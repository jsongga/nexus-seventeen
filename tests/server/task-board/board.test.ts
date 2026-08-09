import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync as DatabaseSyncType, SQLInputValue, StatementResultingChanges } from "node:sqlite";
import { test } from "node:test";
import {
  AUTOMATION_CONFIGURATION_MAX_BYTES,
  TaskBoard,
  TaskBoardError,
  WORK_ITEM_PAGE_SIZE,
  type AgentRole,
} from "#server/task-board";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import {
  AGENT_ONE_TOKEN,
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  config,
  databasePath,
  taskRequest,
  workItemRequest,
} from "./helpers.js";

function postWorkItem(
  board: TaskBoard,
  request: Parameters<TaskBoard["createWorkItem"]>[0],
  idempotencyKey: string,
): ReturnType<TaskBoard["createWorkItem"]> {
  return board.createWorkItemAndStartPlanning(request, idempotencyKey);
}

function completeAssignedTask(
  board: TaskBoard,
  projectId: string,
  agentId: string,
  assignedRole: AgentRole,
  title: string,
  claimId: string,
  result: string,
) {
  const task = board.createTask(projectId, taskRequest({
    title,
    assignedAgentId: agentId,
    assignedRole,
  }));
  const claim = board.claimRun(agentId, { claimId, messageCursor: null });
  assert.ok(claim);
  board.settleRun(claim.run.runId, agentId, { outcome: "completed", result });
  return board.requireTask(task.taskId);
}

async function activeSettlementWorkflow(suffix: string) {
  const fixture = await boardFixture();
  const verifier = fixture.board.createAgent(fixture.project.projectId, {
    agentId: "settlement-verifier",
    role: "verifier",
    area: "atomic-settlement",
    mission: "Verify run and workflow settlement behavior.",
    model: "codex-mini",
    token: "task-board-settlement-verifier-token-0123456789",
  });
  fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
    agentTypes: [{
      agentTypeId: "settlement-verifier",
      name: "Settlement verifier",
      description: "Executes the workflow settlement regression fixture.",
      role: "verifier",
      supplementalInstructions: "Complete the confirmed verification node.",
      skillIds: [],
      evaluatorProfile: "tests",
      enabled: true,
    }],
    stages: automationStages({
      verification: { kind: "agent_type", agentTypeId: "settlement-verifier" },
    }),
  }));
  const workItem = fixture.board.createWorkItem(workItemRequest({
    originalRequest: `Verify atomic run settlement ${suffix}.`,
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), `atomic-settlement-${suffix}`).workItem;
  const proposed = fixture.board.proposeWorkflow({
    workItemId: workItem.workItemId,
    projectId: fixture.project.projectId,
    objective: "Settle the run and its workflow node atomically.",
    assumptions: [],
    acceptanceCriteria: ["The run, task, and workflow node agree."],
    skillIds: [],
    nodes: [{
      nodeId: `settlement-${suffix}`,
      title: `Atomic settlement ${suffix}`,
      objective: "Verify atomic settlement behavior.",
      acceptanceCriteria: ["Settlement is durable and retry-safe."],
      dependencyNodeIds: [],
      stageTemplate: ["verification"],
    }],
  });
  const confirmed = fixture.board.confirmWorkflow(proposed.plans[0]!.planRevisionId, { expectedState: "proposed" });
  const node = confirmed.nodes[0]!;
  assert.equal(node.state, "active");
  const claim = fixture.board.claimRun(verifier.agentId, {
    claimId: `claim-atomic-settlement-${suffix}`,
    messageCursor: null,
  });
  assert.ok(claim);
  assert.equal(claim.context.workflow?.nodeId, node.nodeId);
  return { ...fixture, verifier, workItem, node, claim };
}

const CLAIM_CONTEXT_SKILL_ID = "cicada-evidence-research";

async function claimContextWorkflow(suffix: string) {
  const fixture = await boardFixture();
  const skillPath = join(process.cwd(), "skills", CLAIM_CONTEXT_SKILL_ID, "SKILL.md");
  const skillContent = await readFile(skillPath, "utf8");
  const agentTypeId = `claim-context-${suffix}`;
  fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
    agentTypes: [{
      agentTypeId,
      name: "Claim context researcher",
      description: "Exercises claim-context validation inside the claim transaction.",
      role: "engineer",
      supplementalInstructions: "Return the confirmed skill context with the claimed run.",
      skillIds: [CLAIM_CONTEXT_SKILL_ID],
      evaluatorProfile: "tests",
      enabled: true,
    }],
    stages: automationStages({
      research: { kind: "agent_type", agentTypeId },
    }),
  }));
  const workItem = fixture.board.createWorkItem(workItemRequest({
    originalRequest: `Verify atomic claim context ${suffix}.`,
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), `claim-context-${suffix}`).workItem;
  const title = `Claim context ${suffix}`;
  const proposed = fixture.board.proposeWorkflow({
    workItemId: workItem.workItemId,
    projectId: fixture.project.projectId,
    objective: "Build claim context before committing the claim.",
    assumptions: [],
    acceptanceCriteria: ["Rejected claim context leaves no durable claim state."],
    skillIds: [CLAIM_CONTEXT_SKILL_ID],
    nodes: [{
      nodeId: `claim-context-${suffix}`,
      title,
      objective: "Return a complete, validated claim payload.",
      acceptanceCriteria: ["The run identifier and workflow context arrive together."],
      dependencyNodeIds: [],
      stageTemplate: ["research", "verification"],
    }],
  });
  const confirmed = fixture.board.confirmWorkflow(proposed.plans[0]!.planRevisionId, { expectedState: "proposed" });
  const node = confirmed.nodes[0]!;
  const task = fixture.board.snapshot(fixture.project.projectId).tasks.find((candidate) => candidate.title === `research: ${title}`);
  assert.ok(task);
  assert.equal(task.status, "queued");
  return { ...fixture, workItem, node, task, skillPath, skillContent };
}

async function changeClaimContextSkill(skillPath: string, skillContent: string, suffix: string): Promise<void> {
  await writeFile(skillPath, `${skillContent}\nClaim-context digest mutation: ${suffix}.\n`, "utf8");
}

function assertSkillDigestChangedClaim(
  fixture: Awaited<ReturnType<typeof claimContextWorkflow>>,
  claimId: string,
): void {
  assert.throws(
    () => fixture.board.claimRun(fixture.engineer.agentId, { claimId, messageCursor: null }),
    (error: unknown) => (
      error instanceof TaskBoardError &&
      error.status === 409 &&
      error.code === "SKILL_DIGEST_CHANGED"
    ),
  );
}

function assertCompleteClaimPayload(
  claim: NonNullable<ReturnType<TaskBoard["claimRun"]>>,
  fixture: Awaited<ReturnType<typeof claimContextWorkflow>>,
): void {
  assert.match(claim.run.runId, /^[0-9a-f-]{36}$/u);
  assert.equal(claim.run.taskId, fixture.task.taskId);
  assert.equal(claim.task?.taskId, fixture.task.taskId);
  assert.equal(claim.context.agent.agentId, fixture.engineer.agentId);
  assert.equal(claim.context.projectMemory.projectId, fixture.project.projectId);
  assert.equal(claim.context.workflow?.planRevisionId, fixture.node.planRevisionId);
  assert.equal(claim.context.workflow?.nodeId, fixture.node.nodeId);
  assert.equal(claim.context.workflow?.stage, "research");
  assert.deepEqual(claim.context.workflow?.skills.map((skill) => skill.skillId), [CLAIM_CONTEXT_SKILL_ID]);
}

function settlementHandoff(outcome: "passed" | "failed") {
  return {
    outcome,
    summary: outcome === "passed" ? "Atomic settlement verified." : "Atomic settlement could not be verified.",
    evidence: ["The persisted run, task, and node states were inspected."],
    artifactIds: [],
    acceptanceCriteria: [{
      criterion: "The run, task, and workflow node agree.",
      passed: outcome === "passed",
      evidence: outcome === "passed" ? "All terminal states agree." : "The verification run failed.",
    }],
    blockers: outcome === "passed" ? [] : ["Verification failed."],
    recommendedReturnStage: null,
  } as const;
}

async function proposedActivationWorkflow(
  fixture: Awaited<ReturnType<typeof boardFixture>>,
  suffix: string,
  stageTemplate: readonly ("research" | "verification")[],
) {
  const workItem = fixture.board.createWorkItem(workItemRequest({
    originalRequest: `Reconcile workflow activation ${suffix}.`,
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), `workflow-activation-${suffix}`).workItem;
  const proposed = fixture.board.proposeWorkflow({
    workItemId: workItem.workItemId,
    projectId: fixture.project.projectId,
    objective: `Keep workflow activation ${suffix} crash-safe.`,
    assumptions: [],
    acceptanceCriteria: ["Every ready node has one coherent active attempt."],
    skillIds: [],
    nodes: [{
      nodeId: `workflow-activation-${suffix}`,
      title: `Workflow activation ${suffix}`,
      objective: "Create and link the stage task without a crash window.",
      acceptanceCriteria: ["The task has claim context and can settle the node."],
      dependencyNodeIds: [],
      stageTemplate,
    }],
  });
  return { workItem, plan: proposed.plans[0]!, node: proposed.nodes[0]! };
}

function stageWorkflowForReconciliation(
  db: DatabaseSyncType,
  workflow: Awaited<ReturnType<typeof proposedActivationWorkflow>>,
  stage: "research" | "verification",
): void {
  const confirmedAt = "2026-07-19T20:01:00.000Z";
  assert.equal(Number(db.prepare(`
    UPDATE plan_revisions
    SET state='confirmed',confirmed_by='human:alice',confirmed_at=?
    WHERE plan_revision_id=? AND state='proposed'
  `).run(confirmedAt, workflow.plan.planRevisionId).changes), 1);
  assert.equal(Number(db.prepare(`
    UPDATE work_nodes
    SET state='ready',current_stage=?,version=version+1,updated_at=?
    WHERE node_id=? AND state='pending'
  `).run(stage, confirmedAt, workflow.node.nodeId).changes), 1);
  assert.equal(Number(db.prepare(`
    UPDATE work_items
    SET state='processing',current_stage=?,version=version+1,updated_at=?
    WHERE work_item_id=?
  `).run(stage, confirmedAt, workflow.workItem.workItemId).changes), 1);
}

function configureActivationStages(
  board: TaskBoard,
  stages: Readonly<Partial<Record<"research" | "verification", string>>>,
): void {
  const types = Object.entries(stages).map(([stage, agentTypeId]) => ({
    agentTypeId,
    name: `${stage} activation executor`,
    description: `Executes reconciled ${stage} workflow stages.`,
    role: stage === "verification" ? "verifier" as const : "engineer" as const,
    supplementalInstructions: "Exercise crash-safe workflow activation.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  }));
  board.updateAutomationConfiguration(automationConfigurationRequest({
    agentTypes: types,
    stages: automationStages(Object.fromEntries(Object.entries(stages).map(([stage, agentTypeId]) => [
      stage,
      { kind: "agent_type" as const, agentTypeId },
    ]))),
  }));
}

function sizedAutomationConfiguration(targetBytes: number) {
  const agentTypes = Array.from({ length: 5 }, (_unused, index) => ({
    agentTypeId: `sized-type-${index}`,
    name: "N",
    description: "D",
    role: "manager" as const,
    supplementalInstructions: "",
    skillIds: [] as string[],
    evaluatorProfile: "manual" as const,
    enabled: false,
  }));
  const stages = automationStages();
  let currentBytes = Buffer.byteLength(JSON.stringify({ agentTypes, stages }), "utf8");
  assert.ok(currentBytes <= targetBytes);

  for (const agentType of agentTypes) {
    const added = Math.min(targetBytes - currentBytes, 8_000 - agentType.supplementalInstructions.length);
    agentType.supplementalInstructions += "x".repeat(added);
    currentBytes += added;
  }
  for (const agentType of agentTypes) {
    const added = Math.min(targetBytes - currentBytes, 4_000 - agentType.description.length);
    agentType.description += "x".repeat(added);
    currentBytes += added;
  }
  for (const agentType of agentTypes) {
    const added = Math.min(targetBytes - currentBytes, 160 - agentType.name.length);
    agentType.name += "x".repeat(added);
    currentBytes += added;
  }

  assert.equal(currentBytes, targetBytes);
  assert.equal(Buffer.byteLength(JSON.stringify({ agentTypes, stages }), "utf8"), targetBytes);
  return automationConfigurationRequest({ agentTypes, stages });
}

test("startup reconciles confirmed ready workflow nodes left before activation", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  let board: TaskBoard | null = fixture.board;
  try {
    const verifier = board.createAgent(fixture.project.projectId, {
      agentId: "activation-startup-verifier",
      role: "verifier",
      area: "workflow-activation",
      mission: "Verify startup activation repair.",
      model: "codex-mini",
      token: "activation-startup-verifier-token-0123456789",
    });
    configureActivationStages(board, { verification: "activation-startup-type" });
    const proposed = await proposedActivationWorkflow(fixture, "startup", ["verification"]);
    board.close();
    board = null;

    const { DatabaseSync } = await import("node:sqlite");
    const partial = new DatabaseSync(path);
    try {
      partial.exec("PRAGMA foreign_keys = ON");
      const confirmedAt = "2026-07-19T20:01:00.000Z";
      assert.equal(Number(partial.prepare(`
        UPDATE plan_revisions
        SET state='confirmed',confirmed_by='human:alice',confirmed_at=?
        WHERE plan_revision_id=? AND state='proposed'
      `).run(confirmedAt, proposed.plan.planRevisionId).changes), 1);
      assert.equal(Number(partial.prepare(`
        UPDATE work_nodes
        SET state='ready',current_stage='verification',version=version+1,updated_at=?
        WHERE node_id=? AND state='pending'
      `).run(confirmedAt, proposed.node.nodeId).changes), 1);
      assert.equal(Number(partial.prepare(`
        UPDATE work_items
        SET state='processing',current_stage='verification',version=version+1,updated_at=?
        WHERE work_item_id=?
      `).run(confirmedAt, proposed.workItem.workItemId).changes), 1);
      assert.equal(partial.prepare("SELECT COUNT(*) AS count FROM tasks").get()?.count, 0);
    } finally {
      partial.close();
    }

    board = await TaskBoard.open(config(path));
    const repaired = board.projectWorkflow(fixture.project.projectId);
    assert.equal(repaired.nodes[0]?.state, "active");
    const tasks = board.snapshot(fixture.project.projectId).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.assignedAgentId, verifier.agentId);
    const inspected = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM stage_attempts WHERE node_id=?")
        .get(repaired.nodes[0]!.nodeId)?.count, 1);
    } finally {
      inspected.close();
    }
  } finally {
    board?.close();
  }
});

test("workflow activation rolls back its task and wakeup when attempt linkage fails", async () => {
  const fixture = await boardFixture();
  try {
    fixture.board.createAgent(fixture.project.projectId, {
      agentId: "activation-atomic-verifier",
      role: "verifier",
      area: "workflow-activation",
      mission: "Verify atomic activation.",
      model: "codex-mini",
      token: "activation-atomic-verifier-token-012345678901",
    });
    configureActivationStages(fixture.board, { verification: "activation-atomic-type" });
    const proposed = await proposedActivationWorkflow(fixture, "atomic", ["verification"]);
    const { DatabaseSync } = await import("node:sqlite");
    const originalPrepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function failingAttemptLink(this: DatabaseSyncType, sql: string) {
      if (/^\s*INSERT INTO stage_attempts/u.test(sql)) throw new Error("INJECTED_ATTEMPT_LINK_FAILURE");
      return originalPrepare.call(this, sql);
    };
    try {
      assert.throws(
        () => fixture.board.confirmWorkflow(proposed.plan.planRevisionId, { expectedState: "proposed" }),
        /INJECTED_ATTEMPT_LINK_FAILURE/u,
      );
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
    }
    assert.equal(fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]?.state, "ready");
    assert.equal(fixture.board.snapshot(fixture.project.projectId).tasks.length, 0);
    assert.equal(fixture.board.snapshot(fixture.project.projectId).agents.find((agent) =>
      agent.agentId === "activation-atomic-verifier")?.status, "idle");
  } finally {
    fixture.board.close();
  }
});

test("confirming a plan for a cancelled work item returns WORK_ITEM_ENDED without changing it", async () => {
  const fixture = await boardFixture();
  try {
    const proposed = await proposedActivationWorkflow(fixture, "cancelled-item", ["verification"]);
    const { DatabaseSync } = await import("node:sqlite");
    const cancellation = new DatabaseSync(fixture.path);
    try {
      const endedAt = "2026-07-19T20:01:00.000Z";
      assert.equal(Number(cancellation.prepare(`
        UPDATE work_items
        SET state='cancelled',current_stage=NULL,ended_at=?,version=version+1,updated_at=?
        WHERE work_item_id=? AND ended_at IS NULL
      `).run(endedAt, endedAt, proposed.workItem.workItemId).changes), 1);
    } finally {
      cancellation.close();
    }

    const before = fixture.board.requireWorkItem(proposed.workItem.workItemId);
    assert.throws(
      () => fixture.board.confirmWorkflow(proposed.plan.planRevisionId, { expectedState: "proposed" }),
      (error: unknown) => (
        error instanceof TaskBoardError &&
        error.status === 409 &&
        error.code === "WORK_ITEM_ENDED"
      ),
    );
    assert.deepEqual(fixture.board.requireWorkItem(proposed.workItem.workItemId), before);
    assert.equal(fixture.board.projectWorkflow(fixture.project.projectId).plans[0]?.state, "proposed");
  } finally {
    fixture.board.close();
  }
});

test("workflow project events are not published when confirmation rolls back", async () => {
  const fixture = await boardFixture();
  try {
    const proposed = await proposedActivationWorkflow(fixture, "event-rollback", ["verification"]);
    const published: string[] = [];
    const unsubscribe = fixture.board.subscribeProjectEvents(fixture.project.projectId, (event) => {
      published.push(event.eventType);
    });
    const { DatabaseSync } = await import("node:sqlite");
    const originalPrepare = DatabaseSync.prototype.prepare;
    let injected = false;
    DatabaseSync.prototype.prepare = function failAfterQueuedConfirmationEvent(this: DatabaseSyncType, sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (!injected && /^SELECT n\.\*, COALESCE\(json_group_array/u.test(sql)) {
        const originalAll = statement.all.bind(statement);
        statement.all = ((..._values: SQLInputValue[]) => {
          injected = true;
          throw new Error("INJECTED_POST_EVENT_CONFIRM_FAILURE");
        }) as unknown as typeof statement.all;
        void originalAll;
      }
      return statement;
    };
    try {
      assert.throws(
        () => fixture.board.confirmWorkflow(proposed.plan.planRevisionId, { expectedState: "proposed" }),
        /INJECTED_POST_EVENT_CONFIRM_FAILURE/u,
      );
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
      unsubscribe();
    }

    assert.equal(injected, true);
    assert.deepEqual(published, []);
    const workflow = fixture.board.projectWorkflow(fixture.project.projectId);
    assert.equal(workflow.plans[0]?.state, "proposed");
    assert.equal(workflow.events.some((event) => event.eventType === "plan_confirmed"), false);
  } finally {
    fixture.board.close();
  }
});

test("committed workflow events preserve order and isolate throwing listeners", async () => {
  const fixture = await boardFixture();
  const originalConsoleError = console.error;
  const logged: unknown[][] = [];
  try {
    const proposed = await proposedActivationWorkflow(fixture, "event-order", ["verification"]);
    const beforeThrow: string[] = [];
    const afterThrow: string[] = [];
    const unsubscribeBefore = fixture.board.subscribeProjectEvents(fixture.project.projectId, (event) => {
      beforeThrow.push(event.eventType);
    });
    const unsubscribeThrow = fixture.board.subscribeProjectEvents(fixture.project.projectId, () => {
      throw new Error("INJECTED_PROJECT_EVENT_LISTENER_FAILURE");
    });
    const unsubscribeAfter = fixture.board.subscribeProjectEvents(fixture.project.projectId, (event) => {
      afterThrow.push(event.eventType);
    });
    console.error = (...values: unknown[]) => { logged.push(values); };
    try {
      const confirmed = fixture.board.confirmWorkflow(proposed.plan.planRevisionId, { expectedState: "proposed" });
      assert.equal(confirmed.plans[0]?.state, "confirmed");
      assert.equal(confirmed.nodes[0]?.state, "blocked");
    } finally {
      console.error = originalConsoleError;
      unsubscribeBefore();
      unsubscribeThrow();
      unsubscribeAfter();
    }

    assert.deepEqual(beforeThrow, ["plan_confirmed", "node_blocked"]);
    assert.deepEqual(afterThrow, beforeThrow);
    assert.equal(logged.length, 2);
    assert.ok(logged.every((entry) => String(entry[0]).includes("project event listener failed")));
  } finally {
    console.error = originalConsoleError;
    fixture.board.close();
  }
});

test("after-commit delivery preserves FIFO order across listener-initiated transactions", async () => {
  const store = await TaskBoardStore.open(await databasePath());
  try {
    const delivered: string[] = [];
    let reentered = false;
    const listeners: Array<(event: string) => void> = [
      (event) => delivered.push(event),
      (event) => {
        if (event === "event1" && !reentered) {
          reentered = true;
          store.transaction(() => {
            store.afterCommit(() => dispatch("X"));
          });
        }
      },
    ];
    const dispatch = (event: string): void => {
      for (const listener of listeners) listener(event);
    };

    store.transaction(() => {
      store.afterCommit(() => dispatch("event1"));
      store.afterCommit(() => dispatch("event2"));
    });

    assert.deepEqual(delivered, ["event1", "event2", "X"]);
  } finally {
    store.close();
  }
});

test("after-commit delivery logs callback failures without failing the commit or skipping callbacks", async () => {
  const store = await TaskBoardStore.open(await databasePath());
  const originalConsoleError = console.error;
  const logged: unknown[][] = [];
  try {
    const delivered: string[] = [];
    console.error = (...values: unknown[]) => { logged.push(values); };

    let result: string | undefined;
    assert.doesNotThrow(() => {
      result = store.transaction(() => {
        store.afterCommit(() => {
          throw new Error("INJECTED_AFTER_COMMIT_FAILURE");
        });
        store.afterCommit(() => delivered.push("second"));
        return "committed";
      });
    });

    assert.equal(result, "committed");
    assert.deepEqual(delivered, ["second"]);
    assert.equal(logged.length, 1);
    assert.match(String(logged[0]?.[0]), /after-commit callback failed/u);
    assert.match(String(logged[0]?.[1]), /INJECTED_AFTER_COMMIT_FAILURE/u);
  } finally {
    console.error = originalConsoleError;
    store.close();
  }
});

test("reconciler links a coherent half-created activation task and makes it settleable", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  let board: TaskBoard | null = fixture.board;
  try {
    const verifier = board.createAgent(fixture.project.projectId, {
      agentId: "activation-link-verifier",
      role: "verifier",
      area: "workflow-activation",
      mission: "Verify half-created activation repair.",
      model: "codex-mini",
      token: "activation-link-verifier-token-0123456789012",
    });
    configureActivationStages(board, { verification: "activation-link-type" });
    const proposed = await proposedActivationWorkflow(fixture, "link", ["verification"]);
    const confirmed = board.confirmWorkflow(proposed.plan.planRevisionId, { expectedState: "proposed" });
    const node = confirmed.nodes[0]!;
    const task = board.snapshot(fixture.project.projectId).tasks[0]!;
    board.close();
    board = null;

    const { DatabaseSync } = await import("node:sqlite");
    const partial = new DatabaseSync(path);
    try {
      partial.exec("PRAGMA foreign_keys = ON");
      assert.equal(Number(partial.prepare("DELETE FROM stage_attempts WHERE task_id=?").run(task.taskId).changes), 1);
      assert.equal(Number(partial.prepare(
        "DELETE FROM project_events WHERE node_id=? AND task_id=? AND event_type='stage_started'",
      ).run(node.nodeId, task.taskId).changes), 1);
      assert.equal(Number(partial.prepare("UPDATE work_nodes SET state='ready',version=version-1 WHERE node_id=?")
        .run(node.nodeId).changes), 1);
    } finally {
      partial.close();
    }

    board = await TaskBoard.open(config(path));
    board.reconcileWorkflows(fixture.project.projectId);
    const repaired = board.projectWorkflow(fixture.project.projectId).nodes[0]!;
    assert.equal(repaired.state, "active");
    assert.equal(board.snapshot(fixture.project.projectId).tasks.length, 1);
    assert.equal(board.projectWorkflow(fixture.project.projectId).events.filter((event) =>
      event.nodeId === node.nodeId && event.taskId === task.taskId && event.eventType === "stage_started").length, 1);
    const claim = board.claimRun(verifier.agentId, {
      claimId: "claim-reconciled-half-activation",
      messageCursor: null,
    });
    assert.ok(claim);
    assert.equal(claim.task?.taskId, task.taskId);
    assert.equal(claim.context.workflow?.nodeId, node.nodeId);
    board.settleRun(claim.run.runId, verifier.agentId, {
      outcome: "completed",
      result: "The repaired activation task settled with workflow context.",
      handoff: settlementHandoff("passed"),
    });
    assert.equal(board.projectWorkflow(fixture.project.projectId).nodes[0]?.state, "completed");
  } finally {
    board?.close();
  }
});

