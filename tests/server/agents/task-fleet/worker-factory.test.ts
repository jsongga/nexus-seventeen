import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { join, resolve } from "node:path";
import { codexAdapter } from "../../../../src/server/agents/runtime/codex.js";
import { runtimeRegistry } from "../../../../src/server/agents/runtime/registry.js";
import {
  loadRuntimeProfiles,
  parseRuntimeProfiles,
  RuntimeCapabilityError,
} from "../../../../src/server/agents/runtime/profiles.js";
import { parseTaskFleetConfig } from "#server/agents/task-fleet/config";
import { TaskBoardHttpError } from "#server/agents/task-worker";
import { PromptRegistry } from "#server/agents/task-worker/prompt-registry";
import {
  captureTaskFleetRuntimeVersion,
  classifyTaskFleetError,
  createTaskFleetWorker,
  isTransientTaskFleetError,
} from "#server/agents/task-fleet/worker-factory";
import { tempRoot } from "../task-worker/helpers.js";
import { SHIPPED_RUNTIME_PROFILES } from "../runtime/profile-fixtures.js";

test("captures the first CLI version line once and treats failures or invalid output as unavailable", async () => {
  const calls: Array<{ command: string; arguments_: readonly string[] }> = [];
  const captured = await captureTaskFleetRuntimeVersion("codex", async (command, arguments_) => {
    calls.push({ command, arguments_ });
    return "codex-cli 1.2.3\nrelease metadata\n";
  });
  assert.equal(captured, "codex-cli 1.2.3");
  assert.deepEqual(calls, [{ command: "codex", arguments_: ["--version"] }]);

  assert.equal(
    await captureTaskFleetRuntimeVersion("claude", async () => {
      throw new Error("missing");
    }),
    null
  );
  assert.equal(await captureTaskFleetRuntimeVersion("claude", async () => "\nsecond line"), null);
  assert.equal(await captureTaskFleetRuntimeVersion("claude", async () => "v".repeat(129)), null);
});

test("constructs a worker with the registry-selected adapter and rejects an unknown runtime id", async () => {
  const root = await tempRoot();
  const config = parseTaskFleetConfig({
    version: 1,
    boardUrl: "http://127.0.0.1:4318",
    agents: [
      {
        workerId: "worker-one",
        agentId: "engineer-one",
        token: "agent-one-token-0123456789-abcdefghijklmnopqrstuvwxyz",
        provider: "codex",
        model: "codex-test",
        workingDirectory: root,
        statePath: join(root, "journal", "state.json"),
      },
    ],
  }).agents[0]!;
  let environmentCalls = 0;
  let promptLoads = 0;
  const runtimeProfileLogs: string[] = [];
  const promptsFile = resolve("config/prompts.md");
  const selected = Object.freeze({
    ...codexAdapter,
    environment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
      environmentCalls += 1;
      return codexAdapter.environment(source);
    },
  });
  const worker = await createTaskFleetWorker(config, "http://127.0.0.1:4318", {
    registry: runtimeRegistry([selected]),
    profiles: SHIPPED_RUNTIME_PROFILES,
    promptsFile,
    loadPrompts: (file) => {
      promptLoads += 1;
      assert.equal(file, promptsFile);
      return PromptRegistry.loadSync(file);
    },
    logRuntimeProfile: (line) => runtimeProfileLogs.push(line),
  });
  try {
    assert.equal(environmentCalls, 1);
    assert.equal(promptLoads, 1);
    assert.deepEqual(runtimeProfileLogs, [
      '[task-fleet] runtime_profile runtime="codex" permissionModel="cli-sandbox-flags" mcp=false toolCallGranularity="command" contextNotes="JSONL item stream; schema via --output-schema file"',
    ]);
  } finally {
    await worker.close();
  }

  await assert.rejects(
    createTaskFleetWorker(config, "http://127.0.0.1:4318", {
      registry: runtimeRegistry([]),
      profiles: SHIPPED_RUNTIME_PROFILES,
    }),
    /Unknown runtime adapter: codex/u
  );
});

test("rejects a registry runtime that is missing from the capability profiles", async () => {
  const root = await tempRoot();
  const config = parseTaskFleetConfig({
    version: 1,
    boardUrl: "http://127.0.0.1:4318",
    agents: [
      {
        workerId: "worker-ghost",
        agentId: "engineer-ghost",
        token: "agent-ghost-token-0123456789-abcdefghijklmnopqrstuvwxyz",
        provider: "ghost",
        model: "ghost-test",
        workingDirectory: root,
        statePath: join(root, "journal", "ghost.json"),
      },
    ],
  }).agents[0]!;
  const ghostAdapter = Object.freeze({ ...codexAdapter, runtime: "ghost" });

  await assert.rejects(
    createTaskFleetWorker(config, "http://127.0.0.1:4318", {
      registry: runtimeRegistry([ghostAdapter]),
      profiles: SHIPPED_RUNTIME_PROFILES,
    }),
    /Unknown runtime profile: ghost/u
  );
});

