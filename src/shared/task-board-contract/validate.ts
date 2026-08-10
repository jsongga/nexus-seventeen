import {
  ACTOR_TYPES,
  AGENT_ROLES,
  AGENT_STATUSES,
  AUTOMATION_CONFIGURATION_MAX_BYTES,
  DOCUMENT_CONTENT_MAX_BYTES,
  DOCUMENT_ACTOR_TYPES,
  EVALUATOR_PROFILES,
  IDENTIFIER_PATTERN,
  PLAN_REVISION_STATES,
  QUESTION_STATUSES,
  RUN_STATUSES,
  STAGE_HANDOFF_OUTCOMES,
  TASK_BOARD_API_VERSION,
  TASK_BOARD_ERROR_CODES,
  TASK_KINDS,
  TASK_MESSAGE_KINDS,
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  TASK_STATUSES,
  WAKEUP_REASONS,
  WORKER_CONNECTIONS,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STAGES,
  WORK_ITEM_STATES,
  WORK_NODE_STATES,
  WORKFLOW_STAGES,
  type AgentInterrupt,
  type AgentProfile,
  type AgentRole,
  type AgentRun,
  type AnswerHumanQuestionRequest,
  type AutomationAgentType,
  type AutomationConfiguration,
  type AutomationPipelineStage,
  type AutomationStageExecutor,
  type BoardSnapshot,
  type BoardTask,
  type BacklogTaskRequest,
  type ClaimRunResult,
  type ClaimRunRequest,
  type ConfirmPlanRevisionRequest,
  type CriterionResult,
  type CreateAgentRequest,
  type CreateDocumentRequest,
  type CreateHumanQuestionRequest,
  type CreateHumanTaskMessageRequest,
  type CreateProjectRequest,
  type CreateTaskMessageRequest,
  type CreateTaskPhaseRequest,
  type CreateTaskRequest,
  type CreateWorkItemRequest,
  type DocumentPenHolder,
  type DocumentSnapshot,
  type DocumentSummary,
  type HumanQuestion,
  type InterruptAgentRequest,
  type PlanRevision,
  type Project,
  type ProjectArtifact,
  type ProjectEvent,
  type ResumeAgentRequest,
  type RetryTaskRequest,
  type RotateAgentTokenRequest,
  type SettleRunRequest,
  type SkillSnapshot,
  type StageHandoff,
  type StageHandoffDraft,
  type TaskEvent,
  type TaskKind,
  type TaskMessage,
  type TaskPhase,
  type TaskPhaseStage,
  type TaskPhaseStatus,
  type TaskStatus,
  type UpdateAutomationConfigurationRequest,
  type UpdateDocumentPenRequest,
  type UpdateDocumentRequest,
  type UpdateTaskPhaseRequest,
  type UpdateTaskRequest,
  type UpdateWorkItemRequest,
  type Wakeup,
  type WorkItem,
  type WorkItemProjectTarget,
  type WorkNode,
  type WorkflowStage,
  type WorkflowPlanDraft,
} from "./index.js";

export type JsonRecord = Record<string, unknown>;

export class ContractValidationError extends Error {
  constructor(
    message: string,
    readonly code = "INVALID_REQUEST",
  ) {
    super(message);
    this.name = "ContractValidationError";
  }
}

export interface ExactMessageMap {
  readonly unexpected: (label: string, field: string) => string;
  readonly missing: (label: string, field: string) => string;
}

export const GENERIC_EXACT_MESSAGES: ExactMessageMap = Object.freeze({
  unexpected: (label: string) => `${label} has unexpected or missing fields`,
  missing: (label: string) => `${label} has unexpected or missing fields`,
});

export const NAMED_EXACT_MESSAGES: ExactMessageMap = Object.freeze({
  unexpected: (label: string, field: string) => `${label} has unexpected field ${field}`,
  missing: (label: string, field: string) => `${label} is missing field ${field}`,
});

export const PATH_EXACT_MESSAGES: ExactMessageMap = Object.freeze({
  unexpected: (label: string, field: string) => `${label}.${field} is not supported`,
  missing: (label: string, field: string) => `${label}.${field} is required`,
});

export interface FieldSetOptions {
  readonly messages?: ExactMessageMap;
  readonly required?: readonly string[];
}

export function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContractValidationError(`${label} must be an object`);
  }
  return value as JsonRecord;
}

/** Validate both the permitted and required field sets without sorting user-controlled keys. */
export function exact(
  value: unknown,
  fields: readonly string[],
  label: string,
  options: FieldSetOptions = {},
): JsonRecord {
  const item = record(value, label);
  const messages = options.messages ?? GENERIC_EXACT_MESSAGES;
  const permitted = new Set(fields);
  const unexpected = Object.keys(item).find((key) => !permitted.has(key));
  if (unexpected !== undefined) throw new ContractValidationError(messages.unexpected(label, unexpected));
  const required = options.required ?? fields;
  const missing = required.find((key) => !(key in item));
  if (missing !== undefined) throw new ContractValidationError(messages.missing(label, missing));
  return item;
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ContractValidationError(`${label} must be a string`);
  return value;
}

export interface ScalarMessageProfile {
  readonly stringType: (label: string) => string;
  readonly integerAtLeast: (label: string, minimum: number) => string;
}

/** Browser responses historically reported scalar type errors before semantic errors. */
export const BROWSER_SCALAR_MESSAGES: ScalarMessageProfile = Object.freeze({
  stringType: (label: string) => `${label} must be a string`,
  integerAtLeast: (label: string, minimum: number) => `${label} must be a safe integer of at least ${minimum}`,
});

export interface TextOptions {
  readonly maximum?: number;
  readonly allowEmpty?: boolean;
  readonly trim?: boolean;
  readonly message?: string;
  readonly scalarMessages?: ScalarMessageProfile;
  /** Production worker writes normalize at `normalizeCarriageReturns` in task-worker/worker.ts. */
  readonly carriageReturns?: "reject" | "normalize" | "preserve";
}

/** Human-entered board text: trim at the boundary and reject control characters. */
export function text(value: unknown, label: string, options: TextOptions = {}): string {
  const maximum = options.maximum ?? 8_000;
  if (typeof value !== "string") {
    throw new ContractValidationError(options.scalarMessages?.stringType(label) ?? options.message ?? `${label} is invalid`);
  }
  const carriageReturns = options.carriageReturns ?? "reject";
  const normalized = carriageReturns === "normalize" ? value.replace(/\r\n?/gu, "\n") : value;
  const parsed = options.trim === false ? normalized : normalized.trim();
  const controlPattern = carriageReturns !== "reject"
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\u0000-\u0008\u000b-\u001f\u007f]/u;
  if (
    (!options.allowEmpty && parsed.length === 0) ||
    normalized.length > maximum ||
    controlPattern.test(normalized)
  ) {
    throw new ContractValidationError(options.message ?? `${label} is invalid`);
  }
  return parsed;
}

export interface ProseOptions {
  readonly maximum: number;
  readonly allowEmpty?: boolean;
  /** `preserve` is for worker-authored text normalized immediately before board writes. */
  readonly carriageReturns?: "reject" | "normalize" | "preserve";
  readonly message?: string;
  readonly scalarMessages?: ScalarMessageProfile;
}

/** Contract prose is whitespace-stable; workers may normalize provider-authored CRs. */
export function prose(value: unknown, label: string, options: ProseOptions): string {
  const parsed = text(value, label, {
    maximum: options.maximum,
    allowEmpty: options.allowEmpty,
    trim: false,
    carriageReturns: options.carriageReturns,
    message: options.message,
    scalarMessages: options.scalarMessages,
  });
  if (parsed.trim() !== parsed) throw new ContractValidationError(options.message ?? `${label} is invalid`);
  return parsed;
}

const IDENTIFIER = new RegExp(IDENTIFIER_PATTERN, "u");

export function identifier(
  value: unknown,
  label: string,
  message = `${label} is invalid`,
  scalarMessages?: ScalarMessageProfile,
): string {
  if (typeof value !== "string") throw new ContractValidationError(scalarMessages?.stringType(label) ?? message);
  if (!IDENTIFIER.test(value)) throw new ContractValidationError(message);
  return value;
}

export function timestamp(
  value: unknown,
  label: string,
  message = `${label} must be a timestamp`,
  canonical = false,
  scalarMessages?: ScalarMessageProfile,
): string {
  if (typeof value !== "string") throw new ContractValidationError(scalarMessages?.stringType(label) ?? message);
  if (Number.isNaN(Date.parse(value))) throw new ContractValidationError(message);
  if (canonical && new Date(value).toISOString() !== value) throw new ContractValidationError(message);
  return value;
}

export function contractMember<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
  message = `${label} is invalid`,
  scalarMessages?: ScalarMessageProfile,
): Values[number] {
  if (typeof value !== "string") throw new ContractValidationError(scalarMessages?.stringType(label) ?? message);
  if (!(values as readonly string[]).includes(value)) throw new ContractValidationError(message);
  return value as Values[number];
}

export function contractSetMember<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  label: string,
  message = `${label} has an unsupported value`,
): T {
  const parsed = stringValue(value, label);
  if (!values.has(parsed as T)) throw new ContractValidationError(message);
  return parsed as T;
}

export function booleanValue(value: unknown, label: string, message = `${label} must be a boolean`): boolean {
  if (typeof value !== "boolean") throw new ContractValidationError(message);
  return value;
}

export function integer(
  value: unknown,
  label: string,
  minimum = 0,
  message = `${label} must be a safe integer of at least ${minimum}`,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new ContractValidationError(message);
  return Number(value);
}

export function arrayOf<T>(
  value: unknown,
  label: string,
  parser: (item: unknown, label: string) => T,
): T[] {
  if (!Array.isArray(value)) throw new ContractValidationError(`${label} must be an array`);
  return value.map((item, index) => parser(item, `${label}[${index}]`));
}

export interface ShapeParserOptions {
  /** False preserves the browser adapter's rolling compatibility with additive fields. */
  readonly exact?: false | ExactMessageMap;
  /** Browser response projections historically treated wire IDs as opaque strings. */
  readonly identifiers?: "contract" | "string";
  readonly identifierMessages?: "invalid" | "valid-identifier";
  readonly scalarMessages?: ScalarMessageProfile;
  /** Skip fields that the browser's legacy raw projection intentionally discarded. */
  readonly projection?: "contract" | "browser";
}

function shape(
  value: unknown,
  label: string,
  fields: readonly string[],
  required: readonly string[],
  options: ShapeParserOptions,
): JsonRecord {
  return options.exact === false
    ? record(value, label)
    : exact(value, fields, label, { messages: options.exact, required });
}

function entity(
  value: unknown,
  label: string,
  fields: readonly string[],
  required: readonly string[],
  options: ShapeParserOptions,
): JsonRecord {
  const item = shape(value, label, fields, required, options);
  if (item.apiVersion !== TASK_BOARD_API_VERSION) {
    throw new ContractValidationError(`${label}.apiVersion is incompatible`);
  }
  return item;
}

export function versionedRecord(value: unknown, label: string): JsonRecord {
  const item = record(value, label);
  if (item.apiVersion !== TASK_BOARD_API_VERSION) {
    throw new ContractValidationError(`${label}.apiVersion is incompatible`);
  }
  return item;
}

function shapeIdentifier(value: unknown, label: string, options: ShapeParserOptions): string {
  return options.identifiers === "string"
    ? stringValue(value, label)
    : identifier(value, label, options.identifierMessages === "valid-identifier"
        ? `${label} must be a valid identifier`
        : `${label} is invalid`, options.scalarMessages);
}

function nullableIdentifier(value: unknown, label: string, options: ShapeParserOptions): string | null {
  return value === null ? null : shapeIdentifier(value, label, options);
}

function entityTimestamp(value: unknown, label: string, options: ShapeParserOptions): string {
  return timestamp(value, label, `${label} must be a timestamp`, false, options.scalarMessages);
}

function nullableTimestamp(value: unknown, label: string, options: ShapeParserOptions): string | null {
  return value === null ? null : entityTimestamp(value, label, options);
}

function entityMember<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
  options: ShapeParserOptions,
  message = `${label} has an unsupported value`,
): Values[number] {
  return contractMember(value, values, label, message, options.scalarMessages);
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : stringValue(value, label);
}

function expectedMinutes(
  value: unknown,
  label: string,
  webMessage = false,
  scalarMessages?: ScalarMessageProfile,
): number | null {
  if (value === null || (webMessage && value === undefined)) return null;
  if (scalarMessages !== undefined && (!Number.isSafeInteger(value) || Number(value) < 15)) {
    throw new ContractValidationError(scalarMessages.integerAtLeast(label, 15));
  }
  if (
    !Number.isSafeInteger(value) || Number(value) < 15 || Number(value) % 15 !== 0 ||
    (!webMessage && Number(value) > 10_080)
  ) {
    throw new ContractValidationError(webMessage
      ? `${label} must use a 15-minute interval`
      : `${label} must be a 15-minute interval between 15 and 10080`);
  }
  return Number(value);
}

export function parseProjectEntity(value: unknown, label: string, options: ShapeParserOptions = {}): Project {
  const item = entity(value, label,
    ["apiVersion", "projectId", "name", "description", "version", "createdAt", "updatedAt"],
    ["apiVersion", "projectId", "name", "description", "version", "createdAt", "updatedAt"], options);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    name: stringValue(item.name, `${label}.name`),
    description: stringValue(item.description, `${label}.description`),
    version: integer(item.version, `${label}.version`, 1),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    updatedAt: entityTimestamp(item.updatedAt, `${label}.updatedAt`, options),
  });
}

export function parseWorkItemProjectTargetEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): WorkItemProjectTarget {
  const item = record(value, label);
  const mode = stringValue(item.mode, `${label}.mode`);
  if (mode === "auto") {
    exact(item, ["mode"], label, { messages: {
      unexpected: () => `${label} has unsupported fields for automatic project selection`,
      missing: PATH_EXACT_MESSAGES.missing,
    } });
    return Object.freeze({ mode: "auto" });
  }
  if (mode === "explicit") {
    exact(item, ["mode", "projectId"], label, { messages: {
      unexpected: () => `${label} has unsupported fields for explicit project selection`,
      missing: PATH_EXACT_MESSAGES.missing,
    } });
    return Object.freeze({ mode: "explicit", projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options) });
  }
  throw new ContractValidationError(`${label}.mode has an unsupported value`);
}

