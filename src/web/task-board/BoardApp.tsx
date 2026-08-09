import {
  Activity,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CirclePause,
  FolderKanban,
  HelpCircle,
  ListTodo,
  Plus,
  RefreshCw,
  Send,
  Square,
  UserRoundCheck,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type ReactNode } from 'react';
import { Button, Card, FieldLabel, InlineActionErrors, Modal, Pill, Toast, cn, inputClass } from '../components/ui';
import { fieldsAreDirty } from '../components/dialog-discard';
import { AutomationPage } from './views/AutomationPage';
import { emptyAutomationEditorState } from './model/automation-model';
import { BoardApiError, createTaskBoardClient, randomUuid, type TaskBoardClient } from './data/client';
import { DocumentsPage } from './views/DocumentsPage';
import { missingRouteFallback } from './routing/routing';
import { useHashRoute } from './routing/useHashRoute';
import { AgentPage, ProjectPage } from './views/WorkspacePages';
import { WorkspaceFrame } from './views/WorkspaceSidebar';
import { WorkItemDetail } from './views/WorkItemDetail';
import {
  actionErrorContexts,
  actionErrorMessage,
  errorPipelineReducer,
  initialErrorPipelineState,
  isDialogAnchoredActionContext,
  mutationNetworkError,
  newestActionErrors,
  useActionErrors,
  type ActionError,
  type ActionResult,
} from './model/action-errors';
import {
  isExplicitPointOfContact,
  selectPointOfContact,
} from './model/workspace-model';
import {
  prettyStatus,
  workItemStateTone,
  workItemStatusLabel,
} from './model/work-item-labels';
import { recoveryAffordances } from './model/task-recovery';
import {
  createTaskDetailDraftState,
  taskDetailDraftReducer,
  type TaskDetailDraftAction,
  type TaskDetailDraftState,
} from './model/task-detail-drafts';
import type {
  BoardAgent,
  BoardQuestion,
  BoardRun,
  BoardSnapshot,
  BoardTask,
  BoardWorkItem,
  CreateProjectInput,
  CreateWorkItemInput,
  TaskKind,
  TaskStatus,
  WorkItemPriority,
} from './types';

const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const statusTone: Record<TaskStatus, 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'purple'> = {
  proposed: 'purple',
  backlog: 'neutral',
  queued: 'blue',
  running: 'green',
  waiting_for_human: 'amber',
  blocked: 'amber',
  completed: 'green',
  failed: 'red',
  interrupted: 'red',
  cancelled: 'neutral',
};

const workItemPriorityTone: Record<WorkItemPriority, 'neutral' | 'amber' | 'red' | 'blue' | 'purple'> = {
  urgent: 'red',
  high: 'amber',
  normal: 'blue',
  low: 'neutral',
  opportunistic: 'purple',
};

type DialogName = 'project' | 'task' | null;

/**
 * The board sits behind staff SSO, which the app never sees succeed -- it only
 * ever notices the failure. A 401 means the session lapsed while the page stayed
 * open. Only a top-level navigation can renew it: the document request is allowed
 * to redirect to the identity provider, and an XHR cannot follow that redirect.
 *
 * This deliberately does NOT reload by itself. An earlier version did, guarded by
 * a module-level flag -- which a reload destroys, so the flag reset every time
 * and the page reloaded forever. Re-authentication is now something the operator
 * triggers, so a persistent 401 costs one click rather than an infinite loop.
 *
 * A 403 is a different failure: the session is valid but the account is not in
 * the operator group, and no amount of signing in again grants it.
 */
export function signInFailure(caught: unknown): { message: string; canRetrySignIn: boolean } | null {
  if (!(caught instanceof BoardApiError)) return null;
  if (caught.status === 403) {
    return {
      message: 'You are signed in, but your account is not a board operator. Ask an administrator to add you to the nexus-operator group.',
      canRetrySignIn: false,
    };
  }
  if (caught.status !== 401) return null;
  return { message: 'Your sign-in has expired.', canRetrySignIn: true };
}

const taskKindLabel: Record<TaskKind, string> = {
  work: 'work',
  manager_review: 'manager review',
  human_check: 'human check',
};

function formatTime(value: string | null): string {
  if (value === null) return 'Not recorded';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : dateTime.format(parsed);
}

function taskStatusLabel(task: BoardTask): string {
  if (task.kind !== 'human_check') return prettyStatus(task.status);
  if (task.status === 'completed') return 'approved';
  if (task.status === 'failed') return 'changes requested';
  if (task.endedAt === null) return 'awaiting human';
  return prettyStatus(task.status);
}

