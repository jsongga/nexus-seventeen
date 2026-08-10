import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_ROLES,
  EVALUATOR_PROFILES,
  IDENTIFIER_PATTERN,
  STAGE_HANDOFF_OUTCOMES,
  TASK_KINDS,
  TASK_BOARD_API_VERSION,
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  TASK_STATUSES,
  WAKEUP_REASONS,
  WORKFLOW_STAGES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STAGES,
} from "#shared/task-board-contract";
import {
  NAMED_EXACT_MESSAGES,
  PATH_EXACT_MESSAGES,
  exact,
  identifier,
  parseBoardAutomationUpdate,
  parseBoardCreateAgent,
  parseBoardCreateTaskPhase,
  parseBoardCreateWorkItem,
  parseBoardIdentifier,
  parseBoardSettle,
  parseBoardUpdateTask,
  parseBoardUpdateTaskPhase,
  parseClaimRunResult,
  parseWorkerAgentContext,
  parseWorkerAgentRunOutcome,
  prose,
  timestamp,
} from "#shared/task-board-contract/validate";

const NOW = "2026-08-09T20:00:00.000Z";

function assertAcceptedSet(expected: readonly string[], validate: (value: string) => unknown): void {
  const candidates = [...expected, "not_a_contract_member"];
  const accepted = candidates.filter((candidate) => {
    try { validate(candidate); return true; } catch { return false; }
  });
  assert.deepEqual(accepted, [...expected]);
}

function thrownMessage(validate: () => unknown): string {
  try {
    validate();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail("Expected validation to throw");
}

function context(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 1,
    projectId: "project-one",
    agentId: "agent-one",
    taskId: "task-one",
    mission: { role: "engineer", area: "Checkout", mission: "Keep checkout dependable." },
    projectMemory: "Checkout uses idempotency keys.",
    task: {
      kind: "work", requiredRole: null, title: "Inspect checkout", objective: "Find the retry boundary.",
      acceptanceCriteria: "The boundary is verified.", version: 1, expectedAgentMinutes: null, phases: [],
    },
    areaMemory: [], parentEvidence: null, messagesSinceCursor: null, nextMessageCursor: 0, messages: [],
    triggerQuestion: null, openQuestions: [], workspaceRefs: [], workflow: null,
    ...overrides,
  };
}

function outcome(handoff: unknown = null, workflowPlan: unknown = null): unknown {
  return {
    status: "completed", outputs: [{ type: "result", body: "Done." }], expectedAgentMinutes: null,
    phases: [], detail: "Done.", handoff, workflowPlan,
  };
}

function stages(): Array<Readonly<{ stage: string; executor: Readonly<{ kind: string }> }>> {
  return WORK_ITEM_STAGES.map((stage) => ({ stage, executor: { kind: stage === "human_review" ? "human" : "disabled" } }));
}

test("exact supports generic, named-field, and browser path-compatible messages", () => {
  assert.equal(thrownMessage(() => exact({ a: 1, b: 2 }, ["a"], "Payload")),
    "Payload has unexpected or missing fields");
  assert.equal(thrownMessage(() => exact({ a: 1, b: 2 }, ["a"], "Payload", { messages: NAMED_EXACT_MESSAGES })),
    "Payload has unexpected field b");
  assert.equal(thrownMessage(() => exact({}, ["a"], "payload", { messages: PATH_EXACT_MESSAGES })),
    "payload.a is required");
});

test("prose exposes board-strict and worker-preserved carriage-return policies", () => {
  assert.throws(() => prose("line one\r\nline two", "body", { maximum: 100 }), /invalid/u);
  assert.throws(() => prose("\rline one", "body", { maximum: 100 }), /invalid/u);
  assert.equal(prose("line one\r\nline two", "body", { maximum: 100, carriageReturns: "preserve" }), "line one\r\nline two");
  assert.equal(prose("line one\r\nline two", "body", { maximum: 100, carriageReturns: "normalize" }), "line one\nline two");
});

