import fs from "fs";
import path from "path";

const retainedPackets = ["01", "02", "03", "04", "05", "06", "09", "10", "11", "12", "13", "14", "15", "17", "18", "19", "20", "21", "22", "23", "24", "27", "28", "29", "30"];
const root = path.resolve(process.cwd());
const agentIds = Array.from({ length: 12 }, (_, index) => `analyst_${String(index + 1).padStart(2, "0")}`);
const outputDirectory = path.join(root, "scenarios", "bounded-signal-v2-private");
fs.mkdirSync(outputDirectory, { recursive: true });

const scenarios: string[] = [];
for (const packetId of retainedPackets) {
  const sourcePath = path.join(root, "scenarios", "bounded-signal-v2", `bounded_signal_v2_packet_${packetId}_full_packet.yaml`);
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
  const evidence = (source.evidence as Array<Record<string, unknown>>).map((card, index) => ({
    ...card,
    visibleToAgentIds: [agentIds[index]!],
    availableFromStep: 1,
  }));
  const id = `bounded_signal_v2_packet_${packetId}_private_split`;
  const scenario = {
    ...source,
    id,
    title: `Neutral model packet ${packetId} with one private card per analyst`,
    mechanismTags: ["generated_signal", "bounded_record", "private_split", "fixed_arrival_order"],
    groupDecision: {
      ...(source.groupDecision as Record<string, unknown>),
      evidenceAccess: "private_split",
      allowAbstain: false,
    },
    evidence,
  };
  fs.writeFileSync(path.join(outputDirectory, `${id}.yaml`), `${JSON.stringify(scenario, null, 2)}\n`, "utf8");
  scenarios.push(`scenarios/bounded-signal-v2-private/${id}.yaml`);
}

const manifest = {
  id: "bounded_record_content_haiku_v1",
  title: "Bounded shared record: source cards versus source cards plus conclusions",
  benchmarkMeta: {
    status: "pilot",
    locked: false,
    claimId: "bounded_record_content",
    notes: [
      "First paper-facing memory grid. Each of the twenty-five packets passed no-card, one-card, and full-card controls on Haiku and Sonnet.",
      "The only changed variable is record content: source card alone versus the same source card plus the writer's current conclusion.",
    ],
  },
  scenarios,
  conditions: ["conditions/bounded-evidence-fifo.yaml", "conditions/bounded-mixed-fifo.yaml"],
  seeds: [1],
  rosterPaths: ["rosters/bounded-record-12-haiku.json"],
  turnOrder: agentIds,
  maxSteps: 12,
  // 12 agents x 3 candidate judgments, plus 12 final individual votes.
  budget: { maxModelCalls: 48, maxOutputTokensPerCall: 512, temperature: 0 },
};
fs.writeFileSync(path.join(root, "experiments", "bounded-record-content-haiku-v1.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Wrote ${scenarios.length} private-split scenarios and the 50-cell Haiku manifest.`);
