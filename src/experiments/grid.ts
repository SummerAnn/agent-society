// Experiment grid runner.
//
// Runs a full factorial experiment: scenarios x conditions x seeds.
// Every condition sees the same scenarios and same seeds (paired design).
// Produces paired comparison data suitable for statistical testing.
//
// Usage:
//   const grid = defineGrid({
//     scenarios: ["scenarios/ego-depletion-replication-v1.yaml", ...],
//     conditions: ["conditions/shared-memory.yaml", "conditions/personal-memory.yaml"],
//     seeds: [1, 2, 3, 4, 5],
//     agents: agentPool,
//     maxSteps: 12,
//     budget: { maxModelCalls: 12 },
//   });
//   const results = await runGrid(grid);

import fs from "fs";
import os from "os";
import path from "path";

import { createArchiveRecord } from "../archive";
import { loadCondition, loadScenario } from "../config/load";
import type { AgentSpec, CitationBundle, Condition, Provenance, RunConfig, RunSummary, Scenario } from "../config/schema";
import { queryRows } from "../db/sqlite";
import { runExperimentAsync, type RunExperimentOptions } from "../engine/run";
import { assertTaskEligible } from "../tasks/eligibility";

// --- Types ---

export type BenchmarkStatus = "canonical" | "supporting" | "pilot" | "deprecated";

export type BenchmarkMeta = {
  status: BenchmarkStatus;
  claimId?: string;
  locked?: boolean;
  notes?: string[];
  supersedes?: string[];
};

export type MetricDirection = "lower_is_better" | "higher_is_better";

export type GridMetricMetadata = {
  key: keyof PairedComparison["metricDeltas"];
  title: string;
  direction: MetricDirection;
  bounds?: [number, number];
};

export type InputReference = {
  id: string;
  title: string;
  path: string;
};

export type GridInputCatalog = {
  scenarios: InputReference[];
  conditions: InputReference[];
  rosters: Array<InputReference & { agentCount: number }>;
};

export const GRID_METRIC_METADATA: GridMetricMetadata[] = [
  {
    key: "falseClaimEndorsementRate",
    title: "False claim endorsement rate",
    direction: "lower_is_better",
    bounds: [0, 1],
  },
  {
    key: "peakFalseClaimEndorsementRate",
    title: "Peak false claim endorsement rate",
    direction: "lower_is_better",
    bounds: [0, 1],
  },
  {
    key: "distanceFromGroundTruth",
    title: "Distance from ground truth",
    direction: "lower_is_better",
    bounds: [0, 1],
  },
  {
    key: "recoveryAfterCorrection",
    title: "Recovery after correction",
    direction: "higher_is_better",
    bounds: [-1, 1],
  },
  {
    key: "diversityRetention",
    title: "Diversity retention",
    direction: "higher_is_better",
    bounds: [0, 1],
  },
];

export type ExperimentGrid = {
  id: string;
  title: string;
  provenance?: Provenance;
  citations?: CitationBundle;
  projectRoot: string;
  sourceManifestPath?: string;
  requestedManifestPath?: string;
  benchmarkMeta?: BenchmarkMeta | null;
  scenarios: string[]; // paths to scenario files
  conditions: string[]; // paths to condition files
  seeds: number[];
  agents: AgentSpec[];
  rosters: RosterSpec[];
  maxSteps: number;
  budget: RunConfig["budget"];
  turnOrder?: string[];
  outputDir: string;
};

export type RosterSpec = {
  id: string;
  title: string;
  agents: AgentSpec[];
  sourcePath?: string;
};

export type GridCell = {
  scenarioPath: string;
  scenarioId: string;
  conditionPath: string;
  conditionId: string;
  rosterId: string;
  rosterTitle: string;
  seed: number;
  runConfigPath: string; // generated temp config
};

export type GridResult = {
  grid: ExperimentGrid;
  cells: GridCellResult[];
  // Paired comparisons: condition A vs condition B, same scenario, same seed
  pairings: PairedComparison[];
  // Summary table: one row per condition, aggregated across scenarios and seeds
  summaryTable: ConditionSummaryRow[];
  manifestInfo: {
    sourceManifestPath: string | null;
    requestedManifestPath: string | null;
    benchmarkMeta: BenchmarkMeta | null;
    generatedAt: string;
  };
  inputCatalog: GridInputCatalog;
  metricCatalog: GridMetricMetadata[];
  provenancePath?: string;
  outputPath: string;
};

export type GridCellResult = {
  scenarioId: string;
  conditionId: string;
  rosterId: string;
  rosterTitle: string;
  seed: number;
  summary: RunSummary;
  manipulationCheck: ManipulationCheck;
};

