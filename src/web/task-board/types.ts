import {
  agentRoleValues,
  evaluatorProfileValues,
  planRevisionStateValues,
  questionStatusValues,
  stageHandoffOutcomeValues,
  taskKindValues,
  taskPhaseStageValues,
  taskPhaseStatusValues,
  wakeReasonValues,
  workerConnectionValues,
  workNodeStateValues,
  workItemPriorityValues,
  workItemStageValues,
  workItemStateValues,
  type WorkflowStage,
} from './data/wire';

export type { WorkflowStage };

export type AgentStatus =
  | 'sleeping'
  | 'queued'
  | 'running'
  | 'interrupting'
  | 'waiting_for_human'
  | 'failed';

export type AgentWorkerConnection = typeof workerConnectionValues[number] | null;

export type AgentRole = typeof agentRoleValues[number];
export type TaskKind = typeof taskKindValues[number];

export type TaskStatus =
  | 'proposed'
  | 'backlog'
  | 'queued'
  | 'running'
  | 'waiting_for_human'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';

export type TaskPhaseStage = typeof taskPhaseStageValues[number];
export type TaskPhaseStatus = typeof taskPhaseStatusValues[number];

export type QuestionStatus = typeof questionStatusValues[number];

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_human'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type WakeReason = typeof wakeReasonValues[number];

export type WorkItemPriority = typeof workItemPriorityValues[number];
export type WorkItemState = typeof workItemStateValues[number];
export type WorkItemStage = typeof workItemStageValues[number];
export const AUTOMATION_STAGE_ORDER: readonly WorkItemStage[] = workItemStageValues;
export const AUTOMATION_STAGE_ALLOWED_ROLES: Readonly<Record<WorkItemStage, readonly AgentRole[]>> = {
  refinement: ['manager'],
  project_resolution: ['manager'],
  research: ['engineer', 'verifier'],
  planning: ['engineer'],
  implementation: ['engineer'],
  testing: ['engineer', 'verifier'],
  verification: ['verifier'],
  human_review: [],
  deployment: [],
};
export type WorkItemProjectTarget =
  | { mode: 'auto' }
  | { mode: 'explicit'; projectId: string };

export type AutomationEvaluatorProfile = typeof evaluatorProfileValues[number];

export interface AutomationAgentType {
  id: string;
  name: string;
  description: string;
  role: AgentRole;
  supplementalInstructions: string;
  skillIds: string[];
  evaluatorProfile: AutomationEvaluatorProfile;
  enabled: boolean;
}

export type AutomationStageExecutor =
  | { kind: 'agent_type'; agentTypeId: string }
  | { kind: 'human' }
  | { kind: 'disabled' };

export interface AutomationStageConfiguration {
  stage: WorkItemStage;
  executor: AutomationStageExecutor;
}

export interface AutomationConfiguration {
  id: 'company-default';
  agentTypes: AutomationAgentType[];
  stages: AutomationStageConfiguration[];
  version: number;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
  updatedBy: string;
}

export interface SaveAutomationConfigurationInput {
  version: number;
  agentTypes: AutomationAgentType[];
  stages: AutomationStageConfiguration[];
}

export interface BoardWorkItem {
  id: string;
  originalRequest: string;
  refinedObjective: string | null;
  priority: WorkItemPriority;
  projectTarget: WorkItemProjectTarget;
  resolvedProjectId: string | null;
  planningTaskId: string | null;
  state: WorkItemState;
  currentStage: WorkItemStage | null;
  createdBy: string;
  version: number;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
  endedAt: string | null;
  endedAtMs: number | null;
  cancelledReason: string | null;
  archivedAt: string | null;
  archivedAtMs: number | null;
}

export interface BoardProject {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
}

export interface BoardAgent {
  id: string;
  projectId: string;
  name: string;
  role: AgentRole;
  area: string;
  mission: string;
  model: string | null;
  status: AgentStatus;
  workerConnection: AgentWorkerConnection;
  lastError: string | null;
  currentTaskId: string | null;
  lastEventAt: string | null;
  lastEventAtMs: number | null;
  version: number;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
}

export interface BoardTask {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  kind: TaskKind;
  requiredRole: AgentRole | null;
  requiresReview: boolean;
  title: string;
  objective: string;
  acceptanceCriteria: string | null;
  workspaceRefs: string[];
  assignedAgentId: string | null;
  assignedRole: AgentRole | null;
  status: TaskStatus;
  expectedAgentMinutes: number | null;
  estimateRecordedAt: string | null;
  estimateRecordedAtMs: number | null;
  expectedCompletedAt: string | null;
  expectedCompletedAtMs: number | null;
  orderKey: number;
  phases: BoardTaskPhase[];
  startedAt: string | null;
  startedAtMs: number | null;
  endedAt: string | null;
  endedAtMs: number | null;
  result: string | null;
  version: number;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
}

