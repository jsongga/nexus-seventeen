import assert from "node:assert/strict";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ACTOR_TYPES,
  AGENT_ROLES,
  DESIGN_FAILURE_POINTS,
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
  WORK_ITEM_PHASES,
  WORK_ITEM_STAGES,
  WORK_ITEM_STATES,
  WORK_ITEM_TERMINAL_STATES,
  WORK_NODE_STATES,
  WORKFLOW_STAGES,
} from "#shared/task-board-contract";
import { TaskBoardError } from "#server/task-board/errors";
import {
  TaskBoardStore,
  migrateVersion13To14,
  migrateVersion25To26,
  migrateVersion26To27,
} from "#server/task-board/persistence/store";
import { boardFixture, databasePath, workItemRequest } from "./helpers.js";

test("workflow persistence accepts contract identifiers and exactly the contract stages", async () => {
  const fixture = await boardFixture();
  try {
    for (const [index, stage] of [...WORKFLOW_STAGES, "not_a_contract_member"].entries()) {
      const item = fixture.board.createWorkItem(
        workItemRequest({
          projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
        }),
        `workflow-contract-${index}`
      ).workItem;
      const proposal = {
        workItemId: item.workItemId,
        projectId: fixture.project.projectId,
        objective: "Verify workflow contract derivation.",
        assumptions: [],
        acceptanceCriteria: ["The persistence validator stays aligned."],
        skillIds: [],
        nodes: [
          {
            nodeId: "Node/One",
            title: "Inspect persistence",
            objective: "Verify persistence accepts the shared contract.",
            acceptanceCriteria: ["The proposal is persisted."],
            dependencyNodeIds: [],
            stageTemplate: stage === "verification" ? [stage] : [stage, "verification"],
          },
        ],
      };
      if (stage === "not_a_contract_member") {
        assert.throws(
          () => fixture.board.proposeWorkflow(proposal as never),
          (error: unknown) => error instanceof TaskBoardError && error.code === "WORKFLOW_INVALID"
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
  "open_question",
  "planning_run_failed",
  "design_run_failed",
  "hazardous_without_pipeline",
  "plan_rejected_twice",
  "bright_line",
  "scope_violation",
] as const;
const V22_NOTIFICATION_KINDS = ["park_aged", "park_auto_abandoned"] as const;
const V25_WORK_ITEM_STATES = [
  "queued",
  "planning",
  "plan_approval",
  "designing",
  "implementing",
  "verifying",
  "reviewing",
  "fixing",
  "final_approval",
  "merged",
  "parked",
  "abandoned",
  "dead_letter",
] as const;
const V25_NOTIFICATION_KINDS = ["park_aged", "park_auto_abandoned", "cap_parked", "final_approval_withdrawn"] as const;
const V25_PARK_CATEGORIES = [
  "open_question",
  "planning_run_failed",
  "design_run_failed",
  "hazardous_without_pipeline",
  "plan_rejected_twice",
  "bright_line",
  "scope_violation",
  "stage_cap_exceeded",
  "task_cap_exceeded",
  "base_diverged",
] as const;
const V25_GATE_KINDS = [
  "plan_confirm",
  "plan_reject",
  "final_approve",
  "final_reject",
  "cancel",
  "question_answer",
] as const;

/**
 * SQLite's ALTER TABLE ADD COLUMN appends the definition onto the last column's
 * line, where the fresh schema gives it its own. Measured, that newline and its
 * two spaces are the entire difference between a migrated and a fresh v27
 * `work_items`. Normalizing exactly it keeps every other byte exact.
 */
function normalizeAlteredWorkItems(sql: string): string {
  return sql.replace(
    "  archived_at TEXT, repository_id TEXT NULL REFERENCES repositories(repository_id) ON DELETE RESTRICT,",
    "  archived_at TEXT,\n  repository_id TEXT NULL REFERENCES repositories(repository_id) ON DELETE RESTRICT,"
  );
}

function frozenProjection(store: TaskBoardStore, version: 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27): string {
  const rows = store.db
    .prepare(
      `
    SELECT type, name, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `
    )
    .all() as Array<Readonly<{ type: string; name: string; sql: string }>>;
  return `${rows
    .filter(
      (row) =>
        ![
          ...(version <= 22 ? ["board_pause"] : []),
          ...(version <= 23
            ? ["work_item_onboarding_tasks", "onboarding_once_per_project", "onboarding_task_link"]
            : []),
          ...(version <= 21 ? ["park_records", "notifications", "gate_actions"] : []),
          ...(version <= 20 ? ["review_findings", "design_records", "work_item_design_tasks"] : []),
          ...(version === 19 ? ["verify_attempts"] : []),
          ...(version <= 25 ? ["work_item_dependencies"] : []),
          ...(version <= 26 ? ["repositories", "repositories_project", "repositories_one_primary"] : []),
        ].includes(row.name)
    )
    .map((row) => {
      let sql = row.sql;
      if (version <= 25 && row.name === "projects") {
        sql = sql.replace("  repo_path TEXT NOT NULL,\n", "");
      }
      if (version <= 25 && row.name === "work_items") {
        sql = sql
          .replace(
            "  parent_work_item_id TEXT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,\n" +
              `  phase TEXT NULL CHECK (phase IS NULL OR phase IN (${sqlList(WORK_ITEM_PHASES)})),\n` +
              "  child_ordinal INTEGER NULL,\n",
            ""
          )
          .replace(sqlList(WORK_ITEM_STATES), sqlList(V25_WORK_ITEM_STATES));
      }
      if (version <= 26 && row.name === "work_items") {
        sql = sql.replace("  repository_id TEXT NULL REFERENCES repositories(repository_id) ON DELETE RESTRICT,\n", "");
      }
      if (row.name === "work_items") sql = normalizeAlteredWorkItems(sql);
      if (version <= 25 && row.name === "plan_revisions") {
        sql = sql.replace(" children TEXT NULL,", "");
      }
      if (version <= 25 && row.name === "work_item_transitions") {
        sql = sql.replaceAll(sqlList(WORK_ITEM_STATES), sqlList(V25_WORK_ITEM_STATES));
      }
      if (version <= 25 && row.name === "notifications") {
        sql = sql.replace(
          sqlList(NOTIFICATION_KINDS),
          sqlList(version <= 22 ? V22_NOTIFICATION_KINDS : V25_NOTIFICATION_KINDS)
        );
      }
      if (version <= 25 && row.name === "gate_actions") {
        sql = sql.replace(sqlList(GATE_KINDS), sqlList(V25_GATE_KINDS));
      }
      if (version <= 25 && row.name === "park_records") {
        sql = sql.replace(
          sqlList(PARK_CATEGORIES),
          sqlList(version === 22 ? V22_PARK_CATEGORIES : V25_PARK_CATEGORIES)
        );
      }
      if (version <= 25 && row.name === "verify_attempts") {
        sql = sql.replace(
          "state IN ('starting','running','green','failed','died','failed_to_start','retired')",
          "state IN ('starting','running','green','failed','died','failed_to_start')"
        );
      }
      if (version === 19 && row.name === "work_items") {
        sql = sql.replace("  pipeline_branch TEXT NULL,\n  base_sha TEXT NULL,\n", "");
      } else if (version === 19 && row.name === "plan_revisions") {
        sql = sql.replace(
          "  change_shape TEXT NULL,\n  tier TEXT NULL,\n  declared_scope_json TEXT NULL,\n  non_goals_json TEXT NULL,\n" +
            "  mechanical_portions_json TEXT NULL,\n  blocking_questions_json TEXT NULL,\n" +
            "  criterion_checks_json TEXT NULL,\n  rejected_note TEXT NULL,\n",
          ""
        );
      }
      return `-- ${row.type}: ${row.name}\n${sql};`;
    })
    .join("\n\n")}\n`;
}

function withoutRetiredDocumentSchema(schema: string): string {
  return schema
    .split(/(?=^-- (?:index|table|trigger): )/mu)
    .filter(
      (section) =>
        !/^-- (?:index|table): (?:document_events|document_events_project|documents|documents_project)$/mu.test(
          section.split("\n", 1)[0] ?? ""
        )
    )
    .join("");
}

async function installFrozenSchema(path: string, version: 23 | 24 | 25): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const legacy = new DatabaseSync(path);
  try {
    const frozen = await readFile(
      join(process.cwd(), `tests/server/task-board/fixtures/v${version}-schema.sql`),
      "utf8"
    );
    const schemaKindOrder = ["-- table:", "-- index:", "-- trigger:"];
    const executable = frozen
      .split(/(?=^-- (?:index|table|trigger): )/m)
      .sort(
        (left, right) =>
          schemaKindOrder.findIndex((prefix) => left.startsWith(prefix)) -
          schemaKindOrder.findIndex((prefix) => right.startsWith(prefix))
      )
      .join("");
    legacy.exec(executable);
    legacy.exec(`PRAGMA user_version = ${version};`);
  } finally {
    legacy.close();
  }
  await chmod(path, 0o600);
}

async function installVersion10Schema(path: string): Promise<void> {
  await installFrozenSchema(path, 24);
  const { DatabaseSync } = await import("node:sqlite");
  const legacy = new DatabaseSync(path);
  try {
    // These are exactly the tables introduced after v10 by migrations 10->11 through 23->24.
    // Removing them from the frozen pre-v26 schema makes migrateVersion10To11 create workflow
    // storage from the current WORKFLOW_SCHEMA, including columns added after v10.
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE work_item_onboarding_tasks;
      DROP TABLE gate_actions;
      DROP TABLE notifications;
      DROP TABLE park_records;
      DROP TABLE work_item_design_tasks;
      DROP TABLE design_records;
      DROP TABLE review_findings;
      DROP TABLE work_item_planning_tasks;
      DROP TABLE verify_attempts;
      DROP TABLE project_events;
      DROP TABLE artifacts;
      DROP TABLE stage_handoffs;
      DROP TABLE stage_attempts;
      DROP TABLE work_node_dependencies;
      DROP TABLE work_nodes;
      DROP TABLE plan_revisions;
      DROP TABLE work_item_transitions;
      DROP TABLE board_pause;
      PRAGMA user_version = 10;
    `);
  } finally {
    legacy.close();
  }
}

interface HistoricalSchemaObject {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string | null;
}

async function historicalVersion14TaskSchema(): Promise<readonly HistoricalSchemaObject[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await installFrozenSchema(path, 25);
  const historical = new DatabaseSync(path);
  try {
    migrateVersion13To14(historical);
    return historical
      .prepare(
        `
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_master
      WHERE tbl_name IN ('tasks', 'wakeups')
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name
    `
      )
      .all() as unknown as readonly HistoricalSchemaObject[];
  } finally {
    historical.close();
  }
}

async function installLegacyQuotedTaskSchema(
  path: string,
  legacyTables: readonly ("tasks" | "wakeups")[]
): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const historicalObjects = await historicalVersion14TaskSchema();
  await installFrozenSchema(path, 25);
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec("PRAGMA foreign_keys = OFF;");
    for (const table of ["wakeups", "tasks"] as const) {
      if (legacyTables.includes(table)) legacy.exec(`DROP TABLE ${table};`);
    }
    for (const table of ["tasks", "wakeups"] as const) {
      if (!legacyTables.includes(table)) continue;
      for (const object of historicalObjects) {
        if (object.tableName === table && object.sql !== null) legacy.exec(`${object.sql};`);
      }
    }
    legacy.exec("PRAGMA user_version = 25;");
  } finally {
    legacy.close();
  }
  await chmod(path, 0o600);
}

function rowsJson(db: DatabaseSync, table: string): string {
  return JSON.stringify(
    db
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => ({ ...row }))
  );
}

function taskTableObjects(db: DatabaseSync, table: "tasks" | "wakeups"): string {
  return JSON.stringify(
    db
      .prepare(
        `
    SELECT type, name
    FROM sqlite_master
    WHERE tbl_name = ? AND type IN ('table', 'index', 'trigger')
    ORDER BY type, name
  `
      )
      .all(table)
      .map((row) => ({ ...row }))
  );
}

function migrationLeftovers(db: DatabaseSync): readonly unknown[] {
  return db
    .prepare(
      `
    SELECT type, name
    FROM sqlite_master
    WHERE name LIKE 'temp\\_%' ESCAPE '\\'
       OR name LIKE '%\\_v25' ESCAPE '\\'
       OR lower(name) LIKE '%backup%'
    ORDER BY type, name
  `
    )
    .all();
}

test("fresh v27 DDL preserves the byte-identical non-document v19 through v25 schemas", async () => {
  const store = await TaskBoardStore.open(await databasePath());
  try {
    assert.equal(store.db.prepare("PRAGMA user_version").get()?.user_version, 27);
    for (const version of [19, 20, 21, 22, 23, 24, 25] as const) {
      const fixturePath = join(process.cwd(), `tests/server/task-board/fixtures/v${version}-schema.sql`);
      // v25-schema.sql was generated before the version bump with the same mechanism as v24:
      // UPDATE_TASK_BOARD_SCHEMA_FIXTURES=1 node --test <compiled contract-drift suite>.
      const golden = await readFile(fixturePath, "utf8");
      assert.equal(frozenProjection(store, version), withoutRetiredDocumentSchema(golden));
    }
    assert.deepEqual(
      {
        ...store.db
          .prepare(
            `
      SELECT pause_id, paused, reason, version, updated_at, updated_by FROM board_pause
    `
          )
          .get(),
      },
      {
        pause_id: "board",
        paused: 0,
        reason: null,
        version: 1,
        updated_at: "1970-01-01T00:00:00.000Z",
        updated_by: "system:steward-default",
      }
    );
  } finally {
    store.close();
  }
});

test("v23 fixture migrates through v27 to the same schema as a fresh database", async () => {
  const path = await databasePath();
  await installFrozenSchema(path, 23);

  const upgraded = await TaskBoardStore.open(path);
  const fresh = await TaskBoardStore.open(await databasePath());
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 27);
    const onboardingColumns = upgraded.db.prepare("PRAGMA table_info(work_item_onboarding_tasks)").all();
    assert.deepEqual(
      onboardingColumns.map((row) => String(row.name)),
      ["work_item_id", "project_id", "task_id", "gap_report_artifact_id", "created_at"]
    );
    const gapReportColumn = onboardingColumns.find((row) => row.name === "gap_report_artifact_id");
    assert.ok(gapReportColumn);
    assert.deepEqual(
      {
        type: gapReportColumn.type,
        notnull: gapReportColumn.notnull,
        defaultValue: gapReportColumn.dflt_value,
      },
      { type: "TEXT", notnull: 0, defaultValue: null }
    );
    for (const [name, sql] of [
      [
        "onboarding_once_per_project",
        "CREATE UNIQUE INDEX onboarding_once_per_project ON work_item_onboarding_tasks(project_id)",
      ],
      ["onboarding_task_link", "CREATE UNIQUE INDEX onboarding_task_link ON work_item_onboarding_tasks(task_id)"],
    ] as const) {
      assert.equal(
        upgraded.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)?.sql,
        sql
      );
      assert.equal(fresh.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)?.sql, sql);
    }
    assert.equal(frozenProjection(upgraded, 27), frozenProjection(fresh, 27));
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    fresh.close();
    upgraded.close();
  }
});

test("v24 fixture migrates to the same v27 schema as a fresh database and retires document tables", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await installFrozenSchema(path, 24);
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      INSERT INTO projects(project_id, name, description, version, created_at, updated_at)
      VALUES ('migration-project', 'Migration project', 'Preserve this project.', 1,
        '2026-08-26T12:00:00.000Z', '2026-08-26T12:00:00.000Z');
      INSERT INTO documents(
        document_id, project_id, title, content_type, content, content_version, pen_epoch,
        pen_holder_actor_type, pen_holder_actor_id, pen_holder_client_id, pen_acquired_at,
        sequence, created_at, updated_at
      ) VALUES (
        'retired-document', 'migration-project', 'Retired document', 'text/markdown', '# Exported', 1, 1,
        NULL, NULL, NULL, NULL, 1, '2026-08-26T12:01:00.000Z', '2026-08-26T12:01:00.000Z'
      );
      INSERT INTO document_events(
        document_id, sequence, event_id, project_id, event_type, actor_type,
        actor_id, client_id, document_json, created_at
      ) VALUES (
        'retired-document', 1, 'retired-document-event', 'migration-project', 'document_created',
        'human', 'human:alice', 'migration-test', '{}', '2026-08-26T12:01:00.000Z'
      );
    `);
  } finally {
    legacy.close();
  }

  const upgraded = await TaskBoardStore.open(path);
  const fresh = await TaskBoardStore.open(await databasePath());
  try {
    for (const store of [upgraded, fresh]) {
      assert.equal(store.db.prepare("PRAGMA user_version").get()?.user_version, 27);
      for (const table of ["document_events", "documents"]) {
        assert.equal(
          store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
          undefined
        );
      }
    }
    assert.equal(
      upgraded.db.prepare("SELECT name FROM projects WHERE project_id = 'migration-project'").get()?.name,
      "Migration project"
    );
    assert.equal(frozenProjection(upgraded, 27), frozenProjection(fresh, 27));
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    fresh.close();
    upgraded.close();
  }
});

test("v25 fixture migrates to byte-identical fresh v27 DDL", async () => {
  const path = await databasePath();
  await installFrozenSchema(path, 25);
  const upgraded = await TaskBoardStore.open(path);
  const fresh = await TaskBoardStore.open(await databasePath());
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 27);
    assert.equal(frozenProjection(upgraded, 27), frozenProjection(fresh, 27));
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(upgraded.db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  } finally {
    fresh.close();
    upgraded.close();
  }
});

test("the v26 intermediate genuinely lacks repository_id, so the ALTER branch stays live", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await installFrozenSchema(path, 25);
  const db = new DatabaseSync(path);
  try {
    migrateVersion25To26(db);
    const columnsAtV26 = (db.prepare("PRAGMA table_info(work_items)").all() as { name: string }[]).map((c) => c.name);
    // If an applied migration ever interpolates the live work_items constant
    // again, this database arrives at v26 already carrying the column, the
    // ALTER below never runs, and every test that claims to prove the migration
    // is silently testing the fresh schema against itself.
    assert.equal(columnsAtV26.includes("repository_id"), false, "v26 must not already have repository_id");

    migrateVersion26To27(db);
    const migrated = (
      db.prepare("PRAGMA table_info(work_items)").all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
      }[]
    ).map((c) => `${c.name}|${c.type}|${c.notnull}|${String(c.dflt_value)}`);
    assert.ok(
      migrated.includes("repository_id|TEXT|0|null"),
      `ALTER did not add a nullable TEXT repository_id: ${migrated.join(", ")}`
    );

    const fresh = await TaskBoardStore.open(await databasePath());
    try {
      const freshColumns = (
        fresh.db.prepare("PRAGMA table_info(work_items)").all() as {
          name: string;
          type: string;
          notnull: number;
          dflt_value: unknown;
        }[]
      ).map((c) => `${c.name}|${c.type}|${c.notnull}|${String(c.dflt_value)}`);
      // Column identity and order are the substantive claim. The stored DDL
      // text differs by whitespace, because ALTER appends onto the previous
      // line while the fresh schema declares the column on its own — cosmetic,
      // and asserting on it would only pin SQLite's formatting.
      assert.deepEqual(migrated, freshColumns, "migrated and fresh work_items must agree column for column");
    } finally {
      fresh.close();
    }
  } finally {
    db.close();
  }
});

