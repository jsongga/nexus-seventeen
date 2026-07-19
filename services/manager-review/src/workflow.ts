import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "./canonical.js";
import { ReviewServiceError, corruptStore } from "./errors.js";
import {
  evidenceDigest,
  parseFixedManagerIdentity,
  parseHandoffResult,
  parseIdempotencyKey,
  parseManagerReviewRequest,
  parsePassingEvidenceRequest,
} from "./schema.js";
import { ReviewEventStore } from "./store.js";
import {
  MANAGER_REVIEW_API_VERSION,
  type EngineerFeedback,
  type EvidenceRegisteredEvent,
  type FixedManagerIdentity,
  type ManagerHandoffRegistrar,
  type ManagerReview,
  type ManagerReviewRecordedEvent,
  type PassingEngineerEvidence,
  type PassingEngineerEvidenceRequest,
  type ProductionCheck,
  type RecordManagerReviewRequest,
  type RecordManagerReviewResult,
  type RegisterEvidenceResult,
  type RegisterManagerHandoffRequest,
  type RegisteredManagerHandoff,
  type StoredEvent,
} from "./types.js";

interface IdempotencyRecord {
  readonly requestHash: string;
  readonly event: EvidenceRegisteredEvent | ManagerReviewRecordedEvent;
}

export interface ManagerReviewWorkflowOptions {
  readonly workspaceId: string;
  readonly storePath: string;
  readonly evidenceIssuerPrincipal: string;
  readonly handoffRegistrar: ManagerHandoffRegistrar;
  readonly now?: () => Date;
}

function requestFromEvidence(evidence: PassingEngineerEvidence): PassingEngineerEvidenceRequest {
  return {
    workspaceId: evidence.workspaceId,
    taskId: evidence.taskId,
    completionEventId: evidence.completionEventId,
    engineerAgentId: evidence.engineerAgentId,
    engineerLaneId: evidence.engineerLaneId,
    checkpointRef: evidence.checkpointRef,
    resultOverview: evidence.resultOverview,
    testOutcome: evidence.testOutcome,
    testEvidenceDigest: evidence.testEvidenceDigest,
    releaseArtifactDigest: evidence.releaseArtifactDigest,
    releaseManifestDigest: evidence.releaseManifestDigest,
    targetEnvironment: evidence.targetEnvironment,
    completedAt: evidence.completedAt,
  };
}

function requestFromReview(review: ManagerReview): RecordManagerReviewRequest {
  return {
    evidenceDigest: review.evidenceDigest,
    decision: review.decision,
    summary: review.summary,
    remainingRisks: review.remainingRisks,
  };
}

function reviewIdentity(review: ManagerReview): FixedManagerIdentity {
  return {
    workspaceId: review.workspaceId,
    agentId: review.managerAgentId,
    laneId: review.managerLaneId,
    role: "manager",
  };
}

function exactNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error("MANAGER_REVIEW_CLOCK_INVALID");
  return value;
}

