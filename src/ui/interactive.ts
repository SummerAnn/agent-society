import fs from "fs";
import path from "path";
import readline from "readline";

import {
  analyzeRunPhysics,
  compareRunConfigs,
  createTemporaryRunConfig,
  discoverRunConfigs,
  inspectArchivedExperiment,
  inspectRun,
  listArchivedExperiments,
  listRecentRunSummaries,
  runBatch,
  runFromConfigAsync,
  validateRunConfigFile,
  type BatchResult,
  type ComparisonResult,
  type DiscoveredRunConfig,
  type RunInspection,
} from "../commands";
import type { ArchiveRecord } from "../archive";
import { loadCondition, loadScenario, resolveRelativeConfigPath, loadRunConfig } from "../config/load";
import type {
  AgentSpec,
  ChatMessage,
  CitationBundle,
  Condition,
  MechanismFamily,
  Provenance,
  RunSummary,
  Scenario,
} from "../config/schema";
import { mulberry32 } from "../engine/core";
import type { RunProgressSnapshot } from "../engine/run";
import { defineGrid, runGrid } from "../experiments/grid";
import { generatePaperTables } from "../experiments/table";
import {
  checkProviderStatus,
  redactKey,
  resolveApiKey,
  saveApiKey,
  testProvider,
  type ProviderType,
} from "../llm/provider";
import {
  C,
  agentRow,
  banner,
  bannerCompact,
  batchResultBlock,
  comparisonTable,
  configCardList,
  correctionAnnouncement,
  claimMatrixPanel,
  dashboardRow,
  eventLogLine,
  frame,
  keyHints,
  labSection,
  memoryMapPanel,
  memoryEntryRow,
  memoryPoolPanel,
  menuList,
  metricsPanel,
  progressBar,
  recentRunsTable,
  stanceLabel,
  stripAnsi,
  truncV,
  sideBySide,
  sparkline,
  statusBar,
  summaryBlock,
  type ConfigCard,
  type MenuChoice,
} from "./render";
import { EXPLAIN_TOPICS, type ExplainTopic } from "./explain";

// --- Terminal helpers ---

const W = () => process.stdout.columns || 120;

function clearScreen(): void {
  process.stdout.write("\x1b[H\x1b[2J");
}

function draw(lines: string[]): void {
  clearScreen();
  console.log(lines.join("\n"));
}

function setRawMode(enabled: boolean): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(enabled);
  }
}

function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

async function pause(rl: readline.Interface): Promise<void> {
  await askQuestion(rl, `\n${C.dim}Press Enter to go back...${C.reset}`);
}

// --- Activity log (chat-like feed) ---

const activityLog: { time: string; text: string }[] = [];

function logActivity(text: string): void {
  const now = new Date();
  const time = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
  activityLog.push({ time, text });
  if (activityLog.length > 50) activityLog.shift();
}

// --- Keyboard: vertical list selection ---

async function selectFromList(
  renderScreen: (selectedIndex: number) => string[],
  itemCount: number,
): Promise<number | null> {
  if (!process.stdin.isTTY || itemCount === 0) {
    return itemCount > 0 ? 0 : null;
  }

  readline.emitKeypressEvents(process.stdin);
  setRawMode(true);

  return await new Promise((resolve) => {
    let selected = 0;

    const render = () => draw(renderScreen(selected));

    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      setRawMode(false);
    };

    const finish = (value: number | null) => {
      cleanup();
      resolve(value);
    };

    const clampIdx = (i: number) => {
      if (i < 0) return itemCount - 1;
      if (i >= itemCount) return 0;
      return i;
    };

    const onKeypress = (_str: string, key: readline.Key) => {
      if (key.name === "up") { selected = clampIdx(selected - 1); render(); return; }
      if (key.name === "down") { selected = clampIdx(selected + 1); render(); return; }
      if (key.name === "return") { finish(selected); return; }
      if (key.name === "q" || key.name === "escape") { finish(null); return; }
      if (key.ctrl && key.name === "c") { finish(null); }
    };

    process.stdin.on("keypress", onKeypress);
    render();
  });
}

// --- Keyboard: 2D grid selection (for card menus) ---

async function selectFromGrid(
  renderScreen: (selectedIndex: number) => string[],
  itemCount: number,
  columns: number,
): Promise<number | null> {
  if (!process.stdin.isTTY || itemCount === 0) {
    return itemCount > 0 ? 0 : null;
  }

  readline.emitKeypressEvents(process.stdin);
  setRawMode(true);

  return await new Promise((resolve) => {
    let selected = 0;

    const render = () => draw(renderScreen(selected));

    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      setRawMode(false);
    };

    const finish = (value: number | null) => {
      cleanup();
      resolve(value);
    };

    const clamp = (i: number) => Math.max(0, Math.min(itemCount - 1, i));
    const currentRow = () => Math.floor(selected / columns);
    const currentCol = () => selected % columns;
    const totalRows = Math.ceil(itemCount / columns);

    const onKeypress = (_str: string, key: readline.Key) => {
      if (key.name === "right") {
        const col = currentCol();
        const row = currentRow();
        const nextCol = (col + 1) % columns;
        const nextIdx = row * columns + nextCol;
        selected = nextIdx < itemCount ? nextIdx : row * columns;
        render();
        return;
      }
      if (key.name === "left") {
        const col = currentCol();
        const row = currentRow();
        const nextCol = col === 0 ? Math.min(columns - 1, itemCount - row * columns - 1) : col - 1;
        selected = row * columns + nextCol;
        render();
        return;
      }
      if (key.name === "down") {
        const col = currentCol();
        let nextRow = currentRow() + 1;
        if (nextRow >= totalRows) nextRow = 0;
        let nextIdx = nextRow * columns + col;
        if (nextIdx >= itemCount) nextIdx = clamp((nextRow) * columns);
        if (nextIdx >= itemCount) { nextRow = 0; nextIdx = col; }
        selected = clamp(nextIdx);
        render();
        return;
      }
      if (key.name === "up") {
        const col = currentCol();
        let nextRow = currentRow() - 1;
        if (nextRow < 0) nextRow = totalRows - 1;
        let nextIdx = nextRow * columns + col;
        if (nextIdx >= itemCount) nextIdx = clamp(nextRow * columns + Math.min(col, itemCount - nextRow * columns - 1));
        selected = clamp(nextIdx);
        render();
        return;
      }
      // Number key shortcuts
      if (key.name && key.name >= "1" && key.name <= "9") {
        const idx = parseInt(key.name, 10) - 1;
        if (idx < itemCount) { selected = idx; render(); }
        return;
      }
      if (key.name === "0") {
        // '0' = last item (Exit)
        selected = itemCount - 1;
        finish(selected);
        return;
      }
      if (key.name === "return") { finish(selected); return; }
      if (key.name === "q" || key.name === "escape") { finish(null); return; }
      if (key.ctrl && key.name === "c") { finish(null); }
    };

    process.stdin.on("keypress", onKeypress);
    render();
  });
}

// --- Keyboard: list selection with left/right callbacks (for cycling values) ---

async function selectWithLR(
  renderScreen: (selectedIndex: number) => string[],
  itemCount: number,
  onLeftRight: (index: number, direction: "left" | "right") => void,
): Promise<number | null> {
  if (!process.stdin.isTTY || itemCount === 0) {
    return itemCount > 0 ? 0 : null;
  }

  readline.emitKeypressEvents(process.stdin);
  setRawMode(true);

  return await new Promise((resolve) => {
    let selected = 0;

    const render = () => draw(renderScreen(selected));

    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      setRawMode(false);
    };

    const finish = (value: number | null) => {
      cleanup();
      resolve(value);
    };

    const clampIdx = (i: number) => {
      if (i < 0) return itemCount - 1;
      if (i >= itemCount) return 0;
      return i;
    };

    const onKeypress = (_str: string, key: readline.Key) => {
      if (key.name === "up") { selected = clampIdx(selected - 1); render(); return; }
      if (key.name === "down") { selected = clampIdx(selected + 1); render(); return; }
      if (key.name === "left") { onLeftRight(selected, "left"); render(); return; }
      if (key.name === "right") { onLeftRight(selected, "right"); render(); return; }
      if (key.name === "return") { finish(selected); return; }
      if (key.name === "q" || key.name === "escape") { finish(null); return; }
      if (key.ctrl && key.name === "c") { finish(null); }
    };

    process.stdin.on("keypress", onKeypress);
    render();
  });
}

// --- Keyboard: multi-select (checkboxes) ---

async function selectMultiple(
  renderScreen: (cursorIndex: number, checked: boolean[]) => string[],
  itemCount: number,
  initialChecked?: boolean[],
): Promise<boolean[] | null> {
  if (!process.stdin.isTTY || itemCount === 0) return null;

  readline.emitKeypressEvents(process.stdin);
  setRawMode(true);

  return await new Promise((resolve) => {
    let cursor = 0;
    const checked = initialChecked ? [...initialChecked] : new Array(itemCount).fill(false);

    const render = () => draw(renderScreen(cursor, checked));

    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      setRawMode(false);
    };

    const finish = (value: boolean[] | null) => {
      cleanup();
      resolve(value);
    };

    const clampIdx = (i: number) => {
      if (i < 0) return itemCount - 1;
      if (i >= itemCount) return 0;
      return i;
    };

    const onKeypress = (_str: string, key: readline.Key) => {
      if (key.name === "up") { cursor = clampIdx(cursor - 1); render(); return; }
      if (key.name === "down") { cursor = clampIdx(cursor + 1); render(); return; }
      if (_str === " " || key.name === "right") { checked[cursor] = !checked[cursor]; render(); return; }
      if (key.name === "a") { const allOn = checked.every(Boolean); checked.fill(!allOn); render(); return; }
      if (key.name === "return") { finish(checked); return; }
      if (key.name === "q" || key.name === "escape") { finish(null); return; }
      if (key.ctrl && key.name === "c") { finish(null); }
    };

    process.stdin.on("keypress", onKeypress);
    render();
  });
}

// --- Prompt helpers ---

async function promptOptionalNumber(
  rl: readline.Interface,
  label: string,
  defaultValue: number,
  min: number,
  max?: number,
): Promise<number | undefined> {
  while (true) {
    const suffix = max !== undefined ? ` ${C.dim}[${defaultValue}; ${min}-${max}]${C.reset}` : ` ${C.dim}[${defaultValue}; min ${min}]${C.reset}`;
    const raw = (await askQuestion(rl, `  ${label}${suffix}: `)).trim();
    if (raw === "") return undefined;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= min && (max === undefined || value <= max)) return value;
  }
}

async function promptRequiredNumber(
  rl: readline.Interface,
  label: string,
  defaultValue: number,
  min: number,
  max?: number,
): Promise<number> {
  while (true) {
    const value = await promptOptionalNumber(rl, label, defaultValue, min, max);
    if (value !== undefined) return value;
    return defaultValue;
  }
}

async function promptText(
  rl: readline.Interface,
  label: string,
  defaultValue: string,
): Promise<string> {
  setRawMode(false);
  const raw = (await askQuestion(rl, `  ${label} ${C.dim}[${defaultValue}]${C.reset}: `)).trim();
  return raw || defaultValue;
}

async function promptOptionalText(
  rl: readline.Interface,
  label: string,
  hint?: string,
): Promise<string | undefined> {
  setRawMode(false);
  const suffix = hint ? ` ${C.dim}[${hint}]${C.reset}` : "";
  const raw = (await askQuestion(rl, `  ${label}${suffix}: `)).trim();
  return raw === "" ? undefined : raw;
}

// --- Provider status for display ---

function getProviderStatusLine(projectRoot: string): string {
  const anthropicKey = resolveApiKey("anthropic", projectRoot);
  const openaiKey = resolveApiKey("openai", projectRoot);
  const orKey = resolveApiKey("openrouter", projectRoot);
  if (anthropicKey && openaiKey) return "anthropic+openai";
  if (anthropicKey) return "anthropic";
  if (openaiKey) return "openai";
  if (orKey) return "openrouter";
  return "none";
}

// --- Screen: Main Menu ---

const HOME_MENU_ITEMS = [
  {
    key: "1",
    icon: `${C.bCyan}\u25b7${C.reset}`,
    label: "Run setup",
    desc: "launch one run and override seed, rounds, budget, or agent count",
    helpTitle: "Run setup",
    helpLines: [
      "Pick one existing run config and change the common knobs here.",
      "This is the fastest path if you want to try a run without editing YAML.",
      "You can override seed, round limit, model budget, and agent count.",
    ],
  },
  {
    key: "2",
    icon: `${C.bMagenta}\u2697${C.reset}`,
    label: "Build experiment",
    desc: "make or edit full experiment configs",
    helpTitle: "Build experiment",
    helpLines: [
      "Use this when you want to create a new setup instead of reusing one.",
      "This path is for condition files, scenarios, and fuller experiment design.",
    ],
  },
  {
    key: "3",
    icon: `${C.bCyan}\u2302${C.reset}`,
    label: "Inspect memory",
    desc: "look at stored memories and prune them",
    helpTitle: "Inspect memory",
    helpLines: [
      "Browse what agents stored, how often retrieval happened, and what can be cleaned up.",
    ],
  },
  {
    key: "4",
    icon: `${C.bBlue}\u2630${C.reset}`,
    label: "Batch seeds",
    desc: "run the same setup many times",
    helpTitle: "Batch seeds",
    helpLines: [
      "Use this when one run is too noisy and you want repeated seeds with summary stats.",
    ],
  },
  {
    key: "5",
    icon: `${C.cyan}\u2194${C.reset}`,
    label: "Compare runs",
    desc: "side by side results for two setups",
    helpTitle: "Compare runs",
    helpLines: [
      "Choose two saved setups and compare their main outcome metrics.",
    ],
  },
  {
    key: "6",
    icon: `${C.cyan}\u2302${C.reset}`,
    label: "Run history",
    desc: "inspect completed runs",
    helpTitle: "Run history",
    helpLines: [
      "Open past runs, inspect summaries, and review metrics after the fact.",
    ],
  },
  {
    key: "7",
    icon: `${C.magenta}\u25a4${C.reset}`,
    label: "Experiment archive",
    desc: "browse saved study records",
    helpTitle: "Experiment archive",
    helpLines: [
      "Open saved study records with their conditions, seeds, outputs, and top metrics.",
    ],
  },
  {
    key: "8",
    icon: `${C.cyan}\u2261${C.reset}`,
    label: "Browse setups",
    desc: "see available run configs",
    helpTitle: "Browse setups",
    helpLines: [
      "Look through the current run configs before choosing one to launch or compare.",
    ],
  },
  {
    key: "9",
    icon: `${C.yellow}\u2699${C.reset}`,
    label: "Provider setup",
    desc: "connect model API keys",
    helpTitle: "Provider setup",
    helpLines: [
      "Configure Anthropic, OpenAI, or OpenRouter keys for model-backed runs.",
    ],
  },
  {
    key: "0",
    icon: `${C.bBlue}⌘${C.reset}`,
    label: "Run command",
    desc: "type a CLI command and run it here",
    helpTitle: "Run command",
    helpLines: [
      "Use the same commands as the normal CLI without leaving the TUI.",
      "Examples: experiment experiments/study1-memory-rules.json",
      "batch run-configs/shared-memory-run.yaml 1,2,3,4,5",
    ],
  },
  {
    key: "e",
    icon: `${C.bYellow}i${C.reset}`,
    label: "Explain",
    desc: "plain language help for modes and metrics",
    helpTitle: "Explain",
    helpLines: [
      "Open short explanations for memory modes, outputs, and experiment screens.",
    ],
  },
  {
    key: "x",
    icon: `${C.dim}\u2717${C.reset}`,
    label: "Exit",
    desc: "",
    helpTitle: "Exit",
    helpLines: [
      "Leave the interface.",
    ],
  },
] as const;

function mainMenuScreen(selectedIndex: number, projectRoot: string): string[] {
  const w = W();
  const inner = w - 4;
  const providerStatus = getProviderStatusLine(projectRoot);

  const configCount = discoverRunConfigs(projectRoot).length;
  const runCount = listRecentRunSummaries(projectRoot).length;
  const archiveCount = listArchivedExperiments(projectRoot, 200).records.length;

  const menuLines = HOME_MENU_ITEMS.map((item, i) => {
    const selected = i === selectedIndex;
    const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : ` `;
    const label = selected
      ? `${C.bCyan}${C.bold}${item.label}${C.reset}`
      : `${C.cyan}${item.label}${C.reset}`;
    const desc = item.desc ? `${C.dim}${item.desc}${C.reset}` : "";
    return `  ${marker} ${item.icon} ${label}  ${desc}`;
  });

  const dashboard = dashboardRow([
    { icon: `${C.cyan}\u2261${C.reset}`, label: "configs", value: `${configCount}` },
    { icon: `${C.cyan}\u2302${C.reset}`, label: "runs", value: `${runCount}` },
    { icon: `${C.magenta}\u25a4${C.reset}`, label: "records", value: `${archiveCount}` },
    { icon: `${C.yellow}\u2699${C.reset}`, label: "provider", value: providerStatus },
  ], inner);

  const selectedItem = HOME_MENU_ITEMS[selectedIndex] ?? HOME_MENU_ITEMS[0];
  const helpW = Math.max(42, Math.floor(inner * 0.46));
  const recentText =
    activityLog.length > 0
      ? activityLog.slice(-3).map((entry) => `${entry.time}  ${entry.text}`)
      : ["No recent activity yet."];
  const helpLines = [
    `${C.bCyan}${selectedItem.helpTitle}${C.reset}`,
    "",
    ...selectedItem.helpLines.map((line) => `${C.dim}${line}${C.reset}`),
    "",
    `${C.cyan}Recent activity${C.reset}`,
    ...recentText.map((line) => `${C.dim}${line}${C.reset}`),
  ];
  const helpPanel = frame(helpLines, helpW, "round", "\u25c6 details");

  while (menuLines.length < helpPanel.length) {
    menuLines.push("");
  }

  const splitRows = sideBySide(menuLines, helpPanel, 16);

  const now = new Date();
  const clock = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;

  const content = [
    ...banner("multi agent society", w),
    "",
    `  ${C.dim}Use Run setup if you want to launch one experiment and change the common settings here instead of editing YAML.${C.reset}`,
    "",
    ...dashboard,
    "",
    ...splitRows,
    "",
    statusBar([
      { label: "v", value: "0.6.0" },
      { label: "engine", value: "llm" },
      { label: "\u25c6", value: clock },
    ], w),
    keyHints(["\u2191\u2193 navigate", "\u23ce select", "1-9 jump", "q quit"], w),
  ];
  return frame(content, w, "heavy");
}

function explainPickerScreen(selectedIndex: number): string[] {
  const w = W();
  const rows = EXPLAIN_TOPICS.flatMap((topic, index) => {
    const selected = index === selectedIndex;
    const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : " ";
    const title = selected ? `${C.bCyan}${C.bold}${topic.label}${C.reset}` : `${C.cyan}${topic.label}${C.reset}`;
    const desc = selected ? `${C.cyan}${topic.short}${C.reset}` : `${C.dim}${topic.short}${C.reset}`;
    return [
      `  ${marker} ${title}`,
      `      ${desc}`,
      "",
    ];
  });

  return frame([
    ...bannerCompact("Explain"),
    "",
    `  ${C.dim}Open a short guide for the study runs, modes, metrics, outputs, or screens.${C.reset}`,
    "",
    ...rows,
    keyHints(["\u2191\u2193 navigate", "\u23ce open", "q back"], w),
  ], w, "heavy");
}

function explainTopicScreen(topic: ExplainTopic): string[] {
  const w = W();
  const inner = w - 4;
  const content: string[] = [
    ...bannerCompact(`Explain · ${topic.label}`),
    "",
  ];

  if (topic.summary && topic.summary.length > 0) {
    const summaryLines = topic.summary.flatMap((line) =>
      wrapPlainText(line, Math.max(18, inner - 10)).map((part) => ` ${C.dim}${part}${C.reset}`),
    );
    content.push(...frame(summaryLines, Math.max(40, inner), "round", "\u25c6 at a glance"));
    content.push("");
  }

  const panelWidth = inner >= 140 ? Math.floor((inner - 4) / 2) : inner;
  const sectionPanels = topic.sections.map((section) => explainSectionCardLines(section, panelWidth));
  if (inner >= 140) {
    for (let i = 0; i < sectionPanels.length; i += 2) {
      const left = sectionPanels[i];
      const right = sectionPanels[i + 1] ?? [];
      content.push(...sideBySide(left, right, 4));
      content.push("");
    }
  } else {
    for (const panel of sectionPanels) {
      content.push(...panel);
      content.push("");
    }
  }

  content.push(
    statusBar([
      { label: "topic", value: topic.label },
      { label: "sections", value: `${topic.sections.length}` },
    ], w),
  );
  content.push(keyHints(["q back", "\u23ce back"], w));
  return frame(content, w, "heavy");
}

async function showExplanations(rl: readline.Interface, _projectRoot: string): Promise<void> {
  const idx = await selectFromList(
    (selected) => explainPickerScreen(selected),
    EXPLAIN_TOPICS.length,
  );
  if (idx === null) return;

  draw(explainTopicScreen(EXPLAIN_TOPICS[idx]));
  await pause(rl);
}

// --- Screen: Config picker ---

function configPickerScreen(configs: DiscoveredRunConfig[], selectedIndex: number, title: string): string[] {
  const w = W();
  const rightW = Math.max(34, Math.floor(w * 0.36));
  const cards: ConfigCard[] = configs.map((c) => ({
    conditionId: c.conditionId,
    memoryMode: c.memoryMode,
    agentCount: c.agentCount,
    maxSteps: c.maxSteps,
    seed: c.seed,
    scenarioTitle: c.scenarioTitle,
  }));
  const menuLines = configCardList(cards, selectedIndex);

  const sel = configs[selectedIndex];
  const detailLines: string[] = sel ? [
    `${C.bCyan}${sel.conditionId}${C.reset}`,
    "",
    `${C.blue}scenario${C.reset}    ${C.dim}${sel.scenarioTitle}${C.reset}`,
    `${C.blue}condition${C.reset}   ${C.dim}${sel.conditionTitle || sel.conditionId}${C.reset}`,
    `${C.blue}memory${C.reset}      ${C.cyan}${sel.memoryMode}${C.reset}`,
    "",
    `${C.blue}agents${C.reset}      ${C.bCyan}${sel.agentCount}${C.reset}`,
    `${C.blue}rounds${C.reset}      ${C.bCyan}${sel.maxSteps}${C.reset}`,
    `${C.blue}budget${C.reset}      ${C.bCyan}${sel.maxModelCalls}${C.reset} calls`,
    `${C.blue}seed${C.reset}        ${C.bCyan}${sel.seed}${C.reset}`,
    "",
    `${C.blue}file${C.reset}        ${C.dim}${sel.fileName}${C.reset}`,
  ] : [`${C.dim}No config selected.${C.reset}`];

  const detailPanel = frame(detailLines, rightW, "round", "\u25c6 details");
  while (menuLines.length < detailPanel.length) menuLines.push("");

  return frame([
    ...bannerCompact(title),
    "",
    ...sideBySide(menuLines, detailPanel, 3),
    "",
    keyHints(["\u2191\u2193 navigate", "\u23ce select", "q back"], w),
  ], w);
}

async function chooseConfig(
  projectRoot: string,
  title: string,
  excludePath?: string,
): Promise<DiscoveredRunConfig | null> {
  const configs = discoverRunConfigs(projectRoot).filter((c) => c.path !== excludePath);
  if (configs.length === 0) {
    return null;
  }
  // Auto-select if only one config available
  if (configs.length === 1) {
    return configs[0];
  }

  const idx = await selectFromList(
    (sel) => configPickerScreen(configs, sel, title),
    configs.length,
  );
  return idx !== null ? configs[idx] : null;
}

// --- Screen: Quick config ---

type QuickRunOptions = {
  seed?: number;
  maxSteps?: number;
  maxModelCalls?: number;
  agentCount?: number;
  agents?: AgentSpec[];
};

async function tuneQuickRun(rl: readline.Interface, config: DiscoveredRunConfig): Promise<QuickRunOptions> {
  const w = W();
  const settingsLines = [
    ...bannerCompact("Run setup"),
    "",
    `  ${C.dim}This keeps the chosen YAML file as the base setup and applies temporary overrides for this run only.${C.reset}`,
    `  ${C.dim}Round means one unit of simulation time. In memory mode that is one agent turn.${C.reset}`,
    "",
    `  ${C.blue}\u25b8${C.reset} ${C.bCyan}${C.bold}Condition:${C.reset}      ${C.cyan}${config.conditionId}${C.reset} ${C.dim}(${config.memoryMode})${C.reset}`,
    `  ${C.blue}\u25b8${C.reset} ${C.bCyan}${C.bold}Scenario:${C.reset}       ${C.cyan}${config.scenarioTitle}${C.reset}`,
    `  ${C.blue}\u25b8${C.reset} ${C.bCyan}${C.bold}Seed:${C.reset}           ${C.bCyan}${config.seed}${C.reset}`,
    `  ${C.blue}\u25b8${C.reset} ${C.bCyan}${C.bold}Round limit:${C.reset}    ${C.bCyan}${config.maxSteps}${C.reset}`,
    `  ${C.blue}\u25b8${C.reset} ${C.bCyan}${C.bold}Model budget:${C.reset}   ${C.bCyan}${config.maxModelCalls}${C.reset}`,
    `  ${C.blue}\u25b8${C.reset} ${C.bCyan}${C.bold}Agent count:${C.reset}    ${C.bCyan}${config.agentCount}${C.reset}`,
    "",
    `  ${C.dim}Press Enter to keep defaults, or type a new value.${C.reset}`,
    "",
  ];
  draw(frame(settingsLines, w));

  const seed = await promptOptionalNumber(rl, "Seed override", config.seed, 0);
  const maxSteps = await promptOptionalNumber(rl, "Round limit override", config.maxSteps, 1);
  const maxModelCalls = await promptOptionalNumber(rl, "Model budget override", config.maxModelCalls, 1);
  const agentCount = await promptOptionalNumber(rl, "Agent count override", config.agentCount, 1, config.agentCount);
  return { seed, maxSteps, maxModelCalls, agentCount };
}

function summarizeAgents(agents: AgentSpec[]): string[] {
  const roleCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();

  for (const agent of agents) {
    roleCounts.set(agent.role, (roleCounts.get(agent.role) ?? 0) + 1);
    modelCounts.set(agent.model, (modelCounts.get(agent.model) ?? 0) + 1);
  }

  const roleSummary = Array.from(roleCounts.entries())
    .map(([role, count]) => `${role.replace(/_agent$/, "")}:${count}`)
    .join("  ");
  const modelSummary = Array.from(modelCounts.entries())
    .map(([model, count]) => `${count}x ${model}`)
    .join("  ");

  return [
    `  ${C.blue}Agents:${C.reset} ${C.bCyan}${agents.length}${C.reset}`,
    `  ${C.blue}Roles:${C.reset} ${C.dim}${roleSummary || "none"}${C.reset}`,
    `  ${C.blue}Models:${C.reset} ${C.dim}${modelSummary || "none"}${C.reset}`,
  ];
}

function buildPresetRoster(
  presetKey: string,
  count: number,
  baseModels: string[],
): AgentSpec[] {
  const models = baseModels.length > 0 ? baseModels : ["claude-haiku-4-5-20251001"];
  const makeWithModel = (role: string, index: number): AgentSpec =>
    makeAgent(`${role.replace(/_agent$/, "")}_${index + 1}`, role, models[index % models.length]);

  const roles: string[] = [];
  if (presetKey === "balanced") {
    const cycle = ["contamination_agent", "specialist_agent", "regular_agent"];
    for (let i = 0; i < count; i++) roles.push(cycle[i % cycle.length]);
  } else if (presetKey === "skeptic_panel") {
    for (let i = 0; i < count; i++) roles.push(i < 2 ? "specialist_agent" : "regular_agent");
  } else if (presetKey === "contamination_pulse") {
    for (let i = 0; i < count; i++) roles.push(i === 0 ? "contamination_agent" : "regular_agent");
  } else if (presetKey === "all_regular") {
    for (let i = 0; i < count; i++) roles.push("regular_agent");
  } else {
    for (let i = 0; i < count; i++) roles.push("specialist_agent");
  }

  return roles.map((role, index) => makeWithModel(role, index));
}

function buildRosterFromRoleCounts(
  counts: {
    contamination: number;
    specialist: number;
    regular: number;
  },
  model: string,
): AgentSpec[] {
  const roles: string[] = [
    ...Array.from({ length: counts.contamination }, () => "contamination_agent"),
    ...Array.from({ length: counts.specialist }, () => "specialist_agent"),
    ...Array.from({ length: counts.regular }, () => "regular_agent"),
  ];

  return roles.map((role, index) => makeAgent(`${role.replace(/_agent$/, "")}_${index + 1}`, role, model));
}

function jitterAgent(agent: AgentSpec, rng: () => number, scale: number): AgentSpec {
  const mul = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value * (1 + ((rng() * 2) - 1) * scale)));
  const add = (value: number, span: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value + ((rng() * 2) - 1) * span));

  return {
    ...agent,
    positiveEvidenceWeight: mul(agent.positiveEvidenceWeight, 0.05, 2.5),
    negativeEvidenceWeight: mul(agent.negativeEvidenceWeight, 0.05, 2.5),
    socialWeight: mul(agent.socialWeight, 0, 3),
    falseClaimBias: add(agent.falseClaimBias, 0.6 * scale, -1.25, 1.25),
    correctionTrust: add(agent.correctionTrust, 0.5 * scale, 0, 1),
    writesMemoryThreshold: add(agent.writesMemoryThreshold, 0.35 * scale, 0, 1),
  };
}

