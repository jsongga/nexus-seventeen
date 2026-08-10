/** Browser adapter for the shared task-board runtime contract. */
import type {
  AgentInterrupt,
  AgentProfile,
  AgentRun,
  BoardSnapshot,
  BoardTask,
  DocumentPenHolder,
  DocumentSnapshot,
  DocumentSummary,
  HumanQuestion,
  Project,
  TaskEvent,
  TaskMessage,
  TaskPhase,
  WorkItem,
} from '@shared/task-board-contract';
import {
  BROWSER_SCALAR_MESSAGES,
  PATH_EXACT_MESSAGES,
  arrayOf,
  automationConfigurationPartsBytes,
  booleanValue,
  contractSetMember,
  exact,
  identifier as contractIdentifier,
  integer as contractInteger,
  parseAgentEntity,
  parseAutomationAgentTypeEntity,
  parseAutomationConfigurationEntity,
  parseAutomationExecutorEntity,
  parseAutomationStageEntity,
  parseBoardSnapshotEntity,
  parseDocumentEntity,
  parseDocumentPenHolderEntity,
  parseDocumentSummaryEntity,
  parseEventEntity,
  parseHandoffEntity,
  parseInterruptEntity,
  parseMessageEntity,
  parseNodeEntity,
  parsePlanEntity,
  parseProjectArtifactEntity,
  parseProjectEntity,
  parseProjectEventEntity,
  parseQuestionEntity,
  parseRunEntity,
  parseTaskEntity,
  parseTaskPhaseEntity,
  parseWorkItemEntity,
  prose,
  record as contractRecord,
  skillIdentifier as contractSkillIdentifier,
  stringValue,
  timestamp as contractTimestamp,
  validateAutomationConfigurationParts,
  versionedRecord,
  type JsonRecord,
} from '@shared/task-board-contract/validate';
import type {
  AutomationAgentType,
  AutomationConfiguration,
  AutomationStageConfiguration,
  AutomationStageExecutor,
  ProjectArtifact,
  ProjectWorkflow,
  WorkflowEvent,
  WorkflowHandoff,
  WorkflowNode,
  WorkflowPlan,
} from '../types';
import { maximumAutomationConfigurationBytes, maximumWorkItemCursorBytes } from './wire';

export { maximumWorkItemCursorBytes };
export type { JsonRecord };
export const maximumTaskMessages = 10_000;
export const maximumWorkItemPages = 50;
export const maximumRawWorkItems = 10_000;

type WithMs<T, K extends string> = T & Record<`${K}Ms`, number>;
type WithNullableMs<T, K extends string> = T & Record<`${K}Ms`, number | null>;
type WithoutApi<T> = Omit<T, 'apiVersion'>;
export type RawProject = WithMs<WithMs<WithoutApi<Project>, 'createdAt'>, 'updatedAt'>;
export type RawWorkItem = WithNullableMs<WithNullableMs<WithMs<WithMs<WithoutApi<WorkItem>, 'createdAt'>, 'updatedAt'>, 'endedAt'>, 'archivedAt'>;
export type RawAgent = WithMs<WithoutApi<AgentProfile>, 'createdAt'>;
export type RawDocumentPenHolder = WithMs<DocumentPenHolder, 'acquiredAt'>;
export type RawDocumentSummary = WithMs<WithMs<Omit<WithoutApi<DocumentSummary>, 'penHolder'> & { penHolder: RawDocumentPenHolder | null }, 'createdAt'>, 'updatedAt'>;
export type RawDocument = RawDocumentSummary & Pick<DocumentSnapshot, 'content'>;
export type RawTaskPhase = WithMs<WithMs<WithNullableMs<WithNullableMs<WithoutApi<TaskPhase>, 'startedAt'>, 'endedAt'>, 'createdAt'>, 'updatedAt'>;
export type RawTask = WithMs<WithMs<WithNullableMs<WithNullableMs<WithNullableMs<WithNullableMs<
  Omit<WithoutApi<BoardTask>, 'phases' | 'workspaceRefs'> & { phases: RawTaskPhase[]; workspaceRefs: string[] }, 'estimateRecordedAt'>, 'startedAt'>,
  'expectedCompletedAt'>, 'endedAt'>, 'createdAt'>, 'updatedAt'>;
