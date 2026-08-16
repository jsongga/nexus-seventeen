import { describe, expect, it } from 'vitest';
import {
  deriveTaskDetailMutationAffordances,
  explicitAgentPickerSelection,
  initialAgentPickerSelection,
  recoveryAffordances,
  syncAgentPickerSelection,
} from './task-recovery';

const recoverableStatuses = ['failed', 'blocked', 'interrupted'] as const;

describe('task recovery affordances', () => {
  for (const status of recoverableStatuses) {
    for (const assigned of [true, false]) {
      for (const workflowBound of [true, false]) {
        for (const hasEligibleReplacement of [true, false]) {
          it(`derives ${status}, ${assigned ? 'assigned' : 'unassigned'}, ${workflowBound ? 'workflow-bound' : 'standalone'}, ${hasEligibleReplacement ? 'with' : 'without'} an eligible replacement`, () => {
            const assignedAgentId = assigned ? 'current-agent' : null;
            const eligibleAgentIds = assigned
              ? hasEligibleReplacement ? ['current-agent', 'replacement-agent'] : ['current-agent']
              : hasEligibleReplacement ? ['replacement-agent'] : [];

            const result = recoveryAffordances({
              status,
              assignedAgentId,
              workflowBound,
              eligibleAgentIds,
            });

            expect(result).not.toBeNull();
            expect(result?.retry).toEqual(assigned ? { primary: true } : null);
            expect(result?.reassign).toEqual({
              primary: !assigned,
              eligibleAgentIds: hasEligibleReplacement ? ['replacement-agent'] : [],
              disabledReason: hasEligibleReplacement
                ? null
                : assigned ? 'No other eligible agents' : 'No eligible agents',
            });
            expect(result?.backlog).toEqual(workflowBound ? null : { primary: false });
          });
        }
      }
    }
  }

  it.each(['completed', 'cancelled'] as const)('offers no recovery action for hard-terminal %s tasks', (status) => {
    expect(recoveryAffordances({
      status,
      assignedAgentId: 'current-agent',
      workflowBound: false,
      eligibleAgentIds: ['current-agent', 'replacement-agent'],
    })).toBeNull();
  });

  it.each(['proposed', 'backlog', 'queued', 'running', 'waiting_for_human'] as const)(
    'leaves the existing %s task flow unchanged',
    (status) => {
      expect(recoveryAffordances({
        status,
        assignedAgentId: 'current-agent',
        workflowBound: false,
        eligibleAgentIds: ['current-agent', 'replacement-agent'],
      })).toBeNull();
    },
  );

  it('offers no recovery action for an unrecognized task status', () => {
    expect(recoveryAffordances({
      status: 'unrecognized',
      assignedAgentId: 'current-agent',
      workflowBound: false,
      eligibleAgentIds: ['current-agent', 'replacement-agent'],
    })).toBeNull();
  });

  it('offers backlog when workflow linkage is unavailable so the server can enforce the boundary', () => {
    expect(recoveryAffordances({
      status: 'failed',
      assignedAgentId: 'current-agent',
      workflowBound: null,
      eligibleAgentIds: ['current-agent'],
    })?.backlog).toEqual({ primary: false });
  });
});

describe('task detail mutation affordances', () => {
  const noAffordances = {
    answerQuestion: false,
    decideHumanCheck: false,
    recover: false,
    assign: false,
    interrupt: false,
  };

  it('offers no mutation for an unrecognized task with an open question', () => {
    expect(deriveTaskDetailMutationAffordances({
      status: 'unrecognized',
      kind: 'work',
      ended: false,
      hasOpenQuestion: true,
      hasActiveRun: true,
      hasRecovery: false,
    })).toEqual(noAffordances);
  });

  it('offers no mutation for an unrecognized human-check task', () => {
    expect(deriveTaskDetailMutationAffordances({
      status: 'unrecognized',
      kind: 'human_check',
      ended: false,
      hasOpenQuestion: false,
      hasActiveRun: false,
      hasRecovery: false,
    })).toEqual(noAffordances);
  });
});

describe('task agent picker selection', () => {
  it('tracks changing defaults until the operator makes an explicit selection', () => {
    const initial = initialAgentPickerSelection('task-one', 'agent-one');

    expect(syncAgentPickerSelection(initial, 'task-one', 'agent-two')).toEqual({
      taskId: 'task-one',
      agentId: 'agent-two',
      explicit: false,
    });
  });

  it('preserves an explicit selection across polls and clears it for another task', () => {
    const selected = explicitAgentPickerSelection(
      initialAgentPickerSelection('task-one', 'agent-one'),
      'agent-three',
    );

    expect(syncAgentPickerSelection(selected, 'task-one', 'agent-two')).toBe(selected);
    expect(syncAgentPickerSelection(selected, 'task-two', 'agent-four')).toEqual({
      taskId: 'task-two',
      agentId: 'agent-four',
      explicit: false,
    });
  });
});

it('drops an explicit selection when the agent leaves the eligible set', () => {
  const selected = explicitAgentPickerSelection(
    initialAgentPickerSelection('task-one', 'agent-one'),
    'agent-two',
  );
  expect(
    syncAgentPickerSelection(selected, 'task-one', 'agent-one', ['agent-one', 'agent-three']),
  ).toEqual({ taskId: 'task-one', agentId: 'agent-one', explicit: false });
  expect(
    syncAgentPickerSelection(selected, 'task-one', 'agent-one', ['agent-one', 'agent-two']),
  ).toBe(selected);
});
