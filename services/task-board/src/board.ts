import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { SQLOutputValue } from "node:sqlite";
import {
  TASK_BOARD_API_VERSION,
  type AgentInterrupt,
  type AgentProfile,
  type AgentRole,
  type AgentRun,
  type AnswerHumanQuestionRequest,
  type BoardSnapshot,
  type BoardTask,
  type ClaimRunRequest,
  type ClaimRunResult,
  type CreateAgentRequest,
  type CreateHumanQuestionRequest,
  type CreateHumanTaskMessageRequest,
  type CreateProjectRequest,
  type CreateTaskMessageRequest,
  type CreateTaskRequest,
  type HumanQuestion,
  type InterruptAgentRequest,
  type Project,
  type ResumeAgentRequest,
  type RunInterruptBatch,
  type SettleRunRequest,
  type TaskEvent,
  type TaskMessage,
  type TaskStatus,
  type UpdateTaskRequest,
  type Wakeup,
} from "@cicada/steward-task-board-contract";
import { canonicalJson, sha256, tokenMatches } from "./canonical.js";
import type { TaskBoardConfig } from "./config.js";
import { conflict, TaskBoardError } from "./errors.js";
import { TaskBoardStore } from "./store.js";

type Row = Record<string, SQLOutputValue>;
type Actor = Readonly<{ type: "human" | "agent"; id: string }>;

function stringValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`TASK_BOARD_DATABASE_CORRUPT:${key}`);
  return value;
}

function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`TASK_BOARD_DATABASE_CORRUPT:${key}`);
  return value;
}

function numberValue(row: Row, key: string): number {
  const value = row[key];
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new Error(`TASK_BOARD_DATABASE_CORRUPT:${key}`);
  }
  return number;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`TASK_BOARD_DATABASE_CORRUPT:${label}`);
  }
}

function exactNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error("TASK_BOARD_CLOCK_INVALID");
  return value.toISOString();
}

function expectedCompletedAt(startedAt: string | null, minutes: number): string | null {
  if (startedAt === null) return null;
  const milliseconds = Date.parse(startedAt) + minutes * 60_000;
  if (!Number.isSafeInteger(milliseconds)) throw new Error("TASK_BOARD_TIME_RANGE_INVALID");
  return new Date(milliseconds).toISOString();
}

function projectFromRow(row: Row): Project {
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    projectId: stringValue(row, "project_id"),
    name: stringValue(row, "name"),
    description: stringValue(row, "description"),
    version: numberValue(row, "version"),
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
  });
}

function taskFromRow(row: Row): BoardTask {
  const startedAt = nullableString(row, "started_at");
  const minutes = numberValue(row, "expected_agent_minutes");
  const refs = parseJson<unknown>(stringValue(row, "workspace_refs_json"), "workspace_refs_json");
  if (!Array.isArray(refs) || refs.some((value) => typeof value !== "string")) {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:workspace_refs_json");
  }
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    taskId: stringValue(row, "task_id"),
    projectId: stringValue(row, "project_id"),
    parentTaskId: nullableString(row, "parent_task_id"),
    title: stringValue(row, "title"),
    objective: stringValue(row, "objective"),
    acceptanceCriteria: stringValue(row, "acceptance_criteria"),
    workspaceRefs: Object.freeze([...refs] as string[]),
    status: stringValue(row, "status") as TaskStatus,
    assignedAgentId: nullableString(row, "assigned_agent_id"),
    assignedRole: nullableString(row, "assigned_role") as AgentRole | null,
    expectedAgentMinutes: minutes,
    startedAt,
    expectedCompletedAt: expectedCompletedAt(startedAt, minutes),
    endedAt: nullableString(row, "ended_at"),
    result: nullableString(row, "result"),
    version: numberValue(row, "version"),
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
  });
}

function messageFromRow(row: Row): TaskMessage {
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    messageId: stringValue(row, "message_id"),
    sequence: numberValue(row, "sequence"),
    projectId: stringValue(row, "project_id"),
    taskId: stringValue(row, "task_id"),
    runId: nullableString(row, "run_id"),
    actorType: stringValue(row, "actor_type") as "human" | "agent",
    actorId: stringValue(row, "actor_id"),
    kind: stringValue(row, "kind") as TaskMessage["kind"],
    body: stringValue(row, "body"),
    createdAt: stringValue(row, "created_at"),
  });
}

function questionFromRow(row: Row): HumanQuestion {
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    questionId: stringValue(row, "question_id"),
    projectId: stringValue(row, "project_id"),
    taskId: stringValue(row, "task_id"),
    agentId: stringValue(row, "agent_id"),
    runId: stringValue(row, "run_id"),
    question: stringValue(row, "question"),
    status: stringValue(row, "status") as HumanQuestion["status"],
    answer: nullableString(row, "answer"),
    askedAt: stringValue(row, "asked_at"),
    answeredAt: nullableString(row, "answered_at"),
    answeredBy: nullableString(row, "answered_by"),
    version: numberValue(row, "version"),
  });
}

function wakeupFromRow(row: Row): Wakeup {
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    wakeupId: stringValue(row, "wakeup_id"),
    projectId: stringValue(row, "project_id"),
    agentId: stringValue(row, "agent_id"),
    reason: stringValue(row, "reason") as Wakeup["reason"],
    taskId: nullableString(row, "task_id"),
    questionId: nullableString(row, "question_id"),
    detail: stringValue(row, "detail"),
    createdBy: stringValue(row, "created_by"),
    createdAt: stringValue(row, "created_at"),
    claimedAt: nullableString(row, "claimed_at"),
    runId: nullableString(row, "run_id"),
  });
}