export type ManipulationCheck = {
  passed: boolean;
  contaminationSeeded: boolean;
  contaminationFired: boolean;
  sharedMemoryUsed: boolean;
  correctionDelivered: boolean;
  correctionSeenByAgents: number;
  falseMemorySeedCount: number;
  falseMemoryWriteCount: number;
  falseMemoryRetrievalCount: number;
  falseMemoryRetrievalAgents: number;
  verificationEnabled: boolean;
  details: string[];
};

export type PairedComparison = {
  scenarioId: string;
  rosterId: string;
  seed: number;
  conditionA: string;
  conditionB: string;
  metricDeltas: {
    falseClaimEndorsementRate: number;
    peakFalseClaimEndorsementRate: number;
    distanceFromGroundTruth: number;
    recoveryAfterCorrection: number;
    diversityRetention: number;
  };
};

export type ConditionSummaryRow = {
  conditionId: string;
  conditionTitle: string;
  rosterId: string;
  rosterTitle: string;
  label: string;
  n: number; // number of completed runs
  falseClaimEndorsementRate: { mean: number; std: number; ci95: [number, number] };
  peakFalseClaimEndorsementRate: { mean: number; std: number; ci95: [number, number] };
  distanceFromGroundTruth: { mean: number; std: number; ci95: [number, number] };
  recoveryAfterCorrection: { mean: number; std: number; ci95: [number, number] };
  diversityRetention: { mean: number; std: number; ci95: [number, number] };
  timeToMajorityAdoption: { mean: number | null; count: number };
  manipulationCheckPassRate: number;
};

// --- Grid definition ---

export function defineGrid(params: {
  id?: string;
  title?: string;
  provenance?: Provenance;
  citations?: CitationBundle;
  sourceManifestPath?: string;
  requestedManifestPath?: string;
  benchmarkMeta?: BenchmarkMeta | null;
  _launchMeta?: { requestedManifestPath?: string };
  scenarios: string[];
  conditions: string[];
  seeds: number[];
  agents?: AgentSpec[];
  rosters?: RosterSpec[];
  rosterPaths?: string[];
  maxSteps?: number;
  budget?: RunConfig["budget"];
  turnOrder?: string[];
  outputDir?: string;
  projectRoot?: string;
}): ExperimentGrid {
  const projectRoot = params.projectRoot ?? process.cwd();
  const rostersFromPaths = (params.rosterPaths ?? []).map((rosterPath) => {
    const resolved = path.resolve(projectRoot, rosterPath);
    const raw = JSON.parse(fs.readFileSync(resolved, "utf8")) as RosterSpec;
    return { ...raw, sourcePath: resolved };
  });
  const rosters = params.rosters && params.rosters.length > 0
    ? params.rosters
    : rostersFromPaths.length > 0
      ? rostersFromPaths
      : params.agents && params.agents.length > 0
        ? [{ id: "default", title: "Default roster", agents: params.agents }]
        : [];
  if (rosters.length === 0) {
    throw new Error("Experiment grid requires either agents or rosters.");
  }
  return {
    id: params.id ?? `grid-${Date.now()}`,
    title: params.title ?? "Experiment grid",
    provenance: params.provenance,
    citations: params.citations,
    projectRoot,
    sourceManifestPath: params.sourceManifestPath,
    requestedManifestPath: params.requestedManifestPath ?? params._launchMeta?.requestedManifestPath,
    benchmarkMeta: params.benchmarkMeta ?? null,
    scenarios: params.scenarios.map((s) => path.resolve(projectRoot, s)),
    conditions: params.conditions.map((c) => path.resolve(projectRoot, c)),
    seeds: params.seeds,
    agents: rosters[0].agents,
    rosters,
    maxSteps: params.maxSteps ?? 12,
    budget: params.budget ?? { maxModelCalls: 12 },
    turnOrder: params.turnOrder,
    outputDir: params.outputDir ?? path.resolve(projectRoot, "output"),
  };
}

// --- Generate all cells ---

