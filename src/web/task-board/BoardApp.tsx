import { ArrowLeft, Bell, CircleAlert, CirclePause, FolderKanban, ListTodo, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button, Card, cn } from '../components/ui';
import { markDialogSwitchEvent } from '../components/dialog-stack';
import { AutomationPage } from './views/AutomationPage';
import { emptyAutomationEditorState } from './model/automation-model';
import { BoardApiError, createTaskBoardClient, type BoardNotifications, type TaskBoardClient } from './data/client';
import type { RawBoardNotification, RawBoardPause } from './data/parse';
import { missingRouteFallback, pageToHash } from './routing/routing';
import { useHashRoute } from './routing/useHashRoute';
import { AgentPage, ProjectPage } from './views/WorkspacePages';
import { WorkspaceFrame, type BoardPage } from './views/WorkspaceSidebar';
import { WorkItemDetail } from './views/WorkItemDetail';
import { LedgersPage } from './views/LedgersPage';
import { CREATE_DIALOG_SWITCH_TARGET, CreateDialogs, type DialogName } from './views/CreateDialogs';
import { ActionErrorToasts, EmptyState, FormError, RemovedTaskDetail, TaskRow, WorkItemRow } from './views/TaskList';
import { TaskDetail, taskRunsByCreatedAt } from './views/TaskDetail';
import { actionErrorContexts, actionErrorMessage, errorPipelineReducer, initialErrorPipelineState, isDialogAnchoredActionContext, mutationNetworkError, newestActionErrors, type ActionResult } from './model/action-errors';
import { isExplicitPointOfContact, selectPointOfContact } from './model/workspace-model';
import { BOARD_REFRESH_DEADLINE_MS, BoardRefreshCoordinator, SnapshotCommitCoordinator, refreshTimedOut, type BoardRefreshKind } from './model/refresh-coordinator';
import { createTaskDetailDraftState, taskDetailDraftReducer } from './model/task-detail-drafts';
import { signInFailure } from './model/sign-in-failure';
import { NotificationLoadCoordinator } from './model/notification-load';
import { notificationKindLabel } from './model/work-item-labels';
import { groupWorkItems } from './model/work-item-tree';
import { decompositionFamilyVersionKey } from './model/work-item-detail';
import type { BoardSnapshot, BoardWorkItem, BoardWorkItemDetail, CreateProjectInput, CreateWorkItemInput } from './types';

const notificationDateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

type DialogOpenOptions = Readonly<{
  anchor?: RefObject<HTMLElement | null>;
  projectId?: string;
}>;

type DialogTriggerState = Readonly<{
  name: Exclude<DialogName, null>;
  anchor: RefObject<HTMLElement | null> | null;
  dirty: boolean;
}>;

type DialogTriggerRequest = Readonly<{
  name: Exclude<DialogName, null>;
  anchor: RefObject<HTMLElement | null> | null;
}>;

export type DialogTriggerAction =
  | 'toggle-close'
  | 're-anchor'
  | 'switch-clean'
  | 'switch-dirty';

export function resolveDialogTriggerAction(
  current: DialogTriggerState,
  requested: DialogTriggerRequest,
): DialogTriggerAction {
  if (current.name !== requested.name) {
    return current.dirty ? 'switch-dirty' : 'switch-clean';
  }
  return current.anchor === requested.anchor ? 'toggle-close' : 're-anchor';
}

type PendingDialogAction =
  | Readonly<{ kind: 'open'; name: Exclude<DialogName, null>; options: DialogOpenOptions }>
  | Readonly<{ kind: 'navigate'; page: BoardPage; mode: 'push' | 'replace' }>;