test("a real v26 database migrates every project to one primary repository and matches fresh v27 shape", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await installFrozenSchema(path, 25);
  const legacy = new DatabaseSync(path);
  const createdAt = "2026-09-06T12:00:00.000Z";
  const updatedAt = "2026-09-06T12:30:00.000Z";
  try {
    migrateVersion25To26(legacy);
    assert.equal(legacy.prepare("PRAGMA user_version").get()?.user_version, 26);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      INSERT INTO projects(project_id, name, description, repo_path, version, created_at, updated_at)
      VALUES
        ('v26-api', 'API repository', 'API project.', '/repos/api', 4, '${createdAt}', '${updatedAt}'),
        ('v26-web', 'Web repository', 'Web project.', '/repos/東京-web', 2, '${createdAt}', '${createdAt}');
    `);
  } finally {
    legacy.close();
  }

  const upgraded = await TaskBoardStore.open(path);
  const fresh = await TaskBoardStore.open(await databasePath());
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 27);
    assert.deepEqual(
      upgraded.db
        .prepare(
          `
      SELECT
        project.project_id,
        project.repo_path,
        COUNT(repository.repository_id) AS repository_count,
        SUM(CASE WHEN repository.is_primary = 1 THEN 1 ELSE 0 END) AS primary_count,
        MAX(CASE WHEN repository.is_primary = 1 THEN repository.path END) AS primary_path
      FROM projects project
      LEFT JOIN repositories repository ON repository.project_id = project.project_id
      GROUP BY project.project_id, project.repo_path
      ORDER BY project.project_id
    `
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          project_id: "v26-api",
          repo_path: "/repos/api",
          repository_count: 1,
          primary_count: 1,
          primary_path: "/repos/api",
        },
        {
          project_id: "v26-web",
          repo_path: "/repos/東京-web",
          repository_count: 1,
          primary_count: 1,
          primary_path: "/repos/東京-web",
        },
      ]
    );
    assert.deepEqual(
      upgraded.db
        .prepare(
          `
      SELECT project_id, name, path, is_primary, version, created_at, updated_at
      FROM repositories
      ORDER BY project_id
    `
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          project_id: "v26-api",
          name: "API repository",
          path: "/repos/api",
          is_primary: 1,
          version: 1,
          created_at: createdAt,
          updated_at: updatedAt,
        },
        {
          project_id: "v26-web",
          name: "Web repository",
          path: "/repos/東京-web",
          is_primary: 1,
          version: 1,
          created_at: createdAt,
          updated_at: createdAt,
        },
      ]
    );
    const repositoryIdColumn = upgraded.db
      .prepare("PRAGMA table_info(work_items)")
      .all()
      .find((row) => row.name === "repository_id");
    assert.ok(repositoryIdColumn);
    assert.deepEqual(
      {
        type: repositoryIdColumn.type,
        notnull: repositoryIdColumn.notnull,
        defaultValue: repositoryIdColumn.dflt_value,
      },
      { type: "TEXT", notnull: 0, defaultValue: null }
    );
    const schema = (store: TaskBoardStore): readonly unknown[] =>
      store.db
        .prepare(
          `
        SELECT type, name, tbl_name AS table_name, sql
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `
        )
        .all()
        .map((row) => ({ ...row, sql: typeof row.sql === "string" ? normalizeAlteredWorkItems(row.sql) : row.sql }));
    assert.deepEqual(schema(upgraded), schema(fresh));
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(upgraded.db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  } finally {
    fresh.close();
    upgraded.close();
  }
});

test("v26-to-v27 convergence does not duplicate repositories when its body runs twice", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await installFrozenSchema(path, 25);
  const db = new DatabaseSync(path);
  try {
    migrateVersion25To26(db);
    db.exec(`
      INSERT INTO projects(project_id, name, description, repo_path, version, created_at, updated_at)
      VALUES ('v27-idempotent', 'Idempotent repository', 'Preserve the repository.', '/repos/idempotent', 1,
        '2026-09-06T13:00:00.000Z', '2026-09-06T13:00:00.000Z');
    `);
    migrateVersion26To27(db);
    const afterFirst = JSON.stringify({
      repositories: db
        .prepare("SELECT * FROM repositories ORDER BY repository_id")
        .all()
        .map((row) => ({ ...row })),
      workItemColumns: db
        .prepare("PRAGMA table_info(work_items)")
        .all()
        .map((row) => ({ ...row })),
    });
    db.exec("PRAGMA user_version = 26;");
    migrateVersion26To27(db);
    const afterSecond = JSON.stringify({
      repositories: db
        .prepare("SELECT * FROM repositories ORDER BY repository_id")
        .all()
        .map((row) => ({ ...row })),
      workItemColumns: db
        .prepare("PRAGMA table_info(work_items)")
        .all()
        .map((row) => ({ ...row })),
    });

    assert.equal(afterSecond, afterFirst);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM repositories").get()?.count, 1);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 27);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  } finally {
    db.close();
  }
});

test("repositories reject a second primary for the same project", async () => {
  const store = await TaskBoardStore.open(await databasePath());
  const createdAt = "2026-09-06T14:00:00.000Z";
  try {
    store.db.exec(`
      INSERT INTO projects(project_id, name, description, repo_path, version, created_at, updated_at)
      VALUES ('primary-project', 'Primary project', 'Test primary uniqueness.', '/repos/primary', 1,
        '${createdAt}', '${createdAt}');
      INSERT INTO repositories(
        repository_id, project_id, name, path, is_primary, version, created_at, updated_at
      ) VALUES (
        'primary-one', 'primary-project', 'Primary one', '/repos/primary', 1, 1, '${createdAt}', '${createdAt}'
      );
    `);
    assert.throws(
      () =>
        store.db
          .prepare(
            `
          INSERT INTO repositories(
            repository_id, project_id, name, path, is_primary, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, 1, ?, ?)
        `
          )
          .run("primary-two", "primary-project", "Primary two", "/repos/secondary", createdAt, createdAt),
      /UNIQUE constraint failed: repositories\.project_id/u
    );
  } finally {
    store.close();
  }
});

test("v10 workflow creation migrates through v27 to byte-identical fresh DDL", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await installVersion10Schema(path);
  const before = new DatabaseSync(path);
  try {
    assert.equal(before.prepare("PRAGMA user_version").get()?.user_version, 10);
    assert.equal(
      before.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_revisions'").get(),
      undefined
    );
  } finally {
    before.close();
  }

  const upgraded = await TaskBoardStore.open(path);
  const fresh = await TaskBoardStore.open(await databasePath());
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 27);
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(upgraded.db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
    assert.equal(frozenProjection(upgraded, 27), frozenProjection(fresh, 27));
  } finally {
    fresh.close();
    upgraded.close();
  }
});

test("populated v14-quoted task tables migrate without changing rows, references, or schema objects", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await installLegacyQuotedTaskSchema(path, ["tasks", "wakeups"]);
  const legacy = new DatabaseSync(path);
  const createdAt = "2026-08-28T12:00:00.000Z";
  const preservedTables = ["agents", "tasks", "task_phases", "questions", "wakeups", "runs"] as const;
  let rowsBefore: Readonly<Record<string, string>>;
  let objectsBefore: Readonly<Record<"tasks" | "wakeups", string>>;
  try {
    assert.match(
      String(legacy.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get()?.sql),
      /^CREATE TABLE "tasks"/u
    );
    assert.match(
      String(legacy.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='wakeups'").get()?.sql),
      /^CREATE TABLE "wakeups"/u
    );
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      INSERT INTO projects(project_id, name, description, version, created_at, updated_at)
      VALUES ('legacy-project', 'Quoted migration', 'Répertoire naïf — 東京', 4, '${createdAt}', '${createdAt}');
      INSERT INTO agents(
        agent_id, project_id, role, area, mission, model, token_hash, last_error, version, created_at
      ) VALUES
        ('agent-engineer', 'legacy-project', 'engineer', 'Données', 'Préserver les octets.', 'gpt-test',
          'token-engineer-é', NULL, 2, '${createdAt}'),
        ('agent-manager', 'legacy-project', 'manager', '調整', 'Keep references intact.', 'gpt-test',
          'token-manager-東京', 'Dernière erreur résolue.', 3, '${createdAt}');
      INSERT INTO tasks(
        task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
        title, objective, acceptance_criteria, workspace_refs_json, status,
        assigned_agent_id, assigned_role, expected_agent_minutes, agent_estimate_minutes,
        estimate_recorded_at, order_key, started_at, ended_at, result, version, created_at, updated_at
      ) VALUES
        ('task-root', 'legacy-project', NULL, 'work', NULL, 1,
          'Racine 東京', 'Préserver la tâche racine.', 'Tous les octets survivent.', '["src/東京.ts"]', 'backlog',
          NULL, NULL, 60, NULL, NULL, 0, NULL, NULL, NULL, 5, '${createdAt}', '${createdAt}'),
        ('task-review', 'legacy-project', 'task-root', 'manager_review', 'manager', 1,
          'Révision naïve', 'Vérifier les références.', 'La relation parent reste valide.', '[]', 'in_progress',
          'agent-manager', 'manager', 120, 90, '${createdAt}', 1, '${createdAt}', NULL, NULL, 2,
          '${createdAt}', '${createdAt}'),
        ('task-café', 'legacy-project', 'task-root', 'work', NULL, 0,
          'Café terminé', 'Conserver le résultat.', 'Le texte non ASCII est identique.', '["résultats/é.txt"]', 'completed',
          'agent-engineer', 'engineer', 45, NULL, NULL, 2, '${createdAt}', '${createdAt}', 'Résultat 東京', 7,
          '${createdAt}', '${createdAt}');
      INSERT INTO task_phases(
        phase_id, project_id, task_id, title, stage, status, parallel_group,
        order_key, started_at, ended_at, version, created_at, updated_at
      ) VALUES
        ('phase-root', 'legacy-project', 'task-root', 'Étudier 東京', 'research', 'pending', NULL,
          0, NULL, NULL, 1, '${createdAt}', '${createdAt}'),
        ('phase-review', 'legacy-project', 'task-review', 'Réviser', 'planning', 'in_progress', 'groupe-é',
          1, '${createdAt}', NULL, 2, '${createdAt}', '${createdAt}');
      INSERT INTO questions(
        question_id, project_id, task_id, agent_id, run_id, client_event_id, request_hash,
        question, status, answer, asked_at, answered_at, answered_by, version
      ) VALUES
        ('question-open', 'legacy-project', 'task-root', 'agent-engineer', 'question-run', 'question-event-é',
          'question-hash-é', 'Où est 東京 ?', 'open', NULL, '${createdAt}', NULL, NULL, 1),
        ('question-answered', 'legacy-project', 'task-review', 'agent-manager', 'answer-run', 'answer-event-é',
          'answer-hash-é', 'Continuer ?', 'answered', 'Oui — 続行', '${createdAt}', '${createdAt}', 'human:élise', 2);
      INSERT INTO wakeups(
        wakeup_id, project_id, agent_id, reason, source_key, task_id, question_id,
        detail, created_by, created_at, claimed_at, run_id
      ) VALUES
        ('wakeup-assignment', 'legacy-project', 'agent-engineer', 'human_assignment', 'source-assignment-é',
          'task-root', NULL, 'Affectation reçue — 東京', 'human:élise', '${createdAt}', NULL, NULL),
        ('wakeup-answer', 'legacy-project', 'agent-manager', 'human_answer', 'source-answer-é',
          'task-review', 'question-answered', 'Réponse reçue.', 'human:élise', '${createdAt}', '${createdAt}', 'run-answer'),
        ('wakeup-resume', 'legacy-project', 'agent-engineer', 'resumed', 'source-resume-é',
          NULL, NULL, 'Reprendre sans tâche.', 'system:réveil', '${createdAt}', NULL, NULL);
      INSERT INTO runs(
        run_id, claim_id, claim_request_hash, claim_result_json, project_id, agent_id,
        wakeup_id, task_id, status, started_at, ended_at, result, heartbeat_at,
        runtime, runtime_version, model, prompts_sha
      ) VALUES
        ('run-answer', 'claim-answer', 'claim-hash-é', '{"résultat":"東京"}', 'legacy-project', 'agent-manager',
          'wakeup-answer', 'task-review', 'active', '${createdAt}', NULL, NULL, NULL,
          'node', '22.18.0', 'gpt-test', 'sha256:é'),
        ('run-complete', 'claim-complete', 'claim-complete-hash', NULL, 'legacy-project', 'agent-engineer',
          'wakeup-assignment', 'task-root', 'completed', '${createdAt}', '${createdAt}', 'Terminé — 東京', '${createdAt}',
          NULL, NULL, NULL, NULL);
    `);
    rowsBefore = Object.fromEntries(preservedTables.map((table) => [table, rowsJson(legacy, table)]));
    objectsBefore = {
      tasks: taskTableObjects(legacy, "tasks"),
      wakeups: taskTableObjects(legacy, "wakeups"),
    };
  } finally {
    legacy.close();
  }

  const upgraded = await TaskBoardStore.open(path);
  const fresh = await TaskBoardStore.open(await databasePath());
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 27);
    for (const table of preservedTables) assert.equal(rowsJson(upgraded.db, table), rowsBefore[table], table);
    for (const table of ["tasks", "wakeups"] as const) {
      assert.equal(taskTableObjects(upgraded.db, table), objectsBefore[table]);
      assert.equal(taskTableObjects(upgraded.db, table), taskTableObjects(fresh.db, table));
    }
    assert.deepEqual(
      upgraded.db
        .prepare(
          `
      SELECT runs.run_id, tasks.task_id, wakeups.wakeup_id
      FROM runs
      JOIN tasks ON tasks.task_id = runs.task_id
      JOIN wakeups ON wakeups.wakeup_id = runs.wakeup_id
      ORDER BY runs.rowid
    `
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { run_id: "run-answer", task_id: "task-review", wakeup_id: "wakeup-answer" },
        { run_id: "run-complete", task_id: "task-root", wakeup_id: "wakeup-assignment" },
      ]
    );
    assert.deepEqual(
      upgraded.db
        .prepare(
          `
      SELECT task_phases.phase_id, tasks.task_id
      FROM task_phases JOIN tasks ON tasks.task_id = task_phases.task_id
      ORDER BY task_phases.rowid
    `
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { phase_id: "phase-root", task_id: "task-root" },
        { phase_id: "phase-review", task_id: "task-review" },
      ]
    );
    assert.deepEqual(
      upgraded.db
        .prepare(
          `
      SELECT wakeups.wakeup_id, tasks.task_id, questions.question_id
      FROM wakeups
      LEFT JOIN tasks ON tasks.task_id = wakeups.task_id
      LEFT JOIN questions ON questions.question_id = wakeups.question_id
      ORDER BY wakeups.rowid
    `
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { wakeup_id: "wakeup-assignment", task_id: "task-root", question_id: null },
        { wakeup_id: "wakeup-answer", task_id: "task-review", question_id: "question-answered" },
        { wakeup_id: "wakeup-resume", task_id: null, question_id: null },
      ]
    );
    assert.deepEqual(migrationLeftovers(upgraded.db), []);
    assert.deepEqual(upgraded.db.prepare("SELECT type, name FROM sqlite_temp_master ORDER BY type, name").all(), []);
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(upgraded.db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
    assert.equal(frozenProjection(upgraded, 27), frozenProjection(fresh, 27));
  } finally {
    fresh.close();
    upgraded.close();
  }
});

