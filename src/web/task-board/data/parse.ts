/**
 * Validation of untrusted board API responses.
 *
 * Every function takes the raw value plus a dotted `path` used only to build
 * a readable error message when validation fails — e.g. "board.tasks[3].status".
 * Nothing here projects or renames; that is ./project.ts.
 */
import type {
  AgentRole,
  AutomationAgentType,
  AutomationConfiguration,
  AutomationStageConfiguration,
  AutomationStageExecutor,
  ProjectArtifact,
  ProjectWorkflow,
  TaskKind,
  TaskPhaseStage,
  TaskPhaseStatus,
  WorkflowEvent,
  WorkflowHandoff,
  WorkflowNode,
  WorkflowPlan,
  WorkItemPriority,
  WorkItemProjectTarget,
  WorkItemStage,
  WorkItemState,
} from '../types';
import { AUTOMATION_STAGE_ALLOWED_ROLES, AUTOMATION_STAGE_ORDER } from '../types';
import {
  actorTypes,
  apiVersion,
  documentActorTypes,
  evaluatorProfiles,
  maximumAutomationConfigurationBytes,
  maximumWorkItemCursorBytes,
  messageKinds,
  planRevisionStates,
  questionStatuses,
  rawAgentStatuses,
  rawRunStatuses,
  rawTaskStatuses,
  rawWorkerConnections,
  roles,
  stageHandoffOutcomes,
  taskKinds,
  taskPhaseStages,
  taskPhaseStatuses,
  workItemPriorities,
  workItemStages,
  workItemStates,
  workNodeStates,
  workflowStages,
  type WireAgentStatus,
  type WireRunStatus,
  type WireTaskStatus,
  type WireWorkerConnection,
} from './wire';

export { maximumWorkItemCursorBytes };

export type JsonRecord = Record<string, unknown>;

const automationExecutorKinds = new Set<AutomationStageExecutor['kind']>(['agent_type', 'human', 'disabled']);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const skillIdentifierPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
export const maximumTaskMessages = 10_000;
export const maximumWorkItemPages = 50;
export const maximumRawWorkItems = 10_000;