export type RawQuestion = WithMs<WithNullableMs<Omit<WithoutApi<HumanQuestion>, 'runId' | 'answeredBy'>, 'answeredAt'>, 'askedAt'>;
export type RawRun = WithMs<WithNullableMs<Omit<WithoutApi<AgentRun>, 'claimId' | 'wakeupId' | 'result'>, 'endedAt'>, 'startedAt'>;
export type RawInterrupt = WithMs<Pick<AgentInterrupt, 'sequence' | 'agentId' | 'runId' | 'requestedAt'>, 'requestedAt'>;
export type RawEvent = WithMs<WithoutApi<TaskEvent>, 'createdAt'>;
export type RawMessage = WithMs<Omit<WithoutApi<TaskMessage>, 'runId'>, 'createdAt'>;
export interface RawBoard { project: RawProject; agents: RawAgent[]; tasks: RawTask[]; questions: RawQuestion[]; runs: RawRun[]; interrupts: RawInterrupt[]; events: RawEvent[]; documents: RawDocumentSummary[] }

const loose = {
  exact: false,
  identifiers: 'string',
  projection: 'browser',
  scalarMessages: BROWSER_SCALAR_MESSAGES,
} as const;
const strict = {
  exact: PATH_EXACT_MESSAGES,
  identifierMessages: 'valid-identifier',
  projection: 'browser',
  scalarMessages: BROWSER_SCALAR_MESSAGES,
} as const;
const ms = (value: string): number => Date.parse(value);
const nullableMs = (value: string | null): number | null => value === null ? null : ms(value);
const withoutApiVersion = <T extends { apiVersion: unknown }>(item: T): Omit<T, 'apiVersion'> => {
  const { apiVersion: _apiVersion, ...value } = item;
  return value;
};

export function record(value: unknown, path: string): JsonRecord { return contractRecord(value, path); }
export function exactRecord(value: unknown, path: string, fields: readonly string[]): JsonRecord {
  return exact(value, fields, path, { messages: PATH_EXACT_MESSAGES });
}
export function string(value: unknown, path: string): string { return stringValue(value, path); }
export function boundedText(value: unknown, path: string, maximum: number, allowEmpty = false): string {
  return prose(value, path, {
    maximum,
    allowEmpty,
    message: `${path} must ${allowEmpty ? '' : 'not be empty and '}contain at most ${maximum.toLocaleString()} characters`,
    scalarMessages: BROWSER_SCALAR_MESSAGES,
  });
}
export function integer(value: unknown, path: string, minimum = 0): number { return contractInteger(value, path, minimum); }
export function array<T>(value: unknown, path: string, parse: (item: unknown, path: string) => T): T[] { return arrayOf(value, path, parse); }
export function identifier(value: unknown, path: string): string {
  return contractIdentifier(value, path, `${path} must be a valid identifier`, BROWSER_SCALAR_MESSAGES);
}
export function skillIdentifier(value: unknown, path: string): string {
  return contractSkillIdentifier(value, path, BROWSER_SCALAR_MESSAGES);
}
export function boolean(value: unknown, path: string): boolean { return booleanValue(value, path); }
export function nullableString(value: unknown, path: string): string | null { return value === null ? null : stringValue(value, path); }
export function timestamp(value: unknown, path: string): string {
  return contractTimestamp(value, path, `${path} must be a timestamp`, false, BROWSER_SCALAR_MESSAGES);
}
export function member<T extends string>(value: unknown, values: ReadonlySet<T>, path: string): T {
  return contractSetMember(value, values, path);
}
export function apiEntity(value: unknown, path: string): JsonRecord { return versionedRecord(value, path); }

