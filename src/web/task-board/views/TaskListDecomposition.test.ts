import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { groupWorkItems } from '../model/work-item-tree';
import type { BoardProject, BoardWorkItem } from '../types';
import { WorkItemRow } from './TaskList';

const timestamp = '2026-08-29T12:00:00.000Z';
const project: BoardProject = {
  id: 'project-one',
  name: 'Provider project',
  description: null,
  repoPath: '/repos/provider',
  createdAt: timestamp,
  createdAtMs: Date.parse(timestamp),
  updatedAt: timestamp,
  updatedAtMs: Date.parse(timestamp),
};

function workItem(id: string, overrides: Partial<BoardWorkItem> = {}): BoardWorkItem {
  return {
    id,
    originalRequest: id,
    refinedObjective: null,
    priority: 'normal',
    taskType: 'standard',
    projectTarget: { mode: 'explicit', projectId: project.id },
    resolvedProjectId: project.id,
    parentWorkItemId: null,
    phase: null,
    childOrdinal: null,
    planningTaskId: null,
    state: 'coordinating',
    currentStage: null,
    createdBy: 'human:operator',
    version: 1,
    createdAt: timestamp,
    createdAtMs: Date.parse(timestamp),
    updatedAt: timestamp,
    updatedAtMs: Date.parse(timestamp),
    endedAt: null,
    endedAtMs: null,
    cancelledReason: null,
    archivedAt: null,
    archivedAtMs: null,
    ...overrides,
  };
}

describe('decomposition task-list rows', () => {
  it('keeps article/button semantics while rendering parent progress and indented phase children', () => {
    const parent = workItem('parent', { refinedObjective: 'Coordinate the rollout.' });
    const expand = workItem('expand', { parentWorkItemId: parent.id, phase: 'expand', childOrdinal: 0, state: 'merged' });
    const migrate = workItem('migrate', { parentWorkItemId: parent.id, phase: 'migrate', childOrdinal: 1, state: 'implementing' });
    const abandoned = workItem('abandoned', { parentWorkItemId: parent.id, childOrdinal: 2, state: 'abandoned' });
    const rows = groupWorkItems([migrate, parent, abandoned, expand]);
    const markup = renderToStaticMarkup(createElement('div', null, rows.map((row) => createElement(WorkItemRow, {
      key: row.workItem.id,
      workItem: row.workItem,
      projects: [project],
      selected: false,
      onSelect: () => undefined,
      buttonRef: () => undefined,
      depth: row.depth,
      childCount: row.childCount,
      mergedChildCount: row.mergedChildCount,
      abandonedChildCount: row.abandonedChildCount,
      dependencyHint: row.dependencyHint,
    }))));

    expect(markup.match(/<article/gu)).toHaveLength(4);
    expect(markup.match(/<button/gu)).toHaveLength(4);
    expect(markup).toContain('1 of 2 children merged');
    expect(markup).toContain('· 1 abandoned');
    expect(markup).toContain('Expand');
    expect(markup).toContain('Migrate');
    expect(markup).toContain('after Expand');
    expect(markup).toContain('ml-8');
  });
});
