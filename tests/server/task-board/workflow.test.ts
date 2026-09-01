import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { AgentRole, ClaimRunPinning, WorkflowPlanDraft } from "#shared/task-board-contract";
import { HttpTaskBoardClient } from "#server/agents/task-worker/http-board-client";
import { TaskBoardError } from "#server/task-board";
import type { GitTextRunner } from "#server/shared/git";
import {
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  taskRequest,
  workItemRequest,
} from "./helpers.js";

const IMPLEMENT_PIN = Object.freeze({
  runtime: "codex",
  runtimeVersion: "1.2.3",
  model: "gpt-5.6",
  promptsSha: "implementation-prompts",
});
const REVIEW_PIN = Object.freeze({
  runtime: "codex",
  runtimeVersion: "1.2.3",
  model: "gpt-5.6-review",
  promptsSha: "review-prompts",
});
type RuntimeModelPair = Readonly<{ runtime: string; model: string }>;

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(stderr));
      else resolve(stdout);
    });
  });
}

async function repository(): Promise<{ repo: string; baseSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "steward-review-claim-"));
  const repo = join(root, "repo");
  await git(root, ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.name", "Review Claim Test"]);
  await git(repo, ["config", "user.email", "review-claim@test.invalid"]);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "existing.ts"), "export const value = 1;\n");
  await writeFile(join(repo, "src", "deleted.ts"), "export const removed = true;\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  return { repo, baseSha: (await git(repo, ["rev-parse", "HEAD"])).trim() };
}

function plan(suffix: string): WorkflowPlanDraft {
  return {
    objective: `Review pipeline claim ${suffix}.`,
    assumptions: ["The repository remains available."],
    acceptanceCriteria: ["The review context contains the approved criterion."],
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["src"],
    nonGoals: ["Do not change the schema."],
    mechanicalPortions: ["Rename generated symbols."],
    blockingQuestions: [],
    criterionChecks: [
      {
        criterion: "The review context contains the approved criterion.",
        check: "npm run test:runtime",
      },
    ],
    nodes: [
      {
        nodeId: `review-claim-${suffix}`,
        title: `Review claim ${suffix}`,
        objective: "Expose isolated review evidence.",
        acceptanceCriteria: ["The reviewer can inspect the implementation branch."],
        dependencyNodeIds: [],
        stageTemplate: ["implementation", "testing", "verification"],
      },
    ],
  };
}

function completeTask(
  board: Awaited<ReturnType<typeof boardFixture>>["board"],
  projectId: string,
  agentId: string,
  role: AgentRole,
  suffix: string
): void {
  board.createTask(
    projectId,
    taskRequest({
      title: `Prior area memory ${suffix}`,
      assignedAgentId: agentId,
      assignedRole: role,
      requiresReview: false,
    })
  );
  const claim = board.claimRun(agentId, { claimId: `prior-area-memory-${suffix}`, messageCursor: null });
  assert.ok(claim);
  board.settleRun(claim.run.runId, agentId, { outcome: "completed", result: `Remembered result ${suffix}.` });
}

