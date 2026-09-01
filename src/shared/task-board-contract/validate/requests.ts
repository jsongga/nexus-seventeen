/** Validates inbound board requests before anything else sees them. */

/* —— Imports —— */

import {
  AGENT_GAP_REPORT_MAX_CHARACTERS,
  AGENT_ROLES,
  AUTOMATION_CONFIGURATION_MAX_BYTES,
  AUTOMATION_STAGE_ALLOWED_ROLES,
  type AgentRole,
  type AnswerHumanQuestionRequest,
  type ApprovePipelineMergeRequest,
  type AttestDeployRequest,
  type AutomationAgentType,
  type AutomationPipelineStage,
  type AutomationStageExecutor,
  type BacklogTaskRequest,
  type ClaimRunRequest,
  type ConfirmPlanRevisionRequest,
  ContractValidationError,
  type CreateAgentRequest,
  type CreateHumanQuestionRequest,
  type CreateHumanTaskMessageRequest,
  type CreateProjectRequest,
  type CreateTaskMessageRequest,
  type CreateTaskPhaseRequest,
  type CreateTaskRequest,
  type CreateWorkItemRequest,
  EVALUATOR_PROFILES,
  type InterruptAgentRequest,
  type RejectFinalApprovalRequest,
  type RejectPlanRevisionRequest,
  type ResumeAgentRequest,
  type RetryTaskRequest,
  type RotateAgentTokenRequest,
  type SettleRunRequest,
  TASK_BOARD_ERROR_CODES,
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  TASK_STATUSES,
  type TaskPhaseStage,
  type TaskPhaseStatus,
  type TaskStatus,
  type UpdateAutomationConfigurationRequest,
  type UpdateProjectRequest,
  type UpdateTaskPhaseRequest,
  type UpdateTaskRequest,
  type UpdateWorkItemRequest,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STAGES,
  WORK_ITEM_TASK_TYPES,
  type WorkItemProjectTarget,
} from "../index.js";
import { expectedMinutes, parseDesignRecordDraft, parseReviewFindingDraftList } from "./entities.js";
import { BOARD_DRAFT_POLICY, parseHandoffDraft, parseWorkflowPlan } from "./plans.js";
import {
  GENERIC_EXACT_MESSAGES,
  type JsonRecord,
  NAMED_EXACT_MESSAGES,
  contractMember,
  exact,
  identifier,
  integer,
  record,
  text,
} from "./scalars.js";

/* —— Board request boundary —— */

function boardFailure(message: string, code = "INVALID_REQUEST"): never {
  throw new ContractValidationError(message, code);
}

function boardExact(value: unknown, fields: readonly string[], label: string, named = false): JsonRecord {
  return exact(value, fields, label, { messages: named ? NAMED_EXACT_MESSAGES : GENERIC_EXACT_MESSAGES });
}

function boardAllowed(
  value: unknown,
  fields: readonly string[],
  required: readonly string[],
  label: string
): JsonRecord {
  return exact(value, fields, label, { messages: GENERIC_EXACT_MESSAGES, required });
}

export function parseBoardIdentifier(value: unknown, field: string): string {
  return identifier(value, field, `${field} is invalid`);
}

function boardText(value: unknown, field: string, maximum = 8_000): string {
  return text(value, field, { maximum, message: `${field} is invalid` });
}

function boardPositiveVersion(value: unknown): number {
  return integer(value, "version", 1, "version must be a positive safe integer");
}

function boardNonNegative(value: unknown, field: string): number {
  return integer(value, field, 0, `${field} must be a non-negative safe integer`);
}

function boardRole(value: unknown, field = "role"): AgentRole {
  return contractMember(value, AGENT_ROLES, field, `${field} is invalid`);
}

function boardNullableIdentifier(value: unknown, field: string): string | null {
  return value === null ? null : parseBoardIdentifier(value, field);
}

function boardNullableRole(value: unknown, field: string): AgentRole | null {
  return value === null ? null : boardRole(value, field);
}

