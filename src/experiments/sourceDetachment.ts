import fs from "fs";

import type { GridResult } from "./grid";
import { queryRows } from "../db/sqlite";

export type DetachedSupportSummary = {
  supportingAgents: number;
  agentsRetrievingSharedConclusions: number;
  agentsRetrievingSharedEvidence: number;
  detachedSupportAgents: number;
  detachedSupportRate: number | null;
};

export function evaluateFinalDecisionRetrievalSupport(
  dbPath: string,
  runId: string,
  selectedClaimId: string | null,
  finalStep: number,
): DetachedSupportSummary | null {
  if (!selectedClaimId) return null;

  const safeRunId = runId.replace(/'/g, "''");
  const safeClaimId = selectedClaimId.replace(/'/g, "''");
  const finalSupporters = queryRows<{ agentId: string }>(
    dbPath,
    `SELECT agent_id AS agentId FROM agent_claim_states WHERE run_id = '${safeRunId}' AND claim_id = '${safeClaimId}' AND step_index = ${finalStep} AND stance = 'endorse';`,
  );
  if (finalSupporters.length === 0) {
    return {
      supportingAgents: 0,
      agentsRetrievingSharedConclusions: 0,
      agentsRetrievingSharedEvidence: 0,
      detachedSupportAgents: 0,
      detachedSupportRate: null,
    };
  }

  const entries = queryRows<{ id: string; sourceType: string; visibility: string }>(
    dbPath,
    `SELECT memory_entry_id AS id, source_type AS sourceType, visibility FROM memory_entries WHERE run_id = '${safeRunId}' AND claim_id = '${safeClaimId}';`,
  );
  const entryKinds = new Map(entries.map((entry) => [entry.id, entry]));
  let agentsRetrievingSharedConclusions = 0;
  let agentsRetrievingSharedEvidence = 0;
  let detachedSupportAgents = 0;

  for (const { agentId } of finalSupporters) {
    const trace = queryRows<{ retrievedIdsJson: string }>(
      dbPath,
      `SELECT retrieved_entry_ids_json AS retrievedIdsJson FROM retrieval_traces WHERE run_id = '${safeRunId}' AND claim_id = '${safeClaimId}' AND agent_id = '${agentId.replace(/'/g, "''")}' AND step_index <= ${finalStep} ORDER BY step_index DESC, retrieval_trace_id DESC LIMIT 1;`,
    )[0];
    const retrieved = new Set<string>(JSON.parse(trace?.retrievedIdsJson || "[]") as string[]);
    const retrievedSharedConclusion = [...retrieved].some((id) => {
      const entry = entryKinds.get(id);
      return entry?.visibility === "shared" && entry.sourceType === "agent";
    });
    const retrievedSharedEvidence = [...retrieved].some((id) => {
      const entry = entryKinds.get(id);
      return entry?.visibility === "shared" && entry.sourceType === "evidence";
    });
    if (retrievedSharedConclusion) agentsRetrievingSharedConclusions += 1;
    if (retrievedSharedEvidence) agentsRetrievingSharedEvidence += 1;
    if (retrievedSharedConclusion && !retrievedSharedEvidence) detachedSupportAgents += 1;
  }

  return {
    supportingAgents: finalSupporters.length,
    agentsRetrievingSharedConclusions,
    agentsRetrievingSharedEvidence,
    detachedSupportAgents,
    detachedSupportRate: detachedSupportAgents / finalSupporters.length,
  };
}

export function analyzeSourceDetachmentGrid(gridPath: string): Record<string, unknown> {
  const grid = JSON.parse(fs.readFileSync(gridPath, "utf8")) as GridResult;
  const byCondition = new Map<string, { cells: number; selected: number; detachedRates: number[]; detachedAgents: number; supporters: number }>();

  for (const cell of grid.cells) {
    const condition = byCondition.get(cell.conditionId) ?? {
      cells: 0,
      selected: 0,
      detachedRates: [],
      detachedAgents: 0,
      supporters: 0,
    };
    condition.cells += 1;
    const decision = cell.summary.groupDecision;
    const support = evaluateFinalDecisionRetrievalSupport(
      cell.summary.dbPath,
      cell.summary.runId,
      decision?.selectedClaimId ?? null,
      cell.summary.completedSteps,
    );
    if (support) {
      condition.selected += 1;
      condition.detachedAgents += support.detachedSupportAgents;
      condition.supporters += support.supportingAgents;
      if (support.detachedSupportRate !== null) condition.detachedRates.push(support.detachedSupportRate);
    }
    byCondition.set(cell.conditionId, condition);
  }

  return {
    gridId: grid.grid.id,
    definition: "Among agents endorsing the final selected answer, the share whose final retrieval contained a shared analyst conclusion for that answer but no shared original-source entry for it.",
    conditions: Object.fromEntries([...byCondition].map(([conditionId, value]) => [conditionId, {
      cells: value.cells,
      selectedGroupDecisions: value.selected,
      meanDetachedSupportRate: value.detachedRates.length === 0
        ? null
        : value.detachedRates.reduce((sum, rate) => sum + rate, 0) / value.detachedRates.length,
      detachedSupportAgents: value.detachedAgents,
      supportingAgents: value.supporters,
    }])),
  };
}
