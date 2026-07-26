import assert from "node:assert/strict";
import test from "node:test";
import { DeploymentGrantBroker } from "#server/review/deployment-broker/broker";
import { normalizeConfig } from "#server/review/deployment-broker/config";
import { BrokerError } from "#server/review/deployment-broker/errors";
import { createRequest, handoffRequest, options, tempRoot } from "./helpers.js";

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof BrokerError && error.code === code;
}

test("a human cannot mint any grant without a registered accepted manager handoff", async () => {
  const root = await tempRoot();
  const broker = await DeploymentGrantBroker.open(normalizeConfig(options(root)));
  try {
    await assert.rejects(
      broker.createGrant(createRequest(), "arbitrary-human-grant-0001"),
      hasCode("HANDOFF_NOT_FOUND"),
    );
    const missing = { ...createRequest() } as Record<string, unknown>;
    delete missing.handoffId;
    await assert.rejects(
      broker.createGrant(missing as never, "missing-handoff-grant-0001"),
      hasCode("INVALID_REQUEST"),
    );
    await assert.rejects(
      broker.registerManagerHandoff(
        { ...handoffRequest(), status: "rejected" } as never,
        "rejected-handoff-0001",
      ),
      hasCode("INVALID_REQUEST"),
    );
    await assert.rejects(
      broker.registerManagerHandoff(
        handoffRequest({ reviewedAt: "2026-07-18T20:00:01.000Z" }),
        "future-review-handoff-0001",
      ),
      hasCode("INVALID_REQUEST"),
    );
  } finally {
    await broker.close();
  }
});

test("human grant binding must exactly match the reviewed task, artifact, frozen manifest, and environment", async () => {
  const root = await tempRoot();
  const broker = await DeploymentGrantBroker.open(normalizeConfig(options(root)));
  try {
    const registered = await broker.registerManagerHandoff(handoffRequest(), "exact-handoff-0001");
    const handoffId = registered.handoff.handoffId;
    for (const mismatch of [
      { taskId: "unreviewed-task" },
      { releaseArtifactDigest: `sha256:${"b".repeat(64)}` },
      { releaseManifestDigest: `sha256:${"e".repeat(64)}` },
      { targetEnvironment: "production-eu" },
    ]) {
      await assert.rejects(
        broker.createGrant(createRequest({ handoffId, ...mismatch }), `mismatch-${Object.keys(mismatch)[0]}-0001`),
        hasCode("HANDOFF_BINDING_MISMATCH"),
      );
    }
    await assert.rejects(
      broker.registerManagerHandoff(
        handoffRequest({ managerAgentId: "forged-manager", releaseArtifactDigest: `sha256:${"c".repeat(64)}` }),
        "reused-manager-review-0002",
      ),
      hasCode("MANAGER_REVIEW_ALREADY_REGISTERED"),
    );
  } finally {
    await broker.close();
  }
});

test("manager reviews and accepted handoffs cannot authorize multiple grants under races", async () => {
  const root = await tempRoot();
  const broker = await DeploymentGrantBroker.open(normalizeConfig(options(root)));
  try {
    const registrations = await Promise.allSettled([
      broker.registerManagerHandoff(handoffRequest(), "race-handoff-a-0001"),
      broker.registerManagerHandoff(handoffRequest(), "race-handoff-b-0001"),
    ]);
    const accepted = registrations.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof broker.registerManagerHandoff>>> =>
        result.status === "fulfilled",
    );
    assert.ok(accepted);
    assert.equal(registrations.filter((result) => result.status === "fulfilled").length, 1);
    const rejectedRegistration = registrations.find((result) => result.status === "rejected");
    assert.ok(rejectedRegistration?.status === "rejected");
    assert.ok(hasCode("MANAGER_REVIEW_ALREADY_REGISTERED")(rejectedRegistration.reason));

    const request = createRequest({ handoffId: accepted.value.handoff.handoffId });
    const grants = await Promise.allSettled([
      broker.createGrant(request, "race-grant-a-0001"),
      broker.createGrant(request, "race-grant-b-0001"),
    ]);
    assert.equal(grants.filter((result) => result.status === "fulfilled").length, 1);
    const rejectedGrant = grants.find((result) => result.status === "rejected");
    assert.ok(rejectedGrant?.status === "rejected");
    assert.ok(hasCode("HANDOFF_ALREADY_USED")(rejectedGrant.reason));
  } finally {
    await broker.close();
  }
});

test("handoff registration itself is exactly idempotent", async () => {
  const root = await tempRoot();
  const broker = await DeploymentGrantBroker.open(normalizeConfig(options(root)));
  try {
    const first = await broker.registerManagerHandoff(handoffRequest(), "handoff-idempotent-0001");
    const replay = await broker.registerManagerHandoff(handoffRequest(), "handoff-idempotent-0001");
    assert.equal(replay.duplicate, true);
    assert.equal(replay.handoff.handoffId, first.handoff.handoffId);
    await assert.rejects(
      broker.registerManagerHandoff(
        handoffRequest({ managerReviewId: "manager-review-other" }),
        "handoff-idempotent-0001",
      ),
      hasCode("IDEMPOTENCY_CONFLICT"),
    );
  } finally {
    await broker.close();
  }
});

test("cloned coordinators converge on one permit-derived manager-review handoff", async () => {
  const root = await tempRoot();
  const broker = await DeploymentGrantBroker.open(normalizeConfig(options(root)));
  try {
    const permitId = "11111111-2222-4333-8444-555555555555";
    const request = handoffRequest({
      managerReviewId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    const permitKey = `handoff:permit:${permitId}`;
    const coordinatorA = await broker.registerManagerHandoff(request, permitKey);
    const coordinatorB = await broker.registerManagerHandoff(request, permitKey);
    assert.equal(coordinatorA.duplicate, false);
    assert.equal(coordinatorB.duplicate, true);
    assert.equal(coordinatorB.handoff.handoffId, coordinatorA.handoff.handoffId);

    await assert.rejects(
      broker.registerManagerHandoff(request, "second-coordinator-key-0001"),
      hasCode("MANAGER_REVIEW_ALREADY_REGISTERED"),
    );
  } finally {
    await broker.close();
  }
});