test("validates an operator-declared lane role during worker construction", async () => {
  const root = await tempRoot();
  const config = parseTaskFleetConfig({
    version: 1,
    boardUrl: "http://127.0.0.1:4318",
    agents: [
      {
        workerId: "worker-role",
        agentId: "engineer-role",
        token: "agent-role-token-0123456789-abcdefghijklmnopqrstuvwxyz",
        provider: "codex",
        role: "engineer",
        model: "codex-test",
        workingDirectory: root,
        statePath: join(root, "journal", "role.json"),
      },
    ],
  }).agents[0]!;
  const cases = [
    parseRuntimeProfiles({
      version: 1,
      runtimes: {
        codex: {
          binary: "codex",
          permissionModel: "cli-sandbox-flags",
          roles: { verifier: { sandbox: "read-only" } },
          mcp: false,
          toolCallGranularity: "command",
          contextNotes: "missing engineer role",
        },
      },
    }),
    parseRuntimeProfiles({
      version: 1,
      runtimes: {
        codex: {
          binary: "codex",
          permissionModel: "cli-sandbox-flags",
          roles: { engineer: { sandbox: "unconfined" } },
          mcp: false,
          toolCallGranularity: "command",
          contextNotes: "unknown engineer sandbox",
        },
      },
    }),
  ];

  for (const profiles of cases) {
    await assert.rejects(
      createTaskFleetWorker(config, "http://127.0.0.1:4318", {
        registry: runtimeRegistry([codexAdapter]),
        profiles,
      }),
      (error: unknown) =>
        error instanceof RuntimeCapabilityError && error.runtime === "codex" && error.role === "engineer"
    );
  }
});

test("deduplicates successful profile disk loads per resolved path", async () => {
  const root = await tempRoot();
  const profilesPath = join(root, "runtimes.json");
  await writeFile(profilesPath, await readFile(resolve("config/runtimes.json"), "utf8"), { mode: 0o600 });
  const configs = parseTaskFleetConfig({
    version: 1,
    boardUrl: "http://127.0.0.1:4318",
    agents: ["one", "two"].map((suffix) => ({
      workerId: `worker-${suffix}`,
      agentId: `engineer-${suffix}`,
      token: `agent-${suffix}-token-0123456789-abcdefghijklmnopqrstuvwxyz`,
      provider: "codex",
      model: "codex-test",
      workingDirectory: root,
      statePath: join(root, "journal", `${suffix}.json`),
    })),
  }).agents;
  let loads = 0;
  const loadProfiles = async (path: string) => {
    loads += 1;
    return loadRuntimeProfiles(path);
  };

  const workers = await Promise.all(
    configs.map((config) =>
      createTaskFleetWorker(config, "http://127.0.0.1:4318", {
        registry: runtimeRegistry([codexAdapter]),
        runtimesConfigPath: profilesPath,
        loadProfiles,
      })
    )
  );
  try {
    assert.equal(loads, 1);
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
  }
});

test("evicts a failed profile disk load so a fixed file succeeds on retry", async () => {
  const root = await tempRoot();
  const profilesPath = join(root, "runtimes.json");
  await writeFile(profilesPath, "{ invalid", { mode: 0o600 });
  const config = parseTaskFleetConfig({
    version: 1,
    boardUrl: "http://127.0.0.1:4318",
    agents: [
      {
        workerId: "worker-retry",
        agentId: "engineer-retry",
        token: "agent-retry-token-0123456789-abcdefghijklmnopqrstuvwxyz",
        provider: "codex",
        model: "codex-test",
        workingDirectory: root,
        statePath: join(root, "journal", "retry.json"),
      },
    ],
  }).agents[0]!;
  let loads = 0;
  const loadProfiles = async (path: string) => {
    loads += 1;
    return loadRuntimeProfiles(path);
  };
  const options = { registry: runtimeRegistry([codexAdapter]), runtimesConfigPath: profilesPath, loadProfiles };

  await assert.rejects(createTaskFleetWorker(config, "http://127.0.0.1:4318", options), /not valid JSON/u);
  await writeFile(profilesPath, await readFile(resolve("config/runtimes.json"), "utf8"), { mode: 0o600 });
  const worker = await createTaskFleetWorker(config, "http://127.0.0.1:4318", options);
  try {
    assert.equal(loads, 2);
  } finally {
    await worker.close();
  }
});

test("retries transport, throttling, server, and journal I/O failures", () => {
  for (const status of [null, 408, 425, 429, 500, 503]) {
    assert.equal(isTransientTaskFleetError(new TaskBoardHttpError("temporary", status, null)), true, String(status));
  }
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(isTransientTaskFleetError(new TaskBoardHttpError("permanent", status, null)), false, String(status));
  }
  for (const code of ["EIO", "ENOSPC", "EMFILE", "ENFILE"]) {
    assert.equal(isTransientTaskFleetError(Object.assign(new Error("journal I/O failed"), { code })), true, code);
  }
  assert.equal(isTransientTaskFleetError(new Error("programming error")), false);
});

test("classifies a revoked lane credential separately from transient and poisoned failures", () => {
  assert.equal(classifyTaskFleetError(new TaskBoardHttpError("rotated", 401, "UNAUTHORIZED")), "CREDENTIAL_REVOKED");
  assert.equal(classifyTaskFleetError(new TaskBoardHttpError("temporary", 503, "TEMPORARY")), "TRANSIENT");
  assert.equal(classifyTaskFleetError(new TaskBoardHttpError("invalid", 400, "INVALID_REQUEST")), "POISONED");
  assert.equal(classifyTaskFleetError(new RuntimeCapabilityError("codex", "engineer")), "POISONED");
});
