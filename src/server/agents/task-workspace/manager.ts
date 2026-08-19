import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RETAINED_TIMESTAMP_PATTERN = /-([0-9]+)$/u;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETAINED_LIMIT = 5;

export interface TaskWorkspaceManagerOptions {
  /** Directory that holds one sub-directory per task workspace. Created if missing. Absolute. */
  readonly workspaceRoot: string;
  /** The source repository workspaces are cloned from and harvested into. Absolute. */
  readonly repositoryPath: string;
  /** Failed workspaces kept for debugging; oldest pruned beyond this. Default 5. */
  readonly retainedLimit?: number;
}

export class TaskWorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskWorkspaceError";
  }
}

function git(cwd: string | null, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-c", "core.fsmonitor=", "-c", "core.hooksPath=", ...args], {
      ...(cwd === null ? {} : { cwd }),
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BYTES,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new TaskWorkspaceError(`git ${args[0]} failed: ${stderr.slice(0, 2_000)}`, { cause: error }));
        return;
      }
      resolve(stdout);
    });
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function retainedTimestamp(name: string): number {
  const match = RETAINED_TIMESTAMP_PATTERN.exec(name);
  if (match === null) return Number.NEGATIVE_INFINITY;
  const timestamp = Number(match[1]);
  return Number.isSafeInteger(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

export class TaskWorkspaceManager {
  readonly #workspaceRoot: string;
  readonly #repositoryPath: string;
  readonly #retainedLimit: number;

  constructor(options: TaskWorkspaceManagerOptions) {
    if (!isAbsolute(options.workspaceRoot)) {
      throw new TaskWorkspaceError("workspaceRoot must be absolute");
    }
    if (!isAbsolute(options.repositoryPath)) {
      throw new TaskWorkspaceError("repositoryPath must be absolute");
    }
    const retainedLimit = options.retainedLimit ?? DEFAULT_RETAINED_LIMIT;
    if (!Number.isInteger(retainedLimit) || retainedLimit < 0 || retainedLimit > 64) {
      throw new TaskWorkspaceError("retainedLimit must be an integer from 0 through 64");
    }
    this.#workspaceRoot = options.workspaceRoot;
    this.#repositoryPath = options.repositoryPath;
    this.#retainedLimit = retainedLimit;
  }

  #key(key: string): string {
    if (
      !KEY_PATTERN.test(key)
      || key.includes("..")
      || key.endsWith(".")
      || key.startsWith("retained-")
    ) {
      throw new TaskWorkspaceError(`Invalid task workspace key: ${key}`);
    }
    return key;
  }

  workspacePath(key: string): string {
    const path = join(this.#workspaceRoot, this.#key(key));
    const relativePath = relative(this.#workspaceRoot, path);
    if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new TaskWorkspaceError(`Task workspace path escapes workspaceRoot: ${key}`);
    }
    return path;
  }

  async create(key: string, baseRef?: string): Promise<string> {
    const path = this.workspacePath(key);
    await mkdir(this.#workspaceRoot, { recursive: true });
    await rm(path, { recursive: true, force: true });
    try {
      await git(null, ["clone", "--no-hardlinks", this.#repositoryPath, path]);
      const branch = `task/${this.#key(key)}`;
      const existing = (await git(path, [
        "branch", "--remotes", "--list", `origin/${branch}`,
      ])).trim().length > 0;
      if (existing) {
        await git(path, ["switch", branch]);
      } else {
        if (baseRef !== undefined) await git(path, ["switch", "--detach", baseRef]);
        await git(path, ["switch", "-c", branch]);
      }
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
    return path;
  }

  async harvest(key: string): Promise<void> {
    const branch = `task/${this.#key(key)}`;
    await git(this.#repositoryPath, ["fetch", this.workspacePath(key), `+${branch}:${branch}`]);
  }

  async hasUncommittedChanges(key: string): Promise<boolean> {
    return (await git(this.workspacePath(key), ["status", "--porcelain"])).trim().length > 0;
  }

  async remove(key: string): Promise<void> {
    await rm(this.workspacePath(key), { recursive: true, force: true });
  }

  async #pruneRetained(): Promise<void> {
    const entries = (await readdir(this.#workspaceRoot))
      .filter((name) => name.startsWith("retained-"))
      .sort((left, right) => {
        const leftTimestamp = retainedTimestamp(left);
        const rightTimestamp = retainedTimestamp(right);
        if (leftTimestamp !== rightTimestamp) return leftTimestamp < rightTimestamp ? -1 : 1;
        return left.localeCompare(right);
      });
    for (const name of entries.slice(0, Math.max(0, entries.length - this.#retainedLimit))) {
      await rm(join(this.#workspaceRoot, name), { recursive: true, force: true });
    }
  }

  async #retainName(name: string): Promise<void> {
    const path = join(this.#workspaceRoot, name);
    try {
      await stat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return; // nothing to retain
      throw new TaskWorkspaceError(`Could not inspect task workspace before retention: ${path}`, { cause: error });
    }
    await rename(path, join(this.#workspaceRoot, `retained-${name}-${Date.now()}`));
    await this.#pruneRetained();
  }

  async retain(key: string): Promise<void> {
    await this.#retainName(this.#key(key));
  }

  async retainStrays(activeKeys: readonly string[]): Promise<void> {
    const active = new Set(activeKeys.map((key) => this.#key(key)));
    await mkdir(this.#workspaceRoot, { recursive: true });
    const entries = await readdir(this.#workspaceRoot, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && !entry.name.startsWith("retained-") && !active.has(entry.name)) {
        await this.#retainName(entry.name);
      }
    }
  }
}
