import { describe, expect, it } from 'vitest';
import { addedWorkspacePaths, breadcrumbSegments, filterPickerEntries, pickerEntries } from './project-picker';
import type { BoardProject, HostProjectRoot } from '../types';

const project = (description: string | null): BoardProject => ({
  id: 'p1', name: 'One', description,
  createdAt: '2026-08-15T00:00:00.000Z', createdAtMs: 0, updatedAt: '2026-08-15T00:00:00.000Z', updatedAtMs: 0,
});
const roots: HostProjectRoot[] = [{
  name: 'WebstormProjects', path: '/home/u/WebstormProjects', truncated: false,
  projects: [
    { name: 'older', path: '/home/u/WebstormProjects/older', hasGit: true, modifiedAtMs: 100 },
    { name: 'newer', path: '/home/u/WebstormProjects/newer', hasGit: false, modifiedAtMs: 200 },
  ],
}];

describe('project picker model', () => {
  it('collects workspace paths from bare-path and keyed descriptions, trailing slash trimmed', () => {
    const added = addedWorkspacePaths([project('/home/u/WebstormProjects/older/'), project('Workspace: /home/u/x'), project(null)]);
    expect(added).toEqual(new Set(['/home/u/WebstormProjects/older', '/home/u/x']));
  });
  it('orders entries most-recently-modified first and marks added', () => {
    const entries = pickerEntries(roots, new Set(['/home/u/WebstormProjects/older']));
    expect(entries.map((entry) => [entry.name, entry.added, entry.rootName])).toEqual([
      ['newer', false, 'WebstormProjects'],
      ['older', true, 'WebstormProjects'],
    ]);
  });
  it('filters case-insensitively on name and returns all for blank', () => {
    const entries = pickerEntries(roots, new Set());
    expect(filterPickerEntries(entries, ' NEW ').map((entry) => entry.name)).toEqual(['newer']);
    expect(filterPickerEntries(entries, '')).toHaveLength(2);
  });
  it('builds cumulative breadcrumbs', () => {
    expect(breadcrumbSegments('/home/u/WebstormProjects')).toEqual([
      { label: 'home', path: '/home' },
      { label: 'u', path: '/home/u' },
      { label: 'WebstormProjects', path: '/home/u/WebstormProjects' },
    ]);
  });
});
