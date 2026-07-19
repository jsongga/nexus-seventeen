import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createControlPlane,
  type ControlPlaneService,
} from "@cicada/steward-control-plane";
import {
  createDeploymentBroker,
  type DeploymentBrokerService,
} from "@cicada/steward-deployment-broker";
import {
  createManagerReviewService,
  HttpControlPlaneManagerAuthorizer,
  HttpManagerHandoffRegistrar,
  MANAGER_RUNTIME_EPOCH_HEADER,
  MANAGER_RUNTIME_INSTANCE_HEADER,
  type ManagerReviewService,
} from "@cicada/steward-manager-review";
import {
  ROLE_CAPABILITIES,
  STEWARD_RUNTIME_API_VERSION,
  STEWARD_UI_API_VERSION,
} from "@cicada/steward-protocol";

const EVIDENCE_TOKEN = "integration-evidence-token-00000000000001";
const MANAGER_TOKEN = "integration-manager-token-00000000000001";
const CHECK_READER_TOKEN = "integration-check-reader-00000000000001";
const HANDOFF_TOKEN = "integration-handoff-token-00000000000001";
const OWNER_TOKEN = "integration-owner-token-0000000000000001";
const EXECUTOR_TOKEN = "integration-executor-token-0000000000001";
const CONTROL_PLANE_RUNTIME_TOKEN = "integration-control-manager-runtime-00000001";
const CONTROL_PLANE_HUMAN_TOKEN = "integration-control-human-token-000000001";
const CONTROL_PLANE_OBSERVER_TOKEN = "integration-control-observer-token-00001";
const WORKSPACE_ID = "workspace-production-gate";
const MANAGER_AGENT_ID = "manager-one";
const MANAGER_LANE_ID = "manager-lane-one";
const MANAGER_RUNTIME_INSTANCE_ID = "manager-runtime-production-gate";
const ARTIFACT = `sha256:${"a".repeat(64)}`;
const MANIFEST = `sha256:${"d".repeat(64)}`;

function headers(
  token: string,
  idempotencyKey?: string,
  managerRuntimeEpoch?: number,
  managerRuntimeInstanceId = MANAGER_RUNTIME_INSTANCE_ID,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
    ...(managerRuntimeEpoch === undefined
      ? {}
      : {
          [MANAGER_RUNTIME_INSTANCE_HEADER]: managerRuntimeInstanceId,
          [MANAGER_RUNTIME_EPOCH_HEADER]: String(managerRuntimeEpoch),
        }),
  };
}

function managerRegistration(runtimeInstanceId: string, expectedRuntimeEpoch: number | null) {
  return {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: WORKSPACE_ID,
    agentId: MANAGER_AGENT_ID,
    laneId: MANAGER_LANE_ID,
    runtimeInstanceId,
    expectedRuntimeEpoch,
    displayName: "Production manager",
    role: "manager",
    capabilities: ROLE_CAPABILITIES.manager,
    provider: { name: "codex", model: "gpt-5.4-mini" },
    softwareVersion: "0.1.0",
    checkpointRef: null,
  } as const;
}

