// LLM-backed claim scoring: replaces the heuristic scoreClaim when agents use real models.
//
// Makes one API call per (agent, claim) pair per step.
// Returns stance, confidence, reasoning, and the retrieved memories used.

import type { AgentSpec, BeliefStateRecord, Condition, MemoryEntry, Scenario, StanceLabel } from "../config/schema";
import type { ProviderConfig } from "./provider";
import { retrieveMemoryEntries } from "../memory/retrieve";
import { callLLM, estimateTokenCount, type LLMUsage } from "./client";
import { buildEvalPrompt, buildSystemMessage, parseLLMResponse } from "./prompts";
import { visibleEvidenceForAgent } from "../scenario/access";
import { parseLastJsonObject } from "./json";

export type LLMScoreOutput = {
  stance: StanceLabel;
  confidence: number;
  reasoning: string;
  citedSourceIds: string[];
  retrievedMemory: MemoryEntry[];
  verificationCue: string | null;
  rawResponse: string;
  parseValid: boolean;
  usage: LLMUsage;
  estimatedCostUsd: number | null;
};

export type FinalDecisionOutput = {
  selectedClaimId: string | null;
  // An allowed null answer is a valid abstention, while a missing or invalid
  // JSON selection is not. External-task controls need that distinction.
  parseValid: boolean;
  rawResponse: string;
  confidence: number;
  reasoning: string;
  citedSourceIds: string[];
  availableSourceIds: string[];
  usage: LLMUsage;
  estimatedCostUsd: number | null;
};

const assessmentOutputSchema = {
  type: "object",
  properties: {
    stance: { type: "string", enum: ["endorse", "reject", "uncertain"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasoning: { type: "string" },
    cited_source_ids: { type: "array", items: { type: "string" } },
  },
  required: ["stance", "confidence", "reasoning", "cited_source_ids"],
  additionalProperties: false,
};

const finalChoiceOutputSchema = {
  type: "object",
  properties: {
    selected_claim_id: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasoning: { type: "string" },
    cited_source_ids: { type: "array", items: { type: "string" } },
  },
  required: ["selected_claim_id", "confidence", "reasoning", "cited_source_ids"],
  additionalProperties: false,
};

export async function chooseFinalGroupDecisionWithLLM(
  provider: ProviderConfig,
  agent: AgentSpec,
  scenario: Scenario,
  condition: Condition,
  memoryEntries: MemoryEntry[],
  step: number,
  options: { maxOutputTokens?: number; temperature?: number } = {},
): Promise<FinalDecisionOutput> {
  const decision = scenario.groupDecision;
  if (!decision) throw new Error("Final group choice requested for a scenario without groupDecision.");
  const candidates = decision.candidateClaimIds.map((id) => scenario.claims.find((claim) => claim.id === id)!);
  const visible = candidates.flatMap((claim) => visibleEvidenceForAgent(scenario, agent.id, claim.id, step));
  const retrieved = candidates.flatMap((claim) => retrieveMemoryEntries(memoryEntries, agent.id, claim.id, condition, step));
  const availableSourceIds = [...new Set([...visible.map((item) => item.id), ...retrieved
    .filter((item) => item.sourceType === "evidence" || item.sourceType === "mixed")
    .map((item) => item.text.match(/^\[([^\]]+)\]/)?.[1])
    .filter((item): item is string => Boolean(item))])];
  const prompt = [
    decision.instruction,
    decision.allowAbstain
      ? "Use only the cards shown below. If they do not identify one explanation, return selected_claim_id as null rather than guessing."
      : "Choose exactly one explanation. Use only cards shown below and do not treat repeated agent opinions as extra evidence.",
    "Options:\n" + candidates.map((claim) => `- ${claim.id}: ${claim.text}`).join("\n"),
    `Cards and record entries available to you:\n${[...visible.map((item) => `- [${item.id}] ${item.text}`), ...retrieved.map((item) => `- ${item.text}`)].join("\n") || "- none"}`,
  ].join("\n\n");
  const response = await callLLM(provider, {
    systemPrompt: decision.allowAbstain
      ? "Return only compact JSON: {\"selected_claim_id\": \"one option id\" | null, \"confidence\": 0.0-1.0, \"reasoning\": \"at most 35 words\", \"cited_source_ids\": [\"card_id\"]}."
      : "Return only compact JSON: {\"selected_claim_id\": \"one option id\", \"confidence\": 0.0-1.0, \"reasoning\": \"at most 35 words\", \"cited_source_ids\": [\"card_id\"]}.",
    userPrompt: prompt,
    maxTokens: options.maxOutputTokens ?? 256,
    temperature: options.temperature,
    structuredOutput: {
      name: "submit_group_choice",
      description: "Submit the final choice using the required fields.",
      inputSchema: finalChoiceOutputSchema,
    },
  });
  const parsedObject = parseLastJsonObject(response.text);
  const parsed = parsedObject ?? {};
  const jsonParsed = parsedObject !== null;
  const selected = typeof parsed.selected_claim_id === "string" && decision.candidateClaimIds.includes(parsed.selected_claim_id)
    ? parsed.selected_claim_id : null;
  const validAbstention = decision.allowAbstain && parsed.selected_claim_id === null;
  const parseValid = jsonParsed && (selected !== null || validAbstention);
  const citedSourceIds = Array.isArray(parsed.cited_source_ids)
    ? [...new Set(parsed.cited_source_ids.filter((id): id is string => typeof id === "string" && availableSourceIds.includes(id)))] : [];
  return { selectedClaimId: selected, parseValid, rawResponse: response.text, confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)), reasoning: String(parsed.reasoning ?? ""), citedSourceIds, availableSourceIds, usage: response.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, estimatedCostUsd: response.estimatedCostUsd };
}

