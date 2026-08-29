import { describe, expect, it, vi } from 'vitest';
import { createTaskBoardClient } from './client';

const apiVersion = 'steward.task-board/v1';
const timestamp = '2026-08-29T12:00:00.000Z';
const child = {
  apiVersion,
  workItemId: 'child-expand',
  originalRequest: 'Publish the provider interface.',
  refinedObjective: 'Publish the provider interface.',
  priority: 'normal',
  taskType: 'standard',
  projectTarget: { mode: 'explicit', projectId: 'provider-project' },
  resolvedProjectId: 'provider-project',
  parentWorkItemId: 'parent-one',
  phase: 'expand',
  childOrdinal: 0,
  planningTaskId: null,
  state: 'merged',
  currentStage: null,
  createdBy: 'human:operator',
  version: 4,
  createdAt: timestamp,
  updatedAt: timestamp,
  endedAt: timestamp,
  cancelledReason: null,
  archivedAt: null,
  deployAttested: false,
  mergeSha: '0123456789abcdef0123456789abcdef01234567',
};

const gateAction = {
  gateActionId: 'deploy-attestation-one',
  workItemId: child.workItemId,
  gate: 'deploy_attest',
  actorId: 'human:operator',
  planRevisionId: 'child-plan-one',
  verifiedSha: null,
  mergeSha: null,
  refId: null,
  note: 'Production rollout complete.',
  createdAt: timestamp,
};

describe('decomposition client', () => {
  it('parses children and dependencies and sends attestation and resume actions', async () => {
    const calls: Array<[string, string | undefined, unknown]> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push([url, init?.method, init?.body === undefined ? undefined : JSON.parse(String(init.body))]);
      if (url.endsWith('/v1/work-items/parent-one/children')) {
        return new Response(JSON.stringify({ children: [child] }));
      }
      if (url.endsWith('/v1/work-items/contract-one/dependencies')) {
        return new Response(JSON.stringify({ dependencies: [{
          workItemId: 'contract-one',
          dependsOnWorkItemId: child.workItemId,
        }] }));
      }
      if (url.endsWith(`/v1/work-items/${child.workItemId}/attest-deploy`)) {
        return new Response(JSON.stringify({ gateAction, duplicate: false }));
      }
      if (url.endsWith('/v1/work-items/parent-one/resume')) {
        return new Response(JSON.stringify({
          workItem: {
            ...child,
            workItemId: 'parent-one',
            parentWorkItemId: null,
            phase: null,
            childOrdinal: null,
            state: 'coordinating',
            endedAt: null,
            deployAttested: undefined,
            mergeSha: undefined,
            transitions: [],
          },
        }));
      }
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), { status: 404 });
    });
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
    });

    await expect(client.getWorkItemChildren('parent-one')).resolves.toEqual([expect.objectContaining({
      id: child.workItemId,
      phase: 'expand',
      childOrdinal: 0,
      deployAttested: false,
      mergeSha: child.mergeSha,
    })]);
    await expect(client.getWorkItemDependencies('contract-one')).resolves.toEqual([{
      workItemId: 'contract-one',
      dependsOnWorkItemId: child.workItemId,
    }]);
    await expect(client.attestDeployment(child.workItemId, { note: '  Production rollout complete.  ' })).resolves.toEqual({
      gateAction: expect.objectContaining({
        id: gateAction.gateActionId,
        gate: 'deploy_attest',
        note: 'Production rollout complete.',
        createdAtMs: Date.parse(timestamp),
      }),
      duplicate: false,
    });
    await expect(client.resumeWorkItem('parent-one')).resolves.toMatchObject({ id: 'parent-one', state: 'coordinating' });

    expect(calls).toEqual([
      ['https://board.example.test/v1/work-items/parent-one/children', undefined, undefined],
      ['https://board.example.test/v1/work-items/contract-one/dependencies', undefined, undefined],
      [`https://board.example.test/v1/work-items/${child.workItemId}/attest-deploy`, 'POST', { note: 'Production rollout complete.' }],
      ['https://board.example.test/v1/work-items/parent-one/resume', 'POST', undefined],
    ]);
  });

  it('rejects malformed child readiness projections', async () => {
    const client = createTaskBoardClient({
      fetch: async () => new Response(JSON.stringify({ children: [{ ...child, deployAttested: 'yes' }] })),
    });

    await expect(client.getWorkItemChildren('parent-one')).rejects.toThrow(/deployAttested/u);
  });
});
