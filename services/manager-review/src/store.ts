import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { canonicalJson, sha256 } from "./canonical.js";
import { ReviewServiceError } from "./errors.js";
import { GENESIS_HASH, parseStoredEvent } from "./schema.js";
import type { EventDraft, StoredEvent } from "./types.js";

interface LockRecord {
  readonly pid: number;
  readonly nonce: string;
}

function parseLock(value: string): LockRecord {
  try {
    const parsed = JSON.parse(value) as Partial<LockRecord>;
    if (
      !Number.isSafeInteger(parsed.pid) ||
      Number(parsed.pid) < 1 ||
      typeof parsed.nonce !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(parsed.nonce)
    ) {
      throw new Error("invalid");
    }
    return { pid: Number(parsed.pid), nonce: parsed.nonce };
  } catch {
    throw new ReviewServiceError(500, "REVIEW_STORE_LOCK_INVALID", "Manager review store lock is invalid");
  }
}

export class ReviewEventStore {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #records: StoredEvent[] = [];
  readonly #eventIds = new Set<string>();
  readonly #idempotency = new Set<string>();
  #handle: FileHandle | null = null;
  #lockHandle: FileHandle | null = null;
  #lock: LockRecord | null = null;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(path: string) {
    this.#path = path;
    this.#lockPath = `${path}.lock`;
  }

  get records(): readonly StoredEvent[] {
    return this.#records;
  }

  static async open(path: string): Promise<ReviewEventStore> {
    if (!isAbsolute(path)) {
      throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Manager review store path must be absolute");
    }
    const store = new ReviewEventStore(path);
    try {
      await store.#initialize();
      return store;
    } catch (error) {
      await store.#handle?.close().catch(() => undefined);
      await store.#releaseLock().catch(() => undefined);
      throw error;
    }
  }

  async #initialize(): Promise<void> {
    const directory = dirname(this.#path);
    const created = await mkdir(directory, { recursive: true, mode: 0o700 });
    if (created !== undefined) await chmod(directory, 0o700);
    const directoryEntry = await lstat(directory);
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
      throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Manager review store directory is unsafe");
    }
    if (typeof process.getuid === "function" && directoryEntry.uid !== process.getuid()) {
      throw new ReviewServiceError(500, "INVALID_CONFIGURATION", "Manager review store directory has another owner");
    }
    if ((directoryEntry.mode & 0o077) !== 0) {
      throw new ReviewServiceError(
        500,
        "INVALID_CONFIGURATION",
        "Manager review store directory must be owner-only",
      );
    }
    await this.#acquireLock();
    this.#handle = await open(
      this.#path,
      constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const fileEntry = await this.#handle.stat();
    if (
      !fileEntry.isFile() ||
      fileEntry.nlink !== 1 ||
      (typeof process.getuid === "function" && fileEntry.uid !== process.getuid()) ||
      (fileEntry.mode & 0o077) !== 0
    ) {
      throw new ReviewServiceError(
        500,
        "INVALID_CONFIGURATION",
        "Manager review store file must be regular, singly linked, owner-owned, and owner-only",
      );
    }
    let bytes = await this.#handle.readFile();
    if (bytes.length > 0 && bytes.at(-1) !== 0x0a) {
      const finalNewline = bytes.lastIndexOf(0x0a);
      const tailStart = finalNewline + 1;
      const tail = bytes.subarray(tailStart).toString("utf8");
      try {
        JSON.parse(tail);
        await this.#handle.write("\n");
        await this.#handle.sync();
        bytes = Buffer.concat([bytes, Buffer.from("\n")]);
      } catch {
        await this.#handle.truncate(tailStart);
        await this.#handle.sync();
        bytes = bytes.subarray(0, tailStart);
      }
    }
    const lines = bytes.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    let previousHash = GENESIS_HASH;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]!.length === 0) {
        throw new ReviewServiceError(500, "REVIEW_STORE_CORRUPT", `Empty event at line ${index + 1}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[index]!) as unknown;
      } catch {
        throw new ReviewServiceError(500, "REVIEW_STORE_CORRUPT", `Invalid JSON at line ${index + 1}`);
      }
      const event = parseStoredEvent(parsed, index + 1, previousHash);
      this.#index(event);
      this.#records.push(event);
      previousHash = event.contentHash;
    }
  }

  async #acquireLock(): Promise<void> {
    const lock: LockRecord = { pid: process.pid, nonce: randomUUID() };
    let handle: FileHandle;
    try {
      handle = await open(
        this.#lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ReviewServiceError(
          500,
          "REVIEW_STORE_LOCKED",
          "Manager review store is locked; stale-lock recovery requires explicit operator verification",
        );
      }
      throw error;
    }
    await handle.writeFile(`${canonicalJson(lock)}\n`, "utf8");
    await handle.sync();
    this.#lock = lock;
    this.#lockHandle = handle;
  }

  #index(event: StoredEvent): void {
    const scopedKey = `${event.idempotencyScope}\u0000${event.idempotencyKey}`;
    if (this.#eventIds.has(event.eventId) || this.#idempotency.has(scopedKey)) {
      throw new ReviewServiceError(500, "REVIEW_STORE_CORRUPT", "Duplicate event or idempotency identity");
    }
    this.#eventIds.add(event.eventId);
    this.#idempotency.add(scopedKey);
  }

  append(draft: EventDraft): Promise<StoredEvent> {
    return this.#serialize(async () => {
      if (this.#closed || !this.#handle) throw new Error("MANAGER_REVIEW_STORE_CLOSED");
      const sequence = this.#records.length + 1;
      const previousHash = this.#records.at(-1)?.contentHash ?? GENESIS_HASH;
      const withoutHash = Object.freeze({
        storeVersion: 1 as const,
        sequence,
        previousHash,
        ...draft,
      });
      const event = parseStoredEvent(
        { ...withoutHash, contentHash: sha256(withoutHash) },
        sequence,
        previousHash,
      );
      const line = Buffer.from(`${canonicalJson(event)}\n`, "utf8");
      const before = (await this.#handle.stat()).size;
      try {
        let offset = 0;
        while (offset < line.length) {
          const written = await this.#handle.write(line, offset, line.length - offset);
          if (written.bytesWritten < 1) throw new Error("Manager review store made no write progress");
          offset += written.bytesWritten;
        }
        await this.#handle.sync();
      } catch (error) {
        await this.#handle.truncate(before).catch(() => undefined);
        await this.#handle.sync().catch(() => undefined);
        throw error;
      }
      this.#index(event);
      this.#records.push(event);
      return event;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    await this.#handle?.close();
    this.#handle = null;
    await this.#releaseLock();
  }

  async #releaseLock(): Promise<void> {
    const handle = this.#lockHandle;
    const lock = this.#lock;
    this.#lockHandle = null;
    this.#lock = null;
    await handle?.close();
    if (!lock) return;
    try {
      const current = parseLock(await readFile(this.#lockPath, "utf8"));
      if (current.pid === lock.pid && current.nonce === lock.nonce) {
        await unlink(this.#lockPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
