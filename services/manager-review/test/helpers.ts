import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  FixedManagerIdentity,
  ManagerHandoffRegistrar,
  PassingEngineerEvidenceRequest,
  RegisterManagerHandoffRequest,
  RegisterManagerHandoffResult,
} from "../src/index.js";

export const WORKSPACE_ID = "workspace-alpha";
export const EVIDENCE_TOKEN = "trusted-evidence-issuer-token-0123456789";
export const HUMAN_TOKEN = "human-production-check-token-0123456789";
export const MANAGER_ONE_TOKEN = "manager-one-fixed-lane-token-0123456789";
export const MANAGER_TWO_TOKEN = "manager-two-fixed-lane-token-0123456789";

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

export function managerReview(evidenceDigest: string, decision: "accepted" | "changes_requested" = "accepted") {
  return {
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
