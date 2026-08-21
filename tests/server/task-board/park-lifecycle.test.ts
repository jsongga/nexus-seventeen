import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  TaskBoard,
  TaskBoardError,
  normalizeTaskBoardConfig,
  type BoardNotification,
  type NotificationDeliveryAdapter,
} from "#server/task-board";
import { AGENT_TWO_TOKEN, HUMAN_TOKEN, databasePath, workItemRequest } from "./helpers.js";

const PARKED_AT = "2026-08-01T12:00:00.000Z";
const QUESTION = `Which rollback path should the implementation preserve? ${"x".repeat(240)}`;

function atAge(days: number, hours = 0): Date {
  return new Date(Date.parse(PARKED_AT) + (days * 24 + hours) * 60 * 60 * 1_000);
}

async function lifecycleFixture(overrides: Readonly<{
  parkNotifySeconds?: number;
  parkAutoAbandonSeconds?: number;
}> = {}) {
  const path = await databasePath();
  let clock = new Date(PARKED_AT);
  const delivered: BoardNotification[] = [];
  const delivery: NotificationDeliveryAdapter = {
    deliver(notification) {
      const inspected = new DatabaseSync(path, { readOnly: true });
      try {
        assert.equal(
          inspected.prepare("SELECT COUNT(*) AS count FROM notifications WHERE notification_id=?")
            .get(notification.notificationId)?.count,
          1,
          "delivery must run after the notification transaction commits",
        );
      } finally {
        inspected.close();
      }
      delivered.push(notification);
    },
  };
  const board = await TaskBoard.open(normalizeTaskBoardConfig({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    now: () => clock,
    ...overrides,
  }), { notificationDelivery: delivery });
  const project = board.createProject({
    name: "Park lifecycle",
    description: "Exercise aged parked work and in-app delivery.",
  });
  const manager = board.createAgent(project.projectId, {
    agentId: "park-lifecycle-manager",
    role: "manager",
    area: "lifecycle",
    mission: "Ask the bounded question that parks this work item.",
    model: "claude-haiku",
    token: AGENT_TWO_TOKEN,
  });
  const created = board.createWorkItemAndStartPlanning(workItemRequest({
    originalRequest: "Preserve the intended rollback path before implementation proceeds.",
    projectTarget: { mode: "explicit", projectId: project.projectId },
  }), "park-lifecycle-work-item-0001").workItem;
  assert.ok(created.planningTaskId);
  const claim = board.claimRun(manager.agentId, {
    claimId: "park-lifecycle-claim-0001",
    messageCursor: null,
  });
  assert.ok(claim);
  const question = board.askQuestion(created.planningTaskId, manager.agentId, {
    clientEventId: "park-lifecycle-question-0001",
    question: QUESTION,
    runId: claim.run.runId,
  });
  assert.equal(board.requireWorkItem(created.workItemId).state, "parked");

  return {
    board,
    created,
    delivered,
    path,
    project,
    question,
    setNow(value: Date) {
      clock = value;
    },
  };
}

function parkResolution(path: string, workItemId: string): Readonly<{
  park_record_id: string;
  resolved_at: string | null;
  resolution: string | null;
}> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { ...db.prepare(`
      SELECT park_record_id, resolved_at, resolution
      FROM park_records
      WHERE work_item_id=?
      ORDER BY parked_at DESC, rowid DESC
      LIMIT 1
    `).get(workItemId) } as { park_record_id: string; resolved_at: string | null; resolution: string | null };
  } finally {
    db.close();
  }
}

