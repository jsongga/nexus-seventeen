import assert from "node:assert/strict";
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { BoardNotification, WorkflowPlanDraft } from "#shared/task-board-contract";
import {
  TaskBoard,
  normalizeTaskBoardConfig,
  type NotificationDeliveryAdapter,
} from "#server/task-board";
import {
  stageElapsedSeconds,
  taskActiveSeconds,
} from "#server/task-board/collaborators/wall-clock";
import {
  AGENT_ONE_TOKEN,
  AGENT_TWO_TOKEN,
  HUMAN_TOKEN,
  automationConfigurationRequest,
  automationStages,
  databasePath,
  latestParkRecord,
  workItemRequest,
} from "./helpers.js";

const START = "2026-08-21T12:00:00.000Z";
const BASE_SHA = "a".repeat(40);

function at(seconds: number): Date {
  return new Date(Date.parse(START) + seconds * 1_000);
}

function pipelinePlan(
  tier: "standard" | "hazardous" = "standard",
  suffix = "default",
): WorkflowPlanDraft {
  return {
    objective: "Exercise wall-clock caps on a confirmed pipeline.",
    assumptions: ["The injected clock is authoritative."],
    acceptanceCriteria: ["A runaway agent is suspended and its work item is parked."],
    changeShape: tier === "hazardous" ? "blast_radius" : "feature",
    tier,
    declaredScope: ["src/server", "tests/server"],
    nonGoals: ["Do not change the schema."],
    mechanicalPortions: [],
    blockingQuestions: [],
    criterionChecks: [],
    nodes: [{
      nodeId: `wall-clock-node-${suffix}`,
      title: "Exercise the wall-clock sweep",
      objective: "Keep a stage active beyond its configured cap.",
      acceptanceCriteria: ["The stage becomes resumably blocked."],
      dependencyNodeIds: [],
      stageTemplate: ["implementation", "testing", "verification"],
    }],
  };
}

async function capFixture(caps: Readonly<{
  stageCapSeconds: number;
  taskCapSeconds: number;
}>) {
  const path = await databasePath();
  let clock = at(0);
  const delivered: BoardNotification[] = [];
  const delivery: NotificationDeliveryAdapter = {
    deliver(notification) {
      delivered.push(notification);
    },
  };
  const board = await TaskBoard.open(normalizeTaskBoardConfig({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    heartbeatTimeoutSeconds: 0,
    port: 0,
    now: () => clock,
    ...caps,
  }), {
    git: () => BASE_SHA,
    notificationDelivery: delivery,
  });
  const project = board.createProject({
    name: "Wall-clock caps",
    description: "/tmp/wall-clock-caps",
  });
  const engineer = board.createAgent(project.projectId, {
    agentId: "wall-clock-engineer",
    role: "engineer",
    area: "runtime",
    mission: "Exercise stage cap behavior.",
    model: "codex-mini",
    token: AGENT_ONE_TOKEN,
  });
  const manager = board.createAgent(project.projectId, {
    agentId: "wall-clock-manager",
    role: "manager",
    area: "planning",
    mission: "Exercise planning cap behavior.",
    model: "claude-haiku",
    token: AGENT_TWO_TOKEN,
  });
  const implementationType = {
    agentTypeId: "wall-clock-implementation",
    name: "Wall-clock implementation",
    description: "Runs the implementation stage used by cap tests.",
    role: "engineer" as const,
    supplementalInstructions: "Keep the injected stage active.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  const verificationType = {
    ...implementationType,
    agentTypeId: "wall-clock-verification",
    name: "Wall-clock verification",
    role: "verifier" as const,
  };
  board.updateAutomationConfiguration(automationConfigurationRequest({
    agentTypes: [implementationType, verificationType],
    stages: automationStages({
      implementation: { kind: "agent_type", agentTypeId: implementationType.agentTypeId },
      testing: { kind: "machine_verify" },
      verification: { kind: "agent_type", agentTypeId: verificationType.agentTypeId },
    }),
  }));
  return {
    board,
    delivered,
    engineer,
    manager,
    path,
    project,
    setNow(seconds: number) {
      clock = at(seconds);
    },
  };
}

