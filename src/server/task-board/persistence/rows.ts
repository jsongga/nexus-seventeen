import type { SQLOutputValue } from "node:sqlite";
import {
  TASK_BOARD_API_VERSION,
  type AutomationConfiguration,
  type AgentInterrupt,
  type AgentRole,
  type AgentRun,
  type BoardTask,
  type DocumentEvent,
  type DocumentSnapshot,
  type DocumentSummary,
  type HumanQuestion,
  type Project,
  type TaskEvent,
  type TaskKind,
  type TaskMessage,
  type TaskPhase,
  type TaskPhaseStage,
  type TaskPhaseStatus,
  type TaskStatus,
  type UpdateAutomationConfigurationRequest,
  type Wakeup,
  type WorkItem,
  type WorkItemPriority,
  type WorkItemProjectTarget,
  type WorkItemStage,
  type WorkItemState,
} from "#shared/task-board-contract";
import { parseUpdateAutomationConfiguration } from "../schema.js";
import { expectedCompletedAt } from "./timestamps.js";

export type Row = Record<string, SQLOutputValue>;

export function stringValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`TASK_BOARD_DATABASE_CORRUPT:${key}`);
  return value;
}

export function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`TASK_BOARD_DATABASE_CORRUPT:${key}`);
  return value;
}

export function numberValue(row: Row, key: string): number {
  const value = row[key];
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new Error(`TASK_BOARD_DATABASE_CORRUPT:${key}`);
  }
  return number;
}

function nullableNumberValue(row: Row, key: string): number | null {
  if (row[key] === null) return null;
  return numberValue(row, key);
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`TASK_BOARD_DATABASE_CORRUPT:${label}`);
  }
}

export function projectFromRow(row: Row): Project {
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    projectId: stringValue(row, "project_id"),
    name: stringValue(row, "name"),
    description: stringValue(row, "description"),
    version: numberValue(row, "version"),
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
  });
}

export function workItemFromRow(row: Row): WorkItem {
  const mode = stringValue(row, "project_target_mode");
  const targetProjectId = nullableString(row, "target_project_id");
  let projectTarget: WorkItemProjectTarget;
  if (mode === "auto" && targetProjectId === null) {
    projectTarget = Object.freeze({ mode: "auto" });
  } else if (mode === "explicit" && targetProjectId !== null) {
    projectTarget = Object.freeze({ mode: "explicit", projectId: targetProjectId });
  } else {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:project_target");
  }
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    workItemId: stringValue(row, "work_item_id"),
    originalRequest: stringValue(row, "original_request"),
    refinedObjective: nullableString(row, "refined_objective"),
    priority: stringValue(row, "priority") as WorkItemPriority,
    projectTarget,
    resolvedProjectId: nullableString(row, "resolved_project_id"),
    planningTaskId: nullableString(row, "planning_task_id"),
    state: stringValue(row, "state") as WorkItemState,
    currentStage: nullableString(row, "current_stage") as WorkItemStage | null,
    createdBy: stringValue(row, "created_by"),
    version: numberValue(row, "version"),
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
    endedAt: nullableString(row, "ended_at"),
    cancelledReason: nullableString(row, "cancelled_reason"),
    archivedAt: nullableString(row, "archived_at"),
  });
}

export function automationConfigurationFromRow(row: Row): AutomationConfiguration {
  if (stringValue(row, "configuration_id") !== "company-default") {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:automation_configuration_id");
  }
  let parsed: UpdateAutomationConfigurationRequest;
  try {
    parsed = parseUpdateAutomationConfiguration({
      version: numberValue(row, "version"),
      agentTypes: parseJson<unknown>(stringValue(row, "agent_types_json"), "agent_types_json"),
      stages: parseJson<unknown>(stringValue(row, "stages_json"), "stages_json"),
    });
  } catch {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:automation_configuration");
  }
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    configurationId: "company-default",
    agentTypes: parsed.agentTypes,
    stages: parsed.stages,
    version: parsed.version,
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
    updatedBy: stringValue(row, "updated_by"),
  });
}

