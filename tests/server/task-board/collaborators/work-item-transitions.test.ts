import assert from "node:assert/strict";
import test from "node:test";
import { WORKFLOW_STAGES, isWorkItemTransitionAllowed, type WorkItemState } from "#shared/task-board-contract";
import { TaskBoardError } from "#server/task-board/errors";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import { TransparentWorkflow } from "#server/task-board/persistence/workflow";
import { SkillRegistry } from "#server/task-board/skills";
import {
  registerWorkItemTransitionStore,
  transitionWorkItemInTransaction,
  workItemStateForNodeStage,
  workItemStateForStage,
} from "#server/task-board/collaborators/work-item-transitions";
import { databasePath } from "../helpers.js";

const CREATED_AT = "2026-08-15T12:00:00.000Z";

type TransitionRow = Readonly<{
  sequence: number;
  from_state: WorkItemState | null;
  to_state: WorkItemState;
  actor_type: "human" | "agent" | "system";
  actor_id: string;
  created_at: string;
}>;

async function transitionFixture(
  options: Readonly<{
    initialState?: WorkItemState;
    initialStage?: string | null;
    withInitialTransition?: boolean;
  }> = {}
): Promise<Readonly<{ store: TaskBoardStore; workItemId: string }>> {
  const store = await TaskBoardStore.open(await databasePath());
  const workItemId = "transition-helper-item";
  const initialState = options.initialState ?? "queued";
  const terminal = initialState === "merged" || initialState === "abandoned" || initialState === "dead_letter";
  store.db
    .prepare(
      `
    INSERT INTO work_items(
      work_item_id, original_request, refined_objective, priority,
      project_target_mode, target_project_id, resolved_project_id,
      state, current_stage, created_by, idempotency_key, request_hash,
      version, created_at, updated_at, ended_at, cancelled_reason, archived_at
    ) VALUES (?, 'Exercise transition legality.', NULL, 'normal', 'auto', NULL, NULL,
      ?, ?, 'human:test', 'transition-helper-key', 'transition-helper-hash',
      1, ?, ?, ?, NULL, NULL)
  `
    )
    .run(
      workItemId,
      initialState,
      options.initialStage === undefined ? "refinement" : options.initialStage,
      CREATED_AT,
      CREATED_AT,
      terminal ? CREATED_AT : null
    );
  if (options.withInitialTransition ?? true) {
    store.db
      .prepare(
        `
      INSERT INTO work_item_transitions(
        work_item_id, sequence, from_state, to_state, actor_type, actor_id, created_at
      ) VALUES (?, 1, NULL, ?, 'human', 'human:test', ?)
    `
      )
      .run(workItemId, initialState, CREATED_AT);
  }
  return Object.freeze({ store, workItemId });
}

