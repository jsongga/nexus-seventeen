import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STEWARD_RUNTIME_API_VERSION,
  parseAgentTaskProjection,
  parseLeaseRenewalResult,
  parseRuntimeCommandEnvelope,
  parseRuntimeCommandPollResult,
  parseRuntimeEventBatchReceipt,
  parseSupervisorRegistrationResult,
  type DurableOutboxEvent,
  type LeaseRenewalRequest,
  type RuntimeCommandEnvelope,
  type RuntimeCommandPollRequest,
  type RuntimeEventBatch,
  type SupervisorRegistrationRequest,
} from "#shared/protocol";
import { parseInspectionResult, parsePassingEngineerEvidence } from "#server/review/manager-runtime/schema";
import type {
  EvidenceInspectionRequest,
  EvidenceInspectionResult,
  ManagerRegistrationSession,
  ManagerReviewClient,
  ManagerReviewReceipt,
  ManagerReviewRequest,
  ManagerRuntimeClaim,
  ManagerRuntimeControlClient,
  ManagerRuntimeIdentity,
  PassingEngineerEvidence,
  ReadOnlyManagerInspector,
} from "#server/review/manager-runtime/types";

export const NOW = "2026-07-19T20:00:00.000Z";
export const WORKSPACE = "workspace-manager-runtime";
export const MANAGER = "manager-runtime-one";
export const LANE = "manager-lane-one";
export const INSTANCE = "manager-process-one";
export const SOURCE_TASK = "task_source_engineer";
export const REVIEW_TASK = "task_manager_review";
export const EVIDENCE_ID = "11111111-1111-4111-8111-111111111111";
export const EVIDENCE_DIGEST = `sha256:${"a".repeat(64)}`;
export const TEST_DIGEST = `sha256:${"b".repeat(64)}`;
export const ARTIFACT_DIGEST = `sha256:${"c".repeat(64)}`;
export const MANIFEST_DIGEST = `sha256:${"d".repeat(64)}`;
export const GENERATION_PROOF = `rgp_${"A".repeat(43)}`;

export async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "steward-manager-runtime-"));
}

export function identity(runtimeInstanceId = INSTANCE): ManagerRuntimeIdentity {
  return {
    workspaceId: WORKSPACE,
    agentId: MANAGER,
    laneId: LANE,
    runtimeInstanceId,
    displayName: "Release manager",
    provider: { name: "codex", model: "gpt-5.4-mini" },
    softwareVersion: "0.1.0",
  };
}

export function reviewTask(taskId = REVIEW_TASK) {
  return parseAgentTaskProjection({
    taskId,
    workspaceId: WORKSPACE,
    agentId: MANAGER,
    laneId: LANE,
    subject: {
      type: "manager_review",
      sourceTaskId: SOURCE_TASK,
      evidenceId: EVIDENCE_ID,
      evidenceDigest: EVIDENCE_DIGEST,
    },
    title: "Review exact passing evidence",
    objective: "Inspect evidence without modifying the developer workspace.",
    status: "queued",
    expectedAgentMinutes: 15,
    expectedCompletedAt: "2026-07-19T20:15:00.000Z",
    startedAt: null,
    endedAt: null,
  });
}

export function evidence(overrides: Partial<PassingEngineerEvidence> = {}): PassingEngineerEvidence {
  return parsePassingEngineerEvidence({
    apiVersion: 1,
    evidenceId: EVIDENCE_ID,
    evidenceDigest: EVIDENCE_DIGEST,
    registeredBy: "trusted-evidence-service",
    registeredAt: "2026-07-19T19:59:00.000Z",
    workspaceId: WORKSPACE,
    taskId: SOURCE_TASK,
    completionEventId: "engineer-completion-event",
    engineerAgentId: "engineer-one",
    engineerLaneId: "engineer-lane-one",
    checkpointRef: "engineer-checkpoint",
    resultOverview: "Duplicate production charges are prevented.",
    testOutcome: "passed",
    testEvidenceDigest: TEST_DIGEST,
    releaseArtifactDigest: ARTIFACT_DIGEST,
    releaseManifestDigest: MANIFEST_DIGEST,
    targetEnvironment: "production-us",
    completedAt: "2026-07-19T19:58:00.000Z",
    ...overrides,
  });
}

export function inspection(
  state: EvidenceInspectionResult["state"] = "accepted",
  overrides: Partial<EvidenceInspectionResult> = {},
): EvidenceInspectionResult {
  return parseInspectionResult({
    state,
    evidenceDigest: EVIDENCE_DIGEST,
    testEvidenceDigest: TEST_DIGEST,
    releaseArtifactDigest: ARTIFACT_DIGEST,
    releaseManifestDigest: MANIFEST_DIGEST,
    summary: "The frozen evidence and passing test record match the reviewed release.",
    remainingRisks: "Human production approval is still required.",
    ...overrides,
  });
}

export function command(
  serverSequence: number,
  payload: RuntimeCommandEnvelope["payload"],
  runtimeEpoch = 1,
): RuntimeCommandEnvelope {
  return parseRuntimeCommandEnvelope({
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    commandId: `manager-command-${serverSequence}`,
    workspaceId: WORKSPACE,
    agentId: MANAGER,
    laneId: LANE,
    serverSequence,
    expectedRuntimeEpoch: runtimeEpoch,
    issuedAt: NOW,
    payload,
  });
}

