import type {
  AgentId,
  AgentLaneId,
  Brand,
  EngineeringLoop,
  EngineeringLoopStage,
  HumanActor,
  ISODateTime,
  PolicyDecision,
  PolicyFailureCode,
  Principal,
  TestOutcome,
  UserId,
} from './types';
import {
  AGENT_ESTIMATE_INTERVAL_MINUTES,
  type AgentExpectedMinutes,
} from './agent-task';

export type { AgentLaneId } from './types';
export type AgentRunId = Brand<string, 'AgentRunId'>;
export type QueuedWorkId = Brand<string, 'QueuedWorkId'>;
export type RunControlSignalId = Brand<string, 'RunControlSignalId'>;

export const agentLaneId = (value: string): AgentLaneId => value as AgentLaneId;
export const agentRunId = (value: string): AgentRunId => value as AgentRunId;
export const queuedWorkId = (value: string): QueuedWorkId => value as QueuedWorkId;
export const runControlSignalId = (value: string): RunControlSignalId =>
  value as RunControlSignalId;

export interface AuthenticatedHumanApprover extends HumanActor {
  readonly authenticated: true;
}

export interface RunEvidenceRecord {
  readonly sequence: number;
  readonly summary: string;
  readonly recordedAt: ISODateTime;
}

export interface EngineeringLoopCheckpoint {
  readonly stage: EngineeringLoopStage;
  readonly iteration: number;
  readonly status: EngineeringLoop['status'];
  readonly lastTestOutcome?: TestOutcome;
}

export type AgentQueuePriority = 'next' | 'backlog';

/**
 * Queued work belongs to the stable agent lane, never to one provider process.
 * A run may finish, be interrupted, or be replaced without stranding the item.
 */
export interface QueuedAgentWork {
  readonly id: QueuedWorkId;
  readonly laneId: AgentLaneId;
  readonly agentId: AgentId;
  readonly position: number;
  readonly priority: AgentQueuePriority;
  readonly title: string;
  readonly desiredOutcome: string;
  /** Expected model/tool working time. Human review and waiting time are excluded. */
  readonly expectedAgentMinutes: AgentExpectedMinutes;
  readonly status: 'queued';
  readonly queuedBy: UserId;
  readonly queuedAt: ISODateTime;
}

export type InterruptionOutcome = 'interrupted' | 'refused' | 'unknown';

export type RunCompletionRelation =
  | 'without_interruption'
  // The natural terminal event won before cancellation took effect; it may
  // still have occurred after the human requested interruption.
  | 'before_cancellation'
  | 'after_cancellation_attempt';

export type HumanRunControlStatus =
  | 'idle'
  | 'running'
  | 'interrupt_requested'
  | 'interrupt_acknowledged'
  | 'interrupted'
  | 'interrupt_refused'
  | 'interrupt_unknown';

export type RunControlAction =
  | 'work_queued'
  | 'run_started'
  | 'run_replaced'
  | 'run_completed'
  | 'run_reconciled_running'
  | 'interrupt_requested'
  | 'interrupt_acknowledged'
  | 'interrupt_settled'
  | 'resumed';

/** @deprecated Human commands are the human-issued subset of RunControlAction. */
export type HumanRunControlAction = Extract<
  RunControlAction,
  'work_queued' | 'interrupt_requested' | 'resumed'
>;

export interface RunControlSignal {
  readonly id: RunControlSignalId;
  readonly laneId: AgentLaneId;
  readonly runId?: AgentRunId;
  readonly action: RunControlAction;
  readonly issuedBy: UserId | 'orchestration-worker';
  readonly issuerKind: 'human' | 'service';
  readonly issuedAt: ISODateTime;
  readonly note: string;
  readonly queuedWorkId?: QueuedWorkId;
  readonly queuePriority?: AgentQueuePriority;
  readonly expectedAgentMinutes?: AgentExpectedMinutes;
  readonly interruptionOutcome?: InterruptionOutcome;
  readonly replacedRunId?: AgentRunId;
  readonly completionRelation?: RunCompletionRelation;
  readonly completionFromStatus?: HumanRunControlStatus;
  readonly providerEvidence?: string;
}

/** @deprecated Use RunControlSignal; the log now includes service transitions too. */
export type HumanRunControlSignal = RunControlSignal;

export interface AgentRunInterruption {
  readonly runId: AgentRunId;
  readonly requestSignalId: RunControlSignalId;
  readonly requestedBy: UserId;
  readonly requestedAt: ISODateTime;
  readonly reason: string;
  readonly acknowledgementSignalId?: RunControlSignalId;
  readonly acknowledgedAt?: ISODateTime;
  readonly settlementSignalId?: RunControlSignalId;
  readonly settledAt?: ISODateTime;
  readonly outcome?: InterruptionOutcome;
  readonly outcomeDetail?: string;
  readonly resumeSignalId?: RunControlSignalId;
  readonly resumedAt?: ISODateTime;
  readonly resumedBy?: UserId;
  readonly reconciliationSignalId?: RunControlSignalId;
  readonly reconciledAt?: ISODateTime;
  readonly reconciliationEvidence?: string;
}

