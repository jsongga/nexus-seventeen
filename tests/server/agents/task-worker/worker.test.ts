import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { WAKEUP_REASONS } from "#shared/task-board-contract";
import { TaskWorkerJournalStore } from "#server/agents/task-worker/journal";
import { estimateActivity, phaseActivity } from "#server/agents/task-worker/provider-activity";
import { emptyTaskWorkerJournal, parseBoundedAgentContext } from "#server/agents/task-worker/schema";
import { TaskWorker } from "#server/agents/task-worker/worker";
import type { AgentRunOutcome, AgentRunOutput, TaskWakeClaim, TaskWorkerJournal } from "#server/agents/task-worker/types";
import {
  AGENT,
  FakeBoard,
  FakeLauncher,
  NOW,
  TASK,
  claimed,
  completedOutcome,
  context,
  tempRoot,
  until,
} from "./helpers.js";

interface WorkerDiagnostic {
  readonly type: "lane_error_report_failed";
  readonly agentId: string;
  readonly workerId: string;
  readonly error: string;
}

async function worker(
  root: string,
  board: FakeBoard,
  launcher: FakeLauncher,
  logger?: (event: WorkerDiagnostic) => void,
): Promise<TaskWorker> {
  return TaskWorker.create({
    identity: { workerId: "worker-one", agentId: AGENT },
    statePath: join(root, "state", "journal.json"),
    board,
    launcher,
    longPollMs: 30_000,
    now: () => new Date(NOW),
    ...(logger === undefined ? {} : { logger }),
  });
}

function outputIdempotency(claim: TaskWakeClaim, index: number, output: AgentRunOutput): string {
  const digest = createHash("sha256").update(JSON.stringify({
    action: "append_task_worker_output",
    runId: claim.runId,
    wakeupId: claim.wakeupId,
    taskId: claim.taskId,
    localSequence: index + 1,
    output,
  })).digest("hex");
  return `twe_${digest}`;
}

async function completesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for completion")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("idle dispatch long-polls the board without starting a model process", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  const launcher = new FakeLauncher();
  const taskWorker = await worker(root, board, launcher);
  try {
    assert.equal(await taskWorker.dispatchOnce(), false);
    assert.equal(await taskWorker.dispatchOnce(), false);
    assert.equal(board.claimRequests.length, 2);
    assert.ok(board.claimRequests.every((request) => request.longPollMs === 30_000));
    assert.equal(launcher.requests.length, 0);
    assert.equal(board.outputs.length, 0);
    assert.equal(board.settlements.length, 0);
  } finally {
    await taskWorker.close();
  }
});

test("a pending-claim EIO rolls memory back and the retry persists before board claim I/O", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  launcher.outcomes.push(completedOutcome());
  const persistedClaimIds = new Set<string>();
  const originalSave = TaskWorkerJournalStore.prototype.save;
  let failedPendingSave = false;
  TaskWorkerJournalStore.prototype.save = async function saveWithOneEio(value) {
    const isPendingIntent = value.pendingClaim !== null && value.active === null;
    if (isPendingIntent && !failedPendingSave) {
      failedPendingSave = true;
      throw Object.assign(new Error("Simulated pending-claim journal EIO"), { code: "EIO" });
    }
    await originalSave.call(this, value);
    if (isPendingIntent && value.pendingClaim !== null) persistedClaimIds.add(value.pendingClaim.claimId);
  };
  board.onClaim = (request) => {
    assert.equal(persistedClaimIds.has(request.claimId), true, "claim intent must be durable before board I/O");
  };

  const taskWorker = await worker(root, board, launcher);
  try {
    await assert.rejects(taskWorker.dispatchOnce(), /pending-claim journal EIO/u);
    assert.equal(board.claimRequests.length, 0);
    assert.equal(taskWorker.hasActiveClaim(), false);

    assert.equal(await taskWorker.dispatchOnce(), true);
    assert.equal(board.claimRequests.length, 1);
    assert.equal(launcher.requests.length, 1);
  } finally {
    TaskWorkerJournalStore.prototype.save = originalSave;
    await taskWorker.close();
  }
});

test("restart after a pending-claim EIO cannot inherit an orphaned board-side claim", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  const originalSave = TaskWorkerJournalStore.prototype.save;
  let failedPendingSave = false;
  TaskWorkerJournalStore.prototype.save = async function saveWithOneEio(value) {
    if (value.pendingClaim !== null && value.active === null && !failedPendingSave) {
      failedPendingSave = true;
      throw Object.assign(new Error("Simulated pending-claim journal EIO"), { code: "EIO" });
    }
    await originalSave.call(this, value);
  };

  const first = await worker(root, board, new FakeLauncher());
  try {
    await assert.rejects(first.dispatchOnce(), /pending-claim journal EIO/u);
    assert.equal(board.claimRequests.length, 0, "the failed process never created a board-side claim");
  } finally {
    TaskWorkerJournalStore.prototype.save = originalSave;
    await first.close();
  }

  const launcher = new FakeLauncher();
  launcher.outcomes.push(completedOutcome());
  const restarted = await worker(root, board, launcher);
  try {
    assert.equal(await restarted.dispatchOnce(), true);
    assert.equal(board.claimRequests.length, 1);
    assert.equal(launcher.requests.length, 1);
  } finally {
    await restarted.close();
  }
});

test("area memory accepts only compact ordered prior-task results", () => {
  const recent = {
    taskId: "task-recent",
    title: "Recent checkout finding",
    result: "Retry behavior is now understood.",
    endedAt: "2026-07-19T19:45:00.000Z",
  };
  const older = {
    taskId: "task-older",
    title: "Older checkout finding",
    result: "The charge boundary was located.",
    endedAt: "2026-07-19T19:30:00.000Z",
  };
  const parsed = parseBoundedAgentContext(context({ areaMemory: [recent, older] }));
  assert.deepEqual(parsed.areaMemory, [recent, older]);

  assert.throws(
    () => parseBoundedAgentContext(context({ areaMemory: [{ ...recent, taskId: TASK }] })),
    /current task/u,
  );
  assert.throws(
    () => parseBoundedAgentContext(context({ areaMemory: [older, recent] })),
    /ordering/u,
  );
  assert.throws(
    () => parseBoundedAgentContext(context({
      areaMemory: Array.from({ length: 9 }, (_, index) => ({
        taskId: "task-memory-" + index,
        title: "Prior task " + index,
        result: "Prior result " + index,
        endedAt: new Date(Date.parse("2026-07-19T19:45:00.000Z") - index * 60_000).toISOString(),
      })),
    })),
    /area memory/u,
  );
  assert.throws(
    () => parseBoundedAgentContext(context({ areaMemory: [{ ...recent, result: "x".repeat(1_001) }] })),
    /result/u,
  );
  assert.throws(
    () => parseBoundedAgentContext({
      ...context({ areaMemory: [] }),
      areaMemory: [{ ...recent, transcript: "Raw provider content must not enter memory." }],
    }),
    /unexpected or missing fields/u,
  );
});

