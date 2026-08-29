import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, posix } from "node:path";

import { loadVerifyContract } from "./contract.js";
import { globToRegExp, mapChangedFiles } from "./mapping.js";
import type { MappingHost, VerifyTier } from "./mapping.js";

export interface VerifyRunnerOptions {
  readonly repoRoot: string;
  readonly runsRoot?: string;
  readonly keepRuns?: number;
  readonly supervisorPath?: string;
  /** Command executor injection for tests. Default: spawn via shell:false, argv = command.split(" "). */
  readonly execute?: (argv: readonly string[], options: { cwd: string }) => Promise<number>;
}

export type ForegroundResult =
  | Readonly<{ outcome: "green" }>
  | Readonly<{ outcome: "failed"; step: string }>
  | Readonly<{ outcome: "escalate"; reasons: readonly string[] }>;

export interface VerifyRunStatus {
  readonly id: string;
  readonly state: "running" | "green" | "failed" | "died";
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly command: string;
}

interface StoredRunStatus extends VerifyRunStatus {
  readonly tier?: "full";
  readonly pid?: number;
}

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ChangedFileSnapshot {
  readonly files: readonly string[];
  readonly deletedOrRenamed: readonly string[];
}

const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/u;
const DEFAULT_KEEP_RUNS = 10;
const DEFAULT_TAIL_BYTES = 4_096;

function splitCommand(command: string): readonly string[] {
  return command.split(" ");
}

function executeCommand(argv: readonly string[], options: { cwd: string }): Promise<number> {
  const [program, ...args] = argv;
  if (program === undefined || program.length === 0) throw new Error("cannot execute an empty command");
  return new Promise<number>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function capture(command: string, args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function lines(value: string): readonly string[] {
  return value.split(/\r?\n/u).filter((line) => line.length > 0);
}

function untrackedPaths(porcelain: string): readonly string[] {
  const records = porcelain.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length === 0) continue;
    const code = record.slice(0, 2);
    if (code === "??" && record[2] === " ") paths.push(record.slice(3));
    if (code.startsWith("R") || code.startsWith("C")) index += 1;
  }
  return paths;
}

function isRunArtifact(path: string): boolean {
  return path === ".verify-runs" || path.startsWith(".verify-runs/");
}

function hostFor(repoRoot: string): MappingHost {
  const inspect = (path: string, type: "file" | "directory"): boolean => {
    try {
      const stats = statSync(join(repoRoot, path));
      return type === "file" ? stats.isFile() : stats.isDirectory();
    } catch {
      return false;
    }
  };
  return {
    fileExists: (path) => inspect(path, "file"),
    directoryExists: (path) => inspect(path, "directory"),
  };
}

function compiledTestFile(source: string): string {
  return posix.join(".test-dist", source.replace(/\.tsx?$/u, ".js"));
}

function compiledTestDirectory(source: string): string {
  return posix.join(".test-dist", source, "**/*.test.js");
}

