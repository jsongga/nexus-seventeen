import assert from "node:assert/strict";
import test from "node:test";
import {
  ROLE_CAPABILITIES,
  STEWARD_RUNTIME_API_VERSION,
  parseRuntimeCommandPollRequest,
  parseSupervisorRegistrationRequest,
} from "@cicada/steward-protocol";
import {
  HttpManagerReviewClient,
  HttpManagerRuntimeControlClient,
  RUNTIME_FEATURES_HEADER,
  RUNTIME_GENERATION_PROOF_HEADER,
  RUNTIME_PROOF_CHALLENGE_HEADER,
  RUNTIME_TYPED_TASKS_FEATURE,
} from "../src/http-clients.js";
import type { ManagerRuntimeClaim, ManagerReviewRequest } from "../src/types.js";
import {
  EVIDENCE_DIGEST,
  EVIDENCE_ID,
  GENERATION_PROOF,
  INSTANCE,
  LANE,
  MANAGER,
  NOW,
  REVIEW_TASK,
  WORKSPACE,
} from "./helpers.js";

const TOKEN = "manager-runtime-test-token-that-is-long-enough";
const CHALLENGE = `rgc_${"C".repeat(43)}`;
const REPLACEMENT_PROOF = `rgp_${"R".repeat(43)}`;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const bytes = JSON.stringify(body);
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("content-length")) headers.set("content-length", String(Buffer.byteLength(bytes)));
  return new Response(bytes, { ...init, headers });
}

function registrationRequest() {
  return parseSupervisorRegistrationRequest({
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: WORKSPACE,
    agentId: MANAGER,
    laneId: LANE,
    runtimeInstanceId: INSTANCE,
    expectedRuntimeEpoch: null,
    displayName: "Release manager",
    role: "manager",
    capabilities: ROLE_CAPABILITIES.manager,
    provider: { name: "codex", model: "gpt-5.4-mini" },
    softwareVersion: "0.1.0",
    checkpointRef: null,
  });
}

function registrationResult() {
  return {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: WORKSPACE,
    agentId: MANAGER,
    laneId: LANE,
    runtimeInstanceId: INSTANCE,
    runtimeEpoch: 1,
    leaseId: "manager-lease-one",
    leaseGrantedAt: NOW,
    leaseExpiresAt: "2026-07-19T20:01:00.000Z",
    lastAcceptedLocalSequence: 0,
    controlVersion: 1,
  };
}

const claim: ManagerRuntimeClaim = {
  workspaceId: WORKSPACE,
  agentId: MANAGER,
  laneId: LANE,
  runtimeInstanceId: "manager-process-new",
  runtimeEpoch: 2,
  runtimeGenerationProof: GENERATION_PROOF,
};

const reviewRequest: ManagerReviewRequest = {
  reviewTaskId: REVIEW_TASK,
  evidenceDigest: EVIDENCE_DIGEST as ManagerReviewRequest["evidenceDigest"],
  decision: "accepted",
  summary: "The exact evidence binding passed manager review.",
  remainingRisks: "A human still controls production deployment.",
};

test("sends durable generation handshakes and secure fetch settings", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (String(input).includes("/v1/runtime/register")) {
      return jsonResponse(registrationResult(), {
        headers: { [RUNTIME_GENERATION_PROOF_HEADER]: GENERATION_PROOF },
      });
    }
    return jsonResponse({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: WORKSPACE,
      agentId: MANAGER,
      laneId: LANE,
      runtimeInstanceId: INSTANCE,
      runtimeEpoch: 1,
      latestServerSequence: 0,
      commands: [],
    });
  };
  const client = new HttpManagerRuntimeControlClient({
    baseUrl: "http://127.0.0.1:9000",
    token: TOKEN,
    fetchImplementation,
  });

  const registration = await client.register(
    registrationRequest(),
    { runtimeProofChallenge: CHALLENGE, replacementProof: REPLACEMENT_PROOF },
  );
  assert.equal(registration.runtimeGenerationProof, GENERATION_PROOF);
  const registerHeaders = new Headers(calls[0]?.init.headers);
  assert.equal(registerHeaders.get(RUNTIME_PROOF_CHALLENGE_HEADER), CHALLENGE);
  assert.equal(registerHeaders.get(RUNTIME_GENERATION_PROOF_HEADER), REPLACEMENT_PROOF);
  assert.equal(registerHeaders.get(RUNTIME_FEATURES_HEADER), RUNTIME_TYPED_TASKS_FEATURE);
  assert.equal(calls[0]?.init.redirect, "error");
  assert.equal(calls[0]?.init.credentials, "omit");
  assert.equal(calls[0]?.init.referrerPolicy, "no-referrer");

  await client.pollCommands(parseRuntimeCommandPollRequest({
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: WORKSPACE,
    agentId: MANAGER,
    laneId: LANE,
    runtimeInstanceId: INSTANCE,
    runtimeEpoch: 1,
    afterServerSequence: 0,
  }));
  assert.equal(new Headers(calls[1]?.init.headers).get(RUNTIME_FEATURES_HEADER), RUNTIME_TYPED_TASKS_FEATURE);
});

