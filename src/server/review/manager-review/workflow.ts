import { randomUUID } from "node:crypto";
import {
  parseManagerReviewPermitConsumeReceipt,
  parseManagerReviewPermitConsumeRequest,
  STEWARD_RUNTIME_API_VERSION,
  type ManagerReviewPermitConsumeReceipt,
  type ManagerReviewPermitConsumeRequest,
} from "#shared/protocol";
import { canonicalJson, sha256 } from "./canonical.js";
import { ReviewServiceError, corruptStore } from "./errors.js";
import {
  evidenceDigest,
  parseHandoffResult,
  parseIdempotencyKey,
  parseManagerRuntimeClaim,
  parseManagerReviewRequest,
  parsePassingEvidenceRequest,
} from "./schema.js";
import { ReviewEventStore } from "./store.js";
import {
  MANAGER_REVIEW_API_VERSION,
  MANAGER_REVIEW_AUTHORIZATION_VERSION,
  type EngineerFeedback,
  type EvidenceRegisteredEvent,
  type FixedManagerIdentity,
  type ManagerHandoffRegistrar,
  type ManagerReview,
  type ManagerReviewIntent,
  type ManagerReviewIntentRecordedEvent,
  type ManagerReviewPermitConsumer,
  type ManagerReviewRecordedEvent,
  type ManagerRuntimeAuthorizer,
  type ManagerRuntimeClaim,
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

interface ReviewIntentRecord {
  readonly event: ManagerReviewIntentRecordedEvent;
  readonly reviewScope: string;
}

export interface ManagerReviewWorkflowOptions {
  readonly workspaceId: string;
  readonly storePath: string;
  readonly evidenceIssuerPrincipal: string;
  readonly handoffRegistrar: ManagerHandoffRegistrar;
  readonly managerRuntimeAuthorizer: ManagerRuntimeAuthorizer;
  readonly managerReviewPermitConsumer: ManagerReviewPermitConsumer;
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
    reviewTaskId: review.reviewTaskId,
    evidenceDigest: review.evidenceDigest,
    decision: review.decision,
    summary: review.summary,
    remainingRisks: review.remainingRisks,
  };
}

function reviewRuntimeClaim(review: ManagerReview): ManagerRuntimeClaim {
  return {
    workspaceId: review.workspaceId,
    agentId: review.managerAgentId,
    laneId: review.managerLaneId,
    role: "manager",
    runtimeInstanceId: review.managerRuntimeInstanceId,
    runtimeEpoch: review.managerRuntimeEpoch,
  };
}

function reviewRequestIdentity(manager: ManagerRuntimeClaim): FixedManagerIdentity {
  return {
    workspaceId: manager.workspaceId,
    agentId: manager.agentId,
    laneId: manager.laneId,
    role: "manager",
  };
}

function managerReviewScope(manager: FixedManagerIdentity): string {
  return `manager:${manager.agentId}:${manager.laneId}:review`;
}

function managerReviewIntentScope(manager: FixedManagerIdentity): string {
  return `${managerReviewScope(manager)}-intent`;
}

function logicalReviewRequest(
  evidenceId: string,
  manager: ManagerRuntimeClaim,
  request: RecordManagerReviewRequest,
): Record<string, unknown> {
  return {
    action: "record_manager_review",
    evidenceId,
    manager: reviewRequestIdentity(manager),
    request,
  };
}

function permitRequest(
  evidence: PassingEngineerEvidence,
  manager: ManagerRuntimeClaim,
  request: RecordManagerReviewRequest,
  scope: string,
  idempotencyKey: string,
  requestHash: string,
): ManagerReviewPermitConsumeRequest {
  return parseManagerReviewPermitConsumeRequest({
    apiVersion: STEWARD_RUNTIME_API_VERSION,
    operationId: `manager-review:${sha256({ scope, idempotencyKey, requestHash })}`,
    workspaceId: evidence.workspaceId,
    reviewTaskId: request.reviewTaskId,
    sourceTaskId: evidence.taskId,
    evidenceId: evidence.evidenceId,
    evidenceDigest: evidence.evidenceDigest,
    managerAgentId: manager.agentId,
    managerLaneId: manager.laneId,
    runtimeInstanceId: manager.runtimeInstanceId,
    runtimeEpoch: manager.runtimeEpoch,
    reviewRequestDigest: `sha256:${requestHash}`,
  });
}

