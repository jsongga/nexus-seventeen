import type {
  ApprovalItem,
  AuditItem,
  DemoMission,
  DemoRun,
  ImpactSummary,
} from './data/demo';
import {
  IMPACT_OBSERVER,
  agentRunId,
  authorizeImpactSummaryGeneration,
  failImpactSummaryGeneration,
  impactObserverRunId,
  isAgentTask,
  isoDateTime,
  runControlSignalId,
  settleAgentRunInterruption,
  type HumanRunControlState,
  type AgentTask,
  type ImpactModelProvenance,
  type ImpactSummarySlot,
} from './domain';

export const PERSISTED_DEMO_STATE_VERSION = 8 as const;
export const DEMO_STORAGE_KEY = 'steward-demo-state-v8';

export type StoredDemoRun = Omit<DemoRun, 'queue' | 'agentTask'>;

export interface PersistedDemoState {
  schemaVersion: typeof PERSISTED_DEMO_STATE_VERSION;
  approvals: ApprovalItem[];
  missions: DemoMission[];
  runs: StoredDemoRun[];
  runControls: Record<string, HumanRunControlState>;
  agentTasks: Record<string, AgentTask>;
  impactSlots: Record<string, ImpactSummarySlot>;
  audit: AuditItem[];
  paused: boolean;
}

const ORCHESTRATION_WORKER = Object.freeze({
  kind: 'service' as const,
  id: 'orchestration-worker' as const,
  name: 'Orchestration worker',
});

const HYDRATION_FAILURE_MESSAGE =
  'The page reloaded before the economy observer finished. The last good user-impact revision remains visible.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDateString(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === 'string' && values.includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isOptional(value: unknown, guard: (candidate: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}

function isEvidenceCheck(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.label) &&
    isString(value.detail) &&
    isOneOf(value.status, ['passed', 'warning', 'pending'] as const)
  );
}

function isReleaseEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.commit) &&
    isNonEmptyString(value.buildDigest) &&
    isNonEmptyString(value.artifactDigest) &&
    isNonEmptyString(value.testsDigest) &&
    isNonEmptyString(value.configDigest) &&
    isNonEmptyString(value.migrationsDigest) &&
    isFiniteNumber(value.changedFiles) &&
    isFiniteNumber(value.additions) &&
    isFiniteNumber(value.deletions) &&
    isFiniteNumber(value.cost) &&
    isFiniteNumber(value.baselineCost) &&
    isString(value.rollback)
  );
}

function isManagerReview(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.manager) &&
    isNonEmptyString(value.managerColor) &&
    isNonEmptyString(value.completedAt) &&
    isString(value.summary) &&
    isOneOf(value.confidence, ['high', 'medium', 'low'] as const) &&
    isFiniteNumber(value.reviewedFiles) &&
    isStringArray(value.findings) &&
    isStringArray(value.openRisks) &&
    isFiniteNumber(value.engineerLoops)
  );
}

function isDecisionSelection(
  value: unknown,
): value is NonNullable<ApprovalItem['decision']> {
  return (
    isRecord(value) &&
    isNonEmptyString(value.optionId) &&
    isNonEmptyString(value.label) &&
    isString(value.detail) &&
    isNonEmptyString(value.decidedBy) &&
    isNonEmptyString(value.decidedAt)
  );
}

function hasValidDecisionLink(value: Record<string, unknown>): boolean {
  if (value.decision === undefined) return true;
  const decision = value.decision;
  return (
    value.kind === 'decision' &&
    isDecisionSelection(decision) &&
    Array.isArray(value.checks) &&
    value.checks.some(
      (check) => isRecord(check) && check.id === decision.optionId,
    )
  );
}

function isApproval(value: unknown): value is ApprovalItem {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.workItemId) &&
    isNonEmptyString(value.project) &&
    isNonEmptyString(value.title) &&
    isString(value.summary) &&
    isOneOf(value.kind, ['production', 'scope', 'decision'] as const) &&
    isOneOf(value.status, ['pending', 'approved', 'changes_requested', 'deployed'] as const) &&
    isOneOf(value.risk, ['low', 'medium', 'high', 'critical'] as const) &&
    isNonEmptyString(value.requestedAt) &&
    isDateString(value.startedAt) &&
    isOptional(value.endedAt, isDateString) &&
    (value.status === 'pending'
      ? value.endedAt === undefined
      : isDateString(value.endedAt) &&
        Date.parse(value.endedAt) >= Date.parse(value.startedAt)) &&
    isNonEmptyString(value.requestedBy) &&
    isNonEmptyString(value.requestedByColor) &&
    isNonEmptyString(value.requestedByRole) &&
    isOptional(value.budget, isString) &&
    isOptional(value.branch, isString) &&
    isOptional(value.target, isString) &&
    isOptional(value.confirmationPhrase, isString) &&
    isOptional(value.release, isReleaseEvidence) &&
    isOptional(value.managerReview, isManagerReview) &&
    isOptional(value.decision, isDecisionSelection) &&
    Array.isArray(value.checks) &&
    value.checks.every(isEvidenceCheck) &&
    hasValidDecisionLink(value)
  );
}

