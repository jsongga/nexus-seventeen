import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTaskFleetConfig, parseTaskFleetConfig } from "#server/agents/task-fleet/config";

const TOKEN_ONE = "agent-one-token-0123456789-abcdefghijklmnopqrstuvwxyz";
const TOKEN_TWO = "agent-two-token-0123456789-abcdefghijklmnopqrstuvwxyz";

function validConfig(): Record<string, unknown> {
  return {
    version: 1,
    boardUrl: "http://127.0.0.1:4318",
    retry: { initialDelayMs: 25, maximumDelayMs: 200 },
    agents: [
      {
        workerId: "worker-one",
        agentId: "engineer-one",
        token: TOKEN_ONE,
        runtime: "codex",
        model: "codex-model",
        workingDirectory: "/work/one",
        statePath: "/state/one.json",
      },
      {
        workerId: "worker-two",
        agentId: "manager-one",
        token: TOKEN_TWO,
        runtime: "claude",
        model: "claude-model",
        workingDirectory: "/work/two",
        statePath: "/state/two.json",
        longPollMs: 12_000,
        agentTimeoutMs: 90_000,
        terminationGraceMs: 500,
      },
    ],
  };
}

test("parses a bounded multi-agent fleet and applies idle/retry defaults", () => {
  const input = validConfig();
  delete input.retry;
  const config = parseTaskFleetConfig(input);

  assert.equal(config.version, 1);
  assert.equal(config.boardUrl, "http://127.0.0.1:4318");
  assert.equal(config.runtimesConfigPath, undefined);
  assert.equal(config.promptsFile, undefined);
  assert.deepEqual(config.retry, { initialDelayMs: 1_000, maximumDelayMs: 60_000 });
  assert.equal(config.agents[0]?.longPollMs, 30_000);
  assert.equal(config.agents[0]?.agentTimeoutMs, undefined);
  assert.equal(config.agents[0]?.runtime, "codex");
  assert.equal(config.agents[0]?.launchMode, "local-process");
  assert.equal(config.agents[0]?.container, undefined);
  assert.equal(config.agents[1]?.longPollMs, 12_000);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.agents));
  assert.ok(Object.isFrozen(config.agents[0]));
});

test("accepts registry-resolved runtime ids and an optional runtime profile path", () => {
  const input = validConfig();
  input.runtimesConfigPath = "config/custom-runtimes.json";
  input.promptsFile = "config/custom-prompts.md";
  (input.agents as Array<Record<string, unknown>>)[0]!.runtime = "third-runtime";
  (input.agents as Array<Record<string, unknown>>)[0]!.role = "verifier";

  const config = parseTaskFleetConfig(input);
  assert.equal(config.runtimesConfigPath, "config/custom-runtimes.json");
  assert.equal(config.promptsFile, "config/custom-prompts.md");
  assert.equal(config.agents[0]?.runtime, "third-runtime");
  assert.equal(config.agents[0]?.role, "verifier");
});

test("parses a container lane and applies container defaults", () => {
  const input = validConfig();
  const agent = (input.agents as Array<Record<string, unknown>>)[0]!;
  agent.launchMode = "container";
  agent.container = { workspaceRoot: "/task-workspaces" };

  const parsed = parseTaskFleetConfig(input).agents[0];

  assert.equal(parsed?.launchMode, "container");
  assert.deepEqual(parsed?.container, {
    workspaceRoot: "/task-workspaces",
    image: undefined,
    agentCommand: undefined,
    extraAllowedHosts: [],
  });
  assert.ok(Object.isFrozen(parsed?.container));
  assert.ok(Object.isFrozen(parsed?.container?.extraAllowedHosts));
});

test("loads legacy provider and runtime launch-mode keys with warnings and identical normalized config", () => {
  const legacy = validConfig();
  const legacyAgent = (legacy.agents as Array<Record<string, unknown>>)[0]!;
  legacyAgent.provider = legacyAgent.runtime;
  legacyAgent.runtime = "container";
  legacyAgent.container = { workspaceRoot: "/task-workspaces" };

  const current = validConfig();
  const currentAgent = (current.agents as Array<Record<string, unknown>>)[0]!;
  currentAgent.launchMode = "container";
  currentAgent.container = { workspaceRoot: "/task-workspaces" };

  const warnings: string[] = [];
  const legacyConfig = parseTaskFleetConfig(legacy, (message) => warnings.push(message));
  const currentWarnings: string[] = [];
  const currentConfig = parseTaskFleetConfig(current, (message) => currentWarnings.push(message));

  assert.deepEqual(legacyConfig, currentConfig);
  assert.deepEqual(currentWarnings, []);
  assert.deepEqual(warnings, [
    "config.agents[0].provider is deprecated; use config.agents[0].runtime",
    "config.agents[0].runtime as a launch-mode key is deprecated; use config.agents[0].launchMode",
  ]);
});