test("creating a compatible agent activates a workflow node persisted as blocked", async () => {
  const fixture = await boardFixture();
  try {
    configureActivationStages(fixture.board, { verification: "activation-blocked-type" });
    const proposed = await proposedActivationWorkflow(fixture, "blocked", ["verification"]);
    const confirmed = fixture.board.confirmWorkflow(proposed.plan.planRevisionId, { expectedState: "proposed" });
    assert.equal(confirmed.nodes[0]?.state, "blocked");
    assert.ok(confirmed.events.some((event) => event.eventType === "node_blocked"));
    assert.equal(fixture.board.snapshot(fixture.project.projectId).tasks.length, 0);

    const verifier = fixture.board.createAgent(fixture.project.projectId, {
      agentId: "activation-blocked-verifier",
      role: "verifier",
      area: "workflow-activation",
      mission: "Unblock a waiting workflow node.",
      model: "codex-mini",
      token: "activation-blocked-verifier-token-0123456789",
    });
    const activated = fixture.board.projectWorkflow(fixture.project.projectId);
    assert.equal(activated.nodes[0]?.state, "active");
    assert.equal(fixture.board.snapshot(fixture.project.projectId).tasks[0]?.assignedAgentId, verifier.agentId);
  } finally {
    fixture.board.close();
  }
});

test("startup repairs a ready next stage after post-settlement activation crashes", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  let board: TaskBoard | null = fixture.board;
  try {
    const verifier = board.createAgent(fixture.project.projectId, {
      agentId: "activation-handoff-verifier",
      role: "verifier",
      area: "workflow-activation",
      mission: "Verify post-settlement activation repair.",
      model: "codex-mini",
      token: "activation-handoff-verifier-token-0123456789",
    });
    configureActivationStages(board, {
      research: "activation-handoff-researcher",
      verification: "activation-handoff-verifier-type",
    });
    const proposed = await proposedActivationWorkflow(fixture, "handoff", ["research", "verification"]);
    const confirmed = board.confirmWorkflow(proposed.plan.planRevisionId, { expectedState: "proposed" });
    const researchTask = board.snapshot(fixture.project.projectId).tasks[0]!;
    const researchClaim = board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-post-settlement-activation-research",
      messageCursor: null,
    });
    assert.ok(researchClaim);
    const { DatabaseSync } = await import("node:sqlite");
    const originalPrepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function failingNextStageCreate(this: DatabaseSyncType, sql: string) {
      if (/^\s*INSERT INTO tasks\(/u.test(sql)) throw new Error("INJECTED_POST_SETTLEMENT_ACTIVATION_CRASH");
      return originalPrepare.call(this, sql);
    };
    try {
      assert.throws(
        () => board!.settleRun(researchClaim.run.runId, fixture.engineer.agentId, {
          outcome: "completed",
          result: "Research completed before next-stage activation crashed.",
          handoff: settlementHandoff("passed"),
        }),
        /INJECTED_POST_SETTLEMENT_ACTIVATION_CRASH/u,
      );
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
    }
    const stalled = board.projectWorkflow(fixture.project.projectId);
    assert.equal(stalled.nodes[0]?.state, "ready");
    assert.equal(stalled.nodes[0]?.currentStage, "verification");
    assert.equal(stalled.handoffs.length, 1);
    assert.equal(board.snapshot(fixture.project.projectId).tasks.length, 1);
    assert.equal(board.requireTask(researchTask.taskId).status, "completed");
    assert.equal(confirmed.nodes[0]?.nodeId, stalled.nodes[0]?.nodeId);
    board.close();
    board = null;

    board = await TaskBoard.open(config(path));
    const repaired = board.projectWorkflow(fixture.project.projectId);
    assert.equal(repaired.nodes[0]?.state, "active");
    assert.equal(repaired.nodes[0]?.currentStage, "verification");
    assert.equal(board.snapshot(fixture.project.projectId).tasks.length, 2);
    const verificationClaim = board.claimRun(verifier.agentId, {
      claimId: "claim-post-settlement-activation-verification",
      messageCursor: null,
    });
    assert.ok(verificationClaim);
    assert.equal(verificationClaim.context.workflow?.stage, "verification");
    assert.equal(verificationClaim.context.workflow?.dependencyHandoffs.length, 0);
  } finally {
    board?.close();
  }
});

test("workflow reconciliation is idempotent on a healthy board", async () => {
  const fixture = await boardFixture();
  try {
    fixture.board.createAgent(fixture.project.projectId, {
      agentId: "activation-idempotent-verifier",
      role: "verifier",
      area: "workflow-activation",
      mission: "Verify reconciliation idempotency.",
      model: "codex-mini",
      token: "activation-idempotent-verifier-token-01234567",
    });
    configureActivationStages(fixture.board, { verification: "activation-idempotent-type" });
    const proposed = await proposedActivationWorkflow(fixture, "idempotent", ["verification"]);
    fixture.board.confirmWorkflow(proposed.plan.planRevisionId, { expectedState: "proposed" });

    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const afterFirst = {
      workflow: fixture.board.projectWorkflow(fixture.project.projectId),
      tasks: fixture.board.snapshot(fixture.project.projectId).tasks,
    };
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const afterSecond = {
      workflow: fixture.board.projectWorkflow(fixture.project.projectId),
      tasks: fixture.board.snapshot(fixture.project.projectId).tasks,
    };
    assert.deepEqual(afterSecond, afterFirst);
  } finally {
    fixture.board.close();
  }
});

test("startup isolates a corrupt workflow candidate and repairs candidates in other projects", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  let board: TaskBoard | null = fixture.board;
  const originalConsoleError = console.error;
  const reconciliationErrors: string[] = [];
  try {
    const otherProject = board.createProject({
      name: "Inventory reliability",
      description: "Keep inventory workflow repair independent from corrupt checkout data.",
    });
    const otherVerifier = board.createAgent(otherProject.projectId, {
      agentId: "activation-isolation-verifier",
      role: "verifier",
      area: "workflow-activation",
      mission: "Verify isolated workflow reconciliation.",
      model: "codex-mini",
      token: "activation-isolation-verifier-token-0123456789",
    });
    board.createAgent(fixture.project.projectId, {
      agentId: "activation-corrupt-verifier",
      role: "verifier",
      area: "workflow-activation",
      mission: "Reach corrupt workflow candidate data during reconciliation.",
      model: "codex-mini",
      token: "activation-corrupt-verifier-token-0123456789",
    });
    configureActivationStages(board, { verification: "activation-isolation-type" });
    const corrupt = await proposedActivationWorkflow(fixture, "corrupt-candidate", ["verification"]);
    const repairable = await proposedActivationWorkflow(
      { ...fixture, project: otherProject },
      "other-project",
      ["verification"],
    );
    board.close();
    board = null;

    const { DatabaseSync } = await import("node:sqlite");
    const partial = new DatabaseSync(path);
    let corruptVersion = 0;
    try {
      partial.exec("PRAGMA foreign_keys = ON");
      stageWorkflowForReconciliation(partial, corrupt, "verification");
      stageWorkflowForReconciliation(partial, repairable, "verification");
      assert.equal(Number(partial.prepare(
        "UPDATE work_nodes SET acceptance_criteria_json='null' WHERE node_id=?",
      ).run(corrupt.node.nodeId).changes), 1);
      corruptVersion = Number(partial.prepare("SELECT version FROM work_nodes WHERE node_id=?")
        .get(corrupt.node.nodeId)?.version);
    } finally {
      partial.close();
    }

    console.error = (...values: unknown[]): void => {
      reconciliationErrors.push(values.map(String).join(" "));
    };
    try {
      board = await TaskBoard.open(config(path));
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(board.projectWorkflow(otherProject.projectId).nodes[0]?.state, "active");
    assert.equal(board.snapshot(otherProject.projectId).tasks[0]?.assignedAgentId, otherVerifier.agentId);
    assert.ok(reconciliationErrors.some((message) => message.includes(corrupt.node.nodeId)));
    const inspected = new DatabaseSync(path, { readOnly: true });
    try {
      const untouched = inspected.prepare("SELECT state,version FROM work_nodes WHERE node_id=?")
        .get(corrupt.node.nodeId);
      assert.equal(untouched?.state, "ready");
      assert.equal(Number(untouched?.version), corruptVersion);
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM stage_attempts WHERE node_id=?")
        .get(corrupt.node.nodeId)?.count, 0);
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id=?")
        .get(fixture.project.projectId)?.count, 0);
    } finally {
      inspected.close();
    }
  } finally {
    console.error = originalConsoleError;
    board?.close();
  }
});

test("reconciler skips a claimed activation orphan and creates a fresh linked task", async () => {
  const fixture = await boardFixture();
  try {
    fixture.board.createAgent(fixture.project.projectId, {
      agentId: "activation-claimed-verifier",
      role: "verifier",
      area: "workflow-activation",
      mission: "Verify claimed activation orphans remain ordinary work.",
      model: "codex-mini",
      token: "activation-claimed-verifier-token-0123456789",
    });
    configureActivationStages(fixture.board, { verification: "activation-claimed-type" });
    const proposed = await proposedActivationWorkflow(fixture, "claimed-orphan", ["verification"]);
    const confirmed = fixture.board.confirmWorkflow(proposed.plan.planRevisionId, { expectedState: "proposed" });
    const node = confirmed.nodes[0]!;
    const orphan = fixture.board.snapshot(fixture.project.projectId).tasks[0]!;
    const { DatabaseSync } = await import("node:sqlite");
    const partial = new DatabaseSync(fixture.path);
    try {
      partial.exec("PRAGMA foreign_keys = ON");
      assert.equal(Number(partial.prepare("DELETE FROM stage_attempts WHERE task_id=?")
        .run(orphan.taskId).changes), 1);
      assert.equal(Number(partial.prepare(
        "DELETE FROM project_events WHERE node_id=? AND task_id=? AND event_type='stage_started'",
      ).run(node.nodeId, orphan.taskId).changes), 1);
      assert.equal(Number(partial.prepare("UPDATE work_nodes SET state='ready',version=version-1 WHERE node_id=?")
        .run(node.nodeId).changes), 1);
    } finally {
      partial.close();
    }

    const orphanClaim = fixture.board.claimRun("activation-claimed-verifier", {
      claimId: "claim-activation-claimed-orphan",
      messageCursor: null,
    });
    assert.ok(orphanClaim);
    assert.equal(orphanClaim.task?.taskId, orphan.taskId);
    assert.equal(orphanClaim.context.workflow, null);

    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const tasks = fixture.board.snapshot(fixture.project.projectId).tasks.filter((task) =>
      task.objective === proposed.node.objective);
    assert.equal(tasks.length, 2);
    const replacement = tasks.find((task) => task.taskId !== orphan.taskId);
    assert.ok(replacement);
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM stage_attempts WHERE task_id=?")
        .get(orphan.taskId)?.count, 0);
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM stage_attempts WHERE task_id=? AND node_id=?")
        .get(replacement.taskId, node.nodeId)?.count, 1);
    } finally {
      inspected.close();
    }

    const settled = fixture.board.settleRun(orphanClaim.run.runId, "activation-claimed-verifier", {
      outcome: "completed",
      result: "The claimed orphan completed as ordinary work without workflow context.",
    });
    assert.equal(settled.run.status, "completed");
    assert.equal(fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]?.state, "active");
  } finally {
    fixture.board.close();
  }
});

test("reconciler skips a dead blocked activation orphan and creates a fresh task", async () => {
  const fixture = await boardFixture();
  try {
    fixture.board.createAgent(fixture.project.projectId, {
      agentId: "activation-dead-verifier",
      role: "verifier",
      area: "workflow-activation",
      mission: "Verify dead activation orphans are not adopted.",
      model: "codex-mini",
      token: "activation-dead-verifier-token-0123456789",
    });
    configureActivationStages(fixture.board, { verification: "activation-dead-type" });
    const proposed = await proposedActivationWorkflow(fixture, "dead-orphan", ["verification"]);
    const confirmed = fixture.board.confirmWorkflow(proposed.plan.planRevisionId, { expectedState: "proposed" });
    const node = confirmed.nodes[0]!;
    const orphan = fixture.board.snapshot(fixture.project.projectId).tasks[0]!;
    const orphanClaim = fixture.board.claimRun("activation-dead-verifier", {
      claimId: "claim-activation-dead-orphan",
      messageCursor: null,
    });
    assert.ok(orphanClaim);
    fixture.board.settleRun(orphanClaim.run.runId, "activation-dead-verifier", {
      outcome: "failed",
      result: "The legacy activation task failed before its link was lost.",
      handoff: settlementHandoff("failed"),
    });

    const { DatabaseSync } = await import("node:sqlite");
    const partial = new DatabaseSync(fixture.path);
    try {
      partial.exec("PRAGMA foreign_keys = ON");
      assert.equal(Number(partial.prepare("DELETE FROM stage_attempts WHERE task_id=?")
        .run(orphan.taskId).changes), 1);
      assert.equal(Number(partial.prepare("UPDATE work_nodes SET state='ready',version=version+1 WHERE node_id=?")
        .run(node.nodeId).changes), 1);
      assert.equal(partial.prepare(`
        SELECT COUNT(*) AS count
        FROM wakeups wakeup
        WHERE wakeup.task_id=?
          AND wakeup.claimed_at IS NULL
          AND NOT EXISTS(
            SELECT 1 FROM task_events event WHERE event.event_id='retired-wakeup:' || wakeup.wakeup_id
          )
      `).get(orphan.taskId)?.count, 0);
    } finally {
      partial.close();
    }

    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const tasks = fixture.board.snapshot(fixture.project.projectId).tasks.filter((task) =>
      task.objective === proposed.node.objective);
    assert.equal(tasks.length, 2);
    const replacement = tasks.find((task) => task.taskId !== orphan.taskId);
    assert.ok(replacement);
    assert.equal(fixture.board.requireTask(orphan.taskId).status, "blocked");
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM stage_attempts WHERE task_id=?")
        .get(orphan.taskId)?.count, 0);
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM stage_attempts WHERE task_id=? AND node_id=?")
        .get(replacement.taskId, node.nodeId)?.count, 1);
    } finally {
      inspected.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("stale capacity-blocked candidates are not resurrected after becoming failure-blocked", async () => {
  const fixture = await boardFixture();
  try {
    configureActivationStages(fixture.board, { verification: "activation-stale-type" });
    const proposed = await proposedActivationWorkflow(fixture, "stale-blocked", ["verification"]);
    const confirmed = fixture.board.confirmWorkflow(proposed.plan.planRevisionId, { expectedState: "proposed" });
    const blocked = confirmed.nodes[0]!;
    assert.equal(blocked.state, "blocked");

    const { DatabaseSync } = await import("node:sqlite");
    const capacity = new DatabaseSync(fixture.path);
    try {
      capacity.prepare(`
        INSERT INTO agents(agent_id,project_id,role,area,mission,model,token_hash,created_at)
        VALUES ('activation-stale-verifier', ?, 'verifier', 'workflow-activation',
          'Verify stale blocked candidates remain failed.', 'codex-mini',
          'activation-stale-verifier-direct-token-hash', ?)
      `).run(fixture.project.projectId, blocked.updatedAt);
    } finally {
      capacity.close();
    }
    const originalPrepare = DatabaseSync.prototype.prepare;
    let interleaved = false;
    DatabaseSync.prototype.prepare = function interleaveFailureBlocking(this: DatabaseSyncType, sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (!interleaved && /SELECT node\.node_id[\s\S]*FROM work_nodes node[\s\S]*plan\.state='confirmed'/u.test(sql)) {
        const originalAll = statement.all.bind(statement) as (...values: SQLInputValue[]) => Record<string, unknown>[];
        statement.all = ((...values: SQLInputValue[]) => {
          const rows = originalAll(...values);
          if (rows.some((row) => String(row.node_id) === blocked.nodeId)) {
            originalPrepare.call(this, `
              INSERT INTO project_events(event_id,project_id,node_id,task_id,event_type,summary,created_at)
              VALUES ('event_stale_failure_block', ?, ?, NULL, 'stage_failed', 'Failure won the race.', ?)
            `).run(fixture.project.projectId, blocked.nodeId, blocked.updatedAt);
            interleaved = true;
          }
          return rows;
        }) as typeof statement.all;
      }
      return statement;
    };
    try {
      fixture.board.reconcileWorkflows(fixture.project.projectId);
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
    }

    assert.equal(interleaved, true);
    const afterRace = fixture.board.projectWorkflow(fixture.project.projectId);
    assert.equal(afterRace.nodes[0]?.state, "blocked");
    assert.equal(afterRace.nodes[0]?.version, blocked.version);
    assert.equal(afterRace.events[0]?.eventType, "stage_failed");
    assert.equal(fixture.board.snapshot(fixture.project.projectId).tasks.length, 0);
    const beforeReplay = fixture.board.projectWorkflow(fixture.project.projectId);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.deepEqual(fixture.board.projectWorkflow(fixture.project.projectId), beforeReplay);
  } finally {
    fixture.board.close();
  }
});

test("repeated reconciliation does not churn a still capacity-blocked node", async () => {
  const fixture = await boardFixture();
  try {
    configureActivationStages(fixture.board, { verification: "activation-still-blocked-type" });
    const proposed = await proposedActivationWorkflow(fixture, "still-blocked", ["verification"]);
    const confirmed = fixture.board.confirmWorkflow(proposed.plan.planRevisionId, { expectedState: "proposed" });
    assert.equal(confirmed.nodes[0]?.state, "blocked");
    const before = fixture.board.projectWorkflow(fixture.project.projectId);

    fixture.board.reconcileWorkflows(fixture.project.projectId);
    fixture.board.reconcileWorkflows(fixture.project.projectId);

    assert.deepEqual(fixture.board.projectWorkflow(fixture.project.projectId), before);
    assert.equal(fixture.board.snapshot(fixture.project.projectId).tasks.length, 0);
  } finally {
    fixture.board.close();
  }
});

test("confirmed workflow persists an acyclic graph and activates only dependency roots", async () => {
  const fixture = await boardFixture();
  try {
    const item = fixture.board.createWorkItem(workItemRequest(), "workflow-intake-0001").workItem;
    fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
      agentTypes: [{
        agentTypeId: "researcher", name: "Researcher", description: "Research", role: "engineer",
        supplementalInstructions: "Research the confirmed node and return evidence.", skillIds: ["cicada-evidence-research"], evaluatorProfile: "editorial", enabled: true,
      }],
      stages: automationStages({ research: { kind: "agent_type", agentTypeId: "researcher" } }),
    }));
    const proposed = await fixture.board.proposeWorkflow({
      workItemId: item.workItemId, projectId: fixture.project.projectId,
      objective: "Make retry behavior safe.", assumptions: [], acceptanceCriteria: ["Retry tests pass"],
      skillIds: ["cicada-evidence-research"],
      nodes: [
        { nodeId: "investigate-retries", title: "Investigate retries", objective: "Find failure modes", acceptanceCriteria: ["Evidence recorded"], dependencyNodeIds: [], stageTemplate: ["research", "verification"] },
        { nodeId: "implement-retries", title: "Implement retries", objective: "Make retries safe", acceptanceCriteria: ["Tests pass"], dependencyNodeIds: ["investigate-retries"], stageTemplate: ["research", "planning", "implementation", "testing", "verification"] },
      ],
    });
    const plan = proposed.plans[0]!;
    assert.equal(plan.state, "proposed");
    const confirmed = fixture.board.confirmWorkflow(plan.planRevisionId, { expectedState: "proposed" });
    assert.equal(confirmed.plans[0]?.state, "confirmed");
    assert.equal(confirmed.nodes.find((node) => node.title === "Investigate retries")?.state, "active");
    assert.equal(confirmed.nodes.find((node) => node.title === "Implement retries")?.state, "pending");
    assert.equal(fixture.board.snapshot(fixture.project.projectId).tasks.some((task) => task.title === "research: Investigate retries"), true);
    assert.throws(() => fixture.board.proposeWorkflow({
      workItemId: item.workItemId, projectId: fixture.project.projectId, objective: "Cycle",
      assumptions: [], acceptanceCriteria: ["Never"], skillIds: [],
      nodes: [
        { nodeId: "cycle-a", title: "A", objective: "A", acceptanceCriteria: ["A"], dependencyNodeIds: ["cycle-b"], stageTemplate: ["research", "verification"] },
        { nodeId: "cycle-b", title: "B", objective: "B", acceptanceCriteria: ["B"], dependencyNodeIds: ["cycle-a"], stageTemplate: ["research", "verification"] },
      ],
    }), (error: unknown) => error instanceof TaskBoardError && error.code === "WORKFLOW_CYCLE");
  } finally {
    fixture.board.close();
  }
});

test("claim-context rejection rolls back the run, wakeup claim, and task start", async () => {
  const fixture = await claimContextWorkflow("rollback");
  try {
    const initialTask = fixture.board.requireTask(fixture.task.taskId);
    await changeClaimContextSkill(fixture.skillPath, fixture.skillContent, "rollback");

    assertSkillDigestChangedClaim(fixture, "claim-context-rollback-0001");

    const taskAfterRejection = fixture.board.requireTask(fixture.task.taskId);
    assert.equal(taskAfterRejection.status, initialTask.status);
    assert.equal(taskAfterRejection.startedAt, initialTask.startedAt);
    assert.equal(taskAfterRejection.version, initialTask.version);
    assert.equal(
      fixture.board.snapshot(fixture.project.projectId).recentRuns.some((run) => run.agentId === fixture.engineer.agentId),
      false,
    );

    const { DatabaseSync } = await import("node:sqlite");
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(
        inspected.prepare("SELECT COUNT(*) AS count FROM runs WHERE agent_id=?").get(fixture.engineer.agentId)?.count,
        0,
      );
      const wakeup = inspected.prepare(
        "SELECT claimed_at,run_id FROM wakeups WHERE agent_id=? AND task_id=?",
      ).get(fixture.engineer.agentId, fixture.task.taskId);
      assert.ok(wakeup);
      assert.equal(wakeup.claimed_at, null);
      assert.equal(wakeup.run_id, null);
    } finally {
      inspected.close();
    }
  } finally {
    await writeFile(fixture.skillPath, fixture.skillContent, "utf8");
    fixture.board.close();
  }
});

