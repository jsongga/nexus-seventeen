import assert from "node:assert/strict";
import { test } from "node:test";
import { createTaskBoardService } from "#server/task-board";
import {
  AGENT_ONE_TOKEN,
  AGENT_TWO_TOKEN,
  HUMAN_TOKEN,
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  databasePath,
  gateActions,
  taskRequest,
  workItemRequest,
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

test("unexpected route failures are logged once with redacted structured context", async () => {
  const path = await databasePath();
  const service = await createTaskBoardService({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    reconcileIntervalSeconds: 0,
  });
  const address = await service.start();
  const { DatabaseSync } = await import("node:sqlite");
  const injected = new DatabaseSync(path);
  const originalError = console.error;
  const records: unknown[][] = [];
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  try {
    injected.exec(`
      CREATE TRIGGER fail_project_insert
      BEFORE INSERT ON projects
      BEGIN
        SELECT RAISE(ABORT, 'route exploded Bearer ${secret}');
      END;
    `);
    console.error = (...arguments_: unknown[]) => { records.push(arguments_); };

    const response = await request(address.url, "/v1/projects", "POST", HUMAN_TOKEN, {
      name: "Injected failure",
      description: "Exercise the unexpected route error boundary.",
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: { code: "INTERNAL_ERROR", message: "Task board could not complete the request" },
    });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.[0], "[task-board] request failed");
    const record = records[0]?.[1] as Record<string, unknown> | undefined;
    assert.deepEqual(record === undefined ? undefined : {
      method: record.method,
      path: record.path,
      message: record.message,
    }, {
      method: "POST",
      path: "/v1/projects",
      message: "route exploded [redacted:bearer]",
    });
    assert.equal(typeof record?.stack, "string");
    assert.match(String(record?.stack), /route exploded \[redacted:bearer\]/u);
    assert.doesNotMatch(JSON.stringify(records), new RegExp(secret, "u"));
  } finally {
    console.error = originalError;
    injected.close();
    await service.close();
  }
});

test("dormant automation configuration is human-only and CAS controlled", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
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

test("automatic work-item intake is rejected without creating a row", async () => {
  const path = await databasePath();
  const service = await createTaskBoardService({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    corsOrigins: ["https://app.cicada.build"],
    now: () => new Date("2026-07-20T20:00:00.000Z"),
  });
  const address = await service.start();
  try {
    const response = await request(
      address.url,
      "/v1/work-items",
      "POST",
      HUMAN_TOKEN,
      {
        originalRequest: "Do not strand this request in automatic project routing.",
        projectTarget: { mode: "auto" },
      },
      "http-work-item-auto-rejected-0001",
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { code: "PROJECT_REQUIRED", message: "Choose a project" },
    });

    const { DatabaseSync } = await import("node:sqlite");
    const inspected = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM work_items").get()?.count, 0);
    } finally {
      inspected.close();
    }
  } finally {
    await service.close();
  }
});

