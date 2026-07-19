import {
  STEWARD_UI_API_VERSION,
  type AgentConnectivity,
  type AgentRegistryEvent,
  type DiscoveredAgent,
  type FrontendBootstrap,
  type WorkspaceDiscoverySnapshot,
  type WorkspaceId,
} from './contract';
import type { ISODateTime } from '../domain';

export type ReconciliationFailureCode =
  | 'INVALID_BOOTSTRAP'
  | 'INVALID_SNAPSHOT'
  | 'INVALID_EVENT'
  | 'WORKSPACE_MISMATCH'
  | 'SEQUENCE_GAP'
  | 'SEQUENCE_REGRESSION'
  | 'SEQUENCE_CONFLICT'
  | 'EVENT_ID_REUSED'
  | 'ENTITY_VERSION_REGRESSION'
  | 'ENTITY_VERSION_CONFLICT';

export type ReconciliationResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | {
      readonly ok: false;
      readonly code: ReconciliationFailureCode;
      readonly reason: string;
      readonly rebootstrapRequired: boolean;
    };

export interface FrontendAgentReplica {
  readonly workspaceId: WorkspaceId;
  readonly sequence: number;
  readonly generatedAt: ISODateTime;
  readonly lastEventAt: ISODateTime;
  readonly paused: boolean;
  readonly workspaceControlVersion: number;
  readonly agentsByLane: Readonly<Record<string, DiscoveredAgent>>;
  readonly laneTombstones: Readonly<Record<string, FrontendLaneTombstone>>;
  readonly seenSequenceFingerprints: Readonly<Record<number, string>>;
  readonly seenEventSequences: Readonly<Record<string, number>>;
}

export interface FrontendLaneTombstone {
  readonly agentId: DiscoveredAgent['agentId'];
  readonly laneProjectionVersion: number;
  readonly laneControlVersion: number;
  readonly reason: 'retired' | 'identity_replaced';
}

export interface ValidatedFrontendBootstrap {
  readonly apiVersion: FrontendBootstrap['apiVersion'];
  readonly sessionId: FrontendBootstrap['sessionId'];
  readonly userId: FrontendBootstrap['userId'];
  readonly permissions: FrontendBootstrap['permissions'];
  readonly features: FrontendBootstrap['features'];
  readonly eventStream: FrontendBootstrap['eventStream'];
  readonly commandEndpoint: string;
  readonly replica: FrontendAgentReplica;
}

/** Recent at-least-once delivery history; older duplicates force a fresh snapshot. */
export const FRONTEND_REPLAY_WINDOW = 256;

function allow<Value>(value: Value): ReconciliationResult<Value> {
  return { ok: true, value };
}

function deny<Value>(
  code: ReconciliationFailureCode,
  reason: string,
  rebootstrapRequired = true,
): ReconciliationResult<Value> {
  return { ok: false, code, reason, rebootstrapRequired };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function validTaskSubject(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'development') return hasExactKeys(value, ['type']);
  if (value.type !== 'manager_review') return false;
  return (
    hasExactKeys(value, ['type', 'sourceTaskId', 'evidenceId', 'evidenceDigest']) &&
    typeof value.sourceTaskId === 'string' &&
    value.sourceTaskId.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value.sourceTaskId) &&
    typeof value.evidenceId === 'string' &&
    value.evidenceId.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value.evidenceId) &&
    typeof value.evidenceDigest === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(value.evidenceDigest)
  );
}

function sameTaskSubject(
  left: DiscoveredAgent['task'] extends infer Task
    ? Task extends { subject: infer Subject } ? Subject : never
    : never,
  right: DiscoveredAgent['task'] extends infer Task
    ? Task extends { subject: infer Subject } ? Subject : never
    : never,
): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'development') return true;
  if (right.type !== 'manager_review') return false;
  return (
    left.sourceTaskId === right.sourceTaskId &&
    left.evidenceId === right.evidenceId &&
    left.evidenceDigest === right.evidenceDigest
  );
}

function validTimestamp(value: unknown): value is ISODateTime {
  return typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function validVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validPositiveVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validStringList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

function validControlPlanePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\u0000-\u001f\\]/.test(value)
  ) {
    return false;
  }
  try {
    const endpoint = new URL(value, 'https://control-plane.steward.invalid');
    return (
      endpoint.origin === 'https://control-plane.steward.invalid' &&
      endpoint.username.length === 0 &&
      endpoint.password.length === 0
    );
  } catch {
    return false;
  }
}

