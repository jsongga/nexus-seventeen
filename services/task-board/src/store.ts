import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { TaskBoardError } from "./errors.js";

const SCHEMA_VERSION = 2;

const MIGRATE_VERSION_1_TO_2 = `
ALTER TABLE runs ADD COLUMN task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT;
UPDATE runs
SET task_id = (SELECT wakeups.task_id FROM wakeups WHERE wakeups.wakeup_id = runs.wakeup_id);
PRAGMA user_version = 2;
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
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  workspace_refs_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('backlog', 'queued', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled')),
  assigned_agent_id TEXT REFERENCES agents(agent_id) ON DELETE RESTRICT,
  assigned_role TEXT CHECK (assigned_role IS NULL OR assigned_role IN ('engineer', 'manager', 'verifier')),
  expected_agent_minutes INTEGER NOT NULL CHECK (expected_agent_minutes >= 15 AND expected_agent_minutes <= 10080 AND expected_agent_minutes % 15 = 0),
  started_at TEXT,
  ended_at TEXT,
  result TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((assigned_agent_id IS NULL) = (assigned_role IS NULL)),
  CHECK (ended_at IS NULL OR started_at IS NOT NULL)
) STRICT;
CREATE INDEX tasks_project ON tasks(project_id, created_at, task_id);
CREATE INDEX tasks_agent ON tasks(assigned_agent_id, status, updated_at);

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

CREATE TABLE wakeups (
  wakeup_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('human_assignment', 'human_answer', 'human_resume')),
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

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  claim_request_hash TEXT NOT NULL,
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
      if (version === 0) {
        db.exec(`BEGIN IMMEDIATE; ${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
      } else if (version === 1) {
        db.exec(`BEGIN IMMEDIATE; ${MIGRATE_VERSION_1_TO_2} COMMIT;`);
      } else if (version !== SCHEMA_VERSION) {
        throw new TaskBoardError(
          500,
          "UNSUPPORTED_DATABASE_VERSION",
          `Task board database version ${version} requires an explicit migration`,
        );
      }
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure. SQLite will reject subsequent unsafe work.
      }
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.db.close();
  }
}
