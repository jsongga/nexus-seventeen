import {
  ChevronRight,
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
        'overflow-hidden border-teal-border bg-white',
        className,
      )}
    >
      <div className={cn('flex flex-wrap items-center justify-between gap-2 border-b border-teal-border bg-teal-soft/70', compact ? 'px-4 py-3' : 'px-5 py-4 sm:px-6')}>
        <div className="flex items-center gap-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-white text-teal-700 shadow-[0_1px_2px_rgba(23,28,36,.06)]">
            <ScanText size={15} />
          </span>
          <div>
            <p className="text-[12px] font-semibold text-teal-700">
              Plain-language summary
            </p>
            <p className="mt-0.5 text-[10px] text-muted">Updates automatically as the work progresses</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone={freshness.tone}>{freshness.label}</Pill>
          <Pill tone={confidenceTone[summary.confidence]}>{summary.confidence} confidence</Pill>
        </div>
      </div>

      <div className={cn(compact ? 'p-4' : 'p-5 sm:p-6')}>
        {paused ? (
          <div className="mb-4 flex items-start gap-2 rounded-[10px] border border-caution-border bg-caution-soft px-3 py-2.5 text-[10px] leading-4 text-caution">
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
              ? 'border-info-border bg-info-soft text-info'
              : 'border-caution-border bg-caution-soft text-caution',
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
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[10px] bg-ink-panel text-teal-300">
            <Users size={16} />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-muted">
              What changes for users
            </p>
            <p
              className={cn(
                'mt-1.5 font-display font-medium leading-snug tracking-[-0.02em] text-ink',
                compact ? 'text-[14px]' : 'text-[15px] sm:text-[16px]',
              )}
            >
              {summary.userImpact}
            </p>
            <p className={cn('text-muted', compact ? 'mt-2 text-[11px] leading-5' : 'mt-2.5 text-[12px] leading-5')}>
              <span className="font-semibold text-muted">Intended outcome:</span> {summary.outcome}
            </p>
          </div>
        </div>

        <div className={cn('grid gap-x-6 gap-y-3', compact ? 'mt-3.5' : 'mt-4 md:grid-cols-2')}>
          <div>
            <div className="flex items-center gap-2 text-[11px] font-semibold text-muted">
              <FileText size={13} className="text-teal-700" />
              Where things stand
            </div>
            <p className="mt-1.5 text-[11px] leading-5 text-muted">{summary.plainStatus}</p>
          </div>
          <div>
            <div className="flex items-center gap-2 text-[11px] font-semibold text-muted">
              <Target size={13} className="text-teal-700" />
              Next user-visible outcome
            </div>
            <p className="mt-1.5 text-[11px] leading-5 text-muted">{summary.nextMilestone}</p>
          </div>
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-line bg-line-soft/55 px-3 py-2.5 text-[10px] leading-4 text-muted">
          <History size={13} className="mt-0.5 shrink-0 text-teal-700" />
          <span><span className="font-semibold text-muted">What changed in this revision:</span> {summary.changeSummary}</span>
        </div>
      </div>

      <footer className={cn('border-t border-line bg-card', compact ? 'px-4 py-3' : 'px-5 py-3.5 sm:px-6')}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1.5 font-medium text-muted">
            <Clock3 size={12} className="text-teal-700" /> Updated {summary.refreshedAt}
          </span>
          <span className="text-muted">·</span>
          <span>A plain-language summary — not a test result or release evidence.</span>
        </div>
        <details className="group mt-2">
          <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-[11px] font-semibold text-teal-700 [&::-webkit-details-marker]:hidden">
            <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
            Details
          </summary>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10px] text-muted">
            <span>Revision {summary.revision}</span>
            <span>{summary.model}</span>
            <span>Through event {summary.sourceThroughSequence}</span>
            <span>{summary.sourceUpdates} source {summary.sourceUpdates === 1 ? 'update' : 'updates'}</span>
          </div>
          <p className="mt-2 break-words font-mono text-[9px] text-muted">
            Sources: {summary.sourceRefs.join(' · ')} · Written by {summary.generatedBy}
          </p>
        </details>
      </footer>
    </Card>
  );
}
