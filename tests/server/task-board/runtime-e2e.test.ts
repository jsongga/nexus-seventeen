import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { RuntimeAdapter } from "../../../src/server/agents/runtime/adapter.js";
import { claudeAdapter } from "../../../src/server/agents/runtime/claude.js";
import { codexAdapter } from "../../../src/server/agents/runtime/codex.js";
import type { RuntimeEvent } from "../../../src/server/agents/runtime/adapter.js";
import {
  RuntimeCapabilityError,
  type RuntimeProfile,
  type RuntimeProfiles,
} from "../../../src/server/agents/runtime/profiles.js";
import { runtimeRegistry } from "../../../src/server/agents/runtime/registry.js";
import { parseTaskFleetConfig } from "#server/agents/task-fleet/config";
import {
  createTaskFleetWorker,
  type ManagedTaskWorker,
  type TaskFleetAgentConfig,
} from "#server/agents/task-fleet";
import {
  type AgentRole,
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

const HUMAN_TOKEN = "runtime-e2e-human-token-0123456789abcdef";
const MANAGER_TOKEN = "runtime-e2e-manager-token-0123456789abcdef";
const ENGINEER_TOKEN = "runtime-e2e-engineer-token-0123456789abcdef";
const VERIFIER_TOKEN = "runtime-e2e-verifier-token-0123456789abcdef";
const PROMPTS_ROOT = resolve("prompts");
const DECLARED_SCOPE = Object.freeze(["src/acme"]);
const CHECKED_CRITERION = "The synthetic runtime fixture command passes.";

const ACME_PROFILE: RuntimeProfile = Object.freeze({
  runtime: "acme",
  binary: "acme",
  permissionModel: "acme-role-modes",
  roles: Object.freeze({
    manager: Object.freeze({ sandbox: "observe" }),
    engineer: Object.freeze({ sandbox: "change" }),
    verifier: Object.freeze({ sandbox: "observe" }),
  }),
  mcp: false,
  toolCallGranularity: "operation",
  contextNotes: "Test-only EVT/RESULT line protocol.",
});

const ACME_PROFILES: RuntimeProfiles = Object.freeze({
  version: 1,
  runtimes: new Map([...SHIPPED_RUNTIME_PROFILES.runtimes, ["acme", ACME_PROFILE]]),
});

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function acmeSandbox(profile: RuntimeProfile, role: AgentRole): string {
  if (profile.runtime !== "acme") {
    throw new RuntimeCapabilityError("acme", role, `profile ${profile.runtime} does not match the adapter`);
  }
  const expected = role === "engineer" ? "change" : "observe";
  const sandbox = profile.roles[role]?.sandbox;
  if (sandbox !== expected) {
    throw new RuntimeCapabilityError(
      profile.runtime,
      role,
      sandbox === undefined ? "the role is missing from its capability profile" : `unknown sandbox ${sandbox}`,
    );
  }
  return sandbox;
}

function acmeEvents(line: string): readonly RuntimeEvent[] {
  if (!line.startsWith("EVT ")) return Object.freeze([]);
  let event: JsonObject | null = null;
  try {
    event = object(JSON.parse(line.slice(4)) as unknown);
  } catch {
    return Object.freeze([]);
  }
  switch (event?.kind) {
    case "begin":
      return Object.freeze([{ type: "stage_started" }]);
    case "say":
      return typeof event.text === "string"
        ? Object.freeze([{ type: "message_delta", text: event.text }])
        : Object.freeze([]);
    case "call":
      return typeof event.cmd === "string"
        ? Object.freeze([{
            type: "tool_call",
            name: event.cmd,
            detail: typeof event.detail === "string" ? event.detail : "",
          }])
        : Object.freeze([]);
    case "done":
      return Object.freeze([{ type: "stage_finished" }]);
    default:
      return Object.freeze([]);
  }
}

function acmeResult(stdout: string): unknown {
  let result: unknown;
  let found = false;
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.startsWith("RESULT ")) continue;
    result = JSON.parse(line.slice("RESULT ".length)) as unknown;
    found = true;
  }
  if (!found) throw new Error("Acme ended without a terminal RESULT line");
  return result;
}

