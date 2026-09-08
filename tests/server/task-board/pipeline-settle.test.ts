import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { StageHandoffDraft, WorkflowPlanDraft } from "#shared/task-board-contract";
import { AutomationCollaborator } from "#server/task-board/collaborators/automation";
import { ProjectsCollaborator } from "#server/task-board/collaborators/projects";
import { RunsCollaborator } from "#server/task-board/collaborators/runs";
import { TaskBoardRuntime } from "#server/task-board/collaborators/board-runtime";
import { TasksCollaborator } from "#server/task-board/collaborators/tasks";
import { registerParentTerminationCascade } from "#server/task-board/persistence/work-item-transitions";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import {
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  config,
  latestParkRecord,
  pointProjectAtRepository,
  workItemRequest,
} from "./helpers.js";

type Fixture = Awaited<ReturnType<typeof boardFixture>>;

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(stderr));
      else resolve(stdout);
    });
  });
}

async function fixtureRepo(): Promise<{ repo: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), "steward-pipeline-settle-"));
  const repo = join(root, "repo");
  await git(root, ["init", "-b", "main", repo]);
  await writeFile(join(repo, "readme.md"), "pipeline settle\n");
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "."]);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "initial"]);
  return { repo, head: (await git(repo, ["rev-parse", "HEAD"])).trim() };
}

function updateProjectPath(fixture: Fixture, repositoryPath: string): void {
  const db = new DatabaseSync(fixture.path);
  try {
    pointProjectAtRepository(db, fixture.project.projectId, repositoryPath);
  } finally {
    db.close();
  }
}

function pipelinePlan(declaredScope: readonly string[]): WorkflowPlanDraft {
  return {
    objective: "Enforce declared scope when implementation settles.",
    assumptions: ["The task branch is harvested before settlement."],
    acceptanceCriteria: ["Out-of-scope changes park the work item."],
    changeShape: "feature",
    tier: "standard",
    declaredScope,
    nonGoals: ["Do not change files outside the declared scope."],
    mechanicalPortions: [],
    blockingQuestions: [],
    criterionChecks: [],
    nodes: [
      {
        nodeId: "pipeline-scope-node",
        title: "Enforce pipeline scope",
        objective: "Check task-branch files before advancing to machine verification.",
        acceptanceCriteria: ["Only declared files advance."],
        dependencyNodeIds: [],
        stageTemplate: ["implementation", "testing", "verification"],
      },
    ],
  };
}

function handoff(outcome: "passed" | "failed", summary?: string): StageHandoffDraft {
  return {
    outcome,
    summary: summary ?? (outcome === "passed" ? "Implementation checks passed." : "Implementation stopped."),
    evidence: ["The implementation outcome was inspected."],
    artifactIds: [],
    acceptanceCriteria: [
      {
        criterion: "Only declared files advance.",
        passed: outcome === "passed",
        evidence:
          outcome === "passed" ? "The implementation reported success." : "Implementation stopped at a bright line.",
      },
    ],
    blockers: outcome === "passed" ? [] : ["A bright line blocked implementation."],
    recommendedReturnStage: outcome === "passed" ? null : "implementation",
  };
}

