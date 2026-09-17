/** Reads a host workspace path: normalizes it, names a project from it, and reports why it is unusable. */

/* —— Imports —— */

import { BoardApiError } from "../../data/client";

/* —— Workspace path —— */

export function normalizedWorkspacePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "/" || /^[A-Za-z]:[\\/]$/u.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/u, "");
}

export function projectNameFromPath(path: string): string {
  const segment = path.split(/[\\/]/u).filter(Boolean).at(-1)?.trim();
  return segment ?? "";
}

export function breadcrumbIsReachable(path: string, boundary: string | null): boolean {
  if (boundary === null) return false;
  if (boundary === "/") return path.startsWith("/");
  return path === boundary || path.startsWith(`${boundary}/`);
}

export function hostPathError(caught: unknown, fallback: string): string {
  if (!(caught instanceof BoardApiError)) return fallback;
  if (caught.code === "HOST_PATH_NOT_FOUND") return "That folder does not exist";
  if (caught.code === "HOST_PATH_NOT_DIRECTORY") return "That path is a file, not a folder";
  if (caught.code === "HOST_PATH_OUTSIDE_ROOTS") return "That folder is outside the browsable area";
  if (caught.code === "HOST_PATH_UNREADABLE") return "That folder cannot be read";
  return fallback;
}

export function taskWorkspaceRefs(repositoryPath?: string | null): string[] {
  const path = repositoryPath?.trim();
  if (!path || path.length > 512 || /[\r\n]/u.test(path)) return [];
  const absolutePosixPath = path.startsWith("/");
  const absoluteWindowsPath = /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\]+\\[^\\]+/u.test(path);
  return absolutePosixPath || absoluteWindowsPath ? [path] : [];
}
