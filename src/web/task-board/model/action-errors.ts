import { useCallback, useReducer } from 'react';
import { BoardApiError } from '../data/client';

export type ActionResult = { ok: true } | { ok: false; error: string };

export interface ActionError {
  context: string;
  error: string;
}

export type ActionErrorState = readonly ActionError[];

function actionContext(entityKind: string, entityId: string, operation: string, ...relatedEntities: string[]): string {
  return [entityKind, entityId, ...relatedEntities, operation]
    .map((segment) => encodeURIComponent(segment))
    .join(':');
}

export const actionErrorContexts = {
  projectCreate: actionContext('project', 'new', 'create'),
  workItemCreate: actionContext('work-item', 'new', 'create'),
  agentSend: (agentId: string) => actionContext('agent', agentId, 'send'),
  agentRotateToken: (agentId: string) => actionContext('agent', agentId, 'rotate-token'),
  questionAnswer: (questionId: string) => actionContext('question', questionId, 'answer'),
  taskAnswer: (taskId: string, questionId: string) => actionContext('task', taskId, 'answer', 'question', questionId),
  taskHumanCheckApprove: (taskId: string) => actionContext('task', taskId, 'human-check-approve'),
  taskHumanCheckRequestChanges: (taskId: string) => actionContext('task', taskId, 'human-check-request-changes'),
  taskRetry: (taskId: string) => actionContext('task', taskId, 'retry'),
  taskRecoveryReassign: (taskId: string) => actionContext('task', taskId, 'recovery-reassign'),
  taskRecoveryBacklog: (taskId: string) => actionContext('task', taskId, 'recovery-backlog'),
  taskAssign: (taskId: string) => actionContext('task', taskId, 'assign'),
  taskReturnToBacklog: (taskId: string) => actionContext('task', taskId, 'return-to-backlog'),
  taskInterrupt: (taskId: string, runId: string) => actionContext('task', taskId, 'interrupt', 'run', runId),
  workItemAnswer: (workItemId: string, questionId: string) => actionContext('work-item', workItemId, 'answer', 'question', questionId),
  workItemConfirmPlan: (workItemId: string, planRevisionId: string) => actionContext('work-item', workItemId, 'confirm-plan', 'plan', planRevisionId),
  workItemRejectPlan: (workItemId: string) => actionContext('work-item', workItemId, 'reject-plan'),
  workItemCancel: (workItemId: string) => actionContext('work-item', workItemId, 'cancel'),
  workItemArchive: (workItemId: string) => actionContext('work-item', workItemId, 'archive'),
} as const;

export function isDialogAnchoredActionContext(context: string): boolean {
  return context === actionErrorContexts.projectCreate
    || context === actionErrorContexts.workItemCreate
    || context.endsWith(':rotate-token');
}

export function newestActionErrors(state: ActionErrorState): ActionErrorState {
  return [...state].reverse();
}

export type ActionErrorEvent =
  | { type: 'started'; context: string }
  | { type: 'failed'; context: string; error: string }
  | { type: 'dismissed'; context: string };

function withoutContext(state: ActionErrorState, context: string): ActionErrorState {
  const next = state.filter((entry) => entry.context !== context);
  return next.length === state.length ? state : next;
}

export function actionErrorReducer(
  state: ActionErrorState,
  event: ActionErrorEvent,
): ActionErrorState {
  if (event.type === 'started' || event.type === 'dismissed') {
    return withoutContext(state, event.context);
  }
  return [
    ...withoutContext(state, event.context),
    { context: event.context, error: event.error },
  ];
}

export interface ErrorPipelineState {
  connectivityDown: boolean;
  actionErrors: ActionErrorState;
}

export const initialErrorPipelineState: ErrorPipelineState = {
  connectivityDown: false,
  actionErrors: [],
};

export type ErrorPipelineEvent =
  | { type: 'snapshot-succeeded' }
  | { type: 'snapshot-failed' }
  | { type: 'action-started'; context: string }
  | { type: 'action-failed'; context: string; error: string }
  | { type: 'action-dismissed'; context: string };

export function errorPipelineReducer(
  state: ErrorPipelineState,
  event: ErrorPipelineEvent,
): ErrorPipelineState {
  if (event.type === 'snapshot-succeeded') {
    return state.connectivityDown ? { ...state, connectivityDown: false } : state;
  }
  if (event.type === 'snapshot-failed') {
    return state.connectivityDown ? state : { ...state, connectivityDown: true };
  }
  const actionEvent: ActionErrorEvent = event.type === 'action-started'
    ? { type: 'started', context: event.context }
    : event.type === 'action-failed'
      ? { type: 'failed', context: event.context, error: event.error }
      : { type: 'dismissed', context: event.context };
  const actionErrors = actionErrorReducer(state.actionErrors, actionEvent);
  return actionErrors === state.actionErrors ? state : { ...state, actionErrors };
}

export function useActionErrors() {
  const [errors, dispatch] = useReducer(actionErrorReducer, []);
  const start = useCallback((context: string) => {
    dispatch({ type: 'started', context });
  }, []);
  const fail = useCallback((context: string, error: string) => {
    dispatch({ type: 'failed', context, error });
  }, []);
  const dismiss = useCallback((context: string) => {
    dispatch({ type: 'dismissed', context });
  }, []);

  return { errors, start, fail, dismiss };
}

const conflictMessages: Readonly<Record<string, string>> = {
  TASK_TERMINAL: 'This task is already completed or cancelled and cannot be recovered. Refresh to see its current state.',
  TASK_WORKFLOW_BOUND: 'Workflow stage tasks cannot return to backlog. Retry or reassign this task instead.',
  TASK_UNASSIGNED: 'This task has no assigned agent. Reassign it before retrying.',
  TASK_VERSION_CONFLICT: 'This task changed in another session. Refresh before trying again.',
  WORK_NODE_VERSION_CONFLICT: 'This task changed in another session. Refresh before trying again.',
  WORK_ITEM_ENDED: 'This work item ended before the plan could be confirmed. Refresh to see its current state.',
  WORK_ITEM_VERSION_CONFLICT: 'This work item or plan changed in another session. Refresh before trying again.',
  PLAN_NOT_PROPOSED: 'This work item or plan changed in another session. Refresh before trying again.',
};

export const mutationNetworkError = "Couldn't reach the board — your change was not saved. Check your connection and try again.";

export function actionErrorMessage(caught: unknown): string {
  if (caught instanceof BoardApiError) {
    if (caught.status === 401) {
      return 'Your sign-in has expired. Sign in again, then retry this change.';
    }
    if (caught.status === 403) {
      return 'Your account does not have permission to make this change.';
    }
    if (caught.code !== null && conflictMessages[caught.code]) {
      return conflictMessages[caught.code];
    }
    if (caught.status === 400) {
      return `Check this change: ${caught.message}`;
    }
    if (caught.status === 409) {
      return 'The board changed in another session. Refresh before trying again.';
    }
    if (caught.status >= 500) {
      return `The board could not save this change. ${caught.message}`;
    }
    return caught.message;
  }
  if (caught instanceof TypeError) return mutationNetworkError;
  if (caught instanceof Error) return caught.message;
  return 'The change could not be saved. Refresh and try again.';
}
