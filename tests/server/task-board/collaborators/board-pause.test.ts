import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  type SettleRunRequest,
  type WorkflowPlanDraft,
} from "#shared/task-board-contract";
import { HttpTaskBoardClient } from "#server/agents/task-worker/http-board-client";
import { TaskWorkerJournalStore } from "#server/agents/task-worker/journal";
import { emptyTaskWorkerJournal } from "#server/agents/task-worker/schema";
import { TaskWorker } from "#server/agents/task-worker/worker";
import { TaskBoardError } from "#server/task-board";
import { AutomationCollaborator } from "#server/task-board/collaborators/automation";
import { ProjectsCollaborator } from "#server/task-board/collaborators/projects";
import { RunsCollaborator } from "#server/task-board/collaborators/runs";
import { TaskBoardRuntime } from "#server/task-board/collaborators/runtime";
import { TasksCollaborator } from "#server/task-board/collaborators/tasks";
import { registerParentTerminationCascade } from "#server/task-board/collaborators/work-item-transitions";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import {
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  config,
  taskRequest,
  workItemRequest,
} from "../helpers.js";

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function suspendPlan(): WorkflowPlanDraft {
  return {
    objective: "Keep interrupted implementation work resumable.",
    assumptions: ["The confirmed pipeline is still valid after a board pause."],
    acceptanceCriteria: ["A suspended attempt resumes without consuming the failure cap."],
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["src"],
    nonGoals: ["Do not treat suspension as a failed attempt."],
    mechanicalPortions: [],
    blockingQuestions: [],
    criterionChecks: [],
    nodes: [{
      nodeId: "suspend-implementation-node",
      title: "Suspend implementation safely",
      objective: "Resume the same implementation stage after the board pause ends.",
      acceptanceCriteria: ["The next linked stage attempt is attempt four."],
      dependencyNodeIds: [],
      stageTemplate: ["implementation", "testing", "verification"],
    }],
  };
}

function hazardousSuspendPlan(): WorkflowPlanDraft {
  return {
    ...suspendPlan(),
    objective: "Design interrupted hazardous work before implementation.",
    changeShape: "feature",
    tier: "hazardous",
  };
}

async function openRuns(path: string) {
  const boardConfig = config(path);
  const store = await TaskBoardStore.open(boardConfig.dbPath);
  const runtime = new TaskBoardRuntime(boardConfig, store);
  registerParentTerminationCascade(store, () => undefined);
  const automation = new AutomationCollaborator(runtime);
  const tasks = new TasksCollaborator(runtime);
  const projects = new ProjectsCollaborator(runtime, automation, tasks);
  const runs = new RunsCollaborator(runtime, automation, projects, tasks);
  return { store, runtime, projects, runs };
}

function closeRuns(opened: Awaited<ReturnType<typeof openRuns>>): void {
  opened.projects.close();
  opened.runtime.close();
  opened.store.close();
}

async function activePipelineFixture() {
  const fixture = await boardFixture(undefined, undefined, { git: () => "a".repeat(40) });
  const implementationType = {
    agentTypeId: "suspend-implementation-engineer",
    name: "Suspend implementation engineer",
    description: "Exercises resumable implementation suspension.",
    role: "engineer" as const,
    supplementalInstructions: "Implement the confirmed pipeline plan.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  const verificationType = {
    ...implementationType,
    agentTypeId: "suspend-verifier",
    name: "Suspend verifier",
    description: "Verifies resumed implementation work.",
    role: "verifier" as const,
  };
  fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
    agentTypes: [implementationType, verificationType],
    stages: automationStages({
      implementation: { kind: "agent_type", agentTypeId: implementationType.agentTypeId },
      testing: { kind: "machine_verify" },
      verification: { kind: "agent_type", agentTypeId: verificationType.agentTypeId },
    }),
  }));
  const workItem = fixture.board.createWorkItem(workItemRequest({
    originalRequest: "Suspend active implementation work without exhausting its retry budget.",
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), "suspend-active-pipeline").workItem;
  const proposed = fixture.board.proposeWorkflow({
    ...suspendPlan(),
    workItemId: workItem.workItemId,
    projectId: fixture.project.projectId,
    skillIds: [],
  });
  const plan = proposed.plans[0];
  assert.ok(plan);
  fixture.board.confirmWorkflow(plan.planRevisionId, { expectedState: "proposed" });
  const implementation = fixture.board.claimRun(fixture.engineer.agentId, {
    claimId: "claim-suspend-implementation-attempt-three",
    messageCursor: null,
  });
  assert.ok(implementation);
  const planning = fixture.board.claimRun(fixture.manager.agentId, {
    claimId: "claim-planning-left-active-during-pause",
    messageCursor: null,
  });
  assert.ok(planning);

  const db = new DatabaseSync(fixture.path);
  try {
    db.prepare("UPDATE stage_attempts SET attempt=3 WHERE task_id=?")
      .run(implementation.task!.taskId);
  } finally {
    db.close();
  }
  return { ...fixture, workItem, implementation, planning };
}

