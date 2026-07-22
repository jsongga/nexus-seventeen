import {
  ArrowDown,
  ArrowRight,
  Check,
  Eye,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import {
  isInterruptPending,
  isInterruptSettled,
  isRunStateUncertain,
  type DemoAgent,
  type DemoRun,
} from '../data/demo';
import { Avatar, Button, Card, Pill, cn } from '../components/ui';

export interface TeamViewProps {
  agents: readonly DemoAgent[];
  runs: readonly DemoRun[];
  onControlAgent: (runId: string) => void;
}

const statusTone: Record<DemoAgent['status'], 'green' | 'amber' | 'neutral'> = {
  active: 'green',
  waiting: 'amber',
  idle: 'neutral',
};

export function TeamView({ agents, runs, onControlAgent }: TeamViewProps) {
  const activeAgents = agents.filter((agent) => {
    const run = runs.find((item) => item.agent === agent.name);
    return run
      ? run.status !== 'waiting' && run.controlState === 'running' && !run.workspacePaused
      : agent.status === 'active';
  }).length;
  const totalSpend = agents.reduce((total, agent) => total + agent.spend, 0);
  const roleCount = new Set(agents.map((agent) => agent.role)).size;

  return (
    <div className="space-y-7">
      <header className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-3xl">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-teal-700">
            <Users size={16} />
            Fixed role team
          </div>
          <h1 className="font-display text-[22px] font-semibold leading-tight tracking-[-0.025em] text-ink sm:text-[26px]">
            Move quickly in development without letting one agent mark its own homework.
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-6 text-muted">
            Three durable roles separate engineering, independent verification, and management review. A human can queue, interrupt, or resume any agent at any time.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:min-w-[420px]">
          <Card className="p-3.5">
            <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-muted">Roles</p>
            <p className="mt-1.5 font-mono text-xl font-semibold text-ink">{roleCount}</p>
            <p className="text-[10px] font-semibold text-muted"><span className="font-mono">{agents.length}</span> assigned agents</p>
          </Card>
          <Card className="p-3.5">
            <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-muted">Working</p>
            <p className="mt-1.5 font-mono text-xl font-semibold text-ink">{activeAgents}</p>
            <p className="text-[10px] font-semibold text-muted">active now</p>
          </Card>
          <Card className="p-3.5">
            <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-muted">Spend</p>
            <p className="mt-1.5 font-mono text-xl font-semibold text-ink">${totalSpend.toFixed(2)}</p>
            <p className="text-[10px] font-semibold text-muted">this period</p>
          </Card>
        </div>
      </header>

      <Card as="section" className="overflow-hidden">
        <div className="border-b border-line px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-[16px] font-semibold tracking-[-0.02em] text-ink">Separation of duties</h2>
              <p className="mt-0.5 text-xs text-muted">Engineers journal every loop; a different manager checks the result before a human sees it.</p>
            </div>
            <Pill tone="green"><ShieldCheck size={12} /> Intended policy</Pill>
          </div>
        </div>

        <div className="p-5">
          <div className="grid gap-2 md:grid-cols-2 xl:flex xl:items-stretch">
            {[
              ['Manager assigns', 'Scope + acceptance criteria', 'manager'],
              ['Engineer loops', 'Research → Plan → Execute → Test', 'engineer'],
              ['Manager reviews', 'Checks journal, diff, tests, risk', 'manager'],
              ['Human checks', 'Intended release authority', 'human'],
              ['Demo broker records', 'Consumes authorization in-browser', 'broker'],
            ].map(([label, detail, kind], index, stages) => (
              <div key={label} className="contents">
                <div
                  className={cn(
                    'min-w-0 flex-1 rounded-xl border p-3',
                    kind === 'human'
                      ? 'border-[#e8c675] bg-[#fff6df]'
                      : 'border-line bg-[#f7f8f8]',
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        'grid size-7 shrink-0 place-items-center rounded-full font-mono text-xs font-semibold',
                        kind === 'human'
                          ? 'bg-caution-fill text-ink'
                          : kind === 'broker'
                            ? 'bg-[#d9f3f0] text-teal-700'
                            : 'bg-[#e9ecef] text-muted',
                      )}
                    >
                      {kind === 'human' ? <UserCheck size={14} /> : kind === 'broker' ? <LockKeyhole size={13} /> : index + 1}
                    </span>
                    <div className="min-w-0">
                      <p className={cn('truncate text-xs font-bold text-[#37424a]', kind === 'human' && 'text-[#6c4908]')}>{label}</p>
                      <p className={cn('mt-0.5 text-[9px] font-bold uppercase tracking-[0.07em]', kind === 'human' ? 'text-caution' : 'text-muted')}>
                        {detail}
                      </p>
                    </div>
                  </div>
                </div>
                {index < stages.length - 1 ? (
                  <div className="hidden w-8 shrink-0 place-items-center text-muted xl:grid">
                    <ArrowRight size={15} />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </Card>

      <section aria-labelledby="roles-heading">
        <div>
          <h2 id="roles-heading" className="font-display text-lg font-semibold tracking-[-0.025em] text-ink">Role permissions</h2>
          <p className="mt-0.5 text-sm text-muted">Stable capabilities make ownership legible; every card also opens the human control surface.</p>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {agents.map((agent, index) => {
            const run = runs.find((item) => item.agent === agent.name);
            const workspacePaused = run?.workspacePaused === true;
            const interrupted = run ? isInterruptSettled(run.controlState) : false;
            const interruptPending = run ? isInterruptPending(run.controlState) : false;
            const interruptUnknown = run ? isRunStateUncertain(run.controlState) : false;
            const laneIdle = run?.controlState === 'idle';
            const controlAttention =
              interrupted ||
              interruptPending ||
              interruptUnknown ||
              laneIdle ||
              run?.controlState === 'interrupt_refused';
            const controlLabel = interrupted
              ? 'interrupted'
              : interruptPending
                ? 'stopping'
                : interruptUnknown
                  ? 'state unknown'
                  : run?.controlState === 'interrupt_refused'
                    ? 'still running'
                    : laneIdle
                      ? 'lane idle'
                    : workspacePaused
                      ? 'human paused'
                    : agent.status;
            return (
            <Card key={agent.id} as="article" className={cn('overflow-hidden', index === agents.length - 1 && 'lg:col-span-2 2xl:col-span-1')}>
              <div className="border-b border-line p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar name={agent.name} color={agent.color} size="lg" />
                    <div className="min-w-0">
                      <h3 className="truncate font-display text-[17px] font-semibold tracking-[-0.025em] text-ink">{agent.name}</h3>
                      <p className="mt-0.5 truncate text-xs font-bold text-muted">{agent.role}</p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <Pill tone={interrupted ? 'red' : controlAttention || workspacePaused ? 'amber' : statusTone[agent.status]} dot>
                      {controlLabel}
                    </Pill>
                    <Pill tone="neutral">Fixed role</Pill>
                  </div>
                </div>
                <p className="mt-4 min-h-10 text-[13px] leading-5 text-muted">{agent.responsibility}</p>
                <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-paper px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-bold text-[#37424a]">{agent.model}</p>
                    <p className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.09em] text-muted">{agent.provider}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-xs font-semibold text-ink">${agent.spend.toFixed(2)}</p>
                    <p className="mt-0.5 text-[9px] font-bold text-muted">period spend</p>
                  </div>
                </div>
                {run ? (
                  <div className={cn(
                    'mt-3 flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5',
                    controlAttention ? 'border-[#efb9b2] bg-[#fff1ef]' : 'border-[#b8ded9] bg-[#edf8f7]',
                  )}>
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-[0.09em] text-muted">Human control</p>
                      <p className="mt-0.5 truncate text-[10px] font-semibold text-muted">
                        {run.queue.length} queued · {interrupted ? 'stopped safely' : interruptPending ? 'worker settling' : interruptUnknown ? 'worker state unknown' : laneIdle ? 'no active provider process' : workspacePaused ? 'workspace and checkpoint preserved' : run.currentAction.label}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant={controlAttention ? 'mint' : 'secondary'}
                      icon={<Eye size={13} />}
                      onClick={() => onControlAgent(run.id)}
                      aria-label={`Open human controls for ${agent.name}`}
                    >
                      Control
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="grid gap-px bg-[#e4e7ea] sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                <div className="bg-white p-4">
                  <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-teal-700">
                    <Check size={13} /> Can
                  </p>
                  <ul className="mt-3 space-y-2">
                    {agent.can.map((capability) => (
                      <li key={capability} className="flex items-start gap-2 text-[11px] font-semibold leading-4 text-muted">
                        <span className="mt-1 size-1.5 shrink-0 rounded-full bg-teal-500" />
                        {capability}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="bg-[#fff9f8] p-4">
                  <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-urgent">
                    <X size={13} /> Cannot
                  </p>
                  <ul className="mt-3 space-y-2">
                    {agent.cannot.map((restriction) => (
                      <li key={restriction} className="flex items-start gap-2 text-[11px] font-semibold leading-4 text-[#655e5d]">
                        <span className="mt-1 size-1.5 shrink-0 rotate-45 bg-[#ff8a7a]" />
                        {restriction}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </Card>
          );
          })}
        </div>
      </section>

      <Card as="section" className="overflow-hidden border-[#e8c675] bg-white">
        <div className="grid lg:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
          <div className="p-5 sm:p-7">
            <div className="flex items-start gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-caution-fill text-ink">
                <KeyRound size={21} />
              </span>
              <div>
                <Pill tone="amber">Human-only capability</Pill>
                <h2 className="mt-3 font-display text-xl font-semibold tracking-[-0.03em] text-ink sm:text-2xl">Managers post the task. A person authorizes release.</h2>
                <p className="mt-2 max-w-2xl text-[13px] leading-5 text-muted">
                  A manager checks the engineer's journal, diff, tests, and remaining risks before posting a production-check task. In this browser demo, a human authorizes the exact evidence-bound candidate and a simulated broker records one-time consumption. No deployment occurs.
                </p>
              </div>
            </div>
          </div>

          <div className="border-t border-line bg-[#f7f8f8] p-5 lg:border-l lg:border-t-0 sm:p-6">
            <div className="space-y-2">
              {[
                ['1', 'Engineering manager', 'Checks work and posts the task'],
                ['2', 'Human owner', 'Checks and signs one candidate'],
                ['3', 'Simulated broker', 'Records consumption once'],
              ].map(([step, actor, action], index) => (
                <div key={step} className="relative flex items-center gap-3 rounded-xl border border-line bg-white p-3">
                  <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg font-mono text-[10px] font-semibold', index === 1 ? 'bg-caution-fill text-ink' : 'bg-[#e9ecef] text-muted')}>
                    {step}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-bold text-[#37424a]">{actor}</p>
                    <p className="mt-0.5 text-[10px] text-muted">{action}</p>
                  </div>
                  {index === 1 ? <LockKeyhole size={14} className="text-caution" /> : null}
                  {index < 2 ? <ArrowDown size={12} className="absolute -bottom-[11px] left-[1.35rem] z-10 text-muted" /> : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
