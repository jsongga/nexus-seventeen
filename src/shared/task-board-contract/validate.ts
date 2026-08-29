import {
  ACTOR_TYPES,
  AGENT_GAP_REPORT_MAX_CHARACTERS,
  AGENT_ROLES,
  AGENT_STATUSES,
  AUTOMATION_CONFIGURATION_MAX_BYTES,
  ContractValidationError,
  DESIGN_FAILURE_POINTS,
  DESIGN_RECORD_DETAIL_MAX_LENGTH,
  DESIGN_RECORD_LABEL_MAX_LENGTH,
  DESIGN_RECORD_MAX_FAILURE_POINTS,
  DESIGN_RECORD_MAX_FAULT_INJECTION_CASES,
  DESIGN_RECORD_MAX_IDEMPOTENCY_KEYS,
  DESIGN_RECORD_MAX_STATES,
  DESIGN_RECORD_MAX_TRANSITIONS,
  EVALUATOR_PROFILES,
  GATE_KINDS,
  GIT_OBJECT_ID_PATTERN,
  IDENTIFIER_PATTERN,
  MAX_AGENT_CONTEXT_BYTES,
  MAX_DESIGN_CONTEXT_BYTES,
  MAX_AREA_MEMORY_RESULT_CHARACTERS,
  MAX_INTERNAL_TASK_OBJECTIVE_CHARACTERS,
  NOTIFICATION_KINDS,
  PARK_CATEGORIES,
  PARK_RESOLUTIONS,
  PLAN_CHANGE_SHAPES,
  PLAN_REVISION_STATES,
  PLAN_TIERS,
  QUESTION_STATUSES,
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_DRAFT_MAX_ITEMS,
  REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_WORKSPACE_SUFFIX,
  RUN_STATUSES,
  STAGE_HANDOFF_BLOCKERS_MAX_ITEMS,
  STAGE_HANDOFF_OUTCOMES,
  STAGE_HANDOFF_SUMMARY_MAX_CHARACTERS,
  TASK_BOARD_API_VERSION,
  TASK_BOARD_ERROR_CODES,
  TASK_KINDS,
  TASK_MESSAGE_ACTOR_TYPES,
  TASK_MESSAGE_KINDS,
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  TASK_STATUSES,
  VERIFY_WORKSPACE_SUFFIX,
  WAKEUP_REASONS,
  WORKER_CONNECTIONS,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_PHASES,
  WORK_ITEM_STAGES,
  WORK_ITEM_STATES,
  WORK_ITEM_TASK_TYPES,
  WORK_NODE_STATES,
  WORKFLOW_STAGES,
  isTerminalWorkItemState,
  isValidCrossRepoMarkdown,
  declaredScopesOverlap,
  normalizeDeclaredScope,
  type AgentInterrupt,
  type AgentProfile,
  type AgentRole,
  type AgentRun,
  type AnswerHumanQuestionRequest,
  type ApprovePipelineMergeRequest,
  type AttestDeployRequest,
  type AutomationAgentType,
  type AutomationConfiguration,
  type AutomationPipelineStage,
  type AutomationStageExecutor,
  type BoardPause,
  type BoardNotification,
  type BoardSnapshot,
  type BoardTask,
  type BacklogTaskRequest,
  type ClaimRunResult,
  type ClaimRunPausedResult,
  type ClaimRunRequest,
  type ConfirmPlanRevisionRequest,
  type CriterionResult,
  type CreateAgentRequest,
  type CreateHumanQuestionRequest,
  type CreateHumanTaskMessageRequest,
  type CreateProjectRequest,
  type CreateTaskMessageRequest,
  type CreateTaskPhaseRequest,
  type CreateTaskRequest,
  type CreateWorkItemRequest,
  type CrossRepoContext,
  type DesignFailurePoint,
  type DesignFailurePointKind,
  type DesignRecord,
  type DesignRecordDraft,
  type DeclaredChild,
  type FindingsLedger,
  type GateAction,
  type HumanQuestion,
  type InterruptAgentRequest,
  type PlanRecordFields,
  type PlanRevision,
  type ParkCategory,
  type ParkRecord,
  type ParksLedger,
  type PipelineSummary,
  type Project,
  type ProjectArtifact,
  type ProjectEvent,
  type PublishedInterfaceFailureReason,
  type ReviewFinding,
  type ReviewFindingCategory,
  type ReviewFindingDraft,
  type ReviewFindingSeverity,
  type RejectPlanRevisionRequest,
  type RejectFinalApprovalRequest,
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
  type UpdateTaskPhaseRequest,
  type UpdateTaskRequest,
  type UpdateWorkItemRequest,
  type VerifyAttempt,
  type WorkItem,
  type WorkItemAudit,
  type WorkItemProjectTarget,
  type WorkItemState,
  type WorkItemPhase,
  type WorkItemTransition,
  type WorkNode,
  type WorkflowStage,
  type WorkflowPipelineContext,
  type WorkflowFixContext,
  type WorkflowReviewContext,
  type WorkflowPlanDraft,
} from "./index.js";

export type JsonRecord = Record<string, unknown>;
export { ContractValidationError };

interface ExactMessageMap {
  readonly unexpected: (label: string, field: string) => string;
  readonly missing: (label: string, field: string) => string;
}

const GENERIC_EXACT_MESSAGES: ExactMessageMap = Object.freeze({
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

interface FieldSetOptions {
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

interface ScalarMessageProfile {
  readonly stringType: (label: string) => string;
  readonly integerAtLeast: (label: string, minimum: number) => string;
}

/** Browser responses historically reported scalar type errors before semantic errors. */
export const BROWSER_SCALAR_MESSAGES: ScalarMessageProfile = Object.freeze({
  stringType: (label: string) => `${label} must be a string`,
  integerAtLeast: (label: string, minimum: number) => `${label} must be a safe integer of at least ${minimum}`,
});

interface TextOptions {
  readonly maximum?: number;
  readonly allowEmpty?: boolean;
  readonly trim?: boolean;
  readonly message?: string;
  readonly scalarMessages?: ScalarMessageProfile;
  /** Production worker writes normalize at `normalizeCarriageReturns` in task-worker/worker.ts. */
  readonly carriageReturns?: "reject" | "normalize" | "preserve";
}

/** Human-entered board text: trim at the boundary and reject control characters. */
function text(value: unknown, label: string, options: TextOptions = {}): string {
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

interface ProseOptions {
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

function contractMember<const Values extends readonly string[]>(
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

interface ShapeParserOptions {
  /** False preserves the browser adapter's rolling compatibility with additive fields. */
  readonly exact?: false | ExactMessageMap;
  /** Browser response projections historically treated wire IDs as opaque strings. */
  readonly identifiers?: "contract" | "string";
  readonly identifierMessages?: "invalid" | "valid-identifier";
  readonly scalarMessages?: ScalarMessageProfile;
  /** Skip fields that the browser's legacy raw projection intentionally discarded. */
  readonly projection?: "contract" | "browser";
  /** Bucket explicitly forward-compatible browser enum fields. */
  readonly tolerantEnums?: boolean;
}

export type TolerantTaskEntity = Omit<BoardTask, "status"> & Readonly<{
  status: TaskStatus | "unrecognized";
}>;

export type TolerantWorkItemEntity = Omit<WorkItem, "state" | "taskType" | "phase"> & Readonly<{
  state: WorkItemState | "unrecognized";
  taskType: string;
  phase: WorkItemPhase | "unrecognized" | null;
}>;

export type TolerantDeclaredChild = Omit<DeclaredChild, "phase"> & Readonly<{
  phase?: WorkItemPhase | "unrecognized";
}>;

export type TolerantPlanRevision = Omit<PlanRevision, "children"> & Readonly<{
  children: readonly TolerantDeclaredChild[] | null;
}>;

export type TolerantParkRecord = Omit<ParkRecord, "category" | "resolution"> & Readonly<{
  category: ParkCategory | "unrecognized";
  resolution: typeof PARK_RESOLUTIONS[number] | "unrecognized" | null;
}>;

export type TolerantBoardNotification = Omit<BoardNotification, "kind"> & Readonly<{
  kind: typeof NOTIFICATION_KINDS[number] | "unrecognized";
}>;

export type TolerantGateAction = Omit<GateAction, "gate"> & Readonly<{
  gate: typeof GATE_KINDS[number] | "unrecognized";
}>;

export type TolerantReviewFindingEntity = Omit<ReviewFinding, "category" | "severity" | "stage"> & Readonly<{
  category: ReviewFindingCategory | "unrecognized";
  severity: ReviewFindingSeverity | "unrecognized";
  stage: WorkflowStage | "unrecognized";
}>;

export interface TolerantFindingsLedger {
  readonly categories: readonly {
    readonly category: ReviewFindingCategory | "unrecognized";
    readonly severity: ReviewFindingSeverity | "unrecognized";
    readonly blocking: boolean;
    readonly count: number;
  }[];
  readonly perProject: readonly {
    readonly projectId: string;
    readonly category: ReviewFindingCategory | "unrecognized";
    readonly count: number;
  }[];
  readonly recent: readonly (TolerantReviewFindingEntity & { readonly workItemId: string })[];
}

export interface TolerantParksLedger {
  readonly open: readonly (TolerantParkRecord & { readonly workItemTitle: string })[];
  readonly resolved: readonly (TolerantParkRecord & { readonly workItemTitle: string })[];
  readonly recordsSince: string;
}

type TolerantDesignFailurePoint = Omit<DesignFailurePoint, "point"> & Readonly<{
  point: DesignFailurePointKind | "unrecognized";
}>;

export type TolerantDesignRecordEntity = Omit<DesignRecord, "failurePoints"> & Readonly<{
  failurePoints: readonly TolerantDesignFailurePoint[];
}>;

export type ParsedWorkItemTransition = WorkItemTransition;

export type TolerantWorkItemAudit = Omit<WorkItemAudit, "gateActions"> & Readonly<{
  gateActions: readonly TolerantGateAction[];
}>;

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
  message: string | undefined,
  tolerateUnknown: true,
): Values[number] | "unrecognized";
function entityMember<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
  options: ShapeParserOptions,
  message?: string,
  tolerateUnknown?: false,
): Values[number];
function entityMember<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
  options: ShapeParserOptions,
  message = `${label} has an unsupported value`,
  tolerateUnknown = false,
): Values[number] | "unrecognized" {
  if (
    tolerateUnknown && options.tolerantEnums === true && options.projection === "browser" && typeof value === "string" &&
    !(values as readonly string[]).includes(value)
  ) return "unrecognized";
  return contractMember(value, values, label, message, options.scalarMessages);
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : stringValue(value, label);
}

interface ExpectedMinutesOptions {
  readonly nullable?: boolean;
  readonly undefinedIsNull?: boolean;
  readonly maximum?: number;
  readonly message: (label: string) => string;
  readonly code?: string;
  readonly scalarMessages?: ScalarMessageProfile;
}

function expectedMinutes(value: unknown, label: string, options: ExpectedMinutesOptions): number | null {
  if ((options.nullable && value === null) || (options.undefinedIsNull && value === undefined)) return null;
  if (options.scalarMessages !== undefined && (!Number.isSafeInteger(value) || Number(value) < 15)) {
    throw new ContractValidationError(options.scalarMessages.integerAtLeast(label, 15), options.code);
  }
  if (
    !Number.isSafeInteger(value) || Number(value) < 15 || Number(value) % 15 !== 0 ||
    (options.maximum !== undefined && Number(value) > options.maximum)
  ) {
    throw new ContractValidationError(options.message(label), options.code);
  }
  return Number(value);
}

export function parseProjectEntity(value: unknown, label: string, options: ShapeParserOptions = {}): Project {
  const fields = ["apiVersion", "projectId", "name", "description", "repoPath", "version", "createdAt", "updatedAt"];
  const required = options.projection === "browser" ? fields.filter((field) => field !== "repoPath") : fields;
  const item = entity(value, label, fields, required, options);
  const description = stringValue(item.description, `${label}.description`);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    name: stringValue(item.name, `${label}.name`),
    description,
    repoPath: item.repoPath === undefined ? description : stringValue(item.repoPath, `${label}.repoPath`),
    version: integer(item.version, `${label}.version`, 1),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    updatedAt: entityTimestamp(item.updatedAt, `${label}.updatedAt`, options),
  });
}

function parseWorkItemProjectTargetEntity(
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

export function parseWorkItemTransitionEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): ParsedWorkItemTransition {
  const fields = ["fromState", "toState", "actorType", "actorId", "createdAt"];
  const item = shape(value, label, fields, fields, options);
  return Object.freeze({
    fromState: item.fromState === null
      ? null
      : entityMember(item.fromState, WORK_ITEM_STATES, `${label}.fromState`, options),
    toState: entityMember(item.toState, WORK_ITEM_STATES, `${label}.toState`, options),
    actorType: entityMember(item.actorType, ACTOR_TYPES, `${label}.actorType`, options),
    actorId: stringValue(item.actorId, `${label}.actorId`),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
  });
}

export function parseWorkItemEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>,
): TolerantWorkItemEntity;
export function parseWorkItemEntity(value: unknown, label: string, options?: ShapeParserOptions): WorkItem;
export function parseWorkItemEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): WorkItem | TolerantWorkItemEntity {
  const fields = [
    "apiVersion", "workItemId", "originalRequest", "refinedObjective", "priority", "taskType", "projectTarget", "resolvedProjectId",
    "parentWorkItemId", "phase", "childOrdinal", "planningTaskId", "pipelineBranch", "baseSha", "state", "currentStage", "stateSince", "reviewRound", "heartbeatAt",
    "createdBy", "version", "createdAt", "updatedAt", "endedAt", "cancelledReason", "archivedAt", "transitions",
  ];
  const optional = new Set([
    "transitions", "pipelineBranch", "baseSha", "stateSince", "reviewRound", "heartbeatAt",
    ...(options.projection === "browser" ? ["parentWorkItemId", "phase", "childOrdinal"] : []),
  ]);
  const required = fields.filter((field) => !optional.has(field));
  const item = entity(value, label, fields, required, options);
  const projectTarget = parseWorkItemProjectTargetEntity(item.projectTarget, `${label}.projectTarget`, options);
  const taskType = options.projection === "browser" && options.tolerantEnums === true
    ? stringValue(item.taskType, `${label}.taskType`)
    : entityMember(item.taskType, WORK_ITEM_TASK_TYPES, `${label}.taskType`, options);
  const resolvedProjectId = nullableIdentifier(item.resolvedProjectId, `${label}.resolvedProjectId`, options);
  const state = entityMember(item.state, WORK_ITEM_STATES, `${label}.state`, options, undefined, true);
  const phase = item.phase === undefined || item.phase === null
    ? null
    : entityMember(item.phase, WORK_ITEM_PHASES, `${label}.phase`, options, undefined, true);
  const endedAt = nullableTimestamp(item.endedAt, `${label}.endedAt`, options);
  const archivedAt = nullableTimestamp(item.archivedAt, `${label}.archivedAt`, options);
  const cancelledReason = nullableString(item.cancelledReason, `${label}.cancelledReason`);
  if (item.transitions !== undefined) {
    arrayOf(item.transitions, `${label}.transitions`, (entry, entryLabel) =>
      parseWorkItemTransitionEntity(entry, entryLabel, options));
  }
  if (state !== "unrecognized") {
    const terminal = isTerminalWorkItemState(state);
    if (terminal !== (endedAt !== null)) throw new ContractValidationError(`${label}.endedAt does not match its state`);
    if (archivedAt !== null && !terminal) throw new ContractValidationError(`${label}.archivedAt requires a terminal state`);
    if (cancelledReason !== null && state !== "abandoned") {
      throw new ContractValidationError(`${label}.cancelledReason requires an abandoned state`);
    }
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
    taskType,
    projectTarget,
    resolvedProjectId,
    parentWorkItemId: item.parentWorkItemId === undefined
      ? null
      : nullableIdentifier(item.parentWorkItemId, `${label}.parentWorkItemId`, options),
    phase,
    childOrdinal: item.childOrdinal === undefined || item.childOrdinal === null
      ? null
      : integer(item.childOrdinal, `${label}.childOrdinal`),
    planningTaskId: nullableIdentifier(item.planningTaskId, `${label}.planningTaskId`, options),
    ...(item.pipelineBranch === undefined
      ? {}
      : { pipelineBranch: nullableString(item.pipelineBranch, `${label}.pipelineBranch`) }),
    ...(item.baseSha === undefined ? {} : { baseSha: nullableString(item.baseSha, `${label}.baseSha`) }),
    state,
    currentStage: item.currentStage === null
      ? null
      : entityMember(item.currentStage, WORK_ITEM_STAGES, `${label}.currentStage`, options),
    ...(item.stateSince === undefined
      ? {}
      : { stateSince: nullableTimestamp(item.stateSince, `${label}.stateSince`, options) }),
    ...(item.reviewRound === undefined
      ? {}
      : {
          reviewRound: item.reviewRound === null
            ? null
            : integer(item.reviewRound, `${label}.reviewRound`, 1),
        }),
    ...(item.heartbeatAt === undefined
      ? {}
      : { heartbeatAt: nullableTimestamp(item.heartbeatAt, `${label}.heartbeatAt`, options) }),
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

export function parseTaskEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>,
): TolerantTaskEntity;
export function parseTaskEntity(value: unknown, label: string, options?: ShapeParserOptions): BoardTask;
export function parseTaskEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): BoardTask | TolerantTaskEntity {
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
  const status = entityMember(item.status, TASK_STATUSES, `${label}.status`, options, undefined, true);
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
    expectedAgentMinutes: expectedMinutes(item.expectedAgentMinutes, `${label}.expectedAgentMinutes`, {
      nullable: true,
      undefinedIsNull: options.projection === "browser",
      maximum: options.projection === "browser" ? undefined : 10_080,
      message: (field) => options.projection === "browser"
        ? `${field} must use a 15-minute interval`
        : `${field} must be a 15-minute interval between 15 and 10080`,
      scalarMessages: options.scalarMessages,
    }),
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
    "apiVersion", "runId", "claimId", "projectId", "agentId", "wakeupId", "taskId", "status", "startedAt", "heartbeatAt",
    "endedAt", "result", "runtime", "runtimeVersion", "model", "promptsSha",
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
    heartbeatAt: nullableTimestamp(item.heartbeatAt, `${label}.heartbeatAt`, options),
    endedAt: nullableTimestamp(item.endedAt, `${label}.endedAt`, options),
    result: browserProjection ? null : nullableString(item.result, `${label}.result`),
    runtime: nullableString(item.runtime, `${label}.runtime`),
    runtimeVersion: nullableString(item.runtimeVersion, `${label}.runtimeVersion`),
    model: nullableString(item.model, `${label}.model`),
    promptsSha: nullableString(item.promptsSha, `${label}.promptsSha`),
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
    actorType: entityMember(item.actorType, TASK_MESSAGE_ACTOR_TYPES, `${label}.actorType`, options),
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

const PLAN_RECORD_FIELD_NAMES = [
  "changeShape", "tier", "declaredScope", "nonGoals", "mechanicalPortions", "blockingQuestions", "criterionChecks",
] as const;

function boundedPlanArray<T>(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  parse: (entry: unknown, entryLabel: string) => T,
): readonly T[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new ContractValidationError(`${label} is invalid`);
  }
  return Object.freeze(value.map((entry, index) => parse(entry, `${label}[${index}]`)));
}