function checkedPermitReceipt(
  value: unknown,
  request: ManagerReviewPermitConsumeRequest,
): ManagerReviewPermitConsumeReceipt {
  let receipt: ManagerReviewPermitConsumeReceipt;
  try {
    receipt = parseManagerReviewPermitConsumeReceipt(value);
  } catch (error) {
    throw new ReviewServiceError(
      502,
      "INVALID_CONTROL_PLANE_PERMIT_RESPONSE",
      "Control-plane permit consumer returned an invalid receipt",
      { cause: error },
    );
  }
  const stableRequest = {
    operationId: request.operationId,
    workspaceId: request.workspaceId,
    reviewTaskId: request.reviewTaskId,
    sourceTaskId: request.sourceTaskId,
    evidenceId: request.evidenceId,
    evidenceDigest: request.evidenceDigest,
    managerAgentId: request.managerAgentId,
    managerLaneId: request.managerLaneId,
    reviewRequestDigest: request.reviewRequestDigest,
  };
  const stableReceipt = {
    operationId: receipt.operationId,
    workspaceId: receipt.workspaceId,
    reviewTaskId: receipt.reviewTaskId,
    sourceTaskId: receipt.sourceTaskId,
    evidenceId: receipt.evidenceId,
    evidenceDigest: receipt.evidenceDigest,
    managerAgentId: receipt.managerAgentId,
    managerLaneId: receipt.managerLaneId,
    reviewRequestDigest: receipt.reviewRequestDigest,
  };
  if (canonicalJson(stableReceipt) !== canonicalJson(stableRequest)) {
    throw new ReviewServiceError(
      502,
      "INVALID_CONTROL_PLANE_PERMIT_RESPONSE",
      "Control-plane permit receipt changed its stable review binding",
    );
  }
  if (
    receipt.state === "accepted" &&
    (receipt.managerRuntimeInstanceId !== request.runtimeInstanceId ||
      receipt.managerRuntimeEpoch !== request.runtimeEpoch)
  ) {
    throw new ReviewServiceError(
      502,
      "INVALID_CONTROL_PLANE_PERMIT_RESPONSE",
      "New control-plane permit receipt changed its authorizing runtime",
    );
  }
  return receipt;
}

function exactNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error("MANAGER_REVIEW_CLOCK_INVALID");
  return value;
}

