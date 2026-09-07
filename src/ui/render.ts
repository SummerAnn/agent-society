// Pure rendering utilities — no I/O, no side effects, just strings.
// Retro terminal aesthetic: blue/cyan-on-dark palette with ASCII art.

// --- ANSI Colors ---

export const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  // Functional stance colors (semantic only)
  red: "\x1b[31m",
  green: "\x1b[32m",
  bRed: "\x1b[91m",
  bGreen: "\x1b[92m",
  // Chrome — white/gray only
  white: "\x1b[37m",
  bWhite: "\x1b[97m",
  // Accents
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  bCyan: "\x1b[96m",
  bBlue: "\x1b[94m",
  bYellow: "\x1b[93m",
  bMagenta: "\x1b[95m",
  inverse: "\x1b[7m",
  // Backgrounds
  bgBlue: "\x1b[44m",
  bgCyan: "\x1b[46m",
  bgBlack: "\x1b[40m",
} as const;

// Semantic aliases
const FRAME = C.blue;
const ACCENT = C.cyan;
const MEMORY_WRITE = C.bCyan;

// --- String helpers ---

export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export function visLen(str: string): number {
  return stripAnsi(str).length;
}

export function padV(str: string, width: number): string {
  const diff = width - visLen(str);
  return diff > 0 ? str + " ".repeat(diff) : str;
}

export function truncV(str: string, width: number): string {
  const plain = stripAnsi(str);
  if (plain.length <= width) return padV(str, width);
  return plain.slice(0, Math.max(width - 1, 1)) + "\u2026" + C.reset;
}

export function centerV(str: string, width: number): string {
  const diff = width - visLen(str);
  if (diff <= 0) return str;
  const left = Math.floor(diff / 2);
  return " ".repeat(left) + str + " ".repeat(diff - left);
}

// --- Box drawing ---

const BOX = {
  double: { tl: "\u2554", tr: "\u2557", bl: "\u255a", br: "\u255d", h: "\u2550", v: "\u2551", lt: "\u2560", rt: "\u2563" },
  single: { tl: "\u250c", tr: "\u2510", bl: "\u2514", br: "\u2518", h: "\u2500", v: "\u2502", lt: "\u251c", rt: "\u2524" },
  heavy:  { tl: "\u250f", tr: "\u2513", bl: "\u2517", br: "\u251b", h: "\u2501", v: "\u2503", lt: "\u2523", rt: "\u252b" },
  round:  { tl: "\u256d", tr: "\u256e", bl: "\u2570", br: "\u256f", h: "\u2500", v: "\u2502", lt: "\u251c", rt: "\u2524" },
} as const;

type BoxStyle = keyof typeof BOX;

export function frame(lines: string[], width: number, style: BoxStyle = "double", title?: string): string[] {
  const b = BOX[style];
  const inner = width - 2;
  const result: string[] = [];

  if (title) {
    const t = ` ${title} `;
    const pad = 2;
    result.push(`${FRAME}${b.tl}${b.h.repeat(pad)}${C.reset}${ACCENT}${C.bold}${t}${C.reset}${FRAME}${b.h.repeat(Math.max(0, inner - pad - t.length))}${b.tr}${C.reset}`);
  } else {
    result.push(`${FRAME}${b.tl}${b.h.repeat(inner)}${b.tr}${C.reset}`);
  }

  for (const line of lines) {
    result.push(`${FRAME}${b.v}${C.reset}${padV(line, inner)}${FRAME}${b.v}${C.reset}`);
  }

  result.push(`${FRAME}${b.bl}${b.h.repeat(inner)}${b.br}${C.reset}`);
  return result;
}

export function divider(width: number, style: BoxStyle = "double"): string {
  const b = BOX[style];
  return `${FRAME}${b.lt}${b.h.repeat(width - 2)}${b.rt}${C.reset}`;
}

// --- ASCII Art ---

// Title — Calvin S font (box-drawing, 3 lines, always crisp)
function makeTitle(innerWidth: number): string[] {
  const lines = [
    `${C.bCyan}${C.bold}\u2554\u2550\u2557\u2554\u2550\u2557\u2554\u2550\u2557\u2554\u2557\u2554\u2554\u2566\u2557  \u2554\u2550\u2557\u2554\u2550\u2557\u2554\u2550\u2557\u2566\u2554\u2550\u2557\u2554\u2566\u2557\u2566 \u2566${C.reset}`,
    `${C.bCyan}${C.bold}\u2560\u2550\u2563\u2551 \u2566\u2551\u2563 \u2551\u2551\u2551 \u2551   \u255a\u2550\u2557\u2551 \u2551\u2551  \u2551\u2551\u2563  \u2551 \u255a\u2566\u255d${C.reset}`,
    `${C.blue}\u2569 \u2569\u255a\u2550\u255d\u255a\u2550\u255d\u255d\u255a\u255d \u2569   \u255a\u2550\u255d\u255a\u2550\u255d\u255a\u2550\u255d\u2569\u255a\u2550\u255d \u2569  \u2569${C.reset}`,
  ];
  return lines.map((line) => centerV(line, innerWidth));
}

