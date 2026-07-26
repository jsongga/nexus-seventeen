import { describe, expect, it } from 'vitest';

import {
  advanceEngineeringLoop,
  createHumanProductionCheckTask,
  currentProgress,
  reopenEngineeringLoopAfterChanges,
  reviewEngineeringLoop,
  startEngineeringLoop,
} from './engineering-loop';
import { SEED_AGENTS, SEED_RELEASE } from './seed';
import {
  agentId,
  contentDigest,
  gitCommitSha,
  isoDateTime,
  managerReviewId,
  projectId,
  productionCheckTaskId,
  releaseId,
  workItemId,
} from './types';
import type {
  AgentActor,
  EngineeringLoop,
  ManagerReviewDecision,
  PolicyDecision,
  ReleaseCandidate,
  ReleaseDigests,
} from './types';

const ENGINEER_PROFILE = SEED_AGENTS.find((agent) => agent.role === 'engineer');
const MANAGER_PROFILE = SEED_AGENTS.find((agent) => agent.role === 'manager');
if (!ENGINEER_PROFILE || !MANAGER_PROFILE) {
  throw new Error('Seed data must include an engineer and manager.');
}

const ENGINEER: AgentActor = {
  kind: 'agent',
  id: ENGINEER_PROFILE.id,
  name: ENGINEER_PROFILE.name,
  role: 'engineer',
};

const MANAGER: AgentActor = {
  kind: 'agent',
  id: MANAGER_PROFILE.id,
  name: MANAGER_PROFILE.name,
  role: 'manager',
};

function value<Value>(decision: PolicyDecision<Value>): Value {
  if (!decision.allowed) {
    throw new Error(`${decision.code}: ${decision.reason}`);
  }
  return decision.value;
}

function start(): EngineeringLoop {
  return value(
    startEngineeringLoop({
      projectId: SEED_RELEASE.projectId,
      workItemId: SEED_RELEASE.workItemId,
      actor: ENGINEER,
      progress: {
        summary: 'Inspecting the existing implementation and constraints.',
        recordedAt: isoDateTime('2026-07-18T20:00:00.000Z'),
      },
    }),
  );
}

function advance(
  loop: EngineeringLoop,
  to: 'research' | 'plan' | 'execute' | 'test' | 'completed',
  minute: number,
  testOutcome?: 'passed' | 'failed',
): EngineeringLoop {
  return value(
    advanceEngineeringLoop({
      loop,
      actor: ENGINEER,
      to,
      progress: {
        summary: `Recorded progress moving to ${to}.`,
        recordedAt: isoDateTime(`2026-07-18T20:${String(minute).padStart(2, '0')}:00.000Z`),
      },
      testOutcome,
    }),
  );
}

function completedLoop(): EngineeringLoop {
  let loop = start();
  loop = advance(loop, 'plan', 1);
  loop = advance(loop, 'execute', 2);
  loop = advance(loop, 'test', 3);
  return advance(loop, 'completed', 4, 'passed');
}

function managerReview(
  loop: EngineeringLoop,
  decision: ManagerReviewDecision,
  release: ReleaseCandidate = SEED_RELEASE,
) {
  return value(
    reviewEngineeringLoop({
      reviewId: managerReviewId(`review-${decision}`),
      loop,
      release,
      actor: MANAGER,
      decision,
      summary:
        decision === 'accepted'
          ? 'The implementation and evidence satisfy the task.'
          : 'The timeout case still needs explicit coverage.',
      checksPerformed: ['Reviewed the diff.', 'Reran the acceptance tests.'],
      remainingRisks: ['Watch retry latency after rollout.'],
      reviewedAt: isoDateTime('2026-07-18T20:05:00.000Z'),
    }),
  );
}