export function parseWorkItemEntity(value: unknown, label: string, options: ShapeParserOptions = {}): WorkItem {
  const fields = [
    "apiVersion", "workItemId", "originalRequest", "refinedObjective", "priority", "projectTarget", "resolvedProjectId",
    "planningTaskId", "state", "currentStage", "createdBy", "version", "createdAt", "updatedAt", "endedAt",
    "cancelledReason", "archivedAt",
  ];
  const item = entity(value, label, fields, fields, options);
  const projectTarget = parseWorkItemProjectTargetEntity(item.projectTarget, `${label}.projectTarget`, options);
  const resolvedProjectId = nullableIdentifier(item.resolvedProjectId, `${label}.resolvedProjectId`, options);
  const state = entityMember(item.state, WORK_ITEM_STATES, `${label}.state`, options);
  const endedAt = nullableTimestamp(item.endedAt, `${label}.endedAt`, options);
  const archivedAt = nullableTimestamp(item.archivedAt, `${label}.archivedAt`, options);
  const cancelledReason = nullableString(item.cancelledReason, `${label}.cancelledReason`);
  const terminal = state === "completed" || state === "failed" || state === "cancelled";
  if (terminal !== (endedAt !== null)) throw new ContractValidationError(`${label}.endedAt does not match its state`);
  if (archivedAt !== null && !terminal) throw new ContractValidationError(`${label}.archivedAt requires a terminal state`);
  if (cancelledReason !== null && state !== "cancelled") {
    throw new ContractValidationError(`${label}.cancelledReason requires a cancelled state`);
  }
  if (projectTarget.mode === "explicit" && resolvedProjectId !== projectTarget.projectId) {
    throw new ContractValidationError(`${label}.resolvedProjectId must match its explicit project target`);
  }
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    workItemId: shapeIdentifier(item.workItemId, `${label}.workItemId`, options),
    originalRequest: stringValue(item.originalRequest, `${label}.originalRequest`),
    refinedObjective: nullableString(item.refinedObjective, `${label}.refinedObjective`),
    priority: entityMember(item.priority, WORK_ITEM_PRIORITIES, `${label}.priority`, options),
    projectTarget,
    resolvedProjectId,
    planningTaskId: nullableIdentifier(item.planningTaskId, `${label}.planningTaskId`, options),
    state,
    currentStage: item.currentStage === null
      ? null
      : entityMember(item.currentStage, WORK_ITEM_STAGES, `${label}.currentStage`, options),
    createdBy: shapeIdentifier(item.createdBy, `${label}.createdBy`, options),
    version: integer(item.version, `${label}.version`, 1),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    updatedAt: entityTimestamp(item.updatedAt, `${label}.updatedAt`, options),
    endedAt,
    cancelledReason,
    archivedAt,
  });
}

export function parseTaskPhaseEntity(value: unknown, label: string, options: ShapeParserOptions = {}): TaskPhase {
  const fields = [
    "apiVersion", "phaseId", "projectId", "taskId", "title", "stage", "status", "parallelGroup", "orderKey",
    "startedAt", "endedAt", "version", "createdAt", "updatedAt",
  ];
  const item = entity(value, label, fields, fields, options);
  const stage = entityMember(item.stage, TASK_PHASE_STAGES, `${label}.stage`, options);
  const status = entityMember(item.status, TASK_PHASE_STATUSES, `${label}.status`, options);
  if (stage === "done" && status !== "completed") {
    throw new ContractValidationError(`${label} may use the legacy done stage only when status is completed`);
  }
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    phaseId: shapeIdentifier(item.phaseId, `${label}.phaseId`, options),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    taskId: shapeIdentifier(item.taskId, `${label}.taskId`, options),
    title: stringValue(item.title, `${label}.title`),
    stage,
    status,
    parallelGroup: nullableIdentifier(item.parallelGroup, `${label}.parallelGroup`, options),
    orderKey: integer(item.orderKey, `${label}.orderKey`),
    startedAt: nullableTimestamp(item.startedAt, `${label}.startedAt`, options),
    endedAt: nullableTimestamp(item.endedAt, `${label}.endedAt`, options),
    version: integer(item.version, `${label}.version`, 1),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    updatedAt: entityTimestamp(item.updatedAt, `${label}.updatedAt`, options),
  });
}

/** Task-worker HTTP response profile; preserves its canonical-time and legacy error contract. */
export function parseAgentTaskPhaseResponse(
  value: unknown,
  projectId: string,
  taskId: string,
  label: string,
): TaskPhase {
  const item = exact(value, [
    "apiVersion", "phaseId", "projectId", "taskId", "title", "stage", "status", "parallelGroup", "orderKey",
    "startedAt", "endedAt", "version", "createdAt", "updatedAt",
  ], label);
  if (item.apiVersion !== TASK_BOARD_API_VERSION || item.projectId !== projectId || item.taskId !== taskId) {
    throw new ContractValidationError(`${label} binding is invalid`);
  }
  const stage = contractMember(item.stage, TASK_PHASE_STAGES, `${label}.stage`);
  const status = contractMember(item.status, TASK_PHASE_STATUSES, `${label}.status`);
  if (stage === "done" && status !== "completed") {
    throw new ContractValidationError(`${label} completion state is invalid`);
  }
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    phaseId: identifier(item.phaseId, `${label}.phaseId`),
    projectId,
    taskId,
    title: stringValue(item.title, `${label}.title`),
    stage,
    status,
    parallelGroup: item.parallelGroup === null ? null : identifier(item.parallelGroup, `${label}.parallelGroup`),
    orderKey: integer(item.orderKey, `${label}.orderKey`, 0, `${label}.orderKey is invalid`),
    startedAt: item.startedAt === null
      ? null
      : timestamp(item.startedAt, `${label}.startedAt`, `${label}.startedAt is invalid`, true),
    endedAt: item.endedAt === null
      ? null
      : timestamp(item.endedAt, `${label}.endedAt`, `${label}.endedAt is invalid`, true),
    version: integer(item.version, `${label}.version`, 1, `${label}.version is invalid`),
    createdAt: timestamp(item.createdAt, `${label}.createdAt`, `${label}.createdAt is invalid`, true),
    updatedAt: timestamp(item.updatedAt, `${label}.updatedAt`, `${label}.updatedAt is invalid`, true),
  });
}

export function parseTaskEntity(value: unknown, label: string, options: ShapeParserOptions = {}): BoardTask {
  const fields = [
    "apiVersion", "taskId", "projectId", "parentTaskId", "kind", "requiredRole", "requiresReview", "title", "objective",
    "acceptanceCriteria", "workspaceRefs", "status", "assignedAgentId", "assignedRole", "expectedAgentMinutes",
    "estimateRecordedAt", "orderKey", "phases", "startedAt", "expectedCompletedAt", "endedAt", "result", "version",
    "createdAt", "updatedAt",
  ];
  const required = fields.filter((field) => field !== "estimateRecordedAt" && field !== "phases" && field !== "expectedAgentMinutes");
  const item = entity(value, label, fields, required, options);
  const taskId = shapeIdentifier(item.taskId, `${label}.taskId`, options);
  const projectId = shapeIdentifier(item.projectId, `${label}.projectId`, options);
  const kind = entityMember(item.kind, TASK_KINDS, `${label}.kind`, options);
  const requiredRole = item.requiredRole === null
    ? null
    : entityMember(item.requiredRole, AGENT_ROLES, `${label}.requiredRole`, options);
  const assignedAgentId = nullableIdentifier(item.assignedAgentId, `${label}.assignedAgentId`, options);
  const assignedRole = item.assignedRole === null
    ? null
    : entityMember(item.assignedRole, AGENT_ROLES, `${label}.assignedRole`, options);
  if (kind === "manager_review" ? requiredRole !== "manager" : requiredRole !== null) {
    throw new ContractValidationError(`${label}.requiredRole does not match its task kind`);
  }
  if ((assignedAgentId === null) !== (assignedRole === null)) throw new ContractValidationError(`${label} has an incomplete assignment`);
  if (requiredRole !== null && assignedRole !== null && assignedRole !== requiredRole) {
    throw new ContractValidationError(`${label}.assignedRole does not satisfy requiredRole`);
  }
  if (kind === "human_check" && assignedAgentId !== null) throw new ContractValidationError(`${label} human check cannot be assigned`);
  const phases = item.phases === undefined
    ? []
    : arrayOf(item.phases, `${label}.phases`, (phase, phaseLabel) => parseTaskPhaseEntity(phase, phaseLabel, options));
  if (phases.some((phase) => phase.taskId !== taskId || phase.projectId !== projectId)) {
    throw new ContractValidationError(`${label}.phases must belong to their containing task`);
  }
  const status = entityMember(item.status, TASK_STATUSES, `${label}.status`, options);
  const validatedExpectedCompletedAt = nullableTimestamp(item.expectedCompletedAt, `${label}.expectedCompletedAt`, options);
  const expectedCompletedAt = status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled"
    ? null
    : validatedExpectedCompletedAt;
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    taskId,
    projectId,
    parentTaskId: nullableIdentifier(item.parentTaskId, `${label}.parentTaskId`, options),
    kind,
    requiredRole,
    requiresReview: booleanValue(item.requiresReview, `${label}.requiresReview`),
    title: stringValue(item.title, `${label}.title`),
    objective: stringValue(item.objective, `${label}.objective`),
    acceptanceCriteria: stringValue(item.acceptanceCriteria, `${label}.acceptanceCriteria`),
    workspaceRefs: arrayOf(item.workspaceRefs, `${label}.workspaceRefs`, (entry, entryLabel) => stringValue(entry, entryLabel)),
    status,
    assignedAgentId,
    assignedRole,
    expectedAgentMinutes: expectedMinutes(
      item.expectedAgentMinutes,
      `${label}.expectedAgentMinutes`,
      options.projection === "browser",
      options.scalarMessages,
    ),
    estimateRecordedAt: nullableTimestamp(item.estimateRecordedAt ?? null, `${label}.estimateRecordedAt`, options),
    orderKey: integer(item.orderKey, `${label}.orderKey`),
    phases: Object.freeze(phases),
    startedAt: nullableTimestamp(item.startedAt, `${label}.startedAt`, options),
    expectedCompletedAt,
    endedAt: nullableTimestamp(item.endedAt, `${label}.endedAt`, options),
    result: nullableString(item.result, `${label}.result`),
    version: integer(item.version, `${label}.version`, 1),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    updatedAt: entityTimestamp(item.updatedAt, `${label}.updatedAt`, options),
  });
}

export function parseAgentEntity(value: unknown, label: string, options: ShapeParserOptions = {}): AgentProfile {
  const fields = [
    "apiVersion", "agentId", "projectId", "role", "area", "mission", "model", "status", "workerConnection",
    "lastError", "version", "createdAt",
  ];
  const required = fields.filter((field) => field !== "workerConnection" && field !== "lastError");
  const item = entity(value, label, fields, required, options);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    agentId: shapeIdentifier(item.agentId, `${label}.agentId`, options),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    role: entityMember(item.role, AGENT_ROLES, `${label}.role`, options),
    area: stringValue(item.area, `${label}.area`),
    mission: stringValue(item.mission, `${label}.mission`),
    model: shapeIdentifier(item.model, `${label}.model`, options),
    status: entityMember(item.status, AGENT_STATUSES, `${label}.status`, options),
    workerConnection: item.workerConnection === undefined || item.workerConnection === null
      ? null
      : entityMember(item.workerConnection, WORKER_CONNECTIONS, `${label}.workerConnection`, options),
    lastError: item.lastError === undefined || item.lastError === null
      ? null
      : prose(item.lastError, `${label}.lastError`, {
          maximum: 2_000,
          message: `${label}.lastError must not be empty and contain at most 2,000 characters`,
          scalarMessages: options.scalarMessages,
        }),
    version: integer(item.version, `${label}.version`, 1),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
  });
}

export function parseQuestionEntity(value: unknown, label: string, options: ShapeParserOptions = {}): HumanQuestion {
  const fields = [
    "apiVersion", "questionId", "projectId", "taskId", "agentId", "runId", "question", "status", "answer", "askedAt",
    "answeredAt", "answeredBy", "version",
  ];
  const item = entity(value, label, fields, fields, options);
  const browserProjection = options.projection === "browser";
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    questionId: shapeIdentifier(item.questionId, `${label}.questionId`, options),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    taskId: shapeIdentifier(item.taskId, `${label}.taskId`, options),
    agentId: shapeIdentifier(item.agentId, `${label}.agentId`, options),
    runId: browserProjection ? "" : shapeIdentifier(item.runId, `${label}.runId`, options),
    question: stringValue(item.question, `${label}.question`),
    status: entityMember(item.status, QUESTION_STATUSES, `${label}.status`, options),
    answer: nullableString(item.answer, `${label}.answer`),
    askedAt: entityTimestamp(item.askedAt, `${label}.askedAt`, options),
    answeredAt: nullableTimestamp(item.answeredAt, `${label}.answeredAt`, options),
    answeredBy: browserProjection ? null : nullableIdentifier(item.answeredBy, `${label}.answeredBy`, options),
    version: integer(item.version, `${label}.version`, 1),
  });
}