function taskIsTerminal(task: BoardTask): boolean {
  return task.endedAt !== null
    || task.status === 'completed'
    || task.status === 'failed'
    || task.status === 'interrupted'
    || task.status === 'cancelled';
}

function StatusPill({ task }: { task: BoardTask }) {
  return <Pill tone={statusTone[task.status]} dot>{taskStatusLabel(task)}</Pill>;
}

function TaskKindPill({ kind }: { kind: TaskKind }) {
  const tone = kind === 'human_check' ? 'purple' : kind === 'manager_review' ? 'amber' : 'neutral';
  return <Pill tone={tone}>{taskKindLabel[kind]}</Pill>;
}

function WorkItemRow({
  workItem,
  projects,
  selected,
  onSelect,
  buttonRef,
}: {
  workItem: BoardWorkItem;
  projects: BoardSnapshot['projects'];
  selected: boolean;
  onSelect: () => void;
  buttonRef: (element: HTMLButtonElement | null) => void;
}) {
  const projectId = workItem.resolvedProjectId
    ?? (workItem.projectTarget.mode === 'explicit' ? workItem.projectTarget.projectId : null);
  const projectName = projectId === null
    ? 'Project: Auto'
    : projects.find((project) => project.id === projectId)?.name ?? projectId;
  const displayRequest = workItem.refinedObjective?.trim() || workItem.originalRequest;
  const rowTitle = taskTitleFromPrompt(displayRequest);
  return (
    <article aria-label={`Work item: ${rowTitle}`} className="last:[&>button]:border-b-0">
      <button
        ref={buttonRef}
        type="button"
        aria-label={`${rowTitle} ${workItemStatusLabel(workItem)}`}
        onClick={onSelect}
        className={cn(
          'group mx-2 w-[calc(100%-1rem)] rounded-md border-b border-line px-3 py-4 text-left transition-[background-color,transform] duration-150 ease-out hover:bg-paper/75 motion-safe:active:scale-[0.995]',
          selected && 'bg-paper hover:bg-paper',
        )}
      >
        <div className="flex items-start gap-4">
        <span className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-[99px] border border-taupe text-taupe" aria-hidden="true">
          <Activity size={12} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="font-display text-[15px] font-normal leading-5 text-ink">{rowTitle}</h3>
            <Pill tone={workItemPriorityTone[workItem.priority]}>{workItem.priority} priority</Pill>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
            <Pill tone={workItemStateTone[workItem.state]} dot>{workItemStatusLabel(workItem)}</Pill>
            <span>{projectName}</span>
          </div>
        </div>
        <span className="flex size-[22px] shrink-0 items-center justify-center rounded-[99px] bg-taupe text-white opacity-60 transition-[opacity,transform] duration-150 ease-out group-hover:translate-x-0.5 group-hover:opacity-100">
          <ChevronRight size={12} strokeWidth={2} />
        </span>
        </div>
      </button>
    </article>
  );
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center px-5 py-10 text-center">
      <div className="mb-4 flex size-11 items-center justify-center rounded-[99px] bg-muted-surface text-ink">
        {icon}
      </div>
      <h2 className="font-display text-lg font-light tracking-[0.01em] text-ink">{title}</h2>
      <p className="mt-1 max-w-md text-sm leading-6 text-muted">{body}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

function RemovedTaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(max-width: 1279px)').matches) headingRef.current?.focus();
  }, [taskId]);

  return (
    <Card>
      <div className="flex min-h-52 flex-col items-center justify-center px-5 py-10 text-center" role="status">
        <div className="mb-4 flex size-11 items-center justify-center rounded-[99px] bg-caution-soft text-caution">
          <CircleAlert size={19} />
        </div>
        <h2 ref={headingRef} tabIndex={-1} className="font-display text-lg font-light tracking-[0.01em] text-ink">Task removed</h2>
        <p className="mt-1 max-w-md text-sm leading-6 text-muted">
          Task <span className="break-all font-mono text-xs text-ink">{taskId}</span> is no longer in the board snapshot. Your view has not switched to another task.
        </p>
        <div className="mt-5"><Button size="sm" onClick={onClose}>Close</Button></div>
      </div>
    </Card>
  );
}

function FormError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-md border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent">
      {children}
    </div>
  );
}

