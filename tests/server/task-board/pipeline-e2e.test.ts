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
  type ChildWorkItem,
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
import { VerifyRunner } from "#server/agents/verify";
import {
  createTaskBoardService,
  normalizeTaskBoardConfig,
  TaskBoard,
  type TaskBoardService,
} from "#server/task-board";
import { DEFAULT_SUPERVISOR_PATH } from "#server/task-board/collaborators/verify-attempts";
import { automationConfigurationRequest, automationStages, gateActions } from "./helpers.js";

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
const BLAST_RADIUS_MARKER = "BLAST_RADIUS_DECOMPOSITION";
const FEATURE_SPLIT_MARKER = "FEATURE_SPLIT_DECOMPOSITION";
const PUBLISHED_INTERFACE = "# Published provider interface\n\n- `GET /v1/pipeline-fixture`\n";
const ENGINEER_RUN_PIN = { runtime: "codex", model: "fake-engineer" } as const;
const VERIFIER_RUN_PIN = { runtime: "codex", model: "fake-reviewer" } as const;
const PROMPTS = PromptRegistry.loadSync(resolve("config/prompts.md"));

type EngineerMode =
  | "scoped"
  | "outside_scope"
  | "merge_conflict"
  | "seeded_defect"
  | "phased_provider"
  | "phased_consumer";
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
  readonly projects: readonly FixtureProject[];
  readonly project: FixtureProject;
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

interface FixtureRepositoryOptions {
  readonly name: string;
  readonly verifyPasses: boolean;
  readonly declaredScope?: readonly string[];
  readonly engineerMode?: EngineerMode;
  readonly reviewerMode?: ReviewerMode;
  readonly omitInterfaceOnFirstExpand?: boolean;
}

interface FixtureProject extends Project {
  readonly repo: string;
  readonly declaredScope: readonly string[];
  readonly managerId: string;
  readonly managerToken: string;
  readonly managerWorker: TaskWorker;
  readonly managerScratch: string;
  readonly engineerId: string;
  readonly engineerToken: string;
  readonly engineerWorker: TaskWorker;
  readonly engineerScratch: string;
  readonly verifierId: string;
  readonly verifierToken: string;
  readonly verifierWorker: TaskWorker;
}

