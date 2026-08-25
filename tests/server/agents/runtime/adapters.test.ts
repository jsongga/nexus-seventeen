import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_ROLES } from "../../../../src/shared/task-board-contract/index.js";
import {
  claudeProviderArgs,
  codexProviderArgs,
  providerEnvironment,
  providerResult,
  type AgentProvider,
  type ProviderArgumentOptions,
} from "../../../../src/server/agents/task-worker/agent-envelope.js";
import { claudeAdapter } from "../../../../src/server/agents/runtime/claude.js";
import { codexAdapter } from "../../../../src/server/agents/runtime/codex.js";
import { defaultRuntimeRegistry, runtimeRegistry } from "../../../../src/server/agents/runtime/registry.js";

const OPTION_CASES: readonly ProviderArgumentOptions[] = [
  {
    model: "provider-model",
    workingDirectory: "/workspace/project",
    schemaPath: "/runtime/agent-result.schema.json",
    bareApiKey: false,
    proxyEgress: false,
  },
  {
    model: "provider-model-with-egress",
    workingDirectory: "/workspace/project-with-egress",
    schemaPath: "/runtime/agent-result-with-egress.schema.json",
    bareApiKey: true,
    proxyEgress: true,
  },
];

function invocation(call: () => unknown): unknown {
  try {
    return { returned: call() };
  } catch (error) {
    assert.ok(error instanceof Error);
    return { threw: { name: error.name, message: error.message } };
  }
}

test("runtime adapters preserve provider argv for every fixed agent role", () => {
  for (const options of OPTION_CASES) {
    for (const role of AGENT_ROLES) {
      assert.deepEqual(codexAdapter.args(options, role), codexProviderArgs(options, role));
      assert.deepEqual(claudeAdapter.args(options, role), claudeProviderArgs(options, role));
    }
  }
});

test("runtime adapters preserve provider environment filtering", () => {
  const source: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/agent",
    TMPDIR: "/tmp/runtime",
    TEMP: "",
    TMP: "invalid\0value",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    SSL_CERT_FILE: "/etc/ssl/cert.pem",
    SSL_CERT_DIR: "/etc/ssl/certs",
    CODEX_HOME: "/home/agent/.codex",
    CODEX_API_KEY: "codex-key",
    OPENAI_API_KEY: "openai-key",
    OPENAI_ORGANIZATION: "org-one",
    OPENAI_PROJECT: "project-one",
    ANTHROPIC_API_KEY: "anthropic-key",
    CLAUDE_CONFIG_DIR: "/home/agent/.claude",
    UNRELATED_SECRET: "must-not-pass",
  };

  assert.deepEqual(codexAdapter.environment(source), providerEnvironment("codex", source));
  assert.deepEqual(claudeAdapter.environment(source), providerEnvironment("claude", source));
});

test("runtime adapters preserve successful and failing terminal result parsing", () => {
  const structured = { status: "completed", result: "runtime parity" };
  const fixtures: ReadonlyArray<{
    readonly provider: AgentProvider;
    readonly stdout: string;
  }> = [
    {
      provider: "codex",
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-one" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(structured) } }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n"),
    },
    {
      provider: "claude",
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: structured }),
    },
    {
      provider: "claude",
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(structured) }),
    },
    { provider: "codex", stdout: JSON.stringify({ type: "turn.failed", error: { message: "failed" } }) },
    { provider: "codex", stdout: JSON.stringify({ type: "error", message: "failed" }) },
    { provider: "codex", stdout: JSON.stringify({ type: "turn.completed" }) },
    { provider: "codex", stdout: "not-json" },
    { provider: "claude", stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", result: "failed" }) },
    { provider: "claude", stdout: JSON.stringify({ type: "assistant", message: { content: [] } }) },
    { provider: "claude", stdout: "not-json" },
  ];

  for (const fixture of fixtures) {
    const adapter = fixture.provider === "codex" ? codexAdapter : claudeAdapter;
    assert.deepEqual(
      invocation(() => adapter.result(fixture.stdout)),
      invocation(() => providerResult(fixture.provider, fixture.stdout)),
      `${fixture.provider}: ${fixture.stdout}`,
    );
  }
});