function planRecordText(value: unknown, label: string, maximum: number): string {
  return prose(value, label, { maximum, message: `${label} is invalid` });
}

function planScopeEntry(value: unknown, label: string, parseText: (value: unknown, label: string, maximum: number) => string): string {
  const entry = parseText(value, label, 256);
  if (entry.startsWith("/") || entry.includes("..")) throw new ContractValidationError(`${label} is invalid`);
  return entry;
}

function planCheck(value: unknown, label: string, parseText: (value: unknown, label: string, maximum: number) => string): string {
  const check = parseText(value, label, 512);
  if (/[\u0000-\u001f\u007f]/u.test(check)) throw new ContractValidationError(`${label} is invalid`);
  return check;
}

const REVIEW_FINDING_DRAFT_FIELDS = ["file", "line", "category", "severity", "expected", "actual"] as const;
const REVIEW_FINDING_DRAFT_REQUIRED_FIELDS = ["category", "severity", "expected", "actual"] as const;

function boundedRecordText(value: unknown, label: string, maximum: number): string {
  return text(value, label, { maximum, trim: false, message: `${label} is invalid` });
}

function reviewFindingFile(value: unknown, label: string): string {
  const parsed = boundedRecordText(value, label, 512);
  if (parsed.startsWith("/") || /[\u0000-\u001f\u007f]/u.test(parsed)) {
    throw new ContractValidationError(`${label} is invalid`);
  }
  return parsed;
}

function ledgerText(
  value: unknown,
  label: string,
  maximum: number,
  options: ShapeParserOptions,
  allowEmpty = false,
): string {
  return prose(value, label, {
    maximum,
    allowEmpty,
    message: `${label} is invalid`,
    scalarMessages: options.scalarMessages,
  });
}

function nullableGitSha(value: unknown, label: string): string | null {
  if (value === null) return null;
  const sha = stringValue(value, label);
  if (sha.length !== 40 || !GIT_OBJECT_ID_PATTERN.test(sha)) {
    throw new ContractValidationError(`${label} is invalid`);
  }
  return sha;
}

export function parseParkRecord(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>,
): TolerantParkRecord;
export function parseParkRecord(
  value: unknown,
  label: string,
  options?: ShapeParserOptions,
): ParkRecord;
export function parseParkRecord(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): ParkRecord | TolerantParkRecord {
  const fields = [
    "parkRecordId", "workItemId", "category", "reason", "parkedAt", "resolvedAt", "resolution",
  ];
  const item = shape(value, label, fields, fields, options);
  const tolerateUnknown = options.projection === "browser" && options.tolerantEnums === true;
  const category = tolerateUnknown
    ? entityMember(item.category, PARK_CATEGORIES, `${label}.category`, options, undefined, true)
    : entityMember(item.category, PARK_CATEGORIES, `${label}.category`, options);
  const resolution = item.resolution === null
    ? null
    : tolerateUnknown
      ? entityMember(item.resolution, PARK_RESOLUTIONS, `${label}.resolution`, options, undefined, true)
      : entityMember(item.resolution, PARK_RESOLUTIONS, `${label}.resolution`, options);
  return Object.freeze({
    parkRecordId: shapeIdentifier(item.parkRecordId, `${label}.parkRecordId`, options),
    workItemId: shapeIdentifier(item.workItemId, `${label}.workItemId`, options),
    category,
    reason: ledgerText(item.reason, `${label}.reason`, 2_000, options),
    parkedAt: entityTimestamp(item.parkedAt, `${label}.parkedAt`, options),
    resolvedAt: nullableTimestamp(item.resolvedAt, `${label}.resolvedAt`, options),
    resolution,
  });
}

export function parseBoardPause(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): BoardPause {
  const fields = ["paused", "reason", "version", "updatedAt", "updatedBy"] as const;
  const item = shape(value, label, fields, fields, options);
  return Object.freeze({
    paused: booleanValue(item.paused, `${label}.paused`),
    reason: nullableString(item.reason, `${label}.reason`),
    version: integer(item.version, `${label}.version`, 1),
    updatedAt: entityTimestamp(item.updatedAt, `${label}.updatedAt`, options),
    updatedBy: shapeIdentifier(item.updatedBy, `${label}.updatedBy`, options),
  });
}

export function parseBoardNotification(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>,
): TolerantBoardNotification;
export function parseBoardNotification(
  value: unknown,
  label: string,
  options?: ShapeParserOptions,
): BoardNotification;
export function parseBoardNotification(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): BoardNotification | TolerantBoardNotification {
  const fields = [
    "notificationId", "sequence", "kind", "dedupeKey", "projectId", "workItemId",
    "summary", "createdAt", "readAt", "version",
  ];
  const item = shape(value, label, fields, fields, options);
  const tolerateUnknown = options.projection === "browser" && options.tolerantEnums === true;
  const kind = tolerateUnknown
    ? entityMember(item.kind, NOTIFICATION_KINDS, `${label}.kind`, options, undefined, true)
    : entityMember(item.kind, NOTIFICATION_KINDS, `${label}.kind`, options);
  return Object.freeze({
    notificationId: shapeIdentifier(item.notificationId, `${label}.notificationId`, options),
    sequence: integer(item.sequence, `${label}.sequence`, 1),
    kind,
    dedupeKey: nullableString(item.dedupeKey, `${label}.dedupeKey`),
    projectId: nullableIdentifier(item.projectId, `${label}.projectId`, options),
    workItemId: nullableIdentifier(item.workItemId, `${label}.workItemId`, options),
    summary: ledgerText(item.summary, `${label}.summary`, 500, options),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    readAt: nullableTimestamp(item.readAt, `${label}.readAt`, options),
    version: integer(item.version, `${label}.version`, 1),
  });
}

export function parseGateAction(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>,
): TolerantGateAction;
export function parseGateAction(
  value: unknown,
  label: string,
  options?: ShapeParserOptions,
): GateAction;
export function parseGateAction(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): GateAction | TolerantGateAction {
  const fields = [
    "gateActionId", "workItemId", "gate", "actorId", "planRevisionId", "verifiedSha",
    "mergeSha", "refId", "note", "createdAt",
  ];
  const item = shape(value, label, fields, fields, options);
  const tolerateUnknown = options.projection === "browser" && options.tolerantEnums === true;
  const gate = tolerateUnknown
    ? entityMember(item.gate, GATE_KINDS, `${label}.gate`, options, undefined, true)
    : entityMember(item.gate, GATE_KINDS, `${label}.gate`, options);
  return Object.freeze({
    gateActionId: shapeIdentifier(item.gateActionId, `${label}.gateActionId`, options),
    workItemId: shapeIdentifier(item.workItemId, `${label}.workItemId`, options),
    gate,
    actorId: shapeIdentifier(item.actorId, `${label}.actorId`, options),
    planRevisionId: nullableIdentifier(item.planRevisionId, `${label}.planRevisionId`, options),
    verifiedSha: nullableGitSha(item.verifiedSha, `${label}.verifiedSha`),
    mergeSha: nullableGitSha(item.mergeSha, `${label}.mergeSha`),
    refId: nullableIdentifier(item.refId, `${label}.refId`, options),
    note: item.note === null ? null : ledgerText(item.note, `${label}.note`, 2_000, options, true),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
  });
}

