import { describe, expect, it } from 'vitest';
import type { BoardPage } from './WorkspaceSidebar';
import { hashToPage, pageToHash } from './routing';

const pages: BoardPage[] = [
  { kind: 'tasks' },
  { kind: 'automation' },
  { kind: 'documents' },
  { kind: 'documents', documentId: 'doc-1' },
  { kind: 'project', projectId: 'project-1' },
  { kind: 'agent', agentId: 'agent-1' },
];

describe('pageToHash', () => {
  it('writes the documented form for every page kind', () => {
    expect(pageToHash({ kind: 'tasks' })).toBe('#/tasks');
    expect(pageToHash({ kind: 'automation' })).toBe('#/automation');
    expect(pageToHash({ kind: 'documents' })).toBe('#/documents');
    expect(pageToHash({ kind: 'documents', documentId: 'doc-1' })).toBe('#/documents/doc-1');
    expect(pageToHash({ kind: 'project', projectId: 'project-1' })).toBe('#/project/project-1');
    expect(pageToHash({ kind: 'agent', agentId: 'agent-1' })).toBe('#/agent/agent-1');
  });

  it('encodes ids that contain characters the identifier pattern allows', () => {
    // identifierPattern permits '/', ':' and '@', which would otherwise be read
    // as path structure.
    expect(pageToHash({ kind: 'project', projectId: 'acme/web' })).toBe('#/project/acme%2Fweb');
    expect(pageToHash({ kind: 'agent', agentId: 'bot@host' })).toBe('#/agent/bot%40host');
  });
});

describe('hashToPage', () => {
  it('round-trips every page kind', () => {
    for (const page of pages) {
      expect(hashToPage(pageToHash(page))).toEqual(page);
    }
  });

  it('round-trips ids containing reserved characters', () => {
    const page: BoardPage = { kind: 'project', projectId: 'acme/web' };
    expect(hashToPage(pageToHash(page))).toEqual(page);
  });

  it('falls back to tasks for anything it does not recognise', () => {
    expect(hashToPage('')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/nonsense')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/project')).toEqual({ kind: 'tasks' });   // id required
    expect(hashToPage('#/agent')).toEqual({ kind: 'tasks' });     // id required
    expect(hashToPage('#/project/')).toEqual({ kind: 'tasks' });  // empty id
    expect(hashToPage('not-a-hash')).toEqual({ kind: 'tasks' });
  });

  it('never throws on malformed percent-encoding', () => {
    // decodeURIComponent('%') throws URIError; routing must absorb it.
    expect(() => hashToPage('#/project/%')).not.toThrow();
    expect(hashToPage('#/project/%')).toEqual({ kind: 'tasks' });
  });

  it('accepts a hash with no leading marker', () => {
    expect(hashToPage('/tasks')).toEqual({ kind: 'tasks' });
    expect(hashToPage('/agent/agent-1')).toEqual({ kind: 'agent', agentId: 'agent-1' });
  });
});
