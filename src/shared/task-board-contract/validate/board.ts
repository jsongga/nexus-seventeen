/** Validates the board's automation configuration and the snapshots it answers with. */

/* —— Imports —— */

import {
  AGENT_ROLES,
  AUTOMATION_STAGE_ALLOWED_ROLES,
  type AutomationAgentType,
  type AutomationConfiguration,
  type AutomationPipelineStage,
  type AutomationStageExecutor,
  type BoardSnapshot,
  type ClaimRunPausedResult,
  type ClaimRunResult,
  ContractValidationError,
  EVALUATOR_PROFILES,
  TASK_BOARD_API_VERSION,
  WAKEUP_REASONS,
  WORK_ITEM_PHASES,
  WORK_ITEM_STAGES,
} from "../index.js";
import {
  type ShapeParserOptions,
  entity,
  entityMember,
  entityTimestamp,
  parseAgentEntity,
  parseEventEntity,
  parseInterruptEntity,
  parseProjectEntity,
  parseQuestionEntity,
  parseRunEntity,
  parseTaskEntity,
  shape,
  shapeIdentifier,
} from "./entities.js";
import {
  type ScalarMessageProfile,
  arrayOf,
  booleanValue,
  contractMember,
  exact,
  identifier,
  integer,
  prose,
  record,
  stringValue,
  timestamp,
} from "./scalars.js";
import { parseBoardProjectContexts, parseCrossRepoContext, parseWorkflowPipelineFields } from "./worker.js";

/* —— Automation configuration —— */

export function skillIdentifier(value: unknown, label: string, scalarMessages?: ScalarMessageProfile): string {
  if (typeof value !== "string") {
    throw new ContractValidationError(
      scalarMessages?.stringType(label) ?? `${label} must be a lowercase skill identifier, not a URL or path`
    );
  }
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)) {
    throw new ContractValidationError(`${label} must be a lowercase skill identifier, not a URL or path`);
  }
  return value;
}

export function parseAutomationAgentTypeEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {}
): AutomationAgentType {
  const fields = [
    "agentTypeId",
    "name",
    "description",
    "role",
    "supplementalInstructions",
    "skillIds",
    "evaluatorProfile",
    "enabled",
  ];
  const item = shape(value, label, fields, fields, options);
  const skillIds = arrayOf(item.skillIds, `${label}.skillIds`, (entry, entryLabel) =>
    skillIdentifier(entry, entryLabel, options.scalarMessages)
  );
  if (skillIds.length > 32) throw new ContractValidationError(`${label}.skillIds cannot contain more than 32 entries`);
  if (new Set(skillIds).size !== skillIds.length)
    throw new ContractValidationError(`${label}.skillIds cannot contain duplicates`);
  const supplementalInstructions = prose(item.supplementalInstructions, `${label}.supplementalInstructions`, {
    maximum: 8_000,
    allowEmpty: true,
    message: `${label}.supplementalInstructions must contain at most 8,000 characters`,
    scalarMessages: options.scalarMessages,
  });
  const enabled = booleanValue(item.enabled, `${label}.enabled`);
  if (enabled && supplementalInstructions.trim().length === 0) {
    throw new ContractValidationError(
      `${label}.supplementalInstructions cannot be empty while the agent type is enabled`
    );
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
  options: ShapeParserOptions = {}
): AutomationStageExecutor {
  const item = record(value, label);
  const kind = stringValue(item.kind, `${label}.kind`);
  if (kind === "agent_type") {
    const parsed = shape(item, label, ["kind", "agentTypeId"], ["kind", "agentTypeId"], options);
    return Object.freeze({
      kind: "agent_type",
      agentTypeId: shapeIdentifier(parsed.agentTypeId, `${label}.agentTypeId`, options),
    });
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
  options: ShapeParserOptions = {}
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
  label: string
): void {
  if (agentTypes.length > 32)
    throw new ContractValidationError(`${label}.agentTypes cannot contain more than 32 entries`);
  const typesById = new Map<string, AutomationAgentType>();
  for (const agentType of agentTypes) {
    if (typesById.has(agentType.agentTypeId))
      throw new ContractValidationError(`${label}.agentTypes cannot contain duplicate IDs`);
    typesById.set(agentType.agentTypeId, agentType);
  }
  if (stages.length !== WORK_ITEM_STAGES.length) {
    throw new ContractValidationError(`${label}.stages must contain every automation stage exactly once`);
  }
  stages.forEach((entry, index) => {
    const expectedStage = WORK_ITEM_STAGES[index];
    if (entry.stage !== expectedStage)
      throw new ContractValidationError(`${label}.stages must use the canonical automation stage order`);
    if (entry.executor.kind === "machine_verify" && entry.stage !== "testing") {
      throw new ContractValidationError(`${label}.stages ${entry.stage} cannot use the machine_verify executor`);
    }
    if (entry.stage === "human_review") {
      if (entry.executor.kind !== "human")
        throw new ContractValidationError(`${label}.stages human_review must be owned by a human`);
      return;
    }
    if (entry.stage === "deployment") {
      if (entry.executor.kind !== "disabled")
        throw new ContractValidationError(`${label}.stages deployment must remain disabled`);
      return;
    }
    if (entry.executor.kind === "human")
      throw new ContractValidationError(`${label}.stages ${entry.stage} cannot use a human executor`);
    if (entry.executor.kind !== "agent_type") return;
    const agentType = typesById.get(entry.executor.agentTypeId);
    if (agentType === undefined)
      throw new ContractValidationError(`${label}.stages ${entry.stage} references an unknown agent type`);
    if (!agentType.enabled)
      throw new ContractValidationError(`${label}.stages ${entry.stage} references a disabled agent type`);
    const roles: readonly (typeof AGENT_ROLES)[number][] = AUTOMATION_STAGE_ALLOWED_ROLES[entry.stage];
    if (!roles.includes(agentType.role)) {
      const rolesLabel = roles.join(" or ");
      throw new ContractValidationError(
        `${label}.stages ${entry.stage} requires ${rolesLabel.startsWith("engineer") ? "an" : "a"} ${rolesLabel} agent type`
      );
    }
  });
}

export function automationConfigurationPartsBytes(
  agentTypes: readonly AutomationAgentType[],
  stages: readonly AutomationPipelineStage[]
): number {
  return new TextEncoder().encode(JSON.stringify({ agentTypes, stages })).byteLength;
}

export function parseAutomationConfigurationEntity(
  value: unknown,
  label: string,
  options: ShapeParserOptions = {}
): AutomationConfiguration {
  const fields = [
    "apiVersion",
    "configurationId",
    "agentTypes",
    "stages",
    "version",
    "createdAt",
    "updatedAt",
    "updatedBy",
  ];
  const item = entity(value, label, fields, fields, options);
  if (item.configurationId !== "company-default")
    throw new ContractValidationError(`${label}.configurationId is unsupported`);
  const agentTypes = arrayOf(item.agentTypes, `${label}.agentTypes`, (entry, entryLabel) =>
    parseAutomationAgentTypeEntity(entry, entryLabel, options)
  );
  const stages = arrayOf(item.stages, `${label}.stages`, (entry, entryLabel) =>
    parseAutomationStageEntity(entry, entryLabel, options)
  );
  validateAutomationConfigurationParts(agentTypes, stages, label);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    configurationId: "company-default",
    agentTypes: Object.freeze(agentTypes),
    stages: Object.freeze(stages),
    version: integer(item.version, `${label}.version`, 1),
    createdAt: entityTimestamp(item.createdAt, `${label}.createdAt`, options),
    updatedAt: entityTimestamp(item.updatedAt, `${label}.updatedAt`, options),
    updatedBy:
      options.projection === "browser"
        ? prose(item.updatedBy, `${label}.updatedBy`, {
            maximum: 256,
            message: `${label}.updatedBy must not be empty and contain at most 256 characters`,
            scalarMessages: options.scalarMessages,
          })
        : identifier(item.updatedBy, `${label}.updatedBy`, `${label}.updatedBy is invalid`, options.scalarMessages),
  });
}

/* —— Snapshots and claim responses —— */

export function parseBoardSnapshotEntity(value: unknown, options: ShapeParserOptions = {}): BoardSnapshot {
  const fields = [
    "apiVersion",
    "project",
    "agents",
    "tasks",
    "openQuestions",
    "recentQuestions",
    "recentRuns",
    "recentInterrupts",
    "recentEvents",
  ];
  const required = fields.filter((field) => field !== "recentQuestions");
  const item = entity(value, "board", fields, required, options);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    project: parseProjectEntity(item.project, "board.project", options),
    agents: Object.freeze(
      arrayOf(item.agents, "board.agents", (entry, label) => parseAgentEntity(entry, label, options))
    ),
    tasks: Object.freeze(arrayOf(item.tasks, "board.tasks", (entry, label) => parseTaskEntity(entry, label, options))),
    openQuestions: Object.freeze(
      arrayOf(item.openQuestions, "board.openQuestions", (entry, label) => parseQuestionEntity(entry, label, options))
    ),
    recentQuestions: Object.freeze(
      item.recentQuestions === undefined
        ? []
        : arrayOf(item.recentQuestions, "board.recentQuestions", (entry, label) =>
            parseQuestionEntity(entry, label, options)
          )
    ),
    recentRuns: Object.freeze(
      arrayOf(item.recentRuns, "board.recentRuns", (entry, label) => parseRunEntity(entry, label, options))
    ),
    recentInterrupts: Object.freeze(
      arrayOf(item.recentInterrupts, "board.recentInterrupts", (entry, label) =>
        parseInterruptEntity(entry, label, options)
      )
    ),
    recentEvents: Object.freeze(
      arrayOf(item.recentEvents, "board.recentEvents", (entry, label) => parseEventEntity(entry, label, options))
    ),
  });
}

