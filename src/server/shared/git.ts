/** The one way this server shells out to git: runner, argument prelude, and tree-entry grammar. */

/* —— Imports —— */

import { execFileSync } from "node:child_process";

import { redactForPersistence, redactMultilineForPersistence } from "./redact.js";

/* —— Bounds —— */

// Every git call the server makes is bounded the same way. A repository that
// hangs (a prompt, a lock, a network remote) must not hold a request open, and
// a pathological tree must not be read into memory unbounded.
export const GIT_TIMEOUT_MS = 30_000;
export const GIT_MAX_BYTES = 1024 * 1024;

/* —— Runner —— */

export type GitTextRunner = (arguments_: readonly string[]) => string;

export type GitRunner = GitTextRunner &
  Readonly<{
    bytes: (arguments_: readonly string[]) => Buffer;
  }>;

/**
 * Adapts a text-only runner (what most tests inject) to the byte-capable shape.
 * Callers that must not lose bytes — reading a published interface, where a
 * lossy decode would silently alter the contract — should still be given a real
 * byte runner; this fallback exists so text-only injections keep working.
 */
export function withGitBytes(runner: GitTextRunner): GitRunner {
  if ("bytes" in runner && typeof runner.bytes === "function") return runner as GitRunner;
  return Object.assign((arguments_: readonly string[]) => runner(arguments_), {
    bytes: (arguments_: readonly string[]) => Buffer.from(runner(arguments_), "utf8"),
  });
}

// `stdio` never inherits stdin: git must fail rather than wait for a human, and
// GIT_TERMINAL_PROMPT=0 stops credential prompts on a remote it cannot reach.
// Rebuilt per call, never hoisted: freezing `process.env` at module load would
// pin the environment of whichever module imported this one first.
export function gitExecOptions(): {
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
  stdio: ("ignore" | "pipe")[];
  env: NodeJS.ProcessEnv;
} {
  return {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BYTES,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  };
}

// git echoes what it was given, so a remote URL carrying a token appears in the
// failure text and would reach a log, a handoff, or a persisted settlement.
// Redaction happens here, at the one place every caller shares. The properties
// callers branch on survive: `code` (interface-context maps ENOBUFS to
// "too_large") and `status`, and pipeline-merge still reads stderr/stdout —
// redacted.
export function redactGitFailureForTest(error: unknown): never {
  return redactGitFailure(error);
}

function redactGitFailure(error: unknown): never {
  if (!(error instanceof Error)) throw error;
  const source = error as Error & {
    code?: unknown;
    status?: unknown;
    signal?: unknown;
    stderr?: unknown;
    stdout?: unknown;
  };
  const redacted = new Error(redactForPersistence(source.message)) as Error & Record<string, unknown>;
  redacted.code = source.code;
  redacted.status = source.status;
  redacted.signal = source.signal;
  for (const stream of ["stderr", "stdout"] as const) {
    const value = source[stream];
    // Streams keep their line structure: git's failure text is multi-line and
    // pipeline-merge surfaces it in a user-visible summary, where a single
    // run-jammed line would be unreadable.
    if (typeof value === "string") redacted[stream] = redactMultilineForPersistence(value);
    else if (Buffer.isBuffer(value)) {
      redacted[stream] = Buffer.from(redactMultilineForPersistence(value.toString("utf8")));
    } else redacted[stream] = value;
  }
  throw redacted;
}

/** Creates the process-backed runner every collaborator shares. */
export function createGitRunner(): GitRunner {
  return Object.assign(
    (arguments_: readonly string[]) => {
      try {
        return execFileSync("git", [...arguments_], { ...gitExecOptions(), encoding: "utf8" });
      } catch (error) {
        return redactGitFailure(error);
      }
    },
    {
      bytes: (arguments_: readonly string[]) => {
        try {
          return execFileSync("git", [...arguments_], { ...gitExecOptions(), encoding: "buffer" });
        } catch (error) {
          return redactGitFailure(error);
        }
      },
    }
  );
}

