import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { canonicalJson, sha256 } from "./canonical.js";
import { parseStoredEvent } from "./schema.js";
import type { EventDraft, StoredEvent } from "./types.js";

interface StoreOptions {
  readonly path: string;
}

interface LockRecord {
  readonly pid: number;
  readonly nonce: string;
  readonly createdAt: string;
}

function parseLock(text: string): LockRecord {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("DEPLOYMENT_GRANT_STORE_LOCK_INVALID");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isSafeInteger((value as Record<string, unknown>).pid) ||
    Number((value as Record<string, unknown>).pid) < 1 ||
    typeof (value as Record<string, unknown>).nonce !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(String((value as Record<string, unknown>).nonce)) ||
    typeof (value as Record<string, unknown>).createdAt !== "string"
  ) {
    throw new Error("DEPLOYMENT_GRANT_STORE_LOCK_INVALID");
  }
  return {
    pid: Number((value as Record<string, unknown>).pid),
    nonce: String((value as Record<string, unknown>).nonce),
    createdAt: String((value as Record<string, unknown>).createdAt),
  };
}

export class DeploymentGrantStore {
  readonly #records: StoredEvent[] = [];
  readonly #path: string;
  readonly #lockPath: string;
  readonly #eventIds = new Set<string>();
  readonly #idempotencyKeys = new Set<string>();
  #handle: FileHandle | undefined;
  #lockHandle: FileHandle | undefined;
  #lockRecord: LockRecord | undefined;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #faulted: Error | undefined;

  private constructor(options: StoreOptions) {
    this.#path = options.path;
    this.#lockPath = `${options.path}.lock`;
  }

  get records(): readonly StoredEvent[] {
    return this.#records;
  }

  static async open(options: StoreOptions): Promise<DeploymentGrantStore> {
    const store = new DeploymentGrantStore(options);
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
    if (!isAbsolute(this.#path)) throw new Error("DEPLOYMENT_GRANT_STORE_PATH_NOT_ABSOLUTE");
    const directory = dirname(this.#path);
    const created = await mkdir(directory, { recursive: true, mode: 0o700 });
    if (created !== undefined) await chmod(directory, 0o700);
    const directoryEntry = await lstat(directory);
    if (
      !directoryEntry.isDirectory() ||
      directoryEntry.isSymbolicLink() ||
      (typeof process.getuid === "function" && directoryEntry.uid !== process.getuid()) ||
      (directoryEntry.mode & 0o077) !== 0
    ) {
      throw new Error("DEPLOYMENT_GRANT_STORE_DIRECTORY_UNSAFE");
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
      throw new Error("DEPLOYMENT_GRANT_STORE_FILE_UNSAFE");
    }
    await this.#syncDirectory(directory);
    let bytes = await this.#handle.readFile();
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
      const finalNewline = bytes.lastIndexOf(0x0a);
      const finalStart = finalNewline + 1;
      const tail = bytes.subarray(finalStart).toString("utf8");
      try {
        JSON.parse(tail);
        await this.#handle.write("\n");
        await this.#handle.sync();
        bytes = Buffer.concat([bytes, Buffer.from("\n")]);
      } catch {
        await this.#handle.truncate(finalStart);
        await this.#handle.sync();
        bytes = bytes.subarray(0, finalStart);
      }
    }
    const lines = bytes.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]!.length === 0) {
        throw new Error(`DEPLOYMENT_GRANT_STORE_CORRUPT: empty record at line ${index + 1}`);
      }
      let value: unknown;
      try {
        value = JSON.parse(lines[index]!) as unknown;
      } catch {
        throw new Error(`DEPLOYMENT_GRANT_STORE_CORRUPT: invalid JSON at line ${index + 1}`);
      }
      const event = parseStoredEvent(value, index + 1);
      this.#index(event, index + 1);
      this.#records.push(event);
    }
  }

  async #syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #acquireLock(): Promise<void> {
    const record: LockRecord = {
      pid: process.pid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    let handle: FileHandle;
    try {
      handle = await open(
        this.#lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("DEPLOYMENT_GRANT_STORE_LOCKED: explicit operator stale-lock recovery required");
      }
      throw error;
    }
    try {
      await handle.writeFile(`${canonicalJson(record)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(this.#lockPath).catch(() => undefined);
      throw error;
    }
    this.#lockHandle = handle;
    this.#lockRecord = record;
  }

  #index(event: StoredEvent, line: number): void {
    if (this.#eventIds.has(event.eventId)) {
      throw new Error(`DEPLOYMENT_GRANT_STORE_CORRUPT: duplicate event id at line ${line}`);
    }
    const scopedKey = `${event.idempotencyScope}\u0000${event.idempotencyKey}`;
    if (this.#idempotencyKeys.has(scopedKey)) {
      throw new Error(`DEPLOYMENT_GRANT_STORE_CORRUPT: duplicate idempotency key at line ${line}`);
    }
    this.#eventIds.add(event.eventId);
    this.#idempotencyKeys.add(scopedKey);
  }

  async append(draft: EventDraft): Promise<StoredEvent> {
    return this.#serialize(async () => {
      if (this.#closed) throw new Error("DEPLOYMENT_GRANT_STORE_CLOSED");
      if (this.#faulted !== undefined) throw this.#faulted;
      const handle = this.#handle;
      if (handle === undefined) throw new Error("DEPLOYMENT_GRANT_STORE_NOT_OPEN");
      const sequence = this.#records.length + 1;
      const withoutHash = Object.freeze({ storeVersion: 3 as const, sequence, ...draft });
      const event = parseStoredEvent(
        Object.freeze({ ...withoutHash, contentHash: sha256(withoutHash) }),
        sequence,
      );
      this.#index(event, sequence);
      const line = Buffer.from(`${canonicalJson(event)}\n`, "utf8");
      const before = (await handle.stat()).size;
      try {
        let offset = 0;
        while (offset < line.length) {
          const result = await handle.write(line, offset, line.length - offset);
          if (result.bytesWritten < 1) throw new Error("Deployment grant store made no write progress");
          offset += result.bytesWritten;
        }
        await handle.sync();
      } catch (error) {
        try {
          await handle.truncate(before);
          await handle.sync();
        } catch (rollbackError) {
          this.#faulted = new Error("DEPLOYMENT_GRANT_STORE_FAULTED", { cause: rollbackError });
        }
        this.#eventIds.delete(event.eventId);
        this.#idempotencyKeys.delete(`${event.idempotencyScope}\u0000${event.idempotencyKey}`);
        throw error;
      }
      this.#records.push(event);
      return event;
    });
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
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    const handle = this.#handle;
    this.#handle = undefined;
    await handle?.sync();
    await handle?.close();
    await this.#releaseLock();
  }

  async #releaseLock(): Promise<void> {
    const handle = this.#lockHandle;
    const record = this.#lockRecord;
    this.#lockHandle = undefined;
    this.#lockRecord = undefined;
    await handle?.close();
    if (record === undefined) return;
    try {
      const info = await lstat(this.#lockPath);
      if (!info.isFile() || info.isSymbolicLink()) return;
      const current = parseLock(await readFile(this.#lockPath, "utf8"));
      if (current.nonce === record.nonce && current.pid === record.pid) await unlink(this.#lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
