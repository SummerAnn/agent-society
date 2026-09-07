import { insertRow } from "../../db/sqlite";
import { buildMemoryText, chooseFinalGroupDecisionWithLLM, scoreClaimWithLLM } from "../../llm/score";
import { seededStanceForClaim } from "../../llm/prompts";
import { computeStepMetrics } from "../../metrics/compute";
import { isAgentActiveAtStep, visibleEvidenceForAgent } from "../../scenario/access";
import {
  buildStepSnapshot,
  latestStateForAgentClaim,
  maybeActivateTriggeredInterventions,
  persistClaimLineage,
  persistInterventionsForStep,
  persistMemoryEntry,
  persistModelCall,
  persistStepMetrics,
  persistTestimonyAdoption,
  scoreClaimHeuristic,
} from "../core";
import type { RunProgressSnapshot } from "../types";
import type {
  AgentSpec,
  BeliefStateRecord,
  Condition,
  MemoryEntry,
  RunConfig,
  Scenario,
  StepEvent,
  StepMetrics,
} from "../../config/schema";
import type { ProviderConfig } from "../../llm/provider";

type MemoryModeContext = {
  runId: string;
  runConfig: RunConfig;
  scenario: Scenario;
  condition: Condition;
  dbPath: string;
  allBeliefStates: BeliefStateRecord[];
  memoryEntries: MemoryEntry[];
  stepMetrics: StepMetrics[];
  resolvedInterventions: Scenario["scheduledInterventions"];
  retrievalCounts?: Map<string, number>;
  rng: () => number;
  onStep?: (snapshot: RunProgressSnapshot) => void;
};

function selectAgentForStep(ctx: MemoryModeContext, step: number): AgentSpec | null {
  const activeAgents = ctx.runConfig.agents.filter((candidate) => isAgentActiveAtStep(candidate, step));
  if (activeAgents.length === 0) return null;

  const configuredOrder = ctx.runConfig.turnOrder;
  if (configuredOrder && configuredOrder.length > 0) {
    const agentId = configuredOrder[(step - 1) % configuredOrder.length];
    const agent = activeAgents.find((candidate) => candidate.id === agentId);
    if (!agent) {
      throw new Error(`Turn ${step} requires active agent "${agentId}", but that agent is missing or inactive.`);
    }
    return agent;
  }

  const startOffset = ctx.runConfig.seed % activeAgents.length;
  return activeAgents[(startOffset + step - 1) % activeAgents.length];
}

function recordRetrievedEntries(ctx: MemoryModeContext, entries: MemoryEntry[]): void {
  const retrievalCounts = ctx.retrievalCounts ??= new Map<string, number>();
  for (const entry of entries) {
    retrievalCounts.set(entry.id, (retrievalCounts.get(entry.id) ?? 0) + 1);
  }
}

function seededStatementClaimForStep(agent: AgentSpec, step: number): string | null {
  const policy = agent.seedStatementPolicy;
  if (!policy || step < policy.fromStep || step > policy.untilStep) return null;
  return policy.claimId;
}