function boardRefs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 32)
    boardFailure("workspaceRefs must be an array with at most 32 entries");
  const parsed = value.map((item, index) => boardText(item, `workspaceRefs[${index}]`, 512));
  if (new Set(parsed).size !== parsed.length) boardFailure("workspaceRefs contains a duplicate");
  return Object.freeze(parsed);
}

function boardProjectTarget(value: unknown): Extract<WorkItemProjectTarget, { mode: "explicit" }> {
  const item = record(value, "projectTarget");
  if (item.mode === "auto") {
    boardExact(item, ["mode"], "Automatic project target");
    boardFailure("Choose a project", TASK_BOARD_ERROR_CODES.PROJECT_REQUIRED);
  }
  if (item.mode === "explicit") {
    const explicit = boardExact(item, ["mode", "projectId"], "Explicit project target");
    return Object.freeze({ mode: "explicit", projectId: parseBoardIdentifier(explicit.projectId, "projectId") });
  }
  boardFailure("projectTarget mode is invalid");
}

export function parseBoardCreateProject(value: unknown): CreateProjectRequest {
  const raw = record(value, "Project");
  const item = boardExact(value, ["name", "description", ...("repoPath" in raw ? ["repoPath"] : [])], "Project");
  const description = boardText(item.description, "description", 8_000);
  return Object.freeze({
    name: boardText(item.name, "name", 160),
    description,
    repoPath: item.repoPath === undefined ? description : boardRepoPath(item.repoPath),
  });
}

function boardRepoPath(value: unknown): string {
  const repoPath = boardText(value, "repoPath", 8_000);
  if (!repoPath.startsWith("/")) boardFailure("repoPath must be an absolute path");
  return repoPath;
}

export function parseBoardUpdateProject(value: unknown): UpdateProjectRequest {
  const raw = record(value, "Project update");
  const fields = ["name", "description", "repoPath"].filter((field) => field in raw);
  if (fields.length === 0) boardFailure("Project update must include name, description, or repoPath");
  const item = boardExact(value, fields, "Project update");
  return Object.freeze({
    ...(item.name === undefined ? {} : { name: boardText(item.name, "name", 160) }),
    ...(item.description === undefined ? {} : { description: boardText(item.description, "description", 8_000) }),
    ...(item.repoPath === undefined ? {} : { repoPath: boardRepoPath(item.repoPath) }),
  });
}

export function parseBoardConfirmPlan(value: unknown): ConfirmPlanRevisionRequest {
  const item = boardExact(value, ["expectedState"], "Plan confirmation", true);
  if (item.expectedState !== "proposed") boardFailure("expectedState must be proposed");
  return Object.freeze({ expectedState: "proposed" });
}

export function parseBoardRejectPlan(value: unknown): RejectPlanRevisionRequest {
  const item = boardExact(value, ["note", "expectedState"], "Plan rejection", true);
  if (item.expectedState !== "proposed") boardFailure("expectedState must be proposed");
  return Object.freeze({
    note: boardText(item.note, "note", 2_000),
    expectedState: "proposed",
  });
}

export function parseBoardApprovePipelineMerge(value: unknown): ApprovePipelineMergeRequest {
  const item = boardExact(value, ["version"], "Pipeline merge approval", true);
  return Object.freeze({ version: boardPositiveVersion(item.version) });
}

export function parseBoardAttestDeploy(value: unknown): AttestDeployRequest {
  const item = boardAllowed(value, ["note"], [], "Deploy attestation");
  return Object.freeze({
    ...(item.note === undefined || item.note === "" ? {} : { note: boardText(item.note, "note", 2_000) }),
  });
}

export function parseBoardRejectFinalApproval(value: unknown): RejectFinalApprovalRequest {
  const item = boardExact(value, ["version", "note"], "Final approval rejection", true);
  return Object.freeze({
    version: boardPositiveVersion(item.version),
    note: boardText(item.note, "note", 2_000),
  });
}

