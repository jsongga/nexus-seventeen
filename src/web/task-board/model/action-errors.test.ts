import { describe, expect, it } from 'vitest';
import { BoardApiError } from '../data/client';
import {
  actionErrorContexts,
  actionErrorMessage,
  actionErrorReducer,
  errorPipelineReducer,
  initialErrorPipelineState,
  isDialogAnchoredActionContext,
  newestActionErrors,
} from './action-errors';

describe('action error lifecycle', () => {
  it('sets, dismisses, and replaces an error only when the same action retries', () => {
    const assigned = actionErrorReducer([], {
      type: 'failed',
      context: 'task:one:assign',
      error: 'The task changed.',
    });
    const withAnswerError = actionErrorReducer(assigned, {
      type: 'failed',
      context: 'question:two:answer',
      error: 'The answer was rejected.',
    });

    expect(withAnswerError).toEqual([
      { context: 'task:one:assign', error: 'The task changed.' },
      { context: 'question:two:answer', error: 'The answer was rejected.' },
    ]);

    const assigningAgain = actionErrorReducer(withAnswerError, {
      type: 'started',
      context: 'task:one:assign',
    });
    expect(assigningAgain).toEqual([
      { context: 'question:two:answer', error: 'The answer was rejected.' },
    ]);

    const replacedAssignmentError = actionErrorReducer(assigningAgain, {
      type: 'failed',
      context: 'task:one:assign',
      error: 'Choose another agent.',
    });
    expect(replacedAssignmentError).toEqual([
      { context: 'question:two:answer', error: 'The answer was rejected.' },
      { context: 'task:one:assign', error: 'Choose another agent.' },
    ]);

    expect(actionErrorReducer(replacedAssignmentError, {
      type: 'dismissed',
      context: 'question:two:answer',
    })).toEqual([
      { context: 'task:one:assign', error: 'Choose another agent.' },
    ]);
  });

  it('keeps action failures unchanged across failed and successful poll transitions', () => {
    const failedAction = errorPipelineReducer(initialErrorPipelineState, {
      type: 'action-failed',
      context: 'task:one:assign',
      error: 'The task changed.',
    });
    const pollFailed = errorPipelineReducer(failedAction, { type: 'snapshot-failed' });
    const pollRecovered = errorPipelineReducer(pollFailed, { type: 'snapshot-succeeded' });

    expect(failedAction.connectivityDown).toBe(false);
    expect(pollFailed.connectivityDown).toBe(true);
    expect(pollRecovered.connectivityDown).toBe(false);
    expect(pollRecovered.actionErrors).toBe(failedAction.actionErrors);
    expect(pollRecovered.actionErrors).toEqual([
      { context: 'task:one:assign', error: 'The task changed.' },
    ]);
  });

  it('retains many independent errors, presents the newest first, and dismisses by key', () => {
    const contexts = Array.from(
      { length: 16 },
      (_, index) => actionErrorContexts.agentSend(`agent-${index}`),
    );
    const accumulated = contexts.reduce(
      (state, context, index) => actionErrorReducer(state, {
        type: 'failed',
        context,
        error: `Failure ${index}`,
      }),
      [] as ReturnType<typeof actionErrorReducer>,
    );

    expect(newestActionErrors(accumulated).map((entry) => entry.context)).toEqual([...contexts].reverse());

    const dismissed = actionErrorReducer(accumulated, {
      type: 'dismissed',
      context: contexts[7]!,
    });
    expect(dismissed).toHaveLength(15);
    expect(dismissed.some((entry) => entry.context === contexts[7])).toBe(false);
    expect(dismissed.filter((entry) => entry.context === contexts[8])).toHaveLength(1);
  });
});

