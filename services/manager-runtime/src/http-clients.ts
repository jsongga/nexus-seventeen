import {
  parseLeaseRenewalRequest,
  parseLeaseRenewalResult,
  parseRuntimeCommandPollRequest,
  parseRuntimeCommandPollResult,
  parseRuntimeEventBatch,
  parseRuntimeEventBatchReceipt,
  parseSupervisorRegistrationRequest,
  parseSupervisorRegistrationResult,
  type LeaseRenewalRequest,
  type LeaseRenewalResult,
  type RuntimeCommandPollRequest,
  type RuntimeCommandPollResult,
  type RuntimeEventBatch,
  type RuntimeEventBatchReceipt,
  type SupervisorRegistrationRequest,
} from "@cicada/steward-protocol";
import { parsePassingEngineerEvidence } from "./schema.js";
import type {
  ManagerReviewClient,
  ManagerReviewReceipt,
  ManagerReviewRequest,
  ManagerRegistrationSession,
  ManagerRuntimeClaim,
  ManagerRuntimeControlClient,
  PassingEngineerEvidence,
} from "./types.js";

export class ManagerRuntimeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ManagerRuntimeHttpError";
  }
}

interface HttpOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImplementation?: typeof fetch;
}

export const RUNTIME_PROOF_CHALLENGE_HEADER = "x-steward-runtime-proof-challenge" as const;
export const RUNTIME_GENERATION_PROOF_HEADER = "x-steward-runtime-generation-proof" as const;
export const RUNTIME_FEATURES_HEADER = "x-steward-runtime-features" as const;
export const RUNTIME_TYPED_TASKS_FEATURE = "typed-task-subjects+manager-review-recovery" as const;

interface JsonHttpResult {
  readonly body: unknown;
  readonly headers: Headers;
}

function checkedUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Service URL must be an HTTP(S) origin without path, credentials, query, or fragment");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) throw new Error("Plaintext HTTP is allowed only on exact loopback hosts");
  return url.toString().replace(/\/$/u, "");
}

function checkedToken(value: string): string {
  if (value.length < 32 || value.length > 512 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Runtime credential is invalid");
  }
  return value;
}

function integer(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} is invalid`);
  return parsed;
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} is invalid`);
  return value as Record<string, unknown>;
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
    throw new ManagerRuntimeHttpError("Service response Content-Length is invalid", response.status, null);
  }
  if (declared !== null && Number(declared) > maximum) {
    await response.body?.cancel();
    throw new ManagerRuntimeHttpError("Service response exceeds its size limit", response.status, null);
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    await response.body?.cancel();
    throw new ManagerRuntimeHttpError("Service response is not JSON", response.status, null);
  }
  if (!response.body) throw new ManagerRuntimeHttpError("Service response is empty", response.status, null);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new ManagerRuntimeHttpError("Service response exceeds its size limit", response.status, null);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try {
    return JSON.parse(combined.toString("utf8")) as unknown;
  } catch {
    throw new ManagerRuntimeHttpError("Service response is not valid JSON", response.status, null);
  }
}

class JsonHttpClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpOptions) {
    this.#baseUrl = checkedUrl(options.baseUrl);
    this.#token = checkedToken(options.token);
    this.#timeoutMs = integer(options.timeoutMs, 5_000, 100, 60_000, "timeoutMs");
    this.#maxResponseBytes = integer(options.maxResponseBytes, 1024 * 1024, 1_024, 16 * 1024 * 1024, "maxResponseBytes");
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
  }

  async request(
    method: "GET" | "POST",
    path: string,
    body: unknown | null,
    headers: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<JsonHttpResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#token}`,
          ...headers,
          ...(body === null ? {} : { "content-type": "application/json" }),
        },
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      const result = await boundedJson(response, this.#maxResponseBytes);
      if (!response.ok) {
        throw new ManagerRuntimeHttpError(`Service request failed with HTTP ${response.status}`, response.status, errorCode(result));
      }
      return { body: result, headers: response.headers };
    } catch (error) {
      if (error instanceof ManagerRuntimeHttpError) throw error;
      throw new ManagerRuntimeHttpError(signal?.aborted ? "Service request was canceled" : "Service request failed", null, null);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

export interface HttpManagerRuntimeControlClientOptions extends HttpOptions {}

export class HttpManagerRuntimeControlClient implements ManagerRuntimeControlClient {
  readonly #http: JsonHttpClient;
  constructor(options: HttpManagerRuntimeControlClientOptions) { this.#http = new JsonHttpClient(options); }

  async register(
    request: SupervisorRegistrationRequest,
    context: Readonly<{ runtimeProofChallenge: string; replacementProof: string | null }>,
    signal?: AbortSignal,
  ): Promise<ManagerRegistrationSession> {
    if (!/^rgc_[A-Za-z0-9_-]{43}$/u.test(context.runtimeProofChallenge)) {
      throw new Error("Runtime proof challenge is invalid");
    }
    if (context.replacementProof !== null && !/^rgp_[A-Za-z0-9_-]{43}$/u.test(context.replacementProof)) {
      throw new Error("Replacement runtime proof is invalid");
    }
    const response = await this.#http.request(
      "POST",
      "/v1/runtime/register",
      parseSupervisorRegistrationRequest(request),
      {
        [RUNTIME_PROOF_CHALLENGE_HEADER]: context.runtimeProofChallenge,
        [RUNTIME_FEATURES_HEADER]: RUNTIME_TYPED_TASKS_FEATURE,
        ...(context.replacementProof === null ? {} : { [RUNTIME_GENERATION_PROOF_HEADER]: context.replacementProof }),
      },
      signal,
    );
    const registration = parseSupervisorRegistrationResult(response.body);
    const runtimeGenerationProof = response.headers.get(RUNTIME_GENERATION_PROOF_HEADER);
    if (runtimeGenerationProof === null || !/^rgp_[A-Za-z0-9_-]{43}$/u.test(runtimeGenerationProof)) {
      throw new ManagerRuntimeHttpError("Registration response omitted its runtime generation proof", 502, null);
    }
    return Object.freeze({ ...registration, runtimeGenerationProof });
  }

  async renewLease(request: LeaseRenewalRequest, signal?: AbortSignal): Promise<LeaseRenewalResult> {
    return parseLeaseRenewalResult((await this.#http.request(
      "POST", "/v1/runtime/lease", parseLeaseRenewalRequest(request), {}, signal,
    )).body);
  }

  async uploadEvents(request: RuntimeEventBatch, signal?: AbortSignal): Promise<RuntimeEventBatchReceipt> {
    return parseRuntimeEventBatchReceipt((await this.#http.request(
      "POST", "/v1/runtime/events", parseRuntimeEventBatch(request), {}, signal,
    )).body);
  }

  async pollCommands(request: RuntimeCommandPollRequest, signal?: AbortSignal): Promise<RuntimeCommandPollResult> {
    const parsed = parseRuntimeCommandPollRequest(request);
    const query = new URLSearchParams({
      workspaceId: parsed.workspaceId,
      agentId: parsed.agentId,
      laneId: parsed.laneId,
      runtimeInstanceId: parsed.runtimeInstanceId,
      runtimeEpoch: String(parsed.runtimeEpoch),
      after: String(parsed.afterServerSequence),
    });
    return parseRuntimeCommandPollResult((await this.#http.request(
      "GET",
      `/v1/runtime/commands?${query.toString()}`,
      null,
      { [RUNTIME_FEATURES_HEADER]: RUNTIME_TYPED_TASKS_FEATURE },
      signal,
    )).body);
  }
}

