import assert from "node:assert/strict";
import { BOARD_COMMITTER_EMAIL, BOARD_COMMITTER_NAME } from "#server/shared/git";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { WorkflowPlanDraft } from "#shared/task-board-contract";
import { HttpTaskBoardClient } from "#server/agents/task-worker";
import { TaskBoardError } from "#server/task-board";
import { SkillRegistry } from "#server/task-board/skills";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import { TransparentWorkflow } from "#server/task-board/persistence/workflow";
import {
  registerParentTerminationCascade,
  registerWorkItemTransitionStore,
} from "#server/task-board/persistence/work-item-transitions";
import {
  AGENT_ONE_TOKEN,
  automationConfigurationRequest,
  automationStages,
  boardFixture,
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
  const root = await mkdtemp(join(tmpdir(), "steward-pipeline-repo-"));
  const repo = join(root, "repo");
  await git(root, ["init", "-b", "main", repo]);
  await writeFile(join(repo, "readme.md"), "pipeline\n");
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

function pipelinePlan(tier: "standard" | "hazardous" = "standard"): WorkflowPlanDraft {
  return {
    objective: "Implement the pipeline branch identity.",
    assumptions: ["The registered repository remains on its default branch."],
    acceptanceCriteria: ["Every pipeline stage shares one task branch."],
    changeShape: "feature",
    tier,
    declaredScope: ["src/server", "tests/server"],
    nonGoals: ["Do not push the branch."],
    mechanicalPortions: ["Propagate the confirmed branch metadata."],
    blockingQuestions: [],
    criterionChecks: [
      {
        criterion: "The runtime suite passes.",
        check: "npm run test:runtime",
      },
    ],
    nodes: [
      {
        nodeId: `pipeline-${tier}`,
        title: "Implement pipeline identity",
        objective: "Carry one branch through each pipeline stage.",
        acceptanceCriteria: ["The claim contains the confirmed pipeline metadata."],
        dependencyNodeIds: [],
        stageTemplate: ["implementation", "testing", "verification"],
      },
    ],
  };
}

function preparePipeline(fixture: Fixture, suffix: string, plan = pipelinePlan()) {
  const implementationType = {
    agentTypeId: `pipeline-implementation-${suffix}`,
    name: "Pipeline implementation",
    description: "Executes a confirmed pipeline implementation stage.",
    role: "engineer" as const,
    supplementalInstructions: "Implement only the confirmed pipeline plan.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  const verificationType = {
    ...implementationType,
    agentTypeId: `pipeline-verification-${suffix}`,
    name: "Pipeline verification",
    description: "Independently reviews the confirmed pipeline implementation.",
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
      originalRequest: "Give pipeline stages one durable task branch.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }),
    `pipeline-identity-${suffix}`
  ).workItem;
  const planningClaim = fixture.board.claimRun(fixture.manager.agentId, {
    claimId: `claim-pipeline-planning-${suffix}`,
    messageCursor: null,
  });
  assert.ok(planningClaim);
  fixture.board.settleRun(planningClaim.run.runId, fixture.manager.agentId, {
    outcome: "completed",
    result: "The pipeline plan is ready for confirmation.",
    workflowPlan: plan,
  });
  const revision = fixture.board
    .projectWorkflow(fixture.project.projectId)
    .plans.find((candidate) => candidate.state === "proposed");
  assert.ok(revision);
  return { workItem, revision };
}

function prepareNonPipeline(fixture: Fixture, suffix: string) {
  const researchType = {
    agentTypeId: `workflow-research-${suffix}`,
    name: "Workflow research",
    description: "Executes an ordinary confirmed research stage.",
    role: "engineer" as const,
    supplementalInstructions: "Verify only the confirmed workflow.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  const verificationType = {
    ...researchType,
    agentTypeId: `workflow-verification-${suffix}`,
    name: "Workflow verification",
    description: "Executes the terminal ordinary verification stage.",
    role: "verifier" as const,
  };
  fixture.board.updateAutomationConfiguration(
    automationConfigurationRequest({
      agentTypes: [researchType, verificationType],
      stages: automationStages({
        research: { kind: "agent_type", agentTypeId: researchType.agentTypeId },
        verification: { kind: "agent_type", agentTypeId: verificationType.agentTypeId },
      }),
    })
  );
  const workItem = fixture.board.createWorkItemAndStartPlanning(
    workItemRequest({
      originalRequest: "Verify an ordinary workflow without pipeline identity.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }),
    `ordinary-workflow-${suffix}`
  ).workItem;
  const planningClaim = fixture.board.claimRun(fixture.manager.agentId, {
    claimId: `claim-ordinary-planning-${suffix}`,
    messageCursor: null,
  });
  assert.ok(planningClaim);
  fixture.board.settleRun(planningClaim.run.runId, fixture.manager.agentId, {
    outcome: "completed",
    result: "The ordinary workflow is ready for confirmation.",
    workflowPlan: {
      objective: "Verify the ordinary workflow.",
      assumptions: [],
      acceptanceCriteria: ["The verification result is recorded."],
      nodes: [
        {
          nodeId: `ordinary-research-${suffix}`,
          title: "Research ordinary workflow",
          objective: "Verify without allocating a pipeline branch.",
          acceptanceCriteria: ["The claim has no pipeline context."],
          dependencyNodeIds: [],
          stageTemplate: ["research", "verification"],
        },
      ],
    },
  });
  const revision = fixture.board
    .projectWorkflow(fixture.project.projectId)
    .plans.find((candidate) => candidate.state === "proposed");
  assert.ok(revision);
  fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
  return workItem;
}

function transactionSnapshot(path: string, workItemId: string, planRevisionId: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      workItem: db
        .prepare(
          `
        SELECT state,current_stage,resolved_project_id,pipeline_branch,base_sha,version,updated_at
        FROM work_items WHERE work_item_id=?
      `
        )
        .get(workItemId),
      plan: db
        .prepare("SELECT state,confirmed_by,confirmed_at FROM plan_revisions WHERE plan_revision_id=?")
        .get(planRevisionId),
      nodes: db
        .prepare(
          "SELECT state,current_stage,version,updated_at FROM work_nodes WHERE plan_revision_id=? ORDER BY node_id"
        )
        .all(planRevisionId),
      transitions: db
        .prepare("SELECT COUNT(*) AS count FROM work_item_transitions WHERE work_item_id=?")
        .get(workItemId),
      events: db.prepare("SELECT COUNT(*) AS count FROM project_events").get(),
    };
  } finally {
    db.close();
  }
}

test("a direct v2 pipeline proposal missing tier is rejected before persistence", async () => {
  const fixture = await boardFixture();
  const { tier: _tier, ...incompletePlan } = pipelinePlan();
  try {
    const workItem = fixture.board.createWorkItem(
      workItemRequest({
        originalRequest: "Reject an incomplete direct pipeline proposal.",
        projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
      }),
      "pipeline-incomplete-direct-proposal"
    ).workItem;

    assert.throws(
      () =>
        fixture.board.proposeWorkflow({
          ...incompletePlan,
          workItemId: workItem.workItemId,
          projectId: fixture.project.projectId,
          skillIds: [],
        }),
      (error: unknown) =>
        error instanceof TaskBoardError &&
        error.status === 400 &&
        error.code === "TASK_BOARD_PIPELINE_PLAN_INCOMPLETE" &&
        error.message === "Pipeline plan is missing required field tier"
    );
    assert.deepEqual(fixture.board.projectWorkflow(fixture.project.projectId).plans, []);
  } finally {
    fixture.board.close();
  }
});

test("confirm records the pipeline branch and base SHA and claim projects the pipeline workspace context", async () => {
  const fixture = await boardFixture();
  const repository = await fixtureRepo();
  try {
    updateProjectPath(fixture, repository.repo);
    const { workItem, revision } = preparePipeline(fixture, "success");

    fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });

    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const identity = db
        .prepare("SELECT pipeline_branch,base_sha FROM work_items WHERE work_item_id=?")
        .get(workItem.workItemId);
      assert.equal(identity?.pipeline_branch, `task/${workItem.workItemId}`);
      assert.equal(identity?.base_sha, repository.head);
    } finally {
      db.close();
    }
    const rawClaim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-pipeline-implementation-success",
      messageCursor: null,
    });
    assert.ok(rawClaim);
    const rawWorkflow = rawClaim.context.workflow as unknown as Record<string, unknown>;
    assert.equal(rawWorkflow.workspaceKey, workItem.workItemId);
    assert.deepEqual(rawWorkflow.pipeline, {
      branch: `task/${workItem.workItemId}`,
      baseSha: repository.head,
      changeShape: "feature",
      tier: "standard",
      declaredScope: ["src/server", "tests/server"],
      nonGoals: ["Do not push the branch."],
      assumptions: ["The registered repository remains on its default branch."],
      designRecord: null,
    });

    const client = new HttpTaskBoardClient({
      baseUrl: "http://127.0.0.1/",
      token: AGENT_ONE_TOKEN,
      fetchImplementation: async () =>
        new Response(JSON.stringify(rawClaim), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const mapped = await client.claimNextWake({
      agentId: fixture.engineer.agentId,
      claimId: rawClaim.run.claimId,
      messageCursors: {},
      longPollMs: 0,
    });
    assert.ok(mapped?.context?.workflow);
    const mappedWorkflow = mapped.context.workflow as unknown as Record<string, unknown>;
    assert.equal(mappedWorkflow.workspaceKey, workItem.workItemId);
    assert.deepEqual(mappedWorkflow.pipeline, rawWorkflow.pipeline);
  } finally {
    fixture.board.close();
  }
});

