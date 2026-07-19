import type {
  Brand,
  Capability,
  ISODateTime,
  ModelProvider,
  PolicyDecision,
  PolicyFailureCode,
  Principal,
  ServiceActor,
  WorkItemId,
} from './types';
import type { AgentLaneId } from './human-run-control';

export const IMPACT_OBSERVER: ServiceActor = Object.freeze({
  kind: 'service',
  id: 'impact-observer',
  name: 'Impact observer',
});

export const IMPACT_OBSERVER_CONTRACT = Object.freeze({
  purpose: 'Maintain an event-driven explanation of task outcome and user impact in plain language.',
  authority: 'presentation_only' as const,
  capabilities: Object.freeze([]) as readonly Capability[],
  canMutateWorkflow: false as const,
  productionAuthority: false as const,
  modelTier: 'economy' as const,
  maxOutputTokens: 160,
  maxProgressEntries: 8,
  maxProgressSummaryCharacters: 280,
  maxTaskContextCharacters: 500,
  audience: 'nontechnical' as const,
  omit: Object.freeze([
    'implementation mechanics',
    'file paths',
    'commands',
    'model deliberation',
  ]),
});

export interface ImpactProgressSummary {
  readonly sequence: number;
  readonly summary: string;
  readonly recordedAt: ISODateTime;
}

export interface ImpactObserverInput {
  readonly taskTitle: string;
  readonly desiredOutcome: string;
  readonly progress: readonly ImpactProgressSummary[];
}

export interface BoundedImpactObserverInput {
  readonly taskTitle: string;
  readonly desiredOutcome: string;
  readonly progress: readonly ImpactProgressSummary[];
  readonly omittedProgressCount: number;
}

export type ImpactSummaryStatus =
  | 'queued'
  | 'in_progress'
  | 'blocked'
  | 'ready_for_review'
  | 'complete';

export interface ImpactSummary {
  readonly outcome: string;
  readonly userImpact: string;
  readonly status: ImpactSummaryStatus;
  readonly nextMilestone: string;
}

function allow<Value>(value: Value): PolicyDecision<Value> {
  return { allowed: true, value };
}

function deny<Value>(code: PolicyFailureCode, reason: string): PolicyDecision<Value> {
  return { allowed: false, code, reason };
}

function truncate(value: string, maximumCharacters: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maximumCharacters) {
    return trimmed;
  }

  return `${trimmed.slice(0, maximumCharacters - 1).trimEnd()}…`;
}

/**
 * Produces a read-only, bounded view for the economy observer. The observer sees
 * only the newest progress summaries; it never receives tools or workflow state
 * that it could mutate.
 */
export function boundImpactObserverInput(
  input: ImpactObserverInput,
): PolicyDecision<BoundedImpactObserverInput> {
  const taskTitle = truncate(
    input.taskTitle,
    IMPACT_OBSERVER_CONTRACT.maxTaskContextCharacters,
  );
  const desiredOutcome = truncate(
    input.desiredOutcome,
    IMPACT_OBSERVER_CONTRACT.maxTaskContextCharacters,
  );

  if (taskTitle.length === 0 || desiredOutcome.length === 0) {
    return deny(
      'IMPACT_TASK_CONTEXT_REQUIRED',
      'Impact summaries require both a task title and a result-oriented desired outcome.',
    );
  }

  const meaningfulProgress = input.progress
    .filter((entry) => entry.summary.trim().length > 0)
    .slice(-IMPACT_OBSERVER_CONTRACT.maxProgressEntries)
    .map((entry) =>
      Object.freeze({
        sequence: entry.sequence,
        summary: truncate(
          entry.summary,
          IMPACT_OBSERVER_CONTRACT.maxProgressSummaryCharacters,
        ),
        recordedAt: entry.recordedAt,
      }),
    );

  return allow(
    Object.freeze({
      taskTitle,
      desiredOutcome,
      progress: Object.freeze(meaningfulProgress),
      omittedProgressCount: Math.max(0, input.progress.length - meaningfulProgress.length),
    }),
  );
}

const IMPACT_STATUSES: ReadonlySet<string> = new Set<ImpactSummaryStatus>([
  'queued',
  'in_progress',
  'blocked',
  'ready_for_review',
  'complete',
]);

