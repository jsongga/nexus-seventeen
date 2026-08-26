import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { claudeAdapter } from "../../../src/server/agents/runtime/claude.js";
import { codexAdapter } from "../../../src/server/agents/runtime/codex.js";
import { runtimeRegistry } from "../../../src/server/agents/runtime/registry.js";
import { parseTaskFleetConfig } from "#server/agents/task-fleet/config";
import {
  createTaskFleetWorker,
  type ManagedTaskWorker,
  type TaskFleetAgentConfig,
} from "#server/agents/task-fleet";
import { structuredOutcome } from "#server/agents/task-worker/agent-envelope";
import { mapChangedFiles, parseVerifyContract } from "#server/agents/verify";
import {
  type ConfirmPlanRevisionResponse,
  type PlanRevision,
  type Project,
  type WorkItem,
  type WorkNode,
} from "#shared/task-board-contract";
import {
  createTaskBoardService,
  normalizeTaskBoardConfig,
  TaskBoard,
  type TaskBoardService,
} from "#server/task-board";
import { SHIPPED_RUNTIME_PROFILES } from "../agents/runtime/profile-fixtures.js";
import {
  automationConfigurationRequest,
  automationStages,
  fakeCli,
  type FakeCliFixture,
} from "./helpers.js";

const HUMAN_TOKEN = "onboarding-e2e-human-token-0123456789abcdef";
const MANAGER_TOKEN = "onboarding-e2e-manager-token-0123456789abcdef";
const ENGINEER_TOKEN = "onboarding-e2e-engineer-token-0123456789abcdef";
const VERIFIER_TOKEN = "onboarding-e2e-verifier-token-0123456789abcdef";
const PROMPTS_ROOT = resolve("prompts");
const DECLARED_SCOPE = Object.freeze(["README.md", "docs", "Dockerfile"]);
const GAP_REPORT = "# Onboarding gaps\n\n- Branch protection remains deferred for a repository administrator.";
const WORKFLOW_MARKDOWN = `# Workflow

The fast tier maps a changed source to its focused test, the area tier expands that mapping, and the full tier runs the repository command below.

\`\`\`json
${JSON.stringify({
  version: 1,
  compile: ["node --version"],
  rules: [
    { match: "README.md", action: { kind: "none" } },
    { match: "docs/**", action: { kind: "none" } },
    { match: "Dockerfile", action: { kind: "none" } },
    { match: "src/**", action: { kind: "self" } },
  ],
  full: ["node --version"],
}, null, 2)}
\`\`\`
`;

interface WorkflowSnapshot {
  readonly plans: readonly PlanRevision[];
  readonly nodes: readonly WorkNode[];
}

interface SettlementAttempt {
  readonly runId: string;
  readonly status: number;
  readonly outcome: string | null;
  readonly gapReport: string | null;
  readonly code: string | null;
  readonly message: string | null;
}

interface OnboardingFixture {
  readonly root: string;
  readonly repo: string;
  readonly dbPath: string;
  readonly origin: string;
  readonly service: TaskBoardService;
  readonly sweepBoard: TaskBoard;
  readonly project: Project;
  readonly workItem: WorkItem;
  readonly managerWorker: ManagedTaskWorker;
  readonly engineerWorker: ManagedTaskWorker;
  readonly verifierWorker: ManagedTaskWorker;
  readonly managerId: string;
  readonly engineerId: string;
  readonly verifierId: string;
  readonly engineerScratch: string;
  readonly settlementAttempts: SettlementAttempt[];
}

function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", [...arguments_], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(stderr));
      else resolvePromise(stdout);
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

