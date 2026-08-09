import type { TaskStatus } from "#shared/task-board-contract";

export function exactNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error("TASK_BOARD_CLOCK_INVALID");
  return value.toISOString();
}

export function exactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function expectedCompletedAt(
  status: TaskStatus,
  startedAt: string | null,
  estimateRecordedAt: string | null,
  minutes: number | null,
): string | null {
  if (status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled") return null;
  if (startedAt === null || estimateRecordedAt === null || minutes === null) return null;
  const anchor = Math.max(Date.parse(startedAt), Date.parse(estimateRecordedAt));
  const raw = anchor + minutes * 60_000;
  const interval = 15 * 60_000;
  const milliseconds = Math.ceil(raw / interval) * interval;
  if (!Number.isSafeInteger(milliseconds)) throw new Error("TASK_BOARD_TIME_RANGE_INVALID");
  return new Date(milliseconds).toISOString();
}
