import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  CirclePause,
  ClipboardCheck,
  Clock3,
  LogOut,
  Plus,
  Radio,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  WifiOff,
} from 'lucide-react';
import type {
  AgentTaskProjection,
  HumanCommandEnvelope,
  HumanCommandReceipt,
  IsoTimestamp,
  ProgressEvent,
  RegisteredAgentProjection,
  UiSnapshot,
  WorkspaceId,
} from '#shared/protocol';
import {
  createHttpControlPlaneGateway,
  WorkspaceClient,
  type ControlPlaneGateway,
  type WorkspaceConnectionMode,
  type WorkspaceConnectionState,
} from '../control-plane';
import {
  buildInterruptCommand,
  buildQueueWorkCommand,
  buildResumeAgentCommand,
  buildWorkspacePauseCommand,
  createClientCommandId,
  expectedCompletionForAgentTime,
  mapSnapshotToAgents,
  type AgentOperatorView,
} from './model';
import {
  RuntimeActivityMonitor,
  createActivityTrackingFetch,
  observeGatewayBootstrap,
  runtimeFreshnessIssue,
  submitWithReplicaInvalidation,
} from './runtime-safety';
import {
  createHttpImpactSummaryGateway,
  type ImpactSummaryGateway,
  type LiveImpactSnapshot,
} from './impact-client';
import {
  createHttpProductionCheckGateway,
  type LiveProductionCheck,
  type ProductionCheckGateway,
} from './production-check-client';

const exactTime = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

const AGENT_MINUTE_OPTIONS = [15, 30, 45, 60, 90, 120, 180, 240] as const;

function formatExact(value: IsoTimestamp): string {
  return exactTime.format(new Date(value));
}

function ExactTimestamp({ value, empty = 'Not recorded' }: { value: IsoTimestamp | null; empty?: string }) {
  if (value === null) return <span className="text-muted">{empty}</span>;
  return (
    <time className="font-mono text-[12px] text-ink" dateTime={value} title={value}>
      {formatExact(value)}
    </time>
  );
}

function panelClassName(extra = ''): string {
  return `rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgba(23,28,36,0.04)] ${extra}`;
}

function humanize(value: string): string {
  return value.replaceAll('_', ' ');
}

function modePresentation(mode: WorkspaceConnectionMode): {
  label: string;
  detail: string;
  className: string;
  icon: ReactNode;
} {
  switch (mode) {
    case 'live':
      return {
        label: 'Live',
        detail: 'Commands enabled',
        className: 'border-teal-500/35 bg-teal-soft text-teal-700',
        icon: <Radio aria-hidden="true" className="h-3.5 w-3.5" />,
      };
    case 'connecting':
      return {
        label: 'Connecting',
        detail: 'Read only',
        className: 'border-caution-fill/40 bg-caution-soft text-caution',
        icon: <Activity aria-hidden="true" className="h-3.5 w-3.5" />,
      };
    case 'authentication_required':
      return {
        label: 'Sign-in required',
        detail: 'Read only',
        className: 'border-urgent/25 bg-urgent-soft text-urgent',
        icon: <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />,
      };
    case 'upgrade_required':
      return {
        label: 'Update required',
        detail: 'Read only',
        className: 'border-urgent/25 bg-urgent-soft text-urgent',
        icon: <WifiOff aria-hidden="true" className="h-3.5 w-3.5" />,
      };
    case 'stale':
      return {
        label: 'Reconnecting',
        detail: 'Read only',
        className: 'border-caution-fill/40 bg-caution-soft text-caution',
        icon: <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />,
      };
    case 'idle':
    case 'stopped':
      return {
        label: 'Disconnected',
        detail: 'Read only',
        className: 'border-line bg-canvas text-muted',
        icon: <WifiOff aria-hidden="true" className="h-3.5 w-3.5" />,
      };
  }
}

function ConnectionBadge({ mode }: { mode: WorkspaceConnectionMode }) {
  const presentation = modePresentation(mode);
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold uppercase tracking-[0.12em] ${presentation.className}`}
    >
      {presentation.icon}
      <span>{presentation.label}</span>
      <span aria-hidden="true" className="opacity-45">·</span>
      <span className="font-medium normal-case tracking-normal opacity-75">
        {presentation.detail}
      </span>
    </div>
  );
}

function connectionClassName(state: RegisteredAgentProjection['connectionState']): string {
  switch (state) {
    case 'online':
      return 'bg-teal-soft text-teal-700';
    case 'stale':
      return 'bg-caution-soft text-caution';
    case 'offline':
      return 'bg-canvas text-muted';
  }
}

function taskClassName(status: AgentTaskProjection['status']): string {
  switch (status) {
    case 'running':
      return 'bg-teal-soft text-teal-700';
    case 'completed':
      return 'bg-ink-panel text-white';
    case 'paused':
      return 'bg-caution-soft text-caution';
    case 'failed':
      return 'bg-urgent-soft text-urgent';
    case 'queued':
      return 'bg-canvas text-muted';
  }
}

function TaskCard({ task }: { task: AgentTaskProjection }) {
  return (
    <article className="rounded-xl border border-line-soft bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-bold text-ink">{task.title}</h4>
          <p className="mt-1 text-sm leading-5 text-muted">{task.objective}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${taskClassName(task.status)}`}
        >
          {task.status}
        </span>
      </div>
      {task.subject.type === 'manager_review' ? (
        <div className="mt-3 rounded-lg border border-caution-fill/30 bg-caution-soft/45 p-3 text-xs">
          <p className="font-bold uppercase tracking-[0.1em] text-caution">
            Manager review assignment · read only
          </p>
          <dl className="mt-2 grid gap-1 font-mono text-[11px] text-ink">
            <div><dt className="inline text-muted">Source task </dt><dd className="inline break-all">{task.subject.sourceTaskId}</dd></div>
            <div><dt className="inline text-muted">Evidence </dt><dd className="inline break-all">{task.subject.evidenceId}</dd></div>
            <div><dt className="inline text-muted">Digest </dt><dd className="inline break-all">{task.subject.evidenceDigest}</dd></div>
          </dl>
        </div>
      ) : null}
      <dl className="mt-4 grid gap-2 border-t border-line-soft pt-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted">Started</dt>
          <dd className="mt-0.5"><ExactTimestamp value={task.startedAt} empty="Not started" /></dd>
        </div>
        <div>
          <dt className="text-muted">Ended</dt>
          <dd className="mt-0.5"><ExactTimestamp value={task.endedAt} empty="Not ended" /></dd>
        </div>
        <div>
          <dt className="text-muted">Agent-only estimate</dt>
          <dd className="mt-0.5 font-mono text-[12px] text-ink">
            {task.expectedAgentMinutes} minutes
          </dd>
        </div>
        <div>
          <dt className="text-muted">Expected by · 15-minute boundary</dt>
          <dd className="mt-0.5"><ExactTimestamp value={task.expectedCompletedAt} /></dd>
        </div>
      </dl>
    </article>
  );
}