test("global work-item intake is human-only, explicitly targeted, idempotent, and CAS controlled", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    corsOrigins: ["https://app.cicada.build"],
    now: () => new Date("2026-07-20T20:00:00.000Z"),
  });
  const address = await service.start();
  try {
    const projectResponse = await request(address.url, "/v1/projects", "POST", HUMAN_TOKEN, {
      name: "Checkout reliability",
      description: "Customer-facing recovery work.",
    });
    const project = (await projectResponse.json() as { project: { projectId: string } }).project;
    const body = {
      originalRequest: "Investigate and improve checkout reliability.",
      projectTarget: { mode: "explicit", projectId: project.projectId },
    };
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
        planningTaskId: string | null;
        version: number;
        endedAt: string | null;
        archivedAt: string | null;
      };
    }).workItem;
    assert.equal(created.originalRequest, body.originalRequest);
    assert.equal(created.priority, "normal");
    assert.deepEqual(created.projectTarget, body.projectTarget);
    assert.equal(created.resolvedProjectId, project.projectId);
    assert.equal(created.state, "planning");
    assert.equal(created.currentStage, "planning");
    assert.ok(created.planningTaskId);
    assert.equal(created.version, 2);
    assert.equal(created.endedAt, null);
    assert.equal(created.archivedAt, null);

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
    const projectBoardResponse = await request(
      address.url,
      `/v1/projects/${project.projectId}/board`,
      "GET",
      HUMAN_TOKEN,
    );
    assert.equal(projectBoardResponse.status, 200);
    const projectBoard = await projectBoardResponse.json() as {
      agents: Array<{ agentId: string; role: string }>;
      tasks: Array<{ taskId: string; assignedAgentId: string | null; assignedRole: string | null }>;
    };
    const managers = projectBoard.agents.filter((agent) => agent.role === "manager");
    assert.equal(managers.length, 1);
    assert.equal(managers[0]?.agentId, "checkout-reliability-manager");
    assert.equal(managers[0]?.role, "manager");
    const planningTask = projectBoard.tasks.find((task) => task.taskId === created.planningTaskId);
    assert.equal(planningTask?.assignedAgentId, managers[0]?.agentId);
    assert.equal(planningTask?.assignedRole, "manager");
    assert.equal((await request(
      address.url,
      "/v1/work-items",
      "POST",
      HUMAN_TOKEN,
      { originalRequest: "A different request.", projectTarget: body.projectTarget },
      "http-work-item-create-0001",
    )).status, 409);

    const updateResponse = await request(address.url, `/v1/work-items/${created.workItemId}`, "PATCH", HUMAN_TOKEN, {
      version: created.version,
      priority: "high",
    });
    assert.equal(updateResponse.status, 200);
    const updated = (await updateResponse.json() as {
      workItem: { version: number; priority: string; projectTarget: unknown; resolvedProjectId: string | null };
    }).workItem;
    assert.equal(updated.version, 3);
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

    const prematureArchive = await request(address.url, `/v1/work-items/${created.workItemId}`, "PATCH", HUMAN_TOKEN, {
      version: updated.version,
      action: "archive",
    });
    assert.equal(prematureArchive.status, 409);
    assert.deepEqual(await prematureArchive.json(), {
      error: { code: "WORK_ITEM_NOT_TERMINAL", message: "Only terminal work items can be archived" },
    });

    const cancelRequest = {
      version: updated.version,
      action: "cancel",
      reason: "The operator no longer needs this intake.",
    };
    const cancelledResponse = await request(
      address.url,
      `/v1/work-items/${created.workItemId}`,
      "PATCH",
      HUMAN_TOKEN,
      cancelRequest,
    );
    assert.equal(cancelledResponse.status, 200);
    const cancelled = (await cancelledResponse.json() as {
      workItem: {
        state: string;
        version: number;
        endedAt: string | null;
        cancelledReason: string | null;
        archivedAt: string | null;
      };
    }).workItem;
    assert.equal(cancelled.state, "abandoned");
    assert.equal(cancelled.version, 4);
    assert.ok(cancelled.endedAt);
    assert.equal(cancelled.cancelledReason, cancelRequest.reason);
    assert.equal(cancelled.archivedAt, null);
    const cancelAction = gateActions(service.config.dbPath, created.workItemId).find((action) => action.gate === "cancel");
    assert.ok(cancelAction);
    assert.match(cancelAction.gateActionId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual({ ...cancelAction, gateActionId: undefined }, {
      gateActionId: undefined,
      workItemId: created.workItemId,
      gate: "cancel",
      actorId: "human:alice",
      planRevisionId: null,
      verifiedSha: null,
      mergeSha: null,
      refId: null,
      note: cancelRequest.reason,
      createdAt: cancelled.endedAt,
    });

    const cancelReplay = await request(
      address.url,
      `/v1/work-items/${created.workItemId}`,
      "PATCH",
      HUMAN_TOKEN,
      cancelRequest,
    );
    assert.equal(cancelReplay.status, 200);
    assert.deepEqual((await cancelReplay.json() as { workItem: unknown }).workItem, cancelled);
    assert.equal((await request(
      address.url,
      `/v1/work-items/${created.workItemId}`,
      "PATCH",
      HUMAN_TOKEN,
      { ...cancelRequest, reason: "A different reason cannot replay the cancellation." },
    )).status, 409);
    assert.equal((await request(
      address.url,
      `/v1/work-items/${created.workItemId}`,
      "PATCH",
      HUMAN_TOKEN,
      { ...cancelRequest, version: cancelled.version },
    )).status, 409);

    const listed = await request(address.url, "/v1/work-items", "GET", HUMAN_TOKEN);
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as { workItems: Array<{ workItemId: string }>; nextCursor?: string };
    assert.deepEqual(
      listedBody.workItems.map((item) => item.workItemId),
      [created.workItemId],
    );
    assert.equal(listedBody.nextCursor, undefined);

    const archiveRequest = { version: cancelled.version, action: "archive" };
    const archiveResponse = await request(
      address.url,
      `/v1/work-items/${created.workItemId}`,
      "PATCH",
      HUMAN_TOKEN,
      archiveRequest,
    );
    assert.equal(archiveResponse.status, 200);
    const archived = (await archiveResponse.json() as {
      workItem: { version: number; archivedAt: string | null };
    }).workItem;
    assert.equal(archived.version, 5);
    assert.ok(archived.archivedAt);
    const archiveReplay = await request(
      address.url,
      `/v1/work-items/${created.workItemId}`,
      "PATCH",
      HUMAN_TOKEN,
      archiveRequest,
    );
    assert.equal(archiveReplay.status, 200);
    assert.deepEqual((await archiveReplay.json() as { workItem: unknown }).workItem, archived);

    const defaultAfterArchive = await request(address.url, "/v1/work-items", "GET", HUMAN_TOKEN);
    assert.deepEqual((await defaultAfterArchive.json() as { workItems: unknown[] }).workItems, []);
    const withArchived = await request(address.url, "/v1/work-items?includeArchived=1", "GET", HUMAN_TOKEN);
    const archivedItems = (await withArchived.json() as {
      workItems: Array<{ workItemId: string; archivedAt: string | null }>;
    }).workItems;
    assert.equal(archivedItems.length, 1);
    assert.equal(archivedItems[0]?.workItemId, created.workItemId);
    assert.equal(archivedItems[0]?.archivedAt, archived.archivedAt);
    const fetched = await request(address.url, `/v1/work-items/${created.workItemId}`, "GET", HUMAN_TOKEN);
    assert.equal(fetched.status, 200);
    assert.equal((await fetched.json() as { workItem: { version: number } }).workItem.version, 5);
    assert.equal((await request(address.url, "/v1/work-items/missing", "GET", HUMAN_TOKEN)).status, 404);
    assert.equal((await request(address.url, "/v1/work-items", "GET", AGENT_ONE_TOKEN)).status, 401);
  } finally {
    await service.close();
  }
});

