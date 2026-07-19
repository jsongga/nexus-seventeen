import {
  STEWARD_UI_API_VERSION,
  parseHumanCommandEnvelope,
  parseHumanCommandReceipt,
  parseUiBootstrap,
  parseUiEventEnvelope,
  type HumanCommandEnvelope,
  type HumanCommandReceipt,
  type UiBootstrap,
  type UiEventEnvelope,
  type WorkspaceId,
} from '@cicada/steward-protocol';
import { describe, expect, it, vi } from 'vitest';
import type {
  ControlPlaneGateway,
  UiEventStreamTermination,
  UiEventSubscription,
} from './http-gateway';
import { WorkspaceClient, type WorkspaceConnectionState } from './workspace-client';

const WORKSPACE = 'workspace-one' as WorkspaceId;
const NOW = '2026-07-19T01:00:00.000Z';

function task(status: 'queued' | 'running' = 'queued') {
  return {
    taskId: 'task-one',
    workspaceId: WORKSPACE,
    agentId: 'agent-one',
    laneId: 'lane-one',
    title: 'Implement transport',
    objective: 'Connect the disposable frontend to authoritative state.',
    status,
    expectedAgentMinutes: 30,
    expectedCompletedAt: '2026-07-19T01:30:00.000Z',
    startedAt: status === 'running' ? NOW : null,
    endedAt: null,
  } as const;
}

function bootstrap(
  sequence = 1,
  paused = false,
  options: Readonly<{ withTask?: boolean }> = {},
): UiBootstrap {
  return parseUiBootstrap({
    apiVersion: STEWARD_UI_API_VERSION,
    sessionId: 'session-one',
    userId: 'human-one',
    permissions: ['agents:read', 'agents:control'],
    features: ['runtime-discovery'],
    snapshot: {
      apiVersion: STEWARD_UI_API_VERSION,
      workspaceId: WORKSPACE,
      sequence,
      controlVersion: paused ? 1 : 0,
      generatedAt: NOW,
      paused,
      agents: [
        {
          workspaceId: WORKSPACE,
          agentId: 'agent-one',
          laneId: 'lane-one',
          runtimeInstanceId: 'runtime-one',
          runtimeEpoch: 1,
          displayName: 'Ada',
          role: 'engineer',
          capabilities: ['research', 'plan', 'modify_workspace', 'run_tests'],
          provider: { name: 'codex', model: 'codex-mini' },
          softwareVersion: '0.1.0',
          checkpointRef: null,
          registeredAt: NOW,
          lastSeenAt: NOW,
          leaseExpiresAt: '2026-07-19T01:01:00.000Z',
          currentAction: null,
          connectionState: 'online',
          controlState: paused ? 'held' : 'active',
          controlVersion: paused ? 1 : 0,
          queue: options.withTask ? ['task-one'] : [],
        },
      ],
      tasks: options.withTask ? [task()] : [],
      progress: [],
    },
    eventStream: {
      href: '/v1/ui/events',
      afterSequence: sequence,
      retentionStartsAtSequence: 1,
      heartbeatIntervalMs: 15_000,
    },
    commandEndpoint: '/v1/ui/commands',
  });
}

function pauseEvent(sequence = 2): UiEventEnvelope {
  return parseUiEventEnvelope({
    apiVersion: STEWARD_UI_API_VERSION,
    eventId: `event-${sequence}`,
    workspaceId: WORKSPACE,
    sequence,
    occurredAt: '2026-07-19T01:00:01.000Z',
    causationClientCommandId: 'command-one',
    payload: {
      type: 'workspace_control_updated',
      paused: true,
      controlVersion: 1,
    },
  });
}

function pauseCommand(): HumanCommandEnvelope {
  return parseHumanCommandEnvelope({
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'command-one',
    workspaceId: WORKSPACE,
    expectedControlVersion: 0,
    issuedAt: NOW,
    payload: {
      type: 'set_workspace_pause',
      paused: true,
      reason: 'Pause for a human review.',
    },
  });
}

class FakeGateway implements ControlPlaneGateway {
  readonly bootstraps: UiBootstrap[];
  eventHandler: ((event: UiEventEnvelope) => void) | undefined;
  disconnectHandler: ((reason: UiEventStreamTermination) => void) | undefined;
  receipt: HumanCommandReceipt | undefined;
  closeCount = 0;

  constructor(...bootstraps: UiBootstrap[]) {
    this.bootstraps = bootstraps;
  }

  async bootstrap(): Promise<UiBootstrap> {
    const next = this.bootstraps.shift();
    if (!next) throw new Error('No bootstrap available.');
    return next;
  }

