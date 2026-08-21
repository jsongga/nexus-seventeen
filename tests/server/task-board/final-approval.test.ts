import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DESIGN_FAILURE_POINTS,
  type DesignRecordDraft,
  type StageHandoff,
  type WorkItemAudit,
  type WorkflowPlanDraft,
} from "#shared/task-board-contract";
import { createTaskBoardService, SkillRegistry, TaskBoard, TaskBoardError } from "#server/task-board";
import { mergePipelineBranch } from "#server/task-board/collaborators/merge-executor";
import {
  registerWorkItemTransitionStore,
  transitionWorkItemInTransaction,
} from "#server/task-board/collaborators/work-item-transitions";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import { TransparentWorkflow } from "#server/task-board/persistence/workflow";
import {
  AGENT_ONE_TOKEN,
  HUMAN_TOKEN,
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  config,
  gateActions,
  workItemRequest,
} from "./helpers.js";

type Fixture = Awaited<ReturnType<typeof boardFixture>>;

function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...arguments_], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(stderr));
      else resolve(stdout);
    });
  });
}

async function repository(): Promise<{ repo: string; baseSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "steward-final-approval-"));
  const repo = join(root, "repo");
  await git(root, ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.name", "Task Board Test"]);
  await git(repo, ["config", "user.email", "task-board@test.invalid"]);
  await writeFile(join(repo, "shared.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  return { repo, baseSha: (await git(repo, ["rev-parse", "HEAD"])).trim() };
}

function plan(suffix: string): WorkflowPlanDraft {
  return {
    objective: `Review and merge pipeline ${suffix}.`,
    assumptions: ["The default branch stays available."],
    acceptanceCriteria: [
      "The human can inspect the complete pipeline evidence.",
      "The pipeline commit lands only after approval.",
    ],
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["src/allowed"],
    nonGoals: ["Do not push a remote branch."],
    mechanicalPortions: ["Merge the reviewed local branch."],
    blockingQuestions: [],
    criterionChecks: [
      { criterion: "The human can inspect the complete pipeline evidence.", check: "node check.mjs" },
      { criterion: "An unmatched machine check remains visible.", check: "node unmatched.mjs" },
    ],
    nodes: [{
      nodeId: `final-approval-${suffix}`,
      title: `Final approval ${suffix}`,
      objective: "Produce one bounded implementation commit.",
      acceptanceCriteria: ["The commit is reviewable."],
      dependencyNodeIds: [],
      stageTemplate: ["implementation", "testing", "verification"],
    }],
  };
}

function configurePipeline(fixture: Fixture, suffix: string): void {
  const implementation = {
    agentTypeId: `final-approval-engineer-${suffix}`,
    name: "Final approval engineer",
    description: "Produces the local pipeline commit.",
    role: "engineer" as const,
    supplementalInstructions: "Implement only the confirmed pipeline plan.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  const verification = {
    ...implementation,
    agentTypeId: `final-approval-verifier-${suffix}`,
    name: "Final approval verifier",
    description: "Independently reviews the machine-verified pipeline.",
    role: "verifier" as const,
  };
  fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
    agentTypes: [implementation, verification],
    stages: automationStages({
      implementation: { kind: "agent_type", agentTypeId: implementation.agentTypeId },
      testing: { kind: "machine_verify" },
      verification: { kind: "agent_type", agentTypeId: verification.agentTypeId },
    }),
  }));
}

function setProjectRepository(fixture: Fixture, repo: string): void {
  const db = new DatabaseSync(fixture.path);
  try {
    db.prepare("UPDATE projects SET description=? WHERE project_id=?").run(repo, fixture.project.projectId);
  } finally {
    db.close();
  }
}