async function chooseQuickPresetAgents(
  rl: readline.Interface,
  baseAgents: AgentSpec[],
): Promise<AgentSpec[] | undefined> {
  const presets = [
    {
      label: "Balanced panel",
      key: "balanced",
      desc: "contamination, specialist, and regular agents repeated",
    },
    {
      label: "Skeptic panel",
      key: "skeptic_panel",
      desc: "two specialists and the rest regular",
    },
    {
      label: "Contamination pulse",
      key: "contamination_pulse",
      desc: "one contamination agent and the rest regular",
    },
    {
      label: "All regular",
      key: "all_regular",
      desc: "uniform regular agents",
    },
    {
      label: "All specialists",
      key: "all_specialists",
      desc: "uniform specialist agents",
    },
    {
      label: "Custom mix",
      key: "custom_mix",
      desc: "choose exact counts for contamination, specialist, and regular agents",
    },
  ];

  const idx = await selectFromList(
    (selected) => {
      const w = W();
      const lines = [
        ...bannerCompact("Agent setup"),
        "",
        `  ${C.dim}Pick a ready made roster and I will build the agents for this run.${C.reset}`,
        "",
        ...presets.flatMap((preset, i) => {
          const marker = i === selected ? `${C.bCyan}\u25b8${C.reset}` : " ";
          const label = i === selected ? `${C.bCyan}${C.bold}${preset.label}${C.reset}` : `${C.cyan}${preset.label}${C.reset}`;
          return [`  ${marker} ${label}  ${C.dim}${preset.desc}${C.reset}`];
        }),
        "",
        keyHints(["\u2191\u2193 navigate", "\u23ce select", "q back"], w),
      ];
      return frame(lines, w);
    },
    presets.length,
  );
  if (idx === null) return undefined;

  let roster: AgentSpec[];
  if (presets[idx].key === "custom_mix") {
    const defaultModel = baseAgents[0]?.model ?? "claude-haiku-4-5-20251001";
    const model = await promptText(rl, "Model for this roster", defaultModel);
    const contamination = await promptRequiredNumber(rl, "Contamination agents", 1, 0);
    const specialist = await promptRequiredNumber(rl, "Specialist agents", 2, 0);
    const regular = await promptRequiredNumber(rl, "Regular agents", Math.max(1, baseAgents.length - 3), 0);
    const total = contamination + specialist + regular;
    if (total < 1) {
      draw(frame([
        ...bannerCompact("Agent setup"),
        "",
        `  ${C.bRed}You need at least one agent in the roster.${C.reset}`,
        "",
      ], W()));
      await pause(rl);
      return undefined;
    }
    roster = buildRosterFromRoleCounts({ contamination, specialist, regular }, model);
  } else {
    const defaultCount = baseAgents.length;
    const count = await promptRequiredNumber(rl, "Roster size", defaultCount, 1);
    roster = buildPresetRoster(presets[idx].key, count, baseAgents.map((agent) => agent.model));
  }

  draw(frame([
    ...bannerCompact("Agent setup"),
    "",
    `  ${C.bCyan}${presets[idx].label}${C.reset}`,
    "",
    ...summarizeAgents(roster),
    "",
  ], W()));
  await pause(rl);
  return roster;
}

async function buildCustomAgents(
  rl: readline.Interface,
  baseAgents: AgentSpec[],
): Promise<AgentSpec[] | undefined> {
  const count = await promptRequiredNumber(rl, "How many agents", baseAgents.length, 1);
  const defaultModel = baseAgents[0]?.model ?? "claude-haiku-4-5-20251001";
  const sharedModel = await promptText(rl, "Default model for new agents", defaultModel);

  const roster: AgentSpec[] = [];
  for (let i = 0; i < count; i++) {
    draw(frame([
      ...bannerCompact("Build your own agents"),
      "",
      `  ${C.blue}Agent ${i + 1} of ${count}${C.reset}`,
      "",
      `  ${C.dim}Role options:${C.reset}`,
      `    1. regular_agent`,
      `    2. specialist_agent`,
      `    3. contamination_agent`,
      "",
    ], W()));
    const roleChoice = (await promptText(rl, "Choose role", "1")).trim();
    const role =
      roleChoice === "2" ? "specialist_agent"
        : roleChoice === "3" ? "contamination_agent"
          : roleChoice === "regular_agent" || roleChoice === "specialist_agent" || roleChoice === "contamination_agent"
            ? roleChoice
            : "regular_agent";
    const model = await promptText(rl, `Model for agent ${i + 1}`, sharedModel);
    roster.push(makeAgent(`${role.replace(/_agent$/, "")}_${i + 1}`, role, model));
  }

  draw(frame([
    ...bannerCompact("Build your own agents"),
    "",
    ...summarizeAgents(roster),
    "",
  ], W()));
  await pause(rl);
  return roster;
}

async function randomizeTemplateAgents(
  rl: readline.Interface,
  baseAgents: AgentSpec[],
  seed: number,
): Promise<AgentSpec[] | undefined> {
  draw(frame([
    ...bannerCompact("Randomize within template"),
    "",
    `  ${C.dim}This keeps the same roles and models, but jitters the numeric traits around the current template.${C.reset}`,
    "",
    `  1. Narrow`,
    `  2. Medium`,
    `  3. Wide`,
    "",
  ], W()));
  const choice = await promptText(rl, "Randomization level", "2");
  const scale = choice === "1" ? 0.1 : choice === "3" ? 0.35 : 0.2;
  const rng = mulberry32(seed);
  const roster = baseAgents.map((agent) => jitterAgent(agent, rng, scale));

  draw(frame([
    ...bannerCompact("Randomize within template"),
    "",
    `  ${C.blue}Seed:${C.reset} ${C.bCyan}${seed}${C.reset}`,
    `  ${C.blue}Strength:${C.reset} ${C.bCyan}${choice === "1" ? "narrow" : choice === "3" ? "wide" : "medium"}${C.reset}`,
    "",
    ...summarizeAgents(roster),
    "",
  ], W()));
  await pause(rl);
  return roster;
}

async function chooseAgentSetup(
  rl: readline.Interface,
  baseAgents: AgentSpec[],
  seed: number,
): Promise<AgentSpec[] | undefined> {
  const items = [
    {
      label: "Keep current roster",
      desc: "use the agents already defined in the chosen setup",
    },
    {
      label: "Quick preset",
      desc: "pick a ready made roster shape",
    },
    {
      label: "Build your own agents",
      desc: "choose roles and models yourself",
    },
    {
      label: "Randomize within template",
      desc: "keep the same roles and models, but vary the numeric traits",
    },
  ];

  const idx = await selectFromList(
    (selected) => {
      const w = W();
      const lines = [
        ...bannerCompact("Agent setup"),
        "",
        `  ${C.dim}Choose how you want to prepare the agents for this run.${C.reset}`,
        "",
        ...summarizeAgents(baseAgents),
        "",
        ...items.flatMap((item, i) => {
          const marker = i === selected ? `${C.bCyan}\u25b8${C.reset}` : " ";
          const label = i === selected ? `${C.bCyan}${C.bold}${item.label}${C.reset}` : `${C.cyan}${item.label}${C.reset}`;
          return [`  ${marker} ${label}  ${C.dim}${item.desc}${C.reset}`];
        }),
        "",
        keyHints(["\u2191\u2193 navigate", "\u23ce select", "q keep current"], w),
      ];
      return frame(lines, w);
    },
    items.length,
  );

  if (idx === null || idx === 0) return undefined;
  if (idx === 1) return chooseQuickPresetAgents(rl, baseAgents);
  if (idx === 2) return buildCustomAgents(rl, baseAgents);
  return randomizeTemplateAgents(rl, baseAgents, seed);
}

// --- Screen: Live run ---

const endorsementHistory: number[] = [];

function liveRunScreen(config: DiscoveredRunConfig, snapshot: RunProgressSnapshot): string[] {
  const w = W();
  const inner = w - 4;

  endorsementHistory.push(snapshot.metrics.falseClaimEndorsementRate);

  const stepStr = `${C.bCyan}round ${snapshot.step}${C.reset}${C.dim}/${snapshot.maxSteps}${C.reset}`;
  const headerLines = [
    `  ${C.bCyan}${C.bold}agent society${C.reset}${" ".repeat(Math.max(0, inner - 42))}${stepStr}`,
    `  ${C.cyan}${config.conditionId}${C.reset} ${C.blue}\u2502${C.reset} ${C.dim}seed:${config.seed} \u00b7 ${config.scenarioTitle}${C.reset}`,
  ];

  const agentLines = snapshot.agentStates.map((a) =>
    agentRow(a.agentId, a.role, a.stance, a.confidence, a.agentId === snapshot.agentId, false, inner - 4),
  );
  const activeIdx = snapshot.agentStates.findIndex((a) => a.agentId === snapshot.agentId);
  if (activeIdx >= 0) {
    agentLines[activeIdx] = agentRow(
      snapshot.agentStates[activeIdx].agentId,
      snapshot.agentStates[activeIdx].role,
      snapshot.agentStates[activeIdx].stance,
      snapshot.agentStates[activeIdx].confidence,
      true,
      snapshot.wroteMemory,
      inner - 4,
    );
  }

  const squarePanel = frame(agentLines, inner, "round", "\u2302 The Square");

  const correctionLines: string[] = [];
  if (snapshot.interventionFired) {
    correctionLines.push(...correctionAnnouncement(
      "Verification: the claim is FALSE.",
      inner,
    ));
  }

  const metricW = Math.floor((inner - 2) / 2);
  const memW = inner - metricW - 1;
  const mPanel = metricsPanel(
    snapshot.metrics.falseClaimEndorsementRate,
    undefined,
    snapshot.metrics.distanceFromGroundTruth,
    snapshot.metrics.diversityRetention,
    metricW,
    snapshot.metrics.consensusStrength,
    snapshot.metrics.netEndorsement,
  );
  const memPanel = memoryPoolPanel(
    snapshot.memoryPoolSize,
    config.memoryMode,
    snapshot.wroteMemory ? snapshot.agentId : null,
    snapshot.retrievedMemoryCount,
    snapshot.interventionFired ? "ACTIVE" : "pending",
    memW,
  );
  const panels = sideBySide(mPanel, memPanel);

  const barWidth = Math.max(10, inner - 30);
  const progressLines = [
    `  ${C.blue}Rounds${C.reset}   ${progressBar(snapshot.step, snapshot.maxSteps, barWidth)}`,
    `  ${C.blue}Calls${C.reset}    ${progressBar(snapshot.modelCalls, snapshot.maxModelCalls, barWidth)}`,
  ];

  const sparkW = Math.max(8, inner - 22);
  const trendLine = `  ${C.blue}Trend${C.reset}    ${sparkline(endorsementHistory, sparkW)}`;

  const evtLine = eventLogLine(
    snapshot.agentId,
    snapshot.agentStates.find((a) => a.agentId === snapshot.agentId)?.role ?? "regular_agent",
    snapshot.focusClaimStance,
    snapshot.agentStates.find((a) => a.agentId === snapshot.agentId)?.confidence ?? 0,
    snapshot.wroteMemory,
  );

  const content = [
    ...headerLines,
    "",
    ...squarePanel.map((l) => `  ${l}`),
    ...correctionLines,
    "",
    ...panels.map((l) => `  ${l}`),
    "",
    ...progressLines,
    trendLine,
    "",
    evtLine,
    "",
    statusBar([
      { label: "round", value: `${snapshot.step}` },
      { label: "calls", value: `${snapshot.modelCalls}` },
      { label: "mem", value: `${snapshot.memoryPoolSize}` },
      { label: "endorse", value: `${(snapshot.metrics.falseClaimEndorsementRate * 100).toFixed(0)}%` },
      { label: "consensus", value: `${(snapshot.metrics.consensusStrength * 100).toFixed(0)}%` },
    ], w),
  ];

  return frame(content, w, "heavy");
}

// --- Screen: Run complete ---

function runCompleteScreen(summary: RunSummary): string[] {
  const w = W();
  const content = [
    ...bannerCompact("Run complete"),
    "",
    ...summaryBlock(summary),
    "",
    statusBar([
      { label: "status", value: "DONE" },
      { label: "rounds", value: `${summary.completedSteps}` },
      { label: "peak", value: `${(summary.peakFalseClaimEndorsementRate * 100).toFixed(0)}%` },
    ], w),
  ];
  return frame(content, w, "heavy");
}

// --- Screen: Comparison ---

function comparisonScreen(comparison: ComparisonResult): string[] {
  const w = W();
  const [runA, runB] = comparison.runs;
  const rows = [
    { metric: "Endorsement rate", a: runA.falseClaimEndorsementRate, b: runB.falseClaimEndorsementRate, delta: comparison.deltas.falseClaimEndorsementRate },
    { metric: "Peak endorsement", a: runA.peakFalseClaimEndorsementRate, b: runB.peakFalseClaimEndorsementRate, delta: comparison.deltas.peakFalseClaimEndorsementRate },
    { metric: "Majority adoption", a: runA.timeToMajorityAdoption, b: runB.timeToMajorityAdoption, delta: comparison.deltas.timeToMajorityAdoption },
    { metric: "Truth distance", a: runA.distanceFromGroundTruth, b: runB.distanceFromGroundTruth, delta: comparison.deltas.distanceFromGroundTruth },
    { metric: "Recovery", a: runA.recoveryAfterCorrection, b: runB.recoveryAfterCorrection, delta: comparison.deltas.recoveryAfterCorrection },
    { metric: "Diversity", a: runA.diversityRetention, b: runB.diversityRetention, delta: comparison.deltas.diversityRetention },
  ];
  const content = [
    ...bannerCompact(`${runA.conditionId} vs ${runB.conditionId}`),
    "",
    ...comparisonTable(runA.conditionId, runB.conditionId, rows, w - 4),
    "",
    `  ${C.dim}Saved: ${comparison.comparePath}${C.reset}`,
    "",
    statusBar([
      { label: "A", value: runA.conditionId },
      { label: "B", value: runB.conditionId },
    ], w),
  ];
  return frame(content, w, "heavy");
}

// --- Screen: Batch result ---

function batchScreen(result: BatchResult): string[] {
  const w = W();
  const content = [
    ...bannerCompact("Batch complete"),
    "",
    ...batchResultBlock(result.aggregated, result.seeds.length),
    "",
    `  ${C.dim}Saved: ${result.batchPath}${C.reset}`,
    "",
    statusBar([
      { label: "seeds", value: `${result.seeds.length}` },
      { label: "status", value: "DONE" },
    ], w),
  ];
  return frame(content, w, "heavy");
}

function normalizeCommandTokens(raw: string): string[] {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const cliIdx = tokens.findIndex((token) => token.endsWith("src/cli.ts"));
  if (cliIdx >= 0 && cliIdx + 1 < tokens.length) {
    return tokens.slice(cliIdx + 1);
  }

  if (tokens[0] === "node" || tokens[0] === "npm" || tokens[0] === "pnpm" || tokens[0] === "yarn") {
    const known = tokens.findIndex((token) =>
      ["validate", "run", "compare", "batch", "inspect", "analyze", "experiment"].includes(token),
    );
    if (known >= 0) return tokens.slice(known);
  }

  return tokens;
}

function expandCommandShortcut(tokens: string[]): string[] {
  if (tokens.length === 0) return tokens;
  const key = tokens[0].toLowerCase();
  const shortcutMap: Record<string, string[]> = {
    "1": ["experiment", "experiments/study1-memory-rules.json"],
    "1a": ["experiment", "experiments/study1-gt-verification.json"],
    "2": ["experiment", "experiments/study2-correction-policies.json"],
    "3": ["experiment", "experiments/study1-memory-scaling-benchmark.json"],
    "4": ["experiment", "experiments/study1-memory-model-robustness.json"],
    "5": ["experiment", "experiments/study4-agent-composition-benchmark.json"],
    "6": ["experiment", "experiments/study3-topology.json"],
    "7": ["experiment", "experiments/study5-open-discussion-benchmark.json"],
    "8": ["experiment", "experiments/study6-truthful-collusion-benchmark.json"],
    "9": ["experiment", "experiments/study7-private-evidence-split.json"],
    "10": ["experiment", "experiments/study8-source-exit-observer-benchmark.json"],
    "11": ["experiment", "experiments/study9-correction-trust-benchmark.json"],
    "12": ["experiment", "experiments/study10-memory-poisoning-benchmark.json"],
    "memory-rules": ["experiment", "experiments/study1-memory-rules.json"],
    "memory-benchmark": ["experiment", "experiments/study1-memory-rules.json"],
    "gt-verification": ["experiment", "experiments/study1-gt-verification.json"],
    "correction-policies": ["experiment", "experiments/study2-correction-policies.json"],
    "correction-benchmark": ["experiment", "experiments/study2-correction-policies.json"],
    "memory-scaling": ["experiment", "experiments/study1-memory-scaling-benchmark.json"],
    "model-robustness": ["experiment", "experiments/study1-memory-model-robustness.json"],
    "agent-composition": ["experiment", "experiments/study4-agent-composition-benchmark.json"],
    "topology-chat": ["experiment", "experiments/study3-topology.json"],
    "open-discussion": ["experiment", "experiments/study5-open-discussion-benchmark.json"],
    "truthful-collusion": ["experiment", "experiments/study6-truthful-collusion-benchmark.json"],
    "private-evidence-split": ["experiment", "experiments/study7-private-evidence-split.json"],
    "source-exit-observer": ["experiment", "experiments/study8-source-exit-observer-benchmark.json"],
    "correction-trust": ["experiment", "experiments/study9-correction-trust-benchmark.json"],
    "memory-poisoning": ["experiment", "experiments/study10-memory-poisoning-benchmark.json"],
  };
  return shortcutMap[key] ?? tokens;
}

type RunCommandDetailSection = {
  heading: string;
  lines: string[];
};

type RunCommandMatrixRow = {
  mechanism: string;
  changes: string;
  fixed: string;
  metric: string;
};

type RunCommandItem = {
  group: "Study runs" | "Run tools";
  label: string;
  short: string;
  command: string | null;
  manifestPath?: string;
  detailTitle: string;
  detailSections: RunCommandDetailSection[];
  cost: "cheap" | "medium" | "expensive";
  rosterLine?: string;
  visualLines?: string[];
  matrixRows?: RunCommandMatrixRow[];
};

const RUN_COMMAND_ITEMS: RunCommandItem[] = [
  {
    group: "Study runs",
    label: "1  study 1: split-truth memory rules",
    short: "main memory study: personal notes, shared source evidence, and shared agent conclusions",
    command: "memory-rules",
    manifestPath: "experiments/study1-memory-rules.json",
    detailTitle: "Study 1: split-truth memory rules",
    cost: "expensive",
    rosterLine: "roster  ♦ 1 contamination   ◆ 2 specialists   ○ 2 regular   ◌ 1 observer",
    visualLines: [
      "split truth",
      "[♦ + r1]   [◆ + ◌]   [◆ + r2]",
      "partial views -> memory sharing or isolation -> group belief",
    ],
    detailSections: [
      {
        heading: "Question",
        lines: [
          "Which memory rule helps or hurts truth recovery when no single agent sees the full picture?",
        ],
      },
      {
        heading: "Community seed",
        lines: [
          "the contamination agent begins by endorsing the false claim and sees the misleading early evidence",
          "the strongest corrective evidence is split across other agents",
          "no note is shared at the start; information reaches others only after an agent has a turn",
        ],
      },
      {
        heading: "What changes",
        lines: [
          "personal notes, a shared evidence board, shared agent-written notes, and shared notes with decay",
        ],
      },
      {
        heading: "What stays fixed",
        lines: [
          "same distributed scenario, same roster, same turn order, and no scheduled correction",
        ],
      },
      {
        heading: "Scale",
        lines: [
          "4 distributed scenarios, 4 conditions, 10 seeds, 18 turns per run",
          "main study 1 run and the cleanest memory-only comparison on this screen",
        ],
      },
    ],
    matrixRows: [
      {
        mechanism: "distributed information failure",
        changes: "personal notes vs shared source evidence vs shared judgments vs decay",
        fixed: "same partial-truth scenario, same roster, same turn order, no scheduled correction",
        metric: "truth distance, final false endorsement, evidence and testimony use",
      },
    ],
  },
  {
    group: "Study runs",
    label: "1a study 1: GT verification",
    short: "follow-up study: shared memory with GT verification and harsher noisy GT checks",
    command: "gt-verification",
    manifestPath: "experiments/study1-gt-verification.json",
    detailTitle: "Study 1a: GT verification under split truth",
    cost: "expensive",
    rosterLine: "roster  ♦ 1 contamination   ◆ 2 specialists   ○ 2 regular   ◌ 1 observer-slot",
    visualLines: [
      "shared notes + GT signal",
      "shared -> GT 0% noise -> GT 30% -> GT 50% -> GT 70%",
      "same split truth, different signal quality",
    ],
    detailSections: [
      {
        heading: "Question",
        lines: [
          "How much does GT verification quality change the final group belief when evidence is split across agents?",
        ],
      },
      {
        heading: "Community seed",
        lines: [
          "the same distributed scenarios are reused so only the GT signal quality changes",
          "there is no scheduled correction in this run family",
        ],
      },
      {
        heading: "What changes",
        lines: [
          "shared memory alone, shared memory with GT verification, and noisy GT verification at 30%, 50%, and 70%",
        ],
      },
      {
        heading: "What stays fixed",
        lines: [
          "same distributed scenario, same roster, same seed pattern, and no scheduled correction",
        ],
      },
      {
        heading: "Scale",
        lines: [
          "4 distributed scenarios, 5 conditions, 10 seeds",
          "use this after study 1 if you want to separate clean shared memory from stronger or weaker GT help",
        ],
      },
    ],
    matrixRows: [
      {
        mechanism: "verification quality",
        changes: "GT signal reliability only",
        fixed: "same split-truth scenario, shared memory, roster, and no scheduled correction",
        metric: "final false endorsement, truth distance, recovery, and diversity retention",
      },
    ],
  },
  {
    group: "Study runs",
    label: "2  study 2: correction policies",
    short: "policy study: which correction policy reverses bad consensus",
    command: "correction-policies",
    manifestPath: "experiments/study2-correction-policies.json",
    detailTitle: "Study 2: correction policies",
    cost: "expensive",
    rosterLine: "roster  ♦ 1 contamination   ◆ 2 specialists   ○ 3 regular",
    visualLines: [
      "shared spread -----> correction event -----> recovery or persistence",
    ],
    detailSections: [
      {
        heading: "Question",
        lines: [
          "Which correction policy reverses bad consensus most reliably after false belief starts spreading?",
        ],
      },
      {
        heading: "Community seed",
        lines: [
          "The focal false belief is seeded first under shared memory.",
          "Correction is introduced only after the group has time to propagate it.",
          "The comparison asks which intervention actually reverses lock-in.",
        ],
      },
      {
        heading: "What changes",
        lines: [
          "no correction, default correction, early, late, weak, repeated, and high-authority correction",
        ],
      },
      {
        heading: "What stays fixed",
        lines: [
          "same shared-memory setting, same 6 agent roster, same scenario and evidence",
        ],
      },
      {
        heading: "Scale",
        lines: [
          "6 scenarios, 7 correction conditions, 10 seeds",
          "best policy follow-up once study 1 shows the core memory effect",
        ],
      },
    ],
    matrixRows: [
      {
        mechanism: "correction resistance",
        changes: "no correction, timing, strength, repetition, and authority of correction",
        fixed: "same shared-memory seed, roster, and evidence",
        metric: "recovery after correction, time to recovery, post-correction persistence",
      },
    ],
  },
  {
    group: "Study runs",
    label: "3  study 1b: scale up the society",
    short: "rerun the memory study at 6, 12, and 24 agents",
    command: "memory-scaling",
    manifestPath: "experiments/study1-memory-scaling-benchmark.json",
    detailTitle: "Study 1b: scale up the society",
    cost: "medium",
    visualLines: [
      "6 agents -> 12 agents -> 24 agents",
      "[♦◆◆○○○]   [larger society]   [full crowd]",
    ],
    detailSections: [
      {
        heading: "Question",
        lines: [
          "Does the memory result still hold when the community gets larger?",
        ],
      },
      {
        heading: "What changes",
        lines: [
          "agent count changes while the same memory comparison stays in place",
        ],
      },
      {
        heading: "What stays fixed",
        lines: [
          "same false claim structure, same memory comparison family, same basic correction design",
        ],
      },
      {
        heading: "Scale",
        lines: [
          "2 scenarios, 3 conditions, 5 seeds",
          "6 vs 12 vs 24 agents",
        ],
      },
    ],
    matrixRows: [
      {
        mechanism: "scale sensitivity",
        changes: "agent count only",
        fixed: "same memory comparison, claim structure, and correction design",
        metric: "peak endorsement, time to majority adoption, diversity retention",
      },
    ],
  },
  {
    group: "Study runs",
    label: "4  study 1c: model robustness",
    short: "rerun the memory study across model families",
    command: "model-robustness",
    manifestPath: "experiments/study1-memory-model-robustness.json",
    detailTitle: "Study 1c: model robustness",
    cost: "medium",
    visualLines: [
      "same study setup",
      "model family A  <->  model family B",
    ],
    detailSections: [
      {
        heading: "Question",
        lines: [
          "Does the memory ranking stay similar across different models?",
        ],
      },
      {
        heading: "What changes",
        lines: [
          "the roster model family changes while the memory conditions stay the same",
        ],
      },
      {
        heading: "What stays fixed",
        lines: [
          "same study 1 design, same scenario family, same memory comparison",
        ],
      },
      {
        heading: "Scale",
        lines: [
          "3 scenarios, 3 conditions, 5 seeds",
          "Haiku roster vs GPT 4o mini roster",
        ],
      },
    ],
    matrixRows: [
      {
        mechanism: "model robustness",
        changes: "model family only",
        fixed: "same memory conditions, scenarios, and roster structure",
        metric: "rank-order stability of false endorsement and recovery metrics",
      },
    ],
  },
  {
    group: "Study runs",
    label: "5  study 4: population mix",
    short: "change who is in the society, not the memory rule",
    command: "agent-composition",
    manifestPath: "experiments/study4-agent-composition-benchmark.json",
    detailTitle: "Study 4: population mix",
    cost: "medium",
    visualLines: [
      "balanced       contamination-heavy",
      "♦◆◆○○○   vs   ♦♦◆○○○",
      "specialist-heavy   vs   regular-heavy",
      "♦◆◆◆○○          ♦◆○○○○",
    ],
    detailSections: [
      {
        heading: "Question",
        lines: [
          "Which population mixes are robust, and which ones tip into false consensus?",
        ],
      },
      {
        heading: "What changes",
        lines: [
          "balanced, contamination heavy, specialist heavy, and regular heavy societies",
        ],
      },
      {
        heading: "Important design rule",
        lines: [
          "role does not automatically determine initial false belief",
          "seeding is configured separately so composition stays interpretable",
        ],
      },
      {
        heading: "Scale",
        lines: [
          "6 scenarios, 1 shared memory condition, 10 seeds, 4 roster types",
        ],
      },
    ],
    matrixRows: [
      {
        mechanism: "composition sensitivity",
        changes: "contamination, specialist, and regular mix",
        fixed: "same memory rule, same scenario, same correction timing",
        metric: "peak false endorsement, diversity retention, recovery after correction",
      },
    ],
  },
  {
    group: "Study runs",
    label: "6  study 3: who can talk to whom",
    short: "compare fully connected, star, chain, and ring discussion",
    command: "topology-chat",
    manifestPath: "experiments/study3-topology.json",
    detailTitle: "Study 3: communication structure",
    cost: "expensive",
    visualLines: [
      "topology mini-maps",
      "╭─ fully ────╮  ╭─ star ─────╮",
      "│ A─B─C      │  │    B       │",
      "│ │╲│╱│      │  │    │       │",
      "│ D─E─F      │  │ A──H──C    │",
      "│ all-to-all │  │   / \\      │",
      "╰────────────╯  │  D   E     │",
      "                ╰────────────╯",
      "╭─ chain ────╮  ╭─ ring ─────╮",
      "│ A─B─C─D─E  │  │ A─B─C      │",
      "│ neighbors  │  │ │   │      │",
      "│ only       │  │ F─E─D      │",
      "╰────────────╯  ╰────────────╯",
    ],
    detailSections: [
      {
        heading: "Question",
        lines: [
          "How does communication structure change misinformation spread in direct discussion?",
        ],
      },
      {
        heading: "Topology definitions",
        lines: [
          "fully connected: everyone can directly talk to everyone",
          "star: one hub talks to all others, outer agents do not talk directly",
          "chain: agents talk only to adjacent neighbors in a line",
          "ring: agents talk only to adjacent neighbors in a loop",
        ],
      },
      {
        heading: "What stays fixed",
        lines: [
          "same scenario, source pack, correction event, and roster within each comparison",
        ],
      },
      {
        heading: "Scale",
        lines: [
          "4 scenarios, 4 topologies, 10 seeds",
          "agents talk directly each round",
        ],
      },
    ],
    matrixRows: [
      {
        mechanism: "topology cascade",
        changes: "fully connected vs star vs chain vs ring",
        fixed: "same roster, same source pack, same correction event",
        metric: "time to majority adoption, peak endorsement, final consensus strength",
      },
    ],
  },
  {
    group: "Study runs",
    label: "7  study 5: open discussion",
    short: "source-based discussion with questions, critique, and citations",
    command: "open-discussion",
    manifestPath: "experiments/study5-open-discussion-benchmark.json",
    detailTitle: "Study 5: open discussion",
    cost: "medium",
    rosterLine: "discussion  source cards -> claims -> critique -> citations",
    visualLines: [
      "chat flow",
      "[source cards] -> [A <-> B <-> C] -> [citations] -> [group stance]",
    ],
    detailSections: [
      {
        heading: "Question",
        lines: [
          "What changes when agents argue directly with source cards, critique, summaries, and citations instead of only writing memory entries?",
        ],
      },
      {
        heading: "What changes",
        lines: [
          "source cards, richer message types, citation logging, and post run evaluation",
        ],
      },
      {
        heading: "What stays fixed",
        lines: [
          "same scenario within each comparison and the same 6 agent roster",
        ],
      },
      {
        heading: "Scale",
        lines: [
          "2 scenarios, 2 discussion conditions, 5 seeds",
        ],
      },
    ],
    matrixRows: [
      {
        mechanism: "source-grounded deliberation",
        changes: "discussion protocol and source-card interaction",
        fixed: "same topic, same roster size, same source set",
        metric: "citation fidelity, source coverage, premature consensus risk",
      },
    ],
  },
  {
    group: "Study runs",
    label: "8  study 6: truthful collusion",
    short: "small subgroup steers the group using only true fragments",
    command: "truthful-collusion",
    manifestPath: "experiments/study6-truthful-collusion-benchmark.json",
    detailTitle: "Study 6: truthful collusion",
    cost: "medium",
    visualLines: [
      "true fragments only",
      "supportive evidence repeated  |  contrary evidence omitted",
      "[c1][c2] --------------------> group conclusion shifts",
    ],
    detailSections: [
      {
        heading: "Question",
        lines: [
          "Can a small colluding subgroup push the group toward a wrong conclusion without using fake evidence?",
        ],
      },
      {
        heading: "What changes",
        lines: [
          "baseline open discussion versus hidden collusion versus visible collusion",
        ],
      },
      {
        heading: "Rule of the setting",
        lines: [
          "colluders can use only real source grounded fragments already in the scenario",
          "the steering comes from selective emphasis and omission, not fabricated facts",
        ],
      },
      {
        heading: "Scale",
        lines: [
          "2 scenarios, 3 conditions, 2 seeds",
          "12 agent panels with 1 or 2 colluders",
        ],
      },
    ],
    matrixRows: [
      {
        mechanism: "selective disclosure",
        changes: "hidden vs visible collusion and colluder count",
        fixed: "same true evidence base and same discussion topic",
        metric: "false adoption, citation fidelity drift, omitted-source pattern",
      },
    ],
  },
  {
    group: "Study runs",
    label: "9  study 7: private evidence split",
    short: "compact rerun of study 1 for cheaper audits and noisy-verification checks",
    command: "private-evidence-split",
    manifestPath: "experiments/study7-private-evidence-split.json",
    detailTitle: "Study 7: private evidence split",
    cost: "medium",
    rosterLine: "roster  ♦ 1 contamination   ◆ 2 specialists   ○ 2 regular   ○ 1 observer-slot",
    visualLines: [
      "truth is split",
      "[♦ + r1]   [◆ + o1]   [◆ + r2]",
      "partial views -> memory sharing or isolation -> group belief",
    ],
    detailSections: [
      {
        heading: "Question",
        lines: [
          "What changes when no single agent sees the full truth?",
        ],
      },
      {
        heading: "Community seed",
        lines: [
          "the contamination agent sees the misleading early evidence",
          "the strongest corrective evidence is split across other agents",
        ],
      },
      {
        heading: "What changes",
        lines: [
          "personal memory, shared memory, reliable verification, and noisy verification",
        ],
      },
      {
        heading: "What stays fixed",
        lines: [
          "same distributed scenario, same roster, and same correction event",
        ],
      },
      {
        heading: "Scale",
        lines: [
          "2 distributed scenarios, 4 conditions, 5 seeds",
          "smaller and cheaper than study 1, useful for quick audits before full runs",
        ],
      },
    ],
    matrixRows: [
      {
        mechanism: "distributed information failure",
        changes: "private evidence visibility plus memory regime",
        fixed: "same partial-truth scenario, same roster, same correction event",
        metric: "truth recovery, testimony adoption, final false endorsement",
      },
    ],
  },
  {
    group: "Study runs",
    label: "10 study 8: source exit + observer",
    short: "test whether spread persists after the original source disappears",
    command: "source-exit-observer",
    manifestPath: "experiments/study8-source-exit-observer-benchmark.json",
    detailTitle: "Study 8: source exit and observer effect",
    cost: "medium",
    visualLines: [
      "source exit",
      "[♦] -> shared memory -> group",
      " X at step 3        does the claim keep moving?",
    ],
    detailSections: [
      {
        heading: "Question",
        lines: [
          "Does the false claim keep spreading after the original source disappears, and what changes when one agent can read but not write?",
        ],
      },
      {
        heading: "What changes",
        lines: [
          "baseline, observer only, source exit only, and source exit plus observer",
        ],
      },
      {
        heading: "What stays fixed",
        lines: [
          "same distributed scenarios and same post-exit triggered correction rule",
        ],
      },
      {
        heading: "Scale",
        lines: [
          "4 distributed scenarios, 4 rosters, 5 seeds",
        ],
      },
    ],
    matrixRows: [
      {
        mechanism: "source exit persistence",
        changes: "source exit and read-only observer presence",
        fixed: "same distributed truth and same correction rule",
        metric: "post-exit false adoption, higher-order adoption, recovery after exit",
      },
    ],
  },
  {
    group: "Study runs",
    label: "11 study 9: correction trust",
    short: "vary how much the society listens to correction",
    command: "correction-trust",
    manifestPath: "experiments/study9-correction-trust-benchmark.json",
    detailTitle: "Study 9: correction trust",
    cost: "medium",
    visualLines: [
      "same correction event",
      "low trust  -> weak recovery",
      "high trust -> faster recovery",
    ],
    detailSections: [
      {
        heading: "Question",
        lines: [
          "How much does correction trust determine whether the group recovers?",
        ],
      },
      {
        heading: "What changes",
        lines: [
          "low trust, baseline trust, and high trust rosters",
        ],
      },
      {
        heading: "What stays fixed",
        lines: [
          "same scenarios, same shared memory rule, and same triggered correction",
        ],
      },
      {
        heading: "Scale",
        lines: [
          "4 scenarios, 3 trust panels, 5 seeds",
        ],
      },
    ],
    matrixRows: [
      {
        mechanism: "correction trust",
        changes: "low, baseline, and high trust toward correction",
        fixed: "same shared memory, same trigger, same scenario set",
        metric: "recovery after correction, post-correction persistence, time to recovery",
      },
    ],
  },
  {
    group: "Study runs",
    label: "12 study 10: memory poisoning",
    short: "vary how much false memory is seeded at the start",
    command: "memory-poisoning",
    manifestPath: "experiments/study10-memory-poisoning-benchmark.json",
    detailTitle: "Study 10: memory poisoning strength",
    cost: "medium",
    visualLines: [
      "poisoning strength",
      "low:   one seeded note",
      "mid:   two seeded notes",
      "high:  four repeated seeded notes",
    ],
    detailSections: [
      {
        heading: "Question",
        lines: [
          "How much seeded false memory is needed before recovery breaks down?",
        ],
      },
      {
        heading: "What changes",
        lines: [
          "low, medium, and high seeded false-memory strength",
          "with and without reliable verification",
        ],
      },
      {
        heading: "What stays fixed",
        lines: [
          "same domain evidence, same roster, and same correction timing within each poisoning family",
        ],
      },
      {
        heading: "Scale",
        lines: [
          "6 scenario variants, 2 conditions, 5 seeds",
        ],
      },
    ],
    matrixRows: [
      {
        mechanism: "memory poisoning threshold",
        changes: "dose of seeded false memory and verification defense",
        fixed: "same roster, same evidence family, same correction timing",
        metric: "endorsement curve, false retrieval rate, recovery breakdown point",
      },
    ],
  },
  {
    group: "Run tools",
    label: "Run one config",
    short: "run a single config file",
    command: "run run-configs/shared-memory-run.yaml",
    detailTitle: "Run one config",
    cost: "cheap",
    detailSections: [
      {
        heading: "Use this when",
        lines: [
          "you already know which config file you want",
          "it launches one run, not a whole study grid",
        ],
      },
    ],
  },
  {
    group: "Run tools",
    label: "Batch seeds",
    short: "repeat one config across many seeds",
    command: "batch run-configs/shared-memory-run.yaml 1,2,3,4,5",
    detailTitle: "Batch seeds",
    cost: "medium",
    detailSections: [
      {
        heading: "Use this when",
        lines: [
          "one run is too noisy",
          "it reruns the same config with different seeds and gives summary stats",
        ],
      },
    ],
  },
  {
    group: "Run tools",
    label: "Compare runs",
    short: "compare two configs side by side",
    command: "compare run-configs/personal-memory-run.yaml run-configs/shared-memory-run.yaml",
    detailTitle: "Compare runs",
    cost: "cheap",
    detailSections: [
      {
        heading: "Use this when",
        lines: [
          "you want a direct A versus B comparison",
          "this is lighter than a full study grid",
        ],
      },
    ],
  },
  {
    group: "Run tools",
    label: "Inspect saved run",
    short: "open one finished run",
    command: "inspect",
    detailTitle: "Inspect saved run",
    cost: "cheap",
    detailSections: [
      {
        heading: "Use this when",
        lines: [
          "you want one completed run by run id, summary file, or trace database",
          "this is for looking backward, not launching a new experiment",
        ],
      },
    ],
  },
  {
    group: "Run tools",
    label: "Archive browser",
    short: "browse saved study records",
    command: "archive",
    detailTitle: "Archive browser",
    cost: "cheap",
    detailSections: [
      {
        heading: "Use this when",
        lines: [
          "you want saved experiment records and summaries",
          "this gets more useful after you have run several studies",
        ],
      },
    ],
  },
  {
    group: "Run tools",
    label: "Custom command",
    short: "type any CLI command manually",
    command: null,
    detailTitle: "Custom command",
    cost: "cheap",
    detailSections: [
      {
        heading: "Use this when",
        lines: [
          "the built in entries do not fit",
          "you can still paste a full node command and the TUI will strip the prefix",
        ],
      },
      {
        heading: "Examples",
        lines: [
          "validate run-configs/shared-memory-run.yaml",
          "run run-configs/shared-memory-run.yaml",
          "batch run-configs/shared-memory-run.yaml 1,2,3,4,5",
          "compare run-configs/personal-memory-run.yaml run-configs/shared-memory-run.yaml",
          "inspect <run-id|summary.json|trace.db>",
          "archive",
          "analyze <run-id|summary.json|trace.db>",
          "experiment experiments/study3-topology.json",
          "experiment experiments/study5-open-discussion-benchmark.json",
          "experiment experiments/study7-private-evidence-split.json",
          "experiment experiments/study10-memory-poisoning-benchmark.json",
        ],
      },
    ],
  },
];