const acmeAdapter: RuntimeAdapter = Object.freeze({
  runtime: "acme",
  assertRole(profile: RuntimeProfile, role: AgentRole): void {
    acmeSandbox(profile, role);
  },
  args(
    _options: Parameters<RuntimeAdapter["args"]>[0],
    role: AgentRole,
    profile: RuntimeProfile,
  ): readonly string[] {
    return Object.freeze(["run", `--role=${role}`, `--mode=${acmeSandbox(profile, role)}`]);
  },
  environment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG"] as const) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) environment[key] = value;
    }
    return environment;
  },
  events: acmeEvents,
  result: acmeResult,
});

interface WorkflowSnapshot {
  readonly plans: readonly PlanRevision[];
  readonly nodes: readonly WorkNode[];
}

interface RuntimeFixture {
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

function acmeManagerCliSource(): string {
  return `
if (process.argv.includes("--version")) {
  process.stdout.write("acme-cli 1.0\\n");
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
    progress: ["The Acme plan is ready for confirmation."],
    result: "The Acme runtime fixture plan is ready.",
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    handoff: null,
    workflowPlan: {
      objective: "Deliver the synthetic runtime fixture change.",
      assumptions: ["The fixture repository remains available."],
      acceptanceCriteria: [${JSON.stringify(CHECKED_CRITERION)}, "The task branch contains the Acme marker."],
      changeShape: "feature",
      tier: "standard",
      declaredScope: ${JSON.stringify(DECLARED_SCOPE)},
      nonGoals: ["Do not change files outside src/acme."],
      mechanicalPortions: ["Add one deterministic marker file."],
      blockingQuestions: [],
      criterionChecks: [{criterion:${JSON.stringify(CHECKED_CRITERION)},check:"node --version"}],
      nodes: [{
        nodeId: "acme-runtime-change",
        title: "Implement the Acme runtime fixture",
        objective: "Commit the scoped Acme marker and pass verification.",
        acceptanceCriteria: ["The task branch contains the Acme marker."],
        dependencyNodeIds: [],
        stageTemplate: ["implementation", "testing", "verification"]
      }]
    },
    detail: "The Acme runtime fixture plan is ready."
  };
  process.stdout.write("EVT " + JSON.stringify({kind:"begin"}) + "\\n");
  process.stdout.write("EVT " + JSON.stringify({kind:"say",text:"Planning through the Acme protocol."}) + "\\n");
  process.stdout.write("EVT " + JSON.stringify({kind:"call",cmd:"plan",detail:"single-node"}) + "\\n");
  process.stdout.write("EVT " + JSON.stringify({kind:"done"}) + "\\n");
  process.stdout.write("RESULT " + JSON.stringify(result) + "\\n");
});
`;
}

function acmeEngineerCliSource(): string {
  return `
if (process.argv.includes("--version")) {
  process.stdout.write("acme-cli 1.0\\n");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const child = require("node:child_process");
  const sleep = require("node:timers/promises").setTimeout;
  fs.writeFileSync(path.join(process.env.TMPDIR, "prompt-1.txt"), input);
  fs.mkdirSync(path.join(process.cwd(), "src", "acme"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "src", "acme", "result.txt"), "implemented through acme\\n");
  const runGit = (args) => {
    const executed = child.spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
    if (executed.status !== 0) throw new Error(executed.stderr || "git failed");
  };
  runGit(["add", "--", "src/acme/result.txt"]);
  runGit(["-c", "user.name=Acme Test", "-c", "user.email=acme@test.invalid", "commit", "-m", "add acme runtime marker"]);
  const result = {
    status: "completed",
    progress: ["The Acme implementation is committed."],
    result: "The Acme runtime fixture implementation is complete.",
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    handoff: {
      outcome: "passed",
      summary: "The Acme marker is committed.",
      evidence: ["src/acme/result.txt exists on the task branch."],
      artifactIds: [],
      acceptanceCriteria: [{
        criterion: "The task branch contains the Acme marker.",
        passed: true,
        evidence: "The marker file is committed."
      }],
      blockers: [],
      recommendedReturnStage: null
    },
    workflowPlan: null,
    detail: "The Acme runtime fixture implementation is complete."
  };
  process.stdout.write("EVT " + JSON.stringify({kind:"begin"}) + "\\n");
  await sleep(2_500);
  process.stdout.write("EVT " + JSON.stringify({kind:"say",text:"Implementing through the Acme protocol."}) + "\\n");
  process.stdout.write("EVT " + JSON.stringify({kind:"call",cmd:"file_change",detail:"src/acme/result.txt"}) + "\\n");
  process.stdout.write("EVT " + JSON.stringify({kind:"done"}) + "\\n");
  process.stdout.write("RESULT " + JSON.stringify(result) + "\\n");
});
`;
}

function acmeVerifierCliSource(): string {
  return `
if (process.argv.includes("--version")) {
  process.stdout.write("acme-cli 1.0\\n");
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
    progress: ["Independent Acme verification passed."],
    result: "Independent Acme verification passed.",
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    handoff: {
      outcome: "passed",
      summary: "Independent Acme verification passed.",
      evidence: ["Machine verification is green."],
      artifactIds: [],
      acceptanceCriteria: [],
      blockers: [],
      recommendedReturnStage: null
    },
    workflowPlan: null,
    reviewFindings: [],
    detail: "Independent Acme verification passed."
  };
  process.stdout.write("EVT " + JSON.stringify({kind:"begin"}) + "\\n");
  process.stdout.write("EVT " + JSON.stringify({kind:"say",text:"Reviewing through the Acme protocol."}) + "\\n");
  process.stdout.write("EVT " + JSON.stringify({kind:"call",cmd:"command",detail:"review"}) + "\\n");
  process.stdout.write("EVT " + JSON.stringify({kind:"done"}) + "\\n");
  process.stdout.write("RESULT " + JSON.stringify(result) + "\\n");
});
`;
}

async function fixtureRepository(root: string): Promise<string> {
  const repo = join(root, "repository");
  await git(root, ["init", "-b", "main", repo]);
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "acme-runtime-fixture", private: true, type: "module" }, null, 2)}\n`);
  await writeFile(join(repo, "src", "index.js"), 'process.stdout.write("runtime fixture\\n");\n');
  await writeFile(
    join(repo, "docs", "workflow.md"),
    `# Workflow\n\n\`\`\`json\n${JSON.stringify({
      version: 1,
      compile: ["node --version"],
      rules: [{ match: "src/**", action: { kind: "none" } }],
      full: ["node --version"],
    }, null, 2)}\n\`\`\`\n`,
  );
  await git(repo, ["add", "."]);
  await git(repo, ["-c", "user.name=Acme Test", "-c", "user.email=acme@test.invalid", "commit", "-m", "fixture base"]);
  return repo;
}

