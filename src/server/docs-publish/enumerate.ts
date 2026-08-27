import {
  runDeclaredScopeGit,
  type GitRunner,
} from "../task-board/collaborators/scope-check.js";
import { validateExcludePattern } from "./exclude.js";

export interface DocSource { readonly path: string; readonly title: string; readonly markdown: string }
export interface EnumerateOptions { readonly exclude?: readonly string[] }

function git(runner: GitRunner, repoPath: string, arguments_: readonly string[]): string {
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

export function enumerateDocs(
  repoPath: string,
  ref: string,
  options: EnumerateOptions = {},
  runner: GitRunner = runDeclaredScopeGit,
): readonly DocSource[] {
  const prefixes = excludePrefixes(options.exclude ?? []);
  const output = git(runner, repoPath, ["ls-tree", "-r", "--name-only", "-z", ref, "--"]);
  const paths = (output.includes("\0") ? output.split("\0") : output.split(/\r?\n/u))
    .filter((path) => path.length > 0)
    .filter(isDocSourcePath)
    .filter((path) => !prefixes.some((prefix) => path.startsWith(`${prefix}/`)));

  return Object.freeze(paths.map((path) => Object.freeze({
    path,
    title: path,
    markdown: git(runner, repoPath, ["show", `${ref}:${path}`]),
  })));
}