export function parseRunEntity(value: unknown, label: string, options: ShapeParserOptions = {}): AgentRun {
  const fields = [
    "apiVersion", "runId", "claimId", "projectId", "agentId", "wakeupId", "taskId", "status", "startedAt", "endedAt", "result",
  ];
  const item = entity(value, label, fields, fields, options);
  const browserProjection = options.projection === "browser";
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    runId: shapeIdentifier(item.runId, `${label}.runId`, options),
    claimId: browserProjection ? "" : shapeIdentifier(item.claimId, `${label}.claimId`, options),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    agentId: shapeIdentifier(item.agentId, `${label}.agentId`, options),
    wakeupId: browserProjection ? "" : shapeIdentifier(item.wakeupId, `${label}.wakeupId`, options),
    taskId: nullableIdentifier(item.taskId, `${label}.taskId`, options),
    status: entityMember(item.status, RUN_STATUSES, `${label}.status`, options),
    startedAt: entityTimestamp(item.startedAt, `${label}.startedAt`, options),
    endedAt: nullableTimestamp(item.endedAt, `${label}.endedAt`, options),
    result: browserProjection ? null : nullableString(item.result, `${label}.result`),
  });
}

export function parseWakeupEntity(value: unknown, label: string, options: ShapeParserOptions = {}): Wakeup {
  const fields = [
    "apiVersion", "wakeupId", "projectId", "agentId", "reason", "taskId", "questionId", "detail", "createdBy",
    "createdAt", "claimedAt", "runId",
  ];
  const item = entity(value, label, fields, fields, options);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    wakeupId: shapeIdentifier(item.wakeupId, `${label}.wakeupId`, options),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    agentId: shapeIdentifier(item.agentId, `${label}.agentId`, options),
    reason: entityMember(item.reason, WAKEUP_REASONS, `${label}.reason`, options),
    taskId: nullableIdentifier(item.taskId, `${label}.taskId`, options),
    questionId: nullableIdentifier(item.questionId, `${label}.questionId`, options),
    detail: stringValue(item.detail, `${label}.detail`),
    createdBy: shapeIdentifier(item.createdBy, `${label}.createdBy`, options),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    claimedAt: nullableTimestamp(item.claimedAt, `${label}.claimedAt`, options),
    runId: nullableIdentifier(item.runId, `${label}.runId`, options),
  });
}

export function parseMessageEntity(value: unknown, label: string, options: ShapeParserOptions = {}): TaskMessage {
  const fields = [
    "apiVersion", "messageId", "sequence", "projectId", "taskId", "runId", "actorType", "actorId", "kind", "body", "createdAt",
  ];
  const item = entity(value, label, fields, fields, options);
  const browserProjection = options.projection === "browser";
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    messageId: shapeIdentifier(item.messageId, `${label}.messageId`, options),
    sequence: integer(item.sequence, `${label}.sequence`, 1),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    taskId: shapeIdentifier(item.taskId, `${label}.taskId`, options),
    runId: browserProjection ? null : nullableIdentifier(item.runId, `${label}.runId`, options),
    actorType: entityMember(item.actorType, DOCUMENT_ACTOR_TYPES, `${label}.actorType`, options),
    actorId: shapeIdentifier(item.actorId, `${label}.actorId`, options),
    kind: entityMember(item.kind, TASK_MESSAGE_KINDS, `${label}.kind`, options),
    body: stringValue(item.body, `${label}.body`),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
  });
}

export function parseEventEntity(value: unknown, label: string, options: ShapeParserOptions = {}): TaskEvent {
  const fields = ["apiVersion", "eventId", "projectId", "taskId", "actorType", "actorId", "eventType", "data", "createdAt"];
  const item = entity(value, label, fields, fields, options);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    eventId: shapeIdentifier(item.eventId, `${label}.eventId`, options),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    taskId: nullableIdentifier(item.taskId, `${label}.taskId`, options),
    actorType: entityMember(item.actorType, ACTOR_TYPES, `${label}.actorType`, options),
    actorId: shapeIdentifier(item.actorId, `${label}.actorId`, options),
    eventType: stringValue(item.eventType, `${label}.eventType`),
    data: Object.freeze(record(item.data, `${label}.data`)),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
  });
}

export function parseInterruptEntity(value: unknown, label: string, options: ShapeParserOptions = {}): AgentInterrupt {
  const fields = [
    "apiVersion", "sequence", "interruptId", "projectId", "agentId", "runId", "reason", "requestedBy", "requestedAt",
  ];
  const item = entity(value, label, fields, fields, options);
  const browserProjection = options.projection === "browser";
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    sequence: integer(item.sequence, `${label}.sequence`, 1),
    interruptId: browserProjection ? "" : shapeIdentifier(item.interruptId, `${label}.interruptId`, options),
    projectId: browserProjection ? "" : shapeIdentifier(item.projectId, `${label}.projectId`, options),
    agentId: shapeIdentifier(item.agentId, `${label}.agentId`, options),
    runId: nullableIdentifier(item.runId, `${label}.runId`, options),
    reason: browserProjection ? "" : stringValue(item.reason, `${label}.reason`),
    requestedBy: browserProjection ? "" : shapeIdentifier(item.requestedBy, `${label}.requestedBy`, options),
    requestedAt: entityTimestamp(item.requestedAt, `${label}.requestedAt`, options),
  });
}

function parseCriterionResult(value: unknown, label: string, options: ShapeParserOptions): CriterionResult {
  const item = shape(value, label, ["criterion", "passed", "evidence"], ["criterion", "passed", "evidence"], options);
  return Object.freeze({
    criterion: stringValue(item.criterion, `${label}.criterion`),
    passed: booleanValue(item.passed, `${label}.passed`),
    evidence: stringValue(item.evidence, `${label}.evidence`),
  });
}

export function parsePlanEntity(value: unknown, label: string, options: ShapeParserOptions = {}): PlanRevision {
  const fields = [
    "apiVersion", "planRevisionId", "workItemId", "revision", "objective", "assumptions", "acceptanceCriteria", "projectId",
    "skillDigests", "state", "createdBy", "confirmedBy", "createdAt", "confirmedAt",
  ];
  const item = entity(value, label, fields, fields, options);
  const digests = record(item.skillDigests, `${label}.skillDigests`);
  const skillDigests: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, digest] of Object.entries(digests)) skillDigests[key] = stringValue(digest, `${label}.skillDigests.${key}`);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    planRevisionId: shapeIdentifier(item.planRevisionId, `${label}.planRevisionId`, options),
    workItemId: shapeIdentifier(item.workItemId, `${label}.workItemId`, options),
    revision: integer(item.revision, `${label}.revision`, 1),
    objective: stringValue(item.objective, `${label}.objective`),
    assumptions: Object.freeze(arrayOf(item.assumptions, `${label}.assumptions`, stringValue)),
    acceptanceCriteria: Object.freeze(arrayOf(item.acceptanceCriteria, `${label}.acceptanceCriteria`, stringValue)),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    skillDigests: Object.freeze(skillDigests),
    state: entityMember(item.state, PLAN_REVISION_STATES, `${label}.state`, options),
    createdBy: shapeIdentifier(item.createdBy, `${label}.createdBy`, options),
    confirmedBy: nullableIdentifier(item.confirmedBy, `${label}.confirmedBy`, options),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    confirmedAt: nullableTimestamp(item.confirmedAt, `${label}.confirmedAt`, options),
  });
}

export function parseNodeEntity(value: unknown, label: string, options: ShapeParserOptions = {}): WorkNode {
  const fields = [
    "apiVersion", "nodeId", "planRevisionId", "projectId", "title", "objective", "acceptanceCriteria", "dependencyNodeIds",
    "stageTemplate", "currentStage", "state", "version", "createdAt", "updatedAt",
  ];
  const item = entity(value, label, fields, fields, options);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    nodeId: shapeIdentifier(item.nodeId, `${label}.nodeId`, options),
    planRevisionId: shapeIdentifier(item.planRevisionId, `${label}.planRevisionId`, options),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    title: stringValue(item.title, `${label}.title`),
    objective: stringValue(item.objective, `${label}.objective`),
    acceptanceCriteria: Object.freeze(arrayOf(item.acceptanceCriteria, `${label}.acceptanceCriteria`, stringValue)),
    dependencyNodeIds: Object.freeze(arrayOf(item.dependencyNodeIds, `${label}.dependencyNodeIds`,
      (entry, entryLabel) => shapeIdentifier(entry, entryLabel, options))),
    stageTemplate: Object.freeze(arrayOf(item.stageTemplate, `${label}.stageTemplate`, (stage, stageLabel) =>
      entityMember(stage, WORKFLOW_STAGES, stageLabel, options))),
    currentStage: item.currentStage === null
      ? null
      : entityMember(item.currentStage, WORKFLOW_STAGES, `${label}.currentStage`, options),
    state: entityMember(item.state, WORK_NODE_STATES, `${label}.state`, options),
    version: integer(item.version, `${label}.version`, 1),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    updatedAt: entityTimestamp(item.updatedAt, `${label}.updatedAt`, options),
  });
}

export function parseHandoffEntity(value: unknown, label: string, options: ShapeParserOptions = {}): StageHandoff {
  const fields = [
    "apiVersion", "handoffId", "nodeId", "taskId", "stage", "outcome", "summary", "evidence", "artifactIds",
    "acceptanceCriteria", "blockers", "recommendedReturnStage", "createdAt",
  ];
  const item = entity(value, label, fields, fields, options);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    handoffId: shapeIdentifier(item.handoffId, `${label}.handoffId`, options),
    nodeId: shapeIdentifier(item.nodeId, `${label}.nodeId`, options),
    taskId: shapeIdentifier(item.taskId, `${label}.taskId`, options),
    stage: entityMember(item.stage, WORKFLOW_STAGES, `${label}.stage`, options),
    outcome: entityMember(item.outcome, STAGE_HANDOFF_OUTCOMES, `${label}.outcome`, options),
    summary: stringValue(item.summary, `${label}.summary`),
    evidence: Object.freeze(arrayOf(item.evidence, `${label}.evidence`, stringValue)),
    artifactIds: Object.freeze(arrayOf(item.artifactIds, `${label}.artifactIds`,
      (entry, entryLabel) => shapeIdentifier(entry, entryLabel, options))),
    acceptanceCriteria: Object.freeze(arrayOf(item.acceptanceCriteria, `${label}.acceptanceCriteria`,
      (criterion, criterionLabel) => parseCriterionResult(criterion, criterionLabel, options))),
    blockers: Object.freeze(arrayOf(item.blockers, `${label}.blockers`, stringValue)),
    recommendedReturnStage: item.recommendedReturnStage === null
      ? null
      : entityMember(item.recommendedReturnStage, WORKFLOW_STAGES, `${label}.recommendedReturnStage`, options),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
  });
}

export function parseProjectEventEntity(value: unknown, label: string, options: ShapeParserOptions = {}): ProjectEvent {
  const fields = ["apiVersion", "sequence", "eventId", "projectId", "nodeId", "taskId", "eventType", "summary", "createdAt"];
  const item = entity(value, label, fields, fields, options);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    sequence: integer(item.sequence, `${label}.sequence`, 1),
    eventId: shapeIdentifier(item.eventId, `${label}.eventId`, options),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    nodeId: nullableIdentifier(item.nodeId, `${label}.nodeId`, options),
    taskId: nullableIdentifier(item.taskId, `${label}.taskId`, options),
    eventType: stringValue(item.eventType, `${label}.eventType`),
    summary: stringValue(item.summary, `${label}.summary`),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
  });
}

export function parseProjectArtifactEntity(value: unknown, label: string, options: ShapeParserOptions = {}): ProjectArtifact {
  const fields = [
    "apiVersion", "artifactId", "projectId", "nodeId", "taskId", "mediaType", "byteSize", "digest", "caption",
    "createdBy", "createdAt",
  ];
  const item = entity(value, label, fields, fields, options);
  const digest = stringValue(item.digest, `${label}.digest`);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) throw new ContractValidationError(`${label}.digest must be a SHA-256 digest`);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    artifactId: shapeIdentifier(item.artifactId, `${label}.artifactId`, options),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    nodeId: nullableIdentifier(item.nodeId, `${label}.nodeId`, options),
    taskId: nullableIdentifier(item.taskId, `${label}.taskId`, options),
    mediaType: stringValue(item.mediaType, `${label}.mediaType`) as ProjectArtifact["mediaType"],
    byteSize: integer(item.byteSize, `${label}.byteSize`, 1),
    digest: digest as `sha256:${string}`,
    caption: stringValue(item.caption, `${label}.caption`),
    createdBy: shapeIdentifier(item.createdBy, `${label}.createdBy`, options),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
  });
}

export function parseDocumentPenHolderEntity(value: unknown, label: string, options: ShapeParserOptions = {}): DocumentPenHolder {
  const item = shape(value, label, ["actorType", "actorId", "clientId", "acquiredAt"],
    ["actorType", "actorId", "clientId", "acquiredAt"], options);
  return Object.freeze({
    actorType: entityMember(item.actorType, DOCUMENT_ACTOR_TYPES, `${label}.actorType`, options),
    actorId: shapeIdentifier(item.actorId, `${label}.actorId`, options),
    clientId: shapeIdentifier(item.clientId, `${label}.clientId`, options),
    acquiredAt: entityTimestamp(item.acquiredAt, `${label}.acquiredAt`, options),
  });
}

export function parseDocumentSummaryEntity(value: unknown, label: string, options: ShapeParserOptions = {}): DocumentSummary {
  const fields = [
    "apiVersion", "documentId", "projectId", "title", "contentType", "contentVersion", "penEpoch", "penHolder",
    "sequence", "createdAt", "updatedAt",
  ];
  const item = entity(value, label, fields, fields, options);
  if (item.contentType !== "text/markdown") throw new ContractValidationError(`${label}.contentType has an unsupported value`);
  const penEpoch = integer(item.penEpoch, `${label}.penEpoch`);
  const penHolder = item.penHolder === null ? null : parseDocumentPenHolderEntity(item.penHolder, `${label}.penHolder`, options);
  if (penHolder !== null && penEpoch < 1) throw new ContractValidationError(`${label}.penEpoch must advance before granting the pen`);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    documentId: shapeIdentifier(item.documentId, `${label}.documentId`, options),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    title: stringValue(item.title, `${label}.title`),
    contentType: "text/markdown",
    contentVersion: integer(item.contentVersion, `${label}.contentVersion`, 1),
    penEpoch,
    penHolder,
    sequence: integer(item.sequence, `${label}.sequence`),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    updatedAt: entityTimestamp(item.updatedAt, `${label}.updatedAt`, options),
  });
}

