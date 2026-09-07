import fs from "fs";
import path from "path";

type Candidate = "a" | "b" | "c";

const candidates: Candidate[] = ["a", "b", "c"];
const modelNames = ["Model Ember", "Model Fjord", "Model Lumen"];

function rotate<T>(values: T[], amount: number): T[] {
  const offset = amount % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function candidateId(candidate: Candidate): string {
  return `explanation_${candidate}`;
}

function packet(
  id: string,
  access: "none" | "one_card" | "full_packet",
  correct: Candidate,
  earlyWrong: Candidate,
  otherWrong: Candidate,
  names: string[],
): Record<string, unknown> {
  const nameByCandidate = new Map(candidates.map((candidate, index) => [candidate, names[index]! ]));
  const modelName = (candidate: Candidate) => nameByCandidate.get(candidate)!;
  const evidence = access === "none" ? [] : [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `${id}_early_${index + 1}`,
      text: `A preliminary reading was compatible with ${modelName(earlyWrong)}. The reading was exploratory and did not distinguish the three models.`,
      effects: [{ claimId: candidateId(earlyWrong), effect: 0.20 }],
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `${id}_rules_out_early_${index + 1}`,
      text: `A later blinded check is incompatible with ${modelName(earlyWrong)}. It does not by itself distinguish the two remaining models.`,
      effects: [{ claimId: candidateId(earlyWrong), effect: -0.85 }],
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `${id}_rules_out_other_${index + 1}`,
      text: `A later independent check is incompatible with ${modelName(otherWrong)}. It does not by itself distinguish the two remaining models.`,
      effects: [{ claimId: candidateId(otherWrong), effect: -0.85 }],
    })),
  ];

  return {
    id,
    title: `Neutral model packet ${id}`,
    domain: "generated diagnostic task",
    mechanismFamily: "memory_lock_in",
    mechanismTags: ["generated_signal", "control", "neutral_model_names", access],
    provenance: { kind: "new", note: "Three neutral model names are shuffled across answer positions. The task is generated before model calls." },
    focusClaimId: candidateId(correct),
    groupDecision: {
      candidateClaimIds: candidates.map(candidateId),
      correctClaimId: candidateId(correct),
      instruction: "A recorded pattern may be explained by one of three named models. Choose a model only when the supplied checks rule out both alternatives.",
      requiredSourceIds: [`${id}_rules_out_early_1`, `${id}_rules_out_other_1`],
      evidenceAccess: access === "none" ? "none" : "full_packet",
      allowAbstain: true,
    },
    claims: candidates.map((candidate) => ({
      id: candidateId(candidate),
      text: `${modelName(candidate)} best explains the recorded pattern.`,
      truthLabel: candidate === correct ? "true" : "false",
    })),
    evidence: access === "one_card" ? [evidence[8]] : evidence,
    scheduledInterventions: [],
    initialBeliefStates: [],
    initialMemoryEntries: [],
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const root = path.resolve(process.cwd());
const dir = path.join(root, "scenarios", "bounded-signal-v2-pilot");
fs.mkdirSync(dir, { recursive: true });
const scenarios: string[] = [];

for (let index = 0; index < 3; index += 1) {
  const [correct, earlyWrong, otherWrong] = rotate(candidates, index);
  const names = rotate(modelNames, index + 1);
  for (const access of ["none", "one_card", "full_packet"] as const) {
    const id = `bounded_signal_v2_packet_${index + 1}_${access}`;
    writeJson(path.join(dir, `${id}.yaml`), packet(id, access, correct, earlyWrong, otherWrong, names));
    scenarios.push(`scenarios/bounded-signal-v2-pilot/${id}.yaml`);
  }
}

writeJson(path.join(root, "experiments", "bounded-signal-calibration-haiku-v4.json"), {
  id: "bounded_signal_calibration_haiku_v4",
  title: "Bounded-record task calibration: neutral model names",
  benchmarkMeta: {
    status: "pilot",
    locked: false,
    notes: ["Small task-repair check. Run the 30-packet version only if no-card and one-card controls abstain while full-packet controls choose correctly."],
  },
  scenarios,
  conditions: ["conditions/personal-memory-no-correction.yaml"],
  seeds: [1],
  rosterPaths: ["rosters/bounded-record-control-haiku.json"],
  maxSteps: 1,
  budget: { maxModelCalls: 4, maxOutputTokensPerCall: 256, temperature: 0 },
});