export function parseWorkItemAudit(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>,
): TolerantWorkItemAudit;
export function parseWorkItemAudit(
  value: unknown,
  label: string,
  options?: ShapeParserOptions,
): WorkItemAudit;
export function parseWorkItemAudit(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): WorkItemAudit | TolerantWorkItemAudit {
  const fields = ["gateActions", "transitions"];
  const item = shape(value, label, fields, fields, options);
  const gateActions = arrayOf(item.gateActions, `${label}.gateActions`, (entry, entryLabel) =>
    parseGateAction(entry, entryLabel, options));
  const transitions = arrayOf(item.transitions, `${label}.transitions`, (entry, entryLabel) =>
    parseWorkItemTransitionEntity(entry, entryLabel, options));
  return Object.freeze({
    gateActions: Object.freeze(gateActions),
    transitions: Object.freeze(transitions),
  });
}

function reviewFindingDraftFields(
  item: JsonRecord,
  label: string,
  options: ShapeParserOptions,
  tolerateUnknown: boolean,
  textMaximum = 2_000,
): ReviewFindingDraft | Omit<TolerantReviewFindingEntity, "findingId" | "nodeId" | "stage" | "round" | "blocking" | "createdAt"> {
  const category = tolerateUnknown
    ? entityMember(item.category, REVIEW_FINDING_CATEGORIES, `${label}.category`, options, undefined, true)
    : entityMember(item.category, REVIEW_FINDING_CATEGORIES, `${label}.category`, options);
  const severity = tolerateUnknown
    ? entityMember(item.severity, REVIEW_FINDING_SEVERITIES, `${label}.severity`, options, undefined, true)
    : entityMember(item.severity, REVIEW_FINDING_SEVERITIES, `${label}.severity`, options);
  return Object.freeze({
    ...(item.file === undefined ? {} : {
      file: item.file === null ? null : reviewFindingFile(item.file, `${label}.file`),
    }),
    ...(item.line === undefined ? {} : {
      line: item.line === null ? null : integer(item.line, `${label}.line`, 1),
    }),
    category,
    severity,
    expected: boundedRecordText(item.expected, `${label}.expected`, textMaximum),
    actual: boundedRecordText(item.actual, `${label}.actual`, textMaximum),
  });
}

export function parseReviewFindingDraft(value: unknown): ReviewFindingDraft {
  const item = exact(value, REVIEW_FINDING_DRAFT_FIELDS, "review finding", {
    required: REVIEW_FINDING_DRAFT_REQUIRED_FIELDS,
  });
  return reviewFindingDraftFields(
    item,
    "review finding",
    {},
    false,
    REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH,
  ) as ReviewFindingDraft;
}

function parseReviewFindingDraftList(value: unknown, label: string): readonly ReviewFindingDraft[] {
  if (!Array.isArray(value) || value.length > REVIEW_FINDING_DRAFT_MAX_ITEMS) {
    throw new ContractValidationError(
      `${label} must be an array with at most ${REVIEW_FINDING_DRAFT_MAX_ITEMS} entries`,
    );
  }
  return Object.freeze(value.map((entry) => parseReviewFindingDraft(entry)));
}

export function parseReviewFindingEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>,
): TolerantReviewFindingEntity;
export function parseReviewFindingEntity(
  value: unknown,
  label: string,
  options?: ShapeParserOptions,
): ReviewFinding;
export function parseReviewFindingEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): ReviewFinding | TolerantReviewFindingEntity {
  const required = [
    "findingId", "nodeId", "stage", "round", ...REVIEW_FINDING_DRAFT_REQUIRED_FIELDS, "blocking", "createdAt",
  ];
  const item = shape(value, label, [
    "findingId", "nodeId", "stage", "round", ...REVIEW_FINDING_DRAFT_FIELDS, "blocking", "createdAt",
  ], required, options);
  const tolerateUnknown = options.projection === "browser" && options.tolerantEnums === true;
  const stage = tolerateUnknown
    ? entityMember(item.stage, WORKFLOW_STAGES, `${label}.stage`, options, undefined, true)
    : entityMember(item.stage, WORKFLOW_STAGES, `${label}.stage`, options);
  return Object.freeze({
    findingId: shapeIdentifier(item.findingId, `${label}.findingId`, options),
    nodeId: shapeIdentifier(item.nodeId, `${label}.nodeId`, options),
    stage,
    round: integer(item.round, `${label}.round`, 1),
    ...reviewFindingDraftFields(item, label, options, tolerateUnknown),
    blocking: booleanValue(item.blocking, `${label}.blocking`),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
  });
}

type ParsedLedgerFinding = (ReviewFinding | TolerantReviewFindingEntity) & Readonly<{ workItemId: string }>;
type ParsedLedgerPark = (ParkRecord | TolerantParkRecord) & Readonly<{ workItemTitle: string }>;

function boundedLedgerArray<T>(
  value: unknown,
  label: string,
  maximum: number | null,
  parser: (entry: unknown, entryLabel: string) => T,
): readonly T[] {
  if (!Array.isArray(value) || (maximum !== null && value.length > maximum)) {
    const bound = maximum === null ? "an array" : `an array with at most ${maximum} entries`;
    throw new ContractValidationError(`${label} must be ${bound}`);
  }
  return Object.freeze(value.map((entry, index) => parser(entry, `${label}[${index}]`)));
}

function parseLedgerFinding(
  value: unknown,
  label: string,
  options: ShapeParserOptions,
): ParsedLedgerFinding {
  const fields = [
    "findingId", "nodeId", "stage", "round", ...REVIEW_FINDING_DRAFT_FIELDS,
    "blocking", "createdAt", "workItemId",
  ];
  const required = [
    "findingId", "nodeId", "stage", "round", ...REVIEW_FINDING_DRAFT_REQUIRED_FIELDS,
    "blocking", "createdAt", "workItemId",
  ];
  const item = shape(value, label, fields, required, options);
  const finding = parseReviewFindingEntity({
    findingId: item.findingId,
    nodeId: item.nodeId,
    stage: item.stage,
    round: item.round,
    ...(item.file === undefined ? {} : { file: item.file }),
    ...(item.line === undefined ? {} : { line: item.line }),
    category: item.category,
    severity: item.severity,
    expected: item.expected,
    actual: item.actual,
    blocking: item.blocking,
    createdAt: item.createdAt,
  }, label, options) as ReviewFinding | TolerantReviewFindingEntity;
  return Object.freeze({
    ...finding,
    workItemId: shapeIdentifier(item.workItemId, `${label}.workItemId`, options),
  });
}

function parseLedgerPark(
  value: unknown,
  label: string,
  options: ShapeParserOptions,
  expectedState: "open" | "resolved",
): ParsedLedgerPark {
  const fields = [
    "parkRecordId", "workItemId", "category", "reason", "parkedAt", "resolvedAt", "resolution", "workItemTitle",
  ];
  const item = shape(value, label, fields, fields, options);
  const park = parseParkRecord({
    parkRecordId: item.parkRecordId,
    workItemId: item.workItemId,
    category: item.category,
    reason: item.reason,
    parkedAt: item.parkedAt,
    resolvedAt: item.resolvedAt,
    resolution: item.resolution,
  }, label, options) as ParkRecord | TolerantParkRecord;
  if (expectedState === "open" && (park.resolvedAt !== null || park.resolution !== null)) {
    throw new ContractValidationError(`${label} must be an open park record`);
  }
  if (expectedState === "resolved" && (park.resolvedAt === null || park.resolution === null)) {
    throw new ContractValidationError(`${label} must be a resolved park record`);
  }
  const workItemTitle = boundedRecordText(item.workItemTitle, `${label}.workItemTitle`, 220);
  return Object.freeze({ ...park, workItemTitle });
}

