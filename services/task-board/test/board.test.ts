import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { TaskBoard, TaskBoardError, type AgentRole } from "../src/index.js";
import {
  AGENT_ONE_TOKEN,
  boardFixture,
  config,
  databasePath,
  taskRequest,
} from "./helpers.js";

function completeAssignedTask(
  board: TaskBoard,
  projectId: string,
  agentId: string,
  assignedRole: AgentRole,
  title: string,
  claimId: string,
  result: string,
) {
  const task = board.createTask(projectId, taskRequest({
    title,
    assignedAgentId: agentId,
    assignedRole,
  }));
  const claim = board.claimRun(agentId, { claimId, messageCursor: null });
  assert.ok(claim);
  board.settleRun(claim.run.runId, agentId, { outcome: "completed", result });
  return board.requireTask(task.taskId);
}

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
    assert.equal(snapshot.tasks.length, 2);
    const persistedWork = snapshot.tasks.find((item) => item.taskId === task.taskId);
    const persistedReview = snapshot.tasks.find((item) => item.kind === "manager_review");
    assert.equal(persistedWork?.kind, "work");
    assert.equal(persistedWork?.status, "completed");
    assert.equal(persistedWork?.result, "Research iteration completed.");
    assert.ok(persistedWork?.endedAt);
    assert.equal(persistedReview?.parentTaskId, task.taskId);
    assert.equal(persistedReview?.requiredRole, "manager");
    assert.equal(persistedReview?.assignedAgentId, null);
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

test("persisted stale wakeups are retired without blocking the next valid task", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const staleTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
    title: "Unassigned legacy task",
    assignedAgentId: null,
    assignedRole: null,
  }));
  fixture.board.resumeAgent(fixture.engineer.agentId, {
    reason: "Legacy resume created before assignment validation.",
    taskId: staleTask.taskId,
  }, "legacy-stale-resume-0001");
  const validTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
    title: "Valid work after stale wake",
  }));
  fixture.board.close();

  const restarted = await TaskBoard.open(config(path));
  try {
    const claimed = restarted.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-persisted-stale-wake-0001",
      messageCursor: null,
    });
    assert.ok(claimed);
    assert.equal(claimed.task?.taskId, validTask.taskId);
    assert.equal(restarted.resumeAgent(fixture.engineer.agentId, {
      reason: "Legacy resume created before assignment validation.",
      taskId: staleTask.taskId,
    }, "legacy-stale-resume-0001").duplicate, true);

    const retired = restarted.snapshot(fixture.project.projectId).recentEvents.find((event) => (
      event.eventType === "agent_wakeup_retired" && event.taskId === staleTask.taskId
    ));
    assert.equal(retired?.data.retirementReason, "task_unassigned");
    restarted.settleRun(claimed.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "The valid task completed after the stale wake was retired.",
    });
    assert.equal(restarted.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-retired-stale-wake-0002",
      messageCursor: null,
    }), null);
    assert.equal(
      restarted.snapshot(fixture.project.projectId).agents.find((agent) => agent.agentId === fixture.engineer.agentId)?.status,
      "idle",
    );
  } finally {
    restarted.close();
  }
});

test("reassignment and terminal decisions retire their pending wakes", async () => {
  const fixture = await boardFixture();
  try {
    const reassigned = fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Reassign before claim" }));
    fixture.board.updateTask(reassigned.taskId, {
      version: reassigned.version,
      assignedAgentId: fixture.manager.agentId,
      assignedRole: fixture.manager.role,
    }, { type: "human", id: "human:alice" });
    const cancelled = fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Cancel before claim" }));
    fixture.board.updateTask(cancelled.taskId, {
      version: cancelled.version,
      status: "cancelled",
      result: "The human cancelled this task before an agent started.",
    }, { type: "human", id: "human:alice" });
    const valid = fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Still valid engineer work" }));

    const engineerClaim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-reassignment-and-cancel-0001",
      messageCursor: null,
    });
    assert.ok(engineerClaim);
    assert.equal(engineerClaim.task?.taskId, valid.taskId);
    const managerClaim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-reassigned-manager-work-0001",
      messageCursor: null,
    });
    assert.ok(managerClaim);
    assert.equal(managerClaim.task?.taskId, reassigned.taskId);

    const reasons = fixture.board.snapshot(fixture.project.projectId).recentEvents
      .filter((event) => event.eventType === "agent_wakeup_retired")
      .map((event) => event.data.retirementReason);
    assert.ok(reasons.includes("task_reassigned"));
    assert.ok(reasons.includes("task_cancelled"));
    fixture.board.settleRun(engineerClaim.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: "Stopped after verifying wake retirement.",
    });
    fixture.board.settleRun(managerClaim.run.runId, fixture.manager.agentId, {
      outcome: "failed",
      result: "Stopped after verifying reassignment.",
    });
  } finally {
    fixture.board.close();
  }
});

