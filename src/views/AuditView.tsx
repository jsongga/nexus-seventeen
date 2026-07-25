import {
  Bot,
  CheckCircle2,
  FileClock,
  Fingerprint,
  LockKeyhole,
  Search,
  ServerCog,
  ShieldAlert,
  UserRound,
} from 'lucide-react';
import type { AuditItem } from '../data/demo';
import { Button, Card, Pill, cn } from '../components/ui';

export type AuditActorFilter = AuditItem['actorType'] | 'all';

export interface AuditViewProps {
  items: readonly AuditItem[];
  actorFilter?: AuditActorFilter;
  onActorFilterChange?: (filter: AuditActorFilter) => void;
}

const actorFilters: Array<{ value: AuditActorFilter; label: string; icon: typeof Bot }> = [
  { value: 'all', label: 'All actors', icon: Search },
  { value: 'human', label: 'Humans', icon: UserRound },
  { value: 'agent', label: 'Agents', icon: Bot },
  { value: 'system', label: 'System', icon: ServerCog },
];

const actorStyles: Record<AuditItem['actorType'], { label: string; tone: 'neutral'; icon: typeof Bot }> = {
  human: { label: 'Human', tone: 'neutral', icon: UserRound },
  agent: { label: 'Agent', tone: 'neutral', icon: Bot },
  system: { label: 'System', tone: 'neutral', icon: ServerCog },
};

const eventToneStyles: Record<
  AuditItem['tone'],
  { ring: string; icon: string; line: string; Icon: typeof CheckCircle2 }
> = {
  neutral: {
    ring: 'border-[#d9dde1] bg-[#eef0f2]',
    icon: 'text-muted',
    line: 'bg-[#e4e7ea]',
    Icon: FileClock,
  },
  green: {
    ring: 'border-[#b9ddd9] bg-[#e8f5f3]',
    icon: 'text-teal-700',
    line: 'bg-[#b9ddd9]',
    Icon: CheckCircle2,
  },
  amber: {
    ring: 'border-[#f0d391] bg-[#fff6df]',
    icon: 'text-caution',
    line: 'bg-[#f0d391]',
    Icon: FileClock,
  },
  red: {
    ring: 'border-[#e8b5af] bg-[#fff0ee]',
    icon: 'text-urgent',
    line: 'bg-[#e8b5af]',
    Icon: ShieldAlert,
  },
};

function actorCount(items: readonly AuditItem[], actor: AuditActorFilter) {
  return actor === 'all' ? items.length : items.filter((item) => item.actorType === actor).length;
}