function TaskRow({
  task,
  selected,
  agent,
  projectName,
  openQuestion,
  onSelect,
  buttonRef,
}: {
  task: BoardTask;
  selected: boolean;
  agent: BoardAgent | undefined;
  projectName?: string;
  openQuestion: boolean;
  onSelect: () => void;
  buttonRef: (element: HTMLButtonElement | null) => void;
}) {
  const completed = task.status === 'completed';
  const statusDot = task.status === 'running'
    ? 'bg-success-fill'
    : task.status === 'waiting_for_human' || task.status === 'blocked'
      ? 'bg-taupe'
      : 'bg-muted/55';
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={`${task.title} ${task.status}`}
      onClick={onSelect}
      className={cn(
        'group mx-2 w-[calc(100%-1rem)] rounded-md border-b border-line px-3 py-4 text-left transition-[background-color,transform] duration-150 ease-out last:border-b-0 hover:bg-paper/75 motion-safe:active:scale-[0.995]',
        selected && 'bg-paper hover:bg-paper',
      )}
    >
      <div className="flex items-center gap-4">
        <span
          className={cn(
            'flex size-[22px] shrink-0 items-center justify-center rounded-[99px] border border-taupe text-white',
            completed && 'bg-taupe',
          )}
          aria-hidden="true"
        >
          {completed ? <Check size={12} strokeWidth={2.25} /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={cn('font-display text-[15px] font-normal leading-5 text-ink', completed && 'text-muted line-through decoration-line')}>{task.title}</span>
            {task.kind !== 'work' ? <TaskKindPill kind={task.kind} /> : null}
            {openQuestion ? <HelpCircle size={14} className="text-caution" aria-label="answer needed" /> : null}
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
            {task.kind === 'human_check' ? (
              <><span className="inline-flex items-center rounded-[99px] bg-paper px-2 py-0.5 text-[11px]">Human</span><span className="inline-flex items-center gap-2"><span aria-hidden="true">•</span>{taskStatusLabel(task)}</span></>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-[99px] bg-paper px-2 py-0.5 text-[11px]">
                  {agent ? <span className={cn('size-1.5 rounded-[99px]', statusDot)} /> : null}
                  {agent?.name ?? (task.requiredRole ? `Needs ${task.requiredRole}` : 'Unassigned')}
                </span>
                <span className="inline-flex items-center gap-2"><span aria-hidden="true">•</span>{taskStatusLabel(task)}</span>
                {!taskIsTerminal(task) && task.expectedCompletedAt ? <span className="inline-flex items-center gap-2"><span aria-hidden="true">•</span>Due {formatTime(task.expectedCompletedAt)}</span> : task.expectedAgentMinutes !== null ? <span className="inline-flex items-center gap-2"><span aria-hidden="true">•</span>{task.expectedAgentMinutes} agent min</span> : null}
              </>
            )}
            {projectName ? <span className="inline-flex items-center gap-2"><span className="hidden sm:inline" aria-hidden="true">•</span>{projectName}</span> : null}
          </span>
        </span>
        <span className="flex size-[22px] shrink-0 items-center justify-center rounded-[99px] bg-taupe text-white opacity-60 transition-[opacity,transform] duration-150 ease-out group-hover:translate-x-0.5 group-hover:opacity-100">
          <ChevronRight size={12} strokeWidth={2} />
        </span>
      </div>
    </button>
  );
}

const phaseStatusTone = {
  pending: 'neutral',
  in_progress: 'green',
  blocked: 'amber',
  completed: 'green',
  failed: 'red',
} as const;