async function reviewFixture(
  suffix: string,
  implementPin: ClaimRunPinning | undefined = IMPLEMENT_PIN,
  boardGit?: GitTextRunner
) {
  const fixture = await boardFixture(undefined, undefined, boardGit === undefined ? {} : { git: boardGit });
  const { repo, baseSha } = await repository();
  const verifier = fixture.board.createAgent(fixture.project.projectId, {
    agentId: `review-verifier-${suffix}`,
    role: "verifier",
    area: "pipeline-review",
    mission: "Review implementation evidence without editing it.",
    model: "gpt-5.6-review",
    token: `review-verifier-token-${suffix}-0123456789abcdef`,
  });
  const db = new DatabaseSync(fixture.path);
  db.prepare("UPDATE projects SET repo_path=? WHERE project_id=?").run(repo, fixture.project.projectId);
  db.close();
  completeTask(
    fixture.board,
    fixture.project.projectId,
    fixture.engineer.agentId,
    fixture.engineer.role,
    `${suffix}-engineer`
  );
  completeTask(fixture.board, fixture.project.projectId, verifier.agentId, verifier.role, `${suffix}-verifier`);
  const implementationType = {
    agentTypeId: `review-implementation-${suffix}`,
    name: "Review implementation",
    description: "Implements the pipeline branch.",
    role: "engineer" as const,
    supplementalInstructions: "Commit only the confirmed scope.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  const verificationType = {
    ...implementationType,
    agentTypeId: `review-verification-${suffix}`,
    name: "Review verification",
    description: "Reviews the pipeline branch independently.",
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
      originalRequest: `Build review claim fixture ${suffix}.`,
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }),
    `review-claim-${suffix}`
  ).workItem;
  const planningClaim = fixture.board.claimRun(fixture.manager.agentId, {
    claimId: `review-planning-${suffix}`,
    messageCursor: null,
  });
  assert.ok(planningClaim);
  fixture.board.settleRun(planningClaim.run.runId, fixture.manager.agentId, {
    outcome: "completed",
    result: "The review plan is ready.",
    workflowPlan: plan(suffix),
  });
  const revision = fixture.board
    .projectWorkflow(fixture.project.projectId)
    .plans.find((candidate) => candidate.workItemId === workItem.workItemId && candidate.state === "proposed");
  assert.ok(revision);
  const confirmed = fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
  const node = confirmed.nodes.find((candidate) => candidate.planRevisionId === revision.planRevisionId);
  assert.ok(node);
  const implementationClaim = fixture.board.claimRun(fixture.engineer.agentId, {
    claimId: `review-implementation-claim-${suffix}`,
    messageCursor: null,
    ...(implementPin === undefined ? {} : { pinned: implementPin }),
  });
  assert.ok(implementationClaim);
  assert.equal(implementationClaim.context.workflow?.workspaceKey, workItem.workItemId);
  assert.equal((implementationClaim.context.workflow as unknown as { review?: unknown }).review ?? null, null);
  assert.deepEqual(implementationClaim.context.areaMemory, []);

  const branch = `task/${workItem.workItemId}`;
  await git(repo, ["switch", "-c", branch, baseSha]);
  await writeFile(join(repo, "src", "existing.ts"), "export const value = 2;\n");
  await writeFile(join(repo, "src", "added.ts"), "export const added = true;\n");
  await git(repo, ["rm", "src/deleted.ts"]);
  await git(repo, ["add", "src/existing.ts", "src/added.ts"]);
  await git(repo, ["commit", "-m", "implement review claim"]);
  await git(repo, ["switch", "main"]);

  const verificationTask = fixture.board.createTask(
    fixture.project.projectId,
    taskRequest({
      title: `verification: ${node.title}`,
      objective: node.objective,
      acceptanceCriteria: node.acceptanceCriteria.join("\n"),
      workspaceRefs: [],
      assignedAgentId: verifier.agentId,
      assignedRole: verifier.role,
      requiresReview: false,
    })
  );
  const direct = new DatabaseSync(fixture.path);
  try {
    const implementationTaskId = String(
      direct
        .prepare(
          `
      SELECT task_id FROM stage_attempts WHERE node_id=? AND stage='implementation' ORDER BY attempt DESC LIMIT 1
    `
        )
        .get(node.nodeId)?.task_id
    );
    const now = "2026-08-19T16:00:00.000Z";
    const handoff = {
      apiVersion: "steward.task-board/v1",
      handoffId: `handoff-review-${suffix}`,
      nodeId: node.nodeId,
      taskId: implementationTaskId,
      stage: "implementation",
      outcome: "passed",
      summary: "Implementation is ready for review.",
      evidence: ["ASSUMPTION: Keep the review clone isolated."],
      artifactIds: [],
      acceptanceCriteria: [],
      blockers: [],
      recommendedReturnStage: null,
      createdAt: now,
    };
    direct
      .prepare("INSERT INTO stage_handoffs VALUES(?,?,?,?,?,?,?)")
      .run(
        handoff.handoffId,
        node.nodeId,
        implementationTaskId,
        handoff.stage,
        handoff.outcome,
        JSON.stringify(handoff),
        now
      );
    direct
      .prepare(
        `
      INSERT INTO task_events(event_id,project_id,task_id,actor_type,actor_id,event_type,data_json,created_at)
      VALUES (?, ?, ?, 'agent', ?, 'task_run_settled', '{}', ?)
    `
      )
      .run(`event-review-${suffix}`, fixture.project.projectId, implementationTaskId, fixture.engineer.agentId, now);
    direct
      .prepare("INSERT INTO stage_attempts VALUES(?,?,?,?,?,?)")
      .run(`attempt-review-${suffix}`, node.nodeId, verificationTask.taskId, "verification", 1, "{}");
    direct
      .prepare(
        `
      INSERT INTO review_findings(
        finding_id,node_id,stage,round,file,line,category,severity,expected,actual,blocking,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `
      )
      .run(
        `finding-review-${suffix}-round-2`,
        node.nodeId,
        "verification",
        2,
        "src/existing.ts",
        1,
        "correctness",
        "major",
        "The value is reviewed.",
        "The value was not reviewed.",
        1,
        "2026-08-19T16:02:00.000Z"
      );
    direct
      .prepare(
        `
      INSERT INTO review_findings(
        finding_id,node_id,stage,round,file,line,category,severity,expected,actual,blocking,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `
      )
      .run(
        `finding-review-${suffix}-round-1`,
        node.nodeId,
        "verification",
        1,
        null,
        null,
        "docs",
        "minor",
        "The review notes exist.",
        "The notes were missing.",
        0,
        "2026-08-19T16:01:00.000Z"
      );
  } finally {
    direct.close();
  }
  return { ...fixture, repo, baseSha, verifier, workItem, revision, node, implementationClaim, verificationTask };
}

