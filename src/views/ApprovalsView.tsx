import {
  CheckCircle2,
  CircleSlash2,
  Clock3,
  Filter,
  Fingerprint,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { ApprovalCard } from '../components/ApprovalCard';
import type { ApprovalItem } from '../data/demo';
import { Card, cn, Pill } from '../components/ui';

type FilterKey = 'pending' | 'production' | 'all';

export function ApprovalsView({
  approvals,
  onOpenApproval,
}: {
  approvals: ApprovalItem[];
  onOpenApproval: (id: string) => void;
}) {
  const [filter, setFilter] = useState<FilterKey>('pending');
  const visible = useMemo(() => {
    if (filter === 'pending') return approvals.filter((approval) => approval.status === 'pending');
    if (filter === 'production') return approvals.filter((approval) => approval.kind === 'production');
    return approvals;
  }, [approvals, filter]);

  const pending = approvals.filter((approval) => approval.status === 'pending').length;
  const completed = approvals.filter(
    (approval) => approval.status === 'approved' || approval.status === 'deployed',
  ).length;

  return (
    <div className="space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone="amber" dot>
            {pending} waiting
          </Pill>
          <Pill tone="green">Manager → human</Pill>
          <span className="text-[11px] font-semibold text-muted">Human-only decision queue</span>
        </div>
        <h1 className="mt-3 font-display text-[22px] font-semibold leading-tight tracking-[-0.025em] text-ink sm:text-[26px]">
          Decisions, with the proof attached.
        </h1>
        <p className="mt-2 max-w-2xl text-[14px] leading-6 text-muted sm:text-[15px]">
          Managers review completed engineering loops to the best of their ability, then post a decision-ready task here. Only a human can record release authorization.
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-caution-soft text-caution">
              <Clock3 size={18} />
            </span>
            <div>
              <p className="font-mono text-2xl font-medium tabular-nums text-ink">{pending}</p>
              <p className="text-[11px] font-semibold text-muted">Human decisions waiting</p>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-teal-soft text-teal-700">
              <CheckCircle2 size={18} />
            </span>
            <div>
              <p className="font-mono text-2xl font-medium tabular-nums text-ink">{completed}</p>
              <p className="text-[11px] font-semibold text-muted">Human decisions recorded</p>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-teal-soft text-teal-700">
              <Fingerprint size={18} />
            </span>
            <div>
              <p className="font-mono text-2xl font-medium tabular-nums text-ink">1×</p>
              <p className="text-[11px] font-semibold text-muted">Release approval usage</p>
            </div>
          </div>
        </Card>
      </section>

      <Card className="overflow-hidden border-ink-panel !bg-ink-panel text-white">
        <div className="grid gap-4 p-5 sm:grid-cols-[auto_1fr_auto] sm:items-center sm:px-6">
          <span className="grid size-11 place-items-center rounded-[14px] border border-line bg-ink-panel text-teal-300">
            <LockKeyhole size={21} />
          </span>
          <div>
            <h2 className="font-display text-sm font-bold">Managers prepare. Humans authorize release.</h2>
            <p className="mt-1 text-[11px] leading-5 text-muted">
              This demo checks that a recent human approval matches the release digest, then records simulated consumption. No deployment occurs.
            </p>
          </div>
          <div className="flex items-center gap-2 text-[10px] font-bold text-muted">
            <ShieldCheck size={15} className="text-teal-300" />
            Demo policy check
          </div>
        </div>
      </Card>

      <section>
        <div className="flex flex-col gap-3 border-b border-black/[0.07] pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-[17px] font-bold tracking-[-0.02em] text-ink">Manager handoff inbox</h2>
            <p className="mt-0.5 text-sm text-muted">
              Manager handoffs; production decisions are human-only. Sorted by consequence, then age.
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-xl border border-line bg-white p-1">
            <Filter size={14} className="ml-2 mr-1 text-muted" />
            {(
              [
                ['pending', 'Waiting'],
                ['production', 'Prod tasks'],
                ['all', 'All'],
              ] as const
            ).map(([key, label]) => (
              <button
                type="button"
                key={key}
                onClick={() => setFilter(key)}
                className={cn(
                  'min-h-8 rounded-lg px-3 text-[11px] font-bold transition-colors',
                  filter === key
                    ? 'bg-teal-500 text-ink'
                    : 'text-muted hover:bg-muted-surface hover:text-ink',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          {visible.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              onClick={() => onOpenApproval(approval.id)}
            />
          ))}
        </div>
        {visible.length === 0 ? (
          <Card className="mt-4 flex flex-col items-center px-5 py-14 text-center">
            <span className="grid size-12 place-items-center rounded-[14px] bg-muted-surface text-muted">
              <CircleSlash2 size={21} />
            </span>
            <h3 className="mt-3 font-display text-base font-bold text-ink">Nothing in this queue</h3>
            <p className="mt-1 max-w-sm text-[12px] leading-5 text-muted">
              Completed decisions stay in this browser-local event history even when the inbox is empty.
            </p>
          </Card>
        ) : null}
      </section>
    </div>
  );
}