export function parseDocumentEntity(value: unknown, label: string, options: ShapeParserOptions = {}): DocumentSnapshot {
  const item = entity(value, label, [
    "apiVersion", "documentId", "projectId", "title", "contentType", "contentVersion", "penEpoch", "penHolder",
    "sequence", "createdAt", "updatedAt", "content",
  ], [
    "apiVersion", "documentId", "projectId", "title", "contentType", "contentVersion", "penEpoch", "penHolder",
    "sequence", "createdAt", "updatedAt", "content",
  ], options);
  return Object.freeze({
    ...parseDocumentSummaryEntity(item, label, { ...options, exact: false }),
    content: stringValue(item.content, `${label}.content`),
  });
}

const AUTOMATION_STAGE_ROLES = Object.freeze({
  refinement: Object.freeze(["manager"] as const),
  project_resolution: Object.freeze(["manager"] as const),
  research: Object.freeze(["engineer", "verifier"] as const),
  planning: Object.freeze(["engineer"] as const),
  implementation: Object.freeze(["engineer"] as const),
  testing: Object.freeze(["engineer", "verifier"] as const),
  verification: Object.freeze(["verifier"] as const),
});

export function skillIdentifier(value: unknown, label: string, scalarMessages?: ScalarMessageProfile): string {
  if (typeof value !== "string") {
    throw new ContractValidationError(scalarMessages?.stringType(label) ??
      `${label} must be a lowercase skill identifier, not a URL or path`);
  }
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)) {
    throw new ContractValidationError(`${label} must be a lowercase skill identifier, not a URL or path`);
  }
  return value;
}

export function parseAutomationAgentTypeEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): AutomationAgentType {
  const fields = ["agentTypeId", "name", "description", "role", "supplementalInstructions", "skillIds", "evaluatorProfile", "enabled"];
  const item = shape(value, label, fields, fields, options);
  const skillIds = arrayOf(item.skillIds, `${label}.skillIds`, (entry, entryLabel) =>
    skillIdentifier(entry, entryLabel, options.scalarMessages));
  if (skillIds.length > 32) throw new ContractValidationError(`${label}.skillIds cannot contain more than 32 entries`);
  if (new Set(skillIds).size !== skillIds.length) throw new ContractValidationError(`${label}.skillIds cannot contain duplicates`);
  const supplementalInstructions = prose(item.supplementalInstructions, `${label}.supplementalInstructions`, {
    maximum: 8_000,
    allowEmpty: true,
    message: `${label}.supplementalInstructions must contain at most 8,000 characters`,
    scalarMessages: options.scalarMessages,
  });
  const enabled = booleanValue(item.enabled, `${label}.enabled`);
  if (enabled && supplementalInstructions.trim().length === 0) {
    throw new ContractValidationError(`${label}.supplementalInstructions cannot be empty while the agent type is enabled`);
  }
  return Object.freeze({
    agentTypeId: shapeIdentifier(item.agentTypeId, `${label}.agentTypeId`, options),
    name: prose(item.name, `${label}.name`, {
      maximum: 160,
      message: `${label}.name must not be empty and contain at most 160 characters`,
      scalarMessages: options.scalarMessages,
    }),
    description: prose(item.description, `${label}.description`, {
      maximum: 4_000,
      message: `${label}.description must not be empty and contain at most 4,000 characters`,
      scalarMessages: options.scalarMessages,
    }),
    role: entityMember(item.role, AGENT_ROLES, `${label}.role`, options),
    supplementalInstructions,
    skillIds: Object.freeze(skillIds),
    evaluatorProfile: entityMember(item.evaluatorProfile, EVALUATOR_PROFILES, `${label}.evaluatorProfile`, options),
    enabled,
  });
}

export function parseAutomationExecutorEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): AutomationStageExecutor {
  const item = record(value, label);
  const kind = stringValue(item.kind, `${label}.kind`);
  if (kind === "agent_type") {
    const parsed = shape(item, label, ["kind", "agentTypeId"], ["kind", "agentTypeId"], options);
    return Object.freeze({ kind: "agent_type", agentTypeId: shapeIdentifier(parsed.agentTypeId, `${label}.agentTypeId`, options) });
  }
  if (kind === "human" || kind === "disabled") {
    shape(item, label, ["kind"], ["kind"], options);
    return Object.freeze({ kind });
  }
  throw new ContractValidationError(`${label}.kind has an unsupported value`);
}

export function parseAutomationStageEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): AutomationPipelineStage {
  const item = shape(value, label, ["stage", "executor"], ["stage", "executor"], options);
  return Object.freeze({
    stage: entityMember(item.stage, WORK_ITEM_STAGES, `${label}.stage`, options),
    executor: parseAutomationExecutorEntity(item.executor, `${label}.executor`, options),
  });
}

export function validateAutomationConfigurationParts(
  agentTypes: readonly AutomationAgentType[],
  stages: readonly AutomationPipelineStage[],
  label: string,
): void {
  if (agentTypes.length > 32) throw new ContractValidationError(`${label}.agentTypes cannot contain more than 32 entries`);
  const typesById = new Map<string, AutomationAgentType>();
  for (const agentType of agentTypes) {
    if (typesById.has(agentType.agentTypeId)) throw new ContractValidationError(`${label}.agentTypes cannot contain duplicate IDs`);
    typesById.set(agentType.agentTypeId, agentType);
  }
  if (stages.length !== WORK_ITEM_STAGES.length) {
    throw new ContractValidationError(`${label}.stages must contain every automation stage exactly once`);
  }
  stages.forEach((entry, index) => {
    const expectedStage = WORK_ITEM_STAGES[index];
    if (entry.stage !== expectedStage) throw new ContractValidationError(`${label}.stages must use the canonical automation stage order`);
    if (entry.stage === "human_review") {
      if (entry.executor.kind !== "human") throw new ContractValidationError(`${label}.stages human_review must be owned by a human`);
      return;
    }
    if (entry.stage === "deployment") {
      if (entry.executor.kind !== "disabled") throw new ContractValidationError(`${label}.stages deployment must remain disabled`);
      return;
    }
    if (entry.executor.kind === "human") throw new ContractValidationError(`${label}.stages ${entry.stage} cannot use a human executor`);
    if (entry.executor.kind !== "agent_type") return;
    const agentType = typesById.get(entry.executor.agentTypeId);
    if (agentType === undefined) throw new ContractValidationError(`${label}.stages ${entry.stage} references an unknown agent type`);
    if (!agentType.enabled) throw new ContractValidationError(`${label}.stages ${entry.stage} references a disabled agent type`);
    const roles: readonly (typeof AGENT_ROLES)[number][] = AUTOMATION_STAGE_ROLES[entry.stage];
    if (!roles.includes(agentType.role)) {
      const rolesLabel = roles.join(" or ");
      throw new ContractValidationError(`${label}.stages ${entry.stage} requires ${rolesLabel.startsWith("engineer") ? "an" : "a"} ${rolesLabel} agent type`);
    }
  });
}

export function automationConfigurationPartsBytes(
  agentTypes: readonly AutomationAgentType[],
  stages: readonly AutomationPipelineStage[],
): number {
  return new TextEncoder().encode(JSON.stringify({ agentTypes, stages })).byteLength;
}

export function parseAutomationConfigurationEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): AutomationConfiguration {
  const fields = ["apiVersion", "configurationId", "agentTypes", "stages", "version", "createdAt", "updatedAt", "updatedBy"];
  const item = entity(value, label, fields, fields, options);
  if (item.configurationId !== "company-default") throw new ContractValidationError(`${label}.configurationId is unsupported`);
  const agentTypes = arrayOf(item.agentTypes, `${label}.agentTypes`, (entry, entryLabel) =>
    parseAutomationAgentTypeEntity(entry, entryLabel, options));
  const stages = arrayOf(item.stages, `${label}.stages`, (entry, entryLabel) =>
    parseAutomationStageEntity(entry, entryLabel, options));
  validateAutomationConfigurationParts(agentTypes, stages, label);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    configurationId: "company-default",
    agentTypes: Object.freeze(agentTypes),
    stages: Object.freeze(stages),
    version: integer(item.version, `${label}.version`, 1),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    updatedAt: entityTimestamp(item.updatedAt, `${label}.updatedAt`, options),
    updatedBy: options.projection === "browser"
      ? prose(item.updatedBy, `${label}.updatedBy`, {
          maximum: 256,
          message: `${label}.updatedBy must not be empty and contain at most 256 characters`,
          scalarMessages: options.scalarMessages,
        })
      : identifier(item.updatedBy, `${label}.updatedBy`, `${label}.updatedBy is invalid`, options.scalarMessages),
  });
}

export function parseBoardSnapshotEntity(
  value: unknown,
  options: ShapeParserOptions = {},
): BoardSnapshot {
  const fields = [
    "apiVersion", "project", "agents", "tasks", "openQuestions", "recentQuestions", "recentRuns", "recentInterrupts",
    "recentEvents", "documents",
  ];
  const required = fields.filter((field) => field !== "recentQuestions");
  const item = entity(value, "board", fields, required, options);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    project: parseProjectEntity(item.project, "board.project", options),
    agents: Object.freeze(arrayOf(item.agents, "board.agents", (entry, label) => parseAgentEntity(entry, label, options))),
    tasks: Object.freeze(arrayOf(item.tasks, "board.tasks", (entry, label) => parseTaskEntity(entry, label, options))),
    openQuestions: Object.freeze(arrayOf(item.openQuestions, "board.openQuestions", (entry, label) => parseQuestionEntity(entry, label, options))),
    recentQuestions: Object.freeze(item.recentQuestions === undefined ? [] : arrayOf(item.recentQuestions, "board.recentQuestions",
      (entry, label) => parseQuestionEntity(entry, label, options))),
    recentRuns: Object.freeze(arrayOf(item.recentRuns, "board.recentRuns", (entry, label) => parseRunEntity(entry, label, options))),
    recentInterrupts: Object.freeze(arrayOf(item.recentInterrupts, "board.recentInterrupts",
      (entry, label) => parseInterruptEntity(entry, label, options))),
    recentEvents: Object.freeze(arrayOf(item.recentEvents, "board.recentEvents", (entry, label) => parseEventEntity(entry, label, options))),
    documents: Object.freeze(arrayOf(item.documents, "board.documents", (entry, label) => parseDocumentSummaryEntity(entry, label, options))),
  });
}

export function parseClaimRunResult(value: unknown): ClaimRunResult {
  const envelope = exact(value, ["apiVersion", "run", "wakeup", "task", "context"], "Claim result");
  if (envelope.apiVersion !== TASK_BOARD_API_VERSION) throw new ContractValidationError("Claim result API version is invalid");
  const run = exact(envelope.run, [
    "apiVersion", "runId", "claimId", "projectId", "agentId", "wakeupId", "taskId", "status", "startedAt", "endedAt", "result",
  ], "Claim run");
  const wakeup = exact(envelope.wakeup, [
    "apiVersion", "wakeupId", "projectId", "agentId", "reason", "taskId", "questionId", "detail", "createdBy",
    "createdAt", "claimedAt", "runId",
  ], "Claim wakeup");
  const context = exact(envelope.context, [
    "agent", "projectMemory", "areaMemory", "parentTask", "parentMessages", "acceptanceCriteria", "workspaceRefs",
    "messageCursor", "messages", "triggerQuestion", "openQuestions", "workflow",
  ], "Claim context");
  if (
    run.apiVersion !== TASK_BOARD_API_VERSION || wakeup.apiVersion !== TASK_BOARD_API_VERSION ||
    run.status !== "active" || run.endedAt !== null || run.result !== null ||
    typeof wakeup.reason !== "string" || !(WAKEUP_REASONS as readonly string[]).includes(wakeup.reason)
  ) {
    throw new ContractValidationError("Claim run or wakeup state is invalid");
  }
  identifier(run.runId, "run.runId");
  identifier(run.claimId, "run.claimId");
  identifier(run.projectId, "run.projectId");
  identifier(run.agentId, "run.agentId");
  identifier(run.wakeupId, "run.wakeupId");
  if (run.taskId !== null) identifier(run.taskId, "run.taskId");
  timestamp(run.startedAt, "run.startedAt", "run.startedAt is invalid", true);
  identifier(wakeup.wakeupId, "wakeup.wakeupId");
  identifier(wakeup.projectId, "wakeup.projectId");
  identifier(wakeup.agentId, "wakeup.agentId");
  if (wakeup.taskId !== null) identifier(wakeup.taskId, "wakeup.taskId");
  if (wakeup.questionId !== null) identifier(wakeup.questionId, "wakeup.questionId");
  timestamp(wakeup.createdAt, "wakeup.createdAt", "wakeup.createdAt is invalid", true);
  timestamp(wakeup.claimedAt, "wakeup.claimedAt", "wakeup.claimedAt is invalid", true);
  if (
    run.wakeupId !== wakeup.wakeupId || run.projectId !== wakeup.projectId || run.agentId !== wakeup.agentId ||
    run.taskId !== wakeup.taskId || wakeup.runId !== run.runId || wakeup.claimedAt === null
  ) {
    throw new ContractValidationError("Claim run and wakeup binding is invalid");
  }
  if (
    !Array.isArray(context.workspaceRefs) || !Array.isArray(context.areaMemory) || !Array.isArray(context.messages) ||
    !Array.isArray(context.parentMessages) || !Array.isArray(context.openQuestions)
  ) {
    throw new ContractValidationError("Claim context collections are invalid");
  }
  integer(context.messageCursor, "context.messageCursor", 0, "context.messageCursor is invalid");
  return value as ClaimRunResult;
}

export type { StageHandoffDraft, WorkflowPlanDraft };

export interface ValidatedTaskWakeClaim {
  readonly apiVersion: 1;
  readonly claimId: string;
  readonly runId: string;
  readonly wakeupId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly taskId: string | null;
  readonly reason: string;
  readonly requestedMessageCursor: number | null;
  readonly claimedAt: string;
}