test("v25-to-v26 canonicalizes a lone legacy tasks table without requiring wakeups", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await installLegacyQuotedTaskSchema(path, ["tasks"]);
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec("PRAGMA foreign_keys = OFF; DROP TABLE wakeups; PRAGMA user_version = 25;");
    assert.match(
      String(legacy.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get()?.sql),
      /^CREATE TABLE "tasks"/u
    );
  } finally {
    legacy.close();
  }

  const upgraded = await TaskBoardStore.open(path);
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 27);
    assert.match(
      String(upgraded.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get()?.sql),
      /^CREATE TABLE tasks \(/u
    );
    assert.deepEqual(migrationLeftovers(upgraded.db), []);
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(upgraded.db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  } finally {
    upgraded.close();
  }
});

test("v25-to-v26 preserves pre-existing decomposition columns when its body runs twice", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await installFrozenSchema(path, 25);
  const db = new DatabaseSync(path);
  const createdAt = "2026-08-28T12:00:00.000Z";
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      ALTER TABLE projects ADD COLUMN repo_path TEXT NULL;
      ALTER TABLE work_items ADD COLUMN parent_work_item_id TEXT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT;
      ALTER TABLE work_items ADD COLUMN phase TEXT NULL;
      ALTER TABLE work_items ADD COLUMN child_ordinal INTEGER NULL;
      INSERT INTO projects(project_id, name, description, repo_path, version, created_at, updated_at)
      VALUES ('idempotent-project', 'Idempotent migration', 'Human-readable description.', '/repos/東京-provider',
        2, '${createdAt}', '${createdAt}');
      INSERT INTO work_items(
        work_item_id, original_request, refined_objective, priority, project_target_mode,
        target_project_id, resolved_project_id, parent_work_item_id, phase, child_ordinal,
        pipeline_branch, base_sha, state, current_stage, created_by, idempotency_key,
        request_hash, version, created_at, updated_at, ended_at, cancelled_reason, archived_at
      ) VALUES
        ('idempotent-parent', 'Coordinate the migration.', NULL, 'high', 'explicit',
          'idempotent-project', 'idempotent-project', NULL, 'expand', 0,
          'task/idempotent-parent', 'aaaaaaaa', 'queued', NULL, 'human:migration', 'idempotent-parent-key',
          'idempotent-parent-hash', 3, '${createdAt}', '${createdAt}', NULL, NULL, NULL),
        ('idempotent-child', 'Migrate 東京.', 'Preserve existing decomposition identity.', 'normal', 'explicit',
          'idempotent-project', 'idempotent-project', 'idempotent-parent', 'migrate', 7,
          'task/idempotent-child', NULL, 'queued', NULL, 'human:migration', 'idempotent-child-key',
          'idempotent-child-hash', 4, '${createdAt}', '${createdAt}', NULL, NULL, NULL);
      PRAGMA user_version = 25;
    `);
    const projectSql = `
      SELECT project_id, name, description, repo_path, version, created_at, updated_at
      FROM projects ORDER BY rowid
    `;
    const workItemSql = `
      SELECT work_item_id, parent_work_item_id, phase, child_ordinal, pipeline_branch, base_sha, version
      FROM work_items ORDER BY rowid
    `;
    const before = JSON.stringify({
      projects: db
        .prepare(projectSql)
        .all()
        .map((row) => ({ ...row })),
      workItems: db
        .prepare(workItemSql)
        .all()
        .map((row) => ({ ...row })),
    });

    migrateVersion25To26(db);
    const afterFirst = JSON.stringify({
      projects: db
        .prepare(projectSql)
        .all()
        .map((row) => ({ ...row })),
      workItems: db
        .prepare(workItemSql)
        .all()
        .map((row) => ({ ...row })),
    });
    migrateVersion25To26(db);
    const afterSecond = JSON.stringify({
      projects: db
        .prepare(projectSql)
        .all()
        .map((row) => ({ ...row })),
      workItems: db
        .prepare(workItemSql)
        .all()
        .map((row) => ({ ...row })),
    });

    assert.equal(afterFirst, before);
    assert.equal(afterSecond, afterFirst);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 26);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  } finally {
    db.close();
  }
});

test("populated v25 data upgrades through the v26 rebuild without weakening new constraints", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  await installFrozenSchema(path, 25);
  const legacy = new DatabaseSync(path);
  const createdAt = "2026-08-28T12:00:00.000Z";
  try {
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      INSERT INTO projects(project_id, name, description, version, created_at, updated_at)
      VALUES
        ('v26-project', 'V26 migration', '/repos/provider', 3, '${createdAt}', '${createdAt}'),
        ('v26-catalog-project', 'Catalog migration',
          'Summary: Catalog-managed provider
Docs: https://docs.example.com/provider
Workspace: /repos/catalog-provider',
          2, '${createdAt}', '${createdAt}');
      INSERT INTO work_items(
        work_item_id, original_request, refined_objective, priority, project_target_mode,
        target_project_id, resolved_project_id, pipeline_branch, base_sha, state, current_stage,
        created_by, idempotency_key, request_hash, version, created_at, updated_at,
        ended_at, cancelled_reason, archived_at
      ) VALUES
        ('v26-parent', 'Coordinate the change.', NULL, 'high', 'explicit',
          'v26-project', 'v26-project', NULL, NULL, 'plan_approval', 'planning',
          'human:migration', 'v26-parent-key', 'v26-parent-hash', 4, '${createdAt}', '${createdAt}', NULL, NULL, NULL),
        ('v26-child', 'Implement one child.', NULL, 'normal', 'explicit',
          'v26-project', 'v26-project', NULL, NULL, 'queued', NULL,
          'human:migration', 'v26-child-key', 'v26-child-hash', 1, '${createdAt}', '${createdAt}', NULL, NULL, NULL);
      INSERT INTO plan_revisions(
        plan_revision_id, work_item_id, revision, objective, assumptions_json,
        acceptance_criteria_json, change_shape, tier, declared_scope_json, non_goals_json,
        mechanical_portions_json, blocking_questions_json, criterion_checks_json, rejected_note,
        project_id, skill_digests_json, state, created_by, confirmed_by, created_at, confirmed_at
      ) VALUES (
        'v25-parent-plan', 'v26-parent', 1, 'Preserve this parent plan.', '[]',
        '["The parent plan survives migration."]', 'feature', 'standard', '["src"]', '[]',
        '[]', '[]', '[]', NULL, 'v26-project', '{}', 'proposed', 'agent:planner', NULL,
        '${createdAt}', NULL
      );
      INSERT INTO work_nodes(
        node_id, plan_revision_id, project_id, title, objective,
        acceptance_criteria_json, stage_template_json, current_stage, state,
        version, created_at, updated_at
      ) VALUES (
        'v26-node', 'v25-parent-plan', 'v26-project', 'Preserve verifier state',
        'Keep the open attempt through both migrations.', '["The attempt survives."]',
        '["verification"]', NULL, 'pending', 1, '${createdAt}', '${createdAt}'
      );
      INSERT INTO verify_attempts(
        verify_attempt_id, node_id, stage, attempt, verify_run_id, workspace_path,
        state, check_results_json, detail, created_at, ended_at
      ) VALUES (
        'v26-verify-attempt', 'v26-node', 'verification', 1, 'run-v26', '/tmp/v26-verify',
        'running', NULL, NULL, '${createdAt}', NULL
      );
      INSERT INTO work_item_transitions(
        work_item_id, sequence, from_state, to_state, actor_type, actor_id, created_at
      ) VALUES
        ('v26-parent', 1, NULL, 'plan_approval', 'system', 'system:migration-test', '${createdAt}'),
        ('v26-child', 1, NULL, 'queued', 'system', 'system:migration-test', '${createdAt}');
      INSERT INTO notifications(
        notification_id, sequence, kind, dedupe_key, project_id, work_item_id,
        summary, created_at, read_at, version
      ) VALUES (
        'v25-notification', 7, 'final_approval_withdrawn', 'v25-notification-key',
        'v26-project', 'v26-parent', 'Preserve this notification.', '${createdAt}', NULL, 2
      );
      INSERT INTO gate_actions(
        gate_action_id, work_item_id, gate, actor_id, plan_revision_id,
        verified_sha, merge_sha, ref_id, note, created_at
      ) VALUES (
        'v25-gate', 'v26-parent', 'cancel', 'human:migration', NULL,
        NULL, NULL, 'v25-ref', 'Preserve this gate.', '${createdAt}'
      );
      INSERT INTO park_records(
        park_record_id, work_item_id, category, reason, parked_at, resolved_at, resolution
      ) VALUES (
        'v25-park', 'v26-parent', 'open_question', 'Preserve this park record.',
        '${createdAt}', NULL, NULL
      );
    `);
  } finally {
    legacy.close();
  }

  const upgraded = await TaskBoardStore.open(path);
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 27);
    assert.deepEqual(
      upgraded.db
        .prepare(
          `
      SELECT name, description, repo_path, version
      FROM projects
      WHERE project_id IN ('v26-catalog-project', 'v26-project')
      ORDER BY project_id
    `
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          name: "Catalog migration",
          description:
            "Summary: Catalog-managed provider\nDocs: https://docs.example.com/provider\nWorkspace: /repos/catalog-provider",
          repo_path: "/repos/catalog-provider",
          version: 2,
        },
        {
          name: "V26 migration",
          description: "/repos/provider",
          repo_path: "/repos/provider",
          version: 3,
        },
      ]
    );
    assert.deepEqual(
      upgraded.db
        .prepare(
          `
      SELECT work_item_id, parent_work_item_id, phase, child_ordinal, state, version
      FROM work_items ORDER BY work_item_id
    `
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          work_item_id: "v26-child",
          parent_work_item_id: null,
          phase: null,
          child_ordinal: null,
          state: "queued",
          version: 1,
        },
        {
          work_item_id: "v26-parent",
          parent_work_item_id: null,
          phase: null,
          child_ordinal: null,
          state: "plan_approval",
          version: 4,
        },
      ]
    );
    assert.equal(
      upgraded.db.prepare("SELECT kind FROM notifications WHERE notification_id='v25-notification'").get()?.kind,
      "final_approval_withdrawn"
    );
    assert.equal(
      upgraded.db.prepare("SELECT gate FROM gate_actions WHERE gate_action_id='v25-gate'").get()?.gate,
      "cancel"
    );
    assert.deepEqual(
      {
        ...upgraded.db
          .prepare(
            `
      SELECT verify_attempt_id, verify_run_id, workspace_path, state
      FROM verify_attempts WHERE verify_attempt_id='v26-verify-attempt'
    `
          )
          .get(),
      },
      {
        verify_attempt_id: "v26-verify-attempt",
        verify_run_id: "run-v26",
        workspace_path: "/tmp/v26-verify",
        state: "running",
      }
    );
    upgraded.db
      .prepare(
        `
      UPDATE verify_attempts SET state='retired',ended_at=? WHERE verify_attempt_id='v26-verify-attempt'
    `
      )
      .run(createdAt);
    assert.equal(
      upgraded.db
        .prepare(
          `
      SELECT state FROM verify_attempts WHERE verify_attempt_id='v26-verify-attempt'
    `
        )
        .get()?.state,
      "retired"
    );
    assert.deepEqual(
      {
        ...upgraded.db
          .prepare(
            `
      SELECT work_item_id, category, reason, parked_at, resolved_at, resolution
      FROM park_records WHERE park_record_id='v25-park'
    `
          )
          .get(),
      },
      {
        work_item_id: "v26-parent",
        category: "open_question",
        reason: "Preserve this park record.",
        parked_at: createdAt,
        resolved_at: null,
        resolution: null,
      }
    );
    assert.equal(
      upgraded.db.prepare("SELECT children FROM plan_revisions WHERE plan_revision_id='v25-parent-plan'").get()
        ?.children,
      null
    );

    upgraded.db
      .prepare(
        `
      UPDATE work_items
      SET parent_work_item_id='v26-parent', phase='migrate', child_ordinal=1
      WHERE work_item_id='v26-child'
    `
      )
      .run();
    upgraded.db
      .prepare(
        `
      INSERT INTO work_item_dependencies(work_item_id, depends_on_work_item_id)
      VALUES ('v26-child', 'v26-parent')
    `
      )
      .run();
    upgraded.db
      .prepare(
        `
      INSERT INTO notifications(
        notification_id, sequence, kind, dedupe_key, project_id, work_item_id,
        summary, created_at, read_at, version
      ) VALUES ('v26-notification', 8, 'phase_ready', 'v26-notification-key',
        'v26-project', 'v26-parent', 'The next phase is ready.', '${createdAt}', NULL, 1)
    `
      )
      .run();
    upgraded.db
      .prepare(
        `
      INSERT INTO gate_actions(
        gate_action_id, work_item_id, gate, actor_id, plan_revision_id,
        verified_sha, merge_sha, ref_id, note, created_at
      ) VALUES ('v26-gate', 'v26-child', 'deploy_attest', 'human:migration', NULL,
        NULL, NULL, 'deploy-one', NULL, '${createdAt}')
    `
      )
      .run();
    upgraded.db
      .prepare(
        `
      INSERT INTO park_records(
        park_record_id, work_item_id, category, reason, parked_at, resolved_at, resolution
      ) VALUES ('v26-child-failed-park', 'v26-parent', 'child_failed',
        'A child reached a terminal failure state.', '${createdAt}', NULL, NULL)
    `
      )
      .run();
    assert.equal(
      upgraded.db.prepare("SELECT category FROM park_records WHERE park_record_id='v26-child-failed-park'").get()
        ?.category,
      "child_failed"
    );
    assert.throws(
      () =>
        upgraded.db
          .prepare(
            `
      INSERT INTO work_item_dependencies(work_item_id, depends_on_work_item_id)
      VALUES ('v26-parent', 'v26-parent')
    `
          )
          .run(),
      /CHECK/u
    );
    assert.throws(
      () => upgraded.db.prepare("UPDATE work_items SET phase='future' WHERE work_item_id='v26-child'").run(),
      /CHECK/u
    );
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(upgraded.db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  } finally {
    upgraded.close();
  }
});

