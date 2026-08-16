import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  TaskBoard,
  TaskBoardError,
  createTaskBoardService,
  normalizeTaskBoardConfig,
} from "#server/task-board";
import {
  AGENT_ONE_TOKEN,
  AGENT_TWO_TOKEN,
  HUMAN_TOKEN,
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  databasePath,
  taskRequest,
  workItemRequest,
} from "./helpers.js";

function errorIs(status: number, code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof TaskBoardError && error.status === status && error.code === code;
}

function taskBoardConfig(
  path: string,
  now: () => Date,
  overrides: { heartbeatTimeoutSeconds?: number; reconcileIntervalSeconds?: number } = {},
) {
  return normalizeTaskBoardConfig({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    now,
    ...overrides,
  });
}

function runRow(path: string, runId: string): Record<string, unknown> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT * FROM runs WHERE run_id=?").get(runId);
    assert.ok(row);
    return { ...row };
  } finally {
    db.close();
  }
}

function backdateRun(path: string, runId: string, startedAt: string): void {
  const db = new DatabaseSync(path);
  try {
    assert.equal(Number(db.prepare(
      "UPDATE runs SET started_at=?,heartbeat_at=NULL WHERE run_id=? AND status='active'",
    ).run(startedAt, runId).changes), 1);
  } finally {
    db.close();
  }
}

function eventCount(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(db.prepare("SELECT COUNT(*) AS count FROM task_events").get()?.count);
  } finally {
    db.close();
  }
}

async function request(
  origin: string,
  path: string,
  method: "GET" | "POST" | "PATCH",
  token: string,
  body?: unknown,
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

async function stageWorkItemForWorkflow(path: string, workItemId: string): Promise<void> {
  const db = new DatabaseSync(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT version FROM work_items WHERE work_item_id=? AND state='queued'").get(workItemId);
    assert.ok(row);
    const now = "2026-08-16T12:00:00.000Z";
    assert.equal(Number(db.prepare(`
      UPDATE work_items
      SET state='planning',current_stage='planning',version=version+1,updated_at=?
      WHERE work_item_id=? AND state='queued' AND version=?
    `).run(now, workItemId, Number(row.version)).changes), 1);
    db.prepare(`
      INSERT INTO work_item_transitions(
        work_item_id,sequence,from_state,to_state,actor_type,actor_id,created_at
      ) VALUES (?,2,'queued','planning','system','system:heartbeat-test',?)
    `).run(workItemId, now);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the setup failure.
    }
    throw error;
  } finally {
    db.close();
  }
}

test("heartbeat configuration defaults, disables at zero, and stays above two worker intervals", async () => {
  const path = await databasePath();
  const defaults = taskBoardConfig(path, () => new Date("2026-08-16T12:00:00.000Z"));
  assert.equal(defaults.heartbeatTimeoutSeconds, 300);
  assert.equal(defaults.reconcileIntervalSeconds, 60);

  const disabled = taskBoardConfig(path, () => new Date("2026-08-16T12:00:00.000Z"), {
    heartbeatTimeoutSeconds: 0,
    reconcileIntervalSeconds: 0,
  });
  assert.equal(disabled.heartbeatTimeoutSeconds, 0);
  assert.equal(disabled.reconcileIntervalSeconds, 0);

  assert.throws(
    () => taskBoardConfig(path, () => new Date("2026-08-16T12:00:00.000Z"), {
      heartbeatTimeoutSeconds: 59,
    }),
    errorIs(500, "INVALID_CONFIGURATION"),
  );
  assert.equal(taskBoardConfig(path, () => new Date("2026-08-16T12:00:00.000Z"), {
    heartbeatTimeoutSeconds: 60,
  }).heartbeatTimeoutSeconds, 60);

  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => taskBoardConfig(path, () => new Date("2026-08-16T12:00:00.000Z"), {
        heartbeatTimeoutSeconds: value,
      }),
      errorIs(500, "INVALID_CONFIGURATION"),
    );
    assert.throws(
      () => taskBoardConfig(path, () => new Date("2026-08-16T12:00:00.000Z"), {
        reconcileIntervalSeconds: value,
      }),
      errorIs(500, "INVALID_CONFIGURATION"),
    );
  }
});

