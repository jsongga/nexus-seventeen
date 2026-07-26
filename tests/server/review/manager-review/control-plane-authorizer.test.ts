import assert from "node:assert/strict";
import { test } from "node:test";
import { ROLE_CAPABILITIES, STEWARD_UI_API_VERSION } from "#shared/protocol";
import {
  HttpControlPlaneManagerAuthorizer,
  ReviewServiceError,
} from "#server/review/manager-review";
import { MANAGER_ONE_RUNTIME } from "./helpers.js";

const OBSERVER_TOKEN = "control-plane-observer-read-token-00000001";
const NOW = "2026-07-19T19:04:00.000Z";

function bootstrap() {
  return {
    apiVersion: STEWARD_UI_API_VERSION,
    sessionId: "session_impact_observer",
    userId: "impact_observer",
    permissions: ["workspace:read"],
    features: ["durable-replay", "runtime-fencing"],
    snapshot: {
      apiVersion: STEWARD_UI_API_VERSION,
      workspaceId: MANAGER_ONE_RUNTIME.workspaceId,
      generatedAt: NOW,
      sequence: 4,
      paused: false,
      controlVersion: 4,
      agents: [{
        workspaceId: MANAGER_ONE_RUNTIME.workspaceId,
        agentId: MANAGER_ONE_RUNTIME.agentId,
        laneId: MANAGER_ONE_RUNTIME.laneId,
        runtimeInstanceId: MANAGER_ONE_RUNTIME.runtimeInstanceId,
        runtimeEpoch: MANAGER_ONE_RUNTIME.runtimeEpoch,
        displayName: "Manager one",
        role: "manager",
        capabilities: [...ROLE_CAPABILITIES.manager],
        provider: { name: "codex", model: "codex-mini" },
        softwareVersion: "1.0.0",
        checkpointRef: null,
        registeredAt: "2026-07-19T18:50:00.000Z",
        lastSeenAt: "2026-07-19T19:03:59.000Z",
        leaseExpiresAt: "2026-07-19T19:05:00.000Z",
        currentAction: null,
        connectionState: "online",
        controlState: "active",
        controlVersion: 4,
        queue: [],
      }],
      tasks: [],
      progress: [],
    },
    eventStream: {
      href: "/v1/ui/events",
      afterSequence: 4,
      retentionStartsAtSequence: 1,
      heartbeatIntervalMs: 15_000,
    },
    commandEndpoint: "/v1/ui/commands/disabled",
  };
}

function fetchReturning(
  payload: unknown,
  inspect?: (input: string | URL | Request, init?: RequestInit) => void,
): typeof globalThis.fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    inspect?.(input, init);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function authorizer(payload: unknown): HttpControlPlaneManagerAuthorizer {
  return new HttpControlPlaneManagerAuthorizer({
    controlPlaneOrigin: "https://control.example.test",
    observerReadToken: OBSERVER_TOKEN,
    fetch: fetchReturning(payload),
    now: () => new Date(NOW),
  });
}

async function rejectsCode(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof ReviewServiceError && error.code === code,
  );
}

test("authorizer uses the read-only bootstrap capability and accepts only the exact live runtime", async () => {
  let inspected = false;
  const verifier = new HttpControlPlaneManagerAuthorizer({
    controlPlaneOrigin: "https://control.example.test",
    observerReadToken: OBSERVER_TOKEN,
    fetch: fetchReturning(bootstrap(), (input, init) => {
      inspected = true;
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      assert.equal(url.origin, "https://control.example.test");
      assert.equal(url.pathname, "/v1/ui/bootstrap");
      assert.equal(url.searchParams.get("workspaceId"), MANAGER_ONE_RUNTIME.workspaceId);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), `Bearer ${OBSERVER_TOKEN}`);
      assert.equal(headers.get("X-Steward-UI-Version"), STEWARD_UI_API_VERSION);
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
    }),
    now: () => new Date(NOW),
  });

  await verifier.authorizeManagerRuntime(MANAGER_ONE_RUNTIME);
  assert.equal(inspected, true);
});

