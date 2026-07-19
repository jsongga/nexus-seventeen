import { describe, expect, it } from 'vitest';
import {
  agentId,
  agentExpectedMinutes,
  agentLaneId,
  agentRunId,
  agentTaskId,
  isoDateTime,
  userId,
  workItemId,
} from '../domain';
import {
  STEWARD_UI_API_VERSION,
  commandIntentEventWasObserved,
  commandIntentIsInSnapshot,
  controlPlaneEventId,
  createFrontendAgentReplica,
  createValidatedFrontendBootstrap,
  applyAgentRegistryEvent,
  applyAgentRegistryEvents,
  frontendCommandId,
  frontendSessionId,
  FRONTEND_REPLAY_WINDOW,
  projectAgentConnectivity,
  runtimeInstanceId,
  workspaceId,
  type AgentRegistryEvent,
  type DiscoveredAgent,
  type FrontendBootstrap,
  type FrontendCommand,
  type FrontendCommandReceipt,
  type WorkspaceDiscoverySnapshot,
} from '.';

const WORKSPACE_ID = workspaceId('workspace-northwind');

function discoveredAgent(input: Partial<DiscoveredAgent> = {}): DiscoveredAgent {
  return {
    agentId: agentId('agent-patch'),
    laneId: agentLaneId('lane-patch'),
    runtimeInstanceId: runtimeInstanceId('runtime-patch-1'),
    displayName: 'Patch',
    role: 'engineer',
    capabilities: ['repository.write', 'test.run'],
    lease: {
      state: 'online',
      registeredAt: isoDateTime('2026-07-18T20:00:00.000Z'),
      lastSeenAt: isoDateTime('2026-07-18T20:05:00.000Z'),
      leaseExpiresAt: isoDateTime('2026-07-18T20:06:00.000Z'),
      runtimeEpoch: 1,
    },
    activeRun: {
      id: agentRunId('run-patch-1'),
      state: 'running',
      startedAt: isoDateTime('2026-07-18T20:01:00.000Z'),
    },
    task: {
      id: agentTaskId('task-stw-471'),
      workItemId: workItemId('STW-471'),
      status: 'running',
      startedAt: isoDateTime('2026-07-18T20:01:17.000Z'),
      expectedAgentMinutes: agentExpectedMinutes(45),
      expectedCompletedAt: isoDateTime('2026-07-18T21:00:00.000Z'),
    },
    projectionVersion: 3,
    controlVersion: 2,
    ...input,
  };
}

function snapshot(agents: readonly DiscoveredAgent[] = [discoveredAgent()]): WorkspaceDiscoverySnapshot {
  return {
    apiVersion: STEWARD_UI_API_VERSION,
    workspaceId: WORKSPACE_ID,
    sequence: 40,
    controlVersion: 7,
    generatedAt: isoDateTime('2026-07-18T20:05:00.000Z'),
    paused: false,
    agents,
  };
}

function event(
  sequence: number,
  payload: AgentRegistryEvent['payload'],
  id = `event-${sequence}`,
): AgentRegistryEvent {
  return {
    apiVersion: STEWARD_UI_API_VERSION,
    id: controlPlaneEventId(id),
    workspaceId: WORKSPACE_ID,
    sequence,
    occurredAt: isoDateTime(`2026-07-18T20:05:${String(sequence - 40).padStart(2, '0')}.000Z`),
    payload,
  };
}

function initialReplica() {
  const created = createFrontendAgentReplica(snapshot());
  if (!created.ok) throw new Error(created.reason);
  return created.value;
}