test("a new claimId succeeds with complete context after a rejected claim is refreshed", async () => {
  const fixture = await claimContextWorkflow("new-retry");
  try {
    await changeClaimContextSkill(fixture.skillPath, fixture.skillContent, "new-retry");
    assertSkillDigestChangedClaim(fixture, "claim-context-new-retry-rejected-0001");

    await writeFile(fixture.skillPath, fixture.skillContent, "utf8");
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-context-new-retry-success-0002",
      messageCursor: null,
    });
    assert.ok(claim);
    assertCompleteClaimPayload(claim, fixture);
  } finally {
    await writeFile(fixture.skillPath, fixture.skillContent, "utf8");
    fixture.board.close();
  }
});

test("the same claimId is a fresh attempt after claim-context rejection", async () => {
  const fixture = await claimContextWorkflow("same-retry");
  const claimId = "claim-context-same-retry-0001";
  try {
    await changeClaimContextSkill(fixture.skillPath, fixture.skillContent, "same-retry");
    assertSkillDigestChangedClaim(fixture, claimId);
    assert.equal(
      fixture.board.snapshot(fixture.project.projectId).recentRuns.some((run) => run.agentId === fixture.engineer.agentId),
      false,
    );

    await writeFile(fixture.skillPath, fixture.skillContent, "utf8");
    const claim = fixture.board.claimRun(fixture.engineer.agentId, { claimId, messageCursor: null });
    assert.ok(claim);
    assertCompleteClaimPayload(claim, fixture);
  } finally {
    await writeFile(fixture.skillPath, fixture.skillContent, "utf8");
    fixture.board.close();
  }
});

test("happy-path claim keeps the existing complete response shape", async () => {
  const fixture = await claimContextWorkflow("happy-path");
  try {
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-context-happy-path-0001",
      messageCursor: null,
    });
    assert.ok(claim);
    assertCompleteClaimPayload(claim, fixture);
    assert.deepEqual(Object.keys(claim).sort(), ["apiVersion", "context", "run", "task", "wakeup"]);
    assert.deepEqual(Object.keys(claim.context).sort(), [
      "acceptanceCriteria",
      "agent",
      "areaMemory",
      "messageCursor",
      "messages",
      "openQuestions",
      "parentMessages",
      "parentTask",
      "projectMemory",
      "triggerQuestion",
      "workflow",
      "workspaceRefs",
    ]);
  } finally {
    await writeFile(fixture.skillPath, fixture.skillContent, "utf8");
    fixture.board.close();
  }
});

test("same-claimId replay returns the original claim payload after a skill digest changes", async () => {
  const fixture = await claimContextWorkflow("persisted-replay");
  const request = { claimId: "claim-context-persisted-replay-0001", messageCursor: null } as const;
  try {
    const first = fixture.board.claimRun(fixture.engineer.agentId, request);
    assert.ok(first);
    assertCompleteClaimPayload(first, fixture);
    const { DatabaseSync } = await import("node:sqlite");
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const stored = inspected.prepare("SELECT claim_result_json FROM runs WHERE run_id = ?").get(first.run.runId);
      assert.equal(typeof stored?.claim_result_json, "string");
      assert.deepEqual(JSON.parse(String(stored?.claim_result_json)), first);
    } finally {
      inspected.close();
    }

    await changeClaimContextSkill(fixture.skillPath, fixture.skillContent, "persisted-replay");
    const replay = fixture.board.claimRun(fixture.engineer.agentId, request);
    assert.ok(replay);
    assert.deepEqual(replay.context, first.context);
    assert.deepEqual(replay, first);

    const settled = fixture.board.settleRun(first.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "The persisted claim payload remained replayable after its skill changed.",
    });
    assert.equal(settled.run.status, "completed");
  } finally {
    await writeFile(fixture.skillPath, fixture.skillContent, "utf8");
    fixture.board.close();
  }
});

test("same-claimId replay rebuilds legacy active runs without a persisted claim payload", async () => {
  const fixture = await claimContextWorkflow("legacy-replay");
  const request = { claimId: "claim-context-legacy-replay-0001", messageCursor: null } as const;
  let fixtureOpen = true;
  let restarted: TaskBoard | null = null;
  try {
    const first = fixture.board.claimRun(fixture.engineer.agentId, request);
    assert.ok(first);
    fixture.board.close();
    fixtureOpen = false;

    const { DatabaseSync } = await import("node:sqlite");
    const direct = new DatabaseSync(fixture.path);
    try {
      const cleared = direct.prepare("UPDATE runs SET claim_result_json = NULL WHERE run_id = ?")
        .run(first.run.runId);
      assert.equal(Number(cleared.changes), 1);
    } finally {
      direct.close();
    }

    restarted = await TaskBoard.open(config(fixture.path));
    const replay = restarted.claimRun(fixture.engineer.agentId, request);
    assert.ok(replay);
    assert.deepEqual(replay.context, first.context);
    assert.equal(replay.run.runId, first.run.runId);
    const settled = restarted.settleRun(first.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: "The legacy replay fallback returned the active run.",
    });
    assert.equal(settled.run.status, "failed");
  } finally {
    if (fixtureOpen) fixture.board.close();
    restarted?.close();
  }
});

test("explicit work-item intake plans, confirms, executes, and completes without manual workflow API calls", async () => {
  const fixture = await boardFixture();
  try {
    const verifier = fixture.board.createAgent(fixture.project.projectId, {
      agentId: "verifier-one",
      role: "verifier",
      area: "independent-verification",
      mission: "Verify confirmed acceptance criteria from durable evidence.",
      model: "codex-mini",
      token: "task-board-verifier-token-0123456789",
    });
    fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
      agentTypes: [
        {
          agentTypeId: "implementer", name: "Implementer", description: "Implements confirmed work.",
          role: "engineer", supplementalInstructions: "Implement only the confirmed node.",
          skillIds: ["cicada-software-implementation"], evaluatorProfile: "tests", enabled: true,
        },
        {
          agentTypeId: "verifier", name: "Verifier", description: "Verifies completed work.",
          role: "verifier", supplementalInstructions: "Verify every acceptance criterion independently.",
          skillIds: ["cicada-outcome-evaluation"], evaluatorProfile: "tests", enabled: true,
        },
      ],
      stages: automationStages({
        implementation: { kind: "agent_type", agentTypeId: "implementer" },
        verification: { kind: "agent_type", agentTypeId: "verifier" },
      }),
    }));
    const created = fixture.board.createWorkItem(workItemRequest({
      originalRequest: "Make checkout retries idempotent.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }), "complete-workflow-intake-0001");
    const planningTask = fixture.board.startWorkItemPlanning(created.workItem.workItemId);
    assert.equal(planningTask?.assignedAgentId, fixture.manager.agentId);
    const planningClaim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "complete-workflow-plan-0001",
      messageCursor: null,
    });
    assert.ok(planningClaim);
    fixture.board.settleRun(planningClaim.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "Proposed one bounded implementation node.",
      workflowPlan: {
        objective: "Make checkout retries idempotent.",
        assumptions: ["The checkout repository is available."],
        acceptanceCriteria: ["Repeated retries create one charge."],
        nodes: [{
          nodeId: "idempotent-checkout",
          title: "Implement idempotent checkout",
          objective: "Prevent duplicate charges during retry.",
          acceptanceCriteria: ["Focused retry tests pass."],
          dependencyNodeIds: [],
          stageTemplate: ["implementation", "verification"],
        }],
      },
    });
    const proposed = fixture.board.projectWorkflow(fixture.project.projectId);
    assert.equal(proposed.plans[0]?.state, "proposed");
    assert.equal(fixture.board.requireWorkItem(created.workItem.workItemId).state, "waiting_for_human_review");
    fixture.board.confirmWorkflow(proposed.plans[0]!.planRevisionId, { expectedState: "proposed" });

    const implementation = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "complete-workflow-implementation-0001",
      messageCursor: null,
    });
    assert.ok(implementation);
    assert.equal(implementation.context.workflow?.stage, "implementation");
    assert.deepEqual(implementation.context.workflow?.skills.map((skill) => skill.skillId), ["cicada-software-implementation"]);
    fixture.board.settleRun(implementation.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Retry tests pass and duplicate charges are prevented.",
    });

    const verification = fixture.board.claimRun(verifier.agentId, {
      claimId: "complete-workflow-verification-0001",
      messageCursor: null,
    });
    assert.ok(verification);
    assert.equal(verification.context.workflow?.stage, "verification");
    assert.deepEqual(verification.context.workflow?.skills.map((skill) => skill.skillId), ["cicada-outcome-evaluation"]);
    fixture.board.settleRun(verification.run.runId, verifier.agentId, {
      outcome: "completed",
      result: "The focused evidence satisfies the confirmed criterion.",
    });
    const completed = fixture.board.requireWorkItem(created.workItem.workItemId);
    assert.equal(completed.state, "completed");
    assert.ok(completed.endedAt);
    assert.equal(fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]?.state, "completed");
  } finally {
    fixture.board.close();
  }
});

test("contradictory handoff validation leaves an active workflow run settleable", async () => {
  const fixture = await activeSettlementWorkflow("handoff-mismatch");
  try {
    const initialNodeVersion = fixture.node.version;
    assert.throws(
      () => fixture.board.settleRun(fixture.claim.run.runId, fixture.verifier.agentId, {
        outcome: "failed",
        result: "Verification failed before settlement.",
        handoff: settlementHandoff("passed"),
      }),
      (error: unknown) => (
        error instanceof TaskBoardError &&
        error.status === 400 &&
        error.code === "HANDOFF_OUTCOME_MISMATCH"
      ),
    );

    const rejectedSnapshot = fixture.board.snapshot(fixture.project.projectId);
    assert.equal(rejectedSnapshot.recentRuns.find((run) => run.runId === fixture.claim.run.runId)?.status, "active");
    assert.equal(fixture.board.requireTask(fixture.claim.task!.taskId).status, "in_progress");
    assert.equal(fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]?.state, "active");
    assert.equal(fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]?.version, initialNodeVersion);

    assert.throws(
      () => fixture.board.settleRun(fixture.claim.run.runId, fixture.verifier.agentId, {
        outcome: "failed",
        result: "Verification failed before settlement.",
        handoff: { ...settlementHandoff("failed"), artifactIds: ["missing-settlement-artifact"] },
      }),
      (error: unknown) => (
        error instanceof TaskBoardError &&
        error.status === 400 &&
        error.code === "HANDOFF_ARTIFACT_INVALID"
      ),
    );
    assert.equal(fixture.board.snapshot(fixture.project.projectId).recentRuns.find((run) => run.runId === fixture.claim.run.runId)?.status, "active");
    assert.equal(fixture.board.requireTask(fixture.claim.task!.taskId).status, "in_progress");
    assert.equal(fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]?.state, "active");

    const settled = fixture.board.settleRun(fixture.claim.run.runId, fixture.verifier.agentId, {
      outcome: "failed",
      result: "Verification failed before settlement.",
      handoff: settlementHandoff("failed"),
    });
    assert.equal(settled.duplicate, false);
    assert.equal(settled.run.status, "failed");
    assert.equal(fixture.board.requireTask(fixture.claim.task!.taskId).status, "blocked");
    const workflow = fixture.board.projectWorkflow(fixture.project.projectId);
    assert.equal(workflow.nodes[0]?.state, "blocked");
    assert.equal(workflow.handoffs[0]?.outcome, "failed");
  } finally {
    fixture.board.close();
  }
});

test("a completed planning run missing workflowPlan remains active and accepts a corrected retry", async () => {
  const fixture = await boardFixture();
  try {
    fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
      agentTypes: [{
        agentTypeId: "planning-verifier",
        name: "Planning verifier",
        description: "Executes planned verification nodes.",
        role: "verifier",
        supplementalInstructions: "Verify the confirmed workflow node.",
        skillIds: [],
        evaluatorProfile: "tests",
        enabled: true,
      }],
      stages: automationStages({
        verification: { kind: "agent_type", agentTypeId: "planning-verifier" },
      }),
    }));
    const workItem = fixture.board.createWorkItem(workItemRequest({
      originalRequest: "Plan an atomic settlement verification.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }), "atomic-settlement-planning-required").workItem;
    const planningTask = fixture.board.startWorkItemPlanning(workItem.workItemId);
    assert.ok(planningTask);
    const claim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-atomic-settlement-planning-required",
      messageCursor: null,
    });
    assert.ok(claim);
    const pendingWakeup = fixture.board.resumeAgent(fixture.manager.agentId, {
      reason: "Retry planning after the active run finishes.",
      taskId: planningTask.taskId,
    }, "atomic-settlement-planning-pending-wakeup").wakeup;
    assert.equal(pendingWakeup.claimedAt, null);
    assert.equal(pendingWakeup.runId, null);

    assert.throws(
      () => fixture.board.settleRun(claim.run.runId, fixture.manager.agentId, {
        outcome: "completed",
        result: "The plan is complete but was omitted from this request.",
      }),
      (error: unknown) => (
        error instanceof TaskBoardError &&
        error.status === 400 &&
        error.code === "WORKFLOW_PLAN_REQUIRED"
      ),
    );
    assert.equal(fixture.board.snapshot(fixture.project.projectId).recentRuns.find((run) => run.runId === claim.run.runId)?.status, "active");
    assert.equal(fixture.board.requireTask(planningTask.taskId).status, "in_progress");
    assert.equal(fixture.board.requireWorkItem(workItem.workItemId).state, "processing");
    const { DatabaseSync } = await import("node:sqlite");
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const persistedWakeup = inspected.prepare(
        "SELECT claimed_at,run_id FROM wakeups WHERE wakeup_id=?",
      ).get(pendingWakeup.wakeupId);
      assert.ok(persistedWakeup);
      assert.equal(persistedWakeup.claimed_at, null);
      assert.equal(persistedWakeup.run_id, null);
    } finally {
      inspected.close();
    }

    const settled = fixture.board.settleRun(claim.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "The corrected request includes the completed plan.",
      workflowPlan: {
        objective: "Verify atomic run settlement.",
        assumptions: [],
        acceptanceCriteria: ["Run and workflow states settle together."],
        nodes: [{
          nodeId: "verify-atomic-settlement",
          title: "Verify atomic settlement",
          objective: "Inspect the terminal run, task, and workflow state.",
          acceptanceCriteria: ["All persisted states agree."],
          dependencyNodeIds: [],
          stageTemplate: ["verification"],
        }],
      },
    });
    assert.equal(settled.duplicate, false);
    assert.equal(settled.run.status, "completed");
    assert.equal(fixture.board.requireTask(planningTask.taskId).status, "completed");
    assert.equal(fixture.board.requireWorkItem(workItem.workItemId).state, "waiting_for_human_review");
    assert.equal(fixture.board.projectWorkflow(fixture.project.projectId).plans[0]?.state, "proposed");
  } finally {
    fixture.board.close();
  }
});

test("a duplicate settle repairs a terminal run whose workflow node is still active", async () => {
  const fixture = await activeSettlementWorkflow("retry-repair");
  const result = "Atomic settlement completed before the worker crashed.";
  const taskId = fixture.claim.task!.taskId;
  fixture.board.close();

  const { DatabaseSync } = await import("node:sqlite");
  const partial = new DatabaseSync(fixture.path);
  try {
    partial.exec("PRAGMA foreign_keys = ON");
    partial.prepare("UPDATE runs SET status='completed',ended_at=?,result=? WHERE run_id=? AND status='active'")
      .run("2026-07-19T20:05:00.000Z", result, fixture.claim.run.runId);
    partial.prepare(`
      UPDATE tasks
      SET status='completed',ended_at=?,result=?,version=version+1,updated_at=?
      WHERE task_id=? AND ended_at IS NULL
    `).run("2026-07-19T20:05:00.000Z", result, "2026-07-19T20:05:00.000Z", taskId);
  } finally {
    partial.close();
  }

  const restarted = await TaskBoard.open(config(fixture.path));
  try {
    assert.equal(restarted.projectWorkflow(fixture.project.projectId).nodes[0]?.state, "active");
    const replay = restarted.settleRun(fixture.claim.run.runId, fixture.verifier.agentId, {
      outcome: "completed",
      result,
      handoff: settlementHandoff("passed"),
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.run.status, "completed");
    const repaired = restarted.projectWorkflow(fixture.project.projectId);
    assert.equal(repaired.nodes[0]?.state, "completed");
    assert.equal(repaired.handoffs.length, 1);
    assert.equal(repaired.handoffs[0]?.taskId, taskId);
  } finally {
    restarted.close();
  }
});

test("an old duplicate settle does not repair a workflow after the task has resumed", async () => {
  const fixture = await activeSettlementWorkflow("moved-on-retry");
  const oldResult = "The first verification run failed before workflow settlement.";
  const taskId = fixture.claim.task!.taskId;
  fixture.board.close();

  const { DatabaseSync } = await import("node:sqlite");
  const partial = new DatabaseSync(fixture.path);
  try {
    partial.exec("PRAGMA foreign_keys = ON");
    partial.prepare("UPDATE runs SET status='failed',ended_at=?,result=? WHERE run_id=? AND status='active'")
      .run("2026-07-19T20:05:00.000Z", oldResult, fixture.claim.run.runId);
    partial.prepare(`
      UPDATE tasks
      SET status='blocked',ended_at=NULL,result=NULL,version=version+1,updated_at=?
      WHERE task_id=? AND ended_at IS NULL
    `).run("2026-07-19T20:05:00.000Z", taskId);
  } finally {
    partial.close();
  }

  const restarted = await TaskBoard.open(config(fixture.path));
  try {
    const beforeResume = restarted.projectWorkflow(fixture.project.projectId).nodes[0]!;
    assert.equal(beforeResume.state, "active");
    restarted.resumeAgent(fixture.verifier.agentId, {
      reason: "Retry the failed verification task.",
      taskId,
    }, "resume-atomic-settlement-moved-on-retry");
    const newer = restarted.claimRun(fixture.verifier.agentId, {
      claimId: "claim-atomic-settlement-moved-on-retry-newer",
      messageCursor: null,
    });
    assert.ok(newer);
    assert.equal(newer.task?.taskId, taskId);
    assert.equal(newer.task.status, "in_progress");

    const replay = restarted.settleRun(fixture.claim.run.runId, fixture.verifier.agentId, {
      outcome: "failed",
      result: oldResult,
      handoff: settlementHandoff("failed"),
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.run.status, "failed");
    const afterReplay = restarted.projectWorkflow(fixture.project.projectId);
    assert.equal(afterReplay.nodes[0]?.state, "active");
    assert.equal(afterReplay.nodes[0]?.version, beforeResume.version);
    assert.equal(afterReplay.handoffs.length, 0);
    assert.equal(restarted.snapshot(fixture.project.projectId).recentRuns.find((run) => run.runId === newer.run.runId)?.status, "active");
    assert.equal(restarted.requireTask(taskId).status, "in_progress");

    const settled = restarted.settleRun(newer.run.runId, fixture.verifier.agentId, {
      outcome: "completed",
      result: "The resumed verification completed successfully.",
      handoff: settlementHandoff("passed"),
    });
    assert.equal(settled.duplicate, false);
    assert.equal(settled.run.status, "completed");
    assert.equal(restarted.requireTask(taskId).status, "completed");
    const completed = restarted.projectWorkflow(fixture.project.projectId);
    assert.equal(completed.nodes[0]?.state, "completed");
    assert.equal(completed.handoffs.length, 1);
    assert.equal(completed.handoffs[0]?.outcome, "passed");
  } finally {
    restarted.close();
  }
});

test("a completed run with a valid handoff settles its workflow node", async () => {
  const fixture = await activeSettlementWorkflow("happy-path");
  try {
    const settled = fixture.board.settleRun(fixture.claim.run.runId, fixture.verifier.agentId, {
      outcome: "completed",
      result: "Atomic settlement behavior is verified.",
      handoff: settlementHandoff("passed"),
    });
    assert.equal(settled.duplicate, false);
    assert.equal(settled.run.status, "completed");
    assert.equal(fixture.board.requireTask(fixture.claim.task!.taskId).status, "completed");
    const workflow = fixture.board.projectWorkflow(fixture.project.projectId);
    assert.equal(workflow.nodes[0]?.state, "completed");
    assert.equal(workflow.handoffs.length, 1);
    assert.equal(workflow.handoffs[0]?.outcome, "passed");
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "completed");

    const replay = fixture.board.settleRun(fixture.claim.run.runId, fixture.verifier.agentId, {
      outcome: "completed",
      result: "Atomic settlement behavior is verified.",
      handoff: settlementHandoff("passed"),
    });
    assert.equal(replay.duplicate, true);
    const replayedWorkflow = fixture.board.projectWorkflow(fixture.project.projectId);
    assert.equal(replayedWorkflow.nodes[0]?.version, workflow.nodes[0]?.version);
    assert.equal(replayedWorkflow.handoffs.length, 1);
  } finally {
    fixture.board.close();
  }
});

test("work items preserve original intake, resolve explicit projects, and enforce idempotent CAS updates", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const automaticRequest = { originalRequest: "Investigate checkout retries before choosing a project." };
  const automatic = fixture.board.createWorkItem(automaticRequest, "work-item-create-auto-0001");
  assert.equal(automatic.duplicate, false);
  assert.equal(automatic.workItem.priority, "normal");
  assert.deepEqual(automatic.workItem.projectTarget, { mode: "auto" });
  assert.equal(automatic.workItem.resolvedProjectId, null);
  assert.equal(automatic.workItem.state, "submitted");
  assert.equal(automatic.workItem.currentStage, "refinement");
  assert.equal(automatic.workItem.refinedObjective, null);
  assert.equal(automatic.workItem.createdBy, "human:alice");
  assert.equal(automatic.workItem.version, 1);

  const replay = fixture.board.createWorkItem(automaticRequest, "work-item-create-auto-0001");
  assert.equal(replay.duplicate, true);
  assert.equal(replay.workItem.workItemId, automatic.workItem.workItemId);
  assert.throws(
    () => fixture.board.createWorkItem(
      { originalRequest: "A different request." },
      "work-item-create-auto-0001",
    ),
    (error: unknown) => error instanceof TaskBoardError && error.code === "IDEMPOTENCY_CONFLICT",
  );

  const explicit = fixture.board.createWorkItem(workItemRequest({
    priority: "urgent",
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), "work-item-create-explicit-0001");
  assert.deepEqual(explicit.workItem.projectTarget, { mode: "explicit", projectId: fixture.project.projectId });
  assert.equal(explicit.workItem.resolvedProjectId, fixture.project.projectId);
  assert.equal(fixture.board.listWorkItems()[0]?.workItemId, explicit.workItem.workItemId);

  const targeted = fixture.board.updateWorkItem(automatic.workItem.workItemId, {
    version: automatic.workItem.version,
    priority: "high",
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  });
  assert.equal(targeted.version, 2);
  assert.equal(targeted.priority, "high");
  assert.equal(targeted.resolvedProjectId, fixture.project.projectId);
  assert.equal(targeted.originalRequest, automaticRequest.originalRequest);
  assert.throws(
    () => fixture.board.updateWorkItem(automatic.workItem.workItemId, {
      version: automatic.workItem.version,
      priority: "low",
    }),
    (error: unknown) => error instanceof TaskBoardError && error.code === "WORK_ITEM_VERSION_CONFLICT",
  );
  assert.throws(
    () => fixture.board.createWorkItem(workItemRequest({
      projectTarget: { mode: "explicit", projectId: "missing-project" },
    }), "work-item-missing-project-0001"),
    (error: unknown) => error instanceof TaskBoardError && error.code === "PROJECT_NOT_FOUND",
  );
  fixture.board.close();

  const { DatabaseSync } = await import("node:sqlite");
  const direct = new DatabaseSync(path);
  try {
    assert.throws(
      () => direct.prepare("UPDATE work_items SET original_request = ? WHERE work_item_id = ?")
        .run("Replace the accepted request.", automatic.workItem.workItemId),
      /WORK_ITEM_ORIGINAL_REQUEST_IMMUTABLE/u,
    );
    assert.equal(Number(direct.prepare("PRAGMA user_version").get()?.user_version), 13);
  } finally {
    direct.close();
  }

  const restarted = await TaskBoard.open(config(path));
  try {
    assert.equal(restarted.requireWorkItem(automatic.workItem.workItemId).originalRequest, automaticRequest.originalRequest);
    assert.equal(restarted.listWorkItems().length, 2);
  } finally {
    restarted.close();
  }
});

test("duplicate work-item intake repairs a legacy linkless planning task and makes its run settleable", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const request = workItemRequest({
    originalRequest: "Repair a planning task orphaned before its work-item link committed.",
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  });
  const idempotencyKey = "work-item-planning-legacy-repair-0001";
  let board: TaskBoard | null = fixture.board;
  try {
    board.updateAutomationConfiguration(automationConfigurationRequest({
      agentTypes: [{
        agentTypeId: "planning-repair-verifier",
        name: "Planning repair verifier",
        description: "Verifies the workflow proposed by the repaired planning task.",
        role: "verifier",
        supplementalInstructions: "Verify the repaired planning workflow.",
        skillIds: [],
        evaluatorProfile: "tests",
        enabled: true,
      }],
      stages: automationStages({
        verification: { kind: "agent_type", agentTypeId: "planning-repair-verifier" },
      }),
    }));
    const created = board.createWorkItem(request, idempotencyKey).workItem;
    const legacyPlanningTask = board.startWorkItemPlanning(created.workItemId);
    assert.ok(legacyPlanningTask);
    board.close();
    board = null;

    const { DatabaseSync } = await import("node:sqlite");
    const partial = new DatabaseSync(path);
    try {
      partial.exec("PRAGMA foreign_keys = ON");
      const removedLink = partial.prepare("DELETE FROM work_item_planning_tasks WHERE work_item_id=?")
        .run(created.workItemId);
      assert.equal(Number(removedLink.changes), 1);
      const restoredSubmittedItem = partial.prepare(`
        UPDATE work_items
        SET state='submitted',current_stage='refinement',version=?,updated_at=?
        WHERE work_item_id=?
      `).run(created.version, created.updatedAt, created.workItemId);
      assert.equal(Number(restoredSubmittedItem.changes), 1);
      assert.equal(
        partial.prepare("SELECT COUNT(*) AS count FROM tasks WHERE task_id=?").get(legacyPlanningTask.taskId)?.count,
        1,
      );
      assert.equal(
        partial.prepare("SELECT COUNT(*) AS count FROM wakeups WHERE task_id=? AND claimed_at IS NULL").get(legacyPlanningTask.taskId)?.count,
        1,
      );
    } finally {
      partial.close();
    }

    board = await TaskBoard.open(config(path));
    const replay = postWorkItem(board, request, idempotencyKey);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.workItem.workItemId, created.workItemId);
    assert.equal(replay.workItem.state, "processing");
    assert.equal(replay.workItem.currentStage, "planning");

    const inspected = new DatabaseSync(path, { readOnly: true });
    try {
      const link = inspected.prepare("SELECT task_id FROM work_item_planning_tasks WHERE work_item_id=?")
        .get(created.workItemId);
      assert.equal(link?.task_id, legacyPlanningTask.taskId);
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM tasks WHERE objective=?").get(request.originalRequest)?.count, 1);
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM wakeups WHERE task_id=?").get(legacyPlanningTask.taskId)?.count, 1);
    } finally {
      inspected.close();
    }

    const claim = board.claimRun(fixture.manager.agentId, {
      claimId: "claim-work-item-planning-legacy-repair-0001",
      messageCursor: null,
    });
    assert.ok(claim);
    assert.equal(claim.task?.taskId, legacyPlanningTask.taskId);
    board.settleRun(claim.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "The repaired planning task returned a valid workflow.",
      workflowPlan: {
        objective: "Keep planning-task creation and linkage atomic.",
        assumptions: [],
        acceptanceCriteria: ["A planning run always has its durable work-item link."],
        nodes: [{
          nodeId: "verify-repaired-planning-link",
          title: "Verify repaired planning link",
          objective: "Confirm the legacy planning task can settle with a workflow plan.",
          acceptanceCriteria: ["Settlement proposes the workflow without a link error."],
          dependencyNodeIds: [],
          stageTemplate: ["verification"],
        }],
      },
    });
    assert.equal(board.requireWorkItem(created.workItemId).state, "waiting_for_human_review");
  } finally {
    board?.close();
  }
});

