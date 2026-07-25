import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BrainCircuit,
  Check,
  CheckCircle2,
  CircleDollarSign,
  CircleX,
  ClipboardCheck,
  Clock3,
  Code2,
  Cpu,
  FileCode2,
  FlaskConical,
  Hourglass,
  LockKeyhole,
  ListPlus,
  ListTodo,
  NotebookPen,
  Octagon,
  Play,
  Radio,
  Search,
  ShieldCheck,
  TerminalSquare,
  TimerReset,
  Wrench,
  X,
} from 'lucide-react';
import {
  isInterruptPending,
  isInterruptSettled,
  isRunStateUncertain,
  type DemoRun,
} from '../data/demo';
import { ImpactSummaryCard } from './ImpactSummaryCard';
import { useDialogLayer } from './dialog-stack';
import { Avatar, Button, cn, Pill, ProgressBar } from './ui';
import { formatAgentMinutes, formatTaskTimestamp } from '../task-time';

export interface RunInspectorProps {
  run: DemoRun | null;
  open: boolean;
  onClose: () => void;
  onQueue?: (run: DemoRun) => void;
  onInterrupt?: (run: DemoRun) => void;
  onResume?: (run: DemoRun) => void;
}

const phaseLabels: Record<DemoRun['loopPhase'], string> = {
  research: 'Research',
  plan: 'Plan',
  execute: 'Execute',
  test: 'Test',
  manager_review: 'Manager review',
};

const actionIcons = {
  analysis: BrainCircuit,
  file: FileCode2,
  command: TerminalSquare,
  review: ClipboardCheck,
} satisfies Record<DemoRun['currentAction']['kind'], typeof Activity>;

const actionLabels: Record<DemoRun['currentAction']['kind'], string> = {
  analysis: 'Analysis',
  file: 'File change',
  command: 'Command',
  review: 'Review',
};

const loopIcons = {
  Research: Search,
  Plan: NotebookPen,
  Execute: Code2,
  Test: FlaskConical,
} satisfies Record<DemoRun['loopSteps'][number]['phase'], typeof Activity>;

const loopStatus = {
  done: {
    label: 'Done',
    icon: Check,
    card: 'border-[#cfe2df] bg-[#f5faf9]',
    iconClass: 'bg-teal-soft text-teal-700',
    labelClass: 'text-teal-700',
  },
  active: {
    label: 'Active',
    icon: Activity,
    card: 'border-[#8fc8c2] bg-teal-soft',
    iconClass: 'bg-teal-500 text-ink',
    labelClass: 'text-teal-700',
  },
  queued: {
    label: 'Queued',
    icon: Hourglass,
    card: 'border-line bg-white',
    iconClass: 'bg-line-soft text-[#65707b]',
    labelClass: 'text-muted',
  },
  failed: {
    label: 'Needs work',
    icon: CircleX,
    card: 'border-[#e5b7b3] bg-urgent-soft',
    iconClass: 'bg-[#f8d8d5] text-urgent',
    labelClass: 'text-urgent',
  },
} satisfies Record<DemoRun['loopSteps'][number]['status'], {
  label: string;
  icon: typeof Activity;
  card: string;
  iconClass: string;
  labelClass: string;
}>;

const journalTones = {
  note: {
    icon: NotebookPen,
    marker: 'border-[#ccd9e2] bg-[#eef3f6] text-[#3f6073]',
    evidence: 'border-[#d9e1e7] bg-[#f5f7f9] text-[#4c6472]',
  },
  success: {
    icon: CheckCircle2,
    marker: 'border-[#b9ddd9] bg-teal-soft text-teal-700',
    evidence: 'border-[#cfe2df] bg-[#f5faf9] text-[#416b66]',
  },
  warning: {
    icon: TimerReset,
    marker: 'border-[#ead09b] bg-caution-soft text-caution',
    evidence: 'border-[#eadcb9] bg-[#fff9ea] text-caution',
  },
} satisfies Record<DemoRun['journal'][number]['tone'], {
  icon: typeof Activity;
  marker: string;
  evidence: string;
}>;

const formatTokens = (tokens: number) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens);