test("work-item detail exposes ordered creation and state-transition history", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const seeded = fixture.board.createWorkItem(workItemRequest({
    originalRequest: "Expose work-item transition history through the detail route.",
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), "http-work-item-transition-detail-0001").workItem;
  assert.equal(seeded.state, "queued");
  fixture.board.close();

  const service = await createTaskBoardService({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    corsOrigins: ["https://app.cicada.build"],
    now: () => new Date("2026-07-20T20:00:00.000Z"),
  });
  const address = await service.start();
  try {
    type Transition = Readonly<{
      fromState: string | null;
      toState: string;
      actorType: string;
      actorId: string;
      createdAt: string;
    }>;
    type Detail = Readonly<{
      state: string;
      version: number;
      transitions: Transition[];
    }>;
    const initialTransition: Transition = {
      fromState: null,
      toState: "queued",
      actorType: "human",
      actorId: "human:alice",
      createdAt: seeded.createdAt,
    };

    const initialResponse = await request(
      address.url,
      `/v1/work-items/${seeded.workItemId}`,
      "GET",
      HUMAN_TOKEN,
    );
    assert.equal(initialResponse.status, 200);
    const initial = (await initialResponse.json() as { workItem: Detail }).workItem;
    assert.equal(initial.state, "queued");
    assert.deepEqual(initial.transitions, [initialTransition]);

    const cancellationReason = "The transition-envelope assertion has completed.";
    const cancelledResponse = await request(
      address.url,
      `/v1/work-items/${seeded.workItemId}`,
      "PATCH",
      HUMAN_TOKEN,
      { version: initial.version, action: "cancel", reason: cancellationReason },
    );
    assert.equal(cancelledResponse.status, 200);

    const transitionedResponse = await request(
      address.url,
      `/v1/work-items/${seeded.workItemId}`,
      "GET",
      HUMAN_TOKEN,
    );
    assert.equal(transitionedResponse.status, 200);
    const transitioned = (await transitionedResponse.json() as { workItem: Detail }).workItem;
    assert.equal(transitioned.state, "abandoned");
    assert.deepEqual(transitioned.transitions, [initialTransition, {
      fromState: "queued",
      toState: "abandoned",
      actorType: "human",
      actorId: "human:alice",
      createdAt: "2026-07-20T20:00:00.000Z",
    }]);
  } finally {
    await service.close();
  }
});

