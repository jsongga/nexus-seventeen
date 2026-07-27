import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, stat } from "node:fs/promises";
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
    assert.equal(Number(direct.prepare("PRAGMA user_version").get()?.user_version), 12);
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
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 12);
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
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 12);
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
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 12);
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
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 12);
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
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 12);
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
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 12);
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
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 12);
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
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 12);
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
    assert.equal(Number(verified.prepare("PRAGMA user_version").get()?.user_version), 12);
    assert.equal(
      verified.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_item_planning_tasks'").get()?.name,
      "work_item_planning_tasks",
    );
  } finally {
    verified.close();
  }
});