function isMission(value: unknown): value is DemoMission {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.project) &&
    isString(value.goal) &&
    isOneOf(
      value.state,
      ['scope_review', 'engineering', 'manager_review', 'human_review', 'deployed', 'blocked'] as const,
    ) &&
    isOneOf(value.risk, ['low', 'medium', 'high', 'critical'] as const) &&
    isFiniteNumber(value.progress) &&
    isNonEmptyString(value.owner) &&
    isNonEmptyString(value.ownerColor) &&
    isNonEmptyString(value.model) &&
    isFiniteNumber(value.spent) &&
    isFiniteNumber(value.budget) &&
    isNonEmptyString(value.updated) &&
    isString(value.branch)
  );
}

function isImpactSummary(value: unknown): value is ImpactSummary {
  return (
    isRecord(value) &&
    isString(value.outcome) &&
    isString(value.userImpact) &&
    isString(value.plainStatus) &&
    isString(value.nextMilestone) &&
    isNonEmptyString(value.refreshedAt) &&
    isNonEmptyString(value.model) &&
    isFiniteNumber(value.sourceUpdates) &&
    isOneOf(value.confidence, ['high', 'medium', 'low'] as const) &&
    isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    isNonEmptyString(value.revisionId) &&
    isSafeInteger(value.sourceThroughSequence) &&
    value.sourceThroughSequence >= 0 &&
    isOneOf(value.freshness, ['current', 'refreshing', 'stale', 'error'] as const) &&
    isString(value.changeSummary) &&
    value.generatedBy === 'Impact observer' &&
    isStringArray(value.sourceRefs) &&
    isOptional(value.pendingSourceEvents, isFiniteNumber) &&
    isOptional(value.error, isString)
  );
}

function isCurrentAction(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.label) &&
    isString(value.detail) &&
    isOneOf(value.kind, ['analysis', 'file', 'command', 'review'] as const) &&
    isOptional(value.target, isString) &&
    isNonEmptyString(value.tool) &&
    isNonEmptyString(value.elapsed)
  );
}

function isLoopStep(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value.phase, ['Research', 'Plan', 'Execute', 'Test'] as const) &&
    isOneOf(value.status, ['done', 'active', 'queued', 'failed'] as const) &&
    isString(value.detail)
  );
}

function isJournalEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.time) &&
    isNonEmptyString(value.phase) &&
    isNonEmptyString(value.title) &&
    isString(value.note) &&
    isOptional(value.evidence, isString) &&
    isOneOf(value.tone, ['note', 'success', 'warning'] as const)
  );
}

function isStoredRun(value: unknown): value is StoredDemoRun {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.agentLaneId) &&
    isNonEmptyString(value.workItemId) &&
    isNonEmptyString(value.agent) &&
    isNonEmptyString(value.role) &&
    isNonEmptyString(value.color) &&
    isNonEmptyString(value.model) &&
    isOneOf(value.tier, ['Economy', 'Balanced', 'Frontier'] as const) &&
    isNonEmptyString(value.activity) &&
    isString(value.detail) &&
    isFiniteNumber(value.progress) &&
    isFiniteNumber(value.tokens) &&
    isFiniteNumber(value.tokenLimit) &&
    isFiniteNumber(value.cost) &&
    isNonEmptyString(value.started) &&
    isOneOf(value.status, ['working', 'checking', 'waiting'] as const) &&
    isOptional(value.workspacePaused, (candidate) => typeof candidate === 'boolean') &&
    isOneOf(value.loopPhase, ['research', 'plan', 'execute', 'test', 'manager_review'] as const) &&
    isFiniteNumber(value.iteration) &&
    isNonEmptyString(value.lastHeartbeat) &&
    isCurrentAction(value.currentAction) &&
    Array.isArray(value.loopSteps) &&
    value.loopSteps.every(isLoopStep) &&
    Array.isArray(value.journal) &&
    value.journal.every(isJournalEntry) &&
    isString(value.nextStep) &&
    isOneOf(
      value.controlState,
      ['running', 'interrupt_requested', 'interrupt_acknowledged', 'interrupted', 'interrupt_refused', 'interrupt_unknown'] as const,
    ) &&
    isOptional(value.interruptRequestedAt, isString) &&
    isOptional(value.interruptAcknowledgedAt, isString) &&
    isOptional(value.interruptedAt, isString) &&
    isOptional(value.interruptionReason, isString) &&
    isOptional(value.interruptionDetail, isString) &&
    isImpactSummary(value.impactSummary)
  );
}

