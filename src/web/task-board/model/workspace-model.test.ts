import { describe, expect, it } from 'vitest';
import {
  agentPipelineFocus,
  agentWorkLabel,
  isExplicitPointOfContact,
  recentUpdatesForProject,
  resourcesForProject,
  selectPointOfContact,
  taskNeedsHumanAction,
  workerAssignmentHint,
  workerConnectionLabel,
} from './workspace-model';
import type { BoardAgent, BoardProject, BoardSnapshot, BoardTask } from '../types';

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
  workerConnection: null,
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
  requiresReview: true,
  title: 'Improve setup',
  objective: 'Make setup easier.',
  acceptanceCriteria: 'Setup succeeds.',
  workspaceRefs: ['https://example.com/runbook', '/workspace/platform'],
  assignedAgentId: 'engineer',
  assignedRole: 'engineer',
  status: 'completed',
  expectedAgentMinutes: 15,
  estimateRecordedAt: '2026-07-19T10:00:00.000Z',
  expectedCompletedAt: '2026-07-19T10:15:00.000Z',
  orderKey: 0,
  phases: [],
  startedAt: '2026-07-19T10:00:00.000Z',
  endedAt: '2026-07-19T10:12:00.000Z',
  result: 'Customers can finish setup with fewer steps.',
  version: 2,
  createdAt: '2026-07-19T10:00:00.000Z',
  updatedAt: '2026-07-19T10:12:00.000Z',
  ...overrides,
});

