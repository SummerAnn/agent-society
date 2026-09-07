// Paper-ready table output.
//
// Generates formatted tables from grid results that can go
// directly into a LaTeX paper or markdown document.

import { GRID_METRIC_METADATA, type GridResult, type ConditionSummaryRow } from "./grid";
import { compareAllPairs, type ComparisonReport, type StatTestResult } from "./stats";

function metricTitle(metric: string): string {
  return GRID_METRIC_METADATA.find((entry) => entry.key === metric)?.title
    ?? metric.replace(/([A-Z])/g, " $1").trim();
}

function betterSignForB(metric: string): string {
  const direction = GRID_METRIC_METADATA.find((entry) => entry.key === metric)?.direction;
  return direction === "lower_is_better" ? "negative" : "positive";
}

function formatInferentialValue(test: StatTestResult, value: number, digits: number): string {
  if (test.inferentialStatus !== "ok") return "n/a*";
  return value.toFixed(digits);
}

function formatSignificance(test: StatTestResult): string {
  if (test.inferentialStatus !== "ok") return "descriptive*";
  return test.significant ? "**yes**" : "no";
}

function formatEffectLabel(test: StatTestResult): string {
  if (test.inferentialStatus !== "ok") return "descriptive*";
  return test.effectMagnitude;
}

function collectInferentialNotes(reports: ComparisonReport[]): string[] {
  const notes = new Set<string>();
  for (const report of reports) {
    for (const test of report.tests) {
      if (test.caution) notes.add(test.caution);
    }
  }
  return [...notes];
}

// --- Markdown summary table ---

export function summaryTableMarkdown(gridResult: GridResult): string {
  const rows = gridResult.summaryTable;
  if (rows.length === 0) return "No results.";

  const lines: string[] = [];

  lines.push("## Experiment Results Summary");
  lines.push("");
  lines.push("| Condition | Roster | n | False Claim Endorse | Peak Endorse | Dist from Truth | Recovery | Diversity | Manip. Check |");
  lines.push("|-----------|--------|---|--------------------:|-------------:|----------------:|---------:|----------:|-------------:|");

  for (const row of rows) {
    const fcer = `${row.falseClaimEndorsementRate.mean.toFixed(3)} (${row.falseClaimEndorsementRate.std.toFixed(3)})`;
    const peak = `${row.peakFalseClaimEndorsementRate.mean.toFixed(3)} (${row.peakFalseClaimEndorsementRate.std.toFixed(3)})`;
    const dist = `${row.distanceFromGroundTruth.mean.toFixed(3)} (${row.distanceFromGroundTruth.std.toFixed(3)})`;
    const rec = `${row.recoveryAfterCorrection.mean.toFixed(3)} (${row.recoveryAfterCorrection.std.toFixed(3)})`;
    const div = `${row.diversityRetention.mean.toFixed(3)} (${row.diversityRetention.std.toFixed(3)})`;
    const manip = `${(row.manipulationCheckPassRate * 100).toFixed(0)}%`;

    lines.push(`| ${row.conditionTitle} | ${row.rosterTitle} | ${row.n} | ${fcer} | ${peak} | ${dist} | ${rec} | ${div} | ${manip} |`);
  }

  lines.push("");
  lines.push("Values shown as mean (std). n = number of runs per condition. Bounded metric confidence intervals in the JSON output are clipped to valid ranges.");
  return lines.join("\n");
}

// --- Markdown paired comparison table ---

