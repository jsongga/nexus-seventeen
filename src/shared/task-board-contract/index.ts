export const TASK_BOARD_API_VERSION = "steward.task-board/v1" as const;
/** Maximum persisted UTF-8 JSON size of the { agentTypes, stages } automation aggregate. */
export const AUTOMATION_CONFIGURATION_MAX_BYTES = 48 * 1_024;
/**
 * Maximum UTF-8 size of a document's Markdown content.
 *
 * Deliberately a separate constant from AUTOMATION_CONFIGURATION_MAX_BYTES:
 * the two limits are unrelated and only happen to share a value today, so
 * coupling them would let a change to one silently move the other.
 */
export const DOCUMENT_CONTENT_MAX_BYTES = 48 * 1_024;
export const WORK_ITEM_PAGE_SIZE = 200;
export const WORK_ITEM_CURSOR_MAX_BYTES = 512;

export const AGENT_ROLES = ["engineer", "manager", "verifier"] as const;
export type AgentRole = typeof AGENT_ROLES[number];

export const AGENT_STATUSES = ["idle", "ready", "running", "interrupting", "waiting_for_human"] as const;
export type AgentStatus = typeof AGENT_STATUSES[number];

export const WORKER_CONNECTIONS = ["waiting_for_wake", "watching_run"] as const;
export type WorkerConnection = typeof WORKER_CONNECTIONS[number] | null;

export const TASK_KINDS = ["work", "manager_review", "human_check"] as const;
export type TaskKind = typeof TASK_KINDS[number];

