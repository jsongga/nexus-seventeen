import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseManagerReviewPermitConsumeRequest,
  STEWARD_RUNTIME_API_VERSION,
  type ManagerReviewPermitConsumeRequest,
} from "#shared/protocol";
import {
  HttpControlPlaneManagerReviewPermitConsumer,
  ReviewServiceError,
  withRuntimeGenerationProof,
} from "#server/review/manager-review";

const PERMIT_TOKEN = "control-plane-manager-review-permit-token-00000001";
const RUNTIME_GENERATION_PROOF = `rgp_${"z".repeat(43)}`;

function consumeRequest(
  override: Partial<ManagerReviewPermitConsumeRequest> = {},
): ManagerReviewPermitConsumeRequest {
  return parseManagerReviewPermitConsumeRequest({
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    operationId: `manager-review:${"a".repeat(64)}`,
    workspaceId: "workspace-alpha",
    reviewTaskId: "manager-review-task-0001",
    sourceTaskId: "source-task-0001",
    evidenceId: "evidence-0001",
    evidenceDigest: `sha256:${"b".repeat(64)}`,
    managerAgentId: "manager-one",
    managerLaneId: "manager-lane-one",
    runtimeInstanceId: "manager-runtime-one",
    runtimeEpoch: 7,
    reviewRequestDigest: `sha256:${"c".repeat(64)}`,
    ...override,
  });
}

function receipt(
  request: ManagerReviewPermitConsumeRequest,
  override: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    state: "accepted",
    permitId: "permit-0001",
    operationId: request.operationId,
    workspaceId: request.workspaceId,
    reviewTaskId: request.reviewTaskId,
    sourceTaskId: request.sourceTaskId,
    evidenceId: request.evidenceId,
    evidenceDigest: request.evidenceDigest,
    managerAgentId: request.managerAgentId,
    managerLaneId: request.managerLaneId,
    managerRuntimeInstanceId: request.runtimeInstanceId,
    managerRuntimeEpoch: request.runtimeEpoch,
    reviewRequestDigest: request.reviewRequestDigest,
    authorizedAt: "2026-07-19T19:04:30.000Z",
    workspaceSequence: 41,
    ...override,
  };
}

async function rejectsCode(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof ReviewServiceError && error.code === code,
  );
}

test("permit consumer posts only the dedicated capability and accepts an exactly bound receipt", async () => {
  const request = consumeRequest();
  let inspected = false;
  const consumer = new HttpControlPlaneManagerReviewPermitConsumer({
    controlPlaneOrigin: "https://control.example.test",
    permitConsumeToken: PERMIT_TOKEN,
    fetch: async (input, init) => {
      inspected = true;
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      const headers = new Headers(init?.headers);
      assert.equal(url.origin, "https://control.example.test");
      assert.equal(url.pathname, "/v1/internal/manager-review-permits/consume");
      assert.equal(url.search, "");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      assert.equal(headers.get("Authorization"), `Bearer ${PERMIT_TOKEN}`);
      assert.equal(headers.get("Content-Type"), "application/json");
      assert.equal(
        headers.get("x-steward-runtime-generation-proof"),
        RUNTIME_GENERATION_PROOF,
      );
      assert.deepEqual(JSON.parse(String(init?.body)), request);
      return Response.json(receipt(request), { status: 201 });
    },
  });

  const result = await withRuntimeGenerationProof(
    RUNTIME_GENERATION_PROOF,
    () => consumer.consumeManagerReviewPermit(request),
  );
  assert.equal(inspected, true);
  assert.equal(result.state, "accepted");
  assert.equal(result.workspaceSequence, 41);
});

test("a duplicate permit preserves the original authorizing runtime across replacement recovery", async () => {
  const replacement = consumeRequest({
    runtimeInstanceId: "manager-runtime-replacement" as ManagerReviewPermitConsumeRequest["runtimeInstanceId"],
    runtimeEpoch: 8,
  });
  const consumer = new HttpControlPlaneManagerReviewPermitConsumer({
    controlPlaneOrigin: "https://control.example.test",
    permitConsumeToken: PERMIT_TOKEN,
    fetch: async (_input, init) => {
      assert.equal(
        new Headers(init?.headers).get("x-steward-runtime-generation-proof"),
        null,
      );
      return Response.json(receipt(replacement, {
        state: "duplicate",
        managerRuntimeInstanceId: "manager-runtime-one",
        managerRuntimeEpoch: 7,
      }));
    },
  });

  const result = await consumer.consumeManagerReviewPermit(replacement);
  assert.equal(result.state, "duplicate");
  assert.equal(result.managerRuntimeInstanceId, "manager-runtime-one");
  assert.equal(result.managerRuntimeEpoch, 7);
});

test("permit consumer rejects rebound, malformed, downgraded, and oversized responses", async () => {
  const request = consumeRequest();
  const consumerFor = (response: () => Response) => new HttpControlPlaneManagerReviewPermitConsumer({
    controlPlaneOrigin: "https://control.example.test",
    permitConsumeToken: PERMIT_TOKEN,
    fetch: async () => response(),
  });

  await rejectsCode(
    consumerFor(() => Response.json(receipt(request, { evidenceId: "other-evidence" })))
      .consumeManagerReviewPermit(request),
    "INVALID_CONTROL_PLANE_PERMIT_RESPONSE",
  );
  await rejectsCode(
    consumerFor(() => Response.json(receipt(request, {
      managerRuntimeInstanceId: "other-runtime",
    }))).consumeManagerReviewPermit(request),
    "INVALID_CONTROL_PLANE_PERMIT_RESPONSE",
  );
  await rejectsCode(
    consumerFor(() => new Response(JSON.stringify(receipt(request)), {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })).consumeManagerReviewPermit(request),
    "INVALID_CONTROL_PLANE_PERMIT_RESPONSE",
  );
  await rejectsCode(
    consumerFor(() => new Response("x".repeat(65 * 1_024), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(65 * 1_024),
      },
    })).consumeManagerReviewPermit(request),
    "CONTROL_PLANE_PERMIT_RESPONSE_TOO_LARGE",
  );
  await rejectsCode(
    consumerFor(() => Response.json({ error: { code: "MANAGER_RUNTIME_NOT_ACTIVE" } }, { status: 409 }))
      .consumeManagerReviewPermit(request),
    "CONTROL_PLANE_PERMIT_REJECTED",
  );
});

test("permit origin requires HTTPS except for literal loopback HTTP", () => {
  assert.throws(
    () => new HttpControlPlaneManagerReviewPermitConsumer({
      controlPlaneOrigin: "http://localhost:4100",
      permitConsumeToken: PERMIT_TOKEN,
      fetch: async () => Response.json({}),
    }),
    (error: unknown) => error instanceof ReviewServiceError && error.code === "INVALID_CONFIGURATION",
  );
  assert.doesNotThrow(() => new HttpControlPlaneManagerReviewPermitConsumer({
    controlPlaneOrigin: "http://127.0.0.1:4100",
    permitConsumeToken: PERMIT_TOKEN,
    fetch: async () => Response.json({}),
  }));
});
