import {
  ProtocolValidationError,
  parseUiBootstrap,
  parseUiEventEnvelope,
  parseUiSnapshot,
  type HumanCommandEnvelope,
  type HumanCommandReceipt,
  type RegisteredAgentProjection,
  type UiEventEnvelope,
  type UiSnapshot,
} from '@cicada/steward-protocol';
import {
  ControlPlaneTransportError,
  type ControlPlaneGateway,
  type UiEventStreamTermination,
  type UiEventSubscription,
} from './http-gateway';

export type WorkspaceConnectionMode =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'stale'
  | 'authentication_required'
  | 'upgrade_required'
  | 'stopped';

export interface WorkspaceConnectionState {
  readonly mode: WorkspaceConnectionMode;
  readonly replica?: UiSnapshot;
  readonly reason?: string;
}

export interface WorkspaceClientOptions {
  readonly gateway: ControlPlaneGateway;
  readonly onChange: (state: WorkspaceConnectionState) => void;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
}

class ReplicaReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplicaReconciliationError';
  }
}

function retryDelay(attempt: number, base: number, maximum: number): number {
  return Math.min(maximum, base * 2 ** Math.min(attempt, 8));
}

function assertNever(value: never): never {
  throw new ReplicaReconciliationError(
    `The control plane returned an unsupported event variant: ${String(value)}.`,
  );
}

function replaceById<Value>(
  values: readonly Value[],
  identity: (value: Value) => string,
  replacement: Value,
): readonly Value[] {
  const target = identity(replacement);
  const index = values.findIndex((value) => identity(value) === target);
  if (index < 0) return Object.freeze([...values, replacement]);
  const next = [...values];
  next[index] = replacement;
  return Object.freeze(next);
}

function eventControlVersion(event: UiEventEnvelope): number | undefined {
  switch (event.payload.type) {
    case 'agent_upserted':
    case 'agent_runtime_updated':
      return event.payload.agent.controlVersion;
    case 'workspace_control_updated':
      return event.payload.controlVersion;
    case 'agent_removed':
    case 'task_upserted':
    case 'progress_recorded':
      return undefined;
    default:
      return assertNever(event.payload);
  }
}

function reconcileControlVersion(
  snapshot: UiSnapshot,
  event: UiEventEnvelope,
  seenCausations: Set<string>,
): number {
  const advertised = eventControlVersion(event);
  const causation = event.causationClientCommandId;
  const firstCausation = causation !== undefined && !seenCausations.has(causation);
  const expected = firstCausation ? snapshot.controlVersion + 1 : snapshot.controlVersion;

  if (advertised !== undefined && advertised !== expected) {
    throw new ReplicaReconciliationError(
      advertised < expected
        ? 'A live event regressed the workspace control version.'
        : 'A live event skipped a workspace control version.',
    );
  }
  if (firstCausation) seenCausations.add(causation);
  return advertised ?? expected;
}

function reconcileAgentRuntime(
  existing: RegisteredAgentProjection,
  update: Extract<UiEventEnvelope['payload'], { type: 'agent_runtime_updated' }>['agent'],
): RegisteredAgentProjection {
  if (existing.agentId !== update.agentId || existing.laneId !== update.laneId) {
    throw new ReplicaReconciliationError('A runtime update changed a stable agent identity.');
  }
  if (update.runtimeEpoch < existing.runtimeEpoch) {
    throw new ReplicaReconciliationError('A runtime update came from a fenced runtime epoch.');
  }
  if (
    update.runtimeEpoch === existing.runtimeEpoch &&
    update.runtimeInstanceId !== existing.runtimeInstanceId
  ) {
    throw new ReplicaReconciliationError(
      'A runtime instance changed without advancing its fencing epoch.',
    );
  }
  return Object.freeze({ ...existing, ...update });
}