test("duplicate work-item intake replaces a settled legacy planning orphan", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const request = workItemRequest({
    originalRequest: "Replace a planning orphan that already settled as ordinary work.",
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  });
  const idempotencyKey = "work-item-planning-settled-orphan-0001";
  let board: TaskBoard | null = fixture.board;
  try {
    board.updateAutomationConfiguration(automationConfigurationRequest({
      agentTypes: [{
        agentTypeId: "settled-orphan-verifier",
        name: "Settled orphan verifier",
        description: "Verifies the replacement workflow from a fresh planning task.",
        role: "verifier",
        supplementalInstructions: "Verify the replacement planning workflow.",
        skillIds: [],
        evaluatorProfile: "tests",
        enabled: true,
      }],
      stages: automationStages({
        verification: { kind: "agent_type", agentTypeId: "settled-orphan-verifier" },
      }),
    }));
    const created = board.createWorkItem(request, idempotencyKey).workItem;
    const legacyPlanningTask = board.startWorkItemPlanning(created.workItemId);
    assert.ok(legacyPlanningTask);
    const legacyClaim = board.claimRun(fixture.manager.agentId, {
      claimId: "claim-work-item-planning-settled-orphan-0001",
      messageCursor: null,
    });
    assert.ok(legacyClaim);
    board.close();
    board = null;

    const { DatabaseSync } = await import("node:sqlite");
    const partial = new DatabaseSync(path);
    try {
      partial.exec("PRAGMA foreign_keys = ON");
      assert.equal(
        Number(partial.prepare("DELETE FROM work_item_planning_tasks WHERE work_item_id=?").run(created.workItemId).changes),
        1,
      );
      assert.equal(Number(partial.prepare(`
        UPDATE work_items
        SET state='submitted',current_stage='refinement',version=?,updated_at=?
        WHERE work_item_id=?
      `).run(created.version, created.updatedAt, created.workItemId).changes), 1);
    } finally {
      partial.close();
    }

    board = await TaskBoard.open(config(path));
    const originalExec = DatabaseSync.prototype.exec;
    const originalPrepare = DatabaseSync.prototype.prepare;
    let settleTransactionOpen = false;
    let planningReadInSettleTransaction: boolean | null = null;
    DatabaseSync.prototype.exec = function trackingSettleTransaction(this: DatabaseSyncType, sql: string): void {
      const statement = sql.trim().replace(/;$/u, "").toUpperCase();
      originalExec.call(this, sql);
      if (statement === "BEGIN IMMEDIATE") settleTransactionOpen = true;
      if (statement === "COMMIT" || statement === "ROLLBACK") settleTransactionOpen = false;
    };
    DatabaseSync.prototype.prepare = function trackingPlanningRead(this: DatabaseSyncType, sql: string) {
      if (planningReadInSettleTransaction === null && /FROM work_item_planning_tasks link[\s\S]*WHERE link\.task_id=\?/u.test(sql)) {
        planningReadInSettleTransaction = settleTransactionOpen;
      }
      return originalPrepare.call(this, sql);
    };
    try {
      const settled = board.settleRun(legacyClaim.run.runId, fixture.manager.agentId, {
        outcome: "completed",
        result: "The unlinked orphan settled as ordinary completed work.",
      });
      assert.equal(settled.run.status, "completed");
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
      DatabaseSync.prototype.exec = originalExec;
    }
    assert.equal(planningReadInSettleTransaction, true);
    assert.equal(board.requireTask(legacyPlanningTask.taskId).status, "completed");
    assert.ok(board.requireTask(legacyPlanningTask.taskId).endedAt);

    const replay = postWorkItem(board, request, idempotencyKey);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.workItem.state, "processing");
    assert.equal(replay.workItem.currentStage, "planning");

    const inspected = new DatabaseSync(path, { readOnly: true });
    let replacementTaskId = "";
    try {
      const replacement = inspected.prepare(`
        SELECT link.task_id,task.status,task.ended_at,wakeup.claimed_at
        FROM work_item_planning_tasks link
        JOIN tasks task ON task.task_id=link.task_id
        JOIN wakeups wakeup ON wakeup.task_id=task.task_id
        WHERE link.work_item_id=?
      `).get(created.workItemId);
      assert.ok(replacement);
      replacementTaskId = String(replacement.task_id);
      assert.notEqual(replacementTaskId, legacyPlanningTask.taskId);
      assert.equal(replacement.status, "queued");
      assert.equal(replacement.ended_at, null);
      assert.equal(replacement.claimed_at, null);
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM tasks WHERE objective=?").get(request.originalRequest)?.count, 2);
    } finally {
      inspected.close();
    }

    const replacementClaim = board.claimRun(fixture.manager.agentId, {
      claimId: "claim-work-item-planning-replacement-0001",
      messageCursor: null,
    });
    assert.ok(replacementClaim);
    assert.equal(replacementClaim.task?.taskId, replacementTaskId);
    board.settleRun(replacementClaim.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "The replacement task returned a valid workflow.",
      workflowPlan: {
        objective: "Replace a settled planning orphan safely.",
        assumptions: [],
        acceptanceCriteria: ["Only the fresh runnable planning task is linked."],
        nodes: [{
          nodeId: "verify-settled-orphan-replacement",
          title: "Verify settled orphan replacement",
          objective: "Confirm a fresh planning task supplied the workflow.",
          acceptanceCriteria: ["The replacement plan reaches human review."],
          dependencyNodeIds: [],
          stageTemplate: ["verification"],
        }],
      },
    });
    assert.equal(board.requireWorkItem(created.workItemId).state, "waiting_for_human_review");
  } finally {
    board?.close();
  }
});

test("duplicate work-item intake ignores a legacy planning orphan with only a retired wakeup", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const request = workItemRequest({
    originalRequest: "Replace a planning orphan whose only wakeup was retired.",
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  });
  const idempotencyKey = "work-item-planning-retired-orphan-0001";
  let board: TaskBoard | null = fixture.board;
  try {
    const created = board.createWorkItem(request, idempotencyKey).workItem;
    const legacyPlanningTask = board.startWorkItemPlanning(created.workItemId);
    assert.ok(legacyPlanningTask);
    board.close();
    board = null;

    const { DatabaseSync } = await import("node:sqlite");
    const partial = new DatabaseSync(path);
    try {
      partial.exec("PRAGMA foreign_keys = ON");
      const wakeup = partial.prepare("SELECT wakeup_id FROM wakeups WHERE task_id=? AND claimed_at IS NULL")
        .get(legacyPlanningTask.taskId);
      assert.ok(wakeup);
      assert.equal(
        Number(partial.prepare("DELETE FROM work_item_planning_tasks WHERE work_item_id=?").run(created.workItemId).changes),
        1,
      );
      assert.equal(Number(partial.prepare(`
        UPDATE work_items
        SET state='submitted',current_stage='refinement',version=?,updated_at=?
        WHERE work_item_id=?
      `).run(created.version, created.updatedAt, created.workItemId).changes), 1);
      partial.prepare(`
        INSERT INTO task_events(
          event_id,project_id,task_id,actor_type,actor_id,event_type,data_json,created_at
        ) VALUES (?, ?, ?, 'system', 'test:wakeup-retirement', 'agent_wakeup_retired', '{}', ?)
      `).run(
        `retired-wakeup:${String(wakeup.wakeup_id)}`,
        fixture.project.projectId,
        legacyPlanningTask.taskId,
        created.updatedAt,
      );
    } finally {
      partial.close();
    }

    board = await TaskBoard.open(config(path));
    const replay = postWorkItem(board, request, idempotencyKey);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.workItem.state, "processing");

    const inspected = new DatabaseSync(path, { readOnly: true });
    try {
      const link = inspected.prepare("SELECT task_id FROM work_item_planning_tasks WHERE work_item_id=?")
        .get(created.workItemId);
      assert.ok(link);
      assert.notEqual(link.task_id, legacyPlanningTask.taskId);
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM tasks WHERE objective=?").get(request.originalRequest)?.count, 2);
      assert.equal(inspected.prepare(`
        SELECT COUNT(*) AS count
        FROM wakeups wakeup
        WHERE wakeup.task_id=?
          AND wakeup.claimed_at IS NULL
          AND NOT EXISTS(
            SELECT 1 FROM task_events event WHERE event.event_id='retired-wakeup:' || wakeup.wakeup_id
          )
      `).get(String(link.task_id))?.count, 1);
    } finally {
      inspected.close();
    }
  } finally {
    board?.close();
  }
});

