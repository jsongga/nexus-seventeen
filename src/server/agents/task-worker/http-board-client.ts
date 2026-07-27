import { TASK_BOARD_API_VERSION, type ClaimRunResult } from "#shared/task-board-contract";
import { parseBoundedAgentContext, parseTaskWakeClaim } from "./schema.js";
import type {
  AgentTaskPhase,
  AgentRunInterrupt,
  AppendRunOutputRequest,
  BoundedAgentContext,
  ClaimedAgentRun,
  ClaimNextWakeRequest,
  CreateAgentTaskPhaseRequest,
  SettleAgentRunRequest,
  TaskBoardClient,
  TaskWakeClaim,
  UpdateAgentTaskPhaseRequest,
  UpdateTaskEstimateRequest,
} from "./types.js";

const MAX_AREA_MEMORY_RESULT_CHARACTERS = 1_000;

export class TaskBoardHttpError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string | null) {
    super(message);
    this.name = "TaskBoardHttpError";
  }
}

export interface HttpTaskBoardClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImplementation?: typeof fetch;
}

interface HttpResult {
  readonly status: number;
  readonly body: unknown | null;
}

function checkedUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password ||
    url.search || url.hash || url.pathname !== "/"
  ) {
    throw new Error("Task-board URL must be an HTTP(S) origin without path, credentials, query, or fragment");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) throw new Error("Plaintext task-board HTTP is allowed only on exact loopback hosts");
  return url.toString().replace(/\/$/u, "");
}

function checkedToken(value: string): string {
  if (value.length < 32 || value.length > 512 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Task-board agent token is invalid");
  }
  return value;
}

function integer(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} is invalid`);
  return parsed;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const item = object(value, label);
  const actual = Object.keys(item).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
  return item;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const parsed = new Date(typeof value === "string" ? value : Number.NaN);
  if (typeof value !== "string" || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid`);
  return Number(value);
}

