import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createControlPlane,
  type ControlPlaneService,
} from "#server/control-plane";
import {
  createDeploymentBroker,
  type DeploymentBrokerService,
} from "#server/review/deployment-broker";
import {
  createManagerReviewService,
  HttpControlPlaneManagerAuthorizer,
  HttpControlPlaneManagerReviewPermitConsumer,
  HttpManagerHandoffRegistrar,
  MANAGER_RUNTIME_EPOCH_HEADER,
  MANAGER_RUNTIME_GENERATION_PROOF_HEADER,
  MANAGER_RUNTIME_INSTANCE_HEADER,
  type ManagerReviewService,
} from "#server/review/manager-review";
import {
  ROLE_CAPABILITIES,
  STEWARD_RUNTIME_API_VERSION,
  STEWARD_RUNTIME_GENERATION_PROOF_HEADER,
  STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER,
  STEWARD_UI_API_VERSION,
} from "#shared/protocol";

const EVIDENCE_TOKEN = "integration-evidence-token-00000000000001";
const MANAGER_TOKEN = "integration-manager-token-00000000000001";
const CHECK_READER_TOKEN = "integration-check-reader-00000000000001";
const HANDOFF_TOKEN = "integration-handoff-token-00000000000001";
const OWNER_TOKEN = "integration-owner-token-0000000000000001";
const EXECUTOR_TOKEN = "integration-executor-token-0000000000001";
const CONTROL_PLANE_RUNTIME_TOKEN = "integration-control-manager-runtime-00000001";
const CONTROL_PLANE_ENGINEER_TOKEN = "integration-control-engineer-runtime-00001";
const CONTROL_PLANE_HUMAN_TOKEN = "integration-control-human-token-000000001";
const CONTROL_PLANE_OBSERVER_TOKEN = "integration-control-observer-token-00001";
const CONTROL_PLANE_PERMIT_TOKEN = "integration-control-review-permit-token-00001";
const WORKSPACE_ID = "workspace-production-gate";
const ENGINEER_AGENT_ID = "engineer-one";
const ENGINEER_LANE_ID = "engineer-lane-one";
const ENGINEER_RUNTIME_INSTANCE_ID = "engineer-runtime-production-gate";
const MANAGER_AGENT_ID = "manager-one";
const MANAGER_LANE_ID = "manager-lane-one";
const MANAGER_RUNTIME_INSTANCE_ID = "manager-runtime-production-gate";
const ARTIFACT = `sha256:${"a".repeat(64)}`;
const MANIFEST = `sha256:${"d".repeat(64)}`;
const SOURCE_COMMAND_ID = "production-gate-source";
const SOURCE_TASK_ID = `task_${SOURCE_COMMAND_ID}`;
const REVIEW_COMMAND_ID = "production-gate-review";
const REVIEW_TASK_ID = `task_${REVIEW_COMMAND_ID}`;