// Snowy medieval town scene
function makeTownScene(innerWidth: number): string[] {
  const S = C.white;
  const B = C.dim;
  const A = C.cyan;
  const W = C.blue;
  const R = C.reset;
  const town = [
    `${S}  *        .           *        .    *           .        *     .      *${R}`,
    `${S}       .        *           .            *    .        .           *${R}`,
    `${B}                                  |>>>                                     ${R}`,
    `${B}                  _               |                  /\\                     ${R}`,
    `${B}   ___    ___    | |         _____|____         ____/  \\____          ___   ${R}`,
    `${B}  | ${S}o${B} |  |${S}o ${B}|   | |   ___  |  ${S}o  o  ${B}|   ___  |  ${S}o${B}    ${S}o${B}  |   ___  | ${S}o${B} |  ${R}`,
    `${B}  |   |  |  |   | |  | ${S}o${B} | |  ${S}o  o  ${B}|  | ${S}o${B} | |         |  | ${S}o${B} | |   |  ${R}`,
    `${B}  | ${S}o${B} |  |${S}o ${B}|   | |  |   | |  ${S}o  o  ${B}|  |   | |  ${S}o${B}    ${S}o${B}  |  |   | | ${S}o${B} |  ${R}`,
    `${B}__|___|__|__|___|_|__|___|_|_________|__|___|_|_________|__|___|_|___|__${R}`,
    `${B}  ${A}u${B}       ${A}u${B}    |||   ${A}u${B}        ${A}u${B}       ${A}u${B}        ${A}u${B}       ${A}u${B}      ${A}u${R}`,
    `${B}......${A} u ${B}........|||..........${A} u ${B}...........${A} u ${B}..........${A} u ${B}.......${R}`,
    `${B}__${A}u${B}_____${A}u${B}____${B}/   \\${B}____${A}u${B}______${A}u${B}___${A}u${B}_______${A}u${B}____${A}u${B}_______${A}u${B}____${A}u${B}__${R}`,
    `${W}~~~~~${B}|  ${A}u${B}  |${W}~~~~~${B}|  ${A}u${B}  |${W}~~~~~~~~~~~${B}|  ${A}u${B}  |${W}~~~~~${B}|  ${A}u${B}  |${W}~~~~~~~~${R}`,
    `${W}~~~~~${B}.:::::.${W}~~~~~${B}.:::::.${W}~~~~~~~~~~~${B}.:::::.${W}~~~~~${B}.:::::.${W}~~~~~~~~${R}`,
    `${W}~~~~${B}.:::::::.${W}~~~${B}.:::::::.${W}~~~~~~~${B}.:::::::.${W}~~~${B}.:::::::.${W}~~~~~~${R}`,
  ];
  return town.map((line) => centerV(line, innerWidth));
}

// --- Progress & bars ---

export function progressBar(current: number, total: number, width = 24): string {
  const ratio = Math.min(1, current / Math.max(1, total));
  const filled = Math.round(ratio * width);
  const bar = `${C.bCyan}${"\u2588".repeat(filled)}${C.reset}${C.blue}${"\u2591".repeat(width - filled)}${C.reset}`;
  const pct = `${ACCENT}${(ratio * 100).toFixed(0).padStart(3)}%${C.reset}`;
  return `${bar} ${pct}`;
}

export function confidenceBar(value: number, width = 10): string {
  const filled = Math.round(Math.min(1, Math.max(0, value)) * width);
  return `${C.cyan}${"\u2588".repeat(filled)}${C.reset}${C.blue}${"\u2591".repeat(width - filled)}${C.reset}`;
}

export function sparkline(values: number[], width = 20): string {
  if (values.length === 0) return `${C.blue}${"_".repeat(width)}${C.reset}`;
  const chars = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
  const max = Math.max(...values, 0.01);
  const sampled = values.length <= width
    ? values
    : Array.from({ length: width }, (_, i) => values[Math.floor(i * values.length / width)]);
  return sampled
    .map((v) => {
      const idx = Math.min(chars.length - 1, Math.floor((v / max) * (chars.length - 1)));
      return `${C.cyan}${chars[idx]}${C.reset}`;
    })
    .join("");
}

// --- Stance & role rendering ---

export function stanceLabel(stance: string): string {
  if (stance === "endorse") return `${C.bRed}\u25cf endorse${C.reset}`;
  if (stance === "reject") return `${C.bGreen}\u25cf reject${C.reset}`;
  return `${C.dim}\u25cb uncertain${C.reset}`;
}

export function stancePlain(stance: string): string {
  return stance.toUpperCase().padEnd(9);
}

export function roleSprite(role: string): string {
  if (role === "contamination_agent") return `${C.red}\u2666${C.reset}`;
  if (role === "specialist_agent") return `${C.bCyan}\u25c6${C.reset}`;
  return `${C.white}\u25cb${C.reset}`;
}

export function roleName(role: string): string {
  if (role === "contamination_agent") return `${C.red}contam${C.reset}`;
  if (role === "specialist_agent") return `${C.bCyan}expert${C.reset}`;
  return `${C.cyan}agent${C.reset}`;
}

function roleTag(role: string): string {
  if (role === "contamination_agent") return `${C.red}[CONTAM]${C.reset}`;
  if (role === "specialist_agent") return `${C.bCyan}[EXPERT]${C.reset}`;
  return `${C.cyan}[AGENT]${C.reset}`;
}

// --- Agent row in the society view ---

export function agentRow(
  name: string,
  role: string,
  stance: string,
  confidence: number,
  isActive: boolean,
  wroteMemory: boolean,
  innerWidth: number,
): string {
  const sprite = roleSprite(role);
  const nameStr = padV(isActive ? `${C.bCyan}${C.bold}${name}${C.reset}` : `${C.dim}${name}${C.reset}`, 20);
  const stanceStr = padV(stanceLabel(stance), 22);
  const bar = confidenceBar(confidence, 8);
  const conf = `${C.cyan}${confidence.toFixed(2)}${C.reset}`;
  const activeMarker = isActive ? `${C.bCyan}\u25c0${C.reset}` : " ";
  const memMarker = wroteMemory ? `${MEMORY_WRITE}\u270e${C.reset}` : " ";
  const row = `  ${sprite} ${nameStr} ${stanceStr} ${bar} ${conf} ${activeMarker}${memMarker}`;
  return truncV(row, innerWidth);
}

