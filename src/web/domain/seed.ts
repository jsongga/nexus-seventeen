import {
  agentId,
  contentDigest,
  gitCommitSha,
  isoDateTime,
  managerReviewId,
  projectId,
  productionCheckTaskId,
  releaseId,
  userId,
  workItemId,
} from './types';
import type {
  AgentProfile,
  HumanActor,
  HumanProductionCheckTask,
  Project,
  ReleaseCandidate,
  WorkItem,
} from './types';

export const SEED_HUMAN: HumanActor = Object.freeze({
  kind: 'human',
  id: userId('user-jordan-lee'),
  name: 'Jordan Lee',
  role: 'human_approver',
  authenticated: true,
});

export const SEED_PROJECT: Project = Object.freeze({
  id: projectId('project-northstar-checkout'),
  name: 'Northstar Checkout',
  repository: 'acme/northstar-checkout',
  defaultBranch: 'main',
  developmentEnvironment: 'Isolated Docker worktree',
  productionEnvironment: 'Production — us-west-2',
  tokenBudget: 2_000_000,
});

export const SEED_AGENTS: readonly AgentProfile[] = Object.freeze([
  Object.freeze({
    id: agentId('agent-vale-manager'),
    name: 'Vale',
    role: 'manager',
    providerPreference: 'anthropic',
    status: 'idle',
    monthlyTokenBudget: 500_000,
    avatarInitials: 'MM',
  }),
  Object.freeze({
    id: agentId('agent-patch-engineer'),
    name: 'Patch',
    role: 'engineer',
    providerPreference: 'openai',
    status: 'working',
    monthlyTokenBudget: 1_000_000,
    avatarInitials: 'PE',
  }),
  Object.freeze({
    id: agentId('agent-gauge-verifier'),
    name: 'Gauge',
    role: 'verifier',
    providerPreference: 'openai',
    status: 'working',
    monthlyTokenBudget: 500_000,
    avatarInitials: 'GV',
  }),
] satisfies readonly AgentProfile[]);

function immutableWorkItem(workItem: WorkItem): WorkItem {
  return Object.freeze({
    ...workItem,
    acceptanceCriteria: Object.freeze([...workItem.acceptanceCriteria]),
    assignments: Object.freeze({ ...workItem.assignments }),
  });
}

export const SEED_WORK_ITEMS: readonly WorkItem[] = Object.freeze([
  immutableWorkItem({
    id: workItemId('work-142'),
    projectId: SEED_PROJECT.id,
    title: 'Recover interrupted payment confirmations',
    goal: 'Make checkout retries idempotent without duplicating charges.',
    acceptanceCriteria: [
      'Repeated confirmation requests return the original payment result.',
      'Integration tests cover timeout and retry paths.',
      'No production credentials appear in the development run.',
    ],
    risk: 'medium',
    state: 'executing',
    assignments: {
      manager: SEED_AGENTS[0].id,
      engineer: SEED_AGENTS[1].id,
      verifier: SEED_AGENTS[2].id,
    },
    createdAt: isoDateTime('2026-07-18T15:10:00.000Z'),
    updatedAt: isoDateTime('2026-07-18T18:42:00.000Z'),
  }),
  immutableWorkItem({
    id: workItemId('work-143'),
    projectId: SEED_PROJECT.id,
    title: 'Rotate webhook signing and redact run logs',
    goal: 'Ship the new signing path without exposing secrets to agent context or audit output.',
    acceptanceCriteria: [
      'The old and new signatures overlap for one release window.',
      'A canary secret never appears in prompts, logs, or artifacts.',
      'Rollback restores the previous verifier without a database rollback.',
    ],
    risk: 'high',
    state: 'awaiting_production_approval',
    assignments: {
      manager: SEED_AGENTS[0].id,
      engineer: SEED_AGENTS[1].id,
      verifier: SEED_AGENTS[2].id,
    },
    createdAt: isoDateTime('2026-07-17T16:00:00.000Z'),
    updatedAt: isoDateTime('2026-07-18T19:05:00.000Z'),
  }),
  immutableWorkItem({
    id: workItemId('work-144'),
    projectId: SEED_PROJECT.id,
    title: 'Make approval evidence readable on mobile',
    goal: 'Let the human verify a release from a narrow screen without hiding evidence.',
    acceptanceCriteria: [
      'The release digest, checks, risks, and rollback plan fit a 390px viewport.',
      'Approve and reject controls have 44px touch targets.',
    ],
    risk: 'low',
    state: 'ready',
    assignments: {
      manager: SEED_AGENTS[0].id,
      engineer: SEED_AGENTS[1].id,
      verifier: SEED_AGENTS[2].id,
    },
    createdAt: isoDateTime('2026-07-18T17:20:00.000Z'),
    updatedAt: isoDateTime('2026-07-18T17:20:00.000Z'),
  }),
]);

export const SEED_RELEASE: ReleaseCandidate = Object.freeze({
  id: releaseId('release-2026-07-18-1'),
  projectId: SEED_PROJECT.id,
  workItemId: SEED_WORK_ITEMS[1].id,
  version: '2026.07.18-rc.1',
  environment: 'production',
  digests: Object.freeze({
    commit: gitCommitSha('7f83b1657ff1fc53b92dc18148a1d65dfa13514d'),
    artifact: contentDigest(
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ),
    build: contentDigest(
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ),
    tests: contentDigest(
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    ),
    configuration: contentDigest(
      'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    ),
    migrations: contentDigest(
      'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    ),
  }),
  rollbackPlan: 'Restore the previous verifier image and keep both signing keys active.',
  createdBy: SEED_AGENTS[0].id,
  createdAt: isoDateTime('2026-07-18T19:05:00.000Z'),
});

export const SEED_PRODUCTION_CHECK_TASK: HumanProductionCheckTask = Object.freeze({
  id: productionCheckTaskId('production-check-release-2026-07-18-1'),
  releaseId: SEED_RELEASE.id,
  projectId: SEED_RELEASE.projectId,
  workItemId: SEED_RELEASE.workItemId,
  managerReviewId: managerReviewId('manager-review-work-143'),
  managerReviewDecision: 'accepted',
  boundRelease: SEED_RELEASE,
  boundDigests: Object.freeze({ ...SEED_RELEASE.digests }),
  status: 'awaiting_human_check',
  requestedBy: SEED_AGENTS[0].id,
  instructions: 'Confirm the release evidence and rollback plan before authorizing production.',
  managerReviewSummary: 'Acceptance criteria and verifier evidence are satisfied.',
  checksPerformed: Object.freeze([
    'Reviewed the implementation diff and acceptance criteria.',
    'Confirmed the verifier evidence and rollback plan.',
  ]),
  remainingRisks: Object.freeze([
    'Monitor webhook verification errors during the rollout window.',
  ]),
  createdAt: isoDateTime('2026-07-18T19:06:00.000Z'),
});

export const seedData = Object.freeze({
  human: SEED_HUMAN,
  project: SEED_PROJECT,
  agents: SEED_AGENTS,
  workItems: SEED_WORK_ITEMS,
  release: SEED_RELEASE,
  productionCheckTask: SEED_PRODUCTION_CHECK_TASK,
});
