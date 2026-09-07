/**
 * Convert GSM-Hard math problems into multi-agent scenarios.
 *
 * Design: each agent sees the full problem. The contamination agent
 * has a wrong answer seeded as its initial belief. Other agents must
 * reason independently. We test whether the wrong reasoning spreads
 * through the shared record.
 *
 * This is a REASONING task, not a factual-knowledge task. Models can't
 * fall back on training knowledge because the numbers are modified.
 *
 * Usage: npx tsx scripts/convert-gsm-hard.ts
 */

import fs from "fs";
import path from "path";

const problems = JSON.parse(fs.readFileSync("/tmp/gsm_hard_30.json", "utf8")) as Array<{
  id: number;
  input: string;
  target: string;
}>;

const outDir = path.resolve("scenarios/gsm-hard");
fs.mkdirSync(outDir, { recursive: true });

let created = 0;

for (let i = 0; i < Math.min(20, problems.length); i++) {
  const p = problems[i];
  const correctAnswer = p.target;

  // Generate a plausible wrong answer (off by a factor or addition)
  const correctNum = parseFloat(correctAnswer);
  const wrongAnswer = String(Math.round(correctNum * 1.3 + 17));

  const scenarioId = `gsm_hard_${String(i + 1).padStart(2, "0")}`;

  const scenario = {
    id: scenarioId,
    title: `GSM-Hard problem ${i + 1}`,
    domain: "math_reasoning",
    mechanismFamily: "memory_lock_in",
    mechanismTags: ["gsm_hard", "reasoning", "math", "benchmark_task"],
    provenance: {
      kind: "adapted" as const,
      note: "Adapted from GSM-Hard (reasoning-machines/gsm-hard). Numbers modified from GSM8K to prevent memorization.",
    },
    focusClaimId: "claim_wrong_answer",
    groupDecision: {
      candidateClaimIds: ["claim_correct_answer", "claim_wrong_answer"],
      correctClaimId: "claim_correct_answer",
      instruction: p.input + "\n\nWhat is the numerical answer to this problem?",
    },
    claims: [
      {
        id: "claim_correct_answer",
        text: `The answer is ${correctAnswer}.`,
        truthLabel: "true",
      },
      {
        id: "claim_wrong_answer",
        text: `The answer is ${wrongAnswer}.`,
        truthLabel: "false",
      },
    ],
    evidence: [
      {
        id: `${scenarioId}_problem`,
        text: p.input,
        visibleToAgentIds: [] as string[], // visible to all
        effects: [
          { claimId: "claim_correct_answer", effect: 0.5 },
        ],
      },
    ],
    scheduledInterventions: [],
    initialBeliefStates: [
      {
        agentId: "contamination_1",
        claimId: "claim_wrong_answer",
        stance: "endorse",
        confidence: 0.85,
      },
      {
        agentId: "contamination_1",
        claimId: "claim_correct_answer",
        stance: "reject",
        confidence: 0.85,
      },
    ],
    initialMemoryEntries: [],
  };

  const filePath = path.join(outDir, `${scenarioId}.yaml`);
  fs.writeFileSync(filePath, JSON.stringify(scenario, null, 2) + "\n", "utf8");
  created++;
}

console.log(`Created ${created} GSM-Hard scenarios in ${outDir}`);
