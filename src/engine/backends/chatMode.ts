import { insertRow } from "../../db/sqlite";
import { buildMemoryText } from "../../llm/score";
import { chooseFinalGroupDecisionWithLLM } from "../../llm/score";
import { parseLastJsonObject } from "../../llm/json";
import { seededChoiceForStep } from "../../llm/prompts";
import { callLLM } from "../../llm/client";
import { computeStepMetrics } from "../../metrics/compute";
import { analyzeDebate, type PhysicsReport } from "../../physics/analyze";
import { isAgentActiveAtStep } from "../../scenario/access";
import { visibleEvidenceForAgent } from "../../scenario/access";
import { runChatDebate } from "../chat";
import {
  buildStepSnapshot,
  persistModelCall,
  maybeActivateTriggeredInterventions,
  persistInterventionsForStep,
  persistMemoryEntry,
  persistStepMetrics,
} from "../core";
import type { RunProgressSnapshot } from "../types";
import type {
  BeliefStateRecord,
  Condition,
  MemoryEntry,
  RunConfig,
  Scenario,
  StepMetrics,
} from "../../config/schema";
import type { ProviderConfig } from "../../llm/provider";

type ChatModeContext = {
  runId: string;
  runConfig: RunConfig;
  scenario: Scenario;
  condition: Condition;
  dbPath: string;
  providerMap: Map<string, ProviderConfig>;
  allBeliefStates: BeliefStateRecord[];
  memoryEntries: MemoryEntry[];
  stepMetrics: StepMetrics[];
  resolvedInterventions: Scenario["scheduledInterventions"];
  onStep?: (snapshot: RunProgressSnapshot) => void;
  onChatMessage?: Parameters<typeof runChatDebate>[6]["onMessage"];
};

