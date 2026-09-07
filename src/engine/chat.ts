// Chat/debate engine: multi-round agent conversations about claims.
//
// Each "step" is a full debate session where ALL agents participate over N rounds.
// Agents see each other's messages filtered by the communication topology.
// After the final round, committed stances are recorded for metrics.

import type {
  AgentSpec,
  ChatMessage,
  Condition,
  MemoryEntry,
  Scenario,
  StanceLabel,
  Topology,
} from "../config/schema";
import type { ProviderConfig } from "../llm/provider";
import { callLLM, estimateTokenCount } from "../llm/client";
import {
  buildChatRoundPrompt,
  buildChatSystemPrompt,
  parseChatResponse,
} from "../llm/prompts";

// --- Topology filtering ---

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
    // Agent 0 is the hub — sees all. Others see only the hub.
    if (agentIndex === 0) {
      return messages.filter((m) => m.agentId !== agent.id);
    }
    return messages.filter((m) => m.agentId === agents[0].id);
  }

  if (topology === "chain") {
    // Each agent sees only the agent before them in the list
    if (agentIndex === 0) return [];
    const prevAgent = agents[agentIndex - 1];
    return messages.filter((m) => m.agentId === prevAgent.id);
  }

  if (topology === "ring") {
    // Like chain but wraps around — agent 0 sees last agent
    const prevIndex = (agentIndex - 1 + agents.length) % agents.length;
    const prevAgent = agents[prevIndex];
    return messages.filter((m) => m.agentId === prevAgent.id);
  }

  return messages.filter((m) => m.agentId !== agent.id);
}

// --- Adaptive stopping: detect stance stability ---

function isStable(messages: ChatMessage[], agents: AgentSpec[], minRounds: number): boolean {
  if (minRounds < 2) return false;

  // Check if all agents' stances haven't changed between the last two rounds
  const lastRound = Math.max(...messages.map((m) => m.round));
  if (lastRound < 2) return false;

  for (const agent of agents) {
    const currentStance = messages.find(
      (m) => m.agentId === agent.id && m.round === lastRound,
    )?.stance;
    const prevStance = messages.find(
      (m) => m.agentId === agent.id && m.round === lastRound - 1,
    )?.stance;

    if (!currentStance || !prevStance) return false;
    if (currentStance !== prevStance) return false;
  }
  return true;
}

// --- Main debate runner ---

export type ChatDebateResult = {
  messages: ChatMessage[];
  finalStances: Map<string, { stance: StanceLabel; confidence: number; reasoning: string }>;
  roundsCompleted: number;
  stoppedEarly: boolean;
  usageLogs: Array<{
    round: number;
    agentId: string;
    claimId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
  }>;
};

export type OnChatMessage = (msg: ChatMessage, round: number, totalRounds: number) => void;

export async function runChatDebate(
  agents: AgentSpec[],
  providerMap: Map<string, ProviderConfig>,
  claim: { id: string; text: string; truthLabel: string },
  scenario: Scenario,
  condition: Condition,
  activeInterventions: Scenario["scheduledInterventions"],
  options: {
    chatRounds: number;
    topology: Topology;
    onMessage?: OnChatMessage;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    temperature?: number;
  },
): Promise<ChatDebateResult> {
  const { chatRounds, topology, onMessage } = options;
  const allMessages: ChatMessage[] = [];
  const finalStances = new Map<string, { stance: StanceLabel; confidence: number; reasoning: string }>();
  const usageLogs: ChatDebateResult["usageLogs"] = [];
  let stoppedEarly = false;

  for (let round = 1; round <= chatRounds; round++) {
    const isFinalRound = round === chatRounds;

    // Check adaptive stopping after round 2
    if (round > 2 && isStable(allMessages, agents, round)) {
      stoppedEarly = true;
      // Copy last round's stances as final
      for (const agent of agents) {
        const lastMsg = allMessages.find(
          (m) => m.agentId === agent.id && m.round === round - 1,
        );
        if (lastMsg?.stance) {
          finalStances.set(agent.id, {
            stance: lastMsg.stance,
            confidence: lastMsg.confidence ?? 0.5,
            reasoning: lastMsg.text,
          });
        }
      }
      break;
    }

    for (const agent of agents) {
      const provider = providerMap.get(agent.id)!;
      const visibleMessages = filterByTopology(allMessages, agent, agents, topology);

      const activeCorrections = activeInterventions
        .filter((i) => i.claimId === claim.id)
        .map((i) => ({ id: i.id, text: i.text, effect: i.effect }));

      const systemPrompt = buildChatSystemPrompt(agent, scenario, condition, condition.interaction.chatStyle);
      const userPrompt = buildChatRoundPrompt({
        agent,
        claim,
        scenario,
        condition,
        priorMessages: visibleMessages,
        activeCorrections,
        round,
        totalRounds: chatRounds,
        isFinalRound,
      });

      console.log(
        `[chat] waiting on model call: run=${scenario.id} agent=${agent.id} role=${agent.role} model=${provider.model} round=${round}/${chatRounds} visible_messages=${visibleMessages.length}`,
      );

      let rawResponse: string;
      try {
        const promptEstimate = estimateTokenCount(`${systemPrompt}\n${userPrompt}`);
        if (typeof options.maxInputTokens === "number" && promptEstimate > options.maxInputTokens) {
          throw new Error(
            `Prompt token estimate ${promptEstimate} exceeds per-call cap ${options.maxInputTokens} for agent "${agent.id}" in chat.`,
          );
        }
        const response = await callLLM(provider, {
          systemPrompt,
          userPrompt,
          maxTokens: options.maxOutputTokens ?? 512,
          temperature: options.temperature,
        });
        rawResponse = response.text;
        usageLogs.push({
          round,
          agentId: agent.id,
          claimId: claim.id,
          model: provider.model,
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          estimatedCostUsd: response.estimatedCostUsd,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `[chat] model call failed: scenario=${scenario.id} claim=${claim.id} agent=${agent.id} role=${agent.role} model=${provider.model} round=${round}/${chatRounds}: ${message}`,
        );
      }
      const parsed = parseChatResponse(rawResponse);

      const chatMsg: ChatMessage = {
        round,
        agentId: agent.id,
        claimId: claim.id,
        text: parsed.message,
        messageType: parsed.messageType,
        stance: parsed.stance,
        confidence: parsed.confidence,
        citedSourceIds: parsed.citedSourceIds,
        referencedClaimIds: parsed.referencedClaimIds,
      };

      allMessages.push(chatMsg);
      onMessage?.(chatMsg, round, chatRounds);

      // On final round, record committed stances
      if (isFinalRound) {
        finalStances.set(agent.id, {
          stance: parsed.stance,
          confidence: parsed.confidence,
          reasoning: parsed.message,
        });
      }
    }
  }

  // Ensure all agents have final stances (fallback for early stop edge cases)
  for (const agent of agents) {
    if (!finalStances.has(agent.id)) {
      const lastMsg = [...allMessages].reverse().find((m) => m.agentId === agent.id);
      finalStances.set(agent.id, {
        stance: lastMsg?.stance ?? "uncertain",
        confidence: lastMsg?.confidence ?? 0.3,
        reasoning: lastMsg?.text ?? "",
      });
    }
  }

  return {
    messages: allMessages,
    finalStances,
    roundsCompleted: Math.max(...allMessages.map((m) => m.round)),
    stoppedEarly,
    usageLogs,
  };
}