function positive(value: unknown, label: string): number {
  const parsed = nonNegative(value, label);
  if (parsed === 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function estimateMinutes(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 15 || Number(value) > 10_080 || Number(value) % 15 !== 0) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

function phaseStage(value: unknown, label: string): AgentTaskPhase["stage"] {
  if (
    value !== "research" && value !== "planning" && value !== "execution" &&
    value !== "testing" && value !== "review" && value !== "done"
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function phaseStatus(value: unknown, label: string): AgentTaskPhase["status"] {
  if (
    value !== "pending" && value !== "in_progress" && value !== "blocked" &&
    value !== "completed" && value !== "failed"
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function taskPhase(value: unknown, projectId: string, taskId: string, label: string): AgentTaskPhase {
  const item = exact(value, [
    "apiVersion", "phaseId", "projectId", "taskId", "title", "stage", "status", "parallelGroup", "orderKey",
    "startedAt", "endedAt", "version", "createdAt", "updatedAt",
  ], label);
  if (item.apiVersion !== TASK_BOARD_API_VERSION || item.projectId !== projectId || item.taskId !== taskId) {
    throw new Error(`${label} binding is invalid`);
  }
  const stage = phaseStage(item.stage, `${label}.stage`);
  const status = phaseStatus(item.status, `${label}.status`);
  if (stage === "done" && status !== "completed") throw new Error(`${label} completion state is invalid`);
  if (item.parallelGroup !== null) id(item.parallelGroup, `${label}.parallelGroup`);
  if (item.startedAt !== null) timestamp(item.startedAt, `${label}.startedAt`);
  if (item.endedAt !== null) timestamp(item.endedAt, `${label}.endedAt`);
  timestamp(item.createdAt, `${label}.createdAt`);
  timestamp(item.updatedAt, `${label}.updatedAt`);
  return Object.freeze({
    phaseId: id(item.phaseId, `${label}.phaseId`),
    title: bounded(item.title, `${label}.title`, 240),
    stage,
    status,
    parallelGroup: item.parallelGroup as string | null,
    orderKey: nonNegative(item.orderKey, `${label}.orderKey`),
    version: positive(item.version, `${label}.version`),
  });
}

function bounded(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  const clean = value.trim();
  return clean.length <= maximum ? clean : `${clean.slice(0, Math.max(1, maximum - 16)).trimEnd()}\n[truncated]`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorCode(value: unknown): string | null {
  try {
    const error = object(object(value, "response").error, "error");
    return typeof error.code === "string" ? error.code : null;
  } catch {
    return null;
  }
}

async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && !/^(?:0|[1-9]\d*)$/u.test(declared)) {
    await response.body?.cancel();
    throw new TaskBoardHttpError("Task-board response Content-Length is invalid", response.status, null);
  }
  if (declared !== null && Number(declared) > maximum) {
    await response.body?.cancel();
    throw new TaskBoardHttpError("Task-board response exceeds its size limit", response.status, null);
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    await response.body?.cancel();
    throw new TaskBoardHttpError("Task-board response is not JSON", response.status, null);
  }
  if (!response.body) throw new TaskBoardHttpError("Task-board response is empty", response.status, null);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new TaskBoardHttpError("Task-board response exceeds its size limit", response.status, null);
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new TaskBoardHttpError("Task-board response is not valid JSON", response.status, null);
  }
}

class JsonClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #maximum: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpTaskBoardClientOptions) {
    this.#baseUrl = checkedUrl(options.baseUrl);
    this.#token = checkedToken(options.token);
    this.#timeoutMs = integer(options.timeoutMs, 10_000, 100, 60_000, "timeoutMs");
    this.#maximum = integer(options.maxResponseBytes, 1024 * 1024, 1_024, 16 * 1024 * 1024, "maxResponseBytes");
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
  }

  async request(method: "GET" | "POST" | "PATCH", path: string, body: unknown | null, signal?: AbortSignal, longPoll = false): Promise<HttpResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), longPoll ? 35_000 : this.#timeoutMs);
    timeout.unref();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#token}`,
          ...(body === null ? {} : { "content-type": "application/json" }),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (response.status === 204) {
        await response.body?.cancel();
        return { status: 204, body: null };
      }
      const parsed = await boundedJson(response, this.#maximum);
      if (!response.ok) {
        throw new TaskBoardHttpError(`Task-board request failed with HTTP ${response.status}`, response.status, errorCode(parsed));
      }
      return { status: response.status, body: parsed };
    } catch (error) {
      if (error instanceof TaskBoardHttpError) throw error;
      throw new TaskBoardHttpError(signal?.aborted ? "Task-board request was canceled" : "Task-board request failed", null, null);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function asClaimResult(value: unknown): ClaimRunResult {
  const result = exact(value, ["apiVersion", "run", "wakeup", "task", "context"], "Claim result");
  if (result.apiVersion !== TASK_BOARD_API_VERSION) throw new Error("Claim result API version is invalid");
  const run = exact(result.run, [
    "apiVersion", "runId", "claimId", "projectId", "agentId", "wakeupId", "taskId", "status", "startedAt", "endedAt", "result",
  ], "Claim run");
  const wakeup = exact(result.wakeup, [
    "apiVersion", "wakeupId", "projectId", "agentId", "reason", "taskId", "questionId", "detail", "createdBy",
    "createdAt", "claimedAt", "runId",
  ], "Claim wakeup");
  const context = exact(result.context, [
    "agent", "projectMemory", "areaMemory", "parentTask", "parentMessages", "acceptanceCriteria", "workspaceRefs",
    "messageCursor", "messages", "triggerQuestion", "openQuestions", "workflow",
  ], "Claim context");
  if (
    run.apiVersion !== TASK_BOARD_API_VERSION || wakeup.apiVersion !== TASK_BOARD_API_VERSION ||
    run.status !== "active" || run.endedAt !== null || run.result !== null ||
    wakeup.reason !== "human_assignment" && wakeup.reason !== "human_answer" &&
    wakeup.reason !== "human_resume" && wakeup.reason !== "workflow_handoff"
  ) {
    throw new Error("Claim run or wakeup state is invalid");
  }
  id(run.runId, "run.runId");
  id(run.claimId, "run.claimId");
  id(run.projectId, "run.projectId");
  id(run.agentId, "run.agentId");
  id(run.wakeupId, "run.wakeupId");
  if (run.taskId !== null) id(run.taskId, "run.taskId");
  timestamp(run.startedAt, "run.startedAt");
  id(wakeup.wakeupId, "wakeup.wakeupId");
  id(wakeup.projectId, "wakeup.projectId");
  id(wakeup.agentId, "wakeup.agentId");
  if (wakeup.taskId !== null) id(wakeup.taskId, "wakeup.taskId");
  if (wakeup.questionId !== null) id(wakeup.questionId, "wakeup.questionId");
  timestamp(wakeup.createdAt, "wakeup.createdAt");
  timestamp(wakeup.claimedAt, "wakeup.claimedAt");
  if (
    run.wakeupId !== wakeup.wakeupId || run.projectId !== wakeup.projectId || run.agentId !== wakeup.agentId ||
    run.taskId !== wakeup.taskId ||
    wakeup.runId !== run.runId || wakeup.claimedAt === null
  ) {
    throw new Error("Claim run and wakeup binding is invalid");
  }
  if (
    !Array.isArray(context.workspaceRefs) || !Array.isArray(context.areaMemory) || !Array.isArray(context.messages) ||
    !Array.isArray(context.parentMessages) || !Array.isArray(context.openQuestions)
  ) {
    throw new Error("Claim context collections are invalid");
  }
  nonNegative(context.messageCursor, "context.messageCursor");
  return value as ClaimRunResult;
}

function questionProjection(value: ClaimRunResult["context"]["triggerQuestion"], requireAnswer: boolean): BoundedAgentContext["triggerQuestion"] {
  if (value === null) return null;
  if (requireAnswer && (value.status !== "answered" || value.answer === null)) {
    throw new Error("Human-answer wake omitted its answered trigger question");
  }
  if (value.answer === null) return null;
  return {
    questionId: id(value.questionId, "triggerQuestion.questionId"),
    question: bounded(value.question, "triggerQuestion.question", 2_000),
    answer: bounded(value.answer, "triggerQuestion.answer", 4_000),
  };
}

function mapContext(result: ClaimRunResult, requestedCursor: number | null): BoundedAgentContext | null {
  const { run, wakeup, task, context } = result;
  if (wakeup.taskId === null) {
    if (task !== null) throw new Error("Taskless wake included a task");
    return null;
  }
  if (
    task === null || task.taskId !== wakeup.taskId || task.projectId !== run.projectId ||
    task.assignedAgentId !== run.agentId || context.agent.agentId !== run.agentId ||
    context.agent.projectId !== run.projectId || context.projectMemory.projectId !== run.projectId ||
    context.acceptanceCriteria !== task.acceptanceCriteria || !sameStrings(context.workspaceRefs, task.workspaceRefs)
  ) {
    throw new Error("Claim task and bounded context binding is invalid");
  }
  const messages = context.messages.slice(-12).map((message) => ({
    messageId: id(message.messageId, "message.messageId"),
    cursor: nonNegative(message.sequence, "message.sequence"),
    author: message.actorType,
    body: bounded(message.body, "message.body", 2_000),
    createdAt: timestamp(message.createdAt, "message.createdAt"),
  }));
  const areaMemory = context.areaMemory.map((memory, index) => ({
    taskId: id(memory.taskId, "areaMemory[" + index + "].taskId"),
    title: bounded(memory.title, "areaMemory[" + index + "].title", 512),
    result: bounded(memory.result, "areaMemory[" + index + "].result", MAX_AREA_MEMORY_RESULT_CHARACTERS),
    endedAt: timestamp(memory.endedAt, "areaMemory[" + index + "].endedAt"),
  }));
  if (areaMemory.some((memory) => memory.taskId === task.taskId)) {
    throw new Error("Claim area memory includes the current task");
  }
  const parentEvidence = context.parentTask === null
    ? null
    : {
        taskId: id(context.parentTask.taskId, "parent.taskId"),
        title: bounded(context.parentTask.title, "parent.title", 512),
        objective: bounded(context.parentTask.objective, "parent.objective", 8_000),
        acceptanceCriteria: bounded(context.parentTask.acceptanceCriteria, "parent.acceptanceCriteria", 4_000),
        status: bounded(context.parentTask.status, "parent.status", 64),
        assignedAgentId: context.parentTask.assignedAgentId === null
          ? null
          : id(context.parentTask.assignedAgentId, "parent.assignedAgentId"),
        workspaceRefs: context.parentTask.workspaceRefs.map((reference, index) =>
          bounded(reference, `parent.workspaceRefs[${index}]`, 512)),
        startedAt: context.parentTask.startedAt === null ? null : timestamp(context.parentTask.startedAt, "parent.startedAt"),
        endedAt: context.parentTask.endedAt === null ? null : timestamp(context.parentTask.endedAt, "parent.endedAt"),
        result: context.parentTask.result === null ? null : bounded(context.parentTask.result, "parent.result", 4_000),
        messages: context.parentMessages.slice(-12).map((message, index) => {
          if (
            message.taskId !== context.parentTask?.taskId || message.projectId !== run.projectId ||
            message.actorType !== "human" && message.actorType !== "agent"
          ) {
            throw new Error(`Parent message ${index} is not bound to the parent task`);
          }
          return {
            messageId: id(message.messageId, `parent.messages[${index}].messageId`),
            author: message.actorType,
            kind: message.kind,
            body: bounded(message.body, `parent.messages[${index}].body`, 2_000),
            createdAt: timestamp(message.createdAt, `parent.messages[${index}].createdAt`),
          };
        }),
      };
  if (context.parentTask === null && context.parentMessages.length !== 0) {
    throw new Error("Claim context included parent messages without a parent task");
  }
  if (context.parentTask !== null && context.parentTask.taskId !== task.parentTaskId) {
    throw new Error("Claim context parent does not match the task parent");
  }
  const internal = {
    apiVersion: 1 as const,
    projectId: run.projectId,
    agentId: run.agentId,
    taskId: task.taskId,
    mission: {
      role: context.agent.role,
      area: bounded(context.agent.area, "agent.area", 256),
      mission: bounded(context.agent.mission, "agent.mission", 2_000),
    },
    projectMemory: bounded(`${context.projectMemory.name}\n\n${context.projectMemory.description}`, "projectMemory", 4_000),
    task: {
      kind: task.kind,
      requiredRole: task.requiredRole,
      title: bounded(task.title, "task.title", 512),
      objective: bounded(task.objective, "task.objective", 8_000),
      acceptanceCriteria: bounded(task.acceptanceCriteria, "task.acceptanceCriteria", 4_000),
      version: positive(task.version, "task.version"),
      expectedAgentMinutes: estimateMinutes(task.expectedAgentMinutes, "task.expectedAgentMinutes"),
      phases: (() => {
        if (!Array.isArray(task.phases)) throw new Error("Claim task phases are invalid");
        const parsed = task.phases.map((phase, index) => taskPhase(
          phase,
          run.projectId,
          task.taskId,
          `task.phases[${index}]`,
        ));
        if (parsed.length <= 64) return parsed;
        const selected = new Set<number>();
        for (let index = parsed.length - 1; index >= 0 && selected.size < 64; index -= 1) {
          const phase = parsed[index];
          if (phase !== undefined && phase.status !== "completed" && phase.status !== "failed") selected.add(index);
        }
        for (let index = parsed.length - 1; index >= 0 && selected.size < 64; index -= 1) selected.add(index);
        return parsed.filter((_phase, index) => selected.has(index));
      })(),
    },
    areaMemory,
    parentEvidence,
    messagesSinceCursor: requestedCursor,
    nextMessageCursor: nonNegative(context.messageCursor, "context.messageCursor"),
    messages,
    triggerQuestion: questionProjection(context.triggerQuestion, wakeup.reason === "human_answer"),
    openQuestions: context.openQuestions.slice(0, 4).map((question) => ({
      questionId: id(question.questionId, "openQuestion.questionId"),
      question: bounded(question.question, "openQuestion.question", 2_000),
      answer: question.answer === null ? null : bounded(question.answer, "openQuestion.answer", 4_000),
      status: question.status,
    })),
    workspaceRefs: context.workspaceRefs,
    workflow: context.workflow ?? null,
  };
  return parseBoundedAgentContext(internal);
}

export class HttpTaskBoardClient implements TaskBoardClient {
  readonly #http: JsonClient;

  constructor(options: HttpTaskBoardClientOptions) { this.#http = new JsonClient(options); }

  async claimNextWake(request: ClaimNextWakeRequest, signal?: AbortSignal): Promise<ClaimedAgentRun | null> {
    const result = await this.#http.request(
      "POST",
      `/v1/agents/${encodeURIComponent(request.agentId)}/runs/claim?waitMs=${request.longPollMs}`,
      { claimId: request.claimId, messageCursors: request.messageCursors },
      signal,
      request.longPollMs > 0,
    );
    if (result.status === 204) return null;
    const claimed = asClaimResult(result.body);
    const requestedMessageCursor = claimed.wakeup.taskId === null
      ? null
      : request.messageCursors[claimed.wakeup.taskId] ?? null;
    const claim = parseTaskWakeClaim({
      apiVersion: 1,
      claimId: claimed.run.claimId,
      runId: claimed.run.runId,
      wakeupId: claimed.wakeup.wakeupId,
      projectId: claimed.run.projectId,
      agentId: claimed.run.agentId,
      taskId: claimed.wakeup.taskId,
      reason: claimed.wakeup.reason,
      requestedMessageCursor,
      claimedAt: claimed.run.startedAt,
    });
    return Object.freeze({ claim, context: mapContext(claimed, requestedMessageCursor) });
  }

  async waitForRunInterrupt(claim: TaskWakeClaim, signal?: AbortSignal): Promise<AgentRunInterrupt | null> {
    let after = 0;
    while (!signal?.aborted) {
      const result = await this.#http.request(
        "GET",
        `/v1/runs/${encodeURIComponent(claim.runId)}/interrupts?after=${after}&waitMs=30000`,
        null,
        signal,
        true,
      );
      if (result.status === 204) continue;
      const batch = exact(result.body, ["apiVersion", "items", "cursor"], "Interrupt batch");
      if (batch.apiVersion !== TASK_BOARD_API_VERSION || !Array.isArray(batch.items)) throw new Error("Interrupt batch is invalid");
      const cursor = nonNegative(batch.cursor, "interrupt.cursor");
      if (cursor < after) throw new Error("Interrupt cursor moved backwards");
      after = cursor;
      const first = batch.items[0];
      if (first === undefined) continue;
      const item = exact(first, [
        "apiVersion", "sequence", "interruptId", "projectId", "agentId", "runId", "reason", "requestedBy", "requestedAt",
      ], "Agent interrupt");
      if (item.apiVersion !== TASK_BOARD_API_VERSION || item.runId !== claim.runId) throw new Error("Agent interrupt binding is invalid");
      return Object.freeze({
        sequence: nonNegative(item.sequence, "interrupt.sequence"),
        interruptId: id(item.interruptId, "interrupt.interruptId"),
        projectId: id(item.projectId, "interrupt.projectId"),
        agentId: id(item.agentId, "interrupt.agentId"),
        runId: id(item.runId, "interrupt.runId"),
        reason: bounded(item.reason, "interrupt.reason", 2_000),
        requestedAt: timestamp(item.requestedAt, "interrupt.requestedAt"),
      });
    }
    return null;
  }

  async updateTaskEstimate(request: UpdateTaskEstimateRequest, signal?: AbortSignal): Promise<number> {
    const taskId = request.claim.taskId;
    if (taskId === null) throw new Error("A taskless run cannot estimate work");
    const version = positive(request.version, "estimate.version");
    const minutes = estimateMinutes(request.expectedAgentMinutes, "estimate.expectedAgentMinutes");
    if (minutes === null) throw new Error("An estimate update requires a concrete duration");
    const result = await this.#http.request(
      "PATCH",
      `/v1/tasks/${encodeURIComponent(taskId)}`,
      { version, expectedAgentMinutes: minutes },
      signal,
    );
    const envelope = exact(result.body, ["task"], "Estimate response");
    const task = object(envelope.task, "Estimated task");
    if (
      task.taskId !== taskId || task.projectId !== request.claim.projectId ||
      task.assignedAgentId !== request.claim.agentId || task.expectedAgentMinutes !== minutes
    ) {
      throw new Error("Task-board estimate response belongs to another task or value");
    }
    const nextVersion = positive(task.version, "estimatedTask.version");
    if (nextVersion !== version + 1) throw new Error("Task-board estimate response version is invalid");
    return nextVersion;
  }

  async createTaskPhase(request: CreateAgentTaskPhaseRequest, signal?: AbortSignal): Promise<AgentTaskPhase> {
    const taskId = request.claim.taskId;
    if (taskId === null) throw new Error("A taskless run cannot create a phase");
    const result = await this.#http.request(
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/phases`,
      { title: request.title, stage: request.stage, parallelGroup: request.parallelGroup },
      signal,
    );
    const envelope = exact(result.body, ["phase"], "Phase creation response");
    const phase = taskPhase(envelope.phase, request.claim.projectId, taskId, "Created phase");
    if (
      phase.title !== request.title || phase.stage !== request.stage || phase.status !== "pending" ||
      phase.parallelGroup !== request.parallelGroup
    ) {
      throw new Error("Task-board phase creation response does not match the request");
    }
    return phase;
  }

  async updateTaskPhase(request: UpdateAgentTaskPhaseRequest, signal?: AbortSignal): Promise<AgentTaskPhase> {
    const taskId = request.claim.taskId;
    if (taskId === null) throw new Error("A taskless run cannot update a phase");
    if (request.phase.phaseId.length === 0) throw new Error("Phase id is invalid");
    const body = {
      version: positive(request.phase.version, "phase.version"),
      ...("title" in request ? { title: request.title } : {}),
      ...("stage" in request ? { stage: request.stage } : {}),
      ...("status" in request ? { status: request.status } : {}),
      ...("parallelGroup" in request ? { parallelGroup: request.parallelGroup } : {}),
      ...("orderKey" in request ? { orderKey: request.orderKey } : {}),
    };
    if (Object.keys(body).length === 1) throw new Error("Phase update contains no changes");
    const result = await this.#http.request(
      "PATCH",
      `/v1/task-phases/${encodeURIComponent(request.phase.phaseId)}`,
      body,
      signal,
    );
    const envelope = exact(result.body, ["phase"], "Phase update response");
    const phase = taskPhase(envelope.phase, request.claim.projectId, taskId, "Updated phase");
    if (
      phase.phaseId !== request.phase.phaseId || phase.version !== request.phase.version + 1 ||
      request.title !== undefined && phase.title !== request.title ||
      request.stage !== undefined && phase.stage !== request.stage ||
      request.status !== undefined && phase.status !== request.status ||
      "parallelGroup" in request && phase.parallelGroup !== request.parallelGroup ||
      request.orderKey !== undefined && phase.orderKey !== request.orderKey
    ) {
      throw new Error("Task-board phase update response does not match the request");
    }
    return phase;
  }

  async appendRunOutput(request: AppendRunOutputRequest, signal?: AbortSignal): Promise<void> {
    if (request.claim.taskId === null) throw new Error("A taskless run cannot append task output");
    const output = request.output;
    const path = output.type === "human_question"
      ? `/v1/tasks/${encodeURIComponent(request.claim.taskId)}/questions`
      : `/v1/tasks/${encodeURIComponent(request.claim.taskId)}/messages`;
    const body = output.type === "human_question"
      ? { clientEventId: request.idempotencyKey, question: output.question, runId: request.claim.runId }
      : {
          clientEventId: request.idempotencyKey,
          kind: output.type === "progress" ? "progress" : output.type === "result" ? "result" : "proposal",
          body: output.type === "proposed_child_task" ? JSON.stringify({
            title: output.title,
            objective: output.objective,
            acceptanceCriteria: output.acceptanceCriteria,
          }) : output.body,
          runId: request.claim.runId,
        };
    const result = await this.#http.request("POST", path, body, signal);
    const envelope = exact(result.body, [output.type === "human_question" ? "question" : "message"], "Output response");
    const value = object(envelope[output.type === "human_question" ? "question" : "message"], "Output record");
    if (value.runId !== request.claim.runId || value.taskId !== request.claim.taskId) {
      throw new Error("Task-board output response belongs to another run or task");
    }
  }

  async settleAgentRun(request: SettleAgentRunRequest, signal?: AbortSignal): Promise<void> {
    if (request.outcome === "waiting_for_human") throw new Error("Human questions settle atomically through the question endpoint");
    const result = await this.#http.request(
      "POST",
      `/v1/runs/${encodeURIComponent(request.claim.runId)}/settle`,
      {
        outcome: request.outcome,
        result: request.result,
        handoff: request.handoff ?? null,
        workflowPlan: request.workflowPlan ?? null,
      },
      signal,
    );
    const envelope = exact(result.body, ["run", "duplicate"], "Run settlement response");
    const run = object(envelope.run, "Settled run");
    if (
      typeof envelope.duplicate !== "boolean" || run.runId !== request.claim.runId || run.agentId !== request.claim.agentId ||
      run.status !== request.outcome || run.result !== request.result
    ) {
      throw new Error("Task-board settlement response does not match the run outcome");
    }
  }
}
