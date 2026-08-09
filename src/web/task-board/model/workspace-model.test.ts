import { describe, expect, it } from 'vitest';
import {
  assignmentAgentOptionLabel,
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
import type { BoardAgent, BoardProject, BoardSnapshot, BoardTask, BoardTaskPhase } from '../types';

function epoch(value: string | null): number | null {
  return value === null ? null : Date.parse(value);
}

type PhaseInput = Omit<BoardTaskPhase, 'startedAtMs' | 'endedAtMs' | 'createdAtMs' | 'updatedAtMs'>
  & Partial<Pick<BoardTaskPhase, 'startedAtMs' | 'endedAtMs' | 'createdAtMs' | 'updatedAtMs'>>;

function phaseWithMilliseconds(phase: PhaseInput): BoardTaskPhase {
  return {
    ...phase,
    startedAtMs: phase.startedAtMs ?? epoch(phase.startedAt),
    endedAtMs: phase.endedAtMs ?? epoch(phase.endedAt),
    createdAtMs: phase.createdAtMs ?? Date.parse(phase.createdAt),
    updatedAtMs: phase.updatedAtMs ?? Date.parse(phase.updatedAt),
  };
}

type TaskOverrides = Partial<Omit<BoardTask, 'phases'>> & { phases?: PhaseInput[] };

const project: BoardProject = {
  id: 'project-one',
  name: 'Platform',
  description: 'Keep customer workflows dependable.',
  createdAt: '2026-07-19T10:00:00.000Z',
  createdAtMs: Date.parse('2026-07-19T10:00:00.000Z'),
  updatedAt: '2026-07-19T10:10:00.000Z',
  updatedAtMs: Date.parse('2026-07-19T10:10:00.000Z'),
};

const agent = (overrides: Partial<BoardAgent>): BoardAgent => {
  const createdAt = overrides.createdAt ?? '2026-07-19T10:00:00.000Z';
  const updatedAt = overrides.updatedAt ?? '2026-07-19T10:00:00.000Z';
  const lastEventAt = overrides.lastEventAt ?? null;
  return {
    id: 'engineer',
    projectId: project.id,
    name: 'Engineer',
    role: 'engineer',
    area: 'Platform',
    mission: 'Improve the platform.',
    model: null,
    status: 'sleeping',
    workerConnection: null,
    lastError: null,
    currentTaskId: null,
    version: 1,
    ...overrides,
    lastEventAt,
    lastEventAtMs: overrides.lastEventAtMs ?? epoch(lastEventAt),
    createdAt,
    createdAtMs: overrides.createdAtMs ?? Date.parse(createdAt),
    updatedAt,
    updatedAtMs: overrides.updatedAtMs ?? Date.parse(updatedAt),
  };
};

const task = (overrides: TaskOverrides = {}): BoardTask => {
  const estimateRecordedAt = overrides.estimateRecordedAt === undefined ? '2026-07-19T10:00:00.000Z' : overrides.estimateRecordedAt;
  const expectedCompletedAt = overrides.expectedCompletedAt === undefined ? '2026-07-19T10:15:00.000Z' : overrides.expectedCompletedAt;
  const startedAt = overrides.startedAt === undefined ? '2026-07-19T10:00:00.000Z' : overrides.startedAt;
  const endedAt = overrides.endedAt === undefined ? '2026-07-19T10:12:00.000Z' : overrides.endedAt;
  const createdAt = overrides.createdAt ?? '2026-07-19T10:00:00.000Z';
  const updatedAt = overrides.updatedAt ?? '2026-07-19T10:12:00.000Z';
  return {
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
    orderKey: 0,
    result: 'Customers can finish setup with fewer steps.',
    version: 2,
    ...overrides,
    estimateRecordedAt,
    estimateRecordedAtMs: overrides.estimateRecordedAtMs ?? epoch(estimateRecordedAt),
    expectedCompletedAt,
    expectedCompletedAtMs: overrides.expectedCompletedAtMs ?? epoch(expectedCompletedAt),
    phases: (overrides.phases ?? []).map(phaseWithMilliseconds),
    startedAt,
    startedAtMs: overrides.startedAtMs ?? epoch(startedAt),
    endedAt,
    endedAtMs: overrides.endedAtMs ?? epoch(endedAt),
    createdAt,
    createdAtMs: overrides.createdAtMs ?? Date.parse(createdAt),
    updatedAt,
    updatedAtMs: overrides.updatedAtMs ?? Date.parse(updatedAt),
  };
};

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

  it('includes worker connection state in assignment option labels', () => {
    expect(assignmentAgentOptionLabel(agent({ workerConnection: 'waiting_for_wake' })))
      .toBe('Engineer — Platform — Worker ready');
    expect(assignmentAgentOptionLabel(agent({ workerConnection: 'watching_run' })))
      .toBe('Engineer — Platform — Worker connected');
    expect(assignmentAgentOptionLabel(agent({ workerConnection: null })))
      .toBe('Engineer — Platform — Worker not detected');
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

  it('uses the same explicit POC signals for selection and framing', () => {
    const plainEngineer = agent({ id: 'first', name: 'First' });
    const idSignaledPoc = agent({ id: 'billing-poc', name: 'Billing liaison' });
    const missionSignaledPoc = agent({
      id: 'customer-liaison',
      name: 'Customer liaison',
      mission: 'Act as the company point of contact.',
    });

    expect(isExplicitPointOfContact(idSignaledPoc)).toBe(true);
    expect(isExplicitPointOfContact(missionSignaledPoc)).toBe(true);
    expect(isExplicitPointOfContact(plainEngineer)).toBe(false);
    expect(selectPointOfContact([plainEngineer, idSignaledPoc])?.id).toBe('billing-poc');
    expect(selectPointOfContact([plainEngineer, missionSignaledPoc])?.id).toBe('customer-liaison');
    expect(selectPointOfContact([plainEngineer])?.id).toBe('first');
  });

  it('uses absolute instants for phase, point-of-contact, resource, and update ordering', () => {
    const earlierOffset = '2026-07-19T12:00:00+02:00';
    const laterFraction = '2026-07-19T10:00:00.500Z';
    const focusedAgent = agent({ status: 'running', currentTaskId: 'task-one' });
    const earlierPhase = {
      id: 'phase-earlier-offset',
      title: 'Earlier phase',
      stage: 'planning' as const,
      status: 'in_progress' as const,
      parallelGroup: null,
      orderKey: 1,
      startedAt: earlierOffset,
      endedAt: null,
      version: 1,
      createdAt: earlierOffset,
      updatedAt: earlierOffset,
    };
    const laterPhase = {
      ...earlierPhase,
      id: 'phase-later-fraction',
      title: 'Later phase',
      stage: 'execution' as const,
      startedAt: laterFraction,
      createdAt: laterFraction,
      updatedAt: laterFraction,
    };

    expect(agentPipelineFocus(focusedAgent, [task({ status: 'running', endedAt: null, phases: [earlierPhase, laterPhase] })]).phase?.id)
      .toBe('phase-later-fraction');
    expect(selectPointOfContact([
      agent({ id: 'later-agent', name: 'Later agent', createdAt: laterFraction }),
      agent({ id: 'earlier-agent', name: 'Earlier agent', createdAt: earlierOffset }),
    ])?.id).toBe('earlier-agent');

    const orderedResources = resourcesForProject(
      { ...project, description: null, updatedAt: '2026-07-19T09:00:00Z' },
      [
        task({ id: 'earlier-task', title: 'Earlier task', workspaceRefs: ['https://example.com/shared'], updatedAt: earlierOffset, endedAt: earlierOffset }),
        task({ id: 'later-task', title: 'Later task', workspaceRefs: ['https://example.com/shared'], updatedAt: laterFraction, endedAt: laterFraction }),
      ],
    );
    expect(orderedResources.map((resource) => resource.id)).toEqual([
      'project-one:ref:https://example.com/shared',
      'project-one:result:later-task',
      'project-one:result:earlier-task',
    ]);
    expect(orderedResources[0]?.description).toBe('Linked from Later task');

    const orderedUpdates = recentUpdatesForProject({
      revision: 1,
      generatedAt: laterFraction,
      generatedAtMs: Date.parse(laterFraction),
      workItems: [],
      projects: [project],
      agents: [agent({})],
      tasks: [task()],
      messages: [
        { id: 'earlier-message', projectId: project.id, taskId: 'task-one', authorType: 'agent', authorId: 'engineer', kind: 'progress', body: 'Earlier', createdAt: earlierOffset, createdAtMs: Date.parse(earlierOffset) },
        { id: 'later-message', projectId: project.id, taskId: 'task-one', authorType: 'agent', authorId: 'engineer', kind: 'progress', body: 'Later', createdAt: laterFraction, createdAtMs: Date.parse(laterFraction) },
      ],
      questions: [],
      runs: [],
      documents: [],
    }, project.id);
    expect(orderedUpdates.map((update) => update.id)).toEqual(['later-message', 'earlier-message']);
  });

  it('orders same-instant project updates independently of response order', () => {
    const utc = '2026-07-19T10:00:00Z';
    const offset = '2026-07-19T12:00:00+02:00';
    const messages = [
      { id: 'update-alpha', projectId: project.id, taskId: 'task-one', authorType: 'agent' as const, authorId: 'engineer', kind: 'progress' as const, body: 'Alpha', createdAt: utc, createdAtMs: Date.parse(utc) },
      { id: 'update-omega', projectId: project.id, taskId: 'task-one', authorType: 'agent' as const, authorId: 'engineer', kind: 'progress' as const, body: 'Omega', createdAt: offset, createdAtMs: Date.parse(offset) },
    ];
    const orderedIds = (input: typeof messages) => recentUpdatesForProject({
      revision: 1,
      generatedAt: offset,
      generatedAtMs: Date.parse(offset),
      workItems: [],
      projects: [project],
      agents: [agent({})],
      tasks: [task()],
      messages: input,
      questions: [],
      runs: [],
      documents: [],
    }, project.id).map((update) => update.id);

    expect(orderedIds(messages)).toEqual(['update-alpha', 'update-omega']);
    expect(orderedIds([...messages].reverse())).toEqual(['update-alpha', 'update-omega']);
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
      generatedAtMs: Date.parse('2026-07-19T10:15:00.000Z'),
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
        createdAtMs: Date.parse('2026-07-19T10:13:00.000Z'),
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