function generateCells(grid: ExperimentGrid): GridCell[] {
  const cells: GridCell[] = [];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "maw-grid-"));

  for (const scenarioPath of grid.scenarios) {
    const scenario = loadScenario(scenarioPath);
    for (const conditionPath of grid.conditions) {
      const condition = loadCondition(conditionPath);
      for (const roster of grid.rosters) {
        for (const seed of grid.seeds) {
          const runConfig: RunConfig = {
            id: `${grid.id}_${scenario.id}_${condition.id}_${roster.id}`,
            title: `${grid.title}: ${scenario.id} / ${condition.id} / ${roster.id} / seed ${seed}`,
            scenarioPath,
            conditionPath,
            seed,
            maxSteps: grid.maxSteps,
            budget: grid.budget,
            agents: roster.agents,
            outputDir: grid.outputDir,
            turnOrder: grid.turnOrder,
          };

          const cellDir = path.join(tempRoot, `${scenario.id}_${condition.id}_${roster.id}_s${seed}`);
          fs.mkdirSync(cellDir, { recursive: true });
          const runConfigPath = path.join(cellDir, "run-config.json");
          fs.writeFileSync(runConfigPath, JSON.stringify(runConfig, null, 2), "utf8");

          cells.push({
            scenarioPath,
            scenarioId: scenario.id,
            conditionPath,
            conditionId: condition.id,
            rosterId: roster.id,
            rosterTitle: roster.title,
            seed,
            runConfigPath,
          });
        }
      }
    }
  }

  return cells;
}

// --- Manipulation check from run summary ---

