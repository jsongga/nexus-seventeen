import { describe, expect, it, vi } from 'vitest';
import { BoardPauseVersionGuard, refreshBoardSnapshot } from './BoardApp';
import type { TaskBoardClient } from './data/client';
import type { RawBoardPause } from './data/parse';
import { NotificationLoadCoordinator } from './model/notification-load';
import { taskPhasesByOrder, taskRunsByCreatedAt } from './views/TaskDetail';
import type { BoardRun, BoardSnapshot, BoardTaskPhase } from './types';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

const pauseTimestamp = '2026-08-21T12:00:00.000Z';

function pauseState(version: number, paused: boolean): RawBoardPause {
  return {
    paused,
    reason: paused ? 'Maintenance window.' : null,
    version,
    updatedAt: pauseTimestamp,
    updatedAtMs: Date.parse(pauseTimestamp),
    updatedBy: 'human:operator',
  };
}

describe('board pause refresh coordination', () => {
  it('commits and renders a valid snapshot when the independent pause GET fails', async () => {
    const generatedAt = '2026-08-21T12:00:00.000Z';
    const snapshot: BoardSnapshot = {
      revision: 1,
      generatedAt,
      generatedAtMs: Date.parse(generatedAt),
      projects: [],
      agents: [],
      tasks: [],
      messages: [],
      questions: [],
      runs: [],
      workItems: [],
      documents: [],
    };
    const client = {
      getSnapshot: vi.fn().mockResolvedValue(snapshot),
      getBoardPause: vi.fn().mockRejectedValue(new Error('pause route unavailable')),
    } as unknown as TaskBoardClient;
    const rendered: BoardSnapshot[] = [];
    const pauseUpdates: Array<RawBoardPause | null> = [];
    const signal = new AbortController().signal;

    const result = await refreshBoardSnapshot(
      client,
      'foreground',
      signal,
      async (next) => {
        rendered.push(next);
        return true;
      },
      (next) => pauseUpdates.push(next),
    );
    await result.pauseLoad;

    expect(result.committed).toBe(true);
    expect(rendered).toEqual([snapshot]);
    expect(pauseUpdates).toEqual([null]);
  });

  it('ignores a stale poll response that resolves after a newer mutation response', async () => {
    const guard = new BoardPauseVersionGuard();
    const stalePoll = deferred<RawBoardPause>();
    const mutation = deferred<RawBoardPause>();
    let stored: RawBoardPause | null = null;
    const store = (next: RawBoardPause) => {
      if (guard.accept(next)) stored = next;
    };
    const pollAssignment = stalePoll.promise.then(store);
    const mutationAssignment = mutation.promise.then(store);

    mutation.resolve(pauseState(2, true));
    await mutationAssignment;
    stalePoll.resolve(pauseState(1, false));
    await pollAssignment;

    expect(stored).toEqual(pauseState(2, true));
  });
});

describe('notification refresh coordination', () => {
  it('loads again for an unchanged-revision snapshot arrival without overlapping snapshot reads', async () => {
    const coordinator = new NotificationLoadCoordinator();
    coordinator.activate();
    const first = deferred<void>();
    const load = vi.fn()
      .mockImplementationOnce(async () => first.promise)
      .mockResolvedValueOnce(undefined);
    const initialSnapshot = { revision: 7 };
    const sameRevisionSnapshot = { revision: 7 };

    const pending = coordinator.snapshotArrived(initialSnapshot, load);
    const coalesced = coordinator.snapshotArrived(sameRevisionSnapshot, load);

    expect(load).toHaveBeenCalledOnce();
    first.resolve();
    await Promise.all([pending, coalesced]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('lets a mark-read refresh land while rejecting an older notification load that resolves last', async () => {
    const coordinator = new NotificationLoadCoordinator();
    coordinator.activate();
    const olderResponse = deferred<string>();
    const applied: string[] = [];
    const olderLoad = coordinator.snapshotArrived({ revision: 11 }, async (token) => {
      const value = await olderResponse.promise;
      if (coordinator.isLatest(token)) applied.push(value);
    });

    coordinator.invalidate();
    await coordinator.refresh(async (token) => {
      if (coordinator.isLatest(token)) applied.push('refreshed-after-read');
    });
    olderResponse.resolve('stale-unread-row');
    await olderLoad;

    expect(applied).toEqual(['refreshed-after-read']);
  });
});

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
      heartbeatAt: null,
      heartbeatAtMs: null,
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
