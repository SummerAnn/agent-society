// Physics analysis entry point.
//
// Runs the full analysis pipeline on a completed debate:
//   1. Ising predictions (vanilla + extended)
//   2. Divergence measurement (predicted vs actual)
//   3. Causal decomposition (what Ising can't explain)
//   4. Archetype classification (individual + group)
//   5. Intervention effectiveness (correction as external field)
//
// This produces the PhysicsReport that captures our contribution:
// extending statistical mechanics models for LLM agent systems.

import type { AgentSpec, ChatMessage, Scenario, Condition, Topology } from "../config/schema";
import { estimateCriticalTemperature, type IsingTrajectory } from "./ising";
import { computeDivergence, type DivergenceReport } from "./divergence";
import { decomposeStanceChanges, type DecompositionResult } from "./decomposition";
import { classifyGroup, type GroupArchetypeResult } from "./archetypes";

// --- Full physics report ---

export type PhysicsReport = {
  // Identity
  runId: string;
  topology: Topology;
  agentCount: number;
  debateRounds: number;

  // Ising divergence analysis
  divergence: DivergenceReport;

  // Causal decomposition
  decomposition: DecompositionResult;

  // Archetype classification
  archetypes: GroupArchetypeResult;

  // Intervention analysis (if corrections were applied)
  interventionAnalysis: InterventionAnalysis | null;

  // Critical temperature estimate
  criticalTemperature: number | null;

  // Summary statistics for the paper
  paperMetrics: PaperMetrics;
};

export type InterventionAnalysis = {
  correctionRounds: number[];
  // Magnetization before and after correction
  preCorrectionMagnetization: number;
  postCorrectionMagnetization: number;
  correctionEffect: number; // post - pre
  // Did the Ising model predict the correction effect?
  isingPredictedEffect: number;
  correctionSurprise: number; // actual - predicted effect
  // Recovery: how many rounds to stabilize after correction
  recoveryRounds: number;
};

export type PaperMetrics = {
  // How much of agent behavior is Ising-explainable?
  isingExplainedFraction: number;
  // Improvement from our extended model
  extendedModelImprovement: number;
  // Truth asymmetry ratio (>1 = false claims flip more, which is good)
  truthAsymmetryRatio: number;
  // Correction effectiveness (Ising can't predict this at all)
  correctionEffectiveness: number;
  // Regime prediction accuracy
  regimePredictionCorrect: boolean;
  // Group dynamics pattern
  groupArchetype: string;
  // Dominant agent archetype distribution
  archetypeDistribution: Record<string, number>;
};

// --- Main analysis function ---

export function analyzeDebate(
  runId: string,
  agents: AgentSpec[],
  messages: ChatMessage[],
  scenario: Scenario,
  condition: Condition,
  options: {
    seed?: number;
  } = {},
): PhysicsReport {
  const topology = condition.interaction.topology;
  const rounds = Math.max(0, ...messages.map((m) => m.round));
  const focusClaim = scenario.claims.find((c) => c.id === scenario.focusClaimId);
  const truthLabel = (focusClaim?.truthLabel ?? "mixed") as "true" | "false" | "mixed";

  // Find correction rounds from scenario
  const correctionRounds = scenario.scheduledInterventions
    .filter((i) => i.claimId === scenario.focusClaimId)
    .map((i) => i.step);

  // Build correction schedule for Ising model
  const correctionSchedule = new Map<number, number[]>();
  for (const intervention of scenario.scheduledInterventions) {
    if (intervention.claimId !== scenario.focusClaimId) continue;
    const fields = new Array(agents.length).fill(0);
    for (let i = 0; i < agents.length; i++) {
      fields[i] = intervention.effect * agents[i].correctionTrust;
    }
    correctionSchedule.set(intervention.step, fields);
  }

  // 1. Divergence analysis
  const divergence = computeDivergence(agents, topology, messages, {
    seed: options.seed,
    correctionSchedule,
    truthLabel,
  });

  // 2. Causal decomposition
  const decomposition = decomposeStanceChanges(messages, agents, topology, {
    truthLabel,
    correctionRounds,
  });

  // 3. Archetype classification
  const archetypes = classifyGroup(agents, messages, {
    truthLabel,
    correctionRounds,
  });

  // 4. Intervention analysis
  let interventionAnalysis: InterventionAnalysis | null = null;
  if (correctionRounds.length > 0 && rounds > 0) {
    interventionAnalysis = analyzeIntervention(
      messages,
      agents,
      correctionRounds,
      divergence,
    );
  }

  // 5. Critical temperature
  let criticalTemperature: number | null = null;
  if (agents.length >= 3) {
    const initialStances = new Map<string, { stance: "endorse" | "reject" | "uncertain"; confidence: number }>();
    for (const agent of agents) {
      initialStances.set(agent.id, {
        stance: agent.role === "contamination_agent" ? "endorse" : "uncertain",
        confidence: agent.role === "contamination_agent" ? 0.85 : 0.2,
      });
    }
    const tcResult = estimateCriticalTemperature(agents, topology, initialStances, {
      seed: options.seed,
      roundsPerTemp: Math.max(rounds, 6),
    });
    criticalTemperature = tcResult.criticalTemp;
  }

  // 6. Paper metrics
  const archetypeDistribution: Record<string, number> = {};
  for (const a of archetypes.agents) {
    archetypeDistribution[a.archetype] = (archetypeDistribution[a.archetype] ?? 0) + 1;
  }

  const paperMetrics: PaperMetrics = {
    isingExplainedFraction: decomposition.isingExplainedRate,
    extendedModelImprovement: divergence.improvementRatio,
    truthAsymmetryRatio: decomposition.truthAsymmetry.asymmetryRatio,
    correctionEffectiveness: interventionAnalysis?.correctionEffect ?? 0,
    regimePredictionCorrect: divergence.regimeMatch,
    groupArchetype: archetypes.archetype,
    archetypeDistribution,
  };

  return {
    runId,
    topology,
    agentCount: agents.length,
    debateRounds: rounds,
    divergence,
    decomposition,
    archetypes,
    interventionAnalysis,
    criticalTemperature,
    paperMetrics,
  };
}