for (const reason of WAKEUP_REASONS.filter((candidate) => candidate !== "workflow_handoff")) {
  test(`launches exactly one one-shot agent for ${reason}`, async () => {
    const root = await tempRoot();
    const board = new FakeBoard();
    board.queued.push((request) => claimed(request, { reason }));
    const launcher = new FakeLauncher();
    launcher.outcomes.push(completedOutcome());
    const taskWorker = await worker(root, board, launcher);
    try {
      assert.equal(await taskWorker.dispatchOnce(), true);
      assert.equal(launcher.requests.length, 1);
      assert.equal(launcher.requests[0]?.wakeReason, reason);
      assert.equal(board.outputs.length, 3);
      assert.deepEqual(board.outputs.map((item) => item.output.type), ["progress", "proposed_child_task", "result"]);
      assert.equal(board.settlements.length, 1);
      assert.equal(board.settlements[0]?.outcome, "completed");
      assert.equal(board.settlements[0]?.result, "Customers can retry checkout safely.");
      assert.equal(taskWorker.snapshot.activeRunId, null);
      assert.equal(taskWorker.snapshot.completedRuns, 1);
    } finally {
      await taskWorker.close();
    }
  });
}

test("launches a workflow handoff only for a manager review with completed parent evidence", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request, {
    reason: "workflow_handoff",
    context: context({
      mission: {
        role: "manager",
        area: "Checkout review",
        mission: "Review completed engineer work before the human production check.",
      },
      task: {
        ...context().task,
        kind: "manager_review",
        requiredRole: "manager",
      },
    }),
  }));
  const launcher = new FakeLauncher();
  launcher.outcomes.push(completedOutcome("The engineer evidence is ready for a human decision."));
  const taskWorker = await worker(root, board, launcher);
  try {
    assert.equal(await taskWorker.dispatchOnce(), true);
    assert.equal(launcher.requests.length, 1);
    assert.equal(launcher.requests[0]?.wakeReason, "workflow_handoff");
    assert.equal(board.settlements[0]?.outcome, "completed");
  } finally {
    await taskWorker.close();
  }
});

for (const malformed of [
  {
    label: "work task",
    overrides: { task: { ...context().task, kind: "work" as const, requiredRole: null } },
  },
  {
    label: "non-manager mission",
    overrides: { mission: { ...context().mission, role: "engineer" } },
  },
  {
    label: "missing manager requirement",
    overrides: { task: { ...context().task, kind: "manager_review" as const, requiredRole: null } },
  },
  {
    label: "missing completed parent evidence",
    overrides: { parentEvidence: null },
  },
] as const) {
  test(`rejects a workflow handoff with ${malformed.label} without launching`, async () => {
    const root = await tempRoot();
    const board = new FakeBoard();
    const base = context({
      mission: {
        role: "manager",
        area: "Checkout review",
        mission: "Review completed engineer work before the human production check.",
      },
      task: {
        ...context().task,
        kind: "manager_review",
        requiredRole: "manager",
      },
    });
    board.queued.push((request) => claimed(request, {
      reason: "workflow_handoff",
      context: context({ ...base, ...malformed.overrides }),
    }));
    const launcher = new FakeLauncher();
    const taskWorker = await worker(root, board, launcher);
    try {
      assert.equal(await taskWorker.dispatchOnce(), true);
      assert.equal(launcher.requests.length, 0);
      assert.equal(board.settlements[0]?.outcome, "failed");
      assert.match(board.settlements[0]?.result ?? "", /Workflow handoff/u);
    } finally {
      await taskWorker.close();
    }
  });
}

test("records idempotent live activity before terminal output and settlement", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  const taskWorker = await worker(root, board, launcher);
  try {
    const dispatch = taskWorker.dispatchOnce();
    await until(() => launcher.handles.length === 1, "agent launch");
    const handle = launcher.handles[0];
    assert.ok(handle);

    board.appendFailures = 1;
    handle.emitActivity("Agent process started.");
    await until(() => board.outputs.length === 1, "live activity output");

    assert.equal(taskWorker.snapshot.activePhase, "running");
    assert.equal(board.settlements.length, 0);
    assert.deepEqual(board.outputs[0]?.output, { type: "progress", body: "Agent process started." });
    assert.match(board.outputs[0]?.idempotencyKey ?? "", /^twa_[a-f0-9]{64}$/u);
    assert.equal(board.appendAttempts.length, 2);
    assert.equal(board.appendAttempts[0]?.idempotencyKey, board.appendAttempts[1]?.idempotencyKey);

    handle.resolve(completedOutcome());
    await dispatch;

    assert.deepEqual(
      board.outputs.map((item) => item.output.type),
      ["progress", "progress", "proposed_child_task", "result"],
    );
    assert.equal(board.settlements[0]?.outcome, "completed");
  } finally {
    await taskWorker.close();
  }
});

