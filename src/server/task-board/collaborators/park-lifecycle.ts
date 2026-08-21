import type { ParkCategory, WorkItemState } from "#shared/task-board-contract";
import type { Row } from "../persistence/rows.js";
import { exactIsoTimestamp } from "../persistence/timestamps.js";
import type { TaskBoardRuntime } from "./runtime.js";
import type { NotificationsCollaborator } from "./notifications.js";
import { transitionWorkItemInTransaction } from "./work-item-transitions.js";

interface OpenParkRecord {
  readonly parkRecordId: string;
  readonly workItemId: string;
  readonly category: ParkCategory;
  readonly reason: string;
  readonly parkedAt: string;
  readonly projectId: string | null;
}

export interface ParkLifecycleSweepResult {
  readonly notified: number;
  readonly autoAbandoned: number;
}

function openParkRecordFromRow(row: Row): OpenParkRecord {
  if (
    typeof row.park_record_id !== "string"
    || typeof row.work_item_id !== "string"
    || typeof row.category !== "string"
    || typeof row.reason !== "string"
    || typeof row.parked_at !== "string"
    || (row.project_id !== null && typeof row.project_id !== "string")
  ) {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:open_park_record");
  }
  return Object.freeze({
    parkRecordId: row.park_record_id,
    workItemId: row.work_item_id,
    category: row.category as ParkCategory,
    reason: row.reason,
    parkedAt: row.parked_at,
    projectId: row.project_id,
  });
}

function humanAge(ageSeconds: number): string {
  const units = [
    { seconds: 86_400, singular: "day" },
    { seconds: 3_600, singular: "hour" },
    { seconds: 60, singular: "minute" },
    { seconds: 1, singular: "second" },
  ] as const;
  for (const unit of units) {
    if (ageSeconds < unit.seconds) continue;
    const count = Math.floor(ageSeconds / unit.seconds);
    return `${count} ${unit.singular}${count === 1 ? "" : "s"}`;
  }
  return "0 seconds";
}

function notificationSummary(record: OpenParkRecord, nowMilliseconds: number): string {
  const parkedMilliseconds = Date.parse(record.parkedAt);
  if (!Number.isFinite(parkedMilliseconds)) {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:parked_at");
  }
  const ageSeconds = Math.max(0, Math.floor((nowMilliseconds - parkedMilliseconds) / 1_000));
  return `Work item parked ${humanAge(ageSeconds)} (${record.category}): ${record.reason.slice(0, 200)}`;
}

export class ParkLifecycleCollaborator {
  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly notifications: NotificationsCollaborator,
  ) {}

  sweepParkLifecycle(now: string): ParkLifecycleSweepResult {
    if (!exactIsoTimestamp(now)) throw new Error("TASK_BOARD_CLOCK_INVALID");
    const nowMilliseconds = Date.parse(now);
    const openRecords = () => this.runtime.store.db.prepare(`
      SELECT
        park_record.park_record_id,
        park_record.work_item_id,
        park_record.category,
        park_record.reason,
        park_record.parked_at,
        work_item.resolved_project_id AS project_id
      FROM park_records AS park_record
      JOIN work_items AS work_item ON work_item.work_item_id=park_record.work_item_id
      WHERE park_record.resolved_at IS NULL
      ORDER BY park_record.parked_at, park_record.rowid
    `).all().map((row) => openParkRecordFromRow(row));
    let notified = 0;
    if (this.runtime.config.parkNotifySeconds !== 0) {
      for (const record of openRecords()) {
        const ageSeconds = (nowMilliseconds - Date.parse(record.parkedAt)) / 1_000;
        if (!Number.isFinite(ageSeconds)) throw new Error("TASK_BOARD_DATABASE_CORRUPT:parked_at");
        if (ageSeconds <= this.runtime.config.parkNotifySeconds) continue;
        const inserted = this.runtime.store.transaction(() => {
          const stillOpen = this.runtime.store.db.prepare(`
            SELECT 1 FROM park_records WHERE park_record_id=? AND resolved_at IS NULL
          `).get(record.parkRecordId);
          if (stillOpen === undefined) return null;
          return this.notifications.insertNotificationAtInTransaction({
            kind: "park_aged",
            dedupeKey: `park_aged:${record.parkRecordId}`,
            projectId: record.projectId,
            workItemId: record.workItemId,
            summary: notificationSummary(record, nowMilliseconds),
          }, now);
        });
        if (inserted !== null) notified += 1;
      }
    }

    let autoAbandoned = 0;
    if (this.runtime.config.parkAutoAbandonSeconds !== 0) {
      for (const record of openRecords()) {
        const ageSeconds = (nowMilliseconds - Date.parse(record.parkedAt)) / 1_000;
        if (!Number.isFinite(ageSeconds)) throw new Error("TASK_BOARD_DATABASE_CORRUPT:parked_at");
        if (ageSeconds <= this.runtime.config.parkAutoAbandonSeconds) continue;
        const abandoned = this.runtime.store.transaction(() => {
          const current = this.runtime.store.db.prepare(`
            SELECT
              park_record.park_record_id,
              park_record.work_item_id,
              park_record.category,
              park_record.reason,
              park_record.parked_at,
              work_item.resolved_project_id AS project_id,
              work_item.state
            FROM park_records AS park_record
            JOIN work_items AS work_item ON work_item.work_item_id=park_record.work_item_id
            WHERE park_record.park_record_id=? AND park_record.resolved_at IS NULL
          `).get(record.parkRecordId) as (Row & Readonly<{ state: WorkItemState }>) | undefined;
          if (current === undefined || current.state !== "parked") return false;
          const currentRecord = openParkRecordFromRow(current);
          transitionWorkItemInTransaction(this.runtime.store, {
            workItemId: currentRecord.workItemId,
            to: "abandoned",
            actorType: "system",
            actorId: "system:park-lifecycle",
            now,
            endedAt: now,
            cancelledReason: `parked past auto-abandon threshold (${currentRecord.category})`,
            currentStage: null,
          });
          this.notifications.insertNotificationAtInTransaction({
            kind: "park_auto_abandoned",
            dedupeKey: `park_auto_abandoned:${currentRecord.parkRecordId}`,
            projectId: currentRecord.projectId,
            workItemId: currentRecord.workItemId,
            summary: notificationSummary(currentRecord, nowMilliseconds),
          }, now);
          return true;
        });
        if (abandoned) autoAbandoned += 1;
      }
    }
    return Object.freeze({ notified, autoAbandoned });
  }
}
