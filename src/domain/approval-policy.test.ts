import { describe, expect, it } from 'vitest';

import {
  ApprovalPolicyEngine,
  DEPLOYMENT_BROKER,
  canDeployProduction,
  sameReleaseCandidate,
  sameReleaseDigests,
} from './approval-policy';
import {
  SEED_AGENTS,
  SEED_HUMAN,
  SEED_PRODUCTION_CHECK_TASK,
  SEED_RELEASE,
} from './seed';
import {
  agentId,
  approvalId,
  contentDigest,
  gitCommitSha,
  isoDateTime,
  releaseId,
  workItemId,
} from './types';
import type {
  AgentActor,
  Principal,
  ReleaseCandidate,
  ReleaseDigests,
  ServiceActor,
} from './types';

const MANAGER_AGENT = SEED_AGENTS.find((agent) => agent.role === 'manager');
if (!MANAGER_AGENT) {
  throw new Error('Seed data must include a manager.');
}

const MANAGER_ACTOR: AgentActor = {
  kind: 'agent',
  id: MANAGER_AGENT.id,
  name: MANAGER_AGENT.name,
  role: MANAGER_AGENT.role,
};

const ORCHESTRATION_WORKER: ServiceActor = {
  kind: 'service',
  id: 'orchestration-worker',
  name: 'Orchestration worker',
};

function approve(engine: ApprovalPolicyEngine, id = 'approval-release-1') {
  return engine.approve({
    approvalId: approvalId(id),
    release: SEED_RELEASE,
    productionCheckTask: SEED_PRODUCTION_CHECK_TASK,
    actor: SEED_HUMAN,
    approvedAt: isoDateTime('2026-07-18T19:10:00.000Z'),
  });
}