test("the newest human trigger supersedes older unclaimed wakes for the same task", async () => {
  const fixture = await boardFixture();
  try {
    const task = fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Use only the latest trigger" }));
    const latest = fixture.board.resumeAgent(fixture.engineer.agentId, {
      reason: "Use the newest human direction for this task.",
      taskId: task.taskId,
    }, "newest-trigger-resume-0001");
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-newest-trigger-only-0001",
      messageCursor: null,
    });
    assert.ok(claim);
    assert.equal(claim.wakeup.wakeupId, latest.wakeup.wakeupId);
    assert.equal(claim.wakeup.reason, "human_resume");
    const retired = fixture.board.snapshot(fixture.project.projectId).recentEvents.find((event) => (
      event.eventType === "agent_wakeup_retired" && event.data.retirementReason === "superseded_by_preferred_wakeup"
    ));
    assert.equal(retired?.data.supersededByWakeupId, latest.wakeup.wakeupId);
    fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: "The newest trigger was handled once.",
    });
    assert.equal(fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-no-duplicate-trigger-0002",
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
    const redundantResume = fixture.board.resumeAgent(fixture.engineer.agentId, {
      reason: "Resume after recording the answer.",
      taskId: task.taskId,
    }, "resume-after-answer-0001");
    const resumed = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-answer-0001",
      messageCursor: null,
    });
    assert.ok(resumed);
    assert.equal(resumed.wakeup.wakeupId, answered.wakeup.wakeupId);
    assert.notEqual(resumed.wakeup.wakeupId, redundantResume.wakeup.wakeupId);
    assert.equal(resumed.task?.status, "in_progress");
    assert.equal(resumed.task?.startedAt, startedAt);
    assert.equal(resumed.context.triggerQuestion?.answer, answered.question.answer);
    assert.equal(resumed.context.openQuestions.length, 0);
    const oversight = fixture.board.snapshot(fixture.project.projectId);
    assert.equal(oversight.openQuestions.length, 0);
    assert.equal(oversight.recentQuestions[0]?.answer, answered.question.answer);
    const retiredResume = oversight.recentEvents.find((event) => (
      event.eventType === "agent_wakeup_retired" && event.data.wakeupId === redundantResume.wakeup.wakeupId
    ));
    assert.equal(retiredResume?.data.supersededByWakeupId, answered.wakeup.wakeupId);
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

test("claim area memory keeps the newest eight results, caps result text, and excludes the current task", async () => {
  let now = new Date("2026-07-19T20:00:00.000Z");
  const fixture = await boardFixture(await databasePath(), () => new Date(now));
  try {
    const completed = [];
    const longResult = `Customer impact: ${"x".repeat(1_200)}`;
    for (let index = 0; index < 10; index += 1) {
      if (index < 9) now = new Date(now.valueOf() + 15 * 60_000);
      completed.push(completeAssignedTask(
        fixture.board,
        fixture.project.projectId,
        fixture.engineer.agentId,
        fixture.engineer.role,
        `Completed area task ${index}`,
        `claim-area-history-${index}`,
        index === 9 ? longResult : `Result for completed area task ${index}.`,
      ));
    }

    now = new Date(now.valueOf() + 15 * 60_000);
    const current = fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Current area task" }));
    const request = { claimId: "claim-area-current-0001", messageCursor: null } as const;
    const claim = fixture.board.claimRun(fixture.engineer.agentId, request);
    assert.ok(claim);

    const expected = [...completed].sort((left, right) => {
      if (left.endedAt !== right.endedAt) return left.endedAt! > right.endedAt! ? -1 : 1;
      if (left.taskId === right.taskId) return 0;
      return left.taskId > right.taskId ? -1 : 1;
    }).slice(0, 8);
    assert.deepEqual(claim.context.areaMemory.map((entry) => entry.taskId), expected.map((task) => task.taskId));
    assert.equal(claim.context.areaMemory.length, 8);
    assert.ok(claim.context.areaMemory.every((entry) => entry.taskId !== current.taskId));
    assert.ok(claim.context.areaMemory.every((entry, index) => entry.endedAt === expected[index]?.endedAt));
    assert.ok(claim.context.areaMemory.every((entry) => (
      Object.keys(entry).sort().join(",") === "endedAt,result,taskId,title"
    )));
    const capped = claim.context.areaMemory.find((entry) => entry.title === "Completed area task 9");
    assert.equal(capped?.result, longResult.slice(0, 1_000));
    assert.equal(capped?.result.length, 1_000);

    fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "The current task is complete but must not remember itself.",
    });
    const replay = fixture.board.claimRun(fixture.engineer.agentId, request);
    assert.ok(replay);
    assert.deepEqual(replay.context.areaMemory.map((entry) => entry.taskId), expected.map((task) => task.taskId));
    assert.ok(replay.context.areaMemory.every((entry) => entry.taskId !== current.taskId));
  } finally {
    fixture.board.close();
  }
});