test("a pipeline plan without non-goals confirms and projects an empty claim-context list", async () => {
  const fixture = await boardFixture();
  const repository = await fixtureRepo();
  const { nonGoals: _nonGoals, ...planWithoutNonGoals } = pipelinePlan();
  try {
    updateProjectPath(fixture, repository.repo);
    const { revision } = preparePipeline(fixture, "without-non-goals", planWithoutNonGoals);

    fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-pipeline-implementation-without-non-goals",
      messageCursor: null,
    });

    assert.ok(claim?.context.workflow?.pipeline);
    assert.deepEqual(claim.context.workflow.pipeline.nonGoals, []);
  } finally {
    fixture.board.close();
  }
});

test("an unavailable pipeline repository rolls the entire confirm transaction back", async () => {
  const fixture = await boardFixture();
  try {
    updateProjectPath(fixture, join(tmpdir(), "missing-pipeline-repository"));
    const { workItem, revision } = preparePipeline(fixture, "missing-repo");
    const before = transactionSnapshot(fixture.path, workItem.workItemId, revision.planRevisionId);

    assert.throws(
      () => fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" }),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 409 && error.code === "PROJECT_REPO_PATH_INVALID"
    );

    assert.deepEqual(transactionSnapshot(fixture.path, workItem.workItemId, revision.planRevisionId), before);
  } finally {
    fixture.board.close();
  }
});

