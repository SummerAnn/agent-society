import type { AgentSpec, EvidenceSpec, Scenario } from "../config/schema";

export function isAgentActiveAtStep(agent: AgentSpec, step: number): boolean {
  if (step < agent.activeFromStep) return false;
  if (typeof agent.activeUntilStep === "number" && step > agent.activeUntilStep) return false;
  return true;
}

export function visibleEvidenceForAgent(
  scenario: Scenario,
  agentId: string,
  claimId?: string,
  currentStep = 1,
): EvidenceSpec[] {
  return scenario.evidence.filter((evidence) => {
    if (currentStep < evidence.availableFromStep) return false;
    const visible = !evidence.visibleToAgentIds || evidence.visibleToAgentIds.includes(agentId);
    const relevant = !claimId || evidence.effects.some((effect) => effect.claimId === claimId);
    return visible && relevant;
  });
}
