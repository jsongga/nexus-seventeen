import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "./canonical.js";
import type { DeploymentBrokerConfig } from "./config.js";
import { BrokerError, storeCorrupt } from "./errors.js";
import type {
  ConsumeGrantRequest,
  ConsumeGrantResult,
  CreateGrantRequest,
  CreateGrantResult,
  DeploymentAuthorization,
  DeploymentGrant,
  ManagerHandoff,
  RegisterManagerHandoffRequest,
  RegisterManagerHandoffResult,
  StoredEvent,
} from "./types.js";
import { DEPLOYMENT_BROKER_API_VERSION } from "./types.js";
import { DeploymentGrantStore } from "./store.js";
import {
  parseConsumeGrantRequest,
  parseCreateGrantRequest,
  parseIdempotencyKey,
  parseRegisterManagerHandoffRequest,
} from "./schema.js";

interface IdempotencyRecord {
  readonly requestHash: string;
  readonly event: StoredEvent;
}

function bindingOf(value: ConsumeGrantRequest): ConsumeGrantRequest {
  return {
    workspaceId: value.workspaceId,
    taskId: value.taskId,
    releaseArtifactDigest: value.releaseArtifactDigest,
    releaseManifestDigest: value.releaseManifestDigest,
    targetEnvironment: value.targetEnvironment,
  };
}

function sameBinding(left: ConsumeGrantRequest, right: ConsumeGrantRequest): boolean {
  return canonicalJson(bindingOf(left)) === canonicalJson(bindingOf(right));
}

function exactNow(now: () => Date): Date {
  const value = now();
  if (
    !(value instanceof Date) ||
    Number.isNaN(value.valueOf()) ||
    value.getUTCFullYear() < 2020 ||
    value.getUTCFullYear() > 9_999
  ) {
    throw new Error("DEPLOYMENT_BROKER_CLOCK_INVALID");
  }
  return value;
}

export class DeploymentGrantBroker {
  readonly #config: DeploymentBrokerConfig;
  readonly #store: DeploymentGrantStore;
  readonly #handoffs = new Map<string, ManagerHandoff>();
  readonly #managerReviewIds = new Set<string>();
  readonly #handoffGrants = new Map<string, string>();
  readonly #grants = new Map<string, DeploymentGrant>();
  readonly #consumed = new Map<string, DeploymentAuthorization>();
  readonly #authorizationIds = new Set<string>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  #tail: Promise<void> = Promise.resolve();
  #latestTimestamp: string | undefined;

  private constructor(config: DeploymentBrokerConfig, store: DeploymentGrantStore) {
    this.#config = config;
    this.#store = store;
    this.#restore(store.records);
  }

  static async open(config: DeploymentBrokerConfig): Promise<DeploymentGrantBroker> {
    const store = await DeploymentGrantStore.open({ path: config.storePath });
    try {
      return new DeploymentGrantBroker(config, store);
    } catch (error) {
      await store.close().catch(() => undefined);
      throw error;
    }
  }