export interface BoardTaskPhase {
  id: string;
  title: string;
  stage: TaskPhaseStage;
  status: TaskPhaseStatus;
  parallelGroup: string | null;
  orderKey: number;
  startedAt: string | null;
  startedAtMs: number | null;
  endedAt: string | null;
  endedAtMs: number | null;
  version: number;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
}

export interface BoardMessage {
  id: string;
  projectId: string;
  taskId: string;
  authorType: 'human' | 'agent' | 'system';
  authorId: string | null;
  kind: 'progress' | 'question' | 'answer' | 'decision' | 'result' | 'note' | 'proposal';
  body: string;
  createdAt: string;
  createdAtMs: number;
}

export interface BoardQuestion {
  id: string;
  projectId: string;
  taskId: string;
  agentId: string;
  prompt: string;
  status: QuestionStatus;
  answer: string | null;
  askedAt: string;
  askedAtMs: number;
  answeredAt: string | null;
  answeredAtMs: number | null;
  version: number;
}

export interface BoardRun {
  id: string;
  projectId: string;
  taskId: string | null;
  agentId: string;
  status: RunStatus;
  wakeReason: WakeReason | null;
  startedAt: string | null;
  startedAtMs: number | null;
  endedAt: string | null;
  endedAtMs: number | null;
  interruptRequestedAt: string | null;
  interruptRequestedAtMs: number | null;
  createdAt: string;
  createdAtMs: number;
}

export interface DocumentPenHolder {
  actorType: 'human' | 'agent';
  actorId: string;
  clientId: string;
  acquiredAt: string;
  acquiredAtMs: number;
}

export interface BoardDocumentSummary {
  id: string;
  projectId: string;
  title: string;
  contentType: 'text/markdown';
  contentVersion: number;
  penEpoch: number;
  penHolder: DocumentPenHolder | null;
  sequence: number;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
}

export interface BoardDocument extends BoardDocumentSummary {
  content: string;
}

export interface BoardSnapshot {
  revision: number;
  generatedAt: string;
  generatedAtMs: number;
  workItems: BoardWorkItem[];
  projects: BoardProject[];
  agents: BoardAgent[];
  tasks: BoardTask[];
  messages: BoardMessage[];
  questions: BoardQuestion[];
  runs: BoardRun[];
  documents: BoardDocumentSummary[];
}

export interface WorkflowPlan {
  planRevisionId: string;
  workItemId: string;
  revision: number;
  objective: string;
  assumptions: string[];
  acceptanceCriteria: string[];
  state: typeof planRevisionStateValues[number];
  createdAt: string;
  createdAtMs: number;
  confirmedAt: string | null;
  confirmedAtMs: number | null;
}

export interface WorkflowNode {
  nodeId: string;
  planRevisionId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  dependencyNodeIds: string[];
  stageTemplate: WorkflowStage[];
  currentStage: WorkflowStage | null;
  state: typeof workNodeStateValues[number];
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
}

export interface WorkflowHandoff {
  handoffId: string;
  nodeId: string;
  taskId: string;
  stage: WorkflowStage;
  outcome: typeof stageHandoffOutcomeValues[number];
  summary: string;
  evidence: string[];
  artifactIds: string[];
  blockers: string[];
  createdAt: string;
  createdAtMs: number;
}

export interface WorkflowEvent {
  sequence: number;
  eventId: string;
  nodeId: string | null;
  taskId: string | null;
  eventType: string;
  summary: string;
  createdAt: string;
  createdAtMs: number;
}

export interface ProjectWorkflow {
  plans: WorkflowPlan[];
  nodes: WorkflowNode[];
  handoffs: WorkflowHandoff[];
  events: WorkflowEvent[];
}

export interface ProjectArtifact {
  artifactId: string;
  nodeId: string | null;
  taskId: string | null;
  mediaType: string;
  byteSize: number;
  caption: string;
  createdAt: string;
  createdAtMs: number;
}

export interface CreateProjectInput {
  name: string;
  description: string;
}

export interface RotateAgentTokenResult {
  agentId: string;
  version: number;
  token: string;
}

export interface CreateTaskInput {
  projectId: string;
  parentTaskId: string | null;
  title: string;
  objective: string;
  acceptanceCriteria: string;
  workspaceRefs: string[];
}

export interface CreateWorkItemInput {
  originalRequest: string;
  priority: Exclude<WorkItemPriority, 'opportunistic'>;
  projectId: string;
  idempotencyKey: string;
}

export interface AgentQueryConversationTurn {
  role: 'human' | 'agent';
  body: string;
}

export interface CreateDocumentInput {
  projectId: string;
  title: string;
  content: string;
}
