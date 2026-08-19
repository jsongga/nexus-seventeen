import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type {
  BoardSnapshot,
  ClaimRunResult,
  PipelineSummary,
  PlanRevision,
  Project,
  StageHandoff,
  WorkItem,
  WorkNode,
} from "#shared/task-board-contract";
import {
  ContainedCliAgentLauncher,
  HttpTaskBoardClient,
  TaskWorker,
} from "#server/agents/task-worker";
import { TaskWorkspaceManager, WorkspaceScopedLauncher } from "#server/agents/task-workspace";
import {
  createTaskBoardService,
  normalizeTaskBoardConfig,
  TaskBoard,
  type TaskBoardService,
} from "#server/task-board";
import { automationConfigurationRequest, automationStages } from "./helpers.js";

const HUMAN_TOKEN = "pipeline-e2e-human-token-0123456789abcdef";
const MANAGER_TOKEN = "pipeline-e2e-manager-token-0123456789abcdef";
const ENGINEER_TOKEN = "pipeline-e2e-engineer-token-0123456789abcdef";
const RAW_REQUEST = "Deliver the scoped Pipeline v1 fixture change.";
const REJECTION_NOTE = "Make the second plan explicitly identify the two reviewable commits.";
const CHECKED_CRITERION = "The fixture criterion command passes.";
const HUMAN_CRITERION = "The implementation uses two reviewable commits.";
const MID_RUN_ASSUMPTION = "Implementation selected a plain-text fixture marker.";

type EngineerMode = "scoped" | "outside_scope" | "merge_conflict";

interface WorkflowSnapshot {
  readonly plans: readonly PlanRevision[];
  readonly nodes: readonly WorkNode[];
  readonly handoffs: readonly StageHandoff[];
}

interface FakeCliFixture {
  readonly bin: string;
  readonly working: string;
  readonly scratch: string;
}

interface PipelineFixture {
  readonly root: string;
  readonly repo: string;
  readonly dbPath: string;
  readonly origin: string;
  readonly service: TaskBoardService;
  readonly sweepBoard: TaskBoard;
  readonly project: Project;
  readonly workItem: WorkItem;
  readonly managerId: string;
  readonly engineerId: string;
  readonly managerWorker: TaskWorker;
  readonly engineerWorker: TaskWorker;
  readonly managerScratch: string;
  readonly workspaceRoot: string;
  readonly verifyWorkspaceRoot: string;
  readonly declaredScope: readonly string[];
}

interface FixtureOptions {
  readonly suffix: string;
  readonly engineerMode: EngineerMode;
  readonly verifyPasses: boolean;
  readonly declaredScope?: readonly string[];
}

function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...arguments_], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(stderr));
      else resolve(stdout);
    });
  });
}

async function jsonRequest<T>(
  origin: string,
  path: string,
  method: "GET" | "POST" | "PATCH",
  expectedStatus: number,
  options: Readonly<{ token?: string; body?: unknown; idempotencyKey?: string }> = {},
): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${options.token ?? HUMAN_TOKEN}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.idempotencyKey === undefined ? {} : { "Idempotency-Key": options.idempotencyKey }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, text);
  return JSON.parse(text) as T;
}

async function fakeCodex(root: string, label: string, source: string): Promise<FakeCliFixture> {
  const base = join(root, label);
  const bin = join(base, "bin");
  const working = join(base, "working");
  const scratch = join(base, "scratch");
  await mkdir(bin, { recursive: true });
  await mkdir(working, { recursive: true });
  await mkdir(scratch, { recursive: true });
  const executable = join(bin, "codex");
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { bin, working, scratch };
}