function appendMemoryEntry(ctx: MemoryModeContext, entry: MemoryEntry): void {
  const retrievalCounts = ctx.retrievalCounts ??= new Map<string, number>();
  const capacity = ctx.condition.memory.maxStoredEntries;
  if (capacity !== undefined && ctx.memoryEntries.length >= capacity) {
    const policy = ctx.condition.memory.evictionPolicy ?? "fifo";
    let candidates = [...ctx.memoryEntries];

    if (policy === "source_preserving") {
      const minimumSources = ctx.condition.memory.reservedSourceEntries ?? 0;
      const sourceCount = ctx.memoryEntries.filter((candidate) => candidate.sourceType === "evidence").length;
      if (sourceCount <= minimumSources) {
        const nonSources = candidates.filter((candidate) => candidate.sourceType !== "evidence");
        if (nonSources.length > 0) candidates = nonSources;
      }
    }

    const evicted = policy === "least_retrieved"
      ? candidates.sort((left, right) =>
        (retrievalCounts.get(left.id) ?? 0) - (retrievalCounts.get(right.id) ?? 0) || left.step - right.step,
      )[0]
      : candidates.sort((left, right) => left.step - right.step)[0];

    if (!evicted) throw new Error("Bounded record has no entry available for eviction.");
    ctx.memoryEntries.splice(ctx.memoryEntries.findIndex((candidate) => candidate.id === evicted.id), 1);
    insertRow(ctx.dbPath, "events", {
      run_id: ctx.runId,
      step_index: entry.step,
      agent_id: entry.agentId,
      event_type: "memory_evicted",
      claim_id: evicted.claimId,
      output_json: JSON.stringify({
        evictedMemoryEntryId: evicted.id,
        replacementMemoryEntryId: entry.id,
        evictionPolicy: policy,
        priorRetrievalCount: retrievalCounts.get(evicted.id) ?? 0,
      }),
    });
  }

  ctx.memoryEntries.push(entry);
  persistMemoryEntry(ctx.dbPath, ctx.runId, entry);
}

function focusStatesForProgress(
  runConfig: RunConfig,
  stepSnapshot: BeliefStateRecord[],
  focusClaimId: string,
): { agentId: string; role: string; stance: StepEvent["focusClaimStance"]; confidence: number }[] {
  return stepSnapshot
    .filter((state) => state.claimId === focusClaimId)
    .map((state) => {
      const spec = runConfig.agents.find((agent) => agent.id === state.agentId);
      return {
        agentId: state.agentId,
        role: spec?.role ?? "unknown",
        stance: state.stance,
        confidence: state.confidence,
      };
    });
}

function publishEvidenceToBoard(
  ctx: MemoryModeContext,
  agent: AgentSpec,
  claimId: string,
  step: number,
): string | null {
  if (
    ctx.condition.memory.record !== "evidence_board" &&
    ctx.condition.memory.record !== "mixed_record" &&
    ctx.condition.memory.record !== "source_aware"
  ) return null;

  let firstEntryId: string | null = null;
  for (const evidence of visibleEvidenceForAgent(ctx.scenario, agent.id, claimId, step)) {
    // One source card can bear on several candidate explanations. Store a
    // claim-specific reference so it remains retrievable for each one.
    const entryId = `${ctx.runId}-evidence-${evidence.id}-${claimId}`;
    if (ctx.memoryEntries.some((entry) => entry.id === entryId)) continue;

    const entry: MemoryEntry = {
      id: entryId,
      step,
      agentId: agent.id,
      claimId,
      stance: "uncertain",
      confidence: 0,
      visibility: "shared",
      sourceType: "evidence",
      // Keep the source-card ID in shared memory so a later agent can cite it.
      text: `[${evidence.id}] ${evidence.text}`,
    };
    appendMemoryEntry(ctx, entry);
    firstEntryId ??= entryId;
  }
  return firstEntryId;
}

function publishTaskEvidenceToBoard(
  ctx: MemoryModeContext,
  agent: AgentSpec,
  step: number,
  states: BeliefStateRecord[],
): string | null {
  // A task participant has one private card and one chance to add it to the
  // record. The former implementation copied the same card once per answer
  // choice, which silently gave one agent several record slots.
  const evidence = visibleEvidenceForAgent(ctx.scenario, agent.id, undefined, step)
    .find((candidate) => !ctx.memoryEntries.some((entry) => entry.id.includes(`-evidence-${candidate.id}-`)));
  if (!evidence) return null;

  const claimId = evidence.effects[0]?.claimId ?? ctx.scenario.focusClaimId;
  const entryId = `${ctx.runId}-evidence-${evidence.id}-${claimId}`;
  const assessments = states
    .filter((state) => ctx.scenario.groupDecision?.candidateClaimIds.includes(state.claimId))
    .map((state) => `${state.claimId}: ${state.stance}`)
    .join(", ");
  const isMixed = ctx.condition.memory.record === "mixed_record";
  const entry: MemoryEntry = {
    id: entryId,
    step,
    agentId: agent.id,
    claimId,
    stance: "uncertain",
    confidence: 0,
    visibility: "shared",
    sourceType: isMixed ? "mixed" : "evidence",
    text: isMixed
      ? `[${evidence.id}] ${evidence.text}\n${agent.id}'s current assessment: ${assessments || "undecided"}.`
      : `[${evidence.id}] ${evidence.text}`,
  };
  appendMemoryEntry(ctx, entry);
  return entryId;
}