describe('engineer Research -> Plan -> Execute -> Test loop', () => {
  it('rejects skipped or out-of-order stages', () => {
    const loop = start();
    const skipped = advanceEngineeringLoop({
      loop,
      actor: ENGINEER,
      to: 'execute',
      progress: {
        summary: 'Trying to implement before planning.',
        recordedAt: isoDateTime('2026-07-18T20:01:00.000Z'),
      },
    });

    expect(skipped.allowed).toBe(false);
    if (!skipped.allowed) {
      expect(skipped.code).toBe('INVALID_LOOP_TRANSITION');
    }
    expect(loop.stage).toBe('research');
    expect(loop.journal).toHaveLength(1);
  });

  it('requires a non-empty, valid, monotonic journal entry for every transition', () => {
    const noInitialProgress = startEngineeringLoop({
      projectId: SEED_RELEASE.projectId,
      workItemId: SEED_RELEASE.workItemId,
      actor: ENGINEER,
      progress: { summary: '   ', recordedAt: isoDateTime('2026-07-18T20:00:00.000Z') },
    });
    expect(noInitialProgress.allowed).toBe(false);
    if (!noInitialProgress.allowed) {
      expect(noInitialProgress.code).toBe('PROGRESS_ENTRY_REQUIRED');
    }

    const noTransitionProgress = advanceEngineeringLoop({
      loop: start(),
      actor: ENGINEER,
      to: 'plan',
      progress: { summary: '', recordedAt: isoDateTime('2026-07-18T20:01:00.000Z') },
    });
    expect(noTransitionProgress.allowed).toBe(false);
    if (!noTransitionProgress.allowed) {
      expect(noTransitionProgress.code).toBe('PROGRESS_ENTRY_REQUIRED');
    }

    const timestampMovedBackward = advanceEngineeringLoop({
      loop: start(),
      actor: ENGINEER,
      to: 'plan',
      progress: {
        summary: 'A real update with a stale timestamp.',
        recordedAt: isoDateTime('2026-07-18T19:59:00.000Z'),
      },
    });
    expect(timestampMovedBackward.allowed).toBe(false);
    if (!timestampMovedBackward.allowed) {
      expect(timestampMovedBackward.code).toBe('INVALID_PROGRESS_TIMESTAMP');
    }
  });

  it('starts a new Research iteration after a failed Test and completes only after a pass', () => {
    let loop = start();
    loop = advance(loop, 'plan', 1);
    loop = advance(loop, 'execute', 2);
    loop = advance(loop, 'test', 3);

    const missingResult = advanceEngineeringLoop({
      loop,
      actor: ENGINEER,
      to: 'completed',
      progress: {
        summary: 'Trying to finish without a result.',
        recordedAt: isoDateTime('2026-07-18T20:04:00.000Z'),
      },
    });
    expect(missingResult.allowed).toBe(false);
    if (!missingResult.allowed) {
      expect(missingResult.code).toBe('TEST_RESULT_REQUIRED');
    }

    loop = advance(loop, 'research', 4, 'failed');
    expect(loop.stage).toBe('research');
    expect(loop.status).toBe('active');
    expect(loop.iteration).toBe(2);
    expect(currentProgress(loop)).toMatchObject({
      from: 'test',
      to: 'research',
      iteration: 2,
      testOutcome: 'failed',
    });

    loop = advance(loop, 'plan', 5);
    loop = advance(loop, 'execute', 6);
    loop = advance(loop, 'test', 7);
    loop = advance(loop, 'completed', 8, 'passed');

    expect(loop.status).toBe('completed');
    expect(loop.stage).toBe('completed');
    expect(loop.iteration).toBe(2);
    expect(loop.lastTestOutcome).toBe('passed');
    expect(loop.journal).toHaveLength(9);
    expect(loop.journal.every((entry) => entry.summary.length > 0)).toBe(true);
  });
});

