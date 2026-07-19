import {
  ProtocolValidationError,
  STEWARD_UI_API_VERSION,
  parseUiBootstrap,
  parseUiEventEnvelope,
  type UiBootstrap,
  type UiEventEnvelope,
  type WorkspaceId,
} from "@cicada/steward-protocol";
import type { ImpactEventSource } from "./types.js";

export class ImpactSourceError extends Error {
  readonly retryable: boolean;
  readonly status: number;

  constructor(message: string, options: { readonly retryable: boolean; readonly status?: number }) {
    super(message);
    this.name = "ImpactSourceError";
    this.retryable = options.retryable;
    this.status = options.status ?? 0;
  }
}

export interface HttpImpactEventSourceOptions {
  readonly controlPlaneOrigin: string;
  readonly workspaceId: WorkspaceId;
  readonly readToken: string;
  readonly maximumBootstrapBytes?: number;
  readonly maximumSseEventBytes?: number;
  readonly fetch?: typeof fetch;
}

function originUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("controlPlaneOrigin must be an absolute HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error("controlPlaneOrigin must be an HTTP(S) origin without credentials, path, query, or fragment");
  }
  const loopback = parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";
  if (parsed.protocol === "http:" && !loopback) {
    throw new Error("controlPlaneOrigin requires HTTPS except on loopback");
  }
  return new URL(parsed.origin);
}

function relativeUrl(origin: URL, path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("#")) {
    throw new ImpactSourceError("The control plane advertised an unsafe event path", { retryable: false });
  }
  const target = new URL(path, origin);
  if (target.origin !== origin.origin || target.username.length > 0 || target.password.length > 0) {
    throw new ImpactSourceError("The control plane advertised a cross-origin event path", { retryable: false });
  }
  return target;
}

async function boundedText(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new ImpactSourceError("The control-plane response exceeded the observer limit", { retryable: false });
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new ImpactSourceError("The control-plane response exceeded the observer limit", { retryable: false });
      }
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function responseError(response: Response, context: string): ImpactSourceError {
  if (response.status === 401 || response.status === 403 || response.status === 426) {
    return new ImpactSourceError(`${context} was rejected with HTTP ${response.status}`, {
      retryable: false,
      status: response.status,
    });
  }
  return new ImpactSourceError(`${context} failed with HTTP ${response.status}`, {
    retryable: true,
    status: response.status,
  });
}

export class HttpImpactEventSource implements ImpactEventSource {
  readonly #origin: URL;
  readonly #workspaceId: WorkspaceId;
  readonly #readToken: string;
  readonly #maximumBootstrapBytes: number;
  readonly #maximumSseEventBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpImpactEventSourceOptions) {
    this.#origin = originUrl(options.controlPlaneOrigin);
    this.#workspaceId = options.workspaceId;
    this.#readToken = options.readToken.trim();
    if (this.#readToken.length < 16) throw new Error("readToken must be at least 16 characters");
    this.#maximumBootstrapBytes = options.maximumBootstrapBytes ?? 512 * 1_024;
    this.#maximumSseEventBytes = options.maximumSseEventBytes ?? 256 * 1_024;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (this.#fetch === undefined) throw new Error("This Node runtime does not provide fetch");
  }

