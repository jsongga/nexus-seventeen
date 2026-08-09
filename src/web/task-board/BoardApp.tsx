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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Card, FieldLabel, Modal, Pill, cn, inputClass } from '../components/ui';
import { AutomationPage } from './views/AutomationPage';
import { emptyAutomationEditorState } from './model/automation-model';
import { BoardApiError, createTaskBoardClient, randomUuid, type TaskBoardClient } from './data/client';
import { DocumentsPage } from './views/DocumentsPage';
import { useHashRoute } from './routing/useHashRoute';
import { AgentPage, ProjectPage } from './views/WorkspacePages';
import { WorkspaceFrame, type BoardPage } from './views/WorkspaceSidebar';
import {
  isExplicitPointOfContact,
  selectPointOfContact,
} from './model/workspace-model';
import type {
  BoardAgent,
  BoardQuestion,
  BoardRun,
  BoardSnapshot,
  BoardTask,
  BoardWorkItem,
  CreateAgentInput,
  CreateProjectInput,
  CreateWorkItemInput,
  TaskKind,
  TaskStatus,
  WorkItemPriority,
  WorkItemStage,
  WorkItemState,
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
};

const workItemStateTone: Record<WorkItemState, 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'purple'> = {
  submitted: 'blue',
  processing: 'green',
  needs_input: 'amber',
  waiting_for_human_review: 'amber',
  completed: 'green',
  failed: 'red',
  cancelled: 'neutral',
};

const workItemPriorityTone: Record<WorkItemPriority, 'neutral' | 'amber' | 'red' | 'blue' | 'purple'> = {
  urgent: 'red',
  high: 'amber',
  normal: 'blue',
  low: 'neutral',
  opportunistic: 'purple',
};

const workItemStageLabel: Record<WorkItemStage, string> = {
  refinement: 'Improving task',
  project_resolution: 'Resolving project',
  research: 'Researching',
  planning: 'Planning',
  implementation: 'Implementing',
  testing: 'Testing',
  verification: 'Verifying',
  human_review: 'Preparing human review',
  deployment: 'Deploying',
};

type DialogName = 'project' | 'task' | null;

function prettyStatus(value: string): string {
  return value.replaceAll('_', ' ');
}

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
    || task.status === 'interrupted';
}

function StatusPill({ task }: { task: BoardTask }) {
  return <Pill tone={statusTone[task.status]} dot>{taskStatusLabel(task)}</Pill>;
}

function TaskKindPill({ kind }: { kind: TaskKind }) {
  const tone = kind === 'human_check' ? 'purple' : kind === 'manager_review' ? 'amber' : 'neutral';
  return <Pill tone={tone}>{taskKindLabel[kind]}</Pill>;
}

function workItemStatusLabel(workItem: BoardWorkItem): string {
  if (workItem.state === 'submitted') return 'Submitted · Refinement pending';
  if (workItem.state === 'processing') {
    return workItem.currentStage ? `Processing · ${workItemStageLabel[workItem.currentStage]}` : 'Processing';
  }
  if (workItem.state === 'needs_input') return 'Needs input';
  if (workItem.state === 'waiting_for_human_review') return 'Waiting for human review';
  return prettyStatus(workItem.state);
}

