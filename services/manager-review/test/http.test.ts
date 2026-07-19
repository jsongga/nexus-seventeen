import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  createManagerReviewService,
  MANAGER_RUNTIME_EPOCH_HEADER,
  MANAGER_RUNTIME_INSTANCE_HEADER,
  type ManagerHandoffRegistrar,
  type ManagerRuntimeClaim,
  type RegisterManagerHandoffRequest,
  type RegisterManagerHandoffResult,
} from "../src/index.js";
import {
  EVIDENCE_TOKEN,
  FakeHandoffRegistrar,
  FakeManagerRuntimeAuthorizer,
  HUMAN_TOKEN,
  MANAGER_ONE,
  MANAGER_ONE_TOKEN,
  MANAGER_ONE_RUNTIME,
  MANAGER_TWO,
  MANAGER_TWO_TOKEN,
  WORKSPACE_ID,
  managerReview,
  passingEvidence,
  temporaryStore,
} from "./helpers.js";

async function request(
  url: string,
  method: "GET" | "POST",
  token: string,
  body?: unknown,
  idempotencyKey?: string,
  runtime?: ManagerRuntimeClaim,
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
      ...(runtime === undefined
        ? {}
        : {
            [MANAGER_RUNTIME_INSTANCE_HEADER]: runtime.runtimeInstanceId,
            [MANAGER_RUNTIME_EPOCH_HEADER]: String(runtime.runtimeEpoch),
          }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("HTTP authority is disjoint across evidence, fixed-manager review, and human queue", async () => {
  const registrar = new FakeHandoffRegistrar();
  const runtimeAuthorizer = new FakeManagerRuntimeAuthorizer();
  const service = await createManagerReviewService({
    workspaceId: WORKSPACE_ID,
    storePath: await temporaryStore(),
    evidenceIssuerToken: EVIDENCE_TOKEN,
    evidenceIssuerPrincipal: "service:control-plane-projection",
    humanToken: HUMAN_TOKEN,
    managers: [
      { ...MANAGER_ONE, token: MANAGER_ONE_TOKEN },
      { ...MANAGER_TWO, token: MANAGER_TWO_TOKEN },
    ],
    handoffRegistrar: registrar,
    managerRuntimeAuthorizer: runtimeAuthorizer,
    corsOrigins: ["https://app.cicada.build"],
    now: () => new Date("2026-07-19T19:04:00.000Z"),
  });
  const address = await service.start();
  try {
    const preflight = await fetch(
      `${address.url}/v1/production-checks?workspaceId=${WORKSPACE_ID}`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.cicada.build",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization",
        },
      },
    );
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      "https://app.cicada.build",
    );
    assert.equal(preflight.headers.get("access-control-allow-headers"), "Authorization");

    assert.equal((await request(
      `${address.url}/v1/passing-evidence`,
      "POST",
      MANAGER_ONE_TOKEN,
      passingEvidence(),
      "http-evidence-wrong-0001",
    )).status, 401);

    const evidenceResponse = await request(
      `${address.url}/v1/passing-evidence`,
      "POST",
      EVIDENCE_TOKEN,
      passingEvidence(),
      "http-evidence-0001",
    );
    assert.equal(evidenceResponse.status, 201);
    const evidence = (await evidenceResponse.json() as { evidence: { evidenceId: string; evidenceDigest: string } }).evidence;

    assert.equal((await request(
      `${address.url}/v1/manager-review-queue?workspaceId=${WORKSPACE_ID}`,
      "GET",
      HUMAN_TOKEN,
    )).status, 401);
    assert.equal((await request(
      `${address.url}/v1/manager-review-queue?workspaceId=${WORKSPACE_ID}`,
      "GET",
      MANAGER_ONE_TOKEN,
    )).status, 400);
    assert.equal((await request(
      `${address.url}/v1/manager-review-queue?workspaceId=${WORKSPACE_ID}`,
      "GET",
      MANAGER_ONE_TOKEN,
      undefined,
      undefined,
      { ...MANAGER_ONE_RUNTIME, runtimeEpoch: 0 },
    )).status, 400);
    const queue = await request(
      `${address.url}/v1/manager-review-queue?workspaceId=${WORKSPACE_ID}`,
      "GET",
      MANAGER_ONE_TOKEN,
      undefined,
      undefined,
      MANAGER_ONE_RUNTIME,
    );
    assert.equal(queue.status, 200);
    assert.equal((await queue.json() as { items: unknown[] }).items.length, 1);

    assert.equal((await request(
      `${address.url}/v1/passing-evidence/${evidence.evidenceId}/reviews`,
      "POST",
      EVIDENCE_TOKEN,
      managerReview(evidence.evidenceDigest),
      "http-review-wrong-0001",
    )).status, 401);
    const reviewed = await request(
      `${address.url}/v1/passing-evidence/${evidence.evidenceId}/reviews`,
      "POST",
      MANAGER_ONE_TOKEN,
      managerReview(evidence.evidenceDigest),
      "http-review-0001",
      MANAGER_ONE_RUNTIME,
    );
    assert.equal(reviewed.status, 201);
    const reviewedBody = await reviewed.json() as {
      review: { managerRuntimeInstanceId: string; managerRuntimeEpoch: number };
    };
    assert.equal(reviewedBody.review.managerRuntimeInstanceId, MANAGER_ONE_RUNTIME.runtimeInstanceId);
    assert.equal(reviewedBody.review.managerRuntimeEpoch, MANAGER_ONE_RUNTIME.runtimeEpoch);
    assert.equal(runtimeAuthorizer.calls.length, 2);

    assert.equal((await request(
      `${address.url}/v1/production-checks?workspaceId=${WORKSPACE_ID}`,
      "GET",
      MANAGER_ONE_TOKEN,
    )).status, 401);
    const checks = await request(
      `${address.url}/v1/production-checks?workspaceId=${WORKSPACE_ID}`,
      "GET",
      HUMAN_TOKEN,
    );
    assert.equal(checks.status, 200);
    const items = (await checks.json() as {
      items: Array<{
        status: string;
        releaseManifestDigest: string;
        managerRuntimeInstanceId: string;
        managerRuntimeEpoch: number;
      }>;
    }).items;
    assert.equal(items.length, 1);
    assert.equal(items[0]!.status, "pending_human_review");
    assert.equal(items[0]!.releaseManifestDigest, passingEvidence().releaseManifestDigest);
    assert.equal(items[0]!.managerRuntimeInstanceId, MANAGER_ONE_RUNTIME.runtimeInstanceId);
    assert.equal(items[0]!.managerRuntimeEpoch, MANAGER_ONE_RUNTIME.runtimeEpoch);

    const browserChecks = await fetch(
      `${address.url}/v1/production-checks?workspaceId=${WORKSPACE_ID}`,
      {
        headers: {
          Authorization: `Bearer ${HUMAN_TOKEN}`,
          Origin: "https://app.cicada.build",
        },
      },
    );
    assert.equal(browserChecks.status, 200);
    assert.equal(
      browserChecks.headers.get("access-control-allow-origin"),
      "https://app.cicada.build",
    );

    const disallowedOrigin = await fetch(
      `${address.url}/v1/production-checks?workspaceId=${WORKSPACE_ID}`,
      {
        headers: {
          Authorization: `Bearer ${HUMAN_TOKEN}`,
          Origin: "https://attacker.example.test",
        },
      },
    );
    assert.equal(disallowedOrigin.status, 403);
    assert.equal(disallowedOrigin.headers.get("access-control-allow-origin"), null);

    assert.equal((await request(
      `${address.url}/v1/engineer-feedback?workspaceId=${WORKSPACE_ID}`,
      "GET",
      HUMAN_TOKEN,
    )).status, 401);
    const feedback = await request(
      `${address.url}/v1/engineer-feedback?workspaceId=${WORKSPACE_ID}`,
      "GET",
      EVIDENCE_TOKEN,
    );
    assert.equal(feedback.status, 200);
    assert.equal((await feedback.json() as { items: unknown[] }).items.length, 0);

    for (const attemptedToken of [MANAGER_ONE_TOKEN, HUMAN_TOKEN]) {
      const forbiddenSurface = await request(
        `${address.url}/v1/deployment-grants`,
        "POST",
        attemptedToken,
        {},
        "attempt-grant-0001",
      );
      assert.equal(forbiddenSurface.status, 404);
    }

    runtimeAuthorizer.reject = true;
    const replay = await request(
      `${address.url}/v1/passing-evidence/${evidence.evidenceId}/reviews`,
      "POST",
      MANAGER_ONE_TOKEN,
      managerReview(evidence.evidenceDigest),
      "http-review-0001",
      {
        ...MANAGER_ONE_RUNTIME,
        runtimeInstanceId: "manager-runtime-one-replacement",
        runtimeEpoch: MANAGER_ONE_RUNTIME.runtimeEpoch + 1,
      },
    );
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { duplicate: boolean }).duplicate, true);
    assert.equal(runtimeAuthorizer.calls.length, 2);

    assert.equal((await request(
      `${address.url}/v1/manager-review-queue?workspaceId=${WORKSPACE_ID}`,
      "GET",
      MANAGER_ONE_TOKEN,
      undefined,
      undefined,
      MANAGER_ONE_RUNTIME,
    )).status, 409);
    assert.equal(runtimeAuthorizer.calls.length, 3);
  } finally {
    await service.close();
  }
});

