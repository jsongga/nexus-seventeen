import { describe, expect, it } from 'vitest';
import { TASK_BOARD_API_VERSION } from '@shared/task-board-contract';
import { apiVersion, maximumAutomationConfigurationBytes, workItemPageSize } from './wire';

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
