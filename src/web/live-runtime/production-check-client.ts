const MANAGER_REVIEW_API_VERSION = 1 as const;
// The service is not paginated yet. Keep a high defensive ceiling so normal
// queue growth does not make the whole read view unavailable prematurely.
const MAX_PRODUCTION_CHECK_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PRODUCTION_CHECKS = 1_000;
const MAX_REVIEW_TEXT_CHARS = 2_000;
const DEFAULT_PRODUCTION_CHECK_TIMEOUT_MS = 5_000;

export type ProductionCheckStatus =
  | 'handoff_registration_pending'
  | 'pending_human_review';

export interface LiveProductionCheck {
  readonly apiVersion: typeof MANAGER_REVIEW_API_VERSION;
  readonly productionCheckId: string;
  readonly status: ProductionCheckStatus;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly reviewTaskId: string;
  readonly evidenceId: string;
  readonly evidenceDigest: string;
  readonly completionEventId: string;
  readonly checkpointRef: string | null;
  readonly engineerAgentId: string;
  readonly managerAgentId: string;
  readonly managerRuntimeInstanceId: string;
  readonly managerRuntimeEpoch: number;
  readonly managerReviewId: string;
  readonly permitId: string;
  readonly permitWorkspaceSequence: number;
  readonly resultOverview: string;
  readonly reviewSummary: string;
  readonly remainingRisks: string;
  readonly testEvidenceDigest: string;
  readonly releaseArtifactDigest: string;
  readonly releaseManifestDigest: string;
  readonly targetEnvironment: string;
  readonly completedAt: string;
  readonly reviewedAt: string;
  readonly handoffId: string | null;
  readonly handoffRegisteredAt: string | null;
}

export interface ProductionCheckGateway {
  /** Fetches the read-only human decision queue. This boundary exposes no mutation method. */
  fetchChecks(signal?: AbortSignal): Promise<readonly LiveProductionCheck[]>;
}

export interface HttpProductionCheckGatewayOptions {
  readonly origin: string;
  readonly workspaceId: string;
  readonly readToken: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export class ProductionCheckProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductionCheckProtocolError';
  }
}

export class ProductionCheckTransportError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ProductionCheckTransportError';
    this.status = status;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProductionCheckProtocolError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProductionCheckProtocolError(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ProductionCheckProtocolError(`${label} contains unexpected or missing fields.`);
  }
}

function identifier(value: unknown, label: string, maximum = 128): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
  ) {
    throw new ProductionCheckProtocolError(`${label} is invalid.`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) {
    throw new ProductionCheckProtocolError(`${label} is invalid.`);
  }
  return value;
}

function nullableIdentifier(value: unknown, label: string, maximum = 256): string | null {
  return value === null ? null : identifier(value, label, maximum);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new ProductionCheckProtocolError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function reviewText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_REVIEW_TEXT_CHARS ||
    value.trim() !== value ||
    /[\u0000-\u0008\u000b\u000c\u000d\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new ProductionCheckProtocolError(`${label} is invalid.`);
  }
  return value;
}

function credential(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ProductionCheckProtocolError(`${label} is invalid.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 64) {
    throw new ProductionCheckProtocolError(`${label} is invalid.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new ProductionCheckProtocolError(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function nullableUuid(value: unknown, label: string): string | null {
  return value === null ? null : uuid(value, label);
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ProductionCheckProtocolError(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

function requestTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_PRODUCTION_CHECK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new ProductionCheckProtocolError('Production-check timeout is outside its safe range.');
  }
  return timeoutMs;
}

function requestDeadline(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  readonly didTimeOut: () => boolean;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const relayCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) relayCallerAbort();
  else callerSignal?.addEventListener('abort', relayCallerAbort, { once: true });
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', relayCallerAbort);
    },
  };
}

const PRODUCTION_CHECK_KEYS = [
  'apiVersion',
  'productionCheckId',
  'status',
  'workspaceId',
  'taskId',
  'reviewTaskId',
  'evidenceId',
  'evidenceDigest',
  'completionEventId',
  'checkpointRef',
  'engineerAgentId',
  'managerAgentId',
  'managerRuntimeInstanceId',
  'managerRuntimeEpoch',
  'managerReviewId',
  'permitId',
  'permitWorkspaceSequence',
  'resultOverview',
  'reviewSummary',
  'remainingRisks',
  'testEvidenceDigest',
  'releaseArtifactDigest',
  'releaseManifestDigest',
  'targetEnvironment',
  'completedAt',
  'reviewedAt',
  'handoffId',
  'handoffRegisteredAt',
] as const;

