import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  CircleHelp,
  Clock3,
  ClipboardCheck,
  Code2,
  FileCode2,
  Fingerprint,
  LockKeyhole,
  RotateCcw,
  Route,
  ShieldCheck,
  TestTube2,
  X,
} from 'lucide-react';
import type { ApprovalItem } from '../data/demo';
import { Avatar, Button, cn, Pill } from './ui';
import { useDialogLayer } from './dialog-stack';
import { formatTaskTimestamp } from '../task-time';

const kindLabels = {
  production: 'Human-only production task',
  scope: 'Scope approval',
  decision: 'Human decision',
};

const checkIcons = {
  tests: TestTube2,
  review: Code2,
  security: ShieldCheck,
  rollback: RotateCcw,
  criteria: ClipboardCheck,
  budget: CircleDollarSign,
  risk: AlertTriangle,
  'option-a': Route,
  'option-b': Route,
};

const confidenceTone = {
  high: 'green' as const,
  medium: 'amber' as const,
  low: 'red' as const,
};

function DataRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 text-[12px]">
      <span className="shrink-0 font-semibold text-muted">{label}</span>
      <span className={cn('min-w-0 break-all text-right font-bold text-ink', mono && 'font-mono text-[11px] font-medium')}>
        {value}
      </span>
    </div>
  );
}

