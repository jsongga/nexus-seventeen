import assert from "node:assert/strict";
import test from "node:test";
import { createDeploymentBroker } from "#server/review/deployment-broker/service";
import {
  AGENT_TOKEN,
  consumeRequest,
  createRequest,
  EXECUTOR_TOKEN,
  HANDOFF_ISSUER_TOKEN,
  handoffRequest,
  HUMAN_TOKEN,
  options,
  tempRoot,
} from "./helpers.js";

async function post(
  url: string,
  token: string,
  idempotencyKey: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

test("only the human may mint and only the external executor may consume", async () => {
  const root = await tempRoot();
  const service = await createDeploymentBroker(options(root));
  const address = await service.start();
  try {
    const endpoint = `${address.url}/v1/deployment-grants`;
    const handoffEndpoint = `${address.url}/v1/manager-handoffs`;
    const forgedHandoff = await post(handoffEndpoint, AGENT_TOKEN, "forged-handoff-0001", handoffRequest(), {
      "X-Steward-Role": "manager",
    });
    assert.equal(forgedHandoff.status, 401);
    assert.equal((await post(handoffEndpoint, HUMAN_TOKEN, "human-handoff-0001", handoffRequest())).status, 401);

    const forgedHuman = await post(endpoint, AGENT_TOKEN, "forged-human-0001", createRequest(), {
      "X-Steward-Role": "human",
    });
    assert.equal(forgedHuman.status, 401);

    const executorMint = await post(endpoint, EXECUTOR_TOKEN, "executor-mint-0001", createRequest());
    assert.equal(executorMint.status, 401);
    const issuerMint = await post(endpoint, HANDOFF_ISSUER_TOKEN, "issuer-mint-0001", createRequest());
    assert.equal(issuerMint.status, 401);

    const arbitraryHuman = await post(endpoint, HUMAN_TOKEN, "arbitrary-human-0001", createRequest());
    assert.equal(arbitraryHuman.status, 404);

    const registered = await post(
      handoffEndpoint,
      HANDOFF_ISSUER_TOKEN,
      "http-handoff-0001",
      handoffRequest(),
    );
    assert.equal(registered.status, 201);
    const registeredBody = await registered.json() as {
      handoff: { handoffId: string; status: string; acceptedBy: string };
    };
    assert.equal(registeredBody.handoff.status, "accepted");
    assert.equal(registeredBody.handoff.acceptedBy, "service:manager-handoff");

    const minted = await post(
      endpoint,
      HUMAN_TOKEN,
      "http-create-0001",
      createRequest({ handoffId: registeredBody.handoff.handoffId }),
    );
    assert.equal(minted.status, 201);
    const mintedBody = await minted.json() as { grant: { grantId: string; issuedBy: string; issuedAt: string } };
    assert.equal(mintedBody.grant.issuedBy, "reviewer:alice");
    assert.equal(mintedBody.grant.issuedAt, "2026-07-18T20:00:00.000Z");

    const consumeEndpoint = `${endpoint}/${mintedBody.grant.grantId}/consume`;
    const humanConsume = await post(consumeEndpoint, HUMAN_TOKEN, "human-consume-0001", consumeRequest());
    assert.equal(humanConsume.status, 401);
    const agentConsume = await post(consumeEndpoint, AGENT_TOKEN, "agent-consume-0001", consumeRequest(), {
      "X-Steward-Role": "executor",
    });
    assert.equal(agentConsume.status, 401);

    const consumed = await post(consumeEndpoint, EXECUTOR_TOKEN, "http-consume-0001", consumeRequest());
    assert.equal(consumed.status, 200);
    const consumedBody = await consumed.json() as { authorization: Record<string, unknown>; duplicate: boolean };
    assert.equal(consumedBody.duplicate, false);
    assert.equal(consumedBody.authorization.claimedBy, "deployer:release-service");
    assert.equal("credential" in consumedBody.authorization, false);
    const replay = await post(consumeEndpoint, EXECUTOR_TOKEN, "http-consume-0001", consumeRequest());
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { duplicate: boolean }).duplicate, true);
  } finally {
    await service.close();
  }
});

test("strict schemas, body bounds, and errors do not reflect secret input", async () => {
  const root = await tempRoot();
  const service = await createDeploymentBroker({ ...options(root), maxBodyBytes: 512 });
  const address = await service.start();
  try {
    const endpoint = `${address.url}/v1/deployment-grants`;
    const secret = "do-not-reflect-this-private-value";
    const extraField = await post(endpoint, HUMAN_TOKEN, "strict-shape-0001", {
      ...createRequest(),
      role: "human",
      secret,
    });
    assert.equal(extraField.status, 400);
    assert.doesNotMatch(await extraField.text(), new RegExp(secret, "u"));

    const oversized = await post(endpoint, HUMAN_TOKEN, "oversized-body-0001", {
      ...createRequest(),
      padding: secret.repeat(40),
    });
    assert.equal(oversized.status, 413);
    assert.doesNotMatch(await oversized.text(), new RegExp(secret, "u"));

    const wrongTarget = await post(endpoint, HUMAN_TOKEN, "wrong-target-0001", {
      ...createRequest(),
      targetEnvironment: "attacker-environment",
    });
    assert.equal(wrongTarget.status, 403);
    assert.doesNotMatch(await wrongTarget.text(), /attacker-environment/u);

    const get = await fetch(endpoint, { headers: { Authorization: `Bearer ${HUMAN_TOKEN}` } });
    assert.equal(get.status, 405);
  } finally {
    await service.close();
  }
});
