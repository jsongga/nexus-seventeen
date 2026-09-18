/** Provides the bounded authenticated Outline POST client used by OutlineSink. */

export class OutlineHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "OutlineHttpError";
  }
}

export interface OutlineClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly allowInsecureBaseUrl?: boolean;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImplementation?: typeof fetch;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function checkedUrl(value: string, allowInsecureBaseUrl: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Outline URL is invalid");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Outline URL must be an HTTP(S) origin without path, credentials, query, or fragment");
  }
  if (url.protocol !== "https:" && !allowInsecureBaseUrl) {
    throw new Error("Outline URL must use HTTPS unless allowInsecureBaseUrl is true");
  }
  return url.toString().replace(/\/$/u, "");
}

function checkedToken(value: string): string {
  if (value.length < 1 || value.length > 512 || value.trim() !== value || CONTROL_CHARACTER.test(value)) {
    throw new Error("Outline API token is invalid");
  }
  return value;
}

function integer(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorCode(value: unknown): string | undefined {
  const error = record(value)?.error;
  if (typeof error === "string" && error.length > 0) return error;
  const nested = record(error)?.code;
  return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}

async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && !/^(?:0|[1-9]\d*)$/u.test(declared)) {
    await response.body?.cancel();
    throw new OutlineHttpError("Outline response Content-Length is invalid", response.status);
  }
  if (declared !== null && Number(declared) > maximum) {
    await response.body?.cancel();
    throw new OutlineHttpError("Outline response exceeds its size limit", response.status);
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    await response.body?.cancel();
    throw new OutlineHttpError("Outline response is not JSON", response.status);
  }
  if (!response.body) throw new OutlineHttpError("Outline response is empty", response.status);

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
        throw new OutlineHttpError("Outline response exceeds its size limit", response.status);
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof OutlineHttpError) throw error;
    throw new OutlineHttpError("Outline response is not valid JSON", response.status);
  }
}

export class OutlineClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #maximum: number;
  readonly #fetch: typeof fetch;

  constructor(options: OutlineClientOptions) {
    this.#baseUrl = checkedUrl(options.baseUrl, options.allowInsecureBaseUrl === true);
    this.#token = checkedToken(options.token);
    this.#timeoutMs = integer(options.timeoutMs, 10_000, 1, 60_000, "timeoutMs");
    this.#maximum = integer(options.maxResponseBytes, 1024 * 1024, 1, 16 * 1024 * 1024, "maxResponseBytes");
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
  }

  async request(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    timeout.unref();
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      const parsed = await boundedJson(response, this.#maximum);
      if (!response.ok) {
        const code = errorCode(parsed);
        throw new OutlineHttpError(`Outline request failed with HTTP ${response.status}`, response.status, code);
      }
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  }
}