function proposePipeline(fixture: Fixture, suffix: string): { workItemId: string; planRevisionId: string } {
  const workItem = fixture.board.createWorkItemAndStartPlanning(workItemRequest({
    originalRequest: `Prepare final approval ${suffix}.`,
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), `final-approval-${suffix}`).workItem;
  const claim = fixture.board.claimRun(fixture.manager.agentId, {
    claimId: `final-approval-plan-${suffix}`,
    messageCursor: null,
  });
  assert.ok(claim);
  fixture.board.settleRun(claim.run.runId, fixture.manager.agentId, {
    outcome: "completed",
    result: "The pipeline plan is ready.",
    workflowPlan: plan(suffix),
  });
  const revision = fixture.board.projectWorkflow(fixture.project.projectId).plans.find(
    (candidate) => candidate.workItemId === workItem.workItemId && candidate.state === "proposed",
  );
  assert.ok(revision);
  return { workItemId: workItem.workItemId, planRevisionId: revision.planRevisionId };
}

function forceFinalApproval(path: string, workItemId: string, verifiedSha: string): number {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare(`
      SELECT
        node.node_id,node.project_id,node.title,node.objective,node.acceptance_criteria_json,
        attempt.task_id
      FROM plan_revisions plan
      JOIN work_nodes node ON node.plan_revision_id=plan.plan_revision_id
      JOIN stage_attempts attempt ON attempt.node_id=node.node_id AND attempt.stage='implementation'
      WHERE plan.work_item_id=?
    `).get(workItemId);
    assert.ok(row);
    const nodeId = String(row.node_id);
    const taskId = String(row.task_id);
    const now = "2026-08-19T16:00:00.000Z";
    db.prepare(`
      UPDATE tasks
      SET status='completed',started_at=COALESCE(started_at,?),ended_at=?,result='Implementation complete.',version=version+1,updated_at=?
      WHERE task_id=?
    `).run(now, now, now, taskId);
    const handoff: StageHandoff = {
      apiVersion: "steward.task-board/v1",
      handoffId: `handoff-final-${workItemId}`,
      nodeId,
      taskId,
      stage: "implementation",
      outcome: "passed",
      summary: "Implementation is ready for final review.",
      evidence: [
        "The default branch stays available.",
        "Focused tests passed at commit abc123.",
        "ASSUMPTION: Use a plain-text marker for v1.",
      ],
      artifactIds: [],
      acceptanceCriteria: [],
      blockers: [],
      recommendedReturnStage: null,
      createdAt: now,
    };
    db.prepare("INSERT INTO stage_handoffs VALUES(?,?,?,?,?,?,?)").run(
      handoff.handoffId,
      nodeId,
      taskId,
      handoff.stage,
      handoff.outcome,
      JSON.stringify(handoff),
      now,
    );
    db.prepare(`
      INSERT INTO task_events(event_id,project_id,task_id,actor_type,actor_id,event_type,data_json,created_at)
      VALUES (?, ?, ?, 'agent', 'engineer-one', 'task_run_settled', '{}', ?)
    `).run(`event-engineer-${workItemId}`, String(row.project_id), taskId, now);
    db.prepare(`
      INSERT INTO verify_attempts(
        verify_attempt_id,node_id,stage,attempt,verify_run_id,workspace_path,state,
        check_results_json,detail,created_at,ended_at
      ) VALUES(?,?,'testing',1,'verify-run-one',NULL,'green',?,?,?,?)
    `).run(
      `verify-final-${workItemId}`,
      nodeId,
      JSON.stringify([{
        criterion: "The human can inspect the complete pipeline evidence.",
        check: "node check.mjs",
        passed: true,
      }]),
      `verified-sha:${verifiedSha}`,
      now,
      now,
    );
    const verifyTaskId = `task-machine-${workItemId}`;
    const orderKey = Number(db.prepare("SELECT COALESCE(MAX(order_key),-1)+1 AS n FROM tasks").get()?.n);
    db.prepare(`
      INSERT INTO tasks(
        task_id,project_id,parent_task_id,task_kind,required_role,requires_review,
        title,objective,acceptance_criteria,workspace_refs_json,status,assigned_agent_id,
        assigned_role,expected_agent_minutes,agent_estimate_minutes,estimate_recorded_at,
        order_key,started_at,ended_at,result,version,created_at,updated_at
      ) VALUES (?, ?, NULL, 'work', NULL, 0, ?, ?, ?, '[]', 'completed', NULL,
        NULL, 15, NULL, NULL, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      verifyTaskId,
      String(row.project_id),
      `Machine verify: ${String(row.title)}`,
      String(row.objective),
      (JSON.parse(String(row.acceptance_criteria_json)) as string[]).join("\n"),
      orderKey,
      now,
      now,
      "All configured checks passed.",
      now,
      now,
    );
    db.prepare(`
      INSERT INTO task_events(event_id,project_id,task_id,actor_type,actor_id,event_type,data_json,created_at)
      VALUES (?, ?, ?, 'system', 'system:machine-verify', 'task_created', '{}', ?)
    `).run(`event-machine-${workItemId}`, String(row.project_id), verifyTaskId, now);
    const verifyHandoff: StageHandoff = {
      apiVersion: "steward.task-board/v1",
      handoffId: `handoff-machine-${workItemId}`,
      nodeId,
      taskId: verifyTaskId,
      stage: "testing",
      outcome: "passed",
      summary: "Machine verification passed.",
      evidence: ["Machine verify supplied this operational message."],
      artifactIds: [],
      acceptanceCriteria: [],
      blockers: [],
      recommendedReturnStage: null,
      createdAt: now,
    };
    db.prepare("INSERT INTO stage_handoffs VALUES(?,?,?,?,?,?,?)").run(
      verifyHandoff.handoffId,
      nodeId,
      verifyTaskId,
      verifyHandoff.stage,
      verifyHandoff.outcome,
      JSON.stringify(verifyHandoff),
      now,
    );
    db.prepare("UPDATE work_nodes SET state='completed',current_stage=NULL,version=version+1,updated_at=? WHERE node_id=?")
      .run(now, nodeId);
    db.prepare("UPDATE work_items SET state='final_approval',current_stage=NULL,version=version+1,updated_at=? WHERE work_item_id=?")
      .run(now, workItemId);
    return Number(db.prepare("SELECT version FROM work_items WHERE work_item_id=?").get(workItemId)?.version);
  } finally {
    db.close();
  }
}

async function directFinalApprovalFixture(suffix: string): Promise<{
  path: string;
  workItemId: string;
  planRevisionId: string;
  version: number;
}> {
  const fixture = await boardFixture();
  try {
    const repo = await repository();
    setProjectRepository(fixture, repo.repo);
    configurePipeline(fixture, suffix);
    const proposed = proposePipeline(fixture, suffix);
    fixture.board.confirmWorkflow(proposed.planRevisionId, { expectedState: "proposed" });
    const version = forceFinalApproval(fixture.path, proposed.workItemId, "a".repeat(40));
    return {
      path: fixture.path,
      workItemId: proposed.workItemId,
      planRevisionId: proposed.planRevisionId,
      version,
    };
  } finally {
    fixture.board.close();
  }
}

function seedActiveBlockingFixLoop(path: string, workItemId: string): void {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare(`
      SELECT node.node_id,handoff.task_id
      FROM plan_revisions plan
      JOIN work_nodes node ON node.plan_revision_id=plan.plan_revision_id
      JOIN stage_handoffs handoff ON handoff.node_id=node.node_id AND handoff.stage='testing'
      WHERE plan.work_item_id=? AND plan.state='confirmed'
      LIMIT 1
    `).get(workItemId);
    assert.ok(row);
    db.prepare("INSERT INTO stage_attempts VALUES(?,?,?,?,?,?)").run(
      `attempt-conflict-review-${workItemId}`,
      String(row.node_id),
      String(row.task_id),
      "verification",
      1,
      "{}",
    );
    db.prepare(`
      INSERT INTO review_findings(
        finding_id,node_id,stage,round,file,line,category,severity,expected,actual,blocking,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      `finding-conflict-review-${workItemId}`,
      String(row.node_id),
      "verification",
      1,
      "src/allowed/change.txt",
      1,
      "correctness",
      "major",
      "The pipeline branch merges cleanly.",
      "The merge target conflicts with the pipeline branch.",
      1,
      "2026-08-19T16:30:00.000Z",
    );
  } finally {
    db.close();
  }
}

async function settleMergeConflict(
  path: string,
  workItemId: string,
  version: number,
): Promise<string> {
  const store = await TaskBoardStore.open(path);
  registerWorkItemTransitionStore(store);
  try {
    const workflow = new TransparentWorkflow(
      store.db,
      new SkillRegistry("skills"),
      () => new Date("2026-08-19T17:00:00.000Z"),
      (operation) => store.transaction(operation),
      undefined,
      () => "",
    );
    store.transaction(() => workflow.settlePipelineMergeInTransaction(
      workItemId,
      version,
      { kind: "conflict", summary: "merge conflict in shared.txt" },
      "human:alice",
    ));
    return String(store.db.prepare("SELECT state FROM work_items WHERE work_item_id=?").get(workItemId)?.state);
  } finally {
    store.close();
  }
}

function addReviewAndDesignEvidence(path: string, workItemId: string): DesignRecordDraft {
  const designRecord: DesignRecordDraft = {
    states: ["pending", "sent", "committed"],
    transitions: [{
      from: "pending",
      to: "sent",
      durablePrecondition: "requestId is persisted",
      recovery: "Reuse requestId",
    }],
    failurePoints: DESIGN_FAILURE_POINTS.map((point) => ({
      point,
      resultingState: "pending",
      recovery: "Retry with requestId",
    })),
    idempotencyKeys: [{
      name: "requestId",
      generatedAt: "Before send",
      persistedAt: "With pending state",
      reuse: "Every retry",
    }],
    faultInjectionCases: [{
      name: "Lost response",
      scenario: "Crash after send",
      expectation: "One durable write",
    }],
  };
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare(`
      SELECT plan.plan_revision_id,node.node_id
      FROM plan_revisions plan
      JOIN work_nodes node ON node.plan_revision_id=plan.plan_revision_id
      WHERE plan.work_item_id=? AND plan.state='confirmed'
      LIMIT 1
    `).get(workItemId);
    assert.ok(row);
    db.prepare(`
      INSERT INTO review_findings(
        finding_id,node_id,stage,round,file,line,category,severity,expected,actual,blocking,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      `finding-round-two-${workItemId}`,
      String(row.node_id),
      "verification",
      2,
      "src/allowed/change.txt",
      7,
      "correctness",
      "major",
      "The retry reuses requestId.",
      "The retry generated a new key.",
      1,
      "2026-08-19T16:01:00.000Z",
    );
    db.prepare(`
      INSERT INTO review_findings(
        finding_id,node_id,stage,round,file,line,category,severity,expected,actual,blocking,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      `finding-round-one-${workItemId}`,
      String(row.node_id),
      "verification",
      1,
      null,
      null,
      "docs",
      "minor",
      "The operator notes are present.",
      "The notes were absent.",
      0,
      "2026-08-19T16:02:00.000Z",
    );
    db.prepare(`
      INSERT INTO design_records(design_record_id,work_item_id,plan_revision_id,payload_json,created_at)
      VALUES(?,?,?,?,?)
    `).run(
      `design-${workItemId}`,
      workItemId,
      String(row.plan_revision_id),
      JSON.stringify(designRecord),
      "2026-08-19T16:03:00.000Z",
    );
  } finally {
    db.close();
  }
  return designRecord;
}

async function finalApprovalFixture(
  suffix: string,
  conflict = false,
  forceSettlementConflict = false,
  empty = false,
) {
  const fixture = await boardFixture();
  const repo = await repository();
  setProjectRepository(fixture, repo.repo);
  configurePipeline(fixture, suffix);
  const proposed = proposePipeline(fixture, suffix);
  fixture.board.confirmWorkflow(proposed.planRevisionId, { expectedState: "proposed" });
  const branch = `task/${proposed.workItemId}`;
  await git(repo.repo, ["switch", "-c", branch]);
  if (!empty) {
    await mkdir(join(repo.repo, "src", "allowed"), { recursive: true });
    await writeFile(
      join(repo.repo, conflict ? "shared.txt" : "src/allowed/change.txt"),
      "pipeline\n",
    );
    await git(repo.repo, ["add", "."]);
    await git(repo.repo, ["commit", "-m", `pipeline ${suffix}`]);
  }
  const verifiedSha = (await git(repo.repo, ["rev-parse", "HEAD"])).trim();
  await git(repo.repo, ["switch", "main"]);
  if (conflict) {
    await writeFile(join(repo.repo, "shared.txt"), "default\n");
    await git(repo.repo, ["add", "shared.txt"]);
    await git(repo.repo, ["commit", "-m", "default conflict"]);
  }
  const version = forceFinalApproval(fixture.path, proposed.workItemId, verifiedSha);
  fixture.board.close();
  const service = await createTaskBoardService(
    {
      dbPath: fixture.path,
      humanToken: HUMAN_TOKEN,
      humanPrincipal: "human:alice",
      port: 0,
      reconcileIntervalSeconds: 0,
      now: () => new Date("2026-08-19T17:00:00.000Z"),
    },
    forceSettlementConflict ? {
      mergePipeline: (request_) => {
        const result = mergePipelineBranch(request_);
        if (result.kind === "merged") {
          const db = new DatabaseSync(fixture.path);
          try {
            db.prepare("UPDATE work_items SET version=version+1 WHERE work_item_id=?").run(proposed.workItemId);
          } finally {
            db.close();
          }
        }
        return result;
      },
    } : {},
  );
  const address = await service.start();
  return { ...fixture, ...repo, ...proposed, branch, verifiedSha, version, service, origin: address.url };
}

function request(
  origin: string,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  token = HUMAN_TOKEN,
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

test("board pipeline summary assembles ordered findings and the validated design record", async () => {
  const fixture = await boardFixture();
  const repo = await repository();
  try {
    setProjectRepository(fixture, repo.repo);
    configurePipeline(fixture, "direct-summary");
    const proposed = proposePipeline(fixture, "direct-summary");
    fixture.board.confirmWorkflow(proposed.planRevisionId, { expectedState: "proposed" });
    const branch = `task/${proposed.workItemId}`;
    await git(repo.repo, ["switch", "-c", branch]);
    await mkdir(join(repo.repo, "src", "allowed"), { recursive: true });
    await writeFile(join(repo.repo, "src", "allowed", "change.txt"), "pipeline\n");
    await git(repo.repo, ["add", "."]);
    await git(repo.repo, ["commit", "-m", "pipeline direct summary"]);
    const verifiedSha = (await git(repo.repo, ["rev-parse", "HEAD"])).trim();
    await git(repo.repo, ["switch", "main"]);
    forceFinalApproval(fixture.path, proposed.workItemId, verifiedSha);
    const designRecord = addReviewAndDesignEvidence(fixture.path, proposed.workItemId);

    const summary = fixture.board.pipelineSummary(proposed.workItemId);

    assert.deepEqual(summary.findings.map((finding) => finding.round), [1, 2]);
    assert.deepEqual(summary.findings.map((finding) => finding.findingId), [
      `finding-round-one-${proposed.workItemId}`,
      `finding-round-two-${proposed.workItemId}`,
    ]);
    assert.equal(summary.findings[1]?.blocking, true);
    assert.deepEqual(summary.designRecord, designRecord);
  } finally {
    fixture.board.close();
  }
});

test("pipeline summary returns git, scope, finding, design, verify, and criteria evidence", async () => {
  const fixture = await finalApprovalFixture("summary");
  try {
    const designRecord = addReviewAndDesignEvidence(fixture.path, fixture.workItemId);
    const response = await request(fixture.origin, `/v1/work-items/${fixture.workItemId}/pipeline-summary`, "GET");
    assert.equal(response.status, 200);
    const summary = await response.json() as Record<string, unknown>;
    assert.deepEqual(summary.commits, [{
      sha: (await git(fixture.repo, ["rev-parse", fixture.branch])).trim(),
      subject: "pipeline summary",
    }]);
    assert.match(String(summary.diffstat), /src\/allowed\/change\.txt/u);
    assert.deepEqual(summary.filesTouched, ["src/allowed/change.txt"]);
    assert.deepEqual(summary.declaredScope, ["src/allowed"]);
    assert.equal(summary.scopeOk, true);
    assert.deepEqual(summary.assumptions, ["The default branch stays available."]);
    assert.deepEqual(summary.midRunAssumptions, ["Use a plain-text marker for v1."]);
    assert.deepEqual((summary.findings as Array<Record<string, unknown>>).map((finding) => ({
      findingId: finding.findingId,
      round: finding.round,
      file: finding.file,
      line: finding.line,
      category: finding.category,
      severity: finding.severity,
      blocking: finding.blocking,
    })), [{
      findingId: `finding-round-one-${fixture.workItemId}`,
      round: 1,
      file: null,
      line: null,
      category: "docs",
      severity: "minor",
      blocking: false,
    }, {
      findingId: `finding-round-two-${fixture.workItemId}`,
      round: 2,
      file: "src/allowed/change.txt",
      line: 7,
      category: "correctness",
      severity: "major",
      blocking: true,
    }]);
    assert.deepEqual(summary.designRecord, designRecord);
    assert.deepEqual(summary.criteria, ["The pipeline commit lands only after approval."]);
    assert.deepEqual(summary.criterionChecks, [
      {
        criterion: "The human can inspect the complete pipeline evidence.",
        check: "node check.mjs",
      },
      {
        criterion: "An unmatched machine check remains visible.",
        check: "node unmatched.mjs",
      },
    ]);
    assert.deepEqual((summary.verify as Array<Record<string, unknown>>).map((attempt) => ({
      state: attempt.state,
      checkResults: attempt.checkResults,
    })), [{
      state: "green",
      checkResults: [{
        criterion: "The human can inspect the complete pipeline evidence.",
        check: "node check.mjs",
        passed: true,
      }],
    }]);
    assert.equal((await request(
      fixture.origin,
      `/v1/work-items/${fixture.workItemId}/pipeline-summary`,
      "GET",
      undefined,
      "not-a-human-token",
    )).status, 401);
  } finally {
    await fixture.service.close();
  }
});

test("approve-merge merges before transitioning the work item to merged", async () => {
  const fixture = await finalApprovalFixture("approve");
  try {
    const response = await request(
      fixture.origin,
      `/v1/work-items/${fixture.workItemId}/approve-merge`,
      "POST",
      { version: fixture.version },
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { workItem: { state: string; endedAt: string | null } };
    assert.equal(body.workItem.state, "merged");
    assert.notEqual(body.workItem.endedAt, null);
    assert.equal(await readFile(join(fixture.repo, "src", "allowed", "change.txt"), "utf8"), "pipeline\n");
    assert.equal((await git(fixture.repo, ["rev-list", "--parents", "-n", "1", "HEAD"])).trim().split(" ").length, 3);
    const mergeSha = (await git(fixture.repo, ["rev-parse", "HEAD"])).trim();
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const event = db.prepare("SELECT summary FROM project_events WHERE event_type='pipeline_merged' ORDER BY sequence DESC LIMIT 1").get();
      assert.match(String(event?.summary), /^merged [0-9a-f]{40,64}$/u);
    } finally {
      db.close();
    }

    const actions = gateActions(fixture.path, fixture.workItemId);
    const approvedAction = actions.find((action) => action.gate === "final_approve");
    assert.ok(approvedAction);
    assert.match(approvedAction.gateActionId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual({ ...approvedAction, gateActionId: undefined }, {
      gateActionId: undefined,
      workItemId: fixture.workItemId,
      gate: "final_approve",
      actorId: "human:alice",
      planRevisionId: fixture.planRevisionId,
      verifiedSha: fixture.verifiedSha,
      mergeSha,
      refId: null,
      note: null,
      createdAt: "2026-08-19T17:00:00.000Z",
    });

    const auditResponse = await request(
      fixture.origin,
      `/v1/work-items/${fixture.workItemId}/audit`,
      "GET",
    );
    assert.equal(auditResponse.status, 200);
    const audit = await auditResponse.json() as WorkItemAudit;
    assert.deepEqual(audit.gateActions, actions);
    assert.deepEqual(audit.gateActions.map((action) => action.gate), ["plan_confirm", "final_approve"]);
    assert.equal(audit.transitions.at(-1)?.toState, "merged");
    assert.equal((await request(
      fixture.origin,
      `/v1/work-items/${fixture.workItemId}/audit?unexpected=1`,
      "GET",
    )).status, 400);
    assert.equal((await request(
      fixture.origin,
      `/v1/work-items/${fixture.workItemId}/audit`,
      "GET",
      undefined,
      "not-a-human-token",
    )).status, 401);
  } finally {
    await fixture.service.close();
  }
});

test("approve-merge rejects a branch advanced after green verification without touching the merge target", async () => {
  const fixture = await finalApprovalFixture("branch-moved");
  try {
    const before = (await git(fixture.repo, ["rev-parse", "HEAD"])).trim();
    await git(fixture.repo, ["switch", fixture.branch]);
    await writeFile(join(fixture.repo, "src", "allowed", "post-verify.txt"), "unverified\n");
    await git(fixture.repo, ["add", "src/allowed/post-verify.txt"]);
    await git(fixture.repo, ["commit", "-m", "advance after verification"]);
    await git(fixture.repo, ["switch", "main"]);

    const response = await request(
      fixture.origin,
      `/v1/work-items/${fixture.workItemId}/approve-merge`,
      "POST",
      { version: fixture.version },
    );

    assert.equal(response.status, 409);
    const error = await response.json() as { error: { code: string; message: string } };
    assert.equal(error.error.code, "TASK_BOARD_PIPELINE_BRANCH_MOVED");
    assert.equal(error.error.message, "branch advanced since verification — request changes to re-verify");
    assert.equal((await git(fixture.repo, ["branch", "--show-current"])).trim(), "main");
    assert.equal((await git(fixture.repo, ["rev-parse", "HEAD"])).trim(), before);
    assert.equal(await git(fixture.repo, ["status", "--porcelain"]), "");
    await assert.rejects(readFile(join(fixture.repo, "src", "allowed", "post-verify.txt")));
    assert.equal(
      (await request(fixture.origin, `/v1/work-items/${fixture.workItemId}`, "GET")
        .then((result) => result.json()) as { workItem: { state: string } }).workItem.state,
      "final_approval",
    );
  } finally {
    await fixture.service.close();
  }
});

test("approve-merge rejects a zero-commit pipeline branch as empty", async () => {
  const fixture = await finalApprovalFixture("empty", false, false, true);
  try {
    const before = (await git(fixture.repo, ["rev-parse", "HEAD"])).trim();
    const response = await request(
      fixture.origin,
      `/v1/work-items/${fixture.workItemId}/approve-merge`,
      "POST",
      { version: fixture.version },
    );

    assert.equal(response.status, 409);
    const error = await response.json() as { error: { code: string; message: string } };
    assert.equal(error.error.code, "TASK_BOARD_PIPELINE_BRANCH_EMPTY");
    assert.equal(error.error.message, "nothing to merge");
    assert.equal((await git(fixture.repo, ["rev-parse", "HEAD"])).trim(), before);
    assert.equal(
      (await request(fixture.origin, `/v1/work-items/${fixture.workItemId}`, "GET")
        .then((result) => result.json()) as { workItem: { state: string } }).workItem.state,
      "final_approval",
    );
  } finally {
    await fixture.service.close();
  }
});

test("concurrent approve and reject serialize so exactly one wins without an orphaned merge", async () => {
  const fixture = await finalApprovalFixture("approval-race");
  try {
    const [approve, reject] = await Promise.all([
      request(
        fixture.origin,
        `/v1/work-items/${fixture.workItemId}/approve-merge`,
        "POST",
        { version: fixture.version },
      ),
      request(
        fixture.origin,
        `/v1/work-items/${fixture.workItemId}/reject-final`,
        "POST",
        { version: fixture.version, note: "Hold this merge for one more implementation pass." },
      ),
    ]);
    assert.deepEqual([approve.status, reject.status].sort((left, right) => left - right), [200, 409]);
    const current = await request(fixture.origin, `/v1/work-items/${fixture.workItemId}`, "GET");
    assert.match(
      (await current.json() as { workItem: { state: string } }).workItem.state,
      /^(?:merged|fixing)$/u,
    );
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(db.prepare(
        "SELECT COUNT(*) AS n FROM project_events WHERE event_type='pipeline_merge_orphaned'",
      ).get()?.n, 0);
    } finally {
      db.close();
    }
  } finally {
    await fixture.service.close();
  }
});

test("a forced post-merge settlement CAS failure records the orphaned sha and returns its distinct code", async () => {
  const fixture = await finalApprovalFixture("settlement-conflict", false, true);
  try {
    const response = await request(
      fixture.origin,
      `/v1/work-items/${fixture.workItemId}/approve-merge`,
      "POST",
      { version: fixture.version },
    );
    assert.equal(response.status, 409);
    assert.equal(
      (await response.json() as { error: { code: string } }).error.code,
      "TASK_BOARD_PIPELINE_MERGE_SETTLEMENT_CONFLICT",
    );
    const mergeSha = (await git(fixture.repo, ["rev-parse", "HEAD"])).trim();
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const event = db.prepare(`
        SELECT summary
        FROM project_events
        WHERE event_type='pipeline_merge_orphaned'
        ORDER BY sequence DESC
        LIMIT 1
      `).get();
      assert.match(String(event?.summary), new RegExp(mergeSha, "u"));
      assert.equal(
        db.prepare("SELECT state FROM work_items WHERE work_item_id=?").get(fixture.workItemId)?.state,
        "final_approval",
      );
    } finally {
      db.close();
    }
  } finally {
    await fixture.service.close();
  }
});

test("approve-merge returns a distinct divergence conflict without mutating the merge target", async () => {
  const fixture = await finalApprovalFixture("diverged");
  try {
    await git(fixture.repo, ["switch", "--orphan", "develop"]);
    await writeFile(join(fixture.repo, "unrelated.txt"), "unrelated root\n");
    await git(fixture.repo, ["add", "."]);
    await git(fixture.repo, ["commit", "-m", "unrelated merge target"]);
    const before = (await git(fixture.repo, ["rev-parse", "HEAD"])).trim();
    const response = await request(
      fixture.origin,
      `/v1/work-items/${fixture.workItemId}/approve-merge`,
      "POST",
      { version: fixture.version },
    );
    assert.equal(response.status, 409);
    const error = await response.json() as { error: { code: string; message: string } };
    assert.equal(error.error.code, "TASK_BOARD_PIPELINE_BASE_DIVERGED");
    assert.match(error.error.message, /diverged/iu);
    assert.equal((await git(fixture.repo, ["rev-parse", "HEAD"])).trim(), before);
    const current = await request(fixture.origin, `/v1/work-items/${fixture.workItemId}`, "GET");
    assert.equal((await current.json() as { workItem: { state: string } }).workItem.state, "final_approval");
  } finally {
    await fixture.service.close();
  }
});

test("approve-merge returns conflicts to implementation and returns repo-busy without transition", async () => {
  const conflictFixture = await finalApprovalFixture("conflict", true);
  try {
    const before = (await git(conflictFixture.repo, ["rev-parse", "HEAD"])).trim();
    const response = await request(
      conflictFixture.origin,
      `/v1/work-items/${conflictFixture.workItemId}/approve-merge`,
      "POST",
      { version: conflictFixture.version },
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { workItem: { state: string; currentStage: string } };
    assert.equal(body.workItem.state, "implementing");
    assert.equal(body.workItem.currentStage, "implementation");
    assert.equal((await git(conflictFixture.repo, ["rev-parse", "HEAD"])).trim(), before);
    assert.equal(await git(conflictFixture.repo, ["status", "--porcelain"]), "");
    const claimResponse = await request(
      conflictFixture.origin,
      `/v1/agents/${conflictFixture.engineer.agentId}/runs/claim`,
      "POST",
      { claimId: "claim-merge-conflict", messageCursor: null },
      AGENT_ONE_TOKEN,
    );
    assert.equal(claimResponse.status, 201);
    const claim = await claimResponse.json() as {
      run: { runId: string };
      task: { taskId: string };
      context: { workflow: { stage: string; dependencyHandoffs: Array<{ outcome: string; summary: string }> } };
    };
    assert.equal(claim.context.workflow.stage, "implementation");
    assert.equal(claim.context.workflow.dependencyHandoffs.length, 1);
    assert.equal(claim.context.workflow.dependencyHandoffs[0]?.outcome, "failed");
    assert.match(String(claim.context.workflow.dependencyHandoffs[0]?.summary), /merge conflict/iu);

    const questionResponse = await request(
      conflictFixture.origin,
      `/v1/tasks/${claim.task.taskId}/questions`,
      "POST",
      {
        clientEventId: "question-merge-conflict-implementation-0001",
        question: "Should the conflict resolution preserve the pipeline branch behavior?",
        runId: claim.run.runId,
      },
      AGENT_ONE_TOKEN,
    );
    assert.equal(questionResponse.status, 201);
    const question = (await questionResponse.json() as {
      question: { questionId: string; version: number };
    }).question;
    const answerResponse = await request(
      conflictFixture.origin,
      `/v1/questions/${question.questionId}/answer`,
      "POST",
      { answer: "Yes, preserve the reviewed behavior.", version: question.version },
    );
    assert.equal(answerResponse.status, 201);
    const resumedResponse = await request(
      conflictFixture.origin,
      `/v1/work-items/${conflictFixture.workItemId}`,
      "GET",
    );
    assert.equal((await resumedResponse.json() as { workItem: { state: string } }).workItem.state, "implementing");
  } finally {
    await conflictFixture.service.close();
  }

  const busyFixture = await finalApprovalFixture("busy");
  try {
    await writeFile(join(busyFixture.repo, "operator-notes.txt"), "not committed\n");
    const response = await request(
      busyFixture.origin,
      `/v1/work-items/${busyFixture.workItemId}/approve-merge`,
      "POST",
      { version: busyFixture.version },
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "TASK_BOARD_PIPELINE_REPO_BUSY");
    const current = await request(busyFixture.origin, `/v1/work-items/${busyFixture.workItemId}`, "GET");
    assert.equal((await current.json() as { workItem: { state: string } }).workItem.state, "final_approval");
  } finally {
    await busyFixture.service.close();
  }
});

test("merge-conflict settlement without findings history returns to implementing", async () => {
  const fixture = await directFinalApprovalFixture("conflict-no-findings");

  assert.equal(
    await settleMergeConflict(fixture.path, fixture.workItemId, fixture.version),
    "implementing",
  );
});

test("merge-conflict settlement with an active blocking findings loop returns to fixing", async () => {
  const fixture = await directFinalApprovalFixture("conflict-active-fix-loop");
  seedActiveBlockingFixLoop(fixture.path, fixture.workItemId);

  assert.equal(
    await settleMergeConflict(fixture.path, fixture.workItemId, fixture.version),
    "fixing",
  );
});

test("successful approval settlement persists the verified branch tip and merge commit", async () => {
  const fixture = await boardFixture();
  const repo = await repository();
  try {
    setProjectRepository(fixture, repo.repo);
    configurePipeline(fixture, "direct-approve-ledger");
    const proposed = proposePipeline(fixture, "direct-approve-ledger");
    fixture.board.confirmWorkflow(proposed.planRevisionId, { expectedState: "proposed" });
    const branch = `task/${proposed.workItemId}`;
    await git(repo.repo, ["switch", "-c", branch]);
    await mkdir(join(repo.repo, "src", "allowed"), { recursive: true });
    await writeFile(join(repo.repo, "src", "allowed", "change.txt"), "pipeline\n");
    await git(repo.repo, ["add", "."]);
    await git(repo.repo, ["commit", "-m", "pipeline direct approval ledger"]);
    const verifiedSha = (await git(repo.repo, ["rev-parse", "HEAD"])).trim();
    await git(repo.repo, ["switch", "main"]);
    const version = forceFinalApproval(fixture.path, proposed.workItemId, verifiedSha);

    const merged = await fixture.board.approvePipelineMerge(proposed.workItemId, { version });
    assert.equal(merged.state, "merged");
    const mergeSha = (await git(repo.repo, ["rev-parse", "HEAD"])).trim();
    const actions = gateActions(fixture.path, proposed.workItemId);
    const approvedAction = actions.find((action) => action.gate === "final_approve");
    assert.ok(approvedAction);
    assert.match(approvedAction.gateActionId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual({ ...approvedAction, gateActionId: undefined }, {
      gateActionId: undefined,
      workItemId: proposed.workItemId,
      gate: "final_approve",
      actorId: "human:alice",
      planRevisionId: proposed.planRevisionId,
      verifiedSha,
      mergeSha,
      refId: null,
      note: null,
      createdAt: "2026-07-19T20:00:00.000Z",
    });
    assert.deepEqual(
      fixture.board.workItemAudit(proposed.workItemId).gateActions.map((action) => action.gate),
      ["plan_confirm", "final_approve"],
    );
  } finally {
    fixture.board.close();
  }
});

test("final rejection persists a human-attributed gate action and task event", async () => {
  const fixture = await directFinalApprovalFixture("direct-reject-ledger");
  const board = await TaskBoard.open(config(
    fixture.path,
    () => new Date("2026-08-19T17:00:00.000Z"),
  ));
  try {
    const note = "Add the missing rollback assertion.";
    const rejected = await board.rejectFinalApproval(fixture.workItemId, {
      version: fixture.version,
      note,
    });
    assert.equal(rejected.state, "fixing");
    const rejectedAction = gateActions(fixture.path, fixture.workItemId).find(
      (action) => action.gate === "final_reject",
    );
    assert.ok(rejectedAction);
    assert.match(rejectedAction.gateActionId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual({ ...rejectedAction, gateActionId: undefined }, {
      gateActionId: undefined,
      workItemId: fixture.workItemId,
      gate: "final_reject",
      actorId: "human:alice",
      planRevisionId: fixture.planRevisionId,
      verifiedSha: null,
      mergeSha: null,
      refId: null,
      note,
      createdAt: "2026-08-19T17:00:00.000Z",
    });
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const event = db.prepare(`
        SELECT actor_type, actor_id
        FROM task_events
        WHERE event_type='task_created'
          AND json_extract(data_json,'$.workItemId')=?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `).get(fixture.workItemId);
      assert.deepEqual({ ...event }, { actor_type: "human", actor_id: "human:alice" });
    } finally {
      db.close();
    }
  } finally {
    board.close();
  }
});

test("reject-final records a human implementation handoff and re-arms engineering", async () => {
  const fixture = await finalApprovalFixture("reject");
  try {
    const note = "Keep the implementation, but add the missing rollback assertion.";
    const response = await request(
      fixture.origin,
      `/v1/work-items/${fixture.workItemId}/reject-final`,
      "POST",
      { version: fixture.version, note },
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { workItem: { state: string; currentStage: string } };
    assert.equal(body.workItem.state, "fixing");
    assert.equal(body.workItem.currentStage, "implementation");
    const rejectedAction = gateActions(fixture.path, fixture.workItemId).find(
      (action) => action.gate === "final_reject",
    );
    assert.ok(rejectedAction);
    assert.match(rejectedAction.gateActionId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual({ ...rejectedAction, gateActionId: undefined }, {
      gateActionId: undefined,
      workItemId: fixture.workItemId,
      gate: "final_reject",
      actorId: "human:alice",
      planRevisionId: fixture.planRevisionId,
      verifiedSha: null,
      mergeSha: null,
      refId: null,
      note,
      createdAt: "2026-08-19T17:00:00.000Z",
    });

    const summaryResponse = await request(
      fixture.origin,
      `/v1/work-items/${fixture.workItemId}/pipeline-summary`,
      "GET",
    );
    assert.equal(summaryResponse.status, 200);
    assert.deepEqual(
      (await summaryResponse.json() as { midRunAssumptions: string[] }).midRunAssumptions,
      ["Use a plain-text marker for v1."],
    );

    const claimResponse = await request(
      fixture.origin,
      `/v1/agents/${fixture.engineer.agentId}/runs/claim`,
      "POST",
      { claimId: "claim-final-rejection", messageCursor: null },
      AGENT_ONE_TOKEN,
    );
    assert.equal(claimResponse.status, 201);
    const claim = await claimResponse.json() as {
      run: { runId: string };
      task: { taskId: string };
      context: { workflow: { stage: string; dependencyHandoffs: Array<{ outcome: string; summary: string }> } };
    };
    assert.equal(claim.context.workflow.stage, "implementation");
    assert.deepEqual(claim.context.workflow.dependencyHandoffs.map((handoff) => ({
      outcome: handoff.outcome,
      summary: handoff.summary,
    })), [{ outcome: "failed", summary: note }]);

    const questionResponse = await request(
      fixture.origin,
      `/v1/tasks/${claim.task.taskId}/questions`,
      "POST",
      {
        clientEventId: "question-final-rejection-fix-0001",
        question: "Should the missing rollback assertion cover a timed-out retry?",
        runId: claim.run.runId,
      },
      AGENT_ONE_TOKEN,
    );
    assert.equal(questionResponse.status, 201);
    const question = (await questionResponse.json() as {
      question: { questionId: string; version: number };
    }).question;
    const parkedResponse = await request(
      fixture.origin,
      `/v1/work-items/${fixture.workItemId}`,
      "GET",
    );
    assert.equal((await parkedResponse.json() as { workItem: { state: string } }).workItem.state, "parked");

    const answerResponse = await request(
      fixture.origin,
      `/v1/questions/${question.questionId}/answer`,
      "POST",
      { answer: "Yes, cover the timed-out retry.", version: question.version },
    );
    assert.equal(answerResponse.status, 201);
    const answerAction = gateActions(fixture.path, fixture.workItemId).find(
      (action) => action.gate === "question_answer",
    );
    assert.ok(answerAction);
    assert.match(answerAction.gateActionId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual({ ...answerAction, gateActionId: undefined }, {
      gateActionId: undefined,
      workItemId: fixture.workItemId,
      gate: "question_answer",
      actorId: "human:alice",
      planRevisionId: null,
      verifiedSha: null,
      mergeSha: null,
      refId: question.questionId,
      note: null,
      createdAt: "2026-08-19T17:00:00.000Z",
    });
    const resumedResponse = await request(
      fixture.origin,
      `/v1/work-items/${fixture.workItemId}`,
      "GET",
    );
    assert.equal((await resumedResponse.json() as { workItem: { state: string } }).workItem.state, "fixing");

    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const author = db.prepare(`
        SELECT event.actor_type, event.actor_id, handoff.stage, handoff.outcome
        FROM stage_handoffs handoff
        JOIN task_events event ON event.task_id=handoff.task_id AND event.event_type='task_created'
        WHERE json_extract(handoff.payload_json,'$.summary')=?
      `).get(note);
      assert.deepEqual({ ...author }, {
        actor_type: "human",
        actor_id: "human:alice",
        stage: "implementation",
        outcome: "failed",
      });
    } finally {
      db.close();
    }
  } finally {
    await fixture.service.close();
  }
});

test("confirming a second pipeline plan returns the serial-project conflict while the first is reviewing", async () => {
  const fixture = await boardFixture();
  const repo = await repository();
  setProjectRepository(fixture, repo.repo);
  configurePipeline(fixture, "serial");
  const first = proposePipeline(fixture, "serial-first");
  fixture.board.confirmWorkflow(first.planRevisionId, { expectedState: "proposed" });
  const second = proposePipeline(fixture, "serial-second");
  fixture.board.close();
  const store = await TaskBoardStore.open(fixture.path);
  registerWorkItemTransitionStore(store);
  try {
    store.transaction(() => transitionWorkItemInTransaction(store, {
      workItemId: first.workItemId,
      to: "reviewing",
      actorType: "system",
      actorId: "system:test",
      now: "2026-08-19T16:00:00.000Z",
      currentStage: "verification",
    }));
  } finally {
    store.close();
  }
  const board = await TaskBoard.open(config(fixture.path));
  try {
    assert.throws(
      () => board.confirmWorkflow(second.planRevisionId, { expectedState: "proposed" }),
      (error: unknown) => (
        error instanceof TaskBoardError &&
        error.status === 409 &&
        error.code === "TASK_BOARD_PIPELINE_SERIAL_CONFLICT"
      ),
    );
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.deepEqual({
        ...db.prepare("SELECT pipeline_branch,base_sha FROM work_items WHERE work_item_id=?").get(second.workItemId),
      }, {
        pipeline_branch: null,
        base_sha: null,
      });
    } finally {
      db.close();
    }
  } finally {
    board.close();
  }
});
