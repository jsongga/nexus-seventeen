import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  ROLE_CAPABILITIES,
  STEWARD_RUNTIME_API_VERSION,
  STEWARD_UI_API_VERSION,
} from '#shared/protocol';
import {
  createControlPlane,
  JsonlEventStore,
  type ControlPlaneService,
} from '#server/control-plane';

const supervisorToken = 'supervisor-alpha-token-123';
const humanToken = 'human-alpha-token-456789';
const observerReadToken = 'observer-read-token-789012';
const cleanup: Array<{ directory: string; service: ControlPlaneService | undefined }> = [];

afterEach(async () => {
  for (const item of cleanup.splice(0)) {
    await item.service?.close();
    await rm(item.directory, { force: true, recursive: true });
  }
});

async function serviceFixture(
  path?: string,
  now: () => Date = () => new Date('2026-07-18T20:00:00.000Z'),
) {
  const directory = path ?? (await mkdtemp(join(tmpdir(), 'steward-service-')));
  const item: { directory: string; service: ControlPlaneService | undefined } = {
    directory,
    service: undefined,
  };
  cleanup.push(item);
  const service = await createControlPlane({
    workspaceId: 'workspace-alpha',
    storePath: join(directory, 'events.jsonl'),
    workloadIdentities: [
      {
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        role: 'engineer',
        token: supervisorToken,
      },
    ],
    humanToken,
    observerReadToken,
    corsOrigins: ['https://app.cicada.build'],
    leaseMs: 30_000,
    keepAliveMs: 1_000,
    now,
  });
  item.service = service;
  const { url } = await service.start();
  return { directory, service, url, item };
}

test('CORS preflight allows the shared UI protocol version header', async () => {
  const { url } = await serviceFixture();
  const response = await fetch(`${url}/v1/ui/bootstrap`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.cicada.build',
      'Access-Control-Request-Headers': 'Authorization, X-Steward-UI-Version',
      'Access-Control-Request-Method': 'GET',
    },
  });
  assert.equal(response.status, 204);
  assert.match(
    response.headers.get('access-control-allow-headers') ?? '',
    /X-Steward-UI-Version/u,
  );
});

test('the observer credential reads bootstrap and events without command authority', async () => {
  const fixture = await serviceFixture();
  const observerBootstrap = await requestJson(
    fixture.url,
    '/v1/ui/bootstrap',
    observerReadToken,
  );
  assert.equal(observerBootstrap.response.status, 200);
  assert.deepEqual(observerBootstrap.json.permissions, ['workspace:read']);
  assert.equal(observerBootstrap.json.userId, 'impact_observer');
  assert.equal(observerBootstrap.json.commandEndpoint, '/v1/ui/commands/disabled');
  assert.deepEqual(observerBootstrap.json.features, ['durable-replay', 'runtime-fencing']);

  const stream = await fetch(`${fixture.url}/v1/ui/events?after=0`, {
    headers: { Authorization: `Bearer ${observerReadToken}` },
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /^text\/event-stream/u);
  await stream.body?.cancel();

  const rejectedCommand = await requestJson(
    fixture.url,
    '/v1/ui/commands',
    observerReadToken,
    {},
  );
  assert.equal(rejectedCommand.response.status, 401);
  assert.equal((rejectedCommand.json.error as { code: string }).code, 'UNAUTHORIZED');

  const disabledEndpoint = await requestJson(
    fixture.url,
    '/v1/ui/commands/disabled',
    observerReadToken,
    {},
  );
  assert.equal(disabledEndpoint.response.status, 404);

  const humanBootstrap = await requestJson(fixture.url, '/v1/ui/bootstrap', humanToken);
  assert.equal(humanBootstrap.response.status, 200);
  assert.deepEqual(humanBootstrap.json.permissions, ['workspace:read', 'workspace:control']);
  assert.equal(humanBootstrap.json.commandEndpoint, '/v1/ui/commands');

  const workloadBootstrap = await requestJson(
    fixture.url,
    '/v1/ui/bootstrap',
    supervisorToken,
  );
  assert.equal(workloadBootstrap.response.status, 401);
  assert.equal(fixture.service.store.records.length, 0);
});

test('the observer credential is rejected by every runtime route', async () => {
  const fixture = await serviceFixture();
  const attempts = await Promise.all([
    requestJson(
      fixture.url,
      '/v1/runtime/register',
      observerReadToken,
      registration(),
    ),
    requestJson(fixture.url, '/v1/runtime/lease', observerReadToken, {}),
    requestJson(fixture.url, '/v1/runtime/events', observerReadToken, {}),
    requestJson(fixture.url, '/v1/runtime/commands', observerReadToken),
  ]);

  for (const attempt of attempts) {
    assert.equal(attempt.response.status, 401);
    assert.equal((attempt.json.error as { code: string }).code, 'UNAUTHORIZED');
  }
  assert.equal(fixture.service.store.records.length, 0);
});

test('observer, human, workload, review-permit, and legacy bearer tokens must be distinct', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-service-token-realms-'));
  cleanup.push({ directory, service: undefined });
  const laneIdentity = {
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    role: 'engineer' as const,
    token: supervisorToken,
  };

  await assert.rejects(
    createControlPlane({
      workspaceId: 'workspace-alpha',
      storePath: join(directory, 'human-collision.jsonl'),
      workloadIdentities: [laneIdentity],
      humanToken,
      observerReadToken: humanToken,
    }),
    /Bearer tokens must be distinct/u,
  );
  await assert.rejects(
    createControlPlane({
      workspaceId: 'workspace-alpha',
      storePath: join(directory, 'review-permit-collision.jsonl'),
      workloadIdentities: [laneIdentity],
      humanToken,
      observerReadToken,
      managerReviewPermitToken: supervisorToken,
    }),
    /Bearer tokens must be distinct/u,
  );
  await assert.rejects(
    createControlPlane({
      workspaceId: 'workspace-alpha',
      storePath: join(directory, 'workload-collision.jsonl'),
      workloadIdentities: [laneIdentity],
      humanToken,
      observerReadToken: supervisorToken,
    }),
    /Bearer tokens must be distinct/u,
  );
  await assert.rejects(
    createControlPlane({
      workspaceId: 'workspace-alpha',
      storePath: join(directory, 'legacy-collision.jsonl'),
      developmentMode: true,
      legacyDevSupervisorToken: supervisorToken,
      humanToken,
      observerReadToken: supervisorToken,
    }),
    /Bearer tokens must be distinct/u,
  );
});

test('production-style configuration requires a lane-bound workload identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-service-config-'));
  cleanup.push({ directory, service: undefined });
  await assert.rejects(
    createControlPlane({
      workspaceId: 'workspace-alpha',
      storePath: join(directory, 'events.jsonl'),
      humanToken,
      observerReadToken,
    }),
    /lane-bound workload identity/u,
  );
});

test('the shared legacy development credential is opt-in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-service-legacy-'));
  const item: { directory: string; service: ControlPlaneService | undefined } = {
    directory,
    service: undefined,
  };
  cleanup.push(item);
  const service = await createControlPlane({
    workspaceId: 'workspace-alpha',
    storePath: join(directory, 'events.jsonl'),
    developmentMode: true,
    legacyDevSupervisorToken: supervisorToken,
    humanToken,
    observerReadToken,
    now: () => new Date('2026-07-18T20:00:00.000Z'),
  });
  item.service = service;
  const { url } = await service.start();
  const registered = await requestJson(
    url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );
  assert.equal(registered.response.status, 200);
});