// --- Banner ---

export function banner(subtitle: string, width = 120): string[] {
  const inner = width - 2;
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
  const clock = `${C.dim}${timeStr}${C.reset}`;
  return [
    "",
    ...makeTitle(inner),
    centerV(clock, inner),
    ...makeTownScene(inner),
    "",
    `  ${C.blue}${"\u2501".repeat(inner - 4)}${C.reset}`,
    centerV(`${ACCENT}${subtitle}${C.reset}`, inner),
  ];
}

export function bannerCompact(subtitle: string): string[] {
  return [
    "",
    `  ${C.bCyan}${C.bold}AGENT SOCIETY${C.reset} ${C.blue}\u2503${C.reset} ${ACCENT}${subtitle}${C.reset}`,
    `  ${C.blue}${"\u2501".repeat(40)}${C.reset}`,
    "",
  ];
}

// --- Status bar (bottom of screen) ---

export function statusBar(items: { label: string; value: string }[], width: number): string {
  const inner = width - 2;
  const segments = items.map((i) => `${C.dim}${i.label}:${C.reset}${C.bCyan}${C.bold}${i.value}${C.reset}`);
  const joined = segments.join(`  ${C.blue}\u2502${C.reset}  `);
  return ` ${padV(joined, inner - 1)}`;
}

export function keyHints(hints: string[], width: number): string {
  const inner = width - 2;
  const text = hints.map((h) => `${C.dim}${h}${C.reset}`).join(`${C.blue}  \u2502  ${C.reset}`);
  return ` ${padV(text, inner - 1)}`;
}

// --- Grid menu rendering ---

export type MenuChoice = {
  key: string;
  label: string;
  description: string;
  icon?: string;
};

export type GridMenuOptions = {
  columns: number;
  cardWidth: number;
  gap: number;
};

export function menuGrid(
  options: MenuChoice[],
  selectedIndex: number,
  gridOpts: GridMenuOptions,
): string[] {
  const { columns, cardWidth, gap } = gridOpts;
  const result: string[] = [];
  const rows = Math.ceil(options.length / columns);
  const sel = BOX.heavy;
  const norm = BOX.single;

  for (let row = 0; row < rows; row++) {
    const topLine: string[] = [];
    const iconLine: string[] = [];
    const descLine: string[] = [];
    const botLine: string[] = [];

    for (let col = 0; col < columns; col++) {
      const idx = row * columns + col;
      const gapStr = col < columns - 1 ? " ".repeat(gap) : "";

      if (idx >= options.length) {
        topLine.push(" ".repeat(cardWidth) + gapStr);
        iconLine.push(" ".repeat(cardWidth) + gapStr);
        descLine.push(" ".repeat(cardWidth) + gapStr);
        botLine.push(" ".repeat(cardWidth) + gapStr);
        continue;
      }

      const opt = options[idx];
      const selected = idx === selectedIndex;
      const cw = cardWidth - 2;
      const icon = opt.icon ?? "";

      if (selected) {
        topLine.push(`${C.bCyan}${sel.tl}${sel.h.repeat(cw)}${sel.tr}${C.reset}${gapStr}`);
        iconLine.push(`${C.bCyan}${sel.v} ${icon} ${C.inverse} ${C.bCyan}${C.bold}${opt.label}${C.reset}${C.inverse}${" ".repeat(Math.max(0, cw - visLen(` ${stripAnsi(icon)} ${opt.label} `)))}${C.reset}${C.bCyan}${sel.v}${C.reset}${gapStr}`);
        descLine.push(`${C.bCyan}${sel.v}${C.reset}${padV(`   ${C.bCyan}${opt.description}${C.reset}`, cw)}${C.bCyan}${sel.v}${C.reset}${gapStr}`);
        botLine.push(`${C.bCyan}${sel.bl}${sel.h.repeat(cw)}${sel.br}${C.reset}${gapStr}`);
      } else {
        topLine.push(`${C.dim}${norm.tl}${norm.h.repeat(cw)}${norm.tr}${C.reset}${gapStr}`);
        iconLine.push(`${C.dim}${norm.v}${C.reset}${padV(` ${icon} ${C.blue}${opt.label}${C.reset}`, cw)}${C.dim}${norm.v}${C.reset}${gapStr}`);
        descLine.push(`${C.dim}${norm.v}${C.reset}${padV(`   ${C.dim}${opt.description}${C.reset}`, cw)}${C.dim}${norm.v}${C.reset}${gapStr}`);
        botLine.push(`${C.dim}${norm.bl}${norm.h.repeat(cw)}${norm.br}${C.reset}${gapStr}`);
      }
    }

    result.push(`  ${topLine.join("")}`);
    result.push(`  ${iconLine.join("")}`);
    result.push(`  ${descLine.join("")}`);
    result.push(`  ${botLine.join("")}`);
  }

  return result;
}

// --- Dashboard mini-panels ---

export function dashboardRow(panels: { icon: string; label: string; value: string }[], totalWidth: number): string[] {
  const count = panels.length;
  const gap = 1;
  const panelW = Math.floor((totalWidth - gap * (count - 1)) / count);
  const b = BOX.heavy;
  const topParts: string[] = [];
  const midParts: string[] = [];
  const botParts: string[] = [];

  for (let i = 0; i < count; i++) {
    const p = panels[i];
    const pw = i < count - 1 ? panelW : totalWidth - (panelW + gap) * (count - 1);
    const cw = pw - 2;
    const gapStr = i < count - 1 ? " ".repeat(gap) : "";
    topParts.push(`${C.blue}${b.tl}${b.h.repeat(cw)}${b.tr}${C.reset}${gapStr}`);
    midParts.push(`${C.blue}${b.v}${C.reset}${padV(` ${p.icon} ${C.bWhite}${p.label}${C.reset} ${C.bCyan}${C.bold}${p.value}${C.reset}`, cw)}${C.blue}${b.v}${C.reset}${gapStr}`);
    botParts.push(`${C.blue}${b.bl}${b.h.repeat(cw)}${b.br}${C.reset}${gapStr}`);
  }

  return [
    `  ${topParts.join("")}`,
    `  ${midParts.join("")}`,
    `  ${botParts.join("")}`,
  ];
}

