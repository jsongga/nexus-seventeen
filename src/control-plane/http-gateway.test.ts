import {
  STEWARD_UI_API_VERSION,
  parseHumanCommandEnvelope,
  parseUiBootstrap,
  parseUiEventEnvelope,
  type HumanCommandEnvelope,
  type UiBootstrap,
  type UiEventEnvelope,
  type WorkspaceId,
} from '@cicada/steward-protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  ControlPlaneProtocolError,
  createHttpControlPlaneGateway,
} from './http-gateway';

const WORKSPACE = 'workspace-one' as WorkspaceId;
const NOW = '2026-07-19T01:00:00.000Z';

function bootstrap(): UiBootstrap {
  return parseUiBootstrap({
    apiVersion: STEWARD_UI_API_VERSION,
    sessionId: 'session-one',
    userId: 'human-one',
    permissions: ['agents:read', 'agents:control'],
    features: ['runtime-discovery'],
    snapshot: {
      apiVersion: STEWARD_UI_API_VERSION,
      workspaceId: WORKSPACE,
      sequence: 1,
      controlVersion: 0,
      generatedAt: NOW,
      paused: false,
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
          controlState: 'active',
          controlVersion: 0,
          queue: [],
        },
      ],
      tasks: [],
      progress: [],
    },
    eventStream: {
      href: '/v1/ui/events',
      afterSequence: 1,
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
      reason: 'Human requested a deployment hold.',
    },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HTTP control-plane gateway', () => {
  it('requires HTTPS for bearer credentials except on loopback', () => {
    expect(() => createHttpControlPlaneGateway({
      origin: 'http://control.example',
      workspaceId: WORKSPACE,
      humanToken: 'human-secret',
    })).toThrow(/require HTTPS/u);
    expect(() => createHttpControlPlaneGateway({
      origin: 'http://127.0.0.1:4317',
      workspaceId: WORKSPACE,
      humanToken: 'human-secret',
    })).not.toThrow();
  });

  it('authenticates and validates an authoritative shared-protocol bootstrap', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('https://control.example/v1/ui/bootstrap?workspaceId=workspace-one');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer human-secret');
      expect(new Headers(init?.headers).get('x-steward-ui-version')).toBe(STEWARD_UI_API_VERSION);
      expect(init?.credentials).toBe('omit');
      return jsonResponse(bootstrap());
    });
    const gateway = createHttpControlPlaneGateway({
      origin: 'https://control.example',
      workspaceId: WORKSPACE,
      humanToken: 'human-secret',
      fetch: fetchMock,
    });

    await expect(gateway.bootstrap()).resolves.toEqual(bootstrap());
  });

  it('rejects cross-origin endpoints advertised by bootstrap', async () => {
    const invalid = {
      ...bootstrap(),
      eventStream: { ...bootstrap().eventStream, href: 'https://attacker.example/events' },
    };
    const gateway = createHttpControlPlaneGateway({
      origin: 'https://control.example',
      workspaceId: WORKSPACE,
      humanToken: 'human-secret',
      fetch: async () => jsonResponse(invalid),
    });

    await expect(gateway.bootstrap()).rejects.toBeInstanceOf(ControlPlaneProtocolError);
  });

  it('bounds bootstrap bodies before decoding JSON', async () => {
    const gateway = createHttpControlPlaneGateway({
      origin: 'https://control.example',
      workspaceId: WORKSPACE,
      humanToken: 'human-secret',
      fetch: async () =>
        new Response('{}', {
          headers: {
            'content-type': 'application/json',
            'content-length': String(513 * 1024),
          },
        }),
    });

    await expect(gateway.bootstrap()).rejects.toThrow('exceeded the maximum size');
  });

  it('streams validated SSE events with an authenticated fetch request', async () => {
    const event = pauseEvent();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`: keepalive\r\n\r\ndata: ${JSON.stringify(event)}\r`));
        controller.enqueue(new TextEncoder().encode('\n\r\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/bootstrap')) return jsonResponse(bootstrap());
      expect(String(input)).toBe('https://control.example/v1/ui/events?after=1');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer human-secret');
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    });
    const gateway = createHttpControlPlaneGateway({
      origin: 'https://control.example',
      workspaceId: WORKSPACE,
      humanToken: 'human-secret',
      fetch: fetchMock,
    });
    await gateway.bootstrap();

    const received = await new Promise<UiEventEnvelope>((resolve) => {
      gateway.subscribe({
        afterSequence: 1,
        onEvent: resolve,
        onDisconnect: () => undefined,
      });
    });
    expect(received).toEqual(event);
  });

  it('reports malformed SSE envelopes as protocol errors', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"apiVersion":"wrong"}\n\n'));
        controller.close();
      },
    });
    const gateway = createHttpControlPlaneGateway({
      origin: 'https://control.example',
      workspaceId: WORKSPACE,
      humanToken: 'human-secret',
      fetch: async (input) =>
        String(input).includes('/bootstrap')
          ? jsonResponse(bootstrap())
          : new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    });
    await gateway.bootstrap();

    await expect(
      new Promise<string>((resolve) => {
        gateway.subscribe({
          afterSequence: 1,
          onEvent: () => undefined,
          onDisconnect: (reason) => resolve(reason.kind),
        });
      }),
    ).resolves.toBe('protocol_error');
  });

  it('recognizes the control plane graceful-shutdown SSE event', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: shutdown\ndata: {"reason":"service_draining"}\n\n',
          ),
        );
      },
    });
    const gateway = createHttpControlPlaneGateway({
      origin: 'https://control.example',
      workspaceId: WORKSPACE,
      humanToken: 'human-secret',
      fetch: async (input) =>
        String(input).includes('/bootstrap')
          ? jsonResponse(bootstrap())
          : new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    });
    await gateway.bootstrap();

    await expect(
      new Promise<string>((resolve) => {
        gateway.subscribe({
          afterSequence: 1,
          onEvent: () => undefined,
          onDisconnect: (reason) => resolve(reason.kind),
        });
      }),
    ).resolves.toBe('server_shutdown');
  });

  it('submits shared-protocol commands only after bootstrap and binds the receipt', async () => {
    const command = pauseCommand();
    const receipt = {
      state: 'accepted',
      clientCommandId: command.clientCommandId,
      workspaceId: WORKSPACE,
      acceptedAt: NOW,
      currentControlVersion: 1,
      intentEventSequence: 2,
    };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/bootstrap')) return jsonResponse(bootstrap());
      expect(String(input)).toBe('https://control.example/v1/ui/commands');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual(command);
      return jsonResponse(receipt);
    });
    const gateway = createHttpControlPlaneGateway({
      origin: 'https://control.example',
      workspaceId: WORKSPACE,
      humanToken: 'human-secret',
      fetch: fetchMock,
    });

    await expect(gateway.submit(command)).rejects.toThrow('Bootstrap must complete');
    await gateway.bootstrap();
    await expect(gateway.submit(command)).resolves.toEqual(receipt);
  });
});