function ledgerRecordsSince(value: unknown, label: string): string {
  const parsed = stringValue(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(parsed)) throw new ContractValidationError(`${label} is invalid`);
  const date = new Date(`${parsed}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== parsed) {
    throw new ContractValidationError(`${label} is invalid`);
  }
  return parsed;
}

export function parseFindingsLedger(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>,
): TolerantFindingsLedger;
export function parseFindingsLedger(
  value: unknown,
  label: string,
  options?: ShapeParserOptions,
): FindingsLedger;
export function parseFindingsLedger(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): FindingsLedger | TolerantFindingsLedger {
  const fields = ["categories", "perProject", "recent"];
  const item = shape(value, label, fields, fields, options);
  const tolerateUnknown = options.projection === "browser" && options.tolerantEnums === true;
  const categories = boundedLedgerArray(item.categories, `${label}.categories`, null, (entry, entryLabel) => {
    const aggregate = shape(entry, entryLabel, ["category", "severity", "blocking", "count"], [
      "category", "severity", "blocking", "count",
    ], options);
    return Object.freeze({
      category: tolerateUnknown
        ? entityMember(aggregate.category, REVIEW_FINDING_CATEGORIES, `${entryLabel}.category`, options, undefined, true)
        : entityMember(aggregate.category, REVIEW_FINDING_CATEGORIES, `${entryLabel}.category`, options),
      severity: tolerateUnknown
        ? entityMember(aggregate.severity, REVIEW_FINDING_SEVERITIES, `${entryLabel}.severity`, options, undefined, true)
        : entityMember(aggregate.severity, REVIEW_FINDING_SEVERITIES, `${entryLabel}.severity`, options),
      blocking: booleanValue(aggregate.blocking, `${entryLabel}.blocking`),
      count: integer(aggregate.count, `${entryLabel}.count`, 1),
    });
  });
  const perProject = boundedLedgerArray(item.perProject, `${label}.perProject`, null, (entry, entryLabel) => {
    const aggregate = shape(entry, entryLabel, ["projectId", "category", "count"], [
      "projectId", "category", "count",
    ], options);
    return Object.freeze({
      projectId: shapeIdentifier(aggregate.projectId, `${entryLabel}.projectId`, options),
      category: tolerateUnknown
        ? entityMember(aggregate.category, REVIEW_FINDING_CATEGORIES, `${entryLabel}.category`, options, undefined, true)
        : entityMember(aggregate.category, REVIEW_FINDING_CATEGORIES, `${entryLabel}.category`, options),
      count: integer(aggregate.count, `${entryLabel}.count`, 1),
    });
  });
  const recent = boundedLedgerArray(item.recent, `${label}.recent`, 50, (entry, entryLabel) =>
    parseLedgerFinding(entry, entryLabel, options));
  return Object.freeze({ categories, perProject, recent }) as FindingsLedger | TolerantFindingsLedger;
}

export function parseParksLedger(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>,
): TolerantParksLedger;
export function parseParksLedger(
  value: unknown,
  label: string,
  options?: ShapeParserOptions,
): ParksLedger;
export function parseParksLedger(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): ParksLedger | TolerantParksLedger {
  const fields = ["open", "resolved", "recordsSince"];
  const item = shape(value, label, fields, fields, options);
  const open = boundedLedgerArray(item.open, `${label}.open`, null, (entry, entryLabel) =>
    parseLedgerPark(entry, entryLabel, options, "open"));
  const resolved = boundedLedgerArray(item.resolved, `${label}.resolved`, 100, (entry, entryLabel) =>
    parseLedgerPark(entry, entryLabel, options, "resolved"));
  return Object.freeze({
    open,
    resolved,
    recordsSince: ledgerRecordsSince(item.recordsSince, `${label}.recordsSince`),
  }) as ParksLedger | TolerantParksLedger;
}

const DESIGN_RECORD_FIELDS = [
  "states", "transitions", "failurePoints", "idempotencyKeys", "faultInjectionCases",
] as const;

function parseDesignRecordFields(
  item: JsonRecord,
  label: string,
  options: ShapeParserOptions,
  tolerateUnknown: boolean,
): Omit<TolerantDesignRecordEntity, "designRecordId" | "workItemId" | "planRevisionId" | "createdAt"> {
  const states = boundedPlanArray(item.states, `${label}.states`, 1, DESIGN_RECORD_MAX_STATES,
    (entry, entryLabel) => boundedRecordText(entry, entryLabel, DESIGN_RECORD_LABEL_MAX_LENGTH));
  const transitions = boundedPlanArray(item.transitions, `${label}.transitions`, 1, DESIGN_RECORD_MAX_TRANSITIONS, (entry, entryLabel) => {
    const transition = shape(
      entry,
      entryLabel,
      ["from", "to", "durablePrecondition", "recovery"],
      ["from", "to"],
      options,
    );
    return Object.freeze({
      from: boundedRecordText(transition.from, `${entryLabel}.from`, DESIGN_RECORD_LABEL_MAX_LENGTH),
      to: boundedRecordText(transition.to, `${entryLabel}.to`, DESIGN_RECORD_LABEL_MAX_LENGTH),
      ...(transition.durablePrecondition === undefined ? {} : {
        durablePrecondition: boundedRecordText(
          transition.durablePrecondition,
          `${entryLabel}.durablePrecondition`,
          DESIGN_RECORD_DETAIL_MAX_LENGTH,
        ),
      }),
      ...(transition.recovery === undefined ? {} : {
        recovery: boundedRecordText(transition.recovery, `${entryLabel}.recovery`, DESIGN_RECORD_DETAIL_MAX_LENGTH),
      }),
    });
  });
  const failurePoints = boundedPlanArray(
    item.failurePoints,
    `${label}.failurePoints`,
    tolerateUnknown ? DESIGN_FAILURE_POINTS.length : 0,
    DESIGN_RECORD_MAX_FAILURE_POINTS,
    (entry, entryLabel) => {
      const failurePoint = shape(
        entry,
        entryLabel,
        ["point", "resultingState", "recovery"],
        ["point", "resultingState", "recovery"],
        options,
      );
      const point = tolerateUnknown
        ? entityMember(failurePoint.point, DESIGN_FAILURE_POINTS, `${entryLabel}.point`, options, undefined, true)
        : entityMember(failurePoint.point, DESIGN_FAILURE_POINTS, `${entryLabel}.point`, options);
      return Object.freeze({
        point,
        resultingState: boundedRecordText(
          failurePoint.resultingState,
          `${entryLabel}.resultingState`,
          DESIGN_RECORD_DETAIL_MAX_LENGTH,
        ),
        recovery: boundedRecordText(failurePoint.recovery, `${entryLabel}.recovery`, DESIGN_RECORD_DETAIL_MAX_LENGTH),
      });
    },
  );
  if (!tolerateUnknown) {
    for (const point of DESIGN_FAILURE_POINTS) {
      if (!failurePoints.some((failurePoint) => failurePoint.point === point)) {
        throw new ContractValidationError(`design record missing failure point: ${point}`);
      }
    }
  }
  const idempotencyKeys = boundedPlanArray(
    item.idempotencyKeys,
    `${label}.idempotencyKeys`,
    0,
    DESIGN_RECORD_MAX_IDEMPOTENCY_KEYS,
    (entry, entryLabel) => {
      const key = shape(
        entry,
        entryLabel,
        ["name", "generatedAt", "persistedAt", "reuse"],
        ["name", "generatedAt", "persistedAt", "reuse"],
        options,
      );
      return Object.freeze({
        name: boundedRecordText(key.name, `${entryLabel}.name`, DESIGN_RECORD_LABEL_MAX_LENGTH),
        generatedAt: boundedRecordText(key.generatedAt, `${entryLabel}.generatedAt`, DESIGN_RECORD_DETAIL_MAX_LENGTH),
        persistedAt: boundedRecordText(key.persistedAt, `${entryLabel}.persistedAt`, DESIGN_RECORD_DETAIL_MAX_LENGTH),
        reuse: boundedRecordText(key.reuse, `${entryLabel}.reuse`, DESIGN_RECORD_DETAIL_MAX_LENGTH),
      });
    },
  );
  const faultInjectionCases = boundedPlanArray(
    item.faultInjectionCases,
    `${label}.faultInjectionCases`,
    0,
    DESIGN_RECORD_MAX_FAULT_INJECTION_CASES,
    (entry, entryLabel) => {
      const faultCase = shape(
        entry,
        entryLabel,
        ["name", "scenario", "expectation"],
        ["name", "scenario", "expectation"],
        options,
      );
      return Object.freeze({
        name: boundedRecordText(faultCase.name, `${entryLabel}.name`, DESIGN_RECORD_LABEL_MAX_LENGTH),
        scenario: boundedRecordText(faultCase.scenario, `${entryLabel}.scenario`, DESIGN_RECORD_DETAIL_MAX_LENGTH),
        expectation: boundedRecordText(faultCase.expectation, `${entryLabel}.expectation`, DESIGN_RECORD_DETAIL_MAX_LENGTH),
      });
    },
  );
  return Object.freeze({ states, transitions, failurePoints, idempotencyKeys, faultInjectionCases });
}

export function parseDesignRecordDraft(value: unknown): DesignRecordDraft {
  const item = exact(value, DESIGN_RECORD_FIELDS, "design record");
  return parseDesignRecordFields(item, "design record", {}, false) as DesignRecordDraft;
}

export function parseDesignRecordEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>,
): TolerantDesignRecordEntity;
export function parseDesignRecordEntity(
  value: unknown,
  label: string,
  options?: ShapeParserOptions,
): DesignRecord;
export function parseDesignRecordEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): DesignRecord | TolerantDesignRecordEntity {
  const fields = ["designRecordId", "workItemId", "planRevisionId", "createdAt", ...DESIGN_RECORD_FIELDS];
  const item = shape(value, label, fields, fields, options);
  const tolerateUnknown = options.projection === "browser" && options.tolerantEnums === true;
  return Object.freeze({
    designRecordId: shapeIdentifier(item.designRecordId, `${label}.designRecordId`, options),
    workItemId: shapeIdentifier(item.workItemId, `${label}.workItemId`, options),
    planRevisionId: shapeIdentifier(item.planRevisionId, `${label}.planRevisionId`, options),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    ...parseDesignRecordFields(item, label, options, tolerateUnknown),
  });
}

function parsePlanRecordEntity(
  item: JsonRecord,
  label: string,
  options: ShapeParserOptions,
): PlanRecordFields {
  return Object.freeze({
    ...(item.changeShape === undefined ? {} : {
      changeShape: entityMember(item.changeShape, PLAN_CHANGE_SHAPES, `${label}.changeShape`, options),
    }),
    ...(item.tier === undefined ? {} : {
      tier: entityMember(item.tier, PLAN_TIERS, `${label}.tier`, options),
    }),
    ...(item.declaredScope === undefined ? {} : {
      declaredScope: boundedPlanArray(item.declaredScope, `${label}.declaredScope`, 1, 64,
        (entry, entryLabel) => planScopeEntry(entry, entryLabel, planRecordText)),
    }),
    ...(item.nonGoals === undefined ? {} : {
      nonGoals: boundedPlanArray(item.nonGoals, `${label}.nonGoals`, 0, 32,
        (entry, entryLabel) => planRecordText(entry, entryLabel, 1_000)),
    }),
    ...(item.mechanicalPortions === undefined ? {} : {
      mechanicalPortions: boundedPlanArray(item.mechanicalPortions, `${label}.mechanicalPortions`, 0, 32,
        (entry, entryLabel) => planRecordText(entry, entryLabel, 1_000)),
    }),
    ...(item.blockingQuestions === undefined ? {} : {
      blockingQuestions: boundedPlanArray(item.blockingQuestions, `${label}.blockingQuestions`, 0, 16,
        (entry, entryLabel) => {
          const question = shape(entry, entryLabel, ["question", "recommendedDefault"], ["question", "recommendedDefault"], options);
          return Object.freeze({
            question: planRecordText(question.question, `${entryLabel}.question`, 1_000),
            recommendedDefault: planRecordText(question.recommendedDefault, `${entryLabel}.recommendedDefault`, 1_000),
          });
        }),
    }),
    ...(item.criterionChecks === undefined ? {} : {
      criterionChecks: boundedPlanArray(item.criterionChecks, `${label}.criterionChecks`, 0, 32,
        (entry, entryLabel) => {
          const criterion = shape(entry, entryLabel, ["criterion", "check"], ["criterion", "check"], options);
          return Object.freeze({
            criterion: planRecordText(criterion.criterion, `${entryLabel}.criterion`, 1_000),
            check: planCheck(criterion.check, `${entryLabel}.check`, planRecordText),
          });
        }),
    }),
  });
}

function parseDeclaredChildEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions,
): TolerantDeclaredChild {
  const required = ["key", "objective", "projectId", "declaredScope", "acceptanceCriteria"];
  const item = shape(
    value,
    label,
    [...required, "phase", "dependsOn", "splitBy"],
    required,
    options,
  );
  return Object.freeze({
    key: shapeIdentifier(item.key, `${label}.key`, options),
    objective: planRecordText(item.objective, `${label}.objective`, 4_000),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    declaredScope: boundedPlanArray(item.declaredScope, `${label}.declaredScope`, 1, 64,
      (entry, entryLabel) => planScopeEntry(entry, entryLabel, planRecordText)),
    acceptanceCriteria: boundedPlanArray(item.acceptanceCriteria, `${label}.acceptanceCriteria`, 1, 64,
      (entry, entryLabel) => planRecordText(entry, entryLabel, 2_000)),
    ...(item.phase === undefined ? {} : {
      phase: entityMember(item.phase, WORK_ITEM_PHASES, `${label}.phase`, options, undefined, true),
    }),
    ...(item.dependsOn === undefined ? {} : {
      dependsOn: boundedPlanArray(item.dependsOn, `${label}.dependsOn`, 0, 64,
        (entry, entryLabel) => shapeIdentifier(entry, entryLabel, options)),
    }),
    ...(item.splitBy === undefined ? {} : {
      splitBy: entityMember(item.splitBy, ["consumer", "phase"] as const, `${label}.splitBy`, options),
    }),
  });
}

export function parsePlanEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>,
): TolerantPlanRevision;
export function parsePlanEntity(value: unknown, label: string, options?: ShapeParserOptions): PlanRevision;
export function parsePlanEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): PlanRevision | TolerantPlanRevision {
  const coreRequired = [
    "apiVersion", "planRevisionId", "workItemId", "revision", "objective", "assumptions", "acceptanceCriteria", "projectId",
    "skillDigests", "state", "createdBy", "confirmedBy", "createdAt", "confirmedAt",
  ];
  const required = [...coreRequired, ...(options.projection === "browser" ? [] : ["children"])];
  const fields = [...coreRequired, ...PLAN_RECORD_FIELD_NAMES, "children", "rejectedNote"];
  const item = entity(value, label, fields, required, options);
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
    ...parsePlanRecordEntity(item, label, options),
    children: item.children === undefined || item.children === null
      ? null
      : boundedPlanArray(item.children, `${label}.children`, 0, 64,
        (entry, entryLabel) => parseDeclaredChildEntity(entry, entryLabel, options)),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    skillDigests: Object.freeze(skillDigests),
    state: entityMember(item.state, PLAN_REVISION_STATES, `${label}.state`, options),
    createdBy: shapeIdentifier(item.createdBy, `${label}.createdBy`, options),
    confirmedBy: nullableIdentifier(item.confirmedBy, `${label}.confirmedBy`, options),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    confirmedAt: nullableTimestamp(item.confirmedAt, `${label}.confirmedAt`, options),
    ...(item.rejectedNote === undefined ? {} : { rejectedNote: stringValue(item.rejectedNote, `${label}.rejectedNote`) }),
  });
}

const VERIFY_ATTEMPT_STATES = ["starting", "running", "green", "failed", "died", "failed_to_start", "retired"] as const;
function parseVerifyAttemptEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): VerifyAttempt {
  const fields = [
    "verifyAttemptId", "nodeId", "stage", "attempt", "verifyRunId", "workspacePath", "state",
    "checkResults", "detail", "createdAt", "endedAt",
  ];
  const item = shape(value, label, fields, fields, options);
  let checkResults: VerifyAttempt["checkResults"] = null;
  if (item.checkResults !== null) {
    if (!Array.isArray(item.checkResults) || item.checkResults.length > 32) {
      throw new ContractValidationError(`${label}.checkResults is invalid`);
    }
    checkResults = Object.freeze(item.checkResults.map((entry, index) => {
      const resultLabel = `${label}.checkResults[${index}]`;
      const result = shape(entry, resultLabel, ["criterion", "check", "passed"], ["criterion", "check", "passed"], options);
      return Object.freeze({
        criterion: stringValue(result.criterion, `${resultLabel}.criterion`),
        check: stringValue(result.check, `${resultLabel}.check`),
        passed: booleanValue(result.passed, `${resultLabel}.passed`),
      });
    }));
  }
  return Object.freeze({
    verifyAttemptId: shapeIdentifier(item.verifyAttemptId, `${label}.verifyAttemptId`, options),
    nodeId: shapeIdentifier(item.nodeId, `${label}.nodeId`, options),
    stage: entityMember(item.stage, WORKFLOW_STAGES, `${label}.stage`, options),
    attempt: integer(item.attempt, `${label}.attempt`, 1),
    verifyRunId: nullableIdentifier(item.verifyRunId, `${label}.verifyRunId`, options),
    workspacePath: nullableString(item.workspacePath, `${label}.workspacePath`),
    state: entityMember(item.state, VERIFY_ATTEMPT_STATES, `${label}.state`, options),
    checkResults,
    detail: nullableString(item.detail, `${label}.detail`),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    endedAt: nullableTimestamp(item.endedAt, `${label}.endedAt`, options),
  });
}

export function parsePipelineSummaryEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {},
): PipelineSummary {
  const fields = [
    "commits", "diffstat", "filesTouched", "declaredScope", "scopeOk", "assumptions",
    "midRunAssumptions", "verify", "criteria", "criterionChecks", "findings", "designRecord",
  ];
  const item = shape(value, label, fields, fields, options);
  const commits = boundedPlanArray(item.commits, `${label}.commits`, 0, 1_000, (entry, entryLabel) => {
    const commit = shape(entry, entryLabel, ["sha", "subject"], ["sha", "subject"], options);
    const sha = stringValue(commit.sha, `${entryLabel}.sha`);
    if (!GIT_OBJECT_ID_PATTERN.test(sha)) throw new ContractValidationError(`${entryLabel}.sha is invalid`);
    return Object.freeze({ sha, subject: stringValue(commit.subject, `${entryLabel}.subject`) });
  });
  const stringList = (field: unknown, fieldLabel: string, maximum: number): readonly string[] =>
    boundedPlanArray(field, fieldLabel, 0, maximum, (entry, entryLabel) => stringValue(entry, entryLabel));
  const criterionChecks = boundedPlanArray(
    item.criterionChecks,
    `${label}.criterionChecks`,
    0,
    32,
    (entry, entryLabel) => {
      const check = shape(entry, entryLabel, ["criterion", "check"], ["criterion", "check"], options);
      return Object.freeze({
        criterion: stringValue(check.criterion, `${entryLabel}.criterion`),
        check: stringValue(check.check, `${entryLabel}.check`),
      });
    },
  );
  const tolerateUnknown = options.projection === "browser" && options.tolerantEnums === true;
  const findings = Object.freeze(boundedPlanArray(
    item.findings,
    `${label}.findings`,
    0,
    10_000,
    (entry, entryLabel) => parseReviewFindingEntity(entry, entryLabel, options) as ReviewFinding,
  ));
  let designRecord: DesignRecordDraft | null = null;
  if (item.designRecord !== null) {
    const designItem = shape(
      item.designRecord,
      `${label}.designRecord`,
      DESIGN_RECORD_FIELDS,
      DESIGN_RECORD_FIELDS,
      options,
    );
    designRecord = parseDesignRecordFields(
      designItem,
      `${label}.designRecord`,
      options,
      tolerateUnknown,
    ) as DesignRecordDraft;
  }
  return Object.freeze({
    commits,
    diffstat: stringValue(item.diffstat, `${label}.diffstat`),
    filesTouched: stringList(item.filesTouched, `${label}.filesTouched`, 10_000),
    declaredScope: stringList(item.declaredScope, `${label}.declaredScope`, 64),
    scopeOk: booleanValue(item.scopeOk, `${label}.scopeOk`),
    assumptions: stringList(item.assumptions, `${label}.assumptions`, 64),
    midRunAssumptions: stringList(item.midRunAssumptions, `${label}.midRunAssumptions`, 256),
    verify: boundedPlanArray(item.verify, `${label}.verify`, 0, 256,
      (entry, entryLabel) => parseVerifyAttemptEntity(entry, entryLabel, options)),
    criteria: stringList(item.criteria, `${label}.criteria`, 64),
    criterionChecks,
    findings,
    designRecord,
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
  if (kind === "machine_verify" || kind === "human" || kind === "disabled") {
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
    if (entry.executor.kind === "machine_verify" && entry.stage !== "testing") {
      throw new ContractValidationError(`${label}.stages ${entry.stage} cannot use the machine_verify executor`);
    }
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
    "recentEvents",
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
  });
}

export function parseClaimRunResult(value: unknown): ClaimRunResult {
  const envelope = exact(value, ["apiVersion", "run", "wakeup", "task", "context"], "Claim result");
  if (envelope.apiVersion !== TASK_BOARD_API_VERSION) throw new ContractValidationError("Claim result API version is invalid");
  const run = exact(envelope.run, [
    "apiVersion", "runId", "claimId", "projectId", "agentId", "wakeupId", "taskId", "status", "startedAt", "heartbeatAt",
    "endedAt", "result", "runtime", "runtimeVersion", "model", "promptsSha",
  ], "Claim run");
  const wakeup = exact(envelope.wakeup, [
    "apiVersion", "wakeupId", "projectId", "agentId", "reason", "taskId", "questionId", "detail", "createdBy",
    "createdAt", "claimedAt", "runId",
  ], "Claim wakeup");
  const context = exact(envelope.context, [
    "intake", "onboarding", "design", "agent", "projectMemory", "areaMemory", "parentTask", "parentMessages", "acceptanceCriteria", "workspaceRefs",
    "phase", "crossRepoContext", "messageCursor", "messages", "triggerQuestion", "openQuestions", "workflow",
  ], "Claim context", {
    required: [
      "intake", "design", "agent", "projectMemory", "areaMemory", "parentTask", "parentMessages", "acceptanceCriteria", "workspaceRefs",
      "messageCursor", "messages", "triggerQuestion", "openQuestions", "workflow",
    ],
  });
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
  if (run.heartbeatAt !== null) timestamp(run.heartbeatAt, "run.heartbeatAt", "run.heartbeatAt is invalid", true);
  for (const field of ["runtime", "runtimeVersion", "model", "promptsSha"] as const) {
    if (run[field] !== null) stringValue(run[field], `run.${field}`);
  }
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
  if (context.workflow !== null) {
    const workflow = exact(
      context.workflow,
      ["planRevisionId", "nodeId", "stage", "skills", "dependencyHandoffs", "workspaceKey", "pipeline", "review", "fix"],
      "Workflow context",
      { required: ["planRevisionId", "nodeId", "stage", "skills", "dependencyHandoffs"] },
    );
    const pipelineFields = parseWorkflowPipelineFields(workflow, "Workflow context");
    if (pipelineFields.fix !== null && workflow.stage !== "implementation") {
      throw new ContractValidationError("Workflow context.fix is only valid during implementation");
    }
  }
  if (context.crossRepoContext !== undefined) {
    parseCrossRepoContext(context.crossRepoContext, "context.crossRepoContext");
  }
  if (context.phase !== undefined && context.phase !== null) {
    contractMember(context.phase, WORK_ITEM_PHASES, "context.phase");
  }
  integer(context.messageCursor, "context.messageCursor", 0, "context.messageCursor is invalid");
  booleanValue(context.intake, "context.intake");
  if (context.onboarding !== undefined && context.onboarding !== true) {
    throw new ContractValidationError("context.onboarding must be true when present");
  }
  booleanValue(context.design, "context.design");
  return value as ClaimRunResult;
}

export function parseClaimRunPausedResult(value: unknown): ClaimRunPausedResult {
  const envelope = exact(value, ["paused"], "Paused claim result");
  if (envelope.paused !== true) throw new ContractValidationError("Paused claim result is invalid");
  return Object.freeze({ paused: true });
}

export type { StageHandoffDraft, WorkflowPlanDraft };

interface ValidatedTaskWakeClaim {
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

interface ValidatedAgentTaskPhase {
  readonly phaseId: string;
  readonly title: string;
  readonly stage: TaskPhaseStage;
  readonly status: TaskPhaseStatus;
  readonly parallelGroup: string | null;
  readonly orderKey: number;
  readonly version: number;
}

interface ValidatedAgentTaskPhaseUpdate extends Omit<ValidatedAgentTaskPhase, "phaseId" | "version"> {
  readonly phaseId: string | null;
}

interface ValidatedAgentContext {
  readonly apiVersion: 1;
  readonly projectId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly intake: boolean;
  readonly onboarding?: true;
  readonly design: boolean;
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
  readonly phase: WorkItemPhase | null;
  readonly crossRepoContext?: CrossRepoContext;
  readonly workflow: Readonly<{
    planRevisionId: string;
    nodeId: string;
    stage: WorkflowStage;
    skills: readonly SkillSnapshot[];
    dependencyHandoffs: readonly StageHandoff[];
    workspaceKey: string | null;
    pipeline: WorkflowPipelineContext | null;
    review: WorkflowReviewContext | null;
    fix: WorkflowFixContext | null;
  }> | null;
}

type ValidatedAgentRunOutput =
  | Readonly<{ type: "progress"; body: string }>
  | Readonly<{ type: "proposed_child_task"; title: string; objective: string; acceptanceCriteria: readonly string[] }>
  | Readonly<{ type: "result"; body: string }>
  | Readonly<{ type: "human_question"; question: string }>;

interface ValidatedAgentRunOutcome {
  readonly status: "completed" | "failed" | "interrupted" | "waiting_for_human";
  readonly outputs: readonly ValidatedAgentRunOutput[];
  readonly expectedAgentMinutes: number | null;
  readonly phases: readonly ValidatedAgentTaskPhaseUpdate[];
  readonly detail: string;
  readonly gapReport?: string;
  readonly handoff: StageHandoffDraft | null;
  readonly workflowPlan: WorkflowPlanDraft | null;
  readonly reviewFindings?: readonly ReviewFindingDraft[];
  readonly designRecord?: DesignRecordDraft;
}

const MAX_PUBLISHED_INTERFACE_BYTES = 64 * 1_024;
// Design claims may carry their large approved-plan objective, while later
// pipeline claims add the bounded record to an otherwise full context.
const MAX_OUTCOME_BYTES = 64 * 1_024;
const MAX_AREA_MEMORY_ITEMS = 8;

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export interface WorkerAgentContextUsage {
  readonly bytes: number;
  readonly budget: number;
}

export class WorkerAgentContextBudgetError extends ContractValidationError {
  constructor(readonly usage: WorkerAgentContextUsage, publishedInterface: boolean) {
    super(
      "Agent context exceeds its byte bound",
      publishedInterface ? "PUBLISHED_INTERFACE_OVER_BUDGET" : "INVALID_REQUEST",
    );
    this.name = "WorkerAgentContextBudgetError";
  }
}

export function workerAgentContextUsage(value: unknown): WorkerAgentContextUsage {
  const rawContext = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
  const rawWorkflow = rawContext.workflow;
  const rawPipeline = rawWorkflow !== null && typeof rawWorkflow === "object" && !Array.isArray(rawWorkflow)
    ? (rawWorkflow as JsonRecord).pipeline
    : null;
  const carriesDesignRecord = rawPipeline !== null && typeof rawPipeline === "object" && !Array.isArray(rawPipeline) &&
    (rawPipeline as JsonRecord).designRecord !== null && (rawPipeline as JsonRecord).designRecord !== undefined;
  return Object.freeze({
    bytes: byteLength(value),
    budget: rawContext.design === true || carriesDesignRecord ? MAX_DESIGN_CONTEXT_BYTES : MAX_AGENT_CONTEXT_BYTES,
  });
}

export function publishedInterfaceValidationReason(error: unknown): PublishedInterfaceFailureReason | null {
  if (!(error instanceof ContractValidationError)) return null;
  switch (error.code) {
    case "PUBLISHED_INTERFACE_TOO_LARGE": return "too_large";
    case "PUBLISHED_INTERFACE_INVALID_MARKDOWN": return "invalid_markdown";
    case "PUBLISHED_INTERFACE_EMPTY": return "empty";
    case "PUBLISHED_INTERFACE_OVER_BUDGET": return "over_budget";
    default: return null;
  }
}

function boundedJsonValue(value: unknown, maximum: number, label: string): void {
  if (byteLength(value) > maximum) throw new ContractValidationError(`${label} exceeds its byte bound`);
}

function parseCrossRepoContext(value: unknown, label: string): CrossRepoContext {
  const item = exact(value, [
    "providerProjectId", "providerRepoName", "interfacePath", "sha", "markdown",
  ], label);
  if (item.interfacePath !== "docs/interface.md") {
    throw new ContractValidationError(`${label}.interfacePath is invalid`);
  }
  if (typeof item.sha !== "string" || !GIT_OBJECT_ID_PATTERN.test(item.sha)) {
    throw new ContractValidationError(`${label}.sha is invalid`);
  }
  if (typeof item.markdown !== "string") {
    throw new ContractValidationError(`${label}.markdown must be a string`);
  }
  if (new TextEncoder().encode(item.markdown).byteLength > MAX_PUBLISHED_INTERFACE_BYTES) {
    throw new ContractValidationError(`${label}.markdown exceeds 64 KiB`, "PUBLISHED_INTERFACE_TOO_LARGE");
  }
  if (item.markdown.trim().length === 0) {
    throw new ContractValidationError(`${label}.markdown is empty`, "PUBLISHED_INTERFACE_EMPTY");
  }
  if (!isValidCrossRepoMarkdown(item.markdown)) {
    throw new ContractValidationError(`${label}.markdown is invalid`, "PUBLISHED_INTERFACE_INVALID_MARKDOWN");
  }
  return Object.freeze({
    providerProjectId: identifier(item.providerProjectId, `${label}.providerProjectId`),
    providerRepoName: prose(item.providerRepoName, `${label}.providerRepoName`, { maximum: 256 }),
    interfacePath: "docs/interface.md",
    sha: item.sha,
    markdown: item.markdown,
  });
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
    summary: workerProse(
      handoff.summary,
      `workflow.handoffs[${index}].summary`,
      STAGE_HANDOFF_SUMMARY_MAX_CHARACTERS,
    ),
    evidence: stringList(handoff.evidence, `workflow.handoffs[${index}].evidence`, 32),
    artifactIds: stringList(handoff.artifactIds, `workflow.handoffs[${index}].artifactIds`, 32),
    acceptanceCriteria: Object.freeze(acceptanceCriteria),
    blockers: stringList(
      handoff.blockers,
      `workflow.handoffs[${index}].blockers`,
      STAGE_HANDOFF_BLOCKERS_MAX_ITEMS,
    ),
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

function parseWorkflowPipelineFields(
  item: JsonRecord,
  label: string,
): Readonly<{
  workspaceKey: string | null;
  pipeline: WorkflowPipelineContext | null;
  review: WorkflowReviewContext | null;
  fix: WorkflowFixContext | null;
}> {
  const workspaceKey = item.workspaceKey === undefined || item.workspaceKey === null
    ? null
    : identifier(item.workspaceKey, `${label}.workspaceKey`);
  let pipeline: WorkflowPipelineContext | null = null;
  if (item.pipeline !== undefined && item.pipeline !== null) {
    const rawPipeline = record(item.pipeline, `${label}.pipeline`);
    const value = exact(item.pipeline, [
      "branch", "baseSha", "changeShape", "tier", "declaredScope", "nonGoals", "assumptions",
      ...("designRecord" in rawPipeline ? ["designRecord"] : []),
    ], `${label}.pipeline`);
    if (workspaceKey === null) {
      throw new ContractValidationError(`${label}.pipeline requires workspaceKey`);
    }
    const branch = workerProse(value.branch, `${label}.pipeline.branch`, 133);
    const baseSha = workerProse(value.baseSha, `${label}.pipeline.baseSha`, 64);
    const branchMatch = /^task\/(.+)$/u.exec(branch);
    const branchWorkspaceKey = branchMatch?.[1];
    if (
      branchWorkspaceKey === undefined ||
      (
        workspaceKey !== branchWorkspaceKey &&
        workspaceKey !== `${branchWorkspaceKey}${VERIFY_WORKSPACE_SUFFIX}` &&
        workspaceKey !== `${branchWorkspaceKey}${REVIEW_WORKSPACE_SUFFIX}`
      ) ||
      !GIT_OBJECT_ID_PATTERN.test(baseSha)
    ) {
      throw new ContractValidationError(`${label}.pipeline identity is invalid`);
    }
    pipeline = Object.freeze({
      branch,
      baseSha,
      changeShape: contractMember(value.changeShape, PLAN_CHANGE_SHAPES, `${label}.pipeline.changeShape`),
      tier: contractMember(value.tier, PLAN_TIERS, `${label}.pipeline.tier`),
      declaredScope: boundedPlanArray(value.declaredScope, `${label}.pipeline.declaredScope`, 1, 64,
        (entry, entryLabel) => planScopeEntry(entry, entryLabel, workerProse)),
      nonGoals: boundedPlanArray(value.nonGoals, `${label}.pipeline.nonGoals`, 0, 32,
        (entry, entryLabel) => workerProse(entry, entryLabel, 1_000)),
      assumptions: boundedPlanArray(value.assumptions, `${label}.pipeline.assumptions`, 0, 64,
        (entry, entryLabel) => workerProse(entry, entryLabel, 4_000)),
      designRecord: value.designRecord === undefined || value.designRecord === null
        ? null
        : parseDesignRecordDraft(value.designRecord),
    });
  }
  if ((workspaceKey === null) !== (pipeline === null)) {
    throw new ContractValidationError(`${label}.workspaceKey and pipeline must both be null or both be present`);
  }
  const review = item.review === undefined || item.review === null
    ? null
    : parseWorkflowReviewContext(item.review, `${label}.review`);
  if (review !== null && (pipeline === null || !workspaceKey?.endsWith(REVIEW_WORKSPACE_SUFFIX))) {
    throw new ContractValidationError(`${label}.review identity is invalid`);
  }
  const fix = item.fix === undefined || item.fix === null
    ? null
    : (() => {
        const value = exact(item.fix, ["round", "findings"], `${label}.fix`);
        return Object.freeze({
          round: integer(value.round, `${label}.fix.round`, 1),
          findings: Object.freeze(boundedPlanArray(
            value.findings,
            `${label}.fix.findings`,
            1,
            64,
            (entry, entryLabel) => parseReviewFindingEntity(entry, entryLabel),
          )),
        });
      })();
  if (fix !== null && (pipeline === null || workspaceKey?.endsWith(REVIEW_WORKSPACE_SUFFIX) === true)) {
    throw new ContractValidationError(`${label}.fix identity is invalid`);
  }
  return Object.freeze({ workspaceKey, pipeline, review, fix });
}

function parseWorkflowReviewContext(value: unknown, label: string): WorkflowReviewContext {
  const fields = [
    "commits", "diffstat", "filesTouched", "scopeOk", "midRunAssumptions",
    "acceptanceCriteria", "criterionChecks", "mechanicalPortions", "priorFindings",
    "priorFindingsTruncated",
  ];
  const item = exact(value, fields, label, {
    // Claims persisted before these additive review fields joined the block remain replayable.
    required: fields.filter((field) =>
      field !== "mechanicalPortions" && field !== "priorFindingsTruncated"),
  });
  const commits = boundedPlanArray(item.commits, `${label}.commits`, 0, 1_000, (entry, entryLabel) => {
    const commit = exact(entry, ["sha", "subject"], entryLabel);
    const sha = workerProse(commit.sha, `${entryLabel}.sha`, 64);
    if (!GIT_OBJECT_ID_PATTERN.test(sha)) throw new ContractValidationError(`${entryLabel}.sha is invalid`);
    return Object.freeze({ sha, subject: workerProse(commit.subject, `${entryLabel}.subject`, 1_000) });
  });
  const filesTouched = boundedPlanArray(item.filesTouched, `${label}.filesTouched`, 0, 10_000, (entry, entryLabel) => {
    const file = exact(entry, ["path", "status"], entryLabel);
    return Object.freeze({
      path: reviewFindingFile(file.path, `${entryLabel}.path`),
      status: contractMember(file.status, ["added", "modified", "deleted"] as const, `${entryLabel}.status`),
    });
  });
  const stringList = (input: unknown, field: string, maximum: number, itemMaximum: number): readonly string[] =>
    boundedPlanArray(input, field, 0, maximum,
      (entry, entryLabel) => workerProse(entry, entryLabel, itemMaximum));
  const criterionChecks = boundedPlanArray(
    item.criterionChecks,
    `${label}.criterionChecks`,
    0,
    32,
    (entry, entryLabel) => {
      const criterionCheck = exact(entry, ["criterion", "check"], entryLabel);
      return Object.freeze({
        criterion: workerProse(criterionCheck.criterion, `${entryLabel}.criterion`, 4_000),
        check: planCheck(criterionCheck.check, `${entryLabel}.check`, workerProse),
      });
    },
  );
  const priorFindings = boundedPlanArray(item.priorFindings, `${label}.priorFindings`, 0, 1_000,
    (entry, entryLabel) => parseReviewFindingEntity(entry, entryLabel));
  if (typeof item.scopeOk !== "boolean") throw new ContractValidationError(`${label}.scopeOk is invalid`);
  if (item.priorFindingsTruncated !== undefined && typeof item.priorFindingsTruncated !== "boolean") {
    throw new ContractValidationError(`${label}.priorFindingsTruncated is invalid`);
  }
  return Object.freeze({
    commits,
    diffstat: text(item.diffstat, `${label}.diffstat`, {
      maximum: 64_000,
      allowEmpty: true,
      trim: false,
      carriageReturns: "preserve",
    }),
    filesTouched,
    scopeOk: item.scopeOk,
    midRunAssumptions: stringList(item.midRunAssumptions, `${label}.midRunAssumptions`, 256, 4_000),
    acceptanceCriteria: stringList(item.acceptanceCriteria, `${label}.acceptanceCriteria`, 64, 4_000),
    criterionChecks,
    mechanicalPortions: item.mechanicalPortions === undefined
      ? Object.freeze([])
      : stringList(item.mechanicalPortions, `${label}.mechanicalPortions`, 32, 1_000),
    priorFindings,
    priorFindingsTruncated: item.priorFindingsTruncated ?? false,
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
  const rawContext = record(value, "Agent context");
  const usage = workerAgentContextUsage(value);
  if (usage.bytes > usage.budget) {
    throw new WorkerAgentContextBudgetError(usage, rawContext.crossRepoContext !== undefined);
  }
  const item = exact(value, [
    "apiVersion", "projectId", "agentId", "taskId", "intake", "onboarding", "design", "mission", "projectMemory", "task", "areaMemory", "parentEvidence",
    "messagesSinceCursor", "nextMessageCursor", "messages", "triggerQuestion", "openQuestions", "workspaceRefs", "phase", "crossRepoContext", "workflow",
  ], "Agent context", {
    required: [
      "apiVersion", "projectId", "agentId", "taskId", "intake", "design", "mission", "projectMemory", "task", "areaMemory", "parentEvidence",
      "messagesSinceCursor", "nextMessageCursor", "messages", "triggerQuestion", "openQuestions", "workspaceRefs", "workflow",
    ],
  });
  if (item.apiVersion !== 1) throw new ContractValidationError("Agent context version is invalid");
  if (item.onboarding !== undefined && item.onboarding !== true) {
    throw new ContractValidationError("context.onboarding must be true when present");
  }
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
    const workflowItem = exact(
      item.workflow,
      ["planRevisionId", "nodeId", "stage", "skills", "dependencyHandoffs", "workspaceKey", "pipeline", "review", "fix"],
      "Workflow context",
      { required: ["planRevisionId", "nodeId", "stage", "skills", "dependencyHandoffs"] },
    );
    const workflowStage = contractMember(workflowItem.stage, WORKFLOW_STAGES, "Workflow stage");
    const pipelineFields = parseWorkflowPipelineFields(workflowItem, "Workflow context");
    if (pipelineFields.fix !== null && workflowStage !== "implementation") {
      throw new ContractValidationError("Workflow context.fix is only valid during implementation");
    }
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
      workspaceKey: pipelineFields.workspaceKey,
      pipeline: pipelineFields.pipeline,
      review: pipelineFields.review,
      fix: pipelineFields.fix,
    });
  }

  const crossRepoContext = item.crossRepoContext === undefined
    ? undefined
    : parseCrossRepoContext(item.crossRepoContext, "crossRepoContext");
  const phase = item.phase === undefined || item.phase === null
    ? null
    : contractMember(item.phase, WORK_ITEM_PHASES, "context.phase");

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
    intake: booleanValue(item.intake, "context.intake"),
    ...(item.onboarding === true ? { onboarding: true as const } : {}),
    design: booleanValue(item.design, "context.design"),
    mission: Object.freeze({ role: workerProse(mission.role, "mission.role", 64), area: workerProse(mission.area, "mission.area", 256), mission: workerProse(mission.mission, "mission.mission", 2_000) }),
    projectMemory: workerProse(item.projectMemory, "projectMemory", 8_000),
    task: Object.freeze({
      kind: contractMember(task.kind, TASK_KINDS, "task.kind") as TaskKind,
      requiredRole: task.requiredRole === null ? null : contractMember(task.requiredRole, AGENT_ROLES, "task.requiredRole") as AgentRole,
      title: workerProse(task.title, "task.title", 512),
      objective: workerProse(
        task.objective,
        "task.objective",
        item.design === true ? MAX_INTERNAL_TASK_OBJECTIVE_CHARACTERS : 8_000,
      ),
      acceptanceCriteria: workerProse(task.acceptanceCriteria, "task.acceptanceCriteria", 4_000), version: workerPositive(task.version, "task.version"),
      expectedAgentMinutes: expectedMinutes(task.expectedAgentMinutes, "task.expectedAgentMinutes", {
        nullable: true, maximum: 10_080,
        message: (field) => `${field} must be a 15-minute interval between 15 and 10080`,
      }), phases: Object.freeze(phases),
    }),
    areaMemory: Object.freeze(areaMemory), parentEvidence, messagesSinceCursor: since, nextMessageCursor: next,
    messages: Object.freeze(messages), triggerQuestion, openQuestions: Object.freeze(openQuestions),
    workspaceRefs: Object.freeze(item.workspaceRefs.map((entry, index) => workerProse(entry, `workspaceRefs[${index}]`, 512))),
    phase,
    ...(crossRepoContext === undefined ? {} : { crossRepoContext }),
    workflow,
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

interface DraftMessageMap {
  readonly handoffLabel: string;
  readonly handoffObjectInvalid?: string;
  readonly handoffCriteriaInvalid: string;
  readonly handoffCriterionLabel: (index: number) => string;
  readonly handoffCriterionResultInvalid: (index: number) => string;
  readonly criterionLabel: string;
  readonly criterionEvidenceLabel: string;
  readonly handoffOutcomeLabel: string;
  readonly handoffReturnStageLabel: string;
  readonly workflowPlanLabel: string;
  readonly workflowNodesInvalid: string;
  readonly workflowNodeLabel: (index: number) => string;
  readonly workflowNodeStagesInvalid: (index: number) => string;
  readonly workflowNodeStageLabel: (index: number, stageIndex: number) => string;
  readonly workflowNodeStageOrderInvalid: (index: number) => string;
}

interface DraftParserPolicy {
  readonly exactMessages: ExactMessageMap;
  readonly textKind: "prose" | "text";
  readonly stageListKind: "members" | "strings";
  readonly messages: DraftMessageMap;
}

const WORKER_DRAFT_POLICY: DraftParserPolicy = Object.freeze({
  exactMessages: GENERIC_EXACT_MESSAGES,
  textKind: "prose",
  stageListKind: "members",
  messages: Object.freeze({
    handoffLabel: "Stage handoff",
    handoffCriteriaInvalid: "Stage handoff criteria are invalid",
    handoffCriterionLabel: (index: number) => `Stage handoff criterion ${index}`,
    handoffCriterionResultInvalid: (index: number) => `Stage handoff criterion ${index} result is invalid`,
    criterionLabel: "criterion",
    criterionEvidenceLabel: "criterion evidence",
    handoffOutcomeLabel: "Stage handoff outcome",
    handoffReturnStageLabel: "Stage handoff return stage",
    workflowPlanLabel: "Workflow plan",
    workflowNodesInvalid: "Workflow plan nodes are invalid",
    workflowNodeLabel: (index: number) => `Workflow plan node ${index}`,
    workflowNodeStagesInvalid: (index: number) => `Workflow plan node ${index} stages are invalid`,
    workflowNodeStageLabel: (index: number, stageIndex: number) => `Workflow plan node ${index} stage ${stageIndex}`,
    workflowNodeStageOrderInvalid: (index: number) => `Workflow plan node ${index} stage order is invalid`,
  }),
});

const BOARD_DRAFT_POLICY: DraftParserPolicy = Object.freeze({
  exactMessages: GENERIC_EXACT_MESSAGES,
  textKind: "text",
  stageListKind: "strings",
  messages: Object.freeze({
    handoffLabel: "handoff",
    handoffObjectInvalid: "handoff is invalid",
    handoffCriteriaInvalid: "handoff criteria are invalid",
    handoffCriterionLabel: (index: number) => `handoff criterion ${index}`,
    handoffCriterionResultInvalid: () => "handoff criterion result is invalid",
    criterionLabel: "criterion",
    criterionEvidenceLabel: "evidence",
    handoffOutcomeLabel: "handoff outcome",
    handoffReturnStageLabel: "handoff return stage",
    workflowPlanLabel: "workflowPlan",
    workflowNodesInvalid: "workflowPlan.nodes is invalid",
    workflowNodeLabel: (index: number) => `workflowPlan.nodes[${index}]`,
    workflowNodeStagesInvalid: (index: number) => `workflowPlan.nodes[${index}].stageTemplate is invalid`,
    workflowNodeStageLabel: (index: number, stageIndex: number) => `workflowPlan.nodes[${index}].stageTemplate[${stageIndex}]`,
    workflowNodeStageOrderInvalid: (index: number) => `workflowPlan.nodes[${index}].stageTemplate is invalid`,
  }),
});

function draftExact(value: unknown, fields: readonly string[], label: string, policy: DraftParserPolicy): JsonRecord {
  return exact(value, fields, label, { messages: policy.exactMessages });
}

function draftText(value: unknown, label: string, maximum: number, policy: DraftParserPolicy): string {
  return policy.textKind === "prose"
    ? prose(value, label, { maximum, carriageReturns: "preserve" })
    : text(value, label, { maximum, message: `${label} is invalid` });
}

function draftStringList(
  value: unknown,
  label: string,
  policy: DraftParserPolicy,
  maximum = 32,
  minimum = 0,
): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new ContractValidationError(`${label} is invalid`);
  }
  return Object.freeze(value.map((entry, index) => draftText(entry, `${label}[${index}]`, 2_000, policy)));
}

function parseHandoffDraft(value: unknown, policy: DraftParserPolicy): StageHandoffDraft {
  const messages = policy.messages;
  if (messages.handoffObjectInvalid !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
    throw new ContractValidationError(messages.handoffObjectInvalid);
  }
  const item = draftExact(value, ["outcome", "summary", "evidence", "artifactIds", "acceptanceCriteria", "blockers", "recommendedReturnStage"], messages.handoffLabel, policy);
  if (!Array.isArray(item.acceptanceCriteria) || item.acceptanceCriteria.length > 32) {
    throw new ContractValidationError(messages.handoffCriteriaInvalid);
  }
  const criteria = item.acceptanceCriteria.map((entry, index) => {
    const criterion = draftExact(entry, ["criterion", "passed", "evidence"], messages.handoffCriterionLabel(index), policy);
    if (typeof criterion.passed !== "boolean") throw new ContractValidationError(messages.handoffCriterionResultInvalid(index));
    return Object.freeze({
      criterion: draftText(criterion.criterion, messages.criterionLabel, 1_000, policy),
      passed: criterion.passed,
      evidence: draftText(criterion.evidence, messages.criterionEvidenceLabel, 2_000, policy),
    });
  });
  return Object.freeze({
    outcome: contractMember(item.outcome, STAGE_HANDOFF_OUTCOMES, messages.handoffOutcomeLabel),
    summary: draftText(item.summary, "handoff.summary", STAGE_HANDOFF_SUMMARY_MAX_CHARACTERS, policy),
    evidence: draftStringList(item.evidence, "handoff.evidence", policy),
    artifactIds: draftStringList(item.artifactIds, "handoff.artifactIds", policy),
    acceptanceCriteria: Object.freeze(criteria),
    blockers: draftStringList(
      item.blockers,
      "handoff.blockers",
      policy,
      STAGE_HANDOFF_BLOCKERS_MAX_ITEMS,
    ),
    recommendedReturnStage: item.recommendedReturnStage === null
      ? null
      : contractMember(item.recommendedReturnStage, WORKFLOW_STAGES, messages.handoffReturnStageLabel),
  });
}

function parseDeclaredChild(value: unknown, label: string, policy: DraftParserPolicy): DeclaredChild {
  const required = ["key", "objective", "projectId", "declaredScope", "acceptanceCriteria"];
  const item = exact(
    value,
    [...required, "phase", "dependsOn", "splitBy"],
    label,
    { messages: policy.exactMessages, required },
  );
  const parseText = (entry: unknown, entryLabel: string, maximum: number): string =>
    draftText(entry, entryLabel, maximum, policy);
  return Object.freeze({
    key: identifier(item.key, `${label}.key`),
    objective: draftText(item.objective, `${label}.objective`, 4_000, policy),
    projectId: identifier(item.projectId, `${label}.projectId`),
    declaredScope: boundedPlanArray(item.declaredScope, `${label}.declaredScope`, 1, 64,
      (entry, entryLabel) => planScopeEntry(entry, entryLabel, parseText)),
    acceptanceCriteria: draftStringList(
      item.acceptanceCriteria,
      `${label}.acceptanceCriteria`,
      policy,
      64,
      1,
    ),
    ...(item.phase === undefined ? {} : {
      phase: contractMember(item.phase, WORK_ITEM_PHASES, `${label}.phase`, `${label}.phase is invalid`),
    }),
    ...(item.dependsOn === undefined ? {} : {
      dependsOn: Object.freeze(draftStringList(item.dependsOn, `${label}.dependsOn`, policy, 64)
        .map((dependency, dependencyIndex) => identifier(dependency, `${label}.dependsOn[${dependencyIndex}]`))),
    }),
    ...(item.splitBy === undefined ? {} : {
      splitBy: contractMember(item.splitBy, ["consumer", "phase"] as const, `${label}.splitBy`, `${label}.splitBy is invalid`),
    }),
  });
}

export function validateWorkflowPlanChildren(
  plan: Pick<WorkflowPlanDraft, "changeShape" | "children">,
  parentProjectId?: string,
  parentWorkItemId?: string | null,
): void {
  const children = plan.children;
  const hasChildren = children !== undefined && children.length > 0;
  if (parentWorkItemId !== undefined && parentWorkItemId !== null && hasChildren) {
    throw new ContractValidationError("workflowPlan.children is invalid for a child work item");
  }
  if (plan.changeShape === "mechanical_sweep" && hasChildren) {
    throw new ContractValidationError("workflowPlan.children is invalid for a mechanical_sweep");
  }
  if (plan.changeShape === "blast_radius" && !hasChildren) {
    throw new ContractValidationError("workflowPlan.children is required for a blast_radius");
  }
  if (!hasChildren) return;
  if (plan.changeShape === "blast_radius" && children.some((child) => child.splitBy === undefined)) {
    throw new ContractValidationError("every blast_radius child requires splitBy");
  }
  const phasedChildren = children.filter((child) => child.phase !== undefined);
  if (phasedChildren.length > 0 && phasedChildren.length !== children.length) {
    throw new ContractValidationError("every workflowPlan child requires phase when any phase is declared");
  }
  if (plan.changeShape === "feature" && phasedChildren.length > 0) {
    throw new ContractValidationError("workflowPlan.children phases are invalid for a feature split");
  }

  const childrenByKey = new Map<string, DeclaredChild>();
  for (const child of children) {
    if (childrenByKey.has(child.key)) {
      throw new ContractValidationError("workflowPlan.children contains a duplicate key");
    }
    childrenByKey.set(child.key, child);
    const dependencies = child.dependsOn ?? [];
    if (new Set(dependencies).size !== dependencies.length) {
      throw new ContractValidationError(`workflowPlan child ${child.key} contains a duplicate dependency`);
    }
  }
  for (const child of children) {
    for (const dependency of child.dependsOn ?? []) {
      if (!childrenByKey.has(dependency)) {
        throw new ContractValidationError(`workflowPlan child ${child.key} has an unknown dependency`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new ContractValidationError("workflowPlan.children contains a dependency cycle");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of childrenByKey.get(key)?.dependsOn ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const child of children) visit(child.key);

  for (let left = 0; left < children.length; left += 1) {
    for (let right = left + 1; right < children.length; right += 1) {
      const a = children[left]!;
      const b = children[right]!;
      const requiresDisjointScopes =
        (a.phase === undefined && b.phase === undefined) ||
        (a.phase === "migrate" && b.phase === "migrate");
      if (
        requiresDisjointScopes && a.projectId === b.projectId &&
        declaredScopesOverlap(a.declaredScope, b.declaredScope)
      ) {
        throw new ContractValidationError(`workflowPlan child scopes overlap in project ${a.projectId}`);
      }
    }
  }

  if (phasedChildren.length === 0) return;
  const expands = children.filter((child) => child.phase === "expand");
  const migrates = children.filter((child) => child.phase === "migrate");
  const contracts = children.filter((child) => child.phase === "contract");
  if (expands.length !== 1 || migrates.length < 1 || contracts.length !== 1) {
    throw new ContractValidationError("workflowPlan.children has an invalid phased declaration");
  }
  const expand = expands[0]!;
  const contract = contracts[0]!;
  const publishedInterfacePath = "docs/interface.md";
  const coversPublishedInterface = (child: DeclaredChild): boolean => normalizeDeclaredScope(child.declaredScope)
    .some((prefix) => publishedInterfacePath === prefix || publishedInterfacePath.startsWith(`${prefix}/`));
  if (!coversPublishedInterface(expand)) {
    throw new ContractValidationError(`expand child declaredScope must cover ${publishedInterfacePath}`);
  }
  if (!coversPublishedInterface(contract)) {
    throw new ContractValidationError(`contract child declaredScope must cover ${publishedInterfacePath}`);
  }
  const providerProjectId = parentProjectId ?? expand.projectId;
  if (expand.projectId !== providerProjectId || contract.projectId !== providerProjectId) {
    throw new ContractValidationError("expand and contract children must use the parent project");
  }
  if (migrates.some((child) => child.projectId === providerProjectId)) {
    throw new ContractValidationError("migrate children must use projects other than the parent project");
  }
  if (migrates.some((child) => !(child.dependsOn ?? []).includes(expand.key))) {
    throw new ContractValidationError("every migrate child must depend on the expand child");
  }
  const contractDependencies = new Set(contract.dependsOn ?? []);
  if (migrates.some((child) => !contractDependencies.has(child.key))) {
    throw new ContractValidationError("the contract child must depend on every migrate child");
  }
}

function parseDraftPlanRecord(item: JsonRecord, label: string, policy: DraftParserPolicy): PlanRecordFields {
  const parseText = (value: unknown, field: string, maximum: number): string =>
    draftText(value, field, maximum, policy);
  return Object.freeze({
    ...(item.changeShape === undefined ? {} : {
      changeShape: contractMember(item.changeShape, PLAN_CHANGE_SHAPES, `${label}.changeShape`, `${label}.changeShape is invalid`),
    }),
    ...(item.tier === undefined ? {} : {
      tier: contractMember(item.tier, PLAN_TIERS, `${label}.tier`, `${label}.tier is invalid`),
    }),
    ...(item.declaredScope === undefined ? {} : {
      declaredScope: boundedPlanArray(item.declaredScope, `${label}.declaredScope`, 1, 64,
        (entry, entryLabel) => planScopeEntry(entry, entryLabel, parseText)),
    }),
    ...(item.nonGoals === undefined ? {} : {
      nonGoals: boundedPlanArray(item.nonGoals, `${label}.nonGoals`, 0, 32,
        (entry, entryLabel) => parseText(entry, entryLabel, 1_000)),
    }),
    ...(item.mechanicalPortions === undefined ? {} : {
      mechanicalPortions: boundedPlanArray(item.mechanicalPortions, `${label}.mechanicalPortions`, 0, 32,
        (entry, entryLabel) => parseText(entry, entryLabel, 1_000)),
    }),
    ...(item.blockingQuestions === undefined ? {} : {
      blockingQuestions: boundedPlanArray(item.blockingQuestions, `${label}.blockingQuestions`, 0, 16,
        (entry, entryLabel) => {
          const question = draftExact(entry, ["question", "recommendedDefault"], entryLabel, policy);
          return Object.freeze({
            question: parseText(question.question, `${entryLabel}.question`, 1_000),
            recommendedDefault: parseText(question.recommendedDefault, `${entryLabel}.recommendedDefault`, 1_000),
          });
        }),
    }),
    ...(item.criterionChecks === undefined ? {} : {
      criterionChecks: boundedPlanArray(item.criterionChecks, `${label}.criterionChecks`, 0, 32,
        (entry, entryLabel) => {
          const criterion = draftExact(entry, ["criterion", "check"], entryLabel, policy);
          return Object.freeze({
            criterion: parseText(criterion.criterion, `${entryLabel}.criterion`, 1_000),
            check: planCheck(criterion.check, `${entryLabel}.check`, parseText),
          });
        }),
    }),
  });
}

function parseWorkflowPlan(value: unknown, policy: DraftParserPolicy): WorkflowPlanDraft {
  const messages = policy.messages;
  const required = ["objective", "assumptions", "acceptanceCriteria", "nodes"];
  const item = exact(value, [...required, ...PLAN_RECORD_FIELD_NAMES, "children"], messages.workflowPlanLabel, {
    messages: policy.exactMessages,
    required,
  });
  if (!Array.isArray(item.nodes) || item.nodes.length < 1 || item.nodes.length > 64) {
    throw new ContractValidationError(messages.workflowNodesInvalid);
  }
  const nodes = item.nodes.map((entry, index) => {
    const node = draftExact(entry, ["nodeId", "title", "objective", "acceptanceCriteria", "dependencyNodeIds", "stageTemplate"], messages.workflowNodeLabel(index), policy);
    let stageTemplate: readonly WorkflowStage[];
    if (policy.stageListKind === "members") {
      if (!Array.isArray(node.stageTemplate) || node.stageTemplate.length < 1 || node.stageTemplate.length > 5) {
        throw new ContractValidationError(messages.workflowNodeStagesInvalid(index));
      }
      stageTemplate = node.stageTemplate.map((stage, stageIndex) =>
        contractMember(stage, WORKFLOW_STAGES, messages.workflowNodeStageLabel(index, stageIndex)));
      if (new Set(stageTemplate).size !== stageTemplate.length ||
        (stageTemplate.at(-1) !== "verification" && stageTemplate.at(-1) !== "testing")) {
        throw new ContractValidationError(messages.workflowNodeStageOrderInvalid(index));
      }
    } else {
      const stages = draftStringList(node.stageTemplate, `workflowPlan.nodes[${index}].stageTemplate`, policy, 64, 1);
      if (stages.length > 5 || new Set(stages).size !== stages.length ||
        (stages.at(-1) !== "verification" && stages.at(-1) !== "testing") ||
        stages.some((stage) => !(WORKFLOW_STAGES as readonly string[]).includes(stage))) {
        throw new ContractValidationError(messages.workflowNodeStageOrderInvalid(index));
      }
      stageTemplate = stages as readonly WorkflowStage[];
    }
    return Object.freeze({
      nodeId: identifier(node.nodeId, `workflowPlan.nodes[${index}].nodeId`),
      title: draftText(node.title, `workflowPlan.nodes[${index}].title`, 512, policy),
      objective: draftText(node.objective, `workflowPlan.nodes[${index}].objective`, 4_000, policy),
      acceptanceCriteria: draftStringList(node.acceptanceCriteria, `workflowPlan.nodes[${index}].acceptanceCriteria`, policy, 64, 1),
      dependencyNodeIds: draftStringList(node.dependencyNodeIds, `workflowPlan.nodes[${index}].dependencyNodeIds`, policy, 64),
      stageTemplate: Object.freeze(stageTemplate),
    });
  });
  const parsed = Object.freeze({
    objective: draftText(item.objective, "workflowPlan.objective", 8_000, policy),
    assumptions: draftStringList(item.assumptions, "workflowPlan.assumptions", policy, 64),
    acceptanceCriteria: draftStringList(item.acceptanceCriteria, "workflowPlan.acceptanceCriteria", policy, 64, 1),
    ...parseDraftPlanRecord(item, messages.workflowPlanLabel, policy),
    nodes: Object.freeze(nodes),
    ...(item.children === undefined ? {} : {
      children: boundedPlanArray(item.children, "workflowPlan.children", 0, 64,
        (entry, entryLabel) => parseDeclaredChild(entry, entryLabel, policy)),
    }),
  });
  validateWorkflowPlanChildren(parsed);
  return parsed;
}

export function parseWorkflowPlanDraft(value: unknown): WorkflowPlanDraft {
  return parseWorkflowPlan(value, BOARD_DRAFT_POLICY);
}

export function parseWorkerAgentRunOutcome(value: unknown): ValidatedAgentRunOutcome {
  boundedJsonValue(value, MAX_OUTCOME_BYTES, "Agent outcome");
  const raw = record(value, "Agent outcome");
  const item = exact(value, [
    "status", "outputs", "expectedAgentMinutes", "phases", "detail",
    ...("gapReport" in raw ? ["gapReport"] : []),
    ...("handoff" in raw ? ["handoff"] : []), ...("workflowPlan" in raw ? ["workflowPlan"] : []),
    ...("reviewFindings" in raw ? ["reviewFindings"] : []),
    ...("designRecord" in raw ? ["designRecord"] : []),
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
    status: item.status, outputs: Object.freeze(outputs), expectedAgentMinutes: expectedMinutes(item.expectedAgentMinutes, "outcome.expectedAgentMinutes", {
      nullable: true, maximum: 10_080,
      message: (field) => `${field} must be a 15-minute interval between 15 and 10080`,
    }),
    phases: Object.freeze(phases), detail: workerProse(item.detail, "outcome.detail", 2_000),
    ...(item.gapReport === undefined ? {} : {
      gapReport: workerProse(item.gapReport, "outcome.gapReport", AGENT_GAP_REPORT_MAX_CHARACTERS),
    }),
    handoff: item.handoff === undefined || item.handoff === null ? null : parseHandoffDraft(item.handoff, WORKER_DRAFT_POLICY),
    workflowPlan: item.workflowPlan === undefined || item.workflowPlan === null ? null : parseWorkflowPlan(item.workflowPlan, WORKER_DRAFT_POLICY),
    ...(item.reviewFindings === undefined ? {} : {
      reviewFindings: parseReviewFindingDraftList(item.reviewFindings, "outcome.reviewFindings"),
    }),
    ...(item.designRecord === undefined || item.designRecord === null ? {} : {
      designRecord: parseDesignRecordDraft(item.designRecord),
    }),
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
  const raw = record(value, "Project");
  const item = boardExact(value, ["name", "description", ...("repoPath" in raw ? ["repoPath"] : [])], "Project");
  const description = boardText(item.description, "description", 8_000);
  return Object.freeze({
    name: boardText(item.name, "name", 160),
    description,
    repoPath: item.repoPath === undefined ? description : boardText(item.repoPath, "repoPath", 8_000),
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
  const item = boardAllowed(value, ["originalRequest", "priority", "taskType", "projectTarget"], ["originalRequest"], "Work item");
  const taskType = item.taskType === undefined
    ? "standard"
    : contractMember(item.taskType, WORK_ITEM_TASK_TYPES, "taskType", "taskType is invalid");
  if (item.projectTarget === undefined) {
    boardFailure(
      "Choose a project",
      taskType === "onboarding" ? TASK_BOARD_ERROR_CODES.ONBOARDING_PROJECT_REQUIRED : TASK_BOARD_ERROR_CODES.PROJECT_REQUIRED,
    );
  }
  return Object.freeze({
    originalRequest: boardText(item.originalRequest, "originalRequest", 16_000),
    priority: item.priority === undefined ? "normal" : contractMember(item.priority, WORK_ITEM_PRIORITIES, "priority", "priority is invalid"),
    taskType,
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
  if (item.kind === "machine_verify" || item.kind === "human" || item.kind === "disabled") {
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
    if (entry.executor.kind === "machine_verify" && entry.stage !== "testing") {
      boardFailure(`${entry.stage} cannot use the machine_verify executor`);
    }
    if (entry.stage === "human_review") { if (entry.executor.kind !== "human") boardFailure("human_review must use the human executor"); continue; }
    if (entry.stage === "deployment") { if (entry.executor.kind !== "disabled") boardFailure("deployment must remain disabled"); continue; }
    if (entry.executor.kind === "human") boardFailure(`${entry.stage} cannot use the human executor`);
    if (entry.executor.kind === "disabled" || entry.executor.kind === "machine_verify") continue;
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
  if ("expectedAgentMinutes" in item) expectedMinutes(item.expectedAgentMinutes, "expectedAgentMinutes", {
    maximum: 10_080,
    message: (field) => `${field} must be a 15-minute interval between 15 and 10080`,
    code: "INVALID_EXPECTED_AGENT_MINUTES",
  });
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
  if ("expectedAgentMinutes" in item) result.expectedAgentMinutes = expectedMinutes(item.expectedAgentMinutes, "expectedAgentMinutes", {
    nullable: true, maximum: 10_080,
    message: (field) => `${field} must be a 15-minute interval between 15 and 10080`,
    code: "INVALID_EXPECTED_AGENT_MINUTES",
  });
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
      "Run claim pinned",
    );
    const parsed: { runtime?: string; runtimeVersion?: string; model?: string; promptsSha?: string } = {};
    for (const field of ["runtime", "runtimeVersion", "model", "promptsSha"] as const) {
      if (!(field in rawPinned)) continue;
      const candidate = rawPinned[field];
      if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > 128 || /[\u0000-\u001f\u007f]/u.test(candidate)) {
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
  if (Object.keys(rawCursors).length > 256) boardFailure("messageCursors must be an object with at most 256 task entries");
  const messageCursors: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [taskId, cursor] of Object.entries(rawCursors)) {
    parseBoardIdentifier(taskId, "messageCursors taskId");
    if (!Number.isSafeInteger(cursor) || Number(cursor) < 0) boardFailure("messageCursors values must be non-negative safe integers");
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
  const item = boardExact(value, [
    "outcome", "result",
    ...("gapReport" in raw ? ["gapReport"] : []),
    ...("handoff" in raw ? ["handoff"] : []),
    ...("workflowPlan" in raw ? ["workflowPlan"] : []),
    ...("reviewFindings" in raw ? ["reviewFindings"] : []),
    ...("designRecord" in raw ? ["designRecord"] : []),
  ], "Run settlement");
  if (item.outcome !== "completed" && item.outcome !== "failed" && item.outcome !== "interrupted") boardFailure("Run outcome is invalid");
  return Object.freeze({ outcome: item.outcome, result: boardText(item.result, "result", 16_000),
    ...(item.gapReport === undefined ? {} : {
      gapReport: boardText(item.gapReport, "gapReport", AGENT_GAP_REPORT_MAX_CHARACTERS),
    }),
    handoff: item.handoff === undefined || item.handoff === null ? null : parseHandoffDraft(item.handoff, BOARD_DRAFT_POLICY),
    workflowPlan: item.workflowPlan === undefined || item.workflowPlan === null ? null : parseWorkflowPlan(item.workflowPlan, BOARD_DRAFT_POLICY),
    ...(item.reviewFindings === undefined ? {} : {
      reviewFindings: parseReviewFindingDraftList(item.reviewFindings, "reviewFindings"),
    }),
    ...(item.designRecord === undefined || item.designRecord === null ? {} : {
      designRecord: (() => {
        try {
          return parseDesignRecordDraft(item.designRecord);
        } catch (error) {
          if (error instanceof ContractValidationError) {
            throw new ContractValidationError(
              error.message,
              TASK_BOARD_ERROR_CODES.TASK_BOARD_DESIGN_RECORD_REQUIRED,
            );
          }
          throw error;
        }
      })(),
    }) });
}

export function parseBoardIdempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) {
    boardFailure("A valid Idempotency-Key header is required", "INVALID_IDEMPOTENCY_KEY");
  }
  return value;
}
