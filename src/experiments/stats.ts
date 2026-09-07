// Statistical testing for paired experiment comparisons.
//
// Provides the tests a reviewer will ask for:
//   - Paired t-test (parametric)
//   - Wilcoxon signed-rank test (non-parametric, better for small n)
//   - Cohen's d effect size
//   - 95% confidence intervals
//
// All tests are within-seed paired: condition A seed 1 vs condition B seed 1,
// condition A seed 2 vs condition B seed 2, etc. This controls for
// random variation across seeds.

import type { PairedComparison, GridResult } from "./grid";

// --- Types ---

export type StatTestResult = {
  testName: string;
  conditionA: string;
  conditionB: string;
  metric: string;
  n: number; // number of paired observations
  meanDelta: number; // mean of (B - A)
  stdDelta: number;
  // Paired t-test
  tStatistic: number;
  pValue: number;
  significant: boolean; // p < 0.05
  // Effect size
  cohensD: number;
  effectMagnitude: "negligible" | "small" | "medium" | "large";
  // Confidence interval on the difference
  ci95: [number, number];
  // Non-parametric
  wilcoxonW: number;
  wilcoxonP: number;
  wilcoxonSignificant: boolean;
  inferentialStatus: "ok" | "too_few_pairs" | "degenerate_deltas";
  caution: string | null;
};

export type ComparisonReport = {
  rosterId: string;
  conditionA: string;
  conditionB: string;
  nPairs: number;
  tests: StatTestResult[];
  // One-sentence conclusion per metric
  conclusions: string[];
};

// --- Main comparison function ---

export function comparePaired(
  gridResult: GridResult,
  rosterId: string,
  conditionA: string,
  conditionB: string,
): ComparisonReport {
  const pairs = gridResult.pairings.filter(
    (p) =>
      p.rosterId === rosterId &&
      (
        (p.conditionA === conditionA && p.conditionB === conditionB) ||
        (p.conditionA === conditionB && p.conditionB === conditionA)
      ),
  );

  if (pairs.length === 0) {
    return {
      rosterId,
      conditionA,
      conditionB,
      nPairs: 0,
      tests: [],
      conclusions: ["No paired data found for these conditions."],
    };
  }

  // Normalize direction: always B - A
  const normalizedPairs = pairs.map((p) => {
    if (p.conditionA === conditionA) return p;
    // Flip
    return {
      ...p,
      conditionA,
      conditionB,
      metricDeltas: {
        falseClaimEndorsementRate: -p.metricDeltas.falseClaimEndorsementRate,
        peakFalseClaimEndorsementRate: -p.metricDeltas.peakFalseClaimEndorsementRate,
        distanceFromGroundTruth: -p.metricDeltas.distanceFromGroundTruth,
        recoveryAfterCorrection: -p.metricDeltas.recoveryAfterCorrection,
        diversityRetention: -p.metricDeltas.diversityRetention,
      },
    };
  });

  const metrics = [
    "falseClaimEndorsementRate",
    "peakFalseClaimEndorsementRate",
    "distanceFromGroundTruth",
    "recoveryAfterCorrection",
    "diversityRetention",
  ] as const;

  const tests: StatTestResult[] = [];
  const conclusions: string[] = [];

  for (const metric of metrics) {
    const deltas = normalizedPairs.map((p) => p.metricDeltas[metric]);
    const result = runPairedTest(conditionA, conditionB, metric, deltas);
    tests.push(result);
    conclusions.push(summarize(result));
  }

  return {
    rosterId,
    conditionA,
    conditionB,
    nPairs: normalizedPairs.length,
    tests,
    conclusions,
  };
}

// --- Compare all condition pairs ---

export function compareAllPairs(gridResult: GridResult): ComparisonReport[] {
  const rosterIds = [...new Set(gridResult.cells.map((c) => c.rosterId))];
  const reports: ComparisonReport[] = [];

  for (const rosterId of rosterIds) {
    const conditionIds = [...new Set(gridResult.cells.filter((c) => c.rosterId === rosterId).map((c) => c.conditionId))];
    for (let a = 0; a < conditionIds.length; a++) {
      for (let b = a + 1; b < conditionIds.length; b++) {
        reports.push(comparePaired(gridResult, rosterId, conditionIds[a], conditionIds[b]));
      }
    }
  }

  return reports;
}

// --- Paired t-test ---

function runPairedTest(
  conditionA: string,
  conditionB: string,
  metric: string,
  deltas: number[],
): StatTestResult {
  const minPairsForInference = 5;
  const varianceEpsilon = 1e-9;
  const n = deltas.length;
  const meanDelta = mean(deltas);
  const stdDelta = sd(deltas);
  const enoughPairs = n >= minPairsForInference;
  const stableVariance = stdDelta > varianceEpsilon;

  let inferentialStatus: StatTestResult["inferentialStatus"] = "ok";
  let caution: string | null = null;
  if (!enoughPairs) {
    inferentialStatus = "too_few_pairs";
    caution = `Descriptive only: n=${n} paired runs is below the minimum of ${minPairsForInference} for significance reporting.`;
  } else if (!stableVariance) {
    inferentialStatus = "degenerate_deltas";
    caution = "Descriptive only: paired deltas are effectively identical, so inferential statistics are suppressed.";
  }

  // t-statistic
  const se = stdDelta / Math.sqrt(n);
  const tStatistic = inferentialStatus === "ok" && se > 0 ? meanDelta / se : 0;
  const df = n - 1;
  const pValue = inferentialStatus === "ok" ? twoTailedP(tStatistic, df) : 1;

  // Cohen's d (paired)
  const cohensD = inferentialStatus === "ok" ? meanDelta / stdDelta : 0;
  const effectMagnitude = categorizeEffect(Math.abs(cohensD));

  // 95% CI
  const tCrit = n >= 2 ? tCriticalValue(df) : 1.96;
  const ci95: [number, number] = [meanDelta - tCrit * se, meanDelta + tCrit * se];

  // Wilcoxon signed-rank
  const { W, p: wilcoxonP } = inferentialStatus === "ok"
    ? wilcoxonSignedRank(deltas)
    : { W: 0, p: 1 };

  return {
    testName: "paired_t_test",
    conditionA,
    conditionB,
    metric,
    n,
    meanDelta,
    stdDelta,
    tStatistic,
    pValue,
    significant: inferentialStatus === "ok" && pValue < 0.05,
    cohensD,
    effectMagnitude,
    ci95,
    wilcoxonW: W,
    wilcoxonP,
    wilcoxonSignificant: inferentialStatus === "ok" && wilcoxonP < 0.05,
    inferentialStatus,
    caution,
  };
}

