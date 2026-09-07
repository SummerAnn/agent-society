// Divergence analysis: compare Ising model predictions to actual LLM agent behavior.
//
// This is the core of our contribution — measuring WHERE and WHY
// LLM agents deviate from the spin model. The residual between
// predicted and actual trajectories reveals what statistical mechanics
// misses about language-model agents.

import type { AgentSpec, ChatMessage, StanceLabel, Topology } from "../config/schema";
import {
  simulateIsing,
  simulateExtendedIsing,
  classifyRegime,
  type IsingTrajectory,
  type IsingRegime,
} from "./ising";

// --- Types ---

export type MagnetizationPoint = {
  round: number;
  predicted: number; // Ising model prediction
  predictedExtended: number; // Extended model prediction
  actual: number; // Actual LLM agent behavior
  residualVanilla: number; // actual - predicted (vanilla)
  residualExtended: number; // actual - predicted (extended)
};

export type DivergenceReport = {
  // Per-round comparison
  trajectory: MagnetizationPoint[];

  // Aggregate metrics
  vanillaRMSE: number; // Root mean square error (vanilla Ising vs actual)
  extendedRMSE: number; // Root mean square error (extended Ising vs actual)
  improvementRatio: number; // How much better extended model fits (1 - extRMSE/vanRMSE)

  // Regime analysis
  predictedRegime: IsingRegime;
  actualRegime: IsingRegime;
  regimeMatch: boolean;

  // Phase of maximum divergence
  peakDivergenceRound: number;
  peakDivergenceMagnitude: number;

  // Conviction comparison
  predictedFinalConviction: number;
  actualFinalConviction: number;
  convictionDivergence: number;

  // Directional analysis: does the Ising model get the DIRECTION right
  // even when magnitude is off?
  directionAccuracy: number; // fraction of rounds where sign(predicted) == sign(actual)
};

// --- Convert chat messages to magnetization trajectory ---

function chatToMagnetization(
  messages: ChatMessage[],
  agents: AgentSpec[],
): { magnetization: number[]; conviction: number[]; perAgent: Map<string, number[]> } {
  const rounds = Math.max(0, ...messages.map((m) => m.round));
  const magnetization: number[] = [];
  const conviction: number[] = [];
  const perAgent = new Map<string, number[]>();

  for (const agent of agents) {
    perAgent.set(agent.id, []);
  }

  for (let r = 1; r <= rounds; r++) {
    const roundMsgs = messages.filter((m) => m.round === r);
    const spins: number[] = [];

    for (const agent of agents) {
      const msg = roundMsgs.find((m) => m.agentId === agent.id);
      const spin = stanceToSpin(msg?.stance ?? null, msg?.confidence ?? null);
      spins.push(spin);
      perAgent.get(agent.id)!.push(spin);
    }

    magnetization.push(mean(spins));
    conviction.push(mean(spins.map(Math.abs)));
  }

  return { magnetization, conviction, perAgent };
}

// --- Main divergence computation ---

