import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_STATUSES,
  TASK_STATUSES,
  RUN_STATUSES,
  WORK_ITEM_STATES,
} from '#shared/task-board-contract';

test('agent statuses match the documented wire vocabulary', () => {
  assert.deepEqual([...AGENT_STATUSES], [
    'idle', 'ready', 'running', 'interrupting', 'waiting_for_human',
  ]);
});

test('task statuses are the wire set, not the view set', () => {
  // 'in_progress' and 'cancelled' are wire-only; the view projects them to
  // 'running' and 'interrupted'. If this ever contains 'running', a view
  // type has leaked into the contract.
  assert.deepEqual([...TASK_STATUSES], [
    'backlog', 'queued', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled',
  ]);
  assert.ok(!TASK_STATUSES.includes('running' as never));
});

test('run statuses include active rather than running', () => {
  assert.deepEqual([...RUN_STATUSES], [
    'active', 'waiting_for_human', 'completed', 'failed', 'interrupted',
  ]);
});

test('work item states cover the durable lifecycle', () => {
  assert.deepEqual([...WORK_ITEM_STATES], [
    'submitted', 'processing', 'needs_input', 'waiting_for_human_review',
    'completed', 'failed', 'cancelled',
  ]);
});
