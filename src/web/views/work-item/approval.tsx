/** Renders the final-approval gate and the footer actions that close a work item. */

/* —— Imports —— */

import { Archive, Check, CircleAlert } from "lucide-react";
import { type RefObject } from "react";
import { Button, FieldLabel, InlineActionErrors, cn, inputClass } from "../../components/ui";
import { type ActionErrorState } from "../../model/action-errors";

/* —— Final approval —— */

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
          : "A merge conflict returns the request to implementation with conflict details for the next engineering round."}
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
          Abandon request
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
