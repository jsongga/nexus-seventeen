import {
  STEWARD_UI_API_VERSION,
  parseUiBootstrap,
  type UiBootstrap,
} from "#shared/protocol";
import { ReviewServiceError } from "./errors.js";
import { parseManagerRuntimeClaim } from "./schema.js";
import type { ManagerRuntimeAuthorizer, ManagerRuntimeClaim } from "./types.js";

const DEFAULT_MAXIMUM_BOOTSTRAP_BYTES = 512 * 1_024;
const DEFAULT_MAXIMUM_SNAPSHOT_AGE_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface HttpControlPlaneManagerAuthorizerOptions {
  readonly controlPlaneOrigin: string;
  readonly observerReadToken: string;
  readonly maximumBootstrapBytes?: number;
  readonly maximumSnapshotAgeMs?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new ReviewServiceError(500, "INVALID_CONFIGURATION", `${field} is outside its safe range`);
  }
  return resolved;
}

function exactControlPlaneOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Control-plane origin is invalid");
  }
  const loopback = parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ReviewServiceError(
      500,
      "INVALID_CONFIGURATION",
      "Control-plane origin must be HTTPS, or exact-loopback HTTP, without path, credentials, query, or fragment",
    );
  }
  return new URL(parsed.origin);
}

function observerToken(value: string): string {
  if (
    value.length < 16 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Control-plane observer token is invalid");
  }
  return value;
}

function exactNow(now: () => Date): Date {
  const result = now();
  if (!(result instanceof Date) || Number.isNaN(result.valueOf())) {
    throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Manager runtime authority clock is invalid");
  }
  return result;
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(declared)) {
      await response.body?.cancel();
      throw new ReviewServiceError(502, "INVALID_CONTROL_PLANE_RESPONSE", "Control-plane Content-Length is invalid");
    }
    if (Number(declared) > maximumBytes) {
      await response.body?.cancel();
      throw new ReviewServiceError(502, "CONTROL_PLANE_RESPONSE_TOO_LARGE", "Control-plane bootstrap exceeded its fixed limit");
    }
  }
  if (response.body === null) {
    throw new ReviewServiceError(502, "INVALID_CONTROL_PLANE_RESPONSE", "Control-plane bootstrap had no body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new ReviewServiceError(502, "CONTROL_PLANE_RESPONSE_TOO_LARGE", "Control-plane bootstrap exceeded its fixed limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")) as unknown;
  } catch {
    throw new ReviewServiceError(502, "INVALID_CONTROL_PLANE_RESPONSE", "Control-plane bootstrap was not valid JSON");
  }
}

function canonicalTimestamp(value: string, field: string): number {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new ReviewServiceError(502, "INVALID_CONTROL_PLANE_RESPONSE", `${field} is not canonical`);
  }
  return parsed.valueOf();
}

/**
 * Checks a fresh, read-only control-plane snapshot for every manager operation.
 * This fences stale epochs and current hold/interrupt state, but it is not an
 * atomic permit: a control command committed after this snapshot can still race
 * workflow persistence. The interface allows an atomic permit to replace this
 * alpha implementation without changing review workflow behavior.
 */
export class HttpControlPlaneManagerAuthorizer implements ManagerRuntimeAuthorizer {
  readonly #origin: URL;
  readonly #observerReadToken: string;
  readonly #maximumBootstrapBytes: number;
  readonly #maximumSnapshotAgeMs: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;

