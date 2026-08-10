import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  HelpCircle,
  Send,
  Square,
  UserRoundCheck,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { Button, Card, FieldLabel, InlineActionErrors, Pill, cn, inputClass } from '../../components/ui';
import {
  actionErrorContexts,
  useActionErrors,
  type ActionResult,
} from '../model/action-errors';
import {
  assignmentAgentOptionLabel,
} from '../model/workspace-model';
import {
  explicitAgentPickerSelection,
  initialAgentPickerSelection,
  recoveryAffordances,
  syncAgentPickerSelection,
} from '../model/task-recovery';
import type {
  TaskDetailDraftAction,
  TaskDetailDraftState,
} from '../model/task-detail-drafts';
import type {
  BoardAgent,
  BoardQuestion,
  BoardRun,
  BoardTask,
} from '../types';
import { StatusPill } from './TaskList';

export function taskPhasesByOrder(phases: BoardTask['phases']): BoardTask['phases'] {
  return [...phases].sort((left, right) => (
    left.orderKey - right.orderKey
      || left.createdAtMs - right.createdAtMs
      || left.id.localeCompare(right.id)
  ));
}

export function taskRunsByCreatedAt(runs: BoardRun[]): BoardRun[] {
  return [...runs].sort((left, right) => right.createdAtMs - left.createdAtMs || left.id.localeCompare(right.id));
}

const phaseStatusTone = {
  pending: 'neutral',
  in_progress: 'green',
  blocked: 'amber',
  completed: 'green',
  failed: 'red',
} as const;

