import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  ChildWorkItem,
  DeclaredChild,
  DesignRecordDraft,
  WorkItem,
} from "#shared/task-board-contract";
import { DESIGN_FAILURE_POINTS } from "#shared/task-board-contract";
import { TaskBoard, TaskBoardError } from "#server/task-board";
import { TaskBoardRuntime } from "#server/task-board/collaborators/runtime";
import { transitionWorkItemInTransaction } from "#server/task-board/collaborators/work-item-transitions";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import {
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  config,
  gateActions,
  latestParkRecord,
  workItemRequest,
} from "./helpers.js";

const BASE_SHA = "1".repeat(40);
const ADVANCED_SHA = "2".repeat(40);
const CONSUMER_BASE_SHA = "3".repeat(40);
const VERIFIED_SHAS = ["a".repeat(40), "b".repeat(40), "c".repeat(40)] as const;
const MERGE_SHAS = ["d".repeat(40), "e".repeat(40), "f".repeat(40)] as const;
const NOW = "2026-08-29T14:00:00.000Z";

const IMPLEMENTER = {
  agentTypeId: "decomposition-runtime-implementer",
  name: "Decomposition runtime implementer",
  description: "Implements independently mergeable decomposition children.",
  role: "engineer" as const,
  supplementalInstructions: "Implement only the declared child scope.",
  skillIds: [],
  evaluatorProfile: "tests" as const,
  enabled: true,
};

const REVIEWER = {
  ...IMPLEMENTER,
  agentTypeId: "decomposition-runtime-reviewer",
  name: "Decomposition runtime reviewer",
  role: "verifier" as const,
};

function configureChildPipeline(board: TaskBoard): void {
  const current = board.getAutomationConfiguration();
  board.updateAutomationConfiguration(automationConfigurationRequest({
    version: current.version,
    agentTypes: [IMPLEMENTER, REVIEWER],
    stages: automationStages({
      implementation: { kind: "agent_type", agentTypeId: IMPLEMENTER.agentTypeId },
      testing: { kind: "machine_verify" },
      verification: { kind: "agent_type", agentTypeId: REVIEWER.agentTypeId },
    }),
  }));
}

function proposeParent(
  board: TaskBoard,
  projectId: string,
  children: readonly DeclaredChild[],
  suffix: string,
  changeShape: "feature" | "blast_radius" = "feature",
  tier: "standard" | "hazardous" = "standard",
) {
  configureChildPipeline(board);
  const parent = board.createWorkItem(workItemRequest({
    originalRequest: `Coordinate decomposition runtime ${suffix}.`,
    projectTarget: { mode: "explicit", projectId },
  }), `decomposition-runtime-${suffix}`).workItem;
  const workflow = board.proposeWorkflow({
    workItemId: parent.workItemId,
    projectId,
    objective: `Coordinate ${suffix} children.`,
    assumptions: [],
    acceptanceCriteria: ["Every child reaches its governed merge outcome."],
    changeShape,
    tier,
    declaredScope: ["coordination"],
    children,
    skillIds: [],
    nodes: [{
      nodeId: `parent-${suffix}`,
      title: `Coordinate ${suffix}`,
      objective: `Coordinate ${suffix}.`,
      acceptanceCriteria: ["The parent records child completion."],
      dependencyNodeIds: [],
      stageTemplate: ["verification"],
    }],
  });
  const revision = workflow.plans.find((candidate) => candidate.workItemId === parent.workItemId);
  assert.ok(revision);
  board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
  return { parent, revision, children: board.listChildren(parent.workItemId) };
}

function proposeStandalonePipeline(
  board: TaskBoard,
  projectId: string,
  declaredScope: readonly string[],
  suffix: string,
): WorkItem {
  configureChildPipeline(board);
  const workItem = board.createWorkItem(workItemRequest({
    originalRequest: `Run standalone decomposition regression ${suffix}.`,
    projectTarget: { mode: "explicit", projectId },
  }), `decomposition-standalone-${suffix}`).workItem;
  const workflow = board.proposeWorkflow({
    workItemId: workItem.workItemId,
    projectId,
    objective: `Run standalone ${suffix}.`,
    assumptions: [],
    acceptanceCriteria: ["The pipeline activates when its overlapping predecessor releases scope."],
    changeShape: "feature",
    tier: "standard",
    declaredScope,
    skillIds: [],
    nodes: [{
      nodeId: `standalone-${suffix}`,
      title: `Standalone ${suffix}`,
      objective: `Run standalone ${suffix}.`,
      acceptanceCriteria: ["The pipeline activates after scope release."],
      dependencyNodeIds: [],
      stageTemplate: ["implementation", "testing", "verification"],
    }],
  });
  const revision = workflow.plans.find((candidate) => candidate.workItemId === workItem.workItemId);
  assert.ok(revision);
  board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
  return board.requireWorkItem(workItem.workItemId);
}

function phasedChildren(
  providerProjectId: string,
  consumerProjectId: string,
  suffix: string,
): readonly DeclaredChild[] {
  return [{
    key: "expand",
    objective: `Expand the provider interface for ${suffix}.`,
    projectId: providerProjectId,
    declaredScope: [`src/${suffix}-expand`],
    acceptanceCriteria: ["The expansion is independently mergeable."],
    phase: "expand",
    splitBy: "phase",
  }, {
    key: "migrate",
    objective: `Migrate the consumer interface for ${suffix}.`,
    projectId: consumerProjectId,
    declaredScope: [`src/${suffix}-migrate`],
    acceptanceCriteria: ["The migration waits for expansion."],
    phase: "migrate",
    splitBy: "consumer",
    dependsOn: ["expand"],
  }, {
    key: "contract",
    objective: `Contract the provider interface for ${suffix}.`,
    projectId: providerProjectId,
    declaredScope: [`src/${suffix}-contract`],
    acceptanceCriteria: ["The contraction waits for migration."],
    phase: "contract",
    splitBy: "phase",
    dependsOn: ["migrate"],
  }];
}

function childNode(board: TaskBoard, child: WorkItem) {
  assert.ok(child.resolvedProjectId);
  const workflow = board.projectWorkflow(child.resolvedProjectId);
  const plan = workflow.plans.find((candidate) => candidate.workItemId === child.workItemId);
  assert.ok(plan);
  const node = workflow.nodes.find((candidate) => candidate.planRevisionId === plan.planRevisionId);
  assert.ok(node);
  return { node, plan };
}

function forceMergedWithApproval(path: string, workItemId: string, mergeSha: string): void {
  const db = new DatabaseSync(path);
  try {
    const plan = db.prepare(`
      SELECT plan_revision_id
      FROM plan_revisions
      WHERE work_item_id=? AND state='confirmed'
      ORDER BY revision DESC
      LIMIT 1
    `).get(workItemId);
    assert.ok(plan);
    db.prepare(`
      UPDATE work_items
      SET state='merged',current_stage=NULL,ended_at=?,version=version+1,updated_at=?
      WHERE work_item_id=?
    `).run(NOW, NOW, workItemId);
    db.prepare(`
      INSERT INTO gate_actions(
        gate_action_id,work_item_id,gate,actor_id,plan_revision_id,
        verified_sha,merge_sha,ref_id,note,created_at
      ) VALUES(?,?,'final_approve','human:alice',?,NULL,?,NULL,NULL,?)
    `).run(`forced-final-${workItemId}`, workItemId, String(plan.plan_revision_id), mergeSha, NOW);
  } finally {
    db.close();
  }
}

function forceParentFinalApproval(path: string, workItemId: string): number {
  const db = new DatabaseSync(path);
  try {
    db.prepare(`
      UPDATE work_items
      SET state='final_approval',current_stage=NULL,version=version+1,updated_at=?
      WHERE work_item_id=?
    `).run(NOW, workItemId);
    return Number(db.prepare("SELECT version FROM work_items WHERE work_item_id=?")
      .get(workItemId)?.version);
  } finally {
    db.close();
  }
}

function forceFinalApproval(path: string, workItemId: string, verifiedSha: string): number {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare(`
      SELECT node.node_id
      FROM plan_revisions plan
      JOIN work_nodes node ON node.plan_revision_id=plan.plan_revision_id
      WHERE plan.work_item_id=? AND plan.state='confirmed'
      LIMIT 1
    `).get(workItemId);
    assert.ok(row);
    const attempt = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM verify_attempts
      WHERE node_id=?
    `).get(String(row.node_id))?.count) + 1;
    db.prepare(`
      INSERT INTO verify_attempts(
        verify_attempt_id,node_id,stage,attempt,verify_run_id,workspace_path,state,
        check_results_json,detail,created_at,ended_at
      ) VALUES(?,?,'testing',?, ?,NULL,'green','[]',?,?,?)
    `).run(
      `verify-${workItemId}-${attempt}`,
      String(row.node_id),
      attempt,
      `verify-run-${workItemId}-${attempt}`,
      `verified-sha:${verifiedSha}`,
      NOW,
      NOW,
    );
    db.prepare(`
      UPDATE work_nodes
      SET state='completed',current_stage=NULL,version=version+1,updated_at=?
      WHERE node_id=?
    `).run(NOW, String(row.node_id));
    db.prepare(`
      UPDATE work_items
      SET state='final_approval',current_stage=NULL,ended_at=NULL,version=version+1,updated_at=?
      WHERE work_item_id=?
    `).run(NOW, workItemId);
    return Number(db.prepare("SELECT version FROM work_items WHERE work_item_id=?")
      .get(workItemId)?.version);
  } finally {
    db.close();
  }
}

function hazardousDesignRecord(): DesignRecordDraft {
  return {
    states: ["pending", "committed", "unknown"],
    transitions: [{
      from: "pending",
      to: "committed",
      durablePrecondition: "Persist the child intent before the side effect.",
      recovery: "Resume from the durable child intent.",
    }],
    failurePoints: DESIGN_FAILURE_POINTS.map((point) => ({
      point,
      resultingState: `durable child state after ${point}`,
      recovery: `recover the child after ${point}`,
    })),
    idempotencyKeys: [{
      name: "child-operation-key",
      generatedAt: "Before the first side effect.",
      persistedAt: "With the durable child intent.",
      reuse: "Reuse for every retry.",
    }],
    faultInjectionCases: [{
      name: "Crash after child commit",
      scenario: "Terminate after the commit and before acknowledgement.",
      expectation: "The retry observes the committed child result.",
    }],
  };
}

function latestNodeBlock(path: string, nodeId: string): string | null {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT summary
      FROM project_events
      WHERE node_id=? AND event_type='node_blocked'
      ORDER BY sequence DESC
      LIMIT 1
    `).get(nodeId);
    return row === undefined ? null : String(row.summary);
  } finally {
    db.close();
  }
}

