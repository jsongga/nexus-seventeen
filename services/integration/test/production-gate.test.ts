import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDeploymentBroker,
  type DeploymentBrokerService,
} from "@cicada/steward-deployment-broker";
import {
  createManagerReviewService,
  HttpManagerHandoffRegistrar,
  type ManagerReviewService,
} from "@cicada/steward-manager-review";

const EVIDENCE_TOKEN = "integration-evidence-token-00000000000001";
const MANAGER_TOKEN = "integration-manager-token-00000000000001";
const CHECK_READER_TOKEN = "integration-check-reader-00000000000001";
const HANDOFF_TOKEN = "integration-handoff-token-00000000000001";
const OWNER_TOKEN = "integration-owner-token-0000000000000001";
const EXECUTOR_TOKEN = "integration-executor-token-0000000000001";
const ARTIFACT = `sha256:${"a".repeat(64)}`;
const MANIFEST = `sha256:${"d".repeat(64)}`;

function headers(token: string, idempotencyKey?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
  };
}

test("manager acceptance creates a human check but only the human owner can mint a one-use authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-production-gate-"));
  const now = () => new Date("2026-07-18T20:00:00.000Z");
  let broker: DeploymentBrokerService | undefined;
  let reviews: ManagerReviewService | undefined;
  try {
    broker = await createDeploymentBroker({
      storePath: join(root, "broker", "events.jsonl"),
      humanToken: OWNER_TOKEN,
      handoffIssuerToken: HANDOFF_TOKEN,
      executorToken: EXECUTOR_TOKEN,
      humanPrincipal: "human:release-owner",
      handoffIssuerPrincipal: "service:manager-review",
      executorPrincipal: "service:production-executor",
      targetEnvironments: ["production-us"],
      now,
    });
    const brokerAddress = await broker.start();
    reviews = await createManagerReviewService({
      workspaceId: "workspace-production-gate",
      storePath: join(root, "reviews", "events.jsonl"),
      evidenceIssuerToken: EVIDENCE_TOKEN,
      evidenceIssuerPrincipal: "service:engineer-evidence",
      humanToken: CHECK_READER_TOKEN,
      managers: [{
        workspaceId: "workspace-production-gate",
        agentId: "manager-one",
        laneId: "manager-lane-one",
        role: "manager",
        token: MANAGER_TOKEN,
      }],
      handoffRegistrar: new HttpManagerHandoffRegistrar({
        brokerOrigin: brokerAddress.url,
        handoffIssuerToken: HANDOFF_TOKEN,
      }),
      now,
    });
    const reviewAddress = await reviews.start();

    const evidenceResponse = await fetch(`${reviewAddress.url}/v1/passing-evidence`, {
      method: "POST",
      headers: headers(EVIDENCE_TOKEN, "evidence-production-gate-0001"),
      body: JSON.stringify({
        workspaceId: "workspace-production-gate",
        taskId: "task-production-gate",
        completionEventId: "completion-production-gate",
        engineerAgentId: "engineer-one",
        engineerLaneId: "engineer-lane-one",
        checkpointRef: "commit:0123456789abcdef",
        resultOverview: "Customers can finish checkout without duplicate charges.",
        testOutcome: "passed",
        testEvidenceDigest: `sha256:${"b".repeat(64)}`,
        releaseArtifactDigest: ARTIFACT,
        releaseManifestDigest: MANIFEST,
        targetEnvironment: "production-us",
        completedAt: "2026-07-18T19:58:00.000Z",
      }),
    });
    assert.equal(evidenceResponse.status, 201);
    const registered = await evidenceResponse.json() as {
      evidence: { evidenceId: string; evidenceDigest: string };
    };

    const reviewResponse = await fetch(
      `${reviewAddress.url}/v1/passing-evidence/${registered.evidence.evidenceId}/reviews`,
      {
        method: "POST",
        headers: headers(MANAGER_TOKEN, "review-production-gate-00001"),
        body: JSON.stringify({
          evidenceDigest: registered.evidence.evidenceDigest,
          decision: "accepted",
          summary: "The evidence supports the intended customer outcome.",
          remainingRisks: "Release monitoring and rollback readiness remain human responsibilities.",
        }),
      },
    );
    assert.equal(reviewResponse.status, 201);
    const review = await reviewResponse.json() as {
      productionCheck: {
        handoffId: string;
        managerReviewId: string;
        status: string;
      };
    };
    assert.equal(review.productionCheck.status, "pending_human_review");

    const managerCannotApprove = await fetch(`${brokerAddress.url}/v1/deployment-grants`, {
      method: "POST",
      headers: headers(MANAGER_TOKEN, "manager-cannot-approve-0001"),
      body: JSON.stringify({
        workspaceId: "workspace-production-gate",
        taskId: "task-production-gate",
        releaseArtifactDigest: ARTIFACT,
        releaseManifestDigest: MANIFEST,
        targetEnvironment: "production-us",
        handoffId: review.productionCheck.handoffId,
        expiresInSeconds: 60,
      }),
    });
    assert.equal(managerCannotApprove.status, 401);

    const grantResponse = await fetch(`${brokerAddress.url}/v1/deployment-grants`, {
      method: "POST",
      headers: headers(OWNER_TOKEN, "human-approval-production-0001"),
      body: JSON.stringify({
        workspaceId: "workspace-production-gate",
        taskId: "task-production-gate",
        releaseArtifactDigest: ARTIFACT,
        releaseManifestDigest: MANIFEST,
        targetEnvironment: "production-us",
        handoffId: review.productionCheck.handoffId,
        expiresInSeconds: 60,
      }),
    });
    assert.equal(grantResponse.status, 201);
    const grant = await grantResponse.json() as { grant: { grantId: string } };

    const consumeResponse = await fetch(
      `${brokerAddress.url}/v1/deployment-grants/${grant.grant.grantId}/consume`,
      {
        method: "POST",
        headers: headers(EXECUTOR_TOKEN, "executor-claim-production-0001"),
        body: JSON.stringify({
          workspaceId: "workspace-production-gate",
          taskId: "task-production-gate",
          releaseArtifactDigest: ARTIFACT,
          releaseManifestDigest: MANIFEST,
          targetEnvironment: "production-us",
        }),
      },
    );
    assert.equal(consumeResponse.status, 200);
    const consumed = await consumeResponse.json() as {
      authorization: { authorizationId: string; handoffId: string };
    };
    assert.match(consumed.authorization.authorizationId, /^[0-9a-f-]{36}$/u);
    assert.equal(consumed.authorization.handoffId, review.productionCheck.handoffId);

    const repeatConsume = await fetch(
      `${brokerAddress.url}/v1/deployment-grants/${grant.grant.grantId}/consume`,
      {
        method: "POST",
        headers: headers(EXECUTOR_TOKEN, "executor-second-claim-0001"),
        body: JSON.stringify({
          workspaceId: "workspace-production-gate",
          taskId: "task-production-gate",
          releaseArtifactDigest: ARTIFACT,
          releaseManifestDigest: MANIFEST,
          targetEnvironment: "production-us",
        }),
      },
    );
    assert.equal(repeatConsume.status, 409);
  } finally {
    await reviews?.close();
    await broker?.close();
  }
});
