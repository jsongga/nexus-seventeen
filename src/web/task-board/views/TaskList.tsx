import { Activity, Check, ChevronRight, CircleAlert, HelpCircle } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button, Card, Pill, Toast, cn } from '../../components/ui';
import type { ActionError } from '../model/action-errors';
import {
  prettyStatus,
  taskStatusTone,
  workItemStateTone,
  workItemStatusLabel,
} from '../model/work-item-labels';
import type {
  BoardAgent,
  BoardSnapshot,
  BoardTask,
  BoardWorkItem,
  TaskKind,
  WorkItemPriority,
} from '../types';

const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const workItemPriorityTone: Record<WorkItemPriority, 'neutral' | 'amber' | 'red' | 'blue' | 'purple'> = {
  urgent: 'red',
  high: 'amber',
  normal: 'blue',
  low: 'neutral',
  opportunistic: 'purple',
};


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


export function StatusPill({ task }: { task: BoardTask }) {
  return <Pill tone={taskStatusTone[task.status]} dot>{taskStatusLabel(task)}</Pill>;
}

function TaskKindPill({ kind }: { kind: TaskKind }) {
  const tone = kind === 'human_check' ? 'purple' : kind === 'manager_review' ? 'amber' : 'neutral';
  return <Pill tone={tone}>{taskKindLabel[kind]}</Pill>;
}

export function WorkItemRow({
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

export function EmptyState({
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

export function RemovedTaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
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

export function FormError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-md border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent">
      {children}
    </div>
  );
}

export function TaskRow({
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


function taskTitleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, ' ').trim();
  const firstLine = prompt.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  const summary = firstLine ?? normalized;
  if (summary.length <= 120) return summary;
  return `${summary.slice(0, 119).trimEnd()}…`;
}

export function ActionErrorToasts({
  errors,
  onDismiss,
}: {
  errors: readonly ActionError[];
  onDismiss: (context: string) => void;
}) {
  return errors.length > 0 ? (
    <div className="fixed bottom-4 left-4 right-4 z-[70] mx-auto flex max-h-[calc(100dvh-2rem)] max-w-lg flex-col gap-2 overflow-y-auto overscroll-contain" role="region" aria-label="Action errors">
      {errors.map((entry) => (
        <Toast
          key={entry.context}
          onDismiss={() => onDismiss(entry.context)}
        >
          {entry.error}
        </Toast>
      ))}
    </div>
  ) : null;
}