test("ordinary workflow claims carry null pipeline fields and legacy claim replays default absent fields", async () => {
  const fixture = await boardFixture();
  const claimRequest = { claimId: "claim-ordinary-verification-context", messageCursor: null } as const;
  try {
    prepareNonPipeline(fixture, "null-context");
    const first = fixture.board.claimRun(fixture.engineer.agentId, claimRequest);
    assert.ok(first?.context.workflow);
    assert.equal(first.context.workflow.workspaceKey, null);
    assert.equal(first.context.workflow.pipeline, null);

    const db = new DatabaseSync(fixture.path);
    try {
      const row = db.prepare("SELECT claim_result_json FROM runs WHERE run_id=?").get(first.run.runId);
      const stored = JSON.parse(String(row?.claim_result_json)) as {
        context: { workflow: Record<string, unknown> };
      };
      delete stored.context.workflow.workspaceKey;
      delete stored.context.workflow.pipeline;
      db.prepare("UPDATE runs SET claim_result_json=? WHERE run_id=?").run(JSON.stringify(stored), first.run.runId);
    } finally {
      db.close();
    }

    const replay = fixture.board.claimRun(fixture.engineer.agentId, claimRequest);
    assert.ok(replay?.context.workflow);
    assert.equal(replay.context.workflow.workspaceKey, null);
    assert.equal(replay.context.workflow.pipeline, null);
  } finally {
    fixture.board.close();
  }
});