function applyUiEvent(
  snapshot: UiSnapshot,
  eventInput: UiEventEnvelope,
  seenCausations: Set<string>,
): UiSnapshot {
  let event: UiEventEnvelope;
  try {
    event = parseUiEventEnvelope(eventInput);
  } catch (error) {
    throw new ReplicaReconciliationError(
      error instanceof Error ? error.message : 'The control plane returned an invalid event.',
    );
  }
  if (event.workspaceId !== snapshot.workspaceId) {
    throw new ReplicaReconciliationError('An event from another workspace cannot enter this replica.');
  }
  if (event.sequence !== snapshot.sequence + 1) {
    throw new ReplicaReconciliationError(
      event.sequence <= snapshot.sequence
        ? 'The event stream regressed behind the applied cursor.'
        : 'The event stream skipped a sequence.',
    );
  }

  const controlVersion = reconcileControlVersion(snapshot, event, seenCausations);
  let agents = snapshot.agents;
  let tasks = snapshot.tasks;
  let progress = snapshot.progress;
  let paused = snapshot.paused;

  const payload = event.payload;
  switch (payload.type) {
    case 'agent_upserted': {
      const incoming = payload.agent;
      const lane = agents.find((agent) => agent.laneId === incoming.laneId);
      const duplicateIdentity = agents.find(
        (agent) => agent.agentId === incoming.agentId && agent.laneId !== incoming.laneId,
      );
      if (duplicateIdentity || (lane && lane.agentId !== incoming.agentId)) {
        throw new ReplicaReconciliationError('An agent event conflicted with a stable lane identity.');
      }
      if (lane && incoming.runtimeEpoch < lane.runtimeEpoch) {
        throw new ReplicaReconciliationError('An agent event came from a fenced runtime epoch.');
      }
      agents = replaceById(agents, (agent) => String(agent.laneId), incoming);
      break;
    }
    case 'agent_removed': {
      const existing = agents.find((agent) => agent.laneId === payload.laneId);
      if (!existing || existing.agentId !== payload.agentId) {
        throw new ReplicaReconciliationError('An agent removal did not match the stable lane identity.');
      }
      agents = Object.freeze(agents.filter((agent) => agent.laneId !== payload.laneId));
      break;
    }
    case 'task_upserted': {
      const incoming = payload.task;
      const existing = tasks.find((task) => task.taskId === incoming.taskId);
      if (
        existing &&
        (existing.agentId !== incoming.agentId || existing.laneId !== incoming.laneId)
      ) {
        throw new ReplicaReconciliationError('A task event changed the task owner identity.');
      }
      tasks = replaceById(tasks, (task) => String(task.taskId), incoming);
      break;
    }
    case 'progress_recorded': {
      const incoming = payload.task;
      const existing = tasks.find((task) => task.taskId === incoming.taskId);
      if (
        !existing ||
        existing.agentId !== incoming.agentId ||
        existing.laneId !== incoming.laneId
      ) {
        throw new ReplicaReconciliationError(
          'A progress event did not match an existing task owner identity.',
        );
      }
      tasks = replaceById(tasks, (task) => String(task.taskId), incoming);
      progress = Object.freeze([...progress, payload.progress]);
      break;
    }
    case 'agent_runtime_updated': {
      const update = payload.agent;
      const index = agents.findIndex((agent) => agent.laneId === update.laneId);
      if (index < 0) {
        throw new ReplicaReconciliationError('A runtime update targeted an unknown agent lane.');
      }
      const next = [...agents];
      next[index] = reconcileAgentRuntime(next[index]!, update);
      agents = Object.freeze(next);
      if (payload.task !== null) {
        const existingTask = tasks.find((task) => task.taskId === payload.task?.taskId);
        if (
          existingTask &&
          (existingTask.agentId !== payload.task.agentId ||
            existingTask.laneId !== payload.task.laneId)
        ) {
          throw new ReplicaReconciliationError(
            'A runtime event changed the task owner identity.',
          );
        }
        tasks = replaceById(tasks, (task) => String(task.taskId), payload.task);
      }
      break;
    }
    case 'workspace_control_updated':
      paused = payload.paused;
      break;
    default:
      return assertNever(payload);
  }

  try {
    return parseUiSnapshot({
      ...snapshot,
      generatedAt: event.occurredAt,
      sequence: event.sequence,
      paused,
      controlVersion,
      agents,
      tasks,
      progress,
    });
  } catch (error) {
    throw new ReplicaReconciliationError(
      error instanceof Error ? error.message : 'The event produced an invalid frontend replica.',
    );
  }
}