function isQueuedWork(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.laneId) &&
    isNonEmptyString(value.agentId) &&
    isSafeInteger(value.position) &&
    value.position > 0 &&
    isOneOf(value.priority, ['next', 'backlog'] as const) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.desiredOutcome) &&
    isSafeInteger(value.expectedAgentMinutes) &&
    value.expectedAgentMinutes > 0 &&
    value.expectedAgentMinutes % 15 === 0 &&
    value.status === 'queued' &&
    isNonEmptyString(value.queuedBy) &&
    isDateString(value.queuedAt)
  );
}

function isRunEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    isNonEmptyString(value.summary) &&
    isDateString(value.recordedAt)
  );
}

function isRunControlSignal(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.laneId) &&
    isOptional(value.runId, isNonEmptyString) &&
    isOneOf(
      value.action,
      ['work_queued', 'run_started', 'run_replaced', 'run_completed', 'run_reconciled_running', 'interrupt_requested', 'interrupt_acknowledged', 'interrupt_settled', 'resumed'] as const,
    ) &&
    isNonEmptyString(value.issuedBy) &&
    isOneOf(value.issuerKind, ['human', 'service'] as const) &&
    isDateString(value.issuedAt) &&
    isString(value.note) &&
    isOptional(value.queuedWorkId, isNonEmptyString) &&
    isOptional(value.queuePriority, (candidate): candidate is 'next' | 'backlog' =>
      isOneOf(candidate, ['next', 'backlog'] as const),
    ) &&
    (value.action === 'work_queued'
      ? isSafeInteger(value.expectedAgentMinutes) &&
        value.expectedAgentMinutes > 0 &&
        value.expectedAgentMinutes % 15 === 0
      : value.expectedAgentMinutes === undefined) &&
    isOptional(value.interruptionOutcome, (candidate): candidate is 'interrupted' | 'refused' | 'unknown' =>
      isOneOf(candidate, ['interrupted', 'refused', 'unknown'] as const),
    ) &&
    isOptional(value.replacedRunId, isNonEmptyString) &&
    isOptional(value.completionRelation, (candidate) =>
      isOneOf(candidate, ['without_interruption', 'before_cancellation', 'after_cancellation_attempt'] as const),
    ) &&
    isOptional(value.completionFromStatus, (candidate) =>
      isOneOf(candidate, ['idle', 'running', 'interrupt_requested', 'interrupt_acknowledged', 'interrupted', 'interrupt_refused', 'interrupt_unknown'] as const),
    ) &&
    isOptional(value.providerEvidence, isString)
  );
}

function isLoopCheckpoint(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value.stage, ['research', 'plan', 'execute', 'test', 'completed'] as const) &&
    isFiniteNumber(value.iteration) &&
    isOneOf(value.status, ['active', 'completed'] as const) &&
    isOptional(value.lastTestOutcome, (candidate): candidate is 'passed' | 'failed' =>
      isOneOf(candidate, ['passed', 'failed'] as const),
    )
  );
}

function isInterruption(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.requestSignalId) &&
    isNonEmptyString(value.requestedBy) &&
    isDateString(value.requestedAt) &&
    isString(value.reason) &&
    isOptional(value.acknowledgementSignalId, isNonEmptyString) &&
    isOptional(value.acknowledgedAt, isDateString) &&
    isOptional(value.settlementSignalId, isNonEmptyString) &&
    isOptional(value.settledAt, isDateString) &&
    isOptional(value.outcome, (candidate): candidate is 'interrupted' | 'refused' | 'unknown' =>
      isOneOf(candidate, ['interrupted', 'refused', 'unknown'] as const),
    ) &&
    isOptional(value.outcomeDetail, isString) &&
    isOptional(value.resumeSignalId, isNonEmptyString) &&
    isOptional(value.resumedAt, isDateString) &&
    isOptional(value.resumedBy, isNonEmptyString)
    && isOptional(value.reconciliationSignalId, isNonEmptyString)
    && isOptional(value.reconciledAt, isDateString)
    && isOptional(value.reconciliationEvidence, isNonEmptyString)
  );
}

function isRunCompletion(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.signalId) &&
    isDateString(value.completedAt) &&
    isOneOf(value.relationToInterruption, ['without_interruption', 'before_cancellation', 'after_cancellation_attempt'] as const) &&
    isOneOf(value.priorControlStatus, ['running', 'interrupt_requested', 'interrupt_acknowledged', 'interrupt_refused', 'interrupt_unknown'] as const) &&
    isString(value.note) &&
    isNonEmptyString(value.providerEvidence)
  );
}