export function parseBoardCreateWorkItem(value: unknown): CreateWorkItemRequest {
  const item = boardAllowed(
    value,
    ["originalRequest", "priority", "taskType", "projectTarget"],
    ["originalRequest"],
    "Work item"
  );
  const taskType =
    item.taskType === undefined
      ? "standard"
      : contractMember(item.taskType, WORK_ITEM_TASK_TYPES, "taskType", "taskType is invalid");
  if (item.projectTarget === undefined) {
    boardFailure(
      "Choose a project",
      taskType === "onboarding"
        ? TASK_BOARD_ERROR_CODES.ONBOARDING_PROJECT_REQUIRED
        : TASK_BOARD_ERROR_CODES.PROJECT_REQUIRED
    );
  }
  return Object.freeze({
    originalRequest: boardText(item.originalRequest, "originalRequest", 16_000),
    priority:
      item.priority === undefined
        ? "normal"
        : contractMember(item.priority, WORK_ITEM_PRIORITIES, "priority", "priority is invalid"),
    taskType,
    projectTarget: boardProjectTarget(item.projectTarget),
  });
}

export function parseBoardUpdateWorkItem(value: unknown): UpdateWorkItemRequest {
  const item = boardAllowed(
    value,
    ["version", "priority", "projectTarget", "action", "reason"],
    ["version"],
    "Work item update"
  );
  if (Object.keys(item).length === 1) boardFailure("Work item update contains no changes");
  const version = boardPositiveVersion(item.version);
  if ("action" in item) {
    if (item.action === "cancel") {
      if (Object.keys(item).length !== 3 || !("reason" in item)) {
        boardFailure("Work item cancellation requires only version, action, and reason");
      }
      return Object.freeze({ version, action: "cancel", reason: boardText(item.reason, "reason", 16_000) });
    }
    if (item.action === "archive") {
      if (Object.keys(item).length !== 2) boardFailure("Work item archive requires only version and action");
      return Object.freeze({ version, action: "archive" });
    }
    boardFailure("Work item action is invalid");
  }
  if ("reason" in item) boardFailure("reason is only valid for cancellation");
  const result: {
    version: number;
    priority?: (typeof WORK_ITEM_PRIORITIES)[number];
    projectTarget?: Extract<WorkItemProjectTarget, { mode: "explicit" }>;
  } = { version };
  if ("priority" in item)
    result.priority = contractMember(item.priority, WORK_ITEM_PRIORITIES, "priority", "priority is invalid");
  if ("projectTarget" in item) result.projectTarget = boardProjectTarget(item.projectTarget);
  return Object.freeze(result);
}

function boardSkillIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[a-z0-9][a-z0-9._:-]*$/u.test(value)) {
    boardFailure(`${field} is invalid`);
  }
  return value;
}

function parseBoardAutomationAgentType(value: unknown, index: number): AutomationAgentType {
  const label = `agentTypes[${index}]`;
  const item = boardExact(
    value,
    [
      "agentTypeId",
      "name",
      "description",
      "role",
      "supplementalInstructions",
      "skillIds",
      "evaluatorProfile",
      "enabled",
    ],
    label
  );
  if (!Array.isArray(item.skillIds) || item.skillIds.length > 32)
    boardFailure(`${label}.skillIds must be an array with at most 32 entries`);
  const skillIds = item.skillIds.map((entry, skillIndex) =>
    boardSkillIdentifier(entry, `${label}.skillIds[${skillIndex}]`)
  );
  if (new Set(skillIds).size !== skillIds.length) boardFailure(`${label}.skillIds contains a duplicate`);
  if (typeof item.enabled !== "boolean") boardFailure(`${label}.enabled must be a boolean`);
  const supplementalInstructions = text(item.supplementalInstructions, `${label}.supplementalInstructions`, {
    maximum: 8_000,
    allowEmpty: true,
    message: `${label}.supplementalInstructions is invalid`,
  });
  if (item.enabled && supplementalInstructions.length === 0) {
    boardFailure(`${label}.supplementalInstructions is required for an enabled agent type`);
  }
  return Object.freeze({
    agentTypeId: parseBoardIdentifier(item.agentTypeId, `${label}.agentTypeId`),
    name: boardText(item.name, `${label}.name`, 160),
    description: boardText(item.description, `${label}.description`, 4_000),
    role: boardRole(item.role, `${label}.role`),
    supplementalInstructions,
    skillIds: Object.freeze(skillIds),
    evaluatorProfile: contractMember(
      item.evaluatorProfile,
      EVALUATOR_PROFILES,
      "evaluatorProfile",
      "evaluatorProfile is invalid"
    ),
    enabled: item.enabled,
  });
}

