// Agent and group archetype classification.
//
// Based on El et al. (2026) individual/group archetypes but extended
// with our misinformation-specific categories.
//
// Individual archetypes (from their paper):
//   Frozen — never changes stance
//   Switcher — changes stance once and stays
//   Intermittent — changes multiple times with long stable periods
//   Oscillator — flips rapidly between stances
//
// Our additions:
//   Correctable — changes stance in response to corrections
//   Truth-seeker — moves toward ground truth regardless of social pressure
//   Contaminator — consistently pushes false claims
//
// Group archetypes (from their paper):
//   Persistent Split — stable disagreement throughout
//   Convergence — starts split, reaches agreement
//   Divergence — starts agreed, becomes split
//   Majority Switch — majority flips from one stance to another
//   Persistent Majority — one side dominates throughout
//
// Our additions:
//   Correction Recovery — group recovers truth alignment after intervention
//   Contamination Cascade — false belief spreads progressively through group

import type { AgentSpec, ChatMessage, StanceLabel } from "../config/schema";

// --- Individual archetype types ---

export type IndividualArchetype =
  | "frozen"
  | "switcher"
  | "intermittent"
  | "oscillator"
  | "correctable"
  | "truth_seeker"
  | "contaminator";

export type AgentArchetypeResult = {
  agentId: string;
  role: string;
  archetype: IndividualArchetype;
  flipCount: number;
  finalConviction: number;
  stanceHistory: (StanceLabel | null)[];
  confidenceHistory: number[];
};

// --- Group archetype types ---

export type GroupArchetype =
  | "persistent_split"
  | "convergence"
  | "divergence"
  | "majority_switch"
  | "persistent_majority"
  | "correction_recovery"
  | "contamination_cascade";

export type GroupArchetypeResult = {
  archetype: GroupArchetype;
  magnetizationTrajectory: number[];
  splitIndex: number; // 0 = full consensus, 1 = fully split
  convergenceRound: number | null; // round where consensus was reached
  agents: AgentArchetypeResult[];
};

// --- Individual classification ---

export function classifyAgent(
  agent: AgentSpec,
  messages: ChatMessage[],
  options: {
    truthLabel?: "true" | "false" | "mixed";
    correctionRounds?: number[];
  } = {},
): AgentArchetypeResult {
  const agentMsgs = messages
    .filter((m) => m.agentId === agent.id)
    .sort((a, b) => a.round - b.round);

  const stanceHistory = agentMsgs.map((m) => m.stance);
  const confidenceHistory = agentMsgs.map((m) => m.confidence ?? 0.5);

  // Count stance flips
  let flipCount = 0;
  for (let i = 1; i < stanceHistory.length; i++) {
    if (stanceHistory[i] !== stanceHistory[i - 1] &&
        stanceHistory[i] !== null && stanceHistory[i - 1] !== null) {
      flipCount++;
    }
  }

  const finalConviction = confidenceHistory.length > 0
    ? Math.abs(2 * confidenceHistory[confidenceHistory.length - 1] - 1)
    : 0;

  const archetype = determineIndividualArchetype(
    agent,
    stanceHistory,
    flipCount,
    agentMsgs.length,
    options,
  );

  return {
    agentId: agent.id,
    role: agent.role,
    archetype,
    flipCount,
    finalConviction,
    stanceHistory,
    confidenceHistory,
  };
}

function determineIndividualArchetype(
  agent: AgentSpec,
  stanceHistory: (StanceLabel | null)[],
  flipCount: number,
  totalRounds: number,
  options: { truthLabel?: string; correctionRounds?: number[] },
): IndividualArchetype {
  // Frozen: never changes
  if (flipCount === 0) {
    // But distinguish contaminator from frozen
    if (agent.role === "contamination_agent" &&
        stanceHistory.every((s) => s === "endorse")) {
      return "contaminator";
    }
    return "frozen";
  }

  // Check if the change happened at a correction round
  if (options.correctionRounds && options.correctionRounds.length > 0 && flipCount <= 2) {
    const flipRounds = findFlipRounds(stanceHistory);
    const correctionSet = new Set(options.correctionRounds);
    const correctionAligned = flipRounds.some((r) =>
      correctionSet.has(r) || correctionSet.has(r - 1),
    );
    if (correctionAligned) return "correctable";
  }

  // Truth-seeker: ended at truth-aligned stance and moved there despite starting elsewhere
  if (options.truthLabel && options.truthLabel !== "mixed") {
    const finalStance = stanceHistory[stanceHistory.length - 1];
    const initialStance = stanceHistory[0];
    const truthStance: StanceLabel = options.truthLabel === "true" ? "endorse" : "reject";
    if (finalStance === truthStance && initialStance !== truthStance) {
      return "truth_seeker";
    }
  }

  // Contaminator: role is contamination and maintained endorse throughout
  if (agent.role === "contamination_agent") {
    const endorseRate = stanceHistory.filter((s) => s === "endorse").length / Math.max(1, stanceHistory.length);
    if (endorseRate > 0.7) return "contaminator";
  }

  // Oscillator: flips frequently (more than 40% of rounds)
  if (totalRounds > 2 && flipCount / (totalRounds - 1) > 0.4) {
    return "oscillator";
  }

  // Switcher: changes once and stays
  if (flipCount === 1) return "switcher";

  // Intermittent: changes multiple times but not rapidly
  return "intermittent";
}