/** Accepts model output only after every result-oriented field is populated. */
export function validateImpactSummary(output: unknown): PolicyDecision<ImpactSummary> {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return deny(
      'IMPACT_SUMMARY_INVALID',
      'The impact observer must return a structured summary object.',
    );
  }

  const candidate = output as Record<string, unknown>;
  const outcome = typeof candidate.outcome === 'string' ? candidate.outcome.trim() : '';
  const userImpact =
    typeof candidate.userImpact === 'string' ? candidate.userImpact.trim() : '';
  const nextMilestone =
    typeof candidate.nextMilestone === 'string' ? candidate.nextMilestone.trim() : '';
  const status = typeof candidate.status === 'string' ? candidate.status : '';

  if (
    outcome.length === 0 ||
    userImpact.length === 0 ||
    nextMilestone.length === 0 ||
    !IMPACT_STATUSES.has(status)
  ) {
    return deny(
      'IMPACT_SUMMARY_INVALID',
      'Impact summaries require non-empty outcome, user impact, status, and next milestone fields.',
    );
  }

  return allow(
    Object.freeze({
      outcome,
      userImpact,
      status: status as ImpactSummaryStatus,
      nextMilestone,
    }),
  );
}

export type ImpactSummarySlotId = Brand<string, 'ImpactSummarySlotId'>;
export type ImpactGenerationRequestId = Brand<string, 'ImpactGenerationRequestId'>;
export type ImpactObserverRunId = Brand<string, 'ImpactObserverRunId'>;

export const impactSummarySlotId = (value: string): ImpactSummarySlotId =>
  value as ImpactSummarySlotId;
export const impactGenerationRequestId = (value: string): ImpactGenerationRequestId =>
  value as ImpactGenerationRequestId;
export const impactObserverRunId = (value: string): ImpactObserverRunId =>
  value as ImpactObserverRunId;

export type ImpactObserverDecision<Value> = PolicyDecision<Value>;

export type ImpactSourceEventKind =
  | 'progress_recorded'
  | 'status_changed'
  | 'test_recorded'
  | 'review_recorded'
  | 'human_control_changed';

export interface ImpactSourceEvent {
  readonly sequence: number;
  readonly kind: ImpactSourceEventKind;
  readonly occurredAt: ISODateTime;
}

export interface ImpactModelProvenance {
  readonly provider: ModelProvider;
  readonly modelId: string;
  readonly modelTier: 'economy';
  readonly promptVersion: string;
}

export interface ImpactObserverRunAuthorization {
  readonly runId: ImpactObserverRunId;
  readonly requestId: ImpactGenerationRequestId;
  readonly slotId: ImpactSummarySlotId;
  readonly sourceEventSequence: number;
  readonly baseRevision: number;
  readonly authorizedActorId: 'impact-observer';
  readonly authorizedAt: ISODateTime;
  readonly model: ImpactModelProvenance;
  readonly authority: 'presentation_only';
  readonly capabilities: readonly [];
  readonly toolsAllowed: false;
  readonly canMutateWorkflow: false;
}

interface ImpactGenerationRequestBase {
  readonly id: ImpactGenerationRequestId;
  readonly slotId: ImpactSummarySlotId;
  readonly baseRevision: number;
  readonly firstSourceEventSequence: number;
  readonly sourceEventSequence: number;
  readonly sourceEventAt: ISODateTime;
  readonly requestedAt: ISODateTime;
  readonly coalescedEventCount: number;
}

export interface QueuedImpactGenerationRequest extends ImpactGenerationRequestBase {
  readonly state: 'queued';
}

export interface RunningImpactGenerationRequest extends ImpactGenerationRequestBase {
  readonly state: 'running';
  readonly authorization: ImpactObserverRunAuthorization;
}

export type ImpactGenerationRequest =
  | QueuedImpactGenerationRequest
  | RunningImpactGenerationRequest;

/** A single bounded follow-up retained while a run is already in flight. */
export interface CoalescedImpactRefresh {
  readonly requestId: ImpactGenerationRequestId;
  readonly firstSourceEventSequence: number;
  readonly sourceEventSequence: number;
  readonly sourceEventAt: ISODateTime;
  readonly requestedAt: ISODateTime;
  readonly coalescedEventCount: number;
}