function TaskGroup({
  title,
  tasks,
  empty,
}: {
  title: string;
  tasks: readonly AgentTaskProjection[];
  empty: string;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">{title}</h4>
        <span className="font-mono text-xs text-muted">{tasks.length}</span>
      </div>
      {tasks.length > 0 ? (
        <div className="space-y-2">
          {tasks.map((task) => <TaskCard key={task.taskId} task={task} />)}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted">
          {empty}
        </p>
      )}
    </section>
  );
}

function AgentCard({
  view,
  controlsAvailable,
  workspacePaused,
  onQueue,
  onInterrupt,
  onResume,
}: {
  view: AgentOperatorView;
  controlsAvailable: boolean;
  workspacePaused: boolean;
  onQueue: (agent: RegisteredAgentProjection) => void;
  onInterrupt: (agent: RegisteredAgentProjection) => void;
  onResume: (agent: RegisteredAgentProjection) => void;
}) {
  const { agent, tasks } = view;
  const canResume = agent.controlState === 'paused' || agent.controlState === 'held';
  const actionTask = agent.currentAction
    ? [...tasks.running, ...tasks.attention, ...tasks.queued].find(
        (task) => task.taskId === agent.currentAction?.taskId,
      )
    : undefined;

  return (
    <article className={panelClassName('overflow-hidden')}>
      <header className="border-b border-line p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xl font-extrabold tracking-[-0.02em] text-ink">
                {agent.displayName}
              </h3>
              <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${connectionClassName(agent.connectionState)}`}>
                {agent.connectionState}
              </span>
            </div>
            <p className="mt-1 text-sm capitalize text-muted">
              {agent.role} · {agent.provider.name} / {agent.provider.model}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canResume ? (
              <button
                className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-teal-500/25 bg-teal-soft px-3 text-sm font-bold text-teal-700 transition hover:border-teal-500 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!controlsAvailable || workspacePaused}
                onClick={() => onResume(agent)}
                title={workspacePaused ? 'Resume the workspace before resuming one agent.' : undefined}
                type="button"
              >
                <RotateCcw aria-hidden="true" className="h-4 w-4" />
                Resume
              </button>
            ) : null}
            {agent.role === 'engineer' ? (
              <button
                className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm font-bold text-ink transition hover:border-teal-500 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!controlsAvailable}
                onClick={() => onQueue(agent)}
                type="button"
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                Queue
              </button>
            ) : null}
            <button
              className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-urgent/20 bg-urgent-soft px-3 text-sm font-bold text-urgent transition hover:border-urgent/45 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!controlsAvailable}
              onClick={() => onInterrupt(agent)}
              type="button"
            >
              <Square aria-hidden="true" className="h-3.5 w-3.5 fill-current" />
              Interrupt
            </button>
          </div>
        </div>

        <dl className="mt-5 grid gap-3 rounded-xl bg-canvas p-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted">Control state</dt>
            <dd className="mt-1 font-bold capitalize text-ink">{humanize(agent.controlState)}</dd>
          </div>
          <div>
            <dt className="text-muted">Control version</dt>
            <dd className="mt-1 font-mono text-ink">{agent.controlVersion}</dd>
          </div>
          <div>
            <dt className="text-muted">Last seen</dt>
            <dd className="mt-1"><ExactTimestamp value={agent.lastSeenAt} /></dd>
          </div>
          <div>
            <dt className="text-muted">Lease expires</dt>
            <dd className="mt-1"><ExactTimestamp value={agent.leaseExpiresAt} /></dd>
          </div>
        </dl>

        <div className="mt-4 rounded-xl border border-teal-500/20 bg-teal-soft/65 p-4">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-teal-700">
            Current action
          </p>
          {agent.currentAction ? (
            <div className="mt-2">
              <p className="font-bold text-ink">{agent.currentAction.summary}</p>
              <p className="mt-1 text-xs text-muted">
                {actionTask?.title ?? String(agent.currentAction.taskId)} · since{' '}
                <ExactTimestamp value={agent.currentAction.startedAt} />
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">No action reported by this runtime.</p>
          )}
        </div>
      </header>

      <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-2">
        <TaskGroup title="Running" tasks={tasks.running} empty="No task is running." />
        <TaskGroup title="Queued" tasks={tasks.queued} empty="The queue is empty." />
        <TaskGroup title="Completed" tasks={tasks.completed} empty="No completed tasks yet." />
        <TaskGroup title="Paused or failed" tasks={tasks.attention} empty="Nothing needs attention." />
      </div>
    </article>
  );
}

function phaseClassName(event: ProgressEvent): string {
  if (event.phase === 'test' && event.outcome === 'failed') return 'bg-urgent-soft text-urgent';
  if (event.phase === 'test' && event.outcome === 'passed') return 'bg-teal-soft text-teal-700';
  if (event.phase === 'execute') return 'bg-ink-panel text-white';
  return 'bg-canvas text-muted';
}

function Journal({ snapshot }: { snapshot: UiSnapshot }) {
  const entries = useMemo(
    () => [...snapshot.progress].sort(
      (left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt),
    ),
    [snapshot.progress],
  );
  const tasks = useMemo(
    () => new Map(snapshot.tasks.map((task) => [task.taskId, task])),
    [snapshot.tasks],
  );
  const agents = useMemo(
    () => new Map(snapshot.agents.map((agent) => [agent.agentId, agent])),
    [snapshot.agents],
  );

  return (
    <section className={panelClassName('p-5 sm:p-6')}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-teal-700">RPET journal</p>
          <h2 className="mt-1 text-xl font-extrabold tracking-[-0.02em] text-ink">
            Research → plan → execute → test
          </h2>
          <p className="mt-1 text-sm text-muted">
            Runtime-authored progress, newest first. Failed tests begin another loop.
          </p>
        </div>
        <span className="rounded-full bg-canvas px-3 py-1 font-mono text-xs text-muted">
          {entries.length}
        </span>
      </div>

      {entries.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-line p-5 text-sm text-muted">
          No progress has been recorded yet.
        </p>
      ) : (
        <ol className="mt-6 space-y-3">
          {entries.map((event, index) => {
            const task = tasks.get(event.taskId);
            const agent = task ? agents.get(task.agentId) : undefined;
            const phase = event.phase === 'test'
              ? `test · ${event.outcome}`
              : event.phase;
            return (
              <li key={`${event.taskId}-${event.iteration}-${event.phase}-${event.occurredAt}-${index}`} className="relative rounded-xl border border-line-soft p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${phaseClassName(event)}`}>
                    {phase}
                  </span>
                  <span className="font-mono text-xs text-muted">Loop {event.iteration}</span>
                  <span className="text-xs text-muted">·</span>
                  <span className="text-xs font-bold text-ink">{agent?.displayName ?? 'Unknown agent'}</span>
                </div>
                <p className="mt-2 text-sm font-bold text-ink">{task?.title ?? String(event.taskId)}</p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted">{event.journal}</p>
                <p className="mt-3"><ExactTimestamp value={event.occurredAt} /></p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

interface RuntimeSession {
  readonly origin: string;
  readonly workspaceId: string;
  readonly gateway: ControlPlaneGateway;
  readonly activity: RuntimeActivityMonitor;
  readonly impactGateway?: ImpactSummaryGateway;
  readonly impactOrigin?: string;
  readonly productionCheckGateway?: ProductionCheckGateway;
  readonly productionCheckOrigin?: string;
}

interface ImpactOverviewState {
  readonly snapshot: LiveImpactSnapshot | null;
  readonly loading: boolean;
  readonly issue: string | null;
}

function ImpactOverview({
  configured,
  impactOrigin,
  state,
  runtimeSnapshot,
}: {
  configured: boolean;
  impactOrigin?: string;
  state: ImpactOverviewState;
  runtimeSnapshot: UiSnapshot | undefined;
}) {
  const allSummaries = state.snapshot?.summaries ?? [];
  const summaries = [...allSummaries]
    .sort((left, right) => right.sourceSequence - left.sourceSequence)
    .slice(0, 24);
  const caughtUp = state.snapshot !== null && runtimeSnapshot !== undefined
    ? state.snapshot.sourceSequence >= runtimeSnapshot.sequence
    : false;

  return (
    <section className={panelClassName('mt-6 p-5 sm:p-6')} aria-label="User impact overview">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-teal-soft p-2.5 text-teal-700">
            <Sparkles aria-hidden="true" className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-teal-700">
              Low-cost observer · read only
            </p>
            <h2 className="mt-1 text-lg font-extrabold text-ink">What this work changes for users</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">
              A separate weak model turns bounded, redacted task evidence into outcome-focused updates. It cannot command agents or approve production.
            </p>
          </div>
        </div>
        {state.snapshot ? (
          <div className={`rounded-full px-3 py-1.5 text-xs font-bold ${caughtUp ? 'bg-teal-soft text-teal-700' : 'bg-caution-soft text-caution'}`}>
            {caughtUp ? `Current through event #${state.snapshot.sourceSequence}` : `Catching up from event #${state.snapshot.sourceSequence}`}
          </div>
        ) : null}
      </div>

      {!configured ? (
        <div className="mt-5 rounded-xl border border-dashed border-line px-4 py-4 text-sm leading-6 text-muted">
          No impact observer is connected. Reconnect with its separate read-only origin and output token to show summaries here.
        </div>
      ) : state.loading && state.snapshot === null ? (
        <div className="mt-5 flex items-center gap-2 rounded-xl bg-canvas px-4 py-4 text-sm text-muted" role="status">
          <Activity aria-hidden="true" className="h-4 w-4 animate-pulse text-teal-700" />
          Loading the latest safe summary…
        </div>
      ) : summaries.length === 0 ? (
        <div className="mt-5 rounded-xl border border-dashed border-line px-4 py-4 text-sm leading-6 text-muted">
          The observer is connected but has not published a task summary yet.
        </div>
      ) : (
        <div className="mt-5 grid gap-3 lg:grid-cols-2">
          {summaries.map((summary) => {
            const task = runtimeSnapshot?.tasks.find((candidate) => String(candidate.taskId) === summary.taskId);
            return (
              <article className="rounded-xl border border-line-soft bg-white p-4" key={summary.taskId}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">{humanize(summary.status)}</p>
                    <h3 className="mt-1 text-sm font-extrabold text-ink">{task?.title ?? summary.taskId}</h3>
                  </div>
                  <span className="font-mono text-[11px] text-muted">event #{summary.sourceSequence}</span>
                </div>
                <p className="mt-3 text-sm leading-6 text-ink">{summary.summary}</p>
                <p className="mt-3 border-t border-line-soft pt-3 text-xs text-muted">
                  Updated <time dateTime={summary.updatedAt}>{formatExact(summary.updatedAt as IsoTimestamp)}</time>
                </p>
              </article>
            );
          })}
        </div>
      )}

      {allSummaries.length > summaries.length ? (
        <p className="mt-3 text-xs text-muted">
          Showing the 24 most recently evidenced outcomes. {allSummaries.length - summaries.length} older summaries remain in the observer.
        </p>
      ) : null}

      {state.issue ? (
        <p className="mt-4 rounded-lg border border-caution-fill/35 bg-caution-soft px-3 py-2 text-xs leading-5 text-caution" role="status">
          {state.issue} {state.snapshot ? 'The last valid summary remains visible.' : 'No summary is being shown.'}
        </p>
      ) : null}
      {impactOrigin ? <p className="mt-3 font-mono text-[11px] text-muted">{impactOrigin}</p> : null}
    </section>
  );
}

interface ProductionCheckOverviewState {
  readonly checks: readonly LiveProductionCheck[] | null;
  readonly loading: boolean;
  readonly issue: string | null;
  readonly refreshedAt: IsoTimestamp | null;
}

function shortDigest(value: string): string {
  return `sha256:${value.slice(7, 15)}…${value.slice(-6)}`;
}

function shortIdentifier(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 10)}…${value.slice(-7)}`;
}

function ProductionCheckOverview({
  configured,
  managerReviewOrigin,
  runtimeSnapshot,
  state,
}: {
  configured: boolean;
  managerReviewOrigin?: string;
  runtimeSnapshot: UiSnapshot | undefined;
  state: ProductionCheckOverviewState;
}) {
  const allChecks = state.checks ?? [];
  const checks = [...allChecks]
    .sort((left, right) => Date.parse(right.reviewedAt) - Date.parse(left.reviewedAt))
    .slice(0, 24);

  return (
    <section className={panelClassName('mt-6 p-5 sm:p-6')} aria-label="Human production checks">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-caution-soft p-2.5 text-caution">
            <ClipboardCheck aria-hidden="true" className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-caution">
              Human gate · read only
            </p>
            <h2 className="mt-1 text-lg font-extrabold text-ink">Production decisions waiting for a person</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">
              Managers can prepare evidence for this queue. This view cannot approve a release or deploy anything.
            </p>
          </div>
        </div>
        <span className="rounded-full border border-caution-fill/35 bg-caution-soft px-3 py-1.5 text-xs font-bold text-caution">
          Awaiting human production decision — not deployed
        </span>
      </div>

      {!configured ? (
        <div className="mt-5 rounded-xl border border-dashed border-line px-4 py-4 text-sm leading-6 text-muted">
          No manager-review queue is connected. Reconnect with its separate read-only origin and token to show production checks here.
        </div>
      ) : state.loading && state.checks === null ? (
        <div className="mt-5 flex items-center gap-2 rounded-xl bg-canvas px-4 py-4 text-sm text-muted" role="status">
          <Activity aria-hidden="true" className="h-4 w-4 animate-pulse text-caution" />
          Loading the human production-check queue…
        </div>
      ) : state.checks === null ? (
        <div className="mt-5 rounded-xl border border-dashed border-line px-4 py-4 text-sm leading-6 text-muted">
          No verified production-check list is available.
        </div>
      ) : checks.length === 0 ? (
        <div className="mt-5 rounded-xl border border-dashed border-line px-4 py-4 text-sm leading-6 text-muted">
          No manager-accepted work is awaiting a human production decision.
        </div>
      ) : (
        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          {checks.map((check) => {
            const task = runtimeSnapshot?.tasks.find((candidate) => String(candidate.taskId) === check.taskId);
            return (
              <article className="rounded-xl border border-caution-fill/30 bg-white p-4 sm:p-5" key={check.productionCheckId}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-caution">
                      Awaiting human production decision
                    </p>
                    <h3 className="mt-1 text-base font-extrabold text-ink">{task?.title ?? check.taskId}</h3>
                    <p className="mt-1 font-mono text-[11px] text-muted">{check.taskId}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em] ${check.status === 'pending_human_review' ? 'bg-caution-soft text-caution' : 'bg-canvas text-muted'}`}>
                    {check.status === 'pending_human_review' ? 'Ready for a person' : 'Handoff syncing'}
                  </span>
                </div>

                <div className="mt-4 grid gap-3">
                  <div className="rounded-lg bg-teal-soft/55 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-teal-700">Result overview</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink">{check.resultOverview}</p>
                  </div>
                  <div className="rounded-lg border border-line-soft p-3">
                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Manager review</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink">{check.reviewSummary}</p>
                  </div>
                  <div className="rounded-lg border border-caution-fill/30 bg-caution-soft/55 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-caution">Remaining risks</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink">{check.remainingRisks}</p>
                  </div>
                </div>

                <dl className="mt-4 grid gap-3 border-t border-line-soft pt-4 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-muted">Engineer completed</dt>
                    <dd className="mt-1"><ExactTimestamp value={check.completedAt as IsoTimestamp} /></dd>
                  </div>
                  <div>
                    <dt className="text-muted">Manager reviewed</dt>
                    <dd className="mt-1"><ExactTimestamp value={check.reviewedAt as IsoTimestamp} /></dd>
                  </div>
                  <div>
                    <dt className="text-muted">Target</dt>
                    <dd className="mt-1 font-mono text-[12px] text-ink">{check.targetEnvironment}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Manager runtime</dt>
                    <dd className="mt-1 break-all font-mono text-[11px] text-ink">
                      {check.managerRuntimeInstanceId} · epoch {check.managerRuntimeEpoch}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Review authority · read only</dt>
                    <dd className="mt-1 grid gap-1 break-all font-mono text-[11px] text-ink">
                      <span title={check.reviewTaskId}>Task {check.reviewTaskId}</span>
                      <span title={check.permitId}>
                        Permit {shortIdentifier(check.permitId)} · sequence #{check.permitWorkspaceSequence}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Release bindings</dt>
                    <dd className="mt-1 grid gap-1 font-mono text-[11px] text-ink">
                      <span title={check.releaseArtifactDigest}>Artifact {shortDigest(check.releaseArtifactDigest)}</span>
                      <span title={check.releaseManifestDigest}>Manifest {shortDigest(check.releaseManifestDigest)}</span>
                    </dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>
      )}

      {allChecks.length > checks.length ? (
        <p className="mt-3 text-xs text-muted">
          Showing the 24 most recently reviewed checks. {allChecks.length - checks.length} older checks remain in manager review.
        </p>
      ) : null}
      {state.issue ? (
        <p className="mt-4 rounded-lg border border-caution-fill/35 bg-caution-soft px-3 py-2 text-xs leading-5 text-caution" role="status">
          {state.issue} {state.checks !== null
            ? 'The last valid production-check list remains visible and may be stale.'
            : 'No production checks are being shown.'}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
        {state.refreshedAt ? <span>Last valid refresh <ExactTimestamp value={state.refreshedAt} /></span> : null}
        {managerReviewOrigin ? <span>{managerReviewOrigin}</span> : null}
      </div>
    </section>
  );
}