describe('workspace view model', () => {
  it('keeps durable work labels separate from ephemeral worker readiness', () => {
    expect(agentWorkLabel('sleeping')).toBe('No task');
    expect(agentWorkLabel('running')).toBe('Working');
    expect(workerConnectionLabel('waiting_for_wake')).toBe('Worker ready');
    expect(workerConnectionLabel('watching_run')).toBe('Worker connected');
    expect(workerConnectionLabel(null)).toBe('Worker not detected');
    expect(workerAssignmentHint(null)).toContain('stays queued');
    expect(workerAssignmentHint(null)).not.toContain('offline');
  });

  it('derives implementation, review, and repeated-phase loops for an agent focus', () => {
    const focusedAgent = agent({ status: 'running', currentTaskId: 'task-one' });
    const focusedTask = task({
      status: 'running',
      endedAt: null,
      phases: [
        {
          id: 'execution-one',
          title: 'Implement recovery',
          stage: 'execution',
          status: 'completed',
          parallelGroup: null,
          orderKey: 1,
          startedAt: '2026-07-19T10:00:00.000Z',
          endedAt: '2026-07-19T10:04:00.000Z',
          version: 2,
          createdAt: '2026-07-19T10:00:00.000Z',
          updatedAt: '2026-07-19T10:04:00.000Z',
        },
        {
          id: 'review-one',
          title: 'Review recovery',
          stage: 'review',
          status: 'completed',
          parallelGroup: null,
          orderKey: 2,
          startedAt: '2026-07-19T10:04:00.000Z',
          endedAt: '2026-07-19T10:06:00.000Z',
          version: 2,
          createdAt: '2026-07-19T10:04:00.000Z',
          updatedAt: '2026-07-19T10:06:00.000Z',
        },
        {
          id: 'execution-two',
          title: 'Apply review feedback',
          stage: 'execution',
          status: 'in_progress',
          parallelGroup: null,
          orderKey: 3,
          startedAt: '2026-07-19T10:06:00.000Z',
          endedAt: null,
          version: 1,
          createdAt: '2026-07-19T10:06:00.000Z',
          updatedAt: '2026-07-19T10:06:00.000Z',
        },
      ],
    });

    expect(agentPipelineFocus(focusedAgent, [focusedTask])).toMatchObject({
      task: { id: 'task-one' },
      phase: { id: 'execution-two' },
      stage: 'Implementing',
      loop: 2,
    });
    expect(agentPipelineFocus(agent({ role: 'manager', currentTaskId: 'task-one' }), [focusedTask])).toMatchObject({ stage: 'Reviewing' });
    expect(agentPipelineFocus(agent({ status: 'running', currentTaskId: 'review-task' }), [focusedTask, task({
      id: 'review-task',
      kind: 'manager_review',
      status: 'running',
      orderKey: -1,
      phases: [],
    })])).toMatchObject({ stage: 'Reviewing' });
    expect(agentPipelineFocus(focusedAgent, [task({
      status: 'running',
      endedAt: null,
      phases: [{ ...focusedTask.phases[1]!, status: 'in_progress' }],
    })])).toMatchObject({ stage: 'Implementing', phase: { stage: 'review' } });
    expect(agentPipelineFocus(agent({ currentTaskId: null }), [task({ assignedAgentId: null, status: 'backlog' })])).toEqual({ task: null, phase: null, stage: null, loop: null });

    const parallelTask = task({
      status: 'running',
      endedAt: null,
      phases: [
        { ...focusedTask.phases[0]!, id: 'parallel-one', title: 'Implement client', status: 'in_progress', parallelGroup: 'implementation', orderKey: 2 },
        { ...focusedTask.phases[0]!, id: 'parallel-two', title: 'Plan service handoff', stage: 'planning', status: 'in_progress', parallelGroup: 'implementation', orderKey: 3 },
      ],
    });
    expect(agentPipelineFocus(focusedAgent, [parallelTask])).toMatchObject({ phase: { id: 'parallel-two' }, loop: null });

    const sequentialSameStage = task({
      status: 'running',
      endedAt: null,
      phases: [
        { ...focusedTask.phases[0]!, id: 'execution-a', status: 'completed', orderKey: 1 },
        { ...focusedTask.phases[0]!, id: 'execution-b', status: 'in_progress', orderKey: 2 },
      ],
    });
    expect(agentPipelineFocus(focusedAgent, [sequentialSameStage])).toMatchObject({ phase: { id: 'execution-b' }, loop: null });

    const reusedParallelGroup = task({
      status: 'running',
      endedAt: null,
      phases: [
        { ...focusedTask.phases[0]!, id: 'group-build', status: 'completed', parallelGroup: 'g', orderKey: 1 },
        { ...focusedTask.phases[0]!, id: 'separate-test', stage: 'testing', status: 'completed', parallelGroup: null, orderKey: 2 },
        { ...focusedTask.phases[0]!, id: 'group-review', stage: 'review', status: 'in_progress', parallelGroup: 'g', orderKey: 3 },
      ],
    });
    expect(agentPipelineFocus(focusedAgent, [reusedParallelGroup])).toMatchObject({ phase: { id: 'group-review' }, loop: null });

    const structuredCycle = task({
      status: 'running',
      endedAt: null,
      phases: [
        { ...focusedTask.phases[0]!, id: 'marker-research', stage: 'research', status: 'completed', orderKey: 1 },
        { ...focusedTask.phases[0]!, id: 'marker-plan', stage: 'planning', status: 'completed', orderKey: 2 },
        { ...focusedTask.phases[0]!, id: 'marker-build', stage: 'execution', status: 'completed', orderKey: 3 },
        { ...focusedTask.phases[0]!, id: 'marker-test', stage: 'testing', status: 'in_progress', orderKey: 4 },
      ],
    });
    expect(agentPipelineFocus(focusedAgent, [structuredCycle])).toMatchObject({
      phase: { id: 'marker-test' },
      loop: null,
    });

    const secondStructuredCycle = task({
      status: 'running',
      endedAt: null,
      phases: [
        ...structuredCycle.phases.map((item) => ({ ...item, status: 'completed' as const })),
        { ...focusedTask.phases[0]!, id: 'marker-replan', stage: 'planning', status: 'in_progress', orderKey: 5 },
      ],
    });
    expect(agentPipelineFocus(focusedAgent, [secondStructuredCycle])).toMatchObject({
      phase: { id: 'marker-replan' },
      loop: 2,
    });
  });

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
      workItems: [],
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
      documents: [],
    };
    expect(recentUpdatesForProject(snapshot, project.id)).toEqual([
      expect.objectContaining({ id: 'message-one', author: 'Engineer', body: 'Setup is now shorter for customers.' }),
    ]);
  });
});
