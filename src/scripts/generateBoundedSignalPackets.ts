import fs from "fs";
import path from "path";

type Candidate = "a" | "b" | "c";

type PacketTheme = {
  title: string;
  result: string;
  artifact: string;
  selection: string;
};

const themes: PacketTheme[] = [
  { title: "biomarker assay", result: "the observed biomarker shift", artifact: "a plate-processing artifact", selection: "a baseline participant-composition difference" },
  { title: "materials test", result: "the observed conductivity change", artifact: "an instrument-calibration artifact", selection: "a difference in starting sample composition" },
  { title: "water-treatment study", result: "the observed reduction in a contaminant", artifact: "a sensor drift artifact", selection: "a change in the incoming-water mix" },
  { title: "crop-trial study", result: "the observed yield difference", artifact: "a measurement-device artifact", selection: "a difference in the starting soil mix" },
  { title: "battery-cycle study", result: "the observed capacity improvement", artifact: "a charge-meter artifact", selection: "a difference in the initial cell batch" },
  { title: "network reliability test", result: "the observed reduction in failures", artifact: "a logging-system artifact", selection: "a difference in starting traffic patterns" },
];

const candidates: Candidate[] = ["a", "b", "c"];

function rotate<T>(values: T[], amount: number): T[] {
  const offset = amount % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function candidateId(candidate: Candidate): string {
  return `explanation_${candidate}`;
}

function scenario(
  id: string,
  title: string,
  theme: PacketTheme,
  correct: Candidate,
  earlyWrong: Candidate,
  otherWrong: Candidate,
  access: "none" | "one_card" | "full_packet" | "private_split",
): Record<string, unknown> {
  const descriptions: Record<Candidate, string> = {
    a: `${theme.artifact} best accounts for ${theme.result}.`,
    b: `The tested intervention best accounts for ${theme.result}.`,
    c: `${theme.selection} best accounts for ${theme.result}.`,
  };
  const claims = candidates.map((candidate) => ({
    id: candidateId(candidate),
    text: descriptions[candidate],
    truthLabel: candidate === correct ? "true" : "false",
  }));

  const evidence = access === "none" ? [] : [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `${id}_early_${index + 1}`,
      text: `An early exploratory check was compatible with ${descriptions[earlyWrong]} The check was small or unblinded and did not rule out the other explanations.`,
      effects: [{ claimId: candidateId(earlyWrong), effect: 0.20 }],
      ...(access === "private_split" ? { visibleToAgentIds: [`analyst_${index + 1}`] } : {}),
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `${id}_rules_out_early_${index + 1}`,
      text: `A later blinded and preregistered check makes ${descriptions[earlyWrong]} unlikely.`,
      effects: [{ claimId: candidateId(earlyWrong), effect: -0.85 }],
      ...(access === "private_split" ? { visibleToAgentIds: [`analyst_${index + 5}`] } : {}),
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `${id}_rules_out_other_${index + 1}`,
      text: `A later independent check makes ${descriptions[otherWrong]} unlikely.`,
      effects: [{ claimId: candidateId(otherWrong), effect: -0.85 }],
      ...(access === "private_split" ? { visibleToAgentIds: [`analyst_${index + 9}`] } : {}),
    })),
  ];

  const controlEvidence = access === "one_card" ? [evidence[8]] : evidence;
  return {
    id,
    title,
    domain: `generated ${theme.title} packet`,
    mechanismFamily: "memory_lock_in",
    mechanismTags: ["generated_signal", "bounded_record", access],
    provenance: { kind: "new", note: "Procedurally generated before model calls; answer and label positions vary by packet." },
    focusClaimId: candidateId(correct),
    groupDecision: {
      candidateClaimIds: candidates.map(candidateId),
      correctClaimId: candidateId(correct),
      instruction: access === "none"
        ? "Choose an explanation only if the supplied material supports it. Do not infer an answer from the labels."
        : "Choose the explanation supported by the supplied material. A card that rules out one explanation does not by itself prove either remaining explanation.",
      requiredSourceIds: [`${id}_rules_out_early_1`, `${id}_rules_out_other_1`],
      evidenceAccess: access === "private_split" ? "private_split" : access === "none" ? "none" : "full_packet",
    },
    claims,
    evidence: controlEvidence,
    scheduledInterventions: [],
    initialBeliefStates: [],
    initialMemoryEntries: [],
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const root = path.resolve(process.cwd());
const scenarioDir = path.join(root, "scenarios", "bounded-signal-v1");
fs.mkdirSync(scenarioDir, { recursive: true });

const calibrationScenarios: string[] = [];
const privateScenarios: string[] = [];
const catalog: string[] = [
  "# Bounded Signal Packet Catalog",
  "",
  "Generated before calibration runs. Each packet has three answers, four early weak signals favoring one wrong answer, and eight later stronger signals that rule out both wrong answers.",
  "",
  "| Packet | Domain | Correct answer | Early weak signal favors | Other wrong answer |",
  "| --- | --- | --- | --- | --- |",
];

for (let index = 0; index < 30; index += 1) {
  const packet = String(index + 1).padStart(2, "0");
  const theme = themes[index % themes.length];
  const answerOrder = rotate(candidates, index);
  const [correct, earlyWrong, otherWrong] = answerOrder;
  const baseId = `bounded_signal_packet_${packet}`;
  const commonTitle = `Generated ${theme.title} packet ${packet}`;

  const noCard = `${baseId}_no_card_v1`;
  const oneCard = `${baseId}_one_card_v1`;
  const fullPacket = `${baseId}_full_packet_v1`;
  const privateSplit = `${baseId}_private_split_v1`;
  writeJson(path.join(scenarioDir, `${noCard}.yaml`), scenario(noCard, `${commonTitle}: no-card control`, theme, correct, earlyWrong, otherWrong, "none"));
  writeJson(path.join(scenarioDir, `${oneCard}.yaml`), scenario(oneCard, `${commonTitle}: one-card control`, theme, correct, earlyWrong, otherWrong, "one_card"));
  writeJson(path.join(scenarioDir, `${fullPacket}.yaml`), scenario(fullPacket, `${commonTitle}: full-packet control`, theme, correct, earlyWrong, otherWrong, "full_packet"));
  writeJson(path.join(scenarioDir, `${privateSplit}.yaml`), scenario(privateSplit, `${commonTitle}: private split`, theme, correct, earlyWrong, otherWrong, "private_split"));
  calibrationScenarios.push(
    `scenarios/bounded-signal-v1/${noCard}.yaml`,
    `scenarios/bounded-signal-v1/${oneCard}.yaml`,
    `scenarios/bounded-signal-v1/${fullPacket}.yaml`,
  );
  privateScenarios.push(`scenarios/bounded-signal-v1/${privateSplit}.yaml`);
  catalog.push(`| ${packet} | ${theme.title} | ${correct.toUpperCase()} | ${earlyWrong.toUpperCase()} | ${otherWrong.toUpperCase()} |`);
}

writeJson(path.join(root, "experiments", "bounded-signal-calibration-haiku-v3.json"), {
  id: "bounded_signal_calibration_haiku_v3",
  title: "Bounded-record packet controls: 30 generated packets",
  benchmarkMeta: {
    status: "pilot",
    locked: true,
    notes: [
      "Pre-registered calibration gate for generated signal packets.",
      "Do not launch the 12-agent record comparison until packet-level controls are reviewed.",
    ],
  },
  scenarios: calibrationScenarios,
  conditions: ["conditions/personal-memory-no-correction.yaml"],
  seeds: [1],
  rosterPaths: ["rosters/bounded-record-control-haiku.json"],
  maxSteps: 1,
  budget: { maxModelCalls: 4, maxOutputTokensPerCall: 256, temperature: 0 },
});
fs.writeFileSync(path.join(root, "paper", "BOUNDED_SIGNAL_PACKET_CATALOG.md"), `${catalog.join("\n")}\n`, "utf8");
fs.writeFileSync(path.join(root, "scenarios", "bounded-signal-v1", "private-split-scenarios.json"), `${JSON.stringify(privateScenarios, null, 2)}\n`, "utf8");
