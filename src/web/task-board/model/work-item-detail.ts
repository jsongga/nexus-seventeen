import type { ProjectWorkflow, TaskStatus, WorkflowNode, WorkflowPlan, WorkItemState } from '../types';

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

  const terminal = input.workItemState === 'completed'
    || input.workItemState === 'failed'
    || input.workItemState === 'cancelled';
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
    answerQuestion: input.workItemState === 'needs_input' && input.planningTaskState === 'waiting_for_human',
    confirmPlan: input.workItemState === 'waiting_for_human_review' && input.planningTaskState === 'completed',
    rejectPlan: input.workItemState === 'waiting_for_human_review' && input.planningTaskState === 'completed',
    cancel: true,
    archive: false,
  };
}

export function proposedPlanForWorkItem(workflow: ProjectWorkflow, workItemId: string): WorkflowPlan | null {
  return workflow.plans
    .filter((plan) => plan.workItemId === workItemId && plan.state === 'proposed')
    .sort((left, right) => right.revision - left.revision)[0] ?? null;
}

export function nodesForPlan(workflow: ProjectWorkflow, planRevisionId: string): WorkflowNode[] {
  return workflow.nodes.filter((node) => node.planRevisionId === planRevisionId);
}