function parseProductionCheck(value: unknown, expectedWorkspaceId: string): LiveProductionCheck {
  const item = record(value, 'Production check');
  exactKeys(item, PRODUCTION_CHECK_KEYS, 'Production check');
  if (item.apiVersion !== MANAGER_REVIEW_API_VERSION) {
    throw new ProductionCheckProtocolError('The manager-review service uses an unsupported API version.');
  }
  if (item.status !== 'handoff_registration_pending' && item.status !== 'pending_human_review') {
    throw new ProductionCheckProtocolError('Production check status is invalid.');
  }

  const workspaceId = identifier(item.workspaceId, 'Production check workspaceId');
  if (workspaceId !== expectedWorkspaceId) {
    throw new ProductionCheckProtocolError('The production check belongs to another workspace.');
  }
  const managerReviewId = uuid(item.managerReviewId, 'Production check managerReviewId');
  const productionCheckId = identifier(item.productionCheckId, 'Production check productionCheckId');
  if (productionCheckId !== `production-check:${managerReviewId}`) {
    throw new ProductionCheckProtocolError('Production check identity does not match its manager review.');
  }
  const completedAt = timestamp(item.completedAt, 'Production check completedAt');
  const reviewedAt = timestamp(item.reviewedAt, 'Production check reviewedAt');
  if (Date.parse(reviewedAt) < Date.parse(completedAt)) {
    throw new ProductionCheckProtocolError('Manager review cannot predate task completion.');
  }
  const taskId = identifier(item.taskId, 'Production check taskId');
  const reviewTaskId = identifier(item.reviewTaskId, 'Production check reviewTaskId');
  if (reviewTaskId === taskId) {
    throw new ProductionCheckProtocolError('The manager-review task must differ from its source task.');
  }
  const handoffId = nullableUuid(item.handoffId, 'Production check handoffId');
  const handoffRegisteredAt = nullableTimestamp(
    item.handoffRegisteredAt,
    'Production check handoffRegisteredAt',
  );
  if (item.status === 'handoff_registration_pending') {
    if (handoffId !== null || handoffRegisteredAt !== null) {
      throw new ProductionCheckProtocolError('A pending handoff cannot contain registration details.');
    }
  } else if (handoffId === null || handoffRegisteredAt === null) {
    throw new ProductionCheckProtocolError('A human-review check requires a registered handoff.');
  } else if (Date.parse(handoffRegisteredAt) < Date.parse(reviewedAt)) {
    throw new ProductionCheckProtocolError('Handoff registration cannot predate manager review.');
  }

  return Object.freeze({
    apiVersion: MANAGER_REVIEW_API_VERSION,
    productionCheckId,
    status: item.status,
    workspaceId,
    taskId,
    reviewTaskId,
    evidenceId: uuid(item.evidenceId, 'Production check evidenceId'),
    evidenceDigest: digest(item.evidenceDigest, 'Production check evidenceDigest'),
    completionEventId: identifier(item.completionEventId, 'Production check completionEventId', 256),
    checkpointRef: nullableIdentifier(item.checkpointRef, 'Production check checkpointRef'),
    engineerAgentId: identifier(item.engineerAgentId, 'Production check engineerAgentId'),
    managerAgentId: identifier(item.managerAgentId, 'Production check managerAgentId'),
    managerRuntimeInstanceId: identifier(
      item.managerRuntimeInstanceId,
      'Production check managerRuntimeInstanceId',
    ),
    managerRuntimeEpoch: positiveSafeInteger(
      item.managerRuntimeEpoch,
      'Production check managerRuntimeEpoch',
    ),
    managerReviewId,
    permitId: identifier(item.permitId, 'Production check permitId'),
    permitWorkspaceSequence: positiveSafeInteger(
      item.permitWorkspaceSequence,
      'Production check permitWorkspaceSequence',
    ),
    resultOverview: reviewText(item.resultOverview, 'Production check resultOverview'),
    reviewSummary: reviewText(item.reviewSummary, 'Production check reviewSummary'),
    remainingRisks: reviewText(item.remainingRisks, 'Production check remainingRisks'),
    testEvidenceDigest: digest(item.testEvidenceDigest, 'Production check testEvidenceDigest'),
    releaseArtifactDigest: digest(item.releaseArtifactDigest, 'Production check releaseArtifactDigest'),
    releaseManifestDigest: digest(item.releaseManifestDigest, 'Production check releaseManifestDigest'),
    targetEnvironment: identifier(item.targetEnvironment, 'Production check targetEnvironment'),
    completedAt,
    reviewedAt,
    handoffId,
    handoffRegisteredAt,
  });
}

