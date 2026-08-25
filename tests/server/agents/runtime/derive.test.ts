import assert from "node:assert/strict";
import test from "node:test";
import { claudeAdapter } from "../../../../src/server/agents/runtime/claude.js";
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

function firstDerived<Value>(events: readonly RuntimeEvent[], derive: (event: RuntimeEvent) => Value | null): Value | null {
  return events.map(derive).find((value) => value !== null) ?? null;
}

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
  assert.equal(activityFromEvent({ type: "tool_call", name: "container_starting", detail: "" }), "Task container starting");
  assert.equal(activityFromEvent({ type: "tool_call", name: "container_attached", detail: "" }), "Task container attached");
  assert.equal(activityFromEvent({ type: "tool_call", name: "container_teardown", detail: "" }), "Task container teardown");
  assert.equal(activityFromEvent({ type: "tool_result", name: "command", output: "plain output" }), "A development check completed.");
  assert.equal(activityFromEvent({ type: "tool_result", name: "command", output: "plain output", failed: true }), "A development check found more work.");
  assert.equal(activityFromEvent({ type: "tool_result", name: "tool", output: "plain output" }), "A development step completed.");
  assert.equal(activityFromEvent({ type: "tool_result", name: "tool", output: "plain output", failed: true }), "A development step found more work.");
  assert.equal(activityFromEvent({ type: "stage_finished" }), "Work finished; preparing the recorded result.");
  assert.equal(activityFromEvent({ type: "error", detail: "private provider failure" }), "The run encountered a problem and needs attention.");
});
