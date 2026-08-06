import { WORK_ITEM_CURSOR_MAX_BYTES } from "#shared/task-board-contract";
import { canonicalJson } from "../canonical.js";
import { TaskBoardError } from "../errors.js";
import { exactIsoTimestamp } from "./timestamps.js";
import { numberValue, stringValue, type Row } from "./rows.js";

interface WorkItemCursorTuple {
  readonly version: 1;
  readonly terminalRank: 0 | 1;
  readonly priorityRank: 0 | 1 | 2 | 3 | 4;
  readonly createdAt: string;
  readonly workItemId: string;
}

function invalidWorkItemCursor(): TaskBoardError {
  return new TaskBoardError(400, "INVALID_REQUEST", "cursor is invalid");
}

export function decodeWorkItemCursor(value: string): WorkItemCursorTuple {
  if (
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > WORK_ITEM_CURSOR_MAX_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw invalidWorkItemCursor();
  }
  let bytes: Buffer;
  let text: string;
  let payload: unknown;
  try {
    bytes = Buffer.from(value, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== value) throw invalidWorkItemCursor();
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    payload = JSON.parse(text) as unknown;
  } catch {
    throw invalidWorkItemCursor();
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalidWorkItemCursor();
  }
  const item = payload as Record<string, unknown>;
  const actualKeys = Object.keys(item).sort();
  const expectedKeys = ["createdAt", "priorityRank", "terminalRank", "version", "workItemId"];
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    canonicalJson(item) !== text ||
    item.version !== 1 ||
    (item.terminalRank !== 0 && item.terminalRank !== 1) ||
    !Number.isSafeInteger(item.priorityRank) ||
    Number(item.priorityRank) < 0 ||
    Number(item.priorityRank) > 4 ||
    !exactIsoTimestamp(item.createdAt) ||
    typeof item.workItemId !== "string" ||
    item.workItemId.length < 1 ||
    item.workItemId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(item.workItemId)
  ) {
    throw invalidWorkItemCursor();
  }
  return Object.freeze({
    version: 1,
    terminalRank: item.terminalRank,
    priorityRank: Number(item.priorityRank) as WorkItemCursorTuple["priorityRank"],
    createdAt: item.createdAt,
    workItemId: item.workItemId,
  });
}

export function encodeWorkItemCursor(row: Row): string {
  const terminalRank = numberValue(row, "work_item_terminal_rank");
  const priorityRank = numberValue(row, "work_item_priority_rank");
  if ((terminalRank !== 0 && terminalRank !== 1) || priorityRank < 0 || priorityRank > 4) {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:work_item_cursor_rank");
  }
  const payload: WorkItemCursorTuple = Object.freeze({
    version: 1,
    terminalRank,
    priorityRank: priorityRank as WorkItemCursorTuple["priorityRank"],
    createdAt: stringValue(row, "created_at"),
    workItemId: stringValue(row, "work_item_id"),
  });
  const encoded = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > WORK_ITEM_CURSOR_MAX_BYTES) {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:work_item_cursor_size");
  }
  return encoded;
}