export function parseClaimRunResult(value: unknown): ClaimRunResult {
  const envelope = exact(value, ["apiVersion", "run", "wakeup", "task", "context"], "Claim result");
  if (envelope.apiVersion !== TASK_BOARD_API_VERSION)
    throw new ContractValidationError("Claim result API version is invalid");
  const run = exact(
    envelope.run,
    [
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
    ],
    "Claim run"
  );
  const wakeup = exact(
    envelope.wakeup,
    [
      "apiVersion",
      "wakeupId",
      "projectId",
      "agentId",
      "reason",
      "taskId",
      "questionId",
      "detail",
      "createdBy",
      "createdAt",
      "claimedAt",
      "runId",
    ],
    "Claim wakeup"
  );
  const context = exact(
    envelope.context,
    [
      "intake",
      "boardProjects",
      "onboarding",
      "design",
      "agent",
      "projectMemory",
      "areaMemory",
      "parentTask",
      "parentMessages",
      "acceptanceCriteria",
      "workspaceRefs",
      "phase",
      "crossRepoContext",
      "messageCursor",
      "messages",
      "triggerQuestion",
      "openQuestions",
      "workflow",
    ],
    "Claim context",
    {
      required: [
        "intake",
        "design",
        "agent",
        "projectMemory",
        "areaMemory",
        "parentTask",
        "parentMessages",
        "acceptanceCriteria",
        "workspaceRefs",
        "messageCursor",
        "messages",
        "triggerQuestion",
        "openQuestions",
        "workflow",
      ],
    }
  );
  if (
    run.apiVersion !== TASK_BOARD_API_VERSION ||
    wakeup.apiVersion !== TASK_BOARD_API_VERSION ||
    run.status !== "active" ||
    run.endedAt !== null ||
    run.result !== null ||
    typeof wakeup.reason !== "string" ||
    !(WAKEUP_REASONS as readonly string[]).includes(wakeup.reason)
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
    run.wakeupId !== wakeup.wakeupId ||
    run.projectId !== wakeup.projectId ||
    run.agentId !== wakeup.agentId ||
    run.taskId !== wakeup.taskId ||
    wakeup.runId !== run.runId ||
    wakeup.claimedAt === null
  ) {
    throw new ContractValidationError("Claim run and wakeup binding is invalid");
  }
  if (
    !Array.isArray(context.workspaceRefs) ||
    !Array.isArray(context.areaMemory) ||
    !Array.isArray(context.messages) ||
    !Array.isArray(context.parentMessages) ||
    !Array.isArray(context.openQuestions)
  ) {
    throw new ContractValidationError("Claim context collections are invalid");
  }
  if (context.workflow !== null) {
    const workflow = exact(
      context.workflow,
      [
        "planRevisionId",
        "nodeId",
        "stage",
        "skills",
        "dependencyHandoffs",
        "workspaceKey",
        "pipeline",
        "review",
        "fix",
      ],
      "Workflow context",
      { required: ["planRevisionId", "nodeId", "stage", "skills", "dependencyHandoffs"] }
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
  const intake = booleanValue(context.intake, "context.intake");
  const boardProjects =
    context.boardProjects === undefined
      ? undefined
      : parseBoardProjectContexts(context.boardProjects, "context.boardProjects");
  if (intake && boardProjects === undefined) {
    throw new ContractValidationError("Intake claim context is missing board projects");
  }
  if (!intake && boardProjects !== undefined) {
    throw new ContractValidationError("Board projects are only valid for intake claim context");
  }
  if (boardProjects !== undefined && !boardProjects.some((project) => project.projectId === run.projectId)) {
    throw new ContractValidationError("Intake claim context board projects omit the parent project");
  }
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
