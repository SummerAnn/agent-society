import { loadCondition, loadRunConfig, loadScenario, resolveRelativeConfigPath } from "../config/load";
import {
  type AgentSpec,
  type BeliefStateRecord,
  type Condition,
  type MemoryEntry,
  type RunConfig,
  type Scenario,
  type StanceLabel,
  type StepMetrics,
} from "../config/schema";
import { insertRow } from "../db/sqlite";
import { resolveProvider, type ProviderConfig } from "../llm/provider";
import { retrieveMemoryEntries, weightedMemorySignal } from "../memory/retrieve";
import { computeStepMetrics } from "../metrics/compute";
import { visibleEvidenceForAgent } from "../scenario/access";
import type { LoadedRun } from "./types";

export function mulberry32(seed: number): () => number {
  let value = seed + 0x6d2b79f5;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function loadExperiment(runConfigPath: string): LoadedRun {
  const runConfig = loadRunConfig(runConfigPath);
  const scenarioPath = resolveRelativeConfigPath(runConfigPath, runConfig.scenarioPath);
  const conditionPath = resolveRelativeConfigPath(runConfigPath, runConfig.conditionPath);
  const scenario = loadScenario(scenarioPath);
  const condition = loadCondition(conditionPath);
  return { runConfigPath, runConfig, scenario, condition };
}

export function scoreToStance(score: number): StanceLabel {
  if (score >= 0.35) return "endorse";
  if (score <= -0.35) return "reject";
  return "uncertain";
}

function beliefScoreFromStance(stance: StanceLabel, confidence: number): number {
  if (stance === "endorse") return confidence;
  if (stance === "reject") return -confidence;
  return 0;
}

function verificationSignal(
  claimId: string,
  scenario: Scenario,
  verification: Condition["interventions"]["verification"],
  rng: () => number,
): number {
  if (verification.mode === "none") return 0;

  const claim = scenario.claims.find((item) => item.id === claimId);
  if (!claim) return 0;

  const truthDirection = claim.truthLabel === "false" ? -1 : claim.truthLabel === "true" ? 1 : 0;
  if (verification.mode === "reliable") {
    return truthDirection * 0.4;
  }

  const isWrong = rng() < verification.noiseLevel;
  return (isWrong ? -truthDirection : truthDirection) * 0.4;
}

function resolveFixedInterventionStep(
  originalStep: number,
  timing: Extract<Condition["interventions"]["correctionTiming"], string>,
  maxSteps: number,
): number {
  if (timing === "none") {
    return 0;
  }
  if (timing === "early") {
    return Math.max(1, Math.round(maxSteps * 0.33));
  }
  if (timing === "late") {
    return Math.min(maxSteps, Math.round(maxSteps * 0.83));
  }
  return originalStep;
}

function materializeInterventionSequence(
  intervention: Scenario["scheduledInterventions"][number],
  condition: Condition,
  maxSteps: number,
  step: number,
): Scenario["scheduledInterventions"] {
  let effect = intervention.effect;
  const strength = condition.interventions.correctionStrength;

  if (strength === "weak") {
    effect *= 0.4;
  } else if (strength === "high_authority") {
    effect *= 1.5;
  } else if (strength === "repeated") {
    const repeats = [
      { offset: 0, multiplier: 1 },
      { offset: 1, multiplier: 0.85 },
      { offset: 2, multiplier: 0.7 },
    ];

    return repeats
      .map(({ offset, multiplier }, index) => {
        const repeatedStep = step + offset;
        if (repeatedStep > maxSteps) return null;

        return {
          ...intervention,
          id: index === 0 ? intervention.id : `${intervention.id}-repeat-${index + 1}`,
          step: repeatedStep,
          effect: effect * multiplier,
          text: index === 0 ? intervention.text : `${intervention.text} (repeat ${index + 1}/3)`,
        };
      })
      .filter((value): value is Scenario["scheduledInterventions"][number] => value !== null);
  }

  return [{ ...intervention, step, effect }];
}

export function currentBeliefSnapshot(states: BeliefStateRecord[]): BeliefStateRecord[] {
  return Array.from(latestStatesByAgentClaim(states).values());
}

export function resolveInterventions(
  scenario: Scenario,
  condition: Condition,
  maxSteps: number,
): Scenario["scheduledInterventions"] {
  const timing = condition.interventions.correctionTiming;
  if (typeof timing !== "string") {
    return [];
  }
  if (timing === "none") {
    return [];
  }

  return scenario.scheduledInterventions.flatMap((intervention) =>
    materializeInterventionSequence(
      intervention,
      condition,
      maxSteps,
      resolveFixedInterventionStep(intervention.step, timing, maxSteps),
    ));
}

export function maybeActivateTriggeredInterventions(
  scenario: Scenario,
  condition: Condition,
  maxSteps: number,
  step: number,
  allBeliefStates: BeliefStateRecord[],
  stepMetrics: StepMetrics[],
  resolvedInterventions: Scenario["scheduledInterventions"],
): void {
  const timing = condition.interventions.correctionTiming;
  if (typeof timing === "string") return;
  if (scenario.scheduledInterventions.length === 0) return;
  if (resolvedInterventions.length > 0) return;
  if (step < timing.minStep) return;

  const metrics = stepMetrics.at(-1) ?? computeStepMetrics(
    "trigger-check",
    Math.max(0, step - 1),
    currentBeliefSnapshot(allBeliefStates),
    scenario,
  );

  if (metrics.falseClaimEndorsementRate < timing.threshold) return;

  resolvedInterventions.push(
    ...scenario.scheduledInterventions.flatMap((intervention) =>
      materializeInterventionSequence(intervention, condition, maxSteps, step)),
  );
}

export function scoreClaimHeuristic(
  agent: AgentSpec,
  claimId: string,
  scenario: Scenario,
  condition: Condition,
  memoryEntries: MemoryEntry[],
  activeInterventions: Scenario["scheduledInterventions"],
  currentStep: number,
  rng: () => number,
): { score: number; stance: StanceLabel; confidence: number; retrievedMemory: MemoryEntry[]; reasoning: string } {
  let evidenceScore = 0;
  for (const evidence of visibleEvidenceForAgent(scenario, agent.id, claimId, currentStep)) {
    for (const effect of evidence.effects) {
      if (effect.claimId !== claimId) continue;
      evidenceScore += effect.effect >= 0
        ? effect.effect * agent.positiveEvidenceWeight
        : effect.effect * agent.negativeEvidenceWeight;
    }
  }

  const retrievedMemory = retrieveMemoryEntries(memoryEntries, agent.id, claimId, condition);
  const memoryAverage = weightedMemorySignal(retrievedMemory, condition, scenario, claimId, currentStep);
  const memoryScore = memoryAverage * agent.socialWeight;
  const interventionScore = activeInterventions
    .filter((intervention) => intervention.claimId === claimId)
    .reduce((sum, intervention) => sum + intervention.effect * agent.correctionTrust, 0);
  const vSignal = verificationSignal(claimId, scenario, condition.interventions.verification, rng);
  const bias = claimId === scenario.focusClaimId ? agent.falseClaimBias : 0;
  const noise = (rng() - 0.5) * 0.12;
  const score = bias + evidenceScore + memoryScore + interventionScore + vSignal + noise;

  return {
    score,
    stance: scoreToStance(score),
    confidence: clamp(Math.abs(score), 0.05, 1),
    retrievedMemory,
    reasoning: `[heuristic] score=${score.toFixed(3)} (bias=${bias.toFixed(2)} ev=${evidenceScore.toFixed(2)} mem=${memoryScore.toFixed(2)} int=${interventionScore.toFixed(2)} ver=${vSignal.toFixed(2)})`,
  };
}

export function createInitialState(runId: string, scenario: Scenario, agents: AgentSpec[]): BeliefStateRecord[] {
  const initialStates: BeliefStateRecord[] = [];
  const initialBeliefByKey = new Map<string, { stance: StanceLabel; confidence: number; score?: number }>();

  const configuredBeliefs = scenario.initialBeliefStates.length > 0
    ? scenario.initialBeliefStates
    : scenario.initialMemoryEntries.map((entry) => ({
      agentId: entry.agentId,
      claimId: entry.claimId,
      stance: entry.stance,
      confidence: entry.confidence,
      score: beliefScoreFromStance(entry.stance, entry.confidence),
    }));

  for (const belief of configuredBeliefs) {
    initialBeliefByKey.set(`${belief.agentId}::${belief.claimId}`, belief);
  }

  for (const agent of agents) {
    for (const claim of scenario.claims) {
      const configured = initialBeliefByKey.get(`${agent.id}::${claim.id}`);
      const stance: StanceLabel = configured?.stance ?? "uncertain";
      const confidence = configured?.confidence ?? 0.2;
      const score = configured?.score ?? beliefScoreFromStance(stance, confidence);
      initialStates.push({
        runId,
        step: 0,
        agentId: agent.id,
        claimId: claim.id,
        truthLabel: claim.truthLabel,
        stance,
        score,
        confidence,
      });
    }
  }
  return initialStates;
}

function latestStatesByAgentClaim(states: BeliefStateRecord[]): Map<string, BeliefStateRecord> {
  const latest = new Map<string, BeliefStateRecord>();
  for (const state of states) {
    latest.set(`${state.agentId}::${state.claimId}`, state);
  }
  return latest;
}

export function buildStepSnapshot(
  runId: string,
  step: number,
  previousStates: BeliefStateRecord[],
  updates: BeliefStateRecord[],
): BeliefStateRecord[] {
  const latest = latestStatesByAgentClaim(previousStates);
  for (const update of updates) {
    latest.set(`${update.agentId}::${update.claimId}`, update);
  }
  return Array.from(latest.values()).map((state) => ({ ...state, runId, step }));
}

export function resolveAgentProviders(
  agents: AgentSpec[],
  projectRoot: string,
): Map<string, ProviderConfig> {
  const providers = new Map<string, ProviderConfig>();
  for (const agent of agents) {
    const provider = resolveProvider(agent.model, projectRoot);
    if (!provider) {
      throw new Error(
        `No API key found for agent "${agent.id}" (model: ${agent.model}). Set the appropriate environment variable or run the setup.`,
      );
    }
    providers.set(agent.id, provider);
  }
  return providers;
}

export function persistMemoryEntry(dbPath: string, runId: string, entry: MemoryEntry): void {
  insertRow(dbPath, "memory_entries", {
    memory_entry_id: entry.id,
    run_id: runId,
    step_index: entry.step,
    agent_id: entry.agentId,
    claim_id: entry.claimId,
    stance: entry.stance,
    confidence: entry.confidence,
    visibility: entry.visibility,
    source_type: entry.sourceType,
    entry_text: entry.text,
  });
}

export function persistTestimonyAdoption(
  dbPath: string,
  runId: string,
  step: number,
  agentId: string,
  claimId: string,
  stance: StanceLabel,
  sourceMemoryEntryId: string,
  sourceAgentId: string,
  previousStance: StanceLabel,
  previousConfidence: number,
  currentConfidence: number,
): void {
  insertRow(dbPath, "testimony_adoptions", {
    run_id: runId,
    step_index: step,
    agent_id: agentId,
    claim_id: claimId,
    stance,
    source_memory_entry_id: sourceMemoryEntryId,
    source_agent_id: sourceAgentId,
    previous_stance: previousStance,
    previous_confidence: previousConfidence,
    current_confidence: currentConfidence,
  });
}

export function persistClaimLineage(
  dbPath: string,
  runId: string,
  step: number,
  claimId: string,
  parentMemoryEntryId: string,
  childMemoryEntryId: string,
  parentAgentId: string,
  childAgentId: string,
  relationType: "memory_adoption" | "memory_restatement",
): void {
  insertRow(dbPath, "claim_lineage", {
    run_id: runId,
    step_index: step,
    claim_id: claimId,
    parent_memory_entry_id: parentMemoryEntryId,
    child_memory_entry_id: childMemoryEntryId,
    parent_agent_id: parentAgentId,
    child_agent_id: childAgentId,
    relation_type: relationType,
  });
}

export function persistModelCall(
  dbPath: string,
  runId: string,
  step: number,
  agentId: string,
  claimId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
  estimatedCostUsd: number | null,
): void {
  insertRow(dbPath, "model_calls", {
    run_id: runId,
    step_index: step,
    agent_id: agentId,
    claim_id: claimId,
    model_name: model,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    estimated_cost_usd: estimatedCostUsd,
  });
}

export function latestStateForAgentClaim(
  states: BeliefStateRecord[],
  agentId: string,
  claimId: string,
): BeliefStateRecord | null {
  return latestStatesByAgentClaim(states).get(`${agentId}::${claimId}`) ?? null;
}

export function persistInterventionsForStep(
  dbPath: string,
  runId: string,
  interventions: Scenario["scheduledInterventions"],
  step: number,
): boolean {
  let fired = false;
  for (const intervention of interventions.filter((item) => item.step === step)) {
    fired = true;
    insertRow(dbPath, "interventions", {
      run_id: runId,
      intervention_id: intervention.id,
      step_index: step,
      claim_id: intervention.claimId,
      intervention_type: intervention.type,
      payload_json: JSON.stringify(intervention),
    });
  }
  return fired;
}

export function persistStepMetrics(
  dbPath: string,
  runId: string,
  step: number,
  metrics: StepMetrics,
): void {
  for (const [metricName, metricValue] of Object.entries({
    focusAgentCount: metrics.focusAgentCount,
    falseClaimEndorsementRate: metrics.falseClaimEndorsementRate,
    confidenceWeightedFalseEndorsement: metrics.confidenceWeightedFalseEndorsement,
    falseClaimRejectRate: metrics.falseClaimRejectRate,
    uncertainRate: metrics.uncertainRate,
    distanceFromGroundTruth: metrics.distanceFromGroundTruth,
    diversityRetention: metrics.diversityRetention,
    consensusStrength: metrics.consensusStrength,
    majorityMargin: metrics.majorityMargin,
    netEndorsement: metrics.netEndorsement,
    meanConfidence: metrics.meanConfidence,
    disagreementLevel: metrics.disagreementLevel,
  })) {
    insertRow(dbPath, "metric_records", {
      run_id: runId,
      step_index: step,
      metric_name: metricName,
      metric_value: metricValue,
      metric_json: JSON.stringify(metrics),
    });
  }
}

export function initializeRunStorage(
  dbPath: string,
  runId: string,
  runConfig: RunConfig,
  scenario: Scenario,
  condition: Condition,
  engineMode: "heuristic" | "llm",
): { allBeliefStates: BeliefStateRecord[]; memoryEntries: MemoryEntry[] } {
  insertRow(dbPath, "runs", {
    run_id: runId,
    config_id: runConfig.id,
    scenario_id: scenario.id,
    condition_id: condition.id,
    seed: runConfig.seed,
    memory_mode: condition.memory.mode,
    max_steps: runConfig.maxSteps,
    status: "running",
    run_metadata_json: JSON.stringify({
      title: runConfig.title,
      agentCount: runConfig.agents.length,
      budget: runConfig.budget,
      decay: condition.memory.decay,
      verification: condition.interventions.verification,
      correctionTiming: condition.interventions.correctionTiming,
      correctionStrength: condition.interventions.correctionStrength,
      engineMode,
      interactionMode: condition.interaction.mode,
      topology: condition.interaction.topology,
      chatRounds: condition.interaction.chatRounds,
    }),
  });

  const allBeliefStates = createInitialState(runId, scenario, runConfig.agents);
  for (const state of allBeliefStates) {
    insertRow(dbPath, "agent_claim_states", {
      run_id: state.runId,
      step_index: state.step,
      agent_id: state.agentId,
      claim_id: state.claimId,
      truth_label: state.truthLabel,
      stance: state.stance,
      score: state.score,
      confidence: state.confidence,
    });
  }

  const memoryEntries: MemoryEntry[] = scenario.initialMemoryEntries.map((entry) => ({
    id: entry.id,
    step: 0,
    agentId: entry.agentId,
    claimId: entry.claimId,
    stance: entry.stance,
    confidence: entry.confidence,
    visibility: entry.visibility,
    sourceType: entry.sourceType,
    text: entry.text,
  }));

  for (const entry of memoryEntries) {
    persistMemoryEntry(dbPath, runId, entry);
  }

  return { allBeliefStates, memoryEntries };
}
