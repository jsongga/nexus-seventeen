import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ACTOR_TYPES,
  AGENT_ROLES,
  DESIGN_FAILURE_POINTS,
  DOCUMENT_ACTOR_TYPES,
  GATE_KINDS,
  NOTIFICATION_KINDS,
  PARK_CATEGORIES,
  PARK_RESOLUTIONS,
  PLAN_REVISION_STATES,
  QUESTION_STATUSES,
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_SEVERITIES,
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

const V22_PARK_CATEGORIES = [
  "open_question", "planning_run_failed", "design_run_failed", "hazardous_without_pipeline",
  "plan_rejected_twice", "bright_line", "scope_violation",
] as const;
const V22_NOTIFICATION_KINDS = ["park_aged", "park_auto_abandoned"] as const;

function frozenProjection(store: TaskBoardStore, version: 19 | 20 | 21 | 22 | 23 | 24): string {
  const rows = store.db.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as Array<Readonly<{ type: string; name: string; sql: string }>>;
  return `${rows
    .filter((row) => ![
      ...(version <= 22 ? ["board_pause"] : []),
      ...(version <= 23 ? ["work_item_onboarding_tasks", "onboarding_once_per_project", "onboarding_task_link"] : []),
      ...(version <= 21 ? ["park_records", "notifications", "gate_actions"] : []),
      ...(version <= 20 ? ["review_findings", "design_records", "work_item_design_tasks"] : []),
      ...(version === 19 ? ["verify_attempts"] : []),
    ].includes(row.name))
    .map((row) => {
      let sql = row.sql;
      if (version === 19 && row.name === "work_items") {
        sql = sql.replace("  pipeline_branch TEXT NULL,\n  base_sha TEXT NULL,\n", "");
      } else if (version === 19 && row.name === "plan_revisions") {
        sql = sql.replace(
          "  change_shape TEXT NULL,\n  tier TEXT NULL,\n  declared_scope_json TEXT NULL,\n  non_goals_json TEXT NULL,\n" +
          "  mechanical_portions_json TEXT NULL,\n  blocking_questions_json TEXT NULL,\n" +
          "  criterion_checks_json TEXT NULL,\n  rejected_note TEXT NULL,\n",
          "",
        );
      } else if (version === 22 && row.name === "park_records") {
        sql = sql.replace(sqlList(PARK_CATEGORIES), sqlList(V22_PARK_CATEGORIES));
      } else if (version === 22 && row.name === "notifications") {
        sql = sql.replace(sqlList(NOTIFICATION_KINDS), sqlList(V22_NOTIFICATION_KINDS));
      }
      return `-- ${row.type}: ${row.name}\n${sql};`;
    })
    .join("\n\n")}\n`;
}

test("fresh v24 DDL preserves the byte-identical frozen v19 through v23 schemas", async () => {
  const store = await TaskBoardStore.open(await databasePath());
  try {
    assert.equal(store.db.prepare("PRAGMA user_version").get()?.user_version, 24);
    for (const version of [19, 20, 21, 22, 23] as const) {
      const fixturePath = join(process.cwd(), `tests/server/task-board/fixtures/v${version}-schema.sql`);
      // Regenerate a new pre-migration fixture with the same projection the assertion consumes:
      // UPDATE_TASK_BOARD_SCHEMA_FIXTURES=1 node --test <compiled contract-drift suite>.
      if (version === 23 && process.env.UPDATE_TASK_BOARD_SCHEMA_FIXTURES === "1") {
        await writeFile(fixturePath, frozenProjection(store, version), "utf8");
      }
      const golden = await readFile(fixturePath, "utf8");
      assert.equal(frozenProjection(store, version), golden);
    }
    assert.deepEqual({ ...store.db.prepare(`
      SELECT pause_id, paused, reason, version, updated_at, updated_by FROM board_pause
    `).get() }, {
      pause_id: "board",
      paused: 0,
      reason: null,
      version: 1,
      updated_at: "1970-01-01T00:00:00.000Z",
      updated_by: "system:steward-default",
    });
  } finally {
    store.close();
  }
});