function headers(
  token: string,
  idempotencyKey?: string,
  managerRuntimeEpoch?: number,
  managerRuntimeInstanceId = MANAGER_RUNTIME_INSTANCE_ID,
  managerRuntimeProof?: string,
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
          ...(managerRuntimeProof === undefined
            ? {}
            : { [MANAGER_RUNTIME_GENERATION_PROOF_HEADER]: managerRuntimeProof }),
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

function engineerRegistration() {
  return {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: WORKSPACE_ID,
    agentId: ENGINEER_AGENT_ID,
    laneId: ENGINEER_LANE_ID,
    runtimeInstanceId: ENGINEER_RUNTIME_INSTANCE_ID,
    expectedRuntimeEpoch: null,
    displayName: "Production engineer",
    role: "engineer",
    capabilities: ROLE_CAPABILITIES.engineer,
    provider: { name: "codex", model: "gpt-5.4-mini" },
    softwareVersion: "0.1.0",
    checkpointRef: null,
  } as const;
}

async function postHumanCommand(
  baseUrl: string,
  clientCommandId: string,
  expectedControlVersion: number,
  issuedAt: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/ui/commands`, {
    method: "POST",
    headers: headers(CONTROL_PLANE_HUMAN_TOKEN),
    body: JSON.stringify({
      apiVersion: STEWARD_UI_API_VERSION,
      clientCommandId,
      workspaceId: WORKSPACE_ID,
      expectedControlVersion,
      issuedAt,
      payload,
    }),
  });
  assert.equal(response.status, 200, await response.text());
}

function runtimeEvent(
  identity: {
    agentId: string;
    laneId: string;
    runtimeInstanceId: string;
    runtimeEpoch: number;
  },
  localSequence: number,
  occurredAt: string,
  payload: Record<string, unknown>,
) {
  return {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    eventId: `production-gate-${identity.laneId}-${identity.runtimeEpoch}-${localSequence}`,
    workspaceId: WORKSPACE_ID,
    ...identity,
    localSequence,
    occurredAt,
    payload,
  };
}

async function postRuntimeEvents(
  baseUrl: string,
  token: string,
  identity: {
    agentId: string;
    laneId: string;
    runtimeInstanceId: string;
    runtimeEpoch: number;
  },
  events: readonly ReturnType<typeof runtimeEvent>[],
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/runtime/events`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: WORKSPACE_ID,
      ...identity,
      events,
    }),
  });
  assert.equal(response.status, 200, await response.text());
}

