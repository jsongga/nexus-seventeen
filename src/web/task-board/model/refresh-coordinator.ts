export type BoardRefreshKind = 'foreground' | 'poll' | 'mutation';

type RefreshOperation = (kind: BoardRefreshKind, signal: AbortSignal) => Promise<boolean>;

export const BOARD_REFRESH_DEADLINE_MS = 30_000;

interface BoardRefreshCoordinatorOptions {
  readonly onForegroundLoadingChange?: (loading: boolean) => void;
}

function abortReasonName(signal: AbortSignal): string | null {
  const reason = signal.reason as unknown;
  if (typeof reason !== 'object' || reason === null || !('name' in reason)) return null;
  return typeof reason.name === 'string' ? reason.name : null;
}

/** Distinguishes a bounded connectivity deadline from an owner-disposal abort. */
export function refreshTimedOut(signal: AbortSignal): boolean {
  return signal.aborted && abortReasonName(signal) === 'TimeoutError';
}

interface PendingSnapshotCommit<T> {
  readonly snapshot: T;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly resolve: (committed: boolean) => void;
}

/** Bridges a requested React state update to its layout-effect commit acknowledgement. */
export class SnapshotCommitCoordinator<T> {
  #pending: PendingSnapshotCommit<T> | null = null;

  commit(snapshot: T, signal: AbortSignal, render: (snapshot: T) => void): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    this.#settle(this.#pending, false);
    return new Promise<boolean>((resolve) => {
      const pending: PendingSnapshotCommit<T> = {
        snapshot,
        signal,
        onAbort: () => this.#settle(pending, false),
        resolve,
      };
      this.#pending = pending;
      signal.addEventListener('abort', pending.onAbort, { once: true });
      render(snapshot);
    });
  }

  acknowledge(snapshot: T): void {
    if (this.#pending?.snapshot !== snapshot) return;
    this.#settle(this.#pending, true);
  }

  drain(): void {
    this.#settle(this.#pending, false);
  }

  #settle(pending: PendingSnapshotCommit<T> | null, committed: boolean): void {
    if (pending === null) return;
    if (this.#pending === pending) this.#pending = null;
    pending.signal.removeEventListener('abort', pending.onAbort);
    pending.resolve(committed);
  }
}

/**
 * Serializes board snapshot reads without cancelling useful work.
 *
 * Polls are disposable and skip while another read is active. A mutation waits
 * for that read, then always performs its own read so its caller cannot observe
 * a snapshot that was captured before the mutation committed on the server.
 */
export class BoardRefreshCoordinator {
  readonly #operation: RefreshOperation;
  #active = true;
  #generation = 0;
  #controller: AbortController | null = null;
  #inFlight: Promise<boolean> | null = null;
  #mutationTail: Promise<void> = Promise.resolve();
  readonly #onForegroundLoadingChange: (loading: boolean) => void;
  readonly #foregroundWaiters = new Set<symbol>();

  constructor(operation: RefreshOperation, options: BoardRefreshCoordinatorOptions = {}) {
    this.#operation = operation;
    this.#onForegroundLoadingChange = options.onForegroundLoadingChange ?? (() => undefined);
  }

  activate(): void {
    this.#active = true;
    this.#generation += 1;
    this.#mutationTail = Promise.resolve();
  }

  refresh(kind: BoardRefreshKind): Promise<boolean> {
    if (!this.#active) return Promise.resolve(false);
    const generation = this.#generation;

    if (kind === 'poll') {
      if (this.#inFlight !== null) return Promise.resolve(false);
      return this.#start(kind, generation);
    }

    if (kind === 'foreground') {
      return this.#trackForeground(this.#inFlight ?? this.#start(kind, generation));
    }

    const result = this.#mutationTail.then(async () => {
      while (this.#inFlight !== null) await this.#inFlight;
      if (!this.#active || generation !== this.#generation) return false;
      return this.#start('mutation', generation);
    });
    this.#mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  dispose(): void {
    this.#active = false;
    this.#generation += 1;
    this.#controller?.abort();
    this.#controller = null;
    this.#inFlight = null;
    this.#mutationTail = Promise.resolve();
    if (this.#foregroundWaiters.size > 0) {
      this.#foregroundWaiters.clear();
      this.#onForegroundLoadingChange(false);
    }
  }

  #start(kind: BoardRefreshKind, generation: number): Promise<boolean> {
    const controller = new AbortController();
    this.#controller = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(BOARD_REFRESH_DEADLINE_MS),
    ]);
    const operation = this.#operation(kind, signal);
    const inFlight = operation.finally(() => {
      if (this.#inFlight === inFlight) this.#inFlight = null;
      if (this.#controller === controller) this.#controller = null;
    });
    if (this.#active && generation === this.#generation) this.#inFlight = inFlight;
    return inFlight;
  }

  #trackForeground(result: Promise<boolean>): Promise<boolean> {
    const waiter = Symbol('foreground refresh');
    if (this.#foregroundWaiters.size === 0) this.#onForegroundLoadingChange(true);
    this.#foregroundWaiters.add(waiter);
    return result.finally(() => {
      if (!this.#foregroundWaiters.delete(waiter)) return;
      if (this.#foregroundWaiters.size === 0) this.#onForegroundLoadingChange(false);
    });
  }
}
