export interface SseEvent {
  event: string;
  id: string | null;
  data: string;
}

interface SseFrameParserOptions {
  maximumFrameLength: number;
  onEvent: (event: SseEvent) => void;
  sizeLimitError?: () => Error;
}

const frameBoundary = /\r?\n\r?\n/u;
const incompleteBoundaryPrefixes = ['\r\n\r', '\r\n', '\n\r', '\r', '\n'] as const;

function parseEvent(frame: string): SseEvent {
  let event = 'message';
  let id: string | null = null;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (line === '' || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  return { event, id, data: data.join('\n') };
}

function possibleBoundarySuffixLength(value: string): number {
  return incompleteBoundaryPrefixes.find((prefix) => value.endsWith(prefix))?.length ?? 0;
}

/** Incrementally frames and parses one server-sent event stream. */
export class SseFrameParser {
  readonly #maximumFrameLength: number;
  readonly #onEvent: (event: SseEvent) => void;
  readonly #sizeLimitError: () => Error;
  #pending = '';
  #finished = false;

  constructor(options: SseFrameParserOptions) {
    if (!Number.isSafeInteger(options.maximumFrameLength) || options.maximumFrameLength < 1) {
      throw new Error('The SSE frame size limit must be a positive safe integer');
    }
    this.#maximumFrameLength = options.maximumFrameLength;
    this.#onEvent = options.onEvent;
    this.#sizeLimitError = options.sizeLimitError ?? (() => new Error('An SSE event exceeded the size limit'));
  }

  push(chunk: string): void {
    if (this.#finished) throw new Error('The SSE parser has already finished');
    this.#pending += chunk;
    let boundary = frameBoundary.exec(this.#pending);
    while (boundary) {
      const frame = this.#pending.slice(0, boundary.index);
      this.#pending = this.#pending.slice(boundary.index + boundary[0].length);
      this.#dispatch(frame);
      boundary = frameBoundary.exec(this.#pending);
    }
    const possibleDelimiterLength = possibleBoundarySuffixLength(this.#pending);
    if (this.#pending.length - possibleDelimiterLength > this.#maximumFrameLength) {
      throw this.#sizeLimitError();
    }
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#pending.length > this.#maximumFrameLength) throw this.#sizeLimitError();
    this.#dispatch(this.#pending);
    this.#pending = '';
  }

  #dispatch(frame: string): void {
    if (frame.length > this.#maximumFrameLength) throw this.#sizeLimitError();
    if (frame.trim().length > 0) this.#onEvent(parseEvent(frame));
  }
}
