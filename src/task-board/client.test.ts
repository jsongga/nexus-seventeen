import { describe, expect, it, vi } from 'vitest';
import { createTaskBoardClient, parseBoardSnapshot } from './client';

const apiVersion = 'steward.task-board/v1';
const project = {
  apiVersion,
  projectId: 'project-one',
  name: 'Cicada platform',
  description: 'Make the product more reliable for customers.',
  version: 1,
  createdAt: '2026-07-19T10:00:00.000Z',
  updatedAt: '2026-07-19T10:15:00.000Z',
};
const agent = {
  apiVersion,
  agentId: 'billing-engineer',
  projectId: 'project-one',
  role: 'engineer',
  area: 'Billing',
  mission: 'Keep customer billing dependable.',
  model: 'economy-coding-model',
  status: 'running',
  createdAt: '2026-07-19T10:01:00.000Z',
};
const manager = {
  ...agent,
  agentId: 'release-manager',
  role: 'manager',
  area: 'Release review',
  mission: 'Review work before it reaches the human release gate.',
  status: 'idle',
};
const task = {
  apiVersion,
  taskId: 'task-one',
  projectId: 'project-one',
  parentTaskId: null,
  kind: 'work',
  requiredRole: null,
  title: 'Improve invoice recovery',
  objective: 'Customers can recover a failed invoice without support.',
  acceptanceCriteria: 'The recovery path passes its focused tests.',
  workspaceRefs: ['/workspace/billing'],
  status: 'in_progress',
  assignedAgentId: 'billing-engineer',
  assignedRole: 'engineer',
  expectedAgentMinutes: 30,
  startedAt: '2026-07-19T10:15:00.000Z',
  expectedCompletedAt: '2026-07-19T10:45:00.000Z',
  endedAt: null,
  result: null,
  version: 2,
  createdAt: '2026-07-19T10:10:00.000Z',
  updatedAt: '2026-07-19T10:15:00.000Z',
};
const managerReview = {
  ...task,
  taskId: 'task-manager-review',
  parentTaskId: task.taskId,
  kind: 'manager_review',
  requiredRole: 'manager',
  title: 'Manager review: Improve invoice recovery',
  status: 'backlog',
  assignedAgentId: null,
  assignedRole: null,
  expectedAgentMinutes: 15,
  startedAt: null,
  expectedCompletedAt: null,
  version: 1,
};
const humanCheck = {
  ...managerReview,
  taskId: 'task-human-check',
  parentTaskId: managerReview.taskId,
  kind: 'human_check',
  requiredRole: null,
  title: 'Human check: Improve invoice recovery',
};
const question = {
  apiVersion,
  questionId: 'question-one',
  projectId: 'project-one',
  taskId: 'task-one',
  agentId: 'billing-engineer',
  runId: 'run-one',
  question: 'Should recovery preserve the previous payment method?',
  status: 'open',
  answer: null,
  askedAt: '2026-07-19T10:20:00.000Z',
  answeredAt: null,
  answeredBy: null,
  version: 1,
};
const run = {
  apiVersion,
  runId: 'run-one',
  claimId: 'claim-one',
  projectId: 'project-one',
  agentId: 'billing-engineer',
  wakeupId: 'wakeup-one',
  taskId: 'task-one',
  status: 'active',
  startedAt: '2026-07-19T10:15:00.000Z',
  endedAt: null,
  result: null,
};
const event = {
  apiVersion,
  eventId: 'event-one',
  projectId: 'project-one',
  taskId: 'task-one',
  actorType: 'agent',
  actorId: 'billing-engineer',
  eventType: 'agent_run_claimed',
  data: { runId: 'run-one', wakeReason: 'human_assignment' },
  createdAt: '2026-07-19T10:15:00.000Z',
};

function boardSnapshot() {
  return {
    apiVersion,
    project,
    agents: [agent],
    tasks: [task],
    openQuestions: [question],
    recentRuns: [run],
    recentInterrupts: [],
    recentEvents: [event],
  };
}