function workItemRow(store: TaskBoardStore, workItemId: string) {
  const row = store.db
    .prepare(
      `
    SELECT state, current_stage, refined_objective, version, updated_at, ended_at, cancelled_reason
    FROM work_items WHERE work_item_id = ?
  `
    )
    .get(workItemId) as Readonly<{
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
  const rows = store.db
    .prepare(
      `
    SELECT sequence, from_state, to_state, actor_type, actor_id, created_at
    FROM work_item_transitions WHERE work_item_id = ? ORDER BY sequence
  `
    )
    .all(workItemId) as unknown as readonly TransitionRow[];
  return rows.map((row) => ({ ...row }));
}

type ParkRecordRow = Readonly<{
  park_record_id: string;
  category: string;
  reason: string;
  parked_at: string;
  resolved_at: string | null;
  resolution: string | null;
}>;

function parkRecordRows(store: TaskBoardStore, workItemId: string): readonly ParkRecordRow[] {
  return (
    store.db
      .prepare(
        `
    SELECT park_record_id, category, reason, parked_at, resolved_at, resolution
    FROM park_records
    WHERE work_item_id = ?
    ORDER BY parked_at, rowid
  `
      )
      .all(workItemId) as unknown as readonly ParkRecordRow[]
  ).map((row) => ({ ...row }));
}

function seedOpenParkRecord(store: TaskBoardStore, workItemId: string, suffix: string): void {
  store.db
    .prepare(
      `
    INSERT INTO park_records(
      park_record_id, work_item_id, category, reason, parked_at, resolved_at, resolution
    ) VALUES (?, ?, 'open_question', 'test park', ?, NULL, NULL)
  `
    )
    .run(`park-record-${suffix}`, workItemId, CREATED_AT);
}

function seedRelatedWorkItem(store: TaskBoardStore, workItemId: string, parentWorkItemId: string | null = null): void {
  store.db
    .prepare(
      `
    INSERT INTO work_items(
      work_item_id, original_request, refined_objective, priority,
      project_target_mode, target_project_id, resolved_project_id, parent_work_item_id,
      state, current_stage, created_by, idempotency_key, request_hash,
      version, created_at, updated_at, ended_at, cancelled_reason, archived_at
    ) VALUES (?, 'Contextual transition fixture.', NULL, 'normal', 'auto', NULL, NULL, ?,
      'queued', 'refinement', 'human:test', ?, ?, 1, ?, ?, NULL, NULL, NULL)
  `
    )
    .run(workItemId, parentWorkItemId, `related-${workItemId}`, `related-hash-${workItemId}`, CREATED_AT, CREATED_AT);
}

test("decomposition-only edges allow their required context and reject ordinary items", async () => {
  const cases = [
    {
      from: "queued",
      to: "designing",
      relation: "child",
    },
    {
      from: "queued",
      to: "implementing",
      relation: "child",
    },
    {
      from: "coordinating",
      to: "merged",
      relation: "parent",
    },
    {
      from: "final_approval",
      to: "coordinating",
      relation: "parent",
    },
    {
      from: "parked",
      to: "coordinating",
      relation: "parent",
    },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    const allowed = await transitionFixture({ initialState: scenario.from, initialStage: null });
    try {
      if (scenario.relation === "child") {
        seedRelatedWorkItem(allowed.store, `context-parent-${index}`);
        allowed.store.db
          .prepare("UPDATE work_items SET parent_work_item_id=? WHERE work_item_id=?")
          .run(`context-parent-${index}`, allowed.workItemId);
      } else {
        seedRelatedWorkItem(allowed.store, `context-child-${index}`, allowed.workItemId);
      }
      const now = `2026-08-15T12:1${index}:00.000Z`;
      const result = allowed.store.transaction(() =>
        transitionWorkItemInTransaction(allowed.store, {
          workItemId: allowed.workItemId,
          to: scenario.to,
          actorType: "system",
          actorId: "system:decomposition-test",
          now,
          ...(scenario.to === "merged" ? { endedAt: now } : { currentStage: null }),
        })
      );
      assert.deepEqual(result, { fromState: scenario.from, version: 2 });
    } finally {
      allowed.store.close();
    }

    const denied = await transitionFixture({ initialState: scenario.from, initialStage: null });
    try {
      assert.throws(
        () =>
          denied.store.transaction(() =>
            transitionWorkItemInTransaction(denied.store, {
              workItemId: denied.workItemId,
              to: scenario.to,
              actorType: "system",
              actorId: "system:decomposition-test",
              now: `2026-08-15T12:2${index}:00.000Z`,
              ...(scenario.to === "merged" ? { endedAt: `2026-08-15T12:2${index}:00.000Z` } : { currentStage: null }),
            })
          ),
        (error: unknown) => error instanceof TaskBoardError && error.code === "WORK_ITEM_ILLEGAL_TRANSITION"
      );
      assert.equal(workItemRow(denied.store, denied.workItemId).state, scenario.from);
    } finally {
      denied.store.close();
    }
  }
});

test("an allowed work-item edge bumps the version and appends its actor-attributed transition", async () => {
  const { store, workItemId } = await transitionFixture();
  try {
    const result = store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: "planning",
        actorType: "system",
        actorId: "system:planning",
        now: "2026-08-15T12:01:00.000Z",
        currentStage: "planning",
      })
    );

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
      () =>
        store.transaction(() =>
          transitionWorkItemInTransaction(store, {
            workItemId,
            to: "merged",
            actorType: "agent",
            actorId: "agent:test",
            now: "2026-08-15T12:01:00.000Z",
            endedAt: "2026-08-15T12:01:00.000Z",
          })
        ),
      (error: unknown) =>
        error instanceof TaskBoardError &&
        error.status === 409 &&
        error.code === "WORK_ITEM_ILLEGAL_TRANSITION" &&
        error.message === "work item cannot move queued -> merged"
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
      () =>
        store.transaction(() =>
          transitionWorkItemInTransaction(store, {
            workItemId,
            to: "planning",
            actorType: "system",
            actorId: "system:reconcile",
            now: "2026-08-15T12:01:00.000Z",
            currentStage: "planning",
          })
        ),
      (error: unknown) =>
        error instanceof TaskBoardError &&
        error.code === "WORK_ITEM_ILLEGAL_TRANSITION" &&
        error.message === "work item cannot move merged -> planning"
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
    assert.throws(
      () =>
        store.transaction(() =>
          transitionWorkItemInTransaction(store, {
            workItemId,
            to: "abandoned",
            actorType: "human",
            actorId: "human:test",
            now: "2026-08-15T12:01:00.000Z",
            cancelledReason: "No longer needed",
          })
        ),
      TaskBoardError
    );
    assert.throws(
      () =>
        store.transaction(() =>
          transitionWorkItemInTransaction(store, {
            workItemId,
            to: "planning",
            actorType: "human",
            actorId: "human:test",
            now: "2026-08-15T12:01:00.000Z",
            endedAt: "2026-08-15T12:01:00.000Z",
          })
        ),
      TaskBoardError
    );
    assert.equal(workItemRow(store, workItemId).version, 1);
    assert.equal(transitionRows(store, workItemId).length, 1);
  } finally {
    store.close();
  }
});