function wrapPlainText(text: string, width: number): string[] {
  if (width <= 8) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}

function costBadge(level: RunCommandItem["cost"]): string {
  if (level === "cheap") return `${C.bGreen}[cheap]${C.reset}`;
  if (level === "medium") return `${C.bYellow}[medium]${C.reset}`;
  return `${C.bRed}[expensive]${C.reset}`;
}

function mechanismFamilyLabel(family?: MechanismFamily | null): string {
  if (!family) return "unspecified";
  if (family === "memory_lock_in") return "memory lock-in";
  if (family === "distributed_information") return "distributed information";
  if (family === "source_grounded_deliberation") return "source-grounded deliberation";
  if (family === "selective_disclosure") return "selective disclosure";
  if (family === "source_exit_persistence") return "source-exit persistence";
  if (family === "memory_poisoning") return "memory poisoning";
  return "unspecified";
}

function mechanismMatrixCardLines(rows: RunCommandMatrixRow[], width: number): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(`${C.cyan}${row.mechanism}${C.reset}`);
    for (const wrapped of wrapPlainText(`change: ${row.changes}`, Math.max(20, width - 6))) {
      lines.push(` ${C.dim}${wrapped}${C.reset}`);
    }
    for (const wrapped of wrapPlainText(`fixed: ${row.fixed}`, Math.max(20, width - 6))) {
      lines.push(` ${C.dim}${wrapped}${C.reset}`);
    }
    for (const wrapped of wrapPlainText(`metric: ${row.metric}`, Math.max(20, width - 6))) {
      lines.push(` ${C.dim}${wrapped}${C.reset}`);
    }
    lines.push("");
  }
  if (lines[lines.length - 1] === "") lines.pop();
  return frame(lines, width, "single", "distinguishing matrix");
}

function summarizeConditionTitleForStudyCard(condition: Condition): string {
  if (condition.interaction.mode === "chat") {
    const style = condition.interaction.chatStyle === "open-discussion" ? "open discussion" : "chat debate";
    const chatBits = [style, condition.interaction.topology];
    if (condition.interaction.collusion.strategy === "truthful_selective") {
      chatBits.push(condition.interaction.collusion.visibility === "visible" ? "visible collusion" : "hidden collusion");
    }
    return chatBits.join(" | ");
  }

  const bits: string[] = [];
  bits.push(
    condition.memory.mode === "personal"
      ? "personal memory"
      : condition.memory.record === "evidence_board"
        ? "shared evidence board"
        : "shared agent memory",
  );
  if (condition.memory.decay.enabled) bits.push(`decay h=${condition.memory.decay.halfLife}`);
  if (condition.interventions.verification.mode === "reliable") bits.push("reliable verification");
  if (condition.interventions.verification.mode === "noisy") bits.push("noisy verification");
  if (condition.interventions.correctionTiming === "early") bits.push("early correction");
  if (condition.interventions.correctionTiming === "late") bits.push("late correction");
  if (typeof condition.interventions.correctionTiming === "object") {
    bits.push(`trigger @ ${(condition.interventions.correctionTiming.threshold * 100).toFixed(0)}% endorse`);
  }
  if (condition.interventions.correctionStrength === "weak") bits.push("weak correction");
  if (condition.interventions.correctionStrength === "repeated") bits.push("repeated correction");
  if (condition.interventions.correctionStrength === "high_authority") bits.push("high-authority correction");
  return bits.join(" | ");
}

function manifestConditionCardLines(manifestPath: string, projectRoot: string, width: number): string[] {
  const resolved = path.resolve(projectRoot, manifestPath);
  if (!fs.existsSync(resolved)) return [];
  const manifest = JSON.parse(fs.readFileSync(resolved, "utf8")) as { conditions?: string[] };
  const conditionPaths = manifest.conditions ?? [];
  if (conditionPaths.length === 0) return [];

  const lines: string[] = [];
  for (const conditionPath of conditionPaths) {
    const condition = loadCondition(path.resolve(projectRoot, conditionPath));
    lines.push(`${C.cyan}${condition.title}${C.reset}`);
    for (const wrapped of wrapPlainText(summarizeConditionTitleForStudyCard(condition), Math.max(20, width - 6))) {
      lines.push(` ${C.dim}${wrapped}${C.reset}`);
    }
    lines.push("");
  }
  if (lines[lines.length - 1] === "") lines.pop();
  return frame(lines, width, "single", "condition set");
}

function sectionCardLines(section: RunCommandDetailSection, width: number): string[] {
  const lines: string[] = [];
  for (const line of section.lines) {
    for (const wrapped of wrapPlainText(line, Math.max(16, width - 6))) {
      lines.push(` ${C.dim}${wrapped}${C.reset}`);
    }
  }
  return frame(lines, width, "single", section.heading);
}

function explainSectionCardLines(
  section: ExplainTopic["sections"][number],
  width: number,
): string[] {
  const lines: string[] = [];
  if (section.visualLines && section.visualLines.length > 0) {
    for (const visual of section.visualLines) {
      lines.push(` ${C.cyan}${visual}${C.reset}`);
    }
    lines.push("");
  }
  for (const line of section.lines) {
    for (const wrapped of wrapPlainText(line, Math.max(18, width - 8))) {
      lines.push(` ${C.dim}• ${wrapped}${C.reset}`);
    }
  }
  return frame(lines, width, "round", section.title);
}

function commandPickerScreen(selectedIndex: number): string[] {
  const w = W();
  const inner = w - 4;
  const leftW = Math.max(42, Math.floor((inner - 2) * 0.52));
  const rightW = inner - leftW - 2;
  let previousGroup: RunCommandItem["group"] | null = null;
  const menuLines = RUN_COMMAND_ITEMS.flatMap((item, i) => {
    const selected = i === selectedIndex;
    const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : " ";
    const label = selected ? `${C.bCyan}${C.bold}${item.label}${C.reset}` : `${C.cyan}${item.label}${C.reset}`;
    const desc = selected ? `${C.cyan}${item.short}${C.reset}` : `${C.dim}${item.short}${C.reset}`;
    const badge = costBadge(item.cost);
    const lines: string[] = [];
    if (item.group !== previousGroup) {
      lines.push(`${C.blue}${C.bold}${item.group.toUpperCase()}${C.reset}`);
      lines.push("");
      previousGroup = item.group;
    }
    lines.push(
      `  ${marker} ${label}`,
      `      ${desc}  ${badge}`,
      "",
    );
    return lines;
  });
  const selectedItem = RUN_COMMAND_ITEMS[selectedIndex] ?? RUN_COMMAND_ITEMS[0];
  const detailLines: string[] = [
    `${C.bCyan}${selectedItem.detailTitle}${C.reset}  ${costBadge(selectedItem.cost)}`,
    "",
  ];
  if (selectedItem.rosterLine) {
    detailLines.push(`${C.dim}${selectedItem.rosterLine}${C.reset}`, "");
  }
  if (selectedItem.visualLines && selectedItem.visualLines.length > 0) {
    detailLines.push(...selectedItem.visualLines.map((line) => `${C.cyan}${line}${C.reset}`), "");
  }
  for (const section of selectedItem.detailSections) {
    detailLines.push(...sectionCardLines(section, Math.max(28, rightW)), "");
  }
  if (selectedItem.manifestPath) {
    const conditionCard = manifestConditionCardLines(selectedItem.manifestPath, process.cwd(), Math.max(28, rightW));
    if (conditionCard.length > 0) detailLines.push(...conditionCard, "");
  }
  if (selectedItem.matrixRows && selectedItem.matrixRows.length > 0) {
    detailLines.push(...mechanismMatrixCardLines(selectedItem.matrixRows, Math.max(28, rightW)), "");
  }
  detailLines.push(
    `${C.cyan}Launch command${C.reset}`,
    ...wrapPlainText(selectedItem.command ?? "prompt for custom command", Math.max(20, rightW - 4)).map(
      (line) => `${C.dim}${line}${C.reset}`,
    ),
  );
  const detailPanel = frame(detailLines, rightW, "round", "\u25c6 study card");
  while (menuLines.length < detailPanel.length) menuLines.push("");
  return frame([
    ...bannerCompact("Study board"),
    "",
    `  ${C.dim}Pick a study or tool on the left. The right side spells out the seed, changed variable, fixed setup, and launch command.${C.reset}`,
    `  ${C.dim}Society key: ${C.reset}${C.red}\u2666 contamination${C.reset}${C.dim}  ${C.reset}${C.bCyan}\u25c6 specialist${C.reset}${C.dim}  ${C.reset}${C.white}\u25cb regular${C.reset}`,
    `  ${C.dim}Flow key: ${C.reset}${C.cyan}[agent] -> [note] -> [pool]${C.reset}${C.dim} memory  ${C.reset}${C.cyan}[agent] <-> [agent]${C.reset}${C.dim} chat${C.reset}`,
    "",
    ...sideBySide(menuLines, detailPanel, 12),
    "",
    keyHints(["\u2191\u2193 navigate", "\u23ce launch", "type aliases in custom command", "q back"], w),
  ], w, "heavy");
}

function jsonResultScreen(title: string, body: string): string[] {
  const w = W();
  const bodyLines = body.split("\n").slice(0, Math.max(12, (process.stdout.rows || 40) - 10));
  return frame([
    ...bannerCompact(title),
    "",
    ...bodyLines.map((line) => truncV(`  ${C.dim}${line}${C.reset}`, w - 4)),
    "",
  ], w, "heavy");
}

type ExperimentCellStatus = {
  studyId: string;
  manifestPath: string;
  completed: number;
  total: number;
  scenarioId: string;
  scenarioTitle: string;
  conditionId: string;
  rosterId: string;
  seed: number;
  focusClaimText: string;
  focusClaimTruthLabel: string;
  sourceItems: string[];
  seedNotes: string[];
  seedEntries: string[];
  roleMix: string;
};

type LiveTranscriptEntry = {
  round: number;
  agentId: string;
  stance: string;
  text: string;
};

type ExperimentBudgetEstimate = {
  totalCells: number;
  maxRoundsPerCell: number;
  approxApiCallsUpper: number;
  approxCostLow: number | null;
  approxCostHigh: number | null;
  costLabel: string;
  notes: string[];
};

function conservativeCallsPerStepForManifest(
  manifest: Record<string, unknown>,
  projectRoot: string,
): number {
  const rosters = readManifestRosters(manifest, projectRoot);
  const rosterSizes = rosters.map((roster) => roster.agents.length);
  const conditionPaths = Array.isArray(manifest.conditions) ? manifest.conditions as string[] : [];
  const scenarioPaths = Array.isArray(manifest.scenarios) ? manifest.scenarios as string[] : [];
  let maxCalls = 0;
  for (const conditionPath of conditionPaths) {
    const condition = loadCondition(path.resolve(projectRoot, conditionPath));
    if (condition.interaction.mode === "memory") {
      for (const scenarioPath of scenarioPaths) {
        const scenario = loadScenario(path.resolve(projectRoot, scenarioPath));
        maxCalls = Math.max(maxCalls, scenario.claims.length);
      }
      continue;
    }
    for (const size of rosterSizes) {
      maxCalls = Math.max(maxCalls, size * condition.interaction.chatRounds);
    }
  }
  return maxCalls;
}

const MODEL_PRICING_PER_MILLION: Record<string, { input: number; output: number; label: string }> = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5, label: "Claude Haiku 4.5 via OpenRouter" },
  "anthropic/claude-haiku-4.5": { input: 1, output: 5, label: "Claude Haiku 4.5 via OpenRouter" },
  "gpt-4o-mini": { input: 0.15, output: 0.6, label: "GPT 4o mini" },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6, label: "GPT 4o mini" },
};

const MEMORY_INPUT_TOKEN_LOW = 610;
const MEMORY_INPUT_TOKEN_HIGH = 853;
const MEMORY_OUTPUT_TOKEN_LOW = 80;
const MEMORY_OUTPUT_TOKEN_HIGH = 160;
const CHAT_INPUT_TOKEN_LOW = 850;
const CHAT_INPUT_TOKEN_HIGH = 1450;
const CHAT_OUTPUT_TOKEN_LOW = 120;
const CHAT_OUTPUT_TOKEN_HIGH = 240;

function formatUsd(value: number | null): string {
  if (value === null) return "n/a";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function provenanceLabel(provenance?: Provenance | null): string {
  if (!provenance) return "unspecified";
  return provenance.kind;
}

function citationLines(bundle?: Partial<CitationBundle> | null, limit = 8): string[] {
  if (!bundle) return [];
  const lines: string[] = [];
  const labels: Record<keyof CitationBundle, string> = {
    motivation: "motivation",
    mechanism: "mechanism",
    scenario: "scenario",
    metric: "metric",
  };
  for (const key of ["motivation", "mechanism", "scenario", "metric"] as const) {
    for (const item of bundle[key] ?? []) {
      const extra = item.note ? `  ${item.note}` : "";
      lines.push(`${labels[key]}  ${item.title}${extra}`);
      if (lines.length >= limit) return lines;
    }
  }
  return lines;
}

function mergeCitationBundlesForUi(...bundles: Array<CitationBundle | undefined | null>): CitationBundle | null {
  const merged: CitationBundle = { motivation: [], mechanism: [], scenario: [], metric: [] };
  const seen = new Set<string>();
  for (const bundle of bundles) {
    if (!bundle) continue;
    for (const key of ["motivation", "mechanism", "scenario", "metric"] as const) {
      for (const item of bundle[key] ?? []) {
        const mark = `${key}|${item.title}|${item.url ?? ""}|${item.note ?? ""}`;
        if (seen.has(mark)) continue;
        seen.add(mark);
        merged[key].push(item);
      }
    }
  }
  return Object.values(merged).some((items) => items.length > 0) ? merged : null;
}

function summarizeConditionForUi(condition: Condition): {
  title: string;
  provenance: string;
  citationItems: string[];
} {
  return {
    title: condition.title,
    provenance: provenanceLabel(condition.provenance),
    citationItems: citationLines(condition.citations, 4),
  };
}

function summarizeScenarioForUi(scenario: Scenario): {
  scenarioTitle: string;
  focusClaimText: string;
  focusClaimTruthLabel: string;
  sourceItems: string[];
  seedNotes: string[];
  seedEntries: string[];
  provenance: string;
  citationItems: string[];
  mechanismFamily: string;
  mechanismTags: string[];
} {
  const focusClaim = scenario.claims.find((claim) => claim.id === scenario.focusClaimId);
  const focusSeedEntries = scenario.initialMemoryEntries.filter((entry) => entry.claimId === scenario.focusClaimId);
  const seedAgents = [...new Set(focusSeedEntries.map((entry) => entry.agentId))];
  const seedNotes: string[] = [];
  if (focusSeedEntries.length > 0) {
    seedNotes.push(`${focusSeedEntries.length} seeded focus claim memories from ${seedAgents.join(", ")}`);
  } else {
    seedNotes.push("no seeded focus claim memories");
  }
  if (scenario.scheduledInterventions.length > 0) {
    seedNotes.push(`first correction at step ${scenario.scheduledInterventions[0].step}`);
  } else {
    seedNotes.push("no scheduled correction");
  }
  return {
    scenarioTitle: scenario.title,
    focusClaimText: focusClaim?.text ?? scenario.focusClaimId,
    focusClaimTruthLabel: focusClaim?.truthLabel ?? "unknown",
    provenance: provenanceLabel(scenario.provenance),
    citationItems: citationLines(scenario.citations, 5),
    mechanismFamily: mechanismFamilyLabel(scenario.mechanismFamily),
    mechanismTags: scenario.mechanismTags.slice(0, 4),
    sourceItems: (
      scenario.sourceCards.length > 0
        ? scenario.sourceCards.map((card, index) => `[${index + 1}] ${card.id}: ${card.title}`)
        : (scenario.sources ?? []).map((source, index) => `[${index + 1}] ${source.id ?? `source_${index + 1}`}: ${source.label}`)
    ).slice(0, 5),
    seedNotes,
    seedEntries: focusSeedEntries.map((entry) => `${entry.agentId}: ${entry.text}`).slice(0, 4),
  };
}

function roleLabelForUi(role: string): string {
  if (role === "contamination_agent") return "contamination";
  if (role === "specialist_agent") return "specialist";
  if (role === "regular_agent") return "regular";
  return role.replace(/_agent$/, "").replace(/_/g, " ");
}

function roleMixSummary(agents: AgentSpec[]): string {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    const key = roleLabelForUi(agent.role);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ordered = ["contamination", "specialist", "regular"];
  const parts = ordered
    .filter((key) => (counts.get(key) ?? 0) > 0)
    .map((key) => `${counts.get(key)} ${key}`);
  for (const [key, value] of counts.entries()) {
    if (!ordered.includes(key)) {
      parts.push(`${value} ${key}`);
    }
  }
  return parts.join(", ");
}

function taskCardScreen(
  title: string,
  scenarioInfo: ReturnType<typeof summarizeScenarioForUi>,
  conditionInfo: ReturnType<typeof summarizeConditionForUi> | null,
  manifestInfo: { provenance: string; citationItems: string[] } | null,
  agents: AgentSpec[],
  extras: string[],
): string[] {
  const w = W();
  const citationBlock = [
    ...(manifestInfo?.citationItems ?? []).map((item) => `  ${C.cyan}study${C.reset} ${item}`),
    ...scenarioInfo.citationItems.map((item) => `  ${C.cyan}scenario${C.reset} ${item}`),
    ...((conditionInfo?.citationItems ?? []).map((item) => `  ${C.cyan}condition${C.reset} ${item}`)),
  ].slice(0, 10);
  const lines = [
    ...bannerCompact(title),
    "",
    `  ${C.blue}task${C.reset}          ${C.cyan}${scenarioInfo.scenarioTitle}${C.reset}`,
    `  ${C.blue}focus claim${C.reset}    ${C.dim}${scenarioInfo.focusClaimText}${C.reset}`,
    `  ${C.blue}truth label${C.reset}    ${scenarioInfo.focusClaimTruthLabel === "false" ? `${C.bRed}false${C.reset}` : scenarioInfo.focusClaimTruthLabel === "true" ? `${C.bGreen}true${C.reset}` : `${C.yellow}mixed${C.reset}`}`,
    `  ${C.blue}study kind${C.reset}    ${C.bCyan}${manifestInfo?.provenance ?? "unspecified"}${C.reset}`,
    `  ${C.blue}scenario kind${C.reset} ${C.bCyan}${scenarioInfo.provenance}${C.reset}`,
    `  ${C.blue}mechanism${C.reset}     ${C.bCyan}${scenarioInfo.mechanismFamily}${C.reset}`,
    ...(scenarioInfo.mechanismTags.length > 0
      ? [`  ${C.blue}tags${C.reset}          ${C.dim}${scenarioInfo.mechanismTags.join(", ")}${C.reset}`]
      : []),
    ...(conditionInfo ? [`  ${C.blue}condition kind${C.reset} ${C.bCyan}${conditionInfo.provenance}${C.reset}`] : []),
    `  ${C.blue}role mix${C.reset}       ${C.bCyan}${roleMixSummary(agents) || "unknown"}${C.reset}`,
    ...extras,
    "",
    `${C.bCyan}${C.bold}Where this came from${C.reset}`,
    ...(citationBlock.length > 0
      ? citationBlock.map((item) => truncV(item, w - 4))
      : [`  ${C.dim}no citations saved${C.reset}`]),
    "",
    `${C.bCyan}${C.bold}Sources${C.reset}`,
    ...(scenarioInfo.sourceItems.length > 0
      ? scenarioInfo.sourceItems.map((item) => `  ${C.cyan}${item}${C.reset}`)
      : [`  ${C.dim}none${C.reset}`]),
    "",
    `${C.bCyan}${C.bold}Seeded focus claim entries${C.reset}`,
    ...(scenarioInfo.seedEntries.length > 0
      ? scenarioInfo.seedEntries.map((item) => truncV(`  ${C.dim}${item}${C.reset}`, w - 4))
      : [`  ${C.dim}none${C.reset}`]),
    "",
    `${C.dim}Press Enter to start this run.${C.reset}`,
    "",
  ];
  return frame(lines, w, "heavy");
}

function readManifestRosters(
  manifest: Record<string, unknown>,
  projectRoot: string,
): { id: string; title: string; agents: AgentSpec[] }[] {
  const directRosters = Array.isArray(manifest.rosters) ? manifest.rosters as { id: string; title: string; agents: AgentSpec[] }[] : [];
  if (directRosters.length > 0) return directRosters;

  const rosterPaths = Array.isArray(manifest.rosterPaths) ? manifest.rosterPaths as string[] : [];
  if (rosterPaths.length > 0) {
    return rosterPaths.map((rosterPath) => {
      const resolved = path.resolve(projectRoot, rosterPath);
      return JSON.parse(fs.readFileSync(resolved, "utf8")) as { id: string; title: string; agents: AgentSpec[] };
    });
  }

  const agents = Array.isArray(manifest.agents) ? manifest.agents as AgentSpec[] : [];
  if (agents.length > 0) {
    return [{ id: "default", title: "Default roster", agents }];
  }
  return [];
}

function allRostersSameSize(
  manifest: Record<string, unknown>,
  projectRoot: string,
): boolean {
  const rosters = readManifestRosters(manifest, projectRoot);
  if (rosters.length === 0) return false;
  return rosters.every((roster) => roster.agents.length === rosters[0].agents.length);
}

function applyAgentCapToManifest(
  manifest: Record<string, unknown>,
  projectRoot: string,
  agentCap: number,
): Record<string, unknown> {
  const next = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  const rosters = readManifestRosters(next, projectRoot);
  if (rosters.length > 0) {
    next.rosters = rosters.map((roster) => ({
      ...roster,
      agents: roster.agents.slice(0, Math.min(agentCap, roster.agents.length)),
    }));
    delete next.rosterPaths;
    delete next.agents;
    return next;
  }

  if (Array.isArray(next.agents)) {
    next.agents = (next.agents as AgentSpec[]).slice(0, Math.min(agentCap, (next.agents as AgentSpec[]).length));
  }
  return next;
}

function applyModelOverrideToManifest(
  manifest: Record<string, unknown>,
  projectRoot: string,
  model: string,
): Record<string, unknown> {
  const next = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  const rosters = readManifestRosters(next, projectRoot);
  if (rosters.length > 0) {
    next.rosters = rosters.map((roster) => ({
      ...roster,
      agents: roster.agents.map((agent) => ({ ...agent, model })),
    }));
    delete next.rosterPaths;
    delete next.agents;
    return next;
  }

  if (Array.isArray(next.agents)) {
    next.agents = (next.agents as AgentSpec[]).map((agent) => ({ ...agent, model }));
  }
  return next;
}

type BenchmarkPresetRecipe = {
  preferredScenarios?: string[];
  maxScenarios?: number;
  maxSeeds?: number;
  maxSteps?: number;
  maxModelCalls?: number;
  note: string;
};

type BenchmarkPresetOption = {
  label: string;
  desc: string;
  summary: string;
  manifest?: Record<string, unknown>;
};

type ConcreteBenchmarkPresetOption = BenchmarkPresetOption & {
  manifest: Record<string, unknown>;
};

const RECOMMENDED_BENCHMARK_PRESETS: Record<string, BenchmarkPresetRecipe> = {
  study1_memory_rules: {
    preferredScenarios: [
      "scenarios/distributed-ego-depletion-v1.yaml",
      "scenarios/distributed-wakefield-mmr-autism-v1.yaml",
      "scenarios/distributed-climate-attribution-v1.yaml",
      "scenarios/distributed-room-temp-superconductor-v1.yaml",
    ],
    maxScenarios: 4,
    maxSeeds: 3,
    note: "Starts with the four distributed-evidence cases so the memory-only comparison stays focused on split information rather than correction.",
  },
  study1_memory_rules_v2: {
    preferredScenarios: [
      "scenarios/distributed-ego-depletion-v1.yaml",
      "scenarios/distributed-wakefield-mmr-autism-v1.yaml",
      "scenarios/distributed-climate-attribution-v1.yaml",
      "scenarios/distributed-room-temp-superconductor-v1.yaml",
    ],
    maxScenarios: 4,
    maxSeeds: 3,
    note: "Uses the corrected Study 1 design: private initial seeding, a shared evidence board, and visible confidence decay for old shared notes.",
  },
  study1_gt_verification: {
    preferredScenarios: [
      "scenarios/distributed-ego-depletion-v1.yaml",
      "scenarios/distributed-wakefield-mmr-autism-v1.yaml",
      "scenarios/distributed-climate-attribution-v1.yaml",
      "scenarios/distributed-room-temp-superconductor-v1.yaml",
    ],
    maxScenarios: 4,
    maxSeeds: 3,
    note: "Keeps the same split-evidence cases and trims only seeds, so the only real comparison is GT signal quality.",
  },
  study2_correction_policies: {
    preferredScenarios: [
      "scenarios/ego-depletion-replication-v1.yaml",
      "scenarios/wakefield-mmr-autism-v1.yaml",
      "scenarios/stap-cells-v1.yaml",
      "scenarios/climate-attribution-v1.yaml",
    ],
    maxScenarios: 4,
    maxSeeds: 3,
    note: "Focuses on four correction-stress cases: replication update, retraction, fraud exposure, and scientific-consensus correction.",
  },
  study1_memory_benchmark: {
    preferredScenarios: [
      "scenarios/ego-depletion-replication-v1.yaml",
      "scenarios/wakefield-mmr-autism-v1.yaml",
      "scenarios/room-temp-superconductor-v1.yaml",
      "scenarios/truthfulqa-misconceptions-v1.yaml",
    ],
    maxScenarios: 4,
    maxSeeds: 3,
    note: "Covers four distinct memory-lock-in cases: replication reversal, retracted study, hype cascade, and common misconception.",
  },
  study2_correction_policy_benchmark: {
    preferredScenarios: [
      "scenarios/ego-depletion-replication-v1.yaml",
      "scenarios/wakefield-mmr-autism-v1.yaml",
      "scenarios/stap-cells-v1.yaml",
      "scenarios/climate-attribution-v1.yaml",
    ],
    maxScenarios: 4,
    maxSeeds: 3,
    note: "Focuses on four correction-stress cases: replication update, retraction, fraud exposure, and consensus-level scientific correction.",
  },
  study1_memory_scaling_benchmark: {
    preferredScenarios: [
      "scenarios/ego-depletion-replication-v1.yaml",
      "scenarios/wakefield-mmr-autism-v1.yaml",
    ],
    maxScenarios: 2,
    maxSeeds: 3,
    note: "Uses the two strongest baseline scenarios so the scale test isolates agent count rather than topic variation.",
  },
  study1_memory_model_robustness: {
    preferredScenarios: [
      "scenarios/ego-depletion-replication-v1.yaml",
      "scenarios/wakefield-mmr-autism-v1.yaml",
      "scenarios/truthfulqa-misconceptions-v1.yaml",
    ],
    maxScenarios: 3,
    maxSeeds: 3,
    note: "Uses three scenario families so model robustness is tested across replication, retraction, and misconception settings.",
  },
  study4_agent_composition_benchmark: {
    preferredScenarios: [
      "scenarios/ego-depletion-replication-v1.yaml",
      "scenarios/wakefield-mmr-autism-v1.yaml",
      "scenarios/room-temp-superconductor-v1.yaml",
      "scenarios/truthfulqa-misconceptions-v1.yaml",
    ],
    maxScenarios: 4,
    maxSeeds: 3,
    note: "Uses four cleaner topic families so changes in role mix are easier to interpret than with multiple near-duplicate retraction cases.",
  },
  study3_topology: {
    preferredScenarios: [
      "scenarios/ego-depletion-replication-v1.yaml",
      "scenarios/wakefield-mmr-autism-v1.yaml",
      "scenarios/room-temp-superconductor-v1.yaml",
    ],
    maxScenarios: 3,
    maxSeeds: 3,
    note: "Keeps three debate-friendly scenarios with vivid cascades, so topology effects show up without adding extra topic complexity.",
  },
  study5_open_discussion: {
    preferredScenarios: [
      "scenarios/open-discussion-ego-depletion-v1.yaml",
      "scenarios/open-discussion-wakefield-mmr-autism-v1.yaml",
    ],
    maxScenarios: 2,
    maxSeeds: 3,
    note: "Keeps the full open-discussion study because both scenarios are complementary and already small enough to run directly.",
  },
  study6_truthful_collusion: {
    preferredScenarios: [
      "scenarios/truthful-collusion-ego-depletion-v1.yaml",
      "scenarios/truthful-collusion-wakefield-mmr-autism-v1.yaml",
    ],
    maxScenarios: 2,
    maxSeeds: 2,
    note: "Keeps the full collusion study because the pair of scenarios already cleanly spans replication and retracted-study selective disclosure.",
  },
  study7_private_evidence_split: {
    preferredScenarios: [
      "scenarios/distributed-ego-depletion-v1.yaml",
      "scenarios/distributed-wakefield-mmr-autism-v1.yaml",
    ],
    maxScenarios: 2,
    maxSeeds: 3,
    note: "Keeps both distributed-information scenarios so the private-evidence result is not tied to just one topic.",
  },
  study8_source_exit_observer: {
    maxScenarios: 2,
    maxSeeds: 3,
    note: "Keeps all four source-exit and observer roster variants with three seeds.",
  },
  study9_correction_trust: {
    preferredScenarios: [
      "scenarios/ego-depletion-replication-v1.yaml",
      "scenarios/wakefield-mmr-autism-v1.yaml",
      "scenarios/stap-cells-v1.yaml",
    ],
    maxScenarios: 3,
    maxSeeds: 3,
    note: "Keeps all trust panels while focusing on three representative correction scenarios.",
  },
  study10_memory_poisoning: {
    maxScenarios: 6,
    maxSeeds: 3,
    note: "Keeps all six poisoning-dose variants because the dose ladder is the whole point of the study.",
  },
};

function cloneManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
}