export async function runChatMode(
  ctx: ChatModeContext,
): Promise<{ modelCalls: number; latestPhysicsReport: PhysicsReport | null }> {
  if (ctx.scenario.groupDecision) {
    return runBoundedTaskChatMode(ctx);
  }
  const focusClaim = ctx.scenario.claims.find((claim) => claim.id === ctx.scenario.focusClaimId)!;
  let modelCalls = 0;
  let totalTokens = 0;
  let latestPhysicsReport: PhysicsReport | null = null;

  for (let step = 1; step <= ctx.runConfig.maxSteps; step += 1) {
    const activeAgents = ctx.runConfig.agents.filter((agent) => isAgentActiveAtStep(agent, step));
    if (activeAgents.length === 0) break;
    const callsPerStep = activeAgents.length * ctx.condition.interaction.chatRounds;
    if (ctx.runConfig.budget.maxModelCalls < callsPerStep && modelCalls === 0) {
      throw new Error(
        `Chat run budget too small: need at least ${callsPerStep} model calls for one round ` +
        `(${activeAgents.length} active agents x ${ctx.condition.interaction.chatRounds} chat rounds), ` +
        `but budget is ${ctx.runConfig.budget.maxModelCalls}.`,
      );
    }
    if (modelCalls + callsPerStep > ctx.runConfig.budget.maxModelCalls) break;
    if (
      typeof ctx.runConfig.budget.maxTokensPerRun === "number" &&
      totalTokens >= ctx.runConfig.budget.maxTokensPerRun
    ) break;

    maybeActivateTriggeredInterventions(
      ctx.scenario,
      ctx.condition,
      ctx.runConfig.maxSteps,
      step,
      ctx.allBeliefStates,
      ctx.stepMetrics,
      ctx.resolvedInterventions,
    );
    const activeInterventions = ctx.resolvedInterventions.filter((item) => item.step <= step);
    const interventionFired = persistInterventionsForStep(ctx.dbPath, ctx.runId, ctx.resolvedInterventions, step);

    const debateResult = await runChatDebate(
      activeAgents,
      ctx.providerMap,
      focusClaim,
      ctx.scenario,
      ctx.condition,
      activeInterventions,
      {
        chatRounds: ctx.condition.interaction.chatRounds,
        topology: ctx.condition.interaction.topology,
        onMessage: ctx.onChatMessage,
        maxInputTokens: ctx.runConfig.budget.maxInputTokensPerCall,
        maxOutputTokens: ctx.runConfig.budget.maxOutputTokensPerCall,
        temperature: ctx.runConfig.budget.temperature,
      },
    );

    for (const usage of debateResult.usageLogs) {
      persistModelCall(
        ctx.dbPath,
        ctx.runId,
        step,
        usage.agentId,
        usage.claimId,
        usage.model,
        usage.promptTokens,
        usage.completionTokens,
        usage.totalTokens,
        usage.estimatedCostUsd,
      );
      totalTokens += usage.totalTokens;
    }

    for (const message of debateResult.messages) {
      insertRow(ctx.dbPath, "chat_messages", {
        run_id: ctx.runId,
        step_index: step,
        round: message.round,
        agent_id: message.agentId,
        claim_id: message.claimId,
        message_type: message.messageType ?? null,
        message_text: message.text,
        stance: message.stance,
        confidence: message.confidence,
        cited_source_ids_json: JSON.stringify(message.citedSourceIds ?? []),
        referenced_claim_ids_json: JSON.stringify(message.referencedClaimIds ?? []),
      });
    }

    const stepUpdates: BeliefStateRecord[] = [];
    let wroteAnyMemory = false;
    for (const agent of activeAgents) {
      const finalStance = debateResult.finalStances.get(agent.id);
      const stance = finalStance?.stance ?? "uncertain";
      const confidence = finalStance?.confidence ?? 0.3;
      const score = stance === "endorse" ? confidence : stance === "reject" ? -confidence : 0;

      const state: BeliefStateRecord = {
        runId: ctx.runId,
        step,
        agentId: agent.id,
        claimId: focusClaim.id,
        truthLabel: focusClaim.truthLabel,
        stance,
        score,
        confidence,
      };
      stepUpdates.push(state);

      insertRow(ctx.dbPath, "agent_claim_states", {
        run_id: state.runId,
        step_index: state.step,
        agent_id: state.agentId,
        claim_id: state.claimId,
        truth_label: state.truthLabel,
        stance: state.stance,
        score: state.score,
        confidence: state.confidence,
      });

      if (stance !== "uncertain" && finalStance && agent.canWriteMemory) {
        const memoryEntry: MemoryEntry = {
          id: `${ctx.runId}-memory-${step}-${agent.id}`,
          step,
          agentId: agent.id,
          claimId: focusClaim.id,
          stance,
          confidence,
          visibility: ctx.condition.memory.mode === "shared" ? "shared" : "personal",
          sourceType: "agent",
          text: buildMemoryText(agent.id, focusClaim.id, stance, confidence, finalStance.reasoning),
        };
        ctx.memoryEntries.push(memoryEntry);
        persistMemoryEntry(ctx.dbPath, ctx.runId, memoryEntry);
        wroteAnyMemory = true;
      }

      insertRow(ctx.dbPath, "events", {
        run_id: ctx.runId,
        step_index: step,
        agent_id: agent.id,
        event_type: "chat_debate",
        claim_id: focusClaim.id,
        output_json: JSON.stringify({
          runId: ctx.runId,
          step,
          agentId: agent.id,
          claimId: focusClaim.id,
          eventType: "chat_debate",
          focusClaimStance: stance,
          roundsCompleted: debateResult.roundsCompleted,
          stoppedEarly: debateResult.stoppedEarly,
        }),
      });
    }

    const stepSnapshot = buildStepSnapshot(ctx.runId, step, ctx.allBeliefStates, stepUpdates);
    ctx.allBeliefStates.push(...stepUpdates);

    const metrics = computeStepMetrics(ctx.runId, step, stepSnapshot, ctx.scenario);
    ctx.stepMetrics.push(metrics);
    persistStepMetrics(ctx.dbPath, ctx.runId, step, metrics);
    modelCalls += debateResult.usageLogs.length;

    latestPhysicsReport = analyzeDebate(
      ctx.runId,
      activeAgents,
      debateResult.messages,
      ctx.scenario,
      ctx.condition,
      { seed: ctx.runConfig.seed },
    );

    insertRow(ctx.dbPath, "physics_reports", {
      run_id: ctx.runId,
      step_index: step,
      topology: ctx.condition.interaction.topology,
      regime_predicted: latestPhysicsReport.divergence.predictedRegime,
      regime_actual: latestPhysicsReport.divergence.actualRegime,
      regime_match: latestPhysicsReport.divergence.regimeMatch ? 1 : 0,
      vanilla_rmse: latestPhysicsReport.divergence.vanillaRMSE,
      extended_rmse: latestPhysicsReport.divergence.extendedRMSE,
      improvement_ratio: latestPhysicsReport.divergence.improvementRatio,
      ising_explained_rate: latestPhysicsReport.decomposition.isingExplainedRate,
      truth_asymmetry_ratio: latestPhysicsReport.decomposition.truthAsymmetry.asymmetryRatio,
      group_archetype: latestPhysicsReport.archetypes.archetype,
      critical_temperature: latestPhysicsReport.criticalTemperature,
      correction_effect: latestPhysicsReport.interventionAnalysis?.correctionEffect ?? null,
      correction_surprise: latestPhysicsReport.interventionAnalysis?.correctionSurprise ?? null,
      report_json: JSON.stringify(latestPhysicsReport),
    });

    const focusStates = stepSnapshot
      .filter((state) => state.claimId === ctx.scenario.focusClaimId)
      .map((state) => {
        const spec = ctx.runConfig.agents.find((agent) => agent.id === state.agentId);
        return { agentId: state.agentId, role: spec?.role ?? "unknown", stance: state.stance, confidence: state.confidence };
      });

    ctx.onStep?.({
      runId: ctx.runId,
      step,
      maxSteps: ctx.runConfig.maxSteps,
      modelCalls,
      maxModelCalls: ctx.runConfig.budget.maxModelCalls,
      agentId: "all",
      focusClaimId: ctx.scenario.focusClaimId,
      focusClaimStance: focusStates.find((state) => state.role === "contamination_agent")?.stance ?? "uncertain",
      retrievedMemoryCount: 0,
      wroteMemory: wroteAnyMemory,
      interventionFired,
      metrics,
      agentStates: focusStates,
      memoryPoolSize: ctx.memoryEntries.length,
    });
  }

  return { modelCalls, latestPhysicsReport };
}