// --- List menu (for sub-screens) ---

export function menuList(options: MenuChoice[], selectedIndex: number, innerWidth: number): string[] {
  return options.flatMap((option, index) => {
    const selected = index === selectedIndex;
    const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : ` `;
    const icon = option.icon ? `${option.icon} ` : "";
    const key = `${C.blue}${option.key}${C.reset}`;
    const label = selected
      ? `${C.bCyan}${C.bold}${option.label}${C.reset}`
      : `${C.cyan}${option.label}${C.reset}`;
    const desc = selected
      ? `${C.dim}${C.cyan}${option.description}${C.reset}`
      : `${C.dim}${option.description}${C.reset}`;
    const bg = selected ? `${C.blue}\u2502${C.reset}` : " ";
    return [
      `  ${marker} ${bg} ${icon}${key}  ${label}`,
      `    ${bg}      ${desc}`,
      "",
    ];
  });
}

// --- Correction event announcement ---

export function correctionAnnouncement(text: string, innerWidth: number): string[] {
  const pad2 = Math.max(0, innerWidth - 4);
  return [
    "",
    `  ${C.bRed}\u2588\u2588 CORRECTION ${"\u2550".repeat(Math.max(0, pad2 - 16))}${C.reset}`,
    `  ${C.bRed}\u25b6 ${text}${C.reset}`,
    "",
  ];
}

// --- Format helpers ---

export function fmtNum(value: number | null): string {
  if (value === null) return `${C.dim}n/a${C.reset}`;
  return `${C.bCyan}${Number.isInteger(value) ? `${value}` : value.toFixed(3)}${C.reset}`;
}

export function fmtPct(value: number): string {
  return `${C.bCyan}${(value * 100).toFixed(1)}%${C.reset}`;
}

// --- Metric panel ---

export function metricsPanel(
  endorsement: number,
  peakEndorsement: number | undefined,
  truthDist: number,
  diversity: number,
  width: number,
  consensus?: number,
  netEndorsement?: number,
): string[] {
  const lines = [
    ` ${C.blue}endorsement${C.reset}  ${fmtPct(endorsement)}`,
    ` ${C.blue}truth dist${C.reset}   ${fmtNum(truthDist)}`,
    ` ${C.blue}diversity${C.reset}    ${fmtNum(diversity)}`,
  ];
  if (peakEndorsement !== undefined) {
    lines.splice(1, 0, ` ${C.blue}peak${C.reset}         ${fmtPct(peakEndorsement)}`);
  }
  if (consensus !== undefined) {
    lines.push(` ${C.blue}consensus${C.reset}    ${fmtPct(consensus)}`);
  }
  if (netEndorsement !== undefined) {
    lines.push(` ${C.blue}net${C.reset}          ${fmtNum(netEndorsement)}`);
  }
  return frame(lines, width, "single", "\u2261 metrics");
}

// --- Memory pool panel ---

export function memoryPoolPanel(
  poolSize: number,
  memoryMode: string,
  lastWriter: string | null,
  retrieved: number,
  correctionInfo: string,
  width: number,
): string[] {
  const modeIcon = memoryMode === "shared" ? `${C.bCyan}\u2302${C.reset}` : `${C.cyan}\u2302${C.reset}`;
  const lines = [
    ` ${modeIcon} ${C.blue}${memoryMode} entries${C.reset}  ${C.bCyan}${poolSize}${C.reset}`,
    ` ${C.blue}last write${C.reset}   ${lastWriter ? `${C.bCyan}${lastWriter}${C.reset}` : `${C.dim}none${C.reset}`}`,
    ` ${C.blue}retrieved${C.reset}    ${C.bCyan}${retrieved}${C.reset}`,
    ` ${C.blue}correction${C.reset}   ${correctionInfo === "ACTIVE" ? `${C.bRed}\u25cf active${C.reset}` : `${C.dim}\u25cb ${correctionInfo}${C.reset}`}`,
  ];
  return frame(lines, width, "single", "\u2302 memory");
}

// --- Side by side panels ---

export function sideBySide(leftLines: string[], rightLines: string[], gap = 1): string[] {
  const maxLen = Math.max(leftLines.length, rightLines.length);
  const leftWidth = leftLines.reduce((max, l) => Math.max(max, visLen(l)), 0);
  const result: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const left = padV(leftLines[i] ?? "", leftWidth);
    const right = rightLines[i] ?? "";
    result.push(left + " ".repeat(gap) + right);
  }
  return result;
}

// --- Event log line ---

export function eventLogLine(
  agentId: string,
  role: string,
  stance: string,
  confidence: number,
  wroteMemory: boolean,
): string {
  const sprite = roleSprite(role);
  const tag = roleTag(role);
  const stanceColor = stance === "endorse" ? C.bRed : stance === "reject" ? C.bGreen : C.dim;
  const memIcon = wroteMemory ? ` ${MEMORY_WRITE}\u270e${C.reset}` : "";
  return `  ${C.blue}\u25b6${C.reset} ${sprite} ${tag} ${C.bCyan}${agentId}${C.reset} ${stanceColor}${stance}s${C.reset} ${C.dim}(${confidence.toFixed(2)})${C.reset}${memIcon}`;
}