export const TASK_STATUSES = ["backlog", "queued", "in_progress", "blocked", "completed", "failed", "cancelled"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

export const TASK_PHASE_STAGES = ["research", "planning", "execution", "testing", "review", "done"] as const;
export type TaskPhaseStage = typeof TASK_PHASE_STAGES[number];

export const TASK_PHASE_STATUSES = ["pending", "in_progress", "blocked", "completed", "failed"] as const;
export type TaskPhaseStatus = typeof TASK_PHASE_STATUSES[number];

export const TASK_MESSAGE_KINDS = ["note", "progress", "proposal", "result"] as const;
export type TaskMessageKind = typeof TASK_MESSAGE_KINDS[number];

export const ACTOR_TYPES = ["human", "agent", "system"] as const;
export type ActorType = typeof ACTOR_TYPES[number];

export const QUESTION_STATUSES = ["open", "answered"] as const;
export type QuestionStatus = typeof QUESTION_STATUSES[number];

export const WAKEUP_REASONS = ["human_assignment", "human_answer", "human_resume", "workflow_handoff"] as const;
export type WakeupReason = typeof WAKEUP_REASONS[number];

export const RUN_STATUSES = ["active", "waiting_for_human", "completed", "failed", "interrupted"] as const;
export type RunStatus = typeof RUN_STATUSES[number];

export type DocumentContentType = "text/markdown";

export const DOCUMENT_ACTOR_TYPES = ["human", "agent"] as const;
export type DocumentActorType = typeof DOCUMENT_ACTOR_TYPES[number];

export const WORK_ITEM_PRIORITIES = ["urgent", "high", "normal", "low", "opportunistic"] as const;
export type WorkItemPriority = typeof WORK_ITEM_PRIORITIES[number];

export const WORK_ITEM_STATES = ["submitted", "processing", "needs_input", "waiting_for_human_review", "completed", "failed", "cancelled"] as const;
export type WorkItemState = typeof WORK_ITEM_STATES[number];

export const WORK_ITEM_STAGES = ["refinement", "project_resolution", "research", "planning", "implementation", "testing", "verification", "human_review", "deployment"] as const;
export type WorkItemStage = typeof WORK_ITEM_STAGES[number];

export const WORKFLOW_STAGES = ["research", "planning", "implementation", "testing", "verification"] as const;
export type WorkflowStage = typeof WORKFLOW_STAGES[number];

export const PLAN_REVISION_STATES = ["proposed", "confirmed", "superseded", "rejected"] as const;
export type PlanRevisionState = typeof PLAN_REVISION_STATES[number];

export const WORK_NODE_STATES = ["pending", "ready", "active", "blocked", "stale", "completed", "cancelled"] as const;
export type WorkNodeState = typeof WORK_NODE_STATES[number];

export const STAGE_HANDOFF_OUTCOMES = ["passed", "failed", "needs_input"] as const;
export type StageHandoffOutcome = typeof STAGE_HANDOFF_OUTCOMES[number];
export type ArtifactMediaType =
  | "text/markdown"
  | "text/vnd.mermaid"
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/svg+xml";
export type WorkItemProjectTarget =
  | Readonly<{ mode: "auto" }>
  | Readonly<{ mode: "explicit"; projectId: string }>;
export const EVALUATOR_PROFILES = ["tests", "editorial", "visual", "manual"] as const;
export type AgentTypeEvaluatorProfile = typeof EVALUATOR_PROFILES[number];
export type AutomationStageExecutor =
  | Readonly<{ kind: "agent_type"; agentTypeId: string }>
  | Readonly<{ kind: "human" }>
  | Readonly<{ kind: "disabled" }>;

export interface AutomationAgentType {
  readonly agentTypeId: string;
  readonly name: string;
  readonly description: string;
  /** Fixed authority ceiling. Supplemental configuration cannot expand this role. */
  readonly role: AgentRole;
  readonly supplementalInstructions: string;
  readonly skillIds: readonly string[];
  readonly evaluatorProfile: AgentTypeEvaluatorProfile;
  readonly enabled: boolean;
}

export interface AutomationPipelineStage {
  readonly stage: WorkItemStage;
  readonly executor: AutomationStageExecutor;
}

export interface AutomationConfiguration {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly configurationId: "company-default";
  readonly agentTypes: readonly AutomationAgentType[];
  readonly stages: readonly AutomationPipelineStage[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface WorkItem {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly workItemId: string;
  /** The accepted human submission. Refinement is stored separately and never overwrites it. */
  readonly originalRequest: string;
  readonly refinedObjective: string | null;
  readonly priority: WorkItemPriority;
  readonly projectTarget: WorkItemProjectTarget;
  readonly resolvedProjectId: string | null;
  readonly state: WorkItemState;
  readonly currentStage: WorkItemStage | null;
  readonly createdBy: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
}

export interface WorkItemPage {
  readonly workItems: readonly WorkItem[];
  /** Omitted when the page exhausts the ordered work-item collection. */
  readonly nextCursor?: string;
}

export interface SkillSnapshot {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly digest: `sha256:${string}`;
  readonly content: string;
}

export interface PlanRevision {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly planRevisionId: string;
  readonly workItemId: string;
  readonly revision: number;
  readonly objective: string;
  readonly assumptions: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly projectId: string;
  readonly skillDigests: Readonly<Record<string, string>>;
  readonly state: PlanRevisionState;
  readonly createdBy: string;
  readonly confirmedBy: string | null;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
}

export interface WorkNode {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly nodeId: string;
  readonly planRevisionId: string;
  readonly projectId: string;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly dependencyNodeIds: readonly string[];
  readonly stageTemplate: readonly WorkflowStage[];
  readonly currentStage: WorkflowStage | null;
  readonly state: WorkNodeState;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CriterionResult {
  readonly criterion: string;
  readonly passed: boolean;
  readonly evidence: string;
}

export interface StageHandoff {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly handoffId: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly stage: WorkflowStage;
  readonly outcome: StageHandoffOutcome;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly artifactIds: readonly string[];
  readonly acceptanceCriteria: readonly CriterionResult[];
  readonly blockers: readonly string[];
  readonly recommendedReturnStage: WorkflowStage | null;
  readonly createdAt: string;
}

export interface StageHandoffDraft {
  readonly outcome: StageHandoffOutcome;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly artifactIds: readonly string[];
  readonly acceptanceCriteria: readonly CriterionResult[];
  readonly blockers: readonly string[];
  readonly recommendedReturnStage: WorkflowStage | null;
}

export interface ProjectArtifact {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly artifactId: string;
  readonly projectId: string;
  readonly nodeId: string | null;
  readonly taskId: string | null;
  readonly mediaType: ArtifactMediaType;
  readonly byteSize: number;
  readonly digest: `sha256:${string}`;
  readonly caption: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface CreateProjectArtifactRequest {
  readonly nodeId: string | null;
  readonly taskId: string | null;
  readonly mediaType: ArtifactMediaType;
  readonly caption: string;
  readonly contentBase64: string;
}

export interface ProjectEvent {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly sequence: number;
  readonly eventId: string;
  readonly projectId: string;
  readonly nodeId: string | null;
  readonly taskId: string | null;
  readonly eventType: string;
  readonly summary: string;
  readonly createdAt: string;
}

export interface ProposedWorkNode {
  readonly nodeId: string;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly dependencyNodeIds: readonly string[];
  readonly stageTemplate: readonly WorkflowStage[];
}

export interface WorkflowPlanDraft {
  readonly objective: string;
  readonly assumptions: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly nodes: readonly ProposedWorkNode[];
}

export interface CreatePlanRevisionRequest {
  readonly workItemId: string;
  readonly objective: string;
  readonly assumptions: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly projectId: string;
  readonly skillIds: readonly string[];
  readonly nodes: readonly ProposedWorkNode[];
}

export interface ConfirmPlanRevisionRequest {
  readonly expectedState: "proposed";
}

export interface DocumentPenHolder {
  readonly actorType: DocumentActorType;
  readonly actorId: string;
  readonly clientId: string;
  readonly acquiredAt: string;
}

export interface DocumentSummary {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly documentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly contentType: DocumentContentType;
  readonly contentVersion: number;
  readonly penEpoch: number;
  readonly penHolder: DocumentPenHolder | null;
  /** Per-document durable event cursor. */
  readonly sequence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocumentSnapshot extends DocumentSummary {
  readonly content: string;
}

export interface DocumentEvent {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly eventId: string;
  readonly documentId: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly eventType: "document_created" | "document_pen_acquired" | "document_pen_released" | "document_updated";
  readonly actorType: DocumentActorType;
  readonly actorId: string;
  readonly clientId: string;
  readonly document: DocumentSnapshot;
  readonly createdAt: string;
}

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
  /** Instance-local observation from an authenticated held request; never durable health state. */
  readonly workerConnection: WorkerConnection;
  readonly createdAt: string;
}

export interface BoardTask {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly taskId: string;
  readonly projectId: string;
  readonly parentTaskId: string | null;
  readonly kind: TaskKind;
  readonly requiredRole: AgentRole | null;
  /** True only when completed engineer work should enter the manager/human review workflow. */
  readonly requiresReview: boolean;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: string;
  readonly workspaceRefs: readonly string[];
  readonly status: TaskStatus;
  readonly assignedAgentId: string | null;
  readonly assignedRole: AgentRole | null;
  /** Agent-authored after the assignee has inspected the work. Null means it has not been estimated yet. */
  readonly expectedAgentMinutes: number | null;
  readonly estimateRecordedAt: string | null;
  /** Durable, human-controlled queue position. Lower values appear first. */
  readonly orderKey: number;
  /** Independent phase records may be in progress at the same time. */
  readonly phases: readonly TaskPhase[];
  readonly startedAt: string | null;
  /** Active-work forecast derived from the agent estimate. Null once the task is terminal. */
  readonly expectedCompletedAt: string | null;
  readonly endedAt: string | null;
  readonly result: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskPhase {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly phaseId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly title: string;
  readonly stage: TaskPhaseStage;
  readonly status: TaskPhaseStatus;
  /** Phases sharing a non-null value are intended to run concurrently. */
  readonly parallelGroup: string | null;
  readonly orderKey: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
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
  /** Content is fetched only when a document is opened. */
  readonly documents: readonly DocumentSummary[];
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
    workflow?: Readonly<{
      planRevisionId: string;
      nodeId: string;
      stage: WorkflowStage;
      skills: readonly SkillSnapshot[];
      dependencyHandoffs: readonly StageHandoff[];
    }> | null;
  }>;
}

export interface CreateProjectRequest {
  readonly name: string;
  readonly description: string;
}

export interface CreateWorkItemRequest {
  readonly originalRequest: string;
  /** Defaults to normal. */
  readonly priority?: WorkItemPriority;
  /** Defaults to automatic project resolution. */
  readonly projectTarget?: WorkItemProjectTarget;
}

export interface UpdateWorkItemRequest {
  readonly version: number;
  readonly priority?: WorkItemPriority;
  readonly projectTarget?: WorkItemProjectTarget;
}

export interface UpdateAutomationConfigurationRequest {
  readonly version: number;
  readonly agentTypes: readonly AutomationAgentType[];
  readonly stages: readonly AutomationPipelineStage[];
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
  /** Defaults to true for compatibility. Agent chat requests set this to false. */
  readonly requiresReview?: boolean;
}

export interface CreateTaskPhaseRequest {
  readonly title: string;
  readonly stage: TaskPhaseStage;
  readonly parallelGroup: string | null;
}

export interface UpdateTaskPhaseRequest {
  readonly version: number;
  readonly title?: string;
  readonly stage?: TaskPhaseStage;
  readonly status?: TaskPhaseStatus;
  readonly parallelGroup?: string | null;
  readonly orderKey?: number;
}

export interface CreateDocumentRequest {
  readonly title: string;
  readonly contentType: DocumentContentType;
  readonly content: string;
  readonly clientId: string;
}

export type UpdateDocumentPenRequest =
  | Readonly<{
      action: "acquire";
      clientId: string;
      expectedPenEpoch: number;
      force: boolean;
    }>
  | Readonly<{
      action: "release";
      clientId: string;
      expectedPenEpoch: number;
      force: false;
    }>;

export interface UpdateDocumentRequest {
  readonly clientId: string;
  readonly penEpoch: number;
  readonly contentVersion: number;
  readonly content: string;
}

export interface UpdateTaskRequest {
  readonly version: number;
  readonly title?: string;
  readonly objective?: string;
  readonly acceptanceCriteria?: string;
  readonly workspaceRefs?: readonly string[];
  readonly assignedAgentId?: string | null;
  readonly assignedRole?: AgentRole | null;
  /** Agent-only. Humans assign work but do not forecast its duration. */
  readonly expectedAgentMinutes?: number | null;
  /** Human-only queue ordering control. */
  readonly orderKey?: number;
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
  readonly handoff?: StageHandoffDraft | null;
  readonly workflowPlan?: WorkflowPlanDraft | null;
}
