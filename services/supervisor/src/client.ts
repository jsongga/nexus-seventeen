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
  type SupervisorRegistrationResult,
} from "@cicada/steward-protocol";

export interface SupervisorControlPlaneClient {
  register(request: SupervisorRegistrationRequest): Promise<SupervisorRegistrationResult>;
  renewLease(request: LeaseRenewalRequest, signal?: AbortSignal): Promise<LeaseRenewalResult>;
  uploadEvents(request: RuntimeEventBatch): Promise<RuntimeEventBatchReceipt>;
  pollCommands(request: RuntimeCommandPollRequest, signal?: AbortSignal): Promise<RuntimeCommandPollResult>;
}

export interface HttpSupervisorControlPlaneClientOptions {
  controlPlaneUrl: string;
  supervisorToken: string;
  timeoutMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxResponseBytes?: number;
  fetchImplementation?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

type ResponseParser<T> = (value: unknown) => T;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 100;
const DEFAULT_MAX_BACKOFF_MS = 2_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

function integerInRange(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function errorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function canceledRequestError(): ControlPlaneUnavailableError {
  return new ControlPlaneUnavailableError("Control-plane request was canceled", { retryable: false });
}

async function sleepWithSignal(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await sleep(milliseconds);
    return;
  }
  if (signal.aborted) throw canceledRequestError();
  let removeListener: () => void = () => undefined;
  const canceled = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(canceledRequestError());
    signal.addEventListener("abort", onAbort, { once: true });
    removeListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    await Promise.race([sleep(milliseconds), canceled]);
  } finally {
    removeListener();
  }
}