export function RunInspector({ run, open, onClose, onQueue, onInterrupt, onResume }: RunInspectorProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const [visualViewportTop, setVisualViewportTop] = useState(0);
  const activeRunId = run?.id;
  const { isTopmost } = useDialogLayer({
    open: open && run !== null,
    onClose,
    containerRef: dialogRef,
  });

  useEffect(() => {
    if (!open || !run) return;

    const visualViewport = window.visualViewport;
    const syncVisualViewport = () => setVisualViewportTop(Math.max(0, visualViewport?.offsetTop ?? 0));

    syncVisualViewport();
    visualViewport?.addEventListener('resize', syncVisualViewport);
    visualViewport?.addEventListener('scroll', syncVisualViewport);

    return () => {
      visualViewport?.removeEventListener('resize', syncVisualViewport);
      visualViewport?.removeEventListener('scroll', syncVisualViewport);
    };
  }, [activeRunId, open]);

  if (!open || !run) return null;

  const ActionIcon = actionIcons[run.currentAction.kind];
  const tokenPercent = run.tokenLimit === 0 ? 0 : (run.tokens / run.tokenLimit) * 100;
  const isManagerReview = run.loopPhase === 'manager_review';
  const isInterrupted = isInterruptSettled(run.controlState);
  const interruptPending = isInterruptPending(run.controlState);
  const interruptUnknown = isRunStateUncertain(run.controlState);
  const interruptRefused = run.controlState === 'interrupt_refused';
  const laneIdle = run.controlState === 'idle';
  const controlRestricted = isInterrupted || interruptPending || interruptUnknown || laneIdle;
  const workspacePaused = run.workspacePaused === true;
  const executionInactive = controlRestricted || workspacePaused;
  const taskForecastPaused =
    run.agentTask?.status !== 'completed' &&
    (run.agentTask?.status === 'paused' || workspacePaused || interruptUnknown || laneIdle);
  const controlLabel = isInterrupted
    ? 'Agent interrupted'
    : run.controlState === 'interrupt_requested'
      ? 'Interrupt requested'
      : run.controlState === 'interrupt_acknowledged'
        ? 'Worker acknowledged'
        : interruptUnknown
          ? 'Worker state unknown'
          : interruptRefused
            ? 'Interrupt refused'
            : workspacePaused
              ? 'Workspace paused'
              : laneIdle
                ? 'Lane idle'
                : 'Live agent view';
  const orderedQueue = [...run.queue].sort((left, right) => {
    if (left.position === right.position) return 0;
    return left.position === 'next' ? -1 : 1;
  });

  return (
    <div
      className={cn(
        'fixed inset-x-0 bottom-0 z-[60] bg-ink/45 backdrop-blur-[2px]',
        !isTopmost && 'pointer-events-none',
      )}
      style={{ top: visualViewportTop }}
      role="presentation"
      aria-hidden={isTopmost ? undefined : true}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={() => {
          if (isTopmost) onClose();
        }}
        aria-label="Close live run inspector"
        tabIndex={isTopmost ? 0 : -1}
      />
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal={isTopmost ? 'true' : undefined}
        aria-labelledby="run-inspector-title"
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-full max-w-[620px] flex-col overflow-hidden border-l border-line bg-canvas shadow-[-24px_0_60px_rgba(23,28,36,.18)]"
      >
        <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-line bg-white/92 px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur sm:px-6 sm:py-3.5">
          <button
            type="button"
            onClick={onClose}
            data-dialog-initial-focus
            className="grid size-11 shrink-0 place-items-center rounded-[10px] text-muted transition-colors hover:bg-line-soft hover:text-ink lg:order-last"
            aria-label="Close live run inspector"
          >
            <ArrowLeft size={20} className="lg:hidden" />
            <X size={20} className="hidden lg:block" />
          </button>
          <div className="min-w-0 flex-1">
            <div className={cn(
              'flex items-center gap-2 text-[11px] font-semibold',
              executionInactive || interruptRefused ? 'text-caution' : 'text-teal-700',
            )}>
              <span className="relative flex size-2.5" aria-hidden="true">
                <span className={cn('relative inline-flex size-2.5 rounded-full', executionInactive || interruptRefused ? 'bg-caution-fill' : 'bg-teal-500')} />
              </span>
              {controlLabel}
            </div>
            <h1 id="run-inspector-title" className="mt-0.5 truncate font-display text-base font-semibold tracking-[-0.02em]">
              {run.agent} · {run.workItemId}
            </h1>
          </div>
          <div className="hidden text-right sm:block">
            <p className="text-[10px] font-medium text-muted">Heartbeat</p>
            <p className="mt-0.5 font-mono text-xs text-[#4f5964]">{run.lastHeartbeat}</p>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-4 sm:px-6 sm:py-6">
          <div className="flex flex-wrap items-center gap-2">
            <Avatar name={run.agent} color={run.color} size="sm" />
            <Pill tone={isInterrupted ? 'red' : executionInactive || interruptRefused ? 'amber' : run.status === 'waiting' ? 'amber' : run.status === 'checking' ? 'blue' : 'green'} dot>
              {isInterrupted
                ? 'Human interrupted'
                : interruptPending
                  ? 'Stopping honestly'
                  : interruptUnknown
                    ? 'Status uncertain'
                    : interruptRefused
                      ? 'Still running'
                      : workspacePaused
                        ? 'Human paused'
                        : laneIdle
                          ? 'No active run'
                      : isManagerReview
                        ? 'Manager checking'
                        : 'Agent working'}
            </Pill>
            <Pill tone="neutral">{phaseLabels[run.loopPhase]}</Pill>
            <span className="font-mono text-[11px] text-muted">Iteration {run.iteration}</span>
            <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[11px] text-muted sm:hidden">
              <Radio size={12} className={executionInactive || interruptRefused ? 'text-caution' : 'text-teal-700'} /> {run.lastHeartbeat}
            </span>
          </div>

          {run.agentTask ? (
            <section
              className="mt-4 overflow-hidden rounded-[14px] border border-line bg-white shadow-[0_1px_2px_rgba(23,28,36,.04)]"
              aria-labelledby="task-timing-heading"
              data-testid="agent-task-timing"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-[#fafbfb] px-4 py-3">
                <div>
                  <p className="text-[10px] font-medium text-muted">Durable agent task</p>
                  <h2 id="task-timing-heading" className="mt-0.5 text-xs font-semibold text-[#3f4953]">Actual timing and agent forecast</h2>
                </div>
                <Pill tone={taskForecastPaused ? 'amber' : run.agentTask.status === 'completed' ? 'green' : 'blue'}>
                  {taskForecastPaused ? 'Forecast paused' : formatAgentMinutes(run.agentTask.expectedAgentMinutes)}
                </Pill>
              </div>
              <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-3">
                <div className="bg-white p-4">
                  <p className="text-[10px] font-medium text-muted">Actual start</p>
                  <p className="mt-1.5 font-mono text-xs font-medium text-[#3f4953]" title={String(run.agentTask.startedAt)}>
                    {formatTaskTimestamp(run.agentTask.startedAt)}
                  </p>
                </div>
                <div className="bg-white p-4">
                  <p className="text-[10px] font-medium text-muted">Expected by</p>
                  <p className={cn('mt-1.5 font-mono text-xs font-medium', taskForecastPaused ? 'text-caution' : 'text-teal-700')} title={taskForecastPaused ? undefined : String(run.agentTask.expectedCompletedAt)}>
                    {taskForecastPaused
                      ? 'Paused during human wait'
                      : formatTaskTimestamp(run.agentTask.expectedCompletedAt)}
                  </p>
                </div>
                <div className="bg-white p-4">
                  <p className="text-[10px] font-medium text-muted">Actual end</p>
                  <p className="mt-1.5 font-mono text-xs font-medium text-[#3f4953]" title={run.agentTask.endedAt ? String(run.agentTask.endedAt) : undefined}>
                    {run.agentTask.endedAt ? formatTaskTimestamp(run.agentTask.endedAt) : 'In progress'}
                  </p>
                </div>
              </div>
              <p className="px-4 py-3 text-[10px] leading-4 text-muted">
                The estimate covers agent model and tool time only. Human review, decisions, interruption time, and deployment are excluded.
              </p>
            </section>
          ) : (
            <section className="mt-4 rounded-[14px] border border-dashed border-line bg-white/60 p-4" aria-label="Agent task timing">
              <p className="text-xs font-semibold text-[#4f5964]">No agent task active</p>
              <p className="mt-1 text-[10px] leading-4 text-muted">Start and expected completion appear only after an agent accepts work. No estimate is assigned to a person.</p>
            </section>
          )}

          <section
            className={cn(
              'mt-4 overflow-hidden rounded-[14px] border shadow-[0_1px_2px_rgba(23,28,36,.04)]',
              controlRestricted || interruptRefused ? 'border-[#e5b7b3] bg-urgent-soft' : 'border-[#cfe2df] bg-[#f5faf9]',
            )}
            aria-labelledby="human-controls-heading"
          >
            <div className="p-4 sm:p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn(
                      'grid size-8 shrink-0 place-items-center rounded-lg',
                      controlRestricted || interruptRefused ? 'bg-[#f8d8d5] text-urgent' : 'bg-teal-soft text-teal-700',
                    )}>
                      {controlRestricted || interruptRefused ? <Octagon size={15} /> : <ListTodo size={15} />}
                    </span>
                    <div>
                      <p className="text-[10px] font-medium text-muted">Always available</p>
                      <h2 id="human-controls-heading" className="font-display text-base font-semibold tracking-[-0.02em]">
                        Human controls
                      </h2>
                    </div>
                  </div>
                  <p className="mt-2.5 max-w-md text-[11px] leading-5 text-[#5f6a74]">
                    {isInterrupted
                      ? 'The worker confirmed the process stopped. Workspace, checkpoint, progress journal, and stable agent queue are preserved; this task is not marked done.'
                      : interruptPending
                        ? run.interruptionDetail ?? 'Steward fenced new dispatches and is waiting for the worker to settle the active process. It will not claim the agent stopped early.'
                        : interruptUnknown
                          ? 'Steward cannot prove whether the worker stopped. New dispatches remain fenced, the last observed action is shown below, and a human can retry the request.'
                          : interruptRefused
                            ? 'The worker refused the prior cancellation request and the process may still be running. The refusal is visible and a human can retry.'
                            : workspacePaused
                              ? 'A human paused the workspace. No new model or tool calls can start; the current checkpoint, journal, and stable agent queue remain preserved.'
                              : laneIdle
                                ? 'No provider process is active. Humans may keep queueing desired outcomes; the stable lane, evidence, and engineering checkpoint remain available for the next attempt.'
                            : 'Queue more work or request an interruption at any time. Steward preserves the workspace, journal, and agent-lane queue, and marks the run stopped only after worker settlement.'}
                  </p>
                  {(controlRestricted || interruptRefused) && (run.interruptRequestedAt || run.interruptedAt || run.interruptionReason) ? (
                    <p className="mt-2 font-mono text-[10px] leading-4 text-urgent">
                      {isInterrupted && run.interruptedAt
                        ? `Stopped ${run.interruptedAt}`
                        : run.interruptAcknowledgedAt
                          ? `Acknowledged ${run.interruptAcknowledgedAt}`
                          : run.interruptRequestedAt
                            ? `Requested ${run.interruptRequestedAt}`
                            : 'Human control event recorded'}
                      {run.interruptionReason ? ` · ${run.interruptionReason}` : ''}
                    </p>
                  ) : null}
                </div>
                <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:flex-col">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<ListPlus size={15} />}
                    onClick={() => onQueue?.(run)}
                    disabled={!onQueue}
                    className="w-full whitespace-nowrap sm:w-auto"
                  >
                    Queue work
                  </Button>
                  {isInterrupted ? (
                    <Button
                      size="sm"
                      variant="mint"
                      icon={<Play size={14} />}
                      onClick={() => onResume?.(run)}
                      disabled={!onResume}
                      className="w-full whitespace-nowrap sm:w-auto"
                    >
                      Resume agent
                    </Button>
                  ) : interruptPending ? (
                    <Button
                      size="sm"
                      variant="danger"
                      icon={<Hourglass size={14} />}
                      disabled
                      className="w-full whitespace-nowrap sm:w-auto"
                    >
                      Waiting for worker
                    </Button>
                  ) : laneIdle ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Hourglass size={14} />}
                      disabled
                      className="w-full whitespace-nowrap sm:w-auto"
                    >
                      No active run
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="danger"
                      icon={<Octagon size={14} />}
                      onClick={() => onInterrupt?.(run)}
                      disabled={!onInterrupt}
                      className="w-full whitespace-nowrap sm:w-auto"
                    >
                      {interruptUnknown || interruptRefused ? 'Retry interrupt' : 'Interrupt now'}
                    </Button>
                  )}
                </div>
              </div>

              <div className="mt-4 border-t border-line pt-3.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11px] font-semibold text-muted">Stable queue for {run.agent}</p>
                  <Pill tone={run.queue.length > 0 ? 'blue' : 'neutral'}>{run.queue.length} queued</Pill>
                </div>
                {orderedQueue.length > 0 ? (
                  <ol className="mt-2.5 space-y-2">
                    {orderedQueue.map((item, index) => (
                      <li key={item.id} className="flex min-w-0 items-start gap-2.5 rounded-[10px] border border-line bg-white/85 p-3">
                        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-line-soft font-mono text-[10px] font-medium text-[#5f6973]">
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <p className="break-words text-[11px] font-semibold text-[#3f4953]">{item.title}</p>
                            <Pill tone={item.position === 'next' ? 'green' : 'neutral'} className="min-h-5 px-1.5 text-[9px]">
                              {item.position === 'next' ? 'Next up' : 'Backlog'}
                            </Pill>
                          </div>
                          <p className="mt-1 break-words text-[10px] leading-4 text-muted">{item.desiredOutcome}</p>
                          <p className="mt-1 font-mono text-[9px] text-muted">Queued by {item.queuedBy} · {item.queuedAt}</p>
                          <p className="mt-0.5 font-mono text-[9px] font-medium text-teal-700">Agent estimate · {formatAgentMinutes(item.expectedAgentMinutes)}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-2.5 rounded-[10px] border border-dashed border-line bg-white/45 px-3 py-3 text-[10px] leading-4 text-muted">
                    No follow-up work is queued. This stable lane remains available if the current run is replaced or finishes.
                  </p>
                )}
                <p className="mt-2 font-mono text-[9px] text-muted">
                  Lane {run.agentLaneId} · queue survives run replacement and interruption
                </p>
              </div>
            </div>
          </section>

          <ImpactSummaryCard summary={run.impactSummary} compact paused={workspacePaused} className="mt-4" />

          <section className="mt-4 overflow-hidden rounded-[14px] border border-white/[0.08] bg-ink text-white shadow-[0_10px_28px_rgba(23,28,36,.14)]" aria-live="polite">
            <div className="flex items-start gap-3 p-4 sm:p-5">
              <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-teal-500 text-ink">
                <ActionIcon size={19} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[11px] font-medium text-white/55">
                    {isInterrupted
                      ? 'Preserved action at interruption'
                      : interruptPending
                        ? 'Action being settled'
                        : interruptUnknown
                          ? 'Last observed action'
                          : workspacePaused
                            ? 'Preserved action while paused'
                            : laneIdle
                              ? 'Lane state'
                            : 'Right now'}
                  </p>
                  <span className="rounded-md border border-white/10 bg-white/[0.07] px-2 py-0.5 text-[9px] font-medium text-white/70">
                    {actionLabels[run.currentAction.kind]}
                  </span>
                </div>
                <h2 className="mt-1.5 break-words font-display text-lg font-semibold leading-6 tracking-[-0.02em]">
                  {run.currentAction.label}
                </h2>
                <p className="mt-1.5 break-words text-[12px] leading-5 text-white/55">{run.currentAction.detail}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 border-t border-white/[0.08] bg-white/[0.025] sm:grid-cols-3">
              <div className="min-w-0 border-r border-white/[0.08] p-3.5 sm:p-4">
                <p className="flex items-center gap-1.5 text-[10px] font-medium text-white/50">
                  <Wrench size={11} /> Tool
                </p>
                <p className="mt-1.5 truncate font-mono text-[11px] font-medium text-teal-300" title={run.currentAction.tool}>
                  {run.currentAction.tool}
                </p>
              </div>
              <div className="min-w-0 p-3.5 sm:order-3 sm:border-l sm:border-white/[0.08] sm:p-4">
                <p className="flex items-center gap-1.5 text-[10px] font-medium text-white/50">
                  <Clock3 size={11} /> Elapsed
                </p>
                <p className="mt-1.5 font-mono text-[11px] font-medium text-white/80">{run.currentAction.elapsed}</p>
              </div>
              <div className="col-span-2 min-w-0 border-t border-white/[0.08] p-3.5 sm:order-2 sm:col-span-1 sm:border-t-0 sm:p-4">
                <p className="flex items-center gap-1.5 text-[10px] font-medium text-white/50">
                  <FileCode2 size={11} /> Target
                </p>
                <p className="mt-1.5 break-all font-mono text-[10px] font-medium leading-4 text-white/75">
                  {run.currentAction.target ?? 'Workspace context'}
                </p>
              </div>
            </div>
          </section>

          <section className="mt-7" aria-labelledby="work-loop-heading">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[11px] font-medium text-muted">Completion loop</p>
                <h2 id="work-loop-heading" className="mt-0.5 font-display text-base font-semibold tracking-[-0.02em]">
                  Research → Plan → Execute → Test
                </h2>
              </div>
              <Pill tone={isManagerReview ? 'purple' : 'green'}>Iteration {run.iteration}</Pill>
            </div>

            {isManagerReview ? (
              <div className="mt-3 flex items-start gap-3 rounded-[14px] border border-[#d5d3e3] bg-[#f2f1f7] p-3.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#e5d9f1] text-[#6b5082]">
                  <ClipboardCheck size={15} />
                </span>
                <div>
                  <p className="text-xs font-semibold text-[#55547a]">Engineering loop complete</p>
                  <p className="mt-1 text-[11px] leading-5 text-[#776486]">
                    The manager is checking the work and evidence before creating a human production review task.
                  </p>
                </div>
              </div>
            ) : null}

            <div className="mt-3 grid gap-2.5 sm:grid-cols-4">
              {run.loopSteps.map((step) => {
                const status = loopStatus[step.status];
                const PhaseIcon = loopIcons[step.phase];
                const StatusIcon = status.icon;

                return (
                  <div key={step.phase} className={cn('min-w-0 rounded-[10px] border p-3', status.card)}>
                    <div className="flex items-center gap-2 sm:block">
                      <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', status.iconClass)}>
                        <PhaseIcon size={15} />
                      </span>
                      <div className="min-w-0 flex-1 sm:mt-2.5">
                        <p className="text-xs font-semibold text-[#3f4953]">{step.phase}</p>
                        <p className={cn('mt-0.5 flex items-center gap-1 text-[9px] font-semibold', status.labelClass)}>
                          <StatusIcon size={10} />
                          {step.status === 'active' && isInterrupted
                            ? 'Paused'
                            : step.status === 'active' && interruptPending
                              ? 'Stopping'
                              : step.status === 'active' && interruptUnknown
                                ? 'Unknown'
                                : step.status === 'active' && workspacePaused
                                  ? 'Human paused'
                                  : step.status === 'active' && laneIdle
                                    ? 'No active run'
                                : status.label}
                        </p>
                      </div>
                    </div>
                    <p className="mt-2 break-words text-[10px] leading-4 text-muted">{step.detail}</p>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="mt-7" aria-labelledby="progress-journal-heading">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[11px] font-medium text-muted">Written as work happens</p>
                <h2 id="progress-journal-heading" className="mt-0.5 font-display text-base font-semibold tracking-[-0.02em]">
                  Progress journal
                </h2>
              </div>
              <Pill tone="neutral">{run.journal.length} updates</Pill>
            </div>

            {run.journal.length > 0 ? (
              <ol className="relative mt-4 space-y-3 before:absolute before:bottom-4 before:left-[17px] before:top-4 before:w-px before:bg-line">
                {run.journal.map((entry) => {
                  const tone = journalTones[entry.tone];
                  const JournalIcon = tone.icon;

                  return (
                    <li key={entry.id} className="relative flex min-w-0 items-start gap-3">
                      <span className={cn('z-[1] grid size-9 shrink-0 place-items-center rounded-[10px] border', tone.marker)}>
                        <JournalIcon size={15} />
                      </span>
                      <div className="min-w-0 flex-1 rounded-[14px] border border-line bg-white p-3.5">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-[10px] font-semibold text-[#5f6973]">{entry.phase}</span>
                          <span className="text-[9px] text-muted">·</span>
                          <time className="font-mono text-[10px] text-muted">{entry.time}</time>
                        </div>
                        <h3 className="mt-1 text-[12px] font-semibold text-[#3f4953]">{entry.title}</h3>
                        <p className="mt-1 break-words text-[11px] leading-5 text-muted">{entry.note}</p>
                        {entry.evidence ? (
                          <div className={cn('mt-2.5 flex min-w-0 items-start gap-2 rounded-lg border px-2.5 py-2', tone.evidence)}>
                            <TerminalSquare size={12} className="mt-0.5 shrink-0" />
                            <code className="min-w-0 break-all font-mono text-[9px] font-medium leading-4">{entry.evidence}</code>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="mt-3 rounded-[14px] border border-dashed border-line bg-white/50 p-4 text-center text-xs text-muted">
                The agent will record its first progress note here.
              </div>
            )}
          </section>

          <section className="mt-7 rounded-[14px] bg-ink p-4 text-white sm:p-5">
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-caution-fill text-ink">
                <ArrowRight size={17} />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-white/50">Next step</p>
                <p className="mt-1 break-words text-[13px] font-semibold leading-5 text-white/86">{run.nextStep}</p>
              </div>
            </div>
          </section>

          <section className="mt-7" aria-labelledby="run-boundaries-heading">
            <p className="text-[11px] font-medium text-muted">Execution envelope</p>
            <h2 id="run-boundaries-heading" className="mt-0.5 font-display text-base font-semibold tracking-[-0.02em]">
              Route, budget & boundaries
            </h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded-[14px] border border-line bg-white p-4">
                <div className="flex items-center gap-2 text-[11px] font-medium text-muted">
                  <Cpu size={14} /> Model route
                </div>
                <p className="mt-2 break-words text-[13px] font-semibold text-[#3f4953]">{run.model}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Pill tone={run.tier === 'Economy' ? 'green' : run.tier === 'Balanced' ? 'purple' : 'amber'}>{run.tier}</Pill>
                  <span className="self-center text-[10px] font-medium text-muted">Cheap-first routing</span>
                </div>
              </div>
              <div className="rounded-[14px] border border-line bg-white p-4">
                <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-muted">
                  <span className="flex items-center gap-2"><CircleDollarSign size={14} /> Token budget</span>
                  <span className="font-mono">{Math.round(tokenPercent)}%</span>
                </div>
                <p className="mt-2 font-mono text-[13px] font-medium text-[#3f4953]">
                  {formatTokens(run.tokens)} <span className="text-muted">/ {formatTokens(run.tokenLimit)}</span>
                </p>
                <ProgressBar value={tokenPercent} tone={tokenPercent > 80 ? 'amber' : 'purple'} className="mt-2.5" />
                <p className="mt-1.5 font-mono text-[10px] text-muted">${run.cost.toFixed(2)} accrued</p>
              </div>
              <div className="rounded-[14px] border border-line bg-white p-4 sm:col-span-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="grid size-8 place-items-center rounded-lg bg-teal-soft text-teal-700">
                    <ShieldCheck size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold">Development sandbox</p>
                    <p className="mt-0.5 break-all font-mono text-[9px] text-muted">dev/{run.workItemId.toLowerCase()}</p>
                  </div>
                  <Pill tone="green">Isolated</Pill>
                </div>
                <div className="mt-3 grid gap-2 text-[10px] font-semibold sm:grid-cols-2">
                  <div className="flex min-h-11 items-center gap-2 rounded-[10px] border border-[#cfe2df] bg-[#f5faf9] px-3 text-teal-700">
                    <TerminalSquare size={13} className="shrink-0" /> Repo, tools & tests allowed
                  </div>
                  <div className="flex min-h-11 items-center gap-2 rounded-[10px] border border-[#e5b7b3] bg-urgent-soft px-3 text-urgent">
                    <LockKeyhole size={13} className="shrink-0" /> Prod keys & deployment denied
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="mb-[max(0.5rem,env(safe-area-inset-bottom))] mt-4 flex items-start gap-3 rounded-[14px] border border-[#ead09b] bg-caution-soft p-4">
            <LockKeyhole size={17} className="mt-0.5 shrink-0 text-caution" />
            <div>
              <p className="text-xs font-semibold text-[#684908]">A person is the production gate</p>
              <p className="mt-1 text-[11px] leading-5 text-caution">
                Managers can submit completed work for human review. No agent can approve or deploy it to production.
              </p>
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
