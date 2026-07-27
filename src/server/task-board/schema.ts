import { AUTOMATION_CONFIGURATION_MAX_BYTES } from "#shared/task-board-contract";
import type {
  AgentTypeEvaluatorProfile,
  AgentRole,
  AutomationAgentType,
  AutomationPipelineStage,
  AutomationStageExecutor,
  AnswerHumanQuestionRequest,
  ClaimRunRequest,
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
  SettleRunRequest,
  TaskMessageKind,
  TaskPhaseStage,
  TaskPhaseStatus,
  TaskStatus,
  UpdateDocumentPenRequest,
  UpdateDocumentRequest,
  UpdateAutomationConfigurationRequest,
  UpdateTaskRequest,
  UpdateTaskPhaseRequest,
  UpdateWorkItemRequest,
  WorkItemPriority,
  WorkItemProjectTarget,
  WorkItemStage,
} from "#shared/task-board-contract";
import { TaskBoardError } from "./errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TaskBoardError(400, "INVALID_REQUEST", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${label} has unexpected or missing fields`);
  }
  return value;
}

function allowed(value: unknown, keys: readonly string[], required: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TaskBoardError(400, "INVALID_REQUEST", `${label} must be an object`);
  const permitted = new Set(keys);
  if (Object.keys(value).some((key) => !permitted.has(key)) || required.some((key) => !(key in value))) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${label} has unexpected or missing fields`);
  }
  return value;
}

export function parseIdentifier(value: unknown, field: string, maximum = 128): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
  ) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  return value;
}

function text(value: unknown, field: string, maximum = 8_000): string {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)
  ) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  return value.trim();
}

function token(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "token is invalid");
  }
  return value;
}

function role(value: unknown, field = "role"): AgentRole {
  if (value !== "engineer" && value !== "manager" && value !== "verifier") {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  return value;
}

function nullableRole(value: unknown, field: string): AgentRole | null {
  return value === null ? null : role(value, field);
}

function nullableIdentifier(value: unknown, field: string): string | null {
  return value === null ? null : parseIdentifier(value, field);
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "version must be a positive safe integer");
  }
  return Number(value);
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${field} must be a non-negative safe integer`);
  }
  return Number(value);
}

function nonNegativeVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${field} must be a non-negative safe integer`);
  }
  return Number(value);
}

function documentContent(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 48 * 1_024 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new TaskBoardError(400, "INVALID_DOCUMENT_CONTENT", "content must be valid text no larger than 48 KiB");
  }
  return value;
}

function expectedMinutes(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 15 || Number(value) > 10_080 || Number(value) % 15 !== 0) {
    throw new TaskBoardError(
      400,
      "INVALID_EXPECTED_AGENT_MINUTES",
      "expectedAgentMinutes must be a 15-minute interval between 15 and 10080",
    );
  }
  return Number(value);
}

function nullableExpectedMinutes(value: unknown): number | null {
  return value === null ? null : expectedMinutes(value);
}

function phaseStage(value: unknown): TaskPhaseStage {
  if (
    value !== "research" && value !== "planning" && value !== "execution" &&
    value !== "testing" && value !== "review" && value !== "done"
  ) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "stage is invalid");
  }
  return value;
}

function phaseStatus(value: unknown): TaskPhaseStatus {
  if (
    value !== "pending" && value !== "in_progress" && value !== "blocked" &&
    value !== "completed" && value !== "failed"
  ) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "phase status is invalid");
  }
  return value;
}

function taskStatus(value: unknown): TaskStatus {
  if (
    value !== "backlog" &&
    value !== "queued" &&
    value !== "in_progress" &&
    value !== "blocked" &&
    value !== "completed" &&
    value !== "failed" &&
    value !== "cancelled"
  ) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "status is invalid");
  }
  return value;
}

function workItemPriority(value: unknown): WorkItemPriority {
  if (value !== "urgent" && value !== "high" && value !== "normal" && value !== "low" && value !== "opportunistic") {
    throw new TaskBoardError(400, "INVALID_REQUEST", "priority is invalid");
  }
  return value;
}

function workItemProjectTarget(value: unknown): WorkItemProjectTarget {
  if (!isRecord(value)) throw new TaskBoardError(400, "INVALID_REQUEST", "projectTarget must be an object");
  if (value.mode === "auto") {
    exact(value, ["mode"], "Automatic project target");
    return Object.freeze({ mode: "auto" });
  }
  if (value.mode === "explicit") {
    const item = exact(value, ["mode", "projectId"], "Explicit project target");
    return Object.freeze({ mode: "explicit", projectId: parseIdentifier(item.projectId, "projectId") });
  }
  throw new TaskBoardError(400, "INVALID_REQUEST", "projectTarget mode is invalid");
}

const AUTOMATION_STAGE_ORDER = Object.freeze([
  "refinement",
  "project_resolution",
  "research",
  "planning",
  "implementation",
  "testing",
  "verification",
  "human_review",
  "deployment",
] as const satisfies readonly WorkItemStage[]);

type AutomationAgentStage = Exclude<WorkItemStage, "human_review" | "deployment">;

const AUTOMATION_STAGE_ROLE_COMPATIBILITY = Object.freeze({
  refinement: Object.freeze(["manager"] as const),
  project_resolution: Object.freeze(["manager"] as const),
  research: Object.freeze(["engineer", "verifier"] as const),
  planning: Object.freeze(["engineer"] as const),
  implementation: Object.freeze(["engineer"] as const),
  testing: Object.freeze(["engineer", "verifier"] as const),
  verification: Object.freeze(["verifier"] as const),
}) satisfies Readonly<Record<AutomationAgentStage, readonly AgentRole[]>>;

function evaluatorProfile(value: unknown): AgentTypeEvaluatorProfile {
  if (value !== "tests" && value !== "editorial" && value !== "visual" && value !== "manual") {
    throw new TaskBoardError(400, "INVALID_REQUEST", "evaluatorProfile is invalid");
  }
  return value;
}

function skillIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[a-z0-9][a-z0-9._:-]*$/u.test(value)
  ) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  return value;
}

function supplementalInstructions(value: unknown, enabled: boolean, field: string): string {
  if (
    typeof value !== "string" ||
    value.length > 8_000 ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)
  ) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${field} is invalid`);
  }
  const parsed = value.trim();
  if (enabled && parsed.length === 0) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${field} is required for an enabled agent type`);
  }
  return parsed;
}

function automationAgentType(value: unknown, index: number): AutomationAgentType {
  const label = `agentTypes[${index}]`;
  const item = exact(value, [
    "agentTypeId",
    "name",
    "description",
    "role",
    "supplementalInstructions",
    "skillIds",
    "evaluatorProfile",
    "enabled",
  ], label);
  if (!Array.isArray(item.skillIds) || item.skillIds.length > 32) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${label}.skillIds must be an array with at most 32 entries`);
  }
  const skillIds = item.skillIds.map((skillId, skillIndex) =>
    skillIdentifier(skillId, `${label}.skillIds[${skillIndex}]`));
  if (new Set(skillIds).size !== skillIds.length) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${label}.skillIds contains a duplicate`);
  }
  if (typeof item.enabled !== "boolean") {
    throw new TaskBoardError(400, "INVALID_REQUEST", `${label}.enabled must be a boolean`);
  }
  const enabled = item.enabled;
  return Object.freeze({
    agentTypeId: parseIdentifier(item.agentTypeId, `${label}.agentTypeId`),
    name: text(item.name, `${label}.name`, 160),
    description: text(item.description, `${label}.description`, 4_000),
    role: role(item.role, `${label}.role`),
    supplementalInstructions: supplementalInstructions(item.supplementalInstructions, enabled, `${label}.supplementalInstructions`),
    skillIds: Object.freeze(skillIds),
    evaluatorProfile: evaluatorProfile(item.evaluatorProfile),
    enabled,
  });
}

function automationExecutor(value: unknown, label: string): AutomationStageExecutor {
  if (!isRecord(value)) throw new TaskBoardError(400, "INVALID_REQUEST", `${label} must be an object`);
  if (value.kind === "agent_type") {
    const item = exact(value, ["kind", "agentTypeId"], label);
    return Object.freeze({ kind: "agent_type", agentTypeId: parseIdentifier(item.agentTypeId, `${label}.agentTypeId`) });
  }
  if (value.kind === "human") {
    exact(value, ["kind"], label);
    return Object.freeze({ kind: "human" });
  }
  if (value.kind === "disabled") {
    exact(value, ["kind"], label);
    return Object.freeze({ kind: "disabled" });
  }
  throw new TaskBoardError(400, "INVALID_REQUEST", `${label}.kind is invalid`);
}

function automationStages(value: unknown, agentTypes: readonly AutomationAgentType[]): readonly AutomationPipelineStage[] {
  if (!Array.isArray(value) || value.length !== AUTOMATION_STAGE_ORDER.length) {
    throw new TaskBoardError(400, "INVALID_REQUEST", `stages must contain exactly ${AUTOMATION_STAGE_ORDER.length} entries`);
  }
  const stages = value.map((candidate, index): AutomationPipelineStage => {
    const label = `stages[${index}]`;
    const item = exact(candidate, ["stage", "executor"], label);
    const stage = AUTOMATION_STAGE_ORDER[index];
    if (stage === undefined || item.stage !== stage) {
      throw new TaskBoardError(400, "INVALID_REQUEST", "stages must use the canonical order without duplicates");
    }
    return Object.freeze({
      stage,
      executor: automationExecutor(item.executor, `${label}.executor`),
    });
  });
  if (new Set(stages.map((stage) => stage.stage)).size !== AUTOMATION_STAGE_ORDER.length) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "stages contains a duplicate");
  }
  const typesById = new Map(agentTypes.map((agentType) => [agentType.agentTypeId, agentType] as const));
  for (const stage of stages) {
    if (stage.stage === "human_review") {
      if (stage.executor.kind !== "human") {
        throw new TaskBoardError(400, "INVALID_REQUEST", "human_review must use the human executor");
      }
      continue;
    }
    if (stage.stage === "deployment") {
      if (stage.executor.kind !== "disabled") {
        throw new TaskBoardError(400, "INVALID_REQUEST", "deployment must remain disabled");
      }
      continue;
    }
    if (stage.executor.kind === "human") {
      throw new TaskBoardError(400, "INVALID_REQUEST", `${stage.stage} cannot use the human executor`);
    }
    if (stage.executor.kind === "disabled") continue;
    const agentType = typesById.get(stage.executor.agentTypeId);
    if (agentType === undefined) {
      throw new TaskBoardError(400, "INVALID_REQUEST", `${stage.stage} references an unknown agent type`);
    }
    if (!agentType.enabled) {
      throw new TaskBoardError(400, "INVALID_REQUEST", `${stage.stage} references a disabled agent type`);
    }
    const compatibleRoles: readonly AgentRole[] = AUTOMATION_STAGE_ROLE_COMPATIBILITY[stage.stage];
    if (!compatibleRoles.includes(agentType.role)) {
      throw new TaskBoardError(
        400,
        "INVALID_REQUEST",
        `${stage.stage} cannot use an agent type with the ${agentType.role} role`,
      );
    }
  }
  return Object.freeze(stages);
}

function refs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "workspaceRefs must be an array with at most 32 entries");
  }
  const parsed = value.map((item, index) => text(item, `workspaceRefs[${index}]`, 512));
  if (new Set(parsed).size !== parsed.length) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "workspaceRefs contains a duplicate");
  }
  return Object.freeze(parsed);
}

export function parseCreateProject(value: unknown): CreateProjectRequest {
  const item = exact(value, ["name", "description"], "Project");
  return Object.freeze({ name: text(item.name, "name", 160), description: text(item.description, "description", 8_000) });
}

export function parseCreateWorkItem(value: unknown): CreateWorkItemRequest {
  const item = allowed(value, ["originalRequest", "priority", "projectTarget"], ["originalRequest"], "Work item");
  return Object.freeze({
    originalRequest: text(item.originalRequest, "originalRequest", 16_000),
    priority: item.priority === undefined ? "normal" : workItemPriority(item.priority),
    projectTarget: item.projectTarget === undefined
      ? Object.freeze({ mode: "auto" as const })
      : workItemProjectTarget(item.projectTarget),
  });
}

export function parseUpdateWorkItem(value: unknown): UpdateWorkItemRequest {
  const item = allowed(value, ["version", "priority", "projectTarget"], ["version"], "Work item update");
  if (Object.keys(item).length === 1) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Work item update contains no changes");
  }
  const result: {
    version: number;
    priority?: WorkItemPriority;
    projectTarget?: WorkItemProjectTarget;
  } = { version: positiveVersion(item.version) };
  if ("priority" in item) result.priority = workItemPriority(item.priority);
  if ("projectTarget" in item) result.projectTarget = workItemProjectTarget(item.projectTarget);
  return Object.freeze(result);
}

export function parseUpdateAutomationConfiguration(value: unknown): UpdateAutomationConfigurationRequest {
  const item = exact(value, ["version", "agentTypes", "stages"], "Automation configuration update");
  if (!Array.isArray(item.agentTypes) || item.agentTypes.length > 32) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "agentTypes must be an array with at most 32 entries");
  }
  const agentTypes = item.agentTypes.map(automationAgentType);
  if (new Set(agentTypes.map((agentType) => agentType.agentTypeId)).size !== agentTypes.length) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "agentTypes contains a duplicate agentTypeId");
  }
  const stages = automationStages(item.stages, agentTypes);
  const aggregateBytes = Buffer.byteLength(JSON.stringify({ agentTypes, stages }), "utf8");
  if (aggregateBytes > AUTOMATION_CONFIGURATION_MAX_BYTES) {
    throw new TaskBoardError(
      400,
      "INVALID_REQUEST",
      `Automation configuration exceeds ${AUTOMATION_CONFIGURATION_MAX_BYTES} UTF-8 JSON bytes`,
    );
  }
  return Object.freeze({
    version: positiveVersion(item.version),
    agentTypes: Object.freeze(agentTypes),
    stages,
  });
}

export function parseCreateAgent(value: unknown): CreateAgentRequest {
  const item = exact(value, ["agentId", "role", "area", "mission", "model", "token"], "Agent profile");
  return Object.freeze({
    agentId: parseIdentifier(item.agentId, "agentId"),
    role: role(item.role),
    area: text(item.area, "area", 256),
    mission: text(item.mission, "mission", 4_000),
    model: parseIdentifier(item.model, "model", 256),
    token: token(item.token),
  });
}

export function parseCreateTask(value: unknown): CreateTaskRequest {
  // `expectedAgentMinutes` is accepted and ignored for compatibility with pre-v5
  // human clients. Only the assigned agent may author the durable estimate now.
  const item = allowed(value, [
    "parentTaskId",
    "title",
    "objective",
    "acceptanceCriteria",
    "workspaceRefs",
    "assignedAgentId",
    "assignedRole",
    "requiresReview",
    "expectedAgentMinutes",
  ], [
    "parentTaskId",
    "title",
    "objective",
    "acceptanceCriteria",
    "workspaceRefs",
    "assignedAgentId",
    "assignedRole",
  ], "Task");
  const assignedAgentId = nullableIdentifier(item.assignedAgentId, "assignedAgentId");
  const assignedRole = nullableRole(item.assignedRole, "assignedRole");
  if ((assignedAgentId === null) !== (assignedRole === null)) {
    throw new TaskBoardError(400, "INVALID_ASSIGNMENT", "assignedAgentId and assignedRole must both be set or both be null");
  }
  if ("expectedAgentMinutes" in item) expectedMinutes(item.expectedAgentMinutes);
  if ("requiresReview" in item && typeof item.requiresReview !== "boolean") {
    throw new TaskBoardError(400, "INVALID_REQUEST", "requiresReview must be a boolean");
  }
  return Object.freeze({
    parentTaskId: nullableIdentifier(item.parentTaskId, "parentTaskId"),
    title: text(item.title, "title", 240),
    objective: text(item.objective, "objective", 8_000),
    acceptanceCriteria: text(item.acceptanceCriteria, "acceptanceCriteria", 8_000),
    workspaceRefs: refs(item.workspaceRefs),
    assignedAgentId,
    assignedRole,
    requiresReview: item.requiresReview === undefined ? true : item.requiresReview as boolean,
  });
}

export function parseCreateTaskPhase(value: unknown): CreateTaskPhaseRequest {
  const item = exact(value, ["title", "stage", "parallelGroup"], "Task phase");
  return Object.freeze({
    title: text(item.title, "title", 240),
    stage: phaseStage(item.stage),
    parallelGroup: nullableIdentifier(item.parallelGroup, "parallelGroup"),
  });
}

export function parseUpdateTaskPhase(value: unknown): UpdateTaskPhaseRequest {
  const item = allowed(value, [
    "version",
    "title",
    "stage",
    "status",
    "parallelGroup",
    "orderKey",
  ], ["version"], "Task phase update");
  if (Object.keys(item).length === 1) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Task phase update contains no changes");
  }
  const result: {
    version: number;
    title?: string;
    stage?: TaskPhaseStage;
    status?: TaskPhaseStatus;
    parallelGroup?: string | null;
    orderKey?: number;
  } = { version: positiveVersion(item.version) };
  if ("title" in item) result.title = text(item.title, "title", 240);
  if ("stage" in item) result.stage = phaseStage(item.stage);
  if ("status" in item) result.status = phaseStatus(item.status);
  if ("parallelGroup" in item) result.parallelGroup = nullableIdentifier(item.parallelGroup, "parallelGroup");
  if ("orderKey" in item) result.orderKey = nonNegativeSafeInteger(item.orderKey, "orderKey");
  return Object.freeze(result);
}

export function parseCreateDocument(value: unknown): CreateDocumentRequest {
  const item = exact(value, ["title", "contentType", "content", "clientId"], "Document");
  if (item.contentType !== "text/markdown") {
    throw new TaskBoardError(400, "INVALID_DOCUMENT_CONTENT_TYPE", "contentType must be text/markdown");
  }
  return Object.freeze({
    title: text(item.title, "title", 240),
    contentType: item.contentType,
    content: documentContent(item.content),
    clientId: parseIdentifier(item.clientId, "clientId", 256),
  });
}

export function parseDocumentPenUpdate(value: unknown): UpdateDocumentPenRequest {
  const item = exact(value, ["action", "clientId", "expectedPenEpoch", "force"], "Document pen update");
  if (item.action !== "acquire" && item.action !== "release") {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Document pen action is invalid");
  }
  if (typeof item.force !== "boolean" || (item.action === "release" && item.force)) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "force is only valid when acquiring the pen");
  }
  return Object.freeze({
    action: item.action,
    clientId: parseIdentifier(item.clientId, "clientId", 256),
    expectedPenEpoch: nonNegativeVersion(item.expectedPenEpoch, "expectedPenEpoch"),
    force: item.force,
  }) as UpdateDocumentPenRequest;
}

export function parseDocumentUpdate(value: unknown): UpdateDocumentRequest {
  const item = exact(value, ["clientId", "penEpoch", "contentVersion", "content"], "Document update");
  return Object.freeze({
    clientId: parseIdentifier(item.clientId, "clientId", 256),
    penEpoch: positiveVersion(item.penEpoch),
    contentVersion: positiveVersion(item.contentVersion),
    content: documentContent(item.content),
  });
}

export function parseUpdateTask(value: unknown): UpdateTaskRequest {
  const item = allowed(value, [
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
  ], ["version"], "Task update");
  if (Object.keys(item).length === 1) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Task update contains no changes");
  }
  if (("assignedAgentId" in item) !== ("assignedRole" in item)) {
    throw new TaskBoardError(400, "INVALID_ASSIGNMENT", "Assignment fields must be updated together");
  }
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
  } = { version: positiveVersion(item.version) };
  if ("title" in item) result.title = text(item.title, "title", 240);
  if ("objective" in item) result.objective = text(item.objective, "objective", 8_000);
  if ("acceptanceCriteria" in item) result.acceptanceCriteria = text(item.acceptanceCriteria, "acceptanceCriteria", 8_000);
  if ("workspaceRefs" in item) result.workspaceRefs = refs(item.workspaceRefs);
  if ("assignedAgentId" in item) {
    result.assignedAgentId = nullableIdentifier(item.assignedAgentId, "assignedAgentId");
    result.assignedRole = nullableRole(item.assignedRole, "assignedRole");
    if ((result.assignedAgentId === null) !== (result.assignedRole === null)) {
      throw new TaskBoardError(400, "INVALID_ASSIGNMENT", "Assignment fields must both be set or both be null");
    }
  }
  if ("expectedAgentMinutes" in item) result.expectedAgentMinutes = nullableExpectedMinutes(item.expectedAgentMinutes);
  if ("orderKey" in item) result.orderKey = nonNegativeSafeInteger(item.orderKey, "orderKey");
  if ("status" in item) result.status = taskStatus(item.status);
  if ("result" in item) result.result = item.result === null ? null : text(item.result, "result", 16_000);
  return Object.freeze(result);
}

function messageKind(value: unknown, human: boolean): TaskMessageKind {
  if (human) {
    if (value !== "note") throw new TaskBoardError(400, "INVALID_REQUEST", "Human messages must use note kind");
    return value;
  }
  if (value !== "progress" && value !== "proposal" && value !== "result") {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Agent message kind is invalid");
  }
  return value;
}

export function parseAgentMessage(value: unknown): CreateTaskMessageRequest {
  const item = exact(value, ["clientEventId", "kind", "body", "runId"], "Agent task message");
  return Object.freeze({
    clientEventId: parseIdentifier(item.clientEventId, "clientEventId", 256),
    kind: messageKind(item.kind, false),
    body: text(item.body, "body", 16_000),
    runId: parseIdentifier(item.runId, "runId"),
  });
}

export function parseHumanMessage(value: unknown): CreateHumanTaskMessageRequest {
  const item = exact(value, ["clientEventId", "kind", "body"], "Human task message");
  return Object.freeze({
    clientEventId: parseIdentifier(item.clientEventId, "clientEventId", 256),
    kind: messageKind(item.kind, true) as "note",
    body: text(item.body, "body", 16_000),
  });
}

export function parseQuestion(value: unknown): CreateHumanQuestionRequest {
  const item = exact(value, ["clientEventId", "question", "runId"], "Human question");
  return Object.freeze({
    clientEventId: parseIdentifier(item.clientEventId, "clientEventId", 256),
    question: text(item.question, "question", 8_000),
    runId: parseIdentifier(item.runId, "runId"),
  });
}

export function parseAnswer(value: unknown): AnswerHumanQuestionRequest {
  const item = exact(value, ["answer", "version"], "Question answer");
  return Object.freeze({ answer: text(item.answer, "answer", 16_000), version: positiveVersion(item.version) });
}

export function parseResume(value: unknown): ResumeAgentRequest {
  const item = exact(value, ["reason", "taskId"], "Agent resume");
  return Object.freeze({ reason: text(item.reason, "reason", 2_000), taskId: nullableIdentifier(item.taskId, "taskId") });
}

export function parseInterrupt(value: unknown): InterruptAgentRequest {
  const item = exact(value, ["reason"], "Agent interrupt");
  return Object.freeze({ reason: text(item.reason, "reason", 2_000) });
}

export function parseClaim(value: unknown): ClaimRunRequest {
  if (!isRecord(value)) throw new TaskBoardError(400, "INVALID_REQUEST", "Run claim must be an object");
  const keys = Object.keys(value).sort();
  const legacy = keys.length === 2 && keys[0] === "claimId" && keys[1] === "messageCursor";
  const perTask = keys.length === 2 && keys[0] === "claimId" && keys[1] === "messageCursors";
  if (!legacy && !perTask) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Run claim has unexpected or missing fields");
  }
  const claimId = parseIdentifier(value.claimId, "claimId", 256);
  if (legacy) {
    const cursor = value.messageCursor;
    if (cursor !== null && (!Number.isSafeInteger(cursor) || Number(cursor) < 0)) {
      throw new TaskBoardError(400, "INVALID_REQUEST", "messageCursor must be null or a non-negative safe integer");
    }
    return Object.freeze({ claimId, messageCursor: cursor === null ? null : Number(cursor) });
  }
  if (!isRecord(value.messageCursors) || Object.keys(value.messageCursors).length > 256) {
    throw new TaskBoardError(400, "INVALID_REQUEST", "messageCursors must be an object with at most 256 task entries");
  }
  const messageCursors: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [taskId, cursor] of Object.entries(value.messageCursors)) {
    parseIdentifier(taskId, "messageCursors taskId");
    if (!Number.isSafeInteger(cursor) || Number(cursor) < 0) {
      throw new TaskBoardError(400, "INVALID_REQUEST", "messageCursors values must be non-negative safe integers");
    }
    messageCursors[taskId] = Number(cursor);
  }
  return Object.freeze({ claimId, messageCursors: Object.freeze(messageCursors) });
}

export function parseSettle(value: unknown): SettleRunRequest {
  if (!isRecord(value)) throw new TaskBoardError(400, "INVALID_REQUEST", "Run settlement must be an object");
  const item = exact(value, [
    "outcome", "result",
    ...("handoff" in value ? ["handoff"] : []),
    ...("workflowPlan" in value ? ["workflowPlan"] : []),
  ], "Run settlement");
  if (item.outcome !== "completed" && item.outcome !== "failed" && item.outcome !== "interrupted") {
    throw new TaskBoardError(400, "INVALID_REQUEST", "Run outcome is invalid");
  }
  let handoff: SettleRunRequest["handoff"] = null;
  if (item.handoff !== undefined && item.handoff !== null) {
    if (!isRecord(item.handoff)) throw new TaskBoardError(400, "INVALID_REQUEST", "handoff is invalid");
    const raw = exact(item.handoff, ["outcome", "summary", "evidence", "artifactIds", "acceptanceCriteria", "blockers", "recommendedReturnStage"], "handoff");
    if (raw.outcome !== "passed" && raw.outcome !== "failed" && raw.outcome !== "needs_input") throw new TaskBoardError(400, "INVALID_REQUEST", "handoff outcome is invalid");
    const values = (input: unknown, field: string): readonly string[] => {
      if (!Array.isArray(input) || input.length > 32) throw new TaskBoardError(400, "INVALID_REQUEST", `${field} is invalid`);
      return Object.freeze(input.map((entry, index) => text(entry, `${field}[${index}]`, 2_000)));
    };
    if (!Array.isArray(raw.acceptanceCriteria) || raw.acceptanceCriteria.length > 32) throw new TaskBoardError(400, "INVALID_REQUEST", "handoff criteria are invalid");
    const criteria = raw.acceptanceCriteria.map((entry, index) => {
      const criterion = exact(entry, ["criterion", "passed", "evidence"], `handoff criterion ${index}`);
      if (typeof criterion.passed !== "boolean") throw new TaskBoardError(400, "INVALID_REQUEST", "handoff criterion result is invalid");
      return Object.freeze({ criterion: text(criterion.criterion, "criterion", 1_000), passed: criterion.passed, evidence: text(criterion.evidence, "evidence", 2_000) });
    });
    const returnStage = raw.recommendedReturnStage;
    if (returnStage !== null && returnStage !== "research" && returnStage !== "planning" && returnStage !== "implementation" && returnStage !== "testing" && returnStage !== "verification") throw new TaskBoardError(400, "INVALID_REQUEST", "handoff return stage is invalid");
    handoff = Object.freeze({
      outcome: raw.outcome, summary: text(raw.summary, "handoff.summary", 4_000),
      evidence: values(raw.evidence, "handoff.evidence"), artifactIds: values(raw.artifactIds, "handoff.artifactIds"),
      acceptanceCriteria: Object.freeze(criteria), blockers: values(raw.blockers, "handoff.blockers"),
      recommendedReturnStage: returnStage,
    });
  }
  let workflowPlan: SettleRunRequest["workflowPlan"] = null;
  if (item.workflowPlan !== undefined && item.workflowPlan !== null) {
    const plan = exact(item.workflowPlan, ["objective", "assumptions", "acceptanceCriteria", "nodes"], "workflowPlan");
    const strings = (input: unknown, field: string, minimum = 0): readonly string[] => {
      if (!Array.isArray(input) || input.length < minimum || input.length > 64) {
        throw new TaskBoardError(400, "INVALID_REQUEST", `${field} is invalid`);
      }
      return Object.freeze(input.map((entry, index) => text(entry, `${field}[${index}]`, 2_000)));
    };
    if (!Array.isArray(plan.nodes) || plan.nodes.length < 1 || plan.nodes.length > 64) {
      throw new TaskBoardError(400, "INVALID_REQUEST", "workflowPlan.nodes is invalid");
    }
    const nodes = plan.nodes.map((entry, index) => {
      const node = exact(entry, ["nodeId", "title", "objective", "acceptanceCriteria", "dependencyNodeIds", "stageTemplate"], `workflowPlan.nodes[${index}]`);
      const stages = strings(node.stageTemplate, `workflowPlan.nodes[${index}].stageTemplate`, 1);
      if (
        stages.length > 5 || new Set(stages).size !== stages.length || stages.at(-1) !== "verification" ||
        stages.some((stage) => stage !== "research" && stage !== "planning" && stage !== "implementation" && stage !== "testing" && stage !== "verification")
      ) throw new TaskBoardError(400, "INVALID_REQUEST", `workflowPlan.nodes[${index}].stageTemplate is invalid`);
      return Object.freeze({
        nodeId: parseIdentifier(node.nodeId, `workflowPlan.nodes[${index}].nodeId`),
        title: text(node.title, `workflowPlan.nodes[${index}].title`, 512),
        objective: text(node.objective, `workflowPlan.nodes[${index}].objective`, 4_000),
        acceptanceCriteria: strings(node.acceptanceCriteria, `workflowPlan.nodes[${index}].acceptanceCriteria`, 1),
        dependencyNodeIds: strings(node.dependencyNodeIds, `workflowPlan.nodes[${index}].dependencyNodeIds`),
        stageTemplate: Object.freeze(stages as import("#shared/task-board-contract").WorkflowStage[]),
      });
    });
    workflowPlan = Object.freeze({
      objective: text(plan.objective, "workflowPlan.objective", 8_000),
      assumptions: strings(plan.assumptions, "workflowPlan.assumptions"),
      acceptanceCriteria: strings(plan.acceptanceCriteria, "workflowPlan.acceptanceCriteria", 1),
      nodes: Object.freeze(nodes),
    });
  }
  return Object.freeze({
    outcome: item.outcome,
    result: text(item.result, "result", 16_000),
    handoff,
    workflowPlan,
  });
}

export function parseIdempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) {
    throw new TaskBoardError(400, "INVALID_IDEMPOTENCY_KEY", "A valid Idempotency-Key header is required");
  }
  return value;
}
