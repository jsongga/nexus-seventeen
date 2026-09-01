/** Parses stored task-board entities out of database rows and wire records. */

/* —— Imports —— */

import {
  ACTOR_TYPES,
  AGENT_ROLES,
  AGENT_STATUSES,
  type AgentInterrupt,
  type AgentProfile,
  type AgentRun,
  type BoardNotification,
  type BoardPause,
  type BoardTask,
  ContractValidationError,
  type CriterionResult,
  DESIGN_FAILURE_POINTS,
  DESIGN_RECORD_DETAIL_MAX_LENGTH,
  DESIGN_RECORD_LABEL_MAX_LENGTH,
  DESIGN_RECORD_MAX_FAILURE_POINTS,
  DESIGN_RECORD_MAX_FAULT_INJECTION_CASES,
  DESIGN_RECORD_MAX_IDEMPOTENCY_KEYS,
  DESIGN_RECORD_MAX_STATES,
  DESIGN_RECORD_MAX_TRANSITIONS,
  type DeclaredChild,
  type DesignFailurePoint,
  type DesignFailurePointKind,
  type DesignRecord,
  type DesignRecordDraft,
  type FindingsLedger,
  GATE_KINDS,
  GIT_OBJECT_ID_PATTERN,
  type GateAction,
  type HumanQuestion,
  NOTIFICATION_KINDS,
  PARK_CATEGORIES,
  PARK_RESOLUTIONS,
  PLAN_CHANGE_SHAPES,
  PLAN_REVISION_STATES,
  PLAN_TIERS,
  type ParkCategory,
  type ParkRecord,
  type ParksLedger,
  type PipelineSummary,
  type PlanRecordFields,
  type PlanRevision,
  type Project,
  type ProjectArtifact,
  type ProjectEvent,
  QUESTION_STATUSES,
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_DRAFT_MAX_ITEMS,
  REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH,
  REVIEW_FINDING_SEVERITIES,
  RUN_STATUSES,
  type ReviewFinding,
  type ReviewFindingCategory,
  type ReviewFindingDraft,
  type ReviewFindingSeverity,
  STAGE_HANDOFF_OUTCOMES,
  type StageHandoff,
  TASK_BOARD_API_VERSION,
  TASK_KINDS,
  TASK_MESSAGE_ACTOR_TYPES,
  TASK_MESSAGE_KINDS,
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  TASK_STATUSES,
  type TaskEvent,
  type TaskMessage,
  type TaskPhase,
  type TaskStatus,
  type VerifyAttempt,
  WORKER_CONNECTIONS,
  WORKFLOW_STAGES,
  WORK_ITEM_PHASES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STAGES,
  WORK_ITEM_STATES,
  WORK_ITEM_TASK_TYPES,
  WORK_NODE_STATES,
  type WorkItem,
  type WorkItemAudit,
  type WorkItemPhase,
  type WorkItemProjectTarget,
  type WorkItemState,
  type WorkItemTransition,
  type WorkNode,
  type WorkflowStage,
  isTerminalWorkItemState,
} from "../index.js";
import {
  type ExactMessageMap,
  type JsonRecord,
  PATH_EXACT_MESSAGES,
  type ScalarMessageProfile,
  arrayOf,
  booleanValue,
  boundedClaimText,
  contractMember,
  exact,
  identifier,
  integer,
  prose,
  record,
  stringValue,
  text,
  timestamp,
} from "./scalars.js";

/* —— Stored entity parsing —— */

export interface ShapeParserOptions {
  // Browser response parsing remains forward-compatible with additive server fields.
  readonly exact?: false | ExactMessageMap;
  // Browser projections historically treated wire IDs as opaque strings.
  readonly identifiers?: "contract" | "string";
  readonly identifierMessages?: "invalid" | "valid-identifier";
  readonly scalarMessages?: ScalarMessageProfile;
  // Browser projections intentionally discard server-only fields.
  readonly projection?: "contract" | "browser";
  // Browser enums bucket unknown future members instead of rejecting the response.
  readonly tolerantEnums?: boolean;
}

export type TolerantTaskEntity = Omit<BoardTask, "status"> &
  Readonly<{
    status: TaskStatus | "unrecognized";
  }>;

export type TolerantWorkItemEntity = Omit<WorkItem, "state" | "taskType" | "phase"> &
  Readonly<{
    state: WorkItemState | "unrecognized";
    taskType: string;
    phase: WorkItemPhase | "unrecognized" | null;
  }>;

export type TolerantDeclaredChild = Omit<DeclaredChild, "phase"> &
  Readonly<{
    phase?: WorkItemPhase | "unrecognized";
  }>;

export type TolerantPlanRevision = Omit<PlanRevision, "children"> &
  Readonly<{
    children: readonly TolerantDeclaredChild[] | null;
  }>;

export type TolerantParkRecord = Omit<ParkRecord, "category" | "resolution"> &
  Readonly<{
    category: ParkCategory | "unrecognized";
    resolution: (typeof PARK_RESOLUTIONS)[number] | "unrecognized" | null;
  }>;

export type TolerantBoardNotification = Omit<BoardNotification, "kind"> &
  Readonly<{
    kind: (typeof NOTIFICATION_KINDS)[number] | "unrecognized";
  }>;

export type TolerantGateAction = Omit<GateAction, "gate"> &
  Readonly<{
    gate: (typeof GATE_KINDS)[number] | "unrecognized";
  }>;

