import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ACTOR_TYPES,
  AGENT_ROLES,
  TASK_MESSAGE_ACTOR_TYPES as DOCUMENT_ACTOR_TYPES,
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
  TASK_MESSAGE_ACTOR_TYPES,
  TASK_KINDS,
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
import { TaskBoardError } from "../errors.js";

const SCHEMA_VERSION = 26;

export function workItemPriorityCases(indentation: string): string {
  return WORK_ITEM_PRIORITIES
    .map((priority, rank) => `WHEN '${priority}' THEN ${rank}`)
    .join(`\n${indentation}`);
}

function sqlStringList(values: readonly string[], separator = ", "): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(separator);
}

const DEFAULT_AUTOMATION_STAGES_JSON = JSON.stringify(WORK_ITEM_STAGES.map((stage) => ({
  executor: { kind: stage === "human_review" ? "human" : "disabled" },
  stage,
})));

const VERIFY_ATTEMPTS_SCHEMA = `
CREATE TABLE verify_attempts (
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
);
`;

const WORKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS plan_revisions (
  plan_revision_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  objective TEXT NOT NULL,
  assumptions_json TEXT NOT NULL CHECK (json_valid(assumptions_json)),
  acceptance_criteria_json TEXT NOT NULL CHECK (json_valid(acceptance_criteria_json)),
  change_shape TEXT NULL,
  tier TEXT NULL,
  declared_scope_json TEXT NULL,
  non_goals_json TEXT NULL,
  mechanical_portions_json TEXT NULL,
  blocking_questions_json TEXT NULL,
  criterion_checks_json TEXT NULL,
  rejected_note TEXT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  skill_digests_json TEXT NOT NULL CHECK (json_valid(skill_digests_json)),
  state TEXT NOT NULL CHECK (state IN (${sqlStringList(PLAN_REVISION_STATES, ",")})),
  created_by TEXT NOT NULL,
  confirmed_by TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT, children TEXT NULL,
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
  state TEXT NOT NULL CHECK (state IN (${sqlStringList(WORK_NODE_STATES, ",")})),
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
  stage TEXT NOT NULL CHECK(stage IN (${sqlStringList(WORKFLOW_STAGES, ",")})),
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  skill_digests_json TEXT NOT NULL CHECK(json_valid(skill_digests_json)),
  UNIQUE(node_id, stage, attempt)
) STRICT;
CREATE TABLE IF NOT EXISTS stage_handoffs (
  handoff_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES work_nodes(node_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE RESTRICT,
  stage TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN (${sqlStringList(STAGE_HANDOFF_OUTCOMES, ",")})),
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
CREATE INDEX IF NOT EXISTS project_events_node ON project_events(node_id, sequence);
${VERIFY_ATTEMPTS_SCHEMA}
`;

const WORK_ITEM_PLANNING_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_item_planning_tasks (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;
`;

const WORK_ITEM_DEPENDENCIES_SCHEMA = `
CREATE TABLE work_item_dependencies (
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  depends_on_work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  PRIMARY KEY(work_item_id, depends_on_work_item_id), CHECK(work_item_id <> depends_on_work_item_id)
) STRICT, WITHOUT ROWID;
`;

const WORK_ITEM_ONBOARDING_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_item_onboarding_tasks (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(work_item_id),
  project_id   TEXT NOT NULL REFERENCES projects(project_id),
  task_id      TEXT NOT NULL REFERENCES tasks(task_id),
  gap_report_artifact_id TEXT NULL,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_once_per_project ON work_item_onboarding_tasks(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_task_link ON work_item_onboarding_tasks(task_id);
`;

const REVIEW_DESIGN_SCHEMA = `
CREATE TABLE IF NOT EXISTS review_findings (
  finding_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES work_nodes(node_id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN (${sqlStringList(WORKFLOW_STAGES)})),
  round INTEGER NOT NULL,
  file TEXT NULL,
  line INTEGER NULL,
  category TEXT NOT NULL CHECK (category IN (${sqlStringList(REVIEW_FINDING_CATEGORIES)})),
  severity TEXT NOT NULL CHECK (severity IN (${sqlStringList(REVIEW_FINDING_SEVERITIES)})),
  expected TEXT NOT NULL,
  actual TEXT NOT NULL,
  blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS design_records (
  design_record_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL UNIQUE REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  plan_revision_id TEXT NOT NULL REFERENCES plan_revisions(plan_revision_id) ON DELETE RESTRICT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS work_item_design_tasks (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;
`;

const NOTIFICATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN (${sqlStringList(NOTIFICATION_KINDS)})),
  dedupe_key TEXT NULL UNIQUE,
  project_id TEXT NULL,
  work_item_id TEXT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT NULL,
  version INTEGER NOT NULL
) STRICT;
`;

const GATE_ACTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS gate_actions (
  gate_action_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  gate TEXT NOT NULL CHECK (gate IN (${sqlStringList(GATE_KINDS)})),
  actor_id TEXT NOT NULL,
  plan_revision_id TEXT NULL,
  verified_sha TEXT NULL,
  merge_sha TEXT NULL,
  ref_id TEXT NULL,
  note TEXT NULL,
  created_at TEXT NOT NULL
) STRICT;
`;

const PARK_RECORDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS park_records (
  park_record_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  category TEXT NOT NULL CHECK (category IN (${sqlStringList(PARK_CATEGORIES)})),
  reason TEXT NOT NULL,
  parked_at TEXT NOT NULL,
  resolved_at TEXT NULL,
  resolution TEXT NULL CHECK (resolution IN (${sqlStringList(PARK_RESOLUTIONS)}))
) STRICT;
`;

const LEDGER_OBSERVABILITY_SCHEMA = `
${PARK_RECORDS_SCHEMA}
${NOTIFICATIONS_SCHEMA}
${GATE_ACTIONS_SCHEMA}
`;

const MIGRATE_VERSION_1_TO_2 = `
ALTER TABLE runs ADD COLUMN task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT;
UPDATE runs
SET task_id = (SELECT wakeups.task_id FROM wakeups WHERE wakeups.wakeup_id = runs.wakeup_id);
PRAGMA user_version = 2;
`;

const MIGRATE_VERSION_2_TO_3 = `
ALTER TABLE tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'work'
  CHECK (task_kind IN (${sqlStringList(TASK_KINDS)}));
ALTER TABLE tasks ADD COLUMN required_role TEXT
  CHECK (required_role IS NULL OR required_role IN (${sqlStringList(AGENT_ROLES)}));
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
  pen_holder_actor_type TEXT CHECK (pen_holder_actor_type IS NULL OR pen_holder_actor_type IN (${sqlStringList(DOCUMENT_ACTOR_TYPES)})),
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
  actor_type TEXT NOT NULL CHECK (actor_type IN (${sqlStringList(DOCUMENT_ACTOR_TYPES)})),
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
  stage TEXT NOT NULL CHECK (stage IN (${sqlStringList(TASK_PHASE_STAGES)})),
  status TEXT NOT NULL CHECK (status IN (${sqlStringList(TASK_PHASE_STATUSES)})),
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
  reason TEXT NOT NULL CHECK (reason IN (${sqlStringList(WAKEUP_REASONS)})),
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
  priority TEXT NOT NULL CHECK (priority IN (${sqlStringList(WORK_ITEM_PRIORITIES)})),
  project_target_mode TEXT NOT NULL CHECK (project_target_mode IN ('auto', 'explicit')),
  target_project_id TEXT REFERENCES projects(project_id) ON DELETE RESTRICT,
  resolved_project_id TEXT REFERENCES projects(project_id) ON DELETE RESTRICT,
  parent_work_item_id TEXT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  phase TEXT NULL CHECK (phase IS NULL OR phase IN (${sqlStringList(WORK_ITEM_PHASES)})),
  child_ordinal INTEGER NULL,
  pipeline_branch TEXT NULL,
  base_sha TEXT NULL,
  state TEXT NOT NULL CHECK (state IN (${sqlStringList(WORK_ITEM_STATES)})),
  current_stage TEXT CHECK (current_stage IS NULL OR current_stage IN (${sqlStringList(WORK_ITEM_STAGES)})),
  created_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  cancelled_reason TEXT,
  archived_at TEXT,
  UNIQUE(created_by, idempotency_key),
  CHECK (
    (project_target_mode = 'auto' AND target_project_id IS NULL) OR
    (project_target_mode = 'explicit' AND target_project_id IS NOT NULL)
  ),
  CHECK (project_target_mode = 'auto' OR resolved_project_id IS target_project_id),
  CHECK (
    (state IN (${sqlStringList(WORK_ITEM_TERMINAL_STATES)}) AND ended_at IS NOT NULL) OR
    (state NOT IN (${sqlStringList(WORK_ITEM_TERMINAL_STATES)}) AND ended_at IS NULL)
  )
) STRICT;
CREATE INDEX work_items_updated ON work_items(updated_at DESC, work_item_id);
CREATE INDEX work_items_display_order ON work_items(
  (ended_at IS NOT NULL),
  CASE priority
    ${workItemPriorityCases("    ")}
  END,
  created_at,
  work_item_id
);
CREATE INDEX work_items_unarchived_display_order ON work_items(
  (ended_at IS NOT NULL),
  CASE priority
    ${workItemPriorityCases("    ")}
  END,
  created_at,
  work_item_id
) WHERE archived_at IS NULL;
CREATE TRIGGER work_items_original_request_immutable
BEFORE UPDATE OF original_request ON work_items
WHEN NEW.original_request IS NOT OLD.original_request
BEGIN
  SELECT RAISE(ABORT, 'WORK_ITEM_ORIGINAL_REQUEST_IMMUTABLE');
END;
`;

const WORK_ITEM_TRANSITIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_item_transitions (
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  from_state TEXT CHECK (from_state IS NULL OR from_state IN (${sqlStringList(WORK_ITEM_STATES)})),
  to_state TEXT NOT NULL CHECK (to_state IN (${sqlStringList(WORK_ITEM_STATES)})),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (work_item_id, sequence)
) STRICT;
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
  '${DEFAULT_AUTOMATION_STAGES_JSON}',
  1,
  '1970-01-01T00:00:00.000Z',
  '1970-01-01T00:00:00.000Z',
  'system:steward-default'
);
`;

const BOARD_PAUSE_SCHEMA = `
CREATE TABLE IF NOT EXISTS board_pause (
  pause_id TEXT PRIMARY KEY CHECK (pause_id = 'board'),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  reason TEXT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
) STRICT;
INSERT INTO board_pause(pause_id, paused, reason, version, updated_at, updated_by)
  VALUES ('board', 0, NULL, 1, '1970-01-01T00:00:00.000Z', 'system:steward-default');
`;

const PROJECTS_SCHEMA = `
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`;

const TASKS_SCHEMA = `
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  parent_task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT,
  task_kind TEXT NOT NULL CHECK (task_kind IN (${sqlStringList(TASK_KINDS)})),
  required_role TEXT CHECK (required_role IS NULL OR required_role IN (${sqlStringList(AGENT_ROLES)})),
  requires_review INTEGER NOT NULL CHECK (requires_review IN (0, 1)),
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  workspace_refs_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${sqlStringList(TASK_STATUSES)})),
  assigned_agent_id TEXT REFERENCES agents(agent_id) ON DELETE RESTRICT,
  assigned_role TEXT CHECK (assigned_role IS NULL OR assigned_role IN (${sqlStringList(AGENT_ROLES)})),
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
`;

const SCHEMA = `
${PROJECTS_SCHEMA}

${WORK_ITEM_SCHEMA}
${WORK_ITEM_TRANSITIONS_SCHEMA}
${WORK_ITEM_DEPENDENCIES_SCHEMA}

${AUTOMATION_CONFIGURATION_SCHEMA}
${BOARD_PAUSE_SCHEMA}
${WORKFLOW_SCHEMA}
${WORK_ITEM_PLANNING_SCHEMA}

CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN (${sqlStringList(AGENT_ROLES)})),
  area TEXT NOT NULL,
  mission TEXT NOT NULL,
  model TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  last_error TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX agents_project ON agents(project_id, created_at, agent_id);

${TASKS_SCHEMA}

${WORK_ITEM_ONBOARDING_SCHEMA}

${REVIEW_DESIGN_SCHEMA}

${LEDGER_OBSERVABILITY_SCHEMA}

${TASK_PHASE_SCHEMA}

CREATE TABLE task_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  run_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN (${sqlStringList(TASK_MESSAGE_ACTOR_TYPES)})),
  actor_id TEXT NOT NULL,
  client_event_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (${sqlStringList(TASK_MESSAGE_KINDS)})),
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
  actor_type TEXT NOT NULL CHECK (actor_type IN (${sqlStringList(ACTOR_TYPES)})),
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
  status TEXT NOT NULL CHECK (status IN (${sqlStringList(QUESTION_STATUSES)})),
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
  status TEXT NOT NULL CHECK (status IN (${sqlStringList(RUN_STATUSES)})),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  result TEXT,
  heartbeat_at TEXT,
  runtime TEXT,
  runtime_version TEXT,
  model TEXT,
  prompts_sha TEXT,
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