test("v23 fixture migrates to the same v24 schema as a fresh database", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const legacy = new DatabaseSync(path);
  try {
    const frozenV23 = await readFile(join(process.cwd(), "tests/server/task-board/fixtures/v23-schema.sql"), "utf8");
    const schemaKindOrder = ["-- table:", "-- index:", "-- trigger:"];
    const executableV23 = frozenV23
      .split(/(?=^-- (?:index|table|trigger): )/m)
      .sort((left, right) => schemaKindOrder.findIndex((prefix) => left.startsWith(prefix))
        - schemaKindOrder.findIndex((prefix) => right.startsWith(prefix)))
      .join("");
    legacy.exec(executableV23);
    legacy.exec("PRAGMA user_version = 23;");
  } finally {
    legacy.close();
  }
  await chmod(path, 0o600);

  const upgraded = await TaskBoardStore.open(path);
  const fresh = await TaskBoardStore.open(await databasePath());
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 24);
    assert.deepEqual(
      upgraded.db.prepare("PRAGMA table_info(work_item_onboarding_tasks)").all().map((row) => String(row.name)),
      ["work_item_id", "project_id", "task_id", "created_at"],
    );
    for (const [name, sql] of [
      [
        "onboarding_once_per_project",
        "CREATE UNIQUE INDEX onboarding_once_per_project ON work_item_onboarding_tasks(project_id)",
      ],
      [
        "onboarding_task_link",
        "CREATE UNIQUE INDEX onboarding_task_link ON work_item_onboarding_tasks(task_id)",
      ],
    ] as const) {
      assert.equal(
        upgraded.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)?.sql,
        sql,
      );
      assert.equal(
        fresh.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)?.sql,
        sql,
      );
    }
    assert.equal(frozenProjection(upgraded, 24), frozenProjection(fresh, 24));
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    fresh.close();
    upgraded.close();
  }
});

test("v24 table CHECK clauses contain byte-identical contract-derived enum lists", async () => {
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
      ["review_findings", `CHECK (stage IN (${sqlList(WORKFLOW_STAGES)}))`],
      ["review_findings", `CHECK (category IN (${sqlList(REVIEW_FINDING_CATEGORIES)}))`],
      ["review_findings", `CHECK (severity IN (${sqlList(REVIEW_FINDING_SEVERITIES)}))`],
      ["review_findings", "CHECK (blocking IN (0, 1))"],
      ["design_records", "CHECK (json_valid(payload_json))"],
      ["park_records", `CHECK (category IN (${sqlList(PARK_CATEGORIES)}))`],
      ["park_records", `CHECK (resolution IN (${sqlList(PARK_RESOLUTIONS)}))`],
      ["notifications", `CHECK (kind IN (${sqlList(NOTIFICATION_KINDS)}))`],
      ["gate_actions", `CHECK (gate IN (${sqlList(GATE_KINDS)}))`],
    ];
    for (const [table, fragment] of expected) assert.ok(tableSql(table).includes(fragment), `${table}: ${fragment}`);
  } finally {
    store.close();
  }
});

