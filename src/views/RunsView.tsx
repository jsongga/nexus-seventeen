import {
  Activity,
  Box,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Cpu,
  Eye,
  KeyRound,
  Network,
  NotebookPen,
  Radio,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';
import {
  isInterruptPending,
  isInterruptSettled,
  isRunStateUncertain,
  type DemoRun,
} from '../data/demo';
import { Avatar, Button, Card, Pill, ProgressBar, cn } from '../components/ui';
import { formatAgentMinutes, formatTaskTimestamp } from '../task-time';

export interface RunsViewProps {
  runs: readonly DemoRun[];
  onOpenRun?: (runId: string) => void;
}

const statusStyles: Record<
  DemoRun['status'],
  { label: string; tone: 'green' | 'amber' }
> = {
  working: { label: 'Working', tone: 'green' },
  checking: { label: 'Checking', tone: 'green' },
  waiting: { label: 'Waiting', tone: 'amber' },
};

const tierStyles: Record<DemoRun['tier'], { tone: 'green' | 'neutral' | 'amber'; note: string }> = {
  Economy: { tone: 'green', note: 'Default route' },
  Balanced: { tone: 'neutral', note: 'Risk escalation' },
  Frontier: { tone: 'amber', note: 'Exception route' },
};

const phaseLabels: Record<DemoRun['loopPhase'], string> = {
  research: 'Research',
  plan: 'Plan',
  execute: 'Execute',
  test: 'Test',
  manager_review: 'Manager review',
};

const actionKindLabels: Record<DemoRun['currentAction']['kind'], string> = {
  analysis: 'Analysis',
  file: 'File',
  command: 'Command',
  review: 'Review',
};

const formatTokens = (tokens: number) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens);

