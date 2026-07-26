import {
  ProtocolValidationError,
  STEWARD_UI_API_VERSION,
  parseHumanCommandEnvelope,
  parseHumanCommandReceipt,
  parseUiBootstrap,
  parseUiEventEnvelope,
  type HumanCommandEnvelope,
  type HumanCommandReceipt,
  type UiBootstrap,
  type UiEventEnvelope,
  type WorkspaceId,
} from '#shared/protocol';

const MAX_JSON_BYTES = 512 * 1024;
const MAX_SSE_EVENT_BYTES = 512 * 1024;

export interface HttpControlPlaneGatewayOptions {
  readonly origin: string;
  readonly workspaceId: WorkspaceId;
  readonly humanToken: string;
  readonly bootstrapPath?: string;
  readonly fetch?: typeof fetch;
}

export type UiEventStreamTermination =
  | Readonly<{ kind: 'authentication_expired' }>
  | Readonly<{ kind: 'retention_miss'; retentionStartsAtSequence: number }>
  | Readonly<{ kind: 'incompatible_protocol'; supportedVersions: readonly string[] }>
  | Readonly<{ kind: 'server_shutdown' }>
  | Readonly<{ kind: 'protocol_error'; reason: string }>
  | Readonly<{ kind: 'transient_network'; retryAfterMs?: number }>;

export interface UiEventSubscription {
  close(): void;
}

export interface ControlPlaneGateway {
  bootstrap(signal?: AbortSignal): Promise<UiBootstrap>;
  subscribe(input: {
    readonly afterSequence: number;
    readonly onEvent: (event: UiEventEnvelope) => void;
    readonly onDisconnect: (reason: UiEventStreamTermination) => void;
  }): UiEventSubscription;
  submit(command: HumanCommandEnvelope, signal?: AbortSignal): Promise<HumanCommandReceipt>;
}

export class ControlPlaneTransportError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ControlPlaneTransportError';
    this.status = status;
  }
}

export class ControlPlaneProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlPlaneProtocolError';
  }
}

function configuredOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ControlPlaneProtocolError('The control-plane origin must be a valid HTTP(S) URL.');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ControlPlaneProtocolError(
      'The control-plane origin must be an HTTP(S) URL without credentials or query data.',
    );
  }
  const loopback = parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]' ||
    parsed.hostname === '::1';
  if (parsed.protocol === 'http:' && !loopback) {
    throw new ControlPlaneProtocolError(
      'Bearer credentials require HTTPS except for a loopback development origin.',
    );
  }
  return new URL(parsed.origin);
}

function relativeEndpoint(origin: URL, path: string): URL {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('#')) {
    throw new ControlPlaneProtocolError('The control plane requires an origin-relative endpoint.');
  }
  const endpoint = new URL(path, origin);
  if (endpoint.origin !== origin.origin || endpoint.username || endpoint.password) {
    throw new ControlPlaneProtocolError(
      'The control plane advertised an endpoint outside its configured origin.',
    );
  }
  return endpoint;
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ControlPlaneProtocolError('The control-plane response exceeded the maximum size.');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let body = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      receivedBytes += next.value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel();
        throw new ControlPlaneProtocolError('The control-plane response exceeded the maximum size.');
      }
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const body = await readBoundedText(response, MAX_JSON_BYTES);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ControlPlaneProtocolError('The control plane returned invalid JSON.');
  }
}

function asProtocolError(error: unknown, context: string): ControlPlaneProtocolError {
  if (error instanceof ControlPlaneProtocolError) return error;
  if (error instanceof ProtocolValidationError) {
    return new ControlPlaneProtocolError(`${context}: ${error.message}`);
  }
  return new ControlPlaneProtocolError(context);
}

function streamTermination(response: Response): UiEventStreamTermination {
  if (response.status === 401 || response.status === 403) {
    return { kind: 'authentication_expired' };
  }
  if (response.status === 410) {
    const retentionStart = Number(response.headers.get('x-steward-retention-start'));
    return {
      kind: 'retention_miss',
      retentionStartsAtSequence:
        Number.isSafeInteger(retentionStart) && retentionStart >= 0 ? retentionStart : 0,
    };
  }
  if (response.status === 426) {
    return {
      kind: 'incompatible_protocol',
      supportedVersions: (response.headers.get('x-steward-supported-versions') ?? '')
        .split(',')
        .map((version) => version.trim())
        .filter(Boolean),
    };
  }
  if (response.status === 503 && response.headers.get('x-steward-shutdown') === 'true') {
    return { kind: 'server_shutdown' };
  }
  const retryAfterSeconds = Number(response.headers.get('retry-after'));
  return {
    kind: 'transient_network',
    ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? { retryAfterMs: retryAfterSeconds * 1_000 }
      : {}),
  };
}