test("heartbeat fences run ownership and credential version while changing only heartbeat_at", async () => {
  let now = new Date("2026-08-16T12:00:00.000Z");
  const fixture = await boardFixture(undefined, () => now);
  try {
    const task = fixture.board.createTask(fixture.project.projectId, taskRequest({ requiresReview: false }));
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "heartbeat-board-claim-0001",
      messageCursor: null,
    });
    assert.ok(claim);
    const engineerAuth = fixture.board.authenticateAgent(AGENT_ONE_TOKEN, fixture.engineer.agentId);
    const managerAuth = fixture.board.authenticateAgent(AGENT_TWO_TOKEN, fixture.manager.agentId);

    assert.throws(
      () => fixture.board.heartbeatRun("missing-heartbeat-run", engineerAuth),
      errorIs(404, "RUN_NOT_FOUND"),
    );
    assert.throws(
      () => fixture.board.heartbeatRun(claim.run.runId, managerAuth),
      errorIs(404, "RUN_NOT_FOUND"),
    );

    const before = runRow(fixture.path, claim.run.runId);
    const beforeTask = fixture.board.requireTask(task.taskId);
    const beforeEvents = eventCount(fixture.path);
    const firstHeartbeat = fixture.board.heartbeatRun(claim.run.runId, engineerAuth);
    assert.equal(firstHeartbeat.heartbeatAt, "2026-08-16T12:00:00.000Z");
    assert.equal(runRow(fixture.path, claim.run.runId).heartbeat_at, "2026-08-16T12:00:00.000Z");

    now = new Date("2026-08-16T12:00:30.000Z");
    const secondHeartbeat = fixture.board.heartbeatRun(claim.run.runId, engineerAuth);
    const after = runRow(fixture.path, claim.run.runId);
    assert.deepEqual(
      { ...after, heartbeat_at: before.heartbeat_at },
      before,
    );
    assert.equal(secondHeartbeat.heartbeatAt, "2026-08-16T12:00:30.000Z");
    assert.equal(after.heartbeat_at, "2026-08-16T12:00:30.000Z");
    assert.equal(fixture.board.requireTask(task.taskId).version, beforeTask.version);
    assert.equal(eventCount(fixture.path), beforeEvents);

    fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "interrupted",
      result: "Settled before the final heartbeat.",
    });
    assert.throws(
      () => fixture.board.heartbeatRun(claim.run.runId, engineerAuth),
      errorIs(409, "RUN_NOT_ACTIVE"),
    );

    const nextTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
      title: "Fence a stale heartbeat credential",
      requiresReview: false,
    }));
    const nextClaim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "heartbeat-stale-credential-0001",
      messageCursor: null,
    });
    assert.equal(nextClaim?.task?.taskId, nextTask.taskId);
    const db = new DatabaseSync(fixture.path);
    try {
      assert.equal(Number(db.prepare("UPDATE agents SET version=version+1 WHERE agent_id=?")
        .run(fixture.engineer.agentId).changes), 1);
    } finally {
      db.close();
    }
    assert.throws(
      () => fixture.board.heartbeatRun(nextClaim!.run.runId, engineerAuth),
      errorIs(401, "UNAUTHORIZED"),
    );
    assert.equal(runRow(fixture.path, nextClaim!.run.runId).heartbeat_at, null);
  } finally {
    fixture.board.close();
  }
});

