/**
 * Project workflow reads and plan confirmation.
 *
 * Deliberately not rendered by the current ProjectPage design, which shows the
 * documents, pipeline and activity regions only. Kept exported so the behaviour
 * survives and can be re-surfaced without being rebuilt.
 */
import type { TaskBoardClient } from './client';
import type { ProjectWorkflow, WorkflowPlan as PlanRevision } from './types';

export function fetchProjectWorkflow(
  client: TaskBoardClient,
  projectId: string,
  signal: AbortSignal,
): Promise<ProjectWorkflow | null> {
  return client.getProjectWorkflow(projectId, signal);
}

export function confirmPlan(client: TaskBoardClient, planRevisionId: string): Promise<ProjectWorkflow> {
  return client.confirmWorkflow(planRevisionId);
}

export function proposedPlans(workflow: ProjectWorkflow | null): PlanRevision[] {
  return workflow?.plans.filter((plan) => plan.state === 'proposed') ?? [];
}
