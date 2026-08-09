import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { TaskBoardError } from "../errors.js";

const SCHEMA_VERSION = 13;

const WORKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS plan_revisions (
  plan_revision_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  objective TEXT NOT NULL,
  assumptions_json TEXT NOT NULL CHECK (json_valid(assumptions_json)),
  acceptance_criteria_json TEXT NOT NULL CHECK (json_valid(acceptance_criteria_json)),
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  skill_digests_json TEXT NOT NULL CHECK (json_valid(skill_digests_json)),
  state TEXT NOT NULL CHECK (state IN ('proposed','confirmed','superseded','rejected')),
  created_by TEXT NOT NULL,
  confirmed_by TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  UNIQUE(work_item_id, revision)
) STRICT;
CREATE TABLE IF NOT EXISTS work_nodes (
  node_id TEXT PRIMARY KEY,
  plan_revision_id TEXT NOT NULL REFERENCES plan_revisions(plan_revision_id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  title TEXT NOT NULL, objective TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL CHECK (json_valid(acceptance_criteria_json)),
  stage_template_json TEXT NOT NULL CHECK (json_valid(stage_template_json)),
  current_stage TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','ready','active','blocked','stale','completed','cancelled')),
  version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS work_node_dependencies (
  node_id TEXT NOT NULL REFERENCES work_nodes(node_id) ON DELETE RESTRICT,
  dependency_node_id TEXT NOT NULL REFERENCES work_nodes(node_id) ON DELETE RESTRICT,
  PRIMARY KEY(node_id, dependency_node_id), CHECK(node_id <> dependency_node_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS stage_attempts (
  attempt_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES work_nodes(node_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK(stage IN ('research','planning','implementation','testing','verification')),
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  skill_digests_json TEXT NOT NULL CHECK(json_valid(skill_digests_json)),
  UNIQUE(node_id, stage, attempt)
) STRICT;
CREATE TABLE IF NOT EXISTS stage_handoffs (
  handoff_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES work_nodes(node_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE RESTRICT,
  stage TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('passed','failed','needs_input')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  node_id TEXT REFERENCES work_nodes(node_id) ON DELETE RESTRICT, task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT,
  media_type TEXT NOT NULL, byte_size INTEGER NOT NULL, digest TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE, caption TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS project_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  node_id TEXT REFERENCES work_nodes(node_id) ON DELETE RESTRICT, task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS project_events_project ON project_events(project_id, sequence);
`;

const WORK_ITEM_PLANNING_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_item_planning_tasks (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;
`;

const MIGRATE_VERSION_1_TO_2 = `
ALTER TABLE runs ADD COLUMN task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT;
UPDATE runs
SET task_id = (SELECT wakeups.task_id FROM wakeups WHERE wakeups.wakeup_id = runs.wakeup_id);
PRAGMA user_version = 2;
`;

const MIGRATE_VERSION_2_TO_3 = `
ALTER TABLE tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'work'
  CHECK (task_kind IN ('work', 'manager_review', 'human_check'));
ALTER TABLE tasks ADD COLUMN required_role TEXT
  CHECK (required_role IS NULL OR required_role IN ('engineer', 'manager', 'verifier'));
CREATE UNIQUE INDEX tasks_one_review_stage
  ON tasks(parent_task_id, task_kind)
  WHERE parent_task_id IS NOT NULL AND task_kind IN ('manager_review', 'human_check');
PRAGMA user_version = 3;
`;

const DOCUMENT_SCHEMA = `
CREATE TABLE documents (
  document_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type = 'text/markdown'),
  content TEXT NOT NULL,
  content_version INTEGER NOT NULL CHECK (content_version >= 1),
  pen_epoch INTEGER NOT NULL CHECK (pen_epoch >= 1),
  pen_holder_actor_type TEXT CHECK (pen_holder_actor_type IS NULL OR pen_holder_actor_type IN ('human', 'agent')),
  pen_holder_actor_id TEXT,
  pen_holder_client_id TEXT,
  pen_acquired_at TEXT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (pen_holder_actor_type IS NULL AND pen_holder_actor_id IS NULL AND pen_holder_client_id IS NULL AND pen_acquired_at IS NULL) OR
    (pen_holder_actor_type IS NOT NULL AND pen_holder_actor_id IS NOT NULL AND pen_holder_client_id IS NOT NULL AND pen_acquired_at IS NOT NULL)
  )
) STRICT;
CREATE INDEX documents_project ON documents(project_id, updated_at DESC, document_id);

CREATE TABLE document_events (
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('document_created', 'document_pen_acquired', 'document_pen_released', 'document_updated')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent')),
  actor_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  document_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(document_id, sequence)
) STRICT, WITHOUT ROWID;
CREATE INDEX document_events_project ON document_events(project_id, created_at DESC, document_id, sequence);
`;

const MIGRATE_VERSION_3_TO_4 = `
${DOCUMENT_SCHEMA}
PRAGMA user_version = 4;
`;

const TASK_PHASE_SCHEMA = `
CREATE TABLE task_phases (
  phase_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('research', 'planning', 'execution', 'testing', 'review', 'done')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'blocked', 'completed', 'failed')),
  parallel_group TEXT,
  order_key INTEGER NOT NULL CHECK (order_key >= 0),
  started_at TEXT,
  ended_at TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'pending' AND started_at IS NULL AND ended_at IS NULL) OR
         (status IN ('in_progress', 'blocked') AND started_at IS NOT NULL AND ended_at IS NULL) OR
         (status IN ('completed', 'failed') AND started_at IS NOT NULL AND ended_at IS NOT NULL)),
  CHECK (stage <> 'done' OR status = 'completed')
) STRICT;
CREATE INDEX task_phases_task ON task_phases(task_id, order_key, phase_id);
CREATE INDEX task_phases_parallel ON task_phases(task_id, parallel_group, order_key)
  WHERE parallel_group IS NOT NULL;
`;

function migrationVersion4To5(db: DatabaseSync): string {
  const taskColumns = new Set(db.prepare("PRAGMA table_info(tasks)").all().map((row) => String(row.name)));
  const hasTaskPhases = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_phases'").get() !== undefined;
  return `
    ${taskColumns.has("agent_estimate_minutes") ? "" : `
      ALTER TABLE tasks ADD COLUMN agent_estimate_minutes INTEGER
        CHECK (agent_estimate_minutes IS NULL OR
               (agent_estimate_minutes >= 15 AND agent_estimate_minutes <= 10080 AND agent_estimate_minutes % 15 = 0));
    `}
    ${taskColumns.has("estimate_recorded_at") ? "" : "ALTER TABLE tasks ADD COLUMN estimate_recorded_at TEXT;"}
    ${taskColumns.has("order_key") ? "" : `
      ALTER TABLE tasks ADD COLUMN order_key INTEGER NOT NULL DEFAULT 0 CHECK (order_key >= 0);
      UPDATE tasks SET order_key = 1024 * (rowid - 1);
    `}
    CREATE INDEX IF NOT EXISTS tasks_global_order ON tasks(order_key, task_id);
    ${hasTaskPhases ? "" : TASK_PHASE_SCHEMA}
    PRAGMA user_version = 5;
  `;
}

const MIGRATE_VERSION_5_TO_6 = `
DROP INDEX IF EXISTS tasks_project_order;
-- Version 5 displayed merged projects by this tuple even though allocation was project-local.
CREATE TEMP TABLE steward_task_order_v6 AS
  SELECT
    task_id,
    (ROW_NUMBER() OVER (ORDER BY order_key, task_id) - 1) * 1024 AS global_order_key
  FROM tasks;
UPDATE tasks
SET order_key = (
  SELECT global_order_key
  FROM steward_task_order_v6
  WHERE steward_task_order_v6.task_id = tasks.task_id
);
DROP TABLE steward_task_order_v6;
CREATE INDEX IF NOT EXISTS tasks_global_order ON tasks(order_key, task_id);
PRAGMA user_version = 6;
`;

const WAKEUP_SCHEMA = `
CREATE TABLE wakeups (
  wakeup_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('human_assignment', 'human_answer', 'human_resume', 'workflow_handoff')),
  source_key TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT,
  question_id TEXT REFERENCES questions(question_id) ON DELETE RESTRICT,
  detail TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  run_id TEXT,
  UNIQUE(reason, source_key),
  CHECK ((claimed_at IS NULL) = (run_id IS NULL))
) STRICT;
CREATE INDEX wakeups_pending ON wakeups(agent_id, created_at, wakeup_id) WHERE claimed_at IS NULL;
`;

const WORK_ITEM_SCHEMA = `
CREATE TABLE work_items (
  work_item_id TEXT PRIMARY KEY,
  original_request TEXT NOT NULL,
  refined_objective TEXT,
  priority TEXT NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low', 'opportunistic')),
  project_target_mode TEXT NOT NULL CHECK (project_target_mode IN ('auto', 'explicit')),
  target_project_id TEXT REFERENCES projects(project_id) ON DELETE RESTRICT,
  resolved_project_id TEXT REFERENCES projects(project_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('submitted', 'processing', 'needs_input', 'waiting_for_human_review', 'completed', 'failed', 'cancelled')),
  current_stage TEXT CHECK (current_stage IS NULL OR current_stage IN ('refinement', 'project_resolution', 'research', 'planning', 'implementation', 'testing', 'verification', 'human_review', 'deployment')),
  created_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(created_by, idempotency_key),
  CHECK (
    (project_target_mode = 'auto' AND target_project_id IS NULL) OR
    (project_target_mode = 'explicit' AND target_project_id IS NOT NULL)
  ),
  CHECK (project_target_mode = 'auto' OR resolved_project_id IS target_project_id),
  CHECK (
    (state IN ('completed', 'failed', 'cancelled') AND ended_at IS NOT NULL) OR
    (state NOT IN ('completed', 'failed', 'cancelled') AND ended_at IS NULL)
  )
) STRICT;
CREATE INDEX work_items_updated ON work_items(updated_at DESC, work_item_id);
CREATE INDEX work_items_display_order ON work_items(
  (ended_at IS NOT NULL),
  CASE priority
    WHEN 'urgent' THEN 0
    WHEN 'high' THEN 1
    WHEN 'normal' THEN 2
    WHEN 'low' THEN 3
    WHEN 'opportunistic' THEN 4
  END,
  created_at,
  work_item_id
);
CREATE TRIGGER work_items_original_request_immutable
BEFORE UPDATE OF original_request ON work_items
WHEN NEW.original_request IS NOT OLD.original_request
BEGIN
  SELECT RAISE(ABORT, 'WORK_ITEM_ORIGINAL_REQUEST_IMMUTABLE');
END;
`;

const AUTOMATION_CONFIGURATION_SCHEMA = `
CREATE TABLE automation_configuration (
  configuration_id TEXT PRIMARY KEY CHECK (configuration_id = 'company-default'),
  agent_types_json TEXT NOT NULL
    CHECK (json_valid(agent_types_json) AND json_type(agent_types_json) = 'array'),
  stages_json TEXT NOT NULL
    CHECK (json_valid(stages_json) AND json_type(stages_json) = 'array'),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
) STRICT;
INSERT INTO automation_configuration(
  configuration_id, agent_types_json, stages_json, version, created_at, updated_at, updated_by
) VALUES (
  'company-default',
  '[]',
  '[{"executor":{"kind":"disabled"},"stage":"refinement"},{"executor":{"kind":"disabled"},"stage":"project_resolution"},{"executor":{"kind":"disabled"},"stage":"research"},{"executor":{"kind":"disabled"},"stage":"planning"},{"executor":{"kind":"disabled"},"stage":"implementation"},{"executor":{"kind":"disabled"},"stage":"testing"},{"executor":{"kind":"disabled"},"stage":"verification"},{"executor":{"kind":"human"},"stage":"human_review"},{"executor":{"kind":"disabled"},"stage":"deployment"}]',
  1,
  '1970-01-01T00:00:00.000Z',
  '1970-01-01T00:00:00.000Z',
  'system:steward-default'
);
`;

const SCHEMA = `
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

${WORK_ITEM_SCHEMA}

${AUTOMATION_CONFIGURATION_SCHEMA}
${WORKFLOW_SCHEMA}
${WORK_ITEM_PLANNING_SCHEMA}

CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('engineer', 'manager', 'verifier')),
  area TEXT NOT NULL,
  mission TEXT NOT NULL,
  model TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX agents_project ON agents(project_id, created_at, agent_id);

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  parent_task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT,
  task_kind TEXT NOT NULL CHECK (task_kind IN ('work', 'manager_review', 'human_check')),
  required_role TEXT CHECK (required_role IS NULL OR required_role IN ('engineer', 'manager', 'verifier')),
  requires_review INTEGER NOT NULL CHECK (requires_review IN (0, 1)),
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  workspace_refs_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('backlog', 'queued', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled')),
  assigned_agent_id TEXT REFERENCES agents(agent_id) ON DELETE RESTRICT,
  assigned_role TEXT CHECK (assigned_role IS NULL OR assigned_role IN ('engineer', 'manager', 'verifier')),
  -- Kept for file compatibility with schema versions 1-4. New code reads agent_estimate_minutes.
  expected_agent_minutes INTEGER NOT NULL CHECK (expected_agent_minutes >= 15 AND expected_agent_minutes <= 10080 AND expected_agent_minutes % 15 = 0),
  agent_estimate_minutes INTEGER CHECK (agent_estimate_minutes IS NULL OR
    (agent_estimate_minutes >= 15 AND agent_estimate_minutes <= 10080 AND agent_estimate_minutes % 15 = 0)),
  estimate_recorded_at TEXT,
  order_key INTEGER NOT NULL CHECK (order_key >= 0),
  started_at TEXT,
  ended_at TEXT,
  result TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((assigned_agent_id IS NULL) = (assigned_role IS NULL)),
  CHECK ((task_kind = 'manager_review' AND required_role = 'manager') OR
         (task_kind IN ('work', 'human_check') AND required_role IS NULL)),
  CHECK (required_role IS NULL OR assigned_role IS NULL OR required_role = assigned_role),
  CHECK (task_kind <> 'human_check' OR assigned_agent_id IS NULL),
  CHECK ((agent_estimate_minutes IS NULL) = (estimate_recorded_at IS NULL)),
  CHECK (ended_at IS NULL OR started_at IS NOT NULL)
) STRICT;
CREATE INDEX tasks_project ON tasks(project_id, created_at, task_id);
CREATE INDEX tasks_global_order ON tasks(order_key, task_id);
CREATE INDEX tasks_agent ON tasks(assigned_agent_id, status, updated_at);
CREATE UNIQUE INDEX tasks_one_review_stage
  ON tasks(parent_task_id, task_kind)
  WHERE parent_task_id IS NOT NULL AND task_kind IN ('manager_review', 'human_check');

${TASK_PHASE_SCHEMA}

${DOCUMENT_SCHEMA}

CREATE TABLE task_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  run_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent')),
  actor_id TEXT NOT NULL,
  client_event_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'progress', 'proposal', 'result')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(actor_type, actor_id, client_event_id)
) STRICT;
CREATE INDEX task_messages_task ON task_messages(task_id, sequence);

CREATE TABLE task_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX task_events_project ON task_events(project_id, sequence DESC);

CREATE TABLE questions (
  question_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL,
  client_event_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'answered')),
  answer TEXT,
  asked_at TEXT NOT NULL,
  answered_at TEXT,
  answered_by TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  UNIQUE(agent_id, client_event_id),
  CHECK ((status = 'open' AND answer IS NULL AND answered_at IS NULL AND answered_by IS NULL) OR
         (status = 'answered' AND answer IS NOT NULL AND answered_at IS NOT NULL AND answered_by IS NOT NULL))
) STRICT;
CREATE INDEX questions_agent_status ON questions(agent_id, status, asked_at);

${WAKEUP_SCHEMA}

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  claim_request_hash TEXT NOT NULL,
  claim_result_json TEXT
    CHECK (claim_result_json IS NULL OR
           (json_valid(claim_result_json) AND json_type(claim_result_json) = 'object')),
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  wakeup_id TEXT NOT NULL UNIQUE REFERENCES wakeups(wakeup_id) ON DELETE RESTRICT,
  task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'waiting_for_human', 'completed', 'failed', 'interrupted')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  result TEXT,
  UNIQUE(agent_id, claim_id),
  CHECK ((status = 'active' AND ended_at IS NULL AND result IS NULL) OR
         (status <> 'active' AND ended_at IS NOT NULL AND result IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX runs_one_active_agent ON runs(agent_id) WHERE status = 'active';

CREATE TABLE interrupts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  interrupt_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  run_id TEXT REFERENCES runs(run_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  UNIQUE(agent_id, idempotency_key)
) STRICT;
CREATE INDEX interrupts_project ON interrupts(project_id, requested_at DESC);
`;

function hasColumns(db: DatabaseSync, table: string, expected: readonly string[]): boolean {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
  return expected.every((column) => columns.has(column));
}

function migrateVersion12To13(db: DatabaseSync): void {
  const hasRuns = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get() !== undefined;
  const addClaimResult = !hasRuns || hasColumns(db, "runs", ["claim_result_json"])
    ? ""
    : `ALTER TABLE runs ADD COLUMN claim_result_json TEXT
         CHECK (claim_result_json IS NULL OR
                (json_valid(claim_result_json) AND json_type(claim_result_json) = 'object'));`;
  db.exec(`BEGIN IMMEDIATE; ${addClaimResult} PRAGMA user_version = 13; COMMIT;`);
}

function migrateVersion9To10(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(`${AUTOMATION_CONFIGURATION_SCHEMA} PRAGMA user_version = 10;`);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length !== 0) {
      throw new TaskBoardError(500, "DATABASE_MIGRATION_FOREIGN_KEY_FAILED", "Task board migration failed its foreign-key check");
    }
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  }
}

function migrateVersion10To11(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE; ${WORKFLOW_SCHEMA} PRAGMA user_version = 11; COMMIT;`);
}

function migrateVersion11To12(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE; ${WORK_ITEM_PLANNING_SCHEMA} PRAGMA user_version = 12; COMMIT;`);
}

function migrateVersion8To9(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(`${WORK_ITEM_SCHEMA} PRAGMA user_version = 9;`);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length !== 0) {
      throw new TaskBoardError(500, "DATABASE_MIGRATION_FOREIGN_KEY_FAILED", "Task board migration failed its foreign-key check");
    }
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  }
}

function migrateVersion7To8(db: DatabaseSync): void {
  const addReviewScope = hasColumns(db, "tasks", ["requires_review"])
    ? ""
    : `ALTER TABLE tasks ADD COLUMN requires_review INTEGER NOT NULL DEFAULT 1
         CHECK (requires_review IN (0, 1));`;
  const chatRequestPredicate = hasColumns(db, "tasks", ["acceptance_criteria"])
    ? "OR acceptance_criteria = 'Return a concise answer or result. If more work is needed, propose child tasks for human approval; do not assign agents or deploy.'"
    : "";
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(`
      ${addReviewScope}
      UPDATE tasks
      SET requires_review = 0
      WHERE task_kind <> 'work'
         ${chatRequestPredicate};
      PRAGMA user_version = 8;
    `);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length !== 0) {
      throw new TaskBoardError(500, "DATABASE_MIGRATION_FOREIGN_KEY_FAILED", "Task board migration failed its foreign-key check");
    }
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  }
}

