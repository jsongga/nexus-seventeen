import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  TASK_BOARD_ERROR_CODES,
  type ReviewFindingDraft,
  type StageHandoffDraft,
  type WorkflowPlanDraft,
} from "#shared/task-board-contract";
import { TaskBoardError } from "#server/task-board";
import {
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

async function fixtureRepo(verifyPasses: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steward-machine-verify-"));
  const repo = join(root, "repo");
  await git(root, ["init", "-b", "main", repo]);
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(repo, "readme.md"), "machine verify integration\n");
  await writeFile(
    join(repo, "docs", "workflow.md"),
    `# Verify workflow\n\n\`\`\`json\n${JSON.stringify(
      {
        version: 1,
        compile: ["node verify-compile.mjs"],
        rules: [{ match: "**", action: { kind: "none" } }],
        full: ["node verify-full.mjs"],
      },
      null,
      2
    )}\n\`\`\`\n`
  );
  await writeFile(
    join(repo, "verify-full.mjs"),
    verifyPasses
      ? 'process.stdout.write("full verify passed\\n");\n'
      : 'process.stderr.write("intentional machine verify failure\\n"); process.exit(9);\n'
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
    pointProjectAtRepository(db, fixture.project.projectId, repositoryPath);
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
    nodes: [
      {
        nodeId: "machine-verify-node",
        title: "Exercise machine verify",
        objective: "Implement a scoped change and verify it without an agent executor.",
        acceptanceCriteria: ["The machine verify result is durably settled."],
        dependencyNodeIds: [],
        stageTemplate: ["implementation", "testing", "verification"],
      },
    ],
  };
}

function implementationHandoff(): StageHandoffDraft {
  return {
    outcome: "passed",
    summary: "The scoped implementation is ready for machine verification.",
    evidence: ["The task branch contains the scoped commit."],
    artifactIds: [],
    acceptanceCriteria: [
      {
        criterion: "The implementation is committed.",
        passed: true,
        evidence: "The task branch contains the implementation commit.",
      },
    ],
    blockers: [],
    recommendedReturnStage: null,
  };
}

function reviewFinding(round: number, category: ReviewFindingDraft["category"] = "correctness"): ReviewFindingDraft {
  return {
    file: `src/review-round-${round}.ts`,
    line: round,
    category,
    severity: category === "correctness" ? "major" : "minor",
    expected: `Review round ${round} meets the approved plan.`,
    actual: `Review round ${round} found a defect.`,
  };
}

function reviewHandoff(
  outcome: "passed" | "failed",
  recommendedReturnStage: StageHandoffDraft["recommendedReturnStage"] = outcome === "passed" ? null : "implementation"
): StageHandoffDraft {
  return {
    outcome,
    summary: outcome === "passed" ? "Independent review passed." : "Independent review found a defect.",
    evidence: [],
    artifactIds: [],
    acceptanceCriteria: [],
    blockers: outcome === "passed" ? [] : ["The review finding must be fixed."],
    recommendedReturnStage,
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
  const verificationType = {
    ...implementationType,
    agentTypeId: `machine-verify-verification-${suffix}`,
    name: "Machine verify reviewer",
    description: "Independently reviews green machine verification evidence.",
    role: "verifier" as const,
  };
  const verifier = fixture.board.createAgent(fixture.project.projectId, {
    agentId: `machine-verify-verifier-${suffix}`,
    role: "verifier",
    area: "independent-review",
    mission: "Review a green pipeline without implementing it.",
    model: "codex-mini",
    token: "machine-verify-verifier-token-0123456789abcdef",
  });
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
      originalRequest: "Exercise machine verification.",
      projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
    }),
    `machine-verify-integration-${suffix}`
  ).workItem;
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
  const revision = fixture.board
    .projectWorkflow(fixture.project.projectId)
    .plans.find((candidate) => candidate.state === "proposed");
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
  return { ...fixture, repo, workItem, implementation, verifier };
}

function terminalAttemptCount(path: string): number {
  const db = new DatabaseSync(path);
  try {
    return Number(
      db
        .prepare(
          `
      SELECT COUNT(*) AS count
      FROM verify_attempts
      WHERE state IN ('green','failed','died')
    `
        )
        .get()?.count
    );
  } finally {
    db.close();
  }
}