test("only a live manager can create a human check and only the human owner can authorize production", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-production-gate-"));
  const now = () => new Date("2026-07-18T20:00:00.000Z");
  let controlPlane: ControlPlaneService | undefined;
  let broker: DeploymentBrokerService | undefined;
  let reviews: ManagerReviewService | undefined;
  try {
    controlPlane = await createControlPlane({
      workspaceId: WORKSPACE_ID,
      storePath: join(root, "control-plane", "events.jsonl"),
      workloadIdentities: [{
        workspaceId: WORKSPACE_ID,
        agentId: MANAGER_AGENT_ID,
        laneId: MANAGER_LANE_ID,
        role: "manager",
        token: CONTROL_PLANE_RUNTIME_TOKEN,
      }],
      humanToken: CONTROL_PLANE_HUMAN_TOKEN,
      observerReadToken: CONTROL_PLANE_OBSERVER_TOKEN,
      leaseMs: 60_000,
      keepAliveMs: 1_000,
      now,
    });
    const controlPlaneAddress = await controlPlane.start();
    const registrationResponse = await fetch(`${controlPlaneAddress.url}/v1/runtime/register`, {
      method: "POST",
      headers: headers(CONTROL_PLANE_RUNTIME_TOKEN),
      body: JSON.stringify(managerRegistration(MANAGER_RUNTIME_INSTANCE_ID, null)),
    });
    const registration = await registrationResponse.json() as { runtimeEpoch: number };
    assert.equal(registrationResponse.status, 200, JSON.stringify(registration));

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
      workspaceId: WORKSPACE_ID,
      storePath: join(root, "reviews", "events.jsonl"),
      evidenceIssuerToken: EVIDENCE_TOKEN,
      evidenceIssuerPrincipal: "service:engineer-evidence",
      humanToken: CHECK_READER_TOKEN,
      managers: [{
        workspaceId: WORKSPACE_ID,
        agentId: MANAGER_AGENT_ID,
        laneId: MANAGER_LANE_ID,
        role: "manager",
        token: MANAGER_TOKEN,
      }],
      handoffRegistrar: new HttpManagerHandoffRegistrar({
        brokerOrigin: brokerAddress.url,
        handoffIssuerToken: HANDOFF_TOKEN,
      }),
      managerRuntimeAuthorizer: new HttpControlPlaneManagerAuthorizer({
        controlPlaneOrigin: controlPlaneAddress.url,
        observerReadToken: CONTROL_PLANE_OBSERVER_TOKEN,
        now,
      }),
      now,
    });
    const reviewAddress = await reviews.start();

    const evidenceResponse = await fetch(`${reviewAddress.url}/v1/passing-evidence`, {
      method: "POST",
      headers: headers(EVIDENCE_TOKEN, "evidence-production-gate-0001"),
      body: JSON.stringify({
        workspaceId: WORKSPACE_ID,
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
        headers: headers(
          MANAGER_TOKEN,
          "review-production-gate-00001",
          registration.runtimeEpoch,
        ),
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

    const interruptResponse = await fetch(`${controlPlaneAddress.url}/v1/ui/commands`, {
      method: "POST",
      headers: headers(CONTROL_PLANE_HUMAN_TOKEN),
      body: JSON.stringify({
        apiVersion: STEWARD_UI_API_VERSION,
        clientCommandId: "interrupt-production-manager",
        workspaceId: WORKSPACE_ID,
        expectedControlVersion: 0,
        issuedAt: now().toISOString(),
        payload: {
          type: "request_interrupt",
          agentId: MANAGER_AGENT_ID,
          laneId: MANAGER_LANE_ID,
          reason: "Stop manager review before any further production handoff.",
        },
      }),
    });
    assert.equal(interruptResponse.status, 200, await interruptResponse.text());

    const replacementInstanceId = "manager-runtime-production-gate-replacement";
    const replacementResponse = await fetch(`${controlPlaneAddress.url}/v1/runtime/register`, {
      method: "POST",
      headers: headers(CONTROL_PLANE_RUNTIME_TOKEN),
      body: JSON.stringify(managerRegistration(replacementInstanceId, registration.runtimeEpoch)),
    });
    const replacement = await replacementResponse.json() as { runtimeEpoch: number };
    assert.equal(replacementResponse.status, 200, JSON.stringify(replacement));

    const exactReplayAfterReplacementAndInterrupt = await fetch(
      `${reviewAddress.url}/v1/passing-evidence/${registered.evidence.evidenceId}/reviews`,
      {
        method: "POST",
        headers: headers(
          MANAGER_TOKEN,
          "review-production-gate-00001",
          replacement.runtimeEpoch,
          replacementInstanceId,
        ),
        body: JSON.stringify({
          evidenceDigest: registered.evidence.evidenceDigest,
          decision: "accepted",
          summary: "The evidence supports the intended customer outcome.",
          remainingRisks: "Release monitoring and rollback readiness remain human responsibilities.",
        }),
      },
    );
    assert.equal(exactReplayAfterReplacementAndInterrupt.status, 200);
    assert.equal(
      (await exactReplayAfterReplacementAndInterrupt.json() as { duplicate: boolean }).duplicate,
      true,
    );

    const secondEvidenceResponse = await fetch(`${reviewAddress.url}/v1/passing-evidence`, {
      method: "POST",
      headers: headers(EVIDENCE_TOKEN, "evidence-production-gate-0002"),
      body: JSON.stringify({
        workspaceId: WORKSPACE_ID,
        taskId: "task-production-gate-two",
        completionEventId: "completion-production-gate-two",
        engineerAgentId: "engineer-two",
        engineerLaneId: "engineer-lane-two",
        checkpointRef: "commit:fedcba9876543210",
        resultOverview: "Customers receive a stable order confirmation.",
        testOutcome: "passed",
        testEvidenceDigest: `sha256:${"e".repeat(64)}`,
        releaseArtifactDigest: `sha256:${"f".repeat(64)}`,
        releaseManifestDigest: `sha256:${"1".repeat(64)}`,
        targetEnvironment: "production-us",
        completedAt: "2026-07-18T19:59:00.000Z",
      }),
    });
    assert.equal(secondEvidenceResponse.status, 201);
    const secondEvidence = await secondEvidenceResponse.json() as {
      evidence: { evidenceId: string; evidenceDigest: string };
    };
    const interruptedReview = await fetch(
      `${reviewAddress.url}/v1/passing-evidence/${secondEvidence.evidence.evidenceId}/reviews`,
      {
        method: "POST",
        headers: headers(
          MANAGER_TOKEN,
          "review-production-gate-00002",
          replacement.runtimeEpoch,
          replacementInstanceId,
        ),
        body: JSON.stringify({
          evidenceDigest: secondEvidence.evidence.evidenceDigest,
          decision: "accepted",
          summary: "This must not be recorded while the manager is interrupted.",
          remainingRisks: "The human stop command is authoritative.",
        }),
      },
    );
    assert.equal(interruptedReview.status, 409);
    assert.equal(
      (await interruptedReview.json() as { error: { code: string } }).error.code,
      "MANAGER_RUNTIME_NOT_ACTIVE",
    );

    const checksResponse = await fetch(
      `${reviewAddress.url}/v1/production-checks?workspaceId=${WORKSPACE_ID}`,
      { headers: { Authorization: `Bearer ${CHECK_READER_TOKEN}` } },
    );
    assert.equal(checksResponse.status, 200);
    assert.equal((await checksResponse.json() as { items: unknown[] }).items.length, 1);
  } finally {
    await reviews?.close();
    await broker?.close();
    await controlPlane?.close();
  }
});