export function migrateVersion13To14(db: DatabaseSync): void {
  const hasModernTasks = hasColumns(db, "tasks", [
    "task_id", "project_id", "parent_task_id", "task_kind", "required_role", "requires_review",
    "title", "objective", "acceptance_criteria", "workspace_refs_json", "status",
    "assigned_agent_id", "assigned_role", "expected_agent_minutes", "agent_estimate_minutes",
    "estimate_recorded_at", "order_key", "started_at", "ended_at", "result", "version", "created_at", "updated_at",
  ]);
  const hasWakeups = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wakeups'").get() !== undefined;
  const hasModernWakeups = !hasWakeups || hasColumns(db, "wakeups", [
    "wakeup_id", "project_id", "agent_id", "reason", "source_key", "task_id", "question_id",
    "detail", "created_by", "created_at", "claimed_at", "run_id",
  ]);
  // The v1/v2 migration regression fixtures intentionally contain only skeletal tables.
  // Earlier migrations preserve those shapes to prove column additions; there is no status
  // or wakeup-reason constraint to rebuild in those fixtures.
  if (!hasModernTasks || !hasModernWakeups) {
    db.exec("PRAGMA user_version = 14;");
    return;
  }
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
    db.exec(`
      CREATE TABLE tasks_v14 (
        task_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
        parent_task_id TEXT REFERENCES tasks_v14(task_id) ON DELETE RESTRICT,
        task_kind TEXT NOT NULL CHECK (task_kind IN (${sqlStringList(TASK_KINDS)})),
        required_role TEXT CHECK (required_role IS NULL OR required_role IN (${sqlStringList(AGENT_ROLES)})),
        requires_review INTEGER NOT NULL CHECK (requires_review IN (0, 1)),
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        workspace_refs_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (${sqlStringList(TASK_STATUSES)})),
        assigned_agent_id TEXT REFERENCES agents(agent_id) ON DELETE RESTRICT,
        assigned_role TEXT CHECK (assigned_role IS NULL OR assigned_role IN (${sqlStringList(AGENT_ROLES)})),
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
      INSERT INTO tasks_v14(
        task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
        title, objective, acceptance_criteria, workspace_refs_json, status,
        assigned_agent_id, assigned_role, expected_agent_minutes, agent_estimate_minutes,
        estimate_recorded_at, order_key, started_at, ended_at, result, version, created_at, updated_at
      )
      SELECT
        task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
        title, objective, acceptance_criteria, workspace_refs_json, status,
        assigned_agent_id, assigned_role, expected_agent_minutes, agent_estimate_minutes,
        estimate_recorded_at, order_key, started_at, ended_at, result, version, created_at, updated_at
      FROM tasks
      ORDER BY rowid;
      DROP TABLE tasks;
      ALTER TABLE tasks_v14 RENAME TO tasks;
      CREATE INDEX tasks_project ON tasks(project_id, created_at, task_id);
      CREATE INDEX tasks_global_order ON tasks(order_key, task_id);
      CREATE INDEX tasks_agent ON tasks(assigned_agent_id, status, updated_at);
      CREATE UNIQUE INDEX tasks_one_review_stage
        ON tasks(parent_task_id, task_kind)
        WHERE parent_task_id IS NOT NULL AND task_kind IN ('manager_review', 'human_check');

      CREATE TABLE wakeups_v14 (
        wakeup_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
        agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
        reason TEXT NOT NULL CHECK (reason IN (${sqlStringList(WAKEUP_REASONS)})),
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
      INSERT INTO wakeups_v14(
        wakeup_id, project_id, agent_id, reason, source_key, task_id, question_id,
        detail, created_by, created_at, claimed_at, run_id
      )
      SELECT
        wakeup_id, project_id, agent_id, reason, source_key, task_id, question_id,
        detail, created_by, created_at, claimed_at, run_id
      FROM wakeups
      ORDER BY rowid;
      DROP TABLE wakeups;
      ALTER TABLE wakeups_v14 RENAME TO wakeups;
      CREATE INDEX wakeups_pending ON wakeups(agent_id, created_at, wakeup_id) WHERE claimed_at IS NULL;
      PRAGMA user_version = 14;
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
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

function migrateVersion14To15(db: DatabaseSync): void {
  const hasAgents = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get() !== undefined;
  // The v1/v2 regression fixtures intentionally contain only the tables needed
  // to prove their historical column additions.
  if (!hasAgents) {
    db.exec("PRAGMA user_version = 15;");
    return;
  }
  const addLastError = hasColumns(db, "agents", ["last_error"])
    ? ""
    : "ALTER TABLE agents ADD COLUMN last_error TEXT;";
  db.exec(`BEGIN IMMEDIATE; ${addLastError} PRAGMA user_version = 15; COMMIT;`);
}

function migrateVersion15To16(db: DatabaseSync): void {
  const hasWorkItems = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_items'").get() !== undefined;
  if (!hasWorkItems) {
    db.exec("PRAGMA user_version = 16;");
    return;
  }
  const addArchivedAt = hasColumns(db, "work_items", ["archived_at"])
    ? ""
    : "ALTER TABLE work_items ADD COLUMN archived_at TEXT;";
  const addCancelledReason = hasColumns(db, "work_items", ["cancelled_reason"])
    ? ""
    : "ALTER TABLE work_items ADD COLUMN cancelled_reason TEXT;";
  db.exec(`BEGIN IMMEDIATE;
    ${addCancelledReason}
    ${addArchivedAt}
    CREATE INDEX IF NOT EXISTS work_items_unarchived_display_order ON work_items(
      (ended_at IS NOT NULL),
      CASE priority
        ${workItemPriorityCases("        ")}
      END,
      created_at,
      work_item_id
    ) WHERE archived_at IS NULL;
    PRAGMA user_version = 16;
    COMMIT;
  `);
}

function migrateVersion16To17(db: DatabaseSync): void {
  const hasAgents = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get() !== undefined;
  if (!hasAgents) {
    db.exec("PRAGMA user_version = 17;");
    return;
  }
  const addVersion = hasColumns(db, "agents", ["version"])
    ? ""
    : "ALTER TABLE agents ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);";
  db.exec(`BEGIN IMMEDIATE; ${addVersion} PRAGMA user_version = 17; COMMIT;`);
}

function migrateVersion17To18(db: DatabaseSync): void {
  const hasProjectEvents = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_events'",
  ).get() !== undefined;
  if (!hasProjectEvents) {
    db.exec("PRAGMA user_version = 18;");
    return;
  }
  db.exec(`BEGIN IMMEDIATE;
    CREATE INDEX IF NOT EXISTS project_events_node ON project_events(node_id, sequence);
    PRAGMA user_version = 18;
    COMMIT;
  `);
}

function migrateVersion18To19(db: DatabaseSync): void {
  const workItemsSchema = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_items'",
  ).get() as Readonly<{ sql: string }> | undefined;
  const rebuildLegacyWorkItems = workItemsSchema?.sql.includes("'submitted'") ?? false;
  const hasRuns = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
  ).get() !== undefined;
  const addHeartbeatAt = !hasRuns || hasColumns(db, "runs", ["heartbeat_at"])
    ? ""
    : "ALTER TABLE runs ADD COLUMN heartbeat_at TEXT;";
  const addRuntime = !hasRuns || hasColumns(db, "runs", ["runtime"])
    ? ""
    : "ALTER TABLE runs ADD COLUMN runtime TEXT;";
  const addRuntimeVersion = !hasRuns || hasColumns(db, "runs", ["runtime_version"])
    ? ""
    : "ALTER TABLE runs ADD COLUMN runtime_version TEXT;";
  const addModel = !hasRuns || hasColumns(db, "runs", ["model"])
    ? ""
    : "ALTER TABLE runs ADD COLUMN model TEXT;";
  const addPromptsSha = !hasRuns || hasColumns(db, "runs", ["prompts_sha"])
    ? ""
    : "ALTER TABLE runs ADD COLUMN prompts_sha TEXT;";
  const seedMissingTransitions = workItemsSchema === undefined
    ? ""
    : `
      INSERT INTO work_item_transitions(
        work_item_id, sequence, from_state, to_state, actor_type, actor_id, created_at
      )
      SELECT work_item_id, 1, NULL, state, 'system', 'system:migration', updated_at
      FROM work_items
      WHERE NOT EXISTS (
        SELECT 1
        FROM work_item_transitions transition
        WHERE transition.work_item_id = work_items.work_item_id
      );
    `;
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
    if (rebuildLegacyWorkItems) {
      db.exec(`
        CREATE TABLE work_items_v19 (
        work_item_id TEXT PRIMARY KEY,
        original_request TEXT NOT NULL,
        refined_objective TEXT,
        priority TEXT NOT NULL CHECK (priority IN (${sqlStringList(WORK_ITEM_PRIORITIES)})),
        project_target_mode TEXT NOT NULL CHECK (project_target_mode IN ('auto', 'explicit')),
        target_project_id TEXT REFERENCES projects(project_id) ON DELETE RESTRICT,
        resolved_project_id TEXT REFERENCES projects(project_id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK (state IN (${sqlStringList(WORK_ITEM_STATES)})),
        current_stage TEXT CHECK (current_stage IS NULL OR current_stage IN (${sqlStringList(WORK_ITEM_STAGES)})),
        created_by TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT,
        cancelled_reason TEXT,
        archived_at TEXT,
        UNIQUE(created_by, idempotency_key),
        CHECK (
          (project_target_mode = 'auto' AND target_project_id IS NULL) OR
          (project_target_mode = 'explicit' AND target_project_id IS NOT NULL)
        ),
        CHECK (project_target_mode = 'auto' OR resolved_project_id IS target_project_id),
        CHECK (
          (state IN (${sqlStringList(WORK_ITEM_TERMINAL_STATES)}) AND ended_at IS NOT NULL) OR
          (state NOT IN (${sqlStringList(WORK_ITEM_TERMINAL_STATES)}) AND ended_at IS NULL)
        )
      ) STRICT;
      INSERT INTO work_items_v19(
        work_item_id, original_request, refined_objective, priority,
        project_target_mode, target_project_id, resolved_project_id,
        state, current_stage, created_by, idempotency_key, request_hash,
        version, created_at, updated_at, ended_at, cancelled_reason, archived_at
      )
      SELECT
        work_item_id, original_request, refined_objective, priority,
        project_target_mode, target_project_id, resolved_project_id,
        CASE
          WHEN state = 'submitted' THEN 'queued'
          WHEN state = 'needs_input' THEN 'parked'
          WHEN state = 'completed' THEN 'merged'
          WHEN state = 'failed' THEN 'dead_letter'
          WHEN state = 'cancelled' THEN 'abandoned'
          WHEN state = 'waiting_for_human_review' THEN 'plan_approval'
          WHEN state = 'processing' AND current_stage IN ('implementation', 'deployment') THEN 'implementing'
          WHEN state = 'processing' AND current_stage = 'testing' THEN 'verifying'
          WHEN state = 'processing' AND current_stage = 'verification' THEN 'reviewing'
          WHEN state = 'processing' THEN 'planning'
          ELSE 'planning'
        END,
        current_stage, created_by, idempotency_key, request_hash,
        version, created_at, updated_at, ended_at, cancelled_reason, archived_at
      FROM work_items
      ORDER BY rowid;
      DROP TABLE work_items;
      ALTER TABLE work_items_v19 RENAME TO work_items;
      CREATE INDEX work_items_updated ON work_items(updated_at DESC, work_item_id);
      CREATE INDEX work_items_display_order ON work_items(
        (ended_at IS NOT NULL),
        CASE priority
          ${workItemPriorityCases("          ")}
        END,
        created_at,
        work_item_id
      );
      CREATE INDEX work_items_unarchived_display_order ON work_items(
        (ended_at IS NOT NULL),
        CASE priority
          ${workItemPriorityCases("          ")}
        END,
        created_at,
        work_item_id
      ) WHERE archived_at IS NULL;
        CREATE TRIGGER work_items_original_request_immutable
        BEFORE UPDATE OF original_request ON work_items
        WHEN NEW.original_request IS NOT OLD.original_request
        BEGIN
          SELECT RAISE(ABORT, 'WORK_ITEM_ORIGINAL_REQUEST_IMMUTABLE');
        END;
      `);
    }

    db.exec(`
      ${WORK_ITEM_TRANSITIONS_SCHEMA}
      ${seedMissingTransitions}

      ${addHeartbeatAt}
      ${addRuntime}
      ${addRuntimeVersion}
      ${addModel}
      ${addPromptsSha}
    `);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length !== 0) {
      throw new TaskBoardError(500, "DATABASE_MIGRATION_FOREIGN_KEY_FAILED", "Task board migration failed its foreign-key check");
    }
    db.exec("PRAGMA user_version = 19; COMMIT;");
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

function migrateVersion19To20(db: DatabaseSync): void {
  const hasWorkItems = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_items'",
  ).get() !== undefined;
  const hasPlanRevisions = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plan_revisions'",
  ).get() !== undefined;
  const hasVerifyAttempts = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'verify_attempts'",
  ).get() !== undefined;
  const migrations = [
    !hasWorkItems || hasColumns(db, "work_items", ["pipeline_branch"])
      ? ""
      : "ALTER TABLE work_items ADD COLUMN pipeline_branch TEXT NULL;",
    !hasWorkItems || hasColumns(db, "work_items", ["base_sha"])
      ? ""
      : "ALTER TABLE work_items ADD COLUMN base_sha TEXT NULL;",
    !hasPlanRevisions || hasColumns(db, "plan_revisions", ["change_shape"])
      ? ""
      : "ALTER TABLE plan_revisions ADD COLUMN change_shape TEXT NULL;",
    !hasPlanRevisions || hasColumns(db, "plan_revisions", ["tier"])
      ? ""
      : "ALTER TABLE plan_revisions ADD COLUMN tier TEXT NULL;",
    !hasPlanRevisions || hasColumns(db, "plan_revisions", ["declared_scope_json"])
      ? ""
      : "ALTER TABLE plan_revisions ADD COLUMN declared_scope_json TEXT NULL;",
    !hasPlanRevisions || hasColumns(db, "plan_revisions", ["non_goals_json"])
      ? ""
      : "ALTER TABLE plan_revisions ADD COLUMN non_goals_json TEXT NULL;",
    !hasPlanRevisions || hasColumns(db, "plan_revisions", ["mechanical_portions_json"])
      ? ""
      : "ALTER TABLE plan_revisions ADD COLUMN mechanical_portions_json TEXT NULL;",
    !hasPlanRevisions || hasColumns(db, "plan_revisions", ["blocking_questions_json"])
      ? ""
      : "ALTER TABLE plan_revisions ADD COLUMN blocking_questions_json TEXT NULL;",
    !hasPlanRevisions || hasColumns(db, "plan_revisions", ["criterion_checks_json"])
      ? ""
      : "ALTER TABLE plan_revisions ADD COLUMN criterion_checks_json TEXT NULL;",
    !hasPlanRevisions || hasColumns(db, "plan_revisions", ["rejected_note"])
      ? ""
      : "ALTER TABLE plan_revisions ADD COLUMN rejected_note TEXT NULL;",
    hasVerifyAttempts ? "" : VERIFY_ATTEMPTS_SCHEMA,
  ].join("\n");
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(migrations);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length !== 0) {
      throw new TaskBoardError(500, "DATABASE_MIGRATION_FOREIGN_KEY_FAILED", "Task board migration failed its foreign-key check");
    }
    db.exec("PRAGMA user_version = 20; COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  }
}

function migrateVersion20To21(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(REVIEW_DESIGN_SCHEMA);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length !== 0) {
      throw new TaskBoardError(500, "DATABASE_MIGRATION_FOREIGN_KEY_FAILED", "Task board migration failed its foreign-key check");
    }
    db.exec("PRAGMA user_version = 21; COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  }
}

function migrateVersion21To22(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(LEDGER_OBSERVABILITY_SCHEMA);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length !== 0) {
      throw new TaskBoardError(500, "DATABASE_MIGRATION_FOREIGN_KEY_FAILED", "Task board migration failed its foreign-key check");
    }
    db.exec("PRAGMA user_version = 22; COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  }
}

function migrateVersion22To23(db: DatabaseSync): void {
  const hasBoardPause = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'board_pause'",
  ).get() !== undefined;
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
    db.exec(`
      CREATE TABLE park_records_v23 (
        park_record_id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
        category TEXT NOT NULL CHECK (category IN (${sqlStringList(PARK_CATEGORIES)})),
        reason TEXT NOT NULL,
        parked_at TEXT NOT NULL,
        resolved_at TEXT NULL,
        resolution TEXT NULL CHECK (resolution IN (${sqlStringList(PARK_RESOLUTIONS)}))
      ) STRICT;
      INSERT INTO park_records_v23(
        park_record_id, work_item_id, category, reason, parked_at, resolved_at, resolution
      )
      SELECT park_record_id, work_item_id, category, reason, parked_at, resolved_at, resolution
      FROM park_records
      ORDER BY rowid;
      DROP TABLE park_records;
      ALTER TABLE park_records_v23 RENAME TO park_records;

      CREATE TABLE notifications_v23 (
        notification_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN (${sqlStringList(NOTIFICATION_KINDS)})),
        dedupe_key TEXT NULL UNIQUE,
        project_id TEXT NULL,
        work_item_id TEXT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT NULL,
        version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO notifications_v23(
        notification_id, sequence, kind, dedupe_key, project_id, work_item_id,
        summary, created_at, read_at, version
      )
      SELECT notification_id, sequence, kind, dedupe_key, project_id, work_item_id,
        summary, created_at, read_at, version
      FROM notifications
      ORDER BY rowid;
      DROP TABLE notifications;
      ALTER TABLE notifications_v23 RENAME TO notifications;

      ${hasBoardPause ? "" : BOARD_PAUSE_SCHEMA}
    `);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length !== 0) {
      throw new TaskBoardError(500, "DATABASE_MIGRATION_FOREIGN_KEY_FAILED", "Task board migration failed its foreign-key check");
    }
    db.exec("PRAGMA user_version = 23; COMMIT;");
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

function migrateVersion23To24(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(WORK_ITEM_ONBOARDING_SCHEMA);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length !== 0) {
      throw new TaskBoardError(500, "DATABASE_MIGRATION_FOREIGN_KEY_FAILED", "Task board migration failed its foreign-key check");
    }
    db.exec("PRAGMA user_version = 24; COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  }
}

function migrateVersion24To25(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(`
      DROP TABLE IF EXISTS document_events;
      DROP TABLE IF EXISTS documents;
    `);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length !== 0) {
      throw new TaskBoardError(500, "DATABASE_MIGRATION_FOREIGN_KEY_FAILED", "Task board migration failed its foreign-key check");
    }
    db.exec("PRAGMA user_version = 25; COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  }
}

export function migrateVersion25To26(db: DatabaseSync): void {
  const hasProjects = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'",
  ).get() !== undefined;
  const hasWorkItems = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_items'",
  ).get() !== undefined;
  // The v1/v2 regression fixtures intentionally contain only skeletal tables.
  if (!hasProjects || !hasWorkItems) {
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(WORK_ITEM_DEPENDENCIES_SCHEMA.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length !== 0) {
        throw new TaskBoardError(500, "DATABASE_MIGRATION_FOREIGN_KEY_FAILED", "Task board migration failed its foreign-key check");
      }
      const integrity = db.prepare("PRAGMA quick_check").get();
      if (integrity?.quick_check !== "ok") {
        throw new TaskBoardError(500, "DATABASE_MIGRATION_INTEGRITY_FAILED", "Task board migration failed its integrity check");
      }
      db.exec("PRAGMA user_version = 26; COMMIT;");
      return;
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Preserve the migration failure.
      }
      throw error;
    }
  }
  const addPlanRevisionChildren = hasColumns(db, "plan_revisions", ["children"])
    ? ""
    : "ALTER TABLE plan_revisions ADD COLUMN children TEXT NULL;";
  const backfillProjectRepoPath = !hasColumns(db, "projects", ["repo_path"]);
  const backfillParentWorkItemId = !hasColumns(db, "work_items", ["parent_work_item_id"]);
  const backfillWorkItemPhase = !hasColumns(db, "work_items", ["phase"]);
  const backfillChildOrdinal = !hasColumns(db, "work_items", ["child_ordinal"]);
  const hasWorkItemDependencies = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_item_dependencies'",
  ).get() !== undefined;
  const createWorkItemDependencies = hasWorkItemDependencies ? "" : WORK_ITEM_DEPENDENCIES_SCHEMA;
  const hasVerifyAttempts = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='verify_attempts'",
  ).get() !== undefined;
  const verifyAttemptsAcceptRetired = hasVerifyAttempts && String(db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='verify_attempts'",
  ).get()?.sql).includes("'retired'");
  const migrateVerifyAttempts = !hasVerifyAttempts
    ? VERIFY_ATTEMPTS_SCHEMA
    : verifyAttemptsAcceptRetired
      ? ""
      : `
        ALTER TABLE verify_attempts RENAME TO verify_attempts_v25;
        ${VERIFY_ATTEMPTS_SCHEMA}
        INSERT INTO verify_attempts(
          verify_attempt_id, node_id, stage, attempt, verify_run_id, workspace_path,
          state, check_results_json, detail, created_at, ended_at
        )
        SELECT
          verify_attempt_id, node_id, stage, attempt, verify_run_id, workspace_path,
          state, check_results_json, detail, created_at, ended_at
        FROM verify_attempts_v25
        ORDER BY rowid;
        DROP TABLE verify_attempts_v25;
      `;
  const hasLegacyQuotedTasks = String(db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'",
  ).get()?.sql).startsWith('CREATE TABLE "tasks"');
  const hasLegacyQuotedWakeups = String(db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='wakeups'",
  ).get()?.sql).startsWith('CREATE TABLE "wakeups"');
  const canonicalizeLegacyTasks = hasLegacyQuotedTasks
    ? `
      CREATE TEMP TABLE tasks_v25_rows AS SELECT * FROM tasks ORDER BY rowid;
      DROP TABLE tasks;
      ${TASKS_SCHEMA}
      INSERT INTO tasks(
        task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
        title, objective, acceptance_criteria, workspace_refs_json, status,
        assigned_agent_id, assigned_role, expected_agent_minutes, agent_estimate_minutes,
        estimate_recorded_at, order_key, started_at, ended_at, result, version, created_at, updated_at
      )
      SELECT
        task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
        title, objective, acceptance_criteria, workspace_refs_json, status,
        assigned_agent_id, assigned_role, expected_agent_minutes, agent_estimate_minutes,
        estimate_recorded_at, order_key, started_at, ended_at, result, version, created_at, updated_at
      FROM tasks_v25_rows
      ORDER BY rowid;
      DROP TABLE tasks_v25_rows;
    `
    : "";
  const canonicalizeLegacyWakeups = hasLegacyQuotedWakeups
    ? `
      CREATE TEMP TABLE wakeups_v25_rows AS SELECT * FROM wakeups ORDER BY rowid;
      DROP TABLE wakeups;
      ${WAKEUP_SCHEMA}
      INSERT INTO wakeups(
        wakeup_id, project_id, agent_id, reason, source_key, task_id, question_id,
        detail, created_by, created_at, claimed_at, run_id
      )
      SELECT
        wakeup_id, project_id, agent_id, reason, source_key, task_id, question_id,
        detail, created_by, created_at, claimed_at, run_id
      FROM wakeups_v25_rows
      ORDER BY rowid;
      DROP TABLE wakeups_v25_rows;
    `
    : "";
  const alreadyVersion26 = hasColumns(db, "projects", ["repo_path"])
    && hasColumns(db, "work_items", ["parent_work_item_id", "phase", "child_ordinal"])
    && hasColumns(db, "plan_revisions", ["children"])
    && hasWorkItemDependencies
    && String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'").get()?.sql)
      .includes("'coordinating'")
    && String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notifications'").get()?.sql)
      .includes("'phase_ready'")
    && String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='gate_actions'").get()?.sql)
      .includes("'deploy_attest'")
    && String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='park_records'").get()?.sql)
      .includes("'child_failed'")
    && verifyAttemptsAcceptRetired;
  if (alreadyVersion26) {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length !== 0) {
        throw new TaskBoardError(500, "DATABASE_MIGRATION_FOREIGN_KEY_FAILED", "Task board migration failed its foreign-key check");
      }
      const integrity = db.prepare("PRAGMA quick_check").get();
      if (integrity?.quick_check !== "ok") {
        throw new TaskBoardError(500, "DATABASE_MIGRATION_INTEGRITY_FAILED", "Task board migration failed its integrity check");
      }
      db.exec("PRAGMA user_version = 26; COMMIT;");
      return;
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Preserve the migration failure.
      }
      throw error;
    }
  }
  db.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON; BEGIN IMMEDIATE;");
  try {
    db.exec(`
      ${addPlanRevisionChildren}
      ${canonicalizeLegacyTasks}
      ${canonicalizeLegacyWakeups}
      ${migrateVerifyAttempts}
      ALTER TABLE work_item_transitions RENAME TO work_item_transitions_v25;
      DROP INDEX work_items_updated;
      DROP INDEX work_items_display_order;
      DROP INDEX work_items_unarchived_display_order;
      DROP TRIGGER work_items_original_request_immutable;
      ALTER TABLE work_items RENAME TO work_items_v25;
      ALTER TABLE notifications RENAME TO notifications_v25;
      ALTER TABLE gate_actions RENAME TO gate_actions_v25;
      ALTER TABLE park_records RENAME TO park_records_v25;
      ALTER TABLE projects RENAME TO projects_v25;

      ${PROJECTS_SCHEMA}
      INSERT INTO projects(project_id, name, description, repo_path, version, created_at, updated_at)
      SELECT project_id, name, description, ${backfillProjectRepoPath ? "description" : "repo_path"},
        version, created_at, updated_at
      FROM projects_v25
      ORDER BY rowid;

      ${WORK_ITEM_SCHEMA}
      INSERT INTO work_items(
        work_item_id, original_request, refined_objective, priority,
        project_target_mode, target_project_id, resolved_project_id,
        parent_work_item_id, phase, child_ordinal, pipeline_branch, base_sha,
        state, current_stage, created_by, idempotency_key, request_hash,
        version, created_at, updated_at, ended_at, cancelled_reason, archived_at
      )
      SELECT
        work_item_id, original_request, refined_objective, priority,
        project_target_mode, target_project_id, resolved_project_id,
        ${backfillParentWorkItemId ? "NULL" : "parent_work_item_id"},
        ${backfillWorkItemPhase ? "NULL" : "phase"},
        ${backfillChildOrdinal ? "NULL" : "child_ordinal"}, pipeline_branch, base_sha,
        state, current_stage, created_by, idempotency_key, request_hash,
        version, created_at, updated_at, ended_at, cancelled_reason, archived_at
      FROM work_items_v25
      ORDER BY rowid;

      ${WORK_ITEM_TRANSITIONS_SCHEMA}
      INSERT INTO work_item_transitions(
        work_item_id, sequence, from_state, to_state, actor_type, actor_id, created_at
      )
      SELECT work_item_id, sequence, from_state, to_state, actor_type, actor_id, created_at
      FROM work_item_transitions_v25
      ORDER BY work_item_id, sequence;

      ${PARK_RECORDS_SCHEMA}
      INSERT INTO park_records(
        park_record_id, work_item_id, category, reason, parked_at, resolved_at, resolution
      )
      SELECT park_record_id, work_item_id, category, reason, parked_at, resolved_at, resolution
      FROM park_records_v25
      ORDER BY rowid;

      ${NOTIFICATIONS_SCHEMA}
      INSERT INTO notifications(
        notification_id, sequence, kind, dedupe_key, project_id, work_item_id,
        summary, created_at, read_at, version
      )
      SELECT notification_id, sequence, kind, dedupe_key, project_id, work_item_id,
        summary, created_at, read_at, version
      FROM notifications_v25
      ORDER BY rowid;

      ${GATE_ACTIONS_SCHEMA}
      INSERT INTO gate_actions(
        gate_action_id, work_item_id, gate, actor_id, plan_revision_id,
        verified_sha, merge_sha, ref_id, note, created_at
      )
      SELECT gate_action_id, work_item_id, gate, actor_id, plan_revision_id,
        verified_sha, merge_sha, ref_id, note, created_at
      FROM gate_actions_v25
      ORDER BY rowid;

      ${createWorkItemDependencies}

      DROP TABLE work_item_transitions_v25;
      DROP TABLE park_records_v25;
      DROP TABLE notifications_v25;
      DROP TABLE gate_actions_v25;
      DROP TABLE work_items_v25;
      DROP TABLE projects_v25;
    `);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length !== 0) {
      throw new TaskBoardError(500, "DATABASE_MIGRATION_FOREIGN_KEY_FAILED", "Task board migration failed its foreign-key check");
    }
    const integrity = db.prepare("PRAGMA quick_check").get();
    if (integrity?.quick_check !== "ok") {
      throw new TaskBoardError(500, "DATABASE_MIGRATION_INTEGRITY_FAILED", "Task board migration failed its integrity check");
    }
    db.exec("PRAGMA user_version = 26; COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  } finally {
    db.exec("PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;");
  }
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
  const hasVerifyAttempts = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'verify_attempts'",
  ).get() !== undefined;
  const schema = hasVerifyAttempts ? WORKFLOW_SCHEMA.replace(VERIFY_ATTEMPTS_SCHEMA, "") : WORKFLOW_SCHEMA;
  db.exec(`BEGIN IMMEDIATE; ${schema} PRAGMA user_version = 11; COMMIT;`);
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
          reason TEXT NOT NULL CHECK (reason IN (${sqlStringList(WAKEUP_REASONS)})),
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
          stage TEXT NOT NULL CHECK (stage IN (${sqlStringList(TASK_PHASE_STAGES)})),
          status TEXT NOT NULL CHECK (status IN (${sqlStringList(TASK_PHASE_STATUSES)})),
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
      } else if (version === 13) {
        // Recovery task states and wakeup reasons are added below.
      } else if (version === 14) {
        // Durable fleet lane errors are added below.
      } else if (version === 15) {
        // Terminal work-item archival is added below.
      } else if (version === 16) {
        // Agent credential versions are added below.
      } else if (version === 17) {
        // Workflow node event lookups are indexed below.
      } else if (version === 18) {
        // Work-item pipeline states, transition history, and run identity columns are added below.
      } else if (version === 19) {
        // Pipeline plan records, branch identity, and machine-verify attempts are added below.
      } else if (version === 20) {
        // Review findings, design records, and design-task links are added below.
      } else if (version === 21) {
        // Park records, notifications, and gate actions are added below.
      } else if (version === 22) {
        // Scheduling caps, board pause, and widened ledger enums are added below.
      } else if (version === 23) {
        // Onboarding work-item links are added below.
      } else if (version === 24) {
        // Pen-document storage is retired below.
      } else if (version === 25) {
        // Work-item decomposition and durable project repository paths are added below.
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
      if (version >= 1 && version <= 13) migrateVersion13To14(db);
      if (version >= 1 && version <= 14) migrateVersion14To15(db);
      if (version >= 1 && version <= 15) migrateVersion15To16(db);
      if (version >= 1 && version <= 16) migrateVersion16To17(db);
      if (version >= 1 && version <= 17) migrateVersion17To18(db);
      if (version >= 1 && version <= 18) migrateVersion18To19(db);
      if (version >= 1 && version <= 19) migrateVersion19To20(db);
      if (version >= 1 && version <= 20) migrateVersion20To21(db);
      if (version >= 1 && version <= 21) migrateVersion21To22(db);
      if (version >= 1 && version <= 22) migrateVersion22To23(db);
      if (version >= 1 && version <= 23) migrateVersion23To24(db);
      if (version >= 1 && version <= 24) migrateVersion24To25(db);
      if (version >= 1 && version <= 25) migrateVersion25To26(db);
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

  get hasOpenTransaction(): boolean {
    return this.#transactionAfterCommitOperations !== null;
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
