import assert from "node:assert/strict";
import test from "node:test";
import {
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  WAKEUP_REASONS,
} from "#shared/task-board-contract";
import { phaseSignalFromProviderLine } from "#server/agents/task-worker/provider-activity";
import { TASK_WAKE_REASONS } from "#server/agents/task-worker/types";

test("worker wake reasons mirror the shared contract", () => {
  assert.deepEqual([...TASK_WAKE_REASONS], [...WAKEUP_REASONS]);
});

function providerPhase(
  provider: "codex" | "claude",
  stage: string,
  status: string,
): ReturnType<typeof phaseSignalFromProviderLine> {
  const marker = `STEWARD_PHASE_JSON=${JSON.stringify({
    key: "phase-one",
    title: "Inspect",
    stage,
    status,
    parallelGroup: null,
  })}\n`;
  const line = provider === "codex"
    ? JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: marker } })
    : JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: [{ type: "text", text: marker }] }] },
      });
  return phaseSignalFromProviderLine(provider, line);
}

test("provider phase-signal extraction accepts exactly the shared phase enums", () => {
  for (const provider of ["codex", "claude"] as const) {
    const acceptedStages = [...TASK_PHASE_STAGES, "not_a_contract_member"].filter((stage) =>
      providerPhase(provider, stage, stage === "done" ? "completed" : "pending") !== null);
    assert.deepEqual(acceptedStages, [...TASK_PHASE_STAGES]);

    const acceptedStatuses = [...TASK_PHASE_STATUSES, "not_a_contract_member"].filter((status) =>
      providerPhase(provider, "research", status) !== null);
    assert.deepEqual(acceptedStatuses, [...TASK_PHASE_STATUSES]);
  }
});
