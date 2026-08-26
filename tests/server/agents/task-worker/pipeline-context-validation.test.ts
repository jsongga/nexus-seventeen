import assert from "node:assert/strict";
import test from "node:test";
import { parseBoundedAgentContext } from "#server/agents/task-worker/schema";
import type { BoundedAgentContext } from "#server/agents/task-worker/types";
import {
  DESIGN_FAILURE_POINTS,
  DESIGN_RECORD_DETAIL_MAX_LENGTH,
  DESIGN_RECORD_MAX_TRANSITIONS,
  type DesignRecordDraft,
} from "#shared/task-board-contract";
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

test("onboarding context is optional and accepts only the true discriminator", () => {
  assert.equal(Object.hasOwn(parseBoundedAgentContext(context()), "onboarding"), false);
  assert.equal(parseBoundedAgentContext(context({ onboarding: true })).onboarding, true);
  assert.throws(
    () => parseBoundedAgentContext({ ...context(), onboarding: false }),
    /context\.onboarding must be true when present/u,
  );
});

test("legacy workflow contexts default absent pipeline fields to null", () => {
  const parsed = parseBoundedAgentContext(context({ workflow: workflow() }));

  assert.equal(parsed.workflow?.workspaceKey, null);
  assert.equal(parsed.workflow?.pipeline, null);
  assert.equal(parsed.workflow?.review, null);
  assert.equal(parsed.workflow?.fix, null);
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
    designRecord: null,
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

test("design claims admit their bounded evidence without widening ordinary context budgets", () => {
  const largeDesignRecord: DesignRecordDraft = {
    states: ["pending", "sent"],
    transitions: Array.from({ length: DESIGN_RECORD_MAX_TRANSITIONS }, () => ({
      from: "pending",
      to: "sent",
      durablePrecondition: "p".repeat(DESIGN_RECORD_DETAIL_MAX_LENGTH),
      recovery: "r".repeat(DESIGN_RECORD_DETAIL_MAX_LENGTH),
    })),
    failurePoints: DESIGN_FAILURE_POINTS.map((point) => ({
      point,
      resultingState: "sent",
      recovery: "Resume with the persisted key.",
    })),
    idempotencyKeys: [{
      name: "send-key",
      generatedAt: "Before the first send.",
      persistedAt: "With the durable intent.",
      reuse: "Reuse verbatim on retry.",
    }],
    faultInjectionCases: [{
      name: "Crash after send",
      scenario: "Terminate after sending and before receiving the response.",
      expectation: "Recovery resolves the remote outcome with the same key.",
    }],
  };
  const workspaceKey = "work-item-large-design-context";
  const hazardous = context({
    workflow: workflow({
      workspaceKey,
      pipeline: {
        branch: `task/${workspaceKey}`,
        baseSha: "a".repeat(40),
        changeShape: "feature",
        tier: "hazardous",
        declaredScope: ["src/server"],
        nonGoals: [],
        assumptions: [],
        designRecord: largeDesignRecord,
      },
    }),
  });
  assert.equal(
    parseBoundedAgentContext(hazardous).workflow?.pipeline?.designRecord?.transitions.length,
    DESIGN_RECORD_MAX_TRANSITIONS,
  );

  const oversizedObjective = "x".repeat(270_000);
  assert.throws(
    () => parseBoundedAgentContext(context({
      task: { ...context().task, objective: oversizedObjective },
    })),
    /Agent context exceeds its byte bound/u,
  );
  assert.equal(parseBoundedAgentContext(context({
    design: true,
    task: { ...context().task, objective: oversizedObjective },
  })).task.objective, oversizedObjective);
});

test("pipeline workflow contexts accept implementation, verify, and review workspace keys bound to one task branch", () => {
  const branch = "task/work-item-pipeline-context";
  const pipeline = {
    branch,
    baseSha: "c".repeat(40),
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["src/server"],
    nonGoals: [],
    assumptions: [],
  };

  for (const workspaceKey of [
    "work-item-pipeline-context",
    "work-item-pipeline-context-verify",
    "work-item-pipeline-context-review",
  ]) {
    const parsed = parseBoundedAgentContext(context({
      workflow: workflow({ workspaceKey, pipeline }),
    }));
    assert.equal(parsed.workflow?.workspaceKey, workspaceKey);
  }
  assert.throws(
    () => parseBoundedAgentContext(context({
      workflow: workflow({ workspaceKey: "unrelated-workspace", pipeline }),
    })),
    /pipeline identity is invalid/u,
  );
});

test("review workflow contexts validate and preserve branch inspection evidence", () => {
  const workspaceKey = "work-item-pipeline-context-review";
  const pipeline = {
    branch: "task/work-item-pipeline-context",
    baseSha: "d".repeat(40),
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["src/server"],
    nonGoals: [],
    assumptions: [],
  } as const;
  const review = {
    commits: [{ sha: "e".repeat(40), subject: "Add independent review" }],
    diffstat: " 1 file changed, 2 insertions(+)\n",
    filesTouched: [{ path: "src/server/review.ts", status: "added" }],
    scopeOk: true,
    midRunAssumptions: ["The branch is local."],
    acceptanceCriteria: ["The reviewer receives branch evidence."],
    criterionChecks: [{ criterion: "The reviewer receives branch evidence.", check: "npm run test:runtime" }],
    mechanicalPortions: ["Regenerate the bounded context fixtures."],
    priorFindings: [],
    priorFindingsTruncated: false,
  } as const;

  const parsed = parseBoundedAgentContext(context({
    workflow: workflow({ stage: "verification", workspaceKey, pipeline, review }),
  }));

  assert.deepEqual(parsed.workflow?.review, review);
  assert.throws(
    () => parseBoundedAgentContext(context({
      workflow: workflow({ stage: "verification", workspaceKey: "work-item-pipeline-context", pipeline, review }),
    })),
    /review identity is invalid/u,
  );
});

test("fix workflow contexts preserve one findings round only during pipeline implementation", () => {
  const workspaceKey = "work-item-pipeline-context";
  const pipeline = {
    branch: `task/${workspaceKey}`,
    baseSha: "f".repeat(40),
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["src/server"],
    nonGoals: [],
    assumptions: [],
  } as const;
  const fix = {
    round: 2,
    findings: [{
      findingId: "finding-pipeline-context",
      nodeId: "node-pipeline-context",
      stage: "verification",
      round: 2,
      file: "src/server/fix.ts",
      line: 12,
      category: "correctness",
      severity: "major",
      expected: "The retry is safe.",
      actual: "The retry duplicates work.",
      blocking: true,
      createdAt: "2026-08-19T12:00:00.000Z",
    }],
  } as const;

  const parsed = parseBoundedAgentContext(context({
    workflow: workflow({ workspaceKey, pipeline, fix }),
  }));
  assert.deepEqual(parsed.workflow?.fix, fix);
  assert.throws(
    () => parseBoundedAgentContext(context({
      workflow: workflow({ stage: "verification", workspaceKey, pipeline, fix }),
    })),
    /fix is only valid during implementation/u,
  );
});
