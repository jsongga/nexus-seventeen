import assert from "node:assert/strict";
import {
  STEWARD_RUNTIME_API_VERSION,
  STEWARD_RUNTIME_FEATURES_HEADER,
  STEWARD_RUNTIME_GENERATION_PROOF_HEADER,
  STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER,
  STEWARD_RUNTIME_TYPED_TASKS_FEATURE,
  parseRuntimeCommandPollRequest,
  parseSupervisorRegistrationResult,
} from "@cicada/steward-protocol";
import { test } from "node:test";
import {
  ControlPlaneUnavailableError,
  HttpSupervisorControlPlaneClient,
} from "../src/client.js";
import { registrationIdentity } from "./helpers.js";

test("HTTP client uses bearer auth, bounded retry, and protocol-valid responses", async () => {
  const request = registrationIdentity(3);
  const response = parseSupervisorRegistrationResult({
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: request.workspaceId,
    agentId: request.agentId,
    laneId: request.laneId,
    runtimeInstanceId: request.runtimeInstanceId,
    runtimeEpoch: 4,
    leaseId: "lease-3",
    leaseGrantedAt: "2026-07-18T20:00:00.000Z",
    leaseExpiresAt: "2026-07-18T20:01:00.000Z",
    lastAcceptedLocalSequence: 0,
    controlVersion: 1,
  });
  const calls: {
    url: string;
    authorization: string | null;
    challenge: string | null;
    features: string | null;
    body: unknown;
  }[] = [];
  const sleeps: number[] = [];
  const fetchImplementation = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get("authorization"),
      challenge: headers.get(STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER),
      features: headers.get(STEWARD_RUNTIME_FEATURES_HEADER),
      body: JSON.parse(String(init?.body)) as unknown,
    });
    if (calls.length === 1) return new Response(null, { status: 503 });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        "content-type": "application/json",
        [STEWARD_RUNTIME_GENERATION_PROOF_HEADER]: `rgp_${"p".repeat(43)}`,
      },
    });
  }) as typeof globalThis.fetch;
  const client = new HttpSupervisorControlPlaneClient({
    controlPlaneUrl: "https://control.example.test/base",
    supervisorToken: "secret-supervisor-token",
    fetchImplementation,
    maxAttempts: 2,
    baseBackoffMs: 20,
    maxBackoffMs: 20,
    random: () => 1,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });

  const session = await client.register(request);
  assert.equal(session.runtimeGenerationProof, `rgp_${"p".repeat(43)}`);
  const { runtimeGenerationProof: _proof, ...wireResult } = session;
  assert.deepEqual(wireResult, response);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://control.example.test/base/v1/runtime/register",
    "https://control.example.test/base/v1/runtime/register",
  ]);
  assert.deepEqual(calls.map((call) => call.authorization), [
    "Bearer secret-supervisor-token",
    "Bearer secret-supervisor-token",
  ]);
  assert.equal(calls[0]!.challenge, calls[1]!.challenge);
  assert.match(calls[0]!.challenge ?? "", /^rgc_[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(calls.map((call) => call.features), [
    STEWARD_RUNTIME_TYPED_TASKS_FEATURE,
    STEWARD_RUNTIME_TYPED_TASKS_FEATURE,
  ]);
  assert.deepEqual(calls.map((call) => call.body), [request, request]);
  assert.deepEqual(sleeps, [20]);
});

test("HTTP client rejects a successful response that violates the protocol", async () => {
  const client = new HttpSupervisorControlPlaneClient({
    controlPlaneUrl: "https://control.example.test",
    supervisorToken: "secret-supervisor-token",
    maxAttempts: 1,
    fetchImplementation: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof globalThis.fetch,
  });
  await assert.rejects(
    client.register(registrationIdentity()),
    (error: unknown) => error instanceof ControlPlaneUnavailableError && error.retryable === false,
  );
});

test("HTTP bearer transport is allowed only for exact loopback hosts", () => {
  assert.throws(
    () => new HttpSupervisorControlPlaneClient({
      controlPlaneUrl: "http://control.example.test",
      supervisorToken: "secret-supervisor-token",
    }),
    /only for exact loopback/i,
  );
  for (const controlPlaneUrl of [
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://[::1]:3001",
  ]) {
    assert.doesNotThrow(() => new HttpSupervisorControlPlaneClient({
      controlPlaneUrl,
      supervisorToken: "secret-supervisor-token",
    }));
  }
});

test("HTTP command polling honors caller cancellation without retrying", async () => {
  let attempts = 0;
  const fetchImplementation = (async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    attempts += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Expected an authenticated request signal");
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }) as typeof globalThis.fetch;
  const client = new HttpSupervisorControlPlaneClient({
    controlPlaneUrl: "https://control.example.test",
    supervisorToken: "secret-supervisor-token",
    fetchImplementation,
    maxAttempts: 3,
    timeoutMs: 60_000,
  });
  const controller = new AbortController();
  const identity = registrationIdentity();
  const runtimeEpoch = 1;
  const pending = client.pollCommands(parseRuntimeCommandPollRequest({
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: identity.workspaceId,
    agentId: identity.agentId,
    laneId: identity.laneId,
    runtimeInstanceId: identity.runtimeInstanceId,
    runtimeEpoch,
    afterServerSequence: 0,
  }), controller.signal);
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof ControlPlaneUnavailableError && error.retryable === false,
  );
  assert.equal(attempts, 1);
});
