import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { WorkflowPlanDraft } from "#shared/task-board-contract";
import type { GitRunner } from "#server/task-board/collaborators/scope-check";
import {
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  latestParkRecord,
  workItemRequest,
} from "../helpers.js";

const BASE_SHA = "a".repeat(40);
const ADVANCED_SHA = "b".repeat(40);
const NOW = "2026-08-21T16:00:00.000Z";

interface FakeGitControl {
  branch: string;
  dirty: string;
  head: string;
  ancestor: boolean;
  commands: string[][];
}

function fakeGit(control: FakeGitControl): GitRunner {
  return (arguments_) => {
    const repoIndex = arguments_.indexOf("-C");
    const command = [...arguments_.slice(repoIndex + 2)];
    control.commands.push(command);
    if (command.join(" ") === "rev-parse --abbrev-ref HEAD") return `${control.branch}\n`;
    if (command.join(" ") === "status --porcelain -z") return control.dirty;
    if (command.join(" ") === "rev-parse HEAD") return `${control.head}\n`;
    if (command[0] === "merge-base" && command[1] === "--is-ancestor") {
      if (control.ancestor) return "";
      throw Object.assign(new Error("not an ancestor"), { status: 1 });
    }
    throw new Error(`unexpected git command: ${command.join(" ")}`);
  };
}

function pipelinePlan(suffix: string): WorkflowPlanDraft {
  return {
    objective: `Exercise base-branch polling ${suffix}.`,
    assumptions: ["The repository remains available."],
    acceptanceCriteria: ["The base branch is re-anchored before merge."],
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["src/allowed"],
    nonGoals: ["Do not push a remote branch."],
    mechanicalPortions: ["Update one fixture file."],
    blockingQuestions: [],
    criterionChecks: [{
      criterion: "The base branch is re-anchored before merge.",
      check: "node check.mjs",
    }],
    nodes: [{
      nodeId: `base-poll-${suffix}`,
      title: `Base poll ${suffix}`,
      objective: "Return stale approval to implementation.",
      acceptanceCriteria: ["The task branch composes with the new base."],
      dependencyNodeIds: [],
      stageTemplate: ["implementation", "testing", "verification"],
    }],
  };
}