describe('frontend control-plane discovery contract', () => {
  it('bootstraps an immutable replica containing every registered agent', () => {
    const gauge = discoveredAgent({
      agentId: agentId('agent-gauge'),
      laneId: agentLaneId('lane-gauge'),
      runtimeInstanceId: runtimeInstanceId('runtime-gauge-1'),
      displayName: 'Gauge',
      role: 'verifier',
      activeRun: undefined,
      projectionVersion: 1,
      controlVersion: 1,
    });
    const created = createFrontendAgentReplica(snapshot([discoveredAgent(), gauge]));
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(Object.keys(created.value.agentsByLane)).toEqual(['lane-patch', 'lane-gauge']);
      expect(Object.isFrozen(created.value)).toBe(true);
      expect(Object.isFrozen(created.value.agentsByLane['lane-patch'])).toBe(true);
    }
  });

  it('rejects duplicate stable lanes or agent identities in a bootstrap snapshot', () => {
    const duplicateAgent = discoveredAgent({
      laneId: agentLaneId('lane-other'),
      runtimeInstanceId: runtimeInstanceId('runtime-other'),
    });
    const result = createFrontendAgentReplica(snapshot([discoveredAgent(), duplicateAgent]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_SNAPSHOT');
  });

  it('rejects malformed transport data without throwing', () => {
    expect(createFrontendAgentReplica(null)).toMatchObject({
      ok: false,
      code: 'INVALID_SNAPSHOT',
    });
    expect(createFrontendAgentReplica({ ...snapshot(), agents: [null] })).toMatchObject({
      ok: false,
      code: 'INVALID_SNAPSHOT',
    });
    expect(applyAgentRegistryEvent(initialReplica(), { payload: null })).toMatchObject({
      ok: false,
      code: 'INVALID_EVENT',
    });
    expect(applyAgentRegistryEvent(initialReplica(), {
      ...event(41, { type: 'workspace_pause_changed', paused: true, workspaceControlVersion: 8 }),
      payload: { type: 'future_event' },
    })).toMatchObject({ ok: false, code: 'INVALID_EVENT' });
  });

  it('requires agent-only estimates and quarter-hour task forecasts', () => {
    expect(
      createFrontendAgentReplica(
        snapshot([
          discoveredAgent({
            task: {
              ...discoveredAgent().task!,
              expectedCompletedAt: isoDateTime('2026-07-18T20:52:00.000Z'),
            },
          }),
        ]),
      ),
    ).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT' });

    expect(
      createFrontendAgentReplica(
        snapshot([
          discoveredAgent({
            task: {
              ...discoveredAgent().task!,
              status: 'completed',
              endedAt: isoDateTime('2026-07-18T20:00:00.000Z'),
            },
          }),
        ]),
      ),
    ).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT' });
  });

  it('adds newly registered agents in strict event sequence', () => {
    const gauge = discoveredAgent({
      agentId: agentId('agent-gauge'),
      laneId: agentLaneId('lane-gauge'),
      runtimeInstanceId: runtimeInstanceId('runtime-gauge-1'),
      displayName: 'Gauge',
      role: 'verifier',
      activeRun: undefined,
      projectionVersion: 1,
      controlVersion: 1,
    });
    const applied = applyAgentRegistryEvent(
      initialReplica(),
      event(41, { type: 'agent_upserted', agent: gauge }),
    );
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.value.sequence).toBe(41);
      expect(applied.value.agentsByLane['lane-gauge']?.displayName).toBe('Gauge');
    }
  });

  it('advances heartbeat projections without churning the lane command version', () => {
    const current = discoveredAgent();
    const heartbeat = applyAgentRegistryEvent(
      initialReplica(),
      event(41, {
        type: 'agent_upserted',
        agent: discoveredAgent({
          projectionVersion: 4,
          controlVersion: current.controlVersion,
          lease: {
            ...current.lease,
            lastSeenAt: isoDateTime('2026-07-18T20:05:30.000Z'),
            leaseExpiresAt: isoDateTime('2026-07-18T20:06:30.000Z'),
          },
        }),
      }),
    );
    expect(heartbeat.ok).toBe(true);
    if (heartbeat.ok) {
      expect(heartbeat.value.agentsByLane['lane-patch']?.projectionVersion).toBe(4);
      expect(heartbeat.value.agentsByLane['lane-patch']?.controlVersion).toBe(2);
    }
  });

  it('treats an exact event replay as idempotent', () => {
    const update = event(41, {
      type: 'agent_upserted',
      agent: discoveredAgent({ projectionVersion: 4 }),
    });
    const first = applyAgentRegistryEvent(initialReplica(), update);
    if (!first.ok) throw new Error(first.reason);
    const replay = applyAgentRegistryEvent(first.value, update);
    expect(replay).toEqual({ ok: true, value: first.value });
  });

  it('accepts a delayed exact replay after newer events without rolling state back', () => {
    const firstEvent = event(41, {
      type: 'agent_upserted',
      agent: discoveredAgent({ projectionVersion: 4 }),
    });
    const first = applyAgentRegistryEvent(initialReplica(), firstEvent);
    if (!first.ok) throw new Error(first.reason);
    const second = applyAgentRegistryEvent(
      first.value,
      event(42, { type: 'agent_upserted', agent: discoveredAgent({ projectionVersion: 5 }) }),
    );
    if (!second.ok) throw new Error(second.reason);

    const replay = applyAgentRegistryEvent(second.value, firstEvent);
    expect(replay).toEqual({ ok: true, value: second.value });
  });

  it('bounds replay memory and requires rebootstrap for duplicates older than the window', () => {
    let replica = initialReplica();
    let firstEvent: AgentRegistryEvent | undefined;
    for (let offset = 1; offset <= FRONTEND_REPLAY_WINDOW + 5; offset += 1) {
      const update: AgentRegistryEvent = {
        apiVersion: STEWARD_UI_API_VERSION,
        id: controlPlaneEventId(`event-bounded-${offset}`),
        workspaceId: WORKSPACE_ID,
        sequence: 40 + offset,
        occurredAt: isoDateTime('2026-07-18T20:05:01.000Z'),
        payload: {
          type: 'workspace_pause_changed',
          paused: false,
          workspaceControlVersion: 7,
        },
      };
      firstEvent ??= update;
      const applied = applyAgentRegistryEvent(replica, update);
      if (!applied.ok) throw new Error(applied.reason);
      replica = applied.value;
    }

    expect(Object.keys(replica.seenEventSequences)).toHaveLength(FRONTEND_REPLAY_WINDOW);
    expect(Object.keys(replica.seenSequenceFingerprints)).toHaveLength(FRONTEND_REPLAY_WINDOW);
    const oldReplay = applyAgentRegistryEvent(replica, firstEvent);
    expect(oldReplay.ok).toBe(false);
    if (!oldReplay.ok) expect(oldReplay.code).toBe('SEQUENCE_REGRESSION');
  });

  it('fails closed for gaps, regressions, conflicts, and cross-workspace events', () => {
    const replica = initialReplica();
    const cases: Array<[string, AgentRegistryEvent, string]> = [
      [
        'gap',
        event(42, { type: 'agent_upserted', agent: discoveredAgent({ projectionVersion: 4 }) }),
        'SEQUENCE_GAP',
      ],
      [
        'regression',
        event(40, { type: 'agent_upserted', agent: discoveredAgent() }),
        'SEQUENCE_REGRESSION',
      ],
      [
        'workspace',
        {
          ...event(41, { type: 'agent_upserted', agent: discoveredAgent({ projectionVersion: 4 }) }),
          workspaceId: workspaceId('workspace-other'),
        },
        'WORKSPACE_MISMATCH',
      ],
    ];
    for (const [label, candidate, code] of cases) {
      const result = applyAgentRegistryEvent(replica, candidate);
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.code, label).toBe(code);
    }

    const firstEvent = event(41, {
      type: 'agent_upserted',
      agent: discoveredAgent({ projectionVersion: 4 }),
    });
    const first = applyAgentRegistryEvent(replica, firstEvent);
    if (!first.ok) throw new Error(first.reason);
    const conflict = applyAgentRegistryEvent(first.value, {
      ...firstEvent,
      id: controlPlaneEventId('event-conflict'),
      payload: { type: 'agent_upserted', agent: discoveredAgent({ projectionVersion: 5 }) },
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('SEQUENCE_CONFLICT');
  });

  it('rejects event-id reuse and entity-version regression', () => {
    const first = applyAgentRegistryEvent(
      initialReplica(),
      event(41, { type: 'agent_upserted', agent: discoveredAgent({ projectionVersion: 4 }) }, 'shared-id'),
    );
    if (!first.ok) throw new Error(first.reason);

    const reusedId = applyAgentRegistryEvent(
      first.value,
      event(42, { type: 'agent_upserted', agent: discoveredAgent({ projectionVersion: 5 }) }, 'shared-id'),
    );
    expect(reusedId.ok).toBe(false);
    if (!reusedId.ok) expect(reusedId.code).toBe('EVENT_ID_REUSED');

    const regressed = applyAgentRegistryEvent(
      first.value,
      event(42, { type: 'agent_upserted', agent: discoveredAgent({ projectionVersion: 3 }) }),
    );
    expect(regressed.ok).toBe(false);
    if (!regressed.ok) expect(regressed.code).toBe('ENTITY_VERSION_REGRESSION');
  });

  it('rejects duplicate lane ownership and stale runtime incarnations', () => {
    const duplicateIdentity = applyAgentRegistryEvent(
      initialReplica(),
      event(41, {
        type: 'agent_upserted',
        agent: discoveredAgent({
          laneId: agentLaneId('lane-imposter'),
          runtimeInstanceId: runtimeInstanceId('runtime-imposter'),
          projectionVersion: 1,
          controlVersion: 1,
        }),
      }),
    );
    expect(duplicateIdentity.ok).toBe(false);
    if (!duplicateIdentity.ok) expect(duplicateIdentity.code).toBe('ENTITY_VERSION_CONFLICT');

    const staleEpoch = applyAgentRegistryEvent(
      initialReplica(),
      event(41, {
        type: 'agent_upserted',
        agent: discoveredAgent({
          runtimeInstanceId: runtimeInstanceId('runtime-patch-old'),
          lease: { ...discoveredAgent().lease, runtimeEpoch: 1 },
          projectionVersion: 4,
        }),
      }),
    );
    expect(staleEpoch.ok).toBe(false);
    if (!staleEpoch.ok) expect(staleEpoch.code).toBe('ENTITY_VERSION_CONFLICT');
  });

  it('removes retired agents, retains a version tombstone, and applies a contiguous batch', () => {
    const result = applyAgentRegistryEvents(initialReplica(), [
      event(41, { type: 'workspace_pause_changed', paused: true, workspaceControlVersion: 8 }),
      event(42, {
        type: 'agent_removed',
        laneId: agentLaneId('lane-patch'),
        agentId: agentId('agent-patch'),
        laneProjectionVersion: 4,
        reason: 'retired',
      }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sequence).toBe(42);
      expect(result.value.paused).toBe(true);
      expect(result.value.agentsByLane['lane-patch']).toBeUndefined();
      expect(result.value.laneTombstones['lane-patch']).toMatchObject({
        laneProjectionVersion: 4,
        laneControlVersion: 2,
        reason: 'retired',
      });

      const resurrection = applyAgentRegistryEvent(
        result.value,
        event(43, {
          type: 'agent_upserted',
          agent: discoveredAgent({ projectionVersion: 1, controlVersion: 1 }),
        }),
      );
      expect(resurrection.ok).toBe(false);
      if (!resurrection.ok) expect(resurrection.code).toBe('ENTITY_VERSION_CONFLICT');
    }
  });

  it('permits an explicit, versioned identity replacement and clears its tombstone', () => {
    const removed = applyAgentRegistryEvent(initialReplica(), event(41, {
      type: 'agent_removed',
      laneId: agentLaneId('lane-patch'),
      agentId: agentId('agent-patch'),
      laneProjectionVersion: 4,
      reason: 'identity_replaced',
    }));
    if (!removed.ok) throw new Error(removed.reason);

    const regressedControl = applyAgentRegistryEvent(removed.value, event(42, {
      type: 'agent_upserted',
      agent: discoveredAgent({
        agentId: agentId('agent-patch-v2'),
        runtimeInstanceId: runtimeInstanceId('runtime-patch-v2'),
        projectionVersion: 5,
        controlVersion: 1,
      }),
    }));
    expect(regressedControl.ok).toBe(false);
    if (!regressedControl.ok) expect(regressedControl.code).toBe('ENTITY_VERSION_REGRESSION');

    const replacement = applyAgentRegistryEvent(removed.value, event(42, {
      type: 'agent_upserted',
      agent: discoveredAgent({
        agentId: agentId('agent-patch-v2'),
        runtimeInstanceId: runtimeInstanceId('runtime-patch-v2'),
        projectionVersion: 5,
        controlVersion: 3,
      }),
    }));
    expect(replacement.ok).toBe(true);
    if (replacement.ok) {
      expect(replacement.value.agentsByLane['lane-patch']?.agentId).toBe('agent-patch-v2');
      expect(replacement.value.laneTombstones['lane-patch']).toBeUndefined();
    }
  });

  it('ages an online lease to stale without upgrading server-declared state', () => {
    const agent = discoveredAgent();
    expect(projectAgentConnectivity(agent, isoDateTime('2026-07-18T20:05:30.000Z'))).toBe('online');
    expect(projectAgentConnectivity(agent, isoDateTime('2026-07-18T20:06:01.000Z'))).toBe('stale');
    expect(projectAgentConnectivity(
      discoveredAgent({ lease: { ...agent.lease, state: 'offline' } }),
      isoDateTime('2026-07-18T20:05:30.000Z'),
    )).toBe('offline');
  });

  it('does not treat command acceptance as proof of a worker side effect', () => {
    const commandId = frontendCommandId('command-interrupt-patch');
    const command: FrontendCommand = {
      apiVersion: STEWARD_UI_API_VERSION,
      id: commandId,
      workspaceId: WORKSPACE_ID,
      precondition: {
        resource: 'lane',
        id: agentLaneId('lane-patch'),
        version: 2,
      },
      clientIssuedAt: isoDateTime('2026-07-18T20:05:01.000Z'),
      payload: {
        type: 'request_interrupt',
        runId: agentRunId('run-patch-1'),
        reason: 'Human requested a safe checkpoint.',
      },
    };
    const receipt: FrontendCommandReceipt = {
      state: 'accepted',
      commandId: command.id,
      workspaceId: WORKSPACE_ID,
      acceptedAt: isoDateTime('2026-07-18T20:05:02.000Z'),
      currentTargetVersion: 3,
      intentEventSequence: 41,
    };
    const unrelated = event(41, {
      type: 'agent_upserted',
      agent: discoveredAgent({ projectionVersion: 4, controlVersion: 3 }),
    });
    expect(commandIntentEventWasObserved(receipt, unrelated)).toBe(false);
    expect(commandIntentEventWasObserved(receipt, {
      ...unrelated,
      causationCommandId: command.id,
    })).toBe(true);
    expect(commandIntentEventWasObserved(receipt, {
      ...unrelated,
      sequence: 42,
      causationCommandId: command.id,
    })).toBe(false);
    expect(commandIntentIsInSnapshot(receipt, snapshot())).toBe(false);
    expect(commandIntentIsInSnapshot(
      { ...receipt, state: 'duplicate' },
      { ...snapshot(), sequence: 41 },
    )).toBe(true);
  });

  it('validates a coherent bootstrap cursor and rejects unsafe recovery metadata', () => {
    const bootstrap: FrontendBootstrap = {
      apiVersion: STEWARD_UI_API_VERSION,
      sessionId: frontendSessionId('frontend-session-1'),
      userId: userId('user-jordan'),
      permissions: ['agent.run.interrupt'],
      features: ['registry.leases', 'commands.idempotent'],
      snapshot: snapshot(),
      eventStream: {
        href: '/v1/workspaces/workspace-northwind/events',
        afterSequence: 40,
        retentionStartsAtSequence: 1,
        heartbeatIntervalMs: 15_000,
      },
      commandEndpoint: '/v1/workspaces/workspace-northwind/commands',
    };
    const validated = createValidatedFrontendBootstrap(bootstrap);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.value.replica.sequence).toBe(bootstrap.snapshot.sequence);
      expect(Object.isFrozen(validated.value.eventStream)).toBe(true);
    }

    const invalidBootstraps = [
      { ...bootstrap, eventStream: { ...bootstrap.eventStream, afterSequence: 39 } },
      {
        ...bootstrap,
        eventStream: { ...bootstrap.eventStream, retentionStartsAtSequence: 42 },
      },
      { ...bootstrap, eventStream: { ...bootstrap.eventStream, heartbeatIntervalMs: 0 } },
      { ...bootstrap, commandEndpoint: 'javascript:alert(1)' },
      { ...bootstrap, commandEndpoint: 'https://different-control-plane.example/v1/commands' },
      { ...bootstrap, commandEndpoint: '//different-control-plane.example/v1/commands' },
      { ...bootstrap, apiVersion: 'steward.ui/v2' },
      { ...bootstrap, features: null },
    ];
    for (const invalid of invalidBootstraps) {
      expect(createValidatedFrontendBootstrap(invalid)).toMatchObject({
        ok: false,
        code: 'INVALID_BOOTSTRAP',
      });
    }
  });
});
