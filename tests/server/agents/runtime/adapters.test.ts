import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_ROLES } from "../../../../src/shared/task-board-contract/index.js";
import type { ProviderArgumentOptions } from "../../../../src/server/agents/task-worker/agent-envelope.js";
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

test("runtime adapters define bounded argv for every fixed agent role", () => {
  for (const options of OPTION_CASES) {
    for (const role of AGENT_ROLES) {
      const codex = codexAdapter.args(options, role);
      assert.deepEqual(codex.slice(0, 5), ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config"]);
      assert.equal(codex[codex.indexOf("--model") + 1], options.model);
      assert.equal(codex[codex.indexOf("--cd") + 1], options.workingDirectory);
      assert.equal(codex[codex.indexOf("--output-schema") + 1], options.schemaPath);
      assert.equal(codex[codex.indexOf("--sandbox") + 1], role === "engineer" ? "workspace-write" : "read-only");
      assert.ok(codex.includes(`sandbox_workspace_write.network_access=${options.proxyEgress === true ? "true" : "false"}`));
      assert.deepEqual(codex.slice(-2), [options.schemaPath, "-"]);

      const claude = claudeAdapter.args(options, role);
      assert.deepEqual(claude.slice(0, options.bareApiKey ? 2 : 1), options.bareApiKey ? ["--print", "--bare"] : ["--print"]);
      assert.equal(claude[claude.indexOf("--model") + 1], options.model);
      assert.equal(claude[claude.indexOf("--output-format") + 1], "stream-json");
      assert.equal(claude[claude.indexOf("--permission-mode") + 1], role === "engineer" ? "acceptEdits" : role === "verifier" ? "dontAsk" : "plan");
      assert.equal(claude[claude.indexOf("--tools") + 1], role === "engineer"
        ? "Read,Glob,Grep,Edit,Write,Bash"
        : role === "verifier" ? "Read,Glob,Grep,Bash" : "Read,Glob,Grep");
      const settings = JSON.parse(claude[claude.indexOf("--settings") + 1]!) as {
        sandbox: { filesystem: { allowRead: readonly string[]; allowWrite?: readonly string[]; denyWrite?: readonly string[] } };
      };
      assert.deepEqual(settings.sandbox.filesystem.allowRead, [options.workingDirectory]);
      assert.deepEqual(settings.sandbox.filesystem[role === "engineer" ? "allowWrite" : "denyWrite"], [options.workingDirectory]);
      assert.equal(claude.includes("--allowedTools"), role !== "manager");
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

  assert.deepEqual({ ...codexAdapter.environment(source) }, {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/agent",
    TMPDIR: "/tmp/runtime",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    SSL_CERT_FILE: "/etc/ssl/cert.pem",
    SSL_CERT_DIR: "/etc/ssl/certs",
    CODEX_HOME: "/home/agent/.codex",
    CODEX_API_KEY: "codex-key",
    OPENAI_API_KEY: "openai-key",
    OPENAI_ORGANIZATION: "org-one",
    OPENAI_PROJECT: "project-one",
  });
  assert.deepEqual({ ...claudeAdapter.environment(source) }, {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/agent",
    TMPDIR: "/tmp/runtime",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    SSL_CERT_FILE: "/etc/ssl/cert.pem",
    SSL_CERT_DIR: "/etc/ssl/certs",
    ANTHROPIC_API_KEY: "anthropic-key",
    CLAUDE_CONFIG_DIR: "/home/agent/.claude",
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    DISABLE_AUTOUPDATER: "1",
  });
});

test("runtime adapters parse successful terminal results and reject malformed or failed streams", () => {
  const structured = { status: "completed", result: "runtime parity" };
  assert.deepEqual(codexAdapter.result([
    JSON.stringify({ type: "thread.started", thread_id: "thread-one" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(structured) } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n")), structured);
  assert.deepEqual(claudeAdapter.result(JSON.stringify({
    type: "result", subtype: "success", is_error: false, structured_output: structured,
  })), structured);
  assert.deepEqual(claudeAdapter.result(JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: JSON.stringify(structured),
  })), structured);

  assert.throws(() => codexAdapter.result(JSON.stringify({ type: "turn.failed", error: { message: "failed" } })), /Codex reported a failed run/u);
  assert.throws(() => codexAdapter.result(JSON.stringify({ type: "error", message: "failed" })), /Codex reported a failed run/u);
  assert.throws(() => codexAdapter.result(JSON.stringify({ type: "turn.completed" })), /without a completed structured result/u);
  assert.throws(() => codexAdapter.result("not-json"), /Codex event was not valid JSON/u);
  assert.throws(() => claudeAdapter.result(JSON.stringify({ type: "result", subtype: "error_during_execution", result: "failed" })), /Claude reported a failed run/u);
  assert.throws(() => claudeAdapter.result(JSON.stringify({ type: "assistant", message: { content: [] } })), /without a terminal result event/u);
  assert.throws(() => claudeAdapter.result("not-json"), /Claude stream event was not valid JSON/u);
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