test("plan confirmation rejects null and non-exact request bodies with field-specific errors", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const workItem = fixture.board.createWorkItem(workItemRequest({
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), "http-confirm-validation-0001").workItem;
  const children = [{
    key: "http-provider",
    objective: "Keep the provider declaration visible over HTTP.",
    projectId: fixture.project.projectId,
    declaredScope: ["src/provider"],
    acceptanceCriteria: ["The provider declaration round-trips."],
  }, {
    key: "http-consumer",
    objective: "Keep the consumer declaration visible over HTTP.",
    projectId: fixture.project.projectId,
    declaredScope: ["src/consumer"],
    acceptanceCriteria: ["The consumer declaration round-trips."],
    dependsOn: ["http-provider"],
  }];
  const proposed = fixture.board.proposeWorkflow({
    workItemId: workItem.workItemId,
    projectId: fixture.project.projectId,
    objective: "Validate the plan confirmation request at the HTTP boundary.",
    assumptions: [],
    acceptanceCriteria: ["Invalid request bodies return structured client errors."],
    changeShape: "feature",
    children,
    skillIds: [],
    nodes: [{
      nodeId: "http-confirm-validation",
      title: "Validate confirmation",
      objective: "Reject malformed confirmation bodies.",
      acceptanceCriteria: ["The workflow remains proposed."],
      dependencyNodeIds: [],
      stageTemplate: ["verification"],
    }],
  });
  const planRevisionId = proposed.plans[0]!.planRevisionId;
  fixture.board.close();

  const service = await createTaskBoardService({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    corsOrigins: ["https://app.cicada.build"],
    now: () => new Date("2026-07-20T20:00:00.000Z"),
  });
  const address = await service.start();
  try {
    const workflowResponse = await request(
      address.url,
      `/v1/projects/${fixture.project.projectId}/workflow`,
      "GET",
      HUMAN_TOKEN,
    );
    assert.equal(workflowResponse.status, 200);
    const workflowBody = await workflowResponse.json() as {
      workflow: { plans: Array<{ planRevisionId: string; children?: unknown }> };
    };
    assert.deepEqual(
      workflowBody.workflow.plans.find((plan) => plan.planRevisionId === planRevisionId)?.children,
      children,
    );
    const cases = [
      { body: null, field: "Plan confirmation" },
      { body: {}, field: "expectedState" },
      { body: { expectedState: "proposed", unexpected: true }, field: "unexpected" },
      { body: { expectedState: 7 }, field: "expectedState" },
    ];
    for (const item of cases) {
      const response = await request(
        address.url,
        `/v1/plans/${planRevisionId}/confirm`,
        "POST",
        HUMAN_TOKEN,
        item.body,
      );
      assert.equal(response.status, 400);
      const failure = await response.json() as { error: { code: string; message: string } };
      assert.equal(failure.error.code, "INVALID_REQUEST");
      assert.match(failure.error.message, new RegExp(item.field, "u"));
    }
  } finally {
    await service.close();
  }
});

test("encoded agent route identifiers claim runs and malformed encoding is rejected", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    corsOrigins: ["https://app.cicada.build"],
    now: () => new Date("2026-07-20T20:00:00.000Z"),
  });
  const address = await service.start();
  const agentId = "bot@host";
  try {
    const projectResponse = await request(address.url, "/v1/projects", "POST", HUMAN_TOKEN, {
      name: "Encoded route identifiers",
      description: "Exercise encoded worker route parameters.",
    });
    assert.equal(projectResponse.status, 201);
    const projectId = (await projectResponse.json() as { project: { projectId: string } }).project.projectId;
    assert.equal((await request(address.url, `/v1/projects/${projectId}/agents`, "POST", HUMAN_TOKEN, {
      agentId,
      role: "engineer",
      area: "http-routing",
      mission: "Claim work through an encoded route identifier.",
      model: "codex-mini",
      token: AGENT_ONE_TOKEN,
    })).status, 201);
    assert.equal((await request(address.url, `/v1/projects/${projectId}/tasks`, "POST", HUMAN_TOKEN, taskRequest({
      assignedAgentId: agentId,
      assignedRole: "engineer",
    }))).status, 201);

    const malformed = await request(
      address.url,
      "/v1/agents/%GZ/runs/claim?waitMs=0",
      "POST",
      AGENT_ONE_TOKEN,
      { claimId: "http-malformed-agent-route-0001", messageCursor: null },
    );
    assert.equal(malformed.status, 400);
    assert.equal(
      (await malformed.json() as { error: { code: string } }).error.code,
      "INVALID_IDENTIFIER",
    );

    const claimResponse = await request(
      address.url,
      `/v1/agents/${encodeURIComponent(agentId)}/runs/claim?waitMs=0`,
      "POST",
      AGENT_ONE_TOKEN,
      { claimId: "http-encoded-agent-claim-0001", messageCursor: null },
    );
    assert.equal(claimResponse.status, 201);
    const claim = await claimResponse.json() as { run: { agentId: string }; task: { assignedAgentId: string } };
    assert.equal(claim.run.agentId, agentId);
    assert.equal(claim.task.assignedAgentId, agentId);
  } finally {
    await service.close();
  }
});

