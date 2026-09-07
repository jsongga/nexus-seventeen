/** Names the automation stages, roles and evaluator profiles the board shows. */

/* —— Imports —— */

import { type AgentRole, type AutomationEvaluatorProfile, type WorkItemStage } from "../../types";

/* —— Automation vocabulary —— */

export const stageLabels: Record<WorkItemStage, string> = {
  refinement: "Refinement",
  project_resolution: "Project resolution",
  research: "Research",
  planning: "Planning",
  implementation: "Implementation",
  testing: "Testing",
  verification: "Verification",
  human_review: "Human review",
  deployment: "Deployment",
};

export const stageDescriptions: Record<WorkItemStage, string> = {
  refinement: "Clarifies the original request without replacing it.",
  project_resolution: "Selects an existing project or identifies that one must be created.",
  research: "Collects project context and evidence before a plan is written.",
  planning: "Turns the refined objective and research into an executable plan.",
  implementation: "Changes the assigned workspace; only an engineer type is eligible.",
  testing: "Exercises the implementation and records failures or evidence.",
  verification: "Independently checks the result; only a verifier type is eligible.",
  human_review: "Waits for a human decision before any release action.",
  deployment: "Remains disabled until a separate, human-controlled release path exists.",
};

export const evaluatorLabels: Record<AutomationEvaluatorProfile, string> = {
  tests: "Tests",
  editorial: "Editorial",
  visual: "Visual",
  manual: "Manual",
};

export const roleLabels: Record<AgentRole, string> = {
  engineer: "Engineer",
  manager: "Manager",
  verifier: "Verifier",
};

export function authorityForRole(role: AgentRole): { label: string; detail: string } {
  if (role === "engineer") {
    return {
      label: "Workspace-write",
      detail: "May modify files in the workspace assigned to a task.",
    };
  }
  return {
    label: "Read-only",
    detail:
      role === "manager"
        ? "May inspect work and coordinate decisions, but cannot modify the workspace."
        : "May inspect work and verification evidence, but cannot modify the workspace.",
  };
}
