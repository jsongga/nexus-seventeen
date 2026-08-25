import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { codexAdapter } from "../../../src/server/agents/runtime/codex.js";
import { CODEX_PROFILE } from "../agents/runtime/profile-fixtures.js";
import {
  DESIGN_FAILURE_POINTS,
  SCOPE_HOLD_SUMMARY_PREFIX,
  type BoardSnapshot,
  type ClaimRunResult,
  type ConfirmPlanRevisionResponse,
  type DesignRecordDraft,
  type PipelineSummary,
  type PlanRevision,
  type Project,
  type StageHandoff,
  type WorkItem,
  type WorkNode,
} from "#shared/task-board-contract";
import {
  ContainedCliAgentLauncher,
  HttpTaskBoardClient,
  PromptRegistry,
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
const ENGINEER_TWO_TOKEN = "pipeline-e2e-engineer-two-token-0123456789abcdef";
const VERIFIER_TOKEN = "pipeline-e2e-verifier-token-0123456789abcdef";
const RAW_REQUEST = "Deliver the scoped Pipeline v2 fixture change.";
const REJECTION_NOTE = "Make the second plan explicitly identify the two reviewable commits.";
const CHECKED_CRITERION = "The fixture criterion command passes.";
const HUMAN_CRITERION = "The implementation uses two reviewable commits.";
const MID_RUN_ASSUMPTION = "Implementation selected a plain-text fixture marker.";
const ENGINEER_RUN_PIN = { runtime: "codex", model: "fake-engineer" } as const;
const VERIFIER_RUN_PIN = { runtime: "codex", model: "fake-reviewer" } as const;
const PROMPTS = PromptRegistry.loadSync(resolve("prompts"));

type EngineerMode = "scoped" | "outside_scope" | "merge_conflict" | "seeded_defect";
type ReviewerMode = "passed" | "seeded_defect" | "always_blocking";
type PlanTier = "standard" | "hazardous";

const HAZARDOUS_DESIGN_RECORD = {
  states: ["pending", "sent", "committed", "unknown"],
  transitions: [{
    from: "pending",
    to: "sent",
    durablePrecondition: "Persist the intent and idempotency key before sending.",
    recovery: "Resume from the durable intent with the same key.",
  }],
  failurePoints: DESIGN_FAILURE_POINTS.map((point) => ({
    point,
    resultingState: `durable state after ${point}`,
    recovery: `recover ${point} from durable state`,
  })),
  idempotencyKeys: [{
    name: "pipeline-delivery-key",
    generatedAt: "When the durable intent is created.",
    persistedAt: "In the same transaction as the intent.",
    reuse: "Reuse verbatim for every retry.",
  }],
  faultInjectionCases: [{
    name: "Crash after commit",
    scenario: "Terminate after commit and before acknowledgement.",
    expectation: "Retry observes the committed result without duplicating delivery.",
  }],
} satisfies DesignRecordDraft;

interface WorkflowSnapshot {
  readonly plans: readonly PlanRevision[];
  readonly nodes: readonly WorkNode[];
  readonly handoffs: readonly StageHandoff[];
  readonly events: ReadonlyArray<{
    readonly nodeId: string | null;
    readonly eventType: string;
    readonly summary: string;
  }>;
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
  readonly verifierId: string;
  readonly managerWorker: TaskWorker;
  readonly engineerWorker: TaskWorker;
  readonly secondEngineer: Readonly<{
    id: string;
    token: string;
    worker: TaskWorker;
    scratch: string;
  }> | null;
  readonly verifierWorker: TaskWorker;
  readonly managerScratch: string;
  readonly engineerScratch: string;
  readonly workspaceRoot: string;
  readonly verifyWorkspaceRoot: string;
  readonly declaredScope: readonly string[];
  readonly tier: PlanTier;
}

interface FixtureOptions {
  readonly suffix: string;
  readonly engineerMode: EngineerMode;
  readonly reviewerMode?: ReviewerMode;
  readonly tier?: PlanTier;
  readonly verifyPasses: boolean;
  readonly declaredScope?: readonly string[];
  readonly scopeRoutes?: ReadonlyArray<Readonly<{
    marker: string;
    declaredScope: readonly string[];
  }>>;
  readonly twoEngineerLanes?: boolean;
  readonly engineerDelayMs?: number;
  readonly stageCapSeconds?: number;
  readonly taskCapSeconds?: number;
  readonly now?: () => Date;
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

function managerCliSource(
  suffix: string,
  declaredScope: readonly string[],
  tier: PlanTier,
  scopeRoutes: FixtureOptions["scopeRoutes"] = [],
): string {
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
  const routedScope = ${JSON.stringify(scopeRoutes)}.find((route) => input.includes(route.marker));
  const declaredScope = routedScope === undefined ? ${JSON.stringify(declaredScope)} : routedScope.declaredScope;
  fs.writeFileSync(statePath, String(revision));
  fs.writeFileSync(path.join(process.env.TMPDIR, "prompt-" + revision + ".txt"), input);
  if (input.includes('"design":true')) {
    const result = {
      status: "completed",
      progress: ["The hazardous design record covers every required failure point."],
      result: "The hazardous design record is complete.",
      proposedChildTasks: [],
      expectedAgentMinutes: null,
      phases: [],
      humanQuestion: null,
      handoff: null,
      workflowPlan: null,
      designRecord: ${JSON.stringify(HAZARDOUS_DESIGN_RECORD)},
      detail: "The hazardous design record is complete."
    };
    process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(result)}}) + "\\n");
    process.stdout.write(JSON.stringify({type:"turn.completed"}) + "\\n");
    return;
  }
  const workflowPlan = {
    objective: "Deliver the scoped Pipeline v2 fixture plan v" + revision + ".",
    assumptions: ["The fixture repository stays available."],
    acceptanceCriteria: [${JSON.stringify(CHECKED_CRITERION)}, ${JSON.stringify(HUMAN_CRITERION)}],
    changeShape: "feature",
    tier: ${JSON.stringify(tier)},
    declaredScope,
    nonGoals: ["Do not change files outside the declared scope."],
    mechanicalPortions: ["Add two deterministic fixture files."],
    blockingQuestions: [{
      question: "Should the fixture use a published interface?",
      recommendedDefault: "No; keep the change local to fixture files."
    }],
    criterionChecks: [{ criterion: ${JSON.stringify(CHECKED_CRITERION)}, check: "node criterion-check.mjs" }],
    nodes: [{
      nodeId: ${JSON.stringify(`pipeline-${suffix}-v`)} + revision,
      title: "Implement the Pipeline v2 fixture",
      objective: "Create two scoped commits and pass machine verification.",
      acceptanceCriteria: [${JSON.stringify(HUMAN_CRITERION)}],
      dependencyNodeIds: [],
      stageTemplate: ["implementation", "testing", "verification"]
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

function engineerCliSource(mode: EngineerMode, delayMs = 0): string {
  const secondPath = mode === "outside_scope"
    ? "docs/outside.md"
    : mode === "merge_conflict" ? "shared.txt" : "src/allowed/second.txt";
  return `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const child = require("node:child_process");
  if (${delayMs} > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayMs});
  const statePath = path.join(process.env.TMPDIR, "engineer-runs.txt");
  let previous = 0;
  try { previous = Number(fs.readFileSync(statePath, "utf8")); } catch {}
  const revision = previous + 1;
  fs.writeFileSync(statePath, String(revision));
  fs.writeFileSync(path.join(process.env.TMPDIR, "prompt-" + revision + ".txt"), input);
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
  const mode = ${JSON.stringify(mode)};
  const scopeMatch = /Declared scope \\(only these path prefixes\\): ([^.]*)\\./u.exec(input);
  const scopedRoot = scopeMatch === null ? "src/allowed" : scopeMatch[1].split(",")[0].trim();
  const fixMatch = /Fix round (\\d+) on branch/u.exec(input);
  const fixRound = fixMatch === null ? null : Number(fixMatch[1]);
  if (fixRound !== null) {
    if (mode === "seeded_defect") {
      commit("src/feature.txt", "fixed scoped change\\n", "fix seeded defect");
    } else {
      commit(
        "src/allowed/fix-round-" + fixRound + ".txt",
        "fix round " + fixRound + "\\n",
        "fix review round " + fixRound
      );
    }
  } else if (mode === "seeded_defect") {
    commit("src/allowed/first.txt", "first scoped change\\n", "pipeline step one");
    commit("src/feature.txt", "SEEDED_DEFECT\\n", "seed reviewable defect");
  } else {
    commit(mode === "scoped" ? scopedRoot + "/first.txt" : "src/allowed/first.txt", "first scoped change\\n", "pipeline step one");
    commit(mode === "scoped" ? scopedRoot + "/second.txt" : ${JSON.stringify(secondPath)}, "second pipeline change\\n", "pipeline step two");
  }
  const result = {
    status: "completed",
    progress: [fixRound === null ? "Two logical commits are ready for verification." : "The review fix is ready for verification."],
    result: fixRound === null ? "The staged pipeline implementation is complete." : "The review fix is complete.",
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    handoff: {
      outcome: "passed",
      summary: fixRound === null
        ? "Two staged commits are ready for machine verification."
        : "The review fix is ready for machine verification.",
      evidence: ["The fixture repository stays available.", "Commit abc123 passed focused tests.", "ASSUMPTION: " + ${JSON.stringify(MID_RUN_ASSUMPTION)}],
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
    detail: fixRound === null ? "The staged pipeline implementation is complete." : "The review fix is complete."
  };
  process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(result)}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"turn.completed"}) + "\\n");
});
`;
}

function verifierCliSource(mode: ReviewerMode): string {
  return `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const statePath = path.join(process.env.TMPDIR, "reviewer-runs.txt");
  let previous = 0;
  try { previous = Number(fs.readFileSync(statePath, "utf8")); } catch {}
  const round = previous + 1;
  fs.writeFileSync(statePath, String(round));
  fs.writeFileSync(path.join(process.env.TMPDIR, "prompt-" + round + ".txt"), input);
  const mode = ${JSON.stringify(mode)};
  const blocking = mode === "always_blocking" || (mode === "seeded_defect" && round === 1);
  const reviewFindings = blocking
    ? [mode === "seeded_defect"
      ? {
          file: "src/feature.txt",
          category: "correctness",
          severity: "major",
          expected: "no SEEDED_DEFECT marker",
          actual: "marker present"
        }
      : {
          file: "src/allowed/second.txt",
          category: "correctness",
          severity: "major",
          expected: "review has no blocking defect",
          actual: "blocking defect remains in review round " + round
        }]
    : [];
  const result = {
    status: blocking ? "failed" : "completed",
    progress: [blocking ? "Independent review found a blocking defect." : "Independent verification is complete."],
    result: blocking ? "Independent review found a blocking defect." : "Independent verification passed.",
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    handoff: {
      outcome: blocking ? "failed" : "passed",
      summary: blocking ? "Independent review found a blocking defect." : "Independent verification passed.",
      evidence: [],
      artifactIds: [],
      acceptanceCriteria: [],
      blockers: blocking ? ["The blocking review finding must be fixed."] : [],
      recommendedReturnStage: blocking ? "verification" : null
    },
    workflowPlan: null,
    reviewFindings,
    detail: blocking ? "Independent review found a blocking defect." : "Independent verification passed."
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
  await writeFile(join(repo, "readme.md"), "Pipeline v2 fixture repository.\n");
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
  const tier = options.tier ?? "standard";
  const reviewerMode = options.reviewerMode ?? "passed";
  const dbPath = join(root, "board", "task-board.sqlite");
  const verifyWorkspaceRoot = join(root, "verify-workspaces");
  const boardOptions = {
    dbPath,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:pipeline-reviewer",
    port: 0,
    reconcileIntervalSeconds: 0,
    verifyWorkspaceRoot,
    stageCapSeconds: options.stageCapSeconds ?? 0,
    taskCapSeconds: options.taskCapSeconds ?? 0,
    now: options.now,
  } as const;
  const service = await createTaskBoardService(boardOptions);
  const address = await service.start();
  const sweepBoard = await TaskBoard.open(normalizeTaskBoardConfig(boardOptions));
  const { project } = await jsonRequest<{ project: Project }>(address.url, "/v1/projects", "POST", 201, {
    body: { name: `Pipeline fixture ${options.suffix}`, description: repo },
  });
  const managerId = `pipeline-${options.suffix}-manager`;
  const engineerId = `pipeline-${options.suffix}-engineer`;
  const verifierId = `pipeline-${options.suffix}-verifier`;
  await jsonRequest(address.url, `/v1/projects/${project.projectId}/agents`, "POST", 201, {
    body: {
      agentId: managerId,
      role: "manager",
      area: "pipeline planning",
      mission: "Return complete Pipeline v2 plans for human approval.",
      model: "fake-codex",
      token: MANAGER_TOKEN,
    },
  });
  await jsonRequest(address.url, `/v1/projects/${project.projectId}/agents`, "POST", 201, {
    body: {
      agentId: verifierId,
      role: "verifier",
      area: "pipeline verification",
      mission: "Independently review the machine-verified pipeline evidence.",
      model: VERIFIER_RUN_PIN.model,
      token: VERIFIER_TOKEN,
    },
  });
  await jsonRequest(address.url, `/v1/projects/${project.projectId}/agents`, "POST", 201, {
    body: {
      agentId: engineerId,
      role: "engineer",
      area: "pipeline implementation",
      mission: "Implement only the confirmed declared scope and commit each logical change.",
      model: ENGINEER_RUN_PIN.model,
      token: ENGINEER_TOKEN,
    },
  });
  const secondEngineerId = options.twoEngineerLanes === true
    ? `pipeline-${options.suffix}-engineer-two`
    : null;
  if (secondEngineerId !== null) {
    await jsonRequest(address.url, `/v1/projects/${project.projectId}/agents`, "POST", 201, {
      body: {
        agentId: secondEngineerId,
        role: "engineer",
        area: "parallel pipeline implementation",
        mission: "Provide a second bounded implementation lane for exit-criterion coverage.",
        model: ENGINEER_RUN_PIN.model,
        token: ENGINEER_TWO_TOKEN,
      },
    });
  }
  const engineerType = {
    agentTypeId: `pipeline-${options.suffix}-engineer-type`,
    name: "Pipeline engineer",
    description: "Implements the confirmed Pipeline v2 fixture.",
    role: "engineer" as const,
    supplementalInstructions: "Commit only files in the confirmed declared scope.",
    skillIds: [],
    evaluatorProfile: "tests" as const,
    enabled: true,
  };
  const verifierType = {
    ...engineerType,
    agentTypeId: `pipeline-${options.suffix}-verifier-type`,
    name: "Pipeline verifier",
    description: "Independently reviews the confirmed Pipeline v2 fixture.",
    role: "verifier" as const,
  };
  await jsonRequest(address.url, "/v1/automation-configuration", "PATCH", 200, {
    body: automationConfigurationRequest({
      agentTypes: [engineerType, verifierType],
      stages: automationStages({
        implementation: { kind: "agent_type", agentTypeId: engineerType.agentTypeId },
        testing: { kind: "machine_verify" },
        verification: { kind: "agent_type", agentTypeId: verifierType.agentTypeId },
      }),
    }),
  });

  const declaredScope = options.declaredScope ?? ["src/allowed"];
  const managerCli = await fakeCodex(
    root,
    "manager-cli",
    managerCliSource(options.suffix, declaredScope, tier, options.scopeRoutes),
  );
  const engineerCli = await fakeCodex(
    root,
    "engineer-cli",
    engineerCliSource(options.engineerMode, options.engineerDelayMs),
  );
  const secondEngineerCli = secondEngineerId === null
    ? null
    : await fakeCodex(
        root,
        "engineer-two-cli",
        engineerCliSource(options.engineerMode, options.engineerDelayMs),
      );
  const verifierCli = await fakeCodex(root, "verifier-cli", verifierCliSource(reviewerMode));
  const managerWorker = await TaskWorker.create({
    identity: { workerId: `pipeline-${options.suffix}-manager-worker`, agentId: managerId },
    statePath: join(root, "manager-worker", "journal.json"),
    board: new HttpTaskBoardClient({ baseUrl: address.url, token: MANAGER_TOKEN }),
    launcher: new ContainedCliAgentLauncher({
      adapter: codexAdapter,
      profile: CODEX_PROFILE,
      prompts: PROMPTS,
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
      adapter: codexAdapter,
      profile: CODEX_PROFILE,
      prompts: PROMPTS,
      model: ENGINEER_RUN_PIN.model,
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
    pinned: ENGINEER_RUN_PIN,
    longPollMs: 1,
  });
  const secondEngineerWorker = secondEngineerId === null || secondEngineerCli === null
    ? null
    : await TaskWorker.create({
        identity: { workerId: `pipeline-${options.suffix}-engineer-two-worker`, agentId: secondEngineerId },
        statePath: join(root, "engineer-two-worker", "journal.json"),
        board: new HttpTaskBoardClient({ baseUrl: address.url, token: ENGINEER_TWO_TOKEN }),
        launcher: new WorkspaceScopedLauncher(
          new ContainedCliAgentLauncher({
            adapter: codexAdapter,
            profile: CODEX_PROFILE,
            prompts: PROMPTS,
            model: ENGINEER_RUN_PIN.model,
            workingDirectory: secondEngineerCli.working,
            environment: {
              PATH: `${secondEngineerCli.bin}${delimiter}${process.env.PATH ?? ""}`,
              TMPDIR: secondEngineerCli.scratch,
            },
            timeoutMs: 5_000,
            terminationGraceMs: 10,
            groupAbsenceTimeoutMs: 2_000,
          }),
          new TaskWorkspaceManager({ workspaceRoot, repositoryPath: repo }),
        ),
        pinned: ENGINEER_RUN_PIN,
        longPollMs: 1,
      });
  const verifierWorker = await TaskWorker.create({
    identity: { workerId: `pipeline-${options.suffix}-verifier-worker`, agentId: verifierId },
    statePath: join(root, "verifier-worker", "journal.json"),
    board: new HttpTaskBoardClient({ baseUrl: address.url, token: VERIFIER_TOKEN }),
    launcher: new ContainedCliAgentLauncher({
      adapter: codexAdapter,
      profile: CODEX_PROFILE,
      prompts: PROMPTS,
      model: VERIFIER_RUN_PIN.model,
      workingDirectory: verifierCli.working,
      environment: {
        PATH: `${verifierCli.bin}${delimiter}${process.env.PATH ?? ""}`,
        TMPDIR: verifierCli.scratch,
      },
      timeoutMs: 5_000,
      terminationGraceMs: 10,
      groupAbsenceTimeoutMs: 2_000,
    }),
    pinned: VERIFIER_RUN_PIN,
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
    verifierId,
    managerWorker,
    engineerWorker,
    secondEngineer: secondEngineerId === null || secondEngineerCli === null || secondEngineerWorker === null
      ? null
      : {
          id: secondEngineerId,
          token: ENGINEER_TWO_TOKEN,
          worker: secondEngineerWorker,
          scratch: secondEngineerCli.scratch,
        },
    verifierWorker,
    managerScratch: managerCli.scratch,
    engineerScratch: engineerCli.scratch,
    workspaceRoot,
    verifyWorkspaceRoot,
    declaredScope,
    tier,
  };
}

async function closeFixture(fixture: PipelineFixture): Promise<void> {
  await fixture.managerWorker.close();
  await fixture.engineerWorker.close();
  await fixture.secondEngineer?.worker.close();
  await fixture.verifierWorker.close();
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

async function currentWorkItem(fixture: PipelineFixture, workItemId = fixture.workItem.workItemId): Promise<WorkItem> {
  return (await jsonRequest<{ workItem: WorkItem }>(
    fixture.origin,
    `/v1/work-items/${workItemId}`,
    "GET",
    200,
  )).workItem;
}

async function createPipelineWorkItem(
  fixture: PipelineFixture,
  originalRequest: string,
  idempotencyKey: string,
): Promise<WorkItem> {
  const { workItem } = await jsonRequest<{ workItem: WorkItem }>(
    fixture.origin,
    "/v1/work-items",
    "POST",
    201,
    {
      idempotencyKey,
      body: {
        originalRequest,
        priority: "normal",
        projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
      },
    },
  );
  assert.equal(workItem.state, "planning");
  return workItem;
}

function proposedPlan(snapshot: WorkflowSnapshot, workItemId: string): PlanRevision {
  const plan = snapshot.plans.find((candidate) =>
    candidate.workItemId === workItemId && candidate.state === "proposed");
  assert.ok(plan);
  return plan;
}

function assertCompletePlan(plan: PlanRevision, declaredScope: readonly string[], tier: PlanTier): void {
  assert.equal(plan.changeShape, "feature");
  assert.equal(plan.tier, tier);
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
  assertCompletePlan(first, fixture.declaredScope, fixture.tier);
  assert.deepEqual(snapshot.nodes.find((node) => node.planRevisionId === first.planRevisionId)?.stageTemplate, [
    "implementation",
    "testing",
    "verification",
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
    assertCompletePlan(selected, fixture.declaredScope, fixture.tier);
    assert.equal(snapshot.plans.find((plan) => plan.planRevisionId === first.planRevisionId)?.state, "rejected");
    assert.equal(snapshot.plans.find((plan) => plan.planRevisionId === first.planRevisionId)?.rejectedNote, REJECTION_NOTE);
  }

  assert.equal((await currentWorkItem(fixture)).state, "plan_approval");
  const confirmation = await jsonRequest<ConfirmPlanRevisionResponse>(
    fixture.origin,
    `/v1/plans/${selected.planRevisionId}/confirm`,
    "POST",
    200,
    { body: { expectedState: "proposed" } },
  );
  const confirmed = await currentWorkItem(fixture);
  if (fixture.tier === "hazardous") {
    assert.equal(confirmation.outcome, "designing");
    assert.equal(confirmed.state, "designing");
    assert.equal(confirmed.currentStage, "planning");
  } else {
    assert.equal(confirmation.outcome, undefined);
    assert.equal(confirmed.state, "implementing");
  }
  assert.equal(confirmed.pipelineBranch, `task/${fixture.workItem.workItemId}`);
  assert.match(confirmed.baseSha ?? "", /^[0-9a-f]{40,64}$/u);
  return selected;
}

async function proposeAndConfirmItem(
  fixture: PipelineFixture,
  workItem: WorkItem,
  declaredScope: readonly string[],
): Promise<PlanRevision> {
  assert.equal(await fixture.managerWorker.dispatchOnce(), true);
  assert.equal((await currentWorkItem(fixture, workItem.workItemId)).state, "plan_approval");
  const snapshot = await workflow(fixture);
  const plan = proposedPlan(snapshot, workItem.workItemId);
  assertCompletePlan(plan, declaredScope, "standard");
  assert.deepEqual(snapshot.nodes.find((node) => node.planRevisionId === plan.planRevisionId)?.stageTemplate, [
    "implementation",
    "testing",
    "verification",
  ]);
  await jsonRequest<ConfirmPlanRevisionResponse>(
    fixture.origin,
    `/v1/plans/${plan.planRevisionId}/confirm`,
    "POST",
    200,
    { body: { expectedState: "proposed" } },
  );
  const confirmed = await currentWorkItem(fixture, workItem.workItemId);
  assert.equal(confirmed.state, "implementing");
  assert.equal(confirmed.pipelineBranch, `task/${workItem.workItemId}`);
  assert.match(confirmed.baseSha ?? "", /^[0-9a-f]{40,64}$/u);
  return plan;
}

async function driveVerify(
  fixture: PipelineFixture,
  expectedState: "implementing" | "reviewing",
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

async function driveVerifyItem(
  fixture: PipelineFixture,
  workItemId: string,
  expectedState: "implementing" | "reviewing",
): Promise<WorkItem> {
  await waitForServiceVerifyLaunches(fixture, [workItemId]);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await fixture.sweepBoard.sweepVerifyAttempts();
    const item = fixture.sweepBoard.requireWorkItem(workItemId);
    if (item.state === expectedState) return item;
    if (item.state === "parked" || item.state === "dead_letter" || item.state === "abandoned") {
      const park = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        const reason = park.prepare(`
          SELECT category,reason
          FROM park_records
          WHERE work_item_id=?
          ORDER BY parked_at DESC,rowid DESC
          LIMIT 1
        `).get(workItemId) as { category?: unknown; reason?: unknown } | undefined;
        assert.fail(
          `verify sweep did not reach ${expectedState}; current=${item.state}` +
          (reason === undefined ? "" : `; park=${String(reason.category)}: ${String(reason.reason)}`),
        );
      } finally {
        park.close();
      }
    }
    await delay(25);
  }
  assert.fail(
    `verify sweep did not reach ${expectedState}; current=${fixture.sweepBoard.requireWorkItem(workItemId).state}`,
  );
}

async function waitForServiceVerifyLaunches(
  fixture: PipelineFixture,
  workItemIds: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 5_000;
  let states = new Map<string, string>();
  while (Date.now() < deadline) {
    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const rows = db.prepare(`
        SELECT plan.work_item_id,verify.state
        FROM verify_attempts verify
        JOIN work_nodes node ON node.node_id=verify.node_id
        JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
        WHERE plan.work_item_id IN (${workItemIds.map(() => "?").join(",")})
          AND verify.attempt=(
            SELECT MAX(latest.attempt)
            FROM verify_attempts latest
            WHERE latest.node_id=verify.node_id AND latest.stage=verify.stage
          )
      `).all(...workItemIds) as unknown as ReadonlyArray<{ work_item_id: string; state: string }>;
      states = new Map(rows.map((row) => [row.work_item_id, row.state]));
    } finally {
      db.close();
    }
    if (workItemIds.every((workItemId) => {
      const state = states.get(workItemId);
      return state !== undefined && state !== "starting";
    })) return;
    await delay(25);
  }
  assert.fail(`service-owned verify launch did not finish: ${workItemIds.map(
    (workItemId) => `${workItemId}=${states.get(workItemId) ?? "missing"}`,
  ).join(", ")}`);
}

async function reviewApproveAndMerge(fixture: PipelineFixture, workItemIds: readonly string[]): Promise<void> {
  // The direct sweep board and service each own a verify collaborator. Let the
  // service finish every after-commit launch before the direct board polls any
  // attempt, otherwise its global sweep can race a sibling attempt still in
  // `starting` and make both launch the same workspace.
  await waitForServiceVerifyLaunches(fixture, workItemIds);
  for (const workItemId of workItemIds) await driveVerifyItem(fixture, workItemId, "reviewing");
  for (const _workItemId of workItemIds) assert.equal(await fixture.verifierWorker.dispatchOnce(), true);
  for (const workItemId of workItemIds) {
    const finalApproval = await currentWorkItem(fixture, workItemId);
    assert.equal(finalApproval.state, "final_approval");
    const approved = await jsonRequest<{ workItem: WorkItem }>(
      fixture.origin,
      `/v1/work-items/${workItemId}/approve-merge`,
      "POST",
      200,
      { body: { version: finalApproval.version } },
    );
    assert.equal(approved.workItem.state, "merged");
  }
}

async function waitForActiveEngineerRuns(
  fixture: PipelineFixture,
  expectedAgentIds: ReadonlySet<string>,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const active = new Set((db.prepare(`
        SELECT DISTINCT agent_id
        FROM runs
        WHERE status='active' AND agent_id IN (${[...expectedAgentIds].map(() => "?").join(",")})
      `).all(...expectedAgentIds) as unknown as ReadonlyArray<{ agent_id: string }>).map((row) => row.agent_id));
      if (active.size === expectedAgentIds.size && [...expectedAgentIds].every((id) => active.has(id))) return;
    } finally {
      db.close();
    }
    await delay(10);
  }
  assert.fail("both engineer lanes were not active together");
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

interface PersistedReviewFinding {
  readonly round: number;
  readonly file: string | null;
  readonly category: string;
  readonly severity: string;
  readonly expected: string;
  readonly actual: string;
  readonly blocking: number;
}

function persistedReviewFindings(fixture: PipelineFixture): readonly PersistedReviewFinding[] {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT round,file,category,severity,expected,actual,blocking
      FROM review_findings
      ORDER BY round,created_at,finding_id
    `).all() as unknown as readonly PersistedReviewFinding[];
    return rows.map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

function persistedReviewRounds(fixture: PipelineFixture): readonly number[] {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    return (db.prepare(`
      SELECT attempt
      FROM stage_attempts
      WHERE stage='verification'
      ORDER BY attempt
    `).all() as unknown as ReadonlyArray<{ attempt: number }>).map((row) => row.attempt);
  } finally {
    db.close();
  }
}

interface PersistedRunIdentity {
  readonly runtime: string | null;
  readonly model: string | null;
}

function persistedRunIdentity(fixture: PipelineFixture, agentId: string): PersistedRunIdentity {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT runtime,model
      FROM runs
      WHERE agent_id=?
      ORDER BY started_at DESC,run_id DESC
      LIMIT 1
    `).get(agentId) as unknown as PersistedRunIdentity | undefined;
    assert.ok(row, `no persisted run found for ${agentId}`);
    return { ...row };
  } finally {
    db.close();
  }
}

test("Pipeline v2 exits through reject, revise, implement, machine verify, independent review, final approval, and merge", async () => {
  const fixture = await createFixture({ suffix: "happy", engineerMode: "scoped", verifyPasses: true });
  try {
    await proposeAndConfirm(fixture, true);
    assert.equal(await git(fixture.repo, ["branch", "--show-current"]), "main\n");
    assert.equal(await git(fixture.repo, ["status", "--porcelain"]), "");

    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    assert.equal((await currentWorkItem(fixture)).state, "verifying");
    const reviewing = await driveVerify(fixture, "reviewing");
    assert.equal(reviewing.currentStage, "verification");
    assert.equal(await fixture.verifierWorker.dispatchOnce(), true);
    const finalApproval = await currentWorkItem(fixture);
    assert.equal(finalApproval.state, "final_approval");
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

test("a seeded defect is caught, fixed, re-verified, approved, and merged", async () => {
  const fixture = await createFixture({
    suffix: "seeded-defect",
    engineerMode: "seeded_defect",
    reviewerMode: "seeded_defect",
    verifyPasses: true,
    declaredScope: ["src"],
  });
  try {
    await proposeAndConfirm(fixture, false);
    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    assert.equal((await currentWorkItem(fixture)).state, "verifying");
    await driveVerify(fixture, "reviewing");

    assert.equal(await fixture.verifierWorker.dispatchOnce(), true);
    assert.deepEqual({
      implementation: persistedRunIdentity(fixture, fixture.engineerId),
      verification: persistedRunIdentity(fixture, fixture.verifierId),
    }, {
      implementation: ENGINEER_RUN_PIN,
      verification: VERIFIER_RUN_PIN,
    });
    const fixing = await currentWorkItem(fixture);
    assert.equal(fixing.state, "fixing");
    assert.equal(fixing.currentStage, "implementation");
    const fixingWorkflow = await workflow(fixture);
    assert.equal(
      fixingWorkflow.handoffs.filter((handoff) => handoff.stage === "verification").at(-1)?.recommendedReturnStage,
      "implementation",
    );
    assert.deepEqual(persistedReviewFindings(fixture), [{
      round: 1,
      file: "src/feature.txt",
      category: "correctness",
      severity: "major",
      expected: "no SEEDED_DEFECT marker",
      actual: "marker present",
      blocking: 1,
    }]);

    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    const fixPrompt = await readFile(join(fixture.engineerScratch, "prompt-2.txt"), "utf8");
    assert.match(fixPrompt, /Fix round 1 on branch task\//u);
    assert.match(fixPrompt, /Review findings:/u);
    assert.match(fixPrompt, /"file":"src\/feature\.txt"/u);
    assert.match(fixPrompt, /"expected":"no SEEDED_DEFECT marker"/u);
    assert.match(fixPrompt, /"actual":"marker present"/u);
    assert.equal((await currentWorkItem(fixture)).state, "verifying");
    assert.equal(
      await git(fixture.repo, ["show", `task/${fixture.workItem.workItemId}:src/feature.txt`]),
      "fixed scoped change\n",
    );
    await driveVerify(fixture, "reviewing");

    assert.equal(await fixture.verifierWorker.dispatchOnce(), true);
    const finalApproval = await currentWorkItem(fixture);
    assert.equal(finalApproval.state, "final_approval");
    assert.deepEqual(persistedReviewRounds(fixture), [1, 2]);
    const findingsByRound = [1, 2].map((round) =>
      persistedReviewFindings(fixture).filter((finding) => finding.round === round));
    assert.deepEqual(findingsByRound, [[{
      round: 1,
      file: "src/feature.txt",
      category: "correctness",
      severity: "major",
      expected: "no SEEDED_DEFECT marker",
      actual: "marker present",
      blocking: 1,
    }], []]);
    const summary = await jsonRequest<PipelineSummary>(
      fixture.origin,
      `/v1/work-items/${fixture.workItem.workItemId}/pipeline-summary`,
      "GET",
      200,
    );
    assert.deepEqual(summary.verify.map((attempt) => attempt.state), ["green", "green"]);

    const approved = await jsonRequest<{ workItem: WorkItem }>(
      fixture.origin,
      `/v1/work-items/${fixture.workItem.workItemId}/approve-merge`,
      "POST",
      200,
      { body: { version: finalApproval.version } },
    );
    assert.equal(approved.workItem.state, "merged");
    const fixed = await readFile(join(fixture.repo, "src", "feature.txt"), "utf8");
    assert.equal(fixed, "fixed scoped change\n");
    assert.doesNotMatch(fixed, /SEEDED_DEFECT/u);
  } finally {
    await closeFixture(fixture);
  }
});

test("a fourth blocking review dead-letters after three fix rounds without merging", async () => {
  const fixture = await createFixture({
    suffix: "review-dead-letter",
    engineerMode: "scoped",
    reviewerMode: "always_blocking",
    verifyPasses: true,
  });
  try {
    const mainBefore = (await git(fixture.repo, ["rev-parse", "main"])).trim();
    await proposeAndConfirm(fixture, false);
    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    await driveVerify(fixture, "reviewing");

    for (let round = 1; round <= 4; round += 1) {
      assert.equal(await fixture.verifierWorker.dispatchOnce(), true);
      const reviewed = await currentWorkItem(fixture);
      if (round === 4) {
        assert.equal(reviewed.state, "dead_letter");
        assert.equal(reviewed.currentStage, null);
        assert.notEqual(reviewed.endedAt, null);
        break;
      }
      assert.equal(reviewed.state, "fixing");
      assert.equal(reviewed.currentStage, "implementation");
      assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
      const fixPrompt = await readFile(join(fixture.engineerScratch, `prompt-${round + 1}.txt`), "utf8");
      assert.match(fixPrompt, new RegExp(`Fix round ${round} on branch task/`, "u"));
      assert.match(fixPrompt, new RegExp(`blocking defect remains in review round ${round}`, "u"));
      assert.equal((await currentWorkItem(fixture)).state, "verifying");
      await driveVerify(fixture, "reviewing");
    }

    assert.deepEqual(persistedReviewRounds(fixture), [1, 2, 3, 4]);
    const findings = persistedReviewFindings(fixture);
    assert.deepEqual(findings.map((finding) => finding.round), [1, 2, 3, 4]);
    assert.ok(findings.every((finding) => finding.category === "correctness" && finding.blocking === 1));
    assert.equal((await git(fixture.repo, ["rev-parse", "main"])).trim(), mainBefore);
    assert.doesNotMatch(await git(fixture.repo, ["log", "--format=%s", "main"]), /^Merge branch /mu);
  } finally {
    await closeFixture(fixture);
  }
});

test("a hazardous plan completes design before implementation, review, approval, and merge", async () => {
  const fixture = await createFixture({
    suffix: "hazardous-design",
    engineerMode: "scoped",
    reviewerMode: "passed",
    tier: "hazardous",
    verifyPasses: true,
  });
  try {
    await proposeAndConfirm(fixture, false);
    const designing = await currentWorkItem(fixture);
    assert.equal(designing.state, "designing");
    assert.equal(designing.currentStage, "planning");

    assert.equal(await fixture.managerWorker.dispatchOnce(), true);
    const designPrompt = await readFile(join(fixture.managerScratch, "prompt-2.txt"), "utf8");
    assert.match(designPrompt, /"design":true/u);
    assert.match(designPrompt, /Return a valid designRecord covering all six hazardous failure points/u);
    const implementing = await currentWorkItem(fixture);
    assert.equal(implementing.state, "implementing");
    assert.equal(implementing.currentStage, "implementation");

    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const persisted = db.prepare(
        "SELECT payload_json FROM design_records WHERE work_item_id=?",
      ).get(fixture.workItem.workItemId);
      assert.deepEqual(JSON.parse(String(persisted?.payload_json)), HAZARDOUS_DESIGN_RECORD);
    } finally {
      db.close();
    }

    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    const engineerPrompt = await readFile(join(fixture.engineerScratch, "prompt-1.txt"), "utf8");
    assert.match(engineerPrompt, /This is a hazardous-tier task\. Design record below\./u);
    assert.match(engineerPrompt, /Write each fault-injection case as a test\./u);
    assert.match(engineerPrompt, /"point":"crash_before_send"/u);
    assert.match(engineerPrompt, /"point":"concurrent_invocation"/u);
    assert.match(engineerPrompt, /"faultInjectionCases":\[\{"name":"Crash after commit"/u);
    assert.equal((await currentWorkItem(fixture)).state, "verifying");
    await driveVerify(fixture, "reviewing");
    assert.equal(await fixture.verifierWorker.dispatchOnce(), true);
    const finalApproval = await currentWorkItem(fixture);
    assert.equal(finalApproval.state, "final_approval");
    assert.deepEqual(persistedReviewRounds(fixture), [1]);
    assert.deepEqual(persistedReviewFindings(fixture), []);

    const approved = await jsonRequest<{ workItem: WorkItem }>(
      fixture.origin,
      `/v1/work-items/${fixture.workItem.workItemId}/approve-merge`,
      "POST",
      200,
      { body: { version: finalApproval.version } },
    );
    assert.equal(approved.workItem.state, "merged");
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
    await driveVerify(fixture, "reviewing");
    assert.equal(await fixture.verifierWorker.dispatchOnce(), true);
    const finalApproval = await currentWorkItem(fixture);
    assert.equal(finalApproval.state, "final_approval");
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

test("campaign 7 exit: concurrent disjoint pipelines use both engineer lanes and merge", async () => {
  const fixture = await createFixture({
    suffix: "exit-disjoint",
    engineerMode: "scoped",
    verifyPasses: true,
    declaredScope: ["src/disjoint/a"],
    scopeRoutes: [{ marker: "DISJOINT_SCOPE_B", declaredScope: ["src/disjoint/b"] }],
    twoEngineerLanes: true,
    engineerDelayMs: 250,
  });
  try {
    const secondEngineer = fixture.secondEngineer;
    assert.ok(secondEngineer);
    const firstPlan = await proposeAndConfirmItem(fixture, fixture.workItem, ["src/disjoint/a"]);
    const second = await createPipelineWorkItem(
      fixture,
      "Deliver the DISJOINT_SCOPE_B pipeline fixture change.",
      "pipeline-e2e-exit-disjoint-second",
    );
    const secondPlan = await proposeAndConfirmItem(fixture, second, ["src/disjoint/b"]);
    const nodes = (await workflow(fixture)).nodes.filter((node) =>
      [firstPlan.planRevisionId, secondPlan.planRevisionId].includes(node.planRevisionId));
    assert.equal(nodes.length, 2);
    assert.equal(nodes.every((node) => node.state === "active"), true);

    const dispatches = Promise.all([
      fixture.engineerWorker.dispatchOnce(),
      secondEngineer.worker.dispatchOnce(),
    ]);
    const engineerIds = new Set([fixture.engineerId, secondEngineer.id]);
    await waitForActiveEngineerRuns(fixture, engineerIds);
    assert.deepEqual(await dispatches, [true, true]);
    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const runAgentIds = new Set((db.prepare(`
        SELECT DISTINCT agent_id FROM runs WHERE agent_id IN (?,?)
      `).all(fixture.engineerId, secondEngineer.id) as unknown as ReadonlyArray<{ agent_id: string }>)
        .map((row) => row.agent_id));
      assert.deepEqual(runAgentIds, engineerIds);
    } finally {
      db.close();
    }

    await reviewApproveAndMerge(fixture, [fixture.workItem.workItemId, second.workItemId]);
    assert.equal((await currentWorkItem(fixture)).state, "merged");
    assert.equal((await currentWorkItem(fixture, second.workItemId)).state, "merged");
  } finally {
    await closeFixture(fixture);
  }
});

test("campaign 7 exit: overlapping pipelines serialize until the older item merges", async () => {
  let now = new Date(Date.now() - 1_000);
  const fixture = await createFixture({
    suffix: "exit-overlap",
    engineerMode: "scoped",
    verifyPasses: true,
    declaredScope: ["src/overlap"],
    scopeRoutes: [{ marker: "OVERLAP_SCOPE_B", declaredScope: ["src/overlap/b"] }],
    now: () => now,
  });
  try {
    const firstPlan = await proposeAndConfirmItem(fixture, fixture.workItem, ["src/overlap"]);
    now = new Date(now.getTime() + 1);
    const second = await createPipelineWorkItem(
      fixture,
      "Deliver the nested OVERLAP_SCOPE_B pipeline fixture change.",
      "pipeline-e2e-exit-overlap-second",
    );
    const secondPlan = await proposeAndConfirmItem(fixture, second, ["src/overlap/b"]);
    let snapshot = await workflow(fixture);
    const heldNode = snapshot.nodes.find((node) => node.planRevisionId === secondPlan.planRevisionId);
    assert.equal(heldNode?.state, "blocked");
    assert.equal(snapshot.events.filter((event) =>
      event.nodeId === heldNode?.nodeId && event.eventType === "node_blocked").at(-1)?.summary,
    `${SCOPE_HOLD_SUMMARY_PREFIX}overlaps ${fixture.workItem.workItemId}`);

    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    await driveVerifyItem(fixture, fixture.workItem.workItemId, "reviewing");
    assert.equal(await fixture.verifierWorker.dispatchOnce(), true);
    assert.equal((await currentWorkItem(fixture)).state, "final_approval");
    assert.equal((await workflow(fixture)).nodes.find(
      (node) => node.planRevisionId === secondPlan.planRevisionId)?.state, "blocked");
    const firstFinal = await currentWorkItem(fixture);
    const firstMerged = await jsonRequest<{ workItem: WorkItem }>(
      fixture.origin,
      `/v1/work-items/${fixture.workItem.workItemId}/approve-merge`,
      "POST",
      200,
      { body: { version: firstFinal.version } },
    );
    assert.equal(firstMerged.workItem.state, "merged");

    snapshot = await workflow(fixture);
    assert.equal(snapshot.nodes.find((node) => node.planRevisionId === secondPlan.planRevisionId)?.state, "active");
    assert.equal(snapshot.nodes.find((node) => node.planRevisionId === firstPlan.planRevisionId)?.state, "completed");
    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    await reviewApproveAndMerge(fixture, [second.workItemId]);
    assert.equal((await currentWorkItem(fixture, second.workItemId)).state, "merged");
  } finally {
    await closeFixture(fixture);
  }
});

test("campaign 7 exit: a runaway implementation is stage-capped, notified, retried, and merged", async () => {
  const fixture = await createFixture({
    suffix: "exit-runaway",
    engineerMode: "scoped",
    verifyPasses: true,
    declaredScope: ["src/runaway"],
    stageCapSeconds: 60,
    taskCapSeconds: 0,
  });
  try {
    const plan = await proposeAndConfirmItem(fixture, fixture.workItem, ["src/runaway"]);
    const stub = new HttpTaskBoardClient({ baseUrl: fixture.origin, token: ENGINEER_TOKEN });
    const claimed = await stub.claimNextWake({
      agentId: fixture.engineerId,
      claimId: "pipeline-e2e-exit-runaway-never-settles",
      messageCursors: {},
      longPollMs: 0,
    });
    assert.ok(claimed);
    assert.equal(claimed.context?.workflow?.stage, "implementation");
    const node = (await workflow(fixture)).nodes.find((candidate) =>
      candidate.planRevisionId === plan.planRevisionId);
    assert.ok(node);
    const capClock = new DatabaseSync(fixture.dbPath);
    try {
      const stageStartedAt = new Date(Date.now() - 62_000).toISOString();
      const updated = capClock.prepare(`
        UPDATE project_events
        SET created_at=?
        WHERE sequence=(
          SELECT sequence
          FROM project_events
          WHERE node_id=? AND event_type='stage_started'
          ORDER BY sequence DESC
          LIMIT 1
        )
      `).run(stageStartedAt, node.nodeId);
      assert.equal(Number(updated.changes), 1);
    } finally {
      capClock.close();
    }
    const sweepNow = new Date().toISOString();
    assert.deepEqual(fixture.sweepBoard.sweepWallClockCaps(sweepNow), { suspended: 1, parked: 1 });
    const parked = await currentWorkItem(fixture);
    assert.equal(parked.state, "parked");
    assert.equal(parked.currentStage, "implementation");
    const snapshot = await workflow(fixture);
    assert.equal(snapshot.nodes.find((candidate) => candidate.nodeId === node.nodeId)?.state, "blocked");
    const blockedSummary = snapshot.events.filter((event) =>
      event.nodeId === node.nodeId && event.eventType === "node_blocked").at(-1)?.summary;
    assert.match(blockedSummary ?? "", /^stage cap exceeded: implementation ran \d+s \(cap 60s\)$/u);
    const parks = await jsonRequest<{ open: Array<{ workItemId: string; category: string; reason: string }> }>(
      fixture.origin,
      "/v1/ledgers/parks",
      "GET",
      200,
    );
    assert.ok(parks.open.some((record) =>
      record.workItemId === fixture.workItem.workItemId &&
      record.category === "stage_cap_exceeded" &&
      record.reason === blockedSummary));
    const notifications = await jsonRequest<{ unread: Array<{ workItemId: string | null; kind: string }> }>(
      fixture.origin,
      "/v1/notifications",
      "GET",
      200,
    );
    assert.ok(notifications.unread.some((notification) =>
      notification.workItemId === fixture.workItem.workItemId && notification.kind === "cap_parked"));

    assert.ok(claimed.claim.taskId);
    const suspendedTask = fixture.sweepBoard.requireTask(claimed.claim.taskId);
    const retried = await jsonRequest<{ task: { status: string } }>(
      fixture.origin,
      `/v1/tasks/${suspendedTask.taskId}/retry`,
      "POST",
      200,
      { body: { version: suspendedTask.version } },
    );
    assert.equal(retried.task.status, "queued");
    assert.equal((await currentWorkItem(fixture)).state, "implementing");
    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    await reviewApproveAndMerge(fixture, [fixture.workItem.workItemId]);
    assert.equal((await currentWorkItem(fixture)).state, "merged");
  } finally {
    await closeFixture(fixture);
  }
});

test("campaign 7 exit: the kill switch drains an active run, gates claims, resumes, and merges", async () => {
  const fixture = await createFixture({
    suffix: "exit-kill-switch",
    engineerMode: "scoped",
    verifyPasses: true,
    declaredScope: ["src/kill-switch"],
  });
  try {
    const plan = await proposeAndConfirmItem(fixture, fixture.workItem, ["src/kill-switch"]);
    const stub = new HttpTaskBoardClient({ baseUrl: fixture.origin, token: ENGINEER_TOKEN });
    const claimed = await stub.claimNextWake({
      agentId: fixture.engineerId,
      claimId: "pipeline-e2e-exit-kill-switch-active",
      messageCursors: {},
      longPollMs: 0,
    });
    assert.ok(claimed);
    assert.equal(claimed.context?.workflow?.stage, "implementation");

    const paused = await jsonRequest<{ paused: boolean; reason: string | null; version: number }>(
      fixture.origin,
      "/v1/board/pause",
      "POST",
      200,
      { body: { reason: "Exit criterion maintenance", version: 1 } },
    );
    assert.deepEqual({ paused: paused.paused, reason: paused.reason }, {
      paused: true,
      reason: "Exit criterion maintenance",
    });
    await stub.settleAgentRun({
      claim: claimed.claim,
      outcome: "completed",
      result: "Buffered implementation output flushed after the board pause.",
      idempotencyKey: "pipeline-e2e-exit-kill-switch-flush",
    });
    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT status FROM runs WHERE run_id=?").get(claimed.claim.runId)?.status, "interrupted");
    } finally {
      db.close();
    }
    const suspendedSnapshot = await workflow(fixture);
    const node = suspendedSnapshot.nodes.find((candidate) => candidate.planRevisionId === plan.planRevisionId);
    assert.equal(node?.state, "blocked");
    assert.equal(suspendedSnapshot.events.filter((event) =>
      event.nodeId === node?.nodeId && event.eventType === "node_blocked").at(-1)?.summary,
    "board paused: Exit criterion maintenance");

    const gatedResponse = await fetch(
      `${fixture.origin}/v1/agents/${fixture.engineerId}/runs/claim?waitMs=0`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ENGINEER_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ claimId: "pipeline-e2e-exit-kill-switch-gated", messageCursor: null }),
      },
    );
    assert.equal(gatedResponse.status, 204);
    assert.equal(await gatedResponse.text(), "");
    assert.equal(await stub.claimNextWake({
      agentId: fixture.engineerId,
      claimId: "pipeline-e2e-exit-kill-switch-gated-client",
      messageCursors: {},
      longPollMs: 0,
    }), null);

    const resumed = await jsonRequest<{ paused: boolean; reason: string | null; version: number }>(
      fixture.origin,
      "/v1/board/resume",
      "POST",
      200,
      { body: { version: paused.version } },
    );
    assert.deepEqual({ paused: resumed.paused, reason: resumed.reason }, { paused: false, reason: null });
    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    await reviewApproveAndMerge(fixture, [fixture.workItem.workItemId]);
    assert.equal((await currentWorkItem(fixture)).state, "merged");
  } finally {
    await closeFixture(fixture);
  }
});
