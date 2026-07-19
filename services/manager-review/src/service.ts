import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ReviewServiceError } from "./errors.js";
import {
  readJsonBody,
  requireEvidenceIssuer,
  requireHuman,
  requireManager,
  sendError,
  sendJson,
} from "./http.js";
import { parseFixedManagerIdentity } from "./schema.js";
import type { ManagerCredential, ManagerHandoffRegistrar } from "./types.js";
import { ManagerReviewWorkflow } from "./workflow.js";

export interface ManagerReviewServiceOptions {
  readonly workspaceId: string;
  readonly storePath: string;
  readonly evidenceIssuerToken: string;
  readonly evidenceIssuerPrincipal: string;
  readonly humanToken: string;
  readonly managers: readonly ManagerCredential[];
  readonly handoffRegistrar: ManagerHandoffRegistrar;
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly handoffRetryMs?: number;
  readonly now?: () => Date;
}

export interface ManagerReviewServiceConfig {
  readonly workspaceId: string;
  readonly storePath: string;
  readonly evidenceIssuerToken: string;
  readonly evidenceIssuerPrincipal: string;
  readonly humanToken: string;
  readonly managers: readonly ManagerCredential[];
  readonly handoffRegistrar: ManagerHandoffRegistrar;
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly handoffRetryMs: number;
  readonly now: (() => Date) | undefined;
}

export interface ManagerReviewServiceAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new ReviewServiceError(500, "INVALID_CONFIGURATION", `${field} is outside its safe range`);
  }
  return result;
}

function token(value: string, field: string): string {
  if (value.length < 32 || value.length > 512 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ReviewServiceError(500, "INVALID_CONFIGURATION", `${field} is invalid`);
  }
  return value;
}

function loopbackHost(value: string | undefined): string {
  const host = value ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new ReviewServiceError(
      500,
      "INVALID_CONFIGURATION",
      "Manager review HTTP must bind to a literal loopback address",
    );
  }
  return host;
}

function normalizeConfig(options: ManagerReviewServiceOptions): ManagerReviewServiceConfig {
  const evidenceIssuerToken = token(options.evidenceIssuerToken, "evidenceIssuerToken");
  const humanToken = token(options.humanToken, "humanToken");
  if (options.managers.length < 1 || options.managers.length > 128) {
    throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "One to 128 fixed managers are required");
  }
  const tokens = new Set([evidenceIssuerToken, humanToken]);
  if (tokens.size !== 2) throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Service tokens must be distinct");
  const bindings = new Set<string>();
  const agents = new Set<string>();
  const managers = options.managers.map((candidate, index): ManagerCredential => {
    const identity = parseFixedManagerIdentity({
      workspaceId: candidate.workspaceId,
      agentId: candidate.agentId,
      laneId: candidate.laneId,
      role: candidate.role,
    });
    if (identity.workspaceId !== options.workspaceId) {
      throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Manager workspace must match the served workspace");
    }
    const managerToken = token(candidate.token, `managers[${index}].token`);
    const binding = `${identity.workspaceId}\u0000${identity.agentId}\u0000${identity.laneId}`;
    if (bindings.has(binding) || agents.has(identity.agentId) || tokens.has(managerToken)) {
      throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Manager identities and tokens must be unique");
    }
    bindings.add(binding);
    agents.add(identity.agentId);
    tokens.add(managerToken);
    return Object.freeze({ ...identity, token: managerToken });
  });
  return Object.freeze({
    workspaceId: options.workspaceId,
    storePath: options.storePath,
    evidenceIssuerToken,
    evidenceIssuerPrincipal: options.evidenceIssuerPrincipal,
    humanToken,
    managers: Object.freeze(managers),
    handoffRegistrar: options.handoffRegistrar,
    host: loopbackHost(options.host),
    port: boundedInteger(options.port, 0, 0, 65_535, "port"),
    maxBodyBytes: boundedInteger(options.maxBodyBytes, 16 * 1_024, 1_024, 256 * 1_024, "maxBodyBytes"),
    handoffRetryMs: boundedInteger(options.handoffRetryMs, 5_000, 100, 300_000, "handoffRetryMs"),
    now: options.now,
  });
}

function routeUrl(value: string | undefined): URL {
  try {
    return new URL(value ?? "", "http://manager-review.invalid");
  } catch {
    throw new ReviewServiceError(400, "INVALID_REQUEST", "Request URL is invalid");
  }
}

function oneWorkspaceQuery(url: URL): string {
  if ([...url.searchParams.keys()].some((key) => key !== "workspaceId") || url.searchParams.getAll("workspaceId").length !== 1) {
    throw new ReviewServiceError(400, "INVALID_REQUEST", "Exactly one workspaceId query parameter is required");
  }
  const value = url.searchParams.get("workspaceId") ?? "";
  if (!value) throw new ReviewServiceError(400, "INVALID_REQUEST", "workspaceId is required");
  return value;
}

export class ManagerReviewService {
  readonly config: ManagerReviewServiceConfig;
  readonly #workflow: ManagerReviewWorkflow;
  readonly #server: Server;
  #retryTimer: NodeJS.Timeout | null = null;
  #retryPromise: Promise<void> | null = null;
  #closing = false;
  #started = false;