test("planning-start failure rolls back its task, link, wakeup, and work-item mutation", async () => {
  const fixture = await boardFixture();
  try {
    const request = workItemRequest({
      originalRequest: "Roll back every planning-start write when the link insert fails.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    });
    const submitted = fixture.board.createWorkItem(request, "work-item-planning-rollback-0001").workItem;
    const { DatabaseSync } = await import("node:sqlite");
    const originalPrepare = DatabaseSync.prototype.prepare;
    let injected = false;
    DatabaseSync.prototype.prepare = function failingPlanningLink(this: DatabaseSyncType, sql: string) {
      if (/^\s*INSERT INTO work_item_planning_tasks/u.test(sql)) {
        injected = true;
        throw new Error("INJECTED_PLANNING_LINK_FAILURE");
      }
      return originalPrepare.call(this, sql);
    };
    try {
      assert.throws(
        () => fixture.board.startWorkItemPlanning(submitted.workItemId),
        /INJECTED_PLANNING_LINK_FAILURE/u,
      );
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
    }
    assert.equal(injected, true);
    assert.deepEqual(fixture.board.requireWorkItem(submitted.workItemId), submitted);

    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM work_item_planning_tasks WHERE work_item_id=?").get(submitted.workItemId)?.count, 0);
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM tasks WHERE objective=?").get(request.originalRequest)?.count, 0);
      assert.equal(inspected.prepare(`
        SELECT COUNT(*) AS count
        FROM wakeups wakeup
        JOIN tasks task ON task.task_id=wakeup.task_id
        WHERE task.objective=?
      `).get(request.originalRequest)?.count, 0);
    } finally {
      inspected.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("fresh work-item intake failure rolls back the item with all planning state", async () => {
  const fixture = await boardFixture();
  try {
    const request = workItemRequest({
      originalRequest: "Roll back fresh intake when its planning link cannot be inserted.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    });
    const idempotencyKey = "work-item-planning-fresh-rollback-0001";
    const { DatabaseSync } = await import("node:sqlite");
    const originalPrepare = DatabaseSync.prototype.prepare;
    let injected = false;
    DatabaseSync.prototype.prepare = function failingFreshPlanningLink(this: DatabaseSyncType, sql: string) {
      if (/^\s*INSERT INTO work_item_planning_tasks/u.test(sql)) {
        injected = true;
        throw new Error("INJECTED_PLANNING_LINK_FAILURE");
      }
      return originalPrepare.call(this, sql);
    };
    try {
      assert.throws(
        () => postWorkItem(fixture.board, request, idempotencyKey),
        /INJECTED_PLANNING_LINK_FAILURE/u,
      );
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
    }
    assert.equal(injected, true);

    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM work_items WHERE idempotency_key=?").get(idempotencyKey)?.count, 0);
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM tasks WHERE objective=?").get(request.originalRequest)?.count, 0);
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM work_item_planning_tasks").get()?.count, 0);
      assert.equal(inspected.prepare(`
        SELECT COUNT(*) AS count
        FROM wakeups wakeup
        JOIN tasks task ON task.task_id=wakeup.task_id
        WHERE task.objective=?
      `).get(request.originalRequest)?.count, 0);
    } finally {
      inspected.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("duplicate work-item intake on a healthy processing item is a pure no-op", async () => {
  const fixture = await boardFixture();
  try {
    const request = workItemRequest({
      originalRequest: "Keep a healthy planning intake unchanged on duplicate POST.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    });
    const created = postWorkItem(fixture.board, request, "work-item-planning-healthy-duplicate-0001");
    assert.equal(created.duplicate, false);
    assert.equal(created.workItem.state, "processing");
    const beforeItem = fixture.board.requireWorkItem(created.workItem.workItemId);
    const beforeSnapshot = fixture.board.snapshot(fixture.project.projectId);

    const replay = postWorkItem(fixture.board, request, "work-item-planning-healthy-duplicate-0001");
    assert.equal(replay.duplicate, true);
    assert.deepEqual(replay.workItem, beforeItem);
    assert.deepEqual(fixture.board.requireWorkItem(created.workItem.workItemId), beforeItem);
    assert.deepEqual(fixture.board.snapshot(fixture.project.projectId), beforeSnapshot);
  } finally {
    fixture.board.close();
  }
});

test("work-item POST atomically queues and links planning before the plan is settled", async () => {
  const fixture = await boardFixture();
  try {
    fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
      agentTypes: [{
        agentTypeId: "atomic-planning-verifier",
        name: "Atomic planning verifier",
        description: "Verifies a plan produced by atomic work-item intake.",
        role: "verifier",
        supplementalInstructions: "Verify the atomic planning workflow.",
        skillIds: [],
        evaluatorProfile: "tests",
        enabled: true,
      }],
      stages: automationStages({
        verification: { kind: "agent_type", agentTypeId: "atomic-planning-verifier" },
      }),
    }));
    const request = workItemRequest({
      originalRequest: "Create and link this planning task in one transaction.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    });
    const { DatabaseSync } = await import("node:sqlite");
    const originalExec = DatabaseSync.prototype.exec;
    let begins = 0;
    let commits = 0;
    let rollbacks = 0;
    DatabaseSync.prototype.exec = function trackingPlanningTransaction(this: DatabaseSyncType, sql: string): void {
      const statement = sql.trim().replace(/;$/u, "").toUpperCase();
      originalExec.call(this, sql);
      if (statement === "BEGIN IMMEDIATE") begins += 1;
      if (statement === "COMMIT") commits += 1;
      if (statement === "ROLLBACK") rollbacks += 1;
    };
    let created: ReturnType<TaskBoard["createWorkItem"]>;
    try {
      created = postWorkItem(fixture.board, request, "work-item-planning-atomic-happy-0001");
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
    assert.equal(begins, 1);
    assert.equal(commits, 1);
    assert.equal(rollbacks, 0);
    assert.equal(created.duplicate, false);
    assert.equal(created.workItem.state, "processing");
    assert.equal(created.workItem.currentStage, "planning");

    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    let planningTaskId = "";
    try {
      const planning = inspected.prepare(`
        SELECT link.task_id,task.status,wakeup.claimed_at,wakeup.run_id
        FROM work_item_planning_tasks link
        JOIN tasks task ON task.task_id=link.task_id
        JOIN wakeups wakeup ON wakeup.task_id=task.task_id
        WHERE link.work_item_id=?
      `).get(created.workItem.workItemId);
      assert.ok(planning);
      planningTaskId = String(planning.task_id);
      assert.equal(planning.status, "queued");
      assert.equal(planning.claimed_at, null);
      assert.equal(planning.run_id, null);
    } finally {
      inspected.close();
    }

    const claim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-work-item-planning-atomic-happy-0001",
      messageCursor: null,
    });
    assert.ok(claim);
    assert.equal(claim.task?.taskId, planningTaskId);
    fixture.board.settleRun(claim.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "Atomic work-item planning produced a valid plan.",
      workflowPlan: {
        objective: "Create work-item planning state atomically.",
        assumptions: [],
        acceptanceCriteria: ["The work item, task, wakeup, and link commit together."],
        nodes: [{
          nodeId: "verify-atomic-planning-intake",
          title: "Verify atomic planning intake",
          objective: "Inspect the committed planning state.",
          acceptanceCriteria: ["Every planning row is present and consistent."],
          dependencyNodeIds: [],
          stageTemplate: ["verification"],
        }],
      },
    });
    assert.equal(fixture.board.requireWorkItem(created.workItem.workItemId).state, "waiting_for_human_review");
  } finally {
    fixture.board.close();
  }
});

test("work-item CAS readback stays bound to its mutation while another connection is ready to update", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const competingBoard = await TaskBoard.open(config(path));
  try {
    const created = fixture.board.createWorkItem(
      { originalRequest: "Keep a successful work-item PATCH response transaction-bound." },
      "work-item-transaction-bound-0001",
    ).workItem;
    const { DatabaseSync } = await import("node:sqlite");
    const originalExec = DatabaseSync.prototype.exec;
    const originalPrepare = DatabaseSync.prototype.prepare;
    const activeTransactions = new WeakSet<DatabaseSyncType>();
    let interceptedUpdate = false;
    let updateWasTransactionProtected = false;
    let competingUpdateDuringReadback: ReturnType<TaskBoard["updateWorkItem"]> | null = null;
    let returned: ReturnType<TaskBoard["updateWorkItem"]> | undefined;

    DatabaseSync.prototype.exec = function trackedExec(this: DatabaseSyncType, sql: string): void {
      const statement = sql.trim().replace(/;$/u, "").toUpperCase();
      try {
        originalExec.call(this, sql);
        if (statement === "BEGIN IMMEDIATE") activeTransactions.add(this);
        if (statement === "COMMIT" || statement === "ROLLBACK") activeTransactions.delete(this);
      } catch (error) {
        if (statement === "BEGIN IMMEDIATE" || statement === "COMMIT" || statement === "ROLLBACK") {
          activeTransactions.delete(this);
        }
        throw error;
      }
    };
    DatabaseSync.prototype.prepare = function interleavingPrepare(this: DatabaseSyncType, sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (!interceptedUpdate && /^\s*UPDATE work_items SET/u.test(sql)) {
        interceptedUpdate = true;
        const updateConnection = this;
        const originalRun = statement.run.bind(statement) as (
          ...values: SQLInputValue[]
        ) => StatementResultingChanges;
        statement.run = ((...values: SQLInputValue[]): StatementResultingChanges => {
          const result = originalRun(...values);
          if (activeTransactions.has(updateConnection)) {
            updateWasTransactionProtected = true;
          } else {
            // This is the exact pre-fix window: the CAS write committed, but its
            // representation has not been read back yet on the first connection.
            competingUpdateDuringReadback = competingBoard.updateWorkItem(created.workItemId, {
              version: created.version + 1,
              priority: "low",
            });
          }
          return result;
        }) as typeof statement.run;
      }
      return statement;
    };

    try {
      returned = fixture.board.updateWorkItem(created.workItemId, {
        version: created.version,
        priority: "high",
      });
    } finally {
      DatabaseSync.prototype.exec = originalExec;
      DatabaseSync.prototype.prepare = originalPrepare;
    }

    assert.ok(interceptedUpdate);
    assert.equal(updateWasTransactionProtected, true);
    assert.equal(competingUpdateDuringReadback, null);
    assert.ok(returned);
    assert.equal(returned.version, created.version + 1);
    assert.equal(returned.priority, "high");

    const competingUpdate = competingBoard.updateWorkItem(created.workItemId, {
      version: returned.version,
      priority: "low",
    });
    assert.equal(competingUpdate.version, returned.version + 1);
    assert.equal(competingUpdate.priority, "low");
    assert.equal(fixture.board.requireWorkItem(created.workItemId).version, competingUpdate.version);
  } finally {
    competingBoard.close();
    fixture.board.close();
  }
});

test("work-item keyset pages preserve priority, terminal, timestamp, and id ordering without overlap", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  try {
    const active = Array.from({ length: 199 }, (_unused, index) => fixture.board.createWorkItem({
      originalRequest: `Paginated active work item ${index}`,
      priority: index < 70 ? "urgent" : index < 140 ? "high" : "opportunistic",
    }, `pagination-active-${index}`).workItem);
    const terminalUrgent = fixture.board.createWorkItem({
      originalRequest: "Paginated terminal urgent work item",
      priority: "urgent",
    }, "pagination-terminal-urgent").workItem;

    const { DatabaseSync } = await import("node:sqlite");
    const ordering = new DatabaseSync(path);
    try {
      ordering.prepare("UPDATE work_items SET created_at = ? WHERE work_item_id = ?")
        .run("2026-07-18T20:00:00.000Z", active[0]!.workItemId);
      ordering.prepare("UPDATE work_items SET created_at = ? WHERE work_item_id = ?")
        .run("2026-07-20T20:00:00.000Z", active[1]!.workItemId);
      ordering.prepare("UPDATE work_items SET state = 'completed', ended_at = ? WHERE work_item_id = ?")
        .run("2026-07-21T20:00:00.000Z", terminalUrgent.workItemId);
    } finally {
      ordering.close();
    }

    const exactPage = fixture.board.listWorkItemsPage();
    assert.equal(exactPage.workItems.length, WORK_ITEM_PAGE_SIZE);
    assert.equal(exactPage.nextCursor, undefined);
    assert.equal(exactPage.workItems[0]?.workItemId, active[0]?.workItemId);
    assert.equal(exactPage.workItems[69]?.workItemId, active[1]?.workItemId);
    assert.ok(exactPage.workItems.slice(0, 70).every((workItem) => workItem.priority === "urgent" && workItem.endedAt === null));
    assert.ok(exactPage.workItems.slice(70, 140).every((workItem) => workItem.priority === "high" && workItem.endedAt === null));
    assert.ok(exactPage.workItems.slice(140, 199).every((workItem) => workItem.priority === "opportunistic" && workItem.endedAt === null));
    assert.equal(exactPage.workItems[199]?.workItemId, terminalUrgent.workItemId);
    assert.ok(exactPage.workItems[199]?.endedAt);
    assert.deepEqual(
      fixture.board.listWorkItems().map((workItem) => workItem.workItemId),
      exactPage.workItems.map((workItem) => workItem.workItemId),
    );

    const terminalLow = fixture.board.createWorkItem({
      originalRequest: "Paginated terminal low-priority work item",
      priority: "low",
    }, "pagination-terminal-low").workItem;
    const terminal = new DatabaseSync(path);
    try {
      terminal.prepare("UPDATE work_items SET state = 'completed', ended_at = ? WHERE work_item_id = ?")
        .run("2026-07-21T20:01:00.000Z", terminalLow.workItemId);
    } finally {
      terminal.close();
    }

    const firstPage = fixture.board.listWorkItemsPage();
    assert.equal(firstPage.workItems.length, WORK_ITEM_PAGE_SIZE);
    assert.ok(firstPage.nextCursor);
    assert.deepEqual(
      firstPage.workItems.map((workItem) => workItem.workItemId),
      exactPage.workItems.map((workItem) => workItem.workItemId),
    );
    const secondPage = fixture.board.listWorkItemsPage(firstPage.nextCursor);
    assert.deepEqual(secondPage.workItems.map((workItem) => workItem.workItemId), [terminalLow.workItemId]);
    assert.equal(secondPage.nextCursor, undefined);
    const firstIds = new Set(firstPage.workItems.map((workItem) => workItem.workItemId));
    assert.ok(secondPage.workItems.every((workItem) => !firstIds.has(workItem.workItemId)));
    assert.equal(firstIds.size + secondPage.workItems.length, 201);
  } finally {
    fixture.board.close();
  }
});

test("dormant automation configuration persists atomically without creating executable work", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  fixture.board.createTask(fixture.project.projectId, taskRequest({
    assignedAgentId: null,
    assignedRole: null,
  }));
  const before = fixture.board.snapshot(fixture.project.projectId);
  const defaults = fixture.board.getAutomationConfiguration();
  assert.equal(defaults.configurationId, "company-default");
  assert.equal(defaults.version, 1);
  assert.equal(defaults.updatedBy, "system:steward-default");
  assert.deepEqual(defaults.agentTypes, []);
  assert.deepEqual(defaults.stages, automationStages());

  const managerType = {
    agentTypeId: "intake-manager",
    name: "Intake manager",
    description: "Refines requests and resolves project ownership.",
    role: "manager" as const,
    supplementalInstructions: "Preserve the original request and produce a bounded refinement.",
    skillIds: ["intake.refine", "project.resolve"],
    evaluatorProfile: "editorial" as const,
    enabled: true,
  };
  const engineerType = {
    agentTypeId: "implementation-engineer",
    name: "Implementation engineer",
    description: "Plans, implements, and tests project changes.",
    role: "engineer" as const,
    supplementalInstructions: "Use the project workspace and return concrete test evidence.",
    skillIds: ["code.edit", "tests.run"],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  const verifierType = {
    agentTypeId: "independent-verifier",
    name: "Independent verifier",
    description: "Checks the completed implementation independently.",
    role: "verifier" as const,
    supplementalInstructions: "Remain read-only and report evidence against the criteria.",
    skillIds: ["verification.review"],
    evaluatorProfile: "manual" as const,
    enabled: true,
  };
  const configured = fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
    agentTypes: [managerType, engineerType, verifierType],
    stages: automationStages({
      refinement: { kind: "agent_type", agentTypeId: managerType.agentTypeId },
      project_resolution: { kind: "agent_type", agentTypeId: managerType.agentTypeId },
      research: { kind: "agent_type", agentTypeId: engineerType.agentTypeId },
      planning: { kind: "agent_type", agentTypeId: engineerType.agentTypeId },
      implementation: { kind: "agent_type", agentTypeId: engineerType.agentTypeId },
      testing: { kind: "agent_type", agentTypeId: engineerType.agentTypeId },
      verification: { kind: "agent_type", agentTypeId: verifierType.agentTypeId },
    }),
  }));
  assert.equal(configured.version, 2);
  assert.equal(configured.createdAt, "1970-01-01T00:00:00.000Z");
  assert.equal(configured.updatedBy, "human:alice");
  assert.deepEqual(configured.agentTypes, [managerType, engineerType, verifierType]);
  const after = fixture.board.snapshot(fixture.project.projectId);
  assert.equal(after.tasks.length, before.tasks.length);
  assert.equal(after.recentRuns.length, before.recentRuns.length);
  assert.equal(after.recentEvents.length, before.recentEvents.length);

  assert.throws(
    () => fixture.board.updateAutomationConfiguration({
      version: defaults.version,
      agentTypes: configured.agentTypes,
      stages: configured.stages,
    }),
    (error: unknown) => error instanceof TaskBoardError && error.code === "AUTOMATION_CONFIGURATION_VERSION_CONFLICT",
  );
  assert.throws(
    () => fixture.board.updateAutomationConfiguration({
      version: configured.version,
      agentTypes: configured.agentTypes.map((agentType) => agentType.agentTypeId === managerType.agentTypeId
        ? { ...agentType, role: "engineer" as const }
        : agentType),
      stages: configured.stages.map((stage) => stage.executor.kind === "agent_type"
        && stage.executor.agentTypeId === managerType.agentTypeId
        ? { ...stage, executor: { kind: "disabled" as const } }
        : stage),
    }),
    (error: unknown) => error instanceof TaskBoardError && error.code === "AUTOMATION_AGENT_TYPE_ROLE_IMMUTABLE",
  );
  assert.deepEqual(fixture.board.getAutomationConfiguration(), configured);
  fixture.board.close();

  const { DatabaseSync } = await import("node:sqlite");
  const verified = new DatabaseSync(path);
  try {
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM automation_configuration").get()?.count, 1);
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM tasks").get()?.count, 1);
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM wakeups").get()?.count, 0);
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count, 0);
  } finally {
    verified.close();
  }

  const restarted = await TaskBoard.open(config(path));
  try {
    assert.deepEqual(restarted.getAutomationConfiguration(), configured);
  } finally {
    restarted.close();
  }
});

test("automation configuration enforces its exported 48 KiB UTF-8 aggregate boundary", async () => {
  const fixture = await boardFixture();
  try {
    const boundary = sizedAutomationConfiguration(AUTOMATION_CONFIGURATION_MAX_BYTES);
    assert.equal(
      Buffer.byteLength(JSON.stringify({ agentTypes: boundary.agentTypes, stages: boundary.stages }), "utf8"),
      AUTOMATION_CONFIGURATION_MAX_BYTES,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(boundary), "utf8") < 64 * 1_024);
    const configured = fixture.board.updateAutomationConfiguration(boundary);
    assert.equal(configured.version, 2);

    const nearBoundary = sizedAutomationConfiguration(AUTOMATION_CONFIGURATION_MAX_BYTES - 3);
    const multibyteAgentTypes = nearBoundary.agentTypes.map((agentType, index) => index === nearBoundary.agentTypes.length - 1
      ? { ...agentType, name: `${agentType.name}💥` }
      : agentType);
    const multibyteOversize = automationConfigurationRequest({
      version: configured.version,
      agentTypes: multibyteAgentTypes,
      stages: nearBoundary.stages,
    });
    assert.equal(
      Buffer.byteLength(JSON.stringify({
        agentTypes: multibyteOversize.agentTypes,
        stages: multibyteOversize.stages,
      }), "utf8"),
      AUTOMATION_CONFIGURATION_MAX_BYTES + 1,
    );
    assert.throws(
      () => fixture.board.updateAutomationConfiguration(multibyteOversize),
      (error: unknown) => error instanceof TaskBoardError && error.code === "INVALID_REQUEST",
    );
    assert.equal(fixture.board.getAutomationConfiguration().version, configured.version);
  } finally {
    fixture.board.close();
  }
});

test("automation configuration rejects unsafe stage references and registry identifiers", async () => {
  const fixture = await boardFixture();
  const managerType = {
    agentTypeId: "manager-type",
    name: "Manager type",
    description: "Coordinates non-production work.",
    role: "manager" as const,
    supplementalInstructions: "Coordinate the configured stage without expanding authority.",
    skillIds: ["project.coordinate"],
    evaluatorProfile: "manual" as const,
    enabled: true,
  };
  const engineerType = {
    ...managerType,
    agentTypeId: "engineer-type",
    name: "Engineer type",
    role: "engineer" as const,
  };
  const verifierType = {
    ...managerType,
    agentTypeId: "verifier-type",
    name: "Verifier type",
    role: "verifier" as const,
  };
  try {
    const incompatibleAssignments = [
      { stage: "refinement", agentType: engineerType },
      { stage: "project_resolution", agentType: verifierType },
      { stage: "research", agentType: managerType },
      { stage: "planning", agentType: verifierType },
      { stage: "implementation", agentType: managerType },
      { stage: "testing", agentType: managerType },
      { stage: "verification", agentType: engineerType },
    ] as const;
    for (const { stage, agentType } of incompatibleAssignments) {
      assert.throws(
        () => fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
          agentTypes: [agentType],
          stages: automationStages({ [stage]: { kind: "agent_type", agentTypeId: agentType.agentTypeId } }),
        })),
        (error: unknown) => error instanceof TaskBoardError && error.code === "INVALID_REQUEST",
      );
    }
    assert.throws(
      () => fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
        agentTypes: [{ ...managerType, enabled: false }],
        stages: automationStages({ research: { kind: "agent_type", agentTypeId: managerType.agentTypeId } }),
      })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "INVALID_REQUEST",
    );
    assert.throws(
      () => fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
        agentTypes: [managerType],
        stages: automationStages({ research: { kind: "agent_type", agentTypeId: "missing-type" } }),
      })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "INVALID_REQUEST",
    );
    assert.throws(
      () => fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
        agentTypes: [{ ...managerType, skillIds: ["https://skills.invalid/research"] }],
      })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "INVALID_REQUEST",
    );
    assert.throws(
      () => fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
        agentTypes: [{ ...managerType, supplementalInstructions: "" }],
      })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "INVALID_REQUEST",
    );
    assert.throws(
      () => fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
        agentTypes: Array.from({ length: 33 }, (_unused, index) => ({
          ...managerType,
          agentTypeId: `manager-type-${index}`,
        })),
      })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "INVALID_REQUEST",
    );
    assert.throws(
      () => fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
        agentTypes: [{
          ...managerType,
          skillIds: Array.from({ length: 33 }, (_unused, index) => `skill.${index}`),
        }],
      })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "INVALID_REQUEST",
    );
    assert.throws(
      () => fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
        agentTypes: [{ ...managerType, skillIds: ["project.coordinate", "project.coordinate"] }],
      })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "INVALID_REQUEST",
    );
    assert.throws(
      () => fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
        agentTypes: [managerType, { ...managerType, name: "Duplicate manager type" }],
      })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "INVALID_REQUEST",
    );
    const wrongReview = automationStages().map((stage) => stage.stage === "human_review"
      ? { ...stage, executor: { kind: "disabled" as const } }
      : stage);
    assert.throws(
      () => fixture.board.updateAutomationConfiguration(automationConfigurationRequest({ stages: wrongReview })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "INVALID_REQUEST",
    );
    const wrongDeployment = automationStages().map((stage) => stage.stage === "deployment"
      ? { ...stage, executor: { kind: "human" as const } }
      : stage);
    assert.throws(
      () => fixture.board.updateAutomationConfiguration(automationConfigurationRequest({ stages: wrongDeployment })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "INVALID_REQUEST",
    );
    assert.throws(
      () => fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
        stages: [...automationStages()].reverse(),
      })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "INVALID_REQUEST",
    );
    const verifierStages = fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
      agentTypes: [verifierType],
      stages: automationStages({
        research: { kind: "agent_type", agentTypeId: verifierType.agentTypeId },
        testing: { kind: "agent_type", agentTypeId: verifierType.agentTypeId },
      }),
    }));
    assert.equal(verifierStages.version, 2);
  } finally {
    fixture.board.close();
  }
});

test("projects, fixed agents, tasks, messages, and events survive a database restart", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const task = fixture.board.createTask(fixture.project.projectId, taskRequest());
  const claimed = fixture.board.claimRun(fixture.engineer.agentId, { claimId: "claim-persist-0001", messageCursor: null });
  assert.ok(claimed);
  const progress = fixture.board.appendAgentMessage(task.taskId, fixture.engineer.agentId, {
    clientEventId: "message-persist-0001",
    kind: "progress",
    body: "Retry research and the first test pass are complete.",
    runId: claimed.run.runId,
  });
  fixture.board.settleRun(claimed.run.runId, fixture.engineer.agentId, {
    outcome: "completed",
    result: "Research iteration completed.",
  });
  const progressReplay = fixture.board.appendAgentMessage(task.taskId, fixture.engineer.agentId, {
    clientEventId: "message-persist-0001",
    kind: "progress",
    body: "Retry research and the first test pass are complete.",
    runId: claimed.run.runId,
  });
  assert.equal(progressReplay.messageId, progress.messageId);
  fixture.board.close();

  const restarted = await TaskBoard.open(config(path));
  try {
    const snapshot = restarted.snapshot(fixture.project.projectId);
    assert.equal(snapshot.project.name, fixture.project.name);
    assert.equal(snapshot.agents.length, 2);
    assert.equal(snapshot.tasks.length, 2);
    const persistedWork = snapshot.tasks.find((item) => item.taskId === task.taskId);
    const persistedReview = snapshot.tasks.find((item) => item.kind === "manager_review");
    assert.equal(persistedWork?.kind, "work");
    assert.equal(persistedWork?.status, "completed");
    assert.equal(persistedWork?.result, "Research iteration completed.");
    assert.ok(persistedWork?.endedAt);
    assert.equal(persistedReview?.parentTaskId, task.taskId);
    assert.equal(persistedReview?.requiredRole, "manager");
    assert.equal(persistedReview?.assignedAgentId, fixture.manager.agentId);
    assert.equal(persistedReview?.status, "queued");
    assert.equal(snapshot.recentRuns[0]!.status, "completed");
    assert.equal(snapshot.recentRuns[0]!.taskId, task.taskId);
    assert.equal(restarted.listMessages(task.taskId).length, 1);
    assert.ok(snapshot.recentEvents.some((event) => event.eventType === "agent_run_settled"));
    assert.equal(restarted.authenticateAgent(AGENT_ONE_TOKEN, fixture.engineer.agentId).agentId, fixture.engineer.agentId);
    const reviewClaim = restarted.claimRun(fixture.manager.agentId, {
      claimId: "claim-persisted-review-handoff-0001",
      messageCursor: null,
    });
    assert.ok(reviewClaim);
    assert.equal(reviewClaim.wakeup.reason, "workflow_handoff");
    assert.equal(reviewClaim.wakeup.createdBy, "system:steward-review-workflow");
  } finally {
    restarted.close();
  }
});

test("human notes and task edits do not create a durable task wakeup", async () => {
  const fixture = await boardFixture();
  try {
    const backlog = fixture.board.createTask(fixture.project.projectId, taskRequest({
      assignedAgentId: null,
      assignedRole: null,
    }));
    fixture.board.appendHumanMessage(backlog.taskId, {
      clientEventId: "human-note-no-wake-0001",
      kind: "note",
      body: "Human context only; do not start an agent.",
    });
    assert.equal(fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-before-assignment-0001",
      messageCursor: null,
    }), null);

    fixture.board.updateTask(backlog.taskId, {
      version: backlog.version,
      assignedAgentId: fixture.engineer.agentId,
      assignedRole: fixture.engineer.role,
    }, { type: "human", id: "human:alice" });
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-assignment-0001",
      messageCursor: null,
    });
    assert.ok(claim);
    assert.equal(claim.wakeup.reason, "human_assignment");
    assert.equal(claim.task?.taskId, backlog.taskId);
    assert.equal(claim.run.taskId, backlog.taskId);
    assert.equal(fixture.board.snapshot(fixture.project.projectId).recentRuns[0]?.taskId, backlog.taskId);

    fixture.board.appendAgentMessage(backlog.taskId, fixture.engineer.agentId, {
      clientEventId: "agent-proposal-no-wake-0001",
      kind: "proposal",
      body: "Proposed follow-up; it must not wake any agent.",
      runId: claim.run.runId,
    });
    fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: "The first implementation attempt needs another pass.",
    });
    const blocked = fixture.board.requireTask(backlog.taskId);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.endedAt, null);
    assert.equal(blocked.result, null);
    const titleOnly = fixture.board.updateTask(backlog.taskId, {
      version: blocked.version,
      title: "Recover interrupted checkout safely",
    }, { type: "human", id: "human:alice" });
    assert.equal(titleOnly.version, blocked.version + 1);
    assert.equal(fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-messages-0001",
      messageCursor: null,
    }), null);
  } finally {
    fixture.board.close();
  }
});

test("held worker requests expose transient ref-counted connections without heartbeat events", async () => {
  const fixture = await boardFixture();
  try {
    const projectId = fixture.project.projectId;
    const agentId = fixture.engineer.agentId;
    const backlog = fixture.board.createTask(projectId, taskRequest({
      assignedAgentId: null,
      assignedRole: null,
    }));
    const eventsBeforeWaiting = fixture.board.snapshot(projectId).recentEvents.length;

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const abortedResult = await Promise.race([
      fixture.board.waitToClaimRun(
        agentId,
        { claimId: "claim-already-aborted-0001", messageCursor: null },
        30_000,
        alreadyAborted.signal,
      ),
      new Promise<"still_waiting">((resolve) => setImmediate(() => resolve("still_waiting"))),
    ]);
    assert.equal(abortedResult, null);
    assert.equal(fixture.board.snapshot(projectId).agents.find((agent) => agent.agentId === agentId)?.workerConnection, null);

    const firstClaimAbort = new AbortController();
    const secondClaimAbort = new AbortController();
    const firstClaim = fixture.board.waitToClaimRun(
      agentId,
      { claimId: "claim-held-first-0001", messageCursor: null },
      30_000,
      firstClaimAbort.signal,
    );
    const secondClaim = fixture.board.waitToClaimRun(
      agentId,
      { claimId: "claim-held-second-0001", messageCursor: null },
      30_000,
      secondClaimAbort.signal,
    );
    assert.equal(
      fixture.board.snapshot(projectId).agents.find((agent) => agent.agentId === agentId)?.workerConnection,
      "waiting_for_wake",
    );
    assert.equal(fixture.board.snapshot(projectId).recentEvents.length, eventsBeforeWaiting);

    firstClaimAbort.abort();
    assert.equal(await firstClaim, null);
    assert.equal(
      fixture.board.snapshot(projectId).agents.find((agent) => agent.agentId === agentId)?.workerConnection,
      "waiting_for_wake",
    );
    assert.equal(fixture.board.snapshot(projectId).recentEvents.length, eventsBeforeWaiting);

    fixture.board.updateTask(backlog.taskId, {
      version: backlog.version,
      assignedAgentId: agentId,
      assignedRole: fixture.engineer.role,
    }, { type: "human", id: "human:alice" });
    const claimed = await secondClaim;
    assert.ok(claimed);
    assert.equal(claimed.task?.taskId, backlog.taskId);
    assert.equal(claimed.context.agent.workerConnection, null);
    assert.equal(fixture.board.snapshot(projectId).agents.find((agent) => agent.agentId === agentId)?.workerConnection, null);

    const eventsBeforeWatching = fixture.board.snapshot(projectId).recentEvents.length;
    const firstWatchAbort = new AbortController();
    const secondWatchAbort = new AbortController();
    const firstWatch = fixture.board.waitForRunInterrupts(
      claimed.run.runId,
      agentId,
      0,
      30_000,
      firstWatchAbort.signal,
    );
    const secondWatch = fixture.board.waitForRunInterrupts(
      claimed.run.runId,
      agentId,
      0,
      30_000,
      secondWatchAbort.signal,
    );
    assert.equal(
      fixture.board.snapshot(projectId).agents.find((agent) => agent.agentId === agentId)?.workerConnection,
      "watching_run",
    );
    assert.equal(fixture.board.snapshot(projectId).recentEvents.length, eventsBeforeWatching);

    firstWatchAbort.abort();
    assert.equal(await firstWatch, null);
    assert.equal(
      fixture.board.snapshot(projectId).agents.find((agent) => agent.agentId === agentId)?.workerConnection,
      "watching_run",
    );
    assert.equal(fixture.board.snapshot(projectId).recentEvents.length, eventsBeforeWatching);

    fixture.board.interruptAgent(agentId, { reason: "Stop the connection registry test." }, "interrupt-held-watch-0001");
    const interrupt = await secondWatch;
    assert.equal(interrupt?.items[0]?.reason, "Stop the connection registry test.");
    assert.equal(fixture.board.snapshot(projectId).agents.find((agent) => agent.agentId === agentId)?.workerConnection, null);
    fixture.board.settleRun(claimed.run.runId, agentId, {
      outcome: "interrupted",
      result: "Stopped after testing transient worker connections.",
    });
  } finally {
    fixture.board.close();
  }
});