function sourceIdFromEvidenceEntry(entry: MemoryEntry, runId: string): string | null {
  if (entry.sourceType !== "evidence" && entry.sourceType !== "mixed") return null;
  const prefix = `${runId}-evidence-`;
  const suffix = `-${entry.claimId}`;
  if (!entry.id.startsWith(prefix) || !entry.id.endsWith(suffix)) return null;
  return entry.id.slice(prefix.length, -suffix.length) || null;
}

function writeTaskAssessments(
  ctx: MemoryModeContext,
  agent: AgentSpec,
  step: number,
  states: BeliefStateRecord[],
): string | null {
  if (!ctx.scenario.groupDecision || ctx.condition.memory.record === "evidence_board") return null;
  if (!agent.canWriteMemory || ctx.condition.memory.mode !== "shared") return null;

  let firstEntryId: string | null = null;
  const seededClaimId = seededStatementClaimForStep(agent, step);
  const eligibleStates = states.filter((candidate) =>
    ctx.scenario.groupDecision?.candidateClaimIds.includes(candidate.claimId)
    && (!seededClaimId || candidate.claimId === seededClaimId),
  );
  for (const state of eligibleStates) {
    if (state.stance === "uncertain" && agent.writesMemoryThreshold > 0) continue;
    const entry: MemoryEntry = {
      id: `${ctx.runId}-assessment-${step}-${state.claimId}`,
      step,
      agentId: agent.id,
      claimId: state.claimId,
      stance: state.stance,
      confidence: state.confidence,
      visibility: "shared",
      sourceType: "agent",
      text: `${agent.id} ${state.stance}s ${state.claimId} with confidence ${state.confidence.toFixed(2)}`,
    };
    appendMemoryEntry(ctx, entry);
    firstEntryId ??= entry.id;
  }
  return firstEntryId;
}

