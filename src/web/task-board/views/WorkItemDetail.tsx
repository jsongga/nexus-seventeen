import {
  Archive,
  ArrowRight,
  Check,
  CircleAlert,
  CirclePause,
  HelpCircle,
  RefreshCw,
  Send,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, FieldLabel, InlineActionErrors, Modal, Pill, cn, inputClass } from '../../components/ui';
import { fieldsAreDirty } from '../../components/dialog-discard';
import type { TaskBoardClient } from '../data/client';
import {
  deriveWorkItemDetailAffordances,
  nodesForPlan,
  proposedPlanForWorkItem,
  type DetailedWorkflowPlan,
} from '../model/work-item-detail';
import {
  prettyStatus,
  unknownStateLabel,
  workItemStateLabel,
  workItemStateTone,
  workItemStatusLabel,
} from '../model/work-item-labels';
import {
  actionErrorContexts,
  actionErrorMessage,
  useActionErrors,
  type ActionErrorState,
  type ActionResult,
} from '../model/action-errors';
import type {
  BoardQuestion,
  BoardTask,
  BoardWorkItem,
  ProjectWorkflow,
  WorkflowNode,
} from '../types';

interface WorkItemDetailProps {
  workItem: BoardWorkItem;
  projectName: string | null;
  planningTask: BoardTask | null;
  openQuestion: BoardQuestion | null;
  client: TaskBoardClient;
  busy: boolean;
  onClose: () => void;
  onAnswer: (questionId: string, answer: string) => Promise<ActionResult>;
  onConfirm: (planRevisionId: string) => Promise<ActionResult>;
  onCancel: (reason: string) => Promise<ActionResult>;
  onArchive: () => Promise<ActionResult>;
}

