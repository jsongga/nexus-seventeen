import {
  TASK_BOARD_ERROR_CODES,
  isTerminalWorkItemState,
  isWorkItemTransitionAllowed,
  type WorkItemStage,
  type WorkItemState,
} from "#shared/task-board-contract";
import { conflict, TaskBoardError } from "../errors.js";
import type { TaskBoardStore } from "../persistence/store.js";

const STORES_BY_DATABASE = new WeakMap<TaskBoardStore["db"], TaskBoardStore>();

export interface WorkItemTransitionRequest {
  readonly workItemId: string;
  readonly to: WorkItemState;
  readonly actorType: "human" | "agent" | "system";
  readonly actorId: string;
  readonly now: string;
  readonly endedAt?: string;
  readonly cancelledReason?: string | null;
  readonly currentStage?: WorkItemStage | null;
  /** Another work-item column was changed earlier in this transaction. */
  readonly touch?: boolean;
}

export interface InitialWorkItemTransitionRequest {
  readonly workItemId: string;
  readonly actorType: "human" | "agent" | "system";
  readonly actorId: string;
  readonly now: string;
}

export function workItemStateForStage(
  stage: WorkItemStage | null,
  options: Readonly<{ fixLoop?: boolean }> = {},
): WorkItemState {
  if (stage === "implementation") return options.fixLoop === true ? "fixing" : "implementing";
  if (stage === "deployment") return "implementing";
  if (stage === "testing") return "verifying";
  if (stage === "verification") return "reviewing";
  return "planning";
}

export function workItemStateForNodeStage(
  db: TaskBoardStore["db"],
  nodeId: string | null,
  stage: WorkItemStage | null,
): WorkItemState {
  const fixLoop = stage === "implementation" && nodeId !== null && db.prepare(`
    SELECT 1 FROM review_findings WHERE node_id=? AND blocking=1 LIMIT 1
  `).get(nodeId) !== undefined;
  return workItemStateForStage(stage, { fixLoop });
}

export function registerWorkItemTransitionStore(store: TaskBoardStore): void {
  STORES_BY_DATABASE.set(store.db, store);
}

export function workItemTransitionStoreForDatabase(db: TaskBoardStore["db"]): TaskBoardStore {
  const store = STORES_BY_DATABASE.get(db);
  if (store === undefined) throw new Error("TASK_BOARD_TRANSITION_STORE_NOT_REGISTERED");
  return store;
}

function assertInStoreTransaction(store: TaskBoardStore): void {
  if (!store.hasOpenTransaction) {
    throw new TaskBoardError(
      500,
      "WORK_ITEM_TRANSACTION_REQUIRED",
      "work-item transitions require an open store transaction",
    );
  }
}

export function recordInitialWorkItemTransitionInTransaction(
  store: TaskBoardStore,
  request: InitialWorkItemTransitionRequest,
): void {
  assertInStoreTransaction(store);
  const row = store.db.prepare("SELECT state FROM work_items WHERE work_item_id = ?").get(request.workItemId) as
    | Readonly<{ state: WorkItemState }>
    | undefined;
  if (row === undefined) throw new TaskBoardError(404, "WORK_ITEM_NOT_FOUND", "Work item was not found");
  if (row.state !== "queued") {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:work_item_initial_transition_state");
  }
  store.db.prepare(`
    INSERT INTO work_item_transitions(
      work_item_id, sequence, from_state, to_state, actor_type, actor_id, created_at
    ) VALUES (?, 1, NULL, 'queued', ?, ?, ?)
  `).run(request.workItemId, request.actorType, request.actorId, request.now);
}

export function transitionWorkItemInTransaction(
  store: TaskBoardStore,
  request: WorkItemTransitionRequest,
): { fromState: WorkItemState; version: number } {
  assertInStoreTransaction(store);
  const row = store.db.prepare(`
    SELECT state, current_stage, cancelled_reason, version
    FROM work_items
    WHERE work_item_id = ?
  `).get(request.workItemId) as Readonly<{
    state: WorkItemState;
    current_stage: WorkItemStage | null;
    cancelled_reason: string | null;
    version: number;
  }> | undefined;
  if (row === undefined) throw new TaskBoardError(404, "WORK_ITEM_NOT_FOUND", "Work item was not found");

  const terminal = isTerminalWorkItemState(request.to);
  if (terminal && request.endedAt === undefined) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Terminal work-item transitions require endedAt");
  }
  if (!terminal && request.endedAt !== undefined) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Non-terminal work-item transitions forbid endedAt");
  }
  if (request.to !== "abandoned" && request.cancelledReason !== undefined) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "cancelledReason is only valid for abandoned work items");
  }

  const fromState = row.state;
  if (request.to === fromState) {
    const stageChanged = request.currentStage !== undefined && request.currentStage !== row.current_stage;
    const reasonChanged = request.cancelledReason !== undefined && request.cancelledReason !== row.cancelled_reason;
    if (!stageChanged && !reasonChanged && request.touch !== true) {
      return { fromState, version: row.version };
    }
    const version = row.version + 1;
    const update = store.db.prepare(`
      UPDATE
        work_items
      SET
        current_stage = CASE WHEN ? = 1 THEN ? ELSE current_stage END,
        cancelled_reason = CASE WHEN ? = 1 THEN ? ELSE cancelled_reason END,
        version = ?,
        updated_at = ?
      WHERE work_item_id = ? AND version = ?
    `).run(
      request.currentStage === undefined ? 0 : 1,
      request.currentStage ?? null,
      request.cancelledReason === undefined ? 0 : 1,
      request.cancelledReason ?? null,
      version,
      request.now,
      request.workItemId,
      row.version,
    );
    if (Number(update.changes) !== 1) {
      throw conflict("WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
    }
    return { fromState, version };
  }
  if (!isWorkItemTransitionAllowed(fromState, request.to)) {
    throw conflict(
      TASK_BOARD_ERROR_CODES.WORK_ITEM_ILLEGAL_TRANSITION,
      `work item cannot move ${fromState} -> ${request.to}`,
    );
  }

  const version = row.version + 1;
  const update = store.db.prepare(`
    UPDATE work_items SET
      state = ?,
      ended_at = ?,
      cancelled_reason = ?,
      current_stage = CASE WHEN ? = 1 THEN ? ELSE current_stage END,
      version = ?,
      updated_at = ?
    WHERE work_item_id = ? AND version = ?
  `).run(
    request.to,
    request.endedAt ?? null,
    request.to === "abandoned" ? request.cancelledReason ?? null : null,
    request.currentStage === undefined ? 0 : 1,
    request.currentStage ?? null,
    version,
    request.now,
    request.workItemId,
    row.version,
  );
  if (Number(update.changes) !== 1) {
    throw conflict("WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
  }
  store.db.prepare(`
    INSERT INTO work_item_transitions(
      work_item_id, sequence, from_state, to_state, actor_type, actor_id, created_at
    ) VALUES (
      ?,
      1 + COALESCE((SELECT MAX(sequence) FROM work_item_transitions WHERE work_item_id = ?), 0),
      ?, ?, ?, ?, ?
    )
  `).run(
    request.workItemId,
    request.workItemId,
    fromState,
    request.to,
    request.actorType,
    request.actorId,
    request.now,
  );
  return { fromState, version };
}
