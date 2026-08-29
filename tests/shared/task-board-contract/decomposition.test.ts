import assert from "node:assert/strict";
import test from "node:test";
import {
  TASK_BOARD_API_VERSION,
  declaredScopesOverlap,
  type WorkItemDependency,
} from "#shared/task-board-contract";
import {
  ContractValidationError,
  parseBoardCreateProject,
  parseBoardSettle,
  parseProjectEntity,
  parseWorkItemEntity,
  validateWorkflowPlanChildren,
} from "#shared/task-board-contract/validate";

const NOW = "2026-08-28T12:00:00.000Z";

function child(key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    objective: `Implement ${key}.`,
    projectId: "provider-project",
    declaredScope: [`src/${key}`],
    acceptanceCriteria: [`${key} is verified.`],
    ...overrides,
  };
}

function plan(changeShape: string, children?: readonly unknown[]): Record<string, unknown> {
  return {
    objective: "Coordinate an independently mergeable change.",
    assumptions: [],
    acceptanceCriteria: ["Every declared child is verified."],
    changeShape,
    tier: "standard",
    declaredScope: ["src"],
    nonGoals: [],
    mechanicalPortions: [],
    blockingQuestions: [],
    criterionChecks: [],
    nodes: [{
      nodeId: "node-one",
      title: "Coordinate the change",
      objective: "Produce the approved implementation.",
      acceptanceCriteria: ["The implementation is verified."],
      dependencyNodeIds: [],
      stageTemplate: ["implementation", "testing", "verification"],
    }],
    ...(children === undefined ? {} : { children }),
  };
}

function parse(changeShape: string, children?: readonly unknown[]) {
  return parseBoardSettle({
    outcome: "completed",
    result: "Planning completed.",
    workflowPlan: plan(changeShape, children),
  }).workflowPlan;
}

function parseWithoutChangeShape(children: readonly unknown[]) {
  const { changeShape: _changeShape, ...draft } = plan("feature", children);
  return parseBoardSettle({
    outcome: "completed",
    result: "Planning completed.",
    workflowPlan: draft,
  }).workflowPlan;
}

function phasedChildren(overrides: Partial<Record<"expand" | "migrateOne" | "migrateTwo" | "contract", Record<string, unknown>>> = {}) {
  return [
    child("expand", {
      declaredScope: ["src/expand", "docs/interface.md"],
      phase: "expand",
      splitBy: "phase",
      ...overrides.expand,
    }),
    child("migrate-one", {
      projectId: "consumer-one",
      declaredScope: ["src/consumer-one"],
      phase: "migrate",
      dependsOn: ["expand"],
      splitBy: "consumer",
      ...overrides.migrateOne,
    }),
    child("migrate-two", {
      projectId: "consumer-two",
      declaredScope: ["src/consumer-two"],
      phase: "migrate",
      dependsOn: ["expand"],
      splitBy: "consumer",
      ...overrides.migrateTwo,
    }),
    child("contract", {
      declaredScope: ["src/contract", "docs/interface.md"],
      phase: "contract",
      dependsOn: ["migrate-one", "migrate-two"],
      splitBy: "phase",
      ...overrides.contract,
    }),
  ];
}

test("split-rule matrix accepts mechanical, optional feature, and declared blast-radius shapes", () => {
  assert.equal(parse("mechanical_sweep")?.children, undefined);
  assert.equal(parse("feature")?.children, undefined);
  assert.equal(parse("feature", [child("one"), child("two", {
    declaredScope: ["tests/two"],
    dependsOn: ["one"],
  })])?.children?.length, 2);
  assert.equal(parse("blast_radius", [
    child("provider", { splitBy: "phase" }),
    child("consumer", {
      projectId: "consumer-project",
      declaredScope: ["src/consumer"],
      splitBy: "consumer",
    }),
  ])?.children?.length, 2);
  assert.deepEqual(parse("blast_radius", phasedChildren())?.children, phasedChildren());
});

test("mechanical sweeps reject children and blast-radius plans require split declarations", () => {
  assert.throws(() => parse("mechanical_sweep", [child("one")]), ContractValidationError);
  assert.throws(() => parse("blast_radius"), ContractValidationError);
  assert.throws(() => parse("blast_radius", []), ContractValidationError);
  assert.throws(() => parse("blast_radius", [child("one")]), ContractValidationError);
});

test("phased declarations require exactly one expand, migrates, and exactly one contract", () => {
  assert.throws(() => parse("blast_radius", phasedChildren({ expand: { phase: "migrate", projectId: "consumer-three" } })), ContractValidationError);
  assert.throws(() => parse("blast_radius", phasedChildren({ migrateOne: { phase: "expand", projectId: "provider-project" } })), ContractValidationError);
  assert.throws(() => parse("blast_radius", phasedChildren({
    migrateOne: { phase: "contract", projectId: "provider-project" },
    migrateTwo: { phase: "contract", projectId: "provider-project" },
  })), ContractValidationError);
  assert.throws(() => parse("blast_radius", [
    phasedChildren()[0],
    phasedChildren()[3],
  ]), ContractValidationError);
});

test("phase declarations are total and feature splits are unphased", () => {
  assert.throws(() => parse("blast_radius", phasedChildren({ migrateOne: { phase: undefined } })), ContractValidationError);
  assert.throws(() => parse("feature", phasedChildren()), ContractValidationError);
});

test("phased declarations pin direct expand and migrate dependency edges", () => {
  assert.throws(() => parse("blast_radius", phasedChildren({ migrateOne: { dependsOn: [] } })), ContractValidationError);
  assert.throws(() => parse("blast_radius", phasedChildren({ contract: { dependsOn: ["migrate-one"] } })), ContractValidationError);
});