export class FakeControl implements ManagerRuntimeControlClient {
  readonly registrations: Array<{
    request: SupervisorRegistrationRequest;
    challenge: string;
    replacementProof: string | null;
  }> = [];
  readonly uploaded: DurableOutboxEvent[] = [];
  readonly commands: RuntimeCommandEnvelope[] = [];
  generationProof = GENERATION_PROOF;
  latestEpoch = 0;
  lastAcceptedLocalSequence = 0;
  registrationFailures = 0;
  renewCalls = 0;

  register(
    request: SupervisorRegistrationRequest,
    context: Readonly<{ runtimeProofChallenge: string; replacementProof: string | null }>,
  ): Promise<ManagerRegistrationSession> {
    this.registrations.push({
      request,
      challenge: context.runtimeProofChallenge,
      replacementProof: context.replacementProof,
    });
    const runtimeEpoch = request.expectedRuntimeEpoch === null ? 1 : request.expectedRuntimeEpoch + 1;
    this.latestEpoch = runtimeEpoch;
    const session: ManagerRegistrationSession = {
      ...parseSupervisorRegistrationResult({
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        laneId: request.laneId,
        runtimeInstanceId: request.runtimeInstanceId,
        runtimeEpoch,
        leaseId: `manager-lease-${runtimeEpoch}`,
        leaseGrantedAt: NOW,
        leaseExpiresAt: "2026-07-19T20:01:00.000Z",
        lastAcceptedLocalSequence: this.lastAcceptedLocalSequence,
        controlVersion: runtimeEpoch,
      }),
      runtimeGenerationProof: this.generationProof,
    };
    if (this.registrationFailures > 0) {
      this.registrationFailures -= 1;
      return Promise.reject(new Error("Simulated lost registration response"));
    }
    return Promise.resolve(session);
  }

  renewLease(request: LeaseRenewalRequest) {
    this.renewCalls += 1;
    const grantedAt = new Date(request.sentAt);
    const expiresAt = new Date(grantedAt.valueOf() + 60_000);
    return Promise.resolve(parseLeaseRenewalResult({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: request.workspaceId,
      agentId: request.agentId,
      laneId: request.laneId,
      runtimeInstanceId: request.runtimeInstanceId,
      runtimeEpoch: request.runtimeEpoch,
      leaseId: request.leaseId,
      leaseGrantedAt: grantedAt.toISOString(),
      leaseExpiresAt: expiresAt.toISOString(),
      acceptedThroughLocalSequence: request.lastDurableEventSequence,
      controlVersion: 1,
    }));
  }

  pollCommands(request: RuntimeCommandPollRequest) {
    const selected = this.commands.filter((item) => item.serverSequence > request.afterServerSequence);
    return Promise.resolve(parseRuntimeCommandPollResult({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: request.workspaceId,
      agentId: request.agentId,
      laneId: request.laneId,
      runtimeInstanceId: request.runtimeInstanceId,
      runtimeEpoch: request.runtimeEpoch,
      latestServerSequence: selected.at(-1)?.serverSequence ?? request.afterServerSequence,
      commands: selected,
    }));
  }

  uploadEvents(request: RuntimeEventBatch) {
    this.uploaded.push(...request.events);
    return Promise.resolve(parseRuntimeEventBatchReceipt({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: request.workspaceId,
      agentId: request.agentId,
      laneId: request.laneId,
      runtimeInstanceId: request.runtimeInstanceId,
      runtimeEpoch: request.runtimeEpoch,
      acceptedThroughLocalSequence: request.events.at(-1)?.localSequence ?? 0,
      controlVersion: 1,
    }));
  }
}

export class FakeReviews implements ManagerReviewClient {
  queue: PassingEngineerEvidence[] = [evidence()];
  beforeRecord: (() => void) | null = null;
  calls: Array<{
    claim: ManagerRuntimeClaim;
    evidenceId: string;
    request: ManagerReviewRequest;
    idempotencyKey: string;
  }> = [];

  listQueue(claim: ManagerRuntimeClaim): Promise<readonly PassingEngineerEvidence[]> {
    if (claim.runtimeGenerationProof !== GENERATION_PROOF) throw new Error("Runtime proof missing");
    return Promise.resolve(structuredClone(this.queue));
  }

  recordReview(
    claim: ManagerRuntimeClaim,
    evidenceId: string,
    request: ManagerReviewRequest,
    idempotencyKey: string,
  ): Promise<ManagerReviewReceipt> {
    this.beforeRecord?.();
    this.calls.push({ claim, evidenceId, request, idempotencyKey });
    return Promise.resolve({
      managerReviewId: "22222222-2222-4222-8222-222222222222",
      reviewTaskId: request.reviewTaskId,
      evidenceId,
      evidenceDigest: request.evidenceDigest,
      decision: request.decision,
      managerRuntimeInstanceId: claim.runtimeInstanceId,
      managerRuntimeEpoch: claim.runtimeEpoch,
      duplicate: this.calls.length > 1,
    });
  }
}

export class SequenceInspector implements ReadOnlyManagerInspector {
  readonly calls: EvidenceInspectionRequest[] = [];
  readonly #results: EvidenceInspectionResult[];
  constructor(results: readonly EvidenceInspectionResult[]) { this.#results = [...results]; }
  inspect(request: EvidenceInspectionRequest): Promise<EvidenceInspectionResult> {
    this.calls.push(structuredClone(request));
    return Promise.resolve(this.#results.shift() ?? inspection("changes_requested"));
  }
}
