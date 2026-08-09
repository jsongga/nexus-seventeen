import type { BoardPage } from '../views/WorkspaceSidebar';

interface RouteSnapshotIds {
  tasks: readonly { id: string }[];
  workItems: readonly { id: string }[];
  projects: readonly { id: string }[];
  agents: readonly { id: string }[];
  documents: readonly { id: string }[];
}

/**
 * BoardPage <-> URL hash conversion.
 *
 * Kept free of React and DOM access so it can be unit tested under the node
 * test environment, and so the rules live in one readable place.
 *
 * Ids are percent-encoded because the board's identifier pattern permits '/',
 * ':' and '@' — an id like "acme/web" would otherwise be indistinguishable
 * from extra path segments.
 */

const tasksPage: BoardPage = { kind: 'tasks' };

/** Strips the leading '#' and/or '/' so both '#/agent/x' and '/agent/x' parse. */
function hashSegments(hash: string): string[] {
  const withoutMarker = hash.startsWith('#') ? hash.slice(1) : hash;
  const withoutLeadingSlash = withoutMarker.startsWith('/') ? withoutMarker.slice(1) : withoutMarker;
  return withoutLeadingSlash.split('/');
}

function acceptsSegmentCount(kind: string, segmentCount: number): boolean {
  switch (kind) {
    case 'tasks':
      return segmentCount === 1 || segmentCount === 2;
    case 'automation':
      return segmentCount === 1;
    case 'documents':
      return segmentCount === 1 || segmentCount === 2;
    case 'project':
    case 'agent':
    case 'intake':
      return segmentCount === 2;
    default:
      return false;
  }
}

/** Returns undefined for an absent id and null for an invalid encoded id. */
function decodeId(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function pageHashWithId(kind: 'tasks' | 'documents' | 'project' | 'agent' | 'intake', id: string): string {
  try {
    return `#/${kind}/${encodeURIComponent(id)}`;
  } catch {
    // Keep the route kind visible without claiming this was a tasks page. The
    // extra segment makes the sentinel invalid, so it safely parses to tasks.
    return `#/${kind}/%EF%BF%BD/unencodable`;
  }
}

export function pageToHash(page: BoardPage): string {
  switch (page.kind) {
    case 'tasks':
      return page.taskId ? pageHashWithId('tasks', page.taskId) : '#/tasks';
    case 'intake':
      return pageHashWithId('intake', page.workItemId);
    case 'automation':
      return '#/automation';
    case 'documents':
      return page.documentId ? pageHashWithId('documents', page.documentId) : '#/documents';
    case 'project':
      return pageHashWithId('project', page.projectId);
    case 'agent':
      return pageHashWithId('agent', page.agentId);
  }
}

export function hashToPage(hash: string): BoardPage {
  const segments = hashSegments(hash);
  const [kind, rawId] = segments;
  if (!acceptsSegmentCount(kind, segments.length)) return tasksPage;

  const id = decodeId(rawId);
  switch (kind) {
    case 'tasks':
      if (id === null) return tasksPage;
      return id === undefined ? tasksPage : { kind: 'tasks', taskId: id };
    case 'automation':
      return { kind: 'automation' };
    case 'documents':
      if (id === null) return tasksPage;
      return id === undefined ? { kind: 'documents' } : { kind: 'documents', documentId: id };
    case 'project':
      // A project or agent page without an id cannot render, so fall back
      // rather than producing a page that would immediately blank out.
      return typeof id === 'string' ? { kind: 'project', projectId: id } : tasksPage;
    case 'agent':
      return typeof id === 'string' ? { kind: 'agent', agentId: id } : tasksPage;
    case 'intake':
      return typeof id === 'string' ? { kind: 'intake', workItemId: id } : tasksPage;
    default:
      return tasksPage;
  }
}

/** Reconciles entity routes only after an authoritative snapshot is available. */
export function missingRouteFallback(
  page: BoardPage,
  snapshot: RouteSnapshotIds,
  observedTaskIds: ReadonlySet<string>,
): BoardPage | null {
  if (
    page.kind === 'tasks'
    && page.taskId
    && !snapshot.tasks.some((task) => task.id === page.taskId)
    && !observedTaskIds.has(page.taskId)
  ) return { kind: 'tasks' };
  if (page.kind === 'intake' && !snapshot.workItems.some((workItem) => workItem.id === page.workItemId)) return { kind: 'tasks' };
  if (page.kind === 'project' && !snapshot.projects.some((project) => project.id === page.projectId)) return { kind: 'tasks' };
  if (page.kind === 'agent' && !snapshot.agents.some((agent) => agent.id === page.agentId)) return { kind: 'tasks' };
  if (page.kind === 'documents' && page.documentId && !snapshot.documents.some((document) => document.id === page.documentId)) return { kind: 'documents' };
  return null;
}
