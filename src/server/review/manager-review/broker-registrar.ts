import { canonicalJson } from "./canonical.js";
import { ReviewServiceError } from "./errors.js";
import { parseHandoffResult } from "./schema.js";
import type {
  ManagerHandoffRegistrar,
  RegisterManagerHandoffRequest,
  RegisterManagerHandoffResult,
} from "./types.js";

const MAX_RESPONSE_BYTES = 64 * 1_024;

export interface HttpManagerHandoffRegistrarOptions {
  readonly brokerOrigin: string;
  readonly handoffIssuerToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

function brokerOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Broker origin is invalid");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.pathname !== "/"
  ) {
    throw new ReviewServiceError(
      500,
      "INVALID_CONFIGURATION",
      "Broker origin must be HTTPS, or loopback HTTP, without path, credentials, query, or fragment",
    );
  }
  return new URL(parsed.origin);
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new ReviewServiceError(502, "BROKER_RESPONSE_TOO_LARGE", "Broker response exceeded its fixed limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ReviewServiceError(502, "BROKER_RESPONSE_TOO_LARGE", "Broker response exceeded its fixed limit");
    }
    chunks.push(next.value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ReviewServiceError(502, "INVALID_BROKER_RESPONSE", "Broker response was not valid JSON");
  }
}

export class HttpManagerHandoffRegistrar implements ManagerHandoffRegistrar {
  readonly #endpoint: URL;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: HttpManagerHandoffRegistrarOptions) {
    this.#endpoint = new URL("/v1/manager-handoffs", brokerOrigin(options.brokerOrigin));
    if (options.handoffIssuerToken.length < 32 || options.handoffIssuerToken.length > 512) {
      throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Broker handoff issuer token is invalid");
    }
    this.#token = options.handoffIssuerToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Broker timeout is invalid");
    }
    this.#timeoutMs = timeoutMs;
  }

  async registerManagerHandoff(
    request: RegisterManagerHandoffRequest,
    idempotencyKey: string,
  ): Promise<RegisterManagerHandoffResult> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(request),
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new ReviewServiceError(503, "BROKER_UNAVAILABLE", "Manager handoff broker is unavailable", { cause: error });
    }
    const body = await boundedJson(response);
    if (!response.ok) {
      throw new ReviewServiceError(503, "BROKER_REJECTED_HANDOFF", "Manager handoff broker rejected the request");
    }
    const result = parseHandoffResult(body);
    const returnedRequest = {
      workspaceId: result.handoff.workspaceId,
      taskId: result.handoff.taskId,
      releaseArtifactDigest: result.handoff.releaseArtifactDigest,
      releaseManifestDigest: result.handoff.releaseManifestDigest,
      targetEnvironment: result.handoff.targetEnvironment,
      managerAgentId: result.handoff.managerAgentId,
      managerReviewId: result.handoff.managerReviewId,
      reviewedAt: result.handoff.reviewedAt,
    };
    if (canonicalJson(returnedRequest) !== canonicalJson(request)) {
      throw new ReviewServiceError(502, "INVALID_BROKER_RESPONSE", "Broker returned a different handoff binding");
    }
    return result;
  }
}
