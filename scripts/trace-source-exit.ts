/**
 * Deep trace analysis for source-exit experiments.
 * For each cell where false belief persisted (false endorsement > 0):
 * - What did the contamination agent write before exiting?
 * - Who retrieved those entries after the exit?
 * - Did they change their beliefs based on what they retrieved?
 * - When correction arrived, what was in the retrieval window?
 * - Why did recovery fail?
 *
 * Usage: npx tsx scripts/trace-source-exit.ts <grid-results.json>
 */

import fs from "fs";
import path from "path";
import { queryRows } from "../src/db/sqlite";

type CellResult = {
  scenarioId: string;
  conditionId: string;
  rosterId: string;
  seed: number;
  summary: {
    runId: string;
    dbPath: string;
    falseClaimEndorsementRate: number;
    recoveryAfterCorrection: number;
    distanceFromGroundTruth: number;
  };
};

const gridPath = process.argv[2];
if (!gridPath) {
  console.error("Usage: npx tsx scripts/trace-source-exit.ts <grid-results.json>");
  process.exit(1);
}

const grid = JSON.parse(fs.readFileSync(gridPath, "utf8"));
const cells: CellResult[] = grid.cells;

// Find the focus claim from the first scenario
const focusClaims: Record<string, string> = {
  "distributed_ego_depletion_v1": "claim_ego_depletion",
  "distributed_wakefield_mmr_autism_v1": "claim_mmr_causes_autism",
  "distributed_climate_attribution_v1": "claim_natural_cycles",
  "distributed_room_temp_superconductor_v1": "claim_rts_valid",
};

const agents = ["contamination_1", "specialist_1", "specialist_2", "regular_1", "regular_2", "observer_1"];

console.log("=".repeat(70));
console.log("  SOURCE EXIT TRACE ANALYSIS");
console.log("=".repeat(70));

// Summary by roster
const byRoster: Record<string, CellResult[]> = {};
for (const cell of cells) {
  const key = cell.rosterId;
  if (!byRoster[key]) byRoster[key] = [];
  byRoster[key].push(cell);
}

for (const [rosterId, rosterCells] of Object.entries(byRoster)) {
  const avgFalse = rosterCells.reduce((a, c) => a + c.summary.falseClaimEndorsementRate, 0) / rosterCells.length;
  const avgRecovery = rosterCells.reduce((a, c) => a + c.summary.recoveryAfterCorrection, 0) / rosterCells.length;
  const avgTruth = rosterCells.reduce((a, c) => a + c.summary.distanceFromGroundTruth, 0) / rosterCells.length;
  console.log(`\n${rosterId}: n=${rosterCells.length}  false=${avgFalse.toFixed(3)}  recovery=${avgRecovery.toFixed(3)}  truth=${avgTruth.toFixed(3)}`);
}

// Deep dive into cells with false endorsement > 0
const lockInCells = cells.filter(c => c.summary.falseClaimEndorsementRate > 0);
console.log(`\n${"=".repeat(70)}`);
console.log(`  CELLS WITH PERSISTENT FALSE BELIEF: ${lockInCells.length}/${cells.length}`);
console.log("=".repeat(70));

for (const cell of lockInCells.slice(0, 10)) { // limit to first 10 for readability
  const focusClaim = focusClaims[cell.scenarioId] || "unknown";
  console.log(`\n--- ${cell.scenarioId} / ${cell.rosterId} / seed ${cell.seed} ---`);
  console.log(`False endorsement: ${cell.summary.falseClaimEndorsementRate}`);
  console.log(`Recovery: ${cell.summary.recoveryAfterCorrection}`);

  if (!fs.existsSync(cell.summary.dbPath)) {
    console.log("  DB not found: " + cell.summary.dbPath);
    continue;
  }

  // Belief trajectory
  type StateRow = { step_index: number; agent_id: string; stance: string; confidence: number };
  const states = queryRows<StateRow>(cell.summary.dbPath,
    `SELECT step_index, agent_id, stance, confidence FROM agent_claim_states WHERE claim_id = '${focusClaim}' ORDER BY step_index, agent_id`
  );

  const steps: Record<number, Record<string, string>> = {};
  for (const s of states) {
    if (!steps[s.step_index]) steps[s.step_index] = {};
    const tag = s.stance === "endorse" ? "E" : s.stance === "reject" ? "R" : "U";
    steps[s.step_index][s.agent_id] = `${tag}(${s.confidence.toFixed(2)})`;
  }

  console.log("\n  Belief trajectory:");
  console.log("  Step  " + agents.map(a => a.substring(0,8).padEnd(10)).join(""));
  for (const step of Object.keys(steps).map(Number).sort((a, b) => a - b)) {
    let row = `  ${String(step).padStart(3)}   `;
    for (const a of agents) {
      row += (steps[step][a] || "---").padEnd(10);
    }
    console.log(row);
  }

  // Memory entries written by contamination agent
  type EntryRow = { step_index: number; agent_id: string; stance: string; confidence: number; source_type: string; visibility: string };
  const contamEntries = queryRows<EntryRow>(cell.summary.dbPath,
    `SELECT step_index, agent_id, stance, confidence, source_type, visibility FROM memory_entries WHERE agent_id = 'contamination_1' AND claim_id = '${focusClaim}' ORDER BY step_index`
  );

  if (contamEntries.length > 0) {
    console.log("\n  Contamination agent's memory entries:");
    for (const e of contamEntries) {
      console.log(`    step ${e.step_index}: ${e.source_type} ${e.stance}(${e.confidence.toFixed(2)}) ${e.visibility}`);
    }
  }

  // Who retrieved contamination entries after step 3 (exit step)
  type TraceRow = { step_index: number; agent_id: string; retrieved_entry_ids_json: string };
  const postExitTraces = queryRows<TraceRow>(cell.summary.dbPath,
    `SELECT step_index, agent_id, retrieved_entry_ids_json FROM retrieval_traces WHERE claim_id = '${focusClaim}' AND step_index > 3 ORDER BY step_index`
  );

  if (postExitTraces.length > 0) {
    console.log("\n  Post-exit retrievals (after contamination agent left):");
    for (const t of postExitTraces) {
      const ids = JSON.parse(t.retrieved_entry_ids_json) as string[];
      const hasContam = ids.some(id => id.includes("contamination"));
      console.log(`    step ${t.step_index}: ${t.agent_id.substring(0,12)} retrieved ${ids.length} entries ${hasContam ? "⚠ INCLUDES CONTAMINATION ENTRY" : ""}`);
    }
  }

  // Final stances
  const maxStep = Math.max(...Object.keys(steps).map(Number));
  const finalStances = steps[maxStep] || {};
  const endorsing = Object.entries(finalStances).filter(([_, v]) => v.startsWith("E")).map(([a]) => a);
  if (endorsing.length > 0) {
    console.log(`\n  Still endorsing at end: ${endorsing.join(", ")}`);
  }
}

console.log(`\n${"=".repeat(70)}`);
console.log("  DONE");
console.log("=".repeat(70));