function isRunControl(value: unknown): value is HumanRunControlState {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.laneId) ||
    !isNonEmptyString(value.agentId) ||
    !isOptional(value.activeRunId, isNonEmptyString) ||
    !isOptional(value.activeRunStartedAt, isDateString) ||
    !isOneOf(
      value.status,
      ['idle', 'running', 'interrupt_requested', 'interrupt_acknowledged', 'interrupted', 'interrupt_refused', 'interrupt_unknown'] as const,
    ) ||
    !Array.isArray(value.queue) ||
    !value.queue.every(isQueuedWork) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.every(isRunEvidence) ||
    !Array.isArray(value.signals) ||
    !value.signals.every(isRunControlSignal) ||
    !isOptional(value.loopCheckpoint, isLoopCheckpoint) ||
    !isOptional(value.interruption, isInterruption) ||
    !isOptional(value.lastCompletion, isRunCompletion)
  ) {
    return false;
  }

  const queueIsLinked = value.queue.every(
    (item) =>
      item.laneId === value.laneId &&
      item.agentId === value.agentId &&
      (value.signals as HumanRunControlState['signals']).some(
        (signal) =>
          signal.action === 'work_queued' &&
          signal.queuedWorkId === item.id &&
          signal.expectedAgentMinutes === item.expectedAgentMinutes,
      ),
  );
  const signalsAreLinked = value.signals.every(
    (signal, index, signals) =>
      signal.laneId === value.laneId &&
      (index === 0 || Date.parse(signal.issuedAt) >= Date.parse(signals[index - 1].issuedAt)),
  );
  const signalIds = new Set(value.signals.map((signal) => signal.id));
  if (!queueIsLinked || !signalsAreLinked || signalIds.size !== value.signals.length) {
    return false;
  }

  if (value.lastCompletion !== undefined) {
    if (!isRecord(value.lastCompletion)) return false;
    const completion = value.lastCompletion;
    const completionSignal = value.signals.find(
      (signal) => signal.id === completion.signalId,
    );
    if (
      completionSignal?.action !== 'run_completed' ||
      completionSignal.runId !== completion.runId ||
      completionSignal.issuedAt !== completion.completedAt ||
      completionSignal.completionRelation !== completion.relationToInterruption ||
      completionSignal.completionFromStatus !== completion.priorControlStatus ||
      completionSignal.providerEvidence !== completion.providerEvidence
    ) {
      return false;
    }
  }

  if (value.status === 'idle') {
    return value.activeRunId === undefined && value.activeRunStartedAt === undefined;
  }
  if (value.activeRunId === undefined) return false;

  if (value.status === 'running') {
    if (value.interruption === undefined) return true;
    if (!isRecord(value.interruption)) return false;
    const interruption = value.interruption;
    if (interruption.runId !== value.activeRunId) return false;
    if (interruption.outcome === 'interrupted') {
      return (
        isNonEmptyString(interruption.resumeSignalId) &&
        isDateString(interruption.resumedAt) &&
        isNonEmptyString(interruption.resumedBy) &&
        value.signals.some(
          (signal) =>
            signal.id === interruption.resumeSignalId &&
            signal.action === 'resumed' &&
            signal.runId === value.activeRunId &&
            signal.issuedAt === interruption.resumedAt,
        )
      );
    }
    if (
      interruption.outcome !== 'refused' &&
      interruption.outcome !== 'unknown'
    ) {
      return false;
    }
    return (
      isNonEmptyString(interruption.reconciliationSignalId) &&
      isDateString(interruption.reconciledAt) &&
      isNonEmptyString(interruption.reconciliationEvidence) &&
      value.signals.some(
        (signal) =>
          signal.id === interruption.reconciliationSignalId &&
          signal.action === 'run_reconciled_running' &&
          signal.runId === value.activeRunId &&
          signal.issuedAt === interruption.reconciledAt &&
          signal.providerEvidence === interruption.reconciliationEvidence,
      )
    );
  }

  if (!isRecord(value.interruption) || value.interruption.runId !== value.activeRunId) {
    return false;
  }
  const interruption = value.interruption;
  const requestSignal = value.signals.find(
    (signal) => signal.id === interruption.requestSignalId,
  );
  if (
    requestSignal?.action !== 'interrupt_requested' ||
    requestSignal.runId !== value.activeRunId ||
    requestSignal.issuedAt !== interruption.requestedAt ||
    requestSignal.issuedBy !== interruption.requestedBy
  ) {
    return false;
  }

  const hasAcknowledgement =
    isNonEmptyString(interruption.acknowledgementSignalId) &&
    isDateString(interruption.acknowledgedAt);
  if (
    (interruption.acknowledgementSignalId === undefined) !==
    (interruption.acknowledgedAt === undefined)
  ) {
    return false;
  }
  if (hasAcknowledgement) {
    const acknowledgementSignal = value.signals.find(
      (signal) => signal.id === interruption.acknowledgementSignalId,
    );
    if (
      acknowledgementSignal?.action !== 'interrupt_acknowledged' ||
      acknowledgementSignal.runId !== value.activeRunId ||
      acknowledgementSignal.issuedAt !== interruption.acknowledgedAt
    ) {
      return false;
    }
  }

  if (value.status === 'interrupt_requested') {
    return (
      !hasAcknowledgement &&
      interruption.settlementSignalId === undefined &&
      interruption.settledAt === undefined &&
      interruption.outcome === undefined
    );
  }
  if (value.status === 'interrupt_acknowledged') {
    return (
      hasAcknowledgement &&
      interruption.settlementSignalId === undefined &&
      interruption.settledAt === undefined &&
      interruption.outcome === undefined
    );
  }

  if (
    !isNonEmptyString(interruption.settlementSignalId) ||
    !isDateString(interruption.settledAt)
  ) {
    return false;
  }
  const settlementSignal = value.signals.find(
    (signal) => signal.id === interruption.settlementSignalId,
  );
  if (
    settlementSignal?.action !== 'interrupt_settled' ||
    settlementSignal.runId !== value.activeRunId ||
    settlementSignal.issuedAt !== interruption.settledAt ||
    settlementSignal.interruptionOutcome !== interruption.outcome
  ) {
    return false;
  }

  const expectedOutcome =
    value.status === 'interrupted'
      ? 'interrupted'
      : value.status === 'interrupt_refused'
        ? 'refused'
        : 'unknown';
  return (
    interruption.outcome === expectedOutcome &&
    (expectedOutcome === 'unknown' || hasAcknowledgement)
  );
}

