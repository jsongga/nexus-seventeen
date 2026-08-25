import assert from "node:assert/strict";
import test from "node:test";
import {
  activityFromProviderLine,
  estimateMinutesFromProviderLine,
  phaseSignalFromProviderLine,
  type ActivityProvider,
} from "../../../../src/server/agents/task-worker/provider-activity.js";
import { claudeAdapter } from "../../../../src/server/agents/runtime/claude.js";
import { codexAdapter } from "../../../../src/server/agents/runtime/codex.js";
import {
  activityFromEvent,
  estimateMinutesFromEvent,
  phaseSignalFromEvent,
} from "../../../../src/server/agents/runtime/derive.js";
import type { RuntimeEvent } from "../../../../src/server/agents/runtime/events.js";

const phase = {
  key: "api",
  title: "Implement API",
  stage: "execution",
  status: "in_progress",
  parallelGroup: "delivery",
} as const;
const phaseMarker = `STEWARD_PHASE_JSON=${JSON.stringify(phase)}\n`;

// These are the complete provider-line fixtures from provider-activity.test.ts.
const LEGACY_FIXTURE_LINES: Readonly<Record<ActivityProvider, readonly string[]>> = {
  codex: [
    '{"type":"thread.started","thread_id":"secret-thread"}',
    '{"type":"turn.started","prompt":"do not expose this prompt"}',
    JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "cat /Users/alice/private.txt", aggregated_output: "sk-proj-super-secret-token" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "file_change", changes: [{ path: "/Users/alice/repo/secret.ts", diff: "private source" }] },
    }),
    '{"type":"turn.completed","usage":{"input_tokens":100}}',
    '{"type":"item.completed","item":{"type":"command_execution","exit_code":1,"aggregated_output":"full failing output"}}',
    '{"type":"item.completed","item":{"type":"reasoning","text":"private chain of thought"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"raw final answer"}}',
    "not-json",
    '{"type":"item.started","item":{"type":"web_search","query":"private"}}',
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", exit_code: 0, aggregated_output: "STEWARD_ESTIMATE_MINUTES=45\n" } }),
    JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "printf STEWARD_ESTIMATE_MINUTES=45" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", aggregated_output: "STEWARD_ESTIMATE_MINUTES=17\n" },
    }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", exit_code: 0, aggregated_output: phaseMarker } }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", aggregated_output: phaseMarker.replace("in_progress", "completed") },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", aggregated_output: phaseMarker.replace("execution", "done") },
    }),
  ],
  claude: [
    '{"type":"system","subtype":"init","cwd":"/Users/alice/repo"}',
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Read", input: { file_path: "/Users/alice/private.ts" } },
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "printenv OPENAI_API_KEY" } }] },
    }),
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"private reasoning"}}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"raw assistant response"}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"raw command output"}]}}',
    '{"type":"result","subtype":"success","result":"raw final result"}',
    '{"type":"result","subtype":"error_during_execution","result":"sensitive error"}',
    '{"type":"tool_progress","tool_name":"Edit","input":{"path":"/tmp/private"}}',
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "STEWARD_ESTIMATE_MINUTES=90\n" }] },
    }),
  ],
};

const COVERAGE_LINES: Readonly<Record<ActivityProvider, readonly string[]>> = {
  codex: [
    ...(["reasoning", "todo_list", "plan", "file_change", "web_search", "mcp_tool_call", "tool_call", "collaboration_tool_call"] as const)
      .flatMap((itemType) => [
        JSON.stringify({ type: "item.started", item: { type: itemType } }),
        JSON.stringify({ type: "item.completed", item: { type: itemType } }),
      ]),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", exit_code: 0, aggregated_output: "plain command output\n" } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", exit_code: 0, aggregated_output: "STEWARD_ESTIMATE_MINUTES=7\n" } }),
    JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", status: "failed" } }),
    '{"type":"turn.failed","error":{"message":"turn failed"}}',
    '{"type":"error","message":"provider failed"}',
  ],
  claude: [
    '{"type":"stream_event","event":{"type":"message_start"}}',
    ...["Glob", "Edit", "WebFetch", "TodoWrite", "Task", "Skill", "AskUserQuestion", "UnknownTool"].map((name) => JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name, input: {} }] },
    })),
    '{"type":"tool_use_summary","summary":"private summary"}',
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "plain command output\n" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "STEWARD_ESTIMATE_MINUTES=7\n" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "STEWARD_ESTIMATE_MINUTES=45\n" }] } }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: [{ type: "text", text: phaseMarker }] }] },
    }),
    "not-json",
  ],
};