  subscribe(input: {
    readonly afterSequence: number;
    readonly onEvent: (event: UiEventEnvelope) => void;
    readonly onDisconnect: (reason: UiEventStreamTermination) => void;
  }): UiEventSubscription {
    this.eventHandler = input.onEvent;
    this.disconnectHandler = input.onDisconnect;
    return {
      close: () => {
        this.closeCount += 1;
      },
    };
  }

  async submit(_command: HumanCommandEnvelope): Promise<HumanCommandReceipt> {
    if (!this.receipt) throw new Error('No receipt available.');
    return this.receipt;
  }
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('WorkspaceClient', () => {
  it('bootstraps, applies contiguous events, and exposes a shared-protocol replica', async () => {
    const gateway = new FakeGateway(bootstrap());
    const states: WorkspaceConnectionState[] = [];
    const client = new WorkspaceClient({ gateway, onChange: (state) => states.push(state) });
    client.start();
    await nextTurn();
    expect(client.state.mode).toBe('live');

    gateway.eventHandler?.(pauseEvent());

    expect(client.state.replica?.sequence).toBe(2);
    expect(client.state.replica?.paused).toBe(true);
    expect(client.state.replica?.controlVersion).toBe(1);
    expect(states.map((state) => state.mode)).toEqual(['connecting', 'live', 'live']);
    client.stop();
  });

  it('adds result-oriented RPET progress and its updated task atomically', async () => {
    const gateway = new FakeGateway(bootstrap(1, false, { withTask: true }));
    const client = new WorkspaceClient({ gateway, onChange: () => undefined });
    client.start();
    await nextTurn();

    gateway.eventHandler?.(
      parseUiEventEnvelope({
        apiVersion: STEWARD_UI_API_VERSION,
        eventId: 'progress-event',
        workspaceId: WORKSPACE,
        sequence: 2,
        occurredAt: '2026-07-19T01:00:02.000Z',
        payload: {
          type: 'progress_recorded',
          progress: {
            taskId: 'task-one',
            phase: 'research',
            iteration: 1,
            journal: 'Confirmed the transport boundary and user-facing impact.',
            occurredAt: '2026-07-19T01:00:02.000Z',
          },
          task: task('running'),
        },
      }),
    );

    expect(client.state.replica?.tasks[0]?.status).toBe('running');
    expect(client.state.replica?.progress).toHaveLength(1);
    expect(client.state.replica?.progress[0]?.phase).toBe('research');
    client.stop();
  });

  it('fails closed and re-bootstraps after an event gap', async () => {
    vi.useFakeTimers();
    try {
      const gateway = new FakeGateway(bootstrap(), bootstrap(3, true));
      const client = new WorkspaceClient({ gateway, onChange: () => undefined, retryBaseMs: 50 });
      client.start();
      await vi.runAllTicks();
      await Promise.resolve();
      expect(client.state.mode).toBe('live');

      gateway.eventHandler?.(pauseEvent(3));
      expect(client.state.mode).toBe('stale');

      await vi.runAllTimersAsync();
      expect(client.state.mode).toBe('live');
      expect(client.state.replica?.sequence).toBe(3);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires reauthentication without retrying an expired session', async () => {
    const gateway = new FakeGateway(bootstrap());
    const client = new WorkspaceClient({ gateway, onChange: () => undefined });
    client.start();
    await nextTurn();
    gateway.disconnectHandler?.({ kind: 'authentication_expired' });

    expect(client.state.mode).toBe('authentication_required');
    expect(client.state.replica?.sequence).toBe(1);
    client.stop();
  });

  it('disables commands unless live and advances control state from an accepted receipt', async () => {
    const gateway = new FakeGateway(bootstrap());
    const command = pauseCommand();
    gateway.receipt = parseHumanCommandReceipt({
      state: 'accepted',
      clientCommandId: command.clientCommandId,
      workspaceId: WORKSPACE,
      acceptedAt: NOW,
      currentControlVersion: 1,
      intentEventSequence: 2,
    });
    const client = new WorkspaceClient({ gateway, onChange: () => undefined });

    await expect(client.submit(command)).rejects.toThrow('disabled');
    client.start();
    await nextTurn();
    await expect(client.submit(command)).resolves.toEqual(gateway.receipt);
    expect(client.state.replica?.controlVersion).toBe(1);

    gateway.disconnectHandler?.({ kind: 'transient_network' });
    await expect(client.submit(command)).rejects.toThrow('disabled');
    client.stop();
  });
});
