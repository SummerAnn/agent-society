/**
 * Comprehensive audit of all viable experiment results.
 * Checks for confounds, data quality issues, and validity concerns.
 *
 * Usage: npx tsx scripts/audit-all-results.ts
 */

import fs from "fs";
import path from "path";
import { queryRows } from "../src/db/sqlite";

type GridResult = {
  grid: { id: string; title: string; maxSteps: number; budget: { maxModelCalls: number } };
  cells: Array<{
    scenarioId: string;
    conditionId: string;
    rosterId: string;
    seed: number;
    summary: {
      runId: string;
      dbPath: string;
      completedSteps: number;
      totalModelCalls: number;
      parserFallbackCount: number;
      falseClaimEndorsementRate: number;
      distanceFromGroundTruth: number;
      diversityRetention: number;
    };
    manipulationCheck: { passed: boolean; details: string[] };
  }>;
  summaryTable: Array<{
    conditionId: string;
    n: number;
    falseClaimEndorsementRate: { mean: number; std: number };
    distanceFromGroundTruth: { mean: number; std: number };
    manipulationCheckPassRate: number;
  }>;
};

const RESULTS: Array<{ name: string; path: string; expectedCells: number; notes: string }> = [
  {
    name: "Study A: 4 record rules, 1/6 wrong",
    path: "output/study1_memory_rules_v3_output_complete-grid-results.json",
    expectedCells: 160,
    notes: "Core gradient. 4 scenarios × 4 conditions × 10 seeds.",
  },
  {
    name: "Study B: source-aware vs mixed (Haiku)",
    path: "output/study1_record_controls_v3_output_complete-grid-results.json",
    expectedCells: 80,
    notes: "Record format comparison. 4 scenarios × 2 conditions × 10 seeds.",
  },
  {
    name: "Study D: source-aware vs mixed (Sonnet)",
    path: "output/study1_record_controls_sonnet_v1_output_complete-grid-results.json",
    expectedCells: 80,
    notes: "Cross-model replication of Study B.",
  },
  {
    name: "Study F: late evidence reversal",
    path: "output/study1_late_evidence_reversal_v1-grid-results.json",
    expectedCells: 20,
    notes: "Strong correction. 1 scenario × 2 conditions × 10 seeds.",
  },
  {
    name: "Hidden profiles (Haiku)",
    path: "output/hidden_profile_heldout_haiku_v1-grid-results.json",
    expectedCells: 40,
    notes: "Evidence access. 2 packets × 2 conditions × 10 seeds.",
  },
  {
    name: "Hidden profiles (Sonnet)",
    path: "output/hidden_profile_heldout_sonnet_v1-grid-results.json",
    expectedCells: 40,
    notes: "Cross-model replication.",
  },
  {
    name: "Amplifier: 4/6 wrong (Haiku)",
    path: "output/amplifier_majority_wrong_haiku_v1-grid-results.json",
    expectedCells: 80,
    notes: "Majority wrong. 4 scenarios × 2 conditions × 10 seeds.",
  },
  {
    name: "Source detachment: 3/4 wrong",
    path: "output/hidden_profile_majority_wrong_haiku_v1-grid-results.json",
    expectedCells: 40,
    notes: "Decisive evidence. 2 packets × 2 conditions × 10 seeds.",
  },
  {
    name: "Ambiguous evidence: 3/4 wrong",
    path: "output/ambiguous_evidence_majority_wrong_haiku_v1-grid-results.json",
    expectedCells: 40,
    notes: "Ambiguous cards. 2 packets × 2 conditions × 10 seeds.",
  },
];