export interface AgentRunCompletion {
  readonly runId: AgentRunId;
  readonly signalId: RunControlSignalId;
  readonly completedAt: ISODateTime;
  readonly relationToInterruption: RunCompletionRelation;
  readonly priorControlStatus: HumanRunControlStatus;
  readonly note: string;
  readonly providerEvidence: string;
}

/**
 * Scheduler state is deliberately separate from engineering-loop state. Human
 * controls can stop scheduling, but cannot alter evidence, skip a loop phase,
 * or manufacture a passing Test result.
 */
export interface HumanRunControlState {
  readonly laneId: AgentLaneId;
  readonly agentId: AgentId;
  readonly activeRunId?: AgentRunId;
  readonly activeRunStartedAt?: ISODateTime;
  readonly status: HumanRunControlStatus;
  readonly queue: readonly QueuedAgentWork[];
  readonly evidence: readonly RunEvidenceRecord[];
  readonly signals: readonly RunControlSignal[];
  readonly loopCheckpoint?: EngineeringLoopCheckpoint;
  readonly interruption?: AgentRunInterruption;
  readonly lastCompletion?: AgentRunCompletion;
}

function allow<Value>(value: Value): PolicyDecision<Value> {
  return { allowed: true, value };
}

function deny<Value>(code: PolicyFailureCode, reason: string): PolicyDecision<Value> {
  return { allowed: false, code, reason };
}

function immutableState(state: HumanRunControlState): HumanRunControlState {
  return Object.freeze({
    ...state,
    queue: Object.freeze(state.queue.map((item) => Object.freeze({ ...item }))),
    evidence: Object.freeze(state.evidence.map((item) => Object.freeze({ ...item }))),
    signals: Object.freeze(state.signals.map((signal) => Object.freeze({ ...signal }))),
    ...(state.loopCheckpoint === undefined
      ? {}
      : { loopCheckpoint: Object.freeze({ ...state.loopCheckpoint }) }),
    ...(state.interruption === undefined
      ? {}
      : { interruption: Object.freeze({ ...state.interruption }) }),
    ...(state.lastCompletion === undefined
      ? {}
      : { lastCompletion: Object.freeze({ ...state.lastCompletion }) }),
  });
}

function validTimestamp(timestamp: ISODateTime): boolean {
  return String(timestamp).trim().length > 0 && !Number.isNaN(Date.parse(timestamp));
}

function validateTimestamp(
  state: HumanRunControlState,
  timestamp: ISODateTime,
): PolicyDecision<true> {
  const priorTimestamp = state.signals.at(-1)?.issuedAt ?? state.activeRunStartedAt;
  if (
    !validTimestamp(timestamp) ||
    (priorTimestamp !== undefined && Date.parse(timestamp) < Date.parse(priorTimestamp))
  ) {
    return deny(
      'INVALID_RUN_CONTROL_TIMESTAMP',
      'Run-control transitions require a valid timestamp that does not precede the prior signal.',
    );
  }

  return allow(true);
}

function requireAuthenticatedHuman(
  actor: Principal,
): PolicyDecision<AuthenticatedHumanApprover> {
  if (actor.kind !== 'human' || actor.role !== 'human_approver') {
    return deny(
      'HUMAN_RUN_CONTROL_REQUIRED',
      'Only a human approver may queue, request an interruption, or resume agent work.',
    );
  }

  if (actor.authenticated !== true) {
    return deny(
      'HUMAN_AUTHENTICATION_REQUIRED',
      'Agent run control requires an authenticated human approver.',
    );
  }

  return allow(actor as AuthenticatedHumanApprover);
}

function requireOrchestrationWorker(
  actor: Principal,
): PolicyDecision<'orchestration-worker'> {
  if (actor.kind !== 'service' || actor.id !== 'orchestration-worker') {
    return deny(
      'ORCHESTRATION_WORKER_REQUIRED',
      'Only the orchestration worker may report provider outcomes or change run attempts.',
    );
  }

  return allow(actor.id);
}

type SignalWithoutId = Omit<RunControlSignal, 'id'>;

function sameSignal(left: RunControlSignal, right: SignalWithoutId): boolean {
  return (
    left.laneId === right.laneId &&
    left.runId === right.runId &&
    left.action === right.action &&
    left.issuedBy === right.issuedBy &&
    left.issuerKind === right.issuerKind &&
    left.issuedAt === right.issuedAt &&
    left.note === right.note &&
    left.queuedWorkId === right.queuedWorkId &&
    left.queuePriority === right.queuePriority &&
    left.expectedAgentMinutes === right.expectedAgentMinutes &&
    left.interruptionOutcome === right.interruptionOutcome &&
    left.replacedRunId === right.replacedRunId &&
    left.completionRelation === right.completionRelation &&
    left.completionFromStatus === right.completionFromStatus &&
    left.providerEvidence === right.providerEvidence
  );
}