test("structured phase markers replace inference without creating an interleaved phase stream", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  const taskWorker = await worker(root, board, launcher);
  try {
    const dispatch = taskWorker.dispatchOnce();
    await until(() => launcher.handles.length === 1, "agent launch");
    const handle = launcher.handles[0];
    assert.ok(handle);

    await until(() => board.phaseCreates.length === 1 && board.phaseUpdates.length === 1, "initial live phase");
    assert.deepEqual(
      { title: board.phaseCreates[0]?.title, stage: board.phaseCreates[0]?.stage },
      { title: "Review task", stage: "research" },
    );
    assert.equal(board.phaseUpdates[0]?.status, "in_progress");

    handle.emitActivity("Preparing the implementation plan.");
    await until(() => board.phaseCreates.length === 2, "planning phase");
    assert.equal(board.phaseCreates[1]?.stage, "planning");
    assert.ok(board.phaseUpdates.some((update) => (
      update.phase.stage === "research" && update.stage === undefined && update.status === "completed"
    )));

    handle.emitActivity(estimateActivity(60));
    await until(() => board.estimateUpdates.length === 1, "live estimate");
    assert.equal(board.estimateUpdates[0]?.expectedAgentMinutes, 60);
    assert.equal(board.settlements.length, 0, "live state is visible before terminal settlement");

    handle.emitActivity("Running a development check.");
    await until(() => board.phaseCreates.length === 3, "inferred testing phase");
    assert.equal(board.phaseCreates[2]?.stage, "testing");

    handle.emitActivity(phaseActivity({
      key: "api",
      title: "Implement retry API",
      stage: "execution",
      status: "in_progress",
      parallelGroup: "delivery",
    }));
    handle.emitActivity(phaseActivity({
      key: "tests",
      title: "Verify retry API",
      stage: "testing",
      status: "in_progress",
      parallelGroup: "delivery",
    }));
    await until(() => board.phaseCreates.length === 4, "parallel live phases");
    assert.ok(board.phaseUpdates.some((update) => (
      update.phase.phaseId === "phase-3" && update.title === "Implement retry API" &&
      update.stage === "execution" && update.parallelGroup === "delivery"
    )), "the marker replaces the transport-inferred testing phase");
    assert.equal(board.phaseCreates[3]?.parallelGroup, "delivery");
    assert.equal(board.settlements.length, 0, "parallel phases are visible before terminal settlement");

    const activityCount = board.outputs.length;
    handle.emitActivity("Updating the implementation.");
    await until(() => board.outputs.length === activityCount + 1, "post-marker provider activity");
    assert.equal(board.phaseCreates.length, 4, "inference stays disabled after structured telemetry begins");
    const outcome = completedOutcome("Customers can retry without duplicate work.");
    handle.resolve({
      ...outcome,
      expectedAgentMinutes: 60,
      phases: [
        {
          phaseId: null,
          title: "Implement retry guard",
          stage: "execution",
          status: "completed",
          parallelGroup: "terminal-delivery",
          orderKey: 100,
        },
        {
          phaseId: null,
          title: "Verify retry behavior",
          stage: "testing",
          status: "completed",
          parallelGroup: "terminal-delivery",
          orderKey: 200,
        },
      ],
    });
    await dispatch;

    assert.equal(board.estimateUpdates.length, 1, "terminal output does not repeat the live estimate");
    assert.deepEqual(board.phaseCreates.slice(-2).map((phase) => phase.parallelGroup), ["terminal-delivery", "terminal-delivery"]);
    assert.ok(board.phaseUpdates.some((update) => update.orderKey === 100 && update.status === "completed"));
    assert.ok(board.phaseUpdates.some((update) => update.orderKey === 200 && update.status === "completed"));
    assert.equal(board.settlements[0]?.outcome, "completed");
  } finally {
    await taskWorker.close();
  }
});

test("repeated and parallel live phases append history without rewriting a completed cycle", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  const taskWorker = await worker(root, board, launcher);
  try {
    const dispatch = taskWorker.dispatchOnce();
    await until(() => launcher.handles.length === 1, "agent launch");
    const handle = launcher.handles[0];
    assert.ok(handle);

    handle.emitActivity(phaseActivity({
      key: "cycle-1-execution",
      title: "First implementation cycle",
      stage: "execution",
      status: "in_progress",
      parallelGroup: null,
    }));
    await until(() => board.phaseUpdates.some((update) => (
      update.phase.phaseId === "phase-1" && update.stage === "execution"
    )), "first cycle phase");
    assert.equal(board.phaseCreates.length, 1, "the first marker adopts the inferred phase");
    const firstCycleId = "phase-1";
    handle.emitActivity(phaseActivity({
      key: "cycle-1-execution",
      title: "First implementation cycle",
      stage: "execution",
      status: "completed",
      parallelGroup: null,
    }));
    await until(() => board.phaseUpdates.some((update) => (
      update.phase.phaseId === firstCycleId && update.status === "completed"
    )), "first cycle completion");
    const firstCycleMutationCount = board.phaseUpdates.filter((update) => (
      update.phase.phaseId === firstCycleId
    )).length;

    handle.emitActivity(phaseActivity({
      key: "cycle-1-execution",
      title: "An invalid attempt to reuse completed history",
      stage: "planning",
      status: "in_progress",
      parallelGroup: null,
    }));
    handle.emitActivity(phaseActivity({
      key: "cycle-2-planning",
      title: "Second planning cycle",
      stage: "planning",
      status: "in_progress",
      parallelGroup: null,
    }));
    await until(() => board.phaseCreates.length === 2, "second cycle phase");
    assert.equal(board.phaseCreates[1]?.title, "Second planning cycle");
    assert.equal(board.phaseCreates[1]?.stage, "planning");

    handle.emitActivity(phaseActivity({
      key: "cycle-2-api",
      title: "Parallel API pass",
      stage: "execution",
      status: "in_progress",
      parallelGroup: "cycle-2-delivery",
    }));
    handle.emitActivity(phaseActivity({
      key: "cycle-2-tests",
      title: "Parallel test pass",
      stage: "testing",
      status: "in_progress",
      parallelGroup: "cycle-2-delivery",
    }));
    await until(() => board.phaseCreates.length === 4, "parallel cycle phases");
    assert.deepEqual(
      board.phaseCreates.slice(-2).map((phase) => phase.parallelGroup),
      ["cycle-2-delivery", "cycle-2-delivery"],
    );

    handle.resolve(completedOutcome("The second loop passed its parallel implementation and test work."));
    await dispatch;
    const firstCycleMutations = board.phaseUpdates.filter((update) => update.phase.phaseId === firstCycleId);
    assert.equal(firstCycleMutations.length, firstCycleMutationCount, "the completed first cycle was not rewritten");
    assert.ok(board.phaseUpdates.every((update) => update.stage !== "done"));
    assert.equal(board.settlements[0]?.outcome, "completed");
  } finally {
    await taskWorker.close();
  }
});