async function compiledTestDirectoryHasMatches(repoRoot: string, source: string): Promise<boolean> {
  try {
    const entries = await readdir(join(repoRoot, ".test-dist", source), {
      recursive: true,
      withFileTypes: true,
    });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith(".test.js"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function formatRunTimestamp(date: Date): string {
  const digits = (value: number): string => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${digits(date.getUTCMonth() + 1)}${digits(date.getUTCDate())}` +
    `-${digits(date.getUTCHours())}${digits(date.getUTCMinutes())}${digits(date.getUTCSeconds())}`;
}

function incrementTimestamp(timestamp: string): string {
  const year = Number(timestamp.slice(0, 4));
  const month = Number(timestamp.slice(4, 6));
  const day = Number(timestamp.slice(6, 8));
  const hours = Number(timestamp.slice(9, 11));
  const minutes = Number(timestamp.slice(11, 13));
  const seconds = Number(timestamp.slice(13, 15));
  return formatRunTimestamp(new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds + 1)));
}

function createRunId(existing: readonly string[]): string {
  const latestTimestamp = existing.at(-1)?.slice(0, 15);
  let timestamp = formatRunTimestamp(new Date());
  if (latestTimestamp !== undefined && latestTimestamp > timestamp) timestamp = latestTimestamp;
  const sameSecond = existing.filter((id) => id.startsWith(`${timestamp}-`));
  if (sameSecond.length === 0) {
    return `${timestamp}-${randomBytes(2).toString("hex")}`;
  }

  const maximum = Math.max(...sameSecond.map((id) => Number.parseInt(id.slice(-4), 16)));
  if (maximum < 0xffff) return `${timestamp}-${(maximum + 1).toString(16).padStart(4, "0")}`;
  timestamp = incrementTimestamp(timestamp);
  return `${timestamp}-${randomBytes(2).toString("hex")}`;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function storedStatus(value: unknown, path: string): StoredRunStatus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid verify status at ${path}`);
  }
  const candidate = value as Record<string, unknown>;
  const validState = candidate.state === "running" || candidate.state === "green" ||
    candidate.state === "failed" || candidate.state === "died";
  const validEndedAt = candidate.endedAt === null || typeof candidate.endedAt === "string";
  const validExitCode = candidate.exitCode === null ||
    (typeof candidate.exitCode === "number" && Number.isInteger(candidate.exitCode));
  const validPid = candidate.pid === undefined ||
    (typeof candidate.pid === "number" && Number.isInteger(candidate.pid) && candidate.pid > 0);
  if (
    typeof candidate.id !== "string" || !validState || typeof candidate.startedAt !== "string" ||
    !validEndedAt || !validExitCode || typeof candidate.command !== "string" || !validPid
  ) {
    throw new Error(`invalid verify status at ${path}`);
  }
  return {
    id: candidate.id,
    state: candidate.state as VerifyRunStatus["state"],
    startedAt: candidate.startedAt,
    endedAt: candidate.endedAt as string | null,
    exitCode: candidate.exitCode as number | null,
    command: candidate.command,
    tier: candidate.tier === "full" ? "full" : undefined,
    pid: candidate.pid as number | undefined,
  };
}

function publicStatus(status: StoredRunStatus): VerifyRunStatus {
  return {
    id: status.id,
    state: status.state,
    startedAt: status.startedAt,
    endedAt: status.endedAt,
    exitCode: status.exitCode,
    command: status.command,
  };
}

export class VerifyRunner {
  readonly #repoRoot: string;
  readonly #runsRoot: string;
  readonly #keepRuns: number;
  readonly #supervisorPath: string;
  readonly #execute: (argv: readonly string[], options: { cwd: string }) => Promise<number>;

  public constructor(options: VerifyRunnerOptions) {
    if (!Number.isInteger(options.keepRuns ?? DEFAULT_KEEP_RUNS) || (options.keepRuns ?? DEFAULT_KEEP_RUNS) < 1) {
      throw new RangeError("keepRuns must be a positive integer");
    }
    this.#repoRoot = options.repoRoot;
    this.#runsRoot = options.runsRoot ?? join(options.repoRoot, ".verify-runs");
    this.#keepRuns = options.keepRuns ?? DEFAULT_KEEP_RUNS;
    this.#supervisorPath = options.supervisorPath ?? join(options.repoRoot, "build", "server", "agents", "verify", "supervisor.js");
    this.#execute = options.execute ?? executeCommand;
  }

  public async changedFiles(base: string): Promise<readonly string[]> {
    return (await this.#changedFileSnapshot(base)).files;
  }

  public async runForeground(tier: VerifyTier, base: string): Promise<ForegroundResult> {
    const changed = await this.#changedFileSnapshot(base);
    const contract = await loadVerifyContract(this.#repoRoot);
    const ruleMatchers = contract.rules.map((rule) => ({ rule, matcher: globToRegExp(rule.match) }));
    const unsafeDeletions = changed.deletedOrRenamed.filter((file) => {
      const matched = ruleMatchers.find(({ matcher }) => matcher.test(file));
      return matched?.rule.action.kind !== "none";
    });
    if (unsafeDeletions.length > 0) {
      return {
        outcome: "escalate",
        reasons: unsafeDeletions.map(
          (file) => `${file} (deleted or renamed — stale compiled outputs; run a clean tier)`,
        ),
      };
    }

    const selection = mapChangedFiles(changed.files, contract.rules, tier, hostFor(this.#repoRoot));
    const reasons = [
      ...selection.escalations,
      ...selection.unmatched.map((file) => `${file} (unmapped change, run area/full)`),
    ];
    if (reasons.length > 0) return { outcome: "escalate", reasons };

    const hasSelection = selection.nodeTestFiles.length > 0 || selection.nodeTestDirs.length > 0 ||
      selection.vitestTargets.length > 0;
    if (!hasSelection) {
      console.log("nothing to verify");
      return { outcome: "green" };
    }

    for (const step of contract.compile) {
      const exitCode = await this.#execute(splitCommand(step), { cwd: this.#repoRoot });
      if (exitCode !== 0) return { outcome: "failed", step };
    }

    for (const source of selection.nodeTestFiles) {
      if (!existsSync(join(this.#repoRoot, compiledTestFile(source)))) {
        return {
          outcome: "failed",
          step: `selection (${source} missing after compile — mapping bug)`,
        };
      }
    }

    for (const source of selection.nodeTestDirs) {
      if (!await compiledTestDirectoryHasMatches(this.#repoRoot, source)) {
        return {
          outcome: "failed",
          step: `selection (${source} matched no compiled tests — mapping bug)`,
        };
      }
    }

    const nodeTests = [
      ...selection.nodeTestFiles.map(compiledTestFile),
      ...selection.nodeTestDirs.map(compiledTestDirectory),
    ];
    if (nodeTests.length > 0) {
      const argv = ["node", "--test", ...nodeTests];
      if (await this.#execute(argv, { cwd: this.#repoRoot }) !== 0) {
        return { outcome: "failed", step: argv.join(" ") };
      }
    }

    if (selection.vitestTargets.length > 0) {
      const argv = ["npx", "vitest", "run", ...selection.vitestTargets];
      if (await this.#execute(argv, { cwd: this.#repoRoot }) !== 0) {
        return { outcome: "failed", step: argv.join(" ") };
      }
    }
    return { outcome: "green" };
  }

  public async startFull(): Promise<string> {
    const contract = await loadVerifyContract(this.#repoRoot);
    await mkdir(this.#runsRoot, { recursive: true });
    const existing = await this.#runDirectories();
    const removeCount = Math.max(0, existing.length - (this.#keepRuns - 1));
    for (const id of existing.slice(0, removeCount)) {
      await rm(join(this.#runsRoot, id), { recursive: true, force: true });
    }

    const id = createRunId(existing);
    const runDirectory = join(this.#runsRoot, id);
    await mkdir(runDirectory);
    await writeFile(join(runDirectory, "log"), "", "utf8");
    const initial: StoredRunStatus = {
      id,
      tier: "full",
      state: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      command: contract.full.join(" && "),
    };
    const commands = contract.full.map(splitCommand);
    const child = spawn(process.execPath, [this.#supervisorPath, runDirectory, JSON.stringify(commands)], {
      cwd: this.#repoRoot,
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    child.once("error", () => undefined);
    if (child.pid === undefined) throw new Error("failed to start verify supervisor");
    await atomicWriteJson(join(runDirectory, "status.json"), { ...initial, pid: child.pid });
    child.unref();
    return id;
  }

  public async status(id: string): Promise<VerifyRunStatus> {
    this.#assertRunId(id);
    const path = join(this.#runsRoot, id, "status.json");
    const parsed = storedStatus(JSON.parse(await readFile(path, "utf8")) as unknown, path);
    if (parsed.id !== id) throw new Error(`verify status id mismatch at ${path}`);
    if (parsed.state === "running" && parsed.pid !== undefined) {
      try {
        process.kill(parsed.pid, 0);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          const latest = storedStatus(JSON.parse(await readFile(path, "utf8")) as unknown, path);
          if (latest.id !== id) throw new Error(`verify status id mismatch at ${path}`);
          return publicStatus(latest.state === "running" ? { ...latest, state: "died" } : latest);
        }
        if (code !== "EPERM") throw error;
      }
    }
    return publicStatus(parsed);
  }

  public async terminate(id: string): Promise<void> {
    this.#assertRunId(id);
    const path = join(this.#runsRoot, id, "status.json");
    const parsed = storedStatus(JSON.parse(await readFile(path, "utf8")) as unknown, path);
    if (parsed.id !== id) throw new Error(`verify status id mismatch at ${path}`);
    if (parsed.state !== "running" || parsed.pid === undefined) return;
    try {
      process.kill(process.platform === "win32" ? parsed.pid : -parsed.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  public async tail(id: string, bytes = DEFAULT_TAIL_BYTES): Promise<string> {
    this.#assertRunId(id);
    if (!Number.isInteger(bytes) || bytes < 0) throw new RangeError("tail bytes must be a non-negative integer");
    if (bytes === 0) return "";
    const handle = await open(join(this.#runsRoot, id, "log"), "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(bytes, size);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  public async list(): Promise<readonly VerifyRunStatus[]> {
    const ids = [...await this.#runDirectories()].reverse();
    const statuses = await Promise.all(ids.map(async (id) => {
      try {
        return await this.status(id);
      } catch {
        return undefined;
      }
    }));
    return statuses.filter((status): status is VerifyRunStatus => status !== undefined);
  }

  async #changedFileSnapshot(base: string): Promise<ChangedFileSnapshot> {
    let verification: GitResult;
    try {
      verification = await capture("git", ["rev-parse", "--verify", base], this.#repoRoot);
    } catch (error) {
      throw new Error(`could not verify git base ${base}`, { cause: error });
    }
    if (verification.exitCode !== 0) {
      const detail = verification.stderr.trim();
      throw new Error(`unknown git base ${base}${detail.length > 0 ? `: ${detail}` : ""}`);
    }

    const [diff, status, stale] = await Promise.all([
      capture("git", ["diff", "--no-renames", "--name-only", base, "--"], this.#repoRoot),
      capture("git", ["status", "--porcelain", "-z", "--untracked-files=all"], this.#repoRoot),
      capture("git", ["diff", "--no-renames", "--name-only", "--diff-filter=DR", base, "--"], this.#repoRoot),
    ]);
    for (const result of [diff, status, stale]) {
      if (result.exitCode !== 0) {
        throw new Error(`could not inspect changes from git base ${base}: ${result.stderr.trim()}`);
      }
    }

    const untracked = untrackedPaths(status.stdout);
    const deletedOrRenamed = [...new Set(lines(stale.stdout).filter((path) => !isRunArtifact(path)))].sort();
    const files = [...new Set([...lines(diff.stdout), ...untracked, ...deletedOrRenamed]
      .filter((path) => !isRunArtifact(path)))].sort();
    return { files, deletedOrRenamed };
  }

  async #runDirectories(): Promise<readonly string[]> {
    let entries;
    try {
      entries = await readdir(this.#runsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entries.filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  #assertRunId(id: string): void {
    if (!RUN_ID.test(id)) throw new Error(`invalid verify run id: ${id}`);
  }
}
