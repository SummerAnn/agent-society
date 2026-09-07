import fs from "fs";
import path from "path";
import yaml from "js-yaml";

import {
  conditionSchema,
  runConfigSchema,
  scenarioSchema,
  type Condition,
  type RunConfig,
  type Scenario,
} from "./schema";

function parseYamlFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  return yaml.load(raw);
}

export function loadScenario(filePath: string): Scenario {
  return scenarioSchema.parse(parseYamlFile(filePath));
}

export function loadCondition(filePath: string): Condition {
  return conditionSchema.parse(parseYamlFile(filePath));
}

export function loadRunConfig(filePath: string): RunConfig {
  return runConfigSchema.parse(parseYamlFile(filePath));
}

export function resolveRelativeConfigPath(baseFilePath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return path.resolve(path.dirname(baseFilePath), relativePath);
}