function managerCliSource(suffix: string, declaredScope: readonly string[]): string {
  return `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const statePath = path.join(process.env.TMPDIR, "manager-runs.txt");
  let previous = 0;
  try { previous = Number(fs.readFileSync(statePath, "utf8")); } catch {}
  const revision = previous + 1;
  fs.writeFileSync(statePath, String(revision));
  fs.writeFileSync(path.join(process.env.TMPDIR, "prompt-" + revision + ".txt"), input);
  const workflowPlan = {
    objective: "Deliver the scoped Pipeline v1 fixture plan v" + revision + ".",
    assumptions: ["The fixture repository stays available."],
    acceptanceCriteria: [${JSON.stringify(CHECKED_CRITERION)}, ${JSON.stringify(HUMAN_CRITERION)}],
    changeShape: "feature",
    tier: "standard",
    declaredScope: ${JSON.stringify(declaredScope)},
    nonGoals: ["Do not change files outside the declared scope."],
    mechanicalPortions: ["Add two deterministic fixture files."],
    blockingQuestions: [{
      question: "Should the fixture use a published interface?",
      recommendedDefault: "No; keep the change local to fixture files."
    }],
    criterionChecks: [{ criterion: ${JSON.stringify(CHECKED_CRITERION)}, check: "node criterion-check.mjs" }],
    nodes: [{
      nodeId: ${JSON.stringify(`pipeline-${suffix}-v`)} + revision,
      title: "Implement the Pipeline v1 fixture",
      objective: "Create two scoped commits and pass machine verification.",
      acceptanceCriteria: [${JSON.stringify(HUMAN_CRITERION)}],
      dependencyNodeIds: [],
      stageTemplate: ["implementation", "testing"]
    }]
  };
  const result = {
    status: "completed",
    progress: ["The complete pipeline plan is ready for human review."],
    result: "Pipeline plan v" + revision + " is ready.",
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    handoff: null,
    workflowPlan,
    detail: "Pipeline plan v" + revision + " is ready."
  };
  process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(result)}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"turn.completed"}) + "\\n");
});
`;
}

function engineerCliSource(mode: EngineerMode): string {
  const secondPath = mode === "outside_scope"
    ? "docs/outside.md"
    : mode === "merge_conflict" ? "shared.txt" : "src/allowed/second.txt";
  return `
process.stdin.resume();
process.stdin.on("end", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const child = require("node:child_process");
  const runGit = (args) => {
    const result = child.spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || "git failed");
  };
  const commit = (file, content, subject) => {
    fs.mkdirSync(path.dirname(path.join(process.cwd(), file)), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), file), content);
    runGit(["add", "--", file]);
    runGit(["-c", "user.name=Pipeline Test", "-c", "user.email=pipeline@test.invalid", "commit", "-m", subject]);
  };
  commit("src/allowed/first.txt", "first scoped change\\n", "pipeline step one");
  commit(${JSON.stringify(secondPath)}, "second pipeline change\\n", "pipeline step two");
  const result = {
    status: "completed",
    progress: ["Two logical commits are ready for verification."],
    result: "The staged pipeline implementation is complete.",
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    handoff: {
      outcome: "passed",
      summary: "Two staged commits are ready for machine verification.",
      evidence: ["The fixture repository stays available.", ${JSON.stringify(MID_RUN_ASSUMPTION)}],
      artifactIds: [],
      acceptanceCriteria: [{
        criterion: ${JSON.stringify(HUMAN_CRITERION)},
        passed: true,
        evidence: "The task branch contains two logical commits."
      }],
      blockers: [],
      recommendedReturnStage: null
    },
    workflowPlan: null,
    detail: "The staged pipeline implementation is complete."
  };
  process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(result)}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"turn.completed"}) + "\\n");
});
`;
}