test('the shared legacy credential is rejected without explicit development mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-service-legacy-config-'));
  cleanup.push({ directory, service: undefined });
  await assert.rejects(
    createControlPlane({
      workspaceId: 'workspace-alpha',
      storePath: join(directory, 'events.jsonl'),
      legacyDevSupervisorToken: supervisorToken,
      humanToken,
      observerReadToken,
    } as Parameters<typeof createControlPlane>[0]),
    /requires explicit developmentMode: true/u,
  );
});

test('the shared legacy credential cannot bind to a network-facing host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-service-legacy-host-'));
  cleanup.push({ directory, service: undefined });
  await assert.rejects(
    createControlPlane({
      workspaceId: 'workspace-alpha',
      storePath: join(directory, 'events.jsonl'),
      developmentMode: true,
      legacyDevSupervisorToken: supervisorToken,
      humanToken,
      observerReadToken,
      host: '0.0.0.0',
    }),
    /only bind to a loopback host/u,
  );
});

test('a lane-bound credential cannot self-assert another role on initial registration', async () => {
  const fixture = await serviceFixture();
  const countBeforeAttempt = fixture.service.store.records.length;
  const rejected = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    {
      ...registration(),
      role: 'manager',
      capabilities: ROLE_CAPABILITIES.manager,
    },
  );

  assert.equal(rejected.response.status, 403);
  assert.equal((rejected.json.error as { code: string }).code, 'WORKLOAD_ROLE_MISMATCH');
  assert.equal(fixture.service.store.records.length, countBeforeAttempt);

  const authorized = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );
  assert.equal(authorized.response.status, 200);
  assert.equal(authorized.json.runtimeEpoch, 1);
});

test('a lane-bound credential cannot change role during runtime replacement', async () => {
  const fixture = await serviceFixture();
  const registered = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );
  assert.equal(registered.response.status, 200);

  const countBeforeAttempt = fixture.service.store.records.length;
  const rejected = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    {
      ...registration(1, 'runtime-role-drift'),
      role: 'manager',
      capabilities: ROLE_CAPABILITIES.manager,
    },
  );

  assert.equal(rejected.response.status, 403);
  assert.equal((rejected.json.error as { code: string }).code, 'WORKLOAD_ROLE_MISMATCH');
  assert.equal(fixture.service.store.records.length, countBeforeAttempt);

  const authorized = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(1, 'runtime-authorized-replacement'),
  );
  assert.equal(authorized.response.status, 200);
  assert.equal(authorized.json.runtimeEpoch, 2);
});

test('a pre-CAS alpha registration remains replaceable after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-service-migration-'));
  const item: { directory: string; service: ControlPlaneService | undefined } = {
    directory,
    service: undefined,
  };
  cleanup.push(item);
  const storePath = join(directory, 'events.jsonl');
  const store = await JsonlEventStore.open({
    path: storePath,
    workspaceId: 'workspace-alpha',
    now: () => new Date('2026-07-18T20:00:00.000Z'),
  });
  await store.append([
    {
      eventId: 'registration:lane-patch:1',
      idempotencyKey: 'registration:lane-patch:1',
      kind: 'lane.registered',
      laneId: 'lane-patch',
      actor: 'supervisor',
      data: {
        request: {
          apiVersion: STEWARD_RUNTIME_API_VERSION,
          workspaceId: 'workspace-alpha',
          agentId: 'agent-patch',
          laneId: 'lane-patch',
          runtimeInstanceId: 'runtime-alpha-before-cas',
          runtimeEpoch: 1,
          displayName: 'Patch',
          role: 'engineer',
          capabilities: ROLE_CAPABILITIES.engineer,
          provider: { name: 'codex', model: 'gpt-5.4-mini' },
          softwareVersion: '0.1.0',
          checkpointRef: null,
        },
        leaseId: 'lease-before-cas',
        leaseGrantedAt: '2026-07-18T20:00:00.000Z',
        leaseExpiresAt: '2026-07-18T20:00:30.000Z',
      },
    },
  ]);
  await store.close();

  const service = await createControlPlane({
    workspaceId: 'workspace-alpha',
    storePath,
    workloadIdentities: [
      {
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        role: 'engineer',
        token: supervisorToken,
      },
    ],
    humanToken,
    observerReadToken,
    now: () => new Date('2026-07-18T20:00:01.000Z'),
  });
  item.service = service;
  const { url } = await service.start();
  const replacement = await requestJson(
    url,
    '/v1/runtime/register',
    supervisorToken,
    registration(1, 'runtime-after-cas-migration'),
  );
  assert.equal(replacement.response.status, 200);
  assert.equal(replacement.json.runtimeEpoch, 2);
});

async function requestJson(
  url: string,
  path: string,
  token: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await response.json()) as Record<string, unknown>;
  return { response, json };
}

function registration(
  expectedRuntimeEpoch: number | null = null,
  runtimeInstanceId = 'runtime-1',
) {
  return {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId,
    expectedRuntimeEpoch,
    displayName: 'Patch',
    role: 'engineer',
    capabilities: ROLE_CAPABILITIES.engineer,
    provider: { name: 'codex', model: 'gpt-5.4-mini' },
    softwareVersion: '0.1.0',
    checkpointRef: null,
  };
}

function heartbeat(runtimeEpoch: number, runtimeInstanceId: string, localSequence: number) {
  return {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    eventId: `event-${runtimeEpoch}-${localSequence}`,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId,
    localSequence,
    runtimeEpoch,
    occurredAt: '2026-07-18T20:00:00.000Z',
    payload: { type: 'heartbeat', currentAction: null, checkpointRef: null },
  };
}

function batch(event: ReturnType<typeof heartbeat>) {
  return {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: event.workspaceId,
    agentId: event.agentId,
    laneId: event.laneId,
    runtimeInstanceId: event.runtimeInstanceId,
    runtimeEpoch: event.runtimeEpoch,
    events: [event],
  };
}

