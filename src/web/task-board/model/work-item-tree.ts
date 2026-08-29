import type { BoardWorkItem } from '../types';

export interface WorkItemTreeRow {
  workItem: BoardWorkItem;
  depth: 0 | 1;
  childCount: number;
  mergedChildCount: number;
  abandonedChildCount: number;
  dependencyHint: string | null;
}

function childOrder(
  positions: ReadonlyMap<string, number>,
  left: BoardWorkItem,
  right: BoardWorkItem,
): number {
  const leftOrdinal = left.childOrdinal ?? Number.MAX_SAFE_INTEGER;
  const rightOrdinal = right.childOrdinal ?? Number.MAX_SAFE_INTEGER;
  return leftOrdinal - rightOrdinal
    || (positions.get(left.id) ?? 0) - (positions.get(right.id) ?? 0)
    || left.id.localeCompare(right.id);
}

export function workItemDependencyHint(workItem: BoardWorkItem): string | null {
  if (workItem.phase === 'migrate') return 'after Expand';
  if (workItem.phase === 'contract') return 'after Migrate';
  return null;
}

/**
 * Projects the flat board collection into one accessible render order without
 * mutating the server-owned snapshot. Unknown parents remain visible as roots.
 */
export function groupWorkItems(workItems: readonly BoardWorkItem[]): WorkItemTreeRow[] {
  const positions = new Map(workItems.map((workItem, index) => [workItem.id, index] as const));
  const ids = new Set(positions.keys());
  const childrenByParent = new Map<string, BoardWorkItem[]>();
  for (const workItem of workItems) {
    if (workItem.parentWorkItemId === null || !ids.has(workItem.parentWorkItemId)) continue;
    const children = childrenByParent.get(workItem.parentWorkItemId) ?? [];
    children.push(workItem);
    childrenByParent.set(workItem.parentWorkItemId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => childOrder(positions, left, right));
  }

  const rows: WorkItemTreeRow[] = [];
  const emitted = new Set<string>();
  const append = (workItem: BoardWorkItem, depth: 0 | 1) => {
    if (emitted.has(workItem.id)) return;
    emitted.add(workItem.id);
    const children = childrenByParent.get(workItem.id) ?? [];
    const activeChildren = children.filter((child) => child.state !== 'abandoned' && child.state !== 'dead_letter');
    rows.push({
      workItem,
      depth,
      childCount: activeChildren.length,
      mergedChildCount: activeChildren.filter((child) => child.state === 'merged').length,
      abandonedChildCount: children.length - activeChildren.length,
      dependencyHint: workItem.parentWorkItemId === null ? null : workItemDependencyHint(workItem),
    });
    if (depth === 0) {
      for (const child of children) append(child, 1);
    }
  };

  for (const workItem of workItems) {
    if (workItem.parentWorkItemId === null || !ids.has(workItem.parentWorkItemId)) append(workItem, 0);
  }
  // Defensive rolling-upgrade fallback for malformed cycles or nested rows.
  for (const workItem of workItems) append(workItem, 0);
  return rows;
}
