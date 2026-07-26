import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ProtocolValidationError,
  STEWARD_RUNTIME_API_VERSION,
  STEWARD_RUNTIME_FEATURES_HEADER,
  STEWARD_RUNTIME_GENERATION_PROOF_HEADER,
  STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER,
  STEWARD_RUNTIME_TYPED_TASKS_FEATURE,
  parseAgentTaskProjection,
  parseHumanCommandEnvelope,
  parseHumanCommandReceipt,
  parseLeaseRenewalRequest,
  parseLeaseRenewalResult,
  parseManagerReviewPermitConsumeReceipt,
  parseManagerReviewPermitConsumeRequest,
  parseRuntimeCommandEnvelope,
  parseRuntimeCommandPollRequest,
  parseRuntimeCommandPollResult,
  parseRuntimeEventBatch,
  parseRuntimeEventBatchReceipt,
  parseSupervisorRegistration,
  parseSupervisorRegistrationRequest,
  parseSupervisorRegistrationResult,
  parseUiBootstrap,
  parseUiEventEnvelope,
  type AgentTaskProjection,
  type ClientCommandId,
  type CommandId,
  type DurableOutboxEvent,
  type HumanCommandEnvelope,
  type HumanCommandReceipt,
  type IsoTimestamp,
  type LeaseId,
  type LeaseRenewalRequest,
  type LeaseRenewalResult,
  type ManagerReviewPermitConsumeReceipt,
  type ManagerReviewPermitConsumeRequest,
  type RuntimeCommandEnvelope,
  type RuntimeCommandPayload,
  type RuntimeEventBatchReceipt,
  type SessionId,
  type SupervisorRegistration,
  type SupervisorRegistrationRequest,
  type SupervisorRegistrationResult,
  type TaskId,
  type UiEventEnvelope,
  type UserId,
  type WorkspaceId,
} from '#shared/protocol';
import { canonicalJson, contentDigest } from './canonical.js';
import {
  normalizeConfig,
  type ControlPlaneConfig,
  type ControlPlaneOptions,
} from './config.js';
import { ServiceError } from './errors.js';
import {
  applyCors,
  assertWorkloadBinding,
  assertWorkloadRegistrationRole,
  parseCursor,
  readJsonBody,
  requireHuman,
  requireManagerReviewPermitConsumer,
  requireUiRead,
  requireWorkload,
  sendError,
  sendJson,
  type AuthenticatedWorkload,
} from './http.js';
import { WorkspaceProjection, durableKinds, type LaneState } from './projection.js';
import {
  JsonlEventStore,
  type AppendEntry,
  type DurableEvent,
  type EventDraft,
} from './store.js';
import { agentForecastFrom, shiftAgentForecast } from './timing.js';

function asIso(date: Date): IsoTimestamp {
  return date.toISOString() as IsoTimestamp;
}

const MAX_RUNTIME_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_OFFLINE_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const RUNTIME_PROOF_CHALLENGE_PATTERN = /^rgc_[A-Za-z0-9_-]{43}$/u;
const RUNTIME_GENERATION_PROOF_PATTERN = /^rgp_[A-Za-z0-9_-]{43}$/u;

function runtimeProofChallenge(request: IncomingMessage): string | null {
  const value = request.headers[STEWARD_RUNTIME_PROOF_CHALLENGE_HEADER];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !RUNTIME_PROOF_CHALLENGE_PATTERN.test(value)) {
    throw new ServiceError(
      400,
      'INVALID_RUNTIME_PROOF_CHALLENGE',
      'Runtime proof challenge must contain 256 bits of base64url entropy',
    );
  }
  return value;
}

function optionalRuntimeGenerationProof(request: IncomingMessage): string | null {
  const value = request.headers[STEWARD_RUNTIME_GENERATION_PROOF_HEADER];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !RUNTIME_GENERATION_PROOF_PATTERN.test(value)) {
    throw new ServiceError(
      400,
      'INVALID_RUNTIME_GENERATION_PROOF',
      'Runtime generation proof is malformed',
    );
  }
  return value;
}

function runtimeFeatures(request: IncomingMessage): readonly string[] {
  const value = request.headers[STEWARD_RUNTIME_FEATURES_HEADER];
  if (value === undefined) return Object.freeze([]);
  if (typeof value !== 'string') {
    throw new ServiceError(400, 'INVALID_RUNTIME_FEATURES', 'Runtime feature header is invalid');
  }
  const presented = value.split(',').map((feature) => feature.trim()).filter(Boolean);
  if (new Set(presented).size !== presented.length) {
    throw new ServiceError(400, 'INVALID_RUNTIME_FEATURES', 'Runtime features must not repeat');
  }
  return Object.freeze(
    presented.includes(STEWARD_RUNTIME_TYPED_TASKS_FEATURE)
      ? [STEWARD_RUNTIME_TYPED_TASKS_FEATURE]
      : [],
  );
}

function capabilityDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function exactDigestMatch(expected: string, value: string): boolean {
  const actual = Buffer.from(capabilityDigest(value), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function recordData(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function parseProtocol<T>(parser: (input: unknown) => T, input: unknown): T {
  try {
    return parser(input);
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw new ServiceError(400, 'PROTOCOL_VALIDATION_FAILED', error.message);
    }
    throw error;
  }
}

function assertBoundedText(value: unknown, maximum: number): void {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > 10_000) {
      throw new ServiceError(400, 'PAYLOAD_TOO_COMPLEX', 'Payload has too many values');
    }
    if (typeof current === 'string' && current.length > maximum) {
      throw new ServiceError(400, 'TEXT_TOO_LONG', `Text values are limited to ${maximum} characters`);
    }
    if (Array.isArray(current)) pending.push(...current);
    else if (current !== null && typeof current === 'object') {
      pending.push(...Object.values(current));
    }
  }
}

interface SseSubscriber {
  response: ServerResponse;
  keepalive: NodeJS.Timeout;
}

interface RegisteredRuntimeSession {
  result: SupervisorRegistrationResult;
  runtimeGenerationProof: string | null;
}

export class ControlPlaneService {
  readonly config: ControlPlaneConfig;
  readonly projection: WorkspaceProjection;
  readonly store: JsonlEventStore;
  readonly #server: Server;
  readonly #subscribers = new Set<SseSubscriber>();
  #mutationTail: Promise<void> = Promise.resolve();
  #started = false;
  #draining = false;

