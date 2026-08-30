import type { BoardTask, TaskMessage } from "#shared/task-board-contract";
import { messageFromRow } from "../persistence/rows.js";
import type { TaskBoardRuntime } from "./runtime.js";

export interface ClaimTaskProjectionInputs {
  readonly task: BoardTask;
  readonly messages: readonly TaskMessage[];
  readonly messageCursor: number;
  readonly intake: boolean;
}

/** Reads the task-owned claim fields shared by live claims and readiness previews. */
export function claimTaskProjectionInputs(
  runtime: TaskBoardRuntime,
  taskId: string,
  cursor: number
): ClaimTaskProjectionInputs {
  const task = runtime.requireTask(taskId);
  const messages = runtime.store.db
    .prepare(
      `
    SELECT * FROM task_messages WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT 100
  `
    )
    .all(task.taskId, cursor)
    .map(messageFromRow);
  return Object.freeze({
    task,
    messages: Object.freeze(messages),
    messageCursor: messages.at(-1)?.sequence ?? cursor,
    intake:
      runtime.store.db.prepare("SELECT 1 FROM work_item_planning_tasks WHERE task_id = ?").get(task.taskId) !==
      undefined,
  });
}