test("a stale estimate CAS does not turn completed work into a failed task", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  board.estimateFailures = 1;
  const launcher = new FakeLauncher();
  launcher.outcomes.push({ ...completedOutcome(), expectedAgentMinutes: 45 });
  const taskWorker = await worker(root, board, launcher);
  try {
    await taskWorker.dispatchOnce();
    assert.equal(board.estimateUpdates.length, 1);
    assert.equal(board.settlements[0]?.outcome, "completed");
    assert.equal(board.settlements[0]?.result, "Customers can retry checkout safely.");
  } finally {
    await taskWorker.close();
  }
});

test("never launches for a non-human wake reason", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request, { reason: "scheduler_tick" }));
  const launcher = new FakeLauncher();
  const taskWorker = await worker(root, board, launcher);
  try {
    await taskWorker.dispatchOnce();
    assert.equal(launcher.requests.length, 0);
    assert.equal(board.settlements[0]?.outcome, "failed");
    assert.match(board.settlements[0]?.result ?? "", /not human-authorized/u);
  } finally {
    await taskWorker.close();
  }
});

test("a human question is the last output and atomically ends the run without general settlement", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  launcher.outcomes.push({
    status: "waiting_for_human",
    outputs: [
      { type: "progress", body: "The implementation is blocked on product policy." },
      { type: "human_question", question: "Should retries remain enabled after a fraud rejection?" },
    ],
    expectedAgentMinutes: 45,
    phases: [],
    detail: "Waiting for the product owner to choose retry policy.",
  });
  const taskWorker = await worker(root, board, launcher);
  try {
    await taskWorker.dispatchOnce();
    assert.deepEqual(board.outputs.map((item) => item.output.type), ["progress", "human_question"]);
    assert.equal(board.settlements.length, 0);
    assert.equal(taskWorker.snapshot.activeRunId, null);
  } finally {
    await taskWorker.close();
  }
});

test("normalizes every provider-authored carriage return before board writes", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  launcher.outcomes.push({
    status: "completed",
    outputs: [
      { type: "progress", body: "First check passed.\r\nSecond check passed.\rThird check passed." },
      {
        type: "proposed_child_task",
        title: "Observe retries\r\nin production",
        objective: "Confirm the retry rate.\rConfirm customer impact.",
        acceptanceCriteria: ["Retry rate is visible.\r\nAlerts are configured."],
      },
      { type: "result", body: "Checkout is safe.\r\nFocused tests pass.\rReady for review." },
    ],
    expectedAgentMinutes: null,
    phases: [{
      phaseId: null,
      title: "Verify retries\r\nunder load",
      stage: "testing",
      status: "completed",
      parallelGroup: null,
      orderKey: 100,
    }],
    detail: "Checkout is safe.\r\nFocused tests pass.",
    handoff: {
      outcome: "passed",
      summary: "Implementation passed.\r\nEvidence follows.",
      evidence: ["Unit tests pass.\rRuntime tests pass."],
      artifactIds: [],
      acceptanceCriteria: [{
        criterion: "Retries are safe.\r\nCustomers are protected.",
        passed: true,
        evidence: "The focused tests pass.\rNo duplicate charge was observed.",
      }],
      blockers: ["Release still requires\r\nhuman approval."],
      recommendedReturnStage: null,
    },
    workflowPlan: {
      objective: "Keep checkout safe.\r\nWatch retries.",
      assumptions: ["Operators can view metrics.\rAlerts are enabled."],
      acceptanceCriteria: ["No duplicate charges.\r\nRetries remain observable."],
      nodes: [{
        nodeId: "observe-retries",
        title: "Observe retries\r\nafter release",
        objective: "Watch customer impact.\rEscalate regressions.",
        acceptanceCriteria: ["Retry health stays visible.\r\nNo regression is found."],
        dependencyNodeIds: [],
        stageTemplate: ["verification"],
      }],
    },
  });
  const taskWorker = await worker(root, board, launcher);
  try {
    await taskWorker.dispatchOnce();
    const outbound = JSON.stringify({
      outputs: board.outputs,
      phaseCreates: board.phaseCreates,
      phaseUpdates: board.phaseUpdates,
      settlements: board.settlements,
    });
    assert.doesNotMatch(outbound, /\\r/u);
    assert.equal(
      board.settlements[0]?.result,
      "Checkout is safe.\nFocused tests pass.\nReady for review.",
    );
  } finally {
    await taskWorker.close();
  }
});

test("a human answer is included in the next bounded one-shot context", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request, {
    reason: "human_answer",
    context: context({
      messagesSinceCursor: request.messageCursors[TASK] ?? null,
      triggerQuestion: {
        questionId: "question-one",
        question: "Should retries remain enabled after a fraud rejection?",
        answer: "No. Stop after a fraud rejection and explain the next step.",
      },
    }),
  }));
  const launcher = new FakeLauncher();
  launcher.outcomes.push(completedOutcome());
  const taskWorker = await worker(root, board, launcher);
  try {
    await taskWorker.dispatchOnce();
    assert.equal(
      launcher.requests[0]?.context.triggerQuestion?.answer,
      "No. Stop after a fraud rejection and explain the next step.",
    );
  } finally {
    await taskWorker.close();
  }
});

test("durable board interrupt reaches the process directly and settles interrupted", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  const taskWorker = await worker(root, board, launcher);
  try {
    const dispatch = taskWorker.dispatchOnce();
    await until(() => launcher.handles.length === 1, "agent launch");
    const claim = board.claimRequests[0];
    assert.ok(claim);
    board.requestInterrupt(claimed(claim).claim, "Human stopped the run to revise scope");
    await dispatch;
    assert.deepEqual(launcher.handles[0]?.interruptReasons, ["Human stopped the run to revise scope"]);
    assert.equal(board.settlements[0]?.outcome, "interrupted");
    assert.equal(taskWorker.snapshot.activeRunId, null);
  } finally {
    await taskWorker.close();
  }
});