function claudeManagerCliSource(): string {
  return `
if (process.argv.includes("--version")) {
  process.stdout.write("claude-fake 1.0\\n");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  fs.writeFileSync(path.join(process.env.TMPDIR, "prompt-1.txt"), input);
  const result = {
    status: "completed",
    progress: ["The onboarding plan covers every required deliverable."],
    result: "The repository onboarding plan is ready for confirmation.",
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    handoff: null,
    workflowPlan: {
      objective: "Onboard the external repository for autonomous work.",
      assumptions: ["The registered repository path is the intended target."],
      acceptanceCriteria: [
        "README.md, docs/architecture.md, docs/interface.md, docs/dependencies.md, and docs/workflow.md are present.",
        "A dated onboarding ADR, an agent Dockerfile target, and a branch-protection gap report are present.",
        "The repository full verification command passes."
      ],
      changeShape: "feature",
      tier: "standard",
      declaredScope: ${JSON.stringify(DECLARED_SCOPE)},
      nonGoals: ["Do not configure branch protection."],
      mechanicalPortions: ["Create missing onboarding documentation slots."],
      blockingQuestions: [],
      criterionChecks: [{
        criterion: "The repository full verification command passes.",
        check: "node --version"
      }],
      nodes: [{
        nodeId: "onboarding-deliverables",
        title: "Create onboarding deliverables",
        objective: "Create the documentation, verification contract, agent target, and gap report.",
        acceptanceCriteria: ["Every onboarding deliverable is present on the task branch."],
        dependencyNodeIds: [],
        stageTemplate: ["implementation", "testing", "verification"]
      }]
    },
    detail: "The repository onboarding plan is ready for confirmation."
  };
  process.stdout.write(JSON.stringify({type:"system",subtype:"init"}) + "\\n");
  process.stdout.write(JSON.stringify({
    type:"user",
    message:{content:[{type:"tool_result",content:"STEWARD_PHASE_JSON={\\\"key\\\":\\\"plan\\\",\\\"title\\\":\\\"Plan onboarding\\\",\\\"stage\\\":\\\"planning\\\",\\\"status\\\":\\\"completed\\\",\\\"parallelGroup\\\":null}"}]}
  }) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",structured_output:result}) + "\\n");
});
`;
}

function claudeOnboardingEngineerCliSource(): string {
  return `
if (process.argv.includes("--version")) {
  process.stdout.write("claude-fake 1.0\\n");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const child = require("node:child_process");
  const statePath = path.join(process.env.TMPDIR, "engineer-runs.txt");
  let previous = 0;
  try { previous = Number(fs.readFileSync(statePath, "utf8")); } catch {}
  const run = previous + 1;
  fs.writeFileSync(statePath, String(run));
  fs.writeFileSync(path.join(process.env.TMPDIR, "prompt-" + run + ".txt"), input);
  const write = (file, content) => {
    const absolute = path.join(process.cwd(), file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  };
  const runGit = (args) => {
    const executed = child.spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
    if (executed.status !== 0) throw new Error(executed.stderr || "git failed");
  };
  if (run === 1) {
    write("README.md", "# External fixture\\n\\nRepository onboarding documentation.\\n");
    write("docs/architecture.md", "# Architecture\\n\\nA single Node process owns the fixture behavior.\\n");
    write("docs/dependencies.md", "# Dependencies\\n\\nNode.js 24 is the only runtime dependency.\\n");
    write("docs/workflow.md", ${JSON.stringify(WORKFLOW_MARKDOWN)});
    write("docs/decisions/2026-08-25-onboarding.md", "# Onboard the repository\\n\\nStatus: accepted\\n\\nUse repository-local documentation and verification contracts.\\n");
    write("Dockerfile", "FROM node:24-bookworm-slim AS runtime\\nWORKDIR /app\\nCOPY . .\\n\\nFROM runtime AS agent\\nRUN corepack enable\\nCMD [\\\"node\\\", \\\"src/index.js\\\"]\\n");
    runGit(["add", "--", "README.md", "docs", "Dockerfile"]);
    runGit(["-c", "user.name=Onboarding Test", "-c", "user.email=onboarding@test.invalid", "commit", "-m", "add initial onboarding deliverables"]);
  } else {
    write("docs/interface.md", "# Interface\\n\\nThe fixture exposes no network routes or persisted schemas.\\n");
    runGit(["add", "--", "docs/interface.md"]);
    runGit(["-c", "user.name=Onboarding Test", "-c", "user.email=onboarding@test.invalid", "commit", "-m", "complete onboarding deliverables"]);
  }
  const result = {
    status: "completed",
    progress: [run === 1 ? "The first onboarding pass is ready." : "The corrected onboarding pass is ready."],
    result: run === 1 ? "The first onboarding pass is complete." : "The corrected onboarding pass is complete.",
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    handoff: {
      outcome: "passed",
      summary: run === 1 ? "Initial onboarding deliverables were committed." : "All onboarding deliverables were committed.",
      evidence: ["The task branch contains committed onboarding files."],
      artifactIds: [],
      acceptanceCriteria: [{
        criterion: "Every onboarding deliverable is present on the task branch.",
        passed: true,
        evidence: "The onboarding files were committed."
      }],
      blockers: [],
      recommendedReturnStage: null
    },
    workflowPlan: null,
    detail: run === 1 ? "The first onboarding pass is complete." : "The corrected onboarding pass is complete."
  };
  if (run > 1) result.gapReport = ${JSON.stringify(GAP_REPORT)};
  process.stdout.write(JSON.stringify({type:"system",subtype:"init"}) + "\\n");
  process.stdout.write(JSON.stringify({
    type:"user",
    message:{content:[{type:"tool_result",content:"STEWARD_PHASE_JSON={\\\"key\\\":\\\"write\\\",\\\"title\\\":\\\"Write onboarding files\\\",\\\"stage\\\":\\\"execution\\\",\\\"status\\\":\\\"completed\\\",\\\"parallelGroup\\\":null}"}]}
  }) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",structured_output:result}) + "\\n");
});
`;
}