async function driveVerify(
  fixture: Awaited<ReturnType<typeof pipelineFixture>>,
  expectedState: "implementing" | "reviewing" | "dead_letter",
  expectedTerminalAttempts: number
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await fixture.board.sweepVerifyAttempts();
    if (
      fixture.board.requireWorkItem(fixture.workItem.workItemId).state === expectedState &&
      terminalAttemptCount(fixture.path) === expectedTerminalAttempts
    )
      return;
    await delay(25);
  }
  assert.fail(
    `verify sweep did not reach ${expectedState}; current=${fixture.board.requireWorkItem(fixture.workItem.workItemId).state}`
  );
}

async function reachReview(fixture: Awaited<ReturnType<typeof pipelineFixture>>, claimId: string) {
  fixture.board.settleRun(fixture.implementation.run.runId, fixture.engineer.agentId, {
    outcome: "completed",
    result: "Implementation complete.",
    handoff: implementationHandoff(),
  });
  await driveVerify(fixture, "reviewing", 1);
  const verification = fixture.board.claimRun(fixture.verifier.agentId, { claimId, messageCursor: null });
  assert.ok(verification);
  return verification;
}

function persistedFindings(path: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT * FROM review_findings ORDER BY round, created_at, finding_id").all() as Array<
      Record<string, unknown>
    >;
  } finally {
    db.close();
  }
}

test("pipeline activation, machine verify, and independent review settle into final approval", async () => {
  const fixture = await pipelineFixture("green", true);
  try {
    fixture.board.settleRun(fixture.implementation.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Implementation complete.",
      handoff: implementationHandoff(),
    });
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "verifying");

    await driveVerify(fixture, "reviewing", 1);

    let workflow = fixture.board.projectWorkflow(fixture.project.projectId);
    assert.equal(workflow.nodes[0]?.state, "active");
    assert.equal(workflow.nodes[0]?.currentStage, "verification");
    const machineHandoff = workflow.handoffs.find((handoff) => handoff.stage === "testing");
    assert.ok(machineHandoff);
    assert.equal(machineHandoff.outcome, "passed");
    assert.deepEqual(machineHandoff.acceptanceCriteria, [
      {
        criterion: "The criterion check passes.",
        passed: true,
        evidence: "Passed: node criterion-check.mjs",
      },
    ]);
    const db = new DatabaseSync(fixture.path);
    try {
      const attempt = db.prepare("SELECT state,check_results_json FROM verify_attempts").get();
      assert.equal(attempt?.state, "green");
      assert.deepEqual(JSON.parse(String(attempt?.check_results_json)), [
        {
          criterion: "The criterion check passes.",
          check: "node criterion-check.mjs",
          passed: true,
        },
      ]);
      const author = db
        .prepare(
          `
        SELECT event.actor_id
        FROM stage_handoffs handoff
        JOIN task_events event ON event.task_id=handoff.task_id
        WHERE handoff.stage='testing' AND event.event_type='task_created'
      `
        )
        .get();
      assert.equal(author?.actor_id, "system:machine-verify");
    } finally {
      db.close();
    }
    const verification = fixture.board.claimRun(fixture.verifier.agentId, {
      claimId: "claim-machine-verify-independent-review-green",
      messageCursor: null,
    });
    assert.ok(verification);
    assert.equal(verification.context.workflow?.stage, "verification");
    fixture.board.settleRun(verification.run.runId, fixture.verifier.agentId, {
      outcome: "completed",
      result: "Independent verification passed.",
      handoff: {
        outcome: "passed",
        summary: "Independent verification passed.",
        evidence: [],
        artifactIds: [],
        acceptanceCriteria: [],
        blockers: [],
        recommendedReturnStage: null,
      },
    });
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "final_approval");
    workflow = fixture.board.projectWorkflow(fixture.project.projectId);
    assert.equal(workflow.nodes[0]?.state, "completed");
    await assert.rejects(
      access(join(dirname(fixture.path), "verify-workspaces", `${fixture.workItem.workItemId}-verify`))
    );
  } finally {
    fixture.board.close();
  }
});

test("passed review persists non-blocking findings and reaches final approval", async () => {
  const fixture = await pipelineFixture("non-blocking-review", true);
  try {
    const verification = await reachReview(fixture, "claim-non-blocking-review");
    fixture.board.settleRun(verification.run.runId, fixture.verifier.agentId, {
      outcome: "completed",
      result: "Independent review passed with documentation feedback.",
      handoff: reviewHandoff("passed"),
      reviewFindings: [reviewFinding(1, "docs")],
    });

    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "final_approval");
    const findings = persistedFindings(fixture.path);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.round, 1);
    assert.equal(findings[0]?.blocking, 0);
    assert.equal(findings[0]?.category, "docs");
  } finally {
    fixture.board.close();
  }
});

