/**
 * Create SciTaT control and private-split scenarios from the official dataset.
 *
 * Usage:
 *   npx tsx scripts/convert-scitat.ts /path/to/scitat_dev.json scenarios/scitat-numeric 30
 */

import fs from "fs";
import path from "path";

import { createSciTatScenarios, isNumericSciTatAnswer, type SciTatItem } from "../src/tasks/scitat";

const [inputPath, outputDir = "scenarios/scitat-numeric", requestedLimit = "30"] = process.argv.slice(2);
if (!inputPath) throw new Error("Usage: npx tsx scripts/convert-scitat.ts <scitat-json> [output-dir] [limit]");

const source = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8")) as SciTatItem[];
const limit = Number(requestedLimit);
const candidates = source.filter((item) => isNumericSciTatAnswer(item.answer) && item.tables.length >= 1);
const selected = candidates.slice(0, limit);
if (selected.length < limit) throw new Error(`Only ${selected.length} numeric SciTaT items with tables are available.`);

fs.mkdirSync(path.resolve(outputDir), { recursive: true });
let created = 0;
for (const [itemIndex, item] of selected.entries()) {
  // Balance the correct option across A-D over this screened batch. Every
  // variant of one item keeps the same mapping.
  for (const scenario of createSciTatScenarios(item, itemIndex % 4)) {
    const outputPath = path.join(path.resolve(outputDir), `${scenario.id}.yaml`);
    fs.writeFileSync(outputPath, JSON.stringify(scenario, null, 2) + "\n", "utf8");
    created += 1;
  }
}
console.log(`Created ${created} SciTaT scenarios for ${selected.length} numeric items in ${path.resolve(outputDir)}.`);