async function finalApprovalFixture(suffix: string) {
  const control: FakeGitControl = {
    branch: "main",
    dirty: "",
    head: BASE_SHA,
    ancestor: true,
    commands: [],
  };
  const fixture = await boardFixture(undefined, () => new Date(NOW), { git: fakeGit(control) });
  const db = new DatabaseSync(fixture.path);
  try {
    db.prepare("UPDATE projects SET repo_path=? WHERE project_id=?")
      .run(`/fixture/${suffix}`, fixture.project.projectId);
  } finally {
    db.close();
  }
  const implementation = {
    agentTypeId: `base-poll-engineer-${suffix}`,
    name: "Base poll engineer",
    description: "Rebases a withdrawn final approval.",
    role: "engineer" as const,
    supplementalInstructions: "Rebase onto the current base branch.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  const verification = {
    ...implementation,
    agentTypeId: `base-poll-verifier-${suffix}`,
    name: "Base poll verifier",
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
  const workItem = fixture.board.createWorkItem(workItemRequest({
    originalRequest: `Poll the base branch for ${suffix}.`,
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), `base-poll-${suffix}`).workItem;
  const proposed = fixture.board.proposeWorkflow({
    ...pipelinePlan(suffix),
    workItemId: workItem.workItemId,
    projectId: fixture.project.projectId,
    skillIds: [],
  });
  fixture.board.confirmWorkflow(proposed.plans[0]!.planRevisionId, { expectedState: "proposed" });

  const seeded = new DatabaseSync(fixture.path);
  try {
    seeded.prepare(`
      UPDATE tasks
      SET status='completed',started_at=?,ended_at=?,result='Ready for approval',version=version+1,updated_at=?
      WHERE task_id IN (
        SELECT attempt.task_id
        FROM stage_attempts attempt
        JOIN work_nodes node ON node.node_id=attempt.node_id
        JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
        WHERE plan.work_item_id=?
      )
    `).run(NOW, NOW, NOW, workItem.workItemId);
    seeded.prepare(`
      UPDATE work_nodes
      SET state='completed',current_stage=NULL,version=version+1,updated_at=?
      WHERE plan_revision_id=?
    `).run(NOW, proposed.plans[0]!.planRevisionId);
    seeded.prepare(`
      UPDATE work_items
      SET state='final_approval',current_stage=NULL,version=version+1,updated_at=?
      WHERE work_item_id=?
    `).run(NOW, workItem.workItemId);
  } finally {
    seeded.close();
  }
  control.commands.length = 0;
  return { ...fixture, control, workItemId: workItem.workItemId };
}

test("an unchanged base sha is a no-op", async () => {
  const fixture = await finalApprovalFixture("equal");
  try {
    assert.deepEqual(fixture.board.sweepBaseBranch(NOW), { withdrawn: 0, diverged: 0 });
    assert.equal(fixture.board.requireWorkItem(fixture.workItemId).state, "final_approval");
    assert.equal(
      fixture.control.commands.some((command) => command[0] === "merge-base"),
      false,
    );
  } finally {
    fixture.board.close();
  }
});

test("an advanced base withdraws final approval once with system attribution", async () => {
  const fixture = await finalApprovalFixture("advanced");
  try {
    fixture.control.head = ADVANCED_SHA;
    assert.deepEqual(fixture.board.sweepBaseBranch(NOW), { withdrawn: 1, diverged: 0 });
    assert.deepEqual(fixture.board.sweepBaseBranch(NOW), { withdrawn: 0, diverged: 0 });

    const item = fixture.board.requireWorkItem(fixture.workItemId);
    assert.equal(item.state, "implementing");
    assert.equal(item.currentStage, "implementation");
    assert.equal(item.baseSha, ADVANCED_SHA);
    const note = `base branch advanced to ${ADVANCED_SHA}; rebase onto it and re-verify`;
    const database = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const transition = database.prepare(`
        SELECT actor_type,actor_id
        FROM work_item_transitions
        WHERE work_item_id=?
        ORDER BY sequence DESC
        LIMIT 1
      `).get(fixture.workItemId);
      assert.deepEqual({ ...transition }, {
        actor_type: "system",
        actor_id: "system:base-branch-poll",
      });
      const event = database.prepare(`
        SELECT actor_type,actor_id
        FROM task_events
        WHERE json_extract(data_json,'$.workItemId')=?
        ORDER BY created_at DESC,rowid DESC
        LIMIT 1
      `).get(fixture.workItemId);
      assert.deepEqual({ ...event }, {
        actor_type: "system",
        actor_id: "system:base-branch-poll",
      });
      const handoff = database.prepare(`
        SELECT handoff.payload_json
        FROM stage_handoffs handoff
        JOIN work_nodes node ON node.node_id=handoff.node_id
        JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
        WHERE plan.work_item_id=?
        ORDER BY handoff.created_at DESC,handoff.rowid DESC
        LIMIT 1
      `).get(fixture.workItemId);
      assert.equal(JSON.parse(String(handoff?.payload_json)).summary, note);
    } finally {
      database.close();
    }
    assert.deepEqual(fixture.board.listNotifications().unread.map((notification) => ({
      kind: notification.kind,
      dedupeKey: notification.dedupeKey,
      summary: notification.summary,
    })), [{
      kind: "final_approval_withdrawn",
      dedupeKey: `final_approval_withdrawn:${fixture.workItemId}:${ADVANCED_SHA}`,
      summary: `Final approval withdrawn: base branch advanced to ${ADVANCED_SHA.slice(0, 10)}`,
    }]);
  } finally {
    fixture.board.close();
  }
});

test("detached, task-branch, and dirty merge targets are no-ops", async (t) => {
  for (const candidate of [
    { name: "detached", branch: "HEAD", dirty: "" },
    { name: "item task branch", branch: "item", dirty: "" },
    { name: "another task branch", branch: "task/operator-work", dirty: "" },
    { name: "dirty", branch: "main", dirty: " M operator-notes.txt\0" },
  ]) {
    await t.test(candidate.name, async () => {
      const fixture = await finalApprovalFixture(candidate.name.replaceAll(" ", "-"));
      try {
        fixture.control.head = ADVANCED_SHA;
        fixture.control.branch = candidate.branch === "item"
          ? fixture.board.requireWorkItem(fixture.workItemId).pipelineBranch!
          : candidate.branch;
        fixture.control.dirty = candidate.dirty;
        assert.deepEqual(fixture.board.sweepBaseBranch(NOW), { withdrawn: 0, diverged: 0 });
        assert.equal(fixture.board.requireWorkItem(fixture.workItemId).state, "final_approval");
        assert.equal(
          fixture.control.commands.some((command) => command.join(" ") === "rev-parse HEAD"),
          false,
        );
      } finally {
        fixture.board.close();
      }
    });
  }
});

test("rewritten base history parks the item as base_diverged", async () => {
  const fixture = await finalApprovalFixture("rewritten");
  try {
    fixture.control.head = ADVANCED_SHA;
    fixture.control.ancestor = false;
    assert.deepEqual(fixture.board.sweepBaseBranch(NOW), { withdrawn: 0, diverged: 1 });
    assert.equal(fixture.board.requireWorkItem(fixture.workItemId).state, "parked");
    assert.deepEqual(latestParkRecord(fixture.path, fixture.workItemId), {
      category: "base_diverged",
      reason: `base branch history rewritten (was ${BASE_SHA}, now ${ADVANCED_SHA})`,
    });
    const database = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const transition = database.prepare(`
        SELECT actor_type,actor_id
        FROM work_item_transitions
        WHERE work_item_id=?
        ORDER BY sequence DESC
        LIMIT 1
      `).get(fixture.workItemId);
      assert.deepEqual({ ...transition }, {
        actor_type: "system",
        actor_id: "system:base-branch-poll",
      });
    } finally {
      database.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("a per-item git failure is logged and does not escape the sweep", async (t) => {
  const fixture = await finalApprovalFixture("git-failure");
  const logged = t.mock.method(console, "error", () => undefined);
  try {
    fixture.control.head = "invalid-head";
    assert.deepEqual(fixture.board.sweepBaseBranch(NOW), { withdrawn: 0, diverged: 0 });
    assert.equal(fixture.board.requireWorkItem(fixture.workItemId).state, "final_approval");
    assert.equal(logged.mock.callCount(), 1);
    assert.equal(
      logged.mock.calls[0]?.arguments[0],
      `[task-board] base-branch sweep failed for work item ${fixture.workItemId}`,
    );
  } finally {
    fixture.board.close();
  }
});

function fixtureGit(repo: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function integrationRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steward-base-branch-integration-"));
  const repo = join(root, "repo");
  fixtureGit(root, "init", "-b", "main", repo);
  fixtureGit(repo, "config", "user.name", "Base Poll Test");
  fixtureGit(repo, "config", "user.email", "base-poll@test.invalid");
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(repo, "shared.txt"), "fixture base\n");
  await writeFile(
    join(repo, "docs", "workflow.md"),
    `# Verify workflow\n\n\`\`\`json\n${JSON.stringify({
      version: 1,
      compile: ["node check.mjs"],
      rules: [{ match: "**", action: { kind: "none" } }],
      full: ["node verify-full.mjs"],
    }, null, 2)}\n\`\`\`\n`,
  );
  await writeFile(join(repo, "check.mjs"), "process.exit(0);\n");
  await writeFile(join(repo, "verify-full.mjs"), "process.exit(0);\n");
  fixtureGit(repo, "add", ".");
  fixtureGit(repo, "commit", "-m", "fixture base");
  return repo;
}

async function waitForState(
  board: Awaited<ReturnType<typeof boardFixture>>["board"],
  workItemId: string,
  state: "reviewing",
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await board.sweepVerifyAttempts();
    if (board.requireWorkItem(workItemId).state === state) return;
    await delay(25);
  }
  assert.fail(`work item did not reach ${state}: ${board.requireWorkItem(workItemId).state}`);
}

const passedHandoff = {
  outcome: "passed" as const,
  summary: "The pipeline stage passed.",
  evidence: ["The fixture change is committed."],
  artifactIds: [],
  acceptanceCriteria: [],
  blockers: [],
  recommendedReturnStage: null,
};

test("a fixture pipeline rebases after withdrawal and merges both the base and task changes", async () => {
  const repo = await integrationRepository();
  const fixture = await boardFixture(undefined, () => new Date(NOW));
  try {
    const database = new DatabaseSync(fixture.path);
    try {
      database.prepare("UPDATE projects SET repo_path=? WHERE project_id=?")
        .run(repo, fixture.project.projectId);
    } finally {
      database.close();
    }
    const verifier = fixture.board.createAgent(fixture.project.projectId, {
      agentId: "base-poll-integration-verifier",
      role: "verifier",
      area: "base polling",
      mission: "Review the rebased fixture pipeline.",
      model: "codex-mini",
      token: "base-poll-integration-verifier-token-0123456789",
    });
    const implementation = {
      agentTypeId: "base-poll-integration-engineer",
      name: "Base poll integration engineer",
      description: "Implements and rebases the fixture branch.",
      role: "engineer" as const,
      supplementalInstructions: "Rebase when final approval is withdrawn.",
      skillIds: [],
      evaluatorProfile: "tests" as const,
      enabled: true,
    };
    const verification = {
      ...implementation,
      agentTypeId: "base-poll-integration-verifier",
      name: "Base poll integration verifier",
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
    const workItem = fixture.board.createWorkItem(workItemRequest({
      originalRequest: "Compose a pipeline branch with a newly advanced base.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }), "base-poll-integration").workItem;
    const proposed = fixture.board.proposeWorkflow({
      ...pipelinePlan("integration"),
      workItemId: workItem.workItemId,
      projectId: fixture.project.projectId,
      skillIds: [],
    });
    fixture.board.confirmWorkflow(proposed.plans[0]!.planRevisionId, { expectedState: "proposed" });

    const taskBranch = `task/${workItem.workItemId}`;
    fixtureGit(repo, "switch", "-c", taskBranch);
    await mkdir(join(repo, "src", "allowed"), { recursive: true });
    await writeFile(join(repo, "src", "allowed", "task.txt"), "task change\n");
    fixtureGit(repo, "add", "src/allowed/task.txt");
    fixtureGit(repo, "commit", "-m", "task change");
    const firstImplementation = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "base-poll-integration-implementation-1",
      messageCursor: null,
    });
    assert.ok(firstImplementation);
    fixture.board.settleRun(firstImplementation.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Initial task implementation completed.",
      handoff: passedHandoff,
    });
    await waitForState(fixture.board, workItem.workItemId, "reviewing");
    const firstReview = fixture.board.claimRun(verifier.agentId, {
      claimId: "base-poll-integration-review-1",
      messageCursor: null,
    });
    assert.ok(firstReview);
    fixture.board.settleRun(firstReview.run.runId, verifier.agentId, {
      outcome: "completed",
      result: "Initial independent review passed.",
      handoff: passedHandoff,
      reviewFindings: [],
    });
    assert.equal(fixture.board.requireWorkItem(workItem.workItemId).state, "final_approval");

    fixtureGit(repo, "switch", "main");
    await writeFile(join(repo, "base-change.txt"), "base change\n");
    fixtureGit(repo, "add", "base-change.txt");
    fixtureGit(repo, "commit", "-m", "advance base");
    const advancedHead = fixtureGit(repo, "rev-parse", "HEAD").trim();
    assert.deepEqual(fixture.board.sweepBaseBranch(NOW), { withdrawn: 1, diverged: 0 });
    assert.equal(fixture.board.requireWorkItem(workItem.workItemId).baseSha, advancedHead);

    const secondImplementation = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "base-poll-integration-implementation-2",
      messageCursor: null,
    });
    assert.ok(secondImplementation);
    assert.equal(
      secondImplementation.context.workflow?.dependencyHandoffs.at(-1)?.summary,
      `base branch advanced to ${advancedHead}; rebase onto it and re-verify`,
    );
    fixtureGit(repo, "switch", taskBranch);
    fixtureGit(repo, "merge", "main");
    await writeFile(join(repo, "src", "allowed", "reanchored.txt"), "re-anchored\n");
    fixtureGit(repo, "add", "src/allowed/reanchored.txt");
    fixtureGit(repo, "commit", "-m", "re-anchor task branch");
    fixture.board.settleRun(secondImplementation.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "The engineer rebased onto the advanced base.",
      handoff: passedHandoff,
    });
    await waitForState(fixture.board, workItem.workItemId, "reviewing");
    const secondReview = fixture.board.claimRun(verifier.agentId, {
      claimId: "base-poll-integration-review-2",
      messageCursor: null,
    });
    assert.ok(secondReview);
    fixture.board.settleRun(secondReview.run.runId, verifier.agentId, {
      outcome: "completed",
      result: "The rebased pipeline passed independent review.",
      handoff: passedHandoff,
      reviewFindings: [],
    });
    const finalApproval = fixture.board.requireWorkItem(workItem.workItemId);
    assert.equal(finalApproval.state, "final_approval");

    fixtureGit(repo, "switch", "main");
    assert.equal(
      (await fixture.board.approvePipelineMerge(workItem.workItemId, { version: finalApproval.version })).state,
      "merged",
    );
    fixtureGit(repo, "merge-base", "--is-ancestor", advancedHead, "main");
    assert.equal(await readFile(join(repo, "base-change.txt"), "utf8"), "base change\n");
    assert.equal(await readFile(join(repo, "src", "allowed", "task.txt"), "utf8"), "task change\n");
    assert.equal(await readFile(join(repo, "src", "allowed", "reanchored.txt"), "utf8"), "re-anchored\n");
  } finally {
    fixture.board.close();
  }
});