function documentPenFromRow(row: Row): DocumentSnapshot["penHolder"] {
  const actorType = nullableString(row, "pen_holder_actor_type");
  if (actorType === null) return null;
  return Object.freeze({
    actorType: actorType as "human" | "agent",
    actorId: stringValue(row, "pen_holder_actor_id"),
    clientId: stringValue(row, "pen_holder_client_id"),
    acquiredAt: stringValue(row, "pen_acquired_at"),
  });
}

export function documentSummaryFromRow(row: Row): DocumentSummary {
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    documentId: stringValue(row, "document_id"),
    projectId: stringValue(row, "project_id"),
    title: stringValue(row, "title"),
    contentType: "text/markdown",
    contentVersion: numberValue(row, "content_version"),
    penEpoch: numberValue(row, "pen_epoch"),
    penHolder: documentPenFromRow(row),
    sequence: numberValue(row, "sequence"),
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
  });
}

export function documentFromRow(row: Row): DocumentSnapshot {
  return Object.freeze({
    ...documentSummaryFromRow(row),
    content: stringValue(row, "content"),
  });
}

export function documentEventFromRow(row: Row): DocumentEvent {
  const document = parseJson<DocumentSnapshot>(stringValue(row, "document_json"), "document_json");
  if (
    document.apiVersion !== TASK_BOARD_API_VERSION ||
    typeof document.documentId !== "string" ||
    typeof document.content !== "string" ||
    !Number.isSafeInteger(document.sequence)
  ) {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:document_json");
  }
  const penHolder = document.penHolder === null ? null : Object.freeze({ ...document.penHolder });
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    eventId: stringValue(row, "event_id"),
    documentId: stringValue(row, "document_id"),
    projectId: stringValue(row, "project_id"),
    sequence: numberValue(row, "sequence"),
    eventType: stringValue(row, "event_type") as DocumentEvent["eventType"],
    actorType: stringValue(row, "actor_type") as "human" | "agent",
    actorId: stringValue(row, "actor_id"),
    clientId: stringValue(row, "client_id"),
    document: Object.freeze({ ...document, penHolder }),
    createdAt: stringValue(row, "created_at"),
  });
}

export function phaseFromRow(row: Row): TaskPhase {
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    phaseId: stringValue(row, "phase_id"),
    projectId: stringValue(row, "project_id"),
    taskId: stringValue(row, "task_id"),
    title: stringValue(row, "title"),
    stage: stringValue(row, "stage") as TaskPhaseStage,
    status: stringValue(row, "status") as TaskPhaseStatus,
    parallelGroup: nullableString(row, "parallel_group"),
    orderKey: numberValue(row, "order_key"),
    startedAt: nullableString(row, "started_at"),
    endedAt: nullableString(row, "ended_at"),
    version: numberValue(row, "version"),
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
  });
}

export function taskFromRow(row: Row, phases: readonly TaskPhase[] = []): BoardTask {
  const startedAt = nullableString(row, "started_at");
  const status = stringValue(row, "status") as TaskStatus;
  const minutes = nullableNumberValue(row, "agent_estimate_minutes");
  const estimateRecordedAt = nullableString(row, "estimate_recorded_at");
  if ((minutes === null) !== (estimateRecordedAt === null)) {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:agent_estimate");
  }
  const refs = parseJson<unknown>(stringValue(row, "workspace_refs_json"), "workspace_refs_json");
  if (!Array.isArray(refs) || refs.some((value) => typeof value !== "string")) {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:workspace_refs_json");
  }
  const requiresReviewValue = numberValue(row, "requires_review");
  if (requiresReviewValue !== 0 && requiresReviewValue !== 1) {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:requires_review");
  }
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    taskId: stringValue(row, "task_id"),
    projectId: stringValue(row, "project_id"),
    parentTaskId: nullableString(row, "parent_task_id"),
    kind: stringValue(row, "task_kind") as TaskKind,
    requiredRole: nullableString(row, "required_role") as AgentRole | null,
    requiresReview: requiresReviewValue === 1,
    title: stringValue(row, "title"),
    objective: stringValue(row, "objective"),
    acceptanceCriteria: stringValue(row, "acceptance_criteria"),
    workspaceRefs: Object.freeze([...refs] as string[]),
    status,
    assignedAgentId: nullableString(row, "assigned_agent_id"),
    assignedRole: nullableString(row, "assigned_role") as AgentRole | null,
    expectedAgentMinutes: minutes,
    estimateRecordedAt,
    orderKey: numberValue(row, "order_key"),
    phases: Object.freeze([...phases]),
    startedAt,
    expectedCompletedAt: expectedCompletedAt(status, startedAt, estimateRecordedAt, minutes),
    endedAt: nullableString(row, "ended_at"),
    result: nullableString(row, "result"),
    version: numberValue(row, "version"),
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
  });
}