function replay(
  state: HumanRunControlState,
  signalId: RunControlSignalId,
  expected: SignalWithoutId,
): PolicyDecision<HumanRunControlState> | undefined {
  const prior = state.signals.find((signal) => signal.id === signalId);
  if (prior === undefined) {
    return undefined;
  }

  if (!sameSignal(prior, expected)) {
    return deny(
      'RUN_CONTROL_REPLAY_CONFLICT',
      'A run-control signal id cannot be reused with different transition data.',
    );
  }

  return allow(immutableState(state));
}

function appendSignal(
  state: HumanRunControlState,
  id: RunControlSignalId,
  signal: SignalWithoutId,
): readonly RunControlSignal[] {
  return [...state.signals, Object.freeze({ id, ...signal })];
}

function requireActiveRun(
  state: HumanRunControlState,
  runId?: AgentRunId,
): PolicyDecision<AgentRunId> {
  if (state.activeRunId === undefined) {
    return deny('RUN_NOT_ACTIVE', 'The agent lane has no active run attempt.');
  }

  if (runId !== undefined && runId !== state.activeRunId) {
    return deny(
      'RUN_ATTEMPT_MISMATCH',
      'The provider result does not belong to the lane\'s active run attempt.',
    );
  }

  return allow(state.activeRunId);
}

function runAttemptWasSeen(
  state: HumanRunControlState,
  runId: AgentRunId,
): boolean {
  return state.signals.some(
    (signal) => signal.runId === runId || signal.replacedRunId === runId,
  );
}

export interface CreateHumanRunControlStateInput {
  readonly laneId: AgentLaneId;
  readonly agentId: AgentId;
  readonly activeRunId?: AgentRunId;
  readonly activeRunStartedAt?: ISODateTime;
  readonly evidence?: readonly RunEvidenceRecord[];
  readonly loopCheckpoint?: EngineeringLoopCheckpoint;
}

export function createHumanRunControlState(
  input: CreateHumanRunControlStateInput,
): HumanRunControlState {
  if (input.activeRunStartedAt !== undefined && !validTimestamp(input.activeRunStartedAt)) {
    throw new Error('An active run start requires a valid timestamp.');
  }
  if (input.activeRunId === undefined && input.activeRunStartedAt !== undefined) {
    throw new Error('An idle agent lane cannot have an active-run timestamp.');
  }

  return immutableState({
    laneId: input.laneId,
    agentId: input.agentId,
    ...(input.activeRunId === undefined ? {} : { activeRunId: input.activeRunId }),
    ...(input.activeRunStartedAt === undefined
      ? {}
      : { activeRunStartedAt: input.activeRunStartedAt }),
    status: input.activeRunId === undefined ? 'idle' : 'running',
    queue: [],
    evidence: input.evidence ?? [],
    signals: [],
    ...(input.loopCheckpoint === undefined
      ? {}
      : { loopCheckpoint: input.loopCheckpoint }),
  });
}

export function createEngineeringRunControlState(
  runId: AgentRunId,
  loop: EngineeringLoop,
  laneId: AgentLaneId = agentLaneId(`engineer:${String(loop.engineerId)}`),
): HumanRunControlState {
  return createHumanRunControlState({
    laneId,
    activeRunId: runId,
    agentId: loop.engineerId,
    evidence: loop.journal.map((entry) => ({
      sequence: entry.sequence,
      summary: entry.summary,
      recordedAt: entry.recordedAt,
    })),
    loopCheckpoint: {
      stage: loop.stage,
      iteration: loop.iteration,
      status: loop.status,
      ...(loop.lastTestOutcome === undefined
        ? {}
        : { lastTestOutcome: loop.lastTestOutcome }),
    },
  });
}

export interface QueueAgentWorkInput {
  readonly control: HumanRunControlState;
  readonly actor: Principal;
  readonly workId: QueuedWorkId;
  readonly signalId: RunControlSignalId;
  readonly title: string;
  readonly desiredOutcome: string;
  readonly expectedAgentMinutes: AgentExpectedMinutes;
  readonly priority?: AgentQueuePriority;
  readonly queuedAt: ISODateTime;
}