test("hazardous pipeline confirmation enters design with branch identity", async () => {
  const fixture = await boardFixture();
  const repository = await fixtureRepo();
  try {
    updateProjectPath(fixture, repository.repo);
    const { workItem, revision } = preparePipeline(fixture, "hazardous", pipelinePlan("hazardous"));

    const result = fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });

    assert.equal(result.outcome, "designing");
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const identity = db
        .prepare("SELECT pipeline_branch,base_sha FROM work_items WHERE work_item_id=?")
        .get(workItem.workItemId);
      assert.equal(identity?.pipeline_branch, `task/${workItem.workItemId}`);
      assert.equal(identity?.base_sha, repository.head);
    } finally {
      db.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("pipeline executor drift rejects confirmation without transitioning the work item", async () => {
  const fixture = await boardFixture();
  const repository = await fixtureRepo();
  try {
    updateProjectPath(fixture, repository.repo);
    const { workItem, revision } = preparePipeline(fixture, "executor-drift");
    const configured = fixture.board.getAutomationConfiguration();
    const implementation = configured.stages.find((stage) => stage.stage === "implementation")?.executor;
    assert.equal(implementation?.kind, "agent_type");
    fixture.board.updateAutomationConfiguration(
      automationConfigurationRequest({
        version: configured.version,
        agentTypes: configured.agentTypes,
        stages: automationStages({
          implementation,
          testing: { kind: "agent_type", agentTypeId: implementation.agentTypeId },
        }),
      })
    );
    const before = transactionSnapshot(fixture.path, workItem.workItemId, revision.planRevisionId);

    assert.throws(
      () => fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" }),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 409 && error.code === "TASK_BOARD_PIPELINE_EXECUTOR_DRIFT"
    );

    assert.deepEqual(transactionSnapshot(fixture.path, workItem.workItemId, revision.planRevisionId), before);
    assert.equal(fixture.board.requireWorkItem(workItem.workItemId).state, "plan_approval");
  } finally {
    fixture.board.close();
  }
});

test("pipeline verification executor drift rejects confirmation without transitioning the work item", async () => {
  const fixture = await boardFixture();
  const repository = await fixtureRepo();
  try {
    updateProjectPath(fixture, repository.repo);
    const { workItem, revision } = preparePipeline(fixture, "verification-executor-drift");
    const configured = fixture.board.getAutomationConfiguration();
    const implementation = configured.stages.find((stage) => stage.stage === "implementation")?.executor;
    assert.equal(implementation?.kind, "agent_type");
    fixture.board.updateAutomationConfiguration(
      automationConfigurationRequest({
        version: configured.version,
        agentTypes: configured.agentTypes,
        stages: automationStages({
          implementation,
          testing: { kind: "machine_verify" },
          verification: { kind: "disabled" },
        }),
      })
    );
    const before = transactionSnapshot(fixture.path, workItem.workItemId, revision.planRevisionId);

    assert.throws(
      () => fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" }),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 409 && error.code === "TASK_BOARD_PIPELINE_EXECUTOR_DRIFT"
    );

    assert.deepEqual(transactionSnapshot(fixture.path, workItem.workItemId, revision.planRevisionId), before);
    assert.equal(fixture.board.requireWorkItem(workItem.workItemId).state, "plan_approval");
  } finally {
    fixture.board.close();
  }
});

test("a stored v1 pipeline keeps its testing-only executor contract", async () => {
  const fixture = await boardFixture();
  const repository = await fixtureRepo();
  try {
    updateProjectPath(fixture, repository.repo);
    const { workItem, revision } = preparePipeline(fixture, "stored-v1");
    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare("UPDATE work_nodes SET stage_template_json=? WHERE plan_revision_id=?").run(
        JSON.stringify(["implementation", "testing"]),
        revision.planRevisionId
      );
    } finally {
      db.close();
    }
    const configured = fixture.board.getAutomationConfiguration();
    const implementation = configured.stages.find((stage) => stage.stage === "implementation")?.executor;
    assert.equal(implementation?.kind, "agent_type");
    fixture.board.updateAutomationConfiguration(
      automationConfigurationRequest({
        version: configured.version,
        agentTypes: configured.agentTypes.map((agentType) =>
          agentType.role === "verifier" ? { ...agentType, enabled: false } : agentType
        ),
        stages: automationStages({
          implementation,
          testing: { kind: "machine_verify" },
          verification: { kind: "disabled" },
        }),
      })
    );

    fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });

    const current = fixture.board.requireWorkItem(workItem.workItemId);
    assert.equal(current.pipelineBranch, `task/${workItem.workItemId}`);
    assert.equal(current.baseSha, repository.head);
    assert.equal(current.state, "implementing");
  } finally {
    fixture.board.close();
  }
});

test("a v1 pipeline proposal is rejected with the required v2 template", async () => {
  const fixture = await boardFixture();
  const v2 = pipelinePlan();
  const v1: WorkflowPlanDraft = {
    ...v2,
    nodes: [{ ...v2.nodes[0]!, stageTemplate: ["implementation", "testing"] }],
  };
  try {
    assert.throws(
      () => preparePipeline(fixture, "v1-proposal", v1),
      (error: unknown) =>
        error instanceof TaskBoardError &&
        error.status === 400 &&
        error.code === "TASK_BOARD_PIPELINE_PLAN_INCOMPLETE" &&
        error.message ===
          'pipeline plans must end in a verification stage (template ["implementation","testing","verification"])'
    );
  } finally {
    fixture.board.close();
  }
});

