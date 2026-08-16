import { parseProjectMetadata } from './project-metadata';
import type { BoardProject, HostProjectRoot } from '../types';

export interface PickerEntry {
  name: string;
  path: string;
  hasGit: boolean;
  modifiedAtMs: number;
  rootName: string;
  added: boolean;
}

export function addedWorkspacePaths(projects: readonly BoardProject[]): Set<string> {
  const paths = new Set<string>();
  for (const project of projects) {
    for (const entry of parseProjectMetadata(project.description).entries) {
      if (entry.kind === 'workspace') paths.add(entry.value.replace(/[\\/]+$/u, ''));
    }
  }
  return paths;
}

export function pickerEntries(roots: readonly HostProjectRoot[], added: ReadonlySet<string>): PickerEntry[] {
  return roots.flatMap((root) =>
    [...root.projects]
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || left.name.localeCompare(right.name))
      .map((project) => ({ ...project, rootName: root.name, added: added.has(project.path) })),
  );
}

export function filterPickerEntries(entries: readonly PickerEntry[], query: string): PickerEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...entries];
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
}

export function breadcrumbSegments(path: string): { label: string; path: string }[] {
  const parts = path.split('/').filter((part) => part.length > 0);
  return parts.map((label, index) => ({ label, path: `/${parts.slice(0, index + 1).join('/')}` }));
}
