import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import type {
  ProviderAdapterConfig,
  ProviderStepInput,
} from "@cicada/steward-supervisor";
import { authorizeProviderPhase } from "@cicada/steward-supervisor";
import {
  CliProviderAdapter,
  buildCliInvocation,
} from "../src/adapter.js";
import type { CommandRunner } from "../src/process.js";
import { parseClaudeResult, parseCodexResult } from "../src/result.js";
import { ENGINEER_MODEL_CATALOG_ENV } from "../src/routing.js";

const tiers = Object.freeze({
  economy: Object.freeze({ contextWindowTokens: 8_000, maximumOutputTokens: 4_000 }),
  balanced: Object.freeze({ contextWindowTokens: 16_000, maximumOutputTokens: 4_000 }),
  frontier: Object.freeze({ contextWindowTokens: 64_000, maximumOutputTokens: 8_000 }),
} as const);

function modelCatalog(): Record<string, unknown> {
  return Object.fromEntries(["codex", "claude"].map((provider) => [
    provider,
    Object.fromEntries(["economy", "balanced", "frontier"].map((tier) => [
      tier,
      {
        provider,
        tier,
        modelId: `configured-${provider}-${tier}`,
        ...tiers[tier as keyof typeof tiers],
      },
    ])),
  ]));
}

function routingEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [ENGINEER_MODEL_CATALOG_ENV]: JSON.stringify(modelCatalog()),
    ...overrides,
  };
}

function config(
  providerName: "codex" | "claude" = "codex",
  role: "engineer" | "verifier" | "manager" = "engineer",
): ProviderAdapterConfig {
  return {
    providerName,
    model: providerName === "codex" ? "configured-codex-economy" : "configured-claude-economy",
    role,
    workspaceId: "workspace-test",
    agentId: "agent-test",
    laneId: "lane-test",
    workingDirectory: tmpdir(),
  };
}

function input(
  phase: ProviderStepInput["phase"],
  overrides: Partial<ProviderStepInput> = {},
): ProviderStepInput {
  return {
    task: {
      taskId: "task-one",
      workspaceId: "workspace-test",
      agentId: "agent-test",
      laneId: "lane-test",
      title: "Recover checkout",
      objective: "Customers can retry without creating a duplicate order.",
      status: "running",
      expectedAgentMinutes: 30,
      expectedCompletedAt: "2026-07-18T20:30:00.000Z",
      startedAt: "2026-07-18T20:00:00.000Z",
      endedAt: null,
    } as ProviderStepInput["task"],
    phase,
    iteration: 1,
    authorization: authorizeProviderPhase("engineer", phase),
    signal: new AbortController().signal,
    reportCurrentAction: async () => undefined,
    ...overrides,
  };
}

test("Codex invocation is non-interactive, phase-sandboxed, ephemeral, and prompt-on-stdin", () => {
  const invocation = buildCliInvocation(config("codex"), input("research"), routingEnvironment({
    PATH: "/usr/bin",
    HOME: "/safe/home",
    CODEX_HOME: "/safe/codex",
    CODEX_API_KEY: "provider-secret",
    STEWARD_SUPERVISOR_TOKEN: "must-not-cross",
    STEWARD_CONTROL_PLANE_URL: "must-not-cross",
  }));
  assert.equal(invocation.command, "codex");
  assert.ok(invocation.args.includes("--ephemeral"));
  assert.ok(invocation.args.includes("--ignore-user-config"));
  assert.ok(invocation.args.includes('shell_environment_policy.inherit="none"'));
  assert.ok(invocation.args.includes("shell_environment_policy.ignore_default_excludes=false"));
  assert.equal(invocation.args[invocation.args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(invocation.args.at(-1), "-");
  assert.equal(invocation.args.includes("Recover checkout"), false, "task input is not exposed in argv");
  assert.equal(
    invocation.args[invocation.args.indexOf("--model") + 1],
    "configured-codex-economy",
  );
  assert.match(invocation.stdin, /Customers can retry/u);
  assert.deepEqual(invocation.env, {
    PATH: "/usr/bin",
    HOME: "/safe/home",
    CODEX_HOME: "/safe/codex",
    CODEX_API_KEY: "provider-secret",
  });

  assert.equal(Object.hasOwn(invocation.env, ENGINEER_MODEL_CATALOG_ENV), false);

  const executing = buildCliInvocation(config("codex"), input("execute"), routingEnvironment());
  assert.equal(executing.args[executing.args.indexOf("--sandbox") + 1], "workspace-write");
  const testing = buildCliInvocation(config("codex"), input("test"), routingEnvironment());
  assert.equal(testing.args[testing.args.indexOf("--sandbox") + 1], "read-only");
});

test("the real engineer edge denies a configured provider other than Codex", () => {
  assert.throws(
    () => buildCliInvocation(config("claude"), input("plan"), routingEnvironment()),
    /requires the configured Codex provider/u,
  );
});

test("each first RPET iteration uses economy and observed failed tests escalate the model", () => {
  for (const phase of ["research", "plan", "execute", "test"] as const) {
    const invocation = buildCliInvocation(config(), input(phase), routingEnvironment());
    assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "configured-codex-economy");
  }
  const expectations = [
    [1, "configured-codex-economy"],
    [2, "configured-codex-balanced"],
    [3, "configured-codex-frontier"],
    [20, "configured-codex-frontier"],
  ] as const;
  for (const [iteration, modelId] of expectations) {
    const invocation = buildCliInvocation(
      config(),
      input("research", { iteration }),
      routingEnvironment(),
    );
    assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], modelId);
  }
});

