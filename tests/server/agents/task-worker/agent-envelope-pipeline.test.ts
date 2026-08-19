import assert from "node:assert/strict";
import test from "node:test";
import { agentPrompt } from "#server/agents/task-worker/agent-envelope";
import { context } from "./helpers.js";

const PIPELINE_BLOCK = "Pipeline task on branch task/work-item-one. Declared scope (only these path prefixes): src/server, tests/server. Non-goals: do not change the schema, do not add dependencies. Loop: write a failing test where a criterion allows, implement, run `npm run verify:fast`, read the failure, fix; repeat until green. Run `npm run verify:area` once before finishing. Commit in staged logical units (schema, core, wiring, tests) — never one blob. Reversible mid-run decisions: append to assumptions in your handoff evidence. STOP and return failed with detail starting `BRIGHT_LINE:` if you would need to: touch a file outside declared scope, change a schema or migration unplanned, add a dependency, change a published interface, violate a non-goal, find the plan infeasible, or delete/skip an existing test.";

function pipelineWorkflow(stage: "implementation" | "testing") {
  return {
    planRevisionId: "plan-one",
    nodeId: "node-one",
    stage,
    skills: [],
    dependencyHandoffs: [],
    workspaceKey: "work-item-one",
    pipeline: {
      branch: "task/work-item-one",
      baseSha: "a".repeat(40),
      changeShape: "feature" as const,
      tier: "standard" as const,
      declaredScope: ["src/server", "tests/server"],
      nonGoals: ["do not change the schema", "do not add dependencies"],
      assumptions: ["The focused tests describe the intended behavior."],
    },
  } as const;
}

test("pipeline implementation engineer prompt appends the declared-scope bright-line block verbatim", () => {
  const prompt = agentPrompt({
    runId: "run-pipeline-implementation",
    wakeReason: "human_assignment",
    context: context({ workflow: pipelineWorkflow("implementation") }),
  });

  assert.ok(prompt.includes(PIPELINE_BLOCK));
  assert.equal(prompt.split(PIPELINE_BLOCK).length, 2);
});

test("pipeline block is absent outside the engineer implementation stage", () => {
  const cases = [
    context({ workflow: null }),
    context({ workflow: pipelineWorkflow("testing") }),
    context({
      mission: { role: "manager", area: "Release oversight", mission: "Review evidence and risks." },
      workflow: pipelineWorkflow("implementation"),
    }),
  ];

  for (const boundedContext of cases) {
    const prompt = agentPrompt({
      runId: `run-without-pipeline-block-${boundedContext.mission.role}-${boundedContext.workflow?.stage ?? "none"}`,
      wakeReason: "human_assignment",
      context: boundedContext,
    });
    assert.doesNotMatch(prompt, /Pipeline task on branch/u);
    assert.doesNotMatch(prompt, /BRIGHT_LINE:/u);
  }
});
