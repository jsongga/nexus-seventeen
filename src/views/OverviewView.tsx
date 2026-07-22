import {
  Activity,
  ArrowUpRight,
  Bot,
  Check,
  CircleDollarSign,
  GitBranch,
  LockKeyhole,
  Plus,
  Route,
  ShieldCheck,
  TimerReset,
  TrendingDown,
} from 'lucide-react';
import {
  isInterruptPending,
  isInterruptSettled,
  isRunStateUncertain,
  type ApprovalItem,
  type DemoMission,
  type DemoRun,
} from '../data/demo';
import { ApprovalCard } from '../components/ApprovalCard';
import { ImpactSummaryCard } from '../components/ImpactSummaryCard';
import { Avatar, Button, Card, cn, Pill, ProgressBar, SectionHeading } from '../components/ui';

function Metric({
  label,
  value,
  detail,
  icon,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
  tone: 'green' | 'amber' | 'blue' | 'purple';
}) {
  const tones = {
    green: 'bg-teal-soft text-teal-700',
    amber: 'bg-caution-soft text-caution',
    blue: 'bg-[#eef3f6] text-[#3f6073]',
    purple: 'bg-[#f2f1f7] text-[#55547a]',
  };

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold text-muted">{label}</p>
          <p className="mt-2 font-mono text-[26px] font-medium leading-none tracking-[-0.035em] text-ink sm:text-[30px]">
            {value}
          </p>
          <p className="mt-2 text-[11px] font-medium text-muted">{detail}</p>
        </div>
        <span className={cn('grid size-9 place-items-center rounded-[10px]', tones[tone])}>{icon}</span>
      </div>
    </Card>
  );
}