export interface ValidatedAgentTaskPhase {
  readonly phaseId: string;
  readonly title: string;
  readonly stage: TaskPhaseStage;
  readonly status: TaskPhaseStatus;
  readonly parallelGroup: string | null;
  readonly orderKey: number;
  readonly version: number;
}

export interface ValidatedAgentTaskPhaseUpdate extends Omit<ValidatedAgentTaskPhase, "phaseId" | "version"> {
  readonly phaseId: string | null;
}

export interface ValidatedAgentContext {
  readonly apiVersion: 1;
  readonly projectId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly mission: Readonly<{ role: string; area: string; mission: string }>;
  readonly projectMemory: string;
  readonly task: Readonly<{
    kind: TaskKind;
    requiredRole: AgentRole | null;
    title: string;
    objective: string;
    acceptanceCriteria: string;
    version: number;
    expectedAgentMinutes: number | null;
    phases: readonly ValidatedAgentTaskPhase[];
  }>;
  readonly areaMemory: readonly Readonly<{ taskId: string; title: string; result: string; endedAt: string }>[];
  readonly parentEvidence: Readonly<{
    taskId: string;
    title: string;
    objective: string;
    acceptanceCriteria: string;
    status: string;
    assignedAgentId: string | null;
    workspaceRefs: readonly string[];
    startedAt: string | null;
    endedAt: string | null;
    result: string | null;
    messages: readonly Readonly<{
      messageId: string;
      author: "human" | "agent";
      kind: "note" | "progress" | "proposal" | "result";
      body: string;
      createdAt: string;
    }>[];
  }> | null;
  readonly messagesSinceCursor: number | null;
  readonly nextMessageCursor: number;
  readonly messages: readonly Readonly<{
    messageId: string;
    cursor: number;
    author: "human" | "agent" | "system";
    body: string;
    createdAt: string;
  }>[];
  readonly triggerQuestion: Readonly<{ questionId: string; question: string; answer: string }> | null;
  readonly openQuestions: readonly Readonly<{
    questionId: string;
    question: string;
    answer: string | null;
    status: "open" | "answered";
  }>[];
  readonly workspaceRefs: readonly string[];
  readonly workflow: Readonly<{
    planRevisionId: string;
    nodeId: string;
    stage: WorkflowStage;
    skills: readonly SkillSnapshot[];
    dependencyHandoffs: readonly StageHandoff[];
  }> | null;
}

export type ValidatedAgentRunOutput =
  | Readonly<{ type: "progress"; body: string }>
  | Readonly<{ type: "proposed_child_task"; title: string; objective: string; acceptanceCriteria: readonly string[] }>
  | Readonly<{ type: "result"; body: string }>
  | Readonly<{ type: "human_question"; question: string }>;

export interface ValidatedAgentRunOutcome {
  readonly status: "completed" | "failed" | "interrupted" | "waiting_for_human";
  readonly outputs: readonly ValidatedAgentRunOutput[];
  readonly expectedAgentMinutes: number | null;
  readonly phases: readonly ValidatedAgentTaskPhaseUpdate[];
  readonly detail: string;
  readonly handoff: StageHandoffDraft | null;
  readonly workflowPlan: WorkflowPlanDraft | null;
}

const MAX_CONTEXT_BYTES = 256 * 1_024;
const MAX_OUTCOME_BYTES = 64 * 1_024;
const MAX_AREA_MEMORY_ITEMS = 8;
const MAX_AREA_MEMORY_RESULT_CHARACTERS = 1_000;

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function boundedJsonValue(value: unknown, maximum: number, label: string): void {
  if (byteLength(value) > maximum) throw new ContractValidationError(`${label} exceeds its byte bound`);
}

function workerTimestamp(value: unknown, label: string): string {
  return timestamp(value, label, `${label} must be a canonical timestamp`, true);
}

function workerProse(value: unknown, label: string, maximum: number): string {
  return prose(value, label, { maximum, carriageReturns: "preserve" });
}

function workerNullableProse(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : workerProse(value, label, maximum);
}

function workerNonNegative(value: unknown, label: string): number {
  return integer(value, label, 0, `${label} is invalid`);
}

function workerPositive(value: unknown, label: string): number {
  return integer(value, label, 1, `${label} is invalid`);
}

function workerExpectedMinutes(value: unknown, label: string): number | null {
  return expectedMinutes(value, label);
}

function workerNullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : workerTimestamp(value, label);
}

function workerNullableCursor(value: unknown, label: string): number | null {
  return value === null ? null : workerNonNegative(value, label);
}

function assertWorkerPhaseCompletion(stage: TaskPhaseStage, status: TaskPhaseStatus, label: string): void {
  if (stage === "done" && status !== "completed") {
    throw new ContractValidationError(`${label} may use the legacy done stage only when status is completed`);
  }
}

function parseWorkerHandoffEntity(value: unknown, index: number): StageHandoff {
  const handoff = exact(value, [
    "apiVersion", "handoffId", "nodeId", "taskId", "stage", "outcome", "summary", "evidence",
    "artifactIds", "acceptanceCriteria", "blockers", "recommendedReturnStage", "createdAt",
  ], `Workflow handoff ${index}`);
  if (handoff.apiVersion !== TASK_BOARD_API_VERSION) {
    throw new ContractValidationError(`Workflow handoff ${index} version is invalid`);
  }
  const stage = contractMember(handoff.stage, WORKFLOW_STAGES, `Workflow handoff ${index} stage`);
  const outcome = contractMember(handoff.outcome, STAGE_HANDOFF_OUTCOMES, `Workflow handoff ${index} outcome`);
  const stringList = (input: unknown, label: string, maximum: number): readonly string[] => {
    if (!Array.isArray(input) || input.length > maximum) throw new ContractValidationError(`${label} is invalid`);
    return Object.freeze(input.map((entry, itemIndex) => workerProse(entry, `${label}[${itemIndex}]`, 2_000)));
  };
  if (!Array.isArray(handoff.acceptanceCriteria) || handoff.acceptanceCriteria.length > 32) {
    throw new ContractValidationError(`Workflow handoff ${index} acceptance criteria are invalid`);
  }
  const acceptanceCriteria = handoff.acceptanceCriteria.map((entry, criterionIndex) => {
    const criterion = exact(entry, ["criterion", "passed", "evidence"], `Workflow criterion ${criterionIndex}`);
    if (typeof criterion.passed !== "boolean") {
      throw new ContractValidationError(`Workflow criterion ${criterionIndex} result is invalid`);
    }
    return Object.freeze({
      criterion: workerProse(criterion.criterion, `workflow.criterion[${criterionIndex}].criterion`, 1_000),
      passed: criterion.passed,
      evidence: workerProse(criterion.evidence, `workflow.criterion[${criterionIndex}].evidence`, 2_000),
    });
  });
  const recommendedReturnStage = handoff.recommendedReturnStage === null
    ? null
    : contractMember(handoff.recommendedReturnStage, WORKFLOW_STAGES, `Workflow handoff ${index} return stage`);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    handoffId: identifier(handoff.handoffId, `workflow.handoffs[${index}].handoffId`),
    nodeId: identifier(handoff.nodeId, `workflow.handoffs[${index}].nodeId`),
    taskId: identifier(handoff.taskId, `workflow.handoffs[${index}].taskId`),
    stage,
    outcome,
    summary: workerProse(handoff.summary, `workflow.handoffs[${index}].summary`, 4_000),
    evidence: stringList(handoff.evidence, `workflow.handoffs[${index}].evidence`, 32),
    artifactIds: stringList(handoff.artifactIds, `workflow.handoffs[${index}].artifactIds`, 32),
    acceptanceCriteria: Object.freeze(acceptanceCriteria),
    blockers: stringList(handoff.blockers, `workflow.handoffs[${index}].blockers`, 32),
    recommendedReturnStage,
    createdAt: workerTimestamp(handoff.createdAt, `workflow.handoffs[${index}].createdAt`),
  });
}

function parseWorkerContextPhase(value: unknown, index: number): ValidatedAgentTaskPhase {
  const label = `task.phases[${index}]`;
  const item = exact(value, ["phaseId", "title", "stage", "status", "parallelGroup", "orderKey", "version"], label);
  const stage = contractMember(item.stage, TASK_PHASE_STAGES, `${label}.stage`);
  const status = contractMember(item.status, TASK_PHASE_STATUSES, `${label}.status`);
  assertWorkerPhaseCompletion(stage, status, label);
  return Object.freeze({
    phaseId: identifier(item.phaseId, `${label}.phaseId`),
    title: workerProse(item.title, `${label}.title`, 240),
    stage,
    status,
    parallelGroup: item.parallelGroup === null ? null : identifier(item.parallelGroup, `${label}.parallelGroup`),
    orderKey: workerNonNegative(item.orderKey, `${label}.orderKey`),
    version: workerPositive(item.version, `${label}.version`),
  });
}

function parseWorkerPhaseUpdate(value: unknown, index: number): ValidatedAgentTaskPhaseUpdate {
  const label = `phases[${index}]`;
  const item = exact(value, ["phaseId", "title", "stage", "status", "parallelGroup", "orderKey"], label);
  const stage = contractMember(item.stage, TASK_PHASE_STAGES, `${label}.stage`);
  const status = contractMember(item.status, TASK_PHASE_STATUSES, `${label}.status`);
  assertWorkerPhaseCompletion(stage, status, label);
  return Object.freeze({
    phaseId: item.phaseId === null ? null : identifier(item.phaseId, `${label}.phaseId`),
    title: workerProse(item.title, `${label}.title`, 240),
    stage,
    status,
    parallelGroup: item.parallelGroup === null ? null : identifier(item.parallelGroup, `${label}.parallelGroup`),
    orderKey: workerNonNegative(item.orderKey, `${label}.orderKey`),
  });
}

export function parseWorkerTaskWakeClaim(value: unknown): ValidatedTaskWakeClaim {
  const item = exact(value, [
    "apiVersion", "claimId", "runId", "wakeupId", "projectId", "agentId", "taskId", "reason",
    "requestedMessageCursor", "claimedAt",
  ], "Task wake claim");
  if (item.apiVersion !== 1 || typeof item.reason !== "string" || item.reason.length > 64) {
    throw new ContractValidationError("Task wake claim version or reason is invalid");
  }
  return Object.freeze({
    apiVersion: 1,
    claimId: identifier(item.claimId, "claimId"),
    runId: identifier(item.runId, "runId"),
    wakeupId: identifier(item.wakeupId, "wakeupId"),
    projectId: identifier(item.projectId, "projectId"),
    agentId: identifier(item.agentId, "agentId"),
    taskId: item.taskId === null ? null : identifier(item.taskId, "taskId"),
    reason: item.reason,
    requestedMessageCursor: workerNullableCursor(item.requestedMessageCursor, "requestedMessageCursor"),
    claimedAt: workerTimestamp(item.claimedAt, "claimedAt"),
  });
}

