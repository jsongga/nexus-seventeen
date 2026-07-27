import type {
  AgentRole,
  SkillSnapshot,
  StageHandoff,
  WorkflowStage,
  StageHandoffDraft,
  WorkflowPlanDraft,
  TaskKind,
  TaskPhaseStage,
  TaskPhaseStatus,
} from "#shared/task-board-contract";

export const TASK_WAKE_REASONS = Object.freeze([
  "human_assignment",
  "human_answer",
  "human_resume",
  "workflow_handoff",
] as const);

export type TaskWakeReason = typeof TASK_WAKE_REASONS[number];
export type AgentRunTerminalStatus = "completed" | "failed" | "interrupted" | "waiting_for_human";

/** A durable board claim. `reason` stays a string so the worker can reject new/unsafe reasons without launching. */
export interface TaskWakeClaim {
  readonly apiVersion: 1;
  readonly claimId: string;
  readonly runId: string;
  readonly wakeupId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly taskId: string | null;
  readonly reason: string;
  readonly requestedMessageCursor: number | null;
  readonly claimedAt: string;
}

export interface AgentMission {
  readonly role: string;
  readonly area: string;
  readonly mission: string;
}

export interface AgentTaskContext {
  readonly kind: TaskKind;
  readonly requiredRole: AgentRole | null;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: string;
  readonly version: number;
  readonly expectedAgentMinutes: number | null;
  readonly phases: readonly AgentTaskPhase[];
}

export interface AgentTaskPhase {
  readonly phaseId: string;
  readonly title: string;
  readonly stage: TaskPhaseStage;
  readonly status: TaskPhaseStatus;
  readonly parallelGroup: string | null;
  readonly orderKey: number;
  readonly version: number;
}

/**
 * A provider-authored desired phase state. A null phaseId creates a phase;
 * an existing phaseId updates that phase using the version from task context.
 */
export interface AgentTaskPhaseUpdate {
  readonly phaseId: string | null;
  readonly title: string;
  readonly stage: TaskPhaseStage;
  readonly status: TaskPhaseStatus;
  readonly parallelGroup: string | null;
  readonly orderKey: number;
}

export interface TaskContextMessage {
  readonly messageId: string;
  readonly cursor: number;
  readonly author: "human" | "agent" | "system";
  readonly body: string;
  readonly createdAt: string;
}

/** Deterministic recent task results; never a separately synthesized memory summary. */
export interface AreaMemoryEntry {
  readonly taskId: string;
  readonly title: string;
  readonly result: string;
  readonly endedAt: string;
}

export interface ParentTaskEvidence {
  readonly taskId: string;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: string;
  readonly status: string;
  readonly assignedAgentId: string | null;
  readonly workspaceRefs: readonly string[];
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly result: string | null;
  readonly messages: readonly Readonly<{
    messageId: string;
    author: "human" | "agent";
    kind: "note" | "progress" | "proposal" | "result";
    body: string;
    createdAt: string;
  }>[];
}

/** The only context allowed to cross the model-process boundary. */
export interface BoundedAgentContext {
  readonly apiVersion: 1;
  readonly projectId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly mission: AgentMission;
  readonly projectMemory: string;
  readonly task: AgentTaskContext;
  readonly areaMemory: readonly AreaMemoryEntry[];
  readonly parentEvidence: ParentTaskEvidence | null;
  readonly messagesSinceCursor: number | null;
  readonly nextMessageCursor: number;
  readonly messages: readonly TaskContextMessage[];
  readonly triggerQuestion: Readonly<{
    questionId: string;
    question: string;
    answer: string;
  }> | null;
  readonly openQuestions: readonly Readonly<{
    questionId: string;
    question: string;
    answer: string | null;
    status: "open" | "answered";
  }>[];
  readonly workspaceRefs: readonly string[];
  readonly workflow: Readonly<{
    planRevisionId: string;
    nodeId: string;
    stage: WorkflowStage;
    skills: readonly SkillSnapshot[];
    dependencyHandoffs: readonly StageHandoff[];
  }> | null;
}

export type AgentRunOutput =
  | Readonly<{ type: "progress"; body: string }>
  | Readonly<{
      type: "proposed_child_task";
      title: string;
      objective: string;
      acceptanceCriteria: readonly string[];
    }>
  | Readonly<{ type: "result"; body: string }>
  | Readonly<{ type: "human_question"; question: string }>;

export interface AgentRunOutcome {
  readonly status: AgentRunTerminalStatus;
  readonly outputs: readonly AgentRunOutput[];
  /** Null means the agent does not yet have enough evidence to publish or revise an estimate. */
  readonly expectedAgentMinutes: number | null;
  readonly phases: readonly AgentTaskPhaseUpdate[];
  readonly detail: string;
  readonly handoff?: StageHandoffDraft | null;
  readonly workflowPlan?: WorkflowPlanDraft | null;
}

