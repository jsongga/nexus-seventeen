import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DESIGN_FAILURE_POINTS,
  type DesignRecordDraft,
  type WorkflowPlanDraft,
} from "#shared/task-board-contract";
import { TaskBoardError } from "#server/task-board";
import {
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  latestParkRecord,
  workItemRequest,
} from "./helpers.js";

const BASE_SHA = "a".repeat(40);
const RAW_REQUEST = "Make hazardous checkout delivery crash-safe.";

function designRecord(): DesignRecordDraft {
  return {
    states: ["pending", "sent", "committed", "unknown"],
    transitions: [{
      from: "pending",
      to: "sent",
      durablePrecondition: "Persist the intent and idempotency key before sending.",
      recovery: "Resume from the durable intent with the same key.",
    }],
    failurePoints: DESIGN_FAILURE_POINTS.map((point) => ({
      point,
      resultingState: `durable state after ${point}`,
      recovery: `recover ${point} from durable state`,
    })),
    idempotencyKeys: [{
      name: "delivery-key",
      generatedAt: "When the durable intent is created.",
      persistedAt: "In the same transaction as the intent.",
      reuse: "Reuse verbatim for every retry.",
    }],
    faultInjectionCases: [{
      name: "Crash after commit",
      scenario: "Terminate after commit and before acknowledgement.",
      expectation: "Retry observes the committed result without duplicating delivery.",
    }],
  };
}

function hazardousPlan(
  stageTemplate: WorkflowPlanDraft["nodes"][number]["stageTemplate"] = [
    "implementation",
    "testing",
    "verification",
  ],
): WorkflowPlanDraft {
  return {
    objective: "Make hazardous delivery recoverable across every process boundary.",
    assumptions: ["The remote supports idempotency keys."],
    acceptanceCriteria: ["Every failure point has a tested recovery path."],
    changeShape: "feature",
    tier: "hazardous",
    declaredScope: ["src/server", "tests/server"],
    nonGoals: ["Do not change the database schema."],
    mechanicalPortions: ["Thread the design record through claim context."],
    blockingQuestions: [],
    criterionChecks: [{
      criterion: "The runtime suite passes.",
      check: "npm run test:runtime",
    }],
    nodes: [{
      nodeId: "hazardous-delivery",
      title: "Implement hazardous delivery",
      objective: "Implement the confirmed crash-safe delivery plan.",
      acceptanceCriteria: ["Fault-injection coverage passes."],
      dependencyNodeIds: [],
      stageTemplate,
    }],
  };
}

async function prepareHazardousPipeline(suffix: string, duplicateManagers = false) {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  if (duplicateManagers) {
    fixture.board.createAgent(fixture.project.projectId, {
      agentId: `manager-two-hazardous-${suffix}`,
      role: "manager",
      area: "hazardous design overflow",
      mission: "Provide another manager lane without changing deterministic design assignment.",
      model: "claude-haiku",
      token: `manager-two-hazardous-token-${suffix}-0123456789`,
    });
  }
  const implementer = {
    agentTypeId: `hazardous-implementer-${suffix}`,
    name: "Hazardous implementer",
    description: "Implements a confirmed hazardous pipeline plan.",
    role: "engineer" as const,
    supplementalInstructions: "Follow the confirmed design record.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  const reviewer = {
    ...implementer,
    agentTypeId: `hazardous-reviewer-${suffix}`,
    name: "Hazardous reviewer",
    description: "Reviews a hazardous pipeline independently.",
    role: "verifier" as const,
  };
  fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
    agentTypes: [implementer, reviewer],
    stages: automationStages({
      implementation: { kind: "agent_type", agentTypeId: implementer.agentTypeId },
      testing: { kind: "machine_verify" },
      verification: { kind: "agent_type", agentTypeId: reviewer.agentTypeId },
    }),
  }));
  const workItem = fixture.board.createWorkItemAndStartPlanning(workItemRequest({
    originalRequest: RAW_REQUEST,
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), `hazardous-design-${suffix}`).workItem;
  const planning = fixture.board.claimRun(fixture.manager.agentId, {
    claimId: `claim-hazardous-planning-${suffix}`,
    messageCursor: null,
  });
  assert.ok(planning);
  fixture.board.settleRun(planning.run.runId, fixture.manager.agentId, {
    outcome: "completed",
    result: "The hazardous pipeline plan is ready.",
    workflowPlan: hazardousPlan(),
  });
  const revision = fixture.board.projectWorkflow(fixture.project.projectId).plans.find(
    (candidate) => candidate.state === "proposed",
  );
  assert.ok(revision);
  const confirmation = fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
  return { ...fixture, workItem, revision, confirmation };
}

