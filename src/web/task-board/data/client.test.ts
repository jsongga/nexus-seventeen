import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentQueryConversationContextMarker,
  agentQueryRoutingContextMarker,
  createTaskBoardClient,
  DocumentStreamError,
  parseBoardDocument,
  parseBoardSnapshot,
  randomUuid,
} from './client';
import type { AutomationAgentType, AutomationStageConfiguration } from '../types';

class MemoryStorage implements Storage {
  private readonly values: Map<string, string>;

  constructor(values: Iterable<readonly [string, string]> = []) {
    this.values = new Map(values);
  }

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  copy(): MemoryStorage {
    return new MemoryStorage(this.values.entries());
  }
}

class PageLifecycle {
  private readonly pagehideListeners: Array<(event: Event & { persisted: boolean }) => void> = [];

  readonly addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type !== 'pagehide') return;
    const callback = typeof listener === 'function' ? listener : listener.handleEvent.bind(listener);
    this.pagehideListeners.push(callback as (event: Event & { persisted: boolean }) => void);
  });

  pagehide(persisted: boolean): void {
    const event = Object.assign(new Event('pagehide'), { persisted });
    for (const listener of this.pagehideListeners) listener(event);
  }
}

describe('randomUuid', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses secure random bytes when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
        return bytes;
      },
    });

    expect(randomUuid()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });
});

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
const workItem = {
  apiVersion,
  workItemId: 'work-item-one',
  originalRequest: 'Improve invoice recovery for customers.',
  refinedObjective: null,
  priority: 'normal',
  projectTarget: { mode: 'auto' },
  resolvedProjectId: null,
  state: 'submitted',
  currentStage: 'refinement',
  createdBy: 'human:operator',
  version: 1,
  createdAt: '2026-07-19T10:09:00.000Z',
  updatedAt: '2026-07-19T10:09:00.000Z',
  endedAt: null,
};
const automationConfiguration = {
  apiVersion,
  configurationId: 'company-default',
  agentTypes: [
    {
      agentTypeId: 'workflow-manager',
      name: 'Workflow manager',
      description: 'Refines requests and plans durable work.',
      role: 'manager',
      supplementalInstructions: 'Preserve the original request and ground decisions in project evidence.',
      skillIds: ['task-refinement', 'project-research'],
      evaluatorProfile: 'editorial',
      enabled: true,
    },
    {
      agentTypeId: 'implementation-engineer',
      name: 'Implementation engineer',
      description: 'Implements and tests scoped workspace changes.',
      role: 'engineer',
      supplementalInstructions: 'Make the smallest safe change and run focused tests.',
      skillIds: ['code-review'],
      evaluatorProfile: 'tests',
      enabled: true,
    },
    {
      agentTypeId: 'independent-verifier',
      name: 'Independent verifier',
      description: 'Checks implementation evidence independently.',
      role: 'verifier',
      supplementalInstructions: 'Inspect the result and report evidence without modifying files.',
      skillIds: [],
      evaluatorProfile: 'manual',
      enabled: true,
    },
  ],
  stages: [
    { stage: 'refinement', executor: { kind: 'agent_type', agentTypeId: 'workflow-manager' } },
    { stage: 'project_resolution', executor: { kind: 'agent_type', agentTypeId: 'workflow-manager' } },
    { stage: 'research', executor: { kind: 'agent_type', agentTypeId: 'implementation-engineer' } },
    { stage: 'planning', executor: { kind: 'agent_type', agentTypeId: 'implementation-engineer' } },
    { stage: 'implementation', executor: { kind: 'agent_type', agentTypeId: 'implementation-engineer' } },
    { stage: 'testing', executor: { kind: 'agent_type', agentTypeId: 'implementation-engineer' } },
    { stage: 'verification', executor: { kind: 'agent_type', agentTypeId: 'independent-verifier' } },
    { stage: 'human_review', executor: { kind: 'human' } },
    { stage: 'deployment', executor: { kind: 'disabled' } },
  ],
  version: 4,
  createdAt: '2026-07-19T10:00:00.000Z',
  updatedAt: '2026-07-19T10:15:00.000Z',
  updatedBy: 'human:operator',
};