function WorkItemRow({ workItem, projects }: { workItem: BoardWorkItem; projects: BoardSnapshot['projects'] }) {
  const projectId = workItem.resolvedProjectId
    ?? (workItem.projectTarget.mode === 'explicit' ? workItem.projectTarget.projectId : null);
  const projectName = projectId === null
    ? 'Project: Auto'
    : projects.find((project) => project.id === projectId)?.name ?? projectId;
  const displayRequest = workItem.refinedObjective?.trim() || workItem.originalRequest;
  return (
    <article className="mx-2 rounded-md border-b border-line px-3 py-4 last:border-b-0">
      <div className="flex items-start gap-4">
        <span className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-[99px] border border-taupe text-taupe" aria-hidden="true">
          <Activity size={12} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="font-display text-[15px] font-normal leading-5 text-ink">{taskTitleFromPrompt(displayRequest)}</h3>
            <Pill tone={workItemPriorityTone[workItem.priority]}>{workItem.priority} priority</Pill>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
            <Pill tone={workItemStateTone[workItem.state]} dot>{workItemStatusLabel(workItem)}</Pill>
            <span>{projectName}</span>
          </div>
        </div>
      </div>
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
}: {
  task: BoardTask;
  selected: boolean;
  agent: BoardAgent | undefined;
  projectName?: string;
  openQuestion: boolean;
  onSelect: () => void;
}) {
  const completed = task.status === 'completed';
  const statusDot = task.status === 'running'
    ? 'bg-success-fill'
    : task.status === 'waiting_for_human' || task.status === 'blocked'
      ? 'bg-taupe'
      : 'bg-muted/55';
  return (
    <button
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
  busy,
  onAssign,
  onReturnToBacklog,
  onAnswer,
  onResume,
  onInterrupt,
  onDecideHumanCheck,
}: {
  task: BoardTask;
  agents: BoardAgent[];
  questions: BoardQuestion[];
  runs: BoardRun[];
  busy: boolean;
  onAssign: (agentId: string) => Promise<void>;
  onReturnToBacklog: () => Promise<void>;
  onAnswer: (questionId: string, answer: string) => Promise<void>;
  onResume: () => Promise<void>;
  onInterrupt: (runId: string) => Promise<void>;
  onDecideHumanCheck: (status: 'completed' | 'failed', rationale: string) => Promise<boolean>;
}) {
  const eligibleAgents = useMemo(
    () => task.requiredRole === null ? agents : agents.filter((agent) => agent.role === task.requiredRole),
    [agents, task.requiredRole],
  );
  const defaultAgentId = task.assignedAgentId ?? eligibleAgents[0]?.id ?? '';
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [answer, setAnswer] = useState('');
  const [decisionRationale, setDecisionRationale] = useState('');
  const openQuestion = questions.find((question) => question.status === 'open');
  const activeRun = runs.find((run) => run.status === 'running' || run.status === 'queued');
  const queuedUnclaimed = task.status === 'queued' && !activeRun;
  const assigneeChanged = agentId !== task.assignedAgentId;

  useEffect(() => {
    setAgentId(defaultAgentId);
    setAnswer('');
    setDecisionRationale('');
  }, [defaultAgentId, task.id]);

  return (
    <Card className="overflow-hidden">
      <header className="border-b border-line px-4 py-5 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Current status</p>
            <StatusPill task={task} />
          </div>
          {task.expectedAgentMinutes !== null ? <span className="text-[11px] text-muted">About {task.expectedAgentMinutes} agent min</span> : null}
        </div>
        <h2 className="mt-4 break-words font-display text-xl font-light tracking-[0.01em] text-ink">{task.title}</h2>
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
          <textarea
            className={cn(inputClass, 'mt-3 min-h-24 resize-y py-3')}
            placeholder="Give the missing context…"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <Button
            className="mt-3 w-full"
            variant="primary"
            icon={<Send size={16} />}
            disabled={busy || answer.trim().length === 0}
            onClick={() => void onAnswer(openQuestion.id, answer.trim()).then(() => setAnswer(''))}
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
            value={decisionRationale}
            onChange={(event) => setDecisionRationale(event.target.value)}
          />
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Button
              variant="mint"
              icon={<CheckCircle2 size={16} />}
              disabled={busy || decisionRationale.trim().length === 0}
              onClick={() => void onDecideHumanCheck('completed', decisionRationale.trim()).then((saved) => { if (saved) setDecisionRationale(''); })}
            >
              Approve
            </Button>
            <Button
              variant="danger"
              icon={<CircleAlert size={16} />}
              disabled={busy || decisionRationale.trim().length === 0}
              onClick={() => void onDecideHumanCheck('failed', decisionRationale.trim()).then((saved) => { if (saved) setDecisionRationale(''); })}
            >
              Request changes
            </Button>
          </div>
        </section>
      ) : null}

      {task.kind !== 'human_check' && (task.status === 'backlog' || task.status === 'proposed' || task.status === 'blocked' || task.status === 'interrupted' || task.status === 'failed' || queuedUnclaimed) && !openQuestion ? (
        <section className="px-4 py-4 sm:px-5">
          {task.status === 'blocked' || task.status === 'interrupted' || task.status === 'failed' ? (
            <Button className="w-full" variant="mint" icon={<Activity size={16} />} disabled={busy || !task.assignedAgentId} onClick={() => void onResume()}>
              Resume agent
            </Button>
          ) : (
            <div className="space-y-3">
              {eligibleAgents.length > 0 ? (
                <select className={inputClass} aria-label={task.kind === 'manager_review' ? 'Assign manager' : 'Assign agent'} value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                  {eligibleAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} — {agent.area}</option>)}
                </select>
              ) : <p className="text-sm text-muted">No {task.requiredRole ?? 'eligible'} agent is available.</p>}
              <Button className="w-full" variant="primary" icon={<UserRoundCheck size={16} />} disabled={busy || agentId.length === 0 || (queuedUnclaimed && !assigneeChanged)} onClick={() => void onAssign(agentId)}>
                {queuedUnclaimed ? task.kind === 'manager_review' ? 'Reassign manager and wake' : 'Reassign and wake agent' : task.kind === 'manager_review' ? 'Assign manager and wake' : 'Assign and wake agent'}
              </Button>
              {queuedUnclaimed ? <Button className="w-full" icon={<ArrowLeft size={16} />} disabled={busy} onClick={() => void onReturnToBacklog()}>Return to backlog</Button> : null}
            </div>
          )}
        </section>
      ) : null}

      {task.kind !== 'human_check' && activeRun ? (
        <section className="flex items-center justify-between gap-3 px-4 py-4 sm:px-5">
          <span className="text-sm text-muted">Agent is working on this task.</span>
          <Button variant="danger" size="sm" icon={<Square size={14} />} disabled={busy} onClick={() => void onInterrupt(activeRun.id)}>Interrupt</Button>
        </section>
      ) : null}
    </Card>
  );
}

