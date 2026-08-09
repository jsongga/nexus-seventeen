import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_ROLES,
  STAGE_HANDOFF_OUTCOMES,
  TASK_KINDS,
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  WAKEUP_REASONS,
  WORKFLOW_STAGES,
} from "#shared/task-board-contract";
import { phaseSignalFromProviderLine } from "#server/agents/task-worker/provider-activity";
import { parseAgentRunOutcome, parseBoundedAgentContext } from "#server/agents/task-worker/schema";
import { TASK_WAKE_REASONS } from "#server/agents/task-worker/types";
import { context } from "./helpers.js";

function assertAcceptedSet(
  expected: readonly string[],
  validate: (value: string) => unknown,
): void {
  const candidates = [...expected, "not_a_contract_member"];
  const accepted = candidates.filter((candidate) => {
    try {
      validate(candidate);
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(accepted, [...expected]);
}

test("worker context validators accept exactly the shared role, task, and phase enums", () => {
  assert.deepEqual([...TASK_WAKE_REASONS], [...WAKEUP_REASONS]);
  assertAcceptedSet(AGENT_ROLES, (requiredRole) => parseBoundedAgentContext(context({
    task: { ...context().task, requiredRole: requiredRole as never },
  })));
  assertAcceptedSet(TASK_KINDS, (kind) => parseBoundedAgentContext(context({
    task: { ...context().task, kind: kind as never },
  })));
  assertAcceptedSet(TASK_PHASE_STAGES, (stage) => parseBoundedAgentContext(context({
    task: {
      ...context().task,
      phases: [{
        phaseId: "phase-one",
        title: "Inspect",
        stage: stage as never,
        status: stage === "done" ? "completed" : "pending",
        parallelGroup: null,
        orderKey: 0,
        version: 1,
      }],
    },
  })));
  assertAcceptedSet(TASK_PHASE_STATUSES, (status) => parseBoundedAgentContext(context({
    task: {
      ...context().task,
      phases: [{
        phaseId: "phase-one",
        title: "Inspect",
        stage: "research",
        status: status as never,
        parallelGroup: null,
        orderKey: 0,
        version: 1,
      }],
    },
  })));
});

function outcome(handoff: unknown = null, workflowPlan: unknown = null): unknown {
  return {
    status: "completed",
    outputs: [{ type: "result", body: "Done." }],
    expectedAgentMinutes: null,
    phases: [],
    detail: "Done.",
    handoff,
    workflowPlan,
  };
}

test("worker result validators accept exactly the shared handoff and workflow enums", () => {
  assertAcceptedSet(STAGE_HANDOFF_OUTCOMES, (handoffOutcome) => parseAgentRunOutcome(outcome({
    outcome: handoffOutcome,
    summary: "Verified.",
    evidence: [],
    artifactIds: [],
    acceptanceCriteria: [],
    blockers: [],
    recommendedReturnStage: null,
  })));
  assertAcceptedSet(WORKFLOW_STAGES, (recommendedReturnStage) => parseAgentRunOutcome(outcome({
    outcome: "passed",
    summary: "Verified.",
    evidence: [],
    artifactIds: [],
    acceptanceCriteria: [],
    blockers: [],
    recommendedReturnStage,
  })));
  assertAcceptedSet(WORKFLOW_STAGES, (stage) => parseAgentRunOutcome(outcome(null, {
    objective: "Complete the work.",
    assumptions: [],
    acceptanceCriteria: ["The work is verified."],
    nodes: [{
      nodeId: "node-one",
      title: "Do the work",
      objective: "Complete and verify it.",
      acceptanceCriteria: ["The work is verified."],
      dependencyNodeIds: [],
      stageTemplate: stage === "verification" ? [stage] : [stage, "verification"],
    }],
  })));
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
