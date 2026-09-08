/** Inspects and merges phased pipeline branches with neutral Git process state. */

import { GIT_OBJECT_ID_PATTERN } from "#shared/task-board-contract";
import { defaultGitRunner, gitArguments, type GitRunner, type GitTextRunner } from "../../shared/git.js";

const SUMMARY_LIMIT = 2_000;

export const runMergeGit: GitRunner = defaultGitRunner;

// Kept as a local alias so the many call sites below read unchanged; the
// prelude itself now lives in server/shared/git.ts.
const neutralized = gitArguments;

export type MergePipelineResult =
  | Readonly<{ kind: "merged"; mergeSha: string }>
  | Readonly<{ kind: "conflict"; summary: string }>
  | Readonly<{ kind: "diverged"; detail: string }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "repo_busy" }>;

type PipelineMergeTarget = Readonly<{ kind: "ready"; branch: string; head: string }> | Readonly<{ kind: "repo_busy" }>;

export type PipelineBaseAdvanceInspection =
  | Readonly<{ kind: "repo_busy" }>
  | Readonly<{ kind: "unchanged"; head: string }>
  | Readonly<{ kind: "advanced"; head: string }>
  | Readonly<{ kind: "diverged"; head: string }>;

export function inspectPipelineMergeTarget(
  request: Readonly<{
    repoPath: string;
    branch: string;
    git: GitTextRunner;
  }>
): PipelineMergeTarget {
  let currentBranch: string;
  let dirty: string;
  try {
    currentBranch = request.git(neutralized(request.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    dirty = request.git(neutralized(request.repoPath, ["status", "--porcelain", "-z"]));
  } catch {
    return Object.freeze({ kind: "repo_busy" });
  }
  if (
    dirty.length > 0 ||
    currentBranch === "HEAD" ||
    currentBranch === request.branch ||
    currentBranch.startsWith("task/")
  )
    return Object.freeze({ kind: "repo_busy" });

  const head = request.git(neutralized(request.repoPath, ["rev-parse", "HEAD"])).trim();
  if (!GIT_OBJECT_ID_PATTERN.test(head)) throw new Error("git returned an invalid merge target object id");
  return Object.freeze({ kind: "ready", branch: currentBranch, head });
}

export function isPipelineBaseAncestor(
  request: Readonly<{
    repoPath: string;
    baseSha: string;
    target: string;
    git: GitTextRunner;
  }>
): boolean {
  try {
    request.git(neutralized(request.repoPath, ["merge-base", "--is-ancestor", request.baseSha, request.target]));
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      (error as { status?: unknown }).status === 1
    )
      return false;
    throw error;
  }
}

export function inspectPipelineBaseAdvance(
  request: Readonly<{
    repoPath: string;
    branch: string;
    baseSha: string;
    git: GitTextRunner;
  }>
): PipelineBaseAdvanceInspection {
  const target = inspectPipelineMergeTarget(request);
  if (target.kind === "repo_busy") return target;
  if (target.head === request.baseSha) {
    return Object.freeze({ kind: "unchanged", head: target.head });
  }
  return Object.freeze({
    kind: isPipelineBaseAncestor({
      repoPath: request.repoPath,
      baseSha: request.baseSha,
      target: target.head,
      git: request.git,
    })
      ? "advanced"
      : "diverged",
    head: target.head,
  });
}

export function resolvePipelineBranchTip(
  request: Readonly<{
    repoPath: string;
    branch: string;
    git: GitTextRunner;
  }>
): string {
  const sha = request
    .git(neutralized(request.repoPath, ["rev-parse", "--verify", `${request.branch}^{commit}`]))
    .trim();
  if (!GIT_OBJECT_ID_PATTERN.test(sha)) throw new Error("git returned an invalid branch object id");
  return sha;
}

function optionalGit(git: GitTextRunner, arguments_: readonly string[]): string | null {
  try {
    return git(arguments_);
  } catch {
    return null;
  }
}

function mergeErrorDetail(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error).slice(0, SUMMARY_LIMIT);
  const candidate = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const values = [candidate.stderr, candidate.stdout, candidate.message]
    .map((value) => (Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : ""))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return (values[0] ?? "Git could not merge the pipeline branch.").slice(0, SUMMARY_LIMIT);
}

export function mergePipelineBranch(
  request: Readonly<{
    repoPath: string;
    branch: string;
    branchSha: string;
    baseSha: string;
    git: GitTextRunner;
  }>
): MergePipelineResult {
  if (!GIT_OBJECT_ID_PATTERN.test(request.branchSha)) {
    throw new Error("pipeline branch object id is invalid");
  }
  const target = inspectPipelineMergeTarget(request);
  if (target.kind === "repo_busy") return target;
  let baseIsAncestor = false;
  try {
    baseIsAncestor = isPipelineBaseAncestor({
      repoPath: request.repoPath,
      baseSha: request.baseSha,
      target: "HEAD",
      git: request.git,
    });
  } catch {
    // Preserve the merge executor's established behavior. The poller calls the
    // helper directly so non-ancestry and operational Git failures stay distinct.
  }
  if (!baseIsAncestor) {
    return Object.freeze({
      kind: "diverged",
      detail: `Pipeline base ${request.baseSha} is not an ancestor of merge target ${target.branch} at ${target.head}.`,
    });
  }
  const commitCount = request
    .git(neutralized(request.repoPath, ["rev-list", "--count", `${request.baseSha}..${request.branchSha}`]))
    .trim();
  if (commitCount === "0") return Object.freeze({ kind: "empty" });
  if (!/^\d+$/u.test(commitCount)) throw new Error("git returned an invalid pipeline commit count");
  try {
    request.git(
      neutralized(request.repoPath, [
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        `Merge branch '${request.branch}'`,
        request.branchSha,
      ])
    );
  } catch (error) {
    const mergeHead = optionalGit(request.git, neutralized(request.repoPath, ["rev-parse", "--verify", "MERGE_HEAD"]));
    if (mergeHead === null) throw error;
    request.git(neutralized(request.repoPath, ["merge", "--abort"]));
    return Object.freeze({
      kind: "conflict",
      summary: `Merge conflict for ${request.branch}: ${mergeErrorDetail(error)}`.slice(0, SUMMARY_LIMIT),
    });
  }
  const mergeSha = request.git(neutralized(request.repoPath, ["rev-parse", "HEAD"])).trim();
  if (!GIT_OBJECT_ID_PATTERN.test(mergeSha)) throw new Error("git returned an invalid merge object id");
  return Object.freeze({ kind: "merged", mergeSha });
}
