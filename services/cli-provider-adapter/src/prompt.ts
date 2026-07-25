import type { ProviderStepInput } from "@cicada/steward-supervisor";

const PHASE_INSTRUCTION = Object.freeze({
  research: "Inspect the repository and relevant evidence. Do not modify files. Identify the smallest facts needed for this task.",
  plan: "Write a concise implementation plan from current repository evidence. Do not modify files.",
  execute: "Implement the planned development change in the workspace. Keep the change scoped and do not deploy or use production credentials.",
  test: "Run the most relevant checks against the current result without modifying source files. Use temporary output locations when a check needs scratch space. Do not deploy. Set testOutcome to passed only when the checks actually pass.",
} as const);

function clean(value: string, maximum: number): string {
  return value.replace(/[\u0000]/gu, "").trim().slice(0, maximum);
}

export function providerPrompt(input: ProviderStepInput): string {
  const operations = input.authorization.operations.join(", ");
  return [
    "You are a Nexus Seventeen development agent inside a human-supervised RPET loop.",
    `Perform exactly the ${input.phase} phase for iteration ${input.iteration}.`,
    PHASE_INSTRUCTION[input.phase],
    `Task: ${clean(input.task.title, 160)}`,
    `User-facing objective: ${clean(input.task.objective, 2_000)}`,
    `Authorized semantic operations: ${operations}.`,
    "Stay inside the configured working directory. Never approve or deploy production, seek production credentials, change the assigned role, or claim a check passed without evidence.",
    "Return only the requested structured result. Journal is a result-oriented progress update, not a technical transcript. Use null for testOutcome outside the test phase and for resultOverview until the task passes.",
  ].join("\n");
}