function installImplementationRunHistory(
  fixture: Awaited<ReturnType<typeof reviewFixture>>,
  pairs: Readonly<{
    olderAttempt: RuntimeModelPair;
    latestAttemptOlderRun: RuntimeModelPair;
    latestAttemptLatestRun: RuntimeModelPair;
  }>
): void {
  const latestTask = fixture.board.createTask(
    fixture.project.projectId,
    taskRequest({
      title: `Later implementation attempt ${fixture.node.nodeId}`,
      assignedAgentId: fixture.engineer.agentId,
      assignedRole: fixture.engineer.role,
      requiresReview: false,
    })
  );
  const db = new DatabaseSync(fixture.path);
  try {
    const olderTaskId = String(
      db
        .prepare(
          `
      SELECT task_id
      FROM stage_attempts
      WHERE node_id=? AND stage='implementation' AND attempt=1
    `
        )
        .get(fixture.node.nodeId)?.task_id
    );
    db.prepare("UPDATE runs SET runtime=?,model=? WHERE task_id=?").run(
      pairs.olderAttempt.runtime,
      pairs.olderAttempt.model,
      olderTaskId
    );
    db.prepare("INSERT INTO stage_attempts VALUES(?,?,?,?,?,?)").run(
      `attempt-latest-${fixture.node.nodeId}`,
      fixture.node.nodeId,
      latestTask.taskId,
      "implementation",
      2,
      "{}"
    );
    const firstWakeupId = String(
      db
        .prepare(
          `
      SELECT wakeup_id FROM wakeups WHERE task_id=? ORDER BY created_at,wakeup_id LIMIT 1
    `
        )
        .get(latestTask.taskId)?.wakeup_id
    );
    const secondWakeupId = `wakeup-latest-${fixture.node.nodeId}`;
    db.prepare(
      `
      INSERT INTO wakeups(
        wakeup_id,project_id,agent_id,reason,source_key,task_id,question_id,
        detail,created_by,created_at,claimed_at,run_id
      ) VALUES(?,?,?,'resumed',?,?,NULL,?,?,?,NULL,NULL)
    `
    ).run(
      secondWakeupId,
      fixture.project.projectId,
      fixture.engineer.agentId,
      `implementation-history:${fixture.node.nodeId}`,
      latestTask.taskId,
      "Second run for implementation ordering coverage",
      "system:test",
      "2026-08-19T17:00:00.000Z"
    );
    const insertRun = (suffix: string, wakeupId: string, startedAt: string, pair: RuntimeModelPair): void => {
      const runId = `run-${suffix}-${fixture.node.nodeId}`;
      db.prepare(
        `
        INSERT INTO runs(
          run_id,claim_id,claim_request_hash,claim_result_json,project_id,agent_id,wakeup_id,task_id,
          status,started_at,ended_at,result,heartbeat_at,runtime,runtime_version,model,prompts_sha
        ) VALUES(?,?,?,NULL,?,?,?,?, 'completed',?,?,?,NULL,?,NULL,?,NULL)
      `
      ).run(
        runId,
        `claim-${suffix}-${fixture.node.nodeId}`,
        `hash-${suffix}`,
        fixture.project.projectId,
        fixture.engineer.agentId,
        wakeupId,
        latestTask.taskId,
        startedAt,
        startedAt,
        `Completed ${suffix} run`,
        pair.runtime,
        pair.model
      );
      db.prepare("UPDATE wakeups SET claimed_at=?,run_id=? WHERE wakeup_id=?").run(startedAt, runId, wakeupId);
    };
    insertRun("older", firstWakeupId, "2026-08-19T16:00:00.000Z", pairs.latestAttemptOlderRun);
    insertRun("latest", secondWakeupId, "2026-08-19T17:00:00.000Z", pairs.latestAttemptLatestRun);
  } finally {
    db.close();
  }
}

