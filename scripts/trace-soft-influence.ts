/**
 * Check for softer forms of contagion:
 * - Agents going uncertain after seeing wrong entries
 * - Delayed rejection (more steps to reach reject)
 * - Confidence differences between rosters
 */

import fs from "fs";
import { queryRows } from "../src/db/sqlite";

const gridPath = process.argv[2];
if (!gridPath) { console.error("Usage: npx tsx scripts/trace-soft-influence.ts <grid-results.json>"); process.exit(1); }

const grid = JSON.parse(fs.readFileSync(gridPath, "utf8"));
const focusClaims: Record<string, string> = {
  "distributed_ego_depletion_v1": "claim_ego_depletion",
  "distributed_wakefield_mmr_autism_v1": "claim_mmr_causes_autism",
  "distributed_climate_attribution_v1": "claim_natural_cycles",
  "distributed_room_temp_superconductor_v1": "claim_rts_valid",
};

type Cell = { scenarioId: string; conditionId: string; rosterId: string; seed: number; summary: { dbPath: string } };

const byRoster: Record<string, Cell[]> = {};
for (const cell of grid.cells as Cell[]) {
  if (!byRoster[cell.rosterId]) byRoster[cell.rosterId] = [];
  byRoster[cell.rosterId].push(cell);
}

console.log("=".repeat(70));
console.log("  SOFT INFLUENCE ANALYSIS");
console.log("=".repeat(70));

for (const [rosterId, cells] of Object.entries(byRoster)) {
  let totalUncertainAgents = 0;
  let totalFirstRejectStep = 0;
  let totalFinalConfidence = 0;
  let agentCount = 0;
  let cellsWithUncertain = 0;

  for (const cell of cells) {
    const focusClaim = focusClaims[cell.scenarioId];
    if (!focusClaim || !fs.existsSync(cell.summary.dbPath)) continue;

    type StateRow = { step_index: number; agent_id: string; stance: string; confidence: number };
    const states = queryRows<StateRow>(cell.summary.dbPath,
      `SELECT step_index, agent_id, stance, confidence FROM agent_claim_states WHERE claim_id = '${focusClaim}' AND agent_id != 'contamination_1' ORDER BY step_index, agent_id`
    );

    const agentHistory: Record<string, Array<{step: number; stance: string; conf: number}>> = {};
    for (const s of states) {
      if (!agentHistory[s.agent_id]) agentHistory[s.agent_id] = [];
      agentHistory[s.agent_id].push({step: s.step_index, stance: s.stance, conf: s.confidence});
    }

    let cellHasUncertain = false;
    for (const [agentId, history] of Object.entries(agentHistory)) {
      // Was agent ever uncertain AFTER its first action?
      const afterFirst = history.filter(h => h.step > 0);
      const wasUncertain = afterFirst.some(h => h.stance === "uncertain");
      if (wasUncertain) { totalUncertainAgents++; cellHasUncertain = true; }

      // First step where agent rejects
      const firstReject = history.find(h => h.stance === "reject");
      if (firstReject) totalFirstRejectStep += firstReject.step;

      // Final confidence (of rejection)
      const finalState = history[history.length - 1];
      if (finalState && finalState.stance === "reject") {
        totalFinalConfidence += finalState.conf;
      }
      agentCount++;
    }
    if (cellHasUncertain) cellsWithUncertain++;
  }

  const n = cells.length;
  console.log(`\n${rosterId}:`);
  console.log(`  Cells: ${n}`);
  console.log(`  Cells with any uncertain non-contam agent: ${cellsWithUncertain}/${n} (${(cellsWithUncertain/n*100).toFixed(0)}%)`);
  console.log(`  Total non-contam agents ever uncertain: ${totalUncertainAgents} (avg ${(totalUncertainAgents/n).toFixed(2)}/cell)`);
  console.log(`  Avg first reject step: ${(totalFirstRejectStep/agentCount).toFixed(1)}`);
  console.log(`  Avg final reject confidence: ${(totalFinalConfidence/agentCount).toFixed(3)}`);
}
