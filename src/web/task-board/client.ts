import type {
  AgentQueryConversationTurn,
  AgentRole,
  AgentStatus,
  AutomationAgentType,
  AutomationConfiguration,
  AutomationStageConfiguration,
  AutomationStageExecutor,
  BoardAgent,
  BoardDocument,
  BoardDocumentSummary,
  BoardMessage,
  BoardProject,
  BoardQuestion,
  BoardRun,
  BoardSnapshot,
  BoardTask,
  BoardTaskPhase,
  BoardWorkItem,
  CreateAgentInput,
  CreateDocumentInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateWorkItemInput,
  ProjectArtifact,
  ProjectWorkflow,
  WorkflowEvent,
  RunStatus,
  SaveAutomationConfigurationInput,
  TaskStatus,
  TaskKind,
  TaskPhaseStage,
  TaskPhaseStatus,
  WakeReason,
  WorkItemPriority,
  WorkItemProjectTarget,
  WorkItemStage,
  WorkItemState,
} from './types';
import { AUTOMATION_STAGE_ALLOWED_ROLES, AUTOMATION_STAGE_ORDER } from './types';
import {
  apiVersion,
  documentActorTypes,
  evaluatorProfiles,
  maximumAutomationConfigurationBytes,
  messageKinds,
  questionStatuses,
  rawAgentStatuses,
  rawRunStatuses,
  rawTaskStatuses,
  rawWorkerConnections,
  roles,
  taskKinds,
  taskPhaseStages,
  taskPhaseStatuses,
  wakeReasons,
  workItemPageSize,
  workItemPriorities,
  workItemStages,
  workItemStates,
  type WireAgentStatus,
  type WireRunStatus,
  type WireTaskStatus,
  type WireWorkerConnection,
} from './wire';

type JsonRecord = Record<string, unknown>;

const actorTypes = new Set(['human', 'agent'] as const);
const automationExecutorKinds = new Set<AutomationStageExecutor['kind']>(['agent_type', 'human', 'disabled']);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const skillIdentifierPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
// Client-side paging for task messages. Deliberately NOT the contract's
// WORK_ITEM_PAGE_SIZE — same value today, different concerns.
const taskMessagePageSize = 200;
const maximumTaskMessages = 10_000;
const maximumAgentQueryObjectiveCharacters = 8_000;
const maximumAgentQueryConversationCharacters = 2_400;
const maximumAgentQueryConversationTurns = 12;
const maximumAgentQueryTurnCharacters = 480;
const maximumWorkItemPages = 50;
const maximumRawWorkItems = 10_000;
const maximumWorkItemCursorBytes = 512;

export const agentQueryConversationContextMarker = '\n\nRecent POC conversation (context only; newest request is above):\n';
export const agentQueryRoutingContextMarker = '\n\nCompany routing map (use this only to identify the best project or agent):\n';

export function agentQueryPromptFromObjective(objective: string): string {
  const sectionIndexes = [
    objective.indexOf(agentQueryConversationContextMarker),
    objective.indexOf(agentQueryRoutingContextMarker),
  ].filter((index) => index >= 0);
  const promptEnd = sectionIndexes.length > 0 ? Math.min(...sectionIndexes) : objective.length;
  return objective.slice(0, promptEnd).trim();
}

function compactAgentQueryText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function truncateAgentQueryText(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) return value;
  if (maximumCharacters <= 1) return '…'.slice(0, maximumCharacters);
  return `${value.slice(0, maximumCharacters - 1).trimEnd()}…`;
}

function recentAgentQueryConversation(
  turns: AgentQueryConversationTurn[],
  newestPrompt: string,
): string {
  const newestPromptKey = compactAgentQueryText(newestPrompt);
  const selected: string[] = [];
  const seen = new Set<string>();
  let characters = 0;

  for (let index = turns.length - 1; index >= 0 && selected.length < maximumAgentQueryConversationTurns; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    const body = compactAgentQueryText(turn.body);
    if (!body || (turn.role === 'human' && body === newestPromptKey)) continue;
    const key = `${turn.role}\u0000${body}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const label = turn.role === 'human' ? 'Human' : 'Agent';
    const line = `${label}: ${truncateAgentQueryText(body, maximumAgentQueryTurnCharacters)}`;
    const separatorCharacters = selected.length > 0 ? 1 : 0;
    if (characters + separatorCharacters + line.length > maximumAgentQueryConversationCharacters) break;
    selected.unshift(line);
    characters += separatorCharacters + line.length;
  }

  return selected.join('\n');
}

function appendAgentQuerySection(objective: string, marker: string, content: string): string {
  if (!content) return objective;
  const availableCharacters = maximumAgentQueryObjectiveCharacters - objective.length - marker.length;
  if (availableCharacters <= 0) return objective;
  return `${objective}${marker}${truncateAgentQueryText(content, availableCharacters)}`;
}

interface RawProject {
  projectId: string;
  name: string;
  description: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface RawWorkItem {
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

interface RawAgent {
  agentId: string;
  projectId: string;
  role: AgentRole;
  area: string;
  mission: string;
  model: string;
  status: WireAgentStatus;
  workerConnection: WireWorkerConnection;
  createdAt: string;
}

interface RawDocumentPenHolder {
  actorType: 'human' | 'agent';
  actorId: string;
  clientId: string;
  acquiredAt: string;
}

interface RawDocumentSummary {
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

interface RawDocument extends RawDocumentSummary {
  content: string;
}

interface RawTask {
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

interface RawTaskPhase {
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

interface RawQuestion {
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

interface RawRun {
  runId: string;
  projectId: string;
  agentId: string;
  taskId: string | null;
  status: WireRunStatus;
  startedAt: string;
  endedAt: string | null;
}

interface RawInterrupt {
  sequence: number;
  agentId: string;
  runId: string | null;
  requestedAt: string;
}

interface RawEvent {
  eventId: string;
  projectId: string;
  taskId: string | null;
  actorType: 'human' | 'agent' | 'system';
  actorId: string;
  eventType: string;
  data: JsonRecord;
  createdAt: string;
}

interface RawMessage {
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

interface RawBoard {
  project: RawProject;
  agents: RawAgent[];
  tasks: RawTask[];
  questions: RawQuestion[];
  runs: RawRun[];
  interrupts: RawInterrupt[];
  events: RawEvent[];
  documents: RawDocumentSummary[];
}

function record(value: unknown, path: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function exactRecord(value: unknown, path: string, fields: readonly string[]): JsonRecord {
  const item = record(value, path);
  const expected = new Set(fields);
  const unsupported = Object.keys(item).find((key) => !expected.has(key));
  if (unsupported) throw new Error(`${path}.${unsupported} is not supported`);
  const missing = fields.find((key) => !(key in item));
  if (missing) throw new Error(`${path}.${missing} is required`);
  return item;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
}

function boundedText(value: unknown, path: string, maximum: number, allowEmpty = false): string {
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

function identifier(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!identifierPattern.test(parsed)) throw new Error(`${path} must be a valid identifier`);
  return parsed;
}

function skillIdentifier(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!skillIdentifierPattern.test(parsed)) {
    throw new Error(`${path} must be a lowercase skill identifier, not a URL or path`);
  }
  return parsed;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return string(value, path);
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${path} must be a safe integer of at least ${minimum}`);
  }
  return Number(value);
}