function findFlipRounds(stanceHistory: (StanceLabel | null)[]): number[] {
  const rounds: number[] = [];
  for (let i = 1; i < stanceHistory.length; i++) {
    if (stanceHistory[i] !== stanceHistory[i - 1] &&
        stanceHistory[i] !== null && stanceHistory[i - 1] !== null) {
      rounds.push(i + 1); // 1-indexed rounds
    }
  }
  return rounds;
}

// --- Group classification ---

export function classifyGroup(
  agents: AgentSpec[],
  messages: ChatMessage[],
  options: {
    truthLabel?: "true" | "false" | "mixed";
    correctionRounds?: number[];
  } = {},
): GroupArchetypeResult {
  const rounds = Math.max(0, ...messages.map((m) => m.round));

  // Classify each agent
  const agentResults = agents.map((a) => classifyAgent(a, messages, options));

  // Compute magnetization trajectory (endorsement rate mapped to [-1, 1])
  const magnetization: number[] = [];
  for (let r = 1; r <= rounds; r++) {
    const roundMsgs = messages.filter((m) => m.round === r);
    const spins: number[] = roundMsgs.map((m) => {
      if (m.stance === "endorse") return 1;
      if (m.stance === "reject") return -1;
      return 0;
    });
    magnetization.push(spins.length > 0 ? spins.reduce((a, b) => a + b, 0) / spins.length : 0);
  }

  // Compute split index at each round (1 - |magnetization|, normalized)
  const splitIndices = magnetization.map((m) => 1 - Math.abs(m));
  const finalSplit = splitIndices.length > 0 ? splitIndices[splitIndices.length - 1] : 0;
  const initialSplit = splitIndices.length > 0 ? splitIndices[0] : 0;

  // Find convergence round (first round where |m| > 0.7)
  let convergenceRound: number | null = null;
  for (let i = 0; i < magnetization.length; i++) {
    if (Math.abs(magnetization[i]) > 0.7) {
      convergenceRound = i + 1;
      break;
    }
  }

  const archetype = determineGroupArchetype(
    magnetization,
    initialSplit,
    finalSplit,
    agentResults,
    options,
  );

  return {
    archetype,
    magnetizationTrajectory: magnetization,
    splitIndex: finalSplit,
    convergenceRound,
    agents: agentResults,
  };
}

function determineGroupArchetype(
  magnetization: number[],
  initialSplit: number,
  finalSplit: number,
  agentResults: AgentArchetypeResult[],
  options: { truthLabel?: string; correctionRounds?: number[] },
): GroupArchetype {
  if (magnetization.length < 2) return "persistent_majority";

  const initialM = magnetization[0];
  const finalM = magnetization[magnetization.length - 1];
  const midpoint = Math.floor(magnetization.length / 2);
  const midM = magnetization[midpoint];

  // Correction recovery: was endorsing false claim, got corrected, now rejects
  if (options.correctionRounds && options.correctionRounds.length > 0 && options.truthLabel === "false") {
    const preCorrection = magnetization.slice(0, Math.min(magnetization.length, options.correctionRounds[0]));
    const postCorrection = magnetization.slice(options.correctionRounds[0]);
    const preAvg = preCorrection.length > 0 ? mean(preCorrection) : 0;
    const postAvg = postCorrection.length > 0 ? mean(postCorrection) : 0;
    if (preAvg > 0.3 && postAvg < preAvg - 0.3) {
      return "correction_recovery";
    }
  }

  // Contamination cascade: magnetization monotonically increases toward endorsement of false claim
  if (options.truthLabel === "false") {
    let isMonotonic = true;
    for (let i = 1; i < magnetization.length; i++) {
      if (magnetization[i] < magnetization[i - 1] - 0.1) {
        isMonotonic = false;
        break;
      }
    }
    if (isMonotonic && finalM > initialM + 0.3) {
      return "contamination_cascade";
    }
  }

  // Convergence: starts split, ends in consensus
  if (initialSplit > 0.4 && finalSplit < 0.3) return "convergence";

  // Divergence: starts consensus, ends split
  if (initialSplit < 0.3 && finalSplit > 0.4) return "divergence";

  // Majority switch: sign of magnetization flips
  if (Math.sign(initialM) !== Math.sign(finalM) && Math.abs(initialM) > 0.3 && Math.abs(finalM) > 0.3) {
    return "majority_switch";
  }

  // Persistent split: stays split throughout
  if (mean(magnetization.map((m) => 1 - Math.abs(m))) > 0.4) return "persistent_split";

  // Persistent majority: one side dominates
  return "persistent_majority";
}

// --- Helpers ---

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
