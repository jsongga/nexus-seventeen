import { describe, expect, it, vi } from 'vitest';
import { createTaskBoardClient } from './client';

const now = '2026-08-21T12:00:00.000Z';

const finding = {
  findingId: 'finding-one',
  nodeId: 'node-one',
  stage: 'verification',
  round: 2,
  file: 'src/web/task-board/BoardApp.tsx',
  line: 42,
  category: 'correctness',
  severity: 'major',
  expected: 'Notifications refresh after a read.',
  actual: 'The stale notification remained.',
  blocking: true,
  createdAt: now,
  workItemId: 'work-item-one',
};

const park = {
  parkRecordId: 'park-one',
  workItemId: 'work-item-one',
  category: 'open_question',
  reason: 'Waiting for the operator.',
  parkedAt: now,
  resolvedAt: null,
  resolution: null,
  workItemTitle: 'Make notifications observable',
};

const notification = {
  notificationId: 'notification-one',
  sequence: 1,
  kind: 'park_aged',
  dedupeKey: 'park_aged:park-one',
  projectId: 'project-one',
  workItemId: 'work-item-one',
  summary: 'A work item has been parked for seven days.',
  createdAt: now,
  readAt: null,
  version: 3,
};

const gateAction = {
  gateActionId: 'gate-action-one',
  workItemId: 'work-item-one',
  gate: 'final_approve',
  actorId: 'human:operator',
  planRevisionId: 'plan-one',
  verifiedSha: '0123456789abcdef0123456789abcdef01234567',
  mergeSha: 'abcdef0123456789abcdef0123456789abcdef01',
  refId: null,
  note: null,
  createdAt: now,
};

const transition = {
  fromState: 'reviewing',
  toState: 'final_approval',
  actorType: 'system',
  actorId: 'system:pipeline',
  createdAt: now,
};

describe('observability HTTP client', () => {
  it('requests and projects ledgers, notifications, mark-read, and work-item audit', async () => {
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/ledgers/findings?projectId=project%2Fone')) {
        return new Response(JSON.stringify({
          categories: [{ category: 'correctness', severity: 'major', blocking: true, count: 1 }],
          perProject: [{ projectId: 'project/one', category: 'correctness', count: 1 }],
          recent: [finding],
        }));
      }
      if (url.endsWith('/v1/ledgers/parks')) {
        return new Response(JSON.stringify({ open: [park], resolved: [], recordsSince: '2026-08-20' }));
      }
      if (url.endsWith('/v1/notifications/notification-one/read')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ version: 3 });
        return new Response(JSON.stringify({ notification: { ...notification, readAt: now, version: 4 } }));
      }
      if (url.endsWith('/v1/notifications')) {
        return new Response(JSON.stringify({ unread: [notification], recentRead: [] }));
      }
      if (url.endsWith('/v1/work-items/work-item%2Fone/audit')) {
        return new Response(JSON.stringify({ gateActions: [gateAction], transitions: [transition] }));
      }
      return new Response(JSON.stringify({ error: { message: `Unexpected request: ${url}` } }), { status: 404 });
    });
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
      documentClientId: 'document-ui-test',
    });

    await expect(client.getFindingsLedger('project/one')).resolves.toMatchObject({
      recent: [expect.objectContaining({ findingId: finding.findingId, createdAtMs: Date.parse(now) })],
    });
    await expect(client.getParksLedger()).resolves.toMatchObject({
      open: [expect.objectContaining({ parkRecordId: park.parkRecordId, parkedAtMs: Date.parse(now), resolvedAtMs: null })],
      recordsSince: '2026-08-20',
    });
    await expect(client.getNotifications()).resolves.toMatchObject({
      unread: [expect.objectContaining({ notificationId: notification.notificationId, createdAtMs: Date.parse(now), readAtMs: null })],
    });
    await expect(client.markNotificationRead(notification.notificationId, notification.version)).resolves.toMatchObject({
      notificationId: notification.notificationId,
      version: 4,
      readAtMs: Date.parse(now),
    });
    await expect(client.getWorkItemAudit('work-item/one')).resolves.toMatchObject({
      gateActions: [expect.objectContaining({ gateActionId: gateAction.gateActionId, createdAtMs: Date.parse(now) })],
      transitions: [expect.objectContaining({ toState: 'final_approval', createdAtMs: Date.parse(now) })],
    });
  });

  it('omits the findings query when no project filter is supplied', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ categories: [], perProject: [], recent: [] })));
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
      documentClientId: 'document-ui-test',
    });

    await client.getFindingsLedger();
    expect(request.mock.calls[0]?.[0]).toBe('https://board.example.test/v1/ledgers/findings');
  });
});