test("only a live manager can create a human check and only the human owner can authorize production", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-production-gate-"));
  let currentTime = new Date("2026-07-18T20:00:10.000Z");
  const now = () => new Date(currentTime);
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
      }, {
        workspaceId: WORKSPACE_ID,
        agentId: ENGINEER_AGENT_ID,
        laneId: ENGINEER_LANE_ID,
        role: "engineer",
        token: CONTROL_PLANE_ENGINEER_TOKEN,
      }],
      humanToken: CONTROL_PLANE_HUMAN_TOKEN,
      observerReadToken: CONTROL_PLANE_OBSERVER_TOKEN,
      managerReviewPermitToken: CONTROL_PLANE_PERMIT_TOKEN,
      leaseMs: 60_000,
      keepAliveMs: 1_000,
      now,
    });
    const controlPlaneAddress = await controlPlane.start();
    const registrationResponse = await fetch(`${controlPlaneAddress.url}/v1/runtime/register`, {
      method: "POST",
      headers: {
        ...headers(CONTROL_PLANE_RUNTIME_TOKEN),
        [STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER]: `rgc_${"m".repeat(43)}`,
      },
      body: JSON.stringify(managerRegistration(MANAGER_RUNTIME_INSTANCE_ID, null)),
    });
    const registration = await registrationResponse.json() as { runtimeEpoch: number };
    assert.equal(registrationResponse.status, 200, JSON.stringify(registration));
    const managerRuntimeProof =
      registrationResponse.headers.get(STEWARD_RUNTIME_GENERATION_PROOF_HEADER) ?? "";
    assert.match(managerRuntimeProof, /^rgp_[A-Za-z0-9_-]{43}$/u);

    const engineerRegistrationResponse = await fetch(`${controlPlaneAddress.url}/v1/runtime/register`, {
      method: "POST",
      headers: headers(CONTROL_PLANE_ENGINEER_TOKEN),
      body: JSON.stringify(engineerRegistration()),
    });
    const engineerRuntime = await engineerRegistrationResponse.json() as { runtimeEpoch: number };
    assert.equal(
      engineerRegistrationResponse.status,
      200,
      JSON.stringify(engineerRuntime),
    );

    await postHumanCommand(
      controlPlaneAddress.url,
      SOURCE_COMMAND_ID,
      0,
      "2026-07-18T20:00:00.000Z",
      {
        type: "queue_work",
        agentId: ENGINEER_AGENT_ID,
        laneId: ENGINEER_LANE_ID,
        subject: { type: "development" },
        title: "Prevent duplicate production charges",
        objective: "Complete the research, plan, execute, and passing test loop.",
        expectedAgentMinutes: 15,
        expectedCompletedAt: "2026-07-18T20:15:00.000Z",
      },
    );
    const engineerIdentity = {
      agentId: ENGINEER_AGENT_ID,
      laneId: ENGINEER_LANE_ID,
      runtimeInstanceId: ENGINEER_RUNTIME_INSTANCE_ID,
      runtimeEpoch: engineerRuntime.runtimeEpoch,
    };
    const engineerLifecycle = [
      { type: "progress", taskId: SOURCE_TASK_ID, phase: "research", iteration: 1, journal: "Inspected the customer charge flow." },
      { type: "progress", taskId: SOURCE_TASK_ID, phase: "plan", iteration: 1, journal: "Recorded the smallest safe implementation plan." },
      { type: "progress", taskId: SOURCE_TASK_ID, phase: "execute", iteration: 1, journal: "Implemented idempotent charge handling." },
      { type: "progress", taskId: SOURCE_TASK_ID, phase: "test", iteration: 1, journal: "Duplicate-submit tests passed.", outcome: "passed" },
      { type: "task_completed", taskId: SOURCE_TASK_ID, result: "Customers can finish checkout without duplicate charges.", checkpointRef: null },
    ];
    await postRuntimeEvents(
      controlPlaneAddress.url,
      CONTROL_PLANE_ENGINEER_TOKEN,
      engineerIdentity,
      engineerLifecycle.map((payload, index) => runtimeEvent(
        engineerIdentity,
        index + 1,
        `2026-07-18T20:00:0${index + 1}.000Z`,
        payload,
      )),
    );

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
      managerReviewPermitConsumer: new HttpControlPlaneManagerReviewPermitConsumer({
        controlPlaneOrigin: controlPlaneAddress.url,
        permitConsumeToken: CONTROL_PLANE_PERMIT_TOKEN,
      }),
      now,
    });
    const reviewAddress = await reviews.start();

    const evidenceResponse = await fetch(`${reviewAddress.url}/v1/passing-evidence`, {
      method: "POST",
      headers: headers(EVIDENCE_TOKEN, "evidence-production-gate-0001"),
      body: JSON.stringify({
        workspaceId: WORKSPACE_ID,
        taskId: SOURCE_TASK_ID,
        completionEventId: "completion-production-gate",
        engineerAgentId: ENGINEER_AGENT_ID,
        engineerLaneId: ENGINEER_LANE_ID,
        checkpointRef: "commit:0123456789abcdef",
        resultOverview: "Customers can finish checkout without duplicate charges.",
        testOutcome: "passed",
        testEvidenceDigest: `sha256:${"b".repeat(64)}`,
        releaseArtifactDigest: ARTIFACT,
        releaseManifestDigest: MANIFEST,
        targetEnvironment: "production-us",
        completedAt: "2026-07-18T20:00:05.000Z",
      }),
    });
    assert.equal(evidenceResponse.status, 201);
    const registered = await evidenceResponse.json() as {
      evidence: { evidenceId: string; evidenceDigest: string };
    };

    await postHumanCommand(
      controlPlaneAddress.url,
      REVIEW_COMMAND_ID,
      1,
      "2026-07-18T20:00:10.000Z",
      {
        type: "queue_work",
        agentId: MANAGER_AGENT_ID,
        laneId: MANAGER_LANE_ID,
        subject: {
          type: "manager_review",
          sourceTaskId: SOURCE_TASK_ID,
          evidenceId: registered.evidence.evidenceId,
          evidenceDigest: registered.evidence.evidenceDigest,
        },
        title: "Review the passing checkout evidence",
        objective: "Check the immutable result and identify remaining user risk.",
        expectedAgentMinutes: 15,
        expectedCompletedAt: "2026-07-18T20:30:00.000Z",
      },
    );
    const managerIdentity = {
      agentId: MANAGER_AGENT_ID,
      laneId: MANAGER_LANE_ID,
      runtimeInstanceId: MANAGER_RUNTIME_INSTANCE_ID,
      runtimeEpoch: registration.runtimeEpoch,
    };
    await postRuntimeEvents(
      controlPlaneAddress.url,
      CONTROL_PLANE_RUNTIME_TOKEN,
      managerIdentity,
      [runtimeEvent(managerIdentity, 1, "2026-07-18T20:00:11.000Z", {
        type: "heartbeat",
        currentAction: {
          taskId: REVIEW_TASK_ID,
          summary: "Checking the assigned immutable evidence and user impact.",
          startedAt: "2026-07-18T20:00:11.000Z",
        },
        checkpointRef: null,
      })],
    );
    currentTime = new Date("2026-07-18T20:00:12.000Z");

    const reviewResponse = await fetch(
      `${reviewAddress.url}/v1/passing-evidence/${registered.evidence.evidenceId}/reviews`,
      {
        method: "POST",
        headers: headers(
          MANAGER_TOKEN,
          "review-production-gate-00001",
          registration.runtimeEpoch,
          MANAGER_RUNTIME_INSTANCE_ID,
          managerRuntimeProof,
        ),
        body: JSON.stringify({
          reviewTaskId: REVIEW_TASK_ID,
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
        taskId: SOURCE_TASK_ID,
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
        taskId: SOURCE_TASK_ID,
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
          taskId: SOURCE_TASK_ID,
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
          taskId: SOURCE_TASK_ID,
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
        expectedControlVersion: 2,
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
      headers: {
        ...headers(CONTROL_PLANE_RUNTIME_TOKEN),
        [STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER]: `rgc_${"r".repeat(43)}`,
        [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]: managerRuntimeProof,
      },
      body: JSON.stringify(managerRegistration(replacementInstanceId, registration.runtimeEpoch)),
    });
    const replacement = await replacementResponse.json() as { runtimeEpoch: number };
    assert.equal(replacementResponse.status, 200, JSON.stringify(replacement));
    const replacementRuntimeProof =
      replacementResponse.headers.get(STEWARD_RUNTIME_GENERATION_PROOF_HEADER) ?? "";
    assert.match(replacementRuntimeProof, /^rgp_[A-Za-z0-9_-]{43}$/u);

    const exactReplayAfterReplacementAndInterrupt = await fetch(
      `${reviewAddress.url}/v1/passing-evidence/${registered.evidence.evidenceId}/reviews`,
      {
        method: "POST",
        headers: headers(
          MANAGER_TOKEN,
          "review-production-gate-00001",
          replacement.runtimeEpoch,
          replacementInstanceId,
          replacementRuntimeProof,
        ),
        body: JSON.stringify({
          reviewTaskId: REVIEW_TASK_ID,
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
          replacementRuntimeProof,
        ),
        body: JSON.stringify({
          reviewTaskId: "task-interrupted-review",
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
      "CONTROL_PLANE_PERMIT_REJECTED",
    );

    const checksResponse = await fetch(
      `${reviewAddress.url}/v1/production-checks?workspaceId=${WORKSPACE_ID}`,
      { headers: { Authorization: `Bearer ${CHECK_READER_TOKEN}` } },
    );
    assert.equal(checksResponse.status, 200);
    const checks = (await checksResponse.json() as {
      items: Array<{
        taskId: string;
        reviewTaskId: string;
        permitId: string;
        permitWorkspaceSequence: number;
      }>;
    }).items;
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.taskId, SOURCE_TASK_ID);
    assert.equal(checks[0]?.reviewTaskId, REVIEW_TASK_ID);
    assert.match(checks[0]?.permitId ?? "", /^permit_[0-9a-f-]{36}$/u);
    assert.ok((checks[0]?.permitWorkspaceSequence ?? 0) > 0);
  } finally {
    await reviews?.close();
    await broker?.close();
    await controlPlane?.close();
  }
});
