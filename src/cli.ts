import path from "path";

import fs from "fs";

import {
  analyzeRunPhysics,
  compareRunConfigs,
  inspectArchivedExperiment,
  inspectRun,
  listArchivedExperiments,
  runBatch,
  runFromConfigAsync,
  validateRunConfigFile,
} from "./commands";
import { defineGrid, runGrid } from "./experiments/grid";
import { auditGridResult } from "./experiments/audit";
import { analyzeLateEvidenceGrid } from "./experiments/lateEvidence";
import { generatePaperTables } from "./experiments/table";
import { analyzeSourceDetachmentGrid } from "./experiments/sourceDetachment";
import { buildTaskEligibility } from "./tasks/eligibility";
import { launchInteractiveCli } from "./ui/interactive";

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  node --import tsx src/cli.ts validate <run-config.yaml>",
      "  node --import tsx src/cli.ts run <run-config.yaml>",
      "  node --import tsx src/cli.ts compare <run-config-a.yaml> <run-config-b.yaml>",
      "  node --import tsx src/cli.ts batch <run-config.yaml> <seed1,seed2,...>",
      "  node --import tsx src/cli.ts inspect <run-id|summary.json|trace.db>",
      "  node --import tsx src/cli.ts archive [record-id]",
      "  node --import tsx src/cli.ts analyze <run-id|summary.json|trace.db>",
      "  node --import tsx src/cli.ts experiment <grid-config.json>",
      "  node --import tsx src/cli.ts audit <grid-results.json>",
      "  node --import tsx src/cli.ts late-evidence <grid-results.json>",
      "  node --import tsx src/cli.ts source-detachment <grid-results.json>",
      "  node --import tsx src/cli.ts task-screen <grid-results.json>",
      "  node --import tsx src/cli.ts interactive",
    ].join("\n"),
  );
}

function validate(runConfigPath: string): void {
  console.log(JSON.stringify(validateRunConfigFile(runConfigPath), null, 2));
}

async function run(runConfigPath: string): Promise<void> {
  const summary = await runFromConfigAsync(runConfigPath, { projectRoot: process.cwd() });
  console.log(JSON.stringify(summary, null, 2));
}

async function compare(runConfigPathA: string, runConfigPathB: string): Promise<void> {
  const result = await compareRunConfigs(runConfigPathA, runConfigPathB);
  console.log(JSON.stringify(result, null, 2));
}

function inspect(target: string): void {
  console.log(JSON.stringify(inspectRun(target, process.cwd()), null, 2));
}

function archive(recordId?: string): void {
  if (recordId) {
    console.log(JSON.stringify(inspectArchivedExperiment(recordId, process.cwd()), null, 2));
    return;
  }
  console.log(JSON.stringify(listArchivedExperiments(process.cwd(), 50), null, 2));
}

const [, , command, ...args] = process.argv;

async function main(): Promise<void> {
  if (!command) {
    usage();
  }

  if (command === "validate") {
    if (args.length !== 1) usage();
    validate(path.resolve(args[0]));
  } else if (command === "run") {
    if (args.length !== 1) usage();
    await run(path.resolve(args[0]));
  } else if (command === "compare") {
    if (args.length !== 2) usage();
    await compare(path.resolve(args[0]), path.resolve(args[1]));
  } else if (command === "batch") {
    if (args.length !== 2) usage();
    const seeds = args[1].split(",").map(Number);
    const result = await runBatch(path.resolve(args[0]), seeds, (seed, i, total) => {
      console.log(`Completed seed ${seed} (${i + 1}/${total})`);
    });
    console.log(JSON.stringify(result.aggregated, null, 2));
    console.log(`Batch saved: ${result.batchPath}`);
  } else if (command === "inspect") {
    if (args.length !== 1) usage();
    inspect(args[0]);
  } else if (command === "archive") {
    if (args.length > 1) usage();
    archive(args[0]);
  } else if (command === "analyze") {
    if (args.length !== 1) usage();
    const report = analyzeRunPhysics(args[0], process.cwd());
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "experiment") {
    if (args.length !== 1) usage();
    const gridConfig = JSON.parse(fs.readFileSync(path.resolve(args[0]), "utf8"));
    const grid = defineGrid({ ...gridConfig, projectRoot: process.cwd() });
    const totalCells = grid.scenarios.length * grid.conditions.length * grid.rosters.length * grid.seeds.length;
    console.log(
      `Running experiment grid: ${totalCells} cells `
      + `(${grid.scenarios.length} scenarios x ${grid.conditions.length} conditions x ${grid.rosters.length} rosters x ${grid.seeds.length} seeds)`,
    );
    const result = await runGrid(grid, {
      onProgress: (completed, total, cell) => {
        if (completed < total) {
          console.log(
            `[${completed + 1}/${total}] ${cell.scenarioId} / ${cell.conditionId} / ${cell.rosterId} / seed ${cell.seed}`,
          );
        }
      },
    });
    console.log(generatePaperTables(result, "markdown"));
    console.log(`\nGrid results saved: ${result.outputPath}`);
  } else if (command === "audit") {
    if (args.length !== 1) usage();
    console.log(JSON.stringify(auditGridResult(path.resolve(args[0])), null, 2));
  } else if (command === "late-evidence") {
    if (args.length !== 1) usage();
    console.log(JSON.stringify(analyzeLateEvidenceGrid(path.resolve(args[0])), null, 2));
  } else if (command === "source-detachment") {
    if (args.length !== 1) usage();
    console.log(JSON.stringify(analyzeSourceDetachmentGrid(path.resolve(args[0])), null, 2));
  } else if (command === "task-screen") {
    if (args.length !== 1) usage();
    console.log(JSON.stringify(buildTaskEligibility(path.resolve(args[0]), process.cwd()), null, 2));
  } else if (command === "interactive") {
    if (args.length !== 0) usage();
    await launchInteractiveCli(process.cwd());
  } else {
    usage();
  }
}

void main();
