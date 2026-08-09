import { describe, expect, it } from 'vitest';
import type { BoardPage } from '../views/WorkspaceSidebar';
import { hashToPage, missingRouteFallback, pageToHash } from './routing';

const pages: BoardPage[] = [
  { kind: 'tasks' },
  { kind: 'tasks', taskId: 'task-1' },
  { kind: 'intake', workItemId: 'work-item-1' },
  { kind: 'automation' },
  { kind: 'documents' },
  { kind: 'documents', documentId: 'doc-1' },
  { kind: 'project', projectId: 'project-1' },
  { kind: 'agent', agentId: 'agent-1' },
];

describe('pageToHash', () => {
  it('writes the documented form for every page kind', () => {
    expect(pageToHash({ kind: 'tasks' })).toBe('#/tasks');
    expect(pageToHash({ kind: 'tasks', taskId: 'task-1' })).toBe('#/tasks/task-1');
    expect(pageToHash({ kind: 'intake', workItemId: 'work-item-1' })).toBe('#/intake/work-item-1');
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
    expect(pageToHash({ kind: 'intake', workItemId: 'intake/acme' })).toBe('#/intake/intake%2Facme');
    expect(pageToHash({ kind: 'tasks', taskId: 'task/acme' })).toBe('#/tasks/task%2Facme');
  });

  it('never throws when encoding an id it cannot represent', () => {
    const loneSurrogate = '\uD800';
    expect(() => pageToHash({ kind: 'project', projectId: loneSurrogate })).not.toThrow();
    const hash = pageToHash({ kind: 'project', projectId: loneSurrogate });
    expect(hash).toBe('#/project/%EF%BF%BD/unencodable');
    expect(hash).not.toBe('#/tasks');
    expect(hashToPage(hash)).toEqual({ kind: 'tasks' });
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
    expect(hashToPage('#/intake')).toEqual({ kind: 'tasks' });    // id required
    expect(hashToPage('#/tasks/')).toEqual({ kind: 'tasks' });    // empty optional id
    expect(hashToPage('#/project/')).toEqual({ kind: 'tasks' });  // empty id
    expect(hashToPage('not-a-hash')).toEqual({ kind: 'tasks' });
  });

  it('never throws on malformed percent-encoding', () => {
    // decodeURIComponent('%') throws URIError; routing must absorb it.
    expect(() => hashToPage('#/project/%')).not.toThrow();
    expect(hashToPage('#/project/%')).toEqual({ kind: 'tasks' });
  });

  it('rejects hashes with more segments than the route accepts', () => {
    expect(hashToPage('#/project/real/ignored')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/agent/real/ignored')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/intake/real/ignored')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/automation/ignored')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/tasks/real/ignored')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/documents/doc-1/ignored')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/tasks/')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/documents/')).toEqual({ kind: 'tasks' });
  });

  it('treats a malformed id as malformed on every route, not just some', () => {
    expect(hashToPage('#/project/%')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/agent/%')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/intake/%')).toEqual({ kind: 'tasks' });
    expect(hashToPage('#/tasks/%')).toEqual({ kind: 'tasks' });
    // Regression: this previously resolved to the documents index page.
    expect(hashToPage('#/documents/%')).toEqual({ kind: 'tasks' });
  });

  it('accepts a hash with no leading marker', () => {
    expect(hashToPage('/tasks')).toEqual({ kind: 'tasks' });
    expect(hashToPage('/agent/agent-1')).toEqual({ kind: 'agent', agentId: 'agent-1' });
    expect(hashToPage('/intake/work-item-1')).toEqual({ kind: 'intake', workItemId: 'work-item-1' });
    expect(hashToPage('/tasks/task-1')).toEqual({ kind: 'tasks', taskId: 'task-1' });
  });
});

describe('missingRouteFallback', () => {
  const snapshotIds = {
    tasks: [{ id: 'task-present' }],
    workItems: [],
    projects: [],
    agents: [],
    documents: [],
  };

  it('canonicalizes a task id that has never appeared in an authoritative snapshot', () => {
    expect(missingRouteFallback(
      { kind: 'tasks', taskId: 'task-never-observed' },
      snapshotIds,
      new Set(),
    )).toEqual({ kind: 'tasks' });
  });

  it('keeps the routed placeholder for a task that was observed before removal', () => {
    expect(missingRouteFallback(
      { kind: 'tasks', taskId: 'task-observed-then-removed' },
      snapshotIds,
      new Set(['task-observed-then-removed']),
    )).toBeNull();
  });

  it('keeps a task route when the current snapshot contains the task', () => {
    expect(missingRouteFallback(
      { kind: 'tasks', taskId: 'task-present' },
      snapshotIds,
      new Set(),
    )).toBeNull();
  });
});
