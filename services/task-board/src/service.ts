import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { TaskBoard } from "./board.js";
import { normalizeTaskBoardConfig, type TaskBoardConfig, type TaskBoardOptions } from "./config.js";
import { TaskBoardError } from "./errors.js";
import {
  applyCors,
  bearerToken,
  isHuman,
  readJsonBody,
  requireHuman,
  sendEmpty,
  sendError,
  sendJson,
} from "./http.js";
import {
  parseAgentIdentifier,
  parseAgentMessage,
  parseAnswer,
  parseClaim,
  parseCreateAgent,
  parseCreateProject,
  parseCreateTask,
  parseHumanMessage,
  parseIdentifier,
  parseIdempotencyKey,
  parseInterrupt,
  parseQuestion,
  parseResume,
  parseSettle,
  parseUpdateTask,
} from "./schema.js";

export interface TaskBoardAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

function routeUrl(value: string | undefined): URL {
  try {
    return new URL(value ?? "", "http://task-board.invalid");
  } catch {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Request URL is invalid");
  }
}

function noQuery(url: URL): void {
  if (url.search.length > 0) throw new TaskBoardError(400, "INVALID_REQUEST", "Query parameters are not accepted");
}

function exactIntegerQuery(url: URL, keys: readonly string[], field: string, fallback: number, maximum: number): number {
  if ([...url.searchParams.keys()].some((key) => !keys.includes(key)) || url.searchParams.getAll(field).length > 1) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Query parameters are invalid");
  }
  const raw = url.searchParams.get(field);
  if (raw === null) return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) throw new TaskBoardError(400, "INVALID_REQUEST", `${field} is invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) throw new TaskBoardError(400, "INVALID_REQUEST", `${field} is invalid`);
  return value;
}

export class TaskBoardService {
  readonly config: TaskBoardConfig;
  readonly #board: TaskBoard;
  readonly #server: Server;
  #started = false;
  #closing = false;

  private constructor(config: TaskBoardConfig, board: TaskBoard) {
    this.config = config;
    this.#board = board;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => sendError(response, error));
    });
    this.#server.requestTimeout = 45_000;
    this.#server.headersTimeout = 10_000;
    this.#server.keepAliveTimeout = 5_000;
    this.#server.maxHeadersCount = 32;
  }

  static async create(options: TaskBoardOptions): Promise<TaskBoardService> {
    const config = normalizeTaskBoardConfig(options);
    const board = await TaskBoard.open(config);
    return new TaskBoardService(config, board);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = routeUrl(request.url);
    applyCors(request, response, this.config);
    if (request.method === "OPTIONS") {
      if (request.headers.origin === undefined) throw new TaskBoardError(400, "INVALID_CORS_PREFLIGHT", "Origin is required");
      response.statusCode = 204;
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
      response.setHeader("Access-Control-Max-Age", "600");
      response.end();
      return;
    }
    if (url.pathname === "/health" && request.method === "GET") {
      noQuery(url);
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (url.pathname === "/v1/projects" && request.method === "GET") {
      noQuery(url);
      requireHuman(request, this.config);
      sendJson(response, 200, { projects: this.#board.listProjects() });
      return;
    }
    if (url.pathname === "/v1/projects" && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      sendJson(response, 201, { project: this.#board.createProject(parseCreateProject(await readJsonBody(request, this.config.maxBodyBytes))) });
      return;
    }
    const boardMatch = /^\/v1\/projects\/([^/]+)\/board$/u.exec(url.pathname);
    if (boardMatch && request.method === "GET") {
      noQuery(url);
      requireHuman(request, this.config);
      sendJson(response, 200, this.#board.snapshot(parseIdentifier(boardMatch[1], "projectId")));
      return;
    }
    const agentCreateMatch = /^\/v1\/projects\/([^/]+)\/agents$/u.exec(url.pathname);
    if (agentCreateMatch && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const projectId = parseIdentifier(agentCreateMatch[1], "projectId");
      const agent = this.#board.createAgent(projectId, parseCreateAgent(await readJsonBody(request, this.config.maxBodyBytes)));
      sendJson(response, 201, { agent });
      return;
    }
    const taskCreateMatch = /^\/v1\/projects\/([^/]+)\/tasks$/u.exec(url.pathname);
    if (taskCreateMatch && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const projectId = parseIdentifier(taskCreateMatch[1], "projectId");
      const task = this.#board.createTask(projectId, parseCreateTask(await readJsonBody(request, this.config.maxBodyBytes)));
      sendJson(response, 201, { task });
      return;
    }
    const taskMatch = /^\/v1\/tasks\/([^/]+)$/u.exec(url.pathname);
    if (taskMatch && request.method === "PATCH") {
      noQuery(url);
      const taskId = parseIdentifier(taskMatch[1], "taskId");
      const update = parseUpdateTask(await readJsonBody(request, this.config.maxBodyBytes));
      const actor = isHuman(request, this.config)
        ? { type: "human" as const, id: this.config.humanPrincipal }
        : (() => {
            const agent = this.#board.authenticateAgent(bearerToken(request));
            return { type: "agent" as const, id: agent.agentId };
          })();
      sendJson(response, 200, { task: this.#board.updateTask(taskId, update, actor) });
      return;
    }
    const messageMatch = /^\/v1\/tasks\/([^/]+)\/messages$/u.exec(url.pathname);
    if (messageMatch && request.method === "POST") {
      noQuery(url);
      const taskId = parseIdentifier(messageMatch[1], "taskId");
      const body = await readJsonBody(request, this.config.maxBodyBytes);
      const message = isHuman(request, this.config)
        ? this.#board.appendHumanMessage(taskId, parseHumanMessage(body))
        : (() => {
            const agent = this.#board.authenticateAgent(bearerToken(request));
            return this.#board.appendAgentMessage(taskId, agent.agentId, parseAgentMessage(body));
          })();
      sendJson(response, 201, { message });
      return;
    }
    if (messageMatch && request.method === "GET") {
      const taskId = parseIdentifier(messageMatch[1], "taskId");
      const after = exactIntegerQuery(url, ["after"], "after", 0, Number.MAX_SAFE_INTEGER);
      if (!isHuman(request, this.config)) {
        const agent = this.#board.authenticateAgent(bearerToken(request));
        if (this.#board.requireTask(taskId).assignedAgentId !== agent.agentId) {
          throw new TaskBoardError(403, "TASK_NOT_ASSIGNED", "Task is not assigned to this agent");
        }
      }
      sendJson(response, 200, this.#board.listMessagePage(taskId, after));
      return;
    }
    const questionMatch = /^\/v1\/tasks\/([^/]+)\/questions$/u.exec(url.pathname);
    if (questionMatch && request.method === "POST") {
      noQuery(url);
      const taskId = parseIdentifier(questionMatch[1], "taskId");
      const agent = this.#board.authenticateAgent(bearerToken(request));
      const question = this.#board.askQuestion(taskId, agent.agentId, parseQuestion(await readJsonBody(request, this.config.maxBodyBytes)));
      sendJson(response, 201, { question });
      return;
    }
    const answerMatch = /^\/v1\/questions\/([^/]+)\/answer$/u.exec(url.pathname);
    if (answerMatch && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const result = this.#board.answerQuestion(
        parseIdentifier(answerMatch[1], "questionId"),
        parseAnswer(await readJsonBody(request, this.config.maxBodyBytes)),
      );
      sendJson(response, result.duplicate ? 200 : 201, result);
      return;
    }
    const resumeMatch = /^\/v1\/agents\/([^/]+)\/resume$/u.exec(url.pathname);
    if (resumeMatch && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const result = this.#board.resumeAgent(
        parseAgentIdentifier(resumeMatch[1]),
        parseResume(await readJsonBody(request, this.config.maxBodyBytes)),
        parseIdempotencyKey(request.headers["idempotency-key"]),
      );
      sendJson(response, result.duplicate ? 200 : 201, result);
      return;
    }
    const interruptMatch = /^\/v1\/agents\/([^/]+)\/interrupt$/u.exec(url.pathname);
    if (interruptMatch && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const result = this.#board.interruptAgent(
        parseAgentIdentifier(interruptMatch[1]),
        parseInterrupt(await readJsonBody(request, this.config.maxBodyBytes)),
        parseIdempotencyKey(request.headers["idempotency-key"]),
      );
      sendJson(response, result.duplicate ? 200 : 201, result);
      return;
    }
    const claimMatch = /^\/v1\/agents\/([^/]+)\/runs\/claim$/u.exec(url.pathname);
    if (claimMatch && request.method === "POST") {
      const agentId = parseAgentIdentifier(claimMatch[1]);
      this.#board.authenticateAgent(bearerToken(request), agentId);
      const waitMs = exactIntegerQuery(url, ["waitMs"], "waitMs", 0, 30_000);
      const claim = parseClaim(await readJsonBody(request, this.config.maxBodyBytes));
      const abort = new AbortController();
      const onClose = (): void => abort.abort();
      request.socket.once("close", onClose);
      const result = await this.#board.waitToClaimRun(
        agentId,
        claim,
        waitMs,
        abort.signal,
      );
      request.socket.off("close", onClose);
      if (result === null) sendEmpty(response, 204);
      else sendJson(response, 201, result);
      return;
    }
    const settleMatch = /^\/v1\/runs\/([^/]+)\/settle$/u.exec(url.pathname);
    if (settleMatch && request.method === "POST") {
      noQuery(url);
      const runId = parseIdentifier(settleMatch[1], "runId");
      const agent = this.#board.authenticateAgent(bearerToken(request));
      const result = this.#board.settleRun(runId, agent.agentId, parseSettle(await readJsonBody(request, this.config.maxBodyBytes)));
      sendJson(response, 200, result);
      return;
    }
    const interruptWaitMatch = /^\/v1\/runs\/([^/]+)\/interrupts$/u.exec(url.pathname);
    if (interruptWaitMatch && request.method === "GET") {
      const runId = parseIdentifier(interruptWaitMatch[1], "runId");
      const after = exactIntegerQuery(url, ["after", "waitMs"], "after", 0, Number.MAX_SAFE_INTEGER);
      const waitMs = exactIntegerQuery(url, ["after", "waitMs"], "waitMs", 30_000, 30_000);
      const agent = this.#board.authenticateAgent(bearerToken(request));
      const abort = new AbortController();
      const onClose = (): void => abort.abort();
      request.socket.once("close", onClose);
      const result = await this.#board.waitForRunInterrupts(runId, agent.agentId, after, waitMs, abort.signal);
      request.socket.off("close", onClose);
      if (result === null) sendEmpty(response, 204);
      else sendJson(response, 200, result);
      return;
    }
    throw new TaskBoardError(404, "NOT_FOUND", "Endpoint was not found");
  }

  async start(): Promise<TaskBoardAddress> {
    if (this.#started) throw new Error("TASK_BOARD_ALREADY_STARTED");
    if (this.#closing) throw new Error("TASK_BOARD_CLOSED");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(this.config.port, this.config.host, () => {
        this.#server.off("error", onError);
        resolve();
      });
    });
    this.#started = true;
    const address = this.#server.address() as AddressInfo;
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
    return Object.freeze({ host: address.address, port: address.port, url: `http://${host}:${address.port}` });
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    if (this.#started) {
      await new Promise<void>((resolve, reject) => this.#server.close((error) => error ? reject(error) : resolve()));
      this.#started = false;
    }
    this.#board.close();
  }
}

export function createTaskBoardService(options: TaskBoardOptions): Promise<TaskBoardService> {
  return TaskBoardService.create(options);
}
