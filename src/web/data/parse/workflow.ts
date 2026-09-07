/** Projects a project's workflow, its plan graph, and the board snapshot around it. */

/* —— Imports —— */

import type { BoardSnapshot, PipelineSummary, PlanRecordFields, PlanRevision } from "@shared/task-board-contract";
import {
  parseBoardSnapshotEntity,
  parseHandoffEntity,
  parseNodeEntity,
  parsePlanEntity,
  parsePipelineSummaryEntity,
  parseProjectArtifactEntity,
  parseProjectEventEntity,
  record as contractRecord,
} from "@shared/task-board-contract/validate";
import type {
  ProjectArtifact,
  ProjectWorkflow,
  WorkflowEvent,
  WorkflowHandoff,
  WorkflowNode,
  WorkflowPlan,
} from "../../types";
import {
  projectAgent,
  projectEvent,
  projectInterrupt,
  projectProject,
  projectQuestion,
  projectRun,
  projectTask,
} from "./entities";
import { array, loose, ms, nullableMs, record } from "./scalars";
import { type RawBoard } from "./types";

/* —— Workflow and board —— */

function parseWorkflowPlan(
  value: unknown,
  path: string
): WorkflowPlan & PlanRecordFields & Pick<PlanRevision, "rejectedNote"> {
  const item = parsePlanEntity(value, path, loose);
  return {
    planRevisionId: item.planRevisionId,
    workItemId: item.workItemId,
    revision: item.revision,
    objective: item.objective,
    assumptions: [...item.assumptions],
    acceptanceCriteria: [...item.acceptanceCriteria],
    children:
      item.children === null
        ? null
        : item.children.map((child) => ({
            ...child,
            declaredScope: [...child.declaredScope],
            acceptanceCriteria: [...child.acceptanceCriteria],
            ...(child.dependsOn === undefined ? {} : { dependsOn: [...child.dependsOn] }),
          })),
    ...(item.changeShape === undefined ? {} : { changeShape: item.changeShape }),
    ...(item.tier === undefined ? {} : { tier: item.tier }),
    ...(item.declaredScope === undefined ? {} : { declaredScope: [...item.declaredScope] }),
    ...(item.nonGoals === undefined ? {} : { nonGoals: [...item.nonGoals] }),
    ...(item.mechanicalPortions === undefined ? {} : { mechanicalPortions: [...item.mechanicalPortions] }),
    ...(item.blockingQuestions === undefined
      ? {}
      : {
          blockingQuestions: item.blockingQuestions.map((question) => ({ ...question })),
        }),
    ...(item.criterionChecks === undefined
      ? {}
      : {
          criterionChecks: item.criterionChecks.map((criterion) => ({ ...criterion })),
        }),
    state: item.state,
    createdAt: item.createdAt,
    createdAtMs: ms(item.createdAt),
    confirmedAt: item.confirmedAt,
    confirmedAtMs: nullableMs(item.confirmedAt),
    ...(item.rejectedNote === undefined ? {} : { rejectedNote: item.rejectedNote }),
  };
}

function parseWorkflowNode(value: unknown, path: string): WorkflowNode {
  const item = parseNodeEntity(value, path, loose);
  return {
    nodeId: item.nodeId,
    planRevisionId: item.planRevisionId,
    title: item.title,
    objective: item.objective,
    acceptanceCriteria: [...item.acceptanceCriteria],
    dependencyNodeIds: [...item.dependencyNodeIds],
    stageTemplate: [...item.stageTemplate],
    currentStage: item.currentStage,
    state: item.state,
    createdAt: item.createdAt,
    createdAtMs: ms(item.createdAt),
    updatedAt: item.updatedAt,
    updatedAtMs: ms(item.updatedAt),
  };
}

function parseWorkflowHandoff(value: unknown, path: string): WorkflowHandoff {
  const item = parseHandoffEntity(value, path, loose);
  return {
    handoffId: item.handoffId,
    nodeId: item.nodeId,
    taskId: item.taskId,
    stage: item.stage,
    outcome: item.outcome,
    summary: item.summary,
    evidence: [...item.evidence],
    artifactIds: [...item.artifactIds],
    blockers: [...item.blockers],
    createdAt: item.createdAt,
    createdAtMs: ms(item.createdAt),
  };
}

export function parseWorkflowEvent(value: unknown, path: string): WorkflowEvent {
  const item = parseProjectEventEntity(value, path, loose);
  return {
    sequence: item.sequence,
    eventId: item.eventId,
    nodeId: item.nodeId,
    taskId: item.taskId,
    eventType: item.eventType,
    summary: item.summary,
    createdAt: item.createdAt,
    createdAtMs: ms(item.createdAt),
  };
}

export function parseProjectWorkflow(value: unknown, path: string): ProjectWorkflow {
  const item = record(value, path);
  return {
    plans: array(item.plans, `${path}.plans`, parseWorkflowPlan),
    nodes: array(item.nodes, `${path}.nodes`, parseWorkflowNode),
    handoffs: array(item.handoffs, `${path}.handoffs`, parseWorkflowHandoff),
    events: array(item.events, `${path}.events`, parseWorkflowEvent),
  };
}

export function parsePipelineSummary(value: unknown, path: string): PipelineSummary {
  const item = contractRecord(value, path);
  return parsePipelineSummaryEntity(
    {
      ...item,
      ...(item.findings === undefined ? { findings: [] } : {}),
      ...(item.designRecord === undefined ? { designRecord: null } : {}),
    },
    path,
    loose
  );
}

export function parseProjectArtifact(value: unknown, path: string): ProjectArtifact {
  const item = parseProjectArtifactEntity(value, path, loose);
  return {
    artifactId: item.artifactId,
    nodeId: item.nodeId,
    taskId: item.taskId,
    mediaType: item.mediaType,
    byteSize: item.byteSize,
    caption: item.caption,
    createdAt: item.createdAt,
    createdAtMs: ms(item.createdAt),
  };
}

export function parseRawBoard(value: unknown): RawBoard {
  const item: BoardSnapshot = parseBoardSnapshotEntity(value, loose);
  const open = item.openQuestions.map(projectQuestion);
  const recent = item.recentQuestions.map(projectQuestion);
  const questions = new Map(recent.map((question) => [question.questionId, question]));
  for (const question of open) questions.set(question.questionId, question);
  return {
    project: projectProject(item.project),
    agents: item.agents.map(projectAgent),
    tasks: item.tasks.map(projectTask),
    questions: [...questions.values()],
    runs: item.recentRuns.map(projectRun),
    interrupts: item.recentInterrupts.map(projectInterrupt),
    events: item.recentEvents.map(projectEvent),
  };
}