function handoffRequest(evidence: PassingEngineerEvidence, review: ManagerReview): RegisterManagerHandoffRequest {
  return Object.freeze({
    workspaceId: evidence.workspaceId,
    taskId: evidence.taskId,
    releaseArtifactDigest: evidence.releaseArtifactDigest,
    releaseManifestDigest: evidence.releaseManifestDigest,
    targetEnvironment: evidence.targetEnvironment,
    managerAgentId: review.managerAgentId,
    managerReviewId: review.managerReviewId,
    reviewedAt: review.reviewedAt,
  });
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export class ManagerReviewWorkflow {
  readonly #workspaceId: string;
  readonly #issuer: string;
  readonly #registrar: ManagerHandoffRegistrar;
  readonly #now: () => Date;
  readonly #store: ReviewEventStore;
  readonly #evidence = new Map<string, PassingEngineerEvidence>();
  readonly #completionEvents = new Map<string, string>();
  readonly #reviews = new Map<string, ManagerReview>();
  readonly #reviewByEvidence = new Map<string, string>();
  readonly #handoffs = new Map<string, RegisteredManagerHandoff>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #deliveries = new Map<string, Promise<void>>();
  #tail: Promise<void> = Promise.resolve();

  private constructor(options: ManagerReviewWorkflowOptions, store: ReviewEventStore) {
    this.#workspaceId = options.workspaceId;
    this.#issuer = options.evidenceIssuerPrincipal;
    this.#registrar = options.handoffRegistrar;
    this.#now = options.now ?? (() => new Date());
    this.#store = store;
    this.#restore(store.records);
  }

  static async open(options: ManagerReviewWorkflowOptions): Promise<ManagerReviewWorkflow> {
    const workspace = parsePassingEvidenceRequest({
      workspaceId: options.workspaceId,
      taskId: "configuration-check",
      completionEventId: "configuration-check",
      engineerAgentId: "configuration-engineer",
      engineerLaneId: "configuration-lane",
      checkpointRef: null,
      resultOverview: "Configuration validation only.",
      testOutcome: "passed",
      testEvidenceDigest: `sha256:${"0".repeat(64)}`,
      releaseArtifactDigest: `sha256:${"0".repeat(64)}`,
      releaseManifestDigest: `sha256:${"0".repeat(64)}`,
      targetEnvironment: "configuration",
      completedAt: "2020-01-01T00:00:00.000Z",
    }).workspaceId;
    if (
      options.evidenceIssuerPrincipal.length < 1 ||
      options.evidenceIssuerPrincipal.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(options.evidenceIssuerPrincipal)
    ) {
      throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Evidence issuer principal is invalid");
    }
    const store = await ReviewEventStore.open(options.storePath);
    try {
      return new ManagerReviewWorkflow({ ...options, workspaceId: workspace }, store);
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  async registerEvidence(request: unknown, idempotencyKey: string): Promise<RegisterEvidenceResult> {
    const parsed = parsePassingEvidenceRequest(request);
    const key = parseIdempotencyKey(idempotencyKey);
    if (parsed.workspaceId !== this.#workspaceId) {
      throw new ReviewServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace is not served here");
    }
    const completed = Date.parse(parsed.completedAt);
    if (completed > exactNow(this.#now).valueOf() + 60_000) {
      throw new ReviewServiceError(400, "EVIDENCE_TIME_INVALID", "Engineer completion time is in the future");
    }
    const requestHash = sha256({ action: "register_evidence", request: parsed });
    const scope = `evidence:${this.#issuer}`;
    return this.#serialize(async () => {
      const duplicate = this.#idempotencyResult(scope, key, requestHash);
      if (duplicate !== undefined) {
        if (duplicate.eventType !== "evidence_registered") throw corruptStore("evidence idempotency resolved incorrectly");
        return { evidence: duplicate.evidence, duplicate: true };
      }
      if (this.#completionEvents.has(parsed.completionEventId)) {
        throw new ReviewServiceError(409, "COMPLETION_ALREADY_REGISTERED", "Completion evidence is already registered");
      }
      const registeredAt = exactNow(this.#now).toISOString();
      const evidence: PassingEngineerEvidence = Object.freeze({
        apiVersion: MANAGER_REVIEW_API_VERSION,
        evidenceId: randomUUID(),
        evidenceDigest: evidenceDigest(parsed),
        registeredBy: this.#issuer,
        registeredAt,
        ...parsed,
      });
      const event = await this.#store.append({
        eventId: randomUUID(),
        eventType: "evidence_registered",
        occurredAt: registeredAt,
        idempotencyScope: scope,
        idempotencyKey: key,
        requestHash,
        evidence,
      });
      if (event.eventType !== "evidence_registered") throw new Error("Unexpected stored event type");
      this.#evidence.set(evidence.evidenceId, evidence);
      this.#completionEvents.set(evidence.completionEventId, evidence.evidenceId);
      this.#idempotency.set(`${scope}\u0000${key}`, { requestHash, event });
      return { evidence, duplicate: false };
    });
  }

  listManagerQueue(managerInput: FixedManagerIdentity): readonly PassingEngineerEvidence[] {
    const manager = parseFixedManagerIdentity(managerInput);
    this.#assertManagerWorkspace(manager);
    return Object.freeze(
      [...this.#evidence.values()]
        .filter((evidence) => !this.#reviewByEvidence.has(evidence.evidenceId))
        .sort((left, right) => left.registeredAt.localeCompare(right.registeredAt)),
    );
  }

  async recordManagerReview(
    evidenceId: string,
    request: unknown,
    managerInput: FixedManagerIdentity,
    idempotencyKey: string,
  ): Promise<RecordManagerReviewResult> {
    const manager = parseFixedManagerIdentity(managerInput);
    this.#assertManagerWorkspace(manager);
    const parsed = parseManagerReviewRequest(request);
    const key = parseIdempotencyKey(idempotencyKey);
    const requestHash = sha256({ action: "record_manager_review", evidenceId, manager, request: parsed });
    const scope = `manager:${manager.agentId}:${manager.laneId}:review`;
    const result = await this.#serialize(async (): Promise<RecordManagerReviewResult> => {
      const duplicate = this.#idempotencyResult(scope, key, requestHash);
      if (duplicate !== undefined) {
        if (duplicate.eventType !== "manager_review_recorded") throw corruptStore("review idempotency resolved incorrectly");
        return {
          review: duplicate.review,
          productionCheck: duplicate.review.decision === "accepted" ? this.#productionCheck(duplicate.review) : null,
          duplicate: true,
        };
      }
      const evidence = this.#evidence.get(evidenceId);
      if (!evidence) throw new ReviewServiceError(404, "EVIDENCE_NOT_FOUND", "Passing evidence was not found");
      if (parsed.evidenceDigest !== evidence.evidenceDigest) {
        throw new ReviewServiceError(409, "EVIDENCE_DIGEST_MISMATCH", "Review does not bind the current immutable evidence");
      }
      if (manager.agentId === evidence.engineerAgentId) {
        throw new ReviewServiceError(403, "SELF_REVIEW_FORBIDDEN", "The engineer cannot review their own passing evidence");
      }
      if (this.#reviewByEvidence.has(evidenceId)) {
        throw new ReviewServiceError(409, "EVIDENCE_ALREADY_REVIEWED", "Passing evidence already has a manager review");
      }
      const reviewedAt = exactNow(this.#now).toISOString();
      const review: ManagerReview = Object.freeze({
        apiVersion: MANAGER_REVIEW_API_VERSION,
        managerReviewId: randomUUID(),
        evidenceId,
        evidenceDigest: evidence.evidenceDigest,
        workspaceId: evidence.workspaceId,
        taskId: evidence.taskId,
        engineerAgentId: evidence.engineerAgentId,
        managerAgentId: manager.agentId,
        managerLaneId: manager.laneId,
        decision: parsed.decision,
        summary: parsed.summary,
        remainingRisks: parsed.remainingRisks,
        reviewedAt,
      });
      const event = await this.#store.append({
        eventId: randomUUID(),
        eventType: "manager_review_recorded",
        occurredAt: reviewedAt,
        idempotencyScope: scope,
        idempotencyKey: key,
        requestHash,
        review,
      });
      if (event.eventType !== "manager_review_recorded") throw new Error("Unexpected stored event type");
      this.#reviews.set(review.managerReviewId, review);
      this.#reviewByEvidence.set(evidenceId, review.managerReviewId);
      this.#idempotency.set(`${scope}\u0000${key}`, { requestHash, event });
      return {
        review,
        productionCheck: review.decision === "accepted" ? this.#productionCheck(review) : null,
        duplicate: false,
      };
    });
    if (result.review.decision === "accepted") {
      await this.#deliverReview(result.review.managerReviewId).catch(() => undefined);
      return { ...result, productionCheck: this.#productionCheck(result.review) };
    }
    return result;
  }

  listProductionChecks(workspaceId: string): readonly ProductionCheck[] {
    if (workspaceId !== this.#workspaceId) {
      throw new ReviewServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace is not served here");
    }
    return Object.freeze(
      [...this.#reviews.values()]
        .filter((review) => review.decision === "accepted")
        .map((review) => this.#productionCheck(review))
        .sort((left, right) => left.reviewedAt.localeCompare(right.reviewedAt)),
    );
  }

  listEngineerFeedback(workspaceId: string): readonly EngineerFeedback[] {
    if (workspaceId !== this.#workspaceId) {
      throw new ReviewServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace is not served here");
    }
    return Object.freeze(
      [...this.#reviews.values()]
        .filter((review) => review.decision === "changes_requested")
        .map((review) => {
          const evidence = this.#evidence.get(review.evidenceId);
          if (!evidence) throw corruptStore("manager feedback has no passing evidence");
          return Object.freeze({
            apiVersion: MANAGER_REVIEW_API_VERSION,
            feedbackId: `engineer-feedback:${review.managerReviewId}`,
            status: "changes_requested" as const,
            workspaceId: evidence.workspaceId,
            taskId: evidence.taskId,
            evidenceId: evidence.evidenceId,
            evidenceDigest: evidence.evidenceDigest,
            completionEventId: evidence.completionEventId,
            checkpointRef: evidence.checkpointRef,
            engineerAgentId: evidence.engineerAgentId,
            engineerLaneId: evidence.engineerLaneId,
            managerAgentId: review.managerAgentId,
            managerReviewId: review.managerReviewId,
            resultOverview: evidence.resultOverview,
            reviewSummary: review.summary,
            remainingRisks: review.remainingRisks,
            completedAt: evidence.completedAt,
            reviewedAt: review.reviewedAt,
          });
        })
        .sort((left, right) => left.reviewedAt.localeCompare(right.reviewedAt)),
    );
  }

  async deliverPendingHandoffs(): Promise<void> {
    for (const review of this.#reviews.values()) {
      if (review.decision === "accepted" && !this.#handoffs.has(review.managerReviewId)) {
        await this.#deliverReview(review.managerReviewId).catch(() => undefined);
      }
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.#deliveries.values());
    await this.#store.close();
  }

  #assertManagerWorkspace(manager: FixedManagerIdentity): void {
    if (manager.workspaceId !== this.#workspaceId) {
      throw new ReviewServiceError(403, "MANAGER_WORKSPACE_MISMATCH", "Manager is not assigned to this workspace");
    }
  }

  #idempotencyResult(scope: string, key: string, requestHash: string): StoredEvent | undefined {
    const existing = this.#idempotency.get(`${scope}\u0000${key}`);
    if (!existing) return undefined;
    if (existing.requestHash !== requestHash) {
      throw new ReviewServiceError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request");
    }
    return existing.event;
  }

  #deliverReview(managerReviewId: string): Promise<void> {
    if (this.#handoffs.has(managerReviewId)) return Promise.resolve();
    const existing = this.#deliveries.get(managerReviewId);
    if (existing) return existing;
    const delivery = this.#performDelivery(managerReviewId).finally(() => {
      this.#deliveries.delete(managerReviewId);
    });
    this.#deliveries.set(managerReviewId, delivery);
    return delivery;
  }

  async #performDelivery(managerReviewId: string): Promise<void> {
    const review = this.#reviews.get(managerReviewId);
    if (!review || review.decision !== "accepted") throw new Error("Accepted manager review was not found");
    const evidence = this.#evidence.get(review.evidenceId);
    if (!evidence) throw corruptStore("accepted review has no evidence");
    const request = handoffRequest(evidence, review);
    const result = parseHandoffResult(
      await this.#registrar.registerManagerHandoff(request, `handoff:${managerReviewId}`),
    );
    if (!same(request, handoffRequest(evidence, {
      ...review,
      managerAgentId: result.handoff.managerAgentId,
      managerReviewId: result.handoff.managerReviewId,
      reviewedAt: result.handoff.reviewedAt,
    })) ||
      result.handoff.workspaceId !== request.workspaceId ||
      result.handoff.taskId !== request.taskId ||
      result.handoff.releaseArtifactDigest !== request.releaseArtifactDigest ||
      result.handoff.releaseManifestDigest !== request.releaseManifestDigest ||
      result.handoff.targetEnvironment !== request.targetEnvironment) {
      throw new ReviewServiceError(502, "INVALID_BROKER_RESPONSE", "Broker handoff does not match the accepted review");
    }
    await this.#serialize(async () => {
      const prior = this.#handoffs.get(managerReviewId);
      if (prior) {
        if (prior.handoffId !== result.handoff.handoffId) throw corruptStore("broker changed a registered handoff");
        return;
      }
      const event = await this.#store.append({
        eventId: randomUUID(),
        eventType: "handoff_registered",
        occurredAt: result.handoff.acceptedAt,
        idempotencyScope: "broker:handoff",
        idempotencyKey: `handoff:${managerReviewId}`,
        requestHash: sha256({ action: "register_manager_handoff", request }),
        managerReviewId,
        handoff: result.handoff,
      });
      if (event.eventType !== "handoff_registered") throw new Error("Unexpected stored event type");
      this.#handoffs.set(managerReviewId, result.handoff);
    });
  }

  #productionCheck(review: ManagerReview): ProductionCheck {
    const evidence = this.#evidence.get(review.evidenceId);
    if (!evidence) throw corruptStore("manager review has no passing evidence");
    const handoff = this.#handoffs.get(review.managerReviewId);
    return Object.freeze({
      apiVersion: MANAGER_REVIEW_API_VERSION,
      productionCheckId: `production-check:${review.managerReviewId}`,
      status: handoff ? "pending_human_review" : "handoff_registration_pending",
      workspaceId: evidence.workspaceId,
      taskId: evidence.taskId,
      evidenceId: evidence.evidenceId,
      evidenceDigest: evidence.evidenceDigest,
      completionEventId: evidence.completionEventId,
      checkpointRef: evidence.checkpointRef,
      engineerAgentId: evidence.engineerAgentId,
      managerAgentId: review.managerAgentId,
      managerReviewId: review.managerReviewId,
      resultOverview: evidence.resultOverview,
      reviewSummary: review.summary,
      remainingRisks: review.remainingRisks,
      testEvidenceDigest: evidence.testEvidenceDigest,
      releaseArtifactDigest: evidence.releaseArtifactDigest,
      releaseManifestDigest: evidence.releaseManifestDigest,
      targetEnvironment: evidence.targetEnvironment,
      completedAt: evidence.completedAt,
      reviewedAt: review.reviewedAt,
      handoffId: handoff?.handoffId ?? null,
      handoffRegisteredAt: handoff?.acceptedAt ?? null,
    });
  }

  #restore(events: readonly StoredEvent[]): void {
    for (const event of events) {
      const scopedKey = `${event.idempotencyScope}\u0000${event.idempotencyKey}`;
      if (event.eventType === "evidence_registered") {
        const request = requestFromEvidence(event.evidence);
        if (
          event.idempotencyScope !== `evidence:${this.#issuer}` ||
          event.occurredAt !== event.evidence.registeredAt ||
          event.evidence.workspaceId !== this.#workspaceId ||
          event.requestHash !== sha256({ action: "register_evidence", request }) ||
          this.#evidence.has(event.evidence.evidenceId) ||
          this.#completionEvents.has(event.evidence.completionEventId)
        ) {
          throw corruptStore("registered evidence semantics are inconsistent");
        }
        this.#evidence.set(event.evidence.evidenceId, event.evidence);
        this.#completionEvents.set(event.evidence.completionEventId, event.evidence.evidenceId);
        this.#idempotency.set(scopedKey, { requestHash: event.requestHash, event });
        continue;
      }
      if (event.eventType === "manager_review_recorded") {
        const evidence = this.#evidence.get(event.review.evidenceId);
        const manager = reviewIdentity(event.review);
        if (
          !evidence ||
          event.occurredAt !== event.review.reviewedAt ||
          event.idempotencyScope !== `manager:${manager.agentId}:${manager.laneId}:review` ||
          event.review.workspaceId !== evidence.workspaceId ||
          event.review.taskId !== evidence.taskId ||
          event.review.evidenceDigest !== evidence.evidenceDigest ||
          event.review.engineerAgentId !== evidence.engineerAgentId ||
          event.review.managerAgentId === evidence.engineerAgentId ||
          event.requestHash !== sha256({
            action: "record_manager_review",
            evidenceId: evidence.evidenceId,
            manager,
            request: requestFromReview(event.review),
          }) ||
          this.#reviewByEvidence.has(evidence.evidenceId) ||
          this.#reviews.has(event.review.managerReviewId)
        ) {
          throw corruptStore("manager review semantics are inconsistent");
        }
        this.#reviews.set(event.review.managerReviewId, event.review);
        this.#reviewByEvidence.set(evidence.evidenceId, event.review.managerReviewId);
        this.#idempotency.set(scopedKey, { requestHash: event.requestHash, event });
        continue;
      }
      const review = this.#reviews.get(event.managerReviewId);
      const evidence = review ? this.#evidence.get(review.evidenceId) : undefined;
      if (!review || review.decision !== "accepted" || !evidence) {
        throw corruptStore("handoff has no accepted review");
      }
      const request = handoffRequest(evidence, review);
      if (
        event.idempotencyScope !== "broker:handoff" ||
        event.idempotencyKey !== `handoff:${review.managerReviewId}` ||
        event.requestHash !== sha256({ action: "register_manager_handoff", request }) ||
        !same(request, {
          workspaceId: event.handoff.workspaceId,
          taskId: event.handoff.taskId,
          releaseArtifactDigest: event.handoff.releaseArtifactDigest,
          releaseManifestDigest: event.handoff.releaseManifestDigest,
          targetEnvironment: event.handoff.targetEnvironment,
          managerAgentId: event.handoff.managerAgentId,
          managerReviewId: event.handoff.managerReviewId,
          reviewedAt: event.handoff.reviewedAt,
        }) ||
        this.#handoffs.has(review.managerReviewId)
      ) {
        throw corruptStore("registered handoff semantics are inconsistent");
      }
      this.#handoffs.set(review.managerReviewId, event.handoff);
    }
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release: (() => void) | undefined;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}
