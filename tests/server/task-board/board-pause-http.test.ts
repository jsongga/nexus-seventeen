import assert from "node:assert/strict";
import test from "node:test";
import { createTaskBoardService } from "#server/task-board";
import { AGENT_ONE_TOKEN, HUMAN_TOKEN, databasePath, taskRequest } from "./helpers.js";

async function request(
  origin: string,
  path: string,
  method: "GET" | "POST",
  token: string,
  body?: unknown
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForParkedClaim(origin: string, projectId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await request(origin, `/v1/projects/${projectId}/board`, "GET", HUMAN_TOKEN);
    assert.equal(response.status, 200);
    const snapshot = (await response.json()) as {
      agents: Array<{ agentId: string; workerConnection: string | null }>;
    };
    if (snapshot.agents.find((agent) => agent.agentId === "engineer-one")?.workerConnection === "waiting_for_wake") {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("paused claim did not enter its long poll");
}

test("board pause endpoints enforce human CAS, gate claims, and resume a parked long poll", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    reconcileIntervalSeconds: 0,
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  });
  const address = await service.start();
  try {
    assert.equal((await request(address.url, "/v1/board/pause", "GET", AGENT_ONE_TOKEN)).status, 401);
    const initial = await request(address.url, "/v1/board/pause", "GET", HUMAN_TOKEN);
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), {
      paused: false,
      reason: null,
      version: 1,
      updatedAt: "1970-01-01T00:00:00.000Z",
      updatedBy: "system:steward-default",
    });

    const projectResponse = await request(address.url, "/v1/projects", "POST", HUMAN_TOKEN, {
      name: "Paused claims",
      description: "Keep pending agent work parked while the board is paused.",
    });
    assert.equal(projectResponse.status, 201);
    const projectId = ((await projectResponse.json()) as { project: { projectId: string } }).project.projectId;
    assert.equal(
      (
        await request(address.url, `/v1/projects/${projectId}/agents`, "POST", HUMAN_TOKEN, {
          agentId: "engineer-one",
          role: "engineer",
          area: "pause",
          mission: "Wait for the board to resume before claiming work.",
          model: "codex-mini",
          token: AGENT_ONE_TOKEN,
        })
      ).status,
      201
    );
    assert.equal(
      (
        await request(
          address.url,
          `/v1/projects/${projectId}/tasks`,
          "POST",
          HUMAN_TOKEN,
          taskRequest({
            assignedAgentId: "engineer-one",
            assignedRole: "engineer",
          })
        )
      ).status,
      201
    );

    for (const reason of ["", "x".repeat(501)]) {
      assert.equal(
        (
          await request(address.url, "/v1/board/pause", "POST", HUMAN_TOKEN, {
            reason,
            version: 1,
          })
        ).status,
        400
      );
    }
    const pausedResponse = await request(address.url, "/v1/board/pause", "POST", HUMAN_TOKEN, {
      reason: "Maintenance Authorization: Bearer secret-value",
      version: 1,
    });
    assert.equal(pausedResponse.status, 200);
    const paused = (await pausedResponse.json()) as { paused: boolean; reason: string | null; version: number };
    assert.deepEqual(paused, {
      paused: true,
      reason: "Maintenance Authorization: [redacted:bearer]",
      version: 2,
      updatedAt: "2026-08-21T12:00:00.000Z",
      updatedBy: "human:alice",
    });
    const conflict = await request(address.url, "/v1/board/pause", "POST", HUMAN_TOKEN, {
      reason: null,
      version: 1,
    });
    assert.equal(conflict.status, 409);
    assert.equal(
      ((await conflict.json()) as { error: { code: string } }).error.code,
      "TASK_BOARD_BOARD_PAUSE_VERSION_CONFLICT"
    );

    const repeated = await request(address.url, "/v1/board/pause", "POST", HUMAN_TOKEN, {
      reason: null,
      version: paused.version,
    });
    assert.equal(repeated.status, 200);
    const repeatedPause = (await repeated.json()) as { version: number; paused: boolean; reason: string | null };
    assert.deepEqual(repeatedPause, {
      paused: true,
      reason: null,
      version: 3,
      updatedAt: "2026-08-21T12:00:00.000Z",
      updatedBy: "human:alice",
    });

    const gated = await request(address.url, "/v1/agents/engineer-one/runs/claim?waitMs=0", "POST", AGENT_ONE_TOKEN, {
      claimId: "claim-paused-immediate",
      messageCursor: null,
    });
    assert.equal(gated.status, 204);

    const heldClaim = request(address.url, "/v1/agents/engineer-one/runs/claim?waitMs=30000", "POST", AGENT_ONE_TOKEN, {
      claimId: "claim-paused-until-resume",
      messageCursor: null,
    });
    await waitForParkedClaim(address.url, projectId);
    const wrongResume = await request(address.url, "/v1/board/resume", "POST", HUMAN_TOKEN, { version: 2 });
    assert.equal(wrongResume.status, 409);
    assert.equal(
      ((await wrongResume.json()) as { error: { code: string } }).error.code,
      "TASK_BOARD_BOARD_PAUSE_VERSION_CONFLICT"
    );

    const resume = await request(address.url, "/v1/board/resume", "POST", HUMAN_TOKEN, {
      version: repeatedPause.version,
    });
    assert.equal(resume.status, 200);
    assert.deepEqual(await resume.json(), {
      paused: false,
      reason: null,
      version: 4,
      updatedAt: "2026-08-21T12:00:00.000Z",
      updatedBy: "human:alice",
    });
    assert.equal((await within(heldClaim, 2_000)).status, 201);
  } finally {
    await service.close();
  }
});

test("a paused board returns a typed hold for a persisted claim replay", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    reconcileIntervalSeconds: 0,
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  });
  const address = await service.start();
  try {
    const projectResponse = await request(address.url, "/v1/projects", "POST", HUMAN_TOKEN, {
      name: "Paused replay claims",
      description: "Gate a durable prior claim while the board is paused.",
    });
    assert.equal(projectResponse.status, 201);
    const projectId = ((await projectResponse.json()) as { project: { projectId: string } }).project.projectId;
    assert.equal(
      (
        await request(address.url, `/v1/projects/${projectId}/agents`, "POST", HUMAN_TOKEN, {
          agentId: "engineer-one",
          role: "engineer",
          area: "pause replay",
          mission: "Do not launch while the board is paused.",
          model: "codex-mini",
          token: AGENT_ONE_TOKEN,
        })
      ).status,
      201
    );
    assert.equal(
      (
        await request(
          address.url,
          `/v1/projects/${projectId}/tasks`,
          "POST",
          HUMAN_TOKEN,
          taskRequest({
            assignedAgentId: "engineer-one",
            assignedRole: "engineer",
          })
        )
      ).status,
      201
    );
    const claimBody = { claimId: "claim-paused-persisted-replay", messageCursor: null };
    const initial = await request(
      address.url,
      "/v1/agents/engineer-one/runs/claim?waitMs=0",
      "POST",
      AGENT_ONE_TOKEN,
      claimBody
    );
    assert.equal(initial.status, 201);

    const paused = await request(address.url, "/v1/board/pause", "POST", HUMAN_TOKEN, {
      reason: "Hold persisted claim replays.",
      version: 1,
    });
    assert.equal(paused.status, 200);
    const replay = await request(
      address.url,
      "/v1/agents/engineer-one/runs/claim?waitMs=0",
      "POST",
      AGENT_ONE_TOKEN,
      claimBody
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { paused: true });
  } finally {
    await service.close();
  }
});