test("heartbeat HTTP route mirrors settle authentication and returns the updated run envelope", async () => {
  const service = await createTaskBoardService({
    dbPath: await databasePath(),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    port: 0,
    heartbeatTimeoutSeconds: 300,
    reconcileIntervalSeconds: 0,
    now: () => new Date("2026-08-16T12:00:00.000Z"),
  });
  const address = await service.start();
  try {
    const projectResponse = await request(address.url, "/v1/projects", "POST", HUMAN_TOKEN, {
      name: "Heartbeat HTTP",
      description: "Exercise agent heartbeat authentication.",
    });
    assert.equal(projectResponse.status, 201);
    const projectId = (await projectResponse.json() as { project: { projectId: string } }).project.projectId;
    for (const agent of [
      {
        agentId: "heartbeat-http-engineer",
        role: "engineer",
        area: "heartbeat",
        mission: "Exercise the heartbeat route.",
        model: "codex-mini",
        token: AGENT_ONE_TOKEN,
      },
      {
        agentId: "heartbeat-http-manager",
        role: "manager",
        area: "heartbeat-review",
        mission: "Exercise wrong-run ownership.",
        model: "claude-haiku",
        token: AGENT_TWO_TOKEN,
      },
    ]) {
      assert.equal((await request(
        address.url,
        `/v1/projects/${projectId}/agents`,
        "POST",
        HUMAN_TOKEN,
        agent,
      )).status, 201);
    }
    const taskResponse = await request(address.url, `/v1/projects/${projectId}/tasks`, "POST", HUMAN_TOKEN, taskRequest({
      assignedAgentId: "heartbeat-http-engineer",
      requiresReview: false,
    }));
    assert.equal(taskResponse.status, 201);
    const claimResponse = await request(
      address.url,
      "/v1/agents/heartbeat-http-engineer/runs/claim?waitMs=0",
      "POST",
      AGENT_ONE_TOKEN,
      { claimId: "heartbeat-http-claim-0001", messageCursor: null },
    );
    assert.equal(claimResponse.status, 201);
    const runId = (await claimResponse.json() as { run: { runId: string } }).run.runId;

    assert.equal((await request(address.url, "/v1/runs/missing-heartbeat-run/heartbeat", "POST", AGENT_ONE_TOKEN)).status, 404);
    assert.equal((await request(address.url, `/v1/runs/${runId}/heartbeat`, "POST", AGENT_TWO_TOKEN)).status, 404);
    const heartbeat = await request(address.url, `/v1/runs/${runId}/heartbeat`, "POST", AGENT_ONE_TOKEN);
    assert.equal(heartbeat.status, 200);
    const heartbeatBody = await heartbeat.json() as { run: Record<string, unknown> };
    assert.deepEqual(
      {
        runId: heartbeatBody.run.runId,
        status: heartbeatBody.run.status,
        heartbeatAt: heartbeatBody.run.heartbeatAt,
        runtime: heartbeatBody.run.runtime,
        runtimeVersion: heartbeatBody.run.runtimeVersion,
        model: heartbeatBody.run.model,
        promptsSha: heartbeatBody.run.promptsSha,
      },
      {
        runId,
        status: "active",
        heartbeatAt: "2026-08-16T12:00:00.000Z",
        runtime: null,
        runtimeVersion: null,
        model: null,
        promptsSha: null,
      },
    );

    assert.equal((await request(address.url, `/v1/runs/${runId}/settle`, "POST", AGENT_ONE_TOKEN, {
      outcome: "interrupted",
      result: "Settle before retrying the heartbeat route.",
    })).status, 200);
    const settled = await request(address.url, `/v1/runs/${runId}/heartbeat`, "POST", AGENT_ONE_TOKEN);
    assert.equal(settled.status, 409);
    assert.equal((await settled.json() as { error: { code: string } }).error.code, "RUN_NOT_ACTIVE");
  } finally {
    await service.close();
  }
});

