import fs from "fs";
import path from "path";

import { loadCondition, loadScenario } from "../config/load";
import { queryRows } from "../db/sqlite";
import type { GridResult } from "./grid";

type CountRow = { count: number };
type RetrievalContextRow = { stepIndex: number; contextJson: string };

type AuditRunConfig = {
  turnOrder?: string[];
  agents: Array<{
    id: string;
    activeFromStep?: number;
    activeUntilStep?: number;
    seedStatementPolicy?: { fromStep?: number; untilStep?: number };
  }>;
};

function forcedChatTurns(runConfig: AuditRunConfig, maxSteps: number): number {
  if (!runConfig.turnOrder?.length) return 0;
  let count = 0;
  for (let step = 1; step <= maxSteps; step += 1) {
    const agentId = runConfig.turnOrder[(step - 1) % runConfig.turnOrder.length];
    const agent = runConfig.agents.find((candidate) => candidate.id === agentId);
    const policy = agent?.seedStatementPolicy;
    if (!agent || !policy) continue;
    if (step < (agent.activeFromStep ?? 1) || step > (agent.activeUntilStep ?? Infinity)) continue;
    if (step >= (policy.fromStep ?? 1) && step <= (policy.untilStep ?? 1)) count += 1;
  }
  return count;
}

export type GridAuditReport = {
  gridId: string;
  gridResultPath: string;
  cells: { expected: number; fullSteps: number; fullCalls: number; manipulationPassed: number };
  trace: { parserFallbackEntries: number; correctionEvents: number };
  delayedEvidence: Array<{ evidenceId: string; availableFromStep: number; visibleBeforeAvailable: number; visibleAtOrAfterAvailable: number }>;
  eligibleForDescriptiveAnalysis: boolean;
  failures: string[];
};

function count(dbPath: string, sql: string): number {
  return queryRows<CountRow>(dbPath, sql)[0]?.count ?? 0;
}

function countEvidenceVisibility(
  dbPath: string,
  evidenceId: string,
  availableFromStep: number,
): { visibleBeforeAvailable: number; visibleAtOrAfterAvailable: number } {
  const traces = queryRows<RetrievalContextRow>(
    dbPath,
    "SELECT step_index AS stepIndex, context_json AS contextJson FROM retrieval_traces;",
  );
  let visibleBeforeAvailable = 0;
  let visibleAtOrAfterAvailable = 0;
  for (const trace of traces) {
    const context = JSON.parse(trace.contextJson) as { visibleEvidenceIds?: unknown };
    const visibleEvidenceIds = Array.isArray(context.visibleEvidenceIds) ? context.visibleEvidenceIds : [];
    if (!visibleEvidenceIds.includes(evidenceId)) continue;
    if (trace.stepIndex < availableFromStep) visibleBeforeAvailable += 1;
    else visibleAtOrAfterAvailable += 1;
  }
  return { visibleBeforeAvailable, visibleAtOrAfterAvailable };
}