async function fixtureRepository(root: string, verifyPasses: boolean): Promise<string> {
  const repo = join(root, "repo");
  await git(root, ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.name", "Pipeline Test"]);
  await git(repo, ["config", "user.email", "pipeline@test.invalid"]);
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(repo, "readme.md"), "Pipeline v1 fixture repository.\n");
  await writeFile(join(repo, "shared.txt"), "base shared value\n");
  await writeFile(
    join(repo, "docs", "workflow.md"),
    `# Verify workflow\n\n\`\`\`json\n${JSON.stringify({
      version: 1,
      compile: ["node verify-compile.mjs"],
      rules: [{ match: "**", action: { kind: "none" } }],
      full: ["node verify-full.mjs"],
    }, null, 2)}\n\`\`\`\n`,
  );
  await writeFile(join(repo, "verify-compile.mjs"), 'process.stdout.write("compile marker reached\\n");\n');
  await writeFile(
    join(repo, "verify-full.mjs"),
    verifyPasses
      ? 'process.stdout.write("full verify passed\\n");\n'
      : 'process.stderr.write("intentional full verify failure\\n"); process.exit(9);\n',
  );
  await writeFile(join(repo, "criterion-check.mjs"), 'process.stdout.write("criterion passed\\n");\n');
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture base"]);
  return repo;
}

async function createFixture(options: FixtureOptions): Promise<PipelineFixture> {
  const root = await mkdtemp(join(tmpdir(), `steward-pipeline-e2e-${options.suffix}-`));
  const repo = await fixtureRepository(root, options.verifyPasses);
  const dbPath = join(root, "board", "task-board.sqlite");
  const verifyWorkspaceRoot = join(root, "verify-workspaces");
  const boardOptions = {
    dbPath,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:pipeline-reviewer",
    port: 0,
    reconcileIntervalSeconds: 0,
    verifyWorkspaceRoot,
  } as const;
  const service = await createTaskBoardService(boardOptions);
  const address = await service.start();
  const sweepBoard = await TaskBoard.open(normalizeTaskBoardConfig(boardOptions));
  const { project } = await jsonRequest<{ project: Project }>(address.url, "/v1/projects", "POST", 201, {
    body: { name: `Pipeline fixture ${options.suffix}`, description: repo },
  });
  const managerId = `pipeline-${options.suffix}-manager`;
  const engineerId = `pipeline-${options.suffix}-engineer`;
  await jsonRequest(address.url, `/v1/projects/${project.projectId}/agents`, "POST", 201, {
    body: {
      agentId: managerId,
      role: "manager",
      area: "pipeline planning",
      mission: "Return complete Pipeline v1 plans for human approval.",
      model: "fake-codex",
      token: MANAGER_TOKEN,
    },
  });
  await jsonRequest(address.url, `/v1/projects/${project.projectId}/agents`, "POST", 201, {
    body: {
      agentId: engineerId,
      role: "engineer",
      area: "pipeline implementation",
      mission: "Implement only the confirmed declared scope and commit each logical change.",
      model: "fake-codex",
      token: ENGINEER_TOKEN,
    },
  });
  const engineerType = {
    agentTypeId: `pipeline-${options.suffix}-engineer-type`,
    name: "Pipeline engineer",
    description: "Implements the confirmed Pipeline v1 fixture.",
    role: "engineer" as const,
    supplementalInstructions: "Commit only files in the confirmed declared scope.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  await jsonRequest(address.url, "/v1/automation-configuration", "PATCH", 200, {
    body: automationConfigurationRequest({
      agentTypes: [engineerType],
      stages: automationStages({
        implementation: { kind: "agent_type", agentTypeId: engineerType.agentTypeId },
        testing: { kind: "machine_verify" },
      }),
    }),
  });

  const declaredScope = options.declaredScope ?? ["src/allowed"];
  const managerCli = await fakeCodex(root, "manager-cli", managerCliSource(options.suffix, declaredScope));
  const engineerCli = await fakeCodex(root, "engineer-cli", engineerCliSource(options.engineerMode));
  const managerWorker = await TaskWorker.create({
    identity: { workerId: `pipeline-${options.suffix}-manager-worker`, agentId: managerId },
    statePath: join(root, "manager-worker", "journal.json"),
    board: new HttpTaskBoardClient({ baseUrl: address.url, token: MANAGER_TOKEN }),
    launcher: new ContainedCliAgentLauncher({
      provider: "codex",
      model: "fake-codex",
      workingDirectory: managerCli.working,
      environment: {
        PATH: `${managerCli.bin}${delimiter}${process.env.PATH ?? ""}`,
        TMPDIR: managerCli.scratch,
      },
      timeoutMs: 5_000,
      terminationGraceMs: 10,
      groupAbsenceTimeoutMs: 2_000,
    }),
    longPollMs: 1,
  });
  const workspaceRoot = join(root, "implementation-workspaces");
  const engineerLauncher = new WorkspaceScopedLauncher(
    new ContainedCliAgentLauncher({
      provider: "codex",
      model: "fake-codex",
      workingDirectory: engineerCli.working,
      environment: {
        PATH: `${engineerCli.bin}${delimiter}${process.env.PATH ?? ""}`,
        TMPDIR: engineerCli.scratch,
      },
      timeoutMs: 5_000,
      terminationGraceMs: 10,
      groupAbsenceTimeoutMs: 2_000,
    }),
    new TaskWorkspaceManager({ workspaceRoot, repositoryPath: repo }),
  );
  const engineerWorker = await TaskWorker.create({
    identity: { workerId: `pipeline-${options.suffix}-engineer-worker`, agentId: engineerId },
    statePath: join(root, "engineer-worker", "journal.json"),
    board: new HttpTaskBoardClient({ baseUrl: address.url, token: ENGINEER_TOKEN }),
    launcher: engineerLauncher,
    longPollMs: 1,
  });
  const { workItem } = await jsonRequest<{ workItem: WorkItem }>(address.url, "/v1/work-items", "POST", 201, {
    idempotencyKey: `pipeline-e2e-${options.suffix}`,
    body: {
      originalRequest: RAW_REQUEST,
      priority: "normal",
      projectTarget: { mode: "explicit", projectId: project.projectId },
    },
  });
  assert.equal(workItem.state, "planning");
  return {
    root,
    repo,
    dbPath,
    origin: address.url,
    service,
    sweepBoard,
    project,
    workItem,
    managerId,
    engineerId,
    managerWorker,
    engineerWorker,
    managerScratch: managerCli.scratch,
    workspaceRoot,
    verifyWorkspaceRoot,
    declaredScope,
  };
}