test("oversize work and forged or invalid catalogs fail before provider execution", () => {
  assert.throws(
    () => buildCliInvocation(config(), input("research", {
      task: { ...input("research").task, objective: "x".repeat(100_000) },
    }), routingEnvironment()),
    /routing denied.*blocked/u,
  );
  assert.throws(
    () => buildCliInvocation(config(), input("research"), {}),
    /MODEL_CATALOG_JSON is required/u,
  );

  const unexpected = modelCatalog();
  unexpected.forged = {};
  assert.throws(
    () => buildCliInvocation(config(), input("research"), {
      [ENGINEER_MODEL_CATALOG_ENV]: JSON.stringify(unexpected),
    }),
    /must contain exactly/u,
  );

  const mismatched = modelCatalog() as {
    codex: { economy: { provider: string } };
  };
  mismatched.codex.economy.provider = "claude";
  assert.throws(
    () => buildCliInvocation(config(), input("research"), {
      [ENGINEER_MODEL_CATALOG_ENV]: JSON.stringify(mismatched),
    }),
    /must identify its configured provider and tier/u,
  );

  assert.throws(
    () => buildCliInvocation(
      { ...config(), model: "forged-baseline" },
      input("research"),
      routingEnvironment(),
    ),
    /must match.*economy baseline/u,
  );
});

test("adapter reports a current action and returns only validated structured evidence", async () => {
  const actions: string[] = [];
  const runner: CommandRunner = {
    async run(invocation) {
      assert.match(invocation.stdin, /test phase/u);
      return {
        exitCode: 0,
        stderr: "untrusted diagnostic that is never journaled",
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "thread-one" }),
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: JSON.stringify({
                journal: "Checkout recovery passed the selected checks.",
                testOutcome: "passed",
                resultOverview: "Customers can retry checkout safely.",
              }),
            },
          }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 10 } }),
        ].join("\n"),
      };
    },
  };
  const adapter = new CliProviderAdapter(config("codex"), runner, routingEnvironment());
  const result = await adapter.executeStep(input("test", {
    reportCurrentAction: async (summary) => { actions.push(summary); },
  }));
  assert.deepEqual(actions, [
    "Testing iteration 1 via economy/configured-codex-economy; reasons=fixed_role_phase_baseline",
  ]);
  assert.deepEqual(result, {
    journal: "Checkout recovery passed the selected checks.",
    testOutcome: "passed",
    resultOverview: "Customers can retry checkout safely.",
  });
});

test("adapter fails closed for non-engineer ownership and forged phase authorization", async () => {
  assert.throws(() => new CliProviderAdapter(config("claude", "manager")), /only own engineer/u);
  const adapter = new CliProviderAdapter(config("codex"), {
    async run() { throw new Error("runner must not execute"); },
  }, routingEnvironment());
  const forged = input("research", {
    authorization: {
      role: "engineer",
      phase: "research",
      operations: ["context.read", "workspace.modify"] as never,
    },
  });
  await assert.rejects(adapter.executeStep(forged), /does not match/u);
});

test("Claude structured output parser remains bounded for future non-engineer adapters", () => {
  assert.deepEqual(parseClaudeResult(JSON.stringify({
    type: "result",
    subtype: "success",
    structured_output: {
      journal: "The code path and acceptance checks are mapped.",
      testOutcome: null,
      resultOverview: null,
    },
    usage: { input_tokens: 10, output_tokens: 5 },
  }), "plan"), {
    journal: "The code path and acceptance checks are mapped.",
  });
});

function codexResult(journal: string, resultOverview: string | null = null): string {
  return [
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: JSON.stringify({ journal, testOutcome: "passed", resultOverview }),
      },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
  ].join("\n");
}

test("structured provider output rejects credentials without reflecting them in the error", () => {
  const secrets = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123456",
    "api_key=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "AWS credential AKIAABCDEFGHIJKLMNOP was visible",
    "-----BEGIN PRIVATE KEY-----",
    "token: aB9fQ2rT7wX4zK8mN6pL3vC5sD1jH0uE",
  ];
  for (const secret of secrets) {
    assert.throws(
      () => parseCodexResult(codexResult(`Test passed. ${secret}`), "test"),
      (error: unknown) => error instanceof Error &&
        /credential-safety filter/u.test(error.message) &&
        !error.message.includes(secret),
    );
  }
});

test("credential filter permits ordinary digests, commits, paths, and explicit redaction", () => {
  const digest = "a".repeat(64);
  const commit = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(parseClaudeResult(JSON.stringify({
    type: "result",
    subtype: "success",
    structured_output: {
      journal: `Verified sha256:${digest} at src/checkout/retry-handler.test.ts; token: redacted.`,
      testOutcome: "passed",
      resultOverview: `Commit ${commit} passed without exposing credentials.`,
    },
  }), "test"), {
    journal: `Verified sha256:${digest} at src/checkout/retry-handler.test.ts; token: redacted.`,
    testOutcome: "passed",
    resultOverview: `Commit ${commit} passed without exposing credentials.`,
  });
});
