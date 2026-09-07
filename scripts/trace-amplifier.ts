import { queryRows } from "../src/db/sqlite";

const conditions = [
  { name: "evidence_board", db: "output/amplifier_majority_wrong_haiku_v1_distributed_ego_depletion_majority_wrong_v1_shared_evidence_board_no_correction_distributed_baseline_6_haiku-shared_evidence_board_no_correction-seed1/trace.db" },
  { name: "mixed_record", db: "output/amplifier_majority_wrong_haiku_v1_distributed_ego_depletion_majority_wrong_v1_shared_mixed_record_no_correction_distributed_baseline_6_haiku-shared_mixed_record_no_correction-seed1/trace.db" }
];

const agents = ["contamination_1", "specialist_1", "specialist_2", "regular_1", "regular_2", "observer_1"];
const agentShort: Record<string, string> = {
  contamination_1: "contam_1",
  specialist_1: "spec_1  ",
  specialist_2: "spec_2  ",
  regular_1: "reg_1   ",
  regular_2: "reg_2   ",
  observer_1: "obs_1   "
};

for (const cond of conditions) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${cond.name.toUpperCase()}`);
  console.log(`${"=".repeat(60)}`);

  // Belief trajectory
  type StateRow = { step_index: number; agent_id: string; stance: string; confidence: number };
  const states = queryRows<StateRow>(cond.db,
    "SELECT step_index, agent_id, stance, confidence FROM agent_claim_states WHERE claim_id = 'claim_ego_depletion' ORDER BY step_index, agent_id"
  );

  const steps: Record<number, Record<string, string>> = {};
  for (const s of states) {
    if (!steps[s.step_index]) steps[s.step_index] = {};
    const tag = s.stance === "endorse" ? "E" : s.stance === "reject" ? "R" : "U";
    steps[s.step_index][s.agent_id] = `${tag}(${s.confidence.toFixed(2)})`;
  }

  console.log("\nBelief trajectory (E=endorse R=reject U=uncertain):");
  console.log("Step  " + agents.map(a => agentShort[a]).join("  "));
  for (const step of Object.keys(steps).map(Number).sort((a, b) => a - b)) {
    let row = String(step).padStart(3) + "   ";
    for (const a of agents) {
      row += (steps[step][a] || "---").padEnd(10);
    }
    console.log(row);
  }

  // Memory entries written to shared record
  type EntryRow = { step_index: number; agent_id: string; claim_id: string; stance: string; confidence: number; source_type: string };
  const entries = queryRows<EntryRow>(cond.db,
    "SELECT step_index, agent_id, claim_id, stance, confidence, source_type FROM memory_entries WHERE visibility = 'shared' ORDER BY step_index, claim_id"
  );

  console.log("\nShared record entries:");
  for (const e of entries) {
    const claim = e.claim_id.replace("claim_", "");
    console.log(`  step ${e.step_index}: ${agentShort[e.agent_id] || e.agent_id} ${e.source_type.padEnd(9)} ${e.stance}(${e.confidence.toFixed(2)}) → ${claim}`);
  }

  // Retrieval traces
  type TraceRow = { step_index: number; agent_id: string; retrieved_entry_ids_json: string };
  const traces = queryRows<TraceRow>(cond.db,
    "SELECT step_index, agent_id, retrieved_entry_ids_json FROM retrieval_traces WHERE claim_id = 'claim_ego_depletion' ORDER BY step_index"
  );

  console.log("\nWhat each agent retrieved when evaluating the focus claim:");
  for (const t of traces) {
    const ids = JSON.parse(t.retrieved_entry_ids_json) as string[];
    if (ids.length > 0) {
      console.log(`  step ${t.step_index}: ${agentShort[t.agent_id] || t.agent_id} retrieved ${ids.length} entries: ${ids.map(id => id.substring(0, 40)).join(", ")}`);
    }
  }

  // Testimony adoptions
  try {
    type AdoptRow = { step_index: number; agent_id: string; new_stance: string };
    const adoptions = queryRows<AdoptRow>(cond.db,
      "SELECT step_index, agent_id, new_stance FROM testimony_adoptions WHERE claim_id = 'claim_ego_depletion' ORDER BY step_index"
    );
    if (adoptions.length > 0) {
      console.log("\nTestimony adoptions:");
      for (const a of adoptions) {
        console.log(`  step ${a.step_index}: ${agentShort[a.agent_id] || a.agent_id} adopted ${a.new_stance}`);
      }
    } else {
      console.log("\nNo testimony adoptions recorded.");
    }
  } catch { console.log("\nTestimony adoptions table not available."); }
}
