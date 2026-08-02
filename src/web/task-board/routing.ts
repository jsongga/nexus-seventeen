import type { BoardPage } from './WorkspaceSidebar';

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

/** decodeURIComponent throws on malformed input such as a bare '%'. */
function decodeId(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function pageToHash(page: BoardPage): string {
  switch (page.kind) {
    case 'tasks':
      return '#/tasks';
    case 'automation':
      return '#/automation';
    case 'documents':
      return page.documentId ? `#/documents/${encodeURIComponent(page.documentId)}` : '#/documents';
    case 'project':
      return `#/project/${encodeURIComponent(page.projectId)}`;
    case 'agent':
      return `#/agent/${encodeURIComponent(page.agentId)}`;
  }
}

export function hashToPage(hash: string): BoardPage {
  const [kind, rawId] = hashSegments(hash);
  const id = decodeId(rawId);
  switch (kind) {
    case 'tasks':
      return tasksPage;
    case 'automation':
      return { kind: 'automation' };
    case 'documents':
      return id ? { kind: 'documents', documentId: id } : { kind: 'documents' };
    case 'project':
      // A project or agent page without an id cannot render, so fall back
      // rather than producing a page that would immediately blank out.
      return id ? { kind: 'project', projectId: id } : tasksPage;
    case 'agent':
      return id ? { kind: 'agent', agentId: id } : tasksPage;
    default:
      return tasksPage;
  }
}
