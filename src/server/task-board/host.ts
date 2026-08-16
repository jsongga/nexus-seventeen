import { access, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { TASK_BOARD_ERROR_CODES } from "#shared/task-board-contract";
import { TaskBoardError } from "./errors.js";

/** Maximum entries returned by any host listing; more sets `truncated`. */
export const HOST_LIST_CAP = 500;

export interface HostContext {
  readonly homeDir: string;
  /** When non-null, replaces $HOME auto-detection entirely. */
  readonly rootsOverride: readonly string[] | null;
}
export interface HostProjectEntry {
  readonly name: string;
  readonly path: string;
  readonly hasGit: boolean;
  readonly modifiedAtMs: number;
}
export interface HostProjectRoot {
  readonly name: string;
  readonly path: string;
  readonly projects: readonly HostProjectEntry[];
  readonly truncated: boolean;
}
export interface HostDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly hasGit: boolean;
}
export interface HostDirectoryListing {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly HostDirectoryEntry[];
  readonly truncated: boolean;
}

async function directoryNames(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      names.push(entry.name);
      continue;
    }
    if (entry.isSymbolicLink()) {
      try {
        if ((await stat(join(path, entry.name))).isDirectory()) names.push(entry.name);
      } catch {
        // Broken symlink: skip.
      }
    }
  }
  return names.sort((left, right) => left.localeCompare(right));
}

function hasErrorCode(error: unknown, ...codes: readonly string[]): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && codes.includes(code);
}

function pathNotFound(): TaskBoardError {
  return new TaskBoardError(404, TASK_BOARD_ERROR_CODES.HOST_PATH_NOT_FOUND, "The folder does not exist");
}

function pathOutsideRoots(): TaskBoardError {
  return new TaskBoardError(403, TASK_BOARD_ERROR_CODES.HOST_PATH_OUTSIDE_ROOTS, "The folder is outside the browsable area");
}

function pathUnreadable(): TaskBoardError {
  return new TaskBoardError(403, TASK_BOARD_ERROR_CODES.HOST_PATH_UNREADABLE, "The folder cannot be read");
}

function throwMappedDirectoryError(error: unknown): never {
  if (hasErrorCode(error, "ENOENT")) throw pathNotFound();
  if (hasErrorCode(error, "EACCES", "EPERM")) throw pathUnreadable();
  throw error;
}

async function hasGit(path: string): Promise<boolean> {
  try {
    await access(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function candidateRoots(context: HostContext): Promise<string[]> {
  if (context.rootsOverride !== null) return [...context.rootsOverride];
  let names: string[];
  try {
    names = await readdir(context.homeDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.startsWith(".") && name.endsWith("Projects"))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => join(context.homeDir, name));
}

export async function listProjectRoots(context: HostContext): Promise<HostProjectRoot[]> {
  const bases = await allowedBases(context);
  const roots: HostProjectRoot[] = [];
  for (const rootPath of await candidateRoots(context)) {
    const resolvedRoot = await containedDirectory(rootPath, bases);
    if (resolvedRoot === null) continue;
    let names: string[];
    try {
      names = await directoryNames(resolvedRoot);
    } catch {
      continue;
    }
    const projects = (await Promise.all(
      names.slice(0, HOST_LIST_CAP).map((name) => projectEntry(rootPath, resolvedRoot, name, bases)),
    )).filter((entry): entry is HostProjectEntry => entry !== null);
    roots.push({ name: basename(rootPath), path: rootPath, projects, truncated: names.length > HOST_LIST_CAP });
  }
  return roots.sort((left, right) => left.name.localeCompare(right.name));
}

async function allowedBases(context: HostContext): Promise<string[]> {
  const bases: string[] = [];
  for (const candidate of [context.homeDir, ...(context.rootsOverride ?? [])]) {
    try {
      bases.push(await realpath(candidate));
    } catch {
      // A missing base cannot admit any path.
    }
  }
  return bases;
}

function withinBases(path: string, bases: readonly string[]): boolean {
  return bases.some((base) => base === sep || path === base || path.startsWith(base + sep));
}

async function containedDirectory(path: string, bases: readonly string[]): Promise<string | null> {
  try {
    const resolved = await realpath(path);
    if (!withinBases(resolved, bases) || !(await stat(resolved)).isDirectory()) return null;
    return resolved;
  } catch {
    return null;
  }
}

async function projectEntry(
  rootPath: string,
  resolvedRoot: string,
  name: string,
  bases: readonly string[],
): Promise<HostProjectEntry | null> {
  const path = join(rootPath, name);
  try {
    const resolved = await realpath(join(resolvedRoot, name));
    if (!withinBases(resolved, bases)) return null;
    const details = await stat(resolved);
    if (!details.isDirectory()) return null;
    return {
      name,
      path,
      hasGit: await hasGit(resolved),
      modifiedAtMs: Math.round(details.mtimeMs),
    };
  } catch {
    return null;
  }
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let candidate = resolve(path);
  while (true) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT", "ENOTDIR")) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
}

async function resolveRequestedPath(requestedPath: string, bases: readonly string[]): Promise<string> {
  try {
    return await realpath(requestedPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT", "ENOTDIR")) {
      let ancestor: string;
      try {
        ancestor = await nearestExistingAncestor(requestedPath);
      } catch (ancestorError) {
        if (hasErrorCode(ancestorError, "EACCES", "EPERM")) throw pathUnreadable();
        throw ancestorError;
      }
      if (!withinBases(ancestor, bases)) throw pathOutsideRoots();
      throw pathNotFound();
    }
    if (hasErrorCode(error, "EACCES", "EPERM")) throw pathUnreadable();
    throw error;
  }
}

async function directoryEntry(
  parent: string,
  name: string,
  bases: readonly string[],
): Promise<HostDirectoryEntry | null> {
  const path = join(parent, name);
  try {
    const resolved = await realpath(path);
    if (!withinBases(resolved, bases) || !(await stat(resolved)).isDirectory()) return null;
    return { name, path, hasGit: await hasGit(resolved) };
  } catch {
    return null;
  }
}

export async function listDirectories(context: HostContext, requestedPath: string): Promise<HostDirectoryListing> {
  const bases = await allowedBases(context);
  const resolved = await resolveRequestedPath(requestedPath, bases);
  if (!withinBases(resolved, bases)) throw pathOutsideRoots();

  // Accepted TOCTOU risk: realpath and the following stat/readdir re-walk the path; Node has no openat.
  let details;
  try {
    details = await stat(resolved);
  } catch (error) {
    throwMappedDirectoryError(error);
  }
  if (!details.isDirectory()) {
    throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.HOST_PATH_NOT_DIRECTORY, "The path is a file, not a folder");
  }
  let names: string[];
  try {
    names = await directoryNames(resolved);
  } catch (error) {
    throwMappedDirectoryError(error);
  }
  const parentPath = dirname(resolved);
  const entries = (await Promise.all(
    names.slice(0, HOST_LIST_CAP).map((name) => directoryEntry(resolved, name, bases)),
  )).filter((entry): entry is HostDirectoryEntry => entry !== null);
  return {
    path: resolved,
    parent: parentPath !== resolved && withinBases(parentPath, bases) ? parentPath : null,
    entries,
    truncated: names.length > HOST_LIST_CAP,
  };
}