function selectScenarioSubset(
  currentScenarios: string[],
  preferredScenarios: string[] | undefined,
  maxScenarios: number | undefined,
): string[] {
  if (currentScenarios.length === 0) return [];
  const limit = Math.max(1, Math.min(maxScenarios ?? currentScenarios.length, currentScenarios.length));
  if (!preferredScenarios || preferredScenarios.length === 0) {
    return currentScenarios.slice(0, limit);
  }

  const selected: string[] = [];
  for (const scenarioPath of preferredScenarios) {
    if (currentScenarios.includes(scenarioPath) && !selected.includes(scenarioPath)) {
      selected.push(scenarioPath);
    }
    if (selected.length >= limit) return selected;
  }
  for (const scenarioPath of currentScenarios) {
    if (!selected.includes(scenarioPath)) {
      selected.push(scenarioPath);
    }
    if (selected.length >= limit) return selected;
  }
  return selected;
}

function manifestSizeSummary(manifest: Record<string, unknown>, projectRoot: string): string {
  const scenarioCount = Array.isArray(manifest.scenarios) ? manifest.scenarios.length : 0;
  const conditionCount = Array.isArray(manifest.conditions) ? manifest.conditions.length : 0;
  const rosterCount = readManifestRosters(manifest, projectRoot).length;
  const seedCount = Array.isArray(manifest.seeds) ? manifest.seeds.length : 0;
  const roundCap = typeof manifest.maxSteps === "number" ? manifest.maxSteps : 0;
  return `${scenarioCount} scenarios  ${conditionCount} conditions  ${rosterCount} rosters  ${seedCount} seeds  ${roundCap} rounds`;
}

function scenarioTitlePreviewLines(
  manifest: Record<string, unknown>,
  projectRoot: string,
  width: number,
): string[] {
  const scenarioPaths = Array.isArray(manifest.scenarios) ? manifest.scenarios as string[] : [];
  if (scenarioPaths.length === 0) {
    return [`  ${C.dim}No scenarios in this preset.${C.reset}`];
  }
  return scenarioPaths.map((scenarioPath, index) => {
    const scenario = loadScenario(path.resolve(projectRoot, scenarioPath));
    return truncV(
      `  ${C.blue}[${index + 1}]${C.reset} ${C.cyan}${scenario.title}${C.reset}`,
      Math.max(30, width - 6),
    );
  });
}

function conditionTitlePreviewLines(
  manifest: Record<string, unknown>,
  projectRoot: string,
  width: number,
): string[] {
  const conditionPaths = Array.isArray(manifest.conditions) ? manifest.conditions as string[] : [];
  if (conditionPaths.length === 0) {
    return [`  ${C.dim}No conditions in this preset.${C.reset}`];
  }
  return conditionPaths.map((conditionPath, index) => {
    const condition = loadCondition(path.resolve(projectRoot, conditionPath));
    const modeBits = [condition.interaction.mode, condition.interaction.topology, condition.interaction.chatStyle]
      .filter(Boolean)
      .join(", ");
    return truncV(
      `  ${C.blue}[${index + 1}]${C.reset} ${C.cyan}${condition.title}${C.reset} ${C.dim}(${modeBits})${C.reset}`,
      Math.max(30, width - 6),
    );
  });
}

function applyRecommendedBenchmarkPreset(
  manifest: Record<string, unknown>,
  projectRoot: string,
): ConcreteBenchmarkPresetOption {
  const next = cloneManifest(manifest);
  const manifestId = typeof next.id === "string" ? next.id : "";
  const currentScenarios = Array.isArray(next.scenarios) ? next.scenarios as string[] : [];
  const currentSeeds = Array.isArray(next.seeds) ? next.seeds as number[] : [];
  const recipe = RECOMMENDED_BENCHMARK_PRESETS[manifestId];

  if (recipe) {
    next.scenarios = selectScenarioSubset(currentScenarios, recipe.preferredScenarios, recipe.maxScenarios);
    if (typeof recipe.maxSeeds === "number" && currentSeeds.length > 0) {
      next.seeds = currentSeeds.slice(0, Math.min(recipe.maxSeeds, currentSeeds.length));
    }
    if (typeof recipe.maxSteps === "number") {
      next.maxSteps = Math.min(recipe.maxSteps, typeof next.maxSteps === "number" ? next.maxSteps as number : recipe.maxSteps);
    }
  }

  const rounds = typeof next.maxSteps === "number" ? next.maxSteps as number : 0;
  const budgetFloor = conservativeCallsPerStepForManifest(next, projectRoot) * rounds;
  const currentBudget = typeof (next.budget as { maxModelCalls?: number } | undefined)?.maxModelCalls === "number"
    ? (next.budget as { maxModelCalls: number }).maxModelCalls
    : budgetFloor;
  const targetBudget = typeof recipe?.maxModelCalls === "number" ? recipe.maxModelCalls : currentBudget;
  next.budget = {
    ...(typeof next.budget === "object" && next.budget ? next.budget as Record<string, unknown> : {}),
    maxModelCalls: Math.max(targetBudget, budgetFloor),
  };

  return {
    label: "Recommended run",
    desc: "good first real experiment for this study",
    summary: recipe?.note ?? "Keeps the study structure intact while trimming obvious cost overhead.",
    manifest: next,
  };
}

function applyQuickSmokePreset(
  manifest: Record<string, unknown>,
  projectRoot: string,
): ConcreteBenchmarkPresetOption {
  const next = cloneManifest(manifest);
  const currentScenarios = Array.isArray(next.scenarios) ? next.scenarios as string[] : [];
  const currentSeeds = Array.isArray(next.seeds) ? next.seeds as number[] : [];
  const defaultMaxSteps = typeof next.maxSteps === "number" ? next.maxSteps as number : 12;
  const defaultBudget = typeof (next.budget as { maxModelCalls?: number } | undefined)?.maxModelCalls === "number"
    ? ((next.budget as { maxModelCalls: number }).maxModelCalls)
    : defaultMaxSteps;
  const conservativeCallsPerStep = conservativeCallsPerStepForManifest(next, projectRoot);

  next.scenarios = currentScenarios.slice(0, Math.min(2, currentScenarios.length));
  next.seeds = currentSeeds.slice(0, Math.min(2, currentSeeds.length));
  next.maxSteps = Math.min(6, defaultMaxSteps);
  const smokeBudgetFloor = conservativeCallsPerStep > 0
    ? conservativeCallsPerStep * (next.maxSteps as number)
    : Math.max(defaultBudget, 2);
  next.budget = {
    ...(typeof next.budget === "object" && next.budget ? next.budget as Record<string, unknown> : {}),
    maxModelCalls: Math.max(defaultBudget, smokeBudgetFloor),
  };

  return {
    label: "Quick smoke test",
    desc: "small run to check the pipeline and see the first pattern",
    summary: "Uses two scenarios, two seeds, and a shorter run budget to keep cost low.",
    manifest: next,
  };
}

async function tuneExperimentManifest(
  rl: readline.Interface,
  manifest: Record<string, unknown>,
  projectRoot: string,
): Promise<Record<string, unknown> | null> {
  const scenarioCount = Array.isArray(manifest.scenarios) ? manifest.scenarios.length : 0;
  const seedCount = Array.isArray(manifest.seeds) ? manifest.seeds.length : 0;
  const rosterCount = readManifestRosters(manifest, projectRoot).length;
  const sameSizeRosters = allRostersSameSize(manifest, projectRoot);
  const canAgentCap = sameSizeRosters && rosterCount > 0;
  const recommendedPreset = applyRecommendedBenchmarkPreset(manifest, projectRoot);
  const quickSmokePreset = applyQuickSmokePreset(manifest, projectRoot);

  const mode = await selectFromList(
    (selected) => {
      const w = W();
      const items: BenchmarkPresetOption[] = [
        {
          label: recommendedPreset.label,
          desc: recommendedPreset.desc,
          summary: `${manifestSizeSummary(recommendedPreset.manifest, projectRoot)}  ${recommendedPreset.summary}`,
          manifest: recommendedPreset.manifest,
        },
        {
          label: "Full study set",
          desc: "run the manifest exactly as written",
          summary: `${manifestSizeSummary(manifest, projectRoot)}  best when you want the full preset`,
          manifest,
        },
        {
          label: quickSmokePreset.label,
          desc: quickSmokePreset.desc,
          summary: `${manifestSizeSummary(quickSmokePreset.manifest, projectRoot)}  ${quickSmokePreset.summary}`,
          manifest: quickSmokePreset.manifest,
        },
        {
          label: "Tune setup",
          desc: canAgentCap
            ? "choose scenarios, seeds, rounds, budget, model, and optional agent cap"
            : "choose scenarios, seeds, rounds, budget, and model",
          summary: "manual control over scenario list, seed count, model, and budget caps",
        },
      ];
      const selectedItem = items[selected];
      const selectedScenarioPreviewLines = selectedItem?.manifest
        ? scenarioTitlePreviewLines(selectedItem.manifest, projectRoot, w)
        : [`  ${C.dim}Scenario list will be chosen manually in the next step.${C.reset}`];
      const selectedConditionPreviewLines = selectedItem?.manifest
        ? conditionTitlePreviewLines(selectedItem.manifest, projectRoot, w)
        : [`  ${C.dim}Condition list will stay visible after manual tuning choices.${C.reset}`];
      const lines = [
        ...bannerCompact("Study tuning"),
        "",
        `  ${C.dim}Pick a study-aware preset, run the full study set, or tune the size before launch.${C.reset}`,
        "",
        ...items.flatMap((item, i) => {
          const marker = i === selected ? `${C.bCyan}\u25b8${C.reset}` : " ";
          const label = i === selected ? `${C.bCyan}${C.bold}${item.label}${C.reset}` : `${C.cyan}${item.label}${C.reset}`;
          return [
            `  ${marker} ${label}  ${C.dim}${item.desc}${C.reset}`,
            `      ${truncV(`${C.dim}${item.summary}${C.reset}`, Math.max(36, w - 8))}`,
          ];
        }),
        "",
        `  ${C.blue}Current size${C.reset}  ${C.bCyan}${scenarioCount}${C.reset} scenarios  ${C.bCyan}${seedCount}${C.reset} seeds  ${C.bCyan}${rosterCount}${C.reset} rosters`,
        canAgentCap
          ? `  ${C.dim}Agent cap is available here because all current rosters have the same size.${C.reset}`
          : `  ${C.dim}Agent cap is disabled here because roster sizes differ and that would change the experiment meaning too much.${C.reset}`,
        "",
        ...frame([
          ` ${C.bCyan}${C.bold}Scenario bundle preview${C.reset}`,
          ...selectedScenarioPreviewLines,
        ], w - 4, "single"),
        "",
        ...frame([
          ` ${C.bCyan}${C.bold}Condition bundle preview${C.reset}`,
          ...selectedConditionPreviewLines,
        ], w - 4, "single"),
        "",
        keyHints(["\u2191\u2193 navigate", "\u23ce select", "q back"], w),
      ];
      return frame(lines, w, "heavy");
    },
    4,
  );

  if (mode === null) return null;
  if (mode === 0) return recommendedPreset.manifest;
  if (mode === 1) return manifest;

  const next = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  const currentScenarios = Array.isArray(next.scenarios) ? next.scenarios as string[] : [];
  const currentSeeds = Array.isArray(next.seeds) ? next.seeds as number[] : [];
  const defaultMaxSteps = typeof next.maxSteps === "number" ? next.maxSteps as number : 12;
  const defaultBudgetRaw = typeof (next.budget as { maxModelCalls?: number } | undefined)?.maxModelCalls === "number"
    ? ((next.budget as { maxModelCalls: number }).maxModelCalls)
    : defaultMaxSteps;
  const conservativeCallsPerStep = conservativeCallsPerStepForManifest(next, projectRoot);
  const defaultBudget = Math.max(defaultBudgetRaw, conservativeCallsPerStep * defaultMaxSteps);
  const currentModels = [...new Set(readManifestRosters(next, projectRoot).flatMap((roster) => roster.agents.map((agent) => agent.model)))];

  if (mode === 2) {
    return quickSmokePreset.manifest;
  }

  if (currentScenarios.length > 1) {
    const scenarioChoices = currentScenarios.map((scenarioPath) => {
      const scenario = loadScenario(scenarioPath);
      return {
        path: scenarioPath,
        title: scenario.title,
        claim: scenario.claims.find((claim) => claim.id === scenario.focusClaimId)?.text ?? scenario.focusClaimId,
      };
    });

    const selectedScenarios = await selectMultiple(
      (cursor, checked) => {
        const selectedCount = checked.filter(Boolean).length;
        const w = W();
        const lines = [
          ...bannerCompact("Study tuning | Scenarios"),
          "",
          `  ${C.dim}Pick the exact scenarios to include in this run.${C.reset}`,
          `  ${C.blue}selected${C.reset}  ${C.bCyan}${selectedCount}${C.reset} of ${C.bCyan}${scenarioChoices.length}${C.reset}`,
          "",
          ...scenarioChoices.flatMap((choice, i) => {
            const isCursor = i === cursor;
            const isChecked = checked[i];
            const marker = isCursor ? `${C.bCyan}\u25b8${C.reset}` : " ";
            const box = isChecked ? `${C.bGreen}[\u2713]${C.reset}` : `${C.dim}[ ]${C.reset}`;
            const label = isCursor
              ? `${C.bCyan}${C.bold}${choice.title}${C.reset}`
              : isChecked ? `${C.cyan}${choice.title}${C.reset}` : `${C.dim}${choice.title}${C.reset}`;
            return [
              `  ${marker} ${box} ${label}`,
              `      ${truncV(`${C.dim}${choice.claim}${C.reset}`, Math.max(40, w - 8))}`,
            ];
          }),
          "",
          keyHints(["\u2191\u2193 move", "space toggle", "a all", "\u23ce confirm", "q back"], w),
        ];
        return frame(lines, w, "heavy");
      },
      scenarioChoices.length,
      new Array(scenarioChoices.length).fill(true),
    );

    if (!selectedScenarios) return null;
    const selectedPaths = scenarioChoices.filter((_, i) => selectedScenarios[i]).map((choice) => choice.path);
    if (selectedPaths.length === 0) return null;
    next.scenarios = selectedPaths;
  }

  const newSeedCount = await promptRequiredNumber(
    rl,
    "How many seeds",
    currentSeeds.length,
    1,
    currentSeeds.length,
  );
  const newMaxSteps = await promptRequiredNumber(
    rl,
    "Max rounds",
    defaultMaxSteps,
    1,
  );
  const newBudget = await promptRequiredNumber(
    rl,
    "Model call cap",
    Math.max(defaultBudget, conservativeCallsPerStep * newMaxSteps),
    1,
  );
  const modelOverride = await promptOptionalText(
    rl,
    "Model override for all agents",
    currentModels.length > 0 ? `blank keeps ${currentModels.join(", ")}` : "blank keeps current",
  );

  next.seeds = currentSeeds.slice(0, Math.min(newSeedCount, currentSeeds.length));
  next.maxSteps = newMaxSteps;
  next.budget = {
    ...(typeof next.budget === "object" && next.budget ? next.budget as Record<string, unknown> : {}),
    maxModelCalls: newBudget,
  };
  if (modelOverride) {
    Object.assign(next, applyModelOverrideToManifest(next, projectRoot, modelOverride));
  }

  if (canAgentCap) {
    const rosters = readManifestRosters(next, projectRoot);
    const defaultCap = rosters[0]?.agents.length ?? 0;
    const agentCap = await promptOptionalNumber(
      rl,
      "Agent cap per roster",
      defaultCap,
      1,
      defaultCap,
    );
    if (agentCap !== undefined) {
      return applyAgentCapToManifest(next, projectRoot, agentCap);
    }
  }

  return next;
}

function estimateExperimentBudget(grid: ReturnType<typeof defineGrid>): ExperimentBudgetEstimate {
  let approxApiCallsUpper = 0;
  let totalCostLow = 0;
  let totalCostHigh = 0;
  let haveKnownPricing = true;
  const notes: string[] = [];
  let maxRoundsPerCell = grid.maxSteps;

  for (const scenarioPath of grid.scenarios) {
    const scenario = loadScenario(scenarioPath);
    const claimCount = scenario.claims.length;

    for (const conditionPath of grid.conditions) {
      const condition = loadCondition(conditionPath);
      const roundsPerCell = Math.min(grid.maxSteps, grid.budget.maxModelCalls);

      for (const roster of grid.rosters) {
        const models = [...new Set(roster.agents.map((agent) => agent.model))];
        const model = models.length === 1 ? models[0] : null;
        const pricing = model ? MODEL_PRICING_PER_MILLION[model] : undefined;

        for (const _seed of grid.seeds) {
          if (condition.interaction.mode === "memory") {
            const callsPerStep = claimCount;
            const roundsPerCell = Math.min(grid.maxSteps, Math.floor(grid.budget.maxModelCalls / Math.max(callsPerStep, 1)));
            maxRoundsPerCell = Math.min(maxRoundsPerCell, roundsPerCell);
            const cellCalls = roundsPerCell * callsPerStep;
            approxApiCallsUpper += cellCalls;

            if (pricing) {
              totalCostLow += (cellCalls * MEMORY_INPUT_TOKEN_LOW * pricing.input) / 1_000_000;
              totalCostLow += (cellCalls * MEMORY_OUTPUT_TOKEN_LOW * pricing.output) / 1_000_000;
              totalCostHigh += (cellCalls * MEMORY_INPUT_TOKEN_HIGH * pricing.input) / 1_000_000;
              totalCostHigh += (cellCalls * MEMORY_OUTPUT_TOKEN_HIGH * pricing.output) / 1_000_000;
            } else {
              haveKnownPricing = false;
            }
          } else {
            const callsPerStep = roster.agents.length * condition.interaction.chatRounds;
            const roundsPerCell = Math.min(grid.maxSteps, Math.floor(grid.budget.maxModelCalls / Math.max(callsPerStep, 1)));
            maxRoundsPerCell = Math.min(maxRoundsPerCell, roundsPerCell);
            const cellCalls = roundsPerCell * callsPerStep;
            approxApiCallsUpper += cellCalls;
            if (pricing) {
              totalCostLow += (cellCalls * CHAT_INPUT_TOKEN_LOW * pricing.input) / 1_000_000;
              totalCostLow += (cellCalls * CHAT_OUTPUT_TOKEN_LOW * pricing.output) / 1_000_000;
              totalCostHigh += (cellCalls * CHAT_INPUT_TOKEN_HIGH * pricing.input) / 1_000_000;
              totalCostHigh += (cellCalls * CHAT_OUTPUT_TOKEN_HIGH * pricing.output) / 1_000_000;
            } else {
              haveKnownPricing = false;
            }
          }
        }
      }
    }
  }

  if (grid.conditions.some((conditionPath) => loadCondition(conditionPath).interaction.mode === "memory")) {
    notes.push("memory mode makes one LLM call per claim inside each round");
    notes.push(`rough prompt assumption per call is ${MEMORY_INPUT_TOKEN_LOW}-${MEMORY_INPUT_TOKEN_HIGH} input tokens and ${MEMORY_OUTPUT_TOKEN_LOW}-${MEMORY_OUTPUT_TOKEN_HIGH} output tokens`);
  }
  if (grid.conditions.some((conditionPath) => loadCondition(conditionPath).interaction.mode === "chat")) {
    notes.push(`chat mode rough prompt assumption per call is ${CHAT_INPUT_TOKEN_LOW}-${CHAT_INPUT_TOKEN_HIGH} input tokens and ${CHAT_OUTPUT_TOKEN_LOW}-${CHAT_OUTPUT_TOKEN_HIGH} output tokens`);
  }
  if (maxRoundsPerCell <= 0) {
    notes.push("current model call cap is too low for at least one condition to complete even one round");
  }
  if (!haveKnownPricing) {
    notes.push("dollar estimate is partial or unavailable for unknown or mixed model pricing");
  }

  return {
    totalCells: grid.scenarios.length * grid.conditions.length * grid.rosters.length * grid.seeds.length,
    maxRoundsPerCell,
    approxApiCallsUpper,
    approxCostLow: haveKnownPricing ? totalCostLow : null,
    approxCostHigh: haveKnownPricing ? totalCostHigh : null,
    costLabel: haveKnownPricing ? "approx model cost" : "approx model cost unavailable",
    notes,
  };
}

function experimentPreflightScreen(
  grid: ReturnType<typeof defineGrid>,
  estimate: ExperimentBudgetEstimate,
  manifestPath?: string,
): string[] {
  const w = W();
  const modelSet = [...new Set(grid.rosters.flatMap((roster) => roster.agents.map((agent) => agent.model)))];
  const studyCitationItems = citationLines(grid.citations, 6);
  const scenarioPreview = grid.scenarios.slice(0, 4).map((scenarioPath, index) => {
    const info = summarizeScenarioForUi(loadScenario(scenarioPath));
    return [
      `  ${C.blue}[${index + 1}]${C.reset} ${C.cyan}${info.scenarioTitle}${C.reset}`,
      `      ${truncV(`${C.dim}${info.focusClaimText}${C.reset}`, Math.max(30, w - 8))}`,
      `      ${truncV(`${C.dim}mechanism: ${info.mechanismFamily}${info.mechanismTags.length > 0 ? `  tags: ${info.mechanismTags.join(", ")}` : ""}${C.reset}`, Math.max(30, w - 8))}`,
    ];
  }).flat();
  if (grid.scenarios.length > 4) {
    scenarioPreview.push(`  ${C.dim}+${grid.scenarios.length - 4} more scenarios${C.reset}`);
  }
  const conditionPreview = grid.conditions.slice(0, 4).map((conditionPath, index) => {
    const condition = loadCondition(conditionPath);
    const modeBits = [condition.interaction.mode, condition.interaction.topology, condition.interaction.chatStyle]
      .filter(Boolean)
      .join(", ");
    return `  ${C.blue}[${index + 1}]${C.reset} ${C.cyan}${condition.title}${C.reset} ${C.dim}(${modeBits})${C.reset}`;
  });
  if (grid.conditions.length > 4) {
    conditionPreview.push(`  ${C.dim}+${grid.conditions.length - 4} more conditions${C.reset}`);
  }
  const rosterPreview = grid.rosters.slice(0, 3).map((roster, index) =>
    `  ${C.blue}[${index + 1}]${C.reset} ${C.cyan}${roster.title}${C.reset} ${C.dim}${roleMixSummary(roster.agents)}${C.reset}`);
  if (grid.rosters.length > 3) {
    rosterPreview.push(`  ${C.dim}+${grid.rosters.length - 3} more rosters${C.reset}`);
  }
  return frame([
    ...bannerCompact("Experiment summary"),
    "",
    `  ${C.blue}title${C.reset}        ${C.cyan}${grid.title}${C.reset}`,
    `  ${C.blue}study id${C.reset}     ${C.bCyan}${grid.id}${C.reset}`,
    `  ${C.blue}manifest${C.reset}     ${C.dim}${manifestPath ?? "--"}${C.reset}`,
    ...(grid.requestedManifestPath && grid.requestedManifestPath !== manifestPath
      ? [`  ${C.blue}requested${C.reset}    ${C.dim}${grid.requestedManifestPath}${C.reset}`]
      : []),
    `  ${C.blue}cells${C.reset}        ${C.bCyan}${estimate.totalCells}${C.reset}`,
    `  ${C.blue}scenarios${C.reset}    ${C.bCyan}${grid.scenarios.length}${C.reset}`,
    `  ${C.blue}conditions${C.reset}   ${C.bCyan}${grid.conditions.length}${C.reset}`,
    `  ${C.blue}rosters${C.reset}      ${C.bCyan}${grid.rosters.length}${C.reset}`,
    `  ${C.blue}seeds${C.reset}        ${C.bCyan}${grid.seeds.length}${C.reset}`,
    `  ${C.blue}round cap${C.reset}    ${C.bCyan}${estimate.maxRoundsPerCell}${C.reset} per cell`,
    `  ${C.blue}study kind${C.reset}   ${C.bCyan}${provenanceLabel(grid.provenance)}${C.reset}`,
    ...(grid.benchmarkMeta
      ? [
        `  ${C.blue}study set${C.reset}    ${C.bCyan}${grid.benchmarkMeta.status}${C.reset}`,
        `  ${C.blue}claim id${C.reset}     ${C.bCyan}${grid.benchmarkMeta.claimId ?? "--"}${C.reset}`,
        `  ${C.blue}locked${C.reset}       ${grid.benchmarkMeta.locked ? `${C.bGreen}yes${C.reset}` : `${C.yellow}no${C.reset}`}`,
      ]
      : []),
    `  ${C.blue}models${C.reset}       ${C.cyan}${modelSet.join(", ")}${C.reset}`,
    "",
    `  ${C.blue}api calls${C.reset}    about ${C.bCyan}${estimate.approxApiCallsUpper.toLocaleString()}${C.reset} at full budget`,
    `  ${C.blue}${estimate.costLabel}${C.reset}  ${C.bCyan}${formatUsd(estimate.approxCostLow)}${C.reset} to ${C.bCyan}${formatUsd(estimate.approxCostHigh)}${C.reset}`,
    "",
    `${C.bCyan}${C.bold}Study citations${C.reset}`,
    ...(studyCitationItems.length > 0
      ? studyCitationItems.map((item) => truncV(`  ${C.cyan}${item}${C.reset}`, w - 4))
      : [`  ${C.dim}none${C.reset}`]),
    "",
    `${C.bCyan}${C.bold}Scenarios${C.reset}`,
    ...(scenarioPreview.length > 0 ? scenarioPreview : [`  ${C.dim}none${C.reset}`]),
    "",
    `${C.bCyan}${C.bold}Conditions${C.reset}`,
    ...(conditionPreview.length > 0 ? conditionPreview : [`  ${C.dim}none${C.reset}`]),
    "",
    `${C.bCyan}${C.bold}Rosters${C.reset}`,
    ...(rosterPreview.length > 0 ? rosterPreview : [`  ${C.dim}none${C.reset}`]),
    "",
    ...estimate.notes.map((note) => `  ${C.dim}- ${note}${C.reset}`),
    "",
    `  ${C.dim}Run this experiment now? type y to continue or anything else to go back.${C.reset}`,
    "",
  ], w, "heavy");
}

