import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { IDENTIFIER_PATTERN } from "#shared/task-board-contract";

const KEY = new RegExp(IDENTIFIER_PATTERN, "u");
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
    execFile("git", [...args], {
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
    if (!KEY.test(key) || key.startsWith("retained-")) {
      throw new TaskWorkspaceError(`Invalid task workspace key: ${key}`);
    }
    return key;
  }

  workspacePath(key: string): string {
    return join(this.#workspaceRoot, this.#key(key));
  }

  async create(key: string, baseRef?: string): Promise<string> {
    const path = this.workspacePath(key);
    await mkdir(this.#workspaceRoot, { recursive: true });
    await rm(path, { recursive: true, force: true });
    await git(null, ["clone", "--no-hardlinks", this.#repositoryPath, path]);
    if (baseRef !== undefined) await git(path, ["switch", "--detach", baseRef]);
    await git(path, ["switch", "-c", `task/${this.#key(key)}`]);
    return path;
  }

  async harvest(key: string): Promise<void> {
    const branch = `task/${this.#key(key)}`;
    await git(this.#repositoryPath, ["fetch", this.workspacePath(key), `+${branch}:${branch}`]);
  }

  async remove(key: string): Promise<void> {
    await rm(this.workspacePath(key), { recursive: true, force: true });
  }

  async retain(key: string): Promise<void> {
    const path = this.workspacePath(key);
    try {
      await stat(path);
    } catch {
      return; // nothing to retain
    }
    await rename(path, join(this.#workspaceRoot, `retained-${this.#key(key)}-${Date.now()}`));
    const entries = (await readdir(this.#workspaceRoot)).filter((name) => name.startsWith("retained-")).sort();
    for (const name of entries.slice(0, Math.max(0, entries.length - this.#retainedLimit))) {
      await rm(join(this.#workspaceRoot, name), { recursive: true, force: true });
    }
  }
}
