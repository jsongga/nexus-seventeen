import { randomUUID } from "node:crypto";
import { TASK_BOARD_ERROR_CODES, type BoardNotification } from "#shared/task-board-contract";
import { parseBoardNotification } from "#shared/task-board-contract/validate";
import { conflict, TaskBoardError } from "../errors.js";
import { numberValue, type Row } from "../persistence/rows.js";
import { exactIsoTimestamp, exactNow } from "../persistence/timestamps.js";
import type { TaskBoardRuntime } from "./board-runtime.js";

export interface NotificationDeliveryAdapter {
  deliver(notification: BoardNotification): void;
}

export const IN_APP_NOTIFICATION_DELIVERY_ADAPTER: NotificationDeliveryAdapter = Object.freeze({
  deliver(_notification: BoardNotification): void {
    // The durable notifications row is the in-app delivery.
  },
});

export interface InsertNotificationInput {
  readonly kind: BoardNotification["kind"];
  readonly dedupeKey: string | null;
  readonly projectId: string | null;
  readonly workItemId: string | null;
  readonly summary: string;
}

export interface NotificationList {
  readonly unread: readonly BoardNotification[];
  readonly recentRead: readonly BoardNotification[];
}

function notificationFromRow(row: Row): BoardNotification {
  return parseBoardNotification(
    {
      notificationId: row.notification_id,
      sequence: numberValue(row, "sequence"),
      kind: row.kind,
      dedupeKey: row.dedupe_key,
      projectId: row.project_id,
      workItemId: row.work_item_id,
      summary: row.summary,
      createdAt: row.created_at,
      readAt: row.read_at,
      version: numberValue(row, "version"),
    },
    "notification"
  );
}

export class NotificationsCollaborator {
  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly delivery: NotificationDeliveryAdapter = IN_APP_NOTIFICATION_DELIVERY_ADAPTER
  ) {}

  insertNotificationInTransaction(input: InsertNotificationInput): BoardNotification | null {
    return this.insertNotificationAtInTransaction(input, exactNow(this.runtime.config.now));
  }

  insertNotificationAtInTransaction(input: InsertNotificationInput, createdAt: string): BoardNotification | null {
    if (!this.runtime.store.hasOpenTransaction) {
      throw new TaskBoardError(
        500,
        "NOTIFICATION_TRANSACTION_REQUIRED",
        "notification inserts require an open store transaction"
      );
    }
    if (!exactIsoTimestamp(createdAt)) throw new Error("TASK_BOARD_CLOCK_INVALID");
    const notificationId = randomUUID();
    const next = this.runtime.store.db
      .prepare(
        `
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM notifications
    `
      )
      .get() as Row;
    const sequence = numberValue(next, "sequence");
    if (sequence < 1) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:notification_sequence");
    }
    const inserted = this.runtime.store.db
      .prepare(
        `
      INSERT OR IGNORE INTO notifications(
        notification_id, sequence, kind, dedupe_key, project_id, work_item_id,
        summary, created_at, read_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
    `
      )
      .run(
        notificationId,
        sequence,
        input.kind,
        input.dedupeKey,
        input.projectId,
        input.workItemId,
        input.summary,
        createdAt
      );
    if (Number(inserted.changes) !== 1) {
      if (
        input.dedupeKey !== null &&
        this.runtime.store.db.prepare("SELECT 1 FROM notifications WHERE dedupe_key=?").get(input.dedupeKey) !==
          undefined
      ) {
        return null;
      }
      throw new Error("TASK_BOARD_NOTIFICATION_INSERT_IGNORED");
    }
    const row = this.runtime.store.db
      .prepare("SELECT * FROM notifications WHERE notification_id=?")
      .get(notificationId) as Row | undefined;
    if (row === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:notification_insert_missing");
    const notification = notificationFromRow(row);
    this.runtime.store.afterCommit(() => this.delivery.deliver(notification));
    return notification;
  }

  listNotifications(): NotificationList {
    const unread = this.runtime.store.db
      .prepare(
        `
      SELECT * FROM notifications
      WHERE read_at IS NULL
      ORDER BY sequence DESC
      LIMIT 100
    `
      )
      .all()
      .map((row) => notificationFromRow(row));
    const recentRead = this.runtime.store.db
      .prepare(
        `
      SELECT * FROM notifications
      WHERE read_at IS NOT NULL
      ORDER BY read_at DESC, sequence DESC
      LIMIT 50
    `
      )
      .all()
      .map((row) => notificationFromRow(row));
    return Object.freeze({
      unread: Object.freeze(unread),
      recentRead: Object.freeze(recentRead),
    });
  }

  markNotificationRead(notificationId: string, version: number): BoardNotification {
    return this.runtime.store.transaction(() => {
      const currentRow = this.runtime.store.db
        .prepare("SELECT * FROM notifications WHERE notification_id=?")
        .get(notificationId) as Row | undefined;
      if (currentRow === undefined) {
        throw new TaskBoardError(
          404,
          TASK_BOARD_ERROR_CODES.TASK_BOARD_NOTIFICATION_NOT_FOUND,
          "Notification was not found"
        );
      }
      const current = notificationFromRow(currentRow);
      if (current.version !== version) {
        throw conflict("NOTIFICATION_VERSION_CONFLICT", "Notification version changed");
      }
      const updated = this.runtime.store.db
        .prepare(
          `
        UPDATE notifications
        SET read_at=?, version=version+1
        WHERE notification_id=? AND version=?
      `
        )
        .run(exactNow(this.runtime.config.now), notificationId, version);
      if (Number(updated.changes) !== 1) {
        throw conflict("NOTIFICATION_VERSION_CONFLICT", "Notification version changed");
      }
      const row = this.runtime.store.db
        .prepare("SELECT * FROM notifications WHERE notification_id=?")
        .get(notificationId) as Row | undefined;
      if (row === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:notification_read_missing");
      return notificationFromRow(row);
    });
  }
}
