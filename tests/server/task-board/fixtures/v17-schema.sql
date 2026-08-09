-- index: agents_project
CREATE INDEX agents_project ON agents(project_id, created_at, agent_id);

-- index: document_events_project
CREATE INDEX document_events_project ON document_events(project_id, created_at DESC, document_id, sequence);

-- index: documents_project
CREATE INDEX documents_project ON documents(project_id, updated_at DESC, document_id);

-- index: interrupts_project
CREATE INDEX interrupts_project ON interrupts(project_id, requested_at DESC);

-- index: project_events_project
CREATE INDEX project_events_project ON project_events(project_id, sequence);

-- index: questions_agent_status
CREATE INDEX questions_agent_status ON questions(agent_id, status, asked_at);

-- index: runs_one_active_agent
CREATE UNIQUE INDEX runs_one_active_agent ON runs(agent_id) WHERE status = 'active';

-- index: task_events_project
CREATE INDEX task_events_project ON task_events(project_id, sequence DESC);

-- index: task_messages_task
CREATE INDEX task_messages_task ON task_messages(task_id, sequence);

-- index: task_phases_parallel
CREATE INDEX task_phases_parallel ON task_phases(task_id, parallel_group, order_key)
  WHERE parallel_group IS NOT NULL;

-- index: task_phases_task
CREATE INDEX task_phases_task ON task_phases(task_id, order_key, phase_id);

-- index: tasks_agent
CREATE INDEX tasks_agent ON tasks(assigned_agent_id, status, updated_at);

-- index: tasks_global_order
CREATE INDEX tasks_global_order ON tasks(order_key, task_id);

-- index: tasks_one_review_stage
CREATE UNIQUE INDEX tasks_one_review_stage
  ON tasks(parent_task_id, task_kind)
  WHERE parent_task_id IS NOT NULL AND task_kind IN ('manager_review', 'human_check');

-- index: tasks_project
CREATE INDEX tasks_project ON tasks(project_id, created_at, task_id);

-- index: wakeups_pending
CREATE INDEX wakeups_pending ON wakeups(agent_id, created_at, wakeup_id) WHERE claimed_at IS NULL;

-- index: work_items_display_order
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

-- index: work_items_unarchived_display_order
CREATE INDEX work_items_unarchived_display_order ON work_items(
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
) WHERE archived_at IS NULL;

-- index: work_items_updated
CREATE INDEX work_items_updated ON work_items(updated_at DESC, work_item_id);

-- table: agents
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('engineer', 'manager', 'verifier')),
  area TEXT NOT NULL,
  mission TEXT NOT NULL,
  model TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  last_error TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL
) STRICT;

-- table: artifacts
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  node_id TEXT REFERENCES work_nodes(node_id) ON DELETE RESTRICT, task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT,
  media_type TEXT NOT NULL, byte_size INTEGER NOT NULL, digest TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE, caption TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;

-- table: automation_configuration
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

-- table: document_events
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

-- table: documents
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

-- table: interrupts
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

-- table: plan_revisions
CREATE TABLE plan_revisions (
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

-- table: project_events
CREATE TABLE project_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  node_id TEXT REFERENCES work_nodes(node_id) ON DELETE RESTRICT, task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;

-- table: projects
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- table: questions
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

-- table: runs
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

-- table: stage_attempts
CREATE TABLE stage_attempts (
  attempt_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES work_nodes(node_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK(stage IN ('research','planning','implementation','testing','verification')),
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  skill_digests_json TEXT NOT NULL CHECK(json_valid(skill_digests_json)),
  UNIQUE(node_id, stage, attempt)
) STRICT;

-- table: stage_handoffs
CREATE TABLE stage_handoffs (
  handoff_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES work_nodes(node_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE RESTRICT,
  stage TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('passed','failed','needs_input')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at TEXT NOT NULL
) STRICT;

-- table: task_events
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

-- table: task_messages
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

-- table: task_phases
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

-- table: tasks
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
  status TEXT NOT NULL CHECK (status IN ('backlog', 'queued', 'in_progress', 'blocked', 'completed', 'failed', 'interrupted', 'cancelled')),
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

-- table: wakeups
CREATE TABLE wakeups (
  wakeup_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('human_assignment', 'human_answer', 'human_resume', 'workflow_handoff', 'assigned', 'resumed')),
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

-- table: work_item_planning_tasks
CREATE TABLE work_item_planning_tasks (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(work_item_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;

-- table: work_items
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
  cancelled_reason TEXT,
  archived_at TEXT,
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

-- table: work_node_dependencies
CREATE TABLE work_node_dependencies (
  node_id TEXT NOT NULL REFERENCES work_nodes(node_id) ON DELETE RESTRICT,
  dependency_node_id TEXT NOT NULL REFERENCES work_nodes(node_id) ON DELETE RESTRICT,
  PRIMARY KEY(node_id, dependency_node_id), CHECK(node_id <> dependency_node_id)
) STRICT, WITHOUT ROWID;

-- table: work_nodes
CREATE TABLE work_nodes (
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

-- trigger: work_items_original_request_immutable
CREATE TRIGGER work_items_original_request_immutable
BEFORE UPDATE OF original_request ON work_items
WHEN NEW.original_request IS NOT OLD.original_request
BEGIN
  SELECT RAISE(ABORT, 'WORK_ITEM_ORIGINAL_REQUEST_IMMUTABLE');
END;