describe('artifact-bound production approval', () => {
  it('allows only a human approver to approve production', () => {
    for (const agent of SEED_AGENTS) {
      const engine = new ApprovalPolicyEngine();
      const denied = engine.approve({
        approvalId: approvalId(`approval-${agent.role}-attempt`),
        release: SEED_RELEASE,
        productionCheckTask: SEED_PRODUCTION_CHECK_TASK,
        actor: {
          kind: 'agent',
          id: agent.id,
          name: agent.name,
          role: agent.role,
        },
        approvedAt: isoDateTime('2026-07-18T19:10:00.000Z'),
      });

      expect(denied.allowed, agent.role).toBe(false);
      if (!denied.allowed) {
        expect(denied.code, agent.role).toBe('AGENT_PRODUCTION_FORBIDDEN');
      }
    }

    const engine = new ApprovalPolicyEngine();
    const approved = approve(engine);
    expect(approved.allowed).toBe(true);
    if (approved.allowed) {
      expect(approved.value.approvedBy).toBe(SEED_HUMAN.id);
      expect(approved.value.boundDigests).toEqual(SEED_RELEASE.digests);
      expect(approved.value.boundRelease).toEqual(SEED_RELEASE);
      expect(Object.isFrozen(approved.value.boundRelease)).toBe(true);
      expect(Object.isFrozen(approved.value.boundRelease.digests)).toBe(true);
    }
  });

  it('treats a change to any bound release digest as stale', () => {
    const digestKeys = Object.keys(SEED_RELEASE.digests) as Array<keyof ReleaseDigests>;

    for (const key of digestKeys) {
      const engine = new ApprovalPolicyEngine();
      const id = approvalId(`approval-stale-${key}`);
      const approved = engine.approve({
        approvalId: id,
        release: SEED_RELEASE,
        productionCheckTask: SEED_PRODUCTION_CHECK_TASK,
        actor: SEED_HUMAN,
        approvedAt: isoDateTime('2026-07-18T19:10:00.000Z'),
      });
      expect(approved.allowed).toBe(true);

      const replacement =
        key === 'commit'
          ? gitCommitSha('1111111111111111111111111111111111111111')
          : contentDigest(
              'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
            );
      const changedRelease: ReleaseCandidate = {
        ...SEED_RELEASE,
        digests: {
          ...SEED_RELEASE.digests,
          [key]: replacement,
        },
      };

      const inspected = engine.inspect(id, changedRelease);
      expect(inspected.allowed, key).toBe(false);
      if (!inspected.allowed) {
        expect(inspected.code, key).toBe('STALE_RELEASE');
      }
    }
  });

  it('treats every non-digest change to the approved candidate as stale', () => {
    const mutations: Array<[string, ReleaseCandidate]> = [
      ['work item', { ...SEED_RELEASE, workItemId: workItemId('work-replaced') }],
      ['version', { ...SEED_RELEASE, version: '2026.07.18-rc.repacked' }],
      ['rollback plan', { ...SEED_RELEASE, rollbackPlan: 'Use a different rollback procedure.' }],
      ['creator', { ...SEED_RELEASE, createdBy: agentId('agent-different-creator') }],
      ['creation time', { ...SEED_RELEASE, createdAt: isoDateTime('2026-07-18T19:05:01.000Z') }],
    ];

    for (const [field, changedRelease] of mutations) {
      const engine = new ApprovalPolicyEngine();
      const id = approvalId(`approval-stale-${field.replaceAll(' ', '-')}`);
      expect(approve(engine, id).allowed).toBe(true);

      const inspected = engine.inspect(id, changedRelease);
      expect(inspected.allowed, field).toBe(false);
      if (!inspected.allowed) {
        expect(inspected.code, field).toBe('STALE_RELEASE');
      }

      const consumed = engine.consume({
        approvalId: id,
        release: changedRelease,
        actor: DEPLOYMENT_BROKER,
        consumedAt: isoDateTime('2026-07-18T19:12:00.000Z'),
      });
      expect(consumed.allowed, `${field} consume`).toBe(false);
      if (!consumed.allowed) {
        expect(consumed.code, `${field} consume`).toBe('STALE_RELEASE');
      }
    }
  });

  it('is one-time and only the deployment broker may consume it', () => {
    const engine = new ApprovalPolicyEngine();
    const id = approvalId('approval-one-time');
    const approved = engine.approve({
      approvalId: id,
      release: SEED_RELEASE,
      productionCheckTask: SEED_PRODUCTION_CHECK_TASK,
      actor: SEED_HUMAN,
      approvedAt: isoDateTime('2026-07-18T19:10:00.000Z'),
    });
    expect(approved.allowed).toBe(true);

    for (const actor of [MANAGER_ACTOR, SEED_HUMAN, ORCHESTRATION_WORKER] satisfies Principal[]) {
      const denied = engine.consume({
        approvalId: id,
        release: SEED_RELEASE,
        actor,
        consumedAt: isoDateTime('2026-07-18T19:12:00.000Z'),
      });
      expect(denied.allowed).toBe(false);
    }

    const consumed = engine.consume({
      approvalId: id,
      release: SEED_RELEASE,
      actor: DEPLOYMENT_BROKER,
      consumedAt: isoDateTime('2026-07-18T19:12:00.000Z'),
    });
    expect(consumed.allowed).toBe(true);
    if (consumed.allowed) {
      expect(consumed.value.status).toBe('consumed');
      expect(consumed.value.version).toBe(2);
    }

    const replay = engine.consume({
      approvalId: id,
      release: SEED_RELEASE,
      actor: DEPLOYMENT_BROKER,
      consumedAt: isoDateTime('2026-07-18T19:13:00.000Z'),
    });
    expect(replay.allowed).toBe(false);
    if (!replay.allowed) {
      expect(replay.code).toBe('APPROVAL_ALREADY_CONSUMED');
    }
  });

  it('does not let any agent or human directly deploy', () => {
    for (const agent of SEED_AGENTS) {
      expect(
        canDeployProduction({
          kind: 'agent',
          id: agent.id,
          name: agent.name,
          role: agent.role,
        }).allowed,
        agent.role,
      ).toBe(false);
    }
    expect(canDeployProduction(SEED_HUMAN).allowed).toBe(false);
    expect(canDeployProduction(ORCHESTRATION_WORKER).allowed).toBe(false);
    expect(canDeployProduction(DEPLOYMENT_BROKER)).toEqual({ allowed: true, value: true });
  });

  it('compares the complete digest set, not object identity', () => {
    expect(sameReleaseDigests(SEED_RELEASE.digests, { ...SEED_RELEASE.digests })).toBe(true);
    expect(sameReleaseCandidate(SEED_RELEASE, {
      ...SEED_RELEASE,
      digests: { ...SEED_RELEASE.digests },
    })).toBe(true);
  });

  it('requires a manager-created human production-check task before approval', () => {
    const engine = new ApprovalPolicyEngine();
    const missingTask = engine.approve({
      approvalId: approvalId('approval-without-task'),
      release: SEED_RELEASE,
      actor: SEED_HUMAN,
      approvedAt: isoDateTime('2026-07-18T19:10:00.000Z'),
    });

    expect(missingTask.allowed).toBe(false);
    if (!missingTask.allowed) {
      expect(missingTask.code).toBe('PRODUCTION_CHECK_TASK_REQUIRED');
    }

    const wrongTask = {
      ...SEED_PRODUCTION_CHECK_TASK,
      releaseId: releaseId('a-different-release'),
    };
    const mismatched = engine.approve({
      approvalId: approvalId('approval-wrong-task'),
      release: SEED_RELEASE,
      productionCheckTask: wrongTask,
      actor: SEED_HUMAN,
      approvedAt: isoDateTime('2026-07-18T19:10:00.000Z'),
    });
    expect(mismatched.allowed).toBe(false);
    if (!mismatched.allowed) {
      expect(mismatched.code).toBe('PRODUCTION_CHECK_TASK_MISMATCH');
    }

    const staleBinding = {
      ...SEED_PRODUCTION_CHECK_TASK,
      boundRelease: {
        ...SEED_RELEASE,
        version: '2026.07.18-rc.stale',
      },
    };
    const staleHandoff = engine.approve({
      approvalId: approvalId('approval-stale-task-binding'),
      release: SEED_RELEASE,
      productionCheckTask: staleBinding,
      actor: SEED_HUMAN,
      approvedAt: isoDateTime('2026-07-18T19:10:00.000Z'),
    });
    expect(staleHandoff.allowed).toBe(false);
    if (!staleHandoff.allowed) {
      expect(staleHandoff.code).toBe('PRODUCTION_CHECK_TASK_MISMATCH');
    }
  });

  it('enforces valid, monotonic timestamps through approval, consumption, and revocation', () => {
    const invalidApprovalTimes = [
      {
        label: 'invalid human approval time',
        release: SEED_RELEASE,
        task: SEED_PRODUCTION_CHECK_TASK,
        approvedAt: isoDateTime('not-a-time'),
      },
      {
        label: 'approval before the production check',
        release: SEED_RELEASE,
        task: SEED_PRODUCTION_CHECK_TASK,
        approvedAt: isoDateTime('2026-07-18T19:05:59.999Z'),
      },
      {
        label: 'production check before release creation',
        release: SEED_RELEASE,
        task: {
          ...SEED_PRODUCTION_CHECK_TASK,
          createdAt: isoDateTime('2026-07-18T19:04:59.999Z'),
        },
        approvedAt: isoDateTime('2026-07-18T19:10:00.000Z'),
      },
    ];

    for (const [index, entry] of invalidApprovalTimes.entries()) {
      const denied = new ApprovalPolicyEngine().approve({
        approvalId: approvalId(`approval-invalid-time-${index}`),
        release: entry.release,
        productionCheckTask: entry.task,
        actor: SEED_HUMAN,
        approvedAt: entry.approvedAt,
      });
      expect(denied.allowed, entry.label).toBe(false);
      if (!denied.allowed) {
        expect(denied.code, entry.label).toBe('INVALID_APPROVAL_TIMESTAMP');
      }
    }

    const engine = new ApprovalPolicyEngine();
    const id = approvalId('approval-time-ordered');
    expect(approve(engine, id).allowed).toBe(true);

    for (const consumedAt of [
      isoDateTime('not-a-time'),
      isoDateTime('2026-07-18T19:09:59.999Z'),
    ]) {
      const denied = engine.consume({
        approvalId: id,
        release: SEED_RELEASE,
        actor: DEPLOYMENT_BROKER,
        consumedAt,
      });
      expect(denied.allowed).toBe(false);
      if (!denied.allowed) expect(denied.code).toBe('INVALID_APPROVAL_TIMESTAMP');
    }

    for (const revokedAt of [
      isoDateTime('not-a-time'),
      isoDateTime('2026-07-18T19:09:59.999Z'),
    ]) {
      const denied = engine.revoke({
        approvalId: id,
        actor: SEED_HUMAN,
        revokedAt,
      });
      expect(denied.allowed).toBe(false);
      if (!denied.allowed) expect(denied.code).toBe('INVALID_APPROVAL_TIMESTAMP');
    }

    const revoked = engine.revoke({
      approvalId: id,
      actor: SEED_HUMAN,
      revokedAt: isoDateTime('2026-07-18T19:11:00.000Z'),
    });
    expect(revoked.allowed).toBe(true);
    const repeated = engine.revoke({
      approvalId: id,
      actor: SEED_HUMAN,
      revokedAt: isoDateTime('2026-07-18T19:12:00.000Z'),
    });
    expect(repeated.allowed).toBe(false);
    if (!repeated.allowed) expect(repeated.code).toBe('APPROVAL_REVOKED');
  });
});