function deterministicUuid(namespace: string, identity: string): string {
  const characters = sha256({ namespace, identity }).slice(0, 32).split("");
  characters[12] = "4";
  characters[16] = ((Number.parseInt(characters[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = characters.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function reviewIntentId(operationId: string): string {
  return deterministicUuid("steward-manager-review-intent", operationId);
}

function managerReviewId(permitId: string): string {
  return deterministicUuid("steward-manager-review", permitId);
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
  readonly #runtimeAuthorizer: ManagerRuntimeAuthorizer;
  readonly #permitConsumer: ManagerReviewPermitConsumer;
  readonly #now: () => Date;
  readonly #store: ReviewEventStore;
  readonly #evidence = new Map<string, PassingEngineerEvidence>();
  readonly #completionEvents = new Map<string, string>();
  readonly #reviews = new Map<string, ManagerReview>();
  readonly #reviewByEvidence = new Map<string, string>();
  readonly #reviewByPermit = new Map<string, string>();
  readonly #reviewByPermitSequence = new Map<number, string>();
  readonly #reviewByReviewTask = new Map<string, string>();
  readonly #reviewIntents = new Map<string, ReviewIntentRecord>();
  readonly #intentByEvidence = new Map<string, string>();
  readonly #intentByReviewTask = new Map<string, string>();
  readonly #intentByOperation = new Map<string, string>();
  readonly #handoffs = new Map<string, RegisteredManagerHandoff>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #deliveries = new Map<string, Promise<void>>();
  #tail: Promise<void> = Promise.resolve();

  private constructor(options: ManagerReviewWorkflowOptions, store: ReviewEventStore) {
    this.#workspaceId = options.workspaceId;
    this.#issuer = options.evidenceIssuerPrincipal;
    this.#registrar = options.handoffRegistrar;
    this.#runtimeAuthorizer = options.managerRuntimeAuthorizer;
    this.#permitConsumer = options.managerReviewPermitConsumer;
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
      const workflow = new ManagerReviewWorkflow({ ...options, workspaceId: workspace }, store);
      await workflow.reconcilePendingReviewIntents();
      return workflow;
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

  async listManagerQueue(managerInput: ManagerRuntimeClaim): Promise<readonly PassingEngineerEvidence[]> {
    const manager = parseManagerRuntimeClaim(managerInput);
    this.#assertManagerWorkspace(manager);
    await this.#authorize(manager);
    return Object.freeze(
      [...this.#evidence.values()]
        .filter((evidence) => {
          if (this.#reviewByEvidence.has(evidence.evidenceId)) return false;
          const intentKey = this.#intentByEvidence.get(evidence.evidenceId);
          if (!intentKey) return true;
          const intent = this.#reviewIntents.get(intentKey)?.event.intent;
          if (!intent) throw corruptStore("pending manager review intent cannot be resolved");
          return intent.managerAgentId === manager.agentId && intent.managerLaneId === manager.laneId;
        })
        .sort((left, right) => left.registeredAt.localeCompare(right.registeredAt)),
    );
  }

  async recordManagerReview(
    evidenceId: string,
    request: unknown,
    managerInput: ManagerRuntimeClaim,
    idempotencyKey: string,
  ): Promise<RecordManagerReviewResult> {
    const manager = parseManagerRuntimeClaim(managerInput);
    this.#assertManagerWorkspace(manager);
    const parsed = parseManagerReviewRequest(request);
    const key = parseIdempotencyKey(idempotencyKey);
    // Runtime generation is authorization and audit context, not logical
    // idempotency identity. A replacement process must be able to recover a
    // committed lost response with the same lane, evidence, body, and key.
    const requestHash = sha256(logicalReviewRequest(evidenceId, manager, parsed));
    const scope = managerReviewScope(manager);
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
      const scopedKey = `${scope}\u0000${key}`;
      let intentRecord = this.#reviewIntents.get(scopedKey);
      if (intentRecord) {
        if (intentRecord.event.requestHash !== requestHash) {
          throw new ReviewServiceError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request");
        }
      } else {
        const evidence = this.#evidence.get(evidenceId);
        if (!evidence) throw new ReviewServiceError(404, "EVIDENCE_NOT_FOUND", "Passing evidence was not found");
        if (parsed.evidenceDigest !== evidence.evidenceDigest) {
          throw new ReviewServiceError(409, "EVIDENCE_DIGEST_MISMATCH", "Review does not bind the current immutable evidence");
        }
        if (manager.agentId === evidence.engineerAgentId) {
          throw new ReviewServiceError(403, "SELF_REVIEW_FORBIDDEN", "The engineer cannot review their own passing evidence");
        }
        if (this.#reviewByEvidence.has(evidenceId) || this.#intentByEvidence.has(evidenceId)) {
          throw new ReviewServiceError(409, "EVIDENCE_ALREADY_REVIEWED", "Passing evidence already has a manager review or durable review intent");
        }
        if (this.#reviewByReviewTask.has(parsed.reviewTaskId) || this.#intentByReviewTask.has(parsed.reviewTaskId)) {
          throw new ReviewServiceError(409, "REVIEW_TASK_ALREADY_USED", "Manager review task already authorized another review or durable review intent");
        }
        const consumeRequest = permitRequest(evidence, manager, parsed, scope, key, requestHash);
        const createdAt = exactNow(this.#now).toISOString();
        const intent: ManagerReviewIntent = Object.freeze({
          apiVersion: MANAGER_REVIEW_API_VERSION,
          reviewIntentId: reviewIntentId(consumeRequest.operationId),
          workspaceId: evidence.workspaceId,
          evidenceId: evidence.evidenceId,
          managerAgentId: manager.agentId,
          managerLaneId: manager.laneId,
          initialRuntimeInstanceId: manager.runtimeInstanceId,
          initialRuntimeEpoch: manager.runtimeEpoch,
          operationId: consumeRequest.operationId,
          request: parsed,
          createdAt,
        });
        const event = await this.#store.append({
          eventId: randomUUID(),
          eventType: "manager_review_intent_recorded",
          occurredAt: createdAt,
          idempotencyScope: managerReviewIntentScope(manager),
          idempotencyKey: key,
          requestHash,
          intent,
        });
        if (event.eventType !== "manager_review_intent_recorded") {
          throw new Error("Unexpected stored event type");
        }
        intentRecord = { event, reviewScope: scope };
        this.#indexReviewIntent(intentRecord);
      }
      return this.#consumeAndMaterializeReviewIntent(intentRecord, manager);
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
            reviewTaskId: review.reviewTaskId,
            evidenceId: evidence.evidenceId,
            evidenceDigest: evidence.evidenceDigest,
            completionEventId: evidence.completionEventId,
            checkpointRef: evidence.checkpointRef,
            engineerAgentId: evidence.engineerAgentId,
            engineerLaneId: evidence.engineerLaneId,
            managerAgentId: review.managerAgentId,
            managerRuntimeInstanceId: review.managerRuntimeInstanceId,
            managerRuntimeEpoch: review.managerRuntimeEpoch,
            managerReviewId: review.managerReviewId,
            permitId: review.permitId,
            permitWorkspaceSequence: review.workspaceSequence,
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
    await this.reconcilePendingReviewIntents();
    for (const review of this.#reviews.values()) {
      if (review.decision === "accepted" && !this.#handoffs.has(review.managerReviewId)) {
        await this.#deliverReview(review.managerReviewId).catch(() => undefined);
      }
    }
  }

  async reconcilePendingReviewIntents(): Promise<void> {
    for (const intentRecord of [...this.#reviewIntents.values()]) {
      const scopedKey = `${intentRecord.reviewScope}\u0000${intentRecord.event.idempotencyKey}`;
      if (this.#idempotency.has(scopedKey)) continue;
      let review: ManagerReview | undefined;
      try {
        const result = await this.#serialize(async () => {
          const completed = this.#idempotency.get(scopedKey);
          if (completed) {
            if (completed.event.eventType !== "manager_review_recorded") {
              throw corruptStore("review intent completion resolved incorrectly");
            }
            return completed.event.review;
          }
          const intent = intentRecord.event.intent;
          return (await this.#consumeAndMaterializeReviewIntent(intentRecord, {
            workspaceId: intent.workspaceId,
            agentId: intent.managerAgentId,
            laneId: intent.managerLaneId,
            role: "manager",
            runtimeInstanceId: intent.initialRuntimeInstanceId,
            runtimeEpoch: intent.initialRuntimeEpoch,
          })).review;
        });
        review = result;
      } catch (error) {
        if (error instanceof ReviewServiceError && error.code === "REVIEW_STORE_CORRUPT") throw error;
      }
      if (review?.decision === "accepted") {
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

  #indexReviewIntent(record: ReviewIntentRecord): void {
    const { event } = record;
    const intent = event.intent;
    const scopedKey = `${record.reviewScope}\u0000${event.idempotencyKey}`;
    if (
      this.#reviewIntents.has(scopedKey) ||
      this.#intentByEvidence.has(intent.evidenceId) ||
      this.#intentByReviewTask.has(intent.request.reviewTaskId) ||
      this.#intentByOperation.has(intent.operationId)
    ) {
      throw corruptStore("manager review intent identity is duplicated");
    }
    this.#reviewIntents.set(scopedKey, record);
    this.#intentByEvidence.set(intent.evidenceId, scopedKey);
    this.#intentByReviewTask.set(intent.request.reviewTaskId, scopedKey);
    this.#intentByOperation.set(intent.operationId, scopedKey);
  }

  async #consumeAndMaterializeReviewIntent(
    intentRecord: ReviewIntentRecord,
    manager: ManagerRuntimeClaim,
  ): Promise<RecordManagerReviewResult> {
    const { event } = intentRecord;
    const intent = event.intent;
    const evidence = this.#evidence.get(intent.evidenceId);
    if (!evidence) throw corruptStore("manager review intent has no passing evidence");
    if (
      manager.workspaceId !== intent.workspaceId ||
      manager.agentId !== intent.managerAgentId ||
      manager.laneId !== intent.managerLaneId ||
      manager.role !== "manager"
    ) {
      throw corruptStore("manager review intent runtime identity changed");
    }
    const consumeRequest = permitRequest(
      evidence,
      manager,
      intent.request,
      intentRecord.reviewScope,
      event.idempotencyKey,
      event.requestHash,
    );
    if (consumeRequest.operationId !== intent.operationId) {
      throw corruptStore("manager review intent operation identity changed");
    }
    // The intent above is already fsynced. A crash or lost response after the
    // control-plane commit therefore retries this same operation and receives
    // the original permit audit rather than creating new authority.
    const permit = checkedPermitReceipt(
      await this.#permitConsumer.consumeManagerReviewPermit(consumeRequest),
      consumeRequest,
    );
    if (
      this.#reviewByPermit.has(permit.permitId) ||
      this.#reviewByPermitSequence.has(permit.workspaceSequence)
    ) {
      throw corruptStore("control-plane permit was already materialized by another review");
    }
    const reviewedAt = permit.authorizedAt;
    const review: ManagerReview = Object.freeze({
      apiVersion: MANAGER_REVIEW_API_VERSION,
      authorizationVersion: MANAGER_REVIEW_AUTHORIZATION_VERSION,
      managerReviewId: managerReviewId(permit.permitId),
      reviewTaskId: permit.reviewTaskId,
      evidenceId: intent.evidenceId,
      evidenceDigest: evidence.evidenceDigest,
      workspaceId: evidence.workspaceId,
      taskId: evidence.taskId,
      engineerAgentId: evidence.engineerAgentId,
      managerAgentId: intent.managerAgentId,
      managerLaneId: intent.managerLaneId,
      managerRuntimeInstanceId: permit.managerRuntimeInstanceId,
      managerRuntimeEpoch: permit.managerRuntimeEpoch,
      permitId: permit.permitId,
      authorizedAt: permit.authorizedAt,
      workspaceSequence: permit.workspaceSequence,
      decision: intent.request.decision,
      summary: intent.request.summary,
      remainingRisks: intent.request.remainingRisks,
      reviewedAt,
    });
    if (this.#reviews.has(review.managerReviewId)) {
      throw corruptStore("deterministic manager review identity collided");
    }
    const reviewEvent = await this.#store.append({
      eventId: randomUUID(),
      eventType: "manager_review_recorded",
      occurredAt: reviewedAt,
      idempotencyScope: intentRecord.reviewScope,
      idempotencyKey: event.idempotencyKey,
      requestHash: event.requestHash,
      review,
    });
    if (reviewEvent.eventType !== "manager_review_recorded") {
      throw new Error("Unexpected stored event type");
    }
    this.#reviews.set(review.managerReviewId, review);
    this.#reviewByEvidence.set(intent.evidenceId, review.managerReviewId);
    this.#reviewByPermit.set(review.permitId, review.managerReviewId);
    this.#reviewByPermitSequence.set(review.workspaceSequence, review.managerReviewId);
    this.#reviewByReviewTask.set(review.reviewTaskId, review.managerReviewId);
    this.#idempotency.set(
      `${intentRecord.reviewScope}\u0000${event.idempotencyKey}`,
      { requestHash: event.requestHash, event: reviewEvent },
    );
    return {
      review,
      productionCheck: review.decision === "accepted" ? this.#productionCheck(review) : null,
      duplicate: false,
    };
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
    const idempotencyKey = `handoff:permit:${review.permitId}`;
    const result = parseHandoffResult(
      await this.#registrar.registerManagerHandoff(request, idempotencyKey),
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
        idempotencyKey,
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
      reviewTaskId: review.reviewTaskId,
      evidenceId: evidence.evidenceId,
      evidenceDigest: evidence.evidenceDigest,
      completionEventId: evidence.completionEventId,
      checkpointRef: evidence.checkpointRef,
      engineerAgentId: evidence.engineerAgentId,
      managerAgentId: review.managerAgentId,
      managerRuntimeInstanceId: review.managerRuntimeInstanceId,
      managerRuntimeEpoch: review.managerRuntimeEpoch,
      managerReviewId: review.managerReviewId,
      permitId: review.permitId,
      permitWorkspaceSequence: review.workspaceSequence,
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
      if (event.eventType === "manager_review_intent_recorded") {
        const intent = event.intent;
        const evidence = this.#evidence.get(intent.evidenceId);
        const manager: ManagerRuntimeClaim = {
          workspaceId: intent.workspaceId,
          agentId: intent.managerAgentId,
          laneId: intent.managerLaneId,
          role: "manager",
          runtimeInstanceId: intent.initialRuntimeInstanceId,
          runtimeEpoch: intent.initialRuntimeEpoch,
        };
        const reviewScope = managerReviewScope(manager);
        const expectedPermitRequest = evidence
          ? permitRequest(
              evidence,
              manager,
              intent.request,
              reviewScope,
              event.idempotencyKey,
              event.requestHash,
            )
          : undefined;
        if (
          !evidence ||
          event.idempotencyScope !== managerReviewIntentScope(manager) ||
          event.occurredAt !== intent.createdAt ||
          intent.workspaceId !== this.#workspaceId ||
          intent.request.evidenceDigest !== evidence.evidenceDigest ||
          intent.managerAgentId === evidence.engineerAgentId ||
          event.requestHash !== sha256(logicalReviewRequest(
            evidence.evidenceId,
            manager,
            intent.request,
          )) ||
          expectedPermitRequest?.operationId !== intent.operationId ||
          intent.reviewIntentId !== reviewIntentId(intent.operationId)
        ) {
          throw corruptStore("manager review intent semantics are inconsistent");
        }
        this.#indexReviewIntent({ event, reviewScope });
        continue;
      }
      if (event.eventType === "manager_review_recorded") {
        const evidence = this.#evidence.get(event.review.evidenceId);
        const manager = reviewRuntimeClaim(event.review);
        const intentRecord = this.#reviewIntents.get(
          `${event.idempotencyScope}\u0000${event.idempotencyKey}`,
        );
        const intent = intentRecord?.event.intent;
        if (
          !evidence ||
          !intentRecord ||
          !intent ||
          event.occurredAt !== event.review.reviewedAt ||
          event.idempotencyScope !== `manager:${manager.agentId}:${manager.laneId}:review` ||
          intentRecord.reviewScope !== event.idempotencyScope ||
          intent.evidenceId !== evidence.evidenceId ||
          intent.managerAgentId !== event.review.managerAgentId ||
          intent.managerLaneId !== event.review.managerLaneId ||
          !same(intent.request, requestFromReview(event.review)) ||
          event.review.workspaceId !== evidence.workspaceId ||
          event.review.taskId !== evidence.taskId ||
          event.review.evidenceDigest !== evidence.evidenceDigest ||
          event.review.engineerAgentId !== evidence.engineerAgentId ||
          event.review.managerAgentId === evidence.engineerAgentId ||
          event.review.authorizedAt !== event.review.reviewedAt ||
          event.review.managerReviewId !== managerReviewId(event.review.permitId) ||
          event.requestHash !== sha256(logicalReviewRequest(
            evidence.evidenceId,
            manager,
            requestFromReview(event.review),
          )) ||
          this.#reviewByEvidence.has(evidence.evidenceId) ||
          this.#reviewByPermit.has(event.review.permitId) ||
          this.#reviewByPermitSequence.has(event.review.workspaceSequence) ||
          this.#reviewByReviewTask.has(event.review.reviewTaskId) ||
          this.#reviews.has(event.review.managerReviewId)
        ) {
          throw corruptStore("manager review semantics are inconsistent");
        }
        this.#reviews.set(event.review.managerReviewId, event.review);
        this.#reviewByEvidence.set(evidence.evidenceId, event.review.managerReviewId);
        this.#reviewByPermit.set(event.review.permitId, event.review.managerReviewId);
        this.#reviewByPermitSequence.set(event.review.workspaceSequence, event.review.managerReviewId);
        this.#reviewByReviewTask.set(event.review.reviewTaskId, event.review.managerReviewId);
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
        event.idempotencyKey !== `handoff:permit:${review.permitId}` ||
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

  async #authorize(manager: ManagerRuntimeClaim): Promise<void> {
    // Queue discovery is advisory and remains protected by a fresh read-only
    // snapshot. Every write separately consumes an atomic task-scoped permit.
    await this.#runtimeAuthorizer.authorizeManagerRuntime(manager);
  }
}