test('a workload credential cannot impersonate another lane on any runtime endpoint', async () => {
  const fixture = await serviceFixture();
  const unauthenticated = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    'unconfigured-token-123456',
    registration(),
  );
  assert.equal(unauthenticated.response.status, 401);
  const registered = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );
  assert.equal(registered.response.status, 200);

  const intruder = {
    workspaceId: 'workspace-alpha',
    agentId: 'agent-intruder',
    laneId: 'lane-intruder',
  };
  const crossRegistration = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    {
      ...registration(null, 'runtime-intruder'),
      ...intruder,
    },
  );
  assert.equal(crossRegistration.response.status, 403);

  const crossLease = await requestJson(fixture.url, '/v1/runtime/lease', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    ...intruder,
    runtimeInstanceId: 'runtime-intruder',
    runtimeEpoch: 1,
    leaseId: registered.json.leaseId,
    lastDurableEventSequence: 0,
    sentAt: '2026-07-18T20:00:00.000Z',
  });
  assert.equal(crossLease.response.status, 403);

  const crossEvents = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    ...intruder,
    runtimeInstanceId: 'runtime-intruder',
    runtimeEpoch: 1,
    events: [
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-intruder-1',
        ...intruder,
        runtimeInstanceId: 'runtime-intruder',
        localSequence: 1,
        runtimeEpoch: 1,
        occurredAt: '2026-07-18T20:00:00.000Z',
        payload: { type: 'heartbeat', currentAction: null, checkpointRef: null },
      },
    ],
  });
  assert.equal(crossEvents.response.status, 403);

  const query = new URLSearchParams({
    ...intruder,
    runtimeInstanceId: 'runtime-intruder',
    runtimeEpoch: '1',
    after: '0',
  });
  const crossCommands = await requestJson(
    fixture.url,
    `/v1/runtime/commands?${query}`,
    supervisorToken,
  );
  assert.equal(crossCommands.response.status, 403);

  for (const result of [crossRegistration, crossLease, crossEvents, crossCommands]) {
    assert.equal(
      (result.json.error as { code: string }).code,
      'WORKLOAD_IDENTITY_MISMATCH',
    );
  }
  assert.equal(fixture.service.store.records.length, 1);
});

test('registration CAS allows exactly one concurrent replacement', async () => {
  const fixture = await serviceFixture();
  await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );
  const contenders = await Promise.all([
    requestJson(
      fixture.url,
      '/v1/runtime/register',
      supervisorToken,
      registration(1, 'runtime-contender-a'),
    ),
    requestJson(
      fixture.url,
      '/v1/runtime/register',
      supervisorToken,
      registration(1, 'runtime-contender-b'),
    ),
  ]);
  assert.deepEqual(
    contenders.map((result) => result.response.status).sort(),
    [200, 409],
  );
  const accepted = contenders.find((result) => result.response.status === 200);
  const rejected = contenders.find((result) => result.response.status === 409);
  assert.equal(accepted?.json.runtimeEpoch, 2);
  assert.equal(
    ((rejected?.json.error as { code?: string } | undefined)?.code),
    'REGISTRATION_CAS_CONFLICT',
  );
});

test('the server-issued fence applies uniformly to leases, events, and command queries', async () => {
  const fixture = await serviceFixture();
  const initial = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );
  assert.equal(initial.response.status, 200);
  const validRenewal = await requestJson(fixture.url, '/v1/runtime/lease', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    leaseId: initial.json.leaseId,
    lastDurableEventSequence: 0,
    sentAt: '2026-07-18T20:00:00.000Z',
  });
  assert.equal(validRenewal.response.status, 200);

  const replacement = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(1, 'runtime-2'),
  );
  assert.equal(replacement.response.status, 200);
  assert.equal(replacement.json.runtimeEpoch, 2);

  const staleLease = await requestJson(fixture.url, '/v1/runtime/lease', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    leaseId: initial.json.leaseId,
    lastDurableEventSequence: 0,
    sentAt: '2026-07-18T20:00:00.000Z',
  });
  const staleEvents = await requestJson(
    fixture.url,
    '/v1/runtime/events',
    supervisorToken,
    batch(heartbeat(1, 'runtime-1', 1)),
  );
  const staleQuery = new URLSearchParams({
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: '1',
    after: '0',
  });
  const staleCommands = await requestJson(
    fixture.url,
    `/v1/runtime/commands?${staleQuery}`,
    supervisorToken,
  );
  for (const result of [staleLease, staleEvents, staleCommands]) {
    assert.equal(result.response.status, 409);
    assert.equal((result.json.error as { code: string }).code, 'RUNTIME_FENCED');
  }

  const currentQuery = new URLSearchParams({
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-2',
    runtimeEpoch: '2',
    after: '0',
  });
  const currentCommands = await requestJson(
    fixture.url,
    `/v1/runtime/commands?${currentQuery}`,
    supervisorToken,
  );
  assert.equal(currentCommands.response.status, 200);
});

test('runtime epochs preserve the durable prefix across restart and fence stale writers', async () => {
  const fixture = await serviceFixture();
  const first = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );
  assert.equal(first.response.status, 200);
  assert.equal(first.json.runtimeEpoch, 1);

  const firstHeartbeat = heartbeat(1, 'runtime-1', 1);
  const accepted = await requestJson(
    fixture.url,
    '/v1/runtime/events',
    supervisorToken,
    batch(firstHeartbeat),
  );
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.json.acceptedThroughLocalSequence, 1);
  const durableCount = fixture.service.store.records.length;

  const duplicate = await requestJson(
    fixture.url,
    '/v1/runtime/events',
    supervisorToken,
    batch(firstHeartbeat),
  );
  assert.equal(duplicate.response.status, 200);
  assert.equal(fixture.service.store.records.length, durableCount);

  await fixture.service.close();
  fixture.item.service = undefined;
  const restarted = await serviceFixture(fixture.directory);

  const countBeforeRoleDrift = restarted.service.store.records.length;
  const roleDrift = await requestJson(
    restarted.url,
    '/v1/runtime/register',
    supervisorToken,
    {
      ...registration(1, 'runtime-2'),
      role: 'manager',
      capabilities: ROLE_CAPABILITIES.manager,
    },
  );
  assert.equal(roleDrift.response.status, 403);
  assert.equal((roleDrift.json.error as { code: string }).code, 'WORKLOAD_ROLE_MISMATCH');
  assert.equal(restarted.service.store.records.length, countBeforeRoleDrift);

  const second = await requestJson(
    restarted.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(1, 'runtime-2'),
  );
  assert.equal(second.response.status, 200);
  assert.equal(second.json.lastAcceptedLocalSequence, 1);

  const stale = await requestJson(
    restarted.url,
    '/v1/runtime/events',
    supervisorToken,
    batch(heartbeat(1, 'runtime-1', 2)),
  );
  assert.equal(stale.response.status, 409);
  assert.equal((stale.json.error as { code: string }).code, 'RUNTIME_FENCED');

  const rebased = await requestJson(
    restarted.url,
    '/v1/runtime/events',
    supervisorToken,
    batch(heartbeat(2, 'runtime-2', 2)),
  );
  assert.equal(rebased.response.status, 200);
  assert.equal(rebased.json.acceptedThroughLocalSequence, 2);

  const gap = await requestJson(
    restarted.url,
    '/v1/runtime/events',
    supervisorToken,
    batch(heartbeat(2, 'runtime-2', 4)),
  );
  assert.equal(gap.response.status, 409);
  assert.equal((gap.json.error as { code: string }).code, 'LOCAL_SEQUENCE_GAP');
});