export type TolerantReviewFindingEntity = Omit<ReviewFinding, "category" | "severity" | "stage"> &
  Readonly<{
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

type TolerantDesignFailurePoint = Omit<DesignFailurePoint, "point"> &
  Readonly<{
    point: DesignFailurePointKind | "unrecognized";
  }>;

export type TolerantDesignRecordEntity = Omit<DesignRecord, "failurePoints"> &
  Readonly<{
    failurePoints: readonly TolerantDesignFailurePoint[];
  }>;

export type ParsedWorkItemTransition = WorkItemTransition;

export type TolerantWorkItemAudit = Omit<WorkItemAudit, "gateActions"> &
  Readonly<{
    gateActions: readonly TolerantGateAction[];
  }>;

export function shape(
  value: unknown,
  label: string,
  fields: readonly string[],
  required: readonly string[],
  options: ShapeParserOptions
): JsonRecord {
  return options.exact === false
    ? record(value, label)
    : exact(value, fields, label, { messages: options.exact, required });
}

export function entity(
  value: unknown,
  label: string,
  fields: readonly string[],
  required: readonly string[],
  options: ShapeParserOptions
): JsonRecord {
  const item = shape(value, label, fields, required, options);
  if (item.apiVersion !== TASK_BOARD_API_VERSION) {
    throw new ContractValidationError(`${label}.apiVersion is incompatible`);
  }
  return item;
}

export function shapeIdentifier(value: unknown, label: string, options: ShapeParserOptions): string {
  return options.identifiers === "string"
    ? stringValue(value, label)
    : identifier(
        value,
        label,
        options.identifierMessages === "valid-identifier"
          ? `${label} must be a valid identifier`
          : `${label} is invalid`,
        options.scalarMessages
      );
}

function nullableIdentifier(value: unknown, label: string, options: ShapeParserOptions): string | null {
  return value === null ? null : shapeIdentifier(value, label, options);
}

export function entityTimestamp(value: unknown, label: string, options: ShapeParserOptions): string {
  return timestamp(value, label, `${label} must be a timestamp`, false, options.scalarMessages);
}

function nullableTimestamp(value: unknown, label: string, options: ShapeParserOptions): string | null {
  return value === null ? null : entityTimestamp(value, label, options);
}

export function entityMember<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
  options: ShapeParserOptions,
  message: string | undefined,
  tolerateUnknown: true
): Values[number] | "unrecognized";
export function entityMember<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
  options: ShapeParserOptions,
  message?: string,
  tolerateUnknown?: false
): Values[number];
export function entityMember<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
  options: ShapeParserOptions,
  message = `${label} has an unsupported value`,
  tolerateUnknown = false
): Values[number] | "unrecognized" {
  if (
    tolerateUnknown &&
    options.tolerantEnums === true &&
    options.projection === "browser" &&
    typeof value === "string" &&
    !(values as readonly string[]).includes(value)
  )
    return "unrecognized";
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

export function expectedMinutes(value: unknown, label: string, options: ExpectedMinutesOptions): number | null {
  if ((options.nullable && value === null) || (options.undefinedIsNull && value === undefined)) return null;
  if (options.scalarMessages !== undefined && (!Number.isSafeInteger(value) || Number(value) < 15)) {
    throw new ContractValidationError(options.scalarMessages.integerAtLeast(label, 15), options.code);
  }
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 15 ||
    Number(value) % 15 !== 0 ||
    (options.maximum !== undefined && Number(value) > options.maximum)
  ) {
    throw new ContractValidationError(options.message(label), options.code);
  }
  return Number(value);
}

/* —— Project and work-item entities —— */

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
  options: ShapeParserOptions = {}
): WorkItemProjectTarget {
  const item = record(value, label);
  const mode = stringValue(item.mode, `${label}.mode`);
  if (mode === "auto") {
    exact(item, ["mode"], label, {
      messages: {
        unexpected: () => `${label} has unsupported fields for automatic project selection`,
        missing: PATH_EXACT_MESSAGES.missing,
      },
    });
    return Object.freeze({ mode: "auto" });
  }
  if (mode === "explicit") {
    exact(item, ["mode", "projectId"], label, {
      messages: {
        unexpected: () => `${label} has unsupported fields for explicit project selection`,
        missing: PATH_EXACT_MESSAGES.missing,
      },
    });
    return Object.freeze({
      mode: "explicit",
      projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    });
  }
  throw new ContractValidationError(`${label}.mode has an unsupported value`);
}

export function parseWorkItemTransitionEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {}
): ParsedWorkItemTransition {
  const fields = ["fromState", "toState", "actorType", "actorId", "createdAt"];
  const item = shape(value, label, fields, fields, options);
  return Object.freeze({
    fromState:
      item.fromState === null ? null : entityMember(item.fromState, WORK_ITEM_STATES, `${label}.fromState`, options),
    toState: entityMember(item.toState, WORK_ITEM_STATES, `${label}.toState`, options),
    actorType: entityMember(item.actorType, ACTOR_TYPES, `${label}.actorType`, options),
    actorId: stringValue(item.actorId, `${label}.actorId`),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
  });
}