export function parseWorkerAgentContext(value: unknown): ValidatedAgentContext {
  boundedJsonValue(value, MAX_CONTEXT_BYTES, "Agent context");
  const item = exact(value, [
    "apiVersion", "projectId", "agentId", "taskId", "mission", "projectMemory", "task", "areaMemory", "parentEvidence",
    "messagesSinceCursor", "nextMessageCursor", "messages", "triggerQuestion", "openQuestions", "workspaceRefs", "workflow",
  ], "Agent context");
  if (item.apiVersion !== 1) throw new ContractValidationError("Agent context version is invalid");
  const mission = exact(item.mission, ["role", "area", "mission"], "Agent mission");
  const task = exact(item.task,
    ["kind", "requiredRole", "title", "objective", "acceptanceCriteria", "version", "expectedAgentMinutes", "phases"],
    "Agent task context");
  const currentTaskId = identifier(item.taskId, "context.taskId");
  if (!Array.isArray(item.areaMemory) || item.areaMemory.length > MAX_AREA_MEMORY_ITEMS) {
    throw new ContractValidationError("Agent area memory is invalid");
  }
  const areaMemory = item.areaMemory.map((entry, index) => {
    const memory = exact(entry, ["taskId", "title", "result", "endedAt"], `Area memory ${index}`);
    const parsed = Object.freeze({
      taskId: identifier(memory.taskId, `areaMemory[${index}].taskId`),
      title: workerProse(memory.title, `areaMemory[${index}].title`, 512),
      result: workerProse(memory.result, `areaMemory[${index}].result`, MAX_AREA_MEMORY_RESULT_CHARACTERS),
      endedAt: workerTimestamp(memory.endedAt, `areaMemory[${index}].endedAt`),
    });
    if (parsed.taskId === currentTaskId) throw new ContractValidationError("Agent area memory includes the current task");
    return parsed;
  });
  if (new Set(areaMemory.map((entry) => entry.taskId)).size !== areaMemory.length) {
    throw new ContractValidationError("Agent area memory contains duplicate tasks");
  }
  if (areaMemory.some((entry, index) => {
    const previous = areaMemory[index - 1];
    return previous !== undefined && (entry.endedAt > previous.endedAt || entry.endedAt === previous.endedAt && entry.taskId >= previous.taskId);
  })) throw new ContractValidationError("Agent area memory ordering is invalid");

  if (!Array.isArray(item.messages) || item.messages.length > 50) throw new ContractValidationError("Agent context messages are invalid");
  const messages = item.messages.map((entry, index) => {
    const message = exact(entry, ["messageId", "cursor", "author", "body", "createdAt"], `Message ${index}`);
    if (message.author !== "human" && message.author !== "agent" && message.author !== "system") {
      throw new ContractValidationError(`Message ${index} author is invalid`);
    }
    return Object.freeze({
      messageId: identifier(message.messageId, `messages[${index}].messageId`),
      cursor: workerNonNegative(message.cursor, `messages[${index}].cursor`),
      author: message.author,
      body: workerProse(message.body, `messages[${index}].body`, 2_000),
      createdAt: workerTimestamp(message.createdAt, `messages[${index}].createdAt`),
    });
  });
  if (messages.some((message, index) => index > 0 && message.cursor <= messages[index - 1]!.cursor)) {
    throw new ContractValidationError("Agent context message cursors must increase strictly");
  }
  const since = workerNullableCursor(item.messagesSinceCursor, "messagesSinceCursor");
  const next = workerNonNegative(item.nextMessageCursor, "nextMessageCursor");
  if ((since !== null && next < since) || messages.some((message) => message.cursor <= (since ?? -1) || message.cursor > next)) {
    throw new ContractValidationError("Agent context message cursor binding is invalid");
  }

  if (!Array.isArray(item.openQuestions) || item.openQuestions.length > 16) {
    throw new ContractValidationError("Agent context questions are invalid");
  }
  const openQuestions = item.openQuestions.map((entry, index) => {
    const question = exact(entry, ["questionId", "question", "answer", "status"], `Question ${index}`);
    const status = contractMember(question.status, QUESTION_STATUSES, `Question ${index} status`);
    if (status === "open" && question.answer !== null) throw new ContractValidationError(`Question ${index} open answer is invalid`);
    if (status === "answered" && question.answer === null) throw new ContractValidationError(`Question ${index} answered value is missing`);
    return Object.freeze({
      questionId: identifier(question.questionId, `openQuestions[${index}].questionId`),
      question: workerProse(question.question, `openQuestions[${index}].question`, 2_000),
      answer: workerNullableProse(question.answer, `openQuestions[${index}].answer`, 4_000),
      status,
    });
  });
  const triggerQuestion = item.triggerQuestion === null ? null : (() => {
    const trigger = exact(item.triggerQuestion, ["questionId", "question", "answer"], "Trigger question");
    return Object.freeze({
      questionId: identifier(trigger.questionId, "triggerQuestion.questionId"),
      question: workerProse(trigger.question, "triggerQuestion.question", 2_000),
      answer: workerProse(trigger.answer, "triggerQuestion.answer", 4_000),
    });
  })();
  if (!Array.isArray(item.workspaceRefs) || item.workspaceRefs.length > 32) {
    throw new ContractValidationError("Agent context workspace references are invalid");
  }

  let workflow: ValidatedAgentContext["workflow"] = null;
  if (item.workflow !== null) {
    const workflowItem = exact(item.workflow, ["planRevisionId", "nodeId", "stage", "skills", "dependencyHandoffs"], "Workflow context");
    const workflowStage = contractMember(workflowItem.stage, WORKFLOW_STAGES, "Workflow stage");
    if (!Array.isArray(workflowItem.skills) || workflowItem.skills.length > 16) throw new ContractValidationError("Workflow skills are invalid");
    const skills = workflowItem.skills.map((entry, index) => {
      const skill = exact(entry, ["skillId", "name", "description", "digest", "content"], `Workflow skill ${index}`);
      if (typeof skill.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(skill.digest)) {
        throw new ContractValidationError(`Workflow skill ${index} digest is invalid`);
      }
      return Object.freeze({
        skillId: identifier(skill.skillId, `workflow.skills[${index}].skillId`),
        name: workerProse(skill.name, `workflow.skills[${index}].name`, 256),
        description: workerProse(skill.description, `workflow.skills[${index}].description`, 2_000),
        digest: skill.digest as SkillSnapshot["digest"],
        content: workerProse(skill.content, `workflow.skills[${index}].content`, 32_000),
      });
    });
    if (!Array.isArray(workflowItem.dependencyHandoffs) || workflowItem.dependencyHandoffs.length > 32) {
      throw new ContractValidationError("Workflow dependency handoffs are invalid");
    }
    const dependencyHandoffs = workflowItem.dependencyHandoffs.map(parseWorkerHandoffEntity);
    workflow = Object.freeze({
      planRevisionId: identifier(workflowItem.planRevisionId, "workflow.planRevisionId"),
      nodeId: identifier(workflowItem.nodeId, "workflow.nodeId"),
      stage: workflowStage,
      skills: Object.freeze(skills),
      dependencyHandoffs: Object.freeze(dependencyHandoffs),
    });
  }

  if (!Array.isArray(task.phases) || task.phases.length > 64) throw new ContractValidationError("Agent task phases are invalid");
  const phases = task.phases.map(parseWorkerContextPhase);
  if (new Set(phases.map((phase) => phase.phaseId)).size !== phases.length) {
    throw new ContractValidationError("Agent task phases contain duplicate phase IDs");
  }
  if (phases.some((phase, index) => {
    const previous = phases[index - 1];
    return previous !== undefined && (phase.orderKey < previous.orderKey || phase.orderKey === previous.orderKey && phase.phaseId <= previous.phaseId);
  })) throw new ContractValidationError("Agent task phase ordering is invalid");

  let parentEvidence: ValidatedAgentContext["parentEvidence"] = null;
  if (item.parentEvidence !== null) {
    const parent = exact(item.parentEvidence, [
      "taskId", "title", "objective", "acceptanceCriteria", "status", "assignedAgentId", "workspaceRefs", "startedAt", "endedAt", "result", "messages",
    ], "Parent evidence");
    if (!Array.isArray(parent.workspaceRefs) || parent.workspaceRefs.length > 32) {
      throw new ContractValidationError("Parent evidence workspace references are invalid");
    }
    if (!Array.isArray(parent.messages) || parent.messages.length > 12) throw new ContractValidationError("Parent evidence messages are invalid");
    const parentMessages = parent.messages.map((entry, index) => {
      const message = exact(entry, ["messageId", "author", "kind", "body", "createdAt"], `Parent message ${index}`);
      if (message.author !== "human" && message.author !== "agent") throw new ContractValidationError(`Parent message ${index} author is invalid`);
      if (message.kind !== "note" && message.kind !== "progress" && message.kind !== "proposal" && message.kind !== "result") {
        throw new ContractValidationError(`Parent message ${index} kind is invalid`);
      }
      return Object.freeze({
        messageId: identifier(message.messageId, `parent.messages[${index}].messageId`), author: message.author, kind: message.kind,
        body: workerProse(message.body, `parent.messages[${index}].body`, 2_000),
        createdAt: workerTimestamp(message.createdAt, `parent.messages[${index}].createdAt`),
      });
    });
    parentEvidence = Object.freeze({
      taskId: identifier(parent.taskId, "parent.taskId"), title: workerProse(parent.title, "parent.title", 512),
      objective: workerProse(parent.objective, "parent.objective", 8_000),
      acceptanceCriteria: workerProse(parent.acceptanceCriteria, "parent.acceptanceCriteria", 4_000),
      status: workerProse(parent.status, "parent.status", 64),
      assignedAgentId: parent.assignedAgentId === null ? null : identifier(parent.assignedAgentId, "parent.assignedAgentId"),
      workspaceRefs: Object.freeze(parent.workspaceRefs.map((entry, index) => workerProse(entry, `parent.workspaceRefs[${index}]`, 512))),
      startedAt: workerNullableTimestamp(parent.startedAt, "parent.startedAt"), endedAt: workerNullableTimestamp(parent.endedAt, "parent.endedAt"),
      result: workerNullableProse(parent.result, "parent.result", 4_000), messages: Object.freeze(parentMessages),
    });
  }

  return Object.freeze({
    apiVersion: 1,
    projectId: identifier(item.projectId, "context.projectId"), agentId: identifier(item.agentId, "context.agentId"), taskId: currentTaskId,
    mission: Object.freeze({ role: workerProse(mission.role, "mission.role", 64), area: workerProse(mission.area, "mission.area", 256), mission: workerProse(mission.mission, "mission.mission", 2_000) }),
    projectMemory: workerProse(item.projectMemory, "projectMemory", 8_000),
    task: Object.freeze({
      kind: contractMember(task.kind, TASK_KINDS, "task.kind") as TaskKind,
      requiredRole: task.requiredRole === null ? null : contractMember(task.requiredRole, AGENT_ROLES, "task.requiredRole") as AgentRole,
      title: workerProse(task.title, "task.title", 512), objective: workerProse(task.objective, "task.objective", 8_000),
      acceptanceCriteria: workerProse(task.acceptanceCriteria, "task.acceptanceCriteria", 4_000), version: workerPositive(task.version, "task.version"),
      expectedAgentMinutes: workerExpectedMinutes(task.expectedAgentMinutes, "task.expectedAgentMinutes"), phases: Object.freeze(phases),
    }),
    areaMemory: Object.freeze(areaMemory), parentEvidence, messagesSinceCursor: since, nextMessageCursor: next,
    messages: Object.freeze(messages), triggerQuestion, openQuestions: Object.freeze(openQuestions),
    workspaceRefs: Object.freeze(item.workspaceRefs.map((entry, index) => workerProse(entry, `workspaceRefs[${index}]`, 512))), workflow,
  });
}

export function parseWorkerAgentRunOutput(value: unknown): ValidatedAgentRunOutput {
  const discriminator = record(value, "Agent output").type;
  if (discriminator === "progress" || discriminator === "result") {
    const item = exact(value, ["type", "body"], discriminator === "progress" ? "Progress output" : "Result output");
    return Object.freeze({ type: discriminator, body: workerProse(item.body, `${discriminator}.body`, discriminator === "progress" ? 2_000 : 4_000) });
  }
  if (discriminator === "human_question") {
    const item = exact(value, ["type", "question"], "Human question output");
    return Object.freeze({ type: "human_question", question: workerProse(item.question, "question", 2_000) });
  }
  if (discriminator === "proposed_child_task") {
    const item = exact(value, ["type", "title", "objective", "acceptanceCriteria"], "Child-task proposal");
    if (!Array.isArray(item.acceptanceCriteria) || item.acceptanceCriteria.length < 1 || item.acceptanceCriteria.length > 16) {
      throw new ContractValidationError("Child-task acceptance criteria are invalid");
    }
    return Object.freeze({
      type: "proposed_child_task", title: workerProse(item.title, "proposal.title", 512),
      objective: workerProse(item.objective, "proposal.objective", 4_000),
      acceptanceCriteria: Object.freeze(item.acceptanceCriteria.map((criterion, index) =>
        workerProse(criterion, `proposal.acceptanceCriteria[${index}]`, 1_000))),
    });
  }
  throw new ContractValidationError("Agent output type is invalid");
}

function workerStringList(value: unknown, label: string, maximum = 32, minimum = 0): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new ContractValidationError(`${label} is invalid`);
  return Object.freeze(value.map((entry, index) => workerProse(entry, `${label}[${index}]`, 2_000)));
}

function parseWorkerHandoffDraft(value: unknown): StageHandoffDraft {
  const item = exact(value, ["outcome", "summary", "evidence", "artifactIds", "acceptanceCriteria", "blockers", "recommendedReturnStage"], "Stage handoff");
  if (!Array.isArray(item.acceptanceCriteria) || item.acceptanceCriteria.length > 32) {
    throw new ContractValidationError("Stage handoff criteria are invalid");
  }
  const criteria = item.acceptanceCriteria.map((entry, index) => {
    const criterion = exact(entry, ["criterion", "passed", "evidence"], `Stage handoff criterion ${index}`);
    if (typeof criterion.passed !== "boolean") throw new ContractValidationError(`Stage handoff criterion ${index} result is invalid`);
    return Object.freeze({ criterion: workerProse(criterion.criterion, "criterion", 1_000), passed: criterion.passed, evidence: workerProse(criterion.evidence, "criterion evidence", 2_000) });
  });
  return Object.freeze({
    outcome: contractMember(item.outcome, STAGE_HANDOFF_OUTCOMES, "Stage handoff outcome"),
    summary: workerProse(item.summary, "handoff.summary", 4_000), evidence: workerStringList(item.evidence, "handoff.evidence"),
    artifactIds: workerStringList(item.artifactIds, "handoff.artifactIds"), acceptanceCriteria: Object.freeze(criteria),
    blockers: workerStringList(item.blockers, "handoff.blockers"),
    recommendedReturnStage: item.recommendedReturnStage === null ? null : contractMember(item.recommendedReturnStage, WORKFLOW_STAGES, "Stage handoff return stage"),
  });
}

function parseWorkerWorkflowPlan(value: unknown): WorkflowPlanDraft {
  const item = exact(value, ["objective", "assumptions", "acceptanceCriteria", "nodes"], "Workflow plan");
  if (!Array.isArray(item.nodes) || item.nodes.length < 1 || item.nodes.length > 64) throw new ContractValidationError("Workflow plan nodes are invalid");
  const nodes = item.nodes.map((entry, index) => {
    const node = exact(entry, ["nodeId", "title", "objective", "acceptanceCriteria", "dependencyNodeIds", "stageTemplate"], `Workflow plan node ${index}`);
    if (!Array.isArray(node.stageTemplate) || node.stageTemplate.length < 1 || node.stageTemplate.length > 5) {
      throw new ContractValidationError(`Workflow plan node ${index} stages are invalid`);
    }
    const stageTemplate = node.stageTemplate.map((stage, stageIndex) => contractMember(stage, WORKFLOW_STAGES, `Workflow plan node ${index} stage ${stageIndex}`));
    if (new Set(stageTemplate).size !== stageTemplate.length || stageTemplate.at(-1) !== "verification") {
      throw new ContractValidationError(`Workflow plan node ${index} stage order is invalid`);
    }
    return Object.freeze({
      nodeId: identifier(node.nodeId, `workflowPlan.nodes[${index}].nodeId`), title: workerProse(node.title, `workflowPlan.nodes[${index}].title`, 512),
      objective: workerProse(node.objective, `workflowPlan.nodes[${index}].objective`, 4_000),
      acceptanceCriteria: workerStringList(node.acceptanceCriteria, `workflowPlan.nodes[${index}].acceptanceCriteria`, 64, 1),
      dependencyNodeIds: workerStringList(node.dependencyNodeIds, `workflowPlan.nodes[${index}].dependencyNodeIds`, 64),
      stageTemplate: Object.freeze(stageTemplate),
    });
  });
  return Object.freeze({
    objective: workerProse(item.objective, "workflowPlan.objective", 8_000), assumptions: workerStringList(item.assumptions, "workflowPlan.assumptions", 64),
    acceptanceCriteria: workerStringList(item.acceptanceCriteria, "workflowPlan.acceptanceCriteria", 64, 1), nodes: Object.freeze(nodes),
  });
}

