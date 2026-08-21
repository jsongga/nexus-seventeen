import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PlanRevision,
  WorkflowPlanDraft,
} from "#shared/task-board-contract";
import { HttpTaskBoardClient } from "#server/agents/task-worker";
import { createTaskBoardService, TaskBoard } from "#server/task-board";
import {
  AGENT_ONE_TOKEN,
  AGENT_TWO_TOKEN,
  HUMAN_TOKEN,
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  config,
  gateActions,
  latestParkRecord,
  workItemRequest,
} from "./helpers.js";

const REJECTED_TWICE_RESULT = "plan rejected twice — request unclear";
const HAZARDOUS_RESULT = "hazardous tier requires a pipeline plan";

function standardPlan(suffix: string): WorkflowPlanDraft {
  return {
    objective: `Revise the checkout workflow (${suffix}).`,
    assumptions: ["The checkout project remains available."],
    acceptanceCriteria: ["The confirmed workflow is internally consistent."],
    nodes: [{
      nodeId: `verify-checkout-${suffix}`,
      title: `Verify checkout ${suffix}`,
      objective: "Verify the requested checkout behavior.",
      acceptanceCriteria: ["The verification evidence is recorded."],
      dependencyNodeIds: [],
      stageTemplate: ["verification"],
    }],
  };
}

function hazardousPlan(): WorkflowPlanDraft {
  return {
    objective: "Change a hazardous checkout control.",
    assumptions: ["The change requires a later Design stage."],
    acceptanceCriteria: ["Hazardous work does not activate directly."],
    changeShape: "blast_radius",
    tier: "hazardous",
    declaredScope: ["src/checkout"],
    nonGoals: ["Do not activate implementation before design."],
    mechanicalPortions: ["Update the bounded checkout configuration."],
    blockingQuestions: [{
      question: "Which rollback control should Design select?",
      recommendedDefault: "Retain the current control until Design completes.",
    }],
    criterionChecks: [{
      criterion: "Hazardous work remains parked.",
      check: "Inspect the work-item state and workflow node state.",
    }],
    nodes: [{
      nodeId: "hazardous-checkout-control",
      title: "Change the hazardous checkout control",
      objective: "Implement the control only after a Design stage exists.",
      acceptanceCriteria: ["The control is machine verified."],
      dependencyNodeIds: [],
      stageTemplate: ["verification"],
    }],
  };
}

function settlePlanning(
  fixture: Awaited<ReturnType<typeof boardFixture>>,
  claimId: string,
  plan: WorkflowPlanDraft,
): PlanRevision {
  const claim = fixture.board.claimRun(fixture.manager.agentId, { claimId, messageCursor: null });
  assert.ok(claim);
  assert.equal(claim.context.intake, true);
  fixture.board.settleRun(claim.run.runId, fixture.manager.agentId, {
    outcome: "completed",
    result: `Proposed ${plan.objective}`,
    workflowPlan: plan,
  });
  const proposed = fixture.board.projectWorkflow(fixture.project.projectId).plans.find((item) => item.state === "proposed");
  assert.ok(proposed);
  return proposed;
}

function startIntake(
  fixture: Awaited<ReturnType<typeof boardFixture>>,
  idempotencyKey: string,
  originalRequest = "Make checkout revision handling explicit.",
) {
  const executor = {
    agentTypeId: "plan-gate-executor",
    name: "Plan gate executor",
    description: "Makes proposed workflow stages available to the plan gate tests.",
    role: "engineer" as const,
    supplementalInstructions: "Execute only a confirmed plan.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  const verifier = {
    ...executor,
    agentTypeId: "plan-gate-verifier",
    name: "Plan gate verifier",
    description: "Makes the verification stage available to plan gate tests.",
    role: "verifier" as const,
  };
  fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
    agentTypes: [executor, verifier],
    stages: automationStages({
      implementation: { kind: "agent_type", agentTypeId: executor.agentTypeId },
      testing: { kind: "machine_verify" },
      verification: { kind: "agent_type", agentTypeId: verifier.agentTypeId },
    }),
  }));
  return fixture.board.createWorkItemAndStartPlanning(workItemRequest({
    originalRequest,
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), idempotencyKey).workItem;
}

