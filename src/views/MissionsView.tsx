import {
  CircleDollarSign,
  Clock3,
  Filter,
  GitBranch,
  ShieldCheck,
} from 'lucide-react';
import type { DemoMission, RiskTone } from '../data/demo';
import { Avatar, Button, Card, Pill, ProgressBar, cn } from '../components/ui';

export type MissionFilter = 'all' | 'active' | 'attention' | 'complete';

export interface MissionsViewProps {
  missions: readonly DemoMission[];
  filter?: MissionFilter;
  riskFilter?: RiskTone | 'all';
  onFilterChange?: (filter: MissionFilter) => void;
  onRiskFilterChange?: (risk: RiskTone | 'all') => void;
}

const missionStates: Record<
  DemoMission['state'],
  { label: string; shortLabel: string; tone: 'neutral' | 'green' | 'amber' | 'red' }
> = {
  scope_review: { label: 'Scope review', shortLabel: 'Scope', tone: 'amber' },
  engineering: { label: 'Engineer loop', shortLabel: 'Loop', tone: 'green' },
  manager_review: { label: 'Manager review', shortLabel: 'Review', tone: 'neutral' },
  human_review: { label: 'Human production check', shortLabel: 'Human', tone: 'amber' },
  deployed: { label: 'Deployed', shortLabel: 'Live', tone: 'green' },
  blocked: { label: 'Blocked', shortLabel: 'Blocked', tone: 'red' },
};

const riskTones: Record<RiskTone, 'green' | 'amber' | 'red'> = {
  low: 'green',
  medium: 'amber',
  high: 'red',
  critical: 'red',
};

const pipelineStages: Array<{
  key: Exclude<DemoMission['state'], 'blocked'>;
  label: string;
  caption: string;
  human?: boolean;
}> = [
  { key: 'scope_review', label: 'Scope', caption: 'Human gate', human: true },
  { key: 'engineering', label: 'Engineer loop', caption: 'Research → test' },
  { key: 'manager_review', label: 'Manager review', caption: 'Independent check' },
  { key: 'human_review', label: 'Production check', caption: 'Human gate', human: true },
  { key: 'deployed', label: 'Live', caption: 'Broker release' },
];

const filters: Array<{ value: MissionFilter; label: string }> = [
  { value: 'all', label: 'All missions' },
  { value: 'active', label: 'In progress' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'complete', label: 'Completed' },
];

function matchesFilter(mission: DemoMission, filter: MissionFilter) {
  if (filter === 'active') return !['deployed', 'blocked'].includes(mission.state);
  if (filter === 'attention') {
    return ['scope_review', 'human_review', 'blocked'].includes(mission.state) || mission.risk === 'critical';
  }
  if (filter === 'complete') return mission.state === 'deployed';
  return true;
}

function filterCount(missions: readonly DemoMission[], filter: MissionFilter) {
  return missions.filter((mission) => matchesFilter(mission, filter)).length;
}

