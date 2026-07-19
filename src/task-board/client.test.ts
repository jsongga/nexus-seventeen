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
const task = {
  apiVersion,
  taskId: 'task-one',
  projectId: 'project-one',
  parentTaskId: null,
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
  });
});

describe('task-board HTTP client', () => {
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
});