test("a rejected plan creates a fresh noted planning task and the second proposal can confirm", async () => {
  const fixture = await boardFixture();
  try {
    const workItem = startIntake(fixture, "plan-revision-success-0001");
    const originalPlanningTaskId = workItem.planningTaskId;
    assert.ok(originalPlanningTaskId);
    const firstPlan = settlePlanning(fixture, "plan-revision-success-first-claim-0001", standardPlan("first"));
    const note = "Keep the objective, but make the rollback behavior explicit. Bearer plan-gate-secret";

    assert.deepEqual(fixture.board.rejectWorkflowPlan(firstPlan.planRevisionId, {
      note,
      expectedState: "proposed",
    }), { outcome: "revising" });

    const revising = fixture.board.requireWorkItem(workItem.workItemId);
    assert.equal(revising.state, "planning");
    assert.notEqual(revising.planningTaskId, originalPlanningTaskId);
    assert.ok(revising.planningTaskId);
    assert.equal(
      fixture.board.requireTask(revising.planningTaskId).objective,
      `Prior plan rejected: ${note}\n\n${workItem.originalRequest}`,
    );
    const rejected = fixture.board.projectWorkflow(fixture.project.projectId).plans.find(
      (plan) => plan.planRevisionId === firstPlan.planRevisionId,
    );
    assert.equal(rejected?.state, "rejected");
    assert.equal(rejected?.rejectedNote, note);

    const rejectedAction = gateActions(fixture.path, workItem.workItemId).find(
      (action) => action.gate === "plan_reject",
    );
    assert.ok(rejectedAction);
    assert.match(rejectedAction.gateActionId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual({ ...rejectedAction, gateActionId: undefined }, {
      gateActionId: undefined,
      workItemId: workItem.workItemId,
      gate: "plan_reject",
      actorId: "human:alice",
      planRevisionId: firstPlan.planRevisionId,
      verifiedSha: null,
      mergeSha: null,
      refId: null,
      note: "Keep the objective, but make the rollback behavior explicit. [redacted:bearer]",
      createdAt: "2026-07-19T20:00:00.000Z",
    });

    const secondPlan = settlePlanning(fixture, "plan-revision-success-second-claim-0001", standardPlan("second"));
    const confirmed = fixture.board.confirmWorkflow(secondPlan.planRevisionId, { expectedState: "proposed" });
    assert.equal(confirmed.outcome, undefined);
    assert.equal(confirmed.plans.find((plan) => plan.planRevisionId === secondPlan.planRevisionId)?.state, "confirmed");
    const confirmedAction = gateActions(fixture.path, workItem.workItemId).find(
      (action) => action.gate === "plan_confirm",
    );
    assert.ok(confirmedAction);
    assert.match(confirmedAction.gateActionId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual({ ...confirmedAction, gateActionId: undefined }, {
      gateActionId: undefined,
      workItemId: workItem.workItemId,
      gate: "plan_confirm",
      actorId: "human:alice",
      planRevisionId: secondPlan.planRevisionId,
      verifiedSha: null,
      mergeSha: null,
      refId: String(secondPlan.revision),
      note: null,
      createdAt: "2026-07-19T20:00:00.000Z",
    });
  } finally {
    fixture.board.close();
  }
});

test("a prepended rejection note survives bounded worker-context truncation", async () => {
  const fixture = await boardFixture();
  try {
    const workItem = startIntake(fixture, "plan-revision-long-request-0001", "x".repeat(8_000));
    const firstPlan = settlePlanning(
      fixture,
      "plan-revision-long-request-first-claim-0001",
      standardPlan("long-request"),
    );
    const note = "Keep the rollback instruction at the head of the manager context.";
    const prefix = `Prior plan rejected: ${note}`;

    fixture.board.rejectWorkflowPlan(firstPlan.planRevisionId, {
      note,
      expectedState: "proposed",
    });

    const revised = fixture.board.requireWorkItem(workItem.workItemId);
    assert.ok(revised.planningTaskId);
    assert.ok(fixture.board.requireTask(revised.planningTaskId).objective.startsWith(prefix));

    const claimId = "plan-revision-long-request-second-claim-0001";
    const rawClaim = fixture.board.claimRun(fixture.manager.agentId, { claimId, messageCursor: null });
    assert.ok(rawClaim);
    const client = new HttpTaskBoardClient({
      baseUrl: "http://127.0.0.1/",
      token: AGENT_TWO_TOKEN,
      fetchImplementation: async () => new Response(JSON.stringify(rawClaim), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    const mappedClaim = await client.claimNextWake({
      agentId: fixture.manager.agentId,
      claimId,
      messageCursors: {},
      longPollMs: 0,
    });
    assert.ok(mappedClaim?.context);
    assert.ok(mappedClaim.context.task.objective.startsWith(prefix));
    assert.match(mappedClaim.context.task.objective, /\n\[truncated\]$/u);
  } finally {
    fixture.board.close();
  }
});

test("rejecting a second plan parks the work item and records the bounded reason", async () => {
  const fixture = await boardFixture();
  try {
    const workItem = startIntake(fixture, "plan-revision-parked-0001");
    const firstPlan = settlePlanning(fixture, "plan-revision-parked-first-claim-0001", standardPlan("first-park"));
    fixture.board.rejectWorkflowPlan(firstPlan.planRevisionId, {
      note: "Clarify the rollback boundary.",
      expectedState: "proposed",
    });
    const secondPlan = settlePlanning(fixture, "plan-revision-parked-second-claim-0001", standardPlan("second-park"));
    const secondPlanningTaskId = fixture.board.requireWorkItem(workItem.workItemId).planningTaskId;
    assert.ok(secondPlanningTaskId);

    assert.deepEqual(fixture.board.rejectWorkflowPlan(secondPlan.planRevisionId, {
      note: "The revised rollback boundary is still ambiguous.",
      expectedState: "proposed",
    }), { outcome: "parked" });

    const parked = fixture.board.requireWorkItem(workItem.workItemId);
    assert.equal(parked.state, "parked");
    assert.equal(parked.planningTaskId, secondPlanningTaskId);
    assert.equal(fixture.board.requireTask(secondPlanningTaskId).result, REJECTED_TWICE_RESULT);
    assert.deepEqual(latestParkRecord(fixture.path, workItem.workItemId), {
      category: "plan_rejected_twice",
      reason: REJECTED_TWICE_RESULT,
    });
    const rejected = fixture.board.projectWorkflow(fixture.project.projectId).plans.find(
      (plan) => plan.planRevisionId === secondPlan.planRevisionId,
    );
    assert.equal(rejected?.state, "rejected");
    assert.equal(rejected?.rejectedNote, "The revised rollback boundary is still ambiguous.");
  } finally {
    fixture.board.close();
  }
});

test("confirming a hazardous non-pipeline plan parks without activating its node", async () => {
  const fixture = await boardFixture();
  try {
    const workItem = startIntake(fixture, "hazardous-plan-confirm-0001");
    const planningTaskId = workItem.planningTaskId;
    assert.ok(planningTaskId);
    const plan = settlePlanning(fixture, "hazardous-plan-confirm-claim-0001", hazardousPlan());

    const confirmed = fixture.board.confirmWorkflow(plan.planRevisionId, { expectedState: "proposed" });
    assert.equal(confirmed.outcome, "parked_hazardous");
    assert.equal(fixture.board.requireWorkItem(workItem.workItemId).state, "parked");
    assert.equal(fixture.board.requireTask(planningTaskId).result, HAZARDOUS_RESULT);
    assert.equal(confirmed.plans.find((item) => item.planRevisionId === plan.planRevisionId)?.state, "confirmed");
    assert.deepEqual(
      confirmed.nodes.map((node) => ({ state: node.state, currentStage: node.currentStage })),
      [{ state: "pending", currentStage: null }],
    );
  } finally {
    fixture.board.close();
  }
});

test("the reject endpoint is human-only, validates the exact request, and guards proposed state", async () => {
  const fixture = await boardFixture();
  const workItem = startIntake(fixture, "plan-revision-http-0001");
  const plan = settlePlanning(fixture, "plan-revision-http-claim-0001", standardPlan("http"));
  fixture.board.close();
  const service = await createTaskBoardService({
    dbPath: fixture.path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    corsOrigins: ["https://app.cicada.build"],
    now: () => new Date("2026-08-19T12:00:00.000Z"),
  });
  const address = await service.start();
  const send = (token: string, body: unknown) => fetch(`${address.url}/v1/plans/${plan.planRevisionId}/reject`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await send(AGENT_ONE_TOKEN, { note: "Revise it.", expectedState: "proposed" })).status, 401);
    for (const body of [
      { note: "", expectedState: "proposed" },
      { note: "x".repeat(2_001), expectedState: "proposed" },
      { note: "Revise it.", expectedState: "confirmed" },
      { note: "Revise it.", expectedState: "proposed", extra: true },
    ]) {
      assert.equal((await send(HUMAN_TOKEN, body)).status, 400);
    }
    const response = await send(HUMAN_TOKEN, { note: "Make the failure mode explicit.", expectedState: "proposed" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { outcome: "revising" });
    const conflict = await send(HUMAN_TOKEN, { note: "Try again.", expectedState: "proposed" });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { error: { code: string } }).error.code, "PLAN_NOT_PROPOSED");
  } finally {
    await service.close();
  }

  const reopened = await TaskBoard.open(config(fixture.path));
  try {
    assert.equal(reopened.requireWorkItem(workItem.workItemId).state, "planning");
  } finally {
    reopened.close();
  }
});