export function MissionsView({
  missions,
  filter = 'all',
  riskFilter = 'all',
  onFilterChange,
  onRiskFilterChange,
}: MissionsViewProps) {
  const visibleMissions = missions.filter(
    (mission) => matchesFilter(mission, filter) && (riskFilter === 'all' || mission.risk === riskFilter),
  );
  const attentionCount = filterCount(missions, 'attention');
  const activeSpend = missions
    .filter((mission) => mission.state !== 'deployed')
    .reduce((total, mission) => total + mission.spent, 0);
  const activeBudget = missions
    .filter((mission) => mission.state !== 'deployed')
    .reduce((total, mission) => total + mission.budget, 0);

  return (
    <div className="space-y-7">
      <header className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-3xl">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-teal-700">
            <ShieldCheck size={16} />
            Controlled delivery
          </div>
          <h1 className="font-display text-[28px] font-light leading-tight tracking-[-0.035em] text-ink sm:text-[36px]">
            Deliver the outcome with every gate, dollar, and owner visible.
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-6 text-muted">
            Engineers repeat Research → Plan → Execute → Test until the work passes. A manager checks the evidence before posting a human production task.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:min-w-[360px]">
          <Card className="p-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.11em] text-muted">
              Human checkpoints
            </p>
            <div className="mt-2 flex items-end gap-2">
              <span className="font-mono text-2xl font-semibold tracking-[-0.04em] text-ink">{attentionCount}</span>
              <span className="pb-0.5 text-xs font-semibold text-muted">waiting or blocked</span>
            </div>
          </Card>
          <Card className="p-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.11em] text-muted">
              Active spend
            </p>
            <div className="mt-2 flex items-end gap-2">
              <span className="font-mono text-2xl font-semibold tracking-[-0.04em] text-ink">
                ${activeSpend.toFixed(2)}
              </span>
              <span className="pb-0.5 font-mono text-xs font-medium text-muted">of ${activeBudget}</span>
            </div>
          </Card>
        </div>
      </header>

      <Card as="section" className="overflow-hidden">
        <div className="flex flex-col gap-1 border-b border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-[16px] font-semibold tracking-[-0.02em] text-ink">Delivery pipeline</h2>
            <p className="mt-0.5 text-xs text-muted">The engineering loop repeats until tests pass; yellow stages require you.</p>
          </div>
          <Pill tone="green" dot className="mt-2 self-start sm:mt-0">
            Development allowed
          </Pill>
        </div>
        <div className="px-5 py-5">
          <div className="grid gap-2 md:grid-cols-5 md:gap-0">
            {pipelineStages.map((stage, index) => {
              const count = missions.filter((mission) => mission.state === stage.key).length;
              return (
                <div
                  key={stage.key}
                  className="relative flex items-center gap-3 rounded-[10px] border border-line-soft bg-[#fafbfb] px-3 py-2.5 text-left md:block md:rounded-none md:border-0 md:bg-transparent md:px-1 md:py-0 md:text-center"
                >
                  {index < pipelineStages.length - 1 ? (
                    <div className="absolute left-[56%] right-[-44%] top-4 hidden h-px bg-[#e4e7ea] md:block" />
                  ) : null}
                  <div
                    className={cn(
                      'relative grid size-8 shrink-0 place-items-center rounded-full border font-mono text-xs font-semibold md:mx-auto',
                      stage.human
                        ? 'border-[#e8c675] bg-[#fff6df] text-caution'
                        : stage.key === 'manager_review'
                          ? 'border-[#cdd3d8] bg-paper text-[#47535c]'
                        : count > 0
                          ? 'border-[#8bcfc8] bg-[#e7f7f5] text-teal-700'
                          : 'border-line bg-paper text-muted',
                    )}
                  >
                    {count}
                  </div>
                  <div className="min-w-0 md:contents">
                    <p className="text-xs font-bold text-[#37424a] md:mt-2">{stage.label}</p>
                    <p className={cn('mt-0.5 text-[9px] font-bold uppercase tracking-[0.09em]', stage.human ? 'text-caution' : 'text-muted')}>
                      {stage.caption}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      <section aria-labelledby="missions-list-heading">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 id="missions-list-heading" className="font-display text-lg font-semibold tracking-[-0.025em] text-ink">
              Mission queue
            </h2>
            <p className="mt-0.5 text-sm text-muted"><span className="font-mono">{visibleMissions.length}</span> visible across the workspace</p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex gap-1 overflow-x-auto rounded-[10px] border border-line bg-white p-1" role="toolbar" aria-label="Mission status filters">
              {filters.map((item) => (
                <Button
                  key={item.value}
                  size="sm"
                  variant={filter === item.value ? 'primary' : 'quiet'}
                  className="shrink-0 px-2.5"
                  onClick={() => onFilterChange?.(item.value)}
                  aria-pressed={filter === item.value}
                >
                  {item.label}
                  <span className={cn('ml-0.5 font-mono text-[10px]', filter === item.value ? 'text-ink' : 'text-muted')}>
                    {filterCount(missions, item.value)}
                  </span>
                </Button>
              ))}
            </div>
            <label className="relative shrink-0">
              <span className="sr-only">Filter by risk</span>
              <Filter size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <select
                value={riskFilter}
                onChange={(event) => onRiskFilterChange?.(event.target.value as RiskTone | 'all')}
                className="min-h-11 w-full appearance-none rounded-[10px] border border-[#d7dce0] bg-white py-2 pl-9 pr-8 text-xs font-bold text-[#37424a] outline-none hover:border-[#aeb6bc] focus:border-[#237a72] sm:w-auto"
              >
                <option value="all">All risk levels</option>
                <option value="low">Low risk</option>
                <option value="medium">Medium risk</option>
                <option value="high">High risk</option>
                <option value="critical">Critical risk</option>
              </select>
            </label>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {visibleMissions.map((mission) => {
            const budgetPercent = (mission.spent / mission.budget) * 100;
            const state = missionStates[mission.state];
            const atHumanGate = ['scope_review', 'human_review'].includes(mission.state);

            return (
              <Card key={mission.id} as="article" className="overflow-hidden">
                <div className="grid gap-5 p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_210px_210px] xl:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] font-bold text-muted">{mission.id}</span>
                      <Pill tone={state.tone} dot>{state.label}</Pill>
                      <Pill tone={riskTones[mission.risk]}>{mission.risk} risk</Pill>
                      {atHumanGate ? <Pill tone="amber">Human checkpoint</Pill> : null}
                    </div>
                    <h3 className="mt-2 font-display text-[17px] font-semibold tracking-[-0.025em] text-ink sm:text-lg">
                      {mission.title}
                    </h3>
                    <p className="mt-1 text-[13px] leading-5 text-muted">{mission.goal}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] font-semibold text-muted">
                      <span>{mission.project}</span>
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <GitBranch size={12} />
                        <span className="max-w-[250px] truncate font-mono">{mission.branch}</span>
                      </span>
                      <span className="inline-flex items-center gap-1.5"><Clock3 size={12} />Updated <span className="font-mono">{mission.updated}</span></span>
                    </div>
                  </div>

                  <div className="rounded-xl bg-paper p-3.5 xl:bg-transparent xl:p-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted">Progress</span>
                      <span className="font-mono text-sm font-semibold text-ink">{mission.progress}%</span>
                    </div>
                    <ProgressBar
                      value={mission.progress}
                      tone={mission.state === 'human_review' || mission.state === 'scope_review' || mission.state === 'blocked' ? 'amber' : 'green'}
                      className="mt-2"
                    />
                    <div className="mt-3 flex items-center gap-2">
                      <Avatar name={mission.owner} color={mission.ownerColor} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate text-xs font-bold">{mission.owner}</p>
                        <p className="truncate text-[10px] text-muted">{mission.model}</p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-line bg-[#fafafa] p-3.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-muted">
                        <CircleDollarSign size={13} /> Token budget
                      </span>
                      <span className="font-mono text-xs font-semibold">{Math.round(budgetPercent)}%</span>
                    </div>
                    <ProgressBar value={budgetPercent} tone={budgetPercent > 80 ? 'amber' : 'green'} className="mt-2" />
                    <div className="mt-2 flex items-baseline justify-between">
                      <span className="font-mono text-base font-semibold">${mission.spent.toFixed(2)}</span>
                      <span className="font-mono text-[10px] font-medium text-muted">of ${mission.budget.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}

          {visibleMissions.length === 0 ? (
            <Card className="grid min-h-48 place-items-center border-dashed p-6 text-center">
              <div>
                <p className="font-display text-base font-semibold text-ink">No missions match these filters</p>
                <p className="mt-1 text-sm text-muted">Change the status or risk filter to widen the queue.</p>
              </div>
            </Card>
          ) : null}
        </div>
      </section>
    </div>
  );
}
