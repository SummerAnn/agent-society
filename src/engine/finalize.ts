import type { RunSummary, Scenario, StepMetrics } from "../config/schema";
import { insertRow, writeSummaryJson } from "../db/sqlite";
import {
  computePostCorrectionPersistence,
  computeRecoveryAfterCorrection,
  computeTimeToMajorityAdoption,
} from "../metrics/compute";
import type { PhysicsReport } from "../physics/analyze";
import type { RunConfig } from "../config/schema";
import type { Condition } from "../config/schema";
import { queryRows } from "../db/sqlite";
import { evaluateFinalDecisionRetrievalSupport } from "../experiments/sourceDetachment";

type OpenDiscussionEvaluation = NonNullable<RunSummary["evaluation"]>;

type SourceGrounding = NonNullable<NonNullable<RunSummary["groupDecision"]>["sourceGrounding"]>;

function evaluateGroupSourceGrounding(
  dbPath: string,
  runId: string,
  selectedClaimId: string | null,
  finalStep: number,
  requiredSourceIds: string[],
  correct: boolean,
): SourceGrounding | null {
  if (!selectedClaimId || requiredSourceIds.length === 0) return null;

  const safeRunId = runId.replace(/'/g, "''");
  const safeClaimId = selectedClaimId.replace(/'/g, "''");
  const supporters = queryRows<{ agentId: string }>(
    dbPath,
    `SELECT agent_id AS agentId FROM agent_claim_states WHERE run_id = '${safeRunId}' AND claim_id = '${safeClaimId}' AND step_index = ${finalStep} AND stance = 'endorse';`,
  );
  const available = new Set<string>();
  const cited = new Set<string>();

  for (const { agentId } of supporters) {
    const trace = queryRows<{ contextJson: string }>(
      dbPath,
      `SELECT context_json AS contextJson FROM retrieval_traces WHERE run_id = '${safeRunId}' AND claim_id = '${safeClaimId}' AND agent_id = '${agentId.replace(/'/g, "''")}' AND step_index <= ${finalStep} ORDER BY step_index DESC, retrieval_trace_id DESC LIMIT 1;`,
    )[0];
    let context: Record<string, unknown> = {};
    try {
      context = JSON.parse(trace?.contextJson ?? "{}") as Record<string, unknown>;
    } catch {
      context = {};
    }
    const visible = Array.isArray(context.visibleEvidenceIds) ? context.visibleEvidenceIds : [];
    const retrieved = Array.isArray(context.retrievedSourceIds) ? context.retrievedSourceIds : [];
    const citedIds = Array.isArray(context.citedSourceIds) ? context.citedSourceIds : [];
    const agentAvailable = new Set<string>();
    for (const sourceId of [...visible, ...retrieved]) {
      if (typeof sourceId === "string") {
        agentAvailable.add(sourceId);
        available.add(sourceId);
      }
    }
    for (const sourceId of citedIds) {
      if (typeof sourceId === "string" && agentAvailable.has(sourceId)) cited.add(sourceId);
    }
  }

  const required = new Set(requiredSourceIds);
  const availableRequiredSourceIds = requiredSourceIds.filter((sourceId) => available.has(sourceId));
  const citedRequiredSourceIds = requiredSourceIds.filter((sourceId) => cited.has(sourceId));
  const sourceCoverage = availableRequiredSourceIds.length / required.size;
  const citationCoverage = citedRequiredSourceIds.length / required.size;

  return {
    requiredSourceIds,
    finalSupporterCount: supporters.length,
    availableRequiredSourceIds,
    citedRequiredSourceIds,
    sourceCoverage,
    citationCoverage,
    correctAndGrounded: correct && sourceCoverage === 1 && citationCoverage === 1,
  };
}

function evaluateGroupDecision(
  dbPath: string,
  runId: string,
  scenario: Scenario,
  stepMetrics: StepMetrics[],
): NonNullable<RunSummary["groupDecision"]> | null {
  const decision = scenario.groupDecision;
  // Sequential task-chat has no per-claim state snapshots. Its final choices
  // are still recorded in events, so use the last event step for evaluation.
  const finalStep = stepMetrics.at(-1)?.step ?? queryRows<{ step: number }>(
    dbPath,
    `SELECT COALESCE(MAX(step_index), 0) AS step FROM events WHERE run_id = '${runId.replace(/'/g, "''")}';`,
  )[0]?.step;
  if (!decision || finalStep === undefined) return null;

  const candidateSupport: Record<string, number> = {};
  const finalChoices = queryRows<{ outputJson: string }>(
    dbPath,
    `SELECT output_json AS outputJson FROM events WHERE run_id = '${runId.replace(/'/g, "''")}' AND event_type = 'final_group_choice';`,
  );
  if (finalChoices.length > 0) {
    for (const claimId of decision.candidateClaimIds) candidateSupport[claimId] = 0;
    for (const row of finalChoices) {
      try {
        const choice = JSON.parse(row.outputJson) as { selectedClaimId?: string; confidence?: number };
        if (choice.selectedClaimId && choice.selectedClaimId in candidateSupport) {
          candidateSupport[choice.selectedClaimId] += Number(choice.confidence) || 0;
        }
      } catch { /* invalid choices receive no vote */ }
    }
  } else for (const claimId of decision.candidateClaimIds) {
    const rows = queryRows<{ stance: string; confidence: number }>(
      dbPath,
      `SELECT stance, confidence FROM agent_claim_states WHERE run_id = '${runId.replace(/'/g, "''")}' AND claim_id = '${claimId.replace(/'/g, "''")}' AND step_index = ${finalStep};`,
    );
    candidateSupport[claimId] = rows.length === 0
      ? 0
      : rows.reduce((sum, row) => sum + (row.stance === "endorse" ? row.confidence : row.stance === "reject" ? -row.confidence : 0), 0) / rows.length;
  }
  const ranked = Object.entries(candidateSupport).sort(([, left], [, right]) => right - left);
  const top = ranked[0];
  const second = ranked[1];
  const margin = top ? top[1] - (second?.[1] ?? 0) : 0;
  const tied = Boolean(top && second && Math.abs(margin) < 0.000001);
  const selectedClaimId = top && !tied ? top[0] : null;
  const retrievalSupport = evaluateFinalDecisionRetrievalSupport(dbPath, runId, selectedClaimId, finalStep);
  const correct = selectedClaimId === decision.correctClaimId;
  const sourceGrounding = evaluateGroupSourceGrounding(
    dbPath,
    runId,
    selectedClaimId,
    finalStep,
    decision.requiredSourceIds,
    correct,
  );

  return {
    candidateClaimIds: decision.candidateClaimIds,
    correctClaimId: decision.correctClaimId,
    selectedClaimId,
    correct,
    tied,
    margin,
    candidateSupport,
    retrievalSupport,
    sourceGrounding,
  };
}

function evaluateRun(
  dbPath: string,
  runId: string,
  scenario: Scenario,
  stepMetrics: StepMetrics[],
): OpenDiscussionEvaluation | null {
  const focusClaim = scenario.claims.find((claim) => claim.id === scenario.focusClaimId);
  const validSourceIds = new Set<string>([
    ...scenario.sourceCards.map((card) => card.id),
    ...(scenario.sources ?? []).map((source, index) => source.id ?? `source_${index + 1}`),
  ]);

  const finalStep = stepMetrics.at(-1)?.step;
  const finalStates = finalStep === undefined
    ? []
    : queryRows<{ stance: string }>(
      dbPath,
      `
        SELECT stance
        FROM agent_claim_states
        WHERE run_id = '${runId.replace(/'/g, "''")}'
          AND claim_id = '${scenario.focusClaimId.replace(/'/g, "''")}'
          AND step_index = ${finalStep};
      `,
    );

  let focusClaimAccuracy: number | null = null;
  if (focusClaim && finalStates.length > 0) {
    if (focusClaim.truthLabel === "true") {
      focusClaimAccuracy = finalStates.filter((row) => row.stance === "endorse").length / finalStates.length;
    } else if (focusClaim.truthLabel === "false") {
      focusClaimAccuracy = finalStates.filter((row) => row.stance === "reject").length / finalStates.length;
    } else {
      focusClaimAccuracy = finalStates.filter((row) => row.stance === "uncertain").length / finalStates.length;
    }
  }

  const chatRows = queryRows<{ citedSourceIdsJson: string }>(
    dbPath,
    `
      SELECT cited_source_ids_json AS citedSourceIdsJson
      FROM chat_messages
      WHERE run_id = '${runId.replace(/'/g, "''")}';
    `,
  );

  let totalCitations = 0;
  let validCitations = 0;
  let citedMessages = 0;
  const usedSources = new Set<string>();
  for (const row of chatRows) {
    const citedSourceIds = JSON.parse(row.citedSourceIdsJson || "[]") as string[];
    if (citedSourceIds.length > 0) {
      citedMessages += 1;
    }
    for (const sourceId of citedSourceIds) {
      totalCitations += 1;
      if (validSourceIds.has(sourceId)) {
        validCitations += 1;
        usedSources.add(sourceId);
      }
    }
  }

  const firstHalf = stepMetrics.slice(0, Math.max(1, Math.ceil(stepMetrics.length / 2)));
  const earlyConsensusPeak = firstHalf.length > 0
    ? Math.max(...firstHalf.map((metric) => metric.consensusStrength))
    : 0;
  const prematureConsensusRisk = focusClaimAccuracy === null
    ? earlyConsensusPeak
    : earlyConsensusPeak * (1 - focusClaimAccuracy);

  return {
    focusClaimAccuracy,
    citationFidelity: totalCitations > 0 ? validCitations / totalCitations : null,
    citedMessageRate: chatRows.length > 0 ? citedMessages / chatRows.length : 0,
    sourceCoverage: validSourceIds.size > 0 ? usedSources.size / validSourceIds.size : null,
    earlyConsensusPeak,
    prematureConsensusRisk,
    prematureConsensusFlag: prematureConsensusRisk >= 0.35,
  };
}

function loadUsageSummary(dbPath: string, runId: string): NonNullable<RunSummary["usage"]> | null {
  const rows = queryRows<{
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    estimatedCostUsd: number | null;
  }>(
    dbPath,
    `
      SELECT
        SUM(prompt_tokens) AS promptTokens,
        SUM(completion_tokens) AS completionTokens,
        SUM(total_tokens) AS totalTokens,
        SUM(estimated_cost_usd) AS estimatedCostUsd
      FROM model_calls
      WHERE run_id = '${runId.replace(/'/g, "''")}';
    `,
  );
  const row = rows[0];
  if (!row || row.totalTokens === null) {
    return null;
  }
  return {
    promptTokens: row.promptTokens ?? 0,
    completionTokens: row.completionTokens ?? 0,
    totalTokens: row.totalTokens ?? 0,
    estimatedCostUsd: row.estimatedCostUsd,
  };
}

export function finalizeSummary(
  runId: string,
  runConfig: RunConfig,
  scenario: Scenario,
  condition: Condition,
  stepMetrics: StepMetrics[],
  dbPath: string,
  outputDir: string,
  resolvedInterventions: Scenario["scheduledInterventions"],
  latestPhysicsReport: PhysicsReport | null,
): RunSummary {
  const correctionStep = resolvedInterventions.find(
    (item) => item.claimId === scenario.focusClaimId,
  )?.step ?? null;
  const finalMetrics = stepMetrics.at(-1);
  const evaluation = scenario.scenarioType === "open_discussion"
    ? evaluateRun(dbPath, runId, scenario, stepMetrics)
    : null;
  const usage = loadUsageSummary(dbPath, runId);
  const groupDecision = evaluateGroupDecision(dbPath, runId, scenario, stepMetrics);

  const summary: RunSummary = {
    runId,
    configId: runConfig.id,
    conditionId: condition.id,
    scenarioId: scenario.id,
    memoryMode: condition.memory.mode,
    interactionMode: condition.interaction.mode,
    topology: condition.interaction.topology,
    agentCount: runConfig.agents.length,
    claimCount: scenario.claims.length,
    correctionCount: resolvedInterventions.length,
    maxSteps: runConfig.maxSteps,
    completedSteps: stepMetrics.length,
    falseClaimEndorsementRate: finalMetrics?.falseClaimEndorsementRate ?? 0,
    finalConfidenceWeightedFalseEndorsement: finalMetrics?.confidenceWeightedFalseEndorsement ?? 0,
    finalFalseClaimRejectRate: finalMetrics?.falseClaimRejectRate ?? 0,
    finalUncertainRate: finalMetrics?.uncertainRate ?? 0,
    peakFalseClaimEndorsementRate: Math.max(
      0,
      ...stepMetrics.map((metric) => metric.falseClaimEndorsementRate),
    ),
    peakConfidenceWeightedFalseEndorsement: Math.max(
      0,
      ...stepMetrics.map((metric) => metric.confidenceWeightedFalseEndorsement),
    ),
    timeToMajorityAdoption: computeTimeToMajorityAdoption(stepMetrics),
    timeToCorrection: correctionStep,
    distanceFromGroundTruth: finalMetrics?.distanceFromGroundTruth ?? 0,
    recoveryAfterCorrection: computeRecoveryAfterCorrection(stepMetrics, correctionStep),
    postCorrectionPersistence: computePostCorrectionPersistence(stepMetrics, correctionStep),
    diversityRetention: finalMetrics?.diversityRetention ?? 0,
    trajectory: {
      finalMajorityStance: finalMetrics?.majorityStance ?? "uncertain",
      finalConsensusStrength: finalMetrics?.consensusStrength ?? 0,
      peakConsensusStrength: Math.max(0, ...stepMetrics.map((metric) => metric.consensusStrength)),
      lowestConsensusStrength: stepMetrics.length > 0
        ? Math.min(...stepMetrics.map((metric) => metric.consensusStrength))
        : 0,
      finalNetEndorsement: finalMetrics?.netEndorsement ?? 0,
      finalMeanConfidence: finalMetrics?.meanConfidence ?? 0,
    },
    physics: latestPhysicsReport
      ? {
        predictedRegime: latestPhysicsReport.divergence.predictedRegime,
        actualRegime: latestPhysicsReport.divergence.actualRegime,
        regimeMatch: latestPhysicsReport.divergence.regimeMatch,
        extendedModelImprovement: latestPhysicsReport.paperMetrics.extendedModelImprovement,
        truthAsymmetryRatio: latestPhysicsReport.paperMetrics.truthAsymmetryRatio,
        groupArchetype: latestPhysicsReport.paperMetrics.groupArchetype,
        criticalTemperature: latestPhysicsReport.criticalTemperature,
        correctionEffect: latestPhysicsReport.interventionAnalysis?.correctionEffect ?? null,
        correctionSurprise: latestPhysicsReport.interventionAnalysis?.correctionSurprise ?? null,
      }
      : null,
    evaluation,
    groupDecision,
    usage,
    dbPath,
  };

  insertRow(dbPath, "metric_records", {
    run_id: runId,
    step_index: null,
    metric_name: "run_summary",
    metric_value: 0,
    metric_json: JSON.stringify(summary),
  });
  insertRow(dbPath, "runs", {
    run_id: `${runId}__finalized`,
    config_id: runConfig.id,
    scenario_id: scenario.id,
    condition_id: condition.id,
    seed: runConfig.seed,
    memory_mode: condition.memory.mode,
    max_steps: runConfig.maxSteps,
    status: "completed",
    run_metadata_json: JSON.stringify(summary),
  });

  writeSummaryJson(outputDir, summary);
  return summary;
}
