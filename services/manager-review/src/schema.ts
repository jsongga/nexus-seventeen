import { sha256 } from "./canonical.js";
import { ReviewServiceError, corruptStore } from "./errors.js";
import {
  MANAGER_REVIEW_API_VERSION,
  type FixedManagerIdentity,
  type ManagerReview,
  type PassingEngineerEvidence,
  type PassingEngineerEvidenceRequest,
  type RecordManagerReviewRequest,
  type RegisterManagerHandoffRequest,
  type RegisterManagerHandoffResult,
  type RegisteredManagerHandoff,
  type StoredEvent,
} from "./types.js";

export const GENESIS_HASH = "0".repeat(64);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ReviewServiceError(400, "INVALID_REQUEST", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ReviewServiceError(400, "INVALID_REQUEST", `${label} has unexpected or missing fields`);
  }
  return value;
}

function storedExact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  try {
    return exact(value, keys, label);
  } catch (error) {
    throw corruptStore(error instanceof Error ? error.message : `${label} is invalid`);
  }
}

function identifier(value: unknown, field: string, maximum = 128): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
  ) {
    throw new ReviewServiceError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  return value;
}

function text(value: unknown, field: string, maximum = 2_000): string {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new ReviewServiceError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  return value.trim();
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 64) {
    throw new ReviewServiceError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new ReviewServiceError(400, "INVALID_REQUEST", `${field} must be a canonical timestamp`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new ReviewServiceError(400, "INVALID_REQUEST", `${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new ReviewServiceError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  return value;
}

function nullableIdentifier(value: unknown, field: string): string | null {
  return value === null ? null : identifier(value, field, 256);
}

export function parseIdempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) {
    throw new ReviewServiceError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "A valid Idempotency-Key header is required",
    );
  }
  return value;
}

export function parseFixedManagerIdentity(value: unknown): FixedManagerIdentity {
  const item = exact(value, ["workspaceId", "agentId", "laneId", "role"], "Manager identity");
  if (item.role !== "manager") {
    throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Manager identity must have the fixed manager role");
  }
  return Object.freeze({
    workspaceId: identifier(item.workspaceId, "manager.workspaceId"),
    agentId: identifier(item.agentId, "manager.agentId"),
    laneId: identifier(item.laneId, "manager.laneId"),
    role: "manager",
  });
}

export function parsePassingEvidenceRequest(value: unknown): PassingEngineerEvidenceRequest {
  const item = exact(value, [
    "workspaceId",
    "taskId",
    "completionEventId",
    "engineerAgentId",
    "engineerLaneId",
    "checkpointRef",
    "resultOverview",
    "testOutcome",
    "testEvidenceDigest",
    "releaseArtifactDigest",
    "releaseManifestDigest",
    "targetEnvironment",
    "completedAt",
  ], "Passing engineer evidence");
  if (item.testOutcome !== "passed") {
    throw new ReviewServiceError(400, "PASSING_EVIDENCE_REQUIRED", "Only passing engineer evidence may enter manager review");
  }
  return Object.freeze({
    workspaceId: identifier(item.workspaceId, "workspaceId"),
    taskId: identifier(item.taskId, "taskId"),
    completionEventId: identifier(item.completionEventId, "completionEventId", 256),
    engineerAgentId: identifier(item.engineerAgentId, "engineerAgentId"),
    engineerLaneId: identifier(item.engineerLaneId, "engineerLaneId"),
    checkpointRef: nullableIdentifier(item.checkpointRef, "checkpointRef"),
    resultOverview: text(item.resultOverview, "resultOverview"),
    testOutcome: "passed",
    testEvidenceDigest: digest(item.testEvidenceDigest, "testEvidenceDigest"),
    releaseArtifactDigest: digest(item.releaseArtifactDigest, "releaseArtifactDigest"),
    releaseManifestDigest: digest(item.releaseManifestDigest, "releaseManifestDigest"),
    targetEnvironment: identifier(item.targetEnvironment, "targetEnvironment"),
    completedAt: timestamp(item.completedAt, "completedAt"),
  });
}

export function evidenceDigest(request: PassingEngineerEvidenceRequest): string {
  return `sha256:${sha256(request)}`;
}

export function parseManagerReviewRequest(value: unknown): RecordManagerReviewRequest {
  const item = exact(
    value,
    ["evidenceDigest", "decision", "summary", "remainingRisks"],
    "Manager review",
  );
  if (item.decision !== "accepted" && item.decision !== "changes_requested") {
    throw new ReviewServiceError(400, "INVALID_REQUEST", "Manager review decision is invalid");
  }
  return Object.freeze({
    evidenceDigest: digest(item.evidenceDigest, "evidenceDigest"),
    decision: item.decision,
    summary: text(item.summary, "summary"),
    remainingRisks: text(item.remainingRisks, "remainingRisks"),
  });
}

export function parseHandoffRequest(value: unknown): RegisterManagerHandoffRequest {
  const item = exact(value, [
    "workspaceId",
    "taskId",
    "releaseArtifactDigest",
    "releaseManifestDigest",
    "targetEnvironment",
    "managerAgentId",
    "managerReviewId",
    "reviewedAt",
  ], "Manager handoff");
  return Object.freeze({
    workspaceId: identifier(item.workspaceId, "workspaceId"),
    taskId: identifier(item.taskId, "taskId"),
    releaseArtifactDigest: digest(item.releaseArtifactDigest, "releaseArtifactDigest"),
    releaseManifestDigest: digest(item.releaseManifestDigest, "releaseManifestDigest"),
    targetEnvironment: identifier(item.targetEnvironment, "targetEnvironment"),
    managerAgentId: identifier(item.managerAgentId, "managerAgentId"),
    managerReviewId: identifier(item.managerReviewId, "managerReviewId"),
    reviewedAt: timestamp(item.reviewedAt, "reviewedAt"),
  });
}

function parseRegisteredHandoff(value: unknown): RegisteredManagerHandoff {
  const item = exact(value, [
    "apiVersion",
    "handoffId",
    "status",
    "acceptedBy",
    "acceptedAt",
    "workspaceId",
    "taskId",
    "releaseArtifactDigest",
    "releaseManifestDigest",
    "targetEnvironment",
    "managerAgentId",
    "managerReviewId",
    "reviewedAt",
  ], "Registered manager handoff");
  if (item.apiVersion !== 3 || item.status !== "accepted") {
    throw new ReviewServiceError(502, "INVALID_BROKER_RESPONSE", "Broker returned an invalid handoff status");
  }
  return Object.freeze({
    apiVersion: 3,
    handoffId: uuid(item.handoffId, "handoffId"),
    status: "accepted",
    acceptedBy: identifier(item.acceptedBy, "acceptedBy"),
    acceptedAt: timestamp(item.acceptedAt, "acceptedAt"),
    ...parseHandoffRequest({
      workspaceId: item.workspaceId,
      taskId: item.taskId,
      releaseArtifactDigest: item.releaseArtifactDigest,
      releaseManifestDigest: item.releaseManifestDigest,
      targetEnvironment: item.targetEnvironment,
      managerAgentId: item.managerAgentId,
      managerReviewId: item.managerReviewId,
      reviewedAt: item.reviewedAt,
    }),
  });
}

export function parseHandoffResult(value: unknown): RegisterManagerHandoffResult {
  const item = exact(value, ["handoff", "duplicate"], "Broker handoff result");
  if (typeof item.duplicate !== "boolean") {
    throw new ReviewServiceError(502, "INVALID_BROKER_RESPONSE", "Broker duplicate marker is invalid");
  }
  return Object.freeze({ handoff: parseRegisteredHandoff(item.handoff), duplicate: item.duplicate });
}

function parseStoredEvidence(value: unknown): PassingEngineerEvidence {
  const item = storedExact(value, [
    "apiVersion",
    "evidenceId",
    "evidenceDigest",
    "registeredBy",
    "registeredAt",
    "workspaceId",
    "taskId",
    "completionEventId",
    "engineerAgentId",
    "engineerLaneId",
    "checkpointRef",
    "resultOverview",
    "testOutcome",
    "testEvidenceDigest",
    "releaseArtifactDigest",
    "releaseManifestDigest",
    "targetEnvironment",
    "completedAt",
  ], "Stored evidence");
  try {
    if (item.apiVersion !== MANAGER_REVIEW_API_VERSION) throw new Error("evidence API version is invalid");
    const request = parsePassingEvidenceRequest({
      workspaceId: item.workspaceId,
      taskId: item.taskId,
      completionEventId: item.completionEventId,
      engineerAgentId: item.engineerAgentId,
      engineerLaneId: item.engineerLaneId,
      checkpointRef: item.checkpointRef,
      resultOverview: item.resultOverview,
      testOutcome: item.testOutcome,
      testEvidenceDigest: item.testEvidenceDigest,
      releaseArtifactDigest: item.releaseArtifactDigest,
      releaseManifestDigest: item.releaseManifestDigest,
      targetEnvironment: item.targetEnvironment,
      completedAt: item.completedAt,
    });
    const parsed: PassingEngineerEvidence = Object.freeze({
      apiVersion: MANAGER_REVIEW_API_VERSION,
      evidenceId: uuid(item.evidenceId, "evidenceId"),
      evidenceDigest: digest(item.evidenceDigest, "evidenceDigest"),
      registeredBy: identifier(item.registeredBy, "registeredBy"),
      registeredAt: timestamp(item.registeredAt, "registeredAt"),
      ...request,
    });
    if (parsed.evidenceDigest !== evidenceDigest(request)) throw new Error("evidence digest does not match");
    return parsed;
  } catch (error) {
    throw corruptStore(error instanceof Error ? error.message : "stored evidence is invalid");
  }
}

function parseStoredReview(value: unknown): ManagerReview {
  const item = storedExact(value, [
    "apiVersion",
    "managerReviewId",
    "evidenceId",
    "evidenceDigest",
    "workspaceId",
    "taskId",
    "engineerAgentId",
    "managerAgentId",
    "managerLaneId",
    "decision",
    "summary",
    "remainingRisks",
    "reviewedAt",
  ], "Stored manager review");
  try {
    if (item.apiVersion !== MANAGER_REVIEW_API_VERSION) throw new Error("review API version is invalid");
    const decision = item.decision;
    if (decision !== "accepted" && decision !== "changes_requested") throw new Error("review decision is invalid");
    return Object.freeze({
      apiVersion: MANAGER_REVIEW_API_VERSION,
      managerReviewId: uuid(item.managerReviewId, "managerReviewId"),
      evidenceId: uuid(item.evidenceId, "evidenceId"),
      evidenceDigest: digest(item.evidenceDigest, "evidenceDigest"),
      workspaceId: identifier(item.workspaceId, "workspaceId"),
      taskId: identifier(item.taskId, "taskId"),
      engineerAgentId: identifier(item.engineerAgentId, "engineerAgentId"),
      managerAgentId: identifier(item.managerAgentId, "managerAgentId"),
      managerLaneId: identifier(item.managerLaneId, "managerLaneId"),
      decision,
      summary: text(item.summary, "summary"),
      remainingRisks: text(item.remainingRisks, "remainingRisks"),
      reviewedAt: timestamp(item.reviewedAt, "reviewedAt"),
    });
  } catch (error) {
    throw corruptStore(error instanceof Error ? error.message : "stored review is invalid");
  }
}

export function parseStoredEvent(value: unknown, expectedSequence: number, expectedPreviousHash: string): StoredEvent {
  const record = storedExact(value, [
    "storeVersion",
    "sequence",
    "eventId",
    "eventType",
    "occurredAt",
    "idempotencyScope",
    "idempotencyKey",
    "requestHash",
    "previousHash",
    "contentHash",
    value && typeof value === "object" && "eventType" in value && value.eventType === "evidence_registered"
      ? "evidence"
      : value && typeof value === "object" && "eventType" in value && value.eventType === "manager_review_recorded"
        ? "review"
        : "handoff",
    ...(value && typeof value === "object" && "eventType" in value && value.eventType === "handoff_registered"
      ? ["managerReviewId"]
      : []),
  ], `Stored event ${expectedSequence}`);
  try {
    if (record.storeVersion !== 1 || record.sequence !== expectedSequence) throw new Error("sequence or version is invalid");
    const base = {
      storeVersion: 1 as const,
      sequence: expectedSequence,
      eventId: uuid(record.eventId, "eventId"),
      eventType: record.eventType,
      occurredAt: timestamp(record.occurredAt, "occurredAt"),
      idempotencyScope: identifier(record.idempotencyScope, "idempotencyScope", 256),
      idempotencyKey: parseIdempotencyKey(record.idempotencyKey as string),
      requestHash: typeof record.requestHash === "string" && /^[a-f0-9]{64}$/u.test(record.requestHash)
        ? record.requestHash
        : (() => { throw new Error("request hash is invalid"); })(),
      previousHash: typeof record.previousHash === "string" && /^[a-f0-9]{64}$/u.test(record.previousHash)
        ? record.previousHash
        : (() => { throw new Error("previous hash is invalid"); })(),
    };
    if (base.previousHash !== expectedPreviousHash) throw new Error("hash chain is discontinuous");
    let withoutHash: Record<string, unknown>;
    if (record.eventType === "evidence_registered") {
      withoutHash = { ...base, eventType: "evidence_registered", evidence: parseStoredEvidence(record.evidence) };
    } else if (record.eventType === "manager_review_recorded") {
      withoutHash = { ...base, eventType: "manager_review_recorded", review: parseStoredReview(record.review) };
    } else if (record.eventType === "handoff_registered") {
      withoutHash = {
        ...base,
        eventType: "handoff_registered",
        managerReviewId: uuid(record.managerReviewId, "managerReviewId"),
        handoff: parseRegisteredHandoff(record.handoff),
      };
    } else {
      throw new Error("event type is invalid");
    }
    const contentHash = typeof record.contentHash === "string" ? record.contentHash : "";
    if (!/^[a-f0-9]{64}$/u.test(contentHash) || sha256(withoutHash) !== contentHash) {
      throw new Error("content hash does not match");
    }
    return Object.freeze({ ...withoutHash, contentHash } as StoredEvent);
  } catch (error) {
    throw corruptStore(error instanceof Error ? error.message : `stored event ${expectedSequence} is invalid`);
  }
}