function migrateVersion6To7(db: DatabaseSync): void {
  const rebuildWakeups = hasColumns(db, "wakeups", [
    "wakeup_id", "project_id", "agent_id", "reason", "source_key", "task_id", "question_id",
    "detail", "created_by", "created_at", "claimed_at", "run_id",
  ]);
  const rebuildPhases = hasColumns(db, "task_phases", [
    "phase_id", "project_id", "task_id", "title", "stage", "status", "parallel_group",
    "order_key", "started_at", "ended_at", "version", "created_at", "updated_at",
  ]);
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
    if (rebuildWakeups) {
      db.exec(`
        CREATE TABLE wakeups_v7 (
          wakeup_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
          agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
          reason TEXT NOT NULL CHECK (reason IN ('human_assignment', 'human_answer', 'human_resume', 'workflow_handoff')),
          source_key TEXT NOT NULL,
          task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT,
          question_id TEXT REFERENCES questions(question_id) ON DELETE RESTRICT,
          detail TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          claimed_at TEXT,
          run_id TEXT,
          UNIQUE(reason, source_key),
          CHECK ((claimed_at IS NULL) = (run_id IS NULL))
        ) STRICT;
        INSERT INTO wakeups_v7(
          wakeup_id, project_id, agent_id, reason, source_key, task_id, question_id,
          detail, created_by, created_at, claimed_at, run_id
        )
        SELECT
          wakeup_id, project_id, agent_id, reason, source_key, task_id, question_id,
          detail, created_by, created_at, claimed_at, run_id
        FROM wakeups
        ORDER BY rowid;
        DROP TABLE wakeups;
        ALTER TABLE wakeups_v7 RENAME TO wakeups;
        CREATE INDEX wakeups_pending ON wakeups(agent_id, created_at, wakeup_id) WHERE claimed_at IS NULL;
      `);
    }
    if (rebuildPhases) {
      db.exec(`
        CREATE TABLE task_phases_v7 (
          phase_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
          title TEXT NOT NULL,
          stage TEXT NOT NULL CHECK (stage IN ('research', 'planning', 'execution', 'testing', 'review', 'done')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'blocked', 'completed', 'failed')),
          parallel_group TEXT,
          order_key INTEGER NOT NULL CHECK (order_key >= 0),
          started_at TEXT,
          ended_at TEXT,
          version INTEGER NOT NULL CHECK (version >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK ((status = 'pending' AND started_at IS NULL AND ended_at IS NULL) OR
                 (status IN ('in_progress', 'blocked') AND started_at IS NOT NULL AND ended_at IS NULL) OR
                 (status IN ('completed', 'failed') AND started_at IS NOT NULL AND ended_at IS NOT NULL)),
          CHECK (stage <> 'done' OR status = 'completed')
        ) STRICT;
        INSERT INTO task_phases_v7(
          phase_id, project_id, task_id, title, stage, status, parallel_group,
          order_key, started_at, ended_at, version, created_at, updated_at
        )
        SELECT
          phase_id, project_id, task_id, title, stage, status, parallel_group,
          order_key, started_at, ended_at, version, created_at, updated_at
        FROM task_phases
        ORDER BY rowid;
        DROP TABLE task_phases;
        ALTER TABLE task_phases_v7 RENAME TO task_phases;
        CREATE INDEX task_phases_task ON task_phases(task_id, order_key, phase_id);
        CREATE INDEX task_phases_parallel ON task_phases(task_id, parallel_group, order_key)
          WHERE parallel_group IS NOT NULL;
      `);
    }
    db.exec("PRAGMA user_version = 7;");
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length !== 0) {
      throw new TaskBoardError(500, "DATABASE_MIGRATION_FOREIGN_KEY_FAILED", "Task board migration failed its foreign-key check");
    }
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

