import {
  runDeclaredScopeGit,
  type GitTextRunner,
} from "../task-board/collaborators/scope-check.js";
import { validateExcludePattern } from "./exclude.js";

export interface DocSource {
  readonly path: string;
  readonly title: string;
  readonly markdown: string;
  readonly blobSha: string;
}
interface EnumerateOptions { readonly exclude?: readonly string[] }

interface TreeEntry { readonly path: string; readonly blobSha: string }

const TREE_ENTRY_PREVIEW_CHARACTERS = 120;

function git(runner: GitTextRunner, repoPath: string, arguments_: readonly string[]): string {
  return runner([
    "-c", "core.fsmonitor=",
    "-c", "core.hooksPath=",
    "-C", repoPath,
    ...arguments_,
  ]);
}

function excludePrefixes(patterns: readonly string[]): readonly string[] {
  return patterns.map((pattern, index) =>
    validateExcludePattern(pattern, `exclude[${index}]`).slice(0, -3));
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
  const modeEnd = entry.indexOf(" ");
  const typeEnd = modeEnd < 0 ? -1 : entry.indexOf(" ", modeEnd + 1);
  const shaEnd = typeEnd < 0 ? -1 : entry.indexOf("\t", typeEnd + 1);
  if (modeEnd < 0 || typeEnd < 0 || shaEnd < 0) throw malformedTreeEntry(entry);

  const mode = entry.slice(0, modeEnd);
  const type = entry.slice(modeEnd + 1, typeEnd);
  const blobSha = entry.slice(typeEnd + 1, shaEnd);
  const path = entry.slice(shaEnd + 1);
  if (
    !/^[0-7]{6}$/u.test(mode) || !/^[a-z]+$/u.test(type) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(blobSha) || path.length === 0
  ) {
    throw malformedTreeEntry(entry);
  }
  if (type !== "blob") return undefined;
  return Object.freeze({ blobSha, path });
}

export function enumerateDocs(
  repoPath: string,
  ref: string,
  options: EnumerateOptions = {},
  runner: GitTextRunner = runDeclaredScopeGit,
): readonly DocSource[] {
  const prefixes = excludePrefixes(options.exclude ?? []);
  const output = git(runner, repoPath, ["ls-tree", "-r", "-z", ref, "--", "README.md", "docs"]);
  const entries = output
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map(parseTreeEntry)
    .filter((entry): entry is TreeEntry => entry !== undefined)
    .filter((entry) => isDocSourcePath(entry.path))
    .filter((entry) => !prefixes.some((prefix) => entry.path.startsWith(`${prefix}/`)));

  return Object.freeze(entries.map(({ path, blobSha }) => Object.freeze({
    path,
    title: path,
    markdown: git(runner, repoPath, ["show", `${ref}:${path}`]),
    blobSha,
  })));
}
