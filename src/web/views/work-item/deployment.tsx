/** Renders the Contract phase's deployment attestation gate. */

/* —— Imports —— */

import { RefreshCw } from "lucide-react";
import { Button, FieldLabel, InlineActionErrors, Pill, cn, inputClass } from "../../components/ui";
import { contractApprovalIsReady, type ContractDependencyStatus } from "../../model/work-item-detail";
import { type ActionErrorState } from "../../model/action-errors";
import type { BoardWorkItem } from "../../types";
import { phaseDisplayLabel } from "../../model/work-item-labels";

/* —— Deployment attestation —— */

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
