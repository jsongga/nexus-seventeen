/** Reads and caches a bounded docs/interface.md from an exact provider commit for cross-repository agent context. */

import {
  GIT_OBJECT_ID_PATTERN,
  isValidCrossRepoMarkdown,
  type PublishedInterfaceFailureReason,
} from "#shared/task-board-contract";
import {
  defaultGitRunner,
  isRegularFileMode,
  parseGitTreeEntry,
  runGit,
  runGitBytes,
  splitGitTreeOutput,
  type GitRunner,
} from "../../shared/git.js";

export const PUBLISHED_INTERFACE_MAX_BYTES = 64 * 1_024;
export const PUBLISHED_INTERFACE_CACHE_MAX_ENTRIES = 128;
export const PUBLISHED_INTERFACE_PATH = "docs/interface.md" as const;

export type PublishedInterfaceContentFailureDetail = "invalid_utf8" | "prohibited_characters" | "empty";

export type PublishedInterfaceReadResult =
  | Readonly<{ kind: "present"; markdown: string }>
  | Readonly<{
      kind: "blocked";
      reason: "invalid_markdown";
      detail: Exclude<PublishedInterfaceContentFailureDetail, "empty">;
    }>
  | Readonly<{ kind: "blocked"; reason: "empty"; detail: "empty" }>
  | Readonly<{
      kind: "blocked";
      reason: Exclude<PublishedInterfaceFailureReason, "over_budget" | "invalid_markdown" | "empty">;
    }>;

function publishedTreeEntry(tree: string, path: string): "absent" | "blob" | "not_file" | "read_error" {
  const entries = splitGitTreeOutput(tree);
  if (entries.length === 0) return "absent";
  if (entries.length !== 1) return "read_error";
  const parsed = parseGitTreeEntry(entries[0]!);
  if (parsed === null || parsed.path !== path) return "read_error";
  // A symlink reports type `blob` with mode 120000, so the type alone is not
  // enough: only a regular-file mode is an interface the consumer may read.
  // (A gitlink reports type `commit`, which the type check already rejects.)
  return parsed.type === "blob" && isRegularFileMode(parsed.mode) ? "blob" : "not_file";
}

function blocked(
  reason: Exclude<PublishedInterfaceFailureReason, "over_budget" | "invalid_markdown" | "empty">
): PublishedInterfaceReadResult;
function blocked(
  reason: "invalid_markdown",
  detail: Exclude<PublishedInterfaceContentFailureDetail, "empty">
): PublishedInterfaceReadResult;
function blocked(reason: "empty", detail: "empty"): PublishedInterfaceReadResult;
function blocked(
  reason: Exclude<PublishedInterfaceFailureReason, "over_budget">,
  detail?: PublishedInterfaceContentFailureDetail
): PublishedInterfaceReadResult {
  return Object.freeze(
    detail === undefined ? { kind: "blocked", reason } : { kind: "blocked", reason, detail }
  ) as PublishedInterfaceReadResult;
}

function isNoBufferSpace(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOBUFS";
}

function assertReadTarget(repoPath: string, sha: string, path: string): void {
  if (repoPath.trim().length === 0 || repoPath.includes("\0")) {
    throw new TypeError("provider repository path is invalid");
  }
  if (!GIT_OBJECT_ID_PATTERN.test(sha)) throw new TypeError("published interface SHA is invalid");
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.includes(":") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new TypeError("published interface path is invalid");
  }
}

export function readPublishedInterface(
  repoPath: string,
  sha: string,
  path = PUBLISHED_INTERFACE_PATH,
  runner: GitRunner = defaultGitRunner
): PublishedInterfaceReadResult {
  assertReadTarget(repoPath, sha, path);
  let tree: string;
  try {
    tree = runGit(runner, repoPath, ["ls-tree", "-z", sha, "--", path]);
  } catch {
    return blocked("read_error");
  }
  const entry = publishedTreeEntry(tree, path);
  if (entry === "absent") return blocked("absent");
  if (entry !== "blob") return blocked(entry);
  let sizeOutput: string;
  try {
    sizeOutput = runGit(runner, repoPath, ["cat-file", "-s", `${sha}:${path}`]);
  } catch (error) {
    return blocked(isNoBufferSpace(error) ? "too_large" : "read_error");
  }
  const size = sizeOutput.trim();
  if (!/^(?:0|[1-9]\d*)$/u.test(size) || !Number.isSafeInteger(Number(size))) return blocked("read_error");
  if (Number(size) > PUBLISHED_INTERFACE_MAX_BYTES) return blocked("too_large");
  let blob: Buffer;
  try {
    blob = runGitBytes(runner, repoPath, ["show", `${sha}:${path}`]);
  } catch (error) {
    return blocked(isNoBufferSpace(error) ? "too_large" : "read_error");
  }
  if (blob.byteLength > PUBLISHED_INTERFACE_MAX_BYTES) return blocked("too_large");
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(blob);
  } catch {
    return blocked("invalid_markdown", "invalid_utf8");
  }
  if (markdown.trim().length === 0) return blocked("empty", "empty");
  if (!isValidCrossRepoMarkdown(markdown)) return blocked("invalid_markdown", "prohibited_characters");
  return Object.freeze({ kind: "present", markdown });
}

/** Process-local cache keyed by repository and immutable Git object identity. */
export class PublishedInterfaceCache {
  readonly #entries = new Map<string, PublishedInterfaceReadResult>();

  constructor(private readonly runner: GitRunner = defaultGitRunner) {}

  read(repoPath: string, sha: string, path = PUBLISHED_INTERFACE_PATH): PublishedInterfaceReadResult {
    const key = `${repoPath}\0${sha}\0${path}`;
    const prior = this.#entries.get(key);
    if (prior !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, prior);
      return prior;
    }
    const result = readPublishedInterface(repoPath, sha, path, this.runner);
    if (result.kind === "present" || result.reason !== "read_error") {
      if (this.#entries.size >= PUBLISHED_INTERFACE_CACHE_MAX_ENTRIES) {
        const oldest = this.#entries.keys().next().value as string | undefined;
        if (oldest !== undefined) this.#entries.delete(oldest);
      }
      this.#entries.set(key, result);
    }
    return result;
  }

  evict(repoPath: string, sha: string, path = PUBLISHED_INTERFACE_PATH): void {
    this.#entries.delete(`${repoPath}\0${sha}\0${path}`);
  }
}