export interface AgentLaunchRequest {
  readonly runId: string;
  readonly wakeReason: TaskWakeReason;
  readonly context: BoundedAgentContext;
}

/** `interrupt` must return only after the OS process and descendants are confirmed absent. */
export interface AgentRunHandle {
  readonly completion: Promise<AgentRunOutcome>;
  /**
   * Sanitized, bounded lifecycle labels only; raw provider payloads never cross
   * this boundary. The stream closes when provider output ends, including after
   * interruption.
   */
  readonly activity: AsyncIterable<string>;
  interrupt(reason: string): Promise<void>;
}

/** One launch call represents one complete, one-shot agent process. */
export interface AgentLauncher {
  launch(request: AgentLaunchRequest): Promise<AgentRunHandle>;
}

export interface ClaimNextWakeRequest {
  readonly agentId: string;
  readonly claimId: string;
  readonly messageCursors: Readonly<Record<string, number>>;
  readonly longPollMs: number;
}

export interface ClaimedAgentRun {
  readonly claim: TaskWakeClaim;
  readonly context: BoundedAgentContext | null;
}

export interface AppendRunOutputRequest {
  readonly claim: TaskWakeClaim;
  readonly output: AgentRunOutput;
  readonly localSequence: number;
  readonly idempotencyKey: string;
}

export interface SettleAgentRunRequest {
  readonly claim: TaskWakeClaim;
  readonly outcome: AgentRunTerminalStatus;
  readonly result: string;
  readonly idempotencyKey: string;
  readonly handoff?: StageHandoffDraft | null;
  readonly workflowPlan?: WorkflowPlanDraft | null;
}

export interface UpdateTaskEstimateRequest {
  readonly claim: TaskWakeClaim;
  readonly version: number;
  readonly expectedAgentMinutes: number;
}

export interface CreateAgentTaskPhaseRequest {
  readonly claim: TaskWakeClaim;
  readonly title: string;
  readonly stage: TaskPhaseStage;
  readonly parallelGroup: string | null;
}

export interface UpdateAgentTaskPhaseRequest {
  readonly claim: TaskWakeClaim;
  readonly phase: AgentTaskPhase;
  readonly title?: string;
  readonly stage?: TaskPhaseStage;
  readonly status?: TaskPhaseStatus;
  readonly parallelGroup?: string | null;
  readonly orderKey?: number;
}

export interface AgentRunInterrupt {
  readonly sequence: number;
  readonly interruptId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly reason: string;
  readonly requestedAt: string;
}

/** Board credentials and transport details remain entirely outside the launcher. */
export interface TaskBoardClient {
  claimNextWake(request: ClaimNextWakeRequest, signal?: AbortSignal): Promise<ClaimedAgentRun | null>;
  waitForRunInterrupt(claim: TaskWakeClaim, signal?: AbortSignal): Promise<AgentRunInterrupt | null>;
  updateTaskEstimate(request: UpdateTaskEstimateRequest, signal?: AbortSignal): Promise<number>;
  createTaskPhase(request: CreateAgentTaskPhaseRequest, signal?: AbortSignal): Promise<AgentTaskPhase>;
  updateTaskPhase(request: UpdateAgentTaskPhaseRequest, signal?: AbortSignal): Promise<AgentTaskPhase>;
  appendRunOutput(request: AppendRunOutputRequest, signal?: AbortSignal): Promise<void>;
  settleAgentRun(request: SettleAgentRunRequest, signal?: AbortSignal): Promise<void>;
}

export interface TaskWorkerIdentity {
  readonly workerId: string;
  readonly agentId: string;
}

export interface TaskWorkerOptions {
  readonly identity: TaskWorkerIdentity;
  readonly statePath: string;
  readonly board: TaskBoardClient;
  readonly launcher: AgentLauncher;
  readonly longPollMs?: number;
  readonly now?: () => Date;
}

export interface CompletedRunJournalEntry {
  readonly runId: string;
  readonly wakeId: string;
  readonly taskId: string | null;
  readonly outcome: AgentRunTerminalStatus;
  readonly detail: string;
  readonly startedAt: string;
  readonly endedAt: string;
}

export type ActiveRunPhase = "claimed" | "launch_started" | "running" | "outputs_pending";

export interface ActiveRunJournalEntry {
  readonly claim: TaskWakeClaim;
  readonly phase: ActiveRunPhase;
  readonly contextDigest: string | null;
  readonly launchStartedAt: string | null;
  readonly interruptReason: string | null;
  readonly outcome: AgentRunOutcome | null;
  readonly nextOutputIndex: number;
}

export interface TaskWorkerJournal {
  readonly version: 2;
  readonly identity: TaskWorkerIdentity;
  readonly messageCursors: Readonly<Record<string, number>>;
  readonly pendingClaim: Readonly<{ claimId: string; messageCursors: Readonly<Record<string, number>> }> | null;
  readonly active: ActiveRunJournalEntry | null;
  readonly completed: readonly CompletedRunJournalEntry[];
}