function ProjectForm({ busy, onSubmit }: { busy: boolean; onSubmit: (input: CreateProjectInput) => Promise<void> }) {
  const [workspacePath, setWorkspacePath] = useState('');
  const normalizedPath = workspacePath.trim().replace(/[\\/]+$/u, '');
  const projectName = normalizedPath.split(/[\\/]/u).at(-1)?.trim() ?? '';
  const validPath = projectName.length > 0 && projectName.length <= 160 && taskWorkspaceRefs(normalizedPath).length === 1;
  return (
    <form className="space-y-4 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); if (validPath) void onSubmit({ name: projectName, description: normalizedPath }); }}>
      <div>
        <FieldLabel htmlFor="project-folder">Project folder</FieldLabel>
        <input id="project-folder" className={cn(inputClass, 'font-mono text-xs')} autoFocus required value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="/absolute/path/to/project" />
      </div>
      <Button className="w-full" type="submit" variant="primary" disabled={busy || !validPath}>Add project</Button>
    </form>
  );
}

function automaticEngineerId(projectName: string, agents: BoardAgent[]): string {
  const slug = projectName.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'project';
  const base = `${slug.slice(0, 96)}-engineer`;
  const used = new Set(agents.map((agent) => agent.id));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
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
  onSubmit,
}: {
  projects: BoardSnapshot['projects'];
  defaultProjectId: string | null;
  busy: boolean;
  onSubmit: (input: CreateWorkItemInput) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState('');
  const [priority, setPriority] = useState<CreateWorkItemInput['priority']>('normal');
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [idempotencyKey, setIdempotencyKey] = useState(randomUuid);
  const normalizedPrompt = prompt.trim();
  const projectChosen = projects.some((project) => project.id === projectId);
  const regenerateIdempotencyKey = () => setIdempotencyKey(randomUuid());
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
              setPriority(event.target.value as CreateWorkItemInput['priority']);
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
      <Button className="w-full" type="submit" variant="primary" disabled={busy || !normalizedPrompt || !projectChosen}>
        {projectChosen ? 'Submit task' : 'Choose a project'}
      </Button>
    </form>
  );
}

function missingRouteFallback(page: BoardPage, snapshot: BoardSnapshot): BoardPage | null {
  if (page.kind === 'project' && !snapshot.projects.some((project) => project.id === page.projectId)) return { kind: 'tasks' };
  if (page.kind === 'agent' && !snapshot.agents.some((agent) => agent.id === page.agentId)) return { kind: 'tasks' };
  if (page.kind === 'documents' && page.documentId && !snapshot.documents.some((document) => document.id === page.documentId)) return { kind: 'documents' };
  return null;
}