async function closeFixture(fixture: PipelineFixture): Promise<void> {
  await fixture.managerWorker.close();
  await fixture.engineerWorker.close();
  fixture.sweepBoard.close();
  await fixture.service.close();
}

async function workflow(fixture: PipelineFixture): Promise<WorkflowSnapshot> {
  return (await jsonRequest<{ workflow: WorkflowSnapshot }>(
    fixture.origin,
    `/v1/projects/${fixture.project.projectId}/workflow`,
    "GET",
    200,
  )).workflow;
}

async function currentWorkItem(fixture: PipelineFixture): Promise<WorkItem> {
  return (await jsonRequest<{ workItem: WorkItem }>(
    fixture.origin,
    `/v1/work-items/${fixture.workItem.workItemId}`,
    "GET",
    200,
  )).workItem;
}

function proposedPlan(snapshot: WorkflowSnapshot, workItemId: string): PlanRevision {
  const plan = snapshot.plans.find((candidate) =>
    candidate.workItemId === workItemId && candidate.state === "proposed");
  assert.ok(plan);
  return plan;
}

function assertCompletePlan(plan: PlanRevision, declaredScope: readonly string[]): void {
  assert.equal(plan.changeShape, "feature");
  assert.equal(plan.tier, "standard");
  assert.deepEqual(plan.declaredScope, declaredScope);
  assert.deepEqual(plan.nonGoals, ["Do not change files outside the declared scope."]);
  assert.deepEqual(plan.mechanicalPortions, ["Add two deterministic fixture files."]);
  assert.deepEqual(plan.blockingQuestions, [{
    question: "Should the fixture use a published interface?",
    recommendedDefault: "No; keep the change local to fixture files.",
  }]);
  assert.deepEqual(plan.criterionChecks, [{ criterion: CHECKED_CRITERION, check: "node criterion-check.mjs" }]);
}

