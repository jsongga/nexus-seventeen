import { ArrowLeft, CircleAlert, CirclePause, FolderKanban, ListTodo, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { Button, Card, cn } from '../components/ui';
import { AutomationPage } from './views/AutomationPage';
import { emptyAutomationEditorState } from './model/automation-model';
import { BoardApiError, createTaskBoardClient, type TaskBoardClient } from './data/client';
import { DocumentsPage } from './views/DocumentsPage';
import { missingRouteFallback } from './routing/routing';
import { useHashRoute } from './routing/useHashRoute';
import { AgentPage, ProjectPage } from './views/WorkspacePages';
import { WorkspaceFrame } from './views/WorkspaceSidebar';
import { WorkItemDetail } from './views/WorkItemDetail';
import { CreateDialogs, type DialogName } from './views/CreateDialogs';
import { ActionErrorToasts, EmptyState, FormError, RemovedTaskDetail, TaskRow, WorkItemRow } from './views/TaskList';
import { TaskDetail, taskRunsByCreatedAt } from './views/TaskDetail';
import { actionErrorContexts, actionErrorMessage, errorPipelineReducer, initialErrorPipelineState, isDialogAnchoredActionContext, mutationNetworkError, newestActionErrors, type ActionResult } from './model/action-errors';
import { isExplicitPointOfContact, selectPointOfContact } from './model/workspace-model';
import { BOARD_REFRESH_DEADLINE_MS, BoardRefreshCoordinator, SnapshotCommitCoordinator, refreshTimedOut, type BoardRefreshKind } from './model/refresh-coordinator';
import { createTaskDetailDraftState, taskDetailDraftReducer } from './model/task-detail-drafts';
import { signInFailure } from './model/sign-in-failure';
import type { BoardSnapshot, CreateProjectInput, CreateWorkItemInput } from './types';

export function BoardApp() {
  const client = useMemo<TaskBoardClient>(() => createTaskBoardClient({ baseUrl: '/board-api' }), []);
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [page, navigate] = useHashRoute();
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
  const snapshotCommits = useMemo(() => new SnapshotCommitCoordinator<BoardSnapshot>(), []);
  const observedTaskIds = useRef(new Set<string>());
  const workItemRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const taskRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastOpenWorkItemId = useRef<string | null>(null);
  const lastOpenTaskId = useRef<string | null>(null);
  const workItemDetailWasOpen = useRef(false);
  const taskDetailWasOpen = useRef(false);
  const projectFormDirty = useRef(false);
  const workItemFormDirty = useRef(false);
  const connected = snapshot !== null && !errorPipeline.connectivityDown;

  const commitSnapshot = useCallback((next: BoardSnapshot, signal: AbortSignal): Promise<boolean> => {
    return snapshotCommits.commit(next, signal, setSnapshot);
  }, [snapshotCommits]);

  useLayoutEffect(() => {
    if (snapshot !== null) snapshotCommits.acknowledge(snapshot);
  }, [snapshot, snapshotCommits]);

  useLayoutEffect(() => () => {
    snapshotCommits.drain();
  }, [snapshotCommits]);

  const performRefresh = useCallback(async (kind: BoardRefreshKind, signal: AbortSignal): Promise<boolean> => {
    try {
      const next = await client.getSnapshot(signal, kind);
      if (!await commitSnapshot(next, signal)) {
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
  }, [client, commitSnapshot]);

  const refreshCoordinator = useMemo(() => new BoardRefreshCoordinator(performRefresh, {
    onForegroundLoadingChange: setLoading,
  }), [performRefresh]);
  const refresh = useCallback((kind: BoardRefreshKind = 'foreground') => (
    refreshCoordinator.refresh(kind)
  ), [refreshCoordinator]);

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
    const fallback = missingRouteFallback(page, snapshot, observedTaskIds.current);
    if (fallback !== null) navigate(fallback, 'replace');
  }, [navigate, page, snapshot]);

  const mutate = useCallback(async (context: string, operation: () => Promise<unknown>): Promise<ActionResult> => {
    dispatchErrorPipeline({ type: 'action-started', context });
    if (!connected) {
      dispatchErrorPipeline({ type: 'action-failed', context, error: mutationNetworkError });
      return { ok: false, error: mutationNetworkError };
    }
    setBusy(true);
    try {
      await operation();
      await refresh('mutation');
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
      await operation();
      await refresh('mutation');
      return { ok: true };
    } catch (caught) {
      if (caught instanceof BoardApiError) {
        if (caught.code === 'WORK_ITEM_ENDED') {
          await refresh('mutation');
        }
        if (caught.code === 'WORK_ITEM_VERSION_CONFLICT' || caught.code === 'PLAN_NOT_PROPOSED') {
          await refresh('mutation');
        }
      }
      return { ok: false, error: actionErrorMessage(caught) };
    } finally {
      setBusy(false);
    }
  }, [connected, refresh]);

  const mutateTaskDetail = useCallback(async (operation: () => Promise<unknown>): Promise<ActionResult> => {
    if (!connected) return { ok: false, error: mutationNetworkError };
    setBusy(true);
    try {
      await operation();
      await refresh('mutation');
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
  const selectedWorkItem = page.kind === 'intake' ? allWorkItems.find((workItem) => workItem.id === page.workItemId) : undefined;
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
    navigate({ kind: 'intake', workItemId });
  }

  function closeWorkItem() {
    navigate({ kind: 'tasks' }, 'replace');
  }

  function closeTask() {
    navigate({ kind: 'tasks' }, 'replace');
  }

  function openDialog(name: Exclude<DialogName, null>, projectId?: string) {
    dismissActionError(name === 'project'
      ? actionErrorContexts.projectCreate
      : actionErrorContexts.workItemCreate);
    setDialogProjectId(projectId ?? null);
    if (name === 'project') projectFormDirty.current = false;
    else workItemFormDirty.current = false;
    setDialog(name);
  }

  function closeDialog() {
    if (dialog === 'project') dismissActionError(actionErrorContexts.projectCreate);
    if (dialog === 'task') dismissActionError(actionErrorContexts.workItemCreate);
    projectFormDirty.current = false;
    workItemFormDirty.current = false;
    setDialog(null);
  }

  async function createProject(input: CreateProjectInput): Promise<ActionResult> {
    const result = await mutate(actionErrorContexts.projectCreate, () => client.createProject(input));
    if (result.ok) {
      projectFormDirty.current = false;
      setDialog(null);
    }
    return result;
  }

  async function createWorkItem(input: CreateWorkItemInput): Promise<ActionResult> {
    const result = await mutate(actionErrorContexts.workItemCreate, () => client.createWorkItem(input));
    if (result.ok) {
      workItemFormDirty.current = false;
      setDialog(null);
    }
    return result;
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
  } else if (page.kind === 'documents') {
    content = <DocumentsPage snapshot={snapshot} selectedDocumentId={page.documentId} client={client} connected={connected} onSelectDocument={(documentId) => navigate({ kind: 'documents', documentId })} onRefreshBoard={() => refresh('mutation')} />;
  } else if (page.kind === 'automation') {
    content = <AutomationPage client={client} connected={connected} editorState={automationEditorState} onEditorStateChange={setAutomationEditorState} />;
  } else if (page.kind === 'project' && pageProject) {
    content = <ProjectPage key={pageProject.id} project={pageProject} snapshot={snapshot} client={client} connected={connected} onTask={openTask} onAddTask={() => openDialog('task', pageProject.id)} onSelectDocument={(documentId) => navigate({ kind: 'documents', documentId })} />;
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
            <Button className="size-11 min-h-0 rounded-[99px] p-0 sm:size-10" size="sm" variant="primary" icon={<Plus size={18} strokeWidth={1.6} />} aria-label="Add task" title="Add task" disabled={!connected} onClick={() => openDialog('task')} />
            <Button className="size-11 min-h-0 rounded-[99px] p-0 sm:size-10" size="sm" icon={<FolderKanban size={17} strokeWidth={1.5} />} aria-label="Add project" title="Add project from disk" disabled={!connected} onClick={() => openDialog('project')} />
            {anyDetailOpen ? <Button className="size-11 min-h-0 rounded-[99px] p-0 sm:size-10" size="sm" icon={<RefreshCw size={17} strokeWidth={1.5} className={loading ? 'animate-spin' : ''} />} aria-label="Refresh" title="Refresh" disabled={loading} onClick={() => void refresh()} /> : null}
          </div>
        </header>
        <main className="w-full max-w-[1600px] p-4 sm:px-8 sm:py-6 lg:px-12 lg:py-8">
          <div className={cn('grid items-start gap-8', anyDetailOpen ? 'xl:grid-cols-[minmax(360px,.92fr)_minmax(420px,1.08fr)] xl:gap-10' : 'max-w-5xl')}>
            <div className={cn('min-w-0', anyDetailOpen ? 'hidden xl:block' : 'block')}>
              <div className="space-y-8">
                {allWorkItems.length > 0 ? (
                  <section aria-labelledby="automation-intake-heading">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h2 id="automation-intake-heading" className="font-display text-lg font-light tracking-[0.01em] text-ink">Automation intake</h2>
                      <span className="text-xs text-muted">{allWorkItems.length}</span>
                    </div>
                    <div>{allWorkItems.map((workItem) => <WorkItemRow
                      key={workItem.id}
                      workItem={workItem}
                      projects={snapshot.projects}
                      selected={workItemDetailOpen && workItem.id === selectedWorkItem.id}
                      onSelect={() => openWorkItem(workItem.id)}
                      buttonRef={(element) => {
                        if (element) workItemRowRefs.current.set(workItem.id, element);
                        else workItemRowRefs.current.delete(workItem.id);
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
                  ? <EmptyState icon={<FolderKanban size={19} />} title="Start with a project" body="Add a project folder first. Agents arrive on demand for that project; then submit work." action={<Button size="sm" variant="primary" disabled={!connected} onClick={() => openDialog('project')}>Add project</Button>} />
                  : <EmptyState icon={<ListTodo size={19} />} title="Task list is empty" body="Submit an outcome to record it in durable intake." action={<Button size="sm" variant="primary" disabled={!connected} onClick={() => openDialog('task')}>Add task</Button>} />
                : null}
              </div>
            </div>
            <div className={cn(anyDetailOpen ? 'cicada-page-enter block' : 'hidden')}>
              {anyDetailOpen ? <div className="mb-3 flex items-center justify-between gap-2 xl:hidden"><Button size="sm" icon={<ArrowLeft size={15} />} onClick={workItemDetailOpen ? closeWorkItem : closeTask}>Back to task list</Button><Button size="sm" icon={<RefreshCw size={15} className={loading ? 'animate-spin' : ''} />} disabled={loading} onClick={() => void refresh()}>Refresh</Button></div> : null}
              {selectedWorkItem ? <WorkItemDetail
                key={selectedWorkItem.id}
                workItem={selectedWorkItem}
                projectName={snapshot.projects.find((project) => project.id === selectedWorkItem.resolvedProjectId)?.name ?? null}
                planningTask={snapshot.tasks.find((task) => task.id === selectedWorkItem.planningTaskId) ?? null}
                openQuestion={snapshot.questions.find((question) => question.taskId === selectedWorkItem.planningTaskId && question.status === 'open') ?? null}
                client={client}
                busy={busy || !connected}
                onClose={closeWorkItem}
                onAnswer={(questionId, answer) => mutateWorkItemDetail(() => client.answerQuestion(questionId, { answer }))}
                onConfirm={(planRevisionId) => mutateWorkItemDetail(() => client.confirmWorkflow(planRevisionId))}
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
      : page.kind === 'documents'
        ? 'documents'
        : page.kind === 'automation'
          ? 'automation'
          : 'tasks';

  return (
    <WorkspaceFrame snapshot={snapshot} page={page} pointOfContact={pointOfContact} drawerOpen={drawerOpen} onDrawerChange={setDrawerOpen} onNavigate={navigate} onAddProject={() => openDialog('project')} canAddProject={connected}>
      {errorPipeline.connectivityDown ? <div className="px-4 pt-4 sm:px-8 lg:px-12"><FormError><div className="flex items-start justify-between gap-4"><div><p className="font-semibold">{signInExpired ? 'Your sign-in has expired' : 'Task board unavailable'}</p><p className="mt-1 text-xs leading-5">{signInExpired ? 'Sign in again to continue. Existing durable state remains visible.' : `The board service is not reachable. ${connectivityError ?? 'Could not connect to the task board'}. Existing durable state remains visible. No demo data is being shown.`}</p></div>{signInExpired ? <button type="button" className="shrink-0 underline" onClick={() => globalThis.location.reload()}>Sign in again</button> : null}</div></FormError></div> : null}
      <div key={pageTransitionKey} className="cicada-page-enter">{content}</div>

      <CreateDialogs
        dialog={dialog}
        closeDialog={closeDialog}
        projectFormDirty={projectFormDirty}
        workItemFormDirty={workItemFormDirty}
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