function checkManipulation(
  dbPath: string,
  runId: string,
  runConfig: RunConfig,
  condition: Condition,
  scenario: Scenario,
): ManipulationCheck {
  const details: string[] = [];
  const runIdSql = `'${runId.replace(/'/g, "''")}'`;

  if (scenario.groupDecision) {
    const candidateIds = new Set(scenario.groupDecision.candidateClaimIds);
    const evidenceAccess = scenario.groupDecision.evidenceAccess;
    const privateEvidenceConfigured = scenario.evidence.length > 0 && scenario.evidence.every((evidence) => {
      const visibleTo = evidence.visibleToAgentIds ?? [];
      return visibleTo.length > 0 && visibleTo.length < runConfig.agents.length;
    });
    const noEvidenceConfigured = scenario.evidence.length === 0;
    const publicProblemConfigured = evidenceAccess === "public_problem"
      && scenario.groupDecision.instruction.trim().length > 0;
    const fullPacketConfigured = scenario.evidence.length > 0 && scenario.evidence.every((evidence) => {
      // An omitted visibility list means every agent can see the card.
      const visibleTo = evidence.visibleToAgentIds;
      return !visibleTo || visibleTo.length === runConfig.agents.length;
    });
    const evidenceAccessConfigured = evidenceAccess === "private_split"
      ? privateEvidenceConfigured
      : evidenceAccess === "none"
        ? noEvidenceConfigured
        : evidenceAccess === "public_problem"
          ? publicProblemConfigured
          : fullPacketConfigured;
    const expectedSourceEntries = scenario.evidence.reduce(
      (total, evidence) => total + evidence.effects.filter((effect) => candidateIds.has(effect.claimId)).length,
      0,
    );
    const isBoundedTaskChat = condition.interaction.mode === "chat";
    const sourceEntryCount = isBoundedTaskChat
      ? queryRows<{ count: number }>(dbPath, `SELECT COUNT(*) AS count FROM chat_messages WHERE run_id = ${runIdSql} AND message_type = 'task_turn';`)[0]?.count ?? 0
      : queryRows<{ count: number }>(
        dbPath,
        `SELECT COUNT(*) AS count FROM memory_entries WHERE run_id = ${runIdSql} AND source_type IN ('evidence', 'mixed');`,
      )[0]?.count ?? 0;
    const sharedEntryIds = new Set(queryRows<{ id: string }>(
      dbPath,
      `SELECT memory_entry_id AS id FROM memory_entries WHERE run_id = ${runIdSql} AND visibility = 'shared';`,
    ).map((row) => row.id));
    const sharedMemoryUsed = isBoundedTaskChat
      ? queryRows<{ outputJson: string }>(
        dbPath,
        `SELECT output_json AS outputJson FROM events WHERE run_id = ${runIdSql} AND event_type = 'initial_group_choice';`,
      ).some((row) => {
        try {
          const event = JSON.parse(row.outputJson) as { visibleMessageIds?: unknown };
          return Array.isArray(event.visibleMessageIds) && event.visibleMessageIds.length > 0;
        } catch { return false; }
      })
      : condition.memory.mode === "shared"
      ? queryRows<{ ids: string }>(
        dbPath,
        `SELECT retrieved_entry_ids_json AS ids FROM retrieval_traces WHERE run_id = ${runIdSql};`,
      ).some((row) => (JSON.parse(row.ids) as string[]).some((id) => sharedEntryIds.has(id)))
      : true;
    const expectedSharedSourceEntries = evidenceAccess === "public_problem"
      ? 0
      : isBoundedTaskChat
        ? runConfig.maxSteps
        : expectedSourceEntries;
    const sourceEntriesMatch = condition.memory.mode === "shared"
      ? sourceEntryCount === expectedSharedSourceEntries
      : sourceEntryCount === 0;
    const configuredSeedPolicies = runConfig.agents
      .filter((agent) => agent.seedStatementPolicy)
      .map((agent) => ({ agentId: agent.id, claimId: agent.seedStatementPolicy!.claimId }));
    const enforcedSeedEvents = queryRows<{ agentId: string; claimId: string }>(
      dbPath,
      `SELECT agent_id AS agentId, claim_id AS claimId FROM events WHERE run_id = ${runIdSql} AND event_type = 'forced_seed_statement';`,
    );
    const seedsApplied = configuredSeedPolicies.every((policy) =>
      enforcedSeedEvents.some((event) => event.agentId === policy.agentId && event.claimId === policy.claimId),
    );

    if (!evidenceAccessConfigured) {
      if (evidenceAccess === "private_split") {
        details.push("Every private-evidence card must begin with a non-empty proper subset of the roster.");
      } else if (evidenceAccess === "none") {
        details.push("The no-source reference must not contain any evidence cards.");
      } else if (evidenceAccess === "public_problem") {
        details.push("A public-problem task needs a non-empty group question.");
      } else {
        details.push("Every full-packet evidence card must be visible to every reference agent.");
      }
    }
    if (!sourceEntriesMatch) {
      details.push(`Expected ${expectedSharedSourceEntries} shared source entries for this task condition, found ${sourceEntryCount}.`);
    }
    if (condition.memory.mode === "shared" && !sharedMemoryUsed) {
      details.push("Shared record was enabled but no shared entry was later retrieved.");
    }
    if (configuredSeedPolicies.length > 0 && !seedsApplied) {
      details.push("A configured seeded statement was not written to the trace.");
    }

    return {
      passed: evidenceAccessConfigured && sourceEntriesMatch && sharedMemoryUsed && seedsApplied && details.length === 0,
      contaminationSeeded: configuredSeedPolicies.length > 0,
      contaminationFired: configuredSeedPolicies.length > 0 && seedsApplied,
      sharedMemoryUsed,
      correctionDelivered: false,
      correctionSeenByAgents: 0,
      falseMemorySeedCount: 0,
      falseMemoryWriteCount: 0,
      falseMemoryRetrievalCount: 0,
      falseMemoryRetrievalAgents: 0,
      verificationEnabled: false,
      details,
    };
  }

  const contaminationAgents = runConfig.agents
    .filter((agent) => agent.role === "contamination_agent")
    .map((agent) => agent.id);
  const explicitSeedAgents = runConfig.agents
    .filter((agent) => agent.seedStatementPolicy?.claimId === scenario.focusClaimId && agent.seedStatementPolicy.targetStance === "endorse")
    .map((agent) => agent.id);
  const falseSeedAgentIds = [...new Set([...contaminationAgents, ...explicitSeedAgents])];
  const contaminationSql = falseSeedAgentIds.length > 0
    ? falseSeedAgentIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ")
    : "''";

  const falseWrites = queryRows<{ id: string }>(
    dbPath,
    `
      SELECT memory_entry_id AS id
      FROM memory_entries
      WHERE run_id = ${runIdSql}
        AND claim_id = '${scenario.focusClaimId.replace(/'/g, "''")}'
        AND stance = 'endorse'
        AND source_type = 'agent'
        AND agent_id IN (${contaminationSql});
    `,
  );
  const falseSeeds = queryRows<{ id: string }>(
    dbPath,
    `
      SELECT memory_entry_id AS id
      FROM memory_entries
      WHERE run_id = ${runIdSql}
        AND claim_id = '${scenario.focusClaimId.replace(/'/g, "''")}'
        AND stance = 'endorse'
        AND source_type = 'seed'
        AND agent_id IN (${contaminationSql});
    `,
  );
  const falseMemoryIds = [...new Set([...falseSeeds.map((row) => row.id), ...falseWrites.map((row) => row.id)])];
  const explicitSeedEvents = queryRows<{ count: number }>(
    dbPath,
    `SELECT COUNT(*) AS count FROM events WHERE run_id = ${runIdSql} AND event_type = 'forced_seed_statement' AND claim_id = '${scenario.focusClaimId.replace(/'/g, "''")}';`,
  )[0]?.count ?? 0;
  const contaminationSeeded = falseSeeds.length > 0 || explicitSeedEvents > 0;
  const contaminationFired = falseWrites.length > 0 || explicitSeedEvents > 0;
  const contaminationInitiallyEndorsed = scenario.initialBeliefStates.some((state) =>
    contaminationAgents.includes(state.agentId) &&
    state.claimId === scenario.focusClaimId &&
    state.stance === "endorse",
  );
  if (!contaminationInitiallyEndorsed && !contaminationSeeded && !contaminationFired) {
    details.push("No contamination seed or contamination-agent endorsing memory was present for the focus claim.");
  }

  let falseMemoryRetrievalCount = 0;
  let falseMemoryRetrievalAgents = 0;
  if (falseMemoryIds.length > 0) {
    const retrievals = queryRows<{ agentId: string; ids: string }>(
      dbPath,
      `
        SELECT agent_id AS agentId, retrieved_entry_ids_json AS ids
        FROM retrieval_traces
        WHERE run_id = ${runIdSql}
          AND claim_id = '${scenario.focusClaimId.replace(/'/g, "''")}';
      `,
    );
    const seenAgents = new Set<string>();
    for (const row of retrievals) {
      const ids = JSON.parse(row.ids) as string[];
      if (ids.some((id) => falseMemoryIds.includes(id))) {
        falseMemoryRetrievalCount += 1;
        seenAgents.add(row.agentId);
      }
    }
    falseMemoryRetrievalAgents = seenAgents.size;
  }

  const sharedEntryIds = new Set(queryRows<{ id: string }>(
    dbPath,
    `
      SELECT memory_entry_id AS id
      FROM memory_entries
      WHERE run_id = ${runIdSql}
        AND claim_id = '${scenario.focusClaimId.replace(/'/g, "''")}'
        AND visibility = 'shared';
    `,
  ).map((row) => row.id));
  const sharedMemoryUsed = condition.memory.mode === "shared"
    ? queryRows<{ ids: string }>(
      dbPath,
      `
        SELECT retrieved_entry_ids_json AS ids
        FROM retrieval_traces
        WHERE run_id = ${runIdSql}
          AND claim_id = '${scenario.focusClaimId.replace(/'/g, "''")}';
      `,
    ).some((row) => (JSON.parse(row.ids) as string[]).some((id) => sharedEntryIds.has(id)))
    : true;
  if (condition.memory.mode === "shared" && !sharedMemoryUsed) {
    details.push("Shared memory was enabled but no shared focus-claim record was later retrieved.");
  }

  // Scenario templates may carry a correction for other conditions. A
  // no-correction condition deliberately resolves that template to no event.
  const hasCorrections = scenario.scheduledInterventions.length > 0 &&
    condition.interventions.correctionTiming !== "none";
  const correctionCount = queryRows<{ count: number }>(
    dbPath,
    `
      SELECT COUNT(*) AS count
      FROM interventions
      WHERE run_id = ${runIdSql}
        AND claim_id = '${scenario.focusClaimId.replace(/'/g, "''")}';
    `,
  )[0]?.count ?? 0;
  const correctionDelivered = hasCorrections ? correctionCount > 0 : false;
  if (hasCorrections && !correctionDelivered) {
    details.push("A correction was scheduled but no correction event was written to the trace.");
  }

  const correctionSeenByAgents = hasCorrections
    ? (queryRows<{ count: number }>(
      dbPath,
      `
        SELECT COUNT(DISTINCT agent_id) AS count
        FROM events
        WHERE run_id = ${runIdSql}
          AND json_array_length(json_extract(output_json, '$.activeInterventionIds')) > 0;
      `,
    )[0]?.count ?? 0)
    : 0;
  if (hasCorrections && correctionDelivered && correctionSeenByAgents === 0) {
    details.push("The correction fired but no agent step recorded it as active.");
  }

  const verificationEnabled = condition.interventions.verification.mode !== "none";
  const contaminationPresent = contaminationInitiallyEndorsed || contaminationSeeded || contaminationFired;
  const passed = contaminationPresent &&
    sharedMemoryUsed &&
    (!hasCorrections || (correctionDelivered && correctionSeenByAgents > 0)) &&
    details.length === 0;

  return {
    passed,
    contaminationSeeded,
    contaminationFired,
    sharedMemoryUsed,
    correctionDelivered,
    correctionSeenByAgents,
    falseMemorySeedCount: falseSeeds.length,
    falseMemoryWriteCount: falseWrites.length,
    falseMemoryRetrievalCount,
    falseMemoryRetrievalAgents,
    verificationEnabled,
    details,
  };
}

