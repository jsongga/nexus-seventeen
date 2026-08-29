import type { PipelineSummary, PlanRecordFields, PlanRevision, ReviewFinding } from '@shared/task-board-contract';
import type {
  BoardChildWorkItem,
  BoardWorkItem,
  BoardWorkItemDependency,
  ParkCategory,
  ProjectWorkflow,
  TaskStatus,
  WorkflowNode,
  WorkflowPlan,
  WorkItemPhase,
  WorkItemState,
} from '../types';

export type DetailedWorkflowPlan = WorkflowPlan & PlanRecordFields & Pick<PlanRevision, 'rejectedNote'>;

interface WorkItemDetailAffordances {
  answerQuestion: boolean;
  confirmPlan: boolean;
  rejectPlan: boolean;
  cancel: boolean;
  archive: boolean;
}

export interface DecompositionAffordances {
  approveAndMergeChildren: boolean;
  resumeCoordination: boolean;
  resumeAfterBaseChange: boolean;
  attestDeployment: boolean;
}

export function deriveDecompositionAffordances(input: {
  workItemState: WorkItemState;
  parentWorkItemId: string | null;
  phase: WorkItemPhase | null;
  hasChildren: boolean;
  phasedFamily: boolean;
  childFailed: boolean;
  deployAttested: boolean;
  parkCategory?: ParkCategory | null;
}): DecompositionAffordances {
  const attestablePhase = input.phase === 'expand' || input.phase === 'migrate';
  const decomposedParent = input.parentWorkItemId === null && input.hasChildren;
  return {
    approveAndMergeChildren: decomposedParent
      && !input.phasedFamily
      && input.workItemState === 'final_approval',
    resumeCoordination: decomposedParent
      && input.workItemState === 'parked'
      && !(input.phasedFamily && input.childFailed),
    resumeAfterBaseChange: input.workItemState === 'parked'
      && input.parkCategory === 'base_diverged',
    attestDeployment: input.parentWorkItemId !== null
      && attestablePhase
      && input.workItemState === 'merged'
      && !input.deployAttested,
  };
}

/**
 * Produces a stable refetch key from only the opened decomposition family.
 * Unrelated board activity must not blank or disable family controls.
 */
export function decompositionFamilyVersionKey(
  workItem: BoardWorkItem,
  snapshotWorkItems: readonly BoardWorkItem[],
): string {
  const parentId = workItem.parentWorkItemId ?? workItem.id;
  const family = new Map<string, BoardWorkItem>();
  family.set(workItem.id, workItem);
  for (const candidate of snapshotWorkItems) {
    if (candidate.id === parentId || candidate.parentWorkItemId === parentId) {
      family.set(candidate.id, candidate);
    }
  }
  return [...family.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((candidate) => `${candidate.id}:${candidate.version}`)
    .join('|');
}

export interface ContractDependencyStatus {
  child: BoardChildWorkItem;
  direct: boolean;
  ready: boolean;
}

export function contractApprovalIsReady(
  phase: WorkItemPhase | null,
  state: 'loading' | 'ready' | 'error',
  statuses: readonly ContractDependencyStatus[],
): boolean {
  return phase === 'contract'
    && state === 'ready'
    && statuses.length > 0
    && statuses.every((status) => status.ready);
}

/** Contract readiness is transitive over every non-Contract sibling. */
export function contractDependencyStatuses(
  contractWorkItemId: string,
  siblings: readonly BoardChildWorkItem[],
  dependencies: readonly BoardWorkItemDependency[],
): ContractDependencyStatus[] {
  const directDependencies = new Set(dependencies
    .filter((dependency) => dependency.workItemId === contractWorkItemId)
    .map((dependency) => dependency.dependsOnWorkItemId));
  return siblings
    .filter((sibling) => sibling.id !== contractWorkItemId && sibling.phase !== 'contract')
    .sort((left, right) => (left.childOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.childOrdinal ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id))
    .map((child) => ({
      child,
      direct: directDependencies.has(child.id),
      ready: child.state === 'merged' && child.deployAttested,
    }));
}

export function deriveWorkItemDetailAffordances(input: {
  workItemState: WorkItemState;
  planningTaskState: TaskStatus | null;
  archived: boolean;
}): WorkItemDetailAffordances {
  if (input.archived) {
    return {
      answerQuestion: false,
      confirmPlan: false,
      rejectPlan: false,
      cancel: false,
      archive: false,
    };
  }

  if (input.workItemState === 'unrecognized') {
    return {
      answerQuestion: false,
      confirmPlan: false,
      rejectPlan: false,
      cancel: false,
      archive: false,
    };
  }

  const terminal = input.workItemState === 'merged'
    || input.workItemState === 'dead_letter'
    || input.workItemState === 'abandoned';
  if (terminal) {
    return {
      answerQuestion: false,
      confirmPlan: false,
      rejectPlan: false,
      cancel: false,
      archive: true,
    };
  }

  return {
    answerQuestion: input.workItemState === 'parked' && input.planningTaskState === 'waiting_for_human',
    confirmPlan: input.workItemState === 'plan_approval' && input.planningTaskState === 'completed',
    rejectPlan: input.workItemState === 'plan_approval' && input.planningTaskState === 'completed',
    cancel: true,
    archive: false,
  };
}

export function proposedPlanForWorkItem(workflow: ProjectWorkflow, workItemId: string): DetailedWorkflowPlan | null {
  return (workflow.plans as DetailedWorkflowPlan[])
    .filter((plan) => plan.workItemId === workItemId && plan.state === 'proposed')
    .sort((left, right) => right.revision - left.revision)[0] ?? null;
}

export function nodesForPlan(workflow: ProjectWorkflow, planRevisionId: string): WorkflowNode[] {
  return workflow.nodes.filter((node) => node.planRevisionId === planRevisionId);
}

export function pipelineFileReview(summary: PipelineSummary): Array<Readonly<{
  file: string;
  outsideScope: boolean;
}>> {
  const scope = summary.declaredScope.map((prefix) => prefix.replace(/\/+$/u, ''));
  return summary.filesTouched.map((file) => ({
    file,
    outsideScope: !scope.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)),
  }));
}

export function pipelineAssumptionReview(summary: PipelineSummary): Array<Readonly<{
  assumption: string;
  addedMidRun: boolean;
}>> {
  return [
    ...summary.assumptions.map((assumption) => ({ assumption, addedMidRun: false })),
    ...summary.midRunAssumptions.map((assumption) => ({ assumption, addedMidRun: true })),
  ];
}

export function pipelineFindingRounds(findings: readonly ReviewFinding[]): Array<Readonly<{
  round: number;
  findings: readonly ReviewFinding[];
}>> {
  const byRound = new Map<number, ReviewFinding[]>();
  for (const finding of [...findings].sort((left, right) =>
    left.round - right.round
    || left.createdAt.localeCompare(right.createdAt)
    || left.findingId.localeCompare(right.findingId))) {
    const round = byRound.get(finding.round) ?? [];
    round.push(finding);
    byRound.set(finding.round, round);
  }
  return [...byRound].map(([round, roundFindings]) => ({
    round,
    findings: roundFindings,
  }));
}