export interface ImpactSummaryRevision {
  readonly revision: number;
  readonly summary: ImpactSummary;
  readonly sourceEventSequence: number;
  readonly sourceEventAt: ISODateTime;
  readonly generationRequestId: ImpactGenerationRequestId;
  readonly observerRunId: ImpactObserverRunId;
  readonly model: ImpactModelProvenance;
  readonly generatedAt: ISODateTime;
}

export type ImpactSummaryFreshness = 'empty' | 'fresh' | 'stale' | 'error';

export interface ImpactGenerationError {
  readonly requestId: ImpactGenerationRequestId;
  readonly runId: ImpactObserverRunId;
  readonly sourceEventSequence: number;
  readonly baseRevision: number;
  readonly model: ImpactModelProvenance;
  readonly message: string;
  readonly failedAt: ISODateTime;
}

export interface ImpactGenerationAttempt {
  readonly requestId: ImpactGenerationRequestId;
  readonly runId: ImpactObserverRunId;
  readonly sourceEventSequence: number;
  readonly baseRevision: number;
  readonly outcome: 'published' | 'failed';
  readonly completedAt: ISODateTime;
}

/**
 * One durable presentation slot per stable agent lane. The work-item link
 * supplies outcome context while lane scope keeps manager, engineer, and
 * verifier perspectives explicit. A provider run may be replaced without
 * replacing the slot. A failure never replaces `currentRevision`.
 */
export interface ImpactSummarySlot {
  readonly id: ImpactSummarySlotId;
  readonly agentLaneId: AgentLaneId;
  readonly workItemId: WorkItemId;
  readonly revisions: readonly ImpactSummaryRevision[];
  readonly attempts: readonly ImpactGenerationAttempt[];
  readonly currentRevision?: ImpactSummaryRevision;
  readonly activeRequest?: ImpactGenerationRequest;
  readonly coalescedFollowUp?: CoalescedImpactRefresh;
  readonly latestSourceEventSequence: number;
  readonly latestSourceEventAt?: ISODateTime;
  readonly freshness: ImpactSummaryFreshness;
  readonly lastGenerationError?: ImpactGenerationError;
}

function impactAllow<Value>(value: Value): ImpactObserverDecision<Value> {
  return { allowed: true, value };
}

function impactDeny<Value>(
  code: PolicyFailureCode,
  reason: string,
): ImpactObserverDecision<Value> {
  return { allowed: false, code, reason };
}

function immutableModel(model: ImpactModelProvenance): ImpactModelProvenance {
  return Object.freeze({ ...model });
}

function immutableAuthorization(
  authorization: ImpactObserverRunAuthorization,
): ImpactObserverRunAuthorization {
  return Object.freeze({
    ...authorization,
    model: immutableModel(authorization.model),
    capabilities: Object.freeze([]) as readonly [],
  });
}

function immutableRequest(request: ImpactGenerationRequest): ImpactGenerationRequest {
  if (request.state === 'queued') {
    return Object.freeze({ ...request });
  }

  return Object.freeze({
    ...request,
    authorization: immutableAuthorization(request.authorization),
  });
}

function immutableRevision(revision: ImpactSummaryRevision): ImpactSummaryRevision {
  return Object.freeze({
    ...revision,
    summary: Object.freeze({ ...revision.summary }),
    model: immutableModel(revision.model),
  });
}

function immutableError(error: ImpactGenerationError): ImpactGenerationError {
  return Object.freeze({ ...error, model: immutableModel(error.model) });
}

function immutableAttempt(attempt: ImpactGenerationAttempt): ImpactGenerationAttempt {
  return Object.freeze({ ...attempt });
}

