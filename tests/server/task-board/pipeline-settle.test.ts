import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { StageHandoffDraft, WorkflowPlanDraft } from "#shared/task-board-contract";
import {
  automationConfigurationRequest,
  automationStages,
  boardFixture,
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
    db.prepare("UPDATE projects SET description=? WHERE project_id=?").run(repositoryPath, fixture.project.projectId);
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
    nodes: [{
      nodeId: "pipeline-scope-node",
      title: "Enforce pipeline scope",
      objective: "Check task-branch files before advancing to machine verification.",
      acceptanceCriteria: ["Only declared files advance."],
      dependencyNodeIds: [],
      stageTemplate: ["implementation", "testing"],
    }],
  };
}

function handoff(outcome: "passed" | "failed", summary?: string): StageHandoffDraft {
  return {
    outcome,
    summary: summary ?? (outcome === "passed" ? "Implementation checks passed." : "Implementation stopped."),
    evidence: ["The implementation outcome was inspected."],
    artifactIds: [],
    acceptanceCriteria: [{
      criterion: "Only declared files advance.",
      passed: outcome === "passed",
      evidence: outcome === "passed" ? "The implementation reported success." : "Implementation stopped at a bright line.",
    }],
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
  fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
    agentTypes: [implementationType],
    stages: automationStages({
      implementation: { kind: "agent_type", agentTypeId: implementationType.agentTypeId },
      testing: { kind: "machine_verify" },
    }),
  }));
  const workItem = fixture.board.createWorkItemAndStartPlanning(workItemRequest({
    originalRequest: "Enforce pipeline scope at implementation settlement.",
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), `pipeline-scope-${suffix}`).workItem;
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
  const revision = fixture.board.projectWorkflow(fixture.project.projectId).plans.find((candidate) => candidate.state === "proposed");
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
    assert.equal(fixture.board.requireTask(fixture.implementationClaim.task!.taskId).result, "scope violation: docs/outside.md");
    const node = fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]!;
    assert.equal(node.state, "blocked");
    assert.equal(node.currentStage, "implementation");
  } finally {
    fixture.board.close();
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
    const node = fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]!;
    assert.equal(node.state, "blocked");
    assert.equal(node.currentStage, "implementation");
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