function runFromRow(row: Row): AgentRun {
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    runId: stringValue(row, "run_id"),
    claimId: stringValue(row, "claim_id"),
    projectId: stringValue(row, "project_id"),
    agentId: stringValue(row, "agent_id"),
    wakeupId: stringValue(row, "wakeup_id"),
    taskId: nullableString(row, "task_id"),
    status: stringValue(row, "status") as AgentRun["status"],
    startedAt: stringValue(row, "started_at"),
    endedAt: nullableString(row, "ended_at"),
    result: nullableString(row, "result"),
  });
}

function interruptFromRow(row: Row): AgentInterrupt {
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    sequence: numberValue(row, "sequence"),
    interruptId: stringValue(row, "interrupt_id"),
    projectId: stringValue(row, "project_id"),
    agentId: stringValue(row, "agent_id"),
    runId: nullableString(row, "run_id"),
    reason: stringValue(row, "reason"),
    requestedBy: stringValue(row, "requested_by"),
    requestedAt: stringValue(row, "requested_at"),
  });
}

function eventFromRow(row: Row): TaskEvent {
  const data = parseJson<unknown>(stringValue(row, "data_json"), "data_json");
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:data_json");
  }
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    eventId: stringValue(row, "event_id"),
    projectId: stringValue(row, "project_id"),
    taskId: nullableString(row, "task_id"),
    actorType: stringValue(row, "actor_type") as TaskEvent["actorType"],
    actorId: stringValue(row, "actor_id"),
    eventType: stringValue(row, "event_type"),
    data: Object.freeze(data as Record<string, unknown>),
    createdAt: stringValue(row, "created_at"),
  });
}

export class TaskBoard {
  readonly #config: TaskBoardConfig;
  readonly #store: TaskBoardStore;
  readonly #interruptEvents = new EventEmitter();
  readonly #wakeupEvents = new EventEmitter();

  private constructor(config: TaskBoardConfig, store: TaskBoardStore) {
    this.#config = config;
    this.#store = store;
    this.#interruptEvents.setMaxListeners(512);
    this.#wakeupEvents.setMaxListeners(512);
  }

  static async open(config: TaskBoardConfig): Promise<TaskBoard> {
    return new TaskBoard(config, await TaskBoardStore.open(config.dbPath));
  }

  authenticateAgent(token: string | undefined, expectedAgentId?: string): AgentProfile {
    if (token === undefined) throw new TaskBoardError(401, "UNAUTHORIZED", "Agent authentication is required");
    const rows = expectedAgentId === undefined
      ? this.#store.db.prepare("SELECT * FROM agents").all()
      : this.#store.db.prepare("SELECT * FROM agents WHERE agent_id = ?").all(expectedAgentId);
    const row = rows.find((candidate) => tokenMatches(stringValue(candidate, "token_hash"), token));
    if (!row) throw new TaskBoardError(401, "UNAUTHORIZED", "Agent authentication is required");
    return this.#agentFromRow(row);
  }