function immutableAgent(agent: DiscoveredAgent): DiscoveredAgent {
  return Object.freeze({
    ...agent,
    capabilities: Object.freeze([...agent.capabilities]),
    lease: Object.freeze({ ...agent.lease }),
    ...(agent.activeRun === undefined
      ? {}
      : { activeRun: Object.freeze({ ...agent.activeRun }) }),
    ...(agent.task === undefined
      ? {}
      : {
          task: Object.freeze({
            ...agent.task,
            subject: Object.freeze({ ...agent.task.subject }),
          }),
        }),
  });
}

function validateAgent(value: unknown): value is DiscoveredAgent {
  if (!isRecord(value) || !isRecord(value.lease)) return false;
  const agent = value;
  const lease = value.lease;
  const activeRun = value.activeRun;
  const task = value.task;
  if (activeRun !== undefined && !isRecord(activeRun)) return false;
  if (task !== undefined && !isRecord(task)) return false;

  const validRole = ['manager', 'engineer', 'verifier'].includes(String(agent.role));
  const validConnectivity = ['online', 'stale', 'offline'].includes(String(lease.state));
  const validRunState =
    activeRun === undefined ||
    [
      'starting',
      'running',
      'interrupt_requested',
      'interrupt_acknowledged',
      'interrupt_refused',
      'interrupt_unknown',
      'interrupted',
    ].includes(String(activeRun.state));
  const validTask =
    task === undefined ||
    (() => {
      const status = String(task.status);
      if (!['running', 'paused', 'completed'].includes(status)) return false;
      if (
        typeof task.id !== 'string' ||
        task.id.trim().length === 0 ||
        typeof task.workItemId !== 'string' ||
        task.workItemId.trim().length === 0 ||
        !validTaskSubject(task.subject) ||
        !validTimestamp(task.startedAt) ||
        !validTimestamp(task.expectedCompletedAt) ||
        typeof task.expectedAgentMinutes !== 'number' ||
        !Number.isSafeInteger(task.expectedAgentMinutes) ||
        task.expectedAgentMinutes <= 0 ||
        task.expectedAgentMinutes % 15 !== 0
      ) {
        return false;
      }
      const startedAt = Date.parse(task.startedAt);
      const expectedCompletedAt = Date.parse(task.expectedCompletedAt);
      if (
        expectedCompletedAt < startedAt + task.expectedAgentMinutes * 60_000 ||
        expectedCompletedAt % (15 * 60_000) !== 0
      ) {
        return false;
      }
      if (status === 'completed') {
        return (
          validTimestamp(task.endedAt) && Date.parse(task.endedAt) >= startedAt
        );
      }
      return task.endedAt === undefined;
    })();
  if (
    !validTimestamp(lease.registeredAt) ||
    !validTimestamp(lease.lastSeenAt) ||
    !validTimestamp(lease.leaseExpiresAt)
  ) {
    return false;
  }
  const registeredAt = Date.parse(lease.registeredAt);
  const lastSeenAt = Date.parse(lease.lastSeenAt);
  const leaseExpiresAt = Date.parse(lease.leaseExpiresAt);
  return (
    typeof agent.agentId === 'string' &&
    agent.agentId.trim().length > 0 &&
    typeof agent.laneId === 'string' &&
    agent.laneId.trim().length > 0 &&
    typeof agent.runtimeInstanceId === 'string' &&
    agent.runtimeInstanceId.trim().length > 0 &&
    typeof agent.displayName === 'string' &&
    agent.displayName.trim().length > 0 &&
    validRole &&
    validConnectivity &&
    validRunState &&
    validTask &&
    Array.isArray(agent.capabilities) &&
    agent.capabilities.every(
      (capability) => typeof capability === 'string' && capability.trim().length > 0,
    ) &&
    validPositiveVersion(agent.projectionVersion) &&
    validPositiveVersion(agent.controlVersion) &&
    validPositiveVersion(lease.runtimeEpoch) &&
    registeredAt <= lastSeenAt &&
    lastSeenAt <= leaseExpiresAt &&
    (activeRun === undefined ||
      (typeof activeRun.id === 'string' &&
        activeRun.id.trim().length > 0 &&
        validTimestamp(activeRun.startedAt)))
  );
}