export function NotificationsBlock({
  notifications,
  loading,
  error,
  markingId,
  onMarkRead,
  onOpenWorkItem,
  onRetry,
}: {
  notifications: BoardNotifications | null;
  loading: boolean;
  error: string | null;
  markingId: string | null;
  onMarkRead: (notification: RawBoardNotification) => void;
  onOpenWorkItem: (workItemId: string) => void;
  onRetry: () => void;
}) {
  const unread = notifications?.unread ?? [];
  return (
    <section aria-labelledby="notifications-heading" aria-live="polite">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Bell size={15} className="text-muted" aria-hidden="true" />
          <h2 id="notifications-heading" className="font-display text-lg font-light tracking-[0.01em] text-ink">Notifications</h2>
        </div>
        <span className="text-xs text-muted">{unread.length} unread</span>
      </div>
      {error === null ? null : (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-md border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent" role="alert">
          <span>{error}</span>
          <Button size="sm" onClick={onRetry}>Retry</Button>
        </div>
      )}
      {loading && notifications === null ? (
        <div className="flex min-h-20 items-center justify-center gap-2 rounded-md border border-line bg-muted-surface text-sm text-muted" role="status">
          <RefreshCw size={15} className="animate-spin" /> Loading notifications…
        </div>
      ) : unread.length === 0 ? (
        <p className="rounded-md border border-line bg-muted-surface px-3.5 py-4 text-sm text-muted">No unread notifications.</p>
      ) : (
        <ol className="divide-y divide-line rounded-md border border-line bg-card">
          {unread.map((notification) => {
            const parsed = new Date(notification.createdAt);
            return (
              <li key={notification.notificationId} className="flex flex-col gap-3 px-3.5 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  {notification.workItemId === null ? (
                    <p className="text-sm leading-6 text-ink">{notification.summary}</p>
                  ) : (
                    <button type="button" className="text-left text-sm leading-6 text-ink underline decoration-line underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover" onClick={() => onOpenWorkItem(notification.workItemId!)}>
                      {notification.summary}
                    </button>
                  )}
                  <p className="mt-1 text-[11px] text-muted">
                    {notificationKindLabel[notification.kind]} · <time dateTime={notification.createdAt}>{Number.isNaN(parsed.valueOf()) ? notification.createdAt : notificationDateTime.format(parsed)}</time>
                  </p>
                </div>
                <Button size="sm" disabled={markingId !== null} onClick={() => onMarkRead(notification)}>
                  {markingId === notification.notificationId ? 'Marking…' : 'Mark read'}
                </Button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export async function markNotificationReadAndRefresh(
  client: TaskBoardClient,
  notification: Pick<RawBoardNotification, 'notificationId' | 'version'>,
): Promise<Readonly<{ notifications: BoardNotifications | null; refreshError: string | null }>> {
  await client.markNotificationRead(notification.notificationId, notification.version);
  try {
    return { notifications: await client.getNotifications(), refreshError: null };
  } catch (caught) {
    return {
      notifications: null,
      refreshError: caught instanceof Error
        ? `Marked read, but notifications could not refresh. ${caught.message}`
        : 'Marked read, but notifications could not refresh.',
    };
  }
}

export async function runWorkItemDetailMutation(
  operation: () => Promise<unknown>,
  refresh: () => Promise<boolean>,
): Promise<Readonly<{ actionResult: ActionResult; refreshCommitted: boolean | null }>> {
  try {
    await operation();
    const refreshCommitted = await refresh();
    return { actionResult: { ok: true }, refreshCommitted };
  } catch (caught) {
    if (caught instanceof BoardApiError && (
      caught.code === 'WORK_ITEM_ENDED'
      || caught.code === 'WORK_ITEM_VERSION_CONFLICT'
      || caught.code === 'PLAN_NOT_PROPOSED'
      || caught.code === 'WORK_ITEM_ILLEGAL_TRANSITION'
    )) {
      await refresh();
    }
    return { actionResult: { ok: false, error: actionErrorMessage(caught) }, refreshCommitted: null };
  }
}

export function BoardPauseBanner({ boardPause }: { boardPause: RawBoardPause | null }) {
  if (boardPause?.paused !== true) return null;
  return (
    <div className="border-b border-caution-border bg-caution-soft px-4 py-3 text-caution sm:px-8 lg:px-12" role="status" aria-live="polite">
      <div className="flex items-start gap-2.5">
        <CirclePause className="mt-0.5 shrink-0" size={16} aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold">Board paused</p>
          <p className="mt-0.5 text-xs leading-5">{boardPause.reason ?? 'No reason was provided.'}</p>
        </div>
      </div>
    </div>
  );
}

export async function changeBoardPause(
  client: TaskBoardClient,
  boardPause: RawBoardPause,
  reason: string | null,
): Promise<RawBoardPause | null> {
  if (boardPause.paused) return client.resumeBoard({ version: boardPause.version });
  if (reason === null) return null;
  const trimmedReason = reason.slice(0, 500).trim();
  return client.setBoardPause({
    reason: trimmedReason.length === 0 ? null : trimmedReason,
    version: boardPause.version,
  });
}

export function pausePopoverShouldClose(boardPause: RawBoardPause | null): boolean {
  return boardPause === null || boardPause.paused;
}

/** Keeps delayed reads from replacing a newer pause mutation response. */
export class BoardPauseVersionGuard {
  #latestVersion: number | null = null;

  accept(next: RawBoardPause): boolean {
    if (this.#latestVersion !== null && next.version < this.#latestVersion) return false;
    this.#latestVersion = next.version;
    return true;
  }
}

export type WorkItemDetailLoadResult =
  | Readonly<{ kind: 'loaded'; detail: BoardWorkItemDetail }>
  | Readonly<{ kind: 'not-found' }>
  | Readonly<{ kind: 'failed'; error: unknown }>
  | Readonly<{ kind: 'stale' }>;

/** Aborts superseded detail reads and rejects responses from older navigation intents. */
export class WorkItemDetailLoadCoordinator {
  #generation = 0;
  #controller: AbortController | null = null;

  async load(
    workItemId: string,
    read: (signal: AbortSignal) => Promise<BoardWorkItemDetail>,
  ): Promise<WorkItemDetailLoadResult> {
    this.#controller?.abort();
    const controller = new AbortController();
    const generation = ++this.#generation;
    this.#controller = controller;
    try {
      const detail = await read(controller.signal);
      if (!this.#isCurrent(generation, controller)) return { kind: 'stale' };
      if (detail.id !== workItemId) return { kind: 'failed', error: new Error('The loaded work item did not match the requested child.') };
      return { kind: 'loaded', detail };
    } catch (caught) {
      if (!this.#isCurrent(generation, controller)) return { kind: 'stale' };
      if (caught instanceof BoardApiError && caught.status === 404) return { kind: 'not-found' };
      return { kind: 'failed', error: caught };
    }
  }

  invalidate(): void {
    this.#generation += 1;
    this.#controller?.abort();
    this.#controller = null;
  }

  #isCurrent(generation: number, controller: AbortController): boolean {
    return generation === this.#generation && controller === this.#controller && !controller.signal.aborted;
  }
}

export function snapshotLostSelectedWorkItem(
  workItemId: string,
  previous: readonly Pick<BoardWorkItem, 'id'>[],
  current: readonly Pick<BoardWorkItem, 'id'>[],
): boolean {
  return previous.some((workItem) => workItem.id === workItemId)
    && !current.some((workItem) => workItem.id === workItemId);
}

export async function refreshBoardSnapshot(
  client: TaskBoardClient,
  kind: BoardRefreshKind,
  signal: AbortSignal,
  commitSnapshot: (next: BoardSnapshot, signal: AbortSignal) => Promise<boolean>,
  updateBoardPause: (next: RawBoardPause | null) => void,
): Promise<Readonly<{
  snapshot: BoardSnapshot;
  committed: boolean;
  pauseLoad: Promise<void>;
}>> {
  const pauseLoad = client.getBoardPause(signal).then(
    (next) => {
      if (!signal.aborted) updateBoardPause(next);
    },
    () => {
      if (!signal.aborted || refreshTimedOut(signal)) updateBoardPause(null);
    },
  );
  const snapshot = await client.getSnapshot(signal, kind);
  const committed = await commitSnapshot(snapshot, signal);
  return { snapshot, committed, pauseLoad };
}

export function BoardApp() {
  const client = useMemo<TaskBoardClient>(() => createTaskBoardClient({ baseUrl: '/board-api' }), []);
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [page, navigateRoute] = useHashRoute();
  const routedTaskId = page.kind === 'tasks' ? page.taskId : undefined;
  const [taskDetailDrafts, dispatchTaskDetailDraft] = useReducer(
    taskDetailDraftReducer,
    routedTaskId ?? '',
    createTaskDetailDraftState,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [dialogProjectId, setDialogProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorPipeline, dispatchErrorPipeline] = useReducer(errorPipelineReducer, initialErrorPipelineState);
  const [connectivityError, setConnectivityError] = useState<string | null>(null);
  const [signInExpired, setSignInExpired] = useState(false);
  const [automationEditorState, setAutomationEditorState] = useState(emptyAutomationEditorState);
  const [notifications, setNotifications] = useState<BoardNotifications | null>(null);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const [markingNotificationId, setMarkingNotificationId] = useState<string | null>(null);
  const [notificationsAttempt, setNotificationsAttempt] = useState(0);
  const [familyRefreshRevision, setFamilyRefreshRevision] = useState(0);
  const [loadedWorkItemDetail, setLoadedWorkItemDetail] = useState<BoardWorkItemDetail | null>(null);
  const [workItemDetailLoadingId, setWorkItemDetailLoadingId] = useState<string | null>(null);
  const [boardPause, setBoardPause] = useState<RawBoardPause | null>(null);
  const [pausePopoverOpen, setPausePopoverOpen] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseControlError, setPauseControlError] = useState<string | null>(null);
  const notificationLoads = useMemo(() => new NotificationLoadCoordinator(), []);
  const snapshotCommits = useMemo(() => new SnapshotCommitCoordinator<BoardSnapshot>(), []);
  const pauseVersions = useMemo(() => new BoardPauseVersionGuard(), []);
  const workItemDetailLoads = useMemo(() => new WorkItemDetailLoadCoordinator(), []);
  const observedTaskIds = useRef(new Set<string>());
  const previousSnapshotWorkItems = useRef<readonly BoardWorkItem[]>([]);
  const currentPageRef = useRef(page);
  const currentSnapshotRef = useRef(snapshot);
  const workItemDetailLoadSourceHash = useRef<string | null>(null);
  const workItemRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const taskRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastOpenWorkItemId = useRef<string | null>(null);
  const lastOpenTaskId = useRef<string | null>(null);
  const workItemDetailWasOpen = useRef(false);
  const taskDetailWasOpen = useRef(false);
  const projectFormDirty = useRef(false);
  const workItemFormDirty = useRef(false);
  const pendingDialogActionRef = useRef<PendingDialogAction | null>(null);
  const projectDialogRequestCloseRef = useRef<(() => void) | null>(null);
  const taskDialogRequestCloseRef = useRef<(() => void) | null>(null);
  const headerAddTaskRef = useRef<HTMLButtonElement>(null);
  const emptyStateAddTaskRef = useRef<HTMLButtonElement>(null);
  const fallbackTaskDialogAnchorRef = useRef<HTMLElement>(null);
  const [taskDialogAnchorRef, setTaskDialogAnchorRef] = useState<RefObject<HTMLElement | null>>(
    fallbackTaskDialogAnchorRef,
  );
  const connected = snapshot !== null && !errorPipeline.connectivityDown;
  currentPageRef.current = page;
  currentSnapshotRef.current = snapshot;

  const loadNotifications = useCallback(async (token: number, afterMarkRead = false) => {
    setNotificationsLoading(true);
    try {
      const next = await client.getNotifications();
      if (!notificationLoads.isLatest(token)) return;
      setNotifications(next);
      setNotificationsError(null);
    } catch (caught) {
      if (!notificationLoads.isLatest(token)) return;
      setNotificationsError(afterMarkRead
        ? caught instanceof Error
          ? `Marked read, but notifications could not refresh. ${caught.message}`
          : 'Marked read, but notifications could not refresh.'
        : caught instanceof Error ? caught.message : 'Notifications could not be loaded.');
    } finally {
      if (notificationLoads.isLatest(token)) setNotificationsLoading(false);
    }
  }, [client, notificationLoads]);

  const commitSnapshot = useCallback((next: BoardSnapshot, signal: AbortSignal): Promise<boolean> => {
    return snapshotCommits.commit(next, signal, setSnapshot);
  }, [snapshotCommits]);

  const updateBoardPause = useCallback((next: RawBoardPause | null) => {
    if (next === null) {
      setBoardPause(null);
      return;
    }
    if (pauseVersions.accept(next)) setBoardPause(next);
  }, [pauseVersions]);

  useLayoutEffect(() => {
    if (snapshot !== null) snapshotCommits.acknowledge(snapshot);
  }, [snapshot, snapshotCommits]);

  useLayoutEffect(() => () => {
    snapshotCommits.drain();
  }, [snapshotCommits]);

  useEffect(() => () => workItemDetailLoads.invalidate(), [workItemDetailLoads]);

  useEffect(() => {
    if (workItemDetailLoadingId === null || workItemDetailLoadSourceHash.current === pageToHash(page)) return;
    workItemDetailLoads.invalidate();
    workItemDetailLoadSourceHash.current = null;
    setWorkItemDetailLoadingId(null);
  }, [page, workItemDetailLoadingId, workItemDetailLoads]);

  useEffect(() => {
    notificationLoads.activate();
    return () => notificationLoads.deactivate();
  }, [notificationLoads]);

  useEffect(() => {
    if (pausePopoverShouldClose(boardPause)) setPausePopoverOpen(false);
  }, [boardPause]);

  const performRefresh = useCallback(async (kind: BoardRefreshKind, signal: AbortSignal): Promise<boolean> => {
    try {
      const refreshResult = await refreshBoardSnapshot(
        client,
        kind,
        signal,
        commitSnapshot,
        updateBoardPause,
      );
      const next = refreshResult.snapshot;
      if (!refreshResult.committed) {
        if (refreshTimedOut(signal)) throw signal.reason;
        return false;
      }
      for (const task of next.tasks) observedTaskIds.current.add(task.id);
      dispatchErrorPipeline({ type: 'snapshot-succeeded' });
      setConnectivityError(null);
      setSignInExpired(false);
      return true;
    } catch (caught) {
      const timedOut = refreshTimedOut(signal);
      if (signal.aborted && !timedOut) return false;
      dispatchErrorPipeline({ type: 'snapshot-failed' });
      const signIn = signInFailure(caught);
      setSignInExpired(signIn?.canRetrySignIn ?? false);
      setConnectivityError(timedOut
        ? `The board did not respond within ${BOARD_REFRESH_DEADLINE_MS / 1_000} seconds`
        : signIn?.message ?? (caught instanceof Error ? caught.message : 'Could not connect to the task board'));
      return false;
    }
  }, [client, commitSnapshot, updateBoardPause]);

  const refreshCoordinator = useMemo(() => new BoardRefreshCoordinator(performRefresh, {
    onForegroundLoadingChange: setLoading,
  }), [performRefresh]);
  const refresh = useCallback((kind: BoardRefreshKind = 'foreground') => (
    refreshCoordinator.refresh(kind)
  ), [refreshCoordinator]);
  const refreshManually = useCallback(() => {
    setFamilyRefreshRevision((value) => value + 1);
    return refresh('foreground');
  }, [refresh]);

  useEffect(() => {
    refreshCoordinator.activate();
    setSnapshot(null);
    void refresh('foreground');
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh('poll');
    }, 5_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh('poll');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      refreshCoordinator.dispose();
    };
  }, [refresh, refreshCoordinator]);

  useEffect(() => {
    if (snapshot === null) return;
    const previous = previousSnapshotWorkItems.current;
    previousSnapshotWorkItems.current = snapshot.workItems;
    if (page.kind === 'intake' && snapshotLostSelectedWorkItem(page.workItemId, previous, snapshot.workItems)) {
      setLoadedWorkItemDetail((current) => current?.id === page.workItemId ? null : current);
      void refreshRemovedWorkItemDetail(page.workItemId);
    }
  }, [page, snapshot]);

  useEffect(() => {
    if (snapshot === null) return;
    if (page.kind === 'intake' && loadedWorkItemDetail?.id === page.workItemId) return;
    if (page.kind === 'intake' && workItemDetailLoadingId === page.workItemId) return;
    const fallback = missingRouteFallback(page, snapshot, observedTaskIds.current);
    if (fallback !== null) navigate(fallback, 'replace');
  }, [loadedWorkItemDetail, page, snapshot, workItemDetailLoadingId]);

  useEffect(() => {
    if (snapshot === null) return;
    void notificationLoads.snapshotArrived(snapshot, (token) => loadNotifications(token));
  }, [loadNotifications, notificationLoads, notificationsAttempt, snapshot]);

  const mutate = useCallback(async (context: string, operation: () => Promise<unknown>): Promise<ActionResult> => {
    dispatchErrorPipeline({ type: 'action-started', context });
    if (!connected) {
      dispatchErrorPipeline({ type: 'action-failed', context, error: mutationNetworkError });
      return { ok: false, error: mutationNetworkError };
    }
    setBusy(true);
    try {
      await operation();
      const refreshCommitted = await refresh('mutation');
      dispatchErrorPipeline({ type: 'action-succeeded', refreshCommitted });
      return { ok: true };
    } catch (caught) {
      const error = actionErrorMessage(caught);
      dispatchErrorPipeline({ type: 'action-failed', context, error });
      return { ok: false, error };
    } finally {
      setBusy(false);
    }
  }, [connected, refresh]);

  const mutateWorkItemDetail = useCallback(async (operation: () => Promise<unknown>): Promise<ActionResult> => {
    if (!connected) return { ok: false, error: mutationNetworkError };
    setBusy(true);
    try {
      const mutation = await runWorkItemDetailMutation(operation, () => refresh('mutation'));
      if (mutation.actionResult.ok) {
        dispatchErrorPipeline({ type: 'action-succeeded', refreshCommitted: mutation.refreshCommitted ?? false });
      }
      return mutation.actionResult;
    } finally {
      setBusy(false);
    }
  }, [connected, refresh]);

  const mutateTaskDetail = useCallback(async (operation: () => Promise<unknown>): Promise<ActionResult> => {
    if (!connected) return { ok: false, error: mutationNetworkError };
    setBusy(true);
    try {
      await operation();
      const refreshCommitted = await refresh('mutation');
      dispatchErrorPipeline({ type: 'action-succeeded', refreshCommitted });
      return { ok: true };
    } catch (caught) {
      if (caught instanceof BoardApiError && (
        caught.code === 'TASK_TERMINAL'
        || caught.code === 'TASK_VERSION_CONFLICT'
        || caught.code === 'WORK_NODE_VERSION_CONFLICT'
      )) {
        await refresh('mutation');
      }
      return { ok: false, error: actionErrorMessage(caught) };
    } finally {
      setBusy(false);
    }
  }, [connected, refresh]);

  const allTasks = useMemo(() => [...(snapshot?.tasks ?? [])].sort((left, right) => left.orderKey - right.orderKey || left.id.localeCompare(right.id)), [snapshot]);
  const allWorkItems = snapshot?.workItems ?? [];
  const groupedWorkItems = useMemo(() => groupWorkItems(allWorkItems), [allWorkItems]);
  const snapshotSelectedWorkItem = page.kind === 'intake' ? allWorkItems.find((workItem) => workItem.id === page.workItemId) : undefined;
  const cachedSelectionWasRemoved = page.kind === 'intake'
    && snapshotSelectedWorkItem === undefined
    && loadedWorkItemDetail?.id === page.workItemId
    && snapshotLostSelectedWorkItem(page.workItemId, previousSnapshotWorkItems.current, allWorkItems);
  const selectedWorkItem = snapshotSelectedWorkItem
    ?? (page.kind === 'intake' && loadedWorkItemDetail?.id === page.workItemId && !cachedSelectionWasRemoved ? loadedWorkItemDetail : undefined);
  const workItemDetailOpen = selectedWorkItem !== undefined;
  const selectedTaskId = routedTaskId;
  const taskDetailOpen = selectedTaskId !== undefined;
  const anyDetailOpen = taskDetailOpen || workItemDetailOpen;
  const activeTasks = allTasks.filter((task) => task.status !== 'completed');
  const completedTasks = allTasks.filter((task) => task.status === 'completed');
  const selectedTask = allTasks.find((task) => task.id === selectedTaskId);
  const selectedTaskAgents = snapshot?.agents.filter((agent) => agent.projectId === selectedTask?.projectId) ?? [];
  const taskQuestions = snapshot?.questions.filter((question) => question.taskId === selectedTask?.id) ?? [];
  const taskRuns = taskRunsByCreatedAt(snapshot?.runs.filter((run) => run.taskId === selectedTask?.id) ?? []);
  const openQuestionIds = new Set(snapshot?.questions.filter((question) => question.status === 'open').map((question) => question.taskId));
  const pointOfContact = selectPointOfContact(snapshot?.agents ?? []);
  const pageProject = page.kind === 'project' ? snapshot?.projects.find((project) => project.id === page.projectId) : undefined;
  const pageAgent = page.kind === 'agent' ? snapshot?.agents.find((agent) => agent.id === page.agentId) : undefined;
  const dialogProject = snapshot?.projects.find((project) => project.id === dialogProjectId);
  const projectCreateErrors = errorPipeline.actionErrors.filter((entry) => entry.context === actionErrorContexts.projectCreate);
  const workItemCreateErrors = errorPipeline.actionErrors.filter((entry) => entry.context === actionErrorContexts.workItemCreate);
  const tokenRotationErrors = pageAgent === undefined
    ? []
    : errorPipeline.actionErrors.filter((entry) => entry.context === actionErrorContexts.agentRotateToken(pageAgent.id));
  const unanchoredActionErrors = newestActionErrors(
    errorPipeline.actionErrors.filter((entry) => !isDialogAnchoredActionContext(entry.context)),
  );

  function dismissActionError(context: string) {
    dispatchErrorPipeline({ type: 'action-dismissed', context });
  }

  useEffect(() => {
    dispatchTaskDetailDraft({ type: 'task-synced', taskId: selectedTaskId ?? '' });
  }, [selectedTaskId]);

  useEffect(() => {
    const belowXl = typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 1279px)').matches;
    if (workItemDetailOpen && selectedWorkItem) {
      lastOpenWorkItemId.current = selectedWorkItem.id;
    } else if (workItemDetailWasOpen.current && belowXl) {
      const workItemId = lastOpenWorkItemId.current;
      window.requestAnimationFrame(() => {
        if (workItemId) workItemRowRefs.current.get(workItemId)?.focus();
      });
    }
    workItemDetailWasOpen.current = workItemDetailOpen;
  }, [selectedWorkItem, workItemDetailOpen]);

  useEffect(() => {
    const belowXl = typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 1279px)').matches;
    if (taskDetailOpen && selectedTaskId) {
      lastOpenTaskId.current = selectedTaskId;
    } else if (taskDetailWasOpen.current && belowXl) {
      const taskId = lastOpenTaskId.current;
      window.requestAnimationFrame(() => {
        const taskRow = taskId ? taskRowRefs.current.get(taskId) : undefined;
        if (taskRow?.isConnected) {
          taskRow.focus();
          return;
        }
        document.querySelector<HTMLElement>('[data-page-heading]')?.focus();
      });
    }
    taskDetailWasOpen.current = taskDetailOpen;
  }, [selectedTaskId, taskDetailOpen]);

  function openTask(taskId: string) {
    // Eager reset: the hoisted single-slot draft reducer would otherwise
    // paint the previous task's draft for one frame on direct A->B clicks
    // (the corrective effect runs post-commit).
    dispatchTaskDetailDraft({ type: 'task-synced', taskId });
    navigate({ kind: 'tasks', taskId });
  }

  function openWorkItem(workItemId: string) {
    setLoadedWorkItemDetail(null);
    navigate({ kind: 'intake', workItemId });
  }

  async function refreshRemovedWorkItemDetail(workItemId: string) {
    const sourceHash = pageToHash(currentPageRef.current);
    workItemDetailLoadSourceHash.current = sourceHash;
    setWorkItemDetailLoadingId(workItemId);
    const result = await workItemDetailLoads.load(
      workItemId,
      (signal) => client.getWorkItem(workItemId, signal),
    );
    if (result.kind === 'stale') return;
    if (pageToHash(currentPageRef.current) !== sourceHash) return;
    workItemDetailLoadSourceHash.current = null;
    setWorkItemDetailLoadingId(null);
    if (result.kind === 'loaded') {
      setLoadedWorkItemDetail(result.detail);
      return;
    }
    const context = `work-item:${encodeURIComponent(workItemId)}:open-detail`;
    if (result.kind === 'failed') {
      dispatchErrorPipeline({ type: 'action-failed', context, error: actionErrorMessage(result.error) });
      return;
    }
    const currentSnapshot = currentSnapshotRef.current;
    if (currentSnapshot === null) return;
    const fallback = missingRouteFallback(currentPageRef.current, currentSnapshot, observedTaskIds.current);
    if (fallback !== null) navigate(fallback, 'replace');
  }

  async function openWorkItemFromFamily(workItemId: string) {
    const context = `work-item:${encodeURIComponent(workItemId)}:open-detail`;
    const sourceHash = pageToHash(currentPageRef.current);
    dispatchErrorPipeline({ type: 'action-started', context });
    workItemDetailLoadSourceHash.current = sourceHash;
    setWorkItemDetailLoadingId(workItemId);
    const result = await workItemDetailLoads.load(
      workItemId,
      (signal) => client.getWorkItem(workItemId, signal),
    );
    if (result.kind === 'stale') return;
    if (pageToHash(currentPageRef.current) !== sourceHash) return;
    workItemDetailLoadSourceHash.current = null;
    setWorkItemDetailLoadingId(null);
    if (result.kind === 'loaded') {
      setLoadedWorkItemDetail(result.detail);
      navigate({ kind: 'intake', workItemId });
      return;
    }
    dispatchErrorPipeline({
      type: 'action-failed',
      context,
      error: result.kind === 'not-found'
        ? 'This work item is no longer available.'
        : actionErrorMessage(result.error),
    });
  }

  async function markNotificationRead(notification: RawBoardNotification) {
    if (markingNotificationId !== null) return;
    const previous = notifications;
    notificationLoads.invalidate();
    setMarkingNotificationId(notification.notificationId);
    setNotificationsLoading(false);
    setNotificationsError(null);
    setNotifications((current) => current === null ? current : {
      ...current,
      unread: current.unread.filter((entry) => entry.notificationId !== notification.notificationId),
    });
    try {
      await client.markNotificationRead(notification.notificationId, notification.version);
      await notificationLoads.refresh((token) => loadNotifications(token, true));
    } catch (caught) {
      setNotifications(previous);
      setNotificationsError(caught instanceof Error ? caught.message : 'The notification could not be marked read.');
    } finally {
      setMarkingNotificationId(null);
    }
  }

  function closeWorkItem() {
    navigate({ kind: 'tasks' }, 'replace');
  }

  function closeTask() {
    navigate({ kind: 'tasks' }, 'replace');
  }

  function showDialog(name: Exclude<DialogName, null>, options: DialogOpenOptions = {}) {
    dismissActionError(name === 'project'
      ? actionErrorContexts.projectCreate
      : actionErrorContexts.workItemCreate);
    setDialogProjectId(options.projectId ?? null);
    setTaskDialogAnchorRef(name === 'task'
      ? options.anchor ?? fallbackTaskDialogAnchorRef
      : fallbackTaskDialogAnchorRef);
    if (name === 'project') projectFormDirty.current = false;
    else workItemFormDirty.current = false;
    setDialog(name);
  }

  function requestCurrentDialogClose() {
    const requestClose = dialog === 'project'
      ? projectDialogRequestCloseRef.current
      : dialog === 'task'
        ? taskDialogRequestCloseRef.current
        : null;
    requestClose?.();
  }

  function openDialog(
    name: Exclude<DialogName, null>,
    options: DialogOpenOptions = {},
    event?: Event,
  ) {
    markDialogSwitchEvent(event, CREATE_DIALOG_SWITCH_TARGET);
    if (dialog === null) {
      showDialog(name, options);
      return;
    }

    const requestedAnchor = name === 'task'
      ? options.anchor ?? fallbackTaskDialogAnchorRef
      : null;
    const action = resolveDialogTriggerAction({
      name: dialog,
      anchor: dialog === 'task' ? taskDialogAnchorRef : null,
      dirty: dialog === 'project' ? projectFormDirty.current : workItemFormDirty.current,
    }, { name, anchor: requestedAnchor });

    /*
     * Trigger decision table while a dialog is open:
     *
     * | Request                              | Clean                                 | Dirty                                      |
     * | ------------------------------------ | ------------------------------------- | ------------------------------------------ |
     * | Same dialog, same anchor             | toggle-close through guard            | toggle-close; guard asks before discard    |
     * | Same dialog, different anchor        | re-anchor; keep mounted                | re-anchor; preserve draft and dirty state  |
     * | Different dialog                     | switch once via pending open           | guard; Keep cancels, Discard opens pending |
     * | Navigation (handled by `navigate`)   | close, then navigate                   | guard; Keep cancels, Discard navigates     |
     */
    switch (action) {
      case 'toggle-close':
        requestCurrentDialogClose();
        return;
      case 're-anchor':
        if (name === 'task') setTaskDialogAnchorRef(requestedAnchor ?? fallbackTaskDialogAnchorRef);
        return;
      case 'switch-clean':
      case 'switch-dirty':
        pendingDialogActionRef.current = { kind: 'open', name, options };
        requestCurrentDialogClose();
    }
  }

  function navigate(next: BoardPage, mode: 'push' | 'replace' = 'push', event?: Event) {
    workItemDetailLoads.invalidate();
    workItemDetailLoadSourceHash.current = null;
    setWorkItemDetailLoadingId(null);
    markDialogSwitchEvent(event, CREATE_DIALOG_SWITCH_TARGET);
    if (dialog === null) {
      navigateRoute(next, mode);
      return;
    }
    pendingDialogActionRef.current = { kind: 'navigate', page: next, mode };
    requestCurrentDialogClose();
  }

  function closeDialog({ continuePendingAction = true }: { continuePendingAction?: boolean } = {}) {
    if (dialog === 'project') dismissActionError(actionErrorContexts.projectCreate);
    if (dialog === 'task') dismissActionError(actionErrorContexts.workItemCreate);
    projectFormDirty.current = false;
    workItemFormDirty.current = false;
    const pendingAction = pendingDialogActionRef.current;
    pendingDialogActionRef.current = null;
    if (!continuePendingAction) {
      setDialog(null);
      return;
    }
    if (pendingAction?.kind === 'open') {
      showDialog(pendingAction.name, pendingAction.options);
      return;
    }
    setDialog(null);
    if (pendingAction?.kind === 'navigate') {
      navigateRoute(pendingAction.page, pendingAction.mode);
    }
  }

  function keepEditingDialog() {
    pendingDialogActionRef.current = null;
  }

  async function createProject(input: CreateProjectInput): Promise<ActionResult> {
    const result = await mutate(actionErrorContexts.projectCreate, () => client.createProject(input));
    if (result.ok) {
      closeDialog({ continuePendingAction: false });
    }
    return result;
  }

  async function createWorkItem(input: CreateWorkItemInput): Promise<ActionResult> {
    const result = await mutate(actionErrorContexts.workItemCreate, () => client.createWorkItem(input));
    if (result.ok) {
      closeDialog({ continuePendingAction: false });
    }
    return result;
  }

  function openPausePopover() {
    if (boardPause === null || boardPause.paused || pauseBusy) return;
    setPauseControlError(null);
    setPausePopoverOpen(true);
  }

  function closePausePopover() {
    setPausePopoverOpen(false);
    setPauseControlError(null);
  }

  async function confirmPause(reason: string | null) {
    if (!connected || boardPause === null || boardPause.paused || pauseBusy) return;
    setPauseBusy(true);
    setPauseControlError(null);
    try {
      const next = await changeBoardPause(client, boardPause, reason);
      if (next !== null) {
        updateBoardPause(next);
        setPausePopoverOpen(false);
      }
    } catch (caught) {
      setPauseControlError(caught instanceof Error ? caught.message : 'The board pause state could not be changed.');
    } finally {
      setPauseBusy(false);
    }
  }

  async function resumeBoard() {
    if (boardPause === null || !boardPause.paused || pauseBusy) return;
    setPauseBusy(true);
    setPauseControlError(null);
    try {
      const next = await changeBoardPause(client, boardPause, null);
      if (next !== null) updateBoardPause(next);
    } catch (caught) {
      setPauseControlError(caught instanceof Error ? caught.message : 'The board pause state could not be changed.');
      try {
        updateBoardPause(await client.getBoardPause());
      } catch {
        // Keep the last authoritative state visible with the mutation error.
      }
    } finally {
      setPauseBusy(false);
    }
  }

  let content: ReactNode;
  if (loading && snapshot === null) {
    content = <main className="p-4 sm:px-8 sm:py-6 lg:px-12 lg:py-8"><Card><EmptyState icon={<RefreshCw className="animate-spin" size={20} />} title="Locating your agents" body="Reading durable projects, tasks, questions, and progress from the task board." /></Card></main>;
  } else if (snapshot === null) {
    content = <main className="p-4 sm:px-8 sm:py-6 lg:px-12 lg:py-8"><Card><EmptyState
      icon={<CircleAlert size={20} />}
      title={signInExpired ? 'Your sign-in has expired' : 'Board service unreachable'}
      body={signInExpired
        ? 'Signing in again reloads this page through the identity provider and brings you straight back.'
        : 'The task board service could not be reached. No local demo data is shown.'}
      action={signInExpired ? <Button variant="primary" onClick={() => globalThis.location.reload()}>Sign in again</Button> : undefined}
    /></Card></main>;
  } else if (page.kind === 'automation') {
    content = <AutomationPage client={client} connected={connected} editorState={automationEditorState} onEditorStateChange={setAutomationEditorState} />;
  } else if (page.kind === 'ledgers') {
    content = <LedgersPage client={client} connected={connected} snapshotRevision={snapshot.revision} />;
  } else if (page.kind === 'project' && pageProject) {
    content = <ProjectPage key={pageProject.id} project={pageProject} snapshot={snapshot} client={client} connected={connected} onTask={openTask} onAddTask={(anchor, event) => openDialog('task', { anchor, projectId: pageProject.id }, event)} />;
  } else if (page.kind === 'agent' && pageAgent) {
    content = <AgentPage key={pageAgent.id} agent={pageAgent} snapshot={snapshot} isPointOfContact={pageAgent.id === pointOfContact?.id} explicitPointOfContact={pageAgent.id === pointOfContact?.id && isExplicitPointOfContact(pageAgent)} busy={busy || !connected} rotationErrors={tokenRotationErrors} onDismissActionError={dismissActionError} onTask={openTask} onSend={(prompt, workspaceRefs, routingContext, recentConversation) => mutate(actionErrorContexts.agentSend(pageAgent.id), () => client.createAgentQuery({ projectId: pageAgent.projectId, agentId: pageAgent.id, assignedRole: pageAgent.role, prompt, workspaceRefs, routingContext, recentConversation }))} onAnswer={(questionId, answer) => mutate(actionErrorContexts.questionAnswer(questionId), () => client.answerQuestion(questionId, { answer }))} onRotateToken={async () => {
      let rotated: Awaited<ReturnType<TaskBoardClient['rotateAgentToken']>> | null = null;
      const result = await mutate(actionErrorContexts.agentRotateToken(pageAgent.id), async () => {
        rotated = await client.rotateAgentToken(pageAgent.id, { version: pageAgent.version });
      });
      return result.ok ? rotated : null;
    }} />;
  } else {
    content = (
      <>
        <header className={cn('grid-cols-[minmax(0,1fr)_auto] items-start gap-4 border-b border-line bg-canvas px-4 py-5 sm:px-8 lg:items-center lg:px-12 lg:py-8', anyDetailOpen ? 'hidden xl:grid' : 'grid')}>
          <div><h1 data-page-heading tabIndex={-1} className="font-display text-2xl font-light tracking-[0.02em] sm:text-[28px]">Task List</h1><p className="mt-1.5 text-sm font-light text-muted">New requests enter durable intake for refinement and planning.</p></div>
          <div className="flex flex-wrap gap-2.5" role="group" aria-label="Task list actions">
            <Button ref={headerAddTaskRef} data-dialog-trigger="task" className="size-11 min-h-0 rounded-[99px] p-0 sm:size-10" size="sm" variant="primary" icon={<Plus size={18} strokeWidth={1.6} />} aria-label="Add task" title="Add task" disabled={!connected} onClick={(event) => openDialog('task', { anchor: headerAddTaskRef }, event.nativeEvent)} />
            <Button className="size-11 min-h-0 rounded-[99px] p-0 sm:size-10" size="sm" icon={<FolderKanban size={17} strokeWidth={1.5} />} aria-label="Add project" title="Add project from disk" disabled={!connected} onClick={(event) => openDialog('project', {}, event.nativeEvent)} />
            {anyDetailOpen ? <Button className="size-11 min-h-0 rounded-[99px] p-0 sm:size-10" size="sm" icon={<RefreshCw size={17} strokeWidth={1.5} className={loading ? 'animate-spin' : ''} />} aria-label="Refresh" title="Refresh" disabled={loading} onClick={() => void refreshManually()} /> : null}
          </div>
        </header>
        <main className="w-full max-w-[1600px] p-4 sm:px-8 sm:py-6 lg:px-12 lg:py-8">
          <div className={cn('grid items-start gap-8', anyDetailOpen ? 'xl:grid-cols-[minmax(360px,.92fr)_minmax(420px,1.08fr)] xl:gap-10' : 'max-w-5xl')}>
            <div className={cn('min-w-0', anyDetailOpen ? 'hidden xl:block' : 'block')}>
              <div className="space-y-8">
                <NotificationsBlock
                  notifications={notifications}
                  loading={notificationsLoading}
                  error={notificationsError}
                  markingId={markingNotificationId}
                  onMarkRead={(notification) => { void markNotificationRead(notification); }}
                  onOpenWorkItem={openWorkItem}
                  onRetry={() => setNotificationsAttempt((value) => value + 1)}
                />
                {allWorkItems.length > 0 ? (
                  <section aria-labelledby="automation-intake-heading">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h2 id="automation-intake-heading" className="font-display text-lg font-light tracking-[0.01em] text-ink">Automation intake</h2>
                      <span className="text-xs text-muted">{allWorkItems.length}</span>
                    </div>
                    <div>{groupedWorkItems.map((row) => <WorkItemRow
                      key={row.workItem.id}
                      workItem={row.workItem}
                      projects={snapshot.projects}
                      depth={row.depth}
                      childCount={row.childCount}
                      mergedChildCount={row.mergedChildCount}
                      abandonedChildCount={row.abandonedChildCount}
                      dependencyHint={row.dependencyHint}
                      selected={workItemDetailOpen && row.workItem.id === selectedWorkItem.id}
                      onSelect={() => openWorkItem(row.workItem.id)}
                      buttonRef={(element) => {
                        if (element) workItemRowRefs.current.set(row.workItem.id, element);
                        else workItemRowRefs.current.delete(row.workItem.id);
                      }}
                    />)}</div>
                  </section>
                ) : null}
                {allTasks.length > 0 ? (
                  <>
                    <section aria-labelledby="active-work-heading">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <h2 id="active-work-heading" className="font-display text-lg font-light tracking-[0.01em] text-ink">Board tasks</h2>
                        <span className="text-xs text-muted">{activeTasks.length}</span>
                      </div>
                      <div>{activeTasks.length > 0 ? activeTasks.map((task) => <TaskRow
                        key={task.id}
                        task={task}
                        selected={taskDetailOpen && task.id === selectedTaskId}
                        agent={snapshot.agents.find((agent) => agent.id === task.assignedAgentId)}
                        projectName={snapshot.projects.find((project) => project.id === task.projectId)?.name}
                        openQuestion={openQuestionIds.has(task.id)}
                        onSelect={() => openTask(task.id)}
                        buttonRef={(element) => {
                          if (element) taskRowRefs.current.set(task.id, element);
                          else taskRowRefs.current.delete(task.id);
                        }}
                      />) : <p className="border-b border-line px-1 py-5 text-sm text-muted">No active board tasks.</p>}</div>
                    </section>
                  {completedTasks.length > 0 ? (
                    <section aria-labelledby="completed-work-heading">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <h2 id="completed-work-heading" className="font-display text-lg font-light tracking-[0.01em] text-ink">Completed board tasks</h2>
                        <span className="text-xs text-muted">{completedTasks.length}</span>
                      </div>
                      <div>{completedTasks.map((task) => <TaskRow
                        key={task.id}
                        task={task}
                        selected={taskDetailOpen && task.id === selectedTaskId}
                        agent={snapshot.agents.find((agent) => agent.id === task.assignedAgentId)}
                        projectName={snapshot.projects.find((project) => project.id === task.projectId)?.name}
                        openQuestion={openQuestionIds.has(task.id)}
                        onSelect={() => openTask(task.id)}
                        buttonRef={(element) => {
                          if (element) taskRowRefs.current.set(task.id, element);
                          else taskRowRefs.current.delete(task.id);
                        }}
                      />)}</div>
                    </section>
                  ) : null}
                  </>
                ) : null}
                {allWorkItems.length === 0 && allTasks.length === 0 ? snapshot.projects.length === 0
                  ? <EmptyState icon={<FolderKanban size={19} />} title="Start with a project" body="Add a project folder first. Agents arrive on demand for that project; then submit work." action={<Button size="sm" variant="primary" disabled={!connected} onClick={(event) => openDialog('project', {}, event.nativeEvent)}>Add project</Button>} />
                  : <EmptyState icon={<ListTodo size={19} />} title="Task list is empty" body="Submit an outcome to record it in durable intake." action={<Button ref={emptyStateAddTaskRef} data-dialog-trigger="task" size="sm" variant="primary" disabled={!connected} onClick={(event) => openDialog('task', { anchor: emptyStateAddTaskRef }, event.nativeEvent)}>Add task</Button>} />
                : null}
              </div>
            </div>
            <div className={cn('min-w-0 max-w-full', anyDetailOpen ? 'cicada-page-enter block' : 'hidden')}>
              {anyDetailOpen ? <div className="mb-3 flex items-center justify-between gap-2 xl:hidden"><Button size="sm" icon={<ArrowLeft size={15} />} onClick={workItemDetailOpen ? closeWorkItem : closeTask}>Back to task list</Button><Button size="sm" icon={<RefreshCw size={15} className={loading ? 'animate-spin' : ''} />} disabled={loading} onClick={() => void refreshManually()}>Refresh</Button></div> : null}
              {selectedWorkItem ? <WorkItemDetail
                key={selectedWorkItem.id}
                workItem={selectedWorkItem}
                snapshotRevision={snapshot.revision}
                familyVersionKey={decompositionFamilyVersionKey(selectedWorkItem, allWorkItems)}
                familyRefreshRevision={familyRefreshRevision}
                knownParent={selectedWorkItem.parentWorkItemId === null && allWorkItems.some((candidate) => candidate.parentWorkItemId === selectedWorkItem.id)}
                projectName={snapshot.projects.find((project) => project.id === selectedWorkItem.resolvedProjectId)?.name ?? null}
                projects={snapshot.projects}
                parentWorkItem={selectedWorkItem.parentWorkItemId === null ? null : allWorkItems.find((candidate) => candidate.id === selectedWorkItem.parentWorkItemId) ?? null}
                planningTask={snapshot.tasks.find((task) => task.id === selectedWorkItem.planningTaskId) ?? null}
                openQuestion={snapshot.questions.find((question) => question.taskId === selectedWorkItem.planningTaskId && question.status === 'open') ?? null}
                client={client}
                busy={busy || !connected}
                onClose={closeWorkItem}
                onOpenWorkItem={(workItemId) => { void openWorkItemFromFamily(workItemId); }}
                onAnswer={(questionId, answer) => mutateWorkItemDetail(() => client.answerQuestion(questionId, { answer }))}
                onConfirm={(planRevisionId) => mutateWorkItemDetail(() => client.confirmWorkflow(planRevisionId))}
                onReject={(planRevisionId, note) => mutateWorkItemDetail(() => client.rejectWorkflowPlan(planRevisionId, note))}
                onApproveMerge={() => mutateWorkItemDetail(() => client.approvePipelineMerge(selectedWorkItem.id, { version: selectedWorkItem.version }))}
                onRejectFinal={(note) => mutateWorkItemDetail(() => client.rejectFinalApproval(selectedWorkItem.id, { version: selectedWorkItem.version, note }))}
                onAttestDeploy={(workItemId, note) => mutateWorkItemDetail(() => client.attestDeployment(workItemId, note === undefined ? {} : { note }))}
                onResumeCoordination={() => mutateWorkItemDetail(() => client.resumeWorkItem(selectedWorkItem.id))}
                onCancel={(reason) => mutateWorkItemDetail(() => client.cancelWorkItem(selectedWorkItem.id, { version: selectedWorkItem.version, reason }))}
                onArchive={async () => {
                  const result = await mutateWorkItemDetail(() => client.archiveWorkItem(selectedWorkItem.id, { version: selectedWorkItem.version }));
                  if (result.ok) closeWorkItem();
                  return result;
                }}
              /> : selectedTask && taskDetailOpen ? <TaskDetail key={selectedTask.id} task={selectedTask} agents={selectedTaskAgents} questions={taskQuestions} runs={taskRuns} drafts={taskDetailDrafts} dispatchDraft={dispatchTaskDetailDraft} busy={busy || !connected} onAssign={(agentId) => mutateTaskDetail(() => client.assignTask(selectedTask.id, { agentId, version: selectedTask.version }))} onReturnToBacklog={() => mutateTaskDetail(() => client.returnTaskToBacklog(selectedTask.id, { version: selectedTask.version }))} onRetry={() => mutateTaskDetail(() => client.retryTask(selectedTask.id, selectedTask.version))} onRecoveryBacklog={() => mutateTaskDetail(() => client.backlogTask(selectedTask.id, selectedTask.version))} onAnswer={(questionId, answer) => mutateTaskDetail(() => client.answerQuestion(questionId, { answer }))} onInterrupt={(runId) => mutateTaskDetail(() => client.interruptRun(runId))} onDecideHumanCheck={(status, rationale) => { const result = status === 'completed' ? `Approved for an external human-controlled release step.\n\nRationale: ${rationale}` : `Changes requested by human.\n\nRationale: ${rationale}`; return mutateTaskDetail(() => client.decideHumanCheck(selectedTask.id, { version: selectedTask.version, status, result })); }} /> : taskDetailOpen && selectedTaskId ? <RemovedTaskDetail key={selectedTaskId} taskId={selectedTaskId} onClose={closeTask} /> : <Card><EmptyState icon={<CirclePause size={19} />} title="Nothing selected" body="Choose a task to see its description, status, and phases." /></Card>}
            </div>
          </div>
        </main>
      </>
    );
  }

  const pageTransitionKey = page.kind === 'project'
    ? `project-${page.projectId}`
    : page.kind === 'agent'
      ? `agent-${page.agentId}`
      : page.kind === 'intake'
        ? 'tasks'
        : page.kind === 'automation'
            ? 'automation'
            : page.kind === 'ledgers'
              ? 'ledgers'
              : 'tasks';

  return (
    <WorkspaceFrame snapshot={snapshot} page={page} pointOfContact={pointOfContact} drawerOpen={drawerOpen} onDrawerChange={setDrawerOpen} onNavigate={(next, event) => navigate(next, 'push', event)} onAddProject={(event) => openDialog('project', {}, event)} canAddProject={connected} unreadNotifications={notifications?.unread.length ?? 0} boardPause={boardPause} pausePopoverOpen={pausePopoverOpen} pauseBusy={pauseBusy} pauseControlDisabled={!connected} pauseControlError={pauseControlError} onPauseBoard={openPausePopover} onConfirmPause={(reason) => { void confirmPause(reason); }} onCancelPause={closePausePopover} onResumeBoard={() => { void resumeBoard(); }}>
      <BoardPauseBanner boardPause={boardPause} />
      {errorPipeline.connectivityDown ? <div className="px-4 pt-4 sm:px-8 lg:px-12"><FormError><div className="flex items-start justify-between gap-4"><div><p className="font-semibold">{signInExpired ? 'Your sign-in has expired' : 'Task board unavailable'}</p><p className="mt-1 text-xs leading-5">{signInExpired ? 'Sign in again to continue. Existing durable state remains visible.' : `The board service is not reachable. ${connectivityError ?? 'Could not connect to the task board'}. Existing durable state remains visible. No demo data is being shown.`}</p></div>{signInExpired ? <button type="button" className="shrink-0 underline" onClick={() => globalThis.location.reload()}>Sign in again</button> : null}</div></FormError></div> : null}
      {errorPipeline.actionStatus ? <div className="px-4 pt-4 sm:px-8 lg:px-12"><div role="status" aria-live="polite" className="rounded-md border border-success-fill/50 bg-success-soft px-4 py-3 text-sm text-success">{errorPipeline.actionStatus}</div></div> : null}
      <div key={pageTransitionKey} className="cicada-page-enter">{content}</div>

      <CreateDialogs
        client={client}
        dialog={dialog}
        closeDialog={closeDialog}
        keepEditingDialog={keepEditingDialog}
        projectRequestCloseRef={projectDialogRequestCloseRef}
        taskRequestCloseRef={taskDialogRequestCloseRef}
        projectFormDirty={projectFormDirty}
        workItemFormDirty={workItemFormDirty}
        taskAnchorRef={taskDialogAnchorRef}
        dialogProject={dialogProject}
        snapshot={snapshot}
        busy={busy}
        connected={connected}
        projectCreateErrors={projectCreateErrors}
        workItemCreateErrors={workItemCreateErrors}
        dismissActionError={dismissActionError}
        createProject={createProject}
        createWorkItem={createWorkItem}
      />
      <ActionErrorToasts errors={unanchoredActionErrors} onDismiss={dismissActionError} />
    </WorkspaceFrame>
  );
}