export function runHeuristicMemoryMode(
  ctx: MemoryModeContext,
): { modelCalls: number } {
  let modelCalls = 0;
  const callsPerStep = ctx.scenario.claims.length;

  for (let step = 1; step <= ctx.runConfig.maxSteps; step += 1) {
    if (modelCalls + callsPerStep > ctx.runConfig.budget.maxModelCalls) break;

    const agent = selectAgentForStep(ctx, step);
    if (!agent) break;
    maybeActivateTriggeredInterventions(
      ctx.scenario,
      ctx.condition,
      ctx.runConfig.maxSteps,
      step,
      ctx.allBeliefStates,
      ctx.stepMetrics,
      ctx.resolvedInterventions,
    );
    const activeInterventions = ctx.resolvedInterventions.filter((intervention) => intervention.step <= step);
    const interventionFired = persistInterventionsForStep(ctx.dbPath, ctx.runId, ctx.resolvedInterventions, step);

    const stepUpdates: BeliefStateRecord[] = [];
    let focusClaimRetrievedMemoryIds: string[] = [];
    let focusClaimRetrievedMemory: MemoryEntry[] = [];

    for (const claim of ctx.scenario.claims) {
      const scored = scoreClaimHeuristic(
        agent,
        claim.id,
        ctx.scenario,
        ctx.condition,
        ctx.memoryEntries,
        activeInterventions,
        step,
        ctx.rng,
      );
      const retrievedIds = scored.retrievedMemory.map((entry) => entry.id);
      recordRetrievedEntries(ctx, scored.retrievedMemory);

      insertRow(ctx.dbPath, "retrieval_traces", {
        run_id: ctx.runId,
        step_index: step,
        agent_id: agent.id,
        claim_id: claim.id,
        retrieved_entry_ids_json: JSON.stringify(retrievedIds),
        context_json: JSON.stringify({
          role: agent.role,
          visibleEvidenceIds: visibleEvidenceForAgent(ctx.scenario, agent.id, claim.id, step).map((item) => item.id),
          interventionIds: activeInterventions.map((intervention) => intervention.id),
          reasoning: scored.reasoning,
        }),
      });

      if (claim.id === ctx.scenario.focusClaimId) {
        focusClaimRetrievedMemoryIds = retrievedIds;
        focusClaimRetrievedMemory = scored.retrievedMemory;
      }

      const state: BeliefStateRecord = {
        runId: ctx.runId,
        step,
        agentId: agent.id,
        claimId: claim.id,
        truthLabel: claim.truthLabel,
        stance: scored.stance,
        score: scored.score,
        confidence: scored.confidence,
      };
      stepUpdates.push(state);

      const previousState = latestStateForAgentClaim(ctx.allBeliefStates, agent.id, claim.id);
      const adoptedSources = scored.retrievedMemory.filter((entry) =>
        entry.agentId !== agent.id &&
        entry.claimId === claim.id &&
        entry.stance === state.stance &&
        state.stance !== "uncertain",
      );
      const adopted = adoptedSources.length > 0 && (
        !previousState ||
        previousState.stance !== state.stance ||
        previousState.confidence + 0.15 < state.confidence
      );
      if (adopted) {
        for (const source of adoptedSources) {
          persistTestimonyAdoption(
            ctx.dbPath,
            ctx.runId,
            step,
            agent.id,
            claim.id,
            state.stance,
            source.id,
            source.agentId,
            previousState?.stance ?? "uncertain",
            previousState?.confidence ?? 0,
            state.confidence,
          );
        }
      }

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

      modelCalls += 1;
    }

    const focusState = stepUpdates.find((state) => state.claimId === ctx.scenario.focusClaimId);
    let writtenMemoryEntryId: string | null = null;

    if (
      ctx.condition.memory.record === "evidence_board" ||
      ctx.condition.memory.record === "mixed_record" ||
      ctx.condition.memory.record === "source_aware"
    ) {
      writtenMemoryEntryId = publishTaskEvidenceToBoard(ctx, agent, step, stepUpdates);
    }
    writtenMemoryEntryId ??= writeTaskAssessments(ctx, agent, step, stepUpdates);
    if (ctx.condition.memory.record !== "evidence_board" && (
      focusState &&
      agent.canWriteMemory &&
      focusState.confidence >= agent.writesMemoryThreshold &&
      (focusState.stance !== "uncertain" || agent.writesMemoryThreshold === 0)
    )) {
      const memoryEntry: MemoryEntry = {
        id: `${ctx.runId}-memory-${step}`,
        step,
        agentId: agent.id,
        claimId: focusState.claimId,
        stance: focusState.stance,
        confidence: focusState.confidence,
        visibility: ctx.condition.memory.mode === "shared" ? "shared" : "personal",
        sourceType: "agent",
        text: `${agent.id} ${focusState.stance}s ${focusState.claimId} with confidence ${focusState.confidence.toFixed(2)}`,
      };
      appendMemoryEntry(ctx, memoryEntry);
      writtenMemoryEntryId = memoryEntry.id;

      for (const parent of focusClaimRetrievedMemory.filter((entry) =>
        entry.agentId !== agent.id &&
        entry.claimId === focusState.claimId &&
        entry.stance === focusState.stance,
      )) {
        persistClaimLineage(
          ctx.dbPath,
          ctx.runId,
          step,
          focusState.claimId,
          parent.id,
          memoryEntry.id,
          parent.agentId,
          agent.id,
          "memory_adoption",
        );
      }
    }

    const stepSnapshot = buildStepSnapshot(ctx.runId, step, ctx.allBeliefStates, stepUpdates);
    ctx.allBeliefStates.push(...stepUpdates);

    const event: StepEvent = {
      runId: ctx.runId,
      step,
      agentId: agent.id,
      claimId: ctx.scenario.focusClaimId,
      eventType: "agent_step",
      retrievedMemoryIds: focusClaimRetrievedMemoryIds,
      activeInterventionIds: activeInterventions.map((intervention) => intervention.id),
      writtenMemoryEntryId,
      focusClaimStance: focusState?.stance ?? "uncertain",
    };
    insertRow(ctx.dbPath, "events", {
      run_id: ctx.runId,
      step_index: step,
      agent_id: event.agentId,
      event_type: event.eventType,
      claim_id: event.claimId,
      output_json: JSON.stringify(event),
    });
    if (ctx.scenario.groupDecision && (ctx.runConfig.turnOrder?.slice(0, 4).includes(agent.id) ?? step <= 4)) {
      // Preserve what the first speakers believed before the later cards
      // entered the bounded record. The return pass below uses the same
      // final-choice prompt after all twelve turns.
      insertRow(ctx.dbPath, "events", {
        run_id: ctx.runId,
        step_index: step,
        agent_id: agent.id,
        event_type: "initial_candidate_assessment",
        claim_id: "group_decision",
        output_json: JSON.stringify({
          candidateStates: stepUpdates
            .filter((state) => ctx.scenario.groupDecision?.candidateClaimIds.includes(state.claimId))
            .map((state) => ({ claimId: state.claimId, stance: state.stance, confidence: state.confidence })),
        }),
      });
    }

    const metrics = computeStepMetrics(ctx.runId, step, stepSnapshot, ctx.scenario);
    ctx.stepMetrics.push(metrics);
    persistStepMetrics(ctx.dbPath, ctx.runId, step, metrics);

    const focusStates = focusStatesForProgress(ctx.runConfig, stepSnapshot, ctx.scenario.focusClaimId);
    ctx.onStep?.({
      runId: ctx.runId,
      step,
      maxSteps: ctx.runConfig.maxSteps,
      modelCalls,
      maxModelCalls: ctx.runConfig.budget.maxModelCalls,
      agentId: agent.id,
      focusClaimId: ctx.scenario.focusClaimId,
      focusClaimStance: focusState?.stance ?? "uncertain",
      retrievedMemoryCount: focusClaimRetrievedMemoryIds.length,
      wroteMemory: writtenMemoryEntryId !== null,
      interventionFired,
      metrics,
      agentStates: focusStates,
      memoryPoolSize: ctx.memoryEntries.length,
    });
  }

  return { modelCalls };
}