function projectProject(item: Project): RawProject {
  return { ...withoutApiVersion(item), createdAtMs: ms(item.createdAt), updatedAtMs: ms(item.updatedAt) };
}
export function parseProject(value: unknown, path: string): RawProject {
  return projectProject(parseProjectEntity(value, path, loose));
}
function projectWorkItem(item: WorkItem): RawWorkItem {
  return { ...withoutApiVersion(item), createdAtMs: ms(item.createdAt), updatedAtMs: ms(item.updatedAt), endedAtMs: nullableMs(item.endedAt), archivedAtMs: nullableMs(item.archivedAt) };
}
export function parseWorkItem(value: unknown, path: string): RawWorkItem {
  return projectWorkItem(parseWorkItemEntity(value, path, loose));
}
function projectAgent(item: AgentProfile): RawAgent {
  return { ...withoutApiVersion(item), createdAtMs: ms(item.createdAt) };
}
export function parseAgent(value: unknown, path: string): RawAgent {
  return projectAgent(parseAgentEntity(value, path, loose));
}
function projectDocumentPenHolder(item: DocumentPenHolder): RawDocumentPenHolder {
  return { ...item, acquiredAtMs: ms(item.acquiredAt) };
}
export function parseDocumentPenHolder(value: unknown, path: string): RawDocumentPenHolder {
  return projectDocumentPenHolder(parseDocumentPenHolderEntity(value, path, loose));
}
function projectDocumentSummary(item: DocumentSummary): RawDocumentSummary {
  return {
    ...withoutApiVersion(item),
    penHolder: item.penHolder === null ? null : projectDocumentPenHolder(item.penHolder),
    createdAtMs: ms(item.createdAt),
    updatedAtMs: ms(item.updatedAt),
  };
}
export function parseDocumentSummary(value: unknown, path: string): RawDocumentSummary {
  return projectDocumentSummary(parseDocumentSummaryEntity(value, path, loose));
}
function projectDocument(item: DocumentSnapshot): RawDocument {
  return { ...projectDocumentSummary(item), content: item.content };
}
export function parseDocument(value: unknown, path: string): RawDocument {
  return projectDocument(parseDocumentEntity(value, path, loose));
}
function projectTaskPhase(item: TaskPhase): RawTaskPhase {
  return { ...withoutApiVersion(item), startedAtMs: nullableMs(item.startedAt), endedAtMs: nullableMs(item.endedAt), createdAtMs: ms(item.createdAt), updatedAtMs: ms(item.updatedAt) };
}
export function parseTaskPhase(value: unknown, path: string): RawTaskPhase {
  return projectTaskPhase(parseTaskPhaseEntity(value, path, loose));
}
function projectTask(item: BoardTask): RawTask {
  return {
    ...withoutApiVersion(item),
    workspaceRefs: [...item.workspaceRefs],
    phases: item.phases.map(projectTaskPhase),
    estimateRecordedAtMs: nullableMs(item.estimateRecordedAt), startedAtMs: nullableMs(item.startedAt),
    expectedCompletedAtMs: nullableMs(item.expectedCompletedAt), endedAtMs: nullableMs(item.endedAt),
    createdAtMs: ms(item.createdAt), updatedAtMs: ms(item.updatedAt),
  };
}
export function parseTask(value: unknown, path: string): RawTask {
  return projectTask(parseTaskEntity(value, path, loose));
}
function projectQuestion(value: HumanQuestion): RawQuestion {
  const { apiVersion: _apiVersion, runId: _runId, answeredBy: _answeredBy, ...item } = value;
  return { ...item, askedAtMs: ms(item.askedAt), answeredAtMs: nullableMs(item.answeredAt) };
}
export function parseQuestion(value: unknown, path: string): RawQuestion {
  return projectQuestion(parseQuestionEntity(value, path, loose));
}
function projectRun(value: AgentRun): RawRun {
  const { apiVersion: _apiVersion, claimId: _claimId, wakeupId: _wakeupId, result: _result, ...item } = value;
  return { ...item, startedAtMs: ms(item.startedAt), endedAtMs: nullableMs(item.endedAt) };
}
export function parseRun(value: unknown, path: string): RawRun {
  return projectRun(parseRunEntity(value, path, loose));
}
function projectInterrupt(item: AgentInterrupt): RawInterrupt {
  return { sequence: item.sequence, agentId: item.agentId, runId: item.runId, requestedAt: item.requestedAt, requestedAtMs: ms(item.requestedAt) };
}
export function parseInterrupt(value: unknown, path: string): RawInterrupt {
  return projectInterrupt(parseInterruptEntity(value, path, loose));
}
function projectEvent(item: TaskEvent): RawEvent {
  return { ...withoutApiVersion(item), createdAtMs: ms(item.createdAt) };
}
export function parseEvent(value: unknown, path: string): RawEvent {
  return projectEvent(parseEventEntity(value, path, loose));
}
function projectMessage(value: TaskMessage): RawMessage {
  const { apiVersion: _apiVersion, runId: _runId, ...item } = value;
  return { ...item, createdAtMs: ms(item.createdAt) };
}
export function parseMessage(value: unknown, path: string): RawMessage {
  return projectMessage(parseMessageEntity(value, path, loose));
}