test("review finding expected and actual text are redacted at settlement persistence", async () => {
  const fixture = await pipelineFixture("redacted-review-finding", true);
  const expectedSecret = `review-${"r".repeat(48)}`;
  const actualSecret = `github_pat_${"g".repeat(48)}`;
  try {
    const verification = await reachReview(fixture, "claim-redacted-review-finding");
    fixture.board.settleRun(verification.run.runId, fixture.verifier.agentId, {
      outcome: "completed",
      result: "Independent review passed with a redacted observation.",
      handoff: reviewHandoff("passed"),
      reviewFindings: [
        {
          ...reviewFinding(1, "docs"),
          expected: `Authorization: Bearer ${expectedSecret}`,
          actual: `Observed ${actualSecret}`,
        },
      ],
    });

    const [finding] = persistedFindings(fixture.path);
    assert.ok(finding);
    assert.equal(finding.expected, "Authorization: [redacted:bearer]");
    assert.equal(finding.actual, "Observed [redacted:token]");
    assert.doesNotMatch(JSON.stringify(finding), new RegExp(`${expectedSecret}|${actualSecret}`, "u"));
  } finally {
    fixture.board.close();
  }
});

test("completed pipeline review rejects blocking findings when the handoff is omitted", async () => {
  const fixture = await pipelineFixture("blocking-review-without-handoff", true);
  try {
    const verification = await reachReview(fixture, "claim-blocking-review-without-handoff");
    assert.throws(
      () =>
        fixture.board.settleRun(verification.run.runId, fixture.verifier.agentId, {
          outcome: "completed",
          result: "Review completed with a blocking correctness finding.",
          reviewFindings: [reviewFinding(1)],
        }),
      (error: unknown) =>
        error instanceof TaskBoardError &&
        error.status === 400 &&
        error.code === TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_OUTCOME_MISMATCH
    );

    assert.deepEqual(persistedFindings(fixture.path), []);
    const workItem = fixture.board.requireWorkItem(fixture.workItem.workItemId);
    assert.equal(workItem.state, "reviewing");
    assert.equal(workItem.currentStage, "verification");
    const workflow = fixture.board.projectWorkflow(fixture.project.projectId);
    assert.equal(workflow.nodes[0]?.state, "active");
    assert.equal(workflow.nodes[0]?.currentStage, "verification");
    const run = fixture.board
      .snapshot(fixture.project.projectId)
      .recentRuns.find((candidate) => candidate.runId === verification.run.runId);
    assert.equal(run?.status, "active");
  } finally {
    fixture.board.close();
  }
});

