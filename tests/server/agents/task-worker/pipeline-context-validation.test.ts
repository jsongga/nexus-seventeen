import assert from "node:assert/strict";
import test from "node:test";
import { parseBoundedAgentContext } from "#server/agents/task-worker/schema";
import type { BoundedAgentContext } from "#server/agents/task-worker/types";
import { context } from "./helpers.js";

function workflow(overrides: Record<string, unknown> = {}): NonNullable<BoundedAgentContext["workflow"]> {
  return {
    planRevisionId: "plan-pipeline-context",
    nodeId: "node-pipeline-context",
    stage: "implementation",
    skills: [],
    dependencyHandoffs: [],
    ...overrides,
  } as NonNullable<BoundedAgentContext["workflow"]>;
}

test("legacy workflow contexts default absent pipeline fields to null", () => {
  const parsed = parseBoundedAgentContext(context({ workflow: workflow() }));

  assert.equal(parsed.workflow?.workspaceKey, null);
  assert.equal(parsed.workflow?.pipeline, null);
});

test("pipeline workflow contexts validate and preserve their branch-bound plan record", () => {
  const workspaceKey = "work-item-pipeline-context";
  const pipeline = {
    branch: `task/${workspaceKey}`,
    baseSha: "b".repeat(40),
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["src/server"],
    nonGoals: ["Do not push."],
    assumptions: ["The repository remains local."],
  };
  const parsed = parseBoundedAgentContext(context({
    workflow: workflow({ workspaceKey, pipeline }),
  }));

  assert.equal(parsed.workflow?.workspaceKey, workspaceKey);
  assert.deepEqual(parsed.workflow?.pipeline, pipeline);
  assert.throws(
    () => parseBoundedAgentContext(context({
      workflow: workflow({ workspaceKey, pipeline: { ...pipeline, branch: "task/another-item" } }),
    })),
    /pipeline identity is invalid/u,
  );
});