test("claim result validation preserves canonical timestamps and the legacy projection boundary", () => {
  const claim = {
    apiVersion: TASK_BOARD_API_VERSION,
    run: {
      apiVersion: TASK_BOARD_API_VERSION,
      runId: "run-one",
      claimId: "claim-one",
      projectId: "project-one",
      agentId: "agent-one",
      wakeupId: "wakeup-one",
      taskId: "task-one",
      status: "active",
      startedAt: NOW,
      endedAt: null,
      result: null,
    },
    wakeup: {
      apiVersion: TASK_BOARD_API_VERSION,
      wakeupId: "wakeup-one",
      projectId: "project-one",
      agentId: "agent-one",
      reason: "human_assignment",
      taskId: "task-one",
      questionId: null,
      detail: "Run the task.",
      createdBy: "human:operator",
      createdAt: NOW,
      claimedAt: NOW,
      runId: "run-one",
    },
    task: { validatedByTheBoundedContextProjection: true },
    context: {
      agent: null,
      projectMemory: null,
      areaMemory: [],
      parentTask: null,
      parentMessages: [],
      acceptanceCriteria: null,
      workspaceRefs: [],
      messageCursor: 0,
      messages: [],
      triggerQuestion: null,
      openQuestions: [],
      workflow: null,
    },
  };

  assert.equal(parseClaimRunResult(claim), claim);
  assert.equal(thrownMessage(() => parseClaimRunResult({
    ...claim,
    run: { ...claim.run, startedAt: "2026-08-09T13:00:00-07:00" },
  })), "run.startedAt is invalid");
});

test("timestamp accepts ISO spellings for web millisecond projection and can require canonical worker form", () => {
  const offset = "2026-08-09T13:00:00-07:00";
  assert.equal(timestamp(offset, "createdAt"), offset);
  assert.equal(Date.parse(timestamp(offset, "createdAt")), Date.parse(NOW));
  assert.throws(() => timestamp(offset, "createdAt", "createdAt must be canonical", true), /canonical/u);
  assert.equal(timestamp(NOW, "createdAt", "createdAt must be canonical", true), NOW);
});

test("identifier validation is the single contract grammar", () => {
  const contractPattern = new RegExp(IDENTIFIER_PATTERN, "u");
  assert.equal(contractPattern.source, IDENTIFIER_PATTERN);
  assert.equal(parseBoardIdentifier("A" + "a".repeat(127), "id"), "A" + "a".repeat(127));
  assert.throws(() => parseBoardIdentifier("A" + "a".repeat(128), "id"), /invalid/u);
  assert.throws(() => identifier("-leading-dash", "id"), /invalid/u);
});

test("board request shapes accept exactly the shared contract enum members", () => {
  assertAcceptedSet(AGENT_ROLES, (role) => parseBoardCreateAgent({
    agentId: "agent-one", role, area: "checkout", mission: "Keep checkout safe.", model: "model-one",
    token: "task-board-agent-token-0123456789abcdef",
  }));
  assertAcceptedSet(TASK_PHASE_STAGES, (stage) => parseBoardCreateTaskPhase({ title: "Inspect", stage, parallelGroup: null }));
  assertAcceptedSet(TASK_PHASE_STATUSES, (status) => parseBoardUpdateTaskPhase({ version: 1, status }));
  assertAcceptedSet(TASK_STATUSES, (status) => parseBoardUpdateTask({ version: 1, status }));
  assertAcceptedSet(WORK_ITEM_PRIORITIES, (priority) => parseBoardCreateWorkItem({
    originalRequest: "Make checkout safe.", priority, projectTarget: { mode: "explicit", projectId: "project-one" },
  }));
  assertAcceptedSet(EVALUATOR_PROFILES, (evaluatorProfile) => parseBoardAutomationUpdate({
    version: 1,
    agentTypes: [{ agentTypeId: "type-one", name: "Type one", description: "Disabled drift-test type.", role: "engineer",
      supplementalInstructions: "", skillIds: [], evaluatorProfile, enabled: false }],
    stages: stages(),
  }));
  assert.deepEqual(parseBoardAutomationUpdate({ version: 1, agentTypes: [], stages: stages() }).stages.map((stage) => stage.stage),
    [...WORK_ITEM_STAGES]);
});