test("human token rotation is versioned, one-time, and immediately invalidates the old worker token", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    corsOrigins: ["https://app.cicada.build"],
    now: () => new Date("2026-08-09T20:00:00.000Z"),
  });
  const address = await service.start();
  try {
    const projectResponse = await request(address.url, "/v1/projects", "POST", HUMAN_TOKEN, {
      name: "Rotation tools",
      description: "/workspace/rotation-tools",
    });
    const projectId = (await projectResponse.json() as { project: { projectId: string } }).project.projectId;
    const createdResponse = await request(address.url, `/v1/projects/${projectId}/agents`, "POST", HUMAN_TOKEN, {
      agentId: "rotation-engineer",
      role: "engineer",
      area: "Rotation tools",
      mission: "Exercise worker token rotation.",
      model: "codex-mini",
      token: AGENT_ONE_TOKEN,
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json() as { agent: { version: number } }).agent;
    assert.equal(created.version, 1);

    const immediateWorkerRoute = "/v1/agents/rotation-engineer/runs/claim?waitMs=0";
    assert.equal((await request(address.url, immediateWorkerRoute, "POST", AGENT_ONE_TOKEN, {
      claimId: "rotation-old-token-before-0001",
      messageCursor: null,
    })).status, 204);
    assert.equal((await request(address.url, "/v1/agents/rotation-engineer/rotate-token", "POST", AGENT_ONE_TOKEN, {
      version: created.version,
    })).status, 401);
    for (const invalid of [null, {}, { version: 0 }, { version: 1, extra: true }]) {
      assert.equal((await request(
        address.url,
        "/v1/agents/rotation-engineer/rotate-token",
        "POST",
        HUMAN_TOKEN,
        invalid,
      )).status, 400);
    }

    const heldClaim = request(
      address.url,
      "/v1/agents/rotation-engineer/runs/claim?waitMs=30000",
      "POST",
      AGENT_ONE_TOKEN,
      { claimId: "rotation-held-old-token-0001", messageCursor: null },
    );
    await waitForWorkerConnection(address.url, projectId, "rotation-engineer", "waiting_for_wake");

    const rotatedResponse = await request(
      address.url,
      "/v1/agents/rotation-engineer/rotate-token",
      "POST",
      HUMAN_TOKEN,
      { version: created.version },
    );
    assert.equal(rotatedResponse.status, 200);
    const rotatedEnvelope = await rotatedResponse.json() as {
      agent: { agentId: string; version: number; token?: string };
      token: string;
    };
    assert.deepEqual(Object.keys(rotatedEnvelope).sort(), ["agent", "token"]);
    assert.equal(rotatedEnvelope.agent.agentId, "rotation-engineer");
    assert.equal(rotatedEnvelope.agent.version, 2);
    assert.equal("token" in rotatedEnvelope.agent, false);
    assert.ok(rotatedEnvelope.token.length >= 32);
    assert.notEqual(rotatedEnvelope.token, AGENT_ONE_TOKEN);

    const taskResponse = await request(address.url, `/v1/projects/${projectId}/tasks`, "POST", HUMAN_TOKEN, taskRequest({
      title: "Queue work after rotation",
      assignedAgentId: "rotation-engineer",
      assignedRole: "engineer",
    }));
    assert.equal(taskResponse.status, 201);
    const taskId = (await taskResponse.json() as { task: { taskId: string } }).task.taskId;
    const oldHeldResponse = await heldClaim;
    assert.equal(oldHeldResponse.status, 401);
    assert.deepEqual(await oldHeldResponse.json(), {
      error: { code: "UNAUTHORIZED", message: "Agent authentication is required" },
    });
    const beforeNewClaim = await request(address.url, `/v1/projects/${projectId}/board`, "GET", HUMAN_TOKEN);
    const beforeNewClaimBoard = await beforeNewClaim.json() as {
      tasks: Array<{ taskId: string; status: string }>;
      recentRuns: unknown[];
    };
    assert.equal(beforeNewClaimBoard.recentRuns.length, 0);
    assert.equal(beforeNewClaimBoard.tasks.find((task) => task.taskId === taskId)?.status, "queued");

    assert.equal((await request(address.url, immediateWorkerRoute, "POST", AGENT_ONE_TOKEN, {
      claimId: "rotation-old-token-after-0001",
      messageCursor: null,
    })).status, 401);
    const newClaimResponse = await request(address.url, immediateWorkerRoute, "POST", rotatedEnvelope.token, {
      claimId: "rotation-new-token-after-0001",
      messageCursor: null,
    });
    assert.equal(newClaimResponse.status, 201);
    assert.equal((await newClaimResponse.json() as { task: { taskId: string } }).task.taskId, taskId);
    const stale = await request(
      address.url,
      "/v1/agents/rotation-engineer/rotate-token",
      "POST",
      HUMAN_TOKEN,
      { version: created.version },
    );
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { error: { code: string } }).error.code, "AGENT_VERSION_CONFLICT");

    const snapshot = await request(address.url, `/v1/projects/${projectId}/board`, "GET", HUMAN_TOKEN);
    const snapshotAgent = (await snapshot.json() as { agents: Array<Record<string, unknown>> }).agents[0]!;
    assert.equal("token" in snapshotAgent, false);
    assert.equal("tokenHash" in snapshotAgent, false);
  } finally {
    await service.close();
  }
});

