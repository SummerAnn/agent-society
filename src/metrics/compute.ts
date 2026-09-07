import type { BeliefStateRecord, Scenario, StanceLabel, StepMetrics } from "../config/schema";

function stanceToDistributionIndex(stance: StanceLabel): number {
  if (stance === "endorse") return 0;
  if (stance === "reject") return 1;
  return 2;
}

function truthMismatch(truthLabel: string, stance: StanceLabel): number {
  if (truthLabel === "mixed") {
    return stance === "uncertain" ? 0 : 0.5;
  }
  if (truthLabel === "true") {
    if (stance === "endorse") return 0;
    if (stance === "uncertain") return 0.5;
    return 1;
  }
  if (stance === "reject") return 0;
  if (stance === "uncertain") return 0.5;
  return 1;
}

export function computeStepMetrics(
  runId: string,
  step: number,
  states: BeliefStateRecord[],
  scenario: Scenario,
): StepMetrics {
  const focusStates = states.filter((state) => state.claimId === scenario.focusClaimId);
  const endorseCount = focusStates.filter((state) => state.stance === "endorse").length;
  const rejectCount = focusStates.filter((state) => state.stance === "reject").length;
  const uncertainCount = focusStates.filter((state) => state.stance === "uncertain").length;
  const totalFocus = focusStates.length || 1;
  const endorseShare = endorseCount / totalFocus;
  const rejectShare = rejectCount / totalFocus;
  const uncertainShare = uncertainCount / totalFocus;
  const confidenceWeightedFalseEndorsement = focusStates.reduce(
    (sum, state) => sum + (state.stance === "endorse" ? state.confidence : 0),
    0,
  ) / totalFocus;

  const mismatchSum = states.reduce(
    (sum, state) => sum + truthMismatch(state.truthLabel, state.stance),
    0,
  );
  const distanceFromGroundTruth = mismatchSum / Math.max(1, states.length);

  const distribution = [0, 0, 0];
  for (const state of focusStates) {
    distribution[stanceToDistributionIndex(state.stance)] += 1;
  }
  const entropy = distribution.reduce((sum, count) => {
    if (count === 0) return sum;
    const p = count / totalFocus;
    return sum - p * Math.log2(p);
  }, 0);
  const maxEntropy = Math.log2(3);
  const ranked = [
    { stance: "endorse" as const, share: endorseShare },
    { stance: "reject" as const, share: rejectShare },
    { stance: "uncertain" as const, share: uncertainShare },
  ].sort((a, b) => b.share - a.share);
  const meanConfidence = focusStates.reduce((sum, state) => sum + state.confidence, 0) / totalFocus;

  return {
    runId,
    step,
    focusAgentCount: focusStates.length,
    falseClaimEndorsementRate: endorseShare,
    confidenceWeightedFalseEndorsement,
    falseClaimRejectRate: rejectShare,
    uncertainRate: uncertainShare,
    distanceFromGroundTruth,
    diversityRetention: maxEntropy === 0 ? 0 : entropy / maxEntropy,
    endorseShare,
    rejectShare,
    uncertainShare,
    majorityStance: ranked[0]?.stance ?? "uncertain",
    consensusStrength: ranked[0]?.share ?? 0,
    majorityMargin: (ranked[0]?.share ?? 0) - (ranked[1]?.share ?? 0),
    netEndorsement: endorseShare - rejectShare,
    meanConfidence,
    disagreementLevel: 1 - (ranked[0]?.share ?? 0),
  };
}

export function computeTimeToMajorityAdoption(metrics: StepMetrics[]): number | null {
  const hit = metrics.find((metric) => metric.falseClaimEndorsementRate > 0.5);
  return hit ? hit.step : null;
}

export function computeRecoveryAfterCorrection(
  metrics: StepMetrics[],
  correctionStep: number | null,
): number {
  if (!correctionStep) {
    return 0;
  }
  const beforeCorrection =
    [...metrics]
      .reverse()
      .find((metric) => metric.step < correctionStep)?.falseClaimEndorsementRate ?? 0;
  const finalRate = metrics.at(-1)?.falseClaimEndorsementRate ?? 0;
  return beforeCorrection - finalRate;
}

export function computePostCorrectionPersistence(
  metrics: StepMetrics[],
  correctionStep: number | null,
): number {
  if (!correctionStep) {
    return 0;
  }
  const postCorrection = metrics.filter((metric) => metric.step >= correctionStep);
  if (postCorrection.length === 0) {
    return 0;
  }
  return postCorrection.reduce((sum, metric) => sum + metric.confidenceWeightedFalseEndorsement, 0) / postCorrection.length;
}