test("claim area memory is isolated to an agent and project and survives a file-backed restart", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  let originalOpen = true;
  let restarted: TaskBoard | null = null;
  try {
    const remembered = completeAssignedTask(
      fixture.board,
      fixture.project.projectId,
      fixture.engineer.agentId,
      fixture.engineer.role,
      "Remembered checkout improvement",
      "claim-area-isolation-engineer-0001",
      "Customers can retry without a duplicate charge.",
    );
    const otherAgent = completeAssignedTask(
      fixture.board,
      fixture.project.projectId,
      fixture.manager.agentId,
      fixture.manager.role,
      "Other agent's release review",
      "claim-area-isolation-manager-0001",
      "This belongs only to the manager's area memory.",
    );

    const otherProject = fixture.board.createProject({
      name: "Account recovery",
      description: "Keep account recovery dependable.",
    });
    const otherProjectEngineer = fixture.board.createAgent(otherProject.projectId, {
      agentId: "engineer-other-project",
      role: "engineer",
      area: "account-recovery",
      mission: "Ship safe account recovery improvements.",
      model: "codex-mini",
      token: "task-board-other-project-token-0123456789",
    });
    const otherProjectTask = completeAssignedTask(
      fixture.board,
      otherProject.projectId,
      otherProjectEngineer.agentId,
      otherProjectEngineer.role,
      "Other project's recovery improvement",
      "claim-area-isolation-project-0001",
      "This belongs only to the other project.",
    );

    const current = fixture.board.createTask(fixture.project.projectId, taskRequest({
      title: "Use persistent area memory",
    }));
    const request = { claimId: "claim-area-persist-0001", messageCursor: null } as const;
    const claim = fixture.board.claimRun(fixture.engineer.agentId, request);
    assert.ok(claim);
    assert.deepEqual(claim.context.areaMemory.map((entry) => entry.taskId), [remembered.taskId]);
    assert.ok(claim.context.areaMemory.every((entry) => entry.taskId !== otherAgent.taskId));
    assert.ok(claim.context.areaMemory.every((entry) => entry.taskId !== otherProjectTask.taskId));
    assert.ok(claim.context.areaMemory.every((entry) => entry.taskId !== current.taskId));

    fixture.board.close();
    originalOpen = false;
    restarted = await TaskBoard.open(config(path));
    const replay = restarted.claimRun(fixture.engineer.agentId, request);
    assert.ok(replay);
    assert.deepEqual(replay.context.areaMemory, [{
      taskId: remembered.taskId,
      title: remembered.title,
      result: remembered.result,
      endedAt: remembered.endedAt,
    }]);
  } finally {
    if (originalOpen) fixture.board.close();
    restarted?.close();
  }
});