function paginatedWorkItem(index: number, overrides: Record<string, unknown> = {}) {
  const timestamp = new Date(Date.parse('2026-07-19T10:09:00.000Z') + index * 1_000).toISOString();
  return {
    ...workItem,
    workItemId: `work-item-page-${index.toString().padStart(5, '0')}`,
    originalRequest: `Paginated request ${index}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}
const agent = {
  apiVersion,
  agentId: 'billing-engineer',
  projectId: 'project-one',
  role: 'engineer',
  area: 'Billing',
  mission: 'Keep customer billing dependable.',
  model: 'economy-coding-model',
  status: 'running',
  workerConnection: 'watching_run',
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
  requiresReview: true,
  title: 'Improve invoice recovery',
  objective: 'Customers can recover a failed invoice without support.',
  acceptanceCriteria: 'The recovery path passes its focused tests.',
  workspaceRefs: ['/workspace/billing'],
  status: 'in_progress',
  assignedAgentId: 'billing-engineer',
  assignedRole: 'engineer',
  expectedAgentMinutes: 30,
  estimateRecordedAt: '2026-07-19T10:15:00.000Z',
  orderKey: 1024,
  phases: [],
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
  requiresReview: false,
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
const documentSummary = {
  apiVersion,
  documentId: 'document-release-notes',
  projectId: project.projectId,
  title: 'Release notes',
  contentType: 'text/markdown',
  contentVersion: 2,
  penEpoch: 1,
  penHolder: null,
  sequence: 4,
  createdAt: '2026-07-19T10:05:00.000Z',
  updatedAt: '2026-07-19T10:14:00.000Z',
};
const documentSnapshot = {
  ...documentSummary,
  content: '# Release notes\n\nInvoice recovery is clearer.',
};
const workflowPlan = {
  apiVersion,
  planRevisionId: 'plan-one',
  workItemId: workItem.workItemId,
  revision: 1,
  objective: 'Make invoice recovery dependable.',
  assumptions: ['The billing provider remains available.'],
  acceptanceCriteria: ['The focused recovery test passes.'],
  projectId: project.projectId,
  skillDigests: { 'cicada-software-implementation': `sha256:${'1'.repeat(64)}` },
  state: 'confirmed',
  createdBy: 'human:operator',
  confirmedBy: 'human:operator',
  createdAt: '2026-07-19T10:20:00.000Z',
  confirmedAt: '2026-07-19T10:21:00.000Z',
};
const workflowNode = {
  apiVersion,
  nodeId: 'node-one',
  planRevisionId: workflowPlan.planRevisionId,
  projectId: project.projectId,
  title: 'Verify invoice recovery',
  objective: 'Prove the recovery path is dependable.',
  acceptanceCriteria: ['The focused recovery test passes.'],
  dependencyNodeIds: [],
  stageTemplate: ['implementation', 'testing', 'verification'],
  currentStage: 'testing',
  state: 'active',
  version: 2,
  createdAt: '2026-07-19T10:21:00.000Z',
  updatedAt: '2026-07-19T10:22:00.000Z',
};
const workflowHandoff = {
  apiVersion,
  handoffId: 'handoff-one',
  nodeId: workflowNode.nodeId,
  taskId: task.taskId,
  stage: 'implementation',
  outcome: 'passed',
  summary: 'Invoice recovery implementation is complete.',
  evidence: ['Focused tests passed.'],
  artifactIds: ['artifact-one'],
  acceptanceCriteria: [{ criterion: 'The focused recovery test passes.', passed: true, evidence: 'Passed.' }],
  blockers: [],
  recommendedReturnStage: null,
  createdAt: '2026-07-19T10:22:00.000Z',
};
const workflowEvent = {
  apiVersion,
  sequence: 1,
  eventId: 'workflow-event-one',
  projectId: project.projectId,
  nodeId: workflowNode.nodeId,
  taskId: task.taskId,
  eventType: 'stage_completed',
  summary: 'Implementation completed; testing is ready.',
  createdAt: '2026-07-19T10:22:00.000Z',
};
const projectArtifact = {
  apiVersion,
  artifactId: 'artifact-one',
  projectId: project.projectId,
  nodeId: workflowNode.nodeId,
  taskId: task.taskId,
  mediaType: 'text/markdown',
  byteSize: 42,
  digest: `sha256:${'a'.repeat(64)}`,
  caption: 'Focused invoice recovery evidence',
  createdBy: 'agent:billing-engineer',
  createdAt: '2026-07-19T10:22:00.000Z',
};

function workflowSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    plans: [workflowPlan],
    nodes: [workflowNode],
    handoffs: [workflowHandoff],
    events: [workflowEvent],
    ...overrides,
  };
}

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
    documents: [documentSummary],
  };
}

describe('task-board protocol projection', () => {
  it('maps the durable service contract into user-facing task and run state', () => {
    const snapshot = parseBoardSnapshot(boardSnapshot());
    expect(snapshot.projects[0]).toMatchObject({ id: 'project-one' });
    expect(snapshot.agents[0]).toMatchObject({
      id: 'billing-engineer',
      status: 'running',
      workerConnection: 'watching_run',
      currentTaskId: 'task-one',
    });
    expect(snapshot.tasks[0]).toMatchObject({ id: 'task-one', status: 'waiting_for_human', expectedAgentMinutes: 30 });
    expect(snapshot.questions[0]).toMatchObject({ id: 'question-one', version: 1 });
    expect(snapshot.runs[0]).toMatchObject({ id: 'run-one', taskId: 'task-one', wakeReason: 'human_assignment' });
    expect(snapshot.documents[0]).toMatchObject({ id: 'document-release-notes', contentVersion: 2, penEpoch: 1, sequence: 4 });
    expect(snapshot.revision).toBe(7);
  });

  it('drops stale completion forecasts from terminal task projections', () => {
    const terminalStatuses = [
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'interrupted'],
    ] as const;

    for (const [rawStatus, projectedStatus] of terminalStatuses) {
      const snapshot = parseBoardSnapshot({
        ...boardSnapshot(),
        tasks: [{
          ...task,
          status: rawStatus,
          expectedCompletedAt: '2026-07-20T10:45:00.000Z',
          endedAt: '2026-07-19T10:30:00.000Z',
          result: 'The task is closed.',
        }],
        openQuestions: [],
        recentQuestions: [],
      });

      expect(snapshot.tasks[0]).toMatchObject({
        status: projectedStatus,
        expectedAgentMinutes: 30,
        expectedCompletedAt: null,
      });
    }
  });

  it('retains older open questions outside the recent history without duplicating overlap', () => {
    const olderOpenQuestion = {
      ...question,
      questionId: 'question-older-open',
      question: 'Which customer group should this prioritize?',
      askedAt: '2026-07-18T10:20:00.000Z',
    };
    const answeredQuestion = {
      ...question,
      questionId: 'question-recent-answered',
      question: 'Should we preserve the prior invoice reference?',
      status: 'answered',
      answer: 'Yes.',
      answeredAt: '2026-07-19T10:25:00.000Z',
      answeredBy: 'human:operator',
      version: 2,
    };

    const snapshot = parseBoardSnapshot({
      ...boardSnapshot(),
      openQuestions: [question, olderOpenQuestion],
      recentQuestions: [question, answeredQuestion],
    });

    expect(snapshot.questions.map((item) => item.id)).toEqual([
      question.questionId,
      answeredQuestion.questionId,
      olderOpenQuestion.questionId,
    ]);
    expect(snapshot.questions.filter((item) => item.id === question.questionId)).toHaveLength(1);
    expect(snapshot.questions.find((item) => item.id === olderOpenQuestion.questionId)).toMatchObject({ status: 'open' });
    expect(snapshot.tasks[0]?.status).toBe('waiting_for_human');
  });

  it('parses full document snapshots and rejects malformed fencing state', () => {
    expect(parseBoardDocument(documentSnapshot)).toMatchObject({
      id: documentSummary.documentId,
      content: documentSnapshot.content,
      contentType: 'text/markdown',
    });
    expect(() => parseBoardDocument({ ...documentSnapshot, contentType: 'text/html' })).toThrow(/contentType/u);
    expect(() => parseBoardDocument({ ...documentSnapshot, contentVersion: 0 })).toThrow(/contentVersion/u);
    expect(() => parseBoardDocument({
      ...documentSnapshot,
      penEpoch: 0,
      penHolder: {
        actorType: 'agent',
        actorId: agent.agentId,
        clientId: 'agent-client-one',
        acquiredAt: '2026-07-19T10:15:00.000Z',
      },
    })).toThrow(/penEpoch/u);
  });

  it('rejects invalid versions, model status values, and non-15-minute estimates', () => {
    expect(() => parseBoardSnapshot({ ...boardSnapshot(), apiVersion: 'old' })).toThrow(/apiVersion/u);
    expect(() => parseBoardSnapshot({
      ...boardSnapshot(),
      agents: [{ ...agent, status: 'online' }],
    })).toThrow(/status/u);
    expect(() => parseBoardSnapshot({
      ...boardSnapshot(),
      agents: [{ ...agent, workerConnection: 'offline' }],
    })).toThrow(/workerConnection/u);
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

  it('treats a missing worker connection as not detected for rolling compatibility', () => {
    const { workerConnection: _workerConnection, ...legacyAgent } = agent;
    const snapshot = parseBoardSnapshot({ ...boardSnapshot(), agents: [legacyAgent] });
    expect(snapshot.agents[0]).toMatchObject({ status: 'running', workerConnection: null });
  });

  it('projects nullable estimates and parallel phase progress with legacy fallbacks', () => {
    const phase = {
      apiVersion,
      phaseId: 'phase-api',
      projectId: project.projectId,
      taskId: task.taskId,
      title: 'Implement API changes',
      stage: 'execution',
      status: 'in_progress',
      parallelGroup: 'implementation',
      orderKey: 0,
      startedAt: '2026-07-19T10:20:00.000Z',
      endedAt: null,
      version: 2,
      createdAt: '2026-07-19T10:16:00.000Z',
      updatedAt: '2026-07-19T10:20:00.000Z',
    };
    const snapshot = parseBoardSnapshot({
      ...boardSnapshot(),
      tasks: [{
        ...task,
        expectedAgentMinutes: null,
        estimateRecordedAt: null,
        expectedCompletedAt: null,
        phases: [phase],
      }],
    });
    expect(snapshot.tasks[0]).toMatchObject({
      expectedAgentMinutes: null,
      orderKey: 1024,
      phases: [expect.objectContaining({ id: 'phase-api', stage: 'execution', parallelGroup: 'implementation' })],
    });

    const { orderKey: _orderKey, phases: _phases, estimateRecordedAt: _recorded, ...legacyTask } = task;
    expect(parseBoardSnapshot({ ...boardSnapshot(), tasks: [legacyTask] }).tasks[0]).toMatchObject({
      orderKey: 0,
      phases: [],
      estimateRecordedAt: null,
    });
  });

  it('accepts completed semantic phases and restricts the legacy done stage to completion', () => {
    const phase = {
      apiVersion,
      phaseId: 'phase-research',
      projectId: project.projectId,
      taskId: task.taskId,
      title: 'Research recovery behavior',
      stage: 'research',
      status: 'completed',
      parallelGroup: null,
      orderKey: 0,
      startedAt: '2026-07-19T10:16:00.000Z',
      endedAt: '2026-07-19T10:20:00.000Z',
      version: 2,
      createdAt: '2026-07-19T10:16:00.000Z',
      updatedAt: '2026-07-19T10:20:00.000Z',
    };

    expect(parseBoardSnapshot({
      ...boardSnapshot(),
      tasks: [{ ...task, phases: [phase] }],
    }).tasks[0]?.phases[0]).toMatchObject({ stage: 'research', status: 'completed' });

    expect(parseBoardSnapshot({
      ...boardSnapshot(),
      tasks: [{ ...task, phases: [{ ...phase, phaseId: 'phase-done', stage: 'done' }] }],
    }).tasks[0]?.phases[0]).toMatchObject({ stage: 'done', status: 'completed' });

    expect(() => parseBoardSnapshot({
      ...boardSnapshot(),
      tasks: [{
        ...task,
        phases: [{ ...phase, phaseId: 'phase-invalid-done', stage: 'done', status: 'in_progress' }],
      }],
    })).toThrow(/legacy done stage only when status is completed/u);
  });
});

describe('task-board HTTP client', () => {
  it('parses valid workflow and artifact payloads into the web projection', async () => {
    const request = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/v1/projects/project-one/workflow')) {
        return new Response(JSON.stringify({ workflow: workflowSnapshot() }));
      }
      if (path.endsWith('/v1/projects/project-one/artifacts')) {
        return new Response(JSON.stringify({ artifacts: [projectArtifact] }));
      }
      return new Response('{}', { status: 404 });
    });
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
    });

    await expect(client.getProjectWorkflow(project.projectId)).resolves.toEqual({
      plans: [{
        planRevisionId: workflowPlan.planRevisionId,
        revision: 1,
        objective: workflowPlan.objective,
        assumptions: workflowPlan.assumptions,
        acceptanceCriteria: workflowPlan.acceptanceCriteria,
        state: 'confirmed',
        createdAt: workflowPlan.createdAt,
        confirmedAt: workflowPlan.confirmedAt,
      }],
      nodes: [{
        nodeId: workflowNode.nodeId,
        planRevisionId: workflowPlan.planRevisionId,
        title: workflowNode.title,
        objective: workflowNode.objective,
        acceptanceCriteria: workflowNode.acceptanceCriteria,
        dependencyNodeIds: [],
        stageTemplate: ['implementation', 'testing', 'verification'],
        currentStage: 'testing',
        state: 'active',
        updatedAt: workflowNode.updatedAt,
      }],
      handoffs: [{
        handoffId: workflowHandoff.handoffId,
        nodeId: workflowNode.nodeId,
        taskId: task.taskId,
        stage: 'implementation',
        outcome: 'passed',
        summary: workflowHandoff.summary,
        evidence: workflowHandoff.evidence,
        artifactIds: workflowHandoff.artifactIds,
        blockers: [],
        createdAt: workflowHandoff.createdAt,
      }],
      events: [{
        sequence: 1,
        eventId: workflowEvent.eventId,
        nodeId: workflowNode.nodeId,
        taskId: task.taskId,
        eventType: workflowEvent.eventType,
        summary: workflowEvent.summary,
        createdAt: workflowEvent.createdAt,
      }],
    });
    await expect(client.getProjectArtifacts(project.projectId)).resolves.toEqual([{
      artifactId: projectArtifact.artifactId,
      nodeId: workflowNode.nodeId,
      taskId: task.taskId,
      mediaType: 'text/markdown',
      byteSize: 42,
      caption: projectArtifact.caption,
      createdAt: projectArtifact.createdAt,
    }]);
  });

  it('rejects an unknown workflow enum member at the response boundary', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      workflow: workflowSnapshot({ nodes: [{ ...workflowNode, state: 'paused' }] }),
    })));
    const client = createTaskBoardClient({ fetch: request as unknown as typeof fetch });

    await expect(client.getProjectWorkflow(project.projectId)).rejects.toThrow(
      'workflow response.workflow.nodes[0].state has an unsupported value',
    );
  });

  it('rejects an artifact with a missing required field at the response boundary', async () => {
    const missingCaption: Record<string, unknown> = { ...projectArtifact };
    delete missingCaption.caption;
    const request = vi.fn(async () => new Response(JSON.stringify({ artifacts: [missingCaption] })));
    const client = createTaskBoardClient({ fetch: request as unknown as typeof fetch });

    await expect(client.getProjectArtifacts(project.projectId)).rejects.toThrow(
      'artifacts response.artifacts[0].caption must be a string',
    );
  });

  it('loads automation configuration on demand and sends one exact versioned replacement', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return new Response(JSON.stringify({
        configuration: init?.method === 'PATCH'
          ? { ...automationConfiguration, version: 5, updatedAt: '2026-07-19T10:20:00.000Z' }
          : automationConfiguration,
      }));
    });
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
    });

    const loaded = await client.getAutomationConfiguration();
    expect(loaded).toMatchObject({
      id: 'company-default',
      version: 4,
      agentTypes: [
        expect.objectContaining({ id: 'workflow-manager', role: 'manager' }),
        expect.objectContaining({ id: 'implementation-engineer', role: 'engineer' }),
        expect.objectContaining({ id: 'independent-verifier', role: 'verifier' }),
      ],
    });

    await expect(client.saveAutomationConfiguration({
      version: loaded.version,
      agentTypes: loaded.agentTypes,
      stages: loaded.stages,
    })).resolves.toMatchObject({ version: 5 });

    expect(calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
      ['https://board.example.test/v1/automation-configuration', 'GET'],
      ['https://board.example.test/v1/automation-configuration', 'PATCH'],
    ]);
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({
      version: 4,
      agentTypes: automationConfiguration.agentTypes,
      stages: automationConfiguration.stages,
    });
  });

  it('strictly rejects unsafe automation configuration responses', async () => {
    async function load(configuration: unknown) {
      const request = vi.fn(async () => new Response(JSON.stringify({ configuration })));
      return createTaskBoardClient({ fetch: request as unknown as typeof fetch }).getAutomationConfiguration();
    }

    const withExtraField = structuredClone(automationConfiguration) as typeof automationConfiguration & { secret?: string };
    withExtraField.secret = 'must-not-cross-the-client-boundary';
    await expect(load(withExtraField)).rejects.toThrow(/secret is not supported/u);

    const duplicateId = structuredClone(automationConfiguration);
    duplicateId.agentTypes[1]!.agentTypeId = duplicateId.agentTypes[0]!.agentTypeId;
    await expect(load(duplicateId)).rejects.toThrow(/duplicate IDs/u);

    const missingStage = structuredClone(automationConfiguration);
    missingStage.stages.pop();
    await expect(load(missingStage)).rejects.toThrow(/every automation stage exactly once/u);

    const disabledReference = structuredClone(automationConfiguration);
    disabledReference.agentTypes[1]!.enabled = false;
    await expect(load(disabledReference)).rejects.toThrow(/references a disabled agent type/u);

    const wrongRoleAssignments = [
      [0, 'implementation-engineer', /refinement requires a manager/u],
      [1, 'independent-verifier', /project_resolution requires a manager/u],
      [2, 'workflow-manager', /research requires an engineer or verifier/u],
      [3, 'workflow-manager', /planning requires an engineer/u],
      [4, 'independent-verifier', /implementation requires an engineer/u],
      [5, 'workflow-manager', /testing requires an engineer or verifier/u],
      [6, 'implementation-engineer', /verification requires a verifier/u],
    ] as const;
    for (const [stageIndex, agentTypeId, message] of wrongRoleAssignments) {
      const wrongRole = structuredClone(automationConfiguration);
      wrongRole.stages[stageIndex]!.executor = { kind: 'agent_type', agentTypeId };
      await expect(load(wrongRole)).rejects.toThrow(message);
    }

    const unlockedHumanReview = structuredClone(automationConfiguration);
    unlockedHumanReview.stages[7]!.executor = { kind: 'disabled' };
    await expect(load(unlockedHumanReview)).rejects.toThrow(/human_review must be owned by a human/u);

    const enabledWithoutInstructions = structuredClone(automationConfiguration);
    enabledWithoutInstructions.agentTypes[0]!.supplementalInstructions = '';
    await expect(load(enabledWithoutInstructions)).rejects.toThrow(/cannot be empty while the agent type is enabled/u);

    const pathAsSkillId = structuredClone(automationConfiguration);
    pathAsSkillId.agentTypes[0]!.skillIds = ['skills/task-refinement'];
    await expect(load(pathAsSkillId)).rejects.toThrow(/not a URL or path/u);

    const tooManyTypes = structuredClone(automationConfiguration);
    tooManyTypes.agentTypes = Array.from({ length: 33 }, (_, index) => ({
      ...tooManyTypes.agentTypes[0]!,
      agentTypeId: `workflow-manager-${index}`,
    }));
    await expect(load(tooManyTypes)).rejects.toThrow(/more than 32 entries/u);

    const tooManySkills = structuredClone(automationConfiguration);
    tooManySkills.agentTypes[0]!.skillIds = Array.from({ length: 33 }, (_, index) => `skill-${index}`);
    await expect(load(tooManySkills)).rejects.toThrow(/more than 32 entries/u);

    const oversizedUtf8Payload = structuredClone(automationConfiguration);
    oversizedUtf8Payload.agentTypes.push(...Array.from({ length: 5 }, (_, index) => ({
      ...oversizedUtf8Payload.agentTypes[1]!,
      agentTypeId: `unicode-engineer-${index}`,
      supplementalInstructions: '🦋'.repeat(3_000),
    })));
    await expect(load(oversizedUtf8Payload)).rejects.toThrow(/cannot exceed 48 KiB of UTF-8 JSON/u);
  });

  it('rejects invalid automation drafts before issuing a PATCH', async () => {
    const request = vi.fn();
    const client = createTaskBoardClient({ fetch: request as unknown as typeof fetch });
    const agentTypes = automationConfiguration.agentTypes.map((agentType) => ({
      ...agentType,
      id: agentType.agentTypeId,
    }));

    await expect(client.saveAutomationConfiguration({
      version: 4,
      agentTypes: agentTypes.map((agentType, index) => index === 0
        ? { ...agentType, supplementalInstructions: '' }
        : agentType) as AutomationAgentType[],
      stages: automationConfiguration.stages as AutomationStageConfiguration[],
    })).rejects.toThrow(/cannot be empty while the agent type is enabled/u);

    const oversizedAgentTypes = [
      ...agentTypes,
      ...Array.from({ length: 5 }, (_, index) => ({
        ...agentTypes[1]!,
        id: `unicode-engineer-${index}`,
        agentTypeId: `unicode-engineer-${index}`,
        supplementalInstructions: '🦋'.repeat(3_000),
      })),
    ] as AutomationAgentType[];
    await expect(client.saveAutomationConfiguration({
      version: 4,
      agentTypes: oversizedAgentTypes,
      stages: automationConfiguration.stages as AutomationStageConfiguration[],
    })).rejects.toThrow(/cannot exceed 48 KiB of UTF-8 JSON/u);
    expect(request).not.toHaveBeenCalled();
  });

  it('creates a durable automatic work item with a caller-stable idempotency key', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return new Response(JSON.stringify({ workItem }));
    });
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
    });

    await expect(client.createWorkItem({
      originalRequest: '  Improve invoice recovery for customers.  ',
      priority: 'normal',
      projectTarget: { mode: 'auto' },
      idempotencyKey: 'work-item:create:one',
    })).resolves.toMatchObject({
      id: workItem.workItemId,
      originalRequest: workItem.originalRequest,
      state: 'submitted',
      currentStage: 'refinement',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('https://board.example.test/v1/work-items');
    expect(calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'idempotency-key': 'work-item:create:one' }),
    });
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
      originalRequest: 'Improve invoice recovery for customers.',
      priority: 'normal',
      projectTarget: { mode: 'auto' },
    });
  });

  it('rejects invalid work item inputs before making a request', async () => {
    const request = vi.fn();
    const client = createTaskBoardClient({ fetch: request as unknown as typeof fetch });

    await expect(client.createWorkItem({
      originalRequest: '   ',
      priority: 'normal',
      projectTarget: { mode: 'auto' },
      idempotencyKey: 'work-item:create:one',
    })).rejects.toThrow(/enter a task/iu);
    await expect(client.createWorkItem({
      originalRequest: 'A valid task',
      priority: 'normal',
      projectTarget: { mode: 'auto' },
      idempotencyKey: 'short',
    })).rejects.toThrow(/idempotency key/iu);
    expect(request).not.toHaveBeenCalled();
  });

  it('loads and validates global work items independently of projects', async () => {
    const load = async (item: unknown) => {
      const request = vi.fn(async (url: string | URL | Request) => {
        const path = String(url);
        if (path.endsWith('/v1/projects')) return new Response(JSON.stringify({ projects: [] }));
        if (path.endsWith('/v1/work-items')) return new Response(JSON.stringify({ workItems: [item] }));
        return new Response('{}');
      });
      return createTaskBoardClient({
        baseUrl: 'https://board.example.test',
        fetch: request as unknown as typeof fetch,
      }).getSnapshot();
    };

    await expect(load(workItem)).resolves.toMatchObject({
      workItems: [expect.objectContaining({
        id: workItem.workItemId,
        priority: 'normal',
        projectTarget: { mode: 'auto' },
        state: 'submitted',
      })],
    });
    await expect(load({
      ...workItem,
      workItemId: 'work-item-explicit',
      projectTarget: { mode: 'explicit', projectId: project.projectId },
      resolvedProjectId: project.projectId,
      state: 'processing',
      currentStage: 'human_review',
    })).resolves.toMatchObject({
      workItems: [expect.objectContaining({ currentStage: 'human_review' })],
    });
    await expect(load({ ...workItem, projectTarget: { mode: 'auto', unexpected: true } })).rejects.toThrow(/unsupported fields/iu);
    await expect(load({ ...workItem, state: 'completed', endedAt: null })).rejects.toThrow(/endedAt/iu);
    await expect(load({
      ...workItem,
      projectTarget: { mode: 'explicit', projectId: project.projectId },
      resolvedProjectId: 'another-project',
    })).rejects.toThrow(/explicit project target/iu);
  });

  it('keeps the legacy work-item collection to one unchanged request', async () => {
    const calls: string[] = [];
    const request = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      calls.push(path);
      if (path.endsWith('/v1/projects')) return new Response(JSON.stringify({ projects: [] }));
      if (path.endsWith('/v1/work-items')) return new Response(JSON.stringify({ workItems: [workItem] }));
      return new Response('{}');
    });
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
    });

    await expect(client.getSnapshot()).resolves.toMatchObject({
      workItems: [expect.objectContaining({ id: workItem.workItemId })],
    });
    expect(calls.filter((path) => path.includes('/v1/work-items'))).toEqual([
      'https://board.example.test/v1/work-items',
    ]);
  });

  it('loads a 200-plus-one work-item collection with an encoded continuation', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => paginatedWorkItem(index));
    const cursor = 'cursor/with spaces?and=delimiters';
    const workItemCalls: string[] = [];
    const request = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/v1/projects')) return new Response(JSON.stringify({ projects: [] }));
      if (path.includes('/v1/work-items')) {
        workItemCalls.push(path);
        if (path.endsWith('/v1/work-items')) {
          return new Response(JSON.stringify({ workItems: firstPage, nextCursor: cursor }));
        }
        return new Response(JSON.stringify({ workItems: [paginatedWorkItem(200)] }));
      }
      return new Response('{}');
    });
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
    });

    const snapshot = await client.getSnapshot();

    expect(snapshot.workItems).toHaveLength(201);
    expect(snapshot.workItems.at(-1)?.id).toBe('work-item-page-00200');
    expect(workItemCalls).toEqual([
      'https://board.example.test/v1/work-items',
      `https://board.example.test/v1/work-items?cursor=${encodeURIComponent(cursor)}`,
    ]);
  });

  it('rejects a repeated work-item continuation cursor', async () => {
    let workItemCalls = 0;
    const request = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/v1/projects')) return new Response(JSON.stringify({ projects: [] }));
      if (path.includes('/v1/work-items')) {
        workItemCalls += 1;
        return new Response(JSON.stringify({
          workItems: [paginatedWorkItem(workItemCalls)],
          nextCursor: 'repeated-cursor',
        }));
      }
      return new Response('{}');
    });
    const client = createTaskBoardClient({ fetch: request as unknown as typeof fetch });

    await expect(client.getSnapshot()).rejects.toThrow(/repeated a pagination cursor/u);
    expect(workItemCalls).toBe(2);
  });

  it('rejects oversized work-item pages and invalid continuation cursors', async () => {
    async function load(workItems: unknown[], nextCursor?: unknown) {
      const request = vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith('/v1/projects')) return new Response(JSON.stringify({ projects: [] }));
        return new Response(JSON.stringify({ workItems, ...(nextCursor === undefined ? {} : { nextCursor }) }));
      });
      return createTaskBoardClient({ fetch: request as unknown as typeof fetch }).getSnapshot();
    }

    await expect(load(Array.from({ length: 201 }, (_, index) => paginatedWorkItem(index)))).rejects.toThrow(/more than 200 records/u);
    await expect(load([], '')).rejects.toThrow(/nonempty string/u);
    await expect(load([], '🦋'.repeat(129))).rejects.toThrow(/512 UTF-8 bytes/u);
  });

  it('stops at the 50-page and 10,000-raw-row work-item boundary', async () => {
    const pageRows = Array.from({ length: 200 }, (_, index) => paginatedWorkItem(index));
    let workItemCalls = 0;
    const request = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/v1/projects')) return new Response(JSON.stringify({ projects: [] }));
      if (path.includes('/v1/work-items')) {
        workItemCalls += 1;
        return new Response(JSON.stringify({
          workItems: pageRows,
          nextCursor: `cursor-${workItemCalls}`,
        }));
      }
      return new Response('{}');
    });
    const client = createTaskBoardClient({ fetch: request as unknown as typeof fetch });

    await expect(client.getSnapshot()).rejects.toThrow(/50-page or 10,000-record pagination limit/u);
    expect(workItemCalls).toBe(50);
  });

  it('deduplicates live work-item page boundaries at the highest version without moving the first position', async () => {
    const boundaryId = 'work-item-live-boundary';
    let workItemCalls = 0;
    const request = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/v1/projects')) return new Response(JSON.stringify({ projects: [] }));
      if (path.includes('/v1/work-items')) {
        workItemCalls += 1;
        if (workItemCalls === 1) {
          return new Response(JSON.stringify({
            workItems: [
              paginatedWorkItem(1),
              paginatedWorkItem(2, { workItemId: boundaryId, version: 1, refinedObjective: null }),
            ],
            nextCursor: 'boundary-cursor',
          }));
        }
        return new Response(JSON.stringify({
          workItems: [
            paginatedWorkItem(2, {
              workItemId: boundaryId,
              version: 3,
              refinedObjective: 'The newer live-boundary refinement.',
              updatedAt: '2026-07-19T10:20:00.000Z',
            }),
            paginatedWorkItem(3),
          ],
        }));
      }
      return new Response('{}');
    });
    const client = createTaskBoardClient({ fetch: request as unknown as typeof fetch });

    const snapshot = await client.getSnapshot();

    expect(snapshot.workItems.map((item) => item.id)).toEqual([
      'work-item-page-00001',
      boundaryId,
      'work-item-page-00003',
    ]);
    expect(snapshot.workItems[1]).toMatchObject({
      id: boundaryId,
      version: 3,
      refinedObjective: 'The newer live-boundary refinement.',
    });
  });

  it('propagates the same abort signal through work-item continuation requests', async () => {
    const controller = new AbortController();
    const workItemSignals: Array<AbortSignal | null | undefined> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/v1/projects')) return new Response(JSON.stringify({ projects: [] }));
      if (path.endsWith('/v1/work-items')) {
        workItemSignals.push(init?.signal);
        return new Response(JSON.stringify({ workItems: [paginatedWorkItem(1)], nextCursor: 'next-page' }));
      }
      if (path.includes('/v1/work-items?cursor=')) {
        workItemSignals.push(init?.signal);
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return new Response('{}');
    });
    const client = createTaskBoardClient({ fetch: request as unknown as typeof fetch });

    await expect(client.getSnapshot(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(workItemSignals).toEqual([controller.signal, controller.signal]);
    expect(controller.signal.aborted).toBe(true);
  });

  it('returns the created project from the existing project response envelope', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ project })));
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
    });

    await expect(client.createProject({
      name: 'Cicada platform',
      description: 'Make the product more reliable for customers.',
    })).resolves.toEqual({
      id: project.projectId,
      name: project.name,
      description: project.description,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
    expect(request).toHaveBeenCalledWith(
      'https://board.example.test/v1/projects',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Cicada platform',
          description: 'Make the product more reliable for customers.',
        }),
      }),
    );
  });

  it('uses a stable tab identity for snapshot creation, pen fencing, saves, and release without waking an agent', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return new Response(JSON.stringify({ document: documentSnapshot }));
    });
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      documentClientId: 'document-tab-one',
      fetch: request as unknown as typeof fetch,
    });

    await expect(client.getDocument(documentSummary.documentId)).resolves.toMatchObject({ id: documentSummary.documentId });
    await client.createDocument({ projectId: project.projectId, title: '  Release notes  ', content: '# Draft' });
    await client.changeDocumentPen(documentSummary.documentId, { action: 'acquire', expectedPenEpoch: 1, force: true });
    await client.saveDocumentSnapshot(documentSummary.documentId, { penEpoch: 2, contentVersion: 2, content: '# Saved' });
    await client.changeDocumentPen(documentSummary.documentId, { action: 'release', expectedPenEpoch: 2, force: false });

    expect(client.documentClientId).toBe('document-tab-one');
    expect(calls.map(([url, init]) => [url, init?.method ?? 'GET', init?.body ? JSON.parse(String(init.body)) : null])).toEqual([
      ['https://board.example.test/v1/documents/document-release-notes', 'GET', null],
      ['https://board.example.test/v1/projects/project-one/documents', 'POST', {
        title: 'Release notes',
        contentType: 'text/markdown',
        content: '# Draft',
        clientId: 'document-tab-one',
      }],
      ['https://board.example.test/v1/documents/document-release-notes/pen', 'POST', {
        action: 'acquire',
        clientId: 'document-tab-one',
        expectedPenEpoch: 1,
        force: true,
      }],
      ['https://board.example.test/v1/documents/document-release-notes', 'PATCH', {
        clientId: 'document-tab-one',
        penEpoch: 2,
        contentVersion: 2,
        content: '# Saved',
      }],
      ['https://board.example.test/v1/documents/document-release-notes/pen', 'POST', {
        action: 'release',
        clientId: 'document-tab-one',
        expectedPenEpoch: 2,
        force: false,
      }],
    ]);
    expect(calls.some(([url]) => /\/tasks|\/resume|\/interrupt/u.test(url))).toBe(false);
    expect(calls.every(([, init]) => (init?.headers as Record<string, string> | undefined)?.authorization === undefined)).toBe(true);
  });

  it('validates resumable document snapshot events without adding browser authorization', async () => {
    const streamed = { ...documentSnapshot, contentVersion: 3, sequence: 5, content: '# Streamed' };
    const request = vi.fn(async () => new Response(
      `: keepalive\n\nid: 5\nevent: document\ndata: ${JSON.stringify({ document: streamed })}\n\n`,
      { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
    ));
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      documentClientId: 'document-tab-one',
      fetch: request as unknown as typeof fetch,
    });
    const received: string[] = [];

    await client.subscribeDocument({
      documentId: documentSummary.documentId,
      after: 4,
      signal: new AbortController().signal,
      onDocument: (document) => received.push(`${document.sequence}:${document.content}`),
    });

    expect(received).toEqual(['5:# Streamed']);
    expect(request).toHaveBeenCalledWith(
      'https://board.example.test/v1/documents/document-release-notes/events?after=4',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'omit',
        headers: { accept: 'text/event-stream' },
        signal: expect.any(AbortSignal),
      }),
    );

    const invalid = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: vi.fn(async () => new Response(
        `id: 6\nevent: document\ndata: ${JSON.stringify({ document: streamed })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )) as unknown as typeof fetch,
    });
    await expect(invalid.subscribeDocument({
      documentId: documentSummary.documentId,
      after: 4,
      signal: new AbortController().signal,
      onDocument: () => undefined,
    })).rejects.toBeInstanceOf(DocumentStreamError);
  });

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
      requiresReview: false,
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

  it('adds only bounded recent conversation to an agent follow-up', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return new Response('{}');
    });
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
    });
    const prompt = 'What should we tell customers next?';
    const recentConversation = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'human' as const : 'agent' as const,
      body: `${index === 0 ? 'oldest' : `turn-${index}`} ${'context '.repeat(70)}`,
    }));
    recentConversation.push({ role: 'human', body: prompt });
    recentConversation.push({ role: 'agent', body: 'Newest useful result.' });

    await client.createAgentQuery({
      projectId: project.projectId,
      agentId: agent.agentId,
      assignedRole: 'engineer',
      prompt,
      workspaceRefs: [],
      routingContext: '- Billing: billing-engineer',
      recentConversation,
    });

    const body = JSON.parse(String(calls[0]?.[1]?.body)) as { objective: string };
    expect(body.objective.length).toBeLessThanOrEqual(8_000);
    expect(body.objective.startsWith(`${prompt}${agentQueryConversationContextMarker}`)).toBe(true);
    expect(body.objective).toContain('Agent: Newest useful result.');
    expect(body.objective).not.toContain('oldest');
    expect(body.objective.match(new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu'))).toHaveLength(1);
    expect(body.objective).toContain(agentQueryRoutingContextMarker);
  });

  it('omits hidden context before rejecting a valid maximum-length prompt', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return new Response('{}');
    });
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
    });
    const prompt = 'x'.repeat(8_000);

    await expect(client.createAgentQuery({
      projectId: project.projectId,
      agentId: agent.agentId,
      assignedRole: 'engineer',
      prompt,
      workspaceRefs: [],
      routingContext: '- Billing: billing-engineer',
      recentConversation: [{ role: 'agent', body: 'Earlier result that is optional context.' }],
    })).resolves.toBeUndefined();

    const body = JSON.parse(String(calls[0]?.[1]?.body)) as { objective: string };
    expect(body.objective).toBe(prompt);
  });

  it('returns an unclaimed queued task to backlog without a run command', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return new Response('{}');
    });
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
    });

    await client.returnTaskToBacklog('task-one', { version: 3 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('https://board.example.test/v1/tasks/task-one');
    expect(calls[0]?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
      version: 3,
      assignedAgentId: null,
      assignedRole: null,
      status: 'backlog',
    });
    expect(calls.some(([url]) => url.includes('/resume') || url.includes('/interrupt'))).toBe(false);
  });

  it('exposes the durable task order key without coupling it to assignment', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return new Response('{}');
    });
    const client = createTaskBoardClient({
      baseUrl: 'https://board.example.test',
      fetch: request as unknown as typeof fetch,
    });

    await client.reorderTask('task-one', { orderKey: 4096, version: 3 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('https://board.example.test/v1/tasks/task-one');
    expect(calls[0]?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ version: 3, orderKey: 4096 });
    await expect(client.reorderTask('task-one', { orderKey: -1, version: 3 })).rejects.toThrow(/non-negative/u);
  });

  it('uses the exact API and keeps notes separate from the three wake operations', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      calls.push([path, init]);
      if (path.endsWith('/v1/projects')) return new Response(JSON.stringify({ projects: [project] }));
      if (path.endsWith('/v1/work-items')) return new Response(JSON.stringify({ workItems: [workItem] }));
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
      fetch: request as unknown as typeof fetch,
    });

    const snapshot = await client.getSnapshot();
    expect(snapshot.messages).toHaveLength(1);
    await client.assignTask('task-one', { agentId: 'billing-engineer', version: 2 });
    await client.addMessage('task-one', { body: 'Preserve the existing payment method.', version: 2 });
    await client.answerQuestion('question-one', { answer: 'Yes, preserve it.' });
    await client.resumeTask('task-one', { version: 2 });
    await client.interruptRun('run-one');

    const assignment = calls.find(([url, init]) => url.endsWith('/v1/tasks/task-one') && init?.method === 'PATCH');
    expect(JSON.parse(String(assignment?.[1]?.body))).toEqual({
      version: 2,
      assignedAgentId: 'billing-engineer',
      assignedRole: 'engineer',
      status: 'queued',
    });
    const note = calls.find(([url, init]) => url.endsWith('/v1/tasks/task-one/messages') && init?.method === 'POST');
    expect(JSON.parse(String(note?.[1]?.body))).toMatchObject({ kind: 'note', body: 'Preserve the existing payment method.' });
    expect(calls.some(([url]) => url.endsWith('/v1/questions/question-one/answer'))).toBe(true);
    expect(calls.some(([url]) => url.endsWith('/v1/agents/billing-engineer/resume'))).toBe(true);
    expect(calls.some(([url]) => url.endsWith('/v1/agents/billing-engineer/interrupt'))).toBe(true);
    expect(calls.every(([, init]) => (init?.headers as Record<string, string> | undefined)?.authorization === undefined)).toBe(true);
    expect(calls.every(([, init]) => init?.credentials === 'omit' && init.redirect === 'error')).toBe(true);
  });

  it('loads progress and results after the first 200-message page in chronological order', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      apiVersion,
      messageId: `message-${index + 1}`,
      sequence: index + 1,
      projectId: project.projectId,
      taskId: task.taskId,
      runId: 'run-one',
      actorType: 'agent',
      actorId: agent.agentId,
      kind: 'progress',
      body: `Progress update ${index + 1}`,
      createdAt: new Date(Date.parse('2026-07-19T10:00:00.000Z') + index * 1_000).toISOString(),
    }));
    const laterMessages = [
      {
        ...firstPage[0],
        messageId: 'message-201',
        sequence: 201,
        body: 'The focused verification passed.',
        createdAt: '2026-07-19T10:03:20.000Z',
      },
      {
        ...firstPage[0],
        messageId: 'message-202',
        sequence: 202,
        kind: 'result',
        body: 'Customers can recover failed invoices without support.',
        createdAt: '2026-07-19T10:03:21.000Z',
      },
    ];
    const calls: string[] = [];
    const request = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      calls.push(path);
      if (path.endsWith('/v1/projects')) return new Response(JSON.stringify({ projects: [project] }));
      if (path.endsWith('/v1/work-items')) return new Response(JSON.stringify({ workItems: [] }));
      if (path.endsWith('/v1/projects/project-one/board')) return new Response(JSON.stringify(boardSnapshot()));
      if (path.endsWith('/v1/tasks/task-one/messages?after=0')) {
        return new Response(JSON.stringify({ messages: firstPage, cursor: 200 }));
      }
      if (path.endsWith('/v1/tasks/task-one/messages?after=200')) {
        return new Response(JSON.stringify({ messages: laterMessages, cursor: 202 }));
      }
      return new Response('{}');
    });
    const client = createTaskBoardClient({ baseUrl: 'https://board.example.test', fetch: request as unknown as typeof fetch });

    const snapshot = await client.getSnapshot();

    expect(calls.filter((path) => path.includes('/v1/tasks/task-one/messages?after='))).toEqual([
      'https://board.example.test/v1/tasks/task-one/messages?after=0',
      'https://board.example.test/v1/tasks/task-one/messages?after=200',
    ]);
    expect(snapshot.messages).toHaveLength(202);
    expect(snapshot.messages.slice(-2)).toEqual([
      expect.objectContaining({ id: 'message-201', kind: 'progress', body: 'The focused verification passed.' }),
      expect.objectContaining({ id: 'message-202', kind: 'result', body: 'Customers can recover failed invoices without support.' }),
    ]);
  });

  it('rejects a full message page whose cursor does not advance', async () => {
    const page = Array.from({ length: 200 }, (_, index) => ({
      apiVersion,
      messageId: `stalled-message-${index + 1}`,
      sequence: index + 1,
      projectId: project.projectId,
      taskId: task.taskId,
      runId: 'run-one',
      actorType: 'agent',
      actorId: agent.agentId,
      kind: 'progress',
      body: `Progress update ${index + 1}`,
      createdAt: new Date(Date.parse('2026-07-19T10:00:00.000Z') + index * 1_000).toISOString(),
    }));
    const request = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/v1/projects')) return new Response(JSON.stringify({ projects: [project] }));
      if (path.endsWith('/v1/work-items')) return new Response(JSON.stringify({ workItems: [] }));
      if (path.endsWith('/v1/projects/project-one/board')) return new Response(JSON.stringify(boardSnapshot()));
      if (path.endsWith('/v1/tasks/task-one/messages?after=0')) {
        return new Response(JSON.stringify({ messages: page, cursor: 0 }));
      }
      return new Response('{}');
    });
    const client = createTaskBoardClient({ baseUrl: 'https://board.example.test', fetch: request as unknown as typeof fetch });

    await expect(client.getSnapshot()).rejects.toThrow(/cursor did not advance/u);
    expect(request.mock.calls.filter(([url]) => String(url).includes('/messages?after='))).toHaveLength(1);
  });

  it('rejects remote insecure and scheme-relative board URLs while allowing loopback development', () => {
    expect(() => createTaskBoardClient({ baseUrl: 'http://board.example.test' })).toThrow(/HTTPS/u);
    expect(() => createTaskBoardClient({ baseUrl: '//board.example.test' })).toThrow(/invalid/u);
    expect(() => createTaskBoardClient({ baseUrl: 'http://127.0.0.1:4318' })).not.toThrow();
  });

  it('enforces manager review assignment and records a human check without waking an agent', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      calls.push([path, init]);
      if (path.endsWith('/v1/projects')) return new Response(JSON.stringify({ projects: [project] }));
      if (path.endsWith('/v1/work-items')) return new Response(JSON.stringify({ workItems: [] }));
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
    await expect(client.assignTask(managerReview.taskId, { agentId: agent.agentId, version: 1 })).rejects.toThrow(/requires a manager/u);
    await expect(client.assignTask(humanCheck.taskId, { agentId: manager.agentId, version: 1 })).rejects.toThrow(/cannot be assigned/u);
    await expect(client.resumeTask(humanCheck.taskId, { version: 1 })).rejects.toThrow(/cannot wake/u);
    await expect(client.decideHumanCheck(managerReview.taskId, { version: 1, status: 'completed', result: 'Ready.' })).rejects.toThrow(/Only human checks/u);
    await expect(client.decideHumanCheck(humanCheck.taskId, { version: 1, status: 'completed', result: '  ' })).rejects.toThrow(/rationale/u);

    await client.assignTask(managerReview.taskId, { agentId: manager.agentId, version: 1 });
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

describe('document client tab identity', () => {
  const unusedFetch = vi.fn() as unknown as typeof fetch;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('rotates the copied session identity when an opener page still owns it', async () => {
    const local = new MemoryStorage();
    const originalSession = new MemoryStorage();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', originalSession);
    vi.stubGlobal('addEventListener', new PageLifecycle().addEventListener);
    vi.resetModules();
    const originalModule = await import('./client');
    const originalId = originalModule.createTaskBoardClient({ fetch: unusedFetch }).documentClientId;

    const copiedSession = originalSession.copy();
    vi.stubGlobal('sessionStorage', copiedSession);
    vi.stubGlobal('addEventListener', new PageLifecycle().addEventListener);
    vi.resetModules();
    const copiedModule = await import('./client');
    const copiedId = copiedModule.createTaskBoardClient({ fetch: unusedFetch }).documentClientId;

    expect(copiedId).not.toBe(originalId);
    expect(copiedModule.createTaskBoardClient({ fetch: unusedFetch }).documentClientId).toBe(copiedId);
    expect(originalSession.getItem('cicada.documentClientId')).toBe(originalId);
    expect(copiedSession.getItem('cicada.documentClientId')).toBe(copiedId);
  });

  it('reuses the identity after a normal pagehide releases the ownership claim', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const firstLifecycle = new PageLifecycle();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('addEventListener', firstLifecycle.addEventListener);
    vi.resetModules();
    const firstModule = await import('./client');
    const firstId = firstModule.createTaskBoardClient({ fetch: unusedFetch }).documentClientId;

    firstLifecycle.pagehide(false);

    vi.stubGlobal('addEventListener', new PageLifecycle().addEventListener);
    vi.resetModules();
    const reloadedModule = await import('./client');
    const reloadedId = reloadedModule.createTaskBoardClient({ fetch: unusedFetch }).documentClientId;

    expect(reloadedId).toBe(firstId);
  });

  it('retains a BFCache page claim so a concurrently active page gets a new identity', async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const cachedLifecycle = new PageLifecycle();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('addEventListener', cachedLifecycle.addEventListener);
    vi.resetModules();
    const cachedModule = await import('./client');
    const cachedId = cachedModule.createTaskBoardClient({ fetch: unusedFetch }).documentClientId;

    cachedLifecycle.pagehide(true);

    vi.stubGlobal('addEventListener', new PageLifecycle().addEventListener);
    vi.resetModules();
    const activeModule = await import('./client');
    const activeId = activeModule.createTaskBoardClient({ fetch: unusedFetch }).documentClientId;

    expect(activeId).not.toBe(cachedId);
  });

  it('keeps one runtime identity but does not trust copied session state when local storage is unavailable', async () => {
    const session = new MemoryStorage();
    const unavailableLocal = {
      getItem: () => { throw new Error('local storage denied'); },
    } as unknown as Storage;
    vi.stubGlobal('localStorage', unavailableLocal);
    vi.stubGlobal('sessionStorage', session);
    vi.resetModules();
    const firstModule = await import('./client');
    const firstId = firstModule.createTaskBoardClient({ fetch: unusedFetch }).documentClientId;

    expect(firstModule.createTaskBoardClient({ fetch: unusedFetch }).documentClientId).toBe(firstId);

    vi.resetModules();
    const nextRuntimeModule = await import('./client');
    const nextRuntimeId = nextRuntimeModule.createTaskBoardClient({ fetch: unusedFetch }).documentClientId;

    expect(nextRuntimeId).not.toBe(firstId);
    expect(session.getItem('cicada.documentClientId')).toBe(nextRuntimeId);
  });
});
