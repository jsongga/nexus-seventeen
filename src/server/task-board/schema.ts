/** HTTP/request adapter for the shared task-board runtime validator. */
import {
  ContractValidationError,
  parseBoardAgentMessage,
  parseBoardAnswer,
  parseBoardApprovePipelineMerge,
  parseBoardAttestDeploy,
  parseBoardAutomationUpdate,
  parseBoardBacklogTask,
  parseBoardClaim,
  parseBoardConfirmPlan,
  parseBoardCreateAgent,
  parseBoardCreateRepository,
  parseBoardCreateProject,
  parseBoardUpdateProject,
  parseBoardUpdateRepository,
  parseBoardCreateTask,
  parseBoardCreateTaskPhase,
  parseBoardCreateWorkItem,
  parseBoardHumanMessage,
  parseBoardIdempotencyKey,
  parseBoardIdentifier,
  parseBoardInterrupt,
  parseBoardLaneErrorDetail,
  parseBoardQuestion,
  parseBoardRejectPlan,
  parseBoardRejectFinalApproval,
  parseBoardResume,
  parseBoardRetryTask,
  parseBoardRotateAgentToken,
  parseBoardSettle,
  parseBoardUpdateTask,
  parseBoardUpdateTaskPhase,
  parseBoardUpdateWorkItem,
  parseFindingsLedger as parseFindingsLedgerContract,
  parseParksLedger as parseParksLedgerContract,
  parseWorkItemAudit as parseWorkItemAuditContract,
} from "#shared/task-board-contract/validate";
import type {
  AnswerHumanQuestionRequest,
  ApprovePipelineMergeRequest,
  AttestDeployRequest,
  BacklogTaskRequest,
  ClaimRunRequest,
  ConfirmPlanRevisionRequest,
  CreateAgentRequest,
  CreateRepositoryRequest,
  CreateHumanQuestionRequest,
  CreateHumanTaskMessageRequest,
  CreateProjectRequest,
  UpdateProjectRequest,
  UpdateRepositoryRequest,
  CreateTaskMessageRequest,
  CreateTaskPhaseRequest,
  CreateTaskRequest,
  CreateWorkItemRequest,
  FindingsLedger,
  InterruptAgentRequest,
  ParksLedger,
  RejectPlanRevisionRequest,
  RejectFinalApprovalRequest,
  ResumeAgentRequest,
  RetryTaskRequest,
  RotateAgentTokenRequest,
  SettleRunRequest,
  UpdateAutomationConfigurationRequest,
  UpdateTaskPhaseRequest,
  UpdateTaskRequest,
  UpdateWorkItemRequest,
  WorkItemAudit,
} from "#shared/task-board-contract";
import { TaskBoardError } from "./errors.js";
import { MAX_SAFE_ERROR_DETAIL_CHARACTERS, safeErrorDetail } from "../shared/redact.js";

function adapt<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new TaskBoardError(400, error.code, error.message, { cause: error });
    }
    throw error;
  }
}

export function parseIdentifier(value: unknown, field: string): string {
  return adapt(() => parseBoardIdentifier(value, field));
}