test("a human can return queued work to the backlog before its wake is claimed", async () => {
  const fixture = await boardFixture();
  try {
    const queued = fixture.board.createTask(fixture.project.projectId, taskRequest({
      title: "Correct queued work before execution",
    }));
    assert.equal(queued.status, "queued");
    assert.equal(queued.assignedAgentId, fixture.engineer.agentId);

    const corrected = fixture.board.updateTask(queued.taskId, {
      version: queued.version,
      assignedAgentId: null,
      assignedRole: null,
      status: "backlog",
    }, { type: "human", id: "human:alice" });
    assert.equal(corrected.status, "backlog");
    assert.equal(corrected.assignedAgentId, null);
    assert.equal(corrected.assignedRole, null);
    assert.equal(fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-queued-task-correction-0001",
      messageCursor: null,
    }), null);

    const retired = fixture.board.snapshot(fixture.project.projectId).recentEvents.find((event) => (
      event.taskId === queued.taskId &&
      event.eventType === "agent_wakeup_retired" &&
      event.data.retirementReason === "task_unassigned"
    ));
    assert.ok(retired);
  } finally {
    fixture.board.close();
  }
});

test("persisted stale wakeups are retired without blocking the next valid task", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const staleTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
    title: "Unassigned legacy task",
    assignedAgentId: null,
    assignedRole: null,
  }));
  fixture.board.resumeAgent(fixture.engineer.agentId, {
    reason: "Legacy resume created before assignment validation.",
    taskId: staleTask.taskId,
  }, "legacy-stale-resume-0001");
  const validTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
    title: "Valid work after stale wake",
  }));
  fixture.board.close();

  const restarted = await TaskBoard.open(config(path));
  try {
    const claimed = restarted.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-persisted-stale-wake-0001",
      messageCursor: null,
    });
    assert.ok(claimed);
    assert.equal(claimed.task?.taskId, validTask.taskId);
    assert.equal(restarted.resumeAgent(fixture.engineer.agentId, {
      reason: "Legacy resume created before assignment validation.",
      taskId: staleTask.taskId,
    }, "legacy-stale-resume-0001").duplicate, true);

    const retired = restarted.snapshot(fixture.project.projectId).recentEvents.find((event) => (
      event.eventType === "agent_wakeup_retired" && event.taskId === staleTask.taskId
    ));
    assert.equal(retired?.data.retirementReason, "task_unassigned");
    restarted.settleRun(claimed.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "The valid task completed after the stale wake was retired.",
    });
    assert.equal(restarted.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-retired-stale-wake-0002",
      messageCursor: null,
    }), null);
    assert.equal(
      restarted.snapshot(fixture.project.projectId).agents.find((agent) => agent.agentId === fixture.engineer.agentId)?.status,
      "idle",
    );
  } finally {
    restarted.close();
  }
});

test("reassignment and terminal decisions retire their pending wakes", async () => {
  const fixture = await boardFixture();
  try {
    const reassigned = fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Reassign before claim" }));
    fixture.board.updateTask(reassigned.taskId, {
      version: reassigned.version,
      assignedAgentId: fixture.manager.agentId,
      assignedRole: fixture.manager.role,
    }, { type: "human", id: "human:alice" });
    const cancelled = fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Cancel before claim" }));
    fixture.board.updateTask(cancelled.taskId, {
      version: cancelled.version,
      status: "cancelled",
      result: "The human cancelled this task before an agent started.",
    }, { type: "human", id: "human:alice" });
    const valid = fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Still valid engineer work" }));

    const engineerClaim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-reassignment-and-cancel-0001",
      messageCursor: null,
    });
    assert.ok(engineerClaim);
    assert.equal(engineerClaim.task?.taskId, valid.taskId);
    const managerClaim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-reassigned-manager-work-0001",
      messageCursor: null,
    });
    assert.ok(managerClaim);
    assert.equal(managerClaim.task?.taskId, reassigned.taskId);

    const reasons = fixture.board.snapshot(fixture.project.projectId).recentEvents
      .filter((event) => event.eventType === "agent_wakeup_retired")
      .map((event) => event.data.retirementReason);
    assert.ok(reasons.includes("task_reassigned"));
    assert.ok(reasons.includes("task_cancelled"));
    fixture.board.settleRun(engineerClaim.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: "Stopped after verifying wake retirement.",
    });
    fixture.board.settleRun(managerClaim.run.runId, fixture.manager.agentId, {
      outcome: "failed",
      result: "Stopped after verifying reassignment.",
    });
  } finally {
    fixture.board.close();
  }
});

test("the newest human trigger supersedes older unclaimed wakes for the same task", async () => {
  const fixture = await boardFixture();
  try {
    const task = fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Use only the latest trigger" }));
    const latest = fixture.board.resumeAgent(fixture.engineer.agentId, {
      reason: "Use the newest human direction for this task.",
      taskId: task.taskId,
    }, "newest-trigger-resume-0001");
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-newest-trigger-only-0001",
      messageCursor: null,
    });
    assert.ok(claim);
    assert.equal(claim.wakeup.wakeupId, latest.wakeup.wakeupId);
    assert.equal(claim.wakeup.reason, "human_resume");
    const retired = fixture.board.snapshot(fixture.project.projectId).recentEvents.find((event) => (
      event.eventType === "agent_wakeup_retired" && event.data.retirementReason === "superseded_by_preferred_wakeup"
    ));
    assert.equal(retired?.data.supersededByWakeupId, latest.wakeup.wakeupId);
    fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: "The newest trigger was handled once.",
    });
    assert.equal(fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-no-duplicate-trigger-0002",
      messageCursor: null,
    }), null);
  } finally {
    fixture.board.close();
  }
});

test("asking a question atomically releases the run and only the human answer wakes the agent", async () => {
  const fixture = await boardFixture();
  try {
    const task = fixture.board.createTask(fixture.project.projectId, taskRequest());
    const first = fixture.board.claimRun(fixture.engineer.agentId, { claimId: "claim-question-0001", messageCursor: null });
    assert.ok(first);
    assert.equal(first.task?.status, "in_progress");
    const startedAt = first.task?.startedAt;
    assert.ok(startedAt);
    const question = fixture.board.askQuestion(task.taskId, fixture.engineer.agentId, {
      clientEventId: "question-0001",
      question: "Should retries preserve the original payment intent?",
      runId: first.run.runId,
    });
    assert.equal(question.status, "open");
    const waitingForHuman = fixture.board.snapshot(fixture.project.projectId);
    assert.equal(waitingForHuman.recentRuns[0]!.status, "waiting_for_human");
    assert.equal(waitingForHuman.tasks[0]?.status, "blocked");
    assert.equal(waitingForHuman.tasks[0]?.endedAt, null);
    assert.equal(fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-before-answer-0001",
      messageCursor: null,
    }), null);

    const answered = fixture.board.answerQuestion(question.questionId, {
      answer: "Yes. Preserve it and verify duplicate-submit behavior.",
      version: question.version,
    });
    assert.equal(answered.duplicate, false);
    assert.equal(answered.wakeup.reason, "human_answer");
    const redundantResume = fixture.board.resumeAgent(fixture.engineer.agentId, {
      reason: "Resume after recording the answer.",
      taskId: task.taskId,
    }, "resume-after-answer-0001");
    const resumed = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-answer-0001",
      messageCursor: null,
    });
    assert.ok(resumed);
    assert.equal(resumed.wakeup.wakeupId, answered.wakeup.wakeupId);
    assert.notEqual(resumed.wakeup.wakeupId, redundantResume.wakeup.wakeupId);
    assert.equal(resumed.task?.status, "in_progress");
    assert.equal(resumed.task?.startedAt, startedAt);
    assert.equal(resumed.context.triggerQuestion?.answer, answered.question.answer);
    assert.equal(resumed.context.openQuestions.length, 0);
    const oversight = fixture.board.snapshot(fixture.project.projectId);
    assert.equal(oversight.openQuestions.length, 0);
    assert.equal(oversight.recentQuestions[0]?.answer, answered.question.answer);
    const retiredResume = oversight.recentEvents.find((event) => (
      event.eventType === "agent_wakeup_retired" && event.data.wakeupId === redundantResume.wakeup.wakeupId
    ));
    assert.equal(retiredResume?.data.supersededByWakeupId, answered.wakeup.wakeupId);
  } finally {
    fixture.board.close();
  }
});

test("only the assigned agent records a nullable estimate after inspecting work", async () => {
  let now = new Date("2026-07-19T20:00:00.000Z");
  const fixture = await boardFixture(await databasePath(), () => new Date(now));
  try {
    const task = fixture.board.createTask(fixture.project.projectId, taskRequest());
    assert.equal(task.expectedAgentMinutes, null);
    assert.equal(task.estimateRecordedAt, null);
    const claim = fixture.board.claimRun(fixture.engineer.agentId, { claimId: "claim-timing-0001", messageCursor: null });
    assert.ok(claim);
    assert.equal(claim.task?.status, "in_progress");
    assert.equal(claim.task?.startedAt, "2026-07-19T20:00:00.000Z");
    assert.equal(claim.task?.expectedCompletedAt, null);
    assert.equal(claim.task?.version, task.version + 1);
    await assert.rejects(
      Promise.resolve().then(() => fixture.board.updateTask(task.taskId, {
        version: claim.task!.version,
        expectedAgentMinutes: 30,
      }, { type: "human", id: "human:alice" })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "AGENT_ESTIMATE_REQUIRED",
    );
    now = new Date("2026-07-19T20:05:00.000Z");
    const estimated = fixture.board.updateTask(task.taskId, {
      version: claim.task!.version,
      expectedAgentMinutes: 30,
    }, { type: "agent", id: fixture.engineer.agentId });
    assert.equal(estimated.estimateRecordedAt, "2026-07-19T20:05:00.000Z");
    assert.equal(estimated.expectedCompletedAt, "2026-07-19T20:45:00.000Z");
    await assert.rejects(
      Promise.resolve().then(() => fixture.board.updateTask(task.taskId, {
        version: task.version,
        status: "blocked",
      }, { type: "agent", id: fixture.engineer.agentId })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "TASK_VERSION_CONFLICT",
    );
    now = new Date("2026-07-19T20:35:00.000Z");
    fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Retry behavior passes the required tests.",
    });
    const completed = fixture.board.requireTask(task.taskId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.endedAt, "2026-07-19T20:35:00.000Z");
    assert.equal(completed.expectedCompletedAt, null);
    assert.equal(completed.result, "Retry behavior passes the required tests.");
    assert.equal(completed.version, estimated.version + 1);
  } finally {
    fixture.board.close();
  }
});

test("changing or clearing an assignee clears the previous agent's estimate", async () => {
  const fixture = await boardFixture();
  try {
    const estimatedBlockedTask = (title: string, claimId: string) => {
      const task = fixture.board.createTask(fixture.project.projectId, taskRequest({ title }));
      const claim = fixture.board.claimRun(fixture.engineer.agentId, { claimId, messageCursor: null });
      assert.ok(claim);
      const estimated = fixture.board.updateTask(task.taskId, {
        version: claim.task!.version,
        expectedAgentMinutes: 45,
      }, { type: "agent", id: fixture.engineer.agentId });
      assert.equal(estimated.expectedAgentMinutes, 45);
      assert.ok(estimated.estimateRecordedAt);
      fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
        outcome: "failed",
        result: "The current assignee should release the next pass.",
      });
      const blocked = fixture.board.requireTask(task.taskId);
      assert.equal(blocked.expectedAgentMinutes, 45);
      return blocked;
    };

    const blockedForReassignment = estimatedBlockedTask(
      "Reassign an estimated task",
      "claim-estimate-before-reassignment-0001",
    );
    const reassigned = fixture.board.updateTask(blockedForReassignment.taskId, {
      version: blockedForReassignment.version,
      assignedAgentId: fixture.manager.agentId,
      assignedRole: fixture.manager.role,
    }, { type: "human", id: "human:alice" });
    assert.equal(reassigned.assignedAgentId, fixture.manager.agentId);
    assert.equal(reassigned.expectedAgentMinutes, null);
    assert.equal(reassigned.estimateRecordedAt, null);
    assert.equal(reassigned.expectedCompletedAt, null);
    const updateEvent = fixture.board.snapshot(fixture.project.projectId).recentEvents.find((event) => (
      event.taskId === blockedForReassignment.taskId &&
      event.eventType === "task_updated" &&
      event.data.version === reassigned.version
    ));
    assert.equal(updateEvent?.data.expectedAgentMinutes, null);

    const blockedForBacklog = estimatedBlockedTask(
      "Unassign an estimated task",
      "claim-estimate-before-unassignment-0001",
    );
    const unassigned = fixture.board.updateTask(blockedForBacklog.taskId, {
      version: blockedForBacklog.version,
      assignedAgentId: null,
      assignedRole: null,
      status: "backlog",
    }, { type: "human", id: "human:alice" });
    assert.equal(unassigned.assignedAgentId, null);
    assert.equal(unassigned.expectedAgentMinutes, null);
    assert.equal(unassigned.estimateRecordedAt, null);
    assert.equal(unassigned.expectedCompletedAt, null);
  } finally {
    fixture.board.close();
  }
});

test("durable task order controls both snapshots and the next unclaimed wakeup", async () => {
  const fixture = await boardFixture();
  try {
    const first = fixture.board.createTask(fixture.project.projectId, taskRequest({
      title: "Originally first",
    }));
    const second = fixture.board.createTask(fixture.project.projectId, taskRequest({
      title: "Promoted follow-up",
    }));
    assert.ok(first.orderKey < second.orderKey);

    const demotedFirst = fixture.board.updateTask(first.taskId, {
      version: first.version,
      orderKey: second.orderKey + 1024,
    }, { type: "human", id: "human:alice" });
    assert.equal(demotedFirst.orderKey, second.orderKey + 1024);
    assert.deepEqual(
      fixture.board.snapshot(fixture.project.projectId).tasks.slice(0, 2).map((task) => task.taskId),
      [second.taskId, first.taskId],
    );

    const claimedSecond = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-promoted-order-0001",
      messageCursor: null,
    });
    assert.equal(claimedSecond?.task?.taskId, second.taskId);
    fixture.board.settleRun(claimedSecond!.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: "Release the lane so the ordering assertion can finish.",
    });
  } finally {
    fixture.board.close();
  }
});

test("task order is one global domain across projects, snapshots, reorders, and wake claims", async () => {
  const fixture = await boardFixture();
  try {
    const originallyFirst = fixture.board.createTask(fixture.project.projectId, taskRequest({
      title: "Originally first across the company",
    }));
    const otherProject = fixture.board.createProject({
      name: "Customer reporting",
      description: "Keep customer reports useful.",
    });
    const crossProjectTask = fixture.board.createTask(otherProject.projectId, taskRequest({
      title: "Interleaved work from another project",
      assignedAgentId: null,
      assignedRole: null,
    }));
    const originallyLast = fixture.board.createTask(fixture.project.projectId, taskRequest({
      title: "Originally last across the company",
    }));

    assert.deepEqual(
      [originallyFirst.orderKey, crossProjectTask.orderKey, originallyLast.orderKey],
      [0, 1024, 2048],
    );

    const movedFirst = fixture.board.updateTask(originallyFirst.taskId, {
      version: originallyFirst.version,
      orderKey: 3072,
    }, { type: "human", id: "human:alice" });
    const visibleAcrossProjects = [
      ...fixture.board.snapshot(fixture.project.projectId).tasks,
      ...fixture.board.snapshot(otherProject.projectId).tasks,
    ].sort((left, right) => left.orderKey - right.orderKey || left.taskId.localeCompare(right.taskId));
    assert.deepEqual(
      visibleAcrossProjects.map((task) => task.taskId),
      [crossProjectTask.taskId, originallyLast.taskId, movedFirst.taskId],
    );

    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-global-task-order-0001",
      messageCursor: null,
    });
    assert.equal(claim?.task?.taskId, originallyLast.taskId);
  } finally {
    fixture.board.close();
  }
});

test("duplicate order keys use task id for the same visible and claim order", async () => {
  const fixture = await boardFixture();
  try {
    const first = fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Tied task one" }));
    const second = fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Tied task two" }));
    const tiedOrderKey = 4_096;
    fixture.board.updateTask(first.taskId, {
      version: first.version,
      orderKey: tiedOrderKey,
    }, { type: "human", id: "human:alice" });
    fixture.board.updateTask(second.taskId, {
      version: second.version,
      orderKey: tiedOrderKey,
    }, { type: "human", id: "human:alice" });

    const expected = [first.taskId, second.taskId].sort((left, right) => left.localeCompare(right));
    const visible = fixture.board.snapshot(fixture.project.projectId).tasks.map((task) => task.taskId);
    assert.deepEqual(visible, expected);
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-tied-order-0001",
      messageCursor: null,
    });
    assert.equal(claim?.task?.taskId, visible[0]);
  } finally {
    fixture.board.close();
  }
});

test("agents durably report independent phases that may progress in parallel", async () => {
  const fixture = await boardFixture();
  try {
    const task = fixture.board.createTask(fixture.project.projectId, taskRequest());
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-phases-0001",
      messageCursor: null,
    });
    assert.ok(claim);
    const apiPhase = fixture.board.createTaskPhase(task.taskId, {
      title: "Implement API changes",
      stage: "planning",
      parallelGroup: "implementation",
    }, fixture.engineer.agentId);
    const clientPhase = fixture.board.createTaskPhase(task.taskId, {
      title: "Implement client changes",
      stage: "planning",
      parallelGroup: "implementation",
    }, fixture.engineer.agentId);
    const runningApi = fixture.board.updateTaskPhase(apiPhase.phaseId, {
      version: apiPhase.version,
      stage: "execution",
      status: "in_progress",
    }, fixture.engineer.agentId);
    const runningClient = fixture.board.updateTaskPhase(clientPhase.phaseId, {
      version: clientPhase.version,
      stage: "execution",
      status: "in_progress",
    }, fixture.engineer.agentId);
    const visible = fixture.board.requireTask(task.taskId).phases;
    assert.equal(visible.filter((phase) => phase.status === "in_progress").length, 2);
    assert.deepEqual(visible.map((phase) => phase.parallelGroup), ["implementation", "implementation"]);
    assert.throws(
      () => fixture.board.updateTaskPhase(runningApi.phaseId, {
        version: runningApi.version,
        stage: "done",
      }, fixture.engineer.agentId),
      (error: unknown) => error instanceof TaskBoardError && error.code === "PHASE_STATE_INVALID",
    );
    const completedApi = fixture.board.updateTaskPhase(runningApi.phaseId, {
      version: runningApi.version,
      status: "completed",
    }, fixture.engineer.agentId);
    assert.ok(completedApi.endedAt);
    assert.equal(completedApi.stage, "execution");
    assert.throws(
      () => fixture.board.updateTaskPhase(completedApi.phaseId, {
        version: completedApi.version,
        title: "Cannot rewrite a terminal phase",
      }, fixture.engineer.agentId),
      (error: unknown) => error instanceof TaskBoardError && error.code === "TASK_PHASE_TERMINAL",
    );
    assert.equal(runningClient.status, "in_progress");
  } finally {
    fixture.board.close();
  }
});

test("terminal task transitions atomically settle every unfinished phase", async () => {
  let now = new Date("2026-07-19T20:00:00.000Z");
  const fixture = await boardFixture(await databasePath(), () => new Date(now));
  try {
    const task = fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Settle phase lifecycle" }));
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-terminal-phases-0001",
      messageCursor: null,
    });
    assert.ok(claim);
    const pending = fixture.board.createTaskPhase(task.taskId, {
      title: "Pending research",
      stage: "research",
      parallelGroup: null,
    }, fixture.engineer.agentId);
    const execution = fixture.board.createTaskPhase(task.taskId, {
      title: "Active implementation",
      stage: "planning",
      parallelGroup: "implementation",
    }, fixture.engineer.agentId);
    const running = fixture.board.updateTaskPhase(execution.phaseId, {
      version: execution.version,
      stage: "execution",
      status: "in_progress",
    }, fixture.engineer.agentId);
    const review = fixture.board.createTaskPhase(task.taskId, {
      title: "Blocked review",
      stage: "review",
      parallelGroup: null,
    }, fixture.engineer.agentId);
    const blocked = fixture.board.updateTaskPhase(review.phaseId, {
      version: review.version,
      status: "blocked",
    }, fixture.engineer.agentId);
    const alreadyDone = fixture.board.createTaskPhase(task.taskId, {
      title: "Completed plan",
      stage: "planning",
      parallelGroup: null,
    }, fixture.engineer.agentId);
    const startedDone = fixture.board.updateTaskPhase(alreadyDone.phaseId, {
      version: alreadyDone.version,
      status: "in_progress",
    }, fixture.engineer.agentId);
    const completedBeforeTask = fixture.board.updateTaskPhase(alreadyDone.phaseId, {
      version: startedDone.version,
      status: "completed",
    }, fixture.engineer.agentId);

    now = new Date("2026-07-19T20:15:00.000Z");
    fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "All work phases finished with the run.",
    });
    const completedTask = fixture.board.requireTask(task.taskId);
    assert.equal(completedTask.status, "completed");
    assert.ok(completedTask.phases.every((phase) => phase.status === "completed"));
    assert.deepEqual(completedTask.phases.map((phase) => phase.stage), ["research", "execution", "review", "planning"]);
    const settledPending = completedTask.phases.find((phase) => phase.phaseId === pending.phaseId)!;
    const settledRunning = completedTask.phases.find((phase) => phase.phaseId === running.phaseId)!;
    const settledBlocked = completedTask.phases.find((phase) => phase.phaseId === blocked.phaseId)!;
    const preservedDone = completedTask.phases.find((phase) => phase.phaseId === completedBeforeTask.phaseId)!;
    assert.equal(settledPending.startedAt, "2026-07-19T20:15:00.000Z");
    assert.equal(settledPending.endedAt, "2026-07-19T20:15:00.000Z");
    assert.equal(settledPending.version, pending.version + 1);
    assert.equal(settledRunning.startedAt, running.startedAt);
    assert.equal(settledRunning.endedAt, "2026-07-19T20:15:00.000Z");
    assert.equal(settledRunning.version, running.version + 1);
    assert.equal(settledBlocked.version, blocked.version + 1);
    assert.equal(preservedDone.version, completedBeforeTask.version);
    assert.equal(preservedDone.endedAt, completedBeforeTask.endedAt);
    const reconciliationEvents = fixture.board.snapshot(fixture.project.projectId).recentEvents.filter((event) => (
      event.taskId === task.taskId &&
      event.eventType === "task_phase_updated" &&
      event.data.terminalTaskStatus === "completed"
    ));
    assert.equal(reconciliationEvents.length, 3);

    const failedTask = fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Fail unfinished phase" }));
    const failedClaim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-failed-terminal-phases-0001",
      messageCursor: null,
    });
    assert.ok(failedClaim);
    const failedPhase = fixture.board.createTaskPhase(failedTask.taskId, {
      title: "Unfinished test pass",
      stage: "testing",
      parallelGroup: null,
    }, fixture.engineer.agentId);
    fixture.board.settleRun(failedClaim.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: "The run stopped before tests finished.",
    });
    now = new Date("2026-07-19T20:30:00.000Z");
    const blockedTask = fixture.board.requireTask(failedTask.taskId);
    const terminalFailure = fixture.board.updateTask(failedTask.taskId, {
      version: blockedTask.version,
      status: "failed",
      result: "The human closed the unsuccessful task.",
    }, { type: "human", id: "human:alice" });
    assert.equal(terminalFailure.phases[0]?.status, "failed");
    assert.equal(terminalFailure.phases[0]?.stage, failedPhase.stage);
    assert.equal(terminalFailure.phases[0]?.startedAt, "2026-07-19T20:30:00.000Z");
    assert.equal(terminalFailure.phases[0]?.endedAt, "2026-07-19T20:30:00.000Z");
    assert.equal(terminalFailure.phases[0]?.version, failedPhase.version + 1);
  } finally {
    fixture.board.close();
  }
});