  async bootstrap(signal?: AbortSignal): Promise<UiBootstrap> {
    const endpoint = new URL("/v1/ui/bootstrap", this.#origin);
    endpoint.searchParams.set("workspaceId", this.#workspaceId);
    const response = await this.#fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.#readToken}`,
        Accept: "application/json",
        "X-Steward-UI-Version": STEWARD_UI_API_VERSION,
      },
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw responseError(response, "Impact bootstrap");
    let decoded: unknown;
    try {
      decoded = JSON.parse(await boundedText(response, this.#maximumBootstrapBytes)) as unknown;
    } catch (error) {
      if (error instanceof ImpactSourceError) throw error;
      throw new ImpactSourceError("Impact bootstrap was not valid bounded JSON", { retryable: false });
    }
    let bootstrap: UiBootstrap;
    try {
      bootstrap = parseUiBootstrap(decoded);
    } catch (error) {
      const detail = error instanceof ProtocolValidationError ? `: ${error.message}` : "";
      throw new ImpactSourceError(`Impact bootstrap violated the UI protocol${detail}`, { retryable: false });
    }
    if (bootstrap.snapshot.workspaceId !== this.#workspaceId) {
      throw new ImpactSourceError("Impact bootstrap belongs to another workspace", { retryable: false });
    }
    if (
      !bootstrap.permissions.includes("workspace:read") ||
      bootstrap.permissions.includes("workspace:control")
    ) {
      throw new ImpactSourceError(
        "Impact observer requires a read-only control-plane identity",
        { retryable: false },
      );
    }
    relativeUrl(this.#origin, bootstrap.eventStream.href);
    return bootstrap;
  }

  async stream(
    bootstrap: UiBootstrap,
    afterSequence: number,
    onEvent: (event: UiEventEnvelope) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new ImpactSourceError("Impact cursor must be a non-negative safe integer", { retryable: false });
    }
    const endpoint = relativeUrl(this.#origin, bootstrap.eventStream.href);
    endpoint.searchParams.set("after", String(afterSequence));
    const controller = new AbortController();
    let heartbeatExpired = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    const forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const refreshHeartbeat = () => {
      if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        heartbeatExpired = true;
        controller.abort();
      }, Math.min(900_000, bootstrap.eventStream.heartbeatIntervalMs * 3 + 1_000));
      heartbeatTimer.unref();
    };

    try {
      const response = await this.#fetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.#readToken}`,
          Accept: "text/event-stream",
          "X-Steward-UI-Version": STEWARD_UI_API_VERSION,
          "Last-Event-ID": String(afterSequence),
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw responseError(response, "Impact event stream");
      if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream")) {
        await response.body?.cancel();
        throw new ImpactSourceError("Impact event stream returned an unexpected content type", { retryable: false });
      }
      if (response.body === null) {
        throw new ImpactSourceError("Impact event stream returned no body", { retryable: true });
      }
      refreshHeartbeat();
      await this.#consumeSse(response.body, onEvent, refreshHeartbeat, controller.signal);
      if (!signal?.aborted) throw new ImpactSourceError("Impact event stream ended", { retryable: true });
    } catch (error) {
      if (signal?.aborted) return;
      if (heartbeatExpired) {
        throw new ImpactSourceError("Impact event stream heartbeat expired", { retryable: true });
      }
      if (error instanceof ImpactSourceError) throw error;
      if (abortError(error)) throw new ImpactSourceError("Impact event stream was interrupted", { retryable: true });
      throw new ImpactSourceError("Impact event stream transport failed", { retryable: true });
    } finally {
      if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
      signal?.removeEventListener("abort", forwardAbort);
      controller.abort();
    }
  }

  async #consumeSse(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: UiEventEnvelope) => Promise<void>,
    onActivity: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = "";
    let data: string[] = [];
    let eventName = "";
    let eventId = "";
    let eventBytes = 0;
    let shutdown = false;

    const reset = () => {
      data = [];
      eventName = "";
      eventId = "";
      eventBytes = 0;
    };
    const acceptLine = async (line: string, terminatorBytes: number): Promise<void> => {
      eventBytes += encoder.encode(line).byteLength + terminatorBytes;
      if (eventBytes > this.#maximumSseEventBytes) {
        throw new ImpactSourceError("Impact event exceeded the configured size", { retryable: false });
      }
      if (line.length === 0) {
        if (eventName === "shutdown") {
          shutdown = true;
          return;
        }
        if (data.length === 0) {
          reset();
          return;
        }
        if (eventName !== "" && eventName !== "steward.event") {
          throw new ImpactSourceError("Impact event stream used an unsupported event type", { retryable: false });
        }
        let event: UiEventEnvelope;
        try {
          event = parseUiEventEnvelope(JSON.parse(data.join("\n")) as unknown);
        } catch (error) {
          const detail = error instanceof ProtocolValidationError ? `: ${error.message}` : "";
          throw new ImpactSourceError(`Impact event violated the UI protocol${detail}`, { retryable: false });
        }
        if (eventId !== "" && eventId !== String(event.sequence)) {
          throw new ImpactSourceError("Impact SSE id did not match its event sequence", { retryable: false });
        }
        reset();
        await onEvent(event);
        return;
      }
      if (line.startsWith(":")) return;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      if (field === "event") eventName = value;
      if (field === "id") eventId = value;
    };
    const drain = async (final: boolean): Promise<void> => {
      while (!shutdown) {
        const lf = pending.indexOf("\n");
        const cr = pending.indexOf("\r");
        const boundary = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
        if (boundary < 0) break;
        if (pending[boundary] === "\r" && boundary === pending.length - 1 && !final) break;
        const crlf = pending[boundary] === "\r" && pending[boundary + 1] === "\n";
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + (crlf ? 2 : 1));
        await acceptLine(line, crlf ? 2 : 1);
      }
      if (final && pending.length > 0 && !shutdown) {
        await acceptLine(pending, 0);
        pending = "";
      }
      if (eventBytes + encoder.encode(pending).byteLength > this.#maximumSseEventBytes) {
        throw new ImpactSourceError("Impact event exceeded the configured size", { retryable: false });
      }
    };

    try {
      while (!signal.aborted && !shutdown) {
        const chunk = await reader.read();
        if (chunk.done) break;
        onActivity();
        pending += decoder.decode(chunk.value, { stream: true });
        await drain(false);
      }
      if (!signal.aborted && !shutdown) {
        pending += decoder.decode();
        await drain(true);
      }
      if (shutdown) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