test("lane-error is worker-token authenticated, exact, scrubbed, bounded, and clearable", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    corsOrigins: ["https://app.cicada.build"],
    now: () => new Date("2026-08-09T20:00:00.000Z"),
  });
  const address = await service.start();
  try {
    const projectResponse = await request(address.url, "/v1/projects", "POST", HUMAN_TOKEN, {
      name: "Fleet lane health",
      description: "Surface durable fleet failures to operators.",
    });
    assert.equal(projectResponse.status, 201);
    const projectId = (await projectResponse.json() as { project: { projectId: string } }).project.projectId;
    assert.equal((await request(address.url, `/v1/projects/${projectId}/agents`, "POST", HUMAN_TOKEN, {
      agentId: "engineer-one",
      role: "engineer",
      area: "fleet-runtime",
      mission: "Keep the task lane recoverable.",
      model: "codex-mini",
      token: AGENT_ONE_TOKEN,
    })).status, 201);
    assert.equal((await request(address.url, `/v1/projects/${projectId}/agents`, "POST", HUMAN_TOKEN, {
      agentId: "manager-one",
      role: "manager",
      area: "fleet-runtime",
      mission: "Keep the manager lane recoverable.",
      model: "claude-haiku",
      token: AGENT_TWO_TOKEN,
    })).status, 201);

    const route = "/v1/agents/engineer-one/lane-error";
    assert.equal((await request(address.url, route, "POST", HUMAN_TOKEN, { detail: "not an agent" })).status, 401);
    assert.equal((await request(address.url, route, "POST", AGENT_TWO_TOKEN, { detail: "wrong agent" })).status, 401);
    for (const invalid of [null, {}, { detail: 7 }, { detail: "" }, { detail: null, extra: true }]) {
      assert.equal((await request(address.url, route, "POST", AGENT_ONE_TOKEN, invalid)).status, 400);
    }
    assert.equal((await request(
      address.url,
      route,
      "POST",
      AGENT_ONE_TOKEN,
      { detail: "x".repeat(2_001) },
    )).status, 400);

    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    assert.equal((await request(
      address.url,
      route,
      "POST",
      AGENT_ONE_TOKEN,
      { detail: `Board rejected Bearer ${secret}` },
    )).status, 204);
    const failedBoard = await request(address.url, `/v1/projects/${projectId}/board`, "GET", HUMAN_TOKEN);
    assert.equal(failedBoard.status, 200);
    const failedAgent = (await failedBoard.json() as { agents: Array<{ agentId: string; lastError: string | null }> })
      .agents.find((agent) => agent.agentId === "engineer-one");
    assert.equal(failedAgent?.lastError, "Board rejected [redacted:bearer]");

    assert.equal((await request(address.url, route, "POST", AGENT_ONE_TOKEN, { detail: null })).status, 204);
    const clearedBoard = await request(address.url, `/v1/projects/${projectId}/board`, "GET", HUMAN_TOKEN);
    const clearedAgent = (await clearedBoard.json() as { agents: Array<{ agentId: string; lastError: string | null }> })
      .agents.find((agent) => agent.agentId === "engineer-one");
    assert.equal(clearedAgent?.lastError, null);
  } finally {
    await service.close();
  }
});