test("board workflow shapes accept exactly the shared handoff and stage enums", () => {
  const handoff = (outcomeValue: string, returnStage: string | null) => ({
    outcome: outcomeValue, summary: "Verified.", evidence: [], artifactIds: [], acceptanceCriteria: [], blockers: [],
    recommendedReturnStage: returnStage,
  });
  assertAcceptedSet(STAGE_HANDOFF_OUTCOMES, (value) => parseBoardSettle({ outcome: "completed", result: "Done.", handoff: handoff(value, null) }));
  assertAcceptedSet(WORKFLOW_STAGES, (value) => parseBoardSettle({ outcome: "completed", result: "Done.", handoff: handoff("passed", value) }));
  assertAcceptedSet(WORKFLOW_STAGES, (stage) => parseBoardSettle({
    outcome: "completed", result: "Done.", workflowPlan: {
      objective: "Complete the work.", assumptions: [], acceptanceCriteria: ["The work is verified."],
      nodes: [{ nodeId: "node-one", title: "Do the work", objective: "Complete and verify it.",
        acceptanceCriteria: ["The work is verified."], dependencyNodeIds: [],
        stageTemplate: stage === "verification" ? [stage] : [stage, "verification"] }],
    },
  }));
});

test("worker context shapes accept exactly the shared role, task, and phase enums", () => {
  assert.deepEqual([...WAKEUP_REASONS], ["human_assignment", "human_answer", "human_resume", "workflow_handoff", "assigned", "resumed"]);
  assertAcceptedSet(AGENT_ROLES, (requiredRole) => parseWorkerAgentContext(context({ task: { ...(context().task as object), requiredRole } })));
  assertAcceptedSet(TASK_KINDS, (kind) => parseWorkerAgentContext(context({ task: { ...(context().task as object), kind } })));
  assertAcceptedSet(TASK_PHASE_STAGES, (stage) => parseWorkerAgentContext(context({ task: { ...(context().task as object), phases: [{
    phaseId: "phase-one", title: "Inspect", stage, status: stage === "done" ? "completed" : "pending", parallelGroup: null, orderKey: 0, version: 1,
  }] } })));
  assertAcceptedSet(TASK_PHASE_STATUSES, (status) => parseWorkerAgentContext(context({ task: { ...(context().task as object), phases: [{
    phaseId: "phase-one", title: "Inspect", stage: "research", status, parallelGroup: null, orderKey: 0, version: 1,
  }] } })));
});

test("worker expected minutes rejects an explicitly undefined value", () => {
  assert.equal(thrownMessage(() => parseWorkerAgentContext(context({
    task: { ...(context().task as object), expectedAgentMinutes: undefined },
  }))), "task.expectedAgentMinutes must be a 15-minute interval between 15 and 10080");
});

test("worker outcome shapes accept exactly the shared handoff and workflow enums", () => {
  assertAcceptedSet(STAGE_HANDOFF_OUTCOMES, (value) => parseWorkerAgentRunOutcome(outcome({
    outcome: value, summary: "Verified.", evidence: [], artifactIds: [], acceptanceCriteria: [], blockers: [], recommendedReturnStage: null,
  })));
  assertAcceptedSet(WORKFLOW_STAGES, (value) => parseWorkerAgentRunOutcome(outcome({
    outcome: "passed", summary: "Verified.", evidence: [], artifactIds: [], acceptanceCriteria: [], blockers: [], recommendedReturnStage: value,
  })));
  assertAcceptedSet(WORKFLOW_STAGES, (stage) => parseWorkerAgentRunOutcome(outcome(null, {
    objective: "Complete the work.", assumptions: [], acceptanceCriteria: ["The work is verified."], nodes: [{
      nodeId: "node-one", title: "Do the work", objective: "Complete and verify it.", acceptanceCriteria: ["The work is verified."],
      dependencyNodeIds: [], stageTemplate: stage === "verification" ? [stage] : [stage, "verification"],
    }],
  })));
});
