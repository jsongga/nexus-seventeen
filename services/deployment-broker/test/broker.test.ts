import assert from "node:assert/strict";
import test from "node:test";
import { DeploymentGrantBroker } from "../src/broker.js";
import { normalizeConfig } from "../src/config.js";
import { BrokerError } from "../src/errors.js";
import { consumeRequest, createRequest, handoffRequest, options, tempRoot } from "./helpers.js";

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof BrokerError && error.code === code;
}

async function acceptedHandoff(broker: DeploymentGrantBroker, suffix = "0001"): Promise<string> {
  const result = await broker.registerManagerHandoff(
    handoffRequest({ managerReviewId: `manager-review-${suffix}` }),
    `handoff-request-${suffix}`,
  );
  return result.handoff.handoffId;
}

test("human grants are immutable, exact, server-timestamped, and idempotent", async () => {
  const root = await tempRoot();
  const broker = await DeploymentGrantBroker.open(normalizeConfig(options(root)));
  try {
    const handoffId = await acceptedHandoff(broker);
    const request = createRequest({ handoffId });
    const first = await broker.createGrant(request, "create-request-0001");
    assert.equal(first.duplicate, false);
    assert.equal(first.grant.issuedAt, "2026-07-18T20:00:00.000Z");
    assert.equal(first.grant.expiresAt, "2026-07-18T20:01:00.000Z");
    assert.equal(first.grant.issuedBy, "reviewer:alice");
    assert.equal(first.grant.handoffId, handoffId);
    assert.deepEqual(await broker.createGrant(request, "create-request-0001"), {
      grant: first.grant,
      duplicate: true,
    });
    await assert.rejects(
      broker.createGrant(createRequest({ handoffId, taskId: "different-task" }), "create-request-0001"),
      hasCode("IDEMPOTENCY_CONFLICT"),
    );
    await assert.rejects(
      broker.consumeGrant(first.grant.grantId, consumeRequest({ taskId: "different-task" }), "claim-request-0001"),
      hasCode("GRANT_BINDING_MISMATCH"),
    );
    await assert.rejects(
      broker.consumeGrant(
        first.grant.grantId,
        consumeRequest({ releaseManifestDigest: `sha256:${"f".repeat(64)}` }),
        "claim-manifest-mismatch-0001",
      ),
      hasCode("GRANT_BINDING_MISMATCH"),
    );
  } finally {
    await broker.close();
  }
});

test("a grant can be atomically consumed only once under concurrent claims", async () => {
  const root = await tempRoot();
  const broker = await DeploymentGrantBroker.open(normalizeConfig(options(root)));
  try {
    const handoffId = await acceptedHandoff(broker);
    const { grant } = await broker.createGrant(createRequest({ handoffId }), "create-concurrent-0001");
    const claims = await Promise.allSettled([
      broker.consumeGrant(grant.grantId, consumeRequest(), "claim-concurrent-a"),
      broker.consumeGrant(grant.grantId, consumeRequest(), "claim-concurrent-b"),
    ]);
    const fulfilled = claims.filter((claim): claim is PromiseFulfilledResult<Awaited<ReturnType<typeof broker.consumeGrant>>> => claim.status === "fulfilled");
    const rejected = claims.filter((claim): claim is PromiseRejectedResult => claim.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(hasCode("GRANT_ALREADY_CONSUMED")(rejected[0]!.reason));
    const winningKey = claims[0]!.status === "fulfilled" ? "claim-concurrent-a" : "claim-concurrent-b";
    const replay = await broker.consumeGrant(grant.grantId, consumeRequest(), winningKey);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.authorization.authorizationId, fulfilled[0]!.value.authorization.authorizationId);
  } finally {
    await broker.close();
  }
});

test("expired grants fail closed at the exact expiry boundary", async () => {
  const root = await tempRoot();
  let now = new Date("2026-07-18T20:00:00.000Z");
  const broker = await DeploymentGrantBroker.open(normalizeConfig(options(root, () => new Date(now))));
  try {
    const handoffId = await acceptedHandoff(broker);
    const { grant } = await broker.createGrant(
      createRequest({ handoffId, expiresInSeconds: 15 }),
      "create-expiry-0001",
    );
    now = new Date(grant.expiresAt);
    await assert.rejects(
      broker.consumeGrant(grant.grantId, consumeRequest(), "claim-expiry-0001"),
      hasCode("GRANT_EXPIRED"),
    );
  } finally {
    await broker.close();
  }
});

test("grant and one-shot authorization survive restart without becoming reusable", async () => {
  const root = await tempRoot();
  const config = normalizeConfig(options(root));
  const first = await DeploymentGrantBroker.open(config);
  const handoff = await first.registerManagerHandoff(handoffRequest(), "handoff-restart-0001");
  const grantRequest = createRequest({ handoffId: handoff.handoff.handoffId });
  const created = await first.createGrant(grantRequest, "create-restart-0001");
  const consumed = await first.consumeGrant(created.grant.grantId, consumeRequest(), "claim-restart-0001");
  await first.close();

  const restarted = await DeploymentGrantBroker.open(config);
  try {
    const handoffReplay = await restarted.registerManagerHandoff(handoffRequest(), "handoff-restart-0001");
    const createReplay = await restarted.createGrant(grantRequest, "create-restart-0001");
    const consumeReplay = await restarted.consumeGrant(created.grant.grantId, consumeRequest(), "claim-restart-0001");
    assert.equal(createReplay.grant.grantId, created.grant.grantId);
    assert.equal(handoffReplay.handoff.handoffId, handoff.handoff.handoffId);
    assert.equal(consumeReplay.authorization.authorizationId, consumed.authorization.authorizationId);
    assert.equal(consumeReplay.duplicate, true);
    await assert.rejects(
      restarted.consumeGrant(created.grant.grantId, consumeRequest(), "claim-restart-new-key"),
      hasCode("GRANT_ALREADY_CONSUMED"),
    );
  } finally {
    await restarted.close();
  }
});

test("runtime API rejects forged shapes even when called without HTTP", async () => {
  const root = await tempRoot();
  const broker = await DeploymentGrantBroker.open(normalizeConfig(options(root)));
  try {
    await assert.rejects(
      broker.createGrant({ ...createRequest(), role: "human" } as never, "create-forged-0001"),
      hasCode("INVALID_REQUEST"),
    );
    await assert.rejects(
      broker.createGrant(createRequest(), "short"),
      hasCode("INVALID_IDEMPOTENCY_KEY"),
    );
  } finally {
    await broker.close();
  }
});
