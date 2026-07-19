import type {
  AgentActor,
  EngineeringLoop,
  EngineeringLoopStage,
  HumanProductionCheckTask,
  ISODateTime,
  ManagerReview,
  ManagerReviewDecision,
  ManagerReviewId,
  Principal,
  PolicyDecision,
  PolicyFailureCode,
  ProductionCheckTaskId,
  ProgressJournalEntry,
  ProgressUpdate,
  ProjectId,
  ReleaseCandidate,
  TestOutcome,
  WorkItemId,
} from './types';
import { sameReleaseCandidate, snapshotReleaseCandidate } from './approval-policy';

function allow<Value>(value: Value): PolicyDecision<Value> {
  return { allowed: true, value };
}

function deny<Value>(code: PolicyFailureCode, reason: string): PolicyDecision<Value> {
  return { allowed: false, code, reason };
}

function immutableLoop(loop: EngineeringLoop): EngineeringLoop {
  return Object.freeze({
    ...loop,
    journal: Object.freeze(
      loop.journal.map((entry) => Object.freeze({ ...entry })),
    ),
  });
}

function immutableReview(review: ManagerReview): ManagerReview {
  return Object.freeze({
    ...review,
    reviewedRelease: snapshotReleaseCandidate(review.reviewedRelease),
    checksPerformed: Object.freeze([...review.checksPerformed]),
    remainingRisks: Object.freeze([...review.remainingRisks]),
  });
}

