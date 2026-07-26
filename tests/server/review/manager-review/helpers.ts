import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseManagerReviewPermitConsumeReceipt,
  STEWARD_RUNTIME_API_VERSION,
  type ManagerReviewPermitConsumeReceipt,
  type ManagerReviewPermitConsumeRequest,
} from "#shared/protocol";
import { ReviewServiceError } from "#server/review/manager-review";
import type {
  FixedManagerIdentity,
  ManagerHandoffRegistrar,
  ManagerReviewPermitConsumer,
  ManagerRuntimeAuthorizer,
  ManagerRuntimeClaim,
  PassingEngineerEvidenceRequest,
  RegisterManagerHandoffRequest,
  RegisterManagerHandoffResult,
} from "#server/review/manager-review";

export const WORKSPACE_ID = "workspace-alpha";
export const EVIDENCE_TOKEN = "trusted-evidence-issuer-token-0123456789";
export const HUMAN_TOKEN = "human-production-check-token-0123456789";
export const MANAGER_ONE_TOKEN = "manager-one-fixed-lane-token-0123456789";
export const MANAGER_TWO_TOKEN = "manager-two-fixed-lane-token-0123456789";
export const PERMIT_CONSUME_TOKEN = "manager-review-permit-consume-token-0123456789";

export const MANAGER_ONE: FixedManagerIdentity = Object.freeze({
  workspaceId: WORKSPACE_ID,
  agentId: "manager-one",
  laneId: "manager-lane-one",
  role: "manager",
});

export const MANAGER_TWO: FixedManagerIdentity = Object.freeze({
  workspaceId: WORKSPACE_ID,
  agentId: "manager-two",
  laneId: "manager-lane-two",
  role: "manager",
});

export const MANAGER_ONE_RUNTIME: ManagerRuntimeClaim = Object.freeze({
  ...MANAGER_ONE,
  runtimeInstanceId: "manager-runtime-one",
  runtimeEpoch: 7,
});

export const MANAGER_TWO_RUNTIME: ManagerRuntimeClaim = Object.freeze({
  ...MANAGER_TWO,
  runtimeInstanceId: "manager-runtime-two",
  runtimeEpoch: 3,
});

export class FakeManagerRuntimeAuthorizer implements ManagerRuntimeAuthorizer {
  readonly calls: ManagerRuntimeClaim[] = [];
  reject = false;

  async authorizeManagerRuntime(claim: ManagerRuntimeClaim): Promise<void> {
    this.calls.push(structuredClone(claim));
    if (this.reject) {
      throw new ReviewServiceError(409, "MANAGER_RUNTIME_FENCED", "simulated fenced manager runtime");
    }
  }
}

function stablePermitRequest(request: ManagerReviewPermitConsumeRequest): Record<string, unknown> {
  const { runtimeInstanceId: _instance, runtimeEpoch: _epoch, ...stable } = request;
  return stable;
}

export class FakeManagerReviewPermitConsumer implements ManagerReviewPermitConsumer {
  readonly calls: ManagerReviewPermitConsumeRequest[] = [];
  readonly #receipts = new Map<string, {
    readonly stableRequest: Record<string, unknown>;
    readonly receipt: ManagerReviewPermitConsumeReceipt;
  }>();
  reject = false;
  nextWorkspaceSequence = 100;

  async consumeManagerReviewPermit(
    request: ManagerReviewPermitConsumeRequest,
  ): Promise<ManagerReviewPermitConsumeReceipt> {
    this.calls.push(structuredClone(request));
    if (this.reject) {
      throw new ReviewServiceError(409, "CONTROL_PLANE_PERMIT_REJECTED", "simulated rejected review permit");
    }
    const stableRequest = stablePermitRequest(request);
    const prior = this.#receipts.get(request.operationId);
    if (prior) {
      if (JSON.stringify(prior.stableRequest) !== JSON.stringify(stableRequest)) {
        throw new ReviewServiceError(409, "PERMIT_OPERATION_CONFLICT", "simulated permit operation conflict");
      }
      return parseManagerReviewPermitConsumeReceipt({ ...prior.receipt, state: "duplicate" });
    }
    const receipt = parseManagerReviewPermitConsumeReceipt({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      state: "accepted",
      permitId: randomUUID(),
      operationId: request.operationId,
      workspaceId: request.workspaceId,
      reviewTaskId: request.reviewTaskId,
      sourceTaskId: request.sourceTaskId,
      evidenceId: request.evidenceId,
      evidenceDigest: request.evidenceDigest,
      managerAgentId: request.managerAgentId,
      managerLaneId: request.managerLaneId,
      managerRuntimeInstanceId: request.runtimeInstanceId,
      managerRuntimeEpoch: request.runtimeEpoch,
      reviewRequestDigest: request.reviewRequestDigest,
      authorizedAt: "2026-07-19T19:04:30.000Z",
      workspaceSequence: this.nextWorkspaceSequence++,
    });
    this.#receipts.set(request.operationId, { stableRequest, receipt });
    return receipt;
  }
}

