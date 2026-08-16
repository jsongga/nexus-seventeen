import assert from "node:assert/strict";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ACTOR_TYPES,
  AGENT_ROLES,
  DOCUMENT_ACTOR_TYPES,
  PLAN_REVISION_STATES,
  QUESTION_STATUSES,
  RUN_STATUSES,
  STAGE_HANDOFF_OUTCOMES,
  TASK_KINDS,
  TASK_MESSAGE_ACTOR_TYPES,
  TASK_MESSAGE_KINDS,
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  TASK_STATUSES,
  WAKEUP_REASONS,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STAGES,
  WORK_ITEM_STATES,
  WORK_ITEM_TERMINAL_STATES,
  WORK_NODE_STATES,
  WORKFLOW_STAGES,
} from "#shared/task-board-contract";
import { TaskBoardError } from "#server/task-board/errors";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import { boardFixture, databasePath, workItemRequest } from "./helpers.js";

test("workflow persistence accepts contract identifiers and exactly the contract stages", async () => {
  const fixture = await boardFixture();
  try {
    for (const [index, stage] of [...WORKFLOW_STAGES, "not_a_contract_member"].entries()) {
      const item = fixture.board.createWorkItem(workItemRequest({
        projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
      }), `workflow-contract-${index}`).workItem;
      const proposal = {
        workItemId: item.workItemId,
        projectId: fixture.project.projectId,
        objective: "Verify workflow contract derivation.",
        assumptions: [],
        acceptanceCriteria: ["The persistence validator stays aligned."],
        skillIds: [],
        nodes: [{
          nodeId: "Node/One",
          title: "Inspect persistence",
          objective: "Verify persistence accepts the shared contract.",
          acceptanceCriteria: ["The proposal is persisted."],
          dependencyNodeIds: [],
          stageTemplate: stage === "verification" ? [stage] : [stage, "verification"],
        }],
      };
      if (stage === "not_a_contract_member") {
        assert.throws(
          () => fixture.board.proposeWorkflow(proposal as never),
          (error: unknown) => error instanceof TaskBoardError && error.code === "WORKFLOW_INVALID",
        );
      } else {
        assert.equal(fixture.board.proposeWorkflow(proposal as never).plans.length, index + 1);
      }
    }
  } finally {
    fixture.board.close();
  }
});

function sqlList(values: readonly string[], separator = ", "): string {
  return values.map((value) => `'${value}'`).join(separator);
}

function frozenSchema(store: TaskBoardStore): string {
  const rows = store.db.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as Array<Readonly<{ type: string; name: string; sql: string }>>;
  return `${rows.map((row) => `-- ${row.type}: ${row.name}\n${row.sql};`).join("\n\n")}\n`;
}

test("fresh v19 DDL remains byte-identical to the frozen schema", async () => {
  const store = await TaskBoardStore.open(await databasePath());
  try {
    assert.equal(store.db.prepare("PRAGMA user_version").get()?.user_version, 19);
    const golden = await readFile(join(process.cwd(), "tests/server/task-board/fixtures/v19-schema.sql"), "utf8");
    assert.equal(frozenSchema(store), golden);
  } finally {
    store.close();
  }
});