function claudeVerifierCliSource(): string {
  return `
if (process.argv.includes("--version")) {
  process.stdout.write("claude-fake 1.0\\n");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  fs.writeFileSync(path.join(process.env.TMPDIR, "prompt-1.txt"), input);
  const result = {
    status: "completed",
    progress: ["Independent onboarding review passed."],
    result: "Independent onboarding review passed.",
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    handoff: {
      outcome: "passed",
      summary: "Independent onboarding review passed.",
      evidence: ["Machine verification is green."],
      artifactIds: [],
      acceptanceCriteria: [],
      blockers: [],
      recommendedReturnStage: null
    },
    workflowPlan: null,
    reviewFindings: [],
    detail: "Independent onboarding review passed."
  };
  process.stdout.write(JSON.stringify({type:"system",subtype:"init"}) + "\\n");
  process.stdout.write(JSON.stringify({
    type:"user",
    message:{content:[{type:"tool_result",content:"Independent review inspected the onboarding evidence."}]}
  }) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",structured_output:result}) + "\\n");
});
`;
}

async function fixtureRepository(root: string): Promise<string> {
  const repo = join(root, "external-repository");
  await git(root, ["init", "-b", "main", repo]);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "external-onboarding-fixture", private: true, type: "module" }, null, 2)}\n`);
  await writeFile(join(repo, "src", "index.js"), 'process.stdout.write("external fixture\\n");\n');
  await writeFile(
    join(repo, "Dockerfile"),
    'FROM node:24-bookworm-slim AS runtime\nWORKDIR /app\nCOPY . .\nCMD ["node", "src/index.js"]\n',
  );
  await git(repo, ["add", "."]);
  await git(repo, ["-c", "user.name=Onboarding Test", "-c", "user.email=onboarding@test.invalid", "commit", "-m", "fixture base"]);
  return repo;
}

function laneConfig(options: Readonly<{
  origin: string;
  workerId: string;
  agentId: string;
  token: string;
  role: "manager" | "engineer" | "verifier";
  model: string;
  workingDirectory: string;
  statePath: string;
  workspaceRoot?: string;
}>): TaskFleetAgentConfig {
  return parseTaskFleetConfig({
    version: 1,
    boardUrl: options.origin,
    agents: [{
      workerId: options.workerId,
      agentId: options.agentId,
      token: options.token,
      provider: "claude",
      role: options.role,
      model: options.model,
      workingDirectory: options.workingDirectory,
      statePath: options.statePath,
      longPollMs: 1_000,
      agentTimeoutMs: 5_000,
      terminationGraceMs: 10,
      ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    }],
  }).agents[0]!;
}

async function createFleetWorker(
  config: TaskFleetAgentConfig,
  origin: string,
  cli: FakeCliFixture,
): Promise<ManagedTaskWorker> {
  const priorPath = process.env.PATH;
  const priorTmpdir = process.env.TMPDIR;
  process.env.PATH = `${cli.bin}${delimiter}${priorPath ?? ""}`;
  process.env.TMPDIR = cli.scratch;
  try {
    return await createTaskFleetWorker(config, origin, {
      registry: runtimeRegistry([codexAdapter, claudeAdapter]),
      profiles: SHIPPED_RUNTIME_PROFILES,
      promptsRoot: PROMPTS_ROOT,
    });
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
  }
}

async function createFixture(): Promise<OnboardingFixture> {
  const root = await mkdtemp(join(tmpdir(), "steward-onboarding-e2e-"));
  const repo = await fixtureRepository(root);
  const dbPath = join(root, "board", "task-board.sqlite");
  const boardOptions = {
    dbPath,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:onboarding-reviewer",
    port: 0,
    reconcileIntervalSeconds: 0,
    verifyWorkspaceRoot: join(root, "verify-workspaces"),
  } as const;
  const service = await createTaskBoardService(boardOptions);
  const address = await service.start();
  const sweepBoard = await TaskBoard.open(normalizeTaskBoardConfig(boardOptions));
  const workers: ManagedTaskWorker[] = [];
  try {
    const { project } = await jsonRequest<{ project: Project }>(address.url, "/v1/projects", "POST", 201, {
      body: { name: "External onboarding fixture", description: repo },
    });
    const managerId = "onboarding-claude-manager";
    const engineerId = "onboarding-claude-engineer";
    const verifierId = "onboarding-claude-verifier";
    for (const agent of [
      { agentId: managerId, role: "manager", area: "onboarding planning", mission: "Plan repository onboarding.", model: "claude-manager", token: MANAGER_TOKEN },
      { agentId: engineerId, role: "engineer", area: "onboarding implementation", mission: "Create repository onboarding deliverables.", model: "claude-engineer", token: ENGINEER_TOKEN },
      { agentId: verifierId, role: "verifier", area: "onboarding verification", mission: "Review onboarding evidence independently.", model: "claude-verifier", token: VERIFIER_TOKEN },
    ] as const) {
      await jsonRequest(address.url, `/v1/projects/${project.projectId}/agents`, "POST", 201, { body: agent });
    }

    const implementationType = {
      agentTypeId: "onboarding-e2e-engineer-type",
      name: "Onboarding engineer",
      description: "Creates the confirmed onboarding deliverables.",
      role: "engineer" as const,
      supplementalInstructions: "Commit every onboarding deliverable to the task branch.",
      skillIds: [],
      evaluatorProfile: "tests" as const,
      enabled: true,
    };
    const verificationType = {
      ...implementationType,
      agentTypeId: "onboarding-e2e-verifier-type",
      name: "Onboarding verifier",
      description: "Independently reviews the onboarding deliverables.",
      role: "verifier" as const,
    };
    await jsonRequest(address.url, "/v1/automation-configuration", "PATCH", 200, {
      body: automationConfigurationRequest({
        agentTypes: [implementationType, verificationType],
        stages: automationStages({
          implementation: { kind: "agent_type", agentTypeId: implementationType.agentTypeId },
          testing: { kind: "machine_verify" },
          verification: { kind: "agent_type", agentTypeId: verificationType.agentTypeId },
        }),
      }),
    });

    const managerCli = await fakeCli(join(root, "manager-cli"), "claude", claudeManagerCliSource());
    const engineerCli = await fakeCli(join(root, "engineer-cli"), "claude", claudeOnboardingEngineerCliSource());
    const verifierCli = await fakeCli(join(root, "verifier-cli"), "claude", claudeVerifierCliSource());
    const settlementAttempts: SettlementAttempt[] = [];
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const settlementMatch = /\/v1\/runs\/([^/]+)\/settle$/u.exec(String(input));
      const settlementRequest = settlementMatch === null || init?.body === undefined
        ? null
        : JSON.parse(String(init.body)) as Record<string, unknown>;
      const response = await nativeFetch(input, init);
      if (settlementMatch !== null) {
        const payload = await response.clone().json() as { error?: { code?: unknown; message?: unknown } };
        settlementAttempts.push({
          runId: settlementMatch[1]!,
          status: response.status,
          outcome: typeof settlementRequest?.outcome === "string" ? settlementRequest.outcome : null,
          gapReport: typeof settlementRequest?.gapReport === "string" ? settlementRequest.gapReport : null,
          code: typeof payload.error?.code === "string" ? payload.error.code : null,
          message: typeof payload.error?.message === "string" ? payload.error.message : null,
        });
      }
      return response;
    }) as typeof fetch;
    try {
      workers.push(await createFleetWorker(laneConfig({
        origin: address.url,
        workerId: "onboarding-manager-worker",
        agentId: managerId,
        token: MANAGER_TOKEN,
        role: "manager",
        model: "claude-manager",
        workingDirectory: managerCli.working,
        statePath: join(root, "manager-worker", "journal.json"),
      }), address.url, managerCli));
      workers.push(await createFleetWorker(laneConfig({
        origin: address.url,
        workerId: "onboarding-engineer-worker",
        agentId: engineerId,
        token: ENGINEER_TOKEN,
        role: "engineer",
        model: "claude-engineer",
        workingDirectory: repo,
        workspaceRoot: join(root, "implementation-workspaces"),
        statePath: join(root, "engineer-worker", "journal.json"),
      }), address.url, engineerCli));
      workers.push(await createFleetWorker(laneConfig({
        origin: address.url,
        workerId: "onboarding-verifier-worker",
        agentId: verifierId,
        token: VERIFIER_TOKEN,
        role: "verifier",
        model: "claude-verifier",
        workingDirectory: verifierCli.working,
        statePath: join(root, "verifier-worker", "journal.json"),
      }), address.url, verifierCli));
    } finally {
      globalThis.fetch = nativeFetch;
    }

    const { workItem } = await jsonRequest<{ workItem: WorkItem }>(address.url, "/v1/work-items", "POST", 201, {
      idempotencyKey: "onboarding-e2e-work-item",
      body: {
        taskType: "onboarding",
        originalRequest: "Onboard the external repository for autonomous agent work.",
        priority: "normal",
        projectTarget: { mode: "explicit", projectId: project.projectId },
      },
    });
    assert.equal(workItem.taskType, "onboarding");
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
      managerWorker: workers[0]!,
      engineerWorker: workers[1]!,
      verifierWorker: workers[2]!,
      managerId,
      engineerId,
      verifierId,
      engineerScratch: engineerCli.scratch,
      settlementAttempts,
    };
  } catch (error) {
    await Promise.allSettled(workers.map((worker) => worker.close()));
    sweepBoard.close();
    await service.close();
    throw error;
  }
}

async function closeFixture(fixture: OnboardingFixture): Promise<void> {
  await Promise.allSettled([
    fixture.managerWorker.close(),
    fixture.engineerWorker.close(),
    fixture.verifierWorker.close(),
  ]);
  fixture.sweepBoard.close();
  await fixture.service.close();
}

async function currentWorkItem(fixture: OnboardingFixture): Promise<WorkItem> {
  return (await jsonRequest<{ workItem: WorkItem }>(
    fixture.origin,
    `/v1/work-items/${fixture.workItem.workItemId}`,
    "GET",
    200,
  )).workItem;
}

async function workflow(fixture: OnboardingFixture): Promise<WorkflowSnapshot> {
  return (await jsonRequest<{ workflow: WorkflowSnapshot }>(
    fixture.origin,
    `/v1/projects/${fixture.project.projectId}/workflow`,
    "GET",
    200,
  )).workflow;
}

async function driveVerify(fixture: OnboardingFixture): Promise<void> {
  const launchDeadline = Date.now() + 5_000;
  let verifyState = "";
  while (Date.now() < launchDeadline) {
    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      verifyState = String(db.prepare("SELECT state FROM verify_attempts ORDER BY created_at DESC LIMIT 1").get()?.state ?? "");
    } finally {
      db.close();
    }
    if (verifyState !== "" && verifyState !== "starting") break;
    await delay(25);
  }
  assert.notEqual(verifyState, "", "machine verify did not create an attempt");
  assert.notEqual(verifyState, "starting", "machine verify did not finish its service-owned launch");

  const settleDeadline = Date.now() + 10_000;
  while (Date.now() < settleDeadline) {
    await fixture.sweepBoard.sweepVerifyAttempts();
    const item = fixture.sweepBoard.requireWorkItem(fixture.workItem.workItemId);
    if (item.state === "reviewing") return;
    await delay(25);
  }
  assert.fail(`machine verify did not reach review; current=${fixture.sweepBoard.requireWorkItem(fixture.workItem.workItemId).state}`);
}

test("the Claude e2e shims use parser-accepted stream-json shapes", () => {
  for (const source of [
    claudeManagerCliSource(),
    claudeOnboardingEngineerCliSource(),
    claudeVerifierCliSource(),
  ]) {
    assert.doesNotThrow(() => new Function(source));
  }
  assert.deepEqual(
    claudeAdapter.events('{"type":"system","subtype":"init"}'),
    [{ type: "stage_started" }],
  );
  assert.deepEqual(
    claudeAdapter.events('{"type":"user","message":{"content":[{"type":"tool_result","content":"progress"}]}}'),
    [{ type: "tool_result", name: "tool", output: "progress", failed: false }],
  );
  assert.deepEqual(
    claudeAdapter.result('{"type":"result","structured_output":{"status":"completed"}}\n'),
    { status: "completed" },
  );
  assert.equal(structuredOutcome({
    status: "completed",
    progress: [],
    result: "The corrected onboarding pass is complete.",
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    handoff: null,
    workflowPlan: null,
    gapReport: GAP_REPORT,
    detail: "The corrected onboarding pass is complete.",
  }).gapReport, GAP_REPORT);
});

test("onboarding completes on claude lanes after a correctable deliverables rejection", async () => {
  const fixture = await createFixture();
  try {
    assert.equal(await fixture.managerWorker.run(new AbortController().signal), true);
    assert.equal((await currentWorkItem(fixture)).state, "plan_approval");
    const planningWorkflow = await workflow(fixture);
    const plan = planningWorkflow.plans.find((candidate) => candidate.state === "proposed");
    assert.ok(plan);
    assert.deepEqual(plan.declaredScope, DECLARED_SCOPE);
    assert.deepEqual(
      planningWorkflow.nodes.find((node) => node.planRevisionId === plan.planRevisionId)?.stageTemplate,
      ["implementation", "testing", "verification"],
    );

    await jsonRequest<ConfirmPlanRevisionResponse>(
      fixture.origin,
      `/v1/plans/${plan.planRevisionId}/confirm`,
      "POST",
      200,
      { body: { expectedState: "proposed" } },
    );
    const confirmed = await currentWorkItem(fixture);
    assert.equal(confirmed.state, "implementing");
    assert.equal(confirmed.pipelineBranch, `task/${fixture.workItem.workItemId}`);

    assert.equal(await fixture.engineerWorker.run(new AbortController().signal), true);
    assert.equal(
      await readFile(join(fixture.engineerScratch, "engineer-runs.txt"), "utf8"),
      "1",
      "the first engineer dispatch did not take the incomplete-deliverables branch",
    );
    assert.equal(fixture.engineerWorker.hasActiveClaim(), true);
    assert.equal((await currentWorkItem(fixture)).state, "implementing");
    await assert.rejects(git(fixture.repo, ["show", `${confirmed.pipelineBranch}:docs/interface.md`]));

    const firstClaim = new DatabaseSync(fixture.dbPath, { readOnly: true });
    let implementationIdentity: { run_id: string; claim_id: string };
    try {
      const rows = firstClaim.prepare(
        "SELECT run_id,claim_id,status FROM runs WHERE agent_id=? ORDER BY started_at,run_id",
      ).all(fixture.engineerId) as unknown as ReadonlyArray<{ run_id: string; claim_id: string; status: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, "active");
      implementationIdentity = { run_id: rows[0]!.run_id, claim_id: rows[0]!.claim_id };
      assert.deepEqual(fixture.settlementAttempts.filter((attempt) => attempt.runId === implementationIdentity.run_id), [{
        runId: implementationIdentity.run_id,
        status: 400,
        outcome: "completed",
        gapReport: null,
        code: "ONBOARDING_DELIVERABLES_MISSING",
        message: "Onboarding deliverables are missing: gap report is missing or empty; docs/interface.md is missing or empty",
      }], "the first implementation settlement was not rejected for exactly the correctable omissions");
      assert.equal(firstClaim.prepare("SELECT COUNT(*) AS count FROM artifacts").get()?.count, 0);
    } finally {
      firstClaim.close();
    }

    assert.equal(await fixture.engineerWorker.run(new AbortController().signal), true);
    assert.equal(
      await readFile(join(fixture.engineerScratch, "engineer-runs.txt"), "utf8"),
      "2",
      "the claim-reset dispatch did not relaunch the engineer shim for its corrected turn",
    );
    assert.match(
      await git(fixture.repo, ["show", `${confirmed.pipelineBranch}:docs/interface.md`]),
      /^# Interface$/mu,
      "the corrected engineer commit was not harvested onto the pipeline branch",
    );
    const correctedClaim = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const rows = correctedClaim.prepare(
        "SELECT run_id,claim_id,status FROM runs WHERE agent_id=? ORDER BY started_at,run_id",
      ).all(fixture.engineerId) as unknown as ReadonlyArray<{ run_id: string; claim_id: string; status: string }>;
      assert.deepEqual(
        rows.map((row) => ({ ...row })),
        [{ ...implementationIdentity, status: "completed" }],
        `the corrected same-claim settlement did not complete: ${JSON.stringify(rows)}`,
      );
      assert.deepEqual(
        fixture.settlementAttempts.filter((attempt) => attempt.runId === implementationIdentity.run_id),
        [
          {
            runId: implementationIdentity.run_id,
            status: 400,
            outcome: "completed",
            gapReport: null,
            code: "ONBOARDING_DELIVERABLES_MISSING",
            message: "Onboarding deliverables are missing: gap report is missing or empty; docs/interface.md is missing or empty",
          },
          {
            runId: implementationIdentity.run_id,
            status: 200,
            outcome: "completed",
            gapReport: GAP_REPORT,
            code: null,
            message: null,
          },
        ],
        "the corrected turn did not submit and receive the successful second settlement",
      );
      const verifyAttempt = correctedClaim.prepare(
        "SELECT state FROM verify_attempts ORDER BY created_at DESC,verify_attempt_id DESC LIMIT 1",
      ).get() as { state?: unknown } | undefined;
      assert.ok(
        verifyAttempt !== undefined,
        "the successful implementation settlement did not activate the testing-stage machine verify",
      );
    } finally {
      correctedClaim.close();
    }
    assert.equal(fixture.engineerWorker.hasActiveClaim(), false, "the completed corrected claim remained active");
    assert.equal(
      (await currentWorkItem(fixture)).state,
      "verifying",
      "the successful corrected settlement and testing activation did not advance the work item",
    );

    const branchWorkflow = await git(fixture.repo, ["show", `${confirmed.pipelineBranch}:docs/workflow.md`]);
    assert.deepEqual(parseVerifyContract(branchWorkflow).full, ["node --version"]);
    await driveVerify(fixture);
    const verifyDb = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const attempt = verifyDb.prepare(
        "SELECT state,detail FROM verify_attempts ORDER BY created_at DESC,verify_attempt_id DESC LIMIT 1",
      ).get() as { state?: unknown; detail?: unknown } | undefined;
      assert.equal(attempt?.state, "green");
      assert.match(String(attempt?.detail), /^verified-sha:[0-9a-f]{40}$/u);
    } finally {
      verifyDb.close();
    }

    assert.equal(await fixture.verifierWorker.run(new AbortController().signal), true);
    const finalApproval = await currentWorkItem(fixture);
    assert.equal(finalApproval.state, "final_approval");
    const approved = await jsonRequest<{ workItem: WorkItem }>(
      fixture.origin,
      `/v1/work-items/${fixture.workItem.workItemId}/approve-merge`,
      "POST",
      200,
      { body: { version: finalApproval.version } },
    );
    assert.equal(approved.workItem.state, "merged");

    for (const path of [
      "README.md",
      "docs/architecture.md",
      "docs/interface.md",
      "docs/dependencies.md",
      "docs/workflow.md",
      "docs/decisions/2026-08-25-onboarding.md",
    ]) {
      assert.notEqual((await readFile(join(fixture.repo, path), "utf8")).trim(), "", `${path} is empty`);
    }
    assert.match(await readFile(join(fixture.repo, "Dockerfile"), "utf8"), /^FROM runtime AS agent$/mu);
    const mergedWorkflow = await readFile(join(fixture.repo, "docs", "workflow.md"), "utf8");
    const contract = parseVerifyContract(mergedWorkflow);
    const selection = mapChangedFiles(
      ["README.md", "docs/architecture.md", "docs/interface.md", "docs/dependencies.md", "docs/workflow.md", "docs/decisions/2026-08-25-onboarding.md", "Dockerfile"],
      contract.rules,
      "fast",
      { fileExists: () => false, directoryExists: () => false },
    );
    assert.deepEqual(selection, {
      nodeTestFiles: [],
      nodeTestDirs: [],
      vitestTargets: [],
      escalations: [],
      unmatched: [],
    });

    const detail = await currentWorkItem(fixture) as WorkItem & { readonly gapReportArtifactId: string | null };
    assert.match(detail.gapReportArtifactId ?? "", /^artifact_/u);
    const gapArtifact = await fixture.sweepBoard.artifactContent(detail.gapReportArtifactId!);
    assert.equal(gapArtifact.artifact.mediaType, "text/markdown");
    assert.match(gapArtifact.bytes.toString("utf8"), /branch protection/iu);

    const runsDb = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const runs = runsDb.prepare(
        "SELECT agent_id,runtime,prompts_sha,status FROM runs ORDER BY started_at,run_id",
      ).all() as unknown as ReadonlyArray<{ agent_id: string; runtime: string | null; prompts_sha: string | null; status: string }>;
      assert.equal(runs.length, 3);
      assert.deepEqual(new Set(runs.map((run) => run.agent_id)), new Set([
        fixture.managerId,
        fixture.engineerId,
        fixture.verifierId,
      ]));
      assert.ok(runs.every((run) => run.runtime === "claude"));
      assert.ok(runs.every((run) => typeof run.prompts_sha === "string" && run.prompts_sha.length > 0));
      assert.ok(runs.every((run) => run.status === "completed"));
    } finally {
      runsDb.close();
    }
  } finally {
    await closeFixture(fixture);
  }
});