function isImpactModel(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value.provider, ['openai', 'anthropic'] as const) &&
    isNonEmptyString(value.modelId) &&
    value.modelTier === 'economy' &&
    isNonEmptyString(value.promptVersion)
  );
}

function isDomainImpactSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.outcome) &&
    isNonEmptyString(value.userImpact) &&
    isOneOf(value.status, ['queued', 'in_progress', 'blocked', 'ready_for_review', 'complete'] as const) &&
    isNonEmptyString(value.nextMilestone)
  );
}

function isImpactAuthorization(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.slotId) &&
    isSafeInteger(value.sourceEventSequence) &&
    isSafeInteger(value.baseRevision) &&
    value.authorizedActorId === 'impact-observer' &&
    isDateString(value.authorizedAt) &&
    isImpactModel(value.model) &&
    value.authority === 'presentation_only' &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length === 0 &&
    value.toolsAllowed === false &&
    value.canMutateWorkflow === false
  );
}

function isImpactRequest(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.slotId) ||
    !isSafeInteger(value.baseRevision) ||
    !isSafeInteger(value.firstSourceEventSequence) ||
    !isSafeInteger(value.sourceEventSequence) ||
    !isDateString(value.sourceEventAt) ||
    !isDateString(value.requestedAt) ||
    !isSafeInteger(value.coalescedEventCount) ||
    !isOneOf(value.state, ['queued', 'running'] as const)
  ) {
    return false;
  }

  return value.state === 'queued' || isImpactAuthorization(value.authorization);
}

function isImpactRevision(value: unknown): boolean {
  return (
    isRecord(value) &&
    isSafeInteger(value.revision) &&
    value.revision > 0 &&
    isDomainImpactSummary(value.summary) &&
    isSafeInteger(value.sourceEventSequence) &&
    isDateString(value.sourceEventAt) &&
    isNonEmptyString(value.generationRequestId) &&
    isNonEmptyString(value.observerRunId) &&
    isImpactModel(value.model) &&
    isDateString(value.generatedAt)
  );
}

function isImpactFollowUp(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.requestId) &&
    isSafeInteger(value.firstSourceEventSequence) &&
    isSafeInteger(value.sourceEventSequence) &&
    isDateString(value.sourceEventAt) &&
    isDateString(value.requestedAt) &&
    isSafeInteger(value.coalescedEventCount)
  );
}

function isImpactError(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.runId) &&
    isSafeInteger(value.sourceEventSequence) &&
    isSafeInteger(value.baseRevision) &&
    isImpactModel(value.model) &&
    isNonEmptyString(value.message) &&
    isDateString(value.failedAt)
  );
}

function isImpactAttempt(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.runId) &&
    isSafeInteger(value.sourceEventSequence) &&
    isSafeInteger(value.baseRevision) &&
    isOneOf(value.outcome, ['published', 'failed'] as const) &&
    isDateString(value.completedAt)
  );
}