export function computeDivergence(
  agents: AgentSpec[],
  topology: Topology,
  messages: ChatMessage[],
  options: {
    seed?: number;
    temperature?: number;
    correctionSchedule?: Map<number, number[]>;
    truthLabel?: "true" | "false" | "mixed";
    memoryHalfLife?: number;
  } = {},
): DivergenceReport {
  const rounds = Math.max(0, ...messages.map((m) => m.round));
  if (rounds === 0) {
    return emptyReport();
  }

  // Extract actual trajectory from chat messages
  const actual = chatToMagnetization(messages, agents);

  // Build initial stances from round-1 messages (or use defaults)
  const initialStances = new Map<string, { stance: StanceLabel; confidence: number }>();
  for (const agent of agents) {
    const firstMsg = messages.find((m) => m.agentId === agent.id && m.round === 1);
    if (firstMsg?.stance) {
      initialStances.set(agent.id, {
        stance: firstMsg.stance,
        confidence: firstMsg.confidence ?? 0.5,
      });
    } else {
      // Use agent role to infer initial stance
      initialStances.set(agent.id, {
        stance: agent.role === "contamination_agent" ? "endorse" : "uncertain",
        confidence: agent.role === "contamination_agent" ? 0.85 : 0.2,
      });
    }
  }

  // Run vanilla Ising prediction
  const vanillaTraj = simulateIsing(agents, topology, initialStances, rounds, {
    temperature: options.temperature,
    seed: options.seed,
    correctionSchedule: options.correctionSchedule,
  });

  // Run extended Ising prediction
  const extendedTraj = simulateExtendedIsing(agents, topology, initialStances, rounds, {
    temperature: options.temperature,
    seed: options.seed,
    correctionSchedule: options.correctionSchedule,
    truthLabel: options.truthLabel,
    memoryHalfLife: options.memoryHalfLife,
  });

  // Build per-round comparison
  // Note: Ising trajectories have round 0 (initial), so we offset by 1
  const trajectory: MagnetizationPoint[] = [];
  for (let r = 0; r < rounds; r++) {
    const pred = vanillaTraj.magnetization[r + 1] ?? vanillaTraj.magnetization[vanillaTraj.magnetization.length - 1];
    const predExt = extendedTraj.magnetization[r + 1] ?? extendedTraj.magnetization[extendedTraj.magnetization.length - 1];
    const act = actual.magnetization[r] ?? 0;

    trajectory.push({
      round: r + 1,
      predicted: pred,
      predictedExtended: predExt,
      actual: act,
      residualVanilla: act - pred,
      residualExtended: act - predExt,
    });
  }

  // RMSE
  const vanillaResiduals = trajectory.map((t) => t.residualVanilla);
  const extendedResiduals = trajectory.map((t) => t.residualExtended);
  const vanillaRMSE = rmse(vanillaResiduals);
  const extendedRMSE = rmse(extendedResiduals);
  const improvementRatio = vanillaRMSE > 0 ? 1 - extendedRMSE / vanillaRMSE : 0;

  // Regime classification
  const predictedRegime = classifyRegime(vanillaTraj);
  const actualRegimeTrajectory: IsingTrajectory = {
    rounds,
    spins: [],
    magnetization: actual.magnetization,
    conviction: actual.conviction,
    energy: [],
    susceptibility: [],
  };
  const actualRegime = classifyRegime(actualRegimeTrajectory);

  // Peak divergence
  let peakRound = 1;
  let peakMag = 0;
  for (const t of trajectory) {
    const absDiff = Math.abs(t.residualVanilla);
    if (absDiff > peakMag) {
      peakMag = absDiff;
      peakRound = t.round;
    }
  }

  // Conviction comparison
  const predConviction = mean(vanillaTraj.conviction.slice(-Math.max(1, Math.floor(rounds / 3))));
  const actualConviction = mean(actual.conviction.slice(-Math.max(1, Math.floor(rounds / 3))));

  // Direction accuracy
  let directionCorrect = 0;
  for (const t of trajectory) {
    if (Math.sign(t.predicted) === Math.sign(t.actual) || (Math.abs(t.actual) < 0.05)) {
      directionCorrect++;
    }
  }

  return {
    trajectory,
    vanillaRMSE,
    extendedRMSE,
    improvementRatio,
    predictedRegime,
    actualRegime,
    regimeMatch: predictedRegime === actualRegime,
    peakDivergenceRound: peakRound,
    peakDivergenceMagnitude: peakMag,
    predictedFinalConviction: predConviction,
    actualFinalConviction: actualConviction,
    convictionDivergence: actualConviction - predConviction,
    directionAccuracy: trajectory.length > 0 ? directionCorrect / trajectory.length : 1,
  };
}

// --- Helpers ---

function stanceToSpin(stance: StanceLabel | null, confidence: number | null): number {
  if (!stance || stance === "uncertain") return 0;
  const sign = stance === "endorse" ? 1 : -1;
  return sign * (confidence ?? 0.5);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function rmse(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
}

function emptyReport(): DivergenceReport {
  return {
    trajectory: [],
    vanillaRMSE: 0,
    extendedRMSE: 0,
    improvementRatio: 0,
    predictedRegime: "indifference",
    actualRegime: "indifference",
    regimeMatch: true,
    peakDivergenceRound: 0,
    peakDivergenceMagnitude: 0,
    predictedFinalConviction: 0,
    actualFinalConviction: 0,
    convictionDivergence: 0,
    directionAccuracy: 1,
  };
}