test("park transition metadata is required only for parked targets and is validated", async () => {
  const { store, workItemId } = await transitionFixture();
  try {
    assert.throws(
      () =>
        store.transaction(() =>
          transitionWorkItemInTransaction(store, {
            workItemId,
            to: "parked",
            actorType: "system",
            actorId: "system:test",
            now: "2026-08-15T12:01:00.000Z",
          })
        ),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 400 && error.code === "TASK_BOARD_PARK_RECORD_REQUIRED"
    );
    assert.throws(
      () =>
        store.transaction(() =>
          transitionWorkItemInTransaction(store, {
            workItemId,
            to: "planning",
            actorType: "system",
            actorId: "system:test",
            now: "2026-08-15T12:01:00.000Z",
            park: { category: "open_question", reason: "test park" },
          })
        ),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 400 && error.code === "TASK_BOARD_PARK_RECORD_INVALID"
    );
    for (const park of [
      null,
      { category: "not-a-category", reason: "test park" },
      { category: "open_question", reason: "" },
    ]) {
      assert.throws(
        () =>
          store.transaction(() =>
            transitionWorkItemInTransaction(store, {
              workItemId,
              to: "parked",
              actorType: "system",
              actorId: "system:test",
              now: "2026-08-15T12:01:00.000Z",
              park: park as never,
            })
          ),
        (error: unknown) =>
          error instanceof TaskBoardError && error.status === 400 && error.code === "TASK_BOARD_PARK_RECORD_INVALID"
      );
    }
    assert.deepEqual(parkRecordRows(store, workItemId), []);
    assert.equal(workItemRow(store, workItemId).state, "queued");
  } finally {
    store.close();
  }
});