test("stale-run sweep interrupts stale runs, leaves recent heartbeats alive, and is idempotent", async () => {
  let now = new Date("2026-08-16T12:00:00.000Z");
  const path = await databasePath();
  const board = await TaskBoard.open(taskBoardConfig(path, () => now));
  try {
    const project = board.createProject({ name: "Sweep", description: "Exercise stale-run reconciliation." });
    const engineer = board.createAgent(project.projectId, {
      agentId: "sweep-engineer",
      role: "engineer",
      area: "sweep",
      mission: "Exercise stale-run settlement.",
      model: "codex-mini",
      token: AGENT_ONE_TOKEN,
    });
    const staleTask = board.createTask(project.projectId, taskRequest({
      title: "Interrupt stale work",
      assignedAgentId: engineer.agentId,
      requiresReview: false,
    }));
    const staleClaim = board.claimRun(engineer.agentId, {
      claimId: "stale-sweep-claim-0001",
      messageCursor: null,
    });
    assert.ok(staleClaim);
    backdateRun(path, staleClaim.run.runId, "2026-08-16T11:54:59.999Z");

    assert.equal(board.reconcileStaleRuns(), 1);
    const snapshot = board.snapshot(project.projectId);
    const staleRun = snapshot.recentRuns.find((run) => run.runId === staleClaim.run.runId);
    assert.equal(staleRun?.status, "interrupted");
    assert.equal(staleRun?.result, "run heartbeat lost");
    assert.equal(board.requireTask(staleTask.taskId).status, "interrupted");
    const replay = board.claimRun(engineer.agentId, {
      claimId: "stale-sweep-claim-0001",
      messageCursor: null,
    });
    assert.ok(replay);
    assert.equal(replay.run.status, "interrupted");
    assert.equal(replay.run.heartbeatAt, null);
    assert.equal(replay.run.endedAt, "2026-08-16T12:00:00.000Z");
    assert.equal(replay.run.result, "run heartbeat lost");
    assert.ok(snapshot.recentEvents.some((event) => event.taskId === staleTask.taskId
      && event.eventType === "agent_run_settled"
      && event.actorType === "system"));
    const afterFirstSweep = board.snapshot(project.projectId);
    assert.equal(board.reconcileStaleRuns(), 0);
    assert.deepEqual(board.snapshot(project.projectId), afterFirstSweep);

    const recentTask = board.createTask(project.projectId, taskRequest({
      title: "Keep recently heartbeating work active",
      assignedAgentId: engineer.agentId,
      requiresReview: false,
    }));
    const recentClaim = board.claimRun(engineer.agentId, {
      claimId: "recent-heartbeat-claim-0001",
      messageCursor: null,
    });
    assert.equal(recentClaim?.task?.taskId, recentTask.taskId);
    backdateRun(path, recentClaim!.run.runId, "2026-08-16T11:50:00.000Z");
    now = new Date("2026-08-16T12:01:00.000Z");
    board.heartbeatRun(recentClaim!.run.runId, board.authenticateAgent(AGENT_ONE_TOKEN, engineer.agentId));
    assert.equal(board.reconcileStaleRuns(), 0);
    assert.equal(board.snapshot(project.projectId).recentRuns.find((run) => run.runId === recentClaim!.run.runId)?.status, "active");
  } finally {
    board.close();
  }
});

test("timeout zero disables the sweep without touching stale state", async () => {
  const now = () => new Date("2026-08-16T12:00:00.000Z");
  const path = await databasePath();
  const board = await TaskBoard.open(taskBoardConfig(path, now, { heartbeatTimeoutSeconds: 0 }));
  try {
    const project = board.createProject({ name: "Disabled sweep", description: "Keep stale state untouched." });
    const engineer = board.createAgent(project.projectId, {
      agentId: "disabled-sweep-engineer",
      role: "engineer",
      area: "sweep",
      mission: "Remain active while the sweep is disabled.",
      model: "codex-mini",
      token: AGENT_ONE_TOKEN,
    });
    board.createTask(project.projectId, taskRequest({ assignedAgentId: engineer.agentId, requiresReview: false }));
    const claim = board.claimRun(engineer.agentId, { claimId: "disabled-sweep-claim-0001", messageCursor: null });
    assert.ok(claim);
    backdateRun(path, claim.run.runId, "2026-08-16T10:00:00.000Z");
    const before = board.snapshot(project.projectId);
    assert.equal(board.reconcileStaleRuns(), 0);
    assert.deepEqual(board.snapshot(project.projectId), before);
  } finally {
    board.close();
  }
});