function immutableSlot(slot: ImpactSummarySlot): ImpactSummarySlot {
  const revisions = Object.freeze(slot.revisions.map(immutableRevision));
  const attempts = Object.freeze(slot.attempts.map(immutableAttempt));
  const currentRevision =
    slot.currentRevision === undefined
      ? undefined
      : revisions.find((revision) => revision.revision === slot.currentRevision?.revision) ??
        immutableRevision(slot.currentRevision);

  return Object.freeze({
    ...slot,
    revisions,
    attempts,
    ...(currentRevision === undefined ? {} : { currentRevision }),
    ...(slot.activeRequest === undefined
      ? {}
      : { activeRequest: immutableRequest(slot.activeRequest) }),
    ...(slot.coalescedFollowUp === undefined
      ? {}
      : { coalescedFollowUp: Object.freeze({ ...slot.coalescedFollowUp }) }),
    ...(slot.lastGenerationError === undefined
      ? {}
      : { lastGenerationError: immutableError(slot.lastGenerationError) }),
  });
}

function currentRevisionNumber(slot: ImpactSummarySlot): number {
  return slot.currentRevision?.revision ?? 0;
}

function validTimestamp(value: ISODateTime): boolean {
  return String(value).trim().length > 0 && !Number.isNaN(Date.parse(value));
}

const IMPACT_SOURCE_EVENT_KINDS: ReadonlySet<string> = new Set<ImpactSourceEventKind>([
  'progress_recorded',
  'status_changed',
  'test_recorded',
  'review_recorded',
  'human_control_changed',
]);

function requireImpactObserver(actor: Principal): ImpactObserverDecision<true> {
  if (actor.kind !== 'service' || actor.id !== IMPACT_OBSERVER.id) {
    return impactDeny(
      'IMPACT_OBSERVER_REQUIRED',
      'Only the presentation-only impact observer may write an impact-summary generation.',
    );
  }

  return impactAllow(true);
}

function queuedRequest(
  slotId: ImpactSummarySlotId,
  baseRevision: number,
  trigger: CoalescedImpactRefresh,
): QueuedImpactGenerationRequest {
  return Object.freeze({
    id: trigger.requestId,
    slotId,
    baseRevision,
    firstSourceEventSequence: trigger.firstSourceEventSequence,
    sourceEventSequence: trigger.sourceEventSequence,
    sourceEventAt: trigger.sourceEventAt,
    requestedAt: trigger.requestedAt,
    coalescedEventCount: trigger.coalescedEventCount,
    state: 'queued',
  });
}

export interface CreateImpactSummarySlotInput {
  readonly id: ImpactSummarySlotId;
  readonly agentLaneId: AgentLaneId;
  readonly workItemId: WorkItemId;
}

export function createImpactSummarySlot(
  input: CreateImpactSummarySlotInput,
): ImpactSummarySlot {
  return immutableSlot({
    id: input.id,
    agentLaneId: input.agentLaneId,
    workItemId: input.workItemId,
    revisions: [],
    attempts: [],
    latestSourceEventSequence: 0,
    freshness: 'empty',
  });
}

export interface RequestImpactSummaryGenerationInput {
  readonly slot: ImpactSummarySlot;
  readonly requestId: ImpactGenerationRequestId;
  readonly event: ImpactSourceEvent;
  readonly requestedAt: ISODateTime;
}

/**
 * Turns ordered, meaningful domain events into one bounded generation request.
 * Duplicate/older deliveries are no-ops. New events coalesce into a queued
 * request, or into one follow-up while a run is already using its snapshot.
 */