test("graceful shutdown waits for an in-flight durable handoff retry", async () => {
  let callCount = 0;
  let retryStarted: (() => void) | undefined;
  let releaseRetry: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { retryStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseRetry = resolve; });
  const registrar: ManagerHandoffRegistrar = {
    async registerManagerHandoff(
      request: RegisterManagerHandoffRequest,
      _idempotencyKey: string,
    ): Promise<RegisterManagerHandoffResult> {
      callCount += 1;
      if (callCount === 1) throw new Error("initial handoff outage");
      retryStarted?.();
      await release;
      return {
        duplicate: true,
        handoff: {
          apiVersion: 3,
          handoffId: randomUUID(),
          status: "accepted",
          acceptedBy: "service:manager-handoff",
          acceptedAt: "2026-07-19T19:05:00.000Z",
          ...request,
        },
      };
    },
  };
  const service = await createManagerReviewService({
    workspaceId: WORKSPACE_ID,
    storePath: await temporaryStore(),
    evidenceIssuerToken: EVIDENCE_TOKEN,
    evidenceIssuerPrincipal: "service:control-plane-projection",
    humanToken: HUMAN_TOKEN,
    managers: [{ ...MANAGER_ONE, token: MANAGER_ONE_TOKEN }],
    handoffRegistrar: registrar,
    managerRuntimeAuthorizer: new FakeManagerRuntimeAuthorizer(),
    handoffRetryMs: 100,
    now: () => new Date("2026-07-19T19:04:00.000Z"),
  });
  const address = await service.start();
  const evidenceResponse = await request(
    `${address.url}/v1/passing-evidence`,
    "POST",
    EVIDENCE_TOKEN,
    passingEvidence(),
    "shutdown-evidence-0001",
  );
  const evidence = (await evidenceResponse.json() as {
    evidence: { evidenceId: string; evidenceDigest: string };
  }).evidence;
  const reviewResponse = await request(
    `${address.url}/v1/passing-evidence/${evidence.evidenceId}/reviews`,
    "POST",
    MANAGER_ONE_TOKEN,
    managerReview(evidence.evidenceDigest),
    "shutdown-review-0001",
    MANAGER_ONE_RUNTIME,
  );
  assert.equal(reviewResponse.status, 202);
  let retryTimeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      started,
      new Promise<never>((_resolve, reject) => {
        retryTimeout = setTimeout(() => reject(new Error("retry did not start")), 2_000);
      }),
    ]);
  } finally {
    if (retryTimeout) clearTimeout(retryTimeout);
  }

  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false);
  releaseRetry?.();
  await closing;
  assert.equal(callCount, 2);
});