// --- Summary rendering ---

export function summaryBlock(summary: {
  runId: string;
  conditionId: string;
  memoryMode: string;
  interactionMode?: string;
  topology?: string;
  scenarioId: string;
  agentCount?: number;
  claimCount?: number;
  correctionCount?: number;
  completedSteps: number;
  maxSteps: number;
  falseClaimEndorsementRate: number;
  finalFalseClaimRejectRate?: number;
  finalUncertainRate?: number;
  peakFalseClaimEndorsementRate: number;
  timeToMajorityAdoption: number | null;
  distanceFromGroundTruth: number;
  recoveryAfterCorrection: number;
  diversityRetention: number;
  trajectory?: {
    finalMajorityStance: string;
    finalConsensusStrength: number;
    peakConsensusStrength: number;
    lowestConsensusStrength: number;
    finalNetEndorsement: number;
    finalMeanConfidence: number;
  };
  physics?: {
    predictedRegime: string | null;
    actualRegime: string | null;
    regimeMatch: boolean | null;
    extendedModelImprovement: number | null;
    truthAsymmetryRatio: number | null;
    groupArchetype: string | null;
    criticalTemperature: number | null;
    correctionEffect: number | null;
    correctionSurprise: number | null;
  } | null;
  evaluation?: {
    focusClaimAccuracy: number | null;
    citationFidelity: number | null;
    citedMessageRate: number;
    sourceCoverage: number | null;
    earlyConsensusPeak: number;
    prematureConsensusRisk: number;
    prematureConsensusFlag: boolean;
  } | null;
  dbPath: string;
}): string[] {
  const setupBits = [summary.memoryMode, summary.interactionMode, summary.topology]
    .filter(Boolean)
    .join(" / ");
  const societyLine = summary.agentCount !== undefined
    ? `${summary.agentCount} agents${summary.claimCount !== undefined ? `, ${summary.claimCount} claims` : ""}${summary.correctionCount !== undefined ? `, ${summary.correctionCount} corrections` : ""}`
    : null;

  return [
    `${C.blue}run${C.reset}        ${C.bCyan}${summary.runId}${C.reset}`,
    `${C.blue}condition${C.reset}  ${C.cyan}${summary.conditionId}${C.reset}${setupBits ? ` ${C.dim}(${setupBits})${C.reset}` : ""}`,
    `${C.blue}scenario${C.reset}   ${C.cyan}${summary.scenarioId}${C.reset}`,
    ...(societyLine ? [`${C.blue}society${C.reset}    ${C.bCyan}${societyLine}${C.reset}`] : []),
    `${C.blue}rounds${C.reset}     ${C.bCyan}${summary.completedSteps}${C.reset}${C.dim}/${summary.maxSteps}${C.reset}`,
    "",
    `${C.bCyan}${C.bold}\u2261 outcomes${C.reset}`,
    `  ${C.blue}endorsement rate${C.reset}     ${fmtPct(summary.falseClaimEndorsementRate)}`,
    `  ${C.blue}reject rate${C.reset}          ${fmtPct(summary.finalFalseClaimRejectRate ?? 0)}`,
    `  ${C.blue}uncertain rate${C.reset}       ${fmtPct(summary.finalUncertainRate ?? 0)}`,
    `  ${C.blue}peak endorsement${C.reset}     ${fmtPct(summary.peakFalseClaimEndorsementRate)}`,
    `  ${C.blue}majority adoption${C.reset}    ${fmtNum(summary.timeToMajorityAdoption)}`,
    `  ${C.blue}truth distance${C.reset}       ${fmtNum(summary.distanceFromGroundTruth)}`,
    `  ${C.blue}recovery${C.reset}             ${fmtNum(summary.recoveryAfterCorrection)}`,
    `  ${C.blue}diversity${C.reset}            ${fmtNum(summary.diversityRetention)}`,
    ...(summary.trajectory
      ? [
        "",
        `${C.bCyan}${C.bold}\u2261 trajectory${C.reset}`,
        `  ${C.blue}final majority${C.reset}      ${C.bCyan}${summary.trajectory.finalMajorityStance}${C.reset}`,
        `  ${C.blue}consensus now${C.reset}       ${fmtPct(summary.trajectory.finalConsensusStrength)}`,
        `  ${C.blue}consensus peak${C.reset}      ${fmtPct(summary.trajectory.peakConsensusStrength)}`,
        `  ${C.blue}consensus low${C.reset}       ${fmtPct(summary.trajectory.lowestConsensusStrength)}`,
        `  ${C.blue}net endorsement${C.reset}     ${fmtNum(summary.trajectory.finalNetEndorsement)}`,
        `  ${C.blue}mean confidence${C.reset}     ${fmtNum(summary.trajectory.finalMeanConfidence)}`,
      ]
      : []),
    ...(summary.physics
      ? [
        "",
        `${C.bCyan}${C.bold}\u2261 physics${C.reset}`,
        `  ${C.blue}predicted regime${C.reset}    ${summary.physics.predictedRegime ? `${C.bCyan}${summary.physics.predictedRegime}${C.reset}` : `${C.dim}n/a${C.reset}`}`,
        `  ${C.blue}actual regime${C.reset}       ${summary.physics.actualRegime ? `${C.bCyan}${summary.physics.actualRegime}${C.reset}` : `${C.dim}n/a${C.reset}`}`,
        `  ${C.blue}regime match${C.reset}        ${summary.physics.regimeMatch === null ? `${C.dim}n/a${C.reset}` : summary.physics.regimeMatch ? `${C.bGreen}yes${C.reset}` : `${C.bRed}no${C.reset}`}`,
        `  ${C.blue}model gain${C.reset}          ${fmtNum(summary.physics.extendedModelImprovement)}`,
        `  ${C.blue}truth asymmetry${C.reset}     ${fmtNum(summary.physics.truthAsymmetryRatio)}`,
        `  ${C.blue}group type${C.reset}          ${summary.physics.groupArchetype ? `${C.bCyan}${summary.physics.groupArchetype}${C.reset}` : `${C.dim}n/a${C.reset}`}`,
        `  ${C.blue}critical temp${C.reset}       ${fmtNum(summary.physics.criticalTemperature)}`,
      ]
      : []),
    ...(summary.evaluation
      ? [
        "",
        `${C.bCyan}${C.bold}\u2261 discussion check${C.reset}`,
        `  ${C.blue}focus accuracy${C.reset}      ${summary.evaluation.focusClaimAccuracy === null ? `${C.dim}n/a${C.reset}` : fmtPct(summary.evaluation.focusClaimAccuracy)}`,
        `  ${C.blue}citation fidelity${C.reset}  ${summary.evaluation.citationFidelity === null ? `${C.dim}n/a${C.reset}` : fmtPct(summary.evaluation.citationFidelity)}`,
        `  ${C.blue}cited messages${C.reset}     ${fmtPct(summary.evaluation.citedMessageRate)}`,
        `  ${C.blue}source coverage${C.reset}    ${summary.evaluation.sourceCoverage === null ? `${C.dim}n/a${C.reset}` : fmtPct(summary.evaluation.sourceCoverage)}`,
        `  ${C.blue}early consensus${C.reset}    ${fmtPct(summary.evaluation.earlyConsensusPeak)}`,
        `  ${C.blue}premature risk${C.reset}     ${fmtNum(summary.evaluation.prematureConsensusRisk)}`,
        `  ${C.blue}premature flag${C.reset}     ${summary.evaluation.prematureConsensusFlag ? `${C.bRed}yes${C.reset}` : `${C.bGreen}no${C.reset}`}`,
      ]
      : []),
    "",
    `${C.dim}db: ${summary.dbPath}${C.reset}`,
  ];
}