export function parseWorkItemEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>
): TolerantWorkItemEntity;
export function parseWorkItemEntity(value: unknown, label: string, options?: ShapeParserOptions): WorkItem;
export function parseWorkItemEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {}
): WorkItem | TolerantWorkItemEntity {
  const fields = [
    "apiVersion",
    "workItemId",
    "originalRequest",
    "refinedObjective",
    "priority",
    "taskType",
    "projectTarget",
    "resolvedProjectId",
    "parentWorkItemId",
    "phase",
    "childOrdinal",
    "planningTaskId",
    "pipelineBranch",
    "baseSha",
    "state",
    "currentStage",
    "stateSince",
    "reviewRound",
    "heartbeatAt",
    "createdBy",
    "version",
    "createdAt",
    "updatedAt",
    "endedAt",
    "cancelledReason",
    "archivedAt",
    "transitions",
  ];
  const optional = new Set([
    "transitions",
    "pipelineBranch",
    "baseSha",
    "stateSince",
    "reviewRound",
    "heartbeatAt",
    ...(options.projection === "browser" ? ["parentWorkItemId", "phase", "childOrdinal"] : []),
  ]);
  const required = fields.filter((field) => !optional.has(field));
  const item = entity(value, label, fields, required, options);
  const projectTarget = parseWorkItemProjectTargetEntity(item.projectTarget, `${label}.projectTarget`, options);
  const taskType =
    options.projection === "browser" && options.tolerantEnums === true
      ? stringValue(item.taskType, `${label}.taskType`)
      : entityMember(item.taskType, WORK_ITEM_TASK_TYPES, `${label}.taskType`, options);
  const resolvedProjectId = nullableIdentifier(item.resolvedProjectId, `${label}.resolvedProjectId`, options);
  const state = entityMember(item.state, WORK_ITEM_STATES, `${label}.state`, options, undefined, true);
  const phase =
    item.phase === undefined || item.phase === null
      ? null
      : entityMember(item.phase, WORK_ITEM_PHASES, `${label}.phase`, options, undefined, true);
  const endedAt = nullableTimestamp(item.endedAt, `${label}.endedAt`, options);
  const archivedAt = nullableTimestamp(item.archivedAt, `${label}.archivedAt`, options);
  const cancelledReason = nullableString(item.cancelledReason, `${label}.cancelledReason`);
  if (item.transitions !== undefined) {
    arrayOf(item.transitions, `${label}.transitions`, (entry, entryLabel) =>
      parseWorkItemTransitionEntity(entry, entryLabel, options)
    );
  }
  if (state !== "unrecognized") {
    const terminal = isTerminalWorkItemState(state);
    if (terminal !== (endedAt !== null)) throw new ContractValidationError(`${label}.endedAt does not match its state`);
    if (archivedAt !== null && !terminal)
      throw new ContractValidationError(`${label}.archivedAt requires a terminal state`);
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
    parentWorkItemId:
      item.parentWorkItemId === undefined
        ? null
        : nullableIdentifier(item.parentWorkItemId, `${label}.parentWorkItemId`, options),
    phase,
    childOrdinal:
      item.childOrdinal === undefined || item.childOrdinal === null
        ? null
        : integer(item.childOrdinal, `${label}.childOrdinal`),
    planningTaskId: nullableIdentifier(item.planningTaskId, `${label}.planningTaskId`, options),
    ...(item.pipelineBranch === undefined
      ? {}
      : { pipelineBranch: nullableString(item.pipelineBranch, `${label}.pipelineBranch`) }),
    ...(item.baseSha === undefined ? {} : { baseSha: nullableString(item.baseSha, `${label}.baseSha`) }),
    state,
    currentStage:
      item.currentStage === null
        ? null
        : entityMember(item.currentStage, WORK_ITEM_STAGES, `${label}.currentStage`, options),
    ...(item.stateSince === undefined
      ? {}
      : { stateSince: nullableTimestamp(item.stateSince, `${label}.stateSince`, options) }),
    ...(item.reviewRound === undefined
      ? {}
      : {
          reviewRound: item.reviewRound === null ? null : integer(item.reviewRound, `${label}.reviewRound`, 1),
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

/* —— Task, run, and message entities —— */

export function parseTaskPhaseEntity(value: unknown, label: string, options: ShapeParserOptions = {}): TaskPhase {
  const fields = [
    "apiVersion",
    "phaseId",
    "projectId",
    "taskId",
    "title",
    "stage",
    "status",
    "parallelGroup",
    "orderKey",
    "startedAt",
    "endedAt",
    "version",
    "createdAt",
    "updatedAt",
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

// Task-worker HTTP responses preserve their canonical timestamps and legacy error wording.
export function parseAgentTaskPhaseResponse(
  value: unknown,
  projectId: string,
  taskId: string,
  label: string
): TaskPhase {
  const item = exact(
    value,
    [
      "apiVersion",
      "phaseId",
      "projectId",
      "taskId",
      "title",
      "stage",
      "status",
      "parallelGroup",
      "orderKey",
      "startedAt",
      "endedAt",
      "version",
      "createdAt",
      "updatedAt",
    ],
    label
  );
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
    startedAt:
      item.startedAt === null
        ? null
        : timestamp(item.startedAt, `${label}.startedAt`, `${label}.startedAt is invalid`, true),
    endedAt:
      item.endedAt === null ? null : timestamp(item.endedAt, `${label}.endedAt`, `${label}.endedAt is invalid`, true),
    version: integer(item.version, `${label}.version`, 1, `${label}.version is invalid`),
    createdAt: timestamp(item.createdAt, `${label}.createdAt`, `${label}.createdAt is invalid`, true),
    updatedAt: timestamp(item.updatedAt, `${label}.updatedAt`, `${label}.updatedAt is invalid`, true),
  });
}

export function parseTaskEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>
): TolerantTaskEntity;
export function parseTaskEntity(value: unknown, label: string, options?: ShapeParserOptions): BoardTask;
export function parseTaskEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {}
): BoardTask | TolerantTaskEntity {
  const fields = [
    "apiVersion",
    "taskId",
    "projectId",
    "parentTaskId",
    "kind",
    "requiredRole",
    "requiresReview",
    "title",
    "objective",
    "acceptanceCriteria",
    "workspaceRefs",
    "status",
    "assignedAgentId",
    "assignedRole",
    "expectedAgentMinutes",
    "estimateRecordedAt",
    "orderKey",
    "phases",
    "startedAt",
    "expectedCompletedAt",
    "endedAt",
    "result",
    "version",
    "createdAt",
    "updatedAt",
  ];
  const required = fields.filter(
    (field) => field !== "estimateRecordedAt" && field !== "phases" && field !== "expectedAgentMinutes"
  );
  const item = entity(value, label, fields, required, options);
  const taskId = shapeIdentifier(item.taskId, `${label}.taskId`, options);
  const projectId = shapeIdentifier(item.projectId, `${label}.projectId`, options);
  const kind = entityMember(item.kind, TASK_KINDS, `${label}.kind`, options);
  const requiredRole =
    item.requiredRole === null ? null : entityMember(item.requiredRole, AGENT_ROLES, `${label}.requiredRole`, options);
  const assignedAgentId = nullableIdentifier(item.assignedAgentId, `${label}.assignedAgentId`, options);
  const assignedRole =
    item.assignedRole === null ? null : entityMember(item.assignedRole, AGENT_ROLES, `${label}.assignedRole`, options);
  if (kind === "manager_review" ? requiredRole !== "manager" : requiredRole !== null) {
    throw new ContractValidationError(`${label}.requiredRole does not match its task kind`);
  }
  if ((assignedAgentId === null) !== (assignedRole === null))
    throw new ContractValidationError(`${label} has an incomplete assignment`);
  if (requiredRole !== null && assignedRole !== null && assignedRole !== requiredRole) {
    throw new ContractValidationError(`${label}.assignedRole does not satisfy requiredRole`);
  }
  if (kind === "human_check" && assignedAgentId !== null)
    throw new ContractValidationError(`${label} human check cannot be assigned`);
  const phases =
    item.phases === undefined
      ? []
      : arrayOf(item.phases, `${label}.phases`, (phase, phaseLabel) =>
          parseTaskPhaseEntity(phase, phaseLabel, options)
        );
  if (phases.some((phase) => phase.taskId !== taskId || phase.projectId !== projectId)) {
    throw new ContractValidationError(`${label}.phases must belong to their containing task`);
  }
  const status = entityMember(item.status, TASK_STATUSES, `${label}.status`, options, undefined, true);
  const validatedExpectedCompletedAt = nullableTimestamp(
    item.expectedCompletedAt,
    `${label}.expectedCompletedAt`,
    options
  );
  const expectedCompletedAt =
    status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled"
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
    workspaceRefs: arrayOf(item.workspaceRefs, `${label}.workspaceRefs`, (entry, entryLabel) =>
      stringValue(entry, entryLabel)
    ),
    status,
    assignedAgentId,
    assignedRole,
    expectedAgentMinutes: expectedMinutes(item.expectedAgentMinutes, `${label}.expectedAgentMinutes`, {
      nullable: true,
      undefinedIsNull: options.projection === "browser",
      maximum: options.projection === "browser" ? undefined : 10_080,
      message: (field) =>
        options.projection === "browser"
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
    "apiVersion",
    "agentId",
    "projectId",
    "role",
    "area",
    "mission",
    "model",
    "status",
    "workerConnection",
    "lastError",
    "version",
    "createdAt",
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
    workerConnection:
      item.workerConnection === undefined || item.workerConnection === null
        ? null
        : entityMember(item.workerConnection, WORKER_CONNECTIONS, `${label}.workerConnection`, options),
    lastError:
      item.lastError === undefined || item.lastError === null
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
    "apiVersion",
    "questionId",
    "projectId",
    "taskId",
    "agentId",
    "runId",
    "question",
    "status",
    "answer",
    "askedAt",
    "answeredAt",
    "answeredBy",
    "version",
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
    "apiVersion",
    "runId",
    "claimId",
    "projectId",
    "agentId",
    "wakeupId",
    "taskId",
    "status",
    "startedAt",
    "heartbeatAt",
    "endedAt",
    "result",
    "runtime",
    "runtimeVersion",
    "model",
    "promptsSha",
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
    "apiVersion",
    "messageId",
    "sequence",
    "projectId",
    "taskId",
    "runId",
    "actorType",
    "actorId",
    "kind",
    "body",
    "createdAt",
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
  const fields = [
    "apiVersion",
    "eventId",
    "projectId",
    "taskId",
    "actorType",
    "actorId",
    "eventType",
    "data",
    "createdAt",
  ];
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
    "apiVersion",
    "sequence",
    "interruptId",
    "projectId",
    "agentId",
    "runId",
    "reason",
    "requestedBy",
    "requestedAt",
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

/* —— Plan results, reviews, board controls, and ledgers —— */

function parseCriterionResult(value: unknown, label: string, options: ShapeParserOptions): CriterionResult {
  const item = shape(value, label, ["criterion", "passed", "evidence"], ["criterion", "passed", "evidence"], options);
  return Object.freeze({
    criterion: stringValue(item.criterion, `${label}.criterion`),
    passed: booleanValue(item.passed, `${label}.passed`),
    evidence: stringValue(item.evidence, `${label}.evidence`),
  });
}

export const PLAN_RECORD_FIELD_NAMES = [
  "changeShape",
  "tier",
  "declaredScope",
  "nonGoals",
  "mechanicalPortions",
  "blockingQuestions",
  "criterionChecks",
] as const;

export function boundedPlanArray<T>(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  parse: (entry: unknown, entryLabel: string) => T
): readonly T[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new ContractValidationError(`${label} is invalid`);
  }
  return Object.freeze(value.map((entry, index) => parse(entry, `${label}[${index}]`)));
}

function planRecordText(value: unknown, label: string, maximum: number): string {
  return prose(value, label, { maximum, message: `${label} is invalid` });
}

export function planScopeEntry(
  value: unknown,
  label: string,
  parseText: (value: unknown, label: string, maximum: number) => string
): string {
  const entry = parseText(value, label, 256);
  if (entry.startsWith("/") || entry.includes("..")) throw new ContractValidationError(`${label} is invalid`);
  return entry;
}

export function planCheck(
  value: unknown,
  label: string,
  parseText: (value: unknown, label: string, maximum: number) => string
): string {
  const check = parseText(value, label, 512);
  if (/[\u0000-\u001f\u007f]/u.test(check)) throw new ContractValidationError(`${label} is invalid`);
  return check;
}

const REVIEW_FINDING_DRAFT_FIELDS = ["file", "line", "category", "severity", "expected", "actual"] as const;
const REVIEW_FINDING_DRAFT_REQUIRED_FIELDS = ["category", "severity", "expected", "actual"] as const;

function boundedRecordText(value: unknown, label: string, maximum: number): string {
  return text(value, label, { maximum, trim: false, message: `${label} is invalid` });
}

export function reviewFindingFile(value: unknown, label: string): string {
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
  allowEmpty = false
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
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>
): TolerantParkRecord;
export function parseParkRecord(value: unknown, label: string, options?: ShapeParserOptions): ParkRecord;
export function parseParkRecord(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {}
): ParkRecord | TolerantParkRecord {
  const fields = ["parkRecordId", "workItemId", "category", "reason", "parkedAt", "resolvedAt", "resolution"];
  const item = shape(value, label, fields, fields, options);
  const tolerateUnknown = options.projection === "browser" && options.tolerantEnums === true;
  const category = tolerateUnknown
    ? entityMember(item.category, PARK_CATEGORIES, `${label}.category`, options, undefined, true)
    : entityMember(item.category, PARK_CATEGORIES, `${label}.category`, options);
  const resolution =
    item.resolution === null
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

export function parseBoardPause(value: unknown, label: string, options: ShapeParserOptions = {}): BoardPause {
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
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>
): TolerantBoardNotification;
export function parseBoardNotification(value: unknown, label: string, options?: ShapeParserOptions): BoardNotification;
export function parseBoardNotification(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {}
): BoardNotification | TolerantBoardNotification {
  const fields = [
    "notificationId",
    "sequence",
    "kind",
    "dedupeKey",
    "projectId",
    "workItemId",
    "summary",
    "createdAt",
    "readAt",
    "version",
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
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>
): TolerantGateAction;
export function parseGateAction(value: unknown, label: string, options?: ShapeParserOptions): GateAction;
export function parseGateAction(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {}
): GateAction | TolerantGateAction {
  const fields = [
    "gateActionId",
    "workItemId",
    "gate",
    "actorId",
    "planRevisionId",
    "verifiedSha",
    "mergeSha",
    "refId",
    "note",
    "createdAt",
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
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>
): TolerantWorkItemAudit;
export function parseWorkItemAudit(value: unknown, label: string, options?: ShapeParserOptions): WorkItemAudit;
export function parseWorkItemAudit(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {}
): WorkItemAudit | TolerantWorkItemAudit {
  const fields = ["gateActions", "transitions"];
  const item = shape(value, label, fields, fields, options);
  const gateActions = arrayOf(item.gateActions, `${label}.gateActions`, (entry, entryLabel) =>
    parseGateAction(entry, entryLabel, options)
  );
  const transitions = arrayOf(item.transitions, `${label}.transitions`, (entry, entryLabel) =>
    parseWorkItemTransitionEntity(entry, entryLabel, options)
  );
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
  textMaximum = 2_000
):
  | ReviewFindingDraft
  | Omit<TolerantReviewFindingEntity, "findingId" | "nodeId" | "stage" | "round" | "blocking" | "createdAt"> {
  const category = tolerateUnknown
    ? entityMember(item.category, REVIEW_FINDING_CATEGORIES, `${label}.category`, options, undefined, true)
    : entityMember(item.category, REVIEW_FINDING_CATEGORIES, `${label}.category`, options);
  const severity = tolerateUnknown
    ? entityMember(item.severity, REVIEW_FINDING_SEVERITIES, `${label}.severity`, options, undefined, true)
    : entityMember(item.severity, REVIEW_FINDING_SEVERITIES, `${label}.severity`, options);
  return Object.freeze({
    ...(item.file === undefined
      ? {}
      : {
          file: item.file === null ? null : reviewFindingFile(item.file, `${label}.file`),
        }),
    ...(item.line === undefined
      ? {}
      : {
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
    REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH
  ) as ReviewFindingDraft;
}

export function parseReviewFindingDraftList(value: unknown, label: string): readonly ReviewFindingDraft[] {
  if (!Array.isArray(value) || value.length > REVIEW_FINDING_DRAFT_MAX_ITEMS) {
    throw new ContractValidationError(
      `${label} must be an array with at most ${REVIEW_FINDING_DRAFT_MAX_ITEMS} entries`
    );
  }
  return Object.freeze(value.map((entry) => parseReviewFindingDraft(entry)));
}

export function parseReviewFindingEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>
): TolerantReviewFindingEntity;
export function parseReviewFindingEntity(value: unknown, label: string, options?: ShapeParserOptions): ReviewFinding;
export function parseReviewFindingEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {}
): ReviewFinding | TolerantReviewFindingEntity {
  const required = [
    "findingId",
    "nodeId",
    "stage",
    "round",
    ...REVIEW_FINDING_DRAFT_REQUIRED_FIELDS,
    "blocking",
    "createdAt",
  ];
  const item = shape(
    value,
    label,
    ["findingId", "nodeId", "stage", "round", ...REVIEW_FINDING_DRAFT_FIELDS, "blocking", "createdAt"],
    required,
    options
  );
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
  parser: (entry: unknown, entryLabel: string) => T
): readonly T[] {
  if (!Array.isArray(value) || (maximum !== null && value.length > maximum)) {
    const bound = maximum === null ? "an array" : `an array with at most ${maximum} entries`;
    throw new ContractValidationError(`${label} must be ${bound}`);
  }
  return Object.freeze(value.map((entry, index) => parser(entry, `${label}[${index}]`)));
}

function parseLedgerFinding(value: unknown, label: string, options: ShapeParserOptions): ParsedLedgerFinding {
  const fields = [
    "findingId",
    "nodeId",
    "stage",
    "round",
    ...REVIEW_FINDING_DRAFT_FIELDS,
    "blocking",
    "createdAt",
    "workItemId",
  ];
  const required = [
    "findingId",
    "nodeId",
    "stage",
    "round",
    ...REVIEW_FINDING_DRAFT_REQUIRED_FIELDS,
    "blocking",
    "createdAt",
    "workItemId",
  ];
  const item = shape(value, label, fields, required, options);
  const finding = parseReviewFindingEntity(
    {
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
    },
    label,
    options
  ) as ReviewFinding | TolerantReviewFindingEntity;
  return Object.freeze({
    ...finding,
    workItemId: shapeIdentifier(item.workItemId, `${label}.workItemId`, options),
  });
}

function parseLedgerPark(
  value: unknown,
  label: string,
  options: ShapeParserOptions,
  expectedState: "open" | "resolved"
): ParsedLedgerPark {
  const fields = [
    "parkRecordId",
    "workItemId",
    "category",
    "reason",
    "parkedAt",
    "resolvedAt",
    "resolution",
    "workItemTitle",
  ];
  const item = shape(value, label, fields, fields, options);
  const park = parseParkRecord(
    {
      parkRecordId: item.parkRecordId,
      workItemId: item.workItemId,
      category: item.category,
      reason: item.reason,
      parkedAt: item.parkedAt,
      resolvedAt: item.resolvedAt,
      resolution: item.resolution,
    },
    label,
    options
  ) as ParkRecord | TolerantParkRecord;
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
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>
): TolerantFindingsLedger;
export function parseFindingsLedger(value: unknown, label: string, options?: ShapeParserOptions): FindingsLedger;
export function parseFindingsLedger(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {}
): FindingsLedger | TolerantFindingsLedger {
  const fields = ["categories", "perProject", "recent"];
  const item = shape(value, label, fields, fields, options);
  const tolerateUnknown = options.projection === "browser" && options.tolerantEnums === true;
  const categories = boundedLedgerArray(item.categories, `${label}.categories`, null, (entry, entryLabel) => {
    const aggregate = shape(
      entry,
      entryLabel,
      ["category", "severity", "blocking", "count"],
      ["category", "severity", "blocking", "count"],
      options
    );
    return Object.freeze({
      category: tolerateUnknown
        ? entityMember(
            aggregate.category,
            REVIEW_FINDING_CATEGORIES,
            `${entryLabel}.category`,
            options,
            undefined,
            true
          )
        : entityMember(aggregate.category, REVIEW_FINDING_CATEGORIES, `${entryLabel}.category`, options),
      severity: tolerateUnknown
        ? entityMember(
            aggregate.severity,
            REVIEW_FINDING_SEVERITIES,
            `${entryLabel}.severity`,
            options,
            undefined,
            true
          )
        : entityMember(aggregate.severity, REVIEW_FINDING_SEVERITIES, `${entryLabel}.severity`, options),
      blocking: booleanValue(aggregate.blocking, `${entryLabel}.blocking`),
      count: integer(aggregate.count, `${entryLabel}.count`, 1),
    });
  });
  const perProject = boundedLedgerArray(item.perProject, `${label}.perProject`, null, (entry, entryLabel) => {
    const aggregate = shape(
      entry,
      entryLabel,
      ["projectId", "category", "count"],
      ["projectId", "category", "count"],
      options
    );
    return Object.freeze({
      projectId: shapeIdentifier(aggregate.projectId, `${entryLabel}.projectId`, options),
      category: tolerateUnknown
        ? entityMember(
            aggregate.category,
            REVIEW_FINDING_CATEGORIES,
            `${entryLabel}.category`,
            options,
            undefined,
            true
          )
        : entityMember(aggregate.category, REVIEW_FINDING_CATEGORIES, `${entryLabel}.category`, options),
      count: integer(aggregate.count, `${entryLabel}.count`, 1),
    });
  });
  const recent = boundedLedgerArray(item.recent, `${label}.recent`, 50, (entry, entryLabel) =>
    parseLedgerFinding(entry, entryLabel, options)
  );
  return Object.freeze({ categories, perProject, recent }) as FindingsLedger | TolerantFindingsLedger;
}

export function parseParksLedger(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>
): TolerantParksLedger;
export function parseParksLedger(value: unknown, label: string, options?: ShapeParserOptions): ParksLedger;
export function parseParksLedger(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {}
): ParksLedger | TolerantParksLedger {
  const fields = ["open", "resolved", "recordsSince"];
  const item = shape(value, label, fields, fields, options);
  const open = boundedLedgerArray(item.open, `${label}.open`, null, (entry, entryLabel) =>
    parseLedgerPark(entry, entryLabel, options, "open")
  );
  const resolved = boundedLedgerArray(item.resolved, `${label}.resolved`, 100, (entry, entryLabel) =>
    parseLedgerPark(entry, entryLabel, options, "resolved")
  );
  return Object.freeze({
    open,
    resolved,
    recordsSince: ledgerRecordsSince(item.recordsSince, `${label}.recordsSince`),
  }) as ParksLedger | TolerantParksLedger;
}

/* —— Design and plan entities —— */

const DESIGN_RECORD_FIELDS = [
  "states",
  "transitions",
  "failurePoints",
  "idempotencyKeys",
  "faultInjectionCases",
] as const;

function parseDesignRecordFields(
  item: JsonRecord,
  label: string,
  options: ShapeParserOptions,
  tolerateUnknown: boolean
): Omit<TolerantDesignRecordEntity, "designRecordId" | "workItemId" | "planRevisionId" | "createdAt"> {
  const states = boundedPlanArray(item.states, `${label}.states`, 1, DESIGN_RECORD_MAX_STATES, (entry, entryLabel) =>
    boundedRecordText(entry, entryLabel, DESIGN_RECORD_LABEL_MAX_LENGTH)
  );
  const transitions = boundedPlanArray(
    item.transitions,
    `${label}.transitions`,
    1,
    DESIGN_RECORD_MAX_TRANSITIONS,
    (entry, entryLabel) => {
      const transition = shape(
        entry,
        entryLabel,
        ["from", "to", "durablePrecondition", "recovery"],
        ["from", "to"],
        options
      );
      return Object.freeze({
        from: boundedRecordText(transition.from, `${entryLabel}.from`, DESIGN_RECORD_LABEL_MAX_LENGTH),
        to: boundedRecordText(transition.to, `${entryLabel}.to`, DESIGN_RECORD_LABEL_MAX_LENGTH),
        ...(transition.durablePrecondition === undefined
          ? {}
          : {
              durablePrecondition: boundedRecordText(
                transition.durablePrecondition,
                `${entryLabel}.durablePrecondition`,
                DESIGN_RECORD_DETAIL_MAX_LENGTH
              ),
            }),
        ...(transition.recovery === undefined
          ? {}
          : {
              recovery: boundedRecordText(
                transition.recovery,
                `${entryLabel}.recovery`,
                DESIGN_RECORD_DETAIL_MAX_LENGTH
              ),
            }),
      });
    }
  );
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
        options
      );
      const point = tolerateUnknown
        ? entityMember(failurePoint.point, DESIGN_FAILURE_POINTS, `${entryLabel}.point`, options, undefined, true)
        : entityMember(failurePoint.point, DESIGN_FAILURE_POINTS, `${entryLabel}.point`, options);
      return Object.freeze({
        point,
        resultingState: boundedRecordText(
          failurePoint.resultingState,
          `${entryLabel}.resultingState`,
          DESIGN_RECORD_DETAIL_MAX_LENGTH
        ),
        recovery: boundedRecordText(failurePoint.recovery, `${entryLabel}.recovery`, DESIGN_RECORD_DETAIL_MAX_LENGTH),
      });
    }
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
        options
      );
      return Object.freeze({
        name: boundedRecordText(key.name, `${entryLabel}.name`, DESIGN_RECORD_LABEL_MAX_LENGTH),
        generatedAt: boundedRecordText(key.generatedAt, `${entryLabel}.generatedAt`, DESIGN_RECORD_DETAIL_MAX_LENGTH),
        persistedAt: boundedRecordText(key.persistedAt, `${entryLabel}.persistedAt`, DESIGN_RECORD_DETAIL_MAX_LENGTH),
        reuse: boundedRecordText(key.reuse, `${entryLabel}.reuse`, DESIGN_RECORD_DETAIL_MAX_LENGTH),
      });
    }
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
        options
      );
      return Object.freeze({
        name: boundedRecordText(faultCase.name, `${entryLabel}.name`, DESIGN_RECORD_LABEL_MAX_LENGTH),
        scenario: boundedRecordText(faultCase.scenario, `${entryLabel}.scenario`, DESIGN_RECORD_DETAIL_MAX_LENGTH),
        expectation: boundedRecordText(
          faultCase.expectation,
          `${entryLabel}.expectation`,
          DESIGN_RECORD_DETAIL_MAX_LENGTH
        ),
      });
    }
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
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>
): TolerantDesignRecordEntity;
export function parseDesignRecordEntity(value: unknown, label: string, options?: ShapeParserOptions): DesignRecord;
export function parseDesignRecordEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {}
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

function parsePlanRecordEntity(item: JsonRecord, label: string, options: ShapeParserOptions): PlanRecordFields {
  return Object.freeze({
    ...(item.changeShape === undefined
      ? {}
      : {
          changeShape: entityMember(item.changeShape, PLAN_CHANGE_SHAPES, `${label}.changeShape`, options),
        }),
    ...(item.tier === undefined
      ? {}
      : {
          tier: entityMember(item.tier, PLAN_TIERS, `${label}.tier`, options),
        }),
    ...(item.declaredScope === undefined
      ? {}
      : {
          declaredScope: boundedPlanArray(item.declaredScope, `${label}.declaredScope`, 1, 64, (entry, entryLabel) =>
            planScopeEntry(entry, entryLabel, planRecordText)
          ),
        }),
    ...(item.nonGoals === undefined
      ? {}
      : {
          nonGoals: boundedPlanArray(item.nonGoals, `${label}.nonGoals`, 0, 32, (entry, entryLabel) =>
            planRecordText(entry, entryLabel, 1_000)
          ),
        }),
    ...(item.mechanicalPortions === undefined
      ? {}
      : {
          mechanicalPortions: boundedPlanArray(
            item.mechanicalPortions,
            `${label}.mechanicalPortions`,
            0,
            32,
            (entry, entryLabel) => planRecordText(entry, entryLabel, 1_000)
          ),
        }),
    ...(item.blockingQuestions === undefined
      ? {}
      : {
          blockingQuestions: boundedPlanArray(
            item.blockingQuestions,
            `${label}.blockingQuestions`,
            0,
            16,
            (entry, entryLabel) => {
              const question = shape(
                entry,
                entryLabel,
                ["question", "recommendedDefault"],
                ["question", "recommendedDefault"],
                options
              );
              return Object.freeze({
                question: planRecordText(question.question, `${entryLabel}.question`, 1_000),
                recommendedDefault: planRecordText(
                  question.recommendedDefault,
                  `${entryLabel}.recommendedDefault`,
                  1_000
                ),
              });
            }
          ),
        }),
    ...(item.criterionChecks === undefined
      ? {}
      : {
          criterionChecks: boundedPlanArray(
            item.criterionChecks,
            `${label}.criterionChecks`,
            0,
            32,
            (entry, entryLabel) => {
              const criterion = shape(entry, entryLabel, ["criterion", "check"], ["criterion", "check"], options);
              return Object.freeze({
                criterion: planRecordText(criterion.criterion, `${entryLabel}.criterion`, 1_000),
                check: planCheck(criterion.check, `${entryLabel}.check`, planRecordText),
              });
            }
          ),
        }),
  });
}

function parseDeclaredChildEntity(value: unknown, label: string, options: ShapeParserOptions): TolerantDeclaredChild {
  const required = ["key", "objective", "projectId", "declaredScope", "acceptanceCriteria"];
  const item = shape(value, label, [...required, "phase", "dependsOn", "splitBy"], required, options);
  return Object.freeze({
    key: shapeIdentifier(item.key, `${label}.key`, options),
    objective: planRecordText(item.objective, `${label}.objective`, 4_000),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    declaredScope: boundedPlanArray(item.declaredScope, `${label}.declaredScope`, 1, 64, (entry, entryLabel) =>
      planScopeEntry(entry, entryLabel, planRecordText)
    ),
    acceptanceCriteria: boundedPlanArray(
      item.acceptanceCriteria,
      `${label}.acceptanceCriteria`,
      1,
      64,
      (entry, entryLabel) => planRecordText(entry, entryLabel, 2_000)
    ),
    ...(item.phase === undefined
      ? {}
      : {
          phase: entityMember(item.phase, WORK_ITEM_PHASES, `${label}.phase`, options, undefined, true),
        }),
    ...(item.dependsOn === undefined
      ? {}
      : {
          dependsOn: boundedPlanArray(item.dependsOn, `${label}.dependsOn`, 0, 64, (entry, entryLabel) =>
            shapeIdentifier(entry, entryLabel, options)
          ),
        }),
    ...(item.splitBy === undefined
      ? {}
      : {
          splitBy: entityMember(item.splitBy, ["consumer", "phase"] as const, `${label}.splitBy`, options),
        }),
  });
}

export function parsePlanEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions & Readonly<{ projection: "browser"; tolerantEnums: true }>
): TolerantPlanRevision;
export function parsePlanEntity(value: unknown, label: string, options?: ShapeParserOptions): PlanRevision;
export function parsePlanEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {}
): PlanRevision | TolerantPlanRevision {
  const coreRequired = [
    "apiVersion",
    "planRevisionId",
    "workItemId",
    "revision",
    "objective",
    "assumptions",
    "acceptanceCriteria",
    "projectId",
    "skillDigests",
    "state",
    "createdBy",
    "confirmedBy",
    "createdAt",
    "confirmedAt",
  ];
  const required = [...coreRequired, ...(options.projection === "browser" ? [] : ["children"])];
  const fields = [...coreRequired, ...PLAN_RECORD_FIELD_NAMES, "children", "rejectedNote"];
  const item = entity(value, label, fields, required, options);
  const digests = record(item.skillDigests, `${label}.skillDigests`);
  const skillDigests: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, digest] of Object.entries(digests))
    skillDigests[key] = stringValue(digest, `${label}.skillDigests.${key}`);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    planRevisionId: shapeIdentifier(item.planRevisionId, `${label}.planRevisionId`, options),
    workItemId: shapeIdentifier(item.workItemId, `${label}.workItemId`, options),
    revision: integer(item.revision, `${label}.revision`, 1),
    objective: stringValue(item.objective, `${label}.objective`),
    assumptions: Object.freeze(arrayOf(item.assumptions, `${label}.assumptions`, stringValue)),
    acceptanceCriteria: Object.freeze(arrayOf(item.acceptanceCriteria, `${label}.acceptanceCriteria`, stringValue)),
    ...parsePlanRecordEntity(item, label, options),
    children:
      item.children === undefined || item.children === null
        ? null
        : boundedPlanArray(item.children, `${label}.children`, 0, 64, (entry, entryLabel) =>
            parseDeclaredChildEntity(entry, entryLabel, options)
          ),
    projectId: shapeIdentifier(item.projectId, `${label}.projectId`, options),
    skillDigests: Object.freeze(skillDigests),
    state: entityMember(item.state, PLAN_REVISION_STATES, `${label}.state`, options),
    createdBy: shapeIdentifier(item.createdBy, `${label}.createdBy`, options),
    confirmedBy: nullableIdentifier(item.confirmedBy, `${label}.confirmedBy`, options),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    confirmedAt: nullableTimestamp(item.confirmedAt, `${label}.confirmedAt`, options),
    ...(item.rejectedNote === undefined
      ? {}
      : { rejectedNote: stringValue(item.rejectedNote, `${label}.rejectedNote`) }),
  });
}

