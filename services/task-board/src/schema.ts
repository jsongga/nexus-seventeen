import type {
  AgentRole,
  AnswerHumanQuestionRequest,
  ClaimRunRequest,
  CreateAgentRequest,
  CreateHumanQuestionRequest,
  CreateHumanTaskMessageRequest,
  CreateProjectRequest,
  CreateTaskMessageRequest,
  CreateTaskRequest,
  InterruptAgentRequest,
  ResumeAgentRequest,
  SettleRunRequest,
  TaskMessageKind,
  TaskStatus,
  UpdateTaskRequest,
} from "@cicada/steward-task-board-contract";
import { TaskBoardError } from "./errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TaskBoardError(400, "INVALID_REQUEST", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${label} has unexpected or missing fields`);
  }
  return value;
}

function allowed(value: unknown, keys: readonly string[], required: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TaskBoardError(400, "INVALID_REQUEST", `${label} must be an object`);
  const permitted = new Set(keys);
  if (Object.keys(value).some((key) => !permitted.has(key)) || required.some((key) => !(key in value))) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${label} has unexpected or missing fields`);
  }
  return value;
}

export function parseIdentifier(value: unknown, field: string, maximum = 128): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
  ) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  return value;
}

function text(value: unknown, field: string, maximum = 8_000): string {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)
  ) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  return value.trim();
}

function token(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "token is invalid");
  }
  return value;
}

function role(value: unknown, field = "role"): AgentRole {
  if (value !== "engineer" && value !== "manager" && value !== "verifier") {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  return value;
}

function nullableRole(value: unknown, field: string): AgentRole | null {
  return value === null ? null : role(value, field);
}

function nullableIdentifier(value: unknown, field: string): string | null {
  return value === null ? null : parseIdentifier(value, field);
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "version must be a positive safe integer");
  }
  return Number(value);
}

function expectedMinutes(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 15 || Number(value) > 10_080 || Number(value) % 15 !== 0) {
    throw new TaskBoardError(
      400,
      "INVALID_EXPECTED_AGENT_MINUTES",
      "expectedAgentMinutes must be a 15-minute interval between 15 and 10080",
    );
  }
  return Number(value);
}

function taskStatus(value: unknown): TaskStatus {
  if (
    value !== "backlog" &&
    value !== "queued" &&
    value !== "in_progress" &&
    value !== "blocked" &&
    value !== "completed" &&
    value !== "failed" &&
    value !== "cancelled"
  ) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "status is invalid");
  }
  return value;
}

function refs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "workspaceRefs must be an array with at most 32 entries");
  }
  const parsed = value.map((item, index) => text(item, `workspaceRefs[${index}]`, 512));
  if (new Set(parsed).size !== parsed.length) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "workspaceRefs contains a duplicate");
  }
  return Object.freeze(parsed);
}

export function parseCreateProject(value: unknown): CreateProjectRequest {
  const item = exact(value, ["name", "description"], "Project");
  return Object.freeze({ name: text(item.name, "name", 160), description: text(item.description, "description", 8_000) });
}

export function parseCreateAgent(value: unknown): CreateAgentRequest {
  const item = exact(value, ["agentId", "role", "area", "mission", "model", "token"], "Agent profile");
  return Object.freeze({
    agentId: parseIdentifier(item.agentId, "agentId"),
    role: role(item.role),
    area: text(item.area, "area", 256),
    mission: text(item.mission, "mission", 4_000),
    model: parseIdentifier(item.model, "model", 256),
    token: token(item.token),
  });
}

export function parseCreateTask(value: unknown): CreateTaskRequest {
  const item = exact(value, [
    "parentTaskId",
    "title",
    "objective",
    "acceptanceCriteria",
    "workspaceRefs",
    "assignedAgentId",
    "assignedRole",
    "expectedAgentMinutes",
  ], "Task");
  const assignedAgentId = nullableIdentifier(item.assignedAgentId, "assignedAgentId");
  const assignedRole = nullableRole(item.assignedRole, "assignedRole");
  if ((assignedAgentId === null) !== (assignedRole === null)) {
    throw new TaskBoardError(400, "INVALID_ASSIGNMENT", "assignedAgentId and assignedRole must both be set or both be null");
  }
  return Object.freeze({
    parentTaskId: nullableIdentifier(item.parentTaskId, "parentTaskId"),
    title: text(item.title, "title", 240),
    objective: text(item.objective, "objective", 8_000),
    acceptanceCriteria: text(item.acceptanceCriteria, "acceptanceCriteria", 8_000),
    workspaceRefs: refs(item.workspaceRefs),
    assignedAgentId,
    assignedRole,
    expectedAgentMinutes: expectedMinutes(item.expectedAgentMinutes),
  });
}

export function parseUpdateTask(value: unknown): UpdateTaskRequest {
  const item = allowed(value, [
    "version",
    "title",
    "objective",
    "acceptanceCriteria",
    "workspaceRefs",
    "assignedAgentId",
    "assignedRole",
    "expectedAgentMinutes",
    "status",
    "result",
  ], ["version"], "Task update");
  if (Object.keys(item).length === 1) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Task update contains no changes");
  }
  if (("assignedAgentId" in item) !== ("assignedRole" in item)) {
    throw new TaskBoardError(400, "INVALID_ASSIGNMENT", "Assignment fields must be updated together");
  }
  const result: {
    version: number;
    title?: string;
    objective?: string;
    acceptanceCriteria?: string;
    workspaceRefs?: readonly string[];
    assignedAgentId?: string | null;
    assignedRole?: AgentRole | null;
    expectedAgentMinutes?: number;
    status?: TaskStatus;
    result?: string | null;
  } = { version: positiveVersion(item.version) };
  if ("title" in item) result.title = text(item.title, "title", 240);
  if ("objective" in item) result.objective = text(item.objective, "objective", 8_000);
  if ("acceptanceCriteria" in item) result.acceptanceCriteria = text(item.acceptanceCriteria, "acceptanceCriteria", 8_000);
  if ("workspaceRefs" in item) result.workspaceRefs = refs(item.workspaceRefs);
  if ("assignedAgentId" in item) {
    result.assignedAgentId = nullableIdentifier(item.assignedAgentId, "assignedAgentId");
    result.assignedRole = nullableRole(item.assignedRole, "assignedRole");
    if ((result.assignedAgentId === null) !== (result.assignedRole === null)) {
      throw new TaskBoardError(400, "INVALID_ASSIGNMENT", "Assignment fields must both be set or both be null");
    }
  }
  if ("expectedAgentMinutes" in item) result.expectedAgentMinutes = expectedMinutes(item.expectedAgentMinutes);
  if ("status" in item) result.status = taskStatus(item.status);
  if ("result" in item) result.result = item.result === null ? null : text(item.result, "result", 16_000);
  return Object.freeze(result);
}

function messageKind(value: unknown, human: boolean): TaskMessageKind {
  if (human) {
    if (value !== "note") throw new TaskBoardError(400, "INVALID_REQUEST", "Human messages must use note kind");
    return value;
  }
  if (value !== "progress" && value !== "proposal" && value !== "result") {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Agent message kind is invalid");
  }
  return value;
}

export function parseAgentMessage(value: unknown): CreateTaskMessageRequest {
  const item = exact(value, ["clientEventId", "kind", "body", "runId"], "Agent task message");
  return Object.freeze({
    clientEventId: parseIdentifier(item.clientEventId, "clientEventId", 256),
    kind: messageKind(item.kind, false),
    body: text(item.body, "body", 16_000),
    runId: parseIdentifier(item.runId, "runId"),
  });
}

export function parseHumanMessage(value: unknown): CreateHumanTaskMessageRequest {
  const item = exact(value, ["clientEventId", "kind", "body"], "Human task message");
  return Object.freeze({
    clientEventId: parseIdentifier(item.clientEventId, "clientEventId", 256),
    kind: messageKind(item.kind, true) as "note",
    body: text(item.body, "body", 16_000),
  });
}

export function parseQuestion(value: unknown): CreateHumanQuestionRequest {
  const item = exact(value, ["clientEventId", "question", "runId"], "Human question");
  return Object.freeze({
    clientEventId: parseIdentifier(item.clientEventId, "clientEventId", 256),
    question: text(item.question, "question", 8_000),
    runId: parseIdentifier(item.runId, "runId"),
  });
}

export function parseAnswer(value: unknown): AnswerHumanQuestionRequest {
  const item = exact(value, ["answer", "version"], "Question answer");
  return Object.freeze({ answer: text(item.answer, "answer", 16_000), version: positiveVersion(item.version) });
}

export function parseResume(value: unknown): ResumeAgentRequest {
  const item = exact(value, ["reason", "taskId"], "Agent resume");
  return Object.freeze({ reason: text(item.reason, "reason", 2_000), taskId: nullableIdentifier(item.taskId, "taskId") });
}

export function parseInterrupt(value: unknown): InterruptAgentRequest {
  const item = exact(value, ["reason"], "Agent interrupt");
  return Object.freeze({ reason: text(item.reason, "reason", 2_000) });
}

export function parseClaim(value: unknown): ClaimRunRequest {
  if (!isRecord(value)) throw new TaskBoardError(400, "INVALID_REQUEST", "Run claim must be an object");
  const keys = Object.keys(value).sort();
  const legacy = keys.length === 2 && keys[0] === "claimId" && keys[1] === "messageCursor";
  const perTask = keys.length === 2 && keys[0] === "claimId" && keys[1] === "messageCursors";
  if (!legacy && !perTask) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Run claim has unexpected or missing fields");
  }
  const claimId = parseIdentifier(value.claimId, "claimId", 256);
  if (legacy) {
    const cursor = value.messageCursor;
    if (cursor !== null && (!Number.isSafeInteger(cursor) || Number(cursor) < 0)) {
      throw new TaskBoardError(400, "INVALID_REQUEST", "messageCursor must be null or a non-negative safe integer");
    }
    return Object.freeze({ claimId, messageCursor: cursor === null ? null : Number(cursor) });
  }
  if (!isRecord(value.messageCursors) || Object.keys(value.messageCursors).length > 256) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "messageCursors must be an object with at most 256 task entries");
  }
  const messageCursors: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [taskId, cursor] of Object.entries(value.messageCursors)) {
    parseIdentifier(taskId, "messageCursors taskId");
    if (!Number.isSafeInteger(cursor) || Number(cursor) < 0) {
      throw new TaskBoardError(400, "INVALID_REQUEST", "messageCursors values must be non-negative safe integers");
    }
    messageCursors[taskId] = Number(cursor);
  }
  return Object.freeze({ claimId, messageCursors: Object.freeze(messageCursors) });
}

export function parseSettle(value: unknown): SettleRunRequest {
  const item = exact(value, ["outcome", "result"], "Run settlement");
  if (item.outcome !== "completed" && item.outcome !== "failed" && item.outcome !== "interrupted") {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Run outcome is invalid");
  }
  return Object.freeze({ outcome: item.outcome, result: text(item.result, "result", 16_000) });
}

export function parseIdempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) {
    throw new TaskBoardError(400, "INVALID_IDEMPOTENCY_KEY", "A valid Idempotency-Key header is required");
  }
  return value;
}
