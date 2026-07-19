import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertDisjointSupervisorDirectories,
  assertSafeStateDirectory,
  assertSafeWorkingDirectory,
} from "./config.js";

export const SUPERVISOR_LOCK_FILENAME = ".steward-supervisor.lock";

const LOCK_VERSION = 1;
const MAX_LOCK_BYTES = 4 * 1024;
const MAX_ACQUIRE_ATTEMPTS = 8;
const NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LockedResource = "stateDirectory" | "workingDirectory";

interface ProcessLockMetadata {
  version: 1;
  pid: number;
  nonce: string;
  createdAt: string;
  directory: string;
  resources: readonly LockedResource[];
}

interface OwnedProcessLock {
  path: string;
  metadata: ProcessLockMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLockMetadata(value: unknown, expectedDirectory: string): ProcessLockMetadata {
  if (!isRecord(value)) throw new Error("Supervisor lock metadata must be an object");
  const resources = value.resources;
  if (
    value.version !== LOCK_VERSION ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    typeof value.nonce !== "string" ||
    !NONCE_RE.test(value.nonce) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    value.directory !== expectedDirectory ||
    !Array.isArray(resources) ||
    resources.length < 1 ||
    resources.some((resource) => resource !== "stateDirectory" && resource !== "workingDirectory")
  ) {
    throw new Error("Supervisor lock metadata is invalid");
  }
  return {
    version: LOCK_VERSION,
    pid: value.pid as number,
    nonce: value.nonce,
    createdAt: value.createdAt,
    directory: value.directory,
    resources: Object.freeze([...new Set(resources as LockedResource[])]),
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyPresent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means the process exists but belongs to another user. Unknown
    // failures are also treated as live so recovery fails closed.
    return true;
  }
}

async function fsyncDirectory(pathname: string): Promise<void> {
  const handle = await open(pathname, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLockMetadata(pathname: string, expectedDirectory: string): Promise<ProcessLockMetadata> {
  const handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.size < 1 || file.size > MAX_LOCK_BYTES) {
      throw new Error(`Supervisor lock ${pathname} is not a bounded regular file`);
    }
    const text = await handle.readFile("utf8");
    return parseLockMetadata(JSON.parse(text) as unknown, expectedDirectory);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Supervisor lock ${pathname} contains invalid JSON`, { cause: error });
    }
    throw error;
  } finally {
    await handle.close();
  }
}

async function prepareStateDirectory(pathname: string): Promise<string> {
  const requested = assertSafeStateDirectory(pathname);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const entry = await lstat(requested);
  if (entry.isSymbolicLink()) throw new Error("stateDirectory must not be a symbolic link");
  if (!entry.isDirectory()) throw new Error("stateDirectory must be a directory");
  const canonical = assertSafeStateDirectory(await realpath(requested));
  const canonicalEntry = await stat(canonical);
  if (!canonicalEntry.isDirectory()) throw new Error("stateDirectory must resolve to a directory");
  if (typeof process.getuid === "function" && canonicalEntry.uid !== process.getuid()) {
    throw new Error("stateDirectory must be owned by the supervisor process user");
  }
  await chmod(canonical, 0o700);
  return canonical;
}

async function prepareWorkingDirectory(pathname: string): Promise<string> {
  const requested = assertSafeWorkingDirectory(pathname);
  const entry = await lstat(requested);
  if (entry.isSymbolicLink()) throw new Error("workingDirectory must not be a symbolic link");
  if (!entry.isDirectory()) throw new Error("workingDirectory must be an existing directory");
  const canonical = assertSafeWorkingDirectory(await realpath(requested));
  if ((await stat(canonical)).isDirectory()) return canonical;
  throw new Error("workingDirectory must resolve to a directory");
}

async function createLock(
  pathname: string,
  directory: string,
  resources: readonly LockedResource[],
): Promise<OwnedProcessLock> {
  const metadata: ProcessLockMetadata = {
    version: LOCK_VERSION,
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
    directory,
    resources: Object.freeze([...resources]),
  };
  const handle = await open(
    pathname,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const created = await handle.stat();
  let complete = false;
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
    complete = true;
  } finally {
    await handle.close();
    if (!complete) {
      const current = await lstat(pathname).catch(() => null);
      if (current && current.dev === created.dev && current.ino === created.ino) {
        await unlink(pathname).catch(() => undefined);
      }
    }
  }
  const owned = { path: pathname, metadata };
  try {
    await fsyncDirectory(dirname(pathname));
  } catch (error) {
    try {
      await releaseOne(owned);
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], `Unable to durably create or release supervisor lock ${pathname}`);
    }
    throw error;
  }
  return owned;
}

async function acquireOne(
  directory: string,
  resources: readonly LockedResource[],
): Promise<OwnedProcessLock> {
  const pathname = join(directory, SUPERVISOR_LOCK_FILENAME);
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      return await createLock(pathname, directory, resources);
    } catch (error) {
      if (!isAlreadyPresent(error)) throw error;
    }

    let existing: ProcessLockMetadata;
    try {
      existing = await readLockMetadata(pathname, directory);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (isProcessAlive(existing.pid)) {
      throw new Error(
        `Supervisor resource is already locked by PID ${existing.pid}: ${directory}`,
      );
    }

    // Re-read immediately before removing the exact stale file. A changed
    // nonce means another contender replaced it, so retry without deleting.
    let current: ProcessLockMetadata;
    try {
      current = await readLockMetadata(pathname, directory);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (current.pid !== existing.pid || current.nonce !== existing.nonce) continue;
    await unlink(pathname).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
    await fsyncDirectory(directory);
  }
  throw new Error(`Unable to acquire supervisor resource lock after contention: ${directory}`);
}

async function releaseOne(lock: OwnedProcessLock): Promise<void> {
  let current: ProcessLockMetadata;
  try {
    current = await readLockMetadata(lock.path, lock.metadata.directory);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (current.pid !== lock.metadata.pid || current.nonce !== lock.metadata.nonce) {
    throw new Error(`Refusing to release a supervisor lock no longer owned by this process: ${lock.path}`);
  }
  await unlink(lock.path);
  await fsyncDirectory(dirname(lock.path));
}

/**
 * Holds one exact lock file per canonical state/workspace directory. The
 * canonical path makes different aliases for the same directory contend.
 */
export class SupervisorProcessLocks {
  readonly #locks: OwnedProcessLock[];
  #released = false;

  private constructor(locks: OwnedProcessLock[]) {
    this.#locks = locks;
  }

  static async acquire(stateDirectory: string, workingDirectory: string): Promise<SupervisorProcessLocks> {
    const [canonicalState, canonicalWorking] = await Promise.all([
      prepareStateDirectory(stateDirectory),
      prepareWorkingDirectory(workingDirectory),
    ]);
    assertDisjointSupervisorDirectories(canonicalWorking, canonicalState);
    const byDirectory = new Map<string, Set<LockedResource>>();
    for (const [directory, resource] of [
      [canonicalState, "stateDirectory"],
      [canonicalWorking, "workingDirectory"],
    ] as const) {
      const resources = byDirectory.get(directory) ?? new Set<LockedResource>();
      resources.add(resource);
      byDirectory.set(directory, resources);
    }

    const requested = [...byDirectory.entries()]
      .map(([directory, resources]) => ({ directory, resources: [...resources].sort() as LockedResource[] }))
      .sort((left, right) => left.directory.localeCompare(right.directory));
    const acquired: OwnedProcessLock[] = [];
    try {
      for (const request of requested) {
        acquired.push(await acquireOne(request.directory, request.resources));
      }
      return new SupervisorProcessLocks(acquired);
    } catch (error) {
      const releases = await Promise.allSettled(acquired.reverse().map((lock) => releaseOne(lock)));
      const releaseFailures = releases
        .filter((release): release is PromiseRejectedResult => release.status === "rejected")
        .map((release) => release.reason);
      if (releaseFailures.length > 0) {
        throw new AggregateError([error, ...releaseFailures], "Supervisor lock acquisition and rollback failed");
      }
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.#released) return;
    const failures: unknown[] = [];
    for (const lock of [...this.#locks].reverse()) {
      try {
        await releaseOne(lock);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Unable to release all supervisor process locks safely");
    this.#released = true;
  }
}

export function supervisorLockPath(directory: string): string {
  return join(resolve(directory), SUPERVISOR_LOCK_FILENAME);
}
