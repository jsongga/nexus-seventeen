import type { IncomingMessage, ServerResponse } from "node:http";
import { tokenMatches } from "./canonical.js";
import type { DeploymentBrokerConfig } from "./config.js";
import { BrokerError } from "./errors.js";

export async function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const rawLength = request.headers["content-length"];
  if (Array.isArray(rawLength)) {
    request.resume();
    throw new BrokerError(400, "INVALID_REQUEST", "Content-Length header is invalid");
  }
  if (rawLength !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/u.test(rawLength)) {
      request.resume();
      throw new BrokerError(400, "INVALID_REQUEST", "Content-Length header is invalid");
    }
    if (Number(rawLength) > maximumBytes) {
      request.resume();
      throw new BrokerError(413, "BODY_TOO_LARGE", "Request body exceeds the configured limit");
    }
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) {
      request.resume();
      throw new BrokerError(413, "BODY_TOO_LARGE", "Request body exceeds the configured limit");
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new BrokerError(400, "EMPTY_BODY", "A JSON body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new BrokerError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
}

function suppliedBearer(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length);
  return token.length === 0 ? undefined : token;
}

export function requireHuman(request: IncomingMessage, config: DeploymentBrokerConfig): void {
  if (!tokenMatches(config.humanToken, suppliedBearer(request))) {
    throw new BrokerError(401, "UNAUTHORIZED", "Human reviewer authentication is required");
  }
}

export function requireHandoffIssuer(request: IncomingMessage, config: DeploymentBrokerConfig): void {
  if (!tokenMatches(config.handoffIssuerToken, suppliedBearer(request))) {
    throw new BrokerError(401, "UNAUTHORIZED", "Manager handoff issuer authentication is required");
  }
}

export function requireExecutor(request: IncomingMessage, config: DeploymentBrokerConfig): void {
  if (!tokenMatches(config.executorToken, suppliedBearer(request))) {
    throw new BrokerError(401, "UNAUTHORIZED", "Deployment executor authentication is required");
  }
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

export function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof BrokerError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  sendJson(response, 500, {
    error: { code: "INTERNAL_ERROR", message: "Deployment broker could not complete the request" },
  });
}