test("v19 migrates through v22 with pipeline columns and durable verify attempts", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const legacy = new DatabaseSync(path);
  try {
    const frozenV19 = await readFile(join(process.cwd(), "tests/server/task-board/fixtures/v19-schema.sql"), "utf8");
    const schemaKindOrder = ["-- table:", "-- index:", "-- trigger:"];
    const executableV19 = frozenV19
      .split(/(?=^-- (?:index|table|trigger): )/m)
      .sort((left, right) => schemaKindOrder.findIndex((prefix) => left.startsWith(prefix))
        - schemaKindOrder.findIndex((prefix) => right.startsWith(prefix)))
      .join("");
    legacy.exec(executableV19);
    legacy.exec(`
      INSERT INTO projects(project_id, name, description, version, created_at, updated_at)
      VALUES ('pipeline-project', 'Pipeline project', 'Exercises the v20 migration.', 1,
        '2026-08-18T12:00:00.000Z', '2026-08-18T12:00:00.000Z');
      INSERT INTO work_items(
        work_item_id, original_request, refined_objective, priority, project_target_mode,
        target_project_id, resolved_project_id, state, current_stage, created_by,
        idempotency_key, request_hash, version, created_at, updated_at, ended_at,
        cancelled_reason, archived_at
      ) VALUES (
        'pipeline-work-item', 'Preserve this work item.', 'Preserve this plan.', 'normal', 'explicit',
        'pipeline-project', 'pipeline-project', 'plan_approval', 'planning', 'system:migration-test',
        'pipeline-migration-key', 'pipeline-migration-hash', 1,
        '2026-08-18T12:01:00.000Z', '2026-08-18T12:02:00.000Z', NULL, NULL, NULL
      );
      INSERT INTO plan_revisions(
        plan_revision_id, work_item_id, revision, objective, assumptions_json,
        acceptance_criteria_json, project_id, skill_digests_json, state, created_by,
        confirmed_by, created_at, confirmed_at
      ) VALUES (
        'pipeline-plan', 'pipeline-work-item', 1, 'Preserve this plan.', '[]',
        '["The plan survives."]', 'pipeline-project', '{}', 'proposed', 'agent:planner',
        NULL, '2026-08-18T12:02:00.000Z', NULL
      );
      INSERT INTO work_nodes(
        node_id, plan_revision_id, project_id, title, objective,
        acceptance_criteria_json, stage_template_json, current_stage, state,
        version, created_at, updated_at
      ) VALUES (
        'pipeline-node', 'pipeline-plan', 'pipeline-project', 'Preserve this node',
        'Keep the verify-attempt foreign key usable.', '["The node survives."]',
        '["implementation","verification"]', NULL, 'pending', 1,
        '2026-08-18T12:02:00.000Z', '2026-08-18T12:02:00.000Z'
      );
      PRAGMA user_version = 19;
    `);
  } finally {
    legacy.close();
  }
  await chmod(path, 0o600);

  const upgraded = await TaskBoardStore.open(path);
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 24);
    const columns = (table: string): string[] => upgraded.db.prepare(`PRAGMA table_info(${table})`).all()
      .map((row) => String(row.name));
    for (const column of ["pipeline_branch", "base_sha"]) {
      assert.ok(columns("work_items").includes(column), `work_items.${column}`);
    }
    for (const column of [
      "change_shape", "tier", "declared_scope_json", "non_goals_json",
      "mechanical_portions_json", "blocking_questions_json", "criterion_checks_json", "rejected_note",
    ]) {
      assert.ok(columns("plan_revisions").includes(column), `plan_revisions.${column}`);
    }
    assert.deepEqual(columns("verify_attempts"), [
      "verify_attempt_id", "node_id", "stage", "attempt", "verify_run_id", "workspace_path",
      "state", "check_results_json", "detail", "created_at", "ended_at",
    ]);
    assert.deepEqual(
      { ...upgraded.db.prepare(`
        SELECT original_request, pipeline_branch, base_sha
        FROM work_items WHERE work_item_id = 'pipeline-work-item'
      `).get() },
      { original_request: "Preserve this work item.", pipeline_branch: null, base_sha: null },
    );
    assert.deepEqual(
      { ...upgraded.db.prepare(`
        SELECT objective, change_shape, tier, declared_scope_json, non_goals_json,
          mechanical_portions_json, blocking_questions_json, criterion_checks_json, rejected_note
        FROM plan_revisions WHERE plan_revision_id = 'pipeline-plan'
      `).get() },
      {
        objective: "Preserve this plan.", change_shape: null, tier: null, declared_scope_json: null,
        non_goals_json: null, mechanical_portions_json: null, blocking_questions_json: null,
        criterion_checks_json: null, rejected_note: null,
      },
    );
    const verifySql = String(upgraded.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'verify_attempts'",
    ).get()?.sql);
    assert.equal(verifySql, `CREATE TABLE verify_attempts (
  verify_attempt_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES work_nodes(node_id),
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  verify_run_id TEXT NULL,
  workspace_path TEXT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting','running','green','failed','died','failed_to_start')),
  check_results_json TEXT NULL,
  detail TEXT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT NULL,
  UNIQUE(node_id, stage, attempt)
)`);
    upgraded.db.prepare(`
      INSERT INTO verify_attempts(
        verify_attempt_id, node_id, stage, attempt, verify_run_id, workspace_path,
        state, check_results_json, detail, created_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "verify-attempt-one", "pipeline-node", "testing", 1, null, null,
      "starting", null, null, "2026-08-18T12:03:00.000Z", null,
    );
    assert.throws(() => upgraded.db.prepare(`
      INSERT INTO verify_attempts(verify_attempt_id, node_id, stage, attempt, state, created_at)
      VALUES ('verify-attempt-two', 'pipeline-node', 'testing', 1, 'running', '2026-08-18T12:04:00.000Z')
    `).run(), /UNIQUE/u);
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(upgraded.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  } finally {
    upgraded.close();
  }
});

test("v20 migrates to v21 with review findings, design records, and design-task links", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const legacy = new DatabaseSync(path);
  try {
    const frozenV20 = await readFile(join(process.cwd(), "tests/server/task-board/fixtures/v20-schema.sql"), "utf8");
    const schemaKindOrder = ["-- table:", "-- index:", "-- trigger:"];
    const executableV20 = frozenV20
      .split(/(?=^-- (?:index|table|trigger): )/m)
      .sort((left, right) => schemaKindOrder.findIndex((prefix) => left.startsWith(prefix))
        - schemaKindOrder.findIndex((prefix) => right.startsWith(prefix)))
      .join("");
    legacy.exec(executableV20);
    legacy.exec(`
      INSERT INTO projects(project_id, name, description, version, created_at, updated_at)
      VALUES ('review-project', 'Review project', 'Exercises the v21 migration.', 1,
        '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z');
      INSERT INTO work_items(
        work_item_id, original_request, refined_objective, priority, project_target_mode,
        target_project_id, resolved_project_id, pipeline_branch, base_sha, state, current_stage,
        created_by, idempotency_key, request_hash, version, created_at, updated_at
      ) VALUES (
        'review-work-item', 'Preserve this work item.', 'Review and fix safely.', 'normal', 'explicit',
        'review-project', 'review-project', 'pipeline/review-work-item', '0123456789abcdef',
        'reviewing', 'verification', 'system:migration-test', 'review-migration-key',
        'review-migration-hash', 1, '2026-08-19T12:01:00.000Z', '2026-08-19T12:01:00.000Z'
      );
      INSERT INTO plan_revisions(
        plan_revision_id, work_item_id, revision, objective, assumptions_json,
        acceptance_criteria_json, project_id, skill_digests_json, state, created_by, created_at
      ) VALUES (
        'review-plan', 'review-work-item', 1, 'Review and fix safely.', '[]',
        '["The review state survives."]', 'review-project', '{}', 'confirmed',
        'agent:planner', '2026-08-19T12:02:00.000Z'
      );
      INSERT INTO work_nodes(
        node_id, plan_revision_id, project_id, title, objective,
        acceptance_criteria_json, stage_template_json, current_stage, state,
        version, created_at, updated_at
      ) VALUES (
        'review-node', 'review-plan', 'review-project', 'Review the implementation',
        'Persist review evidence.', '["Review findings are durable."]',
        '["implementation","verification"]', 'verification', 'active', 1,
        '2026-08-19T12:03:00.000Z', '2026-08-19T12:03:00.000Z'
      );
      INSERT INTO tasks(
        task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
        title, objective, acceptance_criteria, workspace_refs_json, status,
        assigned_agent_id, assigned_role, expected_agent_minutes, agent_estimate_minutes,
        estimate_recorded_at, order_key, started_at, ended_at, result, version, created_at, updated_at
      ) VALUES (
        'design-task', 'review-project', NULL, 'work', NULL, 1,
        'Design the recovery flow', 'Cover the durable failure matrix.', 'Every failure point is covered.',
        '[]', 'backlog', NULL, NULL, 15, NULL, NULL, 0, NULL, NULL, NULL, 1,
        '2026-08-19T12:04:00.000Z', '2026-08-19T12:04:00.000Z'
      );
      PRAGMA user_version = 20;
    `);
  } finally {
    legacy.close();
  }
  await chmod(path, 0o600);

  const upgraded = await TaskBoardStore.open(path);
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 24);
    const columns = (table: string): string[] => upgraded.db.prepare(`PRAGMA table_info(${table})`).all()
      .map((row) => String(row.name));
    assert.deepEqual(columns("review_findings"), [
      "finding_id", "node_id", "stage", "round", "file", "line", "category", "severity",
      "expected", "actual", "blocking", "created_at",
    ]);
    assert.deepEqual(columns("design_records"), [
      "design_record_id", "work_item_id", "plan_revision_id", "payload_json", "created_at",
    ]);
    assert.deepEqual(columns("work_item_design_tasks"), ["work_item_id", "task_id", "created_at"]);
    assert.deepEqual(
      { ...upgraded.db.prepare(`
        SELECT original_request, pipeline_branch, base_sha
        FROM work_items WHERE work_item_id = 'review-work-item'
      `).get() },
      {
        original_request: "Preserve this work item.",
        pipeline_branch: "pipeline/review-work-item",
        base_sha: "0123456789abcdef",
      },
    );

    upgraded.db.prepare(`
      INSERT INTO review_findings(
        finding_id, node_id, stage, round, file, line, category, severity,
        expected, actual, blocking, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "finding-one", "review-node", "verification", 1, "src/example.ts", 42,
      "correctness", "major", "A retry is idempotent.", "A retry duplicates a write.", 1,
      "2026-08-19T12:05:00.000Z",
    );
    const payload = JSON.stringify({
      states: ["pending", "committed"],
      transitions: [{ from: "pending", to: "committed" }],
      failurePoints: DESIGN_FAILURE_POINTS.map((point) => ({
        point,
        resultingState: "durable",
        recovery: "Retry with the persisted idempotency key.",
      })),
      idempotencyKeys: [],
      faultInjectionCases: [],
    });
    upgraded.db.prepare(`
      INSERT INTO design_records(design_record_id, work_item_id, plan_revision_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("design-one", "review-work-item", "review-plan", payload, "2026-08-19T12:06:00.000Z");
    upgraded.db.prepare(`
      INSERT INTO work_item_design_tasks(work_item_id, task_id, created_at)
      VALUES (?, ?, ?)
    `).run("review-work-item", "design-task", "2026-08-19T12:07:00.000Z");

    assert.throws(() => upgraded.db.prepare(`
      INSERT INTO review_findings(
        finding_id, node_id, stage, round, category, severity, expected, actual, blocking, created_at
      ) VALUES ('finding-invalid', 'review-node', 'verification', 2, 'unknown', 'major', 'x', 'y', 0,
        '2026-08-19T12:08:00.000Z')
    `).run(), /CHECK constraint failed/u);
    assert.throws(() => upgraded.db.prepare(`
      INSERT INTO design_records(design_record_id, work_item_id, plan_revision_id, payload_json, created_at)
      VALUES ('design-invalid', 'review-work-item', 'review-plan', 'not-json', '2026-08-19T12:08:00.000Z')
    `).run(), /CHECK constraint failed/u);
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    upgraded.close();
  }
});

test("v21 migrates to v22 with park records, notifications, and gate actions", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const legacy = new DatabaseSync(path);
  try {
    const frozenV21 = await readFile(join(process.cwd(), "tests/server/task-board/fixtures/v21-schema.sql"), "utf8");
    const schemaKindOrder = ["-- table:", "-- index:", "-- trigger:"];
    const executableV21 = frozenV21
      .split(/(?=^-- (?:index|table|trigger): )/m)
      .sort((left, right) => schemaKindOrder.findIndex((prefix) => left.startsWith(prefix))
        - schemaKindOrder.findIndex((prefix) => right.startsWith(prefix)))
      .join("");
    legacy.exec(executableV21);
    legacy.exec(`
      INSERT INTO projects(project_id, name, description, version, created_at, updated_at)
      VALUES ('ledger-project', 'Ledger project', 'Exercises the v22 migration.', 1,
        '2026-08-20T12:00:00.000Z', '2026-08-20T12:00:00.000Z');
      INSERT INTO work_items(
        work_item_id, original_request, refined_objective, priority, project_target_mode,
        target_project_id, resolved_project_id, pipeline_branch, base_sha, state, current_stage,
        created_by, idempotency_key, request_hash, version, created_at, updated_at
      ) VALUES (
        'ledger-work-item', 'Preserve this work item.', 'Add durable observability.', 'normal', 'explicit',
        'ledger-project', 'ledger-project', 'pipeline/ledger-work-item',
        '0123456789abcdef0123456789abcdef01234567', 'parked', 'planning',
        'system:migration-test', 'ledger-migration-key', 'ledger-migration-hash', 1,
        '2026-08-20T12:01:00.000Z', '2026-08-20T12:02:00.000Z'
      );
      PRAGMA user_version = 21;
    `);
  } finally {
    legacy.close();
  }
  await chmod(path, 0o600);

  const upgraded = await TaskBoardStore.open(path);
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 24);
    const columns = (table: string): string[] => upgraded.db.prepare(`PRAGMA table_info(${table})`).all()
      .map((row) => String(row.name));
    assert.deepEqual(columns("park_records"), [
      "park_record_id", "work_item_id", "category", "reason", "parked_at", "resolved_at", "resolution",
    ]);
    assert.deepEqual(columns("notifications"), [
      "notification_id", "sequence", "kind", "dedupe_key", "project_id", "work_item_id",
      "summary", "created_at", "read_at", "version",
    ]);
    assert.deepEqual(columns("gate_actions"), [
      "gate_action_id", "work_item_id", "gate", "actor_id", "plan_revision_id", "verified_sha",
      "merge_sha", "ref_id", "note", "created_at",
    ]);
    assert.deepEqual(
      { ...upgraded.db.prepare(`
        SELECT original_request, refined_objective, pipeline_branch, base_sha, state
        FROM work_items WHERE work_item_id = 'ledger-work-item'
      `).get() },
      {
        original_request: "Preserve this work item.",
        refined_objective: "Add durable observability.",
        pipeline_branch: "pipeline/ledger-work-item",
        base_sha: "0123456789abcdef0123456789abcdef01234567",
        state: "parked",
      },
    );

    upgraded.db.prepare(`
      INSERT INTO park_records(
        park_record_id, work_item_id, category, reason, parked_at, resolved_at, resolution
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "park-record-one", "ledger-work-item", "open_question", "Waiting for an answer.",
      "2026-08-20T12:03:00.000Z", null, null,
    );
    upgraded.db.prepare(`
      INSERT INTO notifications(
        notification_id, sequence, kind, dedupe_key, project_id, work_item_id,
        summary, created_at, read_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "notification-one", 1, "park_aged", "park-aged:park-record-one", "ledger-project", "ledger-work-item",
      "The work item has remained parked.", "2026-08-20T12:04:00.000Z", null, 1,
    );
    upgraded.db.prepare(`
      INSERT INTO gate_actions(
        gate_action_id, work_item_id, gate, actor_id, plan_revision_id,
        verified_sha, merge_sha, ref_id, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "gate-action-one", "ledger-work-item", "cancel", "human:operator", null,
      "0123456789abcdef0123456789abcdef01234567", null, "request-one", "Cancelled deliberately.",
      "2026-08-20T12:05:00.000Z",
    );
    assert.equal(upgraded.db.prepare("SELECT count(*) AS count FROM park_records").get()?.count, 1);
    assert.equal(upgraded.db.prepare("SELECT count(*) AS count FROM notifications").get()?.count, 1);
    assert.equal(upgraded.db.prepare("SELECT count(*) AS count FROM gate_actions").get()?.count, 1);
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    upgraded.close();
  }
});