function receiptMessage(receipt: HumanCommandReceipt): { tone: 'success' | 'error'; text: string } {
  if (receipt.state === 'rejected') {
    return { tone: 'error', text: `${receipt.code}: ${receipt.reason}` };
  }
  return {
    tone: 'success',
    text: receipt.state === 'duplicate'
      ? 'The original command was already accepted. No duplicate work was created.'
      : 'Command accepted by the durable control plane.',
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The command could not be submitted.';
}

function ConnectedWorkspace({
  session,
  onDisconnect,
}: {
  session: RuntimeSession;
  onDisconnect: () => void;
}) {
  const [connection, setConnection] = useState<WorkspaceConnectionState>({ mode: 'idle' });
  const [queueAgentId, setQueueAgentId] = useState('');
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [minutes, setMinutes] = useState<number>(30);
  const [interruptAgent, setInterruptAgent] = useState<RegisteredAgentProjection | null>(null);
  const [interruptReason, setInterruptReason] = useState('');
  const [workspaceReason, setWorkspaceReason] = useState('');
  const [pending, setPending] = useState<HumanCommandEnvelope | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [safetyIssue, setSafetyIssue] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [impact, setImpact] = useState<ImpactOverviewState>({
    snapshot: null,
    loading: session.impactGateway !== undefined,
    issue: null,
  });
  const [productionChecks, setProductionChecks] = useState<ProductionCheckOverviewState>({
    checks: null,
    loading: session.productionCheckGateway !== undefined,
    issue: null,
    refreshedAt: null,
  });
  const submittingRef = useRef(false);
  const reconcilingRef = useRef(false);
  const queuePanelRef = useRef<HTMLDivElement>(null);

  const client = useMemo(
    () => new WorkspaceClient({ gateway: session.gateway, onChange: setConnection }),
    [session.gateway],
  );

  useEffect(
    () => session.activity.subscribe((activity) => {
      if (activity.kind !== 'bootstrap') return;
      reconcilingRef.current = false;
      setSafetyIssue(null);
    }),
    [session.activity],
  );

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  useEffect(() => {
    const gateway = session.impactGateway;
    if (!gateway) {
      setImpact({ snapshot: null, loading: false, issue: null });
      return;
    }
    const controller = new AbortController();
    let stopped = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async () => {
      setImpact((current) => ({ ...current, loading: current.snapshot === null }));
      try {
        const next = await gateway.fetchSnapshot(controller.signal);
        if (!stopped) setImpact({ snapshot: next, loading: false, issue: null });
      } catch (error) {
        if (!stopped && !controller.signal.aborted) {
          setImpact((current) => ({
            ...current,
            loading: false,
            issue: errorMessage(error),
          }));
        }
      } finally {
        if (!stopped) refreshTimer = setTimeout(() => void refresh(), 10_000);
      }
    };
    void refresh();
    return () => {
      stopped = true;
      controller.abort();
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    };
  }, [session.impactGateway]);

  useEffect(() => {
    const gateway = session.productionCheckGateway;
    if (!gateway) {
      setProductionChecks({ checks: null, loading: false, issue: null, refreshedAt: null });
      return;
    }
    const controller = new AbortController();
    let stopped = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async () => {
      setProductionChecks((current) => ({ ...current, loading: current.checks === null }));
      try {
        const checks = await gateway.fetchChecks(controller.signal);
        if (!stopped) {
          setProductionChecks({
            checks,
            loading: false,
            issue: null,
            refreshedAt: new Date().toISOString() as IsoTimestamp,
          });
        }
      } catch (error) {
        if (!stopped && !controller.signal.aborted) {
          setProductionChecks((current) => ({
            ...current,
            loading: false,
            issue: errorMessage(error),
          }));
        }
      } finally {
        if (!stopped) refreshTimer = setTimeout(() => void refresh(), 10_000);
      }
    };
    void refresh();
    return () => {
      stopped = true;
      controller.abort();
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    };
  }, [session.productionCheckGateway]);

  const snapshot = connection.replica;
  const agentViews = useMemo(
    () => snapshot ? mapSnapshotToAgents(snapshot) : [],
    [snapshot],
  );
  const terminalReadOnlyMode =
    connection.mode === 'authentication_required' || connection.mode === 'upgrade_required';
  const effectiveMode: WorkspaceConnectionMode = terminalReadOnlyMode
    ? connection.mode
    : safetyIssue === null
      ? connection.mode
      : 'stale';
  const statusReason = terminalReadOnlyMode
    ? connection.reason
    : safetyIssue ?? connection.reason;
  const controlsAvailable = effectiveMode === 'live' && snapshot !== undefined && pending === null && !submitting;

  function invalidateReplica(reason: string): void {
    if (reconcilingRef.current) return;
    reconcilingRef.current = true;
    setSafetyIssue(reason);
    client.stop();
    client.start();
  }

  useEffect(() => {
    const checkFreshness = () => {
      const issue = runtimeFreshnessIssue({
        mode: connection.mode,
        snapshot: connection.replica,
        lastActivityAtMs: session.activity.lastActivityAtMs,
        heartbeatIntervalMs: session.activity.heartbeatIntervalMs,
        nowMs: Date.now(),
      });
      if (issue) invalidateReplica(issue.reason);
    };
    checkFreshness();
    const timer = setInterval(checkFreshness, 1_000);
    return () => clearInterval(timer);
  }, [client, connection.mode, connection.replica, session.activity]);

  useEffect(() => {
    const engineers = snapshot?.agents.filter((agent) => agent.role === 'engineer') ?? [];
    if (engineers.length === 0) {
      setQueueAgentId('');
      return;
    }
    if (!engineers.some((agent) => agent.agentId === queueAgentId)) {
      setQueueAgentId(String(engineers[0]?.agentId ?? ''));
    }
  }, [queueAgentId, snapshot]);

  async function executeCommand(command: HumanCommandEnvelope): Promise<void> {
    if (submittingRef.current || effectiveMode !== 'live') return;
    submittingRef.current = true;
    setSubmitting(true);
    setPending(command);
    setNotice(null);
    try {
      const receipt = await submitWithReplicaInvalidation({
        submit: () => client.submit(command),
        invalidate: invalidateReplica,
      });
      setNotice(receiptMessage(receipt));
      setPending(null);
    } catch (error) {
      setNotice({
        tone: 'error',
        text: `${errorMessage(error)} Retry will reuse the same command ID.`,
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function queueWork(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!snapshot || !controlsAvailable) return;
    const agent = snapshot.agents.find(
      (candidate) => candidate.agentId === queueAgentId && candidate.role === 'engineer',
    );
    if (!agent) {
      setNotice({ tone: 'error', text: 'Choose a registered engineer.' });
      return;
    }
    try {
      const command = buildQueueWorkCommand({
        snapshot,
        agent,
        clientCommandId: createClientCommandId(),
        issuedAt: new Date(),
        title,
        objective,
        expectedAgentMinutes: minutes,
      });
      void executeCommand(command).then(() => {
        setTitle('');
        setObjective('');
      });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    }
  }

  function requestInterrupt(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!snapshot || !interruptAgent || !controlsAvailable) return;
    try {
      const command = buildInterruptCommand({
        snapshot,
        agent: interruptAgent,
        clientCommandId: createClientCommandId(),
        issuedAt: new Date(),
        reason: interruptReason,
      });
      void executeCommand(command).then(() => {
        setInterruptAgent(null);
        setInterruptReason('');
      });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    }
  }

  function setWorkspacePause(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!snapshot || !controlsAvailable) return;
    try {
      const command = buildWorkspacePauseCommand({
        snapshot,
        paused: !snapshot.paused,
        reason: workspaceReason,
        clientCommandId: createClientCommandId(),
        issuedAt: new Date(),
      });
      void executeCommand(command).then(() => setWorkspaceReason(''));
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    }
  }

  function resumeAgent(agent: RegisteredAgentProjection): void {
    if (!snapshot || !controlsAvailable || snapshot.paused) return;
    const pausedTask = snapshot.tasks.find(
      (task) =>
        task.agentId === agent.agentId &&
        task.laneId === agent.laneId &&
        task.status === 'paused',
    ) ?? null;
    try {
      const command = buildResumeAgentCommand({
        snapshot,
        agent,
        task: pausedTask,
        clientCommandId: createClientCommandId(),
        issuedAt: new Date(),
      });
      void executeCommand(command);
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    }
  }

  function openQueue(agent: RegisteredAgentProjection): void {
    if (agent.role !== 'engineer') return;
    setQueueAgentId(String(agent.agentId));
    queuePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const developmentAgents = snapshot?.agents.filter((agent) => agent.role === 'engineer') ?? [];
  const selectedAgent = developmentAgents.find((agent) => agent.agentId === queueAgentId);
  const estimatedDeadline = selectedAgent
    ? expectedCompletionForAgentTime(new Date(), minutes)
    : null;
  const counts = snapshot
    ? {
        agents: snapshot.agents.length,
        queued: snapshot.tasks.filter((task) => task.status === 'queued').length,
        running: snapshot.tasks.filter((task) => task.status === 'running').length,
        completed: snapshot.tasks.filter((task) => task.status === 'completed').length,
      }
    : { agents: 0, queued: 0, running: 0, completed: 0 };
  const workspaceTransitionPending = snapshot?.agents.some((agent) =>
    snapshot.paused
      ? agent.controlState === 'hold_requested'
      : agent.controlState === 'interrupt_requested',
  ) ?? false;

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[1480px] flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div aria-hidden="true" className="grid h-10 w-10 grid-cols-2 gap-1 rounded-xl bg-ink-panel p-2">
              <span className="rounded-full bg-teal-300" />
              <span className="rounded-full bg-teal-500" />
              <span className="rounded-full bg-teal-500" />
              <span className="rounded-full bg-teal-300" />
            </div>
            <div>
              <p className="text-base font-extrabold tracking-[-0.02em]">Nexus Seventeen</p>
              <p className="text-xs text-muted">Authoritative runtime</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ConnectionBadge mode={effectiveMode} />
            <button
              className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 text-sm font-bold text-muted hover:border-ink hover:text-ink"
              onClick={() => {
                client.stop();
                onDisconnect();
              }}
              type="button"
            >
              <LogOut aria-hidden="true" className="h-4 w-4" />
              Change connection
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <section className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.15em] text-teal-700">
              {session.workspaceId}
            </p>
            <h1 className="mt-2 text-3xl font-extrabold tracking-[-0.04em] text-ink sm:text-4xl">
              Agent operations
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
              This screen is disposable. Supervisors and agents continue working if it closes or reloads.
            </p>
            <p className="mt-1 font-mono text-xs text-muted">{session.origin}</p>
          </div>
          {snapshot ? (
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted">
              <span>Snapshot <b className="font-mono text-ink">#{snapshot.sequence}</b></span>
              <span>Control <b className="font-mono text-ink">v{snapshot.controlVersion}</b></span>
              <span>Generated <ExactTimestamp value={snapshot.generatedAt} /></span>
            </div>
          ) : null}
        </section>

        {statusReason ? (
          <div className="mt-5 rounded-xl border border-caution-fill/35 bg-caution-soft px-4 py-3 text-sm text-caution" role="status">
            {statusReason} Commands remain disabled until the workspace is live.
          </div>
        ) : null}

        {notice ? (
          <div
            className={`mt-5 rounded-xl border px-4 py-3 text-sm ${notice.tone === 'success' ? 'border-teal-500/30 bg-teal-soft text-teal-700' : 'border-urgent/20 bg-urgent-soft text-urgent'}`}
            role={notice.tone === 'error' ? 'alert' : 'status'}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>{notice.text}</span>
              {pending ? (
                <div className="flex gap-2">
                  <button
                    className="rounded-lg border border-current/20 px-3 py-1.5 text-xs font-bold disabled:opacity-40"
                    disabled={effectiveMode !== 'live' || submitting}
                    onClick={() => void executeCommand(pending)}
                    type="button"
                  >
                    Retry same command
                  </button>
                  <button
                    className="rounded-lg px-3 py-1.5 text-xs font-bold underline underline-offset-2 disabled:opacity-40"
                    disabled={submitting}
                    onClick={() => setPending(null)}
                    type="button"
                  >
                    Stop retrying
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Object.entries(counts).map(([label, value]) => (
            <div className={panelClassName('px-4 py-4 sm:px-5')} key={label}>
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">{label}</p>
              <p className="mt-1 font-mono text-2xl font-medium text-ink">{value}</p>
            </div>
          ))}
        </section>

        <ImpactOverview
          configured={session.impactGateway !== undefined}
          impactOrigin={session.impactOrigin}
          runtimeSnapshot={snapshot}
          state={impact}
        />

        <ProductionCheckOverview
          configured={session.productionCheckGateway !== undefined}
          managerReviewOrigin={session.productionCheckOrigin}
          runtimeSnapshot={snapshot}
          state={productionChecks}
        />

        {snapshot ? (
          <section className={panelClassName('mt-6 p-5 sm:p-6')}>
            <div className="grid gap-5 lg:grid-cols-[minmax(240px,0.7fr)_minmax(0,1.3fr)] lg:items-end">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-teal-700">
                    Workspace control
                  </p>
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${snapshot.paused ? 'bg-caution-soft text-caution' : 'bg-teal-soft text-teal-700'}`}>
                    {snapshot.paused ? 'Paused' : 'Active'}
                  </span>
                </div>
                <h2 className="mt-2 text-lg font-extrabold text-ink">
                  {snapshot.paused ? 'Resume supervised work' : 'Pause every agent'}
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted">
                  {snapshot.paused
                    ? workspaceTransitionPending
                      ? 'Waiting for every supervisor to settle its hold before resume is available.'
                      : 'Resume only after every supervisor has settled its hold.'
                    : workspaceTransitionPending
                      ? 'Wait for pending agent interrupts to settle before pausing the workspace.'
                      : 'Agents checkpoint and hold locally; the frontend never stops their processes.'}
                </p>
              </div>
              <form className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" onSubmit={setWorkspacePause}>
                <label className="grid gap-1.5 text-xs font-bold text-muted">
                  Human reason
                  <input
                    className="min-h-11 rounded-lg border border-line bg-white px-3 text-sm text-ink placeholder:text-muted/60"
                    maxLength={1_000}
                    onChange={(event) => setWorkspaceReason(event.target.value)}
                    placeholder={snapshot.paused ? 'What review is now complete?' : 'Why must all agents pause?'}
                    required
                    value={workspaceReason}
                  />
                </label>
                <button
                  className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 ${snapshot.paused ? 'bg-teal-700 text-white' : 'bg-urgent text-white'}`}
                  disabled={!controlsAvailable || workspaceTransitionPending}
                  type="submit"
                >
                  {snapshot.paused ? (
                    <RotateCcw aria-hidden="true" className="h-4 w-4" />
                  ) : (
                    <CirclePause aria-hidden="true" className="h-4 w-4" />
                  )}
                  {snapshot.paused ? 'Resume workspace' : 'Pause workspace'}
                </button>
              </form>
            </div>
          </section>
        ) : null}

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
          <div className={panelClassName('p-5 sm:p-6')} ref={queuePanelRef}>
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-teal-soft p-2.5 text-teal-700">
                <Plus aria-hidden="true" className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-extrabold text-ink">Queue agent work</h2>
                <p className="mt-1 text-sm text-muted">
                  Estimate agent working time only. Human review time is deliberately excluded.
                </p>
              </div>
            </div>
            <form className="mt-5 grid gap-4" onSubmit={queueWork}>
              <label className="grid gap-1.5 text-xs font-bold text-muted">
                Agent
                <select
                  className="min-h-11 rounded-lg border border-line bg-white px-3 text-sm text-ink disabled:opacity-50"
                  disabled={developmentAgents.length === 0}
                  onChange={(event) => setQueueAgentId(event.target.value)}
                  value={queueAgentId}
                >
                  {developmentAgents.map((agent) => (
                    <option key={agent.agentId} value={agent.agentId}>
                      {agent.displayName} · {agent.role} · {agent.connectionState}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-xs font-bold text-muted">
                Task title
                <input
                  className="min-h-11 rounded-lg border border-line bg-white px-3 text-sm text-ink placeholder:text-muted/60"
                  maxLength={160}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="What should the agent deliver?"
                  required
                  value={title}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-bold text-muted">
                User-facing outcome
                <textarea
                  className="min-h-24 resize-y rounded-lg border border-line bg-white p-3 text-sm text-ink placeholder:text-muted/60"
                  maxLength={2_000}
                  onChange={(event) => setObjective(event.target.value)}
                  placeholder="Describe what should be true for users when the work is done."
                  required
                  value={objective}
                />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-xs font-bold text-muted">
                  Agent-only working time
                  <select
                    className="min-h-11 rounded-lg border border-line bg-white px-3 text-sm text-ink"
                    onChange={(event) => setMinutes(Number(event.target.value))}
                    value={minutes}
                  >
                    {AGENT_MINUTE_OPTIONS.map((value) => (
                      <option key={value} value={value}>{value} minutes</option>
                    ))}
                  </select>
                </label>
                <div className="rounded-lg bg-canvas px-3 py-2">
                  <p className="text-xs font-bold text-muted">Expected by · 15-minute boundary</p>
                  <p className="mt-1">
                    {estimatedDeadline ? <ExactTimestamp value={estimatedDeadline} /> : <span className="text-sm text-muted">Choose an agent</span>}
                  </p>
                </div>
              </div>
              <button
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-ink-panel px-4 text-sm font-bold text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!controlsAvailable || !selectedAgent}
                type="submit"
              >
                <Send aria-hidden="true" className="h-4 w-4" />
                {submitting ? 'Sending…' : effectiveMode === 'live' ? 'Queue work' : 'Read only while reconnecting'}
              </button>
            </form>
          </div>

          <div className={panelClassName('p-5 sm:p-6')}>
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-urgent-soft p-2.5 text-urgent">
                <CirclePause aria-hidden="true" className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-extrabold text-ink">Interrupt an agent</h2>
                <p className="mt-1 text-sm text-muted">
                  The supervisor checkpoints and settles the interruption; this UI only records intent.
                </p>
              </div>
            </div>
            {interruptAgent ? (
              <form className="mt-5 grid gap-4" onSubmit={requestInterrupt}>
                <div className="rounded-lg bg-canvas p-3">
                  <p className="text-xs text-muted">Target</p>
                  <p className="mt-1 font-bold text-ink">{interruptAgent.displayName}</p>
                  <p className="text-xs capitalize text-muted">{interruptAgent.role} · {humanize(interruptAgent.controlState)}</p>
                </div>
                <label className="grid gap-1.5 text-xs font-bold text-muted">
                  Reason
                  <textarea
                    autoFocus
                    className="min-h-24 resize-y rounded-lg border border-line bg-white p-3 text-sm text-ink placeholder:text-muted/60"
                    maxLength={1_000}
                    onChange={(event) => setInterruptReason(event.target.value)}
                    placeholder="Why should the agent stop now?"
                    required
                    value={interruptReason}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    className="min-h-11 rounded-lg border border-line px-3 text-sm font-bold text-muted"
                    onClick={() => {
                      setInterruptAgent(null);
                      setInterruptReason('');
                    }}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-urgent px-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!controlsAvailable}
                    type="submit"
                  >
                    <Square aria-hidden="true" className="h-3.5 w-3.5 fill-current" />
                    Request interrupt
                  </button>
                </div>
              </form>
            ) : (
              <div className="mt-5 rounded-xl border border-dashed border-line p-5 text-sm text-muted">
                Choose <b className="text-ink">Interrupt</b> on an agent below. Controls are available only while the live event stream is reconciled.
              </div>
            )}
            <div className="mt-5 flex items-start gap-2 border-t border-line-soft pt-4 text-xs leading-5 text-muted">
              <Clock3 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
              Queue and interrupt commands use the snapshot's exact control version. A retry keeps the original idempotency ID.
            </div>
          </div>
        </div>

        <section className="mt-8">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-teal-700">Autodiscovery</p>
              <h2 className="mt-1 text-2xl font-extrabold tracking-[-0.03em] text-ink">Registered agents</h2>
            </div>
            <p className="text-sm text-muted">Every lane comes from the current control-plane snapshot.</p>
          </div>
          {agentViews.length > 0 ? (
            <div className="grid gap-6">
              {agentViews.map((view) => (
                <AgentCard
                  controlsAvailable={controlsAvailable}
                  key={view.agent.laneId}
                  onInterrupt={(agent) => {
                    setInterruptAgent(agent);
                    setInterruptReason('');
                  }}
                  onQueue={openQueue}
                  onResume={resumeAgent}
                  view={view}
                  workspacePaused={snapshot?.paused ?? false}
                />
              ))}
            </div>
          ) : (
            <div className={panelClassName('p-8 text-center')}>
              <WifiOff aria-hidden="true" className="mx-auto h-8 w-8 text-muted" />
              <h3 className="mt-3 font-bold text-ink">
                {snapshot ? 'No supervisors are registered' : 'Waiting for the authoritative snapshot'}
              </h3>
              <p className="mt-1 text-sm text-muted">
                Agents appear automatically after their supervisor registers with this workspace.
              </p>
            </div>
          )}
        </section>

        {snapshot ? <div className="mt-8"><Journal snapshot={snapshot} /></div> : null}
      </main>
    </div>
  );
}

export function LiveRuntimeApp() {
  const [origin, setOrigin] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [humanToken, setHumanToken] = useState('');
  const [impactOrigin, setImpactOrigin] = useState('');
  const [impactToken, setImpactToken] = useState('');
  const [productionCheckOrigin, setProductionCheckOrigin] = useState('');
  const [productionCheckToken, setProductionCheckToken] = useState('');
  const [session, setSession] = useState<RuntimeSession | null>(null);
  const [error, setError] = useState('');

  function connect(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError('');
    try {
      const cleanedWorkspaceId = workspaceId.trim();
      const cleanedHumanToken = humanToken.trim();
      if (typeof globalThis.fetch !== 'function') {
        throw new Error('This browser does not provide fetch.');
      }
      const activity = new RuntimeActivityMonitor();
      const baseGateway = createHttpControlPlaneGateway({
        origin: origin.trim(),
        workspaceId: cleanedWorkspaceId as WorkspaceId,
        humanToken: cleanedHumanToken,
        fetch: createActivityTrackingFetch(
          activity,
          globalThis.fetch.bind(globalThis) as typeof fetch,
        ),
      });
      const gateway = observeGatewayBootstrap(baseGateway, activity);
      const cleanedImpactOrigin = impactOrigin.trim();
      const cleanedImpactToken = impactToken.trim();
      const hasImpactToken = cleanedImpactToken.length > 0;
      if ((cleanedImpactOrigin.length > 0) !== hasImpactToken) {
        throw new Error('Provide both the impact-observer origin and its separate output token, or leave both blank.');
      }
      if (hasImpactToken && cleanedImpactToken === cleanedHumanToken) {
        throw new Error('Use a separate read-only token for the impact observer.');
      }
      const impactGateway = cleanedImpactOrigin.length > 0
        ? createHttpImpactSummaryGateway({
            origin: cleanedImpactOrigin,
            workspaceId: cleanedWorkspaceId,
            outputToken: cleanedImpactToken,
            fetch: globalThis.fetch.bind(globalThis) as typeof fetch,
          })
        : undefined;
      const cleanedProductionCheckOrigin = productionCheckOrigin.trim();
      const cleanedProductionCheckToken = productionCheckToken.trim();
      const hasProductionCheckToken = cleanedProductionCheckToken.length > 0;
      if ((cleanedProductionCheckOrigin.length > 0) !== hasProductionCheckToken) {
        throw new Error('Provide both the manager-review origin and its dedicated production-check read token, or leave both blank.');
      }
      if (hasProductionCheckToken && cleanedProductionCheckToken === cleanedHumanToken) {
        throw new Error('Use a production-check read token that is separate from the control-plane token.');
      }
      if (hasProductionCheckToken && cleanedProductionCheckToken === cleanedImpactToken) {
        throw new Error('Use separate read tokens for production checks and the impact observer.');
      }
      const productionCheckGateway = cleanedProductionCheckOrigin.length > 0
        ? createHttpProductionCheckGateway({
            origin: cleanedProductionCheckOrigin,
            workspaceId: cleanedWorkspaceId,
            readToken: cleanedProductionCheckToken,
            fetch: globalThis.fetch.bind(globalThis) as typeof fetch,
          })
        : undefined;
      setSession({
        origin: new URL(origin.trim()).origin,
        workspaceId: cleanedWorkspaceId,
        gateway,
        activity,
        ...(impactGateway === undefined
          ? {}
          : { impactGateway, impactOrigin: new URL(cleanedImpactOrigin).origin }),
        ...(productionCheckGateway === undefined
          ? {}
          : {
              productionCheckGateway,
              productionCheckOrigin: new URL(cleanedProductionCheckOrigin).origin,
            }),
      });
      // The gateway owns the token only for this in-memory session. Remove it
      // from the form state and DOM immediately after connecting.
      setHumanToken('');
      setImpactToken('');
      setProductionCheckToken('');
    } catch (connectError) {
      setError(errorMessage(connectError));
    }
  }

  if (session) {
    return <ConnectedWorkspace onDisconnect={() => setSession(null)} session={session} />;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10 text-ink sm:px-6">
      <div className="w-full max-w-xl">
        <div className="mb-6 flex items-center gap-3">
          <div aria-hidden="true" className="grid h-12 w-12 grid-cols-2 gap-1 rounded-2xl bg-ink-panel p-2.5">
            <span className="rounded-full bg-teal-300" />
            <span className="rounded-full bg-teal-500" />
            <span className="rounded-full bg-teal-500" />
            <span className="rounded-full bg-teal-300" />
          </div>
          <div>
            <p className="text-lg font-extrabold tracking-[-0.03em]">Nexus Seventeen</p>
            <p className="text-sm text-muted">Connect to an authoritative runtime</p>
          </div>
        </div>

        <section className={panelClassName('p-6 sm:p-8')}>
          <p className="text-xs font-bold uppercase tracking-[0.15em] text-teal-700">Live operator access</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-[-0.04em]">Find every working agent.</h1>
          <p className="mt-3 text-sm leading-6 text-muted">
            The browser is a disposable view over the control plane. Closing this page never stops the supervisors or their agents.
          </p>

          <form autoComplete="off" className="mt-7 grid gap-4" onSubmit={connect}>
            <label className="grid gap-1.5 text-xs font-bold text-muted">
              Control-plane origin
              <input
                autoCapitalize="none"
                className="min-h-12 rounded-lg border border-line bg-white px-3 font-mono text-sm text-ink placeholder:text-muted/55"
                inputMode="url"
                onChange={(event) => setOrigin(event.target.value)}
                placeholder="https://control.example.com"
                required
                spellCheck={false}
                type="url"
                value={origin}
              />
            </label>
            <label className="grid gap-1.5 text-xs font-bold text-muted">
              Workspace ID
              <input
                autoCapitalize="none"
                className="min-h-12 rounded-lg border border-line bg-white px-3 font-mono text-sm text-ink placeholder:text-muted/55"
                onChange={(event) => setWorkspaceId(event.target.value)}
                placeholder="workspace-alpha"
                required
                spellCheck={false}
                value={workspaceId}
              />
            </label>
            <label className="grid gap-1.5 text-xs font-bold text-muted">
              Human bearer token
              <input
                autoCapitalize="none"
                autoComplete="off"
                className="min-h-12 rounded-lg border border-line bg-white px-3 font-mono text-sm text-ink placeholder:text-muted/55"
                onChange={(event) => setHumanToken(event.target.value)}
                placeholder="Paste for this session only"
                required
                spellCheck={false}
                type="password"
                value={humanToken}
              />
            </label>

            <fieldset className="grid gap-4 rounded-xl border border-line-soft bg-canvas p-4">
              <legend className="px-1 text-xs font-bold text-muted">Optional read-only impact observer</legend>
              <label className="grid gap-1.5 text-xs font-bold text-muted">
                Observer origin
                <input
                  autoCapitalize="none"
                  className="min-h-12 rounded-lg border border-line bg-white px-3 font-mono text-sm text-ink placeholder:text-muted/55"
                  inputMode="url"
                  onChange={(event) => setImpactOrigin(event.target.value)}
                  placeholder="https://impact.example.com"
                  spellCheck={false}
                  type="url"
                  value={impactOrigin}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-bold text-muted">
                Separate output token
                <input
                  autoCapitalize="none"
                  autoComplete="off"
                  className="min-h-12 rounded-lg border border-line bg-white px-3 font-mono text-sm text-ink placeholder:text-muted/55"
                  onChange={(event) => setImpactToken(event.target.value)}
                  placeholder="Paste for this session only"
                  spellCheck={false}
                  type="password"
                  value={impactToken}
                />
              </label>
            </fieldset>

            <fieldset className="grid gap-4 rounded-xl border border-caution-fill/30 bg-caution-soft/40 p-4">
              <legend className="px-1 text-xs font-bold text-muted">Optional read-only human production checks</legend>
              <label className="grid gap-1.5 text-xs font-bold text-muted">
                Production-check origin
                <input
                  autoCapitalize="none"
                  className="min-h-12 rounded-lg border border-line bg-white px-3 font-mono text-sm text-ink placeholder:text-muted/55"
                  inputMode="url"
                  onChange={(event) => setProductionCheckOrigin(event.target.value)}
                  placeholder="https://review.example.com"
                  spellCheck={false}
                  type="url"
                  value={productionCheckOrigin}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-bold text-muted">
                Dedicated production-check read token
                <input
                  autoCapitalize="none"
                  autoComplete="off"
                  className="min-h-12 rounded-lg border border-line bg-white px-3 font-mono text-sm text-ink placeholder:text-muted/55"
                  onChange={(event) => setProductionCheckToken(event.target.value)}
                  placeholder="Paste for this session only"
                  spellCheck={false}
                  type="password"
                  value={productionCheckToken}
                />
              </label>
              <p className="text-xs leading-5 text-muted">
                This connection only reads manager-accepted checks. Approval and deployment are intentionally absent from this screen.
              </p>
            </fieldset>

            {error ? (
              <p className="rounded-lg border border-urgent/20 bg-urgent-soft px-3 py-2 text-sm text-urgent" role="alert">
                {error}
              </p>
            ) : null}

            <button className="mt-1 inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-ink-panel px-4 text-sm font-bold text-white hover:bg-teal-700" type="submit">
              <Radio aria-hidden="true" className="h-4 w-4" />
              Connect live
            </button>
          </form>

          <div className="mt-5 flex items-start gap-2 rounded-lg bg-teal-soft px-3 py-3 text-xs leading-5 text-teal-700">
            <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            Tokens stay in memory for this tab. Steward does not put them in the bundle, URL, browser storage, or logs.
          </div>
        </section>

        <p className="mt-5 text-center text-xs text-muted">
          Looking for the visual prototype? <a className="font-bold text-teal-700 underline underline-offset-2" href="/">Open the demo</a>
        </p>
      </div>
    </main>
  );
}
