import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { SettleRunRequest, StageHandoffDraft, WorkflowPlanDraft } from "#shared/task-board-contract";
import { redactMultilineForPersistence } from "../../../src/server/shared/redact.js";
import { TaskBoardError } from "#server/task-board";
import { onboardingDeliverablesCheck } from "../../../src/server/task-board/collaborators/onboarding-check.js";
import {
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  taskRequest,
  workItemRequest,
} from "./helpers.js";

type Fixture = Awaited<ReturnType<typeof boardFixture>>;
type OnboardingFixture = Fixture & Readonly<{
  repository: string;
  workItemId: string;
  implementationTaskId: string;
  implementationRunId: string;
  branch: string;
}>;
type GapReportSettlement = SettleRunRequest & Readonly<{ gapReport?: string }>;

const VALID_WORKFLOW = `# Workflow

\`\`\`json
{"version":1,"compile":["npm run build"],"rules":[{"match":"**","action":{"kind":"self"}}],"full":["npm test"]}
\`\`\`
`;

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(stderr));
      else resolve(stdout);
    });
  });
}

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steward-onboarding-settle-"));
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
    acceptanceCriteria: ["Every required onboarding deliverable is present."],
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["README.md", "docs", "Dockerfile"],
    nonGoals: ["Do not configure branch protection."],
    mechanicalPortions: [],
    blockingQuestions: [],
    criterionChecks: [],
    nodes: [{
      nodeId: "onboarding-deliverables",
      title: "Create onboarding deliverables",
      objective: "Create the documentation and verification contract.",
      acceptanceCriteria: ["Required documentation and the gap report are present."],
      dependencyNodeIds: [],
      stageTemplate: ["implementation", "testing", "verification"],
    }],
  };
}

function handoff(): StageHandoffDraft {
  return {
    outcome: "passed",
    summary: "Onboarding implementation is complete.",
    evidence: ["The deliverables were inspected."],
    artifactIds: [],
    acceptanceCriteria: [{
      criterion: "Required onboarding deliverables are present.",
      passed: true,
      evidence: "The branch contains the deliverables.",
    }],
    blockers: [],
    recommendedReturnStage: null,
  };
}

