import type { BoardWorkItem, WorkItemStage, WorkItemState } from '../types';

export type WorkItemTone = 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'purple';

export const workItemStateTone: Record<WorkItemState, WorkItemTone> = {
  submitted: 'blue',
  processing: 'green',
  needs_input: 'amber',
  waiting_for_human_review: 'amber',
  completed: 'green',
  failed: 'red',
  cancelled: 'neutral',
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
  if (workItem.state === 'submitted') return 'Submitted · Refinement pending';
  if (workItem.state === 'processing') {
    return workItem.currentStage ? `Processing · ${workItemStageLabel[workItem.currentStage]}` : 'Processing';
  }
  if (workItem.state === 'needs_input') return 'Needs input';
  if (workItem.state === 'waiting_for_human_review') return 'Waiting for human review';
  return prettyStatus(workItem.state);
}