export function auditGridResult(gridResultPath: string): GridAuditReport {
  const resolvedPath = path.resolve(gridResultPath);
  const result = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as GridResult;
  const failures: string[] = [];
  let fullSteps = 0;
  let fullCalls = 0;
  let parserFallbackEntries = 0;
  let correctionEvents = 0;

  for (const cell of result.cells) {
    // Memory mode makes one claim call for each active turn. Group-decision
    // tasks then ask every roster member for one final A/B/C choice.
    const conditionPath = result.inputCatalog.conditions.find((item) => item.id === cell.conditionId)?.path;
    if (!conditionPath) throw new Error(`Audit could not resolve condition path for ${cell.conditionId}.`);
    const condition = loadCondition(conditionPath);
    const rosterPath = result.inputCatalog.rosters.find((roster) => roster.id === cell.rosterId)?.path;
    if (!rosterPath) throw new Error(`Audit could not resolve roster path for ${cell.rosterId}.`);
    const roster = JSON.parse(fs.readFileSync(rosterPath, "utf8")) as { agents: AuditRunConfig["agents"] };
    const runConfig: AuditRunConfig = { turnOrder: result.grid.turnOrder, agents: roster.agents };
    const skippedSeedTurns = condition.interaction.mode === "chat" && cell.summary.groupDecision
      ? forcedChatTurns(runConfig, cell.summary.maxSteps)
      : 0;
    const expectedCalls = condition.interaction.mode === "chat" && cell.summary.groupDecision
      ? cell.summary.maxSteps + Math.min(4, cell.summary.agentCount) + cell.summary.agentCount - skippedSeedTurns
      : cell.summary.maxSteps * cell.summary.claimCount
        + (cell.summary.groupDecision ? cell.summary.agentCount + Math.min(4, cell.summary.agentCount) : 0);
    const maxStep = count(cell.summary.dbPath, "SELECT COALESCE(MAX(step_index), 0) AS count FROM events;");
    const calls = count(cell.summary.dbPath, "SELECT COUNT(*) AS count FROM model_calls;");
    if (maxStep === cell.summary.maxSteps) fullSteps += 1;
    if (calls === expectedCalls) fullCalls += 1;
    parserFallbackEntries += count(
      cell.summary.dbPath,
      "SELECT COUNT(*) AS count FROM memory_entries WHERE entry_text LIKE '%[parse fallback]%';",
    );
    correctionEvents += count(cell.summary.dbPath, "SELECT COUNT(*) AS count FROM interventions;");
  }

  const delayedEvidence = result.grid.scenarios.flatMap((scenarioPath) => {
    const scenario = loadScenario(scenarioPath);
    return scenario.evidence
      .filter((evidence) => evidence.availableFromStep > 1)
      .map((evidence) => {
        let visibleBeforeAvailable = 0;
        let visibleAtOrAfterAvailable = 0;
        for (const cell of result.cells.filter((candidate) => candidate.scenarioId === scenario.id)) {
          const visibility = countEvidenceVisibility(cell.summary.dbPath, evidence.id, evidence.availableFromStep);
          visibleBeforeAvailable += visibility.visibleBeforeAvailable;
          visibleAtOrAfterAvailable += visibility.visibleAtOrAfterAvailable;
        }
        return { evidenceId: evidence.id, availableFromStep: evidence.availableFromStep, visibleBeforeAvailable, visibleAtOrAfterAvailable };
      });
  });

  const manipulationPassed = result.cells.filter((cell) => cell.manipulationCheck.passed).length;
  if (fullSteps !== result.cells.length) failures.push(`${result.cells.length - fullSteps} cells did not reach the configured step limit.`);
  if (fullCalls !== result.cells.length) failures.push(`${result.cells.length - fullCalls} cells did not complete their expected model calls.`);
  if (parserFallbackEntries > 0) failures.push(`${parserFallbackEntries} malformed-response fallback entries were written.`);
  if (manipulationPassed !== result.cells.length) failures.push(`${result.cells.length - manipulationPassed} manipulation checks failed.`);
  for (const evidence of delayedEvidence) {
    if (evidence.visibleBeforeAvailable > 0) {
      failures.push(`${evidence.evidenceId} was visible ${evidence.visibleBeforeAvailable} times before step ${evidence.availableFromStep}.`);
    }
    if (evidence.visibleAtOrAfterAvailable === 0) {
      failures.push(`${evidence.evidenceId} was never visible at or after step ${evidence.availableFromStep}.`);
    }
  }

  return {
    gridId: result.grid.id,
    gridResultPath: resolvedPath,
    cells: { expected: result.cells.length, fullSteps, fullCalls, manipulationPassed },
    trace: { parserFallbackEntries, correctionEvents },
    delayedEvidence,
    eligibleForDescriptiveAnalysis: failures.length === 0,
    failures,
  };
}