test("review consistency gates roll back findings before a valid failed review enters fixing", async () => {
  const fixture = await pipelineFixture("review-consistency", true);
  try {
    const verification = await reachReview(fixture, "claim-review-consistency");
    const blocking = reviewFinding(1);
    assert.throws(
      () =>
        fixture.board.settleRun(verification.run.runId, fixture.verifier.agentId, {
          outcome: "completed",
          result: "Review passed incorrectly.",
          handoff: reviewHandoff("passed"),
          reviewFindings: [blocking],
        }),
      (error: unknown) =>
        error instanceof TaskBoardError && error.code === TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_OUTCOME_MISMATCH
    );
    assert.deepEqual(persistedFindings(fixture.path), []);
    assert.throws(
      () =>
        fixture.board.settleRun(verification.run.runId, fixture.verifier.agentId, {
          outcome: "failed",
          result: "Review failed without a blocking finding.",
          handoff: reviewHandoff("failed"),
          reviewFindings: [reviewFinding(1, "docs")],
        }),
      (error: unknown) =>
        error instanceof TaskBoardError && error.code === TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_FINDINGS_REQUIRED
    );
    assert.deepEqual(persistedFindings(fixture.path), []);

    fixture.board.settleRun(verification.run.runId, fixture.verifier.agentId, {
      outcome: "failed",
      result: "Review found a correctness defect.",
      handoff: reviewHandoff("failed", "testing"),
      reviewFindings: [blocking, reviewFinding(1, "docs")],
    });

    const workItem = fixture.board.requireWorkItem(fixture.workItem.workItemId);
    assert.equal(workItem.state, "fixing");
    assert.equal(workItem.currentStage, "implementation");
    const workflow = fixture.board.projectWorkflow(fixture.project.projectId);
    assert.equal(workflow.nodes[0]?.state, "active");
    assert.equal(workflow.nodes[0]?.currentStage, "implementation");
    assert.equal(workflow.handoffs.at(-1)?.recommendedReturnStage, "implementation");
    const findings = persistedFindings(fixture.path);
    assert.deepEqual(
      findings.map((finding) => [finding.round, finding.category, finding.blocking]),
      [
        [1, "correctness", 1],
        [1, "docs", 0],
      ]
    );

    const fixClaim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-review-consistency-fix",
      messageCursor: null,
    });
    assert.ok(fixClaim);
    assert.equal(fixClaim.context.workflow?.dependencyHandoffs.at(-1)?.stage, "verification");
    assert.equal(fixClaim.context.workflow?.fix?.round, 1);
    assert.deepEqual(
      fixClaim.context.workflow?.fix?.findings.map((finding) => [finding.category, finding.blocking]),
      [
        ["correctness", true],
        ["docs", false],
      ]
    );
    fixture.board.settleRun(fixClaim.run.runId, fixture.engineer.agentId, {
      outcome: "failed",
      result: "The first fix attempt needs another pass.",
      handoff: {
        ...implementationHandoff(),
        outcome: "failed",
        summary: "The first fix attempt needs another pass.",
        blockers: ["The correctness defect remains."],
        recommendedReturnStage: "implementation",
      },
    });
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "fixing");
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).currentStage, "implementation");
  } finally {
    fixture.board.close();
  }
});

test("pipeline verifier infrastructure failures without a handoff re-arm through the review cap", async () => {
  const fixture = await pipelineFixture("review-infrastructure-failure", true);
  try {
    let review = await reachReview(fixture, "claim-review-infrastructure-failure-1");
    for (let round = 1; round <= 4; round += 1) {
      const settled = fixture.board.settleRun(review.run.runId, fixture.verifier.agentId, {
        outcome: "failed",
        result: `Verifier launcher failed in round ${round}.`,
      });
      assert.equal(settled.run.status, "failed");
      assert.deepEqual(persistedFindings(fixture.path), []);
      const workItem = fixture.board.requireWorkItem(fixture.workItem.workItemId);
      if (round === 4) {
        assert.equal(workItem.state, "dead_letter");
        assert.equal(workItem.currentStage, null);
        assert.notEqual(workItem.endedAt, null);
        break;
      }
      assert.equal(workItem.state, "reviewing");
      assert.equal(workItem.currentStage, "verification");
      const nextReview = fixture.board.claimRun(fixture.verifier.agentId, {
        claimId: `claim-review-infrastructure-failure-${round + 1}`,
        messageCursor: null,
      });
      assert.ok(nextReview);
      review = nextReview;
    }
  } finally {
    fixture.board.close();
  }
});

test("final-approval rejection fixes the latest blocking round, not a newer non-blocking round", async () => {
  const fixture = await pipelineFixture("mixed-review-history", true);
  try {
    const reviewOne = await reachReview(fixture, "claim-mixed-review-history-1");
    fixture.board.settleRun(reviewOne.run.runId, fixture.verifier.agentId, {
      outcome: "failed",
      result: "Review round one found a blocking defect and a documentation note.",
      handoff: reviewHandoff("failed"),
      reviewFindings: [reviewFinding(1), reviewFinding(1, "docs")],
    });
    const firstFix = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-mixed-review-history-fix-1",
      messageCursor: null,
    });
    assert.ok(firstFix);
    fixture.board.settleRun(firstFix.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "The blocking defect from review round one is fixed.",
      handoff: implementationHandoff(),
    });
    await driveVerify(fixture, "reviewing", 2);
    const reviewTwo = fixture.board.claimRun(fixture.verifier.agentId, {
      claimId: "claim-mixed-review-history-2",
      messageCursor: null,
    });
    assert.ok(reviewTwo);
    fixture.board.settleRun(reviewTwo.run.runId, fixture.verifier.agentId, {
      outcome: "completed",
      result: "Review round two passed with a non-blocking documentation note.",
      handoff: reviewHandoff("passed"),
      reviewFindings: [reviewFinding(2, "docs")],
    });
    const finalApproval = fixture.board.requireWorkItem(fixture.workItem.workItemId);
    assert.equal(finalApproval.state, "final_approval");

    await fixture.board.rejectFinalApproval(fixture.workItem.workItemId, {
      version: finalApproval.version,
      note: "Revisit the last blocking review before approval.",
    });
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "fixing");
    const rejectedFix = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-mixed-review-history-final-rejection",
      messageCursor: null,
    });
    assert.ok(rejectedFix);
    assert.equal(rejectedFix.context.workflow?.fix?.round, 1);
    assert.deepEqual(
      rejectedFix.context.workflow?.fix?.findings.map((finding) => [finding.round, finding.category]),
      [
        [1, "correctness"],
        [1, "docs"],
      ]
    );
  } finally {
    fixture.board.close();
  }
});