test("pipeline HEAD resolution uses the injected hooks-neutralized git invocation before the confirm transaction", async () => {
  const fixture = await boardFixture();
  updateProjectPath(fixture, "/registered/pipeline-repository");
  const { workItem, revision } = preparePipeline(fixture, "injected-git");
  fixture.board.close();
  const store = await TaskBoardStore.open(fixture.path);
  registerWorkItemTransitionStore(store);
  registerParentTerminationCascade(store, () => undefined);
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const expectedSha = "a".repeat(40);
  let transactions = 0;
  try {
    const workflow = new TransparentWorkflow(
      store.db,
      new SkillRegistry(join(process.cwd(), "config", "skills.md")),
      () => new Date("2026-08-19T20:00:00.000Z"),
      (operation) => {
        transactions += 1;
        return store.transaction(operation);
      },
      undefined,
      (arguments_) => {
        mutableCalls.push([...arguments_]);
        return `${expectedSha}\n`;
      }
    );

    const baseSha = workflow.pipelineBaseShaForConfirm(revision.planRevisionId, { expectedState: "proposed" });
    assert.equal(transactions, 0);
    workflow.confirm(revision.planRevisionId, { expectedState: "proposed" }, "human:alice", baseSha, new Map());

    assert.deepEqual(calls, [
      [
        "-c",
        "core.fsmonitor=",
        "-c",
        "core.hooksPath=",
        "-c",
        `user.name=${BOARD_COMMITTER_NAME}`,
        "-c",
        `user.email=${BOARD_COMMITTER_EMAIL}`,
        "-c",
        "safe.directory=*",
        "-C",
        "/registered/pipeline-repository",
        "rev-parse",
        "HEAD",
      ],
    ]);
    const identity = store.db
      .prepare("SELECT pipeline_branch,base_sha FROM work_items WHERE work_item_id=?")
      .get(workItem.workItemId);
    assert.equal(identity?.pipeline_branch, `task/${workItem.workItemId}`);
    assert.equal(identity?.base_sha, expectedSha);
    assert.equal(transactions, 1);
  } finally {
    store.close();
  }
});

test("a throwing injected git runner fails before opening the confirm transaction", async () => {
  const fixture = await boardFixture();
  updateProjectPath(fixture, "/registered/pipeline-repository");
  const { workItem, revision } = preparePipeline(fixture, "throwing-git");
  fixture.board.close();
  const store = await TaskBoardStore.open(fixture.path);
  registerWorkItemTransitionStore(store);
  registerParentTerminationCascade(store, () => undefined);
  let transactions = 0;
  const before = transactionSnapshot(fixture.path, workItem.workItemId, revision.planRevisionId);
  try {
    const workflow = new TransparentWorkflow(
      store.db,
      new SkillRegistry(join(process.cwd(), "config", "skills.md")),
      () => new Date("2026-08-19T20:00:00.000Z"),
      (operation) => {
        transactions += 1;
        return store.transaction(operation);
      },
      undefined,
      () => {
        throw new Error("git unavailable");
      }
    );

    assert.throws(
      () => workflow.pipelineBaseShaForConfirm(revision.planRevisionId, { expectedState: "proposed" }),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 409 && error.code === "PROJECT_REPO_PATH_INVALID"
    );

    assert.equal(transactions, 0);
    assert.deepEqual(transactionSnapshot(fixture.path, workItem.workItemId, revision.planRevisionId), before);
  } finally {
    store.close();
  }
});

test("a malformed pipeline HEAD is reported as an unavailable repository", async () => {
  const fixture = await boardFixture();
  updateProjectPath(fixture, "/registered/pipeline-repository");
  const { revision } = preparePipeline(fixture, "malformed-git");
  fixture.board.close();
  const store = await TaskBoardStore.open(fixture.path);
  registerWorkItemTransitionStore(store);
  registerParentTerminationCascade(store, () => undefined);
  try {
    const workflow = new TransparentWorkflow(
      store.db,
      new SkillRegistry(join(process.cwd(), "config", "skills.md")),
      () => new Date("2026-08-19T20:00:00.000Z"),
      (operation) => store.transaction(operation),
      undefined,
      () => "not-a-sha\n"
    );

    assert.throws(
      () => workflow.pipelineBaseShaForConfirm(revision.planRevisionId, { expectedState: "proposed" }),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 409 && error.code === "PROJECT_REPO_PATH_INVALID"
    );
  } finally {
    store.close();
  }
});
