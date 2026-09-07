import fs from "fs";
import path from "path";

const root = path.resolve(process.cwd());
const haikuRosterPath = path.join(root, "rosters", "bounded-record-12-haiku.json");
const haikuManifestPath = path.join(root, "experiments", "bounded-record-content-haiku-v1.json");
const haikuRoster = JSON.parse(fs.readFileSync(haikuRosterPath, "utf8")) as {
  id: string;
  title: string;
  agents: Array<Record<string, unknown>>;
};
const haikuManifest = JSON.parse(fs.readFileSync(haikuManifestPath, "utf8")) as Record<string, unknown>;

const roster = {
  ...haikuRoster,
  id: "bounded-record-12-sonnet",
  title: "Twelve neutral analysts with private cards (Sonnet)",
  agents: haikuRoster.agents.map((agent) => ({ ...agent, model: "claude-sonnet-4-6" })),
};
const manifest = {
  ...haikuManifest,
  id: "bounded_record_content_sonnet_v1",
  title: "Bounded shared record: source cards versus source cards plus conclusions (Sonnet)",
  rosterPaths: ["rosters/bounded-record-12-sonnet.json"],
  benchmarkMeta: {
    ...(haikuManifest.benchmarkMeta as Record<string, unknown>),
    notes: [
      "Matched Sonnet replication of bounded_record_content_haiku_v1.",
      "The task packets, agent count, private-card allocation, record capacity, retrieval window, order, and call cap are unchanged.",
    ],
  },
};

fs.writeFileSync(path.join(root, "rosters", "bounded-record-12-sonnet.json"), `${JSON.stringify(roster, null, 2)}\n`, "utf8");
fs.writeFileSync(path.join(root, "experiments", "bounded-record-content-sonnet-v1.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log("Wrote matched Sonnet roster and 50-cell manifest.");