export function requestImpactSummaryGeneration(
  input: RequestImpactSummaryGenerationInput,
): ImpactObserverDecision<ImpactSummarySlot> {
  if (
    !Number.isSafeInteger(input.event.sequence) ||
    input.event.sequence <= 0 ||
    !IMPACT_SOURCE_EVENT_KINDS.has(input.event.kind) ||
    !validTimestamp(input.event.occurredAt) ||
    !validTimestamp(input.requestedAt) ||
    Date.parse(input.requestedAt) < Date.parse(input.event.occurredAt)
  ) {
    return impactDeny(
      'IMPACT_SOURCE_EVENT_INVALID',
      'Impact refreshes require a supported, positively sequenced source event and valid observation time.',
    );
  }

  const retriesFailedEvent =
    input.event.sequence === input.slot.latestSourceEventSequence &&
    input.slot.freshness === 'error' &&
    input.slot.activeRequest === undefined;

  if (input.event.sequence <= input.slot.latestSourceEventSequence && !retriesFailedEvent) {
    return impactAllow(input.slot);
  }

  const requestIdWasSeen =
    input.slot.activeRequest?.id === input.requestId ||
    input.slot.coalescedFollowUp?.requestId === input.requestId ||
    input.slot.attempts.some((attempt) => attempt.requestId === input.requestId);
  if (requestIdWasSeen) {
    return impactDeny(
      'IMPACT_GENERATION_ID_REUSED',
      'Impact generation request ids are immutable and may not be reused for a new source event.',
    );
  }

  const trigger: CoalescedImpactRefresh = Object.freeze({
    requestId: input.requestId,
    firstSourceEventSequence: input.event.sequence,
    sourceEventSequence: input.event.sequence,
    sourceEventAt: input.event.occurredAt,
    requestedAt: input.requestedAt,
    coalescedEventCount: 0,
  });

  let activeRequest = input.slot.activeRequest;
  let coalescedFollowUp = input.slot.coalescedFollowUp;

  if (activeRequest === undefined) {
    activeRequest = queuedRequest(input.slot.id, currentRevisionNumber(input.slot), trigger);
  } else if (activeRequest.state === 'queued') {
    activeRequest = Object.freeze({
      ...activeRequest,
      sourceEventSequence: input.event.sequence,
      sourceEventAt: input.event.occurredAt,
      coalescedEventCount: activeRequest.coalescedEventCount + 1,
    });
  } else if (coalescedFollowUp === undefined) {
    coalescedFollowUp = trigger;
  } else {
    coalescedFollowUp = Object.freeze({
      ...coalescedFollowUp,
      sourceEventSequence: input.event.sequence,
      sourceEventAt: input.event.occurredAt,
      coalescedEventCount: coalescedFollowUp.coalescedEventCount + 1,
    });
  }

  const hasCurrentRevision = input.slot.currentRevision !== undefined;
  const freshness =
    input.slot.freshness === 'error'
      ? 'error'
      : hasCurrentRevision
        ? 'stale'
        : 'empty';

  return impactAllow(
    immutableSlot({
      ...input.slot,
      activeRequest,
      ...(coalescedFollowUp === undefined ? {} : { coalescedFollowUp }),
      latestSourceEventSequence: input.event.sequence,
      latestSourceEventAt: input.event.occurredAt,
      freshness,
    }),
  );
}

export interface AuthorizeImpactSummaryGenerationInput {
  readonly slot: ImpactSummarySlot;
  readonly actor: Principal;
  readonly requestId: ImpactGenerationRequestId;
  readonly runId: ImpactObserverRunId;
  readonly baseRevision: number;
  readonly model: ImpactModelProvenance;
  readonly authorizedAt: ISODateTime;
}

function validModelProvenance(model: ImpactModelProvenance): boolean {
  return (
    (model.provider === 'openai' || model.provider === 'anthropic') &&
    model.modelTier === IMPACT_OBSERVER_CONTRACT.modelTier &&
    model.modelId.trim().length > 0 &&
    model.promptVersion.trim().length > 0
  );
}

