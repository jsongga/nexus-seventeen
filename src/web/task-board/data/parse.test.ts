import { describe, expect, it, vi } from 'vitest';
import { TASK_BOARD_API_VERSION } from '@shared/task-board-contract';

const entityParserSpies = vi.hoisted(() => ({
  agent: vi.fn(),
  documentPenHolder: vi.fn(),
  documentSummary: vi.fn(),
  event: vi.fn(),
  interrupt: vi.fn(),
  project: vi.fn(),
  question: vi.fn(),
  run: vi.fn(),
  task: vi.fn(),
  taskPhase: vi.fn(),
}));

vi.mock('@shared/task-board-contract/validate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/task-board-contract/validate')>();
  return {
    ...actual,
    parseAgentEntity: (...args: Parameters<typeof actual.parseAgentEntity>) => {
      entityParserSpies.agent();
      return actual.parseAgentEntity(...args);
    },
    parseBoardSnapshotEntity: (...args: Parameters<typeof actual.parseBoardSnapshotEntity>) => {
      const parsed = actual.parseBoardSnapshotEntity(...args);
      entityParserSpies.project();
      parsed.agents.forEach(() => entityParserSpies.agent());
      parsed.tasks.forEach((task) => {
        entityParserSpies.task();
        task.phases.forEach(() => entityParserSpies.taskPhase());
      });
      parsed.openQuestions.forEach(() => entityParserSpies.question());
      parsed.recentQuestions.forEach(() => entityParserSpies.question());
      parsed.recentRuns.forEach(() => entityParserSpies.run());
      parsed.recentInterrupts.forEach(() => entityParserSpies.interrupt());
      parsed.recentEvents.forEach(() => entityParserSpies.event());
      parsed.documents.forEach((document) => {
        entityParserSpies.documentSummary();
        if (document.penHolder !== null) entityParserSpies.documentPenHolder();
      });
      return parsed;
    },
    parseDocumentPenHolderEntity: (...args: Parameters<typeof actual.parseDocumentPenHolderEntity>) => {
      entityParserSpies.documentPenHolder();
      return actual.parseDocumentPenHolderEntity(...args);
    },
    parseDocumentSummaryEntity: (...args: Parameters<typeof actual.parseDocumentSummaryEntity>) => {
      entityParserSpies.documentSummary();
      return actual.parseDocumentSummaryEntity(...args);
    },
    parseEventEntity: (...args: Parameters<typeof actual.parseEventEntity>) => {
      entityParserSpies.event();
      return actual.parseEventEntity(...args);
    },
    parseInterruptEntity: (...args: Parameters<typeof actual.parseInterruptEntity>) => {
      entityParserSpies.interrupt();
      return actual.parseInterruptEntity(...args);
    },
    parseProjectEntity: (...args: Parameters<typeof actual.parseProjectEntity>) => {
      entityParserSpies.project();
      return actual.parseProjectEntity(...args);
    },
    parseQuestionEntity: (...args: Parameters<typeof actual.parseQuestionEntity>) => {
      entityParserSpies.question();
      return actual.parseQuestionEntity(...args);
    },
    parseRunEntity: (...args: Parameters<typeof actual.parseRunEntity>) => {
      entityParserSpies.run();
      return actual.parseRunEntity(...args);
    },
    parseTaskEntity: (...args: Parameters<typeof actual.parseTaskEntity>) => {
      entityParserSpies.task();
      return actual.parseTaskEntity(...args);
    },
    parseTaskPhaseEntity: (...args: Parameters<typeof actual.parseTaskPhaseEntity>) => {
      entityParserSpies.taskPhase();
      return actual.parseTaskPhaseEntity(...args);
    },
  };
});

import {
  parseAgent,
  parseAutomationAgentType,
  parseAutomationExecutor,
  parseDocument,
  parseProject,
  parseQuestion,
  parseRawBoard,
  parseRun,
  parseTask,
} from './parse';

const NOW = '2026-08-09T20:00:00.000Z';