function parseEventData(dataLines: readonly string[]): UiEventEnvelope | undefined {
  if (dataLines.length === 0) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(dataLines.join('\n')) as unknown;
  } catch {
    throw new ControlPlaneProtocolError('The event stream returned invalid JSON.');
  }
  try {
    return parseUiEventEnvelope(decoded);
  } catch (error) {
    throw asProtocolError(error, 'The event stream returned an invalid Steward event');
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function createHttpControlPlaneGateway(
  options: HttpControlPlaneGatewayOptions,
): ControlPlaneGateway {
  const origin = configuredOrigin(options.origin);
  const bootstrapEndpoint = relativeEndpoint(
    origin,
    options.bootstrapPath ?? '/v1/ui/bootstrap',
  );
  const humanToken = options.humanToken.trim();
  if (humanToken.length === 0) {
    throw new ControlPlaneProtocolError('A human control-plane token is required.');
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (!fetchImplementation) {
    throw new ControlPlaneTransportError('This browser does not provide fetch.');
  }

  let eventStreamPath: string | undefined;
  let commandPath: string | undefined;

  const authorizationHeaders = {
    Authorization: `Bearer ${humanToken}`,
  } as const;

  async function bootstrap(signal?: AbortSignal): Promise<UiBootstrap> {
    const endpoint = new URL(bootstrapEndpoint);
    endpoint.searchParams.set('workspaceId', String(options.workspaceId));
    const response = await fetchImplementation(endpoint, {
      method: 'GET',
      headers: {
        ...authorizationHeaders,
        Accept: 'application/json',
        'X-Steward-UI-Version': STEWARD_UI_API_VERSION,
      },
      cache: 'no-store',
      credentials: 'omit',
      signal,
    });
    if (!response.ok) {
      throw new ControlPlaneTransportError(
        `Control-plane bootstrap failed with HTTP ${response.status}.`,
        response.status,
      );
    }
    const body = await readBoundedJson(response);
    let validated: UiBootstrap;
    try {
      validated = parseUiBootstrap(body);
    } catch (error) {
      throw asProtocolError(error, 'The control plane returned an invalid bootstrap');
    }
    if (validated.snapshot.workspaceId !== options.workspaceId) {
      throw new ControlPlaneProtocolError('The control plane returned a different workspace.');
    }

    // Resolve both paths before retaining either so a partial bootstrap can never
    // arm one transport endpoint.
    relativeEndpoint(origin, validated.eventStream.href);
    relativeEndpoint(origin, validated.commandEndpoint);
    eventStreamPath = validated.eventStream.href;
    commandPath = validated.commandEndpoint;
    return validated;
  }

  function subscribe(input: {
    readonly afterSequence: number;
    readonly onEvent: (event: UiEventEnvelope) => void;
    readonly onDisconnect: (reason: UiEventStreamTermination) => void;
  }): UiEventSubscription {
    if (!eventStreamPath) {
      throw new ControlPlaneProtocolError('Bootstrap must complete before subscribing.');
    }
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new ControlPlaneProtocolError('The event cursor must be a non-negative safe integer.');
    }
    const subscribedPath = eventStreamPath;

    const controller = new AbortController();
    let closed = false;
    let disconnectReported = false;

    const reportDisconnect = (reason: UiEventStreamTermination) => {
      if (closed || disconnectReported) return;
      disconnectReported = true;
      input.onDisconnect(reason);
    };

    const run = async () => {
      const endpoint = relativeEndpoint(origin, subscribedPath);
      endpoint.searchParams.set('after', String(input.afterSequence));
      const response = await fetchImplementation(endpoint, {
        method: 'GET',
        headers: {
          ...authorizationHeaders,
          Accept: 'text/event-stream',
          'X-Steward-UI-Version': STEWARD_UI_API_VERSION,
        },
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!response.ok) {
        reportDisconnect(streamTermination(response));
        return;
      }
      if (!response.body) {
        reportDisconnect({ kind: 'protocol_error', reason: 'The event stream had no response body.' });
        return;
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('text/event-stream')) {
        await response.body.cancel();
        reportDisconnect({
          kind: 'protocol_error',
          reason: 'The event stream returned an unexpected content type.',
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let pending = '';
      let dataLines: string[] = [];
      let eventName = '';
      let eventBytes = 0;
      let serverEnded = false;

      const acceptLine = (line: string, terminatorBytes: number) => {
        eventBytes += encoder.encode(line).byteLength + terminatorBytes;
        if (eventBytes > MAX_SSE_EVENT_BYTES) {
          throw new ControlPlaneProtocolError('An event-stream message exceeded the maximum size.');
        }
        if (line.length === 0) {
          if (eventName === 'shutdown') {
            serverEnded = true;
          } else if (eventName !== '' && eventName !== 'steward.event') {
            throw new ControlPlaneProtocolError(
              `The event stream returned an unsupported event type: ${eventName}.`,
            );
          }
          const event = serverEnded ? undefined : parseEventData(dataLines);
          dataLines = [];
          eventName = '';
          eventBytes = 0;
          if (event) input.onEvent(event);
          return;
        }
        if (line.startsWith(':')) return;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') dataLines.push(value);
        if (field === 'event') eventName = value;
      };

      const drainLines = (final: boolean) => {
        while (!serverEnded) {
          const lf = pending.indexOf('\n');
          const cr = pending.indexOf('\r');
          let boundary: number;
          if (lf < 0) boundary = cr;
          else if (cr < 0) boundary = lf;
          else boundary = Math.min(lf, cr);
          if (boundary < 0) break;
          if (pending[boundary] === '\r' && boundary === pending.length - 1 && !final) break;
          const hasCrLf = pending[boundary] === '\r' && pending[boundary + 1] === '\n';
          const line = pending.slice(0, boundary);
          pending = pending.slice(boundary + (hasCrLf ? 2 : 1));
          acceptLine(line, hasCrLf ? 2 : 1);
        }
        if (final && pending.length > 0) {
          acceptLine(pending, 0);
          pending = '';
        }
        if (eventBytes + encoder.encode(pending).byteLength > MAX_SSE_EVENT_BYTES) {
          throw new ControlPlaneProtocolError(
            'The event stream did not terminate an oversized message.',
          );
        }
      };

      try {
        while (!closed) {
          const next = await reader.read();
          if (next.done) break;
          pending += decoder.decode(next.value, { stream: true });
          drainLines(false);
          if (serverEnded) {
            await reader.cancel();
            break;
          }
        }
        if (!serverEnded) {
          pending += decoder.decode();
          drainLines(true);
        }
      } finally {
        reader.releaseLock();
      }
      if (!closed) reportDisconnect({ kind: 'server_shutdown' });
    };

    void run().catch((error: unknown) => {
      if (closed || isAbortError(error)) return;
      if (error instanceof ControlPlaneProtocolError || error instanceof ProtocolValidationError) {
        reportDisconnect({ kind: 'protocol_error', reason: error.message });
        return;
      }
      reportDisconnect({ kind: 'transient_network' });
    });

    return {
      close() {
        if (closed) return;
        closed = true;
        controller.abort();
      },
    };
  }

  async function submit(
    commandInput: HumanCommandEnvelope,
    signal?: AbortSignal,
  ): Promise<HumanCommandReceipt> {
    if (!commandPath) {
      throw new ControlPlaneProtocolError('Bootstrap must complete before submitting commands.');
    }
    let command: HumanCommandEnvelope;
    try {
      command = parseHumanCommandEnvelope(commandInput);
    } catch (error) {
      throw asProtocolError(error, 'The command is not a valid Steward command');
    }
    if (command.workspaceId !== options.workspaceId) {
      throw new ControlPlaneProtocolError('A command cannot target another workspace.');
    }
    const response = await fetchImplementation(relativeEndpoint(origin, commandPath), {
      method: 'POST',
      headers: {
        ...authorizationHeaders,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Steward-UI-Version': STEWARD_UI_API_VERSION,
      },
      body: JSON.stringify(command),
      cache: 'no-store',
      credentials: 'omit',
      signal,
    });
    if (response.status >= 500) {
      throw new ControlPlaneTransportError(
        `Control-plane command failed with HTTP ${response.status}.`,
        response.status,
      );
    }
    const body = await readBoundedJson(response);
    let receipt: HumanCommandReceipt;
    try {
      receipt = parseHumanCommandReceipt(body);
    } catch (error) {
      if (!response.ok) {
        throw new ControlPlaneTransportError(
          `Control-plane command failed with HTTP ${response.status}.`,
          response.status,
        );
      }
      throw asProtocolError(error, 'The control plane returned an invalid command receipt');
    }
    if (!response.ok && receipt.state !== 'rejected') {
      throw new ControlPlaneProtocolError(
        'The control plane returned a successful receipt with an error status.',
      );
    }
    if (
      receipt.workspaceId !== command.workspaceId ||
      receipt.clientCommandId !== command.clientCommandId
    ) {
      throw new ControlPlaneProtocolError('The command receipt did not match the submitted command.');
    }
    return receipt;
  }

  return Object.freeze({ bootstrap, subscribe, submit });
}
