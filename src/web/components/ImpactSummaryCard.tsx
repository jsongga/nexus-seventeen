import {
  ArrowRight,
  CircleAlert,
  Clock3,
  FileText,
  History,
  ScanText,
  RefreshCw,
  Target,
  Users,
} from 'lucide-react';
import type { ImpactSummary } from '../data/demo';
import { Card, cn, Pill } from './ui';

export interface ImpactSummaryCardProps {
  summary: ImpactSummary;
  compact?: boolean;
  paused?: boolean;
  className?: string;
}

const confidenceTone = {
  high: 'green',
  medium: 'amber',
  low: 'neutral',
} as const;

const freshnessPresentation = {
  current: { label: 'Current', tone: 'green' },
  refreshing: { label: 'Refreshing', tone: 'blue' },
  stale: { label: 'Stale', tone: 'amber' },
  error: { label: 'Refresh failed', tone: 'red' },
} as const;

export function ImpactSummaryCard({
  summary,
  compact = false,
  paused = false,
  className,
}: ImpactSummaryCardProps) {
  const freshness = freshnessPresentation[summary.freshness];
  return (
    <Card
      as="section"
      aria-live="polite"
      className={cn(
        'overflow-hidden border-[#cfe2df] bg-white',
        className,
      )}
    >
      <div className={cn('flex flex-wrap items-center justify-between gap-2 border-b border-[#cfe2df] bg-teal-soft/70', compact ? 'px-4 py-3' : 'px-5 py-4 sm:px-6')}>
        <div className="flex items-center gap-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-white text-teal-700 shadow-[0_1px_2px_rgba(23,28,36,.06)]">
            <ScanText size={15} />
          </span>
          <div>
            <p className="text-[12px] font-semibold text-teal-700">
              Low-cost impact observer
            </p>
            <p className="mt-0.5 text-[10px] text-[#62716f]">Read-only, revisioned, and event-driven</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone={freshness.tone}>{freshness.label}</Pill>
          <Pill tone={confidenceTone[summary.confidence]}>{summary.confidence} confidence</Pill>
        </div>
      </div>

      <div className={cn(compact ? 'p-4' : 'p-5 sm:p-6')}>
        {paused ? (
          <div className="mb-4 flex items-start gap-2 rounded-[10px] border border-[#ead09b] bg-caution-soft px-3 py-2.5 text-[10px] leading-4 text-caution">
            <CircleAlert size={13} className="mt-0.5 shrink-0" />
            <span>
              Human pause active. No model or tool calls are running; this is the last good outcome summary from the preserved checkpoint.
            </span>
          </div>
        ) : null}
        {summary.freshness !== 'current' ? (
          <div className={cn(
            'mb-4 flex items-start gap-2 rounded-[10px] border px-3 py-2.5 text-[10px] leading-4',
            summary.freshness === 'refreshing'
              ? 'border-[#cbd9e1] bg-[#eef3f6] text-[#3f6073]'
              : 'border-[#ead09b] bg-caution-soft text-caution',
          )}>
            {summary.freshness === 'refreshing' ? (
              <RefreshCw size={13} className="mt-0.5 shrink-0 animate-spin" />
            ) : (
              <CircleAlert size={13} className="mt-0.5 shrink-0" />
            )}
            <span>
              {summary.freshness === 'refreshing'
                ? `Refreshing from ${summary.pendingSourceEvents ?? 1} new ${(summary.pendingSourceEvents ?? 1) === 1 ? 'event' : 'events'}. The last good revision stays visible.`
                : summary.error ?? 'The prior verified revision remains visible while the observer catches up.'}
            </span>
          </div>
        ) : null}
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[10px] bg-ink text-teal-300">
            <Users size={16} />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-muted">
              What changes for users
            </p>
            <p
              className={cn(
                'mt-1.5 font-display font-semibold leading-snug tracking-[-0.02em] text-ink',
                compact ? 'text-[15px]' : 'text-lg sm:text-xl',
              )}
            >
              {summary.userImpact}
            </p>
            <p className={cn('text-muted', compact ? 'mt-2 text-[11px] leading-5' : 'mt-2.5 text-[12px] leading-5')}>
              <span className="font-semibold text-[#4f5964]">Intended outcome:</span> {summary.outcome}
            </p>
          </div>
        </div>

        <div className={cn('grid gap-3', compact ? 'mt-4' : 'mt-5 md:grid-cols-2')}>
          <div className="rounded-[10px] border border-line bg-[#fafbfb] p-3.5">
            <div className="flex items-center gap-2 text-[11px] font-semibold text-muted">
              <FileText size={13} className="text-teal-700" />
              Where things stand
            </div>
            <p className="mt-2 text-[11px] leading-5 text-[#4f5964]">{summary.plainStatus}</p>
          </div>
          <div className="rounded-[10px] border border-line bg-[#fafbfb] p-3.5">
            <div className="flex items-center gap-2 text-[11px] font-semibold text-muted">
              <Target size={13} className="text-teal-700" />
              Next user-visible outcome
            </div>
            <p className="mt-2 text-[11px] leading-5 text-[#4f5964]">{summary.nextMilestone}</p>
          </div>
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-line bg-line-soft/55 px-3 py-2.5 text-[10px] leading-4 text-muted">
          <History size={13} className="mt-0.5 shrink-0 text-teal-700" />
          <span><span className="font-semibold text-[#4f5964]">What changed in this revision:</span> {summary.changeSummary}</span>
        </div>
      </div>

      <footer className={cn('border-t border-line bg-[#fafbfb]', compact ? 'px-4 py-3' : 'px-5 py-3.5 sm:px-6')}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10px] text-muted">
          <span className="inline-flex items-center gap-1.5">
            <Clock3 size={12} className="text-teal-700" /> Refreshed {summary.refreshedAt}
          </span>
          <span>Revision {summary.revision}</span>
          <span>{summary.model}</span>
          <span>Through event {summary.sourceThroughSequence}</span>
          <span>{summary.sourceUpdates} source {summary.sourceUpdates === 1 ? 'update' : 'updates'}</span>
        </div>
        <p className="mt-2 break-words font-mono text-[9px] text-muted">
          Sources: {summary.sourceRefs.join(' · ')} · Written by {summary.generatedBy}
        </p>
        <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-4 text-caution">
          <ArrowRight size={11} className="mt-0.5 shrink-0" />
          Concise interpretation only—not test, review, approval, or release evidence.
        </p>
      </footer>
    </Card>
  );
}