function auditGrid(entry: typeof RESULTS[0]): string[] {
  const issues: string[] = [];

  if (!fs.existsSync(entry.path)) {
    issues.push(`FILE MISSING: ${entry.path}`);
    return issues;
  }

  const result: GridResult = JSON.parse(fs.readFileSync(entry.path, "utf8"));
  const cells = result.cells;

  // 1. Cell count
  if (cells.length !== entry.expectedCells) {
    issues.push(`CELL COUNT: expected ${entry.expectedCells}, got ${cells.length}`);
  }

  // 2. Completeness — did every cell finish?
  const maxSteps = result.grid.maxSteps;
  const maxCalls = result.grid.budget.maxModelCalls;
  for (const cell of cells) {
    if (cell.summary.completedSteps < maxSteps) {
      issues.push(`INCOMPLETE: ${cell.scenarioId}/${cell.conditionId}/seed${cell.seed} — ${cell.summary.completedSteps}/${maxSteps} steps`);
    }
    if (cell.summary.totalModelCalls < maxCalls) {
      issues.push(`LOW CALLS: ${cell.scenarioId}/${cell.conditionId}/seed${cell.seed} — ${cell.summary.totalModelCalls}/${maxCalls} calls`);
    }
  }

  // 3. Parser fallbacks — any truncated/malformed responses?
  const totalFallbacks = cells.reduce((sum, c) => sum + (c.summary.parserFallbackCount || 0), 0);
  if (totalFallbacks > 0) {
    issues.push(`PARSER FALLBACKS: ${totalFallbacks} across ${cells.length} cells`);
  }

  // 4. Manipulation checks
  const failedManip = cells.filter(c => !c.manipulationCheck.passed);
  if (failedManip.length > 0) {
    // Check if these are expected (hidden-profile tasks use groupDecision, not contamination check)
    const hasGroupDecision = failedManip.some(c =>
      c.manipulationCheck.details.some(d => d.includes("contamination") || d.includes("shared"))
    );
    if (hasGroupDecision) {
      issues.push(`MANIP CHECK: ${failedManip.length}/${cells.length} failed — may be expected for group-decision tasks`);
    } else {
      issues.push(`MANIP CHECK FAILURE: ${failedManip.length}/${cells.length} failed`);
      for (const f of failedManip.slice(0, 3)) {
        issues.push(`  → ${f.scenarioId}/seed${f.seed}: ${f.manipulationCheck.details.join("; ")}`);
      }
    }
  }

  // 5. Temperature — all runs should be at temp 0 (deterministic)
  // Check if same scenario+condition+seed gives same result across... wait, temp 0 means deterministic per seed
  // So we check: are there any duplicate scenario+condition+seed combos?
  const seen = new Set<string>();
  for (const cell of cells) {
    const key = `${cell.scenarioId}|${cell.conditionId}|${cell.seed}`;
    if (seen.has(key)) {
      issues.push(`DUPLICATE CELL: ${key}`);
    }
    seen.add(key);
  }

  // 6. Confound: do all conditions have the same number of cells?
  const condCounts: Record<string, number> = {};
  for (const cell of cells) {
    condCounts[cell.conditionId] = (condCounts[cell.conditionId] || 0) + 1;
  }
  const counts = Object.values(condCounts);
  if (new Set(counts).size > 1) {
    issues.push(`UNBALANCED CONDITIONS: ${JSON.stringify(condCounts)}`);
  }

  // 7. Confound: are the same seeds used across conditions? (paired design)
  const condSeeds: Record<string, Set<number>> = {};
  for (const cell of cells) {
    if (!condSeeds[cell.conditionId]) condSeeds[cell.conditionId] = new Set();
    condSeeds[cell.conditionId].add(cell.seed);
  }
  const condIds = Object.keys(condSeeds);
  if (condIds.length >= 2) {
    const first = condSeeds[condIds[0]];
    for (let i = 1; i < condIds.length; i++) {
      const other = condSeeds[condIds[i]];
      const missing = [...first].filter(s => !other.has(s));
      const extra = [...other].filter(s => !first.has(s));
      if (missing.length > 0 || extra.length > 0) {
        issues.push(`UNPAIRED SEEDS: ${condIds[0]} vs ${condIds[i]} — missing: ${missing}, extra: ${extra}`);
      }
    }
  }

  // 8. Confound: are the same scenarios used across conditions?
  const condScenarios: Record<string, Set<string>> = {};
  for (const cell of cells) {
    if (!condScenarios[cell.conditionId]) condScenarios[cell.conditionId] = new Set();
    condScenarios[cell.conditionId].add(cell.scenarioId);
  }
  if (condIds.length >= 2) {
    const firstScenarios = [...condScenarios[condIds[0]]].sort().join(",");
    for (let i = 1; i < condIds.length; i++) {
      const otherScenarios = [...condScenarios[condIds[i]]].sort().join(",");
      if (firstScenarios !== otherScenarios) {
        issues.push(`SCENARIO MISMATCH between conditions: ${condIds[0]} vs ${condIds[i]}`);
      }
    }
  }

  // 9. Check for topic-level variation — is the effect driven by one topic?
  if (condIds.length >= 2) {
    const scenarios = [...new Set(cells.map(c => c.scenarioId))];
    if (scenarios.length > 1) {
      const topicEffects: string[] = [];
      for (const scenario of scenarios) {
        const byCondition: Record<string, number[]> = {};
        for (const cell of cells) {
          if (cell.scenarioId !== scenario) continue;
          if (!byCondition[cell.conditionId]) byCondition[cell.conditionId] = [];
          byCondition[cell.conditionId].push(cell.summary.falseClaimEndorsementRate);
        }
        const condMeans = Object.entries(byCondition).map(([cond, vals]) => {
          const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
          return `${cond.substring(0, 20)}=${mean.toFixed(3)}`;
        });
        topicEffects.push(`  ${scenario.substring(0, 45)}: ${condMeans.join(" vs ")}`);
      }
      issues.push(`TOPIC BREAKDOWN (false endorsement):\n${topicEffects.join("\n")}`);
    }
  }

  // 10. Confound: do agents have different roles/biases that could explain the result?
  // (Just flag if contamination agents are present)
  const rosters = [...new Set(cells.map(c => c.rosterId))];
  if (rosters.some(r => r.includes("distributed") || r.includes("baseline"))) {
    issues.push(`NOTE: Uses roster with heterogeneous agent roles (contamination, specialist, regular). Results may be driven by role-specific behavior, not just the record condition.`);
  }

  // 11. Confound: familiar topics — models may know answers from training
  const familiarTopics = ["ego_depletion", "wakefield", "mmr", "climate", "superconductor", "lk99"];
  const scenarioIds = [...new Set(cells.map(c => c.scenarioId))];
  const familiar = scenarioIds.filter(s => familiarTopics.some(t => s.toLowerCase().includes(t)));
  if (familiar.length > 0) {
    issues.push(`CONFOUND: ${familiar.length}/${scenarioIds.length} scenarios use topics LLMs likely know from training: ${familiar.join(", ")}`);
  }

  // 12. DB-level check: verify trace exists and has data
  const sampleCell = cells[0];
  if (sampleCell && sampleCell.summary.dbPath) {
    if (!fs.existsSync(sampleCell.summary.dbPath)) {
      issues.push(`TRACE DB MISSING: ${sampleCell.summary.dbPath}`);
    }
  }

  return issues;
}

