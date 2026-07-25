import assert from "node:assert/strict";
import { test } from "node:test";
import { createTaskBoardService } from "../src/index.js";
import {
  AGENT_ONE_TOKEN,
  AGENT_TWO_TOKEN,
  HUMAN_TOKEN,
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  databasePath,
  taskRequest,
} from "./helpers.js";

async function readSseFrame(reader: ReadableStreamDefaultReader<Uint8Array>, prior = ""): Promise<{ frame: string; rest: string }> {
  const decoder = new TextDecoder();
  let text = prior;
  while (!text.includes("\n\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    text += decoder.decode(chunk.value, { stream: true });
  }
  const boundary = text.indexOf("\n\n");
  return { frame: text.slice(0, boundary), rest: text.slice(boundary + 2) };
}

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

async function waitForWorkerConnection(
  origin: string,
  projectId: string,
  agentId: string,
  expected: "waiting_for_wake" | "watching_run" | null,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await request(origin, `/v1/projects/${projectId}/board`, "GET", HUMAN_TOKEN);
    assert.equal(response.status, 200);
    const board = await response.json() as {
      agents: Array<{ agentId: string; workerConnection: "waiting_for_wake" | "watching_run" | null }>;
    };
    if (board.agents.find((agent) => agent.agentId === agentId)?.workerConnection === expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Worker connection for ${agentId} did not become ${String(expected)}`);
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

test("dormant automation configuration is human-only and CAS controlled", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    host: "127.0.0.1",
    port: 0,
    corsOrigins: ["https://app.cicada.build"],
    now: () => new Date("2026-07-20T20:00:00.000Z"),
  });
  const address = await service.start();
  try {
    assert.equal((await request(address.url, "/v1/automation-configuration", "GET", AGENT_ONE_TOKEN)).status, 401);
    const defaultsResponse = await request(address.url, "/v1/automation-configuration", "GET", HUMAN_TOKEN);
    assert.equal(defaultsResponse.status, 200);
    const defaults = (await defaultsResponse.json() as {
      configuration: {
        configurationId: string;
        version: number;
        agentTypes: unknown[];
        stages: unknown[];
        updatedBy: string;
      };
    }).configuration;
    assert.equal(defaults.configurationId, "company-default");
    assert.equal(defaults.version, 1);
    assert.deepEqual(defaults.agentTypes, []);
    assert.deepEqual(defaults.stages, automationStages());
    assert.equal(defaults.updatedBy, "system:steward-default");

    const engineerType = {
      agentTypeId: "implementation-engineer",
      name: "Implementation engineer",
      description: "Implements and tests approved project changes.",
      role: "engineer" as const,
      supplementalInstructions: "Return concrete implementation and test evidence.",
      skillIds: ["code.edit", "tests.run"],
      evaluatorProfile: "tests" as const,
      enabled: true,
    };
    const verifierType = {
      agentTypeId: "independent-verifier",
      name: "Independent verifier",
      description: "Verifies completed work against the acceptance criteria.",
      role: "verifier" as const,
      supplementalInstructions: "Review independently and report bounded evidence.",
      skillIds: ["verification.review"],
      evaluatorProfile: "manual" as const,
      enabled: true,
    };
    const update = automationConfigurationRequest({
      agentTypes: [engineerType, verifierType],
      stages: automationStages({
        implementation: { kind: "agent_type", agentTypeId: engineerType.agentTypeId },
        testing: { kind: "agent_type", agentTypeId: engineerType.agentTypeId },
        verification: { kind: "agent_type", agentTypeId: verifierType.agentTypeId },
      }),
    });
    assert.equal((await request(
      address.url,
      "/v1/automation-configuration",
      "PATCH",
      AGENT_ONE_TOKEN,
      update,
    )).status, 401);

    const updatedResponse = await request(
      address.url,
      "/v1/automation-configuration",
      "PATCH",
      HUMAN_TOKEN,
      update,
    );
    assert.equal(updatedResponse.status, 200);
    const updated = (await updatedResponse.json() as {
      configuration: {
        version: number;
        agentTypes: unknown[];
        stages: unknown[];
        updatedBy: string;
      };
    }).configuration;
    assert.equal(updated.version, 2);
    assert.deepEqual(updated.agentTypes, [engineerType, verifierType]);
    assert.deepEqual(updated.stages, update.stages);
    assert.equal(updated.updatedBy, "human:alice");

    assert.equal((await request(
      address.url,
      "/v1/automation-configuration",
      "PATCH",
      HUMAN_TOKEN,
      update,
    )).status, 409);
    assert.equal((await request(
      address.url,
      "/v1/automation-configuration",
      "PATCH",
      HUMAN_TOKEN,
      { ...update, version: updated.version, provider: "external" },
    )).status, 400);

    const fetchedResponse = await request(address.url, "/v1/automation-configuration", "GET", HUMAN_TOKEN);
    assert.equal(fetchedResponse.status, 200);
    const fetched = (await fetchedResponse.json() as { configuration: { version: number; agentTypes: unknown[] } }).configuration;
    assert.equal(fetched.version, 2);
    assert.deepEqual(fetched.agentTypes, [engineerType, verifierType]);
  } finally {
    await service.close();
  }
});

test("global work-item intake is human-only, idempotent, and CAS controlled", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    host: "127.0.0.1",
    port: 0,
    corsOrigins: ["https://app.cicada.build"],
    now: () => new Date("2026-07-20T20:00:00.000Z"),
  });
  const address = await service.start();
  try {
    const body = { originalRequest: "Investigate and improve checkout reliability." };
    assert.equal((await request(address.url, "/v1/work-items", "POST", HUMAN_TOKEN, body)).status, 400);
    assert.equal((await request(
      address.url,
      "/v1/work-items",
      "POST",
      AGENT_ONE_TOKEN,
      body,
      "http-work-item-unauthorized-0001",
    )).status, 401);

    const createdResponse = await request(
      address.url,
      "/v1/work-items",
      "POST",
      HUMAN_TOKEN,
      body,
      "http-work-item-create-0001",
    );
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json() as {
      workItem: {
        workItemId: string;
        originalRequest: string;
        priority: string;
        projectTarget: unknown;
        resolvedProjectId: string | null;
        state: string;
        currentStage: string | null;
        version: number;
      };
    }).workItem;
    assert.equal(created.originalRequest, body.originalRequest);
    assert.equal(created.priority, "normal");
    assert.deepEqual(created.projectTarget, { mode: "auto" });
    assert.equal(created.resolvedProjectId, null);
    assert.equal(created.state, "submitted");
    assert.equal(created.currentStage, "refinement");
    assert.equal(created.version, 1);

    const replayResponse = await request(
      address.url,
      "/v1/work-items",
      "POST",
      HUMAN_TOKEN,
      body,
      "http-work-item-create-0001",
    );
    assert.equal(replayResponse.status, 200);
    assert.equal(
      (await replayResponse.json() as { workItem: { workItemId: string } }).workItem.workItemId,
      created.workItemId,
    );
    assert.equal((await request(
      address.url,
      "/v1/work-items",
      "POST",
      HUMAN_TOKEN,
      { originalRequest: "A different request." },
      "http-work-item-create-0001",
    )).status, 409);

    const projectResponse = await request(address.url, "/v1/projects", "POST", HUMAN_TOKEN, {
      name: "Checkout reliability",
      description: "Customer-facing recovery work.",
    });
    const project = (await projectResponse.json() as { project: { projectId: string } }).project;
    const updateResponse = await request(address.url, `/v1/work-items/${created.workItemId}`, "PATCH", HUMAN_TOKEN, {
      version: created.version,
      priority: "high",
      projectTarget: { mode: "explicit", projectId: project.projectId },
    });
    assert.equal(updateResponse.status, 200);
    const updated = (await updateResponse.json() as {
      workItem: { version: number; priority: string; projectTarget: unknown; resolvedProjectId: string | null };
    }).workItem;
    assert.equal(updated.version, 2);
    assert.equal(updated.priority, "high");
    assert.deepEqual(updated.projectTarget, { mode: "explicit", projectId: project.projectId });
    assert.equal(updated.resolvedProjectId, project.projectId);
    assert.equal((await request(address.url, `/v1/work-items/${created.workItemId}`, "PATCH", HUMAN_TOKEN, {
      version: created.version,
      priority: "low",
    })).status, 409);
    assert.equal((await request(address.url, `/v1/work-items/${created.workItemId}`, "PATCH", HUMAN_TOKEN, {
      version: updated.version,
      originalRequest: "Overwrite the accepted request.",
    })).status, 400);

    const listed = await request(address.url, "/v1/work-items", "GET", HUMAN_TOKEN);
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as { workItems: Array<{ workItemId: string }>; nextCursor?: string };
    assert.deepEqual(
      listedBody.workItems.map((item) => item.workItemId),
      [created.workItemId],
    );
    assert.equal(listedBody.nextCursor, undefined);
    const fetched = await request(address.url, `/v1/work-items/${created.workItemId}`, "GET", HUMAN_TOKEN);
    assert.equal(fetched.status, 200);
    assert.equal((await fetched.json() as { workItem: { version: number } }).workItem.version, 2);
    assert.equal((await request(address.url, "/v1/work-items/missing", "GET", HUMAN_TOKEN)).status, 404);
    assert.equal((await request(address.url, "/v1/work-items", "GET", AGENT_ONE_TOKEN)).status, 401);
  } finally {
    await service.close();
  }
});

test("work-item HTTP keyset continuation is exhaustive and rejects non-canonical queries", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  for (let index = 0; index < 201; index += 1) {
    fixture.board.createWorkItem(
      { originalRequest: `HTTP paginated work item ${index}` },
      `http-pagination-${index}`,
    );
  }
  fixture.board.close();

  const service = await createTaskBoardService({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    host: "127.0.0.1",
    port: 0,
    corsOrigins: ["https://app.cicada.build"],
    now: () => new Date("2026-07-20T20:00:00.000Z"),
  });
  const address = await service.start();
  try {
    const initialResponse = await request(address.url, "/v1/work-items", "GET", HUMAN_TOKEN);
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json() as {
      workItems: Array<{ workItemId: string }>;
      nextCursor?: string;
    };
    assert.equal(initial.workItems.length, 200);
    assert.ok(initial.nextCursor);

    const continuationResponse = await request(
      address.url,
      `/v1/work-items?cursor=${encodeURIComponent(initial.nextCursor)}`,
      "GET",
      HUMAN_TOKEN,
    );
    assert.equal(continuationResponse.status, 200);
    const continuation = await continuationResponse.json() as {
      workItems: Array<{ workItemId: string }>;
      nextCursor?: string;
    };
    assert.equal(continuation.workItems.length, 1);
    assert.equal(continuation.nextCursor, undefined);
    const initialIds = new Set(initial.workItems.map((workItem) => workItem.workItemId));
    assert.ok(continuation.workItems.every((workItem) => !initialIds.has(workItem.workItemId)));
    assert.equal(initialIds.size + continuation.workItems.length, 201);

    assert.equal((await request(address.url, "/v1/work-items?unknown=value", "GET", HUMAN_TOKEN)).status, 400);
    assert.equal((await request(
      address.url,
      `/v1/work-items?cursor=${initial.nextCursor}&cursor=${initial.nextCursor}`,
      "GET",
      HUMAN_TOKEN,
    )).status, 400);
    assert.equal((await request(address.url, "/v1/work-items?cursor=", "GET", HUMAN_TOKEN)).status, 400);
    assert.equal((await request(address.url, "/v1/work-items?cursor=not-a-cursor!", "GET", HUMAN_TOKEN)).status, 400);
    assert.equal((await request(
      address.url,
      `/v1/work-items?cursor=${"a".repeat(513)}`,
      "GET",
      HUMAN_TOKEN,
    )).status, 400);

    const unsupportedPayload = JSON.parse(Buffer.from(initial.nextCursor, "base64url").toString("utf8")) as {
      version: number;
    };
    unsupportedPayload.version = 2;
    const unsupportedCursor = Buffer.from(JSON.stringify(unsupportedPayload), "utf8").toString("base64url");
    assert.equal((await request(
      address.url,
      `/v1/work-items?cursor=${unsupportedCursor}`,
      "GET",
      HUMAN_TOKEN,
    )).status, 400);
    assert.equal((await request(
      address.url,
      `/v1/work-items?cursor=${initial.nextCursor}`,
      "GET",
      AGENT_ONE_TOKEN,
    )).status, 401);
  } finally {
    await service.close();
  }
});

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

    const agentEstimate = await request(address.url, `/v1/tasks/${task.taskId}`, "PATCH", AGENT_ONE_TOKEN, {
      version: claim.task.version,
      expectedAgentMinutes: 60,
    });
    assert.equal(agentEstimate.status, 200);
    const estimatedTask = (await agentEstimate.json() as {
      task: { expectedAgentMinutes: number | null; estimateRecordedAt: string | null; expectedCompletedAt: string | null };
    }).task;
    assert.equal(estimatedTask.expectedAgentMinutes, 60);
    assert.equal(estimatedTask.estimateRecordedAt, "2026-07-19T20:00:00.000Z");
    assert.equal(estimatedTask.expectedCompletedAt, "2026-07-19T21:00:00.000Z");
    const humanEstimate = await request(address.url, `/v1/tasks/${task.taskId}`, "PATCH", HUMAN_TOKEN, {
      version: claim.task.version + 1,
      expectedAgentMinutes: 30,
    });
    assert.equal(humanEstimate.status, 403);
    const phaseResponse = await request(address.url, `/v1/tasks/${task.taskId}/phases`, "POST", AGENT_ONE_TOKEN, {
      title: "Implement and verify retry handling",
      stage: "planning",
      parallelGroup: null,
    });
    assert.equal(phaseResponse.status, 201);
    const phase = (await phaseResponse.json() as { phase: { phaseId: string; version: number } }).phase;
    const runningPhase = await request(address.url, `/v1/task-phases/${phase.phaseId}`, "PATCH", AGENT_ONE_TOKEN, {
      version: phase.version,
      stage: "execution",
      status: "in_progress",
    });
    assert.equal(runningPhase.status, 200);
    assert.equal((await runningPhase.json() as { phase: { status: string } }).phase.status, "in_progress");
    assert.equal((await request(address.url, `/v1/tasks/${task.taskId}/phases`, "POST", HUMAN_TOKEN, {
      title: "Humans cannot impersonate agent progress",
      stage: "planning",
      parallelGroup: null,
    })).status, 401);

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
      tasks: Array<{
        taskId: string;
        parentTaskId: string | null;
        kind: string;
        requiredRole: string | null;
        status: string;
        result: string | null;
        endedAt: string | null;
      }>;
      recentRuns: unknown[];
      recentQuestions: unknown[];
    };
    assert.equal(board.tasks.length, 2);
    const completedWork = board.tasks.find((item) => item.taskId === task.taskId);
    const managerReview = board.tasks.find((item) => item.kind === "manager_review");
    assert.equal(completedWork?.kind, "work");
    assert.equal(completedWork?.status, "completed");
    assert.equal(completedWork?.result, "Follow-up verification finished without deployment.");
    assert.ok(completedWork?.endedAt);
    assert.equal(managerReview?.parentTaskId, task.taskId);
    assert.equal(managerReview?.requiredRole, "manager");
    assert.equal(managerReview?.status, "backlog");
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

test("held HTTP worker requests expose transient connections and service close releases them", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    host: "127.0.0.1",
    port: 0,
  });
  const address = await service.start();
  try {
    const projectResponse = await request(address.url, "/v1/projects", "POST", HUMAN_TOKEN, {
      name: "Worker connections",
      description: "Observe existing held worker requests without heartbeats.",
    });
    assert.equal(projectResponse.status, 201);
    const projectId = (await projectResponse.json() as { project: { projectId: string } }).project.projectId;
    for (const agent of [
      { agentId: "engineer-one", token: AGENT_ONE_TOKEN },
      { agentId: "engineer-two", token: AGENT_TWO_TOKEN },
    ]) {
      const response = await request(address.url, `/v1/projects/${projectId}/agents`, "POST", HUMAN_TOKEN, {
        agentId: agent.agentId,
        role: "engineer",
        area: agent.agentId,
        mission: "Complete only explicitly assigned development work.",
        model: "codex-mini",
        token: agent.token,
      });
      assert.equal(response.status, 201);
    }

    const cancel = new AbortController();
    const canceledClaim = fetch(`${address.url}/v1/agents/engineer-one/runs/claim?waitMs=30000`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENT_ONE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ claimId: "http-canceled-held-claim-0001", messageCursor: null }),
      signal: cancel.signal,
    });
    await waitForWorkerConnection(address.url, projectId, "engineer-one", "waiting_for_wake");
    cancel.abort();
    await assert.rejects(canceledClaim, (error: unknown) => error instanceof Error && error.name === "AbortError");
    await waitForWorkerConnection(address.url, projectId, "engineer-one", null);

    const taskResponse = await request(address.url, `/v1/projects/${projectId}/tasks`, "POST", HUMAN_TOKEN, taskRequest({
      title: "Watch an active run",
      assignedAgentId: "engineer-two",
      assignedRole: "engineer",
    }));
    assert.equal(taskResponse.status, 201);
    const claimResponse = await request(
      address.url,
      "/v1/agents/engineer-two/runs/claim?waitMs=0",
      "POST",
      AGENT_TWO_TOKEN,
      { claimId: "http-active-run-for-watch-0001", messageCursor: null },
    );
    assert.equal(claimResponse.status, 201);
    const runId = (await claimResponse.json() as { run: { runId: string } }).run.runId;

    const heldClaim = request(
      address.url,
      "/v1/agents/engineer-one/runs/claim?waitMs=30000",
      "POST",
      AGENT_ONE_TOKEN,
      { claimId: "http-close-held-claim-0001", messageCursor: null },
    );
    const heldInterrupt = request(
      address.url,
      `/v1/runs/${runId}/interrupts?after=0&waitMs=30000`,
      "GET",
      AGENT_TWO_TOKEN,
    );
    await waitForWorkerConnection(address.url, projectId, "engineer-one", "waiting_for_wake");
    await waitForWorkerConnection(address.url, projectId, "engineer-two", "watching_run");

    await within(service.close(), 2_000);
    assert.equal((await heldClaim).status, 204);
    assert.equal((await heldInterrupt).status, 204);
  } finally {
    await service.close();
  }
});

test("document HTTP auth and full-snapshot SSE replay remain ordered across restart", async () => {
  const path = await databasePath();
  const options = {
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    host: "127.0.0.1" as const,
    port: 0,
    now: () => new Date("2026-07-19T20:00:00.000Z"),
  };
  let service = await createTaskBoardService(options);
  let address = await service.start();
  let documentId = "";
  const nearLimit = "x".repeat(48 * 1_024);
  try {
    const projectResponse = await request(address.url, "/v1/projects", "POST", HUMAN_TOKEN, {
      name: "Document broadcasts",
      description: "Share development notes without frontend ownership.",
    });
    const projectId = (await projectResponse.json() as { project: { projectId: string } }).project.projectId;
    assert.equal((await request(address.url, `/v1/projects/${projectId}/agents`, "POST", HUMAN_TOKEN, {
      agentId: "engineer-one",
      role: "engineer",
      area: "documents",
      mission: "Maintain project notes.",
      model: "codex-mini",
      token: AGENT_ONE_TOKEN,
    })).status, 201);
    const otherProjectResponse = await request(address.url, "/v1/projects", "POST", HUMAN_TOKEN, {
      name: "Other project",
      description: "Must not read the first project's documents.",
    });
    const otherProjectId = (await otherProjectResponse.json() as { project: { projectId: string } }).project.projectId;
    assert.equal((await request(address.url, `/v1/projects/${otherProjectId}/agents`, "POST", HUMAN_TOKEN, {
      agentId: "engineer-two",
      role: "engineer",
      area: "other",
      mission: "Stay within the other project.",
      model: "codex-mini",
      token: AGENT_TWO_TOKEN,
    })).status, 201);

    const createdResponse = await request(address.url, `/v1/projects/${projectId}/documents`, "POST", HUMAN_TOKEN, {
      title: "Large recovery note",
      contentType: "text/markdown",
      content: nearLimit,
      clientId: "browser-owner",
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json() as { document: { documentId: string } }).document;
    documentId = created.documentId;
    assert.equal((await request(address.url, `/v1/documents/${documentId}`, "GET", AGENT_ONE_TOKEN)).status, 200);
    assert.equal((await request(address.url, `/v1/documents/${documentId}`, "GET", AGENT_TWO_TOKEN)).status, 403);
    assert.equal((await request(address.url, `/v1/projects/${projectId}/documents`, "POST", AGENT_ONE_TOKEN, {
      title: "Unauthorized create",
      contentType: "text/markdown",
      content: "no",
      clientId: "agent-client",
    })).status, 401);
    const updated = await request(address.url, `/v1/documents/${documentId}`, "PATCH", HUMAN_TOKEN, {
      clientId: "browser-owner",
      penEpoch: 1,
      contentVersion: 1,
      content: nearLimit.replaceAll("x", "y"),
    });
    assert.equal(updated.status, 200);

    await service.close();
    service = await createTaskBoardService(options);
    address = await service.start();

    const controller = new AbortController();
    const stream = await fetch(`${address.url}/v1/documents/${documentId}/events?after=1`, {
      headers: { Authorization: `Bearer ${HUMAN_TOKEN}`, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream/u);
    const reader = stream.body?.getReader();
    assert.ok(reader);
    let parsed = await readSseFrame(reader);
    assert.match(parsed.frame, /^id: 2\nevent: document\ndata: /u);
    const replay = JSON.parse(parsed.frame.split("\ndata: ")[1]!) as { document: { sequence: number; content: string } };
    assert.equal(replay.document.sequence, 2);
    assert.equal(replay.document.content.length, nearLimit.length);

    const liveUpdate = await request(address.url, `/v1/documents/${documentId}`, "PATCH", HUMAN_TOKEN, {
      clientId: "browser-owner",
      penEpoch: 1,
      contentVersion: 2,
      content: "# Human-reviewed recovery",
    });
    assert.equal(liveUpdate.status, 200);
    parsed = await readSseFrame(reader, parsed.rest);
    assert.match(parsed.frame, /^id: 3\nevent: document\ndata: /u);
    const live = JSON.parse(parsed.frame.split("\ndata: ")[1]!) as { document: { sequence: number; contentVersion: number } };
    assert.equal(live.document.sequence, 3);
    assert.equal(live.document.contentVersion, 3);
    controller.abort();
  } finally {
    await service.close();
  }
});