const project = {
  apiVersion: TASK_BOARD_API_VERSION,
  projectId: 'project-one',
  name: 'Project one',
  description: 'Regression fixture.',
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

const agent = {
  apiVersion: TASK_BOARD_API_VERSION,
  agentId: 'agent-one',
  projectId: 'project-one',
  role: 'engineer',
  area: 'Validation',
  mission: 'Preserve the browser contract.',
  model: 'model-one',
  status: 'idle',
  workerConnection: null,
  lastError: null,
  version: 1,
  createdAt: NOW,
};

const phase = {
  apiVersion: TASK_BOARD_API_VERSION,
  phaseId: 'phase-one',
  projectId: 'project-one',
  taskId: 'task-one',
  title: 'Validate',
  stage: 'testing',
  status: 'pending',
  parallelGroup: null,
  orderKey: 0,
  startedAt: null,
  endedAt: null,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

const task = {
  apiVersion: TASK_BOARD_API_VERSION,
  taskId: 'task-one',
  projectId: 'project-one',
  parentTaskId: null,
  kind: 'work',
  requiredRole: null,
  requiresReview: false,
  title: 'Validate browser parsing',
  objective: 'Preserve the existing browser contract.',
  acceptanceCriteria: 'Every regression pin passes.',
  workspaceRefs: [],
  status: 'in_progress',
  assignedAgentId: 'agent-one',
  assignedRole: 'engineer',
  expectedAgentMinutes: 30,
  estimateRecordedAt: NOW,
  orderKey: 0,
  phases: [phase],
  startedAt: NOW,
  expectedCompletedAt: NOW,
  endedAt: null,
  result: null,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

const question = {
  apiVersion: TASK_BOARD_API_VERSION,
  questionId: 'question-one',
  projectId: 'project-one',
  taskId: 'task-one',
  agentId: 'agent-one',
  question: 'Proceed?',
  status: 'open',
  answer: null,
  askedAt: NOW,
  answeredAt: null,
  version: 1,
};

const document = {
  apiVersion: TASK_BOARD_API_VERSION,
  documentId: 'document-one',
  projectId: 'project-one',
  title: 'Document one',
  contentType: 'text/markdown',
  contentVersion: 1,
  penEpoch: 1,
  penHolder: { actorType: 'agent', actorId: 'agent-one', clientId: 'client-one', acquiredAt: NOW },
  sequence: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

describe('browser task-board validator adapter', () => {
  it('keeps response identifiers opaque and omits apiVersion from raw projections', () => {
    const parsed = parseProject({
      ...project,
      projectId: '',
      name: 'Legacy project',
      description: 'The browser historically treats response IDs as opaque strings.',
    }, 'project');

    expect(parsed).toEqual({
      projectId: '',
      name: 'Legacy project',
      description: 'The browser historically treats response IDs as opaque strings.',
      version: 1,
      createdAt: NOW,
      createdAtMs: Date.parse(NOW),
      updatedAt: NOW,
      updatedAtMs: Date.parse(NOW),
    });
    expect(parsed).not.toHaveProperty('apiVersion');
  });

  it('keeps document and pen-holder response identifiers opaque', () => {
    expect(parseDocument({
      ...document,
      documentId: '',
      projectId: 'opaque project id',
      penHolder: { actorType: 'agent', actorId: '', clientId: 'opaque client id', acquiredAt: NOW },
      content: '# Document',
    }, 'document')).toMatchObject({
      documentId: '',
      projectId: 'opaque project id',
      penHolder: { actorId: '', clientId: 'opaque client id' },
    });
  });

  it('validates a terminal task completion timestamp before projecting it to null', () => {
    expect(() => parseTask({
      ...task,
      status: 'completed',
      expectedCompletedAt: 'not-a-timestamp',
      endedAt: NOW,
    }, 'task')).toThrow('task.expectedCompletedAt must be a timestamp');
  });

  it('keeps type-first browser scalar messages', () => {
    expect(() => parseProject({ ...project, createdAt: 1 }, 'project')).toThrow('project.createdAt must be a string');
    expect(() => parseAgent({ ...agent, role: 1 }, 'agent')).toThrow('agent.role must be a string');
    expect(() => parseTask({ ...task, expectedAgentMinutes: '30' }, 'task')).toThrow(
      'task.expectedAgentMinutes must be a safe integer of at least 15',
    );
    expect(() => parseAutomationAgentType({
      agentTypeId: 'type-one',
      name: 1,
      description: 'Regression fixture.',
      role: 'engineer',
      supplementalInstructions: '',
      skillIds: [],
      evaluatorProfile: 'tests',
      enabled: false,
    }, 'agentType')).toThrow('agentType.name must be a string');
  });

  it('runs every entity parser once while projecting a board snapshot', () => {
    Object.values(entityParserSpies).forEach((spy) => spy.mockClear());
    parseRawBoard({
      apiVersion: TASK_BOARD_API_VERSION,
      project,
      agents: [agent],
      tasks: [task],
      openQuestions: [question],
      recentQuestions: [{ ...question, questionId: 'question-two' }],
      recentRuns: [{
        apiVersion: TASK_BOARD_API_VERSION,
        runId: 'run-one',
        projectId: 'project-one',
        agentId: 'agent-one',
        taskId: 'task-one',
        status: 'active',
        startedAt: NOW,
        endedAt: null,
      }],
      recentInterrupts: [{
        apiVersion: TASK_BOARD_API_VERSION,
        sequence: 1,
        agentId: 'agent-one',
        runId: 'run-one',
        requestedAt: NOW,
      }],
      recentEvents: [{
        apiVersion: TASK_BOARD_API_VERSION,
        eventId: 'event-one',
        projectId: 'project-one',
        taskId: 'task-one',
        actorType: 'agent',
        actorId: 'agent-one',
        eventType: 'run_started',
        data: {},
        createdAt: NOW,
      }],
      documents: [document],
    });

    expect(entityParserSpies.project).toHaveBeenCalledTimes(1);
    expect(entityParserSpies.agent).toHaveBeenCalledTimes(1);
    expect(entityParserSpies.task).toHaveBeenCalledTimes(1);
    expect(entityParserSpies.taskPhase).toHaveBeenCalledTimes(1);
    expect(entityParserSpies.question).toHaveBeenCalledTimes(2);
    expect(entityParserSpies.run).toHaveBeenCalledTimes(1);
    expect(entityParserSpies.interrupt).toHaveBeenCalledTimes(1);
    expect(entityParserSpies.event).toHaveBeenCalledTimes(1);
    expect(entityParserSpies.documentSummary).toHaveBeenCalledTimes(1);
    expect(entityParserSpies.documentPenHolder).toHaveBeenCalledTimes(1);
  });

  it('preserves rolling compatibility for response fields omitted by the raw projection', () => {
    expect(parseQuestion({
      apiVersion: TASK_BOARD_API_VERSION,
      questionId: 'question-one',
      projectId: 'project-one',
      taskId: 'task-one',
      agentId: 'agent-one',
      question: 'Proceed?',
      status: 'open',
      answer: null,
      askedAt: NOW,
      answeredAt: null,
      version: 1,
    }, 'question')).not.toHaveProperty('apiVersion');

    expect(parseRun({
      apiVersion: TASK_BOARD_API_VERSION,
      runId: 'run-one',
      projectId: 'project-one',
      agentId: 'agent-one',
      taskId: 'task-one',
      status: 'active',
      startedAt: NOW,
      endedAt: null,
    }, 'run')).not.toHaveProperty('apiVersion');
  });

  it('keeps the browser automation executor error path and type message', () => {
    expect(() => parseAutomationExecutor({ kind: 1 }, 'executor')).toThrow('executor.kind must be a string');
    expect(() => parseAutomationExecutor({ kind: 'unknown' }, 'executor')).toThrow(
      'executor.kind has an unsupported value',
    );
  });
});
