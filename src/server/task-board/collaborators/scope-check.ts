import { defaultGitRunner, type GitRunner, type GitTextRunner, GIT_POLICY_FLAGS } from "../../shared/git.js";
import { normalizeDeclaredScope } from "#shared/task-board-contract";
export { declaredScopesOverlap } from "#shared/task-board-contract";

const SETTLEMENT_RESULT_LIMIT = 2_000;

// The git plumbing lives in server/shared/git.ts so every caller shares one
// timeout, buffer bound and prelude. These re-exports keep existing importers
// working; new code should import ../../shared/git.js directly.
export type { GitRunner, GitTextRunner } from "../../shared/git.js";
export { withGitBytes } from "../../shared/git.js";
export const runDeclaredScopeGit: GitRunner = defaultGitRunner;

export type DeclaredScopeCheckResult = Readonly<{ ok: true }> | Readonly<{ ok: false; files: readonly string[] }>;

export function scopeViolationResult(files: readonly string[]): string {
  return `scope violation: ${files.join(", ")}`.slice(0, SETTLEMENT_RESULT_LIMIT);
}

export function checkDeclaredScope(
  request: Readonly<{
    repoPath: string;
    baseSha: string;
    branch: string;
    declaredScope: readonly string[];
    git: GitTextRunner;
  }>
): DeclaredScopeCheckResult {
  const normalizedScope = normalizeDeclaredScope(request.declaredScope);
  const output = request.git([
    ...GIT_POLICY_FLAGS,
    "-C",
    request.repoPath,
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    `${request.baseSha}..${request.branch}`,
    "--",
  ]);
  return checkDeclaredScopePaths(
    output.split("\0").filter((file) => file.length > 0),
    normalizedScope
  );
}

export function checkDeclaredScopePaths(
  files: readonly string[],
  declaredScope: readonly string[]
): DeclaredScopeCheckResult {
  const normalizedScope = normalizeDeclaredScope(declaredScope);
  const outsideScope = files.filter(
    (file) => !normalizedScope.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))
  );
  return outsideScope.length === 0
    ? Object.freeze({ ok: true })
    : Object.freeze({ ok: false, files: Object.freeze(outsideScope) });
}