test("claim area memory keeps the newest eight results, caps result text, and excludes the current task", async () => {
  let now = new Date("2026-07-19T20:00:00.000Z");
  const fixture = await boardFixture(await databasePath(), () => new Date(now));
  try {
    const completed = [];
    const longResult = `Customer impact: ${"x".repeat(1_200)}`;
    for (let index = 0; index < 10; index += 1) {
      if (index < 9) now = new Date(now.valueOf() + 15 * 60_000);
      completed.push(completeAssignedTask(
        fixture.board,
        fixture.project.projectId,
        fixture.engineer.agentId,
        fixture.engineer.role,
        `Completed area task ${index}`,
        `claim-area-history-${index}`,
        index === 9 ? longResult : `Result for completed area task ${index}.`,
      ));
    }

    now = new Date(now.valueOf() + 15 * 60_000);
    const current = fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Current area task" }));
    const request = { claimId: "claim-area-current-0001", messageCursor: null } as const;
    const claim = fixture.board.claimRun(fixture.engineer.agentId, request);
    assert.ok(claim);

    const expected = [...completed].sort((left, right) => {
      if (left.endedAt !== right.endedAt) return left.endedAt! > right.endedAt! ? -1 : 1;
      if (left.taskId === right.taskId) return 0;
      return left.taskId > right.taskId ? -1 : 1;
    }).slice(0, 8);
    assert.deepEqual(claim.context.areaMemory.map((entry) => entry.taskId), expected.map((task) => task.taskId));
    assert.equal(claim.context.areaMemory.length, 8);
    assert.ok(claim.context.areaMemory.every((entry) => entry.taskId !== current.taskId));
    assert.ok(claim.context.areaMemory.every((entry, index) => entry.endedAt === expected[index]?.endedAt));
    assert.ok(claim.context.areaMemory.every((entry) => (
      Object.keys(entry).sort().join(",") === "endedAt,result,taskId,title"
    )));
    const capped = claim.context.areaMemory.find((entry) => entry.title === "Completed area task 9");
    assert.equal(capped?.result, longResult.slice(0, 1_000));
    assert.equal(capped?.result.length, 1_000);

    fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "The current task is complete but must not remember itself.",
    });
    const replay = fixture.board.claimRun(fixture.engineer.agentId, request);
    assert.ok(replay);
    assert.deepEqual(replay.context.areaMemory.map((entry) => entry.taskId), expected.map((task) => task.taskId));
    assert.ok(replay.context.areaMemory.every((entry) => entry.taskId !== current.taskId));
  } finally {
    fixture.board.close();
  }
});

test("claim area memory is isolated to an agent and project and survives a file-backed restart", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  let originalOpen = true;
  let restarted: TaskBoard | null = null;
  try {
    const remembered = completeAssignedTask(
      fixture.board,
      fixture.project.projectId,
      fixture.engineer.agentId,
      fixture.engineer.role,
      "Remembered checkout improvement",
      "claim-area-isolation-engineer-0001",
      "Customers can retry without a duplicate charge.",
    );
    const otherAgent = completeAssignedTask(
      fixture.board,
      fixture.project.projectId,
      fixture.manager.agentId,
      fixture.manager.role,
      "Other agent's release review",
      "claim-area-isolation-manager-0001",
      "This belongs only to the manager's area memory.",
    );

    const otherProject = fixture.board.createProject({
      name: "Account recovery",
      description: "Keep account recovery dependable.",
    });
    const otherProjectEngineer = fixture.board.createAgent(otherProject.projectId, {
      agentId: "engineer-other-project",
      role: "engineer",
      area: "account-recovery",
      mission: "Ship safe account recovery improvements.",
      model: "codex-mini",
      token: "task-board-other-project-token-0123456789",
    });
    const otherProjectTask = completeAssignedTask(
      fixture.board,
      otherProject.projectId,
      otherProjectEngineer.agentId,
      otherProjectEngineer.role,
      "Other project's recovery improvement",
      "claim-area-isolation-project-0001",
      "This belongs only to the other project.",
    );

    const current = fixture.board.createTask(fixture.project.projectId, taskRequest({
      title: "Use persistent area memory",
    }));
    const request = { claimId: "claim-area-persist-0001", messageCursor: null } as const;
    const claim = fixture.board.claimRun(fixture.engineer.agentId, request);
    assert.ok(claim);
    assert.deepEqual(claim.context.areaMemory.map((entry) => entry.taskId), [remembered.taskId]);
    assert.ok(claim.context.areaMemory.every((entry) => entry.taskId !== otherAgent.taskId));
    assert.ok(claim.context.areaMemory.every((entry) => entry.taskId !== otherProjectTask.taskId));
    assert.ok(claim.context.areaMemory.every((entry) => entry.taskId !== current.taskId));

    fixture.board.close();
    originalOpen = false;
    restarted = await TaskBoard.open(config(path));
    const replay = restarted.claimRun(fixture.engineer.agentId, request);
    assert.ok(replay);
    assert.deepEqual(replay.context.areaMemory, [{
      taskId: remembered.taskId,
      title: remembered.title,
      result: remembered.result,
      endedAt: remembered.endedAt,
    }]);
  } finally {
    if (originalOpen) fixture.board.close();
    restarted?.close();
  }
});

test("claims isolate message cursors per task and expose bounded completed-parent evidence", async () => {
  const fixture = await boardFixture();
  try {
    const olderTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
      title: "Older unassigned follow-up",
      assignedAgentId: null,
      assignedRole: null,
    }));
    const olderNote = fixture.board.appendHumanMessage(olderTask.taskId, {
      clientEventId: "older-task-note-0001",
      kind: "note",
      body: "This older note must not be hidden by another task's cursor.",
    });
    const engineerTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
      title: "Engineer implementation for review",
    }));
    fixture.board.appendHumanMessage(engineerTask.taskId, {
      clientEventId: "engineer-task-note-0001",
      kind: "note",
      body: "Preserve this task-specific implementation constraint.",
    });
    const engineerClaim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-engineer-parent-0001",
      messageCursors: {},
    });
    assert.ok(engineerClaim);
    assert.deepEqual(engineerClaim.context.messages.map((message) => message.taskId), [engineerTask.taskId]);
    fixture.board.appendAgentMessage(engineerTask.taskId, fixture.engineer.agentId, {
      clientEventId: "engineer-parent-progress-0001",
      kind: "progress",
      body: "Research, implementation, and the focused tests are complete.",
      runId: engineerClaim.run.runId,
    });
    fixture.board.settleRun(engineerClaim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Checkout retries are safe and the focused tests pass.",
    });

    const assignedOlder = fixture.board.updateTask(olderTask.taskId, {
      version: olderTask.version,
      assignedAgentId: fixture.engineer.agentId,
      assignedRole: fixture.engineer.role,
    }, { type: "human", id: "human:alice" });
    const olderClaim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-older-task-0001",
      messageCursors: { [engineerTask.taskId]: engineerClaim.context.messageCursor },
    });
    assert.ok(olderClaim);
    assert.equal(olderClaim.task?.version, assignedOlder.version + 1);
    assert.deepEqual(olderClaim.context.messages.map((message) => message.messageId), [olderNote.messageId]);
    fixture.board.settleRun(olderClaim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "The older follow-up was reviewed independently.",
    });

    fixture.board.createTask(fixture.project.projectId, taskRequest({
      parentTaskId: engineerTask.taskId,
      title: "Manager review of completed engineer work",
      assignedAgentId: fixture.manager.agentId,
      assignedRole: fixture.manager.role,
    }));
    const reviewClaim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-manager-review-0001",
      messageCursors: {},
    });
    assert.ok(reviewClaim);
    assert.equal(reviewClaim.context.parentTask?.taskId, engineerTask.taskId);
    assert.equal(reviewClaim.context.parentTask?.status, "completed");
    assert.equal(reviewClaim.context.parentTask?.result, "Checkout retries are safe and the focused tests pass.");
    assert.deepEqual(reviewClaim.context.parentMessages.map((message) => message.kind), ["note", "progress"]);
  } finally {
    fixture.board.close();
  }
});

test("claim is exact-idempotent and the database permits only one active run per agent", async () => {
  const fixture = await boardFixture();
  try {
    fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "First assigned task" }));
    fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Second assigned task" }));
    const first = fixture.board.claimRun(fixture.engineer.agentId, { claimId: "claim-one-active-0001", messageCursor: 0 });
    assert.ok(first);
    const replay = fixture.board.claimRun(fixture.engineer.agentId, { claimId: "claim-one-active-0001", messageCursor: 0 });
    assert.equal(replay?.run.runId, first.run.runId);
    await assert.rejects(
      Promise.resolve().then(() => fixture.board.claimRun(fixture.engineer.agentId, {
        claimId: "claim-one-active-0002",
        messageCursor: 0,
      })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "AGENT_RUN_ACTIVE",
    );
    fixture.board.settleRun(first.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "First run complete.",
    });
    const second = fixture.board.claimRun(fixture.engineer.agentId, { claimId: "claim-one-active-0002", messageCursor: 0 });
    assert.ok(second);
    assert.notEqual(second.run.runId, first.run.runId);
  } finally {
    fixture.board.close();
  }
});

test("human interrupt is durable, idempotent, visible immediately, and only an explicit resume restarts blocked work", async () => {
  const fixture = await boardFixture();
  try {
    fixture.board.createTask(fixture.project.projectId, taskRequest());
    const claim = fixture.board.claimRun(fixture.engineer.agentId, { claimId: "claim-interrupt-0001", messageCursor: 0 });
    assert.ok(claim);
    const first = fixture.board.interruptAgent(fixture.engineer.agentId, { reason: "Human changed deployment scope." }, "interrupt-key-0001");
    const replay = fixture.board.interruptAgent(fixture.engineer.agentId, { reason: "Human changed deployment scope." }, "interrupt-key-0001");
    assert.equal(first.duplicate, false);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.interrupt.interruptId, first.interrupt.interruptId);
    assert.equal(fixture.board.snapshot(fixture.project.projectId).agents[0]!.status, "interrupting");
    const batch = await fixture.board.waitForRunInterrupts(claim.run.runId, fixture.engineer.agentId, 0, 0, new AbortController().signal);
    assert.equal(batch?.items[0]?.reason, "Human changed deployment scope.");
    fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "interrupted",
      result: "Stopped after the durable human interrupt.",
    });
    const blocked = fixture.board.requireTask(claim.task!.taskId);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.endedAt, null);
    assert.equal(blocked.result, null);
    assert.equal(fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-after-interrupt-0001",
      messageCursor: 0,
    }), null);
    fixture.board.resumeAgent(fixture.engineer.agentId, {
      reason: "Human approved a safer follow-up iteration.",
      taskId: blocked.taskId,
    }, "resume-after-interrupt-0001");
    const resumed = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-resumed-after-interrupt-0001",
      messageCursor: 0,
    });
    assert.ok(resumed);
    assert.equal(resumed.task?.status, "in_progress");
    assert.equal(resumed.task?.startedAt, blocked.startedAt);
  } finally {
    fixture.board.close();
  }
});

test("an explicit human resume durably releases an event-driven claim after restart", async () => {
  const path = await databasePath();
  const first = await boardFixture(path);
  const projectId = first.project.projectId;
  const agentId = first.engineer.agentId;
  first.board.resumeAgent(agentId, {
    reason: "Human approved another research iteration.",
    taskId: null,
  }, "resume-persist-0001");
  first.board.close();

  const restarted = await TaskBoard.open(config(path));
  try {
    const claimed = restarted.claimRun(agentId, { claimId: "claim-resume-persist-0001", messageCursor: null });
    assert.ok(claimed);
    assert.equal(claimed.wakeup.reason, "human_resume");
    restarted.settleRun(claimed.run.runId, agentId, {
      outcome: "completed",
      result: "Resumed iteration finished.",
    });

    const waiting = restarted.waitToClaimRun(
      agentId,
      { claimId: "claim-event-driven-resume-0001", messageCursor: null },
      1_000,
      new AbortController().signal,
    );
    restarted.resumeAgent(agentId, {
      reason: "Human explicitly resumed the idle agent.",
      taskId: null,
    }, "resume-event-driven-0001");
    const awakened = await waiting;
    assert.ok(awakened);
    assert.equal(awakened.wakeup.reason, "human_resume");
    assert.equal(restarted.snapshot(projectId).agents.find((agent) => agent.agentId === agentId)?.status, "running");
  } finally {
    restarted.close();
  }
});

test("an assigned agent chat request remains executable without entering the review workflow", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const query = fixture.board.createTask(fixture.project.projectId, taskRequest({
    title: "Request for engineer-one: Explain the retry behavior",
    acceptanceCriteria: "Return a concise answer or result. If more work is needed, propose child tasks for human approval; do not assign agents or deploy.",
    requiresReview: false,
  }));
  assert.equal(query.requiresReview, false);
  fixture.board.close();

  const restarted = await TaskBoard.open(config(path));
  try {
    const persisted = restarted.requireTask(query.taskId);
    assert.equal(persisted.requiresReview, false);
    const claim = restarted.claimRun(fixture.engineer.agentId, {
      claimId: "claim-agent-chat-no-review-0001",
      messageCursor: null,
    });
    assert.ok(claim);
    assert.equal(claim.task?.taskId, query.taskId);
    assert.equal(claim.wakeup.reason, "human_assignment");
    restarted.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Retries preserve the original idempotency key.",
    });

    const snapshot = restarted.snapshot(fixture.project.projectId);
    assert.equal(snapshot.tasks.filter((task) => task.parentTaskId === query.taskId).length, 0);
    assert.equal(restarted.claimRun(fixture.manager.agentId, {
      claimId: "claim-after-agent-chat-no-review-0001",
      messageCursor: null,
    }), null);
  } finally {
    restarted.close();
  }
});

test("a legacy review child for a chat request cannot create a human production check", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const legacyQuery = fixture.board.createTask(fixture.project.projectId, taskRequest({
    title: "Request for engineer-one: Explain legacy retries",
    acceptanceCriteria: "Return a concise answer or result. If more work is needed, propose child tasks for human approval; do not assign agents or deploy.",
    requiresReview: true,
  }));
  const engineerRun = fixture.board.claimRun(fixture.engineer.agentId, {
    claimId: "claim-legacy-chat-review-engineer-0001",
    messageCursor: null,
  });
  assert.ok(engineerRun);
  fixture.board.settleRun(engineerRun.run.runId, fixture.engineer.agentId, {
    outcome: "completed",
    result: "The requested retry explanation is complete.",
  });
  const legacyReview = fixture.board.snapshot(fixture.project.projectId).tasks.find((task) => (
    task.parentTaskId === legacyQuery.taskId && task.kind === "manager_review"
  ));
  assert.ok(legacyReview);
  fixture.board.close();

  const { DatabaseSync } = await import("node:sqlite");
  const migrated = new DatabaseSync(path);
  migrated.prepare("UPDATE tasks SET requires_review = 0 WHERE task_id = ?").run(legacyQuery.taskId);
  migrated.close();

  const restarted = await TaskBoard.open(config(path));
  try {
    assert.equal(restarted.requireTask(legacyQuery.taskId).requiresReview, false);
    assert.equal(restarted.claimRun(fixture.manager.agentId, {
      claimId: "claim-retired-legacy-chat-handoff-0001",
      messageCursor: null,
    }), null);
    restarted.resumeAgent(fixture.manager.agentId, {
      reason: "A human explicitly requested inspection of this historical chat response.",
      taskId: legacyReview.taskId,
    }, "resume-legacy-chat-review-0001");
    const managerRun = restarted.claimRun(fixture.manager.agentId, {
      claimId: "claim-legacy-chat-review-manager-0001",
      messageCursor: null,
    });
    assert.ok(managerRun);
    assert.equal(managerRun.task?.taskId, legacyReview.taskId);
    assert.equal(managerRun.wakeup.reason, "human_resume");
    restarted.settleRun(managerRun.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "The historical review completed without escalating conversational work.",
    });

    const snapshot = restarted.snapshot(fixture.project.projectId);
    assert.equal(snapshot.tasks.filter((task) => (
      task.parentTaskId === legacyReview.taskId && task.kind === "human_check"
    )).length, 0);
  } finally {
    restarted.close();
  }
});

test("completed engineer work hands off once to the sole manager, then creates one human-only check", async () => {
  const fixture = await boardFixture();
  try {
    const work = fixture.board.createTask(fixture.project.projectId, taskRequest());
    assert.equal(work.kind, "work");
    assert.equal(work.requiredRole, null);
    assert.equal(work.requiresReview, true);
    const engineerRun = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-review-workflow-engineer-0001",
      messageCursor: null,
    });
    assert.ok(engineerRun);
    const firstSettlement = fixture.board.settleRun(engineerRun.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "The implementation and focused checks are complete.",
    });
    const replaySettlement = fixture.board.settleRun(engineerRun.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "The implementation and focused checks are complete.",
    });
    assert.equal(firstSettlement.duplicate, false);
    assert.equal(replaySettlement.duplicate, true);

    let snapshot = fixture.board.snapshot(fixture.project.projectId);
    const reviews = snapshot.tasks.filter((task) => task.parentTaskId === work.taskId && task.kind === "manager_review");
    assert.equal(reviews.length, 1);
    const review = reviews[0]!;
    assert.equal(review.requiredRole, "manager");
    assert.equal(review.requiresReview, false);
    assert.equal(review.status, "queued");
    assert.equal(review.assignedAgentId, fixture.manager.agentId);
    assert.deepEqual(review.workspaceRefs, work.workspaceRefs);
    await assert.rejects(
      Promise.resolve().then(() => fixture.board.updateTask(review.taskId, {
        version: review.version,
        assignedAgentId: fixture.engineer.agentId,
        assignedRole: fixture.engineer.role,
      }, { type: "human", id: "human:alice" })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "TASK_REQUIRED_ROLE_MISMATCH",
    );

    const managerRun = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-review-workflow-manager-0001",
      messageCursor: null,
    });
    assert.ok(managerRun);
    assert.equal(managerRun.task?.taskId, review.taskId);
    assert.equal(managerRun.task?.kind, "manager_review");
    assert.equal(managerRun.task?.requiredRole, "manager");
    assert.equal(managerRun.wakeup.reason, "workflow_handoff");
    assert.equal(managerRun.wakeup.createdBy, "system:steward-review-workflow");
    assert.equal(managerRun.context.parentTask?.status, "completed");
    assert.equal(managerRun.context.parentTask?.result, "The implementation and focused checks are complete.");
    fixture.board.settleRun(managerRun.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "Evidence is sufficient for the human owner to decide.",
    });
    assert.equal(fixture.board.settleRun(managerRun.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "Evidence is sufficient for the human owner to decide.",
    }).duplicate, true);

    snapshot = fixture.board.snapshot(fixture.project.projectId);
    const checks = snapshot.tasks.filter((task) => task.parentTaskId === review.taskId && task.kind === "human_check");
    assert.equal(checks.length, 1);
    const humanCheck = checks[0]!;
    assert.equal(humanCheck.requiredRole, null);
    assert.equal(humanCheck.requiresReview, false);
    assert.equal(humanCheck.assignedAgentId, null);
    assert.equal(humanCheck.status, "backlog");
    assert.equal(fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-after-human-check-created-0001",
      messageCursor: null,
    }), null);
    await assert.rejects(
      Promise.resolve().then(() => fixture.board.updateTask(humanCheck.taskId, {
        version: humanCheck.version,
        assignedAgentId: fixture.manager.agentId,
        assignedRole: fixture.manager.role,
      }, { type: "human", id: "human:alice" })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "HUMAN_CHECK_NOT_ASSIGNABLE",
    );
    await assert.rejects(
      Promise.resolve().then(() => fixture.board.updateTask(humanCheck.taskId, {
        version: humanCheck.version,
        status: "completed",
        result: "An agent tried to approve this check.",
      }, { type: "agent", id: fixture.manager.agentId })),
      (error: unknown) => error instanceof TaskBoardError && error.code === "HUMAN_CHECK_HUMAN_ONLY",
    );
    await assert.rejects(
      Promise.resolve().then(() => fixture.board.resumeAgent(fixture.manager.agentId, {
        reason: "Do not wake an agent for a human check.",
        taskId: humanCheck.taskId,
      }, "resume-human-check-0001")),
      (error: unknown) => error instanceof TaskBoardError && error.code === "HUMAN_CHECK_NOT_ASSIGNABLE",
    );
    const decided = fixture.board.updateTask(humanCheck.taskId, {
      version: humanCheck.version,
      status: "completed",
      result: "Human approved the reviewed change for the next controlled release step.",
    }, { type: "human", id: "human:alice" });
    assert.equal(decided.status, "completed");
    assert.ok(decided.endedAt);
    assert.equal(fixture.board.snapshot(fixture.project.projectId).tasks.length, 3);

    const events = fixture.board.snapshot(fixture.project.projectId).recentEvents;
    assert.ok(events.some((event) => event.taskId === review.taskId && event.eventType === "task_created"
      && event.data.kind === "manager_review" && event.data.requiredRole === "manager"));
    assert.ok(events.some((event) => event.taskId === humanCheck.taskId && event.eventType === "task_created"
      && event.data.kind === "human_check" && event.data.requiredRole === null));
    assert.ok(events.some((event) => event.taskId === work.taskId && event.eventType === "task_run_settled"
      && event.data.kind === "work"));
    assert.ok(events.some((event) => event.taskId === work.taskId && event.eventType === "task_created"
      && event.data.kind === "work" && event.data.requiredRole === null));
  } finally {
    fixture.board.close();
  }
});

test("an ambiguous manager roster leaves review work in the backlog without a workflow wake", async () => {
  const fixture = await boardFixture();
  try {
    const secondManager = fixture.board.createAgent(fixture.project.projectId, {
      agentId: "manager-two",
      role: "manager",
      area: "alternate-release-review",
      mission: "Provide alternate oversight when a human chooses this reviewer.",
      model: "claude-haiku",
      token: "task-board-manager-two-token-0123456789abcdef",
    });
    const work = fixture.board.createTask(fixture.project.projectId, taskRequest({
      title: "Require an explicit reviewer choice",
    }));
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-ambiguous-review-work-0001",
      messageCursor: null,
    });
    assert.ok(claim);
    fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Implementation is ready for review, but the reviewer roster is ambiguous.",
    });

    const review = fixture.board.snapshot(fixture.project.projectId).tasks.find((task) => (
      task.parentTaskId === work.taskId && task.kind === "manager_review"
    ));
    assert.ok(review);
    assert.equal(review.status, "backlog");
    assert.equal(review.assignedAgentId, null);
    assert.equal(fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-ambiguous-manager-one-0001",
      messageCursor: null,
    }), null);
    assert.equal(fixture.board.claimRun(secondManager.agentId, {
      claimId: "claim-ambiguous-manager-two-0001",
      messageCursor: null,
    }), null);
  } finally {
    fixture.board.close();
  }
});

test("a project without a manager leaves review work in the backlog without a workflow wake", async () => {
  const fixture = await boardFixture();
  try {
    const project = fixture.board.createProject({
      name: "Managerless service",
      description: "Exercise the manual review fallback when no manager profile exists.",
    });
    const engineer = fixture.board.createAgent(project.projectId, {
      agentId: "managerless-engineer",
      role: "engineer",
      area: "managerless-service",
      mission: "Complete development work while leaving reviewer choice to a human when needed.",
      model: "codex-mini",
      token: "task-board-managerless-engineer-token-0123456789",
    });
    const work = fixture.board.createTask(project.projectId, taskRequest({
      title: "Complete work without a configured reviewer",
      assignedAgentId: engineer.agentId,
      assignedRole: engineer.role,
    }));
    const claim = fixture.board.claimRun(engineer.agentId, {
      claimId: "claim-managerless-review-work-0001",
      messageCursor: null,
    });
    assert.ok(claim);
    fixture.board.settleRun(claim.run.runId, engineer.agentId, {
      outcome: "completed",
      result: "Implementation completed; a human must choose or add a reviewer.",
    });

    const review = fixture.board.snapshot(project.projectId).tasks.find((task) => (
      task.parentTaskId === work.taskId && task.kind === "manager_review"
    ));
    assert.ok(review);
    assert.equal(review.status, "backlog");
    assert.equal(review.assignedAgentId, null);
    assert.equal(review.assignedRole, null);
    assert.equal(fixture.board.claimRun(engineer.agentId, {
      claimId: "claim-managerless-no-handoff-0001",
      messageCursor: null,
    }), null);
  } finally {
    fixture.board.close();
  }
});

