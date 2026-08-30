import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineSummary } from "@shared/task-board-contract";
import type { TaskBoardClient } from "../data/client";
import type { RawWorkItemAudit } from "../data/parse";
import type { BoardChildWorkItem, BoardWorkItem } from "../types";

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

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T extends (...arguments_: never[]) => unknown>(callback: T) => callback,
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
      const index = hookHarness.effectCursor++;
      const previous = hookHarness.effects[index];
      const changed =
        previous === undefined ||
        dependencies === undefined ||
        previous.dependencies === undefined ||
        dependencies.length !== previous.dependencies.length ||
        dependencies.some(
          (dependency, dependencyIndex) => !Object.is(dependency, previous.dependencies?.[dependencyIndex])
        );
      if (!changed) return;
      previous?.cleanup?.();
      const cleanup = effect();
      hookHarness.effects[index] = {
        dependencies,
        cleanup: typeof cleanup === "function" ? cleanup : undefined,
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
        hookHarness.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      const setState = (next: T | ((current: T) => T)) => {
        const current = hookHarness.states[index] as T;
        hookHarness.states[index] = typeof next === "function" ? (next as (value: T) => T)(current) : next;
      };
      return [hookHarness.states[index] as T, setState];
    },
  };
});

import {
  AuditSection,
  ChildrenSection,
  PipelineSummaryDetails,
  StatusTimeline,
  WorkItemDetail,
} from "./WorkItemDetail";

const timestamp = "2026-08-19T12:00:00.000Z";
const summary: PipelineSummary = {
  commits: [],
  diffstat: "",
  filesTouched: [],
  declaredScope: ["src"],
  scopeOk: true,
  assumptions: [],
  midRunAssumptions: [],
  verify: [],
  criteria: [],
  criterionChecks: [],
  findings: [],
  designRecord: null,
};

function audit(note: string): RawWorkItemAudit {
  return {
    transitions: [],
    gateActions: [
      {
        gateActionId: `gate-${note}`,
        workItemId: "work-item-reviewing",
        gate: "question_answer",
        actorId: "human:operator",
        planRevisionId: null,
        verifiedSha: null,
        mergeSha: null,
        refId: null,
        note,
        createdAt: timestamp,
        createdAtMs: Date.parse(timestamp),
      },
    ],
  };
}

