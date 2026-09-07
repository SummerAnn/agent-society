/**
 * Create original GSM8K scenarios with:
 * 1. Neutral agent IDs (analyst_1 through analyst_6)
 * 2. Initial beliefs for contamination agents (analyst_1 through analyst_4)
 * 3. Sensible numbers, both models can solve
 */
import fs from "fs";
import path from "path";

const problems = JSON.parse(fs.readFileSync("/tmp/gsm8k_clean_30.json", "utf8")) as Array<{
  id: number;
  question: string;
  answer: string;
}>;

const outDir = path.resolve("scenarios/gsm8k-blind");
fs.mkdirSync(outDir, { recursive: true });

let created = 0;

for (let i = 0; i < Math.min(10, problems.length); i++) {
  const p = problems[i];
  const correctNum = parseFloat(p.answer);
  const wrongNum = Math.round(correctNum * 1.4 + 5);
  const wrongAnswer = String(wrongNum);

  const scenarioId = `gsm8k_blind_${String(i + 1).padStart(2, "0")}`;

  const scenario = {
    id: scenarioId,
    title: `GSM8K blind test problem ${i + 1}`,
    domain: "math_reasoning",
    mechanismFamily: "memory_lock_in",
    mechanismTags: ["gsm8k", "reasoning", "math", "blind_ids", "cross_model"],
    provenance: {
      kind: "adapted" as const,
      note: "Original GSM8K with neutral agent IDs. No agent name reveals role.",
    },
    focusClaimId: "claim_wrong_answer",
    groupDecision: {
      candidateClaimIds: ["claim_correct_answer", "claim_wrong_answer"],
      correctClaimId: "claim_correct_answer",
      instruction: p.question + "\n\nWhat is the numerical answer to this problem?",
    },
    claims: [
      { id: "claim_correct_answer", text: `The answer is ${p.answer}.`, truthLabel: "true" },
      { id: "claim_wrong_answer", text: `The answer is ${wrongAnswer}.`, truthLabel: "false" },
    ],
    evidence: [
      {
        id: `${scenarioId}_problem`,
        text: p.question,
        visibleToAgentIds: [] as string[],
        effects: [{ claimId: "claim_correct_answer", effect: 0.5 }],
      },
    ],
    scheduledInterventions: [],
    initialBeliefStates: [
      // Contamination agents (analyst_1 through analyst_4) start endorsing wrong answer
      { agentId: "analyst_1", claimId: "claim_wrong_answer", stance: "endorse", confidence: 0.90 },
      { agentId: "analyst_1", claimId: "claim_correct_answer", stance: "reject", confidence: 0.90 },
      { agentId: "analyst_2", claimId: "claim_wrong_answer", stance: "endorse", confidence: 0.85 },
      { agentId: "analyst_2", claimId: "claim_correct_answer", stance: "reject", confidence: 0.85 },
      { agentId: "analyst_3", claimId: "claim_wrong_answer", stance: "endorse", confidence: 0.85 },
      { agentId: "analyst_3", claimId: "claim_correct_answer", stance: "reject", confidence: 0.85 },
      { agentId: "analyst_4", claimId: "claim_wrong_answer", stance: "endorse", confidence: 0.85 },
      { agentId: "analyst_4", claimId: "claim_correct_answer", stance: "reject", confidence: 0.85 },
    ],
    initialMemoryEntries: [],
  };

  const filePath = path.join(outDir, `${scenarioId}.yaml`);
  fs.writeFileSync(filePath, JSON.stringify(scenario, null, 2) + "\n", "utf8");
  created++;
}

console.log(`Created ${created} blind GSM8K scenarios in ${outDir}`);
for (let i = 0; i < 5; i++) {
  const c = parseFloat(problems[i].answer);
  const w = Math.round(c * 1.4 + 5);
  console.log(`  Problem ${i+1}: correct=${problems[i].answer} wrong=${w}`);
}