export function BoardApp() {
  const client = useMemo<TaskBoardClient>(() => createTaskBoardClient({ baseUrl: '/board-api' }), []);
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [page, navigate] = useHashRoute();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDetailOpen, setTaskDetailOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [dialogProjectId, setDialogProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signInExpired, setSignInExpired] = useState(false);
  const [automationEditorState, setAutomationEditorState] = useState(emptyAutomationEditorState);
  const refreshSequence = useRef(0);
  const refreshController = useRef<AbortController | null>(null);

  const refresh = useCallback(async (quiet = false): Promise<boolean> => {
    const sequence = ++refreshSequence.current;
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    if (!quiet) setLoading(true);
    try {
      const next = await client.getSnapshot(controller.signal);
      if (sequence !== refreshSequence.current) return false;
      setSnapshot(next);
      setError(null);
      setConnected(true);
      setSelectedTaskId((current) => current && next.tasks.some((task) => task.id === current) ? current : null);
      return true;
    } catch (caught) {
      if (controller.signal.aborted || sequence !== refreshSequence.current) return false;
      setConnected(false);
      const signIn = signInFailure(caught);
      setSignInExpired(signIn?.canRetrySignIn ?? false);
      setError(signIn?.message ?? (caught instanceof Error ? caught.message : 'Could not connect to the task board'));
      return false;
    } finally {
      if (sequence === refreshSequence.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    refreshController.current?.abort();
    setSnapshot(null);
    setSelectedTaskId(null);
    setTaskDetailOpen(false);
    setConnected(false);
    setError(null);
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
    const fallback = missingRouteFallback(page, snapshot);
    if (fallback !== null) navigate(fallback, 'replace');
  }, [navigate, page, snapshot]);

  const mutate = useCallback(async (operation: () => Promise<unknown>): Promise<boolean> => {
    if (!connected) {
      setError('The board service is not reachable, so changes are unavailable');
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      await operation();
      setDialog(null);
      await refresh(true);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The change could not be saved');
      return false;
    } finally {
      setBusy(false);
    }
  }, [connected, refresh]);

  const allTasks = useMemo(() => [...(snapshot?.tasks ?? [])].sort((left, right) => left.orderKey - right.orderKey || left.id.localeCompare(right.id)), [snapshot]);
  const allWorkItems = snapshot?.workItems ?? [];
  const activeTasks = allTasks.filter((task) => task.status !== 'completed');
  const completedTasks = allTasks.filter((task) => task.status === 'completed');
  const selectedTask = allTasks.find((task) => task.id === selectedTaskId) ?? allTasks[0];
  const selectedTaskAgents = snapshot?.agents.filter((agent) => agent.projectId === selectedTask?.projectId) ?? [];
  const taskQuestions = snapshot?.questions.filter((question) => question.taskId === selectedTask?.id) ?? [];
  const taskRuns = snapshot?.runs.filter((run) => run.taskId === selectedTask?.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt)) ?? [];
  const openQuestionIds = new Set(snapshot?.questions.filter((question) => question.status === 'open').map((question) => question.taskId));
  const pointOfContact = selectPointOfContact(snapshot?.agents ?? []);
  const pageProject = page.kind === 'project' ? snapshot?.projects.find((project) => project.id === page.projectId) : undefined;
  const pageAgent = page.kind === 'agent' ? snapshot?.agents.find((agent) => agent.id === page.agentId) : undefined;
  const dialogProject = snapshot?.projects.find((project) => project.id === dialogProjectId);
  function openTask(taskId: string) {
    setSelectedTaskId(taskId);
    navigate({ kind: 'tasks' });
    setTaskDetailOpen(true);
  }

  function openDialog(name: Exclude<DialogName, null>, projectId?: string) {
    setDialogProjectId(projectId ?? null);
    setDialog(name);
  }

  async function createProject(input: CreateProjectInput): Promise<void> {
    await mutate(async () => {
      const project = await client.createProject(input);
      const agentId = automaticEngineerId(project.name, snapshot?.agents ?? []);
      const token = `${randomUuid()}${randomUuid()}`;
      const profile: CreateAgentInput = {
        projectId: project.id,
        agentId,
        role: 'engineer',
        area: project.name,
        mission: `Own ${project.name}. Research, plan, implement, test, and record concise progress until assigned work is complete.`,
        model: pointOfContact?.model ?? snapshot?.agents[0]?.model ?? 'auto',
        token,
      };
      await client.createAgent(profile);
      window.sessionStorage.setItem(`cicada.pendingAgentToken.${agentId}`, token);
    });
  }

  async function createWorkItem(input: CreateWorkItemInput) {
    await mutate(() => client.createWorkItem(input));
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
    content = <AgentPage key={pageAgent.id} agent={pageAgent} snapshot={snapshot} isPointOfContact={pageAgent.id === pointOfContact?.id} explicitPointOfContact={pageAgent.id === pointOfContact?.id && isExplicitPointOfContact(pageAgent)} busy={busy || !connected} onTask={openTask} onSend={(prompt, workspaceRefs, routingContext, recentConversation) => mutate(() => client.createAgentQuery({ projectId: pageAgent.projectId, agentId: pageAgent.id, assignedRole: pageAgent.role, prompt, workspaceRefs, routingContext, recentConversation }))} onAnswer={(questionId, answer) => mutate(() => client.answerQuestion(questionId, { answer }))} />;
  } else {
    content = (
      <>
        <header className={cn('grid-cols-[minmax(0,1fr)_auto] items-start gap-4 border-b border-line bg-canvas px-4 py-5 sm:px-8 lg:items-center lg:px-12 lg:py-8', taskDetailOpen ? 'hidden xl:grid' : 'grid')}>
          <div><h1 className="font-display text-2xl font-light tracking-[0.02em] sm:text-[28px]">Task List</h1><p className="mt-1.5 text-sm font-light text-muted">New requests enter durable intake for refinement and planning.</p></div>
          <div className="flex flex-wrap gap-2.5">
            <Button className="size-11 min-h-0 rounded-[99px] p-0 sm:size-10" size="sm" variant="primary" icon={<Plus size={18} strokeWidth={1.6} />} aria-label="Add task" title="Add task" disabled={!connected} onClick={() => openDialog('task')} />
            <Button className="size-11 min-h-0 rounded-[99px] p-0 sm:size-10" size="sm" icon={<FolderKanban size={17} strokeWidth={1.5} />} aria-label="Add project" title="Add project from disk" disabled={!connected} onClick={() => openDialog('project')} />
            {taskDetailOpen ? <Button className="size-11 min-h-0 rounded-[99px] p-0 sm:size-10" size="sm" icon={<RefreshCw size={17} strokeWidth={1.5} className={loading ? 'animate-spin' : ''} />} aria-label="Refresh" title="Refresh" disabled={loading} onClick={() => void refresh()} /> : null}
          </div>
        </header>
        <main className="w-full max-w-[1600px] p-4 sm:px-8 sm:py-6 lg:px-12 lg:py-8">
          <div className={cn('grid items-start gap-8', taskDetailOpen ? 'xl:grid-cols-[minmax(360px,.92fr)_minmax(420px,1.08fr)] xl:gap-10' : 'max-w-5xl')}>
            <div className={cn('min-w-0', taskDetailOpen ? 'hidden xl:block' : 'block')}>
              <div className="space-y-8">
                {allWorkItems.length > 0 ? (
                  <section aria-labelledby="automation-intake-heading">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h2 id="automation-intake-heading" className="font-display text-lg font-light tracking-[0.01em] text-ink">Automation intake</h2>
                      <span className="text-xs text-muted">{allWorkItems.length}</span>
                    </div>
                    <div>{allWorkItems.map((workItem) => <WorkItemRow key={workItem.id} workItem={workItem} projects={snapshot.projects} />)}</div>
                  </section>
                ) : null}
                {allTasks.length > 0 ? (
                  <>
                    <section aria-labelledby="active-work-heading">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <h2 id="active-work-heading" className="font-display text-lg font-light tracking-[0.01em] text-ink">Board tasks</h2>
                        <span className="text-xs text-muted">{activeTasks.length}</span>
                      </div>
                      <div>{activeTasks.length > 0 ? activeTasks.map((task) => <TaskRow key={task.id} task={task} selected={taskDetailOpen && task.id === selectedTask?.id} agent={snapshot.agents.find((agent) => agent.id === task.assignedAgentId)} projectName={snapshot.projects.find((project) => project.id === task.projectId)?.name} openQuestion={openQuestionIds.has(task.id)} onSelect={() => openTask(task.id)} />) : <p className="border-b border-line px-1 py-5 text-sm text-muted">No active board tasks.</p>}</div>
                    </section>
                  {completedTasks.length > 0 ? (
                    <section aria-labelledby="completed-work-heading">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <h2 id="completed-work-heading" className="font-display text-lg font-light tracking-[0.01em] text-ink">Completed board tasks</h2>
                        <span className="text-xs text-muted">{completedTasks.length}</span>
                      </div>
                      <div>{completedTasks.map((task) => <TaskRow key={task.id} task={task} selected={taskDetailOpen && task.id === selectedTask?.id} agent={snapshot.agents.find((agent) => agent.id === task.assignedAgentId)} projectName={snapshot.projects.find((project) => project.id === task.projectId)?.name} openQuestion={openQuestionIds.has(task.id)} onSelect={() => openTask(task.id)} />)}</div>
                    </section>
                  ) : null}
                  </>
                ) : null}
                {allWorkItems.length === 0 && allTasks.length === 0 ? <EmptyState icon={<ListTodo size={19} />} title="Task list is empty" body="Submit an outcome to record it in durable intake." action={<Button size="sm" variant="primary" onClick={() => openDialog('task')}>Add task</Button>} /> : null}
              </div>
            </div>
            <div className={cn(taskDetailOpen ? 'cicada-page-enter block' : 'hidden')}>
              {taskDetailOpen ? <div className="mb-3 flex items-center justify-between gap-2 xl:hidden"><Button size="sm" icon={<ArrowLeft size={15} />} onClick={() => setTaskDetailOpen(false)}>Back to task list</Button><Button size="sm" icon={<RefreshCw size={15} className={loading ? 'animate-spin' : ''} />} disabled={loading} onClick={() => void refresh()}>Refresh</Button></div> : null}
              {selectedTask ? <TaskDetail key={selectedTask.id} task={selectedTask} agents={selectedTaskAgents} questions={taskQuestions} runs={taskRuns} busy={busy || !connected} onAssign={async (agentId) => { await mutate(() => client.assignTask(selectedTask.id, { agentId, version: selectedTask.version })); }} onReturnToBacklog={async () => { await mutate(() => client.returnTaskToBacklog(selectedTask.id, { version: selectedTask.version })); }} onAnswer={async (questionId, answer) => { await mutate(() => client.answerQuestion(questionId, { answer })); }} onResume={async () => { await mutate(() => client.resumeTask(selectedTask.id, { version: selectedTask.version })); }} onInterrupt={async (runId) => { await mutate(() => client.interruptRun(runId)); }} onDecideHumanCheck={async (status, rationale) => { const result = status === 'completed' ? `Approved for an external human-controlled release step.\n\nRationale: ${rationale}` : `Changes requested by human.\n\nRationale: ${rationale}`; return mutate(() => client.decideHumanCheck(selectedTask.id, { version: selectedTask.version, status, result })); }} /> : <Card><EmptyState icon={<CirclePause size={19} />} title="Nothing selected" body="Choose a task to see its description, status, and phases." /></Card>}
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
      : page.kind === 'documents'
        ? 'documents'
        : page.kind === 'automation'
          ? 'automation'
          : 'tasks';

  return (
    <WorkspaceFrame snapshot={snapshot} page={page} pointOfContact={pointOfContact} drawerOpen={drawerOpen} onDrawerChange={setDrawerOpen} onNavigate={(next) => { navigate(next); setTaskDetailOpen(false); }}>
      {error ? <div className="px-4 pt-4 sm:px-8 lg:px-12"><FormError><div className="flex items-start justify-between gap-4"><div><p className="font-semibold">{signInExpired ? 'Your sign-in has expired' : 'Task board unavailable'}</p><p className="mt-1 text-xs leading-5">{signInExpired ? 'Sign in again to continue. Existing durable state remains visible.' : `The board service is not reachable. ${error}. Existing durable state remains visible. No demo data is being shown.`}</p></div>{signInExpired ? <button type="button" className="shrink-0 underline" onClick={() => globalThis.location.reload()}>Sign in again</button> : null}</div></FormError></div> : null}
      <div key={pageTransitionKey} className="cicada-page-enter">{content}</div>

      <Modal open={dialog === 'project'} onClose={() => setDialog(null)} title="Add project from disk" description="Enter the project folder. Its name, workspace scope, and engineer profile are added automatically."><ProjectForm busy={busy || !connected} onSubmit={createProject} /></Modal>
      <Modal open={dialog === 'task'} onClose={() => setDialog(null)} title={dialogProject ? `Add a task to ${dialogProject.name}` : 'Add a task'} description="Records a durable intake request. This step does not wake an agent yet."><WorkItemForm key={dialogProject?.id ?? 'unselected'} projects={snapshot?.projects ?? []} defaultProjectId={dialogProject?.id ?? null} busy={busy || !connected} onSubmit={createWorkItem} /></Modal>
      {error && dialog ? <div role="alert" className="fixed bottom-4 left-4 right-4 z-[70] mx-auto max-w-lg rounded-xl border border-urgent/25 bg-urgent-soft px-4 py-3 text-sm text-urgent shadow-[0_12px_34px_rgba(23,28,36,.18)]"><div className="flex items-start justify-between gap-3"><span>{error}</span><button type="button" className="font-bold" onClick={() => setError(null)} aria-label="Dismiss error">×</button></div></div> : null}
    </WorkspaceFrame>
  );
}