test("sweeping a stale workflow run records the same workflow settlement effects as settle", async () => {
  const fixture = await boardFixture(undefined, () => new Date("2026-08-16T12:10:00.000Z"));
  try {
    const verifier = fixture.board.createAgent(fixture.project.projectId, {
      agentId: "heartbeat-sweep-verifier",
      role: "verifier",
      area: "workflow-sweep",
      mission: "Verify stale workflow settlement.",
      model: "codex-mini",
      token: "heartbeat-sweep-verifier-token-0123456789",
    });
    fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
      agentTypes: [{
        agentTypeId: "heartbeat-sweep-verifier",
        name: "Heartbeat sweep verifier",
        description: "Executes the stale workflow fixture.",
        role: "verifier",
        supplementalInstructions: "Exercise workflow settlement through the sweep.",
        skillIds: [],
        evaluatorProfile: "tests",
        enabled: true,
      }],
      stages: automationStages({
        verification: { kind: "agent_type", agentTypeId: "heartbeat-sweep-verifier" },
      }),
    }));
    const workItem = fixture.board.createWorkItem(workItemRequest({
      originalRequest: "Sweep a stale workflow run through normal settlement.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }), "heartbeat-workflow-sweep-0001").workItem;
    await stageWorkItemForWorkflow(fixture.path, workItem.workItemId);
    const proposed = fixture.board.proposeWorkflow({
      workItemId: workItem.workItemId,
      projectId: fixture.project.projectId,
      objective: "Exercise stale workflow settlement.",
      assumptions: [],
      acceptanceCriteria: ["The node receives an ordinary failed handoff."],
      skillIds: [],
      nodes: [{
        nodeId: "heartbeat-workflow-node",
        title: "Heartbeat workflow node",
        objective: "Lose a heartbeat while verification is active.",
        acceptanceCriteria: ["The workflow settlement is observable."],
        dependencyNodeIds: [],
        stageTemplate: ["verification"],
      }],
    });
    fixture.board.confirmWorkflow(proposed.plans[0]!.planRevisionId, { expectedState: "proposed" });
    const claim = fixture.board.claimRun(verifier.agentId, {
      claimId: "heartbeat-workflow-run-0001",
      messageCursor: null,
    });
    assert.ok(claim);
    backdateRun(fixture.path, claim.run.runId, "2026-08-16T12:04:59.999Z");

    assert.equal(fixture.board.reconcileStaleRuns(), 1);
    const workflow = fixture.board.projectWorkflow(fixture.project.projectId);
    assert.equal(workflow.nodes[0]?.state, "blocked");
    assert.equal(workflow.handoffs.length, 1);
    assert.equal(workflow.handoffs[0]?.taskId, claim.task?.taskId);
    assert.equal(workflow.handoffs[0]?.outcome, "failed");
    assert.equal(workflow.handoffs[0]?.summary, "run heartbeat lost");
    assert.ok(workflow.events.some((event) => event.taskId === claim.task?.taskId && event.eventType === "stage_failed"));
  } finally {
    fixture.board.close();
  }
});