test("entering parked appends the categorized park record in the transition transaction", async () => {
  const { store, workItemId } = await transitionFixture();
  try {
    store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: "parked",
        actorType: "agent",
        actorId: "agent:test",
        now: "2026-08-15T12:01:00.000Z",
        park: { category: "open_question", reason: "Which rollback path should be preserved?" },
      })
    );

    const [record] = parkRecordRows(store, workItemId);
    assert.ok(record);
    assert.equal(record.category, "open_question");
    assert.equal(record.reason, "Which rollback path should be preserved?");
    assert.equal(record.parked_at, "2026-08-15T12:01:00.000Z");
    assert.equal(record.resolved_at, null);
    assert.equal(record.resolution, null);
  } finally {
    store.close();
  }
});

test("entering parked redacts an embedded token before recording the reason", async () => {
  const { store, workItemId } = await transitionFixture();
  const secret = `github_pat_${"p".repeat(48)}`;
  try {
    store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: "parked",
        actorType: "agent",
        actorId: "agent:test",
        now: "2026-08-15T12:01:00.000Z",
        park: { category: "open_question", reason: `Blocked while inspecting ${secret}` },
      })
    );

    const [record] = parkRecordRows(store, workItemId);
    assert.ok(record);
    assert.equal(record.reason, "Blocked while inspecting [redacted:token]");
    assert.doesNotMatch(record.reason, new RegExp(secret, "u"));
  } finally {
    store.close();
  }
});

test("park truncation keeps a redaction marker whole at the length boundary", async () => {
  const { store, workItemId } = await transitionFixture();
  const secret = `sk-ant-${"s".repeat(80)}`;
  const prefix = "p".repeat(1_990);
  try {
    store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: "parked",
        actorType: "agent",
        actorId: "agent:test",
        now: "2026-08-15T12:01:00.000Z",
        park: { category: "open_question", reason: `${prefix} ${secret}${"z".repeat(100)}` },
      })
    );

    const [record] = parkRecordRows(store, workItemId);
    assert.ok(record);
    assert.equal(record.reason.length, 2_000);
    assert.match(record.reason, /\[redacted:token\]…$/u);
    assert.doesNotMatch(record.reason, /\[redacted(?::[^\]]*)?…$/u);
  } finally {
    store.close();
  }
});

test("leaving parked derives and records every park resolution", async () => {
  const cases = [
    { target: "implementing", actorType: "system", actorId: "system:workflow", resolution: "resumed" },
    { target: "abandoned", actorType: "human", actorId: "human:test", resolution: "abandoned" },
    { target: "abandoned", actorType: "system", actorId: "system:park-lifecycle", resolution: "auto_abandoned" },
    { target: "abandoned", actorType: "system", actorId: "system:another-abandoner", resolution: "auto_abandoned" },
    { target: "dead_letter", actorType: "system", actorId: "system:workflow", resolution: "dead_letter" },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    const { store, workItemId } = await transitionFixture({
      initialState: "parked",
      initialStage: "implementation",
    });
    try {
      seedOpenParkRecord(store, workItemId, String(index));
      const now = `2026-08-15T12:0${index + 1}:00.000Z`;
      store.transaction(() =>
        transitionWorkItemInTransaction(store, {
          workItemId,
          to: scenario.target,
          actorType: scenario.actorType,
          actorId: scenario.actorId,
          now,
          ...(scenario.target === "abandoned" || scenario.target === "dead_letter"
            ? { endedAt: now }
            : { currentStage: "implementation" as const }),
        })
      );

      const [record] = parkRecordRows(store, workItemId);
      assert.ok(record);
      assert.equal(record.resolved_at, now);
      assert.equal(record.resolution, scenario.resolution);
    } finally {
      store.close();
    }
  }
});

