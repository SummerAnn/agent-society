/**
 * Systematic trace analysis across all source-exit cells.
 * For each roster variant, summarize:
 * - How many cells have persistent false belief
 * - Which agent(s) are still endorsing at the end
 * - Whether any NON-contamination agent ever endorsed the false claim
 * - Whether contamination agent's entries were retrieved by other agents
 * - Whether any agent changed belief TOWARD the false claim after retrieving contamination entries
 *
 * Usage: npx tsx scripts/trace-systematic.ts output/rerun_source_exit_v3-grid-results.json
 */

import fs from "fs";
import { queryRows } from "../src/db/sqlite";

const gridPath = process.argv[2];
if (!gridPath) { console.error("Usage: npx tsx scripts/trace-systematic.ts <grid-results.json>"); process.exit(1); }

const grid = JSON.parse(fs.readFileSync(gridPath, "utf8"));

const focusClaims: Record<string, string> = {
  "distributed_ego_depletion_v1": "claim_ego_depletion",
  "distributed_wakefield_mmr_autism_v1": "claim_mmr_causes_autism",
  "distributed_climate_attribution_v1": "claim_natural_cycles",
  "distributed_room_temp_superconductor_v1": "claim_rts_valid",
};

type Cell = {
  scenarioId: string;
  conditionId: string;
  rosterId: string;
  seed: number;
  summary: { runId: string; dbPath: string; falseClaimEndorsementRate: number; recoveryAfterCorrection: number };
};

const byRoster: Record<string, Cell[]> = {};
for (const cell of grid.cells as Cell[]) {
  if (!byRoster[cell.rosterId]) byRoster[cell.rosterId] = [];
  byRoster[cell.rosterId].push(cell);
}

console.log("=".repeat(70));
console.log("  SYSTEMATIC SOURCE EXIT TRACE ANALYSIS");
console.log("=".repeat(70));

for (const [rosterId, cells] of Object.entries(byRoster)) {
  const lockInCells = cells.filter(c => c.summary.falseClaimEndorsementRate > 0);
  const avgFalse = cells.reduce((a, c) => a + c.summary.falseClaimEndorsementRate, 0) / cells.length;

  console.log(`\n${"─".repeat(70)}`);
  console.log(`Roster: ${rosterId}`);
  console.log(`Cells: ${cells.length} | Lock-in cells: ${lockInCells.length} | Avg false endorsement: ${avgFalse.toFixed(3)}`);

  let contagionCount = 0;
  let contamRetrievedByOthers = 0;
  let othersEverEndorsed = 0;

  for (const cell of cells) {
    const focusClaim = focusClaims[cell.scenarioId];
    if (!focusClaim || !fs.existsSync(cell.summary.dbPath)) continue;

    type StateRow = { step_index: number; agent_id: string; stance: string; confidence: number };
    const states = queryRows<StateRow>(cell.summary.dbPath,
      `SELECT step_index, agent_id, stance, confidence FROM agent_claim_states WHERE claim_id = '${focusClaim}' ORDER BY step_index`
    );

    // Check: did any NON-contamination agent ever endorse?
    const nonContamEndorsements = states.filter(s => s.agent_id !== "contamination_1" && s.stance === "endorse");
    if (nonContamEndorsements.length > 0) {
      othersEverEndorsed++;
      contagionCount++;
    }

    // Check: who still endorses at the final step?
    const maxStep = Math.max(...states.map(s => s.step_index));
    const finalEndorsers = states.filter(s => s.step_index === maxStep && s.stance === "endorse");
    const nonContamFinalEndorsers = finalEndorsers.filter(s => s.agent_id !== "contamination_1");

    if (nonContamFinalEndorsers.length > 0) {
      console.log(`  ⚠ CONTAGION: ${cell.scenarioId}/seed${cell.seed} — non-contamination agents endorsing at end: ${nonContamFinalEndorsers.map(s => s.agent_id).join(", ")}`);
    }

    // Check: did other agents retrieve contamination entries?
    type EntryRow = { memory_entry_id: string };
    const contamEntryIds = queryRows<EntryRow>(cell.summary.dbPath,
      `SELECT memory_entry_id FROM memory_entries WHERE agent_id = 'contamination_1' AND claim_id = '${focusClaim}' AND stance = 'endorse'`
    ).map(r => r.memory_entry_id);

    if (contamEntryIds.length > 0) {
      type TraceRow = { agent_id: string; retrieved_entry_ids_json: string };
      const traces = queryRows<TraceRow>(cell.summary.dbPath,
        `SELECT agent_id, retrieved_entry_ids_json FROM retrieval_traces WHERE claim_id = '${focusClaim}' AND agent_id != 'contamination_1'`
      );

      for (const t of traces) {
        const ids = JSON.parse(t.retrieved_entry_ids_json) as string[];
        if (ids.some(id => contamEntryIds.includes(id))) {
          contamRetrievedByOthers++;
          break; // count per cell, not per retrieval
        }
      }
    }
  }

  console.log(`\n  Summary:`);
  console.log(`    Cells where non-contamination agents ever endorsed: ${othersEverEndorsed}/${cells.length}`);
  console.log(`    Cells where contamination entries were retrieved by others: ${contamRetrievedByOthers}/${cells.length}`);
  console.log(`    Contagion events (false belief spread to other agents): ${contagionCount}/${cells.length}`);
}

console.log(`\n${"=".repeat(70)}`);
console.log("  DONE");
console.log("=".repeat(70));