function laneConfig(options: Readonly<{
  origin: string;
  workerId: string;
  agentId: string;
  token: string;
  role: AgentRole;
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
      provider: "acme",
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
      registry: runtimeRegistry([codexAdapter, claudeAdapter, acmeAdapter]),
      profiles: ACME_PROFILES,
      promptsRoot: PROMPTS_ROOT,
    });
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
  }
}

async function createFixture(): Promise<RuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), "steward-runtime-e2e-"));
  const repo = await fixtureRepository(root);
  const dbPath = join(root, "board", "task-board.sqlite");
  const boardOptions = {
    dbPath,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:runtime-reviewer",
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
      body: { name: "Synthetic runtime fixture", description: repo },
    });
    const managerId = "runtime-acme-manager";
    const engineerId = "runtime-acme-engineer";
    const verifierId = "runtime-acme-verifier";
    for (const agent of [
      { agentId: managerId, role: "manager", area: "runtime planning", mission: "Plan the synthetic runtime change.", model: "acme-manager", token: MANAGER_TOKEN },
      { agentId: engineerId, role: "engineer", area: "runtime implementation", mission: "Implement the synthetic runtime change.", model: "acme-engineer", token: ENGINEER_TOKEN },
      { agentId: verifierId, role: "verifier", area: "runtime verification", mission: "Review the synthetic runtime change.", model: "acme-verifier", token: VERIFIER_TOKEN },
    ] as const) {
      await jsonRequest(address.url, `/v1/projects/${project.projectId}/agents`, "POST", 201, { body: agent });
    }

    const implementationType = {
      agentTypeId: "runtime-e2e-engineer-type",
      name: "Runtime engineer",
      description: "Implements the synthetic runtime fixture.",
      role: "engineer" as const,
      supplementalInstructions: "Commit only the confirmed scope.",
      skillIds: [],
      evaluatorProfile: "tests" as const,
      enabled: true,
    };
    const verificationType = {
      ...implementationType,
      agentTypeId: "runtime-e2e-verifier-type",
      name: "Runtime verifier",
      description: "Reviews the synthetic runtime fixture.",
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

    const managerCli = await fakeCli(join(root, "manager-cli"), "acme", acmeManagerCliSource());
    const engineerCli = await fakeCli(join(root, "engineer-cli"), "acme", acmeEngineerCliSource());
    const verifierCli = await fakeCli(join(root, "verifier-cli"), "acme", acmeVerifierCliSource());
    workers.push(await createFleetWorker(laneConfig({
      origin: address.url,
      workerId: "runtime-manager-worker",
      agentId: managerId,
      token: MANAGER_TOKEN,
      role: "manager",
      model: "acme-manager",
      workingDirectory: managerCli.working,
      statePath: join(root, "manager-worker", "journal.json"),
    }), address.url, managerCli));
    workers.push(await createFleetWorker(laneConfig({
      origin: address.url,
      workerId: "runtime-engineer-worker",
      agentId: engineerId,
      token: ENGINEER_TOKEN,
      role: "engineer",
      model: "acme-engineer",
      workingDirectory: repo,
      workspaceRoot: join(root, "implementation-workspaces"),
      statePath: join(root, "engineer-worker", "journal.json"),
    }), address.url, engineerCli));
    workers.push(await createFleetWorker(laneConfig({
      origin: address.url,
      workerId: "runtime-verifier-worker",
      agentId: verifierId,
      token: VERIFIER_TOKEN,
      role: "verifier",
      model: "acme-verifier",
      workingDirectory: verifierCli.working,
      statePath: join(root, "verifier-worker", "journal.json"),
    }), address.url, verifierCli));

    const { workItem } = await jsonRequest<{ workItem: WorkItem }>(address.url, "/v1/work-items", "POST", 201, {
      idempotencyKey: "runtime-e2e-work-item",
      body: {
        originalRequest: "Deliver the standard work item through the Acme runtime.",
        priority: "normal",
        projectTarget: { mode: "explicit", projectId: project.projectId },
      },
    });
    assert.equal(workItem.taskType, "standard");
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
    };
  } catch (error) {
    await Promise.allSettled(workers.map((worker) => worker.close()));
    sweepBoard.close();
    await service.close();
    throw error;
  }
}