export function parseCreateProject(value: unknown): CreateProjectRequest {
  return adapt(() => parseBoardCreateProject(value));
}
export function parseUpdateProject(value: unknown): UpdateProjectRequest {
  return adapt(() => parseBoardUpdateProject(value));
}
export function parseUpdateRepository(value: unknown): UpdateRepositoryRequest {
  return adapt(() => parseBoardUpdateRepository(value));
}
export function parseConfirmPlanRevisionRequest(value: unknown): ConfirmPlanRevisionRequest {
  return adapt(() => parseBoardConfirmPlan(value));
}
export function parseRejectPlanRevisionRequest(value: unknown): RejectPlanRevisionRequest {
  return adapt(() => parseBoardRejectPlan(value));
}
export function parseApprovePipelineMergeRequest(value: unknown): ApprovePipelineMergeRequest {
  return adapt(() => parseBoardApprovePipelineMerge(value));
}
export function parseAttestDeployRequest(value: unknown): AttestDeployRequest {
  return adapt(() => parseBoardAttestDeploy(value));
}
export function parseRejectFinalApprovalRequest(value: unknown): RejectFinalApprovalRequest {
  return adapt(() => parseBoardRejectFinalApproval(value));
}
export function parseCreateWorkItem(value: unknown): CreateWorkItemRequest {
  return adapt(() => parseBoardCreateWorkItem(value));
}
export function parseUpdateWorkItem(value: unknown): UpdateWorkItemRequest {
  return adapt(() => parseBoardUpdateWorkItem(value));
}
export function parseUpdateAutomationConfiguration(value: unknown): UpdateAutomationConfigurationRequest {
  return adapt(() => parseBoardAutomationUpdate(value));
}
export function parseCreateAgent(value: unknown): CreateAgentRequest {
  return adapt(() => parseBoardCreateAgent(value));
}
export function parseCreateRepository(value: unknown): CreateRepositoryRequest {
  return adapt(() => parseBoardCreateRepository(value));
}
export function parseRotateAgentToken(value: unknown): RotateAgentTokenRequest {
  return adapt(() => parseBoardRotateAgentToken(value));
}
export function parseCreateTask(value: unknown): CreateTaskRequest {
  return adapt(() => parseBoardCreateTask(value));
}
export function parseCreateTaskPhase(value: unknown): CreateTaskPhaseRequest {
  return adapt(() => parseBoardCreateTaskPhase(value));
}
export function parseUpdateTaskPhase(value: unknown): UpdateTaskPhaseRequest {
  return adapt(() => parseBoardUpdateTaskPhase(value));
}
export function parseUpdateTask(value: unknown): UpdateTaskRequest {
  return adapt(() => parseBoardUpdateTask(value));
}
export function parseRetryTask(value: unknown): RetryTaskRequest {
  return adapt(() => parseBoardRetryTask(value));
}
export function parseBacklogTask(value: unknown): BacklogTaskRequest {
  return adapt(() => parseBoardBacklogTask(value));
}
export function parseAgentMessage(value: unknown): CreateTaskMessageRequest {
  return adapt(() => parseBoardAgentMessage(value));
}
export function parseHumanMessage(value: unknown): CreateHumanTaskMessageRequest {
  return adapt(() => parseBoardHumanMessage(value));
}
export function parseQuestion(value: unknown): CreateHumanQuestionRequest {
  return adapt(() => parseBoardQuestion(value));
}
export function parseAnswer(value: unknown): AnswerHumanQuestionRequest {
  return adapt(() => parseBoardAnswer(value));
}
export function parseResume(value: unknown): ResumeAgentRequest {
  return adapt(() => parseBoardResume(value));
}
export function parseInterrupt(value: unknown): InterruptAgentRequest {
  return adapt(() => parseBoardInterrupt(value));
}
export function parseClaim(value: unknown): ClaimRunRequest {
  return adapt(() => parseBoardClaim(value));
}
export function parseSettle(value: unknown): SettleRunRequest {
  return adapt(() => parseBoardSettle(value));
}
export function parseIdempotencyKey(value: string | string[] | undefined): string {
  return adapt(() => parseBoardIdempotencyKey(value));
}
export function parseWorkItemAudit(value: unknown): WorkItemAudit {
  return adapt(() => parseWorkItemAuditContract(value, "workItemAudit"));
}
export function parseFindingsLedger(value: unknown): FindingsLedger {
  return adapt(() => parseFindingsLedgerContract(value, "findingsLedger"));
}
export function parseParksLedger(value: unknown): ParksLedger {
  return adapt(() => parseParksLedgerContract(value, "parksLedger"));
}

function pauseRequestObject(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${label} request must be an object`);
  }
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${label} request has unexpected or missing fields`);
  }
  return item;
}

function pauseVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "version is invalid");
  }
  return value as number;
}

export function parseBoardPauseRequest(value: unknown): Readonly<{
  reason: string | null;
  version: number;
}> {
  const item = pauseRequestObject(value, ["reason", "version"], "Board pause");
  let reason: string | null = null;
  if (item.reason !== null) {
    if (typeof item.reason !== "string") {
      throw new TaskBoardError(400, "INVALID_REQUEST", "reason is invalid");
    }
    reason = item.reason.trim();
    if (reason.length < 1 || item.reason.length > 500 || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(item.reason)) {
      throw new TaskBoardError(400, "INVALID_REQUEST", "reason is invalid");
    }
  }
  return Object.freeze({ reason, version: pauseVersion(item.version) });
}

export function parseBoardResumeRequest(value: unknown): Readonly<{ version: number }> {
  const item = pauseRequestObject(value, ["version"], "Board resume");
  return Object.freeze({ version: pauseVersion(item.version) });
}

export function parseNotificationRead(value: unknown): Readonly<{ version: number }> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Notification read request must be an object");
  }
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 1 || !("version" in item)) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Notification read request has unexpected or missing fields");
  }
  if (!Number.isSafeInteger(item.version) || (item.version as number) < 1) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "version is invalid");
  }
  return Object.freeze({ version: item.version as number });
}

export function parseLaneError(value: unknown): Readonly<{ detail: string | null }> {
  const detail = adapt(() => parseBoardLaneErrorDetail(value, MAX_SAFE_ERROR_DETAIL_CHARACTERS));
  return Object.freeze({ detail: detail === null ? null : safeErrorDetail(detail, "Task fleet lane failed") });
}