test("retry, reassign, and human-answer recovery preserve a fix-round work item", async () => {
  const fixture = await pipelineFixture("fix-recovery-state", true);
  try {
    const review = await reachReview(fixture, "claim-fix-recovery-review");
    fixture.board.settleRun(review.run.runId, fixture.verifier.agentId, {
      outcome: "failed",
      result: "Review found a blocking defect.",
      handoff: reviewHandoff("failed"),
      reviewFindings: [reviewFinding(1)],
    });
    const failFixAttempt = (runId: string, agentId: string): void => {
      fixture.board.settleRun(runId, agentId, {
        outcome: "failed",
        result: "The fix task failed before it could finish.",
        handoff: {
          ...implementationHandoff(),
          outcome: "failed",
          summary: "The fix task failed before it could finish.",
          blockers: ["The fix task must be recovered."],
          recommendedReturnStage: null,
        },
      });
    };

    const firstFix = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-fix-recovery-initial",
      messageCursor: null,
    });
    assert.ok(firstFix?.task);
    failFixAttempt(firstFix.run.runId, fixture.engineer.agentId);
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "fixing");
    const failed = fixture.board.requireTask(firstFix.task.taskId);
    fixture.board.retryTask(failed.taskId, { version: failed.version });
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "fixing");

    const retriedFix = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-fix-recovery-retried",
      messageCursor: null,
    });
    assert.ok(retriedFix?.task);
    failFixAttempt(retriedFix.run.runId, fixture.engineer.agentId);
    const failedAgain = fixture.board.requireTask(retriedFix.task.taskId);
    const replacement = fixture.board.createAgent(fixture.project.projectId, {
      agentId: "fix-recovery-replacement-engineer",
      role: "engineer",
      area: "fix recovery",
      mission: "Recover a fix-round task without changing its work-item state.",
      model: "codex-mini",
      token: "fix-recovery-replacement-engineer-token-0123456789",
    });
    fixture.board.updateTask(
      failedAgain.taskId,
      {
        version: failedAgain.version,
        assignedAgentId: replacement.agentId,
        assignedRole: replacement.role,
      },
      { type: "human", id: "human:alice" }
    );
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "fixing");

    const reassignedFix = fixture.board.claimRun(replacement.agentId, {
      claimId: "claim-fix-recovery-reassigned",
      messageCursor: null,
    });
    assert.ok(reassignedFix?.task);
    const question = fixture.board.askQuestion(reassignedFix.task.taskId, replacement.agentId, {
      clientEventId: "question-fix-recovery-approval",
      question: "Should the recovered task preserve the blocking review context?",
      runId: reassignedFix.run.runId,
    });
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "parked");
    fixture.board.answerQuestion(question.questionId, {
      answer: "Yes. Continue the same fix round with its review context.",
      version: question.version,
    });
    const recovered = fixture.board.requireWorkItem(fixture.workItem.workItemId);
    assert.equal(recovered.state, "fixing");
    assert.equal(recovered.currentStage, "implementation");
  } finally {
    fixture.board.close();
  }
});

test("review findings are rejected outside a pipeline verification settle", async () => {
  const fixture = await pipelineFixture("findings-not-allowed", true);
  try {
    assert.throws(
      () =>
        fixture.board.settleRun(fixture.implementation.run.runId, fixture.engineer.agentId, {
          outcome: "completed",
          result: "Implementation attempted to submit review findings.",
          handoff: implementationHandoff(),
          reviewFindings: [reviewFinding(1)],
        }),
      (error: unknown) =>
        error instanceof TaskBoardError && error.code === TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_FINDINGS_NOT_ALLOWED
    );
    assert.deepEqual(persistedFindings(fixture.path), []);
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "implementing");
  } finally {
    fixture.board.close();
  }
});