function immutableReplica(replica: FrontendAgentReplica): FrontendAgentReplica {
  return Object.freeze({
    ...replica,
    agentsByLane: Object.freeze({ ...replica.agentsByLane }),
    laneTombstones: Object.freeze({ ...replica.laneTombstones }),
    seenSequenceFingerprints: Object.freeze({
      ...replica.seenSequenceFingerprints,
    }),
    seenEventSequences: Object.freeze({ ...replica.seenEventSequences }),
  });
}

function fingerprint(event: AgentRegistryEvent): string {
  return JSON.stringify(event);
}

function boundedReplayHistory(
  sequence: number,
  fingerprints: Readonly<Record<number, string>>,
  eventSequences: Readonly<Record<string, number>>,
): {
  readonly fingerprints: Readonly<Record<number, string>>;
  readonly eventSequences: Readonly<Record<string, number>>;
} {
  const floor = Math.max(1, sequence - FRONTEND_REPLAY_WINDOW + 1);
  const boundedFingerprints = { ...fingerprints };
  const boundedEventSequences = { ...eventSequences };
  for (const key of Object.keys(boundedFingerprints)) {
    if (Number(key) < floor) delete boundedFingerprints[Number(key)];
  }
  for (const [id, eventSequence] of Object.entries(boundedEventSequences)) {
    if (eventSequence < floor) delete boundedEventSequences[id];
  }
  return {
    fingerprints: boundedFingerprints,
    eventSequences: boundedEventSequences,
  };
}

export function createFrontendAgentReplica(
  input: unknown,
): ReconciliationResult<FrontendAgentReplica> {
  if (!isRecord(input) || !Array.isArray(input.agents)) {
    return deny('INVALID_SNAPSHOT', 'Discovery snapshots require an object with an agent list.');
  }
  const snapshot = input as unknown as WorkspaceDiscoverySnapshot;
  if (
    snapshot.apiVersion !== STEWARD_UI_API_VERSION ||
    typeof snapshot.workspaceId !== 'string' ||
    snapshot.workspaceId.trim().length === 0 ||
    !validVersion(snapshot.sequence) ||
    !validVersion(snapshot.controlVersion) ||
    typeof snapshot.paused !== 'boolean' ||
    !validTimestamp(snapshot.generatedAt)
  ) {
    return deny('INVALID_SNAPSHOT', 'Discovery snapshots require a workspace, sequence, and valid generation time.');
  }

  const agentsByLane: Record<string, DiscoveredAgent> = {};
  const seenAgentIds = new Set<string>();
  for (const candidate of snapshot.agents) {
    if (!validateAgent(candidate)) {
      return deny(
        'INVALID_SNAPSHOT',
        'Discovery snapshots require valid agents with unique stable lane and agent identities.',
      );
    }
    const agent = candidate;
    const laneKey = String(agent.laneId);
    const agentKey = String(agent.agentId);
    if (agentsByLane[laneKey] || seenAgentIds.has(agentKey)) {
      return deny(
        'INVALID_SNAPSHOT',
        'Discovery snapshots require valid agents with unique stable lane and agent identities.',
      );
    }
    agentsByLane[laneKey] = immutableAgent(agent);
    seenAgentIds.add(agentKey);
  }

  return allow(
    immutableReplica({
      workspaceId: snapshot.workspaceId,
      sequence: snapshot.sequence,
      generatedAt: snapshot.generatedAt,
      lastEventAt: snapshot.generatedAt,
      paused: snapshot.paused,
      workspaceControlVersion: snapshot.controlVersion,
      agentsByLane,
      laneTombstones: {},
      seenSequenceFingerprints: {},
      seenEventSequences: {},
    }),
  );
}

