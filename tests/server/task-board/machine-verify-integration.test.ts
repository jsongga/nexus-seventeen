import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
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

async function fixtureRepo(verifyPasses: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steward-machine-verify-"));
  const repo = join(root, "repo");
  await git(root, ["init", "-b", "main", repo]);
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(repo, "readme.md"), "machine verify integration\n");
  await writeFile(
    join(repo, "docs", "workflow.md"),
    `# Verify workflow\n\n\`\`\`json\n${JSON.stringify({
      version: 1,
      compile: ["node verify-compile.mjs"],
      rules: [{ match: "**", action: { kind: "none" } }],
      full: ["node verify-full.mjs"],
    }, null, 2)}\n\`\`\`\n`,
  );
  await writeFile(
    join(repo, "verify-full.mjs"),
    verifyPasses
      ? 'process.stdout.write("full verify passed\\n");\n'
      : 'process.stderr.write("intentional machine verify failure\\n"); process.exit(9);\n',
  );
  await writeFile(join(repo, "verify-compile.mjs"), "process.exit(0);\n");
  await writeFile(join(repo, "criterion-check.mjs"), "process.exit(0);\n");
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "."]);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "initial"]);
  return repo;
}

function updateProjectPath(fixture: Fixture, repositoryPath: string): void {
  const db = new DatabaseSync(fixture.path);
  try {
    db.prepare("UPDATE projects SET description=? WHERE project_id=?")
      .run(repositoryPath, fixture.project.projectId);
  } finally {
    db.close();
  }
}

function pipelinePlan(): WorkflowPlanDraft {
  return {
    objective: "Exercise the machine verify executor.",
    assumptions: [],
    acceptanceCriteria: ["The pipeline reaches its expected verify outcome."],
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["src"],
    nonGoals: [],
    mechanicalPortions: [],
    blockingQuestions: [],
    criterionChecks: [{ criterion: "The criterion check passes.", check: "node criterion-check.mjs" }],
    nodes: [{
      nodeId: "machine-verify-node",
      title: "Exercise machine verify",
      objective: "Implement a scoped change and verify it without an agent executor.",
      acceptanceCriteria: ["The machine verify result is durably settled."],
      dependencyNodeIds: [],
      stageTemplate: ["implementation", "testing"],
    }],
  };
}

function implementationHandoff(): StageHandoffDraft {
  return {
    outcome: "passed",
    summary: "The scoped implementation is ready for machine verification.",
    evidence: ["The task branch contains the scoped commit."],
    artifactIds: [],
    acceptanceCriteria: [{
      criterion: "The implementation is committed.",
      passed: true,
      evidence: "The task branch contains the implementation commit.",
    }],
    blockers: [],
    recommendedReturnStage: null,
  };
}

async function pipelineFixture(suffix: string, verifyPasses: boolean) {
  const fixture = await boardFixture();
  const repo = await fixtureRepo(verifyPasses);
  updateProjectPath(fixture, repo);
  const implementationType = {
    agentTypeId: `machine-verify-engineer-${suffix}`,
    name: "Machine verify engineer",
    description: "Prepares implementation rounds for the machine verifier.",
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
    originalRequest: "Exercise machine verification.",
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), `machine-verify-integration-${suffix}`).workItem;
  const planning = fixture.board.claimRun(fixture.manager.agentId, {
    claimId: `claim-machine-verify-planning-${suffix}`,
    messageCursor: null,
  });
  assert.ok(planning);
  fixture.board.settleRun(planning.run.runId, fixture.manager.agentId, {
    outcome: "completed",
    result: "The machine verify plan is ready.",
    workflowPlan: pipelinePlan(),
  });
  const revision = fixture.board.projectWorkflow(fixture.project.projectId).plans.find(
    (candidate) => candidate.state === "proposed",
  );
  assert.ok(revision);
  fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
  const implementation = fixture.board.claimRun(fixture.engineer.agentId, {
    claimId: `claim-machine-verify-implementation-${suffix}-1`,
    messageCursor: null,
  });
  assert.ok(implementation);
  const branch = `task/${workItem.workItemId}`;
  await git(repo, ["checkout", "-b", branch]);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "change.txt"), "scoped pipeline change\n");
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "src/change.txt"]);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "scoped change"]);
  return { ...fixture, repo, workItem, implementation };
}

