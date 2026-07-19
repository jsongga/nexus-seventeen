import type {
  AgentId,
  ApprovalId,
  HumanProductionCheckTask,
  HumanActor,
  ISODateTime,
  PolicyDecision,
  PolicyFailureCode,
  Principal,
  ProductionApproval,
  ReleaseCandidate,
  ReleaseDigests,
  ServiceActor,
} from './types';

function allow<Value>(value: Value): PolicyDecision<Value> {
  return { allowed: true, value };
}

function deny<Value>(code: PolicyFailureCode, reason: string): PolicyDecision<Value> {
  return { allowed: false, code, reason };
}

function immutableApproval(approval: ProductionApproval): ProductionApproval {
  return Object.freeze({
    ...approval,
    boundRelease: snapshotReleaseCandidate(approval.boundRelease),
    boundDigests: Object.freeze({ ...approval.boundDigests }),
  });
}

export function snapshotReleaseCandidate(release: ReleaseCandidate): ReleaseCandidate {
  return Object.freeze({
    ...release,
    digests: Object.freeze({ ...release.digests }),
  });
}

export function sameReleaseDigests(left: ReleaseDigests, right: ReleaseDigests): boolean {
  return (
    Object.keys(left).length === 6 &&
    Object.keys(right).length === 6 &&
    left.commit === right.commit &&
    left.artifact === right.artifact &&
    left.build === right.build &&
    left.tests === right.tests &&
    left.configuration === right.configuration &&
    left.migrations === right.migrations
  );
}

/** Compares every field that makes a release candidate the reviewed unit of work. */
export function sameReleaseCandidate(
  left: ReleaseCandidate,
  right: ReleaseCandidate,
): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.workItemId === right.workItemId &&
    left.version === right.version &&
    left.environment === right.environment &&
    left.rollbackPlan === right.rollbackPlan &&
    left.createdBy === right.createdBy &&
    left.createdAt === right.createdAt &&
    sameReleaseDigests(left.digests, right.digests)
  );
}