function endpoint(baseUrl: string, pathname: string): URL {
  return new URL(`${baseUrl.replace(/\/$/, "")}${pathname}`);
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    await response.body?.cancel();
    throw new ControlPlaneUnavailableError("Control-plane response exceeds the configured size limit", {
      retryable: false,
      status: response.status,
    });
  }
  if (!response.body) {
    throw new ControlPlaneUnavailableError("Control-plane response body is empty", {
      retryable: false,
      status: response.status,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ControlPlaneUnavailableError("Control-plane response exceeds the configured size limit", {
          retryable: false,
          status: response.status,
        });
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ControlPlaneUnavailableError("Control-plane response is not valid JSON", {
      retryable: false,
      status: response.status,
      cause: error,
    });
  }
}

export class HttpSupervisorControlPlaneClient implements SupervisorControlPlaneClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;

  constructor(options: HttpSupervisorControlPlaneClientOptions) {
    const url = new URL(options.controlPlaneUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
      throw new Error("controlPlaneUrl must be an HTTP(S) URL without embedded credentials, query parameters, or a fragment");
    }
    const loopbackHost = url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]";
    if (url.protocol === "http:" && !loopbackHost) {
      throw new Error("controlPlaneUrl may use plaintext HTTP only for exact loopback hosts");
    }
    if (typeof options.supervisorToken !== "string" || options.supervisorToken.length < 16) {
      throw new Error("supervisorToken must contain at least 16 characters");
    }
    this.#baseUrl = url.toString().replace(/\/$/, "");
    this.#token = options.supervisorToken;
    this.#timeoutMs = integerInRange(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", 100, 60_000);
    this.#maxAttempts = integerInRange(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "maxAttempts", 1, 5);
    this.#baseBackoffMs = integerInRange(options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS, "baseBackoffMs", 0, 5_000);
    this.#maxBackoffMs = integerInRange(options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS, "maxBackoffMs", 0, 30_000);
    if (this.#maxBackoffMs < this.#baseBackoffMs) throw new Error("maxBackoffMs must not be less than baseBackoffMs");
    this.#maxResponseBytes = integerInRange(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
      1_024,
      16 * 1024 * 1024,
    );
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  register(request: SupervisorRegistrationRequest): Promise<SupervisorRegistrationResult> {
    return this.#post(
      "/v1/runtime/register",
      parseSupervisorRegistrationRequest(request),
      parseSupervisorRegistrationResult,
    );
  }

  renewLease(request: LeaseRenewalRequest, signal?: AbortSignal): Promise<LeaseRenewalResult> {
    return this.#post("/v1/runtime/lease", parseLeaseRenewalRequest(request), parseLeaseRenewalResult, signal);
  }

  uploadEvents(request: RuntimeEventBatch): Promise<RuntimeEventBatchReceipt> {
    return this.#post("/v1/runtime/events", parseRuntimeEventBatch(request), parseRuntimeEventBatchReceipt);
  }

  pollCommands(request: RuntimeCommandPollRequest, signal?: AbortSignal): Promise<RuntimeCommandPollResult> {
    const parsed = parseRuntimeCommandPollRequest(request);
    const url = endpoint(this.#baseUrl, "/v1/runtime/commands");
    url.searchParams.set("workspaceId", parsed.workspaceId);
    url.searchParams.set("agentId", parsed.agentId);
    url.searchParams.set("laneId", parsed.laneId);
    url.searchParams.set("runtimeInstanceId", parsed.runtimeInstanceId);
    url.searchParams.set("runtimeEpoch", String(parsed.runtimeEpoch));
    url.searchParams.set("after", String(parsed.afterServerSequence));
    return this.#request("GET", url, null, parseRuntimeCommandPollResult, signal);
  }

  #post<T>(pathname: string, body: unknown, parser: ResponseParser<T>, signal?: AbortSignal): Promise<T> {
    return this.#request("POST", endpoint(this.#baseUrl, pathname), body, parser, signal);
  }

  async #request<T>(
    method: "GET" | "POST",
    url: URL,
    body: unknown | null,
    parser: ResponseParser<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let lastError: ControlPlaneUnavailableError | null = null;
    for (let attempt = 0; attempt < this.#maxAttempts; attempt += 1) {
      if (signal?.aborted) throw canceledRequestError();
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.#timeoutMs);
      const cancelFromCaller = () => controller.abort();
      signal?.addEventListener("abort", cancelFromCaller, { once: true });
      try {
        const requestInit: RequestInit = {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.#token}`,
            ...(body === null ? {} : { "content-type": "application/json" }),
          },
          signal: controller.signal,
          ...(body === null ? {} : { body: JSON.stringify(body) }),
        };
        const response = await this.#fetch(url, requestInit);
        if (!response.ok) {
          let code: string | null = null;
          try {
            code = errorCode(await readBoundedJson(response, this.#maxResponseBytes));
          } catch {
            await response.body?.cancel().catch(() => undefined);
          }
          const retryable = retryableStatus(response.status);
          throw new ControlPlaneUnavailableError(`Control-plane request failed with HTTP ${response.status}`, {
            retryable,
            status: response.status,
            code,
          });
        }
        const value = await readBoundedJson(response, this.#maxResponseBytes);
        try {
          return parser(value);
        } catch (error) {
          throw new ControlPlaneUnavailableError("Control-plane response failed Steward protocol validation", {
            retryable: false,
            status: response.status,
            cause: error,
          });
        }
      } catch (error) {
        const normalized = signal?.aborted
          ? canceledRequestError()
          : error instanceof ControlPlaneUnavailableError
            ? error
            : new ControlPlaneUnavailableError(
                timedOut ? "Control-plane request timed out" : "Control-plane request could not be completed",
                { retryable: true, cause: error },
              );
        lastError = normalized;
        if (!normalized.retryable || attempt + 1 >= this.#maxAttempts) throw normalized;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancelFromCaller);
      }

      const exponential = Math.min(this.#maxBackoffMs, this.#baseBackoffMs * (2 ** attempt));
      const jittered = Math.floor(exponential * (0.5 + Math.max(0, Math.min(1, this.#random())) * 0.5));
      await sleepWithSignal(this.#sleep, jittered, signal);
    }
    throw lastError ?? new ControlPlaneUnavailableError("Control-plane request failed", { retryable: true });
  }
}

/*
 * Kept as a distinct error so the daemon can enter offline hold without ever
 * including request headers or response bodies in logs/checkpoints.
 */
export class ControlPlaneUnavailableError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  readonly code: string | null;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      status?: number | null;
      code?: string | null;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ControlPlaneUnavailableError";
    this.retryable = options.retryable;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}
