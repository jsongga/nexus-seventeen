import assert from "node:assert/strict";
import test from "node:test";
import { TASK_BOARD_API_VERSION } from "#shared/task-board-contract";
import {
  HttpTaskBoardClient,
  InactiveClaimReplayError,
  RetryableSettlementError,
} from "../../../../src/server/agents/task-worker/http-board-client.js";
import { TaskBoardClaimResponseError } from "../../../../src/server/agents/task-worker/types.js";
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
  const pinned = {
    runtime: "codex",
    runtimeVersion: "codex-cli 1.2.3",
    model: "gpt-5.6-codex",
    promptsSha: "sha256:claim-prompts",
  };

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

test("claim responses expose immutable run pinning and preserve the onboarding discriminator", async () => {
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
        promptsSha: "sha256:old-prompts",
      },
    });
    assert.ok(replay);
    const onboardingReplay = {
      ...replay,
      context: { ...replay.context, onboarding: true as const },
    };
    const client = new HttpTaskBoardClient({
      baseUrl: "http://127.0.0.1:4318",
      token: TOKEN,
      fetchImplementation: (async () => new Response(JSON.stringify(onboardingReplay), {
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
        promptsSha: "sha256:new-prompts",
      },
    });

    assert.deepEqual(claimed?.pinned, {
      runtime: "codex",
      runtimeVersion: "codex-cli 1.2.3",
      model: "gpt-5.6-old",
      promptsSha: "sha256:old-prompts",
    });
    assert.equal(claimed?.context?.onboarding, true);
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

test("settlement accepts the server-redacted result while sending the original result and gap report for replay", async () => {
  const startedAt = "2026-08-09T20:00:00.000Z";
  const secret = `settle-${"s".repeat(48)}`;
  const rawResult = `Agent stopped after Authorization: Bearer ${secret}`;
  const gapReport = "# Gaps\n\n- Branch protection is deferred.";
  let sentBody: unknown;
  const client = new HttpTaskBoardClient({
    baseUrl: "http://127.0.0.1:4318",
    token: TOKEN,
    fetchImplementation: (async (_input, init = {}) => {
      sentBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        run: {
          runId: "run-redacted-settlement",
          agentId: "engineer-one",
          status: "failed",
          result: "Agent stopped after Authorization: [redacted:bearer]",
        },
        duplicate: false,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  await client.settleAgentRun({
    claim: {
      apiVersion: 1,
      claimId: "claim-redacted-settlement",
      runId: "run-redacted-settlement",
      wakeupId: "wake-redacted-settlement",
      projectId: "project-one",
      agentId: "engineer-one",
      taskId: "task-one",
      reason: "human_assignment",
      requestedMessageCursor: null,
      claimedAt: startedAt,
    },
    idempotencyKey: "settle-redacted-result-0001",
    outcome: "failed",
    result: rawResult,
    gapReport,
  });

  assert.equal((sentBody as { result?: unknown }).result, rawResult);
  assert.equal((sentBody as { gapReport?: unknown }).gapReport, gapReport);
});

test("typed correctable settle 400s are distinguished from poisoned HTTP failures", async () => {
  for (const code of ["WORKFLOW_PLAN_REQUIRED", "ONBOARDING_DELIVERABLES_MISSING"] as const) {
    const client = new HttpTaskBoardClient({
      baseUrl: "http://127.0.0.1:4318",
      token: TOKEN,
      fetchImplementation: (async () => new Response(JSON.stringify({
        error: { code, message: "The model result needs correction." },
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    });

    await assert.rejects(client.settleAgentRun({
      claim: {
        apiVersion: 1,
        claimId: `claim-${code.toLowerCase()}`,
        runId: `run-${code.toLowerCase()}`,
        wakeupId: `wake-${code.toLowerCase()}`,
        projectId: "project-one",
        agentId: "engineer-one",
        taskId: "task-one",
        reason: "human_assignment",
        requestedMessageCursor: null,
        claimedAt: "2026-08-09T20:00:00.000Z",
      },
      idempotencyKey: `settle-${code.toLowerCase()}`,
      outcome: "completed",
      result: "The first result needs correction.",
    }), (error: unknown) => error instanceof RetryableSettlementError && error.code === code);
  }
});