  private constructor(
    config: ControlPlaneConfig,
    store: JsonlEventStore,
    projection: WorkspaceProjection,
  ) {
    this.config = config;
    this.store = store;
    this.projection = projection;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => sendError(response, error));
    });
    this.#server.requestTimeout = 30_000;
    this.#server.headersTimeout = 15_000;
    this.#server.keepAliveTimeout = 5_000;
    this.#server.maxRequestsPerSocket = 1_000;
  }

  static async create(options: ControlPlaneOptions): Promise<ControlPlaneService> {
    const config = normalizeConfig(options);
    const store = await JsonlEventStore.open({
      path: config.storePath,
      workspaceId: config.workspaceId,
      now: config.now,
    });
    const projection = new WorkspaceProjection(config.workspaceId as WorkspaceId);
    try {
      projection.rebuild(store.records);
    } catch (error) {
      await store.close();
      throw error;
    }
    return new ControlPlaneService(config, store, projection);
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.#started) return this.address();
    if (this.#draining) throw new ServiceError(503, 'SERVICE_DRAINING', 'Service is draining');
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.off('error', onError);
        resolve();
      };
      this.#server.once('error', onError);
      this.#server.once('listening', onListening);
      this.#server.listen(this.config.port, this.config.host);
    });
    this.#started = true;
    return this.address();
  }

  address(): { host: string; port: number; url: string } {
    const address = this.#server.address();
    if (address === null || typeof address === 'string') {
      throw new ServiceError(503, 'NOT_LISTENING', 'Control plane is not listening');
    }
    const host = (address as AddressInfo).address;
    const port = (address as AddressInfo).port;
    const urlHost = host.includes(':') ? `[${host}]` : host;
    return { host, port, url: `http://${urlHost}:${port}` };
  }

  async close(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    for (const subscriber of [...this.#subscribers]) {
      clearInterval(subscriber.keepalive);
      subscriber.response.write('event: shutdown\ndata: {"reason":"service_draining"}\n\n');
      subscriber.response.end();
      this.#subscribers.delete(subscriber);
    }
    if (this.#started) {
      await new Promise<void>((resolve, reject) => {
        this.#server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      this.#started = false;
    }
    await this.#mutationTail;
    await this.store.close();
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applyCors(request, response, this.config);
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Last-Event-ID, X-Steward-UI-Version',
      );
      response.setHeader('Access-Control-Max-Age', '600');
      response.end();
      return;
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, this.#draining ? 503 : 200, {
        status: this.#draining ? 'draining' : 'ok',
        workspaceId: this.config.workspaceId,
        lastSequence: this.projection.lastSequence,
        subscribers: this.#subscribers.size,
      });
      return;
    }
    if (this.#draining) {
      throw new ServiceError(503, 'SERVICE_DRAINING', 'Service is draining');
    }

    if (request.method === 'POST' && url.pathname === '/v1/runtime/register') {
      const workload = requireWorkload(request, this.config);
      const proofChallenge = runtimeProofChallenge(request);
      const replacementProof = optionalRuntimeGenerationProof(request);
      const features = runtimeFeatures(request);
      const body = await readJsonBody(request, this.config.maxBodyBytes);
      const registration = parseProtocol(parseSupervisorRegistrationRequest, body);
      assertWorkloadBinding(workload, registration);
      assertWorkloadRegistrationRole(workload, registration);
      assertBoundedText(registration, this.config.maxTextLength);
      const session = await this.#register(
        registration,
        proofChallenge,
        replacementProof,
        features,
      );
      if (session.runtimeGenerationProof !== null) {
        response.setHeader(
          STEWARD_RUNTIME_GENERATION_PROOF_HEADER,
          session.runtimeGenerationProof,
        );
      }
      sendJson(response, 200, session.result);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/runtime/lease') {
      const workload = requireWorkload(request, this.config);
      const body = await readJsonBody(request, this.config.maxBodyBytes);
      const renewal = parseProtocol(parseLeaseRenewalRequest, body);
      assertWorkloadBinding(workload, renewal);
      assertBoundedText(renewal, this.config.maxTextLength);
      sendJson(response, 200, await this.#renewLease(renewal));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/runtime/events') {
      const workload = requireWorkload(request, this.config);
      const body = await readJsonBody(request, this.config.maxBodyBytes);
      sendJson(response, 200, await this.#ingestRuntimeEvents(body, workload));
      return;
    }
    if (
      request.method === 'POST' &&
      url.pathname === '/v1/internal/manager-review-permits/consume'
    ) {
      if (request.headers.origin !== undefined) {
        throw new ServiceError(
          403,
          'INTERNAL_ROUTE_BROWSER_FORBIDDEN',
          'Manager-review permit consumption is service-to-service only',
        );
      }
      requireManagerReviewPermitConsumer(request, this.config);
      const generationProof = optionalRuntimeGenerationProof(request);
      const body = await readJsonBody(request, this.config.maxBodyBytes);
      const permit = parseProtocol(parseManagerReviewPermitConsumeRequest, body);
      assertBoundedText(permit, this.config.maxTextLength);
      sendJson(
        response,
        200,
        await this.#consumeManagerReviewPermit(permit, generationProof),
      );
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/runtime/commands') {
      const workload = requireWorkload(request, this.config);
      sendJson(
        response,
        200,
        await this.#pollRuntimeCommands(url, workload, runtimeFeatures(request)),
      );
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/ui/bootstrap') {
      const uiPrincipal = requireUiRead(request, this.config);
      const observerReadOnly = uiPrincipal === 'observer';
      const bootstrap = parseProtocol(
        parseUiBootstrap,
        this.projection.bootstrap(this.config.now(), {
          sessionId: (observerReadOnly ? 'session_impact_observer' : 'session_alpha') as SessionId,
          userId: (observerReadOnly ? 'impact_observer' : 'human_alpha') as UserId,
          permissions: observerReadOnly
            ? ['workspace:read']
            : ['workspace:read', 'workspace:control'],
          features: observerReadOnly
            ? ['durable-replay', 'runtime-fencing']
            : ['durable-replay', 'human-control', 'runtime-fencing'],
          eventStream: {
            href: '/v1/ui/events',
            afterSequence: this.projection.lastSequence,
            retentionStartsAtSequence: this.projection.lastSequence === 0 ? 0 : 1,
            heartbeatIntervalMs: this.config.keepAliveMs,
          },
          commandEndpoint: observerReadOnly
            ? '/v1/ui/commands/disabled'
            : '/v1/ui/commands',
        }),
      );
      sendJson(response, 200, bootstrap);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/ui/events') {
      requireUiRead(request, this.config);
      this.#openEventStream(request, response, url);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/ui/commands') {
      requireHuman(request, this.config);
      const body = await readJsonBody(request, this.config.maxBodyBytes);
      const command = parseProtocol(parseHumanCommandEnvelope, body);
      assertBoundedText(command, this.config.maxTextLength);
      sendJson(response, 200, await this.#acceptHumanCommand(command));
      return;
    }
    throw new ServiceError(404, 'NOT_FOUND', 'No control-plane route matches this request');
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #commit(drafts: readonly EventDraft[]): Promise<readonly AppendEntry[]> {
    const results = await this.store.append(drafts);
    for (const entry of results) {
      if (entry.duplicate) continue;
      const uiEvent = this.projection.apply(entry.event);
      this.#publish(uiEvent);
    }
    return results;
  }

  #assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.config.workspaceId) {
      throw new ServiceError(404, 'WORKSPACE_NOT_FOUND', 'Workspace is not served here');
    }
  }

  #assertLeaseIdentity(
    lane: LaneState,
    identity: {
      workspaceId: string;
      agentId: string;
      laneId: string;
      runtimeInstanceId: string;
      runtimeEpoch: number;
      leaseId?: string;
    },
    requireLive = true,
    observedAt: Date = this.config.now(),
  ): void {
    this.#assertWorkspace(identity.workspaceId);
    const registration = lane.registration;
    if (
      registration.agentId !== identity.agentId ||
      registration.laneId !== identity.laneId ||
      registration.runtimeInstanceId !== identity.runtimeInstanceId ||
      registration.runtimeEpoch !== identity.runtimeEpoch ||
      (identity.leaseId !== undefined && lane.leaseId !== identity.leaseId)
    ) {
      throw new ServiceError(409, 'RUNTIME_FENCED', 'Runtime epoch or lease is stale');
    }
    if (requireLive && observedAt.getTime() > Date.parse(lane.leaseExpiresAt)) {
      throw new ServiceError(409, 'LEASE_EXPIRED', 'Runtime lease has expired; claim a new epoch');
    }
  }

  #deriveRuntimeGenerationProof(
    registration: SupervisorRegistration,
    challenge: string,
  ): string {
    const binding = canonicalJson({
      version: 1,
      workspaceId: registration.workspaceId,
      agentId: registration.agentId,
      laneId: registration.laneId,
      runtimeInstanceId: registration.runtimeInstanceId,
      runtimeEpoch: registration.runtimeEpoch,
      challenge,
    });
    return `rgp_${createHmac('sha256', this.config.runtimeGenerationProofKey)
      .update(binding, 'utf8')
      .digest('base64url')}`;
  }

  #assertRuntimeGenerationProof(lane: LaneState, proof: string): void {
    if (
      lane.runtimeGenerationProofDigest === null ||
      !exactDigestMatch(lane.runtimeGenerationProofDigest, proof)
    ) {
      throw new ServiceError(
        409,
        'RUNTIME_GENERATION_PROOF_REJECTED',
        'Runtime generation proof is stale or does not match the registered process',
      );
    }
  }

  #registrationSession(
    event: DurableEvent,
    challenge: string | null,
  ): RegisteredRuntimeSession {
    const data = event.data as {
      registration: SupervisorRegistration;
      runtimeGenerationProofDigest?: string;
    };
    if (challenge === null || data.runtimeGenerationProofDigest === undefined) {
      return { result: this.#registrationResult(event), runtimeGenerationProof: null };
    }
    const proof = this.#deriveRuntimeGenerationProof(data.registration, challenge);
    if (!exactDigestMatch(data.runtimeGenerationProofDigest, proof)) {
      throw new ServiceError(
        409,
        'RUNTIME_PROOF_CHALLENGE_CONFLICT',
        'Runtime instance registration proof challenge changed across retry',
      );
    }
    return { result: this.#registrationResult(event), runtimeGenerationProof: proof };
  }

  #registrationResult(event: DurableEvent): SupervisorRegistrationResult {
    const data = event.data as {
      request: SupervisorRegistrationRequest;
      registration: SupervisorRegistration;
      leaseId: LeaseId;
      leaseGrantedAt: IsoTimestamp;
      leaseExpiresAt: IsoTimestamp;
    };
    const lane = this.projection.lanes.get(data.registration.laneId);
    return parseProtocol(parseSupervisorRegistrationResult, {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: data.registration.workspaceId,
      agentId: data.registration.agentId,
      laneId: data.registration.laneId,
      runtimeInstanceId: data.registration.runtimeInstanceId,
      runtimeEpoch: data.registration.runtimeEpoch,
      leaseId: lane?.leaseId ?? data.leaseId,
      leaseGrantedAt: lane?.leaseGrantedAt ?? data.leaseGrantedAt,
      leaseExpiresAt: lane?.leaseExpiresAt ?? data.leaseExpiresAt,
      lastAcceptedLocalSequence: lane?.lastAcceptedLocalSequence ?? 0,
      controlVersion: this.projection.controlVersion,
    });
  }

  #register(
    request: SupervisorRegistrationRequest,
    proofChallenge: string | null,
    replacementProof: string | null,
    features: readonly string[],
  ): Promise<RegisteredRuntimeSession> {
    return this.#exclusive(async () => {
      this.#assertWorkspace(request.workspaceId);
      const existingLane = this.projection.lanes.get(request.laneId);
      let runtimeEpoch: number;

      if (existingLane !== undefined) {
        if (existingLane.registration.agentId !== request.agentId) {
          throw new ServiceError(409, 'LANE_OWNERSHIP_CONFLICT', 'Stable lane belongs to another agent');
        }
        if (existingLane.registration.role !== request.role) {
          throw new ServiceError(409, 'LANE_ROLE_CONFLICT', 'Stable lane cannot change its fixed role');
        }
        if (request.runtimeInstanceId === existingLane.registration.runtimeInstanceId) {
          const currentEpoch = existingLane.registration.runtimeEpoch;
          const eventId = `registration:${request.laneId}:${currentEpoch}`;
          const existing = this.store.getByEventId(eventId);
          if (
            existing === undefined ||
            canonicalJson((existing.data as { request?: unknown }).request) !== canonicalJson(request) ||
            canonicalJson((existing.data as { runtimeFeatures?: unknown }).runtimeFeatures ?? []) !==
              canonicalJson(features)
          ) {
            throw new ServiceError(
              409,
              'RUNTIME_INSTANCE_ALREADY_CLAIMED',
              'Runtime instance is already registered with different content',
            );
          }
          if (this.config.now().getTime() > Date.parse(existingLane.leaseExpiresAt)) {
            throw new ServiceError(
              409,
              'LEASE_EXPIRED_REPLACEMENT_REQUIRED',
              'Expired runtime leases must be reclaimed by a replacement runtime',
            );
          }
          return this.#registrationSession(existing, proofChallenge);
        }
        const protectedReplacement = existingLane.runtimeGenerationProofDigest !== null;
        const legacyEngineerReplacement =
          !protectedReplacement && existingLane.registration.role === 'engineer';
        if (
          !legacyEngineerReplacement &&
          (!protectedReplacement ||
            replacementProof === null ||
            !exactDigestMatch(existingLane.runtimeGenerationProofDigest as string, replacementProof))
        ) {
          throw new ServiceError(
            409,
            'RUNTIME_REPLACEMENT_PROOF_REQUIRED',
            'Replacement must prove possession of the current runtime generation capability',
          );
        }
        if (request.expectedRuntimeEpoch !== existingLane.registration.runtimeEpoch) {
          throw new ServiceError(
            409,
            'REGISTRATION_CAS_CONFLICT',
            'Replacement runtime did not present the current fencing epoch',
          );
        }
        if (existingLane.registration.runtimeEpoch === Number.MAX_SAFE_INTEGER) {
          throw new ServiceError(409, 'RUNTIME_EPOCH_EXHAUSTED', 'Runtime fencing epoch is exhausted');
        }
        runtimeEpoch = existingLane.registration.runtimeEpoch + 1;
      } else {
        if (request.expectedRuntimeEpoch !== null) {
          throw new ServiceError(
            409,
            'REGISTRATION_CAS_CONFLICT',
            'A lane\'s first runtime must not claim a fencing epoch',
          );
        }
        runtimeEpoch = 1;
      }

      const registration = parseProtocol(parseSupervisorRegistration, {
        apiVersion: request.apiVersion,
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        laneId: request.laneId,
        runtimeInstanceId: request.runtimeInstanceId,
        runtimeEpoch,
        displayName: request.displayName,
        role: request.role,
        capabilities: request.capabilities,
        provider: request.provider,
        softwareVersion: request.softwareVersion,
        checkpointRef: request.checkpointRef,
      });
      const eventId = `registration:${registration.laneId}:${registration.runtimeEpoch}`;

      const leaseGrantedAt = asIso(this.config.now());
      const leaseExpiresAt = asIso(
        new Date(Date.parse(leaseGrantedAt) + this.config.leaseMs),
      );
      const leaseId = `lease_${randomUUID()}` as LeaseId;
      const runtimeProof =
        proofChallenge === null
          ? null
          : this.#deriveRuntimeGenerationProof(registration, proofChallenge);
      const drafts: EventDraft[] = [
        {
          eventId,
          idempotencyKey: eventId,
          kind: durableKinds.registered,
          laneId: registration.laneId,
          actor: 'supervisor',
          data: recordData({
            request,
            registration,
            leaseId,
            leaseGrantedAt,
            leaseExpiresAt,
            ...(runtimeProof === null
              ? {}
              : { runtimeGenerationProofDigest: capabilityDigest(runtimeProof) }),
            runtimeFeatures: features,
          }),
        },
      ];

      const rebind = (
        payload: RuntimeCommandPayload,
        suffix: string,
        preservedCommandId?: CommandId,
      ): void => {
        const serverSequence = this.projection.lastSequence + drafts.length + 1;
        const command = parseProtocol(parseRuntimeCommandEnvelope, {
          apiVersion: STEWARD_RUNTIME_API_VERSION,
          commandId:
            preservedCommandId ??
            (`command_rebind_${registration.laneId}_${registration.runtimeEpoch}_${suffix}` as CommandId),
          workspaceId: registration.workspaceId,
          agentId: registration.agentId,
          laneId: registration.laneId,
          serverSequence,
          expectedRuntimeEpoch: registration.runtimeEpoch,
          issuedAt: leaseGrantedAt,
          payload,
        });
        const rebindEventId = `registration-rebind:${registration.laneId}:${registration.runtimeEpoch}:${suffix}`;
        drafts.push({
          eventId: rebindEventId,
          idempotencyKey: rebindEventId,
          kind: durableKinds.runtimeCommand,
          laneId: registration.laneId,
          actor: 'system',
          data: recordData({
            command,
            controlVersion: this.projection.controlVersion,
            advancesControl: false,
          }),
        });
      };

      if (existingLane !== undefined) {

        for (const taskId of existingLane.queue) {
          const task = this.projection.tasks.get(taskId);
          const recoverableRunningReview =
            existingLane.registration.role === 'manager' &&
            task?.status === 'running' &&
            task.subject.type === 'manager_review' &&
            !this.projection.reviewPermitsByTask.has(task.taskId);
          if (task?.status === 'queued') {
            rebind({ type: 'assign_task', task }, `assign-${taskId}`);
          } else if (recoverableRunningReview) {
            rebind({ type: 'recover_task', task }, `recover-${taskId}`);
          }
        }

        if (existingLane.pendingResume !== null) {
          rebind(
            {
              type: 'resume',
              taskId: existingLane.pendingResume.taskId as TaskId | null,
              checkpointRef: existingLane.pendingResume.checkpointRef,
            },
            'preserve-resume',
            existingLane.pendingResume.commandId as CommandId,
          );
        } else if (existingLane.pendingHold !== null) {
          const priorHold = [...existingLane.runtimeCommands]
            .reverse()
            .find(
              (command) =>
                command.commandId === existingLane.pendingHold?.commandId &&
                command.payload.type === 'hold',
            );
          rebind(
            {
              type: 'hold',
              reason:
                priorHold?.payload.type === 'hold'
                  ? priorHold.payload.reason
                  : 'Workspace hold remains pending after runtime replacement',
            },
            'preserve-hold',
            existingLane.pendingHold.commandId as CommandId,
          );
        } else if (
          this.projection.workspacePaused ||
          existingLane.controlState === 'held' ||
          existingLane.controlState === 'paused'
        ) {
          rebind(
            {
              type: 'hold',
              reason: this.projection.workspacePaused
                ? 'Workspace remains paused by human control'
                : 'Agent remains held until a human resumes it',
            },
            'preserve-hold',
          );
        } else if (
          existingLane.controlState === 'interrupt_requested' &&
          existingLane.pendingInterrupt !== null
        ) {
          const priorInterrupt = [...existingLane.runtimeCommands]
            .reverse()
            .find((command) => command.payload.type === 'request_interrupt');
          rebind(
            {
              type: 'request_interrupt',
              reason:
                priorInterrupt?.payload.type === 'request_interrupt'
                  ? priorInterrupt.payload.reason
                  : 'Human interrupt remains pending after runtime replacement',
            },
            'preserve-interrupt',
            existingLane.pendingInterrupt.commandId as CommandId,
          );
        }
      } else if (this.projection.workspacePaused) {
        rebind(
          {
            type: 'hold',
            reason: 'Workspace remains paused by human control',
          },
          'initial-hold',
        );
      }

      const [entry] = await this.#commit(drafts);
      if (entry === undefined) throw new Error('REGISTRATION_COMMIT_EMPTY');
      return this.#registrationSession(entry.event, proofChallenge);
    });
  }

  #renewLease(request: LeaseRenewalRequest): Promise<LeaseRenewalResult> {
    return this.#exclusive(async () => {
      const lane = this.projection.requireLane(request.laneId);
      this.#assertLeaseIdentity(lane, request);
      if (request.lastDurableEventSequence > lane.lastAcceptedLocalSequence) {
        throw new ServiceError(
          409,
          'RUNTIME_SEQUENCE_AHEAD',
          'Runtime reports a durable sequence the server has not accepted',
        );
      }
      const eventId = `lease-renewal:${contentDigest(request)}`;
      const existing = this.store.getByEventId(eventId);
      if (existing !== undefined) return this.#leaseResult(existing);

      const leaseGrantedAt = asIso(this.config.now());
      const leaseExpiresAt = asIso(
        new Date(Date.parse(leaseGrantedAt) + this.config.leaseMs),
      );
      const [entry] = await this.#commit([
        {
          eventId,
          idempotencyKey: eventId,
          kind: durableKinds.leaseRenewed,
          laneId: request.laneId,
          actor: 'supervisor',
          data: recordData({ request, leaseGrantedAt, leaseExpiresAt }),
        },
      ]);
      if (entry === undefined) throw new Error('LEASE_COMMIT_EMPTY');
      return this.#leaseResult(entry.event);
    });
  }

  #leaseResult(event: DurableEvent): LeaseRenewalResult {
    const data = event.data as {
      request: LeaseRenewalRequest;
      leaseGrantedAt: IsoTimestamp;
      leaseExpiresAt: IsoTimestamp;
    };
    const lane = this.projection.requireLane(data.request.laneId);
    return parseProtocol(parseLeaseRenewalResult, {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: data.request.workspaceId,
      agentId: data.request.agentId,
      laneId: data.request.laneId,
      runtimeInstanceId: data.request.runtimeInstanceId,
      runtimeEpoch: data.request.runtimeEpoch,
      leaseId: data.request.leaseId,
      leaseGrantedAt: data.leaseGrantedAt,
      leaseExpiresAt: data.leaseExpiresAt,
      acceptedThroughLocalSequence: lane.lastAcceptedLocalSequence,
      controlVersion: this.projection.controlVersion,
    });
  }

  #ingestRuntimeEvents(
    input: unknown,
    workload: AuthenticatedWorkload,
  ): Promise<RuntimeEventBatchReceipt> {
    return this.#exclusive(async () => {
      const batch = parseProtocol(parseRuntimeEventBatch, input);
      assertWorkloadBinding(workload, batch);
      assertBoundedText(batch, this.config.maxTextLength);
      const lane = this.projection.requireLane(batch.laneId);
      this.#assertLeaseIdentity(lane, batch);

      let nextSequence = lane.lastAcceptedLocalSequence + 1;
      const drafts: EventDraft[] = [];
      const newEvents: DurableOutboxEvent[] = [];
      for (const event of batch.events) {
        const draft: EventDraft = {
          eventId: `runtime:${event.eventId}`,
          idempotencyKey: `runtime:${event.eventId}`,
          kind: durableKinds.runtimeOutbox,
          laneId: event.laneId,
          actor: 'runtime',
          data: recordData({ event }),
        };
        const duplicate = this.store.findDuplicate(draft);
        if (duplicate !== undefined) {
          if (event.localSequence > lane.lastAcceptedLocalSequence) {
            throw new ServiceError(
              409,
              'LOCAL_SEQUENCE_CONFLICT',
              'Duplicate event is not in the accepted runtime prefix',
            );
          }
        } else {
          if (event.localSequence !== nextSequence) {
            throw new ServiceError(
              409,
              'LOCAL_SEQUENCE_GAP',
              'Runtime local sequence is not contiguous',
              { expected: nextSequence, received: event.localSequence },
            );
          }
          nextSequence += 1;
          newEvents.push(event);
        }
        drafts.push(draft);
      }

      this.#preflightRuntimeEvents(lane, newEvents);
      await this.#commit(drafts);
      return parseProtocol(parseRuntimeEventBatchReceipt, {
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        workspaceId: batch.workspaceId,
        agentId: batch.agentId,
        laneId: batch.laneId,
        runtimeInstanceId: batch.runtimeInstanceId,
        runtimeEpoch: batch.runtimeEpoch,
        acceptedThroughLocalSequence: this.projection.requireLane(batch.laneId)
          .lastAcceptedLocalSequence,
        controlVersion: this.projection.controlVersion,
      });
    });
  }

  #preflightRuntimeEvents(lane: LaneState, events: readonly DurableOutboxEvent[]): void {
    type ProgressPhase = 'research' | 'plan' | 'execute' | 'test';
    type ProgressCursor = {
      phase: ProgressPhase;
      iteration: number;
      testOutcome?: 'passed' | 'failed';
    };

    const receivedAt = this.config.now().getTime();
    for (const event of events) {
      const reportedAt = Date.parse(event.occurredAt);
      if (
        reportedAt > receivedAt + MAX_RUNTIME_FUTURE_SKEW_MS ||
        reportedAt < receivedAt - MAX_OFFLINE_EVENT_AGE_MS
      ) {
        throw new ServiceError(
          409,
          'RUNTIME_EVENT_TIME_SKEW',
          'Runtime event time falls outside the accepted offline-upload window',
        );
      }
    }

    const progress = new Map<string, ProgressCursor>();
    for (const [taskId, entries] of this.projection.progress) {
      const latest = entries.at(-1);
      if (latest !== undefined) {
        progress.set(taskId, {
          phase: latest.phase,
          iteration: latest.iteration,
          ...(latest.phase === 'test' ? { testOutcome: latest.outcome } : {}),
        });
      }
    }
    const tasks = new Map(this.projection.tasks);
    const latestProgressAt = new Map<string, string>();
    for (const [taskId, entries] of this.projection.progress) {
      const occurredAt = entries.at(-1)?.occurredAt;
      if (occurredAt !== undefined) latestProgressAt.set(taskId, occurredAt);
    }
    let currentAction = lane.currentAction;
    let controlState = lane.controlState;
    let pendingInterrupt = lane.pendingInterrupt
      ? { ...lane.pendingInterrupt }
      : null;
    let pendingHold = lane.pendingHold ? { ...lane.pendingHold } : null;
    let pendingResume = lane.pendingResume ? { ...lane.pendingResume } : null;

    const requireOwnedTask = (taskId: string) => {
      const task = tasks.get(taskId);
      if (task === undefined) {
        throw new ServiceError(409, 'RUNTIME_TASK_UNKNOWN', `Runtime referenced unknown task: ${taskId}`);
      }
      if (
        task.workspaceId !== this.projection.workspaceId ||
        task.agentId !== lane.registration.agentId ||
        task.laneId !== lane.registration.laneId
      ) {
        throw new ServiceError(409, 'RUNTIME_TASK_LANE_MISMATCH', 'Runtime task belongs to another lane');
      }
      return task;
    };

    const validateTaskState = (
      candidate: AgentTaskProjection,
      code: string,
      reason: string,
    ): AgentTaskProjection => {
      try {
        return parseAgentTaskProjection(candidate);
      } catch (error) {
        throw new ServiceError(409, code, reason, {
          validation: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const activeTaskId = (): string | null => {
      const active = [...tasks.values()].filter(
        (task) =>
          task.laneId === lane.registration.laneId &&
          (task.status === 'running' || task.status === 'paused'),
      );
      if (active.length > 1) {
        throw new ServiceError(
          409,
          'LANE_TASK_CONCURRENCY_CONFLICT',
          'A fixed-role lane may have only one active task',
        );
      }
      const currentTaskId = currentAction?.taskId ?? null;
      if (
        currentTaskId !== null &&
        active[0] !== undefined &&
        active[0].taskId !== currentTaskId
      ) {
        throw new ServiceError(
          409,
          'LANE_CURRENT_ACTION_CONFLICT',
          'Current action does not match the lane active task',
        );
      }
      return currentTaskId ?? active[0]?.taskId ?? null;
    };

    const queueHeadTaskId = (): string | null => {
      for (const taskId of lane.queue) {
        const task = tasks.get(taskId);
        if (task !== undefined && task.status !== 'completed' && task.status !== 'failed') {
          return taskId;
        }
      }
      return null;
    };

    const assertTaskMayRun = (task: AgentTaskProjection): void => {
      if (
        controlState === 'held' ||
        controlState === 'paused' ||
        controlState === 'resume_requested'
      ) {
        throw new ServiceError(
          409,
          'RUNTIME_LANE_HELD',
          'Runtime cannot continue work until a human resumes the lane',
        );
      }
      const active = activeTaskId();
      if (active !== null && active !== task.taskId) {
        throw new ServiceError(
          409,
          'LANE_TASK_CONCURRENCY_CONFLICT',
          'Runtime cannot start another task while this lane has active work',
        );
      }
      if (active === null && queueHeadTaskId() !== task.taskId) {
        throw new ServiceError(
          409,
          'LANE_QUEUE_ORDER_CONFLICT',
          'Runtime must execute its accepted task queue in order',
        );
      }
    };

    const confirmResume = (taskId: string | null, resumedAt: IsoTimestamp): void => {
      if (pendingResume === null) return;
      if (pendingResume.taskId !== taskId) {
        throw new ServiceError(
          409,
          'RESUME_CAUSATION_CONFLICT',
          'Runtime activity does not match the pending resume task',
        );
      }
      pendingResume = null;
      controlState = 'active';
      if (taskId === null) return;
      const task = requireOwnedTask(taskId);
      if (task.status !== 'paused') {
        throw new ServiceError(
          409,
          'RESUME_TASK_STATE_INVALID',
          'Only a paused task can confirm a resume',
        );
      }
      const pausedAt = lane.pausedAtByTask.get(task.taskId);
      tasks.set(
        task.taskId,
        validateTaskState(
          {
            ...task,
            status: 'running',
            expectedCompletedAt:
              pausedAt === undefined
                ? task.expectedCompletedAt
                : shiftAgentForecast(task.expectedCompletedAt, pausedAt, resumedAt),
          },
          'RESUME_TASK_STATE_INVALID',
          'Runtime resume would create an invalid task lifecycle',
        ),
      );
    };

    for (const event of events) {
      const payload = event.payload;
      switch (payload.type) {
        case 'progress': {
          if (pendingResume !== null) confirmResume(payload.taskId, event.occurredAt);
          requireOwnedTask(payload.taskId);
          const task = requireOwnedTask(payload.taskId);
          if (task.status === 'completed' || task.status === 'failed') {
            throw new ServiceError(409, 'RUNTIME_TASK_TERMINAL', 'Runtime cannot progress a terminal task');
          }
          const prior = progress.get(payload.taskId);
          if (prior?.phase === 'test' && prior.testOutcome === 'passed') {
            throw new ServiceError(
              409,
              'PROGRESS_AFTER_PASS',
              'A passing test must be followed by task completion, not another iteration',
            );
          }
          assertTaskMayRun(task);
          const expected: ProgressCursor =
            prior === undefined
              ? { phase: 'research', iteration: 1 }
              : prior.phase === 'research'
                ? { phase: 'plan', iteration: prior.iteration }
                : prior.phase === 'plan'
                  ? { phase: 'execute', iteration: prior.iteration }
                  : prior.phase === 'execute'
                    ? { phase: 'test', iteration: prior.iteration }
                    : { phase: 'research', iteration: prior.iteration + 1 };
          if (payload.phase !== expected.phase || payload.iteration !== expected.iteration) {
            throw new ServiceError(
              409,
              'PROGRESS_ORDER_CONFLICT',
              'Progress must follow the research, plan, execute, test loop',
              {
                expected,
                received: { phase: payload.phase, iteration: payload.iteration },
              },
            );
          }
          const startedAt =
            task.startedAt ??
            (currentAction?.taskId === task.taskId
              ? currentAction.startedAt
              : event.occurredAt);
          const priorProgressAt = latestProgressAt.get(task.taskId);
          if (
            Date.parse(event.occurredAt) < Date.parse(startedAt) ||
            (priorProgressAt !== undefined &&
              Date.parse(event.occurredAt) < Date.parse(priorProgressAt))
          ) {
            throw new ServiceError(
              409,
              'TASK_TIME_REGRESSION',
              'Runtime progress time cannot precede task start or prior progress',
            );
          }
          progress.set(payload.taskId, {
            phase: payload.phase,
            iteration: payload.iteration,
            ...(payload.phase === 'test' ? { testOutcome: payload.outcome } : {}),
          });
          latestProgressAt.set(payload.taskId, event.occurredAt);
          tasks.set(
            task.taskId,
            validateTaskState(
              {
                ...task,
                status: 'running',
                startedAt,
                expectedCompletedAt:
                  task.startedAt === null
                    ? agentForecastFrom(startedAt, task.expectedAgentMinutes)
                    : task.expectedCompletedAt,
                endedAt: null,
              },
              'RUNTIME_TASK_STATE_INVALID',
              'Runtime progress would create an invalid task lifecycle',
            ),
          );
          break;
        }
        case 'heartbeat':
          if (pendingResume !== null) {
            if (payload.currentAction !== null) {
              confirmResume(
                payload.currentAction.taskId,
                payload.currentAction.startedAt,
              );
            } else if (pendingResume.taskId === null) {
              confirmResume(null, event.occurredAt);
            }
          }
          if (payload.currentAction !== null) {
            const task = requireOwnedTask(payload.currentAction.taskId);
            if (task.status === 'completed' || task.status === 'failed') {
              throw new ServiceError(
                409,
                'RUNTIME_TASK_TERMINAL',
                'A terminal task cannot become the current action',
              );
            }
            assertTaskMayRun(task);
            if (
              Date.parse(payload.currentAction.startedAt) > Date.parse(event.occurredAt) ||
              (task.startedAt !== null &&
                Date.parse(payload.currentAction.startedAt) < Date.parse(task.startedAt))
            ) {
              throw new ServiceError(
                409,
                'CURRENT_ACTION_TIME_INVALID',
                'Current action time must fall within the task timeline',
              );
            }
            tasks.set(
              task.taskId,
              validateTaskState(
                {
                  ...task,
                  status: 'running',
                  startedAt: task.startedAt ?? payload.currentAction.startedAt,
                  expectedCompletedAt:
                    task.startedAt === null
                      ? agentForecastFrom(
                          payload.currentAction.startedAt,
                          task.expectedAgentMinutes,
                        )
                      : task.expectedCompletedAt,
                  endedAt: null,
                },
                'RUNTIME_TASK_STATE_INVALID',
                'Current action would create an invalid task lifecycle',
              ),
            );
          }
          currentAction = payload.currentAction;
          break;
        case 'interrupt_acknowledged': {
          if (
            pendingInterrupt?.commandId !== payload.commandId ||
            pendingInterrupt.state !== 'requested'
          ) {
            throw new ServiceError(
              409,
              'INTERRUPT_CAUSATION_CONFLICT',
              'Interrupt acknowledgement does not match a pending request',
            );
          }
          if (payload.taskId !== null) requireOwnedTask(payload.taskId);
          const interruptTaskId = activeTaskId();
          if (payload.taskId !== interruptTaskId) {
            throw new ServiceError(
              409,
              'INTERRUPT_TASK_CONFLICT',
              'Interrupt acknowledgement does not match the active task',
            );
          }
          pendingInterrupt = {
            commandId: payload.commandId,
            state: 'acknowledged',
            taskId: payload.taskId,
          };
          break;
        }
        case 'interrupt_settled':
          if (
            pendingInterrupt?.commandId !== payload.commandId ||
            pendingInterrupt.state !== 'acknowledged' ||
            pendingInterrupt.taskId !== payload.taskId
          ) {
            throw new ServiceError(
              409,
              'INTERRUPT_CAUSATION_CONFLICT',
              'Interrupt settlement does not match its acknowledgement',
            );
          }
          if (payload.taskId !== null) {
            const task = requireOwnedTask(payload.taskId);
            tasks.set(
              task.taskId,
              validateTaskState(
                { ...task, status: 'paused' },
                'INTERRUPT_TASK_STATE_INVALID',
                'Runtime cannot pause a task that has not started or is already terminal',
              ),
            );
          }
          pendingInterrupt = null;
          currentAction = null;
          controlState = 'paused';
          break;
        case 'hold_acknowledged': {
          if (
            pendingHold?.commandId !== payload.commandId ||
            pendingHold.state !== 'requested'
          ) {
            throw new ServiceError(
              409,
              'HOLD_CAUSATION_CONFLICT',
              'Hold acknowledgement does not match a pending request',
            );
          }
          if (payload.taskId !== null) requireOwnedTask(payload.taskId);
          const heldTaskId = activeTaskId();
          if (payload.taskId !== heldTaskId) {
            throw new ServiceError(
              409,
              'HOLD_TASK_CONFLICT',
              'Hold acknowledgement does not match the active task',
            );
          }
          pendingHold = {
            commandId: payload.commandId,
            state: 'acknowledged',
            taskId: payload.taskId,
          };
          controlState = 'hold_requested';
          break;
        }
        case 'hold_settled':
          if (
            pendingHold?.commandId !== payload.commandId ||
            pendingHold.state !== 'acknowledged' ||
            pendingHold.taskId !== payload.taskId
          ) {
            throw new ServiceError(
              409,
              'HOLD_CAUSATION_CONFLICT',
              'Hold settlement does not match its acknowledgement',
            );
          }
          if (payload.taskId !== null) {
            const task = requireOwnedTask(payload.taskId);
            tasks.set(
              task.taskId,
              validateTaskState(
                { ...task, status: 'paused' },
                'HOLD_TASK_STATE_INVALID',
                'Runtime cannot hold a task that has not started or is already terminal',
              ),
            );
          }
          pendingHold = null;
          currentAction = null;
          controlState = 'held';
          break;
        case 'task_completed':
        case 'task_failed': {
          if (pendingResume !== null) confirmResume(payload.taskId, event.occurredAt);
          requireOwnedTask(payload.taskId);
          const task = requireOwnedTask(payload.taskId);
          if (task.status === 'completed' || task.status === 'failed') {
            throw new ServiceError(409, 'RUNTIME_TASK_TERMINAL', 'Runtime task already has a terminal result');
          }
          assertTaskMayRun(task);
          if (payload.type === 'task_completed') {
            const latest = progress.get(payload.taskId);
            if (latest?.phase !== 'test' || latest.testOutcome !== 'passed') {
              throw new ServiceError(
                409,
                'TASK_COMPLETION_WITHOUT_PASS',
                'Runtime cannot complete a task before its latest test passes',
              );
            }
          }
          const startedAt = task.startedAt ?? event.occurredAt;
          const priorProgressAt = latestProgressAt.get(task.taskId);
          if (
            Date.parse(event.occurredAt) < Date.parse(startedAt) ||
            (priorProgressAt !== undefined &&
              Date.parse(event.occurredAt) < Date.parse(priorProgressAt))
          ) {
            throw new ServiceError(
              409,
              'TASK_TIME_REGRESSION',
              'Runtime terminal time cannot precede task start or progress',
            );
          }
          tasks.set(
            task.taskId,
            validateTaskState(
              {
                ...task,
                status: payload.type === 'task_completed' ? 'completed' : 'failed',
                startedAt,
                endedAt: event.occurredAt,
              },
              'RUNTIME_TASK_STATE_INVALID',
              'Runtime result would create an invalid task lifecycle',
            ),
          );
          if (currentAction?.taskId === task.taskId) currentAction = null;
          break;
        }
        case 'interrupt_refused':
          if (
            pendingInterrupt?.commandId !== payload.commandId ||
            pendingInterrupt.state !== 'requested'
          ) {
            throw new ServiceError(
              409,
              'INTERRUPT_CAUSATION_CONFLICT',
              'Interrupt refusal does not match a pending request',
            );
          }
          pendingInterrupt = null;
          controlState = this.projection.workspacePaused ? 'held' : 'active';
          break;
      }
    }
  }

  #consumeManagerReviewPermit(
    request: ManagerReviewPermitConsumeRequest,
    generationProof: string | null,
  ): Promise<ManagerReviewPermitConsumeReceipt> {
    return this.#exclusive(async () => {
      this.#assertWorkspace(request.workspaceId);
      const eventId = `manager-review-permit:${request.operationId}`;
      const existing = this.store.getByEventId(eventId);
      if (existing !== undefined) {
        const storedRequest = parseProtocol(
          parseManagerReviewPermitConsumeRequest,
          (existing.data as { request?: unknown }).request,
        );
        if (
          canonicalJson(this.#logicalReviewPermitRequest(storedRequest)) !==
          canonicalJson(this.#logicalReviewPermitRequest(request))
        ) {
          throw new ServiceError(
            409,
            'REVIEW_PERMIT_IDEMPOTENCY_CONFLICT',
            'Review permit operation id was already used with different logical content',
          );
        }
        return this.#reviewPermitReceipt(existing, 'duplicate');
      }

      if (generationProof === null) {
        throw new ServiceError(
          401,
          'RUNTIME_GENERATION_PROOF_REQUIRED',
          'A new manager-review permit requires the registered runtime generation proof',
        );
      }
      const authorizationTime = this.config.now();
      if (Number.isNaN(authorizationTime.valueOf())) {
        throw new Error('CONTROL_PLANE_CLOCK_INVALID');
      }
      const lane = this.projection.requireLane(request.managerLaneId);
      this.#assertLeaseIdentity(
        lane,
        {
          workspaceId: request.workspaceId,
          agentId: request.managerAgentId,
          laneId: request.managerLaneId,
          runtimeInstanceId: request.runtimeInstanceId,
          runtimeEpoch: request.runtimeEpoch,
        },
        true,
        authorizationTime,
      );
      this.#assertRuntimeGenerationProof(lane, generationProof);

      if (this.projection.workspacePaused) {
        throw new ServiceError(409, 'WORKSPACE_PAUSED', 'Workspace is paused by human control');
      }
      if (lane.registration.role !== 'manager') {
        throw new ServiceError(403, 'REVIEW_ROLE_REQUIRED', 'Only the fixed manager role can consume a review permit');
      }
      if (
        lane.controlState !== 'active' ||
        lane.pendingInterrupt !== null ||
        lane.pendingHold !== null ||
        lane.pendingResume !== null
      ) {
        throw new ServiceError(
          409,
          'MANAGER_RUNTIME_NOT_ACTIVE',
          'Manager runtime is interrupted, held, paused, or changing control state',
        );
      }
      if (this.projection.reviewPermitsByTask.has(request.reviewTaskId)) {
        throw new ServiceError(409, 'REVIEW_TASK_ALREADY_PERMITTED', 'Review task already consumed a permit');
      }
      if (this.projection.reviewPermitsByEvidence.has(request.evidenceId)) {
        throw new ServiceError(409, 'EVIDENCE_ALREADY_PERMITTED', 'Evidence already consumed a review permit');
      }

      const reviewTask = this.projection.tasks.get(request.reviewTaskId);
      if (reviewTask === undefined) {
        throw new ServiceError(409, 'REVIEW_TASK_NOT_FOUND', 'Assigned manager-review task was not found');
      }
      if (
        reviewTask.workspaceId !== request.workspaceId ||
        reviewTask.agentId !== request.managerAgentId ||
        reviewTask.laneId !== request.managerLaneId
      ) {
        throw new ServiceError(409, 'REVIEW_TASK_OWNERSHIP_CONFLICT', 'Review task belongs to another manager lane');
      }
      if (
        reviewTask.status !== 'running' ||
        reviewTask.startedAt === null ||
        lane.currentAction?.taskId !== reviewTask.taskId
      ) {
        throw new ServiceError(
          409,
          'REVIEW_TASK_NOT_RUNNING',
          'Manager review permit requires the assigned task to be the current running action',
        );
      }
      if (
        reviewTask.subject.type !== 'manager_review' ||
        reviewTask.subject.sourceTaskId !== request.sourceTaskId ||
        reviewTask.subject.evidenceId !== request.evidenceId ||
        reviewTask.subject.evidenceDigest !== request.evidenceDigest
      ) {
        throw new ServiceError(
          409,
          'REVIEW_TASK_SUBJECT_CONFLICT',
          'Review request does not match the task\'s immutable evidence binding',
        );
      }

      const sourceTask = this.projection.tasks.get(request.sourceTaskId);
      if (
        sourceTask === undefined ||
        sourceTask.workspaceId !== request.workspaceId ||
        sourceTask.status !== 'completed' ||
        sourceTask.endedAt === null
      ) {
        throw new ServiceError(
          409,
          'REVIEW_SOURCE_NOT_COMPLETE',
          'Manager review requires a completed source task',
        );
      }
      const sourceLane = this.projection.lanes.get(sourceTask.laneId);
      if (sourceLane?.registration.role !== 'engineer') {
        throw new ServiceError(409, 'REVIEW_SOURCE_ROLE_CONFLICT', 'Review source must be an engineer task');
      }
      if (sourceTask.agentId === request.managerAgentId) {
        throw new ServiceError(403, 'SELF_REVIEW_FORBIDDEN', 'A manager cannot review their own source task');
      }

      if (
        authorizationTime.getTime() < Date.parse(reviewTask.startedAt) ||
        authorizationTime.getTime() < Date.parse(sourceTask.endedAt)
      ) {
        throw new ServiceError(
          409,
          'REVIEW_TASK_TIME_INVALID',
          'Control-plane time cannot precede the source completion or review task start',
        );
      }

      const [entry] = await this.#commit([
        {
          eventId,
          idempotencyKey: eventId,
          kind: durableKinds.managerReviewPermit,
          laneId: request.managerLaneId,
          actor: 'system',
          data: recordData({ request, permitId: `permit_${randomUUID()}` }),
          occurredAt: authorizationTime.toISOString(),
        },
      ]);
      if (entry === undefined) throw new Error('REVIEW_PERMIT_COMMIT_EMPTY');
      return this.#reviewPermitReceipt(entry.event, entry.duplicate ? 'duplicate' : 'accepted');
    });
  }

  #logicalReviewPermitRequest(
    request: ManagerReviewPermitConsumeRequest,
  ): Omit<ManagerReviewPermitConsumeRequest, 'runtimeInstanceId' | 'runtimeEpoch'> {
    const { runtimeInstanceId: _runtimeInstanceId, runtimeEpoch: _runtimeEpoch, ...logical } = request;
    return logical;
  }

  #reviewPermitReceipt(
    event: DurableEvent,
    state: ManagerReviewPermitConsumeReceipt['state'],
  ): ManagerReviewPermitConsumeReceipt {
    const data = event.data as { request?: unknown; permitId?: unknown };
    const request = parseProtocol(parseManagerReviewPermitConsumeRequest, data.request);
    return parseProtocol(parseManagerReviewPermitConsumeReceipt, {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      state,
      permitId: data.permitId,
      operationId: request.operationId,
      workspaceId: request.workspaceId,
      reviewTaskId: request.reviewTaskId,
      sourceTaskId: request.sourceTaskId,
      evidenceId: request.evidenceId,
      evidenceDigest: request.evidenceDigest,
      managerAgentId: request.managerAgentId,
      managerLaneId: request.managerLaneId,
      managerRuntimeInstanceId: request.runtimeInstanceId,
      managerRuntimeEpoch: request.runtimeEpoch,
      reviewRequestDigest: request.reviewRequestDigest,
      authorizedAt: event.occurredAt,
      workspaceSequence: event.workspaceSequence,
    });
  }

  async #pollRuntimeCommands(
    url: URL,
    workload: AuthenticatedWorkload,
    presentedFeatures: readonly string[],
  ): Promise<unknown> {
    const required = [
      'workspaceId',
      'agentId',
      'laneId',
      'runtimeInstanceId',
      'runtimeEpoch',
    ] as const;
    for (const name of required) {
      if (!url.searchParams.get(name)) {
        throw new ServiceError(400, 'MISSING_QUERY', `${name} query parameter is required`);
      }
    }
    const after = parseCursor(url.searchParams.get('after') ?? '0', 'after');
    const poll = parseProtocol(parseRuntimeCommandPollRequest, {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: url.searchParams.get('workspaceId') as string,
      agentId: url.searchParams.get('agentId') as string,
      laneId: url.searchParams.get('laneId') as string,
      runtimeInstanceId: url.searchParams.get('runtimeInstanceId') as string,
      runtimeEpoch: Number(url.searchParams.get('runtimeEpoch')),
      afterServerSequence: after,
    });
    assertWorkloadBinding(workload, poll);
    const lane = this.projection.requireLane(poll.laneId);
    this.#assertLeaseIdentity(lane, poll);
    if (canonicalJson(lane.runtimeFeatures) !== canonicalJson(presentedFeatures)) {
      throw new ServiceError(
        409,
        'RUNTIME_FEATURE_NEGOTIATION_CONFLICT',
        'Command poll features differ from the durable runtime registration',
      );
    }
    const typedTasks = lane.runtimeFeatures.includes(STEWARD_RUNTIME_TYPED_TASKS_FEATURE);
    const eligible = lane.runtimeCommands.filter(
      (command) =>
        command.serverSequence > poll.afterServerSequence &&
        command.expectedRuntimeEpoch === poll.runtimeEpoch &&
        (typedTasks || command.payload.type !== 'recover_task'),
    );
    const commands = eligible.slice(0, 100);
    const latestServerSequence =
      eligible.length > commands.length
        ? (commands.at(-1)?.serverSequence ?? poll.afterServerSequence)
        : this.projection.lastSequence;
    const typedResult = parseProtocol(parseRuntimeCommandPollResult, {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: poll.workspaceId,
      agentId: poll.agentId,
      laneId: poll.laneId,
      runtimeInstanceId: poll.runtimeInstanceId,
      runtimeEpoch: poll.runtimeEpoch,
      latestServerSequence,
      commands,
    });
    if (typedTasks) return typedResult;
    return {
      ...typedResult,
      commands: typedResult.commands.map((command) => {
        if (command.payload.type !== 'assign_task') return command;
        const { subject: _subject, ...legacyTask } = command.payload.task;
        return {
          ...command,
          payload: { type: 'assign_task', task: legacyTask },
        };
      }),
    };
  }

  #humanEventId(commandId: ClientCommandId, suffix: string): string {
    return `human:${commandId}:${suffix}`;
  }

  #existingHumanReceipt(
    command: HumanCommandEnvelope,
    primaryEventId: string,
  ): HumanCommandReceipt | undefined {
    const event = this.store.getByEventId(primaryEventId);
    if (event === undefined) return undefined;
    const eventData = event.data as {
      command?: unknown;
      humanCommand?: unknown;
      controlVersion?: unknown;
    };
    const storedCommand = eventData.humanCommand ?? eventData.command;
    if (canonicalJson(storedCommand) !== canonicalJson(command)) {
      throw new ServiceError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'Client command id was already used with different content',
      );
    }
    return parseProtocol(parseHumanCommandReceipt, {
      state: 'duplicate',
      clientCommandId: command.clientCommandId,
      workspaceId: this.projection.workspaceId,
      acceptedAt: event.occurredAt,
      currentControlVersion: this.projection.controlVersion,
      intentEventSequence: event.workspaceSequence,
    });
  }

  #commandEnvelope(
    humanCommand: HumanCommandEnvelope,
    lane: LaneState,
    payload: RuntimeCommandPayload,
    serverSequence: number,
    suffix: string,
    issuedAt: IsoTimestamp,
  ): RuntimeCommandEnvelope {
    return parseProtocol(parseRuntimeCommandEnvelope, {
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      commandId: `command_${humanCommand.clientCommandId}_${suffix}` as CommandId,
      workspaceId: this.projection.workspaceId,
      agentId: lane.registration.agentId,
      laneId: lane.registration.laneId,
      serverSequence,
      expectedRuntimeEpoch: lane.registration.runtimeEpoch,
      issuedAt,
      payload,
    });
  }

  #laneForHuman(command: HumanCommandEnvelope): LaneState {
    if (command.payload.type === 'set_workspace_pause') {
      throw new Error('WORKSPACE_COMMAND_HAS_NO_SINGLE_LANE');
    }
    const lane = this.projection.requireLane(command.payload.laneId);
    if (lane.registration.agentId !== command.payload.agentId) {
      throw new ServiceError(409, 'LANE_OWNERSHIP_CONFLICT', 'Lane belongs to another agent');
    }
    return lane;
  }

  #acceptHumanCommand(command: HumanCommandEnvelope): Promise<HumanCommandReceipt> {
    return this.#exclusive(async () => {
      this.#assertWorkspace(command.workspaceId);
      const primaryId = this.#humanEventId(command.clientCommandId, 'primary');
      const prior = this.#existingHumanReceipt(command, primaryId);
      if (prior !== undefined) return prior;
      if (command.expectedControlVersion !== this.projection.controlVersion) {
        throw new ServiceError(409, 'CONTROL_VERSION_CONFLICT', 'Human command used a stale control version', {
          expected: this.projection.controlVersion,
          received: command.expectedControlVersion,
        });
      }

      const controlVersion = this.projection.controlVersion + 1;
      const issuedAt = asIso(this.config.now());
      const firstSequence = this.projection.lastSequence + 1;
      const drafts: EventDraft[] = [];

      switch (command.payload.type) {
        case 'queue_work': {
          const lane = this.#laneForHuman(command);
          const subject = command.payload.subject;
          if (lane.queue.length >= this.config.maxQueueSize) {
            throw new ServiceError(409, 'QUEUE_FULL', 'Agent queue reached its configured limit');
          }
          if (subject.type === 'development') {
            if (lane.registration.role !== 'engineer') {
              throw new ServiceError(
                409,
                'TASK_ROLE_CONFLICT',
                'Development tasks may be assigned only to engineer lanes',
              );
            }
          } else {
            if (lane.registration.role !== 'manager') {
              throw new ServiceError(
                409,
                'REVIEW_TASK_ROLE_CONFLICT',
                'Manager-review tasks may be assigned only to manager lanes',
              );
            }
            const sourceTask = this.projection.tasks.get(subject.sourceTaskId);
            if (sourceTask === undefined || sourceTask.status !== 'completed') {
              throw new ServiceError(
                409,
                'REVIEW_SOURCE_NOT_COMPLETE',
                'Manager-review tasks require a completed source task',
              );
            }
            const sourceLane = this.projection.lanes.get(sourceTask.laneId);
            if (sourceLane?.registration.role !== 'engineer') {
              throw new ServiceError(
                409,
                'REVIEW_SOURCE_ROLE_CONFLICT',
                'Manager-review source must belong to an engineer lane',
              );
            }
            if (sourceTask.agentId === lane.registration.agentId) {
              throw new ServiceError(
                403,
                'SELF_REVIEW_FORBIDDEN',
                'A manager cannot be assigned their own source task',
              );
            }
            const existingAssignment = [...this.projection.tasks.values()].find(
              (task) =>
                task.subject.type === 'manager_review' &&
                task.subject.evidenceId === subject.evidenceId &&
                task.status !== 'failed',
            );
            if (existingAssignment !== undefined) {
              throw new ServiceError(
                409,
                'REVIEW_ASSIGNMENT_EXISTS',
                'Evidence already has a non-failed manager-review assignment',
              );
            }
          }
          const task = parseProtocol(parseAgentTaskProjection, {
            taskId: `task_${command.clientCommandId}` as TaskId,
            workspaceId: command.workspaceId,
            agentId: command.payload.agentId,
            laneId: command.payload.laneId,
            subject,
            title: command.payload.title,
            objective: command.payload.objective,
            status: 'queued',
            expectedAgentMinutes: command.payload.expectedAgentMinutes,
            expectedCompletedAt: agentForecastFrom(
              issuedAt,
              command.payload.expectedAgentMinutes,
            ),
            startedAt: null,
            endedAt: null,
          });
          const runtime = this.#commandEnvelope(
            command,
            lane,
            { type: 'assign_task', task },
            firstSequence + 1,
            'assign',
            issuedAt,
          );
          drafts.push(
            {
              eventId: primaryId,
              idempotencyKey: primaryId,
              kind: durableKinds.taskQueued,
              laneId: command.payload.laneId,
              actor: 'human',
              data: recordData({ command, task, controlVersion }),
            },
            {
              eventId: this.#humanEventId(command.clientCommandId, 'runtime'),
              idempotencyKey: this.#humanEventId(command.clientCommandId, 'runtime'),
              kind: durableKinds.runtimeCommand,
              laneId: command.payload.laneId,
              actor: 'human',
              data: recordData({
                humanCommandId: command.clientCommandId,
                humanCommand: command,
                command: runtime,
                controlVersion,
                advancesControl: false,
              }),
            },
          );
          break;
        }
        case 'request_interrupt': {
          const lane = this.#laneForHuman(command);
          if (lane.pendingResume !== null || lane.controlState === 'resume_requested') {
            throw new ServiceError(
              409,
              'RESUME_NOT_CONFIRMED',
              'Wait for the runtime to confirm its resume before interrupting it',
            );
          }
          if (lane.pendingHold !== null || lane.controlState === 'hold_requested') {
            throw new ServiceError(
              409,
              'HOLD_ALREADY_PENDING',
              'Wait for the workspace hold to settle before interrupting this agent',
            );
          }
          if (lane.controlState === 'held') {
            throw new ServiceError(409, 'AGENT_HELD', 'A held agent has no active work to interrupt');
          }
          if (lane.pendingInterrupt !== null) {
            throw new ServiceError(
              409,
              'INTERRUPT_ALREADY_PENDING',
              'An interrupt request is already pending for this agent',
            );
          }
          const runtime = this.#commandEnvelope(
            command,
            lane,
            { type: 'request_interrupt', reason: command.payload.reason },
            firstSequence,
            'interrupt',
            issuedAt,
          );
          drafts.push({
            eventId: primaryId,
            idempotencyKey: primaryId,
            kind: durableKinds.runtimeCommand,
            laneId: command.payload.laneId,
            actor: 'human',
            data: recordData({
              humanCommandId: command.clientCommandId,
              humanCommand: command,
              command: runtime,
              controlVersion,
              advancesControl: true,
            }),
          });
          break;
        }
        case 'resume_agent': {
          const lane = this.#laneForHuman(command);
          if (this.projection.workspacePaused) {
            throw new ServiceError(
              409,
              'WORKSPACE_PAUSED',
              'Resume the workspace before resuming an individual agent',
            );
          }
          if (lane.pendingInterrupt !== null) {
            throw new ServiceError(
              409,
              'INTERRUPT_NOT_SETTLED',
              'An agent cannot resume until its interrupt settles',
            );
          }
          if (lane.pendingHold !== null) {
            throw new ServiceError(
              409,
              'HOLD_NOT_SETTLED',
              'An agent cannot resume until its workspace hold settles',
            );
          }
          if (lane.controlState !== 'paused' && lane.controlState !== 'held') {
            throw new ServiceError(
              409,
              'AGENT_NOT_PAUSED',
              'Resume commands require a paused or held agent',
            );
          }
          if (command.payload.checkpointRef !== lane.checkpointRef) {
            throw new ServiceError(
              409,
              'HUMAN_CHECKPOINT_CONFLICT',
              'Resume command does not match the lane checkpoint',
            );
          }
          if (command.payload.taskId !== null) {
            const task = this.projection.tasks.get(command.payload.taskId);
            if (task === undefined) {
              throw new ServiceError(409, 'HUMAN_TASK_UNKNOWN', 'Resume command references an unknown task');
            }
            if (task.agentId !== lane.registration.agentId || task.laneId !== lane.registration.laneId) {
              throw new ServiceError(409, 'HUMAN_TASK_LANE_MISMATCH', 'Resume task belongs to another lane');
            }
            if (task.status !== 'paused') {
              throw new ServiceError(
                409,
                'HUMAN_TASK_NOT_PAUSED',
                'Resume commands may target only a paused task',
              );
            }
          }
          const runtime = this.#commandEnvelope(
            command,
            lane,
            {
              type: 'resume',
              taskId: command.payload.taskId,
              checkpointRef: command.payload.checkpointRef,
            },
            firstSequence,
            'resume',
            issuedAt,
          );
          drafts.push({
            eventId: primaryId,
            idempotencyKey: primaryId,
            kind: durableKinds.runtimeCommand,
            laneId: command.payload.laneId,
            actor: 'human',
            data: recordData({
              humanCommandId: command.clientCommandId,
              humanCommand: command,
              command: runtime,
              controlVersion,
              advancesControl: true,
            }),
          });
          break;
        }
        case 'set_workspace_pause': {
          const lanes = [...this.projection.lanes.values()].sort((left, right) =>
            left.registration.laneId.localeCompare(right.registration.laneId),
          );
          if (
            command.payload.paused &&
            lanes.some(
              (lane) =>
                lane.pendingInterrupt !== null || lane.pendingResume !== null,
            )
          ) {
            throw new ServiceError(
              409,
              'LANE_CONTROL_NOT_SETTLED',
              'Wait for pending agent interrupts or resumes before pausing the workspace',
            );
          }
          if (
            !command.payload.paused &&
            lanes.some((lane) => lane.pendingHold !== null)
          ) {
            throw new ServiceError(
              409,
              'HOLD_NOT_SETTLED',
              'Wait for every agent to confirm the workspace hold before resuming',
            );
          }
          drafts.push({
            eventId: primaryId,
            idempotencyKey: primaryId,
            kind: durableKinds.workspaceControl,
            actor: 'human',
            data: recordData({ command, controlVersion }),
          });
          for (const [index, lane] of lanes.entries()) {
            if (command.payload.paused && lane.controlState !== 'active') continue;
            if (!command.payload.paused && !lane.resumeAfterWorkspacePause) continue;
            const taskId =
              lane.queue.find(
                (queuedTaskId) =>
                  this.projection.tasks.get(queuedTaskId)?.status === 'paused',
              ) ?? null;
            const payload: RuntimeCommandPayload = command.payload.paused
              ? { type: 'hold', reason: command.payload.reason }
              : { type: 'resume', taskId, checkpointRef: lane.checkpointRef };
            const runtime = this.#commandEnvelope(
              command,
              lane,
              payload,
              firstSequence + drafts.length,
              `workspace-${index + 1}`,
              issuedAt,
            );
            const runtimeEventId = this.#humanEventId(
              command.clientCommandId,
              `runtime-${index + 1}`,
            );
            drafts.push({
              eventId: runtimeEventId,
              idempotencyKey: runtimeEventId,
              kind: durableKinds.runtimeCommand,
              laneId: lane.registration.laneId,
              actor: 'human',
              data: recordData({
                humanCommandId: command.clientCommandId,
                humanCommand: command,
                command: runtime,
                controlVersion,
                advancesControl: false,
              }),
            });
          }
          break;
        }
      }

      const results = await this.#commit(drafts);
      const first = results[0]?.event;
      if (first === undefined) throw new Error('HUMAN_COMMAND_COMMIT_EMPTY');
      return parseProtocol(parseHumanCommandReceipt, {
        state: 'accepted',
        clientCommandId: command.clientCommandId,
        workspaceId: this.projection.workspaceId,
        acceptedAt: first.occurredAt,
        currentControlVersion: controlVersion,
        intentEventSequence: first.workspaceSequence,
      });
    });
  }

  #openEventStream(request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (this.#subscribers.size >= this.config.maxSubscribers) {
      throw new ServiceError(503, 'SUBSCRIBER_LIMIT', 'Too many event subscribers');
    }
    const queryCursor = url.searchParams.get('after');
    const headerCursor = request.headers['last-event-id'];
    const after = parseCursor(
      queryCursor ?? (Array.isArray(headerCursor) ? headerCursor[0] : headerCursor) ?? '0',
      'after',
    );
    if (after > this.projection.lastSequence) {
      throw new ServiceError(409, 'CURSOR_AHEAD', 'Event cursor is ahead of durable state');
    }

    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    const keepalive = setInterval(() => {
      if (!response.write(`: keepalive ${Date.now()}\n\n`)) response.end();
    }, this.config.keepAliveMs);
    keepalive.unref();
    const subscriber: SseSubscriber = { response, keepalive };
    this.#subscribers.add(subscriber);
    const remove = () => {
      clearInterval(keepalive);
      this.#subscribers.delete(subscriber);
    };
    request.once('close', remove);
    response.once('close', remove);

    for (const event of this.projection.uiEvents) {
      if (event.sequence <= after) continue;
      if (!this.#writeSse(response, event)) {
        response.end();
        break;
      }
    }
  }

  #writeSse(response: ServerResponse, event: UiEventEnvelope): boolean {
    const parsed = parseProtocol(parseUiEventEnvelope, event);
    return response.write(
      `id: ${parsed.sequence}\nevent: steward.event\ndata: ${JSON.stringify(parsed)}\n\n`,
    );
  }

  #publish(event: UiEventEnvelope): void {
    for (const subscriber of [...this.#subscribers]) {
      if (!this.#writeSse(subscriber.response, event)) {
        clearInterval(subscriber.keepalive);
        subscriber.response.end();
        this.#subscribers.delete(subscriber);
      }
    }
  }
}

export async function createControlPlane(
  options: ControlPlaneOptions,
): Promise<ControlPlaneService> {
  return ControlPlaneService.create(options);
}
