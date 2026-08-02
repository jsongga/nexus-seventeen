import { describe, expect, it } from 'vitest';
import { AGENT_STATUSES, TASK_BOARD_API_VERSION, TASK_STATUSES } from '@shared/task-board-contract';
import {
  apiVersion,
  maximumAutomationConfigurationBytes,
  rawAgentStatuses,
  rawTaskStatuses,
  workItemPageSize,
} from './wire';

describe('wire constants', () => {
  it('resolves the shared contract from source through the @shared alias', () => {
    expect(TASK_BOARD_API_VERSION).toBe('steward.task-board/v1');
  });

  it('re-exports contract constants rather than redeclaring them', () => {
    expect(apiVersion).toBe(TASK_BOARD_API_VERSION);
    expect(maximumAutomationConfigurationBytes).toBe(48 * 1_024);
    expect(workItemPageSize).toBe(200);
  });
});

describe('wire validators', () => {
  it('builds the agent status validator from the contract', () => {
    expect([...rawAgentStatuses].sort()).toEqual([...AGENT_STATUSES].sort());
  });

  it('builds the task status validator from the contract', () => {
    expect([...rawTaskStatuses].sort()).toEqual([...TASK_STATUSES].sort());
  });

  it('rejects view-layer vocabulary that never appears on the wire', () => {
    // 'running' is what the view calls in_progress. If the wire validator
    // ever accepts it, the projection layer has leaked into parsing.
    expect(rawTaskStatuses.has('running' as never)).toBe(false);
    expect(rawAgentStatuses.has('sleeping' as never)).toBe(false);
  });
});
