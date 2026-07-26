import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { emptyTaskWorkerJournal, parseTaskWorkerJournal } from "./schema.js";
import type { TaskWorkerIdentity, TaskWorkerJournal } from "./types.js";

const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;

function ownedByProcess(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

async function requirePrivateDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || !ownedByProcess(entry.uid)) {
    throw new Error("Task worker state directory must be a private process-owned directory");
  }
}

async function readJournal(path: string): Promise<unknown | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const entry = await handle.stat();
    if (
      !entry.isFile() || entry.size < 1 || entry.size > MAX_JOURNAL_BYTES ||
      (entry.mode & 0o077) !== 0 || !ownedByProcess(entry.uid)
    ) {
      throw new Error("Task worker journal must be a private bounded process-owned file");
    }
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Task worker journal contains invalid JSON", { cause: error });
    throw error;
  } finally {
    await handle.close();
  }
}

export class TaskWorkerJournalStore {
  readonly #path: string;
  readonly #identity: TaskWorkerIdentity;
  #state: TaskWorkerJournal;
  #tail: Promise<void> = Promise.resolve();

  private constructor(path: string, identity: TaskWorkerIdentity, state: TaskWorkerJournal) {
    this.#path = path;
    this.#identity = identity;
    this.#state = state;
  }

  static async open(path: string, identity: TaskWorkerIdentity): Promise<TaskWorkerJournalStore> {
    const directory = dirname(path);
    const created = await mkdir(directory, { recursive: true, mode: 0o700 });
    if (created !== undefined) await chmod(directory, 0o700);
    await requirePrivateDirectory(directory);
    const stored = await readJournal(path);
    return new TaskWorkerJournalStore(
      path,
      identity,
      stored === null ? emptyTaskWorkerJournal(identity) : parseTaskWorkerJournal(stored, identity),
    );
  }

  get current(): TaskWorkerJournal {
    return structuredClone(this.#state);
  }

  async save(value: TaskWorkerJournal): Promise<void> {
    const parsed = parseTaskWorkerJournal(value, this.#identity);
    const previous = this.#tail;
    let release: (() => void) | undefined;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.#writeAtomically(`${JSON.stringify(parsed)}\n`);
      this.#state = parsed;
    } finally {
      release?.();
    }
  }

  async #writeAtomically(content: string): Promise<void> {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#path);
      const directory = await open(dirname(this.#path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#tail;
  }
}
