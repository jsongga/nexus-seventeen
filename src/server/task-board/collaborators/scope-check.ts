import { execFileSync } from "node:child_process";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BYTES = 1024 * 1024;
const SETTLEMENT_RESULT_LIMIT = 2_000;

export type DeclaredScopeGitRunner = (arguments_: readonly string[]) => string;

export type DeclaredScopeCheckResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; files: readonly string[] }>;

export const runDeclaredScopeGit: DeclaredScopeGitRunner = (arguments_) => execFileSync("git", [...arguments_], {
  encoding: "utf8",
  timeout: GIT_TIMEOUT_MS,
  maxBuffer: GIT_MAX_BYTES,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
});

export function scopeViolationResult(files: readonly string[]): string {
  return `scope violation: ${files.join(", ")}`.slice(0, SETTLEMENT_RESULT_LIMIT);
}

export function checkDeclaredScope(request: Readonly<{
  repoPath: string;
  baseSha: string;
  branch: string;
  declaredScope: readonly string[];
  git: DeclaredScopeGitRunner;
}>): DeclaredScopeCheckResult {
  const output = request.git([
    "-c", "core.fsmonitor=",
    "-c", "core.hooksPath=",
    "-C", request.repoPath,
    "diff", "--name-only", `${request.baseSha}..${request.branch}`, "--",
  ]);
  const outsideScope = output
    .split(/\r?\n/u)
    .filter((file) => file.length > 0)
    .filter((file) => !request.declaredScope.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)));
  return outsideScope.length === 0
    ? Object.freeze({ ok: true })
    : Object.freeze({ ok: false, files: Object.freeze(outsideScope) });
}
