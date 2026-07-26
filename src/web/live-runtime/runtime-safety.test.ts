import { describe, expect, it, vi } from 'vitest';
import type { UiSnapshot } from '#shared/protocol';
import {
  RuntimeActivityMonitor,
  createActivityTrackingFetch,
  inactivityWindowMs,
  runtimeFreshnessIssue,
  submitWithReplicaInvalidation,
} from './runtime-safety';

function snapshot(input?: {
  connectionState?: 'online' | 'stale' | 'offline';
  leaseExpiresAt?: string;
}): UiSnapshot {
  return {
    apiVersion: 'steward.ui/v2',
    workspaceId: 'workspace-alpha',
    generatedAt: '2026-07-18T20:00:00.000Z',
    sequence: 1,
    paused: false,
    controlVersion: 0,
    agents: [{
      workspaceId: 'workspace-alpha',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      runtimeInstanceId: 'runtime-patch',
      runtimeEpoch: 1,
      displayName: 'Patch',
      role: 'engineer',
      capabilities: ['research', 'plan', 'modify_workspace', 'run_tests'],
      provider: { name: 'codex', model: 'gpt-mini' },
      softwareVersion: '0.1.0',
      checkpointRef: null,
      registeredAt: '2026-07-18T19:00:00.000Z',
      lastSeenAt: '2026-07-18T20:00:00.000Z',
      leaseExpiresAt: input?.leaseExpiresAt ?? '2026-07-18T20:01:00.000Z',
      currentAction: null,
      connectionState: input?.connectionState ?? 'online',
      controlState: 'active',
      controlVersion: 0,
      queue: [],
    }],
    tasks: [],
    progress: [],
  } as unknown as UiSnapshot;
}

describe('live runtime freshness boundary', () => {
  it('ages a presented online lease and ignores an authoritative offline lease', () => {
    const onlineIssue = runtimeFreshnessIssue({
      mode: 'live',
      snapshot: snapshot(),
      lastActivityAtMs: Date.parse('2026-07-18T20:00:59.000Z'),
      heartbeatIntervalMs: 15_000,
      nowMs: Date.parse('2026-07-18T20:01:00.001Z'),
    });
    const offlineIssue = runtimeFreshnessIssue({
      mode: 'live',
      snapshot: snapshot({ connectionState: 'offline' }),
      lastActivityAtMs: Date.parse('2026-07-18T20:00:59.000Z'),
      heartbeatIntervalMs: 15_000,
      nowMs: Date.parse('2026-07-18T20:01:00.001Z'),
    });

    expect(onlineIssue?.kind).toBe('lease_expired');
    expect(offlineIssue).toBeNull();
  });

  it('fails closed after three missed keepalives only while the client claims live', () => {
    expect(inactivityWindowMs(1_000)).toBe(5_000);
    expect(runtimeFreshnessIssue({
      mode: 'live',
      snapshot: snapshot({ leaseExpiresAt: '2026-07-18T21:00:00.000Z' }),
      lastActivityAtMs: 10_000,
      heartbeatIntervalMs: 5_000,
      nowMs: 25_001,
    })?.kind).toBe('stream_inactive');
    expect(runtimeFreshnessIssue({
      mode: 'connecting',
      snapshot: snapshot(),
      lastActivityAtMs: 0,
      heartbeatIntervalMs: 1_000,
      nowMs: 99_000,
    })).toBeNull();
  });

  it('invalidates the replica before propagating an ambiguous submit failure', async () => {
    const order: string[] = [];
    const submission = submitWithReplicaInvalidation({
      submit: async () => {
        order.push('submit');
        throw new TypeError('network connection ended');
      },
      invalidate: () => order.push('stale'),
    }).catch((error: unknown) => {
      order.push('reported');
      throw error;
    });

    await expect(submission).rejects.toThrow('network connection ended');
    expect(order).toEqual(['submit', 'stale', 'reported']);
  });
});

describe('raw stream activity tracking', () => {
  it('observes comment-only SSE chunks that do not become UI events', async () => {
    const monitor = new RuntimeActivityMonitor();
    const activities: string[] = [];
    monitor.subscribe((activity) => activities.push(activity.kind));
    const encoder = new TextEncoder();
    const baseFetch = vi.fn(async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )) as unknown as typeof fetch;
    const observedFetch = createActivityTrackingFetch(monitor, baseFetch);

    const response = await observedFetch('https://control.example.test/events');
    expect(await response.text()).toBe(': keepalive\n\n');
    expect(activities).toEqual(['stream', 'stream']);
  });
});
