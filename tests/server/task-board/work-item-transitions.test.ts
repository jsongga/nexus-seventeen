import assert from "node:assert/strict";
import test from "node:test";
import type { WorkItemState } from "#shared/task-board-contract";
import { TaskBoardError } from "#server/task-board/errors";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import {
  transitionWorkItemInTransaction,
  workItemStateForStage,
} from "#server/task-board/collaborators/work-item-transitions";
import { databasePath } from "./helpers.js";

const CREATED_AT = "2026-08-15T12:00:00.000Z";

type TransitionRow = Readonly<{
  sequence: number;
  from_state: WorkItemState | null;
  to_state: WorkItemState;
  actor_type: "human" | "agent" | "system";
  actor_id: string;
  created_at: string;
}>;

async function transitionFixture(options: Readonly<{
  initialState?: WorkItemState;
  initialStage?: string | null;
  withInitialTransition?: boolean;
}> = {}): Promise<Readonly<{ store: TaskBoardStore; workItemId: string }>> {
  const store = await TaskBoardStore.open(await databasePath());
  const workItemId = "transition-helper-item";
  const initialState = options.initialState ?? "queued";
  const terminal = initialState === "merged" || initialState === "abandoned" || initialState === "dead_letter";
  store.db.prepare(`
    INSERT INTO work_items(
      work_item_id, original_request, refined_objective, priority,
      project_target_mode, target_project_id, resolved_project_id,
      state, current_stage, created_by, idempotency_key, request_hash,
      version, created_at, updated_at, ended_at, cancelled_reason, archived_at
    ) VALUES (?, 'Exercise transition legality.', NULL, 'normal', 'auto', NULL, NULL,
      ?, ?, 'human:test', 'transition-helper-key', 'transition-helper-hash',
      1, ?, ?, ?, NULL, NULL)
  `).run(
    workItemId,
    initialState,
    options.initialStage === undefined ? "refinement" : options.initialStage,
    CREATED_AT,
    CREATED_AT,
    terminal ? CREATED_AT : null,
  );
  if (options.withInitialTransition ?? true) {
    store.db.prepare(`
      INSERT INTO work_item_transitions(
        work_item_id, sequence, from_state, to_state, actor_type, actor_id, created_at
      ) VALUES (?, 1, NULL, ?, 'human', 'human:test', ?)
    `).run(workItemId, initialState, CREATED_AT);
  }
  return Object.freeze({ store, workItemId });
}

function workItemRow(store: TaskBoardStore, workItemId: string) {
  const row = store.db.prepare(`
    SELECT state, current_stage, refined_objective, version, updated_at, ended_at, cancelled_reason
    FROM work_items WHERE work_item_id = ?
  `).get(workItemId) as Readonly<{
    state: WorkItemState;
    current_stage: string | null;
    refined_objective: string | null;
    version: number;
    updated_at: string;
    ended_at: string | null;
    cancelled_reason: string | null;
  }>;
  return { ...row };
}

function transitionRows(store: TaskBoardStore, workItemId: string): readonly TransitionRow[] {
  const rows = store.db.prepare(`
    SELECT sequence, from_state, to_state, actor_type, actor_id, created_at
    FROM work_item_transitions WHERE work_item_id = ? ORDER BY sequence
  `).all(workItemId) as unknown as readonly TransitionRow[];
  return rows.map((row) => ({ ...row }));
}

test("an allowed work-item edge bumps the version and appends its actor-attributed transition", async () => {
  const { store, workItemId } = await transitionFixture();
  try {
    const result = store.transaction(() => transitionWorkItemInTransaction(store, {
      workItemId,
      to: "planning",
      actorType: "system",
      actorId: "system:planning",
      now: "2026-08-15T12:01:00.000Z",
      currentStage: "planning",
    }));

    assert.deepEqual(result, { fromState: "queued", version: 2 });
    assert.deepEqual(workItemRow(store, workItemId), {
      state: "planning",
      current_stage: "planning",
      refined_objective: null,
      version: 2,
      updated_at: "2026-08-15T12:01:00.000Z",
      ended_at: null,
      cancelled_reason: null,
    });
    assert.deepEqual(transitionRows(store, workItemId), [
      {
        sequence: 1,
        from_state: null,
        to_state: "queued",
        actor_type: "human",
        actor_id: "human:test",
        created_at: CREATED_AT,
      },
      {
        sequence: 2,
        from_state: "queued",
        to_state: "planning",
        actor_type: "system",
        actor_id: "system:planning",
        created_at: "2026-08-15T12:01:00.000Z",
      },
    ]);
  } finally {
    store.close();
  }
});