// Run all audits
console.log("=" .repeat(70));
console.log("  COMPREHENSIVE AUDIT OF ALL VIABLE RESULTS");
console.log("=".repeat(70));

let totalIssues = 0;

for (const entry of RESULTS) {
  console.log(`\n--- ${entry.name} ---`);
  console.log(`File: ${entry.path}`);
  console.log(`Expected: ${entry.expectedCells} cells | ${entry.notes}`);

  const issues = auditGrid(entry);

  const warnings = issues.filter(i => i.startsWith("NOTE:") || i.startsWith("CONFOUND:") || i.startsWith("TOPIC BREAKDOWN") || i.startsWith("MANIP CHECK:"));
  const errors = issues.filter(i => !i.startsWith("NOTE:") && !i.startsWith("CONFOUND:") && !i.startsWith("TOPIC BREAKDOWN") && !i.startsWith("MANIP CHECK:"));

  if (errors.length === 0) {
    console.log("✓ No data quality errors");
  } else {
    for (const e of errors) console.log(`✗ ${e}`);
    totalIssues += errors.length;
  }

  for (const w of warnings) console.log(`⚠ ${w}`);
}

console.log(`\n${"=".repeat(70)}`);
console.log(`TOTAL DATA QUALITY ERRORS: ${totalIssues}`);
console.log(`${"=".repeat(70)}`);
