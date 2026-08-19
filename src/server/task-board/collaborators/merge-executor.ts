import { execFileSync } from "node:child_process";
import { GIT_OBJECT_ID_PATTERN } from "#shared/task-board-contract";
import type { GitRunner } from "./scope-check.js";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BYTES = 1024 * 1024;
const SUMMARY_LIMIT = 2_000;

const neutralized = (repoPath: string, arguments_: readonly string[]): readonly string[] => [
  "-c", "core.fsmonitor=",
  "-c", "core.hooksPath=",
  "-C", repoPath,
  ...arguments_,
];

export const runMergeGit: GitRunner = (arguments_) => execFileSync("git", [...arguments_], {
  encoding: "utf8",
  timeout: GIT_TIMEOUT_MS,
  maxBuffer: GIT_MAX_BYTES,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
});

export type MergePipelineResult =
  | Readonly<{ kind: "merged"; mergeSha: string }>
  | Readonly<{ kind: "conflict"; summary: string }>
  | Readonly<{ kind: "diverged"; detail: string }>
  | Readonly<{ kind: "repo_busy" }>;

function optionalGit(git: GitRunner, arguments_: readonly string[]): string | null {
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
    .map((value) => Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return (values[0] ?? "Git could not merge the pipeline branch.").slice(0, SUMMARY_LIMIT);
}

export function mergePipelineBranch(request: Readonly<{
  repoPath: string;
  branch: string;
  baseSha: string;
  git: GitRunner;
}>): MergePipelineResult {
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
  ) return Object.freeze({ kind: "repo_busy" });

  const head = request.git(neutralized(request.repoPath, ["rev-parse", "HEAD"])).trim();
  try {
    request.git(neutralized(request.repoPath, ["merge-base", "--is-ancestor", request.baseSha, "HEAD"]));
  } catch {
    return Object.freeze({
      kind: "diverged",
      detail: `Pipeline base ${request.baseSha} is not an ancestor of merge target ${currentBranch} at ${head}.`,
    });
  }
  try {
    request.git(neutralized(request.repoPath, ["merge", "--no-ff", "--no-edit", request.branch]));
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
