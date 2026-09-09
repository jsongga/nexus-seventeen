/** Loads the proposed workflow a request is waiting on, only while it is awaiting plan approval. */

/* —— Imports —— */

import { useEffect, useState } from "react";
import type { TaskBoardClient } from "../../data/client";
import type { ProjectWorkflow } from "../../types";

/* —— Hook —— */

export interface ProposedWorkflowState {
  readonly workflow: ProjectWorkflow | null;
  readonly workflowState: "idle" | "loading" | "ready" | "error";
  readonly workflowError: string | null;
  readonly retryWorkflow: () => void;
}

/**
 * Idle is a real state, not a missing one: a request outside `plan_approval` has no proposed plan
 * to show, so the load is skipped rather than attempted and failed.
 */
export function useProposedWorkflow(
  client: TaskBoardClient,
  workItem: Readonly<{ id: string; state: string; resolvedProjectId: string | null }>
): ProposedWorkflowState {
  const [workflow, setWorkflow] = useState<ProjectWorkflow | null>(null);
  const [workflowState, setWorkflowState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [workflowAttempt, setWorkflowAttempt] = useState(0);

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

  return {
    workflow,
    workflowState,
    workflowError,
    retryWorkflow: () => setWorkflowAttempt((value) => value + 1),
  };
}