/**
 * Owns a disposable browser replica. The control plane remains authoritative;
 * any malformed, conflicting, or non-contiguous event discards the live
 * transport and starts again from a fresh snapshot.
 */
export class WorkspaceClient {
  readonly #gateway: ControlPlaneGateway;
  readonly #onChange: (state: WorkspaceConnectionState) => void;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #seenCausations = new Set<string>();
  #state: WorkspaceConnectionState = Object.freeze({ mode: 'idle' });
  #subscription: UiEventSubscription | undefined;
  #bootstrapAbort: AbortController | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryAttempt = 0;
  #generation = 0;

  constructor(options: WorkspaceClientOptions) {
    this.#gateway = options.gateway;
    this.#onChange = options.onChange;
    this.#retryBaseMs = Math.max(50, options.retryBaseMs ?? 500);
    this.#retryMaxMs = Math.max(this.#retryBaseMs, options.retryMaxMs ?? 15_000);
  }

  get state(): WorkspaceConnectionState {
    return this.#state;
  }

  start(): void {
    if (this.#state.mode !== 'idle' && this.#state.mode !== 'stopped') return;
    this.#generation += 1;
    this.#retryAttempt = 0;
    this.#seenCausations.clear();
    this.#setState({ mode: 'connecting' });
    void this.#bootstrap(this.#generation);
  }

  stop(): void {
    this.#generation += 1;
    this.#clearTransport();
    this.#seenCausations.clear();
    this.#setState({ mode: 'stopped' });
  }

  async submit(
    command: HumanCommandEnvelope,
    signal?: AbortSignal,
  ): Promise<HumanCommandReceipt> {
    if (this.#state.mode !== 'live' || !this.#state.replica) {
      throw new Error('Authoritative controls are disabled while the workspace is not live.');
    }
    const generation = this.#generation;
    let receipt: HumanCommandReceipt;
    try {
      receipt = await this.#gateway.submit(command, signal);
    } catch (error) {
      if (generation === this.#generation && error instanceof ControlPlaneTransportError) {
        if (error.status === 401 || error.status === 403) {
          this.#subscription?.close();
          this.#subscription = undefined;
          this.#setState({
            mode: 'authentication_required',
            replica: this.#state.replica,
            reason: 'Your control-plane session expired. Reauthenticate before issuing commands.',
          });
        } else if (error.status === 426) {
          this.#subscription?.close();
          this.#subscription = undefined;
          this.#setState({
            mode: 'upgrade_required',
            replica: this.#state.replica,
            reason: 'This Steward frontend is not compatible with the control plane.',
          });
        } else if (error.status === 409) {
          this.#enterRecoverableFailure(
            generation,
            'The command conflicted with newer authoritative state. Reloading the workspace.',
            0,
          );
        }
      }
      throw error;
    }
    if (generation !== this.#generation || this.#state.mode !== 'live' || !this.#state.replica) {
      return receipt;
    }
    if (receipt.state !== 'rejected') {
      if (receipt.currentControlVersion < this.#state.replica.controlVersion) {
        throw new ReplicaReconciliationError('The command receipt regressed the control version.');
      }
      this.#seenCausations.add(receipt.clientCommandId);
      if (receipt.currentControlVersion !== this.#state.replica.controlVersion) {
        this.#setState({
          mode: 'live',
          replica: parseUiSnapshot({
            ...this.#state.replica,
            controlVersion: receipt.currentControlVersion,
          }),
        });
      }
    }
    return receipt;
  }

  #setState(next: WorkspaceConnectionState): void {
    this.#state = Object.freeze(next);
    this.#onChange(this.#state);
  }

  #clearTransport(): void {
    this.#subscription?.close();
    this.#subscription = undefined;
    this.#bootstrapAbort?.abort();
    this.#bootstrapAbort = undefined;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  async #bootstrap(generation: number): Promise<void> {
    this.#subscription?.close();
    this.#subscription = undefined;
    this.#bootstrapAbort?.abort();
    const controller = new AbortController();
    this.#bootstrapAbort = controller;
    try {
      const raw = await this.#gateway.bootstrap(controller.signal);
      if (generation !== this.#generation || controller.signal.aborted) return;
      const bootstrap = parseUiBootstrap(raw);
      this.#bootstrapAbort = undefined;
      this.#retryAttempt = 0;
      this.#seenCausations.clear();
      this.#setState({ mode: 'live', replica: bootstrap.snapshot });
      this.#subscription = this.#gateway.subscribe({
        afterSequence: bootstrap.snapshot.sequence,
        onEvent: (event) => this.#acceptEvent(generation, event),
        onDisconnect: (reason) => this.#handleDisconnect(generation, reason),
      });
    } catch (error) {
      if (generation !== this.#generation || controller.signal.aborted) return;
      this.#bootstrapAbort = undefined;
      if (error instanceof ControlPlaneTransportError && [401, 403].includes(error.status)) {
        this.#setState({
          mode: 'authentication_required',
          replica: this.#state.replica,
          reason: 'Your control-plane session expired. Reauthenticate before issuing commands.',
        });
        return;
      }
      if (error instanceof ControlPlaneTransportError && error.status === 426) {
        this.#setState({
          mode: 'upgrade_required',
          replica: this.#state.replica,
          reason: 'This Steward frontend is not compatible with the control plane.',
        });
        return;
      }
      this.#enterRecoverableFailure(
        generation,
        error instanceof ProtocolValidationError || error instanceof Error
          ? error.message
          : 'Control-plane bootstrap failed.',
      );
    }
  }

  #acceptEvent(generation: number, event: UiEventEnvelope): void {
    if (generation !== this.#generation || this.#state.mode !== 'live' || !this.#state.replica) {
      return;
    }
    try {
      const replica = applyUiEvent(this.#state.replica, event, this.#seenCausations);
      this.#setState({ mode: 'live', replica });
    } catch (error) {
      this.#enterRecoverableFailure(
        generation,
        error instanceof Error ? error.message : 'Live event reconciliation failed.',
        0,
      );
    }
  }

  #handleDisconnect(generation: number, reason: UiEventStreamTermination): void {
    if (generation !== this.#generation) return;
    this.#subscription?.close();
    this.#subscription = undefined;
    if (reason.kind === 'authentication_expired') {
      this.#setState({
        mode: 'authentication_required',
        replica: this.#state.replica,
        reason: 'Your control-plane session expired. Reauthenticate before issuing commands.',
      });
      return;
    }
    if (reason.kind === 'incompatible_protocol') {
      this.#setState({
        mode: 'upgrade_required',
        replica: this.#state.replica,
        reason: 'This Steward frontend is not compatible with the control plane.',
      });
      return;
    }
    const delay =
      reason.kind === 'retention_miss'
        ? 0
        : reason.kind === 'transient_network'
          ? reason.retryAfterMs ?? retryDelay(this.#retryAttempt, this.#retryBaseMs, this.#retryMaxMs)
          : retryDelay(this.#retryAttempt, this.#retryBaseMs, this.#retryMaxMs);
    this.#enterRecoverableFailure(
      generation,
      reason.kind === 'retention_miss'
        ? 'The event cursor expired. Reloading an authoritative snapshot.'
        : reason.kind === 'protocol_error'
          ? reason.reason
          : 'Live updates disconnected. Displayed state is read-only until reconciliation.',
      delay,
    );
  }

  #enterRecoverableFailure(generation: number, reason: string, delay?: number): void {
    if (generation !== this.#generation) return;
    this.#subscription?.close();
    this.#subscription = undefined;
    this.#setState({ mode: 'stale', replica: this.#state.replica, reason });
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    const wait = delay ?? retryDelay(this.#retryAttempt, this.#retryBaseMs, this.#retryMaxMs);
    this.#retryAttempt += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (generation !== this.#generation) return;
      this.#setState({ mode: 'connecting', replica: this.#state.replica });
      void this.#bootstrap(generation);
    }, wait);
  }
}
