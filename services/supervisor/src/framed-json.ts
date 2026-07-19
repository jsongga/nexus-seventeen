import { TextDecoder } from "node:util";
import type { Readable, Writable } from "node:stream";

export const MAX_PROVIDER_FRAME_BYTES = 256 * 1024;
const MAX_QUEUED_FRAMES = 32;

export class FramedJsonProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FramedJsonProtocolError";
  }
}

type FrameWaiter = {
  resolve(value: IteratorResult<unknown>): void;
  reject(error: unknown): void;
};

export class FramedJsonReader implements AsyncIterableIterator<unknown> {
  readonly #readable: Readable;
  readonly #maxFrameBytes: number;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #buffer = Buffer.alloc(0);
  #queue: unknown[] = [];
  #waiters: FrameWaiter[] = [];
  #ended = false;
  #failure: unknown | null = null;

  constructor(readable: Readable, maxFrameBytes = MAX_PROVIDER_FRAME_BYTES) {
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1_024 || maxFrameBytes > 4 * 1024 * 1024) {
      throw new Error("maxFrameBytes must be between 1024 and 4194304");
    }
    this.#readable = readable;
    this.#maxFrameBytes = maxFrameBytes;
    readable.on("data", (chunk: Buffer | string) => this.#receive(chunk));
    readable.once("end", () => this.#finish());
    readable.once("close", () => this.#finish());
    readable.once("error", (error) => this.#fail(error));
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
    return this;
  }

  next(): Promise<IteratorResult<unknown>> {
    if (this.#queue.length > 0) {
      return Promise.resolve({ value: this.#queue.shift(), done: false });
    }
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  destroy(error?: Error): void {
    if (error) this.#fail(error);
    this.#readable.destroy(error);
  }

  #receive(chunkValue: Buffer | string): void {
    if (this.#ended || this.#failure) return;
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    const maximumBuffered = (this.#maxFrameBytes + 4) * 2;
    if (this.#buffer.length + chunk.length > maximumBuffered) {
      this.#fail(new FramedJsonProtocolError("Provider frame buffer exceeded its fixed bound"));
      this.#readable.destroy();
      return;
    }
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > this.#maxFrameBytes) {
        this.#fail(new FramedJsonProtocolError(`Provider frame length ${length} is outside the allowed range`));
        this.#readable.destroy();
        return;
      }
      if (this.#buffer.length < length + 4) return;
      const payload = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      let value: unknown;
      try {
        value = JSON.parse(this.#decoder.decode(payload));
      } catch (error) {
        this.#fail(new FramedJsonProtocolError("Provider frame is not valid UTF-8 JSON", { cause: error }));
        this.#readable.destroy();
        return;
      }
      this.#deliver(value);
      if (this.#failure) return;
    }
  }

  #deliver(value: unknown): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }
    if (this.#queue.length >= MAX_QUEUED_FRAMES) {
      this.#fail(new FramedJsonProtocolError("Provider sent too many unconsumed frames"));
      this.#readable.destroy();
      return;
    }
    this.#queue.push(value);
  }

  #finish(): void {
    if (this.#ended || this.#failure) return;
    if (this.#buffer.length !== 0) {
      this.#fail(new FramedJsonProtocolError("Provider transport ended with a partial frame"));
      return;
    }
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  #fail(error: unknown): void {
    if (this.#failure || this.#ended) return;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}

export class FramedJsonWriter {
  readonly #writable: Writable;
  readonly #maxFrameBytes: number;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(writable: Writable, maxFrameBytes = MAX_PROVIDER_FRAME_BYTES) {
    this.#writable = writable;
    this.#maxFrameBytes = maxFrameBytes;
  }

  send(value: unknown): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Provider frame writer is closed"));
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      return Promise.reject(new FramedJsonProtocolError("Provider message is not JSON serializable", { cause: error }));
    }
    if (serialized === undefined) {
      return Promise.reject(new FramedJsonProtocolError("Provider message must serialize to a JSON value"));
    }
    const payload = Buffer.from(serialized, "utf8");
    if (payload.length === 0 || payload.length > this.#maxFrameBytes) {
      return Promise.reject(new FramedJsonProtocolError(`Provider message exceeds ${this.#maxFrameBytes} bytes`));
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.length, 0);
    const frame = Buffer.concat([header, payload]);
    const write = this.#tail.then(() => new Promise<void>((resolve, reject) => {
      this.#writable.write(frame, (error) => error ? reject(error) : resolve());
    }));
    this.#tail = write.catch(() => undefined);
    return write;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    await new Promise<void>((resolve) => this.#writable.end(resolve));
  }
}