test("v19 table CHECK clauses contain byte-identical contract-derived enum lists", async () => {
  const store = await TaskBoardStore.open(await databasePath());
  try {
    const tableSql = (name: string): string => {
      const row = store.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
        | Readonly<{ sql: string }>
        | undefined;
      assert.ok(row);
      return row.sql;
    };
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["agents", `CHECK (role IN (${sqlList(AGENT_ROLES)}))`],
      ["tasks", `CHECK (task_kind IN (${sqlList(TASK_KINDS)}))`],
      ["tasks", `required_role IN (${sqlList(AGENT_ROLES)})`],
      ["tasks", `assigned_role IN (${sqlList(AGENT_ROLES)})`],
      ["tasks", `CHECK (status IN (${sqlList(TASK_STATUSES)}))`],
      ["task_phases", `CHECK (stage IN (${sqlList(TASK_PHASE_STAGES)}))`],
      ["task_phases", `CHECK (status IN (${sqlList(TASK_PHASE_STATUSES)}))`],
      ["work_items", `CHECK (priority IN (${sqlList(WORK_ITEM_PRIORITIES)}))`],
      ["work_items", `CHECK (state IN (${sqlList(WORK_ITEM_STATES)}))`],
      ["work_items", `current_stage IN (${sqlList(WORK_ITEM_STAGES)})`],
      ["work_items", `state IN (${sqlList(WORK_ITEM_TERMINAL_STATES)}) AND ended_at IS NOT NULL`],
      ["work_items", `state NOT IN (${sqlList(WORK_ITEM_TERMINAL_STATES)}) AND ended_at IS NULL`],
      ["work_item_transitions", `from_state IN (${sqlList(WORK_ITEM_STATES)})`],
      ["work_item_transitions", `CHECK (to_state IN (${sqlList(WORK_ITEM_STATES)}))`],
      ["wakeups", `CHECK (reason IN (${sqlList(WAKEUP_REASONS)}))`],
      ["documents", `pen_holder_actor_type IN (${sqlList(DOCUMENT_ACTOR_TYPES)})`],
      ["document_events", `CHECK (actor_type IN (${sqlList(DOCUMENT_ACTOR_TYPES)}))`],
      ["task_messages", `CHECK (actor_type IN (${sqlList(TASK_MESSAGE_ACTOR_TYPES)}))`],
      ["task_messages", `CHECK (kind IN (${sqlList(TASK_MESSAGE_KINDS)}))`],
      ["task_events", `CHECK (actor_type IN (${sqlList(ACTOR_TYPES)}))`],
      ["questions", `CHECK (status IN (${sqlList(QUESTION_STATUSES)}))`],
      ["runs", `CHECK (status IN (${sqlList(RUN_STATUSES)}))`],
      ["plan_revisions", `CHECK (state IN (${sqlList(PLAN_REVISION_STATES, ",")}))`],
      ["work_nodes", `CHECK (state IN (${sqlList(WORK_NODE_STATES, ",")}))`],
      ["stage_attempts", `CHECK(stage IN (${sqlList(WORKFLOW_STAGES, ",")}))`],
      ["stage_handoffs", `CHECK(outcome IN (${sqlList(STAGE_HANDOFF_OUTCOMES, ",")}))`],
    ];
    for (const [table, fragment] of expected) assert.ok(tableSql(table).includes(fragment), `${table}: ${fragment}`);
  } finally {
    store.close();
  }
});