/** Binds one queued request to exactly one economy-model observer run. */
export function authorizeImpactSummaryGeneration(
  input: AuthorizeImpactSummaryGenerationInput,
): ImpactObserverDecision<ImpactSummarySlot> {
  const observerCheck = requireImpactObserver(input.actor);
  if (!observerCheck.allowed) {
    return observerCheck;
  }

  const request = input.slot.activeRequest;
  if (request === undefined) {
    return impactDeny(
      'IMPACT_GENERATION_REQUEST_REQUIRED',
      'An event-triggered impact generation request must exist before a run is authorized.',
    );
  }

  if (request.id !== input.requestId) {
    return impactDeny(
      'IMPACT_GENERATION_LINK_MISMATCH',
      'The run authorization does not match the active generation request.',
    );
  }

  if (request.state === 'running') {
    if (
      request.authorization.runId === input.runId &&
      request.baseRevision === input.baseRevision
    ) {
      return impactAllow(input.slot);
    }

    return impactDeny(
      'IMPACT_GENERATION_LINK_MISMATCH',
      'The active generation request is already bound to a different observer run.',
    );
  }

  if (input.slot.attempts.some((attempt) => attempt.runId === input.runId)) {
    return impactDeny(
      'IMPACT_GENERATION_ID_REUSED',
      'Impact observer run ids are immutable and may not be reused after publication or failure.',
    );
  }

  if (
    input.baseRevision !== request.baseRevision ||
    input.baseRevision !== currentRevisionNumber(input.slot)
  ) {
    return impactDeny(
      'IMPACT_BASE_REVISION_CONFLICT',
      'The generation request was based on a different visible summary revision.',
    );
  }

  if (!validModelProvenance(input.model)) {
    return impactDeny(
      'IMPACT_MODEL_PROVENANCE_INVALID',
      'Impact generations require a named economy model and prompt version.',
    );
  }

  if (
    !validTimestamp(input.authorizedAt) ||
    Date.parse(input.authorizedAt) < Date.parse(request.requestedAt)
  ) {
    return impactDeny(
      'IMPACT_GENERATION_TIMESTAMP_INVALID',
      'Impact generation authorization cannot precede its request.',
    );
  }

  const model = Object.freeze({
    ...input.model,
    modelId: input.model.modelId.trim(),
    promptVersion: input.model.promptVersion.trim(),
  });
  const authorization: ImpactObserverRunAuthorization = Object.freeze({
    runId: input.runId,
    requestId: request.id,
    slotId: input.slot.id,
    sourceEventSequence: request.sourceEventSequence,
    baseRevision: request.baseRevision,
    authorizedActorId: 'impact-observer',
    authorizedAt: input.authorizedAt,
    model,
    authority: IMPACT_OBSERVER_CONTRACT.authority,
    capabilities: Object.freeze([]) as readonly [],
    toolsAllowed: false,
    canMutateWorkflow: false,
  });

  return impactAllow(
    immutableSlot({
      ...input.slot,
      activeRequest: {
        ...request,
        state: 'running',
        authorization,
      },
    }),
  );
}

interface LinkedImpactGenerationInput {
  readonly slot: ImpactSummarySlot;
  readonly actor: Principal;
  readonly requestId: ImpactGenerationRequestId;
  readonly runId: ImpactObserverRunId;
  readonly baseRevision: number;
}

function requireLinkedGeneration(
  input: LinkedImpactGenerationInput,
): ImpactObserverDecision<RunningImpactGenerationRequest> {
  const observerCheck = requireImpactObserver(input.actor);
  if (!observerCheck.allowed) {
    return observerCheck;
  }

  const request = input.slot.activeRequest;
  if (request === undefined) {
    return impactDeny(
      'IMPACT_GENERATION_REQUEST_REQUIRED',
      'There is no active impact generation to publish or fail.',
    );
  }

  if (
    request.state !== 'running' ||
    request.id !== input.requestId ||
    request.authorization.requestId !== input.requestId ||
    request.authorization.runId !== input.runId ||
    request.authorization.slotId !== input.slot.id
  ) {
    return impactDeny(
      'IMPACT_GENERATION_LINK_MISMATCH',
      'Only the exact observer run authorized for the active request may write its result.',
    );
  }

  if (
    input.baseRevision !== request.baseRevision ||
    input.baseRevision !== request.authorization.baseRevision ||
    input.baseRevision !== currentRevisionNumber(input.slot)
  ) {
    return impactDeny(
      'IMPACT_BASE_REVISION_CONFLICT',
      'The visible impact summary changed after this generation was based.',
    );
  }

  return impactAllow(request);
}

function nextRequestAfterRun(
  slot: ImpactSummarySlot,
  baseRevision: number,
): QueuedImpactGenerationRequest | undefined {
  if (slot.coalescedFollowUp === undefined) {
    return undefined;
  }

  return queuedRequest(slot.id, baseRevision, slot.coalescedFollowUp);
}

export interface PublishImpactSummaryRevisionInput extends LinkedImpactGenerationInput {
  readonly summary: unknown;
  readonly generatedAt: ISODateTime;
}

/**
 * Appends a validated revision with compare-and-swap semantics on
 * `baseRevision`. Persistence must use the same base value in its atomic write.
 */
