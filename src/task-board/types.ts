export type AgentStatus =
  | 'sleeping'
  | 'queued'
  | 'running'
  | 'interrupting'
  | 'waiting_for_human'
  | 'failed';

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

export type QuestionStatus = 'open' | 'answered';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_human'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type WakeReason = 'human_assignment' | 'human_answer' | 'human_resume';

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
  title: string;
  objective: string;
  acceptanceCriteria: string | null;
  workspaceRefs: string[];
  assignedAgentId: string | null;
  assignedRole: AgentRole | null;
  status: TaskStatus;
  expectedAgentMinutes: number;
  expectedCompletedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  result: string | null;
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

export interface BoardSnapshot {
  revision: number;
  generatedAt: string;
  projects: BoardProject[];
  agents: BoardAgent[];
  tasks: BoardTask[];
  messages: BoardMessage[];
  questions: BoardQuestion[];
  runs: BoardRun[];
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
  expectedAgentMinutes: number;
}