function firstDerived<Value>(events: readonly RuntimeEvent[], derive: (event: RuntimeEvent) => Value | null): Value | null {
  return events.map(derive).find((value) => value !== null) ?? null;
}

test("normalized runtime events preserve per-line activity, estimate, and phase derivation", () => {
  for (const provider of ["codex", "claude"] as const) {
    const adapter = provider === "codex" ? codexAdapter : claudeAdapter;
    for (const line of [...LEGACY_FIXTURE_LINES[provider], ...COVERAGE_LINES[provider]]) {
      const events = adapter.events(line);
      assert.equal(
        firstDerived(events, activityFromEvent),
        activityFromProviderLine(provider, line),
        `${provider} activity: ${line}`,
      );
      assert.equal(
        firstDerived(events, estimateMinutesFromEvent),
        estimateMinutesFromProviderLine(provider, line),
        `${provider} estimate: ${line}`,
      );
      assert.deepEqual(
        firstDerived(events, phaseSignalFromEvent),
        phaseSignalFromProviderLine(provider, line),
        `${provider} phase: ${line}`,
      );
    }
  }
});

test("flattened Claude tool-result blocks use the last valid marker", () => {
  const first = { ...phase, key: "first", title: "First marker" };
  const last = { ...phase, key: "last", title: "Last marker", status: "completed" as const };
  const line = JSON.stringify({
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        content: [
          { type: "text", text: `STEWARD_PHASE_JSON=${JSON.stringify(first)}\n` },
          { type: "text", text: `STEWARD_PHASE_JSON=${JSON.stringify(last)}\n` },
        ],
      }],
    },
  });

  assert.deepEqual(firstDerived(claudeAdapter.events(line), phaseSignalFromEvent), last);
  assert.deepEqual(phaseSignalFromProviderLine("claude", line), first, "legacy parser keeps the first block marker");
});

test("event derivation recognizes only bounded markers in tool results", () => {
  assert.equal(estimateMinutesFromEvent({ type: "tool_result", name: "command", output: "STEWARD_ESTIMATE_MINUTES=7\n" }), null);
  assert.equal(estimateMinutesFromEvent({ type: "tool_result", name: "command", output: "STEWARD_ESTIMATE_MINUTES=45\n" }), 45);
  assert.equal(estimateMinutesFromEvent({ type: "message_delta", text: "STEWARD_ESTIMATE_MINUTES=45\n" }), null);
  assert.deepEqual(phaseSignalFromEvent({ type: "tool_result", name: "tool", output: phaseMarker }), phase);
  assert.equal(phaseSignalFromEvent({ type: "message_delta", text: phaseMarker }), null);
});

test("event activity derivation does not expose provider transcript text", () => {
  assert.equal(activityFromEvent({ type: "stage_started" }), "Agent process started.");
  assert.equal(activityFromEvent({ type: "message_delta", text: "private assistant transcript" }), null);
  assert.equal(activityFromEvent({ type: "tool_call", name: "work", detail: "" }), "Work started.");
  assert.equal(activityFromEvent({ type: "tool_call", name: "reasoning", detail: "" }), "Reviewing the task and choosing the next safe step.");
  assert.equal(activityFromEvent({ type: "tool_call", name: "Read", detail: "/Users/alice/private.ts" }), "Inspecting the relevant code and context.");
  assert.equal(activityFromEvent({ type: "tool_result", name: "command", output: "plain output" }), "A development check completed.");
  assert.equal(activityFromEvent({ type: "tool_result", name: "command", output: "plain output", failed: true }), "A development check found more work.");
  assert.equal(activityFromEvent({ type: "tool_result", name: "tool", output: "plain output" }), "A development step completed.");
  assert.equal(activityFromEvent({ type: "tool_result", name: "tool", output: "plain output", failed: true }), "A development step found more work.");
  assert.equal(activityFromEvent({ type: "stage_finished" }), "Work finished; preparing the recorded result.");
  assert.equal(activityFromEvent({ type: "error", detail: "private provider failure" }), "The run encountered a problem and needs attention.");
});
