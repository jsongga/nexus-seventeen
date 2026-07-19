import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { TaskBoard, TaskBoardError } from "../src/index.js";
import {
  AGENT_ONE_TOKEN,
  boardFixture,
  config,
  databasePath,
  taskRequest,
} from "./helpers.js";

test("projects, fixed agents, tasks, messages, and events survive a database restart", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const task = fixture.board.createTask(fixture.project.projectId, taskRequest());
  const claimed = fixture.board.claimRun(fixture.engineer.agentId, { claimId: "claim-persist-0001", messageCursor: null });
  assert.ok(claimed);
  const progress = fixture.board.appendAgentMessage(task.taskId, fixture.engineer.agentId, {
    clientEventId: "message-persist-0001",
    kind: "progress",
    body: "Retry research and the first test pass are complete.",
    runId: claimed.run.runId,
  });
  fixture.board.settleRun(claimed.run.runId, fixture.engineer.agentId, {
    outcome: "completed",
    result: "Research iteration completed.",
  });
  const progressReplay = fixture.board.appendAgentMessage(task.taskId, fixture.engineer.agentId, {
    clientEventId: "message-persist-0001",
    kind: "progress",
    body: "Retry research and the first test pass are complete.",
    runId: claimed.run.runId,
  });
  assert.equal(progressReplay.messageId, progress.messageId);
  fixture.board.close();

  const restarted = await TaskBoard.open(config(path));
  try {
    const snapshot = restarted.snapshot(fixture.project.projectId);
    assert.equal(snapshot.project.name, fixture.project.name);
    assert.equal(snapshot.agents.length, 2);
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.tasks[0]?.status, "completed");
    assert.equal(snapshot.tasks[0]?.result, "Research iteration completed.");
    assert.ok(snapshot.tasks[0]?.endedAt);
    assert.equal(snapshot.recentRuns[0]!.status, "completed");
    assert.equal(snapshot.recentRuns[0]!.taskId, task.taskId);
    assert.equal(restarted.listMessages(task.taskId).length, 1);
    assert.ok(snapshot.recentEvents.some((event) => event.eventType === "agent_run_settled"));
    assert.equal(restarted.authenticateAgent(AGENT_ONE_TOKEN, fixture.engineer.agentId).agentId, fixture.engineer.agentId);
  } finally {
    restarted.close();
  }
});

test("only a new human assignment creates its durable task wakeup", async () => {
  const fixture = await boardFixture();
  try {
    const backlog = fixture.board.createTask(fixture.project.projectId, taskRequest({
      assignedAgentId: null,
      assignedRole: null,
    }));
    fixture.board.appendHumanMessage(backlog.taskId, {
      clientEventId: "human-note-no-wake-0001",
      kind: "note",
      body: "Human context only; do not start an agent.",
    });
    assert.equal(fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-before-assignment-0001",
      messageCursor: null,
    }), null);

    fixture.board.updateTask(backlog.taskId, {
      version: backlog.version,
      assignedAgentId: fixture.engineer.agentId,
      assignedRole: fixture.engineer.role,
    }, { type: "human", id: "human:alice" });
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-assignment-0001",
      messageCursor: null,
    });
    assert.ok(claim);
    assert.equal(claim.wakeup.reason, "human_assignment");
    assert.equal(claim.task?.taskId, backlog.taskId);
    assert.equal(claim.run.taskId, backlog.taskId);
    assert.equal(fixture.board.snapshot(fixture.project.projectId).recentRuns[0]?.taskId, backlog.taskId);

    fixture.board.appendAgentMessage(backlog.taskId, fixture.engineer.agentId, {
      clientEventId: "agent-proposal-no-wake-0001",
      kind: "proposal",
      body: "Proposed follow-up; it must not wake any agent.",
      runId: claim.run.runId,
    });
    fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: "The first implementation attempt needs another pass.",
    });
    const blocked = fixture.board.requireTask(backlog.taskId);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.endedAt, null);
    assert.equal(blocked.result, null);
    const titleOnly = fixture.board.updateTask(backlog.taskId, {
      version: blocked.version,
      title: "Recover interrupted checkout safely",
    }, { type: "human", id: "human:alice" });
    assert.equal(titleOnly.version, blocked.version + 1);
    assert.equal(fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-messages-0001",
      messageCursor: null,
    }), null);
  } finally {
    fixture.board.close();
  }
});

