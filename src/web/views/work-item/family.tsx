/** Renders a work item's place in its decomposition family, and the state that tracks it. */

/* —— Imports —— */

import { RefreshCw } from "lucide-react";
import { Button, Pill } from "../../components/ui";
import { phaseDisplayLabel, workItemStateTone, workItemStatusLabel } from "../../model/work-item-labels";
import type { BoardChildWorkItem, BoardProject, BoardWorkItem, BoardWorkItemDependency } from "../../types";

/* —— Parent and children —— */

export interface InitialWorkItemFamily {
  state: "ready" | "error";
  children: readonly BoardChildWorkItem[];
  dependencies: readonly BoardWorkItemDependency[];
  error: string | null;
  status?: number;
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

export function initialFamilyState(
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
