import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TaskBoardError } from "#server/task-board";
import { sha256 } from "#server/task-board/canonical";
import type { CreateWorkItemRequest, WorkflowPlanDraft } from "#shared/task-board-contract";
import {
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  workItemRequest,
} from "./helpers.js";

const ONBOARDING_ACCEPTANCE_CRITERIA = "Return a single-node v2 workflowPlan with stageTemplate [\"implementation\",\"testing\",\"verification\"], declaredScope covering README.md, docs/**, and Dockerfile, and acceptance criteria naming the five documentation slots, a dated onboarding ADR, a valid VerifyContract defining the three test tiers and source-to-test mapping, an agent Dockerfile target when a Dockerfile exists, and a gap report that always includes deferred branch protection.";

type OnboardingCreateRequest = CreateWorkItemRequest & Readonly<{ taskType: "onboarding" }>;
function onboardingRequest(
  overrides: Partial<CreateWorkItemRequest> = {},
): OnboardingCreateRequest {
  return {
    originalRequest: "Onboard this project for autonomous work.",
    priority: "normal",
    ...overrides,
    taskType: "onboarding",
  };
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(stderr));
      else resolve(stdout);
    });
  });
}

async function onboardingRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steward-onboarding-intake-"));
  const repo = join(root, "repo");
  await git(root, ["init", "-b", "main", repo]);
  await writeFile(join(repo, "seed.txt"), "onboarding fixture\n", "utf8");
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "."]);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "initial"]);
  return repo;
}

function onboardingPlan(): WorkflowPlanDraft {
  return {
    objective: "Onboard the repository for autonomous work.",
    assumptions: ["The registered repository is the intended onboarding target."],
    acceptanceCriteria: [
      "The five documentation slots, onboarding ADR, VerifyContract, conditional agent target, and gap report are produced.",
    ],
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["README.md", "docs", "Dockerfile"],
    nonGoals: ["Do not configure branch protection while GitHub integration is deferred."],
    mechanicalPortions: ["Generate discoverable routes and schema documentation."],
    blockingQuestions: [],
    criterionChecks: [{
      criterion: "The repository verification contract parses.",
      check: "Run the repository's fast verification tier.",
    }],
    nodes: [{
      nodeId: "onboarding-deliverables",
      title: "Create onboarding deliverables",
      objective: "Create the documented onboarding surface and verification contract.",
      acceptanceCriteria: ["Every onboarding deliverable is present or named in the gap report."],
      dependencyNodeIds: [],
      stageTemplate: ["implementation", "testing", "verification"],
    }],
  };
}