describe('action error contexts', () => {
  it('gives every action an entity-scoped operation key', () => {
    const contexts = [
      actionErrorContexts.projectCreate,
      actionErrorContexts.workItemCreate,
      actionErrorContexts.agentSend('agent:one'),
      actionErrorContexts.agentRotateToken('agent:one'),
      actionErrorContexts.questionAnswer('question:one'),
      actionErrorContexts.taskAnswer('task:one', 'question:one'),
      actionErrorContexts.taskHumanCheckApprove('task:one'),
      actionErrorContexts.taskHumanCheckRequestChanges('task:one'),
      actionErrorContexts.taskRetry('task:one'),
      actionErrorContexts.taskRecoveryReassign('task:one'),
      actionErrorContexts.taskRecoveryBacklog('task:one'),
      actionErrorContexts.taskAssign('task:one'),
      actionErrorContexts.taskReturnToBacklog('task:one'),
      actionErrorContexts.taskInterrupt('task:one', 'run:one'),
      actionErrorContexts.workItemAnswer('work-item:one', 'question:one'),
      actionErrorContexts.workItemConfirmPlan('work-item:one', 'plan:one'),
      actionErrorContexts.workItemRejectPlan('work-item:one'),
      actionErrorContexts.workItemCancel('work-item:one'),
      actionErrorContexts.workItemArchive('work-item:one'),
    ];

    expect(new Set(contexts).size).toBe(contexts.length);
    expect(actionErrorContexts.taskRecoveryReassign('task:one'))
      .not.toBe(actionErrorContexts.taskAssign('task:one'));
    expect(actionErrorContexts.workItemRejectPlan('work-item:one'))
      .not.toBe(actionErrorContexts.workItemCancel('work-item:one'));
    expect(actionErrorContexts.workItemAnswer('work-item:one', 'question:one'))
      .not.toBe(actionErrorContexts.workItemAnswer('work-item:one', 'question:two'));
  });

  it('classifies only modal-owned BoardApp actions as dialog anchored', () => {
    expect(isDialogAnchoredActionContext(actionErrorContexts.projectCreate)).toBe(true);
    expect(isDialogAnchoredActionContext(actionErrorContexts.workItemCreate)).toBe(true);
    expect(isDialogAnchoredActionContext(actionErrorContexts.agentRotateToken('agent:one'))).toBe(true);
    expect(isDialogAnchoredActionContext(actionErrorContexts.agentSend('agent:one'))).toBe(false);
    expect(isDialogAnchoredActionContext(actionErrorContexts.questionAnswer('question:one'))).toBe(false);
  });
});

describe('action error taxonomy', () => {
  it.each([
    ['TASK_TERMINAL', 'This task is already completed or cancelled and cannot be recovered. Refresh to see its current state.'],
    ['TASK_WORKFLOW_BOUND', 'Workflow stage tasks cannot return to backlog. Retry or reassign this task instead.'],
    ['TASK_UNASSIGNED', 'This task has no assigned agent. Reassign it before retrying.'],
    ['TASK_VERSION_CONFLICT', 'This task changed in another session. Refresh before trying again.'],
    ['WORK_NODE_VERSION_CONFLICT', 'This task changed in another session. Refresh before trying again.'],
    ['WORK_ITEM_ENDED', 'This work item ended before the plan could be confirmed. Refresh to see its current state.'],
    ['WORK_ITEM_VERSION_CONFLICT', 'This work item or plan changed in another session. Refresh before trying again.'],
    ['PLAN_NOT_PROPOSED', 'This work item or plan changed in another session. Refresh before trying again.'],
  ])('maps conflict code %s', (code, expected) => {
    expect(actionErrorMessage(new BoardApiError('server wording', 409, code))).toBe(expected);
  });

  it('distinguishes authentication, authorization, validation, generic conflict, and server failures', () => {
    expect(actionErrorMessage(new BoardApiError('expired', 401, 'UNAUTHENTICATED')))
      .toBe('Your sign-in has expired. Sign in again, then retry this change.');
    expect(actionErrorMessage(new BoardApiError('wrong group', 403, 'FORBIDDEN')))
      .toBe('Your account does not have permission to make this change.');
    expect(actionErrorMessage(new BoardApiError('Choose a project.', 400, 'PROJECT_REQUIRED')))
      .toBe('Check this change: Choose a project.');
    expect(actionErrorMessage(new BoardApiError('stale', 409, 'AGENT_VERSION_CONFLICT')))
      .toBe('The board changed in another session. Refresh before trying again.');
    expect(actionErrorMessage(new BoardApiError('database unavailable', 503, 'UNAVAILABLE')))
      .toBe('The board could not save this change. database unavailable');
  });

  it('uses saved-change copy for network failures without claiming the whole board is unavailable', () => {
    const message = actionErrorMessage(new TypeError('Failed to fetch'));

    expect(message).toBe("Couldn't reach the board — your change was not saved. Check your connection and try again.");
    expect(message).not.toContain('Task board unavailable');
  });

  it('preserves a specific local validation error and handles unknown failures safely', () => {
    expect(actionErrorMessage(new Error('Select an eligible manager.'))).toBe('Select an eligible manager.');
    expect(actionErrorMessage(null)).toBe('The change could not be saved. Refresh and try again.');
  });
});
