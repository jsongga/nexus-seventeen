import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_STATUSES,
  TASK_BOARD_ERROR_CODES,
  TASK_STATUSES,
  WAKEUP_REASONS,
  RUN_STATUSES,
  WORK_ITEM_STATES,
  WORK_ITEM_TASK_TYPES,
  WORK_ITEM_TERMINAL_STATES,
  WORK_ITEM_TRANSITIONS,
  isHardTerminalTaskStatus,
  pipelineTemplateShape,
  isRecoverableTaskStatus,
  isTerminalWorkItemState,
  isWorkItemTransitionAllowed,
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
  assert.equal(TASK_BOARD_ERROR_CODES.PROJECT_REQUIRED, 'PROJECT_REQUIRED');
  assert.equal(TASK_BOARD_ERROR_CODES.ONBOARDING_PROJECT_REQUIRED, 'ONBOARDING_PROJECT_REQUIRED');
  assert.equal(TASK_BOARD_ERROR_CODES.ONBOARDING_EXISTS, 'ONBOARDING_EXISTS');
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

test('work-item task types expose the standard default and onboarding discriminator', () => {
  assert.deepEqual([...WORK_ITEM_TASK_TYPES], ['standard', 'onboarding']);
});

test('work item states cover the durable lifecycle', () => {
  assert.deepEqual([...WORK_ITEM_STATES], [
    'queued', 'planning', 'plan_approval', 'designing', 'implementing',
    'verifying', 'reviewing', 'fixing', 'final_approval', 'merged',
    'parked', 'abandoned', 'dead_letter',
  ]);
});

test('work item transition table is pinned edge for edge', () => {
  assert.deepEqual(WORK_ITEM_TRANSITIONS, {
    queued: ['planning', 'parked', 'abandoned', 'dead_letter'],
    planning: ['plan_approval', 'implementing', 'verifying', 'reviewing', 'parked', 'abandoned', 'dead_letter'],
    plan_approval: ['designing', 'implementing', 'verifying', 'reviewing', 'planning', 'parked', 'abandoned', 'dead_letter'],
    designing: ['implementing', 'parked', 'abandoned', 'dead_letter'],
    implementing: ['verifying', 'reviewing', 'planning', 'merged', 'parked', 'abandoned', 'dead_letter'],
    verifying: ['reviewing', 'fixing', 'final_approval', 'implementing', 'planning', 'parked', 'abandoned', 'dead_letter'],
    reviewing: ['fixing', 'planning', 'implementing', 'verifying', 'final_approval', 'merged', 'parked', 'abandoned', 'dead_letter'],
    fixing: ['verifying', 'parked', 'abandoned', 'dead_letter'],
    final_approval: ['merged', 'fixing', 'implementing', 'parked', 'abandoned', 'dead_letter'],
    parked: ['planning', 'implementing', 'verifying', 'reviewing', 'fixing', 'abandoned', 'dead_letter'],
    merged: [],
    abandoned: [],
    dead_letter: [],
  });
});

test('work item terminal states are absorbing', () => {
  assert.deepEqual([...WORK_ITEM_TERMINAL_STATES], [
    'merged', 'abandoned', 'dead_letter',
  ]);

  for (const state of WORK_ITEM_STATES) {
    assert.equal(
      isTerminalWorkItemState(state),
      WORK_ITEM_TERMINAL_STATES.includes(state as never),
    );
  }

  for (const terminal of WORK_ITEM_TERMINAL_STATES) {
    assert.equal(WORK_ITEM_TRANSITIONS[terminal].length, 0);
  }
});

test('work item transitions preserve liveness and terminal escape routes', () => {
  const targets = new Set(Object.values(WORK_ITEM_TRANSITIONS).flat());

  for (const state of WORK_ITEM_STATES) {
    if (isTerminalWorkItemState(state)) {
      continue;
    }

    assert.ok(WORK_ITEM_TRANSITIONS[state].length >= 1, `${state} has no outgoing edge`);
    assert.ok(WORK_ITEM_TRANSITIONS[state].includes('abandoned'), `${state} cannot be abandoned`);
    assert.ok(WORK_ITEM_TRANSITIONS[state].includes('dead_letter'), `${state} cannot dead-letter`);
  }

  for (const state of WORK_ITEM_STATES) {
    if (state !== 'queued') {
      assert.ok(targets.has(state), `${state} is unreachable`);
    }
  }
});

test('work item transitions include required reverse edges', () => {
  assert.equal(isWorkItemTransitionAllowed('reviewing', 'planning'), true);
  assert.equal(isWorkItemTransitionAllowed('fixing', 'verifying'), true);
  assert.equal(isWorkItemTransitionAllowed('final_approval', 'implementing'), true);
  assert.equal(isWorkItemTransitionAllowed('parked', 'implementing'), true);
  assert.equal(isWorkItemTransitionAllowed('parked', 'fixing'), true);
});

test('pipeline template shape recognizes only the v1 and v2 serial templates', () => {
  const cases = [
    { template: ['implementation', 'testing'], expected: 'v1' },
    { template: ['implementation', 'testing', 'verification'], expected: 'v2' },
    { template: ['testing', 'implementation'], expected: null },
    { template: ['implementation', 'implementation', 'testing'], expected: null },
    { template: ['implementation', 'testing', 'verification', 'research'], expected: null },
    { template: ['implementation', 'verification', 'testing'], expected: null },
  ] as const;

  for (const { template, expected } of cases) {
    assert.equal(pipelineTemplateShape(template), expected, JSON.stringify(template));
  }
});

test('work item transitions reject exits from terminal states', () => {
  assert.equal(isWorkItemTransitionAllowed('merged', 'planning'), false);
});

test('illegal work item transitions have a stable error code', () => {
  assert.equal(
    TASK_BOARD_ERROR_CODES.WORK_ITEM_ILLEGAL_TRANSITION,
    'WORK_ITEM_ILLEGAL_TRANSITION',
  );
});