test("each repeated park exit resolves only its newest open ledger record", async () => {
  const { store, workItemId } = await transitionFixture({
    initialState: "implementing",
    initialStage: "implementation",
  });
  try {
    store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: "parked",
        actorType: "agent",
        actorId: "agent:test",
        now: "2026-08-15T12:01:00.000Z",
        park: { category: "open_question", reason: "First question" },
      })
    );
    store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: "implementing",
        actorType: "human",
        actorId: "human:test",
        now: "2026-08-15T12:02:00.000Z",
        currentStage: "implementation",
      })
    );
    store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: "parked",
        actorType: "agent",
        actorId: "agent:test",
        now: "2026-08-15T12:03:00.000Z",
        park: { category: "open_question", reason: "Second question" },
      })
    );

    const beforeSecondExit = parkRecordRows(store, workItemId);
    assert.equal(beforeSecondExit.length, 2);
    const firstResolved = beforeSecondExit[0];
    assert.ok(firstResolved);
    assert.equal(firstResolved.resolved_at, "2026-08-15T12:02:00.000Z");
    assert.equal(firstResolved.resolution, "resumed");
    assert.equal(beforeSecondExit[1]?.resolved_at, null);
    assert.equal(beforeSecondExit[1]?.resolution, null);

    store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: "implementing",
        actorType: "human",
        actorId: "human:test",
        now: "2026-08-15T12:04:00.000Z",
        currentStage: "implementation",
      })
    );

    const afterSecondExit = parkRecordRows(store, workItemId);
    assert.deepEqual(afterSecondExit[0], firstResolved);
    assert.equal(afterSecondExit[1]?.resolved_at, "2026-08-15T12:04:00.000Z");
    assert.equal(afterSecondExit[1]?.resolution, "resumed");
  } finally {
    store.close();
  }
});

test("a same-state request without stage or reason changes is an idempotent no-op", async () => {
  const { store, workItemId } = await transitionFixture();
  try {
    const result = store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: "queued",
        actorType: "system",
        actorId: "system:reconcile",
        now: "2026-08-15T12:01:00.000Z",
      })
    );
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
      store.db
        .prepare("UPDATE work_items SET refined_objective = ? WHERE work_item_id = ?")
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
    const result = store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: "abandoned",
        actorType: "human",
        actorId: "human:test",
        now: "2026-08-15T12:02:00.000Z",
        endedAt: CREATED_AT,
        cancelledReason: "The operator supplied the missing reason.",
      })
    );
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
    assert.throws(
      () =>
        transitionWorkItemInTransaction(store, {
          workItemId,
          to: "planning",
          actorType: "system",
          actorId: "system:planning",
          now: "2026-08-15T12:01:00.000Z",
        }),
      (error: unknown) =>
        error instanceof TaskBoardError &&
        error.status === 500 &&
        error.code === "WORK_ITEM_TRANSACTION_REQUIRED" &&
        error.message === "work-item transitions require an open store transaction"
    );
    assert.equal(workItemRow(store, workItemId).version, 1);
    assert.equal(transitionRows(store, workItemId).length, 1);
  } finally {
    store.close();
  }
});

test("workflow construction rejects a bootstrap without a parent termination cascade", async () => {
  const { store } = await transitionFixture();
  try {
    registerWorkItemTransitionStore(store);
    assert.throws(
      () =>
        new TransparentWorkflow(
          store.db,
          new SkillRegistry("config/skills.md"),
          () => new Date(CREATED_AT),
          (operation) => store.transaction(operation),
          undefined,
          () => ""
        ),
      /TASK_BOARD_PARENT_TERMINATION_CASCADE_MISSING/u
    );
  } finally {
    store.close();
  }
});

