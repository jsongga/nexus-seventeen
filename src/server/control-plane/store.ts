import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { canonicalJson, contentDigest } from './canonical.js';
import { ServiceError, invariant } from './errors.js';

export type EventActor = 'human' | 'supervisor' | 'runtime' | 'system';

export interface EventDraft {
  eventId: string;
  idempotencyKey?: string;
  kind: string;
  laneId?: string;
  actor: EventActor;
  data: Record<string, unknown>;
  /** Optional authoritative decision time captured by the caller. */
  occurredAt?: string;
}

export interface DurableEvent extends EventDraft {
  schemaVersion: 1;
  workspaceId: string;
  workspaceSequence: number;
  occurredAt: string;
  contentHash: string;
}

export interface AppendEntry {
  event: DurableEvent;
  duplicate: boolean;
}

export interface JsonlStoreOptions {
  path: string;
  workspaceId: string;
  now?: () => Date;
}

interface IdentifierIndexEntry {
  hash: string;
  event: DurableEvent;
}

const BATCH_FRAME_VERSION = 1;
const BATCH_RECORD_TYPE = 'atomic-batch-entry';

interface BatchEventFrame {
  storeFrameVersion: typeof BATCH_FRAME_VERSION;
  recordType: typeof BATCH_RECORD_TYPE;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  event: DurableEvent;
}

interface PendingBatch {
  batchId: string;
  batchSize: number;
  events: DurableEvent[];
  startByte: number;
  startLine: number;
}

function semanticContent(event: EventDraft): Record<string, unknown> {
  return {
    actor: event.actor,
    data: event.data,
    kind: event.kind,
    ...(event.laneId === undefined ? {} : { laneId: event.laneId }),
  };
}

function eventHash(event: EventDraft): string {
  return contentDigest(semanticContent(event));
}

