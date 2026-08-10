import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

test("fresh v17 DDL remains byte-identical to the frozen schema", async () => {
  const store = await TaskBoardStore.open(await databasePath());
  try {
    assert.equal(store.db.prepare("PRAGMA user_version").get()?.user_version, 17);
    const golden = await readFile(join(process.cwd(), "tests/server/task-board/fixtures/v17-schema.sql"), "utf8");
    assert.equal(frozenSchema(store), golden);
  } finally {
    store.close();
  }
});

test("v17 table CHECK clauses contain byte-identical contract-derived enum lists", async () => {
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