  constructor(options: HttpControlPlaneManagerAuthorizerOptions) {
    this.#origin = exactControlPlaneOrigin(options.controlPlaneOrigin);
    this.#observerReadToken = observerToken(options.observerReadToken);
    this.#maximumBootstrapBytes = boundedInteger(
      options.maximumBootstrapBytes,
      DEFAULT_MAXIMUM_BOOTSTRAP_BYTES,
      1_024,
      2 * 1_024 * 1_024,
      "maximumBootstrapBytes",
    );
    this.#maximumSnapshotAgeMs = boundedInteger(
      options.maximumSnapshotAgeMs,
      DEFAULT_MAXIMUM_SNAPSHOT_AGE_MS,
      100,
      30_000,
      "maximumSnapshotAgeMs",
    );
    this.#timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 60_000, "timeoutMs");
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (this.#fetch === undefined) {
      throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "This Node runtime does not provide fetch");
    }
    this.#now = options.now ?? (() => new Date());
  }

  async authorizeManagerRuntime(claim: ManagerRuntimeClaim): Promise<void> {
    const parsedClaim = parseManagerRuntimeClaim(claim);
    const endpoint = new URL("/v1/ui/bootstrap", this.#origin);
    endpoint.searchParams.set("workspaceId", parsedClaim.workspaceId);
    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#observerReadToken}`,
          "X-Steward-UI-Version": STEWARD_UI_API_VERSION,
        },
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new ReviewServiceError(
        503,
        "CONTROL_PLANE_UNAVAILABLE",
        "Control-plane runtime authority is unavailable",
        { cause: error },
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ReviewServiceError(
        503,
        "CONTROL_PLANE_UNAVAILABLE",
        "Control-plane runtime authority rejected the request",
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
      await response.body?.cancel();
      throw new ReviewServiceError(502, "INVALID_CONTROL_PLANE_RESPONSE", "Control-plane bootstrap was not JSON");
    }

    let bootstrap: UiBootstrap;
    try {
      bootstrap = parseUiBootstrap(await boundedJson(response, this.#maximumBootstrapBytes));
    } catch (error) {
      if (error instanceof ReviewServiceError) throw error;
      throw new ReviewServiceError(
        502,
        "INVALID_CONTROL_PLANE_RESPONSE",
        "Control-plane bootstrap violated the Steward UI protocol",
        { cause: error },
      );
    }

    if (
      bootstrap.sessionId !== "session_impact_observer" ||
      bootstrap.userId !== "impact_observer" ||
      bootstrap.permissions.length !== 1 ||
      bootstrap.permissions[0] !== "workspace:read" ||
      bootstrap.features.length !== 2 ||
      !bootstrap.features.includes("durable-replay") ||
      !bootstrap.features.includes("runtime-fencing") ||
      bootstrap.commandEndpoint !== "/v1/ui/commands/disabled"
    ) {
      throw new ReviewServiceError(
        502,
        "CONTROL_PLANE_AUTHORITY_NOT_READ_ONLY",
        "Control-plane observer identity is not strictly read-only",
      );
    }
    if (bootstrap.snapshot.workspaceId !== parsedClaim.workspaceId) {
      throw new ReviewServiceError(409, "MANAGER_RUNTIME_FENCED", "Manager runtime belongs to another workspace");
    }

    const nowMs = exactNow(this.#now).valueOf();
    const generatedAtMs = canonicalTimestamp(bootstrap.snapshot.generatedAt, "snapshot.generatedAt");
    if (
      generatedAtMs < nowMs - this.#maximumSnapshotAgeMs ||
      generatedAtMs > nowMs + this.#maximumSnapshotAgeMs
    ) {
      throw new ReviewServiceError(409, "MANAGER_AUTHORITY_SNAPSHOT_STALE", "Control-plane authority snapshot is not fresh");
    }
    if (bootstrap.snapshot.paused) {
      throw new ReviewServiceError(409, "MANAGER_RUNTIME_HELD", "Workspace is paused");
    }

    const identityCandidates = bootstrap.snapshot.agents.filter(
      (agent) => agent.laneId === parsedClaim.laneId || agent.agentId === parsedClaim.agentId,
    );
    const lane = identityCandidates.length === 1 ? identityCandidates[0] : undefined;
    if (
      lane === undefined ||
      lane.workspaceId !== parsedClaim.workspaceId ||
      lane.laneId !== parsedClaim.laneId ||
      lane.agentId !== parsedClaim.agentId ||
      lane.role !== "manager" ||
      lane.runtimeInstanceId !== parsedClaim.runtimeInstanceId ||
      lane.runtimeEpoch !== parsedClaim.runtimeEpoch
    ) {
      throw new ReviewServiceError(409, "MANAGER_RUNTIME_FENCED", "Manager runtime was replaced or is not registered");
    }
    if (lane.controlVersion !== bootstrap.snapshot.controlVersion) {
      throw new ReviewServiceError(502, "INVALID_CONTROL_PLANE_RESPONSE", "Manager control version does not match its snapshot");
    }
    const leaseExpiresAtMs = canonicalTimestamp(lane.leaseExpiresAt, "manager.leaseExpiresAt");
    const lastSeenAtMs = canonicalTimestamp(lane.lastSeenAt, "manager.lastSeenAt");
    if (lastSeenAtMs > generatedAtMs) {
      throw new ReviewServiceError(502, "INVALID_CONTROL_PLANE_RESPONSE", "Manager last-seen time is ahead of its snapshot");
    }
    if (lane.connectionState !== "online" || leaseExpiresAtMs <= Math.max(nowMs, generatedAtMs)) {
      throw new ReviewServiceError(409, "MANAGER_RUNTIME_OFFLINE", "Manager runtime lease is not active");
    }
    if (lane.controlState !== "active") {
      throw new ReviewServiceError(409, "MANAGER_RUNTIME_NOT_ACTIVE", "Manager runtime is interrupted, paused, or held");
    }
  }
}
