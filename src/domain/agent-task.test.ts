import { describe, expect, it } from 'vitest';

import {
  AGENT_ESTIMATE_INTERVAL_MINUTES,
  agentExpectedMinutes,
  agentTaskId,
  completeAgentTask,
  isAgentTask,
  pauseAgentTask,
  resumeAgentTask,
  startAgentTask,
} from './agent-task';
import type { AgentTask } from './agent-task';
import { agentLaneId } from './human-run-control';
import { agentId, isoDateTime, workItemId } from './types';
import type { PolicyDecision } from './types';

function value<Value>(decision: PolicyDecision<Value>): Value {
  if (!decision.allowed) {
    throw new Error(`${decision.code}: ${decision.reason}`);
  }
  return decision.value;
}

function start(
  startedAt = '2026-07-18T20:08:27.321Z',
  expectedMinutes = 30,
): AgentTask {
  return value(
    startAgentTask({
      id: agentTaskId('task-checkout-recovery'),
      laneId: agentLaneId('lane-engineer-patch'),
      agentId: agentId('agent-patch'),
      workItemId: workItemId('work-checkout-recovery'),
      title: 'Repair checkout timeout recovery',
      expectedAgentMinutes: agentExpectedMinutes(expectedMinutes),
      startedAt: isoDateTime(startedAt),
    }),
  );
}