// --- Comparison table ---

export function comparisonTable(
  labelA: string,
  labelB: string,
  rows: { metric: string; a: number | null; b: number | null; delta: number | null }[],
  width: number,
): string[] {
  const mw = 24;
  const vw = 12;
  const header = `${C.bold}${C.bCyan}${padV("metric", mw)}${padV(labelA, vw)}${padV(labelB, vw)}delta${C.reset}`;
  const sep = `${C.blue}${"\u2550".repeat(Math.min(width - 4, mw + vw * 2 + 8))}${C.reset}`;
  const dataRows = rows.map((r) => {
    const deltaStr = r.delta !== null ? (r.delta > 0 ? `${C.bRed}\u25b2+${fmtNum(r.delta)}${C.reset}` : r.delta < 0 ? `${C.bGreen}\u25bc${fmtNum(r.delta)}${C.reset}` : fmtNum(r.delta)) : `${C.dim}n/a${C.reset}`;
    return `${C.blue}${padV(r.metric, mw)}${C.reset}${padV(fmtNum(r.a), vw)}${padV(fmtNum(r.b), vw)}${deltaStr}`;
  });
  return [header, sep, ...dataRows];
}

// --- Config card ---

export type ConfigCard = {
  conditionId: string;
  memoryMode: string;
  agentCount: number;
  maxSteps: number;
  seed: number;
  scenarioTitle: string;
};

export function configCardList(configs: ConfigCard[], selectedIndex: number): string[] {
  return configs.flatMap((config, index) => {
    const selected = index === selectedIndex;
    const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : " ";
    const title = selected ? `${C.bCyan}${C.bold}${config.conditionId}${C.reset}` : `${C.cyan}${config.conditionId}${C.reset}`;
    const mode = config.memoryMode === "shared" ? `${C.bCyan}\u2302 shared${C.reset}` : `${C.cyan}\u2302 personal${C.reset}`;
    return [
      `  ${marker} ${title}  ${mode}`,
      `       ${C.blue}agents${C.reset}=${C.bCyan}${config.agentCount}${C.reset}  ${C.blue}rounds${C.reset}=${C.bCyan}${config.maxSteps}${C.reset}  ${C.blue}seed${C.reset}=${C.bCyan}${config.seed}${C.reset}`,
      `       ${C.dim}${config.scenarioTitle}${C.reset}`,
      "",
    ];
  });
}

// --- Recent runs table ---

export function recentRunsTable(summaries: { runId: string; conditionId: string; peakFalseClaimEndorsementRate: number; timeToMajorityAdoption: number | null }[]): string[] {
  if (summaries.length === 0) {
    return [`  ${C.dim}No previous runs found. Run an experiment first.${C.reset}`];
  }
  const header = `${C.bold}${C.bCyan}${padV("#", 4)}${padV("run id", 38)}${padV("condition", 16)}${padV("peak", 8)}majority${C.reset}`;
  const sep = `${C.blue}${"\u2550".repeat(74)}${C.reset}`;
  const rows = summaries.slice(0, 10).map((s, i) =>
    `${C.blue}${padV(`${i + 1}`, 4)}${C.reset}${padV(truncV(`${C.cyan}${s.runId}${C.reset}`, 36), 38)}${padV(`${C.dim}${s.conditionId}${C.reset}`, 16)}${padV(fmtPct(s.peakFalseClaimEndorsementRate), 8)}${fmtNum(s.timeToMajorityAdoption)}`,
  );
  return [header, sep, ...rows];
}

// --- Lab bench section header ---