test("a fix round re-runs machine verify before review and then reaches final approval", async () => {
  const fixture = await pipelineFixture("full-fix-loop", true);
  try {
    const reviewOne = await reachReview(fixture, "claim-full-fix-loop-review-1");
    fixture.board.settleRun(reviewOne.run.runId, fixture.verifier.agentId, {
      outcome: "failed",
      result: "Review round one failed.",
      handoff: reviewHandoff("failed"),
      reviewFindings: [reviewFinding(1)],
    });
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "fixing");

    const fix = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-full-fix-loop-implementation-2",
      messageCursor: null,
    });
    assert.ok(fix);
    await writeFile(join(fixture.repo, "src", "fix-round-1.txt"), "fix round one\n");
    await git(fixture.repo, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "src/fix-round-1.txt"]);
    await git(fixture.repo, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "fix review round one"]);
    fixture.board.settleRun(fix.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Fix round one complete.",
      handoff: implementationHandoff(),
    });
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "verifying");
    await driveVerify(fixture, "reviewing", 2);

    const reviewTwo = fixture.board.claimRun(fixture.verifier.agentId, {
      claimId: "claim-full-fix-loop-review-2",
      messageCursor: null,
    });
    assert.ok(reviewTwo);
    assert.deepEqual(
      reviewTwo.context.workflow?.review?.priorFindings.map((finding) => finding.round),
      [1]
    );
    fixture.board.settleRun(reviewTwo.run.runId, fixture.verifier.agentId, {
      outcome: "completed",
      result: "Review round two passed.",
      handoff: reviewHandoff("passed"),
      reviewFindings: [],
    });
    assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "final_approval");

    const db = new DatabaseSync(fixture.path);
    try {
      const states = (
        db
          .prepare(
            `
        SELECT to_state FROM work_item_transitions
        WHERE work_item_id=? ORDER BY sequence
      `
          )
          .all(fixture.workItem.workItemId) as Array<{ to_state: string }>
      ).map((row) => row.to_state);
      const fixingIndex = states.lastIndexOf("fixing");
      assert.deepEqual(states.slice(fixingIndex, fixingIndex + 4), [
        "fixing",
        "verifying",
        "reviewing",
        "final_approval",
      ]);
    } finally {
      db.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("pipeline review failures re-arm three fix rounds and dead-letter round four", async () => {
  const fixture = await pipelineFixture("review-cap", true);
  try {
    let review = await reachReview(fixture, "claim-review-cap-review-1");
    for (let round = 1; round <= 4; round += 1) {
      fixture.board.settleRun(review.run.runId, fixture.verifier.agentId, {
        outcome: "failed",
        result: `Review round ${round} failed.`,
        handoff: reviewHandoff("failed"),
        reviewFindings: [reviewFinding(round)],
      });
      const workItem = fixture.board.requireWorkItem(fixture.workItem.workItemId);
      if (round === 4) {
        assert.equal(workItem.state, "dead_letter");
        assert.equal(workItem.currentStage, null);
        assert.notEqual(workItem.endedAt, null);
        break;
      }
      assert.equal(workItem.state, "fixing");
      const fix = fixture.board.claimRun(fixture.engineer.agentId, {
        claimId: `claim-review-cap-fix-${round + 1}`,
        messageCursor: null,
      });
      assert.ok(fix);
      fixture.board.settleRun(fix.run.runId, fixture.engineer.agentId, {
        outcome: "completed",
        result: `Fix round ${round} complete.`,
        handoff: implementationHandoff(),
      });
      assert.equal(fixture.board.requireWorkItem(fixture.workItem.workItemId).state, "verifying");
      await driveVerify(fixture, "reviewing", round + 1);
      const nextReview = fixture.board.claimRun(fixture.verifier.agentId, {
        claimId: `claim-review-cap-review-${round + 1}`,
        messageCursor: null,
      });
      assert.ok(nextReview);
      review = nextReview;
    }
    assert.deepEqual(
      persistedFindings(fixture.path).map((finding) => finding.round),
      [1, 2, 3, 4]
    );
    assert.equal(fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]?.state, "blocked");
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
      const testingHandoffs = fixture.board
        .projectWorkflow(fixture.project.projectId)
        .handoffs.filter((handoff) => handoff.stage === "testing");
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
