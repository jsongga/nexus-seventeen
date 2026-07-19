import {
  STEWARD_RUNTIME_API_VERSION,
  STEWARD_UI_API_VERSION,
  parseAgentTaskProjection,
  parseManagerReviewPermitConsumeReceipt,
  parseManagerReviewPermitConsumeRequest,
  type AgentConnectionState,
  type AgentRuntimeUpdate,
  type AgentTaskProjection,
  type ClientCommandId,
  type DurableOutboxEvent,
  type EventId,
  type HumanCommandEnvelope,
  type IsoTimestamp,
  type LeaseId,
  type ManagerReviewPermitConsumeReceipt,
  type ManagerReviewPermitConsumeRequest,
  type ProgressEvent,
  type RegisteredAgentProjection,
  type RuntimeCommandEnvelope,
  type SupervisorRegistration,
  type UiBootstrap,
  type UiEventEnvelope,
  type UiEventPayload,
  type UiSnapshot,
  type WorkspaceId,
} from '@cicada/steward-protocol';
import { invariant } from './errors.js';
import type { DurableEvent } from './store.js';
import { agentForecastFrom, shiftAgentForecast } from './timing.js';

export const durableKinds = Object.freeze({
  registered: 'lane.registered',
  leaseRenewed: 'lane.lease_renewed',
  runtimeOutbox: 'runtime.outbox',
  taskQueued: 'human.task_queued',
  runtimeCommand: 'human.runtime_command_issued',
  workspaceControl: 'human.workspace_control_changed',
  managerReviewPermit: 'manager.review_permit_consumed',
});

export interface LaneState {
  registration: SupervisorRegistration;
  /** SHA-256 verifier only; the runtime capability is never persisted. */
  runtimeGenerationProofDigest: string | null;
  runtimeFeatures: readonly string[];
  leaseId: LeaseId;
  leaseGrantedAt: IsoTimestamp;
  leaseExpiresAt: IsoTimestamp;
  registeredAt: IsoTimestamp;
  lastSeenAt: IsoTimestamp;
  lastAcceptedLocalSequence: number;
  currentAction: RegisteredAgentProjection['currentAction'];
  checkpointRef: RegisteredAgentProjection['checkpointRef'];
  controlState: RegisteredAgentProjection['controlState'];
  queue: AgentTaskProjection['taskId'][];
  runtimeCommands: RuntimeCommandEnvelope[];
  pendingInterrupt: {
    commandId: string;
    state: 'requested' | 'acknowledged';
    taskId: string | null;
  } | null;
  pendingHold: {
    commandId: string;
    state: 'requested' | 'acknowledged';
    taskId: string | null;
  } | null;
  pendingResume: {
    commandId: string;
    taskId: string | null;
    checkpointRef: RegisteredAgentProjection['checkpointRef'];
  } | null;
  resumeAfterWorkspacePause: boolean;
  pausedAtByTask: Map<string, IsoTimestamp>;
}

interface RegisteredData extends Record<string, unknown> {
  registration?: SupervisorRegistration;
  /** Pre-CAS alpha records stored the accepted registration under request. */
  request?: SupervisorRegistration;
  leaseId: LeaseId;
  leaseGrantedAt: IsoTimestamp;
  leaseExpiresAt: IsoTimestamp;
  runtimeGenerationProofDigest?: string;
  runtimeFeatures?: readonly string[];
}

interface LeaseData extends Record<string, unknown> {
  leaseGrantedAt: IsoTimestamp;
  leaseExpiresAt: IsoTimestamp;
}

interface OutboxData extends Record<string, unknown> {
  event: DurableOutboxEvent;
}

interface QueuedData extends Record<string, unknown> {
  command: HumanCommandEnvelope;
  task: AgentTaskProjection;
  controlVersion: number;
}

interface RuntimeCommandData extends Record<string, unknown> {
  command: RuntimeCommandEnvelope;
  controlVersion: number;
  advancesControl: boolean;
}

interface WorkspaceControlData extends Record<string, unknown> {
  command: HumanCommandEnvelope;
  controlVersion: number;
}

interface ManagerReviewPermitData extends Record<string, unknown> {
  request: ManagerReviewPermitConsumeRequest;
  permitId: string;
}

function dataAs<T extends Record<string, unknown>>(event: DurableEvent): T {
  return event.data as T;
}