test("hazardous pipeline confirmation enters designing with identity and a claimable design task", async () => {
  const fixture = await prepareHazardousPipeline("confirm");
  try {
    assert.equal(fixture.confirmation.outcome, "designing");
    const current = fixture.board.requireWorkItem(fixture.workItem.workItemId);
    assert.equal(current.state, "designing");
    assert.equal(current.currentStage, "planning");
    assert.equal(current.pipelineBranch, `task/${fixture.workItem.workItemId}`);
    assert.equal(current.baseSha, BASE_SHA);
    assert.deepEqual(
      fixture.confirmation.nodes.map((node) => ({ state: node.state, currentStage: node.currentStage })),
      [{ state: "pending", currentStage: null }],
    );

    const claim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-hazardous-design-confirm",
      messageCursor: null,
    });
    assert.ok(claim?.task);
    assert.equal(claim.context.intake, false);
    assert.equal((claim.context as { design?: boolean }).design, true);
    assert.equal(
      claim.task.title,
      `Design workflow: ${hazardousPlan().objective}`,
    );
    assert.match(claim.task.objective, /"tier":"hazardous"/u);
    assert.match(claim.task.objective, /"nodes":\[/u);
    assert.match(claim.task.objective, new RegExp(RAW_REQUEST, "u"));
  } finally {
    fixture.board.close();
  }
});

test("hazardous pipeline confirmation assigns design to the oldest duplicate manager", async () => {
  const fixture = await prepareHazardousPipeline("duplicate-managers", true);
  try {
    assert.equal(fixture.confirmation.outcome, "designing");
    const claim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-hazardous-design-duplicate-managers",
      messageCursor: null,
    });
    assert.ok(claim?.task);
    assert.equal(claim.run.agentId, fixture.manager.agentId);
    assert.equal(claim.task.assignedAgentId, fixture.manager.agentId);
    assert.equal((claim.context as { design?: boolean }).design, true);
  } finally {
    fixture.board.close();
  }
});

test("a complete design settlement persists the record, activates implementation, and injects every later claim", async () => {
  const fixture = await prepareHazardousPipeline("complete");
  const draft = designRecord();
  try {
    const designClaim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-hazardous-design-complete",
      messageCursor: null,
    });
    assert.ok(designClaim);
    fixture.board.settleRun(designClaim.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "The hazardous design record is complete.",
      designRecord: draft,
    } as never);

    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const persisted = db.prepare(
        "SELECT work_item_id,plan_revision_id,payload_json FROM design_records WHERE work_item_id=?",
      ).get(fixture.workItem.workItemId);
      assert.equal(persisted?.work_item_id, fixture.workItem.workItemId);
      assert.equal(persisted?.plan_revision_id, fixture.revision.planRevisionId);
      assert.deepEqual(JSON.parse(String(persisted?.payload_json)), draft);
    } finally {
      db.close();
    }
    const current = fixture.board.requireWorkItem(fixture.workItem.workItemId);
    assert.equal(current.state, "implementing");
    assert.equal(current.currentStage, "implementation");
    const implementation = fixture.board.projectWorkflow(fixture.project.projectId).nodes[0];
    assert.equal(implementation?.state, "active");
    assert.equal(implementation?.currentStage, "implementation");

    const implementationClaim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-hazardous-implementation-after-design",
      messageCursor: null,
    });
    assert.ok(implementationClaim?.context.workflow?.pipeline);
    assert.equal((implementationClaim.context as { design?: boolean }).design, false);
    assert.deepEqual(
      (implementationClaim.context.workflow.pipeline as { designRecord?: DesignRecordDraft | null }).designRecord,
      draft,
    );
  } finally {
    fixture.board.close();
  }
});