test("a parent terminal transition rechecks cascade registration before writing", async () => {
  const { store, workItemId } = await transitionFixture();
  try {
    const childWorkItemId = "transition-time-cascade-child";
    seedRelatedWorkItem(store, childWorkItemId, workItemId);
    const before = workItemRow(store, workItemId);

    assert.throws(
      () =>
        store.transaction(() =>
          transitionWorkItemInTransaction(store, {
            workItemId,
            to: "abandoned",
            actorType: "human",
            actorId: "human:test",
            now: "2026-08-15T12:01:00.000Z",
            endedAt: "2026-08-15T12:01:00.000Z",
            cancelledReason: "Exercise the transition-time cascade guard.",
          })
        ),
      /TASK_BOARD_PARENT_TERMINATION_CASCADE_MISSING/u
    );
    assert.deepEqual(workItemRow(store, workItemId), before);
    assert.equal(transitionRows(store, workItemId).length, 1);
    assert.equal(workItemRow(store, childWorkItemId).state, "queued");
  } finally {
    store.close();
  }
});

test("successive work-item transitions use per-item sequences 1, 2, and 3", async () => {
  const { store, workItemId } = await transitionFixture();
  try {
    store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: "planning",
        actorType: "system",
        actorId: "system:planning",
        now: "2026-08-15T12:01:00.000Z",
        currentStage: "planning",
      })
    );
    store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: "plan_approval",
        actorType: "agent",
        actorId: "manager:test",
        now: "2026-08-15T12:02:00.000Z",
        currentStage: "human_review",
      })
    );

    assert.deepEqual(
      transitionRows(store, workItemId).map((row) => row.sequence),
      [1, 2, 3]
    );
    assert.deepEqual(
      transitionRows(store, workItemId).map((row) => row.to_state),
      ["queued", "planning", "plan_approval"]
    );
  } finally {
    store.close();
  }
});

test("workflow stages map to the v19 work-item pipeline states", () => {
  assert.deepEqual(
    [
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
    ],
    [
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
    ]
  );
  assert.equal(workItemStateForStage("implementation", { fixLoop: true }), "fixing");
  assert.equal(workItemStateForStage("testing", { fixLoop: true }), "verifying");
  assert.equal(workItemStateForStage("verification", { fixLoop: true }), "reviewing");
});

test("the fix-loop predicate is round-scoped and sticky only while already fixing", async () => {
  const { store, workItemId } = await transitionFixture();
  try {
    const nodeId = "predicate-node";
    store.db.exec("PRAGMA foreign_keys = OFF");
    store.db
      .prepare("INSERT INTO stage_attempts VALUES(?,?,?,?,?,?)")
      .run("predicate-verification-1", nodeId, "predicate-verification-task-1", "verification", 1, "{}");
    store.db
      .prepare(
        `
      INSERT INTO review_findings(
        finding_id,node_id,stage,round,file,line,category,severity,expected,actual,blocking,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `
      )
      .run(
        "predicate-finding-1",
        nodeId,
        "verification",
        1,
        null,
        null,
        "correctness",
        "major",
        "The implementation is correct.",
        "A defect remains.",
        1,
        CREATED_AT
      );

    assert.equal(workItemStateForNodeStage(store.db, workItemId, nodeId, "implementation", "implementing"), "fixing");

    store.db
      .prepare("INSERT INTO stage_attempts VALUES(?,?,?,?,?,?)")
      .run("predicate-verification-2", nodeId, "predicate-verification-task-2", "verification", 2, "{}");
    store.db
      .prepare(
        `
      INSERT INTO review_findings(
        finding_id,node_id,stage,round,file,line,category,severity,expected,actual,blocking,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `
      )
      .run(
        "predicate-finding-2",
        nodeId,
        "verification",
        2,
        null,
        null,
        "docs",
        "minor",
        "The documentation is complete.",
        "A non-blocking note remains.",
        0,
        "2026-08-15T12:02:00.000Z"
      );

    assert.equal(workItemStateForNodeStage(store.db, workItemId, nodeId, "implementation", "parked"), "implementing");
    assert.equal(workItemStateForNodeStage(store.db, workItemId, nodeId, "implementation", "fixing"), "fixing");
    assert.equal(workItemStateForNodeStage(store.db, workItemId, nodeId, "testing", "fixing"), "verifying");
  } finally {
    store.close();
  }
});

