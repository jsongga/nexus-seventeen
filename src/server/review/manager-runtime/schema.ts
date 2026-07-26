import {
  parseAgentTaskProjection,
  parseDurableOutboxEvent,
  parseSupervisorRegistrationRequest,
  type Sha256Digest,
} from "#shared/protocol";
import type {
  EvidenceInspectionResult,
  ManagerRuntimeIdentity,
  ManagerRuntimeState,
  PassingEngineerEvidence,
} from "./types.js";

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], context: string): Record<string, unknown> {
  const item = record(value, context);
  const actual = Object.keys(item).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${context} has unexpected or missing fields`);
  }
  return item;
}

function text(value: unknown, field: string, maximum = 4_096): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field, 512);
}

function digest(value: unknown, field: string): Sha256Digest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field} must be a lowercase SHA-256 digest`);
  }
  return value as Sha256Digest;
}

function timestamp(value: unknown, field: string): string {
  const parsed = new Date(typeof value === "string" ? value : Number.NaN);
  if (typeof value !== "string" || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be a canonical timestamp`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field} is invalid`);
  return Number(value);
}

export function parsePassingEngineerEvidence(value: unknown): PassingEngineerEvidence {
  const item = exact(value, [
    "apiVersion", "evidenceId", "evidenceDigest", "registeredBy", "registeredAt", "workspaceId", "taskId",
    "completionEventId", "engineerAgentId", "engineerLaneId", "checkpointRef", "resultOverview", "testOutcome",
    "testEvidenceDigest", "releaseArtifactDigest", "releaseManifestDigest", "targetEnvironment", "completedAt",
  ], "Passing engineer evidence");
  if (item.apiVersion !== 1 || item.testOutcome !== "passed") throw new Error("Passing engineer evidence is invalid");
  return Object.freeze({
    apiVersion: 1,
    evidenceId: text(item.evidenceId, "evidenceId", 128),
    evidenceDigest: digest(item.evidenceDigest, "evidenceDigest"),
    registeredBy: text(item.registeredBy, "registeredBy", 128),
    registeredAt: timestamp(item.registeredAt, "registeredAt"),
    workspaceId: text(item.workspaceId, "workspaceId", 128),
    taskId: text(item.taskId, "taskId", 128),
    completionEventId: text(item.completionEventId, "completionEventId", 256),
    engineerAgentId: text(item.engineerAgentId, "engineerAgentId", 128),
    engineerLaneId: text(item.engineerLaneId, "engineerLaneId", 128),
    checkpointRef: nullableText(item.checkpointRef, "checkpointRef"),
    resultOverview: text(item.resultOverview, "resultOverview"),
    testOutcome: "passed",
    testEvidenceDigest: digest(item.testEvidenceDigest, "testEvidenceDigest"),
    releaseArtifactDigest: digest(item.releaseArtifactDigest, "releaseArtifactDigest"),
    releaseManifestDigest: digest(item.releaseManifestDigest, "releaseManifestDigest"),
    targetEnvironment: text(item.targetEnvironment, "targetEnvironment", 128),
    completedAt: timestamp(item.completedAt, "completedAt"),
  });
}

export function parseInspectionResult(value: unknown): EvidenceInspectionResult {
  const item = exact(value, [
    "state", "evidenceDigest", "testEvidenceDigest", "releaseArtifactDigest", "releaseManifestDigest",
    "summary", "remainingRisks",
  ], "Manager inspection result");
  if (item.state !== "accepted" && item.state !== "changes_requested" && item.state !== "continue") {
    throw new Error("Manager inspection state is invalid");
  }
  return Object.freeze({
    state: item.state,
    evidenceDigest: digest(item.evidenceDigest, "inspection.evidenceDigest"),
    testEvidenceDigest: digest(item.testEvidenceDigest, "inspection.testEvidenceDigest"),
    releaseArtifactDigest: digest(item.releaseArtifactDigest, "inspection.releaseArtifactDigest"),
    releaseManifestDigest: digest(item.releaseManifestDigest, "inspection.releaseManifestDigest"),
    summary: text(item.summary, "inspection.summary"),
    remainingRisks: text(item.remainingRisks, "inspection.remainingRisks"),
  });
}

function parseStoredEvidence(value: unknown): PassingEngineerEvidence | null {
  return value === null ? null : parsePassingEngineerEvidence(value);
}

export function emptyRuntimeState(identity: ManagerRuntimeIdentity): ManagerRuntimeState {
  return Object.freeze({
    version: 1,
    identity: Object.freeze({
      workspaceId: identity.workspaceId,
      agentId: identity.agentId,
      laneId: identity.laneId,
      runtimeInstanceId: identity.runtimeInstanceId,
    }),
    runtimeEpoch: 0,
    runtimeGenerationProof: null,
    registrationIntent: null,
    lease: null,
    lastServerSequence: 0,
    nextLocalSequence: 1,
    desiredState: "active",
    queue: Object.freeze([]),
    active: null,
    currentAction: null,
    pendingEvents: Object.freeze([]),
  });
}

