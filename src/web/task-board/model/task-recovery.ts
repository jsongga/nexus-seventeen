import {
  isHardTerminalTaskStatus,
  isRecoverableTaskStatus,
  rawTaskStatuses,
  type WireTaskStatus,
} from '../data/wire';
import type { TaskKind, TaskStatus } from '../types';

export interface TaskDetailMutationAffordances {
  answerQuestion: boolean;
  decideHumanCheck: boolean;
  recover: boolean;
  assign: boolean;
  interrupt: boolean;
}

export function deriveTaskDetailMutationAffordances(input: {
  status: TaskStatus;
  kind: TaskKind;
  ended: boolean;
  hasOpenQuestion: boolean;
  hasActiveRun: boolean;
  hasRecovery: boolean;
}): TaskDetailMutationAffordances {
  if (input.status === 'unrecognized') {
    return {
      answerQuestion: false,
      decideHumanCheck: false,
      recover: false,
      assign: false,
      interrupt: false,
    };
  }

  const agentTask = input.kind !== 'human_check';
  const queuedUnclaimed = input.status === 'queued' && !input.hasActiveRun;
  return {
    answerQuestion: agentTask && input.hasOpenQuestion,
    decideHumanCheck: !agentTask && !input.ended,
    recover: agentTask && input.hasRecovery && !input.hasOpenQuestion,
    assign: agentTask
      && !input.hasOpenQuestion
      && (input.status === 'backlog' || input.status === 'proposed' || queuedUnclaimed),
    interrupt: agentTask && input.hasActiveRun,
  };
}

export interface RecoveryAffordanceInput {
  status: TaskStatus;
  assignedAgentId: string | null;
  /** Null means the board snapshot does not expose workflow linkage. */
  workflowBound: boolean | null;
  eligibleAgentIds: readonly string[];
}

export interface RecoveryAffordances {
  retry: Readonly<{ primary: true }> | null;
  reassign: Readonly<{
    primary: boolean;
    eligibleAgentIds: string[];
    disabledReason: string | null;
  }>;
  backlog: Readonly<{ primary: false }> | null;
}

export interface AgentPickerSelection {
  readonly taskId: string;
  readonly agentId: string;
  readonly explicit: boolean;
}

export function initialAgentPickerSelection(taskId: string, defaultAgentId: string): AgentPickerSelection {
  return { taskId, agentId: defaultAgentId, explicit: false };
}

export function explicitAgentPickerSelection(
  current: AgentPickerSelection,
  agentId: string,
): AgentPickerSelection {
  return { ...current, agentId, explicit: true };
}

export function syncAgentPickerSelection(
  current: AgentPickerSelection,
  taskId: string,
  defaultAgentId: string,
  eligibleAgentIds?: readonly string[],
): AgentPickerSelection {
  if (current.taskId !== taskId) return initialAgentPickerSelection(taskId, defaultAgentId);
  if (current.explicit) {
    // A poll can remove the explicitly chosen agent from the eligible set;
    // keeping the stale id would post a doomed reassignment.
    if (eligibleAgentIds !== undefined && !eligibleAgentIds.includes(current.agentId)) {
      return initialAgentPickerSelection(taskId, defaultAgentId);
    }
    return current;
  }
  if (current.agentId === defaultAgentId) return current;
  return { ...current, agentId: defaultAgentId };
}

function contractStatus(status: TaskStatus): WireTaskStatus | null {
  if (!rawTaskStatuses.has(status as WireTaskStatus)) return null;
  return status as WireTaskStatus;
}

/** Derives only recovery-state controls; null preserves every existing non-recovery flow. */
export function recoveryAffordances(input: RecoveryAffordanceInput): RecoveryAffordances | null {
  const status = contractStatus(input.status);
  if (status === null || isHardTerminalTaskStatus(status) || !isRecoverableTaskStatus(status)) return null;

  const assigned = input.assignedAgentId !== null;
  const eligibleAgentIds = input.eligibleAgentIds.filter((agentId) => agentId !== input.assignedAgentId);
  return {
    retry: assigned ? { primary: true } : null,
    reassign: {
      primary: !assigned,
      eligibleAgentIds,
      disabledReason: eligibleAgentIds.length > 0
        ? null
        : assigned ? 'No other eligible agents' : 'No eligible agents',
    },
    backlog: input.workflowBound === true ? null : { primary: false },
  };
}