test("rejects old and new keys for either concept instead of preferring one", () => {
  const duplicateRuntime = validConfig();
  (duplicateRuntime.agents as Array<Record<string, unknown>>)[0]!.provider = "codex";
  assert.throws(
    () => parseTaskFleetConfig(duplicateRuntime),
    /cannot set both provider and runtime; provider is deprecated, use runtime/u
  );

  const duplicateLaunchMode = validConfig();
  const agent = (duplicateLaunchMode.agents as Array<Record<string, unknown>>)[0]!;
  agent.provider = agent.runtime;
  agent.runtime = "container";
  agent.launchMode = "container";
  agent.container = { workspaceRoot: "/task-workspaces" };
  assert.throws(
    () => parseTaskFleetConfig(duplicateLaunchMode),
    /cannot set both runtime as a legacy launch-mode key and launchMode/u
  );
});

test("fails safely when a reserved or unknown launch-mode value cannot be used as the model runtime", () => {
  const reserved = validConfig();
  (reserved.agents as Array<Record<string, unknown>>)[0]!.runtime = "container";
  assert.throws(
    () => parseTaskFleetConfig(reserved),
    /runtime="container" is the deprecated launch-mode key; add the model runtime.*launchMode/u
  );

  const unknownLaunchMode = validConfig();
  (unknownLaunchMode.agents as Array<Record<string, unknown>>)[0]!.launchMode = "remote";
  assert.throws(() => parseTaskFleetConfig(unknownLaunchMode), /launchMode must be local-process or container/u);
});

test("rejects ambiguous, duplicated, unsafe, and unbounded fleet configuration", () => {
  const cases: Array<readonly [string, (value: Record<string, unknown>) => void, RegExp]> = [
    [
      "top-level unknown",
      (value) => {
        value.extra = true;
      },
      /unknown field extra/u,
    ],
    [
      "unsupported version",
      (value) => {
        value.version = 2;
      },
      /version must be 1/u,
    ],
    [
      "no agents",
      (value) => {
        value.agents = [];
      },
      /between 1 and 128/u,
    ],
    [
      "non-origin board URL",
      (value) => {
        value.boardUrl = "http://127.0.0.1:4318/api";
      },
      /HTTPS origin/u,
    ],
    [
      "plaintext remote board",
      (value) => {
        value.boardUrl = "http://example.com";
      },
      /HTTPS origin/u,
    ],
    [
      "retry inversion",
      (value) => {
        value.retry = { initialDelayMs: 500, maximumDelayMs: 100 };
      },
      /between 500 and 300000/u,
    ],
    [
      "agent unknown",
      (value) => {
        (value.agents as Array<Record<string, unknown>>)[0]!.extra = true;
      },
      /unknown field extra/u,
    ],
    [
      "short token",
      (value) => {
        (value.agents as Array<Record<string, unknown>>)[0]!.token = "short";
      },
      /at least 32/u,
    ],
    [
      "bad runtime",
      (value) => {
        (value.agents as Array<Record<string, unknown>>)[0]!.runtime = " invalid ";
      },
      /runtime is invalid/u,
    ],
    [
      "bad role",
      (value) => {
        (value.agents as Array<Record<string, unknown>>)[0]!.role = "administrator";
      },
      /role must be one of/u,
    ],
    [
      "empty runtime profile path",
      (value) => {
        value.runtimesConfigPath = "";
      },
      /runtimesConfigPath is invalid/u,
    ],
    [
      "empty prompts file",
      (value) => {
        value.promptsFile = "";
      },
      /promptsFile is invalid/u,
    ],
    [
      "obsolete prompts root",
      (value) => {
        value.promptsRoot = "prompts";
      },
      /promptsRoot.*promptsFile/u,
    ],
    [
      "container lane without config",
      (value) => {
        (value.agents as Array<Record<string, unknown>>)[0]!.launchMode = "container";
      },
      /container is required for container lanes/u,
    ],
    [
      "container config on local lane",
      (value) => {
        (value.agents as Array<Record<string, unknown>>)[0]!.container = { workspaceRoot: "/task-workspaces" };
      },
      /container is only valid for container lanes/u,
    ],
    [
      "bad container host",
      (value) => {
        const agent = (value.agents as Array<Record<string, unknown>>)[0]!;
        agent.launchMode = "container";
        agent.container = { workspaceRoot: "/task-workspaces", extraAllowedHosts: ["Bad Host!"] };
      },
      /extraAllowedHosts\[0\] is invalid/u,
    ],
    [
      "relative container workspace root",
      (value) => {
        const agent = (value.agents as Array<Record<string, unknown>>)[0]!;
        agent.launchMode = "container";
        agent.container = { workspaceRoot: "task-workspaces" };
      },
      /workspaceRoot must be absolute/u,
    ],
    [
      "container unknown",
      (value) => {
        const agent = (value.agents as Array<Record<string, unknown>>)[0]!;
        agent.launchMode = "container";
        agent.container = { workspaceRoot: "/task-workspaces", extra: true };
      },
      /container has unknown field extra/u,
    ],
    [
      "unbounded model",
      (value) => {
        (value.agents as Array<Record<string, unknown>>)[0]!.model = "m".repeat(129);
      },
      /model is invalid/u,
    ],
    [
      "relative workdir",
      (value) => {
        (value.agents as Array<Record<string, unknown>>)[0]!.workingDirectory = "work";
      },
      /must be absolute/u,
    ],
    [
      "tight long poll",
      (value) => {
        (value.agents as Array<Record<string, unknown>>)[0]!.longPollMs = 0;
      },
      /between 1000 and 30000/u,
    ],
    [
      "long poll overflow",
      (value) => {
        (value.agents as Array<Record<string, unknown>>)[0]!.longPollMs = 30_001;
      },
      /between 1000 and 30000/u,
    ],
    [
      "duplicate agent",
      (value) => {
        const agents = value.agents as Array<Record<string, unknown>>;
        agents[1]!.agentId = agents[0]!.agentId;
      },
      /duplicate agentId/u,
    ],
    [
      "duplicate worker",
      (value) => {
        const agents = value.agents as Array<Record<string, unknown>>;
        agents[1]!.workerId = agents[0]!.workerId;
      },
      /duplicate workerId/u,
    ],
    [
      "duplicate journal",
      (value) => {
        const agents = value.agents as Array<Record<string, unknown>>;
        agents[1]!.statePath = agents[0]!.statePath;
      },
      /duplicate statePath/u,
    ],
  ];

  for (const [label, mutate, expected] of cases) {
    const value = validConfig();
    mutate(value);
    assert.throws(() => parseTaskFleetConfig(value), expected, label);
  }
});