function parseBoardAutomationExecutor(value: unknown, label: string): AutomationStageExecutor {
  const item = record(value, label);
  if (item.kind === "agent_type") {
    const parsed = boardExact(item, ["kind", "agentTypeId"], label);
    return Object.freeze({
      kind: "agent_type",
      agentTypeId: parseBoardIdentifier(parsed.agentTypeId, `${label}.agentTypeId`),
    });
  }
  if (item.kind === "machine_verify" || item.kind === "human" || item.kind === "disabled") {
    boardExact(item, ["kind"], label);
    return Object.freeze({ kind: item.kind });
  }
  boardFailure(`${label}.kind is invalid`);
}

function parseBoardAutomationStages(
  value: unknown,
  agentTypes: readonly AutomationAgentType[]
): readonly AutomationPipelineStage[] {
  if (!Array.isArray(value) || value.length !== WORK_ITEM_STAGES.length) {
    boardFailure(`stages must contain exactly ${WORK_ITEM_STAGES.length} entries`);
  }
  const stages = value.map((candidate, index): AutomationPipelineStage => {
    const label = `stages[${index}]`;
    const item = boardExact(candidate, ["stage", "executor"], label);
    const stage = WORK_ITEM_STAGES[index];
    if (stage === undefined || item.stage !== stage)
      boardFailure("stages must use the canonical order without duplicates");
    return Object.freeze({ stage, executor: parseBoardAutomationExecutor(item.executor, `${label}.executor`) });
  });
  const types = new Map(agentTypes.map((entry) => [entry.agentTypeId, entry] as const));
  for (const entry of stages) {
    if (entry.executor.kind === "machine_verify" && entry.stage !== "testing") {
      boardFailure(`${entry.stage} cannot use the machine_verify executor`);
    }
    if (entry.stage === "human_review") {
      if (entry.executor.kind !== "human") boardFailure("human_review must use the human executor");
      continue;
    }
    if (entry.stage === "deployment") {
      if (entry.executor.kind !== "disabled") boardFailure("deployment must remain disabled");
      continue;
    }
    if (entry.executor.kind === "human") boardFailure(`${entry.stage} cannot use the human executor`);
    if (entry.executor.kind === "disabled" || entry.executor.kind === "machine_verify") continue;
    const agentType = types.get(entry.executor.agentTypeId);
    if (agentType === undefined) boardFailure(`${entry.stage} references an unknown agent type`);
    if (!agentType.enabled) boardFailure(`${entry.stage} references a disabled agent type`);
    const roles: readonly AgentRole[] = AUTOMATION_STAGE_ALLOWED_ROLES[entry.stage];
    if (!roles.includes(agentType.role))
      boardFailure(`${entry.stage} cannot use an agent type with the ${agentType.role} role`);
  }
  return Object.freeze(stages);
}