export function parseWorkerAgentRunOutcome(value: unknown): ValidatedAgentRunOutcome {
  boundedJsonValue(value, MAX_OUTCOME_BYTES, "Agent outcome");
  const raw = record(value, "Agent outcome");
  const item = exact(value, [
    "status", "outputs", "expectedAgentMinutes", "phases", "detail",
    ...("handoff" in raw ? ["handoff"] : []), ...("workflowPlan" in raw ? ["workflowPlan"] : []),
  ], "Agent outcome");
  if (item.status !== "completed" && item.status !== "failed" && item.status !== "interrupted" && item.status !== "waiting_for_human") {
    throw new ContractValidationError("Agent outcome status is invalid");
  }
  if (!Array.isArray(item.outputs) || item.outputs.length > 64) throw new ContractValidationError("Agent outcome outputs are invalid");
  if (!Array.isArray(item.phases) || item.phases.length > 32) throw new ContractValidationError("Agent outcome phases are invalid");
  const outputs = item.outputs.map(parseWorkerAgentRunOutput);
  const phases = item.phases.map(parseWorkerPhaseUpdate);
  const ids = phases.flatMap((phase) => phase.phaseId === null ? [] : [phase.phaseId]);
  if (new Set(ids).size !== ids.length) throw new ContractValidationError("Agent outcome phases contain duplicate phase IDs");
  const results = outputs.filter((output) => output.type === "result").length;
  const questions = outputs.filter((output) => output.type === "human_question").length;
  if (item.status === "completed" ? results !== 1 || questions !== 0 : results !== 0) {
    throw new ContractValidationError("Agent outcome result does not match its terminal status");
  }
  if (item.status === "waiting_for_human" ? questions !== 1 : questions !== 0) {
    throw new ContractValidationError("Agent outcome question does not match its terminal status");
  }
  if (item.status === "waiting_for_human" && outputs.at(-1)?.type !== "human_question") {
    throw new ContractValidationError("A human question must be the final output because it ends the run");
  }
  return Object.freeze({
    status: item.status, outputs: Object.freeze(outputs), expectedAgentMinutes: workerExpectedMinutes(item.expectedAgentMinutes, "outcome.expectedAgentMinutes"),
    phases: Object.freeze(phases), detail: workerProse(item.detail, "outcome.detail", 2_000),
    handoff: item.handoff === undefined || item.handoff === null ? null : parseWorkerHandoffDraft(item.handoff),
    workflowPlan: item.workflowPlan === undefined || item.workflowPlan === null ? null : parseWorkerWorkflowPlan(item.workflowPlan),
  });
}

function boardFailure(message: string, code = "INVALID_REQUEST"): never {
  throw new ContractValidationError(message, code);
}

function boardExact(value: unknown, fields: readonly string[], label: string, named = false): JsonRecord {
  return exact(value, fields, label, { messages: named ? NAMED_EXACT_MESSAGES : GENERIC_EXACT_MESSAGES });
}

function boardAllowed(value: unknown, fields: readonly string[], required: readonly string[], label: string): JsonRecord {
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

function boardExpectedMinutes(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 15 || Number(value) > 10_080 || Number(value) % 15 !== 0) {
    boardFailure("expectedAgentMinutes must be a 15-minute interval between 15 and 10080", "INVALID_EXPECTED_AGENT_MINUTES");
  }
  return Number(value);
}

function boardNullableExpectedMinutes(value: unknown): number | null {
  return value === null ? null : boardExpectedMinutes(value);
}

function boardRefs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 32) boardFailure("workspaceRefs must be an array with at most 32 entries");
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
  const item = boardExact(value, ["name", "description"], "Project");
  return Object.freeze({ name: boardText(item.name, "name", 160), description: boardText(item.description, "description", 8_000) });
}

export function parseBoardConfirmPlan(value: unknown): ConfirmPlanRevisionRequest {
  const item = boardExact(value, ["expectedState"], "Plan confirmation", true);
  if (item.expectedState !== "proposed") boardFailure("expectedState must be proposed");
  return Object.freeze({ expectedState: "proposed" });
}

export function parseBoardCreateWorkItem(value: unknown): CreateWorkItemRequest {
  const item = boardAllowed(value, ["originalRequest", "priority", "projectTarget"], ["originalRequest"], "Work item");
  if (item.projectTarget === undefined) boardFailure("Choose a project", TASK_BOARD_ERROR_CODES.PROJECT_REQUIRED);
  return Object.freeze({
    originalRequest: boardText(item.originalRequest, "originalRequest", 16_000),
    priority: item.priority === undefined ? "normal" : contractMember(item.priority, WORK_ITEM_PRIORITIES, "priority", "priority is invalid"),
    projectTarget: boardProjectTarget(item.projectTarget),
  });
}

export function parseBoardUpdateWorkItem(value: unknown): UpdateWorkItemRequest {
  const item = boardAllowed(value, ["version", "priority", "projectTarget", "action", "reason"], ["version"], "Work item update");
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
  const result: { version: number; priority?: (typeof WORK_ITEM_PRIORITIES)[number]; projectTarget?: Extract<WorkItemProjectTarget, { mode: "explicit" }> } = { version };
  if ("priority" in item) result.priority = contractMember(item.priority, WORK_ITEM_PRIORITIES, "priority", "priority is invalid");
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
  const item = boardExact(value, ["agentTypeId", "name", "description", "role", "supplementalInstructions", "skillIds", "evaluatorProfile", "enabled"], label);
  if (!Array.isArray(item.skillIds) || item.skillIds.length > 32) boardFailure(`${label}.skillIds must be an array with at most 32 entries`);
  const skillIds = item.skillIds.map((entry, skillIndex) => boardSkillIdentifier(entry, `${label}.skillIds[${skillIndex}]`));
  if (new Set(skillIds).size !== skillIds.length) boardFailure(`${label}.skillIds contains a duplicate`);
  if (typeof item.enabled !== "boolean") boardFailure(`${label}.enabled must be a boolean`);
  const supplementalInstructions = text(item.supplementalInstructions, `${label}.supplementalInstructions`, {
    maximum: 8_000, allowEmpty: true, message: `${label}.supplementalInstructions is invalid`,
  });
  if (item.enabled && supplementalInstructions.length === 0) {
    boardFailure(`${label}.supplementalInstructions is required for an enabled agent type`);
  }
  return Object.freeze({
    agentTypeId: parseBoardIdentifier(item.agentTypeId, `${label}.agentTypeId`), name: boardText(item.name, `${label}.name`, 160),
    description: boardText(item.description, `${label}.description`, 4_000), role: boardRole(item.role, `${label}.role`),
    supplementalInstructions, skillIds: Object.freeze(skillIds),
    evaluatorProfile: contractMember(item.evaluatorProfile, EVALUATOR_PROFILES, "evaluatorProfile", "evaluatorProfile is invalid"), enabled: item.enabled,
  });
}

function parseBoardAutomationExecutor(value: unknown, label: string): AutomationStageExecutor {
  const item = record(value, label);
  if (item.kind === "agent_type") {
    const parsed = boardExact(item, ["kind", "agentTypeId"], label);
    return Object.freeze({ kind: "agent_type", agentTypeId: parseBoardIdentifier(parsed.agentTypeId, `${label}.agentTypeId`) });
  }
  if (item.kind === "human" || item.kind === "disabled") {
    boardExact(item, ["kind"], label); return Object.freeze({ kind: item.kind });
  }
  boardFailure(`${label}.kind is invalid`);
}

function parseBoardAutomationStages(value: unknown, agentTypes: readonly AutomationAgentType[]): readonly AutomationPipelineStage[] {
  if (!Array.isArray(value) || value.length !== WORK_ITEM_STAGES.length) {
    boardFailure(`stages must contain exactly ${WORK_ITEM_STAGES.length} entries`);
  }
  const stages = value.map((candidate, index): AutomationPipelineStage => {
    const label = `stages[${index}]`; const item = boardExact(candidate, ["stage", "executor"], label); const stage = WORK_ITEM_STAGES[index];
    if (stage === undefined || item.stage !== stage) boardFailure("stages must use the canonical order without duplicates");
    return Object.freeze({ stage, executor: parseBoardAutomationExecutor(item.executor, `${label}.executor`) });
  });
  const types = new Map(agentTypes.map((entry) => [entry.agentTypeId, entry] as const));
  for (const entry of stages) {
    if (entry.stage === "human_review") { if (entry.executor.kind !== "human") boardFailure("human_review must use the human executor"); continue; }
    if (entry.stage === "deployment") { if (entry.executor.kind !== "disabled") boardFailure("deployment must remain disabled"); continue; }
    if (entry.executor.kind === "human") boardFailure(`${entry.stage} cannot use the human executor`);
    if (entry.executor.kind === "disabled") continue;
    const agentType = types.get(entry.executor.agentTypeId);
    if (agentType === undefined) boardFailure(`${entry.stage} references an unknown agent type`);
    if (!agentType.enabled) boardFailure(`${entry.stage} references a disabled agent type`);
    const roles: readonly AgentRole[] = AUTOMATION_STAGE_ROLES[entry.stage];
    if (!roles.includes(agentType.role)) boardFailure(`${entry.stage} cannot use an agent type with the ${agentType.role} role`);
  }
  return Object.freeze(stages);
}

export function parseBoardAutomationUpdate(value: unknown): UpdateAutomationConfigurationRequest {
  const item = boardExact(value, ["version", "agentTypes", "stages"], "Automation configuration update");
  if (!Array.isArray(item.agentTypes) || item.agentTypes.length > 32) boardFailure("agentTypes must be an array with at most 32 entries");
  const agentTypes = item.agentTypes.map(parseBoardAutomationAgentType);
  if (new Set(agentTypes.map((entry) => entry.agentTypeId)).size !== agentTypes.length) boardFailure("agentTypes contains a duplicate agentTypeId");
  const stages = parseBoardAutomationStages(item.stages, agentTypes);
  if (new TextEncoder().encode(JSON.stringify({ agentTypes, stages })).byteLength > AUTOMATION_CONFIGURATION_MAX_BYTES) {
    boardFailure(`Automation configuration exceeds ${AUTOMATION_CONFIGURATION_MAX_BYTES} UTF-8 JSON bytes`);
  }
  return Object.freeze({ version: boardPositiveVersion(item.version), agentTypes: Object.freeze(agentTypes), stages });
}

export function parseBoardCreateAgent(value: unknown): CreateAgentRequest {
  const item = boardExact(value, ["agentId", "role", "area", "mission", "model", "token"], "Agent profile");
  if (typeof item.token !== "string" || item.token.length < 32 || item.token.length > 512 || item.token.trim() !== item.token || /[\u0000-\u001f\u007f]/u.test(item.token)) {
    boardFailure("token is invalid");
  }
  return Object.freeze({ agentId: parseBoardIdentifier(item.agentId, "agentId"), role: boardRole(item.role),
    area: boardText(item.area, "area", 256), mission: boardText(item.mission, "mission", 4_000),
    model: parseBoardIdentifier(item.model, "model"), token: item.token });
}

export function parseBoardRotateAgentToken(value: unknown): RotateAgentTokenRequest {
  const item = boardExact(value, ["version"], "Agent token rotation"); return Object.freeze({ version: boardPositiveVersion(item.version) });
}

export function parseBoardCreateTask(value: unknown): CreateTaskRequest {
  const item = boardAllowed(value, ["parentTaskId", "title", "objective", "acceptanceCriteria", "workspaceRefs", "assignedAgentId", "assignedRole", "requiresReview", "expectedAgentMinutes"],
    ["parentTaskId", "title", "objective", "acceptanceCriteria", "workspaceRefs", "assignedAgentId", "assignedRole"], "Task");
  const assignedAgentId = boardNullableIdentifier(item.assignedAgentId, "assignedAgentId");
  const assignedRole = boardNullableRole(item.assignedRole, "assignedRole");
  if ((assignedAgentId === null) !== (assignedRole === null)) {
    boardFailure("assignedAgentId and assignedRole must both be set or both be null", "INVALID_ASSIGNMENT");
  }
  if ("expectedAgentMinutes" in item) boardExpectedMinutes(item.expectedAgentMinutes);
  if ("requiresReview" in item && typeof item.requiresReview !== "boolean") boardFailure("requiresReview must be a boolean");
  return Object.freeze({ parentTaskId: boardNullableIdentifier(item.parentTaskId, "parentTaskId"), title: boardText(item.title, "title", 240),
    objective: boardText(item.objective, "objective", 8_000), acceptanceCriteria: boardText(item.acceptanceCriteria, "acceptanceCriteria", 8_000),
    workspaceRefs: boardRefs(item.workspaceRefs), assignedAgentId, assignedRole,
    requiresReview: item.requiresReview === undefined ? true : item.requiresReview as boolean });
}

export function parseBoardCreateTaskPhase(value: unknown): CreateTaskPhaseRequest {
  const item = boardExact(value, ["title", "stage", "parallelGroup"], "Task phase");
  return Object.freeze({ title: boardText(item.title, "title", 240), stage: contractMember(item.stage, TASK_PHASE_STAGES, "stage", "stage is invalid"),
    parallelGroup: boardNullableIdentifier(item.parallelGroup, "parallelGroup") });
}

export function parseBoardUpdateTaskPhase(value: unknown): UpdateTaskPhaseRequest {
  const item = boardAllowed(value, ["version", "title", "stage", "status", "parallelGroup", "orderKey"], ["version"], "Task phase update");
  if (Object.keys(item).length === 1) boardFailure("Task phase update contains no changes");
  const result: { version: number; title?: string; stage?: TaskPhaseStage; status?: TaskPhaseStatus; parallelGroup?: string | null; orderKey?: number } = { version: boardPositiveVersion(item.version) };
  if ("title" in item) result.title = boardText(item.title, "title", 240);
  if ("stage" in item) result.stage = contractMember(item.stage, TASK_PHASE_STAGES, "stage", "stage is invalid");
  if ("status" in item) result.status = contractMember(item.status, TASK_PHASE_STATUSES, "phase status", "phase status is invalid");
  if ("parallelGroup" in item) result.parallelGroup = boardNullableIdentifier(item.parallelGroup, "parallelGroup");
  if ("orderKey" in item) result.orderKey = boardNonNegative(item.orderKey, "orderKey");
  return Object.freeze(result);
}