function writeLaunchManifest(
  projectRoot: string,
  manifest: Record<string, unknown>,
  requestedManifestPath: string,
): string {
  const manifestId = typeof manifest.id === "string" && manifest.id.trim() ? manifest.id.trim() : "experiment";
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const dir = path.resolve(projectRoot, "lab", "launch-manifests");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${manifestId}-${stamp}.json`);
  const payload = {
    ...manifest,
    _launchMeta: {
      savedAt: new Date().toISOString(),
      requestedManifestPath,
    },
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

function experimentLiveScreen(
  cell: ExperimentCellStatus,
  snapshot: RunProgressSnapshot | null,
  transcript: LiveTranscriptEntry[],
  activity: string[],
  estimate?: ExperimentBudgetEstimate,
): string[] {
  const w = W();
  const inner = w - 4;
  const leftW = Math.max(48, Math.floor((inner - 2) * 0.58));
  const rightW = inner - leftW - 2;
  const barW = Math.max(12, rightW - 16);
  const cellIndex = Math.min(cell.total, cell.completed + 1);
  const cellPercent = cell.total > 0 ? Math.round((cellIndex / cell.total) * 100) : 0;

  const transcriptLines = transcript.length > 0
    ? transcript.slice(-8).flatMap((entry) => {
      const stanceColor = entry.stance === "endorse"
        ? C.bRed
        : entry.stance === "reject"
          ? C.bGreen
          : C.dim;
      return [
        truncV(` ${C.blue}r${entry.round}${C.reset} ${C.bCyan}${entry.agentId}${C.reset} ${stanceColor}[${entry.stance}]${C.reset}`, leftW - 2),
        truncV(` ${C.dim}${entry.text}${C.reset}`, leftW - 2),
        "",
      ];
    })
    : activity.length > 0
      ? activity.slice(-10).map((line) => truncV(` ${C.dim}${line}${C.reset}`, leftW - 2))
      : [` ${C.dim}Waiting for the first agent action...${C.reset}`];

  const leftPanel = frame(transcriptLines, leftW, "single", transcript.length > 0 ? "live thread" : "activity");
  const contextLines = [
    ` ${C.blue}task${C.reset}        ${truncV(`${C.cyan}${cell.scenarioTitle}${C.reset}`, inner - 18)}`,
    ` ${C.blue}claim${C.reset}       ${truncV(`${C.dim}${cell.focusClaimText}${C.reset}`, inner - 18)}`,
    ` ${C.blue}truth${C.reset}       ${cell.focusClaimTruthLabel === "false" ? `${C.bRed}false${C.reset}` : cell.focusClaimTruthLabel === "true" ? `${C.bGreen}true${C.reset}` : `${C.yellow}mixed${C.reset}`}`,
    ` ${C.blue}roles${C.reset}       ${truncV(`${C.bCyan}${cell.roleMix || "unknown"}${C.reset}`, inner - 18)}`,
    ` ${C.blue}seed setup${C.reset}  ${truncV(`${C.dim}${cell.seedNotes.join("  |  ")}${C.reset}`, inner - 18)}`,
  ];
  const sourceLines = cell.sourceItems.length > 0
    ? cell.sourceItems.map((item) => truncV(` ${C.blue}source${C.reset}      ${C.cyan}${item}${C.reset}`, inner - 2))
    : [truncV(` ${C.blue}source${C.reset}      ${C.dim}none${C.reset}`, inner - 2)];
  const seedEntryLines = cell.seedEntries.length > 0
    ? cell.seedEntries.map((item) => truncV(` ${C.blue}seeded${C.reset}      ${C.dim}${item}${C.reset}`, inner - 2))
    : [truncV(` ${C.blue}seeded${C.reset}      ${C.dim}none${C.reset}`, inner - 2)];
  const contextPanel = frame([
    ...contextLines,
    "",
    ...sourceLines,
    "",
    ...seedEntryLines,
  ], inner, "single", "task context");

  const rightLines = [
    ` ${C.blue}cell${C.reset}        ${C.bCyan}${cellIndex}${C.reset}/${C.bCyan}${cell.total}${C.reset}  ${C.dim}${cellPercent}%${C.reset}`,
    ` ${C.blue}progress${C.reset}    ${progressBar(cellIndex, Math.max(cell.total, 1), barW)}`,
    ` ${C.blue}study${C.reset}       ${C.bCyan}${cell.studyId}${C.reset}`,
    ` ${C.blue}manifest${C.reset}    ${truncV(`${C.dim}${cell.manifestPath}${C.reset}`, rightW - 14)}`,
    ` ${C.blue}scenario${C.reset}    ${C.cyan}${cell.scenarioId}${C.reset}`,
    ` ${C.blue}condition${C.reset}   ${C.cyan}${cell.conditionId}${C.reset}`,
    ` ${C.blue}roster${C.reset}      ${C.cyan}${cell.rosterId}${C.reset}`,
    ` ${C.blue}seed${C.reset}        ${C.bCyan}${cell.seed}${C.reset}`,
    "",
  ];

  if (snapshot) {
    rightLines.push(
      ` ${C.blue}run${C.reset}         ${truncV(`${C.dim}${snapshot.runId}${C.reset}`, rightW - 14)}`,
      ` ${C.blue}round${C.reset}       ${C.bCyan}${snapshot.step}${C.reset}/${C.bCyan}${snapshot.maxSteps}${C.reset}`,
      ` ${C.blue}calls${C.reset}       ${C.bCyan}${snapshot.modelCalls}${C.reset}/${C.bCyan}${snapshot.maxModelCalls}${C.reset}`,
      ` ${C.blue}agent${C.reset}       ${C.bCyan}${snapshot.agentId}${C.reset}`,
      ` ${C.blue}agents${C.reset}      ${C.bCyan}${snapshot.agentStates.length}${C.reset}`,
      ` ${C.blue}stance${C.reset}      ${stanceLabel(snapshot.focusClaimStance)}`,
      ` ${C.blue}retrieved${C.reset}   ${C.bCyan}${snapshot.retrievedMemoryCount}${C.reset}`,
      ` ${C.blue}wrote${C.reset}       ${snapshot.wroteMemory ? `${C.bCyan}yes${C.reset}` : `${C.dim}no${C.reset}`}`,
      ` ${C.blue}correction${C.reset}  ${snapshot.interventionFired ? `${C.bRed}active${C.reset}` : `${C.dim}no${C.reset}`}`,
      ` ${C.blue}memory pool${C.reset} ${C.bCyan}${snapshot.memoryPoolSize}${C.reset}`,
      "",
      ` ${C.blue}false endorse${C.reset} ${C.bCyan}${(snapshot.metrics.falseClaimEndorsementRate * 100).toFixed(1)}%${C.reset}`,
      ` ${C.blue}false reject${C.reset}  ${C.bCyan}${(snapshot.metrics.falseClaimRejectRate * 100).toFixed(1)}%${C.reset}`,
      ` ${C.blue}diversity${C.reset}     ${C.bCyan}${snapshot.metrics.diversityRetention.toFixed(3)}${C.reset}`,
      ` ${C.blue}consensus${C.reset}     ${C.bCyan}${snapshot.metrics.consensusStrength.toFixed(3)}${C.reset}`,
    );
  } else {
    rightLines.push(` ${C.dim}Waiting for the first round...${C.reset}`);
  }

  if (estimate) {
    rightLines.push(
      "",
      ` ${C.blue}api calls${C.reset}   ${C.bCyan}${estimate.approxApiCallsUpper.toLocaleString()}${C.reset} max`,
      ` ${C.blue}cost${C.reset}        ${C.bCyan}${formatUsd(estimate.approxCostLow)}${C.reset} to ${C.bCyan}${formatUsd(estimate.approxCostHigh)}${C.reset}`,
    );
  }

  const rightPanel = frame(rightLines, rightW, "single", "current cell");
  const content = [
    ...bannerCompact("Experiment running"),
    "",
    ...contextPanel,
    "",
    ...sideBySide(leftPanel, rightPanel, 2),
    "",
  ];

  return frame(content, w, "heavy");
}

async function showRunCommand(rl: readline.Interface, projectRoot: string): Promise<void> {
  const choice = await selectFromList(
    (selected) => commandPickerScreen(selected),
    RUN_COMMAND_ITEMS.length,
  );
  if (choice === null) return;

  const selectedItem = RUN_COMMAND_ITEMS[choice];
  let raw = selectedItem.command ?? "";

  if (selectedItem.label === "Inspect saved run") {
    raw = await promptText(rl, "Command", "inspect");
  } else if (selectedItem.label === "Custom command") {
    raw = await promptText(rl, "Command", "memory-rules");
  }

  const tokens = expandCommandShortcut(normalizeCommandTokens(raw));
  if (tokens.length === 0) return;

  let preparedExperimentManifest: Record<string, unknown> | null = null;
  if (tokens[0] === "experiment" && tokens.length === 2) {
    const experimentPath = path.resolve(projectRoot, tokens[1]);
    if (fs.existsSync(experimentPath)) {
      const manifest = JSON.parse(fs.readFileSync(experimentPath, "utf8")) as Record<string, unknown>;
      const tuned = await tuneExperimentManifest(rl, manifest, projectRoot);
      if (tuned === null) return;
      preparedExperimentManifest = tuned;
    }
  }

  const [command, ...args] = tokens;

  if (command === "validate") {
    if (args.length !== 1) {
      draw(jsonResultScreen("Run command", "Usage: validate <run-config.yaml>"));
      await pause(rl);
      return;
    }
    const result = validateRunConfigFile(path.resolve(projectRoot, args[0]));
    draw(jsonResultScreen("Validate", JSON.stringify(result, null, 2)));
    await pause(rl);
    return;
  }

  if (command === "run") {
    if (args.length !== 1) {
      draw(jsonResultScreen("Run command", "Usage: run <run-config.yaml>"));
      await pause(rl);
      return;
    }
    const summary = await runFromConfigAsync(path.resolve(projectRoot, args[0]), { projectRoot });
    draw(runCompleteScreen(summary));
    await pause(rl);
    return;
  }

  if (command === "batch") {
    if (args.length !== 2) {
      draw(jsonResultScreen("Run command", "Usage: batch <run-config.yaml> <seed1,seed2,...>"));
      await pause(rl);
      return;
    }
    const seeds = args[1].split(",").map(Number).filter((n) => Number.isFinite(n));
    const result = await runBatch(path.resolve(projectRoot, args[0]), seeds, (seed, i, total) => {
      draw(jsonResultScreen("Batch running", `Completed seed ${seed} (${i + 1}/${total})`));
    });
    draw(batchScreen(result));
    await pause(rl);
    return;
  }

  if (command === "compare") {
    if (args.length !== 2) {
      draw(jsonResultScreen("Run command", "Usage: compare <run-config-a.yaml> <run-config-b.yaml>"));
      await pause(rl);
      return;
    }
    const result = await compareRunConfigs(path.resolve(projectRoot, args[0]), path.resolve(projectRoot, args[1]));
    draw(comparisonScreen(result));
    await pause(rl);
    return;
  }

  if (command === "inspect") {
    if (args.length !== 1) {
      draw(jsonResultScreen("Run command", "Usage: inspect <run-id|summary.json|trace.db>"));
      await pause(rl);
      return;
    }
    const result = inspectRun(args[0], projectRoot);
    draw(inspectionScreen(result));
    await pause(rl);
    return;
  }

  if (command === "archive") {
    if (args.length > 1) {
      draw(jsonResultScreen("Run command", "Usage: archive [record-id]"));
      await pause(rl);
      return;
    }
    if (args.length === 0) {
      draw(jsonResultScreen("Archive", JSON.stringify(listArchivedExperiments(projectRoot, 50), null, 2)));
      await pause(rl);
      return;
    }
    const record = inspectArchivedExperiment(args[0], projectRoot);
    draw(jsonResultScreen("Archive", JSON.stringify(record, null, 2)));
    await pause(rl);
    return;
  }

  if (command === "analyze") {
    if (args.length !== 1) {
      draw(jsonResultScreen("Run command", "Usage: analyze <run-id|summary.json|trace.db>"));
      await pause(rl);
      return;
    }
    const report = analyzeRunPhysics(args[0], projectRoot);
    draw(jsonResultScreen("Analyze", JSON.stringify(report, null, 2)));
    await pause(rl);
    return;
  }

  if (command === "experiment") {
    if (args.length !== 1) {
      draw(jsonResultScreen("Run command", "Usage: experiment <grid-config.json>"));
      await pause(rl);
      return;
    }
    const manifest: Record<string, unknown> = preparedExperimentManifest
      ?? JSON.parse(fs.readFileSync(path.resolve(projectRoot, args[0]), "utf8")) as Record<string, unknown>;
    const launchManifestPath = writeLaunchManifest(projectRoot, manifest, args[0]);
    const grid = defineGrid({ ...(manifest as Record<string, unknown>), projectRoot, sourceManifestPath: launchManifestPath } as {
      id?: string;
      title?: string;
      provenance?: Provenance;
      citations?: CitationBundle;
      sourceManifestPath?: string;
      requestedManifestPath?: string;
      benchmarkMeta?: {
        status: "canonical" | "supporting" | "pilot" | "deprecated";
        claimId?: string;
        locked?: boolean;
        notes?: string[];
        supersedes?: string[];
      } | null;
      _launchMeta?: { requestedManifestPath?: string };
      scenarios: string[];
      conditions: string[];
      seeds: number[];
      agents?: AgentSpec[];
      rosters?: { id: string; title: string; agents: AgentSpec[] }[];
      rosterPaths?: string[];
      maxSteps?: number;
      budget?: { maxModelCalls: number };
      outputDir?: string;
      projectRoot?: string;
    });
    const estimate = estimateExperimentBudget(grid);
    draw(experimentPreflightScreen(grid, estimate, args[0]));
    const confirm = (await promptText(rl, `Run experiment [${grid.id}]`, "y")).trim().toLowerCase();
    if (confirm !== "y" && confirm !== "yes") {
      return;
    }
    const totalCells = grid.scenarios.length * grid.conditions.length * grid.rosters.length * grid.seeds.length;
    let currentCell: ExperimentCellStatus | null = null;
    let currentSnapshot: RunProgressSnapshot | null = null;
    let transcript: LiveTranscriptEntry[] = [];
    let activity: string[] = [];
    const result = await runGrid(grid, {
      onProgress: (completed, total, cell) => {
        if (completed < total) {
          const scenarioInfo = summarizeScenarioForUi(loadScenario(cell.scenarioPath));
          const conditionInfo = summarizeConditionForUi(loadCondition(cell.conditionPath));
          currentCell = {
            studyId: grid.id,
            manifestPath: args[0],
            completed,
            total,
            scenarioId: cell.scenarioId,
            scenarioTitle: scenarioInfo.scenarioTitle,
            conditionId: cell.conditionId,
            rosterId: cell.rosterId,
            seed: cell.seed,
            focusClaimText: scenarioInfo.focusClaimText,
            focusClaimTruthLabel: scenarioInfo.focusClaimTruthLabel,
            sourceItems: [
              ...scenarioInfo.sourceItems,
              ...scenarioInfo.citationItems.map((item) => `ref ${item}`),
              ...conditionInfo.citationItems.map((item) => `rule ${item}`),
            ].slice(0, 8),
            seedNotes: scenarioInfo.seedNotes,
            seedEntries: scenarioInfo.seedEntries,
            roleMix: roleMixSummary(grid.rosters.find((roster) => roster.id === cell.rosterId)?.agents ?? []),
          };
          currentSnapshot = null;
          transcript = [];
          activity = [];
          draw(experimentLiveScreen(currentCell, currentSnapshot, transcript, activity, estimate));
        }
      },
      runOptions: {
        projectRoot,
        onChatMessage: (msg) => {
          if (!currentCell) return;
          transcript.push({
            round: msg.round,
            agentId: msg.agentId,
            stance: msg.stance ?? "uncertain",
            text: msg.text,
          });
          if (transcript.length > 12) transcript = transcript.slice(-12);
          draw(experimentLiveScreen(currentCell, currentSnapshot, transcript, activity, estimate));
        },
        onStep: (snapshot) => {
          if (!currentCell) return;
          currentSnapshot = snapshot;
          activity.push(
            `round ${snapshot.step}  ${snapshot.agentId}  ${snapshot.focusClaimStance}  mem:${snapshot.retrievedMemoryCount}  write:${snapshot.wroteMemory ? "yes" : "no"}`,
          );
          if (activity.length > 14) activity = activity.slice(-14);
          draw(experimentLiveScreen(currentCell, currentSnapshot, transcript, activity, estimate));
        },
      },
    });
    const tables = generatePaperTables(result, "markdown");
    draw(jsonResultScreen(
      "Experiment complete",
      `Study id: ${grid.id}\nManifest: ${args[0]}\n\n${tables}\n\nGrid results saved: ${result.outputPath}\nTotal cells: ${totalCells}`,
    ));
    await pause(rl);
    return;
  }

  draw(jsonResultScreen("Run command", `Unsupported command: ${command}`));
  await pause(rl);
}

function historyPickerScreen(summaries: RunSummary[], selectedIndex: number): string[] {
  const w = W();
  const rightW = Math.max(36, Math.floor(w * 0.38));
  const leftW = w - rightW - 6;

  const menuLines = summaries.flatMap((summary, index) => {
    const selected = index === selectedIndex;
    const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : " ";
    const title = selected ? `${C.bCyan}${C.bold}${summary.runId}${C.reset}` : `${C.cyan}${summary.runId}${C.reset}`;
    const peak = (summary.peakFalseClaimEndorsementRate * 100).toFixed(0);
    return [
      `${marker} ${truncV(title, leftW - 4)}`,
      `    ${C.blue}${summary.conditionId}${C.reset} ${C.dim}peak:${peak}%${C.reset}`,
      "",
    ];
  });

  const sel = summaries[selectedIndex];
  const detailLines: string[] = sel ? [
    `${C.bCyan}${sel.conditionId}${C.reset}`,
    "",
    `${C.blue}scenario${C.reset}    ${C.dim}${sel.scenarioId}${C.reset}`,
    `${C.blue}mode${C.reset}        ${C.cyan}${sel.interactionMode}${C.reset}  ${C.cyan}${sel.memoryMode}${C.reset}`,
    `${C.blue}topology${C.reset}    ${C.cyan}${sel.topology}${C.reset}`,
    `${C.blue}agents${C.reset}      ${C.bCyan}${sel.agentCount}${C.reset}  ${C.blue}rounds${C.reset} ${C.bCyan}${sel.completedSteps}${C.reset}/${C.dim}${sel.maxSteps}${C.reset}`,
    "",
    `${C.blue}peak endorse${C.reset}  ${C.bRed}${(sel.peakFalseClaimEndorsementRate * 100).toFixed(0)}%${C.reset}`,
    `${C.blue}final reject${C.reset}  ${C.bGreen}${(sel.finalFalseClaimRejectRate * 100).toFixed(0)}%${C.reset}`,
    `${C.blue}uncertain${C.reset}     ${C.dim}${(sel.finalUncertainRate * 100).toFixed(0)}%${C.reset}`,
    `${C.blue}majority at${C.reset}   ${C.bCyan}${sel.timeToMajorityAdoption ?? "never"}${C.reset}`,
    `${C.blue}correction${C.reset}    ${C.bCyan}${sel.timeToCorrection ?? "none"}${C.reset}`,
    "",
    `${C.blue}consensus${C.reset}     ${C.bCyan}${sel.trajectory.finalConsensusStrength.toFixed(2)}${C.reset}`,
    `${C.blue}stance${C.reset}        ${sel.trajectory.finalMajorityStance === "endorse" ? `${C.bRed}endorse${C.reset}` : sel.trajectory.finalMajorityStance === "reject" ? `${C.bGreen}reject${C.reset}` : `${C.dim}uncertain${C.reset}`}`,
    `${C.blue}diversity${C.reset}     ${C.bCyan}${sel.diversityRetention.toFixed(2)}${C.reset}`,
  ] : [`${C.dim}No run selected.${C.reset}`];

  const detailPanel = frame(detailLines, rightW, "round", "\u25c6 details");
  while (menuLines.length < detailPanel.length) menuLines.push("");

  return frame([
    ...bannerCompact("Run history"),
    "",
    ...sideBySide(menuLines, detailPanel, 3),
    "",
    keyHints(["\u2191\u2193 navigate", "\u23ce inspect", "q back"], w),
  ], w);
}

function inspectionScreen(inspection: RunInspection): string[] {
  const w = W();
  const sparkWidth = Math.max(12, w - 24);
  const visualPanelWidth = Math.max(42, Math.floor((w - 7) / 2));

  const stanceIcon = (s: string) => s === "endorse" ? `${C.bRed}\u25cf${C.reset}` : s === "reject" ? `${C.bGreen}\u25cf${C.reset}` : `${C.dim}\u25cb${C.reset}`;

  const interventionLines = inspection.interventions.length === 0
    ? [`  ${C.dim}No correction events fired.${C.reset}`]
    : inspection.interventions.slice(0, 4).map((item) =>
      truncV(
        `  ${C.blue}round ${C.bCyan}${item.step}${C.reset} ${C.blue}\u2502${C.reset} ${C.cyan}${item.interventionId}${C.reset} ${C.blue}\u2502${C.reset} ${C.dim}effect ${item.effect.toFixed(2)}${C.reset}`,
        w - 4,
      ),
    );

  const stateLines = inspection.finalFocusStates.length === 0
    ? [`  ${C.dim}No final focus-claim states recorded.${C.reset}`]
    : inspection.finalFocusStates.map((state) =>
      truncV(
        `  ${stanceIcon(state.stance)} ${C.bCyan}${state.agentId}${C.reset} ${C.blue}\u2502${C.reset} ${state.stance === "endorse" ? C.bRed : state.stance === "reject" ? C.bGreen : C.dim}${state.stance}${C.reset} ${C.blue}\u2502${C.reset} ${C.cyan}conf ${state.confidence.toFixed(2)}${C.reset} ${C.blue}\u2502${C.reset} ${C.dim}truth:${state.truthLabel}${C.reset}`,
        w - 4,
      ),
    );

  const eventLines = inspection.recentEvents.length === 0
    ? [`  ${C.dim}No recent events recorded.${C.reset}`]
    : inspection.recentEvents.map((event) =>
      truncV(
        `  ${C.blue}round ${C.bCyan}${event.step}${C.reset} ${stanceIcon(event.focusClaimStance)} ${C.cyan}${event.agentId}${C.reset} ${event.focusClaimStance === "endorse" ? C.bRed : event.focusClaimStance === "reject" ? C.bGreen : C.dim}${event.focusClaimStance}${C.reset} ${event.wroteMemory ? `${C.bCyan}\u270e${C.reset}` : ""} ${C.dim}ret:${event.retrievedMemoryCount} corr:${event.interventionCount}${C.reset}`,
        w - 4,
      ),
    );

  const memoryLines = inspection.recentMemoryEntries.length === 0
    ? [`  ${C.dim}No memory entries recorded.${C.reset}`]
    : inspection.recentMemoryEntries.map((entry) =>
      truncV(
        `  ${C.blue}round ${C.bCyan}${entry.step}${C.reset} ${stanceIcon(entry.stance)} ${C.cyan}${entry.agentId}${C.reset} ${C.dim}${entry.visibility}${C.reset} ${C.dim}${entry.text.slice(0, 40)}${C.reset}`,
        w - 4,
      ),
    );

  const scenarioLines = inspection.scenarioContext
    ? [
      `  ${C.blue}task${C.reset}        ${truncV(`${C.cyan}${inspection.scenarioContext.scenarioTitle}${C.reset}`, w - 18)}`,
      `  ${C.blue}claim${C.reset}       ${truncV(`${C.dim}${inspection.scenarioContext.focusClaimText}${C.reset}`, w - 18)}`,
      `  ${C.blue}truth${C.reset}       ${inspection.scenarioContext.focusClaimTruthLabel === "false" ? `${C.bRed}false${C.reset}` : inspection.scenarioContext.focusClaimTruthLabel === "true" ? `${C.bGreen}true${C.reset}` : `${C.yellow}mixed${C.reset}`}`,
      `  ${C.blue}seed setup${C.reset}  ${truncV(`${C.dim}${inspection.scenarioContext.seedNotes.join("  |  ")}${C.reset}`, w - 18)}`,
      ...(inspection.scenarioContext.sourceLabels.length > 0
        ? inspection.scenarioContext.sourceLabels.slice(0, 5).map((item) =>
          truncV(`  ${C.blue}source${C.reset}      ${C.cyan}${item}${C.reset}`, w - 4))
        : [`  ${C.blue}source${C.reset}      ${C.dim}none${C.reset}`]),
      "",
    ]
    : [];

  const mapPanel = memoryMapPanel(
    inspection.memoryFlow,
    inspection.summary.memoryMode,
    visualPanelWidth,
  );
  const matrixPanel = claimMatrixPanel(
    inspection.claimMatrix,
    inspection.interventions.map((item) => item.step),
    visualPanelWidth,
  );
  const visualRows = w >= 108
    ? sideBySide(mapPanel, matrixPanel, 3)
    : [...mapPanel, "", ...matrixPanel];

  const content = [
    ...bannerCompact(`Archive \u00b7 ${inspection.summary.conditionId}`),
    "",
    ...summaryBlock(inspection.summary),
    "",
    ...scenarioLines,
    `${C.bCyan}${C.bold}\u2261 timeline${C.reset}`,
    `  ${C.blue}endorse${C.reset}   ${sparkline(inspection.metricTimeline.map((m) => m.falseClaimEndorsementRate), sparkWidth)}`,
    `  ${C.blue}consensus${C.reset} ${sparkline(inspection.metricTimeline.map((m) => m.consensusStrength), sparkWidth)}`,
    `  ${C.blue}net${C.reset}       ${sparkline(inspection.metricTimeline.map((m) => m.netEndorsement + 1), sparkWidth)}`,
    `  ${C.blue}distance${C.reset}  ${sparkline(inspection.metricTimeline.map((m) => m.distanceFromGroundTruth), sparkWidth)}`,
    `  ${C.blue}diversity${C.reset} ${sparkline(inspection.metricTimeline.map((m) => m.diversityRetention), sparkWidth)}`,
    "",
    `${C.bCyan}${C.bold}\u2261 structure${C.reset}`,
    ...visualRows,
    "",
    `${C.bCyan}${C.bold}\u2261 interventions${C.reset}`,
    ...interventionLines,
    "",
    `${C.bCyan}${C.bold}\u2261 final focus states${C.reset}`,
    ...stateLines,
    "",
    `${C.bCyan}${C.bold}\u2261 recent events${C.reset}`,
    ...eventLines,
    "",
    `${C.bCyan}${C.bold}\u2261 recent memory${C.reset}`,
    ...memoryLines,
    "",
    statusBar([
      { label: "status", value: inspection.status },
      { label: "engine", value: inspection.engineMode },
      { label: "focus", value: inspection.focusClaimId ?? "n/a" },
    ], w),
  ];
  return frame(content, w, "heavy");
}

// --- Actions ---

// --- Chat transcript display ---

const ROLE_COLORS: Record<string, string> = {
  contamination_agent: C.bRed,
  specialist_agent: C.bCyan,
  regular_agent: C.reset,
};

const STANCE_COLORS: Record<string, string> = {
  endorse: C.bRed,
  reject: C.green,
  uncertain: C.yellow,
};

function chatTranscriptLines(messages: ChatMessage[], w: number): string[] {
  const lines: string[] = [];
  let lastRound = 0;

  for (const msg of messages) {
    if (msg.round !== lastRound) {
      lastRound = msg.round;
      lines.push("");
      lines.push(`  ${C.dim}${"─".repeat(Math.min(50, w - 8))}${C.reset}`);
      lines.push(`  ${C.bCyan}${C.bold}Round ${msg.round}${C.reset}`);
      lines.push("");
    }

    const agentColor = ROLE_COLORS[msg.agentId.replace(/_\d+$/, "_agent")] ?? C.reset;
    const stanceColor = msg.stance ? (STANCE_COLORS[msg.stance] ?? C.dim) : C.dim;
    const stanceBadge = msg.stance
      ? ` ${stanceColor}[${msg.stance.toUpperCase()} ${((msg.confidence ?? 0) * 100).toFixed(0)}%]${C.reset}`
      : "";
    const typeBadge = msg.messageType ? ` ${C.yellow}<${msg.messageType}>${C.reset}` : "";
    const citationBadge = msg.citedSourceIds && msg.citedSourceIds.length > 0
      ? ` ${C.cyan}{${msg.citedSourceIds.join(", ")}}${C.reset}`
      : "";

    lines.push(`  ${agentColor}${C.bold}${msg.agentId}${C.reset}${stanceBadge}${typeBadge}${citationBadge}`);

    // Wrap message text to terminal width
    const maxMsgW = w - 8;
    const msgText = msg.text || "(no message)";
    const words = msgText.split(/\s+/);
    let line = "    ";
    for (const word of words) {
      if (line.length + word.length + 1 > maxMsgW && line.trim().length > 0) {
        lines.push(`${C.dim}${line}${C.reset}`);
        line = "    ";
      }
      line += (line.trim().length > 0 ? " " : "") + word;
    }
    if (line.trim().length > 0) {
      lines.push(`${C.dim}${line}${C.reset}`);
    }
    lines.push("");
  }

  return lines;
}

async function runSingleConfig(rl: readline.Interface, projectRoot: string): Promise<void> {
  const config = await chooseConfig(projectRoot, "Run experiment");
  if (!config) return;

  // Check API keys for all agents
  const runConfig = loadRunConfig(config.path);
  for (const agent of runConfig.agents) {
    const status = checkProviderStatus(agent.model, projectRoot);
    if (!status.ready) {
      const w = W();
      draw(frame([
        ...bannerCompact("Provider needed"),
        "",
        `  ${C.bRed}\u2717${C.reset} Agent "${agent.id}" uses model ${C.bCyan}${agent.model}${C.reset}`,
        `  ${C.dim}but no API key is configured for ${status.keyEnvVar}.${C.reset}`,
        "",
        `  ${C.dim}Use "Provider" from the main menu to configure it,${C.reset}`,
        `  ${C.dim}or set ${status.keyEnvVar} in your environment.${C.reset}`,
        "",
      ], w));
      await pause(rl);
      return;
    }
  }

  // Detect interaction mode from condition
  const conditionPath = resolveRelativeConfigPath(config.path, runConfig.conditionPath);
  const condition = loadCondition(conditionPath);
  const isChatMode = condition.interaction.mode === "chat";

  const quick = await tuneQuickRun(rl, config);
  const currentAgents =
    quick.agentCount && quick.agentCount > 0
      ? runConfig.agents.slice(0, Math.min(quick.agentCount, runConfig.agents.length))
      : runConfig.agents;
  const agentOverride = await chooseAgentSetup(rl, currentAgents, quick.seed ?? config.seed);
  if (agentOverride && agentOverride.length > 0) {
    quick.agents = agentOverride;
  }
  const hasOverrides = Object.values(quick).some((v) => v !== undefined);
  const runConfigPath = hasOverrides ? createTemporaryRunConfig(config.path, quick) : config.path;

  const displayConfig = { ...config };
  if (quick.seed !== undefined) displayConfig.seed = quick.seed;
  if (quick.maxSteps !== undefined) displayConfig.maxSteps = quick.maxSteps;
  if (quick.maxModelCalls !== undefined) displayConfig.maxModelCalls = quick.maxModelCalls;
  if (quick.agents && quick.agents.length > 0) {
    displayConfig.agentCount = quick.agents.length;
  } else if (quick.agentCount !== undefined) {
    displayConfig.agentCount = quick.agentCount;
  }

  endorsementHistory.length = 0;
  const scenarioPath = resolveRelativeConfigPath(config.path, runConfig.scenarioPath);
  const scenario = loadScenario(scenarioPath);
  const scenarioInfo = summarizeScenarioForUi(scenario);
  const conditionInfo = summarizeConditionForUi(condition);
  const runExtras = [
    `  ${C.blue}condition${C.reset}     ${C.cyan}${config.conditionId}${C.reset} ${C.dim}(${config.memoryMode})${C.reset}`,
    `  ${C.blue}seed${C.reset}          ${C.bCyan}${displayConfig.seed}${C.reset}`,
    `  ${C.blue}round limit${C.reset}   ${C.bCyan}${displayConfig.maxSteps}${C.reset}`,
    `  ${C.blue}model budget${C.reset}  ${C.bCyan}${displayConfig.maxModelCalls}${C.reset}`,
  ];
  draw(taskCardScreen(
    "Run task card",
    scenarioInfo,
    conditionInfo,
    null,
    quick.agents && quick.agents.length > 0 ? quick.agents : currentAgents,
    runExtras,
  ));
  await askQuestion(rl, "  Press Enter to start run...");

  if (isChatMode) {
    // --- Chat mode: show live transcript ---
    const chatLog: ChatMessage[] = [];
    const w = W();

    const onChatMessage = (msg: ChatMessage, round: number, totalRounds: number) => {
      chatLog.push(msg);
      // Redraw with full transcript — show last N lines that fit
      const transcriptLines = chatTranscriptLines(chatLog, w);
      const maxVisible = Math.max(10, (process.stdout.rows || 40) - 12);
      const visibleTranscript = transcriptLines.length > maxVisible
        ? transcriptLines.slice(-maxVisible)
        : transcriptLines;

      draw(frame([
        ...bannerCompact(`Debate ${condition.interaction.topology}`),
        "",
        `  ${C.blue}\u25b8${C.reset} ${C.bCyan}${C.bold}Topology:${C.reset} ${C.cyan}${condition.interaction.topology}${C.reset}  ${C.blue}\u25b8${C.reset} ${C.bCyan}${C.bold}Round:${C.reset} ${C.cyan}${round}/${totalRounds}${C.reset}  ${C.blue}\u25b8${C.reset} ${C.bCyan}${C.bold}Agents:${C.reset} ${C.cyan}${runConfig.agents.length}${C.reset}`,
        `  ${C.blue}\u25b8${C.reset} ${C.bCyan}${C.bold}Task:${C.reset} ${C.dim}${truncV(scenarioInfo.scenarioTitle, Math.max(20, w - 20))}${C.reset}`,
        `  ${C.blue}\u25b8${C.reset} ${C.bCyan}${C.bold}Sources:${C.reset} ${C.dim}${truncV(scenarioInfo.sourceItems.join("  | ") || "none", Math.max(20, w - 20))}${C.reset}`,
        "",
        ...visibleTranscript,
        "",
        statusBar([
          { label: "mode", value: "chat" },
          { label: "topology", value: condition.interaction.topology },
          { label: "round", value: `${round}/${totalRounds}` },
          { label: "messages", value: `${chatLog.length}` },
        ], w),
      ], w));
    };

    const onStep = (snapshot: RunProgressSnapshot) => {
      // After each debate cycle completes, briefly show metrics
      draw(liveRunScreen(displayConfig, snapshot));
    };

    const summary = await runFromConfigAsync(runConfigPath, { onStep, onChatMessage, projectRoot });

    logActivity(`Chat debate done: ${summary.conditionId} (${summary.completedSteps} rounds, ${chatLog.length} messages)`);
    logActivity(`Peak endorsement: ${(summary.peakFalseClaimEndorsementRate * 100).toFixed(0)}%`);

    // Show final transcript + results
    const finalTranscript = chatTranscriptLines(chatLog, w);
    draw(frame([
      ...bannerCompact("Debate complete"),
      "",
      ...summaryBlock(summary),
      "",
      `${C.bCyan}${C.bold}\u2261 conversation transcript${C.reset}`,
      ...finalTranscript.slice(-30),
      "",
      `  ${C.dim}${chatLog.length} total messages across ${Math.max(...chatLog.map((m) => m.round))} rounds${C.reset}`,
      "",
    ], w));
    await pause(rl);
  } else {
    // --- Memory mode: existing behavior ---
    const onStep = (snapshot: RunProgressSnapshot) => {
      draw(liveRunScreen(displayConfig, snapshot));
    };

    const summary = await runFromConfigAsync(runConfigPath, { onStep, projectRoot });

    logActivity(`Run done: ${summary.conditionId} (${summary.completedSteps} rounds)`);
    logActivity(`Peak endorsement: ${(summary.peakFalseClaimEndorsementRate * 100).toFixed(0)}%`);
    draw(runCompleteScreen(summary));
    await pause(rl);
  }
}

async function runBatchConfig(rl: readline.Interface, projectRoot: string): Promise<void> {
  const config = await chooseConfig(projectRoot, "Batch run");
  if (!config) return;

  const w = W();
  draw(frame([
    ...bannerCompact("Batch setup"),
    "",
    `  ${C.blue}\u25b8${C.reset} ${C.bCyan}${C.bold}Condition:${C.reset} ${C.cyan}${config.conditionId}${C.reset} ${C.dim}(${config.memoryMode})${C.reset}`,
    `  ${C.blue}\u25b8${C.reset} ${C.bCyan}${C.bold}Scenario:${C.reset}  ${C.cyan}${config.scenarioTitle}${C.reset}`,
    "",
    `  ${C.dim}Enter comma-separated seeds (e.g. 1,2,3,4,5)${C.reset}`,
    "",
  ], w));

  const seedInput = (await askQuestion(rl, "  Seeds: ")).trim();
  if (!seedInput) return;
  const seeds = seedInput.split(",").map(Number).filter((n) => !Number.isNaN(n));
  if (seeds.length === 0) return;

  const result = await runBatch(config.path, seeds, (seed, i, total) => {
    draw(frame([
      ...bannerCompact("Batch in progress"),
      "",
      `  ${C.bCyan}Running seed ${seed}${C.reset} ${C.dim}(${i + 1}/${total})${C.reset}`,
      `  ${progressBar(i + 1, total, 30)}`,
      "",
      statusBar([
        { label: "seed", value: `${seed}` },
        { label: "progress", value: `${i + 1}/${total}` },
      ], w),
    ], w));
  });

  logActivity(`Batch done: ${seeds.length} seeds, ${config.conditionId}`);
  draw(batchScreen(result));
  await pause(rl);
}

async function compareTwoConfigs(rl: readline.Interface, projectRoot: string): Promise<void> {
  const configA = await chooseConfig(projectRoot, "Select condition A");
  if (!configA) return;
  const configB = await chooseConfig(projectRoot, "Select condition B", configA.path);
  if (!configB) return;

  const w = W();
  draw(frame([
    ...bannerCompact("Comparing"),
    "",
    `  ${C.dim}Running ${C.cyan}${configA.conditionId}${C.dim} vs ${C.cyan}${configB.conditionId}${C.dim}...${C.reset}`,
    "",
  ], w));

  const comparison = await compareRunConfigs(configA.path, configB.path);
  draw(comparisonScreen(comparison));
  await pause(rl);
}

async function showHistory(rl: readline.Interface, projectRoot: string): Promise<void> {
  const w = W();
  const summaries = listRecentRunSummaries(projectRoot).slice(0, 12);
  if (summaries.length === 0) {
    draw(frame([
      ...bannerCompact("Run archive"),
      "",
      ...recentRunsTable([]),
      "",
    ], w));
    await pause(rl);
    return;
  }

  const idx = await selectFromList(
    (selected) => historyPickerScreen(summaries, selected),
    summaries.length,
  );
  if (idx === null) {
    return;
  }

  const inspection = inspectRun(summaries[idx].dbPath, projectRoot);
  draw(inspectionScreen(inspection));
  await pause(rl);
}

function archivePickerScreen(records: ArchiveRecord[], selectedIndex: number): string[] {
  const w = W();
  const rightW = Math.max(36, Math.floor(w * 0.38));

  const menuLines = records.flatMap((record, index) => {
    const selected = index === selectedIndex;
    const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : " ";
    const title = selected
      ? `${C.bCyan}${C.bold}${record.title}${C.reset}`
      : `${C.cyan}${record.title}${C.reset}`;
    const kindIcon = record.kind === "grid" ? `${C.magenta}\u25a4${C.reset}` : record.kind === "batch" ? `${C.cyan}\u2261${C.reset}` : `${C.dim}\u25cb${C.reset}`;
    return [
      `${marker} ${kindIcon} ${title}`,
      `    ${C.dim}${record.conditions.length} cond  ${record.seeds.length} seeds${C.reset}`,
      "",
    ];
  });

  const sel = records[selectedIndex];
  const detailLines: string[] = sel ? [
    `${C.bCyan}${sel.title}${C.reset}`,
    "",
    `${C.blue}kind${C.reset}        ${C.cyan}${sel.kind}${C.reset}`,
    `${C.blue}created${C.reset}     ${C.dim}${new Date(sel.createdAt).toLocaleString()}${C.reset}`,
    ...(sel.question ? [`${C.blue}question${C.reset}    ${C.dim}${sel.question}${C.reset}`] : []),
    "",
    `${C.blue}scenarios${C.reset}   ${C.dim}${sel.scenarios.join(", ") || "--"}${C.reset}`,
    `${C.blue}conditions${C.reset}  ${C.dim}${sel.conditions.join(", ") || "--"}${C.reset}`,
    `${C.blue}rosters${C.reset}     ${C.dim}${sel.rosters.join(", ") || "--"}${C.reset}`,
    `${C.blue}seeds${C.reset}       ${C.dim}${sel.seeds.join(", ") || "--"}${C.reset}`,
    `${C.blue}runs${C.reset}        ${C.bCyan}${sel.runIds.length}${C.reset}`,
    "",
    ...Object.entries(sel.metrics).slice(0, 6).map(
      ([k, v]) => `${C.blue}${k}${C.reset}  ${C.bCyan}${String(v)}${C.reset}`,
    ),
  ] : [`${C.dim}No record selected.${C.reset}`];

  const detailPanel = frame(detailLines, rightW, "round", "\u25c6 details");
  while (menuLines.length < detailPanel.length) menuLines.push("");

  return frame([
    ...bannerCompact("Experiment archive"),
    "",
    ...sideBySide(menuLines, detailPanel, 3),
    "",
    keyHints(["\u2191\u2193 navigate", "\u23ce open", "q back"], w),
  ], w);
}

function archiveRecordScreen(record: ArchiveRecord): string[] {
  const w = W();
  const metrics = Object.entries(record.metrics).map(
    ([key, value]) => `  ${C.blue}${key}:${C.reset} ${C.bCyan}${String(value)}${C.reset}`,
  );
  const provenance = record.provenance?.kind ?? "--";
  const citationItems = citationLines(record.citations ?? null, 8);
  const outputs = [
    ...(record.primaryOutputPath ? [`  ${C.blue}Primary:${C.reset} ${C.dim}${record.primaryOutputPath}${C.reset}`] : []),
    ...record.extraOutputPaths.slice(0, 6).map((value) => `  ${C.blue}Extra:${C.reset}   ${C.dim}${value}${C.reset}`),
  ];
  return frame([
    ...bannerCompact("Experiment archive"),
    "",
    `  ${C.blue}Title:${C.reset}      ${C.bCyan}${record.title}${C.reset}`,
    `  ${C.blue}Kind:${C.reset}       ${C.cyan}${record.kind}${C.reset}`,
    `  ${C.blue}Created:${C.reset}    ${C.dim}${new Date(record.createdAt).toLocaleString()}${C.reset}`,
    `  ${C.blue}Question:${C.reset}   ${C.dim}${record.question ?? "--"}${C.reset}`,
    `  ${C.blue}Study kind:${C.reset} ${C.dim}${provenance}${C.reset}`,
    `  ${C.blue}Scenarios:${C.reset}  ${C.dim}${record.scenarios.join(", ") || "--"}${C.reset}`,
    `  ${C.blue}Conditions:${C.reset} ${C.dim}${record.conditions.join(", ") || "--"}${C.reset}`,
    `  ${C.blue}Rosters:${C.reset}    ${C.dim}${record.rosters.join(", ") || "--"}${C.reset}`,
    `  ${C.blue}Models:${C.reset}     ${C.dim}${record.models.join(", ") || "--"}${C.reset}`,
    `  ${C.blue}Seeds:${C.reset}      ${C.dim}${record.seeds.join(", ") || "--"}${C.reset}`,
    "",
    ...labSection("Citations", "\u2691", w),
    "",
    ...(citationItems.length > 0
      ? citationItems.map((item) => truncV(`  ${C.cyan}${item}${C.reset}`, w - 4))
      : [`  ${C.dim}No saved citations.${C.reset}`]),
    "",
    ...labSection("Metrics", "\u2261", w),
    "",
    ...(metrics.length > 0 ? metrics : [`  ${C.dim}No saved metrics.${C.reset}`]),
    "",
    ...labSection("Outputs", "\u25a3", w),
    "",
    ...(outputs.length > 0 ? outputs : [`  ${C.dim}No output paths saved.${C.reset}`]),
    "",
  ], w);
}

async function showArchive(rl: readline.Interface, projectRoot: string): Promise<void> {
  const records = listArchivedExperiments(projectRoot, 30).records;
  if (records.length === 0) {
    draw(frame([
      ...bannerCompact("Experiment archive"),
      "",
      `  ${C.dim}No saved records yet. Run a study, batch, compare, or single setup first.${C.reset}`,
      "",
    ], W()));
    await pause(rl);
    return;
  }

  const idx = await selectFromList(
    (selected) => archivePickerScreen(records, selected),
    records.length,
  );
  if (idx === null) return;

  const record = inspectArchivedExperiment(records[idx].id, projectRoot);
  draw(archiveRecordScreen(record));
  await pause(rl);
}

async function showConfigs(rl: readline.Interface, projectRoot: string): Promise<void> {
  const configs = discoverRunConfigs(projectRoot);
  const cards: ConfigCard[] = configs.map((c) => ({
    conditionId: c.conditionId,
    memoryMode: c.memoryMode,
    agentCount: c.agentCount,
    maxSteps: c.maxSteps,
    seed: c.seed,
    scenarioTitle: c.scenarioTitle,
  }));
  const w = W();
  draw(frame([
    ...bannerCompact("Available run configs"),
    "",
    ...configCardList(cards, -1),
  ], w));
  await pause(rl);
}

async function validateConfig(rl: readline.Interface, projectRoot: string): Promise<void> {
  const config = await chooseConfig(projectRoot, "Validate config");
  if (!config) return;
  const result = validateRunConfigFile(config.path);
  const w = W();
  draw(frame([
    ...bannerCompact("Validation result"),
    "",
    `  ${C.bGreen}\u2713 ok${C.reset}`,
    `  ${C.blue}Run config:${C.reset} ${C.bCyan}${result.runConfig}${C.reset}`,
    `  ${C.blue}Scenario:${C.reset}   ${C.bCyan}${result.scenario}${C.reset}`,
    `  ${C.blue}Condition:${C.reset}  ${C.bCyan}${result.condition}${C.reset}`,
    "",
  ], w));
  await pause(rl);
}

// --- Action: Setup Provider ---

async function setupProvider(rl: readline.Interface, projectRoot: string): Promise<void> {
  const w = W();

  const anthropicKey = resolveApiKey("anthropic", projectRoot);
  const openaiKey = resolveApiKey("openai", projectRoot);
  const orKey = resolveApiKey("openrouter", projectRoot);

  const statusLines = [
    ...bannerCompact("Provider setup"),
    "",
    `  ${C.bCyan}${C.bold}\u2261 Current status${C.reset}`,
    `  ${anthropicKey ? `${C.bGreen}\u2713${C.reset}` : `${C.red}\u2717${C.reset}`} ${C.cyan}Anthropic (Claude)${C.reset}  ${anthropicKey ? `${C.dim}${redactKey(anthropicKey)}${C.reset}` : `${C.dim}not configured${C.reset}`}`,
    `  ${openaiKey ? `${C.bGreen}\u2713${C.reset}` : `${C.red}\u2717${C.reset}`} ${C.cyan}OpenAI${C.reset}             ${openaiKey ? `${C.dim}${redactKey(openaiKey)}${C.reset}` : `${C.dim}not configured${C.reset}`}`,
    `  ${orKey ? `${C.bGreen}\u2713${C.reset}` : `${C.red}\u2717${C.reset}`} ${C.cyan}OpenRouter${C.reset}         ${orKey ? `${C.dim}${redactKey(orKey)}${C.reset}` : `${C.dim}not configured${C.reset}`}`,
    "",
    `  ${C.dim}Keys are saved to .env in the project root.${C.reset}`,
    `  ${C.dim}Auto-detected from env, .env, or ~/.flamebird/.env${C.reset}`,
    "",
    `  ${C.bCyan}${C.bold}Add a provider:${C.reset}`,
    `  ${C.bCyan}1${C.reset} ${C.cyan}Anthropic (Claude)${C.reset}`,
    `  ${C.bCyan}2${C.reset} ${C.cyan}OpenAI${C.reset}`,
    `  ${C.bCyan}3${C.reset} ${C.cyan}OpenRouter${C.reset}`,
    `  ${C.bCyan}4${C.reset} ${C.cyan}OpenAI-compatible (custom endpoint)${C.reset}`,
    `  ${C.dim}Enter to go back${C.reset}`,
    "",
  ];
  draw(frame(statusLines, w));

  const choice = (await askQuestion(rl, "  Choice: ")).trim();
  if (!choice || !["1", "2", "3", "4"].includes(choice)) return;

  const providerType: ProviderType = choice === "1" ? "anthropic" : choice === "2" ? "openai" : choice === "3" ? "openrouter" : "openai-compat";
  const providerLabel = choice === "1" ? "Anthropic" : choice === "2" ? "OpenAI" : choice === "3" ? "OpenRouter" : "Custom";

  const apiKey = (await askQuestion(rl, `  ${providerLabel} API key: `)).trim();
  if (!apiKey) return;

  let baseUrl: string | undefined;
  if (choice === "4") {
    baseUrl = (await askQuestion(rl, `  Base URL [http://localhost:11434/v1]: `)).trim() || "http://localhost:11434/v1";
  }

  draw(frame([
    ...bannerCompact("Testing connection"),
    "",
    `  ${C.dim}Connecting to ${providerLabel}...${C.reset}`,
    "",
  ], w));

  const testModel = choice === "1" ? "claude-haiku-4-5-20251001" : choice === "2" ? "gpt-4o-mini" : choice === "3" ? "anthropic/claude-haiku-4-5" : "test";
  const testBaseUrl = baseUrl ?? (providerType === "anthropic" ? "https://api.anthropic.com" : providerType === "openrouter" ? "https://openrouter.ai/api" : "https://api.openai.com");
  const status = await testProvider({
    type: providerType === "openrouter" ? "openrouter" : providerType,
    apiKey,
    baseUrl: testBaseUrl,
    model: testModel,
  });

  if (status.available) {
    saveApiKey(providerType, apiKey, projectRoot, baseUrl);
    draw(frame([
      ...bannerCompact("Provider configured"),
      "",
      `  ${C.bGreen}\u2713 Connected successfully!${C.reset}`,
      `  ${C.dim}Key saved to .env${C.reset}`,
      "",
    ], w));
  } else {
    draw(frame([
      ...bannerCompact("Connection failed"),
      "",
      `  ${C.bRed}\u2717 ${status.error}${C.reset}`,
      "",
      `  ${C.dim}Key NOT saved. Check your API key and try again.${C.reset}`,
      "",
      `  ${C.dim}Save anyway? (y/N)${C.reset}`,
      "",
    ], w));
    const saveAnyway = (await askQuestion(rl, "  ")).trim().toLowerCase();
    if (saveAnyway === "y" || saveAnyway === "yes") {
      saveApiKey(providerType, apiKey, projectRoot, baseUrl);
      console.log(`  ${C.dim}Key saved.${C.reset}`);
    }
  }

  await pause(rl);
}

