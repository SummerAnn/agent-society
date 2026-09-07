// Causal decomposition of belief dynamics.
//
// The Ising model says agents change stances due to social coupling.
// But LLM agents can change for reasons spins can't:
//   1. Memory recall — retrieving old context that shifts belief
//   2. Argument quality — being persuaded by content, not peer pressure
//   3. Truth alignment — gravitating toward ground truth despite social pressure
//   4. Correction response — external interventions with varying effectiveness
//
// This module decomposes each stance change into these causal factors,
// producing the residual analysis that Ising models cannot capture.

import type { AgentSpec, ChatMessage, StanceLabel, Topology } from "../config/schema";

// --- Types ---

export type StanceChange = {
  agentId: string;
  round: number;
  previousStance: StanceLabel | null;
  newStance: StanceLabel | null;
  previousConfidence: number;
  newConfidence: number;
  // Causal attribution
  cause: StanceChangeCause;
};

export type StanceChangeCause =
  | "social_conformity" // Changed to match visible majority → Ising explains this
  | "anti_conformity" // Changed AGAINST visible majority → Ising can't explain
  | "truth_seeking" // Moved toward ground truth despite social pressure
  | "correction_response" // Changed after receiving a correction
  | "conviction_drift" // Confidence changed but stance stayed same
  | "stable"; // No change

export type DecompositionResult = {
  // Per-agent stance change history
  changes: StanceChange[];

  // Aggregate rates
  totalChanges: number;
  socialConformityRate: number;
  antiConformityRate: number;
  truthSeekingRate: number;
  correctionResponseRate: number;
  stabilityRate: number;

  // What fraction of behavior does Ising explain?
  isingExplainedRate: number; // social_conformity / total changes
  isingUnexplainedRate: number; // everything else / total changes

  // Per-agent breakdown
  perAgent: Map<string, {
    changes: number;
    conformity: number;
    antiConformity: number;
    truthSeeking: number;
    correctionResponse: number;
  }>;

  // Truth asymmetry measurement
  truthAsymmetry: {
    trueClaimFlipRate: number; // How often agents flip away from endorsing true claims
    falseClaimFlipRate: number; // How often agents flip away from endorsing false claims
    asymmetryRatio: number; // false/true — >1 means false claims are less stable (good)
  };
};

// --- Visible majority computation ---

function computeVisibleMajority(
  messages: ChatMessage[],
  agents: AgentSpec[],
  targetAgent: AgentSpec,
  round: number,
  topology: Topology,
): StanceLabel | null {
  // Get messages visible to this agent from previous round
  const prevRoundMsgs = messages.filter((m) => m.round === round - 1);
  if (prevRoundMsgs.length === 0) return null;

  const visibleMsgs = filterByTopology(prevRoundMsgs, targetAgent, agents, topology);
  if (visibleMsgs.length === 0) return null;

  let endorseCount = 0;
  let rejectCount = 0;
  for (const msg of visibleMsgs) {
    if (msg.stance === "endorse") endorseCount++;
    else if (msg.stance === "reject") rejectCount++;
  }

  if (endorseCount > rejectCount) return "endorse";
  if (rejectCount > endorseCount) return "reject";
  return "uncertain";
}

function filterByTopology(
  messages: ChatMessage[],
  agent: AgentSpec,
  agents: AgentSpec[],
  topology: Topology,
): ChatMessage[] {
  if (topology === "fully-connected") {
    return messages.filter((m) => m.agentId !== agent.id);
  }

  const agentIndex = agents.findIndex((a) => a.id === agent.id);

  if (topology === "star") {
    if (agentIndex === 0) return messages.filter((m) => m.agentId !== agent.id);
    return messages.filter((m) => m.agentId === agents[0].id);
  }

  if (topology === "chain") {
    if (agentIndex === 0) return [];
    return messages.filter((m) => m.agentId === agents[agentIndex - 1].id);
  }

  if (topology === "ring") {
    const prevIndex = (agentIndex - 1 + agents.length) % agents.length;
    return messages.filter((m) => m.agentId === agents[prevIndex].id);
  }

  return messages.filter((m) => m.agentId !== agent.id);
}

// --- Main decomposition ---