test("kill-switch suspension blocks an attempt-three node without failure accounting and resumes at attempt four", async () => {
  const fixture = await activePipelineFixture();
  try {
    const before = fixture.board.requireWorkItem(fixture.workItem.workItemId);
    const interruptWatch = fixture.board.waitForRunInterrupts(
      fixture.implementation.run.runId,
      fixture.engineer.agentId,
      0,
      30_000,
      new AbortController().signal,
    );
    const paused = fixture.board.setBoardPause({
      paused: true,
      reason: "operator maintenance",
      version: 1,
      actor: "human:alice",
    });
    assert.equal(paused.version, 2);
    assert.deepEqual(fixture.board.suspendAllActiveRuns(
      "board paused: operator maintenance",
      { type: "system", id: "system:kill-switch" },
    ), { suspended: 1, failed: 0 });
    const interruptBatch = await within(interruptWatch, 2_000);
    assert.equal(interruptBatch?.items[0]?.reason, "board paused: operator maintenance");
    assert.equal(interruptBatch?.items[0]?.requestedBy, "system:kill-switch");

    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const run = db.prepare("SELECT status,result FROM runs WHERE run_id=?")
        .get(fixture.implementation.run.runId);
      assert.deepEqual({ ...run }, {
        status: "interrupted",
        result: "board paused: operator maintenance",
      });
      assert.equal(db.prepare("SELECT status FROM runs WHERE run_id=?")
        .get(fixture.planning.run.runId)?.status, "active");
      assert.deepEqual({ ...db.prepare(`
        SELECT reason,requested_by
        FROM interrupts
        WHERE run_id=?
      `).get(fixture.implementation.run.runId) }, {
        reason: "board paused: operator maintenance",
        requested_by: "system:kill-switch",
      });
      const settledEvent = db.prepare(`
        SELECT actor_type,actor_id
        FROM task_events
        WHERE task_id=? AND event_type='agent_run_settled'
        ORDER BY sequence DESC LIMIT 1
      `).get(fixture.implementation.task!.taskId);
      assert.deepEqual({ ...settledEvent }, {
        actor_type: "system",
        actor_id: "system:kill-switch",
      });
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM park_records WHERE work_item_id=?")
        .get(fixture.workItem.workItemId)?.count, 0);
    } finally {
      db.close();
    }

    const suspendedWorkflow = fixture.board.projectWorkflow(fixture.project.projectId);
    const suspendedNode = suspendedWorkflow.nodes[0];
    assert.ok(suspendedNode);
    assert.equal(suspendedNode.state, "blocked");
    assert.ok(suspendedWorkflow.events.some((event) =>
      event.nodeId === suspendedNode.nodeId &&
      event.taskId === fixture.implementation.task!.taskId &&
      event.eventType === "node_blocked" &&
      event.summary === "board paused: operator maintenance"));
    assert.equal(suspendedWorkflow.events.some((event) =>
      event.taskId === fixture.implementation.task!.taskId && event.eventType === "stage_failed"), false);
    const suspendedItem = fixture.board.requireWorkItem(fixture.workItem.workItemId);
    assert.equal(suspendedItem.state, before.state);
    assert.equal(suspendedItem.currentStage, before.currentStage);
    assert.notEqual(suspendedItem.state, "dead_letter");

    fixture.board.setBoardPause({
      paused: false,
      reason: null,
      version: paused.version,
      actor: "human:alice",
    });
    fixture.board.resumePausedWork();
    const resumed = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-resumed-implementation-attempt-four",
      messageCursor: null,
    });
    assert.ok(resumed);
    const attempt = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(attempt.prepare("SELECT attempt FROM stage_attempts WHERE task_id=?")
        .get(resumed.task!.taskId)?.attempt, 4);
    } finally {
      attempt.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("an outputs_pending worker accepts a system-interrupt settlement replay and clears its claim", async () => {
  const fixture = await activePipelineFixture();
  const identity = { workerId: "suspend-race-worker", agentId: fixture.engineer.agentId };
  const statePath = join(dirname(fixture.path), "suspend-race-worker", "journal.json");
  const claim = Object.freeze({
    apiVersion: 1 as const,
    claimId: fixture.implementation.run.claimId,
    runId: fixture.implementation.run.runId,
    wakeupId: fixture.implementation.run.wakeupId,
    projectId: fixture.implementation.run.projectId,
    agentId: fixture.implementation.run.agentId,
    taskId: fixture.implementation.run.taskId,
    reason: fixture.implementation.wakeup.reason,
    requestedMessageCursor: null,
    claimedAt: fixture.implementation.run.startedAt,
  });
  const outcome = Object.freeze({
    status: "completed" as const,
    outputs: Object.freeze([{ type: "result" as const, body: "Buffered work completed before suspension." }]),
    expectedAgentMinutes: null,
    phases: Object.freeze([]),
    detail: "Buffered work completed before suspension.",
  });
  const journal = await TaskWorkerJournalStore.open(statePath, identity);
  await journal.save({
    ...emptyTaskWorkerJournal(identity),
    active: {
      claim,
      phase: "outputs_pending",
      contextDigest: `sha256:${"b".repeat(64)}`,
      launchStartedAt: fixture.implementation.run.startedAt,
      interruptReason: null,
      outcome,
      nextOutputIndex: outcome.outputs.length,
      correctableSettlementRejections: 0,
    },
  });
  await journal.close();

  const acknowledgments: Array<ReturnType<typeof fixture.board.settleRun>> = [];
  let settleCalls = 0;
  const client = new HttpTaskBoardClient({
    baseUrl: "http://127.0.0.1:4318",
    token: "suspend-race-agent-token-0123456789",
    fetchImplementation: (async (input, init = {}) => {
      assert.match(String(input), new RegExp(`/v1/runs/${claim.runId}/settle$`, "u"));
      settleCalls += 1;
      assert.deepEqual(fixture.board.suspendAllActiveRuns(
        "board paused: output flush race",
        { type: "system", id: "system:kill-switch" },
      ), { suspended: 1, failed: 0 });
      const request = JSON.parse(String(init.body)) as SettleRunRequest;
      const acknowledged = fixture.board.settleRun(claim.runId, claim.agentId, request);
      acknowledgments.push(acknowledged);
      return new Response(JSON.stringify(acknowledged), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  const worker = await TaskWorker.create({
    identity,
    statePath,
    board: client,
    launcher: {
      assertRole: () => undefined,
      launch: async () => { throw new Error("outputs_pending recovery must not launch"); },
    },
    longPollMs: 1,
  });
  try {
    assert.equal(await worker.dispatchOnce(), true);
    assert.equal(settleCalls, 1);
    assert.equal(acknowledgments[0]?.duplicate, true);
    assert.equal(acknowledgments[0]?.run.status, "interrupted");
    assert.equal(worker.hasActiveClaim(), false);
    assert.equal(worker.snapshot.completedRuns, 1);
  } finally {
    await worker.close();
    fixture.board.close();
  }
});

test("system suspension closes an in-progress task phase inside the settlement transaction", async () => {
  const fixture = await activePipelineFixture();
  const taskId = fixture.implementation.task!.taskId;
  const phase = fixture.board.createTaskPhase(taskId, {
    title: "Flush implementation output",
    stage: "execution",
    parallelGroup: null,
  }, fixture.engineer.agentId);
  const inProgress = fixture.board.updateTaskPhase(phase.phaseId, {
    version: phase.version,
    status: "in_progress",
  }, fixture.engineer.agentId);
  fixture.board.close();

  const opened = await openRuns(fixture.path);
  try {
    opened.store.transaction(() => {
      assert.ok(opened.runs.suspendActiveRunInTransaction(
        fixture.implementation.run.runId,
        "board paused: close live phases",
        { type: "system", id: "system:kill-switch" },
      ));
      const closed = opened.runtime.requireTaskPhase(inProgress.phaseId);
      assert.equal(closed.status, "failed");
      assert.ok(closed.endedAt);
      const event = opened.store.db.prepare(`
        SELECT actor_type,actor_id,data_json
        FROM task_events
        WHERE task_id=? AND event_type='task_phase_updated'
        ORDER BY sequence DESC LIMIT 1
      `).get(taskId);
      assert.equal(event?.actor_type, "system");
      assert.equal(event?.actor_id, "system:kill-switch");
      assert.equal(JSON.parse(String(event?.data_json)).terminalTaskStatus, "interrupted");
    });
  } finally {
    closeRuns(opened);
  }
});

test("one conflicting run does not stop the pause drain from suspending the rest", async (t) => {
  const fixture = await activePipelineFixture();
  let closed = false;
  try {
    const secondEngineer = fixture.board.createAgent(fixture.project.projectId, {
      agentId: "suspend-second-engineer",
      role: "engineer",
      area: "parallel-pause-drain",
      mission: "Keep a second pipeline run active during the pause drain.",
      model: "codex-mini",
      token: "suspend-second-engineer-token-0123456789",
    });
    const secondItem = fixture.board.createWorkItem(workItemRequest({
      originalRequest: "Suspend a second active implementation run after a peer conflicts.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }), "suspend-second-active-pipeline").workItem;
    const proposed = fixture.board.proposeWorkflow({
      ...suspendPlan(),
      workItemId: secondItem.workItemId,
      projectId: fixture.project.projectId,
      declaredScope: ["tests"],
      skillIds: [],
    });
    const plan = proposed.plans.find((candidate) => candidate.workItemId === secondItem.workItemId);
    assert.ok(plan);
    fixture.board.confirmWorkflow(plan.planRevisionId, { expectedState: "proposed" });
    const secondRun = fixture.board.claimRun(secondEngineer.agentId, {
      claimId: "claim-suspend-second-active-pipeline",
      messageCursor: null,
    });
    assert.ok(secondRun);
    fixture.board.close();
    closed = true;

    const opened = await openRuns(fixture.path);
    try {
      const activeRunIds = opened.store.db.prepare(`
        SELECT run_id FROM runs WHERE status='active' AND task_id IS NOT NULL ORDER BY started_at,run_id
      `).all().map((row) => String(row.run_id)).filter((runId) =>
        runId !== fixture.planning.run.runId);
      assert.equal(activeRunIds.length, 2);
      const conflictRunId = activeRunIds[0]!;
      const drainRunId = activeRunIds[1]!;
      const suspend = opened.runs.suspendActiveRunInTransaction.bind(opened.runs);
      t.mock.method(opened.runs, "suspendActiveRunInTransaction", (
        ...arguments_: Parameters<typeof opened.runs.suspendActiveRunInTransaction>
      ) => {
        const [runId] = arguments_;
        if (runId === conflictRunId) throw new Error("synthetic run settlement conflict");
        return suspend(...arguments_);
      });
      const logged = t.mock.method(console, "error", () => undefined);

      assert.deepEqual(opened.runs.suspendAllActiveRuns(
        "board paused: drain despite conflict",
        { type: "system", id: "system:kill-switch" },
      ), { suspended: 1, failed: 1 });
      assert.equal(logged.mock.callCount(), 1);
      assert.equal(opened.store.db.prepare("SELECT status FROM runs WHERE run_id=?")
        .get(conflictRunId)?.status, "active");
      assert.equal(opened.store.db.prepare("SELECT status FROM runs WHERE run_id=?")
        .get(drainRunId)?.status, "interrupted");
    } finally {
      closeRuns(opened);
    }
  } finally {
    if (!closed) fixture.board.close();
  }
});

test("suspending an active planning run leaves the work item for the cap caller to park", async () => {
  const fixture = await boardFixture();
  const workItem = fixture.board.createWorkItemAndStartPlanning(workItemRequest({
    originalRequest: "Leave planning state unchanged until the cap sweep parks it.",
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), "suspend-planning-cap-composition").workItem;
  const planning = fixture.board.claimRun(fixture.manager.agentId, {
    claimId: "claim-suspend-planning-cap-composition",
    messageCursor: null,
  });
  assert.ok(planning);
  const before = fixture.board.requireWorkItem(workItem.workItemId);
  fixture.board.close();

  const opened = await openRuns(fixture.path);
  try {
    assert.ok(opened.store.transaction(() => opened.runs.suspendActiveRunInTransaction(
      planning.run.runId,
      "stage cap exceeded: planning ran 901s (cap 900s)",
      { type: "system", id: "system:stage-cap" },
    )));
    assert.equal(opened.runtime.requireTask(planning.task!.taskId).status, "interrupted");
    assert.equal(opened.store.db.prepare("SELECT status FROM runs WHERE run_id=?")
      .get(planning.run.runId)?.status, "interrupted");
    const after = opened.runtime.requireWorkItem(workItem.workItemId);
    assert.deepEqual({ state: after.state, currentStage: after.currentStage, version: after.version }, {
      state: before.state,
      currentStage: before.currentStage,
      version: before.version,
    });
    assert.equal(opened.store.db.prepare(`
      SELECT COUNT(*) AS count FROM park_records
      WHERE work_item_id=? AND category='planning_run_failed'
    `).get(workItem.workItemId)?.count, 0);
  } finally {
    closeRuns(opened);
  }
});

test("suspending an active design run leaves the work item for the cap caller to park", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => "a".repeat(40) });
  const implementationType = {
    agentTypeId: "suspend-design-implementer",
    name: "Suspend design implementer",
    description: "Implements the hazardous plan after design.",
    role: "engineer" as const,
    supplementalInstructions: "Follow the confirmed design record.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  const verificationType = {
    ...implementationType,
    agentTypeId: "suspend-design-verifier",
    name: "Suspend design verifier",
    description: "Verifies the hazardous implementation.",
    role: "verifier" as const,
  };
  fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
    agentTypes: [implementationType, verificationType],
    stages: automationStages({
      implementation: { kind: "agent_type", agentTypeId: implementationType.agentTypeId },
      testing: { kind: "machine_verify" },
      verification: { kind: "agent_type", agentTypeId: verificationType.agentTypeId },
    }),
  }));
  const workItem = fixture.board.createWorkItemAndStartPlanning(workItemRequest({
    originalRequest: "Leave hazardous design state unchanged until the cap sweep parks it.",
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), "suspend-design-cap-composition").workItem;
  const planning = fixture.board.claimRun(fixture.manager.agentId, {
    claimId: "claim-plan-before-suspend-design-cap-composition",
    messageCursor: null,
  });
  assert.ok(planning);
  fixture.board.settleRun(planning.run.runId, fixture.manager.agentId, {
    outcome: "completed",
    result: "The hazardous plan is ready for design.",
    workflowPlan: hazardousSuspendPlan(),
  });
  const plan = fixture.board.projectWorkflow(fixture.project.projectId).plans.find(
    (candidate) => candidate.state === "proposed",
  );
  assert.ok(plan);
  fixture.board.confirmWorkflow(plan.planRevisionId, { expectedState: "proposed" });
  const design = fixture.board.claimRun(fixture.manager.agentId, {
    claimId: "claim-suspend-design-cap-composition",
    messageCursor: null,
  });
  assert.ok(design);
  assert.equal(design.context.design, true);
  const before = fixture.board.requireWorkItem(workItem.workItemId);
  fixture.board.close();

  const opened = await openRuns(fixture.path);
  try {
    assert.ok(opened.store.transaction(() => opened.runs.suspendActiveRunInTransaction(
      design.run.runId,
      "stage cap exceeded: planning ran 901s (cap 900s)",
      { type: "system", id: "system:stage-cap" },
    )));
    assert.equal(opened.runtime.requireTask(design.task!.taskId).status, "interrupted");
    assert.equal(opened.store.db.prepare("SELECT status FROM runs WHERE run_id=?")
      .get(design.run.runId)?.status, "interrupted");
    const after = opened.runtime.requireWorkItem(workItem.workItemId);
    assert.deepEqual({ state: after.state, currentStage: after.currentStage, version: after.version }, {
      state: before.state,
      currentStage: before.currentStage,
      version: before.version,
    });
    assert.equal(opened.store.db.prepare(`
      SELECT COUNT(*) AS count FROM park_records
      WHERE work_item_id=? AND category='design_run_failed'
    `).get(workItem.workItemId)?.count, 0);
  } finally {
    closeRuns(opened);
  }
});

test("a conflicting settle remains rejected after a human interruption", async () => {
  const fixture = await boardFixture();
  try {
    fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Rotate during work" }));
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-human-interrupt-conflict",
      messageCursor: null,
    });
    assert.ok(claim);
    fixture.board.rotateAgentToken(fixture.engineer.agentId, fixture.engineer.version);
    assert.throws(
      () => fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
        outcome: "completed",
        result: "This conflicts with the human interruption.",
      }),
      (error: unknown) => error instanceof TaskBoardError && error.status === 409 && error.code === "RUN_NOT_ACTIVE",
    );
  } finally {
    fixture.board.close();
  }
});

test("board pause state is redacted, round-trips, and bumps its CAS version on every accepted POST equivalent", async () => {
  const fixture = await boardFixture();
  try {
    assert.deepEqual(fixture.board.getBoardPause(), {
      paused: false,
      reason: null,
      version: 1,
      updatedAt: "1970-01-01T00:00:00.000Z",
      updatedBy: "system:steward-default",
    });
    const paused = fixture.board.setBoardPause({
      paused: true,
      reason: "Maintenance Authorization: Bearer secret-value",
      version: 1,
      actor: "human:alice",
    });
    assert.equal(paused.reason, "Maintenance Authorization: [redacted:bearer]");
    assert.equal(paused.version, 2);
    assert.equal(fixture.board.isBoardPaused(), true);
    assert.throws(
      () => fixture.board.setBoardPause({
        paused: false,
        reason: null,
        version: 1,
        actor: "human:alice",
      }),
      (error: unknown) => error instanceof Error &&
        "code" in error && error.code === "TASK_BOARD_BOARD_PAUSE_VERSION_CONFLICT",
    );
    const repeated = fixture.board.setBoardPause({
      paused: true,
      reason: null,
      version: paused.version,
      actor: "human:alice",
    });
    assert.equal(repeated.version, 3);
    assert.equal(repeated.paused, true);
    assert.equal(repeated.reason, null);
    const resumed = fixture.board.setBoardPause({
      paused: false,
      reason: null,
      version: repeated.version,
      actor: "human:alice",
    });
    assert.equal(resumed.version, 4);
    assert.equal(fixture.board.isBoardPaused(), false);
  } finally {
    fixture.board.close();
  }
});

test("resume emits for pending live wakeups and releases a claim parked behind the pause gate", async () => {
  const fixture = await boardFixture();
  try {
    fixture.board.createTask(fixture.project.projectId, taskRequest());
    const paused = fixture.board.setBoardPause({
      paused: true,
      reason: null,
      version: 1,
      actor: "human:alice",
    });
    assert.equal(fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-paused-immediate-direct",
      messageCursor: null,
    }), null);
    const heldClaim = fixture.board.waitToClaimRun(
      fixture.engineer.agentId,
      { claimId: "claim-paused-until-resume-direct", messageCursor: null },
      30_000,
      new AbortController().signal,
    );
    fixture.board.setBoardPause({
      paused: false,
      reason: null,
      version: paused.version,
      actor: "human:alice",
    });
    fixture.board.resumePausedWork();
    assert.ok(await within(heldClaim, 2_000));
  } finally {
    fixture.board.close();
  }
});