test("redacts credentials from a durable interrupt reason while still terminating the run", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  const taskWorker = await worker(root, board, launcher);
  try {
    const dispatch = taskWorker.dispatchOnce();
    await until(() => launcher.handles.length === 1, "agent launch");
    const claim = board.claimRequests[0];
    assert.ok(claim);
    board.requestInterrupt(claimed(claim).claim, "Stop after exposing sk-proj-0123456789abcdef in diagnostics");
    await dispatch;
    assert.deepEqual(
      launcher.handles[0]?.interruptReasons,
      ["Stop after exposing [redacted] in diagnostics"],
    );
    assert.equal(board.settlements[0]?.result, "Stop after exposing [redacted] in diagnostics");
    const journal = await readFile(join(root, "state", "journal.json"), "utf8");
    assert.doesNotMatch(journal, /sk-proj-0123456789abcdef/u);
    assert.match(journal, /\[redacted\]/u);
  } finally {
    await taskWorker.close();
  }
});

test("starts process-group termination before an interrupt journal write can reject", async () => {
  const root = await tempRoot();
  const stateDirectory = join(root, "state");
  const movedStateDirectory = join(root, "state-before-journal-failure");
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  const taskWorker = await worker(root, board, launcher);
  let releaseInterrupt: (() => void) | undefined;
  let dispatch: Promise<boolean> | undefined;
  try {
    dispatch = taskWorker.dispatchOnce();
    await until(() => launcher.handles.length === 1, "agent launch");
    await until(() => taskWorker.snapshot.activePhase === "running", "running journal state");
    const handle = launcher.handles[0];
    assert.ok(handle);
    handle.emitActivity("Agent process started.");
    await until(() => board.outputs.length === 1, "live activity forwarding");
    handle.interruptBarrier = new Promise<void>((resolve) => { releaseInterrupt = resolve; });

    await rename(stateDirectory, movedStateDirectory);
    await writeFile(stateDirectory, "This file makes journal child paths fail with ENOTDIR.");
    const interruption = taskWorker.interrupt("Human stopped the run").then(
      () => ({ status: "fulfilled" as const, error: null }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await until(() => handle.interruptReasons.length === 1, "termination independent of journal persistence");
    await unlink(stateDirectory);
    await rename(movedStateDirectory, stateDirectory);
    assert.ok(releaseInterrupt);
    releaseInterrupt();

    const result = await interruption;
    assert.equal(result.status, "rejected");
    assert.match(result.error instanceof Error ? result.error.message : "", /directory|ENOTDIR/u);
    await dispatch;
    assert.equal(board.settlements[0]?.outcome, "interrupted");
  } finally {
    await unlink(stateDirectory).catch(() => undefined);
    await rename(movedStateDirectory, stateDirectory).catch(() => undefined);
    releaseInterrupt?.();
    launcher.handles[0]?.reject(new Error("Test cleanup stopped the simulated child"));
    await dispatch?.catch(() => undefined);
    await taskWorker.close();
  }
});

test("shares concurrent interrupt settlement and retries only after the in-flight attempt rejects", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  const taskWorker = await worker(root, board, launcher);
  try {
    const dispatch = taskWorker.dispatchOnce();
    await until(() => launcher.handles.length === 1, "agent launch");
    await until(() => taskWorker.snapshot.activePhase === "running", "running journal state");
    const handle = launcher.handles[0];
    assert.ok(handle);
    handle.emitActivity("Agent process started.");
    await until(() => board.outputs.length === 1, "live activity forwarding");
    let releaseInterrupt!: () => void;
    handle.interruptBarrier = new Promise<void>((resolve) => { releaseInterrupt = resolve; });
    handle.interruptFailures = 1;

    const first = taskWorker.interrupt("Human stopped the run");
    const concurrent = taskWorker.interrupt("Human stopped the run");
    await until(() => handle.interruptReasons.length === 1, "one in-flight termination attempt");
    releaseInterrupt();
    await Promise.all([
      assert.rejects(first, /termination failure/u),
      assert.rejects(concurrent, /termination failure/u),
    ]);
    assert.deepEqual(handle.interruptReasons, ["Human stopped the run"]);

    handle.interruptBarrier = null;
    assert.equal(await taskWorker.interrupt("Human stopped the run"), true);
    await dispatch;

    assert.deepEqual(handle.interruptReasons, ["Human stopped the run", "Human stopped the run"]);
    assert.equal(board.settlements[0]?.outcome, "interrupted");
  } finally {
    await taskWorker.close();
  }
});

test("shutdown records a rejected termination and completes while the child remains non-exiting", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  const taskWorker = await worker(root, board, launcher);
  const controller = new AbortController();
  try {
    const running = taskWorker.run(controller.signal);
    await until(() => launcher.handles.length === 1, "agent launch");
    await until(() => taskWorker.snapshot.activePhase === "running", "running journal state");
    const handle = launcher.handles[0];
    assert.ok(handle);
    handle.emitActivity("Agent process started.");
    await until(() => board.outputs.length === 1, "live activity forwarding");
    handle.interruptFailures = 1;
    handle.interruptFailureMessage = "Simulated process-group termination failure after Bearer abc123def456";

    controller.abort();
    await until(() => handle.interruptReasons.length === 1, "shutdown interrupt attempt");
    await completesWithin(running, 500);
    assert.equal(board.settlements[0]?.outcome, "interrupted");
    assert.match(board.settlements[0]?.result ?? "", /process-group termination failed.*simulated/iu);
    assert.match(board.settlements[0]?.result ?? "", /Bearer \[redacted\]/u);
    const journal = await readFile(join(root, "state", "journal.json"), "utf8");
    assert.match(journal, /process-group termination failed.*simulated/iu);
    assert.doesNotMatch(journal, /abc123def456/u);
    assert.doesNotMatch(journal, /\r/u);
  } finally {
    launcher.handles[0]?.reject(new Error("Test cleanup stopped the simulated child"));
    await taskWorker.close();
  }
});