export function passingEvidence(
  override: Partial<PassingEngineerEvidenceRequest> = {},
): PassingEngineerEvidenceRequest {
  return {
    workspaceId: WORKSPACE_ID,
    taskId: "task-checkout-retry",
    completionEventId: "completion-event-0001",
    engineerAgentId: "engineer-one",
    engineerLaneId: "engineer-lane-one",
    checkpointRef: "checkpoint-0001",
    resultOverview: "Customers can retry checkout without duplicate charges.",
    testOutcome: "passed",
    testEvidenceDigest: `sha256:${"a".repeat(64)}`,
    releaseArtifactDigest: `sha256:${"b".repeat(64)}`,
    releaseManifestDigest: `sha256:${"c".repeat(64)}`,
    targetEnvironment: "production-us",
    completedAt: "2026-07-19T19:00:00.000Z",
    ...override,
  };
}

export function managerReview(
  evidenceDigest: string,
  decision: "accepted" | "changes_requested" = "accepted",
  reviewTaskId = "manager-review-task-0001",
) {
  return {
    reviewTaskId,
    evidenceDigest,
    decision,
    summary: decision === "accepted"
      ? "The user-facing result is supported by the submitted passing evidence."
      : "The evidence does not cover the duplicate-submit edge case.",
    remainingRisks: decision === "accepted"
      ? "A human should verify the staged rollback and payment dashboard before production."
      : "Duplicate submits remain unverified.",
  } as const;
}

export async function temporaryStore(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steward-manager-review-"));
  return join(root, "private", "review-events.jsonl");
}

export class FakeHandoffRegistrar implements ManagerHandoffRegistrar {
  readonly calls: Array<{ request: RegisterManagerHandoffRequest; idempotencyKey: string }> = [];
  readonly permanentFailures = new Set<string>();
  readonly #accepted = new Map<string, RegisterManagerHandoffResult>();
  failuresRemaining = 0;
  failAll = false;

  async registerManagerHandoff(
    request: RegisterManagerHandoffRequest,
    idempotencyKey: string,
  ): Promise<RegisterManagerHandoffResult> {
    this.calls.push({ request: structuredClone(request), idempotencyKey });
    let result = this.#accepted.get(idempotencyKey);
    if (!result) {
      result = Object.freeze({
        duplicate: false,
        handoff: Object.freeze({
          apiVersion: 3 as const,
          handoffId: randomUUID(),
          status: "accepted" as const,
          acceptedBy: "service:manager-handoff",
          acceptedAt: "2026-07-19T19:05:00.000Z",
          ...request,
        }),
      });
      this.#accepted.set(idempotencyKey, result);
    } else {
      result = Object.freeze({ ...result, duplicate: true });
    }
    if (
      this.failAll ||
      this.permanentFailures.has(request.managerReviewId) ||
      this.failuresRemaining > 0
    ) {
      if (this.failuresRemaining > 0) this.failuresRemaining -= 1;
      throw new Error("simulated lost broker response");
    }
    return result;
  }
}
