/**
 * The web app's single doorway to the shared task-board contract.
 *
 * Only this file imports `@shared/*`; it also documents the wire/view naming
 * hazards:
 *
 *  1. Wire types collide by name with the view types in ./types.ts —
 *     TaskStatus, AgentStatus and RunStatus mean different things on each
 *     side. Wire versions are re-exported with a `Wire` prefix.
 *  2. Two names differ across the boundary: the contract calls them
 *     WakeupReason and AgentTypeEvaluatorProfile; the web calls them
 *     WakeReason and AutomationEvaluatorProfile.
 */

/* —— Shared contract imports —— */

import {
  ACTOR_TYPES,
  AGENT_ROLES,
  AGENT_STATUSES,
  AUTOMATION_CONFIGURATION_MAX_BYTES,
  AUTOMATION_STAGE_ALLOWED_ROLES,
  EVALUATOR_PROFILES,
  GATE_KINDS,
  IDENTIFIER_PATTERN,
  NOTIFICATION_KINDS,
  PARK_CATEGORIES,
  PLAN_REVISION_STATES,
  QUESTION_STATUSES,
  RUN_STATUSES,
  TASK_BOARD_API_VERSION,
  TASK_KINDS,
  TASK_MESSAGE_PAGE_SIZE,
  TASK_MESSAGE_KINDS,
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  TASK_STATUSES,
  STAGE_HANDOFF_OUTCOMES,
  WAKEUP_REASONS,
  WORKER_CONNECTIONS,
  WORK_ITEM_CURSOR_MAX_BYTES,
  WORK_ITEM_PAGE_SIZE,
  WORK_ITEM_PHASES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STAGES,
  WORK_ITEM_STATES,
  WORK_ITEM_TASK_TYPES,
  WORK_NODE_STATES,
  WORKFLOW_STAGES,
  isHardTerminalTaskStatus,
  isRecoverableTaskStatus,
  type AgentStatus,
  type ParkCategory,
  type RunStatus,
  type TaskStatus,
  type WakeupReason,
  type WorkerConnection,
  type WorkflowStage,
} from "@shared/task-board-contract";

/* —— Wire vocabulary aliases —— */

// Prefixed because ./types.ts exports different types under these same three
// names. Importing the wrong one compiles but is silently incorrect.
export type WireAgentStatus = AgentStatus;
export type WireTaskStatus = TaskStatus;
export type WireRunStatus = RunStatus;
export type WireWorkerConnection = WorkerConnection;

// Renamed to the vocabulary the web app already uses.
export type WakeReason = WakeupReason;
export type { ParkCategory, WorkflowStage };
export { isHardTerminalTaskStatus, isRecoverableTaskStatus };

export const apiVersion = TASK_BOARD_API_VERSION;
export const unrecognizedState = "unrecognized" as const;
export const maximumAutomationConfigurationBytes = AUTOMATION_CONFIGURATION_MAX_BYTES;
export const maximumWorkItemCursorBytes = WORK_ITEM_CURSOR_MAX_BYTES;
export const taskMessagePageSize = TASK_MESSAGE_PAGE_SIZE;
export const workItemPageSize = WORK_ITEM_PAGE_SIZE;
export const identifierPattern = new RegExp(IDENTIFIER_PATTERN, "u");

// Array aliases stay intact so view types can derive with `typeof X[number]`.
export const agentRoleValues = AGENT_ROLES;
export const workerConnectionValues = WORKER_CONNECTIONS;
export const taskKindValues = TASK_KINDS;
export const taskPhaseStageValues = TASK_PHASE_STAGES;
export const taskPhaseStatusValues = TASK_PHASE_STATUSES;
export const questionStatusValues = QUESTION_STATUSES;
export const wakeReasonValues = WAKEUP_REASONS;
export const workItemPriorityValues = WORK_ITEM_PRIORITIES;
export const workItemStateValues = WORK_ITEM_STATES;
export const workItemPhaseValues = WORK_ITEM_PHASES;
export const workItemTaskTypeValues = WORK_ITEM_TASK_TYPES;
export const workItemStageValues = WORK_ITEM_STAGES;
export const automationStageAllowedRoles = AUTOMATION_STAGE_ALLOWED_ROLES;
export const evaluatorProfileValues = EVALUATOR_PROFILES;
export const planRevisionStateValues = PLAN_REVISION_STATES;
export const workNodeStateValues = WORK_NODE_STATES;
export const stageHandoffOutcomeValues = STAGE_HANDOFF_OUTCOMES;
export const notificationKindValues = NOTIFICATION_KINDS;
export const parkCategoryValues = PARK_CATEGORIES;
export const gateKindValues = GATE_KINDS;

/* —— Runtime validator sets —— */

/** Runtime validators, derived so a contract change reaches parsing automatically. */
export const rawAgentStatuses = new Set(AGENT_STATUSES);
export const actorTypes = new Set(ACTOR_TYPES);
export const rawWorkerConnections = new Set(workerConnectionValues);
export const rawTaskStatuses = new Set(TASK_STATUSES);
export const rawRunStatuses = new Set(RUN_STATUSES);
export const roles = new Set(agentRoleValues);
export const taskKinds = new Set(taskKindValues);
export const taskPhaseStages = new Set(taskPhaseStageValues);
export const taskPhaseStatuses = new Set(taskPhaseStatusValues);
export const messageKinds = new Set(TASK_MESSAGE_KINDS);
export const questionStatuses = new Set(questionStatusValues);
export const wakeReasons = new Set(wakeReasonValues);
export const workItemPriorities = new Set(workItemPriorityValues);
export const workItemStates = new Set(workItemStateValues);
export const workItemPhases = new Set(workItemPhaseValues);
export const workItemStages = new Set(workItemStageValues);
export const evaluatorProfiles = new Set(evaluatorProfileValues);
export const workflowStages = new Set(WORKFLOW_STAGES);
export const planRevisionStates = new Set(planRevisionStateValues);
export const workNodeStates = new Set(workNodeStateValues);
export const stageHandoffOutcomes = new Set(stageHandoffOutcomeValues);
export const notificationKinds = new Set(notificationKindValues);
export const parkCategories = new Set(parkCategoryValues);
export const gateKinds = new Set(gateKindValues);
