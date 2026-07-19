import assert from "node:assert/strict";
import test from "node:test";
import {
  ActivityBuffer,
  activityFromClaudeStreamLine,
  activityFromCodexJsonLine,
  activityFromProviderLine,
  sanitizeActivity,
} from "../src/provider-activity.js";

test("maps Codex lifecycle and development events without copying provider payloads", () => {
  assert.equal(activityFromCodexJsonLine('{"type":"thread.started","thread_id":"secret-thread"}'), "Agent process started.");
  assert.equal(activityFromCodexJsonLine('{"type":"turn.started","prompt":"do not expose this prompt"}'), "Work started.");
  assert.equal(
    activityFromCodexJsonLine(JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "cat /Users/alice/private.txt", aggregated_output: "sk-proj-super-secret-token" },
    })),
    "Running a development check.",
  );
  assert.equal(
    activityFromCodexJsonLine(JSON.stringify({
      type: "item.completed",
      item: { type: "file_change", changes: [{ path: "/Users/alice/repo/secret.ts", diff: "private source" }] },
    })),
    "Updated the implementation.",
  );
  assert.equal(activityFromCodexJsonLine('{"type":"turn.completed","usage":{"input_tokens":100}}'), "Work finished; preparing the recorded result.");
});

test("reports Codex check failures but ignores reasoning and agent-message text", () => {
  assert.equal(
    activityFromCodexJsonLine('{"type":"item.completed","item":{"type":"command_execution","exit_code":1,"aggregated_output":"full failing output"}}'),
    "A development check found more work.",
  );
  assert.equal(
    activityFromCodexJsonLine('{"type":"item.completed","item":{"type":"reasoning","text":"private chain of thought"}}'),
    null,
  );
  assert.equal(
    activityFromCodexJsonLine('{"type":"item.completed","item":{"type":"agent_message","text":"raw final answer"}}'),
    null,
  );
  assert.equal(activityFromCodexJsonLine("not-json"), null);
});

test("maps Claude stream-json tool activity without exposing tool inputs", () => {
  assert.equal(activityFromClaudeStreamLine('{"type":"system","subtype":"init","cwd":"/Users/alice/repo"}'), "Agent process started.");
  assert.equal(
    activityFromClaudeStreamLine(JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Read", input: { file_path: "/Users/alice/private.ts" } },
      },
    })),
    "Inspecting the relevant code and context.",
  );
  assert.equal(
    activityFromClaudeStreamLine(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "printenv OPENAI_API_KEY" } }] },
    })),
    "Running a development check.",
  );
});

test("ignores Claude text and thinking while reporting safe completion states", () => {
  assert.equal(
    activityFromClaudeStreamLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"private reasoning"}}}'),
    null,
  );
  assert.equal(
    activityFromClaudeStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"raw assistant response"}]}}'),
    null,
  );
  assert.equal(
    activityFromClaudeStreamLine('{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"raw command output"}]}}'),
    "A development step found more work.",
  );
  assert.equal(
    activityFromClaudeStreamLine('{"type":"result","subtype":"success","result":"raw final result"}'),
    "Work finished; preparing the recorded result.",
  );
  assert.equal(
    activityFromClaudeStreamLine('{"type":"result","subtype":"error_during_execution","result":"sensitive error"}'),
    "The run encountered a problem and needs attention.",
  );
});

test("dispatches lines through the selected provider parser", () => {
  assert.equal(activityFromProviderLine("codex", '{"type":"item.started","item":{"type":"web_search","query":"private"}}'), "Researching relevant information.");
  assert.equal(activityFromProviderLine("claude", '{"type":"tool_progress","tool_name":"Edit","input":{"path":"/tmp/private"}}'), "Updating the implementation.");
});

test("activity sanitizer removes likely credentials, links, and local paths and enforces a bound", () => {
  const safe = sanitizeActivity(
    "Checking /Users/alice/private/repo with sk-proj-abcdefghijklmnopqrstuvwxyz at https://internal.example/path " + "x".repeat(200),
    96,
  );
  assert.ok(safe);
  assert.ok(safe.length <= 96);
  assert.doesNotMatch(safe, /alice|sk-proj|internal\.example/u);
  assert.match(safe, /\[local path\]|\[credential redacted\]|\[link redacted\]/u);
});

test("activity buffer deduplicates and holds only the latest rate-limited update", () => {
  const buffer = new ActivityBuffer({ minimumIntervalMs: 1_000, dedupeWindowMs: 10_000 });
  assert.equal(buffer.push("Work started.", 1_000), "Work started.");
  assert.equal(buffer.push("Work started.", 1_100), null);
  assert.equal(buffer.push("Inspecting the relevant code and context.", 1_200), null);
  assert.equal(buffer.push("Updating the implementation.", 1_300), null);
  assert.equal(buffer.hasPending, true);
  assert.equal(buffer.flush(1_999), null);
  assert.equal(buffer.flush(2_000), "Updating the implementation.");
  assert.equal(buffer.hasPending, false);
  assert.equal(buffer.push("Work started.", 2_100), null);
});

test("activity buffer emits a pending update before holding a new update", () => {
  const buffer = new ActivityBuffer({ minimumIntervalMs: 100, dedupeWindowMs: 0 });
  assert.equal(buffer.push("First.", 0), "First.");
  assert.equal(buffer.push("Second.", 10), null);
  assert.equal(buffer.push("Third.", 100), "Second.");
  assert.equal(buffer.flush(200), "Third.");
  assert.throws(() => buffer.flush(199), /moved backwards/u);
});

test("activity buffer drains its latest update when a short provider stream ends", () => {
  const buffer = new ActivityBuffer({ minimumIntervalMs: 1_500, dedupeWindowMs: 30_000 });
  assert.equal(buffer.push("Agent process started.", 1_000), "Agent process started.");
  assert.equal(buffer.push("Running a development check.", 1_050), null);
  assert.equal(buffer.push("Work finished; preparing the recorded result.", 1_100), null);
  assert.equal(buffer.drain(1_101), "Work finished; preparing the recorded result.");
  assert.equal(buffer.hasPending, false);
  assert.equal(buffer.drain(1_102), null);
});