test("phased projects keep expand and contract in the parent repo and migrates outside it", () => {
  const parsed = parse("blast_radius", phasedChildren());
  assert.ok(parsed);
  assert.doesNotThrow(() => validateWorkflowPlanChildren(parsed, "provider-project"));
  assert.throws(() => validateWorkflowPlanChildren(parsed, "different-parent"), ContractValidationError);
  assert.throws(() => parse("blast_radius", phasedChildren({ contract: { projectId: "consumer-three" } })), ContractValidationError);
  assert.throws(() => parse("blast_radius", phasedChildren({ migrateOne: { projectId: "provider-project" } })), ContractValidationError);
});

test("child dependency keys are unique, resolvable, acyclic, and duplicate-free", () => {
  assert.throws(() => parse("feature", [child("same"), child("same", { declaredScope: ["tests/same"] })]), ContractValidationError);
  assert.throws(() => parse("feature", [child("one", { dependsOn: ["missing"] })]), ContractValidationError);
  assert.throws(() => parse("feature", [child("one"), child("two", { dependsOn: ["one", "one"] })]), ContractValidationError);
  assert.throws(() => parse("feature", [
    child("one", { dependsOn: ["two"] }),
    child("two", { declaredScope: ["tests/two"], dependsOn: ["one"] }),
  ]), ContractValidationError);
});

test("child scopes are pairwise disjoint within a project but may repeat across projects", () => {
  assert.equal(declaredScopesOverlap(["src/app"], ["src/app/routes"]), true);
  assert.equal(declaredScopesOverlap(["src/app"], ["tests/app"]), false);
  assert.throws(() => parse("feature", [
    child("one", { declaredScope: ["src/app"] }),
    child("two", { declaredScope: ["src/app/routes"] }),
  ]), ContractValidationError);
  assert.doesNotThrow(() => parse("feature", [
    child("one", { declaredScope: ["src/app"] }),
    child("two", { projectId: "consumer-project", declaredScope: ["src/app"] }),
  ]));
  assert.doesNotThrow(() => parse("blast_radius", phasedChildren({
    expand: { declaredScope: ["src/provider/interface.ts", "docs/interface.md"] },
    contract: { declaredScope: ["src/provider/interface.ts", "docs/interface.md"] },
  })));
  assert.throws(() => parse("blast_radius", phasedChildren({
    migrateTwo: {
      projectId: "consumer-one",
      declaredScope: ["src/consumer-one/routes"],
    },
  })), ContractValidationError);
});

test("declared children do not invent a changeShape requirement", () => {
  assert.equal(parseWithoutChangeShape([
    child("one"),
    child("two", { projectId: "consumer-project", declaredScope: ["src/two"] }),
  ])?.children?.length, 2);
});

test("declared child fields use contract identifiers, scope paths, phases, and split kinds", () => {
  for (const invalid of [
    child("-invalid"),
    child("one", { projectId: "-invalid" }),
    child("one", { declaredScope: ["/absolute"] }),
    child("one", { acceptanceCriteria: [] }),
    child("one", { phase: "future" }),
    child("one", { splitBy: "repository" }),
  ]) {
    assert.throws(() => parse("feature", [invalid]), ContractValidationError);
  }
});

test("declared-scope overlap failures use the contract validation error", () => {
  assert.throws(
    () => declaredScopesOverlap(["/"], ["src"]),
    (error: unknown) => error instanceof ContractValidationError && /empty path prefix/u.test(error.message),
  );
});

test("work-item entities parse decomposition identity fields and the dependency type is public", () => {
  const parsed = parseWorkItemEntity({
    apiVersion: TASK_BOARD_API_VERSION,
    workItemId: "child-work-item",
    originalRequest: "Implement the consumer migration.",
    refinedObjective: null,
    priority: "normal",
    taskType: "standard",
    projectTarget: { mode: "explicit", projectId: "consumer-project" },
    resolvedProjectId: "consumer-project",
    parentWorkItemId: "parent-work-item",
    phase: "migrate",
    childOrdinal: 2,
    planningTaskId: null,
    pipelineBranch: null,
    baseSha: null,
    state: "queued",
    currentStage: null,
    createdBy: "human:operator",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    endedAt: null,
    cancelledReason: null,
    archivedAt: null,
  }, "workItem");
  assert.deepEqual({
    parentWorkItemId: parsed.parentWorkItemId,
    phase: parsed.phase,
    childOrdinal: parsed.childOrdinal,
  }, {
    parentWorkItemId: "parent-work-item",
    phase: "migrate",
    childOrdinal: 2,
  });
  const dependency: WorkItemDependency = {
    workItemId: "child-work-item",
    dependsOnWorkItemId: "expand-work-item",
  };
  assert.equal(dependency.dependsOnWorkItemId, "expand-work-item");
});

test("project requests default repoPath to description and project entities expose it", () => {
  assert.deepEqual(parseBoardCreateProject({
    name: "Provider",
    description: "/repos/legacy-provider",
  }), {
    name: "Provider",
    description: "/repos/legacy-provider",
    repoPath: "/repos/legacy-provider",
  });
  assert.deepEqual(parseBoardCreateProject({
    name: "Provider",
    description: "Owns the public interface.",
    repoPath: "/repos/provider",
  }), {
    name: "Provider",
    description: "Owns the public interface.",
    repoPath: "/repos/provider",
  });
  const entity = parseProjectEntity({
    apiVersion: TASK_BOARD_API_VERSION,
    projectId: "provider-project",
    name: "Provider",
    description: "Owns the public interface.",
    repoPath: "/repos/provider",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }, "project");
  assert.equal(entity.repoPath, "/repos/provider");
});