export function createValidatedFrontendBootstrap(
  input: unknown,
): ReconciliationResult<ValidatedFrontendBootstrap> {
  if (!isRecord(input) || !isRecord(input.eventStream)) {
    return deny('INVALID_BOOTSTRAP', 'Bootstrap requires an object with event-stream metadata.');
  }
  const bootstrap = input as unknown as FrontendBootstrap;
  const replica = createFrontendAgentReplica(bootstrap.snapshot);
  if (!replica.ok) {
    return deny('INVALID_BOOTSTRAP', replica.reason);
  }
  if (
    bootstrap.apiVersion !== STEWARD_UI_API_VERSION ||
    typeof bootstrap.sessionId !== 'string' ||
    bootstrap.sessionId.trim().length === 0 ||
    typeof bootstrap.userId !== 'string' ||
    bootstrap.userId.trim().length === 0 ||
    !validStringList(bootstrap.permissions) ||
    !validStringList(bootstrap.features) ||
    !validControlPlanePath(bootstrap.eventStream.href) ||
    bootstrap.eventStream.afterSequence !== replica.value.sequence ||
    !validVersion(bootstrap.eventStream.retentionStartsAtSequence) ||
    bootstrap.eventStream.retentionStartsAtSequence > replica.value.sequence + 1 ||
    !Number.isSafeInteger(bootstrap.eventStream.heartbeatIntervalMs) ||
    bootstrap.eventStream.heartbeatIntervalMs < 1_000 ||
    bootstrap.eventStream.heartbeatIntervalMs > 300_000 ||
    !validControlPlanePath(bootstrap.commandEndpoint)
  ) {
    return deny(
      'INVALID_BOOTSTRAP',
      'Bootstrap identity, protocol, cursor, retention, heartbeat, or endpoint metadata is invalid.',
    );
  }

  return allow(Object.freeze({
    apiVersion: bootstrap.apiVersion,
    sessionId: bootstrap.sessionId,
    userId: bootstrap.userId,
    permissions: Object.freeze([...bootstrap.permissions]),
    features: Object.freeze([...bootstrap.features]),
    eventStream: Object.freeze({ ...bootstrap.eventStream }),
    commandEndpoint: bootstrap.commandEndpoint,
    replica: replica.value,
  }));
}