  private constructor(config: ManagerReviewServiceConfig, workflow: ManagerReviewWorkflow) {
    this.config = config;
    this.#workflow = workflow;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => sendError(response, error));
    });
    this.#server.requestTimeout = 15_000;
    this.#server.headersTimeout = 10_000;
    this.#server.keepAliveTimeout = 5_000;
    this.#server.maxHeadersCount = 32;
  }

  static async create(options: ManagerReviewServiceOptions): Promise<ManagerReviewService> {
    const config = normalizeConfig(options);
    const workflow = await ManagerReviewWorkflow.open({
      workspaceId: config.workspaceId,
      storePath: config.storePath,
      evidenceIssuerPrincipal: config.evidenceIssuerPrincipal,
      handoffRegistrar: config.handoffRegistrar,
      ...(config.now === undefined ? {} : { now: config.now }),
    });
    return new ManagerReviewService(config, workflow);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = routeUrl(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      if (url.search) throw new ReviewServiceError(400, "INVALID_REQUEST", "Health endpoint takes no query");
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (url.pathname === "/v1/passing-evidence" && request.method === "POST") {
      if (url.search) throw new ReviewServiceError(400, "INVALID_REQUEST", "Evidence endpoint takes no query");
      requireEvidenceIssuer(request, this.config);
      const result = await this.#workflow.registerEvidence(
        await readJsonBody(request, this.config.maxBodyBytes),
        typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : "",
      );
      sendJson(response, result.duplicate ? 200 : 201, result);
      return;
    }
    if (url.pathname === "/v1/manager-review-queue" && request.method === "GET") {
      const manager = requireManager(request, this.config);
      const workspaceId = oneWorkspaceQuery(url);
      if (workspaceId !== manager.workspaceId) {
        throw new ReviewServiceError(403, "MANAGER_WORKSPACE_MISMATCH", "Manager is not assigned to the requested workspace");
      }
      sendJson(response, 200, { items: this.#workflow.listManagerQueue(manager) });
      return;
    }
    const reviewMatch = /^\/v1\/passing-evidence\/([0-9a-f-]{36})\/reviews$/u.exec(url.pathname);
    if (reviewMatch && request.method === "POST") {
      if (url.search) throw new ReviewServiceError(400, "INVALID_REQUEST", "Review endpoint takes no query");
      const manager = requireManager(request, this.config);
      const result = await this.#workflow.recordManagerReview(
        reviewMatch[1]!,
        await readJsonBody(request, this.config.maxBodyBytes),
        manager,
        typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : "",
      );
      const status = result.duplicate
        ? 200
        : result.productionCheck?.status === "handoff_registration_pending"
          ? 202
          : 201;
      sendJson(response, status, result);
      return;
    }
    if (url.pathname === "/v1/production-checks" && request.method === "GET") {
      requireHuman(request, this.config);
      sendJson(response, 200, { items: this.#workflow.listProductionChecks(oneWorkspaceQuery(url)) });
      return;
    }
    if (url.pathname === "/v1/engineer-feedback" && request.method === "GET") {
      requireEvidenceIssuer(request, this.config);
      sendJson(response, 200, { items: this.#workflow.listEngineerFeedback(oneWorkspaceQuery(url)) });
      return;
    }
    throw new ReviewServiceError(404, "NOT_FOUND", "Endpoint was not found");
  }

  async start(): Promise<ManagerReviewServiceAddress> {
    if (this.#started) throw new Error("MANAGER_REVIEW_SERVICE_ALREADY_STARTED");
    if (this.#closing) throw new Error("MANAGER_REVIEW_SERVICE_CLOSED");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(this.config.port, this.config.host, () => {
        this.#server.off("error", onError);
        resolve();
      });
    });
    this.#started = true;
    this.#scheduleRetry();
    void this.#retryPending();
    const address = this.#server.address() as AddressInfo;
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
    return Object.freeze({ host: address.address, port: address.port, url: `http://${host}:${address.port}` });
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    if (this.#retryTimer) clearInterval(this.#retryTimer);
    this.#retryTimer = null;
    if (this.#started) {
      await new Promise<void>((resolve, reject) => this.#server.close((error) => error ? reject(error) : resolve()));
      this.#started = false;
    }
    await this.#retryPromise;
    await this.#workflow.close();
  }

  #scheduleRetry(): void {
    this.#retryTimer = setInterval(() => { void this.#retryPending(); }, this.config.handoffRetryMs);
    this.#retryTimer.unref();
  }

  #retryPending(): Promise<void> {
    if (this.#closing) return Promise.resolve();
    if (this.#retryPromise) return this.#retryPromise;
    const retry = this.#workflow.deliverPendingHandoffs()
      .catch(() => undefined)
      .finally(() => {
        if (this.#retryPromise === retry) this.#retryPromise = null;
      });
    this.#retryPromise = retry;
    return retry;
  }
}

export function createManagerReviewService(options: ManagerReviewServiceOptions): Promise<ManagerReviewService> {
  return ManagerReviewService.create(options);
}