test("rejects unsafe service origins", () => {
  const options = { token: TOKEN };
  assert.throws(() => new HttpManagerRuntimeControlClient({ ...options, baseUrl: "http://localhost:9000" }), /loopback/u);
  assert.throws(() => new HttpManagerRuntimeControlClient({ ...options, baseUrl: "https://example.com/api" }), /without path/u);
  assert.throws(() => new HttpManagerRuntimeControlClient({ ...options, baseUrl: "https://user@example.com" }), /without path/u);
  assert.throws(() => new HttpManagerRuntimeControlClient({ ...options, baseUrl: "https://example.com?token=x" }), /without path/u);
  assert.doesNotThrow(() => new HttpManagerRuntimeControlClient({ ...options, baseUrl: "http://[::1]:9000" }));
});

test("requires bounded JSON responses with syntactically valid Content-Length", async () => {
  const wrongType: typeof fetch = async () => new Response("{}", {
    headers: { "content-type": "text/plain", "content-length": "2" },
  });
  const wrongLength: typeof fetch = async () => new Response("{}", {
    headers: { "content-type": "application/json", "content-length": "1e3" },
  });
  const first = new HttpManagerReviewClient({
    baseUrl: "https://review.example",
    token: TOKEN,
    fetchImplementation: wrongType,
  });
  const second = new HttpManagerReviewClient({
    baseUrl: "https://review.example",
    token: TOKEN,
    fetchImplementation: wrongLength,
  });
  await assert.rejects(first.listQueue(claim), /not JSON/u);
  await assert.rejects(second.listQueue(claim), /Content-Length is invalid/u);
});

test("accepts an idempotent duplicate's original runtime audit but fences a new receipt", async () => {
  let duplicate = true;
  let managerAgentId = MANAGER;
  const calls: RequestInit[] = [];
  const fetchImplementation: typeof fetch = async (_input, init) => {
    calls.push(init ?? {});
    return jsonResponse({
      duplicate,
      review: {
        managerReviewId: "22222222-2222-4222-8222-222222222222",
        reviewTaskId: REVIEW_TASK,
        evidenceId: EVIDENCE_ID,
        evidenceDigest: EVIDENCE_DIGEST,
        decision: "accepted",
        managerAgentId,
        managerLaneId: LANE,
        managerRuntimeInstanceId: "manager-process-original",
        managerRuntimeEpoch: 1,
      },
    });
  };
  const client = new HttpManagerReviewClient({
    baseUrl: "https://review.example",
    token: TOKEN,
    fetchImplementation,
  });

  const receipt = await client.recordReview(claim, EVIDENCE_ID, reviewRequest, `manager-review:${"a".repeat(64)}`);
  assert.equal(receipt.duplicate, true);
  assert.equal(receipt.managerRuntimeInstanceId, "manager-process-original");
  assert.equal(receipt.managerRuntimeEpoch, 1);
  assert.equal(new Headers(calls[0]?.headers).get(RUNTIME_GENERATION_PROOF_HEADER), GENERATION_PROOF);

  duplicate = false;
  await assert.rejects(
    client.recordReview(claim, EVIDENCE_ID, reviewRequest, `manager-review:${"b".repeat(64)}`),
    /does not match/u,
  );
  duplicate = true;
  managerAgentId = "another-manager";
  await assert.rejects(
    client.recordReview(claim, EVIDENCE_ID, reviewRequest, `manager-review:${"c".repeat(64)}`),
    /does not match/u,
  );
});
