import fs from "fs";
import path from "path";
import { queryRows } from "../src/db/sqlite";

const outDir = "output";

function analyzeExperiment(pattern: string, label: string, target: number, falseClaims?: string[]) {
  const dirs = fs.readdirSync(outDir).filter(d => d.startsWith(pattern));
  if (dirs.length === 0) return;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${label} (${dirs.length} cells)`);
  console.log(`${"=".repeat(60)}`);

  // Group by roster+condition
  const groups: Record<string, { fe: number; td: number; dir: string }[]> = {};
  for (const dir of dirs) {
    const summaryPath = path.join(outDir, dir, "summary.json");
    if (!fs.existsSync(summaryPath)) continue;
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

    // Extract condition and roster from dir name
    const parts = dir.replace(pattern + "_", "");
    const key = parts.substring(0, 80);
    if (!groups[key]) groups[key] = [];
    groups[key].push({
      fe: summary.falseClaimEndorsementRate || 0,
      td: summary.truthDistance || 0,
      dir
    });
  }

  // Aggregate by condition
  const condGroups: Record<string, number[]> = {};
  for (const [key, cells] of Object.entries(groups)) {
    // Simplify key to condition+roster
    let simpleKey = key;
    // Try to extract meaningful parts
    const condMatch = key.match(/(shared_memory|personal_memory|chat_fully|chat_star|bounded|evidence_board)[^_]*[^-]*/);
    const rosterMatch = key.match(/(baseline|source_exit|majority_wrong|bounded-record|early-exit)[^-]*/);
    if (condMatch || rosterMatch) {
      simpleKey = `${rosterMatch?.[0] || "?"} / ${condMatch?.[0] || "?"}`;
    }
    if (!condGroups[simpleKey]) condGroups[simpleKey] = [];
    condGroups[simpleKey].push(...cells.map(c => c.fe));
  }

  for (const [key, values] of Object.entries(condGroups)) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    console.log(`  ${key}: false_endorsement=${avg.toFixed(3)} (n=${values.length})`);
  }

  // Check for actual contagion
  let contagionCells = 0;
  let totalChecked = 0;
  for (const dir of dirs) {
    const dbPath = path.join(outDir, dir, "trace.db");
    if (!fs.existsSync(dbPath)) continue;
    totalChecked++;

    try {
      type StateRow = { agent_id: string; stance: string };
      const rows = queryRows<StateRow>(dbPath,
        `SELECT DISTINCT agent_id, stance FROM agent_claim_states WHERE stance = 'endorse' AND agent_id NOT LIKE 'contamination%' AND claim_id LIKE '%wrong%' OR (stance = 'endorse' AND agent_id NOT LIKE 'contamination%' AND claim_id LIKE '%false%')`
      );
      if (rows.length > 0) contagionCells++;
    } catch (e) {}
  }
  console.log(`  >> Contagion (non-contam endorsing false claim): ${contagionCells}/${totalChecked}`);
}

// Completed experiments
analyzeExperiment("contagion_chat_unfamiliar_v1", "CHAT UNFAMILIAR", 50);
analyzeExperiment("incomplete_packet", "INCOMPLETE PACKET", 75);

// Check early GSM-Hard results
analyzeExperiment("gsm_hard_contagion_v1", "GSM-HARD MEMORY (early)", 400);
analyzeExperiment("gsm_hard_chat_contagion_v1", "GSM-HARD CHAT (early)", 200);
analyzeExperiment("majority_wrong_gsm_hard_v1", "MAJORITY-WRONG GSM-HARD (early)", 200);