async function assertOwnerOnlyDirectory(path: string): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  if (created !== undefined) await chmod(path, 0o700);
  const entry = await lstat(path);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    (typeof process.getuid === "function" && entry.uid !== process.getuid()) ||
    (entry.mode & 0o077) !== 0
  ) {
    throw new TaskBoardError(500, "UNSAFE_DATABASE_PATH", "Task board database directory must be owner-only");
  }
}

async function assertOwnerOnlyFile(path: string): Promise<void> {
  const entry = await lstat(path);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    (typeof process.getuid === "function" && entry.uid !== process.getuid()) ||
    (entry.mode & 0o077) !== 0
  ) {
    throw new TaskBoardError(500, "UNSAFE_DATABASE_PATH", "Task board database must be a private regular file");
  }
}

export class TaskBoardStore {
  readonly db: DatabaseSync;
  #closed = false;
  #transactionAfterCommitOperations: Array<() => void> | null = null;
  readonly #pendingAfterCommitOperations: Array<() => void> = [];
  #drainingAfterCommitOperations = false;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static async open(path: string): Promise<TaskBoardStore> {
    if (!isAbsolute(path) || path === "/" || path === ":memory:") {
      throw new TaskBoardError(500, "INVALID_CONFIGURATION", "Task board requires an absolute file-backed database path");
    }
    const directory = dirname(path);
    await assertOwnerOnlyDirectory(directory);
    let existed = true;
    try {
      await assertOwnerOnlyFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existed = false;
    }
    let sqlite: typeof import("node:sqlite");
    try {
      sqlite = await import("node:sqlite");
    } catch (error) {
      throw new TaskBoardError(
        500,
        "SQLITE_UNAVAILABLE",
        "This Node runtime does not provide the required built-in node:sqlite module (Node 22.5 or newer is required)",
        { cause: error },
      );
    }
    let db: DatabaseSync;
    try {
      db = new sqlite.DatabaseSync(path);
    } catch (error) {
      throw new TaskBoardError(500, "DATABASE_OPEN_FAILED", "Task board database could not be opened", { cause: error });
    }
    try {
      if (!existed) await chmod(path, 0o600);
      await assertOwnerOnlyFile(path);
      db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
      const row = db.prepare("PRAGMA user_version").get();
      const version = Number(row?.user_version ?? -1);
      const migration4to5 = version > 0 && version < 5 ? migrationVersion4To5(db) : "";
      if (version === 0) {
        db.exec(`BEGIN IMMEDIATE; ${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
      } else if (version === 1) {
        db.exec(`BEGIN IMMEDIATE; ${MIGRATE_VERSION_1_TO_2} ${MIGRATE_VERSION_2_TO_3} ${MIGRATE_VERSION_3_TO_4} ${migration4to5} ${MIGRATE_VERSION_5_TO_6} COMMIT;`);
      } else if (version === 2) {
        db.exec(`BEGIN IMMEDIATE; ${MIGRATE_VERSION_2_TO_3} ${MIGRATE_VERSION_3_TO_4} ${migration4to5} ${MIGRATE_VERSION_5_TO_6} COMMIT;`);
      } else if (version === 3) {
        db.exec(`BEGIN IMMEDIATE; ${MIGRATE_VERSION_3_TO_4} ${migration4to5} ${MIGRATE_VERSION_5_TO_6} COMMIT;`);
      } else if (version === 4) {
        db.exec(`BEGIN IMMEDIATE; ${migration4to5} ${MIGRATE_VERSION_5_TO_6} COMMIT;`);
      } else if (version === 5) {
        db.exec(`BEGIN IMMEDIATE; ${MIGRATE_VERSION_5_TO_6} COMMIT;`);
      } else if (version === 6) {
        // Rebuilt below because both changed constraints are table-level.
      } else if (version === 7) {
        // The review-workflow scope column is added below.
      } else if (version === 8) {
        // The global work-item intake table is added below.
      } else if (version === 9) {
        // The dormant automation configuration is added below.
      } else if (version === 10) {
        // Transparent workflow storage is added below.
      } else if (version === 11) {
        // Work-item planning-task links are added below.
      } else if (version === 12) {
        // Durable claim results are added below.
      } else if (version !== SCHEMA_VERSION) {
        throw new TaskBoardError(
          500,
          "UNSUPPORTED_DATABASE_VERSION",
          `Task board database version ${version} requires an explicit migration`,
        );
      }
      if (version >= 1 && version <= 6) migrateVersion6To7(db);
      if (version >= 1 && version <= 7) migrateVersion7To8(db);
      if (version >= 1 && version <= 8) migrateVersion8To9(db);
      if (version >= 1 && version <= 9) migrateVersion9To10(db);
      if (version >= 1 && version <= 10) migrateVersion10To11(db);
      if (version >= 1 && version <= 11) migrateVersion11To12(db);
      if (version >= 1 && version <= 12) migrateVersion12To13(db);
      const integrity = db.prepare("PRAGMA quick_check").get();
      if (integrity?.quick_check !== "ok") {
        throw new TaskBoardError(500, "DATABASE_CORRUPT", "Task board database integrity check failed");
      }
      return new TaskBoardStore(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  transaction<T>(operation: () => T): T {
    if (this.#closed) throw new Error("TASK_BOARD_STORE_CLOSED");
    if (this.#transactionAfterCommitOperations !== null) throw new Error("TASK_BOARD_TRANSACTION_NESTED");
    this.db.exec("BEGIN IMMEDIATE");
    const afterCommitOperations: Array<() => void> = [];
    this.#transactionAfterCommitOperations = afterCommitOperations;
    let value: T;
    try {
      value = operation();
      this.db.exec("COMMIT");
    } catch (error) {
      this.#transactionAfterCommitOperations = null;
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure. SQLite will reject subsequent unsafe work.
      }
      throw error;
    }
    this.#transactionAfterCommitOperations = null;
    this.#pendingAfterCommitOperations.push(...afterCommitOperations);
    this.drainAfterCommitOperations();
    return value;
  }

  afterCommit(operation: () => void): void {
    if (this.#closed) throw new Error("TASK_BOARD_STORE_CLOSED");
    if (this.#transactionAfterCommitOperations !== null) {
      this.#transactionAfterCommitOperations.push(operation);
      return;
    }
    this.#pendingAfterCommitOperations.push(operation);
    this.drainAfterCommitOperations();
  }

  private drainAfterCommitOperations(): void {
    if (this.#drainingAfterCommitOperations) return;
    this.#drainingAfterCommitOperations = true;
    try {
      while (this.#pendingAfterCommitOperations.length > 0) {
        const operation = this.#pendingAfterCommitOperations.shift()!;
        try {
          operation();
        } catch (error) {
          console.error("[task-board] after-commit callback failed", error);
        }
      }
    } finally {
      this.#drainingAfterCommitOperations = false;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.db.close();
  }
}
