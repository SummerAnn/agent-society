import fs from "fs";
import path from "path";

import { loadScenario } from "../config/load";
import type { Scenario, StanceLabel } from "../config/schema";
import { queryRows } from "../db/sqlite";
import type { GridResult } from "./grid";

type RetrievalTraceRow = {
  agentId: string;
  step: number;
  contextJson: string;
};

type BeliefRow = {
  agentId: string;
  step: number;
  stance: StanceLabel;
};

export type LateEvidenceScenarioReport = {
  scenarioId: string;
  lateCounterevidenceIds: string[];
  cells: number;
  agentsExposed: number;
  agentsFalseBeforeExposure: number;
  agentsStillEndorsingAtEnd: number;
  agentsNoLongerEndorsingAtEnd: number;
  agentsRejectingAtEnd: number;
  persistenceRateAmongAtRiskAgents: number | null;
  rejectionRateAmongAtRiskAgents: number | null;
};

export type LateEvidenceReport = {
  gridId: string;
  definition: string;
  scopeNote: string;
  scenarios: LateEvidenceScenarioReport[];
  outputPath?: string;
};

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function lateCounterevidenceIds(scenario: Scenario): string[] {
  return scenario.evidence
    .filter((evidence) => evidence.availableFromStep > 1)
    .filter((evidence) => evidence.effects.some(
      (effect) => effect.claimId === scenario.focusClaimId && effect.effect < 0,
    ))
    .map((evidence) => evidence.id);
}

function visibleLateEvidenceIds(contextJson: string, lateIds: Set<string>): string[] {
  const context = JSON.parse(contextJson) as { visibleEvidenceIds?: unknown };
  const ids = Array.isArray(context.visibleEvidenceIds) ? context.visibleEvidenceIds : [];
  return ids.filter((id): id is string => typeof id === "string" && lateIds.has(id));
}

function firstLateExposureByAgent(
  dbPath: string,
  runId: string,
  claimId: string,
  lateIds: Set<string>,
): Map<string, number> {
  const rows = queryRows<RetrievalTraceRow>(
    dbPath,
    `SELECT agent_id AS agentId, step_index AS step, context_json AS contextJson
     FROM retrieval_traces
     WHERE run_id = ${sqlString(runId)} AND claim_id = ${sqlString(claimId)}
     ORDER BY agent_id ASC, step_index ASC;`,
  );
  const exposure = new Map<string, number>();
  for (const row of rows) {
    if (exposure.has(row.agentId)) continue;
    if (visibleLateEvidenceIds(row.contextJson, lateIds).length > 0) {
      exposure.set(row.agentId, row.step);
    }
  }
  return exposure;
}

function focusBeliefs(dbPath: string, runId: string, claimId: string): BeliefRow[] {
  return queryRows<BeliefRow>(
    dbPath,
    `SELECT agent_id AS agentId, step_index AS step, stance
     FROM agent_claim_states
     WHERE run_id = ${sqlString(runId)} AND claim_id = ${sqlString(claimId)}
     ORDER BY agent_id ASC, step_index ASC;`,
  );
}

function lastStanceAtOrBefore(rows: BeliefRow[], agentId: string, step: number): StanceLabel | null {
  const eligible = rows.filter((row) => row.agentId === agentId && row.step <= step);
  return eligible.at(-1)?.stance ?? null;
}

function finalStance(rows: BeliefRow[], agentId: string): StanceLabel | null {
  const eligible = rows.filter((row) => row.agentId === agentId);
  return eligible.at(-1)?.stance ?? null;
}

export function analyzeLateEvidenceGrid(gridResultPath: string): LateEvidenceReport {
  const resolvedPath = path.resolve(gridResultPath);
  const result = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as GridResult;
  const reports: LateEvidenceScenarioReport[] = [];

  for (const scenarioPath of result.grid.scenarios) {
    const scenario = loadScenario(scenarioPath);
    const lateIds = lateCounterevidenceIds(scenario);
    if (lateIds.length === 0) continue;

    let agentsExposed = 0;
    let agentsFalseBeforeExposure = 0;
    let agentsStillEndorsingAtEnd = 0;
    let agentsNoLongerEndorsingAtEnd = 0;
    let agentsRejectingAtEnd = 0;
    const lateIdSet = new Set(lateIds);

    for (const cell of result.cells.filter((candidate) => candidate.scenarioId === scenario.id)) {
      const exposure = firstLateExposureByAgent(
        cell.summary.dbPath,
        cell.summary.runId,
        scenario.focusClaimId,
        lateIdSet,
      );
      const beliefs = focusBeliefs(cell.summary.dbPath, cell.summary.runId, scenario.focusClaimId);
      agentsExposed += exposure.size;
      for (const [agentId, firstExposureStep] of exposure) {
        const stanceBeforeExposure = lastStanceAtOrBefore(beliefs, agentId, firstExposureStep - 1);
        if (stanceBeforeExposure !== "endorse") continue;
        agentsFalseBeforeExposure += 1;
        const ending = finalStance(beliefs, agentId);
        if (ending === "endorse") {
          agentsStillEndorsingAtEnd += 1;
        } else {
          agentsNoLongerEndorsingAtEnd += 1;
        }
        if (ending === "reject") agentsRejectingAtEnd += 1;
      }
    }

    reports.push({
      scenarioId: scenario.id,
      lateCounterevidenceIds: lateIds,
      cells: result.cells.filter((candidate) => candidate.scenarioId === scenario.id).length,
      agentsExposed,
      agentsFalseBeforeExposure,
      agentsStillEndorsingAtEnd,
      agentsNoLongerEndorsingAtEnd,
      agentsRejectingAtEnd,
      persistenceRateAmongAtRiskAgents: agentsFalseBeforeExposure === 0
        ? null
        : agentsStillEndorsingAtEnd / agentsFalseBeforeExposure,
      rejectionRateAmongAtRiskAgents: agentsFalseBeforeExposure === 0
        ? null
        : agentsRejectingAtEnd / agentsFalseBeforeExposure,
    });
  }

  const report: LateEvidenceReport = {
    gridId: result.grid.id,
    definition: "An at-risk agent is one that endorsed the false focus claim before a late counter-source first became visible in its prompt. Persistence is the share of those agents that still endorsed the claim in their final recorded stance. Rejection is the share that ended by rejecting it.",
    scopeNote: "This measures recorded exposure and later belief change. It does not establish why an agent changed or prove that it attended to a particular source.",
    scenarios: reports,
  };
  const outputPath = path.join(path.dirname(resolvedPath), `${result.grid.id}-late-evidence-report.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { ...report, outputPath };
}