function timestamp(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (Number.isNaN(Date.parse(parsed))) throw new Error(`${path} must be a timestamp`);
  return parsed;
}

function nullableTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : timestamp(value, path);
}

function member<T extends string>(value: unknown, values: ReadonlySet<T>, path: string): T {
  const parsed = string(value, path);
  if (!values.has(parsed as T)) throw new Error(`${path} has an unsupported value`);
  return parsed as T;
}

function array<T>(value: unknown, path: string, parse: (item: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => parse(item, `${path}[${index}]`));
}

function apiEntity(value: unknown, path: string): JsonRecord {
  const item = record(value, path);
  if (item.apiVersion !== apiVersion) throw new Error(`${path}.apiVersion is incompatible`);
  return item;
}

function parseProject(value: unknown, path: string): RawProject {
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

function parseWorkItemProjectTarget(value: unknown, path: string): WorkItemProjectTarget {
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

function parseWorkItem(value: unknown, path: string): RawWorkItem {
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

function parseAutomationAgentType(value: unknown, path: string): AutomationAgentType {
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

function parseAutomationExecutor(value: unknown, path: string): AutomationStageExecutor {
  const item = record(value, path);
  const kind = member(item.kind, automationExecutorKinds, `${path}.kind`);
  if (kind === 'agent_type') {
    const exact = exactRecord(item, path, ['kind', 'agentTypeId']);
    return { kind, agentTypeId: identifier(exact.agentTypeId, `${path}.agentTypeId`) };
  }
  exactRecord(item, path, ['kind']);
  return { kind };
}

function parseAutomationStage(value: unknown, path: string): AutomationStageConfiguration {
  const item = exactRecord(value, path, ['stage', 'executor']);
  return {
    stage: member(item.stage, workItemStages, `${path}.stage`),
    executor: parseAutomationExecutor(item.executor, `${path}.executor`),
  };
}

function validateAutomationParts(
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

function automationAgentTypeWire(agentType: AutomationAgentType): JsonRecord {
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

function automationStageWire(entry: AutomationStageConfiguration): JsonRecord {
  return {
    stage: entry.stage,
    executor: entry.executor.kind === 'agent_type'
      ? { kind: entry.executor.kind, agentTypeId: entry.executor.agentTypeId }
      : { kind: entry.executor.kind },
  };
}

function validateAutomationPayloadSize(
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

function parseAutomationConfiguration(value: unknown, path: string): AutomationConfiguration {
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

function automationConfigurationFromEnvelope(value: unknown, path: string): AutomationConfiguration {
  const envelope = exactRecord(value, path, ['configuration']);
  return parseAutomationConfiguration(envelope.configuration, `${path}.configuration`);
}

function automationConfigurationUpdateBody(input: SaveAutomationConfigurationInput): JsonRecord {
  const version = integer(input.version, 'automation configuration update.version', 1);
  const rawAgentTypes = input.agentTypes.map(automationAgentTypeWire);
  const agentTypes = rawAgentTypes.map((agentType, index) => parseAutomationAgentType(agentType, `automation configuration update.agentTypes[${index}]`));
  const rawStages = input.stages.map(automationStageWire);
  const stages = rawStages.map((entry, index) => parseAutomationStage(entry, `automation configuration update.stages[${index}]`));
  validateAutomationParts(agentTypes, stages, 'automation configuration update');
  validateAutomationPayloadSize(agentTypes, stages, 'automation configuration update');
  return { version, agentTypes: rawAgentTypes, stages: rawStages };
}

function parseAgent(value: unknown, path: string): RawAgent {
  const item = apiEntity(value, path);
  const workerConnection = item.workerConnection === undefined || item.workerConnection === null
    ? null
    : member(item.workerConnection, rawWorkerConnections, `${path}.workerConnection`);
  return {
    agentId: string(item.agentId, `${path}.agentId`),
    projectId: string(item.projectId, `${path}.projectId`),
    role: member(item.role, roles, `${path}.role`),
    area: string(item.area, `${path}.area`),
    mission: string(item.mission, `${path}.mission`),
    model: string(item.model, `${path}.model`),
    status: member(item.status, rawAgentStatuses, `${path}.status`),
    workerConnection,
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
  };
}

function parseDocumentPenHolder(value: unknown, path: string): RawDocumentPenHolder {
  const item = record(value, path);
  return {
    actorType: member(item.actorType, documentActorTypes, `${path}.actorType`),
    actorId: string(item.actorId, `${path}.actorId`),
    clientId: string(item.clientId, `${path}.clientId`),
    acquiredAt: timestamp(item.acquiredAt, `${path}.acquiredAt`),
  };
}

function parseDocumentSummary(value: unknown, path: string): RawDocumentSummary {
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

function parseDocument(value: unknown, path: string): RawDocument {
  const item = apiEntity(value, path);
  return {
    ...parseDocumentSummary(item, path),
    content: string(item.content, `${path}.content`),
  };
}

function parseTask(value: unknown, path: string): RawTask {
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
    expectedCompletedAt: status === 'completed' || status === 'failed' || status === 'cancelled'
      ? null
      : projectedCompletion,
    endedAt: nullableTimestamp(item.endedAt, `${path}.endedAt`),
    result: nullableString(item.result, `${path}.result`),
    version: integer(item.version, `${path}.version`, 1),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
  };
}

function parseTaskPhase(value: unknown, path: string): RawTaskPhase {
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

function parseQuestion(value: unknown, path: string): RawQuestion {
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

function parseRun(value: unknown, path: string): RawRun {
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

function parseInterrupt(value: unknown, path: string): RawInterrupt {
  const item = apiEntity(value, path);
  return {
    sequence: integer(item.sequence, `${path}.sequence`, 1),
    agentId: string(item.agentId, `${path}.agentId`),
    runId: nullableString(item.runId, `${path}.runId`),
    requestedAt: timestamp(item.requestedAt, `${path}.requestedAt`),
  };
}

function parseEvent(value: unknown, path: string): RawEvent {
  const item = apiEntity(value, path);
  const actorType = string(item.actorType, `${path}.actorType`);
  if (actorType !== 'human' && actorType !== 'agent' && actorType !== 'system') {
    throw new Error(`${path}.actorType has an unsupported value`);
  }
  return {
    eventId: string(item.eventId, `${path}.eventId`),
    projectId: string(item.projectId, `${path}.projectId`),
    taskId: nullableString(item.taskId, `${path}.taskId`),
    actorType,
    actorId: string(item.actorId, `${path}.actorId`),
    eventType: string(item.eventType, `${path}.eventType`),
    data: record(item.data, `${path}.data`),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
  };
}

function parseMessage(value: unknown, path: string): RawMessage {
  const item = apiEntity(value, path);
  return {
    messageId: string(item.messageId, `${path}.messageId`),
    sequence: integer(item.sequence, `${path}.sequence`, 1),
    projectId: string(item.projectId, `${path}.projectId`),
    taskId: string(item.taskId, `${path}.taskId`),
    actorType: member(item.actorType, actorTypes, `${path}.actorType`),
    actorId: string(item.actorId, `${path}.actorId`),
    kind: member(item.kind, messageKinds, `${path}.kind`),
    body: string(item.body, `${path}.body`),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
  };
}

function parseRawBoard(value: unknown): RawBoard {
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

function taskStatus(status: RawTask['status'], hasOpenQuestion: boolean): TaskStatus {
  if (hasOpenQuestion) return 'waiting_for_human';
  const statuses: Record<RawTask['status'], TaskStatus> = {
    backlog: 'backlog',
    queued: 'queued',
    in_progress: 'running',
    blocked: 'blocked',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'interrupted',
  };
  return statuses[status];
}

function agentStatus(status: RawAgent['status']): AgentStatus {
  const statuses: Record<RawAgent['status'], AgentStatus> = {
    idle: 'sleeping',
    ready: 'queued',
    running: 'running',
    interrupting: 'interrupting',
    waiting_for_human: 'waiting_for_human',
  };
  return statuses[status];
}

function runStatus(status: RawRun['status']): RunStatus {
  return status === 'active' ? 'running' : status;
}

function eventRunId(event: RawEvent): string | null {
  return typeof event.data.runId === 'string' ? event.data.runId : null;
}

function eventWakeReason(event: RawEvent): WakeReason | null {
  const value = event.data.wakeReason;
  return typeof value === 'string' && wakeReasons.has(value as WakeReason) ? value as WakeReason : null;
}

function newest(values: Array<string | null | undefined>, fallback: string): string {
  return values.filter((value): value is string => typeof value === 'string').sort().at(-1) ?? fallback;
}

function documentSummary(raw: RawDocumentSummary): BoardDocumentSummary {
  return {
    id: raw.documentId,
    projectId: raw.projectId,
    title: raw.title,
    contentType: raw.contentType,
    contentVersion: raw.contentVersion,
    penEpoch: raw.penEpoch,
    penHolder: raw.penHolder === null ? null : { ...raw.penHolder },
    sequence: raw.sequence,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function documentProjection(raw: RawDocument): BoardDocument {
  return { ...documentSummary(raw), content: raw.content };
}

function projectProjection(raw: RawProject): BoardProject {
  return {
    id: raw.projectId,
    name: raw.name,
    description: raw.description,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function workItemProjection(raw: RawWorkItem): BoardWorkItem {
  return {
    id: raw.workItemId,
    originalRequest: raw.originalRequest,
    refinedObjective: raw.refinedObjective,
    priority: raw.priority,
    projectTarget: { ...raw.projectTarget },
    resolvedProjectId: raw.resolvedProjectId,
    state: raw.state,
    currentStage: raw.currentStage,
    createdBy: raw.createdBy,
    version: raw.version,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    endedAt: raw.endedAt,
  };
}

function normalize(boards: RawBoard[], listedProjects: RawProject[], rawMessages: RawMessage[], rawWorkItems: RawWorkItem[]): BoardSnapshot {
  const tasksById = new Map<string, BoardTask>();
  const allRawTasks = boards.flatMap((board) => board.tasks);
  const questions: BoardQuestion[] = boards.flatMap((board) => board.questions.map((question) => ({
    id: question.questionId,
    projectId: question.projectId,
    taskId: question.taskId,
    agentId: question.agentId,
    prompt: question.question,
    status: question.status,
    answer: question.answer,
    askedAt: question.askedAt,
    answeredAt: question.answeredAt,
    version: question.version,
  })));
  const openQuestionTasks = new Set(questions.filter((question) => question.status === 'open').map((question) => question.taskId));
  for (const [index, raw] of allRawTasks.entries()) {
    const phases: BoardTaskPhase[] = raw.phases.map((phase) => ({
      id: phase.phaseId,
      title: phase.title,
      stage: phase.stage,
      status: phase.status,
      parallelGroup: phase.parallelGroup,
      orderKey: phase.orderKey,
      startedAt: phase.startedAt,
      endedAt: phase.endedAt,
      version: phase.version,
      createdAt: phase.createdAt,
      updatedAt: phase.updatedAt,
    }));
    tasksById.set(raw.taskId, {
      id: raw.taskId,
      projectId: raw.projectId,
      parentTaskId: raw.parentTaskId,
      kind: raw.kind,
      requiredRole: raw.requiredRole,
      requiresReview: raw.requiresReview,
      title: raw.title,
      objective: raw.objective,
      acceptanceCriteria: raw.acceptanceCriteria,
      workspaceRefs: raw.workspaceRefs,
      assignedAgentId: raw.assignedAgentId,
      assignedRole: raw.assignedRole,
      status: taskStatus(raw.status, openQuestionTasks.has(raw.taskId)),
      expectedAgentMinutes: raw.expectedAgentMinutes,
      estimateRecordedAt: raw.estimateRecordedAt,
      expectedCompletedAt: raw.expectedCompletedAt,
      orderKey: raw.orderKey ?? index * 1024,
      phases,
      startedAt: raw.startedAt,
      endedAt: raw.endedAt,
      result: raw.result,
      version: raw.version,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }

  const runs: BoardRun[] = [];
  for (const board of boards) {
    const runEvents = new Map(board.events.map((event) => [eventRunId(event), event]));
    for (const raw of board.runs) {
      const event = runEvents.get(raw.runId);
      const taskId = raw.taskId ?? event?.taskId ?? null;
      if (!taskId) continue;
      const interrupt = board.interrupts.find((item) => item.runId === raw.runId);
      runs.push({
        id: raw.runId,
        projectId: raw.projectId,
        taskId,
        agentId: raw.agentId,
        status: runStatus(raw.status),
        wakeReason: event ? eventWakeReason(event) : null,
        startedAt: raw.startedAt,
        endedAt: raw.endedAt,
        interruptRequestedAt: interrupt?.requestedAt ?? null,
        createdAt: raw.startedAt,
      });
    }
  }

  const agents: BoardAgent[] = boards.flatMap((board) => board.agents.map((raw) => {
    const owned = allRawTasks.filter((task) => task.assignedAgentId === raw.agentId);
    const current = owned.find((task) => task.status === 'in_progress' || task.status === 'blocked')
      ?? owned.find((task) => task.status === 'queued')
      ?? null;
    const activity = board.events.filter((event) => event.actorId === raw.agentId).map((event) => event.createdAt);
    return {
      id: raw.agentId,
      projectId: raw.projectId,
      name: raw.agentId,
      role: raw.role,
      area: raw.area,
      mission: raw.mission,
      model: raw.model,
      status: agentStatus(raw.status),
      workerConnection: raw.workerConnection,
      currentTaskId: current?.taskId ?? null,
      lastEventAt: newest(activity, raw.createdAt),
      createdAt: raw.createdAt,
      updatedAt: newest(activity, raw.createdAt),
    };
  }));

  const projects = listedProjects.map(projectProjection);
  const workItems = rawWorkItems.map(workItemProjection);
  const tasks = [...tasksById.values()];
  const messages: BoardMessage[] = rawMessages.map((message) => ({
    id: message.messageId,
    projectId: message.projectId,
    taskId: message.taskId,
    authorType: message.actorType,
    authorId: message.actorId,
    kind: message.kind,
    body: message.body,
    createdAt: message.createdAt,
  }));
  const documents = boards.flatMap((board) => board.documents.map(documentSummary));
  const generatedAt = newest([
    ...workItems.map((workItem) => workItem.updatedAt),
    ...projects.map((project) => project.updatedAt),
    ...boards.flatMap((board) => board.events.map((event) => event.createdAt)),
    ...messages.map((message) => message.createdAt),
    ...documents.map((document) => document.updatedAt),
  ], new Date(0).toISOString());
  return {
    revision: workItems.reduce((sum, workItem) => sum + workItem.version, 0)
      + projects.reduce((sum, project) => sum + (listedProjects.find((raw) => raw.projectId === project.id)?.version ?? 0), 0)
      + tasks.reduce((sum, task) => sum + task.version, 0)
      + tasks.reduce((sum, task) => sum + task.phases.reduce((phaseSum, phase) => phaseSum + phase.version, 0), 0)
      + documents.reduce((sum, document) => sum + document.sequence, 0),
    generatedAt,
    workItems,
    projects,
    agents,
    tasks,
    messages,
    questions,
    runs,
    documents,
  };
}

/** Parses the task-board's authoritative single-project snapshot into the frontend projection. */
export function parseBoardSnapshot(value: unknown): BoardSnapshot {
  const board = parseRawBoard(value);
  return normalize([board], [board.project], [], []);
}

/** Parses one authoritative document snapshot returned by the task board. */
export function parseBoardDocument(value: unknown): BoardDocument {
  return documentProjection(parseDocument(value, 'document'));
}

function documentFromEnvelope(value: unknown, path: string): BoardDocument {
  const envelope = record(value, path);
  return documentProjection(parseDocument(envelope.document, `${path}.document`));
}

function projectFromEnvelope(value: unknown, path: string): BoardProject {
  const envelope = record(value, path);
  return projectProjection(parseProject(envelope.project, `${path}.project`));
}

function workItemFromEnvelope(value: unknown, path: string): BoardWorkItem {
  const envelope = record(value, path);
  return workItemProjection(parseWorkItem(envelope.workItem, `${path}.workItem`));
}

function workItemPageFromEnvelope(value: unknown, path: string): {
  workItems: RawWorkItem[];
  nextCursor: string | null;
} {
  const envelope = record(value, path);
  if (!Array.isArray(envelope.workItems)) throw new Error(`${path}.workItems must be an array`);
  if (envelope.workItems.length > workItemPageSize) {
    throw new Error(`${path}.workItems cannot contain more than ${workItemPageSize} records`);
  }
  const workItems = envelope.workItems.map((item, index) => parseWorkItem(item, `${path}.workItems[${index}]`));
  if (!('nextCursor' in envelope)) return { workItems, nextCursor: null };
  const nextCursor = string(envelope.nextCursor, `${path}.nextCursor`);
  if (
    nextCursor.length === 0
    || new TextEncoder().encode(nextCursor).byteLength > maximumWorkItemCursorBytes
  ) {
    throw new Error(`${path}.nextCursor must be a nonempty string no larger than ${maximumWorkItemCursorBytes} UTF-8 bytes`);
  }
  return { workItems, nextCursor };
}

export class BoardApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BoardApiError';
  }
}

export class DocumentStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentStreamError';
  }
}

export interface TaskBoardClient {
  readonly documentClientId: string;
  getSnapshot(signal?: AbortSignal): Promise<BoardSnapshot>;
  getAutomationConfiguration(signal?: AbortSignal): Promise<AutomationConfiguration>;
  saveAutomationConfiguration(input: SaveAutomationConfigurationInput): Promise<AutomationConfiguration>;
  getDocument(documentId: string, signal?: AbortSignal): Promise<BoardDocument>;
  createDocument(input: CreateDocumentInput): Promise<BoardDocument>;
  changeDocumentPen(documentId: string, input: {
    action: 'acquire' | 'release';
    expectedPenEpoch: number;
    force: boolean;
  }): Promise<BoardDocument>;
  saveDocumentSnapshot(documentId: string, input: {
    penEpoch: number;
    contentVersion: number;
    content: string;
  }): Promise<BoardDocument>;
  subscribeDocument(input: {
    documentId: string;
    after: number;
    signal: AbortSignal;
    onDocument: (document: BoardDocument) => void;
  }): Promise<void>;
  createProject(input: CreateProjectInput): Promise<BoardProject>;
  createWorkItem(input: CreateWorkItemInput): Promise<BoardWorkItem>;
  createAgent(input: CreateAgentInput): Promise<void>;
  createTask(input: CreateTaskInput): Promise<void>;
  createAgentQuery(input: {
    projectId: string;
    agentId: string;
    assignedRole: AgentRole;
    prompt: string;
    workspaceRefs: string[];
    routingContext?: string;
    recentConversation?: AgentQueryConversationTurn[];
  }): Promise<void>;
  assignTask(taskId: string, input: { agentId: string; version: number }): Promise<void>;
  reorderTask(taskId: string, input: { orderKey: number; version: number }): Promise<void>;
  returnTaskToBacklog(taskId: string, input: { version: number }): Promise<void>;
  addMessage(taskId: string, input: { body: string; version: number }): Promise<void>;
  answerQuestion(questionId: string, input: { answer: string }): Promise<void>;
  resumeTask(taskId: string, input: { version: number }): Promise<void>;
  decideHumanCheck(taskId: string, input: { version: number; status: 'completed' | 'failed'; result: string }): Promise<void>;
  interruptRun(runId: string): Promise<void>;
  getProjectWorkflow(projectId: string, signal?: AbortSignal): Promise<ProjectWorkflow>;
  getProjectArtifacts(projectId: string, signal?: AbortSignal): Promise<ProjectArtifact[]>;
  confirmWorkflow(planRevisionId: string): Promise<ProjectWorkflow>;
  subscribeProjectEvents(input: {
    projectId: string;
    after: number;
    signal: AbortSignal;
    onEvent: (event: WorkflowEvent) => void;
  }): Promise<void>;
  getArtifactBlob(artifactId: string, signal?: AbortSignal): Promise<Blob>;
  uploadArtifact(projectId: string, input: {
    mediaType: string;
    caption: string;
    contentBase64: string;
  }): Promise<ProjectArtifact>;
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = `Task board request failed (${response.status})`;
  try {
    const value = record(await response.json(), 'error response');
    const error = record(value.error, 'error response.error');
    return typeof error.message === 'string' && error.message.length > 0 ? error.message : fallback;
  } catch {
    return fallback;
  }
}

export function randomUuid(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  if (typeof source?.getRandomValues !== 'function') {
    throw new Error('This browser cannot generate secure random identifiers');
  }
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

function clientEventId(): string {
  return `ui-${randomUuid()}`;
}

function safeBaseUrl(value: string): string {
  const trimmed = value.replace(/\/$/, '');
  if (trimmed === '' || (trimmed.startsWith('/') && !trimmed.startsWith('//'))) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Task board URL is invalid');
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.username || parsed.password || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))) {
    throw new Error('Task board credentials require HTTPS or a loopback URL');
  }
  if (parsed.search || parsed.hash) throw new Error('Task board URL cannot include a query or fragment');
  return trimmed;
}

const documentClientStorageKey = 'cicada.documentClientId';
const documentClientOwnerStoragePrefix = 'cicada.documentClientOwner.';
const documentClientRuntimeNonce = `document-runtime-${randomUuid()}`;
let runtimeDocumentClientId: string | null = null;
let runtimeDocumentClientOwnerKey: string | null = null;
let documentClientCleanupRegistered = false;

function newDocumentClientId(): string {
  return `document-ui-${randomUuid()}`;
}

function documentClientOwnerKey(clientId: string): string {
  return `${documentClientOwnerStoragePrefix}${clientId}`;
}

function registerDocumentClientCleanup(): void {
  if (documentClientCleanupRegistered || typeof globalThis.addEventListener !== 'function') return;
  documentClientCleanupRegistered = true;
  globalThis.addEventListener('pagehide', (event) => {
    if ('persisted' in event && event.persisted === true) return;
    const ownerKey = runtimeDocumentClientOwnerKey;
    if (!ownerKey) return;
    try {
      if (globalThis.localStorage?.getItem(ownerKey) === documentClientRuntimeNonce) {
        globalThis.localStorage.removeItem(ownerKey);
      }
    } catch {
      // A storage policy change must not make page navigation fail.
    }
  });
}

function claimDocumentClientId(clientId: string, storage: Storage): boolean {
  const ownerKey = documentClientOwnerKey(clientId);
  const currentOwner = storage.getItem(ownerKey);
  if (currentOwner && currentOwner !== documentClientRuntimeNonce) return false;
  storage.setItem(ownerKey, documentClientRuntimeNonce);
  if (storage.getItem(ownerKey) !== documentClientRuntimeNonce) return false;
  runtimeDocumentClientOwnerKey = ownerKey;
  registerDocumentClientCleanup();
  return true;
}

function stableDocumentClientId(configured?: string): string {
  const supplied = configured?.trim();
  if (supplied) return supplied;
  if (runtimeDocumentClientId) return runtimeDocumentClientId;

  let session: Storage | undefined;
  try {
    session = globalThis.sessionStorage;
    const local = globalThis.localStorage;
    if (!session || !local) throw new Error('Browser storage is unavailable');

    const stored = session.getItem(documentClientStorageKey)?.trim();
    let selected: string | null = null;
    if (stored && claimDocumentClientId(stored, local)) {
      selected = stored;
    } else {
      for (let attempt = 0; attempt < 3 && !selected; attempt += 1) {
        const candidate = newDocumentClientId();
        if (claimDocumentClientId(candidate, local)) selected = candidate;
      }
    }
    if (!selected) throw new Error('Document client ownership could not be claimed');
    session.setItem(documentClientStorageKey, selected);
    runtimeDocumentClientId = selected;
  } catch {
    // Without a shared ownership claim, reusing copied session storage is unsafe.
    const claimedOwnerKey = runtimeDocumentClientOwnerKey;
    try {
      if (claimedOwnerKey && globalThis.localStorage?.getItem(claimedOwnerKey) === documentClientRuntimeNonce) {
        globalThis.localStorage.removeItem(claimedOwnerKey);
      }
    } catch {
      // Storage is already known to be unreliable; continue with runtime state.
    }
    runtimeDocumentClientOwnerKey = null;
    runtimeDocumentClientId = newDocumentClientId();
    try {
      session?.setItem(documentClientStorageKey, runtimeDocumentClientId);
    } catch {
      // The runtime-scoped value still keeps repeated client creation stable.
    }
  }
  return runtimeDocumentClientId;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      result[index] = await operation(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}

const maximumDocumentEventBytes = 2 * 1024 * 1024;

function dispatchDocumentEvent(
  frame: string,
  onDocument: (document: BoardDocument) => void,
): void {
  let eventName = 'message';
  let eventId: string | null = null;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (line === '' || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'id') eventId = value;
    else if (field === 'data') data.push(value);
  }
  if (eventName !== 'document') return;
  if (eventId === null || !/^(?:0|[1-9]\d*)$/u.test(eventId)) {
    throw new DocumentStreamError('The document stream returned an invalid event cursor.');
  }
  const sequence = Number(eventId);
  if (!Number.isSafeInteger(sequence)) throw new DocumentStreamError('The document stream cursor is too large.');
  let decoded: unknown;
  try {
    decoded = JSON.parse(data.join('\n')) as unknown;
  } catch {
    throw new DocumentStreamError('The document stream returned invalid JSON.');
  }
  const envelope = record(decoded, 'document event');
  const document = documentProjection(parseDocument(envelope.document, 'document event.document'));
  if (document.sequence !== sequence) {
    throw new DocumentStreamError('The document stream cursor does not match its document snapshot.');
  }
  onDocument(document);
}

async function consumeDocumentStream(
  response: Response,
  onDocument: (document: BoardDocument) => void,
): Promise<void> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^text\/event-stream(?:\s*;|$)/iu.test(contentType)) {
    throw new DocumentStreamError('The document stream did not return server-sent events.');
  }
  if (!response.body) throw new DocumentStreamError('The document stream returned no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const next = await reader.read();
      pending += decoder.decode(next.value, { stream: !next.done });
      let boundary = /\r?\n\r?\n/u.exec(pending);
      while (boundary) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        if (frame.length > maximumDocumentEventBytes) {
          throw new DocumentStreamError('A document stream event exceeded the size limit.');
        }
        if (frame.trim().length > 0) dispatchDocumentEvent(frame, onDocument);
        boundary = /\r?\n\r?\n/u.exec(pending);
      }
      if (pending.length > maximumDocumentEventBytes) {
        throw new DocumentStreamError('A document stream event exceeded the size limit.');
      }
      if (next.done) break;
    }
    if (pending.trim().length > 0) dispatchDocumentEvent(pending, onDocument);
  } finally {
    reader.releaseLock();
  }
}

export function createTaskBoardClient(options: {
  baseUrl?: string;
  token?: string;
  fetch?: typeof fetch;
  documentClientId?: string;
} = {}): TaskBoardClient {
  const baseUrl = safeBaseUrl(options.baseUrl ?? '');
  const token = options.token?.trim() ?? '';
  const requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const documentClientId = stableDocumentClientId(options.documentClientId);
  const agentRoles = new Map<string, CreateAgentInput['role']>();
  const questionVersions = new Map<string, number>();
  const taskAgents = new Map<string, string>();
  const taskPolicies = new Map<string, Readonly<{ kind: TaskKind; requiredRole: AgentRole | null }>>();
  const runAgents = new Map<string, string>();

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const response = await requestFetch(`${baseUrl}${path}`, {
      ...init,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: {
        ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init?.headers,
      },
    });
    if (!response.ok) throw new BoardApiError(await errorMessage(response), response.status);
    return response;
  }

  async function json(path: string, init?: RequestInit): Promise<unknown> {
    return request(path, init).then((response) => response.json());
  }

  async function post(path: string, body: unknown, idempotencyKey?: string): Promise<void> {
    await request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined,
    });
  }

  async function taskMessages(task: RawTask, signal?: AbortSignal): Promise<RawMessage[]> {
    const messages: RawMessage[] = [];
    let after = 0;
    while (true) {
      const envelope = record(
        await json(`/v1/tasks/${encodeURIComponent(task.taskId)}/messages?after=${after}`, { signal }),
        'messages response',
      );
      const page = array(envelope.messages, 'messages response.messages', parseMessage);
      const cursor = integer(envelope.cursor, 'messages response.cursor');
      if (page.length > taskMessagePageSize) throw new Error('messages response exceeded the page size limit');
      if (cursor < after) throw new Error('messages response cursor moved backwards');
      if (page.length === 0) {
        if (cursor !== after) throw new Error('messages response cursor advanced without messages');
        return messages;
      }
      if (cursor === after) throw new Error('messages response cursor did not advance');

      let previousSequence = after;
      for (const message of page) {
        if (message.taskId !== task.taskId || message.projectId !== task.projectId) {
          throw new Error('messages response belongs to another task or project');
        }
        if (message.sequence <= previousSequence) throw new Error('messages response is not in chronological order');
        previousSequence = message.sequence;
      }
      if (cursor !== previousSequence) throw new Error('messages response cursor does not match its final message');
      if (messages.length + page.length > maximumTaskMessages) {
        throw new Error(`messages response exceeded the ${maximumTaskMessages}-message task limit`);
      }
      messages.push(...page);
      if (page.length < taskMessagePageSize) return messages;
      after = cursor;
    }
  }

  async function paginatedWorkItems(initialValue: unknown, signal?: AbortSignal): Promise<RawWorkItem[]> {
    const merged: RawWorkItem[] = [];
    const positionsById = new Map<string, number>();
    const seenCursors = new Set<string>();
    let value = initialValue;
    let pages = 0;
    let rawRows = 0;

    while (true) {
      pages += 1;
      const page = workItemPageFromEnvelope(value, `work items response page ${pages}`);
      rawRows += page.workItems.length;
      if (rawRows > maximumRawWorkItems) {
        throw new Error(`work items response exceeded the ${maximumRawWorkItems.toLocaleString()}-record raw pagination limit`);
      }
      for (const workItem of page.workItems) {
        const position = positionsById.get(workItem.workItemId);
        if (position === undefined) {
          positionsById.set(workItem.workItemId, merged.length);
          merged.push(workItem);
        } else if (workItem.version > merged[position]!.version) {
          merged[position] = workItem;
        }
      }

      const cursor = page.nextCursor;
      if (cursor === null) return merged;
      if (seenCursors.has(cursor)) throw new Error('work items response repeated a pagination cursor');
      seenCursors.add(cursor);
      if (pages >= maximumWorkItemPages || rawRows >= maximumRawWorkItems) {
        throw new Error(`work items response exceeded the ${maximumWorkItemPages}-page or ${maximumRawWorkItems.toLocaleString()}-record pagination limit`);
      }
      value = await json(`/v1/work-items?cursor=${encodeURIComponent(cursor)}`, { signal });
    }
  }

  return {
    documentClientId,
    async getProjectWorkflow(projectId, signal) {
      const envelope = record(await json(`/v1/projects/${encodeURIComponent(projectId)}/workflow`, { signal }), 'workflow response');
      const workflow = record(envelope.workflow, 'workflow response.workflow');
      return {
        plans: array(workflow.plans, 'workflow plans', (value) => record(value, 'workflow plan')) as unknown as ProjectWorkflow['plans'],
        nodes: array(workflow.nodes, 'workflow nodes', (value) => record(value, 'workflow node')) as unknown as ProjectWorkflow['nodes'],
        handoffs: array(workflow.handoffs, 'workflow handoffs', (value) => record(value, 'workflow handoff')) as unknown as ProjectWorkflow['handoffs'],
        events: array(workflow.events, 'workflow events', (value) => record(value, 'workflow event')) as unknown as ProjectWorkflow['events'],
      };
    },
    async getProjectArtifacts(projectId, signal) {
      const envelope = record(await json(`/v1/projects/${encodeURIComponent(projectId)}/artifacts`, { signal }), 'artifacts response');
      return array(envelope.artifacts, 'artifacts response.artifacts', (value) => record(value, 'artifact')) as unknown as ProjectArtifact[];
    },
    async confirmWorkflow(planRevisionId) {
      const envelope = record(await json(`/v1/plans/${encodeURIComponent(planRevisionId)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ expectedState: 'proposed' }),
      }), 'confirm workflow response');
      const workflow = record(envelope.workflow, 'confirm workflow response.workflow');
      return {
        plans: array(workflow.plans, 'workflow plans', (value) => record(value, 'workflow plan')) as unknown as ProjectWorkflow['plans'],
        nodes: array(workflow.nodes, 'workflow nodes', (value) => record(value, 'workflow node')) as unknown as ProjectWorkflow['nodes'],
        handoffs: array(workflow.handoffs, 'workflow handoffs', (value) => record(value, 'workflow handoff')) as unknown as ProjectWorkflow['handoffs'],
        events: array(workflow.events, 'workflow events', (value) => record(value, 'workflow event')) as unknown as ProjectWorkflow['events'],
      };
    },
    async subscribeProjectEvents(input) {
      const response = await request(
        `/v1/projects/${encodeURIComponent(input.projectId)}/workflow/events?after=${input.after}`,
        { signal: input.signal, headers: { accept: 'text/event-stream' } },
      );
      if (!response.body) throw new Error('The workflow event stream returned no body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      try {
        while (true) {
          const chunk = await reader.read();
          pending += decoder.decode(chunk.value, { stream: !chunk.done });
          let boundary = pending.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const data = frame.split(/\r?\n/u).filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
            if (data) {
              const envelope = record(JSON.parse(data) as unknown, 'workflow event');
              input.onEvent(record(envelope.event, 'workflow event.event') as unknown as WorkflowEvent);
            }
            boundary = pending.indexOf('\n\n');
          }
          if (pending.length > 64 * 1_024) throw new Error('A workflow event exceeded the size limit');
          if (chunk.done) return;
        }
      } finally {
        reader.releaseLock();
      }
    },
    async getArtifactBlob(artifactId, signal) {
      return request(`/v1/artifacts/${encodeURIComponent(artifactId)}`, { signal }).then((response) => response.blob());
    },
    async uploadArtifact(projectId, input) {
      const envelope = record(await json(`/v1/projects/${encodeURIComponent(projectId)}/artifacts`, {
        method: 'POST',
        body: JSON.stringify({ nodeId: null, taskId: null, ...input }),
      }), 'upload artifact response');
      return record(envelope.artifact, 'upload artifact response.artifact') as unknown as ProjectArtifact;
    },
    async getSnapshot(signal) {
      const [projectsValue, workItemsValue] = await Promise.all([
        json('/v1/projects', { signal }),
        json('/v1/work-items', { signal }),
      ]);
      const projectsEnvelope = record(projectsValue, 'projects response');
      const projects = array(projectsEnvelope.projects, 'projects response.projects', parseProject);
      const workItems = await paginatedWorkItems(workItemsValue, signal);
      const boards = await mapWithConcurrency(projects, 6, async (project) => {
        return parseRawBoard(await json(`/v1/projects/${encodeURIComponent(project.projectId)}/board`, { signal }));
      });
      const tasks = boards.flatMap((board) => board.tasks);
      const messageGroups = await mapWithConcurrency(tasks, 6, (task) => taskMessages(task, signal));
      const rawMessages = messageGroups.flat();
      agentRoles.clear();
      questionVersions.clear();
      taskAgents.clear();
      taskPolicies.clear();
      runAgents.clear();
      for (const board of boards) {
        for (const agent of board.agents) agentRoles.set(agent.agentId, agent.role);
        for (const question of board.questions) questionVersions.set(question.questionId, question.version);
        for (const task of board.tasks) {
          taskPolicies.set(task.taskId, { kind: task.kind, requiredRole: task.requiredRole });
          if (task.assignedAgentId) taskAgents.set(task.taskId, task.assignedAgentId);
        }
        for (const run of board.runs) runAgents.set(run.runId, run.agentId);
      }
      return normalize(boards, projects, rawMessages, workItems);
    },
    async getAutomationConfiguration(signal) {
      return automationConfigurationFromEnvelope(
        await json('/v1/automation-configuration', { signal }),
        'automation configuration response',
      );
    },
    async saveAutomationConfiguration(input) {
      return automationConfigurationFromEnvelope(
        await json('/v1/automation-configuration', {
          method: 'PATCH',
          body: JSON.stringify(automationConfigurationUpdateBody(input)),
        }),
        'save automation configuration response',
      );
    },
    async getDocument(documentId, signal) {
      return documentFromEnvelope(
        await json(`/v1/documents/${encodeURIComponent(documentId)}`, { signal }),
        'document response',
      );
    },
    async createDocument(input) {
      const title = input.title.trim();
      if (title.length === 0) throw new Error('Enter a document title');
      return documentFromEnvelope(
        await json(`/v1/projects/${encodeURIComponent(input.projectId)}/documents`, {
          method: 'POST',
          body: JSON.stringify({
            title,
            contentType: 'text/markdown',
            content: input.content,
            clientId: documentClientId,
          }),
        }),
        'create document response',
      );
    },
    async changeDocumentPen(documentId, input) {
      return documentFromEnvelope(
        await json(`/v1/documents/${encodeURIComponent(documentId)}/pen`, {
          method: 'POST',
          body: JSON.stringify({
            action: input.action,
            clientId: documentClientId,
            expectedPenEpoch: input.expectedPenEpoch,
            force: input.force,
          }),
        }),
        'document pen response',
      );
    },
    async saveDocumentSnapshot(documentId, input) {
      return documentFromEnvelope(
        await json(`/v1/documents/${encodeURIComponent(documentId)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            clientId: documentClientId,
            penEpoch: input.penEpoch,
            contentVersion: input.contentVersion,
            content: input.content,
          }),
        }),
        'save document response',
      );
    },
    async subscribeDocument(input) {
      if (!Number.isSafeInteger(input.after) || input.after < 0) {
        throw new Error('Document event cursor must be a non-negative safe integer');
      }
      const response = await request(
        `/v1/documents/${encodeURIComponent(input.documentId)}/events?after=${input.after}`,
        { signal: input.signal, headers: { accept: 'text/event-stream' } },
      );
      await consumeDocumentStream(response, input.onDocument);
    },
    async createProject(input) {
      return projectFromEnvelope(
        await json('/v1/projects', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
        'create project response',
      );
    },
    async createWorkItem(input) {
      const originalRequest = input.originalRequest.trim();
      if (originalRequest.length === 0) throw new Error('Enter a task');
      if (originalRequest.length > 16_000) throw new Error('Tasks cannot exceed 16,000 characters');
      const idempotencyKey = input.idempotencyKey.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(idempotencyKey)) {
        throw new Error('Task submission has an invalid idempotency key');
      }
      if (input.projectTarget.mode === 'explicit' && input.projectTarget.projectId.trim().length === 0) {
        throw new Error('Choose a project or use automatic project selection');
      }
      return workItemFromEnvelope(
        await json('/v1/work-items', {
          method: 'POST',
          body: JSON.stringify({
            originalRequest,
            priority: input.priority,
            projectTarget: input.projectTarget,
          }),
          headers: { 'idempotency-key': idempotencyKey },
        }),
        'create work item response',
      );
    },
    async createAgent(input) {
      const { projectId, ...body } = input;
      await post(`/v1/projects/${encodeURIComponent(projectId)}/agents`, body);
    },
    async createTask(input) {
      const { projectId, ...task } = input;
      await post(`/v1/projects/${encodeURIComponent(projectId)}/tasks`, {
        ...task,
        assignedAgentId: null,
        assignedRole: null,
      });
    },
    async createAgentQuery(input) {
      const prompt = input.prompt.trim();
      if (prompt.length === 0) throw new Error('Enter a question or request for this agent');
      if (prompt.length > maximumAgentQueryObjectiveCharacters) throw new Error('Agent questions and requests cannot exceed 8,000 characters');
      const recentConversation = recentAgentQueryConversation(input.recentConversation ?? [], prompt);
      const routingContext = input.routingContext?.trim();
      const objectiveWithConversation = appendAgentQuerySection(
        prompt,
        agentQueryConversationContextMarker,
        recentConversation,
      );
      const objective = appendAgentQuerySection(
        objectiveWithConversation,
        agentQueryRoutingContextMarker,
        routingContext ?? '',
      );
      const workspaceRefs = [...new Set(input.workspaceRefs)].slice(0, 32);
      const titlePrefix = `Request for ${input.agentId}: `;
      const titleSummary = prompt.replace(/\s+/gu, ' ');
      await post(`/v1/projects/${encodeURIComponent(input.projectId)}/tasks`, {
        parentTaskId: null,
        title: `${titlePrefix}${titleSummary}`.slice(0, 240).trimEnd(),
        objective,
        acceptanceCriteria: 'Return a concise answer or result. If more work is needed, propose child tasks for human approval; do not assign agents or deploy.',
        workspaceRefs,
        assignedAgentId: input.agentId,
        assignedRole: input.assignedRole,
        requiresReview: false,
      });
    },
    async assignTask(taskId, input) {
      const role = agentRoles.get(input.agentId);
      if (!role) throw new Error('Refresh the board before assigning this agent');
      const policy = taskPolicies.get(taskId);
      if (!policy) throw new Error('Refresh the board before assigning this task');
      if (policy.kind === 'human_check') throw new Error('Human checks cannot be assigned to agents');
      if (policy.requiredRole !== null && role !== policy.requiredRole) {
        throw new Error(`This task requires a ${policy.requiredRole} agent`);
      }
      await request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: input.version,
          assignedAgentId: input.agentId,
          assignedRole: role,
          status: 'queued',
        }),
      });
    },
    async reorderTask(taskId, input) {
      if (!Number.isSafeInteger(input.orderKey) || input.orderKey < 0) {
        throw new Error('Task order must be a non-negative safe integer');
      }
      await request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: input.version, orderKey: input.orderKey }),
      });
    },
    async returnTaskToBacklog(taskId, input) {
      await request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: input.version,
          assignedAgentId: null,
          assignedRole: null,
          status: 'backlog',
        }),
      });
    },
    async addMessage(taskId, input) {
      void input.version;
      await post(`/v1/tasks/${encodeURIComponent(taskId)}/messages`, {
        clientEventId: clientEventId(),
        kind: 'note',
        body: input.body,
      });
    },
    async answerQuestion(questionId, input) {
      const version = questionVersions.get(questionId);
      if (!version) throw new Error('Refresh the board before answering this question');
      await post(`/v1/questions/${encodeURIComponent(questionId)}/answer`, { answer: input.answer, version });
    },
    async resumeTask(taskId, input) {
      if (taskPolicies.get(taskId)?.kind === 'human_check') throw new Error('Human checks cannot wake an agent');
      const agentId = taskAgents.get(taskId);
      if (!agentId) throw new Error('This task has no assigned agent to resume');
      await post(
        `/v1/agents/${encodeURIComponent(agentId)}/resume`,
        { reason: 'Human explicitly resumed this task', taskId },
        `resume:${taskId}:${input.version}`,
      );
    },
    async decideHumanCheck(taskId, input) {
      if (taskPolicies.get(taskId)?.kind !== 'human_check') throw new Error('Only human checks accept a human release decision');
      const result = input.result.trim();
      if (result.length === 0) throw new Error('A human decision rationale is required');
      await request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: input.version, status: input.status, result }),
      });
    },
    async interruptRun(runId) {
      const agentId = runAgents.get(runId);
      if (!agentId) throw new Error('Refresh the board before interrupting this run');
      await post(
        `/v1/agents/${encodeURIComponent(agentId)}/interrupt`,
        { reason: 'Human interrupted this agent from the task board' },
        `interrupt:${runId}`,
      );
    },
  };
}