export function messageFromRow(row: Row): TaskMessage {
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    messageId: stringValue(row, "message_id"),
    sequence: numberValue(row, "sequence"),
    projectId: stringValue(row, "project_id"),
    taskId: stringValue(row, "task_id"),
    runId: nullableString(row, "run_id"),
    actorType: stringValue(row, "actor_type") as "human" | "agent",
    actorId: stringValue(row, "actor_id"),
    kind: stringValue(row, "kind") as TaskMessage["kind"],
    body: stringValue(row, "body"),
    createdAt: stringValue(row, "created_at"),
  });
}

export function questionFromRow(row: Row): HumanQuestion {
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    questionId: stringValue(row, "question_id"),
    projectId: stringValue(row, "project_id"),
    taskId: stringValue(row, "task_id"),
    agentId: stringValue(row, "agent_id"),
    runId: stringValue(row, "run_id"),
    question: stringValue(row, "question"),
    status: stringValue(row, "status") as HumanQuestion["status"],
    answer: nullableString(row, "answer"),
    askedAt: stringValue(row, "asked_at"),
    answeredAt: nullableString(row, "answered_at"),
    answeredBy: nullableString(row, "answered_by"),
    version: numberValue(row, "version"),
  });
}

export function wakeupFromRow(row: Row): Wakeup {
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    wakeupId: stringValue(row, "wakeup_id"),
    projectId: stringValue(row, "project_id"),
    agentId: stringValue(row, "agent_id"),
    reason: stringValue(row, "reason") as Wakeup["reason"],
    taskId: nullableString(row, "task_id"),
    questionId: nullableString(row, "question_id"),
    detail: stringValue(row, "detail"),
    createdBy: stringValue(row, "created_by"),
    createdAt: stringValue(row, "created_at"),
    claimedAt: nullableString(row, "claimed_at"),
    runId: nullableString(row, "run_id"),
  });
}

export function runFromRow(row: Row): AgentRun {
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    runId: stringValue(row, "run_id"),
    claimId: stringValue(row, "claim_id"),
    projectId: stringValue(row, "project_id"),
    agentId: stringValue(row, "agent_id"),
    wakeupId: stringValue(row, "wakeup_id"),
    taskId: nullableString(row, "task_id"),
    status: stringValue(row, "status") as AgentRun["status"],
    startedAt: stringValue(row, "started_at"),
    endedAt: nullableString(row, "ended_at"),
    result: nullableString(row, "result"),
  });
}

export function interruptFromRow(row: Row): AgentInterrupt {
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    sequence: numberValue(row, "sequence"),
    interruptId: stringValue(row, "interrupt_id"),
    projectId: stringValue(row, "project_id"),
    agentId: stringValue(row, "agent_id"),
    runId: nullableString(row, "run_id"),
    reason: stringValue(row, "reason"),
    requestedBy: stringValue(row, "requested_by"),
    requestedAt: stringValue(row, "requested_at"),
  });
}

export function eventFromRow(row: Row): TaskEvent {
  const data = parseJson<unknown>(stringValue(row, "data_json"), "data_json");
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:data_json");
  }
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    eventId: stringValue(row, "event_id"),
    projectId: stringValue(row, "project_id"),
    taskId: nullableString(row, "task_id"),
    actorType: stringValue(row, "actor_type") as TaskEvent["actorType"],
    actorId: stringValue(row, "actor_id"),
    eventType: stringValue(row, "event_type"),
    data: Object.freeze(data as Record<string, unknown>),
    createdAt: stringValue(row, "created_at"),
  });
}