interface FixtureOptions {
  readonly suffix: string;
  readonly originalRequest?: string;
  readonly engineerMode: EngineerMode;
  readonly reviewerMode?: ReviewerMode;
  readonly tier?: PlanTier;
  readonly verifyPasses: boolean;
  readonly declaredScope?: readonly string[];
  readonly repos?: readonly FixtureRepositoryOptions[];
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
  projectRoutes: Readonly<{
    ownProjectId: string;
    providerProjectId: string;
    consumerProjectId: string | null;
  }>,
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
  const contextMatch = /Bounded task context follows as JSON:\\n([^\\n]+)\\nReturn only/u.exec(input);
  if (contextMatch === null) throw new Error("manager prompt omitted bounded task context");
  const boundedContext = JSON.parse(contextMatch[1]);
  const boardProjects = boundedContext.boardProjects;
  const projectRoutes = ${JSON.stringify(projectRoutes)};
  if (!Array.isArray(boardProjects) || boardProjects.length < 1 || boardProjects.length > 64) {
    throw new Error("manager prompt omitted bounded board projects");
  }
  for (const project of boardProjects) {
    if (Object.keys(project).sort().join(",") !== "name,projectId,repoName") {
      throw new Error("manager prompt carried an invalid board project");
    }
  }
  for (const projectId of [projectRoutes.providerProjectId, projectRoutes.consumerProjectId].filter(Boolean)) {
    if (!boardProjects.some((project) => project.projectId === projectId)) {
      throw new Error("manager prompt omitted a routed board project");
    }
  }
  let workflowPlan = {
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
  if (input.includes(${JSON.stringify(BLAST_RADIUS_MARKER)})) {
    if (projectRoutes.consumerProjectId === null) throw new Error("blast-radius fixture requires a consumer project");
    workflowPlan = {
      ...workflowPlan,
      objective: "Coordinate a phased provider/consumer interface change.",
      acceptanceCriteria: ["Every phased child reaches its governed merge outcome."],
      changeShape: "blast_radius",
      declaredScope: ["coordination"],
      criterionChecks: [],
      children: [{
        key: "expand",
        objective: "Publish the additive provider interface.",
        projectId: projectRoutes.providerProjectId,
        declaredScope: ["src/provider", "docs/interface.md"],
        acceptanceCriteria: ["The additive interface is published in docs/interface.md."],
        phase: "expand",
        splitBy: "phase"
      }, {
        key: "migrate",
        objective: "Migrate the consumer against the published provider interface.",
        projectId: projectRoutes.consumerProjectId,
        declaredScope: ["src/consumer"],
        acceptanceCriteria: ["The consumer records and uses the exact published interface."],
        phase: "migrate",
        dependsOn: ["expand"],
        splitBy: "consumer"
      }, {
        key: "contract",
        objective: "Contract the provider after every consumer deploy is attested.",
        projectId: projectRoutes.providerProjectId,
        declaredScope: ["src/contract", "docs/interface.md"],
        acceptanceCriteria: ["The provider contract is finalized after migration."],
        phase: "contract",
        dependsOn: ["migrate"],
        splitBy: "phase"
      }],
      nodes: [{
        nodeId: ${JSON.stringify(`pipeline-${suffix}-parent-v`)} + revision,
        title: "Coordinate the phased interface change",
        objective: "Coordinate Expand, Migrate, and Contract.",
        acceptanceCriteria: ["The parent records all three governed child outcomes."],
        dependencyNodeIds: [],
        stageTemplate: ["verification"]
      }]
    };
  } else if (input.includes(${JSON.stringify(FEATURE_SPLIT_MARKER)})) {
    workflowPlan = {
      ...workflowPlan,
      objective: "Coordinate two independently reviewable feature children.",
      acceptanceCriteria: ["Both feature children merge under one parent approval."],
      changeShape: "feature",
      declaredScope: ["coordination"],
      criterionChecks: [],
      children: [{
        key: "feature-one",
        objective: "Implement the first independent feature slice.",
        projectId: projectRoutes.ownProjectId,
        declaredScope: ["src/feature/one"],
        acceptanceCriteria: ["The first feature slice passes verification."]
      }, {
        key: "feature-two",
        objective: "Implement the second independent feature slice.",
        projectId: projectRoutes.ownProjectId,
        declaredScope: ["src/feature/two"],
        acceptanceCriteria: ["The second feature slice passes verification."],
        dependsOn: ["feature-one"]
      }],
      nodes: [{
        nodeId: ${JSON.stringify(`pipeline-${suffix}-parent-v`)} + revision,
        title: "Coordinate the feature split",
        objective: "Coordinate both independent feature slices.",
        acceptanceCriteria: ["The parent records both child merges."],
        dependencyNodeIds: [],
        stageTemplate: ["verification"]
      }]
    };
  }
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

function engineerCliSource(
  mode: EngineerMode,
  delayMs = 0,
  phased: Readonly<{
    providerRepoPath: string | null;
    providerProjectId: string | null;
    providerRepoName: string | null;
    omitInterfaceOnFirstExpand: boolean;
  }> = {
    providerRepoPath: null,
    providerProjectId: null,
    providerRepoName: null,
    omitInterfaceOnFirstExpand: false,
  },
): string {
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
  const phased = ${JSON.stringify(phased)};
  const scopeMatch = /Declared scope \\(only these path prefixes\\): ([^.]*)\\./u.exec(input);
  const scopedRoot = scopeMatch === null ? "src/allowed" : scopeMatch[1].split(",")[0].trim();
  const fixMatch = /Fix round (\\d+) on branch/u.exec(input);
  const fixRound = fixMatch === null ? null : Number(fixMatch[1]);
  const isExpand = input.includes("This is the Expand phase of a planned interface change.");
  const isContract = input.includes("This is the Contract phase of a planned interface change.");
  const baseAdvanceRetry = input.includes("base branch advanced to") && input.includes("rebase onto it and re-verify");
  if (baseAdvanceRetry) {
    runGit(["rebase", "main"]);
  } else if (mode === "phased_consumer") {
    const interfaceHeader = /PUBLISHED interface below \\(([^\\s]+) @ ([0-9a-f]{40,64})\\);/u.exec(input);
    const providerProject = /Provider project: ([^\\n]+)\\n/u.exec(input);
    const providerRepository = /Provider repository: ([^\\n]+)\\n/u.exec(input);
    const publishedMarkdown = /--- BEGIN PUBLISHED INTERFACE ---\\n([\\s\\S]*?)\\n--- END PUBLISHED INTERFACE ---/u.exec(input);
    if (interfaceHeader === null || providerProject === null || providerRepository === null || publishedMarkdown === null) {
      throw new Error("consumer prompt omitted the published interface section");
    }
    const crossRepo = {
      interfacePath: interfaceHeader[1],
      sha: interfaceHeader[2],
      providerProjectId: providerProject[1],
      providerRepoName: providerRepository[1],
      markdown: publishedMarkdown[1],
    };
    if (crossRepo.providerProjectId !== phased.providerProjectId) throw new Error("consumer received the wrong provider project");
    if (crossRepo.providerRepoName !== phased.providerRepoName) throw new Error("consumer received the wrong provider repository name");
    if (crossRepo.interfacePath !== "docs/interface.md") throw new Error("consumer received the wrong interface path");
    if (!/^[0-9a-f]{40,64}$/u.test(crossRepo.sha)) throw new Error("consumer received an invalid Expand merge sha");
    if (crossRepo.markdown !== ${JSON.stringify(PUBLISHED_INTERFACE)}) throw new Error("consumer received different interface markdown");
    if (phased.providerRepoPath !== null) {
      if (process.argv.some((value) => value.includes(phased.providerRepoPath))) {
        throw new Error("provider repository path leaked through consumer argv");
      }
      if (Object.values(process.env).some((value) => typeof value === "string" && value.includes(phased.providerRepoPath))) {
        throw new Error("provider repository path leaked through consumer environment");
      }
      if (input.includes(phased.providerRepoPath)) throw new Error("provider repository path leaked through consumer prompt");
    }
    if (fixRound === null) {
      commit("src/consumer/provider-interface.md", crossRepo.markdown, "record published provider interface");
      commit("src/consumer/provider-context.json", JSON.stringify({
        providerProjectId: crossRepo.providerProjectId,
        sha: crossRepo.sha
      }) + "\\n", "record provider interface identity");
    } else {
      commit(
        "src/consumer/fix-round-" + fixRound + ".txt",
        "consumer fix round " + fixRound + "\\n",
        "fix consumer review round " + fixRound
      );
    }
  } else if (mode === "phased_provider" && isExpand) {
    if (fixRound === null) {
      commit("src/provider/change.txt", "additive provider change\\n", "expand provider interface");
      if (!phased.omitInterfaceOnFirstExpand) {
        commit("docs/interface.md", ${JSON.stringify(PUBLISHED_INTERFACE)}, "publish provider interface");
      }
    } else {
      commit("docs/interface.md", ${JSON.stringify(PUBLISHED_INTERFACE)}, "publish provider interface fix");
    }
  } else if (mode === "phased_provider" && isContract) {
    commit("src/contract/change.txt", "contract provider change\\n", "contract provider interface");
  } else if (fixRound !== null) {
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

async function fixtureRepository(root: string, name: string, verifyPasses: boolean): Promise<string> {
  const repo = join(root, name);
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
  const tier = options.tier ?? "standard";
  const repositoryOptions = options.repos ?? [{
    name: "repo",
    verifyPasses: options.verifyPasses,
    declaredScope: options.declaredScope,
    engineerMode: options.engineerMode,
    reviewerMode: options.reviewerMode,
  }];
  assert.ok(repositoryOptions.length > 0, "a pipeline fixture needs at least one repository");
  const repositories = await Promise.all(repositoryOptions.map(async (repository, index) => ({
    index,
    options: repository,
    repo: await fixtureRepository(root, repository.name, repository.verifyPasses),
  })));
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
  const projectRows: Array<Readonly<{
    index: number;
    options: FixtureRepositoryOptions;
    repo: string;
    project: Project;
  }>> = [];
  for (const repository of repositories) {
    const { project } = await jsonRequest<{ project: Project }>(address.url, "/v1/projects", "POST", 201, {
      body: {
        name: `Pipeline fixture ${options.suffix} ${repository.options.name}`,
        description: `Real Git fixture for ${repository.options.name}.`,
        repoPath: repository.repo,
      },
    });
    projectRows.push({ ...repository, project });
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
  const workspaceRoot = join(root, "implementation-workspaces");
  const provider = projectRows[0]!;
  const consumer = projectRows[1] ?? null;
  const fixtureProjects: FixtureProject[] = [];
  for (const row of projectRows) {
    const identitySuffix = row.index === 0 ? "" : `-${row.index + 1}`;
    const managerId = `pipeline-${options.suffix}${identitySuffix}-manager`;
    const engineerId = `pipeline-${options.suffix}${identitySuffix}-engineer`;
    const verifierId = `pipeline-${options.suffix}${identitySuffix}-verifier`;
    const managerToken = row.index === 0
      ? MANAGER_TOKEN
      : `pipeline-e2e-manager-${row.index + 1}-token-0123456789abcdef`;
    const engineerToken = row.index === 0
      ? ENGINEER_TOKEN
      : `pipeline-e2e-engineer-${row.index + 1}-token-0123456789abcdef`;
    const verifierToken = row.index === 0
      ? VERIFIER_TOKEN
      : `pipeline-e2e-verifier-${row.index + 1}-token-0123456789abcdef`;
    await jsonRequest(address.url, `/v1/projects/${row.project.projectId}/agents`, "POST", 201, {
      body: {
        agentId: managerId,
        role: "manager",
        area: "pipeline planning",
        mission: "Return complete Pipeline v2 plans for human approval.",
        model: "fake-codex",
        token: managerToken,
      },
    });
    await jsonRequest(address.url, `/v1/projects/${row.project.projectId}/agents`, "POST", 201, {
      body: {
        agentId: verifierId,
        role: "verifier",
        area: "pipeline verification",
        mission: "Independently review the machine-verified pipeline evidence.",
        model: VERIFIER_RUN_PIN.model,
        token: verifierToken,
      },
    });
    await jsonRequest(address.url, `/v1/projects/${row.project.projectId}/agents`, "POST", 201, {
      body: {
        agentId: engineerId,
        role: "engineer",
        area: "pipeline implementation",
        mission: "Implement only the confirmed declared scope and commit each logical change.",
        model: ENGINEER_RUN_PIN.model,
        token: engineerToken,
      },
    });
    const declaredScope = row.options.declaredScope ?? options.declaredScope ?? ["src/allowed"];
    const cliLabel = row.index === 0 ? "" : `-${row.index + 1}`;
    const managerCli = await fakeCodex(
      root,
      `manager${cliLabel}-cli`,
      managerCliSource(options.suffix, declaredScope, tier, options.scopeRoutes, {
        ownProjectId: row.project.projectId,
        providerProjectId: provider.project.projectId,
        consumerProjectId: consumer?.project.projectId ?? null,
      }),
    );
    const engineerCli = await fakeCodex(
      root,
      `engineer${cliLabel}-cli`,
      engineerCliSource(row.options.engineerMode ?? options.engineerMode, options.engineerDelayMs, {
        providerRepoPath: provider.repo,
        providerProjectId: provider.project.projectId,
        providerRepoName: provider.project.name,
        omitInterfaceOnFirstExpand: row.options.omitInterfaceOnFirstExpand ?? false,
      }),
    );
    const verifierCli = await fakeCodex(
      root,
      `verifier${cliLabel}-cli`,
      verifierCliSource(row.options.reviewerMode ?? options.reviewerMode ?? "passed"),
    );
    const managerWorker = await TaskWorker.create({
      identity: { workerId: `pipeline-${options.suffix}${identitySuffix}-manager-worker`, agentId: managerId },
      statePath: join(root, `manager${cliLabel}-worker`, "journal.json"),
      board: new HttpTaskBoardClient({ baseUrl: address.url, token: managerToken }),
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
    const engineerWorker = await TaskWorker.create({
      identity: { workerId: `pipeline-${options.suffix}${identitySuffix}-engineer-worker`, agentId: engineerId },
      statePath: join(root, `engineer${cliLabel}-worker`, "journal.json"),
      board: new HttpTaskBoardClient({ baseUrl: address.url, token: engineerToken }),
      launcher: new WorkspaceScopedLauncher(
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
        new TaskWorkspaceManager({ workspaceRoot, repositoryPath: row.repo }),
      ),
      pinned: ENGINEER_RUN_PIN,
      longPollMs: 1,
    });
    const verifierWorker = await TaskWorker.create({
      identity: { workerId: `pipeline-${options.suffix}${identitySuffix}-verifier-worker`, agentId: verifierId },
      statePath: join(root, `verifier${cliLabel}-worker`, "journal.json"),
      board: new HttpTaskBoardClient({ baseUrl: address.url, token: verifierToken }),
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
    fixtureProjects.push({
      ...row.project,
      repo: row.repo,
      declaredScope,
      managerId,
      managerToken,
      managerWorker,
      managerScratch: managerCli.scratch,
      engineerId,
      engineerToken,
      engineerWorker,
      engineerScratch: engineerCli.scratch,
      verifierId,
      verifierToken,
      verifierWorker,
    });
  }
  const project = fixtureProjects[0]!;
  let secondEngineer: PipelineFixture["secondEngineer"] = null;
  if (options.twoEngineerLanes === true) {
    const secondEngineerId = `pipeline-${options.suffix}-engineer-two`;
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
    const secondEngineerCli = await fakeCodex(
      root,
      "engineer-two-cli",
      engineerCliSource(options.engineerMode, options.engineerDelayMs),
    );
    const secondEngineerWorker = await TaskWorker.create({
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
        new TaskWorkspaceManager({ workspaceRoot, repositoryPath: project.repo }),
      ),
      pinned: ENGINEER_RUN_PIN,
      longPollMs: 1,
    });
    secondEngineer = {
      id: secondEngineerId,
      token: ENGINEER_TWO_TOKEN,
      worker: secondEngineerWorker,
      scratch: secondEngineerCli.scratch,
    };
  }
  const { workItem } = await jsonRequest<{ workItem: WorkItem }>(address.url, "/v1/work-items", "POST", 201, {
    idempotencyKey: `pipeline-e2e-${options.suffix}`,
    body: {
      originalRequest: options.originalRequest ?? RAW_REQUEST,
      priority: "normal",
      projectTarget: { mode: "explicit", projectId: project.projectId },
    },
  });
  assert.equal(workItem.state, "planning");
  return {
    root,
    repo: project.repo,
    dbPath,
    origin: address.url,
    service,
    sweepBoard,
    projects: fixtureProjects,
    project,
    workItem,
    managerId: project.managerId,
    engineerId: project.engineerId,
    verifierId: project.verifierId,
    managerWorker: project.managerWorker,
    engineerWorker: project.engineerWorker,
    secondEngineer,
    verifierWorker: project.verifierWorker,
    managerScratch: project.managerScratch,
    engineerScratch: project.engineerScratch,
    workspaceRoot,
    verifyWorkspaceRoot,
    declaredScope: project.declaredScope,
    tier,
  };
}

async function closeFixture(fixture: PipelineFixture): Promise<void> {
  for (const project of fixture.projects) {
    await project.managerWorker.close();
    await project.engineerWorker.close();
    await project.verifierWorker.close();
  }
  await fixture.secondEngineer?.worker.close();
  fixture.sweepBoard.close();
  await fixture.service.close();
}

async function workflow(
  fixture: PipelineFixture,
  project: Project = fixture.project,
): Promise<WorkflowSnapshot> {
  return (await jsonRequest<{ workflow: WorkflowSnapshot }>(
    fixture.origin,
    `/v1/projects/${project.projectId}/workflow`,
    "GET",
    200,
  )).workflow;
}

async function childrenFor(fixture: PipelineFixture, parentWorkItemId: string): Promise<readonly ChildWorkItem[]> {
  return (await jsonRequest<{ children: readonly ChildWorkItem[] }>(
    fixture.origin,
    `/v1/work-items/${parentWorkItemId}/children`,
    "GET",
    200,
  )).children;
}

function latestNodeBlock(fixture: PipelineFixture, workItemId: string): string | null {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT event.summary
      FROM project_events event
      JOIN work_nodes node ON node.node_id=event.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      WHERE plan.work_item_id=? AND event.event_type='node_blocked'
      ORDER BY event.sequence DESC
      LIMIT 1
    `).get(workItemId) as { summary?: unknown } | undefined;
    return row === undefined ? null : String(row.summary);
  } finally {
    db.close();
  }
}

function singleFinalApproval(fixture: PipelineFixture, workItemId: string, expectMergeSha = true) {
  const approvals = gateActions(fixture.dbPath, workItemId).filter((action) => action.gate === "final_approve");
  assert.equal(approvals.length, 1, `${workItemId} must have exactly one final_approve action`);
  const approval = approvals[0];
  assert.ok(approval);
  if (expectMergeSha) assert.match(approval.mergeSha ?? "", /^[0-9a-f]{40,64}$/u);
  return approval;
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

async function proposeAndConfirmDecomposition(
  fixture: PipelineFixture,
  expectedShape: "feature" | "blast_radius",
  expectedPhases: readonly ("expand" | "migrate" | "contract" | null)[],
): Promise<Readonly<{
  plan: PlanRevision;
  children: readonly ChildWorkItem[];
}>> {
  assert.equal(await fixture.project.managerWorker.dispatchOnce(), true);
  assert.equal((await currentWorkItem(fixture)).state, "plan_approval");
  const snapshot = await workflow(fixture);
  const plan = proposedPlan(snapshot, fixture.workItem.workItemId);
  assert.equal(plan.changeShape, expectedShape);
  assert.equal(plan.tier, "standard");
  assert.equal(plan.children?.length, expectedPhases.length);
  assert.deepEqual(plan.children?.map((child) => child.phase ?? null), expectedPhases);
  for (const child of plan.children ?? []) {
    assert.ok(child.objective.length > 0);
    assert.ok(child.declaredScope.length > 0);
    assert.ok(child.acceptanceCriteria.length > 0);
  }
  await jsonRequest<ConfirmPlanRevisionResponse>(
    fixture.origin,
    `/v1/plans/${plan.planRevisionId}/confirm`,
    "POST",
    200,
    { body: { expectedState: "proposed" } },
  );
  const parent = await currentWorkItem(fixture);
  assert.equal(parent.state, "coordinating");
  assert.equal(parent.pipelineBranch, null);
  assert.equal(parent.baseSha, null);
  const children = await childrenFor(fixture, parent.workItemId);
  assert.equal(children.length, expectedPhases.length);
  assert.deepEqual(children.map((child) => child.phase), expectedPhases);
  assert.deepEqual(children.map((child) => child.childOrdinal), expectedPhases.map((_, index) => index));
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    for (const child of children) {
      assert.equal(db.prepare(`
        SELECT to_state
        FROM work_item_transitions
        WHERE work_item_id=? AND sequence=1
      `).get(child.workItemId)?.to_state, "queued");
    }
  } finally {
    db.close();
  }
  return { plan, children };
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

test("campaign 10 exit: a blast-radius change lands as phased children across two repos", async () => {
  const fixture = await createFixture({
    suffix: "exit-blast-radius",
    originalRequest: `Deliver the ${BLAST_RADIUS_MARKER} across provider and consumer repositories.`,
    engineerMode: "scoped",
    verifyPasses: true,
    repos: [{
      name: "provider",
      verifyPasses: true,
      engineerMode: "phased_provider",
      omitInterfaceOnFirstExpand: true,
    }, {
      name: "consumer",
      verifyPasses: true,
      engineerMode: "phased_consumer",
    }],
  });
  try {
    const [provider, consumer] = fixture.projects;
    assert.ok(provider);
    assert.ok(consumer);
    assert.notEqual(provider.projectId, consumer.projectId);
    assert.notEqual(provider.managerId, consumer.managerId);
    assert.notEqual(provider.engineerId, consumer.engineerId);
    assert.notEqual(provider.verifierId, consumer.verifierId);

    const decomposition = await proposeAndConfirmDecomposition(
      fixture,
      "blast_radius",
      ["expand", "migrate", "contract"],
    );
    const [expand, migrate, contract] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    assert.ok(contract);
    assert.equal(expand.resolvedProjectId, provider.projectId);
    assert.equal(migrate.resolvedProjectId, consumer.projectId);
    assert.equal(contract.resolvedProjectId, provider.projectId);
    assert.deepEqual(decomposition.plan.children?.map((child) => child.dependsOn ?? []), [[], ["expand"], ["migrate"]]);
    assert.equal((await currentWorkItem(fixture, expand.workItemId)).state, "implementing");
    assert.equal((await currentWorkItem(fixture, migrate.workItemId)).state, "queued");
    assert.equal((await currentWorkItem(fixture, contract.workItemId)).state, "queued");
    assert.equal(await consumer.engineerWorker.dispatchOnce(), false);

    assert.equal(await provider.engineerWorker.dispatchOnce(), true);
    assert.equal((await currentWorkItem(fixture, expand.workItemId)).state, "verifying");
    await driveVerifyItem(fixture, expand.workItemId, "reviewing");
    assert.equal(await provider.verifierWorker.dispatchOnce(), true);
    assert.equal((await currentWorkItem(fixture, expand.workItemId)).state, "fixing");
    assert.equal(await consumer.engineerWorker.dispatchOnce(), false);
    const publicationDb = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const verificationHandoffs = publicationDb.prepare(`
        SELECT handoff.payload_json
        FROM stage_handoffs handoff
        JOIN work_nodes node ON node.node_id=handoff.node_id
        JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
        WHERE plan.work_item_id=? AND handoff.stage='verification'
        ORDER BY handoff.created_at,handoff.rowid
      `).all(expand.workItemId).map((row) => JSON.parse(String(row.payload_json))) as Array<{
        outcome: string;
        summary: string;
        blockers: string[];
      }>;
      assert.equal(verificationHandoffs[0]?.outcome, "passed");
      assert.equal(verificationHandoffs[0]?.summary, "Independent verification passed.");
      assert.equal(verificationHandoffs[1]?.outcome, "failed");
      assert.equal(verificationHandoffs[1]?.blockers.at(-1), "publish docs/interface.md (absent)");
      assert.equal(publicationDb.prepare(`
        SELECT event.actor_id
        FROM task_events event
        JOIN stage_handoffs handoff ON handoff.task_id=event.task_id
        JOIN work_nodes node ON node.node_id=handoff.node_id
        JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
        WHERE plan.work_item_id=?
          AND event.actor_id='system:interface-publication'
          AND event.event_type='task_created'
        ORDER BY event.created_at DESC,event.rowid DESC
        LIMIT 1
      `).get(expand.workItemId)?.actor_id, "system:interface-publication");
      assert.equal(publicationDb.prepare(`
        SELECT expected
        FROM review_findings finding
        JOIN work_nodes node ON node.node_id=finding.node_id
        JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
        WHERE plan.work_item_id=? AND finding.file='docs/interface.md'
        ORDER BY finding.created_at DESC,finding.rowid DESC
        LIMIT 1
      `).get(expand.workItemId)?.expected, "publish docs/interface.md (absent)");
    } finally {
      publicationDb.close();
    }

    assert.equal(await provider.engineerWorker.dispatchOnce(), true);
    assert.equal(await readFile(join(provider.repo, "docs", "interface.md"), "utf8").catch(() => null), null);
    await driveVerifyItem(fixture, expand.workItemId, "reviewing");
    assert.equal(await provider.verifierWorker.dispatchOnce(), true);
    const mergedExpand = await currentWorkItem(fixture, expand.workItemId);
    assert.equal(mergedExpand.state, "merged");
    const parentPlanConfirm = gateActions(fixture.dbPath, fixture.workItem.workItemId).find(
      (action) => action.gate === "plan_confirm",
    );
    assert.ok(parentPlanConfirm);
    const expandApproval = singleFinalApproval(fixture, expand.workItemId);
    const expandMainSha = (await git(provider.repo, ["rev-parse", "main"])).trim();
    assert.equal(expandApproval.mergeSha, expandMainSha);
    assert.equal(expandApproval.actorId, "system:parent-plan-authorization");
    assert.equal(expandApproval.refId, parentPlanConfirm.gateActionId);
    assert.equal((await currentWorkItem(fixture, migrate.workItemId)).state, "implementing");

    assert.equal(await consumer.engineerWorker.dispatchOnce(), true);
    await driveVerifyItem(fixture, migrate.workItemId, "reviewing");
    assert.equal(await consumer.verifierWorker.dispatchOnce(), true);
    assert.equal((await currentWorkItem(fixture, migrate.workItemId)).state, "merged");
    const migrateApproval = singleFinalApproval(fixture, migrate.workItemId);
    const migrateMainSha = (await git(consumer.repo, ["rev-parse", "main"])).trim();
    assert.equal(migrateApproval.mergeSha, migrateMainSha);
    assert.equal(migrateApproval.actorId, "system:parent-plan-authorization");
    assert.equal(migrateApproval.refId, parentPlanConfirm.gateActionId);
    assert.equal(await readFile(join(consumer.repo, "src", "consumer", "provider-interface.md"), "utf8"), PUBLISHED_INTERFACE);
    assert.equal(
      JSON.parse(await readFile(join(consumer.repo, "src", "consumer", "provider-context.json"), "utf8")).sha,
      expandApproval.mergeSha,
    );
    assert.equal(
      await git(provider.repo, ["show", `${expandApproval.mergeSha}:docs/interface.md`]),
      PUBLISHED_INTERFACE,
    );

    assert.equal((await currentWorkItem(fixture, contract.workItemId)).state, "queued");
    assert.equal(latestNodeBlock(fixture, contract.workItemId),
      `waits for ${expand.workItemId} (expand) deploy attestation`);
    await jsonRequest(fixture.origin, `/v1/work-items/${migrate.workItemId}/attest-deploy`, "POST", 200, {
      body: { note: "The consumer migration is deployed." },
    });
    assert.equal((await currentWorkItem(fixture, contract.workItemId)).state, "queued");
    assert.equal(latestNodeBlock(fixture, contract.workItemId),
      `waits for ${expand.workItemId} (expand) deploy attestation`);
    await jsonRequest(fixture.origin, `/v1/work-items/${expand.workItemId}/attest-deploy`, "POST", 200, {
      body: { note: "The additive provider interface is deployed." },
    });
    const activeContract = await currentWorkItem(fixture, contract.workItemId);
    assert.equal(activeContract.state, "implementing");
    assert.equal(activeContract.baseSha, (await git(provider.repo, ["rev-parse", "HEAD"])).trim());

    assert.equal(await provider.engineerWorker.dispatchOnce(), true);
    await driveVerifyItem(fixture, contract.workItemId, "reviewing");
    assert.equal(await provider.verifierWorker.dispatchOnce(), true);
    const contractFinalApproval = await currentWorkItem(fixture, contract.workItemId);
    assert.equal(contractFinalApproval.state, "final_approval");
    const contractMerged = await jsonRequest<{ workItem: WorkItem }>(
      fixture.origin,
      `/v1/work-items/${contract.workItemId}/approve-merge`,
      "POST",
      200,
      { body: { version: contractFinalApproval.version } },
    );
    assert.equal(contractMerged.workItem.state, "merged");
    assert.equal((await currentWorkItem(fixture)).state, "merged");
    const contractApproval = singleFinalApproval(fixture, contract.workItemId);
    const contractMainSha = (await git(provider.repo, ["rev-parse", "main"])).trim();
    assert.equal(contractApproval.mergeSha, contractMainSha);
    assert.equal(contractApproval.actorId, "human:pipeline-reviewer");
    const parentApproval = singleFinalApproval(fixture, fixture.workItem.workItemId, false);
    assert.equal(parentApproval.refId, decomposition.plan.planRevisionId);
    assert.equal(parentApproval.mergeSha, null);
    assert.equal(parentApproval.note, "3 children merged, 0 abandoned");
    assert.deepEqual(
      fixture.sweepBoard.parentCompletion(fixture.workItem.workItemId).children,
      [{ workItemId: expand.workItemId, mergeSha: expandMainSha },
        { workItemId: migrate.workItemId, mergeSha: migrateMainSha },
        { workItemId: contract.workItemId, mergeSha: contractMainSha }],
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("campaign 10 exit: a same-repository feature split re-verifies after the first parent approval", async () => {
  const fixture = await createFixture({
    suffix: "exit-feature-split",
    originalRequest: `Deliver the ${FEATURE_SPLIT_MARKER} in one repository.`,
    engineerMode: "scoped",
    verifyPasses: true,
  });
  try {
    const decomposition = await proposeAndConfirmDecomposition(fixture, "feature", [null, null]);
    const [first, second] = decomposition.children;
    assert.ok(first);
    assert.ok(second);
    assert.deepEqual(decomposition.plan.children?.map((child) => child.dependsOn ?? []), [[], ["feature-one"]]);
    assert.equal((await currentWorkItem(fixture, first.workItemId)).state, "implementing");
    assert.equal((await currentWorkItem(fixture, second.workItemId)).state, "implementing");

    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    await waitForServiceVerifyLaunches(fixture, [first.workItemId, second.workItemId]);
    await driveVerifyItem(fixture, first.workItemId, "reviewing");
    await driveVerifyItem(fixture, second.workItemId, "reviewing");
    assert.equal(await fixture.verifierWorker.dispatchOnce(), true);
    assert.equal(await fixture.verifierWorker.dispatchOnce(), true);
    assert.deepEqual(
      await Promise.all([first, second].map(async (child) => (await currentWorkItem(fixture, child.workItemId)).state)),
      ["final_approval", "final_approval"],
    );
    const parentApproval = await currentWorkItem(fixture);
    assert.equal(parentApproval.state, "final_approval");
    const notifications = await jsonRequest<{ unread: Array<{ kind: string; workItemId: string | null }> }>(
      fixture.origin,
      "/v1/notifications",
      "GET",
      200,
    );
    assert.equal(notifications.unread.filter((notification) =>
      notification.kind === "parent_ready_for_approval" &&
      notification.workItemId === fixture.workItem.workItemId).length, 1);

    const coordinating = await jsonRequest<{ workItem: WorkItem }>(
      fixture.origin,
      `/v1/work-items/${fixture.workItem.workItemId}/approve-merge`,
      "POST",
      200,
      { body: { version: parentApproval.version } },
    );
    assert.equal(coordinating.workItem.state, "coordinating");
    assert.deepEqual(
      await Promise.all([first, second].map(async (child) => (await currentWorkItem(fixture, child.workItemId)).state)),
      ["merged", "implementing"],
    );
    assert.ok((await jsonRequest<{ unread: Array<{ kind: string; workItemId: string | null }> }>(
      fixture.origin,
      "/v1/notifications",
      "GET",
      200,
    )).unread.some((notification) =>
      notification.kind === "final_approval_withdrawn" && notification.workItemId === second.workItemId));

    assert.equal(await fixture.engineerWorker.dispatchOnce(), true);
    await driveVerifyItem(fixture, second.workItemId, "reviewing");
    assert.equal(await fixture.verifierWorker.dispatchOnce(), true);
    assert.equal((await currentWorkItem(fixture, second.workItemId)).state, "final_approval");
    const secondParentApproval = await currentWorkItem(fixture);
    assert.equal(secondParentApproval.state, "final_approval");
    const merged = await jsonRequest<{ workItem: WorkItem }>(
      fixture.origin,
      `/v1/work-items/${fixture.workItem.workItemId}/approve-merge`,
      "POST",
      200,
      { body: { version: secondParentApproval.version } },
    );
    assert.equal(merged.workItem.state, "merged");
    assert.equal((await currentWorkItem(fixture, second.workItemId)).state, "merged");
    const [firstApproval, secondApproval] = [first, second].map((child) =>
      singleFinalApproval(fixture, child.workItemId));
    assert.ok(firstApproval);
    assert.ok(secondApproval);
    assert.equal(firstApproval.actorId, "human:pipeline-reviewer");
    assert.equal(secondApproval.actorId, "human:pipeline-reviewer");
    assert.equal(await git(fixture.repo, [
      "merge-base",
      "--is-ancestor",
      firstApproval.mergeSha!,
      secondApproval.mergeSha!,
    ]), "");
    const parentGate = singleFinalApproval(fixture, fixture.workItem.workItemId, false);
    assert.equal(parentGate.refId, decomposition.plan.planRevisionId);
    assert.equal(parentGate.note, "2 children merged, 0 abandoned");
  } finally {
    await closeFixture(fixture);
  }
});

test("campaign 10 exit: a child dead-lettering parks the parent (child_failed)", async () => {
  const fixture = await createFixture({
    suffix: "exit-child-failed",
    originalRequest: `Deliver the ${BLAST_RADIUS_MARKER} with a deliberately rejected migration.`,
    engineerMode: "scoped",
    verifyPasses: true,
    repos: [{
      name: "provider",
      verifyPasses: true,
      engineerMode: "phased_provider",
    }, {
      name: "consumer",
      verifyPasses: true,
      engineerMode: "phased_consumer",
      reviewerMode: "always_blocking",
    }],
  });
  let cancellationVerifyRunner: VerifyRunner | null = null;
  let cancellationVerifyRunId: string | null = null;
  let cancellationVerifyPid: number | null = null;
  try {
    const [provider, consumer] = fixture.projects;
    assert.ok(provider);
    assert.ok(consumer);
    const decomposition = await proposeAndConfirmDecomposition(
      fixture,
      "blast_radius",
      ["expand", "migrate", "contract"],
    );
    const [expand, migrate, contract] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    assert.ok(contract);

    assert.equal(await provider.engineerWorker.dispatchOnce(), true);
    await driveVerifyItem(fixture, expand.workItemId, "reviewing");
    assert.equal(await provider.verifierWorker.dispatchOnce(), true);
    assert.equal((await currentWorkItem(fixture, expand.workItemId)).state, "merged");
    assert.equal((await currentWorkItem(fixture, migrate.workItemId)).state, "implementing");

    for (let round = 1; round <= 4; round += 1) {
      assert.equal(await consumer.engineerWorker.dispatchOnce(), true);
      await driveVerifyItem(fixture, migrate.workItemId, "reviewing");
      assert.equal(await consumer.verifierWorker.dispatchOnce(), true);
      assert.equal(
        (await currentWorkItem(fixture, migrate.workItemId)).state,
        round === 4 ? "dead_letter" : "fixing",
      );
    }
    assert.equal((await currentWorkItem(fixture)).state, "parked");
    assert.equal((await currentWorkItem(fixture, contract.workItemId)).state, "queued");
    assert.equal(latestNodeBlock(fixture, contract.workItemId),
      `blocked: ${migrate.workItemId} (migrate) dead_letter`);
    const parks = await jsonRequest<{ open: Array<{ workItemId: string; category: string }> }>(
      fixture.origin,
      "/v1/ledgers/parks",
      "GET",
      200,
    );
    assert.ok(parks.open.some((park) =>
      park.workItemId === fixture.workItem.workItemId && park.category === "child_failed"));

    const rejectedResumeSideEffects = () => {
      const inspected = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        return Object.freeze({
          tasks: Number(inspected.prepare("SELECT COUNT(*) AS count FROM tasks").get()?.count),
          wakeups: Number(inspected.prepare("SELECT COUNT(*) AS count FROM wakeups").get()?.count),
          transitions: Number(inspected.prepare("SELECT COUNT(*) AS count FROM work_item_transitions").get()?.count),
          notifications: Number(inspected.prepare("SELECT COUNT(*) AS count FROM notifications").get()?.count),
          taskEvents: Number(inspected.prepare("SELECT COUNT(*) AS count FROM task_events").get()?.count),
          projectEvents: Number(inspected.prepare("SELECT COUNT(*) AS count FROM project_events").get()?.count),
        });
      } finally {
        inspected.close();
      }
    };
    const beforeRejectedResume = rejectedResumeSideEffects();

    const rejectedResume = await jsonRequest<{ error: { code: string; message: string } }>(
      fixture.origin,
      `/v1/work-items/${fixture.workItem.workItemId}/resume`,
      "POST",
      409,
    );
    assert.equal(rejectedResume.error.code, "PARENT_PHASED_FAILED");
    assert.deepEqual(rejectedResumeSideEffects(), beforeRejectedResume, "a rejected resume must be side-effect-free");
    const parkedParent = await currentWorkItem(fixture);
    assert.equal(parkedParent.state, "parked");
    assert.equal((await currentWorkItem(fixture, contract.workItemId)).state, "queued");
    assert.equal(latestNodeBlock(fixture, contract.workItemId),
      `blocked: ${migrate.workItemId} (migrate) dead_letter`);

    const activeContractTask = fixture.sweepBoard.createTask(provider.projectId, {
      parentTaskId: null,
      title: "Hold Contract work open until the family is cancelled",
      objective: "Exercise cancellation of a run linked to the blocked Contract child.",
      acceptanceCriteria: "The parent cancellation interrupts this run.",
      workspaceRefs: [],
      assignedAgentId: provider.engineerId,
      assignedRole: "engineer",
      requiresReview: false,
    });
    const activeContractRun = fixture.sweepBoard.claimRun(provider.engineerId, {
      claimId: "exit-child-failed-contract-cancel-run",
      messageCursor: null,
    });
    assert.ok(activeContractRun?.task);
    assert.equal(activeContractRun.task.taskId, activeContractTask.taskId);
    const verifyAttemptId = `verify-cancel-${contract.workItemId}`;
    const verifyWorkspaceKey = `${contract.workItemId}-verify`;
    const verifyWorkspaceManager = new TaskWorkspaceManager({
      workspaceRoot: fixture.verifyWorkspaceRoot,
      repositoryPath: provider.repo,
    });
    const verifyWorkspacePath = await verifyWorkspaceManager.create(
      verifyWorkspaceKey,
      contract.baseSha ?? undefined,
      contract.workItemId,
    );
    await writeFile(
      join(verifyWorkspacePath, "verify-full.mjs"),
      "setTimeout(() => process.exit(0), 60_000);\n",
    );
    cancellationVerifyRunner = new VerifyRunner({
      repoRoot: verifyWorkspacePath,
      supervisorPath: DEFAULT_SUPERVISOR_PATH,
    });
    cancellationVerifyRunId = await cancellationVerifyRunner.startFull();
    const verifyStatus = JSON.parse(await readFile(join(
      verifyWorkspacePath,
      ".verify-runs",
      cancellationVerifyRunId,
      "status.json",
    ), "utf8")) as { pid?: unknown; state?: unknown };
    assert.equal(verifyStatus.state, "running");
    assert.equal(typeof verifyStatus.pid, "number");
    const verifyPid = Number(verifyStatus.pid);
    cancellationVerifyPid = verifyPid;
    process.kill(verifyPid, 0);
    let contractNodeId = "";
    let completionEventsBeforeCancel = 0;
    const cancellationSetupDb = new DatabaseSync(fixture.dbPath);
    try {
      const contractNode = cancellationSetupDb.prepare(`
        SELECT node.node_id
        FROM work_nodes node
        JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
        WHERE plan.work_item_id=? AND plan.state='confirmed'
        LIMIT 1
      `).get(contract.workItemId);
      assert.ok(contractNode);
      contractNodeId = String(contractNode.node_id);
      cancellationSetupDb.prepare(`
        INSERT INTO stage_attempts(attempt_id,node_id,task_id,stage,attempt,skill_digests_json)
        VALUES(?,?,?,'implementation',99,'{}')
      `).run(`attempt-cancel-${contract.workItemId}`, contractNodeId, activeContractTask.taskId);
      cancellationSetupDb.prepare(`
        INSERT INTO verify_attempts(
          verify_attempt_id,node_id,stage,attempt,verify_run_id,workspace_path,state,
          check_results_json,detail,created_at,ended_at
        ) VALUES(?,?,'testing',99,?,?,'running',NULL,NULL,?,NULL)
      `).run(
        verifyAttemptId,
        contractNodeId,
        cancellationVerifyRunId,
        verifyWorkspacePath,
        new Date().toISOString(),
      );
      completionEventsBeforeCancel = Number(cancellationSetupDb.prepare(`
        SELECT COUNT(*) AS count
        FROM project_events
        WHERE node_id=? AND event_type='stage_completed'
      `).get(contractNodeId)?.count);
    } finally {
      cancellationSetupDb.close();
    }

    const cancelled = await jsonRequest<{ workItem: WorkItem }>(
      fixture.origin,
      `/v1/work-items/${fixture.workItem.workItemId}`,
      "PATCH",
      200,
      {
        body: {
          version: parkedParent.version,
          action: "cancel",
          reason: "Cancel the unsafe phased family after the migration dead-lettered.",
        },
      },
    );
    assert.equal(cancelled.workItem.state, "abandoned");
    assert.equal((await currentWorkItem(fixture, expand.workItemId)).state, "merged");
    assert.equal((await currentWorkItem(fixture, migrate.workItemId)).state, "dead_letter");
    assert.equal((await currentWorkItem(fixture, contract.workItemId)).state, "abandoned");
    assert.equal(
      await fixture.sweepBoard.sweepVerifyAttempts(),
      1,
      "the durable retired verifier seeded by this arc is replayed once",
    );
    const cleanupDeadline = Date.now() + 5_000;
    while (Date.now() < cleanupDeadline) {
      try {
        await access(verifyWorkspacePath);
      } catch {
        break;
      }
      await delay(25);
    }
    await assert.rejects(access(verifyWorkspacePath));
    const processDeadline = Date.now() + 5_000;
    let verifyProcessRunning = true;
    while (Date.now() < processDeadline && verifyProcessRunning) {
      try {
        process.kill(verifyPid, 0);
        await delay(25);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        verifyProcessRunning = false;
      }
    }
    assert.equal(verifyProcessRunning, false, "the retired Contract verifier process must terminate");
    const cancellationDb = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const retiredAttempt = cancellationDb.prepare(`
        SELECT state,ended_at
        FROM verify_attempts
        WHERE verify_attempt_id=?
      `).get(verifyAttemptId);
      assert.equal(retiredAttempt?.state, "retired");
      assert.equal(retiredAttempt?.ended_at, (await currentWorkItem(fixture, contract.workItemId)).endedAt);
      const interruptedRun = cancellationDb.prepare(`
        SELECT status,ended_at
        FROM runs
        WHERE run_id=?
      `).get(activeContractRun.run.runId);
      assert.equal(interruptedRun?.status, "interrupted");
      assert.equal(interruptedRun?.ended_at, cancelled.workItem.endedAt);
      assert.equal(cancellationDb.prepare("SELECT status FROM tasks WHERE task_id=?")
        .get(activeContractTask.taskId)?.status, "cancelled");
      assert.equal(Number(cancellationDb.prepare(`
        SELECT COUNT(*) AS count
        FROM project_events
        WHERE node_id=? AND event_type='stage_completed'
      `).get(contractNodeId)?.count), completionEventsBeforeCancel);
      assert.equal(cancellationDb.prepare("SELECT 1 FROM stage_handoffs WHERE handoff_id=?")
        .get(`handoff_${verifyAttemptId}`), undefined);
    } finally {
      cancellationDb.close();
    }
  } finally {
    await closeFixture(fixture);
    if (cancellationVerifyRunner !== null && cancellationVerifyRunId !== null) {
      await cancellationVerifyRunner.terminate(cancellationVerifyRunId).catch(() => undefined);
    }
    if (cancellationVerifyPid !== null) {
      try {
        process.kill(cancellationVerifyPid, 0);
        process.kill(process.platform === "win32" ? cancellationVerifyPid : -cancellationVerifyPid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
});
