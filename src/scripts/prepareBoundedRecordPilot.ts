import fs from "fs";
import path from "path";

const root = path.resolve(process.cwd());
const sourcePath = path.join(root, "scenarios", "bounded-signal-v2", "bounded_signal_v2_packet_01_full_packet.yaml");
const scenario = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
const agentIds = Array.from({ length: 12 }, (_, index) => `analyst_${String(index + 1).padStart(2, "0")}`);
const evidence = (scenario.evidence as Array<Record<string, unknown>>).map((card, index) => ({
  ...card,
  visibleToAgentIds: [agentIds[index]!],
  availableFromStep: 1,
}));

const privateScenario = {
  ...scenario,
  id: "bounded_signal_v2_packet_01_private_split",
  title: "Neutral model packet 01 with one private card per analyst",
  mechanismTags: ["generated_signal", "bounded_record", "private_split", "fixed_arrival_order"],
  groupDecision: {
    ...(scenario.groupDecision as Record<string, unknown>),
    evidenceAccess: "private_split",
    allowAbstain: false,
  },
  evidence,
};

const outputPath = path.join(root, "scenarios", "bounded-signal-v2", "bounded_signal_v2_packet_01_private_split.yaml");
fs.writeFileSync(outputPath, `${JSON.stringify(privateScenario, null, 2)}\n`, "utf8");
console.log(`Wrote ${path.relative(root, outputPath)} with ${evidence.length} private cards.`);