describe('manager review and human production handoff', () => {
  it('requires a separate manager and a completed passing loop', () => {
    const incomplete = reviewEngineeringLoop({
      reviewId: managerReviewId('review-incomplete'),
      loop: start(),
      release: SEED_RELEASE,
      actor: MANAGER,
      decision: 'accepted',
      summary: 'This should not be accepted yet.',
      checksPerformed: ['Looked at the current research.'],
      reviewedAt: isoDateTime('2026-07-18T20:05:00.000Z'),
    });
    expect(incomplete.allowed).toBe(false);
    if (!incomplete.allowed) {
      expect(incomplete.code).toBe('LOOP_NOT_COMPLETE');
    }

    const engineerReview = reviewEngineeringLoop({
      reviewId: managerReviewId('review-by-engineer'),
      loop: completedLoop(),
      release: SEED_RELEASE,
      actor: ENGINEER,
      decision: 'accepted',
      summary: 'Self approval attempt.',
      checksPerformed: ['Reviewed my own work.'],
      reviewedAt: isoDateTime('2026-07-18T20:05:00.000Z'),
    });
    expect(engineerReview.allowed).toBe(false);
    if (!engineerReview.allowed) {
      expect(engineerReview.code).toBe('ROLE_MISMATCH');
    }

    const sameIdentityManager: AgentActor = { ...MANAGER, id: ENGINEER.id };
    const sameIdentity = reviewEngineeringLoop({
      reviewId: managerReviewId('review-same-identity'),
      loop: completedLoop(),
      release: SEED_RELEASE,
      actor: sameIdentityManager,
      decision: 'accepted',
      summary: 'Attempting to switch roles to review my own work.',
      checksPerformed: ['Reviewed the diff.'],
      reviewedAt: isoDateTime('2026-07-18T20:05:00.000Z'),
    });
    expect(sameIdentity.allowed).toBe(false);
    if (!sameIdentity.allowed) {
      expect(sameIdentity.code).toBe('MANAGER_SEPARATION_REQUIRED');
    }
  });

  it('binds the decision to a frozen snapshot of the exact release candidate', () => {
    const review = managerReview(completedLoop(), 'accepted');

    expect(review.reviewedRelease).toEqual(SEED_RELEASE);
    expect(review.reviewedRelease).not.toBe(SEED_RELEASE);
    expect(Object.isFrozen(review.reviewedRelease)).toBe(true);
    expect(Object.isFrozen(review.reviewedRelease.digests)).toBe(true);

    const wrongLoopRelease = reviewEngineeringLoop({
      reviewId: managerReviewId('review-wrong-loop-release'),
      loop: completedLoop(),
      release: { ...SEED_RELEASE, workItemId: workItemId('work-other') },
      actor: MANAGER,
      decision: 'accepted',
      summary: 'This candidate belongs to another work item.',
      checksPerformed: ['Reviewed the diff.'],
      reviewedAt: isoDateTime('2026-07-18T20:05:00.000Z'),
    });
    expect(wrongLoopRelease.allowed).toBe(false);
    if (!wrongLoopRelease.allowed) {
      expect(wrongLoopRelease.code).toBe('MANAGER_REVIEW_MISMATCH');
    }
  });

  it('lets changes requested reopen at Research but not create a human task', () => {
    const loop = completedLoop();
    const review = managerReview(loop, 'changes_requested');

    const handoff = createHumanProductionCheckTask({
      taskId: productionCheckTaskId('check-rejected-review'),
      release: SEED_RELEASE,
      review,
      actor: MANAGER,
      instructions: 'Please check this unaccepted work.',
      createdAt: isoDateTime('2026-07-18T20:06:00.000Z'),
    });
    expect(handoff.allowed).toBe(false);
    if (!handoff.allowed) {
      expect(handoff.code).toBe('MANAGER_REVIEW_NOT_ACCEPTED');
    }

    const reopened = reopenEngineeringLoopAfterChanges({
      loop,
      review,
      actor: ENGINEER,
      progress: {
        summary: 'Researching the requested timeout coverage.',
        recordedAt: isoDateTime('2026-07-18T20:06:00.000Z'),
      },
    });
    expect(reopened.allowed).toBe(true);
    if (reopened.allowed) {
      expect(reopened.value.stage).toBe('research');
      expect(reopened.value.iteration).toBe(2);
      expect(currentProgress(reopened.value).from).toBe('completed');
    }
  });

  it('does not let a stale changes-requested review reopen an active or later loop', () => {
    const completed = completedLoop();
    const review = managerReview(completed, 'changes_requested');

    const activeAttempt = reopenEngineeringLoopAfterChanges({
      loop: start(),
      review,
      actor: ENGINEER,
      progress: {
        summary: 'Trying to reuse a review while the original iteration is active.',
        recordedAt: isoDateTime('2026-07-18T20:06:00.000Z'),
      },
    });
    expect(activeAttempt.allowed).toBe(false);
    if (!activeAttempt.allowed) {
      expect(activeAttempt.code).toBe('LOOP_NOT_COMPLETE');
    }

    let later = value(
      reopenEngineeringLoopAfterChanges({
        loop: completed,
        review,
        actor: ENGINEER,
        progress: {
          summary: 'Researching the requested changes.',
          recordedAt: isoDateTime('2026-07-18T20:06:00.000Z'),
        },
      }),
    );
    later = advance(later, 'plan', 7);
    later = advance(later, 'execute', 8);
    later = advance(later, 'test', 9);
    later = advance(later, 'completed', 10, 'passed');

    const laterAttempt = reopenEngineeringLoopAfterChanges({
      loop: later,
      review,
      actor: ENGINEER,
      progress: {
        summary: 'Trying to reuse iteration one review against iteration two.',
        recordedAt: isoDateTime('2026-07-18T20:11:00.000Z'),
      },
    });
    expect(laterAttempt.allowed).toBe(false);
    if (!laterAttempt.allowed) {
      expect(laterAttempt.code).toBe('MANAGER_REVIEW_MISMATCH');
    }
  });

  it('creates a release-bound human task only from an accepted manager review', () => {
    const missingReview = createHumanProductionCheckTask({
      taskId: productionCheckTaskId('check-without-review'),
      release: SEED_RELEASE,
      actor: MANAGER,
      instructions: 'Please check this release.',
      createdAt: isoDateTime('2026-07-18T20:06:00.000Z'),
    });
    expect(missingReview.allowed).toBe(false);
    if (!missingReview.allowed) {
      expect(missingReview.code).toBe('MANAGER_REVIEW_REQUIRED');
    }

    const review = managerReview(completedLoop(), 'accepted');
    const handoff = createHumanProductionCheckTask({
      taskId: productionCheckTaskId('check-accepted-review'),
      release: SEED_RELEASE,
      review,
      actor: MANAGER,
      instructions: 'Verify the evidence and rollback plan before production.',
      createdAt: isoDateTime('2026-07-18T20:06:00.000Z'),
    });

    expect(handoff.allowed).toBe(true);
    if (handoff.allowed) {
      expect(handoff.value.releaseId).toBe(SEED_RELEASE.id);
      expect(handoff.value.boundRelease).toEqual(SEED_RELEASE);
      expect(handoff.value.boundRelease).not.toBe(SEED_RELEASE);
      expect(Object.isFrozen(handoff.value.boundRelease)).toBe(true);
      expect(handoff.value.boundDigests).toEqual(SEED_RELEASE.digests);
      expect(handoff.value.managerReviewId).toBe(review.id);
      expect(handoff.value.managerReviewDecision).toBe('accepted');
      expect(handoff.value.checksPerformed).toEqual(review.checksPerformed);
    }
  });

  it('rejects every digest or identity mismatch between review and handoff', () => {
    const review = managerReview(completedLoop(), 'accepted');
    const digestKeys = Object.keys(SEED_RELEASE.digests) as Array<keyof ReleaseDigests>;
    const changedDigestCandidates = digestKeys.map((key): ReleaseCandidate => ({
      ...SEED_RELEASE,
      digests: {
        ...SEED_RELEASE.digests,
        [key]:
          key === 'commit'
            ? gitCommitSha('1111111111111111111111111111111111111111')
            : contentDigest(
                'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
              ),
      },
    }));
    const changedIdentityCandidates: ReleaseCandidate[] = [
      { ...SEED_RELEASE, id: releaseId('release-other') },
      { ...SEED_RELEASE, projectId: projectId('project-other') },
      { ...SEED_RELEASE, workItemId: workItemId('work-other') },
      { ...SEED_RELEASE, version: '2026.07.18-rc.2' },
      {
        ...SEED_RELEASE,
        environment: 'staging' as ReleaseCandidate['environment'],
      },
      { ...SEED_RELEASE, rollbackPlan: 'Use a different rollback plan.' },
      { ...SEED_RELEASE, createdBy: agentId('agent-other-manager') },
      { ...SEED_RELEASE, createdAt: isoDateTime('2026-07-18T19:05:01.000Z') },
    ];

    for (const [index, release] of [
      ...changedDigestCandidates,
      ...changedIdentityCandidates,
    ].entries()) {
      const handoff = createHumanProductionCheckTask({
        taskId: productionCheckTaskId(`check-mismatched-release-${index}`),
        release,
        review,
        actor: MANAGER,
        instructions: 'Attempt a handoff with a candidate the manager did not review.',
        createdAt: isoDateTime('2026-07-18T20:06:00.000Z'),
      });

      expect(handoff.allowed, `candidate ${index}`).toBe(false);
      if (!handoff.allowed) {
        expect(handoff.code, `candidate ${index}`).toBe('MANAGER_REVIEW_MISMATCH');
      }
    }
  });
});