function batchId(events: readonly DurableEvent[]): string {
  return contentDigest({
    storeFrameVersion: BATCH_FRAME_VERSION,
    recordType: BATCH_RECORD_TYPE,
    events,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseDurableEvent(value: unknown, line: number): DurableEvent {
  if (!isRecord(value)) throw new Error(`STORE_CORRUPT: line ${line} is not an object`);
  const actor = value.actor;
  if (!['human', 'supervisor', 'runtime', 'system'].includes(String(actor))) {
    throw new Error(`STORE_CORRUPT: line ${line} has an invalid actor`);
  }
  if (
    value.schemaVersion !== 1 ||
    !nonEmptyString(value.workspaceId) ||
    !Number.isSafeInteger(value.workspaceSequence) ||
    Number(value.workspaceSequence) < 1 ||
    !nonEmptyString(value.occurredAt) ||
    Number.isNaN(Date.parse(value.occurredAt)) ||
    !nonEmptyString(value.eventId) ||
    !nonEmptyString(value.kind) ||
    !isRecord(value.data) ||
    !nonEmptyString(value.contentHash)
  ) {
    throw new Error(`STORE_CORRUPT: line ${line} has an invalid durable event`);
  }
  if (value.idempotencyKey !== undefined && !nonEmptyString(value.idempotencyKey)) {
    throw new Error(`STORE_CORRUPT: line ${line} has an invalid idempotency key`);
  }
  if (value.laneId !== undefined && !nonEmptyString(value.laneId)) {
    throw new Error(`STORE_CORRUPT: line ${line} has an invalid lane id`);
  }

  const event = value as unknown as DurableEvent;
  if (event.contentHash !== eventHash(event)) {
    throw new Error(`STORE_CORRUPT: line ${line} content digest does not match`);
  }
  return event;
}

function parseBatchEventFrame(value: unknown, line: number): BatchEventFrame | undefined {
  if (!isRecord(value) || value.recordType !== BATCH_RECORD_TYPE) return undefined;
  if (
    value.storeFrameVersion !== BATCH_FRAME_VERSION ||
    !nonEmptyString(value.batchId) ||
    !Number.isSafeInteger(value.batchIndex) ||
    Number(value.batchIndex) < 0 ||
    !Number.isSafeInteger(value.batchSize) ||
    Number(value.batchSize) < 2 ||
    Number(value.batchIndex) >= Number(value.batchSize)
  ) {
    throw new Error(`STORE_CORRUPT: line ${line} has an invalid batch frame`);
  }
  return {
    storeFrameVersion: BATCH_FRAME_VERSION,
    recordType: BATCH_RECORD_TYPE,
    batchId: value.batchId,
    batchIndex: Number(value.batchIndex),
    batchSize: Number(value.batchSize),
    event: parseDurableEvent(value.event, line),
  };
}

export class JsonlEventStore {
  readonly records: DurableEvent[] = [];
  readonly #eventIds = new Map<string, IdentifierIndexEntry>();
  readonly #idempotencyKeys = new Map<string, IdentifierIndexEntry>();
  readonly #path: string;
  readonly #lockPath: string;
  readonly #workspaceId: string;
  readonly #now: () => Date;
  #handle: FileHandle | undefined;
  #lockHandle: FileHandle | undefined;
  #lockNonce: string | undefined;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #faulted: Error | undefined;

  private constructor(options: JsonlStoreOptions) {
    this.#path = options.path;
    this.#lockPath = `${options.path}.lock`;
    this.#workspaceId = options.workspaceId;
    this.#now = options.now ?? (() => new Date());
  }

  static async open(options: JsonlStoreOptions): Promise<JsonlEventStore> {
    const store = new JsonlEventStore(options);
    try {
      await store.#initialize();
      return store;
    } catch (error) {
      await store.#handle?.close().catch(() => undefined);
      store.#handle = undefined;
      await store.#releaseLock().catch(() => undefined);
      throw error;
    }
  }

  async #initialize(): Promise<void> {
    const storeDirectory = dirname(this.#path);
    const createdDirectory = await mkdir(storeDirectory, { mode: 0o700, recursive: true });
    if (createdDirectory !== undefined) await chmod(storeDirectory, 0o700);
    await this.#acquireLock();
    this.#handle = await open(
      this.#path,
      constants.O_APPEND |
        constants.O_CREAT |
        constants.O_RDWR |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await this.#handle.chmod(0o600);
    const bytes = await readFile(this.#path);
    let durableBytes = bytes;

    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
      const finalNewline = bytes.lastIndexOf(0x0a);
      const finalStart = finalNewline + 1;
      const finalText = bytes.subarray(finalStart).toString('utf8');
      try {
        JSON.parse(finalText);
        await this.#handle.write('\n');
        await this.#handle.sync();
        durableBytes = Buffer.concat([bytes, Buffer.from('\n')]);
      } catch {
        await this.#handle.truncate(finalStart);
        await this.#handle.sync();
        durableBytes = bytes.subarray(0, finalStart);
      }
    }

    const lines = durableBytes.toString('utf8').split('\n');
    let byteOffset = 0;
    let pendingBatch: PendingBatch | undefined;
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index];
      const lineStart = byteOffset;
      byteOffset += Buffer.byteLength(text ?? '', 'utf8') + 1;
      if (text === undefined || text.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(
          `STORE_CORRUPT: invalid JSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const frame = parseBatchEventFrame(parsed, index + 1);
      if (frame === undefined) {
        if (pendingBatch !== undefined) {
          throw new Error(
            `STORE_CORRUPT: line ${index + 1} interrupts batch started at line ${pendingBatch.startLine}`,
          );
        }
        const event = parseDurableEvent(parsed, index + 1);
        this.#indexLoaded(event, index + 1);
        this.records.push(event);
        continue;
      }

      if (pendingBatch === undefined) {
        if (frame.batchIndex !== 0) {
          throw new Error(`STORE_CORRUPT: line ${index + 1} starts partway through a batch`);
        }
        pendingBatch = {
          batchId: frame.batchId,
          batchSize: frame.batchSize,
          events: [],
          startByte: lineStart,
          startLine: index + 1,
        };
      }
      if (
        frame.batchId !== pendingBatch.batchId ||
        frame.batchSize !== pendingBatch.batchSize ||
        frame.batchIndex !== pendingBatch.events.length
      ) {
        throw new Error(
          `STORE_CORRUPT: line ${index + 1} is not the next entry in batch started at line ${pendingBatch.startLine}`,
        );
      }
      pendingBatch.events.push(frame.event);

      if (pendingBatch.events.length === pendingBatch.batchSize) {
        if (batchId(pendingBatch.events) !== pendingBatch.batchId) {
          throw new Error(
            `STORE_CORRUPT: batch started at line ${pendingBatch.startLine} has an invalid digest`,
          );
        }
        for (let batchIndex = 0; batchIndex < pendingBatch.events.length; batchIndex += 1) {
          const event = pendingBatch.events[batchIndex];
          invariant(event, 'STORE_CORRUPT', 'Complete batch contains no event');
          this.#indexLoaded(event, pendingBatch.startLine + batchIndex);
          this.records.push(event);
        }
        pendingBatch = undefined;
      }
    }

    if (pendingBatch !== undefined) {
      await this.#handle.truncate(pendingBatch.startByte);
      await this.#handle.sync();
    }
  }

  async #acquireLock(): Promise<void> {
    const nonce = randomUUID();
    const owner = {
      pid: process.pid,
      host: hostname(),
      nonce,
      createdAt: new Date().toISOString(),
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.#lockPath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
        await handle.sync();
        this.#lockHandle = handle;
        this.#lockNonce = nonce;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      let staleOwner:
        | { pid: number; host: string; nonce: string; device: number; inode: number }
        | undefined;
      try {
        const candidate = await open(
          this.#lockPath,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        let candidateStat: { dev: number; ino: number };
        let parsed: { pid?: unknown; host?: unknown; nonce?: unknown };
        try {
          candidateStat = await candidate.stat();
          parsed = JSON.parse(await candidate.readFile('utf8')) as typeof parsed;
        } finally {
          await candidate.close();
        }
        if (
          parsed.host === hostname() &&
          Number.isSafeInteger(parsed.pid) &&
          Number(parsed.pid) > 0 &&
          typeof parsed.nonce === 'string' &&
          parsed.nonce.length > 0
        ) {
          try {
            process.kill(Number(parsed.pid), 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              staleOwner = {
                pid: Number(parsed.pid),
                host: parsed.host,
                nonce: parsed.nonce,
                device: candidateStat.dev,
                inode: candidateStat.ino,
              };
            }
          }
        }
      } catch {
        staleOwner = undefined;
      }
      if (staleOwner === undefined) {
        throw new ServiceError(
          503,
          'STORE_ALREADY_LOCKED',
          'Another control-plane writer owns this event store',
        );
      }

      let unchanged = false;
      try {
        const candidate = await open(
          this.#lockPath,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        let candidateStat: { dev: number; ino: number };
        let parsed: { pid?: unknown; host?: unknown; nonce?: unknown };
        try {
          candidateStat = await candidate.stat();
          parsed = JSON.parse(await candidate.readFile('utf8')) as typeof parsed;
        } finally {
          await candidate.close();
        }
        unchanged =
          parsed.pid === staleOwner.pid &&
          parsed.host === staleOwner.host &&
          parsed.nonce === staleOwner.nonce &&
          candidateStat.dev === staleOwner.device &&
          candidateStat.ino === staleOwner.inode;
      } catch {
        unchanged = false;
      }
      if (!unchanged) continue;
      await unlink(this.#lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    throw new ServiceError(503, 'STORE_ALREADY_LOCKED', 'Unable to acquire the event-store lock');
  }

  async #releaseLock(): Promise<void> {
    await this.#lockHandle?.close();
    this.#lockHandle = undefined;
    const nonce = this.#lockNonce;
    this.#lockNonce = undefined;
    if (nonce === undefined) return;
    try {
      const parsed = JSON.parse(await readFile(this.#lockPath, 'utf8')) as {
        nonce?: unknown;
      };
      if (parsed.nonce === nonce) await unlink(this.#lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  #indexLoaded(event: DurableEvent, line: number): void {
    const expectedSequence = this.records.length + 1;
    if (event.workspaceId !== this.#workspaceId) {
      throw new Error(`STORE_CORRUPT: line ${line} belongs to another workspace`);
    }
    if (event.workspaceSequence !== expectedSequence) {
      throw new Error(
        `STORE_CORRUPT: line ${line} sequence ${event.workspaceSequence} is not ${expectedSequence}`,
      );
    }
    if (this.#eventIds.has(event.eventId)) {
      throw new Error(`STORE_CORRUPT: duplicate event id at line ${line}`);
    }
    if (event.idempotencyKey !== undefined && this.#idempotencyKeys.has(event.idempotencyKey)) {
      throw new Error(`STORE_CORRUPT: duplicate idempotency key at line ${line}`);
    }
    const entry = { event, hash: event.contentHash };
    this.#eventIds.set(event.eventId, entry);
    if (event.idempotencyKey !== undefined) this.#idempotencyKeys.set(event.idempotencyKey, entry);
  }

  append(drafts: readonly EventDraft[]): Promise<readonly AppendEntry[]> {
    if (this.#closed) {
      return Promise.reject(new ServiceError(503, 'SERVICE_DRAINING', 'The durable store is closed'));
    }
    if (this.#faulted !== undefined) {
      return Promise.reject(
        new ServiceError(
          503,
          'STORE_FAULTED',
          'The durable store requires a safe reopen after a failed write',
        ),
      );
    }
    const operation = this.#tail.then(() => this.#appendSerialized(drafts));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  findDuplicate(draft: EventDraft): DurableEvent | undefined {
    const hash = eventHash(draft);
    const byEvent = this.#eventIds.get(draft.eventId);
    const byKey =
      draft.idempotencyKey === undefined
        ? undefined
        : this.#idempotencyKeys.get(draft.idempotencyKey);
    for (const [identifier, existing] of [
      [`event id ${draft.eventId}`, byEvent],
      [
        draft.idempotencyKey === undefined
          ? 'idempotency key'
          : `idempotency key ${draft.idempotencyKey}`,
        byKey,
      ],
    ] as const) {
      if (existing !== undefined && existing.hash !== hash) {
        throw new ServiceError(
          409,
          'IDEMPOTENCY_CONFLICT',
          `Reused ${identifier} has different content`,
        );
      }
    }
    if (byEvent !== undefined && byKey !== undefined && byEvent.event !== byKey.event) {
      throw new ServiceError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'Event id and idempotency key refer to different committed events',
      );
    }
    return byEvent?.event ?? byKey?.event;
  }

  getByEventId(eventId: string): DurableEvent | undefined {
    return this.#eventIds.get(eventId)?.event;
  }

  async #appendSerialized(drafts: readonly EventDraft[]): Promise<readonly AppendEntry[]> {
    invariant(this.#handle, 'STORE_NOT_OPEN', 'Store file handle is missing');
    if (drafts.length === 0) return [];

    const results: AppendEntry[] = [];
    const newEvents: DurableEvent[] = [];
    const pendingEventIds = new Map<string, IdentifierIndexEntry>();
    const pendingIdempotency = new Map<string, IdentifierIndexEntry>();

    for (const draft of drafts) {
      const hash = eventHash(draft);
      const byEvent = pendingEventIds.get(draft.eventId) ?? this.#eventIds.get(draft.eventId);
      const byKey =
        draft.idempotencyKey === undefined
          ? undefined
          : pendingIdempotency.get(draft.idempotencyKey) ??
            this.#idempotencyKeys.get(draft.idempotencyKey);
      for (const [identifier, existing] of [
        [`event id ${draft.eventId}`, byEvent],
        [
          draft.idempotencyKey === undefined
            ? 'idempotency key'
            : `idempotency key ${draft.idempotencyKey}`,
          byKey,
        ],
      ] as const) {
        if (existing !== undefined && existing.hash !== hash) {
          throw new ServiceError(
            409,
            'IDEMPOTENCY_CONFLICT',
            `Reused ${identifier} has different content`,
          );
        }
      }
      const duplicate = byEvent?.event ?? byKey?.event;
      if (duplicate !== undefined) {
        if (byEvent !== undefined && byKey !== undefined && byEvent.event !== byKey.event) {
          throw new ServiceError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Event id and idempotency key refer to different committed events',
          );
        }
        results.push({ duplicate: true, event: duplicate });
        continue;
      }

      const occurredAt = draft.occurredAt ?? this.#now().toISOString();
      const parsedOccurredAt = new Date(occurredAt);
      if (Number.isNaN(parsedOccurredAt.valueOf()) || parsedOccurredAt.toISOString() !== occurredAt) {
        throw new Error('EVENT_OCCURRENCE_INVALID');
      }
      const { occurredAt: _requestedOccurredAt, ...durableDraft } = draft;
      const event: DurableEvent = {
        schemaVersion: 1,
        workspaceId: this.#workspaceId,
        workspaceSequence: this.records.length + newEvents.length + 1,
        occurredAt,
        ...durableDraft,
        contentHash: hash,
      };
      const entry = { event, hash };
      pendingEventIds.set(event.eventId, entry);
      if (event.idempotencyKey !== undefined) {
        pendingIdempotency.set(event.idempotencyKey, entry);
      }
      newEvents.push(event);
      results.push({ duplicate: false, event });
    }

    if (newEvents.length > 0) {
      const newBatchId = batchId(newEvents);
      const persistedRecords: readonly (DurableEvent | BatchEventFrame)[] =
        newEvents.length === 1
          ? newEvents
          : newEvents.map((event, batchIndex): BatchEventFrame => ({
              storeFrameVersion: BATCH_FRAME_VERSION,
              recordType: BATCH_RECORD_TYPE,
              batchId: newBatchId,
              batchIndex,
              batchSize: newEvents.length,
              event,
            }));
      const bytes = Buffer.from(
        persistedRecords.map((record) => `${canonicalJson(record)}\n`).join(''),
        'utf8',
      );
      const preAppendSize = (await this.#handle.stat()).size;
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const result = await this.#handle.write(bytes, offset, bytes.length - offset, null);
          if (result.bytesWritten === 0) throw new Error('STORE_WRITE_STALLED');
          offset += result.bytesWritten;
        }
        await this.#handle.sync();
      } catch (error) {
        try {
          await this.#handle.truncate(preAppendSize);
          await this.#handle.sync();
        } catch (rollbackError) {
          this.#faulted = new AggregateError(
            [error, rollbackError],
            'STORE_WRITE_AND_ROLLBACK_FAILED',
          );
        }
        throw error;
      }
      for (const event of newEvents) {
        this.records.push(event);
        const entry = { event, hash: event.contentHash };
        this.#eventIds.set(event.eventId, entry);
        if (event.idempotencyKey !== undefined) {
          this.#idempotencyKeys.set(event.idempotencyKey, entry);
        }
      }
    }

    return results;
  }

  async drain(): Promise<void> {
    await this.#tail;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    await this.#handle?.close();
    this.#handle = undefined;
    await this.#releaseLock();
  }

  async byteLength(): Promise<number> {
    return (await stat(this.#path)).size;
  }
}
