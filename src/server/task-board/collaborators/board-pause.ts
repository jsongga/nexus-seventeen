import { TASK_BOARD_ERROR_CODES, type BoardPause } from "#shared/task-board-contract";
import { parseBoardPause } from "#shared/task-board-contract/validate";
import { redactForPersistence } from "../../shared/redact.js";
import { conflict } from "../errors.js";
import { exactNow } from "../persistence/timestamps.js";
import type { TaskBoardRuntime } from "./board-runtime.js";

type Row = Record<string, unknown>;

function boardPauseFromRow(row: Row): BoardPause {
  return parseBoardPause(
    {
      paused: row.paused === 1,
      reason: row.reason,
      version: row.version,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    },
    "boardPause"
  );
}

export class BoardPauseCollaborator {
  constructor(private readonly runtime: TaskBoardRuntime) {}

  getBoardPause(): BoardPause {
    const row = this.runtime.store.db
      .prepare(
        `
      SELECT paused,reason,version,updated_at,updated_by
      FROM board_pause
      WHERE pause_id='board'
    `
      )
      .get() as Row | undefined;
    if (row === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:board_pause_missing");
    return boardPauseFromRow(row);
  }

  setBoardPause(input: { paused: boolean; reason: string | null; version: number; actor: string }): BoardPause {
    return this.runtime.store.transaction(() => {
      const now = exactNow(this.runtime.config.now);
      const reason = input.reason === null ? null : redactForPersistence(input.reason);
      const update = this.runtime.store.db
        .prepare(
          `
        UPDATE board_pause
        SET paused=?,reason=?,version=version+1,updated_at=?,updated_by=?
        WHERE pause_id='board' AND version=?
      `
        )
        .run(input.paused ? 1 : 0, reason, now, input.actor, input.version);
      if (Number(update.changes) !== 1) {
        throw conflict(TASK_BOARD_ERROR_CODES.TASK_BOARD_BOARD_PAUSE_VERSION_CONFLICT, "Board pause version changed");
      }
      return this.getBoardPause();
    });
  }

  isBoardPaused(): boolean {
    const row = this.runtime.store.db.prepare("SELECT paused FROM board_pause WHERE pause_id='board'").get() as
      | Row
      | undefined;
    if (row === undefined || (row.paused !== 0 && row.paused !== 1)) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:board_pause");
    }
    return row.paused === 1;
  }
}
