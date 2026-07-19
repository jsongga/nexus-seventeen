import { describe, expect, it } from 'vitest';
import { isExplicitPointOfContact, recentUpdatesForProject, resourcesForProject, selectPointOfContact, taskNeedsHumanAction } from './workspace-model';
import type { BoardAgent, BoardProject, BoardSnapshot, BoardTask } from './types';

const project: BoardProject = {
  id: 'project-one',
  name: 'Platform',
  description: 'Keep customer workflows dependable.',
  createdAt: '2026-07-19T10:00:00.000Z',
  updatedAt: '2026-07-19T10:10:00.000Z',
};

const agent = (overrides: Partial<BoardAgent>): BoardAgent => ({
  id: 'engineer',
  projectId: project.id,
  name: 'Engineer',
  role: 'engineer',
  area: 'Platform',
  mission: 'Improve the platform.',
  model: null,
  status: 'sleeping',
  currentTaskId: null,
  lastEventAt: null,
  createdAt: '2026-07-19T10:00:00.000Z',
  updatedAt: '2026-07-19T10:00:00.000Z',
  ...overrides,
});

const task = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  id: 'task-one',
  projectId: project.id,
  parentTaskId: null,
  kind: 'work',
  requiredRole: null,
  title: 'Improve setup',
  objective: 'Make setup easier.',
  acceptanceCriteria: 'Setup succeeds.',
  workspaceRefs: ['https://example.com/runbook', '/workspace/platform'],
  assignedAgentId: 'engineer',
  assignedRole: 'engineer',
  status: 'completed',
  expectedAgentMinutes: 15,
  expectedCompletedAt: '2026-07-19T10:15:00.000Z',
  startedAt: '2026-07-19T10:00:00.000Z',
  endedAt: '2026-07-19T10:12:00.000Z',
  result: 'Customers can finish setup with fewer steps.',
  version: 2,
  createdAt: '2026-07-19T10:00:00.000Z',
  updatedAt: '2026-07-19T10:12:00.000Z',
  ...overrides,
});

describe('workspace view model', () => {
  it('selects exactly one explicit POC before engineer or oldest-agent fallbacks', () => {
    const agents = [
      agent({ id: 'first', name: 'First' }),
      agent({ id: 'manager', name: 'Manager', role: 'manager' }),
      agent({ id: 'steward-poc', name: 'Steward', mission: 'Act as the company point of contact.' }),
    ];
    expect(selectPointOfContact(agents)?.id).toBe('steward-poc');
    expect(isExplicitPointOfContact(agents[2]!)).toBe(true);
    expect(isExplicitPointOfContact(agents[0]!)).toBe(false);
    expect(selectPointOfContact(agents.filter((item) => item.id !== 'steward-poc'))?.id).toBe('first');
  });

  it('surfaces unassigned manager review and human release work as human attention', () => {
    expect(taskNeedsHumanAction(task({ kind: 'manager_review', requiredRole: 'manager', assignedAgentId: null, assignedRole: null, status: 'backlog', endedAt: null }))).toBe(true);
    expect(taskNeedsHumanAction(task({ kind: 'human_check', assignedAgentId: null, assignedRole: null, status: 'backlog', endedAt: null }))).toBe(true);
    expect(taskNeedsHumanAction(task({ kind: 'work', assignedAgentId: null, assignedRole: null, status: 'backlog', endedAt: null }))).toBe(false);
  });

  it('derives honest project documents, links, setup references, and outcomes', () => {
    const resources = resourcesForProject(project, [task()]);
    expect(resources.map((resource) => resource.kind)).toEqual(expect.arrayContaining(['brief', 'link', 'setup', 'outcome']));
    expect(resources.find((resource) => resource.kind === 'link')?.href).toBe('https://example.com/runbook');
    expect(resourcesForProject(project, [task({ kind: 'manager_review', requiredRole: 'manager' })]).some((resource) => resource.kind === 'outcome')).toBe(false);
  });

  it('uses durable messages as recent updates and avoids a duplicate task fallback', () => {
    const snapshot: BoardSnapshot = {
      revision: 1,
      generatedAt: '2026-07-19T10:15:00.000Z',
      projects: [project],
      agents: [agent({})],
      tasks: [task()],
      messages: [{
        id: 'message-one',
        projectId: project.id,
        taskId: 'task-one',
        authorType: 'agent',
        authorId: 'engineer',
        kind: 'result',
        body: 'Setup is now shorter for customers.',
        createdAt: '2026-07-19T10:13:00.000Z',
      }],
      questions: [],
      runs: [],
    };
    expect(recentUpdatesForProject(snapshot, project.id)).toEqual([
      expect.objectContaining({ id: 'message-one', author: 'Engineer', body: 'Setup is now shorter for customers.' }),
    ]);
  });
});