test("loads a regular bounded JSON file and reports invalid JSON without leaking contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-task-fleet-config-"));
  const validPath = join(root, "fleet.json");
  const legacyPath = join(root, "legacy-fleet.json");
  const invalidPath = join(root, "invalid.json");
  await writeFile(validPath, JSON.stringify(validConfig()), { mode: 0o600 });
  const legacy = validConfig();
  for (const agent of legacy.agents as Array<Record<string, unknown>>) {
    agent.provider = agent.runtime;
    delete agent.runtime;
  }
  const firstLegacyAgent = (legacy.agents as Array<Record<string, unknown>>)[0]!;
  firstLegacyAgent.runtime = "container";
  firstLegacyAgent.container = { workspaceRoot: "/task-workspaces" };
  await writeFile(legacyPath, JSON.stringify(legacy), { mode: 0o600 });
  await writeFile(invalidPath, `{ "token": "${TOKEN_ONE}"`, { mode: 0o600 });

  const loaded = await loadTaskFleetConfig(validPath);
  assert.equal(loaded.agents.length, 2);
  const legacyWarnings: string[] = [];
  const loadedLegacy = await loadTaskFleetConfig(legacyPath, (message) => legacyWarnings.push(message));
  assert.deepEqual(
    loadedLegacy.agents.map(({ runtime, launchMode }) => ({ runtime, launchMode })),
    [
      { runtime: "codex", launchMode: "container" },
      { runtime: "claude", launchMode: "local-process" },
    ]
  );
  assert.deepEqual(legacyWarnings, [
    "config.agents[0].provider is deprecated; use config.agents[0].runtime",
    "config.agents[0].runtime as a launch-mode key is deprecated; use config.agents[0].launchMode",
    "config.agents[1].provider is deprecated; use config.agents[1].runtime",
  ]);
  await assert.rejects(loadTaskFleetConfig(invalidPath), (error: unknown) => {
    assert.match(String(error), /not valid JSON/u);
    assert.doesNotMatch(String(error), new RegExp(TOKEN_ONE, "u"));
    return true;
  });
});
