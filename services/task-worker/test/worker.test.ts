import assert from "node:assert/strict";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { TaskWorkerJournalStore } from "../src/journal.js";
import { emptyTaskWorkerJournal } from "../src/schema.js";
import { TaskWorker } from "../src/worker.js";
import type { AgentRunOutcome, TaskWorkerJournal } from "../src/types.js";
import {
  AGENT,
  FakeBoard,
  FakeLauncher,
  NOW,
  claimed,
  completedOutcome,
  context,
  tempRoot,
  until,
} from "./helpers.js";

async function worker(root: string, board: FakeBoard, launcher: FakeLauncher): Promise<TaskWorker> {
  return TaskWorker.create({
    identity: { workerId: "worker-one", agentId: AGENT },
    statePath: join(root, "state", "journal.json"),
    board,
    launcher,
    longPollMs: 30_000,
    now: () => new Date(NOW),
  });
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

for (const reason of ["human_assignment", "human_answer", "human_resume"] as const) {
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
      assert.equal(taskWorker.snapshot.activeRunId, null);
      assert.equal(taskWorker.snapshot.completedRuns, 1);
    } finally {
      await taskWorker.close();
    }
  });
}

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
    assert.match(board.settlements[0]?.detail ?? "", /not human-authorized/u);
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

test("a human answer is included in the next bounded one-shot context", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request, {
    reason: "human_answer",
    context: context({
      messagesSinceCursor: request.messageCursor,
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
    assert.equal(board.claimRequests[1]?.messageCursor, board.claimRequests[0]?.messageCursor);
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

test("does not duplicate a model process after restart beyond the durable launch boundary", async () => {
  const root = await tempRoot();
  const statePath = join(root, "state", "journal.json");
  const identity = { workerId: "worker-one", agentId: AGENT };
  const request = { agentId: AGENT, claimId: "claim-recovery", messageCursor: null, longPollMs: 0 };
  const activeClaim = claimed(request).claim;
  const store = await TaskWorkerJournalStore.open(statePath, identity);
  const seeded: TaskWorkerJournal = {
    ...emptyTaskWorkerJournal(identity),
    messageCursor: 2,
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
    assert.match(board.settlements[0]?.detail ?? "", /refusing to launch a duplicate/u);
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
    assert.equal(board.claimRequests[1]?.messageCursor, 2);
    assert.equal(launcher.requests[1]?.context.messagesSinceCursor, 2);
    assert.deepEqual(launcher.requests[1]?.context.messages.map((message) => message.cursor), [3]);
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
  assert.equal(parsed.version, 1);
  const file = await import("node:fs/promises").then(({ stat }) => stat(path));
  assert.equal(file.mode & 0o777, 0o600);
});

test("rejects invalid terminal output before appending it to the board", async () => {
  const root = await tempRoot();
  const board = new FakeBoard();
  board.queued.push((request) => claimed(request));
  const launcher = new FakeLauncher();
  launcher.outcomes.push({
    status: "completed",
    outputs: [{ type: "human_question", question: "This conflicts with completed." }],
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
      "agentId", "apiVersion", "messages", "messagesSinceCursor", "mission", "nextMessageCursor", "openQuestions",
      "parentSummary", "projectId", "projectMemory", "task", "taskId", "triggerQuestion", "workspaceRefs",
    ]);
    assert.equal("token" in (launcher.requests[0]?.context ?? {}), false);
    assert.equal("boardUrl" in (launcher.requests[0]?.context ?? {}), false);
  } finally {
    await taskWorker.close();
  }
});