function TaskPhases({ task }: { task: BoardTask }) {
  const phases = taskPhasesByOrder(task.phases);
  const parallelCounts = new Map<string, number>();
  for (const phase of phases) {
    if (phase.parallelGroup) parallelCounts.set(phase.parallelGroup, (parallelCounts.get(phase.parallelGroup) ?? 0) + 1);
  }

  return (
    <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="task-phases-heading">
      <h3 id="task-phases-heading" className="text-xs font-semibold text-ink">Phases</h3>
      {phases.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-muted">The agent will add phases and an estimate after reviewing the task.</p>
      ) : (
        <ol className="mt-3 divide-y divide-line overflow-hidden rounded-md border border-line bg-muted-surface">
          {phases.map((phase) => {
            const parallel = phase.parallelGroup !== null && (parallelCounts.get(phase.parallelGroup) ?? 0) > 1;
            return (
              <li key={phase.id} className="flex items-start gap-3 px-3.5 py-3">
                <span className={cn(
                  'mt-1.5 size-2 shrink-0 rounded-[99px]',
                  phase.status === 'completed' ? 'bg-success-fill' : phase.status === 'in_progress' ? 'bg-taupe-hover' : phase.status === 'failed' ? 'bg-urgent' : phase.status === 'blocked' ? 'bg-caution-fill' : 'bg-line',
                )} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-medium text-ink">{phase.title}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                    <span className="capitalize">{phase.stage.replaceAll('_', ' ')}</span>
                    {parallel ? <span className="rounded-[99px] bg-paper px-2 py-0.5">Parallel</span> : null}
                  </span>
                </span>
                <Pill tone={phaseStatusTone[phase.status]}>{phase.status.replaceAll('_', ' ')}</Pill>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function TaskDetail({
  task,
  agents,
  questions,
  runs,
  drafts,
  dispatchDraft,
  busy,
  onAssign,
  onReturnToBacklog,
  onRetry,
  onRecoveryBacklog,
  onAnswer,
  onInterrupt,
  onDecideHumanCheck,
}: {
  task: BoardTask;
  agents: BoardAgent[];
  questions: BoardQuestion[];
  runs: BoardRun[];
  drafts: TaskDetailDraftState;
  dispatchDraft: Dispatch<TaskDetailDraftAction>;
  busy: boolean;
  onAssign: (agentId: string) => Promise<ActionResult>;
  onReturnToBacklog: () => Promise<ActionResult>;
  onRetry: () => Promise<ActionResult>;
  onRecoveryBacklog: () => Promise<ActionResult>;
  onAnswer: (questionId: string, answer: string) => Promise<ActionResult>;
  onInterrupt: (runId: string) => Promise<ActionResult>;
  onDecideHumanCheck: (status: 'completed' | 'failed', rationale: string) => Promise<ActionResult>;
}) {
  const eligibleAgents = useMemo(
    () => task.requiredRole === null ? agents : agents.filter((agent) => agent.role === task.requiredRole),
    [agents, task.requiredRole],
  );
  const recovery = useMemo(() => recoveryAffordances({
    status: task.status,
    assignedAgentId: task.assignedAgentId,
    // The board snapshot does not expose stage-attempt linkage. The dedicated
    // backlog endpoint remains authoritative and returns TASK_WORKFLOW_BOUND.
    workflowBound: null,
    eligibleAgentIds: eligibleAgents.map((agent) => agent.id),
  }), [eligibleAgents, task.assignedAgentId, task.status]);
  const recoveryAgents = useMemo(() => recovery === null
    ? []
    : recovery.reassign.eligibleAgentIds.flatMap((eligibleId) => {
      const eligible = eligibleAgents.find((agent) => agent.id === eligibleId);
      return eligible ? [eligible] : [];
    }), [eligibleAgents, recovery]);
  const defaultAgentId = recovery === null
    ? task.assignedAgentId ?? eligibleAgents[0]?.id ?? ''
    : recovery.reassign.eligibleAgentIds[0] ?? '';
  const [agentSelection, setAgentSelection] = useState(() => initialAgentPickerSelection(task.id, defaultAgentId));
  const agentId = agentSelection.taskId === task.id ? agentSelection.agentId : defaultAgentId;
  const selectedAgent = eligibleAgents.find((agent) => agent.id === agentId);
  const selectedWorkerOffline = selectedAgent?.workerConnection === null;
  const offlineNoticeId = `assignment-worker-${task.id}`;
  const recoveryHelpId = `recovery-help-${task.id}`;
  const recoveryDescribedBy = [
    busy || recovery?.reassign.disabledReason ? recoveryHelpId : null,
    selectedWorkerOffline ? offlineNoticeId : null,
  ].filter((value): value is string => value !== null).join(' ') || undefined;
  const actionErrors = useActionErrors();
  const openQuestion = questions.find((question) => question.status === 'open');
  const activeRun = runs.find((run) => run.status === 'running' || run.status === 'queued');
  const queuedUnclaimed = task.status === 'queued' && !activeRun;
  const assigneeChanged = agentId !== task.assignedAgentId;
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);

  const eligiblePickerIds = useMemo(
    () => (recovery === null ? eligibleAgents.map((agent) => agent.id) : recovery.reassign.eligibleAgentIds),
    [eligibleAgents, recovery],
  );
  useEffect(() => {
    setAgentSelection((current) => syncAgentPickerSelection(current, task.id, defaultAgentId, eligiblePickerIds));
  }, [defaultAgentId, task.id, eligiblePickerIds]);

  function selectAgent(nextAgentId: string): void {
    setAgentSelection((current) => explicitAgentPickerSelection(
      syncAgentPickerSelection(current, task.id, defaultAgentId),
      nextAgentId,
    ));
  }

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(max-width: 1279px)').matches) detailHeadingRef.current?.focus();
  }, [task.id]);

  async function runAction(context: string, operation: () => Promise<ActionResult>): Promise<boolean> {
    actionErrors.start(context);
    const result = await operation();
    if (result.ok) return true;
    actionErrors.fail(context, result.error);
    return false;
  }

  return (
    <section aria-label={`Task details: ${task.title}`}>
      <Card className="overflow-hidden">
      <header className="border-b border-line px-4 py-5 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Current status</p>
            <StatusPill task={task} />
          </div>
          {task.expectedAgentMinutes !== null ? <span className="text-[11px] text-muted">About {task.expectedAgentMinutes} agent min</span> : null}
        </div>
        <h2 ref={detailHeadingRef} tabIndex={-1} className="mt-4 break-words font-display text-xl font-light tracking-[0.01em] text-ink">{task.title}</h2>
        <div className="mt-4">
          <p className="text-xs font-medium text-muted">Description</p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink">{task.objective}</p>
        </div>
      </header>

      {task.kind !== 'human_check' ? <TaskPhases task={task} /> : null}

      {task.kind !== 'human_check' && openQuestion ? (
        <section className="border-b border-caution-fill/30 bg-caution-soft/55 px-4 py-4 sm:px-5">
          <div className="flex items-center gap-2 text-caution">
            <HelpCircle size={17} />
            <h3 className="text-xs font-semibold">Waiting for your answer</h3>
          </div>
          <p className="mt-3 whitespace-pre-wrap text-sm font-medium leading-6 text-ink">{openQuestion.prompt}</p>
          <div className="mt-3">
            <FieldLabel htmlFor={`task-answer-${task.id}`}>Your answer</FieldLabel>
            <textarea
              id={`task-answer-${task.id}`}
              className={cn(inputClass, 'min-h-24 resize-y py-3')}
              placeholder="Give the missing context…"
              value={drafts.answer}
              onChange={(event) => dispatchDraft({ type: 'answer-changed', value: event.target.value })}
            />
          </div>
          <Button
            className="mt-3 w-full"
            variant="primary"
            icon={<Send size={16} />}
            disabled={busy || drafts.answer.trim().length === 0}
            onClick={() => void runAction(actionErrorContexts.taskAnswer(task.id, openQuestion.id), () => onAnswer(openQuestion.id, drafts.answer.trim())).then((saved) => { if (saved) dispatchDraft({ type: 'answer-changed', value: '' }); })}
          >
            Answer and wake agent
          </Button>
        </section>
      ) : null}

      {task.kind === 'human_check' && task.endedAt === null ? (
        <section className="border-b border-caution-fill/30 bg-caution-soft/45 px-4 py-4 sm:px-5">
          <div className="flex items-center gap-2 text-caution"><UserRoundCheck size={17} /><h3 className="text-xs font-semibold">Human release decision</h3></div>
          <FieldLabel htmlFor={'human-decision-' + task.id}>Decision rationale</FieldLabel>
          <textarea
            id={'human-decision-' + task.id}
            className={cn(inputClass, 'min-h-24 resize-y py-3')}
            placeholder="Why is this ready, or what must change?"
            value={drafts.decisionRationale}
            onChange={(event) => dispatchDraft({ type: 'rationale-changed', value: event.target.value })}
          />
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Button
              variant="mint"
              icon={<CheckCircle2 size={16} />}
              disabled={busy || drafts.decisionRationale.trim().length === 0}
              onClick={() => void runAction(actionErrorContexts.taskHumanCheckApprove(task.id), () => onDecideHumanCheck('completed', drafts.decisionRationale.trim())).then((saved) => { if (saved) dispatchDraft({ type: 'rationale-changed', value: '' }); })}
            >
              Approve
            </Button>
            <Button
              variant="danger"
              icon={<CircleAlert size={16} />}
              disabled={busy || drafts.decisionRationale.trim().length === 0}
              onClick={() => void runAction(actionErrorContexts.taskHumanCheckRequestChanges(task.id), () => onDecideHumanCheck('failed', drafts.decisionRationale.trim())).then((saved) => { if (saved) dispatchDraft({ type: 'rationale-changed', value: '' }); })}
            >
              Request changes
            </Button>
          </div>
        </section>
      ) : null}

      {task.kind !== 'human_check' && recovery !== null && !openQuestion ? (
        <section className="space-y-3 px-4 py-4 sm:px-5" aria-label="Task recovery actions">
          <div>
            <h3 className="text-xs font-semibold text-ink">Recover task</h3>
            <p className="mt-1 text-xs leading-5 text-muted">Retry the same assignment, choose another eligible agent, or return standalone work to the backlog.</p>
          </div>
          {recovery.retry ? (
            <Button className="w-full" variant="primary" icon={<Activity size={16} />} disabled={busy} onClick={() => void runAction(actionErrorContexts.taskRetry(task.id), onRetry)}>
              Retry
            </Button>
          ) : null}
          <div>
            <FieldLabel htmlFor={`recovery-agent-${task.id}`}>Replacement agent</FieldLabel>
            <select
              id={`recovery-agent-${task.id}`}
              className={inputClass}
              value={agentId}
              disabled={busy || recoveryAgents.length === 0}
              aria-describedby={recoveryDescribedBy}
              onChange={(event) => selectAgent(event.target.value)}
            >
              {recoveryAgents.length === 0 ? <option value="">No eligible agents</option> : null}
              {recoveryAgents.map((agent) => <option key={agent.id} value={agent.id}>{assignmentAgentOptionLabel(agent)}</option>)}
            </select>
            {selectedWorkerOffline ? <p id={offlineNoticeId} className="mt-2 text-xs leading-5 text-caution" role="status">Worker offline — the task will wait until its lane connects</p> : null}
          </div>
          <Button
            className="w-full"
            variant={recovery.reassign.primary ? 'primary' : 'secondary'}
            icon={<UserRoundCheck size={16} />}
            disabled={busy || recovery.reassign.disabledReason !== null || agentId.length === 0}
            aria-describedby={recoveryDescribedBy}
            onClick={() => void runAction(actionErrorContexts.taskRecoveryReassign(task.id), () => onAssign(agentId))}
          >
            Reassign
          </Button>
          {recovery.backlog ? (
            <Button className="w-full" icon={<ArrowLeft size={16} />} disabled={busy} onClick={() => void runAction(actionErrorContexts.taskRecoveryBacklog(task.id), onRecoveryBacklog)}>
              Return to backlog
            </Button>
          ) : null}
          {busy || recovery.reassign.disabledReason ? (
            <p id={recoveryHelpId} className="text-xs leading-5 text-muted">
              {busy ? 'Recovery actions are temporarily unavailable while a board change is in progress.' : recovery.reassign.disabledReason}
            </p>
          ) : null}
        </section>
      ) : task.kind !== 'human_check' && (task.status === 'backlog' || task.status === 'proposed' || queuedUnclaimed) && !openQuestion ? (
        <section className="px-4 py-4 sm:px-5">
            <div className="space-y-3">
              {eligibleAgents.length > 0 ? (
                <div>
                  <select className={inputClass} aria-label={task.kind === 'manager_review' ? 'Assign manager' : 'Assign agent'} aria-describedby={selectedWorkerOffline ? offlineNoticeId : undefined} value={agentId} onChange={(event) => selectAgent(event.target.value)}>
                    {eligibleAgents.map((agent) => <option key={agent.id} value={agent.id}>{assignmentAgentOptionLabel(agent)}</option>)}
                  </select>
                  {selectedWorkerOffline ? <p id={offlineNoticeId} className="mt-2 text-xs leading-5 text-caution" role="status">Worker offline — the task will wait until its lane connects</p> : null}
                </div>
              ) : <p className="text-sm text-muted">No {task.requiredRole ?? 'eligible'} agent is available.</p>}
              <Button className="w-full" variant="primary" icon={<UserRoundCheck size={16} />} aria-describedby={selectedWorkerOffline ? offlineNoticeId : undefined} disabled={busy || agentId.length === 0 || (queuedUnclaimed && !assigneeChanged)} onClick={() => void runAction(actionErrorContexts.taskAssign(task.id), () => onAssign(agentId))}>
                {queuedUnclaimed ? task.kind === 'manager_review' ? 'Reassign manager and wake' : 'Reassign and wake agent' : task.kind === 'manager_review' ? 'Assign manager and wake' : 'Assign and wake agent'}
              </Button>
              {queuedUnclaimed ? <Button className="w-full" icon={<ArrowLeft size={16} />} disabled={busy} onClick={() => void runAction(actionErrorContexts.taskReturnToBacklog(task.id), onReturnToBacklog)}>Return to backlog</Button> : null}
            </div>
        </section>
      ) : null}

      {actionErrors.errors.length > 0 ? <div className="border-t border-line px-4 py-4 sm:px-5"><InlineActionErrors errors={actionErrors.errors} onDismiss={actionErrors.dismiss} /></div> : null}

      {task.kind !== 'human_check' && activeRun ? (
        <section className="flex items-center justify-between gap-3 px-4 py-4 sm:px-5">
          <span className="text-sm text-muted">Agent is working on this task.</span>
          <Button variant="danger" size="sm" icon={<Square size={14} />} disabled={busy} onClick={() => void runAction(actionErrorContexts.taskInterrupt(task.id, activeRun.id), () => onInterrupt(activeRun.id))}>Interrupt</Button>
        </section>
      ) : null}
      </Card>
    </section>
  );
}