test("an illegal work-item edge changes neither the row nor transition history", async () => {
  const { store, workItemId } = await transitionFixture();
  try {
    const before = workItemRow(store, workItemId);
    assert.throws(
      () => store.transaction(() => transitionWorkItemInTransaction(store, {
        workItemId,
        to: "merged",
        actorType: "agent",
        actorId: "agent:test",
        now: "2026-08-15T12:01:00.000Z",
        endedAt: "2026-08-15T12:01:00.000Z",
      })),
      (error: unknown) => (
        error instanceof TaskBoardError &&
        error.status === 409 &&
        error.code === "WORK_ITEM_ILLEGAL_TRANSITION" &&
        error.message === "work item cannot move queued -> merged"
      ),
    );
    assert.deepEqual(workItemRow(store, workItemId), before);
    assert.equal(transitionRows(store, workItemId).length, 1);
  } finally {
    store.close();
  }
});

test("a terminal work item rejects a later transition and appends nothing", async () => {
  const { store, workItemId } = await transitionFixture({ initialState: "merged", initialStage: null });
  try {
    const before = workItemRow(store, workItemId);
    assert.throws(
      () => store.transaction(() => transitionWorkItemInTransaction(store, {
        workItemId,
        to: "planning",
        actorType: "system",
        actorId: "system:reconcile",
        now: "2026-08-15T12:01:00.000Z",
        currentStage: "planning",
      })),
      (error: unknown) => (
        error instanceof TaskBoardError &&
        error.code === "WORK_ITEM_ILLEGAL_TRANSITION" &&
        error.message === "work item cannot move merged -> planning"
      ),
    );
    assert.deepEqual(workItemRow(store, workItemId), before);
    assert.equal(transitionRows(store, workItemId).length, 1);
  } finally {
    store.close();
  }
});

test("terminal targets require endedAt and non-terminal targets reject it", async () => {
  const { store, workItemId } = await transitionFixture();
  try {
    assert.throws(() => store.transaction(() => transitionWorkItemInTransaction(store, {
      workItemId,
      to: "abandoned",
      actorType: "human",
      actorId: "human:test",
      now: "2026-08-15T12:01:00.000Z",
      cancelledReason: "No longer needed",
    })), TaskBoardError);
    assert.throws(() => store.transaction(() => transitionWorkItemInTransaction(store, {
      workItemId,
      to: "planning",
      actorType: "human",
      actorId: "human:test",
      now: "2026-08-15T12:01:00.000Z",
      endedAt: "2026-08-15T12:01:00.000Z",
    })), TaskBoardError);
    assert.equal(workItemRow(store, workItemId).version, 1);
    assert.equal(transitionRows(store, workItemId).length, 1);
  } finally {
    store.close();
  }
});

test("a same-state request without stage or reason changes is an idempotent no-op", async () => {
  const { store, workItemId } = await transitionFixture();
  try {
    const result = store.transaction(() => transitionWorkItemInTransaction(store, {
      workItemId,
      to: "queued",
      actorType: "system",
      actorId: "system:reconcile",
      now: "2026-08-15T12:01:00.000Z",
    }));
    assert.deepEqual(result, { fromState: "queued", version: 1 });
    assert.equal(workItemRow(store, workItemId).updated_at, CREATED_AT);
    assert.equal(transitionRows(store, workItemId).length, 1);
  } finally {
    store.close();
  }
});

test("a same-state touch bumps the version for caller-changed columns without appending history", async () => {
  const { store, workItemId } = await transitionFixture();
  try {
    const result = store.transaction(() => {
      store.db.prepare("UPDATE work_items SET refined_objective = ? WHERE work_item_id = ?")
        .run("A revised objective.", workItemId);
      return transitionWorkItemInTransaction(store, {
        workItemId,
        to: "queued",
        actorType: "human",
        actorId: "human:test",
        now: "2026-08-15T12:02:00.000Z",
        touch: true,
      });
    });
    assert.deepEqual(result, { fromState: "queued", version: 2 });
    assert.equal(workItemRow(store, workItemId).refined_objective, "A revised objective.");
    assert.equal(workItemRow(store, workItemId).updated_at, "2026-08-15T12:02:00.000Z");
    assert.equal(transitionRows(store, workItemId).length, 1);
  } finally {
    store.close();
  }
});

test("a same-state touch applies an abandoned cancellation reason without appending history", async () => {
  const { store, workItemId } = await transitionFixture({ initialState: "abandoned", initialStage: null });
  try {
    const result = store.transaction(() => transitionWorkItemInTransaction(store, {
      workItemId,
      to: "abandoned",
      actorType: "human",
      actorId: "human:test",
      now: "2026-08-15T12:02:00.000Z",
      endedAt: CREATED_AT,
      cancelledReason: "The operator supplied the missing reason.",
    }));
    assert.deepEqual(result, { fromState: "abandoned", version: 2 });
    assert.equal(workItemRow(store, workItemId).cancelled_reason, "The operator supplied the missing reason.");
    assert.equal(transitionRows(store, workItemId).length, 1);
  } finally {
    store.close();
  }
});