test('registration issues contiguous epochs, deduplicates retries, and requires replacement after expiry', async () => {
  let nowMs = Date.parse('2026-07-18T20:00:00.000Z');
  const fixture = await serviceFixture(undefined, () => new Date(nowMs));
  const initial = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(null, 'runtime-after-offline-restarts'),
  );
  assert.equal(initial.response.status, 200);
  assert.equal(initial.json.runtimeEpoch, 1);
  const countAfterInitial = fixture.service.store.records.length;

  const retry = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(null, 'runtime-after-offline-restarts'),
  );
  assert.equal(retry.response.status, 200);
  assert.equal(retry.json.runtimeEpoch, 1);
  assert.equal(retry.json.leaseId, initial.json.leaseId);
  assert.equal(fixture.service.store.records.length, countAfterInitial);

  const skippedEpoch = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(3, 'runtime-skipped-epoch'),
  );
  assert.equal(skippedEpoch.response.status, 409);
  assert.equal(
    (skippedEpoch.json.error as { code: string }).code,
    'REGISTRATION_CAS_CONFLICT',
  );

  nowMs += 31_000;
  const expiredRetry = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(null, 'runtime-after-offline-restarts'),
  );
  assert.equal(expiredRetry.response.status, 409);
  assert.equal(
    (expiredRetry.json.error as { code: string }).code,
    'LEASE_EXPIRED_REPLACEMENT_REQUIRED',
  );

  const reclaimed = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(1, 'runtime-after-more-offline-restarts'),
  );
  assert.equal(reclaimed.response.status, 200);
  assert.equal(reclaimed.json.runtimeEpoch, 2);

  const staleReplacement = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(1, 'runtime-with-stale-cas'),
  );
  assert.equal(staleReplacement.response.status, 409);
  assert.equal(
    (staleReplacement.json.error as { code: string }).code,
    'REGISTRATION_CAS_CONFLICT',
  );
});

test('invalid runtime task semantics are rejected before the durable append', async () => {
  const fixture = await serviceFixture();
  await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );
  const beforeUnknown = fixture.service.store.records.length;
  const unknown = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: [
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-unknown-task',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-1',
        localSequence: 1,
        runtimeEpoch: 1,
        occurredAt: '2026-07-18T19:05:00.000Z',
        payload: {
          type: 'progress',
          taskId: 'task-missing',
          phase: 'research',
          iteration: 1,
          journal: 'This must not reach durable storage.',
        },
      },
    ],
  });
  assert.equal(unknown.response.status, 409);
  assert.equal((unknown.json.error as { code: string }).code, 'RUNTIME_TASK_UNKNOWN');
  assert.equal(fixture.service.store.records.length, beforeUnknown);

  await requestJson(fixture.url, '/v1/ui/commands', humanToken, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'human-order-command',
    workspaceId: 'workspace-alpha',
    expectedControlVersion: 0,
    issuedAt: '2026-07-18T19:00:00.000Z',
    payload: {
      type: 'queue_work',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      title: 'Follow the delivery loop',
      objective: 'Make each engineering phase reviewable.',
      expectedAgentMinutes: 15,
      expectedCompletedAt: '2026-07-18T19:15:00.000Z',
    },
  });
  const lane = fixture.service.projection.requireLane('lane-patch');
  const assign = lane.runtimeCommands.find((command) => command.payload.type === 'assign_task');
  assert.ok(assign);
  assert.equal(assign.payload.type, 'assign_task');
  const beforeOutOfOrder = fixture.service.store.records.length;
  const outOfOrder = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: [
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-plan-before-research',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-1',
        localSequence: 1,
        runtimeEpoch: 1,
        occurredAt: '2026-07-18T19:05:00.000Z',
        payload: {
          type: 'progress',
          taskId: assign.payload.task.taskId,
          phase: 'plan',
          iteration: 1,
          journal: 'Planning cannot precede recorded research.',
        },
      },
    ],
  });
  assert.equal(outOfOrder.response.status, 409);
  assert.equal((outOfOrder.json.error as { code: string }).code, 'PROGRESS_ORDER_CONFLICT');
  assert.equal(fixture.service.store.records.length, beforeOutOfOrder);

  const prematureCompletion = await requestJson(
    fixture.url,
    '/v1/runtime/events',
    supervisorToken,
    {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: 'workspace-alpha',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      runtimeInstanceId: 'runtime-1',
      runtimeEpoch: 1,
      events: [
        {
          apiVersion: STEWARD_RUNTIME_API_VERSION,
          eventId: 'event-complete-before-pass',
          workspaceId: 'workspace-alpha',
          agentId: 'agent-patch',
          laneId: 'lane-patch',
          runtimeInstanceId: 'runtime-1',
          localSequence: 1,
          runtimeEpoch: 1,
          occurredAt: '2026-07-18T19:06:00.000Z',
          payload: {
            type: 'task_completed',
            taskId: assign.payload.task.taskId,
            result: 'This result has no passing test evidence.',
            checkpointRef: null,
          },
        },
      ],
    },
  );
  assert.equal(prematureCompletion.response.status, 409);
  assert.equal(
    (prematureCompletion.json.error as { code: string }).code,
    'TASK_COMPLETION_WITHOUT_PASS',
  );
  assert.equal(fixture.service.store.records.length, beforeOutOfOrder);

  const beforeInvalidResume = fixture.service.store.records.length;
  const invalidResume = await requestJson(
    fixture.url,
    '/v1/ui/commands',
    humanToken,
    {
      apiVersion: STEWARD_UI_API_VERSION,
      clientCommandId: 'human-resume-queued-task',
      workspaceId: 'workspace-alpha',
      expectedControlVersion: 1,
      issuedAt: '2026-07-18T19:07:00.000Z',
      payload: {
        type: 'resume_agent',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        taskId: assign.payload.task.taskId,
        checkpointRef: null,
      },
    },
  );
  assert.equal(invalidResume.response.status, 409);
  assert.equal(
    (invalidResume.json.error as { code: string }).code,
    'AGENT_NOT_PAUSED',
  );
  assert.equal(fixture.service.store.records.length, beforeInvalidResume);
  assert.equal(
    (await requestJson(fixture.url, '/v1/ui/bootstrap', humanToken)).response.status,
    200,
  );

  const forgedInterrupt = await requestJson(
    fixture.url,
    '/v1/runtime/events',
    supervisorToken,
    {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: 'workspace-alpha',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      runtimeInstanceId: 'runtime-1',
      runtimeEpoch: 1,
      events: [
        {
          apiVersion: STEWARD_RUNTIME_API_VERSION,
          eventId: 'event-forged-interrupt-ack',
          workspaceId: 'workspace-alpha',
          agentId: 'agent-patch',
          laneId: 'lane-patch',
          runtimeInstanceId: 'runtime-1',
          localSequence: 1,
          runtimeEpoch: 1,
          occurredAt: '2026-07-18T19:08:00.000Z',
          payload: {
            type: 'interrupt_acknowledged',
            commandId: 'command-never-issued',
            taskId: null,
          },
        },
      ],
    },
  );
  assert.equal(forgedInterrupt.response.status, 409);
  assert.equal(
    (forgedInterrupt.json.error as { code: string }).code,
    'INTERRUPT_CAUSATION_CONFLICT',
  );
  assert.equal(fixture.service.store.records.length, beforeInvalidResume);

  await fixture.service.close();
  fixture.item.service = undefined;
  const restarted = await serviceFixture(fixture.directory);
  assert.equal(restarted.service.store.records.length, beforeOutOfOrder);
  assert.equal(restarted.service.projection.lastSequence, beforeOutOfOrder);
});