export function labSection(title: string, icon: string, width: number): string[] {
  const inner = width - 4;
  const line = `${C.blue}${"\u2500".repeat(Math.max(0, inner - title.length - 4))}${C.reset}`;
  return [
    `  ${C.bCyan}${icon}${C.reset} ${C.bCyan}${C.bold}${title}${C.reset} ${line}`,
  ];
}

// --- Wizard step indicator ---

export function wizardSteps(steps: string[], currentStep: number, width: number): string[] {
  const parts = steps.map((s, i) => {
    if (i < currentStep) return `${C.bGreen}\u2713 ${s}${C.reset}`;
    if (i === currentStep) return `${C.bCyan}${C.bold}\u25b8 ${s}${C.reset}`;
    return `${C.dim}\u25cb ${s}${C.reset}`;
  });
  const joined = parts.join(`${C.blue} \u2500 ${C.reset}`);
  return [`  ${joined}`, `  ${C.blue}${"\u2500".repeat(Math.max(0, width - 4))}${C.reset}`];
}

// --- Inline selector (for wizard fields) ---

export function inlineOption(
  label: string,
  value: string,
  selected: boolean,
  width: number,
): string {
  const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : ` `;
  const labelStr = selected ? `${C.bCyan}${C.bold}${label}${C.reset}` : `${C.cyan}${label}${C.reset}`;
  const valueStr = selected ? `${C.bCyan}${value}${C.reset}` : `${C.dim}${value}${C.reset}`;
  return truncV(`  ${marker} ${labelStr}  ${valueStr}`, width);
}

// --- Memory entry row ---

export function memoryEntryRow(
  entry: { step: number; agentId: string; claimId: string; stance: string; confidence: number; text: string; sourceType: string },
  selected: boolean,
  width: number,
): string[] {
  const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : ` `;
  const stanceIcon = entry.stance === "endorse" ? `${C.bRed}\u25cf${C.reset}` : entry.stance === "reject" ? `${C.bGreen}\u25cf${C.reset}` : `${C.dim}\u25cb${C.reset}`;
  const titleColor = selected ? `${C.bCyan}${C.bold}` : C.cyan;
  const src = entry.sourceType === "seed"
    ? `${C.yellow}seed${C.reset}`
    : entry.sourceType === "evidence"
      ? `${C.bGreen}evidence${C.reset}`
      : `${C.dim}agent${C.reset}`;
  return [
    truncV(`  ${marker} ${stanceIcon} ${titleColor}${entry.agentId}${C.reset} ${C.blue}\u2502${C.reset} ${C.dim}round ${entry.step}${C.reset} ${C.blue}\u2502${C.reset} ${src} ${C.blue}\u2502${C.reset} ${C.dim}${entry.claimId}${C.reset}`, width),
    truncV(`      ${C.dim}${entry.text.slice(0, width - 10)}${C.reset}`, width),
    "",
  ];
}

function stanceGlyph(stance: string): string {
  if (stance === "endorse") return `${C.bRed}+${C.reset}`;
  if (stance === "reject") return `${C.bGreen}-${C.reset}`;
  return `${C.dim}.${C.reset}`;
}

export function memoryMapPanel(
  flows: {
    agentId: string;
    writes: number;
    retrievals: number;
    endorseWrites: number;
    rejectWrites: number;
    uncertainWrites: number;
    lastWriteStep: number | null;
  }[],
  memoryMode: string,
  width: number,
): string[] {
  if (flows.length === 0) {
    return frame([
      ` ${C.dim}No memory flow recorded for the focus claim.${C.reset}`,
    ], width, "single", "memory map");
  }

  const maxActivity = Math.max(
    1,
    ...flows.map((flow) => Math.max(flow.writes, flow.retrievals)),
  );
  const totalWrites = flows.reduce((sum, flow) => sum + flow.writes, 0);
  const totalRetrievals = flows.reduce((sum, flow) => sum + flow.retrievals, 0);
  const maxBar = Math.max(4, Math.min(8, width - 36));

  const lines: string[] = [
    ` ${C.cyan}${memoryMode}${C.reset} ${C.blue}pool${C.reset}  ${C.bCyan}${totalWrites}${C.reset} writes  ${C.bCyan}${totalRetrievals}${C.reset} retrievals`,
    "",
  ];

  for (const flow of flows.slice(0, 8)) {
    const writeBar = `${C.bCyan}${"█".repeat(Math.max(0, Math.round((flow.writes / maxActivity) * maxBar)))}${C.reset}${C.blue}${"░".repeat(Math.max(0, maxBar - Math.round((flow.writes / maxActivity) * maxBar)))}${C.reset}`;
    const readBar = `${C.cyan}${"█".repeat(Math.max(0, Math.round((flow.retrievals / maxActivity) * maxBar)))}${C.reset}${C.blue}${"░".repeat(Math.max(0, maxBar - Math.round((flow.retrievals / maxActivity) * maxBar)))}${C.reset}`;
    const agentLabel = truncV(`${C.cyan}${flow.agentId}${C.reset}`, 12);
    const tally = `${C.bRed}+${flow.endorseWrites}${C.reset} ${C.bGreen}-${flow.rejectWrites}${C.reset} ${C.dim}.${flow.uncertainWrites}${C.reset}`;
    lines.push(
      truncV(` ${agentLabel} ${C.blue}W${C.reset} ${writeBar} ${String(flow.writes).padStart(2, " ")} ${C.blue}→◎←${C.reset} ${String(flow.retrievals).padStart(2, " ")} ${readBar} ${C.blue}R${C.reset}`, width - 2),
    );
    lines.push(
      truncV(` ${" ".repeat(13)}${tally}  ${C.dim}last:${flow.lastWriteStep ?? "-"}${C.reset}`, width - 2),
    );
  }

  return frame(lines, width, "single", "memory map");
}