const uiAgentType = (item: ReturnType<typeof parseAutomationAgentTypeEntity>): AutomationAgentType => ({
  id: item.agentTypeId, name: item.name, description: item.description, role: item.role,
  supplementalInstructions: item.supplementalInstructions, skillIds: [...item.skillIds], evaluatorProfile: item.evaluatorProfile, enabled: item.enabled,
});
export function parseAutomationAgentType(value: unknown, path: string): AutomationAgentType { return uiAgentType(parseAutomationAgentTypeEntity(value, path, strict)); }
export function parseAutomationExecutor(value: unknown, path: string): AutomationStageExecutor {
  return { ...parseAutomationExecutorEntity(value, path, strict) };
}
export function parseAutomationStage(value: unknown, path: string): AutomationStageConfiguration {
  const item = parseAutomationStageEntity(value, path, strict); return { stage: item.stage, executor: { ...item.executor } };
}
export function automationAgentTypeWire(item: AutomationAgentType): JsonRecord { return { agentTypeId: item.id, name: item.name, description: item.description, role: item.role, supplementalInstructions: item.supplementalInstructions, skillIds: [...item.skillIds], evaluatorProfile: item.evaluatorProfile, enabled: item.enabled }; }
export function automationStageWire(item: AutomationStageConfiguration): JsonRecord { return { stage: item.stage, executor: item.executor.kind === 'agent_type' ? { ...item.executor } : { kind: item.executor.kind } }; }
const canonicalAutomation = (agentTypes: AutomationAgentType[], stages: AutomationStageConfiguration[]) => ({
  agentTypes: agentTypes.map((item, index) => parseAutomationAgentTypeEntity(automationAgentTypeWire(item), `agentTypes[${index}]`, strict)),
  stages: stages.map((item, index) => parseAutomationStageEntity(automationStageWire(item), `stages[${index}]`, strict)),
});
export function validateAutomationParts(agentTypes: AutomationAgentType[], stages: AutomationStageConfiguration[], path: string): void { const value = canonicalAutomation(agentTypes, stages); validateAutomationConfigurationParts(value.agentTypes, value.stages, path); }
export function validateAutomationPayloadSize(agentTypes: AutomationAgentType[], stages: AutomationStageConfiguration[], path: string): void { const value = canonicalAutomation(agentTypes, stages); if (automationConfigurationPartsBytes(value.agentTypes, value.stages) > maximumAutomationConfigurationBytes) throw new Error(`${path} agent types and stages cannot exceed 48 KiB of UTF-8 JSON`); }
export function parseAutomationConfiguration(value: unknown, path: string): AutomationConfiguration {
  const item = parseAutomationConfigurationEntity(value, path, strict); const agentTypes = item.agentTypes.map(uiAgentType); const stages = item.stages.map((entry) => ({ stage: entry.stage, executor: { ...entry.executor } })); validateAutomationPayloadSize(agentTypes, stages, path);
  return { id: 'company-default', agentTypes, stages, version: item.version, createdAt: item.createdAt, createdAtMs: ms(item.createdAt), updatedAt: item.updatedAt, updatedAtMs: ms(item.updatedAt), updatedBy: item.updatedBy };
}