// --- Wilcoxon signed-rank test ---

function wilcoxonSignedRank(deltas: number[]): { W: number; p: number } {
  // Remove zeros
  const nonZero = deltas.filter((d) => d !== 0);
  const n = nonZero.length;

  if (n < 5) return { W: 0, p: 1 }; // Too few observations

  // Rank absolute values
  const ranked = nonZero
    .map((d, i) => ({ value: d, abs: Math.abs(d), index: i }))
    .sort((a, b) => a.abs - b.abs)
    .map((item, rank) => ({ ...item, rank: rank + 1 }));

  // Handle ties by averaging ranks
  for (let i = 0; i < ranked.length; ) {
    let j = i;
    while (j < ranked.length && ranked[j].abs === ranked[i].abs) j++;
    if (j > i + 1) {
      const avgRank = (ranked[i].rank + ranked[j - 1].rank) / 2;
      for (let k = i; k < j; k++) ranked[k].rank = avgRank;
    }
    i = j;
  }

  // Sum positive and negative ranks
  const Wplus = ranked.filter((r) => nonZero[r.index] > 0).reduce((s, r) => s + r.rank, 0);
  const Wminus = ranked.filter((r) => nonZero[r.index] < 0).reduce((s, r) => s + r.rank, 0);
  const W = Math.min(Wplus, Wminus);

  // Normal approximation for p-value (valid for n >= 10, approximate for smaller)
  const expectedW = n * (n + 1) / 4;
  const varW = n * (n + 1) * (2 * n + 1) / 24;
  const z = (W - expectedW) / Math.sqrt(varW);
  const p = 2 * normalCDF(-Math.abs(z));

  return { W, p };
}

// --- Summary sentence ---

function summarize(result: StatTestResult): string {
  const dir = result.meanDelta > 0 ? "higher" : "lower";
  const metric = result.metric.replace(/([A-Z])/g, " $1").toLowerCase().trim();

  if (result.inferentialStatus !== "ok") {
    return `${result.conditionB} had ${dir} ${metric} than ${result.conditionA} ` +
      `(delta=${result.meanDelta.toFixed(3)}, descriptive only, n=${result.n}).`;
  }

  const sig = result.significant ? "significantly" : "not significantly";
  const effect = result.effectMagnitude;

  return `${result.conditionB} had ${dir} ${metric} than ${result.conditionA} ` +
    `(delta=${result.meanDelta.toFixed(3)}, ${sig}, p=${result.pValue.toFixed(3)}, ` +
    `d=${result.cohensD.toFixed(2)} [${effect}], n=${result.n})`;
}

// --- Helpers ---

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sd(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

function categorizeEffect(d: number): "negligible" | "small" | "medium" | "large" {
  if (d < 0.2) return "negligible";
  if (d < 0.5) return "small";
  if (d < 0.8) return "medium";
  return "large";
}

// Approximate t critical values (two-tailed, alpha=0.05)
function tCriticalValue(df: number): number {
  const table: Record<number, number> = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
    6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
    11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
    20: 2.086, 25: 2.060, 30: 2.042, 40: 2.021, 60: 2.000,
    120: 1.980,
  };
  if (table[df]) return table[df];
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
  for (const k of keys) {
    if (k >= df) return table[k];
  }
  return 1.96;
}

// Two-tailed p-value from t-statistic (approximation using normal for large df)
function twoTailedP(t: number, df: number): number {
  // For df > 30, t ≈ normal
  if (df > 30) return 2 * normalCDF(-Math.abs(t));

  // Beta incomplete function approximation for t-distribution
  const x = df / (df + t * t);
  const a = df / 2;
  const b = 0.5;
  const betaI = incompleteBeta(x, a, b);
  return betaI;
}

// Standard normal CDF (Abramowitz & Stegun approximation)
function normalCDF(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  const absZ = Math.abs(z);
  const t = 1 / (1 + p * absZ);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absZ * absZ / 2);

  return 0.5 * (1 + sign * y);
}

// Regularized incomplete beta function (simple series expansion)
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Use continued fraction for better convergence
  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta);

  // Lentz's algorithm for continued fraction
  let f = 1;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  f = d;

  for (let m = 1; m <= 100; m++) {
    // Even step
    let numerator = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    f *= d * c;

    // Odd step
    numerator = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const delta = d * c;
    f *= delta;

    if (Math.abs(delta - 1) < 1e-8) break;
  }

  return front * f / a;
}

// Log gamma (Stirling approximation)
function lnGamma(z: number): number {
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  z -= 1;
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.001208650973866179, -0.000005395239384953,
  ];
  let x = 1.000000000190015;
  for (let i = 0; i < coefficients.length; i++) {
    x += coefficients[i] / (z + i + 1);
  }
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
