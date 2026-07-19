import {
  ArrowRight,
  CheckCircle2,
  CircleHelp,
  ClipboardCheck,
  GitCommitHorizontal,
  Rocket,
  ShieldAlert,
} from 'lucide-react';
import type { ApprovalItem } from '../data/demo';
import { Avatar, cn, Pill } from './ui';

const kindMeta = {
  production: {
    label: 'Human-only production task',
    icon: Rocket,
    tone: 'neutral' as const,
    iconClass: 'bg-ink text-[#7fe0d6]',
  },
  scope: {
    label: 'Scope approval',
    icon: ClipboardCheck,
    tone: 'green' as const,
    iconClass: 'bg-[#e8f5f3] text-teal-700',
  },
  decision: {
    label: 'Your decision',
    icon: CircleHelp,
    tone: 'amber' as const,
    iconClass: 'bg-[#fff6df] text-caution',
  },
};

export function ApprovalCard({
  approval,
  selected = false,
  onClick,
  compact = false,
}: {
  approval: ApprovalItem;
  selected?: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  const meta = kindMeta[approval.kind];
  const Icon = meta.icon;
  const passedChecks = approval.checks.filter((check) => check.status === 'passed').length;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group w-full rounded-[14px] border bg-white p-4 text-left shadow-[0_1px_2px_rgba(23,28,36,.05),0_10px_26px_rgba(23,28,36,.06)] transition-colors hover:border-[#237a72]/45',
        selected ? 'border-[#237a72] ring-2 ring-[#41bbb0]/20' : 'border-line',
        compact ? 'sm:p-3.5' : 'sm:p-5',
      )}
    >
      <div className="flex items-start gap-3.5">
        <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', meta.iconClass)}>
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={meta.tone}>{meta.label}</Pill>
            {approval.managerReview ? <Pill tone="green">Manager handoff</Pill> : null}
            {approval.risk === 'high' || approval.risk === 'critical' ? (
              <Pill tone="red" dot>
                {approval.risk} risk
              </Pill>
            ) : null}
            <span className="ml-auto font-mono text-[11px] font-medium tabular-nums text-[#66707a]">{approval.requestedAt}</span>
          </div>
          <h3 className="mt-2.5 font-display text-[15px] font-bold leading-5 tracking-[-0.02em] text-ink sm:text-base">
            {approval.title}
          </h3>
          {!compact ? (
            <p className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-muted">{approval.summary}</p>
          ) : null}

          {approval.kind === 'production' && approval.managerReview && !compact ? (
            <div className="mt-3 rounded-[10px] border border-[#b9ddd9] bg-[#e8f5f3] px-3 py-2.5 text-[11px] leading-4 text-[#365f5b]">
              <span className="font-bold text-teal-700">
                {approval.managerReview.manager} completed the manager review.
              </span>{' '}
              Reviewed to the best of their ability; only a human can approve or deploy this release.
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[#eef0f2] pt-3 text-[11px] font-semibold text-muted">
            <span className="flex items-center gap-1.5">
              <Avatar name={approval.requestedBy} size="sm" />
              <span className="min-w-0">
                <span className="block truncate font-bold text-[#333c46]">{approval.requestedBy}</span>
                <span className="block truncate text-[10px] text-[#66707a]">{approval.requestedByRole}</span>
              </span>
            </span>
            {approval.release ? (
              <>
                <span className="flex items-center gap-1 font-mono tabular-nums">
                  <GitCommitHorizontal size={13} />
                  {approval.release.commit.slice(0, 7)}
                </span>
                <span className="flex items-center gap-1 font-mono tabular-nums text-teal-700">
                  <CheckCircle2 size={13} />
                  {passedChecks}/{approval.checks.length} gates
                </span>
              </>
            ) : approval.budget ? (
              <span className="font-mono tabular-nums">{approval.budget}</span>
            ) : (
              <span className="flex items-center gap-1 text-caution">
                <ShieldAlert size={13} />
                Agents paused here
              </span>
            )}
            <ArrowRight
              size={15}
              className="ml-auto text-muted transition-colors group-hover:text-teal-700"
            />
          </div>
        </div>
      </div>
    </button>
  );
}
