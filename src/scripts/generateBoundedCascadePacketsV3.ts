import fs from "fs";
import path from "path";

type Candidate = "a" | "b" | "c";
type Access = "none" | "one_card" | "full_packet" | "private_split";

const candidates: Candidate[] = ["a", "b", "c"];
const nameSets = [
  ["Model Ember", "Model Fjord", "Model Lumen"],
  ["Model Cobalt", "Model Juniper", "Model Saffron"],
  ["Model Atlas", "Model Birch", "Model Cinder"],
  ["Model Delta", "Model Kestrel", "Model Marrow"],
  ["Model Oriole", "Model Quartz", "Model Rowan"],
] as const;

function rotate<T>(items: readonly T[], by: number): T[] {
  const offset = by % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function claimId(candidate: Candidate): string {
  return `explanation_${candidate}`;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// The first four cards weakly favor one wrong model. Two later cards, held by
// different agents, rule out both wrong models. The final six cards add no
// answer information but still consume one record/thread slot when posted.
function buildPacket(id: string, access: Access, index: number): Record<string, unknown> {
  const [correct, earlyWrong, otherWrong] = rotate(candidates, index);
  const names = rotate(nameSets[index % nameSets.length]!, Math.floor(index / 3));
  const name = (candidate: Candidate) => names[candidates.indexOf(candidate)]!;
  const optionOrder = rotate(candidates, index + Math.floor(index / 3));
  const early = Array.from({ length: 4 }, (_, position) => ({
    id: `${id}_early_${position + 1}`,
    text: `A preliminary check made ${name(earlyWrong)} look more plausible, but it did not rule out either alternative.`,
    effects: [{ claimId: claimId(earlyWrong), effect: 0.45 }],
  }));
  const correctCards = [
    {
      id: `${id}_late_rules_out_early`,
      text: `A later blinded check rules out ${name(earlyWrong)}. It does not choose between the other two models.`,
      effects: [{ claimId: claimId(earlyWrong), effect: -0.9 }],
    },
    {
      id: `${id}_late_rules_out_other`,
      text: `A later independent check rules out ${name(otherWrong)}. It does not choose between the other two models.`,
      effects: [{ claimId: claimId(otherWrong), effect: -0.9 }],
    },
  ];
  const filler = Array.from({ length: 6 }, (_, position) => ({
    id: `${id}_post_late_neutral_${position + 1}`,
    text: `A later administrative record confirms the observation was logged, but it does not distinguish the three models.`,
    effects: [],
  }));
  const allCards = [...early, ...correctCards, ...filler];
  const cards = access === "none" ? [] : access === "one_card" ? [correctCards[index % 2]!] : allCards;
  const evidence = cards.map((card, position) => ({
    ...card,
    ...(access === "private_split" ? { visibleToAgentIds: [`analyst_${String(position + 1).padStart(2, "0")}`] } : {}),
    availableFromStep: 1,
  }));
  return {
    id,
    title: `Bounded cascade packet ${String(index + 1).padStart(2, "0")} (${access})`,
    domain: "generated diagnostic task",
    mechanismFamily: "memory_lock_in",
    mechanismTags: ["generated_signal", "bounded_record", "late_evidence", "post_late_turnover", access],
    provenance: { kind: "new", note: "Generated before model calls; model names and correct answer positions rotate." },
    focusClaimId: claimId(correct),
    groupDecision: {
      candidateClaimIds: optionOrder.map(claimId),
      correctClaimId: claimId(correct),
      instruction: "Choose a model only when the available checks rule out both alternatives. A preliminary preference is not enough to choose.",
      requiredSourceIds: correctCards.map((card) => card.id),
      evidenceAccess: access === "none" ? "none" : access === "private_split" ? "private_split" : "full_packet",
      allowAbstain: access !== "private_split",
    },
    claims: optionOrder.map((candidate) => ({ id: claimId(candidate), text: `${name(candidate)} best explains the recorded pattern.`, truthLabel: candidate === correct ? "true" : "false" })),
    evidence,
    scheduledInterventions: [],
    initialBeliefStates: [],
    initialMemoryEntries: [],
  };
}

const root = path.resolve(process.cwd());
const scenarioDir = path.join(root, "scenarios", "bounded-cascade-v3");
fs.mkdirSync(scenarioDir, { recursive: true });
const controlScenarios: string[] = [];
const privateScenarios: string[] = [];

for (let index = 0; index < 30; index += 1) {
  const packet = String(index + 1).padStart(2, "0");
  for (const access of ["none", "one_card", "full_packet", "private_split"] as const) {
    const id = `bounded_cascade_v3_packet_${packet}_${access}`;
    const filePath = path.join(scenarioDir, `${id}.yaml`);
    writeJson(filePath, buildPacket(id, access, index));
    if (access === "private_split") privateScenarios.push(`scenarios/bounded-cascade-v3/${id}.yaml`);
    else controlScenarios.push(`scenarios/bounded-cascade-v3/${id}.yaml`);
  }
}

writeJson(path.join(root, "experiments", "bounded-cascade-v3-controls-haiku.json"), {
  id: "bounded_cascade_v3_controls_haiku",
  title: "Bounded cascade task controls: no card, one card, full packet",
  benchmarkMeta: { status: "pilot", locked: false, notes: ["No-card and one-card controls must abstain; the full packet must choose correctly before group runs."] },
  scenarios: controlScenarios,
  conditions: ["conditions/personal-memory-no-correction.yaml"],
  seeds: [1],
  rosterPaths: ["rosters/bounded-record-control-haiku.json"],
  maxSteps: 1,
  budget: { maxModelCalls: 5, maxOutputTokensPerCall: 256, temperature: 0 },
});
writeJson(path.join(root, "experiments", "bounded-cascade-v3-controls-sonnet.json"), {
  id: "bounded_cascade_v3_controls_sonnet",
  title: "Bounded cascade task controls: matched Sonnet replication",
  benchmarkMeta: { status: "pilot", locked: false, notes: ["Run only task controls in parallel with Haiku. Do not launch a Sonnet group grid until both models pass the packet gates."] },
  scenarios: controlScenarios,
  conditions: ["conditions/personal-memory-no-correction.yaml"],
  seeds: [1],
  rosterPaths: ["rosters/bounded-record-control-sonnet.json"],
  maxSteps: 1,
  budget: { maxModelCalls: 5, maxOutputTokensPerCall: 256, temperature: 0 },
});
writeJson(path.join(root, "scenarios", "bounded-cascade-v3", "private-split-scenarios.json"), privateScenarios);
console.log(`Wrote ${controlScenarios.length} controls and ${privateScenarios.length} private packets.`);
