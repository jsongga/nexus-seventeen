import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from '../../components/ui';
import type { TaskBoardClient } from '../data/client';
import type { BoardQuestion, BoardTask, BoardWorkItem } from '../types';
import { GapReportSection, WorkItemDetail } from './WorkItemDetail';

vi.mock('../../components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/ui')>();
  return { ...actual, Modal: vi.fn(() => null) };
});

const timestamp = '2026-08-16T00:00:00.000Z';

const parkedWorkItem: BoardWorkItem = {
  id: 'work-item-one',
  originalRequest: 'Plan the next campaign.',
  refinedObjective: null,
  priority: 'normal',
  taskType: 'standard',
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

describe('work-item confirmation surfaces', () => {
  it('anchors only the dirty-free merge and archive confirms', () => {
    vi.mocked(Modal).mockClear();
    renderParkedDetail(null);

    const modalProps = new Map(vi.mocked(Modal).mock.calls.map(([props]) => [props.title, props]));
    expect(modalProps.get('Approve and merge pipeline')).toMatchObject({
      variant: 'anchored',
      anchorRef: { current: null },
    });
    expect(modalProps.get('Archive work item')).toMatchObject({
      variant: 'anchored',
      anchorRef: { current: null },
    });
    for (const takeoverTitle of [
      'Cancel work item',
      'Reject proposed plan',
      'Request implementation changes',
    ]) {
      const takeoverProps = modalProps.get(takeoverTitle);
      expect(takeoverProps).toBeDefined();
      expect(takeoverProps).not.toHaveProperty('variant');
      expect(takeoverProps).not.toHaveProperty('anchorRef');
    }
  });
});

describe('onboarding gap report section', () => {
  it('renders distinct loading, recorded, empty, and recoverable error states', () => {
    const loading = renderToStaticMarkup(createElement(GapReportSection, {
      state: 'loading',
      content: null,
      error: null,
      onRetry: () => undefined,
    }));
    const recorded = renderToStaticMarkup(createElement(GapReportSection, {
      state: 'ready',
      content: '# Gaps\n\n- Branch protection is deferred.',
      error: null,
      onRetry: () => undefined,
    }));
    const empty = renderToStaticMarkup(createElement(GapReportSection, {
      state: 'ready',
      content: null,
      error: null,
      onRetry: () => undefined,
    }));
    const failed = renderToStaticMarkup(createElement(GapReportSection, {
      state: 'error',
      content: null,
      error: 'Artifact content could not be loaded.',
      onRetry: () => undefined,
    }));

    expect(loading).toContain('Loading gap report…');
    expect(recorded).toContain('Gap report');
    expect(recorded).toContain('# Gaps');
    expect(recorded).toContain('Branch protection is deferred.');
    expect(empty).toContain('No gap report has been recorded yet.');
    expect(failed).toContain('Artifact content could not be loaded.');
    expect(failed).toContain('Retry');
  });
});