export function parseProductionCheckResponse(
  value: unknown,
  expectedWorkspaceId: string,
): readonly LiveProductionCheck[] {
  const response = record(value, 'Production-check response');
  exactKeys(response, ['items'], 'Production-check response');
  if (!Array.isArray(response.items) || response.items.length > MAX_PRODUCTION_CHECKS) {
    throw new ProductionCheckProtocolError('Production checks must be a bounded array.');
  }
  const checks = response.items.map((item) => parseProductionCheck(item, expectedWorkspaceId));
  const checkIds = new Set<string>();
  const reviewIds = new Set<string>();
  const reviewTaskIds = new Set<string>();
  const permitIds = new Set<string>();
  const permitSequences = new Set<number>();
  const evidenceIds = new Set<string>();
  for (const check of checks) {
    if (
      checkIds.has(check.productionCheckId) ||
      reviewIds.has(check.managerReviewId) ||
      reviewTaskIds.has(check.reviewTaskId) ||
      permitIds.has(check.permitId) ||
      permitSequences.has(check.permitWorkspaceSequence) ||
      evidenceIds.has(check.evidenceId)
    ) {
      throw new ProductionCheckProtocolError('Production checks contain a duplicate identity.');
    }
    checkIds.add(check.productionCheckId);
    reviewIds.add(check.managerReviewId);
    reviewTaskIds.add(check.reviewTaskId);
    permitIds.add(check.permitId);
    permitSequences.add(check.permitWorkspaceSequence);
    evidenceIds.add(check.evidenceId);
  }
  return Object.freeze(checks);
}

function configuredOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProductionCheckProtocolError('The manager-review origin must be a valid HTTP(S) URL.');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== '/' ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ProductionCheckProtocolError(
      'The manager-review origin must be an exact HTTP(S) origin without credentials, path, or query data.',
    );
  }
  const loopback = parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]' ||
    parsed.hostname === '::1';
  if (parsed.protocol === 'http:' && !loopback) {
    throw new ProductionCheckProtocolError(
      'Bearer credentials require HTTPS except for a loopback development origin.',
    );
  }
  return new URL(parsed.origin);
}

async function readBoundedBody(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    await response.body?.cancel().catch(() => undefined);
    throw new ProductionCheckProtocolError('The manager-review response must be JSON.');
  }
  const declaredText = response.headers.get('content-length');
  if (declaredText !== null && !/^(?:0|[1-9]\d*)$/u.test(declaredText)) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProductionCheckProtocolError('The manager-review response has an invalid size declaration.');
  }
  if (declaredText !== null && Number(declaredText) > MAX_PRODUCTION_CHECK_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProductionCheckProtocolError('The manager-review response exceeded the maximum size.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_PRODUCTION_CHECK_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProductionCheckProtocolError('The manager-review response exceeded the maximum size.');
      }
      body += decoder.decode(next.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export function createHttpProductionCheckGateway(
  options: HttpProductionCheckGatewayOptions,
): ProductionCheckGateway {
  const origin = configuredOrigin(options.origin);
  const workspaceId = identifier(options.workspaceId, 'Production-check workspaceId');
  const readToken = credential(options.readToken, 'Production-check read token');
  const timeoutMs = requestTimeout(options.timeoutMs);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new ProductionCheckProtocolError('This browser does not provide fetch.');
  }
  const endpoint = new URL('/v1/production-checks', origin);
  endpoint.searchParams.set('workspaceId', workspaceId);

  return Object.freeze({
    async fetchChecks(signal?: AbortSignal): Promise<readonly LiveProductionCheck[]> {
      const deadline = requestDeadline(signal, timeoutMs);
      try {
        const response = await fetchImplementation(endpoint, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${readToken}`,
          },
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: deadline.signal,
        });
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          if (response.status === 401 || response.status === 403) {
            throw new ProductionCheckTransportError('Production-check authentication failed.', response.status);
          }
          throw new ProductionCheckTransportError('The manager-review service rejected the request.', response.status);
        }
        const text = await readBoundedBody(response);
        let decoded: unknown;
        try {
          decoded = JSON.parse(text) as unknown;
        } catch {
          throw new ProductionCheckProtocolError('The manager-review service returned invalid JSON.');
        }
        return parseProductionCheckResponse(decoded, workspaceId);
      } catch (error) {
        if (
          error instanceof ProductionCheckProtocolError ||
          error instanceof ProductionCheckTransportError
        ) {
          throw error;
        }
        if (signal?.aborted) throw error;
        if (deadline.didTimeOut()) {
          throw new ProductionCheckTransportError('The production-check request timed out.', 0);
        }
        throw new ProductionCheckTransportError('The manager-review service could not be reached.', 0);
      } finally {
        deadline.dispose();
      }
    },
  });
}