export function parseBoardAutomationUpdate(value: unknown): UpdateAutomationConfigurationRequest {
  const item = boardExact(value, ["version", "agentTypes", "stages"], "Automation configuration update");
  if (!Array.isArray(item.agentTypes) || item.agentTypes.length > 32)
    boardFailure("agentTypes must be an array with at most 32 entries");
  const agentTypes = item.agentTypes.map(parseBoardAutomationAgentType);
  if (new Set(agentTypes.map((entry) => entry.agentTypeId)).size !== agentTypes.length)
    boardFailure("agentTypes contains a duplicate agentTypeId");
  const stages = parseBoardAutomationStages(item.stages, agentTypes);
  if (
    new TextEncoder().encode(JSON.stringify({ agentTypes, stages })).byteLength > AUTOMATION_CONFIGURATION_MAX_BYTES
  ) {
    boardFailure(`Automation configuration exceeds ${AUTOMATION_CONFIGURATION_MAX_BYTES} UTF-8 JSON bytes`);
  }
  return Object.freeze({ version: boardPositiveVersion(item.version), agentTypes: Object.freeze(agentTypes), stages });
}

export function parseBoardCreateAgent(value: unknown): CreateAgentRequest {
  const item = boardExact(value, ["agentId", "role", "area", "mission", "model", "token"], "Agent profile");
  if (
    typeof item.token !== "string" ||
    item.token.length < 32 ||
    item.token.length > 512 ||
    item.token.trim() !== item.token ||
    /[\u0000-\u001f\u007f]/u.test(item.token)
  ) {
    boardFailure("token is invalid");
  }
  return Object.freeze({
    agentId: parseBoardIdentifier(item.agentId, "agentId"),
    role: boardRole(item.role),
    area: boardText(item.area, "area", 256),
    mission: boardText(item.mission, "mission", 4_000),
    model: parseBoardIdentifier(item.model, "model"),
    token: item.token,
  });
}

export function parseBoardRotateAgentToken(value: unknown): RotateAgentTokenRequest {
  const item = boardExact(value, ["version"], "Agent token rotation");
  return Object.freeze({ version: boardPositiveVersion(item.version) });
}

export function parseBoardCreateTask(value: unknown): CreateTaskRequest {
  const item = boardAllowed(
    value,
    [
      "parentTaskId",
      "title",
      "objective",
      "acceptanceCriteria",
      "workspaceRefs",
      "assignedAgentId",
      "assignedRole",
      "requiresReview",
      "expectedAgentMinutes",
    ],
    ["parentTaskId", "title", "objective", "acceptanceCriteria", "workspaceRefs", "assignedAgentId", "assignedRole"],
    "Task"
  );
  const assignedAgentId = boardNullableIdentifier(item.assignedAgentId, "assignedAgentId");
  const assignedRole = boardNullableRole(item.assignedRole, "assignedRole");
  if ((assignedAgentId === null) !== (assignedRole === null)) {
    boardFailure("assignedAgentId and assignedRole must both be set or both be null", "INVALID_ASSIGNMENT");
  }
  if ("expectedAgentMinutes" in item)
    expectedMinutes(item.expectedAgentMinutes, "expectedAgentMinutes", {
      maximum: 10_080,
      message: (field) => `${field} must be a 15-minute interval between 15 and 10080`,
      code: "INVALID_EXPECTED_AGENT_MINUTES",
    });
  if ("requiresReview" in item && typeof item.requiresReview !== "boolean")
    boardFailure("requiresReview must be a boolean");
  return Object.freeze({
    parentTaskId: boardNullableIdentifier(item.parentTaskId, "parentTaskId"),
    title: boardText(item.title, "title", 240),
    objective: boardText(item.objective, "objective", 8_000),
    acceptanceCriteria: boardText(item.acceptanceCriteria, "acceptanceCriteria", 8_000),
    workspaceRefs: boardRefs(item.workspaceRefs),
    assignedAgentId,
    assignedRole,
    requiresReview: item.requiresReview === undefined ? true : (item.requiresReview as boolean),
  });
}

export function parseBoardCreateTaskPhase(value: unknown): CreateTaskPhaseRequest {
  const item = boardExact(value, ["title", "stage", "parallelGroup"], "Task phase");
  return Object.freeze({
    title: boardText(item.title, "title", 240),
    stage: contractMember(item.stage, TASK_PHASE_STAGES, "stage", "stage is invalid"),
    parallelGroup: boardNullableIdentifier(item.parallelGroup, "parallelGroup"),
  });
}