function isImpactSlot(value: unknown): value is ImpactSummarySlot {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.agentLaneId) ||
    !isNonEmptyString(value.workItemId) ||
    !Array.isArray(value.revisions) ||
    !value.revisions.every(isImpactRevision) ||
    !Array.isArray(value.attempts) ||
    !value.attempts.every(isImpactAttempt) ||
    !isOptional(value.currentRevision, isImpactRevision) ||
    !isOptional(value.activeRequest, isImpactRequest) ||
    !isOptional(value.coalescedFollowUp, isImpactFollowUp) ||
    !isSafeInteger(value.latestSourceEventSequence) ||
    value.latestSourceEventSequence < 0 ||
    !isOptional(value.latestSourceEventAt, isDateString) ||
    !isOneOf(value.freshness, ['empty', 'fresh', 'stale', 'error'] as const) ||
    !isOptional(value.lastGenerationError, isImpactError)
  ) {
    return false;
  }

  const attempts = value.attempts;
  const revisions = value.revisions;
  const currentRevision = isRecord(value.currentRevision) ? value.currentRevision.revision : 0;
  const requestIds = new Set(
    attempts.map((attempt) => (isRecord(attempt) ? attempt.requestId : undefined)),
  );
  const observerRunIds = new Set(
    attempts.map((attempt) => (isRecord(attempt) ? attempt.runId : undefined)),
  );
  if (
    requestIds.size !== attempts.length ||
    observerRunIds.size !== attempts.length
  ) {
    return false;
  }
  const revisionsAreContiguous = revisions.every(
    (revision, index, revisions) =>
      isRecord(revision) &&
      revision.revision === index + 1 &&
      (index === 0 ||
        (isRecord(revisions[index - 1]) &&
          Number(revision.sourceEventSequence) >= Number(revisions[index - 1].sourceEventSequence))),
  );
  if (!revisionsAreContiguous) return false;
  const publishedAttemptsMatch = revisions.every((revision) => {
    if (!isRecord(revision)) return false;
    return attempts.some(
      (attempt) =>
        isRecord(attempt) &&
        attempt.outcome === 'published' &&
        attempt.requestId === revision.generationRequestId &&
        attempt.runId === revision.observerRunId &&
        attempt.sourceEventSequence === revision.sourceEventSequence &&
        attempt.baseRevision === Number(revision.revision) - 1 &&
        attempt.completedAt === revision.generatedAt,
    );
  });
  if (!publishedAttemptsMatch) return false;
  if (value.revisions.length === 0 && value.currentRevision !== undefined) return false;
  if (value.revisions.length > 0) {
    const lastRevision = value.revisions.at(-1);
    if (
      currentRevision !== value.revisions.length ||
      JSON.stringify(value.currentRevision) !== JSON.stringify(lastRevision)
    ) {
      return false;
    }
  }

  if (value.activeRequest !== undefined) {
    if (!isRecord(value.activeRequest)) return false;
    const request = value.activeRequest;
    if (
      request.slotId !== value.id ||
      request.baseRevision !== currentRevision ||
      Number(request.firstSourceEventSequence) > Number(request.sourceEventSequence) ||
      Number(request.sourceEventSequence) > value.latestSourceEventSequence
    ) {
      return false;
    }
    if (
      requestIds.has(request.id) ||
      (request.state === 'running' &&
        isRecord(request.authorization) &&
        observerRunIds.has(request.authorization.runId))
    ) {
      return false;
    }

    if (request.state === 'queued') {
      if (request.authorization !== undefined || value.coalescedFollowUp !== undefined) {
        return false;
      }
    } else {
      if (!isRecord(request.authorization)) return false;
      const authorization = request.authorization;
      if (
        authorization.requestId !== request.id ||
        authorization.slotId !== value.id ||
        authorization.sourceEventSequence !== request.sourceEventSequence ||
        authorization.baseRevision !== request.baseRevision ||
        Date.parse(String(authorization.authorizedAt)) < Date.parse(String(request.requestedAt))
      ) {
        return false;
      }
    }
  } else if (value.coalescedFollowUp !== undefined) {
    return false;
  }

  if (value.coalescedFollowUp !== undefined) {
    if (!isRecord(value.coalescedFollowUp) || !isRecord(value.activeRequest)) return false;
    if (
      value.activeRequest.state !== 'running' ||
      Number(value.coalescedFollowUp.firstSourceEventSequence) <=
        Number(value.activeRequest.sourceEventSequence) ||
      Number(value.coalescedFollowUp.sourceEventSequence) > value.latestSourceEventSequence
    ) {
      return false;
    }
    if (
      requestIds.has(value.coalescedFollowUp.requestId) ||
      value.coalescedFollowUp.requestId === value.activeRequest.id
    ) {
      return false;
    }
  }

  if (value.lastGenerationError !== undefined) {
    if (!isRecord(value.lastGenerationError)) return false;
    const error = value.lastGenerationError;
    const matchingFailure = attempts.some(
      (attempt) =>
        isRecord(attempt) &&
        attempt.outcome === 'failed' &&
        attempt.requestId === error.requestId &&
        attempt.runId === error.runId &&
        attempt.sourceEventSequence === error.sourceEventSequence &&
        attempt.baseRevision === error.baseRevision &&
        attempt.completedAt === error.failedAt,
    );
    if (!matchingFailure) return false;
  }

  return true;
}