export function publishImpactSummaryRevision(
  input: PublishImpactSummaryRevisionInput,
): ImpactObserverDecision<ImpactSummarySlot> {
  const linkCheck = requireLinkedGeneration(input);
  if (!linkCheck.allowed) {
    return linkCheck;
  }

  const request = linkCheck.value;
  if (
    !validTimestamp(input.generatedAt) ||
    Date.parse(input.generatedAt) < Date.parse(request.authorization.authorizedAt)
  ) {
    return impactDeny(
      'IMPACT_GENERATION_TIMESTAMP_INVALID',
      'An impact revision cannot be generated before its observer run was authorized.',
    );
  }

  const summaryCheck = validateImpactSummary(input.summary);
  if (!summaryCheck.allowed) {
    return impactDeny('IMPACT_SUMMARY_INVALID', summaryCheck.reason);
  }

  const nextRevisionNumber = request.baseRevision + 1;
  const revision: ImpactSummaryRevision = Object.freeze({
    revision: nextRevisionNumber,
    summary: summaryCheck.value,
    sourceEventSequence: request.authorization.sourceEventSequence,
    sourceEventAt: request.sourceEventAt,
    generationRequestId: request.id,
    observerRunId: request.authorization.runId,
    model: request.authorization.model,
    generatedAt: input.generatedAt,
  });
  const activeRequest = nextRequestAfterRun(input.slot, nextRevisionNumber);
  const attempt: ImpactGenerationAttempt = Object.freeze({
    requestId: request.id,
    runId: request.authorization.runId,
    sourceEventSequence: request.authorization.sourceEventSequence,
    baseRevision: request.baseRevision,
    outcome: 'published',
    completedAt: input.generatedAt,
  });

  return impactAllow(
    immutableSlot({
      ...input.slot,
      revisions: [...input.slot.revisions, revision],
      attempts: [...input.slot.attempts, attempt],
      currentRevision: revision,
      activeRequest,
      coalescedFollowUp: undefined,
      freshness:
        revision.sourceEventSequence === input.slot.latestSourceEventSequence
          ? 'fresh'
          : 'stale',
      lastGenerationError: undefined,
    }),
  );
}

export interface FailImpactSummaryGenerationInput extends LinkedImpactGenerationInput {
  readonly message: string;
  readonly failedAt: ISODateTime;
}

/** Records failure metadata without replacing or deleting the last good revision. */
export function failImpactSummaryGeneration(
  input: FailImpactSummaryGenerationInput,
): ImpactObserverDecision<ImpactSummarySlot> {
  const linkCheck = requireLinkedGeneration(input);
  if (!linkCheck.allowed) {
    return linkCheck;
  }

  const request = linkCheck.value;
  const message = input.message.trim();
  if (message.length === 0) {
    return impactDeny(
      'IMPACT_SUMMARY_INVALID',
      'A failed impact generation requires a concise error message.',
    );
  }

  if (
    !validTimestamp(input.failedAt) ||
    Date.parse(input.failedAt) < Date.parse(request.authorization.authorizedAt)
  ) {
    return impactDeny(
      'IMPACT_GENERATION_TIMESTAMP_INVALID',
      'An impact generation cannot fail before its observer run was authorized.',
    );
  }

  const activeRequest = nextRequestAfterRun(
    input.slot,
    currentRevisionNumber(input.slot),
  );
  const lastGenerationError: ImpactGenerationError = Object.freeze({
    requestId: request.id,
    runId: request.authorization.runId,
    sourceEventSequence: request.authorization.sourceEventSequence,
    baseRevision: request.baseRevision,
    model: request.authorization.model,
    message,
    failedAt: input.failedAt,
  });
  const attempt: ImpactGenerationAttempt = Object.freeze({
    requestId: request.id,
    runId: request.authorization.runId,
    sourceEventSequence: request.authorization.sourceEventSequence,
    baseRevision: request.baseRevision,
    outcome: 'failed',
    completedAt: input.failedAt,
  });

  return impactAllow(
    immutableSlot({
      ...input.slot,
      attempts: [...input.slot.attempts, attempt],
      activeRequest,
      coalescedFollowUp: undefined,
      freshness: 'error',
      lastGenerationError,
    }),
  );
}
