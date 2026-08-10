import { describe, expect, it } from 'vitest';
import { taskPhasesByOrder, taskRunsByCreatedAt } from './views/TaskDetail';
import type { BoardRun, BoardTaskPhase } from './types';

describe('board timestamp ordering', () => {
  it('orders same-position phases and runs by absolute instants', () => {
    const earlierOffset = '2026-07-19T12:00:00+02:00';
    const laterFraction = '2026-07-19T10:00:00.500Z';
    const phase = (id: string, createdAt: string): BoardTaskPhase => ({
      id,
      title: id,
      stage: 'execution',
      status: 'pending',
      parallelGroup: null,
      orderKey: 1,
      startedAt: null,
      startedAtMs: null,
      endedAt: null,
      endedAtMs: null,
      version: 1,
      createdAt,
      createdAtMs: Date.parse(createdAt),
      updatedAt: createdAt,
      updatedAtMs: Date.parse(createdAt),
    });
    const run = (id: string, createdAt: string): BoardRun => ({
      id,
      projectId: 'project-one',
      taskId: 'task-one',
      agentId: 'agent-one',
      status: 'completed',
      wakeReason: null,
      startedAt: createdAt,
      startedAtMs: Date.parse(createdAt),
      endedAt: createdAt,
      endedAtMs: Date.parse(createdAt),
      interruptRequestedAt: null,
      interruptRequestedAtMs: null,
      createdAt,
      createdAtMs: Date.parse(createdAt),
    });

    expect(taskPhasesByOrder([
      phase('later', laterFraction),
      phase('earlier', earlierOffset),
    ]).map((item) => item.id)).toEqual(['earlier', 'later']);
    expect(taskRunsByCreatedAt([
      run('earlier', earlierOffset),
      run('later', laterFraction),
    ]).map((item) => item.id)).toEqual(['later', 'earlier']);
  });
});