test("claims isolate message cursors per task and expose bounded completed-parent evidence", async () => {
  const fixture = await boardFixture();
  try {
    const olderTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
      title: "Older unassigned follow-up",
      assignedAgentId: null,
      assignedRole: null,
    }));
    const olderNote = fixture.board.appendHumanMessage(olderTask.taskId, {
      clientEventId: "older-task-note-0001",
      kind: "note",
      body: "This older note must not be hidden by another task's cursor.",
    });
    const engineerTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
      title: "Engineer implementation for review",
    }));
    fixture.board.appendHumanMessage(engineerTask.taskId, {
      clientEventId: "engineer-task-note-0001",
      kind: "note",
      body: "Preserve this task-specific implementation constraint.",
    });
    const engineerClaim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-engineer-parent-0001",
      messageCursors: {},
    });
    assert.ok(engineerClaim);
    assert.deepEqual(engineerClaim.context.messages.map((message) => message.taskId), [engineerTask.taskId]);
    fixture.board.appendAgentMessage(engineerTask.taskId, fixture.engineer.agentId, {
      clientEventId: "engineer-parent-progress-0001",
      kind: "progress",
      body: "Research, implementation, and the focused tests are complete.",
      runId: engineerClaim.run.runId,
    });
    fixture.board.settleRun(engineerClaim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Checkout retries are safe and the focused tests pass.",
    });

    const assignedOlder = fixture.board.updateTask(olderTask.taskId, {
      version: olderTask.version,
      assignedAgentId: fixture.engineer.agentId,
      assignedRole: fixture.engineer.role,
    }, { type: "human", id: "human:alice" });
    const olderClaim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-older-task-0001",
      messageCursors: { [engineerTask.taskId]: engineerClaim.context.messageCursor },
    });
    assert.ok(olderClaim);
    assert.equal(olderClaim.task?.version, assignedOlder.version + 1);
    assert.deepEqual(olderClaim.context.messages.map((message) => message.messageId), [olderNote.messageId]);
    fixture.board.settleRun(olderClaim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "The older follow-up was reviewed independently.",
    });

    fixture.board.createTask(fixture.project.projectId, taskRequest({
      parentTaskId: engineerTask.taskId,
      title: "Manager review of completed engineer work",
      assignedAgentId: fixture.manager.agentId,
      assignedRole: fixture.manager.role,
      expectedAgentMinutes: 15,
    }));
    const reviewClaim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-manager-review-0001",
      messageCursors: {},
    });
    assert.ok(reviewClaim);
    assert.equal(reviewClaim.context.parentTask?.taskId, engineerTask.taskId);
    assert.equal(reviewClaim.context.parentTask?.status, "completed");
    assert.equal(reviewClaim.context.parentTask?.result, "Checkout retries are safe and the focused tests pass.");
    assert.deepEqual(reviewClaim.context.parentMessages.map((message) => message.kind), ["note", "progress"]);
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