export function pairedComparisonMarkdown(gridResult: GridResult): string {
  const reports = compareAllPairs(gridResult);
  if (reports.length === 0) return "No paired comparisons available.";

  const lines: string[] = [];
  const conditionTitles = new Map(gridResult.summaryTable.map((row) => [row.conditionId, row.conditionTitle]));
  const rosterTitles = new Map(gridResult.summaryTable.map((row) => [row.rosterId, row.rosterTitle]));

  lines.push("## Paired Comparisons (within-seed)");

  for (const report of reports) {
    lines.push("");
    lines.push(`### ${conditionTitles.get(report.conditionA) ?? report.conditionA} vs ${conditionTitles.get(report.conditionB) ?? report.conditionB} on ${rosterTitles.get(report.rosterId) ?? report.rosterId} (n=${report.nPairs} pairs)`);
    lines.push("");
    lines.push("| Metric | Delta (B - A) | Better sign for B | p (t-test) | Cohen's d | Effect | p (Wilcoxon) | Sig? |");
    lines.push("|--------|--------------:|-------------------|-----------:|----------:|--------|-------------:|------|");

    for (const test of report.tests) {
      const sig = formatSignificance(test);
      const delta = `${test.meanDelta >= 0 ? "+" : ""}${test.meanDelta.toFixed(3)}`;
      const metric = metricTitle(test.metric);

      lines.push(
        `| ${metric} | ${delta} | ${betterSignForB(test.metric)} | ${formatInferentialValue(test, test.pValue, 3)} | ${formatInferentialValue(test, test.cohensD, 2)} | ${formatEffectLabel(test)} | ${formatInferentialValue(test, test.wilcoxonP, 3)} | ${sig} |`,
      );
    }

    lines.push("");
    lines.push("**Conclusions:**");
    for (const conclusion of report.conclusions) {
      lines.push(`- ${conclusion}`);
    }
  }

  const notes = collectInferentialNotes(reports);
  if (notes.length > 0) {
    lines.push("");
    lines.push("*Inferential stats marked `n/a*` or `descriptive*` are intentionally suppressed.*");
    for (const note of notes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push("");
  lines.push("*Delta is always condition B minus condition A. For lower-is-better metrics, a negative delta favors condition B.*");

  return lines.join("\n");
}

// --- LaTeX summary table ---

export function summaryTableLatex(gridResult: GridResult): string {
  const rows = gridResult.summaryTable;
  if (rows.length === 0) return "% No results.";

  const lines: string[] = [];

  lines.push("\\begin{table}[htbp]");
  lines.push("\\centering");
  lines.push("\\caption{Experiment results across conditions. Values shown as mean $\\pm$ std.}");
  lines.push("\\label{tab:results}");
  lines.push("\\begin{tabular}{llcccccc}");
  lines.push("\\toprule");
  lines.push("Condition & Roster & $n$ & FCE Rate & Peak FCE & Dist. Truth & Recovery & Diversity \\\\");
  lines.push("\\midrule");

  for (const row of rows) {
    const id = row.conditionTitle.replace(/_/g, "\\_");
    const fcer = `${row.falseClaimEndorsementRate.mean.toFixed(3)} \\pm ${row.falseClaimEndorsementRate.std.toFixed(3)}`;
    const peak = `${row.peakFalseClaimEndorsementRate.mean.toFixed(3)} \\pm ${row.peakFalseClaimEndorsementRate.std.toFixed(3)}`;
    const dist = `${row.distanceFromGroundTruth.mean.toFixed(3)} \\pm ${row.distanceFromGroundTruth.std.toFixed(3)}`;
    const rec = `${row.recoveryAfterCorrection.mean.toFixed(3)} \\pm ${row.recoveryAfterCorrection.std.toFixed(3)}`;
    const div = `${row.diversityRetention.mean.toFixed(3)} \\pm ${row.diversityRetention.std.toFixed(3)}`;

    const roster = row.rosterTitle.replace(/_/g, "\\_");
    lines.push(`${id} & ${roster} & ${row.n} & $${fcer}$ & $${peak}$ & $${dist}$ & $${rec}$ & $${div}$ \\\\`);
  }

  lines.push("\\bottomrule");
  lines.push("\\end{tabular}");
  lines.push("\\end{table}");

  return lines.join("\n");
}

// --- LaTeX paired comparison table ---

export function pairedComparisonLatex(gridResult: GridResult): string {
  const reports = compareAllPairs(gridResult);
  if (reports.length === 0) return "% No paired comparisons.";

  const lines: string[] = [];
  const conditionTitles = new Map(gridResult.summaryTable.map((row) => [row.conditionId, row.conditionTitle]));
  const rosterTitles = new Map(gridResult.summaryTable.map((row) => [row.rosterId, row.rosterTitle]));

  lines.push("\\begin{table}[htbp]");
  lines.push("\\centering");
  lines.push("\\caption{Paired within-seed comparisons between conditions.}");
  lines.push("\\label{tab:paired}");
  lines.push("\\begin{tabular}{llccccc}");
  lines.push("\\toprule");
  lines.push("Comparison & Metric & $\\Delta$ & $p$ & Cohen's $d$ & Effect & Sig. \\\\");
  lines.push("\\midrule");

  for (const report of reports) {
    const comp = `${(conditionTitles.get(report.conditionA) ?? report.conditionA).replace(/_/g, "\\_")} vs ${(conditionTitles.get(report.conditionB) ?? report.conditionB).replace(/_/g, "\\_")}`;
    const roster = (rosterTitles.get(report.rosterId) ?? report.rosterId).replace(/_/g, "\\_");
    let first = true;

    for (const test of report.tests) {
      const label = first ? `${comp} (${roster})` : "";
      first = false;

      const metric = metricTitle(test.metric);
      const delta = `${test.meanDelta >= 0 ? "+" : ""}${test.meanDelta.toFixed(3)}`;
      const sig = test.inferentialStatus === "ok" ? (test.significant ? "\\checkmark" : "") : "\\textit{desc.}";
      const pValue = test.inferentialStatus === "ok" ? `$${test.pValue.toFixed(3)}$` : "\\textit{n/a}";
      const cohensD = test.inferentialStatus === "ok" ? `$${test.cohensD.toFixed(2)}$` : "\\textit{n/a}";
      const effect = test.inferentialStatus === "ok" ? test.effectMagnitude : "\\textit{desc.}";

      lines.push(
        `${label} & ${metric} & $${delta}$ & ${pValue} & ${cohensD} & ${effect} & ${sig} \\\\`,
      );
    }
    lines.push("\\midrule");
  }

  // Remove last midrule
  lines[lines.length - 1] = "\\bottomrule";
  lines.push("\\end{tabular}");
  const notes = collectInferentialNotes(reports);
  if (notes.length > 0) {
    lines.push("\\\\[2pt]");
    lines.push("\\par\\footnotesize Inferential entries marked as \\textit{n/a} or \\textit{desc.} are descriptive-only summaries.");
  }
  lines.push("\\end{table}");

  return lines.join("\n");
}

// --- Combined output ---

export function generatePaperTables(
  gridResult: GridResult,
  format: "markdown" | "latex" = "markdown",
): string {
  if (format === "latex") {
    return [
      summaryTableLatex(gridResult),
      "",
      pairedComparisonLatex(gridResult),
    ].join("\n");
  }

  return [
    summaryTableMarkdown(gridResult),
    "",
    pairedComparisonMarkdown(gridResult),
  ].join("\n");
}