export async function runLlmMemoryMode(
  ctx: MemoryModeContext & { providerMap: Map<string, ProviderConfig> },
): Promise<{ modelCalls: number }> {
  let modelCalls = 0;
  let totalTokens = 0;
  const callsPerStep = ctx.scenario.claims.length;

  for (let step = 1; step <= ctx.runConfig.maxSteps; step += 1) {
    if (modelCalls + callsPerStep > ctx.runConfig.budget.maxModelCalls) break;

    const agent = selectAgentForStep(ctx, step);
    if (!agent) break;
    const provider = ctx.providerMap.get(agent.id)!;
    maybeActivateTriggeredInterventions(
      ctx.scenario,
      ctx.condition,
      ctx.runConfig.maxSteps,
      step,
      ctx.allBeliefStates,
      ctx.stepMetrics,
      ctx.resolvedInterventions,
    );
    const activeInterventions = ctx.resolvedInterventions.filter((intervention) => intervention.step <= step);
    const interventionFired = persistInterventionsForStep(ctx.dbPath, ctx.runId, ctx.resolvedInterventions, step);

    const stepUpdates: BeliefStateRecord[] = [];
    let focusClaimRetrievedMemoryIds: string[] = [];
    let focusClaimRetrievedMemory: MemoryEntry[] = [];
    let focusClaimReasoning = "";

    for (const claim of ctx.scenario.claims) {
      if (
        typeof ctx.runConfig.budget.maxTokensPerRun === "number" &&
        totalTokens >= ctx.runConfig.budget.maxTokensPerRun
      ) {
        return { modelCalls };
      }
      const previousState = latestStateForAgentClaim(ctx.allBeliefStates, agent.id, claim.id);
      const llmResult = await scoreClaimWithLLM(
        provider,
        agent,
        claim.id,
        ctx.scenario,
        ctx.condition,
        ctx.memoryEntries,
        activeInterventions,
        previousState,
        ctx.rng,
        {
          maxInputTokens: ctx.runConfig.budget.maxInputTokensPerCall,
          maxOutputTokens: ctx.runConfig.budget.maxOutputTokensPerCall,
          temperature: ctx.runConfig.budget.temperature,
          currentStep: step,
        },
      );
      const forcedStance = seededStanceForClaim(agent, claim.id, step);
      const stance = forcedStance ?? llmResult.stance;
      const confidence = forcedStance ? 0.95 : llmResult.confidence;
      const score = stance === "endorse" ? confidence : stance === "reject" ? -confidence : 0;
      const retrievedIds = llmResult.retrievedMemory.map((entry) => entry.id);
      recordRetrievedEntries(ctx, llmResult.retrievedMemory);
      const retrievedSourceIds = llmResult.retrievedMemory
        .map((entry) => sourceIdFromEvidenceEntry(entry, ctx.runId))
        .filter((sourceId): sourceId is string => sourceId !== null);
      const reasoning = forcedStance
        ? `Configured informed-false statement: ${agent.id} publicly ${forcedStance}s this claim.`
        : llmResult.reasoning;

      if (forcedStance) {
        insertRow(ctx.dbPath, "events", {
          run_id: ctx.runId, step_index: step, agent_id: agent.id, event_type: "forced_seed_statement", claim_id: claim.id,
          output_json: JSON.stringify({ stance: forcedStance, confidence, mode: "informed_false_statement" }),
        });
      }

      if (claim.id === ctx.scenario.focusClaimId) {
        focusClaimReasoning = reasoning;
        focusClaimRetrievedMemoryIds = retrievedIds;
        focusClaimRetrievedMemory = llmResult.retrievedMemory;
      }

      insertRow(ctx.dbPath, "retrieval_traces", {
        run_id: ctx.runId,
        step_index: step,
        agent_id: agent.id,
        claim_id: claim.id,
        retrieved_entry_ids_json: JSON.stringify(retrievedIds),
        context_json: JSON.stringify({
          role: agent.role,
          visibleEvidenceIds: visibleEvidenceForAgent(ctx.scenario, agent.id, claim.id, step).map((item) => item.id),
          retrievedSourceIds,
          interventionIds: activeInterventions.map((intervention) => intervention.id),
          priorStance: previousState?.stance ?? null,
          priorConfidence: previousState?.confidence ?? null,
          verificationCue: llmResult.verificationCue,
          responseParseValid: llmResult.parseValid,
          rawResponse: llmResult.rawResponse,
          reasoning,
          citedSourceIds: llmResult.citedSourceIds,
          engineMode: "llm",
        }),
      });

      persistModelCall(
        ctx.dbPath,
        ctx.runId,
        step,
        agent.id,
        claim.id,
        provider.model,
        llmResult.usage.promptTokens,
        llmResult.usage.completionTokens,
        llmResult.usage.totalTokens,
        llmResult.estimatedCostUsd,
      );
      totalTokens += llmResult.usage.totalTokens;
      modelCalls += 1;

      const state: BeliefStateRecord = {
        runId: ctx.runId,
        step,
        agentId: agent.id,
        claimId: claim.id,
        truthLabel: claim.truthLabel,
        stance,
        score,
        confidence,
      };
      stepUpdates.push(state);

      const adoptedSources = llmResult.retrievedMemory.filter((entry) =>
        entry.agentId !== agent.id &&
        entry.claimId === claim.id &&
        entry.stance === state.stance &&
        state.stance !== "uncertain",
      );
      const adopted = adoptedSources.length > 0 && (
        !previousState ||
        previousState.stance !== state.stance ||
        previousState.confidence + 0.15 < state.confidence
      );
      if (adopted) {
        for (const source of adoptedSources) {
          persistTestimonyAdoption(
            ctx.dbPath,
            ctx.runId,
            step,
            agent.id,
            claim.id,
            state.stance,
            source.id,
            source.agentId,
            previousState?.stance ?? "uncertain",
            previousState?.confidence ?? 0,
            state.confidence,
          );
        }
      }

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
    }

    const focusState = stepUpdates.find((state) => state.claimId === ctx.scenario.focusClaimId);
    let writtenMemoryEntryId: string | null = null;
    if (
      ctx.condition.memory.record === "evidence_board" ||
      ctx.condition.memory.record === "mixed_record" ||
      ctx.condition.memory.record === "source_aware"
    ) {
      writtenMemoryEntryId = publishTaskEvidenceToBoard(ctx, agent, step, stepUpdates);
    }
    writtenMemoryEntryId ??= writeTaskAssessments(ctx, agent, step, stepUpdates);
    if (
      ctx.condition.memory.record !== "evidence_board"
      && focusState
      && focusState.stance !== "uncertain"
      && agent.canWriteMemory
    ) {
      const memoryEntry: MemoryEntry = {
        id: `${ctx.runId}-memory-${step}`,
        step,
        agentId: agent.id,
        claimId: focusState.claimId,
        stance: focusState.stance,
        confidence: focusState.confidence,
        visibility: ctx.condition.memory.mode === "shared" ? "shared" : "personal",
        sourceType: "agent",
        text: buildMemoryText(agent.id, focusState.claimId, focusState.stance, focusState.confidence, focusClaimReasoning),
      };
      appendMemoryEntry(ctx, memoryEntry);
      writtenMemoryEntryId = memoryEntry.id;

      for (const parent of focusClaimRetrievedMemory.filter((entry) =>
        entry.agentId !== agent.id &&
        entry.claimId === focusState.claimId &&
        entry.stance === focusState.stance,
      )) {
        persistClaimLineage(
          ctx.dbPath,
          ctx.runId,
          step,
          focusState.claimId,
          parent.id,
          memoryEntry.id,
          parent.agentId,
          agent.id,
          "memory_adoption",
        );
      }
    }

    const stepSnapshot = buildStepSnapshot(ctx.runId, step, ctx.allBeliefStates, stepUpdates);
    ctx.allBeliefStates.push(...stepUpdates);

    const event: StepEvent = {
      runId: ctx.runId,
      step,
      agentId: agent.id,
      claimId: ctx.scenario.focusClaimId,
      eventType: "agent_step",
      retrievedMemoryIds: focusClaimRetrievedMemoryIds,
      activeInterventionIds: activeInterventions.map((intervention) => intervention.id),
      writtenMemoryEntryId,
      focusClaimStance: focusState?.stance ?? "uncertain",
    };
    insertRow(ctx.dbPath, "events", {
      run_id: ctx.runId,
      step_index: step,
      agent_id: event.agentId,
      event_type: event.eventType,
      claim_id: event.claimId,
      output_json: JSON.stringify(event),
    });
    if (ctx.scenario.groupDecision && (ctx.runConfig.turnOrder?.slice(0, 4).includes(agent.id) ?? step <= 4)) {
      insertRow(ctx.dbPath, "events", {
        run_id: ctx.runId,
        step_index: step,
        agent_id: agent.id,
        event_type: "initial_candidate_assessment",
        claim_id: "group_decision",
        output_json: JSON.stringify({
          candidateStates: stepUpdates
            .filter((state) => ctx.scenario.groupDecision?.candidateClaimIds.includes(state.claimId))
            .map((state) => ({ claimId: state.claimId, stance: state.stance, confidence: state.confidence })),
        }),
      });
    }

    const metrics = computeStepMetrics(ctx.runId, step, stepSnapshot, ctx.scenario);
    ctx.stepMetrics.push(metrics);
    persistStepMetrics(ctx.dbPath, ctx.runId, step, metrics);

    const focusStates = focusStatesForProgress(ctx.runConfig, stepSnapshot, ctx.scenario.focusClaimId);
    ctx.onStep?.({
      runId: ctx.runId,
      step,
      maxSteps: ctx.runConfig.maxSteps,
      modelCalls,
      maxModelCalls: ctx.runConfig.budget.maxModelCalls,
      agentId: agent.id,
      focusClaimId: ctx.scenario.focusClaimId,
      focusClaimStance: focusState?.stance ?? "uncertain",
      retrievedMemoryCount: focusClaimRetrievedMemoryIds.length,
      wroteMemory: writtenMemoryEntryId !== null,
      interventionFired,
      metrics,
      agentStates: focusStates,
      memoryPoolSize: ctx.memoryEntries.length,
    });
  }

  if (ctx.scenario.groupDecision) {
    const finalStep = ctx.stepMetrics.at(-1)?.step ?? 1;
    const returnIds = ctx.runConfig.turnOrder?.slice(0, 4) ?? ctx.runConfig.agents.slice(0, 4).map((agent) => agent.id);
    if (modelCalls + returnIds.length + ctx.runConfig.agents.length > ctx.runConfig.budget.maxModelCalls) {
      throw new Error("Group-decision return and final passes exceed the configured model-call budget.");
    }
    for (const agentId of returnIds) {
      const agent = ctx.runConfig.agents.find((candidate) => candidate.id === agentId)!;
      const provider = ctx.providerMap.get(agent.id)!;
      const choice = await chooseFinalGroupDecisionWithLLM(provider, agent, ctx.scenario, ctx.condition, ctx.memoryEntries, finalStep, { maxOutputTokens: ctx.runConfig.budget.maxOutputTokensPerCall, temperature: ctx.runConfig.budget.temperature });
      insertRow(ctx.dbPath, "events", { run_id: ctx.runId, step_index: finalStep, agent_id: agent.id, event_type: "return_group_choice", claim_id: choice.selectedClaimId ?? "none", output_json: JSON.stringify(choice) });
      persistModelCall(ctx.dbPath, ctx.runId, finalStep, agent.id, "return_group_choice", provider.model, choice.usage.promptTokens, choice.usage.completionTokens, choice.usage.totalTokens, choice.estimatedCostUsd);
      modelCalls += 1;
    }
    for (const agent of ctx.runConfig.agents) {
      const provider = ctx.providerMap.get(agent.id)!;
      const choice = await chooseFinalGroupDecisionWithLLM(provider, agent, ctx.scenario, ctx.condition, ctx.memoryEntries, finalStep, { maxOutputTokens: ctx.runConfig.budget.maxOutputTokensPerCall, temperature: ctx.runConfig.budget.temperature });
      insertRow(ctx.dbPath, "events", { run_id: ctx.runId, step_index: finalStep, agent_id: agent.id, event_type: "final_group_choice", claim_id: choice.selectedClaimId ?? "none", output_json: JSON.stringify(choice) });
      persistModelCall(ctx.dbPath, ctx.runId, finalStep, agent.id, "final_group_choice", provider.model, choice.usage.promptTokens, choice.usage.completionTokens, choice.usage.totalTokens, choice.estimatedCostUsd);
      modelCalls += 1;
    }
  }
  return { modelCalls };
}
