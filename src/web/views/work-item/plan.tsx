/** Renders a work item's proposed plan and the human gate that accepts or rejects it. */

/* —— Imports —— */

import { ArrowRight, Check, CircleAlert } from "lucide-react";
import { Button, FieldLabel, InlineActionErrors, Pill, cn, inputClass } from "../../components/ui";
import { type DetailedWorkflowPlan } from "../../model/work-item-detail";
import { planValueLabel, prettyStatus, unknownStateLabel } from "../../model/work-item-labels";
import { type ActionErrorState } from "../../model/action-errors";
import type { BoardRepository, WorkflowNode } from "../../types";

/* —— Plan record and gate —— */

export function WorkflowNodeCard({ node, allNodes }: { node: WorkflowNode; allNodes: WorkflowNode[] }) {
  const titles = new Map(allNodes.map((candidate) => [candidate.nodeId, candidate.title]));
  return (
    <li>
      <article className="rounded-md border border-line bg-muted-surface p-3.5" aria-label={node.title}>
        <p className="text-sm font-semibold text-ink">{node.title}</p>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted">{node.objective}</p>
        <div className="mt-3">
          <p className="text-[11px] font-medium text-muted">Stages</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {node.stageTemplate.map((nodeStage, index) => (
              <span key={nodeStage} className="inline-flex items-center gap-1.5">
                {index > 0 ? <ArrowRight size={11} className="text-muted" aria-hidden="true" /> : null}
                <Pill>{prettyStatus(nodeStage)}</Pill>
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

export function repositoryTargetLabel(
  repositories: readonly BoardRepository[],
  projectId: string | null,
  repositoryId: string | null | undefined
): string {
  if (repositoryId === null || repositoryId === undefined) {
    const primary = repositories.find((repository) => repository.projectId === projectId && repository.isPrimary);
    return primary === undefined ? "Inherits the project's primary repository" : `${primary.name} (inherits primary)`;
  }
  const repository = repositories.find((candidate) => candidate.id === repositoryId);
  return repository === undefined ? `${repositoryId} (pinned; name unavailable)` : `${repository.name} (pinned)`;
}

export function PlanRecordDetails({
  plan,
  repositories,
}: {
  plan: DetailedWorkflowPlan;
  repositories: readonly BoardRepository[];
}) {
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
                  <p className="mt-1 text-[11px] leading-5 text-muted">
                    Repository: {repositoryTargetLabel(repositories, child.projectId, child.repositoryId)}
                  </p>
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
