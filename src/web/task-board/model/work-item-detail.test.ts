import { describe, expect, it } from 'vitest';
import type { BoardWorkItem, TaskStatus, WorkItemState } from '../types';
import { deriveWorkItemDetailAffordances, nodesForPlan, proposedPlanForWorkItem } from './work-item-detail';
import {
  notificationKindLabel,
  parkCategoryLabel,
  workItemStateLabel,
  workItemStatusLabel,
} from './work-item-labels';

const workItemStates: readonly WorkItemState[] = [
  'queued',
  'planning',
  'plan_approval',
  'designing',
  'implementing',
  'verifying',
  'reviewing',
  'fixing',
  'final_approval',
  'merged',
  'parked',
  'abandoned',
  'dead_letter',
  'unrecognized',
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
  'cancelled',
  'unrecognized',
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
          const terminal = workItemState === 'merged' || workItemState === 'dead_letter' || workItemState === 'abandoned';
          const expected = archived
            ? noAffordances
            : workItemState === 'unrecognized'
              ? noAffordances
              : terminal
                ? { ...noAffordances, archive: true }
                : {
                    answerQuestion: workItemState === 'parked' && planningTaskState === 'waiting_for_human',
                    confirmPlan: workItemState === 'plan_approval' && planningTaskState === 'completed',
                    rejectPlan: workItemState === 'plan_approval' && planningTaskState === 'completed',
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
      workItemState: 'parked',
      planningTaskState: null,
      archived: false,
    })).toEqual({ ...noAffordances, cancel: true });
    expect(deriveWorkItemDetailAffordances({
      workItemState: 'plan_approval',
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
  it('labels every park category and notification kind, including scheduling additions', () => {
    expect(parkCategoryLabel).toEqual({
      open_question: 'Open question',
      planning_run_failed: 'Planning run failed',
      design_run_failed: 'Design run failed',
      hazardous_without_pipeline: 'Hazardous without pipeline',
      plan_rejected_twice: 'Plan rejected twice',
      bright_line: 'Bright line',
      scope_violation: 'Scope violation',
      stage_cap_exceeded: 'Stage cap exceeded',
      task_cap_exceeded: 'Task cap exceeded',
      base_diverged: 'Base diverged',
      unrecognized: 'Unknown category',
    });
    expect(notificationKindLabel).toEqual({
      park_aged: 'Park aged',
      park_auto_abandoned: 'Park auto-abandoned',
      cap_parked: 'Cap parked',
      final_approval_withdrawn: 'Final approval withdrawn',
      unrecognized: 'Unknown notification',
    });
  });

  it('uses the exhaustive campaign vocabulary in list rows and the detail pane', () => {
    const expected = {
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
      unrecognized: 'Unknown state — refresh the app',
    } satisfies Record<WorkItemState | 'unrecognized', string>;

    expect(workItemStateLabel).toEqual(expected);
    for (const state of workItemStates) {
      expect(workItemStatusLabel({ state } as BoardWorkItem)).toBe(expected[state]);
    }
  });
});