test("onboarding intake requires an existing explicit project target", async () => {
  const fixture = await boardFixture();
  try {
    for (const [idempotencyKey, request] of [
      ["onboarding-target-missing", onboardingRequest()],
      ["onboarding-target-unknown", onboardingRequest({
        projectTarget: { mode: "explicit", projectId: "missing-project" },
      })],
    ] as const) {
      assert.throws(
        () => fixture.board.createWorkItemAndStartPlanning(request, idempotencyKey),
        (error: unknown) => error instanceof TaskBoardError
          && error.status === 400
          && error.code === "ONBOARDING_PROJECT_REQUIRED",
      );
    }

    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM work_items").get()?.count, 0);
    } finally {
      inspected.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("onboarding intake links one planning task per project and exposes onboarding on reads and claims", async () => {
  const fixture = await boardFixture();
  try {
    const repository = await onboardingRepository();
    const writable = new DatabaseSync(fixture.path);
    try {
      writable.prepare("UPDATE projects SET description=? WHERE project_id=?")
        .run(repository, fixture.project.projectId);
    } finally {
      writable.close();
    }
    const implementationType = {
      agentTypeId: "onboarding-implementation",
      name: "Onboarding implementation",
      description: "Creates the repository onboarding deliverables.",
      role: "engineer" as const,
      supplementalInstructions: "Implement the confirmed onboarding plan.",
      skillIds: [],
      evaluatorProfile: "tests" as const,
      enabled: true,
    };
    const verificationType = {
      ...implementationType,
      agentTypeId: "onboarding-verification",
      name: "Onboarding verification",
      description: "Independently verifies the onboarding deliverables.",
      role: "verifier" as const,
    };
    fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
      agentTypes: [implementationType, verificationType],
      stages: automationStages({
        implementation: { kind: "agent_type", agentTypeId: implementationType.agentTypeId },
        testing: { kind: "machine_verify" },
        verification: { kind: "agent_type", agentTypeId: verificationType.agentTypeId },
      }),
    }));
    const request = onboardingRequest({
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    });
    const created = fixture.board.createWorkItemAndStartPlanning(request, "onboarding-create-first");

    assert.equal(created.duplicate, false);
    assert.equal(created.workItem.taskType, "onboarding");
    assert.equal(fixture.board.requireWorkItem(created.workItem.workItemId).taskType, "onboarding");
    assert.equal(
      fixture.board.listWorkItems().find((item) => item.workItemId === created.workItem.workItemId)!.taskType,
      "onboarding",
    );

    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const link = inspected.prepare(`
        SELECT onboarding.project_id,onboarding.task_id,onboarding.created_at,
          task.title,task.objective,task.acceptance_criteria
        FROM work_item_onboarding_tasks onboarding
        JOIN tasks task ON task.task_id=onboarding.task_id
        WHERE onboarding.work_item_id=?
      `).get(created.workItem.workItemId);
      assert.ok(link);
      assert.equal(link.project_id, fixture.project.projectId);
      assert.equal(link.task_id, created.workItem.planningTaskId);
      assert.equal(link.title, `Plan workflow: ${request.originalRequest}`);
      assert.equal(link.objective, `Onboard project: ${fixture.project.name}`);
      assert.equal(link.acceptance_criteria, ONBOARDING_ACCEPTANCE_CRITERIA);
      assert.equal(link.created_at, "2026-07-19T20:00:00.000Z");
    } finally {
      inspected.close();
    }

    const claim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-onboarding-planning",
      messageCursor: null,
    });
    assert.ok(claim);
    assert.equal(claim.context.intake, true);
    assert.equal(claim.context.onboarding, true);

    fixture.board.settleRun(claim.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "The onboarding plan is ready for confirmation.",
      workflowPlan: onboardingPlan(),
    });
    const revision = fixture.board.projectWorkflow(fixture.project.projectId).plans
      .find((candidate) => candidate.state === "proposed");
    assert.ok(revision);
    fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
    const implementationClaim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-onboarding-implementation",
      messageCursor: null,
    });
    assert.ok(implementationClaim);
    assert.equal(implementationClaim.context.intake, false);
    assert.equal(implementationClaim.context.onboarding, true);
    assert.equal(implementationClaim.context.workflow?.stage, "implementation");
    assert.ok(implementationClaim.context.workflow?.pipeline);

    const replay = fixture.board.createWorkItemAndStartPlanning(request, "onboarding-create-first");
    assert.equal(replay.duplicate, true);
    assert.equal(replay.workItem.workItemId, created.workItem.workItemId);

    assert.throws(
      () => fixture.board.createWorkItemAndStartPlanning(request, "onboarding-create-second"),
      (error: unknown) => error instanceof TaskBoardError
        && error.status === 409
        && error.code === "ONBOARDING_EXISTS",
    );

    const afterConflict = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(afterConflict.prepare("SELECT COUNT(*) AS count FROM work_item_onboarding_tasks").get()?.count, 1);
      assert.equal(afterConflict.prepare("SELECT COUNT(*) AS count FROM work_items").get()?.count, 1);
      assert.equal(
        afterConflict.prepare("SELECT work_item_id FROM work_item_onboarding_tasks WHERE project_id=?")
          .get(fixture.project.projectId)?.work_item_id,
        created.workItem.workItemId,
      );
    } finally {
      afterConflict.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("standard intake defaults taskType and leaves onboarding linkage and claim context absent", async () => {
  const fixture = await boardFixture();
  try {
    const request = workItemRequest({
      originalRequest: "Plan a standard checkout reliability change.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    });
    const created = fixture.board.createWorkItemAndStartPlanning(request, "standard-create-default");

    assert.equal(created.workItem.taskType, "standard");
    assert.equal(fixture.board.requireWorkItem(created.workItem.workItemId).taskType, "standard");
    const claim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-standard-planning",
      messageCursor: null,
    });
    assert.ok(claim);
    assert.equal(Object.hasOwn(claim.context, "onboarding"), false);

    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM work_item_onboarding_tasks").get()?.count, 0);
      const planning = inspected.prepare(`
        SELECT task.objective,task.acceptance_criteria
        FROM work_item_planning_tasks planning
        JOIN tasks task ON task.task_id=planning.task_id
        WHERE planning.work_item_id=?
      `).get(created.workItem.workItemId);
      assert.equal(planning?.objective, request.originalRequest);
      assert.match(String(planning?.acceptance_criteria), /^Return a concise workflowPlan/u);
    } finally {
      inspected.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("standard create replay accepts a pre-v24 request hash", async () => {
  const fixture = await boardFixture();
  try {
    const request = workItemRequest({
      originalRequest: "Replay this standard request across the v24 upgrade.",
      taskType: "standard",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    });
    const idempotencyKey = "standard-create-pre-v24-hash";
    const created = fixture.board.createWorkItem(request, idempotencyKey);
    const legacyHash = sha256({
      action: "create_work_item",
      createdBy: created.workItem.createdBy,
      originalRequest: request.originalRequest,
      priority: request.priority ?? "normal",
      projectTarget: request.projectTarget,
    });
    const writable = new DatabaseSync(fixture.path);
    try {
      writable.prepare("UPDATE work_items SET request_hash=? WHERE work_item_id=?")
        .run(legacyHash, created.workItem.workItemId);
    } finally {
      writable.close();
    }

    const replay = fixture.board.createWorkItem(request, idempotencyKey);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.workItem.workItemId, created.workItem.workItemId);
  } finally {
    fixture.board.close();
  }
});

test("onboarding request hashes are distinct from the legacy-compatible standard shape", async () => {
  const fixture = await boardFixture();
  try {
    const baseRequest = {
      originalRequest: "Hash this request by onboarding intent.",
      priority: "normal" as const,
      projectTarget: { mode: "explicit" as const, projectId: fixture.project.projectId },
    };
    const standard = fixture.board.createWorkItem(
      { ...baseRequest, taskType: "standard" },
      "hash-distinction-standard",
    );
    const onboarding = fixture.board.createWorkItem(
      { ...baseRequest, taskType: "onboarding" },
      "hash-distinction-onboarding",
    );
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const standardHash = String(inspected.prepare("SELECT request_hash FROM work_items WHERE work_item_id=?")
        .get(standard.workItem.workItemId)?.request_hash);
      const onboardingHash = String(inspected.prepare("SELECT request_hash FROM work_items WHERE work_item_id=?")
        .get(onboarding.workItem.workItemId)?.request_hash);
      const legacyHash = sha256({
        action: "create_work_item",
        createdBy: standard.workItem.createdBy,
        ...baseRequest,
      });
      assert.equal(standardHash, legacyHash);
      assert.equal(onboardingHash, sha256({
        action: "create_work_item",
        createdBy: onboarding.workItem.createdBy,
        originalRequest: baseRequest.originalRequest,
        priority: baseRequest.priority,
        taskType: "onboarding",
        projectTarget: baseRequest.projectTarget,
      }));
      assert.notEqual(onboardingHash, standardHash);
    } finally {
      inspected.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("post-precheck onboarding uniqueness races return a typed conflict without SQLite text", async () => {
  const fixture = await boardFixture();
  try {
    const standard = fixture.board.createWorkItemAndStartPlanning(workItemRequest({
      originalRequest: "Provide a conflicting link row for the forced race.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }), "onboarding-race-standard");
    assert.ok(standard.workItem.planningTaskId);

    const writable = new DatabaseSync(fixture.path);
    try {
      writable.exec(`
        CREATE TRIGGER force_onboarding_unique_race
        AFTER INSERT ON work_item_onboarding_tasks
        BEGIN
          INSERT INTO work_item_onboarding_tasks(work_item_id,project_id,task_id,created_at)
          VALUES(
            '${standard.workItem.workItemId}',
            NEW.project_id,
            '${standard.workItem.planningTaskId}',
            NEW.created_at
          );
        END;
      `);
    } finally {
      writable.close();
    }

    let caught: unknown;
    try {
      fixture.board.createWorkItemAndStartPlanning(onboardingRequest({
        projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
      }), "onboarding-race-create");
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof TaskBoardError);
    assert.deepEqual({ status: caught.status, code: caught.code, message: caught.message }, {
      status: 409,
      code: "ONBOARDING_EXISTS",
      message: "This project already has an onboarding work item",
    });
    assert.doesNotMatch(String(caught), /SQLite|UNIQUE constraint failed/u);

    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM work_item_onboarding_tasks").get()?.count, 0);
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM work_items").get()?.count, 1);
    } finally {
      inspected.close();
    }
  } finally {
    fixture.board.close();
  }
});