test('runtime event time is bounded without rejecting ordinary offline uploads', async () => {
  const fixture = await serviceFixture();
  await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );
  const before = fixture.service.store.records.length;
  const poisoned = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: [
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-impossible-future-time',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-1',
        localSequence: 1,
        runtimeEpoch: 1,
        occurredAt: '9999-12-31T23:59:59.000Z',
        payload: { type: 'heartbeat', currentAction: null, checkpointRef: null },
      },
    ],
  });
  assert.equal(poisoned.response.status, 409);
  assert.equal(
    (poisoned.json.error as { code: string }).code,
    'RUNTIME_EVENT_TIME_SKEW',
  );
  assert.equal(fixture.service.store.records.length, before);
});

test('agent-authored task and progress times survive delayed upload and restart', async () => {
  const fixture = await serviceFixture();
  await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );

  const queued = await requestJson(fixture.url, '/v1/ui/commands', humanToken, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'human-timing-command',
    workspaceId: 'workspace-alpha',
    expectedControlVersion: 0,
    issuedAt: '2026-07-18T19:00:00.000Z',
    payload: {
      type: 'queue_work',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      title: 'Recover delayed work',
      objective: 'Restore task history after a control-plane outage.',
      expectedAgentMinutes: 30,
      expectedCompletedAt: '2026-07-18T19:30:00.000Z',
    },
  });
  assert.equal(queued.response.status, 200);

  const lane = fixture.service.projection.requireLane('lane-patch');
  const assign = lane.runtimeCommands.find((command) => command.payload.type === 'assign_task');
  assert.ok(assign);
  assert.equal(assign.payload.type, 'assign_task');
  const taskId = assign.payload.task.taskId;
  assert.equal(
    fixture.service.projection.requireTask(taskId).expectedCompletedAt,
    '2026-07-18T20:30:00.000Z',
    'the server must ignore a client-authored absolute forecast',
  );
  const startedAt = '2026-07-18T19:05:00.000Z';
  const endedAt = '2026-07-18T19:12:00.000Z';
  const progressTimes = [
    '2026-07-18T19:06:00.000Z',
    '2026-07-18T19:07:00.000Z',
    '2026-07-18T19:08:00.000Z',
    '2026-07-18T19:11:00.000Z',
  ];
  const events = [
    {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      eventId: 'event-delayed-heartbeat',
      workspaceId: 'workspace-alpha',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      runtimeInstanceId: 'runtime-1',
      localSequence: 1,
      runtimeEpoch: 1,
      occurredAt: startedAt,
      payload: {
        type: 'heartbeat',
        currentAction: {
          taskId,
          summary: 'Researching the user-visible failure.',
          startedAt,
        },
        checkpointRef: null,
      },
    },
    ...(['research', 'plan', 'execute', 'test'] as const).map((phase, index) => ({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      eventId: `event-delayed-${phase}`,
      workspaceId: 'workspace-alpha',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      runtimeInstanceId: 'runtime-1',
      localSequence: index + 2,
      runtimeEpoch: 1,
      occurredAt: progressTimes[index],
      payload: {
        type: 'progress',
        taskId,
        phase,
        iteration: 1,
        journal: `${phase} produced reviewable task evidence.`,
        ...(phase === 'test' ? { outcome: 'passed' as const } : {}),
      },
    })),
    {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      eventId: 'event-delayed-complete',
      workspaceId: 'workspace-alpha',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      runtimeInstanceId: 'runtime-1',
      localSequence: 6,
      runtimeEpoch: 1,
      occurredAt: endedAt,
      payload: {
        type: 'task_completed',
        taskId,
        result: 'Task history is available again.',
        checkpointRef: null,
      },
    },
  ];
  const uploadedProgress = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: events.slice(0, -1),
  });
  assert.equal(uploadedProgress.response.status, 200);

  const completionEvent = events.at(-1);
  assert.ok(completionEvent);
  const regressedCompletion = await requestJson(
    fixture.url,
    '/v1/runtime/events',
    supervisorToken,
    {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: 'workspace-alpha',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      runtimeInstanceId: 'runtime-1',
      runtimeEpoch: 1,
      events: [{ ...completionEvent, occurredAt: '2026-07-18T19:04:00.000Z' }],
    },
  );
  assert.equal(regressedCompletion.response.status, 409);
  assert.equal(
    (regressedCompletion.json.error as { code: string }).code,
    'TASK_TIME_REGRESSION',
  );

  const uploaded = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: [completionEvent],
  });
  assert.equal(uploaded.response.status, 200);

  const task = fixture.service.projection.requireTask(taskId);
  assert.equal(task.startedAt, startedAt);
  assert.equal(task.endedAt, endedAt);
  assert.equal(task.expectedCompletedAt, '2026-07-18T19:45:00.000Z');
  assert.equal(
    fixture.service.projection.progress.get(taskId)?.[0]?.occurredAt,
    progressTimes[0],
  );
  const bootstrap = await requestJson(fixture.url, '/v1/ui/bootstrap', humanToken);
  const snapshot = bootstrap.json.snapshot as {
    progress: Array<{ taskId: string; phase: string; occurredAt: string }>;
  };
  assert.deepEqual(
    snapshot.progress.map((entry) => [entry.taskId, entry.phase, entry.occurredAt]),
    (['research', 'plan', 'execute', 'test'] as const).map((phase, index) => [
      taskId,
      phase,
      progressTimes[index],
    ]),
  );

  await fixture.service.close();
  fixture.item.service = undefined;
  const restarted = await serviceFixture(fixture.directory);
  const rebuilt = restarted.service.projection.requireTask(taskId);
  assert.equal(rebuilt.startedAt, startedAt);
  assert.equal(rebuilt.endedAt, endedAt);
  assert.equal(
    restarted.service.projection.progress.get(taskId)?.[0]?.occurredAt,
    progressTimes[0],
  );
});

