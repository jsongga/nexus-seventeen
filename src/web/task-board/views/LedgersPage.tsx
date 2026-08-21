import { CircleAlert, CirclePause, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Card, Pill } from '../../components/ui';
import type { TaskBoardClient } from '../data/client';
import type { RawFindingsLedger, RawParksLedger } from '../data/parse';
import { elapsedMilliseconds, formatElapsedDuration } from '../model/observability';
import { prettyStatus } from '../model/work-item-labels';
import { pageToHash } from '../routing/routing';

const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function displayLabel(value: string): string {
  const label = prettyStatus(value);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function workItemHref(workItemId: string): string {
  return pageToHash({ kind: 'intake', workItemId });
}

function Timestamp({ value }: { value: string }) {
  const parsed = new Date(value);
  return <time dateTime={value}>{Number.isNaN(parsed.valueOf()) ? value : dateTime.format(parsed)}</time>;
}

export interface FindingCategoryCounts {
  category: string;
  total: number;
  minor: number;
  major: number;
  critical: number;
  other: number;
  blocking: number;
}

export function findingCategoryCounts(ledger: RawFindingsLedger): FindingCategoryCounts[] {
  const categories = new Map<string, {
    total: number;
    minor: number;
    major: number;
    critical: number;
    other: number;
    blocking: number;
  }>();
  for (const aggregate of ledger.categories) {
    const current = categories.get(aggregate.category) ?? {
      total: 0,
      minor: 0,
      major: 0,
      critical: 0,
      other: 0,
      blocking: 0,
    };
    current.total += aggregate.count;
    if (aggregate.severity === 'minor') current.minor += aggregate.count;
    else if (aggregate.severity === 'major') current.major += aggregate.count;
    else if (aggregate.severity === 'critical') current.critical += aggregate.count;
    else current.other += aggregate.count;
    if (aggregate.blocking) current.blocking += aggregate.count;
    categories.set(aggregate.category, current);
  }
  return [...categories.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, counts]) => ({ category, ...counts }));
}

