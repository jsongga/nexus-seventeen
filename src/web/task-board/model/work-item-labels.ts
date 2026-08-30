import type { NOTIFICATION_KINDS, ParkCategory } from "@shared/task-board-contract";
import type { BoardWorkItem, TaskStatus, WorkItemStage, WorkItemState } from "../types";

export type WorkItemTone = "neutral" | "green" | "amber" | "red" | "blue" | "purple";
export const unknownStateLabel = "Unknown state — refresh the app";

export const parkCategoryLabel: Record<ParkCategory | "unrecognized", string> = {
  open_question: "Open question",
  planning_run_failed: "Planning run failed",
  design_run_failed: "Design run failed",
  hazardous_without_pipeline: "Hazardous without pipeline",
  plan_rejected_twice: "Plan rejected twice",
  bright_line: "Bright line",
  scope_violation: "Scope violation",
  stage_cap_exceeded: "Stage cap exceeded",
  task_cap_exceeded: "Task cap exceeded",
  base_diverged: "Base diverged",
  child_failed: "Child failed",
  unrecognized: "Unknown category",
};

export const notificationKindLabel: Record<(typeof NOTIFICATION_KINDS)[number] | "unrecognized", string> = {
  park_aged: "Park aged",
  park_auto_abandoned: "Park auto-abandoned",
  cap_parked: "Cap parked",
  final_approval_withdrawn: "Final approval withdrawn",
  parent_ready_for_approval: "Parent ready for approval",
  phase_ready: "Phase ready",
  unrecognized: "Unknown notification",
};

export const workItemStateTone: Record<WorkItemState, WorkItemTone> = {
  queued: "blue",
  planning: "green",
  plan_approval: "amber",
  coordinating: "purple",
  designing: "green",
  implementing: "green",
  verifying: "green",
  reviewing: "green",
  fixing: "amber",
  final_approval: "amber",
  merged: "green",
  parked: "amber",
  abandoned: "neutral",
  dead_letter: "red",
  unrecognized: "neutral",
};

export const workItemStateLabel: Record<WorkItemState | "unrecognized", string> = {
  queued: "Queued",
  planning: "Planning",
  plan_approval: "Plan review",
  coordinating: "Coordinating",
  designing: "Design",
  implementing: "Implementing",
  verifying: "Verifying",
  reviewing: "Reviewing",
  fixing: "Fixing",
  final_approval: "Final review",
  merged: "Done",
  parked: "Parked",
  abandoned: "Cancelled",
  dead_letter: "Failed",
  unrecognized: unknownStateLabel,
};

export const taskStatusTone: Record<TaskStatus, WorkItemTone> = {
  proposed: "purple",
  backlog: "neutral",
  queued: "blue",
  running: "green",
  waiting_for_human: "amber",
  blocked: "amber",
  completed: "green",
  failed: "red",
  interrupted: "red",
  cancelled: "neutral",
  unrecognized: "neutral",
};

export const workItemStageLabel: Record<WorkItemStage, string> = {
  refinement: "Improving task",
  project_resolution: "Resolving project",
  research: "Researching",
  planning: "Planning",
  implementation: "Implementing",
  testing: "Testing",
  verification: "Verifying",
  human_review: "Preparing human review",
  deployment: "Deploying",
};

export function prettyStatus(value: string): string {
  return value.replaceAll("_", " ");
}

export function workItemStatusLabel(workItem: BoardWorkItem): string {
  return workItemStateLabel[workItem.state];
}