test("a swept implementation retries through verification to merged with truthful transition history", async () => {
  let now = new Date("2026-08-16T12:00:00.000Z");
  const fixture = await boardFixture(undefined, () => now);
  try {
    const verifier = fixture.board.createAgent(fixture.project.projectId, {
      agentId: "heartbeat-retry-verifier",
      role: "verifier",
      area: "workflow-retry",
      mission: "Verify the retried implementation after its heartbeat is lost.",
      model: "codex-mini",
      token: "heartbeat-retry-verifier-token-0123456789",
    });
    fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
      agentTypes: [
        {
          agentTypeId: "heartbeat-retry-implementer",
          name: "Heartbeat retry implementer",
          description: "Executes and retries the implementation stage.",
          role: "engineer",
          supplementalInstructions: "Complete the bounded implementation.",
          skillIds: [],
          evaluatorProfile: "tests",
          enabled: true,
        },
        {
          agentTypeId: "heartbeat-retry-verifier",
          name: "Heartbeat retry verifier",
          description: "Verifies the retried implementation.",
          role: "verifier",
          supplementalInstructions: "Verify the implementation independently.",
          skillIds: [],
          evaluatorProfile: "tests",
          enabled: true,
        },
      ],
      stages: automationStages({
        implementation: { kind: "agent_type", agentTypeId: "heartbeat-retry-implementer" },
        verification: { kind: "agent_type", agentTypeId: "heartbeat-retry-verifier" },
      }),
    }));
    const workItem = fixture.board.createWorkItem(workItemRequest({
      originalRequest: "Retry a swept implementation and preserve truthful state history.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }), "heartbeat-retry-history-0001").workItem;
    await stageWorkItemForWorkflow(fixture.path, workItem.workItemId);
    const proposed = fixture.board.proposeWorkflow({
      workItemId: workItem.workItemId,
      projectId: fixture.project.projectId,
      objective: "Complete implementation and verification after a stale-run retry.",
      assumptions: [],
      acceptanceCriteria: ["The work item reaches merged with truthful transition history."],
      skillIds: [],
      nodes: [{
        nodeId: "heartbeat-retry-history-node",
        title: "Retry the stale implementation",
        objective: "Recover the interrupted implementation before verification.",
        acceptanceCriteria: ["Both stages complete after the retry."],
        dependencyNodeIds: [],
        stageTemplate: ["implementation", "verification"],
      }],
    });
    fixture.board.confirmWorkflow(proposed.plans[0]!.planRevisionId, { expectedState: "proposed" });

    const transitionPairs = () => fixture.board.requireWorkItem(workItem.workItemId).transitions
      .map((transition) => [transition.fromState, transition.toState]);
    const implementingHistory = [
      [null, "queued"],
      ["queued", "planning"],
      ["planning", "plan_approval"],
      ["plan_approval", "implementing"],
    ];
    assert.equal(fixture.board.requireWorkItem(workItem.workItemId).state, "implementing");
    assert.deepEqual(transitionPairs(), implementingHistory);

    const staleClaim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "heartbeat-retry-stale-run-0001",
      messageCursor: null,
    });
    assert.ok(staleClaim);
    assert.equal(staleClaim.context.workflow?.stage, "implementation");
    now = new Date("2026-08-16T12:05:01.000Z");
    assert.equal(fixture.board.reconcileStaleRuns(), 1);
    assert.equal(fixture.board.requireTask(staleClaim.task!.taskId).status, "interrupted");
    assert.equal(fixture.board.requireWorkItem(workItem.workItemId).state, "implementing");
    assert.deepEqual(transitionPairs(), implementingHistory);

    const interruptedTask = fixture.board.requireTask(staleClaim.task!.taskId);
    fixture.board.retryTask(interruptedTask.taskId, { version: interruptedTask.version });
    assert.deepEqual(transitionPairs(), implementingHistory);
    const implementationRetry = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "heartbeat-retry-implementation-0002",
      messageCursor: null,
    });
    assert.ok(implementationRetry);
    assert.equal(implementationRetry.context.workflow?.stage, "implementation");
    fixture.board.settleRun(implementationRetry.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "The retried implementation completed successfully.",
    });
    assert.equal(fixture.board.requireWorkItem(workItem.workItemId).state, "reviewing");
    assert.deepEqual(transitionPairs(), [
      ...implementingHistory,
      ["implementing", "reviewing"],
    ]);

    const verificationClaim = fixture.board.claimRun(verifier.agentId, {
      claimId: "heartbeat-retry-verification-0001",
      messageCursor: null,
    });
    assert.ok(verificationClaim);
    assert.equal(verificationClaim.context.workflow?.stage, "verification");
    fixture.board.settleRun(verificationClaim.run.runId, verifier.agentId, {
      outcome: "completed",
      result: "Independent verification passed after the retry.",
    });
    const merged = fixture.board.requireWorkItem(workItem.workItemId);
    assert.equal(merged.state, "merged");
    assert.ok(merged.endedAt);
    assert.deepEqual(transitionPairs(), [
      ...implementingHistory,
      ["implementing", "reviewing"],
      ["reviewing", "merged"],
    ]);
  } finally {
    fixture.board.close();
  }
});