function latestTransitionActor(path: string, workItemId: string): Readonly<{
  actorType: string;
  actorId: string;
}> | null {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT actor_type,actor_id
      FROM work_item_transitions
      WHERE work_item_id=?
      ORDER BY sequence DESC
      LIMIT 1
    `).get(workItemId);
    return row === undefined ? null : Object.freeze({
      actorType: String(row.actor_type),
      actorId: String(row.actor_id),
    });
  } finally {
    db.close();
  }
}

test("unphased dependencies order merges without blocking parallel child activation", async () => {
  const verifiedByBranch = new Map<string, string>();
  const mergeOrder: string[] = [];
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline(request) {
      mergeOrder.push(request.branch.slice("task/".length));
      return { kind: "merged", mergeSha: MERGE_SHAS[mergeOrder.length - 1]! };
    },
  });
  const declared: readonly DeclaredChild[] = [{
    key: "first",
    objective: "Merge the first child.",
    projectId: fixture.project.projectId,
    declaredScope: ["src/first"],
    acceptanceCriteria: ["The first child merges."],
  }, {
    key: "second",
    objective: "Start in parallel but merge after the first child.",
    projectId: fixture.project.projectId,
    declaredScope: ["src/second"],
    acceptanceCriteria: ["The second child starts immediately and merges second."],
    dependsOn: ["first"],
  }];

  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      declared,
      "dependency-readiness",
    );
    const [first, second] = decomposition.children;
    assert.ok(first);
    assert.ok(second);
    assert.equal(fixture.board.requireWorkItem(first.workItemId).state, "implementing");
    assert.equal(fixture.board.requireWorkItem(second.workItemId).state, "implementing");
    assert.equal(childNode(fixture.board, first).node.state, "active");
    assert.equal(childNode(fixture.board, second).node.state, "active");

    for (const [index, child] of [first, second].entries()) {
      verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[index]!);
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const parent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(parent.state, "final_approval");
    const settled = await fixture.board.approvePipelineMerge(parent.workItemId, { version: parent.version });
    assert.equal(settled.state, "merged");
    assert.deepEqual(mergeOrder, [first.workItemId, second.workItemId]);
  } finally {
    fixture.board.close();
  }
});

test("confirm activates children in another project through the parent project's scoped pass", async () => {
  const fixture = await boardFixture(
    undefined,
    undefined,
    { git: () => `${BASE_SHA}\n` },
    { reconcileIntervalSeconds: 0 },
  );
  try {
    const childProject = fixture.board.createProject({
      name: "Cross-project child owner",
      description: "Owns every child while the decomposition parent stays in the intake project.",
      repoPath: "/repos/cross-project-child-owner",
    });

    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "remote-one",
      objective: "Activate the first remote child during confirmation.",
      projectId: childProject.projectId,
      declaredScope: ["src/remote-one"],
      acceptanceCriteria: ["The first remote child starts without a timer."],
    }, {
      key: "remote-two",
      objective: "Activate the second remote child during confirmation.",
      projectId: childProject.projectId,
      declaredScope: ["src/remote-two"],
      acceptanceCriteria: ["The second remote child starts without a timer."],
    }], "parent-project-confirm-pass");

    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).resolvedProjectId, fixture.project.projectId);
    assert.ok(decomposition.children.every((child) => child.resolvedProjectId === childProject.projectId));
    assert.deepEqual(
      decomposition.children.map((child) => fixture.board.requireWorkItem(child.workItemId).state),
      ["implementing", "implementing"],
    );
    assert.ok(decomposition.children.every((child) => childNode(fixture.board, child).node.state === "active"));
  } finally {
    fixture.board.close();
  }
});

test("unphased child activation keeps its confirmation-time base when the default branch moves", async () => {
  let headReads = 0;
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      if (arguments_.includes("rev-parse") && arguments_.at(-1) === "HEAD") {
        headReads += 1;
        return `${headReads === 1 ? BASE_SHA : ADVANCED_SHA}\n`;
      }
      throw new Error(`unexpected git command: ${arguments_.join(" ")}`);
    },
  });
  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "unphased-moving-head",
      objective: "Keep the confirmation-time base for an unphased child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/unphased-moving-head"],
      acceptanceCriteria: ["Activation does not refresh an unphased base."],
    }], "unphased-moving-head");
    const [child] = decomposition.children;
    assert.ok(child);
    assert.equal(headReads, 1);
    assert.equal(fixture.board.requireWorkItem(child.workItemId).baseSha, BASE_SHA);
  } finally {
    fixture.board.close();
  }
});

test("a ready hazardous child enters the ordinary Design stage while implementation stays pending", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "hazardous-child",
      objective: "Design and implement the hazardous child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/hazardous"],
      acceptanceCriteria: ["The hazardous child follows Design."],
      splitBy: "consumer",
    }], "hazardous-readiness", "blast_radius", "hazardous");
    const [child] = decomposition.children;
    assert.ok(child);
    assert.equal(fixture.board.requireWorkItem(child.workItemId).state, "designing");
    const node = childNode(fixture.board, child).node;
    assert.equal(node.state, "pending");
    assert.equal(node.currentStage, null);
    const db = new DatabaseSync(fixture.path);
    try {
      assert.equal(Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM work_item_design_tasks
        WHERE work_item_id=?
      `).get(child.workItemId)?.count), 1);
      assert.equal(Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM stage_attempts
        WHERE node_id=? AND stage='implementation'
      `).get(node.nodeId)?.count), 0);
      db.prepare(`
        UPDATE tasks
        SET status='cancelled',started_at=COALESCE(started_at,?),ended_at=?,result='Superseded by direct test proposal',
          version=version+1,updated_at=?
        WHERE task_id IN (
          SELECT task_id FROM work_item_planning_tasks WHERE work_item_id=?
        ) AND ended_at IS NULL
      `).run(NOW, NOW, NOW, decomposition.parent.workItemId);
    } finally {
      db.close();
    }
    const designClaim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-hazardous-decomposition-design",
      messageCursor: null,
    });
    assert.ok(designClaim?.task);
    assert.equal(designClaim.context.design, true);
    fixture.board.settleRun(designClaim.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "The hazardous child design is confirmed.",
      designRecord: hazardousDesignRecord(),
    });
    assert.equal(fixture.board.requireWorkItem(child.workItemId).state, "implementing");
    const activated = childNode(fixture.board, child).node;
    assert.equal(activated.state, "active");
    assert.equal(activated.currentStage, "implementation");
  } finally {
    fixture.board.close();
  }
});

test("feature parent approval merges children in dependency order and settles parent audit", async () => {
  const verifiedByBranch = new Map<string, string>();
  const mergeOrder: string[] = [];
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline(request) {
      const workItemId = request.branch.slice("task/".length);
      mergeOrder.push(workItemId);
      const index = mergeOrder.length - 1;
      return { kind: "merged", mergeSha: MERGE_SHAS[index]! };
    },
  });
  const declared: readonly DeclaredChild[] = [{
    key: "dependent",
    objective: "Merge after the provider child.",
    projectId: fixture.project.projectId,
    declaredScope: ["src/dependent"],
    acceptanceCriteria: ["The dependent merges second."],
    dependsOn: ["provider"],
  }, {
    key: "provider",
    objective: "Merge before the dependent child.",
    projectId: fixture.project.projectId,
    declaredScope: ["src/provider"],
    acceptanceCriteria: ["The provider merges first."],
  }];

  try {
    const { parent, revision, children } = proposeParent(
      fixture.board,
      fixture.project.projectId,
      declared,
      "feature-parent-approval",
    );
    const [dependent, provider] = children;
    assert.ok(dependent);
    assert.ok(provider);
    for (const [index, child] of [provider, dependent].entries()) {
      verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[index]!);
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const readyParent = fixture.board.requireWorkItem(parent.workItemId);
    assert.equal(readyParent.state, "final_approval");
    const readyNotification = fixture.board.listNotifications().unread.find(
      (notification) => notification.kind === "parent_ready_for_approval",
    );
    assert.ok(readyNotification);
    assert.match(readyNotification.dedupeKey ?? "", new RegExp(`^parent_ready_for_approval:${parent.workItemId}:`));

    const mergedParent = await fixture.board.approvePipelineMerge(parent.workItemId, {
      version: readyParent.version,
    });
    assert.equal(mergedParent.state, "merged");
    assert.deepEqual(mergeOrder, [provider.workItemId, dependent.workItemId]);
    assert.deepEqual(
      [provider, dependent].map((child) => gateActions(fixture.path, child.workItemId).at(-1)).map((action) => ({
        gate: action?.gate,
        actorId: action?.actorId,
        mergeSha: action?.mergeSha,
      })),
      [{ gate: "final_approve", actorId: "human:alice", mergeSha: MERGE_SHAS[0] }, {
        gate: "final_approve", actorId: "human:alice", mergeSha: MERGE_SHAS[1],
      }],
    );
    const parentApproval = gateActions(fixture.path, parent.workItemId).at(-1);
    assert.equal(parentApproval?.gate, "final_approve");
    assert.equal(parentApproval?.mergeSha, null);
    assert.equal(parentApproval?.refId, revision.planRevisionId);
    assert.equal(parentApproval?.note, "2 children merged, 0 abandoned");
    assert.deepEqual(latestTransitionActor(fixture.path, parent.workItemId), {
      actorType: "human",
      actorId: "human:alice",
    });
    assert.deepEqual(fixture.board.parentCompletion(parent.workItemId).children, [{
      workItemId: dependent.workItemId,
      mergeSha: MERGE_SHAS[1],
    }, {
      workItemId: provider.workItemId,
      mergeSha: MERGE_SHAS[0],
    }]);
  } finally {
    fixture.board.close();
  }
});

test("rejecting a promoted unphased parent fans rejection out and waits for child re-verification", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "reject-parent-one",
      objective: "Return through implementation when the parent approval is rejected.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/reject-parent-one"],
      acceptanceCriteria: ["The child is re-verified after parent rejection."],
    }, {
      key: "reject-parent-two",
      objective: "Also return through implementation while coordination resumes.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/reject-parent-two"],
      acceptanceCriteria: ["The second child is re-verified."],
    }], "reject-promoted-parent");
    for (const [index, child] of decomposition.children.entries()) {
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const parent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(parent.state, "final_approval");
    const notificationsBefore = fixture.board.listNotifications().unread.filter(
      (notification) => notification.kind === "parent_ready_for_approval",
    ).length;
    const note = "Coordinate the parent outcome again.";

    const rejected = await fixture.board.rejectFinalApproval(parent.workItemId, {
      version: parent.version,
      note,
    });

    assert.equal(rejected.state, "coordinating");
    assert.deepEqual(
      fixture.board.listChildren(parent.workItemId).map((child) => child.state),
      ["fixing", "fixing"],
    );
    for (const child of decomposition.children) {
      const action = gateActions(fixture.path, child.workItemId).at(-1);
      assert.equal(action?.gate, "final_reject");
      assert.equal(action?.actorId, "human:alice");
      assert.equal(action?.note, note);
    }
    const action = gateActions(fixture.path, parent.workItemId).at(-1);
    assert.equal(action?.gate, "final_reject");
    assert.equal(action?.actorId, "human:alice");
    assert.equal(action?.note, note);

    fixture.board.reconcileWorkflows(fixture.project.projectId);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "coordinating");
    assert.equal(fixture.board.listNotifications().unread.filter(
      (notification) => notification.kind === "parent_ready_for_approval",
    ).length, notificationsBefore);

    for (const [index, child] of decomposition.children.entries()) {
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "final_approval");
    assert.equal(fixture.board.listNotifications().unread.filter(
      (notification) => notification.kind === "parent_ready_for_approval",
    ).length, notificationsBefore + 1);
  } finally {
    fixture.board.close();
  }
});

test("rejecting one promoted child withdraws and then re-promotes its parent once", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "direct-reject-one",
      objective: "Leave final approval through a direct child rejection.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/direct-reject-one"],
      acceptanceCriteria: ["The parent approval is withdrawn."],
    }, {
      key: "direct-reject-two",
      objective: "Remain ready while the rejected sibling re-verifies.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/direct-reject-two"],
      acceptanceCriteria: ["The parent is promoted again after both children are ready."],
    }], "direct-child-rejection");
    for (const [index, child] of decomposition.children.entries()) {
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const promoted = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(promoted.state, "final_approval");
    const readyNotificationsBefore = fixture.board.listNotifications().unread.filter((notification) => (
      notification.kind === "parent_ready_for_approval"
      && notification.workItemId === promoted.workItemId
    )).length;
    const [rejectedChild] = decomposition.children;
    assert.ok(rejectedChild);

    const rejected = await fixture.board.rejectFinalApproval(rejectedChild.workItemId, {
      version: fixture.board.requireWorkItem(rejectedChild.workItemId).version,
      note: "Re-verify the directly rejected child.",
    });

    assert.equal(rejected.state, "fixing");
    const withdrawn = fixture.board.requireWorkItem(promoted.workItemId);
    assert.equal(withdrawn.state, "coordinating");
    assert.equal(withdrawn.version, promoted.version + 1);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(fixture.board.requireWorkItem(promoted.workItemId).state, "coordinating");
    assert.equal(fixture.board.listNotifications().unread.filter((notification) => (
      notification.kind === "parent_ready_for_approval"
      && notification.workItemId === promoted.workItemId
    )).length, readyNotificationsBefore);

    forceFinalApproval(fixture.path, rejectedChild.workItemId, VERIFIED_SHAS[2]);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const rePromoted = fixture.board.requireWorkItem(promoted.workItemId);
    assert.equal(rePromoted.state, "final_approval");
    assert.equal(rePromoted.version, withdrawn.version + 1);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(fixture.board.listNotifications().unread.filter((notification) => (
      notification.kind === "parent_ready_for_approval"
      && notification.workItemId === promoted.workItemId
    )).length, readyNotificationsBefore + 1);
  } finally {
    fixture.board.close();
  }
});

test("a branch-bearing item with children uses the leaf path for both approval decisions", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "predicate-child",
      objective: "Expose the decomposed-parent branch predicate.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/predicate-child"],
      acceptanceCriteria: ["Approval routing remains symmetric."],
    }], "decomposed-parent-predicate");
    const parentVersion = forceParentFinalApproval(fixture.path, decomposition.parent.workItemId);
    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare("UPDATE work_items SET pipeline_branch=?,base_sha=? WHERE work_item_id=?")
        .run(`task/${decomposition.parent.workItemId}`, BASE_SHA, decomposition.parent.workItemId);
    } finally {
      db.close();
    }

    await assert.rejects(
      fixture.board.rejectFinalApproval(decomposition.parent.workItemId, {
        version: parentVersion,
        note: "Exercise leaf rejection routing.",
      }),
      /TASK_BOARD_DATABASE_CORRUPT:pipeline_implementation_stage_missing/u,
    );
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "final_approval");
    assert.equal(gateActions(fixture.path, decomposition.parent.workItemId).some(
      (action) => action.gate === "final_reject",
    ), false);

    await assert.rejects(
      fixture.board.approvePipelineMerge(decomposition.parent.workItemId, { version: parentVersion }),
      (error: unknown) => error instanceof TaskBoardError
        && error.code === "TASK_BOARD_PIPELINE_BRANCH_MOVED",
    );
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "final_approval");
  } finally {
    fixture.board.close();
  }
});

test("a 64-child parent settles with bounded audit fields and derived child merge detail", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  const declared = Array.from({ length: 64 }, (_, ordinal): DeclaredChild => ({
    key: `child-${ordinal}`,
    objective: `Complete child ${ordinal}.`,
    projectId: fixture.project.projectId,
    declaredScope: [`src/child-${ordinal}`],
    acceptanceCriteria: [`Child ${ordinal} merges.`],
  }));
  try {
    const { parent, revision, children } = proposeParent(
      fixture.board,
      fixture.project.projectId,
      declared,
      "maximum-parent-completion",
    );
    for (const child of children) forceMergedWithApproval(fixture.path, child.workItemId, MERGE_SHAS[0]);
    const parentVersion = forceParentFinalApproval(fixture.path, parent.workItemId);

    const settled = await fixture.board.approvePipelineMerge(parent.workItemId, { version: parentVersion });

    assert.equal(settled.state, "merged");
    const action = gateActions(fixture.path, parent.workItemId).at(-1);
    assert.equal(action?.refId, revision.planRevisionId);
    assert.equal(action?.note, "64 children merged, 0 abandoned");
    const completion = fixture.board.parentCompletion(parent.workItemId);
    assert.equal(completion.parentWorkItemId, parent.workItemId);
    assert.equal(completion.children.length, 64);
    assert.ok(completion.children.every((child) => child.mergeSha === MERGE_SHAS[0]));
    assert.ok(fixture.board.listChildren(parent.workItemId).every((child) => child.mergeSha === MERGE_SHAS[0]));
  } finally {
    fixture.board.close();
  }
});

test("repo_busy in one phased parent does not block an unrelated parent promotion", async () => {
  const verifiedByBranch = new Map<string, string>();
  let busyBranch = "";
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      if (arguments_.includes("--abbrev-ref")) return "main\n";
      if (arguments_.includes("--porcelain")) return "";
      if (arguments_.includes("merge-base")) return "";
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline(request) {
      return request.branch === busyBranch
        ? { kind: "repo_busy" }
        : { kind: "merged", mergeSha: MERGE_SHAS[0] };
    },
  });
  const consumer = fixture.board.createProject({
    name: "Busy policy consumer",
    description: "Hosts the phased migrate child.",
    repoPath: "/repos/busy-policy-consumer",
  });
  try {
    const phased = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "expand",
      objective: "Expand before the busy merge.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/busy-expand"],
      acceptanceCriteria: ["The expand child remains retryable."],
      phase: "expand",
      splitBy: "phase",
    }, {
      key: "migrate",
      objective: "Migrate after expand.",
      projectId: consumer.projectId,
      declaredScope: ["src/busy-migrate"],
      acceptanceCriteria: ["The migrate follows expand."],
      phase: "migrate",
      splitBy: "consumer",
      dependsOn: ["expand"],
    }, {
      key: "contract",
      objective: "Contract after migrate.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/busy-contract"],
      acceptanceCriteria: ["The contract follows deployment."],
      phase: "contract",
      splitBy: "phase",
      dependsOn: ["migrate"],
    }], "busy-policy", "blast_radius");
    const expand = phased.children[0];
    assert.ok(expand);
    busyBranch = expand.pipelineBranch!;
    verifiedByBranch.set(busyBranch, VERIFIED_SHAS[0]);
    forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);

    const unrelated = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "unrelated-one",
      objective: "Prepare an unrelated child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/unrelated-one"],
      acceptanceCriteria: ["The first unrelated child is ready."],
    }, {
      key: "unrelated-two",
      objective: "Prepare another unrelated child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/unrelated-two"],
      acceptanceCriteria: ["The second unrelated child is ready."],
    }], "unrelated-promotion");
    for (const [index, child] of unrelated.children.entries()) {
      verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[index]!);
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }

    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...arguments_: unknown[]) => { errors.push(arguments_); };
    try {
      fixture.board.reconcileWorkflows(fixture.project.projectId);
    } finally {
      console.error = originalError;
    }

    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "final_approval");
    assert.equal(fixture.board.requireWorkItem(unrelated.parent.workItemId).state, "final_approval");
    assert.ok(fixture.board.listNotifications().unread.some((notification) => (
      notification.kind === "parent_ready_for_approval"
      && notification.workItemId === unrelated.parent.workItemId
    )));
    assert.ok(errors.some((arguments_) => JSON.stringify(arguments_).includes(expand.workItemId)));
  } finally {
    fixture.board.close();
  }
});

test("project-scoped reconciliation leaves an unrelated ready parent untouched", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  const unrelatedProject = fixture.board.createProject({
    name: "Unrelated reconciliation project",
    description: "Owns a decomposition family outside the requested project.",
    repoPath: "/repos/unrelated-reconciliation",
  });
  try {
    const unrelated = proposeParent(fixture.board, unrelatedProject.projectId, [{
      key: "one",
      objective: "Prepare the first unrelated child.",
      projectId: unrelatedProject.projectId,
      declaredScope: ["src/unrelated-one"],
      acceptanceCriteria: ["The first child is ready."],
    }, {
      key: "two",
      objective: "Prepare the second unrelated child.",
      projectId: unrelatedProject.projectId,
      declaredScope: ["src/unrelated-two"],
      acceptanceCriteria: ["The second child is ready."],
    }], "project-scoped-unrelated");
    for (const [index, child] of unrelated.children.entries()) {
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }

    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(fixture.board.requireWorkItem(unrelated.parent.workItemId).state, "coordinating");

    fixture.board.reconcileWorkflows(unrelatedProject.projectId);
    assert.equal(fixture.board.requireWorkItem(unrelated.parent.workItemId).state, "final_approval");
  } finally {
    fixture.board.close();
  }
});

for (const failure of ["repo_busy", "conflict"] as const) {
  test(`a ${failure} automatic merge failure does not starve a parallel Migrate sibling`, async () => {
    const verifiedByBranch = new Map<string, string>();
    let failedBranch = "";
    const fixture = await boardFixture(undefined, undefined, {
      git(arguments_) {
        if (arguments_.includes("--abbrev-ref")) return "main\n";
        if (arguments_.includes("--porcelain")) return "";
        if (arguments_.includes("merge-base")) return "";
        const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
        if (verifiedRef !== undefined) {
          return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
        }
        return `${BASE_SHA}\n`;
      },
      mergePipeline(request) {
        if (request.branch === failedBranch) {
          return failure === "repo_busy"
            ? { kind: "repo_busy" }
            : { kind: "conflict", summary: "The first Migrate conflicts." };
        }
        return {
          kind: "merged",
          mergeSha: request.branch.endsWith("expand") ? MERGE_SHAS[0] : MERGE_SHAS[1],
        };
      },
    });
    const firstConsumer = fixture.board.createProject({
      name: `First ${failure} consumer`,
      description: "Hosts the failing Migrate child.",
      repoPath: `/repos/${failure}-first-consumer`,
    });
    const secondConsumer = fixture.board.createProject({
      name: `Second ${failure} consumer`,
      description: "Hosts the independent Migrate child.",
      repoPath: `/repos/${failure}-second-consumer`,
    });
    try {
      const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
        key: "expand",
        objective: "Expand before both migrations.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/expand"],
        acceptanceCriteria: ["The expansion merges."],
        phase: "expand",
        splitBy: "phase",
      }, {
        key: "migrate-one",
        objective: "Exercise the first migration failure.",
        projectId: firstConsumer.projectId,
        declaredScope: ["src/migrate-one"],
        acceptanceCriteria: ["The first migration remains retryable."],
        phase: "migrate",
        splitBy: "consumer",
        dependsOn: ["expand"],
      }, {
        key: "migrate-two",
        objective: "Merge independently of the first migration failure.",
        projectId: secondConsumer.projectId,
        declaredScope: ["src/migrate-two"],
        acceptanceCriteria: ["The second migration merges in the same pass."],
        phase: "migrate",
        splitBy: "consumer",
        dependsOn: ["expand"],
      }, {
        key: "contract",
        objective: "Contract after both migrations deploy.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/contract"],
        acceptanceCriteria: ["The contract remains downstream."],
        phase: "contract",
        splitBy: "phase",
        dependsOn: ["migrate-one", "migrate-two"],
      }], `parallel-migrate-${failure}`, "blast_radius");
      const [expand, firstMigrate, secondMigrate] = decomposition.children;
      assert.ok(expand);
      assert.ok(firstMigrate);
      assert.ok(secondMigrate);
      verifiedByBranch.set(expand.pipelineBranch!, VERIFIED_SHAS[0]);
      forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);
      fixture.board.reconcileWorkflows(fixture.project.projectId);
      assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "merged");

      failedBranch = firstMigrate.pipelineBranch!;
      verifiedByBranch.set(firstMigrate.pipelineBranch!, VERIFIED_SHAS[1]);
      verifiedByBranch.set(secondMigrate.pipelineBranch!, VERIFIED_SHAS[2]);
      forceFinalApproval(fixture.path, firstMigrate.workItemId, VERIFIED_SHAS[1]);
      forceFinalApproval(fixture.path, secondMigrate.workItemId, VERIFIED_SHAS[2]);
      const originalError = console.error;
      console.error = () => undefined;
      try {
        fixture.board.reconcileWorkflows(fixture.project.projectId);
      } finally {
        console.error = originalError;
      }

      assert.equal(
        fixture.board.requireWorkItem(firstMigrate.workItemId).state,
        failure === "repo_busy" ? "final_approval" : "implementing",
      );
      assert.equal(fixture.board.requireWorkItem(secondMigrate.workItemId).state, "merged");
    } finally {
      fixture.board.close();
    }
  });
}

test("a non-transient automatic merge failure reuses human conflict recovery and notifies", async () => {
  const verifiedByBranch = new Map<string, string>();
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      if (arguments_.includes("--abbrev-ref")) return "main\n";
      if (arguments_.includes("--porcelain")) return "";
      if (arguments_.includes("merge-base")) return "";
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline() {
      return { kind: "conflict", summary: "Automatic merge conflict in the Expand child." };
    },
  });
  const consumer = fixture.board.createProject({
    name: "Conflict policy consumer",
    description: "Hosts the conflict-policy migrate child.",
    repoPath: "/repos/conflict-policy-consumer",
  });
  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "expand",
      objective: "Exercise automatic merge conflict recovery.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/conflict-expand"],
      acceptanceCriteria: ["The child returns to implementation."],
      phase: "expand",
      splitBy: "phase",
    }, {
      key: "migrate",
      objective: "Wait for the recovered Expand child.",
      projectId: consumer.projectId,
      declaredScope: ["src/conflict-migrate"],
      acceptanceCriteria: ["The migrate stays downstream."],
      phase: "migrate",
      splitBy: "consumer",
      dependsOn: ["expand"],
    }, {
      key: "contract",
      objective: "Wait for deployment after migration.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/conflict-contract"],
      acceptanceCriteria: ["The contract stays downstream."],
      phase: "contract",
      splitBy: "phase",
      dependsOn: ["migrate"],
    }], "automatic-conflict", "blast_radius");
    const expand = decomposition.children[0];
    assert.ok(expand);
    verifiedByBranch.set(expand.pipelineBranch!, VERIFIED_SHAS[0]);
    forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);

    const originalError = console.error;
    console.error = () => undefined;
    try {
      fixture.board.reconcileWorkflows(fixture.project.projectId);
    } finally {
      console.error = originalError;
    }

    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "implementing");
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const handoff = inspected.prepare(`
        SELECT handoff.payload_json
        FROM stage_handoffs handoff
        JOIN work_nodes node ON node.node_id=handoff.node_id
        JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
        WHERE plan.work_item_id=? AND handoff.stage='implementation'
        ORDER BY handoff.created_at DESC,handoff.rowid DESC
        LIMIT 1
      `).get(expand.workItemId);
      assert.match(String(handoff?.payload_json), /Automatic merge conflict in the Expand child/u);
    } finally {
      inspected.close();
    }
    assert.ok(fixture.board.listNotifications().unread.some((notification) => (
      notification.kind === "final_approval_withdrawn"
      && notification.workItemId === expand.workItemId
    )));
  } finally {
    fixture.board.close();
  }
});

test("unphased parents promote with merged siblings and fan out only over unmerged children", async () => {
  const verifiedByBranch = new Map<string, string>();
  const mergeOrder: string[] = [];
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline(request) {
      mergeOrder.push(request.branch.slice("task/".length));
      return { kind: "merged", mergeSha: MERGE_SHAS[mergeOrder.length - 1]! };
    },
  });
  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "merged-first",
      objective: "Merge individually before sibling approval.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/merged-first"],
      acceptanceCriteria: ["The child merges individually."],
    }, {
      key: "remaining",
      objective: "Merge through parent fan-out.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/remaining"],
      acceptanceCriteria: ["The parent merges only this child."],
    }], "mixed-child-states");
    const [first, remaining] = decomposition.children;
    assert.ok(first);
    assert.ok(remaining);
    verifiedByBranch.set(first.pipelineBranch!, VERIFIED_SHAS[0]);
    const firstVersion = forceFinalApproval(fixture.path, first.workItemId, VERIFIED_SHAS[0]);
    await fixture.board.approvePipelineMerge(first.workItemId, { version: firstVersion });
    verifiedByBranch.set(remaining.pipelineBranch!, VERIFIED_SHAS[1]);
    forceFinalApproval(fixture.path, remaining.workItemId, VERIFIED_SHAS[1]);

    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const readyParent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(readyParent.state, "final_approval");
    const settled = await fixture.board.approvePipelineMerge(decomposition.parent.workItemId, {
      version: readyParent.version,
    });
    assert.equal(settled.state, "merged");
    assert.deepEqual(mergeOrder, [first.workItemId, remaining.workItemId]);
  } finally {
    fixture.board.close();
  }
});

test("parent fan-out reconciles an overlapping pipeline in every child project before returning", async () => {
  let now = new Date("2026-08-29T14:00:00.000Z");
  const verifiedByBranch = new Map<string, string>();
  const fixture = await boardFixture(undefined, () => now, {
    git(arguments_) {
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline: () => ({ kind: "merged", mergeSha: MERGE_SHAS[0] }),
  });
  try {
    const childProject = fixture.board.createProject({
      name: "Fan-out child project",
      description: "Owns the child scope and a pipeline waiting for its release.",
      repoPath: "/repos/fan-out-child",
    });
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "scope-holder",
      objective: "Hold the child project's shared scope through parent approval.",
      projectId: childProject.projectId,
      declaredScope: ["src/fan-out-shared"],
      acceptanceCriteria: ["The parent merge releases the remote project scope."],
    }], "fan-out-child-project-reconcile");
    const [child] = decomposition.children;
    assert.ok(child);
    now = new Date("2026-08-29T14:00:01.000Z");
    const held = proposeStandalonePipeline(
      fixture.board,
      childProject.projectId,
      ["src/fan-out-shared"],
      "fan-out-scope-waiter",
    );
    assert.equal(childNode(fixture.board, held).node.state, "blocked");

    verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[0]);
    forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[0]);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const parent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(parent.state, "final_approval");

    const settled = await fixture.board.approvePipelineMerge(parent.workItemId, { version: parent.version });

    assert.equal(settled.state, "merged");
    assert.equal(childNode(fixture.board, held).node.state, "active");
  } finally {
    fixture.board.close();
  }
});

test("parent fan-out resumes after a mid-way child merge conflict", async () => {
  const verifiedByBranch = new Map<string, string>();
  const mergeOrder: string[] = [];
  let conflicted = false;
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline(request) {
      const workItemId = request.branch.slice("task/".length);
      mergeOrder.push(workItemId);
      if (mergeOrder.length === 2 && !conflicted) {
        conflicted = true;
        return { kind: "conflict", summary: "Merge conflict in the second child." };
      }
      return { kind: "merged", mergeSha: mergeOrder.length === 1 ? MERGE_SHAS[0] : MERGE_SHAS[1] };
    },
  });
  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "one",
      objective: "Merge before the failing child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/resume-one"],
      acceptanceCriteria: ["The first merge remains landed."],
    }, {
      key: "two",
      objective: "Fail once, then merge on retry.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/resume-two"],
      acceptanceCriteria: ["The retry skips the merged sibling."],
      dependsOn: ["one"],
    }], "resumable-fan-out");
    const [one, two] = decomposition.children;
    assert.ok(one);
    assert.ok(two);
    for (const [index, child] of decomposition.children.entries()) {
      verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[index]!);
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const readyParent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(readyParent.state, "final_approval");

    await assert.rejects(
      fixture.board.approvePipelineMerge(decomposition.parent.workItemId, { version: readyParent.version }),
      (error: unknown) => error instanceof TaskBoardError && error.code === "PARENT_CHILD_MERGE_CONFLICT",
    );
    assert.equal(fixture.board.requireWorkItem(one.workItemId).state, "merged");
    assert.equal(fixture.board.requireWorkItem(two.workItemId).state, "implementing");
    const withdrawnParent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(withdrawnParent.state, "coordinating");
    assert.equal(withdrawnParent.version, readyParent.version + 1);

    forceFinalApproval(fixture.path, two.workItemId, VERIFIED_SHAS[1]);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const rePromotedParent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(rePromotedParent.state, "final_approval");
    assert.equal(rePromotedParent.version, withdrawnParent.version + 1);
    const settled = await fixture.board.approvePipelineMerge(decomposition.parent.workItemId, {
      version: rePromotedParent.version,
    });
    assert.equal(settled.state, "merged");
    assert.deepEqual(mergeOrder, [one.workItemId, two.workItemId, two.workItemId]);
  } finally {
    fixture.board.close();
  }
});

test("the last individually approved unphased child settles its parent directly", async () => {
  const verifiedByBranch = new Map<string, string>();
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline(request) {
      return {
        kind: "merged",
        mergeSha: request.branch.endsWith("-0") ? MERGE_SHAS[0] : MERGE_SHAS[1],
      };
    },
  });
  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "one",
      objective: "Merge first through its own approval.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/individual-one"],
      acceptanceCriteria: ["The first child merges."],
    }, {
      key: "two",
      objective: "Merge last through its own approval.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/individual-two"],
      acceptanceCriteria: ["The last child settles the parent."],
    }], "individual-last-settlement");
    const [one, two] = decomposition.children;
    assert.ok(one);
    assert.ok(two);
    for (const [index, child] of decomposition.children.entries()) {
      verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[index]!);
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "final_approval");
    await fixture.board.approvePipelineMerge(one.workItemId, {
      version: fixture.board.requireWorkItem(one.workItemId).version,
    });
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "final_approval");
    await fixture.board.approvePipelineMerge(two.workItemId, {
      version: fixture.board.requireWorkItem(two.workItemId).version,
    });
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "merged");
    assert.equal(
      gateActions(fixture.path, decomposition.parent.workItemId).at(-1)?.actorId,
      "system:parent-completion",
    );
    assert.deepEqual(latestTransitionActor(fixture.path, decomposition.parent.workItemId), {
      actorType: "system",
      actorId: "system:parent-completion",
    });
  } finally {
    fixture.board.close();
  }
});

test("an unphased blast-radius parent uses the one-parent-approval policy", async () => {
  const verifiedByBranch = new Map<string, string>();
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline() {
      return { kind: "merged", mergeSha: MERGE_SHAS[0] };
    },
  });
  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "consumer-split",
      objective: "Ship an unphased blast-radius child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/consumer-split"],
      acceptanceCriteria: ["The parent provides one approval."],
      splitBy: "consumer",
    }], "unphased-blast-radius", "blast_radius");
    const child = decomposition.children[0];
    assert.ok(child);
    verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[0]);
    forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[0]);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const readyParent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(readyParent.state, "final_approval");
    const settled = await fixture.board.approvePipelineMerge(decomposition.parent.workItemId, {
      version: readyParent.version,
    });
    assert.equal(settled.state, "merged");
    assert.equal(gateActions(fixture.path, decomposition.parent.workItemId).at(-1)?.note, "1 children merged, 0 abandoned");
  } finally {
    fixture.board.close();
  }
});

test("phased children auto-merge under parent authorization and Contract waits for deploy attestations", async () => {
  const verifiedByBranch = new Map<string, string>();
  const mergeOrder: string[] = [];
  let providerHead = BASE_SHA;
  let expandBranch = "";
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      if (arguments_.includes("--abbrev-ref")) return "main\n";
      if (arguments_.includes("--porcelain")) return "";
      if (arguments_.includes("merge-base")) return "";
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      const repositoryIndex = arguments_.indexOf("-C");
      const repository = repositoryIndex < 0 ? null : arguments_[repositoryIndex + 1];
      return `${repository === "/repos/runtime-consumer" ? CONSUMER_BASE_SHA : providerHead}\n`;
    },
    mergePipeline(request) {
      mergeOrder.push(request.branch.slice("task/".length));
      if (request.branch === expandBranch) providerHead = ADVANCED_SHA;
      return { kind: "merged", mergeSha: MERGE_SHAS[mergeOrder.length - 1]! };
    },
  });
  const provider = fixture.board.createProject({
    name: "Runtime provider",
    description: "Owns the expanded and contracted interface.",
    repoPath: "/repos/runtime-provider",
  });
  const consumer = fixture.board.createProject({
    name: "Runtime consumer",
    description: "Consumes the expanded interface.",
    repoPath: "/repos/runtime-consumer",
  });
  const declared: readonly DeclaredChild[] = [{
    key: "expand",
    objective: "Expand the provider interface.",
    projectId: provider.projectId,
    declaredScope: ["docs/interface.md"],
    acceptanceCriteria: ["The additive interface is published."],
    phase: "expand",
    splitBy: "phase",
  }, {
    key: "migrate",
    objective: "Migrate the consumer.",
    projectId: consumer.projectId,
    declaredScope: ["src/client"],
    acceptanceCriteria: ["The consumer uses the additive interface."],
    phase: "migrate",
    dependsOn: ["expand"],
    splitBy: "consumer",
  }, {
    key: "contract",
    objective: "Contract the provider interface.",
    projectId: provider.projectId,
    declaredScope: ["docs/interface.md"],
    acceptanceCriteria: ["The legacy interface is removed."],
    phase: "contract",
    dependsOn: ["migrate"],
    splitBy: "phase",
  }];

  const originalInfo = console.info;
  const infoLines: unknown[][] = [];
  console.info = (...arguments_: unknown[]) => { infoLines.push(arguments_); };
  try {
    const { parent, revision, children } = proposeParent(
      fixture.board,
      provider.projectId,
      declared,
      "phased-policy",
      "blast_radius",
    );
    const [expand, migrate, contract] = children;
    assert.ok(expand);
    assert.ok(migrate);
    assert.ok(contract);
    expandBranch = expand.pipelineBranch!;
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).baseSha, BASE_SHA);
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).baseSha, CONSUMER_BASE_SHA);
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).baseSha, BASE_SHA);
    const parentPlanConfirm = gateActions(fixture.path, parent.workItemId).find(
      (action) => action.gate === "plan_confirm",
    );
    assert.ok(parentPlanConfirm);

    verifiedByBranch.set(expand.pipelineBranch!, VERIFIED_SHAS[0]);
    forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);
    fixture.board.reconcileWorkflows(provider.projectId);
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "merged");
    assert.equal(providerHead, ADVANCED_SHA);
    const expandApproval = gateActions(fixture.path, expand.workItemId).at(-1);
    assert.equal(expandApproval?.gate, "final_approve");
    assert.equal(expandApproval?.actorId, "system:parent-plan-authorization");
    assert.equal(expandApproval?.refId, parentPlanConfirm.gateActionId);
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "implementing");
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).baseSha, CONSUMER_BASE_SHA);

    verifiedByBranch.set(migrate.pipelineBranch!, VERIFIED_SHAS[1]);
    forceFinalApproval(fixture.path, migrate.workItemId, VERIFIED_SHAS[1]);
    fixture.board.reconcileWorkflows(consumer.projectId);
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "merged");
    const migrateApproval = gateActions(fixture.path, migrate.workItemId).at(-1);
    assert.equal(migrateApproval?.actorId, "system:parent-plan-authorization");
    assert.equal(migrateApproval?.refId, parentPlanConfirm.gateActionId);
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "queued");
    assert.equal(
      latestNodeBlock(fixture.path, childNode(fixture.board, contract).node.nodeId),
      `waits for ${expand.workItemId} (expand) deploy attestation`,
    );

    assert.throws(
      () => fixture.board.attestDeploy(contract.workItemId, { note: "Not merged yet." }),
      (error: unknown) => error instanceof TaskBoardError && error.code === "WORK_ITEM_NOT_MERGED",
    );
    const migrateAttestation = fixture.board.attestDeploy(migrate.workItemId, { note: "Consumer deployed first." });
    assert.equal(migrateAttestation.duplicate, false);
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "queued");
    assert.equal(
      latestNodeBlock(fixture.path, childNode(fixture.board, contract).node.nodeId),
      `waits for ${expand.workItemId} (expand) deploy attestation`,
    );

    const firstAttestation = fixture.board.attestDeploy(expand.workItemId, { note: "Provider deployed." });
    const duplicateAttestation = fixture.board.attestDeploy(expand.workItemId, { note: "Ignored duplicate." });
    assert.equal(firstAttestation.duplicate, false);
    assert.equal(duplicateAttestation.duplicate, true);
    assert.equal(duplicateAttestation.gateAction.gateActionId, firstAttestation.gateAction.gateActionId);
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "implementing");
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).baseSha, ADVANCED_SHA);
    const contractBaseRefresh = infoLines.find((arguments_) => (
      arguments_[0] === "[task-board] phased child base refreshed"
      && typeof arguments_[1] === "object"
      && arguments_[1] !== null
      && (arguments_[1] as { workItemId?: unknown }).workItemId === contract.workItemId
    ));
    assert.deepEqual(contractBaseRefresh?.[1], {
      workItemId: contract.workItemId,
      projectId: provider.projectId,
      previousBaseSha: BASE_SHA,
      baseSha: ADVANCED_SHA,
    });
    assert.deepEqual(
      (fixture.board.listChildren(parent.workItemId) as readonly ChildWorkItem[]).map((child) => child.deployAttested),
      [true, true, false],
    );
    const phaseReady = fixture.board.listNotifications().unread.find(
      (notification) => notification.kind === "phase_ready",
    );
    assert.equal(phaseReady?.dedupeKey, `phase_ready:${parent.workItemId}:${contract.workItemId}`);
    assert.equal(fixture.board.listNotifications().unread.filter(
      (notification) => notification.kind === "phase_ready",
    ).length, 1);

    verifiedByBranch.set(contract.pipelineBranch!, VERIFIED_SHAS[2]);
    const contractVersion = forceFinalApproval(fixture.path, contract.workItemId, VERIFIED_SHAS[2]);
    const mergedContract = await fixture.board.approvePipelineMerge(contract.workItemId, {
      version: contractVersion,
    });
    assert.equal(mergedContract.state, "merged");
    assert.deepEqual(mergeOrder, [expand.workItemId, migrate.workItemId, contract.workItemId]);
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "merged");
    const parentCompletion = gateActions(fixture.path, parent.workItemId).at(-1);
    assert.equal(parentCompletion?.gate, "final_approve");
    assert.equal(parentCompletion?.actorId, "system:parent-plan-authorization");
    assert.equal(parentCompletion?.planRevisionId, revision.planRevisionId);
    assert.deepEqual(latestTransitionActor(fixture.path, parent.workItemId), {
      actorType: "system",
      actorId: "system:parent-plan-authorization",
    });
  } finally {
    console.info = originalInfo;
    fixture.board.close();
  }
});

test("a duplicate deploy attestation retries Contract readiness reconciliation", async () => {
  let failNextContractRefresh = false;
  const fixture = await boardFixture(undefined, undefined, {
    git() {
      if (failNextContractRefresh) {
        failNextContractRefresh = false;
        throw new Error("injected Contract base refresh failure");
      }
      return `${BASE_SHA}\n`;
    },
  });
  const consumer = fixture.board.createProject({
    name: "Attestation retry consumer",
    description: "Owns the migrate phase for duplicate attestation recovery.",
    repoPath: "/repos/attestation-retry-consumer",
  });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      phasedChildren(fixture.project.projectId, consumer.projectId, "duplicate-attestation"),
      "duplicate-attestation-reconcile",
      "blast_radius",
    );
    const [expand, migrate, contract] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    assert.ok(contract);
    forceMergedWithApproval(fixture.path, expand.workItemId, MERGE_SHAS[0]);
    forceMergedWithApproval(fixture.path, migrate.workItemId, MERGE_SHAS[1]);
    fixture.board.attestDeploy(migrate.workItemId, { note: "Consumer deployed." });

    failNextContractRefresh = true;
    const first = fixture.board.attestDeploy(expand.workItemId, { note: "Provider deployed." });
    assert.equal(first.duplicate, false);
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "queued");

    const duplicate = fixture.board.attestDeploy(expand.workItemId, { note: "Retry readiness." });

    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.gateAction.gateActionId, first.gateAction.gateActionId);
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "implementing");
    assert.equal(childNode(fixture.board, contract).node.state, "active");
  } finally {
    fixture.board.close();
  }
});

test("phased automatic merge withdraws an approval when the provider base advances and merges after re-verification", async () => {
  const verifiedByBranch = new Map<string, string>();
  let providerHead = BASE_SHA;
  let mergeCalls = 0;
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      if (arguments_.includes("--abbrev-ref")) return "main\n";
      if (arguments_.includes("--porcelain")) return "";
      if (arguments_.includes("merge-base")) return "";
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      if (arguments_.includes("rev-parse") && arguments_.at(-1) === "HEAD") return `${providerHead}\n`;
      throw new Error(`unexpected git command: ${arguments_.join(" ")}`);
    },
    mergePipeline() {
      mergeCalls += 1;
      return { kind: "merged", mergeSha: MERGE_SHAS[0] };
    },
  });
  const consumer = fixture.board.createProject({
    name: "Base-advance consumer",
    description: "Waits behind the re-verified Expand child.",
    repoPath: "/repos/base-advance-consumer",
  });
  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "expand",
      objective: "Expand the provider before its base advances.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/base-advance-expand"],
      acceptanceCriteria: ["Stale verification never merges."],
      phase: "expand",
      splitBy: "phase",
    }, {
      key: "migrate",
      objective: "Wait for the re-verified expansion.",
      projectId: consumer.projectId,
      declaredScope: ["src/base-advance-migrate"],
      acceptanceCriteria: ["Migration starts only after expansion merges."],
      phase: "migrate",
      splitBy: "consumer",
      dependsOn: ["expand"],
    }, {
      key: "contract",
      objective: "Remain downstream of migration deployment.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/base-advance-contract"],
      acceptanceCriteria: ["Contraction remains gated."],
      phase: "contract",
      splitBy: "phase",
      dependsOn: ["migrate"],
    }], "phased-base-advance", "blast_radius");
    const [expand] = decomposition.children;
    assert.ok(expand);
    verifiedByBranch.set(expand.pipelineBranch!, VERIFIED_SHAS[0]);
    forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);
    providerHead = ADVANCED_SHA;

    fixture.board.reconcileWorkflows(fixture.project.projectId);

    const withdrawn = fixture.board.requireWorkItem(expand.workItemId);
    assert.equal(withdrawn.state, "implementing");
    assert.equal(withdrawn.baseSha, ADVANCED_SHA);
    assert.equal(mergeCalls, 0);
    assert.ok(fixture.board.listNotifications().unread.some((notification) => (
      notification.kind === "final_approval_withdrawn"
      && notification.workItemId === expand.workItemId
      && notification.dedupeKey === `final_approval_withdrawn:${expand.workItemId}:${ADVANCED_SHA}`
    )));

    verifiedByBranch.set(expand.pipelineBranch!, VERIFIED_SHAS[1]);
    forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[1]);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "merged");
    assert.equal(mergeCalls, 1);
  } finally {
    fixture.board.close();
  }
});

for (const inspection of ["diverged", "repo_busy"] as const) {
  test(`phased automatic merge handles a ${inspection} base inspection without calling merge`, async (t) => {
    let inspectionMode: "unchanged" | typeof inspection = "unchanged";
    let mergeCalls = 0;
    const fixture = await boardFixture(undefined, undefined, {
      git(arguments_) {
        if (arguments_.includes("--abbrev-ref")) {
          return inspectionMode === "repo_busy" ? "HEAD\n" : "main\n";
        }
        if (arguments_.includes("--porcelain")) return "";
        if (arguments_.includes("merge-base")) {
          if (inspectionMode === "diverged") {
            throw Object.assign(new Error("not an ancestor"), { status: 1 });
          }
          return "";
        }
        const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
        if (verifiedRef !== undefined) return `${VERIFIED_SHAS[0]}\n`;
        if (arguments_.includes("rev-parse") && arguments_.at(-1) === "HEAD") {
          return `${inspectionMode === "diverged" ? ADVANCED_SHA : BASE_SHA}\n`;
        }
        throw new Error(`unexpected git command: ${arguments_.join(" ")}`);
      },
      mergePipeline() {
        mergeCalls += 1;
        return { kind: "merged", mergeSha: MERGE_SHAS[0] };
      },
    });
    const logged = t.mock.method(console, "info", () => undefined);
    try {
      const consumer = fixture.board.createProject({
        name: `${inspection} guard consumer`,
        description: `Hosts the ${inspection} guard migration.`,
        repoPath: `/repos/${inspection}-guard-consumer`,
      });
      const decomposition = proposeParent(
        fixture.board,
        fixture.project.projectId,
        phasedChildren(fixture.project.projectId, consumer.projectId, `${inspection}-guard`),
        `phased-${inspection}-guard`,
        "blast_radius",
      );
      const [expand] = decomposition.children;
      assert.ok(expand);
      forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);
      inspectionMode = inspection;

      fixture.board.reconcileWorkflows(fixture.project.projectId);

      assert.equal(mergeCalls, 0);
      if (inspection === "diverged") {
        assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "parked");
        assert.deepEqual(latestParkRecord(fixture.path, expand.workItemId), {
          category: "base_diverged",
          reason: `base branch history rewritten (was ${BASE_SHA}, now ${ADVANCED_SHA})`,
        });
        assert.ok(fixture.board.listNotifications().unread.some((notification) => (
          notification.kind === "final_approval_withdrawn"
          && notification.workItemId === expand.workItemId
          && notification.dedupeKey === `final_approval_withdrawn:${expand.workItemId}:base-diverged:${ADVANCED_SHA}`
        )));
      } else {
        assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "final_approval");
        assert.ok(logged.mock.calls.some((call) => (
          call.arguments[0] === "[task-board] phased automatic merge skipped"
          && typeof call.arguments[1] === "object"
          && call.arguments[1] !== null
          && (call.arguments[1] as { childWorkItemId?: unknown }).childWorkItemId === expand.workItemId
        )));
      }
    } finally {
      fixture.board.close();
    }
  });
}

test("board pause skips the whole decomposition policy pass until work resumes", async (t) => {
  let mergeCalls = 0;
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      if (arguments_.includes("--abbrev-ref")) return "main\n";
      if (arguments_.includes("--porcelain")) return "";
      if (arguments_.some((argument) => argument.endsWith("^{commit}"))) return `${VERIFIED_SHAS[0]}\n`;
      if (arguments_.includes("rev-parse")) return `${BASE_SHA}\n`;
      throw new Error(`unexpected git command: ${arguments_.join(" ")}`);
    },
    mergePipeline() {
      mergeCalls += 1;
      return { kind: "merged", mergeSha: MERGE_SHAS[0] };
    },
  });
  try {
    const consumer = fixture.board.createProject({
      name: "Paused policy consumer",
      description: "Hosts migration work held behind the board pause.",
      repoPath: "/repos/paused-policy-consumer",
    });
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      phasedChildren(fixture.project.projectId, consumer.projectId, "paused-policy"),
      "paused-policy",
      "blast_radius",
    );
    const [expand] = decomposition.children;
    assert.ok(expand);
    forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);
    const initialPause = fixture.board.getBoardPause();
    fixture.board.setBoardPause({
      paused: true,
      reason: "Hold all automatic decomposition policy actions.",
      version: initialPause.version,
      actor: "human:alice",
    });
    const logged = t.mock.method(console, "info", () => undefined);

    fixture.board.reconcileWorkflows(fixture.project.projectId);

    assert.equal(mergeCalls, 0);
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "final_approval");
    assert.equal(logged.mock.callCount(), 1);
    assert.equal(logged.mock.calls[0]?.arguments[0], "[task-board] decomposition policy reconciliation skipped");
    assert.deepEqual(logged.mock.calls[0]?.arguments[1], {
      reason: "board_paused",
      projectId: fixture.project.projectId,
    });

    const paused = fixture.board.getBoardPause();
    fixture.board.setBoardPause({
      paused: false,
      reason: null,
      version: paused.version,
      actor: "human:alice",
    });
    fixture.board.resumePausedWork();
    assert.equal(mergeCalls, 1);
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "merged");
  } finally {
    fixture.board.close();
  }
});

test("decomposition reconciliation fails closed when the board pause row is missing", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    proposeParent(fixture.board, fixture.project.projectId, [{
      key: "pause-row-guard",
      objective: "Keep policy work behind the durable pause row.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/pause-row-guard"],
      acceptanceCriteria: ["A missing pause row fails closed."],
    }], "missing-pause-row");
    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare("DELETE FROM board_pause WHERE pause_id='board'").run();
    } finally {
      db.close();
    }

    assert.throws(
      () => fixture.board.reconcileWorkflows(fixture.project.projectId),
      /TASK_BOARD_DATABASE_CORRUPT:board_pause/u,
    );
  } finally {
    fixture.board.close();
  }
});

test("base-branch withdrawal also withdraws a feature parent's pending approval", async () => {
  let targetHead = BASE_SHA;
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      if (arguments_.includes("--abbrev-ref")) return "main\n";
      if (arguments_.includes("--porcelain")) return "";
      if (arguments_.includes("--is-ancestor")) return "";
      if (arguments_.includes("HEAD") || arguments_.includes("--verify")) return `${targetHead}\n`;
      return `${targetHead}\n`;
    },
  });
  try {
    const { parent, children } = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "one",
      objective: "Prepare the first child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/withdraw-one"],
      acceptanceCriteria: ["The first child is ready."],
    }, {
      key: "two",
      objective: "Prepare the second child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/withdraw-two"],
      acceptanceCriteria: ["The second child is ready."],
    }], "withdraw-parent");
    for (const [index, child] of children.entries()) {
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "final_approval");
    targetHead = ADVANCED_SHA;
    const sweep = fixture.board.sweepBaseBranch(NOW);
    assert.equal(sweep.withdrawn, 2);
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "coordinating");
    assert.ok(fixture.board.listNotifications().unread.some((notification) => (
      notification.kind === "final_approval_withdrawn"
      && notification.workItemId === parent.workItemId
      && notification.dedupeKey?.startsWith(`final_approval_withdrawn:${parent.workItemId}:`) === true
    )));
  } finally {
    fixture.board.close();
  }
});

test("an abandoned or dead-lettered child parks its parent as child_failed", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  const first = proposeParent(fixture.board, fixture.project.projectId, [{
    key: "abandoned",
    objective: "Exercise abandoned-child propagation.",
    projectId: fixture.project.projectId,
    declaredScope: ["src/abandoned"],
    acceptanceCriteria: ["The parent is parked."],
  }], "abandoned-child");
  const [abandonedChild] = first.children;
  assert.ok(abandonedChild);
  try {
    fixture.board.updateWorkItem(abandonedChild.workItemId, {
      action: "cancel",
      version: fixture.board.requireWorkItem(abandonedChild.workItemId).version,
      reason: "The child cannot proceed.",
    });
    assert.equal(fixture.board.requireWorkItem(first.parent.workItemId).state, "parked");
    assert.deepEqual(latestParkRecord(fixture.path, first.parent.workItemId), {
      category: "child_failed",
      reason: `Child ${abandonedChild.workItemId} was abandoned`,
    });

    const second = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "dead-lettered",
      objective: "Exercise dead-letter propagation.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/dead-lettered"],
      acceptanceCriteria: ["The second parent is parked."],
    }], "dead-letter-child");
    const [deadChild] = second.children;
    assert.ok(deadChild);
    fixture.board.close();
    const store = await TaskBoardStore.open(fixture.path);
    new TaskBoardRuntime(config(fixture.path), store);
    try {
      store.transaction(() => {
        transitionWorkItemInTransaction(store, {
          workItemId: deadChild.workItemId,
          to: "dead_letter",
          actorType: "system",
          actorId: "system:test",
          now: NOW,
          endedAt: NOW,
          currentStage: null,
        });
      });
      const parent = store.db.prepare("SELECT state FROM work_items WHERE work_item_id=?")
        .get(second.parent.workItemId);
      assert.equal(parent?.state, "parked");
      const park = store.db.prepare(`
        SELECT category,reason
        FROM park_records
        WHERE work_item_id=?
        ORDER BY rowid DESC
        LIMIT 1
      `).get(second.parent.workItemId);
      assert.equal(park?.category, "child_failed");
      assert.equal(park?.reason, `Child ${deadChild.workItemId} was dead-lettered`);
    } finally {
      store.close();
    }
  } finally {
    try {
      fixture.board.close();
    } catch {
      // The dead-letter branch closes the board before opening the store directly.
    }
  }
});

test("resuming a child-failure park abandons the dead-lettered child and completes through the remaining child", async () => {
  const fixture = await boardFixture(undefined, undefined, {
    git: () => `${VERIFIED_SHAS[0]}\n`,
    mergePipeline: () => ({ kind: "merged", mergeSha: MERGE_SHAS[0] }),
  });
  const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
    key: "failed",
    objective: "Dead-letter this child to park the parent.",
    projectId: fixture.project.projectId,
    declaredScope: ["src/unpark-failed"],
    acceptanceCriteria: ["The failure parks the parent."],
  }, {
    key: "remaining",
    objective: "Continue after the parent is unparked.",
    projectId: fixture.project.projectId,
    declaredScope: ["src/unpark-remaining"],
    acceptanceCriteria: ["This child can still merge."],
  }], "child-failure-unpark");
  const [failed, remaining] = decomposition.children;
  assert.ok(failed);
  assert.ok(remaining);
  try {
    const store = await TaskBoardStore.open(fixture.path);
    new TaskBoardRuntime(config(fixture.path), store);
    try {
      store.transaction(() => {
        transitionWorkItemInTransaction(store, {
          workItemId: failed.workItemId,
          to: "dead_letter",
          actorType: "system",
          actorId: "system:test-dead-letter",
          now: NOW,
          endedAt: NOW,
          currentStage: null,
        });
      });
    } finally {
      store.close();
    }
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "parked");
    assert.throws(
      () => fixture.board.resumeWorkItem(remaining.workItemId),
      (error: unknown) => error instanceof TaskBoardError && error.status === 409,
    );

    const resumed = fixture.board.resumeWorkItem(decomposition.parent.workItemId);
    assert.equal(resumed.state, "coordinating");
    assert.deepEqual(latestTransitionActor(fixture.path, decomposition.parent.workItemId), {
      actorType: "human",
      actorId: "human:alice",
    });
    assert.equal(fixture.board.requireWorkItem(remaining.workItemId).state, "implementing");
    forceFinalApproval(fixture.path, remaining.workItemId, VERIFIED_SHAS[0]);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const promoted = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(promoted.state, "final_approval");

    const merged = await fixture.board.approvePipelineMerge(promoted.workItemId, { version: promoted.version });

    assert.equal(merged.state, "merged");
    assert.equal(fixture.board.requireWorkItem(failed.workItemId).state, "dead_letter");
    assert.equal(fixture.board.requireWorkItem(remaining.workItemId).state, "merged");
    const completion = gateActions(fixture.path, decomposition.parent.workItemId).at(-1);
    assert.equal(completion?.gate, "final_approve");
    assert.equal(completion?.note, "1 children merged, 1 abandoned");
  } finally {
    fixture.board.close();
  }
});

test("a phased Contract stays blocked by an abandoned Migrate until the parent is cancelled", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const consumer = fixture.board.createProject({
      name: "Abandoned migration consumer",
      description: "Owns the migration that makes Contract unsafe when abandoned.",
      repoPath: "/repos/abandoned-migration-consumer",
    });
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      phasedChildren(fixture.project.projectId, consumer.projectId, "abandoned-migrate"),
      "phased-abandoned-migrate",
      "blast_radius",
    );
    const [expand, migrate, contract] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    assert.ok(contract);
    forceMergedWithApproval(fixture.path, expand.workItemId, MERGE_SHAS[0]);
    fixture.board.attestDeploy(expand.workItemId, { note: "The expansion is deployed." });

    fixture.board.updateWorkItem(migrate.workItemId, {
      action: "cancel",
      version: fixture.board.requireWorkItem(migrate.workItemId).version,
      reason: "The migration is unsafe to continue.",
    });

    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "parked");
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "queued");
    assert.equal(childNode(fixture.board, contract).node.state, "blocked");
    assert.equal(
      latestNodeBlock(fixture.path, childNode(fixture.board, contract).node.nodeId),
      `blocked: ${migrate.workItemId} (migrate) abandoned`,
    );

    const resumed = fixture.board.resumeWorkItem(decomposition.parent.workItemId);

    assert.equal(resumed.state, "coordinating");
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "queued");
    assert.equal(childNode(fixture.board, contract).node.state, "blocked");
    assert.equal(
      latestNodeBlock(fixture.path, childNode(fixture.board, contract).node.nodeId),
      `blocked: ${migrate.workItemId} (migrate) abandoned`,
    );

    const cancelled = fixture.board.updateWorkItem(decomposition.parent.workItemId, {
      action: "cancel",
      version: resumed.version,
      reason: "Cancel the unsafe phased family.",
    });

    assert.equal(cancelled.state, "abandoned");
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "merged");
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "abandoned");
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "abandoned");
  } finally {
    fixture.board.close();
  }
});

test("resuming an unphased parent with only abandoned children completes it", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "first",
      objective: "Abandon the first unphased child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/all-abandoned-first"],
      acceptanceCriteria: ["The parent records this abandoned child."],
    }, {
      key: "second",
      objective: "Abandon the second unphased child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/all-abandoned-second"],
      acceptanceCriteria: ["The parent records this abandoned child."],
    }], "all-children-abandoned");
    for (const child of decomposition.children) {
      fixture.board.updateWorkItem(child.workItemId, {
        action: "cancel",
        version: fixture.board.requireWorkItem(child.workItemId).version,
        reason: `Abandon ${child.workItemId}.`,
      });
    }
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "parked");

    const resumed = fixture.board.resumeWorkItem(decomposition.parent.workItemId);

    assert.equal(resumed.state, "merged");
    assert.equal(
      gateActions(fixture.path, decomposition.parent.workItemId).at(-1)?.note,
      "0 children merged, 2 abandoned",
    );
  } finally {
    fixture.board.close();
  }
});

test("resuming a parked parent activates a newly ready phased child in the same call", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const consumer = fixture.board.createProject({
      name: "Resume reconciliation consumer",
      description: "Hosts the child that becomes ready while its parent is parked.",
      repoPath: "/repos/resume-reconciliation-consumer",
    });
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "expand",
      objective: "Merge before the parked family resumes.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/resume-expand"],
      acceptanceCriteria: ["The expansion satisfies migration readiness."],
      phase: "expand",
      splitBy: "phase",
    }, {
      key: "migrate",
      objective: "Activate in the resume call once Expand is merged.",
      projectId: consumer.projectId,
      declaredScope: ["src/resume-migrate"],
      acceptanceCriteria: ["Resume reconciliation activates migration."],
      phase: "migrate",
      splitBy: "consumer",
      dependsOn: ["expand"],
    }, {
      key: "contract",
      objective: "Provide a terminal child that parks the parent before resume.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/resume-contract"],
      acceptanceCriteria: ["The parent can be resumed after this child fails."],
      phase: "contract",
      splitBy: "phase",
      dependsOn: ["migrate"],
    }], "resume-reconciles-ready-child", "blast_radius");
    const [expand, migrate, contract] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    assert.ok(contract);
    fixture.board.updateWorkItem(contract.workItemId, {
      action: "cancel",
      version: fixture.board.requireWorkItem(contract.workItemId).version,
      reason: "Park the family while Expand finishes externally.",
    });
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "parked");
    forceMergedWithApproval(fixture.path, expand.workItemId, MERGE_SHAS[0]);
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "queued");

    const resumed = fixture.board.resumeWorkItem(decomposition.parent.workItemId);

    assert.equal(resumed.state, "coordinating");
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "implementing");
    assert.equal(childNode(fixture.board, migrate).node.state, "active");
  } finally {
    fixture.board.close();
  }
});

test("cancelling a coordinating parent abandons active children and leaves merged siblings untouched", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "active",
      objective: "Run until the coordinating parent is cancelled.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/cascade-active"],
      acceptanceCriteria: ["Parent cancellation terminates this run."],
    }, {
      key: "merged",
      objective: "Remain merged when the parent is cancelled.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/cascade-merged"],
      acceptanceCriteria: ["Merged children are immutable."],
    }], "cancel-parent-cascade");
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "cancel-parent-cascade-active-run",
      messageCursor: null,
    });
    assert.ok(claim?.task);
    const activeChildId = claim.context.workflow?.workspaceKey;
    assert.ok(activeChildId);
    const mergedChild = decomposition.children.find((child) => child.workItemId !== activeChildId);
    assert.ok(mergedChild);
    forceMergedWithApproval(fixture.path, mergedChild.workItemId, MERGE_SHAS[0]);
    const mergedActionsBefore = gateActions(fixture.path, mergedChild.workItemId);
    const parent = fixture.board.requireWorkItem(decomposition.parent.workItemId);

    const cancelled = fixture.board.updateWorkItem(parent.workItemId, {
      action: "cancel",
      version: parent.version,
      reason: "Stop the decomposed family.",
    });

    assert.equal(cancelled.state, "abandoned");
    const activeChild = fixture.board.requireWorkItem(activeChildId);
    assert.equal(activeChild.state, "abandoned");
    assert.equal(activeChild.endedAt, cancelled.endedAt);
    assert.equal(fixture.board.requireTask(claim.task.taskId).status, "cancelled");
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const run = db.prepare("SELECT status,ended_at FROM runs WHERE run_id=?").get(claim.run.runId);
      assert.equal(run?.status, "interrupted");
      assert.equal(run?.ended_at, cancelled.endedAt);
    } finally {
      db.close();
    }
    const childCancel = gateActions(fixture.path, activeChildId).at(-1);
    assert.equal(childCancel?.gate, "cancel");
    assert.equal(childCancel?.refId, parent.workItemId);
    assert.equal(childCancel?.note, `parent ${parent.workItemId} abandoned`);
    const cascadeNotifications = fixture.board.listNotifications().unread.filter((notification) => (
      notification.kind === "park_auto_abandoned"
      && notification.workItemId === activeChildId
      && notification.dedupeKey === `park_auto_abandoned:${activeChildId}:${parent.workItemId}`
    ));
    assert.equal(cascadeNotifications.length, 1);
    assert.equal(fixture.board.requireWorkItem(mergedChild.workItemId).state, "merged");
    assert.deepEqual(gateActions(fixture.path, mergedChild.workItemId), mergedActionsBefore);
  } finally {
    fixture.board.close();
  }
});

test("a parent termination cascade reconciles overlapping pipelines in every child project", async () => {
  let now = new Date("2026-08-29T14:00:00.000Z");
  const fixture = await boardFixture(undefined, () => now, { git: () => `${BASE_SHA}\n` });
  try {
    const childProject = fixture.board.createProject({
      name: "Cascade child project",
      description: "Owns a child scope released by parent termination.",
      repoPath: "/repos/cascade-child",
    });
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "cascade-holder",
      objective: "Hold remote scope until the parent terminates.",
      projectId: childProject.projectId,
      declaredScope: ["src/cascade-shared"],
      acceptanceCriteria: ["Termination releases the remote scope immediately."],
    }], "cascade-child-project-reconcile");
    const [child] = decomposition.children;
    assert.ok(child);
    now = new Date("2026-08-29T14:00:01.000Z");
    const held = proposeStandalonePipeline(
      fixture.board,
      childProject.projectId,
      ["src/cascade-shared"],
      "cascade-scope-waiter",
    );
    assert.equal(childNode(fixture.board, held).node.state, "blocked");

    const parent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    const cancelled = fixture.board.updateWorkItem(parent.workItemId, {
      action: "cancel",
      version: parent.version,
      reason: "Release every cascaded child project.",
    });

    assert.equal(cancelled.state, "abandoned");
    assert.equal(fixture.board.requireWorkItem(child.workItemId).state, "abandoned");
    assert.equal(fixture.board.requireWorkItem(held.workItemId).state, "implementing");
    assert.equal(childNode(fixture.board, held).node.state, "active");
  } finally {
    fixture.board.close();
  }
});

test("parent cancellation retires a child's running machine verification before late settlement", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "machine-verify-child",
      objective: "Remain in machine verification until the parent is cancelled.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/machine-verify-child"],
      acceptanceCriteria: ["Late machine settlement cannot write durable output."],
    }], "cancel-machine-verification");
    const [child] = decomposition.children;
    assert.ok(child);
    const node = childNode(fixture.board, child).node;
    const verifyAttemptId = `verify-cancel-${child.workItemId}`;
    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare(`
        UPDATE work_items
        SET state='verifying',current_stage='testing',version=version+1,updated_at=?
        WHERE work_item_id=?
      `).run(NOW, child.workItemId);
      db.prepare(`
        UPDATE work_nodes
        SET state='active',current_stage='testing',version=version+1,updated_at=?
        WHERE node_id=?
      `).run(NOW, node.nodeId);
      db.prepare(`
        INSERT INTO verify_attempts(
          verify_attempt_id,node_id,stage,attempt,verify_run_id,workspace_path,state,
          check_results_json,detail,created_at,ended_at
        ) VALUES(?,?,'testing',1,'late-verify-run','/tmp/late-verify-workspace','running',NULL,NULL,?,NULL)
      `).run(verifyAttemptId, node.nodeId, NOW);
    } finally {
      db.close();
    }
    const parent = fixture.board.requireWorkItem(decomposition.parent.workItemId);

    fixture.board.updateWorkItem(parent.workItemId, {
      action: "cancel",
      version: parent.version,
      reason: "Cancel while the child verifier is still running.",
    });

    const retired = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const attempt = retired.prepare("SELECT state,ended_at FROM verify_attempts WHERE verify_attempt_id=?")
        .get(verifyAttemptId);
      assert.equal(attempt?.state, "retired");
      assert.equal(attempt?.ended_at, fixture.board.requireWorkItem(parent.workItemId).endedAt);
    } finally {
      retired.close();
    }

    assert.equal(await fixture.board.sweepVerifyAttempts(), 0);
    const settled = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(settled.prepare("SELECT 1 FROM tasks WHERE task_id=?")
        .get(`task_${verifyAttemptId}`), undefined);
      assert.equal(settled.prepare("SELECT 1 FROM stage_handoffs WHERE handoff_id=?")
        .get(`handoff_${verifyAttemptId}`), undefined);
    } finally {
      settled.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("park auto-abandon cascades to an active child while preserving a merged sibling", async () => {
  let clock = new Date(NOW);
  const fixture = await boardFixture(undefined, () => clock, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, [{
      key: "active",
      objective: "Remain active until the parked parent auto-abandons.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/auto-cascade-active"],
      acceptanceCriteria: ["Auto-abandon terminates this run."],
    }, {
      key: "failure",
      objective: "Fail to park the coordinating parent.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/auto-cascade-failure"],
      acceptanceCriteria: ["This failure parks the parent."],
    }, {
      key: "merged",
      objective: "Remain merged across parent auto-abandon.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/auto-cascade-merged"],
      acceptanceCriteria: ["Merged siblings are untouched."],
    }], "auto-abandon-parent-cascade");
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "auto-abandon-parent-cascade-active-run",
      messageCursor: null,
    });
    assert.ok(claim?.task);
    const activeChildId = claim.context.workflow?.workspaceKey;
    assert.ok(activeChildId);
    const [failedChild, mergedChild] = decomposition.children.filter(
      (child) => child.workItemId !== activeChildId,
    );
    assert.ok(failedChild);
    assert.ok(mergedChild);
    forceMergedWithApproval(fixture.path, mergedChild.workItemId, MERGE_SHAS[0]);
    const mergedActionsBefore = gateActions(fixture.path, mergedChild.workItemId);
    fixture.board.updateWorkItem(failedChild.workItemId, {
      action: "cancel",
      version: fixture.board.requireWorkItem(failedChild.workItemId).version,
      reason: "Park the parent for lifecycle expiry.",
    });
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "parked");

    clock = new Date(Date.parse(NOW) + 8 * 24 * 60 * 60 * 1_000);
    const sweep = fixture.board.sweepParkLifecycle(clock.toISOString());

    assert.equal(sweep.autoAbandoned, 1);
    const parent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(parent.state, "abandoned");
    const activeChild = fixture.board.requireWorkItem(activeChildId);
    assert.equal(activeChild.state, "abandoned");
    assert.equal(activeChild.endedAt, parent.endedAt);
    assert.equal(fixture.board.requireTask(claim.task.taskId).status, "cancelled");
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT status FROM runs WHERE run_id=?").get(claim.run.runId)?.status, "interrupted");
    } finally {
      db.close();
    }
    const childCancel = gateActions(fixture.path, activeChildId).at(-1);
    assert.equal(childCancel?.gate, "cancel");
    assert.equal(childCancel?.refId, parent.workItemId);
    assert.equal(childCancel?.note, `parent ${parent.workItemId} abandoned`);
    assert.equal(fixture.board.requireWorkItem(mergedChild.workItemId).state, "merged");
    assert.deepEqual(gateActions(fixture.path, mergedChild.workItemId), mergedActionsBefore);
  } finally {
    fixture.board.close();
  }
});
