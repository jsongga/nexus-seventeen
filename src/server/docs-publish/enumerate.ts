/** Reads README.md and docs Markdown from one immutable Git tree without checking out the configured ref. */

import { defaultGitRunner, parseGitTreeEntry, runGit, type GitTextRunner } from "../shared/git.js";
import { validateExcludePattern } from "./exclude.js";

export interface DocSource {
  readonly path: string;
  readonly title: string;
  readonly markdown: string;
  readonly blobSha: string;
}
interface EnumerateOptions {
  readonly exclude?: readonly string[];
}

interface TreeEntry {
  readonly path: string;
  readonly blobSha: string;
}

const TREE_ENTRY_PREVIEW_CHARACTERS = 120;

function excludePrefixes(patterns: readonly string[]): readonly string[] {
  return patterns.map((pattern, index) => validateExcludePattern(pattern, `exclude[${index}]`).slice(0, -3));
}

export function isDocSourcePath(path: string): boolean {
  return path === "README.md" || (path.startsWith("docs/") && path.endsWith(".md"));
}

function malformedTreeEntry(entry: string): Error {
  const truncated = entry.length > TREE_ENTRY_PREVIEW_CHARACTERS;
  const preview = `${entry.slice(0, TREE_ENTRY_PREVIEW_CHARACTERS)}${truncated ? "…" : ""}`;
  return new Error(`git ls-tree returned a malformed entry: ${JSON.stringify(preview)}`);
}

function parseTreeEntry(entry: string): TreeEntry | undefined {
  // The grammar is shared; the policy is not. A record this publisher cannot
  // parse is a bug in its own invocation, so it throws rather than skipping.
  const parsed = parseGitTreeEntry(entry);
  if (parsed === null) throw malformedTreeEntry(entry);
  if (parsed.type !== "blob") return undefined;
  return Object.freeze({ blobSha: parsed.sha, path: parsed.path });
}

export function enumerateDocs(
  repoPath: string,
  ref: string,
  options: EnumerateOptions = {},
  runner: GitTextRunner = defaultGitRunner
): readonly DocSource[] {
  const prefixes = excludePrefixes(options.exclude ?? []);
  const output = runGit(runner, repoPath, ["ls-tree", "-r", "-z", ref, "--", "README.md", "docs"]);
  const entries = output
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map(parseTreeEntry)
    .filter((entry): entry is TreeEntry => entry !== undefined)
    .filter((entry) => isDocSourcePath(entry.path))
    .filter((entry) => !prefixes.some((prefix) => entry.path.startsWith(`${prefix}/`)));

  return Object.freeze(
    entries.map(({ path, blobSha }) =>
      Object.freeze({
        path,
        title: path,
        markdown: runGit(runner, repoPath, ["show", `${ref}:${path}`]),
        blobSha,
      })
    )
  );
}