test("authorizer fences replaced, stale, held, offline, and inconsistent manager snapshots", async () => {
  const wrongRuntime = bootstrap();
  wrongRuntime.snapshot.agents[0]!.runtimeEpoch += 1;
  await rejectsCode(
    authorizer(wrongRuntime).authorizeManagerRuntime(MANAGER_ONE_RUNTIME),
    "MANAGER_RUNTIME_FENCED",
  );

  const wrongInstance = bootstrap();
  wrongInstance.snapshot.agents[0]!.runtimeInstanceId = "manager-runtime-replacement";
  await rejectsCode(
    authorizer(wrongInstance).authorizeManagerRuntime(MANAGER_ONE_RUNTIME),
    "MANAGER_RUNTIME_FENCED",
  );

  const stale = bootstrap();
  stale.snapshot.generatedAt = "2026-07-19T19:03:56.000Z";
  await rejectsCode(
    authorizer(stale).authorizeManagerRuntime(MANAGER_ONE_RUNTIME),
    "MANAGER_AUTHORITY_SNAPSHOT_STALE",
  );

  const paused = bootstrap();
  paused.snapshot.paused = true;
  await rejectsCode(
    authorizer(paused).authorizeManagerRuntime(MANAGER_ONE_RUNTIME),
    "MANAGER_RUNTIME_HELD",
  );

  const held = bootstrap();
  held.snapshot.agents[0]!.controlState = "held";
  await rejectsCode(
    authorizer(held).authorizeManagerRuntime(MANAGER_ONE_RUNTIME),
    "MANAGER_RUNTIME_NOT_ACTIVE",
  );

  const offline = bootstrap();
  offline.snapshot.agents[0]!.connectionState = "offline";
  await rejectsCode(
    authorizer(offline).authorizeManagerRuntime(MANAGER_ONE_RUNTIME),
    "MANAGER_RUNTIME_OFFLINE",
  );

  const expired = bootstrap();
  expired.snapshot.agents[0]!.leaseExpiresAt = NOW;
  await rejectsCode(
    authorizer(expired).authorizeManagerRuntime(MANAGER_ONE_RUNTIME),
    "MANAGER_RUNTIME_OFFLINE",
  );

  const mismatchedControlVersion = bootstrap();
  mismatchedControlVersion.snapshot.agents[0]!.controlVersion = 3;
  await rejectsCode(
    authorizer(mismatchedControlVersion).authorizeManagerRuntime(MANAGER_ONE_RUNTIME),
    "INVALID_CONTROL_PLANE_RESPONSE",
  );
});

test("authorizer rejects any bootstrap that is not the exact observer-only projection", async () => {
  const humanBootstrap = bootstrap();
  humanBootstrap.sessionId = "session_alpha";
  humanBootstrap.userId = "human_alpha";
  humanBootstrap.permissions.push("workspace:control");
  humanBootstrap.features.push("human-control");
  humanBootstrap.commandEndpoint = "/v1/ui/commands";
  await rejectsCode(
    authorizer(humanBootstrap).authorizeManagerRuntime(MANAGER_ONE_RUNTIME),
    "CONTROL_PLANE_AUTHORITY_NOT_READ_ONLY",
  );

  const splitIdentity = bootstrap();
  splitIdentity.snapshot.agents[0]!.laneId = "manager-lane-alias";
  splitIdentity.snapshot.agents.push({
    ...splitIdentity.snapshot.agents[0]!,
    agentId: "manager-other",
    laneId: MANAGER_ONE_RUNTIME.laneId,
    runtimeInstanceId: "manager-runtime-other",
  });
  await rejectsCode(
    authorizer(splitIdentity).authorizeManagerRuntime(MANAGER_ONE_RUNTIME),
    "MANAGER_RUNTIME_FENCED",
  );
});

test("protocol rejection is generic and does not reflect downstream validator detail", async () => {
  const invalid = bootstrap() as ReturnType<typeof bootstrap> & { injectedSecret?: string };
  invalid.injectedSecret = "do-not-reflect-this-value";
  await assert.rejects(
    authorizer(invalid).authorizeManagerRuntime(MANAGER_ONE_RUNTIME),
    (error: unknown) => {
      assert.ok(error instanceof ReviewServiceError);
      assert.equal(error.code, "INVALID_CONTROL_PLANE_RESPONSE");
      assert.equal(error.message, "Control-plane bootstrap violated the Steward UI protocol");
      assert.equal(error.message.includes("do-not-reflect-this-value"), false);
      assert.ok(error.cause instanceof Error);
      return true;
    },
  );
});

test("control-plane origin requires HTTPS except for a literal loopback address", () => {
  assert.throws(
    () => new HttpControlPlaneManagerAuthorizer({
      controlPlaneOrigin: "http://localhost:4100",
      observerReadToken: OBSERVER_TOKEN,
      fetch: fetchReturning(bootstrap()),
    }),
    (error: unknown) => error instanceof ReviewServiceError && error.code === "INVALID_CONFIGURATION",
  );
  assert.doesNotThrow(() => new HttpControlPlaneManagerAuthorizer({
    controlPlaneOrigin: "http://127.0.0.1:4100",
    observerReadToken: OBSERVER_TOKEN,
    fetch: fetchReturning(bootstrap()),
  }));
});