export function parseBoardUpdateTaskPhase(value: unknown): UpdateTaskPhaseRequest {
  const item = boardAllowed(
    value,
    ["version", "title", "stage", "status", "parallelGroup", "orderKey"],
    ["version"],
    "Task phase update"
  );
  if (Object.keys(item).length === 1) boardFailure("Task phase update contains no changes");
  const result: {
    version: number;
    title?: string;
    stage?: TaskPhaseStage;
    status?: TaskPhaseStatus;
    parallelGroup?: string | null;
    orderKey?: number;
  } = { version: boardPositiveVersion(item.version) };
  if ("title" in item) result.title = boardText(item.title, "title", 240);
  if ("stage" in item) result.stage = contractMember(item.stage, TASK_PHASE_STAGES, "stage", "stage is invalid");
  if ("status" in item)
    result.status = contractMember(item.status, TASK_PHASE_STATUSES, "phase status", "phase status is invalid");
  if ("parallelGroup" in item) result.parallelGroup = boardNullableIdentifier(item.parallelGroup, "parallelGroup");
  if ("orderKey" in item) result.orderKey = boardNonNegative(item.orderKey, "orderKey");
  return Object.freeze(result);
}

export function parseBoardUpdateTask(value: unknown): UpdateTaskRequest {
  const item = boardAllowed(
    value,
    [
      "version",
      "title",
      "objective",
      "acceptanceCriteria",
      "workspaceRefs",
      "assignedAgentId",
      "assignedRole",
      "expectedAgentMinutes",
      "orderKey",
      "status",
      "result",
    ],
    ["version"],
    "Task update"
  );
  if (Object.keys(item).length === 1) boardFailure("Task update contains no changes");
  if ("assignedAgentId" in item !== "assignedRole" in item)
    boardFailure("Assignment fields must be updated together", "INVALID_ASSIGNMENT");
  const result: {
    version: number;
    title?: string;
    objective?: string;
    acceptanceCriteria?: string;
    workspaceRefs?: readonly string[];
    assignedAgentId?: string | null;
    assignedRole?: AgentRole | null;
    expectedAgentMinutes?: number | null;
    orderKey?: number;
    status?: TaskStatus;
    result?: string | null;
  } = { version: boardPositiveVersion(item.version) };
  if ("title" in item) result.title = boardText(item.title, "title", 240);
  if ("objective" in item) result.objective = boardText(item.objective, "objective", 8_000);
  if ("acceptanceCriteria" in item)
    result.acceptanceCriteria = boardText(item.acceptanceCriteria, "acceptanceCriteria", 8_000);
  if ("workspaceRefs" in item) result.workspaceRefs = boardRefs(item.workspaceRefs);
  if ("assignedAgentId" in item) {
    result.assignedAgentId = boardNullableIdentifier(item.assignedAgentId, "assignedAgentId");
    result.assignedRole = boardNullableRole(item.assignedRole, "assignedRole");
    if ((result.assignedAgentId === null) !== (result.assignedRole === null)) {
      boardFailure("Assignment fields must both be set or both be null", "INVALID_ASSIGNMENT");
    }
  }
  if ("expectedAgentMinutes" in item)
    result.expectedAgentMinutes = expectedMinutes(item.expectedAgentMinutes, "expectedAgentMinutes", {
      nullable: true,
      maximum: 10_080,
      message: (field) => `${field} must be a 15-minute interval between 15 and 10080`,
      code: "INVALID_EXPECTED_AGENT_MINUTES",
    });
  if ("orderKey" in item) result.orderKey = boardNonNegative(item.orderKey, "orderKey");
  if ("status" in item) result.status = contractMember(item.status, TASK_STATUSES, "status", "status is invalid");
  if ("result" in item) result.result = item.result === null ? null : boardText(item.result, "result", 16_000);
  return Object.freeze(result);
}