/* —— Pipeline evidence and artifacts —— */

const VERIFY_ATTEMPT_STATES = ["starting", "running", "green", "failed", "died", "failed_to_start", "retired"] as const;
function parseVerifyAttemptEntity(value: unknown, label: string, options: ShapeParserOptions = {}): VerifyAttempt {
  const fields = [
    "verifyAttemptId",
    "nodeId",
    "stage",
    "attempt",
    "verifyRunId",
    "workspacePath",
    "state",
    "checkResults",
    "detail",
    "createdAt",
    "endedAt",
  ];
  const item = shape(value, label, fields, fields, options);
  let checkResults: VerifyAttempt["checkResults"] = null;
  if (item.checkResults !== null) {
    if (!Array.isArray(item.checkResults) || item.checkResults.length > 32) {
      throw new ContractValidationError(`${label}.checkResults is invalid`);
    }
    checkResults = Object.freeze(
      item.checkResults.map((entry, index) => {
        const resultLabel = `${label}.checkResults[${index}]`;
        const result = shape(
          entry,
          resultLabel,
          ["criterion", "check", "passed"],
          ["criterion", "check", "passed"],
          options
        );
        return Object.freeze({
          criterion: stringValue(result.criterion, `${resultLabel}.criterion`),
          check: stringValue(result.check, `${resultLabel}.check`),
          passed: booleanValue(result.passed, `${resultLabel}.passed`),
        });
      })
    );
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
  options: ShapeParserOptions = {}
): PipelineSummary {
  const fields = [
    "commits",
    "diffstat",
    "filesTouched",
    "declaredScope",
    "scopeOk",
    "assumptions",
    "midRunAssumptions",
    "verify",
    "criteria",
    "criterionChecks",
    "findings",
    "designRecord",
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
    }
  );
  const tolerateUnknown = options.projection === "browser" && options.tolerantEnums === true;
  const findings = Object.freeze(
    boundedPlanArray(
      item.findings,
      `${label}.findings`,
      0,
      10_000,
      (entry, entryLabel) => parseReviewFindingEntity(entry, entryLabel, options) as ReviewFinding
    )
  );
  let designRecord: DesignRecordDraft | null = null;
  if (item.designRecord !== null) {
    const designItem = shape(
      item.designRecord,
      `${label}.designRecord`,
      DESIGN_RECORD_FIELDS,
      DESIGN_RECORD_FIELDS,
      options
    );
    designRecord = parseDesignRecordFields(
      designItem,
      `${label}.designRecord`,
      options,
      tolerateUnknown
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
    verify: boundedPlanArray(item.verify, `${label}.verify`, 0, 256, (entry, entryLabel) =>
      parseVerifyAttemptEntity(entry, entryLabel, options)
    ),
    criteria: stringList(item.criteria, `${label}.criteria`, 64),
    criterionChecks,
    findings,
    designRecord,
  });
}

