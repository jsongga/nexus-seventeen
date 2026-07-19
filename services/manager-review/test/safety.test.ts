import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createManagerReviewService,
  HttpManagerHandoffRegistrar,
  ReviewServiceError,
} from "../src/index.js";
import {
  EVIDENCE_TOKEN,
  FakeHandoffRegistrar,
  HUMAN_TOKEN,
  MANAGER_ONE,
  MANAGER_ONE_TOKEN,
  WORKSPACE_ID,
  temporaryStore,
} from "./helpers.js";

function serviceOptions(storePath: string) {
  return {
    workspaceId: WORKSPACE_ID,
    storePath,
    evidenceIssuerToken: EVIDENCE_TOKEN,
    evidenceIssuerPrincipal: "service:control-plane-projection",
    humanToken: HUMAN_TOKEN,
    managers: [{ ...MANAGER_ONE, token: MANAGER_ONE_TOKEN }],
    handoffRegistrar: new FakeHandoffRegistrar(),
  } as const;
}

test("the bearer-authenticated review service rejects non-loopback bind hosts", async () => {
  await assert.rejects(
    createManagerReviewService({ ...serviceOptions(await temporaryStore()), host: "0.0.0.0" }),
    (error: unknown) => error instanceof ReviewServiceError && error.code === "INVALID_CONFIGURATION",
  );
});

test("an existing review-store directory must already be owner-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-manager-review-mode-"));
  const directory = join(root, "shared-state");
  await mkdir(directory, { mode: 0o755 });
  await chmod(directory, 0o755);
  await assert.rejects(
    createManagerReviewService(serviceOptions(join(directory, "events.jsonl"))),
    (error: unknown) => error instanceof ReviewServiceError && error.code === "INVALID_CONFIGURATION",
  );
});

test("the HTTP registrar accepts broker v3 only and preserves artifact plus manifest binding", async () => {
  const token = "broker-handoff-issuer-token-0123456789";
  let observed: {
    authorization: string | undefined;
    idempotency: string | undefined;
    body: unknown;
  } = { authorization: undefined, idempotency: undefined, body: undefined };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      observed = {
        authorization: request.headers.authorization,
        idempotency: request.headers["idempotency-key"] as string | undefined,
        body,
      };
      const encoded = JSON.stringify({
        duplicate: false,
        handoff: {
          apiVersion: 3,
          handoffId: "123e4567-e89b-42d3-a456-426614174000",
          status: "accepted",
          acceptedBy: "service:manager-handoff",
          acceptedAt: "2026-07-19T19:05:00.000Z",
          ...body,
        },
      });
      response.statusCode = 201;
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Content-Length", Buffer.byteLength(encoded));
      response.end(encoded);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const registrar = new HttpManagerHandoffRegistrar({
      brokerOrigin: `http://127.0.0.1:${address.port}`,
      handoffIssuerToken: token,
    });
    const request = {
      workspaceId: WORKSPACE_ID,
      taskId: "task-checkout-retry",
      releaseArtifactDigest: `sha256:${"a".repeat(64)}`,
      releaseManifestDigest: `sha256:${"b".repeat(64)}`,
      targetEnvironment: "production-us",
      managerAgentId: MANAGER_ONE.agentId,
      managerReviewId: "review-0001",
      reviewedAt: "2026-07-19T19:04:00.000Z",
    };
    const result = await registrar.registerManagerHandoff(request, "handoff-review-0001");
    assert.equal(result.handoff.apiVersion, 3);
    assert.equal(result.handoff.releaseArtifactDigest, request.releaseArtifactDigest);
    assert.equal(result.handoff.releaseManifestDigest, request.releaseManifestDigest);
    assert.equal(observed.authorization, `Bearer ${token}`);
    assert.equal(observed.idempotency, "handoff-review-0001");
    assert.deepEqual(observed.body, request);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  assert.throws(
    () => new HttpManagerHandoffRegistrar({
      brokerOrigin: "http://broker.example.com",
      handoffIssuerToken: token,
    }),
    (error: unknown) => error instanceof ReviewServiceError && error.code === "INVALID_CONFIGURATION",
  );
});

test("the HTTP registrar rejects downgraded, rebound, and oversized broker responses", async () => {
  const token = "broker-negative-response-token-0123456789";
  const request = {
    workspaceId: WORKSPACE_ID,
    taskId: "task-checkout-retry",
    releaseArtifactDigest: `sha256:${"a".repeat(64)}`,
    releaseManifestDigest: `sha256:${"b".repeat(64)}`,
    targetEnvironment: "production-us",
    managerAgentId: MANAGER_ONE.agentId,
    managerReviewId: "review-negative-0001",
    reviewedAt: "2026-07-19T19:04:00.000Z",
  };
  const result = (overrides: Record<string, unknown> = {}) => ({
    duplicate: false,
    handoff: {
      apiVersion: 3,
      handoffId: "123e4567-e89b-42d3-a456-426614174000",
      status: "accepted",
      acceptedBy: "service:manager-handoff",
      acceptedAt: "2026-07-19T19:05:00.000Z",
      ...request,
      ...overrides,
    },
  });
  const registrarFor = (response: () => Response) => new HttpManagerHandoffRegistrar({
    brokerOrigin: "https://broker.example.test",
    handoffIssuerToken: token,
    fetch: (async () => response()) as typeof globalThis.fetch,
  });

  await assert.rejects(
    registrarFor(() => Response.json(result({ apiVersion: 2 }), { status: 201 }))
      .registerManagerHandoff(request, "negative-version-0001"),
    (error: unknown) => error instanceof ReviewServiceError && error.code === "INVALID_BROKER_RESPONSE",
  );
  await assert.rejects(
    registrarFor(() => Response.json(result({
      releaseManifestDigest: `sha256:${"c".repeat(64)}`,
    }), { status: 201 })).registerManagerHandoff(request, "negative-binding-0001"),
    (error: unknown) => error instanceof ReviewServiceError && error.code === "INVALID_BROKER_RESPONSE",
  );
  await assert.rejects(
    registrarFor(() => new Response("x".repeat(65 * 1_024), {
      status: 201,
      headers: { "Content-Length": String(65 * 1_024) },
    })).registerManagerHandoff(request, "negative-oversize-0001"),
    (error: unknown) => error instanceof ReviewServiceError && error.code === "BROKER_RESPONSE_TOO_LARGE",
  );
});
