import { describe, expect, it } from 'vitest';
import { recoveryAffordances } from './task-recovery';

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

  it('offers backlog when workflow linkage is unavailable so the server can enforce the boundary', () => {
    expect(recoveryAffordances({
      status: 'failed',
      assignedAgentId: 'current-agent',
      workflowBound: null,
      eligibleAgentIds: ['current-agent'],
    })?.backlog).toEqual({ primary: false });
  });
});