export function applyAgentRegistryEvent(
  replica: FrontendAgentReplica,
  input: unknown,
): ReconciliationResult<FrontendAgentReplica> {
  if (!isRecord(input) || !isRecord(input.payload)) {
    return deny('INVALID_EVENT', 'Registry events require an object with a payload.');
  }
  const event = input as unknown as AgentRegistryEvent;
  if (
    event.apiVersion !== STEWARD_UI_API_VERSION ||
    typeof event.workspaceId !== 'string' ||
    event.workspaceId.trim().length === 0 ||
    !validVersion(event.sequence) ||
    event.sequence === 0 ||
    !validTimestamp(event.occurredAt) ||
    typeof event.id !== 'string' ||
    event.id.trim().length === 0 ||
    (event.causationCommandId !== undefined &&
      (typeof event.causationCommandId !== 'string' ||
        event.causationCommandId.trim().length === 0))
  ) {
    return deny('INVALID_EVENT', 'Registry events require a positive sequence, identity, and valid timestamp.');
  }
  if (event.workspaceId !== replica.workspaceId) {
    return deny('WORKSPACE_MISMATCH', 'An event from another workspace cannot enter this frontend replica.');
  }

  const eventFingerprint = fingerprint(event);
  const eventId = String(event.id);
  const priorIdSequence = replica.seenEventSequences[eventId];
  if (priorIdSequence !== undefined) {
    const exactReplay =
      priorIdSequence === event.sequence &&
      replica.seenSequenceFingerprints[event.sequence] === eventFingerprint;
    return exactReplay
      ? allow(replica)
      : deny('EVENT_ID_REUSED', 'A control-plane event identifier was reused with different data.');
  }

  if (event.sequence <= replica.sequence) {
    const priorFingerprint = replica.seenSequenceFingerprints[event.sequence];
    if (priorFingerprint === eventFingerprint) return allow(replica);
    return priorFingerprint === undefined
      ? deny('SEQUENCE_REGRESSION', 'The event stream moved behind the authoritative snapshot or applied cursor.')
      : deny('SEQUENCE_CONFLICT', 'A previously applied sequence was replayed with different data.');
  }
  if (Date.parse(event.occurredAt) < Date.parse(replica.lastEventAt)) {
    return deny('INVALID_EVENT', 'A new registry event cannot move behind the applied event timestamp.');
  }
  if (event.sequence !== replica.sequence + 1) {
    return deny('SEQUENCE_GAP', 'The event stream skipped a sequence; reload an authoritative snapshot before continuing.');
  }

  const nextAgents = { ...replica.agentsByLane };
  const nextTombstones = { ...replica.laneTombstones };
  let nextPaused = replica.paused;
  let nextWorkspaceControlVersion = replica.workspaceControlVersion;

  if (event.payload.type === 'agent_upserted') {
    const agent = event.payload.agent;
    if (!validateAgent(agent)) {
      return deny('INVALID_EVENT', 'Agent upsert events must contain a valid complete discovery record.');
    }
    const laneKey = String(agent.laneId);
    const existing = nextAgents[laneKey];
    const tombstone = nextTombstones[laneKey];
    const duplicateIdentity = Object.entries(nextAgents).find(
      ([otherLane, candidate]) => otherLane !== laneKey && candidate.agentId === agent.agentId,
    );
    if (duplicateIdentity) {
      return deny('ENTITY_VERSION_CONFLICT', 'An agent identity cannot own more than one stable lane.');
    }
    if (existing && existing.agentId !== agent.agentId) {
      return deny('ENTITY_VERSION_CONFLICT', 'A lane identity replacement requires an explicit removal event.');
    }
    if (tombstone) {
      if (tombstone.reason === 'retired') {
        return deny('ENTITY_VERSION_CONFLICT', 'A retired stable lane cannot be resurrected.');
      }
      if (agent.projectionVersion <= tombstone.laneProjectionVersion) {
        return deny(
          agent.projectionVersion < tombstone.laneProjectionVersion
            ? 'ENTITY_VERSION_REGRESSION'
            : 'ENTITY_VERSION_CONFLICT',
          'An identity replacement must advance the removed lane version.',
        );
      }
      if (agent.controlVersion <= tombstone.laneControlVersion) {
        return deny(
          agent.controlVersion < tombstone.laneControlVersion
            ? 'ENTITY_VERSION_REGRESSION'
            : 'ENTITY_VERSION_CONFLICT',
          'An identity replacement must advance the stable lane control version.',
        );
      }
      if (agent.agentId === tombstone.agentId) {
        return deny('ENTITY_VERSION_CONFLICT', 'An identity replacement must install a new agent identity.');
      }
    }
    if (existing && agent.projectionVersion < existing.projectionVersion) {
      return deny('ENTITY_VERSION_REGRESSION', 'An agent lane update moved behind its current version.');
    }
    if (existing && agent.controlVersion < existing.controlVersion) {
      return deny('ENTITY_VERSION_REGRESSION', 'An agent update moved behind its lane control version.');
    }
    if (existing && agent.lease.runtimeEpoch < existing.lease.runtimeEpoch) {
      return deny('ENTITY_VERSION_REGRESSION', 'An agent update came from a fenced runtime epoch.');
    }
    if (
      existing &&
      agent.lease.runtimeEpoch === existing.lease.runtimeEpoch &&
      agent.runtimeInstanceId !== existing.runtimeInstanceId
    ) {
      return deny('ENTITY_VERSION_CONFLICT', 'A runtime instance changed without advancing its fencing epoch.');
    }
    if (
      existing?.task !== undefined &&
      agent.task !== undefined &&
      existing.task.id === agent.task.id &&
      !sameTaskSubject(existing.task.subject, agent.task.subject)
    ) {
      return deny('ENTITY_VERSION_CONFLICT', 'An agent update changed an existing task subject binding.');
    }
    if (
      existing?.task !== undefined &&
      agent.task !== undefined &&
      existing.task.id === agent.task.id &&
      (existing.task.startedAt !== agent.task.startedAt ||
        existing.task.expectedAgentMinutes !== agent.task.expectedAgentMinutes ||
        (existing.task.status === 'completed' && agent.task.status !== 'completed'))
    ) {
      return deny('ENTITY_VERSION_CONFLICT', 'An agent update reset an existing task lifecycle.');
    }
    if (
      existing &&
      agent.projectionVersion === existing.projectionVersion &&
      JSON.stringify(existing) !== JSON.stringify(agent)
    ) {
      return deny('ENTITY_VERSION_CONFLICT', 'An agent lane version was reused with different state.');
    }
    nextAgents[laneKey] = immutableAgent(agent);
    delete nextTombstones[laneKey];
  } else if (event.payload.type === 'agent_removed') {
    const laneKey = String(event.payload.laneId);
    const existing = nextAgents[laneKey];
    if (
      typeof event.payload.laneId !== 'string' ||
      event.payload.laneId.trim().length === 0 ||
      typeof event.payload.agentId !== 'string' ||
      event.payload.agentId.trim().length === 0 ||
      !validPositiveVersion(event.payload.laneProjectionVersion) ||
      typeof event.payload.reason !== 'string' ||
      !['retired', 'identity_replaced'].includes(event.payload.reason)
    ) {
      return deny('INVALID_EVENT', 'Agent removal events require a lane, agent, and positive lane version.');
    }
    if (existing && event.payload.laneProjectionVersion <= existing.projectionVersion) {
      return deny(
        event.payload.laneProjectionVersion < existing.projectionVersion
          ? 'ENTITY_VERSION_REGRESSION'
          : 'ENTITY_VERSION_CONFLICT',
        'An agent removal must advance the current lane version.',
      );
    }
    if (existing && existing.agentId !== event.payload.agentId) {
      return deny('ENTITY_VERSION_CONFLICT', 'An agent removal does not match the lane owner.');
    }
    if (!existing || nextTombstones[laneKey]) {
      return deny('ENTITY_VERSION_CONFLICT', 'An agent removal must target a currently registered lane.');
    }
    nextTombstones[laneKey] = Object.freeze({
      agentId: event.payload.agentId,
      laneProjectionVersion: event.payload.laneProjectionVersion,
      laneControlVersion: existing.controlVersion,
      reason: event.payload.reason,
    });
    delete nextAgents[laneKey];
  } else if (event.payload.type === 'workspace_pause_changed') {
    if (
      !validVersion(event.payload.workspaceControlVersion) ||
      typeof event.payload.paused !== 'boolean'
    ) {
      return deny('INVALID_EVENT', 'Workspace events require a valid version and pause state.');
    }
    if (event.payload.workspaceControlVersion < replica.workspaceControlVersion) {
      return deny('ENTITY_VERSION_REGRESSION', 'A workspace update moved behind its current version.');
    }
    if (
      event.payload.workspaceControlVersion === replica.workspaceControlVersion &&
      event.payload.paused !== replica.paused
    ) {
      return deny('ENTITY_VERSION_CONFLICT', 'A workspace version was reused with a different pause state.');
    }
    nextPaused = event.payload.paused;
    nextWorkspaceControlVersion = event.payload.workspaceControlVersion;
  } else {
    return deny('INVALID_EVENT', 'Registry event payload type is not supported by this API version.');
  }

  const replayHistory = boundedReplayHistory(
    event.sequence,
    {
      ...replica.seenSequenceFingerprints,
      [event.sequence]: eventFingerprint,
    },
    {
      ...replica.seenEventSequences,
      [eventId]: event.sequence,
    },
  );

  return allow(
    immutableReplica({
      ...replica,
      sequence: event.sequence,
      lastEventAt: event.occurredAt,
      paused: nextPaused,
      workspaceControlVersion: nextWorkspaceControlVersion,
      agentsByLane: nextAgents,
      laneTombstones: nextTombstones,
      seenSequenceFingerprints: replayHistory.fingerprints,
      seenEventSequences: replayHistory.eventSequences,
    }),
  );
}

export function applyAgentRegistryEvents(
  replica: FrontendAgentReplica,
  events: readonly unknown[],
): ReconciliationResult<FrontendAgentReplica> {
  let current = replica;
  for (const event of events) {
    const applied = applyAgentRegistryEvent(current, event);
    if (!applied.ok) return applied;
    current = applied.value;
  }
  return allow(current);
}

/** Never upgrades server state; it only ages an apparently-online lease to stale. */
export function projectAgentConnectivity(
  agent: DiscoveredAgent,
  observedAt: ISODateTime,
): AgentConnectivity {
  if (agent.lease.state !== 'online') return agent.lease.state;
  if (!validTimestamp(observedAt)) return 'stale';
  return Date.parse(observedAt) > Date.parse(agent.lease.leaseExpiresAt)
    ? 'stale'
    : 'online';
}