// --- Action: Experiment Builder ---

type AgentDraft = {
  id: string;
  role: string;
  model: string;
  positiveEvidenceWeight: number;
  negativeEvidenceWeight: number;
  socialWeight: number;
  falseClaimBias: number;
  correctionTrust: number;
  writesMemoryThreshold: number;
  activeFromStep: number;
  activeUntilStep?: number;
  canWriteMemory: boolean;
};

type ConditionChoice = {
  path: string;
  label: string;
  id: string;
  mode: string;
  decay: boolean;
  decayHalfLife: number;
};

type ExperimentDraft = {
  name: string;
  scenarioTemplate: string;
  researchQuestion: string;
  selectedConditions: ConditionChoice[];
  // Agents (shared across all conditions)
  agents: AgentDraft[];
  // Run params
  seed: number;
  maxSteps: number;
  maxModelCalls: number;
};

function makeAgent(id: string, role: string, model = "claude-haiku-4-5-20251001"): AgentDraft {
  return { id, role, model, ...agentDefaults(role), activeFromStep: 1, canWriteMemory: true };
}

function defaultDraft(): ExperimentDraft {
  return {
    name: "",
    scenarioTemplate: "",
    researchQuestion: "",
    selectedConditions: [],
    agents: [
      makeAgent("contamination_1", "contamination_agent"),
      makeAgent("specialist_1", "specialist_agent"),
      makeAgent("regular_1", "regular_agent"),
    ],
    seed: 42,
    maxSteps: 20,
    maxModelCalls: 50,
  };
}

function agentDefaults(role: string): { positiveEvidenceWeight: number; negativeEvidenceWeight: number; socialWeight: number; falseClaimBias: number; correctionTrust: number; writesMemoryThreshold: number } {
  if (role === "contamination_agent") return { positiveEvidenceWeight: 0.6, negativeEvidenceWeight: 0.3, socialWeight: 0.1, falseClaimBias: 0.95, correctionTrust: 0.15, writesMemoryThreshold: 0.4 };
  if (role === "specialist_agent") return { positiveEvidenceWeight: 0.85, negativeEvidenceWeight: 1.2, socialWeight: 0.3, falseClaimBias: 0.0, correctionTrust: 0.95, writesMemoryThreshold: 0.3 };
  return { positiveEvidenceWeight: 0.9, negativeEvidenceWeight: 0.7, socialWeight: 1.2, falseClaimBias: 0.15, correctionTrust: 0.65, writesMemoryThreshold: 0.45 };
}

// --- Scenario creation wizard ---

async function createScenarioWizard(rl: readline.Interface, projectRoot: string): Promise<string | null> {
  const w = W();
  const yaml = (await import("js-yaml")).default;

  const prompt = (label: string, defaultVal = ""): Promise<string> => {
    return new Promise((resolve) => {
      setRawMode(false);
      rl.question(`  ${C.bCyan}${label}${C.reset}${defaultVal ? ` ${C.dim}(${defaultVal})${C.reset}` : ""}: `, (ans) => {
        resolve(ans.trim() || defaultVal);
      });
    });
  };

  // --- Title & ID ---
  draw(frame([
    ...bannerCompact("Lab \u2502 New Scenario"),
    "",
    ...labSection("Step 1: Basics", "1", w),
    "",
    `  ${C.dim}Give your scenario a title and ID.${C.reset}`,
    "",
  ], w));
  const title = await prompt("Title", "My custom scenario");
  const id = await prompt("ID (snake_case)", title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));

  // --- Claims ---
  type Claim = { id: string; text: string; truthLabel: "true" | "false" | "mixed" };
  const claims: Claim[] = [];
  let focusClaimId = "";

  draw(frame([
    ...bannerCompact("Lab \u2502 New Scenario"),
    "",
    ...labSection("Step 2: Claims", "2", w),
    "",
    `  ${C.dim}Add claims. The first false claim becomes the focus claim.${C.reset}`,
    `  ${C.dim}Enter an empty text to stop adding claims.${C.reset}`,
    "",
  ], w));

  let claimIdx = 1;
  while (true) {
    const text = await prompt(`Claim ${claimIdx} text (empty to stop)`);
    if (!text) break;

    draw(frame([
      ...bannerCompact("Lab \u2502 New Scenario"),
      "",
      `  ${C.bCyan}Claim:${C.reset} ${C.cyan}${text}${C.reset}`,
      "",
      `  ${C.dim}Truth label options: true, false, mixed${C.reset}`,
      "",
    ], w));
    const truthRaw = await prompt("Truth label", "false");
    const truthLabel = (["true", "false", "mixed"].includes(truthRaw) ? truthRaw : "false") as "true" | "false" | "mixed";

    const claimId = `claim_${claimIdx}`;
    claims.push({ id: claimId, text, truthLabel });
    if (!focusClaimId && truthLabel === "false") focusClaimId = claimId;
    claimIdx++;
  }

  if (claims.length === 0) {
    draw(frame([`  ${C.bRed}No claims added. Scenario creation cancelled.${C.reset}`, ""], w));
    await pause(rl);
    return null;
  }
  if (!focusClaimId) focusClaimId = claims[0].id;

  // --- Evidence ---
  type Evidence = { id: string; text: string; effects: { claimId: string; effect: number }[] };
  const evidence: Evidence[] = [];

  draw(frame([
    ...bannerCompact("Lab \u2502 New Scenario"),
    "",
    ...labSection("Step 3: Evidence", "3", w),
    "",
    `  ${C.dim}Add evidence pieces. Each piece affects one or more claims.${C.reset}`,
    `  ${C.dim}Enter empty text to stop.${C.reset}`,
    "",
    `  ${C.blue}Your claims:${C.reset}`,
    ...claims.map((c) => `    ${c.truthLabel === "false" ? C.bRed : c.truthLabel === "mixed" ? C.yellow : C.bGreen}${c.id}${C.reset}: ${C.dim}${c.text}${C.reset}`),
    "",
  ], w));

  let evIdx = 1;
  while (true) {
    const text = await prompt(`Evidence ${evIdx} text (empty to stop)`);
    if (!text) break;

    const effects: { claimId: string; effect: number }[] = [];
    for (const claim of claims) {
      const effectStr = await prompt(`  Effect on ${claim.id} (-1 to 1, 0 = no effect)`, "0");
      const effect = parseFloat(effectStr);
      if (!isNaN(effect) && effect !== 0) {
        effects.push({ claimId: claim.id, effect });
      }
    }

    evidence.push({ id: `ev_${evIdx}`, text, effects });
    evIdx++;
  }

  // --- Correction ---
  draw(frame([
    ...bannerCompact("Lab \u2502 New Scenario"),
    "",
    ...labSection("Step 4: Correction", "4", w),
    "",
    `  ${C.dim}Schedule a correction intervention.${C.reset}`,
    "",
  ], w));
  const corrStepStr = await prompt("Correction round (0 = none)", "8");
  const corrStep = parseInt(corrStepStr, 10);

  type Intervention = { id: string; step: number; type: "correction"; claimId: string; text: string; effect: number };
  const scheduledInterventions: Intervention[] = [];
  if (corrStep > 0) {
    const corrText = await prompt("Correction text", `Verification: the claim "${claims.find((c) => c.id === focusClaimId)?.text}" is false.`);
    const corrEffectStr = await prompt("Correction effect (-1 to 0)", "-0.85");
    const corrEffect = parseFloat(corrEffectStr) || -0.85;
    scheduledInterventions.push({
      id: "corr_1", step: corrStep, type: "correction",
      claimId: focusClaimId, text: corrText, effect: corrEffect,
    });
  }

  // --- Initial memory ---
  draw(frame([
    ...bannerCompact("Lab \u2502 New Scenario"),
    "",
    ...labSection("Step 5: Initial Memory", "5", w),
    "",
    `  ${C.dim}Add initial memory entries to pre-load into the agent pool.${C.reset}`,
    `  ${C.dim}Initial beliefs can also be set directly from these entries. Empty text to stop.${C.reset}`,
    "",
  ], w));

  type SeedEntry = { id: string; agentId: string; claimId: string; stance: "endorse" | "reject" | "uncertain"; confidence: number; visibility: "shared"; sourceType: "seed"; text: string };
  const seedMemoryEntries: SeedEntry[] = [];
  let seedIdx = 1;
  while (true) {
    const text = await prompt(`Seed ${seedIdx} text (empty to stop)`);
    if (!text) break;
    const agentId = await prompt("  Agent ID", "contamination_1");
    const claimId = await prompt("  Claim ID", focusClaimId);
    const stanceRaw = await prompt("  Stance (endorse/reject/uncertain)", "endorse");
    const stance = (["endorse", "reject", "uncertain"].includes(stanceRaw) ? stanceRaw : "endorse") as "endorse" | "reject" | "uncertain";
    const confStr = await prompt("  Confidence (0-1)", "0.85");
    const confidence = Math.max(0, Math.min(1, parseFloat(confStr) || 0.85));

    seedMemoryEntries.push({
      id: `seed_${seedIdx}`, agentId, claimId, stance, confidence,
      visibility: "shared", sourceType: "seed", text,
    });
    seedIdx++;
  }

  const initialBeliefStates = Array.from(
    new Map(
      seedMemoryEntries.map((entry) => [
        `${entry.agentId}::${entry.claimId}`,
        {
          agentId: entry.agentId,
          claimId: entry.claimId,
          stance: entry.stance,
          confidence: entry.confidence,
          score: entry.stance === "endorse" ? entry.confidence : entry.stance === "reject" ? -entry.confidence : 0,
        },
      ]),
    ).values(),
  );

  // --- Save ---
  const scenario = {
    id,
    title,
    focusClaimId,
    claims,
    evidence,
    scheduledInterventions,
    initialBeliefStates,
    initialMemoryEntries: seedMemoryEntries,
  };
  const scenarioDir = path.resolve(projectRoot, "scenarios");
  if (!fs.existsSync(scenarioDir)) fs.mkdirSync(scenarioDir, { recursive: true });
  const filePath = path.join(scenarioDir, `${id}.yaml`);

  // Validation warnings
  const warnings: string[] = [];
  if (evidence.length === 0) warnings.push("No evidence \u2014 agents need evidence to evaluate claims");
  if (claims.every((c) => c.truthLabel === "false")) warnings.push("All claims false \u2014 add true/mixed claims for ground-truth contrast");
  if (claims.every((c) => c.truthLabel === "true")) warnings.push("All claims true \u2014 add false claims to study propagation");
  if (seedMemoryEntries.length === 0 && claims.some((c) => c.truthLabel === "false")) warnings.push("No initial memory \u2014 add explicit starting beliefs or memory if you want contamination at round 0");
  if (scheduledInterventions.length === 0) warnings.push("No correction \u2014 cannot measure recovery after intervention");

  // Preview
  draw(frame([
    ...bannerCompact("Lab \u2502 New Scenario \u2502 Preview"),
    "",
    `  ${C.blue}Title:${C.reset}       ${C.bCyan}${title}${C.reset}`,
    `  ${C.blue}ID:${C.reset}          ${C.cyan}${id}${C.reset}`,
    `  ${C.blue}Focus:${C.reset}       ${C.bRed}${focusClaimId}${C.reset}`,
    `  ${C.blue}Claims:${C.reset}      ${C.bCyan}${claims.length}${C.reset} (${C.bRed}${claims.filter((c) => c.truthLabel === "false").length}F${C.reset} ${C.yellow}${claims.filter((c) => c.truthLabel === "mixed").length}M${C.reset} ${C.bGreen}${claims.filter((c) => c.truthLabel === "true").length}T${C.reset})`,
    `  ${C.blue}Evidence:${C.reset}    ${C.bCyan}${evidence.length}${C.reset}`,
    `  ${C.blue}Corrections:${C.reset} ${C.bCyan}${scheduledInterventions.length}${C.reset}`,
    `  ${C.blue}Initial beliefs:${C.reset} ${C.bCyan}${initialBeliefStates.length}${C.reset}`,
    `  ${C.blue}Initial memory:${C.reset}  ${C.bCyan}${seedMemoryEntries.length}${C.reset}`,
    "",
    ...(warnings.length > 0 ? [
      `  ${C.bYellow}\u26a0 Warnings:${C.reset}`,
      ...warnings.map((msg) => `    ${C.yellow}\u2022 ${msg}${C.reset}`),
      "",
    ] : []),
    `  ${C.blue}Save to:${C.reset} ${C.dim}${filePath}${C.reset}`,
    "",
  ], w));

  setRawMode(false);
  const confirm = await prompt("Save? (y/n)", "y");
  if (confirm.toLowerCase() !== "y") return null;

  fs.writeFileSync(filePath, yaml.dump(JSON.parse(JSON.stringify(scenario)), { lineWidth: 120 }));
  logActivity(`Created scenario: ${title}`);
  return filePath;
}