export function parseWorkflowPlan(value: unknown, path: string): WorkflowPlan { const item = parsePlanEntity(value, path, loose); return { planRevisionId: item.planRevisionId, workItemId: item.workItemId, revision: item.revision, objective: item.objective, assumptions: [...item.assumptions], acceptanceCriteria: [...item.acceptanceCriteria], state: item.state, createdAt: item.createdAt, createdAtMs: ms(item.createdAt), confirmedAt: item.confirmedAt, confirmedAtMs: nullableMs(item.confirmedAt) }; }
export function parseWorkflowNode(value: unknown, path: string): WorkflowNode { const item = parseNodeEntity(value, path, loose); return { nodeId: item.nodeId, planRevisionId: item.planRevisionId, title: item.title, objective: item.objective, acceptanceCriteria: [...item.acceptanceCriteria], dependencyNodeIds: [...item.dependencyNodeIds], stageTemplate: [...item.stageTemplate], currentStage: item.currentStage, state: item.state, createdAt: item.createdAt, createdAtMs: ms(item.createdAt), updatedAt: item.updatedAt, updatedAtMs: ms(item.updatedAt) }; }
export function parseWorkflowHandoff(value: unknown, path: string): WorkflowHandoff { const item = parseHandoffEntity(value, path, loose); return { handoffId: item.handoffId, nodeId: item.nodeId, taskId: item.taskId, stage: item.stage, outcome: item.outcome, summary: item.summary, evidence: [...item.evidence], artifactIds: [...item.artifactIds], blockers: [...item.blockers], createdAt: item.createdAt, createdAtMs: ms(item.createdAt) }; }
export function parseWorkflowEvent(value: unknown, path: string): WorkflowEvent { const item = parseProjectEventEntity(value, path, loose); return { sequence: item.sequence, eventId: item.eventId, nodeId: item.nodeId, taskId: item.taskId, eventType: item.eventType, summary: item.summary, createdAt: item.createdAt, createdAtMs: ms(item.createdAt) }; }
export function parseProjectWorkflow(value: unknown, path: string): ProjectWorkflow { const item = record(value, path); return { plans: array(item.plans, `${path}.plans`, parseWorkflowPlan), nodes: array(item.nodes, `${path}.nodes`, parseWorkflowNode), handoffs: array(item.handoffs, `${path}.handoffs`, parseWorkflowHandoff), events: array(item.events, `${path}.events`, parseWorkflowEvent) }; }
export function parseProjectArtifact(value: unknown, path: string): ProjectArtifact { const item = parseProjectArtifactEntity(value, path, loose); return { artifactId: item.artifactId, nodeId: item.nodeId, taskId: item.taskId, mediaType: item.mediaType, byteSize: item.byteSize, caption: item.caption, createdAt: item.createdAt, createdAtMs: ms(item.createdAt) }; }

export function parseRawBoard(value: unknown): RawBoard {
  const item: BoardSnapshot = parseBoardSnapshotEntity(value, loose);
  const open = item.openQuestions.map(projectQuestion);
  const recent = item.recentQuestions.map(projectQuestion);
  const questions = new Map(recent.map((question) => [question.questionId, question])); for (const question of open) questions.set(question.questionId, question);
  return {
    project: projectProject(item.project),
    agents: item.agents.map(projectAgent),
    tasks: item.tasks.map(projectTask),
    questions: [...questions.values()],
    runs: item.recentRuns.map(projectRun),
    interrupts: item.recentInterrupts.map(projectInterrupt),
    events: item.recentEvents.map(projectEvent),
    documents: item.documents.map(projectDocumentSummary),
  };
}