test("an interrupt during prelaunch phase persistence prevents the model from starting", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  let releasePhase!: () => void;
  board.phaseCreateBarrier = new Promise<void>((resolve) => { releasePhase = resolve; });
  const launcher = new FakeLauncher();
  const taskWorker = await worker(root, board, launcher);
  try {
    const dispatch = taskWorker.dispatchOnce();
    await until(() => board.phaseCreates.length === 1, "prelaunch phase request");
    const claimRequest = board.claimRequests[0];
    assert.ok(claimRequest);
    board.requestInterrupt(claimed(claimRequest).claim, "Human revised the task before launch");
    await until(() => taskWorker.snapshot.interruptReason !== null, "durable prelaunch interrupt");
    releasePhase();
    await dispatch;
    assert.equal(launcher.requests.length, 0);
    assert.equal(board.settlements[0]?.outcome, "interrupted");
  } finally {
    releasePhase();
    await taskWorker.close();
  }
});

test("one worker never claims or launches a second run while its agent is active", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push(
    (request) => claimed(request, { runId: "run-one", wakeupId: "wake-one" }),
    (request) => claimed(request, { runId: "run-two", wakeupId: "wake-two" }),
  );
  const launcher = new FakeLauncher();
  const taskWorker = await worker(root, board, launcher);
  try {
    const first = taskWorker.dispatchOnce();
    await until(() => launcher.handles.length === 1, "first agent run");
    assert.equal(await taskWorker.dispatchOnce(), false);
    assert.equal(board.claimRequests.length, 1);
    assert.equal(launcher.requests.length, 1);
    launcher.handles[0]?.resolve(completedOutcome("First run completed."));
    await first;
    launcher.outcomes.push(completedOutcome("Second run completed."));
    assert.equal(await taskWorker.dispatchOnce(), true);
    assert.equal(launcher.requests.length, 2);
  } finally {
    await taskWorker.close();
  }
});

test("retries the exact durable claim ID and cursor after a lost response", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.claimFailures = 1;
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  launcher.outcomes.push(completedOutcome());
  const first = await worker(root, board, launcher);
  await assert.rejects(first.dispatchOnce(), /lost claim response/u);
  await first.close();

  const restarted = await worker(root, board, launcher);
  try {
    await restarted.dispatchOnce();
    assert.equal(board.claimRequests.length, 2);
    assert.equal(board.claimRequests[1]?.claimId, board.claimRequests[0]?.claimId);
    assert.deepEqual(board.claimRequests[1]?.messageCursors, board.claimRequests[0]?.messageCursors);
    assert.equal(launcher.requests.length, 1);
  } finally {
    await restarted.close();
  }
});

test("recovery clears last_error only after the durable claim replay validates", async () => {
  const root = await tempRoot();
  const statePath = join(root, "state", "journal.json");
  const identity = { workerId: "worker-one", agentId: AGENT };
  const request = {
    agentId: AGENT,
    claimId: "claim-recovery-clear",
    messageCursors: { [TASK]: 2 },
    longPollMs: 0,
  };
  const activeClaim = claimed(request).claim;
  const store = await TaskWorkerJournalStore.open(statePath, identity);
  await store.save({
    ...emptyTaskWorkerJournal(identity),
    messageCursors: { [TASK]: 2 },
    active: {
      claim: activeClaim,
      phase: "claimed",
      contextDigest: null,
      launchStartedAt: null,
      interruptReason: null,
      outcome: null,
      nextOutputIndex: 0,
    },
  });
  await store.close();

  const board = new FakeBoard();
  board.claimFailures = 1;
  board.queued.push((replayRequest) => claimed(replayRequest));
  const launcher = new FakeLauncher();
  launcher.outcomes.push(completedOutcome());
  const restarted = await worker(root, board, launcher);
  try {
    await assert.rejects(restarted.dispatchOnce(), /lost claim response/u);
    assert.equal(board.laneErrors.length, 0, "a failed replay must preserve the real lane error");
    assert.equal(launcher.requests.length, 0);

    assert.equal(await restarted.dispatchOnce(), true);
    assert.deepEqual(board.laneErrors.map((entry) => entry.detail), [null]);
    assert.equal(launcher.requests.length, 1);
  } finally {
    await restarted.close();
  }
});

test("replays pending outputs after restart without launching the model again", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.appendFailures = 1;
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  launcher.outcomes.push(completedOutcome());
  const first = await worker(root, board, launcher);
  await assert.rejects(first.dispatchOnce(), /lost output response/u);
  assert.equal(launcher.requests.length, 1);
  await first.close();

  const restarted = await worker(root, board, launcher);
  try {
    await restarted.dispatchOnce();
    assert.equal(launcher.requests.length, 1);
    assert.equal(board.appendAttempts.length, 4);
    assert.equal(board.appendAttempts[1]?.idempotencyKey, board.appendAttempts[0]?.idempotencyKey);
    assert.equal(board.settlements.length, 1);
  } finally {
    await restarted.close();
  }
});

test("replays a CR-bearing journal with its pre-normalization identity without duplicating the board event", async () => {
  const root = await tempRoot();
  const statePath = join(root, "state", "journal.json");
  const identity = { workerId: "worker-one", agentId: AGENT };
  const request = { agentId: AGENT, claimId: "claim-poison-pill", messageCursors: {}, longPollMs: 0 };
  const activeClaim = claimed(request).claim;
  const proposal = {
    type: "proposed_child_task" as const,
    title: "Observe retries\r\nin production",
    objective: "Confirm retry behavior.\rEscalate regressions.",
    acceptanceCriteria: ["The board records one proposal.\r\nThe event identity is stable."],
  };
  const outcome: AgentRunOutcome = {
    status: "completed",
    outputs: [proposal, { type: "result", body: "Recovered result can settle." }],
    expectedAgentMinutes: null,
    phases: [],
    detail: "Recovered result can settle.",
  };
  const expectedClientEventId = outputIdempotency(activeClaim, 0, proposal);
  const store = await TaskWorkerJournalStore.open(statePath, identity);
  await store.save({
    ...emptyTaskWorkerJournal(identity),
    active: {
      claim: activeClaim,
      phase: "outputs_pending",
      contextDigest: `sha256:${"b".repeat(64)}`,
      launchStartedAt: NOW,
      interruptReason: null,
      outcome,
      nextOutputIndex: 0,
    },
  });
  await store.close();

  const board = new FakeBoard();
  const launcher = new FakeLauncher();
  board.appendFailures = 1;
  const firstReplay = await worker(root, board, launcher);
  await assert.rejects(firstReplay.dispatchOnce(), /lost output response/u);
  await firstReplay.close();

  const restarted = await worker(root, board, launcher);
  try {
    await restarted.dispatchOnce();
    assert.equal(launcher.requests.length, 0);
    const proposalAttempts = board.appendAttempts.filter((attempt) => attempt.output.type === "proposed_child_task");
    assert.equal(proposalAttempts.length, 2);
    assert.ok(proposalAttempts.every((attempt) => attempt.idempotencyKey === expectedClientEventId));
    assert.equal(board.outputs.filter((item) => item.output.type === "proposed_child_task").length, 1);
    assert.equal(board.settlements[0]?.result, "Recovered result can settle.");
    assert.doesNotMatch(JSON.stringify({ outputs: board.outputs, settlements: board.settlements }), /\\r/u);
  } finally {
    await restarted.close();
  }
});

