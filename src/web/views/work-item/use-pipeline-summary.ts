/** Loads one request's pipeline summary while it is in a state that has one to show. */

/* —— Imports —— */

import { useEffect, useRef, useState } from "react";
import type { TaskBoardClient } from "../../data/client";
import type { PipelineSummary } from "@shared/task-board-contract";

/* —— Hook —— */

export interface PipelineSummaryState {
  readonly pipelineSummary: PipelineSummary | null;
  readonly pipelineSummaryState: "idle" | "loading" | "ready" | "error";
  readonly pipelineSummaryError: string | null;
  readonly retryPipelineSummary: () => void;
}

/**
 * `visible` gates the load rather than the render: a request with no pipeline stage to report
 * should not fetch one and then show an empty panel. The id ref keeps the previous request's
 * summary from appearing under a new one before the reset effect runs.
 */
export function usePipelineSummary(
  client: TaskBoardClient,
  workItem: Readonly<{ id: string; state: string; version: number }>,
  visible: boolean
): PipelineSummaryState {
  const [pipelineSummary, setPipelineSummary] = useState<PipelineSummary | null>(null);
  const [pipelineSummaryState, setPipelineSummaryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [pipelineSummaryError, setPipelineSummaryError] = useState<string | null>(null);
  const [pipelineSummaryAttempt, setPipelineSummaryAttempt] = useState(0);
  const pipelineSummaryWorkItemIdRef = useRef(workItem.id);

  const belongsToWorkItem = pipelineSummaryWorkItemIdRef.current === workItem.id;
  const renderedPipelineSummary = belongsToWorkItem ? pipelineSummary : null;

  useEffect(() => {
    pipelineSummaryWorkItemIdRef.current = workItem.id;
    setPipelineSummary(null);
    setPipelineSummaryError(null);
    setPipelineSummaryState("idle");
  }, [workItem.id]);

  useEffect(() => {
    if (!visible) {
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
    // `renderedPipelineSummary` decides the interim state; it must not trigger a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, pipelineSummaryAttempt, visible, workItem.id, workItem.state, workItem.version]);

  return {
    pipelineSummary: renderedPipelineSummary,
    pipelineSummaryState: belongsToWorkItem ? pipelineSummaryState : "loading",
    pipelineSummaryError: belongsToWorkItem ? pipelineSummaryError : null,
    retryPipelineSummary: () => setPipelineSummaryAttempt((value) => value + 1),
  };
}
