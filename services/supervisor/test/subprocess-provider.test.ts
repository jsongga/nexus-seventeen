import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { authorizeProviderPhase } from "../src/provider-policy.js";
import { SubprocessProviderAdapter, providerChildEnvironment } from "../src/subprocess-provider.js";
import { taskFixture } from "./helpers.js";

const temporaryDirectories: string[] = [];

async function sha256(pathname: string): Promise<string> {
  return createHash("sha256").update(await readFile(pathname)).digest("hex");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function adapterFixture(options: { stepTimeoutMs?: number; abortGraceMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "steward-provider-process-"));
  const workingDirectory = join(root, "workspace/project");
  const stateDirectory = join(root, "state/supervisor");
  await mkdir(workingDirectory, { recursive: true });
  temporaryDirectories.push(root);
  const modulePath = fileURLToPath(new URL("./provider-fixture.js", import.meta.url));
  const moduleSha256 = await sha256(modulePath);
  const adapter = await SubprocessProviderAdapter.create({
    config: {
      providerName: "codex",
      model: "fixture-model",
      role: "engineer",
      workspaceId: "workspace-test",
      agentId: "agent-test",
      laneId: "lane-test",
      workingDirectory,
    },
    modulePath,
    moduleSha256,
    stateDirectory,
    environment: {
      PATH: process.env.PATH,
      HOME: "/tmp/provider-home",
      CODEX_API_KEY: "codex-key-is-allowed",
      CODEX_HOME: "/tmp/provider-codex-home",
      OPENAI_API_KEY: "provider-key-is-allowed",
      CICADA_STEWARD_MODEL_CATALOG_JSON: "{\"caller\":\"catalog\"}",
      STEWARD_SUPERVISOR_TOKEN: "must-not-cross",
      STEWARD_STATE_DIRECTORY: "/must/not/cross",
      UNRELATED_SECRET: "must-not-cross",
      NODE_OPTIONS: "--inspect",
    },
    requestTimeoutMs: 2_000,
    ...(options.stepTimeoutMs !== undefined ? { stepTimeoutMs: options.stepTimeoutMs } : {}),
    ...(options.abortGraceMs !== undefined ? { abortGraceMs: options.abortGraceMs } : {}),
  });
  return { adapter, workingDirectory };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

test("provider child environment is an explicit allowlist with no supervisor state", () => {
  const child = providerChildEnvironment("codex", {
    PATH: "/bin",
    CODEX_API_KEY: "allowed-codex-credential",
    CODEX_HOME: "/tmp/codex-home",
    OPENAI_API_KEY: "allowed-provider-credential",
    CICADA_STEWARD_MODEL_CATALOG_JSON: "{\"caller\":\"catalog\"}",
    ANTHROPIC_API_KEY: "wrong-provider-credential",
    STEWARD_SUPERVISOR_TOKEN: "control-secret",
    STEWARD_STATE_DIRECTORY: "/control/state",
    RANDOM_SECRET: "ambient-secret",
    NODE_OPTIONS: "--require=malicious",
  });
  assert.deepEqual({ ...child }, {
    PATH: "/bin",
    CODEX_API_KEY: "allowed-codex-credential",
    CODEX_HOME: "/tmp/codex-home",
    OPENAI_API_KEY: "allowed-provider-credential",
    CICADA_STEWARD_MODEL_CATALOG_JSON: "{\"caller\":\"catalog\"}",
  });
});

test("real adapter module runs out of process with scrubbed config, environment, and semantic authorization", async () => {
  const { adapter } = await adapterFixture();
  const result = await adapter.executeStep({
    task: taskFixture(),
    phase: "research",
    iteration: 1,
    authorization: authorizeProviderPhase("engineer", "research"),
    signal: new AbortController().signal,
    reportCurrentAction: async () => undefined,
  });
  const evidence = JSON.parse(result.journal) as {
    configKeys: string[];
    environmentKeys: string[];
    authorization: { role: string; phase: string; operations: string[] };
  };
  assert.deepEqual(evidence.configKeys, [
    "agentId",
    "laneId",
    "model",
    "providerName",
    "role",
    "workingDirectory",
    "workspaceId",
  ]);
  assert.equal(evidence.environmentKeys.includes("OPENAI_API_KEY"), true);
  assert.equal(evidence.environmentKeys.includes("CODEX_API_KEY"), true);
  assert.equal(evidence.environmentKeys.includes("CODEX_HOME"), true);
  assert.equal(evidence.environmentKeys.includes("CICADA_STEWARD_MODEL_CATALOG_JSON"), true);
  for (const forbidden of [
    "STEWARD_SUPERVISOR_TOKEN",
    "STEWARD_STATE_DIRECTORY",
    "UNRELATED_SECRET",
    "NODE_OPTIONS",
  ]) {
    assert.equal(evidence.environmentKeys.includes(forbidden), false, `${forbidden} crossed the child boundary`);
  }
  assert.deepEqual(evidence.authorization, {
    role: "engineer",
    phase: "research",
    operations: ["context.read", "research.perform", "progress.record"],
  });
  await adapter.shutdown();
});

test("subprocess provider honors abort and restarts after a forced timeout", async () => {
  const { adapter } = await adapterFixture({ stepTimeoutMs: 100, abortGraceMs: 50 });
  const controller = new AbortController();
  const cooperative = adapter.executeStep({
    task: { ...taskFixture(), title: "wait-for-abort" },
    phase: "research",
    iteration: 1,
    authorization: authorizeProviderPhase("engineer", "research"),
    signal: controller.signal,
    reportCurrentAction: async () => controller.abort(),
  });
  await assert.rejects(cooperative, (error: unknown) => (error as Error).name === "AbortError");
  await adapter.settleInterrupt({ task: null, reason: "test cooperative abort" });

  const ignoring = adapter.executeStep({
    task: { ...taskFixture("task-ignore"), title: "ignore-abort" },
    phase: "research",
    iteration: 1,
    authorization: authorizeProviderPhase("engineer", "research"),
    signal: new AbortController().signal,
    reportCurrentAction: async () => undefined,
  });
  await assert.rejects(ignoring, (error: unknown) => (error as Error).name === "TimeoutError");

  const recovered = await adapter.executeStep({
    task: taskFixture("task-recovered"),
    phase: "research",
    iteration: 1,
    authorization: authorizeProviderPhase("engineer", "research"),
    signal: new AbortController().signal,
    reportCurrentAction: async () => undefined,
  });
  assert.match(recovered.journal, /environmentKeys/);
  await adapter.shutdown();
});

test("oversized provider output is rejected by the framed transport", async () => {
  const { adapter } = await adapterFixture();
  await assert.rejects(
    adapter.executeStep({
      task: { ...taskFixture(), title: "oversize" },
      phase: "research",
      iteration: 1,
      authorization: authorizeProviderPhase("engineer", "research"),
      signal: new AbortController().signal,
      reportCurrentAction: async () => undefined,
    }),
    /failed|frame|transport/i,
  );
  await adapter.shutdown();
});

test("interrupt settlement kills and confirms absence of TERM-ignoring provider descendants", async () => {
  const { adapter, workingDirectory } = await adapterFixture({ abortGraceMs: 50 });
  const controller = new AbortController();
  await assert.rejects(
    adapter.executeStep({
      task: { ...taskFixture(), title: "stubborn-grandchild" },
      phase: "research",
      iteration: 1,
      authorization: authorizeProviderPhase("engineer", "research"),
      signal: controller.signal,
      reportCurrentAction: async () => controller.abort(),
    }),
    (error: unknown) => (error as Error).name === "AbortError",
  );
  const grandchildPid = Number((await readFile(join(workingDirectory, "stubborn-grandchild.pid"), "utf8")).trim());
  assert.equal(processExists(grandchildPid), true, "adversarial grandchild must exist before settlement");
  try {
    await adapter.settleInterrupt({ task: null, reason: "human interrupt" });
    assert.equal(processExists(grandchildPid), false, "settlement returned while a provider descendant survived");
  } finally {
    if (processExists(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
    await adapter.shutdown().catch(() => undefined);
  }
});

test("provider module must be outside mutable roots, unlinked, and integrity pinned on every launch", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "steward-provider-integrity-")));
  temporaryDirectories.push(root);
  const workingDirectory = join(root, "workspace/project");
  const stateDirectory = join(root, "state/supervisor");
  const trustedDirectory = join(root, "trusted-adapter");
  await Promise.all([
    mkdir(workingDirectory, { recursive: true }),
    mkdir(trustedDirectory, { recursive: true }),
  ]);
  const source = `export function createProviderAdapter(config){return {providerName:config.providerName,model:config.model,async executeStep(input){await input.reportCurrentAction('trusted action');return {journal:'trusted result'}},async settleInterrupt(){},async shutdown(){}}}\n`;
  const trustedPath = join(trustedDirectory, "adapter.mjs");
  await writeFile(trustedPath, source, { mode: 0o600 });
  const digest = await sha256(trustedPath);
  const config = {
    providerName: "codex" as const,
    model: "fixture-model",
    role: "engineer" as const,
    workspaceId: "workspace-test",
    agentId: "agent-test",
    laneId: "lane-test",
    workingDirectory,
  };

  const insideWorkspace = join(workingDirectory, "adapter.mjs");
  await writeFile(insideWorkspace, source, { mode: 0o600 });
  await assert.rejects(
    SubprocessProviderAdapter.create({
      config,
      modulePath: insideWorkspace,
      moduleSha256: await sha256(insideWorkspace),
      stateDirectory,
    }),
    /outside workingDirectory/i,
  );

  const linkedPath = join(trustedDirectory, "linked.mjs");
  await symlink(trustedPath, linkedPath);
  await assert.rejects(
    SubprocessProviderAdapter.create({
      config,
      modulePath: linkedPath,
      moduleSha256: digest,
      stateDirectory,
    }),
    /symbolic-link/i,
  );

  const adapter = await SubprocessProviderAdapter.create({
    config,
    modulePath: trustedPath,
    moduleSha256: digest,
    stateDirectory,
    abortGraceMs: 50,
  });
  await adapter.settleInterrupt({ task: null, reason: "rotate before integrity recheck" });
  await writeFile(trustedPath, `${source}// tampered\n`, { mode: 0o600 });
  await assert.rejects(
    adapter.executeStep({
      task: taskFixture(),
      phase: "research",
      iteration: 1,
      authorization: authorizeProviderPhase("engineer", "research"),
      signal: new AbortController().signal,
      reportCurrentAction: async () => undefined,
    }),
    /SHA-256/i,
  );
  await adapter.shutdown().catch(() => undefined);

  await chmod(trustedPath, 0o622);
  await assert.rejects(
    SubprocessProviderAdapter.create({
      config,
      modulePath: trustedPath,
      moduleSha256: await sha256(trustedPath),
      stateDirectory,
    }),
    /group- or world-writable/i,
  );
});