test("a completed design is discarded when cancellation wins the settlement race", async () => {
  const fixture = await prepareHazardousPipeline("cancelled");
  try {
    const designClaim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-hazardous-design-cancelled",
      messageCursor: null,
    });
    assert.ok(designClaim?.task);
    const beforeCancellation = fixture.board.requireWorkItem(fixture.workItem.workItemId);
    const cancelled = fixture.board.updateWorkItem(fixture.workItem.workItemId, {
      version: beforeCancellation.version,
      action: "cancel",
      reason: "The operator cancelled while the design run was active.",
    });
    assert.equal(cancelled.state, "abandoned");
    assert.equal(fixture.board.snapshot(fixture.project.projectId).recentRuns.find(
      (run) => run.runId === designClaim.run.runId,
    )?.status, "interrupted");
    const cancelledTask = fixture.board.requireTask(designClaim.task.taskId);
    assert.equal(cancelledTask.status, "cancelled");

    const settlement = {
      outcome: "completed",
      result: "The design completed after cancellation.",
      designRecord: designRecord(),
    } as const;
    const settled = fixture.board.settleRun(designClaim.run.runId, fixture.manager.agentId, settlement);
    assert.equal(settled.run.status, "completed");
    assert.equal(settled.duplicate, false);
    const afterSettlement = fixture.board.requireWorkItem(fixture.workItem.workItemId);
    assert.equal(afterSettlement.state, "abandoned");
    assert.equal(afterSettlement.version, cancelled.version);
    assert.equal(afterSettlement.endedAt, cancelled.endedAt);
    assert.equal(afterSettlement.cancelledReason, cancelled.cancelledReason);
    assert.deepEqual(fixture.board.requireTask(designClaim.task.taskId), cancelledTask);
    const replay = fixture.board.settleRun(designClaim.run.runId, fixture.manager.agentId, settlement);
    assert.equal(replay.run.status, "completed");
    assert.equal(replay.duplicate, true);
    assert.deepEqual(fixture.board.requireWorkItem(fixture.workItem.workItemId), afterSettlement);

    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(db.prepare(
        "SELECT COUNT(*) AS count FROM design_records WHERE work_item_id=?",
      ).get(fixture.workItem.workItemId)?.count, 0);
      assert.equal(db.prepare(
        "SELECT COUNT(*) AS count FROM interrupts WHERE run_id=?",
      ).get(designClaim.run.runId)?.count, 1);
      const node = db.prepare(`
        SELECT state,current_stage
        FROM work_nodes
        WHERE plan_revision_id=?
      `).get(fixture.revision.planRevisionId);
      assert.equal(node?.state, "pending");
      assert.equal(node?.current_stage, null);
      const discarded = db.prepare(`
        SELECT data_json
        FROM task_events
        WHERE task_id=? AND event_type='work_item_design_discarded'
      `).get(designClaim.task.taskId);
      assert.ok(discarded);
      assert.deepEqual(JSON.parse(String(discarded.data_json)), {
        workItemId: fixture.workItem.workItemId,
        runId: designClaim.run.runId,
        reason: "work_item_ended",
      });
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM task_events
        WHERE task_id=? AND event_type='work_item_design_discarded'
      `).get(designClaim.task.taskId)?.count, 1);
    } finally {
      db.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("cancelling mid-implementing cancels the stage task and retires its pending wakeup", async () => {
  const fixture = await prepareHazardousPipeline("cancel-implementing");
  try {
    const designClaim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-hazardous-design-cancel-implementing",
      messageCursor: null,
    });
    assert.ok(designClaim?.task);
    fixture.board.settleRun(designClaim.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "The design is ready before cancellation.",
      designRecord: designRecord(),
    });
    const implementing = fixture.board.requireWorkItem(fixture.workItem.workItemId);
    assert.equal(implementing.state, "implementing");
    const stageTask = fixture.board.snapshot(fixture.project.projectId).tasks.find(
      (task) => task.status === "queued",
    );
    assert.ok(stageTask);
    assert.equal(stageTask.status, "queued");

    fixture.board.updateWorkItem(fixture.workItem.workItemId, {
      version: implementing.version,
      action: "cancel",
      reason: "Stop the active implementation before it is claimed.",
    });

    assert.equal(fixture.board.requireTask(stageTask.taskId).status, "cancelled");
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM wakeups wakeup
        JOIN task_events event ON event.event_id='retired-wakeup:' || wakeup.wakeup_id
        WHERE wakeup.task_id=? AND wakeup.claimed_at IS NULL
          AND event.event_type='agent_wakeup_retired'
          AND json_extract(event.data_json, '$.retirementReason')='task_cancelled'
      `).get(stageTask.taskId)?.count, 1);
    } finally {
      db.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("completed design settlement requires a record and names the first missing failure point", async () => {
  const fixture = await prepareHazardousPipeline("invalid");
  try {
    const designClaim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-hazardous-design-invalid",
      messageCursor: null,
    });
    assert.ok(designClaim);
    const incomplete = {
      ...designRecord(),
      failurePoints: designRecord().failurePoints.slice(0, -1),
    };
    assert.throws(
      () => fixture.board.settleRun(designClaim.run.runId, fixture.manager.agentId, {
        outcome: "completed",
        result: "The design is incomplete.",
        designRecord: incomplete,
      } as never),
      (error: unknown) => error instanceof TaskBoardError &&
        error.status === 400 &&
        error.code === "TASK_BOARD_DESIGN_RECORD_REQUIRED" &&
        error.message === "design record missing failure point: concurrent_invocation",
    );
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "designing");
  } finally {
    fixture.board.close();
  }
});

