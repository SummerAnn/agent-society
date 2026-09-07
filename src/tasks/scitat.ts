import type { Scenario } from "../config/schema";

export type SciTatItem = {
  id: string;
  paragraph: { paragraph_id: string; text: string };
  tables: Array<{
    table_id: string;
    label: string;
    caption: string;
    table: string[][];
  }>;
  question: string;
  question_type: string;
  answer: string;
};

export const SCITAT_ADAPTER_ID = "scitat_numeric_v1";
export const SCITAT_ANALYST_IDS = ["analyst_1", "analyst_2", "analyst_3", "analyst_4"];

type TaskPhase = "no_context" | "one_piece" | "full_context" | "group";

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function isNumericSciTatAnswer(value: string): boolean {
  return /^[+-]?[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?(?:%|x)?$/.test(value.trim());
}

function numericDistractors(answer: string): string[] {
  const trimmed = answer.trim();
  const suffix = trimmed.endsWith("%") ? "%" : trimmed.endsWith("x") ? "x" : "";
  const numeric = Number(trimmed.replace(/[,%x]/g, ""));
  const magnitude = Math.max(Math.abs(numeric) * 0.2, 1);
  const decimals = (trimmed.split(".")[1]?.replace(/[^0-9]/g, "").length ?? 0);
  const render = (value: number): string => `${value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: true,
  })}${suffix}`;
  const values = [numeric + magnitude, numeric - magnitude, numeric * 2 + (numeric === 0 ? 1 : 0)]
    .map(render)
    .filter((value, index, all) => value !== trimmed && all.indexOf(value) === index);
  if (values.length < 3) values.push(render(numeric + magnitude * 2));
  return values.slice(0, 3);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

type AnswerOption = { id: string; text: string; correct: boolean };

// Keep one opaque, deterministic option order for every version of an item.
// The task ID decides the permutation, preventing an option-label or position
// shortcut while preserving the same answer interface across all controls.
function answerOptions(item: SciTatItem, requestedCorrectPosition?: number): AnswerOption[] {
  const values = [item.answer.trim(), ...numericDistractors(item.answer)];
  const wrongOrder = [1, 2, 3];
  let state = stableHash(item.id);
  for (let index = wrongOrder.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    [wrongOrder[index], wrongOrder[swapIndex]] = [wrongOrder[swapIndex], wrongOrder[index]];
  }
  const correctPosition = requestedCorrectPosition ?? (stableHash(item.id) % values.length);
  if (correctPosition < 0 || correctPosition >= values.length) {
    throw new Error(`Invalid SciTaT correct option position: ${correctPosition}`);
  }
  const order = [...wrongOrder];
  order.splice(correctPosition, 0, 0);
  return order.map((valueIndex, optionIndex) => ({
    id: `option_${String.fromCharCode(97 + optionIndex)}`,
    text: values[valueIndex],
    correct: valueIndex === 0,
  }));
}

function renderTable(table: SciTatItem["tables"][number]): string {
  const rows = table.table.map((row) => row.join(" | ")).join("\n");
  return `${table.caption}\n${rows}`;
}

function sourcePieces(item: SciTatItem): Array<{ id: string; title: string; text: string }> {
  return [
    {
      id: "paragraph",
      title: "Paper paragraph",
      text: item.paragraph.text,
    },
    ...item.tables.map((table, index) => ({
      id: `table_${index + 1}`,
      title: `Table ${table.label || index + 1}`,
      text: renderTable(table),
    })),
  ];
}

function createScenario(
  item: SciTatItem,
  phase: TaskPhase,
  pieces: ReturnType<typeof sourcePieces>,
  pieceId?: string,
  requestedCorrectPosition?: number,
): Scenario {
  const taskId = slug(item.id);
  const options = answerOptions(item, requestedCorrectPosition);
  const correctId = options.find((option) => option.correct)!.id;
  const selectedPieces = phase === "no_context"
    ? []
    : phase === "one_piece"
      ? pieces.filter((piece) => piece.id === pieceId)
      : pieces;
  const evidence = selectedPieces.map((piece, index) => ({
    id: piece.id,
    text: piece.text,
    visibleToAgentIds: phase === "group"
      ? [SCITAT_ANALYST_IDS[index % SCITAT_ANALYST_IDS.length]]
      // Controls use the single neutral reference analyst. The group version
      // is the only variant that distributes cards across four analysts.
      : [SCITAT_ANALYST_IDS[0]],
    effects: [{ claimId: correctId, effect: 0 }],
    availableFromStep: 1,
  }));
  const evidenceAccess = phase === "no_context" ? "none" : phase === "group" ? "private_split" : "full_packet";
  const titleSuffix = phase === "one_piece" ? ` (${pieceId})` : ` (${phase.replace("_", " ")})`;

  return {
    id: `scitat_${taskId}_${phase}${pieceId ? `_${pieceId}` : ""}`,
    title: `SciTaT ${item.id}${titleSuffix}`,
    scenarioType: "claim_benchmark",
    domain: "scientific_table_reasoning",
    mechanismFamily: "distributed_information",
    mechanismTags: ["scitat", "external_task", "numeric_answer", phase],
    provenance: {
      kind: "adapted",
      note: "Adapted from the official SciTaT task. The answer options are numeric alternatives generated from the released answer for engine-compatible group-choice scoring.",
    },
    sources: [{ label: "SciTaT", url: "https://github.com/zhxlia/SciTaT" }],
    sourceCards: selectedPieces.map((piece) => ({
      id: piece.id,
      title: piece.title,
      citation: `SciTaT item ${item.id}`,
      summary: piece.text,
      url: "https://github.com/zhxlia/SciTaT",
      notes: [],
    })),
    focusClaimId: correctId,
    groupDecision: {
      candidateClaimIds: options.map((option) => option.id),
      correctClaimId: correctId,
      instruction: `${item.question}\n\nGive the numeric answer supported by the supplied paper material.`,
      requiredSourceIds: phase === "group" ? selectedPieces.map((piece) => piece.id) : [],
      evidenceAccess,
      allowAbstain: phase !== "full_context" && phase !== "group",
    },
    taskProtocol: {
      adapterId: SCITAT_ADAPTER_ID,
      taskId: item.id,
      phase,
      pieceId,
      requiredSourceIds: pieces.map((piece) => piece.id),
    },
    claims: [
      ...options.map((option) => ({
        id: option.id,
        text: `The numeric answer is ${option.text}.`,
        truthLabel: option.correct ? "true" as const : "false" as const,
      })),
    ],
    evidence,
    scheduledInterventions: [],
    initialBeliefStates: [],
    initialMemoryEntries: [],
    seedMemoryEntries: [],
  };
}

export function createSciTatScenarios(item: SciTatItem, requestedCorrectPosition?: number): Scenario[] {
  if (!isNumericSciTatAnswer(item.answer)) {
    throw new Error(`SciTaT item ${item.id} does not have an exact numeric answer.`);
  }
  const pieces = sourcePieces(item);
  if (pieces.length < 2) throw new Error(`SciTaT item ${item.id} has fewer than two source pieces.`);
  return [
    createScenario(item, "no_context", pieces, undefined, requestedCorrectPosition),
    ...pieces.map((piece) => createScenario(item, "one_piece", pieces, piece.id, requestedCorrectPosition)),
    createScenario(item, "full_context", pieces, undefined, requestedCorrectPosition),
    createScenario(item, "group", pieces, undefined, requestedCorrectPosition),
  ];
}
