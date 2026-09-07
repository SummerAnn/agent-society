/**
 * Analyze all completed experiments — false endorsement, contagion check, soft influence.
 */
import fs from "fs";
import path from "path";
import { queryRows } from "../src/db/sqlite";

const outDir = "output";

function analyze(gridPattern: string, label: string) {
  const gridFile = `output/${gridPattern}-grid-results.json`;

  // Try grid results first
  if (fs.existsSync(gridFile)) {
    const data = JSON.parse(fs.readFileSync(gridFile, "utf8"));
    const cells = data.cells || [];

    console.log(`\n${"=".repeat(65)}`);
    console.log(`  ${label} (${cells.length} cells) — from grid-results`);
    console.log(`${"=".repeat(65)}`);

    // Group by roster+condition
    const groups: Record<string, any[]> = {};
    for (const c of cells) {
      const key = `${c.rosterId} | ${c.conditionId}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    }

    for (const [key, group] of Object.entries(groups)) {
      const avgFe = group.reduce((a: number, c: any) => a + (c.summary?.falseClaimEndorsementRate || 0), 0) / group.length;
      const avgTd = group.reduce((a: number, c: any) => a + (c.summary?.truthDistance || 0), 0) / group.length;
      const avgRec = group.reduce((a: number, c: any) => a + (c.summary?.recoveryAfterCorrection || 0), 0) / group.length;
      console.log(`  ${key}`);
      console.log(`    false_endorsement=${avgFe.toFixed(3)}  truth_dist=${avgTd.toFixed(3)}  recovery=${avgRec.toFixed(3)}  (n=${group.length})`);
    }

    // Contagion check
    let contagionCells = 0;
    let checked = 0;
    for (const c of cells) {
      const dbPath = c.summary?.dbPath;
      if (!dbPath || !fs.existsSync(dbPath)) continue;
      checked++;
      try {
        type Row = { agent_id: string };
        // Check for non-contam agents endorsing ANY false claim
        const rows = queryRows<Row>(dbPath,
          `SELECT DISTINCT acs.agent_id FROM agent_claim_states acs
           JOIN (SELECT id, truthLabel FROM (VALUES ('claim_wrong_answer','false'),('claim_ego_depletion','false'),('claim_mmr_causes_autism','false'),('claim_natural_cycles','false'),('claim_rts_valid','false'),('claim_glucose_mechanism','false'),('claim_meta_analysis_valid','false')) AS t(id, truthLabel)) fc ON acs.claim_id = fc.id
           WHERE acs.stance = 'endorse' AND acs.agent_id NOT LIKE 'contamination%'`
        );
        if (rows.length > 0) contagionCells++;
      } catch(e) {}
    }
    console.log(`\n  Contagion (non-contam endorsing false): ${contagionCells}/${checked}`);
    return;
  }

  // Fall back to scanning output dirs
  const dirs = fs.readdirSync(outDir).filter(d => d.startsWith(gridPattern));
  if (dirs.length === 0) return;

  console.log(`\n${"=".repeat(65)}`);
  console.log(`  ${label} (${dirs.length} cells) — from output dirs`);
  console.log(`${"=".repeat(65)}`);

  let totalFe = 0;
  let count = 0;
  for (const dir of dirs) {
    const sp = path.join(outDir, dir, "summary.json");
    if (!fs.existsSync(sp)) continue;
    const s = JSON.parse(fs.readFileSync(sp, "utf8"));
    totalFe += s.falseClaimEndorsementRate || 0;
    count++;
  }
  if (count > 0) {
    console.log(`  Avg false endorsement: ${(totalFe/count).toFixed(3)} (n=${count})`);
  }
}

// Completed experiments with grid results
analyze("rerun_noisy_verification_source_exit_v3", "NOISY VERIFICATION + EXIT");
analyze("rerun_chat_star_correction_v3", "CHAT STAR + CORRECTION");

// Completed experiments without grid results yet
analyze("contagion_chat_unfamiliar_v1", "CHAT UNFAMILIAR (unfamiliar tasks)");
analyze("incomplete_packet", "INCOMPLETE PACKET");
analyze("source_exit_no_counter_evidence_v1", "NO-COUNTER-EVIDENCE + EXIT");
analyze("corrector_exit", "CORRECTOR EXIT");

// Nearly done
analyze("multi_exit_contagion_v1", "MULTI-EXIT (3 agents leave)");
analyze("mitigation_evidence_board", "EVIDENCE BOARD + EXIT (mitigation)");

// Early GSM-Hard results
analyze("majority_wrong_gsm_hard_v1", "MAJORITY-WRONG GSM-HARD (early)");
analyze("gsm_hard_chat_contagion_v1", "GSM-HARD CHAT (early)");
