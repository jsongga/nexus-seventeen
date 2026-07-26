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
        provider: "codex",
        model: "codex-model",
        workingDirectory: "/work/one",
        statePath: "/state/one.json",
      },
      {
        workerId: "worker-two",
        agentId: "manager-one",
        token: TOKEN_TWO,
        provider: "claude",
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
  assert.deepEqual(config.retry, { initialDelayMs: 250, maximumDelayMs: 10_000 });
  assert.equal(config.agents[0]?.longPollMs, 30_000);
  assert.equal(config.agents[0]?.agentTimeoutMs, undefined);
  assert.equal(config.agents[1]?.longPollMs, 12_000);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.agents));
  assert.ok(Object.isFrozen(config.agents[0]));
});

test("rejects ambiguous, duplicated, unsafe, and unbounded fleet configuration", () => {
  const cases: Array<readonly [string, (value: Record<string, unknown>) => void, RegExp]> = [
    ["top-level unknown", (value) => { value.extra = true; }, /unknown field extra/u],
    ["unsupported version", (value) => { value.version = 2; }, /version must be 1/u],
    ["no agents", (value) => { value.agents = []; }, /between 1 and 128/u],
    ["non-origin board URL", (value) => { value.boardUrl = "http://127.0.0.1:4318/api"; }, /HTTPS origin/u],
    ["plaintext remote board", (value) => { value.boardUrl = "http://example.com"; }, /HTTPS origin/u],
    ["retry inversion", (value) => { value.retry = { initialDelayMs: 500, maximumDelayMs: 100 }; }, /between 500 and 300000/u],
    ["agent unknown", (value) => { (value.agents as Array<Record<string, unknown>>)[0]!.extra = true; }, /unknown field extra/u],
    ["short token", (value) => { (value.agents as Array<Record<string, unknown>>)[0]!.token = "short"; }, /at least 32/u],
    ["bad provider", (value) => { (value.agents as Array<Record<string, unknown>>)[0]!.provider = "other"; }, /codex or claude/u],
    ["relative workdir", (value) => { (value.agents as Array<Record<string, unknown>>)[0]!.workingDirectory = "work"; }, /must be absolute/u],
    ["tight long poll", (value) => { (value.agents as Array<Record<string, unknown>>)[0]!.longPollMs = 0; }, /between 1000 and 30000/u],
    ["long poll overflow", (value) => { (value.agents as Array<Record<string, unknown>>)[0]!.longPollMs = 30_001; }, /between 1000 and 30000/u],
    ["duplicate agent", (value) => {
      const agents = value.agents as Array<Record<string, unknown>>;
      agents[1]!.agentId = agents[0]!.agentId;
    }, /duplicate agentId/u],
    ["duplicate worker", (value) => {
      const agents = value.agents as Array<Record<string, unknown>>;
      agents[1]!.workerId = agents[0]!.workerId;
    }, /duplicate workerId/u],
    ["duplicate journal", (value) => {
      const agents = value.agents as Array<Record<string, unknown>>;
      agents[1]!.statePath = agents[0]!.statePath;
    }, /duplicate statePath/u],
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
  const invalidPath = join(root, "invalid.json");
  await writeFile(validPath, JSON.stringify(validConfig()), { mode: 0o600 });
  await writeFile(invalidPath, `{ "token": "${TOKEN_ONE}"`, { mode: 0o600 });

  const loaded = await loadTaskFleetConfig(validPath);
  assert.equal(loaded.agents.length, 2);
  await assert.rejects(loadTaskFleetConfig(invalidPath), (error: unknown) => {
    assert.match(String(error), /not valid JSON/u);
    assert.doesNotMatch(String(error), new RegExp(TOKEN_ONE, "u"));
    return true;
  });
});