function asIso(value: string): IsoTimestamp {
  return value as IsoTimestamp;
}

export class WorkspaceProjection {
  readonly workspaceId: WorkspaceId;
  readonly lanes = new Map<string, LaneState>();
  readonly tasks = new Map<string, AgentTaskProjection>();
  readonly progress = new Map<string, ProgressEvent[]>();
  readonly reviewPermitsByOperation = new Map<string, ManagerReviewPermitConsumeReceipt>();
  readonly reviewPermitsByTask = new Map<string, ManagerReviewPermitConsumeReceipt>();
  readonly reviewPermitsByEvidence = new Map<string, ManagerReviewPermitConsumeReceipt>();
  readonly uiEvents: UiEventEnvelope[] = [];
  workspacePaused = false;
  controlVersion = 0;
  lastSequence = 0;

  constructor(workspaceId: WorkspaceId) {
    this.workspaceId = workspaceId;
  }

  rebuild(records: readonly DurableEvent[]): void {
    for (const event of records) this.apply(event);
  }

  apply(event: DurableEvent): UiEventEnvelope {
    invariant(
      event.workspaceId === this.workspaceId,
      'PROJECTION_WORKSPACE_MISMATCH',
      'Durable event belongs to another workspace',
    );
    invariant(
      event.workspaceSequence === this.lastSequence + 1,
      'PROJECTION_SEQUENCE_GAP',
      'Durable events must be applied contiguously',
    );

    let payload: UiEventPayload;
    switch (event.kind) {
      case durableKinds.registered:
        payload = this.#applyRegistration(dataAs<RegisteredData>(event), event.occurredAt);
        break;
      case durableKinds.leaseRenewed:
        payload = this.#applyLease(event.laneId, dataAs<LeaseData>(event), event.occurredAt);
        break;
      case durableKinds.runtimeOutbox:
        payload = this.#applyOutbox(dataAs<OutboxData>(event), event.occurredAt);
        break;
      case durableKinds.taskQueued:
        payload = this.#applyTaskQueued(dataAs<QueuedData>(event));
        break;
      case durableKinds.runtimeCommand:
        payload = this.#applyRuntimeCommand(dataAs<RuntimeCommandData>(event), event.occurredAt);
        break;
      case durableKinds.workspaceControl:
        payload = this.#applyWorkspaceControl(dataAs<WorkspaceControlData>(event));
        break;
      case durableKinds.managerReviewPermit:
        payload = this.#applyManagerReviewPermit(
          dataAs<ManagerReviewPermitData>(event),
          event,
        );
        break;
      default:
        throw new Error(`PROJECTION_UNKNOWN_EVENT: ${event.kind}`);
    }