export function AuditView({ items, actorFilter = 'all', onActorFilterChange }: AuditViewProps) {
  const visibleItems = items.filter((item) => actorFilter === 'all' || item.actorType === actorFilter);
  const humanEvents = actorCount(items, 'human');
  const blockedEvents = items.filter((item) => item.tone === 'red').length;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-3xl">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-bold text-muted">
            <FileClock size={14} className="text-teal-700" />
            Immutable history
          </div>
          <h1 className="font-display text-[28px] font-light leading-tight tracking-[-0.035em] text-ink sm:text-[36px]">
            Reconstruct every decision, handoff, and blocked action.
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-6 text-muted">
            The audit ledger is append-only, so oversight survives beyond a chat transcript and production decisions stay attributable.
          </p>
        </div>

        <Card className="grid grid-cols-3 divide-x divide-[#e4e7ea] overflow-hidden sm:min-w-[410px]">
          <div className="p-4">
            <p className="text-[9px] font-bold uppercase tracking-[0.11em] text-muted">Events</p>
            <p className="mt-1.5 font-mono text-xl font-medium tabular-nums text-ink">{items.length}</p>
            <p className="text-[9px] font-semibold text-[#66707a]">in view</p>
          </div>
          <div className="p-4">
            <p className="text-[9px] font-bold uppercase tracking-[0.11em] text-muted">Human</p>
            <p className="mt-1.5 font-mono text-xl font-medium tabular-nums text-ink">{humanEvents}</p>
            <p className="text-[9px] font-semibold text-[#66707a]">signed actions</p>
          </div>
          <div className="p-4">
            <p className="text-[9px] font-bold uppercase tracking-[0.11em] text-muted">Blocked</p>
            <p className="mt-1.5 font-mono text-xl font-medium tabular-nums text-urgent">{blockedEvents}</p>
            <p className="text-[9px] font-semibold text-[#66707a]">policy stops</p>
          </div>
        </Card>
      </header>

      <Card as="section" className="overflow-hidden border-[#b9ddd9] !bg-white">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-teal-500 text-ink">
              <LockKeyhole size={19} />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-base font-bold tracking-[-0.02em] text-ink">Append-only event ledger</h2>
                <Pill tone="green">Retention on</Pill>
              </div>
              <p className="mt-1 max-w-2xl text-[12px] leading-5 text-muted">
                Entries may be added, never edited in place. Release actions retain the actor, target, policy result, and evidence reference.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 rounded-xl border border-[#b9ddd9] bg-[#e8f5f3] px-3 py-2.5">
            <Fingerprint size={16} className="text-teal-700" />
            <div>
              <p className="text-[10px] font-bold text-teal-700">Evidence-linked</p>
              <p className="mt-0.5 text-[9px] text-muted">Actor + target + policy</p>
            </div>
          </div>
        </div>
      </Card>

      <section aria-labelledby="audit-events-heading">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 id="audit-events-heading" className="font-display text-lg font-bold tracking-[-0.025em] text-ink">Event timeline</h2>
            <p className="mt-0.5 text-sm text-muted">Newest first · <span className="font-mono tabular-nums">{visibleItems.length}</span> matching events</p>
          </div>

          <div className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-white p-1" role="toolbar" aria-label="Filter audit events by actor">
            {actorFilters.map((filter) => {
              const Icon = filter.icon;
              const active = actorFilter === filter.value;
              return (
                <Button
                  key={filter.value}
                  size="sm"
                  variant={active ? 'primary' : 'quiet'}
                  className="shrink-0 px-2.5"
                  icon={<Icon size={13} />}
                  onClick={() => onActorFilterChange?.(filter.value)}
                  aria-pressed={active}
                >
                  {filter.label}
                  <span className={cn('ml-0.5 font-mono text-[10px] tabular-nums', active ? 'text-ink/65' : 'text-[#66707a]')}>
                    {actorCount(items, filter.value)}
                  </span>
                </Button>
              );
            })}
          </div>
        </div>

        <Card className="mt-4 overflow-hidden px-4 py-2 sm:px-6">
          {visibleItems.length > 0 ? (
            <ol>
              {visibleItems.map((item, index) => {
                const actor = actorStyles[item.actorType];
                const eventStyle = eventToneStyles[item.tone];
                const ActorIcon = actor.icon;
                const EventIcon = eventStyle.Icon;
                const isLast = index === visibleItems.length - 1;

                return (
                  <li key={item.id} className="relative grid grid-cols-[42px_minmax(0,1fr)] gap-3 sm:grid-cols-[48px_minmax(0,1fr)_140px] sm:gap-4">
                    <div className="relative flex justify-center pt-5 sm:pt-6">
                      {!isLast ? <span className={cn('absolute bottom-0 top-[3.35rem] w-px', eventStyle.line)} /> : null}
                      <span className={cn('relative z-[1] grid size-9 place-items-center rounded-xl border shadow-[0_0_0_4px_white]', eventStyle.ring, eventStyle.icon)}>
                        <EventIcon size={16} />
                      </span>
                    </div>

                    <div className={cn('min-w-0 py-5 sm:py-6', !isLast && 'border-b border-[#eef0f2]')}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-display text-[15px] font-bold tracking-[-0.015em] text-ink">{item.actor}</span>
                        <Pill tone={actor.tone}>
                          <ActorIcon size={11} /> {actor.label}
                        </Pill>
                        <span className="text-[13px] font-semibold text-[#404a54]">{item.action}</span>
                      </div>
                      <div className="mt-2 inline-flex max-w-full items-center rounded-lg border border-line bg-paper px-2.5 py-1.5 font-mono text-[10px] font-medium text-[#404a54]">
                        <span className="truncate">{item.target}</span>
                      </div>
                      <p className="mt-2 max-w-3xl text-[12px] leading-5 text-muted">{item.detail}</p>
                      <p className="mt-2 font-mono text-[10px] font-medium tabular-nums text-[#66707a] sm:hidden">{item.time}</p>
                    </div>

                    <div className={cn('hidden py-6 text-right sm:block', !isLast && 'border-b border-[#eef0f2]')}>
                      <p className="font-mono text-[11px] font-medium tabular-nums text-muted">{item.time}</p>
                      <p className="mt-1 font-mono text-[9px] text-[#66707a]">{item.id}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="grid min-h-48 place-items-center text-center">
              <div>
                <p className="font-display text-base font-bold text-ink">No events from this actor type</p>
                <p className="mt-1 text-sm text-muted">Select another actor filter to inspect the ledger.</p>
              </div>
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