function isAuditItem(value: unknown): value is AuditItem {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.actor) &&
    isOneOf(value.actorType, ['human', 'agent', 'system'] as const) &&
    isNonEmptyString(value.action) &&
    isNonEmptyString(value.target) &&
    isString(value.detail) &&
    isNonEmptyString(value.time) &&
    isOneOf(value.tone, ['neutral', 'green', 'amber', 'red'] as const)
  );
}

/** Runtime trust boundary for browser storage. Invalid or old data is reset as a whole. */
export function isPersistedDemoState(value: unknown): value is PersistedDemoState {
  if (
    !isRecord(value) ||
    value.schemaVersion !== PERSISTED_DEMO_STATE_VERSION ||
    !Array.isArray(value.approvals) ||
    !value.approvals.every(isApproval) ||
    !Array.isArray(value.missions) ||
    !value.missions.every(isMission) ||
    !Array.isArray(value.runs) ||
    !value.runs.every(isStoredRun) ||
    !isRecord(value.runControls) ||
    !Object.values(value.runControls).every(isRunControl) ||
    !isRecord(value.agentTasks) ||
    !Object.values(value.agentTasks).every(isAgentTask) ||
    !isRecord(value.impactSlots) ||
    !Object.values(value.impactSlots).every(isImpactSlot) ||
    !Array.isArray(value.audit) ||
    !value.audit.every(isAuditItem) ||
    typeof value.paused !== 'boolean'
  ) {
    return false;
  }

  const runIds = new Set(value.runs.map((run) => run.id));
  const laneIds = new Set(value.runs.map((run) => run.agentLaneId));
  const runControls = value.runControls as Record<string, HumanRunControlState>;
  const agentTasks = value.agentTasks as Record<string, AgentTask>;
  const impactSlots = value.impactSlots as Record<string, ImpactSummarySlot>;
  if (runIds.size !== value.runs.length) return false;
  if (Object.keys(impactSlots).some((laneId) => !laneIds.has(laneId))) return false;
  if (
    Object.entries(agentTasks).some(
      ([laneId, task]) =>
        !laneIds.has(laneId) || String(task.laneId) !== laneId,
    )
  ) {
    return false;
  }

  return value.runs.every((run) => {
    const control = runControls[run.agentLaneId];
    const slot = impactSlots[run.agentLaneId];
    return (
      control !== undefined &&
      control.laneId === run.agentLaneId &&
      (agentTasks[run.agentLaneId] === undefined ||
        String(agentTasks[run.agentLaneId].workItemId) === run.workItemId) &&
      slot !== undefined &&
      slot.agentLaneId === run.agentLaneId &&
      slot.workItemId === run.workItemId &&
      slot.currentRevision?.revision === run.impactSummary.revision
    );
  });
}

function modelForSummary(summary: ImpactSummary): ImpactModelProvenance {
  return {
    provider: summary.model.toLowerCase().includes('claude') ? 'anthropic' : 'openai',
    modelId: summary.model.replace(/\s+observer$/i, '').trim(),
    modelTier: 'economy',
    promptVersion: 'impact-v2',
  };
}

function timestampAfter(now: number, ...values: Array<string | undefined>) {
  const latest = values.reduce(
    (maximum, value) => Math.max(maximum, value === undefined ? 0 : Date.parse(value)),
    now,
  );
  return isoDateTime(new Date(latest + 1).toISOString());
}

function abandonImpactGeneration(
  slot: ImpactSummarySlot,
  summary: ImpactSummary,
  runId: string,
  now: number,
): ImpactSummarySlot {
  let reconciled = slot;

  // There can be one active request and one coalesced follow-up. Fail both so
  // no in-memory observer work is implied after the page process disappeared.
  for (let attempt = 0; attempt < 2 && reconciled.activeRequest; attempt += 1) {
    if (reconciled.activeRequest.state === 'queued') {
      const request = reconciled.activeRequest;
      const authorized = authorizeImpactSummaryGeneration({
        slot: reconciled,
        actor: IMPACT_OBSERVER,
        requestId: request.id,
        runId: impactObserverRunId(
          `reload-${runId.toLowerCase()}-${String(request.id)}`,
        ),
        baseRevision: request.baseRevision,
        model: modelForSummary(summary),
        authorizedAt: timestampAfter(now, request.requestedAt),
      });
      if (!authorized.allowed) return reconciled;
      reconciled = authorized.value;
    }

    const request = reconciled.activeRequest;
    if (!request || request.state !== 'running') return reconciled;
    const failed = failImpactSummaryGeneration({
      slot: reconciled,
      actor: IMPACT_OBSERVER,
      requestId: request.id,
      runId: request.authorization.runId,
      baseRevision: request.baseRevision,
      message: HYDRATION_FAILURE_MESSAGE,
      failedAt: timestampAfter(now + attempt + 1, request.authorization.authorizedAt),
    });
    if (!failed.allowed) return reconciled;
    reconciled = failed.value;
  }

  return reconciled;
}

