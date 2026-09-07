import type { Condition, MemoryEntry, Scenario, StanceLabel } from "../config/schema";

function stanceToNumeric(stance: StanceLabel): number {
  if (stance === "endorse") return 1;
  if (stance === "reject") return -1;
  return 0;
}

export function retrieveMemoryEntries(
  memoryEntries: MemoryEntry[],
  agentId: string,
  claimId: string,
  condition: Pick<Condition, "memory">,
  currentStep?: number,
): MemoryEntry[] {
  const filtered = memoryEntries.filter((entry) => {
    if (entry.claimId !== claimId) return false;
    if (condition.memory.mode === "shared") return true;
    return entry.agentId === agentId;
  });
  let selected: MemoryEntry[];
  if (condition.memory.mode === "shared" && (condition.memory.record === "source_aware" || condition.memory.record === "independence_aware")) {
    // Reserve half of the window for source material and retain only each
    // agent's newest assessment, so repeated opinions cannot crowd it out.
    const sourceSlots = Math.ceil(condition.memory.maxRetrievedEntries / 2);
    const sources = filtered.filter((entry) => entry.sourceType === "evidence").slice(-sourceSlots);
    const latestByAgent = new Map<string, MemoryEntry>();
    for (const entry of [...filtered].reverse()) {
      if (entry.sourceType === "evidence" || latestByAgent.has(entry.agentId)) continue;
      latestByAgent.set(entry.agentId, entry);
    }
    const judgments = Array.from(latestByAgent.values())
      .slice(0, condition.memory.maxRetrievedEntries - sources.length)
      .reverse();
    selected = [...sources, ...judgments];
  } else {
    selected = filtered.slice(-condition.memory.maxRetrievedEntries);
  }
  if (!condition.memory.decay.enabled || currentStep === undefined) {
    return selected;
  }

  // The LLM cannot apply a numeric decay rule by itself. Give it the retained
  // confidence for each note so the decay condition changes its actual input.
  return selected.map((entry) => {
    const age = Math.max(0, currentStep - entry.step);
    const retention = Math.pow(0.5, age / condition.memory.decay.halfLife);
    return {
      ...entry,
      confidence: entry.confidence * retention,
      text: `${entry.text} [recorded ${age} turn${age === 1 ? "" : "s"} ago; retained confidence ${retention.toFixed(2)}]`,
    };
  });
}

export function weightedMemorySignal(
  retrievedMemory: MemoryEntry[],
  condition: Pick<Condition, "memory">,
  scenario: Pick<Scenario, "focusClaimId">,
  claimId: string,
  currentStep: number,
): number {
  if (retrievedMemory.length === 0) {
    return 0;
  }

  const decay = condition.memory.decay;
  let totalWeight = 0;
  let totalSignal = 0;

  for (const entry of retrievedMemory) {
    const stanceValue = stanceToNumeric(entry.stance);
    const confidence = entry.confidence;
    const signal = stanceValue * confidence;

    let weight = 1;
    if (decay.enabled) {
      const age = currentStep - entry.step;
      weight = Math.pow(0.5, age / decay.halfLife);
    }

    totalSignal += signal * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? totalSignal / totalWeight : 0;
}