export function FindingsLedgerSection({ ledger }: { ledger: RawFindingsLedger }) {
  const rows = findingCategoryCounts(ledger);

  return (
    <section aria-labelledby="findings-ledger-heading">
      <div className="border-b border-line px-4 py-4 sm:px-5">
        <h2 id="findings-ledger-heading" className="font-display text-xl font-light tracking-[0.01em] text-ink">Review findings</h2>
        <p className="mt-1 text-sm leading-6 text-muted">Counts by category and severity, with the 50 most recent findings available for inspection.</p>
      </div>
      {rows.length === 0 ? (
        <div className="flex min-h-40 flex-col items-center justify-center px-5 py-8 text-center">
          <CirclePause size={18} className="text-muted" aria-hidden="true" />
          <p className="mt-2 text-sm font-medium text-ink">No review findings</p>
          <p className="mt-1 text-xs leading-5 text-muted">No review findings have been recorded.</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-left text-xs">
              <thead className="bg-muted-surface text-[11px] text-muted">
                <tr>
                  {['Category', 'Total', 'Minor', 'Major', 'Critical', 'Other', 'Blocking'].map((heading) => (
                    <th key={heading} scope="col" className="whitespace-nowrap border-b border-line px-4 py-2.5 font-medium">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map(({ category, ...counts }) => (
                  <tr key={category}>
                    <th scope="row" className="whitespace-nowrap px-4 py-3 font-medium text-ink">{displayLabel(category)}</th>
                    {[counts.total, counts.minor, counts.major, counts.critical, counts.other, counts.blocking].map((count, index) => (
                      <td key={`${category}-${index}`} className="px-4 py-3 font-mono text-muted">{count}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="divide-y divide-line border-t border-line" aria-label="Recent findings by category">
            {rows.map(({ category }) => {
              const recent = ledger.recent.filter((finding) => finding.category === category);
              return (
                <details key={category} className="group px-4 py-3 sm:px-5">
                  <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover">
                    <span>{displayLabel(category)} findings</span>
                    <span className="text-xs font-normal text-muted">{recent.length} recent</span>
                  </summary>
                  {recent.length === 0 ? (
                    <p className="pb-2 pt-3 text-xs text-muted">No recent findings in this category.</p>
                  ) : (
                    <ol className="space-y-3 pb-2 pt-3">
                      {recent.map((finding) => {
                        const location = finding.file
                          ? `${finding.file}${finding.line === null || finding.line === undefined ? '' : `:${finding.line}`}`
                          : null;
                        return (
                          <li key={finding.findingId} className="rounded-md border border-line bg-muted-surface p-3.5">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <Pill tone={finding.blocking ? 'red' : 'neutral'}>{finding.blocking ? 'Blocking · ' : ''}{displayLabel(finding.severity)}</Pill>
                                <Pill>{displayLabel(finding.stage)} · round {finding.round}</Pill>
                              </div>
                              <Timestamp value={finding.createdAt} />
                            </div>
                            {location === null ? null : <code className="mt-2 block break-all font-mono text-[11px] leading-5 text-muted">{location}</code>}
                            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                              <div><dt className="text-[11px] font-medium text-muted">Expected</dt><dd className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-5 text-ink">{finding.expected}</dd></div>
                              <div><dt className="text-[11px] font-medium text-muted">Actual</dt><dd className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-5 text-ink">{finding.actual}</dd></div>
                            </dl>
                            <a className="mt-3 inline-flex min-h-9 items-center text-xs font-medium text-ink underline decoration-line underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover" href={workItemHref(finding.workItemId)}>
                              Open work item {finding.workItemId}
                            </a>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </details>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

export function ParksLedgerSection({
  ledger,
  nowMs = Date.now(),
}: {
  ledger: RawParksLedger;
  nowMs?: number;
}) {
  const open = [...ledger.open].sort((left, right) => left.parkedAtMs - right.parkedAtMs);
  const resolved = [...ledger.resolved].sort((left, right) => (right.resolvedAtMs ?? 0) - (left.resolvedAtMs ?? 0));
  return (
    <section aria-labelledby="parks-ledger-heading">
      <div className="border-b border-line px-4 py-4 sm:px-5">
        <h2 id="parks-ledger-heading" className="font-display text-xl font-light tracking-[0.01em] text-ink">Park ledger</h2>
        <p className="mt-1 text-sm leading-6 text-muted">Open parks are oldest first; resolved records preserve the latest resolution history.</p>
        <p className="mt-2 rounded-md border border-line bg-muted-surface px-3 py-2 text-xs leading-5 text-muted">
          Park records begin {ledger.recordsSince}; older parks have no ledger entry.
        </p>
      </div>

      <div className="px-4 py-4 sm:px-5">
        <h3 className="text-xs font-semibold text-ink">Open parks</h3>
        {open.length === 0 ? (
          <p className="mt-2 rounded-md border border-line bg-muted-surface px-3.5 py-4 text-sm text-muted">No work items are currently parked.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-md border border-line">
            <table className="min-w-full border-collapse text-left text-xs">
              <thead className="bg-muted-surface text-[11px] text-muted"><tr>{['Work item', 'Category', 'Age', 'Reason', 'Parked'].map((heading) => <th key={heading} scope="col" className="whitespace-nowrap border-b border-line px-3 py-2 font-medium">{heading}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {open.map((park) => (
                  <tr key={park.parkRecordId} className="align-top">
                    <td className="min-w-52 px-3 py-3"><a className="font-medium text-ink underline decoration-line underline-offset-4" href={workItemHref(park.workItemId)}>{park.workItemTitle}</a></td>
                    <td className="whitespace-nowrap px-3 py-3 text-muted">{displayLabel(park.category)}</td>
                    <td className="whitespace-nowrap px-3 py-3 font-mono text-ink">{formatElapsedDuration(elapsedMilliseconds(park.parkedAtMs, nowMs))}</td>
                    <td className="min-w-64 whitespace-pre-wrap break-words px-3 py-3 leading-5 text-ink">{park.reason}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-muted"><Timestamp value={park.parkedAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="border-t border-line px-4 py-4 sm:px-5">
        <h3 className="text-xs font-semibold text-ink">Resolution history</h3>
        {resolved.length === 0 ? (
          <p className="mt-2 rounded-md border border-line bg-muted-surface px-3.5 py-4 text-sm text-muted">No park resolutions have been recorded.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-md border border-line">
            <table className="min-w-full border-collapse text-left text-xs">
              <thead className="bg-muted-surface text-[11px] text-muted"><tr>{['Work item', 'Category', 'Resolution', 'Reason', 'Resolved'].map((heading) => <th key={heading} scope="col" className="whitespace-nowrap border-b border-line px-3 py-2 font-medium">{heading}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {resolved.map((park) => (
                  <tr key={park.parkRecordId} className="align-top">
                    <td className="min-w-52 px-3 py-3"><a className="font-medium text-ink underline decoration-line underline-offset-4" href={workItemHref(park.workItemId)}>{park.workItemTitle}</a></td>
                    <td className="whitespace-nowrap px-3 py-3 text-muted">{displayLabel(park.category)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-ink">{displayLabel(park.resolution ?? 'unknown')}</td>
                    <td className="min-w-64 whitespace-pre-wrap break-words px-3 py-3 leading-5 text-ink">{park.reason}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-muted">{park.resolvedAt === null ? 'Not recorded' : <Timestamp value={park.resolvedAt} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function LedgerLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center px-5 py-8 text-center" role="alert">
      <CircleAlert size={18} className="text-urgent" aria-hidden="true" />
      <p className="mt-2 text-sm font-medium text-ink">Ledger unavailable</p>
      <p className="mt-1 max-w-lg text-xs leading-5 text-muted">{message}</p>
      <Button className="mt-4" size="sm" icon={<RefreshCw size={14} />} onClick={onRetry}>Retry</Button>
    </div>
  );
}

export function LedgersPage({
  client,
  connected,
  snapshotRevision,
}: {
  client: TaskBoardClient;
  connected: boolean;
  snapshotRevision: number;
}) {
  const [findings, setFindings] = useState<RawFindingsLedger | null>(null);
  const [parks, setParks] = useState<RawParksLedger | null>(null);
  const [findingsError, setFindingsError] = useState<string | null>(null);
  const [parksError, setParksError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!connected) {
      setFindingsError('Reconnect the task board to load review findings.');
      setParksError('Reconnect the task board to load park records.');
      return;
    }
    const controller = new AbortController();
    setFindingsError(null);
    setParksError(null);
    void client.getFindingsLedger(undefined, controller.signal).then(setFindings).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setFindingsError(caught instanceof Error ? caught.message : 'Review findings could not be loaded.');
    });
    void client.getParksLedger(controller.signal).then(setParks).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setParksError(caught instanceof Error ? caught.message : 'Park records could not be loaded.');
    });
    return () => controller.abort();
  }, [attempt, client, connected, snapshotRevision]);

  return (
    <>
      <header className="border-b border-line bg-canvas px-4 py-5 sm:px-8 lg:px-12 lg:py-8">
        <h1 data-page-heading tabIndex={-1} className="font-display text-2xl font-light tracking-[0.02em] sm:text-[28px]">Ledgers</h1>
        <p className="mt-1.5 text-sm font-light text-muted">Review patterns, parked work, and durable resolution history.</p>
      </header>
      <main className="w-full max-w-[1600px] space-y-6 p-4 sm:px-8 sm:py-6 lg:px-12 lg:py-8">
        <Card>
          {findingsError !== null ? <LedgerLoadError message={findingsError} onRetry={() => setAttempt((value) => value + 1)} />
            : findings === null ? <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted" role="status"><RefreshCw size={16} className="animate-spin" /> Loading review findings…</div>
              : <FindingsLedgerSection ledger={findings} />}
        </Card>
        <Card>
          {parksError !== null ? <LedgerLoadError message={parksError} onRetry={() => setAttempt((value) => value + 1)} />
            : parks === null ? <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted" role="status"><RefreshCw size={16} className="animate-spin" /> Loading park records…</div>
              : <ParksLedgerSection ledger={parks} />}
        </Card>
      </main>
    </>
  );
}
