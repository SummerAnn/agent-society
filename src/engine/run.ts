import path from "path";

import { initDatabase } from "../db/sqlite";
import { resolveAgentProviders, initializeRunStorage, loadExperiment, mulberry32, resolveInterventions } from "./core";
import { runChatMode } from "./backends/chatMode";
import { runHeuristicMemoryMode, runLlmMemoryMode } from "./backends/memoryMode";
import { finalizeSummary } from "./finalize";

export type { RunExperimentOptions, RunProgressSnapshot } from "./types";
import type { RunExperimentOptions } from "./types";
import type { RunSummary } from "../config/schema";
import type { PhysicsReport } from "../physics/analyze";

/** @internal Sync runner for tests only. Uses heuristic scoring and memory mode semantics. */
export function runExperimentSync(runConfigPath: string, options: RunExperimentOptions = {}): RunSummary {
  const { runConfig, scenario, condition } = loadExperiment(runConfigPath);
  const runId = `${runConfig.id}-${condition.id}-seed${runConfig.seed}`;
  const outputRoot = options.outputRootOverride
    ? path.resolve(options.outputRootOverride)
    : path.resolve(path.dirname(runConfigPath), runConfig.outputDir);
  const outputDir = path.join(outputRoot, runId);
  const dbPath = path.join(outputDir, "trace.db");

  initDatabase(dbPath);
  const rng = mulberry32(runConfig.seed);
  const resolvedInterventions = resolveInterventions(scenario, condition, runConfig.maxSteps);
  const { allBeliefStates, memoryEntries } = initializeRunStorage(
    dbPath,
    runId,
    runConfig,
    scenario,
    condition,
    "heuristic",
  );
  const stepMetrics: import("../config/schema").StepMetrics[] = [];

  runHeuristicMemoryMode({
    runId,
    runConfig,
    scenario,
    condition,
    dbPath,
    allBeliefStates,
    memoryEntries,
    stepMetrics,
    resolvedInterventions,
    retrievalCounts: new Map(),
    onStep: options.onStep,
    rng,
  });

  return finalizeSummary(
    runId,
    runConfig,
    scenario,
    condition,
    stepMetrics,
    dbPath,
    outputDir,
    resolvedInterventions,
    null,
  );
}

export async function runExperimentAsync(runConfigPath: string, options: RunExperimentOptions = {}): Promise<RunSummary> {
  const { runConfig, scenario, condition } = loadExperiment(runConfigPath);
  const projectRoot = options.projectRoot ?? process.cwd();
  const runId = `${runConfig.id}-${condition.id}-seed${runConfig.seed}`;
  const outputRoot = options.outputRootOverride
    ? path.resolve(options.outputRootOverride)
    : path.resolve(path.dirname(runConfigPath), runConfig.outputDir);
  const outputDir = path.join(outputRoot, runId);
  const dbPath = path.join(outputDir, "trace.db");

  initDatabase(dbPath);
  const rng = mulberry32(runConfig.seed);
  const resolvedInterventions = resolveInterventions(scenario, condition, runConfig.maxSteps);
  const { allBeliefStates, memoryEntries } = initializeRunStorage(
    dbPath,
    runId,
    runConfig,
    scenario,
    condition,
    "llm",
  );
  const stepMetrics: import("../config/schema").StepMetrics[] = [];

  let latestPhysicsReport: PhysicsReport | null = null;

  if (condition.interaction.mode === "chat") {
    const providerMap = resolveAgentProviders(runConfig.agents, projectRoot);
    const chatResult = await runChatMode({
      runId,
      runConfig,
      scenario,
      condition,
      dbPath,
      providerMap,
      allBeliefStates,
      memoryEntries,
      stepMetrics,
      resolvedInterventions,
      onStep: options.onStep,
      onChatMessage: options.onChatMessage,
    });
    latestPhysicsReport = chatResult.latestPhysicsReport;
  } else {
    const providerMap = resolveAgentProviders(runConfig.agents, projectRoot);
    await runLlmMemoryMode({
      runId,
      runConfig,
      scenario,
      condition,
      dbPath,
      providerMap,
      allBeliefStates,
      memoryEntries,
      stepMetrics,
      resolvedInterventions,
      retrievalCounts: new Map(),
      rng,
      onStep: options.onStep,
    });
  }

  return finalizeSummary(
    runId,
    runConfig,
    scenario,
    condition,
    stepMetrics,
    dbPath,
    outputDir,
    resolvedInterventions,
    latestPhysicsReport,
  );
}