async function experimentLab(rl: readline.Interface, projectRoot: string): Promise<void> {
  const w = W();
  const draft = defaultDraft();
  const { loadScenario, loadCondition } = await import("../config/load");

  // --- Load scenarios ---
  const scenarioDir = path.resolve(projectRoot, "scenarios");
  const scenarioFiles = fs.existsSync(scenarioDir)
    ? fs.readdirSync(scenarioDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    : [];

  const scenarioChoices = scenarioFiles.map((f) => {
    const scenarioPath = path.join(scenarioDir, f);
    try {
      const s = loadScenario(scenarioPath);
      const focusClaim = s.claims.find((c) => c.id === s.focusClaimId);
      return {
        label: s.title, path: scenarioPath, id: s.id,
        domain: (s as Record<string, unknown>).domain as string | undefined,
        sources: ((s as Record<string, unknown>).sources ?? []) as { label: string; url?: string }[],
        focusClaimText: focusClaim?.text ?? "--",
        falseCount: s.claims.filter((c) => c.truthLabel === "false").length,
        mixedCount: s.claims.filter((c) => c.truthLabel === "mixed").length,
        trueCount: s.claims.filter((c) => c.truthLabel === "true").length,
        claimDetails: s.claims.map((c) => ({ text: c.text, truth: c.truthLabel })),
        evidenceTexts: s.evidence.map((e) => e.text),
        correctionStep: s.scheduledInterventions[0]?.step,
        correctionText: s.scheduledInterventions[0]?.text,
    seedCount: s.initialMemoryEntries.length,
      };
    } catch {
      return {
        label: f, path: scenarioPath, id: f,
        domain: undefined as string | undefined,
        sources: [] as { label: string; url?: string }[],
        focusClaimText: "--",
        falseCount: 0, mixedCount: 0, trueCount: 0,
        claimDetails: [] as { text: string; truth: string }[], evidenceTexts: [] as string[],
        correctionStep: undefined as number | undefined, correctionText: undefined as string | undefined, seedCount: 0,
      };
    }
  });

  // --- Load conditions ---
  const conditionDir = path.resolve(projectRoot, "conditions");
  const conditionFiles = fs.existsSync(conditionDir)
    ? fs.readdirSync(conditionDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    : [];

  const conditionChoices = conditionFiles.map((f) => {
    const condPath = path.join(conditionDir, f);
    try {
      const c = loadCondition(condPath);
      return { label: c.title, path: condPath, id: c.id, mode: c.memory.mode, decay: c.memory.decay.enabled, decayHalfLife: c.memory.decay.halfLife };
    } catch {
      return { label: f, path: condPath, id: f, mode: "unknown" as const, decay: false, decayHalfLife: 6 };
    }
  });

  // ─── Step 1: Choose scenario ───
  const CREATE_NEW_IDX = scenarioChoices.length;
  const totalScenarioItems = scenarioChoices.length + 1; // existing + "Create New"

  const scenarioIdx = await selectFromList(
    (sel) => {
      const isCreateNew = sel === CREATE_NEW_IDX;
      const sc = isCreateNew ? null : (scenarioChoices[sel] ?? scenarioChoices[0]);
      const lines = [
        ...bannerCompact("Lab \u2502 Choose Scenario"),
        "",
        ...labSection("Scenarios", "\u2697", w),
        "",
        ...scenarioChoices.flatMap((s, i) => {
          const selected = i === sel;
          const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : ` `;
          const title = selected ? `${C.bCyan}${C.bold}${s.label}${C.reset}` : `${C.cyan}${s.label}${C.reset}`;
          const truth = `${C.bRed}${s.falseCount}F${C.reset} ${C.yellow}${s.mixedCount}M${C.reset} ${C.bGreen}${s.trueCount}T${C.reset}`;
          const corr = s.correctionStep ? `${C.dim}corr@${s.correctionStep}${C.reset}` : "";
          return [`  ${marker} ${title}  ${truth} ${C.dim}${s.evidenceTexts.length}ev${C.reset} ${corr}`];
        }),
        `  ${sel === CREATE_NEW_IDX ? `${C.bCyan}\u25b8${C.reset}` : ` `} ${sel === CREATE_NEW_IDX ? `${C.bMagenta}${C.bold}+ Create New Scenario${C.reset}` : `${C.magenta}+ Create New Scenario${C.reset}`}`,
        "",
        ...(isCreateNew ? [
          ...labSection("New scenario", "\u25a3", w),
          "",
          `  ${C.bMagenta}Build a custom scenario with your own claims,${C.reset}`,
          `  ${C.bMagenta}evidence, corrections, and seed memories.${C.reset}`,
          "",
          `  ${C.dim}You'll be guided through each part:${C.reset}`,
          `    ${C.cyan}1.${C.reset} ${C.dim}Name & focus claim${C.reset}`,
          `    ${C.cyan}2.${C.reset} ${C.dim}Add claims (true/false/mixed)${C.reset}`,
          `    ${C.cyan}3.${C.reset} ${C.dim}Add evidence & effects${C.reset}`,
          `    ${C.cyan}4.${C.reset} ${C.dim}Schedule corrections${C.reset}`,
          `    ${C.cyan}5.${C.reset} ${C.dim}Seed memory entries${C.reset}`,
        ] : sc ? [
          ...labSection("Selected detail", "\u25a3", w),
          "",
          `  ${C.blue}Focus claim:${C.reset}`,
          `    ${C.bRed}\u25cf${C.reset} ${C.bCyan}${sc.focusClaimText}${C.reset}`,
          "",
          `  ${C.blue}All claims:${C.reset}`,
          ...sc.claimDetails.map((c) => {
            const color = c.truth === "false" ? C.bRed : c.truth === "mixed" ? C.yellow : C.bGreen;
            return `    ${color}\u25cf [${c.truth}]${C.reset} ${C.dim}${c.text}${C.reset}`;
          }),
          "",
          `  ${C.blue}Evidence (${sc.evidenceTexts.length}):${C.reset}`,
          ...sc.evidenceTexts.map((e) => truncV(`    ${C.dim}\u2022 ${e}${C.reset}`, w - 4)),
          "",
          ...(sc.correctionStep ? [
            `  ${C.bRed}\u26a1 Correction at round ${sc.correctionStep}:${C.reset}`,
            `    ${C.dim}${sc.correctionText}${C.reset}`,
          ] : []),
          ...(sc.seedCount > 0 ? [`  ${C.blue}Seed memory:${C.reset} ${C.dim}${sc.seedCount} pre-loaded entries${C.reset}`] : []),
          ...(sc.domain ? [``, `  ${C.blue}Domain:${C.reset} ${C.cyan}${sc.domain}${C.reset}`] : []),
          ...(sc.sources.length > 0 ? [
            `  ${C.blue}Sources:${C.reset}`,
            ...sc.sources.map((src) => truncV(`    ${C.dim}\u2022 ${src.label}${src.url ? ` ${C.cyan}${src.url}${C.reset}` : ""}${C.reset}`, w - 4)),
          ] : []),
        ] : []),
        "",
        keyHints(["\u2191\u2193 navigate", "\u23ce select", "q cancel"], w),
      ];
      return frame(lines, w);
    },
    totalScenarioItems,
  );

  if (scenarioIdx === null) return;

  // ─── Create New Scenario flow ───
  if (scenarioIdx === CREATE_NEW_IDX) {
    const newScenarioPath = await createScenarioWizard(rl, projectRoot);
    if (!newScenarioPath) return;
    draft.scenarioTemplate = newScenarioPath;
    const s = loadScenario(newScenarioPath);
    draft.name = `custom_${s.id}`;
  } else {
    if (scenarioChoices.length === 0) return;
    draft.scenarioTemplate = scenarioChoices[scenarioIdx].path;
    draft.name = `custom_${scenarioChoices[scenarioIdx].id}`;
  }

  // Derive scenario label for display
  let scenLabel = "Custom scenario";
  if (scenarioIdx !== CREATE_NEW_IDX && scenarioChoices[scenarioIdx]) {
    scenLabel = scenarioChoices[scenarioIdx].label;
  } else {
    try { scenLabel = loadScenario(draft.scenarioTemplate).title; } catch { /* keep default */ }
  }

  // ─── Step 2: Research question ───
  const RESEARCH_QUESTIONS = [
    { key: "memory_mode", label: "Memory mode", desc: "Does shared memory amplify false-claim propagation?", conditionIds: ["personal_memory", "shared_memory"] },
    { key: "decay", label: "Decay effect", desc: "Does memory decay reduce false-claim lock-in?", conditionIds: ["shared_memory", "shared_memory_decay"] },
    { key: "verification", label: "Verification", desc: "Does verification prevent false-claim adoption?", conditionIds: ["shared_memory", "shared_memory_verification", "shared_memory_noisy_verification"] },
    { key: "timing", label: "Correction timing", desc: "Does early correction reduce entrenchment?", conditionIds: ["shared_memory", "shared_memory_early_correction", "shared_memory_late_correction"] },
    { key: "strength", label: "Correction strength", desc: "How does correction strength affect recovery?", conditionIds: ["shared_memory", "shared_memory_weak_correction", "shared_memory_repeated_correction", "shared_memory_high_authority"] },
    { key: "full", label: "Full matrix", desc: "Run all conditions for complete comparison", conditionIds: [] as string[] },
    { key: "custom", label: "Custom", desc: "Select conditions manually", conditionIds: [] as string[] },
  ];

  const questionIdx = await selectFromList(
    (sel) => {
      const lines = [
        ...bannerCompact("Lab \u2502 Research Question"),
        "",
        ...RESEARCH_QUESTIONS.map((rq, i) => {
          const selected = i === sel;
          const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : ` `;
          const label = selected ? `${C.bCyan}${C.bold}${rq.label}${C.reset}` : `${C.cyan}${rq.label}${C.reset}`;
          const desc = selected ? `${C.cyan}${rq.desc}${C.reset}` : `${C.dim}${rq.desc}${C.reset}`;
          return `  ${marker} ${label}  ${desc}`;
        }),
        "",
        keyHints(["\u2191\u2193 navigate", "\u23ce select", "q cancel"], w),
      ];
      return frame(lines, w);
    },
    RESEARCH_QUESTIONS.length,
  );

  if (questionIdx === null) return;
  const question = RESEARCH_QUESTIONS[questionIdx];
  draft.researchQuestion = question.desc;
  draft.name = `exp_${question.key}_${scenarioIdx !== CREATE_NEW_IDX && scenarioChoices[scenarioIdx] ? scenarioChoices[scenarioIdx].id : "custom"}`;

  // ─── Step 3: Select conditions (multi-select) ───
  const initialChecked = conditionChoices.map((c) =>
    question.conditionIds.length === 0 || question.conditionIds.includes(c.id),
  );

  const checkedResult = await selectMultiple(
    (cursor, checked) => {
      const selectedCount = checked.filter(Boolean).length;
      const lines = [
        ...bannerCompact("Lab \u2502 Select Conditions"),
        "",
        `  ${C.bCyan}${selectedCount}${C.reset} ${C.dim}selected${C.reset}${selectedCount < 2 ? `  ${C.yellow}(min 2)${C.reset}` : ""}`,
        "",
        ...conditionChoices.map((cc, i) => {
          const isCursor = i === cursor;
          const isChecked = checked[i];
          const marker = isCursor ? `${C.bCyan}\u25b8${C.reset}` : ` `;
          const box = isChecked ? `${C.bGreen}[\u2713]${C.reset}` : `${C.dim}[ ]${C.reset}`;
          const label = isCursor
            ? `${C.bCyan}${C.bold}${cc.label}${C.reset}`
            : isChecked ? `${C.cyan}${cc.label}${C.reset}` : `${C.dim}${cc.label}${C.reset}`;
          return `  ${marker} ${box} ${label}`;
        }),
        "",
        keyHints(["\u2191\u2193 move", "space toggle", "a all", "\u23ce confirm", "q back"], w),
      ];
      return frame(lines, w);
    },
    conditionChoices.length,
    initialChecked,
  );

  if (!checkedResult) return;

  draft.selectedConditions = conditionChoices
    .filter((_, i) => checkedResult[i])
    .map((c) => ({ path: c.path, label: c.label, id: c.id, mode: c.mode, decay: c.decay, decayHalfLife: c.decayHalfLife }));

  if (draft.selectedConditions.length < 2) {
    draw(frame([
      ...bannerCompact("Lab"),
      "",
      `  ${C.bRed}\u2717${C.reset} ${C.dim}Need at least 2 conditions for a comparison experiment.${C.reset}`,
      "",
    ], w));
    await pause(rl);
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // HUB — experiment design overview
  // ═══════════════════════════════════════════════════════════════

  const ROLES = [
    { key: "contamination_agent", label: "Contaminator", icon: `${C.red}\u2666${C.reset}`, desc: "high bias, ignores corrections" },
    { key: "specialist_agent", label: "Expert", icon: `${C.bCyan}\u25c6${C.reset}`, desc: "trusts evidence, low bias" },
    { key: "regular_agent", label: "Regular", icon: `${C.white}\u25cb${C.reset}`, desc: "socially influenced, moderate" },
  ];
  const MODELS = ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-6", "gpt-4o-mini", "gpt-4o"];

  const rIcon = (r: string) => r === "contamination_agent" ? `${C.red}\u2666${C.reset}` : r === "specialist_agent" ? `${C.bCyan}\u25c6${C.reset}` : `${C.white}\u25cb${C.reset}`;
  const rName = (r: string) => r === "contamination_agent" ? "contam" : r === "specialist_agent" ? "expert" : "regular";

  type HubAction = "agents" | "run_params" | "run";
  const HUB_ITEMS: { label: string; icon: string; action: HubAction }[] = [
    { label: "Agent Workbench", icon: "\u25c6", action: "agents" },
    { label: "Run Parameters", icon: "\u2302", action: "run_params" },
    { label: "Run Experiment", icon: "\u26a1", action: "run" },
  ];

  let hubDone = false;
  while (!hubDone) {
    const hubIdx = await selectFromList(
      (sel) => {
        const agentSummary = draft.agents.map((a) => {
          const model = `${C.bMagenta}${a.model.replace("claude-", "").replace("-20251001", "").slice(0, 8)}${C.reset}`;
          return `${rIcon(a.role)}${C.cyan}${a.id}${C.reset}${model}`;
        }).join("  ");

        const runsTotal = draft.selectedConditions.length;
        const condList = draft.selectedConditions.map((c) => `${C.cyan}${c.id}${C.reset}`).join(`${C.dim}, ${C.reset}`);
        const modelName = draft.agents[0]?.model ?? "none";

        const lines = [
          ...bannerCompact("Lab \u2502 Experiment Hub"),
          "",
          `  ${C.blue}Scenario:${C.reset}   ${C.bCyan}${scenLabel}${C.reset}`,
          `  ${C.blue}Question:${C.reset}   ${C.dim}${draft.researchQuestion}${C.reset}`,
          `  ${C.blue}Conditions:${C.reset} ${condList}`,
          `  ${C.blue}Agents:${C.reset}     ${agentSummary || `${C.dim}none${C.reset}`}`,
          `  ${C.blue}Run:${C.reset}        ${C.dim}seed:${C.reset}${C.bCyan}${draft.seed}${C.reset} ${C.dim}rounds:${C.reset}${C.bCyan}${draft.maxSteps}${C.reset} ${C.dim}cap:${C.reset}${C.bCyan}${draft.maxModelCalls}${C.reset}  ${C.dim}(${runsTotal} runs, ${C.bMagenta}${modelName}${C.reset}${C.dim})${C.reset}`,
          "",
          ...HUB_ITEMS.map((item, i) => {
            const selected = i === sel;
            const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : ` `;
            const label = selected ? `${C.bCyan}${C.bold}${item.icon} ${item.label}${C.reset}` : `${C.cyan}${item.icon} ${item.label}${C.reset}`;
            return `  ${marker} ${label}`;
          }),
          "",
          keyHints(["\u2191\u2193 navigate", "\u23ce open", "q cancel"], w),
        ];
        return frame(lines, w);
      },
      HUB_ITEMS.length,
    );

    if (hubIdx === null) return;
    const hubAction = HUB_ITEMS[hubIdx].action;

    // ─── Agent Workbench ─────────────────────────────────────
    if (hubAction === "agents") {
      let agentsDone = false;
      while (!agentsDone) {
        const actionItems: { type: "agent" | "add" | "done"; agentIdx?: number }[] = [];
        for (let i = 0; i < draft.agents.length; i++) actionItems.push({ type: "agent", agentIdx: i });
        actionItems.push({ type: "add" });
        actionItems.push({ type: "done" });

        const benchIdx = await selectFromList(
          (sel) => {
            const agentLines = draft.agents.flatMap((a, i) => {
              const selected = sel === i;
              const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : ` `;
              const nameStr = selected ? `${C.bCyan}${C.bold}${a.id}${C.reset}` : `${C.cyan}${a.id}${C.reset}`;
              const modelStr = `${C.bMagenta}${a.model}${C.reset}`;
              return [
                `  ${marker} ${rIcon(a.role)} ${nameStr} ${C.blue}\u2502${C.reset} ${C.dim}${rName(a.role)}${C.reset} ${C.blue}\u2502${C.reset} ${modelStr}`,
                `      ${C.dim}bias:${a.falseClaimBias.toFixed(2)} social:${a.socialWeight.toFixed(1)} corrTrust:${a.correctionTrust.toFixed(2)} ev:+${a.positiveEvidenceWeight.toFixed(1)}/-${a.negativeEvidenceWeight.toFixed(1)} mem:${a.writesMemoryThreshold.toFixed(2)}${C.reset}`,
                "",
              ];
            });
            const addSel = sel === draft.agents.length;
            const doneSel = sel === draft.agents.length + 1;
            const lines = [
              ...bannerCompact("Lab \u2502 Agent Workbench"),
              "",
              ...labSection(`${draft.agents.length} agents`, "\u25c6", w),
              "",
              ...agentLines,
              `  ${addSel ? `${C.bCyan}\u25b8${C.reset}` : ` `} ${addSel ? `${C.bGreen}${C.bold}+ Add agent${C.reset}` : `${C.green}+ Add agent${C.reset}`}`,
              "",
              `  ${doneSel ? `${C.bCyan}\u25b8${C.reset}` : ` `} ${doneSel ? `${C.bCyan}${C.bold}\u2190 Back to hub${C.reset}` : `${C.cyan}\u2190 Back to hub${C.reset}`}`,
              "",
              keyHints(["\u2191\u2193 navigate", "\u23ce select/edit", "q back"], w),
            ];
            return frame(lines, w);
          },
          actionItems.length,
        );

        if (benchIdx === null) { agentsDone = true; continue; }
        const action = actionItems[benchIdx];

        if (action.type === "done") {
          agentsDone = true;
        } else if (action.type === "add") {
          const roleIdx = await selectFromList(
            (sel) => {
              const lines = [
                ...bannerCompact("Lab \u2502 Add Agent"),
                "",
                ...labSection("Choose a role", "\u25c6", w),
                "",
                ...ROLES.flatMap((r, i) => {
                  const selected = i === sel;
                  const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : ` `;
                  const d = agentDefaults(r.key);
                  return [
                    `  ${marker} ${r.icon} ${selected ? `${C.bCyan}${C.bold}${r.label}${C.reset}` : `${C.cyan}${r.label}${C.reset}`}`,
                    `      ${selected ? C.cyan : C.dim}${r.desc}${C.reset}`,
                    `      ${C.dim}bias:${d.falseClaimBias.toFixed(2)} social:${d.socialWeight.toFixed(1)} corrTrust:${d.correctionTrust.toFixed(2)} ev:+${d.positiveEvidenceWeight.toFixed(1)}/-${d.negativeEvidenceWeight.toFixed(1)}${C.reset}`,
                    "",
                  ];
                }),
                keyHints(["\u2191\u2193 navigate", "\u23ce add", "q back"], w),
              ];
              return frame(lines, w);
            },
            ROLES.length,
          );
          if (roleIdx !== null) {
            const role = ROLES[roleIdx];
            const prefix = role.key === "contamination_agent" ? "contamination" : role.key === "specialist_agent" ? "specialist" : "regular";
            const count = draft.agents.filter((a) => a.role === role.key).length + 1;
            draft.agents.push(makeAgent(`${prefix}_${count}`, role.key));
          }
        } else if (action.type === "agent" && action.agentIdx !== undefined) {
          // Per-agent action menu
          const a = draft.agents[action.agentIdx];
          const AGENT_ACTIONS = ["Edit parameters", "Change model", "Rename", "Reset to defaults", "Delete"];

          const editIdx = await selectFromList(
            (sel) => {
              const lines = [
                ...bannerCompact(`Lab \u2502 ${a.id}`),
                "",
                `  ${rIcon(a.role)} ${C.bCyan}${C.bold}${a.id}${C.reset} ${C.dim}(${rName(a.role)})${C.reset}  ${C.bMagenta}${a.model}${C.reset}`,
                `  ${C.dim}bias:${a.falseClaimBias.toFixed(2)} social:${a.socialWeight.toFixed(1)} corrTrust:${a.correctionTrust.toFixed(2)} ev:+${a.positiveEvidenceWeight.toFixed(1)}/-${a.negativeEvidenceWeight.toFixed(1)} mem:${a.writesMemoryThreshold.toFixed(2)}${C.reset}`,
                "",
                ...AGENT_ACTIONS.map((item, i) => {
                  const selected = i === sel;
                  const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : ` `;
                  const color = item === "Delete" ? (selected ? `${C.bRed}${C.bold}` : C.red) : (selected ? `${C.bCyan}${C.bold}` : C.cyan);
                  return `  ${marker} ${color}${item}${C.reset}`;
                }),
                "",
                keyHints(["\u2191\u2193 navigate", "\u23ce select", "q back"], w),
              ];
              return frame(lines, w);
            },
            AGENT_ACTIONS.length,
          );

          if (editIdx === 0) {
            // Edit parameters — typed input
            draw(frame([
              ...bannerCompact(`Lab \u2502 Edit ${a.id}`),
              "",
              `  ${C.dim}Type a value or Enter to keep current.${C.reset}`,
              "",
            ], w));
            setRawMode(false);

            const promptFloat = async (label: string, current: number, min: number, max: number): Promise<number> => {
              const raw = (await askQuestion(rl, `  ${C.blue}${label}${C.reset} ${C.dim}[${current}]${C.reset}: `)).trim();
              if (!raw) return current;
              const v = parseFloat(raw);
              if (isNaN(v)) return current;
              return Math.max(min, Math.min(max, v));
            };

            a.falseClaimBias = await promptFloat("False claim bias (0-1)", a.falseClaimBias, 0, 1);
            a.socialWeight = await promptFloat("Social weight (0-3)", a.socialWeight, 0, 3);
            a.correctionTrust = await promptFloat("Correction trust (0-1)", a.correctionTrust, 0, 1);
            a.positiveEvidenceWeight = await promptFloat("+Evidence weight (0-3)", a.positiveEvidenceWeight, 0, 3);
            a.negativeEvidenceWeight = await promptFloat("-Evidence weight (0-3)", a.negativeEvidenceWeight, 0, 3);
            a.writesMemoryThreshold = await promptFloat("Memory threshold (0-1)", a.writesMemoryThreshold, 0, 1);
          } else if (editIdx === 1) {
            // Change model — typed input with hint
            draw(frame([
              ...bannerCompact(`Lab \u2502 Model for ${a.id}`),
              "",
              `  ${C.dim}Current: ${a.model}${C.reset}`,
              `  ${C.dim}Options: ${MODELS.join(", ")}${C.reset}`,
              `  ${C.dim}Or type any model name.${C.reset}`,
              "",
            ], w));
            setRawMode(false);
            const modelInput = (await askQuestion(rl, `  ${C.blue}Model${C.reset} ${C.dim}[${a.model}]${C.reset}: `)).trim();
            if (modelInput) a.model = modelInput;
          } else if (editIdx === 2) {
            // Rename
            draw(frame([...bannerCompact(`Lab \u2502 Rename ${a.id}`), "", `  ${C.dim}Current: ${a.id}${C.reset}`, ""], w));
            setRawMode(false);
            const newName = (await askQuestion(rl, `  ${C.blue}New name${C.reset}: `)).trim();
            if (newName && /^[a-zA-Z0-9_-]+$/.test(newName)) a.id = newName;
          } else if (editIdx === 3) {
            Object.assign(a, agentDefaults(a.role));
          } else if (editIdx === 4) {
            draft.agents.splice(action.agentIdx, 1);
          }
        }
      }
    }

    // ─── Run Parameters Editor (typed input) ──────────────────
    if (hubAction === "run_params") {
      draw(frame([
        ...bannerCompact("Lab \u2502 Run Parameters"),
        "",
        `  ${C.dim}Type a value or press Enter to keep current.${C.reset}`,
        "",
        `  ${C.blue}Seed:${C.reset}           ${C.bCyan}${draft.seed}${C.reset}`,
        `  ${C.blue}Round limit:${C.reset}    ${C.bCyan}${draft.maxSteps}${C.reset}`,
        `  ${C.blue}Model call cap:${C.reset} ${C.bCyan}${draft.maxModelCalls}${C.reset}`,
        "",
      ], w));
      setRawMode(false);
      const newSeed = await promptOptionalNumber(rl, "Seed", draft.seed, 0);
      if (newSeed !== undefined) draft.seed = newSeed;
      const newSteps = await promptOptionalNumber(rl, "Round limit", draft.maxSteps, 1);
      if (newSteps !== undefined) draft.maxSteps = newSteps;
      const newCap = await promptOptionalNumber(rl, "Model call cap", draft.maxModelCalls, 1);
      if (newCap !== undefined) draft.maxModelCalls = newCap;
    }

    // ─── Run Experiment ─────────────────────────────────────
    if (hubAction === "run") {
      if (draft.agents.length === 0) {
        draw(frame([
          ...bannerCompact("Lab"),
          "",
          `  ${C.bRed}\u2717${C.reset} ${C.dim}Need at least 1 agent. Go to Agent Workbench first.${C.reset}`,
          "",
        ], w));
        await pause(rl);
        continue;
      }

      // Generate and run one config per condition
      const runConfigDir = path.resolve(projectRoot, "run-configs");
      fs.mkdirSync(runConfigDir, { recursive: true });
      const experimentSummaries: { condId: string; condLabel: string; summary: RunSummary }[] = [];

      for (let ci = 0; ci < draft.selectedConditions.length; ci++) {
        const cond = draft.selectedConditions[ci];
        const configName = `${draft.name}_${cond.id}`;
        const scenarioRelPath = path.relative(runConfigDir, draft.scenarioTemplate);
        const conditionRelPath = path.relative(runConfigDir, cond.path);

        const runConfig = {
          id: configName,
          title: `Experiment: ${scenLabel} / ${cond.label}`,
          scenarioPath: scenarioRelPath,
          conditionPath: conditionRelPath,
          seed: draft.seed,
          maxSteps: draft.maxSteps,
          budget: { maxModelCalls: draft.maxModelCalls },
          agents: draft.agents.map((a) => ({
            id: a.id, role: a.role, model: a.model,
            positiveEvidenceWeight: a.positiveEvidenceWeight,
            negativeEvidenceWeight: a.negativeEvidenceWeight,
            socialWeight: a.socialWeight,
            falseClaimBias: a.falseClaimBias,
            correctionTrust: a.correctionTrust,
            writesMemoryThreshold: a.writesMemoryThreshold,
            activeFromStep: a.activeFromStep,
            activeUntilStep: a.activeUntilStep,
            canWriteMemory: a.canWriteMemory,
          })),
          outputDir: "../output",
        };

        const configPath = path.join(runConfigDir, `${configName}.yaml`);
        fs.writeFileSync(configPath, JSON.stringify(runConfig, null, 2) + "\n", "utf8");

        // Show progress
        draw(frame([
          ...bannerCompact("Lab \u2502 Running Experiment"),
          "",
          `  ${C.bCyan}Condition ${ci + 1}/${draft.selectedConditions.length}${C.reset}`,
          `  ${C.cyan}${cond.label}${C.reset} ${C.dim}(${cond.id})${C.reset}`,
          "",
          `  ${progressBar(ci, draft.selectedConditions.length, 30)}`,
          "",
          ...experimentSummaries.map((s) => `  ${C.bGreen}\u2713${C.reset} ${C.cyan}${s.condLabel}${C.reset} ${C.dim}endorse:${(s.summary.falseClaimEndorsementRate * 100).toFixed(0)}% peak:${(s.summary.peakFalseClaimEndorsementRate * 100).toFixed(0)}%${C.reset}`),
          "",
        ], w));

        const summary = await runFromConfigAsync(configPath, { projectRoot });
        experimentSummaries.push({ condId: cond.id, condLabel: cond.label, summary });
      }

      logActivity(`Experiment: ${draft.selectedConditions.length} conditions on ${scenLabel}`);

      // ─── Experiment Results ────────────────────────────────
      const EXP_METRICS: { key: string; label: string; fmt: (v: number | null) => string }[] = [
        { key: "falseClaimEndorsementRate", label: "Endorsement rate", fmt: (v) => v !== null ? `${(v as number * 100).toFixed(1)}%` : "n/a" },
        { key: "peakFalseClaimEndorsementRate", label: "Peak endorsement", fmt: (v) => v !== null ? `${(v as number * 100).toFixed(1)}%` : "n/a" },
        { key: "timeToMajorityAdoption", label: "Majority adoption", fmt: (v) => v !== null ? `round ${v}` : "never" },
        { key: "distanceFromGroundTruth", label: "Truth distance", fmt: (v) => v !== null ? (v as number).toFixed(3) : "n/a" },
        { key: "recoveryAfterCorrection", label: "Recovery", fmt: (v) => v !== null ? (v as number).toFixed(3) : "n/a" },
        { key: "diversityRetention", label: "Diversity", fmt: (v) => v !== null ? (v as number).toFixed(3) : "n/a" },
      ];

      const resultLines: string[] = [
        ...bannerCompact("Lab \u2502 Experiment Results"),
        "",
        ...labSection(`${draft.researchQuestion}`, "\u2697", w),
        `  ${C.dim}Scenario: ${scenLabel} \u2502 Seed: ${draft.seed} \u2502 Rounds: ${draft.maxSteps}${C.reset}`,
        "",
        ...labSection("Results by condition", "\u2261", w),
        "",
      ];

      // Build comparison table
      const labelW = 20;
      const colW = Math.max(14, ...experimentSummaries.map((s) => s.condId.length + 2));

      // Header
      resultLines.push(`  ${"Metric".padEnd(labelW)}  ${experimentSummaries.map((s) => `${C.bCyan}${s.condId.padEnd(colW)}${C.reset}`).join("  ")}`);
      resultLines.push(`  ${"\u2500".repeat(labelW)}  ${experimentSummaries.map(() => "\u2500".repeat(colW)).join("  ")}`);

      // Metric rows
      for (const metric of EXP_METRICS) {
        const label = metric.label.padEnd(labelW);
        const vals = experimentSummaries.map((s) => {
          const v = (s.summary as Record<string, unknown>)[metric.key];
          return metric.fmt(v as number | null).padEnd(colW);
        });
        resultLines.push(`  ${C.blue}${label}${C.reset}  ${vals.map((v) => `${C.cyan}${v}${C.reset}`).join("  ")}`);
      }
      resultLines.push("");

      // Deltas for 2-condition comparisons
      if (experimentSummaries.length === 2) {
        const [a, b] = experimentSummaries;
        resultLines.push(...labSection(`Deltas: ${b.condId} \u2212 ${a.condId}`, "\u0394", w));
        for (const metric of EXP_METRICS) {
          const va = (a.summary as Record<string, unknown>)[metric.key] as number | null;
          const vb = (b.summary as Record<string, unknown>)[metric.key] as number | null;
          if (typeof va === "number" && typeof vb === "number") {
            const delta = vb - va;
            const sign = delta > 0 ? "+" : "";
            const isWorse = (metric.key.includes("endorsement") || metric.key.includes("distance")) ? delta > 0 : delta < 0;
            const color = isWorse ? C.bRed : C.bGreen;
            resultLines.push(`  ${C.blue}${metric.label.padEnd(labelW)}${C.reset}  ${color}${sign}${delta.toFixed(3)}${C.reset}`);
          }
        }
        resultLines.push("");
      }

      // Key findings
      const rates = experimentSummaries.map((s) => ({ id: s.condId, rate: s.summary.falseClaimEndorsementRate }));
      const highest = rates.reduce((a, b) => a.rate > b.rate ? a : b);
      const lowest = rates.reduce((a, b) => a.rate < b.rate ? a : b);
      resultLines.push(...labSection("Key findings", "\u25b8", w));
      resultLines.push(`  ${C.bRed}Highest endorsement:${C.reset} ${C.cyan}${highest.id}${C.reset} ${C.dim}(${(highest.rate * 100).toFixed(1)}%)${C.reset}`);
      resultLines.push(`  ${C.bGreen}Lowest endorsement:${C.reset}  ${C.cyan}${lowest.id}${C.reset} ${C.dim}(${(lowest.rate * 100).toFixed(1)}%)${C.reset}`);
      if (highest.rate > lowest.rate) {
        const effect = ((highest.rate - lowest.rate) * 100).toFixed(1);
        resultLines.push(`  ${C.blue}Effect size:${C.reset} ${C.bCyan}${effect}pp${C.reset} ${C.dim}(percentage points)${C.reset}`);
      }
      resultLines.push("");

      // Saved configs
      resultLines.push(...labSection("Saved configs", "\u2714", w));
      for (const cond of draft.selectedConditions) {
        resultLines.push(`  ${C.dim}run-configs/${draft.name}_${cond.id}.yaml${C.reset}`);
      }
      resultLines.push("");

      draw(frame(resultLines, w, "heavy"));
      await pause(rl);
      hubDone = true;
    }
  }
}

// --- Action: Memory Manager ---

async function memoryManager(rl: readline.Interface, projectRoot: string): Promise<void> {
  const w = W();
  const summaries = listRecentRunSummaries(projectRoot).slice(0, 10);

  if (summaries.length === 0) {
    draw(frame([
      ...bannerCompact("Memory Manager"),
      "",
      `  ${C.dim}No runs found. Run something first.${C.reset}`,
      "",
    ], w));
    await pause(rl);
    return;
  }

  // Pick a run
  const runIdx = await selectFromList(
    (sel) => {
      const rightW = Math.max(34, Math.floor(w * 0.36));
      const menuLines = summaries.flatMap((s, i) => {
        const selected = i === sel;
        const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : ` `;
        const label = selected ? `${C.bCyan}${C.bold}${s.runId}${C.reset}` : `${C.cyan}${s.runId}${C.reset}`;
        return [
          `${marker} ${label}`,
          `    ${C.dim}${s.conditionId}  ${s.memoryMode}${C.reset}`,
          "",
        ];
      });

      const s = summaries[sel];
      const detailLines: string[] = s ? [
        `${C.bCyan}${s.conditionId}${C.reset}`,
        "",
        `${C.blue}mode${C.reset}        ${C.cyan}${s.memoryMode}${C.reset}`,
        `${C.blue}topology${C.reset}    ${C.cyan}${s.topology}${C.reset}`,
        `${C.blue}agents${C.reset}      ${C.bCyan}${s.agentCount}${C.reset}`,
        `${C.blue}rounds${C.reset}      ${C.bCyan}${s.completedSteps}${C.reset}/${C.dim}${s.maxSteps}${C.reset}`,
        "",
        `${C.blue}peak${C.reset}        ${C.bRed}${(s.peakFalseClaimEndorsementRate * 100).toFixed(0)}%${C.reset}`,
        `${C.blue}reject${C.reset}      ${C.bGreen}${(s.finalFalseClaimRejectRate * 100).toFixed(0)}%${C.reset}`,
        `${C.blue}consensus${C.reset}   ${C.bCyan}${s.trajectory.finalConsensusStrength.toFixed(2)}${C.reset}`,
        `${C.blue}stance${C.reset}      ${s.trajectory.finalMajorityStance === "endorse" ? `${C.bRed}endorse${C.reset}` : s.trajectory.finalMajorityStance === "reject" ? `${C.bGreen}reject${C.reset}` : `${C.dim}uncertain${C.reset}`}`,
      ] : [`${C.dim}No run selected.${C.reset}`];

      const detailPanel = frame(detailLines, rightW, "round", "\u25c6 details");
      while (menuLines.length < detailPanel.length) menuLines.push("");

      return frame([
        ...bannerCompact("Memory Manager \u2502 Select Run"),
        "",
        ...sideBySide(menuLines, detailPanel, 3),
        "",
        keyHints(["\u2191\u2193 navigate", "\u23ce select", "q back"], w),
      ], w);
    },
    summaries.length,
  );

  if (runIdx === null) return;

  const selectedSummary = summaries[runIdx];
  const inspection = inspectRun(selectedSummary.dbPath, projectRoot);
  const memEntries = inspection.recentMemoryEntries;

  // ── Memory Dashboard ──
  const visualPanelWidth = Math.max(42, Math.floor((w - 7) / 2));
  const sparkWidth = Math.max(12, w - 24);

  // Build adoption flow diagram lines
  const adoptionFlowLines = (() => {
    if (inspection.testimonyAdoptions.length === 0) {
      return [`  ${C.dim}No stance adoptions recorded.${C.reset}`];
    }
    return inspection.testimonyAdoptions.slice(0, 8).map((a) => {
      const arrow = a.previousStance !== a.stance
        ? `${C.bYellow}\u2192${C.reset}`
        : `${C.dim}\u2192${C.reset}`;
      const stIcon = a.stance === "endorse" ? `${C.bRed}\u25cf${C.reset}` : a.stance === "reject" ? `${C.bGreen}\u25cf${C.reset}` : `${C.dim}\u25cb${C.reset}`;
      const prevIcon = a.previousStance === "endorse" ? `${C.bRed}+${C.reset}` : a.previousStance === "reject" ? `${C.bGreen}-${C.reset}` : `${C.dim}.${C.reset}`;
      const confDelta = a.currentConfidence - a.previousConfidence;
      const confStr = confDelta >= 0 ? `${C.bCyan}+${confDelta.toFixed(2)}${C.reset}` : `${C.yellow}${confDelta.toFixed(2)}${C.reset}`;
      return truncV(
        `  ${C.blue}r${a.step}${C.reset} ${C.cyan}${a.sourceAgentId}${C.reset} ${arrow} ${C.bCyan}${a.agentId}${C.reset}  ${prevIcon}${arrow}${stIcon} ${confStr}`,
        w - 4,
      );
    });
  })();

  // Build lineage diagram lines
  const lineageLines = (() => {
    if (inspection.claimLineage.length === 0) {
      return [`  ${C.dim}No claim lineage recorded.${C.reset}`];
    }
    return inspection.claimLineage.slice(0, 6).map((l) => {
      const relIcon = l.relationType === "adoption" ? `${C.bCyan}\u2500\u25b8${C.reset}` : l.relationType === "challenge" ? `${C.bYellow}\u2500\u00d7${C.reset}` : `${C.dim}\u2500\u25e6${C.reset}`;
      return truncV(
        `  ${C.blue}r${l.step}${C.reset} ${C.cyan}${l.parentAgentId}${C.reset} ${relIcon} ${C.bCyan}${l.childAgentId}${C.reset}  ${C.dim}${l.relationType}${C.reset}`,
        w - 4,
      );
    });
  })();

  // ── Topology diagram ──
  const topology = selectedSummary.topology ?? "fully-connected";
  const topoAgents = (() => {
    const ids = new Set<string>();
    for (const e of memEntries) ids.add(e.agentId);
    for (const f of inspection.memoryFlow) ids.add(f.agentId);
    for (const s of inspection.finalFocusStates) ids.add(s.agentId);
    return Array.from(ids).sort();
  })();

  const topoLines = (() => {
    const n = topoAgents.length;
    if (n === 0) return [`  ${C.dim}No agents.${C.reset}`];

    // Short label with role color
    const lbl = (i: number) => {
      const id = topoAgents[i];
      const short = id.length > 8 ? id.slice(0, 6) + ".." : id;
      const color = id.startsWith("contamination") ? C.red
        : id.startsWith("specialist") ? C.bCyan : C.cyan;
      return `${color}${short}${C.reset}`;
    };
    const lblPlain = (i: number) => {
      const id = topoAgents[i];
      return id.length > 8 ? id.slice(0, 6) + ".." : id;
    };
    const link = `${C.blue}\u2500\u2500${C.reset}`;
    const lines: string[] = [];

    if (topology === "fully-connected") {
      //  ╭──────────────────────╮
      //  │  A ── B ── C ── D   │
      //  │  all ←→ all          │
      //  ╰──────────────────────╯
      const row = topoAgents.map((_, i) => lbl(i)).join(` ${link} `);
      const rowPlain = topoAgents.map((_, i) => lblPlain(i)).join(" ── ");
      const boxW = Math.max(rowPlain.length + 6, 20);
      lines.push(`    ${C.blue}\u256d${"─".repeat(boxW)}\u256e${C.reset}`);
      lines.push(`    ${C.blue}\u2502${C.reset}  ${row}  ${" ".repeat(Math.max(0, boxW - rowPlain.length - 4))}${C.blue}\u2502${C.reset}`);
      // Cross-links indicator
      const meshLine = `all ←→ all  ${n}n ${n * (n - 1) / 2}e`;
      lines.push(`    ${C.blue}\u2502${C.reset}  ${C.dim}${meshLine}${C.reset}${" ".repeat(Math.max(0, boxW - meshLine.length - 4))}  ${C.blue}\u2502${C.reset}`);
      lines.push(`    ${C.blue}\u2570${"─".repeat(boxW)}\u256f${C.reset}`);

    } else if (topology === "star") {
      //        spoke1
      //          │
      //  spoke2 ─ HUB ─ spoke3
      //          │
      //        spoke4
      const hubLabel = lbl(0);
      const hubPlain = lblPlain(0);
      const spokes = topoAgents.slice(1);
      const top = spokes.slice(0, Math.ceil(spokes.length / 3));
      const mid = spokes.slice(Math.ceil(spokes.length / 3), Math.ceil(spokes.length * 2 / 3));
      const bot = spokes.slice(Math.ceil(spokes.length * 2 / 3));
      const hubPad = " ".repeat(hubPlain.length + 6);

      // Top spokes
      for (const s of top) {
        const si = topoAgents.indexOf(s);
        lines.push(`    ${hubPad}${C.blue}\u2502${C.reset}`);
        lines.push(`    ${hubPad}${lbl(si)}`);
      }
      if (top.length > 0) lines.push(`    ${hubPad}${C.blue}\u2502${C.reset}`);

      // Middle row: left spokes ── HUB ── right spokes
      const leftStr = mid.map((s) => lbl(topoAgents.indexOf(s))).join(` ${link} `);
      const rightStr = bot.map((s) => lbl(topoAgents.indexOf(s))).join(` ${link} `);
      const midLine = (mid.length > 0 ? `${leftStr} ${link} ` : "    ")
        + `[${hubLabel}]`
        + (bot.length > 0 ? ` ${link} ${rightStr}` : "");
      lines.push(`    ${midLine}`);

      // Bottom spokes (if odd distribution)
      if (top.length > 0) lines.push(`    ${hubPad}${C.blue}\u2502${C.reset}`);
      lines.push(`    ${C.dim}hub: ${hubPlain}  (${spokes.length} spokes, ${spokes.length} links)${C.reset}`);

    } else if (topology === "chain") {
      //  A ── B ── C ── D ── E
      //  ●    ●    ●    ●    ●
      const chainStr = topoAgents.map((_, i) => lbl(i)).join(` ${link} `);
      lines.push(`    ${chainStr}`);
      lines.push(`    ${C.dim}linear  ${n}n ${n - 1}e  ends: ${lblPlain(0)}, ${lblPlain(n - 1)}${C.reset}`);

    } else if (topology === "ring") {
      //  ╭─ A ── B ── C ─╮
      //  ╰─ F ── E ── D ─╯
      const half = Math.ceil(n / 2);
      const topRow = topoAgents.slice(0, half);
      const botRow = topoAgents.slice(half).reverse();

      const topStr = topRow.map((_, i) => lbl(i)).join(` ${link} `);
      const topPlain = topRow.map((_, i) => lblPlain(i)).join(" ── ");
      const botStr = botRow.map((s) => lbl(topoAgents.indexOf(s))).join(` ${link} `);
      const botPlain = botRow.map((s) => lblPlain(topoAgents.indexOf(s))).join(" ── ");

      const innerW = Math.max(topPlain.length, botPlain.length);
      const topPad = " ".repeat(Math.max(0, innerW - topPlain.length));
      const botPad = " ".repeat(Math.max(0, innerW - botPlain.length));

      lines.push(`    ${C.blue}\u256d\u2500${C.reset} ${topStr}${topPad} ${C.blue}\u2500\u256e${C.reset}`);
      lines.push(`    ${C.blue}\u2502${C.reset}${" ".repeat(innerW + 2)}${C.blue}\u2502${C.reset}`);
      if (botRow.length > 0) {
        lines.push(`    ${C.blue}\u2570\u2500${C.reset} ${botStr}${botPad} ${C.blue}\u2500\u256f${C.reset}`);
      } else {
        lines.push(`    ${C.blue}\u2570${"─".repeat(innerW + 2)}\u256f${C.reset}`);
      }
      lines.push(`    ${C.dim}closed ring  ${n}n ${n}e${C.reset}`);
    }

    return lines;
  })();

  // ── Per-agent memory banks ──
  const agentBankLines = (() => {
    // Group memory entries by agent
    const byAgent = new Map<string, typeof memEntries>();
    for (const entry of memEntries) {
      const list = byAgent.get(entry.agentId) ?? [];
      list.push(entry);
      byAgent.set(entry.agentId, list);
    }
    // Merge in agents that have flow stats but no entries
    for (const flow of inspection.memoryFlow) {
      if (!byAgent.has(flow.agentId)) byAgent.set(flow.agentId, []);
    }
    // Merge in agents from final states
    for (const st of inspection.finalFocusStates) {
      if (!byAgent.has(st.agentId)) byAgent.set(st.agentId, []);
    }

    const agents = Array.from(byAgent.keys()).sort();
    if (agents.length === 0) return [`  ${C.dim}No agents recorded.${C.reset}`];

    const lines: string[] = [];
    const bankW = Math.max(40, w - 6);

    for (const agentId of agents) {
      const entries = byAgent.get(agentId) ?? [];
      const flow = inspection.memoryFlow.find((f) => f.agentId === agentId);
      const finalState = inspection.finalFocusStates.find((s) => s.agentId === agentId);
      const matrixRow = inspection.claimMatrix.find((r) => r.agentId === agentId);

      // Role icon from agent ID prefix
      const roleIcon = agentId.startsWith("contamination")
        ? `${C.red}\u2666${C.reset}`
        : agentId.startsWith("specialist")
          ? `${C.bCyan}\u25c6${C.reset}`
          : `${C.white}\u25cb${C.reset}`;
      const roleLabel = agentId.startsWith("contamination")
        ? `${C.red}contam${C.reset}`
        : agentId.startsWith("specialist")
          ? `${C.bCyan}expert${C.reset}`
          : `${C.cyan}agent${C.reset}`;

      // Final stance
      const stIcon = finalState
        ? (finalState.stance === "endorse" ? `${C.bRed}\u25cf endorse${C.reset}` : finalState.stance === "reject" ? `${C.bGreen}\u25cf reject${C.reset}` : `${C.dim}\u25cb uncertain${C.reset}`)
        : `${C.dim}\u25cb ?${C.reset}`;
      const confStr = finalState ? `${C.bCyan}${finalState.confidence.toFixed(2)}${C.reset}` : `${C.dim}--${C.reset}`;

      // Trajectory glyphs from claim matrix
      const trajectory = matrixRow
        ? matrixRow.states.map((s) =>
          s.stance === "endorse" ? `${C.bRed}+${C.reset}` : s.stance === "reject" ? `${C.bGreen}-${C.reset}` : `${C.dim}.${C.reset}`,
        ).join("")
        : `${C.dim}--${C.reset}`;

      // Stats
      const wCount = flow?.writes ?? 0;
      const rCount = flow?.retrievals ?? 0;

      // Agent header line
      lines.push(`  ${roleIcon} ${C.bCyan}${C.bold}${agentId}${C.reset}  ${roleLabel}  ${stIcon}  ${C.blue}conf${C.reset} ${confStr}`);
      // Trajectory
      lines.push(`    ${C.blue}trajectory${C.reset} ${trajectory}  ${C.blue}W${C.reset}${C.dim}:${wCount}${C.reset} ${C.blue}R${C.reset}${C.dim}:${rCount}${C.reset}`);

      // Memory entries for this agent (most recent first, max 3)
      const agentEntries = entries.slice(-3);
      if (agentEntries.length > 0) {
        for (const e of agentEntries) {
          const src = e.sourceType === "seed"
            ? `${C.yellow}seed${C.reset}`
            : e.sourceType === "evidence"
              ? `${C.bGreen}evidence${C.reset}`
              : `${C.dim}r${e.step}${C.reset}`;
          const eStance = e.stance === "endorse" ? `${C.bRed}+${C.reset}` : e.stance === "reject" ? `${C.bGreen}-${C.reset}` : `${C.dim}.${C.reset}`;
          const preview = e.text.slice(0, Math.max(20, bankW - 30));
          lines.push(truncV(`    ${C.blue}\u2502${C.reset} ${src} ${eStance} ${C.dim}${preview}${C.reset}`, bankW));
        }
        if (entries.length > 3) {
          lines.push(`    ${C.blue}\u2502${C.reset} ${C.dim}... +${entries.length - 3} more${C.reset}`);
        }
      } else {
        lines.push(`    ${C.blue}\u2502${C.reset} ${C.dim}(no entries)${C.reset}`);
      }
      lines.push("");
    }
    return lines;
  })();

  // Memory map + claim matrix side by side
  const mapPanel = memoryMapPanel(inspection.memoryFlow, selectedSummary.memoryMode, visualPanelWidth);
  const matrixPanel = claimMatrixPanel(inspection.claimMatrix, inspection.interventions.map((item) => item.step), visualPanelWidth);
  const visualRows = w >= 108
    ? sideBySide(mapPanel, matrixPanel, 3)
    : [...mapPanel, "", ...matrixPanel];

  // Dashboard view
  const dashLines = [
    ...bannerCompact(`Memory \u2502 ${selectedSummary.conditionId}`),
    "",
    `  ${C.blue}mode${C.reset} ${C.bCyan}${selectedSummary.memoryMode}${C.reset}  ${C.blue}topology${C.reset} ${C.bCyan}${topology}${C.reset}  ${C.blue}rounds${C.reset} ${C.bCyan}${selectedSummary.completedSteps}${C.reset}  ${C.blue}entries${C.reset} ${C.bCyan}${memEntries.length}${C.reset}`,
    `  ${C.blue}claim${C.reset} ${C.dim}${inspection.focusClaimId ?? "n/a"}${C.reset}`,
    "",
    `${C.bCyan}${C.bold}\u2261 topology${C.reset}  ${C.dim}who can talk to whom${C.reset}`,
    ...topoLines,
    "",
    `${C.bCyan}${C.bold}\u2261 agent memory banks${C.reset}  ${C.dim}each agent's stored beliefs + stance path${C.reset}`,
    ...agentBankLines,
    `${C.bCyan}${C.bold}\u2261 read/write activity${C.reset}  ${C.dim}bar: how much each agent wrote vs read${C.reset}`,
    ...visualRows,
    "",
    `${C.bCyan}${C.bold}\u2261 belief over time${C.reset}  ${C.dim}sparklines: group metrics each round${C.reset}`,
    `  ${C.blue}endorse${C.reset}   ${sparkline(inspection.metricTimeline.map((m) => m.falseClaimEndorsementRate), sparkWidth)}`,
    `  ${C.blue}consensus${C.reset} ${sparkline(inspection.metricTimeline.map((m) => m.consensusStrength), sparkWidth)}`,
    `  ${C.blue}distance${C.reset}  ${sparkline(inspection.metricTimeline.map((m) => m.distanceFromGroundTruth), sparkWidth)}`,
    "",
    `${C.bCyan}${C.bold}\u2261 influence${C.reset}  ${C.dim}who changed whose mind${C.reset}`,
    ...adoptionFlowLines,
    "",
    `${C.bCyan}${C.bold}\u2261 lineage${C.reset}  ${C.dim}how beliefs spread agent-to-agent${C.reset}`,
    ...lineageLines,
    "",
    statusBar([
      { label: "status", value: inspection.status },
      { label: "engine", value: inspection.engineMode },
      { label: "entries", value: `${memEntries.length}` },
    ], w),
  ];

  draw(frame(dashLines, w, "heavy"));

  if (memEntries.length === 0) {
    await pause(rl);
    return;
  }

  // Prompt to drill into entries
  const answer = (await promptText(rl, "Drill into entries? (y/n)", "n")).toLowerCase();
  if (answer !== "y" && answer !== "yes") return;

  const memIdx = await selectFromList(
    (sel) => {
      const lines = [
        ...bannerCompact(`Memory Entries \u2502 ${selectedSummary.conditionId}`),
        "",
        ...memEntries.flatMap((entry, i) =>
          memoryEntryRow(entry, i === sel, w - 4),
        ),
        "",
        keyHints(["\u2191\u2193 navigate", "\u23ce view detail", "q back"], w),
      ];
      return frame(lines, w);
    },
    memEntries.length,
  );

  if (memIdx === null) return;

  // Show detail of selected entry
  const entry = memEntries[memIdx];
  const stanceIcon = entry.stance === "endorse" ? `${C.bRed}\u25cf endorse${C.reset}` : entry.stance === "reject" ? `${C.bGreen}\u25cf reject${C.reset}` : `${C.dim}\u25cb uncertain${C.reset}`;

  draw(frame([
    ...bannerCompact(`Memory Entry Detail`),
    "",
    `  ${C.blue}Agent${C.reset}       ${C.bCyan}${entry.agentId}${C.reset}`,
    `  ${C.blue}Claim${C.reset}       ${C.bCyan}${entry.claimId}${C.reset}`,
    `  ${C.blue}Round${C.reset}       ${C.bCyan}${entry.step}${C.reset}`,
    `  ${C.blue}Stance${C.reset}      ${stanceIcon}`,
    `  ${C.blue}Confidence${C.reset}  ${C.bCyan}${entry.confidence.toFixed(2)}${C.reset}`,
    `  ${C.blue}Visibility${C.reset}  ${C.cyan}${entry.visibility}${C.reset}`,
    `  ${C.blue}Source${C.reset}      ${entry.sourceType === "seed" ? `${C.yellow}seed${C.reset}` : entry.sourceType === "evidence" ? `${C.bGreen}evidence${C.reset}` : `${C.cyan}agent${C.reset}`}`,
    "",
    `  ${C.dim}${"─".repeat(Math.min(60, w - 8))}${C.reset}`,
    "",
    `  ${C.dim}${entry.text}${C.reset}`,
    "",
    statusBar([
      { label: "run", value: selectedSummary.conditionId },
      { label: "entry", value: `${memIdx + 1}/${memEntries.length}` },
    ], w),
  ], w));
  await pause(rl);
}

// --- Main loop ---

const MENU_ACTIONS: { execute: (rl: readline.Interface, root: string) => Promise<void> }[] = [
  { execute: runSingleConfig },       // 0: Run
  { execute: experimentLab },         // 1: Lab
  { execute: memoryManager },         // 2: Memory
  { execute: runBatchConfig },         // 3: Batch
  { execute: compareTwoConfigs },      // 4: Compare
  { execute: showHistory },            // 5: History
  { execute: showArchive },            // 6: Archive
  { execute: showConfigs },            // 7: Configs
  { execute: setupProvider },          // 8: Provider
  { execute: showRunCommand },         // 9: Run command
  { execute: showExplanations },       // 10: Explain
];

const ACTION_LABELS = [
  "Run setup",
  "Build experiment",
  "Inspect memory",
  "Batch seeds",
  "Compare runs",
  "Run history",
  "Experiment archive",
  "Browse setups",
  "Provider setup",
  "Run command",
  "Explain",
];

export async function launchInteractiveCli(projectRoot = process.cwd()): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Seed activity log with system info
  const configCount = discoverRunConfigs(projectRoot).length;
  const runCount = listRecentRunSummaries(projectRoot).length;
  const archiveCount = listArchivedExperiments(projectRoot).records.length;
  logActivity("System initialized");
  logActivity(`${configCount} configs loaded`);
  if (runCount > 0) logActivity(`${runCount} previous runs found`);
  if (archiveCount > 0) logActivity(`${archiveCount} archived study records found`);
  const provider = getProviderStatusLine(projectRoot);
  if (provider !== "none") logActivity(`Provider: ${provider}`);

  try {
    while (true) {
      const menuItemCount = 12; // 11 actions + Exit
      const idx = await selectFromList(
        (sel) => mainMenuScreen(sel, projectRoot),
        menuItemCount,
      );

      if (idx === null || idx === 11) break;

      const action = MENU_ACTIONS[idx];
      if (action) {
        const label = ACTION_LABELS[idx] ?? "action";
        logActivity(`Opened ${label}`);
        await action.execute(rl, projectRoot);
        logActivity(`Returned from ${label}`);
      }
    }
  } finally {
    setRawMode(false);
    rl.close();
  }
}