function validTimestamp(value: ISODateTime): boolean {
  return String(value).trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function validApprovalSequence(input: {
  readonly releaseCreatedAt: ISODateTime;
  readonly productionCheckCreatedAt: ISODateTime;
  readonly approvedAt: ISODateTime;
}): boolean {
  return (
    validTimestamp(input.releaseCreatedAt) &&
    validTimestamp(input.productionCheckCreatedAt) &&
    validTimestamp(input.approvedAt) &&
    Date.parse(input.productionCheckCreatedAt) >= Date.parse(input.releaseCreatedAt) &&
    Date.parse(input.approvedAt) >= Date.parse(input.productionCheckCreatedAt)
  );
}

export function canAssignManager(
  engineerAgentId: AgentId,
  managerAgentId: AgentId,
): PolicyDecision<true> {
  if (engineerAgentId === managerAgentId) {
    return deny(
      'MANAGER_SEPARATION_REQUIRED',
      'The engineer that performed the work cannot independently review it as manager.',
    );
  }

  return allow(true);
}

export function canDeployProduction(actor: Principal): PolicyDecision<true> {
  if (actor.kind === 'agent') {
    return deny(
      'AGENT_PRODUCTION_FORBIDDEN',
      'Agents never receive the capability to deploy production.',
    );
  }

  if (actor.kind !== 'service' || actor.id !== 'deployment-broker') {
    return deny(
      'DEPLOYMENT_BROKER_REQUIRED',
      'Only the deployment broker may execute an approved production deployment.',
    );
  }

  return allow(true);
}

export interface ApproveProductionInput {
  readonly approvalId: ApprovalId;
  readonly release: ReleaseCandidate;
  readonly productionCheckTask?: HumanProductionCheckTask;
  readonly actor: Principal;
  readonly approvedAt: ISODateTime;
}

export interface ConsumeProductionInput {
  readonly approvalId: ApprovalId;
  readonly release: ReleaseCandidate;
  readonly actor: Principal;
  readonly consumedAt: ISODateTime;
}

export interface RevokeProductionInput {
  readonly approvalId: ApprovalId;
  readonly actor: Principal;
  readonly revokedAt: ISODateTime;
}

/**
 * Stateful policy boundary for a local MVP. A durable implementation should
 * persist the same transitions with compare-and-swap on `version` so two
 * deployment workers cannot consume one approval concurrently.
 */
export class ApprovalPolicyEngine {
  readonly #approvals = new Map<ApprovalId, ProductionApproval>();

  constructor(initialApprovals: readonly ProductionApproval[] = []) {
    for (const approval of initialApprovals) {
      this.#approvals.set(approval.id, immutableApproval(approval));
    }
  }

  approve(input: ApproveProductionInput): PolicyDecision<ProductionApproval> {
    const actorCheck = this.#requireHumanApprover(input.actor);
    if (!actorCheck.allowed) {
      return actorCheck;
    }

    if (this.#approvals.has(input.approvalId)) {
      return deny(
        'APPROVAL_ALREADY_EXISTS',
        'Approval identifiers are immutable and cannot be reused.',
      );
    }

    if (!input.productionCheckTask) {
      return deny(
        'PRODUCTION_CHECK_TASK_REQUIRED',
        'Human approval requires a production-check task posted from an accepted manager review.',
      );
    }

    const checkTask = input.productionCheckTask;
    if (
      checkTask.status !== 'awaiting_human_check' ||
      checkTask.managerReviewDecision !== 'accepted' ||
      checkTask.releaseId !== input.release.id ||
      checkTask.projectId !== input.release.projectId ||
      checkTask.workItemId !== input.release.workItemId ||
      !sameReleaseCandidate(checkTask.boundRelease, input.release) ||
      !sameReleaseDigests(checkTask.boundDigests, input.release.digests)
    ) {
      return deny(
        'PRODUCTION_CHECK_TASK_MISMATCH',
        'The human task is not an accepted manager handoff for this exact release candidate.',
      );
    }

    if (
      !validApprovalSequence({
        releaseCreatedAt: input.release.createdAt,
        productionCheckCreatedAt: checkTask.createdAt,
        approvedAt: input.approvedAt,
      })
    ) {
      return deny(
        'INVALID_APPROVAL_TIMESTAMP',
        'The release, production-check task, and human approval require valid timestamps in that order.',
      );
    }

    const approval = immutableApproval({
      id: input.approvalId,
      releaseId: input.release.id,
      projectId: input.release.projectId,
      productionCheckTaskId: checkTask.id,
      boundRelease: input.release,
      boundDigests: input.release.digests,
      status: 'approved',
      approvedBy: actorCheck.value.id,
      approvedAt: input.approvedAt,
      version: 1,
    });

    this.#approvals.set(approval.id, approval);
    return allow(approval);
  }

  inspect(
    approvalId: ApprovalId,
    currentRelease: ReleaseCandidate,
  ): PolicyDecision<ProductionApproval> {
    const approval = this.#approvals.get(approvalId);
    if (!approval) {
      return deny('APPROVAL_NOT_FOUND', 'No human approval exists for this deployment.');
    }

    if (
      approval.releaseId !== currentRelease.id ||
      approval.projectId !== currentRelease.projectId
    ) {
      return deny(
        'RELEASE_MISMATCH',
        'The approval belongs to a different project or release candidate.',
      );
    }

    if (approval.status === 'consumed') {
      return deny(
        'APPROVAL_ALREADY_CONSUMED',
        'Production approvals are one-time authorizations and this one has already been used.',
      );
    }

    if (approval.status === 'revoked') {
      return deny('APPROVAL_REVOKED', 'The human approver revoked this authorization.');
    }

    if (
      !sameReleaseCandidate(approval.boundRelease, currentRelease) ||
      !sameReleaseDigests(approval.boundDigests, currentRelease.digests)
    ) {
      return deny(
        'STALE_RELEASE',
        'The exact release candidate changed after approval, including its identity, version, provenance, rollback plan, timestamp, or digests.',
      );
    }

    return allow(approval);
  }

  consume(input: ConsumeProductionInput): PolicyDecision<ProductionApproval> {
    const deployCheck = canDeployProduction(input.actor);
    if (!deployCheck.allowed) {
      return deployCheck;
    }

    const inspected = this.inspect(input.approvalId, input.release);
    if (!inspected.allowed) {
      return inspected;
    }


    if (
      !validTimestamp(input.consumedAt) ||
      Date.parse(input.consumedAt) < Date.parse(inspected.value.approvedAt)
    ) {
      return deny(
        'INVALID_APPROVAL_TIMESTAMP',
        'Approval consumption requires a valid timestamp that does not precede human approval.',
      );
    }

    const consumed = immutableApproval({
      ...inspected.value,
      status: 'consumed',
      consumedAt: input.consumedAt,
      consumedBy: 'deployment-broker',
      version: inspected.value.version + 1,
    });

    this.#approvals.set(consumed.id, consumed);
    return allow(consumed);
  }

  revoke(input: RevokeProductionInput): PolicyDecision<ProductionApproval> {
    const actorCheck = this.#requireHumanApprover(input.actor);
    if (!actorCheck.allowed) {
      return actorCheck;
    }

    const existing = this.#approvals.get(input.approvalId);
    if (!existing) {
      return deny('APPROVAL_NOT_FOUND', 'No human approval exists to revoke.');
    }

    if (existing.status === 'consumed') {
      return deny(
        'APPROVAL_ALREADY_CONSUMED',
        'A consumed deployment authorization cannot be revoked retroactively.',
      );
    }

    if (existing.status === 'revoked') {
      return deny('APPROVAL_REVOKED', 'The human approver already revoked this authorization.');
    }

    if (
      !validTimestamp(input.revokedAt) ||
      Date.parse(input.revokedAt) < Date.parse(existing.approvedAt)
    ) {
      return deny(
        'INVALID_APPROVAL_TIMESTAMP',
        'Approval revocation requires a valid timestamp that does not precede human approval.',
      );
    }

    const revoked = immutableApproval({
      ...existing,
      status: 'revoked',
      revokedAt: input.revokedAt,
      version: existing.version + 1,
    });

    this.#approvals.set(revoked.id, revoked);
    return allow(revoked);
  }

  getApproval(approvalId: ApprovalId): ProductionApproval | undefined {
    return this.#approvals.get(approvalId);
  }

  listApprovals(): readonly ProductionApproval[] {
    return [...this.#approvals.values()];
  }

  #requireHumanApprover(actor: Principal): PolicyDecision<HumanActor> {
    if (actor.kind === 'agent') {
      return deny(
        'AGENT_PRODUCTION_FORBIDDEN',
        'An agent may request review, but may never approve production.',
      );
    }

    if (
      actor.kind !== 'human' ||
      actor.role !== 'human_approver' ||
      actor.authenticated !== true
    ) {
      return deny(
        'HUMAN_APPROVER_REQUIRED',
        'Production approval requires an authenticated human approver.',
      );
    }

    return allow(actor);
  }
}

export const DEPLOYMENT_BROKER: ServiceActor = Object.freeze({
  kind: 'service',
  id: 'deployment-broker',
  name: 'Deployment broker',
});