// --- Run the grid ---

export type OnGridProgress = (completed: number, total: number, cell: GridCell) => void;

// External-task group scenarios are unavailable until their controls have
// passed in the exact execution mode. Memory and chat have different prompts,
// records, and traces, so one cannot qualify the other.
function assertExternalTaskEligibility(grid: ExperimentGrid): void {
  for (const scenarioPath of grid.scenarios) {
    const scenario = loadScenario(scenarioPath);
    if (scenario.taskProtocol?.phase !== "group") continue;

    for (const conditionPath of grid.conditions) {
      const condition = loadCondition(conditionPath);
      assertTaskEligible(grid.projectRoot, scenarioPath, condition.interaction.mode);
    }
  }
}

function getCellRunId(gridId: string, cell: GridCell): string {
  return `${gridId}_${cell.scenarioId}_${cell.conditionId}_${cell.rosterId}-${cell.conditionId}-seed${cell.seed}`;
}

function getCellOutputDir(grid: ExperimentGrid, cell: GridCell): string {
  return path.join(grid.outputDir, getCellRunId(grid.id, cell));
}

function getCellSummaryPath(grid: ExperimentGrid, cell: GridCell): string {
  return path.join(getCellOutputDir(grid, cell), "summary.json");
}

function loadExistingCellResult(grid: ExperimentGrid, cell: GridCell): GridCellResult | null {
  const summaryPath = getCellSummaryPath(grid, cell);
  if (!fs.existsSync(summaryPath)) {
    return null;
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as RunSummary;
  const condition = loadCondition(cell.conditionPath);
  const scenario = loadScenario(cell.scenarioPath);
  const runConfig = JSON.parse(fs.readFileSync(cell.runConfigPath, "utf8")) as RunConfig;
  const manipulationCheck = checkManipulation(summary.dbPath, summary.runId, runConfig, condition, scenario);

  return {
    scenarioId: cell.scenarioId,
    conditionId: cell.conditionId,
    rosterId: cell.rosterId,
    rosterTitle: cell.rosterTitle,
    seed: cell.seed,
    summary,
    manipulationCheck,
  };
}

function buildInputCatalog(grid: ExperimentGrid): GridInputCatalog {
  return {
    scenarios: grid.scenarios.map((scenarioPath) => {
      const scenario = loadScenario(scenarioPath);
      return {
        id: scenario.id,
        title: scenario.title,
        path: scenarioPath,
      };
    }),
    conditions: grid.conditions.map((conditionPath) => {
      const condition = loadCondition(conditionPath);
      return {
        id: condition.id,
        title: condition.title,
        path: conditionPath,
      };
    }),
    rosters: grid.rosters.map((roster) => ({
      id: roster.id,
      title: roster.title,
      path: roster.sourcePath ?? "",
      agentCount: roster.agents.length,
    })),
  };
}

export async function runGrid(
  grid: ExperimentGrid,
  options: {
    onProgress?: OnGridProgress;
    runOptions?: RunExperimentOptions;
  } = {},
): Promise<GridResult> {
  assertExternalTaskEligibility(grid);
  const cells = generateCells(grid);
  const totalCells = cells.length;
  const cellResults: GridCellResult[] = [];
  const inputCatalog = buildInputCatalog(grid);
  let completed = 0;

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const cached = loadExistingCellResult(grid, cell);
    if (cached) {
      cellResults.push(cached);
      completed += 1;
      options.onProgress?.(completed, totalCells, cell);
      continue;
    }

    options.onProgress?.(completed, totalCells, cell);

    const summary = await runExperimentAsync(cell.runConfigPath, {
      ...options.runOptions,
      outputRootOverride: grid.outputDir,
    });

    const condition = loadCondition(cell.conditionPath);
    const scenario = loadScenario(cell.scenarioPath);
    const runConfig = JSON.parse(fs.readFileSync(cell.runConfigPath, "utf8")) as RunConfig;
    const manipulationCheck = checkManipulation(summary.dbPath, summary.runId, runConfig, condition, scenario);

    cellResults.push({
      scenarioId: cell.scenarioId,
      conditionId: cell.conditionId,
      rosterId: cell.rosterId,
      rosterTitle: cell.rosterTitle,
      seed: cell.seed,
      summary,
      manipulationCheck,
    });

    completed += 1;
    options.onProgress?.(completed, totalCells, cell);
  }

  // Build paired comparisons
  const pairings = buildPairings(cellResults);

  // Build summary table
  const summaryTable = buildSummaryTable(cellResults, inputCatalog.conditions);

  // Save results
  const outputPath = path.join(grid.outputDir, `${grid.id}-grid-results.json`);
  const provenancePath = path.join(grid.outputDir, `${grid.id}-figure-provenance.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const result: GridResult = {
    grid,
    cells: cellResults,
    pairings,
    summaryTable,
    manifestInfo: {
      sourceManifestPath: grid.sourceManifestPath ?? null,
      requestedManifestPath: grid.requestedManifestPath ?? null,
      benchmarkMeta: grid.benchmarkMeta ?? null,
      generatedAt: new Date().toISOString(),
    },
    inputCatalog,
    metricCatalog: GRID_METRIC_METADATA,
    provenancePath,
    outputPath,
  };

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");
  fs.writeFileSync(provenancePath, JSON.stringify({
    studyId: grid.id,
    title: grid.title,
    resultPath: outputPath,
    sourceManifestPath: grid.sourceManifestPath ?? null,
    requestedManifestPath: grid.requestedManifestPath ?? null,
    benchmarkMeta: grid.benchmarkMeta ?? null,
    scenarios: inputCatalog.scenarios.map(({ id, title, path: sourcePath }) => ({ id, title, sourcePath })),
    conditions: inputCatalog.conditions.map(({ id, title, path: sourcePath }) => ({ id, title, sourcePath })),
    rosters: inputCatalog.rosters.map(({ id, title, path: sourcePath, agentCount }) => ({ id, title, sourcePath, agentCount })),
    metricCatalog: GRID_METRIC_METADATA,
    generatedAt: result.manifestInfo.generatedAt,
  }, null, 2), "utf8");

  const allModels = [...new Set(grid.rosters.flatMap((roster) => roster.agents.map((agent) => agent.model)))].sort();
  createArchiveRecord({
    projectRoot: grid.projectRoot,
    kind: "grid",
    title: grid.title,
    question: grid.title,
    note: "Factorial benchmark grid run.",
    command: grid.sourceManifestPath
      ? `experiment ${path.relative(grid.projectRoot, grid.sourceManifestPath)}`
      : `experiment ${path.relative(grid.projectRoot, outputPath).replace(/-grid-results\.json$/, ".json")}`,
    tags: ["grid", "benchmark"],
    scenarios: [...new Set(result.cells.map((cell) => cell.scenarioId))].sort(),
    conditions: [...new Set(result.cells.map((cell) => cell.conditionId))].sort(),
    rosters: [...new Set(result.cells.map((cell) => cell.rosterId))].sort(),
    models: allModels,
    seeds: grid.seeds,
    runIds: result.cells.map((cell) => cell.summary.runId),
    primaryOutputPath: outputPath,
    extraOutputPaths: [
      ...(grid.sourceManifestPath ? [grid.sourceManifestPath] : []),
      provenancePath,
      ...result.cells.map((cell) => cell.summary.dbPath),
    ],
    manifestPath: grid.sourceManifestPath ?? null,
    requestedManifestPath: grid.requestedManifestPath ?? null,
    benchmarkMeta: grid.benchmarkMeta ?? null,
    metrics: {
      completedCells: result.cells.length,
      manipulationCheckPassRate: result.cells.length > 0
        ? result.cells.filter((cell) => cell.manipulationCheck.passed).length / result.cells.length
        : 0,
    },
    provenance: grid.provenance ?? null,
    citations: grid.citations ?? null,
  });
  return result;
}

// --- Paired comparisons ---

function buildPairings(
  cells: GridCellResult[],
): PairedComparison[] {
  const pairings: PairedComparison[] = [];
  const conditionIds = [...new Set(cells.map((c) => c.conditionId))];

  for (let a = 0; a < conditionIds.length; a++) {
    for (let b = a + 1; b < conditionIds.length; b++) {
      const condA = conditionIds[a];
      const condB = conditionIds[b];

      // Find matching pairs: same scenario, same seed
      const cellsA = cells.filter((c) => c.conditionId === condA);
      const cellsB = cells.filter((c) => c.conditionId === condB);

      for (const cA of cellsA) {
        const cB = cellsB.find(
          (c) => c.scenarioId === cA.scenarioId && c.seed === cA.seed && c.rosterId === cA.rosterId,
        );
        if (!cB) continue;

        pairings.push({
          scenarioId: cA.scenarioId,
          rosterId: cA.rosterId,
          seed: cA.seed,
          conditionA: condA,
          conditionB: condB,
          metricDeltas: {
            falseClaimEndorsementRate:
              cB.summary.falseClaimEndorsementRate - cA.summary.falseClaimEndorsementRate,
            peakFalseClaimEndorsementRate:
              cB.summary.peakFalseClaimEndorsementRate - cA.summary.peakFalseClaimEndorsementRate,
            distanceFromGroundTruth:
              cB.summary.distanceFromGroundTruth - cA.summary.distanceFromGroundTruth,
            recoveryAfterCorrection:
              cB.summary.recoveryAfterCorrection - cA.summary.recoveryAfterCorrection,
            diversityRetention:
              cB.summary.diversityRetention - cA.summary.diversityRetention,
          },
        });
      }
    }
  }

  return pairings;
}

// --- Summary table ---

function buildSummaryTable(
  cells: GridCellResult[],
  conditions: InputReference[],
): ConditionSummaryRow[] {
  const groups = [...new Set(cells.map((c) => `${c.conditionId}::${c.rosterId}`))];
  const conditionTitleById = new Map(conditions.map((condition) => [condition.id, condition.title]));

  return groups.map((groupKey) => {
    const [condId, rosterId] = groupKey.split("::");
    const condCells = cells.filter((c) => c.conditionId === condId && c.rosterId === rosterId);
    const summaries = condCells.map((c) => c.summary);
    const n = summaries.length;
    const rosterTitle = condCells[0]?.rosterTitle ?? rosterId;

    const vals = (fn: (s: RunSummary) => number) => summaries.map(fn);
    const majorityTimes = summaries
      .map((s) => s.timeToMajorityAdoption)
      .filter((v): v is number => v !== null);

    const fcer = vals((s) => s.falseClaimEndorsementRate);
    const passCount = condCells.filter((c) => c.manipulationCheck.passed).length;

    return {
      conditionId: condId,
      conditionTitle: conditionTitleById.get(condId) ?? condId,
      rosterId,
      rosterTitle,
      label: rosterId === "default"
        ? (conditionTitleById.get(condId) ?? condId)
        : `${conditionTitleById.get(condId) ?? condId} / ${rosterTitle}`,
      n,
      falseClaimEndorsementRate: {
        mean: mean(fcer),
        std: std(fcer),
        ci95: ci95(fcer, [0, 1]),
      },
      peakFalseClaimEndorsementRate: {
        mean: mean(vals((s) => s.peakFalseClaimEndorsementRate)),
        std: std(vals((s) => s.peakFalseClaimEndorsementRate)),
        ci95: ci95(vals((s) => s.peakFalseClaimEndorsementRate), [0, 1]),
      },
      distanceFromGroundTruth: {
        mean: mean(vals((s) => s.distanceFromGroundTruth)),
        std: std(vals((s) => s.distanceFromGroundTruth)),
        ci95: ci95(vals((s) => s.distanceFromGroundTruth), [0, 1]),
      },
      recoveryAfterCorrection: {
        mean: mean(vals((s) => s.recoveryAfterCorrection)),
        std: std(vals((s) => s.recoveryAfterCorrection)),
        ci95: ci95(vals((s) => s.recoveryAfterCorrection), [-1, 1]),
      },
      diversityRetention: {
        mean: mean(vals((s) => s.diversityRetention)),
        std: std(vals((s) => s.diversityRetention)),
        ci95: ci95(vals((s) => s.diversityRetention), [0, 1]),
      },
      timeToMajorityAdoption: {
        mean: majorityTimes.length > 0 ? mean(majorityTimes) : null,
        count: majorityTimes.length,
      },
      manipulationCheckPassRate: n > 0 ? passCount / n : 0,
    };
  });
}

// --- Stats helpers ---

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

function clampToBounds(value: number, bounds?: [number, number]): number {
  if (!bounds) return value;
  return Math.max(bounds[0], Math.min(bounds[1], value));
}

function ci95(values: number[], bounds?: [number, number]): [number, number] {
  if (values.length < 2) return [mean(values), mean(values)];
  const m = mean(values);
  const se = std(values) / Math.sqrt(values.length);
  // t-value for 95% CI approximation (use 1.96 for large n, conservative for small)
  const t = values.length >= 30 ? 1.96 : tCritical(values.length - 1);
  return [clampToBounds(m - t * se, bounds), clampToBounds(m + t * se, bounds)];
}

// Approximate t critical values for small samples (two-tailed, 0.05)
function tCritical(df: number): number {
  const table: Record<number, number> = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
    6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
    15: 2.131, 20: 2.086, 25: 2.060, 30: 2.042,
  };
  if (table[df]) return table[df];
  // Find nearest
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
  for (const k of keys) {
    if (k >= df) return table[k];
  }
  return 1.96;
}
