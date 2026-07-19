import type { UiSnapshot } from '@cicada/steward-protocol';
import type {
  ControlPlaneGateway,
  WorkspaceConnectionMode,
} from '../control-plane';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const MINIMUM_INACTIVITY_WINDOW_MS = 5_000;
const MISSED_HEARTBEATS_BEFORE_RECONCILE = 3;

export const AMBIGUOUS_COMMAND_REASON =
  'The command outcome is uncertain. Reloading authoritative state before another command.';

export type RuntimeActivity = Readonly<{
  kind: 'bootstrap' | 'stream';
  occurredAtMs: number;
}>;

/** Mutable only inside one connected tab; it never persists transport state. */
export class RuntimeActivityMonitor {
  #heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
  #lastActivityAtMs: number | null = null;
  readonly #listeners = new Set<(activity: RuntimeActivity) => void>();

  get heartbeatIntervalMs(): number {
    return this.#heartbeatIntervalMs;
  }

  get lastActivityAtMs(): number | null {
    return this.#lastActivityAtMs;
  }

  recordBootstrap(heartbeatIntervalMs: number, occurredAtMs = Date.now()): void {
    if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
      throw new TypeError('The control plane advertised an invalid heartbeat interval.');
    }
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
    this.#record({ kind: 'bootstrap', occurredAtMs });
  }

  recordStreamActivity(occurredAtMs = Date.now()): void {
    this.#record({ kind: 'stream', occurredAtMs });
  }

  subscribe(listener: (activity: RuntimeActivity) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #record(activity: RuntimeActivity): void {
    this.#lastActivityAtMs = activity.occurredAtMs;
    for (const listener of this.#listeners) listener(activity);
  }
}

export type RuntimeFreshnessIssue = Readonly<{
  kind: 'stream_inactive' | 'lease_expired';
  reason: string;
}>;

export function inactivityWindowMs(heartbeatIntervalMs: number): number {
  return Math.max(
    MINIMUM_INACTIVITY_WINDOW_MS,
    heartbeatIntervalMs * MISSED_HEARTBEATS_BEFORE_RECONCILE,
  );
}

export function runtimeFreshnessIssue(input: {
  readonly mode: WorkspaceConnectionMode;
  readonly snapshot: UiSnapshot | undefined;
  readonly lastActivityAtMs: number | null;
  readonly heartbeatIntervalMs: number;
  readonly nowMs: number;
}): RuntimeFreshnessIssue | null {
  if (input.mode !== 'live' || input.snapshot === undefined) return null;

  const expiredAgent = input.snapshot.agents.find(
    (agent) =>
      agent.connectionState !== 'offline' &&
      input.nowMs > Date.parse(agent.leaseExpiresAt),
  );
  if (expiredAgent) {
    return {
      kind: 'lease_expired',
      reason: `${expiredAgent.displayName}'s displayed lease expired. Reloading authoritative state.`,
    };
  }

  const inactivityWindow = inactivityWindowMs(input.heartbeatIntervalMs);
  if (
    input.lastActivityAtMs === null ||
    input.nowMs - input.lastActivityAtMs > inactivityWindow
  ) {
    return {
      kind: 'stream_inactive',
      reason: 'The live stream missed its keepalives. Reloading authoritative state.',
    };
  }
  return null;
}

/** Fails closed before propagating any command outcome the UI cannot prove. */
export async function submitWithReplicaInvalidation<Result>(input: {
  readonly submit: () => Promise<Result>;
  readonly invalidate: (reason: string) => void;
}): Promise<Result> {
  try {
    return await input.submit();
  } catch (error) {
    input.invalidate(AMBIGUOUS_COMMAND_REASON);
    throw error;
  }
}

/**
 * Observes bytes before the shared SSE parser. This includes comment-only
 * keepalives, which the shared gateway correctly does not expose as UI events.
 */
export function createActivityTrackingFetch(
  monitor: RuntimeActivityMonitor,
  baseFetch: typeof fetch,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await baseFetch(input, init);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!response.body || !contentType.startsWith('text/event-stream')) return response;

    monitor.recordStreamActivity();
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          monitor.recordStreamActivity();
          controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}

/** Captures the server-advertised keepalive interval after validated bootstrap. */
export function observeGatewayBootstrap(
  gateway: ControlPlaneGateway,
  monitor: RuntimeActivityMonitor,
): ControlPlaneGateway {
  return Object.freeze({
    async bootstrap(signal?: AbortSignal) {
      const bootstrap = await gateway.bootstrap(signal);
      monitor.recordBootstrap(bootstrap.eventStream.heartbeatIntervalMs);
      return bootstrap;
    },
    subscribe(input: Parameters<ControlPlaneGateway['subscribe']>[0]) {
      return gateway.subscribe(input);
    },
    submit(command: Parameters<ControlPlaneGateway['submit']>[0], signal?: AbortSignal) {
      return gateway.submit(command, signal);
    },
  });
}
