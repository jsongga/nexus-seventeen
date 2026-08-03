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
import {
  AGENT_ROLES,
  AGENT_STATUSES,
  AUTOMATION_CONFIGURATION_MAX_BYTES,
  DOCUMENT_ACTOR_TYPES,
  EVALUATOR_PROFILES,
  QUESTION_STATUSES,
  RUN_STATUSES,
  TASK_BOARD_API_VERSION,
  TASK_KINDS,
  TASK_MESSAGE_KINDS,
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  TASK_STATUSES,
  WAKEUP_REASONS,
  WORKER_CONNECTIONS,
  WORK_ITEM_CURSOR_MAX_BYTES,
  WORK_ITEM_PAGE_SIZE,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STAGES,
  WORK_ITEM_STATES,
  type AgentStatus,
  type RunStatus,
  type TaskStatus,
  type WakeupReason,
  type WorkerConnection,
} from '@shared/task-board-contract';

// Prefixed because ./types.ts exports different types under these same three
// names. Importing the wrong one compiles but is silently incorrect.
export type WireAgentStatus = AgentStatus;
export type WireTaskStatus = TaskStatus;
export type WireRunStatus = RunStatus;
export type WireWorkerConnection = WorkerConnection;

// Renamed to the vocabulary the web app already uses.
export type WakeReason = WakeupReason;

export const apiVersion = TASK_BOARD_API_VERSION;
export const maximumAutomationConfigurationBytes = AUTOMATION_CONFIGURATION_MAX_BYTES;
export const maximumWorkItemCursorBytes = WORK_ITEM_CURSOR_MAX_BYTES;
export const workItemPageSize = WORK_ITEM_PAGE_SIZE;

/** Runtime validators, derived so a contract change reaches parsing automatically. */
export const rawAgentStatuses = new Set(AGENT_STATUSES);
export const rawWorkerConnections = new Set(WORKER_CONNECTIONS);
export const rawTaskStatuses = new Set(TASK_STATUSES);
export const rawRunStatuses = new Set(RUN_STATUSES);
export const roles = new Set(AGENT_ROLES);
export const taskKinds = new Set(TASK_KINDS);
export const taskPhaseStages = new Set(TASK_PHASE_STAGES);
export const taskPhaseStatuses = new Set(TASK_PHASE_STATUSES);
export const messageKinds = new Set(TASK_MESSAGE_KINDS);
export const questionStatuses = new Set(QUESTION_STATUSES);
export const wakeReasons = new Set(WAKEUP_REASONS);
export const workItemPriorities = new Set(WORK_ITEM_PRIORITIES);
export const workItemStates = new Set(WORK_ITEM_STATES);
export const workItemStages = new Set(WORK_ITEM_STAGES);
export const evaluatorProfiles = new Set(EVALUATOR_PROFILES);
export const documentActorTypes = new Set(DOCUMENT_ACTOR_TYPES);
