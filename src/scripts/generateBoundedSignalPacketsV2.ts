import fs from "fs";
import path from "path";

type Candidate = "a" | "b" | "c";
type Access = "none" | "one_card" | "full_packet";

const candidates: Candidate[] = ["a", "b", "c"];
const nameSets = [
  ["Model Ember", "Model Fjord", "Model Lumen"],
  ["Model Cobalt", "Model Juniper", "Model Saffron"],
  ["Model Atlas", "Model Birch", "Model Cinder"],
  ["Model Delta", "Model Kestrel", "Model Marrow"],
  ["Model Oriole", "Model Quartz", "Model Rowan"],
  ["Model Solace", "Model Tundra", "Model Vela"],
  ["Model Alder", "Model Brim", "Model Coral"],
  ["Model Dune", "Model Flint", "Model Grove"],
  ["Model Halo", "Model Indigo", "Model Lark"],
  ["Model Moss", "Model Nacre", "Model Oriel"],
] as const;

const preliminaryTemplates = [
  "An exploratory reading was compatible with {model}. It did not distinguish the three models.",
  "A first-pass measurement was consistent with {model}. The measurement was not decisive among the three models.",
  "An early screening result fit {model}, but the screening method could not separate the alternatives.",
];

const exclusionTemplates = [
  "A later blinded check is incompatible with {model}. It leaves the other two models unresolved.",
  "An independent follow-up rules out {model}. It does not choose between the two remaining models.",
  "A higher-quality check conflicts with {model}. The two other models remain possible from this check alone.",
];

function rotate<T>(values: readonly T[], amount: number): T[] {
  const offset = amount % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function candidateId(candidate: Candidate): string {
  return `explanation_${candidate}`;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function packet(
  id: string,
  access: Access,
  correct: Candidate,
  earlyWrong: Candidate,
  otherWrong: Candidate,
  names: readonly string[],
  templateOffset: number,
  oneCardTargets: Candidate,
  optionOrder: Candidate[],
): Record<string, unknown> {
  const nameByCandidate = new Map(candidates.map((candidate, index) => [candidate, names[index]! ]));
  const modelName = (candidate: Candidate) => nameByCandidate.get(candidate)!;
  const preliminary = preliminaryTemplates[templateOffset % preliminaryTemplates.length]!;
  const firstExclusion = exclusionTemplates[templateOffset % exclusionTemplates.length]!;
  const secondExclusion = exclusionTemplates[(templateOffset + 1) % exclusionTemplates.length]!;
  const earlyCards = Array.from({ length: 4 }, (_, index) => ({
    id: `${id}_early_${index + 1}`,
    text: preliminary.replace("{model}", modelName(earlyWrong)),
    effects: [{ claimId: candidateId(earlyWrong), effect: 0.2 }],
  }));
  const earlyExclusionCards = Array.from({ length: 4 }, (_, index) => ({
    id: `${id}_rules_out_early_${index + 1}`,
    text: firstExclusion.replace("{model}", modelName(earlyWrong)),
    effects: [{ claimId: candidateId(earlyWrong), effect: -0.85 }],
  }));
  const otherExclusionCards = Array.from({ length: 4 }, (_, index) => ({
    id: `${id}_rules_out_other_${index + 1}`,
    text: secondExclusion.replace("{model}", modelName(otherWrong)),
    effects: [{ claimId: candidateId(otherWrong), effect: -0.85 }],
  }));
  const allCards = [...earlyCards, ...earlyExclusionCards, ...otherExclusionCards];
  const oneCard = oneCardTargets === earlyWrong ? earlyExclusionCards[0]! : otherExclusionCards[0]!;

  return {
    id,
    title: `Neutral model packet ${id}`,
    domain: "generated diagnostic task",
    mechanismFamily: "memory_lock_in",
    mechanismTags: ["generated_signal", "control", "neutral_model_names", "counterbalanced", access],
    provenance: {
      kind: "new",
      note: "Generated before model calls. Candidate names, answer positions, excluded alternatives, and card wording rotate across packets.",
    },
    focusClaimId: candidateId(correct),
    groupDecision: {
      // The final choice prompt must not always put the same answer in the middle.
      candidateClaimIds: optionOrder.map(candidateId),
      correctClaimId: candidateId(correct),
      instruction: "A recorded pattern may be explained by one of three named models. Choose a model only when the supplied checks rule out both alternatives.",
      requiredSourceIds: [`${id}_rules_out_early_1`, `${id}_rules_out_other_1`],
      evidenceAccess: access === "none" ? "none" : "full_packet",
      allowAbstain: true,
    },
    claims: optionOrder.map((candidate) => ({
      id: candidateId(candidate),
      text: `${modelName(candidate)} best explains the recorded pattern.`,
      truthLabel: candidate === correct ? "true" : "false",
    })),
    evidence: access === "none" ? [] : access === "one_card" ? [oneCard] : allCards,
    scheduledInterventions: [],
    initialBeliefStates: [],
    initialMemoryEntries: [],
  };
}

const root = path.resolve(process.cwd());
const directory = path.join(root, "scenarios", "bounded-signal-v2");
fs.mkdirSync(directory, { recursive: true });
const scenarios: string[] = [];

for (let index = 0; index < 30; index += 1) {
  const [correct, earlyWrong, otherWrong] = rotate(candidates, index);
  const names = rotate(nameSets[index % nameSets.length]!, Math.floor(index / candidates.length));
  const oneCardTargets = index % 2 === 0 ? earlyWrong : otherWrong;
  const optionOrder = rotate(candidates, index + Math.floor(index / candidates.length));
  for (const access of ["none", "one_card", "full_packet"] as const) {
    const id = `bounded_signal_v2_packet_${String(index + 1).padStart(2, "0")}_${access}`;
    writeJson(
      path.join(directory, `${id}.yaml`),
      packet(id, access, correct, earlyWrong, otherWrong, names, index, oneCardTargets, optionOrder),
    );
    scenarios.push(`scenarios/bounded-signal-v2/${id}.yaml`);
  }
}

writeJson(path.join(root, "experiments", "bounded-signal-calibration-haiku-v7.json"), {
  id: "bounded_signal_calibration_haiku_v7",
  title: "Bounded-record task calibration: 30 neutral packets with rotated answer order",
  benchmarkMeta: {
    status: "pilot",
    locked: false,
    notes: [
      "Thirty generated packets, each tested with no cards, one non-decisive card, and all twelve cards. Candidate display order rotates across packets.",
      "Run Sonnet only if the Haiku task gates pass.",
    ],
  },
  scenarios,
  conditions: ["conditions/personal-memory-no-correction.yaml"],
  seeds: [1],
  rosterPaths: ["rosters/bounded-record-control-haiku.json"],
  maxSteps: 1,
  budget: { maxModelCalls: 4, maxOutputTokensPerCall: 512, temperature: 0 },
});

console.log(`Wrote ${scenarios.length} scenarios to ${path.relative(root, directory)}.`);