function TaskPhases({ task }: { task: BoardTask }) {
  const phases = [...task.phases].sort((left, right) => left.orderKey - right.orderKey || left.createdAt.localeCompare(right.createdAt));
  const parallelCounts = new Map<string, number>();
  for (const phase of phases) {
    if (phase.parallelGroup) parallelCounts.set(phase.parallelGroup, (parallelCounts.get(phase.parallelGroup) ?? 0) + 1);
  }

  return (
    <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="task-phases-heading">
      <h3 id="task-phases-heading" className="text-xs font-semibold text-ink">Phases</h3>
      {phases.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-muted">The agent will add phases and an estimate after reviewing the task.</p>
      ) : (
        <ol className="mt-3 divide-y divide-line overflow-hidden rounded-md border border-line bg-muted-surface">
          {phases.map((phase) => {
            const parallel = phase.parallelGroup !== null && (parallelCounts.get(phase.parallelGroup) ?? 0) > 1;
            return (
              <li key={phase.id} className="flex items-start gap-3 px-3.5 py-3">
                <span className={cn(
                  'mt-1.5 size-2 shrink-0 rounded-[99px]',
                  phase.status === 'completed' ? 'bg-success-fill' : phase.status === 'in_progress' ? 'bg-taupe-hover' : phase.status === 'failed' ? 'bg-urgent' : phase.status === 'blocked' ? 'bg-caution-fill' : 'bg-line',
                )} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-medium text-ink">{phase.title}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                    <span className="capitalize">{phase.stage.replaceAll('_', ' ')}</span>
                    {parallel ? <span className="rounded-[99px] bg-paper px-2 py-0.5">Parallel</span> : null}
                  </span>
                </span>
                <Pill tone={phaseStatusTone[phase.status]}>{phase.status.replaceAll('_', ' ')}</Pill>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function TaskDetail({
  task,
  agents,
  questions,
  runs,
  drafts,
  dispatchDraft,
  busy,
  onAssign,
  onReturnToBacklog,
  onRetry,
  onRecoveryBacklog,
  onAnswer,
  onInterrupt,
  onDecideHumanCheck,
}: {
  task: BoardTask;
  agents: BoardAgent[];
  questions: BoardQuestion[];
  runs: BoardRun[];
  drafts: TaskDetailDraftState;
  dispatchDraft: Dispatch<TaskDetailDraftAction>;
  busy: boolean;
  onAssign: (agentId: string) => Promise<ActionResult>;
  onReturnToBacklog: () => Promise<ActionResult>;
  onRetry: () => Promise<ActionResult>;
  onRecoveryBacklog: () => Promise<ActionResult>;
  onAnswer: (questionId: string, answer: string) => Promise<ActionResult>;
  onInterrupt: (runId: string) => Promise<ActionResult>;
  onDecideHumanCheck: (status: 'completed' | 'failed', rationale: string) => Promise<ActionResult>;
}) {
  const eligibleAgents = useMemo(
    () => task.requiredRole === null ? agents : agents.filter((agent) => agent.role === task.requiredRole),
    [agents, task.requiredRole],
  );
  const recovery = useMemo(() => recoveryAffordances({
    status: task.status,
    assignedAgentId: task.assignedAgentId,
    // The board snapshot does not expose stage-attempt linkage. The dedicated
    // backlog endpoint remains authoritative and returns TASK_WORKFLOW_BOUND.
    workflowBound: null,
    eligibleAgentIds: eligibleAgents.map((agent) => agent.id),
  }), [eligibleAgents, task.assignedAgentId, task.status]);
  const recoveryAgents = useMemo(() => recovery === null
    ? []
    : recovery.reassign.eligibleAgentIds.flatMap((eligibleId) => {
      const eligible = eligibleAgents.find((agent) => agent.id === eligibleId);
      return eligible ? [eligible] : [];
    }), [eligibleAgents, recovery]);
  const defaultAgentId = recovery === null
    ? task.assignedAgentId ?? eligibleAgents[0]?.id ?? ''
    : recovery.reassign.eligibleAgentIds[0] ?? '';
  const [agentId, setAgentId] = useState(defaultAgentId);
  const actionErrors = useActionErrors();
  const openQuestion = questions.find((question) => question.status === 'open');
  const activeRun = runs.find((run) => run.status === 'running' || run.status === 'queued');
  const queuedUnclaimed = task.status === 'queued' && !activeRun;
  const assigneeChanged = agentId !== task.assignedAgentId;
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setAgentId(defaultAgentId);
  }, [defaultAgentId, task.id]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(max-width: 1279px)').matches) detailHeadingRef.current?.focus();
  }, [task.id]);

  async function runAction(context: string, operation: () => Promise<ActionResult>): Promise<boolean> {
    actionErrors.start(context);
    const result = await operation();
    if (result.ok) return true;
    actionErrors.fail(context, result.error);
    return false;
  }

  return (
    <section aria-label={`Task details: ${task.title}`}>
      <Card className="overflow-hidden">
      <header className="border-b border-line px-4 py-5 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Current status</p>
            <StatusPill task={task} />
          </div>
          {task.expectedAgentMinutes !== null ? <span className="text-[11px] text-muted">About {task.expectedAgentMinutes} agent min</span> : null}
        </div>
        <h2 ref={detailHeadingRef} tabIndex={-1} className="mt-4 break-words font-display text-xl font-light tracking-[0.01em] text-ink">{task.title}</h2>
        <div className="mt-4">
          <p className="text-xs font-medium text-muted">Description</p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink">{task.objective}</p>
        </div>
      </header>

      {task.kind !== 'human_check' ? <TaskPhases task={task} /> : null}

      {task.kind !== 'human_check' && openQuestion ? (
        <section className="border-b border-caution-fill/30 bg-caution-soft/55 px-4 py-4 sm:px-5">
          <div className="flex items-center gap-2 text-caution">
            <HelpCircle size={17} />
            <h3 className="text-xs font-semibold">Waiting for your answer</h3>
          </div>
          <p className="mt-3 whitespace-pre-wrap text-sm font-medium leading-6 text-ink">{openQuestion.prompt}</p>
          <div className="mt-3">
            <FieldLabel htmlFor={`task-answer-${task.id}`}>Your answer</FieldLabel>
            <textarea
              id={`task-answer-${task.id}`}
              className={cn(inputClass, 'min-h-24 resize-y py-3')}
              placeholder="Give the missing context…"
              value={drafts.answer}
              onChange={(event) => dispatchDraft({ type: 'answer-changed', value: event.target.value })}
            />
          </div>
          <Button
            className="mt-3 w-full"
            variant="primary"
            icon={<Send size={16} />}
            disabled={busy || drafts.answer.trim().length === 0}
            onClick={() => void runAction(actionErrorContexts.taskAnswer(task.id, openQuestion.id), () => onAnswer(openQuestion.id, drafts.answer.trim())).then((saved) => { if (saved) dispatchDraft({ type: 'answer-changed', value: '' }); })}
          >
            Answer and wake agent
          </Button>
        </section>
      ) : null}

      {task.kind === 'human_check' && task.endedAt === null ? (
        <section className="border-b border-caution-fill/30 bg-caution-soft/45 px-4 py-4 sm:px-5">
          <div className="flex items-center gap-2 text-caution"><UserRoundCheck size={17} /><h3 className="text-xs font-semibold">Human release decision</h3></div>
          <FieldLabel htmlFor={'human-decision-' + task.id}>Decision rationale</FieldLabel>
          <textarea
            id={'human-decision-' + task.id}
            className={cn(inputClass, 'min-h-24 resize-y py-3')}
            placeholder="Why is this ready, or what must change?"
            value={drafts.decisionRationale}
            onChange={(event) => dispatchDraft({ type: 'rationale-changed', value: event.target.value })}
          />
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Button
              variant="mint"
              icon={<CheckCircle2 size={16} />}
              disabled={busy || drafts.decisionRationale.trim().length === 0}
              onClick={() => void runAction(actionErrorContexts.taskHumanCheckApprove(task.id), () => onDecideHumanCheck('completed', drafts.decisionRationale.trim())).then((saved) => { if (saved) dispatchDraft({ type: 'rationale-changed', value: '' }); })}
            >
              Approve
            </Button>
            <Button
              variant="danger"
              icon={<CircleAlert size={16} />}
              disabled={busy || drafts.decisionRationale.trim().length === 0}
              onClick={() => void runAction(actionErrorContexts.taskHumanCheckRequestChanges(task.id), () => onDecideHumanCheck('failed', drafts.decisionRationale.trim())).then((saved) => { if (saved) dispatchDraft({ type: 'rationale-changed', value: '' }); })}
            >
              Request changes
            </Button>
          </div>
        </section>
      ) : null}

      {task.kind !== 'human_check' && recovery !== null && !openQuestion ? (
        <section className="space-y-3 px-4 py-4 sm:px-5" aria-label="Task recovery actions">
          <div>
            <h3 className="text-xs font-semibold text-ink">Recover task</h3>
            <p className="mt-1 text-xs leading-5 text-muted">Retry the same assignment, choose another eligible agent, or return standalone work to the backlog.</p>
          </div>
          {recovery.retry ? (
            <Button className="w-full" variant="primary" icon={<Activity size={16} />} disabled={busy} onClick={() => void runAction(actionErrorContexts.taskRetry(task.id), onRetry)}>
              Retry
            </Button>
          ) : null}
          <div>
            <FieldLabel htmlFor={`recovery-agent-${task.id}`}>Replacement agent</FieldLabel>
            <select
              id={`recovery-agent-${task.id}`}
              className={inputClass}
              value={agentId}
              disabled={busy || recoveryAgents.length === 0}
              aria-describedby={busy || recovery.reassign.disabledReason ? `recovery-help-${task.id}` : undefined}
              onChange={(event) => setAgentId(event.target.value)}
            >
              {recoveryAgents.length === 0 ? <option value="">No eligible agents</option> : null}
              {recoveryAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} — {agent.area}</option>)}
            </select>
          </div>
          <Button
            className="w-full"
            variant={recovery.reassign.primary ? 'primary' : 'secondary'}
            icon={<UserRoundCheck size={16} />}
            disabled={busy || recovery.reassign.disabledReason !== null || agentId.length === 0}
            aria-describedby={busy || recovery.reassign.disabledReason ? `recovery-help-${task.id}` : undefined}
            onClick={() => void runAction(actionErrorContexts.taskRecoveryReassign(task.id), () => onAssign(agentId))}
          >
            Reassign
          </Button>
          {recovery.backlog ? (
            <Button className="w-full" icon={<ArrowLeft size={16} />} disabled={busy} onClick={() => void runAction(actionErrorContexts.taskRecoveryBacklog(task.id), onRecoveryBacklog)}>
              Return to backlog
            </Button>
          ) : null}
          {busy || recovery.reassign.disabledReason ? (
            <p id={`recovery-help-${task.id}`} className="text-xs leading-5 text-muted">
              {busy ? 'Recovery actions are temporarily unavailable while a board change is in progress.' : recovery.reassign.disabledReason}
            </p>
          ) : null}
        </section>
      ) : task.kind !== 'human_check' && (task.status === 'backlog' || task.status === 'proposed' || queuedUnclaimed) && !openQuestion ? (
        <section className="px-4 py-4 sm:px-5">
            <div className="space-y-3">
              {eligibleAgents.length > 0 ? (
                <select className={inputClass} aria-label={task.kind === 'manager_review' ? 'Assign manager' : 'Assign agent'} value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                  {eligibleAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} — {agent.area}</option>)}
                </select>
              ) : <p className="text-sm text-muted">No {task.requiredRole ?? 'eligible'} agent is available.</p>}
              <Button className="w-full" variant="primary" icon={<UserRoundCheck size={16} />} disabled={busy || agentId.length === 0 || (queuedUnclaimed && !assigneeChanged)} onClick={() => void runAction(actionErrorContexts.taskAssign(task.id), () => onAssign(agentId))}>
                {queuedUnclaimed ? task.kind === 'manager_review' ? 'Reassign manager and wake' : 'Reassign and wake agent' : task.kind === 'manager_review' ? 'Assign manager and wake' : 'Assign and wake agent'}
              </Button>
              {queuedUnclaimed ? <Button className="w-full" icon={<ArrowLeft size={16} />} disabled={busy} onClick={() => void runAction(actionErrorContexts.taskReturnToBacklog(task.id), onReturnToBacklog)}>Return to backlog</Button> : null}
            </div>
        </section>
      ) : null}

      {actionErrors.errors.length > 0 ? <div className="border-t border-line px-4 py-4 sm:px-5"><InlineActionErrors errors={actionErrors.errors} onDismiss={actionErrors.dismiss} /></div> : null}

      {task.kind !== 'human_check' && activeRun ? (
        <section className="flex items-center justify-between gap-3 px-4 py-4 sm:px-5">
          <span className="text-sm text-muted">Agent is working on this task.</span>
          <Button variant="danger" size="sm" icon={<Square size={14} />} disabled={busy} onClick={() => void runAction(actionErrorContexts.taskInterrupt(task.id, activeRun.id), () => onInterrupt(activeRun.id))}>Interrupt</Button>
        </section>
      ) : null}
      </Card>
    </section>
  );
}