test("does not duplicate a model process after restart beyond the durable launch boundary", async () => {
  const root = await tempRoot();
  const statePath = join(root, "state", "journal.json");
  const identity = { workerId: "worker-one", agentId: AGENT };
  const request = { agentId: AGENT, claimId: "claim-recovery", messageCursors: {}, longPollMs: 0 };
  const activeClaim = claimed(request).claim;
  const store = await TaskWorkerJournalStore.open(statePath, identity);
  const seeded: TaskWorkerJournal = {
    ...emptyTaskWorkerJournal(identity),
    messageCursors: { "task-one": 2 },
    active: {
      claim: activeClaim,
      phase: "launch_started",
      contextDigest: `sha256:${"a".repeat(64)}`,
      launchStartedAt: NOW,
      interruptReason: null,
      outcome: null,
      nextOutputIndex: 0,
    },
  };
  await store.save(seeded);
  await store.close();

  const board = new FakeBoard();
  const launcher = new FakeLauncher();
  const restarted = await worker(root, board, launcher);
  try {
    await restarted.dispatchOnce();
    assert.equal(launcher.requests.length, 0);
    assert.equal(board.settlements[0]?.outcome, "failed");
    assert.match(board.settlements[0]?.result ?? "", /refusing to launch a duplicate/u);
  } finally {
    await restarted.close();
  }
});

test("message cursor advances once and bounds the next human-triggered context", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push(
    (request) => claimed(request, { context: context({ messagesSinceCursor: null, nextMessageCursor: 2 }) }),
    (request) => claimed(request, {
      reason: "human_resume",
      runId: "run-two",
      wakeupId: "wake-two",
      context: context({ messagesSinceCursor: 2, nextMessageCursor: 3, messages: [{
        messageId: "message-three",
        cursor: 3,
        author: "human",
        body: "Please also cover the timeout edge case.",
        createdAt: NOW,
      }] }),
    }),
  );
  const launcher = new FakeLauncher();
  launcher.outcomes.push(completedOutcome(), completedOutcome());
  const taskWorker = await worker(root, board, launcher);
  try {
    await taskWorker.dispatchOnce();
    await taskWorker.dispatchOnce();
    assert.equal(board.claimRequests[1]?.messageCursors["task-one"], 2);
    assert.equal(launcher.requests[1]?.context.messagesSinceCursor, 2);
    assert.deepEqual(launcher.requests[1]?.context.messages.map((message) => message.cursor), [3]);
  } finally {
    await taskWorker.close();
  }
});

test("message cursors are isolated per task so earlier messages on another task are not skipped", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  const secondTaskId = "task-two";
  board.queued.push(
    (request) => claimed(request, {
      context: context({ messagesSinceCursor: null, nextMessageCursor: 20 }),
    }),
    (request) => claimed(request, {
      runId: "run-two",
      wakeupId: "wake-two",
      taskId: secondTaskId,
      context: context({
        taskId: secondTaskId,
        messagesSinceCursor: null,
        nextMessageCursor: 5,
        messages: [{
          messageId: "task-two-message-five",
          cursor: 5,
          author: "human",
          body: "This note existed before the first task completed.",
          createdAt: NOW,
        }],
      }),
    }),
  );
  const launcher = new FakeLauncher();
  launcher.outcomes.push(completedOutcome(), completedOutcome());
  const taskWorker = await worker(root, board, launcher);
  try {
    await taskWorker.dispatchOnce();
    await taskWorker.dispatchOnce();
    assert.equal(board.claimRequests[1]?.messageCursors[TASK], 20);
    assert.equal(board.claimRequests[1]?.messageCursors[secondTaskId], undefined);
    assert.equal(launcher.requests[1]?.context.messagesSinceCursor, null);
    assert.deepEqual(launcher.requests[1]?.context.messages.map((message) => message.cursor), [5]);
    assert.deepEqual(taskWorker.snapshot.messageCursors, { [TASK]: 20, [secondTaskId]: 5 });
  } finally {
    await taskWorker.close();
  }
});

test("taskless human resume settles failed without launching a context-free agent", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request, { reason: "human_resume", taskId: null, context: null }));
  const launcher = new FakeLauncher();
  const taskWorker = await worker(root, board, launcher);
  try {
    await taskWorker.dispatchOnce();
    assert.equal(launcher.requests.length, 0);
    assert.equal(board.settlements[0]?.outcome, "failed");
  } finally {
    await taskWorker.close();
  }
});

test("journal remains private on disk", async () => {
  const root = await tempRoot();
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  const board = new FakeBoard();
  const taskWorker = await worker(root, board, new FakeLauncher());
  await taskWorker.dispatchOnce();
  await taskWorker.close();
  const path = join(stateDirectory, "journal.json");
  const parsed = JSON.parse(await readFile(path, "utf8")) as { version: number };
  assert.equal(parsed.version, 2);
  const file = await import("node:fs/promises").then(({ stat }) => stat(path));
  assert.equal(file.mode & 0o777, 0o600);
});