test("implementation recovery keeps fixing sticky across a parked transition", async () => {
  const { store, workItemId } = await transitionFixture({
    initialState: "fixing",
    initialStage: "implementation",
  });
  try {
    store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: "parked",
        actorType: "agent",
        actorId: "agent:test",
        now: "2026-08-15T12:01:00.000Z",
        park: { category: "open_question", reason: "Should the fix preserve the retry behavior?" },
      })
    );

    assert.equal(
      workItemStateForNodeStage(store.db, workItemId, "fixing-park-node", "implementation", "parked"),
      "fixing"
    );
  } finally {
    store.close();
  }
});

test("implementation recovery from an ordinary implementing park remains implementing", async () => {
  const { store, workItemId } = await transitionFixture({
    initialState: "implementing",
    initialStage: "implementation",
  });
  try {
    store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: "parked",
        actorType: "agent",
        actorId: "agent:test",
        now: "2026-08-15T12:01:00.000Z",
        park: { category: "open_question", reason: "Should implementation preserve the retry behavior?" },
      })
    );

    assert.equal(
      workItemStateForNodeStage(store.db, workItemId, "implementing-park-node", "implementation", "parked"),
      "implementing"
    );
  } finally {
    store.close();
  }
});

test("every workflow stage move has a legal work-item state decision", () => {
  for (const fromStage of WORKFLOW_STAGES) {
    const mapA = workItemStateForStage(fromStage);
    const possibleCurrentStates: readonly WorkItemState[] = mapA === "planning" ? [mapA, "plan_approval"] : [mapA];

    for (const toStage of WORKFLOW_STAGES) {
      const mapB = workItemStateForStage(toStage);
      for (const currentState of possibleCurrentStates) {
        const planApprovalCollapseApplies = currentState === "plan_approval" && mapB === "planning";
        const decision = planApprovalCollapseApplies ? currentState : mapB;
        assert.ok(
          isWorkItemTransitionAllowed(currentState, decision) || currentState === decision,
          `${fromStage} (${currentState}) -> ${toStage} (${decision}) is not covered`
        );
      }
    }
  }
});

test("plan approval reaches reviewing in exactly one stage-mapped transition", async () => {
  const { store, workItemId } = await transitionFixture({
    initialState: "plan_approval",
    initialStage: "human_review",
  });
  try {
    const result = store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: workItemStateForStage("verification"),
        actorType: "system",
        actorId: "system:workflow",
        now: "2026-08-15T12:03:00.000Z",
        currentStage: "verification",
      })
    );
    assert.deepEqual(result, { fromState: "plan_approval", version: 2 });
    assert.deepEqual(
      transitionRows(store, workItemId).map((row) => row.to_state),
      ["plan_approval", "reviewing"]
    );
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
    const result = store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: workItemStateForStage("testing"),
        actorType: "human",
        actorId: "human:test",
        now: "2026-08-15T12:03:00.000Z",
        currentStage: "testing",
      })
    );
    assert.deepEqual(result, { fromState: "parked", version: 2 });
    assert.deepEqual(
      transitionRows(store, workItemId).map((row) => row.to_state),
      ["parked", "verifying"]
    );
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
    const result = store.transaction(() =>
      transitionWorkItemInTransaction(store, {
        workItemId,
        to: workItemStateForStage("planning"),
        actorType: "system",
        actorId: "system:workflow",
        now: "2026-08-15T12:04:00.000Z",
        currentStage: "planning",
      })
    );
    assert.deepEqual(result, { fromState: "planning", version: 2 });
    assert.equal(workItemRow(store, workItemId).current_stage, "planning");
    assert.equal(transitionRows(store, workItemId).length, 1);
  } finally {
    store.close();
  }
});