describe('agent task timing', () => {
  it('accepts only positive safe-integer estimates in 15-minute intervals', () => {
    expect(AGENT_ESTIMATE_INTERVAL_MINUTES).toBe(15);
    expect(agentExpectedMinutes(15)).toBe(15);
    expect(agentExpectedMinutes(30)).toBe(30);
    expect(agentExpectedMinutes(90)).toBe(90);

    for (const invalid of [0, -15, 14, 20, 15.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      expect(() => agentExpectedMinutes(invalid)).toThrow(/positive safe integer divisible by 15/);
    }
  });

  it('preserves the exact actual start and snaps the forecast up to a quarter hour', () => {
    const task = start();

    expect(task).toMatchObject({
      status: 'running',
      startedAt: '2026-07-18T20:08:27.321Z',
      expectedAgentMinutes: 30,
      expectedCompletedAt: '2026-07-18T20:45:00.000Z',
      pauses: [],
    });
    expect(task).not.toHaveProperty('endedAt');
    expect(task).not.toHaveProperty('runId');
    expect(Object.isFrozen(task)).toBe(true);
    expect(Object.isFrozen(task.pauses)).toBe(true);
  });

  it('does not push an estimate that already lands on a quarter-hour boundary', () => {
    const task = start('2026-07-18T20:00:00.000Z', 45);

    expect(task.expectedCompletedAt).toBe('2026-07-18T20:45:00.000Z');
  });

  it('defensively rejects malformed start timing even if callers bypass branded constructors', () => {
    const malformed = startAgentTask({
      id: agentTaskId('task-malformed'),
      laneId: agentLaneId('lane-malformed'),
      agentId: agentId('agent-malformed'),
      workItemId: workItemId('work-malformed'),
      title: 'Malformed timing',
      expectedAgentMinutes: 20 as ReturnType<typeof agentExpectedMinutes>,
      startedAt: isoDateTime('not-an-iso-time'),
    });

    expect(malformed.allowed).toBe(false);
    if (!malformed.allowed) {
      expect(malformed.code).toBe('AGENT_TASK_TIMING_INVALID');
    }

    const validButUnrepresentableEstimate = startAgentTask({
      id: agentTaskId('task-unrepresentable'),
      laneId: agentLaneId('lane-unrepresentable'),
      agentId: agentId('agent-unrepresentable'),
      workItemId: workItemId('work-unrepresentable'),
      title: 'Unrepresentable forecast',
      expectedAgentMinutes: agentExpectedMinutes(9_007_199_254_740_990),
      startedAt: isoDateTime('2026-07-18T20:00:00.000Z'),
    });
    expect(validButUnrepresentableEstimate.allowed).toBe(false);
    if (!validButUnrepresentableEstimate.allowed) {
      expect(validButUnrepresentableEstimate.code).toBe('AGENT_TASK_TIMING_INVALID');
    }
  });

  it('pauses for human wait without ending the durable task', () => {
    const task = start();
    const paused = value(
      pauseAgentTask({
        task,
        pausedAt: isoDateTime('2026-07-18T20:20:12.000Z'),
      }),
    );

    expect(paused.status).toBe('paused');
    expect(paused.expectedCompletedAt).toBe(task.expectedCompletedAt);
    expect(paused.pauses).toEqual([
      { pausedAt: '2026-07-18T20:20:12.000Z' },
    ]);
    expect(paused).not.toHaveProperty('endedAt');
    expect(task.status).toBe('running');
    expect(task.pauses).toEqual([]);
  });

  it('adds only closed human-wait duration before re-snapping the forecast', () => {
    let task = start();
    task = value(
      pauseAgentTask({
        task,
        pausedAt: isoDateTime('2026-07-18T20:20:00.000Z'),
      }),
    );
    task = value(
      resumeAgentTask({
        task,
        resumedAt: isoDateTime('2026-07-18T20:28:00.000Z'),
      }),
    );

    expect(task.status).toBe('running');
    expect(task.expectedCompletedAt).toBe('2026-07-18T21:00:00.000Z');
    expect(task.pauses).toEqual([
      {
        pausedAt: '2026-07-18T20:20:00.000Z',
        resumedAt: '2026-07-18T20:28:00.000Z',
      },
    ]);

    task = value(
      pauseAgentTask({
        task,
        pausedAt: isoDateTime('2026-07-18T20:30:00.000Z'),
      }),
    );
    task = value(
      resumeAgentTask({
        task,
        resumedAt: isoDateTime('2026-07-18T20:45:00.000Z'),
      }),
    );

    expect(task.expectedCompletedAt).toBe('2026-07-18T21:15:00.000Z');
  });

  it('records the exact end time only when the running task completes', () => {
    const running = start();
    const completed = value(
      completeAgentTask({
        task: running,
        endedAt: isoDateTime('2026-07-18T20:37:09.456Z'),
      }),
    );

    expect(completed.status).toBe('completed');
    expect(completed.endedAt).toBe('2026-07-18T20:37:09.456Z');
    expect(completed.startedAt).toBe(running.startedAt);
    expect(completed.expectedCompletedAt).toBe(running.expectedCompletedAt);
    expect(running).not.toHaveProperty('endedAt');
  });

  it('rejects out-of-order times and invalid state transitions', () => {
    const running = start();
    const earlyPause = pauseAgentTask({
      task: running,
      pausedAt: isoDateTime('2026-07-18T20:08:27.320Z'),
    });
    expect(earlyPause.allowed).toBe(false);
    if (!earlyPause.allowed) {
      expect(earlyPause.code).toBe('AGENT_TASK_TIMING_INVALID');
    }

    const paused = value(
      pauseAgentTask({
        task: running,
        pausedAt: isoDateTime('2026-07-18T20:20:00.000Z'),
      }),
    );
    const pausedAgain = pauseAgentTask({
      task: paused,
      pausedAt: isoDateTime('2026-07-18T20:21:00.000Z'),
    });
    expect(pausedAgain.allowed).toBe(false);
    if (!pausedAgain.allowed) {
      expect(pausedAgain.code).toBe('INVALID_AGENT_TASK_TRANSITION');
    }

    const earlyResume = resumeAgentTask({
      task: paused,
      resumedAt: isoDateTime('2026-07-18T20:19:59.999Z'),
    });
    expect(earlyResume.allowed).toBe(false);
    if (!earlyResume.allowed) {
      expect(earlyResume.code).toBe('AGENT_TASK_TIMING_INVALID');
    }

    const completedWhilePaused = completeAgentTask({
      task: paused,
      endedAt: isoDateTime('2026-07-18T20:25:00.000Z'),
    });
    expect(completedWhilePaused.allowed).toBe(false);
    if (!completedWhilePaused.allowed) {
      expect(completedWhilePaused.code).toBe('INVALID_AGENT_TASK_TRANSITION');
    }

    const earlyEnd = completeAgentTask({
      task: running,
      endedAt: isoDateTime('2026-07-18T20:08:27.320Z'),
    });
    expect(earlyEnd.allowed).toBe(false);
    if (!earlyEnd.allowed) {
      expect(earlyEnd.code).toBe('AGENT_TASK_TIMING_INVALID');
    }
  });

  it('validates persisted timing structure, chronology, status, and derived forecast', () => {
    const running = start();
    expect(isAgentTask(running)).toBe(true);
    expect(
      isAgentTask({
        ...running,
        expectedCompletedAt: '2026-07-18T20:46:00.000Z',
      }),
    ).toBe(false);
    expect(
      isAgentTask({
        ...running,
        status: 'paused',
      }),
    ).toBe(false);
    expect(
      isAgentTask({
        ...running,
        pauses: [
          {
            pausedAt: '2026-07-18T20:20:00.000Z',
            resumedAt: '2026-07-18T20:19:00.000Z',
          },
        ],
      }),
    ).toBe(false);
    expect(
      isAgentTask({
        ...running,
        status: 'completed',
        endedAt: '2026-07-18T20:01:00.000Z',
      }),
    ).toBe(false);
  });
});
