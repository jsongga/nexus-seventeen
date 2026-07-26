import { BrokerError, storeCorrupt } from "./errors.js";
import type { DeploymentBrokerConfig } from "./config.js";
import type {
  ConsumeGrantRequest,
  CreateGrantRequest,
  DeploymentAuthorization,
  DeploymentGrant,
  ManagerHandoff,
  RegisterManagerHandoffRequest,
  StoredEvent,
} from "./types.js";
import { DEPLOYMENT_BROKER_API_VERSION } from "./types.js";
import { sha256 } from "./canonical.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new BrokerError(400, "INVALID_REQUEST", `${context} has unexpected or missing fields`);
  }
}

function requestIdentifier(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
  ) {
    throw new BrokerError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  return value;
}

function sha256Digest(value: unknown, field: "releaseArtifactDigest" | "releaseManifestDigest"): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new BrokerError(400, "INVALID_REQUEST", `${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function requestUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    throw new BrokerError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  return value;
}

function requestTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 64) {
    throw new BrokerError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new BrokerError(400, "INVALID_REQUEST", `${field} must be a canonical timestamp`);
  }
  return value;
}

function parseBinding(value: Record<string, unknown>, config: DeploymentBrokerConfig): ConsumeGrantRequest {
  const targetEnvironment = requestIdentifier(value.targetEnvironment, "targetEnvironment", config.maxTextLength);
  if (!config.targetEnvironments.has(targetEnvironment)) {
    throw new BrokerError(403, "TARGET_NOT_ALLOWED", "The requested deployment target is not allowed");
  }
  return Object.freeze({
    workspaceId: requestIdentifier(value.workspaceId, "workspaceId", config.maxTextLength),
    taskId: requestIdentifier(value.taskId, "taskId", config.maxTextLength),
    releaseArtifactDigest: sha256Digest(value.releaseArtifactDigest, "releaseArtifactDigest"),
    releaseManifestDigest: sha256Digest(value.releaseManifestDigest, "releaseManifestDigest"),
    targetEnvironment,
  });
}

export function parseCreateGrantRequest(value: unknown, config: DeploymentBrokerConfig): CreateGrantRequest {
  if (!isRecord(value)) throw new BrokerError(400, "INVALID_REQUEST", "Request body must be an object");
  exactKeys(
    value,
    [
      "workspaceId", "taskId", "releaseArtifactDigest", "releaseManifestDigest", "targetEnvironment",
      "handoffId", "expiresInSeconds",
    ],
    "Grant request",
  );
  if (
    !Number.isSafeInteger(value.expiresInSeconds) ||
    Number(value.expiresInSeconds) < config.minimumExpirySeconds ||
    Number(value.expiresInSeconds) > config.maximumExpirySeconds
  ) {
    throw new BrokerError(400, "INVALID_REQUEST", "expiresInSeconds is outside the allowed short-lived range");
  }
  return Object.freeze({
    ...parseBinding(value, config),
    handoffId: requestUuid(value.handoffId, "handoffId"),
    expiresInSeconds: Number(value.expiresInSeconds),
  });
}

export function parseRegisterManagerHandoffRequest(
  value: unknown,
  config: DeploymentBrokerConfig,
): RegisterManagerHandoffRequest {
  if (!isRecord(value)) throw new BrokerError(400, "INVALID_REQUEST", "Request body must be an object");
  exactKeys(
    value,
    [
      "workspaceId", "taskId", "releaseArtifactDigest", "releaseManifestDigest", "targetEnvironment",
      "managerAgentId", "managerReviewId", "reviewedAt",
    ],
    "Manager handoff request",
  );
  return Object.freeze({
    ...parseBinding(value, config),
    managerAgentId: requestIdentifier(value.managerAgentId, "managerAgentId", config.maxTextLength),
    managerReviewId: requestIdentifier(value.managerReviewId, "managerReviewId", config.maxTextLength),
    reviewedAt: requestTimestamp(value.reviewedAt, "reviewedAt"),
  });
}

export function parseConsumeGrantRequest(value: unknown, config: DeploymentBrokerConfig): ConsumeGrantRequest {
  if (!isRecord(value)) throw new BrokerError(400, "INVALID_REQUEST", "Request body must be an object");
  exactKeys(
    value,
    ["workspaceId", "taskId", "releaseArtifactDigest", "releaseManifestDigest", "targetEnvironment"],
    "Claim request",
  );
  return parseBinding(value, config);
}

export function parseIdempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) {
    throw new BrokerError(400, "INVALID_IDEMPOTENCY_KEY", "A valid Idempotency-Key header is required");
  }
  return value;
}

function storedText(value: unknown, field: string, maximum = 1_024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw storeCorrupt(`${field} is invalid`);
  }
  return value;
}

function storedTimestamp(value: unknown, field: string): string {
  const text = storedText(value, field, 64);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== text) {
    throw storeCorrupt(`${field} is not a canonical timestamp`);
  }
  return text;
}

function storedBinding(value: Record<string, unknown>): ConsumeGrantRequest {
  return {
    workspaceId: storedText(value.workspaceId, "workspaceId"),
    taskId: storedText(value.taskId, "taskId"),
    releaseArtifactDigest: storedText(value.releaseArtifactDigest, "releaseArtifactDigest", 71),
    releaseManifestDigest: storedText(value.releaseManifestDigest, "releaseManifestDigest", 71),
    targetEnvironment: storedText(value.targetEnvironment, "targetEnvironment"),
  };
}

function parseStoredGrant(value: unknown): DeploymentGrant {
  if (!isRecord(value)) throw storeCorrupt("grant is not an object");
  const expected = [
    "apiVersion", "grantId", "handoffId", "workspaceId", "taskId", "releaseArtifactDigest",
    "releaseManifestDigest", "targetEnvironment",
    "issuedBy", "issuedAt", "expiresAt",
  ];
  if (Object.keys(value).sort().join("|") !== expected.sort().join("|")) throw storeCorrupt("grant shape is invalid");
  if (value.apiVersion !== DEPLOYMENT_BROKER_API_VERSION) throw storeCorrupt("grant version is invalid");
  const grant = {
    apiVersion: DEPLOYMENT_BROKER_API_VERSION,
    grantId: storedText(value.grantId, "grantId"),
    handoffId: storedText(value.handoffId, "handoffId"),
    ...storedBinding(value),
    issuedBy: storedText(value.issuedBy, "issuedBy"),
    issuedAt: storedTimestamp(value.issuedAt, "issuedAt"),
    expiresAt: storedTimestamp(value.expiresAt, "expiresAt"),
  };
  if (!UUID_V4.test(grant.grantId) || !UUID_V4.test(grant.handoffId)) {
    throw storeCorrupt("grant identifiers are invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(grant.releaseArtifactDigest)) throw storeCorrupt("artifact digest is invalid");
  if (!/^sha256:[a-f0-9]{64}$/u.test(grant.releaseManifestDigest)) throw storeCorrupt("manifest digest is invalid");
  if (grant.expiresAt <= grant.issuedAt) throw storeCorrupt("grant expiry is not after issuance");
  return Object.freeze(grant);
}

function parseStoredHandoff(value: unknown): ManagerHandoff {
  if (!isRecord(value)) throw storeCorrupt("manager handoff is not an object");
  const expected = [
    "apiVersion", "handoffId", "status", "workspaceId", "taskId", "releaseArtifactDigest",
    "releaseManifestDigest",
    "targetEnvironment", "managerAgentId", "managerReviewId", "reviewedAt", "acceptedBy", "acceptedAt",
  ];
  if (Object.keys(value).sort().join("|") !== expected.sort().join("|")) {
    throw storeCorrupt("manager handoff shape is invalid");
  }
  if (value.apiVersion !== DEPLOYMENT_BROKER_API_VERSION || value.status !== "accepted") {
    throw storeCorrupt("manager handoff version or status is invalid");
  }
  const handoff = {
    apiVersion: DEPLOYMENT_BROKER_API_VERSION,
    handoffId: storedText(value.handoffId, "handoffId"),
    status: "accepted" as const,
    ...storedBinding(value),
    managerAgentId: storedText(value.managerAgentId, "managerAgentId"),
    managerReviewId: storedText(value.managerReviewId, "managerReviewId"),
    reviewedAt: storedTimestamp(value.reviewedAt, "reviewedAt"),
    acceptedBy: storedText(value.acceptedBy, "acceptedBy"),
    acceptedAt: storedTimestamp(value.acceptedAt, "acceptedAt"),
  };
  if (!UUID_V4.test(handoff.handoffId)) throw storeCorrupt("handoffId is invalid");
  if (handoff.reviewedAt > handoff.acceptedAt) throw storeCorrupt("manager review is after handoff acceptance");
  if (!/^sha256:[a-f0-9]{64}$/u.test(handoff.releaseArtifactDigest)) {
    throw storeCorrupt("handoff artifact digest is invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(handoff.releaseManifestDigest)) {
    throw storeCorrupt("handoff manifest digest is invalid");
  }
  return Object.freeze(handoff);
}

function parseStoredAuthorization(value: unknown): DeploymentAuthorization {
  if (!isRecord(value)) throw storeCorrupt("authorization is not an object");
  const expected = [
    "apiVersion", "authorizationId", "grantId", "handoffId", "workspaceId", "taskId", "releaseArtifactDigest",
    "releaseManifestDigest",
    "targetEnvironment", "issuedBy", "claimedBy", "issuedAt", "expiresAt", "consumedAt",
  ];
  if (Object.keys(value).sort().join("|") !== expected.sort().join("|")) {
    throw storeCorrupt("authorization shape is invalid");
  }
  if (value.apiVersion !== DEPLOYMENT_BROKER_API_VERSION) throw storeCorrupt("authorization version is invalid");
  const authorization = {
    apiVersion: DEPLOYMENT_BROKER_API_VERSION,
    authorizationId: storedText(value.authorizationId, "authorizationId"),
    grantId: storedText(value.grantId, "grantId"),
    handoffId: storedText(value.handoffId, "handoffId"),
    ...storedBinding(value),
    issuedBy: storedText(value.issuedBy, "issuedBy"),
    claimedBy: storedText(value.claimedBy, "claimedBy"),
    issuedAt: storedTimestamp(value.issuedAt, "issuedAt"),
    expiresAt: storedTimestamp(value.expiresAt, "expiresAt"),
    consumedAt: storedTimestamp(value.consumedAt, "consumedAt"),
  };
  if (
    !UUID_V4.test(authorization.authorizationId) ||
    !UUID_V4.test(authorization.grantId) ||
    !UUID_V4.test(authorization.handoffId)
  ) {
    throw storeCorrupt("authorization identifiers are invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(authorization.releaseArtifactDigest)) {
    throw storeCorrupt("authorization artifact digest is invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(authorization.releaseManifestDigest)) {
    throw storeCorrupt("authorization manifest digest is invalid");
  }
  if (authorization.consumedAt < authorization.issuedAt || authorization.consumedAt >= authorization.expiresAt) {
    throw storeCorrupt("authorization time bounds are invalid");
  }
  return Object.freeze(authorization);
}

export function parseStoredEvent(value: unknown, expectedSequence: number): StoredEvent {
  if (!isRecord(value)) throw storeCorrupt(`event ${expectedSequence} is not an object`);
  const eventType = value.eventType;
  const payloadField = eventType === "manager_handoff_registered"
    ? "handoff"
    : eventType === "grant_created"
      ? "grant"
      : eventType === "grant_consumed"
        ? "authorization"
        : undefined;
  if (payloadField === undefined) throw storeCorrupt(`event ${expectedSequence} has an invalid type`);
  const expected = [
    "storeVersion", "sequence", "eventId", "eventType", "occurredAt", "idempotencyScope",
    "idempotencyKey", "requestHash", "contentHash", payloadField,
  ];
  if (Object.keys(value).sort().join("|") !== expected.sort().join("|")) {
    throw storeCorrupt(`event ${expectedSequence} shape is invalid`);
  }
  if (value.storeVersion !== 3 || value.sequence !== expectedSequence) {
    throw storeCorrupt(`event ${expectedSequence} sequence or version is invalid`);
  }
  const base = {
    storeVersion: 3 as const,
    sequence: expectedSequence,
    eventId: storedText(value.eventId, "eventId"),
    eventType,
    occurredAt: storedTimestamp(value.occurredAt, "occurredAt"),
    idempotencyScope: storedText(value.idempotencyScope, "idempotencyScope"),
    idempotencyKey: storedText(value.idempotencyKey, "idempotencyKey", 128),
    requestHash: storedText(value.requestHash, "requestHash", 64),
  };
  if (!UUID_V4.test(base.eventId)) {
    throw storeCorrupt("eventId is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(base.requestHash)) throw storeCorrupt("requestHash is invalid");
  const withoutHash = eventType === "manager_handoff_registered"
    ? { ...base, eventType: "manager_handoff_registered" as const, handoff: parseStoredHandoff(value.handoff) }
    : eventType === "grant_created"
      ? { ...base, eventType: "grant_created" as const, grant: parseStoredGrant(value.grant) }
      : { ...base, eventType: "grant_consumed" as const, authorization: parseStoredAuthorization(value.authorization) };
  const contentHash = storedText(value.contentHash, "contentHash", 64);
  if (!/^[a-f0-9]{64}$/u.test(contentHash) || sha256(withoutHash) !== contentHash) {
    throw storeCorrupt(`event ${expectedSequence} content hash does not match`);
  }
  return Object.freeze({ ...withoutHash, contentHash } as StoredEvent);
}