// --- Intervention analysis ---

function analyzeIntervention(
  messages: ChatMessage[],
  agents: AgentSpec[],
  correctionRounds: number[],
  divergence: DivergenceReport,
): InterventionAnalysis {
  const firstCorrection = Math.min(...correctionRounds);
  const rounds = Math.max(0, ...messages.map((m) => m.round));

  // Pre-correction magnetization (average of rounds before correction)
  const preMsgs = messages.filter((m) => m.round < firstCorrection);
  const preMag = computeMagnetization(preMsgs, agents);

  // Post-correction magnetization (average of rounds after correction)
  const postMsgs = messages.filter((m) => m.round >= firstCorrection);
  const postMag = computeMagnetization(postMsgs, agents);

  const correctionEffect = postMag - preMag;

  // What did the Ising model predict for the same correction?
  const preIdx = Math.max(0, firstCorrection - 2);
  const postIdx = Math.min(divergence.trajectory.length - 1, firstCorrection);
  const isingPre = divergence.trajectory[preIdx]?.predicted ?? 0;
  const isingPost = divergence.trajectory[postIdx]?.predicted ?? 0;
  const isingPredictedEffect = isingPost - isingPre;

  // Recovery: how many rounds until magnetization stabilizes after correction
  let recoveryRounds = 0;
  for (let r = firstCorrection; r <= rounds; r++) {
    const roundMsgs = messages.filter((m) => m.round === r);
    const mag = roundMsgs.length > 0
      ? roundMsgs.reduce((s, m) => {
        if (m.stance === "endorse") return s + 1;
        if (m.stance === "reject") return s - 1;
        return s;
      }, 0) / roundMsgs.length
      : 0;

    recoveryRounds = r - firstCorrection;

    // Check if stable (within 0.1 of post-correction average)
    if (Math.abs(mag - postMag) < 0.1 && r > firstCorrection + 1) break;
  }

  return {
    correctionRounds,
    preCorrectionMagnetization: preMag,
    postCorrectionMagnetization: postMag,
    correctionEffect,
    isingPredictedEffect,
    correctionSurprise: correctionEffect - isingPredictedEffect,
    recoveryRounds,
  };
}

function computeMagnetization(messages: ChatMessage[], agents: AgentSpec[]): number {
  if (messages.length === 0) return 0;
  const rounds = [...new Set(messages.map((m) => m.round))];
  let totalMag = 0;
  for (const r of rounds) {
    const roundMsgs = messages.filter((m) => m.round === r);
    const spins: number[] = roundMsgs.map((m) => {
      if (m.stance === "endorse") return 1;
      if (m.stance === "reject") return -1;
      return 0;
    });
    totalMag += spins.reduce((a, b) => a + b, 0) / Math.max(1, spins.length);
  }
  return totalMag / Math.max(1, rounds.length);
}