function reviewingWorkItem(version = 4): BoardWorkItem {
  return {
    id: "work-item-reviewing",
    originalRequest: "Review the pipeline evidence.",
    refinedObjective: null,
    priority: "normal",
    taskType: "standard",
    projectTarget: { mode: "explicit", projectId: "project-one" },
    resolvedProjectId: "project-one",
    parentWorkItemId: null,
    phase: null,
    childOrdinal: null,
    planningTaskId: "planning-one",
    state: "reviewing",
    currentStage: "verification",
    createdBy: "human:operator",
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

function renderDetail(
  workItem: BoardWorkItem,
  client: TaskBoardClient,
  snapshotRevision = 1,
  familyVersionKey = `${workItem.id}:${workItem.version}`,
  familyRefreshRevision = 0
): ReactNode {
  hookHarness.stateCursor = 0;
  hookHarness.refCursor = 0;
  hookHarness.effectCursor = 0;
  const noop = async () => ({ ok: true as const });
  const familyClient = client as TaskBoardClient & {
    getWorkItemChildren?: TaskBoardClient["getWorkItemChildren"];
    getWorkItemDependencies?: TaskBoardClient["getWorkItemDependencies"];
  };
  familyClient.getWorkItemChildren ??= async () => [];
  familyClient.getWorkItemDependencies ??= async () => [];
  return WorkItemDetail({
    workItem,
    snapshotRevision,
    familyVersionKey,
    familyRefreshRevision,
    projectName: "Project one",
    projects: [],
    parentWorkItem: null,
    planningTask: null,
    openQuestion: null,
    client: familyClient,
    busy: false,
    onClose: vi.fn(),
    onAnswer: noop,
    onConfirm: noop,
    onAttestDeploy: noop,
    onResumeCoordination: noop,
    onCancel: noop,
    onArchive: noop,
  });
}

describe("decomposition family refresh", () => {
  beforeEach(() => {
    resetHookHarness();
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  });

  afterEach(() => {
    resetHookHarness();
    vi.unstubAllGlobals();
  });

  it("keeps the last family visible, ignores unrelated revisions, and retries on manual refresh", async () => {
    const parent = { ...reviewingWorkItem(4), id: "parent-one", state: "final_approval" as const };
    const child: BoardChildWorkItem = {
      ...parent,
      id: "child-one",
      parentWorkItemId: parent.id,
      childOrdinal: 0,
      state: "final_approval",
      deployAttested: false,
      mergeSha: null,
    };
    const backgroundRefresh = new Promise<BoardChildWorkItem[]>(() => undefined);
    const getWorkItemChildren = vi
      .fn()
      .mockResolvedValueOnce([child])
      .mockImplementation(() => backgroundRefresh);
    const client = {
      getWorkItemChildren,
      getWorkItemAudit: vi.fn().mockResolvedValue({ gateActions: [], transitions: [] }),
      getPipelineSummary: vi.fn().mockResolvedValue(summary),
    } as unknown as TaskBoardClient;

    renderDetail(parent, client, 10, "parent-one:4|child-one:1");
    await Promise.resolve();
    await Promise.resolve();
    const loaded = renderDetail(parent, client, 10, "parent-one:4|child-one:1");
    expect(findElement(loaded, ChildrenSection)?.props).toMatchObject({ state: "ready", children: [child] });

    renderDetail(parent, client, 11, "parent-one:4|child-one:1");
    expect(getWorkItemChildren).toHaveBeenCalledTimes(1);

    renderDetail(parent, client, 11, "parent-one:4|child-one:2");
    const refreshing = renderDetail(parent, client, 11, "parent-one:4|child-one:2");
    expect(getWorkItemChildren).toHaveBeenCalledTimes(2);
    expect(findElement(refreshing, ChildrenSection)?.props).toMatchObject({ state: "ready", children: [child] });

    renderDetail(parent, client, 11, "parent-one:4|child-one:2", 1);
    expect(getWorkItemChildren).toHaveBeenCalledTimes(3);
  });
});

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
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(" ");
  if (!isValidElement(node)) return "";
  return textContent((node.props as { children?: ReactNode }).children);
}

describe("pipeline summary fetch gate", () => {
  beforeEach(() => {
    resetHookHarness();
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  });

  afterEach(() => {
    resetHookHarness();
    vi.unstubAllGlobals();
  });

  it("fetches the pipeline summary while the work item is reviewing", () => {
    const getPipelineSummary = vi.fn().mockResolvedValue(summary);
    const getWorkItemAudit = vi.fn().mockResolvedValue({ gateActions: [], transitions: [] });
    const client = { getPipelineSummary, getWorkItemAudit } as unknown as TaskBoardClient;

    renderDetail(reviewingWorkItem(), client);

    expect(getPipelineSummary).toHaveBeenCalledOnce();
    expect(getPipelineSummary).toHaveBeenCalledWith("work-item-reviewing", expect.any(AbortSignal));
  });

  it("keeps the rendered summary visible while a version-bump refetch is in flight", async () => {
    let resolveRefresh: ((value: PipelineSummary) => void) | undefined;
    const refresh = new Promise<PipelineSummary>((resolve) => {
      resolveRefresh = resolve;
    });
    const getPipelineSummary = vi
      .fn()
      .mockResolvedValueOnce(summary)
      .mockImplementationOnce(() => refresh);
    const getWorkItemAudit = vi.fn().mockResolvedValue({ gateActions: [], transitions: [] });
    const client = { getPipelineSummary, getWorkItemAudit } as unknown as TaskBoardClient;

    renderDetail(reviewingWorkItem(4), client);
    await Promise.resolve();
    await Promise.resolve();

    const loaded = renderDetail(reviewingWorkItem(4), client);
    expect(findElement(loaded, PipelineSummaryDetails)?.props).toMatchObject({ summary });

    renderDetail(reviewingWorkItem(5), client);
    const refreshing = renderDetail(reviewingWorkItem(5), client);

    expect(getPipelineSummary).toHaveBeenCalledTimes(2);
    expect(findElement(refreshing, PipelineSummaryDetails)?.props).toMatchObject({ summary });
    expect(textContent(refreshing)).not.toContain("Loading pipeline summary");

    resolveRefresh?.(summary);
    await refresh;
  });
});

describe("work-item audit refresh", () => {
  beforeEach(() => {
    resetHookHarness();
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  });

  afterEach(() => {
    resetHookHarness();
    vi.unstubAllGlobals();
  });

  it("keeps the rendered audit visible while a version-bump refetch is in flight", async () => {
    const initialAudit = audit("initial");
    const refresh = new Promise<RawWorkItemAudit>(() => undefined);
    const getWorkItemAudit = vi
      .fn()
      .mockResolvedValueOnce(initialAudit)
      .mockImplementationOnce(() => refresh);
    const client = {
      getPipelineSummary: vi.fn().mockResolvedValue(summary),
      getWorkItemAudit,
    } as unknown as TaskBoardClient;

    renderDetail(reviewingWorkItem(4), client, 1);
    await Promise.resolve();
    await Promise.resolve();
    const loaded = renderDetail(reviewingWorkItem(4), client, 1);
    expect(findElement(loaded, AuditSection)?.props).toMatchObject({ audit: initialAudit });

    renderDetail(reviewingWorkItem(5), client, 1);
    const refreshing = renderDetail(reviewingWorkItem(5), client, 1);

    expect(getWorkItemAudit).toHaveBeenCalledTimes(2);
    expect(findElement(refreshing, AuditSection)?.props).toMatchObject({ audit: initialAudit });
    expect(findElement(refreshing, StatusTimeline)?.props).toMatchObject({ state: "ready" });
  });

  it("refetches on snapshot revision and updates versionless gate actions without clearing the prior audit", async () => {
    const initialAudit = audit("before-answer");
    const updatedAudit = audit("question-answered");
    let resolveRefresh!: (value: RawWorkItemAudit) => void;
    const refresh = new Promise<RawWorkItemAudit>((resolve) => {
      resolveRefresh = resolve;
    });
    const getWorkItemAudit = vi
      .fn()
      .mockResolvedValueOnce(initialAudit)
      .mockImplementationOnce(() => refresh);
    const client = {
      getPipelineSummary: vi.fn().mockResolvedValue(summary),
      getWorkItemAudit,
    } as unknown as TaskBoardClient;

    renderDetail(reviewingWorkItem(4), client, 20);
    await Promise.resolve();
    await Promise.resolve();
    renderDetail(reviewingWorkItem(4), client, 20);

    renderDetail(reviewingWorkItem(4), client, 21);
    const refreshing = renderDetail(reviewingWorkItem(4), client, 21);
    expect(getWorkItemAudit).toHaveBeenCalledTimes(2);
    expect(findElement(refreshing, AuditSection)?.props).toMatchObject({ audit: initialAudit });
    expect(findElement(refreshing, StatusTimeline)?.props).toMatchObject({ state: "ready" });

    resolveRefresh(updatedAudit);
    await refresh;
    await Promise.resolve();
    const refreshed = renderDetail(reviewingWorkItem(4), client, 21);
    expect(findElement(refreshed, AuditSection)?.props).toMatchObject({ audit: updatedAudit });
  });
});