test("verification claims include isolated review context and reject an equal implementation runtime", async () => {
  const fixture = await reviewFixture("context-conflict");
  try {
    assert.throws(
      () =>
        fixture.board.claimRun(fixture.verifier.agentId, {
          claimId: "review-runtime-conflict-equal",
          messageCursor: null,
          pinned: IMPLEMENT_PIN,
        }),
      (error: unknown) =>
        error instanceof TaskBoardError &&
        error.status === 409 &&
        error.code === "TASK_BOARD_REVIEW_RUNTIME_CONFLICT" &&
        error.message ===
          "review runtime matches implement runtime (codex/gpt-5.6) — configure a different reviewer lane"
    );
    assert.throws(
      () =>
        fixture.board.claimRun(fixture.verifier.agentId, {
          claimId: "review-runtime-conflict-equal-retry",
          messageCursor: null,
          pinned: IMPLEMENT_PIN,
        }),
      (error: unknown) => error instanceof TaskBoardError && error.code === "TASK_BOARD_REVIEW_RUNTIME_CONFLICT"
    );
    const conflictEvents = fixture.board
      .projectWorkflow(fixture.project.projectId)
      .events.filter((event) => event.eventType === "review_runtime_conflict" && event.nodeId === fixture.node.nodeId);
    assert.equal(conflictEvents.length, 1);
    assert.match(conflictEvents[0]?.summary ?? "", /codex\/gpt-5\.6/u);

    const claim = fixture.board.claimRun(fixture.verifier.agentId, {
      claimId: "review-runtime-conflict-different-model",
      messageCursor: null,
      pinned: REVIEW_PIN,
    });
    assert.ok(claim);
    const workflow = claim.context.workflow as unknown as {
      workspaceKey: string;
      review: {
        commits: Array<{ sha: string; subject: string }>;
        diffstat: string;
        filesTouched: Array<{ path: string; status: string }>;
        scopeOk: boolean;
        midRunAssumptions: string[];
        acceptanceCriteria: string[];
        criterionChecks: Array<{ criterion: string; check: string }>;
        mechanicalPortions: string[];
        priorFindings: Array<{ findingId: string; round: number }>;
        priorFindingsTruncated: boolean;
      };
    };
    assert.equal(workflow.workspaceKey, `${fixture.workItem.workItemId}-review`);
    assert.equal(workflow.review.commits.length, 1);
    assert.equal(workflow.review.commits[0]?.subject, "implement review claim");
    assert.match(workflow.review.diffstat, /3 files changed/u);
    assert.deepEqual(workflow.review.filesTouched, [
      { path: "src/added.ts", status: "added" },
      { path: "src/deleted.ts", status: "deleted" },
      { path: "src/existing.ts", status: "modified" },
    ]);
    assert.equal(workflow.review.scopeOk, true);
    assert.deepEqual(workflow.review.midRunAssumptions, ["Keep the review clone isolated."]);
    assert.deepEqual(workflow.review.acceptanceCriteria, ["The review context contains the approved criterion."]);
    assert.deepEqual(workflow.review.criterionChecks, [
      {
        criterion: "The review context contains the approved criterion.",
        check: "npm run test:runtime",
      },
    ]);
    assert.deepEqual(workflow.review.mechanicalPortions, ["Rename generated symbols."]);
    assert.deepEqual(
      workflow.review.priorFindings.map((finding) => finding.round),
      [1, 2]
    );
    assert.equal(workflow.review.priorFindingsTruncated, false);
    assert.deepEqual(claim.context.areaMemory, []);
  } finally {
    fixture.board.close();
  }
});

test("runtime conflict uses the latest run of the latest implementation attempt", async () => {
  const fixture = await reviewFixture("latest-runtime-order");
  try {
    installImplementationRunHistory(fixture, {
      olderAttempt: REVIEW_PIN,
      latestAttemptOlderRun: REVIEW_PIN,
      latestAttemptLatestRun: IMPLEMENT_PIN,
    });

    assert.throws(
      () =>
        fixture.board.claimRun(fixture.verifier.agentId, {
          claimId: "review-runtime-latest-order-conflict",
          messageCursor: null,
          pinned: IMPLEMENT_PIN,
        }),
      (error: unknown) => error instanceof TaskBoardError && error.code === "TASK_BOARD_REVIEW_RUNTIME_CONFLICT"
    );
  } finally {
    fixture.board.close();
  }
});