test("v27 schema contains the contract-derived checks and repository storage", async () => {
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
      ["work_items", `CHECK (phase IS NULL OR phase IN (${sqlList(WORK_ITEM_PHASES)}))`],
      ["work_items", `current_stage IN (${sqlList(WORK_ITEM_STAGES)})`],
      ["work_items", `state IN (${sqlList(WORK_ITEM_TERMINAL_STATES)}) AND ended_at IS NOT NULL`],
      ["work_items", `state NOT IN (${sqlList(WORK_ITEM_TERMINAL_STATES)}) AND ended_at IS NULL`],
      ["work_item_transitions", `from_state IN (${sqlList(WORK_ITEM_STATES)})`],
      ["work_item_transitions", `CHECK (to_state IN (${sqlList(WORK_ITEM_STATES)}))`],
      ["wakeups", `CHECK (reason IN (${sqlList(WAKEUP_REASONS)}))`],
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
      ["repositories", "CHECK (is_primary IN (0, 1))"],
      ["repositories", "CHECK (version >= 1)"],
    ];
    for (const [table, fragment] of expected) assert.ok(tableSql(table).includes(fragment), `${table}: ${fragment}`);
    assert.ok(tableSql("projects").includes("repo_path TEXT NOT NULL"));
    assert.equal(
      tableSql("repositories"),
      `CREATE TABLE repositories (
  repository_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT`
    );
    assert.equal(
      store.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='repositories_project'").get()?.sql,
      "CREATE INDEX repositories_project ON repositories(project_id, created_at, repository_id)"
    );
    assert.equal(
      store.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='repositories_one_primary'").get()
        ?.sql,
      "CREATE UNIQUE INDEX repositories_one_primary ON repositories(project_id) WHERE is_primary = 1"
    );
    assert.ok(
      tableSql("work_items").includes(
        "parent_work_item_id TEXT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT"
      )
    );
    assert.ok(
      tableSql("work_items").includes(
        "repository_id TEXT NULL REFERENCES repositories(repository_id) ON DELETE RESTRICT"
      )
    );
    assert.ok(tableSql("work_items").includes("child_ordinal INTEGER NULL"));
    assert.ok(tableSql("plan_revisions").includes("children TEXT NULL"));
    assert.equal(
      tableSql("work_item_dependencies"),
      `CREATE TABLE work_item_dependencies (
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  depends_on_work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  PRIMARY KEY(work_item_id, depends_on_work_item_id), CHECK(work_item_id <> depends_on_work_item_id)
) STRICT, WITHOUT ROWID`
    );
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
      .sort(
        (left, right) =>
          schemaKindOrder.findIndex((prefix) => left.startsWith(prefix)) -
          schemaKindOrder.findIndex((prefix) => right.startsWith(prefix))
      )
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
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 27);
    const columns = (table: string): string[] =>
      upgraded.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => String(row.name));
    for (const column of ["pipeline_branch", "base_sha"]) {
      assert.ok(columns("work_items").includes(column), `work_items.${column}`);
    }
    for (const column of [
      "change_shape",
      "tier",
      "declared_scope_json",
      "non_goals_json",
      "mechanical_portions_json",
      "blocking_questions_json",
      "criterion_checks_json",
      "rejected_note",
      "children",
    ]) {
      assert.ok(columns("plan_revisions").includes(column), `plan_revisions.${column}`);
    }
    assert.deepEqual(columns("verify_attempts"), [
      "verify_attempt_id",
      "node_id",
      "stage",
      "attempt",
      "verify_run_id",
      "workspace_path",
      "state",
      "check_results_json",
      "detail",
      "created_at",
      "ended_at",
    ]);
    assert.deepEqual(
      {
        ...upgraded.db
          .prepare(
            `
        SELECT original_request, pipeline_branch, base_sha
        FROM work_items WHERE work_item_id = 'pipeline-work-item'
      `
          )
          .get(),
      },
      { original_request: "Preserve this work item.", pipeline_branch: null, base_sha: null }
    );
    assert.deepEqual(
      {
        ...upgraded.db
          .prepare(
            `
        SELECT objective, change_shape, tier, declared_scope_json, non_goals_json,
          mechanical_portions_json, blocking_questions_json, criterion_checks_json, rejected_note, children
        FROM plan_revisions WHERE plan_revision_id = 'pipeline-plan'
      `
          )
          .get(),
      },
      {
        objective: "Preserve this plan.",
        change_shape: null,
        tier: null,
        declared_scope_json: null,
        non_goals_json: null,
        mechanical_portions_json: null,
        blocking_questions_json: null,
        criterion_checks_json: null,
        rejected_note: null,
        children: null,
      }
    );
    const verifySql = String(
      upgraded.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'verify_attempts'").get()?.sql
    );
    assert.equal(
      verifySql,
      `CREATE TABLE verify_attempts (
  verify_attempt_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES work_nodes(node_id),
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  verify_run_id TEXT NULL,
  workspace_path TEXT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting','running','green','failed','died','failed_to_start','retired')),
  check_results_json TEXT NULL,
  detail TEXT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT NULL,
  UNIQUE(node_id, stage, attempt)
)`
    );
    upgraded.db
      .prepare(
        `
      INSERT INTO verify_attempts(
        verify_attempt_id, node_id, stage, attempt, verify_run_id, workspace_path,
        state, check_results_json, detail, created_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        "verify-attempt-one",
        "pipeline-node",
        "testing",
        1,
        null,
        null,
        "starting",
        null,
        null,
        "2026-08-18T12:03:00.000Z",
        null
      );
    assert.throws(
      () =>
        upgraded.db
          .prepare(
            `
      INSERT INTO verify_attempts(verify_attempt_id, node_id, stage, attempt, state, created_at)
      VALUES ('verify-attempt-two', 'pipeline-node', 'testing', 1, 'running', '2026-08-18T12:04:00.000Z')
    `
          )
          .run(),
      /UNIQUE/u
    );
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
      .sort(
        (left, right) =>
          schemaKindOrder.findIndex((prefix) => left.startsWith(prefix)) -
          schemaKindOrder.findIndex((prefix) => right.startsWith(prefix))
      )
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
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 27);
    const columns = (table: string): string[] =>
      upgraded.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => String(row.name));
    assert.deepEqual(columns("review_findings"), [
      "finding_id",
      "node_id",
      "stage",
      "round",
      "file",
      "line",
      "category",
      "severity",
      "expected",
      "actual",
      "blocking",
      "created_at",
    ]);
    assert.deepEqual(columns("design_records"), [
      "design_record_id",
      "work_item_id",
      "plan_revision_id",
      "payload_json",
      "created_at",
    ]);
    assert.deepEqual(columns("work_item_design_tasks"), ["work_item_id", "task_id", "created_at"]);
    assert.deepEqual(
      {
        ...upgraded.db
          .prepare(
            `
        SELECT original_request, pipeline_branch, base_sha
        FROM work_items WHERE work_item_id = 'review-work-item'
      `
          )
          .get(),
      },
      {
        original_request: "Preserve this work item.",
        pipeline_branch: "pipeline/review-work-item",
        base_sha: "0123456789abcdef",
      }
    );

    upgraded.db
      .prepare(
        `
      INSERT INTO review_findings(
        finding_id, node_id, stage, round, file, line, category, severity,
        expected, actual, blocking, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        "finding-one",
        "review-node",
        "verification",
        1,
        "src/example.ts",
        42,
        "correctness",
        "major",
        "A retry is idempotent.",
        "A retry duplicates a write.",
        1,
        "2026-08-19T12:05:00.000Z"
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
    upgraded.db
      .prepare(
        `
      INSERT INTO design_records(design_record_id, work_item_id, plan_revision_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run("design-one", "review-work-item", "review-plan", payload, "2026-08-19T12:06:00.000Z");
    upgraded.db
      .prepare(
        `
      INSERT INTO work_item_design_tasks(work_item_id, task_id, created_at)
      VALUES (?, ?, ?)
    `
      )
      .run("review-work-item", "design-task", "2026-08-19T12:07:00.000Z");

    assert.throws(
      () =>
        upgraded.db
          .prepare(
            `
      INSERT INTO review_findings(
        finding_id, node_id, stage, round, category, severity, expected, actual, blocking, created_at
      ) VALUES ('finding-invalid', 'review-node', 'verification', 2, 'unknown', 'major', 'x', 'y', 0,
        '2026-08-19T12:08:00.000Z')
    `
          )
          .run(),
      /CHECK constraint failed/u
    );
    assert.throws(
      () =>
        upgraded.db
          .prepare(
            `
      INSERT INTO design_records(design_record_id, work_item_id, plan_revision_id, payload_json, created_at)
      VALUES ('design-invalid', 'review-work-item', 'review-plan', 'not-json', '2026-08-19T12:08:00.000Z')
    `
          )
          .run(),
      /CHECK constraint failed/u
    );
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
      .sort(
        (left, right) =>
          schemaKindOrder.findIndex((prefix) => left.startsWith(prefix)) -
          schemaKindOrder.findIndex((prefix) => right.startsWith(prefix))
      )
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
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 27);
    const columns = (table: string): string[] =>
      upgraded.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => String(row.name));
    assert.deepEqual(columns("park_records"), [
      "park_record_id",
      "work_item_id",
      "category",
      "reason",
      "parked_at",
      "resolved_at",
      "resolution",
    ]);
    assert.deepEqual(columns("notifications"), [
      "notification_id",
      "sequence",
      "kind",
      "dedupe_key",
      "project_id",
      "work_item_id",
      "summary",
      "created_at",
      "read_at",
      "version",
    ]);
    assert.deepEqual(columns("gate_actions"), [
      "gate_action_id",
      "work_item_id",
      "gate",
      "actor_id",
      "plan_revision_id",
      "verified_sha",
      "merge_sha",
      "ref_id",
      "note",
      "created_at",
    ]);
    assert.deepEqual(
      {
        ...upgraded.db
          .prepare(
            `
        SELECT original_request, refined_objective, pipeline_branch, base_sha, state
        FROM work_items WHERE work_item_id = 'ledger-work-item'
      `
          )
          .get(),
      },
      {
        original_request: "Preserve this work item.",
        refined_objective: "Add durable observability.",
        pipeline_branch: "pipeline/ledger-work-item",
        base_sha: "0123456789abcdef0123456789abcdef01234567",
        state: "parked",
      }
    );

    upgraded.db
      .prepare(
        `
      INSERT INTO park_records(
        park_record_id, work_item_id, category, reason, parked_at, resolved_at, resolution
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        "park-record-one",
        "ledger-work-item",
        "open_question",
        "Waiting for an answer.",
        "2026-08-20T12:03:00.000Z",
        null,
        null
      );
    upgraded.db
      .prepare(
        `
      INSERT INTO notifications(
        notification_id, sequence, kind, dedupe_key, project_id, work_item_id,
        summary, created_at, read_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        "notification-one",
        1,
        "park_aged",
        "park-aged:park-record-one",
        "ledger-project",
        "ledger-work-item",
        "The work item has remained parked.",
        "2026-08-20T12:04:00.000Z",
        null,
        1
      );
    upgraded.db
      .prepare(
        `
      INSERT INTO gate_actions(
        gate_action_id, work_item_id, gate, actor_id, plan_revision_id,
        verified_sha, merge_sha, ref_id, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        "gate-action-one",
        "ledger-work-item",
        "cancel",
        "human:operator",
        null,
        "0123456789abcdef0123456789abcdef01234567",
        null,
        "request-one",
        "Cancelled deliberately.",
        "2026-08-20T12:05:00.000Z"
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
      .sort(
        (left, right) =>
          schemaKindOrder.findIndex((prefix) => left.startsWith(prefix)) -
          schemaKindOrder.findIndex((prefix) => right.startsWith(prefix))
      )
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
        resolution
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
        index + 3
      );
    }
    parkRowsBefore = legacy
      .prepare("SELECT rowid, * FROM park_records ORDER BY rowid")
      .all()
      .map((row) => ({ ...row }));
    notificationRowsBefore = legacy
      .prepare("SELECT rowid, * FROM notifications ORDER BY rowid")
      .all()
      .map((row) => ({ ...row }));
    legacy.exec("PRAGMA user_version = 22;");
  } finally {
    legacy.close();
  }
  await chmod(path, 0o600);

  const upgraded = await TaskBoardStore.open(path);
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 27);
    assert.deepEqual(
      upgraded.db
        .prepare("SELECT rowid, * FROM park_records ORDER BY rowid")
        .all()
        .map((row) => ({ ...row })),
      parkRowsBefore
    );
    assert.deepEqual(
      upgraded.db
        .prepare("SELECT rowid, * FROM notifications ORDER BY rowid")
        .all()
        .map((row) => ({ ...row })),
      notificationRowsBefore
    );

    const tableSql = (name: string): string =>
      String(upgraded.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)?.sql);
    assert.ok(tableSql("park_records").includes(`CHECK (category IN (${sqlList(PARK_CATEGORIES)}))`));
    assert.ok(tableSql("notifications").includes(`CHECK (kind IN (${sqlList(NOTIFICATION_KINDS)}))`));

    const insertPark = upgraded.db.prepare(`
      INSERT INTO park_records(
        park_record_id, work_item_id, category, reason, parked_at, resolved_at, resolution
      ) VALUES (?, 'v23-work-item', ?, 'Migration insertability check.', '2026-08-21T16:00:00.000Z', NULL, NULL)
    `);
    for (const [index, category] of [
      ...V22_PARK_CATEGORIES,
      ...PARK_CATEGORIES.slice(V22_PARK_CATEGORIES.length),
    ].entries()) {
      insertPark.run(`post-v23-park-${index}`, category);
    }
    const insertNotification = upgraded.db.prepare(`
      INSERT INTO notifications(
        notification_id, sequence, kind, dedupe_key, project_id, work_item_id,
        summary, created_at, read_at, version
      ) VALUES (?, ?, ?, ?, NULL, NULL, 'Migration insertability check.', '2026-08-21T16:01:00.000Z', NULL, 1)
    `);
    for (const [index, kind] of [
      ...V22_NOTIFICATION_KINDS,
      ...NOTIFICATION_KINDS.slice(V22_NOTIFICATION_KINDS.length),
    ].entries()) {
      insertNotification.run(`post-v23-notification-${index}`, 100 + index, kind, `post-v23-dedupe-${index}`);
    }
    assert.throws(() => insertNotification.run("duplicate-sequence", 100, "cap_parked", "unique-dedupe"), /UNIQUE/u);
    assert.throws(() => insertNotification.run("duplicate-dedupe", 999, "cap_parked", "post-v23-dedupe-0"), /UNIQUE/u);

    assert.deepEqual(
      {
        ...upgraded.db
          .prepare(
            `
      SELECT paused, reason, version, updated_at, updated_by
      FROM board_pause WHERE pause_id = 'board'
    `
          )
          .get(),
      },
      {
        paused: 0,
        reason: null,
        version: 1,
        updated_at: "1970-01-01T00:00:00.000Z",
        updated_by: "system:steward-default",
      }
    );
    assert.ok(tableSql("board_pause").includes("pause_id TEXT PRIMARY KEY CHECK (pause_id = 'board')"));
    assert.throws(
      () => upgraded.db.prepare("UPDATE board_pause SET pause_id = 'other' WHERE pause_id = 'board'").run(),
      /CHECK/u
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
  const mappingCells: ReadonlyArray<
    Readonly<{
      id: string;
      state: string;
      currentStage: string | null;
      migratedState: string;
      targetProjectId?: string;
      archivedAt?: string;
    }>
  > = [
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
    {
      id: "migration-06-human-review",
      state: "waiting_for_human_review",
      currentStage: "human_review",
      migratedState: "plan_approval",
    },
    {
      id: "migration-07-plan-approval",
      state: "waiting_for_human_review",
      currentStage: "planning",
      migratedState: "plan_approval",
    },
    {
      id: "migration-08-implementation",
      state: "processing",
      currentStage: "implementation",
      migratedState: "implementing",
    },
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
      .sort(
        (left, right) =>
          schemaKindOrder.findIndex((prefix) => left.startsWith(prefix)) -
          schemaKindOrder.findIndex((prefix) => right.startsWith(prefix))
      )
      .join("");
    legacy.exec(executableV18);
    legacy
      .prepare(
        `
      INSERT INTO projects(project_id, name, description, version, created_at, updated_at)
      VALUES (?, 'Migration target', 'Exercises explicit project references.', 1, ?, ?)
    `
      )
      .run(explicitProjectId, "2026-08-15T11:00:00.000Z", "2026-08-15T11:00:00.000Z");
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
        cell.archivedAt ?? null
      );
    }
    legacy.exec("PRAGMA user_version = 18;");
  } finally {
    legacy.close();
  }
  await chmod(path, 0o600);

  const upgraded = await TaskBoardStore.open(path);
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 27);
    assert.deepEqual(
      upgraded.db
        .prepare(
          `
        SELECT work_item_id, state, project_target_mode, target_project_id, resolved_project_id, archived_at
        FROM work_items
        ORDER BY work_item_id
      `
        )
        .all()
        .map((row) => ({
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
      }))
    );
    assert.deepEqual(
      upgraded.db
        .prepare(
          `
        SELECT work_item_id, sequence, from_state, to_state, actor_type, actor_id, created_at
        FROM work_item_transitions
        ORDER BY work_item_id, sequence
      `
        )
        .all()
        .map((row) => ({
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
      }))
    );
    const runColumns = new Set(
      upgraded.db
        .prepare("PRAGMA table_info(runs)")
        .all()
        .map((row) => String(row.name))
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
      null
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
      "2026-08-15T15:02:00.000Z"
    );
    const insertTransition = original.db.prepare(`
      INSERT INTO work_item_transitions(
        work_item_id, sequence, from_state, to_state, actor_type, actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertTransition.run("guard-reviewing", 1, null, "queued", "system", "system:intake", "2026-08-15T14:00:00.000Z");
    insertTransition.run(
      "guard-reviewing",
      2,
      "queued",
      "reviewing",
      "agent",
      "agent:reviewer",
      "2026-08-15T14:02:00.000Z"
    );
    insertTransition.run("guard-merged", 1, null, "merged", "human", "human:approver", "2026-08-15T15:02:00.000Z");
    original.db.exec("PRAGMA user_version = 18;");
  } finally {
    original.close();
  }

  const reopened = await TaskBoardStore.open(path);
  try {
    assert.equal(reopened.db.prepare("PRAGMA user_version").get()?.user_version, 27);
    assert.deepEqual(
      reopened.db
        .prepare("SELECT work_item_id, state FROM work_items ORDER BY work_item_id")
        .all()
        .map((row) => ({ work_item_id: row.work_item_id, state: row.state })),
      [
        { work_item_id: "guard-merged", state: "merged" },
        { work_item_id: "guard-reviewing", state: "reviewing" },
      ]
    );
    assert.deepEqual(
      reopened.db
        .prepare(
          `
        SELECT work_item_id, sequence, from_state, to_state, actor_type, actor_id, created_at
        FROM work_item_transitions
        ORDER BY work_item_id, sequence
      `
        )
        .all()
        .map((row) => ({
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
      ]
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
      .sort(
        (left, right) =>
          schemaKindOrder.findIndex((prefix) => left.startsWith(prefix)) -
          schemaKindOrder.findIndex((prefix) => right.startsWith(prefix))
      )
      .join("");
    legacy.exec(executableV17);
    legacy.exec("PRAGMA user_version = 17;");
  } finally {
    legacy.close();
  }
  await chmod(path, 0o600);

  const upgraded = await TaskBoardStore.open(path);
  try {
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()?.user_version, 27);
    assert.equal(
      upgraded.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='project_events_node'").get()?.sql,
      "CREATE INDEX project_events_node ON project_events(node_id, sequence)"
    );
    assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    upgraded.close();
  }
});
