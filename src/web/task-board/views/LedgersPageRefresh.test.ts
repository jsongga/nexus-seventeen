import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskBoardClient } from '../data/client';
import type { RawFindingsLedger, RawParksLedger } from '../data/parse';

const hookHarness = vi.hoisted(() => ({
  stateCursor: 0,
  effectCursor: 0,
  states: [] as unknown[],
  effects: [] as Array<{
    dependencies: readonly unknown[] | undefined;
    cleanup: (() => void) | undefined;
  }>,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
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

import { FindingsLedgerSection, LedgersPage, ParksLedgerSection } from './LedgersPage';

const initialFindings: RawFindingsLedger = {
  categories: [{ category: 'correctness', severity: 'minor', blocking: false, count: 1 }],
  perProject: [],
  recent: [],
};
const refreshedFindings: RawFindingsLedger = {
  categories: [{ category: 'correctness', severity: 'major', blocking: true, count: 2 }],
  perProject: [],
  recent: [],
};
const initialParks: RawParksLedger = { recordsSince: '2026-08-20', open: [], resolved: [] };
const refreshedParks: RawParksLedger = { recordsSince: '2026-08-21', open: [], resolved: [] };

function resetHookHarness() {
  for (const effect of hookHarness.effects) effect?.cleanup?.();
  hookHarness.stateCursor = 0;
  hookHarness.effectCursor = 0;
  hookHarness.states.length = 0;
  hookHarness.effects.length = 0;
}

function renderPage(client: TaskBoardClient, snapshotRevision: number): ReactNode {
  hookHarness.stateCursor = 0;
  hookHarness.effectCursor = 0;
  return LedgersPage({ client, connected: true, snapshotRevision });
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

describe('ledger background refresh', () => {
  beforeEach(resetHookHarness);
  afterEach(resetHookHarness);

  it('reloads both ledgers on revision change without blanking rendered data', async () => {
    let resolveFindings!: (value: RawFindingsLedger) => void;
    let resolveParks!: (value: RawParksLedger) => void;
    const pendingFindings = new Promise<RawFindingsLedger>((resolve) => { resolveFindings = resolve; });
    const pendingParks = new Promise<RawParksLedger>((resolve) => { resolveParks = resolve; });
    const getFindingsLedger = vi.fn()
      .mockResolvedValueOnce(initialFindings)
      .mockImplementationOnce(() => pendingFindings);
    const getParksLedger = vi.fn()
      .mockResolvedValueOnce(initialParks)
      .mockImplementationOnce(() => pendingParks);
    const client = { getFindingsLedger, getParksLedger } as unknown as TaskBoardClient;

    renderPage(client, 4);
    await Promise.resolve();
    await Promise.resolve();
    const loaded = renderPage(client, 4);
    expect(findElement(loaded, FindingsLedgerSection)?.props).toMatchObject({ ledger: initialFindings });
    expect(findElement(loaded, ParksLedgerSection)?.props).toMatchObject({ ledger: initialParks });

    renderPage(client, 5);
    const refreshing = renderPage(client, 5);
    expect(getFindingsLedger).toHaveBeenCalledTimes(2);
    expect(getParksLedger).toHaveBeenCalledTimes(2);
    expect(findElement(refreshing, FindingsLedgerSection)?.props).toMatchObject({ ledger: initialFindings });
    expect(findElement(refreshing, ParksLedgerSection)?.props).toMatchObject({ ledger: initialParks });

    resolveFindings(refreshedFindings);
    resolveParks(refreshedParks);
    await Promise.all([pendingFindings, pendingParks]);
    await Promise.resolve();
    const refreshed = renderPage(client, 5);
    expect(findElement(refreshed, FindingsLedgerSection)?.props).toMatchObject({ ledger: refreshedFindings });
    expect(findElement(refreshed, ParksLedgerSection)?.props).toMatchObject({ ledger: refreshedParks });
  });
});
