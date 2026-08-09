import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOARD_REFRESH_DEADLINE_MS,
  BoardRefreshCoordinator,
  SnapshotCommitCoordinator,
  refreshTimedOut,
  type BoardRefreshKind,
} from './refresh-coordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function installFakeAbortSignalTimeout(): void {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new DOMException(`Timed out after ${milliseconds} ms`, 'TimeoutError'));
    }, milliseconds);
    return controller.signal;
  });
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

describe('board refresh coordination', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('skips poll ticks while any refresh is in flight', async () => {
    vi.useFakeTimers();
    const releases: Array<ReturnType<typeof deferred<boolean>>> = [];
    const operation = vi.fn(() => {
      const release = deferred<boolean>();
      releases.push(release);
      return release.promise;
    });
    const coordinator = new BoardRefreshCoordinator(operation);
    const interval = setInterval(() => { void coordinator.refresh('poll'); }, 5_000);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(operation).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(operation).toHaveBeenCalledTimes(1);

    releases[0]!.resolve(true);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(operation).toHaveBeenCalledTimes(2);

    clearInterval(interval);
    coordinator.dispose();
  });

  it('waits for an in-flight poll and then gives a mutation its own refresh', async () => {
    vi.useFakeTimers();
    const kinds: BoardRefreshKind[] = [];
    const signals: AbortSignal[] = [];
    const releases: Array<ReturnType<typeof deferred<boolean>>> = [];
    const coordinator = new BoardRefreshCoordinator((kind, signal) => {
      kinds.push(kind);
      signals.push(signal);
      const release = deferred<boolean>();
      releases.push(release);
      return release.promise;
    });

    const poll = coordinator.refresh('poll');
    const mutation = coordinator.refresh('mutation');
    await flushMicrotasks();
    expect(kinds).toEqual(['poll']);
    await expect(coordinator.refresh('poll')).resolves.toBe(false);
    expect(signals[0]?.aborted).toBe(false);

    releases[0]!.resolve(true);
    await poll;
    await flushMicrotasks();
    expect(kinds).toEqual(['poll', 'mutation']);

    releases[1]!.resolve(true);
    await expect(mutation).resolves.toBe(true);
    coordinator.dispose();
  });

  it('deadlines a hung poll, exposes the connectivity failure, and lets the next poll recover', async () => {
    vi.useFakeTimers();
    installFakeAbortSignalTimeout();
    let calls = 0;
    let connectivityDown = false;
    const coordinator = new BoardRefreshCoordinator(async (_kind, signal) => {
      calls += 1;
      try {
        if (calls === 1) await waitForAbort(signal);
        connectivityDown = false;
        return true;
      } catch {
        if (refreshTimedOut(signal)) connectivityDown = true;
        return false;
      }
    });

    const hungPoll = coordinator.refresh('poll');
    await vi.advanceTimersByTimeAsync(BOARD_REFRESH_DEADLINE_MS);

    await expect(hungPoll).resolves.toBe(false);
    expect(connectivityDown).toBe(true);
    await expect(coordinator.refresh('poll')).resolves.toBe(true);
    expect(calls).toBe(2);
    expect(connectivityDown).toBe(false);
    coordinator.dispose();
  });

  it('unblocks a mutation queued behind a hung poll when the poll reaches its deadline', async () => {
    vi.useFakeTimers();
    installFakeAbortSignalTimeout();
    const kinds: BoardRefreshKind[] = [];
    const coordinator = new BoardRefreshCoordinator(async (kind, signal) => {
      kinds.push(kind);
      if (kind === 'poll') {
        try {
          await waitForAbort(signal);
        } catch {
          return false;
        }
      }
      return true;
    });

    const poll = coordinator.refresh('poll');
    const mutation = coordinator.refresh('mutation');
    let mutationSettled = false;
    void mutation.finally(() => { mutationSettled = true; });
    await flushMicrotasks();
    expect(kinds).toEqual(['poll']);
    expect(mutationSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(BOARD_REFRESH_DEADLINE_MS);

    await expect(poll).resolves.toBe(false);
    await expect(mutation).resolves.toBe(true);
    expect(kinds).toEqual(['poll', 'mutation']);
    expect(mutationSettled).toBe(true);
    coordinator.dispose();
  });

  it('returns an unrefreshed result and frees the lane when a mutation refresh reaches its deadline', async () => {
    vi.useFakeTimers();
    installFakeAbortSignalTimeout();
    let calls = 0;
    const coordinator = new BoardRefreshCoordinator(async (_kind, signal) => {
      calls += 1;
      if (calls === 1) {
        try {
          await waitForAbort(signal);
        } catch {
          return false;
        }
      }
      return true;
    });

    const mutation = coordinator.refresh('mutation');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(BOARD_REFRESH_DEADLINE_MS);

    await expect(mutation).resolves.toBe(false);
    await expect(coordinator.refresh('poll')).resolves.toBe(true);
    expect(calls).toBe(2);
    coordinator.dispose();
  });

  it('reports foreground loading while a manual refresh joins an active poll', async () => {
    const release = deferred<boolean>();
    const loadingChanges: boolean[] = [];
    const coordinator = new BoardRefreshCoordinator(
      () => release.promise,
      { onForegroundLoadingChange: (loading) => loadingChanges.push(loading) },
    );

    const poll = coordinator.refresh('poll');
    const foreground = coordinator.refresh('foreground');
    expect(loadingChanges).toEqual([true]);

    release.resolve(true);
    await expect(poll).resolves.toBe(true);
    await expect(foreground).resolves.toBe(true);
    expect(loadingChanges).toEqual([true, false]);
    coordinator.dispose();
  });

  it('reserves aborts for disposal', async () => {
    vi.useFakeTimers();
    const release = deferred<boolean>();
    let signal: AbortSignal | null = null;
    const coordinator = new BoardRefreshCoordinator((_kind, nextSignal) => {
      signal = nextSignal;
      return release.promise;
    });

    const foreground = coordinator.refresh('foreground');
    await expect(coordinator.refresh('poll')).resolves.toBe(false);
    expect(signal).not.toBeNull();
    expect(signal!.aborted).toBe(false);

    coordinator.dispose();
    expect(signal!.aborted).toBe(true);
    release.resolve(false);
    await expect(foreground).resolves.toBe(false);
  });

  it('does not resolve a mutation refresh until its snapshot commit is acknowledged', async () => {
    vi.useFakeTimers();
    const response = deferred<void>();
    const committed = deferred<void>();
    const events: string[] = [];
    const coordinator = new BoardRefreshCoordinator(async () => {
      events.push('request-started');
      await response.promise;
      events.push('snapshot-ready');
      await committed.promise;
      events.push('snapshot-committed');
      return true;
    });
    let settled = false;

    const mutation = coordinator.refresh('mutation').then((result) => {
      settled = true;
      return result;
    });
    await flushMicrotasks();
    response.resolve();
    await flushMicrotasks();

    expect(events).toEqual(['request-started', 'snapshot-ready']);
    expect(settled).toBe(false);

    committed.resolve();
    await expect(mutation).resolves.toBe(true);
    expect(events).toEqual(['request-started', 'snapshot-ready', 'snapshot-committed']);
    coordinator.dispose();
  });
});

describe('snapshot commit coordination', () => {
  it('resolves only after the matching snapshot commit callback fires', async () => {
    const commits = new SnapshotCommitCoordinator<string>();
    const controller = new AbortController();
    const rendered: string[] = [];
    let settled = false;

    const pending = commits.commit('snapshot-two', controller.signal, (snapshot) => {
      rendered.push(snapshot);
    }).then((result) => {
      settled = true;
      return result;
    });
    await flushMicrotasks();

    expect(rendered).toEqual(['snapshot-two']);
    expect(settled).toBe(false);
    commits.acknowledge('snapshot-one');
    await flushMicrotasks();
    expect(settled).toBe(false);

    commits.acknowledge('snapshot-two');
    await expect(pending).resolves.toBe(true);
  });

  it('drains an uncommitted snapshot when its owner unmounts', async () => {
    const commits = new SnapshotCommitCoordinator<object>();
    const controller = new AbortController();
    const snapshot = {};
    const pending = commits.commit(snapshot, controller.signal, () => undefined);

    commits.drain();

    await expect(pending).resolves.toBe(false);
  });
});