export function decomposeStanceChanges(
  messages: ChatMessage[],
  agents: AgentSpec[],
  topology: Topology,
  options: {
    truthLabel?: "true" | "false" | "mixed";
    correctionRounds?: number[]; // rounds where corrections were active
  } = {},
): DecompositionResult {
  const rounds = Math.max(0, ...messages.map((m) => m.round));
  const changes: StanceChange[] = [];
  const perAgent = new Map<string, { changes: number; conformity: number; antiConformity: number; truthSeeking: number; correctionResponse: number }>();

  for (const agent of agents) {
    perAgent.set(agent.id, { changes: 0, conformity: 0, antiConformity: 0, truthSeeking: 0, correctionResponse: 0 });
  }

  const truthLabel = options.truthLabel ?? "mixed";
  const correctionRounds = new Set(options.correctionRounds ?? []);

  // Track flips for truth asymmetry
  let trueClaimFlips = 0;
  let trueClaimOpportunities = 0;
  let falseClaimFlips = 0;
  let falseClaimOpportunities = 0;

  for (let round = 2; round <= rounds; round++) {
    for (const agent of agents) {
      const prevMsg = messages.find((m) => m.agentId === agent.id && m.round === round - 1);
      const currMsg = messages.find((m) => m.agentId === agent.id && m.round === round);

      if (!prevMsg || !currMsg) continue;

      const prevStance = prevMsg.stance;
      const currStance = currMsg.stance;
      const prevConf = prevMsg.confidence ?? 0.5;
      const currConf = currMsg.confidence ?? 0.5;

      const stanceChanged = prevStance !== currStance;
      const visibleMajority = computeVisibleMajority(messages, agents, agent, round, topology);

      // Truth asymmetry tracking
      if (truthLabel === "true" && prevStance === "endorse") {
        trueClaimOpportunities++;
        if (stanceChanged) trueClaimFlips++;
      }
      if (truthLabel === "false" && prevStance === "endorse") {
        falseClaimOpportunities++;
        if (stanceChanged) falseClaimFlips++;
      }

      let cause: StanceChangeCause;

      if (!stanceChanged && Math.abs(currConf - prevConf) < 0.1) {
        cause = "stable";
      } else if (!stanceChanged) {
        cause = "conviction_drift";
      } else if (correctionRounds.has(round) || correctionRounds.has(round - 1)) {
        // If a correction was active around this round, attribute to correction
        cause = "correction_response";
      } else if (visibleMajority && currStance === visibleMajority) {
        // Moved toward majority → social conformity (Ising can explain)
        cause = "social_conformity";
      } else if (visibleMajority && currStance !== visibleMajority && currStance !== "uncertain") {
        // Moved AGAINST majority
        if (truthLabel !== "mixed" && isTowardTruth(currStance, truthLabel)) {
          cause = "truth_seeking";
        } else {
          cause = "anti_conformity";
        }
      } else if (truthLabel !== "mixed" && isTowardTruth(currStance, truthLabel)) {
        cause = "truth_seeking";
      } else {
        cause = "social_conformity"; // default: attribute to social dynamics
      }

      changes.push({
        agentId: agent.id,
        round,
        previousStance: prevStance,
        newStance: currStance,
        previousConfidence: prevConf,
        newConfidence: currConf,
        cause,
      });

      const agentStats = perAgent.get(agent.id)!;
      if (stanceChanged) {
        agentStats.changes++;
        if (cause === "social_conformity") agentStats.conformity++;
        if (cause === "anti_conformity") agentStats.antiConformity++;
        if (cause === "truth_seeking") agentStats.truthSeeking++;
        if (cause === "correction_response") agentStats.correctionResponse++;
      }
    }
  }

  const totalChanges = changes.filter((c) => c.cause !== "stable" && c.cause !== "conviction_drift").length;
  const countCause = (cause: StanceChangeCause) => changes.filter((c) => c.cause === cause).length;
  const total = Math.max(1, totalChanges);

  const trueFlipRate = trueClaimOpportunities > 0 ? trueClaimFlips / trueClaimOpportunities : 0;
  const falseFlipRate = falseClaimOpportunities > 0 ? falseClaimFlips / falseClaimOpportunities : 0;

  return {
    changes,
    totalChanges,
    socialConformityRate: countCause("social_conformity") / total,
    antiConformityRate: countCause("anti_conformity") / total,
    truthSeekingRate: countCause("truth_seeking") / total,
    correctionResponseRate: countCause("correction_response") / total,
    stabilityRate: countCause("stable") / Math.max(1, changes.length),
    isingExplainedRate: countCause("social_conformity") / total,
    isingUnexplainedRate: 1 - countCause("social_conformity") / total,
    perAgent,
    truthAsymmetry: {
      trueClaimFlipRate: trueFlipRate,
      falseClaimFlipRate: falseFlipRate,
      asymmetryRatio: trueFlipRate > 0 ? falseFlipRate / trueFlipRate : falseFlipRate > 0 ? Infinity : 1,
    },
  };
}

// --- Helper ---

function isTowardTruth(stance: StanceLabel | null, truthLabel: string): boolean {
  if (!stance) return false;
  if (truthLabel === "true") return stance === "endorse";
  if (truthLabel === "false") return stance === "reject";
  return false;
}