test("completed engineer work creates one silent manager review, then one human-only check", async () => {
  const fixture = await boardFixture();
  try {
    const work = fixture.board.createTask(fixture.project.projectId, taskRequest());
    assert.equal(work.kind, "work");
    assert.equal(work.requiredRole, null);
    const engineerRun = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-review-workflow-engineer-0001",
      messageCursor: null,
    });
    assert.ok(engineerRun);
    const firstSettlement = fixture.board.settleRun(engineerRun.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "The implementation and focused checks are complete.",
    });
    const replaySettlement = fixture.board.settleRun(engineerRun.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "The implementation and focused checks are complete.",
    });
    assert.equal(firstSettlement.duplicate, false);
    assert.equal(replaySettlement.duplicate, true);

    let snapshot = fixture.board.snapshot(fixture.project.projectId);
    const reviews = snapshot.tasks.filter((task) => task.parentTaskId === work.taskId && task.kind === "manager_review");
    assert.equal(reviews.length, 1);
    const review = reviews[0]!;
    assert.equal(review.requiredRole, "manager");
    assert.equal(review.status, "backlog");
    assert.equal(review.assignedAgentId, null);
    assert.deepEqual(review.workspaceRefs, work.workspaceRefs);
    assert.equal(fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-review-before-human-assignment-0001",
      messageCursor: null,
    }), null);
    await assert.rejects(
      Promise.resolve().then(() => fixture.board.updateTask(review.taskId, {
        version: review.version,
        assignedAgentId: fixture.engineer.agentId,
        assignedRole: fixture.engineer.role,
      }, { type: "human", id: "human:alice" })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "TASK_REQUIRED_ROLE_MISMATCH",
    );

    const assignedReview = fixture.board.updateTask(review.taskId, {
      version: review.version,
      assignedAgentId: fixture.manager.agentId,
      assignedRole: fixture.manager.role,
    }, { type: "human", id: "human:alice" });
    const managerRun = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-review-workflow-manager-0001",
      messageCursor: null,
    });
    assert.ok(managerRun);
    assert.equal(managerRun.task?.taskId, assignedReview.taskId);
    assert.equal(managerRun.task?.kind, "manager_review");
    fixture.board.settleRun(managerRun.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "Evidence is sufficient for the human owner to decide.",
    });
    assert.equal(fixture.board.settleRun(managerRun.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "Evidence is sufficient for the human owner to decide.",
    }).duplicate, true);

    snapshot = fixture.board.snapshot(fixture.project.projectId);
    const checks = snapshot.tasks.filter((task) => task.parentTaskId === review.taskId && task.kind === "human_check");
    assert.equal(checks.length, 1);
    const humanCheck = checks[0]!;
    assert.equal(humanCheck.requiredRole, null);
    assert.equal(humanCheck.assignedAgentId, null);
    assert.equal(humanCheck.status, "backlog");
    assert.equal(fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-after-human-check-created-0001",
      messageCursor: null,
    }), null);
    await assert.rejects(
      Promise.resolve().then(() => fixture.board.updateTask(humanCheck.taskId, {
        version: humanCheck.version,
        assignedAgentId: fixture.manager.agentId,
        assignedRole: fixture.manager.role,
      }, { type: "human", id: "human:alice" })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "HUMAN_CHECK_NOT_ASSIGNABLE",
    );
    await assert.rejects(
      Promise.resolve().then(() => fixture.board.updateTask(humanCheck.taskId, {
        version: humanCheck.version,
        status: "completed",
        result: "An agent tried to approve this check.",
      }, { type: "agent", id: fixture.manager.agentId })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "HUMAN_CHECK_HUMAN_ONLY",
    );
    await assert.rejects(
      Promise.resolve().then(() => fixture.board.resumeAgent(fixture.manager.agentId, {
        reason: "Do not wake an agent for a human check.",
        taskId: humanCheck.taskId,
      }, "resume-human-check-0001")),
      (error: unknown) => error instanceof TaskBoardError && error.code === "HUMAN_CHECK_NOT_ASSIGNABLE",
    );
    const decided = fixture.board.updateTask(humanCheck.taskId, {
      version: humanCheck.version,
      status: "completed",
      result: "Human approved the reviewed change for the next controlled release step.",
    }, { type: "human", id: "human:alice" });
    assert.equal(decided.status, "completed");
    assert.ok(decided.endedAt);
    assert.equal(fixture.board.snapshot(fixture.project.projectId).tasks.length, 3);

    const events = fixture.board.snapshot(fixture.project.projectId).recentEvents;
    assert.ok(events.some((event) => event.taskId === review.taskId && event.eventType === "task_created"
      && event.data.kind === "manager_review" && event.data.requiredRole === "manager"));
    assert.ok(events.some((event) => event.taskId === humanCheck.taskId && event.eventType === "task_created"
      && event.data.kind === "human_check" && event.data.requiredRole === null));
    assert.ok(events.some((event) => event.taskId === work.taskId && event.eventType === "task_run_settled"
      && event.data.kind === "work"));
    assert.ok(events.some((event) => event.taskId === work.taskId && event.eventType === "task_created"
      && event.data.kind === "work" && event.data.requiredRole === null));
  } finally {
    fixture.board.close();
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
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      parent_task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT
    ) STRICT;
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
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 3);
    assert.equal(verified.prepare("SELECT task_id FROM runs WHERE run_id = ?").get("run-legacy")?.task_id, "task-legacy");
    const task = verified.prepare("SELECT task_kind, required_role FROM tasks WHERE task_id = ?").get("task-legacy");
    assert.equal(task?.task_kind, "work");
    assert.equal(task?.required_role, null);
  } finally {
    verified.close();
  }
});

test("schema version 2 adds review fields in place and defaults existing tasks to work", async () => {
  const path = await databasePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import("node:sqlite");
  const versionTwo = new DatabaseSync(path);
  versionTwo.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      parent_task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT
    ) STRICT;
    INSERT INTO tasks(task_id, parent_task_id) VALUES ('task-v2', NULL);
    PRAGMA user_version = 2;
  `);
  versionTwo.close();
  await chmod(path, 0o600);

  const upgraded = await TaskBoard.open(config(path));
  upgraded.close();

  const verified = new DatabaseSync(path);
  try {
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 3);
    const task = verified.prepare("SELECT task_kind, required_role FROM tasks WHERE task_id = ?").get("task-v2");
    assert.equal(task?.task_kind, "work");
    assert.equal(task?.required_role, null);
    const index = verified.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tasks_one_review_stage'").get();
    assert.equal(index?.name, "tasks_one_review_stage");
  } finally {
    verified.close();
  }
});
