import type { IncomingMessage, ServerResponse } from "node:http";
import { sha256, tokenMatches } from "./canonical.js";
import type { TaskBoardConfig } from "./config.js";
import { TaskBoardError } from "./errors.js";

export async function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const length = request.headers["content-length"];
  if (Array.isArray(length) || (length !== undefined && !/^(?:0|[1-9]\d*)$/u.test(length))) {
    request.resume();
    throw new TaskBoardError(400, "INVALID_REQUEST", "Content-Length is invalid");
  }
  if (length !== undefined && Number(length) > maximumBytes) {
    request.resume();
    throw new TaskBoardError(413, "BODY_TOO_LARGE", "Request body exceeds the configured limit");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) {
      request.resume();
      throw new TaskBoardError(413, "BODY_TOO_LARGE", "Request body exceeds the configured limit");
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new TaskBoardError(400, "EMPTY_BODY", "A JSON body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new TaskBoardError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
}

export function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return undefined;
  const value = authorization.slice("Bearer ".length);
  return value.length > 0 ? value : undefined;
}

export function isHuman(request: IncomingMessage, config: TaskBoardConfig): boolean {
  return tokenMatches(sha256(config.humanToken), bearerToken(request));
}

export function requireHuman(request: IncomingMessage, config: TaskBoardConfig): void {
  if (!isHuman(request, config)) throw new TaskBoardError(401, "UNAUTHORIZED", "Human authentication is required");
}

export function applyCors(request: IncomingMessage, response: ServerResponse, config: TaskBoardConfig): void {
  const origin = request.headers.origin;
  if (origin === undefined) return;
  if (typeof origin !== "string" || !config.corsOrigins.has(origin)) {
    throw new TaskBoardError(403, "ORIGIN_NOT_ALLOWED", "Browser origin is not allowed");
  }
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

export function sendEmpty(response: ServerResponse, status: number): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end();
}

export function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof TaskBoardError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Task board could not complete the request" } });
}