async function pipelineFixture(suffix: string, declaredScope = ["src/allowed"]) {
  const fixture = await boardFixture();
  const repository = await fixtureRepo();
  updateProjectPath(fixture, repository.repo);
  const implementationType = {
    agentTypeId: `pipeline-scope-${suffix}`,
    name: "Pipeline scope engineer",
    description: "Exercises implementation settlement scope enforcement.",
    role: "engineer" as const,
    supplementalInstructions: "Implement the confirmed pipeline plan.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  const verificationType = {
    ...implementationType,
    agentTypeId: `pipeline-scope-verification-${suffix}`,
    name: "Pipeline scope verification",
    description: "Independently reviews a scope-checked pipeline.",
    role: "verifier" as const,
  };
  fixture.board.updateAutomationConfiguration(
    automationConfigurationRequest({
      agentTypes: [implementationType, verificationType],
      stages: automationStages({
        implementation: { kind: "agent_type", agentTypeId: implementationType.agentTypeId },
        testing: { kind: "machine_verify" },
        verification: { kind: "agent_type", agentTypeId: verificationType.agentTypeId },
      }),
    })
  );
  const workItem = fixture.board.createWorkItemAndStartPlanning(
    workItemRequest({
      originalRequest: "Enforce pipeline scope at implementation settlement.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }),
    `pipeline-scope-${suffix}`
  ).workItem;
  const planningClaim = fixture.board.claimRun(fixture.manager.agentId, {
    claimId: `claim-pipeline-scope-planning-${suffix}`,
    messageCursor: null,
  });
  assert.ok(planningClaim);
  fixture.board.settleRun(planningClaim.run.runId, fixture.manager.agentId, {
    outcome: "completed",
    result: "The scope-enforcement plan is ready.",
    workflowPlan: pipelinePlan(declaredScope),
  });
  const revision = fixture.board
    .projectWorkflow(fixture.project.projectId)
    .plans.find((candidate) => candidate.state === "proposed");
  assert.ok(revision);
  fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
  const implementationClaim = fixture.board.claimRun(fixture.engineer.agentId, {
    claimId: `claim-pipeline-scope-implementation-${suffix}`,
    messageCursor: null,
  });
  assert.ok(implementationClaim);
  return { ...fixture, repository, workItem, revision, implementationClaim };
}

async function commitTaskFile(repo: string, branch: string, path: string): Promise<void> {
  await git(repo, ["checkout", "-b", branch]);
  const absolutePath = join(repo, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${path}\n`);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "--", path]);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", `change ${path}`]);
}

test("out-of-scope implementation commit parks the pipeline and names the file", async () => {
  const fixture = await pipelineFixture("outside");
  try {
    const branch = `task/${fixture.workItem.workItemId}`;
    await commitTaskFile(fixture.repository.repo, branch, "docs/outside.md");

    fixture.board.settleRun(fixture.implementationClaim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Implementation is complete.",
      handoff: handoff("passed"),
    });

    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "parked");
    assert.equal(
      fixture.board.requireTask(fixture.implementationClaim.task!.taskId).result,
      "scope violation: docs/outside.md"
    );
    assert.deepEqual(latestParkRecord(fixture.path, fixture.workItem.workItemId), {
      category: "scope_violation",
      reason: "scope violation: docs/outside.md",
    });
    const node = fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]!;
    assert.equal(node.state, "blocked");
    assert.equal(node.currentStage, "implementation");
  } finally {
    fixture.board.close();
  }
});

test("scope-violation parking records a failed handoff with the violation detail", async () => {
  const fixture = await pipelineFixture("outside-handoff");
  try {
    const branch = `task/${fixture.workItem.workItemId}`;
    await commitTaskFile(fixture.repository.repo, branch, "docs/outside.md");

    fixture.board.settleRun(fixture.implementationClaim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Implementation is complete.",
      handoff: handoff("passed"),
    });

    const persisted = fixture.board
      .projectWorkflow(fixture.project.projectId)
      .handoffs.find((candidate) => candidate.taskId === fixture.implementationClaim.task!.taskId);
    assert.ok(persisted);
    assert.equal(persisted.outcome, "failed");
    assert.equal(persisted.summary, "scope violation: docs/outside.md");
    assert.deepEqual(persisted.blockers, ["scope violation: docs/outside.md"]);
  } finally {
    fixture.board.close();
  }
});

test("throwing settlement Git runner fails closed and never advances", async () => {
  const fixture = await pipelineFixture("git-failure");
  fixture.board.close();
  const boardConfig = config(fixture.path);
  const store = await TaskBoardStore.open(boardConfig.dbPath);
  const runtime = new TaskBoardRuntime(boardConfig, store);
  registerParentTerminationCascade(store, () => undefined);
  const automation = new AutomationCollaborator(runtime);
  const tasks = new TasksCollaborator(runtime);
  const projects = new ProjectsCollaborator(runtime, automation, tasks);
  let gitCalls = 0;
  const runs = new RunsCollaborator(runtime, automation, projects, tasks, () => {
    gitCalls += 1;
    throw new Error("task branch was not harvested");
  });
  try {
    runs.settleRun(fixture.implementationClaim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Implementation is complete.",
      handoff: handoff("passed"),
    });

    assert.equal(gitCalls, 1);
    assert.equal(runtime.requireWorkItem(fixture.workItem.workItemId).state, "parked");
    assert.equal(runtime.requireTask(fixture.implementationClaim.task!.taskId).result, "scope check failed");
    const node = projects.projectWorkflow(fixture.project.projectId).nodes[0]!;
    assert.equal(node.state, "blocked");
    assert.equal(node.currentStage, "implementation");
    const persisted = projects
      .projectWorkflow(fixture.project.projectId)
      .handoffs.find((candidate) => candidate.taskId === fixture.implementationClaim.task!.taskId);
    assert.ok(persisted);
    assert.equal(persisted.outcome, "failed");
    assert.equal(persisted.summary, "scope check failed");
  } finally {
    runtime.close();
    store.close();
  }
});

test("failed implementation with BRIGHT_LINE detail parks instead of retrying", async () => {
  const fixture = await pipelineFixture("bright-line");
  const detail = "BRIGHT_LINE: adding the required dependency is outside the confirmed plan.";
  try {
    fixture.board.settleRun(fixture.implementationClaim.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: detail,
      handoff: handoff("failed"),
    });

    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "parked");
    assert.equal(fixture.board.requireTask(fixture.implementationClaim.task!.taskId).result, detail);
    assert.deepEqual(latestParkRecord(fixture.path, fixture.workItem.workItemId), {
      category: "bright_line",
      reason: detail,
    });
    const node = fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]!;
    assert.equal(node.state, "blocked");
    assert.equal(node.currentStage, "implementation");
  } finally {
    fixture.board.close();
  }
});

test("P6 bright-line parking delegates marked truncation to the park ledger", async () => {
  const fixture = await pipelineFixture("bright-line-truncation");
  const detail = `BRIGHT_LINE:${"b".repeat(3_000)}`;
  try {
    fixture.board.settleRun(fixture.implementationClaim.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: detail,
      handoff: handoff("failed"),
    });

    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "parked");
    assert.deepEqual(latestParkRecord(fixture.path, fixture.workItem.workItemId), {
      category: "bright_line",
      reason: `${detail.slice(0, 1_999)}…`,
    });
  } finally {
    fixture.board.close();
  }
});

test("failed implementation parks on a BRIGHT_LINE handoff summary", async () => {
  const fixture = await pipelineFixture("bright-line-handoff");
  const detail = "BRIGHT_LINE: the requested interface change is outside the confirmed plan.";
  try {
    fixture.board.settleRun(fixture.implementationClaim.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: "Implementation could not finish.",
      handoff: handoff("failed", detail),
    });

    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "parked");
    assert.equal(fixture.board.requireTask(fixture.implementationClaim.task!.taskId).result, detail);
    const node = fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]!;
    assert.equal(node.state, "blocked");
    assert.equal(node.currentStage, "implementation");
  } finally {
    fixture.board.close();
  }
});

test("a non-pipeline BRIGHT_LINE string follows the ordinary failed-stage retry path", async () => {
  const fixture = await boardFixture();
  const detail = "BRIGHT_LINE: this is ordinary non-pipeline failure text.";
  try {
    const implementationType = {
      agentTypeId: "non-pipeline-bright-line-engineer",
      name: "Non-pipeline engineer",
      description: "Exercises ordinary workflow retry behavior.",
      role: "engineer" as const,
      supplementalInstructions: "Follow the ordinary workflow contract.",
      skillIds: [],
      evaluatorProfile: "tests" as const,
      enabled: true,
    };
    fixture.board.updateAutomationConfiguration(
      automationConfigurationRequest({
        agentTypes: [implementationType],
        stages: automationStages({
          implementation: { kind: "agent_type", agentTypeId: implementationType.agentTypeId },
        }),
      })
    );
    const workItem = fixture.board.createWorkItem(
      workItemRequest({
        originalRequest: "Retry a non-pipeline implementation failure.",
        projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
      }),
      "non-pipeline-bright-line"
    ).workItem;
    const proposed = fixture.board.proposeWorkflow({
      workItemId: workItem.workItemId,
      projectId: fixture.project.projectId,
      objective: "Exercise ordinary retry semantics.",
      assumptions: [],
      acceptanceCriteria: ["The work item remains live after its first failure."],
      skillIds: [],
      nodes: [
        {
          nodeId: "non-pipeline-bright-line-node",
          title: "Retry ordinary implementation",
          objective: "Return the failed stage to implementation.",
          acceptanceCriteria: ["The first failure does not park the work item."],
          dependencyNodeIds: [],
          stageTemplate: ["implementation", "verification"],
        },
      ],
    });
    fixture.board.confirmWorkflow(proposed.plans[0]!.planRevisionId, { expectedState: "proposed" });
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-non-pipeline-bright-line",
      messageCursor: null,
    });
    assert.ok(claim);

    fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: detail,
      handoff: {
        outcome: "failed",
        summary: detail,
        evidence: [],
        artifactIds: [],
        acceptanceCriteria: [],
        blockers: [detail],
        recommendedReturnStage: "implementation",
      },
    });

    const current = fixture.board.requireWorkItem(workItem.workItemId);
    assert.equal(current.pipelineBranch, null);
    assert.equal(current.state, "implementing");
    assert.equal(current.currentStage, "implementation");
    assert.notEqual(fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]?.state, "blocked");
  } finally {
    fixture.board.close();
  }
});

test("in-scope implementation commit advances to machine testing", async () => {
  const fixture = await pipelineFixture("inside");
  try {
    const branch = `task/${fixture.workItem.workItemId}`;
    await commitTaskFile(fixture.repository.repo, branch, "src/allowed/change.ts");

    fixture.board.settleRun(fixture.implementationClaim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Implementation is complete.",
      handoff: handoff("passed"),
    });

    const workItem = fixture.board.requireWorkItem(fixture.workItem.workItemId);
    assert.notEqual(workItem.state, "parked");
    assert.equal(workItem.currentStage, "testing");
    const node = fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]!;
    assert.equal(node.currentStage, "testing");
  } finally {
    fixture.board.close();
  }
});

test("planning settlements reject review findings", async () => {
  const fixture = await boardFixture();
  try {
    const workItem = fixture.board.createWorkItemAndStartPlanning(
      workItemRequest({
        originalRequest: "Reject findings from a planning settlement.",
        projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
      }),
      "planning-review-findings"
    ).workItem;
    const planning = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-planning-review-findings",
      messageCursor: null,
    });
    assert.ok(planning);

    assert.throws(
      () =>
        fixture.board.settleRun(planning.run.runId, fixture.manager.agentId, {
          outcome: "completed",
          result: "The plan is ready.",
          workflowPlan: pipelinePlan(["src"]),
          reviewFindings: [
            {
              category: "correctness",
              severity: "major",
              expected: "Findings are emitted only by the reviewer.",
              actual: "The planner attempted to emit a finding.",
            },
          ],
        }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "TASK_BOARD_REVIEW_FINDINGS_NOT_ALLOWED"
    );
    assert.equal(fixture.board.requireWorkItem(workItem.workItemId).state, "planning");
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT status FROM runs WHERE run_id=?").get(planning.run.runId)?.status, "active");
    } finally {
      db.close();
    }
  } finally {
    fixture.board.close();
  }
});