export function ApprovalDrawer({
  approval,
  open,
  onClose,
  onApprove,
  onRequestChanges,
}: {
  approval: ApprovalItem | null;
  open: boolean;
  onClose: () => void;
  onApprove: (approval: ApprovalItem, decisionOptionId?: string) => void;
  onRequestChanges: (approval: ApprovalItem) => void;
}) {
  const [visualViewportTop, setVisualViewportTop] = useState(0);
  const [decisionOptionId, setDecisionOptionId] = useState('');
  const drawerRef = useRef<HTMLElement>(null);
  const { isTopmost } = useDialogLayer({
    open: open && approval !== null,
    onClose,
    containerRef: drawerRef,
  });

  useEffect(() => {
    if (!open || !approval) return;

    const visualViewport = window.visualViewport;
    const syncVisualViewport = () => setVisualViewportTop(Math.max(0, visualViewport?.offsetTop ?? 0));

    syncVisualViewport();
    visualViewport?.addEventListener('resize', syncVisualViewport);
    visualViewport?.addEventListener('scroll', syncVisualViewport);

    return () => {
      visualViewport?.removeEventListener('resize', syncVisualViewport);
      visualViewport?.removeEventListener('scroll', syncVisualViewport);
    };
  }, [approval?.id, open]);

  useEffect(() => {
    if (!open || !approval) return;
    setDecisionOptionId(approval.decision?.optionId ?? '');
  }, [approval?.id, open]);

  if (!open || !approval) return null;

  const release = approval.release;
  const ready = approval.checks.every((check) => check.status !== 'pending');
  const managerReady = approval.kind !== 'production' || Boolean(approval.managerReview);
  const closed = approval.status !== 'pending';
  const decisionReady = approval.kind !== 'decision' || decisionOptionId.length > 0;
  const actionLabel = closed
    ? approval.status === 'deployed'
      ? 'Authorization recorded'
      : approval.status === 'approved'
        ? 'Already approved'
        : 'Changes requested'
    : approval.kind === 'production'
      ? managerReady
        ? 'Review authorization'
        : 'Manager review required'
      : approval.kind === 'scope'
        ? 'Approve scope'
        : 'Record decision';

  return (
    <div
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 bg-ink/45 backdrop-blur-[2px]',
        !isTopmost && 'pointer-events-none',
      )}
      style={{ top: visualViewportTop }}
      role="presentation"
      aria-hidden={isTopmost ? undefined : true}
    >
      <button
        className="absolute inset-0 cursor-default"
        onClick={() => {
          if (isTopmost) onClose();
        }}
        aria-label="Close approval details"
        tabIndex={isTopmost ? 0 : -1}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal={isTopmost ? 'true' : undefined}
        aria-label={`${approval.title} approval details`}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-full max-w-[560px] flex-col overflow-hidden border-l border-line bg-paper shadow-[-24px_0_60px_rgba(23,28,36,.18)]"
      >
        <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-line bg-white px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6 sm:py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="grid size-10 place-items-center rounded-xl text-muted hover:bg-[#eef0f2] hover:text-ink lg:hidden"
            aria-label="Back"
          >
            <ArrowLeft size={19} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold text-muted">
              <span className="font-mono">{approval.id}</span> · {kindLabels[approval.kind]}
            </p>
            <p className="mt-0.5 truncate text-sm font-bold text-ink">Decision evidence</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="hidden size-10 place-items-center rounded-xl text-muted hover:bg-[#eef0f2] hover:text-ink lg:grid"
            aria-label="Close"
          >
            <X size={19} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={approval.kind === 'production' ? 'neutral' : approval.kind === 'scope' ? 'green' : 'amber'}>
              {kindLabels[approval.kind]}
            </Pill>
            <Pill tone={approval.risk === 'high' || approval.risk === 'critical' ? 'red' : 'neutral'} dot>
              {approval.risk} risk
            </Pill>
            <span className="ml-auto font-mono text-[11px] font-medium tabular-nums text-muted">{approval.requestedAt}</span>
          </div>

          <h1 className="mt-4 font-display text-[20px] font-bold leading-[1.2] tracking-[-0.025em] text-ink sm:text-[24px]">
            {approval.title}
          </h1>
          <p className="mt-3 text-[14px] leading-6 text-muted">{approval.summary}</p>

          <div className="mt-5 flex items-center gap-3 rounded-[14px] border border-line bg-white p-3.5">
            <Avatar name={approval.requestedBy} />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-ink">
                {approval.kind === 'production' ? 'Handoff posted' : 'Requested'} by {approval.requestedBy}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-muted">
                {approval.requestedByRole} ·{' '}
                {approval.kind === 'production'
                  ? 'intended role cannot authorize production'
                  : 'waiting for human intent'}
              </p>
            </div>
            <LockKeyhole size={17} className="text-teal-700" />
          </div>

          <section className="mt-3 overflow-hidden rounded-[14px] border border-line bg-white" aria-label="Human task timing">
            <div className="grid grid-cols-3 gap-px bg-[#e4e7ea]">
              <div className="min-w-0 bg-white p-3">
                <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-muted">Opened</p>
                <p className="mt-1 truncate font-mono text-[10px] font-medium tabular-nums text-[#404a54]" title={String(approval.startedAt)}>
                  {formatTaskTimestamp(approval.startedAt)}
                </p>
              </div>
              <div className="min-w-0 bg-white p-3">
                <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-muted">Resolved</p>
                <p className="mt-1 truncate font-mono text-[10px] font-medium tabular-nums text-[#404a54]" title={approval.endedAt ? String(approval.endedAt) : undefined}>
                  {approval.endedAt ? formatTaskTimestamp(approval.endedAt) : 'Awaiting human'}
                </p>
              </div>
              <div className="min-w-0 bg-white p-3">
                <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-muted">Estimate</p>
                <p className="mt-1 flex items-center gap-1 text-[10px] font-bold text-muted">
                  <Clock3 size={11} /> No ETA for people
                </p>
              </div>
            </div>
          </section>

          {release ? (
            <section className="mt-7" aria-labelledby="manager-assessment-title">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 id="manager-assessment-title" className="font-display text-[15px] font-bold text-ink">
                    Manager assessment
                  </h2>
                  <p className="mt-0.5 text-[11px] text-muted">Decision-ready human handoff</p>
                </div>
                {approval.managerReview ? (
                  <Pill tone={confidenceTone[approval.managerReview.confidence]} dot className="capitalize">
                    {approval.managerReview.confidence} confidence
                  </Pill>
                ) : (
                  <Pill tone="amber" dot>
                    Not attached
                  </Pill>
                )}
              </div>

              {approval.managerReview ? (
                <div className="mt-3 overflow-hidden rounded-[14px] border border-[#b9ddd9] bg-white">
                  <div className="bg-[#e8f5f3] p-4">
                    <div className="flex items-start gap-3">
                      <Avatar
                        name={approval.managerReview.manager}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold text-teal-700">
                          {approval.managerReview.manager} reviewed this work to the best of their ability
                        </p>
                        <p className="mt-0.5 text-[10px] font-semibold text-muted">
                          Completed <span className="font-mono tabular-nums">{approval.managerReview.completedAt}</span> · Prototype policy: managers cannot authorize or deploy production
                        </p>
                      </div>
                      <LockKeyhole size={16} className="mt-0.5 shrink-0 text-teal-700" />
                    </div>
                    <p className="mt-3 text-[12px] leading-5 text-[#365f5b]">{approval.managerReview.summary}</p>
                  </div>

                  <div className="grid grid-cols-2 border-y border-[#eef0f2] bg-white">
                    <div className="border-r border-[#eef0f2] px-4 py-3">
                      <p className="font-mono text-xl font-medium tabular-nums text-ink">
                        {approval.managerReview.engineerLoops}
                      </p>
                      <p className="text-[9px] font-bold uppercase tracking-wide text-muted">
                        Engineer loops checked
                      </p>
                    </div>
                    <div className="px-4 py-3">
                      <p className="font-mono text-xl font-medium tabular-nums text-ink">
                        {approval.managerReview.reviewedFiles}
                      </p>
                      <p className="text-[9px] font-bold uppercase tracking-wide text-muted">
                        Files reviewed
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-5 p-4 sm:grid-cols-2">
                    <div>
                      <p className="flex items-center gap-1.5 text-[11px] font-bold text-teal-700">
                        <CheckCircle2 size={14} className="text-teal-700" />
                        Findings
                      </p>
                      {approval.managerReview.findings.length > 0 ? (
                        <ul className="mt-2 space-y-2">
                          {approval.managerReview.findings.map((finding, index) => (
                            <li
                              key={`${index}-${finding}`}
                              className="flex gap-2 text-[11px] leading-4 text-muted"
                            >
                              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-teal-500" />
                              <span>{finding}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-[11px] leading-4 text-muted">No findings recorded.</p>
                      )}
                    </div>

                    <div>
                      <p className="flex items-center gap-1.5 text-[11px] font-bold text-caution">
                        <AlertTriangle size={14} className="text-caution" />
                        Residual risks
                      </p>
                      {approval.managerReview.openRisks.length > 0 ? (
                        <ul className="mt-2 space-y-2">
                          {approval.managerReview.openRisks.map((risk, index) => (
                            <li
                              key={`${index}-${risk}`}
                              className="flex gap-2 text-[11px] leading-4 text-[#665a42]"
                            >
                              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-caution-fill" />
                              <span>{risk}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-[11px] leading-4 text-muted">No residual risks recorded.</p>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-3 rounded-[14px] border border-[#f0d391] bg-[#fff6df] p-4 text-[11px] leading-5 text-caution">
                  No manager assessment is attached. Request one before making the human-only production decision.
                </div>
              )}
            </section>
          ) : null}

          {release ? (
            <section className="mt-7">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-[15px] font-bold text-ink">Exact release candidate</h2>
                <Pill tone="green" dot>
                  Demo evidence
                </Pill>
              </div>
              <div className="mt-3 rounded-[14px] border border-line bg-white px-4 py-1">
                <DataRow label="Target" value={approval.target ?? 'Production'} />
                <div className="border-t border-[#eef0f2]" />
                <DataRow label="Commit" value={release.commit} mono />
                <div className="border-t border-[#eef0f2]" />
                <DataRow label="Build" value={release.buildDigest} mono />
                <div className="border-t border-[#eef0f2]" />
                <DataRow label="Artifact" value={release.artifactDigest} mono />
                <div className="border-t border-[#eef0f2]" />
                <DataRow label="Tests" value={release.testsDigest} mono />
                <div className="border-t border-[#eef0f2]" />
                <DataRow label="Config" value={release.configDigest} mono />
                <div className="border-t border-[#eef0f2]" />
                <DataRow label="Migrations" value={release.migrationsDigest} mono />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <div className="rounded-xl border border-line bg-white p-3 text-center">
                  <FileCode2 size={16} className="mx-auto text-teal-700" />
                  <p className="mt-1.5 font-mono text-lg font-medium tabular-nums text-ink">{release.changedFiles}</p>
                  <p className="text-[9px] font-bold uppercase tracking-wide text-muted">Files</p>
                </div>
                <div className="rounded-xl border border-line bg-white p-3 text-center">
                  <span className="font-mono text-sm font-medium tabular-nums text-teal-700">+{release.additions}</span>
                  <p className="mt-2 font-mono text-lg font-medium tabular-nums text-ink">−{release.deletions}</p>
                  <p className="text-[9px] font-bold uppercase tracking-wide text-muted">Diff</p>
                </div>
                <div className="rounded-xl border border-line bg-white p-3 text-center">
                  <CircleDollarSign size={16} className="mx-auto text-teal-700" />
                  <p className="mt-1.5 font-mono text-lg font-medium tabular-nums text-ink">${release.cost.toFixed(2)}</p>
                  <p className="text-[9px] font-bold uppercase tracking-wide text-muted">Agent cost</p>
                </div>
              </div>
            </section>
          ) : (
            <section className="mt-7">
              <h2 className="font-display text-[15px] font-bold text-ink">Authorized development envelope</h2>
              <div className="mt-3 rounded-[14px] border border-line bg-white px-4 py-1">
                <DataRow label="Mission" value={approval.workItemId} mono />
                <div className="border-t border-[#eef0f2]" />
                <DataRow label="Branch" value={approval.branch ?? 'Created after approval'} mono />
                {approval.budget ? (
                  <>
                    <div className="border-t border-[#eef0f2]" />
                    <DataRow label="Budget" value={approval.budget} />
                  </>
                ) : null}
              </div>
            </section>
          )}

          <section className="mt-7">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-[15px] font-bold text-ink">
                {release ? 'Required evidence' : 'Review packet'}
              </h2>
              <span className="font-mono text-[11px] font-medium tabular-nums text-teal-700">
                {approval.checks.filter((check) => check.status === 'passed').length}/{approval.checks.length} passed
              </span>
            </div>
            <div
              className="mt-3 overflow-hidden rounded-[14px] border border-line bg-white"
              role={approval.kind === 'decision' ? 'radiogroup' : undefined}
              aria-label={approval.kind === 'decision' ? 'Retry behavior' : undefined}
            >
              {approval.checks.map((check, index) => {
                const Icon = checkIcons[check.id as keyof typeof checkIcons] ?? Check;
                const selected = decisionOptionId === check.id;
                const content = (
                  <>
                    {approval.kind === 'decision' ? (
                      <input
                        type="radio"
                        name={`decision-${approval.id}`}
                        value={check.id}
                        checked={selected}
                        onChange={() => setDecisionOptionId(check.id)}
                        disabled={closed}
                        className="size-4 shrink-0 accent-[#237a72]"
                      />
                    ) : null}
                    <span
                      className={cn(
                        'grid size-8 shrink-0 place-items-center rounded-lg',
                        check.status === 'passed'
                          ? 'bg-[#e8f5f3] text-teal-700'
                          : selected
                            ? 'bg-[#e8f5f3] text-teal-700'
                            : 'bg-[#fff6df] text-caution',
                      )}
                    >
                      <Icon size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-bold text-ink">{check.label}</span>
                      <span className="mt-0.5 block text-[11px] text-muted">{check.detail}</span>
                    </span>
                    {approval.kind === 'decision' ? (
                      <Pill tone={selected ? 'green' : 'neutral'}>
                        {selected ? (closed ? 'Recorded choice' : 'Selected') : 'Choose'}
                      </Pill>
                    ) : check.status === 'passed' ? (
                      <CheckCircle2 size={17} className="text-teal-700" />
                    ) : (
                      <ChevronRight size={16} className="text-caution" />
                    )}
                  </>
                );

                return approval.kind === 'decision' ? (
                  <label
                    key={check.id}
                    className={cn(
                      'flex min-h-16 items-center gap-3 px-4 py-3.5 transition-colors',
                      index > 0 && 'border-t border-[#eef0f2]',
                      !closed && 'cursor-pointer hover:bg-paper',
                      selected && 'bg-[#e8f5f3]',
                    )}
                  >
                    {content}
                  </label>
                ) : (
                  <div
                    key={check.id}
                    className={cn(
                      'flex items-center gap-3 px-4 py-3.5',
                      index > 0 && 'border-t border-[#eef0f2]',
                    )}
                  >
                    {content}
                  </div>
                );
              })}
            </div>
            {approval.kind === 'decision' && !closed ? (
              <p className="mt-2 text-[10px] font-semibold text-muted">
                Choose one behavior before recording the decision. Steward will persist the exact choice in this browser's event history.
              </p>
            ) : null}
          </section>

          {release ? (
            <>
              <section className="mt-7 rounded-[14px] border border-[#b9ddd9] bg-[#e8f5f3] p-4">
                <div className="flex items-start gap-3">
                  <TrendingCost release={release} />
                </div>
              </section>
              <section className="mt-4 rounded-[14px] border border-line bg-white p-4">
                <div className="flex items-start gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#eef0f2] text-muted">
                    <RotateCcw size={15} />
                  </span>
                  <div>
                    <p className="text-xs font-bold text-ink">Rollback plan</p>
                    <p className="mt-1 text-[11px] leading-5 text-muted">{release.rollback}</p>
                  </div>
                </div>
              </section>
            </>
          ) : null}

          <section className="mt-5 flex items-start gap-3 rounded-[14px] border border-[#f0d391] bg-[#fff6df] p-4">
            {approval.kind === 'production' ? (
              <Fingerprint size={18} className="mt-0.5 shrink-0 text-caution" />
            ) : (
              <CircleHelp size={18} className="mt-0.5 shrink-0 text-caution" />
            )}
            <div>
              <p className="text-xs font-bold text-caution">
                {approval.kind === 'production' ? 'Browser-local release authorization' : 'Agents are waiting for your intent'}
              </p>
              <p className="mt-1 text-[11px] leading-5 text-caution">
                {approval.kind === 'production'
                  ? 'The demo records one use for this exact manifest. Resetting browser data resets this simulated policy state.'
                  : 'After approval, the role team can work without per-command interruptions inside development.'}
              </p>
            </div>
          </section>
        </div>

        <footer className="shrink-0 border-t border-line bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:px-6 sm:pb-4">
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" disabled={closed} onClick={() => onRequestChanges(approval)}>
              Request changes
            </Button>
            <Button
              variant="primary"
              className="whitespace-nowrap px-2 text-[13px] sm:px-4 sm:text-sm"
              disabled={!ready || !managerReady || !decisionReady || closed}
              onClick={() => onApprove(approval, decisionOptionId || undefined)}
              icon={approval.kind === 'production' ? <LockKeyhole size={16} /> : <ClipboardCheck size={16} />}
            >
              {actionLabel}
            </Button>
          </div>
          <p className="mt-2.5 text-center text-[10px] font-semibold text-muted">
            Decision is attributed to Jordan Lee in this browser-local event history.
          </p>
        </footer>
      </aside>
    </div>
  );
}

function TrendingCost({ release }: { release: NonNullable<ApprovalItem['release']> }) {
  const savings = Math.round((1 - release.cost / release.baselineCost) * 100);
  return (
    <>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-teal-500 text-ink">
        <CircleDollarSign size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-bold text-teal-700">Cheap-first route saved <span className="font-mono tabular-nums">{savings}%</span></p>
          <Pill tone="green"><span className="font-mono tabular-nums">${release.cost.toFixed(2)}</span> routed</Pill>
        </div>
        <p className="mt-1 text-[11px] leading-5 text-[#365f5b]">
          Frontier-only estimate: <span className="font-mono tabular-nums">${release.baselineCost.toFixed(2)}</span>. Verification passed without a Fable or Sol escalation.
        </p>
      </div>
    </>
  );
}
