import { ReviewServiceError } from "./errors.js";
import type { ManagerCredential } from "./types.js";

const MAX_MANAGERS_JSON_BYTES = 64 * 1_024;

export interface ManagerReviewRuntimeConfig {
  readonly workspaceId: string;
  readonly storePath: string;
  readonly evidenceIssuerToken: string;
  readonly evidenceIssuerPrincipal: string;
  readonly humanToken: string;
  readonly managers: readonly ManagerCredential[];
  readonly brokerOrigin: string;
  readonly brokerHandoffIssuerToken: string;
  readonly controlPlaneOrigin: string;
  readonly controlPlaneObserverReadToken: string;
  readonly controlPlanePermitConsumeToken: string;
  readonly corsOrigins: readonly string[];
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly handoffRetryMs?: number;
  readonly brokerTimeoutMs?: number;
  readonly controlPlaneTimeoutMs?: number;
  readonly controlPlaneMaximumBootstrapBytes?: number;
  readonly controlPlaneMaximumSnapshotAgeMs?: number;
  readonly controlPlanePermitTimeoutMs?: number;
  readonly controlPlanePermitMaximumResponseBytes?: number;
}

function invalid(message: string): never {
  throw new ReviewServiceError(500, "INVALID_CONFIGURATION", message);
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) invalid(`${name} is required`);
  return value;
}