async function proposeAndConfirm(fixture: PipelineFixture, rejectOnce: boolean): Promise<PlanRevision> {
  assert.equal(await fixture.managerWorker.dispatchOnce(), true);
  assert.equal((await currentWorkItem(fixture)).state, "plan_approval");
  let snapshot = await workflow(fixture);
  const first = proposedPlan(snapshot, fixture.workItem.workItemId);
  assert.equal(first.revision, 1);
  assertCompletePlan(first, fixture.declaredScope);
  assert.deepEqual(snapshot.nodes.find((node) => node.planRevisionId === first.planRevisionId)?.stageTemplate, [
    "implementation",
    "testing",
  ]);

  let selected = first;
  if (rejectOnce) {
    const rejected = await jsonRequest<{ outcome: string }>(
      fixture.origin,
      `/v1/plans/${first.planRevisionId}/reject`,
      "POST",
      200,
      { body: { note: REJECTION_NOTE, expectedState: "proposed" } },
    );
    assert.deepEqual(rejected, { outcome: "revising" });
    const revising = await currentWorkItem(fixture);
    assert.equal(revising.state, "planning");
    assert.ok(revising.planningTaskId);
    const board = await jsonRequest<BoardSnapshot>(
      fixture.origin,
      `/v1/projects/${fixture.project.projectId}/board`,
      "GET",
      200,
    );
    assert.equal(
      board.tasks.find((task) => task.taskId === revising.planningTaskId)?.objective,
      `Prior plan rejected: ${REJECTION_NOTE}\n\n${RAW_REQUEST}`,
    );

    assert.equal(await fixture.managerWorker.dispatchOnce(), true);
    assert.match(
      await readFile(join(fixture.managerScratch, "prompt-2.txt"), "utf8"),
      new RegExp(`Prior plan rejected: ${REJECTION_NOTE}`, "u"),
    );
    snapshot = await workflow(fixture);
    selected = proposedPlan(snapshot, fixture.workItem.workItemId);
    assert.equal(selected.revision, 2);
    assert.match(selected.objective, /v2\.$/u);
    assertCompletePlan(selected, fixture.declaredScope);
    assert.equal(snapshot.plans.find((plan) => plan.planRevisionId === first.planRevisionId)?.state, "rejected");
    assert.equal(snapshot.plans.find((plan) => plan.planRevisionId === first.planRevisionId)?.rejectedNote, REJECTION_NOTE);
  }

  assert.equal((await currentWorkItem(fixture)).state, "plan_approval");
  await jsonRequest(
    fixture.origin,
    `/v1/plans/${selected.planRevisionId}/confirm`,
    "POST",
    200,
    { body: { expectedState: "proposed" } },
  );
  const confirmed = await currentWorkItem(fixture);
  assert.equal(confirmed.state, "implementing");
  assert.equal(confirmed.pipelineBranch, `task/${fixture.workItem.workItemId}`);
  assert.match(confirmed.baseSha ?? "", /^[0-9a-f]{40,64}$/u);
  return selected;
}

async function driveVerify(
  fixture: PipelineFixture,
  expectedState: "implementing" | "final_approval",
): Promise<WorkItem> {
  const startDeadline = Date.now() + 5_000;
  let launchState = "";
  while (Date.now() < startDeadline) {
    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      launchState = String(db.prepare(`
        SELECT state
        FROM verify_attempts
        ORDER BY created_at DESC, verify_attempt_id DESC
        LIMIT 1
      `).get()?.state ?? "");
    } finally {
      db.close();
    }
    if (launchState !== "" && launchState !== "starting") break;
    await delay(25);
  }
  assert.notEqual(launchState, "", "machine verify did not create an attempt");
  assert.notEqual(launchState, "starting", "machine verify did not finish its service-owned launch");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await fixture.sweepBoard.sweepVerifyAttempts();
    const item = fixture.sweepBoard.requireWorkItem(fixture.workItem.workItemId);
    if (item.state === expectedState) return item;
    await delay(25);
  }
  assert.fail(
    `verify sweep did not reach ${expectedState}; current=${fixture.sweepBoard.requireWorkItem(fixture.workItem.workItemId).state}`,
  );
}

