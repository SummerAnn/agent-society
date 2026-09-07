import fs from "fs";
import os from "os";
import path from "path";
import { vi } from "vitest";

import { inspectRun } from "../src/commands";
import type { Condition, RunConfig, Scenario, StepMetrics } from "../src/config/schema";
import { initDatabase, insertRow, queryRows } from "../src/db/sqlite";
import { initializeRunStorage, mulberry32, resolveInterventions } from "../src/engine/core";
import { runLlmMemoryMode } from "../src/engine/backends/memoryMode";
import { defineGrid, runGrid } from "../src/experiments/grid";
import { analyzeLateEvidenceGrid } from "../src/experiments/lateEvidence";
import { loadCondition, loadScenario } from "../src/config/load";
import { runExperimentSync } from "../src/engine/run";
import * as llmScore from "../src/llm/score";
import { computeStepMetrics } from "../src/metrics/compute";
import { retrieveMemoryEntries } from "../src/memory/retrieve";
import { buildChatSystemPrompt, buildEvalPrompt, parseLLMResponse } from "../src/llm/prompts";
import { parseLastJsonObject } from "../src/llm/json";

describe("multiagentworld", () => {
  it("keeps an explicit stance when a fenced JSON response is truncated", () => {
    const parsed = parseLLMResponse("```json\n{\"stance\": \"reject\", \"confidence\": 0.68, \"reasoning\": \"I do not endorse the claim");

    expect(parsed.stance).toBe("reject");
    expect(parsed.confidence).toBeCloseTo(0.68, 5);
    expect(parsed.reasoning).toContain("parse fallback");
    expect(parsed.citedSourceIds).toEqual([]);
  });

  it("keeps cited source IDs from a valid JSON response", () => {
    const parsed = parseLLMResponse('{"stance":"endorse","confidence":0.8,"reasoning":"Card W2 supports this.","cited_source_ids":["W2","W2"," ",7]}');

    expect(parsed.citedSourceIds).toEqual(["W2"]);
  });

  it("uses the final complete JSON object when a model revises its answer", () => {
    const parsed = parseLastJsonObject([
      "```json",
      '{"selected_claim_id":"option_b","confidence":0.7}',
      "```",
      "Correction: the arithmetic supports option_a.",
      "```json",
      '{"selected_claim_id":"option_a","confidence":0.95}',
      "```",
    ].join("\n"));

    expect(parsed).toMatchObject({ selected_claim_id: "option_a", confidence: 0.95 });
  });

  it("uses a temporary seeded statement without changing an agent's role", () => {
    const scenario = loadScenario(path.resolve("scenarios/ego-depletion-replication-v1.yaml"));
    const base = loadScenario(path.resolve("scenarios/ego-depletion-replication-v1.yaml"));
    const agent = {
      id: "agent_1",
      role: "neutral_analyst",
      model: "claude-haiku-4-5-20251001",
      positiveEvidenceWeight: 0.7,
      negativeEvidenceWeight: 0.45,
      socialWeight: 0.2,
      falseClaimBias: 0.95,
      correctionTrust: 0.2,
      writesMemoryThreshold: 0.45,
      activeFromStep: 1,
      canWriteMemory: true,
      seedStatementPolicy: {
        kind: "informed_false_statement" as const,
        claimId: scenario.focusClaimId,
        targetStance: "endorse" as const,
        fromStep: 1,
        untilStep: 1,
      },
    };
    const claim = scenario.claims.find((item) => item.id === scenario.focusClaimId)!;
    const condition = loadCondition(path.resolve("conditions/shared-memory-no-correction.yaml"));
    const memoryPrompt = buildEvalPrompt({ agent, claim, scenario, retrievedMemories: [], memoryRecord: condition.memory.record, activeCorrections: [], isFocusClaim: true });
    const chatPrompt = buildChatSystemPrompt(agent, base, condition, "claim-debate");

    expect(memoryPrompt).toContain("Private seeded-statement instruction");
    expect(memoryPrompt).toContain("this claim is false");
    expect(chatPrompt).toContain("neutral analyst");
  });

  it("stores a SQLite-backed run and keeps memory conditions behaviorally distinct", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-"));
    const personalConfig = path.resolve("run-configs/personal-memory-run.yaml");
    const sharedConfig = path.resolve("run-configs/shared-memory-run.yaml");

    const personalSummary = runExperimentSync(personalConfig, { outputRootOverride: tmpDir });
    const sharedSummary = runExperimentSync(sharedConfig, { outputRootOverride: tmpDir });

    expect(sharedSummary.falseClaimEndorsementRate).toBeLessThan(personalSummary.falseClaimEndorsementRate);
    expect(sharedSummary.recoveryAfterCorrection).toBeGreaterThan(personalSummary.recoveryAfterCorrection);
    expect(sharedSummary.completedSteps).toBe(personalSummary.completedSteps);
    expect(sharedSummary.evaluation).toBeNull();
    expect(fs.existsSync(personalSummary.dbPath)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(personalSummary.dbPath), "summary.json"))).toBe(true);
  });

  it("reduces the confidence of old notes before an LLM sees a decaying shared record", () => {
    const condition = loadCondition(path.resolve("conditions/shared-memory-decay-no-correction.yaml"));
    const retrieved = retrieveMemoryEntries([
      {
        id: "old-note",
        step: 1,
        agentId: "agent_1",
        claimId: "claim_false",
        stance: "endorse",
        confidence: 0.8,
        visibility: "shared",
        sourceType: "agent",
        text: "An old conclusion.",
      },
    ], "agent_2", "claim_false", condition, 9);

    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]?.confidence).toBeCloseTo(0.2, 5);
    expect(retrieved[0]?.text).toContain("recorded 8 turns ago");
  });

  it("expands repeated correction into multiple intervention events", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-"));
    const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-config-"));
    const baseConfigPath = path.resolve("run-configs/shared-memory-run.yaml");
    const baseConfig = JSON.parse(fs.readFileSync(baseConfigPath, "utf8")) as Record<string, unknown>;
    const repeatedConditionPath = path.resolve("conditions/shared-memory-repeated-correction.yaml");
    const tempConfigPath = path.join(tempConfigDir, "shared-memory-repeated-correction-run.yaml");

    baseConfig.scenarioPath = path.resolve("scenarios/ego-depletion-replication-v1.yaml");
    baseConfig.conditionPath = repeatedConditionPath;
    baseConfig.budget = { maxModelCalls: 48 };
    baseConfig.outputDir = tmpDir;
    fs.writeFileSync(tempConfigPath, `${JSON.stringify(baseConfig, null, 2)}\n`, "utf8");

    const summary = runExperimentSync(tempConfigPath, { outputRootOverride: tmpDir });
    const interventions = queryRows<{ step_index: number; intervention_id: string }>(
      summary.dbPath,
      "SELECT step_index, intervention_id FROM interventions ORDER BY step_index ASC, intervention_event_id ASC;",
    );

    expect(interventions).toHaveLength(3);
    expect(interventions.map((row) => row.step_index)).toEqual([8, 9, 10]);
    expect(interventions[1]?.intervention_id).toContain("repeat-2");
    expect(interventions[2]?.intervention_id).toContain("repeat-3");
  });

  it("returns structured inspection data from a trace database", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-"));
    const sharedConfig = path.resolve("run-configs/shared-memory-run.yaml");
    const summary = runExperimentSync(sharedConfig, { outputRootOverride: tmpDir });

    const inspection = inspectRun(summary.dbPath);

    expect(inspection.summary.runId).toBe(summary.runId);
    expect(inspection.metricTimeline).toHaveLength(summary.completedSteps);
    expect(inspection.focusClaimId).toBe("claim_ego_depletion");
    expect(inspection.finalFocusStates.length).toBeGreaterThan(0);
    expect(inspection.recentEvents.length).toBeGreaterThan(0);
    expect(inspection.recentMemoryEntries.length).toBeGreaterThan(0);
    expect(inspection.memoryFlow.length).toBeGreaterThan(0);
    expect(inspection.claimMatrix.length).toBeGreaterThan(0);
    expect(inspection.claimMatrix[0]?.states.length).toBe(summary.completedSteps + 1);
  });

  it("does not infer initial belief from role alone", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-"));
    const scenarioPath = path.join(tmpDir, "role-only-scenario.yaml");
    const runConfigPath = path.join(tmpDir, "role-only-run.yaml");

    fs.writeFileSync(scenarioPath, `${JSON.stringify({
      id: "role_only_init_v1",
      title: "Role only initialization",
      focusClaimId: "claim_false",
      claims: [
        { id: "claim_false", text: "A false claim.", truthLabel: "false" },
      ],
      evidence: [],
      scheduledInterventions: [],
      initialBeliefStates: [],
      initialMemoryEntries: [],
    }, null, 2)}\n`, "utf8");

    fs.writeFileSync(runConfigPath, `${JSON.stringify({
      id: "role_only_run",
      title: "Role only run",
      scenarioPath,
      conditionPath: path.resolve("conditions/personal-memory.yaml"),
      seed: 1,
      maxSteps: 1,
      budget: { maxModelCalls: 1 },
      agents: [
        {
          id: "contamination_1",
          role: "contamination_agent",
          model: "heuristic-mini",
          positiveEvidenceWeight: 0.7,
          negativeEvidenceWeight: 0.5,
          socialWeight: 0.15,
          falseClaimBias: 0.95,
          correctionTrust: 0.2,
          writesMemoryThreshold: 0.45,
        },
      ],
      outputDir: tmpDir,
    }, null, 2)}\n`, "utf8");

    const summary = runExperimentSync(runConfigPath, { outputRootOverride: tmpDir });
    const rows = queryRows<{ stance: string; confidence: number }>(
      summary.dbPath,
      "SELECT stance, confidence FROM agent_claim_states WHERE step_index = 0 AND agent_id = 'contamination_1' AND claim_id = 'claim_false' LIMIT 1;",
    );

    expect(rows[0]?.stance).toBe("uncertain");
    expect(rows[0]?.confidence).toBe(0.2);
  });

  it("applies explicit initial belief states from config", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-"));
    const scenarioPath = path.join(tmpDir, "explicit-init-scenario.yaml");
    const runConfigPath = path.join(tmpDir, "explicit-init-run.yaml");

    fs.writeFileSync(scenarioPath, `${JSON.stringify({
      id: "explicit_init_v1",
      title: "Explicit initial belief state",
      focusClaimId: "claim_false",
      claims: [
        { id: "claim_false", text: "A false claim.", truthLabel: "false" },
      ],
      evidence: [],
      scheduledInterventions: [],
      initialBeliefStates: [
        { agentId: "regular_1", claimId: "claim_false", stance: "endorse", confidence: 0.77 },
      ],
      initialMemoryEntries: [],
    }, null, 2)}\n`, "utf8");

    fs.writeFileSync(runConfigPath, `${JSON.stringify({
      id: "explicit_init_run",
      title: "Explicit init run",
      scenarioPath,
      conditionPath: path.resolve("conditions/personal-memory.yaml"),
      seed: 1,
      maxSteps: 1,
      budget: { maxModelCalls: 1 },
      agents: [
        {
          id: "regular_1",
          role: "regular_agent",
          model: "heuristic-mini",
          positiveEvidenceWeight: 0.9,
          negativeEvidenceWeight: 0.8,
          socialWeight: 1,
          falseClaimBias: 0.2,
          correctionTrust: 0.7,
          writesMemoryThreshold: 0.4,
        },
      ],
      outputDir: tmpDir,
    }, null, 2)}\n`, "utf8");

    const summary = runExperimentSync(runConfigPath, { outputRootOverride: tmpDir });
    const rows = queryRows<{ stance: string; confidence: number; score: number }>(
      summary.dbPath,
      "SELECT stance, confidence, score FROM agent_claim_states WHERE step_index = 0 AND agent_id = 'regular_1' AND claim_id = 'claim_false' LIMIT 1;",
    );

    expect(rows[0]?.stance).toBe("endorse");
    expect(rows[0]?.confidence).toBe(0.77);
    expect(rows[0]?.score).toBe(0.77);
  });

  it("stores private source cards for every candidate and scores the final group choice", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-"));
    const scenarioPath = path.join(tmpDir, "hidden-profile-scenario.json");
    const rosterPath = path.resolve("rosters/hidden-profile-4-haiku.json");
    const roster = JSON.parse(fs.readFileSync(rosterPath, "utf8")) as { agents: RunConfig["agents"] };
    const runConfigPath = path.join(tmpDir, "hidden-profile-run.json");

    fs.writeFileSync(scenarioPath, `${JSON.stringify({
      id: "hidden_profile_smoke_v1",
      title: "Hidden profile smoke test",
      focusClaimId: "candidate_a",
      groupDecision: {
        candidateClaimIds: ["candidate_a", "candidate_b", "candidate_c"],
        correctClaimId: "candidate_b",
        instruction: "Choose the one explanation supported by the study packet.",
      },
      claims: [
        { id: "candidate_a", text: "Explanation A is correct.", truthLabel: "false" },
        { id: "candidate_b", text: "Explanation B is correct.", truthLabel: "true" },
        { id: "candidate_c", text: "Explanation C is correct.", truthLabel: "false" },
      ],
      evidence: [
        { id: "card_a", text: "Card A rules out explanation A.", visibleToAgentIds: ["analyst_1"], effects: [{ claimId: "candidate_a", effect: -0.9 }] },
        { id: "card_b", text: "Card B supports explanation B.", visibleToAgentIds: ["analyst_2"], effects: [{ claimId: "candidate_b", effect: 0.9 }] },
        { id: "card_c", text: "Card C rules out explanation C.", visibleToAgentIds: ["analyst_3"], effects: [{ claimId: "candidate_c", effect: -0.9 }] },
      ],
      scheduledInterventions: [],
      initialBeliefStates: [],
      initialMemoryEntries: [],
    }, null, 2)}\n`, "utf8");
    fs.writeFileSync(runConfigPath, `${JSON.stringify({
      id: "hidden_profile_smoke_run",
      title: "Hidden profile smoke run",
      scenarioPath,
      conditionPath: path.resolve("conditions/shared-source-aware-no-correction.yaml"),
      seed: 1,
      maxSteps: 4,
      budget: { maxModelCalls: 12 },
      agents: roster.agents.map((agent) => ({ ...agent, model: "heuristic-mini" })),
      outputDir: tmpDir,
    }, null, 2)}\n`, "utf8");

    const summary = runExperimentSync(runConfigPath, { outputRootOverride: tmpDir });
    const evidenceClaims = queryRows<{ claim_id: string }>(
      summary.dbPath,
      "SELECT DISTINCT claim_id FROM memory_entries WHERE source_type = 'evidence' ORDER BY claim_id;",
    );

    expect(evidenceClaims.map((row) => row.claim_id)).toEqual(["candidate_a", "candidate_b", "candidate_c"]);
    expect(summary.groupDecision?.candidateClaimIds).toEqual(["candidate_a", "candidate_b", "candidate_c"]);
    expect(Object.keys(summary.groupDecision?.candidateSupport ?? {})).toEqual([
      "candidate_a",
      "candidate_b",
      "candidate_c",
    ]);
    expect(summary.groupDecision?.retrievalSupport).not.toBeUndefined();
  });

  it("keeps Study 1 seeding private and makes the evidence board share sources rather than judgments", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-"));
    const scenarioPath = path.resolve("scenarios/distributed-ego-depletion-v1.yaml");
    const conditionPath = path.resolve("conditions/shared-evidence-board-no-correction.yaml");
    const runConfigPath = path.join(tmpDir, "evidence-board-run.yaml");
    const roster = JSON.parse(fs.readFileSync("rosters/distributed-baseline-6-haiku.json", "utf8")) as { agents: RunConfig["agents"] };
    const scenario = loadScenario(scenarioPath);

    expect(scenario.initialMemoryEntries).toEqual([]);
    fs.writeFileSync(runConfigPath, `${JSON.stringify({
      id: "evidence_board_run",
      title: "Evidence board smoke test",
      scenarioPath,
      conditionPath,
      seed: 0,
      maxSteps: 6,
      budget: { maxModelCalls: 18 },
      agents: roster.agents,
      outputDir: tmpDir,
    }, null, 2)}\n`, "utf8");

    const summary = runExperimentSync(runConfigPath, { outputRootOverride: tmpDir });
    const entries = queryRows<{ source_type: string; entry_text: string }>(
      summary.dbPath,
      "SELECT source_type, entry_text FROM memory_entries ORDER BY step_index ASC;",
    );

    expect(summary.completedSteps).toBe(6);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.source_type === "evidence")).toBe(true);
    expect(entries.every((entry) => scenario.evidence.some((evidence) => entry.entry_text === `[${evidence.id}] ${evidence.text}`))).toBe(true);
  });

  it("fires correction when trigger threshold is already met in the current belief state", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-"));
    const scenarioPath = path.join(tmpDir, "trigger-scenario.yaml");
    const conditionPath = path.join(tmpDir, "trigger-condition.yaml");
    const runConfigPath = path.join(tmpDir, "trigger-run.yaml");

    fs.writeFileSync(scenarioPath, `${JSON.stringify({
      id: "triggered_correction_v1",
      title: "Triggered correction scenario",
      focusClaimId: "claim_false",
      claims: [
        { id: "claim_false", text: "A false claim.", truthLabel: "false" },
      ],
      evidence: [],
      scheduledInterventions: [
        { id: "corr_1", step: 4, type: "correction", claimId: "claim_false", text: "The claim is false.", effect: -0.8 },
      ],
      initialBeliefStates: [
        { agentId: "agent_1", claimId: "claim_false", stance: "endorse", confidence: 0.9 },
        { agentId: "agent_2", claimId: "claim_false", stance: "reject", confidence: 0.9 },
      ],
      initialMemoryEntries: [],
    }, null, 2)}\n`, "utf8");

    fs.writeFileSync(conditionPath, `${JSON.stringify({
      id: "trigger_threshold",
      title: "Triggered threshold condition",
      memory: { mode: "shared", maxRetrievedEntries: 6 },
      interventions: {
        correctionVisibility: "global",
        correctionTiming: { mode: "endorsement_threshold", threshold: 0.5, minStep: 1 },
      },
    }, null, 2)}\n`, "utf8");

    fs.writeFileSync(runConfigPath, `${JSON.stringify({
      id: "trigger_run",
      title: "Trigger run",
      scenarioPath,
      conditionPath,
      seed: 1,
      maxSteps: 2,
      budget: { maxModelCalls: 2 },
      agents: [
        {
          id: "agent_1",
          role: "regular_agent",
          model: "heuristic-mini",
          positiveEvidenceWeight: 0.9,
          negativeEvidenceWeight: 0.8,
          socialWeight: 0.1,
          falseClaimBias: 0.1,
          correctionTrust: 1,
          writesMemoryThreshold: 0.95,
        },
        {
          id: "agent_2",
          role: "regular_agent",
          model: "heuristic-mini",
          positiveEvidenceWeight: 0.9,
          negativeEvidenceWeight: 0.8,
          socialWeight: 0.1,
          falseClaimBias: 0.1,
          correctionTrust: 1,
          writesMemoryThreshold: 0.95,
        },
      ],
      outputDir: tmpDir,
    }, null, 2)}\n`, "utf8");

    const summary = runExperimentSync(runConfigPath, { outputRootOverride: tmpDir });
    const interventions = queryRows<{ step_index: number; intervention_id: string }>(
      summary.dbPath,
      "SELECT step_index, intervention_id FROM interventions ORDER BY step_index ASC, intervention_event_id ASC;",
    );

    expect(interventions).toHaveLength(1);
    expect(interventions[0]?.step_index).toBe(1);
    expect(summary.timeToCorrection).toBe(1);
  });

  it("does not fire trigger before the threshold is reached", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-"));
    const scenarioPath = path.join(tmpDir, "no-trigger-scenario.yaml");
    const conditionPath = path.join(tmpDir, "no-trigger-condition.yaml");
    const runConfigPath = path.join(tmpDir, "no-trigger-run.yaml");

    fs.writeFileSync(scenarioPath, `${JSON.stringify({
      id: "no_trigger_v1",
      title: "No trigger scenario",
      focusClaimId: "claim_false",
      claims: [
        { id: "claim_false", text: "A false claim.", truthLabel: "false" },
      ],
      evidence: [],
      scheduledInterventions: [
        { id: "corr_1", step: 4, type: "correction", claimId: "claim_false", text: "The claim is false.", effect: -0.8 },
      ],
      initialBeliefStates: [
        { agentId: "agent_1", claimId: "claim_false", stance: "endorse", confidence: 0.9 },
        { agentId: "agent_2", claimId: "claim_false", stance: "reject", confidence: 0.9 },
      ],
      initialMemoryEntries: [],
    }, null, 2)}\n`, "utf8");

    fs.writeFileSync(conditionPath, `${JSON.stringify({
      id: "high_trigger_threshold",
      title: "High threshold condition",
      memory: { mode: "shared", maxRetrievedEntries: 6 },
      interventions: {
        correctionVisibility: "global",
        correctionTiming: { mode: "endorsement_threshold", threshold: 0.75, minStep: 1 },
      },
    }, null, 2)}\n`, "utf8");

    fs.writeFileSync(runConfigPath, `${JSON.stringify({
      id: "no_trigger_run",
      title: "No trigger run",
      scenarioPath,
      conditionPath,
      seed: 1,
      maxSteps: 1,
      budget: { maxModelCalls: 1 },
      agents: [
        {
          id: "agent_1",
          role: "regular_agent",
          model: "heuristic-mini",
          positiveEvidenceWeight: 0.9,
          negativeEvidenceWeight: 0.8,
          socialWeight: 0.1,
          falseClaimBias: 0.1,
          correctionTrust: 1,
          writesMemoryThreshold: 0.95,
        },
        {
          id: "agent_2",
          role: "regular_agent",
          model: "heuristic-mini",
          positiveEvidenceWeight: 0.9,
          negativeEvidenceWeight: 0.8,
          socialWeight: 0.1,
          falseClaimBias: 0.1,
          correctionTrust: 1,
          writesMemoryThreshold: 0.95,
        },
      ],
      outputDir: tmpDir,
    }, null, 2)}\n`, "utf8");

    const summary = runExperimentSync(runConfigPath, { outputRootOverride: tmpDir });
    const interventions = queryRows<{ step_index: number; intervention_id: string }>(
      summary.dbPath,
      "SELECT step_index, intervention_id FROM interventions ORDER BY step_index ASC, intervention_event_id ASC;",
    );

    expect(interventions).toHaveLength(0);
    expect(summary.timeToCorrection).toBeNull();
  });

  it("fires triggered corrections in the async LLM memory path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-"));
    const dbPath = path.join(tmpDir, "trace.db");
    initDatabase(dbPath);

    const scenario: Scenario = {
      id: "llm_trigger_v1",
      title: "LLM triggered correction",
      scenarioType: "claim_benchmark",
      mechanismTags: [],
      sourceCards: [],
      focusClaimId: "claim_false",
      claims: [
        { id: "claim_false", text: "A false claim.", truthLabel: "false" },
      ],
      evidence: [],
      scheduledInterventions: [
        { id: "corr_1", step: 4, type: "correction", claimId: "claim_false", text: "The claim is false.", effect: -0.8 },
      ],
      initialBeliefStates: [
        { agentId: "agent_1", claimId: "claim_false", stance: "endorse", confidence: 0.9 },
      ],
      initialMemoryEntries: [],
      seedMemoryEntries: [],
    };
    const condition: Condition = {
      id: "trigger_threshold",
      title: "Triggered threshold condition",
      memory: {
        mode: "shared",
        record: "agent_judgment",
        maxRetrievedEntries: 6,
        decay: { enabled: false, halfLife: 6 },
      },
      interventions: {
        correctionVisibility: "global",
        correctionTiming: { mode: "endorsement_threshold", threshold: 0.5, minStep: 1 },
        correctionStrength: "default",
        verification: { mode: "none", noiseLevel: 0 },
      },
      interaction: {
        mode: "memory",
        topology: "fully-connected",
        chatRounds: 3,
        chatStyle: "claim-debate",
        collusion: {
          strategy: "none",
          visibility: "hidden",
          omitContraryEvidence: false,
          repeatSupportiveEvidence: false,
        },
      },
    };
    const runConfig: RunConfig = {
      id: "llm_trigger_run",
      title: "LLM trigger run",
      scenarioPath: "unused",
      conditionPath: "unused",
      seed: 0,
      maxSteps: 1,
      budget: { maxModelCalls: 1 },
      agents: [
        {
          id: "agent_1",
          role: "regular_agent" as const,
          model: "claude-haiku-4-5-20251001",
          positiveEvidenceWeight: 0.9,
          negativeEvidenceWeight: 0.8,
          socialWeight: 0.1,
          falseClaimBias: 0.1,
          correctionTrust: 1,
          writesMemoryThreshold: 0.95,
          activeFromStep: 1,
          canWriteMemory: true,
        },
      ],
      outputDir: tmpDir,
    };

    const runId = `${runConfig.id}-${condition.id}-seed${runConfig.seed}`;
    const resolvedInterventions = resolveInterventions(scenario, condition, runConfig.maxSteps);
    const { allBeliefStates, memoryEntries } = initializeRunStorage(
      dbPath,
      runId,
      runConfig,
      scenario,
      condition,
      "llm",
    );
    const stepMetrics: StepMetrics[] = [];
    const scoreSpy = vi.spyOn(llmScore, "scoreClaimWithLLM").mockImplementation(async (
      _provider,
      _agent,
      _claimId,
      _scenario,
      _condition,
      _memoryEntries,
      activeInterventions,
    ) => ({
      stance: activeInterventions.length > 0 ? "reject" : "endorse",
      confidence: 0.9,
      reasoning: "mocked",
      citedSourceIds: [],
      retrievedMemory: [],
      verificationCue: null,
      rawResponse: "{\"stance\":\"reject\",\"confidence\":0.9}",
      parseValid: true,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      estimatedCostUsd: null,
    }));

    try {
      await runLlmMemoryMode({
        runId,
        runConfig,
        scenario,
        condition,
        dbPath,
        allBeliefStates,
        memoryEntries,
        stepMetrics,
        resolvedInterventions,
        rng: mulberry32(runConfig.seed),
        providerMap: new Map([
          ["agent_1", { type: "anthropic", apiKey: "test-key", baseUrl: "https://example.invalid", model: "claude-haiku-4-5-20251001", workspaceId: null }],
        ]),
      });
    } finally {
      scoreSpy.mockRestore();
    }

    const interventions = queryRows<{ step_index: number; intervention_id: string }>(
      dbPath,
      "SELECT step_index, intervention_id FROM interventions ORDER BY step_index ASC, intervention_event_id ASC;",
    );
    const events = queryRows<{ output_json: string }>(
      dbPath,
      "SELECT output_json FROM events ORDER BY event_id ASC;",
    );
    const firstEvent = JSON.parse(events[0]!.output_json) as { activeInterventionIds?: string[]; focusClaimStance?: string };

    expect(interventions).toHaveLength(1);
    expect(interventions[0]?.step_index).toBe(1);
    expect(firstEvent.activeInterventionIds ?? []).toContain("corr_1");
    expect(firstEvent.focusClaimStance).toBe("reject");
  });

  it("computes confidence-weighted false endorsement as a structured metric", () => {
    const metrics = computeStepMetrics(
      "metric_run",
      1,
      [
        {
          runId: "metric_run",
          step: 1,
          agentId: "agent_1",
          claimId: "claim_false",
          truthLabel: "false",
          stance: "endorse",
          score: 0.8,
          confidence: 0.8,
        },
        {
          runId: "metric_run",
          step: 1,
          agentId: "agent_2",
          claimId: "claim_false",
          truthLabel: "false",
          stance: "endorse",
          score: 0.4,
          confidence: 0.4,
        },
        {
          runId: "metric_run",
          step: 1,
          agentId: "agent_3",
          claimId: "claim_false",
          truthLabel: "false",
          stance: "reject",
          score: -0.9,
          confidence: 0.9,
        },
      ],
      {
        id: "metric_scenario",
        title: "Metric scenario",
        scenarioType: "claim_benchmark",
        mechanismTags: [],
        sourceCards: [],
        focusClaimId: "claim_false",
        claims: [{ id: "claim_false", text: "A false claim.", truthLabel: "false" }],
        evidence: [],
        scheduledInterventions: [],
        initialBeliefStates: [],
        initialMemoryEntries: [],
        seedMemoryEntries: [],
      },
    );

    expect(metrics.falseClaimEndorsementRate).toBeCloseTo(2 / 3, 5);
    expect(metrics.confidenceWeightedFalseEndorsement).toBeCloseTo(0.4, 5);
  });

  it("counts only agents who held the false view before late evidence appeared", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-late-evidence-"));
    const dbPath = path.join(tmpDir, "trace.db");
    const scenarioPath = path.join(tmpDir, "scenario.yaml");
    const resultPath = path.join(tmpDir, "grid-results.json");
    const runId = "late_evidence_run";
    initDatabase(dbPath);
    fs.writeFileSync(scenarioPath, `${JSON.stringify({
      id: "late_evidence_test",
      title: "Late evidence test",
      focusClaimId: "claim_false",
      claims: [{ id: "claim_false", text: "A false claim.", truthLabel: "false" }],
      evidence: [{
        id: "late_counter_source",
        text: "A later source refutes the claim.",
        availableFromStep: 7,
        effects: [{ claimId: "claim_false", effect: -0.9 }],
      }],
      scheduledInterventions: [],
      initialBeliefStates: [],
      initialMemoryEntries: [],
    }, null, 2)}\n`, "utf8");

    for (const [agentId, step, stance] of [
      ["agent_false_then_reject", 0, "endorse"],
      ["agent_false_then_reject", 18, "reject"],
      ["agent_never_false", 0, "uncertain"],
      ["agent_never_false", 18, "endorse"],
    ] as const) {
      insertRow(dbPath, "agent_claim_states", {
        run_id: runId,
        step_index: step,
        agent_id: agentId,
        claim_id: "claim_false",
        truth_label: "false",
        stance,
        score: 0,
        confidence: 0.5,
      });
      if (step === 18) {
        insertRow(dbPath, "retrieval_traces", {
          run_id: runId,
          step_index: 7,
          agent_id: agentId,
          claim_id: "claim_false",
          retrieved_entry_ids_json: "[]",
          context_json: JSON.stringify({ visibleEvidenceIds: ["late_counter_source"] }),
        });
      }
    }

    fs.writeFileSync(resultPath, JSON.stringify({
      grid: { id: "late_evidence_grid", scenarios: [scenarioPath] },
      cells: [{ scenarioId: "late_evidence_test", summary: { dbPath, runId } }],
    }), "utf8");
    const report = analyzeLateEvidenceGrid(resultPath);
    const scenario = report.scenarios[0]!;

    expect(scenario.agentsExposed).toBe(2);
    expect(scenario.agentsFalseBeforeExposure).toBe(1);
    expect(scenario.agentsStillEndorsingAtEnd).toBe(0);
    expect(scenario.agentsRejectingAtEnd).toBe(1);
  });

  it("respects per-agent evidence visibility in heuristic runs", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-"));
    const scenarioPath = path.join(tmpDir, "private-evidence-scenario.yaml");
    const runConfigPath = path.join(tmpDir, "private-evidence-run.yaml");

    fs.writeFileSync(scenarioPath, `${JSON.stringify({
      id: "private_evidence_v1",
      title: "Private evidence scenario",
      focusClaimId: "claim_false",
      claims: [
        { id: "claim_false", text: "A false claim.", truthLabel: "false" },
      ],
      evidence: [
        {
          id: "ev_private",
          text: "Hidden refutation only visible to specialist_1.",
          visibleToAgentIds: ["specialist_1"],
          effects: [{ claimId: "claim_false", effect: -0.9 }],
        },
      ],
      scheduledInterventions: [],
      initialBeliefStates: [],
      initialMemoryEntries: [],
    }, null, 2)}\n`, "utf8");

    fs.writeFileSync(runConfigPath, `${JSON.stringify({
      id: "private_evidence_run",
      title: "Private evidence run",
      scenarioPath,
      conditionPath: path.resolve("conditions/personal-memory.yaml"),
      seed: 0,
      maxSteps: 1,
      budget: { maxModelCalls: 1 },
      agents: [
        {
          id: "regular_1",
          role: "regular_agent",
          model: "heuristic-mini",
          positiveEvidenceWeight: 0.8,
          negativeEvidenceWeight: 0.8,
          socialWeight: 0.1,
          falseClaimBias: 0.1,
          correctionTrust: 0.6,
          writesMemoryThreshold: 0.9,
        },
        {
          id: "specialist_1",
          role: "specialist_agent",
          model: "heuristic-mini",
          positiveEvidenceWeight: 0.8,
          negativeEvidenceWeight: 1.2,
          socialWeight: 0.1,
          falseClaimBias: 0,
          correctionTrust: 0.9,
          writesMemoryThreshold: 0.9,
        },
      ],
      outputDir: tmpDir,
    }, null, 2)}\n`, "utf8");

    const summary = runExperimentSync(runConfigPath, { outputRootOverride: tmpDir });
    const traceRows = queryRows<{ agent_id: string; context_json: string }>(
      summary.dbPath,
      "SELECT agent_id, context_json FROM retrieval_traces ORDER BY retrieval_trace_id ASC;",
    );

    const firstContext = JSON.parse(traceRows[0]!.context_json) as { visibleEvidenceIds?: string[] };
    expect(traceRows[0]?.agent_id).toBe("regular_1");
    expect(firstContext.visibleEvidenceIds ?? []).toEqual([]);
  });

  it("records testimony adoption and claim lineage when a memory is repeated", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-"));
    const scenarioPath = path.join(tmpDir, "lineage-scenario.yaml");
    const runConfigPath = path.join(tmpDir, "lineage-run.yaml");

    fs.writeFileSync(scenarioPath, `${JSON.stringify({
      id: "lineage_v1",
      title: "Lineage scenario",
      focusClaimId: "claim_false",
      claims: [{ id: "claim_false", text: "A false claim.", truthLabel: "false" }],
      evidence: [],
      scheduledInterventions: [],
      initialBeliefStates: [
        { agentId: "regular_2", claimId: "claim_false", stance: "uncertain", confidence: 0.2 },
      ],
      initialMemoryEntries: [
        {
          id: "seed_1",
          agentId: "regular_1",
          claimId: "claim_false",
          stance: "endorse",
          confidence: 0.9,
          visibility: "shared",
          sourceType: "seed",
          text: "regular_1 strongly endorses the claim",
        },
      ],
    }, null, 2)}\n`, "utf8");

    fs.writeFileSync(runConfigPath, `${JSON.stringify({
      id: "lineage_run",
      title: "Lineage run",
      scenarioPath,
      conditionPath: path.resolve("conditions/shared-memory.yaml"),
      seed: 1,
      maxSteps: 1,
      budget: { maxModelCalls: 1 },
      agents: [
        {
          id: "regular_1",
          role: "regular_agent",
          model: "heuristic-mini",
          positiveEvidenceWeight: 0.9,
          negativeEvidenceWeight: 0.8,
          socialWeight: 0.2,
          falseClaimBias: 0.05,
          correctionTrust: 0.6,
          writesMemoryThreshold: 0.9,
        },
        {
          id: "regular_2",
          role: "regular_agent",
          model: "heuristic-mini",
          positiveEvidenceWeight: 0.9,
          negativeEvidenceWeight: 0.8,
          socialWeight: 1.8,
          falseClaimBias: 0.05,
          correctionTrust: 0.6,
          writesMemoryThreshold: 0.3,
        },
      ],
      outputDir: tmpDir,
    }, null, 2)}\n`, "utf8");

    const summary = runExperimentSync(runConfigPath, { outputRootOverride: tmpDir });
    const adoptions = queryRows<{ agent_id: string; source_agent_id: string; stance: string }>(
      summary.dbPath,
      "SELECT agent_id, source_agent_id, stance FROM testimony_adoptions ORDER BY adoption_id ASC;",
    );
    const lineage = queryRows<{ parent_agent_id: string; child_agent_id: string; relation_type: string }>(
      summary.dbPath,
      "SELECT parent_agent_id, child_agent_id, relation_type FROM claim_lineage ORDER BY lineage_id ASC;",
    );

    expect(adoptions.length).toBeGreaterThan(0);
    expect(adoptions[0]?.agent_id).toBe("regular_2");
    expect(adoptions[0]?.source_agent_id).toBe("regular_1");
    expect(lineage.length).toBeGreaterThan(0);
    expect(lineage[0]?.child_agent_id).toBe("regular_2");
    expect(lineage[0]?.relation_type).toBe("memory_adoption");
  });

  it("supports observer-style agents that do not write memory and source exit by step", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-"));
    const scenarioPath = path.join(tmpDir, "observer-exit-scenario.yaml");
    const runConfigPath = path.join(tmpDir, "observer-exit-run.yaml");

    fs.writeFileSync(scenarioPath, `${JSON.stringify({
      id: "observer_exit_v1",
      title: "Observer and exit scenario",
      focusClaimId: "claim_false",
      claims: [{ id: "claim_false", text: "A false claim.", truthLabel: "false" }],
      evidence: [],
      scheduledInterventions: [],
      initialBeliefStates: [],
      initialMemoryEntries: [],
    }, null, 2)}\n`, "utf8");

    fs.writeFileSync(runConfigPath, `${JSON.stringify({
      id: "observer_exit_run",
      title: "Observer and exit run",
      scenarioPath,
      conditionPath: path.resolve("conditions/shared-memory.yaml"),
      seed: 0,
      maxSteps: 3,
      budget: { maxModelCalls: 3 },
      agents: [
        {
          id: "contamination_1",
          role: "contamination_agent",
          model: "heuristic-mini",
          positiveEvidenceWeight: 0.8,
          negativeEvidenceWeight: 0.8,
          socialWeight: 0.2,
          falseClaimBias: 0.9,
          correctionTrust: 0.2,
          writesMemoryThreshold: 0.3,
          activeUntilStep: 1,
        },
        {
          id: "observer_1",
          role: "regular_agent",
          model: "heuristic-mini",
          positiveEvidenceWeight: 0.8,
          negativeEvidenceWeight: 0.8,
          socialWeight: 0.8,
          falseClaimBias: 0.1,
          correctionTrust: 0.6,
          writesMemoryThreshold: 0.2,
          canWriteMemory: false,
        },
      ],
      outputDir: tmpDir,
    }, null, 2)}\n`, "utf8");

    const summary = runExperimentSync(runConfigPath, { outputRootOverride: tmpDir });
    const laterEvents = queryRows<{ step_index: number }>(
      summary.dbPath,
      "SELECT step_index FROM events WHERE agent_id = 'contamination_1' AND step_index > 1;",
    );
    const observerWrites = queryRows<{ agent_id: string }>(
      summary.dbPath,
      "SELECT agent_id FROM memory_entries WHERE agent_id = 'observer_1';",
    );

    expect(laterEvents).toHaveLength(0);
    expect(observerWrites).toHaveLength(0);
  });

  it("skips finished cells when rerunning a grid", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-grid-"));
    const grid = defineGrid({
      id: "resume_grid_test",
      title: "Resume grid test",
      scenarios: [path.resolve("scenarios/ego-depletion-replication-v1.yaml")],
      conditions: [path.resolve("conditions/personal-memory.yaml")],
      seeds: [1],
      rosterPaths: [path.resolve("rosters/balanced-6-haiku.json")],
      maxSteps: 2,
      budget: { maxModelCalls: 2 },
      outputDir: tmpDir,
      projectRoot: tmpDir,
    });

    const first = await runGrid(grid);
    expect(first.cells).toHaveLength(1);

    const summaryPath = path.join(tmpDir, "resume_grid_test_ego_depletion_replication_v1_personal_memory_balanced_6_haiku-personal_memory-seed1", "summary.json");
    const before = fs.statSync(summaryPath).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await runGrid(grid);
    const after = fs.statSync(summaryPath).mtimeMs;

    expect(second.cells).toHaveLength(1);
    expect(after).toBe(before);
  });

  it("records manifest provenance and titled summaries for grid results", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiagentworld-grid-meta-"));
    const manifestPath = path.join(tmpDir, "benchmark.json");
    fs.writeFileSync(manifestPath, "{\n  \"id\": \"meta_grid\"\n}\n", "utf8");

    const grid = defineGrid({
      id: "meta_grid_test",
      title: "Meta grid test",
      sourceManifestPath: manifestPath,
      requestedManifestPath: "experiments/meta-grid.json",
      benchmarkMeta: {
        status: "pilot",
        claimId: "smoke_claim",
        locked: false,
      },
      scenarios: [path.resolve("scenarios/ego-depletion-replication-v1.yaml")],
      conditions: [path.resolve("conditions/personal-memory.yaml")],
      seeds: [1],
      rosterPaths: [path.resolve("rosters/balanced-6-haiku.json")],
      maxSteps: 2,
      budget: { maxModelCalls: 2 },
      outputDir: tmpDir,
      projectRoot: tmpDir,
    });

    const result = await runGrid(grid);
    const row = result.summaryTable[0];

    expect(row?.conditionTitle).toBe("Personal memory only");
    expect(row?.label).toBe("Personal memory only / Balanced 6 agent panel");
    expect(result.manifestInfo.sourceManifestPath).toBe(manifestPath);
    expect(result.manifestInfo.requestedManifestPath).toBe("experiments/meta-grid.json");
    expect(result.manifestInfo.benchmarkMeta?.status).toBe("pilot");
    expect(result.inputCatalog.conditions[0]?.title).toBe("Personal memory only");
    expect(result.provenancePath).toBe(path.join(tmpDir, "meta_grid_test-figure-provenance.json"));
    expect(fs.existsSync(result.provenancePath!)).toBe(true);
    expect(row?.falseClaimEndorsementRate.ci95[0]).toBeGreaterThanOrEqual(0);
    expect(row?.falseClaimEndorsementRate.ci95[1]).toBeLessThanOrEqual(1);
  });

  it("loads every study manifest with explicit benchmark metadata and a single interaction family", () => {
    const experimentDir = path.resolve("experiments");
    const files = fs.readdirSync(experimentDir).filter((file) => /^study.*\.json$/.test(file)).sort();

    expect(files.length).toBeGreaterThanOrEqual(10);

    for (const file of files) {
      const manifestPath = path.join(experimentDir, file);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      const grid = defineGrid({
        ...(manifest as Parameters<typeof defineGrid>[0]),
        projectRoot: path.resolve("."),
        sourceManifestPath: manifestPath,
      });
      const modes = [...new Set(grid.conditions.map((conditionPath) => loadCondition(conditionPath).interaction.mode))];

      expect(grid.benchmarkMeta).toBeTruthy();
      expect(modes).toHaveLength(1);

      if (grid.benchmarkMeta?.status === "canonical" || grid.benchmarkMeta?.status === "supporting") {
        expect(grid.benchmarkMeta.locked).toBe(true);
      }
      if (grid.benchmarkMeta?.status === "pilot" || grid.benchmarkMeta?.status === "deprecated") {
        expect(grid.benchmarkMeta.locked).toBe(false);
      }
    }
  });
});