export interface RawProject {
  projectId: string;
  name: string;
  description: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RawWorkItem {
  workItemId: string;
  originalRequest: string;
  refinedObjective: string | null;
  priority: WorkItemPriority;
  projectTarget: WorkItemProjectTarget;
  resolvedProjectId: string | null;
  state: WorkItemState;
  currentStage: WorkItemStage | null;
  createdBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface RawAgent {
  agentId: string;
  projectId: string;
  role: AgentRole;
  area: string;
  mission: string;
  model: string;
  status: WireAgentStatus;
  workerConnection: WireWorkerConnection;
  lastError: string | null;
  createdAt: string;
}

export interface RawDocumentPenHolder {
  actorType: 'human' | 'agent';
  actorId: string;
  clientId: string;
  acquiredAt: string;
}

export interface RawDocumentSummary {
  documentId: string;
  projectId: string;
  title: string;
  contentType: 'text/markdown';
  contentVersion: number;
  penEpoch: number;
  penHolder: RawDocumentPenHolder | null;
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface RawDocument extends RawDocumentSummary {
  content: string;
}

export interface RawTask {
  taskId: string;
  projectId: string;
  parentTaskId: string | null;
  kind: TaskKind;
  requiredRole: AgentRole | null;
  requiresReview: boolean;
  title: string;
  objective: string;
  acceptanceCriteria: string;
  workspaceRefs: string[];
  status: WireTaskStatus;
  assignedAgentId: string | null;
  assignedRole: AgentRole | null;
  expectedAgentMinutes: number | null;
  estimateRecordedAt: string | null;
  orderKey: number | null;
  phases: RawTaskPhase[];
  startedAt: string | null;
  expectedCompletedAt: string | null;
  endedAt: string | null;
  result: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RawTaskPhase {
  phaseId: string;
  projectId: string;
  taskId: string;
  title: string;
  stage: TaskPhaseStage;
  status: TaskPhaseStatus;
  parallelGroup: string | null;
  orderKey: number;
  startedAt: string | null;
  endedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RawQuestion {
  questionId: string;
  projectId: string;
  taskId: string;
  agentId: string;
  question: string;
  status: 'open' | 'answered';
  answer: string | null;
  askedAt: string;
  answeredAt: string | null;
  version: number;
}

export interface RawRun {
  runId: string;
  projectId: string;
  agentId: string;
  taskId: string | null;
  status: WireRunStatus;
  startedAt: string;
  endedAt: string | null;
}

export interface RawInterrupt {
  sequence: number;
  agentId: string;
  runId: string | null;
  requestedAt: string;
}

export interface RawEvent {
  eventId: string;
  projectId: string;
  taskId: string | null;
  actorType: 'human' | 'agent' | 'system';
  actorId: string;
  eventType: string;
  data: JsonRecord;
  createdAt: string;
}

export interface RawMessage {
  messageId: string;
  sequence: number;
  projectId: string;
  taskId: string;
  actorType: 'human' | 'agent';
  actorId: string;
  kind: 'note' | 'progress' | 'proposal' | 'result';
  body: string;
  createdAt: string;
}

export interface RawBoard {
  project: RawProject;
  agents: RawAgent[];
  tasks: RawTask[];
  questions: RawQuestion[];
  runs: RawRun[];
  interrupts: RawInterrupt[];
  events: RawEvent[];
  documents: RawDocumentSummary[];
}

export function record(value: unknown, path: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonRecord;
}

export function exactRecord(value: unknown, path: string, fields: readonly string[]): JsonRecord {
  const item = record(value, path);
  const expected = new Set(fields);
  const unsupported = Object.keys(item).find((key) => !expected.has(key));
  if (unsupported) throw new Error(`${path}.${unsupported} is not supported`);
  const missing = fields.find((key) => !(key in item));
  if (missing) throw new Error(`${path}.${missing} is required`);
  return item;
}

export function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
}

export function boundedText(value: unknown, path: string, maximum: number, allowEmpty = false): string {
  const parsed = string(value, path);
  if (
    (!allowEmpty && parsed.length === 0)
    || parsed.length > maximum
    || parsed.trim() !== parsed
    || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(parsed)
  ) {
    throw new Error(`${path} must ${allowEmpty ? '' : 'not be empty and '}contain at most ${maximum.toLocaleString()} characters`);
  }
  return parsed;
}

export function identifier(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!identifierPattern.test(parsed)) throw new Error(`${path} must be a valid identifier`);
  return parsed;
}

export function skillIdentifier(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!skillIdentifierPattern.test(parsed)) {
    throw new Error(`${path} must be a lowercase skill identifier, not a URL or path`);
  }
  return parsed;
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

export function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return string(value, path);
}

export function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${path} must be a safe integer of at least ${minimum}`);
  }
  return Number(value);
}

export function timestamp(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (Number.isNaN(Date.parse(parsed))) throw new Error(`${path} must be a timestamp`);
  return parsed;
}

export function nullableTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : timestamp(value, path);
}

export function member<T extends string>(value: unknown, values: ReadonlySet<T>, path: string): T {
  const parsed = string(value, path);
  if (!values.has(parsed as T)) throw new Error(`${path} has an unsupported value`);
  return parsed as T;
}

export function array<T>(value: unknown, path: string, parse: (item: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => parse(item, `${path}[${index}]`));
}

export function apiEntity(value: unknown, path: string): JsonRecord {
  const item = record(value, path);
  if (item.apiVersion !== apiVersion) throw new Error(`${path}.apiVersion is incompatible`);
  return item;
}

export function parseProject(value: unknown, path: string): RawProject {
  const item = apiEntity(value, path);
  return {
    projectId: string(item.projectId, `${path}.projectId`),
    name: string(item.name, `${path}.name`),
    description: string(item.description, `${path}.description`),
    version: integer(item.version, `${path}.version`, 1),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
  };
}

export function parseWorkItemProjectTarget(value: unknown, path: string): WorkItemProjectTarget {
  const item = record(value, path);
  const mode = string(item.mode, `${path}.mode`);
  if (mode === 'auto') {
    if (Object.keys(item).some((key) => key !== 'mode')) throw new Error(`${path} has unsupported fields for automatic project selection`);
    return { mode: 'auto' };
  }
  if (mode === 'explicit') {
    if (Object.keys(item).some((key) => key !== 'mode' && key !== 'projectId')) {
      throw new Error(`${path} has unsupported fields for explicit project selection`);
    }
    return { mode: 'explicit', projectId: string(item.projectId, `${path}.projectId`) };
  }
  throw new Error(`${path}.mode has an unsupported value`);
}

export function parseWorkItem(value: unknown, path: string): RawWorkItem {
  const item = apiEntity(value, path);
  const projectTarget = parseWorkItemProjectTarget(item.projectTarget, `${path}.projectTarget`);
  const resolvedProjectId = nullableString(item.resolvedProjectId, `${path}.resolvedProjectId`);
  const state = member(item.state, workItemStates, `${path}.state`);
  const endedAt = nullableTimestamp(item.endedAt, `${path}.endedAt`);
  const terminal = state === 'completed' || state === 'failed' || state === 'cancelled';
  if (terminal !== (endedAt !== null)) throw new Error(`${path}.endedAt does not match its state`);
  if (projectTarget.mode === 'explicit' && resolvedProjectId !== projectTarget.projectId) {
    throw new Error(`${path}.resolvedProjectId must match its explicit project target`);
  }
  return {
    workItemId: string(item.workItemId, `${path}.workItemId`),
    originalRequest: string(item.originalRequest, `${path}.originalRequest`),
    refinedObjective: nullableString(item.refinedObjective, `${path}.refinedObjective`),
    priority: member(item.priority, workItemPriorities, `${path}.priority`),
    projectTarget,
    resolvedProjectId,
    state,
    currentStage: item.currentStage === null
      ? null
      : member(item.currentStage, workItemStages, `${path}.currentStage`),
    createdBy: string(item.createdBy, `${path}.createdBy`),
    version: integer(item.version, `${path}.version`, 1),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
    endedAt,
  };
}

function validateStringRecord(value: unknown, path: string): void {
  const item = record(value, path);
  for (const [key, entry] of Object.entries(item)) string(entry, `${path}.${key}`);
}

export function parseWorkflowPlan(value: unknown, path: string): WorkflowPlan {
  const item = apiEntity(value, path);
  string(item.workItemId, `${path}.workItemId`);
  string(item.projectId, `${path}.projectId`);
  validateStringRecord(item.skillDigests, `${path}.skillDigests`);
  string(item.createdBy, `${path}.createdBy`);
  nullableString(item.confirmedBy, `${path}.confirmedBy`);
  return {
    planRevisionId: string(item.planRevisionId, `${path}.planRevisionId`),
    revision: integer(item.revision, `${path}.revision`, 1),
    objective: string(item.objective, `${path}.objective`),
    assumptions: array(item.assumptions, `${path}.assumptions`, string),
    acceptanceCriteria: array(item.acceptanceCriteria, `${path}.acceptanceCriteria`, string),
    state: member(item.state, planRevisionStates, `${path}.state`),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
    confirmedAt: nullableTimestamp(item.confirmedAt, `${path}.confirmedAt`),
  };
}

export function parseWorkflowNode(value: unknown, path: string): WorkflowNode {
  const item = apiEntity(value, path);
  string(item.projectId, `${path}.projectId`);
  integer(item.version, `${path}.version`, 1);
  timestamp(item.createdAt, `${path}.createdAt`);
  return {
    nodeId: string(item.nodeId, `${path}.nodeId`),
    planRevisionId: string(item.planRevisionId, `${path}.planRevisionId`),
    title: string(item.title, `${path}.title`),
    objective: string(item.objective, `${path}.objective`),
    acceptanceCriteria: array(item.acceptanceCriteria, `${path}.acceptanceCriteria`, string),
    dependencyNodeIds: array(item.dependencyNodeIds, `${path}.dependencyNodeIds`, string),
    stageTemplate: array(
      item.stageTemplate,
      `${path}.stageTemplate`,
      (stage, stagePath) => member(stage, workflowStages, stagePath),
    ),
    currentStage: item.currentStage === null
      ? null
      : member(item.currentStage, workflowStages, `${path}.currentStage`),
    state: member(item.state, workNodeStates, `${path}.state`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
  };
}

function parseCriterionResult(value: unknown, path: string): void {
  const item = record(value, path);
  string(item.criterion, `${path}.criterion`);
  boolean(item.passed, `${path}.passed`);
  string(item.evidence, `${path}.evidence`);
}

export function parseWorkflowHandoff(value: unknown, path: string): WorkflowHandoff {
  const item = apiEntity(value, path);
  array(item.acceptanceCriteria, `${path}.acceptanceCriteria`, parseCriterionResult);
  if (item.recommendedReturnStage !== null) {
    member(item.recommendedReturnStage, workflowStages, `${path}.recommendedReturnStage`);
  }
  return {
    handoffId: string(item.handoffId, `${path}.handoffId`),
    nodeId: string(item.nodeId, `${path}.nodeId`),
    taskId: string(item.taskId, `${path}.taskId`),
    stage: member(item.stage, workflowStages, `${path}.stage`),
    outcome: member(item.outcome, stageHandoffOutcomes, `${path}.outcome`),
    summary: string(item.summary, `${path}.summary`),
    evidence: array(item.evidence, `${path}.evidence`, string),
    artifactIds: array(item.artifactIds, `${path}.artifactIds`, string),
    blockers: array(item.blockers, `${path}.blockers`, string),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
  };
}

export function parseWorkflowEvent(value: unknown, path: string): WorkflowEvent {
  const item = apiEntity(value, path);
  string(item.projectId, `${path}.projectId`);
  return {
    sequence: integer(item.sequence, `${path}.sequence`, 1),
    eventId: string(item.eventId, `${path}.eventId`),
    nodeId: nullableString(item.nodeId, `${path}.nodeId`),
    taskId: nullableString(item.taskId, `${path}.taskId`),
    eventType: string(item.eventType, `${path}.eventType`),
    summary: string(item.summary, `${path}.summary`),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
  };
}

export function parseProjectWorkflow(value: unknown, path: string): ProjectWorkflow {
  const item = record(value, path);
  return {
    plans: array(item.plans, `${path}.plans`, parseWorkflowPlan),
    nodes: array(item.nodes, `${path}.nodes`, parseWorkflowNode),
    handoffs: array(item.handoffs, `${path}.handoffs`, parseWorkflowHandoff),
    events: array(item.events, `${path}.events`, parseWorkflowEvent),
  };
}

export function parseProjectArtifact(value: unknown, path: string): ProjectArtifact {
  const item = apiEntity(value, path);
  string(item.projectId, `${path}.projectId`);
  const digest = string(item.digest, `${path}.digest`);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) throw new Error(`${path}.digest must be a SHA-256 digest`);
  string(item.createdBy, `${path}.createdBy`);
  return {
    artifactId: string(item.artifactId, `${path}.artifactId`),
    nodeId: nullableString(item.nodeId, `${path}.nodeId`),
    taskId: nullableString(item.taskId, `${path}.taskId`),
    mediaType: string(item.mediaType, `${path}.mediaType`),
    byteSize: integer(item.byteSize, `${path}.byteSize`, 1),
    caption: string(item.caption, `${path}.caption`),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
  };
}

export function parseAutomationAgentType(value: unknown, path: string): AutomationAgentType {
  const item = exactRecord(value, path, [
    'agentTypeId',
    'name',
    'description',
    'role',
    'supplementalInstructions',
    'skillIds',
    'evaluatorProfile',
    'enabled',
  ]);
  const skillIds = array(item.skillIds, `${path}.skillIds`, skillIdentifier);
  if (skillIds.length > 32) throw new Error(`${path}.skillIds cannot contain more than 32 entries`);
  if (new Set(skillIds).size !== skillIds.length) throw new Error(`${path}.skillIds cannot contain duplicates`);
  const supplementalInstructions = boundedText(item.supplementalInstructions, `${path}.supplementalInstructions`, 8_000, true);
  const enabled = boolean(item.enabled, `${path}.enabled`);
  if (enabled && supplementalInstructions.trim().length === 0) {
    throw new Error(`${path}.supplementalInstructions cannot be empty while the agent type is enabled`);
  }
  return {
    id: identifier(item.agentTypeId, `${path}.agentTypeId`),
    name: boundedText(item.name, `${path}.name`, 160),
    description: boundedText(item.description, `${path}.description`, 4_000),
    role: member(item.role, roles, `${path}.role`),
    supplementalInstructions,
    skillIds,
    evaluatorProfile: member(item.evaluatorProfile, evaluatorProfiles, `${path}.evaluatorProfile`),
    enabled,
  };
}

export function parseAutomationExecutor(value: unknown, path: string): AutomationStageExecutor {
  const item = record(value, path);
  const kind = member(item.kind, automationExecutorKinds, `${path}.kind`);
  if (kind === 'agent_type') {
    const exact = exactRecord(item, path, ['kind', 'agentTypeId']);
    return { kind, agentTypeId: identifier(exact.agentTypeId, `${path}.agentTypeId`) };
  }
  exactRecord(item, path, ['kind']);
  return { kind };
}

export function parseAutomationStage(value: unknown, path: string): AutomationStageConfiguration {
  const item = exactRecord(value, path, ['stage', 'executor']);
  return {
    stage: member(item.stage, workItemStages, `${path}.stage`),
    executor: parseAutomationExecutor(item.executor, `${path}.executor`),
  };
}

export function validateAutomationParts(
  agentTypes: AutomationAgentType[],
  stages: AutomationStageConfiguration[],
  path: string,
): void {
  if (agentTypes.length > 32) throw new Error(`${path}.agentTypes cannot contain more than 32 entries`);
  const agentTypesById = new Map<string, AutomationAgentType>();
  for (const agentType of agentTypes) {
    if (agentTypesById.has(agentType.id)) throw new Error(`${path}.agentTypes cannot contain duplicate IDs`);
    agentTypesById.set(agentType.id, agentType);
  }

  if (stages.length !== AUTOMATION_STAGE_ORDER.length) {
    throw new Error(`${path}.stages must contain every automation stage exactly once`);
  }
  stages.forEach((entry, index) => {
    const expectedStage = AUTOMATION_STAGE_ORDER[index];
    if (entry.stage !== expectedStage) {
      throw new Error(`${path}.stages must use the canonical automation stage order`);
    }
    if (entry.stage === 'human_review') {
      if (entry.executor.kind !== 'human') throw new Error(`${path}.stages human_review must be owned by a human`);
      return;
    }
    if (entry.stage === 'deployment') {
      if (entry.executor.kind !== 'disabled') throw new Error(`${path}.stages deployment must remain disabled`);
      return;
    }
    if (entry.executor.kind === 'human') {
      throw new Error(`${path}.stages ${entry.stage} cannot use a human executor`);
    }
    if (entry.executor.kind !== 'agent_type') return;
    const agentType = agentTypesById.get(entry.executor.agentTypeId);
    if (!agentType) throw new Error(`${path}.stages ${entry.stage} references an unknown agent type`);
    if (!agentType.enabled) throw new Error(`${path}.stages ${entry.stage} references a disabled agent type`);
    const allowedRoles = AUTOMATION_STAGE_ALLOWED_ROLES[entry.stage];
    if (!allowedRoles.includes(agentType.role)) {
      const rolesLabel = allowedRoles.join(' or ');
      const article = rolesLabel.startsWith('engineer') ? 'an' : 'a';
      throw new Error(`${path}.stages ${entry.stage} requires ${article} ${rolesLabel} agent type`);
    }
  });
}

export function automationAgentTypeWire(agentType: AutomationAgentType): JsonRecord {
  return {
    agentTypeId: agentType.id,
    name: agentType.name,
    description: agentType.description,
    role: agentType.role,
    supplementalInstructions: agentType.supplementalInstructions,
    skillIds: [...agentType.skillIds],
    evaluatorProfile: agentType.evaluatorProfile,
    enabled: agentType.enabled,
  };
}

export function automationStageWire(entry: AutomationStageConfiguration): JsonRecord {
  return {
    stage: entry.stage,
    executor: entry.executor.kind === 'agent_type'
      ? { kind: entry.executor.kind, agentTypeId: entry.executor.agentTypeId }
      : { kind: entry.executor.kind },
  };
}

export function validateAutomationPayloadSize(
  agentTypes: AutomationAgentType[],
  stages: AutomationStageConfiguration[],
  path: string,
): void {
  const serialized = JSON.stringify({
    agentTypes: agentTypes.map(automationAgentTypeWire),
    stages: stages.map(automationStageWire),
  });
  if (new TextEncoder().encode(serialized).byteLength > maximumAutomationConfigurationBytes) {
    throw new Error(`${path} agent types and stages cannot exceed 48 KiB of UTF-8 JSON`);
  }
}

export function parseAutomationConfiguration(value: unknown, path: string): AutomationConfiguration {
  const item = exactRecord(value, path, [
    'apiVersion',
    'configurationId',
    'agentTypes',
    'stages',
    'version',
    'createdAt',
    'updatedAt',
    'updatedBy',
  ]);
  if (item.apiVersion !== apiVersion) throw new Error(`${path}.apiVersion is incompatible`);
  if (item.configurationId !== 'company-default') throw new Error(`${path}.configurationId is unsupported`);
  const agentTypes = array(item.agentTypes, `${path}.agentTypes`, parseAutomationAgentType);
  const stages = array(item.stages, `${path}.stages`, parseAutomationStage);
  validateAutomationParts(agentTypes, stages, path);
  validateAutomationPayloadSize(agentTypes, stages, path);
  return {
    id: 'company-default',
    agentTypes,
    stages,
    version: integer(item.version, `${path}.version`, 1),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
    updatedBy: boundedText(item.updatedBy, `${path}.updatedBy`, 256),
  };
}

export function parseAgent(value: unknown, path: string): RawAgent {
  const item = apiEntity(value, path);
  const workerConnection = item.workerConnection === undefined || item.workerConnection === null
    ? null
    : member(item.workerConnection, rawWorkerConnections, `${path}.workerConnection`);
  const lastError = item.lastError === undefined || item.lastError === null
    ? null
    : boundedText(item.lastError, `${path}.lastError`, 2_000);
  return {
    agentId: string(item.agentId, `${path}.agentId`),
    projectId: string(item.projectId, `${path}.projectId`),
    role: member(item.role, roles, `${path}.role`),
    area: string(item.area, `${path}.area`),
    mission: string(item.mission, `${path}.mission`),
    model: string(item.model, `${path}.model`),
    status: member(item.status, rawAgentStatuses, `${path}.status`),
    workerConnection,
    lastError,
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
  };
}

export function parseDocumentPenHolder(value: unknown, path: string): RawDocumentPenHolder {
  const item = record(value, path);
  return {
    actorType: member(item.actorType, documentActorTypes, `${path}.actorType`),
    actorId: string(item.actorId, `${path}.actorId`),
    clientId: string(item.clientId, `${path}.clientId`),
    acquiredAt: timestamp(item.acquiredAt, `${path}.acquiredAt`),
  };
}

export function parseDocumentSummary(value: unknown, path: string): RawDocumentSummary {
  const item = apiEntity(value, path);
  if (item.contentType !== 'text/markdown') throw new Error(`${path}.contentType has an unsupported value`);
  const penEpoch = integer(item.penEpoch, `${path}.penEpoch`);
  const penHolder = item.penHolder === null
    ? null
    : parseDocumentPenHolder(item.penHolder, `${path}.penHolder`);
  if (penHolder !== null && penEpoch < 1) throw new Error(`${path}.penEpoch must advance before granting the pen`);
  return {
    documentId: string(item.documentId, `${path}.documentId`),
    projectId: string(item.projectId, `${path}.projectId`),
    title: string(item.title, `${path}.title`),
    contentType: 'text/markdown',
    contentVersion: integer(item.contentVersion, `${path}.contentVersion`, 1),
    penEpoch,
    penHolder,
    sequence: integer(item.sequence, `${path}.sequence`),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
  };
}

export function parseDocument(value: unknown, path: string): RawDocument {
  const item = apiEntity(value, path);
  return {
    ...parseDocumentSummary(item, path),
    content: string(item.content, `${path}.content`),
  };
}

export function parseTask(value: unknown, path: string): RawTask {
  const item = apiEntity(value, path);
  const taskId = string(item.taskId, `${path}.taskId`);
  const projectId = string(item.projectId, `${path}.projectId`);
  const status = member(item.status, rawTaskStatuses, `${path}.status`);
  const projectedCompletion = nullableTimestamp(item.expectedCompletedAt, `${path}.expectedCompletedAt`);
  const expectedAgentMinutes = item.expectedAgentMinutes === null || item.expectedAgentMinutes === undefined
    ? null
    : integer(item.expectedAgentMinutes, `${path}.expectedAgentMinutes`, 15);
  if (expectedAgentMinutes !== null && expectedAgentMinutes % 15 !== 0) {
    throw new Error(`${path}.expectedAgentMinutes must use a 15-minute interval`);
  }
  const kind = member(item.kind, taskKinds, `${path}.kind`);
  const requiredRole = item.requiredRole === null ? null : member(item.requiredRole, roles, `${path}.requiredRole`);
  if (typeof item.requiresReview !== 'boolean') throw new Error(`${path}.requiresReview must be a boolean`);
  const assignedAgentId = nullableString(item.assignedAgentId, `${path}.assignedAgentId`);
  const assignedRole = item.assignedRole === null ? null : member(item.assignedRole, roles, `${path}.assignedRole`);
  if (kind === 'manager_review' ? requiredRole !== 'manager' : requiredRole !== null) {
    throw new Error(`${path}.requiredRole does not match its task kind`);
  }
  if ((assignedAgentId === null) !== (assignedRole === null)) throw new Error(`${path} has an incomplete assignment`);
  if (requiredRole !== null && assignedRole !== null && assignedRole !== requiredRole) {
    throw new Error(`${path}.assignedRole does not satisfy requiredRole`);
  }
  if (kind === 'human_check' && assignedAgentId !== null) throw new Error(`${path} human check cannot be assigned`);
  const phases = item.phases === undefined
    ? []
    : array(item.phases, `${path}.phases`, parseTaskPhase);
  if (phases.some((phase) => phase.taskId !== taskId || phase.projectId !== projectId)) {
    throw new Error(`${path}.phases must belong to their containing task`);
  }
  return {
    taskId,
    projectId,
    parentTaskId: nullableString(item.parentTaskId, `${path}.parentTaskId`),
    kind,
    requiredRole,
    requiresReview: item.requiresReview,
    title: string(item.title, `${path}.title`),
    objective: string(item.objective, `${path}.objective`),
    acceptanceCriteria: string(item.acceptanceCriteria, `${path}.acceptanceCriteria`),
    workspaceRefs: array(item.workspaceRefs, `${path}.workspaceRefs`, string),
    status,
    assignedAgentId,
    assignedRole,
    expectedAgentMinutes,
    estimateRecordedAt: item.estimateRecordedAt === undefined
      ? null
      : nullableTimestamp(item.estimateRecordedAt, `${path}.estimateRecordedAt`),
    orderKey: item.orderKey === undefined ? null : integer(item.orderKey, `${path}.orderKey`),
    phases,
    startedAt: nullableTimestamp(item.startedAt, `${path}.startedAt`),
    expectedCompletedAt: status === 'completed' || status === 'failed' || status === 'interrupted' || status === 'cancelled'
      ? null
      : projectedCompletion,
    endedAt: nullableTimestamp(item.endedAt, `${path}.endedAt`),
    result: nullableString(item.result, `${path}.result`),
    version: integer(item.version, `${path}.version`, 1),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
  };
}

export function parseTaskPhase(value: unknown, path: string): RawTaskPhase {
  const item = apiEntity(value, path);
  const stage = member(item.stage, taskPhaseStages, `${path}.stage`);
  const status = member(item.status, taskPhaseStatuses, `${path}.status`);
  if (stage === 'done' && status !== 'completed') {
    throw new Error(`${path} may use the legacy done stage only when status is completed`);
  }
  return {
    phaseId: string(item.phaseId, `${path}.phaseId`),
    projectId: string(item.projectId, `${path}.projectId`),
    taskId: string(item.taskId, `${path}.taskId`),
    title: string(item.title, `${path}.title`),
    stage,
    status,
    parallelGroup: nullableString(item.parallelGroup, `${path}.parallelGroup`),
    orderKey: integer(item.orderKey, `${path}.orderKey`),
    startedAt: nullableTimestamp(item.startedAt, `${path}.startedAt`),
    endedAt: nullableTimestamp(item.endedAt, `${path}.endedAt`),
    version: integer(item.version, `${path}.version`, 1),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
  };
}

export function parseQuestion(value: unknown, path: string): RawQuestion {
  const item = apiEntity(value, path);
  return {
    questionId: string(item.questionId, `${path}.questionId`),
    projectId: string(item.projectId, `${path}.projectId`),
    taskId: string(item.taskId, `${path}.taskId`),
    agentId: string(item.agentId, `${path}.agentId`),
    question: string(item.question, `${path}.question`),
    status: member(item.status, questionStatuses, `${path}.status`),
    answer: nullableString(item.answer, `${path}.answer`),
    askedAt: timestamp(item.askedAt, `${path}.askedAt`),
    answeredAt: nullableTimestamp(item.answeredAt, `${path}.answeredAt`),
    version: integer(item.version, `${path}.version`, 1),
  };
}

export function parseRun(value: unknown, path: string): RawRun {
  const item = apiEntity(value, path);
  return {
    runId: string(item.runId, `${path}.runId`),
    projectId: string(item.projectId, `${path}.projectId`),
    agentId: string(item.agentId, `${path}.agentId`),
    taskId: nullableString(item.taskId, `${path}.taskId`),
    status: member(item.status, rawRunStatuses, `${path}.status`),
    startedAt: timestamp(item.startedAt, `${path}.startedAt`),
    endedAt: nullableTimestamp(item.endedAt, `${path}.endedAt`),
  };
}

export function parseInterrupt(value: unknown, path: string): RawInterrupt {
  const item = apiEntity(value, path);
  return {
    sequence: integer(item.sequence, `${path}.sequence`, 1),
    agentId: string(item.agentId, `${path}.agentId`),
    runId: nullableString(item.runId, `${path}.runId`),
    requestedAt: timestamp(item.requestedAt, `${path}.requestedAt`),
  };
}

export function parseEvent(value: unknown, path: string): RawEvent {
  const item = apiEntity(value, path);
  return {
    eventId: string(item.eventId, `${path}.eventId`),
    projectId: string(item.projectId, `${path}.projectId`),
    taskId: nullableString(item.taskId, `${path}.taskId`),
    actorType: member(item.actorType, actorTypes, `${path}.actorType`),
    actorId: string(item.actorId, `${path}.actorId`),
    eventType: string(item.eventType, `${path}.eventType`),
    data: record(item.data, `${path}.data`),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
  };
}

export function parseMessage(value: unknown, path: string): RawMessage {
  const item = apiEntity(value, path);
  return {
    messageId: string(item.messageId, `${path}.messageId`),
    sequence: integer(item.sequence, `${path}.sequence`, 1),
    projectId: string(item.projectId, `${path}.projectId`),
    taskId: string(item.taskId, `${path}.taskId`),
    actorType: member(item.actorType, documentActorTypes, `${path}.actorType`),
    actorId: string(item.actorId, `${path}.actorId`),
    kind: member(item.kind, messageKinds, `${path}.kind`),
    body: string(item.body, `${path}.body`),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
  };
}

export function parseRawBoard(value: unknown): RawBoard {
  const item = apiEntity(value, 'board');
  const open = array(item.openQuestions, 'board.openQuestions', parseQuestion);
  const recent = item.recentQuestions === undefined
    ? []
    : array(item.recentQuestions, 'board.recentQuestions', parseQuestion);
  const questionsById = new Map(recent.map((question) => [question.questionId, question]));
  for (const question of open) questionsById.set(question.questionId, question);
  return {
    project: parseProject(item.project, 'board.project'),
    agents: array(item.agents, 'board.agents', parseAgent),
    tasks: array(item.tasks, 'board.tasks', parseTask),
    questions: [...questionsById.values()],
    runs: array(item.recentRuns, 'board.recentRuns', parseRun),
    interrupts: array(item.recentInterrupts, 'board.recentInterrupts', parseInterrupt),
    events: array(item.recentEvents, 'board.recentEvents', parseEvent),
    documents: array(item.documents, 'board.documents', parseDocumentSummary),
  };
}
