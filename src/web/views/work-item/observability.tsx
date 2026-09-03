/** Renders the state timeline and the audit trail behind it. */

/* —— Imports —— */

import { formatAuditDateTime } from "../../data/date-format";
import type { RawWorkItemAudit } from "../../data/parse";
import { elapsedMilliseconds, formatElapsedDuration } from "../../model/observability";
import { prettyStatus, workItemStateLabel } from "../../model/work-item-labels";
import type { BoardWorkItem, BoardWorkItemTransition } from "../../types";

/* —— Timeline and audit —— */

function AuditTimestamp({ value }: { value: string }) {
  return <time dateTime={value}>{formatAuditDateTime(value)}</time>;
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