function LiveRunCard({ run, onOpen }: { run: DemoRun; onOpen: () => void }) {
  const tierTone = run.tier === 'Economy' ? 'green' : run.tier === 'Balanced' ? 'purple' : 'red';
  const phaseWords: Record<string, string> = {
    research: 'Researching',
    plan: 'Planning',
    execute: 'Coding',
    test: 'Testing',
    manager_review: 'Being reviewed',
  };
  const phaseLabel = phaseWords[run.loopPhase] ?? run.loopPhase;
  const interrupted = isInterruptSettled(run.controlState);
  const settling = isInterruptPending(run.controlState);
  const uncertain = isRunStateUncertain(run.controlState);
  const laneIdle = run.controlState === 'idle';
  const controlAttention = interrupted || settling || uncertain || laneIdle || run.controlState === 'interrupt_refused';
  const activelyWorking = !controlAttention && run.status !== 'waiting';
  const controlStatus = interrupted
    ? 'Interrupted'
    : settling
      ? 'Stopping'
      : uncertain
        ? 'State unknown'
        : run.controlState === 'interrupt_refused'
          ? 'Still running'
          : laneIdle
            ? 'Lane idle'
          : phaseLabel;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-[14px] border border-line bg-white p-4 text-left shadow-[0_1px_2px_rgba(23,28,36,.04)] transition-colors hover:border-[#c7cdd2] hover:bg-[#fdfdfd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700/35"
      aria-label={`Inspect live run ${run.id} for ${run.agent}`}
    >
      <div className="flex items-start gap-3">
        <div className="relative">
          <Avatar name={run.agent} color={run.color} />
          <span
            className={cn(
              'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-white',
              activelyWorking ? 'bg-teal-500' : controlAttention ? 'bg-urgent' : 'bg-caution-fill',
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold">{run.agent}</p>
            <span className="text-[11px] font-medium text-muted">{run.role}</span>
            <Pill tone={tierTone} className="ml-auto">
              {run.tier}
            </Pill>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Pill tone={interrupted ? 'red' : controlAttention ? 'amber' : run.loopPhase === 'manager_review' ? 'purple' : 'blue'}>
              {controlStatus} · attempt {run.iteration}
            </Pill>
            <span className={cn('inline-flex items-center gap-1 text-[10px] font-semibold', controlAttention ? 'text-urgent' : 'text-teal-700')}>
              <span className={cn('size-1.5 rounded-full', controlAttention ? 'bg-urgent' : 'bg-teal-500')} />
              {run.lastHeartbeat}
            </span>
          </div>
          <p className="mt-2 truncate text-[13px] font-semibold text-[#3f4953]">{run.currentAction.label}</p>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted">{run.currentAction.detail}</p>
          <div className="mt-3 flex items-center gap-3">
            <ProgressBar value={run.progress} tone={run.tier === 'Balanced' ? 'purple' : 'green'} className="flex-1" />
            <span className="font-mono text-[10px] font-medium text-muted">{run.progress}%</span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[10px] text-muted">
            <span className="font-mono">${run.cost.toFixed(2)} spent so far</span>
            <span className="ml-auto inline-flex items-center gap-1 font-semibold text-teal-700">
              Inspect <ArrowUpRight size={10} />
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

function PipelineMini({ mission }: { mission: DemoMission }) {
  const stateLabels = {
    scope_review: 'Needs your OK',
    engineering: 'Building',
    manager_review: 'In review',
    human_review: 'Needs your approval',
    deployed: 'Demo authorized',
    blocked: 'Blocked',
  };
  const stateTone =
    mission.state === 'deployed'
      ? 'green'
      : mission.state === 'human_review' || mission.state === 'scope_review'
        ? 'amber'
        : mission.state === 'manager_review'
          ? 'purple'
          : mission.state === 'blocked'
            ? 'red'
            : 'blue';

  return (
    <div className="flex items-center gap-3 border-b border-line-soft py-3.5 last:border-0">
      <Avatar name={mission.owner} color={mission.ownerColor} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold">{mission.title}</p>
        <div className="mt-1 font-mono text-[10px] text-muted">
          Updated {mission.updated}
        </div>
      </div>
      <Pill tone={stateTone}>{stateLabels[mission.state]}</Pill>
    </div>
  );
}

export function OverviewView({
  approvals,
  missions,
  runs,
  paused,
  onOpenApproval,
  onViewApprovals,
  onViewRuns,
  onNewMission,
  onOpenRun,
}: {
  approvals: ApprovalItem[];
  missions: DemoMission[];
  runs: DemoRun[];
  paused: boolean;
  onOpenApproval: (id: string) => void;
  onViewApprovals: () => void;
  onViewRuns: () => void;
  onNewMission: () => void;
  onOpenRun: (id: string) => void;
}) {
  const pending = approvals.filter((approval) => approval.status === 'pending');
  const liveMissions = missions.filter((mission) => mission.state !== 'deployed');
  const routedSpend = missions.reduce((sum, mission) => sum + mission.spent, 0);
  const primaryRun = runs.find((run) => run.role === 'Software engineer') ?? runs[0];
  const activeAgentCount = runs.filter((run) => run.status !== 'waiting' && run.controlState === 'running').length;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <span className="font-medium text-[#5d6771]">Good morning, Jordan.</span>
            <span className="font-mono">Saturday · July 18</span>
          </div>
          <h1 className="font-display text-[22px] font-semibold leading-tight tracking-[-0.025em] text-ink sm:text-[26px]">
            {pending.length} decisions need you.
          </h1>
          <p className="mt-2 max-w-xl text-[14px] leading-6 text-muted sm:text-[15px]">
            See what every agent is working on right now. Any real release still requires an external deployment integration.
          </p>
        </div>
        <Button
          className="sm:hidden"
          variant="primary"
          onClick={onNewMission}
          icon={<Plus size={16} />}
          aria-label="Create a new mission"
        >
          Start a mission
        </Button>
      </header>

      <Card className="overflow-hidden border-ink !bg-ink px-5 py-4 text-white sm:px-6 sm:py-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <span className="grid size-11 shrink-0 place-items-center rounded-[10px] border border-white/10 bg-white/[0.07] text-teal-300">
            <LockKeyhole size={21} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-[15px] font-semibold">Human release authorization is required</h2>
              <Pill tone="dark">Simulation only</Pill>
            </div>
            <p className="mt-1 text-[12px] leading-5 text-white/58">
              Agents can build, test, and preview their work. This browser demo records decisions but cannot release to customers.
            </p>
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px] text-white/60">
            <ShieldCheck size={16} className="text-teal-300" />
            Browser-local
          </div>
        </div>
      </Card>

      {primaryRun ? (
        <section className="space-y-3" aria-label="Main agent user impact overview">
          <SectionHeading
            title="What this work means for customers"
            description="A plain-language summary that updates on its own as the work progresses."
            action={
              <Button
                size="sm"
                variant="quiet"
                onClick={() => onOpenRun(primaryRun.id)}
                icon={<ArrowUpRight size={14} />}
              >
                Inspect {primaryRun.agent}
              </Button>
            }
          />
          <div>
            <ImpactSummaryCard summary={primaryRun.impactSummary} paused={paused} />
          </div>
        </section>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-3">
        <Metric
          label="Agents active"
          value={`${paused ? 0 : activeAgentCount} / ${runs.length}`}
          detail={paused ? 'Paused by human' : `${runs.length - activeAgentCount} ready or stopped`}
          icon={<Bot size={18} />}
          tone="green"
        />
        <Metric
          label="Modeled savings"
          value="68%"
          detail="Demo route estimate"
          icon={<TrendingDown size={18} />}
          tone="purple"
        />
        <Metric
          label="Mission spend"
          value={`$${routedSpend.toFixed(2)}`}
          detail="$39.00 active budget"
          icon={<CircleDollarSign size={18} />}
          tone="blue"
        />
      </section>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,.75fr)]">
        <section className="min-w-0 space-y-3">
          <SectionHeading
            title="Needs your attention"
            description="The decisions waiting on you, with the facts to decide."
            action={
              <Button size="sm" variant="quiet" onClick={onViewApprovals} icon={<ArrowUpRight size={14} />}>
                Open inbox
              </Button>
            }
          />
          {pending.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} onClick={() => onOpenApproval(approval.id)} />
          ))}
        </section>

        <aside className="min-w-0 space-y-6">
          <section className="space-y-3">
            <SectionHeading
              title="Live work"
              description={paused ? 'Everything is safely paused.' : 'See exactly what each agent is doing now.'}
              action={
                <Button size="sm" variant="quiet" onClick={onViewRuns} icon={<Activity size={14} />}>
                  All runs
                </Button>
              }
            />
            <div className="space-y-2.5">
              {runs.slice(0, 3).map((run) => (
                <LiveRunCard key={run.id} run={run} onOpen={() => onOpenRun(run.id)} />
              ))}
            </div>
          </section>

          <Card className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-display text-[15px] font-semibold">Work in progress</h2>
                <p className="mt-0.5 text-[11px] text-muted">From request to authorization</p>
              </div>
              <span className="grid size-9 place-items-center rounded-[10px] bg-teal-soft text-teal-700">
                <Route size={18} />
              </span>
            </div>
            <div className="mt-2">
              {liveMissions.slice(0, 4).map((mission) => (
                <PipelineMini key={mission.id} mission={mission} />
              ))}
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 border-t border-line-soft pt-4 text-center">
              <div>
                <GitBranch size={14} className="mx-auto text-muted" />
                <p className="mt-1 text-[10px] font-medium text-muted">Sandboxed</p>
              </div>
              <div>
                <TimerReset size={14} className="mx-auto text-muted" />
                <p className="mt-1 text-[10px] font-medium text-muted">Cost-capped</p>
              </div>
              <div>
                <Check size={14} className="mx-auto text-teal-700" />
                <p className="mt-1 text-[10px] font-medium text-teal-700">You approve</p>
              </div>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
