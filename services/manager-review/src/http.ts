import type { IncomingMessage, ServerResponse } from "node:http";
import { tokenMatches } from "./canonical.js";
import { ReviewServiceError } from "./errors.js";
import type { ManagerReviewServiceConfig } from "./service.js";
import type { FixedManagerIdentity } from "./types.js";

function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return undefined;
  return value.slice("Bearer ".length) || undefined;
}

export function requireEvidenceIssuer(request: IncomingMessage, config: ManagerReviewServiceConfig): void {
  if (!tokenMatches(config.evidenceIssuerToken, bearer(request))) {
    throw new ReviewServiceError(401, "UNAUTHORIZED", "Trusted evidence issuer authentication is required");
  }
}

export function requireHuman(request: IncomingMessage, config: ManagerReviewServiceConfig): void {
  if (!tokenMatches(config.humanToken, bearer(request))) {
    throw new ReviewServiceError(401, "UNAUTHORIZED", "Human production-check authentication is required");
  }
}

export function requireManager(
  request: IncomingMessage,
  config: ManagerReviewServiceConfig,
): FixedManagerIdentity {
  const presented = bearer(request);
  let match: ManagerReviewServiceConfig["managers"][number] | undefined;
  for (const manager of config.managers) {
    if (tokenMatches(manager.token, presented)) match = manager;
  }
  if (!match) throw new ReviewServiceError(401, "UNAUTHORIZED", "Fixed manager authentication is required");
  return Object.freeze({
    workspaceId: match.workspaceId,
    agentId: match.agentId,
    laneId: match.laneId,
    role: "manager",
  });
}

export async function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const declared = request.headers["content-length"];
  if (Array.isArray(declared) || (declared !== undefined && !/^(?:0|[1-9]\d*)$/u.test(declared))) {
    request.resume();
    throw new ReviewServiceError(400, "INVALID_REQUEST", "Content-Length is invalid");
  }
  if (declared !== undefined && Number(declared) > maximumBytes) {
    request.resume();
    throw new ReviewServiceError(413, "BODY_TOO_LARGE", "Request body exceeds its fixed limit");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunkValue of request) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    bytes += chunk.length;
    if (bytes > maximumBytes) {
      request.resume();
      throw new ReviewServiceError(413, "BODY_TOO_LARGE", "Request body exceeds its fixed limit");
    }
    chunks.push(chunk);
  }
  if (bytes === 0) throw new ReviewServiceError(400, "EMPTY_BODY", "A JSON body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ReviewServiceError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(encoded));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(encoded);
}

export function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof ReviewServiceError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  sendJson(response, 500, {
    error: { code: "INTERNAL_ERROR", message: "Manager review service could not complete the request" },
  });
}
