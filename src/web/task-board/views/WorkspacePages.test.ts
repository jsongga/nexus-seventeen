import { describe, expect, it } from 'vitest';
import { agentPageUsesPointOfContactMode, deriveInterruptAllOutcome } from './WorkspacePages';

describe('agentPageUsesPointOfContactMode', () => {
  it('enables POC chat framing only for the selected explicit POC', () => {
    expect(agentPageUsesPointOfContactMode(true, true)).toBe(true);
    expect(agentPageUsesPointOfContactMode(true, false)).toBe(false);
    expect(agentPageUsesPointOfContactMode(false, true)).toBe(false);
  });
});

describe('deriveInterruptAllOutcome', () => {
  it('counts live interrupts, already-finished runs, and failures separately', () => {
    const error = new Error('network unavailable');
    expect(deriveInterruptAllOutcome(
      ['run-live', 'run-finished', 'run-failed'],
      [
        { status: 'fulfilled', value: { runId: 'run-live' } },
        { status: 'fulfilled', value: { runId: null } },
        { status: 'rejected', reason: error },
      ],
    )).toEqual({
      handledRunIds: ['run-live', 'run-finished'],
      interruptedCount: 1,
      alreadyFinishedCount: 1,
      failedCount: 1,
    });
  });
});
