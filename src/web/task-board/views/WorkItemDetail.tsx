import { Archive, ArrowRight, Check, CircleAlert, CirclePause, HelpCircle, RefreshCw, Send, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { DesignRecordDraft, PipelineSummary, ReviewFinding } from "@shared/task-board-contract";
import { Button, Card, FieldLabel, InlineActionErrors, Modal, Pill, cn, inputClass } from "../../components/ui";
import { fieldsAreDirty } from "../../components/dialog-stack";
import { BoardApiError, type TaskBoardClient } from "../data/client";
import type { RawWorkItemAudit } from "../data/parse";
import {
  deriveWorkItemDetailAffordances,
  contractApprovalIsReady,
  contractDependencyStatuses,
  deriveDecompositionAffordances,
  nodesForPlan,
  pipelineAssumptionReview,
  pipelineFindingRounds,
  pipelineFileReview,
  proposedPlanForWorkItem,
  type ContractDependencyStatus,
  type DetailedWorkflowPlan,
} from "../model/work-item-detail";
import { elapsedMilliseconds, formatElapsedDuration } from "../model/observability";
import {
  prettyStatus,
  unknownStateLabel,
  workItemStateLabel,
  workItemStateTone,
  workItemStatusLabel,
} from "../model/work-item-labels";
import { actionErrorContexts, useActionErrors, type ActionErrorState, type ActionResult } from "../model/action-errors";
import type {
  BoardChildWorkItem,
  BoardProject,
  BoardQuestion,
  BoardTask,
  BoardWorkItem,
  BoardWorkItemDependency,
  BoardWorkItemTransition,
  ProjectWorkflow,
  WorkflowNode,
} from "../types";

export interface InitialWorkItemFamily {
  state: "ready" | "error";
  children: readonly BoardChildWorkItem[];
  dependencies: readonly BoardWorkItemDependency[];
  error: string | null;
  status?: number;
}

interface WorkItemDetailProps {
  workItem: BoardWorkItem;
  snapshotRevision: number;
  familyVersionKey?: string;
  familyRefreshRevision?: number;
  knownParent?: boolean;
  initialFamily?: InitialWorkItemFamily;
  projectName: string | null;
  projects: readonly BoardProject[];
  parentWorkItem: BoardWorkItem | null;
  planningTask: BoardTask | null;
  openQuestion: BoardQuestion | null;
  client: TaskBoardClient;
  busy: boolean;
  onClose: () => void;
  onOpenWorkItem?: (workItemId: string) => void;
  onAnswer: (questionId: string, answer: string) => Promise<ActionResult>;
  onConfirm: (planRevisionId: string) => Promise<ActionResult>;
  onReject?: (planRevisionId: string, note: string) => Promise<ActionResult>;
  onApproveMerge?: () => Promise<ActionResult>;
  onRejectFinal?: (note: string) => Promise<ActionResult>;
  onAttestDeploy: (workItemId: string, note?: string) => Promise<ActionResult>;
  onResumeCoordination: () => Promise<ActionResult>;
  onCancel: (reason: string) => Promise<ActionResult>;
  onArchive: () => Promise<ActionResult>;
}

export function GapReportSection({
  state,
  content,
  error,
  onRetry,
}: {
  state: "loading" | "ready" | "error";
  content: string | null;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="onboarding-gap-report-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="onboarding-gap-report-heading" className="text-xs font-semibold text-ink">
            Gap report
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Items the onboarding pass could not complete automatically.
          </p>
        </div>
        {state === "error" ? (
          <Button size="sm" icon={<RefreshCw size={14} />} onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
      {state === "loading" ? (
        <div
          className="mt-3 flex min-h-20 items-center justify-center gap-2 rounded-md border border-line bg-muted-surface text-sm text-muted"
          role="status"
        >
          <RefreshCw size={15} className="animate-spin" aria-hidden="true" /> Loading gap report…
        </div>
      ) : state === "error" ? (
        <p
          className="mt-3 rounded-md border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent"
          role="alert"
        >
          {error ?? "The gap report could not be loaded."}
        </p>
      ) : content === null ? (
        <p className="mt-3 rounded-md border border-line bg-muted-surface px-3.5 py-3 text-sm text-muted">
          No gap report has been recorded yet.
        </p>
      ) : (
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-muted-surface px-3.5 py-3 font-mono text-xs leading-6 text-ink">
          {content}
        </pre>
      )}
    </section>
  );
}

export function familyNotParentAfterSnapshot(current: boolean, knownParent: boolean): boolean {
  return knownParent ? false : current;
}

export function ParentWorkItemLink({
  parentWorkItemId,
  parentWorkItem,
  onOpenWorkItem,
}: {
  parentWorkItemId: string;
  parentWorkItem: BoardWorkItem | null;
  onOpenWorkItem?: (workItemId: string) => void;
}) {
  const label = parentWorkItem?.refinedObjective?.trim() || parentWorkItem?.originalRequest || parentWorkItemId;
  const className =
    "break-words text-ink underline decoration-line underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover";
  return onOpenWorkItem === undefined ? (
    <a className={className} href={`#/intake/${encodeURIComponent(parentWorkItemId)}`}>
      {label}
    </a>
  ) : (
    <button
      type="button"
      className={`${className} text-left`}
      data-detail-source="work-item-id"
      onClick={() => onOpenWorkItem(parentWorkItemId)}
    >
      {label}
    </button>
  );
}

const auditDateTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

function AuditTimestamp({ value }: { value: string }) {
  const parsed = new Date(value);
  return <time dateTime={value}>{Number.isNaN(parsed.valueOf()) ? value : auditDateTime.format(parsed)}</time>;
}

export function StatusTimeline({
  workItem,
  transitions,
  state = "ready",
  nowMs = Date.now(),
}: {
  workItem: BoardWorkItem;
  transitions: readonly BoardWorkItemTransition[];
  state?: "loading" | "ready" | "error";
  nowMs?: number;
}) {
  const ordered = [...transitions].sort((left, right) => left.createdAtMs - right.createdAtMs);
  const firstTransition = ordered[0];
  const timelineEndMs = workItem.endedAtMs ?? nowMs;
  const total =
    firstTransition === undefined
      ? null
      : formatElapsedDuration(elapsedMilliseconds(firstTransition.createdAtMs, timelineEndMs));

  return (
    <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="work-item-timeline-heading">
      <div className="flex items-center justify-between gap-3">
        <h3 id="work-item-timeline-heading" className="text-xs font-semibold text-ink">
          Status timeline
        </h3>
        {total === null ? null : <span className="font-mono text-[11px] text-muted">Total {total}</span>}
      </div>
      {state === "loading" ? (
        <p className="mt-3 text-xs text-muted" role="status">
          Loading transition history…
        </p>
      ) : state === "error" ? (
        <p className="mt-3 text-xs text-muted">Transition history is unavailable.</p>
      ) : ordered.length === 0 ? (
        <p className="mt-3 text-xs text-muted">No state transitions were recorded.</p>
      ) : (
        <ol className="mt-3 divide-y divide-line rounded-md border border-line">
          {ordered.map((transition, index) => {
            const next = ordered[index + 1];
            const endMs = next?.createdAtMs ?? timelineEndMs;
            const elapsed = formatElapsedDuration(elapsedMilliseconds(transition.createdAtMs, endMs));
            return (
              <li
                key={`${transition.createdAt}-${index}`}
                className="grid gap-2 px-3 py-3 text-xs sm:grid-cols-[minmax(120px,.7fr)_minmax(160px,1fr)_auto] sm:items-center"
              >
                <div>
                  <p className="font-medium text-ink">{workItemStateLabel[transition.toState]}</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    <AuditTimestamp value={transition.createdAt} />
                  </p>
                </div>
                <p className="break-words text-muted">
                  <span className="capitalize">{transition.actorType}</span> · {transition.actorId}
                </p>
                <p className="font-mono text-[11px] text-ink">{elapsed}</p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function AuditArtifactReferences({ action }: { action: RawWorkItemAudit["gateActions"][number] }) {
  const references = [
    action.planRevisionId === null ? null : (
      <span key="plan">
        Plan <code className="font-mono text-[11px]">{action.planRevisionId}</code>
      </span>
    ),
    action.verifiedSha === null ? null : (
      <span key="verified">
        Verified <code className="font-mono text-[11px]">{action.verifiedSha.slice(0, 10)}</code>
      </span>
    ),
    action.mergeSha === null ? null : (
      <span key="merge">
        Merge <code className="font-mono text-[11px]">{action.mergeSha.slice(0, 10)}</code>
      </span>
    ),
    action.refId === null ? null : (
      <span key="ref">
        Ref <code className="font-mono text-[11px]">{action.refId}</code>
      </span>
    ),
  ].filter((reference) => reference !== null);
  return references.length === 0 ? (
    <span className="text-muted">—</span>
  ) : (
    <div className="flex min-w-48 flex-col gap-1 text-ink">{references}</div>
  );
}

export function AuditSection({ audit }: { audit: RawWorkItemAudit }) {
  return (
    <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="work-item-audit-heading">
      <h3 id="work-item-audit-heading" className="text-xs font-semibold text-ink">
        Audit
      </h3>
      {audit.gateActions.length === 0 ? (
        <p className="mt-2 text-xs text-muted">No gate actions were recorded.</p>
      ) : (
        <div className="mt-3 max-w-full overflow-x-auto rounded-md border border-line">
          <table className="w-max min-w-full border-collapse text-left text-xs">
            <thead className="bg-muted-surface text-[11px] text-muted">
              <tr>
                {["Gate", "Actor", "Artifact references", "Note", "Timestamp"].map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="whitespace-nowrap border-b border-line px-3 py-2 font-medium"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {audit.gateActions.map((action) => (
                <tr key={action.gateActionId} className="align-top">
                  <td className="whitespace-nowrap px-3 py-3 font-medium capitalize text-ink">
                    {prettyStatus(action.gate)}
                  </td>
                  <td className="min-w-36 break-words px-3 py-3 text-ink">{action.actorId}</td>
                  <td className="px-3 py-3">
                    <AuditArtifactReferences action={action} />
                  </td>
                  <td className="min-w-52 whitespace-pre-wrap break-words px-3 py-3 leading-5 text-ink">
                    {action.note ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-muted">
                    <AuditTimestamp value={action.createdAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
              ? "Starts without another node."
              : node.dependencyNodeIds.map((dependencyId) => titles.get(dependencyId) ?? dependencyId).join(", ")}
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
      {items.length > 0 ? (
        <ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-5 text-ink">
          {items.map((item, index) => (
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs leading-5 text-muted">None declared.</p>
      )}
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
            {plan.tier === undefined ? null : (
              <Pill tone={plan.tier === "hazardous" ? "red" : "green"}>{planValueLabel(plan.tier)}</Pill>
            )}
          </div>
        ) : null}
      </div>
      {plan.assumptions.length > 0 ? <PlanListSection title="Assumptions" items={plan.assumptions} /> : null}
      <PlanListSection title="Acceptance criteria" items={plan.acceptanceCriteria} />
      {plan.declaredScope === undefined ? null : <PlanListSection title="Declared scope" items={plan.declaredScope} />}
      {plan.nonGoals === undefined ? null : <PlanListSection title="Non-goals" items={plan.nonGoals} />}
      {plan.mechanicalPortions === undefined ? null : (
        <PlanListSection title="Mechanical portions" items={plan.mechanicalPortions} />
      )}
      {plan.blockingQuestions === undefined ? null : (
        <div className="mt-3">
          <p className="text-[11px] font-medium text-muted">Blocking questions</p>
          {plan.blockingQuestions.length > 0 ? (
            <ol className="mt-1.5 space-y-2">
              {plan.blockingQuestions.map((question, index) => (
                <li
                  key={`${index}-${question.question}`}
                  className="rounded-md border border-line bg-muted-surface px-3 py-2.5"
                >
                  <p className="text-xs font-medium leading-5 text-ink">{question.question}</p>
                  <p className="mt-1 text-[11px] font-medium text-muted">Recommended default</p>
                  <p className="mt-0.5 text-xs leading-5 text-ink">{question.recommendedDefault}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-1 text-xs leading-5 text-muted">None declared.</p>
          )}
        </div>
      )}
      {plan.criterionChecks === undefined ? null : (
        <div className="mt-3">
          <p className="text-[11px] font-medium text-muted">Criterion checks</p>
          {plan.criterionChecks.length > 0 ? (
            <dl className="mt-1.5 space-y-2">
              {plan.criterionChecks.map((criterion, index) => (
                <div
                  key={`${index}-${criterion.criterion}`}
                  className="rounded-md border border-line bg-muted-surface px-3 py-2.5"
                >
                  <dt className="text-xs font-medium leading-5 text-ink">{criterion.criterion}</dt>
                  <dd className="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-5 text-muted">
                    {criterion.check}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-1 text-xs leading-5 text-muted">None declared.</p>
          )}
        </div>
      )}
      {plan.children === null || plan.children.length === 0 ? null : (
        <div className="mt-3">
          <p className="text-[11px] font-medium text-muted">Declared children</p>
          <ol className="mt-1.5 space-y-2">
            {plan.children.map((child, index) => {
              const phase =
                child.phase === undefined
                  ? null
                  : child.phase === "unrecognized"
                    ? unknownStateLabel
                    : planValueLabel(child.phase);
              return (
                <li key={child.key} className="rounded-md border border-line bg-muted-surface px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[11px] text-muted">{index + 1}</span>
                    {phase === null ? null : <Pill tone="purple">{phase}</Pill>}
                    <span className="text-[11px] text-muted">{child.projectId}</span>
                  </div>
                  <p className="mt-1 text-xs font-medium leading-5 text-ink">{child.objective}</p>
                  <PlanListSection title="Declared scope" items={child.declaredScope} />
                  <PlanListSection title="Acceptance criteria" items={child.acceptanceCriteria} />
                  <p className="mt-1 text-[11px] leading-5 text-muted">
                    {child.dependsOn === undefined || child.dependsOn.length === 0
                      ? "No declared dependency."
                      : `After ${child.dependsOn.join(", ")}`}
                  </p>
                </li>
              );
            })}
          </ol>
          {plan.children.some((child) => child.phase !== undefined) ? (
            <p className="mt-3 rounded-md border border-caution/30 bg-caution-soft px-3.5 py-3 text-xs leading-5 text-caution">
              Expand and Migrate children merge automatically once verified and reviewed; Contract requires your
              approval after deployment is attested
            </p>
          ) : null}
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
      {plan.tier === "hazardous" ? (
        <div
          className="mb-3 rounded-md border border-caution/30 bg-caution-soft px-3.5 py-3 text-sm leading-6 text-caution"
          role="alert"
        >
          <p className="font-medium">Hazardous tier: confirming enters the Design stage before implementation.</p>
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {confirmEnabled ? (
          <Button variant="mint" icon={<Check size={16} />} disabled={busy} onClick={onConfirm}>
            Confirm plan
          </Button>
        ) : null}
        {rejectEnabled ? (
          <Button variant="danger" icon={<CircleAlert size={16} />} disabled={busy} onClick={onReject}>
            Reject plan
          </Button>
        ) : null}
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
    <form
      className="space-y-4 p-5 sm:p-6"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div>
        <FieldLabel htmlFor={`work-item-rejection-note-${workItemId}`}>Revision note</FieldLabel>
        <textarea
          id={`work-item-rejection-note-${workItemId}`}
          className={cn(inputClass, "min-h-24 resize-y py-3")}
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
        <Button type="submit" variant="danger" disabled={busy || note.trim().length === 0}>
          Reject and revise
        </Button>
        <Button disabled={busy} onClick={onKeep}>
          Keep proposed plan
        </Button>
      </div>
    </form>
  );
}

export function ReviewFindingsPanel({ findings }: { findings: readonly ReviewFinding[] }) {
  const rounds = pipelineFindingRounds(findings);
  return (
    <div className="rounded-md border border-line bg-card p-3.5">
      <h4 className="text-xs font-semibold text-ink">Review findings</h4>
      {rounds.length === 0 ? (
        <p className="mt-2 text-xs text-muted">No review findings were recorded.</p>
      ) : (
        <div className="mt-3 space-y-4">
          {rounds.map((round) => (
            <section key={round.round} aria-labelledby={`review-findings-round-${round.round}`}>
              <h5
                id={`review-findings-round-${round.round}`}
                className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted"
              >
                Round {round.round}
              </h5>
              <ol className="mt-2 space-y-2">
                {round.findings.map((finding) => {
                  const location = finding.file
                    ? `${finding.file}${finding.line === undefined || finding.line === null ? "" : `:${finding.line}`}`
                    : finding.line === undefined || finding.line === null
                      ? null
                      : `Line ${finding.line}`;
                  return (
                    <li key={finding.findingId} className="rounded-md border border-line bg-muted-surface p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {finding.blocking ? (
                            <Pill tone="red">
                              Blocking · {prettyStatus(finding.category)} · {prettyStatus(finding.severity)}
                            </Pill>
                          ) : (
                            <Pill>
                              {prettyStatus(finding.category)} · {prettyStatus(finding.severity)}
                            </Pill>
                          )}
                          <Pill>{prettyStatus(finding.stage)}</Pill>
                        </div>
                        {location === null ? null : (
                          <code className="break-all font-mono text-[11px] leading-5 text-muted">{location}</code>
                        )}
                      </div>
                      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                        <div>
                          <dt className="text-[11px] font-medium text-muted">Expected</dt>
                          <dd className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-5 text-ink">
                            {finding.expected}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[11px] font-medium text-muted">Actual</dt>
                          <dd className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-5 text-ink">
                            {finding.actual}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function phaseDisplayLabel(phase: BoardWorkItem["phase"]): string {
  if (phase === null) return "Unphased";
  if (phase === "unrecognized") return unknownStateLabel;
  return planValueLabel(phase);
}

function childAttestationLabel(child: BoardChildWorkItem): string {
  if (child.deployAttested) return "Attested";
  if (child.phase !== "expand" && child.phase !== "migrate") return "Not required";
  return child.state === "merged" ? "Not attested" : "Waiting for merge";
}

export function ChildrenSection({
  children,
  projects,
  state,
  error,
  onRetry,
  onOpenChild,
  onAttestChild,
  attestationBusy = false,
}: {
  children: readonly BoardChildWorkItem[];
  projects: readonly BoardProject[];
  state: "loading" | "ready" | "error";
  error: string | null;
  onRetry: () => void;
  onOpenChild?: (workItemId: string) => void;
  onAttestChild?: (workItemId: string, anchor: HTMLButtonElement) => void;
  attestationBusy?: boolean;
}) {
  if (children.length === 0 && state !== "error") return null;
  const projectNames = new Map(projects.map((project) => [project.id, project.name] as const));
  const loadError = error === null ? "Children could not be loaded." : `Children could not be loaded. ${error}`;
  return (
    <section
      className="min-w-0 max-w-full border-b border-line px-4 py-4 sm:px-5"
      aria-labelledby="work-item-children-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="work-item-children-heading" className="text-xs font-semibold text-ink">
            Children
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Declared merge order and deployment readiness for this coordination family.
          </p>
        </div>
        {state === "error" || error !== null ? (
          <Button size="sm" icon={<RefreshCw size={14} />} onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
      {state === "ready" && error !== null ? (
        <p className="mt-3 text-xs text-urgent" role="alert">
          {loadError} The last loaded children remain visible.
        </p>
      ) : null}
      {state === "loading" ? (
        <div
          className="mt-3 flex min-h-24 items-center justify-center gap-2 rounded-md border border-line bg-muted-surface text-sm text-muted"
          role="status"
        >
          <RefreshCw size={15} className="animate-spin" aria-hidden="true" /> Loading children…
        </div>
      ) : state === "error" ? (
        <p
          className="mt-3 rounded-md border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent"
          role="alert"
        >
          {loadError}
        </p>
      ) : children.length === 0 ? (
        <p className="mt-3 rounded-md border border-line bg-muted-surface px-3.5 py-3 text-sm text-muted">
          No materialized children.
        </p>
      ) : (
        <div className="mt-3 max-w-full overflow-x-auto rounded-md border border-line">
          <table className="w-max min-w-full border-collapse text-left text-xs">
            <thead className="bg-muted-surface text-[11px] text-muted">
              <tr>
                {["Ordinal", "Phase", "Project", "State", "Attestation", "Actions"].map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="whitespace-nowrap border-b border-line px-3 py-2 font-medium"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {children.map((child, index) => (
                <tr key={child.id} className="align-middle">
                  <td className="px-3 py-3 font-mono text-[11px] text-ink">
                    {child.childOrdinal === null ? index + 1 : child.childOrdinal + 1}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3">
                    <Pill tone="purple">{phaseDisplayLabel(child.phase)}</Pill>
                  </td>
                  <td className="min-w-36 break-words px-3 py-3 text-ink">
                    {child.resolvedProjectId === null
                      ? "Unresolved"
                      : (projectNames.get(child.resolvedProjectId) ?? child.resolvedProjectId)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3">
                    <Pill tone={workItemStateTone[child.state]} dot>
                      {workItemStatusLabel(child)}
                    </Pill>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-ink">{childAttestationLabel(child)}</td>
                  <td className="whitespace-nowrap px-3 py-3">
                    <div className="flex items-center gap-2">
                      <a
                        className="text-ink underline decoration-line underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover"
                        data-detail-source="work-item-id"
                        href={`#/intake/${encodeURIComponent(child.id)}`}
                        onClick={
                          onOpenChild === undefined
                            ? undefined
                            : (event) => {
                                event.preventDefault();
                                onOpenChild(child.id);
                              }
                        }
                      >
                        Open child
                      </a>
                      {onAttestChild !== undefined &&
                      (child.phase === "expand" || child.phase === "migrate") &&
                      child.state === "merged" &&
                      !child.deployAttested ? (
                        <Button
                          size="sm"
                          variant="mint"
                          disabled={attestationBusy}
                          onClick={(event) => onAttestChild(child.id, event.currentTarget)}
                        >
                          Attest deployed
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function ContractAttestationGate({
  statuses,
  phase,
  state,
  error,
  onRetry,
}: {
  statuses: readonly ContractDependencyStatus[];
  phase: BoardWorkItem["phase"];
  state: "loading" | "ready" | "error";
  error: string | null;
  onRetry: () => void;
}) {
  const ready = contractApprovalIsReady(phase, state, statuses);
  return (
    <section
      className="mt-4 rounded-md border border-line bg-card p-3.5"
      aria-labelledby="contract-attestation-heading"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="contract-attestation-heading" className="text-xs font-semibold text-ink">
          Deployment attestations
        </h4>
        <div className="flex items-center gap-2">
          <Pill tone={ready ? "green" : "amber"}>{ready ? "Ready" : "Blocked"}</Pill>
          {state === "error" || error !== null ? (
            <Button size="sm" icon={<RefreshCw size={14} />} onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      </div>
      <p className="mt-1 text-xs leading-5 text-muted">
        Contract approval requires every Expand and Migrate sibling to be merged and deployment-attested.
      </p>
      {state === "ready" && error !== null ? (
        <p className="mt-3 text-xs text-urgent" role="alert">
          {error} The last loaded attestation status remains visible.
        </p>
      ) : null}
      {state === "loading" ? (
        <p className="mt-3 text-xs text-muted" role="status">
          Loading dependency attestations…
        </p>
      ) : state === "error" ? (
        <p className="mt-3 text-xs text-urgent" role="alert">
          {error ?? "Attestation status is unavailable. Approval stays disabled."}
        </p>
      ) : statuses.length === 0 ? (
        <p className="mt-3 text-xs text-muted">No dependency status is available. Approval stays disabled.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line rounded-md border border-line">
          {statuses.map(({ child, direct, ready: childReady }) => (
            <li key={child.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-xs">
              <span className="min-w-0 break-words text-ink">
                {phaseDisplayLabel(child.phase)} · {child.refinedObjective?.trim() || child.originalRequest}
                {direct ? <span className="ml-1 text-[11px] text-muted">Direct dependency</span> : null}
              </span>
              <Pill tone={childReady ? "green" : "amber"}>
                {childReady ? "Attested" : child.state === "merged" ? "Not attested" : "Not merged"}
              </Pill>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AttestDeploymentForm({
  workItemId,
  note,
  busy,
  errors,
  onNoteChange,
  onDismissError,
  onSubmit,
  onCancel,
}: {
  workItemId: string;
  note: string;
  busy: boolean;
  errors: ActionErrorState;
  onNoteChange: (note: string) => void;
  onDismissError: (context: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="space-y-4 p-5 sm:p-6"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel htmlFor={`work-item-attestation-note-${workItemId}`}>Note</FieldLabel>
          <span id={`work-item-attestation-note-help-${workItemId}`} className="text-[11px] text-muted">
            Optional
          </span>
        </div>
        <textarea
          id={`work-item-attestation-note-${workItemId}`}
          className={cn(inputClass, "min-h-24 resize-y py-3")}
          data-dialog-initial-focus
          aria-describedby={`work-item-attestation-note-help-${workItemId}`}
          maxLength={2_000}
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder="Deployment environment or evidence"
        />
      </div>
      <InlineActionErrors errors={errors} onDismiss={onDismissError} />
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="submit" variant="mint" disabled={busy}>
          Attest deployed
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DesignTable({
  title,
  headers,
  rows,
}: {
  title: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}) {
  return (
    <div className="mt-3">
      <h5 className="text-[11px] font-medium text-muted">{title}</h5>
      {rows.length === 0 ? (
        <p className="mt-1 text-xs leading-5 text-muted">None recorded.</p>
      ) : (
        <div className="mt-1.5 max-w-full overflow-x-auto rounded-md border border-line">
          <table className="w-max min-w-full border-collapse text-left text-xs">
            <thead className="bg-muted-surface text-[11px] text-muted">
              <tr>
                {headers.map((header) => (
                  <th key={header} scope="col" className="whitespace-nowrap border-b border-line px-3 py-2 font-medium">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row, rowIndex) => (
                <tr key={`${rowIndex}-${row.join("-")}`} className="align-top">
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${cellIndex}-${cell}`}
                      className="min-w-32 whitespace-pre-wrap break-words px-3 py-2 leading-5 text-ink"
                    >
                      {cell || "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function DesignRecordDetails({ designRecord }: { designRecord: DesignRecordDraft }) {
  return (
    <div className="rounded-md border border-line bg-card p-3.5">
      <h4 className="text-xs font-semibold text-ink">Design record</h4>
      <div className="mt-3">
        <h5 className="text-[11px] font-medium text-muted">States</h5>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {designRecord.states.map((state) => (
            <Pill key={state}>{state}</Pill>
          ))}
        </div>
      </div>
      <DesignTable
        title="Transitions"
        headers={["From", "To", "Durable precondition", "Recovery"]}
        rows={designRecord.transitions.map((transition) => [
          transition.from,
          transition.to,
          transition.durablePrecondition ?? "",
          transition.recovery ?? "",
        ])}
      />
      <DesignTable
        title="Failure points"
        headers={["Point", "Resulting state", "Recovery"]}
        rows={designRecord.failurePoints.map((failurePoint) => [
          prettyStatus(failurePoint.point),
          failurePoint.resultingState,
          failurePoint.recovery,
        ])}
      />
      <DesignTable
        title="Idempotency keys"
        headers={["Key", "Generated", "Persisted", "Reuse"]}
        rows={designRecord.idempotencyKeys.map((key) => [key.name, key.generatedAt, key.persistedAt, key.reuse])}
      />
      <DesignTable
        title="Fault-injection cases"
        headers={["Case", "Scenario", "Expectation"]}
        rows={designRecord.faultInjectionCases.map((faultCase) => [
          faultCase.name,
          faultCase.scenario,
          faultCase.expectation,
        ])}
      />
    </div>
  );
}

export function PipelineSummaryDetails({ summary }: { summary: PipelineSummary }) {
  const files = pipelineFileReview(summary);
  const assumptions = pipelineAssumptionReview(summary);
  return (
    <div className="mt-4 space-y-4">
      {!summary.scopeOk ? (
        <div className="rounded-md border border-urgent/25 bg-urgent-soft px-3.5 py-3 text-sm text-urgent" role="alert">
          <p className="font-medium">Work outside the declared scope</p>
          <p className="mt-1 text-xs leading-5">Review each highlighted file before approving the merge.</p>
        </div>
      ) : null}

      <ReviewFindingsPanel findings={summary.findings} />

      {summary.designRecord === null ? null : <DesignRecordDetails designRecord={summary.designRecord} />}

      <div className="rounded-md border border-line bg-card p-3.5">
        <h4 className="text-xs font-semibold text-ink">Commits</h4>
        {summary.commits.length > 0 ? (
          <ol className="mt-2 space-y-2">
            {summary.commits.map((commit) => (
              <li key={commit.sha} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2 text-xs leading-5">
                <code className="font-mono text-muted" title={commit.sha}>
                  {commit.sha.slice(0, 8)}
                </code>
                <span className="break-words text-ink">{commit.subject}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-xs text-muted">No commits are present on the pipeline branch.</p>
        )}
      </div>

      <div className="rounded-md border border-line bg-card p-3.5">
        <h4 className="text-xs font-semibold text-ink">Diffstat</h4>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted-surface p-3 font-mono text-[11px] leading-5 text-ink">
          {summary.diffstat || "No file changes."}
        </pre>
      </div>

      <div className="rounded-md border border-line bg-card p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-ink">Files and declared scope</h4>
          <Pill tone={summary.scopeOk ? "green" : "red"}>{summary.scopeOk ? "Within scope" : "Scope violations"}</Pill>
        </div>
        <p className="mt-2 text-[11px] leading-5 text-muted">
          Declared: {summary.declaredScope.join(", ") || "None declared"}
        </p>
        {files.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {files.map((file) => (
              <li
                key={file.file}
                className={cn(
                  "flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs",
                  file.outsideScope
                    ? "border-urgent/25 bg-urgent-soft text-urgent"
                    : "border-line bg-muted-surface text-ink"
                )}
              >
                <code className="min-w-0 break-all font-mono">{file.file}</code>
                {file.outsideScope ? (
                  <Pill tone="red">Outside declared scope</Pill>
                ) : (
                  <Pill tone="green">In scope</Pill>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted">No files changed.</p>
        )}
      </div>

      <div className="rounded-md border border-line bg-card p-3.5">
        <h4 className="text-xs font-semibold text-ink">Assumptions</h4>
        {assumptions.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {assumptions.map((item, index) => (
              <li
                key={`${index}-${item.assumption}`}
                className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-line bg-muted-surface px-3 py-2 text-xs leading-5 text-ink"
              >
                <span className="min-w-0 flex-1 break-words">{item.assumption}</span>
                {item.addedMidRun ? <Pill tone="amber">Added during implementation</Pill> : <Pill>Confirmed plan</Pill>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted">No assumptions recorded.</p>
        )}
      </div>

      <div className="rounded-md border border-line bg-card p-3.5">
        <h4 className="text-xs font-semibold text-ink">Machine verification</h4>
        {summary.verify.length > 0 ? (
          <ol className="mt-2 space-y-3">
            {summary.verify.map((attempt) => (
              <li key={attempt.verifyAttemptId} className="rounded-md border border-line bg-muted-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium text-ink">
                    Attempt {attempt.attempt} · {prettyStatus(attempt.stage)}
                  </p>
                  <Pill
                    tone={
                      attempt.state === "green"
                        ? "green"
                        : attempt.state === "running" || attempt.state === "starting"
                          ? "amber"
                          : "red"
                    }
                  >
                    {prettyStatus(attempt.state)}
                  </Pill>
                </div>
                {attempt.detail ? (
                  <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-muted">{attempt.detail}</p>
                ) : null}
                {attempt.checkResults === null || attempt.checkResults.length === 0 ? (
                  <p className="mt-2 text-xs text-muted">No criterion checks were recorded.</p>
                ) : (
                  <dl className="mt-2 space-y-2">
                    {attempt.checkResults.map((check, index) => (
                      <div
                        key={`${index}-${check.criterion}`}
                        className="rounded-md border border-line bg-card px-3 py-2"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <dt className="text-xs font-medium leading-5 text-ink">{check.criterion}</dt>
                          <Pill tone={check.passed ? "green" : "red"}>{check.passed ? "Passed" : "Failed"}</Pill>
                        </div>
                        <dd className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted">
                          {check.check}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-xs text-muted">No verify attempts were recorded.</p>
        )}
      </div>

      <div className="rounded-md border border-line bg-card p-3.5">
        <h4 className="text-xs font-semibold text-ink">Human-review criteria</h4>
        {summary.criteria.length > 0 ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-ink">
            {summary.criteria.map((criterion, index) => (
              <li key={`${index}-${criterion}`}>{criterion}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted">No prose criteria recorded.</p>
        )}
      </div>
    </div>
  );
}

export function FinalApprovalActions({
  busy,
  approveAnchorRef,
  mode = "pipeline",
  approveDisabled = false,
  onApprove,
  onRequestChanges,
}: {
  busy: boolean;
  approveAnchorRef: RefObject<HTMLButtonElement | null>;
  mode?: "pipeline" | "parent";
  approveDisabled?: boolean;
  onApprove: () => void;
  onRequestChanges: () => void;
}) {
  return (
    <div className="mt-4">
      <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Final approval actions">
        <Button
          ref={approveAnchorRef}
          className="scroll-mt-14 lg:scroll-mt-0"
          variant="mint"
          icon={<Check size={16} />}
          disabled={busy || approveDisabled}
          onClick={onApprove}
        >
          {mode === "parent" ? "Approve & merge children" : "Approve & merge"}
        </Button>
        <Button variant="danger" icon={<CircleAlert size={16} />} disabled={busy} onClick={onRequestChanges}>
          {mode === "parent" ? "Send back to coordination" : "Request changes"}
        </Button>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted">
        {mode === "parent"
          ? "One approval merges every unmerged child in dependency order. A conflict returns that child to implementation."
          : "A merge conflict returns the work item to implementation with conflict details for the next engineering round."}
      </p>
    </div>
  );
}

export function FinalRejectionForm({
  workItemId,
  note,
  busy,
  errors,
  onNoteChange,
  onDismissError,
  onSubmit,
  onKeep,
  parent = false,
}: {
  workItemId: string;
  note: string;
  busy: boolean;
  errors: ActionErrorState;
  onNoteChange: (note: string) => void;
  onDismissError: (context: string) => void;
  onSubmit: () => void;
  onKeep: () => void;
  parent?: boolean;
}) {
  return (
    <form
      className="space-y-4 p-5 sm:p-6"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div>
        <FieldLabel htmlFor={`work-item-final-change-note-${workItemId}`}>Change note</FieldLabel>
        <textarea
          id={`work-item-final-change-note-${workItemId}`}
          className={cn(inputClass, "min-h-24 resize-y py-3")}
          autoFocus
          required
          maxLength={2_000}
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder="What should the next implementation round change?"
        />
      </div>
      <InlineActionErrors errors={errors} onDismiss={onDismissError} />
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="submit" variant="danger" disabled={busy || note.trim().length === 0}>
          {parent ? "Send back" : "Send back to implementation"}
        </Button>
        <Button disabled={busy} onClick={onKeep}>
          {parent ? "Keep in final approval" : "Keep in final review"}
        </Button>
      </div>
    </form>
  );
}

export function WorkItemFooterActions({
  busy,
  finalActionBusy,
  showResume,
  resumeLabel = "Resume coordination",
  showCancel,
  showArchive,
  archiveDisabled,
  archiveHintId,
  cancelHint,
  resumeAnchorRef,
  archiveAnchorRef,
  onResume,
  onCancel,
  onArchive,
}: {
  busy: boolean;
  finalActionBusy: boolean;
  showResume: boolean;
  resumeLabel?: string;
  showCancel: boolean;
  showArchive: boolean;
  archiveDisabled: boolean;
  archiveHintId: string;
  cancelHint?: string | null;
  resumeAnchorRef: RefObject<HTMLButtonElement | null>;
  archiveAnchorRef: RefObject<HTMLButtonElement | null>;
  onResume: () => void;
  onCancel: () => void;
  onArchive: () => void;
}) {
  return (
    <footer className="flex flex-wrap justify-end gap-2 px-4 py-4 sm:px-5">
      {showResume ? (
        <Button
          ref={resumeAnchorRef}
          className="scroll-mt-14 lg:scroll-mt-0"
          variant="primary"
          disabled={busy || finalActionBusy}
          onClick={onResume}
        >
          {resumeLabel}
        </Button>
      ) : null}
      {showCancel && cancelHint ? <p className="self-center text-xs text-urgent">{cancelHint}</p> : null}
      {showCancel ? (
        <Button variant="danger" disabled={busy} onClick={onCancel}>
          Cancel work item
        </Button>
      ) : null}
      {showArchive ? (
        <Button
          ref={archiveAnchorRef}
          className="scroll-mt-14 lg:scroll-mt-0"
          icon={<Archive size={15} />}
          disabled={busy || archiveDisabled}
          aria-describedby={archiveDisabled ? archiveHintId : undefined}
          onClick={onArchive}
        >
          Archive
        </Button>
      ) : null}
      {showArchive && archiveDisabled ? (
        <p id={archiveHintId} className="w-full text-right text-xs text-muted">
          Attest deployment before archiving
        </p>
      ) : null}
    </footer>
  );
}

function initialFamilyState(
  workItem: BoardWorkItem,
  knownParent: boolean,
  initialFamily: InitialWorkItemFamily | undefined
): Readonly<{
  children: BoardChildWorkItem[];
  dependencies: BoardWorkItemDependency[];
  state: "loading" | "ready" | "error";
  error: string | null;
  parentAbsent: boolean;
}> {
  if (initialFamily === undefined) {
    return { children: [], dependencies: [], state: "loading", error: null, parentAbsent: false };
  }
  const parentless = workItem.parentWorkItemId === null;
  const notFound = parentless && initialFamily.state === "error" && initialFamily.status === 404;
  const empty = parentless && initialFamily.state === "ready" && initialFamily.children.length === 0;
  const knownFamily = !parentless || knownParent || initialFamily.children.length > 0;
  if (notFound || empty || (initialFamily.state === "error" && !knownFamily)) {
    return { children: [], dependencies: [], state: "ready", error: null, parentAbsent: notFound || empty };
  }
  return {
    children: [...initialFamily.children],
    dependencies: [...initialFamily.dependencies],
    state: initialFamily.state,
    error: initialFamily.error,
    parentAbsent: false,
  };
}

export function WorkItemDetail({
  workItem,
  snapshotRevision,
  familyVersionKey = `${workItem.id}:${workItem.version}`,
  familyRefreshRevision = 0,
  knownParent = false,
  initialFamily,
  projectName,
  projects,
  parentWorkItem,
  planningTask,
  openQuestion,
  client,
  busy,
  onClose,
  onOpenWorkItem,
  onAnswer,
  onConfirm,
  onReject,
  onApproveMerge,
  onRejectFinal,
  onAttestDeploy,
  onResumeCoordination,
  onCancel,
  onArchive,
}: WorkItemDetailProps) {
  const seededFamily = initialFamilyState(workItem, knownParent, initialFamily);
  const [answer, setAnswer] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [rejectionNote, setRejectionNote] = useState("");
  const [finalChangeNote, setFinalChangeNote] = useState("");
  const [attestationNote, setAttestationNote] = useState("");
  const [attestationWorkItemId, setAttestationWorkItemId] = useState(workItem.id);
  const [rejecting, setRejecting] = useState(false);
  const [finalActionBusy, setFinalActionBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<
    "cancel" | "reject" | "merge" | "requestChanges" | "archive" | "attest" | "resume" | null
  >(null);
  const actionErrors = useActionErrors();
  const [workflow, setWorkflow] = useState<ProjectWorkflow | null>(null);
  const [workflowState, setWorkflowState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [workflowAttempt, setWorkflowAttempt] = useState(0);
  const [pipelineSummary, setPipelineSummary] = useState<PipelineSummary | null>(null);
  const [pipelineSummaryState, setPipelineSummaryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [pipelineSummaryError, setPipelineSummaryError] = useState<string | null>(null);
  const [pipelineSummaryAttempt, setPipelineSummaryAttempt] = useState(0);
  const [audit, setAudit] = useState<RawWorkItemAudit | null>(null);
  const [auditState, setAuditState] = useState<"loading" | "ready" | "error">("loading");
  const [gapReportContent, setGapReportContent] = useState<string | null>(null);
  const [gapReportState, setGapReportState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [gapReportError, setGapReportError] = useState<string | null>(null);
  const [gapReportAttempt, setGapReportAttempt] = useState(0);
  const [familyChildren, setFamilyChildren] = useState<BoardChildWorkItem[]>(() => seededFamily.children);
  const [familyDependencies, setFamilyDependencies] = useState<BoardWorkItemDependency[]>(
    () => seededFamily.dependencies
  );
  const [familyState, setFamilyState] = useState<"loading" | "ready" | "error">(() => seededFamily.state);
  const [familyError, setFamilyError] = useState<string | null>(() => seededFamily.error);
  const [familyAttempt, setFamilyAttempt] = useState(0);
  const familyHasLastGoodRef = useRef(seededFamily.children.length > 0);
  const familyNotParentRef = useRef(seededFamily.parentAbsent);
  const pipelineSummaryWorkItemIdRef = useRef(workItem.id);
  const auditWorkItemIdRef = useRef(workItem.id);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const mergeConfirmationAnchorRef = useRef<HTMLButtonElement>(null);
  const archiveConfirmationAnchorRef = useRef<HTMLButtonElement>(null);
  const attestationConfirmationAnchorRef = useRef<HTMLButtonElement>(null);
  const resumeConfirmationAnchorRef = useRef<HTMLButtonElement>(null);
  const detailHeadingId = `work-item-detail-heading-${workItem.id}`;
  const actionContexts = {
    rejectPlan: actionErrorContexts.workItemRejectPlan(workItem.id),
    approveMerge: `work-item:${encodeURIComponent(workItem.id)}:approve-merge`,
    rejectFinal: `work-item:${encodeURIComponent(workItem.id)}:reject-final`,
    attestDeploy: `work-item:${encodeURIComponent(attestationWorkItemId)}:attest-deploy`,
    resumeCoordination: `work-item:${encodeURIComponent(workItem.id)}:resume-coordination`,
    cancel: actionErrorContexts.workItemCancel(workItem.id),
    archive: actionErrorContexts.workItemArchive(workItem.id),
  } as const;
  const affordances = deriveWorkItemDetailAffordances({
    workItemState: workItem.state,
    planningTaskState: planningTask?.status ?? null,
    archived: workItem.archivedAt !== null,
  });
  const familyParentCandidate =
    workItem.parentWorkItemId === null &&
    ["coordinating", "final_approval", "parked", "merged", "abandoned", "dead_letter"].includes(workItem.state);
  const familyRelevant = workItem.parentWorkItemId !== null || familyParentCandidate;
  const hasChildren = workItem.parentWorkItemId === null && familyChildren.length > 0;
  const phasedFamily = familyChildren.some((child) => child.phase !== null);
  const childFailed = familyChildren.some((child) => child.state === "abandoned" || child.state === "dead_letter");
  const isDecomposedParent = hasChildren;
  const loadedChild = familyChildren.find((child) => child.id === workItem.id);
  const deployAttested = loadedChild?.deployAttested ?? false;
  const decompositionAffordances = deriveDecompositionAffordances({
    workItemState: workItem.state,
    parentWorkItemId: workItem.parentWorkItemId,
    phase: workItem.phase,
    hasChildren,
    phasedFamily,
    childFailed,
    deployAttested,
    parkCategory: workItem.parkCategory,
  });
  const resumeAfterBaseChange = decompositionAffordances.resumeAfterBaseChange;
  const phasedChildFailure =
    workItem.parentWorkItemId === null && workItem.state === "parked" && phasedFamily && childFailed;
  const dependencyStatuses =
    workItem.phase === "contract" ? contractDependencyStatuses(workItem.id, familyChildren, familyDependencies) : [];
  const contractApprovalEnabled = contractApprovalIsReady(workItem.phase, familyState, dependencyStatuses);
  const archiveRequiresAttestation =
    workItem.parentWorkItemId !== null &&
    (workItem.phase === "expand" || workItem.phase === "migrate") &&
    workItem.state === "merged" &&
    !deployAttested;
  const archiveHintId = `work-item-archive-hint-${workItem.id}`;
  const pipelineSummaryVisible =
    ["reviewing", "fixing", "final_approval"].includes(workItem.state) && !isDecomposedParent;
  const pipelineSummaryBelongsToWorkItem = pipelineSummaryWorkItemIdRef.current === workItem.id;
  const renderedPipelineSummary = pipelineSummaryBelongsToWorkItem ? pipelineSummary : null;
  const renderedPipelineSummaryState = pipelineSummaryBelongsToWorkItem ? pipelineSummaryState : "loading";
  const renderedPipelineSummaryError = pipelineSummaryBelongsToWorkItem ? pipelineSummaryError : null;
  const auditBelongsToWorkItem = auditWorkItemIdRef.current === workItem.id;
  const renderedAudit = auditBelongsToWorkItem ? audit : null;
  const renderedAuditState = auditBelongsToWorkItem ? auditState : "loading";

  useEffect(() => {
    setAnswer("");
    setCancelReason("");
    setRejectionNote("");
    setFinalChangeNote("");
    setAttestationNote("");
    setAttestationWorkItemId(workItem.id);
    setRejecting(false);
    setFinalActionBusy(false);
    setConfirmation(null);
  }, [workItem.id]);

  useEffect(() => {
    familyNotParentRef.current = familyNotParentAfterSnapshot(familyNotParentRef.current, knownParent);
  }, [knownParent, workItem.id]);

  useEffect(() => {
    if (!familyRelevant) {
      familyHasLastGoodRef.current = false;
      familyNotParentRef.current = false;
      setFamilyChildren([]);
      setFamilyDependencies([]);
      setFamilyError(null);
      setFamilyState("ready");
      return;
    }
    const controller = new AbortController();
    const parentId = workItem.parentWorkItemId ?? workItem.id;
    const hasLastGood = familyHasLastGoodRef.current;
    if (!hasLastGood) {
      setFamilyState("loading");
      setFamilyError(null);
    }
    const dependencies =
      workItem.phase === "contract"
        ? client.getWorkItemDependencies(workItem.id, controller.signal)
        : Promise.resolve([]);
    void Promise.all([client.getWorkItemChildren(parentId, controller.signal), dependencies])
      .then(([children, nextDependencies]) => {
        if (controller.signal.aborted) return;
        setFamilyChildren(children);
        setFamilyDependencies(nextDependencies);
        setFamilyError(null);
        setFamilyState("ready");
        familyHasLastGoodRef.current = children.length > 0;
        familyNotParentRef.current = workItem.parentWorkItemId === null && children.length === 0;
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        const parentNotFound =
          workItem.parentWorkItemId === null && caught instanceof BoardApiError && caught.status === 404;
        if (parentNotFound) {
          familyHasLastGoodRef.current = false;
          familyNotParentRef.current = true;
          setFamilyChildren([]);
          setFamilyDependencies([]);
          setFamilyError(null);
          setFamilyState("ready");
          return;
        }
        const knownFamily =
          workItem.parentWorkItemId !== null || hasLastGood || (knownParent && !familyNotParentRef.current);
        if (!knownFamily) {
          setFamilyChildren([]);
          setFamilyDependencies([]);
          setFamilyError(null);
          setFamilyState("ready");
          return;
        }
        setFamilyError(caught instanceof Error ? caught.message : "The decomposition family could not be loaded.");
        if (!hasLastGood) {
          setFamilyChildren([]);
          setFamilyDependencies([]);
          setFamilyState("error");
        }
      });
    return () => controller.abort();
  }, [
    client,
    familyAttempt,
    familyRefreshRevision,
    familyRelevant,
    familyVersionKey,
    knownParent,
    workItem.id,
    workItem.parentWorkItemId,
    workItem.phase,
  ]);

  useEffect(() => {
    pipelineSummaryWorkItemIdRef.current = workItem.id;
    setPipelineSummary(null);
    setPipelineSummaryError(null);
    setPipelineSummaryState("idle");
  }, [workItem.id]);

  useEffect(() => {
    auditWorkItemIdRef.current = workItem.id;
    setAudit(null);
    setAuditState("loading");
  }, [workItem.id]);

  useEffect(() => {
    if (workItem.taskType !== "onboarding") {
      setGapReportContent(null);
      setGapReportError(null);
      setGapReportState("idle");
      return;
    }
    const controller = new AbortController();
    setGapReportContent(null);
    setGapReportError(null);
    setGapReportState("loading");
    void client
      .getWorkItem(workItem.id, controller.signal)
      .then(async (detail) => {
        if (controller.signal.aborted) return;
        if (detail.gapReportArtifactId === null) {
          setGapReportState("ready");
          return;
        }
        const blob = await client.getArtifactBlob(detail.gapReportArtifactId, controller.signal);
        const content = await blob.text();
        if (controller.signal.aborted) return;
        setGapReportContent(content);
        setGapReportState("ready");
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setGapReportError(caught instanceof Error ? caught.message : "The gap report could not be loaded.");
        setGapReportState("error");
      });
    return () => controller.abort();
  }, [client, gapReportAttempt, workItem.id, workItem.taskType, workItem.version]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    if (window.matchMedia("(max-width: 1279px)").matches) detailHeadingRef.current?.focus();
  }, [workItem.id]);

  useEffect(() => {
    const controller = new AbortController();
    setAuditState(renderedAudit === null ? "loading" : "ready");
    void client
      .getWorkItemAudit(workItem.id, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setAudit(next);
        setAuditState("ready");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setAuditState("error");
      });
    return () => controller.abort();
  }, [client, snapshotRevision, workItem.id, workItem.version]);

  useEffect(() => {
    if (workItem.state !== "plan_approval" || workItem.resolvedProjectId === null) {
      setWorkflow(null);
      setWorkflowError(null);
      setWorkflowState("idle");
      return;
    }
    const controller = new AbortController();
    setWorkflow(null);
    setWorkflowError(null);
    setWorkflowState("loading");
    void client
      .getProjectWorkflow(workItem.resolvedProjectId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setWorkflow(next);
        setWorkflowState("ready");
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setWorkflowError(caught instanceof Error ? caught.message : "The proposed plan could not be loaded");
        setWorkflowState("error");
      });
    return () => controller.abort();
  }, [client, workItem.id, workItem.resolvedProjectId, workItem.state, workflowAttempt]);

  useEffect(() => {
    if (!pipelineSummaryVisible) {
      return;
    }
    const controller = new AbortController();
    setPipelineSummaryError(null);
    setPipelineSummaryState(renderedPipelineSummary === null ? "loading" : "ready");
    void client
      .getPipelineSummary(workItem.id, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setPipelineSummary(next);
        setPipelineSummaryState("ready");
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setPipelineSummaryError(caught instanceof Error ? caught.message : "The pipeline summary could not be loaded");
        setPipelineSummaryState("error");
      });
    return () => controller.abort();
  }, [client, pipelineSummaryAttempt, pipelineSummaryVisible, workItem.id, workItem.state, workItem.version]);

  const proposedPlan = useMemo(
    () => (workflow === null ? null : proposedPlanForWorkItem(workflow, workItem.id)),
    [workflow, workItem.id]
  );
  const planNodes = useMemo(
    () => (proposedPlan === null || workflow === null ? [] : nodesForPlan(workflow, proposedPlan.planRevisionId)),
    [proposedPlan, workflow]
  );
  const answerContext = openQuestion === null ? null : actionErrorContexts.workItemAnswer(workItem.id, openQuestion.id);
  const confirmPlanContext =
    proposedPlan === null ? null : actionErrorContexts.workItemConfirmPlan(workItem.id, proposedPlan.planRevisionId);
  async function save(context: string, operation: () => Promise<ActionResult>, onSaved?: () => void) {
    actionErrors.start(context);
    const result = await operation();
    if (result.ok) onSaved?.();
    else actionErrors.fail(context, result.error);
  }

  async function submitCancellation() {
    const reason = cancelReason.trim();
    if (reason.length === 0 || confirmation !== "cancel") return;
    await save(
      actionContexts.cancel,
      () => onCancel(reason),
      () => {
        setCancelReason("");
        closeConfirmation();
      }
    );
  }

  async function submitRejection() {
    const note = rejectionNote.trim();
    if (note.length === 0 || confirmation !== "reject" || proposedPlan === null || onReject === undefined) return;
    await save(
      actionContexts.rejectPlan,
      async () => {
        setRejecting(true);
        try {
          return await onReject(proposedPlan.planRevisionId, note);
        } finally {
          setRejecting(false);
        }
      },
      () => {
        setRejectionNote("");
        closeConfirmation();
      }
    );
  }

  async function submitFinalRejection() {
    const note = finalChangeNote.trim();
    if (note.length === 0 || confirmation !== "requestChanges" || onRejectFinal === undefined) return;
    await save(
      actionContexts.rejectFinal,
      async () => {
        setFinalActionBusy(true);
        try {
          return await onRejectFinal(note);
        } finally {
          setFinalActionBusy(false);
        }
      },
      () => {
        setFinalChangeNote("");
        closeConfirmation();
      }
    );
  }

  async function submitMergeApproval() {
    if (confirmation !== "merge" || onApproveMerge === undefined) return;
    await save(
      actionContexts.approveMerge,
      async () => {
        setFinalActionBusy(true);
        try {
          return await onApproveMerge();
        } finally {
          setFinalActionBusy(false);
        }
      },
      closeConfirmation
    );
  }

  async function submitDeploymentAttestation() {
    if (confirmation !== "attest") return;
    const note = attestationNote.trim();
    await save(
      actionContexts.attestDeploy,
      async () => {
        setFinalActionBusy(true);
        try {
          return await onAttestDeploy(attestationWorkItemId, note.length === 0 ? undefined : note);
        } finally {
          setFinalActionBusy(false);
        }
      },
      () => {
        setAttestationNote("");
        setFamilyAttempt((value) => value + 1);
        closeConfirmation();
      }
    );
  }

  async function submitResumeCoordination() {
    if (confirmation !== "resume") return;
    await save(
      actionContexts.resumeCoordination,
      async () => {
        setFinalActionBusy(true);
        try {
          return await onResumeCoordination();
        } finally {
          setFinalActionBusy(false);
        }
      },
      closeConfirmation
    );
  }

  function confirmationContext(next: typeof confirmation): string | null {
    if (next === "reject") return actionContexts.rejectPlan;
    if (next === "merge") return actionContexts.approveMerge;
    if (next === "requestChanges") return actionContexts.rejectFinal;
    if (next === "cancel") return actionContexts.cancel;
    if (next === "archive") return actionContexts.archive;
    if (next === "attest") return actionContexts.attestDeploy;
    if (next === "resume") return actionContexts.resumeCoordination;
    return null;
  }

  function openConfirmation(next: Exclude<typeof confirmation, null>) {
    actionErrors.dismiss(confirmationContext(next)!);
    if (next === "cancel") setCancelReason("");
    if (next === "reject") setRejectionNote("");
    if (next === "requestChanges") setFinalChangeNote("");
    if (next === "attest") setAttestationNote("");
    setConfirmation(next);
  }

  function openDeploymentAttestation(targetWorkItemId: string, anchor?: HTMLButtonElement) {
    const context = `work-item:${encodeURIComponent(targetWorkItemId)}:attest-deploy`;
    actionErrors.dismiss(context);
    if (anchor !== undefined) attestationConfirmationAnchorRef.current = anchor;
    setAttestationWorkItemId(targetWorkItemId);
    setAttestationNote("");
    setConfirmation("attest");
  }

  function closeConfirmation() {
    const context = confirmationContext(confirmation);
    if (context !== null) actionErrors.dismiss(context);
    setConfirmation(null);
  }

  const takeoverOpen = confirmation === "cancel" || confirmation === "reject" || confirmation === "requestChanges";

  return (
    <>
      <div
        className="min-w-0 max-w-full"
        role="region"
        aria-labelledby={detailHeadingId}
        aria-hidden={takeoverOpen ? true : undefined}
      >
        <Card className="min-w-0 max-w-full overflow-hidden" as="article">
          <header className="border-b border-line px-4 py-5 sm:px-5">
            <div className="flex items-start justify-between gap-4">
              <div role="group" aria-label="Current status">
                <p className="mb-1.5 text-xs font-medium text-muted">Current status</p>
                <Pill tone={workItemStateTone[workItem.state]} dot>
                  {workItemStatusLabel(workItem)}
                </Pill>
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
            <h2
              ref={detailHeadingRef}
              id={detailHeadingId}
              tabIndex={-1}
              className="mt-4 break-words font-display text-xl font-light tracking-[0.01em] text-ink"
            >
              Work-item details
            </h2>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-muted">Task type</dt>
                <dd className="mt-1 break-words text-ink">{workItem.taskType}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Resolved project</dt>
                <dd className="mt-1 break-words text-ink">
                  {projectName ??
                    (workItem.resolvedProjectId === null ? "Not resolved yet" : workItem.resolvedProjectId)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Planning task</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2 text-ink">
                  <span className="break-words">{planningTask?.title ?? "Not linked yet"}</span>
                  {planningTask ? (
                    <Pill>
                      {planningTask.status === "unrecognized" ? unknownStateLabel : prettyStatus(planningTask.status)}
                    </Pill>
                  ) : null}
                </dd>
              </div>
              {workItem.parentWorkItemId === null ? null : (
                <div className="sm:col-span-2">
                  <dt className="text-xs font-medium text-muted">Parent work item</dt>
                  <dd className="mt-1">
                    <ParentWorkItemLink
                      parentWorkItemId={workItem.parentWorkItemId}
                      parentWorkItem={parentWorkItem}
                      onOpenWorkItem={onOpenWorkItem}
                    />
                  </dd>
                </div>
              )}
            </dl>
          </header>

          <StatusTimeline
            workItem={workItem}
            transitions={renderedAudit?.transitions ?? []}
            state={renderedAuditState}
          />

          <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="original-request-heading">
            <h3 id="original-request-heading" className="text-xs font-semibold text-ink">
              Original request
            </h3>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink">
              {workItem.originalRequest}
            </p>
          </section>

          {familyParentCandidate && (isDecomposedParent || familyState === "error") ? (
            <ChildrenSection
              children={familyChildren}
              projects={projects}
              state={familyState}
              error={familyError}
              onRetry={() => setFamilyAttempt((value) => value + 1)}
              onOpenChild={onOpenWorkItem}
              onAttestChild={openDeploymentAttestation}
              attestationBusy={busy || finalActionBusy}
            />
          ) : null}

          {workItem.parentWorkItemId !== null &&
          (workItem.phase === "expand" || workItem.phase === "migrate") &&
          workItem.state === "merged" ? (
            <section
              className="min-w-0 border-b border-line px-4 py-4 sm:px-5"
              aria-labelledby="deployment-attestation-heading"
              aria-live="polite"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 id="deployment-attestation-heading" className="text-xs font-semibold text-ink">
                    Deployment
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    The merge is complete. Human attestation records that this phase is deployed.
                  </p>
                </div>
                {familyState === "ready" && deployAttested ? <Pill tone="green">Deployment attested</Pill> : null}
              </div>
              {familyState === "ready" && familyError !== null ? (
                <div
                  className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-urgent"
                  role="alert"
                >
                  <span>{familyError} The last loaded deployment status remains visible.</span>
                  <Button
                    size="sm"
                    icon={<RefreshCw size={14} />}
                    onClick={() => setFamilyAttempt((value) => value + 1)}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}
              {familyState === "error" ? (
                <div
                  className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-urgent"
                  role="alert"
                >
                  <span>{familyError ?? "Deployment attestation status could not be loaded."}</span>
                  <Button
                    size="sm"
                    icon={<RefreshCw size={14} />}
                    onClick={() => setFamilyAttempt((value) => value + 1)}
                  >
                    Retry
                  </Button>
                </div>
              ) : familyState === "loading" ? (
                <p className="mt-3 text-xs text-muted" role="status">
                  Loading deployment attestation…
                </p>
              ) : decompositionAffordances.attestDeployment ? (
                <Button
                  ref={attestationConfirmationAnchorRef}
                  className="mt-3 scroll-mt-14 lg:scroll-mt-0"
                  variant="mint"
                  disabled={busy || finalActionBusy}
                  onClick={() => openDeploymentAttestation(workItem.id)}
                >
                  Attest deployed
                </Button>
              ) : null}
            </section>
          ) : null}

          {workItem.taskType === "onboarding" ? (
            <GapReportSection
              state={gapReportState === "idle" ? "loading" : gapReportState}
              content={gapReportContent}
              error={gapReportError}
              onRetry={() => setGapReportAttempt((value) => value + 1)}
            />
          ) : null}

          {workItem.cancelledReason !== null ? (
            <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="cancellation-reason-heading">
              <h3 id="cancellation-reason-heading" className="text-xs font-semibold text-ink">
                Cancellation reason
              </h3>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink">
                {workItem.cancelledReason}
              </p>
            </section>
          ) : null}

          {workItem.state === "parked" && !isDecomposedParent && openQuestion !== null ? (
            <form
              className="border-b border-caution-fill/30 bg-caution-soft/55 px-4 py-4 sm:px-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (answer.trim().length === 0) return;
                void save(
                  actionErrorContexts.workItemAnswer(workItem.id, openQuestion.id),
                  () => onAnswer(openQuestion.id, answer.trim()),
                  () => setAnswer("")
                );
              }}
            >
              <div className="flex items-center gap-2 text-caution">
                <HelpCircle size={17} />
                <h3 className="text-xs font-semibold">Planning needs your input</h3>
              </div>
              {affordances.answerQuestion ? (
                <>
                  <p className="mt-3 whitespace-pre-wrap text-sm font-medium leading-6 text-ink">
                    {openQuestion.prompt}
                  </p>
                  <div className="mt-3">
                    <FieldLabel htmlFor={`work-item-answer-${workItem.id}`}>Your answer</FieldLabel>
                    <textarea
                      id={`work-item-answer-${workItem.id}`}
                      className={cn(inputClass, "min-h-24 resize-y py-3")}
                      placeholder="Give the missing context…"
                      value={answer}
                      onChange={(event) => setAnswer(event.target.value)}
                    />
                  </div>
                  <Button
                    className="mt-3 w-full"
                    type="submit"
                    variant="primary"
                    icon={<Send size={16} />}
                    disabled={busy || answer.trim().length === 0}
                  >
                    Answer and resume planning
                  </Button>
                </>
              ) : (
                <div className="mt-3 rounded-md border border-line bg-card px-3.5 py-3 text-sm text-muted">
                  The linked planning task has not published an open question. Refresh to check for its latest state.
                </div>
              )}
            </form>
          ) : workItem.state === "parked" && !isDecomposedParent ? (
            <section className="border-b border-line px-4 py-4 sm:px-5">
              <div
                className="rounded-md border border-line bg-muted-surface px-3.5 py-3 text-sm text-muted"
                role="status"
              >
                Parked — no open question. Retry or reassign from the task view.
              </div>
            </section>
          ) : null}

          {decompositionAffordances.approveAndMergeChildren &&
          onApproveMerge !== undefined &&
          onRejectFinal !== undefined ? (
            <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="parent-final-approval-heading">
              <h3 id="parent-final-approval-heading" className="text-xs font-semibold text-ink">
                Final approval
              </h3>
              <p className="mt-1 text-xs leading-5 text-muted">
                Every remaining child is verified and ready. One approval merges them in dependency order.
              </p>
              <FinalApprovalActions
                busy={busy || finalActionBusy}
                approveAnchorRef={mergeConfirmationAnchorRef}
                mode="parent"
                onApprove={() => openConfirmation("merge")}
                onRequestChanges={() => openConfirmation("requestChanges")}
              />
            </section>
          ) : null}

          {workItem.state === "plan_approval" ? (
            <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="proposed-plan-heading">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 id="proposed-plan-heading" className="text-xs font-semibold text-ink">
                    Proposed plan
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    Review the stages and dependencies before workflow execution begins.
                  </p>
                </div>
                {workflowState === "error" ? (
                  <Button
                    size="sm"
                    icon={<RefreshCw size={14} />}
                    onClick={() => setWorkflowAttempt((value) => value + 1)}
                  >
                    Retry
                  </Button>
                ) : null}
              </div>
              {workflowState === "loading" ? (
                <div
                  className="mt-4 flex min-h-28 items-center justify-center gap-2 rounded-md border border-line bg-muted-surface text-sm text-muted"
                  role="status"
                >
                  <RefreshCw size={16} className="animate-spin" /> Loading proposed plan…
                </div>
              ) : workflowState === "error" ? (
                <div
                  className="mt-4 rounded-md border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent"
                  role="alert"
                >
                  {workflowError ?? "The proposed plan could not be loaded."}
                </div>
              ) : workflowState === "ready" && proposedPlan === null ? (
                <div className="mt-4 flex min-h-28 flex-col items-center justify-center rounded-md border border-line bg-muted-surface px-5 text-center">
                  <CirclePause size={18} className="text-muted" />
                  <p className="mt-2 text-sm font-medium text-ink">No proposed plan</p>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    The workflow snapshot has no proposed revision for this work item.
                  </p>
                </div>
              ) : proposedPlan ? (
                <div className="mt-4">
                  <PlanRecordDetails plan={proposedPlan} />
                  {planNodes.length > 0 ? (
                    <ol className="mt-3 space-y-3">
                      {planNodes.map((node) => (
                        <WorkflowNodeCard key={node.nodeId} node={node} allNodes={planNodes} />
                      ))}
                    </ol>
                  ) : (
                    <p className="mt-3 rounded-md border border-line bg-muted-surface p-3.5 text-sm text-muted">
                      This proposed plan contains no work nodes.
                    </p>
                  )}
                  <PlanApprovalActions
                    plan={proposedPlan}
                    busy={busy || rejecting}
                    confirmEnabled={affordances.confirmPlan}
                    rejectEnabled={affordances.rejectPlan && onReject !== undefined}
                    onConfirm={() => {
                      void save(actionErrorContexts.workItemConfirmPlan(workItem.id, proposedPlan.planRevisionId), () =>
                        onConfirm(proposedPlan.planRevisionId)
                      );
                    }}
                    onReject={() => openConfirmation("reject")}
                  />
                </div>
              ) : workflowState === "idle" ? (
                <div className="mt-4 rounded-md border border-line bg-muted-surface px-3.5 py-3 text-sm text-muted">
                  The resolved project is unavailable, so the plan cannot be loaded.
                </div>
              ) : null}
            </section>
          ) : null}

          {pipelineSummaryVisible ? (
            <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="pipeline-summary-heading">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 id="pipeline-summary-heading" className="text-xs font-semibold text-ink">
                    {workItem.state === "final_approval" ? "Final approval" : "Pipeline review"}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    {workItem.state === "final_approval"
                      ? "Review the committed changes, declared scope, assumptions, and verify evidence before merging locally."
                      : "Track review findings, design decisions, committed changes, and verification evidence while the pipeline is active."}
                  </p>
                </div>
                {renderedPipelineSummaryState === "error" ? (
                  <Button
                    size="sm"
                    icon={<RefreshCw size={14} />}
                    onClick={() => setPipelineSummaryAttempt((value) => value + 1)}
                  >
                    Retry
                  </Button>
                ) : null}
              </div>
              {renderedPipelineSummaryState === "loading" ? (
                <div
                  className="mt-4 flex min-h-28 items-center justify-center gap-2 rounded-md border border-line bg-muted-surface text-sm text-muted"
                  role="status"
                >
                  <RefreshCw size={16} className="animate-spin" /> Loading pipeline summary…
                </div>
              ) : renderedPipelineSummaryState === "error" ? (
                <div
                  className="mt-4 rounded-md border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent"
                  role="alert"
                >
                  {renderedPipelineSummaryError ?? "The pipeline summary could not be loaded."}
                </div>
              ) : renderedPipelineSummaryState === "ready" && renderedPipelineSummary !== null ? (
                <>
                  <PipelineSummaryDetails summary={renderedPipelineSummary} />
                  {(workItem.phase === "contract" || workItem.phase === "unrecognized") &&
                  workItem.state === "final_approval" ? (
                    <ContractAttestationGate
                      statuses={dependencyStatuses}
                      phase={workItem.phase}
                      state={familyState}
                      error={familyError}
                      onRetry={() => setFamilyAttempt((value) => value + 1)}
                    />
                  ) : null}
                  {workItem.state === "final_approval" &&
                  onApproveMerge !== undefined &&
                  onRejectFinal !== undefined ? (
                    <FinalApprovalActions
                      busy={busy || finalActionBusy}
                      approveAnchorRef={mergeConfirmationAnchorRef}
                      approveDisabled={
                        (workItem.phase === "contract" || workItem.phase === "unrecognized") && !contractApprovalEnabled
                      }
                      onApprove={() => openConfirmation("merge")}
                      onRequestChanges={() => openConfirmation("requestChanges")}
                    />
                  ) : null}
                </>
              ) : (
                <div className="mt-4 rounded-md border border-line bg-muted-surface px-3.5 py-3 text-sm text-muted">
                  {workItem.state === "final_approval"
                    ? "The pipeline summary is unavailable. Refresh before making a final decision."
                    : "The pipeline summary is unavailable. Refresh to check the latest review evidence."}
                </div>
              )}
            </section>
          ) : null}

          {renderedAuditState === "ready" && renderedAudit !== null ? <AuditSection audit={renderedAudit} /> : null}

          <InlineActionErrors
            className={
              actionErrors.errors.some(
                (entry) => entry.context === answerContext || entry.context === confirmPlanContext
              )
                ? "border-b border-line px-4 py-3 sm:px-5"
                : undefined
            }
            errors={actionErrors.errors.filter(
              (entry) => entry.context === answerContext || entry.context === confirmPlanContext
            )}
            onDismiss={actionErrors.dismiss}
          />

          {affordances.cancel || affordances.archive ? (
            <WorkItemFooterActions
              busy={busy}
              finalActionBusy={finalActionBusy}
              showResume={decompositionAffordances.resumeCoordination || resumeAfterBaseChange}
              resumeLabel={resumeAfterBaseChange ? "Resume after base change" : "Resume coordination"}
              showCancel={affordances.cancel}
              showArchive={affordances.archive}
              archiveDisabled={archiveRequiresAttestation}
              archiveHintId={archiveHintId}
              cancelHint={phasedChildFailure ? "A phase failed — cancel the coordination to abandon it" : null}
              resumeAnchorRef={resumeConfirmationAnchorRef}
              archiveAnchorRef={archiveConfirmationAnchorRef}
              onResume={() => openConfirmation("resume")}
              onCancel={() => openConfirmation("cancel")}
              onArchive={() => openConfirmation("archive")}
            />
          ) : null}
        </Card>
      </div>

      <Modal
        open={confirmation === "cancel"}
        onClose={closeConfirmation}
        isDirty={() => fieldsAreDirty([cancelReason])}
        title="Cancel work item"
        description="This stops the intake and its live planning task. This action cannot be undone."
      >
        {(requestClose) => (
          <form
            className="space-y-4 p-5 sm:p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCancellation();
            }}
          >
            <div>
              <FieldLabel htmlFor={`work-item-cancel-reason-${workItem.id}`}>Reason</FieldLabel>
              <textarea
                id={`work-item-cancel-reason-${workItem.id}`}
                className={cn(inputClass, "min-h-24 resize-y py-3")}
                autoFocus
                required
                maxLength={16_000}
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
                placeholder="Why is this work item being cancelled?"
              />
            </div>
            <InlineActionErrors
              errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.cancel)}
              onDismiss={actionErrors.dismiss}
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <Button type="submit" variant="danger" disabled={busy || cancelReason.trim().length === 0}>
                Cancel work item
              </Button>
              <Button disabled={busy} onClick={requestClose}>
                Keep work item
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        open={confirmation === "reject"}
        onClose={closeConfirmation}
        isDirty={() => fieldsAreDirty([rejectionNote])}
        title="Reject proposed plan"
        description="Send one bounded revision note back to planning. Rejecting a second proposed revision parks the work item."
      >
        {(requestClose) => (
          <PlanRejectionForm
            workItemId={workItem.id}
            note={rejectionNote}
            busy={busy || rejecting}
            errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.rejectPlan)}
            onNoteChange={setRejectionNote}
            onDismissError={actionErrors.dismiss}
            onSubmit={() => {
              void submitRejection();
            }}
            onKeep={requestClose}
          />
        )}
      </Modal>

      <Modal
        open={confirmation === "merge"}
        onClose={closeConfirmation}
        variant="anchored"
        anchorRef={mergeConfirmationAnchorRef}
        title={isDecomposedParent ? "Approve and merge children" : "Approve and merge pipeline"}
        description={
          isDecomposedParent
            ? "This merges every unmerged child in dependency order, then completes the parent. A conflict returns that child to implementation."
            : "This creates a local no-fast-forward merge commit on the clean checked-out merge target. It does not push anything. A conflict returns the work item to implementation with conflict details."
        }
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 sm:p-6">
          <Button
            variant="mint"
            icon={<Check size={15} />}
            disabled={busy || finalActionBusy}
            onClick={() => {
              void submitMergeApproval();
            }}
          >
            {isDecomposedParent ? "Approve and merge" : "Approve & merge"}
          </Button>
          <Button disabled={busy || finalActionBusy} onClick={closeConfirmation}>
            {isDecomposedParent ? "Keep in final approval" : "Keep in final review"}
          </Button>
          <InlineActionErrors
            className="sm:col-span-2"
            errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.approveMerge)}
            onDismiss={actionErrors.dismiss}
          />
        </div>
      </Modal>

      <Modal
        open={confirmation === "requestChanges"}
        onClose={closeConfirmation}
        isDirty={() => fieldsAreDirty([finalChangeNote])}
        title={isDecomposedParent ? "Send back to coordination" : "Request implementation changes"}
        description={
          isDecomposedParent
            ? "Every unmerged child in final approval returns to implementation with this note. The parent returns to coordination."
            : "The work item returns to implementation with this note attached to the next engineering round."
        }
      >
        {(requestClose) => (
          <FinalRejectionForm
            workItemId={workItem.id}
            note={finalChangeNote}
            busy={busy || finalActionBusy}
            errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.rejectFinal)}
            onNoteChange={setFinalChangeNote}
            onDismissError={actionErrors.dismiss}
            onSubmit={() => {
              void submitFinalRejection();
            }}
            onKeep={requestClose}
            parent={isDecomposedParent}
          />
        )}
      </Modal>

      <Modal
        open={confirmation === "attest"}
        onClose={closeConfirmation}
        isDirty={() => fieldsAreDirty([attestationNote])}
        variant="anchored"
        anchorRef={attestationConfirmationAnchorRef}
        title="Attest deployment"
        description="Record that this merged phase is deployed. The optional note is stored with the human gate action."
      >
        {(requestClose) => (
          <AttestDeploymentForm
            workItemId={attestationWorkItemId}
            note={attestationNote}
            busy={busy || finalActionBusy}
            errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.attestDeploy)}
            onNoteChange={setAttestationNote}
            onDismissError={actionErrors.dismiss}
            onSubmit={() => {
              void submitDeploymentAttestation();
            }}
            onCancel={requestClose}
          />
        )}
      </Modal>

      <Modal
        open={confirmation === "resume"}
        onClose={closeConfirmation}
        variant="anchored"
        anchorRef={resumeConfirmationAnchorRef}
        title={
          resumeAfterBaseChange
            ? workItem.parentWorkItemId === null
              ? "Resume work item"
              : "Resume child"
            : "Resume coordination"
        }
        description={
          resumeAfterBaseChange
            ? "Refresh the pipeline base to the current repository head, resolve the base-diverged park, and return to implementation."
            : "Return this parked decomposed parent to coordination and continue the remaining child work."
        }
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 sm:p-6">
          <Button
            variant="primary"
            disabled={busy || finalActionBusy}
            onClick={() => {
              void submitResumeCoordination();
            }}
          >
            Resume
          </Button>
          <Button disabled={busy || finalActionBusy} onClick={closeConfirmation}>
            Cancel
          </Button>
          <InlineActionErrors
            className="sm:col-span-2"
            errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.resumeCoordination)}
            onDismiss={actionErrors.dismiss}
          />
        </div>
      </Modal>

      <Modal
        open={confirmation === "archive"}
        onClose={closeConfirmation}
        variant="anchored"
        anchorRef={archiveConfirmationAnchorRef}
        title="Archive work item"
        description="Archived work items leave the default intake list but remain stored and retrievable."
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 sm:p-6">
          <Button
            variant="primary"
            icon={<Archive size={15} />}
            disabled={busy}
            onClick={() => void save(actionContexts.archive, onArchive, closeConfirmation)}
          >
            Archive work item
          </Button>
          <Button disabled={busy} onClick={closeConfirmation}>
            Keep visible
          </Button>
          <InlineActionErrors
            className="sm:col-span-2"
            errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.archive)}
            onDismiss={actionErrors.dismiss}
          />
        </div>
      </Modal>
    </>
  );
}