/** The shared process-backed runner. Tests inject their own instead. */
export const defaultGitRunner: GitRunner = createGitRunner();

/* —— Repository-scoped invocation —— */

// `??` would accept an empty string and reproduce the outage this identity exists to prevent:
// git treats an empty user.name as unset, and an empty user.email writes `<>` commits.
const configured = (value: string | undefined, fallback: string): string =>
  value === undefined || value.trim() === "" ? fallback : value;

export const BOARD_COMMITTER_NAME = configured(process.env.STEWARD_GIT_COMMITTER_NAME, "Nexus Seventeen");
export const BOARD_COMMITTER_EMAIL = configured(
  process.env.STEWARD_GIT_COMMITTER_EMAIL,
  "board@nexus-seventeen.invalid"
);

// Four settings are applied on every invocation rather than per call site. Two are
// disabled: the filesystem monitor (a daemon the server must not start or depend on)
// and hooks (a repository must never run its own code inside this process's tree).
// Two are supplied: a committer identity, because the board creates merge commits
// itself and a container has no ambient git identity — without these, every merge
// fails with git's "Please tell me who you are", surfaced as an opaque
// "pipeline repository is unavailable".
export const GIT_POLICY_FLAGS: readonly string[] = Object.freeze([
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.hooksPath=",
  "-c",
  `user.name=${BOARD_COMMITTER_NAME}`,
  "-c",
  `user.email=${BOARD_COMMITTER_EMAIL}`,
  // The board runs as `node` and operates on repositories an operator cloned or bind-mounted in,
  // which are typically root-owned (the entrypoint chowns /var/lib/steward and /private, not
  // /repos). Without this git refuses them for "dubious ownership" and the failure surfaces as the
  // same opaque "pipeline repository is unavailable". Safe here because the prelude already
  // disables hooks, which is what the ownership check exists to protect against.
  "-c",
  "safe.directory=*",
]);

export function gitArguments(repoPath: string, arguments_: readonly string[]): readonly string[] {
  return [...GIT_POLICY_FLAGS, "-C", repoPath, ...arguments_];
}

export function runGit(runner: GitTextRunner, repoPath: string, arguments_: readonly string[]): string {
  return runner(gitArguments(repoPath, arguments_));
}

export function runGitBytes(runner: GitRunner, repoPath: string, arguments_: readonly string[]): Buffer {
  return runner.bytes(gitArguments(repoPath, arguments_));
}

/* —— Tree entries —— */

export type GitTreeEntry = Readonly<{
  mode: string;
  type: string;
  sha: string;
  path: string;
}>;

/** A regular file — not a symlink (120000), a gitlink (160000), or a directory. */
export function isRegularFileMode(mode: string): boolean {
  return mode === "100644" || mode === "100755";
}

/**
 * Parses one `-z` separated `ls-tree` record, or returns null when the record
 * does not match the grammar. Callers decide what a parse failure means: the
 * docs publisher throws, while interface reads map it to a typed block reason.
 */
export function parseGitTreeEntry(entry: string): GitTreeEntry | null {
  const modeEnd = entry.indexOf(" ");
  const typeEnd = modeEnd < 0 ? -1 : entry.indexOf(" ", modeEnd + 1);
  const shaEnd = typeEnd < 0 ? -1 : entry.indexOf("\t", typeEnd + 1);
  if (modeEnd < 0 || typeEnd < 0 || shaEnd < 0) return null;

  const mode = entry.slice(0, modeEnd);
  const type = entry.slice(modeEnd + 1, typeEnd);
  const sha = entry.slice(typeEnd + 1, shaEnd);
  const path = entry.slice(shaEnd + 1);
  if (
    !/^[0-7]{6}$/u.test(mode) ||
    !/^[a-z]+$/u.test(type) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha) ||
    path.length === 0
  ) {
    return null;
  }
  return Object.freeze({ mode, type, sha, path });
}

/** Splits `ls-tree -z` output into its records, dropping the trailing empty one. */
export function splitGitTreeOutput(output: string): readonly string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}