test("a persisted claim replay is held while paused and resumes without creating another run", async () => {
  const fixture = await boardFixture();
  try {
    fixture.board.createTask(fixture.project.projectId, taskRequest());
    const request = {
      claimId: "claim-paused-persisted-replay-direct",
      messageCursor: null,
    };
    const initial = fixture.board.claimRun(fixture.engineer.agentId, request);
    assert.ok(initial);
    const paused = fixture.board.setBoardPause({
      paused: true,
      reason: "Hold a persisted replay.",
      version: 1,
      actor: "human:alice",
    });

    assert.equal(fixture.board.claimRun(fixture.engineer.agentId, request), null);

    fixture.board.setBoardPause({
      paused: false,
      reason: null,
      version: paused.version,
      actor: "human:alice",
    });
    const replay = fixture.board.claimRun(fixture.engineer.agentId, request);
    assert.ok(replay);
    assert.equal(replay.run.runId, initial.run.runId);
    assert.equal(
      fixture.board.snapshot(fixture.project.projectId).recentRuns.filter((run) => run.claimId === request.claimId).length,
      1,
    );
  } finally {
    fixture.board.close();
  }
});

test("suspending a settled run is a null no-op", async () => {
  const fixture = await boardFixture();
  const task = fixture.board.createTask(fixture.project.projectId, taskRequest());
  const claim = fixture.board.claimRun(fixture.engineer.agentId, {
    claimId: "claim-settled-before-suspend",
    messageCursor: null,
  });
  assert.ok(claim);
  fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
    outcome: "completed",
    result: "Already complete.",
  });
  fixture.board.close();

  const opened = await openRuns(fixture.path);
  try {
    assert.equal(opened.store.transaction(() => opened.runs.suspendActiveRunInTransaction(
      claim.run.runId,
      "board paused: no-op",
      { type: "system", id: "system:kill-switch" },
    )), null);
    assert.equal(opened.runtime.requireTask(task.taskId).status, "completed");
  } finally {
    closeRuns(opened);
  }
});
