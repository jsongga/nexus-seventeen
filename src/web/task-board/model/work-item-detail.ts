import type { PipelineSummary, PlanRecordFields, PlanRevision } from '@shared/task-board-contract';
import type { ProjectWorkflow, TaskStatus, WorkflowNode, WorkflowPlan, WorkItemState } from '../types';

export type DetailedWorkflowPlan = WorkflowPlan & PlanRecordFields & Pick<PlanRevision, 'rejectedNote'>;

export interface WorkItemDetailAffordances {
  answerQuestion: boolean;
  confirmPlan: boolean;
  rejectPlan: boolean;
  cancel: boolean;
  archive: boolean;
}

export function deriveWorkItemDetailAffordances(input: {
  workItemState: WorkItemState;
  planningTaskState: TaskStatus | null;
  archived: boolean;
}): WorkItemDetailAffordances {
  if (input.archived) {
    return {
      answerQuestion: false,
      confirmPlan: false,
      rejectPlan: false,
      cancel: false,
      archive: false,
    };
  }

  if (input.workItemState === 'unrecognized') {
    return {
      answerQuestion: false,
      confirmPlan: false,
      rejectPlan: false,
      cancel: false,
      archive: false,
    };
  }

  const terminal = input.workItemState === 'merged'
    || input.workItemState === 'dead_letter'
    || input.workItemState === 'abandoned';
  if (terminal) {
    return {
      answerQuestion: false,
      confirmPlan: false,
      rejectPlan: false,
      cancel: false,
      archive: true,
    };
  }

  return {
    answerQuestion: input.workItemState === 'parked' && input.planningTaskState === 'waiting_for_human',
    confirmPlan: input.workItemState === 'plan_approval' && input.planningTaskState === 'completed',
    rejectPlan: input.workItemState === 'plan_approval' && input.planningTaskState === 'completed',
    cancel: true,
    archive: false,
  };
}

export function proposedPlanForWorkItem(workflow: ProjectWorkflow, workItemId: string): DetailedWorkflowPlan | null {
  return (workflow.plans as DetailedWorkflowPlan[])
    .filter((plan) => plan.workItemId === workItemId && plan.state === 'proposed')
    .sort((left, right) => right.revision - left.revision)[0] ?? null;
}

export function nodesForPlan(workflow: ProjectWorkflow, planRevisionId: string): WorkflowNode[] {
  return workflow.nodes.filter((node) => node.planRevisionId === planRevisionId);
}

export function pipelineFileReview(summary: PipelineSummary): Array<Readonly<{
  file: string;
  outsideScope: boolean;
}>> {
  const scope = summary.declaredScope.map((prefix) => prefix.replace(/\/+$/u, ''));
  return summary.filesTouched.map((file) => ({
    file,
    outsideScope: !scope.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)),
  }));
}

export function pipelineAssumptionReview(summary: PipelineSummary): Array<Readonly<{
  assumption: string;
  addedMidRun: boolean;
}>> {
  return [
    ...summary.assumptions.map((assumption) => ({ assumption, addedMidRun: false })),
    ...summary.midRunAssumptions.map((assumption) => ({ assumption, addedMidRun: true })),
  ];
}