    this.lastSequence = event.workspaceSequence;
    const humanCommandId = (event.data as { humanCommandId?: unknown; command?: { clientCommandId?: unknown } });
    const causation =
      typeof humanCommandId.humanCommandId === 'string'
        ? humanCommandId.humanCommandId
        : typeof humanCommandId.command?.clientCommandId === 'string'
          ? humanCommandId.command.clientCommandId
          : undefined;
    const envelope: UiEventEnvelope = {
      apiVersion: STEWARD_UI_API_VERSION,
      eventId: event.eventId as EventId,
      workspaceId: this.workspaceId,
      sequence: event.workspaceSequence,
      occurredAt: asIso(event.occurredAt),
      ...(causation === undefined
        ? {}
        : { causationClientCommandId: causation as ClientCommandId }),
      payload,
    };
    this.uiEvents.push(envelope);
    return envelope;
  }

  #applyRegistration(data: RegisteredData, occurredAt: string): UiEventPayload {
    const request = data.registration ?? data.request;
    invariant(
      request,
      'PROJECTION_REGISTRATION_MISSING',
      'Registration event has no accepted runtime identity',
    );
    invariant(
      data.runtimeGenerationProofDigest === undefined ||
        /^sha256:[a-f0-9]{64}$/u.test(data.runtimeGenerationProofDigest),
      'PROJECTION_RUNTIME_PROOF_DIGEST_INVALID',
      'Registration event has an invalid runtime proof verifier',
    );
    invariant(
      data.runtimeFeatures === undefined ||
        (Array.isArray(data.runtimeFeatures) &&
          data.runtimeFeatures.every((feature) => typeof feature === 'string')),
      'PROJECTION_RUNTIME_FEATURES_INVALID',
      'Registration event has invalid runtime feature negotiation',
    );
    const lane: LaneState = {
      registration: request,
      runtimeGenerationProofDigest: data.runtimeGenerationProofDigest ?? null,
      runtimeFeatures: Object.freeze([...(data.runtimeFeatures ?? [])]),
      leaseId: data.leaseId,
      leaseGrantedAt: data.leaseGrantedAt,
      leaseExpiresAt: data.leaseExpiresAt,
      registeredAt: asIso(occurredAt),
      lastSeenAt: asIso(occurredAt),
      lastAcceptedLocalSequence: 0,
      currentAction: null,
      checkpointRef: request.checkpointRef,
      controlState: this.workspacePaused ? 'held' : 'active',
      queue: [],
      runtimeCommands: [],
      pendingInterrupt: null,
      pendingHold: null,
      pendingResume: null,
      resumeAfterWorkspacePause: this.workspacePaused,
      pausedAtByTask: new Map(),
    };
    const prior = this.lanes.get(request.laneId);
    if (prior !== undefined) {
      invariant(
        prior.registration.agentId === request.agentId,
        'PROJECTION_AGENT_CHANGED',
        'A stable lane cannot change agent identity',
      );
      invariant(
        prior.registration.role === request.role,
        'PROJECTION_ROLE_CHANGED',
        'A stable lane cannot change its fixed role',
      );
      lane.queue = [...prior.queue];
      lane.runtimeCommands = [...prior.runtimeCommands];
      lane.lastAcceptedLocalSequence = prior.lastAcceptedLocalSequence;
      lane.registeredAt = prior.registeredAt;
      lane.controlState = prior.controlState;
      lane.pendingInterrupt = prior.pendingInterrupt
        ? { ...prior.pendingInterrupt }
        : null;
      lane.pendingHold = prior.pendingHold ? { ...prior.pendingHold } : null;
      lane.pendingResume = prior.pendingResume ? { ...prior.pendingResume } : null;
      lane.resumeAfterWorkspacePause = prior.resumeAfterWorkspacePause;
      lane.pausedAtByTask = new Map(prior.pausedAtByTask);
    }
    this.lanes.set(request.laneId, lane);
    return { type: 'agent_upserted', agent: this.agent(request.laneId, new Date(occurredAt)) };
  }

  #applyLease(laneId: string | undefined, data: LeaseData, occurredAt: string): UiEventPayload {
    const lane = this.requireLane(laneId);
    lane.leaseGrantedAt = data.leaseGrantedAt;
    lane.leaseExpiresAt = data.leaseExpiresAt;
    lane.lastSeenAt = asIso(occurredAt);
    return {
      type: 'agent_runtime_updated',
      agent: this.runtimeUpdate(lane, new Date(occurredAt)),
      task: this.taskForRuntimeUpdate(lane),
    };
  }

  #confirmResume(
    lane: LaneState,
    taskId: string | null,
    resumedAt: IsoTimestamp,
  ): AgentTaskProjection | null {
    const pending = lane.pendingResume;
    if (pending === null) return null;
    invariant(
      pending.taskId === taskId,
      'PROJECTION_RESUME_CAUSATION',
      'Runtime activity does not match the pending resume task',
    );
    lane.pendingResume = null;
    lane.controlState = 'active';
    lane.resumeAfterWorkspacePause = false;
    if (taskId === null) return null;

    const task = this.requireTask(taskId);
    invariant(
      task.status === 'paused',
      'PROJECTION_RESUME_TASK_STATE',
      'Only a paused task can confirm a resume',
    );
    const pausedAt = lane.pausedAtByTask.get(task.taskId);
    const updated: AgentTaskProjection = {
      ...task,
      status: 'running',
      expectedCompletedAt:
        pausedAt === undefined
          ? task.expectedCompletedAt
          : shiftAgentForecast(task.expectedCompletedAt, pausedAt, resumedAt),
    };
    this.tasks.set(task.taskId, updated);
    lane.pausedAtByTask.delete(task.taskId);
    return updated;
  }

  #applyOutbox(data: OutboxData, occurredAt: string): UiEventPayload {
    const outbox = data.event;
    const lane = this.requireLane(outbox.laneId);
    invariant(
      outbox.runtimeEpoch === lane.registration.runtimeEpoch,
      'PROJECTION_STALE_EPOCH',
      'Outbox event was committed for a stale epoch',
    );
    invariant(
      outbox.localSequence === lane.lastAcceptedLocalSequence + 1,
      'PROJECTION_LOCAL_SEQUENCE_GAP',
      'Runtime local sequences must be contiguous',
    );
    lane.lastAcceptedLocalSequence = outbox.localSequence;
    lane.lastSeenAt = asIso(occurredAt);

    const agentOccurredAt = outbox.occurredAt;
    switch (outbox.payload.type) {
      case 'progress': {
        if (lane.pendingResume !== null) {
          this.#confirmResume(lane, outbox.payload.taskId, agentOccurredAt);
        }
        const task = this.requireTask(outbox.payload.taskId);
        const startedAt =
          task.startedAt ??
          (lane.currentAction?.taskId === task.taskId
            ? lane.currentAction.startedAt
            : agentOccurredAt);
        const next: AgentTaskProjection = {
          ...task,
          status: 'running',
          startedAt,
          expectedCompletedAt:
            task.startedAt === null
              ? agentForecastFrom(startedAt, task.expectedAgentMinutes)
              : task.expectedCompletedAt,
        };
        this.tasks.set(task.taskId, next);
        const entry: ProgressEvent = {
          taskId: outbox.payload.taskId,
          phase: outbox.payload.phase,
          iteration: outbox.payload.iteration,
          journal: outbox.payload.journal,
          occurredAt: agentOccurredAt,
          ...(outbox.payload.phase === 'test' ? { outcome: outbox.payload.outcome } : {}),
        } as ProgressEvent;
        const entries = this.progress.get(task.taskId) ?? [];
        entries.push(entry);
        this.progress.set(task.taskId, entries);
        return { type: 'progress_recorded', progress: entry, task: next };
      }
      case 'heartbeat': {
        let resumedTask: AgentTaskProjection | null = null;
        if (lane.pendingResume !== null) {
          if (outbox.payload.currentAction !== null) {
            resumedTask = this.#confirmResume(
              lane,
              outbox.payload.currentAction.taskId,
              outbox.payload.currentAction.startedAt,
            );
          } else if (lane.pendingResume.taskId === null) {
            this.#confirmResume(lane, null, agentOccurredAt);
          }
        }
        lane.currentAction = outbox.payload.currentAction;
        lane.checkpointRef = outbox.payload.checkpointRef;
        let task: AgentTaskProjection | null = resumedTask;
        if (outbox.payload.currentAction !== null) {
          const current = this.requireTask(outbox.payload.currentAction.taskId);
          invariant(
            current.status !== 'completed' && current.status !== 'failed',
            'PROJECTION_TERMINAL_TASK_ACTION',
            'A terminal task cannot become the current action',
          );
          const next: AgentTaskProjection = {
            ...current,
            status: 'running',
            startedAt: current.startedAt ?? outbox.payload.currentAction.startedAt,
            expectedCompletedAt:
              current.startedAt === null
                ? agentForecastFrom(
                    outbox.payload.currentAction.startedAt,
                    current.expectedAgentMinutes,
                  )
                : current.expectedCompletedAt,
            endedAt: null,
          };
          this.tasks.set(next.taskId, next);
          task = next;
        }
        return {
          type: 'agent_runtime_updated',
          agent: this.runtimeUpdate(lane, new Date(occurredAt)),
          task,
        };
      }
      case 'interrupt_acknowledged':
        invariant(
          lane.pendingInterrupt?.commandId === outbox.payload.commandId &&
            lane.pendingInterrupt.state === 'requested',
          'PROJECTION_INTERRUPT_CAUSATION',
          'Interrupt acknowledgement does not match a pending request',
        );
        lane.pendingInterrupt = {
          commandId: outbox.payload.commandId,
          state: 'acknowledged',
          taskId: outbox.payload.taskId,
        };
        lane.controlState = 'interrupt_requested';
        return {
          type: 'agent_runtime_updated',
          agent: this.runtimeUpdate(lane, new Date(occurredAt)),
          task:
            outbox.payload.taskId === null
              ? this.taskForRuntimeUpdate(lane)
              : this.requireTask(outbox.payload.taskId),
        };
      case 'interrupt_refused':
        invariant(
          lane.pendingInterrupt?.commandId === outbox.payload.commandId &&
            lane.pendingInterrupt.state === 'requested',
          'PROJECTION_INTERRUPT_CAUSATION',
          'Interrupt refusal does not match a pending request',
        );
        lane.pendingInterrupt = null;
        lane.controlState = this.workspacePaused ? 'held' : 'active';
        return {
          type: 'agent_runtime_updated',
          agent: this.runtimeUpdate(lane, new Date(occurredAt)),
          task: this.taskForRuntimeUpdate(lane),
        };
      case 'interrupt_settled': {
        invariant(
          lane.pendingInterrupt?.commandId === outbox.payload.commandId &&
            lane.pendingInterrupt.state === 'acknowledged' &&
            lane.pendingInterrupt.taskId === outbox.payload.taskId,
          'PROJECTION_INTERRUPT_CAUSATION',
          'Interrupt settlement does not match its acknowledgement',
        );
        lane.pendingInterrupt = null;
        lane.controlState = 'paused';
        lane.currentAction = null;
        lane.checkpointRef = outbox.payload.checkpointRef;
        let updatedTask: AgentTaskProjection | null = null;
        if (outbox.payload.taskId !== null) {
          const task = this.requireTask(outbox.payload.taskId);
          updatedTask = { ...task, status: 'paused' };
          this.tasks.set(task.taskId, updatedTask);
          lane.pausedAtByTask.set(task.taskId, agentOccurredAt);
        }
        return {
          type: 'agent_runtime_updated',
          agent: this.runtimeUpdate(lane, new Date(occurredAt)),
          task: updatedTask,
        };
      }
      case 'hold_acknowledged': {
        invariant(
          lane.pendingHold?.commandId === outbox.payload.commandId &&
            lane.pendingHold.state === 'requested',
          'PROJECTION_HOLD_CAUSATION',
          'Hold acknowledgement does not match a pending request',
        );
        lane.pendingHold = {
          commandId: outbox.payload.commandId,
          state: 'acknowledged',
          taskId: outbox.payload.taskId,
        };
        lane.controlState = 'hold_requested';
        return {
          type: 'agent_runtime_updated',
          agent: this.runtimeUpdate(lane, new Date(occurredAt)),
          task:
            outbox.payload.taskId === null
              ? this.taskForRuntimeUpdate(lane)
              : this.requireTask(outbox.payload.taskId),
        };
      }
      case 'hold_settled': {
        invariant(
          lane.pendingHold?.commandId === outbox.payload.commandId &&
            lane.pendingHold.state === 'acknowledged' &&
            lane.pendingHold.taskId === outbox.payload.taskId,
          'PROJECTION_HOLD_CAUSATION',
          'Hold settlement does not match its acknowledgement',
        );
        lane.pendingHold = null;
        lane.controlState = 'held';
        lane.currentAction = null;
        lane.checkpointRef = outbox.payload.checkpointRef;
        let updatedTask: AgentTaskProjection | null = null;
        if (outbox.payload.taskId !== null) {
          const task = this.requireTask(outbox.payload.taskId);
          updatedTask = { ...task, status: 'paused' };
          this.tasks.set(task.taskId, updatedTask);
          lane.pausedAtByTask.set(task.taskId, agentOccurredAt);
        }
        return {
          type: 'agent_runtime_updated',
          agent: this.runtimeUpdate(lane, new Date(occurredAt)),
          task: updatedTask,
        };
      }
      case 'task_completed': {
        if (lane.pendingResume !== null) {
          this.#confirmResume(lane, outbox.payload.taskId, agentOccurredAt);
        }
        const task = this.requireTask(outbox.payload.taskId);
        const next: AgentTaskProjection = {
          ...task,
          status: 'completed',
          endedAt: agentOccurredAt,
        };
        this.tasks.set(task.taskId, next);
        lane.currentAction = null;
        lane.checkpointRef = outbox.payload.checkpointRef;
        lane.queue = lane.queue.filter((taskId) => taskId !== task.taskId);
        lane.pausedAtByTask.delete(task.taskId);
        return {
          type: 'agent_runtime_updated',
          agent: this.runtimeUpdate(lane, new Date(occurredAt)),
          task: next,
        };
      }
      case 'task_failed': {
        if (lane.pendingResume !== null) {
          this.#confirmResume(lane, outbox.payload.taskId, agentOccurredAt);
        }
        const task = this.requireTask(outbox.payload.taskId);
        const next: AgentTaskProjection = {
          ...task,
          status: 'failed',
          startedAt: task.startedAt ?? agentOccurredAt,
          endedAt: agentOccurredAt,
        };
        this.tasks.set(task.taskId, next);
        lane.currentAction = null;
        lane.checkpointRef = outbox.payload.checkpointRef;
        lane.queue = lane.queue.filter((taskId) => taskId !== task.taskId);
        lane.pausedAtByTask.delete(task.taskId);
        return {
          type: 'agent_runtime_updated',
          agent: this.runtimeUpdate(lane, new Date(occurredAt)),
          task: next,
        };
      }
    }
  }

  #applyTaskQueued(data: QueuedData): UiEventPayload {
    invariant(
      data.controlVersion === this.controlVersion + 1,
      'PROJECTION_CONTROL_VERSION_GAP',
      'Human control versions must advance by one',
    );
    this.controlVersion = data.controlVersion;
    // Pre-subject alpha records can be normalized only when their fixed lane
    // is an engineer lane. Never infer a manager-review evidence binding from
    // title/objective prose; legacy non-engineer tasks fail replay closed.
    const candidate = data.task as AgentTaskProjection & { subject?: AgentTaskProjection['subject'] };
    const task = Object.hasOwn(candidate, 'subject')
      ? parseAgentTaskProjection(candidate)
      : (() => {
          const lane = this.requireLane(candidate.laneId);
          invariant(
            lane.registration.role === 'engineer',
            'PROJECTION_LEGACY_TASK_SUBJECT_REQUIRED',
            'Legacy non-engineer tasks require an explicit typed subject',
          );
          return parseAgentTaskProjection({ ...candidate, subject: { type: 'development' } });
        })();
    this.tasks.set(task.taskId, task);
    return { type: 'task_upserted', task };
  }

  #applyRuntimeCommand(data: RuntimeCommandData, occurredAt: string): UiEventPayload {
    if (data.advancesControl) {
      invariant(
        data.controlVersion === this.controlVersion + 1,
        'PROJECTION_CONTROL_VERSION_GAP',
        'Human control versions must advance by one',
      );
      this.controlVersion = data.controlVersion;
    } else {
      invariant(
        data.controlVersion === this.controlVersion,
        'PROJECTION_CONTROL_VERSION_MISMATCH',
        'Runtime command must use the accepted control version',
      );
    }
    const command = data.command;
    const lane = this.requireLane(command.laneId);
    let taskUpdate: AgentTaskProjection | null = null;
    lane.runtimeCommands.push(command);
    switch (command.payload.type) {
      case 'assign_task':
        if (!lane.queue.includes(command.payload.task.taskId)) lane.queue.push(command.payload.task.taskId);
        taskUpdate = this.requireTask(command.payload.task.taskId);
        break;
      case 'recover_task':
        invariant(
          command.payload.task.subject.type === 'manager_review' &&
            command.payload.task.status === 'running',
          'PROJECTION_RECOVER_TASK_INVALID',
          'Only a running manager-review task can be rebound for recovery',
        );
        if (!lane.queue.includes(command.payload.task.taskId)) lane.queue.push(command.payload.task.taskId);
        taskUpdate = this.requireTask(command.payload.task.taskId);
        break;
      case 'request_interrupt':
        if (lane.pendingInterrupt?.commandId !== command.commandId) {
          lane.pendingInterrupt = {
            commandId: command.commandId,
            state: 'requested',
            taskId: null,
          };
        }
        lane.controlState = 'interrupt_requested';
        break;
      case 'resume': {
        if (lane.pendingResume?.commandId !== command.commandId) {
          lane.pendingResume = {
            commandId: command.commandId,
            taskId: command.payload.taskId,
            checkpointRef: command.payload.checkpointRef,
          };
        }
        lane.controlState = 'resume_requested';
        lane.checkpointRef = command.payload.checkpointRef;
        break;
      }
      case 'hold':
        if (lane.pendingHold?.commandId !== command.commandId) {
          lane.pendingHold = {
            commandId: command.commandId,
            state: 'requested',
            taskId: null,
          };
        }
        lane.controlState = 'hold_requested';
        break;
    }
    return {
      type: 'agent_runtime_updated',
      agent: this.runtimeUpdate(lane, new Date(occurredAt)),
      task: taskUpdate ?? this.taskForRuntimeUpdate(lane),
    };
  }

  #applyWorkspaceControl(data: WorkspaceControlData): UiEventPayload {
    invariant(
      data.controlVersion === this.controlVersion + 1,
      'PROJECTION_CONTROL_VERSION_GAP',
      'Human control versions must advance by one',
    );
    invariant(
      data.command.payload.type === 'set_workspace_pause',
      'PROJECTION_COMMAND_KIND',
      'Workspace control event contains the wrong human command',
    );
    this.controlVersion = data.controlVersion;
    this.workspacePaused = data.command.payload.paused;
    if (this.workspacePaused) {
      for (const lane of this.lanes.values()) {
        lane.resumeAfterWorkspacePause = lane.controlState === 'active';
      }
    }
    return {
      type: 'workspace_control_updated',
      paused: this.workspacePaused,
      controlVersion: this.controlVersion,
    };
  }

  #applyManagerReviewPermit(
    data: ManagerReviewPermitData,
    event: DurableEvent,
  ): UiEventPayload {
    const request = parseManagerReviewPermitConsumeRequest(data.request);
    const lane = this.requireLane(request.managerLaneId);
    const task = this.requireTask(request.reviewTaskId);
    const sourceTask = this.requireTask(request.sourceTaskId);
    invariant(
      event.laneId === request.managerLaneId &&
      lane.registration.role === 'manager' &&
        lane.registration.agentId === request.managerAgentId &&
        lane.registration.runtimeInstanceId === request.runtimeInstanceId &&
        lane.registration.runtimeEpoch === request.runtimeEpoch,
      'PROJECTION_REVIEW_PERMIT_IDENTITY',
      'Manager-review permit does not match the accepted runtime generation',
    );
    invariant(
      task.agentId === request.managerAgentId &&
        task.laneId === request.managerLaneId &&
        task.status === 'running' &&
        lane.currentAction?.taskId === task.taskId,
      'PROJECTION_REVIEW_PERMIT_TASK_STATE',
      'Manager-review permit requires the assigned running task',
    );
    invariant(
      task.subject.type === 'manager_review' &&
        task.subject.sourceTaskId === request.sourceTaskId &&
        task.subject.evidenceId === request.evidenceId &&
        task.subject.evidenceDigest === request.evidenceDigest,
      'PROJECTION_REVIEW_PERMIT_SUBJECT',
      'Manager-review permit does not match its immutable task subject',
    );
    invariant(
      sourceTask.status === 'completed' &&
        sourceTask.agentId !== request.managerAgentId &&
        Date.parse(sourceTask.endedAt ?? '') <= Date.parse(event.occurredAt) &&
        task.startedAt !== null &&
        Date.parse(task.startedAt) <= Date.parse(event.occurredAt),
      'PROJECTION_REVIEW_PERMIT_TIMELINE',
      'Manager-review permit has an invalid source or review task timeline',
    );
    invariant(
      !this.reviewPermitsByOperation.has(request.operationId) &&
        !this.reviewPermitsByTask.has(request.reviewTaskId) &&
        !this.reviewPermitsByEvidence.has(request.evidenceId),
      'PROJECTION_REVIEW_PERMIT_DUPLICATE',
      'Manager-review permit was consumed more than once',
    );

    const receipt = parseManagerReviewPermitConsumeReceipt({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      state: 'accepted',
      permitId: data.permitId,
      operationId: request.operationId,
      workspaceId: request.workspaceId,
      reviewTaskId: request.reviewTaskId,
      sourceTaskId: request.sourceTaskId,
      evidenceId: request.evidenceId,
      evidenceDigest: request.evidenceDigest,
      managerAgentId: request.managerAgentId,
      managerLaneId: request.managerLaneId,
      managerRuntimeInstanceId: request.runtimeInstanceId,
      managerRuntimeEpoch: request.runtimeEpoch,
      reviewRequestDigest: request.reviewRequestDigest,
      authorizedAt: event.occurredAt,
      workspaceSequence: event.workspaceSequence,
    });
    this.reviewPermitsByOperation.set(receipt.operationId, receipt);
    this.reviewPermitsByTask.set(receipt.reviewTaskId, receipt);
    this.reviewPermitsByEvidence.set(receipt.evidenceId, receipt);

    const completed: AgentTaskProjection = {
      ...task,
      status: 'completed',
      endedAt: receipt.authorizedAt,
    };
    this.tasks.set(completed.taskId, completed);
    lane.currentAction = null;
    lane.queue = lane.queue.filter((taskId) => taskId !== completed.taskId);
    lane.pausedAtByTask.delete(completed.taskId);
    return {
      type: 'agent_runtime_updated',
      agent: this.runtimeUpdate(lane, new Date(event.occurredAt)),
      task: completed,
    };
  }

  requireLane(laneId: string | undefined): LaneState {
    invariant(laneId !== undefined, 'PROJECTION_LANE_REQUIRED', 'Event requires a lane');
    const lane = this.lanes.get(laneId);
    invariant(lane, 'PROJECTION_LANE_MISSING', `Unknown lane: ${laneId}`);
    return lane;
  }

  requireTask(taskId: string): AgentTaskProjection {
    const task = this.tasks.get(taskId);
    invariant(task, 'PROJECTION_TASK_MISSING', `Unknown task: ${taskId}`);
    return task;
  }

  connectionState(lane: LaneState, now: Date): AgentConnectionState {
    return now.getTime() <= Date.parse(lane.leaseExpiresAt) ? 'online' : 'offline';
  }

  agent(laneId: string, now: Date): RegisteredAgentProjection {
    const lane = this.requireLane(laneId);
    const registration = lane.registration;
    return {
      workspaceId: registration.workspaceId,
      agentId: registration.agentId,
      laneId: registration.laneId,
      runtimeInstanceId: registration.runtimeInstanceId,
      runtimeEpoch: registration.runtimeEpoch,
      displayName: registration.displayName,
      role: registration.role,
      capabilities: registration.capabilities,
      provider: registration.provider,
      softwareVersion: registration.softwareVersion,
      checkpointRef: lane.checkpointRef,
      registeredAt: lane.registeredAt,
      lastSeenAt: lane.lastSeenAt,
      leaseExpiresAt: lane.leaseExpiresAt,
      currentAction: lane.currentAction,
      connectionState: this.connectionState(lane, now),
      controlState: lane.controlState,
      controlVersion: this.controlVersion,
      queue: lane.queue,
    };
  }

  taskForRuntimeUpdate(lane: LaneState): AgentTaskProjection | null {
    const currentTaskId = lane.currentAction?.taskId;
    if (currentTaskId !== undefined) {
      return this.tasks.get(currentTaskId) ?? null;
    }
    for (const taskId of lane.queue) {
      const task = this.tasks.get(taskId);
      if (task !== undefined && task.status !== 'completed' && task.status !== 'failed') {
        return task;
      }
    }
    return null;
  }

  runtimeUpdate(lane: LaneState, now: Date): AgentRuntimeUpdate {
    const registration = lane.registration;
    return {
      agentId: registration.agentId,
      laneId: registration.laneId,
      runtimeInstanceId: registration.runtimeInstanceId,
      runtimeEpoch: registration.runtimeEpoch,
      leaseExpiresAt: lane.leaseExpiresAt,
      lastSeenAt: lane.lastSeenAt,
      checkpointRef: lane.checkpointRef,
      currentAction: lane.currentAction,
      connectionState: this.connectionState(lane, now),
      controlState: lane.controlState,
      controlVersion: this.controlVersion,
      queue: lane.queue,
    };
  }

  snapshot(now: Date): UiSnapshot {
    return {
      apiVersion: STEWARD_UI_API_VERSION,
      workspaceId: this.workspaceId,
      generatedAt: asIso(now.toISOString()),
      sequence: this.lastSequence,
      paused: this.workspacePaused,
      controlVersion: this.controlVersion,
      agents: [...this.lanes.keys()].sort().map((laneId) => this.agent(laneId, now)),
      tasks: [...this.tasks.values()].sort((left, right) => left.taskId.localeCompare(right.taskId)),
      progress: [...this.progress.values()].flat(),
    };
  }

  bootstrap(
    now: Date,
    metadata: Omit<UiBootstrap, 'apiVersion' | 'snapshot'>,
  ): UiBootstrap {
    return {
      apiVersion: STEWARD_UI_API_VERSION,
      ...metadata,
      snapshot: this.snapshot(now),
    };
  }
}