test("Codex lines map to the internal runtime event shapes", () => {
  assert.deepEqual(codexAdapter.events('{"type":"thread.started","thread_id":"thread-one"}'), [
    { type: "stage_started" },
  ]);
  assert.deepEqual(codexAdapter.events(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "assistant text" },
  })), [
    { type: "message_delta", text: "assistant text" },
  ]);
  assert.deepEqual(codexAdapter.events(JSON.stringify({
    type: "item.started",
    item: { type: "command_execution", command: "npm run test:runtime" },
  })), [
    { type: "tool_call", name: "command", detail: "npm run test:runtime" },
  ]);
  assert.deepEqual(codexAdapter.events(JSON.stringify({
    type: "item.completed",
    item: { type: "command_execution", command: "npm run test:runtime", aggregated_output: "all tests passed\n" },
  })), [
    { type: "tool_result", name: "command", output: "all tests passed\n", failed: false },
  ]);
  assert.deepEqual(codexAdapter.events(JSON.stringify({
    type: "item.completed",
    item: { type: "command_execution", exit_code: 1, aggregated_output: "tests failed\n" },
  })), [
    { type: "tool_result", name: "command", output: "tests failed\n", failed: true },
  ]);
  assert.deepEqual(codexAdapter.events('{"type":"turn.completed"}'), [
    { type: "stage_finished" },
  ]);
  assert.deepEqual(codexAdapter.events('{"type":"turn.failed","error":{"message":"turn failed"}}'), [
    { type: "error", detail: "turn failed" },
  ]);
  assert.deepEqual(codexAdapter.events('{"type":"error","message":"provider failed"}'), [
    { type: "error", detail: "provider failed" },
  ]);
  assert.deepEqual(codexAdapter.events("not-json"), []);
});

test("Codex normalizes every legacy activity-bearing item form", () => {
  const fixtures: ReadonlyArray<{
    readonly line: string;
    readonly events: readonly unknown[];
  }> = [
    {
      line: '{"type":"turn.started"}',
      events: [{ type: "tool_call", name: "work", detail: "" }],
    },
    ...(["reasoning", "todo_list", "plan", "file_change", "web_search", "mcp_tool_call", "tool_call", "collaboration_tool_call"] as const)
      .flatMap((name) => [
        {
          line: JSON.stringify({ type: "item.started", item: { type: name } }),
          events: [{ type: "tool_call", name, detail: "" }],
        },
        {
          line: JSON.stringify({ type: "item.completed", item: { type: name } }),
          events: [{ type: "tool_result", name, output: "", failed: false }],
        },
      ]),
  ];

  for (const fixture of fixtures) {
    assert.deepEqual(codexAdapter.events(fixture.line), fixture.events, fixture.line);
  }
});

test("Claude lines map to the internal runtime event shapes", () => {
  assert.deepEqual(claudeAdapter.events('{"type":"system","subtype":"init"}'), [
    { type: "stage_started" },
  ]);
  assert.deepEqual(claudeAdapter.events(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "assistant text" }] },
  })), [
    { type: "message_delta", text: "assistant text" },
  ]);
  assert.deepEqual(claudeAdapter.events(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "streamed text" } },
  })), [
    { type: "message_delta", text: "streamed text" },
  ]);
  assert.deepEqual(claudeAdapter.events(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
  })), [
    { type: "tool_call", name: "Bash", detail: '{"command":"npm test"}' },
  ]);
  assert.deepEqual(claudeAdapter.events(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", content: "command output\n" }] },
  })), [
    { type: "tool_result", name: "tool", output: "command output\n", failed: false },
  ]);
  assert.deepEqual(claudeAdapter.events(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", content: [{ type: "text", text: "nested output\n" }] }] },
  })), [
    { type: "tool_result", name: "tool", output: "nested output\n", failed: false },
  ]);
  assert.deepEqual(claudeAdapter.events(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", is_error: true, content: "command failed\n" }] },
  })), [
    { type: "tool_result", name: "tool", output: "command failed\n", failed: true },
  ]);
  assert.deepEqual(claudeAdapter.events(JSON.stringify({
    type: "stream_event",
    event: { type: "message_start" },
  })), [
    { type: "tool_call", name: "work", detail: "" },
  ]);
  assert.deepEqual(claudeAdapter.events(JSON.stringify({
    type: "tool_progress",
    tool_name: "Edit",
  })), [
    { type: "tool_call", name: "progress", detail: "Edit" },
  ]);
  assert.deepEqual(claudeAdapter.events('{"type":"tool_use_summary","summary":"private summary"}'), [
    { type: "tool_result", name: "summary", output: "" },
  ]);
  assert.deepEqual(claudeAdapter.events('{"type":"result","subtype":"success","result":"done"}'), [
    { type: "stage_finished" },
  ]);
  assert.deepEqual(claudeAdapter.events('{"type":"result","subtype":"error_during_execution","result":"provider failed"}'), [
    { type: "error", detail: "provider failed" },
  ]);
  assert.deepEqual(claudeAdapter.events("not-json"), []);
});

test("runtime registries provide stable lookup and default vendor order", () => {
  const registry = runtimeRegistry([claudeAdapter, codexAdapter]);
  assert.deepEqual(registry.ids(), ["claude", "codex"]);
  assert.equal(registry.get("claude"), claudeAdapter);
  assert.equal(registry.get("codex"), codexAdapter);
  assert.equal(registry.get("unknown"), null);

  const defaults = defaultRuntimeRegistry();
  assert.deepEqual(defaults.ids(), ["codex", "claude"]);
  assert.equal(defaults.get("codex"), codexAdapter);
  assert.equal(defaults.get("claude"), claudeAdapter);
});