async function claimImplementationRetry(fixture: PipelineFixture, claimId: string): Promise<ClaimRunResult> {
  return jsonRequest<ClaimRunResult>(
    fixture.origin,
    `/v1/agents/${fixture.engineerId}/runs/claim`,
    "POST",
    201,
    { token: ENGINEER_TOKEN, body: { claimId, messageCursor: null } },
  );
}

test("Pipeline v1 exits through reject, revise, implement, machine verify, final approval, and merge", async () => {
  const fixture = await createFixture({ suffix: "happy", engineerMode: "scoped", verifyPasses: true });
  try {
    await proposeAndConfirm(fixture, true);
    assert.equal(await git(fixture.repo, ["branch", "--show-current"]), "main\n");
    assert.equal(await git(fixture.repo, ["status", "--porcelain"]), "");

    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    assert.equal((await currentWorkItem(fixture)).state, "verifying");
    const finalApproval = await driveVerify(fixture, "final_approval");
    assert.equal(finalApproval.currentStage, null);

    const summary = await jsonRequest<PipelineSummary>(
      fixture.origin,
      `/v1/work-items/${fixture.workItem.workItemId}/pipeline-summary`,
      "GET",
      200,
    );
    assert.equal(summary.commits.length, 2);
    assert.deepEqual(new Set(summary.commits.map((commit) => commit.subject)), new Set([
      "pipeline step one",
      "pipeline step two",
    ]));
    assert.equal(summary.scopeOk, true);
    assert.deepEqual(summary.filesTouched, ["src/allowed/first.txt", "src/allowed/second.txt"]);
    assert.deepEqual(summary.declaredScope, ["src/allowed"]);
    assert.deepEqual(summary.criteria, [HUMAN_CRITERION]);
    assert.deepEqual(summary.criterionChecks, [{ criterion: CHECKED_CRITERION, check: "node criterion-check.mjs" }]);
    assert.deepEqual(summary.verify.map((attempt) => ({
      state: attempt.state,
      checkResults: attempt.checkResults,
    })), [{
      state: "green",
      checkResults: [{ criterion: CHECKED_CRITERION, check: "node criterion-check.mjs", passed: true }],
    }]);
    assert.deepEqual(summary.assumptions, ["The fixture repository stays available."]);
    assert.deepEqual(summary.midRunAssumptions, [MID_RUN_ASSUMPTION]);
    assert.doesNotMatch(summary.midRunAssumptions.join("\n"), /machine verify|Passed:/iu);
    await assert.rejects(access(join(fixture.verifyWorkspaceRoot, `${fixture.workItem.workItemId}-verify`)));
    await assert.rejects(access(join(fixture.workspaceRoot, fixture.workItem.workItemId)));
    assert.equal(await git(fixture.repo, ["branch", "--show-current"]), "main\n");
    assert.equal(await git(fixture.repo, ["status", "--porcelain"]), "");

    const approved = await jsonRequest<{ workItem: WorkItem }>(
      fixture.origin,
      `/v1/work-items/${fixture.workItem.workItemId}/approve-merge`,
      "POST",
      200,
      { body: { version: finalApproval.version } },
    );
    assert.equal(approved.workItem.state, "merged");
    const mergeParents = (await git(fixture.repo, ["rev-list", "--parents", "-n", "1", "main"])).trim().split(" ");
    assert.equal(mergeParents.length, 3);
    for (const commit of summary.commits) {
      await git(fixture.repo, ["merge-base", "--is-ancestor", commit.sha, "main"]);
    }
    const mainSubjects = await git(fixture.repo, ["log", "--format=%s", "main"]);
    assert.match(mainSubjects, /^Merge branch 'task\//u);
    assert.match(mainSubjects, /pipeline step one/u);
    assert.match(mainSubjects, /pipeline step two/u);
  } finally {
    await closeFixture(fixture);
  }
});

test("an engineer commit outside declared scope parks the pipeline and names the file", async () => {
  const fixture = await createFixture({ suffix: "scope", engineerMode: "outside_scope", verifyPasses: true });
  try {
    await proposeAndConfirm(fixture, false);
    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    assert.equal((await currentWorkItem(fixture)).state, "parked");
    const snapshot = await workflow(fixture);
    const handoff = snapshot.handoffs.find((candidate) => candidate.stage === "implementation");
    assert.ok(handoff);
    assert.equal(handoff.outcome, "failed");
    assert.match(handoff.summary, /scope violation: docs\/outside\.md/u);
    const board = await jsonRequest<BoardSnapshot>(
      fixture.origin,
      `/v1/projects/${fixture.project.projectId}/board`,
      "GET",
      200,
    );
    assert.ok(board.tasks.some((task) => task.result === "scope violation: docs/outside.md"));
  } finally {
    await closeFixture(fixture);
  }
});

test("a failing machine verify returns to implementation with tail evidence in the next claim", async () => {
  const fixture = await createFixture({ suffix: "verify-fail", engineerMode: "scoped", verifyPasses: false });
  try {
    await proposeAndConfirm(fixture, false);
    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    await driveVerify(fixture, "implementing");

    const retry = await claimImplementationRetry(fixture, "pipeline-e2e-verify-failure-retry");
    const handoffs = retry.context.workflow?.dependencyHandoffs;
    assert.ok(handoffs);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0]?.stage, "testing");
    assert.equal(handoffs[0]?.outcome, "failed");
    assert.match(handoffs[0]?.summary ?? "", /intentional full verify failure/u);
    assert.match(handoffs[0]?.evidence.join("\n") ?? "", /intentional full verify failure/u);
  } finally {
    await closeFixture(fixture);
  }
});

