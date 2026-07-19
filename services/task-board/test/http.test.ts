import assert from "node:assert/strict";
import { test } from "node:test";
import { createTaskBoardService } from "../src/index.js";
import {
  AGENT_ONE_TOKEN,
  HUMAN_TOKEN,
  databasePath,
  taskRequest,
} from "./helpers.js";

async function request(
  origin: string,
  path: string,
  method: "GET" | "POST" | "PATCH",
  token: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("strict HTTP API exposes real board state, per-agent auth, CAS, and no heartbeat surface", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    host: "127.0.0.1",
    port: 0,
    corsOrigins: ["https://app.cicada.build"],
    now: () => new Date("2026-07-19T20:00:00.000Z"),
  });
  const address = await service.start();
  try {
    assert.equal((await request(address.url, "/v1/projects", "GET", AGENT_ONE_TOKEN)).status, 401);
    const projectResponse = await request(address.url, "/v1/projects", "POST", HUMAN_TOKEN, {
      name: "Checkout reliability",
      description: "Customer-facing recovery work.",
    });
    assert.equal(projectResponse.status, 201);
    const project = (await projectResponse.json() as { project: { projectId: string } }).project;

    const agentResponse = await request(address.url, `/v1/projects/${project.projectId}/agents`, "POST", HUMAN_TOKEN, {
      agentId: "engineer-one",
      role: "engineer",
      area: "checkout",
      mission: "Complete assigned checkout work safely.",
      model: "codex-mini",
      token: AGENT_ONE_TOKEN,
    });
    assert.equal(agentResponse.status, 201);
    assert.equal(JSON.stringify(await agentResponse.json()).includes(AGENT_ONE_TOKEN), false);

    const invalidTask = await request(address.url, `/v1/projects/${project.projectId}/tasks`, "POST", HUMAN_TOKEN, {
      ...taskRequest({ assignedAgentId: null, assignedRole: null }),
      expectedAgentMinutes: 20,
    });
    assert.equal(invalidTask.status, 400);

    const taskResponse = await request(address.url, `/v1/projects/${project.projectId}/tasks`, "POST", HUMAN_TOKEN, taskRequest({
      assignedAgentId: null,
      assignedRole: null,
    }));
    assert.equal(taskResponse.status, 201);
    const task = (await taskResponse.json() as { task: { taskId: string; version: number } }).task;
    assert.equal((await request(
      address.url,
      "/v1/agents/engineer-one/runs/claim?waitMs=0",
      "POST",
      AGENT_ONE_TOKEN,
      { claimId: "http-claim-before-assignment-0001", messageCursor: null },
    )).status, 204);

    const assignedResponse = await request(address.url, `/v1/tasks/${task.taskId}`, "PATCH", HUMAN_TOKEN, {
      version: task.version,
      assignedAgentId: "engineer-one",
      assignedRole: "engineer",
    });
    assert.equal(assignedResponse.status, 200);
    await assignedResponse.json();
    const claimResponse = await request(
      address.url,
      "/v1/agents/engineer-one/runs/claim?waitMs=0",
      "POST",
      AGENT_ONE_TOKEN,
      { claimId: "http-claim-after-assignment-0001", messageCursor: null },
    );
    assert.equal(claimResponse.status, 201);
    const claim = await claimResponse.json() as {
      run: { runId: string; taskId: string | null };
      wakeup: { reason: string };
      task: { status: string; version: number; startedAt: string | null };
      context: { acceptanceCriteria: string; agent: { role: string } };
    };
    assert.equal(claim.wakeup.reason, "human_assignment");
    assert.equal(claim.run.taskId, task.taskId);
    assert.equal(claim.task.status, "in_progress");
    assert.ok(claim.task.startedAt);
    assert.equal(claim.context.acceptanceCriteria, taskRequest().acceptanceCriteria);
    assert.equal(claim.context.agent.role, "engineer");

    const forbiddenAssignment = await request(address.url, `/v1/tasks/${task.taskId}`, "PATCH", AGENT_ONE_TOKEN, {
      version: claim.task.version,
      expectedAgentMinutes: 60,
    });
    assert.equal(forbiddenAssignment.status, 403);

    const messageBody = {
      clientEventId: "http-progress-0001",
      kind: "progress",
      body: "The first test iteration is passing.",
      runId: claim.run.runId,
    };
    const messageOne = await request(address.url, `/v1/tasks/${task.taskId}/messages`, "POST", AGENT_ONE_TOKEN, messageBody);
    const messageReplay = await request(address.url, `/v1/tasks/${task.taskId}/messages`, "POST", AGENT_ONE_TOKEN, messageBody);
    assert.equal(messageOne.status, 201);
    assert.equal(messageReplay.status, 201);
    assert.equal(
      (await messageOne.json() as { message: { messageId: string } }).message.messageId,
      (await messageReplay.json() as { message: { messageId: string } }).message.messageId,
    );

    const settle = await request(address.url, `/v1/runs/${claim.run.runId}/settle`, "POST", AGENT_ONE_TOKEN, {
      outcome: "failed",
      result: "The run needs a human-approved follow-up pass.",
    });
    assert.equal(settle.status, 200);

    const heldClaim = request(
      address.url,
      "/v1/agents/engineer-one/runs/claim?waitMs=1000",
      "POST",
      AGENT_ONE_TOKEN,
      { claimId: "http-held-claim-0001", messageCursor: null },
    );
    const resume = await request(
      address.url,
      "/v1/agents/engineer-one/resume",
      "POST",
      HUMAN_TOKEN,
      { reason: "Human approved a follow-up verification pass.", taskId: task.taskId },
      "http-resume-held-claim-0001",
    );
    assert.equal(resume.status, 201);
    const heldClaimResponse = await heldClaim;
    assert.equal(heldClaimResponse.status, 201);
    const heldClaimBody = await heldClaimResponse.json() as {
      run: { runId: string; taskId: string | null };
      wakeup: { reason: string };
    };
    assert.equal(heldClaimBody.wakeup.reason, "human_resume");
    assert.equal(heldClaimBody.run.taskId, task.taskId);
    assert.equal((await request(address.url, "/v1/agents/engineer-one/runs/claim?waitMs=30001", "POST", AGENT_ONE_TOKEN, {
      claimId: "http-invalid-wait-0001",
      messageCursor: null,
    })).status, 400);
    assert.equal((await request(address.url, `/v1/runs/${heldClaimBody.run.runId}/settle`, "POST", AGENT_ONE_TOKEN, {
      outcome: "completed",
      result: "Follow-up verification finished without deployment.",
    })).status, 200);
    assert.equal((await request(address.url, "/v1/heartbeat", "POST", AGENT_ONE_TOKEN, {})).status, 404);

    const boardResponse = await request(address.url, `/v1/projects/${project.projectId}/board`, "GET", HUMAN_TOKEN);
    assert.equal(boardResponse.status, 200);
    const board = await boardResponse.json() as {
      tasks: Array<{ status: string; result: string | null; endedAt: string | null }>;
      recentRuns: unknown[];
      recentQuestions: unknown[];
    };
    assert.equal(board.tasks.length, 1);
    assert.equal(board.tasks[0]?.status, "completed");
    assert.equal(board.tasks[0]?.result, "Follow-up verification finished without deployment.");
    assert.ok(board.tasks[0]?.endedAt);
    assert.equal(board.recentRuns.length, 2);
    assert.equal(board.recentQuestions.length, 0);

    const browser = await fetch(`${address.url}/v1/projects/${project.projectId}/board`, {
      headers: { Authorization: `Bearer ${HUMAN_TOKEN}`, Origin: "https://app.cicada.build" },
    });
    assert.equal(browser.status, 200);
    assert.equal(browser.headers.get("access-control-allow-origin"), "https://app.cicada.build");
  } finally {
    await service.close();
  }
});