function terminalAttemptCount(path: string): number {
  const db = new DatabaseSync(path);
  try {
    return Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM verify_attempts
      WHERE state IN ('green','failed','died')
    `).get()?.count);
  } finally {
    db.close();
  }
}

async function driveVerify(
  fixture: Awaited<ReturnType<typeof pipelineFixture>>,
  expectedState: "implementing" | "final_approval" | "dead_letter",
  expectedTerminalAttempts: number,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await fixture.board.sweepVerifyAttempts();
    if (
      fixture.board.requireWorkItem(fixture.workItem.workItemId).state === expectedState &&
      terminalAttemptCount(fixture.path) === expectedTerminalAttempts
    ) return;
    await delay(25);
  }
  assert.fail(
    `verify sweep did not reach ${expectedState}; current=${fixture.board.requireWorkItem(fixture.workItem.workItemId).state}`,
  );
}

test("pipeline activation and the public sweep settle machine verify green into final approval", async () => {
  const fixture = await pipelineFixture("green", true);
  try {
    fixture.board.settleRun(fixture.implementation.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Implementation complete.",
      handoff: implementationHandoff(),
    });
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "verifying");

    await driveVerify(fixture, "final_approval", 1);

    const workflow = fixture.board.projectWorkflow(fixture.project.projectId);
    assert.equal(workflow.nodes[0]?.state, "completed");
    const machineHandoff = workflow.handoffs.find((handoff) => handoff.stage === "testing");
    assert.ok(machineHandoff);
    assert.equal(machineHandoff.outcome, "passed");
    assert.deepEqual(machineHandoff.acceptanceCriteria, [{
      criterion: "The criterion check passes.",
      passed: true,
      evidence: "Passed: node criterion-check.mjs",
    }]);
    const db = new DatabaseSync(fixture.path);
    try {
      const attempt = db.prepare("SELECT state,check_results_json FROM verify_attempts").get();
      assert.equal(attempt?.state, "green");
      assert.deepEqual(JSON.parse(String(attempt?.check_results_json)), [{
        criterion: "The criterion check passes.",
        check: "node criterion-check.mjs",
        passed: true,
      }]);
      const author = db.prepare(`
        SELECT event.actor_id
        FROM stage_handoffs handoff
        JOIN task_events event ON event.task_id=handoff.task_id
        WHERE handoff.stage='testing' AND event.event_type='task_created'
      `).get();
      assert.equal(author?.actor_id, "system:machine-verify");
    } finally {
      db.close();
    }
    await assert.rejects(access(join(dirname(fixture.path), "verify-workspaces", `${fixture.workItem.workItemId}-verify`)));
  } finally {
    fixture.board.close();
  }
});

test("a retried pipeline implementation claim includes the latest failed machine-verify handoff", async () => {
  const fixture = await pipelineFixture("retry-context", false);
  try {
    fixture.board.settleRun(fixture.implementation.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Implementation round one complete.",
      handoff: implementationHandoff(),
    });
    await driveVerify(fixture, "implementing", 1);

    const retry = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-machine-verify-retry-context-2",
      messageCursor: null,
    });

    assert.ok(retry);
    const handoffs = retry.context.workflow?.dependencyHandoffs;
    assert.ok(handoffs);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0]?.stage, "testing");
    assert.equal(handoffs[0]?.outcome, "failed");
    assert.match(handoffs[0]?.summary ?? "", /intentional machine verify failure/u);
    assert.match(handoffs[0]?.evidence.join("\n") ?? "", /intentional machine verify failure/u);
  } finally {
    fixture.board.close();
  }
});

test("machine verify failures return to implementation with tail evidence and dead-letter on round three", async () => {
  const fixture = await pipelineFixture("failed", false);
  try {
    let implementation = fixture.implementation;
    for (let round = 1; round <= 3; round += 1) {
      fixture.board.settleRun(implementation.run.runId, fixture.engineer.agentId, {
        outcome: "completed",
        result: `Implementation round ${round} complete.`,
        handoff: implementationHandoff(),
      });
      await driveVerify(fixture, round < 3 ? "implementing" : "dead_letter", round);
      const testingHandoffs = fixture.board.projectWorkflow(fixture.project.projectId).handoffs.filter(
        (handoff) => handoff.stage === "testing",
      );
      assert.equal(testingHandoffs.length, round);
      assert.match(testingHandoffs.at(-1)?.summary ?? "", /intentional machine verify failure/u);
      if (round < 3) {
        const next = fixture.board.claimRun(fixture.engineer.agentId, {
          claimId: `claim-machine-verify-implementation-failed-${round + 1}`,
          messageCursor: null,
        });
        assert.ok(next);
        implementation = next;
      }
    }
    assert.equal(fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]?.state, "blocked");
  } finally {
    fixture.board.close();
  }
});