test("completed design settlement without a record is rejected and remains active", async () => {
  const fixture = await prepareHazardousPipeline("missing");
  try {
    const designClaim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-hazardous-design-missing",
      messageCursor: null,
    });
    assert.ok(designClaim);
    assert.throws(
      () => fixture.board.settleRun(designClaim.run.runId, fixture.manager.agentId, {
        outcome: "completed",
        result: "The design record was omitted.",
      }),
      (error: unknown) => error instanceof TaskBoardError &&
        error.status === 400 &&
        error.code === "TASK_BOARD_DESIGN_RECORD_REQUIRED",
    );
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT status FROM runs WHERE run_id=?").get(designClaim.run.runId)?.status, "active");
    } finally {
      db.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("non-completed design settlements reject a design record", async () => {
  const fixture = await prepareHazardousPipeline("failed-with-record");
  try {
    const designClaim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-hazardous-design-failed-with-record",
      messageCursor: null,
    });
    assert.ok(designClaim);
    assert.throws(
      () => fixture.board.settleRun(designClaim.run.runId, fixture.manager.agentId, {
        outcome: "failed",
        result: "The design failed but echoed a partial record.",
        designRecord: designRecord(),
      }),
      (error: unknown) => error instanceof TaskBoardError &&
        error.status === 400 &&
        error.code === "TASK_BOARD_DESIGN_RECORD_NOT_ALLOWED",
    );
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT status FROM runs WHERE run_id=?").get(designClaim.run.runId)?.status, "active");
    } finally {
      db.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("design records are rejected on non-design tasks", async () => {
  const fixture = await prepareHazardousPipeline("not-allowed");
  try {
    const designClaim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-hazardous-design-before-engineer-rejection",
      messageCursor: null,
    });
    assert.ok(designClaim);
    fixture.board.settleRun(designClaim.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "The design is complete.",
      designRecord: designRecord(),
    } as never);
    const engineerClaim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-hazardous-engineer-design-rejection",
      messageCursor: null,
    });
    assert.ok(engineerClaim);
    assert.throws(
      () => fixture.board.settleRun(engineerClaim.run.runId, fixture.engineer.agentId, {
        outcome: "failed",
        result: "The engineer must not replace the design.",
        designRecord: designRecord(),
      } as never),
      (error: unknown) => error instanceof TaskBoardError &&
        error.status === 400 &&
        error.code === "TASK_BOARD_DESIGN_RECORD_NOT_ALLOWED",
    );
  } finally {
    fixture.board.close();
  }
});

test("a failed design run parks the hazardous work item", async () => {
  const fixture = await prepareHazardousPipeline("failed");
  try {
    const designClaim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-hazardous-design-failed",
      messageCursor: null,
    });
    assert.ok(designClaim);
    fixture.board.settleRun(designClaim.run.runId, fixture.manager.agentId, {
      outcome: "failed",
      result: "The design could not establish a safe recovery path.",
    });
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "parked");
    assert.equal(fixture.board.requireTask(designClaim.task!.taskId).result, "The design could not establish a safe recovery path.");
    assert.deepEqual(latestParkRecord(fixture.path, fixture.workItem.workItemId), {
      category: "design_run_failed",
      reason: "The design could not establish a safe recovery path.",
    });
  } finally {
    fixture.board.close();
  }
});

test("hazardous non-pipeline confirmation remains parked with the pipeline-plan requirement", async () => {
  const fixture = await boardFixture();
  try {
    const verifier = {
      agentTypeId: "hazardous-non-pipeline-verifier",
      name: "Hazardous verifier",
      description: "Executes the ordinary verification-only workflow.",
      role: "verifier" as const,
      supplementalInstructions: "Verify only.",
      skillIds: [],
      evaluatorProfile: "tests" as const,
      enabled: true,
    };
    fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
      agentTypes: [verifier],
      stages: automationStages({ verification: { kind: "agent_type", agentTypeId: verifier.agentTypeId } }),
    }));
    const workItem = fixture.board.createWorkItemAndStartPlanning(workItemRequest({
      originalRequest: "Confirm hazardous work without a pipeline plan.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }), "hazardous-non-pipeline-design").workItem;
    const planning = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-hazardous-non-pipeline-planning",
      messageCursor: null,
    });
    assert.ok(planning);
    fixture.board.settleRun(planning.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "The non-pipeline plan is ready.",
      workflowPlan: hazardousPlan(["verification"]),
    });
    const revision = fixture.board.projectWorkflow(fixture.project.projectId).plans.find(
      (candidate) => candidate.state === "proposed",
    );
    assert.ok(revision);
    const confirmed = fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
    assert.equal(confirmed.outcome, "parked_hazardous");
    assert.equal(fixture.board.requireWorkItem(workItem.workItemId).state, "parked");
    assert.equal(
      fixture.board.requireTask(workItem.planningTaskId!).result,
      "hazardous tier requires a pipeline plan",
    );
    assert.deepEqual(latestParkRecord(fixture.path, workItem.workItemId), {
      category: "hazardous_without_pipeline",
      reason: "hazardous tier requires a pipeline plan",
    });
  } finally {
    fixture.board.close();
  }
});