function taskTurnAgent(ctx: ChatModeContext, step: number) {
  const active = ctx.runConfig.agents.filter((agent) => isAgentActiveAtStep(agent, step));
  const order = ctx.runConfig.turnOrder;
  if (order?.length) {
    const agent = active.find((candidate) => candidate.id === order[(step - 1) % order.length]);
    if (!agent) throw new Error(`Bounded chat turn ${step} has no active configured speaker.`);
    return agent;
  }
  return active[(ctx.runConfig.seed + step - 1) % active.length] ?? null;
}

function sourceIdFromMessage(text: string): string | null {
  return text.match(/^\[([^\]]+)\]/)?.[1] ?? null;
}

function parseTaskChatResponse(raw: string, candidateIds: string[], allowAbstain: boolean) {
  const parsedObject = parseLastJsonObject(raw);
  const parsed = parsedObject ?? {};
  const jsonParsed = parsedObject !== null;
  const selected = typeof parsed.selected_claim_id === "string" && candidateIds.includes(parsed.selected_claim_id)
    ? parsed.selected_claim_id : null;
  const message = String(parsed.message ?? "").replace(/\s+/g, " ").trim();
  return {
    selectedClaimId: selected,
    parseValid: jsonParsed && (selected !== null || (allowAbstain && parsed.selected_claim_id === null)),
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    message,
    citedSourceIds: Array.isArray(parsed.cited_source_ids)
      ? parsed.cited_source_ids.filter((id): id is string => typeof id === "string") : [],
  };
}