test("runtime conflict ignores matching older implementation attempts and runs", async () => {
  const fixture = await reviewFixture("older-runtime-order");
  try {
    installImplementationRunHistory(fixture, {
      olderAttempt: IMPLEMENT_PIN,
      latestAttemptOlderRun: IMPLEMENT_PIN,
      latestAttemptLatestRun: REVIEW_PIN,
    });

    const claim = fixture.board.claimRun(fixture.verifier.agentId, {
      claimId: "review-runtime-older-order-allowed",
      messageCursor: null,
      pinned: IMPLEMENT_PIN,
    });
    assert.ok(claim);
    assert.equal(claim.context.workflow?.workspaceKey, `${fixture.workItem.workItemId}-review`);
  } finally {
    fixture.board.close();
  }
});

test("oversized review Git evidence is bounded before persistence and round-trips through the worker", async () => {
  const syntheticSha = "f".repeat(40);
  const oversizedDiffstat = "x".repeat(70_000);
  const syntheticLog = Array.from({ length: 1_100 }, (_unused, index) => `${syntheticSha}\0Commit ${index}\0`).join("");
  const syntheticNameStatus = Array.from({ length: 11_000 }, (_unused, index) => `M\0src/generated-${index}.ts\0`).join(
    ""
  );
  let fixturePath: string | null = null;
  let inspectionCalls = 0;
  const syntheticGit: GitTextRunner = (arguments_) => {
    if (arguments_.includes("rev-parse")) return syntheticSha;
    if (arguments_.includes("log")) {
      inspectionCalls += 1;
      return syntheticLog;
    }
    if (arguments_.includes("--stat")) {
      inspectionCalls += 1;
      assert.ok(fixturePath);
      const probe = new DatabaseSync(fixturePath);
      try {
        probe.exec("BEGIN IMMEDIATE");
        probe.exec("ROLLBACK");
      } finally {
        probe.close();
      }
      return oversizedDiffstat;
    }
    if (arguments_.includes("--name-status")) {
      inspectionCalls += 1;
      return syntheticNameStatus;
    }
    throw new Error(`unexpected git command: ${arguments_.join(" ")}`);
  };
  const fixture = await reviewFixture("oversized-evidence", IMPLEMENT_PIN, syntheticGit);
  fixturePath = fixture.path;
  try {
    const request = {
      claimId: "review-oversized-evidence",
      messageCursor: null,
      pinned: REVIEW_PIN,
    } as const;
    const claim = fixture.board.claimRun(fixture.verifier.agentId, request);
    assert.ok(claim);
    const replay = fixture.board.claimRun(fixture.verifier.agentId, request);
    assert.deepEqual(replay, claim);
    assert.equal(inspectionCalls, 3);

    const client = new HttpTaskBoardClient({
      baseUrl: "http://127.0.0.1:4318",
      token: "review-round-trip-token-0123456789abcdef",
      fetchImplementation: (async () =>
        new Response(JSON.stringify(replay), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    const workerClaim = await client.claimNextWake({
      agentId: fixture.verifier.agentId,
      claimId: request.claimId,
      messageCursors: {},
      longPollMs: 0,
      pinned: REVIEW_PIN,
    });
    assert.ok(workerClaim?.context?.workflow?.review);
    const review = workerClaim.context.workflow.review;
    assert.equal(review.diffstat.length, 64_000);
    assert.match(review.diffstat, /\[truncated: additional diffstat output omitted\]$/u);
    assert.ok(review.commits.length <= 1_000);
    assert.match(review.commits.at(-1)?.subject ?? "", /additional commits omitted/u);
    assert.ok(review.filesTouched.length <= 10_000);
    assert.match(review.filesTouched.at(-1)?.path ?? "", /additional files omitted/u);
    assert.deepEqual(review.mechanicalPortions, ["Rename generated symbols."]);
    assert.equal(review.priorFindingsTruncated, false);

    const legacyReplay = JSON.parse(JSON.stringify(replay)) as {
      context: { workflow: { review: Record<string, unknown> } };
    };
    delete legacyReplay.context.workflow.review.mechanicalPortions;
    delete legacyReplay.context.workflow.review.priorFindingsTruncated;
    const legacyClient = new HttpTaskBoardClient({
      baseUrl: "http://127.0.0.1:4318",
      token: "legacy-review-token-0123456789abcdef",
      fetchImplementation: (async () =>
        new Response(JSON.stringify(legacyReplay), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    const legacyWorkerClaim = await legacyClient.claimNextWake({
      agentId: fixture.verifier.agentId,
      claimId: request.claimId,
      messageCursors: {},
      longPollMs: 0,
      pinned: REVIEW_PIN,
    });
    assert.deepEqual(legacyWorkerClaim?.context?.workflow?.review?.mechanicalPortions, []);
    assert.equal(legacyWorkerClaim?.context?.workflow?.review?.priorFindingsTruncated, false);
  } finally {
    fixture.board.close();
  }
});

test("oversized prior review findings keep the newest evidence and round-trip with truncation", async () => {
  const fixture = await reviewFixture("oversized-prior-findings");
  try {
    const db = new DatabaseSync(fixture.path);
    try {
      const insert = db.prepare(`
        INSERT INTO review_findings(
          finding_id,node_id,stage,round,file,line,category,severity,expected,actual,blocking,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (let round = 3; round <= 6; round += 1) {
        for (let index = 0; index < 16; index += 1) {
          insert.run(
            `finding-oversized-${round}-${index}`,
            fixture.node.nodeId,
            "verification",
            round,
            `src/oversized-round-${round}-${index}.ts`,
            index + 1,
            "correctness",
            "major",
            `Expected ${round}-${index} ${"e".repeat(1_780)}`,
            `Actual ${round}-${index} ${"a".repeat(1_784)}`,
            1,
            `2026-08-19T18:${String(round).padStart(2, "0")}:${String(index).padStart(2, "0")}.000Z`
          );
        }
      }
    } finally {
      db.close();
    }

    const request = {
      claimId: "review-oversized-prior-findings",
      messageCursor: null,
      pinned: REVIEW_PIN,
    } as const;
    const claim = fixture.board.claimRun(fixture.verifier.agentId, request);
    assert.ok(claim?.context.workflow?.review);
    const boardReview = claim.context.workflow.review;
    assert.equal(boardReview.priorFindingsTruncated, true);
    assert.ok(boardReview.priorFindings.length > 0);
    assert.ok(boardReview.priorFindings.every((finding) => finding.round === 6));
    assert.ok(Buffer.byteLength(JSON.stringify(claim.context), "utf8") < 256 * 1_024);

    const client = new HttpTaskBoardClient({
      baseUrl: "http://127.0.0.1:4318",
      token: "oversized-prior-findings-token-0123456789abcdef",
      fetchImplementation: (async () =>
        new Response(JSON.stringify(claim), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    const workerClaim = await client.claimNextWake({
      agentId: fixture.verifier.agentId,
      claimId: request.claimId,
      messageCursors: {},
      longPollMs: 0,
      pinned: REVIEW_PIN,
    });
    assert.equal(workerClaim?.context?.workflow?.review?.priorFindingsTruncated, true);
    assert.deepEqual(workerClaim?.context?.workflow?.review?.priorFindings, boardReview.priorFindings);
  } finally {
    fixture.board.close();
  }
});

test("verification claims allow absent pinning without emitting a runtime-conflict event", async () => {
  const fixture = await reviewFixture("absent-pinning");
  try {
    const claim = fixture.board.claimRun(fixture.verifier.agentId, {
      claimId: "review-runtime-conflict-absent-review-pin",
      messageCursor: null,
    });
    assert.ok(claim);
    assert.equal(claim.context.workflow?.workspaceKey, `${fixture.workItem.workItemId}-review`);
    assert.equal(
      fixture.board
        .projectWorkflow(fixture.project.projectId)
        .events.some((event) => event.eventType === "review_runtime_conflict"),
      false
    );
  } finally {
    fixture.board.close();
  }
});

test("verification claims allow a pinned reviewer when implementation pinning is absent", async () => {
  const fixture = await reviewFixture("absent-implementation-pinning", undefined);
  try {
    const claim = fixture.board.claimRun(fixture.verifier.agentId, {
      claimId: "review-runtime-conflict-absent-implementation-pin",
      messageCursor: null,
      pinned: REVIEW_PIN,
    });
    assert.ok(claim);
    assert.equal(claim.context.workflow?.workspaceKey, `${fixture.workItem.workItemId}-review`);
    assert.equal(
      fixture.board
        .projectWorkflow(fixture.project.projectId)
        .events.some((event) => event.eventType === "review_runtime_conflict"),
      false
    );
  } finally {
    fixture.board.close();
  }
});
