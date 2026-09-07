import fs from "fs";
import path from "path";
import os from "os";

import { createArchiveRecord, listArchiveRecords, readArchiveRecord, type ArchiveRecord } from "./archive";
import { loadCondition, loadRunConfig, loadScenario, resolveRelativeConfigPath } from "./config/load";
import type { AgentSpec, ChatMessage, CitationBundle, Condition, Provenance, RunConfig, RunSummary, Scenario } from "./config/schema";
import { queryRows } from "./db/sqlite";
import { runExperimentSync, runExperimentAsync, type RunExperimentOptions } from "./engine/run";
import { analyzeDebate, type PhysicsReport } from "./physics/analyze";

export type ValidationResult = {
  ok: true;
  runConfig: string;
  scenario: string;
  condition: string;
};

export type ComparisonResult = {
  runs: [RunSummary, RunSummary];
  deltas: {
    falseClaimEndorsementRate: number;
    peakFalseClaimEndorsementRate: number;
    timeToMajorityAdoption: number | null;
    distanceFromGroundTruth: number;
    recoveryAfterCorrection: number;
    diversityRetention: number;
  };
  majorityAdoptionComparison: Record<string, number | null>;
  comparePath: string;
};

export type ArchiveOverview = {
  records: ArchiveRecord[];
};

export type DiscoveredRunConfig = {
  path: string;
  fileName: string;
  configId: string;
  title: string;
  scenarioId: string;
  scenarioTitle: string;
  conditionId: string;
  conditionTitle: string;
  memoryMode: Condition["memory"]["mode"];
  seed: number;
  agentCount: number;
  maxSteps: number;
  maxModelCalls: number;
};

export type QuickRunOverrides = {
  seed?: number;
  maxSteps?: number;
  maxModelCalls?: number;
  agentCount?: number;
  agents?: AgentSpec[];
};

function mergeCitationBundles(...bundles: Array<CitationBundle | undefined>): CitationBundle | null {
  const merged: CitationBundle = {
    motivation: [],
    mechanism: [],
    scenario: [],
    metric: [],
  };
  const seen = new Set<string>();
  for (const bundle of bundles) {
    if (!bundle) continue;
    for (const key of ["motivation", "mechanism", "scenario", "metric"] as const) {
      for (const item of bundle[key] ?? []) {
        const marker = `${key}|${item.title}|${item.url ?? ""}|${item.note ?? ""}`;
        if (seen.has(marker)) continue;
        seen.add(marker);
        merged[key].push(item);
      }
    }
  }
  return Object.values(merged).some((items) => items.length > 0) ? merged : null;
}

function preferProvenance(...items: Array<Provenance | undefined>): Provenance | null {
  return items.find(Boolean) ?? null;
}

function loadResolvedExperimentFiles(runConfigPath: string): {
  runConfig: ReturnType<typeof loadRunConfig>;
  scenario: Scenario;
  condition: Condition;
  scenarioPath: string;
  conditionPath: string;
} {
  const runConfig = loadRunConfig(runConfigPath);
  const scenarioPath = resolveRelativeConfigPath(runConfigPath, runConfig.scenarioPath);
  const conditionPath = resolveRelativeConfigPath(runConfigPath, runConfig.conditionPath);
  const scenario = loadScenario(scenarioPath);
  const condition = loadCondition(conditionPath);
  return { runConfig, scenario, condition, scenarioPath, conditionPath };
}

export function validateRunConfigFile(runConfigPath: string): ValidationResult {
  const { scenarioPath, conditionPath } = loadResolvedExperimentFiles(runConfigPath);
  return {
    ok: true,
    runConfig: path.basename(runConfigPath),
    scenario: path.basename(scenarioPath),
    condition: path.basename(conditionPath),
  };
}

export async function runFromConfigAsync(runConfigPath: string, options: RunExperimentOptions = {}): Promise<RunSummary> {
  const summary = await runExperimentAsync(runConfigPath, options);
  const { runConfig, scenario, condition } = loadResolvedExperimentFiles(runConfigPath);
  const models = [...new Set(runConfig.agents.map((agent) => agent.model))].sort();
  createArchiveRecord({
    projectRoot: options.projectRoot ?? process.cwd(),
    kind: "single-run",
    title: runConfig.title,
    question: null,
    note: null,
    command: `run ${path.relative(options.projectRoot ?? process.cwd(), runConfigPath)}`,
    tags: ["single-run", condition.memory.mode, condition.interaction.mode],
    scenarios: [scenario.id],
    conditions: [condition.id],
    rosters: [],
    models,
    seeds: [runConfig.seed],
    runIds: [summary.runId],
    primaryOutputPath: summary.dbPath,
    extraOutputPaths: [path.join(path.dirname(summary.dbPath), "summary.json")],
    metrics: {
      falseClaimEndorsementRate: summary.falseClaimEndorsementRate,
      recoveryAfterCorrection: summary.recoveryAfterCorrection,
      diversityRetention: summary.diversityRetention,
    },
    provenance: preferProvenance(scenario.provenance, condition.provenance),
    citations: mergeCitationBundles(scenario.citations, condition.citations),
  });
  return summary;
}