function optionalInteger(environment: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) invalid(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalid(`${name} is outside the safe integer range`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseManagers(value: string): readonly ManagerCredential[] {
  if (Buffer.byteLength(value, "utf8") > MAX_MANAGERS_JSON_BYTES) {
    invalid("STEWARD_MANAGER_REVIEW_MANAGERS_JSON exceeds its fixed limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    invalid("STEWARD_MANAGER_REVIEW_MANAGERS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 128) {
    invalid("STEWARD_MANAGER_REVIEW_MANAGERS_JSON must contain one to 128 managers");
  }
  return Object.freeze(parsed.map((entry, index): ManagerCredential => {
    if (!isRecord(entry)) invalid(`Manager ${index} must be an object`);
    const expected = ["agentId", "laneId", "role", "token", "workspaceId"];
    const actual = Object.keys(entry).sort();
    if (actual.length !== expected.length || actual.some((key, offset) => key !== expected[offset])) {
      invalid(`Manager ${index} has unexpected or missing fields`);
    }
    if (
      typeof entry.workspaceId !== "string" ||
      typeof entry.agentId !== "string" ||
      typeof entry.laneId !== "string" ||
      entry.role !== "manager" ||
      typeof entry.token !== "string"
    ) {
      invalid(`Manager ${index} has invalid field types`);
    }
    return Object.freeze({
      workspaceId: entry.workspaceId,
      agentId: entry.agentId,
      laneId: entry.laneId,
      role: "manager",
      token: entry.token,
    });
  }));
}

export function loadManagerReviewRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ManagerReviewRuntimeConfig {
  const evidenceIssuerToken = required(environment, "STEWARD_MANAGER_REVIEW_EVIDENCE_ISSUER_TOKEN");
  const humanToken = required(environment, "STEWARD_MANAGER_REVIEW_HUMAN_TOKEN");
  const brokerHandoffIssuerToken = required(
    environment,
    "STEWARD_MANAGER_REVIEW_BROKER_HANDOFF_ISSUER_TOKEN",
  );
  const controlPlaneObserverReadToken = required(
    environment,
    "STEWARD_MANAGER_REVIEW_CONTROL_PLANE_OBSERVER_READ_TOKEN",
  );
  const controlPlanePermitConsumeToken = required(
    environment,
    "STEWARD_MANAGER_REVIEW_CONTROL_PLANE_PERMIT_CONSUME_TOKEN",
  );
  const managers = parseManagers(required(environment, "STEWARD_MANAGER_REVIEW_MANAGERS_JSON"));
  const corsOrigins = Object.freeze(
    (environment.STEWARD_MANAGER_REVIEW_CORS_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  const capabilities = [
    evidenceIssuerToken,
    humanToken,
    brokerHandoffIssuerToken,
    controlPlaneObserverReadToken,
    controlPlanePermitConsumeToken,
    ...managers.map((manager) => manager.token),
  ];
  if (new Set(capabilities).size !== capabilities.length) {
    invalid("Evidence, human, manager, broker, observer, and permit capabilities must all be distinct");
  }

  const host = environment.STEWARD_MANAGER_REVIEW_HOST;
  const port = optionalInteger(environment, "STEWARD_MANAGER_REVIEW_PORT");
  const maxBodyBytes = optionalInteger(environment, "STEWARD_MANAGER_REVIEW_MAX_BODY_BYTES");
  const handoffRetryMs = optionalInteger(environment, "STEWARD_MANAGER_REVIEW_HANDOFF_RETRY_MS");
  const brokerTimeoutMs = optionalInteger(environment, "STEWARD_MANAGER_REVIEW_BROKER_TIMEOUT_MS");
  const controlPlaneTimeoutMs = optionalInteger(
    environment,
    "STEWARD_MANAGER_REVIEW_CONTROL_PLANE_TIMEOUT_MS",
  );
  const controlPlaneMaximumBootstrapBytes = optionalInteger(
    environment,
    "STEWARD_MANAGER_REVIEW_CONTROL_PLANE_MAX_BOOTSTRAP_BYTES",
  );
  const controlPlaneMaximumSnapshotAgeMs = optionalInteger(
    environment,
    "STEWARD_MANAGER_REVIEW_CONTROL_PLANE_MAX_SNAPSHOT_AGE_MS",
  );
  const controlPlanePermitTimeoutMs = optionalInteger(
    environment,
    "STEWARD_MANAGER_REVIEW_CONTROL_PLANE_PERMIT_TIMEOUT_MS",
  );
  const controlPlanePermitMaximumResponseBytes = optionalInteger(
    environment,
    "STEWARD_MANAGER_REVIEW_CONTROL_PLANE_PERMIT_MAX_RESPONSE_BYTES",
  );
  return Object.freeze({
    workspaceId: required(environment, "STEWARD_MANAGER_REVIEW_WORKSPACE_ID"),
    storePath: required(environment, "STEWARD_MANAGER_REVIEW_STORE_PATH"),
    evidenceIssuerToken,
    evidenceIssuerPrincipal: required(environment, "STEWARD_MANAGER_REVIEW_EVIDENCE_ISSUER_PRINCIPAL"),
    humanToken,
    managers,
    brokerOrigin: required(environment, "STEWARD_MANAGER_REVIEW_BROKER_ORIGIN"),
    brokerHandoffIssuerToken,
    controlPlaneOrigin: required(environment, "STEWARD_MANAGER_REVIEW_CONTROL_PLANE_ORIGIN"),
    controlPlaneObserverReadToken,
    controlPlanePermitConsumeToken,
    corsOrigins,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
    ...(handoffRetryMs === undefined ? {} : { handoffRetryMs }),
    ...(brokerTimeoutMs === undefined ? {} : { brokerTimeoutMs }),
    ...(controlPlaneTimeoutMs === undefined ? {} : { controlPlaneTimeoutMs }),
    ...(controlPlaneMaximumBootstrapBytes === undefined
      ? {}
      : { controlPlaneMaximumBootstrapBytes }),
    ...(controlPlaneMaximumSnapshotAgeMs === undefined
      ? {}
      : { controlPlaneMaximumSnapshotAgeMs }),
    ...(controlPlanePermitTimeoutMs === undefined
      ? {}
      : { controlPlanePermitTimeoutMs }),
    ...(controlPlanePermitMaximumResponseBytes === undefined
      ? {}
      : { controlPlanePermitMaximumResponseBytes }),
  });
}