test('human pause time shifts the agent-only forecast to the next 15-minute boundary', async () => {
  let now = new Date('2026-07-18T20:00:00.000Z');
  const fixture = await serviceFixture(undefined, () => now);
  await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );
  await requestJson(fixture.url, '/v1/ui/commands', humanToken, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'human-forecast-task',
    workspaceId: 'workspace-alpha',
    expectedControlVersion: 0,
    issuedAt: '2026-07-18T20:00:00.000Z',
    payload: {
      type: 'queue_work',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      title: 'Keep an agent-only forecast',
      objective: 'Do not count time spent waiting for a human response as agent work.',
      expectedAgentMinutes: 30,
      expectedCompletedAt: '2026-07-18T20:30:00.000Z',
    },
  });
  const lane = fixture.service.projection.requireLane('lane-patch');
  const taskId = lane.queue[0];
  assert.ok(taskId);

  const start = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: [
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-forecast-start',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-1',
        localSequence: 1,
        runtimeEpoch: 1,
        occurredAt: '2026-07-18T20:00:02.000Z',
        payload: {
          type: 'heartbeat',
          currentAction: {
            taskId,
            summary: 'Researching the task.',
            startedAt: '2026-07-18T20:00:02.000Z',
          },
          checkpointRef: null,
        },
      },
    ],
  });
  assert.equal(start.response.status, 200);
  assert.equal(
    fixture.service.projection.requireTask(taskId).expectedCompletedAt,
    '2026-07-18T20:45:00.000Z',
  );

  await requestJson(fixture.url, '/v1/ui/commands', humanToken, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'human-forecast-interrupt',
    workspaceId: 'workspace-alpha',
    expectedControlVersion: 1,
    issuedAt: '2026-07-18T20:04:00.000Z',
    payload: {
      type: 'request_interrupt',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      reason: 'Pause for a human product decision.',
    },
  });
  const interrupt = [...lane.runtimeCommands]
    .reverse()
    .find((command) => command.payload.type === 'request_interrupt');
  assert.ok(interrupt);
  const settled = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: [
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-forecast-interrupt-ack',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-1',
        localSequence: 2,
        runtimeEpoch: 1,
        occurredAt: '2026-07-18T20:00:04.000Z',
        payload: {
          type: 'interrupt_acknowledged',
          commandId: interrupt.commandId,
          taskId,
        },
      },
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-forecast-interrupt-settled',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-1',
        localSequence: 3,
        runtimeEpoch: 1,
        occurredAt: '2026-07-18T20:00:05.000Z',
        payload: {
          type: 'interrupt_settled',
          commandId: interrupt.commandId,
          taskId,
          checkpointRef: 'checkpoint-forecast-pause',
        },
      },
    ],
  });
  assert.equal(settled.response.status, 200);
  assert.equal(fixture.service.projection.requireTask(taskId).status, 'paused');

  const commandsBeforeWorkspaceOverlay = lane.runtimeCommands.length;
  const workspacePause = await requestJson(fixture.url, '/v1/ui/commands', humanToken, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'human-forecast-workspace-pause',
    workspaceId: 'workspace-alpha',
    expectedControlVersion: 2,
    issuedAt: '2026-07-18T20:06:00.000Z',
    payload: {
      type: 'set_workspace_pause',
      paused: true,
      reason: 'Pause the rest of the workspace without changing this individual stop.',
    },
  });
  assert.equal(workspacePause.response.status, 200);
  assert.equal(lane.controlState, 'paused');
  assert.equal(lane.runtimeCommands.length, commandsBeforeWorkspaceOverlay);
  const workspaceResume = await requestJson(fixture.url, '/v1/ui/commands', humanToken, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'human-forecast-workspace-resume',
    workspaceId: 'workspace-alpha',
    expectedControlVersion: 3,
    issuedAt: '2026-07-18T20:07:00.000Z',
    payload: {
      type: 'set_workspace_pause',
      paused: false,
      reason: 'Resume only agents that the workspace pause stopped.',
    },
  });
  assert.equal(workspaceResume.response.status, 200);
  assert.equal(lane.controlState, 'paused');
  assert.equal(fixture.service.projection.requireTask(taskId).status, 'paused');
  assert.equal(lane.runtimeCommands.length, commandsBeforeWorkspaceOverlay);

  now = new Date('2026-07-18T20:00:18.000Z');
  const resumed = await requestJson(fixture.url, '/v1/ui/commands', humanToken, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'human-forecast-resume',
    workspaceId: 'workspace-alpha',
    expectedControlVersion: 4,
    issuedAt: '2026-07-18T20:18:00.000Z',
    payload: {
      type: 'resume_agent',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      taskId,
      checkpointRef: 'checkpoint-forecast-pause',
    },
  });
  assert.equal(resumed.response.status, 200);
  assert.equal(lane.controlState, 'resume_requested');
  assert.equal(fixture.service.projection.requireTask(taskId).status, 'paused');
  now = new Date('2026-07-18T20:00:00.000Z');
  const confirmed = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: [
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-forecast-resume-confirmed',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-1',
        localSequence: 4,
        runtimeEpoch: 1,
        occurredAt: '2026-07-18T20:00:18.000Z',
        payload: {
          type: 'heartbeat',
          currentAction: {
            taskId,
            summary: 'Resuming after the human decision.',
            startedAt: '2026-07-18T20:00:18.000Z',
          },
          checkpointRef: 'checkpoint-forecast-pause',
        },
      },
    ],
  });
  assert.equal(confirmed.response.status, 200);
  const task = fixture.service.projection.requireTask(taskId);
  assert.equal(task.status, 'running');
  assert.equal(task.startedAt, '2026-07-18T20:00:02.000Z');
  assert.equal(task.endedAt, null);
  assert.equal(task.expectedCompletedAt, '2026-07-18T21:00:00.000Z');
});