function validTimestamp(value: ISODateTime): boolean {
  return String(value).trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function validateProgress(
  update: ProgressUpdate,
  notBefore?: ISODateTime,
): PolicyDecision<true> {
  if (update.summary.trim().length === 0) {
    return deny(
      'PROGRESS_ENTRY_REQUIRED',
      'Every engineering-loop transition requires a non-empty progress entry.',
    );
  }

  if (
    !validTimestamp(update.recordedAt) ||
    (notBefore !== undefined && Date.parse(update.recordedAt) < Date.parse(notBefore))
  ) {
    return deny(
      'INVALID_PROGRESS_TIMESTAMP',
      'Progress entries require a valid timestamp that does not precede the prior entry.',
    );
  }

  return allow(true);
}

function latestTimestamp(loop: EngineeringLoop): ISODateTime {
  return loop.journal.at(-1)?.recordedAt ?? loop.startedAt;
}

function progressEntry(input: {
  readonly loop?: EngineeringLoop;
  readonly iteration: number;
  readonly from: EngineeringLoopStage | 'not_started';
  readonly to: EngineeringLoopStage;
  readonly progress: ProgressUpdate;
  readonly testOutcome?: TestOutcome;
}): ProgressJournalEntry {
  return Object.freeze({
    sequence: (input.loop?.journal.length ?? 0) + 1,
    iteration: input.iteration,
    from: input.from,
    to: input.to,
    summary: input.progress.summary.trim(),
    recordedAt: input.progress.recordedAt,
    ...(input.testOutcome === undefined ? {} : { testOutcome: input.testOutcome }),
  });
}

function requireAssignedEngineer(
  actor: Principal,
  loop?: EngineeringLoop,
): PolicyDecision<AgentActor> {
  if (actor.kind !== 'agent' || actor.role !== 'engineer') {
    return deny('ROLE_MISMATCH', 'Only an engineer may operate an engineering loop.');
  }

  if (loop && actor.id !== loop.engineerId) {
    return deny(
      'ROLE_MISMATCH',
      'Only the engineer assigned to this loop may advance its work.',
    );
  }

  return allow(actor);
}

export interface StartEngineeringLoopInput {
  readonly projectId: ProjectId;
  readonly workItemId: WorkItemId;
  readonly actor: Principal;
  readonly progress: ProgressUpdate;
}

export function startEngineeringLoop(
  input: StartEngineeringLoopInput,
): PolicyDecision<EngineeringLoop> {
  const engineerCheck = requireAssignedEngineer(input.actor);
  if (!engineerCheck.allowed) {
    return engineerCheck;
  }

  const progressCheck = validateProgress(input.progress);
  if (!progressCheck.allowed) {
    return progressCheck;
  }

  const firstEntry = progressEntry({
    iteration: 1,
    from: 'not_started',
    to: 'research',
    progress: input.progress,
  });

  return allow(
    immutableLoop({
      projectId: input.projectId,
      workItemId: input.workItemId,
      engineerId: engineerCheck.value.id,
      stage: 'research',
      iteration: 1,
      status: 'active',
      journal: [firstEntry],
      startedAt: input.progress.recordedAt,
    }),
  );
}

export interface AdvanceEngineeringLoopInput {
  readonly loop: EngineeringLoop;
  readonly actor: Principal;
  readonly to: EngineeringLoopStage;
  readonly progress: ProgressUpdate;
  readonly testOutcome?: TestOutcome;
}

const NEXT_STAGE = Object.freeze({
  research: 'plan',
  plan: 'execute',
  execute: 'test',
} satisfies Readonly<Record<'research' | 'plan' | 'execute', EngineeringLoopStage>>);

/**
 * Enforces Research -> Plan -> Execute -> Test. A passing Test completes the
 * engineer's loop; a failed Test atomically opens the next Research iteration.
 */
export function advanceEngineeringLoop(
  input: AdvanceEngineeringLoopInput,
): PolicyDecision<EngineeringLoop> {
  const engineerCheck = requireAssignedEngineer(input.actor, input.loop);
  if (!engineerCheck.allowed) {
    return engineerCheck;
  }

  const progressCheck = validateProgress(input.progress, latestTimestamp(input.loop));
  if (!progressCheck.allowed) {
    return progressCheck;
  }

  if (input.loop.status === 'completed' || input.loop.stage === 'completed') {
    return deny(
      'INVALID_LOOP_TRANSITION',
      'A completed loop can only be reopened after a manager requests changes.',
    );
  }

  let nextIteration = input.loop.iteration;
  let nextStatus: EngineeringLoop['status'] = 'active';
  let nextTestOutcome: TestOutcome | undefined = input.loop.lastTestOutcome;

  if (input.loop.stage === 'test') {
    if (input.testOutcome === undefined) {
      return deny(
        'TEST_RESULT_REQUIRED',
        'Leaving Test requires a recorded passing or failing result.',
      );
    }

    const expectedDestination = input.testOutcome === 'passed' ? 'completed' : 'research';
    if (input.to !== expectedDestination) {
      return deny(
        'INVALID_LOOP_TRANSITION',
        input.testOutcome === 'passed'
          ? 'A passing Test may only complete the loop.'
          : 'A failed Test must start a new iteration at Research.',
      );
    }

    nextTestOutcome = input.testOutcome;
    if (input.testOutcome === 'passed') {
      nextStatus = 'completed';
    } else {
      nextIteration += 1;
    }
  } else {
    if (input.testOutcome !== undefined) {
      return deny(
        'INVALID_LOOP_TRANSITION',
        'Test outcomes may only be recorded while leaving the Test stage.',
      );
    }

    if (input.to !== NEXT_STAGE[input.loop.stage]) {
      return deny(
        'INVALID_LOOP_TRANSITION',
        `${input.loop.stage} must transition to ${NEXT_STAGE[input.loop.stage]}; stages cannot be skipped.`,
      );
    }

    if (input.to === 'test') {
      nextTestOutcome = undefined;
    }
  }

  const entry = progressEntry({
    loop: input.loop,
    iteration: nextIteration,
    from: input.loop.stage,
    to: input.to,
    progress: input.progress,
    testOutcome: input.testOutcome,
  });

  return allow(
    immutableLoop({
      ...input.loop,
      stage: input.to,
      iteration: nextIteration,
      status: nextStatus,
      journal: [...input.loop.journal, entry],
      lastTestOutcome: nextTestOutcome,
      ...(nextStatus === 'completed'
        ? { completedAt: input.progress.recordedAt }
        : { completedAt: undefined }),
    }),
  );
}

export function currentProgress(loop: EngineeringLoop): ProgressJournalEntry {
  const current = loop.journal.at(-1);
  if (!current) {
    throw new Error('An engineering loop must contain at least one progress entry.');
  }
  return current;
}

export interface ReviewEngineeringLoopInput {
  readonly reviewId: ManagerReviewId;
  readonly loop: EngineeringLoop;
  readonly release: ReleaseCandidate;
  readonly actor: AgentActor;
  readonly decision: ManagerReviewDecision;
  readonly summary: string;
  readonly checksPerformed: readonly string[];
  readonly remainingRisks?: readonly string[];
  readonly reviewedAt: ISODateTime;
}

export function reviewEngineeringLoop(
  input: ReviewEngineeringLoopInput,
): PolicyDecision<ManagerReview> {
  if (input.actor.role !== 'manager') {
    return deny('ROLE_MISMATCH', 'Only a manager may review a completed engineering loop.');
  }

  if (input.actor.id === input.loop.engineerId) {
    return deny(
      'MANAGER_SEPARATION_REQUIRED',
      'The engineer who performed the work cannot act as its manager reviewer.',
    );
  }

  if (
    input.loop.status !== 'completed' ||
    input.loop.stage !== 'completed' ||
    input.loop.lastTestOutcome !== 'passed'
  ) {
    return deny(
      'LOOP_NOT_COMPLETE',
      'Manager review requires a complete engineering loop whose Test passed.',
    );
  }

  if (
    input.release.projectId !== input.loop.projectId ||
    input.release.workItemId !== input.loop.workItemId
  ) {
    return deny(
      'MANAGER_REVIEW_MISMATCH',
      'A manager may only review a release candidate produced for this engineering loop.',
    );
  }

  const progressCheck = validateProgress(
    { summary: input.summary, recordedAt: input.reviewedAt },
    latestTimestamp(input.loop),
  );
  if (!progressCheck.allowed) {
    return progressCheck;
  }

  const checksPerformed = input.checksPerformed
    .map((check) => check.trim())
    .filter((check) => check.length > 0);
  if (checksPerformed.length === 0) {
    return deny(
      'MANAGER_REVIEW_EVIDENCE_REQUIRED',
      'A manager must record at least one check performed before deciding.',
    );
  }

  const remainingRisks = (input.remainingRisks ?? [])
    .map((risk) => risk.trim())
    .filter((risk) => risk.length > 0);

  return allow(
    immutableReview({
      id: input.reviewId,
      projectId: input.loop.projectId,
      workItemId: input.loop.workItemId,
      engineerId: input.loop.engineerId,
      managerId: input.actor.id,
      loopIteration: input.loop.iteration,
      reviewedRelease: input.release,
      decision: input.decision,
      summary: input.summary.trim(),
      checksPerformed,
      remainingRisks,
      reviewedAt: input.reviewedAt,
    }),
  );
}

export interface ReopenEngineeringLoopInput {
  readonly loop: EngineeringLoop;
  readonly review: ManagerReview;
  readonly actor: Principal;
  readonly progress: ProgressUpdate;
}

export function reopenEngineeringLoopAfterChanges(
  input: ReopenEngineeringLoopInput,
): PolicyDecision<EngineeringLoop> {
  const engineerCheck = requireAssignedEngineer(input.actor, input.loop);
  if (!engineerCheck.allowed) {
    return engineerCheck;
  }

  if (
    input.review.projectId !== input.loop.projectId ||
    input.review.workItemId !== input.loop.workItemId ||
    input.review.engineerId !== input.loop.engineerId ||
    input.review.loopIteration !== input.loop.iteration
  ) {
    return deny(
      'MANAGER_REVIEW_MISMATCH',
      'The manager review does not belong to this exact loop iteration.',
    );
  }

  if (
    input.loop.status !== 'completed' ||
    input.loop.stage !== 'completed' ||
    input.loop.lastTestOutcome !== 'passed' ||
    input.loop.completedAt === undefined
  ) {
    return deny(
      'LOOP_NOT_COMPLETE',
      'Only the completed passing loop reviewed by the manager can be reopened.',
    );
  }

  if (input.review.decision !== 'changes_requested') {
    return deny(
      'MANAGER_REVIEW_NOT_ACCEPTED',
      'Only a changes-requested review can reopen an engineering loop.',
    );
  }

  const progressCheck = validateProgress(input.progress, input.review.reviewedAt);
  if (!progressCheck.allowed) {
    return progressCheck;
  }

  const nextIteration = input.loop.iteration + 1;
  const entry = progressEntry({
    loop: input.loop,
    iteration: nextIteration,
    from: 'completed',
    to: 'research',
    progress: input.progress,
  });

  return allow(
    immutableLoop({
      ...input.loop,
      stage: 'research',
      iteration: nextIteration,
      status: 'active',
      journal: [...input.loop.journal, entry],
      completedAt: undefined,
      lastTestOutcome: undefined,
    }),
  );
}

export interface CreateHumanProductionCheckTaskInput {
  readonly taskId: ProductionCheckTaskId;
  readonly release: ReleaseCandidate;
  readonly review?: ManagerReview;
  readonly actor: AgentActor;
  readonly instructions: string;
  readonly createdAt: ISODateTime;
}

export function createHumanProductionCheckTask(
  input: CreateHumanProductionCheckTaskInput,
): PolicyDecision<HumanProductionCheckTask> {
  if (input.actor.role !== 'manager') {
    return deny(
      'ROLE_MISMATCH',
      'Only a manager may post a production-check task to a human.',
    );
  }

  if (!input.review) {
    return deny(
      'MANAGER_REVIEW_REQUIRED',
      'A production-check task requires a completed manager review.',
    );
  }

  if (input.review.managerId === input.review.engineerId) {
    return deny(
      'MANAGER_SEPARATION_REQUIRED',
      'The engineer and manager reviewer must be different agents.',
    );
  }

  if (input.review.managerId !== input.actor.id) {
    return deny(
      'MANAGER_REVIEW_MISMATCH',
      'Only the manager who recorded the review may hand it to a human.',
    );
  }

  if (input.review.decision !== 'accepted') {
    return deny(
      'MANAGER_REVIEW_NOT_ACCEPTED',
      'A human production check may only be created from an accepted manager review.',
    );
  }

  if (!sameReleaseCandidate(input.review.reviewedRelease, input.release)) {
    return deny(
      'MANAGER_REVIEW_MISMATCH',
      'The accepted manager review does not bind this exact release candidate.',
    );
  }

  const progressCheck = validateProgress(
    { summary: input.instructions, recordedAt: input.createdAt },
    input.review.reviewedAt,
  );
  if (!progressCheck.allowed) {
    return progressCheck;
  }

  return allow(
    Object.freeze({
      id: input.taskId,
      releaseId: input.release.id,
      projectId: input.release.projectId,
      workItemId: input.release.workItemId,
      managerReviewId: input.review.id,
      managerReviewDecision: 'accepted',
      boundRelease: snapshotReleaseCandidate(input.release),
      boundDigests: Object.freeze({ ...input.release.digests }),
      status: 'awaiting_human_check',
      requestedBy: input.actor.id,
      instructions: input.instructions.trim(),
      managerReviewSummary: input.review.summary,
      checksPerformed: Object.freeze([...input.review.checksPerformed]),
      remainingRisks: Object.freeze([...input.review.remainingRisks]),
      createdAt: input.createdAt,
    }),
  );
}