test("v18 work-item states migrate to v19 with an initial transition per item", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const legacy = new DatabaseSync(path);
  const explicitProjectId = "migration-project-explicit";
  const mappingCells: ReadonlyArray<Readonly<{
    id: string;
    state: string;
    currentStage: string | null;
    migratedState: string;
    targetProjectId?: string;
    archivedAt?: string;
  }>> = [
    {
      id: "migration-01-submitted",
      state: "submitted",
      currentStage: "refinement",
      migratedState: "queued",
      targetProjectId: explicitProjectId,
    },
    { id: "migration-02-needs-input", state: "needs_input", currentStage: "planning", migratedState: "parked" },
    {
      id: "migration-03-completed",
      state: "completed",
      currentStage: "deployment",
      migratedState: "merged",
      archivedAt: "2026-08-15T13:00:00.000Z",
    },
    { id: "migration-04-failed", state: "failed", currentStage: "testing", migratedState: "dead_letter" },
    { id: "migration-05-cancelled", state: "cancelled", currentStage: null, migratedState: "abandoned" },
    { id: "migration-06-human-review", state: "waiting_for_human_review", currentStage: "human_review", migratedState: "final_approval" },
    { id: "migration-07-plan-approval", state: "waiting_for_human_review", currentStage: "planning", migratedState: "plan_approval" },
    { id: "migration-08-implementation", state: "processing", currentStage: "implementation", migratedState: "implementing" },
    { id: "migration-09-deployment", state: "processing", currentStage: "deployment", migratedState: "implementing" },
    { id: "migration-10-testing", state: "processing", currentStage: "testing", migratedState: "verifying" },
    { id: "migration-11-verification", state: "processing", currentStage: "verification", migratedState: "reviewing" },
    { id: "migration-12-refinement", state: "processing", currentStage: "refinement", migratedState: "planning" },
    { id: "migration-13-null-stage", state: "processing", currentStage: null, migratedState: "planning" },
  ];
  try {
    const frozenV18 = await readFile(join(process.cwd(), "tests/server/task-board/fixtures/v18-schema.sql"), "utf8");
    const schemaKindOrder = ["-- table:", "-- index:", "-- trigger:"];
    const executableV18 = frozenV18
      .split(/(?=^-- (?:index|table|trigger): )/m)
      .sort((left, right) => schemaKindOrder.findIndex((prefix) => left.startsWith(prefix))
        - schemaKindOrder.findIndex((prefix) => right.startsWith(prefix)))
      .join("");
    legacy.exec(executableV18);
    legacy.prepare(`
      INSERT INTO projects(project_id, name, description, version, created_at, updated_at)
      VALUES (?, 'Migration target', 'Exercises explicit project references.', 1, ?, ?)
    `).run(explicitProjectId, "2026-08-15T11:00:00.000Z", "2026-08-15T11:00:00.000Z");
    const insert = legacy.prepare(`
      INSERT INTO work_items(
        work_item_id, original_request, priority, project_target_mode, target_project_id,
        resolved_project_id, state, current_stage,
        created_by, idempotency_key, request_hash, version, created_at, updated_at,
        ended_at, cancelled_reason, archived_at
      ) VALUES (?, ?, 'normal', ?, ?, ?, ?, ?, 'system:migration-test', ?, ?, 1, ?, ?, ?, ?, ?)
    `);
    for (const [index, cell] of mappingCells.entries()) {
      const timestamp = `2026-08-15T12:${String(index).padStart(2, "0")}:00.000Z`;
      const terminal = cell.state === "completed" || cell.state === "failed" || cell.state === "cancelled";
      insert.run(
        cell.id,
        `Migrate ${cell.state} at ${cell.currentStage ?? "no stage"}`,
        cell.targetProjectId === undefined ? "auto" : "explicit",
        cell.targetProjectId ?? null,
        cell.targetProjectId ?? null,
        cell.state,
        cell.currentStage,
        `migration-key-${index}`,
        `migration-hash-${index}`,
        timestamp,
        timestamp,
        terminal ? timestamp : null,
        cell.state === "cancelled" ? "Superseded during migration" : null,
        cell.archivedAt ?? null,
      );
    }
    legacy.exec("PRAGMA user_version = 18;");
  } finally {
    legacy.close();
  }
  await chmod(path, 0o600);

  const upgraded = await TaskBoardStore.open(path);
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 19);
    assert.deepEqual(
      upgraded.db.prepare(`
        SELECT work_item_id, state, project_target_mode, target_project_id, resolved_project_id, archived_at
        FROM work_items
        ORDER BY work_item_id
      `).all().map((row) => ({
        work_item_id: row.work_item_id,
        state: row.state,
        project_target_mode: row.project_target_mode,
        target_project_id: row.target_project_id,
        resolved_project_id: row.resolved_project_id,
        archived_at: row.archived_at,
      })),
      mappingCells.map((cell) => ({
        work_item_id: cell.id,
        state: cell.migratedState,
        project_target_mode: cell.targetProjectId === undefined ? "auto" : "explicit",
        target_project_id: cell.targetProjectId ?? null,
        resolved_project_id: cell.targetProjectId ?? null,
        archived_at: cell.archivedAt ?? null,
      })),
    );
    assert.deepEqual(
      upgraded.db.prepare(`
        SELECT work_item_id, sequence, from_state, to_state, actor_type, actor_id, created_at
        FROM work_item_transitions
        ORDER BY work_item_id, sequence
      `).all().map((row) => ({
        work_item_id: row.work_item_id,
        sequence: row.sequence,
        from_state: row.from_state,
        to_state: row.to_state,
        actor_type: row.actor_type,
        actor_id: row.actor_id,
        created_at: row.created_at,
      })),
      mappingCells.map((cell, index) => ({
        work_item_id: cell.id,
        sequence: 1,
        from_state: null,
        to_state: cell.migratedState,
        actor_type: "system",
        actor_id: "system:migration",
        created_at: `2026-08-15T12:${String(index).padStart(2, "0")}:00.000Z`,
      })),
    );
    const runColumns = new Set(
      upgraded.db.prepare("PRAGMA table_info(runs)").all().map((row) => String(row.name)),
    );
    for (const column of ["heartbeat_at", "runtime", "runtime_version", "model", "prompts_sha"]) {
      assert.ok(runColumns.has(column), `runs.${column}`);
    }
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    upgraded.close();
  }
});