test('workspace hold accepts pre-settlement evidence and rejects post-settlement work', async () => {
  let now = new Date('2026-07-18T20:00:00.000Z');
  const fixture = await serviceFixture(undefined, () => now);
  await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );
  await requestJson(fixture.url, '/v1/ui/commands', humanToken, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'human-hold-task',
    workspaceId: 'workspace-alpha',
    expectedControlVersion: 0,
    issuedAt: '2026-07-18T20:00:00.000Z',
    payload: {
      type: 'queue_work',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      title: 'Reach a causal hold boundary',
      objective: 'Keep evidence produced before a human pause and stop work after settlement.',
      expectedAgentMinutes: 15,
      expectedCompletedAt: '2026-07-18T20:15:00.000Z',
    },
  });
  const lane = fixture.service.projection.requireLane('lane-patch');
  const taskId = lane.queue[0];
  assert.ok(taskId);
  const started = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: [
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-hold-start',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-1',
        localSequence: 1,
        runtimeEpoch: 1,
        occurredAt: '2026-07-18T20:00:01.000Z',
        payload: {
          type: 'heartbeat',
          currentAction: {
            taskId,
            summary: 'Researching before the hold arrives.',
            startedAt: '2026-07-18T20:00:01.000Z',
          },
          checkpointRef: null,
        },
      },
    ],
  });
  assert.equal(started.response.status, 200);

  const pause = await requestJson(fixture.url, '/v1/ui/commands', humanToken, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'human-workspace-hold',
    workspaceId: 'workspace-alpha',
    expectedControlVersion: 1,
    issuedAt: '2026-07-18T20:02:00.000Z',
    payload: {
      type: 'set_workspace_pause',
      paused: true,
      reason: 'Human review requires a clean provider boundary.',
    },
  });
  assert.equal(pause.response.status, 200);
  assert.equal(fixture.service.projection.workspacePaused, true);
  assert.equal(lane.controlState, 'hold_requested');
  const hold = [...lane.runtimeCommands]
    .reverse()
    .find((command) => command.payload.type === 'hold');
  assert.ok(hold);

  const inFlight = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: [
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-hold-in-flight-research',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-1',
        localSequence: 2,
        runtimeEpoch: 1,
        occurredAt: '2026-07-18T20:00:02.000Z',
        payload: {
          type: 'progress',
          taskId,
          phase: 'research',
          iteration: 1,
          journal: 'This evidence was already in flight when the hold was requested.',
        },
      },
    ],
  });
  assert.equal(inFlight.response.status, 200);

  const lifecycle = [
    {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      eventId: 'event-hold-ack',
      workspaceId: 'workspace-alpha',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      runtimeInstanceId: 'runtime-1',
      localSequence: 3,
      runtimeEpoch: 1,
      occurredAt: '2026-07-18T20:00:03.000Z',
      payload: {
        type: 'hold_acknowledged',
        commandId: hold.commandId,
        taskId,
      },
    },
    {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      eventId: 'event-hold-settled',
      workspaceId: 'workspace-alpha',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      runtimeInstanceId: 'runtime-1',
      localSequence: 4,
      runtimeEpoch: 1,
      occurredAt: '2026-07-18T20:00:04.000Z',
      payload: {
        type: 'hold_settled',
        commandId: hold.commandId,
        taskId,
        checkpointRef: 'checkpoint-workspace-hold',
      },
    },
  ] as const;
  const beforeBypass = fixture.service.store.records.length;
  const bypass = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: [
      ...lifecycle,
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-hold-post-settlement-plan',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-1',
        localSequence: 5,
        runtimeEpoch: 1,
        occurredAt: '2026-07-18T20:00:05.000Z',
        payload: {
          type: 'progress',
          taskId,
          phase: 'plan',
          iteration: 1,
          journal: 'This work is after the settled human hold and must be rejected.',
        },
      },
    ],
  });
  assert.equal(bypass.response.status, 409);
  assert.equal((bypass.json.error as { code: string }).code, 'RUNTIME_LANE_HELD');
  assert.equal(fixture.service.store.records.length, beforeBypass);

  const settled = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: lifecycle,
  });
  assert.equal(settled.response.status, 200);
  assert.equal(lane.controlState, 'held');
  assert.equal(lane.currentAction, null);
  assert.equal(fixture.service.projection.requireTask(taskId).status, 'paused');

  now = new Date('2026-07-18T20:00:10.000Z');
  const resume = await requestJson(fixture.url, '/v1/ui/commands', humanToken, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'human-workspace-resume',
    workspaceId: 'workspace-alpha',
    expectedControlVersion: 2,
    issuedAt: '2026-07-18T20:10:00.000Z',
    payload: {
      type: 'set_workspace_pause',
      paused: false,
      reason: 'Human review is complete.',
    },
  });
  assert.equal(resume.response.status, 200);
  assert.equal(fixture.service.projection.workspacePaused, false);
  assert.equal(lane.controlState, 'resume_requested');
  assert.equal(fixture.service.projection.requireTask(taskId).status, 'paused');
  now = new Date('2026-07-18T20:00:00.000Z');
  const resumeConfirmed = await requestJson(
    fixture.url,
    '/v1/runtime/events',
    supervisorToken,
    {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: 'workspace-alpha',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      runtimeInstanceId: 'runtime-1',
      runtimeEpoch: 1,
      events: [
        {
          apiVersion: STEWARD_RUNTIME_API_VERSION,
          eventId: 'event-workspace-resume-confirmed',
          workspaceId: 'workspace-alpha',
          agentId: 'agent-patch',
          laneId: 'lane-patch',
          runtimeInstanceId: 'runtime-1',
          localSequence: 5,
          runtimeEpoch: 1,
          occurredAt: '2026-07-18T20:00:10.000Z',
          payload: {
            type: 'heartbeat',
            currentAction: {
              taskId,
              summary: 'Continuing after workspace review.',
              startedAt: '2026-07-18T20:00:10.000Z',
            },
            checkpointRef: 'checkpoint-workspace-hold',
          },
        },
      ],
    },
  );
  assert.equal(resumeConfirmed.response.status, 200);
  assert.equal(lane.controlState, 'active');
  assert.equal(fixture.service.projection.requireTask(taskId).status, 'running');
});

test('a fixed-role lane executes one queued task at a time in accepted order', async () => {
  const fixture = await serviceFixture();
  await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );
  for (const [index, suffix] of ['first', 'second'].entries()) {
    const queued = await requestJson(fixture.url, '/v1/ui/commands', humanToken, {
      apiVersion: STEWARD_UI_API_VERSION,
      clientCommandId: `human-lane-${suffix}`,
      workspaceId: 'workspace-alpha',
      expectedControlVersion: index,
      issuedAt: '2026-07-18T20:00:00.000Z',
      payload: {
        type: 'queue_work',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        title: `${suffix} accepted task`,
        objective: 'Preserve one-at-a-time queue order for a fixed-role agent.',
        expectedAgentMinutes: 15,
        expectedCompletedAt: '2026-07-18T20:15:00.000Z',
      },
    });
    assert.equal(queued.response.status, 200);
  }
  const lane = fixture.service.projection.requireLane('lane-patch');
  const [firstTaskId, secondTaskId] = lane.queue;
  assert.ok(firstTaskId);
  assert.ok(secondTaskId);
  const beforeSkippedTask = fixture.service.store.records.length;

  const skipped = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: [
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-start-second-first',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-1',
        localSequence: 1,
        runtimeEpoch: 1,
        occurredAt: '2026-07-18T20:01:00.000Z',
        payload: {
          type: 'progress',
          taskId: secondTaskId,
          phase: 'research',
          iteration: 1,
          journal: 'Attempting to skip the accepted queue head.',
        },
      },
    ],
  });
  assert.equal(skipped.response.status, 409);
  assert.equal((skipped.json.error as { code: string }).code, 'LANE_QUEUE_ORDER_CONFLICT');
  assert.equal(fixture.service.store.records.length, beforeSkippedTask);

  const started = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: [
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-start-first',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-1',
        localSequence: 1,
        runtimeEpoch: 1,
        occurredAt: '2026-07-18T20:01:00.000Z',
        payload: {
          type: 'heartbeat',
          currentAction: {
            taskId: firstTaskId,
            summary: 'Working the accepted queue head.',
            startedAt: '2026-07-18T20:01:00.000Z',
          },
          checkpointRef: null,
        },
      },
    ],
  });
  assert.equal(started.response.status, 200);
  const beforeConcurrentTask = fixture.service.store.records.length;
  const concurrent = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: [
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-start-concurrent-second',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-1',
        localSequence: 2,
        runtimeEpoch: 1,
        occurredAt: '2026-07-18T20:02:00.000Z',
        payload: {
          type: 'heartbeat',
          currentAction: {
            taskId: secondTaskId,
            summary: 'Attempting concurrent work in one role lane.',
            startedAt: '2026-07-18T20:02:00.000Z',
          },
          checkpointRef: null,
        },
      },
    ],
  });
  assert.equal(concurrent.response.status, 409);
  assert.equal(
    (concurrent.json.error as { code: string }).code,
    'LANE_TASK_CONCURRENCY_CONFLICT',
  );
  assert.equal(fixture.service.store.records.length, beforeConcurrentTask);
  assert.equal(fixture.service.projection.requireTask(firstTaskId).status, 'running');
  assert.equal(fixture.service.projection.requireTask(secondTaskId).status, 'queued');
});

