import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineSummary } from '@shared/task-board-contract';
import type { TaskBoardClient } from '../data/client';
import type { BoardWorkItem } from '../types';

const hookHarness = vi.hoisted(() => ({
  stateCursor: 0,
  refCursor: 0,
  effectCursor: 0,
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{
    dependencies: readonly unknown[] | undefined;
    cleanup: (() => void) | undefined;
  }>,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useCallback: <T extends (...arguments_: never[]) => unknown>(callback: T) => callback,
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
      const index = hookHarness.effectCursor++;
      const previous = hookHarness.effects[index];
      const changed = previous === undefined
        || dependencies === undefined
        || previous.dependencies === undefined
        || dependencies.length !== previous.dependencies.length
        || dependencies.some((dependency, dependencyIndex) => !Object.is(dependency, previous.dependencies?.[dependencyIndex]));
      if (!changed) return;
      previous?.cleanup?.();
      const cleanup = effect();
      hookHarness.effects[index] = {
        dependencies,
        cleanup: typeof cleanup === 'function' ? cleanup : undefined,
      };
    },
    useMemo: <T>(factory: () => T) => factory(),
    useReducer: <T>(_: unknown, initial: T) => [initial, vi.fn()],
    useRef: <T>(initial: T) => {
      const index = hookHarness.refCursor++;
      hookHarness.refs[index] ??= { current: initial };
      return hookHarness.refs[index] as { current: T };
    },
    useState: <T>(initial: T | (() => T)) => {
      const index = hookHarness.stateCursor++;
      if (!(index in hookHarness.states)) {
        hookHarness.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      }
      const setState = (next: T | ((current: T) => T)) => {
        const current = hookHarness.states[index] as T;
        hookHarness.states[index] = typeof next === 'function'
          ? (next as (value: T) => T)(current)
          : next;
      };
      return [hookHarness.states[index] as T, setState];
    },
  };
});

import { PipelineSummaryDetails, WorkItemDetail } from './WorkItemDetail';

const timestamp = '2026-08-19T12:00:00.000Z';
const summary: PipelineSummary = {
  commits: [],
  diffstat: '',
  filesTouched: [],
  declaredScope: ['src'],
  scopeOk: true,
  assumptions: [],
  midRunAssumptions: [],
  verify: [],
  criteria: [],
  criterionChecks: [],
  findings: [],
  designRecord: null,
};

function reviewingWorkItem(version = 4): BoardWorkItem {
  return {
    id: 'work-item-reviewing',
    originalRequest: 'Review the pipeline evidence.',
    refinedObjective: null,
    priority: 'normal',
    projectTarget: { mode: 'explicit', projectId: 'project-one' },
    resolvedProjectId: 'project-one',
    planningTaskId: 'planning-one',
    state: 'reviewing',
    currentStage: 'verification',
    createdBy: 'human:operator',
    version,
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
}

function resetHookHarness() {
  for (const effect of hookHarness.effects) effect?.cleanup?.();
  hookHarness.stateCursor = 0;
  hookHarness.refCursor = 0;
  hookHarness.effectCursor = 0;
  hookHarness.states.length = 0;
  hookHarness.refs.length = 0;
  hookHarness.effects.length = 0;
}

function renderDetail(workItem: BoardWorkItem, client: TaskBoardClient): ReactNode {
  hookHarness.stateCursor = 0;
  hookHarness.refCursor = 0;
  hookHarness.effectCursor = 0;
  const noop = async () => ({ ok: true as const });
  return WorkItemDetail({
    workItem,
    projectName: 'Project one',
    planningTask: null,
    openQuestion: null,
    client,
    busy: false,
    onClose: vi.fn(),
    onAnswer: noop,
    onConfirm: noop,
    onCancel: noop,
    onArchive: noop,
  });
}

function findElement(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return findElement((node.props as { children?: ReactNode }).children, type);
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(' ');
  if (!isValidElement(node)) return '';
  return textContent((node.props as { children?: ReactNode }).children);
}

describe('pipeline summary fetch gate', () => {
  beforeEach(() => {
    resetHookHarness();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  });

  afterEach(() => {
    resetHookHarness();
    vi.unstubAllGlobals();
  });

  it('fetches the pipeline summary while the work item is reviewing', () => {
    const getPipelineSummary = vi.fn().mockResolvedValue(summary);
    const client = { getPipelineSummary } as unknown as TaskBoardClient;

    renderDetail(reviewingWorkItem(), client);

    expect(getPipelineSummary).toHaveBeenCalledOnce();
    expect(getPipelineSummary).toHaveBeenCalledWith('work-item-reviewing', expect.any(AbortSignal));
  });

  it('keeps the rendered summary visible while a version-bump refetch is in flight', async () => {
    let resolveRefresh: ((value: PipelineSummary) => void) | undefined;
    const refresh = new Promise<PipelineSummary>((resolve) => { resolveRefresh = resolve; });
    const getPipelineSummary = vi.fn()
      .mockResolvedValueOnce(summary)
      .mockImplementationOnce(() => refresh);
    const client = { getPipelineSummary } as unknown as TaskBoardClient;

    renderDetail(reviewingWorkItem(4), client);
    await Promise.resolve();
    await Promise.resolve();

    const loaded = renderDetail(reviewingWorkItem(4), client);
    expect(findElement(loaded, PipelineSummaryDetails)?.props).toMatchObject({ summary });

    renderDetail(reviewingWorkItem(5), client);
    const refreshing = renderDetail(reviewingWorkItem(5), client);

    expect(getPipelineSummary).toHaveBeenCalledTimes(2);
    expect(findElement(refreshing, PipelineSummaryDetails)?.props).toMatchObject({ summary });
    expect(textContent(refreshing)).not.toContain('Loading pipeline summary');

    resolveRefresh?.(summary);
    await refresh;
  });
});