export function claimMatrixPanel(
  rows: {
    agentId: string;
    states: { step: number; stance: string; confidence: number }[];
  }[],
  interventionSteps: number[],
  width: number,
): string[] {
  if (rows.length === 0) {
    return frame([
      ` ${C.dim}No claim trajectory recorded for the focus claim.${C.reset}`,
    ], width, "single", "claim matrix");
  }

  const labelWidth = Math.min(
    14,
    Math.max(6, ...rows.map((row) => stripAnsi(row.agentId).length)),
  );
  const maxCols = Math.max(6, width - labelWidth - 5);
  const allSteps = rows[0]?.states.map((cell) => cell.step) ?? [];
  const sampledSteps = allSteps.length <= maxCols
    ? allSteps
    : Array.from({ length: maxCols }, (_, index) => {
      const mapped = Math.round((index / Math.max(1, maxCols - 1)) * (allSteps.length - 1));
      return allSteps[mapped];
    });

  const stepDigits = sampledSteps.map((step) => `${step % 10}`).join("");
  const correctionSet = new Set(interventionSteps);
  const corrLine = sampledSteps.map((step) => correctionSet.has(step) ? `${C.bYellow}!${C.reset}` : `${C.blue}·${C.reset}`).join("");

  const lines: string[] = [
    ` ${padV(`${C.blue}step${C.reset}`, labelWidth)} ${C.dim}${stepDigits}${C.reset}`,
    ` ${padV(`${C.blue}corr${C.reset}`, labelWidth)} ${corrLine}`,
  ];

  for (const row of rows.slice(0, 10)) {
    const stateMap = new Map<number, { stance: string; confidence: number }>(
      row.states.map((cell) => [cell.step, { stance: cell.stance, confidence: cell.confidence }]),
    );
    const glyphs = sampledSteps.map((step) => stanceGlyph(stateMap.get(step)?.stance ?? "uncertain")).join("");
    lines.push(` ${padV(truncV(`${C.cyan}${row.agentId}${C.reset}`, labelWidth), labelWidth)} ${glyphs}`);
  }

  lines.push("");
  lines.push(` ${C.bRed}+${C.reset} endorse  ${C.bGreen}-${C.reset} reject  ${C.dim}.${C.reset} uncertain  ${C.bYellow}!${C.reset} correction`);

  return frame(lines, width, "single", "claim matrix");
}

// --- Agent preset card ---

export function agentPresetCard(
  preset: { name: string; role: string; description: string },
  selected: boolean,
  width: number,
): string {
  const marker = selected ? `${C.bCyan}\u25b8${C.reset}` : ` `;
  const icon = preset.role === "contamination_agent" ? `${C.red}\u2666${C.reset}` : preset.role === "specialist_agent" ? `${C.bCyan}\u25c6${C.reset}` : `${C.white}\u25cb${C.reset}`;
  const nameStr = selected ? `${C.bCyan}${C.bold}${preset.name}${C.reset}` : `${C.cyan}${preset.name}${C.reset}`;
  const desc = selected ? `${C.cyan}${preset.description}${C.reset}` : `${C.dim}${preset.description}${C.reset}`;
  return truncV(`  ${marker} ${icon} ${nameStr} ${C.blue}\u2502${C.reset} ${desc}`, width);
}

// --- Batch result rendering ---

export function batchResultBlock(aggregated: {
  falseClaimEndorsementRate: { mean: number; std: number };
  peakFalseClaimEndorsementRate: { mean: number; std: number };
  timeToMajorityAdoption: { mean: number | null; count: number };
  distanceFromGroundTruth: { mean: number; std: number };
  recoveryAfterCorrection: { mean: number; std: number };
  diversityRetention: { mean: number; std: number };
}, seedCount: number): string[] {
  const f = (s: { mean: number; std: number }) => `${fmtNum(s.mean)} ${C.dim}\u00b1 ${fmtNum(s.std)}${C.reset}`;
  return [
    `${C.bCyan}${C.bold}\u2261 batch results${C.reset} ${C.dim}(${seedCount} seeds)${C.reset}`,
    "",
    `  ${C.blue}endorsement rate${C.reset}     ${f(aggregated.falseClaimEndorsementRate)}`,
    `  ${C.blue}peak endorsement${C.reset}     ${f(aggregated.peakFalseClaimEndorsementRate)}`,
    `  ${C.blue}majority adoption${C.reset}    ${aggregated.timeToMajorityAdoption.mean !== null ? `${fmtNum(aggregated.timeToMajorityAdoption.mean)} ${C.dim}(${aggregated.timeToMajorityAdoption.count}/${seedCount} runs)${C.reset}` : `${C.dim}never (0/${seedCount} runs)${C.reset}`}`,
    `  ${C.blue}truth distance${C.reset}       ${f(aggregated.distanceFromGroundTruth)}`,
    `  ${C.blue}recovery${C.reset}             ${f(aggregated.recoveryAfterCorrection)}`,
    `  ${C.blue}diversity${C.reset}            ${f(aggregated.diversityRetention)}`,
  ];
}

// --- Activity / chat panel ---

export function activityPanel(
  messages: { time: string; text: string }[],
  width: number,
  maxVisible = 10,
): string[] {
  const visible = messages.slice(-maxVisible);
  const lines: string[] = [];
  for (const m of visible) {
    lines.push(` ${C.dim}${m.time}${C.reset}  ${C.cyan}${m.text}${C.reset}`);
  }
  while (lines.length < maxVisible) {
    lines.push("");
  }
  return frame(lines, width, "single", "\u25c6 activity");
}

export function commandBar(input: string, width: number): string {
  const prompt = ` ${C.bCyan}\u25b8${C.reset} ${input}${C.dim}\u2588${C.reset}`;
  return padV(prompt, width - 2);
}
