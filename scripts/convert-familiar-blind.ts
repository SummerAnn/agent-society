/**
 * Create blind versions of familiar science scenarios.
 * Same claims and evidence, but agent IDs are analyst_1 through analyst_6.
 */
import fs from "fs";
import path from "path";

const scenarios = [
  "scenarios/distributed-ego-depletion-v1.yaml",
  "scenarios/distributed-wakefield-mmr-autism-v1.yaml",
];

const outDir = path.resolve("scenarios/familiar-blind");
fs.mkdirSync(outDir, { recursive: true });

// Map old IDs to new IDs
const idMap: Record<string, string> = {
  contamination_1: "analyst_1",
  specialist_1: "analyst_5",
  specialist_2: "analyst_5", // collapse to analyst_5 if only 6 agents
  regular_1: "analyst_6",
  regular_2: "analyst_6",
  observer_1: "analyst_6",
};

for (const scenarioPath of scenarios) {
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));

  // Create blind version
  const blindId = scenario.id.replace("distributed_", "blind_");
  const blind = {
    ...scenario,
    id: blindId,
    title: scenario.title + " (blind IDs)",
    mechanismTags: [...(scenario.mechanismTags || []), "blind_ids"],
  };

  // Remap agent IDs in initialBeliefStates
  blind.initialBeliefStates = [
    // 4 contamination agents endorse the false claim
    { agentId: "analyst_1", claimId: scenario.focusClaimId, stance: "endorse", confidence: 0.90 },
    { agentId: "analyst_2", claimId: scenario.focusClaimId, stance: "endorse", confidence: 0.85 },
    { agentId: "analyst_3", claimId: scenario.focusClaimId, stance: "endorse", confidence: 0.85 },
    { agentId: "analyst_4", claimId: scenario.focusClaimId, stance: "endorse", confidence: 0.85 },
  ];

  // Remap evidence visibility - make all evidence visible to all (simpler)
  blind.evidence = scenario.evidence.map((ev: any) => ({
    ...ev,
    visibleToAgentIds: [], // visible to all
  }));

  // Clear initial memory entries (they reference old IDs)
  blind.initialMemoryEntries = [];

  const outPath = path.join(outDir, `${blindId}.yaml`);
  fs.writeFileSync(outPath, JSON.stringify(blind, null, 2) + "\n", "utf8");
  console.log(`Created ${outPath}`);
}