async function onboardingFixture(suffix: string): Promise<OnboardingFixture> {
  const fixture = await boardFixture();
  const repository = await fixtureRepo();
  const writable = new DatabaseSync(fixture.path);
  try {
    writable.prepare("UPDATE projects SET description=? WHERE project_id=?")
      .run(repository, fixture.project.projectId);
  } finally {
    writable.close();
  }
  const implementationType = {
    agentTypeId: `onboarding-implementation-${suffix}`,
    name: "Onboarding implementation",
    description: "Creates onboarding deliverables.",
    role: "engineer" as const,
    supplementalInstructions: "Implement the confirmed onboarding plan.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  const verificationType = {
    ...implementationType,
    agentTypeId: `onboarding-verification-${suffix}`,
    name: "Onboarding verification",
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
  const workItem = fixture.board.createWorkItemAndStartPlanning(workItemRequest({
    taskType: "onboarding",
    originalRequest: "Onboard this repository.",
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), `onboarding-settle-${suffix}`).workItem;
  const planning = fixture.board.claimRun(fixture.manager.agentId, {
    claimId: `claim-onboarding-planning-${suffix}`,
    messageCursor: null,
  });
  assert.ok(planning);
  fixture.board.settleRun(planning.run.runId, fixture.manager.agentId, {
    outcome: "completed",
    result: "The onboarding plan is ready.",
    workflowPlan: onboardingPlan(),
  });
  const revision = fixture.board.projectWorkflow(fixture.project.projectId).plans
    .find((candidate) => candidate.state === "proposed");
  assert.ok(revision);
  fixture.board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
  const implementation = fixture.board.claimRun(fixture.engineer.agentId, {
    claimId: `claim-onboarding-implementation-${suffix}`,
    messageCursor: null,
  });
  assert.ok(implementation?.task);
  const inspected = new DatabaseSync(fixture.path, { readOnly: true });
  try {
    const branch = inspected.prepare("SELECT pipeline_branch FROM work_items WHERE work_item_id=?")
      .get(workItem.workItemId)?.pipeline_branch;
    assert.equal(typeof branch, "string");
    return {
      ...fixture,
      repository,
      workItemId: workItem.workItemId,
      implementationTaskId: implementation.task.taskId,
      implementationRunId: implementation.run.runId,
      branch: String(branch),
    };
  } catch (error) {
    fixture.board.close();
    throw error;
  } finally {
    inspected.close();
  }
}

async function commitDeliverables(
  fixture: OnboardingFixture,
  overrides: Readonly<{ omit?: string; workflow?: string }> = {},
): Promise<void> {
  await git(fixture.repository, ["checkout", "-b", fixture.branch]);
  const files: Readonly<Record<string, string>> = {
    "README.md": "# Fixture project\n",
    "docs/architecture.md": "# Architecture\n",
    "docs/interface.md": "# Interface\n",
    "docs/dependencies.md": "# Dependencies\n",
    "docs/workflow.md": overrides.workflow ?? VALID_WORKFLOW,
    "docs/decisions/2026-08-25-onboarding.md": "# Onboard the project\n",
  };
  for (const [path, content] of Object.entries(files)) {
    if (path === overrides.omit) continue;
    const absolutePath = join(fixture.repository, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  await git(fixture.repository, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "."]);
  await git(fixture.repository, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "add onboarding deliverables"]);
}

function settleImplementation(fixture: OnboardingFixture, gapReport?: string) {
  const request: GapReportSettlement = {
    outcome: "completed",
    result: "Onboarding implementation is complete.",
    handoff: handoff(),
    ...(gapReport === undefined ? {} : { gapReport }),
  };
  return fixture.board.settleRun(
    fixture.implementationRunId,
    fixture.engineer.agentId,
    request,
  );
}

function assertDeliverablesError(operation: () => unknown, pattern: RegExp): void {
  assert.throws(operation, (error: unknown) => error instanceof TaskBoardError
    && error.status === 400
    && error.code === "ONBOARDING_DELIVERABLES_MISSING"
    && pattern.test(error.message));
}

async function driveFailedMachineVerifyToImplementation(fixture: OnboardingFixture): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await fixture.board.sweepVerifyAttempts();
    if (fixture.board.requireWorkItem(fixture.workItemId).state === "implementing") return;
    await delay(25);
  }
  assert.fail(`machine testing did not return to implementation; current=${fixture.board.requireWorkItem(fixture.workItemId).state}`);
}

