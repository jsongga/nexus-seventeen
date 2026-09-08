import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TaskBoard, TaskBoardError, normalizeTaskBoardConfig } from "#server/task-board";
import { NotificationsCollaborator } from "#server/task-board/collaborators/notifications";
import { TaskBoardRuntime } from "#server/task-board/collaborators/board-runtime";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import { HUMAN_TOKEN, config, databasePath } from "../helpers.js";

const NOW = "2026-08-21T16:00:00.000Z";

function seedNotifications(path: string): void {
  const db = new DatabaseSync(path);
  try {
    const insert = db.prepare(`
      INSERT INTO notifications(
        notification_id, sequence, kind, dedupe_key, project_id, work_item_id,
        summary, created_at, read_at, version
      ) VALUES (?, ?, 'park_aged', NULL, NULL, NULL, ?, ?, ?, 1)
    `);
    for (let sequence = 1; sequence <= 154; sequence += 1) {
      const createdAt = new Date(Date.parse("2026-08-20T00:00:00.000Z") + sequence * 1_000).toISOString();
      insert.run(
        `notification-${sequence}`,
        sequence,
        `Seeded notification ${sequence}`,
        createdAt,
        sequence <= 52 ? createdAt : null
      );
    }
  } finally {
    db.close();
  }
}

test("notification lists are bounded and read updates use versioned CAS", async () => {
  const path = await databasePath();
  const board = await TaskBoard.open(
    normalizeTaskBoardConfig({
      dbPath: path,
      humanToken: HUMAN_TOKEN,
      humanPrincipal: "human:alice",
      now: () => new Date(NOW),
    })
  );
  try {
    seedNotifications(path);
    const listed = board.listNotifications();
    assert.equal(listed.unread.length, 100);
    assert.equal(listed.unread[0]?.sequence, 154);
    assert.equal(listed.unread.at(-1)?.sequence, 55);
    assert.equal(listed.recentRead.length, 50);
    assert.equal(listed.recentRead[0]?.sequence, 52);
    assert.equal(listed.recentRead.at(-1)?.sequence, 3);

    const marked = board.markNotificationRead("notification-154", 1);
    assert.equal(marked.readAt, NOW);
    assert.equal(marked.version, 2);
    assert.equal(board.listNotifications().recentRead[0]?.notificationId, "notification-154");
    assert.throws(
      () => board.markNotificationRead("notification-154", 1),
      (error: unknown) => error instanceof TaskBoardError && error.status === 409
    );
    assert.throws(
      () => board.markNotificationRead("notification-unknown", 1),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 404 && error.code === "TASK_BOARD_NOTIFICATION_NOT_FOUND"
    );
  } finally {
    board.close();
  }
});

test("duplicate cap notification inserts exercise INSERT OR IGNORE and return null", async () => {
  const path = await databasePath();
  const store = await TaskBoardStore.open(path);
  const runtime = new TaskBoardRuntime(config(path), store);
  const notifications = new NotificationsCollaborator(runtime);
  const input = {
    kind: "cap_parked" as const,
    dedupeKey: "cap_parked:direct-item:direct-attempt",
    projectId: null,
    workItemId: null,
    summary: "Direct cap notification dedupe test.",
  };
  try {
    const first = store.transaction(() => notifications.insertNotificationAtInTransaction(input, NOW));
    const second = store.transaction(() => notifications.insertNotificationAtInTransaction(input, NOW));
    assert.ok(first);
    assert.equal(second, null);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE dedupe_key=?").get(input.dedupeKey)?.count,
      1
    );
  } finally {
    runtime.close();
    store.close();
  }
});