test("asking a question atomically releases the run and only the human answer wakes the agent", async () => {
  const fixture = await boardFixture();
  try {
    const task = fixture.board.createTask(fixture.project.projectId, taskRequest());
    const first = fixture.board.claimRun(fixture.engineer.agentId, { claimId: "claim-question-0001", messageCursor: null });
    assert.ok(first);
    assert.equal(first.task?.status, "in_progress");
    const startedAt = first.task?.startedAt;
    assert.ok(startedAt);
    const question = fixture.board.askQuestion(task.taskId, fixture.engineer.agentId, {
      clientEventId: "question-0001",
      question: "Should retries preserve the original payment intent?",
      runId: first.run.runId,
    });
    assert.equal(question.status, "open");
    const waitingForHuman = fixture.board.snapshot(fixture.project.projectId);
    assert.equal(waitingForHuman.recentRuns[0]!.status, "waiting_for_human");
    assert.equal(waitingForHuman.tasks[0]?.status, "blocked");
    assert.equal(waitingForHuman.tasks[0]?.endedAt, null);
    assert.equal(fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-before-answer-0001",
      messageCursor: null,
    }), null);

    const answered = fixture.board.answerQuestion(question.questionId, {
      answer: "Yes. Preserve it and verify duplicate-submit behavior.",
      version: question.version,
    });
    assert.equal(answered.duplicate, false);
    assert.equal(answered.wakeup.reason, "human_answer");
    const resumed = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-answer-0001",
      messageCursor: null,
    });
    assert.ok(resumed);
    assert.equal(resumed.task?.status, "in_progress");
    assert.equal(resumed.task?.startedAt, startedAt);
    assert.equal(resumed.context.triggerQuestion?.answer, answered.question.answer);
    assert.equal(resumed.context.openQuestions.length, 0);
    const oversight = fixture.board.snapshot(fixture.project.projectId);
    assert.equal(oversight.openQuestions.length, 0);
    assert.equal(oversight.recentQuestions[0]?.answer, answered.question.answer);
  } finally {
    fixture.board.close();
  }
});

test("task timing is server-owned, uses 15-minute estimates, and updates by compare-and-swap", async () => {
  let now = new Date("2026-07-19T20:00:00.000Z");
  const fixture = await boardFixture(await databasePath(), () => new Date(now));
  try {
    const task = fixture.board.createTask(fixture.project.projectId, taskRequest({ expectedAgentMinutes: 30 }));
    const claim = fixture.board.claimRun(fixture.engineer.agentId, { claimId: "claim-timing-0001", messageCursor: null });
    assert.ok(claim);
    assert.equal(claim.task?.status, "in_progress");
    assert.equal(claim.task?.startedAt, "2026-07-19T20:00:00.000Z");
    assert.equal(claim.task?.expectedCompletedAt, "2026-07-19T20:30:00.000Z");
    assert.equal(claim.task?.version, task.version + 1);
    await assert.rejects(
      Promise.resolve().then(() => fixture.board.updateTask(task.taskId, {
        version: task.version,
        status: "blocked",
      }, { type: "agent", id: fixture.engineer.agentId })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "TASK_VERSION_CONFLICT",
    );
    now = new Date("2026-07-19T20:30:00.000Z");
    fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Retry behavior passes the required tests.",
    });
    const completed = fixture.board.requireTask(task.taskId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.endedAt, "2026-07-19T20:30:00.000Z");
    assert.equal(completed.result, "Retry behavior passes the required tests.");
    assert.equal(completed.version, (claim.task?.version ?? 0) + 1);
  } finally {
    fixture.board.close();
  }
});

test("claim is exact-idempotent and the database permits only one active run per agent", async () => {
  const fixture = await boardFixture();
  try {
    fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "First assigned task" }));
    fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Second assigned task" }));
    const first = fixture.board.claimRun(fixture.engineer.agentId, { claimId: "claim-one-active-0001", messageCursor: 0 });
    assert.ok(first);
    const replay = fixture.board.claimRun(fixture.engineer.agentId, { claimId: "claim-one-active-0001", messageCursor: 0 });
    assert.equal(replay?.run.runId, first.run.runId);
    await assert.rejects(
      Promise.resolve().then(() => fixture.board.claimRun(fixture.engineer.agentId, {
        claimId: "claim-one-active-0002",
        messageCursor: 0,
      })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "AGENT_RUN_ACTIVE",
    );
    fixture.board.settleRun(first.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "First run complete.",
    });
    const second = fixture.board.claimRun(fixture.engineer.agentId, { claimId: "claim-one-active-0002", messageCursor: 0 });
    assert.ok(second);
    assert.notEqual(second.run.runId, first.run.runId);
  } finally {
    fixture.board.close();
  }
});