  #restore(events: readonly StoredEvent[]): void {
    for (const event of events) {
      if (this.#latestTimestamp !== undefined && event.occurredAt < this.#latestTimestamp) {
        throw storeCorrupt("event timestamps move backward");
      }
      const scopedIdempotency = `${event.idempotencyScope}\u0000${event.idempotencyKey}`;
      if (this.#idempotency.has(scopedIdempotency)) throw storeCorrupt("duplicate idempotency record");
      if (event.eventType === "manager_handoff_registered") {
        if (event.idempotencyScope !== "handoff:register" || event.occurredAt !== event.handoff.acceptedAt) {
          throw storeCorrupt("manager handoff metadata is inconsistent");
        }
        if (
          sha256({ action: "register_manager_handoff", request: {
            ...bindingOf(event.handoff),
            managerAgentId: event.handoff.managerAgentId,
            managerReviewId: event.handoff.managerReviewId,
            reviewedAt: event.handoff.reviewedAt,
          } }) !== event.requestHash
        ) {
          throw storeCorrupt("manager handoff request hash is inconsistent");
        }
        if (this.#handoffs.has(event.handoff.handoffId)) throw storeCorrupt("duplicate handoff id");
        if (this.#managerReviewIds.has(event.handoff.managerReviewId)) {
          throw storeCorrupt("manager review was registered more than once");
        }
        this.#handoffs.set(event.handoff.handoffId, event.handoff);
        this.#managerReviewIds.add(event.handoff.managerReviewId);
      } else if (event.eventType === "grant_created") {
        if (event.idempotencyScope !== "human:create" || event.occurredAt !== event.grant.issuedAt) {
          throw storeCorrupt("grant creation metadata is inconsistent");
        }
        const handoff = this.#handoffs.get(event.grant.handoffId);
        if (handoff === undefined) throw storeCorrupt("grant has no accepted manager handoff");
        if (!sameBinding(handoff, event.grant)) throw storeCorrupt("grant does not match its manager handoff");
        if (this.#handoffGrants.has(handoff.handoffId)) throw storeCorrupt("manager handoff authorized multiple grants");
        const expirySeconds = (Date.parse(event.grant.expiresAt) - Date.parse(event.grant.issuedAt)) / 1_000;
        if (
          !Number.isSafeInteger(expirySeconds) ||
          sha256({
            action: "create_grant",
            request: { ...bindingOf(event.grant), handoffId: event.grant.handoffId, expiresInSeconds: expirySeconds },
          }) !== event.requestHash
        ) {
          throw storeCorrupt("grant creation request hash is inconsistent");
        }
        if (this.#grants.has(event.grant.grantId)) throw storeCorrupt("duplicate grant id");
        this.#grants.set(event.grant.grantId, event.grant);
        this.#handoffGrants.set(handoff.handoffId, event.grant.grantId);
      } else {
        if (event.idempotencyScope !== "executor:consume" || event.occurredAt !== event.authorization.consumedAt) {
          throw storeCorrupt("grant consumption metadata is inconsistent");
        }
        const grant = this.#grants.get(event.authorization.grantId);
        if (grant === undefined) throw storeCorrupt("authorization refers to an unknown grant");
        if (this.#consumed.has(grant.grantId)) throw storeCorrupt("grant was consumed more than once");
        if (this.#authorizationIds.has(event.authorization.authorizationId)) {
          throw storeCorrupt("duplicate authorization id");
        }
        if (
          !sameBinding(grant, event.authorization) ||
          event.authorization.issuedBy !== grant.issuedBy ||
          event.authorization.handoffId !== grant.handoffId ||
          event.authorization.issuedAt !== grant.issuedAt ||
          event.authorization.expiresAt !== grant.expiresAt
        ) {
          throw storeCorrupt("authorization does not exactly match its grant");
        }
        if (
          sha256({ action: "consume_grant", grantId: grant.grantId, request: bindingOf(event.authorization) }) !==
          event.requestHash
        ) {
          throw storeCorrupt("grant consumption request hash is inconsistent");
        }
        this.#consumed.set(grant.grantId, event.authorization);
        this.#authorizationIds.add(event.authorization.authorizationId);
      }
      this.#idempotency.set(scopedIdempotency, { requestHash: event.requestHash, event });
      this.#latestTimestamp = event.occurredAt;
    }
  }

  async registerManagerHandoff(
    request: RegisterManagerHandoffRequest,
    idempotencyKey: string,
  ): Promise<RegisterManagerHandoffResult> {
    const parsedRequest = parseRegisterManagerHandoffRequest(request, this.#config);
    const parsedKey = parseIdempotencyKey(idempotencyKey);
    const requestHash = sha256({ action: "register_manager_handoff", request: parsedRequest });
    return this.#serialize(async () => {
      const duplicate = this.#idempotencyResult("handoff:register", parsedKey, requestHash);
      if (duplicate !== undefined) {
        if (duplicate.eventType !== "manager_handoff_registered") {
          throw storeCorrupt("idempotency result has the wrong event type");
        }
        return { handoff: duplicate.handoff, duplicate: true };
      }
      if (this.#managerReviewIds.has(parsedRequest.managerReviewId)) {
        throw new BrokerError(
          409,
          "MANAGER_REVIEW_ALREADY_REGISTERED",
          "Manager review has already been registered as a handoff",
        );
      }
      const accepted = exactNow(this.#config.now);
      this.#assertMonotonic(accepted);
      if (parsedRequest.reviewedAt > accepted.toISOString()) {
        throw new BrokerError(400, "INVALID_REQUEST", "reviewedAt cannot be in the future");
      }
      const handoff: ManagerHandoff = Object.freeze({
        apiVersion: DEPLOYMENT_BROKER_API_VERSION,
        handoffId: randomUUID(),
        status: "accepted",
        ...parsedRequest,
        acceptedBy: this.#config.handoffIssuerPrincipal,
        acceptedAt: accepted.toISOString(),
      });
      const event = await this.#store.append({
        eventId: randomUUID(),
        eventType: "manager_handoff_registered",
        occurredAt: handoff.acceptedAt,
        idempotencyScope: "handoff:register",
        idempotencyKey: parsedKey,
        requestHash,
        handoff,
      });
      this.#handoffs.set(handoff.handoffId, handoff);
      this.#managerReviewIds.add(handoff.managerReviewId);
      this.#idempotency.set(`handoff:register\u0000${parsedKey}`, { requestHash, event });
      this.#latestTimestamp = handoff.acceptedAt;
      return { handoff, duplicate: false };
    });
  }

  async createGrant(request: CreateGrantRequest, idempotencyKey: string): Promise<CreateGrantResult> {
    const parsedRequest = parseCreateGrantRequest(request, this.#config);
    const parsedKey = parseIdempotencyKey(idempotencyKey);
    const requestHash = sha256({ action: "create_grant", request: parsedRequest });
    return this.#serialize(async () => {
      const duplicate = this.#idempotencyResult("human:create", parsedKey, requestHash);
      if (duplicate !== undefined) {
        if (duplicate.eventType !== "grant_created") throw storeCorrupt("idempotency result has the wrong event type");
        return { grant: duplicate.grant, duplicate: true };
      }
      const issued = exactNow(this.#config.now);
      this.#assertMonotonic(issued);
      const handoff = this.#handoffs.get(parsedRequest.handoffId);
      if (handoff === undefined) {
        throw new BrokerError(404, "HANDOFF_NOT_FOUND", "Accepted manager handoff was not found");
      }
      if (!sameBinding(handoff, parsedRequest)) {
        throw new BrokerError(409, "HANDOFF_BINDING_MISMATCH", "Grant does not exactly match the manager handoff");
      }
      if (this.#handoffGrants.has(handoff.handoffId)) {
        throw new BrokerError(409, "HANDOFF_ALREADY_USED", "Manager handoff has already authorized a grant");
      }
      const expiresAtMilliseconds = issued.valueOf() + parsedRequest.expiresInSeconds * 1_000;
      if (!Number.isSafeInteger(expiresAtMilliseconds)) throw new BrokerError(400, "INVALID_REQUEST", "Expiry is invalid");
      const grant: DeploymentGrant = Object.freeze({
        apiVersion: DEPLOYMENT_BROKER_API_VERSION,
        grantId: randomUUID(),
        ...bindingOf(parsedRequest),
        handoffId: handoff.handoffId,
        issuedBy: this.#config.humanPrincipal,
        issuedAt: issued.toISOString(),
        expiresAt: new Date(expiresAtMilliseconds).toISOString(),
      });
      const event = await this.#store.append({
        eventId: randomUUID(),
        eventType: "grant_created",
        occurredAt: grant.issuedAt,
        idempotencyScope: "human:create",
        idempotencyKey: parsedKey,
        requestHash,
        grant,
      });
      this.#grants.set(grant.grantId, grant);
      this.#handoffGrants.set(handoff.handoffId, grant.grantId);
      this.#idempotency.set(`human:create\u0000${parsedKey}`, { requestHash, event });
      this.#latestTimestamp = grant.issuedAt;
      return { grant, duplicate: false };
    });
  }