async function startPlanning(fixture: Awaited<ReturnType<typeof capFixture>>, suffix: string) {
  const workItem = fixture.board.createWorkItemAndStartPlanning(workItemRequest({
    originalRequest: `Exercise wall-clock planning ${suffix}.`,
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), `wall-clock-${suffix}`).workItem;
  const planning = fixture.board.claimRun(fixture.manager.agentId, {
    claimId: `wall-clock-planning-${suffix}`,
    messageCursor: null,
  });
  assert.ok(planning);
  return { planning, workItem };
}

async function startPipeline(fixture: Awaited<ReturnType<typeof capFixture>>, suffix: string) {
  const { planning, workItem } = await startPlanning(fixture, suffix);
  fixture.board.settleRun(planning.run.runId, fixture.manager.agentId, {
    outcome: "completed",
    result: "The wall-clock pipeline is ready.",
    workflowPlan: pipelinePlan("standard", suffix),
  });
  const plan = fixture.board.projectWorkflow(fixture.project.projectId).plans.find(
    (candidate) => candidate.state === "proposed",
  );
  assert.ok(plan);
  const confirmed = fixture.board.confirmWorkflow(plan.planRevisionId, { expectedState: "proposed" });
  const node = confirmed.nodes[0];
  assert.ok(node);
  const implementation = fixture.board.claimRun(fixture.engineer.agentId, {
    claimId: `wall-clock-implementation-${suffix}`,
    messageCursor: null,
  });
  assert.ok(implementation);
  const inspected = new DatabaseSync(fixture.path, { readOnly: true });
  try {
    const attempt = inspected.prepare("SELECT attempt_id FROM stage_attempts WHERE task_id=?")
      .get(implementation.task!.taskId);
    assert.equal(typeof attempt?.attempt_id, "string");
    return { attemptId: String(attempt!.attempt_id), implementation, node, workItem };
  } finally {
    inspected.close();
  }
}

async function startDesign(fixture: Awaited<ReturnType<typeof capFixture>>, suffix: string) {
  const { planning, workItem } = await startPlanning(fixture, suffix);
  fixture.board.settleRun(planning.run.runId, fixture.manager.agentId, {
    outcome: "completed",
    result: "The hazardous wall-clock pipeline is ready for design.",
    workflowPlan: pipelinePlan("hazardous", suffix),
  });
  const plan = fixture.board.projectWorkflow(fixture.project.projectId).plans.find(
    (candidate) => candidate.state === "proposed",
  );
  assert.ok(plan);
  fixture.board.confirmWorkflow(plan.planRevisionId, { expectedState: "proposed" });
  const design = fixture.board.claimRun(fixture.manager.agentId, {
    claimId: `wall-clock-design-${suffix}`,
    messageCursor: null,
  });
  assert.ok(design);
  assert.equal(design.context.design, true);
  return { design, workItem };
}

test("stage clock uses retry boundaries and task clock sums post-resume run intervals", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE project_events(
        sequence INTEGER PRIMARY KEY,
        node_id TEXT,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE work_item_transitions(
        work_item_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        to_state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE runs(
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE TABLE work_item_planning_tasks(work_item_id TEXT NOT NULL, task_id TEXT NOT NULL);
      CREATE TABLE work_item_design_tasks(work_item_id TEXT NOT NULL, task_id TEXT NOT NULL);
      CREATE TABLE plan_revisions(plan_revision_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL);
      CREATE TABLE work_nodes(node_id TEXT PRIMARY KEY, plan_revision_id TEXT NOT NULL);
      CREATE TABLE stage_attempts(node_id TEXT NOT NULL, task_id TEXT NOT NULL);
      CREATE TABLE park_records(work_item_id TEXT NOT NULL, resolved_at TEXT, resolution TEXT);
    `);
    const event = db.prepare("INSERT INTO project_events VALUES(?,?,?,?)");
    event.run(1, "node-1", "stage_started", "2026-08-21T11:00:00.000Z");
    event.run(2, "node-1", "stage_completed", "2026-08-21T12:29:00.000Z");
    event.run(3, "node-1", "stage_retry_ready", "2026-08-21T12:20:00.000Z");
    assert.equal(stageElapsedSeconds(db, "node-1", "2026-08-21T12:30:00.000Z"), 600);
    assert.equal(stageElapsedSeconds(db, "missing-node", "2026-08-21T12:30:00.000Z"), null);

    const transition = db.prepare("INSERT INTO work_item_transitions VALUES('item-1',?,?,?)");
    transition.run(1, "queued", "2026-08-21T10:00:00.000Z");
    transition.run(2, "designing", "2026-08-21T10:10:00.000Z");
    transition.run(3, "parked", "2026-08-21T10:20:00.000Z");
    transition.run(4, "planning", "2026-08-21T10:50:00.000Z");
    transition.run(5, "final_approval", "2026-08-21T11:05:00.000Z");
    transition.run(6, "implementing", "2026-08-21T11:20:00.000Z");
    transition.run(7, "verifying", "2026-08-21T11:25:00.000Z");
    transition.run(8, "parked", "2026-08-21T11:30:00.000Z");
    transition.run(9, "reviewing", "2026-08-21T11:50:00.000Z");
    db.prepare("INSERT INTO work_item_planning_tasks VALUES('item-1','planning-task')").run();
    db.prepare("INSERT INTO work_item_design_tasks VALUES('item-1','design-task')").run();
    db.prepare("INSERT INTO plan_revisions VALUES('plan-1','item-1')").run();
    db.prepare("INSERT INTO work_nodes VALUES('node-1','plan-1')").run();
    db.prepare("INSERT INTO stage_attempts VALUES('node-1','stage-task')").run();
    db.prepare("INSERT INTO park_records VALUES('item-1',?,'resumed')")
      .run("2026-08-21T11:00:00.000Z");
    const run = db.prepare("INSERT INTO runs VALUES(?,?,?,?)");
    run.run("pre-resume-planning", "planning-task", "2026-08-21T10:00:00.000Z", "2026-08-21T10:10:00.000Z");
    run.run("cross-resume-design", "design-task", "2026-08-21T10:59:00.000Z", "2026-08-21T11:05:00.000Z");
    run.run("post-resume-stage", "stage-task", "2026-08-21T11:10:00.000Z", "2026-08-21T11:20:00.000Z");
    run.run("post-resume-planning", "planning-task", "2026-08-21T11:30:00.000Z", "2026-08-21T11:35:00.000Z");
    run.run("active-stage", "stage-task", "2026-08-21T11:50:00.000Z", null);
    assert.equal(taskActiveSeconds(db, "item-1", "2026-08-21T12:00:00.000Z"), 1_500);
  } finally {
    db.close();
  }
});

test("stage cap suspends the run, blocks the node, parks exactly, and notifies once", async () => {
  const fixture = await capFixture({ stageCapSeconds: 3_600, taskCapSeconds: 10_800 });
  try {
    const active = await startPipeline(fixture, "stage-cap");
    fixture.setNow(3_601);
    const reason = "stage cap exceeded: implementation ran 3601s (cap 3600s)";
    assert.deepEqual(fixture.board.sweepWallClockCaps(at(3_601).toISOString()), { suspended: 1, parked: 1 });
    assert.equal(fixture.board.snapshot(fixture.project.projectId).recentRuns.find(
      (run) => run.runId === active.implementation.run.runId,
    )?.status, "interrupted");
    assert.equal(fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]?.state, "blocked");
    assert.deepEqual(latestParkRecord(fixture.path, active.workItem.workItemId), {
      category: "stage_cap_exceeded",
      reason,
    });
    assert.equal(fixture.board.requireWorkItem(active.workItem.workItemId).currentStage, "implementation");
    assert.deepEqual(fixture.board.sweepWallClockCaps(at(3_601).toISOString()), { suspended: 0, parked: 0 });
    assert.equal(fixture.delivered.length, 1);
    assert.equal(fixture.delivered[0]?.kind, "cap_parked");
    assert.equal(fixture.delivered[0]?.dedupeKey, `cap_parked:${active.workItem.workItemId}:${active.attemptId}`);
    assert.equal(fixture.delivered[0]?.summary, `Work item parked: ${reason}`);
  } finally {
    fixture.board.close();
  }
});

test("a cap-parked stage stays blocked through reconciliation and human retry reactivates it", async () => {
  const fixture = await capFixture({ stageCapSeconds: 60, taskCapSeconds: 0 });
  try {
    const active = await startPipeline(fixture, "parked-reconcile");
    fixture.setNow(61);
    assert.deepEqual(fixture.board.sweepWallClockCaps(at(61).toISOString()), { suspended: 1, parked: 1 });

    const before = new DatabaseSync(fixture.path, { readOnly: true });
    let attemptCount = 0;
    let taskCount = 0;
    try {
      attemptCount = Number(before.prepare("SELECT COUNT(*) AS count FROM stage_attempts WHERE node_id=?")
        .get(active.node.nodeId)?.count);
      taskCount = Number(before.prepare(`
        SELECT COUNT(*) AS count
        FROM tasks task
        JOIN stage_attempts attempt ON attempt.task_id=task.task_id
        WHERE attempt.node_id=?
      `).get(active.node.nodeId)?.count);
    } finally {
      before.close();
    }

    fixture.board.reconcileWorkflowsBestEffort(fixture.project.projectId);
    assert.equal(fixture.board.requireWorkItem(active.workItem.workItemId).state, "parked");
    assert.equal(fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]?.state, "blocked");
    const reconciled = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(Number(reconciled.prepare("SELECT COUNT(*) AS count FROM stage_attempts WHERE node_id=?")
        .get(active.node.nodeId)?.count), attemptCount);
      assert.equal(Number(reconciled.prepare(`
        SELECT COUNT(*) AS count
        FROM tasks task
        JOIN stage_attempts attempt ON attempt.task_id=task.task_id
        WHERE attempt.node_id=?
      `).get(active.node.nodeId)?.count), taskCount);
    } finally {
      reconciled.close();
    }

    const suspended = fixture.board.requireTask(active.implementation.task!.taskId);
    assert.equal(suspended.status, "interrupted");
    const retried = fixture.board.retryTask(suspended.taskId, { version: suspended.version });
    assert.equal(retried.task.status, "queued");
    assert.equal(fixture.board.requireWorkItem(active.workItem.workItemId).state, "implementing");
    assert.equal(fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]?.state, "active");
    const resumed = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "wall-clock-parked-reconcile-retry",
      messageCursor: null,
    });
    assert.ok(resumed);
    assert.equal(resumed.task?.taskId, suspended.taskId);
  } finally {
    fixture.board.close();
  }
});

test("cap notifications use the sweep's injected timestamp", async () => {
  const fixture = await capFixture({ stageCapSeconds: 60, taskCapSeconds: 0 });
  try {
    const active = await startPipeline(fixture, "notification-clock");
    const sweepNow = at(61).toISOString();
    assert.deepEqual(fixture.board.sweepWallClockCaps(sweepNow), { suspended: 1, parked: 1 });
    assert.equal(fixture.delivered[0]?.createdAt, sweepNow);
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(inspected.prepare("SELECT created_at FROM notifications WHERE dedupe_key=?")
        .get(`cap_parked:${active.workItem.workItemId}:${active.attemptId}`)?.created_at, sweepNow);
    } finally {
      inspected.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("task cap resets after human retry and does not immediately re-park the new run", async () => {
  const fixture = await capFixture({ stageCapSeconds: 0, taskCapSeconds: 60 });
  try {
    const active = await startPipeline(fixture, "task-cap");
    fixture.setNow(61);
    const reason = "task cap exceeded: 61s agent-active (cap 60s)";
    assert.deepEqual(fixture.board.sweepWallClockCaps(at(61).toISOString()), { suspended: 1, parked: 1 });
    assert.deepEqual(latestParkRecord(fixture.path, active.workItem.workItemId), {
      category: "task_cap_exceeded",
      reason,
    });
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const transition = db.prepare(`
        SELECT actor_type,actor_id FROM work_item_transitions
        WHERE work_item_id=? AND to_state='parked'
        ORDER BY sequence DESC LIMIT 1
      `).get(active.workItem.workItemId);
      assert.deepEqual({ ...transition }, { actor_type: "system", actor_id: "system:task-cap" });
    } finally {
      db.close();
    }

    fixture.setNow(61);
    const suspended = fixture.board.requireTask(active.implementation.task!.taskId);
    fixture.board.retryTask(suspended.taskId, { version: suspended.version });
    const resumed = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "wall-clock-task-cap-resumed-run",
      messageCursor: null,
    });
    assert.ok(resumed);
    fixture.setNow(120);
    assert.deepEqual(fixture.board.sweepWallClockCaps(at(120).toISOString()), { suspended: 0, parked: 0 });
    assert.equal(fixture.board.requireWorkItem(active.workItem.workItemId).state, "implementing");
    assert.equal(fixture.delivered.length, 1);
  } finally {
    fixture.board.close();
  }
});

test("task cap sums genuine run time across stage retries within one resumed epoch and parks once", async () => {
  const fixture = await capFixture({ stageCapSeconds: 0, taskCapSeconds: 60 });
  try {
    const active = await startPipeline(fixture, "task-cap-cumulative-runs");
    fixture.setNow(40);
    fixture.board.settleRun(active.implementation.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: "The first implementation attempt needs another pass.",
      handoff: {
        outcome: "failed",
        summary: "The first implementation attempt needs another pass.",
        evidence: [],
        artifactIds: [],
        acceptanceCriteria: [],
        blockers: ["Retry the implementation."],
        recommendedReturnStage: "implementation",
      },
    });
    fixture.setNow(1_000);
    const retried = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "wall-clock-task-cap-cumulative-retry",
      messageCursor: null,
    });
    assert.ok(retried);
    fixture.setNow(1_030);
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(taskActiveSeconds(
        inspected,
        active.workItem.workItemId,
        at(1_030).toISOString(),
      ), 70);
    } finally {
      inspected.close();
    }
    const reason = "task cap exceeded: 70s agent-active (cap 60s)";
    assert.deepEqual(fixture.board.sweepWallClockCaps(at(1_030).toISOString()), { suspended: 1, parked: 1 });
    assert.deepEqual(latestParkRecord(fixture.path, active.workItem.workItemId), {
      category: "task_cap_exceeded",
      reason,
    });
    assert.deepEqual(fixture.board.sweepWallClockCaps(at(1_030).toISOString()), { suspended: 0, parked: 0 });
    assert.equal(fixture.delivered.length, 1);
  } finally {
    fixture.board.close();
  }
});

test("pre-confirm planning runs receive the planning stage cap without a generic failure park", async () => {
  const fixture = await capFixture({ stageCapSeconds: 60, taskCapSeconds: 60 });
  try {
    const active = await startPlanning(fixture, "planning-cap");
    fixture.setNow(61);
    const reason = "stage cap exceeded: planning ran 61s (cap 60s)";
    assert.deepEqual(fixture.board.sweepWallClockCaps(at(61).toISOString()), { suspended: 1, parked: 1 });
    assert.deepEqual(latestParkRecord(fixture.path, active.workItem.workItemId), {
      category: "stage_cap_exceeded",
      reason,
    });
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM park_records
        WHERE work_item_id=? AND category='planning_run_failed'
      `).get(active.workItem.workItemId)?.count, 0);
    } finally {
      db.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("pipeline design runs use runs.started_at and suppress the generic design failure park", async () => {
  const fixture = await capFixture({ stageCapSeconds: 60, taskCapSeconds: 60 });
  try {
    const active = await startDesign(fixture, "design-cap");
    fixture.setNow(61);
    const reason = "stage cap exceeded: designing ran 61s (cap 60s)";
    assert.deepEqual(fixture.board.sweepWallClockCaps(at(61).toISOString()), { suspended: 1, parked: 1 });
    assert.deepEqual(latestParkRecord(fixture.path, active.workItem.workItemId), {
      category: "stage_cap_exceeded",
      reason,
    });
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM park_records
        WHERE work_item_id=? AND category='design_run_failed'
      `).get(active.workItem.workItemId)?.count, 0);
    } finally {
      db.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("disabled caps leave active work untouched", async () => {
  const fixture = await capFixture({ stageCapSeconds: 0, taskCapSeconds: 0 });
  try {
    const active = await startPlanning(fixture, "disabled-caps");
    fixture.setNow(100_000);
    assert.deepEqual(fixture.board.sweepWallClockCaps(at(100_000).toISOString()), { suspended: 0, parked: 0 });
    assert.equal(fixture.board.snapshot(fixture.project.projectId).recentRuns.find(
      (run) => run.runId === active.planning.run.runId,
    )?.status, "active");
    assert.equal(fixture.board.requireWorkItem(active.workItem.workItemId).state, "planning");
    assert.equal(fixture.delivered.length, 0);
  } finally {
    fixture.board.close();
  }
});

test("a scope-held item aged four hours with no runs accrues no task-cap time", async () => {
  const fixture = await capFixture({ stageCapSeconds: 60, taskCapSeconds: 60 });
  try {
    const confirmWithoutClaim = async (suffix: string) => {
      const { planning, workItem } = await startPlanning(fixture, suffix);
      fixture.board.settleRun(planning.run.runId, fixture.manager.agentId, {
        outcome: "completed",
        result: "The wall-clock pipeline is ready.",
        workflowPlan: pipelinePlan("standard", suffix),
      });
      const plan = fixture.board.projectWorkflow(fixture.project.projectId).plans.find(
        (candidate) => candidate.state === "proposed",
      );
      assert.ok(plan);
      const confirmed = fixture.board.confirmWorkflow(plan.planRevisionId, { expectedState: "proposed" });
      const node = confirmed.nodes.find((candidate) => candidate.planRevisionId === plan.planRevisionId);
      assert.ok(node);
      return { node, workItem };
    };

    const holder = await confirmWithoutClaim("scope-holder");
    fixture.setNow(1);
    const held = await confirmWithoutClaim("scope-held");
    assert.equal(held.node.state, "blocked");

    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare("DELETE FROM project_events WHERE node_id=? AND event_type='node_blocked'")
        .run(held.node.nodeId);
      db.prepare("UPDATE work_nodes SET state='ready',version=version+1 WHERE node_id=?")
        .run(held.node.nodeId);
      db.prepare(`
        INSERT INTO project_events(
          event_id,project_id,node_id,task_id,event_type,summary,created_at
        ) VALUES (?, ?, ?, NULL, 'stage_started', 'stale synthetic stage entry', ?)
      `).run(
        "event-wall-clock-scope-held-stale-stage",
        fixture.project.projectId,
        held.node.nodeId,
        at(0).toISOString(),
      );
    } finally {
      db.close();
    }

    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const blocked = fixture.board.projectWorkflow(fixture.project.projectId).nodes.find(
      (candidate) => candidate.nodeId === held.node.nodeId,
    );
    assert.equal(blocked?.state, "blocked");
    const latestBlock = fixture.board.listProjectEvents(fixture.project.projectId).findLast(
      (event) => event.nodeId === held.node.nodeId && event.eventType === "node_blocked",
    );
    assert.equal(latestBlock?.summary, `scope-hold: overlaps ${holder.workItem.workItemId}`);
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(stageElapsedSeconds(inspected, held.node.nodeId, at(14_400).toISOString()), 14_400);
      assert.equal(taskActiveSeconds(inspected, held.workItem.workItemId, at(14_400).toISOString()), 0);
      assert.equal(inspected.prepare(`
        SELECT COUNT(*) AS count
        FROM runs run
        JOIN stage_attempts attempt ON attempt.task_id=run.task_id
        WHERE attempt.node_id=? AND run.status='active'
      `).get(held.node.nodeId)?.count, 0);
    } finally {
      inspected.close();
    }

    assert.deepEqual(fixture.board.sweepWallClockCaps(at(14_400).toISOString()), { suspended: 0, parked: 0 });
    assert.equal(fixture.board.requireWorkItem(held.workItem.workItemId).state, "implementing");
    assert.equal(fixture.delivered.length, 0);
  } finally {
    fixture.board.close();
  }
});

test("a run settled after candidate selection is a no-op inside the cap transaction", async () => {
  const fixture = await capFixture({ stageCapSeconds: 60, taskCapSeconds: 60 });
  const active = await startPlanning(fixture, "settled-race");
  fixture.setNow(61);
  const originalPrepare = DatabaseSync.prototype.prepare;
  let interleaved = false;
  DatabaseSync.prototype.prepare = function settleSelectedRun(this: DatabaseSyncType, sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (!interleaved && /WITH pipeline_plans[\s\S]*UNION ALL[\s\S]*work_item_planning_tasks/u.test(sql)) {
      const originalAll = statement.all.bind(statement) as (...values: SQLInputValue[]) => Record<string, unknown>[];
      statement.all = ((...values: SQLInputValue[]) => {
        const rows = originalAll(...values);
        if (rows.some((row) => row.run_id === active.planning.run.runId)) {
          originalPrepare.call(this, `
            UPDATE runs
            SET status='completed',ended_at=?,result='settled before cap transaction'
            WHERE run_id=? AND status='active'
          `).run(at(61).toISOString(), active.planning.run.runId);
          interleaved = true;
        }
        return rows;
      }) as typeof statement.all;
    }
    return statement;
  };
  try {
    assert.deepEqual(fixture.board.sweepWallClockCaps(at(61).toISOString()), { suspended: 0, parked: 0 });
    assert.equal(interleaved, true);
    assert.equal(fixture.board.requireWorkItem(active.workItem.workItemId).state, "planning");
    assert.equal(fixture.delivered.length, 0);
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    fixture.board.close();
  }
});