function boardDocumentContent(value: unknown): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > DOCUMENT_CONTENT_MAX_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    boardFailure("content must be valid text no larger than 48 KiB", "INVALID_DOCUMENT_CONTENT");
  }
  return value;
}

export function parseBoardCreateDocument(value: unknown): CreateDocumentRequest {
  const item = boardExact(value, ["title", "contentType", "content", "clientId"], "Document");
  if (item.contentType !== "text/markdown") boardFailure("contentType must be text/markdown", "INVALID_DOCUMENT_CONTENT_TYPE");
  return Object.freeze({ title: boardText(item.title, "title", 240), contentType: "text/markdown", content: boardDocumentContent(item.content),
    clientId: parseBoardIdentifier(item.clientId, "clientId") });
}

export function parseBoardDocumentPenUpdate(value: unknown): UpdateDocumentPenRequest {
  const item = boardExact(value, ["action", "clientId", "expectedPenEpoch", "force"], "Document pen update");
  if (item.action !== "acquire" && item.action !== "release") boardFailure("Document pen action is invalid");
  if (typeof item.force !== "boolean" || item.action === "release" && item.force) boardFailure("force is only valid when acquiring the pen");
  return Object.freeze({ action: item.action, clientId: parseBoardIdentifier(item.clientId, "clientId"),
    expectedPenEpoch: boardNonNegative(item.expectedPenEpoch, "expectedPenEpoch"), force: item.force }) as UpdateDocumentPenRequest;
}

export function parseBoardDocumentUpdate(value: unknown): UpdateDocumentRequest {
  const item = boardExact(value, ["clientId", "penEpoch", "contentVersion", "content"], "Document update");
  return Object.freeze({ clientId: parseBoardIdentifier(item.clientId, "clientId"), penEpoch: boardPositiveVersion(item.penEpoch),
    contentVersion: boardPositiveVersion(item.contentVersion), content: boardDocumentContent(item.content) });
}

export function parseBoardUpdateTask(value: unknown): UpdateTaskRequest {
  const item = boardAllowed(value, ["version", "title", "objective", "acceptanceCriteria", "workspaceRefs", "assignedAgentId", "assignedRole",
    "expectedAgentMinutes", "orderKey", "status", "result"], ["version"], "Task update");
  if (Object.keys(item).length === 1) boardFailure("Task update contains no changes");
  if (("assignedAgentId" in item) !== ("assignedRole" in item)) boardFailure("Assignment fields must be updated together", "INVALID_ASSIGNMENT");
  const result: { version: number; title?: string; objective?: string; acceptanceCriteria?: string; workspaceRefs?: readonly string[];
    assignedAgentId?: string | null; assignedRole?: AgentRole | null; expectedAgentMinutes?: number | null; orderKey?: number;
    status?: TaskStatus; result?: string | null } = { version: boardPositiveVersion(item.version) };
  if ("title" in item) result.title = boardText(item.title, "title", 240);
  if ("objective" in item) result.objective = boardText(item.objective, "objective", 8_000);
  if ("acceptanceCriteria" in item) result.acceptanceCriteria = boardText(item.acceptanceCriteria, "acceptanceCriteria", 8_000);
  if ("workspaceRefs" in item) result.workspaceRefs = boardRefs(item.workspaceRefs);
  if ("assignedAgentId" in item) {
    result.assignedAgentId = boardNullableIdentifier(item.assignedAgentId, "assignedAgentId"); result.assignedRole = boardNullableRole(item.assignedRole, "assignedRole");
    if ((result.assignedAgentId === null) !== (result.assignedRole === null)) {
      boardFailure("Assignment fields must both be set or both be null", "INVALID_ASSIGNMENT");
    }
  }
  if ("expectedAgentMinutes" in item) result.expectedAgentMinutes = boardNullableExpectedMinutes(item.expectedAgentMinutes);
  if ("orderKey" in item) result.orderKey = boardNonNegative(item.orderKey, "orderKey");
  if ("status" in item) result.status = contractMember(item.status, TASK_STATUSES, "status", "status is invalid");
  if ("result" in item) result.result = item.result === null ? null : boardText(item.result, "result", 16_000);
  return Object.freeze(result);
}

export function parseBoardRetryTask(value: unknown): RetryTaskRequest {
  const item = boardExact(value, ["version"], "Task retry"); return Object.freeze({ version: boardPositiveVersion(item.version) });
}

export function parseBoardBacklogTask(value: unknown): BacklogTaskRequest {
  const item = boardExact(value, ["version"], "Task backlog transition"); return Object.freeze({ version: boardPositiveVersion(item.version) });
}

export function parseBoardAgentMessage(value: unknown): CreateTaskMessageRequest {
  const item = boardExact(value, ["clientEventId", "kind", "body", "runId"], "Agent task message");
  if (item.kind !== "progress" && item.kind !== "proposal" && item.kind !== "result") boardFailure("Agent message kind is invalid");
  return Object.freeze({ clientEventId: parseBoardIdentifier(item.clientEventId, "clientEventId"), kind: item.kind,
    body: boardText(item.body, "body", 16_000), runId: parseBoardIdentifier(item.runId, "runId") });
}

export function parseBoardHumanMessage(value: unknown): CreateHumanTaskMessageRequest {
  const item = boardExact(value, ["clientEventId", "kind", "body"], "Human task message");
  if (item.kind !== "note") boardFailure("Human messages must use note kind");
  return Object.freeze({ clientEventId: parseBoardIdentifier(item.clientEventId, "clientEventId"), kind: "note", body: boardText(item.body, "body", 16_000) });
}

export function parseBoardQuestion(value: unknown): CreateHumanQuestionRequest {
  const item = boardExact(value, ["clientEventId", "question", "runId"], "Human question");
  return Object.freeze({ clientEventId: parseBoardIdentifier(item.clientEventId, "clientEventId"), question: boardText(item.question, "question", 8_000),
    runId: parseBoardIdentifier(item.runId, "runId") });
}

export function parseBoardAnswer(value: unknown): AnswerHumanQuestionRequest {
  const item = boardExact(value, ["answer", "version"], "Question answer");
  return Object.freeze({ answer: boardText(item.answer, "answer", 16_000), version: boardPositiveVersion(item.version) });
}

export function parseBoardResume(value: unknown): ResumeAgentRequest {
  const item = boardExact(value, ["reason", "taskId"], "Agent resume");
  return Object.freeze({ reason: boardText(item.reason, "reason", 2_000), taskId: boardNullableIdentifier(item.taskId, "taskId") });
}

export function parseBoardInterrupt(value: unknown): InterruptAgentRequest {
  const item = boardExact(value, ["reason"], "Agent interrupt"); return Object.freeze({ reason: boardText(item.reason, "reason", 2_000) });
}

export function parseBoardLaneErrorDetail(value: unknown, maximum: number): string | null {
  const item = boardExact(value, ["detail"], "Agent lane error");
  return item.detail === null ? null : boardText(item.detail, "detail", maximum);
}

export function parseBoardClaim(value: unknown): ClaimRunRequest {
  const item = record(value, "Run claim"); const keys = Object.keys(item).sort();
  const legacy = keys.length === 2 && keys[0] === "claimId" && keys[1] === "messageCursor";
  const perTask = keys.length === 2 && keys[0] === "claimId" && keys[1] === "messageCursors";
  if (!legacy && !perTask) boardFailure("Run claim has unexpected or missing fields");
  const claimId = parseBoardIdentifier(item.claimId, "claimId");
  if (legacy) {
    const cursor = item.messageCursor;
    if (cursor !== null && (!Number.isSafeInteger(cursor) || Number(cursor) < 0)) {
      boardFailure("messageCursor must be null or a non-negative safe integer");
    }
    return Object.freeze({ claimId, messageCursor: cursor === null ? null : Number(cursor) });
  }
  if (item.messageCursors === null || typeof item.messageCursors !== "object" || Array.isArray(item.messageCursors)) {
    boardFailure("messageCursors must be an object with at most 256 task entries");
  }
  const rawCursors = record(item.messageCursors, "messageCursors");
  if (Object.keys(rawCursors).length > 256) boardFailure("messageCursors must be an object with at most 256 task entries");
  const messageCursors: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [taskId, cursor] of Object.entries(rawCursors)) {
    parseBoardIdentifier(taskId, "messageCursors taskId");
    if (!Number.isSafeInteger(cursor) || Number(cursor) < 0) boardFailure("messageCursors values must be non-negative safe integers");
    messageCursors[taskId] = Number(cursor);
  }
  return Object.freeze({ claimId, messageCursors: Object.freeze(messageCursors) });
}

function boardStringList(value: unknown, field: string, maximum = 32, minimum = 0): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) boardFailure(`${field} is invalid`);
  return Object.freeze(value.map((entry, index) => boardText(entry, `${field}[${index}]`, 2_000)));
}

function parseBoardHandoffDraft(value: unknown): StageHandoffDraft {
  if (value === null || typeof value !== "object" || Array.isArray(value)) boardFailure("handoff is invalid");
  const raw = boardExact(value, ["outcome", "summary", "evidence", "artifactIds", "acceptanceCriteria", "blockers", "recommendedReturnStage"], "handoff");
  if (!Array.isArray(raw.acceptanceCriteria) || raw.acceptanceCriteria.length > 32) boardFailure("handoff criteria are invalid");
  const criteria = raw.acceptanceCriteria.map((entry, index) => {
    const criterion = boardExact(entry, ["criterion", "passed", "evidence"], `handoff criterion ${index}`);
    if (typeof criterion.passed !== "boolean") boardFailure("handoff criterion result is invalid");
    return Object.freeze({ criterion: boardText(criterion.criterion, "criterion", 1_000), passed: criterion.passed, evidence: boardText(criterion.evidence, "evidence", 2_000) });
  });
  return Object.freeze({ outcome: contractMember(raw.outcome, STAGE_HANDOFF_OUTCOMES, "handoff outcome", "handoff outcome is invalid"),
    summary: boardText(raw.summary, "handoff.summary", 4_000), evidence: boardStringList(raw.evidence, "handoff.evidence"),
    artifactIds: boardStringList(raw.artifactIds, "handoff.artifactIds"), acceptanceCriteria: Object.freeze(criteria),
    blockers: boardStringList(raw.blockers, "handoff.blockers"), recommendedReturnStage: raw.recommendedReturnStage === null ? null :
      contractMember(raw.recommendedReturnStage, WORKFLOW_STAGES, "handoff return stage", "handoff return stage is invalid") });
}

function parseBoardWorkflowPlan(value: unknown): WorkflowPlanDraft {
  const plan = boardExact(value, ["objective", "assumptions", "acceptanceCriteria", "nodes"], "workflowPlan");
  if (!Array.isArray(plan.nodes) || plan.nodes.length < 1 || plan.nodes.length > 64) boardFailure("workflowPlan.nodes is invalid");
  const nodes = plan.nodes.map((entry, index) => {
    const node = boardExact(entry, ["nodeId", "title", "objective", "acceptanceCriteria", "dependencyNodeIds", "stageTemplate"], `workflowPlan.nodes[${index}]`);
    const stages = boardStringList(node.stageTemplate, `workflowPlan.nodes[${index}].stageTemplate`, 64, 1);
    if (stages.length > 5 || new Set(stages).size !== stages.length || stages.at(-1) !== "verification" ||
      stages.some((stage) => !(WORKFLOW_STAGES as readonly string[]).includes(stage))) {
      boardFailure(`workflowPlan.nodes[${index}].stageTemplate is invalid`);
    }
    return Object.freeze({ nodeId: parseBoardIdentifier(node.nodeId, `workflowPlan.nodes[${index}].nodeId`),
      title: boardText(node.title, `workflowPlan.nodes[${index}].title`, 512), objective: boardText(node.objective, `workflowPlan.nodes[${index}].objective`, 4_000),
      acceptanceCriteria: boardStringList(node.acceptanceCriteria, `workflowPlan.nodes[${index}].acceptanceCriteria`, 64, 1),
      dependencyNodeIds: boardStringList(node.dependencyNodeIds, `workflowPlan.nodes[${index}].dependencyNodeIds`, 64),
      stageTemplate: Object.freeze(stages as WorkflowStage[]) });
  });
  return Object.freeze({ objective: boardText(plan.objective, "workflowPlan.objective", 8_000), assumptions: boardStringList(plan.assumptions, "workflowPlan.assumptions", 64),
    acceptanceCriteria: boardStringList(plan.acceptanceCriteria, "workflowPlan.acceptanceCriteria", 64, 1), nodes: Object.freeze(nodes) });
}

export function parseBoardSettle(value: unknown): SettleRunRequest {
  const raw = record(value, "Run settlement");
  const item = boardExact(value, ["outcome", "result", ...("handoff" in raw ? ["handoff"] : []), ...("workflowPlan" in raw ? ["workflowPlan"] : [])], "Run settlement");
  if (item.outcome !== "completed" && item.outcome !== "failed" && item.outcome !== "interrupted") boardFailure("Run outcome is invalid");
  return Object.freeze({ outcome: item.outcome, result: boardText(item.result, "result", 16_000),
    handoff: item.handoff === undefined || item.handoff === null ? null : parseBoardHandoffDraft(item.handoff),
    workflowPlan: item.workflowPlan === undefined || item.workflowPlan === null ? null : parseBoardWorkflowPlan(item.workflowPlan) });
}

export function parseBoardIdempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) {
    boardFailure("A valid Idempotency-Key header is required", "INVALID_IDEMPOTENCY_KEY");
  }
  return value;
}
