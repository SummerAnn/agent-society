import fs from "fs";
import path from "path";

import { loadScenario } from "../config/load";
import { queryRows } from "../db/sqlite";
import type { GridResult } from "../experiments/grid";

type TaskPhaseResult = {
  runs: number;
  correctRate: number;
  finalResponsesValid: boolean;
  parserFallbackEntries: number;
  technicalPass: boolean;
};

type TaskModeEligibility = {
  approved: boolean;
  reasons: string[];
  phases: {
    noContext: TaskPhaseResult | null;
    onePiece: Record<string, TaskPhaseResult>;
    fullContext: TaskPhaseResult | null;
  };
};

export type TaskEligibilityRegistry = {
  schemaVersion: 1;
  adapterId: string;
  generatedAt: string;
  items: Record<string, { modes: Partial<Record<"memory" | "chat", TaskModeEligibility>> }>;
};

function fallbackCount(dbPath: string): number {
  const memory = queryRows<{ count: number }>(dbPath, "SELECT COUNT(*) AS count FROM memory_entries WHERE entry_text LIKE '%[parse fallback]%';")[0]?.count ?? 0;
  const chat = queryRows<{ count: number }>(dbPath, "SELECT COUNT(*) AS count FROM chat_messages WHERE message_text LIKE '%[parse fallback]%';")[0]?.count ?? 0;
  return memory + chat;
}

function finalResponsesValid(dbPath: string, requireSelection: boolean): boolean {
  const rows = queryRows<{ outputJson: string }>(
    dbPath,
    "SELECT output_json AS outputJson FROM events WHERE event_type = 'final_group_choice';",
  );
  if (rows.length === 0) return false;
  return rows.every((row) => {
    try {
      const choice = JSON.parse(row.outputJson) as { parseValid?: unknown; selectedClaimId?: unknown };
      return choice.parseValid === true && (!requireSelection || typeof choice.selectedClaimId === "string");
    } catch {
      return false;
    }
  });
}

function phaseResult(cells: GridResult["cells"], requireSelection: boolean): TaskPhaseResult {
  const correct = cells.filter((cell) => cell.summary.groupDecision?.correct).length;
  const validFinalResponses = cells.every((cell) => finalResponsesValid(cell.summary.dbPath, requireSelection));
  const parserFallbackEntries = cells.reduce((total, cell) => total + fallbackCount(cell.summary.dbPath), 0);
  const technicalPass = validFinalResponses
    && parserFallbackEntries === 0
    // Generic manipulation checks require shared retrieval, which is not
    // expected for a no-context or one-piece control. These controls instead
    // require a valid final response; null is valid only when abstention is
    // explicitly allowed by the scenario.
    && cells.every((cell) => cell.summary.groupDecision !== undefined);
  return {
    runs: cells.length,
    correctRate: cells.length === 0 ? 0 : correct / cells.length,
    finalResponsesValid: validFinalResponses,
    parserFallbackEntries,
    technicalPass,
  };
}

