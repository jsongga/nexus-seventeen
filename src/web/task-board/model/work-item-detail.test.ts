import { describe, expect, it } from 'vitest';
import type { BoardWorkItem, TaskStatus, WorkItemState } from '../types';
import { deriveWorkItemDetailAffordances, nodesForPlan, proposedPlanForWorkItem } from './work-item-detail';
import { workItemStatusLabel } from './work-item-labels';

const workItemStates: readonly WorkItemState[] = [
  'submitted',
  'processing',
  'needs_input',
  'waiting_for_human_review',
  'completed',
  'failed',
  'cancelled',
];

const planningTaskStates: readonly (TaskStatus | null)[] = [
  null,
  'proposed',
  'backlog',
  'queued',
  'running',
  'waiting_for_human',
  'blocked',
  'completed',
  'failed',
  'interrupted',
];

const noAffordances = {
  answerQuestion: false,
  confirmPlan: false,
  rejectPlan: false,
  cancel: false,
  archive: false,
};

describe('deriveWorkItemDetailAffordances', () => {
  it('derives every action for every work-item, planning-task, and archive combination', () => {
    for (const workItemState of workItemStates) {
      for (const planningTaskState of planningTaskStates) {
        for (const archived of [false, true]) {
          const terminal = workItemState === 'completed' || workItemState === 'failed' || workItemState === 'cancelled';
          const expected = archived
            ? noAffordances
            : terminal
              ? { ...noAffordances, archive: true }
              : {
                  answerQuestion: workItemState === 'needs_input' && planningTaskState === 'waiting_for_human',
                  confirmPlan: workItemState === 'waiting_for_human_review' && planningTaskState === 'completed',
                  rejectPlan: workItemState === 'waiting_for_human_review' && planningTaskState === 'completed',
                  cancel: true,
                  archive: false,
                };

          expect(
            deriveWorkItemDetailAffordances({
              workItemState,
              planningTaskState,
              archived,
            }),
            `${workItemState}/${planningTaskState ?? 'missing'}/${archived ? 'archived' : 'visible'}`,
          ).toEqual(expected);
        }
      }
    }
  });

  it('does not infer answer or review actions from the work-item state alone', () => {
    expect(deriveWorkItemDetailAffordances({
      workItemState: 'needs_input',
      planningTaskState: null,
      archived: false,
    })).toEqual({ ...noAffordances, cancel: true });
    expect(deriveWorkItemDetailAffordances({
      workItemState: 'waiting_for_human_review',
      planningTaskState: 'running',
      archived: false,
    })).toEqual({ ...noAffordances, cancel: true });
  });
});

describe('work-item workflow selection', () => {
  it('selects only the latest proposed revision and its nodes for the opened work item', () => {
    const workflow = {
      plans: [
        { planRevisionId: 'old', workItemId: 'opened', revision: 1, state: 'superseded' },
        { planRevisionId: 'other', workItemId: 'another', revision: 4, state: 'proposed' },
        { planRevisionId: 'latest', workItemId: 'opened', revision: 3, state: 'proposed' },
        { planRevisionId: 'earlier', workItemId: 'opened', revision: 2, state: 'proposed' },
      ],
      nodes: [
        { nodeId: 'latest-node', planRevisionId: 'latest' },
        { nodeId: 'other-node', planRevisionId: 'other' },
      ],
      handoffs: [],
      events: [],
    } as never;

    expect(proposedPlanForWorkItem(workflow, 'opened')?.planRevisionId).toBe('latest');
    expect(nodesForPlan(workflow, 'latest').map((node) => node.nodeId)).toEqual(['latest-node']);
  });
});

describe('work-item labels', () => {
  it('uses one human-review stage label in list rows and the detail pane', () => {
    expect(workItemStatusLabel({
      state: 'processing',
      currentStage: 'human_review',
    } as BoardWorkItem)).toBe('Processing · Preparing human review');
  });
});