test("cancelled work item does not prevent its stale planning run from settling interrupted", async () => {
  let now = new Date("2026-08-16T12:00:00.000Z");
  const fixture = await boardFixture(undefined, () => now);
  try {
    const created = fixture.board.createWorkItemAndStartPlanning(workItemRequest({
      originalRequest: "Cancel intake while its planning worker is still active.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }), "heartbeat-cancelled-planning-0001").workItem;
    const claim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "heartbeat-cancelled-planning-run-0001",
      messageCursor: null,
    });
    assert.equal(claim?.task?.taskId, created.planningTaskId);
    const cancelled = fixture.board.updateWorkItem(created.workItemId, {
      version: created.version,
      action: "cancel",
      reason: "The operator cancelled intake while planning was running.",
    });
    assert.equal(cancelled.state, "abandoned");
    assert.equal(fixture.board.requireTask(claim!.task!.taskId).status, "cancelled");

    now = new Date("2026-08-16T12:10:00.000Z");
    assert.equal(fixture.board.reconcileStaleRuns(), 1);
    const run = fixture.board.snapshot(fixture.project.projectId).recentRuns.find((item) => item.runId === claim!.run.runId);
    assert.equal(run?.status, "interrupted");
    assert.equal(run?.result, "run heartbeat lost");
    assert.equal(fixture.board.requireWorkItem(created.workItemId).state, "abandoned");
    assert.equal(fixture.board.requireTask(claim!.task!.taskId).status, "cancelled");
  } finally {
    fixture.board.close();
  }
});

test("startup sweeps stale runs and the service interval is unrefed and cleared", async () => {
  const path = await databasePath();
  const first = await TaskBoard.open(taskBoardConfig(path, () => new Date("2026-08-16T12:00:00.000Z")));
  let runId = "";
  try {
    const project = first.createProject({ name: "Startup sweep", description: "Exercise startup and timer ownership." });
    const engineer = first.createAgent(project.projectId, {
      agentId: "startup-sweep-engineer",
      role: "engineer",
      area: "sweep",
      mission: "Remain active across a board restart.",
      model: "codex-mini",
      token: AGENT_ONE_TOKEN,
    });
    first.createTask(project.projectId, taskRequest({ assignedAgentId: engineer.agentId, requiresReview: false }));
    const claim = first.claimRun(engineer.agentId, { claimId: "startup-sweep-claim-0001", messageCursor: null });
    assert.ok(claim);
    runId = claim.run.runId;
  } finally {
    first.close();
  }

  const restarted = await TaskBoard.open(taskBoardConfig(path, () => new Date("2026-08-16T12:10:00.000Z")));
  try {
    assert.equal(runRow(path, runId).status, "interrupted");
    assert.equal(runRow(path, runId).result, "run heartbeat lost");
  } finally {
    restarted.close();
  }

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let intervalCallback: (() => void) | undefined;
  let intervalDelay: number | undefined;
  let unrefed = false;
  let cleared = false;
  const fakeTimer = { unref: () => { unrefed = true; } } as NodeJS.Timeout;
  globalThis.setInterval = ((callback: () => void, delay?: number) => {
    intervalCallback = callback;
    intervalDelay = delay;
    return fakeTimer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: NodeJS.Timeout) => {
    assert.equal(timer, fakeTimer);
    cleared = true;
  }) as typeof clearInterval;
  let service: Awaited<ReturnType<typeof createTaskBoardService>> | undefined;
  try {
    service = await createTaskBoardService({
      dbPath: await databasePath(),
      humanToken: HUMAN_TOKEN,
      humanPrincipal: "human:alice",
      port: 0,
      heartbeatTimeoutSeconds: 300,
      reconcileIntervalSeconds: 7,
      now: () => new Date("2026-08-16T12:10:00.000Z"),
    });
    assert.equal(intervalDelay, 7_000);
    assert.equal(unrefed, true);
    assert.ok(intervalCallback);
    intervalCallback();
    await service.close();
    service = undefined;
    assert.equal(cleared, true);
  } finally {
    await service?.close();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
