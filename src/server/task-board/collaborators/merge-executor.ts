import { execFileSync } from "node:child_process";
import type { GitRunner } from "./scope-check.js";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BYTES = 1024 * 1024;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
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
  | Readonly<{ kind: "repo_busy" }>;

function optionalGit(git: GitRunner, arguments_: readonly string[]): string | null {
  try {
    return git(arguments_);
  } catch {
    return null;
  }
}

function defaultBranch(repoPath: string, currentBranch: string, git: GitRunner): string | null {
  const remoteHead = optionalGit(git, neutralized(repoPath, [
    "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD",
  ]))?.trim();
  if (remoteHead !== undefined && remoteHead !== null && remoteHead.length > 0) {
    return remoteHead.startsWith("origin/") ? remoteHead.slice("origin/".length) : remoteHead;
  }

  const configured = optionalGit(git, neutralized(repoPath, ["config", "--get", "init.defaultBranch"]))?.trim();
  const candidates = [configured, "main", "master"]
    .filter((candidate): candidate is string => candidate !== undefined && candidate !== null && candidate.length > 0);
  for (const candidate of new Set(candidates)) {
    const resolved = optionalGit(git, neutralized(repoPath, ["rev-parse", "--verify", `refs/heads/${candidate}`]))?.trim();
    if (resolved !== undefined && resolved !== null && GIT_OBJECT_ID.test(resolved)) return candidate;
  }

  const localBranches = optionalGit(git, neutralized(repoPath, [
    "for-each-ref", "--format=%(refname:short)", "refs/heads",
  ]))?.split("\n").filter((branch) => branch.length > 0) ?? [];
  return localBranches.length === 1 && localBranches[0] === currentBranch ? currentBranch : null;
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
  const expectedDefault = defaultBranch(request.repoPath, currentBranch, request.git);
  if (
    dirty.length > 0 ||
    currentBranch === "HEAD" ||
    currentBranch === request.branch ||
    expectedDefault === null ||
    currentBranch !== expectedDefault
  ) return Object.freeze({ kind: "repo_busy" });

  const head = request.git(neutralized(request.repoPath, ["rev-parse", "HEAD"])).trim();
  if (head !== request.baseSha) {
    request.git(neutralized(request.repoPath, ["merge-base", "--is-ancestor", request.baseSha, "HEAD"]));
    console.warn(`[task-board] default branch moved beyond pipeline base ${request.baseSha}`);
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
  if (!GIT_OBJECT_ID.test(mergeSha)) throw new Error("git returned an invalid merge object id");
  return Object.freeze({ kind: "merged", mergeSha });
}