function ProjectForm({
  busy,
  errors,
  onDismissError,
  onSubmit,
  onCancel,
  onDirtyChange,
}: {
  busy: boolean;
  errors: readonly ActionError[];
  onDismissError: (context: string) => void;
  onSubmit: (input: CreateProjectInput) => Promise<ActionResult>;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [workspacePath, setWorkspacePath] = useState('');
  const normalizedPath = workspacePath.trim().replace(/[\\/]+$/u, '');
  const projectName = normalizedPath.split(/[\\/]/u).at(-1)?.trim() ?? '';
  const validPath = projectName.length > 0 && projectName.length <= 160 && taskWorkspaceRefs(normalizedPath).length === 1;
  return (
    <form className="space-y-4 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); if (validPath) void onSubmit({ name: projectName, description: normalizedPath }); }}>
      <div>
        <FieldLabel htmlFor="project-folder">Project folder</FieldLabel>
        <input id="project-folder" className={cn(inputClass, 'font-mono text-xs')} autoFocus required value={workspacePath} onChange={(event) => {
          setWorkspacePath(event.target.value);
          onDirtyChange(fieldsAreDirty([event.target.value]));
        }} placeholder="/absolute/path/to/project" />
      </div>
      <InlineActionErrors errors={errors} onDismiss={onDismissError} />
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="submit" variant="primary" disabled={busy || !validPath}>Add project</Button>
        <Button disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function taskTitleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, ' ').trim();
  const firstLine = prompt.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  const summary = firstLine ?? normalized;
  if (summary.length <= 120) return summary;
  return `${summary.slice(0, 119).trimEnd()}…`;
}

function taskWorkspaceRefs(workspacePath?: string | null): string[] {
  const path = workspacePath?.trim();
  if (!path || path.length > 512 || /[\r\n]/u.test(path)) return [];
  const absolutePosixPath = path.startsWith('/');
  const absoluteWindowsPath = /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\]+\\[^\\]+/u.test(path);
  return absolutePosixPath || absoluteWindowsPath ? [path] : [];
}