async function closeFixture(fixture: RuntimeFixture): Promise<void> {
  await Promise.allSettled([
    fixture.managerWorker.close(),
    fixture.engineerWorker.close(),
    fixture.verifierWorker.close(),
  ]);
  fixture.sweepBoard.close();
  await fixture.service.close();
}

async function currentWorkItem(fixture: RuntimeFixture): Promise<WorkItem> {
  return (await jsonRequest<{ workItem: WorkItem }>(
    fixture.origin,
    `/v1/work-items/${fixture.workItem.workItemId}`,
    "GET",
    200,
  )).workItem;
}

async function workflow(fixture: RuntimeFixture): Promise<WorkflowSnapshot> {
  return (await jsonRequest<{ workflow: WorkflowSnapshot }>(
    fixture.origin,
    `/v1/projects/${fixture.project.projectId}/workflow`,
    "GET",
    200,
  )).workflow;
}

async function driveVerify(fixture: RuntimeFixture): Promise<void> {
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

test("the test-local Acme adapter maps its distinct line protocol", () => {
  for (const source of [acmeManagerCliSource(), acmeEngineerCliSource(), acmeVerifierCliSource()]) {
    assert.doesNotThrow(() => new Function(source));
  }
  assert.doesNotThrow(() => acmeAdapter.assertRole(ACME_PROFILE, "engineer"));
  assert.deepEqual(acmeAdapter.events('EVT {"kind":"begin"}'), [{ type: "stage_started" }]);
  assert.deepEqual(
    acmeAdapter.events('EVT {"kind":"say","text":"hello"}'),
    [{ type: "message_delta", text: "hello" }],
  );
  assert.deepEqual(
    acmeAdapter.events('EVT {"kind":"call","cmd":"file_change","detail":"src/acme/result.txt"}'),
    [{ type: "tool_call", name: "file_change", detail: "src/acme/result.txt" }],
  );
  assert.deepEqual(acmeAdapter.events('EVT {"kind":"done"}'), [{ type: "stage_finished" }]);
  assert.deepEqual(acmeAdapter.result('RESULT {"status":"completed"}\n'), { status: "completed" });
});

test("a test-local third runtime drives a standard work item through merge", async () => {
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
    assert.equal((await currentWorkItem(fixture)).state, "implementing");

    assert.equal(await fixture.engineerWorker.run(new AbortController().signal), true);
    assert.equal((await currentWorkItem(fixture)).state, "verifying");
    await driveVerify(fixture);

    const verifyDb = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.equal(
        verifyDb.prepare("SELECT state FROM verify_attempts ORDER BY created_at DESC LIMIT 1").get()?.state,
        "green",
      );
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
    assert.equal(await readFile(join(fixture.repo, "src", "acme", "result.txt"), "utf8"), "implemented through acme\n");

    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const runs = db.prepare(
        "SELECT agent_id,runtime,prompts_sha,status FROM runs ORDER BY started_at,run_id",
      ).all() as unknown as ReadonlyArray<{ agent_id: string; runtime: string | null; prompts_sha: string | null; status: string }>;
      assert.equal(runs.length, 3);
      assert.deepEqual(new Set(runs.map((run) => run.agent_id)), new Set([
        fixture.managerId,
        fixture.engineerId,
        fixture.verifierId,
      ]));
      assert.ok(runs.every((run) => run.runtime === "acme"));
      assert.ok(runs.every((run) => typeof run.prompts_sha === "string" && run.prompts_sha.length > 0));
      assert.ok(runs.every((run) => run.status === "completed"));

      const acmeActivity = db.prepare(`
        SELECT message.body
        FROM task_messages message
        JOIN runs run ON run.run_id=message.run_id
        WHERE run.runtime='acme' AND message.kind='progress'
        ORDER BY message.sequence
      `).all() as unknown as ReadonlyArray<{ body: string }>;
      assert.ok(acmeActivity.length > 0);
      assert.ok(
        acmeActivity.some((message) => message.body === "Updating the implementation."),
        `Acme file-change activity was not persisted: ${JSON.stringify(acmeActivity)}`,
      );
    } finally {
      db.close();
    }
  } finally {
    await closeFixture(fixture);
  }
});