test("human interrupt is durable, idempotent, visible immediately, and only an explicit resume restarts blocked work", async () => {
  const fixture = await boardFixture();
  try {
    fixture.board.createTask(fixture.project.projectId, taskRequest());
    const claim = fixture.board.claimRun(fixture.engineer.agentId, { claimId: "claim-interrupt-0001", messageCursor: 0 });
    assert.ok(claim);
    const first = fixture.board.interruptAgent(fixture.engineer.agentId, { reason: "Human changed deployment scope." }, "interrupt-key-0001");
    const replay = fixture.board.interruptAgent(fixture.engineer.agentId, { reason: "Human changed deployment scope." }, "interrupt-key-0001");
    assert.equal(first.duplicate, false);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.interrupt.interruptId, first.interrupt.interruptId);
    assert.equal(fixture.board.snapshot(fixture.project.projectId).agents[0]!.status, "interrupting");
    const batch = await fixture.board.waitForRunInterrupts(claim.run.runId, fixture.engineer.agentId, 0, 0, new AbortController().signal);
    assert.equal(batch?.items[0]?.reason, "Human changed deployment scope.");
    fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "interrupted",
      result: "Stopped after the durable human interrupt.",
    });
    const blocked = fixture.board.requireTask(claim.task!.taskId);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.endedAt, null);
    assert.equal(blocked.result, null);
    assert.equal(fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-interrupt-0001",
      messageCursor: 0,
    }), null);
    fixture.board.resumeAgent(fixture.engineer.agentId, {
      reason: "Human approved a safer follow-up iteration.",
      taskId: blocked.taskId,
    }, "resume-after-interrupt-0001");
    const resumed = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-resumed-after-interrupt-0001",
      messageCursor: 0,
    });
    assert.ok(resumed);
    assert.equal(resumed.task?.status, "in_progress");
    assert.equal(resumed.task?.startedAt, blocked.startedAt);
  } finally {
    fixture.board.close();
  }
});

test("an explicit human resume durably releases an event-driven claim after restart", async () => {
  const path = await databasePath();
  const first = await boardFixture(path);
  const projectId = first.project.projectId;
  const agentId = first.engineer.agentId;
  first.board.resumeAgent(agentId, {
    reason: "Human approved another research iteration.",
    taskId: null,
  }, "resume-persist-0001");
  first.board.close();

  const restarted = await TaskBoard.open(config(path));
  try {
    const claimed = restarted.claimRun(agentId, { claimId: "claim-resume-persist-0001", messageCursor: null });
    assert.ok(claimed);
    assert.equal(claimed.wakeup.reason, "human_resume");
    restarted.settleRun(claimed.run.runId, agentId, {
      outcome: "completed",
      result: "Resumed iteration finished.",
    });

    const waiting = restarted.waitToClaimRun(
      agentId,
      { claimId: "claim-event-driven-resume-0001", messageCursor: null },
      1_000,
      new AbortController().signal,
    );
    restarted.resumeAgent(agentId, {
      reason: "Human explicitly resumed the idle agent.",
      taskId: null,
    }, "resume-event-driven-0001");
    const awakened = await waiting;
    assert.ok(awakened);
    assert.equal(awakened.wakeup.reason, "human_resume");
    assert.equal(restarted.snapshot(projectId).agents.find((agent) => agent.agentId === agentId)?.status, "running");
  } finally {
    restarted.close();
  }
});

test("the SQLite database and parent directory must remain owner-only", async () => {
  const path = await databasePath();
  const board = await TaskBoard.open(config(path));
  board.close();
  assert.equal((await stat(path)).mode & 0o077, 0);
  assert.equal((await stat(join(path, ".."))).mode & 0o077, 0);

  const root = await mkdtemp(join(tmpdir(), "steward-task-board-unsafe-"));
  const shared = join(root, "shared");
  await mkdir(shared, { mode: 0o755 });
  await chmod(shared, 0o755);
  await assert.rejects(
    TaskBoard.open(config(join(shared, "task-board.sqlite"))),
    (error: unknown) => error instanceof TaskBoardError && error.code === "UNSAFE_DATABASE_PATH",
  );
});

test("schema version 1 upgrades in place and preserves the run-to-task projection", async () => {
  const path = await databasePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import("node:sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE tasks (task_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE wakeups (
      wakeup_id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      wakeup_id TEXT NOT NULL UNIQUE REFERENCES wakeups(wakeup_id) ON DELETE RESTRICT
    ) STRICT;
    INSERT INTO tasks(task_id) VALUES ('task-legacy');
    INSERT INTO wakeups(wakeup_id, task_id) VALUES ('wakeup-legacy', 'task-legacy');
    INSERT INTO runs(run_id, wakeup_id) VALUES ('run-legacy', 'wakeup-legacy');
    PRAGMA user_version = 1;
  `);
  legacy.close();
  await chmod(path, 0o600);

  const upgraded = await TaskBoard.open(config(path));
  upgraded.close();

  const verified = new DatabaseSync(path);
  try {
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 2);
    assert.equal(verified.prepare("SELECT task_id FROM runs WHERE run_id = ?").get("run-legacy")?.task_id, "task-legacy");
  } finally {
    verified.close();
  }
});
