import { describe, expect, it } from 'vitest';
import {
  createTaskDetailDraftState,
  taskDetailDraftReducer,
} from './task-detail-drafts';

describe('task detail draft state', () => {
  it('preserves both operator drafts while the same task receives new snapshots', () => {
    let state = createTaskDetailDraftState('task-one');
    state = taskDetailDraftReducer(state, { type: 'answer-changed', value: 'Still typing an answer' });
    state = taskDetailDraftReducer(state, { type: 'rationale-changed', value: 'Release evidence' });

    expect(taskDetailDraftReducer(state, { type: 'task-synced', taskId: 'task-one' })).toEqual(state);
  });

  it('clears both drafts only when the task id changes', () => {
    let state = createTaskDetailDraftState('task-one');
    state = taskDetailDraftReducer(state, { type: 'answer-changed', value: 'Old answer' });
    state = taskDetailDraftReducer(state, { type: 'rationale-changed', value: 'Old rationale' });

    expect(taskDetailDraftReducer(state, { type: 'task-synced', taskId: 'task-two' })).toEqual({
      taskId: 'task-two',
      answer: '',
      decisionRationale: '',
    });
  });
});
