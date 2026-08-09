import {
  isHardTerminalTaskStatus,
  isRecoverableTaskStatus,
  rawTaskStatuses,
  type WireTaskStatus,
} from '../data/wire';
import type { TaskStatus } from '../types';

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
