import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  TASK_BOARD_ERROR_CODES,
  WORK_ITEM_CURSOR_MAX_BYTES,
  type CreateProjectArtifactRequest,
} from "#shared/task-board-contract";
import { TaskBoard } from "./board.js";
import { normalizeTaskBoardConfig, type TaskBoardConfig, type TaskBoardOptions } from "./config.js";
import { TaskBoardError } from "./errors.js";
import { listDirectories, listProjectRoots } from "./host.js";
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
  parseAgentMessage,
  parseAnswer,
  parseBacklogTask,
  parseClaim,
  parseConfirmPlanRevisionRequest,
  parseCreateAgent,
  parseCreateDocument,
  parseCreateProject,
  parseCreateTask,
  parseCreateTaskPhase,
  parseCreateWorkItem,
  parseHumanMessage,
  parseIdentifier,
  parseIdempotencyKey,
  parseInterrupt,
  parseLaneError,
  parseDocumentPenUpdate,
  parseDocumentUpdate,
  parseQuestion,
  parseRetryTask,
  parseRotateAgentToken,
  parseResume,
  parseSettle,
  parseUpdateAutomationConfiguration,
  parseUpdateTask,
  parseUpdateTaskPhase,
  parseUpdateWorkItem,
} from "./schema.js";

export interface TaskBoardAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

interface DocumentStream {
  readonly response: ServerResponse;
  readonly unsubscribe: () => void;
}

function parseArtifact(value: unknown): CreateProjectArtifactRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TaskBoardError(400, "INVALID_REQUEST", "Artifact request must be an object");
  const item = value as Record<string, unknown>;
  const expected = ["caption", "contentBase64", "mediaType", "nodeId", "taskId"].sort();
  if (Object.keys(item).sort().some((key, index) => key !== expected[index]) || Object.keys(item).length !== expected.length) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Artifact request has unexpected or missing fields");
  }
  return item as unknown as CreateProjectArtifactRequest;
}

function routeUrl(value: string | undefined): URL {
  try {
    return new URL(value ?? "", "http://task-board.invalid");
  } catch {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Request URL is invalid");
  }
}

function parseRouteIdentifier(value: string, field: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new TaskBoardError(
      400,
      TASK_BOARD_ERROR_CODES.INVALID_IDENTIFIER,
      `${field} has malformed percent-encoding`,
    );
  }
  return parseIdentifier(decoded, field);
}

function noQuery(url: URL): void {
  if (url.search.length > 0) throw new TaskBoardError(400, "INVALID_REQUEST", "Query parameters are not accepted");
}

function workItemListQuery(url: URL): { cursor: string | undefined; includeArchived: boolean } {
  const values = url.searchParams.getAll("cursor");
  const archivedValues = url.searchParams.getAll("includeArchived");
  if (
    [...url.searchParams.keys()].some((key) => key !== "cursor" && key !== "includeArchived")
    || values.length > 1
    || archivedValues.length > 1
    || (archivedValues[0] !== undefined && archivedValues[0] !== "1")
  ) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Query parameters are invalid");
  }
  const cursor = values[0];
  if (cursor !== undefined && (cursor.length < 1 || Buffer.byteLength(cursor, "utf8") > WORK_ITEM_CURSOR_MAX_BYTES)) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "cursor is invalid");
  }
  return { cursor, includeArchived: archivedValues[0] === "1" };
}