describe('task-board protocol projection', () => {
  it('maps the durable service contract into user-facing task and run state', () => {
    const snapshot = parseBoardSnapshot(boardSnapshot());
    expect(snapshot.projects[0]).toMatchObject({ id: 'project-one' });
    expect(snapshot.agents[0]).toMatchObject({ id: 'billing-engineer', status: 'running', currentTaskId: 'task-one' });
    expect(snapshot.tasks[0]).toMatchObject({ id: 'task-one', status: 'waiting_for_human', expectedAgentMinutes: 30 });
    expect(snapshot.questions[0]).toMatchObject({ id: 'question-one', version: 1 });
    expect(snapshot.runs[0]).toMatchObject({ id: 'run-one', taskId: 'task-one', wakeReason: 'human_assignment' });
  });

  it('rejects invalid versions, model status values, and non-15-minute estimates', () => {
    expect(() => parseBoardSnapshot({ ...boardSnapshot(), apiVersion: 'old' })).toThrow(/apiVersion/u);
    expect(() => parseBoardSnapshot({
      ...boardSnapshot(),
      agents: [{ ...agent, status: 'online' }],
    })).toThrow(/status/u);
    expect(() => parseBoardSnapshot({
      ...boardSnapshot(),
      tasks: [{ ...task, expectedAgentMinutes: 17 }],
    })).toThrow(/15-minute/u);
    expect(() => parseBoardSnapshot({
      ...boardSnapshot(),
      tasks: [{ ...task, kind: 'review' }],
    })).toThrow(/kind/u);
    expect(() => parseBoardSnapshot({
      ...boardSnapshot(),
      tasks: [{ ...task, kind: 'manager_review', requiredRole: 'engineer' }],
    })).toThrow(/requiredRole/u);
  });
});