function WorkItemForm({
  projects,
  defaultProjectId,
  busy,
  errors,
  onDismissError,
  onSubmit,
  onCancel,
  onDirtyChange,
}: {
  projects: BoardSnapshot['projects'];
  defaultProjectId: string | null;
  busy: boolean;
  errors: readonly ActionError[];
  onDismissError: (context: string) => void;
  onSubmit: (input: CreateWorkItemInput) => Promise<ActionResult>;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [priority, setPriority] = useState<CreateWorkItemInput['priority']>('normal');
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [idempotencyKey, setIdempotencyKey] = useState(randomUuid);
  const normalizedPrompt = prompt.trim();
  const projectChosen = projects.some((project) => project.id === projectId);
  const regenerateIdempotencyKey = () => setIdempotencyKey(randomUuid());
  const initialProjectId = defaultProjectId ?? '';
  const reportDirty = (next: {
    prompt?: string;
    priority?: CreateWorkItemInput['priority'];
    projectId?: string;
  }) => {
    onDirtyChange(
      fieldsAreDirty([next.prompt ?? prompt])
      || (next.priority ?? priority) !== 'normal'
      || (next.projectId ?? projectId) !== initialProjectId,
    );
  };
  return (
    <form
      className="space-y-4 p-5 sm:p-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!normalizedPrompt || !projectChosen) return;
        void onSubmit({
          originalRequest: normalizedPrompt,
          priority,
          projectId,
          idempotencyKey,
        });
      }}
    >
      <div>
        <FieldLabel htmlFor="task-prompt">Task</FieldLabel>
        <textarea
          id="task-prompt"
          className={cn(inputClass, 'min-h-32 resize-y py-3')}
          autoFocus
          required
          maxLength={16_000}
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
            reportDirty({ prompt: event.target.value });
            regenerateIdempotencyKey();
          }}
          placeholder="What should be done?"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <FieldLabel htmlFor="work-item-priority">Priority</FieldLabel>
          <select
            id="work-item-priority"
            className={inputClass}
            value={priority}
            onChange={(event) => {
              const nextPriority = event.target.value as CreateWorkItemInput['priority'];
              setPriority(nextPriority);
              reportDirty({ priority: nextPriority });
              regenerateIdempotencyKey();
            }}
          >
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div>
          <FieldLabel htmlFor="work-item-project">Project</FieldLabel>
          <select
            id="work-item-project"
            className={inputClass}
            required
            disabled={projects.length === 0}
            aria-describedby={projects.length === 0 ? 'work-item-project-help' : undefined}
            value={projectChosen ? projectId : ''}
            onChange={(event) => {
              setProjectId(event.target.value);
              reportDirty({ projectId: event.target.value });
              regenerateIdempotencyKey();
            }}
          >
            <option value="" disabled>Choose a project</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          {projects.length === 0 ? (
            <p id="work-item-project-help" className="mt-2 text-xs leading-5 text-muted">
              No projects exist yet. Close this form and choose Add project first.
            </p>
          ) : null}
        </div>
      </div>
      <InlineActionErrors errors={errors} onDismiss={onDismissError} />
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="submit" variant="primary" disabled={busy || !normalizedPrompt || !projectChosen}>
          {projectChosen ? 'Submit task' : 'Choose a project'}
        </Button>
        <Button disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

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
  const refreshSequence = useRef(0);
  const refreshController = useRef<AbortController | null>(null);
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

  const refresh = useCallback(async (quiet = false): Promise<boolean> => {
    const sequence = ++refreshSequence.current;
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    if (!quiet) setLoading(true);
    try {
      const next = await client.getSnapshot(controller.signal);
      if (sequence !== refreshSequence.current) return false;
      for (const task of next.tasks) observedTaskIds.current.add(task.id);
      setSnapshot(next);
      dispatchErrorPipeline({ type: 'snapshot-succeeded' });
      setConnectivityError(null);
      setSignInExpired(false);
      return true;
    } catch (caught) {
      if (controller.signal.aborted || sequence !== refreshSequence.current) return false;
      dispatchErrorPipeline({ type: 'snapshot-failed' });
      const signIn = signInFailure(caught);
      setSignInExpired(signIn?.canRetrySignIn ?? false);
      setConnectivityError(signIn?.message ?? (caught instanceof Error ? caught.message : 'Could not connect to the task board'));
      return false;
    } finally {
      if (sequence === refreshSequence.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    refreshController.current?.abort();
    setSnapshot(null);
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true);
    }, 5_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      refreshController.current?.abort();
      refreshSequence.current += 1;
    };
  }, [refresh]);

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
      await refresh(true);
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
      await refresh(true);
      return { ok: true };
    } catch (caught) {
      if (caught instanceof BoardApiError) {
        if (caught.code === 'WORK_ITEM_ENDED') {
          await refresh(true);
        }
        if (caught.code === 'WORK_ITEM_VERSION_CONFLICT' || caught.code === 'PLAN_NOT_PROPOSED') {
          await refresh(true);
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
      await refresh(true);
      return { ok: true };
    } catch (caught) {
      if (caught instanceof BoardApiError && (
        caught.code === 'TASK_TERMINAL'
        || caught.code === 'TASK_VERSION_CONFLICT'
        || caught.code === 'WORK_NODE_VERSION_CONFLICT'
      )) {
        await refresh(true);
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
  const taskRuns = snapshot?.runs.filter((run) => run.taskId === selectedTask?.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt)) ?? [];
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
    content = <DocumentsPage snapshot={snapshot} selectedDocumentId={page.documentId} client={client} connected={connected} onSelectDocument={(documentId) => navigate({ kind: 'documents', documentId })} onRefreshBoard={() => refresh(true)} />;
  } else if (page.kind === 'automation') {
    content = <AutomationPage client={client} connected={connected} editorState={automationEditorState} onEditorStateChange={setAutomationEditorState} />;
  } else if (page.kind === 'project' && pageProject) {
    content = <ProjectPage project={pageProject} snapshot={snapshot} client={client} connected={connected} onTask={openTask} onAddTask={() => openDialog('task', pageProject.id)} onSelectDocument={(documentId) => navigate({ kind: 'documents', documentId })} />;
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
                {allWorkItems.length === 0 && allTasks.length === 0 ? <EmptyState icon={<ListTodo size={19} />} title="Task list is empty" body="Submit an outcome to record it in durable intake." action={<Button size="sm" variant="primary" onClick={() => openDialog('task')}>Add task</Button>} /> : null}
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
    <WorkspaceFrame snapshot={snapshot} page={page} pointOfContact={pointOfContact} drawerOpen={drawerOpen} onDrawerChange={setDrawerOpen} onNavigate={navigate}>
      {errorPipeline.connectivityDown ? <div className="px-4 pt-4 sm:px-8 lg:px-12"><FormError><div className="flex items-start justify-between gap-4"><div><p className="font-semibold">{signInExpired ? 'Your sign-in has expired' : 'Task board unavailable'}</p><p className="mt-1 text-xs leading-5">{signInExpired ? 'Sign in again to continue. Existing durable state remains visible.' : `The board service is not reachable. ${connectivityError ?? 'Could not connect to the task board'}. Existing durable state remains visible. No demo data is being shown.`}</p></div>{signInExpired ? <button type="button" className="shrink-0 underline" onClick={() => globalThis.location.reload()}>Sign in again</button> : null}</div></FormError></div> : null}
      <div key={pageTransitionKey} className="cicada-page-enter">{content}</div>

      <Modal
        open={dialog === 'project'}
        onClose={closeDialog}
        isDirty={() => projectFormDirty.current}
        title="Add project from disk"
        description="Enter the project folder. Agent identities are created when the project receives work."
      >
        {(requestClose) => <ProjectForm
          busy={busy || !connected}
          errors={projectCreateErrors}
          onDismissError={dismissActionError}
          onSubmit={createProject}
          onCancel={requestClose}
          onDirtyChange={(dirty) => { projectFormDirty.current = dirty; }}
        />}
      </Modal>
      <Modal
        open={dialog === 'task'}
        onClose={closeDialog}
        isDirty={() => workItemFormDirty.current}
        title={dialogProject ? `Add a task to ${dialogProject.name}` : 'Add a task'}
        description="Records a durable intake request. This step does not wake an agent yet."
      >
        {(requestClose) => <WorkItemForm
          key={dialogProject?.id ?? 'unselected'}
          projects={snapshot?.projects ?? []}
          defaultProjectId={dialogProject?.id ?? null}
          busy={busy || !connected}
          errors={workItemCreateErrors}
          onDismissError={dismissActionError}
          onSubmit={createWorkItem}
          onCancel={requestClose}
          onDirtyChange={(dirty) => { workItemFormDirty.current = dirty; }}
        />}
      </Modal>
      {unanchoredActionErrors.length > 0 ? (
        <div className="fixed bottom-4 left-4 right-4 z-[70] mx-auto flex max-h-[calc(100dvh-2rem)] max-w-lg flex-col gap-2 overflow-y-auto overscroll-contain" role="region" aria-label="Action errors">
          {unanchoredActionErrors.map((entry) => (
            <Toast
              key={entry.context}
              onDismiss={() => dismissActionError(entry.context)}
            >
              {entry.error}
            </Toast>
          ))}
        </div>
      ) : null}
    </WorkspaceFrame>
  );
}