test("an approve-merge conflict returns to implementation with a conflict handoff", async () => {
  const fixture = await createFixture({
    suffix: "merge-conflict",
    engineerMode: "merge_conflict",
    verifyPasses: true,
    declaredScope: ["src/allowed", "shared.txt"],
  });
  try {
    await proposeAndConfirm(fixture, false);
    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    const finalApproval = await driveVerify(fixture, "final_approval");
    await writeFile(join(fixture.repo, "shared.txt"), "default branch conflict\n");
    await git(fixture.repo, ["add", "shared.txt"]);
    await git(fixture.repo, ["commit", "-m", "default branch conflict"]);
    const before = (await git(fixture.repo, ["rev-parse", "HEAD"])).trim();
    assert.equal(await git(fixture.repo, ["branch", "--show-current"]), "main\n");
    assert.equal(await git(fixture.repo, ["status", "--porcelain"]), "");

    const response = await jsonRequest<{ workItem: WorkItem }>(
      fixture.origin,
      `/v1/work-items/${fixture.workItem.workItemId}/approve-merge`,
      "POST",
      200,
      { body: { version: finalApproval.version } },
    );
    assert.equal(response.workItem.state, "implementing");
    assert.equal(response.workItem.currentStage, "implementation");
    assert.equal((await git(fixture.repo, ["rev-parse", "HEAD"])).trim(), before);
    assert.equal(await git(fixture.repo, ["status", "--porcelain"]), "");

    const retry = await claimImplementationRetry(fixture, "pipeline-e2e-merge-conflict-retry");
    const handoffs = retry.context.workflow?.dependencyHandoffs;
    assert.ok(handoffs);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0]?.stage, "implementation");
    assert.equal(handoffs[0]?.outcome, "failed");
    assert.match(handoffs[0]?.summary ?? "", /merge conflict/iu);
  } finally {
    await closeFixture(fixture);
  }
});
