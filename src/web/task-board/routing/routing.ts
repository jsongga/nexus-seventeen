import type { BoardPage } from '../views/WorkspaceSidebar';

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
    case 'automation':
      return segmentCount === 1;
    case 'documents':
      return segmentCount === 1 || segmentCount === 2;
    case 'project':
    case 'agent':
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

function pageHashWithId(kind: 'documents' | 'project' | 'agent', id: string): string {
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
      return '#/tasks';
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
      return tasksPage;
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
    default:
      return tasksPage;
  }
}