test("legacy global cursor journals migrate without applying one task's cursor to another", async () => {
  const root = await tempRoot();
  const stateDirectory = join(root, "state");
  const path = join(stateDirectory, "journal.json");
  const identity = { workerId: "worker-one", agentId: AGENT };
  await mkdir(stateDirectory, { mode: 0o700 });
  await writeFile(path, `${JSON.stringify({
    version: 1,
    identity,
    messageCursor: 91,
    pendingClaim: null,
    active: null,
    completed: [],
  })}\n`, { mode: 0o600 });

  const store = await TaskWorkerJournalStore.open(path, identity);
  try {
    assert.equal(store.current.version, 2);
    assert.deepEqual(store.current.messageCursors, {});
  } finally {
    await store.close();
  }
});

test("rejects invalid terminal output before appending it to the board", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  launcher.outcomes.push({
    status: "completed",
    outputs: [{ type: "human_question", question: "This conflicts with completed." }],
    expectedAgentMinutes: null,
    phases: [],
    detail: "Invalid provider output.",
  } as AgentRunOutcome);
  const taskWorker = await worker(root, board, launcher);
  try {
    await taskWorker.dispatchOnce();
    assert.equal(board.outputs.length, 0);
    assert.equal(board.settlements[0]?.outcome, "failed");
  } finally {
    await taskWorker.close();
  }
});

test("launcher receives only the bounded contract fields", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  launcher.outcomes.push(completedOutcome());
  const taskWorker = await worker(root, board, launcher);
  try {
    await taskWorker.dispatchOnce();
    assert.deepEqual(Object.keys(launcher.requests[0]?.context ?? {}).sort(), [
      "agentId", "apiVersion", "areaMemory", "messages", "messagesSinceCursor", "mission", "nextMessageCursor",
      "openQuestions", "parentEvidence", "projectId", "projectMemory", "task", "taskId", "triggerQuestion",
      "workflow", "workspaceRefs",
    ]);
    assert.equal("token" in (launcher.requests[0]?.context ?? {}), false);
    assert.equal("boardUrl" in (launcher.requests[0]?.context ?? {}), false);
  } finally {
    await taskWorker.close();
  }
});

test("a successful claim still launches when clearing last_error returns 404 and logs loudly", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  board.laneErrorFailures = 1;
  board.laneErrorFailure = Object.assign(new Error("lane-error endpoint returned 404"), { status: 404 });
  const launcher = new FakeLauncher();
  launcher.outcomes.push(completedOutcome());
  const diagnostics: WorkerDiagnostic[] = [];
  const taskWorker = await worker(root, board, launcher, (event) => diagnostics.push(event));
  try {
    assert.equal(await taskWorker.dispatchOnce(), true);
    assert.equal(launcher.requests.length, 1);
    assert.equal(board.settlements[0]?.outcome, "completed");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.type, "lane_error_report_failed");
    assert.match(diagnostics[0]?.error ?? "", /404/u);
  } finally {
    await taskWorker.close();
  }
});

test("quarantine replaces a rejected terminal settlement with a scrubbed failed outcome and drops local ownership", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  board.settleFailures = 1;
  const launcher = new FakeLauncher();
  launcher.outcomes.push(completedOutcome());
  const taskWorker = await worker(root, board, launcher);
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  try {
    await assert.rejects(taskWorker.dispatchOnce(), /settlement rejection/u);
    assert.equal(taskWorker.hasActiveClaim(), true);

    await taskWorker.reportLaneError(`Settle rejected Bearer ${secret}`);
    await taskWorker.quarantineActiveClaim(`Settle rejected Bearer ${secret}`);

    assert.equal(board.settlementAttempts.length, 2);
    assert.equal(board.settlements.length, 1);
    assert.equal(board.settlements[0]?.outcome, "failed");
    assert.equal(board.settlements[0]?.result, "Settle rejected Bearer [redacted]");
    assert.equal(board.laneErrors.find((entry) => entry.detail !== null)?.detail, "Settle rejected Bearer [redacted]");
    assert.equal(taskWorker.hasActiveClaim(), false);
    assert.equal(taskWorker.snapshot.completedRuns, 1);
  } finally {
    await taskWorker.close();
  }
});

test("dropActiveClaim only updates the journal and makes zero board calls", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  board.settleFailures = 1;
  const launcher = new FakeLauncher();
  launcher.outcomes.push(completedOutcome());
  const taskWorker = await worker(root, board, launcher);
  try {
    await assert.rejects(taskWorker.dispatchOnce(), /settlement rejection/u);
    const boardCallsBefore = {
      claims: board.claimRequests.length,
      appendAttempts: board.appendAttempts.length,
      settlementAttempts: board.settlementAttempts.length,
      estimateUpdates: board.estimateUpdates.length,
      phaseCreates: board.phaseCreates.length,
      phaseUpdates: board.phaseUpdates.length,
      laneErrors: board.laneErrors.length,
    };

    await taskWorker.dropActiveClaim("Quarantine settlement retries were exhausted");

    assert.deepEqual({
      claims: board.claimRequests.length,
      appendAttempts: board.appendAttempts.length,
      settlementAttempts: board.settlementAttempts.length,
      estimateUpdates: board.estimateUpdates.length,
      phaseCreates: board.phaseCreates.length,
      phaseUpdates: board.phaseUpdates.length,
      laneErrors: board.laneErrors.length,
    }, boardCallsBefore);
    assert.equal(taskWorker.hasActiveClaim(), false);
  } finally {
    await taskWorker.close();
  }
});

test("a poisoned claim response journals its validated claim handle so the fleet can quarantine it", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  board.poisonedClaimFailures = 1;
  board.poisonedClaimReason = "human_assignment\u0000 sk-proj-board-secret-0123456789";
  const launcher = new FakeLauncher();
  const taskWorker = await worker(root, board, launcher);
  try {
    await assert.rejects(taskWorker.dispatchOnce(), /context is invalid/u);
    assert.equal(taskWorker.hasActiveClaim(), true);
    assert.equal(launcher.requests.length, 0);
    const journal = await readFile(join(root, "state", "journal.json"), "utf8");
    assert.doesNotMatch(journal, /sk-proj-board-secret/u);
    assert.match(journal, /poisoned_claim/u);

    await taskWorker.quarantineActiveClaim("Claim response context is invalid");
    assert.equal(board.settlements[0]?.outcome, "failed");
    assert.equal(board.settlements[0]?.result, "Claim response context is invalid");
    assert.equal(taskWorker.hasActiveClaim(), false);
  } finally {
    await taskWorker.close();
  }
});
