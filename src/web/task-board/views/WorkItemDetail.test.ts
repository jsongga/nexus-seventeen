import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskBoardClient } from '../data/client';
import type { BoardQuestion, BoardTask, BoardWorkItem } from '../types';
import { WorkItemDetail } from './WorkItemDetail';

const timestamp = '2026-08-16T00:00:00.000Z';

const parkedWorkItem: BoardWorkItem = {
  id: 'work-item-one',
  originalRequest: 'Plan the next campaign.',
  refinedObjective: null,
  priority: 'normal',
  projectTarget: { mode: 'auto' },
  resolvedProjectId: 'project-one',
  planningTaskId: 'planning-task-one',
  state: 'parked',
  currentStage: 'planning',
  createdBy: 'operator-one',
  version: 1,
  createdAt: timestamp,
  createdAtMs: Date.parse(timestamp),
  updatedAt: timestamp,
  updatedAtMs: Date.parse(timestamp),
  endedAt: null,
  endedAtMs: null,
  cancelledReason: null,
  archivedAt: null,
  archivedAtMs: null,
};

const planningTask: BoardTask = {
  id: 'planning-task-one',
  projectId: 'project-one',
  parentTaskId: null,
  kind: 'work',
  requiredRole: 'engineer',
  requiresReview: false,
  title: 'Plan the campaign',
  objective: 'Prepare the campaign plan.',
  acceptanceCriteria: null,
  workspaceRefs: [],
  assignedAgentId: 'agent-one',
  assignedRole: 'engineer',
  status: 'waiting_for_human',
  expectedAgentMinutes: null,
  estimateRecordedAt: null,
  estimateRecordedAtMs: null,
  expectedCompletedAt: null,
  expectedCompletedAtMs: null,
  orderKey: 1,
  phases: [],
  startedAt: timestamp,
  startedAtMs: Date.parse(timestamp),
  endedAt: null,
  endedAtMs: null,
  result: null,
  version: 1,
  createdAt: timestamp,
  createdAtMs: Date.parse(timestamp),
  updatedAt: timestamp,
  updatedAtMs: Date.parse(timestamp),
};

const openQuestion: BoardQuestion = {
  id: 'question-one',
  projectId: 'project-one',
  taskId: planningTask.id,
  agentId: 'agent-one',
  prompt: 'Which audience should this target?',
  status: 'open',
  answer: null,
  askedAt: timestamp,
  askedAtMs: Date.parse(timestamp),
  answeredAt: null,
  answeredAtMs: null,
  version: 1,
};

function renderParkedDetail(question: BoardQuestion | null): string {
  const ok = async () => ({ ok: true as const });
  return renderToStaticMarkup(createElement(WorkItemDetail, {
    workItem: parkedWorkItem,
    snapshotRevision: 1,
    projectName: 'Project one',
    planningTask,
    openQuestion: question,
    client: {} as TaskBoardClient,
    busy: false,
    onClose: () => undefined,
    onAnswer: ok,
    onConfirm: ok,
    onCancel: ok,
    onArchive: ok,
  }));
}

describe('parked work-item detail', () => {
  it('shows a neutral parked notice when there is no open question', () => {
    const markup = renderParkedDetail(null);

    expect(markup).toContain('Parked — no open question. Retry or reassign from the task view.');
    expect(markup).not.toContain('Planning needs your input');
  });

  it('shows the question UI when there is an open question', () => {
    const markup = renderParkedDetail(openQuestion);

    expect(markup).toContain('Planning needs your input');
    expect(markup).toContain('Which audience should this target?');
    expect(markup).not.toContain('Parked — no open question. Retry or reassign from the task view.');
  });
});