test("work-item HTTP keyset continuation is exhaustive and rejects non-canonical queries", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  for (let index = 0; index < 201; index += 1) {
    fixture.board.createWorkItem(
      {
        originalRequest: `HTTP paginated work item ${index}`,
        projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
      },
      `http-pagination-${index}`,
    );
  }
  fixture.board.close();

  const service = await createTaskBoardService({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
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
    assert.equal((await request(address.url, "/v1/work-items?includeArchived=0", "GET", HUMAN_TOKEN)).status, 400);
    assert.equal((await request(address.url, "/v1/work-items?includeArchived=1&includeArchived=1", "GET", HUMAN_TOKEN)).status, 400);
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
      {
        claimId: "http-claim-after-assignment-0001",
        messageCursor: null,
        pinned: {
          runtime: "node",
          runtimeVersion: "22.18.0",
          model: "gpt-5",
          promptsSha: "http-prompt-bundle-sha",
        },
      },
    );
    assert.equal(claimResponse.status, 201);
    const claim = await claimResponse.json() as {
      run: {
        runId: string;
        taskId: string | null;
        heartbeatAt: string | null;
        runtime: string | null;
        runtimeVersion: string | null;
        model: string | null;
        promptsSha: string | null;
      };
      wakeup: { reason: string };
      task: { status: string; version: number; startedAt: string | null };
      context: { acceptanceCriteria: string; agent: { role: string } };
    };
    assert.equal(claim.wakeup.reason, "human_assignment");
    assert.equal(claim.run.taskId, task.taskId);
    assert.deepEqual(
      {
        heartbeatAt: claim.run.heartbeatAt,
        runtime: claim.run.runtime,
        runtimeVersion: claim.run.runtimeVersion,
        model: claim.run.model,
        promptsSha: claim.run.promptsSha,
      },
      {
        heartbeatAt: null,
        runtime: "node",
        runtimeVersion: "22.18.0",
        model: "gpt-5",
        promptsSha: "http-prompt-bundle-sha",
      },
    );
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
    const failedBoardResponse = await request(
      address.url,
      `/v1/projects/${project.projectId}/board`,
      "GET",
      HUMAN_TOKEN,
    );
    const failedTask = (await failedBoardResponse.json() as {
      tasks: Array<{ taskId: string; version: number }>;
    }).tasks.find((candidate) => candidate.taskId === task.taskId)!;

    const heldClaim = request(
      address.url,
      "/v1/agents/engineer-one/runs/claim?waitMs=1000",
      "POST",
      AGENT_ONE_TOKEN,
      { claimId: "http-held-claim-0001", messageCursor: null },
    );
    const resume = await request(
      address.url,
      `/v1/tasks/${task.taskId}/retry`,
      "POST",
      HUMAN_TOKEN,
      { version: failedTask.version },
    );
    assert.equal(resume.status, 200);
    const heldClaimResponse = await heldClaim;
    assert.equal(heldClaimResponse.status, 201);
    const heldClaimBody = await heldClaimResponse.json() as {
      run: { runId: string; taskId: string | null };
      wakeup: { reason: string };
    };
    assert.equal(heldClaimBody.wakeup.reason, "resumed");
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

test("task recovery routes retry, reassign, and backlog recoverable work", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
  });
  const address = await service.start();
  try {
    const projectResponse = await request(address.url, "/v1/projects", "POST", HUMAN_TOKEN, {
      name: "HTTP task recovery",
      description: "Exercise human recovery transitions through the service boundary.",
    });
    const projectId = (await projectResponse.json() as { project: { projectId: string } }).project.projectId;
    for (const agent of [
      { agentId: "engineer-one", token: AGENT_ONE_TOKEN },
      { agentId: "engineer-two", token: AGENT_TWO_TOKEN },
    ]) {
      assert.equal((await request(address.url, `/v1/projects/${projectId}/agents`, "POST", HUMAN_TOKEN, {
        agentId: agent.agentId,
        role: "engineer",
        area: "http-recovery",
        mission: "Recover explicitly assigned checkout work.",
        model: "codex-mini",
        token: agent.token,
      })).status, 201);
    }
    const taskResponse = await request(address.url, `/v1/projects/${projectId}/tasks`, "POST", HUMAN_TOKEN, taskRequest({
      title: "Recover a task through HTTP",
      assignedAgentId: "engineer-one",
      assignedRole: "engineer",
      requiresReview: false,
    }));
    const taskId = (await taskResponse.json() as { task: { taskId: string } }).task.taskId;
    const firstClaimResponse = await request(
      address.url,
      "/v1/agents/engineer-one/runs/claim?waitMs=0",
      "POST",
      AGENT_ONE_TOKEN,
      { claimId: "http-recovery-first-claim-0001", messageCursor: null },
    );
    const firstRunId = (await firstClaimResponse.json() as { run: { runId: string } }).run.runId;
    assert.equal((await request(address.url, `/v1/runs/${firstRunId}/settle`, "POST", AGENT_ONE_TOKEN, {
      outcome: "failed",
      result: "The first HTTP recovery pass failed.",
    })).status, 200);

    const failedBoard = await request(address.url, `/v1/projects/${projectId}/board`, "GET", HUMAN_TOKEN);
    const failedTask = (await failedBoard.json() as { tasks: Array<{ taskId: string; status: string }> })
      .tasks.find((candidate) => candidate.taskId === taskId)!;
    assert.equal(failedTask.status, "failed");
    const resumeBody = {
      reason: "Retry failed work through the existing Resume affordance.",
      taskId,
    };
    const resumeResponse = await request(
      address.url,
      "/v1/agents/engineer-one/resume",
      "POST",
      HUMAN_TOKEN,
      resumeBody,
      "http-resume-failed-compat-0001",
    );
    assert.equal(resumeResponse.status, 201);
    const resumed = await resumeResponse.json() as { wakeup: { wakeupId: string; reason: string } };
    assert.equal(resumed.wakeup.reason, "resumed");
    const resumeReplay = await request(
      address.url,
      "/v1/agents/engineer-one/resume",
      "POST",
      HUMAN_TOKEN,
      resumeBody,
      "http-resume-failed-compat-0001",
    );
    assert.equal(resumeReplay.status, 200);
    assert.equal((await resumeReplay.json() as { wakeup: { wakeupId: string } }).wakeup.wakeupId, resumed.wakeup.wakeupId);
    const resumedBoard = await request(address.url, `/v1/projects/${projectId}/board`, "GET", HUMAN_TOKEN);
    const resumedTask = (await resumedBoard.json() as { tasks: Array<{ taskId: string; status: string }> })
      .tasks.find((candidate) => candidate.taskId === taskId)!;
    assert.equal(resumedTask.status, "queued");

    const retryClaimResponse = await request(
      address.url,
      "/v1/agents/engineer-one/runs/claim?waitMs=0",
      "POST",
      AGENT_ONE_TOKEN,
      { claimId: "http-recovery-retry-claim-0001", messageCursor: null },
    );
    const retryRunId = (await retryClaimResponse.json() as { run: { runId: string } }).run.runId;
    assert.equal((await request(address.url, `/v1/runs/${retryRunId}/settle`, "POST", AGENT_ONE_TOKEN, {
      outcome: "interrupted",
      result: "The retried HTTP run was interrupted.",
    })).status, 200);

    const interruptedBoard = await request(address.url, `/v1/projects/${projectId}/board`, "GET", HUMAN_TOKEN);
    const interruptedTask = (await interruptedBoard.json() as { tasks: Array<{ taskId: string; status: string; version: number }> })
      .tasks.find((candidate) => candidate.taskId === taskId)!;
    assert.equal(interruptedTask.status, "interrupted");
    const reassignResponse = await request(address.url, `/v1/tasks/${taskId}`, "PATCH", HUMAN_TOKEN, {
      version: interruptedTask.version,
      assignedAgentId: "engineer-two",
      assignedRole: "engineer",
    });
    assert.equal(reassignResponse.status, 200);
    const reassigned = (await reassignResponse.json() as { task: { status: string; version: number } }).task;
    assert.equal(reassigned.status, "queued");
    assert.equal((await request(
      address.url,
      "/v1/agents/engineer-one/runs/claim?waitMs=0",
      "POST",
      AGENT_ONE_TOKEN,
      { claimId: "http-recovery-old-agent-claim-0001", messageCursor: null },
    )).status, 204);
    const replacementClaimResponse = await request(
      address.url,
      "/v1/agents/engineer-two/runs/claim?waitMs=0",
      "POST",
      AGENT_TWO_TOKEN,
      { claimId: "http-recovery-new-agent-claim-0001", messageCursor: null },
    );
    assert.equal(replacementClaimResponse.status, 201);
    const replacementClaim = await replacementClaimResponse.json() as {
      run: { runId: string };
      wakeup: { reason: string };
      task: { version: number };
    };
    assert.equal(replacementClaim.wakeup.reason, "assigned");
    assert.equal((await request(address.url, `/v1/runs/${replacementClaim.run.runId}/settle`, "POST", AGENT_TWO_TOKEN, {
      outcome: "failed",
      result: "Return the recovered task to the backlog for later triage.",
    })).status, 200);

    const secondFailedBoard = await request(address.url, `/v1/projects/${projectId}/board`, "GET", HUMAN_TOKEN);
    const secondFailed = (await secondFailedBoard.json() as { tasks: Array<{ taskId: string; version: number }> })
      .tasks.find((candidate) => candidate.taskId === taskId)!;
    const backlogResponse = await request(address.url, `/v1/tasks/${taskId}/backlog`, "POST", HUMAN_TOKEN, {
      version: secondFailed.version,
    });
    assert.equal(backlogResponse.status, 200);
    const backlogged = (await backlogResponse.json() as {
      task: { status: string; assignedAgentId: string | null };
    }).task;
    assert.equal(backlogged.status, "backlog");
    assert.equal(backlogged.assignedAgentId, null);
  } finally {
    await service.close();
  }
});

test("new task recovery routes reject malformed request bodies", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
  });
  const address = await service.start();
  try {
    for (const route of ["retry", "backlog"]) {
      for (const body of [null, {}, { version: 1, unexpected: true }, { version: "1" }]) {
        const response = await request(
          address.url,
          `/v1/tasks/malformed-recovery-task/${route}`,
          "POST",
          HUMAN_TOKEN,
          body,
        );
        assert.equal(response.status, 400);
        assert.equal((await response.json() as { error: { code: string } }).error.code, "INVALID_REQUEST");
      }
    }
  } finally {
    await service.close();
  }
});

test("held HTTP worker requests expose transient connections and service close releases them", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
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

test("document routes are retired", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    now: () => new Date("2026-07-19T20:00:00.000Z"),
  });
  const address = await service.start();
  try {
    const response = await request(address.url, "/v1/documents/x", "GET", HUMAN_TOKEN);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: "NOT_FOUND", message: "Endpoint was not found" },
    });
  } finally {
    await service.close();
  }
});
