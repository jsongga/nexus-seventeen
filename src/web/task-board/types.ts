export type AgentStatus =
  | 'sleeping'
  | 'queued'
  | 'running'
  | 'interrupting'
  | 'waiting_for_human'
  | 'failed';

export type AgentWorkerConnection = 'waiting_for_wake' | 'watching_run' | null;

export type AgentRole = 'engineer' | 'manager' | 'verifier';
export type TaskKind = 'work' | 'manager_review' | 'human_check';

export type TaskStatus =
  | 'proposed'
  | 'backlog'
  | 'queued'
  | 'running'
  | 'waiting_for_human'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type TaskPhaseStage = 'research' | 'planning' | 'execution' | 'testing' | 'review' | 'done';
export type TaskPhaseStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed';

export type QuestionStatus = 'open' | 'answered';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_human'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type WakeReason = 'human_assignment' | 'human_answer' | 'human_resume' | 'workflow_handoff';

export type WorkItemPriority = 'urgent' | 'high' | 'normal' | 'low' | 'opportunistic';
export type WorkItemState =
  | 'submitted'
  | 'processing'
  | 'needs_input'
  | 'waiting_for_human_review'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type WorkItemStage =
  | 'refinement'
  | 'project_resolution'
  | 'research'
  | 'planning'
  | 'implementation'
  | 'testing'
  | 'verification'
  | 'human_review'
  | 'deployment';
export const AUTOMATION_STAGE_ORDER: readonly WorkItemStage[] = [
  'refinement',
  'project_resolution',
  'research',
  'planning',
  'implementation',
  'testing',
  'verification',
  'human_review',
  'deployment',
];
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

export type AutomationEvaluatorProfile = 'tests' | 'editorial' | 'visual' | 'manual';

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
  updatedAt: string;
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
  state: WorkItemState;
  currentStage: WorkItemStage | null;
  createdBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface BoardProject {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
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
  currentTaskId: string | null;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  expectedCompletedAt: string | null;
  orderKey: number;
  phases: BoardTaskPhase[];
  startedAt: string | null;
  endedAt: string | null;
  result: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface BoardTaskPhase {
  id: string;
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

export interface BoardMessage {
  id: string;
  projectId: string;
  taskId: string;
  authorType: 'human' | 'agent' | 'system';
  authorId: string | null;
  kind: 'progress' | 'question' | 'answer' | 'decision' | 'result' | 'note' | 'proposal';
  body: string;
  createdAt: string;
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
  answeredAt: string | null;
  version: number;
}

export interface BoardRun {
  id: string;
  projectId: string;
  taskId: string;
  agentId: string;
  status: RunStatus;
  wakeReason: WakeReason | null;
  startedAt: string | null;
  endedAt: string | null;
  interruptRequestedAt: string | null;
  createdAt: string;
}

export interface DocumentPenHolder {
  actorType: 'human' | 'agent';
  actorId: string;
  clientId: string;
  acquiredAt: string;
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
  updatedAt: string;
}

export interface BoardDocument extends BoardDocumentSummary {
  content: string;
}

export interface BoardSnapshot {
  revision: number;
  generatedAt: string;
  workItems: BoardWorkItem[];
  projects: BoardProject[];
  agents: BoardAgent[];
  tasks: BoardTask[];
  messages: BoardMessage[];
  questions: BoardQuestion[];
  runs: BoardRun[];
  documents: BoardDocumentSummary[];
}

export type WorkflowStage = 'research' | 'planning' | 'implementation' | 'testing' | 'verification';

export interface WorkflowPlan {
  planRevisionId: string;
  revision: number;
  objective: string;
  assumptions: string[];
  acceptanceCriteria: string[];
  state: 'proposed' | 'confirmed' | 'superseded' | 'rejected';
  createdAt: string;
  confirmedAt: string | null;
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
  state: 'pending' | 'ready' | 'active' | 'blocked' | 'stale' | 'completed' | 'cancelled';
  updatedAt: string;
}

export interface WorkflowHandoff {
  handoffId: string;
  nodeId: string;
  taskId: string;
  stage: WorkflowStage;
  outcome: 'passed' | 'failed' | 'needs_input';
  summary: string;
  evidence: string[];
  artifactIds: string[];
  blockers: string[];
  createdAt: string;
}

export interface WorkflowEvent {
  sequence: number;
  eventId: string;
  nodeId: string | null;
  taskId: string | null;
  eventType: string;
  summary: string;
  createdAt: string;
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
}

export interface CreateProjectInput {
  name: string;
  description: string;
}

export interface CreateAgentInput {
  projectId: string;
  agentId: string;
  role: AgentRole;
  area: string;
  mission: string;
  model: string;
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
  projectTarget: WorkItemProjectTarget;
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