test("the transition helper rejects calls outside a store transaction", async () => {
  const { store, workItemId } = await transitionFixture();
  try {
    assert.throws(() => transitionWorkItemInTransaction(store, {
      workItemId,
      to: "planning",
      actorType: "system",
      actorId: "system:planning",
      now: "2026-08-15T12:01:00.000Z",
    }), (error: unknown) => (
      error instanceof TaskBoardError &&
      error.status === 500 &&
      error.code === "WORK_ITEM_TRANSACTION_REQUIRED" &&
      error.message === "work-item transitions require an open store transaction"
    ));
    assert.equal(workItemRow(store, workItemId).version, 1);
    assert.equal(transitionRows(store, workItemId).length, 1);
  } finally {
    store.close();
  }
});

test("successive work-item transitions use per-item sequences 1, 2, and 3", async () => {
  const { store, workItemId } = await transitionFixture();
  try {
    store.transaction(() => transitionWorkItemInTransaction(store, {
      workItemId,
      to: "planning",
      actorType: "system",
      actorId: "system:planning",
      now: "2026-08-15T12:01:00.000Z",
      currentStage: "planning",
    }));
    store.transaction(() => transitionWorkItemInTransaction(store, {
      workItemId,
      to: "plan_approval",
      actorType: "agent",
      actorId: "manager:test",
      now: "2026-08-15T12:02:00.000Z",
      currentStage: "human_review",
    }));

    assert.deepEqual(transitionRows(store, workItemId).map((row) => row.sequence), [1, 2, 3]);
    assert.deepEqual(transitionRows(store, workItemId).map((row) => row.to_state), [
      "queued",
      "planning",
      "plan_approval",
    ]);
  } finally {
    store.close();
  }
});

test("workflow stages map to the v19 work-item pipeline states", () => {
  assert.deepEqual([
    workItemStateForStage("refinement"),
    workItemStateForStage("project_resolution"),
    workItemStateForStage("research"),
    workItemStateForStage("planning"),
    workItemStateForStage("implementation"),
    workItemStateForStage("deployment"),
    workItemStateForStage("testing"),
    workItemStateForStage("verification"),
    workItemStateForStage("human_review"),
    workItemStateForStage(null),
  ], [
    "planning",
    "planning",
    "planning",
    "planning",
    "implementing",
    "implementing",
    "verifying",
    "reviewing",
    "planning",
    "planning",
  ]);
});

test("plan approval reaches reviewing in exactly one stage-mapped transition", async () => {
  const { store, workItemId } = await transitionFixture({
    initialState: "plan_approval",
    initialStage: "human_review",
  });
  try {
    const result = store.transaction(() => transitionWorkItemInTransaction(store, {
      workItemId,
      to: workItemStateForStage("verification"),
      actorType: "system",
      actorId: "system:workflow",
      now: "2026-08-15T12:03:00.000Z",
      currentStage: "verification",
    }));
    assert.deepEqual(result, { fromState: "plan_approval", version: 2 });
    assert.deepEqual(transitionRows(store, workItemId).map((row) => row.to_state), [
      "plan_approval",
      "reviewing",
    ]);
    assert.equal(workItemRow(store, workItemId).current_stage, "verification");
  } finally {
    store.close();
  }
});

test("parked reaches verifying in exactly one stage-mapped transition", async () => {
  const { store, workItemId } = await transitionFixture({
    initialState: "parked",
    initialStage: "testing",
  });
  try {
    const result = store.transaction(() => transitionWorkItemInTransaction(store, {
      workItemId,
      to: workItemStateForStage("testing"),
      actorType: "human",
      actorId: "human:test",
      now: "2026-08-15T12:03:00.000Z",
      currentStage: "testing",
    }));
    assert.deepEqual(result, { fromState: "parked", version: 2 });
    assert.deepEqual(transitionRows(store, workItemId).map((row) => row.to_state), [
      "parked",
      "verifying",
    ]);
  } finally {
    store.close();
  }
});

test("a stage-only move inside one mapped state bumps version without appending a state transition", async () => {
  const { store, workItemId } = await transitionFixture({
    initialState: "planning",
    initialStage: "research",
  });
  try {
    const result = store.transaction(() => transitionWorkItemInTransaction(store, {
      workItemId,
      to: workItemStateForStage("planning"),
      actorType: "system",
      actorId: "system:workflow",
      now: "2026-08-15T12:04:00.000Z",
      currentStage: "planning",
    }));
    assert.deepEqual(result, { fromState: "planning", version: 2 });
    assert.equal(workItemRow(store, workItemId).current_stage, "planning");
    assert.equal(transitionRows(store, workItemId).length, 1);
  } finally {
    store.close();
  }
});
