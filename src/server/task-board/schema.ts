/** HTTP/request adapter for the shared task-board runtime validator. */
import {
  ContractValidationError,
  parseBoardAgentMessage,
  parseBoardAnswer,
  parseBoardAutomationUpdate,
  parseBoardBacklogTask,
  parseBoardClaim,
  parseBoardConfirmPlan,
  parseBoardCreateAgent,
  parseBoardCreateDocument,
  parseBoardCreateProject,
  parseBoardCreateTask,
  parseBoardCreateTaskPhase,
  parseBoardCreateWorkItem,
  parseBoardDocumentPenUpdate,
  parseBoardDocumentUpdate,
  parseBoardHumanMessage,
  parseBoardIdempotencyKey,
  parseBoardIdentifier,
  parseBoardInterrupt,
  parseBoardLaneErrorDetail,
  parseBoardQuestion,
  parseBoardResume,
  parseBoardRetryTask,
  parseBoardRotateAgentToken,
  parseBoardSettle,
  parseBoardUpdateTask,
  parseBoardUpdateTaskPhase,
  parseBoardUpdateWorkItem,
} from "#shared/task-board-contract/validate";
import type {
  AnswerHumanQuestionRequest,
  BacklogTaskRequest,
  ClaimRunRequest,
  ConfirmPlanRevisionRequest,
  CreateAgentRequest,
  CreateDocumentRequest,
  CreateHumanQuestionRequest,
  CreateHumanTaskMessageRequest,
  CreateProjectRequest,
  CreateTaskMessageRequest,
  CreateTaskPhaseRequest,
  CreateTaskRequest,
  CreateWorkItemRequest,
  InterruptAgentRequest,
  ResumeAgentRequest,
  RetryTaskRequest,
  RotateAgentTokenRequest,
  SettleRunRequest,
  UpdateAutomationConfigurationRequest,
  UpdateDocumentPenRequest,
  UpdateDocumentRequest,
  UpdateTaskPhaseRequest,
  UpdateTaskRequest,
  UpdateWorkItemRequest,
} from "#shared/task-board-contract";
import { TaskBoardError } from "./errors.js";
import { MAX_SAFE_ERROR_DETAIL_CHARACTERS, safeErrorDetail } from "../shared/safe-error-detail.js";

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

export function parseCreateProject(value: unknown): CreateProjectRequest { return adapt(() => parseBoardCreateProject(value)); }
export function parseConfirmPlanRevisionRequest(value: unknown): ConfirmPlanRevisionRequest { return adapt(() => parseBoardConfirmPlan(value)); }
export function parseCreateWorkItem(value: unknown): CreateWorkItemRequest { return adapt(() => parseBoardCreateWorkItem(value)); }
export function parseUpdateWorkItem(value: unknown): UpdateWorkItemRequest { return adapt(() => parseBoardUpdateWorkItem(value)); }
export function parseUpdateAutomationConfiguration(value: unknown): UpdateAutomationConfigurationRequest { return adapt(() => parseBoardAutomationUpdate(value)); }
export function parseCreateAgent(value: unknown): CreateAgentRequest { return adapt(() => parseBoardCreateAgent(value)); }
export function parseRotateAgentToken(value: unknown): RotateAgentTokenRequest { return adapt(() => parseBoardRotateAgentToken(value)); }
export function parseCreateTask(value: unknown): CreateTaskRequest { return adapt(() => parseBoardCreateTask(value)); }
export function parseCreateTaskPhase(value: unknown): CreateTaskPhaseRequest { return adapt(() => parseBoardCreateTaskPhase(value)); }
export function parseUpdateTaskPhase(value: unknown): UpdateTaskPhaseRequest { return adapt(() => parseBoardUpdateTaskPhase(value)); }
export function parseCreateDocument(value: unknown): CreateDocumentRequest { return adapt(() => parseBoardCreateDocument(value)); }
export function parseDocumentPenUpdate(value: unknown): UpdateDocumentPenRequest { return adapt(() => parseBoardDocumentPenUpdate(value)); }
export function parseDocumentUpdate(value: unknown): UpdateDocumentRequest { return adapt(() => parseBoardDocumentUpdate(value)); }
export function parseUpdateTask(value: unknown): UpdateTaskRequest { return adapt(() => parseBoardUpdateTask(value)); }
export function parseRetryTask(value: unknown): RetryTaskRequest { return adapt(() => parseBoardRetryTask(value)); }
export function parseBacklogTask(value: unknown): BacklogTaskRequest { return adapt(() => parseBoardBacklogTask(value)); }
export function parseAgentMessage(value: unknown): CreateTaskMessageRequest { return adapt(() => parseBoardAgentMessage(value)); }
export function parseHumanMessage(value: unknown): CreateHumanTaskMessageRequest { return adapt(() => parseBoardHumanMessage(value)); }
export function parseQuestion(value: unknown): CreateHumanQuestionRequest { return adapt(() => parseBoardQuestion(value)); }
export function parseAnswer(value: unknown): AnswerHumanQuestionRequest { return adapt(() => parseBoardAnswer(value)); }
export function parseResume(value: unknown): ResumeAgentRequest { return adapt(() => parseBoardResume(value)); }
export function parseInterrupt(value: unknown): InterruptAgentRequest { return adapt(() => parseBoardInterrupt(value)); }
export function parseClaim(value: unknown): ClaimRunRequest { return adapt(() => parseBoardClaim(value)); }
export function parseSettle(value: unknown): SettleRunRequest { return adapt(() => parseBoardSettle(value)); }
export function parseIdempotencyKey(value: string | string[] | undefined): string { return adapt(() => parseBoardIdempotencyKey(value)); }

export function parseLaneError(value: unknown): Readonly<{ detail: string | null }> {
  const detail = adapt(() => parseBoardLaneErrorDetail(value, MAX_SAFE_ERROR_DETAIL_CHARACTERS));
  return Object.freeze({ detail: detail === null ? null : safeErrorDetail(detail, "Task fleet lane failed") });
}