test("onboarding implementation settlement rejects every missing deliverable without mutating the active attempt", async () => {
  const fixture = await onboardingFixture("missing-interface");
  try {
    await commitDeliverables(fixture, { omit: "docs/interface.md" });

    assertDeliverablesError(() => settleImplementation(fixture, "# Gaps\n\n- Branch protection is deferred."), /docs\/interface\.md/u);

    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(inspected.prepare("SELECT status FROM runs WHERE run_id=?").get(fixture.implementationRunId)?.status, "active");
      assert.equal(inspected.prepare("SELECT status FROM tasks WHERE task_id=?").get(fixture.implementationTaskId)?.status, "in_progress");
      assert.equal(inspected.prepare("SELECT state FROM work_items WHERE work_item_id=?").get(fixture.workItemId)?.state, "implementing");
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM artifacts").get()?.count, 0);
    } finally {
      inspected.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("onboarding implementation settlement names an invalid workflow contract", async () => {
  const fixture = await onboardingFixture("invalid-workflow");
  try {
    await commitDeliverables(fixture, {
      workflow: "# Workflow\n\n```json\nnot json\n```\n",
    });

    assertDeliverablesError(
      () => settleImplementation(fixture, "# Gaps\n\n- Branch protection is deferred."),
      /docs\/workflow\.md VerifyContract: invalid JSON in fenced json block/u,
    );
  } finally {
    fixture.board.close();
  }
});

test("onboarding implementation settlement names an empty decisions directory", async () => {
  const fixture = await onboardingFixture("missing-decisions");
  try {
    await commitDeliverables(fixture, { omit: "docs/decisions/2026-08-25-onboarding.md" });

    assertDeliverablesError(
      () => settleImplementation(fixture, "# Gaps\n\n- Branch protection is deferred."),
      /docs\/decisions\/ is missing or empty/u,
    );
  } finally {
    fixture.board.close();
  }
});

test("onboarding validation fails closed before git when either repository identity field is empty", () => {
  for (const [repoPath, branch, expected] of [
    ["", "task/onboarding", ["repo_path is missing or empty"]],
    ["/repo", " \t", ["pipeline_branch is missing or empty"]],
  ] as const) {
    let gitCalls = 0;
    const result = onboardingDeliverablesCheck(repoPath, branch, "# Gaps\n", () => {
      gitCalls += 1;
      throw new Error("git must not run");
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, expected);
    assert.equal(gitCalls, 0);
  }
});

test("onboarding settlement detail retains later missing items after a long contract error", async () => {
  const fixture = await onboardingFixture("bounded-error-detail");
  try {
    const oversizedUnknownField = "x".repeat(5_000);
    await commitDeliverables(fixture, {
      workflow: `# Workflow\n\n\`\`\`json\n{"version":1,"compile":["npm run build"],"rules":[{"match":"**","action":{"kind":"self"}}],"full":["npm test"],"${oversizedUnknownField}":true}\n\`\`\`\n`,
    });

    assert.throws(() => settleImplementation(fixture), (error: unknown) => error instanceof TaskBoardError
      && error.status === 400
      && error.code === "ONBOARDING_DELIVERABLES_MISSING"
      && error.message.length <= 2_000
      && /docs\/workflow\.md VerifyContract: contract has unknown field/u.test(error.message)
      && /gap report is missing or empty/u.test(error.message));
  } finally {
    fixture.board.close();
  }
});

test("onboarding implementation settlement requires a non-empty gap report", async () => {
  const fixture = await onboardingFixture("missing-gap-report");
  try {
    await commitDeliverables(fixture);

    assertDeliverablesError(() => settleImplementation(fixture), /gap report/u);
    assertDeliverablesError(() => settleImplementation(fixture, " \n\t"), /gap report/u);
    const persisted = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const rejections = persisted.prepare(`
        SELECT data_json
        FROM task_events
        WHERE task_id=? AND event_type='settlement_rejected'
        ORDER BY sequence
      `).all(fixture.implementationTaskId);
      assert.equal(rejections.length, 2);
      assert.deepEqual(JSON.parse(String(rejections[0]?.data_json)), {
        code: "ONBOARDING_DELIVERABLES_MISSING",
        detail: "Onboarding deliverables are missing: gap report is missing or empty",
        retractedOutputCount: 0,
        runId: fixture.implementationRunId,
      });
    } finally {
      persisted.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("a rejection-trace write failure preserves the original typed settlement error", async () => {
  const fixture = await onboardingFixture("rejection-trace-failure");
  const originalConsoleError = console.error;
  const logged: unknown[][] = [];
  try {
    await commitDeliverables(fixture);
    const writable = new DatabaseSync(fixture.path);
    try {
      writable.exec(`
        CREATE TRIGGER reject_settlement_rejected_event
        BEFORE INSERT ON task_events
        WHEN NEW.event_type='settlement_rejected'
        BEGIN
          SELECT RAISE(ABORT, 'simulated settlement rejection trace failure');
        END
      `);
    } finally {
      writable.close();
    }
    console.error = (...data: unknown[]): void => { logged.push(data); };

    assertDeliverablesError(() => settleImplementation(fixture), /gap report/u);
    assert.match(String(logged[0]?.[0]), /settlement rejection recording failed/u);
    assert.match(String(logged[0]?.[0]), new RegExp(fixture.implementationRunId, "u"));
  } finally {
    console.error = originalConsoleError;
    fixture.board.close();
  }
});

test("successful onboarding implementation stores and surfaces the durable redacted gap-report identity", async () => {
  const fixture = await onboardingFixture("success");
  try {
    await commitDeliverables(fixture);
    const secret = "Bearer abcdefghijklmnopqrstuvwxyz";
    const report = `# Gaps\n\n- Branch protection is deferred.\n- Credential sample: ${secret}\n`;
    const nodeId = fixture.board.projectWorkflow(fixture.project.projectId).nodes[0]!.nodeId;
    const spoof = await fixture.board.createArtifact(fixture.project.projectId, {
      nodeId,
      taskId: fixture.implementationTaskId,
      mediaType: "text/markdown",
      caption: "Onboarding gap report",
      contentBase64: Buffer.from("# Human-authored artifact\n", "utf8").toString("base64"),
    });

    const settled = settleImplementation(fixture, report);

    assert.equal(settled.run.status, "completed");
    const detail = fixture.board.requireWorkItem(fixture.workItemId) as ReturnType<Fixture["board"]["requireWorkItem"]> & {
      readonly gapReportArtifactId: string | null;
    };
    assert.match(detail.gapReportArtifactId ?? "", /^artifact_/u);
    assert.notEqual(detail.gapReportArtifactId, spoof.artifactId);
    const stored = await fixture.board.artifactContent(detail.gapReportArtifactId!);
    assert.equal(stored.artifact.projectId, fixture.project.projectId);
    assert.equal(stored.artifact.nodeId, nodeId);
    assert.equal(stored.artifact.taskId, fixture.implementationTaskId);
    assert.equal(stored.artifact.mediaType, "text/markdown");
    assert.equal(stored.bytes.toString("utf8"), redactMultilineForPersistence(report));
    assert.equal(stored.bytes.toString("utf8"), "# Gaps\n\n- Branch protection is deferred.\n- Credential sample: [redacted:bearer]\n");
    assert.doesNotMatch(stored.bytes.toString("utf8"), /abcdefghijklmnopqrstuvwxyz/u);
    assert.ok(fixture.board.listProjectEvents(fixture.project.projectId).some((event) =>
      event.eventType === "artifact_created" &&
      event.nodeId === nodeId &&
      event.taskId === fixture.implementationTaskId &&
      event.summary === "Onboarding gap report"));
    const persisted = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(
        persisted.prepare(`
          SELECT gap_report_artifact_id
          FROM work_item_onboarding_tasks
          WHERE work_item_id=?
        `).get(fixture.workItemId)?.gap_report_artifact_id,
        detail.gapReportArtifactId,
      );
    } finally {
      persisted.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("a later implementation attempt replaces the gap-report artifact while a duplicate settle stays idempotent", async () => {
  const fixture = await onboardingFixture("fresh-gap-report");
  try {
    await commitDeliverables(fixture);
    const firstReport = "# Gaps\n\n- First implementation report.\n";
    const firstRequest: GapReportSettlement = {
      outcome: "completed",
      result: "First onboarding implementation is complete.",
      handoff: handoff(),
      gapReport: firstReport,
    };
    const firstSettle = fixture.board.settleRun(
      fixture.implementationRunId,
      fixture.engineer.agentId,
      firstRequest,
    );
    assert.equal(firstSettle.duplicate, false);
    const duplicate = fixture.board.settleRun(
      fixture.implementationRunId,
      fixture.engineer.agentId,
      firstRequest,
    );
    assert.equal(duplicate.duplicate, true);
    const firstDetail = fixture.board.requireWorkItem(fixture.workItemId) as ReturnType<Fixture["board"]["requireWorkItem"]> & {
      readonly gapReportArtifactId: string | null;
    };
    const firstArtifactId = firstDetail.gapReportArtifactId;
    assert.match(firstArtifactId ?? "", /^artifact_/u);

    await driveFailedMachineVerifyToImplementation(fixture);
    const secondImplementation = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-onboarding-second-implementation-fresh-gap-report",
      messageCursor: null,
    });
    assert.ok(secondImplementation?.task);
    assert.notEqual(secondImplementation.task.taskId, fixture.implementationTaskId);
    const secondReport = "# Gaps\n\n- Corrected implementation report.\n";
    fixture.board.settleRun(secondImplementation.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "Corrected onboarding implementation is complete.",
      handoff: handoff(),
      gapReport: secondReport,
    });

    const secondDetail = fixture.board.requireWorkItem(fixture.workItemId) as typeof firstDetail;
    assert.match(secondDetail.gapReportArtifactId ?? "", /^artifact_/u);
    assert.notEqual(secondDetail.gapReportArtifactId, firstArtifactId);
    const firstArtifact = await fixture.board.artifactContent(firstArtifactId!);
    const secondArtifact = await fixture.board.artifactContent(secondDetail.gapReportArtifactId!);
    assert.equal(firstArtifact.bytes.toString("utf8"), firstReport);
    assert.equal(secondArtifact.bytes.toString("utf8"), secondReport);
    assert.equal(secondArtifact.artifact.taskId, secondImplementation.task.taskId);
    assert.equal(
      fixture.board.listProjectEvents(fixture.project.projectId).filter((event) =>
        event.eventType === "artifact_created" && event.summary === "Onboarding gap report").length,
      2,
    );
  } finally {
    fixture.board.close();
  }
});

test("a repair-time onboarding rejection leaves a completed run's outputs and event history intact", async () => {
  const fixture = await onboardingFixture("settled-repair-rejection");
  try {
    await commitDeliverables(fixture);
    const request: GapReportSettlement = {
      outcome: "completed",
      result: "Onboarding implementation is complete before repair replay.",
      handoff: handoff(),
      gapReport: "# Gaps\n\n- Branch protection is deferred.\n",
    };
    fixture.board.appendAgentMessage(fixture.implementationTaskId, fixture.engineer.agentId, {
      clientEventId: `twe_${"d".repeat(64)}`,
      runId: fixture.implementationRunId,
      kind: "result",
      body: request.result,
    });
    const initial = fixture.board.settleRun(
      fixture.implementationRunId,
      fixture.engineer.agentId,
      request,
    );
    assert.equal(initial.run.status, "completed");

    await git(fixture.repository, ["rm", "docs/interface.md"]);
    await git(fixture.repository, [
      "-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "remove onboarding interface doc",
    ]);
    const partial = new DatabaseSync(fixture.path);
    try {
      partial.exec("PRAGMA foreign_keys = ON");
      partial.prepare("DELETE FROM stage_handoffs WHERE task_id=?").run(fixture.implementationTaskId);
      partial.prepare(`
        UPDATE work_nodes
        SET state='active',current_stage='implementation'
        WHERE node_id=(SELECT node_id FROM stage_attempts WHERE task_id=? AND stage='implementation')
      `).run(fixture.implementationTaskId);
    } finally {
      partial.close();
    }

    assertDeliverablesError(
      () => fixture.board.settleRun(fixture.implementationRunId, fixture.engineer.agentId, request),
      /docs\/interface\.md/u,
    );
    assert.deepEqual(
      fixture.board.listMessages(fixture.implementationTaskId).map((message) => message.body),
      [request.result],
    );
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(inspected.prepare(`
        SELECT COUNT(*) AS count
        FROM task_events
        WHERE event_type='settlement_rejected' AND json_extract(data_json,'$.runId')=?
      `).get(fixture.implementationRunId)?.count, 0);
    } finally {
      inspected.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("standard work items settle without onboarding deliverable validation or a gap report", async () => {
  const fixture = await boardFixture();
  try {
    const task = fixture.board.createTask(fixture.project.projectId, taskRequest({
      title: "Settle a standard task",
      workspaceRefs: [],
    }));
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-standard-settlement-bypass",
      messageCursor: null,
    });
    assert.ok(claim);
    assert.equal(claim.task?.taskId, task.taskId);

    const settled = fixture.board.settleRun(claim.run.runId, fixture.engineer.agentId, {
      outcome: "completed",
      result: "The standard task is complete.",
    });

    assert.equal(settled.run.status, "completed");
    assert.equal(fixture.board.requireTask(task.taskId).status, "completed");
  } finally {
    fixture.board.close();
  }
});
