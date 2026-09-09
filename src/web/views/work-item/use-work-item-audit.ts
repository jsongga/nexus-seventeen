/** Loads one request's audit trail, holding the previous one until the new request's arrives. */

/* —— Imports —— */

import { useEffect, useRef, useState } from "react";
import type { TaskBoardClient } from "../../data/client";
import type { RawWorkItemAudit } from "../../data/parse";

/* —— Hook —— */

export interface WorkItemAuditState {
  readonly audit: RawWorkItemAudit | null;
  readonly auditState: "loading" | "ready" | "error";
}

/**
 * The id ref is what stops a previous request's audit rendering under a new one: until the reset
 * effect runs, the held value belongs to the request that is leaving, so it is reported as
 * loading rather than shown.
 */
export function useWorkItemAudit(
  client: TaskBoardClient,
  workItemId: string,
  workItemVersion: number,
  snapshotRevision: number
): WorkItemAuditState {
  const [audit, setAudit] = useState<RawWorkItemAudit | null>(null);
  const [auditState, setAuditState] = useState<"loading" | "ready" | "error">("loading");
  const auditWorkItemIdRef = useRef(workItemId);

  const belongsToWorkItem = auditWorkItemIdRef.current === workItemId;
  const renderedAudit = belongsToWorkItem ? audit : null;
  const renderedAuditState = belongsToWorkItem ? auditState : "loading";

  useEffect(() => {
    auditWorkItemIdRef.current = workItemId;
    setAudit(null);
    setAuditState("loading");
  }, [workItemId]);

  useEffect(() => {
    const controller = new AbortController();
    setAuditState(renderedAudit === null ? "loading" : "ready");
    void client
      .getWorkItemAudit(workItemId, controller.signal)
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
    // `renderedAudit` is read to decide the interim state, not to trigger a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, snapshotRevision, workItemId, workItemVersion]);

  return { audit: renderedAudit, auditState: renderedAuditState };
}