function StatusTimeline({ workItem }: { workItem: BoardWorkItem }) {
  const position = workItem.state === 'unrecognized'
    ? -1
    : workItem.state === 'queued'
      ? 0
      : workItem.endedAt !== null
        ? 3
        : workItem.state === 'plan_approval' || workItem.state === 'final_approval' || workItem.state === 'parked'
          ? 2
          : 1;
  const checkpoint = workItem.state === 'parked'
    ? 'Parked'
    : workItem.state === 'plan_approval'
      ? 'Plan review'
      : workItem.state === 'final_approval'
        ? 'Final review'
        : 'Human checkpoint';
  const terminalLabel = workItem.endedAt === null ? 'Terminal' : workItemStateLabel[workItem.state];
  const steps = ['Queued', 'In progress', checkpoint, terminalLabel];

  return (
    <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="work-item-timeline-heading">
      <h3 id="work-item-timeline-heading" className="text-xs font-semibold text-ink">Status timeline</h3>
      <ol className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-4 sm:gap-0">
        {steps.map((label, index) => {
          const complete = workItem.state !== 'unrecognized'
            && (index < position || (index === 3 && workItem.endedAt !== null));
          const current = index === position && workItem.endedAt === null;
          return (
            <li key={`${index}-${label}`} className="relative flex items-center gap-3 sm:block sm:pr-3">
              {index > 0 ? <span className={cn('absolute right-[calc(100%-9px)] top-2 hidden h-px w-[calc(100%-18px)] sm:block', complete || current ? 'bg-taupe' : 'bg-line')} aria-hidden="true" /> : null}
              <span className={cn(
                'relative z-[1] flex size-[18px] shrink-0 items-center justify-center rounded-full border bg-card',
                complete ? 'border-taupe bg-taupe text-white' : current ? 'border-taupe text-taupe' : 'border-line text-muted',
              )} aria-hidden="true">
                {complete ? <Check size={10} strokeWidth={2.5} /> : <span className={cn('size-1.5 rounded-full', current ? 'bg-taupe' : 'bg-line')} />}
              </span>
              <span className={cn('text-xs capitalize sm:mt-2 sm:block', current || complete ? 'text-ink' : 'text-muted')}>{label}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function WorkflowNodeCard({ node, allNodes }: { node: WorkflowNode; allNodes: WorkflowNode[] }) {
  const titles = new Map(allNodes.map((candidate) => [candidate.nodeId, candidate.title]));
  return (
    <li>
      <article className="rounded-md border border-line bg-muted-surface p-3.5" aria-label={node.title}>
        <p className="text-sm font-semibold text-ink">{node.title}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted">{node.objective}</p>
      <div className="mt-3">
        <p className="text-[11px] font-medium text-muted">Stages</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {node.stageTemplate.map((stage, index) => (
            <span key={stage} className="inline-flex items-center gap-1.5">
              {index > 0 ? <ArrowRight size={11} className="text-muted" aria-hidden="true" /> : null}
              <Pill>{prettyStatus(stage)}</Pill>
            </span>
          ))}
        </div>
      </div>
      <div className="mt-3">
        <p className="text-[11px] font-medium text-muted">Dependencies</p>
        <p className="mt-1 text-xs leading-5 text-ink">
          {node.dependencyNodeIds.length === 0
            ? 'Starts without another node.'
            : node.dependencyNodeIds.map((dependencyId) => titles.get(dependencyId) ?? dependencyId).join(', ')}
        </p>
        </div>
      </article>
    </li>
  );
}

function planValueLabel(value: string): string {
  const label = prettyStatus(value);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function PlanListSection({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div className="mt-3">
      <p className="text-[11px] font-medium text-muted">{title}</p>
      {items.length > 0
        ? <ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-5 text-ink">{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
        : <p className="mt-1 text-xs leading-5 text-muted">None declared.</p>}
    </div>
  );
}

export function PlanRecordDetails({ plan }: { plan: DetailedWorkflowPlan }) {
  return (
    <div className="rounded-md border border-line bg-card p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-semibold text-ink">{plan.objective}</p>
        {plan.changeShape !== undefined || plan.tier !== undefined ? (
          <div className="flex flex-wrap gap-1.5" aria-label="Plan classification">
            {plan.changeShape === undefined ? null : <Pill tone="purple">{planValueLabel(plan.changeShape)}</Pill>}
            {plan.tier === undefined ? null : <Pill tone={plan.tier === 'hazardous' ? 'red' : 'green'}>{planValueLabel(plan.tier)}</Pill>}
          </div>
        ) : null}
      </div>
      {plan.assumptions.length > 0 ? <PlanListSection title="Assumptions" items={plan.assumptions} /> : null}
      <PlanListSection title="Acceptance criteria" items={plan.acceptanceCriteria} />
      {plan.declaredScope === undefined ? null : <PlanListSection title="Declared scope" items={plan.declaredScope} />}
      {plan.nonGoals === undefined ? null : <PlanListSection title="Non-goals" items={plan.nonGoals} />}
      {plan.mechanicalPortions === undefined ? null : <PlanListSection title="Mechanical portions" items={plan.mechanicalPortions} />}
      {plan.blockingQuestions === undefined ? null : (
        <div className="mt-3">
          <p className="text-[11px] font-medium text-muted">Blocking questions</p>
          {plan.blockingQuestions.length > 0 ? (
            <ol className="mt-1.5 space-y-2">
              {plan.blockingQuestions.map((question, index) => (
                <li key={`${index}-${question.question}`} className="rounded-md border border-line bg-muted-surface px-3 py-2.5">
                  <p className="text-xs font-medium leading-5 text-ink">{question.question}</p>
                  <p className="mt-1 text-[11px] font-medium text-muted">Recommended default</p>
                  <p className="mt-0.5 text-xs leading-5 text-ink">{question.recommendedDefault}</p>
                </li>
              ))}
            </ol>
          ) : <p className="mt-1 text-xs leading-5 text-muted">None declared.</p>}
        </div>
      )}
      {plan.criterionChecks === undefined ? null : (
        <div className="mt-3">
          <p className="text-[11px] font-medium text-muted">Criterion checks</p>
          {plan.criterionChecks.length > 0 ? (
            <dl className="mt-1.5 space-y-2">
              {plan.criterionChecks.map((criterion, index) => (
                <div key={`${index}-${criterion.criterion}`} className="rounded-md border border-line bg-muted-surface px-3 py-2.5">
                  <dt className="text-xs font-medium leading-5 text-ink">{criterion.criterion}</dt>
                  <dd className="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-5 text-muted">{criterion.check}</dd>
                </div>
              ))}
            </dl>
          ) : <p className="mt-1 text-xs leading-5 text-muted">None declared.</p>}
        </div>
      )}
    </div>
  );
}

export function PlanApprovalActions({
  plan,
  busy,
  confirmEnabled,
  rejectEnabled,
  onConfirm,
  onReject,
}: {
  plan: DetailedWorkflowPlan;
  busy: boolean;
  confirmEnabled: boolean;
  rejectEnabled: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  if (!confirmEnabled && !rejectEnabled) return null;
  return (
    <div className="mt-4">
      {plan.tier === 'hazardous' ? (
        <div className="mb-3 rounded-md border border-caution/30 bg-caution-soft px-3.5 py-3 text-sm leading-6 text-caution" role="alert">
          <p className="font-medium">Hazardous plans park at confirmation</p>
          <p className="mt-1 text-xs leading-5">This tier needs the Design stage from campaign 5. Confirming records approval but does not activate work.</p>
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {confirmEnabled ? <Button variant="mint" icon={<Check size={16} />} disabled={busy} onClick={onConfirm}>Confirm plan</Button> : null}
        {rejectEnabled ? <Button variant="danger" icon={<CircleAlert size={16} />} disabled={busy} onClick={onReject}>Reject plan</Button> : null}
      </div>
    </div>
  );
}

export function PlanRejectionForm({
  workItemId,
  note,
  busy,
  errors,
  onNoteChange,
  onDismissError,
  onSubmit,
  onKeep,
}: {
  workItemId: string;
  note: string;
  busy: boolean;
  errors: ActionErrorState;
  onNoteChange: (note: string) => void;
  onDismissError: (context: string) => void;
  onSubmit: () => void;
  onKeep: () => void;
}) {
  return (
    <form className="space-y-4 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <div>
        <FieldLabel htmlFor={`work-item-rejection-note-${workItemId}`}>Revision note</FieldLabel>
        <textarea
          id={`work-item-rejection-note-${workItemId}`}
          className={cn(inputClass, 'min-h-24 resize-y py-3')}
          autoFocus
          required
          maxLength={2_000}
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder="What must change before this plan can proceed?"
        />
      </div>
      <InlineActionErrors errors={errors} onDismiss={onDismissError} />
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="submit" variant="danger" disabled={busy || note.trim().length === 0}>Reject and revise</Button>
        <Button disabled={busy} onClick={onKeep}>Keep proposed plan</Button>
      </div>
    </form>
  );
}

export function WorkItemDetail({
  workItem,
  projectName,
  planningTask,
  openQuestion,
  client,
  busy,
  onClose,
  onAnswer,
  onConfirm,
  onCancel,
  onArchive,
}: WorkItemDetailProps) {
  const [answer, setAnswer] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [rejectionNote, setRejectionNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [confirmation, setConfirmation] = useState<'cancel' | 'reject' | 'archive' | null>(null);
  const actionErrors = useActionErrors();
  const [workflow, setWorkflow] = useState<ProjectWorkflow | null>(null);
  const [workflowState, setWorkflowState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [workflowAttempt, setWorkflowAttempt] = useState(0);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingId = `work-item-detail-heading-${workItem.id}`;
  const actionContexts = {
    rejectPlan: actionErrorContexts.workItemRejectPlan(workItem.id),
    cancel: actionErrorContexts.workItemCancel(workItem.id),
    archive: actionErrorContexts.workItemArchive(workItem.id),
  } as const;
  const affordances = deriveWorkItemDetailAffordances({
    workItemState: workItem.state,
    planningTaskState: planningTask?.status ?? null,
    archived: workItem.archivedAt !== null,
  });

  useEffect(() => {
    setAnswer('');
    setCancelReason('');
    setRejectionNote('');
    setRejecting(false);
    setConfirmation(null);
  }, [workItem.id]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(max-width: 1279px)').matches) detailHeadingRef.current?.focus();
  }, [workItem.id]);

  useEffect(() => {
    if (workItem.state !== 'plan_approval' || workItem.resolvedProjectId === null) {
      setWorkflow(null);
      setWorkflowError(null);
      setWorkflowState('idle');
      return;
    }
    const controller = new AbortController();
    setWorkflow(null);
    setWorkflowError(null);
    setWorkflowState('loading');
    void client.getProjectWorkflow(workItem.resolvedProjectId, controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      setWorkflow(next);
      setWorkflowState('ready');
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setWorkflowError(caught instanceof Error ? caught.message : 'The proposed plan could not be loaded');
      setWorkflowState('error');
    });
    return () => controller.abort();
  }, [client, workItem.id, workItem.resolvedProjectId, workItem.state, workflowAttempt]);

  const proposedPlan = useMemo(
    () => workflow === null ? null : proposedPlanForWorkItem(workflow, workItem.id),
    [workflow, workItem.id],
  );
  const planNodes = useMemo(
    () => proposedPlan === null || workflow === null ? [] : nodesForPlan(workflow, proposedPlan.planRevisionId),
    [proposedPlan, workflow],
  );
  const answerContext = openQuestion === null
    ? null
    : actionErrorContexts.workItemAnswer(workItem.id, openQuestion.id);
  const confirmPlanContext = proposedPlan === null
    ? null
    : actionErrorContexts.workItemConfirmPlan(workItem.id, proposedPlan.planRevisionId);
  async function save(context: string, operation: () => Promise<ActionResult>, onSaved?: () => void) {
    actionErrors.start(context);
    const result = await operation();
    if (result.ok) onSaved?.();
    else actionErrors.fail(context, result.error);
  }

  async function submitCancellation() {
    const reason = cancelReason.trim();
    if (reason.length === 0 || confirmation !== 'cancel') return;
    await save(actionContexts.cancel, () => onCancel(reason), () => {
      setCancelReason('');
      closeConfirmation();
    });
  }

  async function submitRejection() {
    const note = rejectionNote.trim();
    if (note.length === 0 || confirmation !== 'reject' || proposedPlan === null) return;
    await save(actionContexts.rejectPlan, async () => {
      setRejecting(true);
      try {
        await client.rejectWorkflowPlan(proposedPlan.planRevisionId, note);
        return { ok: true };
      } catch (caught) {
        return { ok: false, error: actionErrorMessage(caught) };
      } finally {
        setRejecting(false);
      }
    }, () => {
      setRejectionNote('');
      closeConfirmation();
      setWorkflowAttempt((value) => value + 1);
    });
  }

  function confirmationContext(next: typeof confirmation): string | null {
    if (next === 'reject') return actionContexts.rejectPlan;
    if (next === 'cancel') return actionContexts.cancel;
    if (next === 'archive') return actionContexts.archive;
    return null;
  }

  function openConfirmation(next: Exclude<typeof confirmation, null>) {
    actionErrors.dismiss(confirmationContext(next)!);
    if (next === 'cancel') setCancelReason('');
    if (next === 'reject') setRejectionNote('');
    setConfirmation(next);
  }

  function closeConfirmation() {
    const context = confirmationContext(confirmation);
    if (context !== null) actionErrors.dismiss(context);
    setConfirmation(null);
  }

  return (
    <>
      <div role="region" aria-labelledby={detailHeadingId}>
        <Card className="overflow-hidden" as="article">
        <header className="border-b border-line px-4 py-5 sm:px-5">
          <div className="flex items-start justify-between gap-4">
            <div role="group" aria-label="Current status">
              <p className="mb-1.5 text-xs font-medium text-muted">Current status</p>
              <Pill tone={workItemStateTone[workItem.state]} dot>{workItemStatusLabel(workItem)}</Pill>
            </div>
            <button
              type="button"
              className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-muted-surface hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover"
              onClick={onClose}
              aria-label="Close work-item details"
            >
              <X size={18} />
            </button>
          </div>
          <h2 ref={detailHeadingRef} id={detailHeadingId} tabIndex={-1} className="mt-4 break-words font-display text-xl font-light tracking-[0.01em] text-ink">Work-item details</h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-muted">Resolved project</dt>
              <dd className="mt-1 break-words text-ink">{projectName ?? (workItem.resolvedProjectId === null ? 'Not resolved yet' : workItem.resolvedProjectId)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted">Planning task</dt>
              <dd className="mt-1 flex flex-wrap items-center gap-2 text-ink">
                <span className="break-words">{planningTask?.title ?? 'Not linked yet'}</span>
                {planningTask ? <Pill>{planningTask.status === 'unrecognized' ? unknownStateLabel : prettyStatus(planningTask.status)}</Pill> : null}
              </dd>
            </div>
          </dl>
        </header>

        <StatusTimeline workItem={workItem} />

        <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="original-request-heading">
          <h3 id="original-request-heading" className="text-xs font-semibold text-ink">Original request</h3>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink">{workItem.originalRequest}</p>
        </section>

        {workItem.cancelledReason !== null ? (
          <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="cancellation-reason-heading">
            <h3 id="cancellation-reason-heading" className="text-xs font-semibold text-ink">Cancellation reason</h3>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink">{workItem.cancelledReason}</p>
          </section>
        ) : null}

        {workItem.state === 'parked' && openQuestion !== null ? (
          <form
            className="border-b border-caution-fill/30 bg-caution-soft/55 px-4 py-4 sm:px-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (answer.trim().length === 0) return;
              void save(actionErrorContexts.workItemAnswer(workItem.id, openQuestion.id), () => onAnswer(openQuestion.id, answer.trim()), () => setAnswer(''));
            }}
          >
            <div className="flex items-center gap-2 text-caution">
              <HelpCircle size={17} />
              <h3 className="text-xs font-semibold">Planning needs your input</h3>
            </div>
            {affordances.answerQuestion ? (
              <>
                <p className="mt-3 whitespace-pre-wrap text-sm font-medium leading-6 text-ink">{openQuestion.prompt}</p>
                <div className="mt-3">
                  <FieldLabel htmlFor={`work-item-answer-${workItem.id}`}>Your answer</FieldLabel>
                  <textarea
                    id={`work-item-answer-${workItem.id}`}
                    className={cn(inputClass, 'min-h-24 resize-y py-3')}
                    placeholder="Give the missing context…"
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                  />
                </div>
                <Button className="mt-3 w-full" type="submit" variant="primary" icon={<Send size={16} />} disabled={busy || answer.trim().length === 0}>
                  Answer and resume planning
                </Button>
              </>
            ) : (
              <div className="mt-3 rounded-md border border-line bg-card px-3.5 py-3 text-sm text-muted">
                The linked planning task has not published an open question. Refresh to check for its latest state.
              </div>
            )}
          </form>
        ) : workItem.state === 'parked' ? (
          <section className="border-b border-line px-4 py-4 sm:px-5">
            <div className="rounded-md border border-line bg-muted-surface px-3.5 py-3 text-sm text-muted" role="status">
              Parked — no open question. Retry or reassign from the task view.
            </div>
          </section>
        ) : null}

        {workItem.state === 'plan_approval' ? (
          <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="proposed-plan-heading">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 id="proposed-plan-heading" className="text-xs font-semibold text-ink">Proposed plan</h3>
                <p className="mt-1 text-xs leading-5 text-muted">Review the stages and dependencies before workflow execution begins.</p>
              </div>
              {workflowState === 'error' ? <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => setWorkflowAttempt((value) => value + 1)}>Retry</Button> : null}
            </div>
            {workflowState === 'loading' ? (
              <div className="mt-4 flex min-h-28 items-center justify-center gap-2 rounded-md border border-line bg-muted-surface text-sm text-muted" role="status">
                <RefreshCw size={16} className="animate-spin" /> Loading proposed plan…
              </div>
            ) : workflowState === 'error' ? (
              <div className="mt-4 rounded-md border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent" role="alert">
                {workflowError ?? 'The proposed plan could not be loaded.'}
              </div>
            ) : workflowState === 'ready' && proposedPlan === null ? (
              <div className="mt-4 flex min-h-28 flex-col items-center justify-center rounded-md border border-line bg-muted-surface px-5 text-center">
                <CirclePause size={18} className="text-muted" />
                <p className="mt-2 text-sm font-medium text-ink">No proposed plan</p>
                <p className="mt-1 text-xs leading-5 text-muted">The workflow snapshot has no proposed revision for this work item.</p>
              </div>
            ) : proposedPlan ? (
              <div className="mt-4">
                <PlanRecordDetails plan={proposedPlan} />
                {planNodes.length > 0 ? <ol className="mt-3 space-y-3">{planNodes.map((node) => <WorkflowNodeCard key={node.nodeId} node={node} allNodes={planNodes} />)}</ol> : <p className="mt-3 rounded-md border border-line bg-muted-surface p-3.5 text-sm text-muted">This proposed plan contains no work nodes.</p>}
                <PlanApprovalActions
                  plan={proposedPlan}
                  busy={busy || rejecting}
                  confirmEnabled={affordances.confirmPlan}
                  rejectEnabled={affordances.rejectPlan}
                  onConfirm={() => { void save(actionErrorContexts.workItemConfirmPlan(workItem.id, proposedPlan.planRevisionId), () => onConfirm(proposedPlan.planRevisionId)); }}
                  onReject={() => openConfirmation('reject')}
                />
              </div>
            ) : workflowState === 'idle' ? (
              <div className="mt-4 rounded-md border border-line bg-muted-surface px-3.5 py-3 text-sm text-muted">
                The resolved project is unavailable, so the plan cannot be loaded.
              </div>
            ) : null}
          </section>
        ) : null}

        <InlineActionErrors
          className={actionErrors.errors.some((entry) => entry.context === answerContext || entry.context === confirmPlanContext) ? 'border-b border-line px-4 py-3 sm:px-5' : undefined}
          errors={actionErrors.errors.filter((entry) => entry.context === answerContext || entry.context === confirmPlanContext)}
          onDismiss={actionErrors.dismiss}
        />

        {affordances.cancel || affordances.archive ? (
          <footer className="flex flex-wrap justify-end gap-2 px-4 py-4 sm:px-5">
            {affordances.cancel ? <Button variant="danger" disabled={busy} onClick={() => openConfirmation('cancel')}>Cancel work item</Button> : null}
            {affordances.archive ? <Button icon={<Archive size={15} />} disabled={busy} onClick={() => openConfirmation('archive')}>Archive</Button> : null}
          </footer>
        ) : null}
        </Card>
      </div>

      <Modal
        open={confirmation === 'cancel'}
        onClose={closeConfirmation}
        isDirty={() => fieldsAreDirty([cancelReason])}
        title="Cancel work item"
        description="This stops the intake and its live planning task. This action cannot be undone."
      >
        {(requestClose) => <form className="space-y-4 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); void submitCancellation(); }}>
          <div>
            <FieldLabel htmlFor={`work-item-cancel-reason-${workItem.id}`}>Reason</FieldLabel>
            <textarea
              id={`work-item-cancel-reason-${workItem.id}`}
              className={cn(inputClass, 'min-h-24 resize-y py-3')}
              autoFocus
              required
              maxLength={16_000}
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              placeholder="Why is this work item being cancelled?"
            />
          </div>
          <InlineActionErrors errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.cancel)} onDismiss={actionErrors.dismiss} />
          <div className="grid gap-2 sm:grid-cols-2">
            <Button type="submit" variant="danger" disabled={busy || cancelReason.trim().length === 0}>Cancel work item</Button>
            <Button disabled={busy} onClick={requestClose}>Keep work item</Button>
          </div>
        </form>}
      </Modal>

      <Modal
        open={confirmation === 'reject'}
        onClose={closeConfirmation}
        isDirty={() => fieldsAreDirty([rejectionNote])}
        title="Reject proposed plan"
        description="Send one bounded revision note back to planning. Rejecting a second proposed revision parks the work item."
      >
        {(requestClose) => <PlanRejectionForm
          workItemId={workItem.id}
          note={rejectionNote}
          busy={busy || rejecting}
          errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.rejectPlan)}
          onNoteChange={setRejectionNote}
          onDismissError={actionErrors.dismiss}
          onSubmit={() => { void submitRejection(); }}
          onKeep={requestClose}
        />}
      </Modal>

      <Modal
        open={confirmation === 'archive'}
        onClose={closeConfirmation}
        title="Archive work item"
        description="Archived work items leave the default intake list but remain stored and retrievable."
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 sm:p-6">
          <Button variant="primary" icon={<Archive size={15} />} disabled={busy} onClick={() => void save(actionContexts.archive, onArchive, closeConfirmation)}>Archive work item</Button>
          <Button disabled={busy} onClick={closeConfirmation}>Keep visible</Button>
          <InlineActionErrors className="sm:col-span-2" errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.archive)} onDismiss={actionErrors.dismiss} />
        </div>
      </Modal>
    </>
  );
}
