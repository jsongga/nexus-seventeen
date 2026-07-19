import { randomBytes } from 'node:crypto';
import type { AgentRole } from '@cicada/steward-protocol';
import { ServiceError } from './errors.js';

export interface WorkloadIdentityCredential {
  workspaceId: string;
  agentId: string;
  laneId: string;
  role: AgentRole;
  token: string;
}

interface ControlPlaneBaseOptions {
  workspaceId: string;
  storePath: string;
  workloadIdentities?: readonly WorkloadIdentityCredential[];
  humanToken: string;
  observerReadToken: string;
  /**
   * Dedicated capability for the manager-review coordinator to consume a
   * one-use review authorization. It is optional for embedded/test control
   * planes that do not expose the review workflow.
   */
  managerReviewPermitToken?: string;
  /** Server-only HMAC key used to issue per-runtime-generation proofs. */
  runtimeGenerationProofKey?: string;
  host?: string;
  port?: number;
  corsOrigins?: readonly string[];
  leaseMs?: number;
  maxBodyBytes?: number;
  maxTextLength?: number;
  maxQueueSize?: number;
  maxSubscribers?: number;
  keepAliveMs?: number;
  now?: () => Date;
}

/**
 * The shared workload credential exists only for loopback development. Callers
 * must opt in explicitly; production-style configurations cannot carry it.
 */
export type ControlPlaneOptions = ControlPlaneBaseOptions &
  (
    | {
        developmentMode: true;
        legacyDevSupervisorToken: string;
      }
    | {
        developmentMode?: false;
        legacyDevSupervisorToken?: never;
      }
  );

export interface ControlPlaneConfig {
  workspaceId: string;
  storePath: string;
  workloadIdentities: readonly WorkloadIdentityCredential[];
  legacyDevSupervisorToken: string | undefined;
  humanToken: string;
  observerReadToken: string;
  managerReviewPermitToken: string | undefined;
  runtimeGenerationProofKey: string;
  host: string;
  port: number;
  corsOrigins: ReadonlySet<string>;
  leaseMs: number;
  maxBodyBytes: number;
  maxTextLength: number;
  maxQueueSize: number;
  maxSubscribers: number;
  keepAliveMs: number;
  now: () => Date;
}

const LOOPBACK_DEVELOPMENT_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new ServiceError(500, 'INVALID_CONFIGURATION', `${name} is outside its safe range`);
  }
  return resolved;
}

function requiredText(value: string, name: string, maximum = 512): string {
  if (value.length === 0 || value.length > maximum || /[\u0000-\u001f]/u.test(value)) {
    throw new ServiceError(500, 'INVALID_CONFIGURATION', `${name} is invalid`);
  }
  return value;
}

function requiredRole(value: unknown, name: string): AgentRole {
  if (value !== 'engineer' && value !== 'verifier' && value !== 'manager') {
    throw new ServiceError(500, 'INVALID_CONFIGURATION', `${name} is invalid`);
  }
  return value;
}