export function queueAgentWork(
  input: QueueAgentWorkInput,
): PolicyDecision<HumanRunControlState> {
  const humanCheck = requireAuthenticatedHuman(input.actor);
  if (!humanCheck.allowed) {
    return humanCheck;
  }

  const title = input.title.trim();
  if (title.length === 0) {
    return deny('QUEUE_ITEM_TITLE_REQUIRED', 'Queued work requires a non-empty title.');
  }

  const desiredOutcome = input.desiredOutcome.trim();
  if (desiredOutcome.length === 0) {
    return deny(
      'QUEUE_ITEM_OUTCOME_REQUIRED',
      'Queued work requires a result-oriented desired outcome.',
    );
  }

  if (
    !Number.isSafeInteger(input.expectedAgentMinutes) ||
    input.expectedAgentMinutes <= 0 ||
    input.expectedAgentMinutes % AGENT_ESTIMATE_INTERVAL_MINUTES !== 0
  ) {
    return deny(
      'AGENT_ESTIMATE_INTERVAL_REQUIRED',
      'Expected agent work time must be a positive 15-minute increment and must exclude human wait time.',
    );
  }

  const priority = input.priority ?? 'backlog';

  const signal: SignalWithoutId = {
    laneId: input.control.laneId,
    action: 'work_queued',
    issuedBy: humanCheck.value.id,
    issuerKind: 'human',
    issuedAt: input.queuedAt,
    note: `${title}: ${desiredOutcome}`,
    queuedWorkId: input.workId,
    queuePriority: priority,
    expectedAgentMinutes: input.expectedAgentMinutes,
  };
  const replayDecision = replay(input.control, input.signalId, signal);
  if (replayDecision !== undefined) {
    return replayDecision;
  }

  if (input.control.queue.some((item) => item.id === input.workId)) {
    return deny(
      'RUN_CONTROL_REPLAY_CONFLICT',
      'A queued-work id cannot be reused by a different run-control signal.',
    );
  }

  const timestampCheck = validateTimestamp(input.control, input.queuedAt);
  if (!timestampCheck.allowed) {
    return timestampCheck;
  }

  const insertionIndex =
    priority === 'next'
      ? input.control.queue.findIndex((item) => item.priority === 'backlog')
      : input.control.queue.length;
  const resolvedInsertionIndex = insertionIndex === -1 ? input.control.queue.length : insertionIndex;
  const entry: QueuedAgentWork = Object.freeze({
    id: input.workId,
    laneId: input.control.laneId,
    agentId: input.control.agentId,
    position: resolvedInsertionIndex + 1,
    priority,
    title,
    desiredOutcome,
    expectedAgentMinutes: input.expectedAgentMinutes,
    status: 'queued',
    queuedBy: humanCheck.value.id,
    queuedAt: input.queuedAt,
  });
  const nextQueue = [...input.control.queue];
  nextQueue.splice(resolvedInsertionIndex, 0, entry);
  const positionedQueue = nextQueue.map((item, index) =>
    Object.freeze({ ...item, position: index + 1 }),
  );

  return allow(
    immutableState({
      ...input.control,
      queue: positionedQueue,
      signals: appendSignal(input.control, input.signalId, signal),
    }),
  );
}

export interface RequestAgentRunInterruptionInput {
  readonly control: HumanRunControlState;
  readonly actor: Principal;
  readonly signalId: RunControlSignalId;
  readonly requestedAt: ISODateTime;
  readonly reason?: string;
}

export function requestAgentRunInterruption(
  input: RequestAgentRunInterruptionInput,
): PolicyDecision<HumanRunControlState> {
  const humanCheck = requireAuthenticatedHuman(input.actor);
  if (!humanCheck.allowed) {
    return humanCheck;
  }

  const reason = input.reason?.trim() || 'Human requested an interruption.';
  const priorRunId = input.control.signals.find(
    (prior) => prior.id === input.signalId && prior.action === 'interrupt_requested',
  )?.runId;
  const targetRunId = priorRunId ?? input.control.activeRunId;
  if (targetRunId === undefined) {
    return deny('RUN_NOT_ACTIVE', 'The agent lane has no active run attempt.');
  }
  const signal: SignalWithoutId = {
    laneId: input.control.laneId,
    runId: targetRunId,
    action: 'interrupt_requested',
    issuedBy: humanCheck.value.id,
    issuerKind: 'human',
    issuedAt: input.requestedAt,
    note: reason,
  };
  const replayDecision = replay(input.control, input.signalId, signal);
  if (replayDecision !== undefined) {
    return replayDecision;
  }

  const activeRun = requireActiveRun(input.control, targetRunId);
  if (!activeRun.allowed) {
    return activeRun;
  }

  if (
    input.control.status !== 'running' &&
    input.control.status !== 'interrupt_refused' &&
    input.control.status !== 'interrupt_unknown'
  ) {
    return deny(
      'INVALID_RUN_CONTROL_TRANSITION',
      `An interruption cannot be requested while the lane is ${input.control.status}.`,
    );
  }

  const timestampCheck = validateTimestamp(input.control, input.requestedAt);
  if (!timestampCheck.allowed) {
    return timestampCheck;
  }

  return allow(
    immutableState({
      ...input.control,
      status: 'interrupt_requested',
      signals: appendSignal(input.control, input.signalId, signal),
      interruption: {
        runId: activeRun.value,
        requestSignalId: input.signalId,
        requestedBy: humanCheck.value.id,
        requestedAt: input.requestedAt,
        reason,
      },
    }),
  );
}