export interface HttpManagerReviewClientOptions extends HttpOptions {}

function runtimeHeaders(claim: ManagerRuntimeClaim): Record<string, string> {
  return {
    "x-steward-runtime-instance-id": claim.runtimeInstanceId,
    "x-steward-runtime-epoch": String(claim.runtimeEpoch),
    [RUNTIME_GENERATION_PROOF_HEADER]: claim.runtimeGenerationProof,
  };
}

export class HttpManagerReviewClient implements ManagerReviewClient {
  readonly #http: JsonHttpClient;
  constructor(options: HttpManagerReviewClientOptions) { this.#http = new JsonHttpClient(options); }

  async listQueue(claim: ManagerRuntimeClaim, signal?: AbortSignal): Promise<readonly PassingEngineerEvidence[]> {
    const query = new URLSearchParams({ workspaceId: claim.workspaceId });
    const response = object((await this.#http.request(
      "GET", `/v1/manager-review-queue?${query.toString()}`, null, runtimeHeaders(claim), signal,
    )).body, "Manager review queue");
    if (Object.keys(response).length !== 1 || !Array.isArray(response.items)) throw new Error("Manager review queue shape is invalid");
    return Object.freeze(response.items.map((item) => parsePassingEngineerEvidence(item)));
  }

  async recordReview(
    claim: ManagerRuntimeClaim,
    evidenceId: string,
    request: ManagerReviewRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ManagerReviewReceipt> {
    if (!/^[0-9a-f-]{36}$/u.test(evidenceId)) throw new Error("evidenceId is invalid");
    const response = object((await this.#http.request(
      "POST",
      `/v1/passing-evidence/${evidenceId}/reviews`,
      request,
      { ...runtimeHeaders(claim), "idempotency-key": idempotencyKey },
      signal,
    )).body, "Manager review response");
    const review = object(response.review, "Manager review");
    if (typeof response.duplicate !== "boolean") throw new Error("Manager review duplicate marker is invalid");
    const duplicate = response.duplicate;
    if (
      review.reviewTaskId !== request.reviewTaskId ||
      review.evidenceId !== evidenceId ||
      review.evidenceDigest !== request.evidenceDigest ||
      review.decision !== request.decision ||
      review.managerAgentId !== claim.agentId ||
      review.managerLaneId !== claim.laneId ||
      (!duplicate && review.managerRuntimeInstanceId !== claim.runtimeInstanceId) ||
      (!duplicate && review.managerRuntimeEpoch !== claim.runtimeEpoch) ||
      typeof review.managerRuntimeInstanceId !== "string" ||
      !Number.isSafeInteger(review.managerRuntimeEpoch) ||
      Number(review.managerRuntimeEpoch) < 1 ||
      typeof review.managerReviewId !== "string"
    ) {
      throw new Error("Manager review response does not match the submitted decision");
    }
    return Object.freeze({
      managerReviewId: review.managerReviewId,
      reviewTaskId: request.reviewTaskId,
      evidenceId,
      evidenceDigest: request.evidenceDigest,
      decision: request.decision,
      managerRuntimeInstanceId: review.managerRuntimeInstanceId,
      managerRuntimeEpoch: Number(review.managerRuntimeEpoch),
      duplicate,
    });
  }
}
