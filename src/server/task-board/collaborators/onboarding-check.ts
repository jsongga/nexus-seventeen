import { parseVerifyContract } from "../../agents/verify/contract.js";
import { runDeclaredScopeGit, type GitTextRunner } from "./scope-check.js";
const REQUIRED_FILES = Object.freeze([
  "README.md",
  "docs/architecture.md",
  "docs/interface.md",
  "docs/dependencies.md",
  "docs/workflow.md",
] as const);

interface OnboardingCheckResult {
  readonly ok: boolean;
  readonly missing: readonly string[];
}

function git(runner: GitTextRunner, repoPath: string, arguments_: readonly string[]): string {
  return runner([
    "-c", "core.fsmonitor=",
    "-c", "core.hooksPath=",
    "-C", repoPath,
    ...arguments_,
  ]);
}

function branchFile(runner: GitTextRunner, repoPath: string, branch: string, path: string): string | null {
  try {
    return git(runner, repoPath, ["show", `${branch}:${path}`]);
  } catch {
    return null;
  }
}

export function onboardingDeliverablesCheck(
  repoPath: string,
  branch: string,
  gapReport: string | undefined,
  runner: GitTextRunner = runDeclaredScopeGit,
): OnboardingCheckResult {
  const missing: string[] = [];
  if (typeof repoPath !== "string" || repoPath.trim().length === 0) {
    missing.push("repo_path is missing or empty");
  }
  if (typeof branch !== "string" || branch.trim().length === 0) {
    missing.push("pipeline_branch is missing or empty");
  }
  if (typeof gapReport !== "string" || gapReport.trim().length === 0) {
    missing.push("gap report is missing or empty");
  }
  if (missing.length > 0 && (
    typeof repoPath !== "string" || repoPath.trim().length === 0 ||
    typeof branch !== "string" || branch.trim().length === 0
  )) {
    return Object.freeze({ ok: false, missing: Object.freeze(missing) });
  }

  let workflow: string | null = null;
  for (const path of REQUIRED_FILES) {
    const content = branchFile(runner, repoPath, branch, path);
    if (content === null || content.trim().length === 0) {
      missing.push(`${path} is missing or empty`);
      continue;
    }
    if (path === "docs/workflow.md") workflow = content;
  }

  try {
    const decisions = git(runner, repoPath, ["ls-tree", "-r", "--name-only", branch, "--", "docs/decisions"]);
    if (decisions.trim().length === 0) missing.push("docs/decisions/ is missing or empty");
  } catch {
    missing.push("docs/decisions/ is missing or empty");
  }

  if (workflow !== null) {
    try {
      parseVerifyContract(workflow);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "contract is invalid";
      missing.push(`docs/workflow.md VerifyContract: ${detail}`);
    }
  }
  return Object.freeze({ ok: missing.length === 0, missing: Object.freeze(missing) });
}
