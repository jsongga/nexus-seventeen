import { execFileSync } from "node:child_process";
import { normalizeDeclaredScope } from "#shared/task-board-contract";
export { declaredScopesOverlap } from "#shared/task-board-contract";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BYTES = 1024 * 1024;
const SETTLEMENT_RESULT_LIMIT = 2_000;

export type GitRunner = (arguments_: readonly string[]) => string;

export type DeclaredScopeCheckResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; files: readonly string[] }>;

export const runDeclaredScopeGit: GitRunner = (arguments_) => execFileSync("git", [...arguments_], {
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
  git: GitRunner;
}>): DeclaredScopeCheckResult {
  const normalizedScope = normalizeDeclaredScope(request.declaredScope);
  const output = request.git([
    "-c", "core.fsmonitor=",
    "-c", "core.hooksPath=",
    "-C", request.repoPath,
    "diff", "--no-renames", "--name-only", "-z", `${request.baseSha}..${request.branch}`, "--",
  ]);
  return checkDeclaredScopePaths(
    output.split("\0").filter((file) => file.length > 0),
    normalizedScope,
  );
}

export function checkDeclaredScopePaths(
  files: readonly string[],
  declaredScope: readonly string[],
): DeclaredScopeCheckResult {
  const normalizedScope = normalizeDeclaredScope(declaredScope);
  const outsideScope = files
    .filter((file) => !normalizedScope.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)));
  return outsideScope.length === 0
    ? Object.freeze({ ok: true })
    : Object.freeze({ ok: false, files: Object.freeze(outsideScope) });
}
