import assert from "node:assert/strict";
import test from "node:test";
import { TASK_BOARD_API_VERSION } from "#shared/task-board-contract";
import {
  HttpTaskBoardClient,
  InactiveClaimReplayError,
} from "#server/agents/task-worker/http-board-client";
import { TaskBoardClaimResponseError } from "#server/agents/task-worker/types";
import { boardFixture, taskRequest } from "../../task-board/helpers.js";

const TOKEN = "agent-one-token-0123456789-abcdefghijklmnopqrstuvwxyz";

test("claim pinning is sent verbatim and heartbeat uses the body-less run route", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const startedAt = "2026-08-09T20:00:00.000Z";
  const heartbeatAt = "2026-08-09T20:00:30.000Z";
  const run = {
    apiVersion: TASK_BOARD_API_VERSION,
    runId: "run-one",
    claimId: "claim-one",
    projectId: "project-one",
    agentId: "engineer-one",
    wakeupId: "wake-one",
    taskId: "task-one",
    status: "active",
    startedAt,
    heartbeatAt,
    endedAt: null,
    result: null,
    runtime: "codex",
    runtimeVersion: "codex-cli 1.2.3",
    model: "gpt-5.6-codex",
    promptsSha: null,
  };
  const client = new HttpTaskBoardClient({
    baseUrl: "http://127.0.0.1:4318",
    token: TOKEN,
    fetchImplementation: (async (input, init = {}) => {
      requests.push({ url: String(input), init });
      if (String(input).includes("/runs/claim")) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ run }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  const pinned = { runtime: "codex", runtimeVersion: "codex-cli 1.2.3", model: "gpt-5.6-codex" };

  await client.claimNextWake({
    agentId: "engineer-one",
    claimId: "claim-one",
    messageCursors: { "task-one": 4 },
    longPollMs: 1,
    pinned,
  });
  await client.heartbeatRun({
    apiVersion: 1,
    claimId: "claim-one",
    runId: "run-one",
    wakeupId: "wake-one",
    projectId: "project-one",
    agentId: "engineer-one",
    taskId: "task-one",
    reason: "human_assignment",
    requestedMessageCursor: 4,
    claimedAt: startedAt,
  });

  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    claimId: "claim-one",
    messageCursors: { "task-one": 4 },
    pinned,
  });
  assert.equal(requests[1]?.url, "http://127.0.0.1:4318/v1/runs/run-one/heartbeat");
  assert.equal(requests[1]?.init.method, "POST");
  assert.equal(requests[1]?.init.body, undefined);
});

test("claim responses expose the immutable run pinning instead of the replay request", async () => {
  const fixture = await boardFixture();
  try {
    fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Retain replay pinning" }));
    const replay = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-http-replay-pinning",
      messageCursor: null,
      pinned: {
        runtime: "codex",
        runtimeVersion: "codex-cli 1.2.3",
        model: "gpt-5.6-old",
      },
    });
    assert.ok(replay);
    const client = new HttpTaskBoardClient({
      baseUrl: "http://127.0.0.1:4318",
      token: TOKEN,
      fetchImplementation: (async () => new Response(JSON.stringify(replay), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    });

    const claimed = await client.claimNextWake({
      agentId: fixture.engineer.agentId,
      claimId: replay.run.claimId,
      messageCursors: {},
      longPollMs: 0,
      pinned: {
        runtime: "codex",
        runtimeVersion: "codex-cli 2.0.0",
        model: "gpt-5.6-new",
      },
    });

    assert.deepEqual(claimed?.pinned, {
      runtime: "codex",
      runtimeVersion: "codex-cli 1.2.3",
      model: "gpt-5.6-old",
    });
  } finally {
    fixture.board.close();
  }
});

test("a settled claim replay is reported as inactive before worker launch", async () => {
  const fixture = await boardFixture();
  try {
    fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Reject an inactive replay" }));
    const first = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-http-inactive-replay",
      messageCursor: null,
    });
    assert.ok(first);
    const endedAt = "2026-08-09T20:05:00.000Z";
    const replay = {
      ...first,
      run: {
        ...first.run,
        status: "interrupted" as const,
        endedAt,
        result: "run heartbeat lost",
      },
    };
    const client = new HttpTaskBoardClient({
      baseUrl: "http://127.0.0.1:4318",
      token: TOKEN,
      fetchImplementation: (async () => new Response(JSON.stringify(replay), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    });

    await assert.rejects(
      client.claimNextWake({
        agentId: fixture.engineer.agentId,
        claimId: first.run.claimId,
        messageCursors: {},
        longPollMs: 0,
      }),
      (error: unknown) => (
        error instanceof InactiveClaimReplayError &&
        error.claim.runId === first.run.runId &&
        error.status === "interrupted" &&
        error.endedAt === endedAt
      ),
    );
  } finally {
    fixture.board.close();
  }
});

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
    token: TOKEN,
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
