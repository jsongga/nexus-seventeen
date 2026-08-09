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
import { Button, Card, FieldLabel, Modal, Pill, cn, inputClass } from '../../components/ui';
import type { TaskBoardClient } from '../data/client';
import {
  deriveWorkItemDetailAffordances,
  nodesForPlan,
  proposedPlanForWorkItem,
} from '../model/work-item-detail';
import {
  prettyStatus,
  workItemStateTone,
  workItemStatusLabel,
} from '../model/work-item-labels';
import type {
  BoardQuestion,
  BoardTask,
  BoardWorkItem,
  ProjectWorkflow,
  WorkflowNode,
} from '../types';

export interface WorkItemDetailMutationResult {
  saved: boolean;
  error?: string;
}

interface WorkItemDetailProps {
  workItem: BoardWorkItem;
  projectName: string | null;
  planningTask: BoardTask | null;
  openQuestion: BoardQuestion | null;
  client: TaskBoardClient;
  busy: boolean;
  onClose: () => void;
  onAnswer: (questionId: string, answer: string) => Promise<WorkItemDetailMutationResult>;
  onConfirm: (planRevisionId: string) => Promise<WorkItemDetailMutationResult>;
  onCancel: (reason: string) => Promise<WorkItemDetailMutationResult>;
  onArchive: () => Promise<WorkItemDetailMutationResult>;
}

