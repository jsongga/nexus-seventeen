/** Reconciles the routed work item with what the latest snapshot still contains. */

/* —— Imports —— */

import { pageToHash, type BoardPage } from "../routing/routing";
import { type BoardWorkItem, type BoardWorkItemDetail } from "../types";

/* —— Routed selection —— */

export type WorkItemDetailLoadResult =
  | Readonly<{ kind: "loaded"; detail: BoardWorkItemDetail }>
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "failed"; error: unknown }>
  | Readonly<{ kind: "stale" }>;

export function snapshotLostSelectedWorkItem(
  workItemId: string,
  previous: readonly Pick<BoardWorkItem, "id">[],
  current: readonly Pick<BoardWorkItem, "id">[]
): boolean {
  return (
    previous.some((workItem) => workItem.id === workItemId) && !current.some((workItem) => workItem.id === workItemId)
  );
}

export function workItemDetailReloadPending(page: BoardPage, sourceHash: string | null): boolean {
  return page.kind === "intake" && sourceHash === pageToHash(page);
}

export function routedWorkItemSelection(
  page: BoardPage,
  snapshotWorkItems: readonly BoardWorkItem[],
  loadedDetail: BoardWorkItemDetail | null,
  previousSnapshotWorkItems: readonly Pick<BoardWorkItem, "id">[]
): BoardWorkItem | BoardWorkItemDetail | undefined {
  if (page.kind !== "intake") return undefined;
  const selected = snapshotWorkItems.find((workItem) => workItem.id === page.workItemId);
  const cachedSelectionWasRemoved =
    selected === undefined &&
    loadedDetail?.id === page.workItemId &&
    snapshotLostSelectedWorkItem(page.workItemId, previousSnapshotWorkItems, snapshotWorkItems);
  return selected ?? (loadedDetail?.id === page.workItemId && !cachedSelectionWasRemoved ? loadedDetail : undefined);
}
