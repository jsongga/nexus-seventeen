import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal } from '../../components/ui';
import type { TaskBoardClient } from '../data/client';
import type { BoardAgent, BoardProject, BoardSnapshot } from '../types';

vi.mock('../../components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/ui')>();
  return { ...actual, Modal: vi.fn(() => null) };
});

import {
  AgentPage,
  ProjectPage,
  activityUpdates,
  agentPageUsesPointOfContactMode,
  deriveInterruptAllOutcome,
  latestByAskedAt,
  latestByUpdatedAt,
  orderAgentChatEntries,
} from './WorkspacePages';

const timestamp = '2026-08-28T12:00:00.000Z';
const project: BoardProject = {
  id: 'project-one',
  name: 'Project one',
  description: 'Project context.',
  repoPath: '/repos/project-one',
  createdAt: timestamp,
  createdAtMs: Date.parse(timestamp),
  updatedAt: timestamp,
  updatedAtMs: Date.parse(timestamp),
};
const agent: BoardAgent = {
  id: 'agent-one',
  projectId: project.id,
  name: 'Agent one',
  role: 'engineer',
  area: 'Project one',
  mission: 'Implement the project.',
  model: 'auto',
  status: 'sleeping',
  workerConnection: null,
  lastError: null,
  currentTaskId: null,
  lastEventAt: null,
  lastEventAtMs: null,
  version: 1,
  createdAt: timestamp,
  createdAtMs: Date.parse(timestamp),
  updatedAt: timestamp,
  updatedAtMs: Date.parse(timestamp),
};
const snapshot: BoardSnapshot = {
  revision: 1,
  generatedAt: timestamp,
  generatedAtMs: Date.parse(timestamp),
  workItems: [],
  projects: [project],
  agents: [agent],
  tasks: [],
  messages: [],
  questions: [],
  runs: [],
};

beforeEach(() => {
  vi.mocked(Modal).mockClear();
});

describe('workspace confirmation surfaces', () => {
  it('reads workspace metadata from repoPath rather than the descriptive text', () => {
    const markup = renderToStaticMarkup(createElement(ProjectPage, {
      project,
      snapshot,
      onTask: vi.fn(),
      onAddTask: vi.fn(),
      client: { getProjectArtifacts: vi.fn() } as unknown as TaskBoardClient,
      connected: true,
    }));

    expect(markup).toContain('/repos/project-one');
    expect(markup).not.toContain('Project context.');
  });

  it('renders the interrupt and token-rotation confirms as anchored variants', () => {
    renderToStaticMarkup(createElement(ProjectPage, {
      project,
      snapshot,
      onTask: vi.fn(),
      onAddTask: vi.fn(),
      client: { getProjectArtifacts: vi.fn() } as unknown as TaskBoardClient,
      connected: true,
    }));
    renderToStaticMarkup(createElement(AgentPage, {
      agent,
      snapshot,
      isPointOfContact: false,
      explicitPointOfContact: false,
      busy: false,
      rotationErrors: [],
      onDismissActionError: vi.fn(),
      onTask: vi.fn(),
      onSend: vi.fn(),
      onAnswer: vi.fn(),
      onRotateToken: vi.fn(),
    }));

    const modalProps = vi.mocked(Modal).mock.calls.map(([props]) => props);
    expect(modalProps.find(({ title }) => String(title).startsWith('Interrupt '))).toMatchObject({
      variant: 'anchored',
      anchorRef: { current: null },
    });
    expect(modalProps.find(({ title }) => title === 'Rotate agent token?')).toMatchObject({
      variant: 'anchored',
      anchorRef: { current: null },
    });
  });
});

describe('agentPageUsesPointOfContactMode', () => {
  it('enables POC chat framing only for the selected explicit POC', () => {
    expect(agentPageUsesPointOfContactMode(true, true)).toBe(true);
    expect(agentPageUsesPointOfContactMode(true, false)).toBe(false);
    expect(agentPageUsesPointOfContactMode(false, true)).toBe(false);
  });
});

describe('deriveInterruptAllOutcome', () => {
  it('counts live interrupts, already-finished runs, and failures separately', () => {
    const error = new Error('network unavailable');
    expect(deriveInterruptAllOutcome(
      ['run-live', 'run-finished', 'run-failed'],
      [
        { status: 'fulfilled', value: { runId: 'run-live' } },
        { status: 'fulfilled', value: { runId: null } },
        { status: 'rejected', reason: error },
      ],
    )).toEqual({
      handledRunIds: ['run-live', 'run-finished'],
      interruptedCount: 1,
      alreadyFinishedCount: 1,
      failedCount: 1,
    });
  });
});

describe('workspace timestamp ordering', () => {
  it('orders activity and chat by absolute instants', () => {
    const earlierOffset = '2026-07-19T12:00:00+02:00';
    const laterFraction = '2026-07-19T10:00:00.500Z';

    expect(activityUpdates([
      { id: 'earlier', projectId: 'project-one', taskId: 'task-one', taskTitle: 'Task', author: 'Agent', body: 'Earlier', kind: 'progress', createdAt: earlierOffset, createdAtMs: Date.parse(earlierOffset) },
      { id: 'later', projectId: 'project-one', taskId: 'task-one', taskTitle: 'Task', author: 'Agent', body: 'Later', kind: 'progress', createdAt: laterFraction, createdAtMs: Date.parse(laterFraction) },
    ], []).map((update) => update.id)).toEqual(['later', 'earlier']);

    expect(orderAgentChatEntries([
      { id: 'earlier', author: 'Agent', body: 'Earlier', createdAt: earlierOffset, createdAtMs: Date.parse(earlierOffset), sender: 'agent', contextRole: null, order: 0 },
      { id: 'later', author: 'Agent', body: 'Later', createdAt: laterFraction, createdAtMs: Date.parse(laterFraction), sender: 'agent', contextRole: null, order: 0 },
    ]).map((entry) => entry.id)).toEqual(['earlier', 'later']);

    expect(latestByUpdatedAt([
      { id: 'earlier', updatedAt: earlierOffset, updatedAtMs: Date.parse(earlierOffset) },
      { id: 'later', updatedAt: laterFraction, updatedAtMs: Date.parse(laterFraction) },
    ])?.id).toBe('later');
    expect(latestByAskedAt([
      { id: 'earlier', askedAt: earlierOffset, askedAtMs: Date.parse(earlierOffset) },
      { id: 'later', askedAt: laterFraction, askedAtMs: Date.parse(laterFraction) },
    ])?.id).toBe('later');
  });

  it('selects the same latest entity for equivalent instants in either input order', () => {
    const utc = '2026-07-19T10:00:00Z';
    const offset = '2026-07-19T12:00:00+02:00';
    const items = [
      { id: 'item-alpha', updatedAt: utc, updatedAtMs: Date.parse(utc) },
      { id: 'item-omega', updatedAt: offset, updatedAtMs: Date.parse(offset) },
    ];

    expect(latestByUpdatedAt(items)?.id).toBe('item-omega');
    expect(latestByUpdatedAt([...items].reverse())?.id).toBe('item-omega');
  });
});
