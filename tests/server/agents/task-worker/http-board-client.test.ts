import assert from "node:assert/strict";
import test from "node:test";
import { TASK_BOARD_API_VERSION } from "#shared/task-board-contract";
import { HttpTaskBoardClient } from "#server/agents/task-worker/http-board-client";
import { TaskBoardClaimResponseError } from "#server/agents/task-worker/types";

test("claim validation errors retain a minimally validated handle without journaling board-provided reason text", async () => {
  const startedAt = "2026-08-09T20:00:00.000Z";
  const credentialShapedReason = "human_assignment\u0000 sk-proj-board-secret-0123456789";
  const body = {
    apiVersion: TASK_BOARD_API_VERSION,
    run: {
      apiVersion: TASK_BOARD_API_VERSION,
      runId: "run-poisoned",
      claimId: "claim-poisoned",
      projectId: "project-one",
      agentId: "engineer-one",
      wakeupId: "wake-poisoned",
      taskId: "task-one",
      status: "active",
      startedAt,
      endedAt: null,
      result: null,
    },
    wakeup: {
      apiVersion: TASK_BOARD_API_VERSION,
      wakeupId: "wake-poisoned",
      projectId: "project-one",
      agentId: "engineer-one",
      reason: credentialShapedReason,
      taskId: "task-one",
      questionId: null,
      detail: "Run the assigned task.",
      createdBy: "human:operator",
      createdAt: startedAt,
      claimedAt: startedAt,
      runId: "run-poisoned",
    },
    task: null,
    context: {},
  };
  const client = new HttpTaskBoardClient({
    baseUrl: "http://127.0.0.1:4318",
    token: "agent-one-token-0123456789-abcdefghijklmnopqrstuvwxyz",
    fetchImplementation: (async () => new Response(JSON.stringify(body), {
      status: 201,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  await assert.rejects(
    client.claimNextWake({
      agentId: "engineer-one",
      claimId: "claim-poisoned",
      messageCursors: { "task-one": 7 },
      longPollMs: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof TaskBoardClaimResponseError);
      assert.equal(error.claim?.runId, "run-poisoned");
      assert.equal(error.claim?.claimId, "claim-poisoned");
      assert.equal(error.claim?.requestedMessageCursor, 7);
      assert.equal(error.claim?.reason, "poisoned_claim");
      assert.doesNotMatch(JSON.stringify(error.claim), /sk-proj-board-secret/u);
      return true;
    },
  );
});
