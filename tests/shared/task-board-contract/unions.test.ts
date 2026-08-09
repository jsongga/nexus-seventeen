import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_STATUSES,
  TASK_BOARD_ERROR_CODES,
  TASK_STATUSES,
  WAKEUP_REASONS,
  RUN_STATUSES,
  WORK_ITEM_STATES,
  isHardTerminalTaskStatus,
  isRecoverableTaskStatus,
} from '#shared/task-board-contract';

test('agent statuses match the documented wire vocabulary', () => {
  assert.deepEqual([...AGENT_STATUSES], [
    'idle', 'ready', 'running', 'interrupting', 'waiting_for_human',
  ]);
});

test('task statuses are the wire set, not the view set', () => {
  // 'in_progress' and 'cancelled' are wire-only; the view projects them to
  // 'running' and 'interrupted'. The wire also carries an explicit recoverable
  // 'interrupted' state. If this ever contains 'running', a view
  // type has leaked into the contract.
  assert.deepEqual([...TASK_STATUSES], [
    'backlog', 'queued', 'in_progress', 'blocked', 'completed', 'failed', 'interrupted', 'cancelled',
  ]);
  assert.ok(!TASK_STATUSES.includes('running' as never));
});

test('run statuses include active rather than running', () => {
  assert.deepEqual([...RUN_STATUSES], [
    'active', 'waiting_for_human', 'completed', 'failed', 'interrupted',
  ]);
});

test('task recovery adds stable error and wakeup vocabulary', () => {
  assert.equal(TASK_BOARD_ERROR_CODES.TASK_TERMINAL, 'TASK_TERMINAL');
  assert.equal(TASK_BOARD_ERROR_CODES.TASK_UNASSIGNED, 'TASK_UNASSIGNED');
  assert.equal(TASK_BOARD_ERROR_CODES.TASK_WORKFLOW_BOUND, 'TASK_WORKFLOW_BOUND');
  assert.equal(TASK_BOARD_ERROR_CODES.TASK_RETRY_REQUIRED, 'TASK_RETRY_REQUIRED');
  assert.equal(TASK_BOARD_ERROR_CODES.TASK_NOT_RECOVERABLE, 'TASK_NOT_RECOVERABLE');
  assert.equal(TASK_BOARD_ERROR_CODES.TASK_WORKFLOW_ATTEMPT_SUPERSEDED, 'TASK_WORKFLOW_ATTEMPT_SUPERSEDED');
  assert.equal(TASK_BOARD_ERROR_CODES.WORK_NODE_VERSION_CONFLICT, 'WORK_NODE_VERSION_CONFLICT');
  assert.equal(TASK_BOARD_ERROR_CODES.TASK_RECOVERY_REQUIRED, 'TASK_RECOVERY_REQUIRED');
  assert.equal(isRecoverableTaskStatus('failed'), true);
  assert.equal(isRecoverableTaskStatus('blocked'), true);
  assert.equal(isRecoverableTaskStatus('interrupted'), true);
  assert.equal(isRecoverableTaskStatus('queued'), false);
  assert.equal(isHardTerminalTaskStatus('completed'), true);
  assert.equal(isHardTerminalTaskStatus('cancelled'), true);
  assert.equal(isHardTerminalTaskStatus('failed'), false);
  assert.ok(WAKEUP_REASONS.includes('assigned'));
  assert.ok(WAKEUP_REASONS.includes('resumed'));
});

test('work item states cover the durable lifecycle', () => {
  assert.deepEqual([...WORK_ITEM_STATES], [
    'submitted', 'processing', 'needs_input', 'waiting_for_human_review',
    'completed', 'failed', 'cancelled',
  ]);
});
