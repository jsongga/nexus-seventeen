import type { BoardWorkItem, TaskStatus, WorkItemStage, WorkItemState } from '../types';

export type WorkItemTone = 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'purple';
export const unknownStateLabel = 'Unknown state — refresh the app';

export const workItemStateTone: Record<WorkItemState, WorkItemTone> = {
  queued: 'blue',
  planning: 'green',
  plan_approval: 'amber',
  designing: 'green',
  implementing: 'green',
  verifying: 'green',
  reviewing: 'green',
  fixing: 'amber',
  final_approval: 'amber',
  merged: 'green',
  parked: 'amber',
  abandoned: 'neutral',
  dead_letter: 'red',
  unrecognized: 'neutral',
};

export const workItemStateLabel: Record<WorkItemState | 'unrecognized', string> = {
  queued: 'Queued',
  planning: 'Planning',
  plan_approval: 'Plan review',
  designing: 'Design',
  implementing: 'Implementing',
  verifying: 'Verifying',
  reviewing: 'Reviewing',
  fixing: 'Fixing',
  final_approval: 'Final review',
  merged: 'Done',
  parked: 'Parked',
  abandoned: 'Cancelled',
  dead_letter: 'Failed',
  unrecognized: unknownStateLabel,
};

export const taskStatusTone: Record<TaskStatus, WorkItemTone> = {
  proposed: 'purple',
  backlog: 'neutral',
  queued: 'blue',
  running: 'green',
  waiting_for_human: 'amber',
  blocked: 'amber',
  completed: 'green',
  failed: 'red',
  interrupted: 'red',
  cancelled: 'neutral',
  unrecognized: 'neutral',
};

export const workItemStageLabel: Record<WorkItemStage, string> = {
  refinement: 'Improving task',
  project_resolution: 'Resolving project',
  research: 'Researching',
  planning: 'Planning',
  implementation: 'Implementing',
  testing: 'Testing',
  verification: 'Verifying',
  human_review: 'Preparing human review',
  deployment: 'Deploying',
};

export function prettyStatus(value: string): string {
  return value.replaceAll('_', ' ');
}

export function workItemStatusLabel(workItem: BoardWorkItem): string {
  return workItemStateLabel[workItem.state];
}
