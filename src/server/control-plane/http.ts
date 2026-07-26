import type { IncomingMessage, ServerResponse } from 'node:http';
import { tokenMatches } from './canonical.js';
import type { ControlPlaneConfig, WorkloadIdentityCredential } from './config.js';
import { ServiceError } from './errors.js';

export async function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    request.resume();
    throw new ServiceError(413, 'BODY_TOO_LARGE', 'Request body exceeds the configured limit');
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) {
      request.resume();
      throw new ServiceError(413, 'BODY_TOO_LARGE', 'Request body exceeds the configured limit');
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new ServiceError(400, 'EMPTY_BODY', 'A JSON body is required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ServiceError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return undefined;
  return authorization.slice('Bearer '.length);
}

export type AuthenticatedWorkload = Readonly<{
  binding: Readonly<
    Pick<WorkloadIdentityCredential, 'workspaceId' | 'agentId' | 'laneId' | 'role'>
  > | null;
  legacyDevCredential: boolean;
}>;

export function requireWorkload(
  request: IncomingMessage,
  config: ControlPlaneConfig,
): AuthenticatedWorkload {
  const presented = bearerToken(request);
  let matched: WorkloadIdentityCredential | undefined;
  for (const identity of config.workloadIdentities) {
    const matches = tokenMatches(identity.token, presented);
    if (matches) matched = identity;
  }
  const legacyMatches =
    config.legacyDevSupervisorToken === undefined
      ? false
      : tokenMatches(config.legacyDevSupervisorToken, presented);
  if (matched === undefined && !legacyMatches) {
    throw new ServiceError(401, 'UNAUTHORIZED', 'Workload authentication is required');
  }
  return Object.freeze({
    binding:
      matched === undefined
        ? null
        : Object.freeze({
            workspaceId: matched.workspaceId,
            agentId: matched.agentId,
            laneId: matched.laneId,
            role: matched.role,
          }),
    legacyDevCredential: legacyMatches,
  });
}

export function assertWorkloadBinding(
  workload: AuthenticatedWorkload,
  identity: { workspaceId: string; agentId: string; laneId: string },
): void {
  const binding = workload.binding;
  if (
    binding !== null &&
    (binding.workspaceId !== identity.workspaceId ||
      binding.agentId !== identity.agentId ||
      binding.laneId !== identity.laneId)
  ) {
    throw new ServiceError(
      403,
      'WORKLOAD_IDENTITY_MISMATCH',
      'Credential is not authorized for the requested workspace, agent, and lane',
    );
  }
}

export function assertWorkloadRegistrationRole(
  workload: AuthenticatedWorkload,
  registration: { role: WorkloadIdentityCredential['role'] },
): void {
  const binding = workload.binding;
  if (binding !== null && binding.role !== registration.role) {
    throw new ServiceError(
      403,
      'WORKLOAD_ROLE_MISMATCH',
      'Credential is not authorized for the requested role',
    );
  }
}

export function requireHuman(request: IncomingMessage, config: ControlPlaneConfig): void {
  if (!tokenMatches(config.humanToken, bearerToken(request))) {
    throw new ServiceError(401, 'UNAUTHORIZED', 'Human authentication is required');
  }
}

/**
 * This capability can consume one narrowly bound review permit. It cannot
 * read UI state, impersonate a runtime, issue human controls, or deploy.
 */
export function requireManagerReviewPermitConsumer(
  request: IncomingMessage,
  config: ControlPlaneConfig,
): void {
  if (config.managerReviewPermitToken === undefined) {
    throw new ServiceError(
      503,
      'MANAGER_REVIEW_PERMITS_DISABLED',
      'Manager-review permit consumption is not configured',
    );
  }
  if (!tokenMatches(config.managerReviewPermitToken, bearerToken(request))) {
    throw new ServiceError(
      401,
      'UNAUTHORIZED',
      'Manager-review permit authentication is required',
    );
  }
}

export type UiReadPrincipal = 'human' | 'observer';

export function requireUiRead(
  request: IncomingMessage,
  config: ControlPlaneConfig,
): UiReadPrincipal {
  const presented = bearerToken(request);
  const humanMatches = tokenMatches(config.humanToken, presented);
  const observerMatches = tokenMatches(config.observerReadToken, presented);
  if (!humanMatches && !observerMatches) {
    throw new ServiceError(401, 'UNAUTHORIZED', 'UI read authentication is required');
  }
  return observerMatches ? 'observer' : 'human';
}

export function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  config: ControlPlaneConfig,
): void {
  const origin = request.headers.origin;
  if (origin === undefined) return;
  if (!config.corsOrigins.has(origin)) {
    throw new ServiceError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
  }
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(encoded));
  response.setHeader('Cache-Control', 'no-store');
  response.end(encoded);
}

export function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof ServiceError) {
    sendJson(response, error.status, {
      error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) },
    });
    return;
  }
  sendJson(response, 500, {
    error: { code: 'INTERNAL_ERROR', message: 'The control plane could not complete the request' },
  });
}

export function parseCursor(value: string | null, name = 'cursor'): number {
  if (value === null || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new ServiceError(400, 'INVALID_CURSOR', `${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ServiceError(400, 'INVALID_CURSOR', `${name} is too large`);
  }
  return parsed;
}