export function parseBoardRetryTask(value: unknown): RetryTaskRequest {
  const item = boardExact(value, ["version"], "Task retry");
  return Object.freeze({ version: boardPositiveVersion(item.version) });
}

export function parseBoardBacklogTask(value: unknown): BacklogTaskRequest {
  const item = boardExact(value, ["version"], "Task backlog transition");
  return Object.freeze({ version: boardPositiveVersion(item.version) });
}

export function parseBoardAgentMessage(value: unknown): CreateTaskMessageRequest {
  const item = boardExact(value, ["clientEventId", "kind", "body", "runId"], "Agent task message");
  if (item.kind !== "progress" && item.kind !== "proposal" && item.kind !== "result")
    boardFailure("Agent message kind is invalid");
  return Object.freeze({
    clientEventId: parseBoardIdentifier(item.clientEventId, "clientEventId"),
    kind: item.kind,
    body: boardText(item.body, "body", 16_000),
    runId: parseBoardIdentifier(item.runId, "runId"),
  });
}

export function parseBoardHumanMessage(value: unknown): CreateHumanTaskMessageRequest {
  const item = boardExact(value, ["clientEventId", "kind", "body"], "Human task message");
  if (item.kind !== "note") boardFailure("Human messages must use note kind");
  return Object.freeze({
    clientEventId: parseBoardIdentifier(item.clientEventId, "clientEventId"),
    kind: "note",
    body: boardText(item.body, "body", 16_000),
  });
}

export function parseBoardQuestion(value: unknown): CreateHumanQuestionRequest {
  const item = boardExact(value, ["clientEventId", "question", "runId"], "Human question");
  return Object.freeze({
    clientEventId: parseBoardIdentifier(item.clientEventId, "clientEventId"),
    question: boardText(item.question, "question", 8_000),
    runId: parseBoardIdentifier(item.runId, "runId"),
  });
}

export function parseBoardAnswer(value: unknown): AnswerHumanQuestionRequest {
  const item = boardExact(value, ["answer", "version"], "Question answer");
  return Object.freeze({
    answer: boardText(item.answer, "answer", 16_000),
    version: boardPositiveVersion(item.version),
  });
}

export function parseBoardResume(value: unknown): ResumeAgentRequest {
  const item = boardExact(value, ["reason", "taskId"], "Agent resume");
  return Object.freeze({
    reason: boardText(item.reason, "reason", 2_000),
    taskId: boardNullableIdentifier(item.taskId, "taskId"),
  });
}

export function parseBoardInterrupt(value: unknown): InterruptAgentRequest {
  const item = boardExact(value, ["reason"], "Agent interrupt");
  return Object.freeze({ reason: boardText(item.reason, "reason", 2_000) });
}

export function parseBoardLaneErrorDetail(value: unknown, maximum: number): string | null {
  const item = boardExact(value, ["detail"], "Agent lane error");
  return item.detail === null ? null : boardText(item.detail, "detail", maximum);
}