test("park lifecycle configuration defaults, disables at zero, and validates threshold ordering", async () => {
  const path = await databasePath();
  const defaults = normalizeTaskBoardConfig({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
  });
  assert.equal(defaults.parkNotifySeconds, 86_400);
  assert.equal(defaults.parkAutoAbandonSeconds, 604_800);

  const disabled = normalizeTaskBoardConfig({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    parkNotifySeconds: 0,
    parkAutoAbandonSeconds: 0,
  });
  assert.equal(disabled.parkNotifySeconds, 0);
  assert.equal(disabled.parkAutoAbandonSeconds, 0);

  const minimums = normalizeTaskBoardConfig({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    parkNotifySeconds: 60,
    parkAutoAbandonSeconds: 60,
  });
  assert.equal(minimums.parkNotifySeconds, 60);
  assert.equal(minimums.parkAutoAbandonSeconds, 60);

  for (const options of [
    { parkNotifySeconds: 59 },
    { parkAutoAbandonSeconds: 59 },
    { parkNotifySeconds: 120, parkAutoAbandonSeconds: 60 },
  ]) {
    assert.throws(
      () => normalizeTaskBoardConfig({
        dbPath: path,
        humanToken: HUMAN_TOKEN,
        humanPrincipal: "human:alice",
        ...options,
      }),
      (error: unknown) => error instanceof TaskBoardError
        && error.status === 500
        && error.code === "INVALID_CONFIGURATION",
    );
  }
  assert.equal(normalizeTaskBoardConfig({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    parkNotifySeconds: 120,
    parkAutoAbandonSeconds: 0,
  }).parkAutoAbandonSeconds, 0);
});

test("the clock-driven lifecycle sweep notifies once then auto-abandons an open-question park", async () => {
  const fixture = await lifecycleFixture();
  try {
    fixture.setNow(atAge(1));
    assert.deepEqual(fixture.board.sweepParkLifecycle(atAge(1).toISOString()), {
      notified: 0,
      autoAbandoned: 0,
    });
    assert.deepEqual(fixture.board.listNotifications(), { unread: [], recentRead: [] });

    assert.deepEqual(fixture.board.sweepParkLifecycle(atAge(2).toISOString()), {
      notified: 1,
      autoAbandoned: 0,
    });
    assert.deepEqual(fixture.board.sweepParkLifecycle(atAge(2).toISOString()), {
      notified: 0,
      autoAbandoned: 0,
    });
    const aged = fixture.board.listNotifications().unread;
    const parkRecordId = parkResolution(fixture.path, fixture.created.workItemId).park_record_id;
    assert.equal(aged.length, 1);
    assert.equal(aged[0]?.kind, "park_aged");
    assert.equal(aged[0]?.sequence, 1);
    assert.equal(aged[0]?.dedupeKey, `park_aged:${parkRecordId}`);
    assert.equal(aged[0]?.projectId, fixture.project.projectId);
    assert.equal(aged[0]?.workItemId, fixture.created.workItemId);
    assert.equal(aged[0]?.createdAt, atAge(2).toISOString());
    assert.equal(aged[0]?.summary, `Work item parked 2 days (open_question): ${QUESTION.slice(0, 200)}`);
    assert.equal(fixture.delivered.length, 1);

    fixture.setNow(atAge(7));
    assert.deepEqual(fixture.board.sweepParkLifecycle(atAge(7).toISOString()), {
      notified: 0,
      autoAbandoned: 0,
    });
    assert.equal(fixture.board.requireWorkItem(fixture.created.workItemId).state, "parked");

    fixture.setNow(atAge(8));
    assert.deepEqual(fixture.board.sweepParkLifecycle(atAge(8).toISOString()), {
      notified: 0,
      autoAbandoned: 1,
    });
    const abandoned = fixture.board.requireWorkItem(fixture.created.workItemId);
    assert.equal(abandoned.state, "abandoned");
    assert.equal(abandoned.currentStage, null);
    assert.equal(abandoned.endedAt, atAge(8).toISOString());
    assert.equal(abandoned.cancelledReason, "parked past auto-abandon threshold (open_question)");
    assert.deepEqual(abandoned.transitions.at(-1), {
      fromState: "parked",
      toState: "abandoned",
      actorType: "system",
      actorId: "system:park-lifecycle",
      createdAt: atAge(8).toISOString(),
    });
    assert.deepEqual(parkResolution(fixture.path, fixture.created.workItemId), {
      park_record_id: parkRecordId,
      resolved_at: atAge(8).toISOString(),
      resolution: "auto_abandoned",
    });
    assert.equal(fixture.board.requireTask(fixture.created.planningTaskId!).status, "cancelled");
    const closedQuestion = fixture.board.snapshot(fixture.project.projectId).openQuestions.find(
      (candidate) => candidate.questionId === fixture.question.questionId,
    );
    assert.equal(
      closedQuestion,
      undefined,
      "auto-abandon closes questions on linked work",
    );
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const question = inspected.prepare(`
        SELECT status,answer,answered_at,answered_by FROM questions WHERE question_id=?
      `).get(fixture.question.questionId);
      assert.deepEqual({ ...question }, {
        status: "answered",
        answer: "Closed because the work item was cancelled: parked past auto-abandon threshold (open_question)",
        answered_at: atAge(8).toISOString(),
        answered_by: "system:park-lifecycle",
      });
      assert.equal(inspected.prepare(`
        SELECT COUNT(*) AS count FROM task_events
        WHERE task_id=? AND event_type='human_question_closed'
          AND actor_type='system' AND actor_id='system:park-lifecycle'
          AND json_extract(data_json, '$.reason')='work_item_cancelled'
      `).get(fixture.created.planningTaskId)?.count, 1);
    } finally {
      inspected.close();
    }

    const notifications = fixture.board.listNotifications().unread;
    assert.equal(notifications.length, 2);
    assert.equal(notifications[0]?.kind, "park_auto_abandoned");
    assert.equal(notifications[0]?.sequence, 2);
    assert.equal(notifications[0]?.dedupeKey, `park_auto_abandoned:${parkRecordId}`);
    assert.equal(notifications[0]?.createdAt, atAge(8).toISOString());
    assert.equal(
      notifications[0]?.summary,
      `Work item parked 8 days (open_question): ${QUESTION.slice(0, 200)}`,
    );
    assert.equal(fixture.delivered.length, 2);
  } finally {
    fixture.board.close();
  }
});