/**
 * Compatibility entry point. This records a human request; it never claims the
 * provider stopped before the orchestration worker reports that outcome.
 */
export interface InterruptAgentRunInput {
  readonly control: HumanRunControlState;
  readonly actor: Principal;
  readonly signalId: RunControlSignalId;
  readonly interruptedAt: ISODateTime;
  readonly reason?: string;
}

export function interruptAgentRun(
  input: InterruptAgentRunInput,
): PolicyDecision<HumanRunControlState> {
  return requestAgentRunInterruption({
    control: input.control,
    actor: input.actor,
    signalId: input.signalId,
    requestedAt: input.interruptedAt,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}

export interface AcknowledgeAgentRunInterruptionInput {
  readonly control: HumanRunControlState;
  readonly actor: Principal;
  readonly runId: AgentRunId;
  readonly signalId: RunControlSignalId;
  readonly acknowledgedAt: ISODateTime;
  readonly note?: string;
}

export function acknowledgeAgentRunInterruption(
  input: AcknowledgeAgentRunInterruptionInput,
): PolicyDecision<HumanRunControlState> {
  const workerCheck = requireOrchestrationWorker(input.actor);
  if (!workerCheck.allowed) {
    return workerCheck;
  }

  const note = input.note?.trim() || 'The provider acknowledged the interruption request.';
  const signal: SignalWithoutId = {
    laneId: input.control.laneId,
    runId: input.runId,
    action: 'interrupt_acknowledged',
    issuedBy: workerCheck.value,
    issuerKind: 'service',
    issuedAt: input.acknowledgedAt,
    note,
  };
  const replayDecision = replay(input.control, input.signalId, signal);
  if (replayDecision !== undefined) {
    return replayDecision;
  }

  const activeRun = requireActiveRun(input.control, input.runId);
  if (!activeRun.allowed) {
    return activeRun;
  }

  if (
    input.control.status !== 'interrupt_requested' ||
    input.control.interruption?.runId !== activeRun.value
  ) {
    return deny(
      'INVALID_RUN_CONTROL_TRANSITION',
      'A provider acknowledgement requires a pending interruption request for the active run.',
    );
  }

  const timestampCheck = validateTimestamp(input.control, input.acknowledgedAt);
  if (!timestampCheck.allowed) {
    return timestampCheck;
  }

  return allow(
    immutableState({
      ...input.control,
      status: 'interrupt_acknowledged',
      signals: appendSignal(input.control, input.signalId, signal),
      interruption: {
        ...input.control.interruption,
        acknowledgementSignalId: input.signalId,
        acknowledgedAt: input.acknowledgedAt,
      },
    }),
  );
}

export interface SettleAgentRunInterruptionInput {
  readonly control: HumanRunControlState;
  readonly actor: Principal;
  readonly runId: AgentRunId;
  readonly signalId: RunControlSignalId;
  readonly outcome: InterruptionOutcome;
  readonly settledAt: ISODateTime;
  readonly detail?: string;
}

const DEFAULT_OUTCOME_DETAIL: Readonly<Record<InterruptionOutcome, string>> = {
  interrupted: 'The provider confirmed that the active run stopped.',
  refused: 'The provider refused the interruption and the active run may continue.',
  unknown: 'The provider could not confirm whether the active run stopped.',
};

export function settleAgentRunInterruption(
  input: SettleAgentRunInterruptionInput,
): PolicyDecision<HumanRunControlState> {
  const workerCheck = requireOrchestrationWorker(input.actor);
  if (!workerCheck.allowed) {
    return workerCheck;
  }

  const detail = input.detail?.trim() || DEFAULT_OUTCOME_DETAIL[input.outcome];
  const signal: SignalWithoutId = {
    laneId: input.control.laneId,
    runId: input.runId,
    action: 'interrupt_settled',
    issuedBy: workerCheck.value,
    issuerKind: 'service',
    issuedAt: input.settledAt,
    note: detail,
    interruptionOutcome: input.outcome,
  };
  const replayDecision = replay(input.control, input.signalId, signal);
  if (replayDecision !== undefined) {
    return replayDecision;
  }

  const activeRun = requireActiveRun(input.control, input.runId);
  if (!activeRun.allowed) {
    return activeRun;
  }

  const acknowledgedSettlement =
    input.control.status === 'interrupt_acknowledged' &&
    input.control.interruption?.runId === activeRun.value &&
    input.control.interruption.acknowledgedAt !== undefined;
  const unacknowledgedTimeout =
    input.outcome === 'unknown' &&
    input.control.status === 'interrupt_requested' &&
    input.control.interruption?.runId === activeRun.value;
  if (!acknowledgedSettlement && !unacknowledgedTimeout) {
    return deny(
      'INVALID_RUN_CONTROL_TRANSITION',
      'An interruption outcome requires an acknowledged request, except that an unacknowledged timeout may settle as unknown.',
    );
  }

  const timestampCheck = validateTimestamp(input.control, input.settledAt);
  if (!timestampCheck.allowed) {
    return timestampCheck;
  }

  const status: HumanRunControlStatus =
    input.outcome === 'interrupted'
      ? 'interrupted'
      : input.outcome === 'refused'
        ? 'interrupt_refused'
        : 'interrupt_unknown';

  return allow(
    immutableState({
      ...input.control,
      status,
      signals: appendSignal(input.control, input.signalId, signal),
      interruption: {
        ...input.control.interruption,
        settlementSignalId: input.signalId,
        settledAt: input.settledAt,
        outcome: input.outcome,
        outcomeDetail: detail,
      },
    }),
  );
}

export interface ReconcileAgentRunStillRunningInput {
  readonly control: HumanRunControlState;
  readonly actor: Principal;
  readonly runId: AgentRunId;
  readonly signalId: RunControlSignalId;
  readonly reconciledAt: ISODateTime;
  readonly providerEvidence: string;
  readonly note?: string;
}

/**
 * A refusal or unknown result is not permission to schedule more work. The
 * worker must prove that the same provider process is alive before the lane can
 * return to running. A provider-confirmed interruption can only be resumed by
 * a human and is deliberately excluded from this transition.
 */
export function reconcileAgentRunStillRunning(
  input: ReconcileAgentRunStillRunningInput,
): PolicyDecision<HumanRunControlState> {
  const workerCheck = requireOrchestrationWorker(input.actor);
  if (!workerCheck.allowed) {
    return workerCheck;
  }

  const providerEvidence = input.providerEvidence.trim();
  if (providerEvidence.length === 0) {
    return deny(
      'RUN_RECONCILIATION_EVIDENCE_REQUIRED',
      'Returning a run to running requires provider evidence that the same process is alive.',
    );
  }

  const note =
    input.note?.trim() || 'The worker proved that the same provider process is still running.';
  const signal: SignalWithoutId = {
    laneId: input.control.laneId,
    runId: input.runId,
    action: 'run_reconciled_running',
    issuedBy: workerCheck.value,
    issuerKind: 'service',
    issuedAt: input.reconciledAt,
    note,
    providerEvidence,
  };
  const replayDecision = replay(input.control, input.signalId, signal);
  if (replayDecision !== undefined) {
    return replayDecision;
  }

  const activeRun = requireActiveRun(input.control, input.runId);
  if (!activeRun.allowed) {
    return activeRun;
  }

  const reconcilableOutcome =
    input.control.status === 'interrupt_refused'
      ? 'refused'
      : input.control.status === 'interrupt_unknown'
        ? 'unknown'
        : undefined;
  if (
    reconcilableOutcome === undefined ||
    input.control.interruption?.runId !== activeRun.value ||
    input.control.interruption.outcome !== reconcilableOutcome
  ) {
    return deny(
      'INVALID_RUN_CONTROL_TRANSITION',
      'Only a refused or unknown interruption for the active run can be reconciled as still running.',
    );
  }

  const timestampCheck = validateTimestamp(input.control, input.reconciledAt);
  if (!timestampCheck.allowed) {
    return timestampCheck;
  }

  return allow(
    immutableState({
      ...input.control,
      status: 'running',
      signals: appendSignal(input.control, input.signalId, signal),
      interruption: {
        ...input.control.interruption,
        reconciliationSignalId: input.signalId,
        reconciledAt: input.reconciledAt,
        reconciliationEvidence: providerEvidence,
      },
    }),
  );
}

export interface ResumeAgentRunInput {
  readonly control: HumanRunControlState;
  readonly actor: Principal;
  readonly signalId: RunControlSignalId;
  readonly resumedAt: ISODateTime;
  readonly note?: string;
}

export function resumeAgentRun(
  input: ResumeAgentRunInput,
): PolicyDecision<HumanRunControlState> {
  const humanCheck = requireAuthenticatedHuman(input.actor);
  if (!humanCheck.allowed) {
    return humanCheck;
  }

  const note = input.note?.trim() || 'Human resumed the agent at its saved checkpoint.';
  const priorRunId = input.control.signals.find(
    (prior) => prior.id === input.signalId && prior.action === 'resumed',
  )?.runId;
  const targetRunId = priorRunId ?? input.control.activeRunId;
  if (targetRunId === undefined) {
    return deny('RUN_NOT_ACTIVE', 'The agent lane has no active run attempt.');
  }
  const signal: SignalWithoutId = {
    laneId: input.control.laneId,
    runId: targetRunId,
    action: 'resumed',
    issuedBy: humanCheck.value.id,
    issuerKind: 'human',
    issuedAt: input.resumedAt,
    note,
  };
  const replayDecision = replay(input.control, input.signalId, signal);
  if (replayDecision !== undefined) {
    return replayDecision;
  }

  const activeRun = requireActiveRun(input.control, targetRunId);
  if (!activeRun.allowed) {
    return activeRun;
  }

  if (
    input.control.status !== 'interrupted' ||
    input.control.interruption?.outcome !== 'interrupted'
  ) {
    return deny(
      'RUN_NOT_INTERRUPTED',
      'Only a provider-confirmed interrupted run can be resumed by a human.',
    );
  }

  const timestampCheck = validateTimestamp(input.control, input.resumedAt);
  if (!timestampCheck.allowed) {
    return timestampCheck;
  }

  return allow(
    immutableState({
      ...input.control,
      status: 'running',
      signals: appendSignal(input.control, input.signalId, signal),
      interruption: {
        ...input.control.interruption,
        resumeSignalId: input.signalId,
        resumedAt: input.resumedAt,
        resumedBy: humanCheck.value.id,
      },
    }),
  );
}

export interface StartAgentRunAttemptInput {
  readonly control: HumanRunControlState;
  readonly actor: Principal;
  readonly runId: AgentRunId;
  readonly signalId: RunControlSignalId;
  readonly startedAt: ISODateTime;
  readonly note?: string;
}

export function startAgentRunAttempt(
  input: StartAgentRunAttemptInput,
): PolicyDecision<HumanRunControlState> {
  const workerCheck = requireOrchestrationWorker(input.actor);
  if (!workerCheck.allowed) {
    return workerCheck;
  }

  const note = input.note?.trim() || 'The orchestration worker started a new run attempt.';
  const signal: SignalWithoutId = {
    laneId: input.control.laneId,
    runId: input.runId,
    action: 'run_started',
    issuedBy: workerCheck.value,
    issuerKind: 'service',
    issuedAt: input.startedAt,
    note,
  };
  const replayDecision = replay(input.control, input.signalId, signal);
  if (replayDecision !== undefined) {
    return replayDecision;
  }

  if (input.control.status !== 'idle' || input.control.activeRunId !== undefined) {
    return deny(
      'INVALID_RUN_CONTROL_TRANSITION',
      'A run attempt can start only while its agent lane is idle.',
    );
  }
  if (runAttemptWasSeen(input.control, input.runId)) {
    return deny(
      'RUN_ATTEMPT_REUSED',
      'Run-attempt ids are immutable and may never be reused after completion or replacement.',
    );
  }

  const timestampCheck = validateTimestamp(input.control, input.startedAt);
  if (!timestampCheck.allowed) {
    return timestampCheck;
  }

  return allow(
    immutableState({
      ...input.control,
      activeRunId: input.runId,
      activeRunStartedAt: input.startedAt,
      status: 'running',
      signals: appendSignal(input.control, input.signalId, signal),
      interruption: undefined,
    }),
  );
}

export interface ReplaceAgentRunAttemptInput {
  readonly control: HumanRunControlState;
  readonly actor: Principal;
  readonly previousRunId: AgentRunId;
  readonly nextRunId: AgentRunId;
  readonly signalId: RunControlSignalId;
  readonly replacedAt: ISODateTime;
  readonly note?: string;
}

export function replaceAgentRunAttempt(
  input: ReplaceAgentRunAttemptInput,
): PolicyDecision<HumanRunControlState> {
  const workerCheck = requireOrchestrationWorker(input.actor);
  if (!workerCheck.allowed) {
    return workerCheck;
  }

  const note = input.note?.trim() || 'The orchestration worker replaced the run attempt.';
  const signal: SignalWithoutId = {
    laneId: input.control.laneId,
    runId: input.nextRunId,
    action: 'run_replaced',
    issuedBy: workerCheck.value,
    issuerKind: 'service',
    issuedAt: input.replacedAt,
    note,
    replacedRunId: input.previousRunId,
  };
  const replayDecision = replay(input.control, input.signalId, signal);
  if (replayDecision !== undefined) {
    return replayDecision;
  }

  const activeRun = requireActiveRun(input.control, input.previousRunId);
  if (!activeRun.allowed) {
    return activeRun;
  }

  if (input.control.status !== 'running') {
    return deny(
      'INVALID_RUN_CONTROL_TRANSITION',
      'A run can be replaced only while the lane is running; a human hold must be resolved first.',
    );
  }
  if (input.previousRunId === input.nextRunId) {
    return deny(
      'INVALID_RUN_CONTROL_TRANSITION',
      'A replacement run attempt must have a new run id.',
    );
  }
  if (runAttemptWasSeen(input.control, input.nextRunId)) {
    return deny(
      'RUN_ATTEMPT_REUSED',
      'A replacement must use a globally new run-attempt id for this agent lane.',
    );
  }

  const timestampCheck = validateTimestamp(input.control, input.replacedAt);
  if (!timestampCheck.allowed) {
    return timestampCheck;
  }

  return allow(
    immutableState({
      ...input.control,
      activeRunId: input.nextRunId,
      activeRunStartedAt: input.replacedAt,
      status: 'running',
      signals: appendSignal(input.control, input.signalId, signal),
      interruption: undefined,
    }),
  );
}

export interface CompleteAgentRunAttemptInput {
  readonly control: HumanRunControlState;
  readonly actor: Principal;
  readonly runId: AgentRunId;
  readonly signalId: RunControlSignalId;
  readonly completedAt: ISODateTime;
  readonly providerEvidence: string;
  readonly note?: string;
}

interface RunCompletionContext {
  readonly priorControlStatus: HumanRunControlStatus;
  readonly relationToInterruption: RunCompletionRelation;
}

function runCompletionContext(
  control: HumanRunControlState,
): RunCompletionContext | undefined {
  switch (control.status) {
    case 'running':
      return {
        priorControlStatus: control.status,
        relationToInterruption:
          control.interruption === undefined
            ? 'without_interruption'
            : 'after_cancellation_attempt',
      };
    case 'interrupt_requested':
    case 'interrupt_acknowledged':
      return {
        priorControlStatus: control.status,
        relationToInterruption: 'before_cancellation',
      };
    case 'interrupt_refused':
    case 'interrupt_unknown':
      return {
        priorControlStatus: control.status,
        relationToInterruption: 'after_cancellation_attempt',
      };
    case 'idle':
    case 'interrupted':
      return undefined;
  }
}

export function completeAgentRunAttempt(
  input: CompleteAgentRunAttemptInput,
): PolicyDecision<HumanRunControlState> {
  const workerCheck = requireOrchestrationWorker(input.actor);
  if (!workerCheck.allowed) {
    return workerCheck;
  }

  const providerEvidence = input.providerEvidence.trim();
  if (providerEvidence.length === 0) {
    return deny(
      'RUN_COMPLETION_EVIDENCE_REQUIRED',
      'Completing a run requires authoritative provider evidence of natural termination.',
    );
  }

  const note = input.note?.trim() || 'The orchestration worker completed the run attempt.';
  const priorCompletionSignal = input.control.signals.find(
    (prior) => prior.id === input.signalId && prior.action === 'run_completed',
  );
  const completionContext =
    priorCompletionSignal?.completionFromStatus !== undefined &&
    priorCompletionSignal.completionRelation !== undefined
      ? {
          priorControlStatus: priorCompletionSignal.completionFromStatus,
          relationToInterruption: priorCompletionSignal.completionRelation,
        }
      : runCompletionContext(input.control);

  if (completionContext === undefined) {
    const reusedSignal = input.control.signals.some((prior) => prior.id === input.signalId);
    if (reusedSignal) {
      return deny(
        'RUN_CONTROL_REPLAY_CONFLICT',
        'A run-control signal id cannot be reused with different transition data.',
      );
    }
    return deny(
      'INVALID_RUN_CONTROL_TRANSITION',
      'Natural completion is valid only for a nonterminal active run; an interrupted run is already terminal.',
    );
  }

  const signal: SignalWithoutId = {
    laneId: input.control.laneId,
    runId: input.runId,
    action: 'run_completed',
    issuedBy: workerCheck.value,
    issuerKind: 'service',
    issuedAt: input.completedAt,
    note,
    completionRelation: completionContext.relationToInterruption,
    completionFromStatus: completionContext.priorControlStatus,
    providerEvidence,
  };
  const replayDecision = replay(input.control, input.signalId, signal);
  if (replayDecision !== undefined) {
    return replayDecision;
  }

  const activeRun = requireActiveRun(input.control, input.runId);
  if (!activeRun.allowed) {
    return activeRun;
  }

  const timestampCheck = validateTimestamp(input.control, input.completedAt);
  if (!timestampCheck.allowed) {
    return timestampCheck;
  }

  const { activeRunId: _activeRunId, activeRunStartedAt: _startedAt, ...lane } = input.control;
  void _activeRunId;
  void _startedAt;

  return allow(
    immutableState({
      ...lane,
      status: 'idle',
      signals: appendSignal(input.control, input.signalId, signal),
      interruption: undefined,
      lastCompletion: {
        runId: activeRun.value,
        signalId: input.signalId,
        completedAt: input.completedAt,
        relationToInterruption: completionContext.relationToInterruption,
        priorControlStatus: completionContext.priorControlStatus,
        note,
        providerEvidence,
      },
    }),
  );
}

export function canAgentRun(
  control: HumanRunControlState,
  actor: Principal,
): PolicyDecision<true> {
  if (actor.kind !== 'agent' || actor.id !== control.agentId) {
    return deny('ROLE_MISMATCH', 'Only the agent assigned to this lane may execute it.');
  }

  if (control.activeRunId === undefined || control.status === 'idle') {
    return deny('RUN_NOT_ACTIVE', 'The agent lane has no active run attempt.');
  }

  if (control.status !== 'running') {
    return deny(
      'RUN_INTERRUPTED',
      `The run cannot accept more execution while its control status is ${control.status}.`,
    );
  }

  return allow(true);
}