export function parseRuntimeState(value: unknown, identity: ManagerRuntimeIdentity): ManagerRuntimeState {
  const item = exact(value, [
    "version", "identity", "runtimeEpoch", "runtimeGenerationProof", "registrationIntent", "lease",
    "lastServerSequence", "nextLocalSequence", "desiredState",
    "queue", "active", "currentAction", "pendingEvents",
  ], "Manager runtime state");
  if (item.version !== 1) throw new Error("Manager runtime state version is invalid");
  const storedIdentity = exact(item.identity, ["workspaceId", "agentId", "laneId", "runtimeInstanceId"], "Stored identity");
  for (const field of ["workspaceId", "agentId", "laneId", "runtimeInstanceId"] as const) {
    if (field !== "runtimeInstanceId" && storedIdentity[field] !== identity[field]) {
      throw new Error("Manager runtime state belongs to another identity");
    }
  }
  const runtimeEpoch = nonNegativeInteger(item.runtimeEpoch, "runtimeEpoch");
  const runtimeGenerationProof = item.runtimeGenerationProof === null
    ? null
    : text(item.runtimeGenerationProof, "runtimeGenerationProof", 128);
  if (runtimeGenerationProof !== null && !/^rgp_[A-Za-z0-9_-]{43}$/u.test(runtimeGenerationProof)) {
    throw new Error("runtimeGenerationProof is invalid");
  }
  let registrationIntent: ManagerRuntimeState["registrationIntent"] = null;
  if (item.registrationIntent !== null) {
    const intent = exact(
      item.registrationIntent,
      ["request", "runtimeProofChallenge"],
      "Registration intent",
    );
    const request = parseSupervisorRegistrationRequest(intent.request);
    if (
      request.workspaceId !== identity.workspaceId ||
      request.agentId !== identity.agentId ||
      request.laneId !== identity.laneId ||
      request.role !== "manager" ||
      request.expectedRuntimeEpoch !== (runtimeEpoch === 0 ? null : runtimeEpoch)
    ) {
      throw new Error("Registration intent does not match the manager runtime state");
    }
    const runtimeProofChallenge = text(intent.runtimeProofChallenge, "registrationIntent.runtimeProofChallenge", 128);
    if (!/^rgc_[A-Za-z0-9_-]{43}$/u.test(runtimeProofChallenge)) {
      throw new Error("registrationIntent.runtimeProofChallenge is invalid");
    }
    registrationIntent = {
      request,
      runtimeProofChallenge,
    };
  }
  const nextLocalSequence = nonNegativeInteger(item.nextLocalSequence, "nextLocalSequence");
  if (nextLocalSequence < 1) throw new Error("nextLocalSequence is invalid");
  if (item.desiredState !== "active" && item.desiredState !== "held" && item.desiredState !== "paused") {
    throw new Error("desiredState is invalid");
  }
  if (!Array.isArray(item.queue) || !Array.isArray(item.pendingEvents)) throw new Error("Stored queues are invalid");
  const queue = item.queue.map((task) => parseAgentTaskProjection(task));
  let active: ManagerRuntimeState["active"] = null;
  if (item.active !== null) {
    const value = exact(
      item.active,
      ["task", "phase", "iteration", "evidence", "decision", "progressMode"],
      "Active review",
    );
    if (value.phase !== "locate" && value.phase !== "inspect" && value.phase !== "submit") {
      throw new Error("Active review phase is invalid");
    }
    const iteration = nonNegativeInteger(value.iteration, "active.iteration");
    if (iteration < 1) throw new Error("Active review iteration is invalid");
    if (value.progressMode !== "emit" && value.progressMode !== "suppress") {
      throw new Error("Active review progressMode is invalid");
    }
    let decision: ManagerRuntimeState["active"] extends infer _ ? import("./types.js").StoredDecision | null : never = null;
    if (value.decision !== null) {
      const parsed = exact(value.decision, ["decision", "summary", "remainingRisks"], "Stored decision");
      if (parsed.decision !== "accepted" && parsed.decision !== "changes_requested") {
        throw new Error("Stored manager decision is invalid");
      }
      decision = {
        decision: parsed.decision,
        summary: text(parsed.summary, "decision.summary"),
        remainingRisks: text(parsed.remainingRisks, "decision.remainingRisks"),
      };
    }
    active = {
      task: parseAgentTaskProjection(value.task),
      phase: value.phase,
      iteration,
      evidence: parseStoredEvidence(value.evidence),
      decision,
      progressMode: value.progressMode,
    };
  }
  let lease: ManagerRuntimeState["lease"] = null;
  if (item.lease !== null) {
    const parsed = exact(item.lease, ["leaseId", "leaseGrantedAt", "leaseExpiresAt"], "Stored lease");
    lease = {
      leaseId: text(parsed.leaseId, "leaseId", 128),
      leaseGrantedAt: timestamp(parsed.leaseGrantedAt, "leaseGrantedAt"),
      leaseExpiresAt: timestamp(parsed.leaseExpiresAt, "leaseExpiresAt"),
    };
  }
  let currentAction: ManagerRuntimeState["currentAction"] = null;
  if (item.currentAction !== null) {
    const parsed = exact(item.currentAction, ["taskId", "summary", "startedAt"], "Current action");
    currentAction = {
      taskId: text(parsed.taskId, "currentAction.taskId", 128),
      summary: text(parsed.summary, "currentAction.summary", 512),
      startedAt: timestamp(parsed.startedAt, "currentAction.startedAt"),
    };
  }
  const pendingEvents = item.pendingEvents.map((event) => parseDurableOutboxEvent(event));
  if (pendingEvents.some((event) => event.runtimeEpoch !== runtimeEpoch)) {
    throw new Error("Pending runtime events use another fencing epoch");
  }
  return Object.freeze({
    version: 1,
    identity: Object.freeze({
      workspaceId: identity.workspaceId,
      agentId: identity.agentId,
      laneId: identity.laneId,
      runtimeInstanceId: text(storedIdentity.runtimeInstanceId, "identity.runtimeInstanceId", 128),
    }),
    runtimeEpoch,
    runtimeGenerationProof,
    registrationIntent,
    lease,
    lastServerSequence: nonNegativeInteger(item.lastServerSequence, "lastServerSequence"),
    nextLocalSequence,
    desiredState: item.desiredState,
    queue: Object.freeze(queue),
    active,
    currentAction,
    pendingEvents: Object.freeze(pendingEvents),
  });
}
