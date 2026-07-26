const IMPACT_API_VERSION = 'steward.impact/v1' as const;
const MAX_IMPACT_RESPONSE_BYTES = 256 * 1024;
const MAX_IMPACT_SUMMARIES = 1_000;
const MAX_SUMMARY_CHARS = 4_000;

export type ImpactTaskStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed';

export interface LiveImpactSummary {
  readonly taskId: string;
  readonly status: ImpactTaskStatus;
  readonly summary: string;
  readonly updatedAt: string;
  readonly sourceSequence: number;
}

export interface LiveImpactSnapshot {
  readonly apiVersion: typeof IMPACT_API_VERSION;
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly sourceSequence: number;
  readonly summaries: readonly LiveImpactSummary[];
}

export interface ImpactSummaryGateway {
  fetchSnapshot(signal?: AbortSignal): Promise<LiveImpactSnapshot>;
}

export interface HttpImpactSummaryGatewayOptions {
  readonly origin: string;
  readonly workspaceId: string;
  readonly outputToken: string;
  readonly fetch?: typeof fetch;
}

export class ImpactSummaryProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImpactSummaryProtocolError';
  }
}

export class ImpactSummaryTransportError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ImpactSummaryTransportError';
    this.status = status;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ImpactSummaryProtocolError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ImpactSummaryProtocolError(`${label} contains unexpected fields.`);
  }
}

function boundedString(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || /\p{Cc}/u.test(value)) {
    throw new ImpactSummaryProtocolError(`${label} is invalid.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = boundedString(value, label, 64);
  if (Number.isNaN(Date.parse(text)) || new Date(text).toISOString() !== text) {
    throw new ImpactSummaryProtocolError(`${label} must be a canonical ISO timestamp.`);
  }
  return text;
}

function sequence(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ImpactSummaryProtocolError(`${label} must be a non-negative safe integer.`);
  }
  return Number(value);
}

function parseSummary(value: unknown): LiveImpactSummary {
  const item = record(value, 'Impact summary');
  exactKeys(item, ['taskId', 'status', 'summary', 'updatedAt', 'sourceSequence'], 'Impact summary');
  if (!['queued', 'running', 'paused', 'completed', 'failed'].includes(String(item.status))) {
    throw new ImpactSummaryProtocolError('Impact summary status is invalid.');
  }
  return Object.freeze({
    taskId: boundedString(item.taskId, 'Impact summary taskId'),
    status: item.status as ImpactTaskStatus,
    summary: boundedString(item.summary, 'Impact summary text', MAX_SUMMARY_CHARS),
    updatedAt: timestamp(item.updatedAt, 'Impact summary updatedAt'),
    sourceSequence: sequence(item.sourceSequence, 'Impact summary sourceSequence'),
  });
}

export function parseImpactSnapshot(value: unknown, expectedWorkspaceId: string): LiveImpactSnapshot {
  const snapshot = record(value, 'Impact summary snapshot');
  exactKeys(
    snapshot,
    ['apiVersion', 'workspaceId', 'generatedAt', 'sourceSequence', 'summaries'],
    'Impact summary snapshot',
  );
  if (snapshot.apiVersion !== IMPACT_API_VERSION) {
    throw new ImpactSummaryProtocolError('The impact observer uses an unsupported API version.');
  }
  const workspaceId = boundedString(snapshot.workspaceId, 'Impact summary workspaceId');
  if (workspaceId !== expectedWorkspaceId) {
    throw new ImpactSummaryProtocolError('The impact summary belongs to another workspace.');
  }
  if (!Array.isArray(snapshot.summaries) || snapshot.summaries.length > MAX_IMPACT_SUMMARIES) {
    throw new ImpactSummaryProtocolError('Impact summaries must be a bounded array.');
  }
  const sourceSequence = sequence(snapshot.sourceSequence, 'Impact summary sourceSequence');
  const summaries = snapshot.summaries.map(parseSummary);
  const seen = new Set<string>();
  for (const summary of summaries) {
    if (seen.has(summary.taskId)) {
      throw new ImpactSummaryProtocolError('Impact summaries contain a duplicate taskId.');
    }
    if (summary.sourceSequence > sourceSequence) {
      throw new ImpactSummaryProtocolError('An impact summary is newer than its snapshot.');
    }
    seen.add(summary.taskId);
  }
  return Object.freeze({
    apiVersion: IMPACT_API_VERSION,
    workspaceId,
    generatedAt: timestamp(snapshot.generatedAt, 'Impact summary generatedAt'),
    sourceSequence,
    summaries: Object.freeze(summaries),
  });
}

function configuredOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ImpactSummaryProtocolError('The impact-observer origin must be a valid HTTP(S) URL.');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ImpactSummaryProtocolError(
      'The impact-observer origin must be an HTTP(S) URL without credentials or query data.',
    );
  }
  const loopback = parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]' ||
    parsed.hostname === '::1';
  if (parsed.protocol === 'http:' && !loopback) {
    throw new ImpactSummaryProtocolError(
      'Bearer credentials require HTTPS except for a loopback development origin.',
    );
  }
  return new URL(parsed.origin);
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMPACT_RESPONSE_BYTES) {
    throw new ImpactSummaryProtocolError('The impact-observer response exceeded the maximum size.');
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
      if (bytes > MAX_IMPACT_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ImpactSummaryProtocolError('The impact-observer response exceeded the maximum size.');
      }
      body += decoder.decode(next.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export function createHttpImpactSummaryGateway(
  options: HttpImpactSummaryGatewayOptions,
): ImpactSummaryGateway {
  const origin = configuredOrigin(options.origin);
  const workspaceId = boundedString(options.workspaceId, 'Impact summary workspaceId');
  const outputToken = boundedString(options.outputToken, 'Impact observer output token', 4_096);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new ImpactSummaryProtocolError('This browser does not provide fetch.');
  }
  const endpoint = new URL('/v1/impact-summaries', origin);
  endpoint.searchParams.set('workspaceId', workspaceId);

  return Object.freeze({
    async fetchSnapshot(signal?: AbortSignal): Promise<LiveImpactSnapshot> {
      let response: Response;
      try {
        response = await fetchImplementation(endpoint, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${outputToken}`,
          },
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal,
        });
      } catch (error) {
        if (error instanceof ImpactSummaryProtocolError) throw error;
        throw new ImpactSummaryTransportError('The impact observer could not be reached.', 0);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401 || response.status === 403) {
          throw new ImpactSummaryTransportError('Impact-observer authentication failed.', response.status);
        }
        throw new ImpactSummaryTransportError('The impact observer rejected the request.', response.status);
      }
      const text = await readBoundedBody(response);
      let decoded: unknown;
      try {
        decoded = JSON.parse(text) as unknown;
      } catch {
        throw new ImpactSummaryProtocolError('The impact observer returned invalid JSON.');
      }
      return parseImpactSnapshot(decoded, workspaceId);
    },
  });
}