test("markdown documents survive restart while board snapshots expose summaries without content", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const document = fixture.board.createDocument(fixture.project.projectId, {
    title: "Checkout recovery notes",
    contentType: "text/markdown",
    content: "# Recovery\n\nCustomers can retry safely.",
    clientId: "browser-primary",
  });
  assert.equal(document.contentVersion, 1);
  assert.equal(document.penEpoch, 1);
  assert.equal(document.sequence, 1);
  assert.deepEqual(document.penHolder, {
    actorType: "human",
    actorId: "human:alice",
    clientId: "browser-primary",
    acquiredAt: "2026-07-19T20:00:00.000Z",
  });
  const summary = fixture.board.snapshot(fixture.project.projectId).documents[0];
  assert.equal(summary?.documentId, document.documentId);
  assert.equal("content" in (summary ?? {}), false);
  fixture.board.close();

  const restarted = await TaskBoard.open(config(path));
  try {
    assert.equal(restarted.getDocument(document.documentId).content, document.content);
    const events = restarted.listDocumentEvents(document.documentId, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, "document_created");
    assert.equal(events[0]?.document.sequence, 1);
  } finally {
    restarted.close();
  }
});

test("document pen epochs fence stale clients and only humans can force a takeover", async () => {
  const fixture = await boardFixture();
  try {
    const created = fixture.board.createDocument(fixture.project.projectId, {
      title: "Release checklist",
      contentType: "text/markdown",
      content: "- [ ] Verify checkout",
      clientId: "browser-owner",
    });
    assert.throws(
      () => fixture.board.updateDocumentPen(created.documentId, {
        action: "acquire",
        clientId: "agent-editor",
        expectedPenEpoch: 1,
        force: false,
      }, { type: "agent", id: fixture.engineer.agentId }),
      (error: unknown) => error instanceof TaskBoardError && error.code === "DOCUMENT_PEN_HELD",
    );
    assert.throws(
      () => fixture.board.updateDocumentPen(created.documentId, {
        action: "acquire",
        clientId: "agent-editor",
        expectedPenEpoch: 1,
        force: true,
      }, { type: "agent", id: fixture.engineer.agentId }),
      (error: unknown) => error instanceof TaskBoardError && error.code === "DOCUMENT_FORCE_HUMAN_ONLY",
    );

    const released = fixture.board.updateDocumentPen(created.documentId, {
      action: "release",
      clientId: "browser-owner",
      expectedPenEpoch: 1,
      force: false,
    }, { type: "human", id: "human:alice" });
    assert.equal(released.penHolder, null);
    assert.equal(released.penEpoch, 1);
    const agentOwned = fixture.board.updateDocumentPen(created.documentId, {
      action: "acquire",
      clientId: "agent-editor",
      expectedPenEpoch: 1,
      force: false,
    }, { type: "agent", id: fixture.engineer.agentId });
    assert.equal(agentOwned.penEpoch, 2);
    assert.equal(agentOwned.penHolder?.clientId, "agent-editor");
    const repeated = fixture.board.updateDocumentPen(created.documentId, {
      action: "acquire",
      clientId: "agent-editor",
      expectedPenEpoch: 1,
      force: false,
    }, { type: "agent", id: fixture.engineer.agentId });
    assert.equal(repeated.sequence, agentOwned.sequence);
    assert.equal(repeated.penEpoch, agentOwned.penEpoch);

    const agentEdit = fixture.board.updateDocument(created.documentId, {
      clientId: "agent-editor",
      penEpoch: 2,
      contentVersion: 1,
      content: "- [x] Verify checkout",
    }, { type: "agent", id: fixture.engineer.agentId });
    assert.equal(agentEdit.contentVersion, 2);
    const taken = fixture.board.updateDocumentPen(created.documentId, {
      action: "acquire",
      clientId: "browser-reviewer",
      expectedPenEpoch: 2,
      force: true,
    }, { type: "human", id: "human:alice" });
    assert.equal(taken.penEpoch, 3);
    assert.equal(taken.penHolder?.clientId, "browser-reviewer");
    assert.throws(
      () => fixture.board.updateDocument(created.documentId, {
        clientId: "agent-editor",
        penEpoch: 2,
        contentVersion: 2,
        content: "stale overwrite",
      }, { type: "agent", id: fixture.engineer.agentId }),
      (error: unknown) => error instanceof TaskBoardError && error.code === "DOCUMENT_PEN_EPOCH_CONFLICT",
    );
    const humanEdit = fixture.board.updateDocument(created.documentId, {
      clientId: "browser-reviewer",
      penEpoch: 3,
      contentVersion: 2,
      content: "- [x] Verify checkout\n- [x] Human reviewed",
    }, { type: "human", id: "human:alice" });
    assert.equal(humanEdit.contentVersion, 3);
    assert.deepEqual(
      fixture.board.listDocumentEvents(created.documentId).map((event) => event.sequence),
      [1, 2, 3, 4, 5, 6],
    );
  } finally {
    fixture.board.close();
  }
});

test("the SQLite database and parent directory must remain owner-only", async () => {
  const path = await databasePath();
  const board = await TaskBoard.open(config(path));
  board.close();
  assert.equal((await stat(path)).mode & 0o077, 0);
  assert.equal((await stat(join(path, ".."))).mode & 0o077, 0);

  const root = await mkdtemp(join(tmpdir(), "steward-task-board-unsafe-"));
  const shared = join(root, "shared");
  await mkdir(shared, { mode: 0o755 });
  await chmod(shared, 0o755);
  await assert.rejects(
    TaskBoard.open(config(join(shared, "task-board.sqlite"))),
    (error: unknown) => error instanceof TaskBoardError && error.code === "UNSAFE_DATABASE_PATH",
  );
});

test("schema version 9 migration adds dormant automation configuration without changing existing board state", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const existingTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
    assignedAgentId: null,
    assignedRole: null,
  }));
  fixture.board.close();

  const { DatabaseSync } = await import("node:sqlite");
  const versionNine = new DatabaseSync(path);
  versionNine.exec("DROP TABLE automation_configuration; PRAGMA user_version = 9;");
  versionNine.close();

  const upgraded = await TaskBoard.open(config(path));
  try {
    assert.equal(upgraded.requireTask(existingTask.taskId).title, existingTask.title);
    const configuration = upgraded.getAutomationConfiguration();
    assert.equal(configuration.configurationId, "company-default");
    assert.equal(configuration.version, 1);
    assert.equal(configuration.updatedBy, "system:steward-default");
    assert.deepEqual(configuration.agentTypes, []);
    assert.deepEqual(configuration.stages, automationStages());
  } finally {
    upgraded.close();
  }

  const verified = new DatabaseSync(path);
  try {
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 13);
    assert.deepEqual(verified.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM automation_configuration").get()?.count, 1);
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM tasks").get()?.count, 1);
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM wakeups").get()?.count, 0);
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count, 0);
  } finally {
    verified.close();
  }
});

test("schema version 8 migration adds global work-item intake without changing existing board state", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const existingTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
    assignedAgentId: null,
    assignedRole: null,
  }));
  fixture.board.close();

  const { DatabaseSync } = await import("node:sqlite");
  const versionEight = new DatabaseSync(path);
  versionEight.exec("DROP TABLE automation_configuration; DROP TABLE work_items; PRAGMA user_version = 8;");
  versionEight.close();

  const upgraded = await TaskBoard.open(config(path));
  try {
    assert.equal(upgraded.requireTask(existingTask.taskId).title, existingTask.title);
    const created = upgraded.createWorkItem({ originalRequest: "Refine this request after the v9 migration." }, "migration-v9-work-item-0001");
    assert.equal(created.workItem.state, "submitted");
    assert.equal(created.workItem.priority, "normal");
  } finally {
    upgraded.close();
  }

  const verified = new DatabaseSync(path);
  try {
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 13);
    assert.deepEqual(verified.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM work_items").get()?.count, 1);
  } finally {
    verified.close();
  }
});

test("schema version 7 migration backfills durable review scope for work and agent chat requests", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const work = fixture.board.createTask(fixture.project.projectId, taskRequest({
    title: "Implement safer retry handling",
    assignedAgentId: null,
    assignedRole: null,
  }));
  const query = fixture.board.createTask(fixture.project.projectId, taskRequest({
    title: "Request for engineer-one: Explain retry handling",
    acceptanceCriteria: "Return a concise answer or result. If more work is needed, propose child tasks for human approval; do not assign agents or deploy.",
    assignedAgentId: null,
    assignedRole: null,
    requiresReview: false,
  }));
  fixture.board.close();

  const { DatabaseSync } = await import("node:sqlite");
  const versionSeven = new DatabaseSync(path);
  versionSeven.exec("DROP TABLE automation_configuration; DROP TABLE work_items; ALTER TABLE tasks DROP COLUMN requires_review; PRAGMA user_version = 7;");
  versionSeven.close();

  const upgraded = await TaskBoard.open(config(path));
  try {
    assert.equal(upgraded.requireTask(work.taskId).requiresReview, true);
    assert.equal(upgraded.requireTask(query.taskId).requiresReview, false);
  } finally {
    upgraded.close();
  }

  const verified = new DatabaseSync(path);
  try {
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 13);
    assert.deepEqual(verified.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    verified.close();
  }
});

test("schema version 6 migration preserves claimed runs, pending wakes, and semantic phase history", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const activeTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
    title: "Preserve an active run through migration",
  }));
  const activeClaim = fixture.board.claimRun(fixture.engineer.agentId, {
    claimId: "claim-v7-migration-active-0001",
    messageCursor: null,
  });
  assert.ok(activeClaim);
  const phase = fixture.board.createTaskPhase(activeTask.taskId, {
    title: "Implement migration-safe state",
    stage: "execution",
    parallelGroup: null,
  }, fixture.engineer.agentId);
  const runningPhase = fixture.board.updateTaskPhase(phase.phaseId, {
    version: phase.version,
    status: "in_progress",
  }, fixture.engineer.agentId);
  const legacyPhase = fixture.board.createTaskPhase(activeTask.taskId, {
    title: "Preserve a legacy done row",
    stage: "review",
    parallelGroup: null,
  }, fixture.engineer.agentId);
  const runningLegacyPhase = fixture.board.updateTaskPhase(legacyPhase.phaseId, {
    version: legacyPhase.version,
    status: "in_progress",
  }, fixture.engineer.agentId);
  const completedLegacyPhase = fixture.board.updateTaskPhase(legacyPhase.phaseId, {
    version: runningLegacyPhase.version,
    stage: "done",
    status: "completed",
  }, fixture.engineer.agentId);
  const pendingManagerTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
    title: "Preserve an unclaimed wake through migration",
    assignedAgentId: fixture.manager.agentId,
    assignedRole: fixture.manager.role,
  }));
  fixture.board.close();

  const { DatabaseSync } = await import("node:sqlite");
  const versionSix = new DatabaseSync(path);
  versionSix.exec("DROP TABLE automation_configuration; DROP TABLE work_items; PRAGMA user_version = 6;");
  versionSix.close();

  const upgraded = await TaskBoard.open(config(path));
  try {
    const replay = upgraded.claimRun(fixture.engineer.agentId, {
      claimId: "claim-v7-migration-active-0001",
      messageCursor: null,
    });
    assert.ok(replay);
    assert.equal(replay.run.runId, activeClaim.run.runId);
    assert.equal(replay.wakeup.wakeupId, activeClaim.wakeup.wakeupId);
    const completedPhase = upgraded.updateTaskPhase(runningPhase.phaseId, {
      version: runningPhase.version,
      status: "completed",
    }, fixture.engineer.agentId);
    assert.equal(completedPhase.stage, "execution");
    assert.equal(completedPhase.status, "completed");

    const pendingClaim = upgraded.claimRun(fixture.manager.agentId, {
      claimId: "claim-v7-migration-pending-0001",
      messageCursor: null,
    });
    assert.ok(pendingClaim);
    assert.equal(pendingClaim.task?.taskId, pendingManagerTask.taskId);
    assert.equal(pendingClaim.wakeup.reason, "human_assignment");
    upgraded.settleRun(pendingClaim.run.runId, fixture.manager.agentId, {
      outcome: "failed",
      result: "Closed the migration fixture's pending manager run.",
    });
    upgraded.settleRun(replay.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: "Closed the migration fixture's active engineer run.",
    });
  } finally {
    upgraded.close();
  }

  const verified = new DatabaseSync(path);
  try {
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 13);
    assert.deepEqual(verified.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count, 2);
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM wakeups").get()?.count, 2);
    const migratedPhase = verified.prepare("SELECT stage, status FROM task_phases WHERE phase_id = ?").get(runningPhase.phaseId);
    assert.equal(migratedPhase?.stage, "execution");
    assert.equal(migratedPhase?.status, "completed");
    const migratedLegacyPhase = verified.prepare("SELECT stage, status FROM task_phases WHERE phase_id = ?").get(completedLegacyPhase.phaseId);
    assert.equal(migratedLegacyPhase?.stage, "done");
    assert.equal(migratedLegacyPhase?.status, "completed");
  } finally {
    verified.close();
  }
});

test("schema version 5 migrates project-local order keys into the existing global display order", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const firstProjectTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
    title: "First project task",
  }));
  const otherProject = fixture.board.createProject({
    name: "Reporting migration",
    description: "Exercise global task ordering during migration.",
  });
  const otherProjectTask = fixture.board.createTask(otherProject.projectId, taskRequest({
    title: "Other project task",
    assignedAgentId: null,
    assignedRole: null,
  }));
  const laterFirstProjectTask = fixture.board.createTask(fixture.project.projectId, taskRequest({
    title: "Later first project task",
  }));
  fixture.board.close();

  const legacyGlobalOrder = [
    { taskId: firstProjectTask.taskId, orderKey: 0 },
    { taskId: otherProjectTask.taskId, orderKey: 0 },
    { taskId: laterFirstProjectTask.taskId, orderKey: 1024 },
  ].sort((left, right) => left.orderKey - right.orderKey || left.taskId.localeCompare(right.taskId));

  const { DatabaseSync } = await import("node:sqlite");
  const versionFive = new DatabaseSync(path);
  versionFive.exec("DROP INDEX tasks_global_order; CREATE INDEX tasks_project_order ON tasks(project_id, order_key, task_id);");
  versionFive.prepare("UPDATE tasks SET order_key = ? WHERE task_id = ?").run(0, firstProjectTask.taskId);
  versionFive.prepare("UPDATE tasks SET order_key = ? WHERE task_id = ?").run(0, otherProjectTask.taskId);
  versionFive.prepare("UPDATE tasks SET order_key = ? WHERE task_id = ?").run(1024, laterFirstProjectTask.taskId);
  versionFive.exec("DROP TABLE automation_configuration; DROP TABLE work_items; PRAGMA user_version = 5;");
  versionFive.close();

  const upgraded = await TaskBoard.open(config(path));
  try {
    const visibleAcrossProjects = [
      ...upgraded.snapshot(fixture.project.projectId).tasks,
      ...upgraded.snapshot(otherProject.projectId).tasks,
    ].sort((left, right) => left.orderKey - right.orderKey || left.taskId.localeCompare(right.taskId));
    assert.deepEqual(visibleAcrossProjects.map((task) => task.taskId), legacyGlobalOrder.map((task) => task.taskId));
    assert.deepEqual(visibleAcrossProjects.map((task) => task.orderKey), [0, 1024, 2048]);

    const appended = upgraded.createTask(otherProject.projectId, taskRequest({
      title: "Created after global order migration",
      assignedAgentId: null,
      assignedRole: null,
    }));
    assert.equal(appended.orderKey, 3072);
  } finally {
    upgraded.close();
  }

  const verified = new DatabaseSync(path);
  try {
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 13);
    assert.equal(verified.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tasks_global_order'").get()?.name, "tasks_global_order");
    assert.equal(verified.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tasks_project_order'").get(), undefined);
  } finally {
    verified.close();
  }
});

test("schema version 1 upgrades in place and preserves the run-to-task projection", async () => {
  const path = await databasePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import("node:sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      parent_task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE wakeups (
      wakeup_id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      wakeup_id TEXT NOT NULL UNIQUE REFERENCES wakeups(wakeup_id) ON DELETE RESTRICT
    ) STRICT;
    INSERT INTO tasks(task_id) VALUES ('task-legacy');
    INSERT INTO wakeups(wakeup_id, task_id) VALUES ('wakeup-legacy', 'task-legacy');
    INSERT INTO runs(run_id, wakeup_id) VALUES ('run-legacy', 'wakeup-legacy');
    PRAGMA user_version = 1;
  `);
  legacy.close();
  await chmod(path, 0o600);

  const upgraded = await TaskBoard.open(config(path));
  upgraded.close();

  const verified = new DatabaseSync(path);
  try {
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 13);
    assert.equal(verified.prepare("SELECT task_id FROM runs WHERE run_id = ?").get("run-legacy")?.task_id, "task-legacy");
    const task = verified.prepare("SELECT task_kind, required_role, agent_estimate_minutes, order_key FROM tasks WHERE task_id = ?").get("task-legacy");
    assert.equal(task?.task_kind, "work");
    assert.equal(task?.required_role, null);
    assert.equal(task?.agent_estimate_minutes, null);
    assert.equal(task?.order_key, 0);
    assert.equal(verified.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_phases'").get()?.name, "task_phases");
  } finally {
    verified.close();
  }
});

test("schema version 2 adds review fields in place and defaults existing tasks to work", async () => {
  const path = await databasePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import("node:sqlite");
  const versionTwo = new DatabaseSync(path);
  versionTwo.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      parent_task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT,
      expected_agent_minutes INTEGER NOT NULL
    ) STRICT;
    INSERT INTO tasks(task_id, parent_task_id, expected_agent_minutes) VALUES ('task-v2', NULL, 45);
    PRAGMA user_version = 2;
  `);
  versionTwo.close();
  await chmod(path, 0o600);

  const upgraded = await TaskBoard.open(config(path));
  upgraded.close();

  const verified = new DatabaseSync(path);
  try {
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 13);
    const task = verified.prepare("SELECT task_kind, required_role, expected_agent_minutes, agent_estimate_minutes, order_key FROM tasks WHERE task_id = ?").get("task-v2");
    assert.equal(task?.task_kind, "work");
    assert.equal(task?.required_role, null);
    assert.equal(task?.expected_agent_minutes, 45);
    assert.equal(task?.agent_estimate_minutes, null);
    assert.equal(task?.order_key, 0);
    const index = verified.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tasks_one_review_stage'").get();
    assert.equal(index?.name, "tasks_one_review_stage");
  } finally {
    verified.close();
  }
});

test("schema version 3 upgrades in place, preserves existing board data, and enables documents", async () => {
  const path = await databasePath();
  const fixture = await boardFixture(path);
  const projectId = fixture.project.projectId;
  const projectName = fixture.project.name;
  fixture.board.close();

  const { DatabaseSync } = await import("node:sqlite");
  const versionThree = new DatabaseSync(path);
  versionThree.exec(`
    DROP TABLE automation_configuration;
    DROP TABLE work_items;
    DROP TABLE document_events;
    DROP TABLE documents;
    PRAGMA user_version = 3;
  `);
  versionThree.close();

  const upgraded = await TaskBoard.open(config(path));
  try {
    assert.equal(upgraded.listProjects().find((project) => project.projectId === projectId)?.name, projectName);
    const document = upgraded.createDocument(projectId, {
      title: "Post-upgrade notes",
      contentType: "text/markdown",
      content: "Existing projects can add documents after migration.",
      clientId: "migration-check",
    });
    assert.equal(upgraded.getDocument(document.documentId).contentVersion, 1);
  } finally {
    upgraded.close();
  }

  const verified = new DatabaseSync(path);
  try {
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 13);
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM documents").get()?.count, 1);
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM document_events").get()?.count, 1);
  } finally {
    verified.close();
  }
});

test("artifacts are immutable, content-validated, and visible in the project event stream", async () => {
  const fixture = await boardFixture();
  try {
    const artifact = await fixture.board.createArtifact(fixture.project.projectId, {
      nodeId: null,
      taskId: null,
      mediaType: "text/vnd.mermaid",
      caption: "Checkout dependency map",
      contentBase64: Buffer.from("flowchart LR\nA --> B\n").toString("base64"),
    });
    assert.equal(artifact.caption, "Checkout dependency map");
    assert.equal(fixture.board.listArtifacts(fixture.project.projectId).length, 1);
    const stored = await fixture.board.artifactContent(artifact.artifactId);
    assert.equal(stored.bytes.toString("utf8"), "flowchart LR\nA --> B\n");
    assert.equal(fixture.board.listProjectEvents(fixture.project.projectId).at(-1)?.eventType, "artifact_created");
    await assert.rejects(
      fixture.board.createArtifact(fixture.project.projectId, {
        nodeId: null,
        taskId: null,
        mediaType: "image/png",
        caption: "Spoofed image",
        contentBase64: Buffer.from("not a png").toString("base64"),
      }),
      (error: unknown) => error instanceof TaskBoardError && error.code === "ARTIFACT_MEDIA_MISMATCH",
    );
  } finally {
    fixture.board.close();
  }
});

test("schema version 11 adds durable work-item planning links", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  const fixture = await boardFixture(path);
  fixture.board.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE work_item_planning_tasks; PRAGMA user_version = 11;");
  legacy.close();
  const upgraded = await TaskBoard.open(config(path));
  upgraded.close();
  const verified = new DatabaseSync(path);
  try {
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 13);
    assert.equal(
      verified.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_item_planning_tasks'").get()?.name,
      "work_item_planning_tasks",
    );
  } finally {
    verified.close();
  }
});

test("schema version 12 adds durable claim results while preserving active legacy runs", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await databasePath();
  const fixture = await boardFixture(path);
  fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Preserve a version 12 active run" }));
  const request = { claimId: "claim-v12-migration-active-0001", messageCursor: null } as const;
  const claim = fixture.board.claimRun(fixture.engineer.agentId, request);
  assert.ok(claim);
  fixture.board.close();

  const legacy = new DatabaseSync(path);
  legacy.exec("ALTER TABLE runs DROP COLUMN claim_result_json; PRAGMA user_version = 12;");
  legacy.close();

  const upgraded = await TaskBoard.open(config(path));
  try {
    const replay = upgraded.claimRun(fixture.engineer.agentId, request);
    assert.ok(replay);
    assert.equal(replay.run.runId, claim.run.runId);
    upgraded.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: "The migrated legacy run remained replayable and settleable.",
    });
  } finally {
    upgraded.close();
  }

  const verified = new DatabaseSync(path);
  try {
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 13);
    assert.equal(
      verified.prepare("SELECT name FROM pragma_table_info('runs') WHERE name = 'claim_result_json'").get()?.name,
      "claim_result_json",
    );
    assert.equal(
      verified.prepare("SELECT claim_result_json FROM runs WHERE run_id = ?").get(claim.run.runId)?.claim_result_json,
      null,
    );
  } finally {
    verified.close();
  }
});