export function parseNodeEntity(value: unknown, label: string, options: ShapeParserOptions = {}): WorkNode {
  const fields = [
    "apiVersion",
    "nodeId",
    "planRevisionId",
    "projectId",
    "title",
    "objective",
    "acceptanceCriteria",
    "dependencyNodeIds",
    "stageTemplate",
    "currentStage",
    "state",
    "version",
    "createdAt",
    "updatedAt",
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
    dependencyNodeIds: Object.freeze(
      arrayOf(item.dependencyNodeIds, `${label}.dependencyNodeIds`, (entry, entryLabel) =>
        shapeIdentifier(entry, entryLabel, options)
      )
    ),
    stageTemplate: Object.freeze(
      arrayOf(item.stageTemplate, `${label}.stageTemplate`, (stage, stageLabel) =>
        entityMember(stage, WORKFLOW_STAGES, stageLabel, options)
      )
    ),
    currentStage:
      item.currentStage === null
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
    "apiVersion",
    "handoffId",
    "nodeId",
    "taskId",
    "stage",
    "outcome",
    "summary",
    "evidence",
    "artifactIds",
    "acceptanceCriteria",
    "blockers",
    "recommendedReturnStage",
    "createdAt",
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
    artifactIds: Object.freeze(
      arrayOf(item.artifactIds, `${label}.artifactIds`, (entry, entryLabel) =>
        shapeIdentifier(entry, entryLabel, options)
      )
    ),
    acceptanceCriteria: Object.freeze(
      arrayOf(item.acceptanceCriteria, `${label}.acceptanceCriteria`, (criterion, criterionLabel) =>
        parseCriterionResult(criterion, criterionLabel, options)
      )
    ),
    blockers: Object.freeze(arrayOf(item.blockers, `${label}.blockers`, stringValue)),
    recommendedReturnStage:
      item.recommendedReturnStage === null
        ? null
        : entityMember(item.recommendedReturnStage, WORKFLOW_STAGES, `${label}.recommendedReturnStage`, options),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
  });
}