/**
 * Browser timers are not durable. On reload, transient worker/observer states
 * are settled honestly instead of being shown as if background work survived.
 */
export function reconcilePersistedDemoState(
  state: PersistedDemoState,
  now = Date.now(),
): PersistedDemoState {
  let recoveredControlCount = 0;
  let recoveredObserverCount = 0;

  const runControls = Object.fromEntries(
    Object.entries(state.runControls).map(([laneId, control], index) => {
      if (
        (control.status !== 'interrupt_requested' &&
          control.status !== 'interrupt_acknowledged') ||
        control.activeRunId === undefined
      ) {
        return [laneId, control] as const;
      }

      const settled = settleAgentRunInterruption({
        control,
        actor: ORCHESTRATION_WORKER,
        runId: agentRunId(control.activeRunId),
        signalId: runControlSignalId(`reload-${laneId}-interrupt-unknown-${control.signals.length}`),
        outcome: 'unknown',
        settledAt: timestampAfter(
          now + index,
          control.signals.at(-1)?.issuedAt,
          control.interruption?.acknowledgedAt,
        ),
        detail:
          'The page reloaded before worker settlement was recorded. Steward cannot prove whether the provider process stopped, so new dispatches remain fenced.',
      });
      if (!settled.allowed) return [laneId, control] as const;
      recoveredControlCount += 1;
      return [laneId, settled.value] as const;
    }),
  );

  const impactSlots: Record<string, ImpactSummarySlot> = { ...state.impactSlots };
  const runs = state.runs.map((run) => {
    const slot = impactSlots[run.agentLaneId];
    const hadTransientObserver =
      run.impactSummary.freshness === 'refreshing' || slot.activeRequest !== undefined;
    if (!hadTransientObserver) return run;

    impactSlots[run.agentLaneId] = abandonImpactGeneration(
      slot,
      run.impactSummary,
      run.id,
      now + recoveredObserverCount * 4,
    );
    recoveredObserverCount += 1;
    return {
      ...run,
      impactSummary: {
        ...run.impactSummary,
        freshness: 'error' as const,
        pendingSourceEvents: 0,
        error: HYDRATION_FAILURE_MESSAGE,
      },
    };
  });

  if (recoveredControlCount === 0 && recoveredObserverCount === 0) return state;

  const recoveryAudit: AuditItem[] = [];
  if (recoveredControlCount > 0) {
    recoveryAudit.push({
      id: `evt-reload-${now}-run-control`,
      actor: 'Orchestration worker',
      actorType: 'system',
      action: 'marked unfinished interrupts as unknown',
      target: `${recoveredControlCount} agent ${recoveredControlCount === 1 ? 'lane' : 'lanes'}`,
      detail:
        'The browser process disappeared before settlement evidence was recorded. Dispatch remains fenced until a human retries or reconciles the worker.',
      time: 'Today · after reload',
      tone: 'amber',
    });
  }
  if (recoveredObserverCount > 0) {
    recoveryAudit.push({
      id: `evt-reload-${now}-impact`,
      actor: 'Impact observer',
      actorType: 'system',
      action: 'retained last good summary after reload',
      target: `${recoveredObserverCount} impact ${recoveredObserverCount === 1 ? 'slot' : 'slots'}`,
      detail:
        'Incomplete economy-model generations were failed explicitly; prior user-facing revisions remain available with an error marker.',
      time: 'Today · after reload',
      tone: 'amber',
    });
  }

  return {
    ...state,
    runs,
    runControls,
    impactSlots,
    audit: [...recoveryAudit, ...state.audit],
  };
}

export function parsePersistedDemoState(
  serialized: string | null,
  fallback: PersistedDemoState,
  now = Date.now(),
): PersistedDemoState {
  if (serialized === null) return fallback;

  try {
    const parsed: unknown = JSON.parse(serialized);
    return isPersistedDemoState(parsed)
      ? reconcilePersistedDemoState(parsed, now)
      : fallback;
  } catch {
    return fallback;
  }
}