test("v22 migrates to v23 without changing old ledger bytes and widens both enum CHECKs", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const legacy = new DatabaseSync(path);
  let parkRowsBefore: Array<Record<string, unknown>> = [];
  let notificationRowsBefore: Array<Record<string, unknown>> = [];
  try {
    const frozenV22 = await readFile(join(process.cwd(), "tests/server/task-board/fixtures/v22-schema.sql"), "utf8");
    const schemaKindOrder = ["-- table:", "-- index:", "-- trigger:"];
    const executableV22 = frozenV22
      .split(/(?=^-- (?:index|table|trigger): )/m)
      .sort((left, right) => schemaKindOrder.findIndex((prefix) => left.startsWith(prefix))
        - schemaKindOrder.findIndex((prefix) => right.startsWith(prefix)))
      .join("");
    legacy.exec(executableV22);
    legacy.exec(`
      INSERT INTO projects(project_id, name, description, version, created_at, updated_at)
      VALUES ('v23-project', 'Migration project', 'Exercises the v23 rebuild.', 1,
        '2026-08-21T12:00:00.000Z', '2026-08-21T12:00:00.000Z');
      INSERT INTO work_items(
        work_item_id, original_request, refined_objective, priority, project_target_mode,
        target_project_id, resolved_project_id, pipeline_branch, base_sha, state, current_stage,
        created_by, idempotency_key, request_hash, version, created_at, updated_at
      ) VALUES (
        'v23-work-item', 'Preserve every v22 ledger row.', 'Widen CHECK-backed enums.', 'normal', 'explicit',
        'v23-project', 'v23-project', 'pipeline/v23-work-item',
        '0123456789abcdef0123456789abcdef01234567', 'parked', 'planning',
        'system:migration-test', 'v23-migration-key', 'v23-migration-hash', 1,
        '2026-08-21T12:01:00.000Z', '2026-08-21T12:01:00.000Z'
      );
    `);
    const insertPark = legacy.prepare(`
      INSERT INTO park_records(
        park_record_id, work_item_id, category, reason, parked_at, resolved_at, resolution
      ) VALUES (?, 'v23-work-item', ?, ?, ?, ?, ?)
    `);
    for (const [index, category] of V22_PARK_CATEGORIES.entries()) {
      const resolution = index === 0 ? null : PARK_RESOLUTIONS[(index - 1) % PARK_RESOLUTIONS.length];
      insertPark.run(
        `v22-park-${index}`,
        category,
        `Preserve ${category} byte-for-byte — café ${index}.`,
        `2026-08-21T12:${String(index + 2).padStart(2, "0")}:00.000Z`,
        resolution === null ? null : `2026-08-21T13:${String(index).padStart(2, "0")}:00.000Z`,
        resolution,
      );
    }
    const insertNotification = legacy.prepare(`
      INSERT INTO notifications(
        notification_id, sequence, kind, dedupe_key, project_id, work_item_id,
        summary, created_at, read_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [index, kind] of V22_NOTIFICATION_KINDS.entries()) {
      insertNotification.run(
        `v22-notification-${index}`,
        11 + index * 18,
        kind,
        index === 0 ? `v22-dedupe-${index}` : null,
        index === 0 ? "v23-project" : null,
        index === 0 ? "v23-work-item" : null,
        `Preserve ${kind} byte-for-byte — café ${index}.`,
        `2026-08-21T14:0${index}:00.000Z`,
        index === 0 ? null : `2026-08-21T15:0${index}:00.000Z`,
        index + 3,
      );
    }
    parkRowsBefore = legacy.prepare("SELECT rowid, * FROM park_records ORDER BY rowid").all()
      .map((row) => ({ ...row }));
    notificationRowsBefore = legacy.prepare("SELECT rowid, * FROM notifications ORDER BY rowid").all()
      .map((row) => ({ ...row }));
    legacy.exec("PRAGMA user_version = 22;");
  } finally {
    legacy.close();
  }
  await chmod(path, 0o600);

  const upgraded = await TaskBoardStore.open(path);
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 24);
    assert.deepEqual(
      upgraded.db.prepare("SELECT rowid, * FROM park_records ORDER BY rowid").all().map((row) => ({ ...row })),
      parkRowsBefore,
    );
    assert.deepEqual(
      upgraded.db.prepare("SELECT rowid, * FROM notifications ORDER BY rowid").all().map((row) => ({ ...row })),
      notificationRowsBefore,
    );

    const tableSql = (name: string): string => String(upgraded.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name)?.sql);
    assert.ok(tableSql("park_records").includes(`CHECK (category IN (${sqlList(PARK_CATEGORIES)}))`));
    assert.ok(tableSql("notifications").includes(`CHECK (kind IN (${sqlList(NOTIFICATION_KINDS)}))`));

    const insertPark = upgraded.db.prepare(`
      INSERT INTO park_records(
        park_record_id, work_item_id, category, reason, parked_at, resolved_at, resolution
      ) VALUES (?, 'v23-work-item', ?, 'Migration insertability check.', '2026-08-21T16:00:00.000Z', NULL, NULL)
    `);
    for (const [index, category] of [...V22_PARK_CATEGORIES, ...PARK_CATEGORIES.slice(V22_PARK_CATEGORIES.length)].entries()) {
      insertPark.run(`post-v23-park-${index}`, category);
    }
    const insertNotification = upgraded.db.prepare(`
      INSERT INTO notifications(
        notification_id, sequence, kind, dedupe_key, project_id, work_item_id,
        summary, created_at, read_at, version
      ) VALUES (?, ?, ?, ?, NULL, NULL, 'Migration insertability check.', '2026-08-21T16:01:00.000Z', NULL, 1)
    `);
    for (const [index, kind] of [...V22_NOTIFICATION_KINDS, ...NOTIFICATION_KINDS.slice(V22_NOTIFICATION_KINDS.length)].entries()) {
      insertNotification.run(`post-v23-notification-${index}`, 100 + index, kind, `post-v23-dedupe-${index}`);
    }
    assert.throws(
      () => insertNotification.run("duplicate-sequence", 100, "cap_parked", "unique-dedupe"),
      /UNIQUE/u,
    );
    assert.throws(
      () => insertNotification.run("duplicate-dedupe", 999, "cap_parked", "post-v23-dedupe-0"),
      /UNIQUE/u,
    );

    assert.deepEqual({ ...upgraded.db.prepare(`
      SELECT paused, reason, version, updated_at, updated_by
      FROM board_pause WHERE pause_id = 'board'
    `).get() }, {
      paused: 0,
      reason: null,
      version: 1,
      updated_at: "1970-01-01T00:00:00.000Z",
      updated_by: "system:steward-default",
    });
    assert.ok(tableSql("board_pause").includes("pause_id TEXT PRIMARY KEY CHECK (pause_id = 'board')"));
    assert.throws(
      () => upgraded.db.prepare("UPDATE board_pause SET pause_id = 'other' WHERE pause_id = 'board'").run(),
      /CHECK/u,
    );
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(upgraded.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  } finally {
    upgraded.close();
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
    { id: "migration-06-human-review", state: "waiting_for_human_review", currentStage: "human_review", migratedState: "plan_approval" },
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
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 24);
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
    assert.equal(reopened.db.prepare("PRAGMA user_version").get()?.user_version, 24);
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
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 24);
    assert.equal(
      upgraded.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='project_events_node'").get()?.sql,
      "CREATE INDEX project_events_node ON project_events(node_id, sequence)",
    );
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    upgraded.close();
  }
});