export function buildTaskEligibility(resultPath: string, projectRoot: string): TaskEligibilityRegistry {
  const grid = JSON.parse(fs.readFileSync(path.resolve(resultPath), "utf8")) as GridResult;
  const scenarios = new Map(grid.inputCatalog.scenarios.map((reference) => [reference.id, loadScenario(reference.path)]));
  const modeSet = new Set(grid.cells.map((cell) => cell.summary.interactionMode));
  if (modeSet.size !== 1) throw new Error("A task-screen result must contain exactly one interaction mode.");
  const mode = [...modeSet][0] as "memory" | "chat";
  const grouped = new Map<string, { adapterId: string; phases: Map<string, GridResult["cells"]> }>();

  for (const cell of grid.cells) {
    const protocol = scenarios.get(cell.scenarioId)?.taskProtocol;
    if (!protocol || protocol.phase === "group") continue;
    const entry = grouped.get(protocol.taskId) ?? { adapterId: protocol.adapterId, phases: new Map() };
    const phaseKey = protocol.phase === "one_piece" ? `one_piece:${protocol.pieceId}` : protocol.phase;
    const cells = entry.phases.get(phaseKey) ?? [];
    cells.push(cell);
    entry.phases.set(phaseKey, cells);
    grouped.set(protocol.taskId, entry);
  }

  const byAdapter = new Map<string, TaskEligibilityRegistry>();
  for (const [taskId, entry] of grouped) {
    const noContext = entry.phases.has("no_context") ? phaseResult(entry.phases.get("no_context")!, false) : null;
    const fullContext = entry.phases.has("full_context") ? phaseResult(entry.phases.get("full_context")!, true) : null;
    const onePiece = Object.fromEntries([...entry.phases.entries()]
      .filter(([phase]) => phase.startsWith("one_piece:"))
      .map(([phase, cells]) => [phase.slice("one_piece:".length), phaseResult(cells, false)]));
    const reasons: string[] = [];
    if (!noContext) reasons.push("Missing no-context control.");
    else if (!noContext.technicalPass) reasons.push("No-context control has no valid final response or has parser fallbacks.");
    else if (noContext.correctRate > 0.35) reasons.push(`No-context accuracy ${noContext.correctRate.toFixed(3)} exceeds 0.350.`);
    if (!fullContext) reasons.push("Missing full-context control.");
    else if (!fullContext.technicalPass) reasons.push("Full-context control has no valid selected answer or has parser fallbacks.");
    else if (fullContext.correctRate < 0.8) reasons.push(`Full-context accuracy ${fullContext.correctRate.toFixed(3)} is below 0.800.`);
    const pieces = Object.entries(onePiece);
    if (pieces.length === 0) reasons.push("Missing one-piece controls.");
    for (const [pieceId, result] of pieces) {
      if (!result.technicalPass) reasons.push(`One-piece control ${pieceId} has no valid final response or has parser fallbacks.`);
      else if (result.correctRate >= 0.6) reasons.push(`One-piece control ${pieceId} accuracy ${result.correctRate.toFixed(3)} reaches 0.600.`);
    }
    const registry = byAdapter.get(entry.adapterId) ?? {
      schemaVersion: 1,
      adapterId: entry.adapterId,
      generatedAt: new Date().toISOString(),
      items: {},
    };
    registry.items[taskId] = {
      modes: {
        [mode]: {
          approved: reasons.length === 0,
          reasons,
          phases: { noContext, onePiece, fullContext },
        },
      },
    };
    byAdapter.set(entry.adapterId, registry);
  }

  if (byAdapter.size !== 1) throw new Error("A task-screen result must contain scenarios from exactly one adapter.");
  const registry = [...byAdapter.values()][0];
  const outputPath = path.join(projectRoot, "output", "task-screens", `${registry.adapterId}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const previous = fs.existsSync(outputPath)
    ? JSON.parse(fs.readFileSync(outputPath, "utf8")) as TaskEligibilityRegistry
    : null;
  for (const [taskId, item] of Object.entries(previous?.items ?? {})) {
    registry.items[taskId] = {
      modes: { ...item.modes, ...(registry.items[taskId]?.modes ?? {}) },
    };
  }
  fs.writeFileSync(outputPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
  return registry;
}

export function assertTaskEligible(projectRoot: string, scenarioPath: string, interactionMode: "memory" | "chat"): void {
  const scenario = loadScenario(scenarioPath);
  const protocol = scenario.taskProtocol;
  if (!protocol || protocol.phase !== "group") return;
  const eligibilityPath = path.join(projectRoot, "output", "task-screens", `${protocol.adapterId}.json`);
  if (!fs.existsSync(eligibilityPath)) {
    throw new Error(`Blocked ${scenario.id}: no task-screen eligibility file exists at ${eligibilityPath}.`);
  }
  const registry = JSON.parse(fs.readFileSync(eligibilityPath, "utf8")) as TaskEligibilityRegistry;
  const result = registry.items[protocol.taskId]?.modes[interactionMode];
  if (!result?.approved) {
    const details = result?.reasons.join(" ") || `No ${interactionMode} screen result exists for ${protocol.taskId}.`;
    throw new Error(`Blocked ${scenario.id}: ${details}`);
  }
}