export function normalizeConfig(options: ControlPlaneOptions): ControlPlaneConfig {
  const workspaceId = requiredText(options.workspaceId, 'workspaceId', 128);
  const humanToken = requiredText(options.humanToken, 'humanToken');
  const observerReadToken = requiredText(options.observerReadToken, 'observerReadToken');
  const managerReviewPermitToken =
    options.managerReviewPermitToken === undefined
      ? undefined
      : requiredText(options.managerReviewPermitToken, 'managerReviewPermitToken');
  const runtimeGenerationProofKey = requiredText(
    options.runtimeGenerationProofKey ?? randomBytes(32).toString('base64url'),
    'runtimeGenerationProofKey',
  );
  const host = requiredText(options.host ?? '127.0.0.1', 'host', 255).toLowerCase();
  if (
    options.developmentMode !== undefined &&
    options.developmentMode !== true &&
    options.developmentMode !== false
  ) {
    throw new ServiceError(500, 'INVALID_CONFIGURATION', 'developmentMode must be a boolean');
  }
  const legacyDevSupervisorToken =
    options.legacyDevSupervisorToken === undefined
      ? undefined
      : requiredText(options.legacyDevSupervisorToken, 'legacyDevSupervisorToken');
  if (legacyDevSupervisorToken !== undefined && options.developmentMode !== true) {
    throw new ServiceError(
      500,
      'INVALID_CONFIGURATION',
      'legacyDevSupervisorToken requires explicit developmentMode: true',
    );
  }
  if (legacyDevSupervisorToken !== undefined && !LOOPBACK_DEVELOPMENT_HOSTS.has(host)) {
    throw new ServiceError(
      500,
      'INVALID_CONFIGURATION',
      'The legacy development credential may only bind to a loopback host',
    );
  }
  const workloadIdentities = (options.workloadIdentities ?? []).map(
    (identity, index): WorkloadIdentityCredential => ({
      workspaceId: requiredText(identity.workspaceId, `workloadIdentities[${index}].workspaceId`, 128),
      agentId: requiredText(identity.agentId, `workloadIdentities[${index}].agentId`, 128),
      laneId: requiredText(identity.laneId, `workloadIdentities[${index}].laneId`, 128),
      role: requiredRole(identity.role, `workloadIdentities[${index}].role`),
      token: requiredText(identity.token, `workloadIdentities[${index}].token`),
    }),
  );
  if (workloadIdentities.length === 0 && legacyDevSupervisorToken === undefined) {
    throw new ServiceError(
      500,
      'INVALID_CONFIGURATION',
      'At least one lane-bound workload identity is required',
    );
  }
  if (
    humanToken.length < 16 ||
    observerReadToken.length < 16 ||
    (managerReviewPermitToken !== undefined && managerReviewPermitToken.length < 16) ||
    runtimeGenerationProofKey.length < 32 ||
    (legacyDevSupervisorToken !== undefined && legacyDevSupervisorToken.length < 16) ||
    workloadIdentities.some((identity) => identity.token.length < 16)
  ) {
    throw new ServiceError(
      500,
      'INVALID_CONFIGURATION',
      'Bearer tokens must contain at least 16 characters',
    );
  }
  const laneBindings = new Set<string>();
  if (observerReadToken === humanToken) {
    throw new ServiceError(500, 'INVALID_CONFIGURATION', 'Bearer tokens must be distinct');
  }
  const tokens = new Set<string>([humanToken, observerReadToken]);
  if (managerReviewPermitToken !== undefined) {
    if (tokens.has(managerReviewPermitToken)) {
      throw new ServiceError(500, 'INVALID_CONFIGURATION', 'Bearer tokens must be distinct');
    }
    tokens.add(managerReviewPermitToken);
  }
  if (legacyDevSupervisorToken !== undefined) {
    if (tokens.has(legacyDevSupervisorToken)) {
      throw new ServiceError(500, 'INVALID_CONFIGURATION', 'Bearer tokens must be distinct');
    }
    tokens.add(legacyDevSupervisorToken);
  }
  for (const identity of workloadIdentities) {
    if (identity.workspaceId !== workspaceId) {
      throw new ServiceError(
        500,
        'INVALID_CONFIGURATION',
        'Workload identity workspaceId must match the served workspace',
      );
    }
    const binding = `${identity.workspaceId}\u0000${identity.agentId}\u0000${identity.laneId}`;
    if (laneBindings.has(binding)) {
      throw new ServiceError(500, 'INVALID_CONFIGURATION', 'Workload lane bindings must be unique');
    }
    if (tokens.has(identity.token)) {
      throw new ServiceError(500, 'INVALID_CONFIGURATION', 'Bearer tokens must be distinct');
    }
    laneBindings.add(binding);
    tokens.add(identity.token);
  }
  if (tokens.has(runtimeGenerationProofKey)) {
    throw new ServiceError(
      500,
      'INVALID_CONFIGURATION',
      'Runtime proof key and bearer tokens must be distinct',
    );
  }

  const origins = new Set<string>();
  for (const origin of options.corsOrigins ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ServiceError(500, 'INVALID_CONFIGURATION', `Invalid CORS origin: ${origin}`);
    }
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new ServiceError(500, 'INVALID_CONFIGURATION', `Unsafe CORS origin: ${origin}`);
    }
    origins.add(origin);
  }

  return Object.freeze({
    workspaceId,
    storePath: requiredText(options.storePath, 'storePath', 4_096),
    workloadIdentities: Object.freeze(workloadIdentities.map((identity) => Object.freeze(identity))),
    legacyDevSupervisorToken,
    humanToken,
    observerReadToken,
    managerReviewPermitToken,
    runtimeGenerationProofKey,
    host,
    port: boundedInteger(options.port, 0, 0, 65_535, 'port'),
    corsOrigins: origins,
    leaseMs: boundedInteger(options.leaseMs, 30_000, 5_000, 300_000, 'leaseMs'),
    maxBodyBytes: boundedInteger(options.maxBodyBytes, 64 * 1_024, 1_024, 1_048_576, 'maxBodyBytes'),
    maxTextLength: boundedInteger(options.maxTextLength, 4_096, 128, 32_768, 'maxTextLength'),
    maxQueueSize: boundedInteger(options.maxQueueSize, 100, 1, 1_000, 'maxQueueSize'),
    maxSubscribers: boundedInteger(options.maxSubscribers, 64, 1, 1_000, 'maxSubscribers'),
    keepAliveMs: boundedInteger(options.keepAliveMs, 15_000, 1_000, 60_000, 'keepAliveMs'),
    now: options.now ?? (() => new Date()),
  });
}