function hostDirectoriesQuery(url: URL): string | undefined {
  const values = url.searchParams.getAll("path");
  if ([...url.searchParams.keys()].some((key) => key !== "path") || values.length > 1) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Query parameters are invalid");
  }
  const path = values[0];
  if (path === undefined) return undefined;
  if (path.length < 1 || path.length > 512 || !path.startsWith("/") || /[\u0000\r\n]/u.test(path)) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "path must be an absolute path of at most 512 characters");
  }
  return path;
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
  readonly #documentStreams = new Set<DocumentStream>();
  readonly #projectStreams = new Set<DocumentStream>();
  readonly #closingAbort = new AbortController();
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
    if (url.pathname === "/v1/automation-configuration" && request.method === "GET") {
      noQuery(url);
      requireHuman(request, this.config);
      sendJson(response, 200, { configuration: this.#board.getAutomationConfiguration() });
      return;
    }
    if (url.pathname === "/v1/automation-configuration" && request.method === "PATCH") {
      noQuery(url);
      requireHuman(request, this.config);
      const configuration = this.#board.updateAutomationConfiguration(
        parseUpdateAutomationConfiguration(await readJsonBody(request, this.config.maxBodyBytes)),
      );
      sendJson(response, 200, { configuration });
      return;
    }
    if (url.pathname === "/v1/work-items" && request.method === "GET") {
      const { cursor, includeArchived } = workItemListQuery(url);
      requireHuman(request, this.config);
      sendJson(response, 200, this.#board.listWorkItemsPage(cursor, includeArchived));
      return;
    }
    if (url.pathname === "/v1/work-items" && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const result = this.#board.createWorkItemAndStartPlanning(
        parseCreateWorkItem(await readJsonBody(request, this.config.maxBodyBytes)),
        parseIdempotencyKey(request.headers["idempotency-key"]),
      );
      sendJson(response, result.duplicate ? 200 : 201, {
        workItem: this.#board.requireWorkItem(result.workItem.workItemId),
      });
      return;
    }
    const confirmPlanMatch = /^\/v1\/plans\/([^/]+)\/confirm$/u.exec(url.pathname);
    if (confirmPlanMatch && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const workflow = this.#board.confirmWorkflow(
        parseRouteIdentifier(confirmPlanMatch[1], "planRevisionId"),
        parseConfirmPlanRevisionRequest(await readJsonBody(request, this.config.maxBodyBytes)),
      );
      sendJson(response, 200, { workflow });
      return;
    }
    const workItemMatch = /^\/v1\/work-items\/([^/]+)$/u.exec(url.pathname);
    if (workItemMatch && request.method === "GET") {
      noQuery(url);
      requireHuman(request, this.config);
      sendJson(response, 200, { workItem: this.#board.requireWorkItem(parseRouteIdentifier(workItemMatch[1], "workItemId")) });
      return;
    }
    if (workItemMatch && request.method === "PATCH") {
      noQuery(url);
      requireHuman(request, this.config);
      const workItem = this.#board.updateWorkItem(
        parseRouteIdentifier(workItemMatch[1], "workItemId"),
        parseUpdateWorkItem(await readJsonBody(request, this.config.maxBodyBytes)),
      );
      this.#board.startWorkItemPlanning(workItem.workItemId);
      sendJson(response, 200, { workItem: this.#board.requireWorkItem(workItem.workItemId) });
      return;
    }
    if (url.pathname === "/v1/projects" && request.method === "GET") {
      noQuery(url);
      requireHuman(request, this.config);
      sendJson(response, 200, { projects: this.#board.listProjects() });
      return;
    }
    if (url.pathname === "/v1/host/project-roots" && request.method === "GET") {
      noQuery(url);
      requireHuman(request, this.config);
      sendJson(response, 200, { roots: await listProjectRoots(this.config.host) });
      return;
    }
    if (url.pathname === "/v1/host/directories" && request.method === "GET") {
      const path = hostDirectoriesQuery(url);
      requireHuman(request, this.config);
      sendJson(response, 200, { listing: await listDirectories(this.config.host, path ?? this.config.host.homeDir) });
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
      sendJson(response, 200, this.#board.snapshot(parseRouteIdentifier(boardMatch[1], "projectId")));
      return;
    }
    const workflowMatch = /^\/v1\/projects\/([^/]+)\/workflow$/u.exec(url.pathname);
    if (workflowMatch && request.method === "GET") {
      noQuery(url);
      requireHuman(request, this.config);
      sendJson(response, 200, { workflow: this.#board.projectWorkflow(parseRouteIdentifier(workflowMatch[1], "projectId")) });
      return;
    }
    const workflowEventsMatch = /^\/v1\/projects\/([^/]+)\/workflow\/events$/u.exec(url.pathname);
    if (workflowEventsMatch && request.method === "GET") {
      requireHuman(request, this.config);
      const projectId = parseRouteIdentifier(workflowEventsMatch[1], "projectId");
      const after = exactIntegerQuery(url, ["after"], "after", 0, Number.MAX_SAFE_INTEGER);
      this.#openProjectStream(request, response, projectId, after);
      return;
    }
    const artifactsMatch = /^\/v1\/projects\/([^/]+)\/artifacts$/u.exec(url.pathname);
    if (artifactsMatch && request.method === "GET") {
      noQuery(url);
      requireHuman(request, this.config);
      sendJson(response, 200, { artifacts: this.#board.listArtifacts(parseRouteIdentifier(artifactsMatch[1], "projectId")) });
      return;
    }
    if (artifactsMatch && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const artifact = await this.#board.createArtifact(
        parseRouteIdentifier(artifactsMatch[1], "projectId"),
        parseArtifact(await readJsonBody(request, this.config.maxBodyBytes)),
      );
      sendJson(response, 201, { artifact });
      return;
    }
    const artifactMatch = /^\/v1\/artifacts\/([^/]+)$/u.exec(url.pathname);
    if (artifactMatch && request.method === "GET") {
      noQuery(url);
      requireHuman(request, this.config);
      const { artifact, bytes } = await this.#board.artifactContent(parseRouteIdentifier(artifactMatch[1], "artifactId"));
      response.statusCode = 200;
      response.setHeader("Content-Type", artifact.mediaType);
      response.setHeader("Content-Length", String(bytes.length));
      response.setHeader("ETag", `"${artifact.digest}"`);
      response.setHeader("Cache-Control", "private, immutable, max-age=31536000");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.end(bytes);
      return;
    }
    const documentCreateMatch = /^\/v1\/projects\/([^/]+)\/documents$/u.exec(url.pathname);
    if (documentCreateMatch && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const projectId = parseRouteIdentifier(documentCreateMatch[1], "projectId");
      const document = this.#board.createDocument(
        projectId,
        parseCreateDocument(await readJsonBody(request, this.config.maxBodyBytes)),
      );
      sendJson(response, 201, { document });
      return;
    }
    const documentMatch = /^\/v1\/documents\/([^/]+)$/u.exec(url.pathname);
    if (documentMatch && request.method === "GET") {
      noQuery(url);
      const documentId = parseRouteIdentifier(documentMatch[1], "documentId");
      const document = this.#board.getDocument(documentId);
      this.#documentActor(request, document.projectId);
      sendJson(response, 200, { document });
      return;
    }
    const documentPenMatch = /^\/v1\/documents\/([^/]+)\/pen$/u.exec(url.pathname);
    if (documentPenMatch && request.method === "POST") {
      noQuery(url);
      const documentId = parseRouteIdentifier(documentPenMatch[1], "documentId");
      const current = this.#board.getDocument(documentId);
      const actor = this.#documentActor(request, current.projectId);
      const update = parseDocumentPenUpdate(await readJsonBody(request, this.config.maxBodyBytes));
      if (actor.type === "agent") this.#board.assertAgentCredentialVersion(actor.id, actor.credentialVersion);
      const document = this.#board.updateDocumentPen(
        documentId,
        update,
        actor,
      );
      sendJson(response, 200, { document });
      return;
    }
    if (documentMatch && request.method === "PATCH") {
      noQuery(url);
      const documentId = parseRouteIdentifier(documentMatch[1], "documentId");
      const current = this.#board.getDocument(documentId);
      const actor = this.#documentActor(request, current.projectId);
      const update = parseDocumentUpdate(await readJsonBody(request, this.config.maxBodyBytes));
      if (actor.type === "agent") this.#board.assertAgentCredentialVersion(actor.id, actor.credentialVersion);
      const document = this.#board.updateDocument(
        documentId,
        update,
        actor,
      );
      sendJson(response, 200, { document });
      return;
    }
    const documentEventsMatch = /^\/v1\/documents\/([^/]+)\/events$/u.exec(url.pathname);
    if (documentEventsMatch && request.method === "GET") {
      const documentId = parseRouteIdentifier(documentEventsMatch[1], "documentId");
      const document = this.#board.getDocument(documentId);
      this.#documentActor(request, document.projectId);
      const after = exactIntegerQuery(url, ["after"], "after", 0, Number.MAX_SAFE_INTEGER);
      this.#openDocumentStream(request, response, documentId, document.sequence, after);
      return;
    }
    const agentCreateMatch = /^\/v1\/projects\/([^/]+)\/agents$/u.exec(url.pathname);
    if (agentCreateMatch && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const projectId = parseRouteIdentifier(agentCreateMatch[1], "projectId");
      const agent = this.#board.createAgent(projectId, parseCreateAgent(await readJsonBody(request, this.config.maxBodyBytes)));
      sendJson(response, 201, { agent });
      return;
    }
    const agentTokenRotateMatch = /^\/v1\/agents\/([^/]+)\/rotate-token$/u.exec(url.pathname);
    if (agentTokenRotateMatch && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const agentId = parseRouteIdentifier(agentTokenRotateMatch[1], "agentId");
      const rotation = parseRotateAgentToken(await readJsonBody(request, this.config.maxBodyBytes));
      sendJson(response, 200, this.#board.rotateAgentToken(agentId, rotation.version));
      return;
    }
    const taskCreateMatch = /^\/v1\/projects\/([^/]+)\/tasks$/u.exec(url.pathname);
    if (taskCreateMatch && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const projectId = parseRouteIdentifier(taskCreateMatch[1], "projectId");
      const task = this.#board.createTask(projectId, parseCreateTask(await readJsonBody(request, this.config.maxBodyBytes)));
      sendJson(response, 201, { task });
      return;
    }
    const taskMatch = /^\/v1\/tasks\/([^/]+)$/u.exec(url.pathname);
    if (taskMatch && request.method === "PATCH") {
      noQuery(url);
      const taskId = parseRouteIdentifier(taskMatch[1], "taskId");
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
    const taskRetryMatch = /^\/v1\/tasks\/([^/]+)\/retry$/u.exec(url.pathname);
    if (taskRetryMatch && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const result = this.#board.retryTask(
        parseRouteIdentifier(taskRetryMatch[1], "taskId"),
        parseRetryTask(await readJsonBody(request, this.config.maxBodyBytes)),
      );
      sendJson(response, 200, result);
      return;
    }
    const taskBacklogMatch = /^\/v1\/tasks\/([^/]+)\/backlog$/u.exec(url.pathname);
    if (taskBacklogMatch && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const result = this.#board.backlogTask(
        parseRouteIdentifier(taskBacklogMatch[1], "taskId"),
        parseBacklogTask(await readJsonBody(request, this.config.maxBodyBytes)),
      );
      sendJson(response, 200, result);
      return;
    }
    const phaseCreateMatch = /^\/v1\/tasks\/([^/]+)\/phases$/u.exec(url.pathname);
    if (phaseCreateMatch && request.method === "POST") {
      noQuery(url);
      const taskId = parseRouteIdentifier(phaseCreateMatch[1], "taskId");
      const agent = this.#board.authenticateAgent(bearerToken(request));
      const requestBody = parseCreateTaskPhase(await readJsonBody(request, this.config.maxBodyBytes));
      this.#board.assertAgentCredentialVersion(agent.agentId, agent.version);
      const phase = this.#board.createTaskPhase(
        taskId,
        requestBody,
        agent.agentId,
      );
      sendJson(response, 201, { phase });
      return;
    }
    const phaseMatch = /^\/v1\/task-phases\/([^/]+)$/u.exec(url.pathname);
    if (phaseMatch && request.method === "PATCH") {
      noQuery(url);
      const phaseId = parseRouteIdentifier(phaseMatch[1], "phaseId");
      const agent = this.#board.authenticateAgent(bearerToken(request));
      const requestBody = parseUpdateTaskPhase(await readJsonBody(request, this.config.maxBodyBytes));
      this.#board.assertAgentCredentialVersion(agent.agentId, agent.version);
      const phase = this.#board.updateTaskPhase(
        phaseId,
        requestBody,
        agent.agentId,
      );
      sendJson(response, 200, { phase });
      return;
    }
    const messageMatch = /^\/v1\/tasks\/([^/]+)\/messages$/u.exec(url.pathname);
    if (messageMatch && request.method === "POST") {
      noQuery(url);
      const taskId = parseRouteIdentifier(messageMatch[1], "taskId");
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
      const taskId = parseRouteIdentifier(messageMatch[1], "taskId");
      const after = exactIntegerQuery(url, ["after"], "after", 0, Number.MAX_SAFE_INTEGER);
      if (!isHuman(request, this.config)) {
        const agent = this.#board.authenticateAgent(bearerToken(request));
        if (this.#board.requireTask(taskId).assignedAgentId !== agent.agentId) {
          throw new TaskBoardError(403, "TASK_NOT_ASSIGNED", "Task is not assigned to this agent");
        }
      }
      const messages = this.#board.listMessages(taskId, after);
      sendJson(response, 200, { messages, cursor: messages.at(-1)?.sequence ?? after });
      return;
    }
    const questionMatch = /^\/v1\/tasks\/([^/]+)\/questions$/u.exec(url.pathname);
    if (questionMatch && request.method === "POST") {
      noQuery(url);
      const taskId = parseRouteIdentifier(questionMatch[1], "taskId");
      const agent = this.#board.authenticateAgent(bearerToken(request));
      const requestBody = parseQuestion(await readJsonBody(request, this.config.maxBodyBytes));
      this.#board.assertAgentCredentialVersion(agent.agentId, agent.version);
      const question = this.#board.askQuestion(taskId, agent.agentId, requestBody);
      sendJson(response, 201, { question });
      return;
    }
    const answerMatch = /^\/v1\/questions\/([^/]+)\/answer$/u.exec(url.pathname);
    if (answerMatch && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const result = this.#board.answerQuestion(
        parseRouteIdentifier(answerMatch[1], "questionId"),
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
        parseRouteIdentifier(resumeMatch[1], "agentId"),
        parseResume(await readJsonBody(request, this.config.maxBodyBytes)),
        parseIdempotencyKey(request.headers["idempotency-key"]),
      );
      sendJson(response, result.duplicate ? 200 : 201, result);
      return;
    }
    const laneErrorMatch = /^\/v1\/agents\/([^/]+)\/lane-error$/u.exec(url.pathname);
    if (laneErrorMatch && request.method === "POST") {
      noQuery(url);
      const agentId = parseRouteIdentifier(laneErrorMatch[1], "agentId");
      const agent = this.#board.authenticateAgent(bearerToken(request), agentId);
      const { detail } = parseLaneError(await readJsonBody(request, this.config.maxBodyBytes));
      this.#board.assertAgentCredentialVersion(agentId, agent.version);
      this.#board.setAgentLaneError(agentId, detail);
      sendEmpty(response, 204);
      return;
    }
    const interruptMatch = /^\/v1\/agents\/([^/]+)\/interrupt$/u.exec(url.pathname);
    if (interruptMatch && request.method === "POST") {
      noQuery(url);
      requireHuman(request, this.config);
      const result = this.#board.interruptAgent(
        parseRouteIdentifier(interruptMatch[1], "agentId"),
        parseInterrupt(await readJsonBody(request, this.config.maxBodyBytes)),
        parseIdempotencyKey(request.headers["idempotency-key"]),
      );
      sendJson(response, result.duplicate ? 200 : 201, result);
      return;
    }
    const claimMatch = /^\/v1\/agents\/([^/]+)\/runs\/claim$/u.exec(url.pathname);
    if (claimMatch && request.method === "POST") {
      const agentId = parseRouteIdentifier(claimMatch[1], "agentId");
      const agent = this.#board.authenticateAgent(bearerToken(request), agentId);
      const waitMs = exactIntegerQuery(url, ["waitMs"], "waitMs", 0, 30_000);
      const claim = parseClaim(await readJsonBody(request, this.config.maxBodyBytes));
      const abort = new AbortController();
      const onClose = (): void => abort.abort();
      if (request.socket.destroyed) abort.abort();
      else request.socket.once("close", onClose);
      let result: Awaited<ReturnType<TaskBoard["waitToClaimRun"]>>;
      try {
        result = await this.#board.waitToClaimRun(
          agentId,
          claim,
          waitMs,
          AbortSignal.any([abort.signal, this.#closingAbort.signal]),
          agent.version,
        );
      } finally {
        request.socket.off("close", onClose);
      }
      if (result === null) sendEmpty(response, 204);
      else sendJson(response, 201, result);
      return;
    }
    const settleMatch = /^\/v1\/runs\/([^/]+)\/settle$/u.exec(url.pathname);
    if (settleMatch && request.method === "POST") {
      noQuery(url);
      const runId = parseRouteIdentifier(settleMatch[1], "runId");
      const agent = this.#board.authenticateAgent(bearerToken(request));
      const settlement = parseSettle(await readJsonBody(request, this.config.maxBodyBytes));
      this.#board.assertAgentCredentialVersion(agent.agentId, agent.version);
      const result = this.#board.settleRun(runId, agent.agentId, settlement);
      sendJson(response, 200, result);
      return;
    }
    const interruptWaitMatch = /^\/v1\/runs\/([^/]+)\/interrupts$/u.exec(url.pathname);
    if (interruptWaitMatch && request.method === "GET") {
      const runId = parseRouteIdentifier(interruptWaitMatch[1], "runId");
      const after = exactIntegerQuery(url, ["after", "waitMs"], "after", 0, Number.MAX_SAFE_INTEGER);
      const waitMs = exactIntegerQuery(url, ["after", "waitMs"], "waitMs", 30_000, 30_000);
      const agent = this.#board.authenticateAgent(bearerToken(request));
      const abort = new AbortController();
      const onClose = (): void => abort.abort();
      if (request.socket.destroyed) abort.abort();
      else request.socket.once("close", onClose);
      let result: Awaited<ReturnType<TaskBoard["waitForRunInterrupts"]>>;
      try {
        result = await this.#board.waitForRunInterrupts(
          runId,
          agent.agentId,
          after,
          waitMs,
          AbortSignal.any([abort.signal, this.#closingAbort.signal]),
          agent.version,
        );
      } finally {
        request.socket.off("close", onClose);
      }
      if (result === null) sendEmpty(response, 204);
      else sendJson(response, 200, result);
      return;
    }
    throw new TaskBoardError(404, "NOT_FOUND", "Endpoint was not found");
  }

  #documentActor(request: IncomingMessage, projectId: string): Readonly<
    { type: "human"; id: string }
    | { type: "agent"; id: string; credentialVersion: number }
  > {
    if (isHuman(request, this.config)) {
      return Object.freeze({ type: "human", id: this.config.humanPrincipal });
    }
    const agent = this.#board.authenticateAgent(bearerToken(request));
    if (agent.projectId !== projectId) {
      throw new TaskBoardError(403, "DOCUMENT_PROJECT_FORBIDDEN", "Agent belongs to another project");
    }
    return Object.freeze({ type: "agent", id: agent.agentId, credentialVersion: agent.version });
  }

  #openDocumentStream(
    request: IncomingMessage,
    response: ServerResponse,
    documentId: string,
    currentSequence: number,
    after: number,
  ): void {
    if (after > currentSequence) {
      throw new TaskBoardError(409, "DOCUMENT_CURSOR_AHEAD", "Document cursor is ahead of durable state");
    }

    let stream: DocumentStream | undefined;
    const remove = (): void => {
      if (stream === undefined) return;
      stream.unsubscribe();
      this.#documentStreams.delete(stream);
      stream = undefined;
    };
    const write = (document: import("#shared/task-board-contract").DocumentSnapshot): boolean => {
      if (response.writableEnded || response.destroyed) return false;
      // A false return is backpressure, not a failed delivery. The durable cursor
      // lets a disconnected client replay; do not truncate a valid large frame.
      response.write(
        `id: ${document.sequence}\nevent: document\ndata: ${JSON.stringify({ document })}\n\n`,
      );
      return true;
    };
    const unsubscribe = this.#board.subscribeDocumentEvents(documentId, (event) => {
      if (!write(event.document)) {
        remove();
        response.end();
      }
    });
    stream = { response, unsubscribe };
    this.#documentStreams.add(stream);
    request.once("close", remove);
    response.once("close", remove);

    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.flushHeaders();

    let cursor = after;
    while (!response.writableEnded) {
      const events = this.#board.listDocumentEvents(documentId, cursor);
      for (const event of events) {
        if (!write(event.document)) {
          remove();
          response.end();
          return;
        }
        cursor = event.sequence;
      }
      if (events.length < 200) break;
    }
  }

  #openProjectStream(request: IncomingMessage, response: ServerResponse, projectId: string, after: number): void {
    const write = (event: import("#shared/task-board-contract").ProjectEvent): boolean => {
      if (response.writableEnded || response.destroyed) return false;
      response.write(`id: ${event.sequence}\nevent: workflow\ndata: ${JSON.stringify({ event })}\n\n`);
      return true;
    };
    let stream: DocumentStream | undefined;
    const remove = (): void => {
      if (!stream) return;
      stream.unsubscribe();
      this.#projectStreams.delete(stream);
      stream = undefined;
    };
    const unsubscribe = this.#board.subscribeProjectEvents(projectId, (event) => {
      if (!write(event)) { remove(); response.end(); }
    });
    stream = { response, unsubscribe };
    this.#projectStreams.add(stream);
    request.once("close", remove);
    response.once("close", remove);
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    for (const event of this.#board.listProjectEvents(projectId, after)) {
      if (!write(event)) { remove(); response.end(); break; }
    }
  }

  async start(): Promise<TaskBoardAddress> {
    if (this.#started) throw new Error("TASK_BOARD_ALREADY_STARTED");
    if (this.#closing) throw new Error("TASK_BOARD_CLOSED");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(this.config.port, this.config.listenHost, () => {
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
    this.#closingAbort.abort();
    for (const stream of [...this.#documentStreams]) {
      stream.unsubscribe();
      stream.response.end();
      this.#documentStreams.delete(stream);
    }
    for (const stream of [...this.#projectStreams]) {
      stream.unsubscribe();
      stream.response.end();
      this.#projectStreams.delete(stream);
    }
    if (this.#started) {
      const stopped = new Promise<void>((resolve, reject) => {
        this.#server.close((error) => error ? reject(error) : resolve());
      });
      // Let aborted held requests end their responses, then close the keep-alive
      // sockets they leave behind instead of waiting out keepAliveTimeout.
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.#server.closeIdleConnections();
      await stopped;
      this.#started = false;
    }
    this.#board.close();
  }
}

export function createTaskBoardService(options: TaskBoardOptions): Promise<TaskBoardService> {
  return TaskBoardService.create(options);
}
