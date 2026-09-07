import type { Condition, RunConfig, Scenario, StanceLabel, StepMetrics } from "../config/schema";
import type { OnChatMessage } from "./chat";

export type RunProgressSnapshot = {
  runId: string;
  step: number;
  maxSteps: number;
  modelCalls: number;
  maxModelCalls: number;
  agentId: string;
  focusClaimId: string;
  focusClaimStance: StanceLabel;
  retrievedMemoryCount: number;
  wroteMemory: boolean;
  interventionFired: boolean;
  metrics: StepMetrics;
  agentStates: { agentId: string; role: string; stance: StanceLabel; confidence: number }[];
  memoryPoolSize: number;
};

export type RunExperimentOptions = {
  outputRootOverride?: string;
  projectRoot?: string;
  onStep?: (snapshot: RunProgressSnapshot) => void;
  onChatMessage?: OnChatMessage;
};

export type LoadedRun = {
  runConfigPath: string;
  runConfig: RunConfig;
  scenario: Scenario;
  condition: Condition;
};