function buildVerificationCue(
  claim: { truthLabel: string },
  verification: Condition["interventions"]["verification"],
  rng: () => number,
): string | null {
  if (verification.mode === "none") return null;

  const truthDirection = claim.truthLabel === "false"
    ? "false"
    : claim.truthLabel === "true"
      ? "true"
      : null;
  if (!truthDirection) return null;

  if (verification.mode === "reliable") {
    return truthDirection === "true"
      ? "A high-reliability external verification check supports this claim."
      : "A high-reliability external verification check says this claim is likely false.";
  }

  const flipped = rng() < verification.noiseLevel;
  const observedDirection = flipped
    ? truthDirection === "true" ? "false" : "true"
    : truthDirection;

  return observedDirection === "true"
    ? `A noisy external verification check currently supports this claim. This channel can be wrong about ${Math.round(verification.noiseLevel * 100)}% of the time.`
    : `A noisy external verification check currently says this claim is likely false. This channel can be wrong about ${Math.round(verification.noiseLevel * 100)}% of the time.`;
}

// --- Main LLM scoring function ---

export async function scoreClaimWithLLM(
  provider: ProviderConfig,
  agent: AgentSpec,
  claimId: string,
  scenario: Scenario,
  condition: Condition,
  memoryEntries: MemoryEntry[],
  activeInterventions: Scenario["scheduledInterventions"],
  priorBelief: BeliefStateRecord | null,
  rng: () => number,
  options: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    temperature?: number;
    currentStep?: number;
  } = {},
): Promise<LLMScoreOutput> {
  const claim = scenario.claims.find((c) => c.id === claimId);
  if (!claim) {
    return {
      stance: "uncertain",
      confidence: 0.2,
      reasoning: "Claim not found",
      citedSourceIds: [],
      retrievedMemory: [],
      verificationCue: null,
      rawResponse: "",
      parseValid: false,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      estimatedCostUsd: null,
    };
  }

  const retrievedMemory = retrieveMemoryEntries(memoryEntries, agent.id, claimId, condition, options.currentStep);

  const activeCorrections = activeInterventions
    .filter((i) => i.claimId === claimId)
    .map((i) => ({ id: i.id, text: i.text, effect: i.effect }));

  const systemPrompt = buildSystemMessage(agent);
  const verificationCue = buildVerificationCue(claim, condition.interventions.verification, rng);
  const userPrompt = buildEvalPrompt({
    agent,
    claim,
    scenario,
    retrievedMemories: retrievedMemory,
    memoryRecord: condition.memory.record,
    currentStep: options.currentStep,
    activeCorrections,
    isFocusClaim: claimId === scenario.focusClaimId,
    priorBelief: priorBelief
      ? {
        stance: priorBelief.stance,
        confidence: priorBelief.confidence,
      }
      : null,
    verificationCue,
  });

  const promptEstimate = estimateTokenCount(`${systemPrompt}\n${userPrompt}`);
  if (typeof options.maxInputTokens === "number" && promptEstimate > options.maxInputTokens) {
    throw new Error(
      `Prompt token estimate ${promptEstimate} exceeds per-call cap ${options.maxInputTokens} for agent "${agent.id}" claim "${claimId}".`,
    );
  }

  const response = await callLLM(provider, {
    systemPrompt,
    userPrompt,
    maxTokens: options.maxOutputTokens ?? 512,
    temperature: options.temperature,
    structuredOutput: {
      name: "submit_claim_assessment",
      description: "Submit the claim assessment using the required fields.",
      inputSchema: assessmentOutputSchema,
    },
  });
  const parsed = parseLLMResponse(response.text);
  const parseValid = parseLastJsonObject(response.text) !== null;

  return {
    stance: parsed.stance,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    citedSourceIds: parsed.citedSourceIds,
    retrievedMemory,
    verificationCue,
    rawResponse: response.text,
    parseValid,
    usage: response.usage ?? {
      promptTokens: promptEstimate,
      completionTokens: estimateTokenCount(response.text),
      totalTokens: promptEstimate + estimateTokenCount(response.text),
    },
    estimatedCostUsd: response.estimatedCostUsd,
  };
}

// --- Build memory text from LLM reasoning ---

export function buildMemoryText(agentId: string, claimId: string, stance: StanceLabel, confidence: number, reasoning: string): string {
  return `[${agentId}] ${stance}s ${claimId} (conf: ${confidence.toFixed(2)}): ${reasoning}`;
}