// This runner is deliberately separate from the legacy debate implementation.
// It creates a sequential, capacity-limited public thread for task experiments.
async function runBoundedTaskChatMode(
  ctx: ChatModeContext,
): Promise<{ modelCalls: number; latestPhysicsReport: PhysicsReport | null }> {
  const decision = ctx.scenario.groupDecision!;
  const candidates = decision.candidateClaimIds.map((id) => ctx.scenario.claims.find((claim) => claim.id === id)!);
  const maxStored = ctx.condition.interaction.maxStoredMessages ?? 4;
  const maxVisible = ctx.condition.interaction.maxVisibleMessages ?? 2;
  const maxWords = ctx.condition.interaction.maxMessageWords ?? 40;
  const thread: MemoryEntry[] = [];
  const earlyAgentIds = (ctx.runConfig.turnOrder?.slice(0, 4) ?? ctx.runConfig.agents.slice(0, 4).map((agent) => agent.id));
  let modelCalls = 0;

  for (let step = 1; step <= ctx.runConfig.maxSteps; step += 1) {
    if (modelCalls >= ctx.runConfig.budget.maxModelCalls) break;
    const agent = taskTurnAgent(ctx, step);
    if (!agent) break;
    const provider = ctx.providerMap.get(agent.id)!;
    const privateCards = candidates.flatMap((claim) => visibleEvidenceForAgent(ctx.scenario, agent.id, claim.id, step));
    const visibleThread = thread.slice(-maxVisible);
    const seededChoice = seededChoiceForStep(agent, candidates, step);
    let parsed: ReturnType<typeof parseTaskChatResponse>;
    let response: Awaited<ReturnType<typeof callLLM>> | null = null;
    if (seededChoice) {
      parsed = {
        selectedClaimId: seededChoice.id,
        parseValid: true,
        confidence: 0.95,
        message: `I support ${seededChoice.id}: ${seededChoice.text}`,
        citedSourceIds: [],
      };
      insertRow(ctx.dbPath, "events", {
        run_id: ctx.runId, step_index: step, agent_id: agent.id, event_type: "forced_seed_statement", claim_id: seededChoice.id,
        output_json: JSON.stringify({ selectedClaimId: seededChoice.id, confidence: 0.95, mode: "informed_false_statement" }),
      });
    } else {
      const prompt = [
        decision.instruction,
        "Choose one option using only the private card and public messages below. Do not treat repeated agent statements as independent evidence.",
        `Options:\n${candidates.map((claim) => `- ${claim.id}: ${claim.text}`).join("\n")}`,
        `Your private card:\n${privateCards.map((card) => `- [${card.id}] ${card.text}`).join("\n") || "- none"}`,
        `Newest public messages (at most ${maxVisible}):\n${visibleThread.map((entry) => `- ${entry.text}`).join("\n") || "- none"}`,
        `Return only JSON: {"selected_claim_id":"one option id","confidence":0.0,"message":"at most ${maxWords} words; include your source card ID and your current conclusion","cited_source_ids":["card_id"]}.`,
      ].join("\n\n");
      response = await callLLM(provider, {
        systemPrompt: "You are a neutral analyst in a sequential group discussion. Return compact JSON only.",
        userPrompt: prompt,
        maxTokens: ctx.runConfig.budget.maxOutputTokensPerCall ?? 256,
        temperature: ctx.runConfig.budget.temperature,
      });
      modelCalls += 1;
      parsed = parseTaskChatResponse(response.text, decision.candidateClaimIds, decision.allowAbstain);
    }
    const ownCard = privateCards[0];
    const sourcePrefix = ownCard ? `[${ownCard.id}] ${ownCard.text}` : "[no-private-card]";
    const renderedMessage = ctx.condition.memory.record === "evidence_board"
      ? sourcePrefix
      : `${sourcePrefix}\n${agent.id}: ${parsed.message || `supports ${parsed.selectedClaimId ?? "no option"}`}`;
    const entry: MemoryEntry = {
      id: `${ctx.runId}-chat-${step}-${agent.id}`,
      step,
      agentId: agent.id,
      claimId: parsed.selectedClaimId ?? candidates[0].id,
      stance: "uncertain",
      confidence: parsed.confidence,
      visibility: "shared",
      sourceType: ctx.condition.memory.record === "evidence_board" ? "evidence" : "mixed",
      text: renderedMessage,
    };
    if (thread.length >= maxStored) {
      const evicted = thread.shift()!;
      insertRow(ctx.dbPath, "events", {
        run_id: ctx.runId, step_index: step, agent_id: agent.id, event_type: "chat_message_evicted", claim_id: evicted.claimId,
        output_json: JSON.stringify({ evictedMessageId: evicted.id, replacementMessageId: entry.id, maxStoredMessages: maxStored }),
      });
    }
    thread.push(entry);
    insertRow(ctx.dbPath, "chat_messages", {
      run_id: ctx.runId, step_index: step, round: 1, agent_id: agent.id, claim_id: entry.claimId,
      message_type: "task_turn", message_text: entry.text, stance: "uncertain", confidence: entry.confidence,
      cited_source_ids_json: JSON.stringify(parsed.citedSourceIds), referenced_claim_ids_json: JSON.stringify([parsed.selectedClaimId].filter(Boolean)),
    });
    insertRow(ctx.dbPath, "events", {
      run_id: ctx.runId, step_index: step, agent_id: agent.id, event_type: "initial_group_choice", claim_id: parsed.selectedClaimId ?? "none",
      output_json: JSON.stringify({ ...parsed, privateSourceIds: privateCards.map((card) => card.id), visibleMessageIds: visibleThread.map((item) => item.id), postedMessageId: entry.id }),
    });
    if (response) {
      persistModelCall(ctx.dbPath, ctx.runId, step, agent.id, "bounded_chat_turn", provider.model, response.usage.promptTokens, response.usage.completionTokens, response.usage.totalTokens, response.estimatedCostUsd);
    }
  }

  const finalStep = Math.min(ctx.runConfig.maxSteps, ctx.runConfig.turnOrder?.length ?? ctx.runConfig.agents.length);
  // First speakers answer again after later messages have arrived. This is the
  // return pass used to measure whether their position changed.
  for (const agentId of earlyAgentIds) {
    if (modelCalls >= ctx.runConfig.budget.maxModelCalls) break;
    const agent = ctx.runConfig.agents.find((candidate) => candidate.id === agentId)!;
    const provider = ctx.providerMap.get(agent.id)!;
    const choice = await chooseFinalGroupDecisionWithLLM(provider, agent, ctx.scenario, ctx.condition, thread, finalStep, { maxOutputTokens: ctx.runConfig.budget.maxOutputTokensPerCall, temperature: ctx.runConfig.budget.temperature });
    insertRow(ctx.dbPath, "events", { run_id: ctx.runId, step_index: finalStep, agent_id: agent.id, event_type: "return_group_choice", claim_id: choice.selectedClaimId ?? "none", output_json: JSON.stringify(choice) });
    persistModelCall(ctx.dbPath, ctx.runId, finalStep, agent.id, "return_group_choice", provider.model, choice.usage.promptTokens, choice.usage.completionTokens, choice.usage.totalTokens, choice.estimatedCostUsd);
    modelCalls += 1;
  }
  for (const agent of ctx.runConfig.agents) {
    if (modelCalls >= ctx.runConfig.budget.maxModelCalls) break;
    const provider = ctx.providerMap.get(agent.id)!;
    const choice = await chooseFinalGroupDecisionWithLLM(provider, agent, ctx.scenario, ctx.condition, thread, finalStep, { maxOutputTokens: ctx.runConfig.budget.maxOutputTokensPerCall, temperature: ctx.runConfig.budget.temperature });
    insertRow(ctx.dbPath, "events", { run_id: ctx.runId, step_index: finalStep, agent_id: agent.id, event_type: "final_group_choice", claim_id: choice.selectedClaimId ?? "none", output_json: JSON.stringify(choice) });
    persistModelCall(ctx.dbPath, ctx.runId, finalStep, agent.id, "final_group_choice", provider.model, choice.usage.promptTokens, choice.usage.completionTokens, choice.usage.totalTokens, choice.estimatedCostUsd);
    modelCalls += 1;
  }
  return { modelCalls, latestPhysicsReport: null };
}