  async consumeGrant(
    grantId: string,
    request: ConsumeGrantRequest,
    idempotencyKey: string,
  ): Promise<ConsumeGrantResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(grantId)) {
      throw new BrokerError(404, "GRANT_NOT_FOUND", "Deployment grant was not found");
    }
    const parsedRequest = parseConsumeGrantRequest(request, this.#config);
    const parsedKey = parseIdempotencyKey(idempotencyKey);
    const requestHash = sha256({ action: "consume_grant", grantId, request: parsedRequest });
    return this.#serialize(async () => {
      const duplicate = this.#idempotencyResult("executor:consume", parsedKey, requestHash);
      if (duplicate !== undefined) {
        if (duplicate.eventType !== "grant_consumed") throw storeCorrupt("idempotency result has the wrong event type");
        return { authorization: duplicate.authorization, duplicate: true };
      }
      const grant = this.#grants.get(grantId);
      if (grant === undefined) throw new BrokerError(404, "GRANT_NOT_FOUND", "Deployment grant was not found");
      if (this.#consumed.has(grantId)) {
        throw new BrokerError(409, "GRANT_ALREADY_CONSUMED", "Deployment grant has already been consumed");
      }
      if (!sameBinding(grant, parsedRequest)) {
        throw new BrokerError(409, "GRANT_BINDING_MISMATCH", "Claim does not exactly match the deployment grant");
      }
      const consumed = exactNow(this.#config.now);
      this.#assertMonotonic(consumed);
      if (consumed.toISOString() >= grant.expiresAt) {
        throw new BrokerError(410, "GRANT_EXPIRED", "Deployment grant has expired");
      }
      const authorization: DeploymentAuthorization = Object.freeze({
        apiVersion: DEPLOYMENT_BROKER_API_VERSION,
        authorizationId: randomUUID(),
        grantId,
        handoffId: grant.handoffId,
        ...bindingOf(grant),
        issuedBy: grant.issuedBy,
        claimedBy: this.#config.executorPrincipal,
        issuedAt: grant.issuedAt,
        expiresAt: grant.expiresAt,
        consumedAt: consumed.toISOString(),
      });
      const event = await this.#store.append({
        eventId: randomUUID(),
        eventType: "grant_consumed",
        occurredAt: authorization.consumedAt,
        idempotencyScope: "executor:consume",
        idempotencyKey: parsedKey,
        requestHash,
        authorization,
      });
      this.#consumed.set(grantId, authorization);
      this.#authorizationIds.add(authorization.authorizationId);
      this.#idempotency.set(`executor:consume\u0000${parsedKey}`, { requestHash, event });
      this.#latestTimestamp = authorization.consumedAt;
      return { authorization, duplicate: false };
    });
  }

  #idempotencyResult(scope: string, key: string, requestHash: string): StoredEvent | undefined {
    const existing = this.#idempotency.get(`${scope}\u0000${key}`);
    if (existing === undefined) return undefined;
    if (existing.requestHash !== requestHash) {
      throw new BrokerError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request");
    }
    return existing.event;
  }

  #assertMonotonic(value: Date): void {
    if (this.#latestTimestamp !== undefined && value.toISOString() < this.#latestTimestamp) {
      throw new Error("DEPLOYMENT_BROKER_CLOCK_MOVED_BACKWARD");
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

  async close(): Promise<void> {
    await this.#tail;
    await this.#store.close();
  }
}
