/**
 * Record whether each external task item passed no-context, one-piece, and
 * full-context controls for one interaction mode. The resulting registry is
 * required before a private-split group scenario can launch.
 *
 * Usage:
 *   npx tsx scripts/audit-task-screen.ts output/scitat_numeric_memory_screen_v1-grid-results.json
 */

import { buildTaskEligibility } from "../src/tasks/eligibility";

const [resultPath] = process.argv.slice(2);
if (!resultPath) throw new Error("Usage: npx tsx scripts/audit-task-screen.ts <grid-results.json>");
console.log(JSON.stringify(buildTaskEligibility(resultPath, process.cwd()), null, 2));