test("a park resolved between lifecycle sweeps is not auto-abandoned", async () => {
  const fixture = await lifecycleFixture();
  try {
    fixture.setNow(atAge(2));
    assert.equal(fixture.board.sweepParkLifecycle(atAge(2).toISOString()).notified, 1);
    fixture.board.answerQuestion(fixture.question.questionId, {
      answer: "Preserve the last verified rollback behavior.",
      version: fixture.question.version,
    });
    assert.equal(fixture.board.requireWorkItem(fixture.created.workItemId).state, "planning");

    fixture.setNow(atAge(8));
    assert.deepEqual(fixture.board.sweepParkLifecycle(atAge(8).toISOString()), {
      notified: 0,
      autoAbandoned: 0,
    });
    assert.equal(fixture.board.requireWorkItem(fixture.created.workItemId).state, "planning");
    const resumedRecord = parkResolution(fixture.path, fixture.created.workItemId);
    assert.equal(resumedRecord.resolved_at, atAge(2).toISOString());
    assert.equal(resumedRecord.resolution, "resumed");
    assert.deepEqual(fixture.board.listNotifications().unread.map((item) => item.kind), ["park_aged"]);
  } finally {
    fixture.board.close();
  }
});

test("zero independently disables notification and auto-abandon halves", async () => {
  const notifyDisabled = await lifecycleFixture({ parkNotifySeconds: 0 });
  try {
    notifyDisabled.setNow(atAge(8));
    assert.deepEqual(notifyDisabled.board.sweepParkLifecycle(atAge(8).toISOString()), {
      notified: 0,
      autoAbandoned: 1,
    });
    assert.deepEqual(
      notifyDisabled.board.listNotifications().unread.map((notification) => notification.kind),
      ["park_auto_abandoned"],
    );
  } finally {
    notifyDisabled.board.close();
  }

  const abandonDisabled = await lifecycleFixture({ parkAutoAbandonSeconds: 0 });
  try {
    abandonDisabled.setNow(atAge(8));
    assert.deepEqual(abandonDisabled.board.sweepParkLifecycle(atAge(8).toISOString()), {
      notified: 1,
      autoAbandoned: 0,
    });
    assert.equal(abandonDisabled.board.requireWorkItem(abandonDisabled.created.workItemId).state, "parked");
    assert.deepEqual(
      abandonDisabled.board.listNotifications().unread.map((notification) => notification.kind),
      ["park_aged"],
    );
  } finally {
    abandonDisabled.board.close();
  }
});
