import {
  parseManagerReviewPermitConsumeReceipt,
  STEWARD_RUNTIME_GENERATION_PROOF_HEADER,
  type ManagerReviewPermitConsumeReceipt,
  type ManagerReviewPermitConsumeRequest,
} from "@cicada/steward-protocol";
import { canonicalJson } from "./canonical.js";
import { ReviewServiceError } from "./errors.js";
import type { ManagerReviewPermitConsumer } from "./types.js";
import { optionalRuntimeGenerationProof } from "./runtime-generation-proof.js";

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 64 * 1_024;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface HttpControlPlaneManagerReviewPermitConsumerOptions {
  readonly controlPlaneOrigin: string;
  readonly permitConsumeToken: string;
  readonly maximumResponseBytes?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

function exactControlPlaneOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Control-plane permit origin is invalid");
  }
  const loopback =
    parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
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
      "Control-plane permit origin must be HTTPS, or loopback HTTP, without path, credentials, query, or fragment",
    );
  }
  return new URL(parsed.origin);
}

function token(value: string): string {
  if (
    value.length < 32 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Control-plane permit capability is invalid");
  }
  return value;
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

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(declared)) {
      await response.body?.cancel();
      throw new ReviewServiceError(
        502,
        "INVALID_CONTROL_PLANE_PERMIT_RESPONSE",
        "Control-plane permit Content-Length is invalid",
      );
    }
    if (Number(declared) > maximumBytes) {
      await response.body?.cancel();
      throw new ReviewServiceError(
        502,
        "CONTROL_PLANE_PERMIT_RESPONSE_TOO_LARGE",
        "Control-plane permit response exceeded its fixed limit",
      );
    }
  }
  if (response.body === null) {
    throw new ReviewServiceError(
      502,
      "INVALID_CONTROL_PLANE_PERMIT_RESPONSE",
      "Control-plane permit response had no body",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new ReviewServiceError(
          502,
          "CONTROL_PLANE_PERMIT_RESPONSE_TOO_LARGE",
          "Control-plane permit response exceeded its fixed limit",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")) as unknown;
  } catch {
    throw new ReviewServiceError(
      502,
      "INVALID_CONTROL_PLANE_PERMIT_RESPONSE",
      "Control-plane permit response was not valid JSON",
    );
  }
}

function stableReceiptBinding(receipt: ManagerReviewPermitConsumeReceipt): Record<string, unknown> {
  return {
    operationId: receipt.operationId,
    workspaceId: receipt.workspaceId,
    reviewTaskId: receipt.reviewTaskId,
    sourceTaskId: receipt.sourceTaskId,
    evidenceId: receipt.evidenceId,
    evidenceDigest: receipt.evidenceDigest,
    managerAgentId: receipt.managerAgentId,
    managerLaneId: receipt.managerLaneId,
    reviewRequestDigest: receipt.reviewRequestDigest,
  };
}

function stableRequestBinding(request: ManagerReviewPermitConsumeRequest): Record<string, unknown> {
  return {
    operationId: request.operationId,
    workspaceId: request.workspaceId,
    reviewTaskId: request.reviewTaskId,
    sourceTaskId: request.sourceTaskId,
    evidenceId: request.evidenceId,
    evidenceDigest: request.evidenceDigest,
    managerAgentId: request.managerAgentId,
    managerLaneId: request.managerLaneId,
    reviewRequestDigest: request.reviewRequestDigest,
  };
}

export class HttpControlPlaneManagerReviewPermitConsumer implements ManagerReviewPermitConsumer {
  readonly #endpoint: URL;
  readonly #permitConsumeToken: string;
  readonly #maximumResponseBytes: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: HttpControlPlaneManagerReviewPermitConsumerOptions) {
    this.#endpoint = new URL(
      "/v1/internal/manager-review-permits/consume",
      exactControlPlaneOrigin(options.controlPlaneOrigin),
    );
    this.#permitConsumeToken = token(options.permitConsumeToken);
    this.#maximumResponseBytes = boundedInteger(
      options.maximumResponseBytes,
      DEFAULT_MAXIMUM_RESPONSE_BYTES,
      1_024,
      2 * 1_024 * 1_024,
      "maximumResponseBytes",
    );
    this.#timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 60_000, "timeoutMs");
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (this.#fetch === undefined) {
      throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "This Node runtime does not provide fetch");
    }
  }

  async consumeManagerReviewPermit(
    request: ManagerReviewPermitConsumeRequest,
  ): Promise<ManagerReviewPermitConsumeReceipt> {
    const runtimeGenerationProof = optionalRuntimeGenerationProof();
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#permitConsumeToken}`,
          "Content-Type": "application/json",
          ...(runtimeGenerationProof === undefined
            ? {}
            : { [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]: runtimeGenerationProof }),
        },
        body: JSON.stringify(request),
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new ReviewServiceError(
        503,
        "CONTROL_PLANE_PERMIT_UNAVAILABLE",
        "Control-plane manager-review permit authority is unavailable",
        { cause: error },
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status === 409 ? 409 : 503;
      throw new ReviewServiceError(
        status,
        "CONTROL_PLANE_PERMIT_REJECTED",
        "Control-plane manager-review permit authority rejected the request",
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
      await response.body?.cancel();
      throw new ReviewServiceError(
        502,
        "INVALID_CONTROL_PLANE_PERMIT_RESPONSE",
        "Control-plane permit response was not JSON",
      );
    }

    let receipt: ManagerReviewPermitConsumeReceipt;
    try {
      receipt = parseManagerReviewPermitConsumeReceipt(
        await boundedJson(response, this.#maximumResponseBytes),
      );
    } catch (error) {
      if (error instanceof ReviewServiceError) throw error;
      throw new ReviewServiceError(
        502,
        "INVALID_CONTROL_PLANE_PERMIT_RESPONSE",
        "Control-plane permit response violated the Steward runtime protocol",
        { cause: error },
      );
    }
    if (canonicalJson(stableReceiptBinding(receipt)) !== canonicalJson(stableRequestBinding(request))) {
      throw new ReviewServiceError(
        502,
        "INVALID_CONTROL_PLANE_PERMIT_RESPONSE",
        "Control-plane permit response changed its stable review binding",
      );
    }
    if (
      receipt.state === "accepted" &&
      (receipt.managerRuntimeInstanceId !== request.runtimeInstanceId ||
        receipt.managerRuntimeEpoch !== request.runtimeEpoch)
    ) {
      throw new ReviewServiceError(
        502,
        "INVALID_CONTROL_PLANE_PERMIT_RESPONSE",
        "New control-plane permit response changed its authorizing runtime",
      );
    }
    return receipt;
  }
}