test('human commands use control-version CAS and bootstrap rebuilds after restart', async () => {
  const fixture = await serviceFixture();
  const registered = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );
  assert.equal(registered.response.status, 200);

  const command = {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'human-command-1',
    workspaceId: 'workspace-alpha',
    expectedControlVersion: 0,
    issuedAt: '2026-07-18T20:00:00.000Z',
    payload: {
      type: 'queue_work',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      title: 'Repair mobile navigation',
      objective: 'People can use every action on a small screen.',
      expectedAgentMinutes: 30,
      expectedCompletedAt: '2026-07-18T20:30:00.000Z',
    },
  };
  const accepted = await requestJson(fixture.url, '/v1/ui/commands', humanToken, command);
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.json.state, 'accepted');
  assert.equal(accepted.json.currentControlVersion, 1);

  const pollQuery = new URLSearchParams({
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: '1',
    after: '0',
  });
  const polled = await requestJson(
    fixture.url,
    `/v1/runtime/commands?${pollQuery}`,
    supervisorToken,
  );
  assert.equal(polled.response.status, 200);
  assert.equal((polled.json.commands as Array<{ payload: { type: string } }>)[0]?.payload.type, 'assign_task');

  const duplicate = await requestJson(fixture.url, '/v1/ui/commands', humanToken, command);
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.json.state, 'duplicate');

  const conflict = await requestJson(fixture.url, '/v1/ui/commands', humanToken, {
    ...command,
    clientCommandId: 'human-command-2',
  });
  assert.equal(conflict.response.status, 409);
  assert.equal((conflict.json.error as { code: string }).code, 'CONTROL_VERSION_CONFLICT');

  const bootstrap = await requestJson(fixture.url, '/v1/ui/bootstrap', humanToken);
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.json.apiVersion, STEWARD_UI_API_VERSION);
  const snapshot = bootstrap.json.snapshot as { sequence: number; tasks: unknown[]; agents: unknown[] };
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.agents.length, 1);
  assert.equal((bootstrap.json.eventStream as { href: string }).href, '/v1/ui/events');

  await fixture.service.close();
  fixture.item.service = undefined;
  const restarted = await serviceFixture(fixture.directory);
  const rebuilt = await requestJson(restarted.url, '/v1/ui/bootstrap', humanToken);
  const rebuiltSnapshot = rebuilt.json.snapshot as { sequence: number; tasks: unknown[] };
  assert.equal(rebuiltSnapshot.sequence, snapshot.sequence);
  assert.equal(rebuiltSnapshot.tasks.length, 1);
});

test('a replacement epoch receives unconsumed queue and interrupt intent', async () => {
  const fixture = await serviceFixture();
  await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );
  await requestJson(fixture.url, '/v1/ui/commands', humanToken, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'human-carry-forward-task',
    workspaceId: 'workspace-alpha',
    expectedControlVersion: 0,
    issuedAt: '2026-07-18T20:00:00.000Z',
    payload: {
      type: 'queue_work',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      title: 'Preserve accepted work',
      objective: 'A runtime replacement still receives the human task.',
      expectedAgentMinutes: 15,
      expectedCompletedAt: '2026-07-18T20:15:00.000Z',
    },
  });
  await requestJson(fixture.url, '/v1/ui/commands', humanToken, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'human-carry-forward-interrupt',
    workspaceId: 'workspace-alpha',
    expectedControlVersion: 1,
    issuedAt: '2026-07-18T20:00:00.000Z',
    payload: {
      type: 'request_interrupt',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      reason: 'Stop before continuing this accepted work.',
    },
  });
  const originalInterrupt = [...fixture.service.projection.requireLane('lane-patch').runtimeCommands]
    .reverse()
    .find((command) => command.payload.type === 'request_interrupt');
  assert.ok(originalInterrupt);

  const replacement = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(1, 'runtime-replacement'),
  );
  assert.equal(replacement.response.status, 200);

  const query = new URLSearchParams({
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-replacement',
    runtimeEpoch: '2',
    after: '0',
  });
  const poll = await requestJson(
    fixture.url,
    `/v1/runtime/commands?${query}`,
    supervisorToken,
  );
  assert.equal(poll.response.status, 200);
  const commands = poll.json.commands as Array<{
    commandId: string;
    expectedRuntimeEpoch: number;
    payload: { type: string; reason?: string };
  }>;
  assert.deepEqual(
    commands.map((command) => command.payload.type),
    ['assign_task', 'request_interrupt'],
  );
  assert.ok(commands.every((command) => command.expectedRuntimeEpoch === 2));
  assert.equal(commands[1]?.commandId, originalInterrupt.commandId);
  assert.equal(
    commands[1]?.payload.reason,
    'Stop before continuing this accepted work.',
  );
});

test('an acknowledged interrupt keeps its causation across runtime replacement', async () => {
  const fixture = await serviceFixture();
  await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(),
  );
  await requestJson(fixture.url, '/v1/ui/commands', humanToken, {
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: 'human-rebind-acknowledged-interrupt',
    workspaceId: 'workspace-alpha',
    expectedControlVersion: 0,
    issuedAt: '2026-07-18T20:00:00.000Z',
    payload: {
      type: 'request_interrupt',
      agentId: 'agent-patch',
      laneId: 'lane-patch',
      reason: 'Preserve this stop intent through replacement.',
    },
  });
  const lane = fixture.service.projection.requireLane('lane-patch');
  const interrupt = [...lane.runtimeCommands]
    .reverse()
    .find((command) => command.payload.type === 'request_interrupt');
  assert.ok(interrupt);
  const acknowledged = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-1',
    runtimeEpoch: 1,
    events: [
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-rebind-interrupt-ack',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-1',
        localSequence: 1,
        runtimeEpoch: 1,
        occurredAt: '2026-07-18T20:01:00.000Z',
        payload: {
          type: 'interrupt_acknowledged',
          commandId: interrupt.commandId,
          taskId: null,
        },
      },
    ],
  });
  assert.equal(acknowledged.response.status, 200);
  assert.equal(lane.pendingInterrupt?.state, 'acknowledged');

  const replacement = await requestJson(
    fixture.url,
    '/v1/runtime/register',
    supervisorToken,
    registration(1, 'runtime-after-ack'),
  );
  assert.equal(replacement.response.status, 200);
  const replacementLane = fixture.service.projection.requireLane('lane-patch');
  assert.equal(replacementLane.pendingInterrupt?.state, 'acknowledged');
  assert.equal(replacementLane.pendingInterrupt?.commandId, interrupt.commandId);

  const settled = await requestJson(fixture.url, '/v1/runtime/events', supervisorToken, {
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    workspaceId: 'workspace-alpha',
    agentId: 'agent-patch',
    laneId: 'lane-patch',
    runtimeInstanceId: 'runtime-after-ack',
    runtimeEpoch: 2,
    events: [
      {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        eventId: 'event-rebind-interrupt-settle',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-after-ack',
        localSequence: 2,
        runtimeEpoch: 2,
        occurredAt: '2026-07-18T20:02:00.000Z',
        payload: {
          type: 'interrupt_settled',
          commandId: interrupt.commandId,
          taskId: null,
          checkpointRef: 'checkpoint-rebound-interrupt',
        },
      },
    ],
  });
  assert.equal(settled.response.status, 200);
  assert.equal(replacementLane.pendingInterrupt, null);
  assert.equal(replacementLane.controlState, 'paused');
});

test('SSE replays committed events after a cursor and graceful drain closes the stream', async () => {
  const { url, service } = await serviceFixture();
  await requestJson(url, '/v1/runtime/register', supervisorToken, registration());
  const controller = new AbortController();
  const response = await fetch(`${url}/v1/ui/events?after=0`, {
    headers: { Authorization: `Bearer ${humanToken}` },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('event: steward.event')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    text += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(text, /id: 1\n/);

  const close = service.close();
  let sawShutdown = text.includes('event: shutdown');
  while (!sawShutdown) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    sawShutdown = text.includes('event: shutdown');
  }
  await close;
  assert.equal(sawShutdown, true);
  controller.abort();
});
