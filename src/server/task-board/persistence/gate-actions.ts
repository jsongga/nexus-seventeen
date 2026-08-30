import { randomUUID } from "node:crypto";
import type { GateAction } from "#shared/task-board-contract";
import { parseGateAction } from "#shared/task-board-contract/validate";
import { redactForPersistence } from "../../shared/redact.js";
import type { TaskBoardStore } from "./store.js";
import { exactNow } from "./timestamps.js";
import { TaskBoardError } from "../errors.js";

export type GateActionInput = Omit<GateAction, "gateActionId" | "createdAt">;

export class GateActionWriter {
  constructor(
    private readonly store: TaskBoardStore,
    private readonly now: () => Date
  ) {}

  insertGateActionInTransaction(input: GateActionInput): GateAction {
    if (!this.store.hasOpenTransaction) {
      throw new TaskBoardError(
        500,
        "GATE_ACTION_TRANSACTION_REQUIRED",
        "gate-action inserts require an open store transaction"
      );
    }
    const action = parseGateAction(
      {
        ...input,
        gateActionId: randomUUID(),
        note: input.note === null ? null : redactForPersistence(input.note, 2_000),
        createdAt: exactNow(this.now),
      },
      "gateAction"
    );
    this.store.db
      .prepare(
        `
      INSERT INTO gate_actions(
        gate_action_id, work_item_id, gate, actor_id, plan_revision_id,
        verified_sha, merge_sha, ref_id, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        action.gateActionId,
        action.workItemId,
        action.gate,
        action.actorId,
        action.planRevisionId,
        action.verifiedSha,
        action.mergeSha,
        action.refId,
        action.note,
        action.createdAt
      );
    return action;
  }
}