function StatusTimeline({ workItem }: { workItem: BoardWorkItem }) {
  const position = workItem.state === 'submitted'
    ? 0
    : workItem.state === 'processing'
      ? 1
      : workItem.endedAt === null
        ? 2
        : 3;
  const checkpoint = workItem.state === 'needs_input'
    ? 'Needs input'
    : workItem.state === 'waiting_for_human_review'
      ? 'Plan review'
      : 'Human checkpoint';
  const terminalLabel = workItem.endedAt === null ? 'Terminal' : prettyStatus(workItem.state);
  const steps = ['Submitted', 'Processing', checkpoint, terminalLabel];

  return (
    <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="work-item-timeline-heading">
      <h3 id="work-item-timeline-heading" className="text-xs font-semibold text-ink">Status timeline</h3>
      <ol className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-4 sm:gap-0">
        {steps.map((label, index) => {
          const complete = index < position || (index === 3 && workItem.endedAt !== null);
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
  const [confirmation, setConfirmation] = useState<'cancel' | 'reject' | 'archive' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<ProjectWorkflow | null>(null);
  const [workflowState, setWorkflowState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [workflowAttempt, setWorkflowAttempt] = useState(0);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingId = `work-item-detail-heading-${workItem.id}`;
  const affordances = deriveWorkItemDetailAffordances({
    workItemState: workItem.state,
    planningTaskState: planningTask?.status ?? null,
    archived: workItem.archivedAt !== null,
  });

  useEffect(() => {
    setAnswer('');
    setCancelReason('');
    setConfirmation(null);
    setActionError(null);
  }, [workItem.id]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(max-width: 1279px)').matches) detailHeadingRef.current?.focus();
  }, [workItem.id]);

  useEffect(() => {
    if (workItem.state !== 'waiting_for_human_review' || workItem.resolvedProjectId === null) {
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

  async function save(operation: () => Promise<WorkItemDetailMutationResult>, onSaved?: () => void) {
    setActionError(null);
    const result = await operation();
    if (result.saved) onSaved?.();
    else setActionError(result.error ?? 'The change could not be saved. Refresh and try again.');
  }

  async function submitCancellation() {
    const reason = cancelReason.trim();
    if (reason.length === 0) return;
    await save(() => onCancel(reason), () => {
      setCancelReason('');
      setConfirmation(null);
    });
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
                {planningTask ? <Pill>{prettyStatus(planningTask.status)}</Pill> : null}
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

        {workItem.state === 'needs_input' ? (
          <form
            className="border-b border-caution-fill/30 bg-caution-soft/55 px-4 py-4 sm:px-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!openQuestion || answer.trim().length === 0) return;
              void save(() => onAnswer(openQuestion.id, answer.trim()), () => setAnswer(''));
            }}
          >
            <div className="flex items-center gap-2 text-caution">
              <HelpCircle size={17} />
              <h3 className="text-xs font-semibold">Planning needs your input</h3>
            </div>
            {affordances.answerQuestion && openQuestion ? (
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
        ) : null}

        {workItem.state === 'waiting_for_human_review' ? (
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
                <div className="rounded-md border border-line bg-card p-3.5">
                  <p className="text-sm font-semibold text-ink">{proposedPlan.objective}</p>
                  {proposedPlan.assumptions.length > 0 ? (
                    <div className="mt-3"><p className="text-[11px] font-medium text-muted">Assumptions</p><ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-5 text-ink">{proposedPlan.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></div>
                  ) : null}
                  <div className="mt-3"><p className="text-[11px] font-medium text-muted">Acceptance criteria</p><ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-5 text-ink">{proposedPlan.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></div>
                </div>
                {planNodes.length > 0 ? <ol className="mt-3 space-y-3">{planNodes.map((node) => <WorkflowNodeCard key={node.nodeId} node={node} allNodes={planNodes} />)}</ol> : <p className="mt-3 rounded-md border border-line bg-muted-surface p-3.5 text-sm text-muted">This proposed plan contains no work nodes.</p>}
                {affordances.confirmPlan || affordances.rejectPlan ? (
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    <Button variant="mint" icon={<Check size={16} />} disabled={busy} onClick={() => void save(() => onConfirm(proposedPlan.planRevisionId))}>Confirm plan</Button>
                    <Button variant="danger" icon={<CircleAlert size={16} />} disabled={busy} onClick={() => { setCancelReason(''); setConfirmation('reject'); setActionError(null); }}>Reject plan</Button>
                  </div>
                ) : null}
              </div>
            ) : workflowState === 'idle' ? (
              <div className="mt-4 rounded-md border border-line bg-muted-surface px-3.5 py-3 text-sm text-muted">
                The resolved project is unavailable, so the plan cannot be loaded.
              </div>
            ) : null}
          </section>
        ) : null}

        {actionError ? <div className="border-b border-urgent/20 bg-urgent-soft px-4 py-3 text-sm text-urgent sm:px-5" role="alert">{actionError}</div> : null}

        {affordances.cancel || affordances.archive ? (
          <footer className="flex flex-wrap justify-end gap-2 px-4 py-4 sm:px-5">
            {affordances.cancel ? <Button variant="danger" disabled={busy} onClick={() => { setCancelReason(''); setConfirmation('cancel'); setActionError(null); }}>Cancel work item</Button> : null}
            {affordances.archive ? <Button icon={<Archive size={15} />} disabled={busy} onClick={() => { setConfirmation('archive'); setActionError(null); }}>Archive</Button> : null}
          </footer>
        ) : null}
        </Card>
      </div>

      <Modal
        open={confirmation === 'cancel' || confirmation === 'reject'}
        onClose={() => setConfirmation(null)}
        title={confirmation === 'reject' ? 'Reject proposed plan' : 'Cancel work item'}
        description={confirmation === 'reject'
          ? 'Rejecting the plan cancels this work item and records your reason on its planning task.'
          : 'This stops the intake and its live planning task. This action cannot be undone.'}
      >
        <form className="space-y-4 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); void submitCancellation(); }}>
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
              placeholder={confirmation === 'reject' ? 'What must change before this can proceed?' : 'Why is this work item being cancelled?'}
            />
          </div>
          {actionError ? <div className="rounded-md border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent" role="alert">{actionError}</div> : null}
          <div className="grid gap-2 sm:grid-cols-2">
            <Button type="submit" variant="danger" disabled={busy || cancelReason.trim().length === 0}>{confirmation === 'reject' ? 'Reject and cancel' : 'Cancel work item'}</Button>
            <Button disabled={busy} onClick={() => setConfirmation(null)}>Keep work item</Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={confirmation === 'archive'}
        onClose={() => setConfirmation(null)}
        title="Archive work item"
        description="Archived work items leave the default intake list but remain stored and retrievable."
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 sm:p-6">
          <Button variant="primary" icon={<Archive size={15} />} disabled={busy} onClick={() => void save(onArchive, () => setConfirmation(null))}>Archive work item</Button>
          <Button disabled={busy} onClick={() => setConfirmation(null)}>Keep visible</Button>
          {actionError ? <div className="rounded-md border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent sm:col-span-2" role="alert">{actionError}</div> : null}
        </div>
      </Modal>
    </>
  );
}
