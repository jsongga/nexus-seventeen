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

export function proposedPlanForWorkItem(workflow: ProjectWorkflow, workItemId: string): WorkflowPlan | null {
  return workflow.plans
    .filter((plan) => plan.workItemId === workItemId && plan.state === 'proposed')
    .sort((left, right) => right.revision - left.revision)[0] ?? null;
}

export function nodesForPlan(workflow: ProjectWorkflow, planRevisionId: string): WorkflowNode[] {
  return workflow.nodes.filter((node) => node.planRevisionId === planRevisionId);
}
