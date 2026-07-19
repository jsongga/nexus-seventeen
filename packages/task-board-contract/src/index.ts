export const TASK_BOARD_API_VERSION = "steward.task-board/v1" as const;

export type AgentRole = "engineer" | "manager" | "verifier";
export type AgentStatus = "idle" | "ready" | "running" | "interrupting" | "waiting_for_human";
export type TaskKind = "work" | "manager_review" | "human_check";
export type TaskStatus =
  | "backlog"
  | "queued"
  | "in_progress"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";
export type TaskMessageKind = "note" | "progress" | "proposal" | "result";
export type ActorType = "human" | "agent" | "system";
export type QuestionStatus = "open" | "answered";
export type WakeupReason = "human_assignment" | "human_answer" | "human_resume";
export type RunStatus = "active" | "waiting_for_human" | "completed" | "failed" | "interrupted";

export interface Project {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly projectId: string;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentProfile {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly agentId: string;
  readonly projectId: string;
  readonly role: AgentRole;
  readonly area: string;
  readonly mission: string;
  readonly model: string;
  readonly status: AgentStatus;
  readonly createdAt: string;
}

export interface BoardTask {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly taskId: string;
  readonly projectId: string;
  readonly parentTaskId: string | null;
  readonly kind: TaskKind;
  readonly requiredRole: AgentRole | null;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: string;
  readonly workspaceRefs: readonly string[];
  readonly status: TaskStatus;
  readonly assignedAgentId: string | null;
  readonly assignedRole: AgentRole | null;
  readonly expectedAgentMinutes: number;
  readonly startedAt: string | null;
  readonly expectedCompletedAt: string | null;
  readonly endedAt: string | null;
  readonly result: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskMessage {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly messageId: string;
  readonly sequence: number;
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string | null;
  readonly actorType: Exclude<ActorType, "system">;
  readonly actorId: string;
  readonly kind: TaskMessageKind;
  readonly body: string;
  readonly createdAt: string;
}

export interface TaskEvent {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly eventId: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly eventType: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface HumanQuestion {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly questionId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly question: string;
  readonly status: QuestionStatus;
  readonly answer: string | null;
  readonly askedAt: string;
  readonly answeredAt: string | null;
  readonly answeredBy: string | null;
  readonly version: number;
}

export interface Wakeup {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly wakeupId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly reason: WakeupReason;
  readonly taskId: string | null;
  readonly questionId: string | null;
  readonly detail: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly claimedAt: string | null;
  readonly runId: string | null;
}

export interface AgentRun {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly runId: string;
  readonly claimId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly wakeupId: string;
  readonly taskId: string | null;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly result: string | null;
}

export interface AgentInterrupt {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly sequence: number;
  readonly interruptId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly runId: string | null;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
}

export interface RunInterruptBatch {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly items: readonly AgentInterrupt[];
  readonly cursor: number;
}

export interface BoardSnapshot {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly project: Project;
  readonly agents: readonly AgentProfile[];
  readonly tasks: readonly BoardTask[];
  readonly openQuestions: readonly HumanQuestion[];
  readonly recentQuestions: readonly HumanQuestion[];
  readonly recentRuns: readonly AgentRun[];
  readonly recentInterrupts: readonly AgentInterrupt[];
  readonly recentEvents: readonly TaskEvent[];
}

export interface ClaimRunResult {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly run: AgentRun;
  readonly wakeup: Wakeup;
  readonly task: BoardTask | null;
  readonly context: Readonly<{
    agent: AgentProfile;
    projectMemory: Readonly<{
      projectId: string;
      name: string;
      description: string;
    }>;
    areaMemory: readonly Readonly<{
      taskId: string;
      title: string;
      result: string;
      endedAt: string;
    }>[];
    parentTask: BoardTask | null;
    parentMessages: readonly TaskMessage[];
    acceptanceCriteria: string | null;
    workspaceRefs: readonly string[];
    messageCursor: number;
    messages: readonly TaskMessage[];
    triggerQuestion: HumanQuestion | null;
    openQuestions: readonly HumanQuestion[];
  }>;
}

export interface CreateProjectRequest {
  readonly name: string;
  readonly description: string;
}

export interface CreateAgentRequest {
  readonly agentId: string;
  readonly role: AgentRole;
  readonly area: string;
  readonly mission: string;
  readonly model: string;
  readonly token: string;
}

export interface CreateTaskRequest {
  readonly parentTaskId: string | null;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: string;
  readonly workspaceRefs: readonly string[];
  readonly assignedAgentId: string | null;
  readonly assignedRole: AgentRole | null;
  readonly expectedAgentMinutes: number;
}

export interface UpdateTaskRequest {
  readonly version: number;
  readonly title?: string;
  readonly objective?: string;
  readonly acceptanceCriteria?: string;
  readonly workspaceRefs?: readonly string[];
  readonly assignedAgentId?: string | null;
  readonly assignedRole?: AgentRole | null;
  readonly expectedAgentMinutes?: number;
  readonly status?: TaskStatus;
  readonly result?: string | null;
}

export interface CreateTaskMessageRequest {
  readonly clientEventId: string;
  readonly kind: TaskMessageKind;
  readonly body: string;
  readonly runId: string;
}

export interface CreateHumanTaskMessageRequest {
  readonly clientEventId: string;
  readonly kind: "note";
  readonly body: string;
}

export interface CreateHumanQuestionRequest {
  readonly clientEventId: string;
  readonly question: string;
  readonly runId: string;
}

export type ClaimRunRequest =
  | Readonly<{
      claimId: string;
      /** Legacy single-task cursor. New workers send `messageCursors` instead. */
      messageCursor: number | null;
      messageCursors?: never;
    }>
  | Readonly<{
      claimId: string;
      /** Per-task cursors prevent activity on one task from hiding older messages on another. */
      messageCursors: Readonly<Record<string, number>>;
      messageCursor?: never;
    }>;

export interface AnswerHumanQuestionRequest {
  readonly answer: string;
  readonly version: number;
}

export interface ResumeAgentRequest {
  readonly reason: string;
  readonly taskId: string | null;
}

export interface InterruptAgentRequest {
  readonly reason: string;
}

export interface SettleRunRequest {
  readonly outcome: "completed" | "failed" | "interrupted";
  readonly result: string;
}