test("reopening an already-v19-shaped store at version 18 preserves states and transition history", async () => {
  const path = await databasePath();
  const original = await TaskBoardStore.open(path);
  try {
    const insertWorkItem = original.db.prepare(`
      INSERT INTO work_items(
        work_item_id, original_request, priority, project_target_mode, state, current_stage,
        created_by, idempotency_key, request_hash, version, created_at, updated_at, ended_at
      ) VALUES (?, ?, 'normal', 'auto', ?, ?, 'system:guard-test', ?, ?, 1, ?, ?, ?)
    `);
    insertWorkItem.run(
      "guard-reviewing",
      "Preserve the reviewing state.",
      "reviewing",
      "verification",
      "guard-key-reviewing",
      "guard-hash-reviewing",
      "2026-08-15T14:00:00.000Z",
      "2026-08-15T14:02:00.000Z",
      null,
    );
    insertWorkItem.run(
      "guard-merged",
      "Preserve the merged state.",
      "merged",
      "deployment",
      "guard-key-merged",
      "guard-hash-merged",
      "2026-08-15T15:00:00.000Z",
      "2026-08-15T15:02:00.000Z",
      "2026-08-15T15:02:00.000Z",
    );
    const insertTransition = original.db.prepare(`
      INSERT INTO work_item_transitions(
        work_item_id, sequence, from_state, to_state, actor_type, actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertTransition.run(
      "guard-reviewing", 1, null, "queued", "system", "system:intake", "2026-08-15T14:00:00.000Z",
    );
    insertTransition.run(
      "guard-reviewing", 2, "queued", "reviewing", "agent", "agent:reviewer", "2026-08-15T14:02:00.000Z",
    );
    insertTransition.run(
      "guard-merged", 1, null, "merged", "human", "human:approver", "2026-08-15T15:02:00.000Z",
    );
    original.db.exec("PRAGMA user_version = 18;");
  } finally {
    original.close();
  }

  const reopened = await TaskBoardStore.open(path);
  try {
    assert.equal(reopened.db.prepare("PRAGMA user_version").get()?.user_version, 19);
    assert.deepEqual(
      reopened.db.prepare("SELECT work_item_id, state FROM work_items ORDER BY work_item_id").all()
        .map((row) => ({ work_item_id: row.work_item_id, state: row.state })),
      [
        { work_item_id: "guard-merged", state: "merged" },
        { work_item_id: "guard-reviewing", state: "reviewing" },
      ],
    );
    assert.deepEqual(
      reopened.db.prepare(`
        SELECT work_item_id, sequence, from_state, to_state, actor_type, actor_id, created_at
        FROM work_item_transitions
        ORDER BY work_item_id, sequence
      `).all().map((row) => ({
        work_item_id: row.work_item_id,
        sequence: row.sequence,
        from_state: row.from_state,
        to_state: row.to_state,
        actor_type: row.actor_type,
        actor_id: row.actor_id,
        created_at: row.created_at,
      })),
      [
        {
          work_item_id: "guard-merged",
          sequence: 1,
          from_state: null,
          to_state: "merged",
          actor_type: "human",
          actor_id: "human:approver",
          created_at: "2026-08-15T15:02:00.000Z",
        },
        {
          work_item_id: "guard-reviewing",
          sequence: 1,
          from_state: null,
          to_state: "queued",
          actor_type: "system",
          actor_id: "system:intake",
          created_at: "2026-08-15T14:00:00.000Z",
        },
        {
          work_item_id: "guard-reviewing",
          sequence: 2,
          from_state: "queued",
          to_state: "reviewing",
          actor_type: "agent",
          actor_id: "agent:reviewer",
          created_at: "2026-08-15T14:02:00.000Z",
        },
      ],
    );
  } finally {
    reopened.close();
  }
});

test("v17 migrates through v19 while preserving the node-event lookup index", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const legacy = new DatabaseSync(path);
  try {
    const frozenV17 = await readFile(join(process.cwd(), "tests/server/task-board/fixtures/v17-schema.sql"), "utf8");
    const schemaKindOrder = ["-- table:", "-- index:", "-- trigger:"];
    const executableV17 = frozenV17
      .split(/(?=^-- (?:index|table|trigger): )/m)
      .sort((left, right) => schemaKindOrder.findIndex((prefix) => left.startsWith(prefix))
        - schemaKindOrder.findIndex((prefix) => right.startsWith(prefix)))
      .join("");
    legacy.exec(executableV17);
    legacy.exec("PRAGMA user_version = 17;");
  } finally {
    legacy.close();
  }
  await chmod(path, 0o600);

  const upgraded = await TaskBoardStore.open(path);
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 19);
    assert.equal(
      upgraded.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='project_events_node'").get()?.sql,
      "CREATE INDEX project_events_node ON project_events(node_id, sequence)",
    );
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    upgraded.close();
  }
});