/** @internal Sync runner for tests only — uses heuristic models. Do not use for experiments. */
export function runFromConfigSync(runConfigPath: string, options: RunExperimentOptions = {}): RunSummary {
  return runExperimentSync(runConfigPath, options);
}

export async function compareRunConfigs(
  runConfigPathA: string,
  runConfigPathB: string,
  compareOutputDir = path.resolve(process.cwd(), "comparisons"),
): Promise<ComparisonResult> {
  const summaryA = await runExperimentAsync(runConfigPathA);
  const summaryB = await runExperimentAsync(runConfigPathB);
  const comparison: ComparisonResult = {
    runs: [summaryA, summaryB],
    deltas: {
      falseClaimEndorsementRate: summaryB.falseClaimEndorsementRate - summaryA.falseClaimEndorsementRate,
      peakFalseClaimEndorsementRate:
        summaryB.peakFalseClaimEndorsementRate - summaryA.peakFalseClaimEndorsementRate,
      timeToMajorityAdoption:
        summaryA.timeToMajorityAdoption === null || summaryB.timeToMajorityAdoption === null
          ? null
          : summaryB.timeToMajorityAdoption - summaryA.timeToMajorityAdoption,
      distanceFromGroundTruth: summaryB.distanceFromGroundTruth - summaryA.distanceFromGroundTruth,
      recoveryAfterCorrection: summaryB.recoveryAfterCorrection - summaryA.recoveryAfterCorrection,
      diversityRetention: summaryB.diversityRetention - summaryA.diversityRetention,
    },
    majorityAdoptionComparison: {
      [summaryA.conditionId]: summaryA.timeToMajorityAdoption,
      [summaryB.conditionId]: summaryB.timeToMajorityAdoption,
    },
    comparePath: "",
  };

  fs.mkdirSync(compareOutputDir, { recursive: true });
  const comparePath = path.join(compareOutputDir, `${summaryA.runId}-vs-${summaryB.runId}.json`);
  fs.writeFileSync(comparePath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
  comparison.comparePath = comparePath;

  const configA = loadResolvedExperimentFiles(runConfigPathA);
  const configB = loadResolvedExperimentFiles(runConfigPathB);
  createArchiveRecord({
    projectRoot: process.cwd(),
    kind: "compare",
    title: `${configA.condition.id} vs ${configB.condition.id}`,
    question: "How do these two conditions differ on the same benchmark setup?",
    note: null,
    command: `compare ${path.relative(process.cwd(), runConfigPathA)} ${path.relative(process.cwd(), runConfigPathB)}`,
    tags: ["compare", configA.condition.memory.mode, configB.condition.memory.mode],
    scenarios: [configA.scenario.id, configB.scenario.id],
    conditions: [configA.condition.id, configB.condition.id],
    rosters: [],
    models: [...new Set([
      ...configA.runConfig.agents.map((agent) => agent.model),
      ...configB.runConfig.agents.map((agent) => agent.model),
    ])].sort(),
    seeds: [configA.runConfig.seed, configB.runConfig.seed],
    runIds: [summaryA.runId, summaryB.runId],
    primaryOutputPath: comparePath,
    extraOutputPaths: [summaryA.dbPath, summaryB.dbPath],
    metrics: {
      deltaFalseClaimEndorsementRate: comparison.deltas.falseClaimEndorsementRate,
      deltaRecoveryAfterCorrection: comparison.deltas.recoveryAfterCorrection,
      deltaDiversityRetention: comparison.deltas.diversityRetention,
    },
    provenance: preferProvenance(configA.scenario.provenance, configA.condition.provenance, configB.scenario.provenance, configB.condition.provenance),
    citations: mergeCitationBundles(
      configA.scenario.citations,
      configA.condition.citations,
      configB.scenario.citations,
      configB.condition.citations,
    ),
  });

  return comparison;
}

export function discoverRunConfigs(projectRoot = process.cwd()): DiscoveredRunConfig[] {
  const runConfigDir = path.resolve(projectRoot, "run-configs");
  if (!fs.existsSync(runConfigDir)) {
    return [];
  }

  return fs
    .readdirSync(runConfigDir)
    .filter((fileName) => fileName.endsWith(".yaml") || fileName.endsWith(".yml"))
    .sort()
    .map((fileName) => {
      const runConfigPath = path.join(runConfigDir, fileName);
      const { runConfig, scenario, condition } = loadResolvedExperimentFiles(runConfigPath);
      return {
        path: runConfigPath,
        fileName,
        configId: runConfig.id,
        title: runConfig.title,
        scenarioId: scenario.id,
        scenarioTitle: scenario.title,
        conditionId: condition.id,
        conditionTitle: condition.title,
        memoryMode: condition.memory.mode,
        seed: runConfig.seed,
        agentCount: runConfig.agents.length,
        maxSteps: runConfig.maxSteps,
        maxModelCalls: runConfig.budget.maxModelCalls,
      };
    });
}

export function listRecentRunSummaries(projectRoot = process.cwd()): RunSummary[] {
  const outputDir = path.resolve(projectRoot, "output");
  if (!fs.existsSync(outputDir)) {
    return [];
  }

  const summaries = fs
    .readdirSync(outputDir)
    .map((runId) => ({
      runId,
      summaryPath: path.join(outputDir, runId, "summary.json"),
    }))
    .filter(({ summaryPath }) => fs.existsSync(summaryPath))
    .map(({ summaryPath }) => {
      const stat = fs.statSync(summaryPath);
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as RunSummary;
      return { summary, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ summary }) => summary);

  return summaries;
}

export function listArchivedExperiments(projectRoot = process.cwd(), limit = 50): ArchiveOverview {
  return { records: listArchiveRecords(projectRoot, limit) };
}

export function inspectArchivedExperiment(recordId: string, projectRoot = process.cwd()): ArchiveRecord {
  return readArchiveRecord(projectRoot, recordId);
}

// --- Batch runner ---

export type BatchResult = {
  seeds: number[];
  summaries: RunSummary[];
  aggregated: {
    falseClaimEndorsementRate: { mean: number; std: number };
    peakFalseClaimEndorsementRate: { mean: number; std: number };
    timeToMajorityAdoption: { mean: number | null; count: number };
    distanceFromGroundTruth: { mean: number; std: number };
    recoveryAfterCorrection: { mean: number; std: number };
    diversityRetention: { mean: number; std: number };
  };
  batchPath: string;
};

export type InspectionMetricPoint = {
  step: number;
  falseClaimEndorsementRate: number;
  falseClaimRejectRate: number;
  distanceFromGroundTruth: number;
  diversityRetention: number;
  consensusStrength: number;
  netEndorsement: number;
};

export type InspectionIntervention = {
  step: number;
  interventionId: string;
  claimId: string;
  type: string;
  text: string;
  effect: number;
};

export type InspectionEvent = {
  step: number;
  agentId: string;
  focusClaimStance: string;
  wroteMemory: boolean;
  retrievedMemoryCount: number;
  interventionCount: number;
};

export type InspectionMemoryEntry = {
  step: number;
  agentId: string;
  claimId: string;
  stance: string;
  confidence: number;
  visibility: string;
  sourceType: string;
  text: string;
};

export type InspectionFinalState = {
  agentId: string;
  claimId: string;
  truthLabel: string;
  stance: string;
  confidence: number;
};

export type InspectionMemoryFlow = {
  agentId: string;
  writes: number;
  retrievals: number;
  endorseWrites: number;
  rejectWrites: number;
  uncertainWrites: number;
  lastWriteStep: number | null;
};

export type InspectionClaimMatrixCell = {
  step: number;
  stance: string;
  confidence: number;
};

export type InspectionClaimMatrixRow = {
  agentId: string;
  states: InspectionClaimMatrixCell[];
};

export type InspectionAdoption = {
  step: number;
  agentId: string;
  claimId: string;
  stance: string;
  sourceAgentId: string;
  sourceMemoryEntryId: string;
  previousStance: string;
  previousConfidence: number;
  currentConfidence: number;
};

export type InspectionLineage = {
  step: number;
  claimId: string;
  parentAgentId: string;
  childAgentId: string;
  parentMemoryEntryId: string;
  childMemoryEntryId: string;
  relationType: string;
};

export type InspectionScenarioContext = {
  scenarioTitle: string;
  focusClaimText: string;
  focusClaimTruthLabel: string;
  sourceLabels: string[];
  seedNotes: string[];
};

export type RunInspection = {
  summary: RunSummary;
  status: string;
  engineMode: string;
  focusClaimId: string | null;
  scenarioContext: InspectionScenarioContext | null;
  metricTimeline: InspectionMetricPoint[];
  interventions: InspectionIntervention[];
  recentEvents: InspectionEvent[];
  recentMemoryEntries: InspectionMemoryEntry[];
  finalFocusStates: InspectionFinalState[];
  memoryFlow: InspectionMemoryFlow[];
  claimMatrix: InspectionClaimMatrixRow[];
  testimonyAdoptions: InspectionAdoption[];
  claimLineage: InspectionLineage[];
};

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function loadSummaryFromDb(dbPath: string): RunSummary {
  const rows = queryRows<{ metric_json: string }>(
    dbPath,
    "SELECT metric_json FROM metric_records WHERE metric_name = 'run_summary' ORDER BY metric_record_id DESC LIMIT 1;",
  );
  const raw = rows[0]?.metric_json;
  if (!raw) {
    throw new Error(`Could not find run summary in ${dbPath}`);
  }
  return JSON.parse(raw) as RunSummary;
}

function resolveScenarioContext(
  scenarioId: string,
  projectRoot: string,
): InspectionScenarioContext | null {
  const scenarioDir = path.resolve(projectRoot, "scenarios");
  if (!fs.existsSync(scenarioDir)) return null;

  for (const fileName of fs.readdirSync(scenarioDir)) {
    if (!fileName.endsWith(".yaml") && !fileName.endsWith(".yml")) continue;
    try {
      const scenario = loadScenario(path.join(scenarioDir, fileName));
      if (scenario.id !== scenarioId) continue;
      const focusClaim = scenario.claims.find((claim) => claim.id === scenario.focusClaimId);
      const seedNotes: string[] = [];
      const focusSeedEntries = scenario.initialMemoryEntries.filter((entry) => entry.claimId === scenario.focusClaimId);
      if (focusSeedEntries.length > 0) {
        const seedAgents = [...new Set(focusSeedEntries.map((entry) => entry.agentId))];
        seedNotes.push(`${focusSeedEntries.length} initial memory entries for the focus claim from ${seedAgents.join(", ")}`);
      } else {
        seedNotes.push("no initial memory entries for the focus claim");
      }
      if (scenario.scheduledInterventions.length > 0) {
        const first = scenario.scheduledInterventions[0];
        seedNotes.push(`first correction is scheduled for step ${first.step}`);
      } else {
        seedNotes.push("no scheduled correction in this scenario");
      }
      return {
        scenarioTitle: scenario.title,
        focusClaimText: focusClaim?.text ?? scenario.focusClaimId,
        focusClaimTruthLabel: focusClaim?.truthLabel ?? "unknown",
        sourceLabels: scenario.sourceCards.length > 0
          ? scenario.sourceCards.map((card) => `${card.id}: ${card.title}`)
          : (scenario.sources ?? []).map((source, index) => `${source.id ?? `source_${index + 1}`}: ${source.label}`),
        seedNotes,
      };
    } catch {
      continue;
    }
  }

  return null;
}

function resolveInspectionPaths(
  target: string,
  projectRoot: string,
): { dbPath: string; summary: RunSummary } {
  const resolvedTarget = path.resolve(target);

  if (fs.existsSync(resolvedTarget)) {
    const stat = fs.statSync(resolvedTarget);
    if (stat.isDirectory()) {
      const summaryPath = path.join(resolvedTarget, "summary.json");
      if (!fs.existsSync(summaryPath)) {
        throw new Error(`No summary.json found in ${resolvedTarget}`);
      }
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as RunSummary;
      return { dbPath: summary.dbPath, summary };
    }

    if (path.basename(resolvedTarget) === "summary.json") {
      const summary = JSON.parse(fs.readFileSync(resolvedTarget, "utf8")) as RunSummary;
      return { dbPath: summary.dbPath, summary };
    }

    if (path.basename(resolvedTarget) === "trace.db") {
      const summaryPath = path.join(path.dirname(resolvedTarget), "summary.json");
      const summary = fs.existsSync(summaryPath)
        ? JSON.parse(fs.readFileSync(summaryPath, "utf8")) as RunSummary
        : loadSummaryFromDb(resolvedTarget);
      return { dbPath: resolvedTarget, summary };
    }
  }

  const summaryPath = path.resolve(projectRoot, "output", target, "summary.json");
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Could not resolve run target "${target}". Pass a run id, summary.json, trace.db, or run output directory.`);
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as RunSummary;
  return { dbPath: summary.dbPath, summary };
}

export function inspectRun(target: string, projectRoot = process.cwd()): RunInspection {
  const { dbPath, summary } = resolveInspectionPaths(target, projectRoot);
  const runIdSql = sqlString(summary.runId);

  const focusClaimId = queryRows<{ claimId: string }>(
    dbPath,
    `SELECT claim_id AS claimId FROM events WHERE run_id = ${runIdSql} ORDER BY step_index ASC LIMIT 1;`,
  )[0]?.claimId ?? null;

  const metadataRow = queryRows<{ run_metadata_json: string }>(
    dbPath,
    `SELECT run_metadata_json FROM runs WHERE run_id = ${runIdSql} LIMIT 1;`,
  )[0];
  const metadata = metadataRow ? JSON.parse(metadataRow.run_metadata_json) as { engineMode?: string } : {};

  const finalizedStatus = queryRows<{ status: string }>(
    dbPath,
    `SELECT status FROM runs WHERE run_id = ${sqlString(`${summary.runId}__finalized`)} LIMIT 1;`,
  )[0]?.status;
  const initialStatus = queryRows<{ status: string }>(
    dbPath,
    `SELECT status FROM runs WHERE run_id = ${runIdSql} LIMIT 1;`,
  )[0]?.status;

  const metricTimeline = queryRows<InspectionMetricPoint>(
    dbPath,
    `
      SELECT
        step_index AS step,
        json_extract(metric_json, '$.falseClaimEndorsementRate') AS falseClaimEndorsementRate,
        json_extract(metric_json, '$.falseClaimRejectRate') AS falseClaimRejectRate,
        json_extract(metric_json, '$.distanceFromGroundTruth') AS distanceFromGroundTruth,
        json_extract(metric_json, '$.diversityRetention') AS diversityRetention,
        json_extract(metric_json, '$.consensusStrength') AS consensusStrength,
        json_extract(metric_json, '$.netEndorsement') AS netEndorsement
      FROM metric_records
      WHERE run_id = ${runIdSql}
        AND metric_name = 'falseClaimEndorsementRate'
        AND step_index IS NOT NULL
      ORDER BY step_index ASC;
    `,
  );

  const interventions = queryRows<{
    step: number;
    interventionId: string;
    claimId: string;
    type: string;
    payloadJson: string;
  }>(
    dbPath,
    `
      SELECT
        step_index AS step,
        intervention_id AS interventionId,
        claim_id AS claimId,
        intervention_type AS type,
        payload_json AS payloadJson
      FROM interventions
      WHERE run_id = ${runIdSql}
      ORDER BY step_index ASC, intervention_event_id ASC;
    `,
  ).map((row) => {
    const payload = JSON.parse(row.payloadJson) as { text?: string; effect?: number };
    return {
      step: row.step,
      interventionId: row.interventionId,
      claimId: row.claimId,
      type: row.type,
      text: payload.text ?? "",
      effect: payload.effect ?? 0,
    };
  });

  const recentEvents = queryRows<{
    step: number;
    agentId: string;
    outputJson: string;
  }>(
    dbPath,
    `
      SELECT
        step_index AS step,
        agent_id AS agentId,
        output_json AS outputJson
      FROM events
      WHERE run_id = ${runIdSql}
      ORDER BY step_index DESC, event_id DESC
      LIMIT 6;
    `,
  )
    .map((row) => {
      const output = JSON.parse(row.outputJson) as {
        focusClaimStance?: string;
        writtenMemoryEntryId?: string | null;
        retrievedMemoryIds?: string[];
        activeInterventionIds?: string[];
      };
      return {
        step: row.step,
        agentId: row.agentId,
        focusClaimStance: output.focusClaimStance ?? "uncertain",
        wroteMemory: output.writtenMemoryEntryId !== null && output.writtenMemoryEntryId !== undefined,
        retrievedMemoryCount: output.retrievedMemoryIds?.length ?? 0,
        interventionCount: output.activeInterventionIds?.length ?? 0,
      };
    })
    .reverse();

  const recentMemoryEntries = queryRows<InspectionMemoryEntry>(
    dbPath,
    `
      SELECT
        step_index AS step,
        agent_id AS agentId,
        claim_id AS claimId,
        stance,
        confidence,
        visibility,
        source_type AS sourceType,
        entry_text AS text
      FROM memory_entries
      WHERE run_id = ${runIdSql}
      ORDER BY step_index DESC, rowid DESC
      LIMIT 6;
    `,
  ).reverse();

  const memoryFlow = (() => {
    if (!focusClaimId) return [] as InspectionMemoryFlow[];

    const writeRows = queryRows<{
      agentId: string;
      writes: number;
      endorseWrites: number;
      rejectWrites: number;
      uncertainWrites: number;
      lastWriteStep: number | null;
    }>(
      dbPath,
      `
        SELECT
          agent_id AS agentId,
          COUNT(*) AS writes,
          SUM(CASE WHEN stance = 'endorse' THEN 1 ELSE 0 END) AS endorseWrites,
          SUM(CASE WHEN stance = 'reject' THEN 1 ELSE 0 END) AS rejectWrites,
          SUM(CASE WHEN stance = 'uncertain' THEN 1 ELSE 0 END) AS uncertainWrites,
          MAX(step_index) AS lastWriteStep
        FROM memory_entries
        WHERE run_id = ${runIdSql}
          AND claim_id = ${sqlString(focusClaimId)}
        GROUP BY agent_id
        ORDER BY writes DESC, agent_id ASC;
      `,
    );

    const retrievalRows = queryRows<{
      agentId: string;
      retrievedIdsJson: string;
    }>(
      dbPath,
      `
        SELECT
          agent_id AS agentId,
          retrieved_entry_ids_json AS retrievedIdsJson
        FROM retrieval_traces
        WHERE run_id = ${runIdSql}
          AND claim_id = ${sqlString(focusClaimId)}
        ORDER BY step_index ASC;
      `,
    );

    const retrievalCounts = new Map<string, number>();
    for (const row of retrievalRows) {
      let count = 0;
      try {
        const ids = JSON.parse(row.retrievedIdsJson) as unknown[];
        count = Array.isArray(ids) ? ids.length : 0;
      } catch {
        count = 0;
      }
      retrievalCounts.set(row.agentId, (retrievalCounts.get(row.agentId) ?? 0) + count);
    }

    const agentIds = new Set<string>([
      ...writeRows.map((row) => row.agentId),
      ...retrievalCounts.keys(),
    ]);

    return Array.from(agentIds)
      .map((agentId) => {
        const writeRow = writeRows.find((row) => row.agentId === agentId);
        return {
          agentId,
          writes: writeRow?.writes ?? 0,
          retrievals: retrievalCounts.get(agentId) ?? 0,
          endorseWrites: writeRow?.endorseWrites ?? 0,
          rejectWrites: writeRow?.rejectWrites ?? 0,
          uncertainWrites: writeRow?.uncertainWrites ?? 0,
          lastWriteStep: writeRow?.lastWriteStep ?? null,
        };
      })
      .sort((a, b) => {
        const aScore = a.writes * 1000 + a.retrievals;
        const bScore = b.writes * 1000 + b.retrievals;
        return bScore - aScore || a.agentId.localeCompare(b.agentId);
      });
  })();

  const finalFocusStates = focusClaimId
    ? queryRows<InspectionFinalState>(
      dbPath,
      `
        SELECT
          agent_id AS agentId,
          claim_id AS claimId,
          truth_label AS truthLabel,
          stance,
          confidence
        FROM agent_claim_states
        WHERE run_id = ${runIdSql}
          AND claim_id = ${sqlString(focusClaimId)}
          AND step_index = (
            SELECT MAX(step_index)
            FROM agent_claim_states
            WHERE run_id = ${runIdSql}
              AND claim_id = ${sqlString(focusClaimId)}
          )
        ORDER BY agent_id ASC;
      `,
    )
    : [];

  const claimMatrix = (() => {
    if (!focusClaimId) return [] as InspectionClaimMatrixRow[];

    const rows = queryRows<{
      agentId: string;
      step: number;
      stance: string;
      confidence: number;
    }>(
      dbPath,
      `
        SELECT
          agent_id AS agentId,
          step_index AS step,
          stance,
          confidence
        FROM agent_claim_states
        WHERE run_id = ${runIdSql}
          AND claim_id = ${sqlString(focusClaimId)}
        ORDER BY agent_id ASC, step_index ASC;
      `,
    );

    const steps = Array.from({ length: summary.completedSteps + 1 }, (_, index) => index);
    const byAgent = new Map<string, Map<number, { stance: string; confidence: number }>>();
    for (const row of rows) {
      const map = byAgent.get(row.agentId) ?? new Map<number, { stance: string; confidence: number }>();
      map.set(row.step, { stance: row.stance, confidence: row.confidence });
      byAgent.set(row.agentId, map);
    }

    return Array.from(byAgent.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([agentId, stateMap]) => {
        let last = stateMap.get(0) ?? { stance: "uncertain", confidence: 0 };
        return {
          agentId,
          states: steps.map((step) => {
            const next = stateMap.get(step);
            if (next) {
              last = next;
            }
            return {
              step,
              stance: last.stance,
              confidence: last.confidence,
            };
          }),
        };
      });
  })();

  let testimonyAdoptions: InspectionAdoption[] = [];
  try {
    testimonyAdoptions = queryRows<InspectionAdoption>(
      dbPath,
      `
        SELECT
          step_index AS step,
          agent_id AS agentId,
          claim_id AS claimId,
          stance,
          source_agent_id AS sourceAgentId,
          source_memory_entry_id AS sourceMemoryEntryId,
          previous_stance AS previousStance,
          previous_confidence AS previousConfidence,
          current_confidence AS currentConfidence
        FROM testimony_adoptions
        WHERE run_id = ${runIdSql}
        ORDER BY step_index DESC, adoption_id DESC
        LIMIT 12;
      `,
    ).reverse();
  } catch { /* table may not exist in older DBs */ }

  let claimLineage: InspectionLineage[] = [];
  try {
    claimLineage = queryRows<InspectionLineage>(
      dbPath,
      `
        SELECT
          step_index AS step,
          claim_id AS claimId,
          parent_agent_id AS parentAgentId,
          child_agent_id AS childAgentId,
          parent_memory_entry_id AS parentMemoryEntryId,
          child_memory_entry_id AS childMemoryEntryId,
          relation_type AS relationType
        FROM claim_lineage
        WHERE run_id = ${runIdSql}
        ORDER BY step_index DESC, lineage_id DESC
        LIMIT 12;
      `,
    ).reverse();
  } catch { /* table may not exist in older DBs */ }

  return {
    summary,
    status: finalizedStatus ?? initialStatus ?? "unknown",
    engineMode: metadata.engineMode ?? "unknown",
    focusClaimId,
    scenarioContext: resolveScenarioContext(summary.scenarioId, projectRoot),
    metricTimeline,
    interventions,
    recentEvents,
    recentMemoryEntries,
    finalFocusStates,
    memoryFlow,
    claimMatrix,
    testimonyAdoptions,
    claimLineage,
  };
}

export async function runBatch(
  runConfigPath: string,
  seeds: number[],
  onSeedComplete?: (seed: number, index: number, total: number, summary: RunSummary) => void,
): Promise<BatchResult> {
  const summaries: RunSummary[] = [];

  for (let i = 0; i < seeds.length; i++) {
    const tempPath = createTemporaryRunConfig(runConfigPath, { seed: seeds[i] });
    const summary = await runExperimentAsync(tempPath);
    summaries.push(summary);
    onSeedComplete?.(seeds[i], i, seeds.length, summary);
  }

  const vals = (fn: (s: RunSummary) => number) => summaries.map(fn);
  const majorityTimes = summaries
    .map((s) => s.timeToMajorityAdoption)
    .filter((v): v is number => v !== null);

  const aggregated: BatchResult["aggregated"] = {
    falseClaimEndorsementRate: { mean: mean(vals((s) => s.falseClaimEndorsementRate)), std: std(vals((s) => s.falseClaimEndorsementRate)) },
    peakFalseClaimEndorsementRate: { mean: mean(vals((s) => s.peakFalseClaimEndorsementRate)), std: std(vals((s) => s.peakFalseClaimEndorsementRate)) },
    timeToMajorityAdoption: { mean: majorityTimes.length > 0 ? mean(majorityTimes) : null, count: majorityTimes.length },
    distanceFromGroundTruth: { mean: mean(vals((s) => s.distanceFromGroundTruth)), std: std(vals((s) => s.distanceFromGroundTruth)) },
    recoveryAfterCorrection: { mean: mean(vals((s) => s.recoveryAfterCorrection)), std: std(vals((s) => s.recoveryAfterCorrection)) },
    diversityRetention: { mean: mean(vals((s) => s.diversityRetention)), std: std(vals((s) => s.diversityRetention)) },
  };

  const batchOutputDir = path.resolve(process.cwd(), "comparisons");
  fs.mkdirSync(batchOutputDir, { recursive: true });
  const batchPath = path.join(batchOutputDir, `batch-${summaries[0]?.conditionId ?? "unknown"}-${seeds.length}seeds.json`);
  const result: BatchResult = { seeds, summaries, aggregated, batchPath };
  fs.writeFileSync(batchPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  const { runConfig, scenario, condition } = loadResolvedExperimentFiles(runConfigPath);
  createArchiveRecord({
    projectRoot: process.cwd(),
    kind: "batch",
    title: `${condition.id} batch (${seeds.length} seeds)`,
    question: "How stable is this condition across repeated seeds?",
    note: null,
    command: `batch ${path.relative(process.cwd(), runConfigPath)} ${seeds.join(",")}`,
    tags: ["batch", condition.memory.mode, condition.interaction.mode],
    scenarios: [scenario.id],
    conditions: [condition.id],
    rosters: [],
    models: [...new Set(runConfig.agents.map((agent) => agent.model))].sort(),
    seeds,
    runIds: summaries.map((summary) => summary.runId),
    primaryOutputPath: batchPath,
    extraOutputPaths: summaries.map((summary) => summary.dbPath),
    metrics: {
      falseClaimEndorsementRateMean: aggregated.falseClaimEndorsementRate.mean,
      recoveryAfterCorrectionMean: aggregated.recoveryAfterCorrection.mean,
      diversityRetentionMean: aggregated.diversityRetention.mean,
    },
  });

  return result;
}

// --- Physics analysis of completed runs ---

export function analyzeRunPhysics(target: string, projectRoot = process.cwd()): PhysicsReport {
  const { dbPath, summary } = resolveInspectionPaths(target, projectRoot);
  const runIdSql = sqlString(summary.runId);

  // Load chat messages from the database
  const rawMessages = queryRows<{
    round: number;
    agent_id: string;
    claim_id: string;
    message_text: string;
    stance: string | null;
    confidence: number | null;
    step_index: number;
  }>(
    dbPath,
    `SELECT round, agent_id, claim_id, message_text, stance, confidence, step_index
     FROM chat_messages
     WHERE run_id = ${runIdSql}
     ORDER BY step_index ASC, round ASC, message_id ASC;`,
  );

  if (rawMessages.length === 0) {
    throw new Error(`No chat messages found for run "${summary.runId}". Physics analysis requires chat mode runs.`);
  }

  const messages: ChatMessage[] = rawMessages.map((r) => ({
    round: r.round,
    agentId: r.agent_id,
    claimId: r.claim_id,
    text: r.message_text,
    stance: (r.stance as ChatMessage["stance"]) ?? null,
    confidence: r.confidence,
  }));

  // Load run metadata for agents, scenario, condition
  const metadataRow = queryRows<{ run_metadata_json: string }>(
    dbPath,
    `SELECT run_metadata_json FROM runs WHERE run_id = ${runIdSql} LIMIT 1;`,
  )[0];

  if (!metadataRow) {
    throw new Error(`Could not find run metadata for "${summary.runId}"`);
  }

  const metadata = JSON.parse(metadataRow.run_metadata_json) as {
    topology?: string;
    interactionMode?: string;
  };

  // Load agent states to reconstruct agent specs
  const agentRows = queryRows<{
    agent_id: string;
    stance: string;
    confidence: number;
  }>(
    dbPath,
    `SELECT DISTINCT agent_id, stance, confidence
     FROM agent_claim_states
     WHERE run_id = ${runIdSql} AND step_index = 0
     ORDER BY agent_id ASC;`,
  );

  // Reconstruct minimal agent specs from DB
  const agentIds = [...new Set(agentRows.map((r) => r.agent_id))];
  const agents: AgentSpec[] = agentIds.map((id) => {
    const initialState = agentRows.find((r) => r.agent_id === id);
    const isContam = initialState?.stance === "endorse" && (initialState?.confidence ?? 0) > 0.7;
    return {
      id,
      role: isContam ? "contamination_agent" : "specialist",
      model: "unknown",
      positiveEvidenceWeight: 1,
      negativeEvidenceWeight: 1,
      socialWeight: 0.6,
      falseClaimBias: isContam ? 0.4 : 0,
      correctionTrust: 0.5,
      writesMemoryThreshold: 0.5,
      activeFromStep: 1,
      canWriteMemory: true,
    };
  });

  // Reconstruct minimal scenario
  const claimIds = [...new Set(messages.map((m) => m.claimId))];
  const scenario: Scenario = {
    id: summary.scenarioId,
    title: "",
    scenarioType: "claim_benchmark",
    mechanismTags: [],
    sourceCards: [],
    focusClaimId: claimIds[0] ?? "",
    claims: claimIds.map((id) => ({
      id,
      text: "",
      truthLabel: "false" as const,
    })),
    evidence: [],
    scheduledInterventions: [],
    initialBeliefStates: [],
    initialMemoryEntries: [],
    seedMemoryEntries: [],
  };

  // Reconstruct minimal condition
  const condition: Condition = {
    id: summary.conditionId,
    title: "",
    memory: {
      mode: summary.memoryMode,
      record: "agent_judgment",
      maxRetrievedEntries: 6,
      decay: { enabled: false, halfLife: 6 },
    },
    interaction: {
      mode: "chat",
      chatRounds: 3,
      topology: (metadata.topology ?? "fully-connected") as Condition["interaction"]["topology"],
      chatStyle: "claim-debate",
      collusion: {
        strategy: "none",
        visibility: "hidden",
        omitContraryEvidence: false,
        repeatSupportiveEvidence: false,
      },
    },
    interventions: {
      correctionVisibility: "global",
      verification: { mode: "none", noiseLevel: 0 },
      correctionTiming: "default",
      correctionStrength: "default",
    },
  };

  return analyzeDebate(summary.runId, agents, messages, scenario, condition, { seed: 42 });
}

export function createTemporaryRunConfig(
  runConfigPath: string,
  overrides: QuickRunOverrides,
  tempRoot = os.tmpdir(),
): string {
  const runConfig = loadRunConfig(runConfigPath);
  const scenarioPath = resolveRelativeConfigPath(runConfigPath, runConfig.scenarioPath);
  const conditionPath = resolveRelativeConfigPath(runConfigPath, runConfig.conditionPath);

  const updatedConfig: RunConfig = {
    ...runConfig,
    seed: overrides.seed ?? runConfig.seed,
    maxSteps: overrides.maxSteps ?? runConfig.maxSteps,
    budget: {
      ...runConfig.budget,
      maxModelCalls: overrides.maxModelCalls ?? runConfig.budget.maxModelCalls,
    },
    agents:
      overrides.agents && overrides.agents.length > 0
        ? overrides.agents
        : overrides.agentCount && overrides.agentCount > 0
          ? runConfig.agents.slice(0, Math.min(overrides.agentCount, runConfig.agents.length))
          : runConfig.agents,
    scenarioPath,
    conditionPath,
  };

  const tempDir = fs.mkdtempSync(path.join(tempRoot, "multiagentworld-run-"));
  const tempPath = path.join(tempDir, path.basename(runConfigPath));
  fs.writeFileSync(tempPath, `${JSON.stringify(updatedConfig, null, 2)}\n`, "utf8");
  return tempPath;
}