export function parseProjectEventEntity(value: unknown, label: string, options: ShapeParserOptions = {}): ProjectEvent {
  const fields = [
    "apiVersion",
    "sequence",
    "eventId",
    "projectId",
    "nodeId",
    "taskId",
    "eventType",
    "summary",
    "createdAt",
  ];
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

export function parseProjectArtifactEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {}
): ProjectArtifact {
  const fields = [
    "apiVersion",
    "artifactId",
    "projectId",
    "nodeId",
    "taskId",
    "mediaType",
    "byteSize",
    "digest",
    "caption",
    "createdBy",
    "createdAt",
  ];
  const item = entity(value, label, fields, fields, options);
  const digest = stringValue(item.digest, `${label}.digest`);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest))
    throw new ContractValidationError(`${label}.digest must be a SHA-256 digest`);
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

export function projectAgentTaskPhase(value: unknown, projectId: string, taskId: string, label: string) {
  const item = parseAgentTaskPhaseResponse(value, projectId, taskId, label);
  return Object.freeze({
    phaseId: item.phaseId,
    title: boundedClaimText(item.title, `${label}.title`, 240),
    stage: item.stage,
    status: item.status,
    parallelGroup: item.parallelGroup,
    orderKey: item.orderKey,
    version: item.version,
  });
}