export function RunsView({ runs, onOpenRun }: RunsViewProps) {
  const usedTokens = runs.reduce((total, run) => total + run.tokens, 0);
  const tokenLimit = runs.reduce((total, run) => total + run.tokenLimit, 0);
  const totalCost = runs.reduce((total, run) => total + run.cost, 0);
  const economyCount = runs.filter((run) => run.tier === 'Economy').length;
  const activeCount = runs.filter((run) => run.status !== 'waiting' && run.controlState === 'running').length;
  const budgetPercent = tokenLimit === 0 ? 0 : (usedTokens / tokenLimit) * 100;

  return (
    <div className="space-y-7">
      <header className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-3xl">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-teal-700">
            <Activity size={16} />
            Live execution
          </div>
          <h1 className="font-display text-[22px] font-semibold leading-tight tracking-[-0.025em] text-ink sm:text-[26px]">
            Know exactly what every agent is doing—and what it can spend.
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-6 text-muted">
            These seeded run cards illustrate intended routing and token budgets. The browser demo does not create isolation or enforce spend.
          </p>
        </div>

        <Card className="min-w-0 p-4 sm:min-w-[390px]">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.11em] text-muted">Live token envelope</p>
              <p className="mt-1 font-mono text-2xl font-semibold tracking-[-0.04em] text-ink">
                {formatTokens(usedTokens)} <span className="text-sm font-medium text-muted">/ {formatTokens(tokenLimit)}</span>
              </p>
            </div>
            <div className="grid size-11 place-items-center rounded-xl bg-teal-soft text-teal-700">
              <CircleDollarSign size={21} />
            </div>
          </div>
          <ProgressBar value={budgetPercent} tone={budgetPercent > 80 ? 'amber' : 'green'} className="mt-3" />
          <div className="mt-2 flex items-center justify-between font-mono text-[11px] font-medium text-muted">
            <span>{Math.round(budgetPercent)}% consumed</span>
            <span>${totalCost.toFixed(2)} current cost</span>
          </div>
        </Card>
      </header>

      <section aria-labelledby="active-runs-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="active-runs-heading" className="font-display text-lg font-semibold tracking-[-0.025em] text-ink">Agent sessions</h2>
            <p className="mt-0.5 text-sm text-muted"><span className="font-mono">{activeCount}</span> active · <span className="font-mono">{runs.length - activeCount}</span> ready or human-interrupted · every agent is controllable</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Pill tone="green" dot>{economyCount} economy routed</Pill>
            <Pill tone="neutral">{runs.length - economyCount} escalated</Pill>
          </div>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {runs.map((run) => {
            const tokenPercent = run.tokenLimit === 0 ? 0 : (run.tokens / run.tokenLimit) * 100;
            const status = statusStyles[run.status];
            const tier = tierStyles[run.tier];
            const managerReview = run.loopPhase === 'manager_review';
            const interrupted = isInterruptSettled(run.controlState);
            const interruptPending = isInterruptPending(run.controlState);
            const interruptUnknown = isRunStateUncertain(run.controlState);
            const laneIdle = run.controlState === 'idle';
            const taskForecastPaused =
              run.agentTask?.status !== 'completed' &&
              (run.agentTask?.status === 'paused' ||
                run.workspacePaused === true ||
                interruptUnknown ||
                laneIdle);
            const controlAttention =
              interrupted ||
              interruptPending ||
              interruptUnknown ||
              laneIdle ||
              run.controlState === 'interrupt_refused';
            const controlLabel = interrupted
              ? 'Interrupted'
              : interruptPending
                ? 'Stopping'
                : interruptUnknown
                  ? 'State unknown'
                  : run.controlState === 'interrupt_refused'
                    ? 'Still running'
                    : laneIdle
                      ? 'Lane idle'
                    : status.label;

            return (
              <Card key={run.id} as="article" className="flex min-h-[540px] flex-col overflow-hidden">
                <div className="border-b border-line p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="relative">
                        <Avatar name={run.agent} color={run.color} size="lg" />
                        <span
                          className={cn(
                            'absolute -bottom-1 -right-1 size-3.5 rounded-full border-[3px] border-white bg-teal-500',
                            run.status === 'waiting' && 'bg-caution-fill',
                            run.status === 'checking' && 'bg-teal-500',
                          )}
                        />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-display text-base font-semibold tracking-[-0.02em] text-ink">{run.agent}</p>
                        <p className="mt-0.5 truncate text-xs font-semibold text-muted">{run.role} · <span className="font-mono">{run.id}</span></p>
                      </div>
                    </div>
                    <Pill tone={interrupted ? 'red' : controlAttention ? 'amber' : status.tone} dot>{controlLabel}</Pill>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Pill tone={managerReview ? 'neutral' : 'green'}>
                      {phaseLabels[run.loopPhase]}
                    </Pill>
                    <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted">
                      Iteration <span className="font-mono">{run.iteration}</span>
                    </span>
                    <span className="ml-auto flex items-center gap-1.5 text-[10px] font-bold text-teal-700">
                      <Radio size={12} />
                      Heartbeat <span className="font-mono">{run.lastHeartbeat}</span>
                    </span>
                  </div>

                  <div className="mt-3">
                    <p className="font-display text-[17px] font-semibold leading-5 tracking-[-0.02em] text-ink">{run.activity}</p>
                    <p className="mt-1.5 text-[13px] leading-5 text-muted">{run.detail}</p>
                  </div>

                  <div
                    className={cn(
                      'mt-4 rounded-xl border p-3.5',
                      managerReview ? 'border-line bg-paper' : 'border-teal-border bg-teal-soft',
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={cn(
                        'text-[9px] font-bold uppercase tracking-[0.1em]',
                        managerReview ? 'text-muted' : 'text-teal-700',
                      )}>
                        Doing now
                      </p>
                      <span className="rounded-md border border-line bg-white px-2 py-0.5 text-[9px] font-bold text-muted">
                        {actionKindLabels[run.currentAction.kind]}
                      </span>
                      <span className="ml-auto flex items-center gap-1 font-mono text-[9px] font-medium text-muted">
                        <Clock3 size={11} /> {run.currentAction.elapsed}
                      </span>
                    </div>
                    <p className="mt-2 break-words text-[13px] font-bold leading-5 text-ink">
                      {run.currentAction.label}
                    </p>
                    <p className="mt-1 break-words text-[11px] leading-4 text-muted">{run.currentAction.detail}</p>
                    <div className="mt-2.5 grid gap-1.5 text-[9px] font-bold text-muted sm:grid-cols-2">
                      <span className="min-w-0 truncate rounded-lg border border-line bg-white px-2 py-1.5 font-mono" title={run.currentAction.tool}>
                        Tool · {run.currentAction.tool}
                      </span>
                      <span className="min-w-0 break-all rounded-lg border border-line bg-white px-2 py-1.5 font-mono">
                        Target · {run.currentAction.target ?? 'Workspace context'}
                      </span>
                    </div>
                  </div>

                  {run.agentTask ? (
                    <div className="mt-4 rounded-xl border border-line bg-card p-3" data-testid="agent-task-timing">
                      <div className="grid grid-cols-3 gap-2">
                        <div className="min-w-0">
                          <p className="text-[9px] font-bold uppercase tracking-[0.09em] text-muted">Actual start</p>
                          <p className="mt-1 truncate font-mono text-[10px] font-medium text-muted" title={String(run.agentTask.startedAt)}>
                            {formatTaskTimestamp(run.agentTask.startedAt)}
                          </p>
                        </div>
                        <div className="min-w-0 border-l border-line pl-2">
                          <p className="text-[9px] font-bold uppercase tracking-[0.09em] text-muted">Expected by</p>
                          <p className={cn('mt-1 truncate font-mono text-[10px] font-medium', taskForecastPaused ? 'text-caution' : 'text-teal-700')} title={taskForecastPaused ? undefined : String(run.agentTask.expectedCompletedAt)}>
                            {taskForecastPaused
                              ? 'Forecast paused'
                              : formatTaskTimestamp(run.agentTask.expectedCompletedAt)}
                          </p>
                        </div>
                        <div className="min-w-0 border-l border-line pl-2">
                          <p className="text-[9px] font-bold uppercase tracking-[0.09em] text-muted">Actual end</p>
                          <p className="mt-1 truncate font-mono text-[10px] font-medium text-muted" title={run.agentTask.endedAt ? String(run.agentTask.endedAt) : undefined}>
                            {run.agentTask.endedAt ? formatTaskTimestamp(run.agentTask.endedAt) : 'In progress'}
                          </p>
                        </div>
                      </div>
                      <p className="mt-2 flex items-center gap-1 font-mono text-[9px] font-medium text-muted">
                        <Clock3 size={11} /> {formatAgentMinutes(run.agentTask.expectedAgentMinutes)} · human wait excluded
                      </p>
                    </div>
                  ) : (
                    <div className="mt-4 flex items-center gap-2 rounded-xl border border-dashed border-line bg-card p-3 text-[10px] font-semibold text-muted">
                      <Clock3 size={13} /> No agent task active · no agent ETA
                    </div>
                  )}

                  <div className="mt-3 flex items-center justify-end gap-4">
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1 text-[10px] font-bold text-muted">
                        <NotebookPen size={12} /> <span className="font-mono">{run.journal.length}</span> notes
                      </span>
                      <span className="flex items-center gap-1 text-[10px] font-bold text-muted">
                        <span className="font-mono">{run.queue.length}</span> queued
                      </span>
                      <span className="font-mono text-sm font-semibold text-ink">{run.progress}%</span>
                    </div>
                  </div>
                  <ProgressBar value={run.progress} tone={controlAttention ? 'amber' : 'green'} className="mt-2" />
                </div>

                <div className="grid grid-cols-2 gap-px border-b border-line bg-muted-surface">
                  <div className="bg-white p-4">
                    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-muted">
                      <Cpu size={13} /> Model route
                    </div>
                    <p className="mt-2 truncate text-xs font-bold text-muted" title={run.model}>{run.model}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Pill tone={tier.tone}>{run.tier}</Pill>
                      <span className="text-[9px] font-bold text-muted">{tier.note}</span>
                    </div>
                  </div>
                  <div className="bg-white p-4">
                    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-muted">
                      <CircleDollarSign size={13} /> Token cap
                    </div>
                    <p className="mt-2 font-mono text-xs font-semibold text-muted">
                      {formatTokens(run.tokens)} <span className="font-medium text-muted">/ {formatTokens(run.tokenLimit)}</span>
                    </p>
                    <ProgressBar value={tokenPercent} tone={tokenPercent > 80 ? 'amber' : 'green'} className="mt-2.5" />
                    <p className="mt-1.5 font-mono text-[9px] font-medium text-muted">${run.cost.toFixed(2)} accrued</p>
                  </div>
                </div>

                <div className="mt-auto bg-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="grid size-8 place-items-center rounded-lg border border-line bg-white text-teal-700">
                        <TerminalSquare size={15} />
                      </span>
                      <div>
                        <p className="text-[11px] font-bold text-muted">Workspace context · demo</p>
                        <p className="mt-0.5 font-mono text-[9px] text-muted">dev/{run.workItemId.toLowerCase()}</p>
                      </div>
                    </div>
                    <Pill tone="green">Illustrative</Pill>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-bold">
                    <div className="flex min-w-0 items-center gap-1.5 rounded-lg border border-teal-border bg-white px-2.5 py-2 text-teal-700">
                      <Box size={12} /> Intended: repo + tools
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5 rounded-lg border border-urgent-border bg-urgent-soft px-2.5 py-2 text-urgent">
                      <KeyRound size={12} /> Credentials not checked
                    </div>
                  </div>
                  <Button
                    variant="primary"
                    className="mt-3 w-full"
                    icon={<Eye size={16} />}
                    disabled={!onOpenRun}
                    onClick={() => onOpenRun?.(run.id)}
                    aria-label={`Open human controls for ${run.agent}`}
                  >
                    Open controls
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>

        {runs.length === 0 ? (
          <Card className="mt-4 grid min-h-52 place-items-center border-dashed p-6 text-center">
            <div>
              <p className="font-display text-base font-semibold text-ink">No agents are running</p>
              <p className="mt-1 text-sm text-muted">Approved missions will appear here when execution begins.</p>
            </div>
          </Card>
        ) : null}
      </section>

      <Card as="section" className="overflow-hidden border-teal-border bg-white">
        <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[1.15fr_1fr] lg:items-center">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-teal-500 text-ink">
              <ShieldCheck size={19} />
            </span>
            <div>
              <h2 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Prototype boundary model</h2>
              <p className="mt-1 text-[13px] leading-5 text-muted">
                This screen illustrates intended permissions. The browser demo does not create a sandbox or inspect production credentials.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl border border-line bg-card p-3 text-center">
              <Network size={15} className="mx-auto text-teal-700" />
              <p className="mt-2 text-[10px] font-bold text-muted">Network policy target</p>
            </div>
            <div className="rounded-xl border border-line bg-card p-3 text-center">
              <CheckCircle2 size={15} className="mx-auto text-teal-700" />
              <p className="mt-2 text-[10px] font-bold text-muted">Sample test evidence</p>
            </div>
            <div className="rounded-xl border border-caution-border bg-caution-soft p-3 text-center">
              <KeyRound size={15} className="mx-auto text-caution" />
              <p className="mt-2 text-[10px] font-bold text-caution">Human authorization target</p>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
