export interface TaskDetailDraftState {
  taskId: string;
  answer: string;
  decisionRationale: string;
}

export type TaskDetailDraftAction =
  | { type: 'task-synced'; taskId: string }
  | { type: 'answer-changed'; value: string }
  | { type: 'rationale-changed'; value: string };

export function createTaskDetailDraftState(taskId: string): TaskDetailDraftState {
  return { taskId, answer: '', decisionRationale: '' };
}

/** Keeps poll-driven snapshot changes from becoming destructive form resets. */
export function taskDetailDraftReducer(
  state: TaskDetailDraftState,
  action: TaskDetailDraftAction,
): TaskDetailDraftState {
  switch (action.type) {
    case 'task-synced':
      return action.taskId === state.taskId ? state : createTaskDetailDraftState(action.taskId);
    case 'answer-changed':
      return { ...state, answer: action.value };
    case 'rationale-changed':
      return { ...state, decisionRationale: action.value };
  }
}
