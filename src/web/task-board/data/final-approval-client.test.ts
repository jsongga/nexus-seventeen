import { describe, expect, it, vi } from 'vitest';
import { createTaskBoardClient } from './client';

const timestamp = '2026-08-19T12:00:00.000Z';

const workItem = {
  apiVersion: 'steward.task-board/v1',
  workItemId: 'work-item-one',
  originalRequest: 'Review the pipeline.',
  refinedObjective: null,
  priority: 'normal',
  projectTarget: { mode: 'explicit', projectId: 'project-one' },
  resolvedProjectId: 'project-one',
  planningTaskId: 'planning-one',
  pipelineBranch: 'task/work-item-one',
  baseSha: '0123456789abcdef0123456789abcdef01234567',
  state: 'final_approval',
  currentStage: null,
  createdBy: 'human:alice',
  version: 7,
  createdAt: timestamp,
  updatedAt: timestamp,
  endedAt: null,
  cancelledReason: null,
  archivedAt: null,
  transitions: [],
};

const pipelineSummary = {
  commits: [{ sha: 'abcdef0123456789abcdef0123456789abcdef01', subject: 'Pipeline commit' }],
  diffstat: ' src/change.ts | 1 +',
  filesTouched: ['src/change.ts'],
  declaredScope: ['src'],
  scopeOk: true,
  assumptions: ['The contract remains stable.'],
  midRunAssumptions: [],
  verify: [{
    verifyAttemptId: 'verify-one',
    nodeId: 'node-one',
    stage: 'testing',
    attempt: 1,
    verifyRunId: 'run-one',
    workspacePath: null,
    state: 'green',
    checkResults: [],
    detail: 'Passed.',
    createdAt: timestamp,
    endedAt: timestamp,
  }],
  criteria: ['The change is reviewable.'],
  criterionChecks: [],
};

describe('final approval client', () => {
  it('validates the pipeline summary response while defaulting fields absent from older responses', async () => {
    const request = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(pipelineSummary)));
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
    });

    await expect(client.getPipelineSummary('work-item-one')).resolves.toEqual({
      ...pipelineSummary,
      findings: [],
      designRecord: null,
    });
    expect(request.mock.calls[0]?.[0]).toBe('https://board.example.test/v1/work-items/work-item-one/pipeline-summary');

    const invalid = createTaskBoardClient({
      fetch: async () => new Response(JSON.stringify({ ...pipelineSummary, scopeOk: 'yes' })),
    });
    await expect(invalid.getPipelineSummary('work-item-one')).rejects.toThrow(/scopeOk/u);
  });

  it('sends optimistic versions and a trimmed bounded final-rejection note', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return new Response(JSON.stringify({ workItem }));
    });
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
    });

    await client.approvePipelineMerge('work-item-one', { version: 7 });
    await client.rejectFinalApproval('work-item-one', { version: 7, note: '  Add rollback coverage.  ' });

    expect(calls.map(([url, init]) => [url, init?.method, JSON.parse(String(init?.body))])).toEqual([
      [
        'https://board.example.test/v1/work-items/work-item-one/approve-merge',
        'POST',
        { version: 7 },
      ],
      [
        'https://board.example.test/v1/work-items/work-item-one/reject-final',
        'POST',
        { version: 7, note: 'Add rollback coverage.' },
      ],
    ]);
  });
});