  listProjects(): readonly Project[] {
    return Object.freeze(this.#store.db.prepare("SELECT * FROM projects ORDER BY created_at, project_id").all().map(projectFromRow));
  }

  createProject(request: CreateProjectRequest): Project {
    const now = exactNow(this.#config.now);
    const projectId = randomUUID();
    this.#store.transaction(() => {
      this.#store.db.prepare(`
        INSERT INTO projects(project_id, name, description, version, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(projectId, request.name, request.description, now, now);
      this.#insertEvent(projectId, null, { type: "human", id: this.#config.humanPrincipal }, "project_created", {
        name: request.name,
      }, now);
    });
    return this.#requireProject(projectId);
  }

  createAgent(projectId: string, request: CreateAgentRequest): AgentProfile {
    this.#requireProject(projectId);
    const tokenHash = sha256(request.token);
    if (tokenHash === sha256(this.#config.humanToken)) {
      throw conflict("TOKEN_REALM_CONFLICT", "Agent credential must be distinct from the human credential");
    }
    const now = exactNow(this.#config.now);
    try {
      this.#store.transaction(() => {
        this.#store.db.prepare(`
          INSERT INTO agents(agent_id, project_id, role, area, mission, model, token_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          request.agentId,
          projectId,
          request.role,
          request.area,
          request.mission,
          request.model,
          tokenHash,
          now,
        );
        this.#insertEvent(projectId, null, { type: "human", id: this.#config.humanPrincipal }, "agent_profile_created", {
          agentId: request.agentId,
          role: request.role,
          area: request.area,
          model: request.model,
        }, now);
      });
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        throw conflict("AGENT_ALREADY_EXISTS", "Agent id or credential is already registered");
      }
      throw error;
    }
    return this.#requireAgent(request.agentId);
  }

  createTask(projectId: string, request: CreateTaskRequest): BoardTask {
    this.#requireProject(projectId);
    if (request.parentTaskId !== null) {
      const parent = this.#requireTask(request.parentTaskId);
      if (parent.projectId !== projectId) throw conflict("PARENT_PROJECT_MISMATCH", "Parent task belongs to another project");
    }
    if (request.assignedAgentId !== null && request.assignedRole !== null) {
      this.#assertAssignment(projectId, request.assignedAgentId, request.assignedRole);
    }
    const taskId = randomUUID();
    const now = exactNow(this.#config.now);
    const status: TaskStatus = request.assignedAgentId === null ? "backlog" : "queued";
    this.#store.transaction(() => {
      this.#store.db.prepare(`
        INSERT INTO tasks(
          task_id, project_id, parent_task_id, title, objective, acceptance_criteria, workspace_refs_json,
          status, assigned_agent_id, assigned_role, expected_agent_minutes, started_at, ended_at,
          result, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, ?, ?)
      `).run(
        taskId,
        projectId,
        request.parentTaskId,
        request.title,
        request.objective,
        request.acceptanceCriteria,
        canonicalJson(request.workspaceRefs),
        status,
        request.assignedAgentId,
        request.assignedRole,
        request.expectedAgentMinutes,
        now,
        now,
      );
      this.#insertEvent(projectId, taskId, { type: "human", id: this.#config.humanPrincipal }, "task_created", {
        status,
        assignedAgentId: request.assignedAgentId,
        expectedAgentMinutes: request.expectedAgentMinutes,
      }, now);
      if (request.assignedAgentId !== null) {
        this.#insertWakeup(
          projectId,
          request.assignedAgentId,
          "human_assignment",
          `task:${taskId}:version:1`,
          taskId,
          null,
          `Assigned task: ${request.title}`,
          now,
        );
      }
    });
    if (request.assignedAgentId !== null) this.#wakeupEvents.emit(request.assignedAgentId);
    return this.#requireTask(taskId);
  }

  updateTask(taskId: string, request: UpdateTaskRequest, actor: Actor): BoardTask {
    const current = this.#requireTask(taskId);
    if (current.version !== request.version) throw conflict("TASK_VERSION_CONFLICT", "Task version changed");
    if (current.endedAt !== null) throw conflict("TASK_TERMINAL", "Terminal tasks are immutable");
    if (actor.type === "agent") {
      const forbidden = ["title", "objective", "acceptanceCriteria", "workspaceRefs", "assignedAgentId", "assignedRole", "expectedAgentMinutes"]
        .some((field) => field in request);
      if (forbidden) throw new TaskBoardError(403, "HUMAN_UPDATE_REQUIRED", "Assignment and planning fields are human-only");
      if (current.assignedAgentId !== actor.id) throw new TaskBoardError(403, "TASK_NOT_ASSIGNED", "Task is not assigned to this agent");
      if (request.status === "cancelled" || request.status === "backlog" || request.status === "queued") {
        throw new TaskBoardError(403, "HUMAN_UPDATE_REQUIRED", "Agent cannot move work to the requested status");
      }
      this.#requireActiveRun(actor.id, taskId);
    }
    const assignedAgentId = "assignedAgentId" in request ? request.assignedAgentId ?? null : current.assignedAgentId;
    const assignedRole = "assignedRole" in request ? request.assignedRole ?? null : current.assignedRole;
    if (assignedAgentId !== null && assignedRole !== null) this.#assertAssignment(current.projectId, assignedAgentId, assignedRole);
    const assignmentChanged = actor.type === "human" && assignedAgentId !== null && assignedAgentId !== current.assignedAgentId;
    const status = request.status ?? (assignmentChanged && current.status === "backlog" ? "queued" : current.status);
    const terminal = status === "completed" || status === "failed" || status === "cancelled";
    const result = "result" in request ? request.result ?? null : current.result;
    if (terminal && result === null) throw new TaskBoardError(400, "TASK_RESULT_REQUIRED", "Terminal task status requires a result");
    if (!terminal && result !== null) throw new TaskBoardError(400, "TASK_RESULT_NOT_TERMINAL", "Task result is reserved for terminal status");
    const now = exactNow(this.#config.now);
    const startedAt = current.startedAt ?? (status === "in_progress" || status === "blocked" || terminal ? now : null);
    const endedAt = terminal ? now : null;
    const nextVersion = current.version + 1;
    const changed = this.#store.transaction(() => {
      const update = this.#store.db.prepare(`
        UPDATE tasks SET
          title = ?, objective = ?, acceptance_criteria = ?, workspace_refs_json = ?, status = ?,
          assigned_agent_id = ?, assigned_role = ?, expected_agent_minutes = ?, started_at = ?, ended_at = ?,
          result = ?, version = ?, updated_at = ?
        WHERE task_id = ? AND version = ? AND ended_at IS NULL
      `).run(
        request.title ?? current.title,
        request.objective ?? current.objective,
        request.acceptanceCriteria ?? current.acceptanceCriteria,
        canonicalJson(request.workspaceRefs ?? current.workspaceRefs),
        status,
        assignedAgentId,
        assignedRole,
        request.expectedAgentMinutes ?? current.expectedAgentMinutes,
        startedAt,
        endedAt,
        result,
        nextVersion,
        now,
        taskId,
        current.version,
      );
      if (Number(update.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Task version changed");
      this.#insertEvent(current.projectId, taskId, actor, "task_updated", {
        previousVersion: current.version,
        version: nextVersion,
        status,
        assignedAgentId,
      }, now);
      if (assignmentChanged && assignedAgentId !== null) {
        this.#insertWakeup(
          current.projectId,
          assignedAgentId,
          "human_assignment",
          `task:${taskId}:version:${nextVersion}`,
          taskId,
          null,
          `Assigned task: ${request.title ?? current.title}`,
          now,
        );
      }
      return true;
    });
    if (!changed) throw new Error("TASK_BOARD_UPDATE_FAILED");
    if (assignmentChanged && assignedAgentId !== null) this.#wakeupEvents.emit(assignedAgentId);
    return this.#requireTask(taskId);
  }

  appendAgentMessage(taskId: string, agentId: string, request: CreateTaskMessageRequest): TaskMessage {
    const task = this.#requireTask(taskId);
    if (task.assignedAgentId !== agentId) throw new TaskBoardError(403, "TASK_NOT_ASSIGNED", "Task is not assigned to this agent");
    return this.#appendMessage(task, { type: "agent", id: agentId }, request.clientEventId, request.runId, request.kind, request.body);
  }

  appendHumanMessage(taskId: string, request: CreateHumanTaskMessageRequest): TaskMessage {
    const task = this.#requireTask(taskId);
    return this.#appendMessage(
      task,
      { type: "human", id: this.#config.humanPrincipal },
      request.clientEventId,
      null,
      request.kind,
      request.body,
    );
  }

  askQuestion(taskId: string, agentId: string, request: CreateHumanQuestionRequest): HumanQuestion {
    const task = this.#requireTask(taskId);
    if (task.assignedAgentId !== agentId) throw new TaskBoardError(403, "TASK_NOT_ASSIGNED", "Task is not assigned to this agent");
    const hash = sha256({ action: "ask_question", taskId, agentId, request });
    const prior = this.#store.db.prepare("SELECT * FROM questions WHERE agent_id = ? AND client_event_id = ?").get(agentId, request.clientEventId);
    if (prior) {
      if (stringValue(prior, "request_hash") !== hash) throw conflict("CLIENT_EVENT_CONFLICT", "clientEventId was used for another question");
      return questionFromRow(prior);
    }
    this.#requireRun(request.runId, agentId, taskId, true);
    if (task.endedAt !== null) throw conflict("TASK_TERMINAL", "Terminal task cannot wait for a human answer");
    const questionId = randomUUID();
    const now = exactNow(this.#config.now);
    this.#store.transaction(() => {
      this.#store.db.prepare(`
        INSERT INTO questions(
          question_id, project_id, task_id, agent_id, run_id, client_event_id, request_hash,
          question, status, answer, asked_at, answered_at, answered_by, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, NULL, NULL, 1)
      `).run(questionId, task.projectId, taskId, agentId, request.runId, request.clientEventId, hash, request.question, now);
      const settled = this.#store.db.prepare(`
        UPDATE runs SET status = 'waiting_for_human', ended_at = ?, result = ?
        WHERE run_id = ? AND agent_id = ? AND status = 'active'
      `).run(now, `Waiting for human answer: ${request.question}`, request.runId, agentId);
      if (Number(settled.changes) !== 1) throw conflict("RUN_NOT_ACTIVE", "Run is no longer active");
      if (task.status !== "blocked") {
        const blocked = this.#store.db.prepare(`
          UPDATE tasks
          SET status = 'blocked', version = version + 1, updated_at = ?
          WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND ended_at IS NULL
        `).run(now, taskId, agentId, task.version);
        if (Number(blocked.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Task changed while its question was opening");
        this.#insertEvent(task.projectId, taskId, { type: "agent", id: agentId }, "task_blocked_for_human", {
          runId: request.runId,
          questionId,
          previousStatus: task.status,
          status: "blocked",
          version: task.version + 1,
        }, now);
      }
      this.#insertEvent(task.projectId, taskId, { type: "agent", id: agentId }, "human_question_opened", {
        questionId,
        runId: request.runId,
      }, now);
    });
    return questionFromRow(this.#store.db.prepare("SELECT * FROM questions WHERE question_id = ?").get(questionId)!);
  }

  answerQuestion(questionId: string, request: AnswerHumanQuestionRequest): { question: HumanQuestion; wakeup: Wakeup; duplicate: boolean } {
    const currentRow = this.#store.db.prepare("SELECT * FROM questions WHERE question_id = ?").get(questionId);
    if (!currentRow) throw new TaskBoardError(404, "QUESTION_NOT_FOUND", "Question was not found");
    const current = questionFromRow(currentRow);
    if (current.status === "answered") {
      if (current.answer !== request.answer || current.version !== request.version + 1) {
        throw conflict("QUESTION_ALREADY_ANSWERED", "Question already has another answer");
      }
      const wake = this.#store.db.prepare("SELECT * FROM wakeups WHERE reason = 'human_answer' AND source_key = ?").get(`question:${questionId}`);
      if (!wake) throw new Error("TASK_BOARD_DATABASE_CORRUPT:answered_question_wakeup");
      return { question: current, wakeup: wakeupFromRow(wake), duplicate: true };
    }
    if (current.version !== request.version) throw conflict("QUESTION_VERSION_CONFLICT", "Question version changed");
    const now = exactNow(this.#config.now);
    let wakeupId = "";
    this.#store.transaction(() => {
      const update = this.#store.db.prepare(`
        UPDATE questions SET status = 'answered', answer = ?, answered_at = ?, answered_by = ?, version = version + 1
        WHERE question_id = ? AND status = 'open' AND version = ?
      `).run(request.answer, now, this.#config.humanPrincipal, questionId, request.version);
      if (Number(update.changes) !== 1) throw conflict("QUESTION_VERSION_CONFLICT", "Question version changed");
      wakeupId = this.#insertWakeup(
        current.projectId,
        current.agentId,
        "human_answer",
        `question:${questionId}`,
        current.taskId,
        questionId,
        `Human answered: ${request.answer}`,
        now,
      );
      this.#insertEvent(current.projectId, current.taskId, { type: "human", id: this.#config.humanPrincipal }, "human_question_answered", {
        questionId,
        wakeupId,
      }, now);
    });
    this.#wakeupEvents.emit(current.agentId);
    return {
      question: questionFromRow(this.#store.db.prepare("SELECT * FROM questions WHERE question_id = ?").get(questionId)!),
      wakeup: wakeupFromRow(this.#store.db.prepare("SELECT * FROM wakeups WHERE wakeup_id = ?").get(wakeupId)!),
      duplicate: false,
    };
  }

  resumeAgent(agentId: string, request: ResumeAgentRequest, idempotencyKey: string): { wakeup: Wakeup; duplicate: boolean } {
    const agent = this.#requireAgent(agentId);
    if (request.taskId !== null) {
      const task = this.#requireTask(request.taskId);
      if (task.projectId !== agent.projectId) throw conflict("TASK_PROJECT_MISMATCH", "Resume task belongs to another project");
    }
    const sourceKey = `${agentId}:${idempotencyKey}`;
    const prior = this.#store.db.prepare("SELECT * FROM wakeups WHERE reason = 'human_resume' AND source_key = ?").get(sourceKey);
    if (prior) {
      if (stringValue(prior, "detail") !== request.reason || nullableString(prior, "task_id") !== request.taskId) {
        throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key was used for another resume");
      }
      return { wakeup: wakeupFromRow(prior), duplicate: true };
    }
    const now = exactNow(this.#config.now);
    let wakeupId = "";
    this.#store.transaction(() => {
      wakeupId = this.#insertWakeup(
        agent.projectId,
        agentId,
        "human_resume",
        sourceKey,
        request.taskId,
        null,
        request.reason,
        now,
      );
      this.#insertEvent(agent.projectId, request.taskId, { type: "human", id: this.#config.humanPrincipal }, "agent_resumed", {
        agentId,
        wakeupId,
      }, now);
    });
    this.#wakeupEvents.emit(agentId);
    return { wakeup: wakeupFromRow(this.#store.db.prepare("SELECT * FROM wakeups WHERE wakeup_id = ?").get(wakeupId)!), duplicate: false };
  }

  interruptAgent(
    agentId: string,
    request: InterruptAgentRequest,
    idempotencyKey: string,
  ): { interrupt: AgentInterrupt; duplicate: boolean } {
    const agent = this.#requireAgent(agentId);
    const hash = sha256({ action: "interrupt_agent", agentId, request });
    const prior = this.#store.db.prepare("SELECT * FROM interrupts WHERE agent_id = ? AND idempotency_key = ?").get(agentId, idempotencyKey);
    if (prior) {
      if (stringValue(prior, "request_hash") !== hash) throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key was used for another interrupt");
      return { interrupt: interruptFromRow(prior), duplicate: true };
    }
    const active = this.#store.db.prepare("SELECT run_id FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
    const runId = active ? stringValue(active, "run_id") : null;
    const now = exactNow(this.#config.now);
    const interruptId = randomUUID();
    this.#store.transaction(() => {
      this.#store.db.prepare(`
        INSERT INTO interrupts(
          interrupt_id, project_id, agent_id, run_id, idempotency_key, request_hash, reason, requested_by, requested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(interruptId, agent.projectId, agentId, runId, idempotencyKey, hash, request.reason, this.#config.humanPrincipal, now);
      this.#insertEvent(agent.projectId, null, { type: "human", id: this.#config.humanPrincipal }, "agent_interrupt_requested", {
        interruptId,
        agentId,
        runId,
        reason: request.reason,
      }, now);
    });
    const interrupt = interruptFromRow(this.#store.db.prepare("SELECT * FROM interrupts WHERE interrupt_id = ?").get(interruptId)!);
    if (runId !== null) this.#interruptEvents.emit(runId);
    return { interrupt, duplicate: false };
  }

  async waitForRunInterrupts(
    runId: string,
    agentId: string,
    after: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<RunInterruptBatch | null> {
    this.#requireRun(runId, agentId, null, false);
    const immediate = this.#interruptBatch(runId, after);
    if (immediate.items.length > 0 || waitMs === 0) return immediate.items.length > 0 ? immediate : null;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        if (timer) clearTimeout(timer);
        this.#interruptEvents.off(runId, done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.#interruptEvents.once(runId, done);
      signal.addEventListener("abort", done, { once: true });
      timer = setTimeout(done, waitMs);
      timer.unref();
    });
    if (signal.aborted) return null;
    const batch = this.#interruptBatch(runId, after);
    return batch.items.length > 0 ? batch : null;
  }

  claimRun(agentId: string, request: ClaimRunRequest): ClaimRunResult | null {
    const agent = this.#requireAgent(agentId);
    const requestHash = sha256({ action: "claim_run", agentId, request });
    const prior = this.#store.db.prepare("SELECT * FROM runs WHERE agent_id = ? AND claim_id = ?").get(agentId, request.claimId);
    if (prior) {
      if (stringValue(prior, "claim_request_hash") !== requestHash) throw conflict("CLAIM_ID_CONFLICT", "claimId was used with another cursor");
      return this.#claimResult(runFromRow(prior), request.messageCursor ?? 0);
    }
    const existing = this.#store.db.prepare("SELECT run_id FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
    if (existing) throw conflict("AGENT_RUN_ACTIVE", "Agent already has an active run");
    const wakeupRow = this.#store.db.prepare(`
      SELECT * FROM wakeups WHERE agent_id = ? AND claimed_at IS NULL ORDER BY created_at, wakeup_id LIMIT 1
    `).get(agentId);
    if (!wakeupRow) return null;
    const wakeup = wakeupFromRow(wakeupRow);
    const runId = randomUUID();
    const now = exactNow(this.#config.now);
    this.#store.transaction(() => {
      const activeInside = this.#store.db.prepare("SELECT 1 FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
      if (activeInside) throw conflict("AGENT_RUN_ACTIVE", "Agent already has an active run");
      this.#store.db.prepare(`
        INSERT INTO runs(run_id, claim_id, claim_request_hash, project_id, agent_id, wakeup_id, task_id, status, started_at, ended_at, result)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL)
      `).run(runId, request.claimId, requestHash, agent.projectId, agentId, wakeup.wakeupId, wakeup.taskId, now);
      const claim = this.#store.db.prepare(`
        UPDATE wakeups SET claimed_at = ?, run_id = ? WHERE wakeup_id = ? AND claimed_at IS NULL
      `).run(now, runId, wakeup.wakeupId);
      if (Number(claim.changes) !== 1) throw conflict("WAKEUP_ALREADY_CLAIMED", "Wakeup was already claimed");
      if (wakeup.taskId !== null) {
        const taskRow = this.#store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(wakeup.taskId);
        if (!taskRow) throw new Error("TASK_BOARD_DATABASE_CORRUPT:wakeup_task");
        const task = taskFromRow(taskRow);
        if (task.assignedAgentId !== agentId) {
          throw conflict("WAKEUP_TASK_NOT_ASSIGNED", "Wakeup task is no longer assigned to this agent");
        }
        if (task.endedAt !== null) throw conflict("WAKEUP_TASK_TERMINAL", "Wakeup task is already terminal");
        if (task.status === "queued" || task.status === "blocked") {
          const started = this.#store.db.prepare(`
            UPDATE tasks
            SET status = 'in_progress', started_at = COALESCE(started_at, ?), version = version + 1, updated_at = ?
            WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND status IN ('queued', 'blocked') AND ended_at IS NULL
          `).run(now, now, task.taskId, agentId, task.version);
          if (Number(started.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Task changed while its run was starting");
          this.#insertEvent(task.projectId, task.taskId, { type: "agent", id: agentId }, "task_run_started", {
            runId,
            previousStatus: task.status,
            status: "in_progress",
            version: task.version + 1,
          }, now);
        }
      }
      this.#insertEvent(agent.projectId, wakeup.taskId, { type: "agent", id: agentId }, "agent_run_claimed", {
        runId,
        claimId: request.claimId,
        wakeupId: wakeup.wakeupId,
        wakeReason: wakeup.reason,
      }, now);
    });
    return this.#claimResult(runFromRow(this.#store.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId)!), request.messageCursor ?? 0);
  }

  async waitToClaimRun(
    agentId: string,
    request: ClaimRunRequest,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<ClaimRunResult | null> {
    const immediate = this.claimRun(agentId, request);
    if (immediate !== null || waitMs === 0) return immediate;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        if (timer) clearTimeout(timer);
        this.#wakeupEvents.off(agentId, done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.#wakeupEvents.once(agentId, done);
      signal.addEventListener("abort", done, { once: true });
      timer = setTimeout(done, waitMs);
      timer.unref();
    });
    if (signal.aborted) return null;
    return this.claimRun(agentId, request);
  }

  settleRun(runId: string, agentId: string, request: SettleRunRequest): { run: AgentRun; duplicate: boolean } {
    const row = this.#store.db.prepare("SELECT * FROM runs WHERE run_id = ? AND agent_id = ?").get(runId, agentId);
    if (!row) throw new TaskBoardError(404, "RUN_NOT_FOUND", "Run was not found");
    const current = runFromRow(row);
    if (current.status !== "active") {
      if (current.status === request.outcome && current.result === request.result) return { run: current, duplicate: true };
      throw conflict("RUN_NOT_ACTIVE", "Run is already settled");
    }
    const now = exactNow(this.#config.now);
    this.#store.transaction(() => {
      const update = this.#store.db.prepare(`
        UPDATE runs SET status = ?, ended_at = ?, result = ? WHERE run_id = ? AND agent_id = ? AND status = 'active'
      `).run(request.outcome, now, request.result, runId, agentId);
      if (Number(update.changes) !== 1) throw conflict("RUN_NOT_ACTIVE", "Run is already settled");
      if (current.taskId !== null) {
        const taskRow = this.#store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(current.taskId);
        if (!taskRow) throw new Error("TASK_BOARD_DATABASE_CORRUPT:run_task");
        const task = taskFromRow(taskRow);
        if (task.assignedAgentId === agentId && task.endedAt === null) {
          const nextStatus: TaskStatus = request.outcome === "completed" ? "completed" : "blocked";
          if (task.status !== nextStatus || request.outcome === "completed") {
            const lifecycle = request.outcome === "completed"
              ? this.#store.db.prepare(`
                  UPDATE tasks
                  SET status = 'completed', ended_at = ?, result = ?, version = version + 1, updated_at = ?
                  WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND ended_at IS NULL
                `).run(now, request.result, now, task.taskId, agentId, task.version)
              : this.#store.db.prepare(`
                  UPDATE tasks
                  SET status = 'blocked', ended_at = NULL, result = NULL, version = version + 1, updated_at = ?
                  WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND ended_at IS NULL
                `).run(now, task.taskId, agentId, task.version);
            if (Number(lifecycle.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Task changed while its run was settling");
            this.#insertEvent(task.projectId, task.taskId, { type: "agent", id: agentId }, "task_run_settled", {
              runId,
              outcome: request.outcome,
              previousStatus: task.status,
              status: nextStatus,
              version: task.version + 1,
            }, now);
          }
        }
      }
      this.#insertEvent(current.projectId, current.taskId, { type: "agent", id: agentId }, "agent_run_settled", {
        runId,
        outcome: request.outcome,
      }, now);
    });
    return { run: runFromRow(this.#store.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId)!), duplicate: false };
  }

  snapshot(projectId: string): BoardSnapshot {
    const project = this.#requireProject(projectId);
    return Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      project,
      agents: Object.freeze(this.#store.db.prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY created_at, agent_id").all(projectId).map((row) => this.#agentFromRow(row))),
      tasks: Object.freeze(this.#store.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, task_id").all(projectId).map(taskFromRow)),
      openQuestions: Object.freeze(this.#store.db.prepare("SELECT * FROM questions WHERE project_id = ? AND status = 'open' ORDER BY asked_at, question_id").all(projectId).map(questionFromRow)),
      recentQuestions: Object.freeze(this.#store.db.prepare("SELECT * FROM questions WHERE project_id = ? ORDER BY asked_at DESC, question_id DESC LIMIT 100").all(projectId).map(questionFromRow)),
      recentRuns: Object.freeze(this.#store.db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC, run_id DESC LIMIT 100").all(projectId).map(runFromRow)),
      recentInterrupts: Object.freeze(this.#store.db.prepare("SELECT * FROM interrupts WHERE project_id = ? ORDER BY sequence DESC LIMIT 100").all(projectId).map(interruptFromRow)),
      recentEvents: Object.freeze(this.#store.db.prepare("SELECT * FROM task_events WHERE project_id = ? ORDER BY sequence DESC LIMIT 200").all(projectId).map(eventFromRow)),
    });
  }

  listMessages(taskId: string, after = 0): readonly TaskMessage[] {
    this.#requireTask(taskId);
    return Object.freeze(this.#store.db.prepare(`
      SELECT * FROM task_messages WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT 200
    `).all(taskId, after).map(messageFromRow));
  }

  requireTask(taskId: string): BoardTask {
    return this.#requireTask(taskId);
  }

  close(): void {
    this.#interruptEvents.removeAllListeners();
    this.#wakeupEvents.removeAllListeners();
    this.#store.close();
  }

  #appendMessage(
    task: BoardTask,
    actor: Actor,
    clientEventId: string,
    runId: string | null,
    kind: TaskMessage["kind"],
    body: string,
  ): TaskMessage {
    const hash = sha256({ action: "append_task_message", taskId: task.taskId, actor, clientEventId, runId, kind, body });
    const prior = this.#store.db.prepare(`
      SELECT * FROM task_messages WHERE actor_type = ? AND actor_id = ? AND client_event_id = ?
    `).get(actor.type, actor.id, clientEventId);
    if (prior) {
      if (stringValue(prior, "request_hash") !== hash) throw conflict("CLIENT_EVENT_CONFLICT", "clientEventId was used for another message");
      return messageFromRow(prior);
    }
    if (actor.type === "agent") {
      if (runId === null) throw new Error("TASK_BOARD_AGENT_MESSAGE_RUN_MISSING");
      this.#requireRun(runId, actor.id, task.taskId, true);
    }
    const messageId = randomUUID();
    const now = exactNow(this.#config.now);
    this.#store.transaction(() => {
      this.#store.db.prepare(`
        INSERT INTO task_messages(
          message_id, project_id, task_id, run_id, actor_type, actor_id, client_event_id,
          request_hash, kind, body, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(messageId, task.projectId, task.taskId, runId, actor.type, actor.id, clientEventId, hash, kind, body, now);
      this.#insertEvent(task.projectId, task.taskId, actor, "task_message_appended", { messageId, kind }, now);
    });
    return messageFromRow(this.#store.db.prepare("SELECT * FROM task_messages WHERE message_id = ?").get(messageId)!);
  }

  #claimResult(run: AgentRun, cursor: number): ClaimRunResult {
    const wakeup = wakeupFromRow(this.#store.db.prepare("SELECT * FROM wakeups WHERE wakeup_id = ?").get(run.wakeupId)!);
    const task = wakeup.taskId === null ? null : this.#requireTask(wakeup.taskId);
    const messages = task === null ? [] : this.#store.db.prepare(`
      SELECT * FROM task_messages WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT 100
    `).all(task.taskId, cursor).map(messageFromRow);
    const messageCursor = messages.at(-1)?.sequence ?? cursor;
    const triggerQuestion = wakeup.questionId === null
      ? null
      : questionFromRow(this.#store.db.prepare("SELECT * FROM questions WHERE question_id = ?").get(wakeup.questionId)!);
    const parentTask = task?.parentTaskId ? this.#requireTask(task.parentTaskId) : null;
    const project = this.#requireProject(run.projectId);
    return Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      run,
      wakeup,
      task,
      context: Object.freeze({
        agent: this.#requireAgent(run.agentId),
        projectMemory: Object.freeze({ projectId: project.projectId, name: project.name, description: project.description }),
        parentTask,
        acceptanceCriteria: task?.acceptanceCriteria ?? null,
        workspaceRefs: task?.workspaceRefs ?? Object.freeze([]),
        messageCursor,
        messages: Object.freeze(messages),
        triggerQuestion,
        openQuestions: Object.freeze(this.#store.db.prepare(`
          SELECT * FROM questions WHERE agent_id = ? AND status = 'open' ORDER BY asked_at, question_id LIMIT 50
        `).all(run.agentId).map(questionFromRow)),
      }),
    });
  }

  #interruptBatch(runId: string, after: number): RunInterruptBatch {
    const items = this.#store.db.prepare(`
      SELECT * FROM interrupts WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT 100
    `).all(runId, after).map(interruptFromRow);
    return Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      items: Object.freeze(items),
      cursor: items.at(-1)?.sequence ?? after,
    });
  }

  #agentFromRow(row: Row): AgentProfile {
    const agentId = stringValue(row, "agent_id");
    const active = this.#store.db.prepare("SELECT run_id FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
    let status: AgentProfile["status"];
    if (active) {
      const interrupted = this.#store.db.prepare("SELECT 1 FROM interrupts WHERE run_id = ? LIMIT 1").get(stringValue(active, "run_id"));
      status = interrupted ? "interrupting" : "running";
    } else if (this.#store.db.prepare("SELECT 1 FROM wakeups WHERE agent_id = ? AND claimed_at IS NULL LIMIT 1").get(agentId)) {
      status = "ready";
    } else if (this.#store.db.prepare("SELECT 1 FROM questions WHERE agent_id = ? AND status = 'open' LIMIT 1").get(agentId)) {
      status = "waiting_for_human";
    } else {
      status = "idle";
    }
    return Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      agentId,
      projectId: stringValue(row, "project_id"),
      role: stringValue(row, "role") as AgentRole,
      area: stringValue(row, "area"),
      mission: stringValue(row, "mission"),
      model: stringValue(row, "model"),
      status,
      createdAt: stringValue(row, "created_at"),
    });
  }

  #requireProject(projectId: string): Project {
    const row = this.#store.db.prepare("SELECT * FROM projects WHERE project_id = ?").get(projectId);
    if (!row) throw new TaskBoardError(404, "PROJECT_NOT_FOUND", "Project was not found");
    return projectFromRow(row);
  }

  #requireAgent(agentId: string): AgentProfile {
    const row = this.#store.db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId);
    if (!row) throw new TaskBoardError(404, "AGENT_NOT_FOUND", "Agent was not found");
    return this.#agentFromRow(row);
  }

  #requireTask(taskId: string): BoardTask {
    const row = this.#store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
    if (!row) throw new TaskBoardError(404, "TASK_NOT_FOUND", "Task was not found");
    return taskFromRow(row);
  }

  #requireRun(runId: string, agentId: string, taskId: string | null, active: boolean): AgentRun {
    const row = this.#store.db.prepare("SELECT * FROM runs WHERE run_id = ? AND agent_id = ?").get(runId, agentId);
    if (!row) throw new TaskBoardError(404, "RUN_NOT_FOUND", "Run was not found");
    const run = runFromRow(row);
    if (active && run.status !== "active") throw conflict("RUN_NOT_ACTIVE", "Run is no longer active");
    if (taskId !== null) {
      const wake = this.#store.db.prepare("SELECT task_id FROM wakeups WHERE wakeup_id = ?").get(run.wakeupId);
      if (!wake || nullableString(wake, "task_id") !== taskId) throw conflict("RUN_TASK_MISMATCH", "Run is not bound to this task");
    }
    return run;
  }

  #requireActiveRun(agentId: string, taskId: string): AgentRun {
    const row = this.#store.db.prepare("SELECT * FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
    if (!row) throw conflict("RUN_NOT_ACTIVE", "Agent has no active run");
    return this.#requireRun(stringValue(row, "run_id"), agentId, taskId, true);
  }

  #assertAssignment(projectId: string, agentId: string, role: AgentRole): void {
    const agent = this.#requireAgent(agentId);
    if (agent.projectId !== projectId) throw conflict("AGENT_PROJECT_MISMATCH", "Assigned agent belongs to another project");
    if (agent.role !== role) throw conflict("AGENT_ROLE_MISMATCH", "Assigned role does not match the fixed agent profile");
  }

  #insertWakeup(
    projectId: string,
    agentId: string,
    reason: Wakeup["reason"],
    sourceKey: string,
    taskId: string | null,
    questionId: string | null,
    detail: string,
    now: string,
  ): string {
    const wakeupId = randomUUID();
    this.#store.db.prepare(`
      INSERT INTO wakeups(
        wakeup_id, project_id, agent_id, reason, source_key, task_id, question_id,
        detail, created_by, created_at, claimed_at, run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      wakeupId,
      projectId,
      agentId,
      reason,
      sourceKey,
      taskId,
      questionId,
      detail,
      this.#config.humanPrincipal,
      now,
    );
    return wakeupId;
  }

  #insertEvent(
    projectId: string,
    taskId: string | null,
    actor: Actor | Readonly<{ type: "system"; id: string }>,
    eventType: string,
    data: Readonly<Record<string, unknown>>,
    now: string,
  ): void {
    this.#store.db.prepare(`
      INSERT INTO task_events(event_id, project_id, task_id, actor_type, actor_id, event_type, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), projectId, taskId, actor.type, actor.id, eventType, canonicalJson(data), now);
  }
}