describe('task-board HTTP client', () => {
  it('creates an assigned agent query and wake with one atomic task request', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return new Response('{}');
    });
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
    });
    const workspaceRefs = [
      '/workspace/billing',
      '/workspace/billing',
      ...Array.from({ length: 34 }, (_, index) => `/workspace/reference-${index}`),
    ];

    await client.createAgentQuery({
      projectId: project.projectId,
      agentId: agent.agentId,
      assignedRole: 'engineer',
      prompt: '  Explain the invoice retry behavior\nand propose follow-up work if needed.  ',
      workspaceRefs,
      routingContext: '- Billing: billing-engineer (engineer, Billing)',
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(calls[0]?.[0]).toBe('https://board.example.test/v1/projects/project-one/tasks');
    expect(calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
      parentTaskId: null,
      title: 'Request for billing-engineer: Explain the invoice retry behavior and propose follow-up work if needed.',
      objective: 'Explain the invoice retry behavior\nand propose follow-up work if needed.\n\nCompany routing map (use this only to identify the best project or agent):\n- Billing: billing-engineer (engineer, Billing)',
      acceptanceCriteria: 'Return a concise answer or result. If more work is needed, propose child tasks for human approval; do not assign agents or deploy.',
      workspaceRefs: ['/workspace/billing', ...workspaceRefs.slice(2, 33)],
      assignedAgentId: 'billing-engineer',
      assignedRole: 'engineer',
      expectedAgentMinutes: 15,
    });
    expect(calls.some(([url]) => url.includes('/resume') || url.includes('/interrupt'))).toBe(false);
    expect(calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('does not send an empty agent query', async () => {
    const request = vi.fn();
    const client = createTaskBoardClient({ fetch: request as unknown as typeof fetch });

    await expect(client.createAgentQuery({
      projectId: project.projectId,
      agentId: agent.agentId,
      assignedRole: 'engineer',
      prompt: '   ',
      workspaceRefs: [],
    })).rejects.toThrow(/question or request/u);
    expect(request).not.toHaveBeenCalled();
  });

  it('uses the exact API and keeps notes separate from the three wake operations', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      calls.push([path, init]);
      if (path.endsWith('/v1/projects')) return new Response(JSON.stringify({ projects: [project] }));
      if (path.endsWith('/v1/projects/project-one/board')) return new Response(JSON.stringify(boardSnapshot()));
      if (path.includes('/v1/tasks/task-one/messages?after=0')) {
        return new Response(JSON.stringify({ messages: [{
          apiVersion,
          messageId: 'message-one',
          sequence: 1,
          projectId: 'project-one',
          taskId: 'task-one',
          runId: 'run-one',
          actorType: 'agent',
          actorId: 'billing-engineer',
          kind: 'progress',
          body: 'Research complete; planning the smallest safe change.',
          createdAt: '2026-07-19T10:18:00.000Z',
        }], cursor: 1 }));
      }
      return new Response('{}');
    });
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      token: 'human-token-value',
      fetch: request as unknown as typeof fetch,
    });

    const snapshot = await client.getSnapshot();
    expect(snapshot.messages).toHaveLength(1);
    await client.assignTask('task-one', { agentId: 'billing-engineer', expectedAgentMinutes: 45, version: 2 });
    await client.addMessage('task-one', { body: 'Preserve the existing payment method.', version: 2 });
    await client.answerQuestion('question-one', { answer: 'Yes, preserve it.' });
    await client.resumeTask('task-one', { version: 2 });
    await client.interruptRun('run-one');

    const assignment = calls.find(([url, init]) => url.endsWith('/v1/tasks/task-one') && init?.method === 'PATCH');
    expect(JSON.parse(String(assignment?.[1]?.body))).toEqual({
      version: 2,
      assignedAgentId: 'billing-engineer',
      assignedRole: 'engineer',
      expectedAgentMinutes: 45,
      status: 'queued',
    });
    const note = calls.find(([url, init]) => url.endsWith('/v1/tasks/task-one/messages') && init?.method === 'POST');
    expect(JSON.parse(String(note?.[1]?.body))).toMatchObject({ kind: 'note', body: 'Preserve the existing payment method.' });
    expect(calls.some(([url]) => url.endsWith('/v1/questions/question-one/answer'))).toBe(true);
    expect(calls.some(([url]) => url.endsWith('/v1/agents/billing-engineer/resume'))).toBe(true);
    expect(calls.some(([url]) => url.endsWith('/v1/agents/billing-engineer/interrupt'))).toBe(true);
    expect(calls.every(([, init]) => (init?.headers as Record<string, string> | undefined)?.authorization === 'Bearer human-token-value')).toBe(true);
    expect(calls.every(([, init]) => init?.credentials === 'omit' && init.redirect === 'error')).toBe(true);
  });

  it('will not send a bearer token over a remote insecure or scheme-relative URL', () => {
    expect(() => createTaskBoardClient({ baseUrl: 'http://board.example.test', token: 'secret' })).toThrow(/HTTPS/u);
    expect(() => createTaskBoardClient({ baseUrl: '//board.example.test', token: 'secret' })).toThrow(/invalid/u);
    expect(() => createTaskBoardClient({ baseUrl: 'http://127.0.0.1:4318', token: 'secret' })).not.toThrow();
  });

  it('enforces manager review assignment and records a human check without waking an agent', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      calls.push([path, init]);
      if (path.endsWith('/v1/projects')) return new Response(JSON.stringify({ projects: [project] }));
      if (path.endsWith('/v1/projects/project-one/board')) {
        return new Response(JSON.stringify({
          ...boardSnapshot(),
          agents: [agent, manager],
          tasks: [managerReview, humanCheck],
          openQuestions: [],
          recentQuestions: [],
          recentRuns: [],
          recentEvents: [],
        }));
      }
      if (path.includes('/messages?after=0')) return new Response(JSON.stringify({ messages: [], cursor: 0 }));
      return new Response('{}');
    });
    const client = createTaskBoardClient({ baseUrl: 'https://board.example.test', fetch: request as unknown as typeof fetch });

    const snapshot = await client.getSnapshot();
    expect(snapshot.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: managerReview.taskId, kind: 'manager_review', requiredRole: 'manager' }),
      expect.objectContaining({ id: humanCheck.taskId, kind: 'human_check', requiredRole: null }),
    ]));
    await expect(client.assignTask(managerReview.taskId, { agentId: agent.agentId, expectedAgentMinutes: 15, version: 1 })).rejects.toThrow(/requires a manager/u);
    await expect(client.assignTask(humanCheck.taskId, { agentId: manager.agentId, expectedAgentMinutes: 15, version: 1 })).rejects.toThrow(/cannot be assigned/u);
    await expect(client.resumeTask(humanCheck.taskId, { version: 1 })).rejects.toThrow(/cannot wake/u);
    await expect(client.decideHumanCheck(managerReview.taskId, { version: 1, status: 'completed', result: 'Ready.' })).rejects.toThrow(/Only human checks/u);
    await expect(client.decideHumanCheck(humanCheck.taskId, { version: 1, status: 'completed', result: '  ' })).rejects.toThrow(/rationale/u);

    await client.assignTask(managerReview.taskId, { agentId: manager.agentId, expectedAgentMinutes: 15, version: 1 });
    await client.decideHumanCheck(humanCheck.taskId, {
      version: 1,
      status: 'completed',
      result: 'Approved for an external human-controlled release step. Rationale: focused checks passed.',
    });

    const patches = calls
      .filter(([, init]) => init?.method === 'PATCH')
      .map(([url, init]) => [url, JSON.parse(String(init?.body))] as const);
    expect(patches).toEqual([
      ['https://board.example.test/v1/tasks/task-manager-review', {
        version: 1,
        assignedAgentId: manager.agentId,
        assignedRole: 'manager',
        expectedAgentMinutes: 15,
        status: 'queued',
      }],
      ['https://board.example.test/v1/tasks/task-human-check', {
        version: 1,
        status: 'completed',
        result: 'Approved for an external human-controlled release step. Rationale: focused checks passed.',
      }],
    ]);
    expect(calls.some(([url]) => url.includes('/resume') || url.includes('/interrupt'))).toBe(false);
  });
});