export function parseBoardClaim(value: unknown): ClaimRunRequest {
  const item = record(value, "Run claim");
  const keys = Object.keys(item).sort();
  const requestKeys = keys.filter((key) => key !== "pinned");
  const legacy = requestKeys.length === 2 && requestKeys[0] === "claimId" && requestKeys[1] === "messageCursor";
  const perTask = requestKeys.length === 2 && requestKeys[0] === "claimId" && requestKeys[1] === "messageCursors";
  const hasPinned = "pinned" in item;
  if (!legacy && !perTask) boardFailure("Run claim has unexpected or missing fields");
  const claimId = parseBoardIdentifier(item.claimId, "claimId");
  let pinned: ClaimRunRequest["pinned"];
  if (hasPinned) {
    const rawPinned = boardAllowed(
      item.pinned,
      ["runtime", "runtimeVersion", "model", "promptsSha"],
      [],
      "Run claim pinned"
    );
    const parsed: { runtime?: string; runtimeVersion?: string; model?: string; promptsSha?: string } = {};
    for (const field of ["runtime", "runtimeVersion", "model", "promptsSha"] as const) {
      if (!(field in rawPinned)) continue;
      const candidate = rawPinned[field];
      if (
        typeof candidate !== "string" ||
        candidate.length < 1 ||
        candidate.length > 128 ||
        /[\u0000-\u001f\u007f]/u.test(candidate)
      ) {
        boardFailure(`${field} is invalid`);
      }
      parsed[field] = candidate;
    }
    pinned = Object.freeze(parsed);
  }
  if (legacy) {
    const cursor = item.messageCursor;
    if (cursor !== null && (!Number.isSafeInteger(cursor) || Number(cursor) < 0)) {
      boardFailure("messageCursor must be null or a non-negative safe integer");
    }
    return Object.freeze({
      claimId,
      messageCursor: cursor === null ? null : Number(cursor),
      ...(pinned === undefined ? {} : { pinned }),
    });
  }
  if (item.messageCursors === null || typeof item.messageCursors !== "object" || Array.isArray(item.messageCursors)) {
    boardFailure("messageCursors must be an object with at most 256 task entries");
  }
  const rawCursors = record(item.messageCursors, "messageCursors");
  if (Object.keys(rawCursors).length > 256)
    boardFailure("messageCursors must be an object with at most 256 task entries");
  const messageCursors: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [taskId, cursor] of Object.entries(rawCursors)) {
    parseBoardIdentifier(taskId, "messageCursors taskId");
    if (!Number.isSafeInteger(cursor) || Number(cursor) < 0)
      boardFailure("messageCursors values must be non-negative safe integers");
    messageCursors[taskId] = Number(cursor);
  }
  return Object.freeze({
    claimId,
    messageCursors: Object.freeze(messageCursors),
    ...(pinned === undefined ? {} : { pinned }),
  });
}

export function parseBoardSettle(value: unknown): SettleRunRequest {
  const raw = record(value, "Run settlement");
  const item = boardExact(
    value,
    [
      "outcome",
      "result",
      ...("gapReport" in raw ? ["gapReport"] : []),
      ...("handoff" in raw ? ["handoff"] : []),
      ...("workflowPlan" in raw ? ["workflowPlan"] : []),
      ...("reviewFindings" in raw ? ["reviewFindings"] : []),
      ...("designRecord" in raw ? ["designRecord"] : []),
    ],
    "Run settlement"
  );
  if (item.outcome !== "completed" && item.outcome !== "failed" && item.outcome !== "interrupted")
    boardFailure("Run outcome is invalid");
  return Object.freeze({
    outcome: item.outcome,
    result: boardText(item.result, "result", 16_000),
    ...(item.gapReport === undefined
      ? {}
      : {
          gapReport: boardText(item.gapReport, "gapReport", AGENT_GAP_REPORT_MAX_CHARACTERS),
        }),
    handoff:
      item.handoff === undefined || item.handoff === null ? null : parseHandoffDraft(item.handoff, BOARD_DRAFT_POLICY),
    workflowPlan:
      item.workflowPlan === undefined || item.workflowPlan === null
        ? null
        : parseWorkflowPlan(item.workflowPlan, BOARD_DRAFT_POLICY),
    ...(item.reviewFindings === undefined
      ? {}
      : {
          reviewFindings: parseReviewFindingDraftList(item.reviewFindings, "reviewFindings"),
        }),
    ...(item.designRecord === undefined || item.designRecord === null
      ? {}
      : {
          designRecord: (() => {
            try {
              return parseDesignRecordDraft(item.designRecord);
            } catch (error) {
              if (error instanceof ContractValidationError) {
                throw new ContractValidationError(
                  error.message,
                  TASK_BOARD_ERROR_CODES.TASK_BOARD_DESIGN_RECORD_REQUIRED
                );
              }
              throw error;
            }
          })(),
        }),
  });
}

export function parseBoardIdempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) {
    boardFailure("A valid Idempotency-Key header is required", "INVALID_IDEMPOTENCY_KEY");
  }
  return value;
}
