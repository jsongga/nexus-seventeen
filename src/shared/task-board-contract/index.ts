/** Defines the shared task-board wire contract for servers, workers, and web clients. */

/* —— Contract metadata and safety bounds —— */

export const TASK_BOARD_API_VERSION = "steward.task-board/v1" as const;
// These codes are stable because board clients branch on them.
export const TASK_BOARD_ERROR_CODES = Object.freeze({
  AGENT_VERSION_CONFLICT: "AGENT_VERSION_CONFLICT",
  HOST_PATH_NOT_DIRECTORY: "HOST_PATH_NOT_DIRECTORY",
  HOST_PATH_NOT_FOUND: "HOST_PATH_NOT_FOUND",
  HOST_PATH_OUTSIDE_ROOTS: "HOST_PATH_OUTSIDE_ROOTS",
  HOST_PATH_UNREADABLE: "HOST_PATH_UNREADABLE",
  INVALID_IDENTIFIER: "INVALID_IDENTIFIER",
  ONBOARDING_DELIVERABLES_MISSING: "ONBOARDING_DELIVERABLES_MISSING",
  ONBOARDING_EXISTS: "ONBOARDING_EXISTS",
  ONBOARDING_PROJECT_REQUIRED: "ONBOARDING_PROJECT_REQUIRED",
  PLAN_NOT_FOUND: "PLAN_NOT_FOUND",
  PLAN_NOT_PROPOSED: "PLAN_NOT_PROPOSED",
  PLANNING_UNAVAILABLE: "PLANNING_UNAVAILABLE",
  PROJECT_REPO_PATH_INVALID: "PROJECT_REPO_PATH_INVALID",
  PROJECT_REQUIRED: "PROJECT_REQUIRED",
  PARENT_PHASED_FAILED: "PARENT_PHASED_FAILED",
  TASK_NOT_RECOVERABLE: "TASK_NOT_RECOVERABLE",
  TASK_RECOVERY_REQUIRED: "TASK_RECOVERY_REQUIRED",
  TASK_BOARD_PIPELINE_EXECUTOR_DRIFT: "TASK_BOARD_PIPELINE_EXECUTOR_DRIFT",
  TASK_BOARD_PIPELINE_BASE_DIVERGED: "TASK_BOARD_PIPELINE_BASE_DIVERGED",
  TASK_BOARD_PIPELINE_BRANCH_EMPTY: "TASK_BOARD_PIPELINE_BRANCH_EMPTY",
  TASK_BOARD_PIPELINE_BRANCH_MOVED: "TASK_BOARD_PIPELINE_BRANCH_MOVED",
  TASK_BOARD_PIPELINE_MERGE_SETTLEMENT_CONFLICT: "TASK_BOARD_PIPELINE_MERGE_SETTLEMENT_CONFLICT",
  TASK_BOARD_PIPELINE_PLAN_INCOMPLETE: "TASK_BOARD_PIPELINE_PLAN_INCOMPLETE",
  TASK_BOARD_PIPELINE_REPO_BUSY: "TASK_BOARD_PIPELINE_REPO_BUSY",
  TASK_BOARD_PIPELINE_REPO_UNAVAILABLE: "TASK_BOARD_PIPELINE_REPO_UNAVAILABLE",
  TASK_BOARD_PUBLISHED_INTERFACE_UNAVAILABLE: "TASK_BOARD_PUBLISHED_INTERFACE_UNAVAILABLE",
  // retired campaign 7 — kept for old clients
  TASK_BOARD_PIPELINE_SERIAL_CONFLICT: "TASK_BOARD_PIPELINE_SERIAL_CONFLICT",
  TASK_BOARD_REVIEW_FINDINGS_NOT_ALLOWED: "TASK_BOARD_REVIEW_FINDINGS_NOT_ALLOWED",
  TASK_BOARD_REVIEW_FINDINGS_REQUIRED: "TASK_BOARD_REVIEW_FINDINGS_REQUIRED",
  TASK_BOARD_REVIEW_OUTCOME_MISMATCH: "TASK_BOARD_REVIEW_OUTCOME_MISMATCH",
  TASK_BOARD_REVIEW_RUNTIME_CONFLICT: "TASK_BOARD_REVIEW_RUNTIME_CONFLICT",
  TASK_BOARD_DESIGN_RECORD_REQUIRED: "TASK_BOARD_DESIGN_RECORD_REQUIRED",
  TASK_BOARD_DESIGN_RECORD_NOT_ALLOWED: "TASK_BOARD_DESIGN_RECORD_NOT_ALLOWED",
  TASK_BOARD_PARK_RECORD_REQUIRED: "TASK_BOARD_PARK_RECORD_REQUIRED",
  TASK_BOARD_PARK_RECORD_INVALID: "TASK_BOARD_PARK_RECORD_INVALID",
  TASK_BOARD_NOTIFICATION_NOT_FOUND: "TASK_BOARD_NOTIFICATION_NOT_FOUND",
  TASK_BOARD_BOARD_PAUSE_VERSION_CONFLICT: "TASK_BOARD_BOARD_PAUSE_VERSION_CONFLICT",
  TASK_TERMINAL: "TASK_TERMINAL",
  TASK_UNASSIGNED: "TASK_UNASSIGNED",
  TASK_WORKFLOW_BOUND: "TASK_WORKFLOW_BOUND",
  TASK_WORKFLOW_ATTEMPT_SUPERSEDED: "TASK_WORKFLOW_ATTEMPT_SUPERSEDED",
  WORK_NODE_VERSION_CONFLICT: "WORK_NODE_VERSION_CONFLICT",
  WORK_ITEM_ENDED: "WORK_ITEM_ENDED",
  WORK_ITEM_ILLEGAL_TRANSITION: "WORK_ITEM_ILLEGAL_TRANSITION",
  WORK_ITEM_NOT_TERMINAL: "WORK_ITEM_NOT_TERMINAL",
} as const);
export type TaskBoardErrorCode = (typeof TASK_BOARD_ERROR_CODES)[keyof typeof TASK_BOARD_ERROR_CODES];
export const AUTOMATION_CONFIGURATION_MAX_BYTES = 48 * 1_024;
export const TASK_MESSAGE_PAGE_SIZE = 200;
export const WORK_ITEM_PAGE_SIZE = 200;
export const WORK_ITEM_CURSOR_MAX_BYTES = 512;
export const REVIEW_WORKSPACE_SUFFIX = "-review";
export const VERIFY_WORKSPACE_SUFFIX = "-verify";
export const MAX_INTERNAL_TASK_OBJECTIVE_CHARACTERS = 768_000;
export const MAX_AREA_MEMORY_RESULT_CHARACTERS = 1_000;
export const MAX_AGENT_CONTEXT_BYTES = 256 * 1_024;
export const MAX_DESIGN_CONTEXT_BYTES = 4 * 1_024 * 1_024;
export const TASK_WORKER_OUTPUT_ID_PREFIX = "twe_" as const;
export const TASK_WORKER_ACTIVITY_ID_PREFIX = "twa_" as const;
export const TASK_WORKER_SETTLEMENT_ID_PREFIX = "tws_" as const;
export const PUBLISHED_INTERFACE_FAILURE_REASONS = Object.freeze([
  "absent",
  "not_file",
  "too_large",
  "invalid_markdown",
  "empty",
  "read_error",
  "over_budget",
] as const);
export type PublishedInterfaceFailureReason = (typeof PUBLISHED_INTERFACE_FAILURE_REASONS)[number];
export const AGENT_GAP_REPORT_MAX_CHARACTERS = 32_000;
export const SCOPE_HOLD_SUMMARY_PREFIX = "scope-hold: ";

export class ContractValidationError extends Error {
  constructor(
    message: string,
    readonly code = "INVALID_REQUEST"
  ) {
    super(message);
    this.name = "ContractValidationError";
  }
}

export function normalizeDeclaredScope(declaredScope: readonly string[]): readonly string[] {
  const normalizedScope = declaredScope.map((prefix) => prefix.replace(/\/+$/u, ""));
  if (normalizedScope.some((prefix) => prefix.length === 0)) {
    throw new ContractValidationError("declared scope contains an empty path prefix");
  }
  return normalizedScope;
}

export function declaredScopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  const normalizedA = normalizeDeclaredScope(a);
  const normalizedB = normalizeDeclaredScope(b);
  return normalizedA.some((x) => normalizedB.some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
}

// Grammar changes begin here: runtime validators, web types, and generated schemas
// derive from these values. store.ts interpolates these arrays into SQL CHECKs:
// AGENT_ROLES, TASK_KINDS, TASK_STATUSES, TASK_PHASE_STAGES,
// TASK_PHASE_STATUSES, TASK_MESSAGE_KINDS, ACTOR_TYPES, QUESTION_STATUSES,
// WAKEUP_REASONS, RUN_STATUSES, TASK_MESSAGE_ACTOR_TYPES,
// WORK_ITEM_PRIORITIES, WORK_ITEM_STATES, WORK_ITEM_TERMINAL_STATES,
// WORK_ITEM_PHASES, WORK_ITEM_STAGES, WORKFLOW_STAGES, PLAN_REVISION_STATES,
// WORK_NODE_STATES, STAGE_HANDOFF_OUTCOMES, REVIEW_FINDING_CATEGORIES,
// REVIEW_FINDING_SEVERITIES, PARK_CATEGORIES, PARK_RESOLUTIONS,
// NOTIFICATION_KINDS, GATE_KINDS, and DOCUMENT_ACTOR_TYPES. Changing one also
// requires a schema-version bump and rebuild migration for existing databases.
export const IDENTIFIER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$" as const;
export const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

const PROHIBITED_CROSS_REPO_MARKDOWN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u;

// Persisted cross-repository prompts reject controls and unpaired surrogates.
export function isValidCrossRepoMarkdown(value: string): boolean {
  return !PROHIBITED_CROSS_REPO_MARKDOWN.test(value);
}

/* —— State-machine vocabulary —— */

export const AGENT_ROLES = ["engineer", "manager", "verifier"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_STATUSES = ["idle", "ready", "running", "interrupting", "waiting_for_human"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const WORKER_CONNECTIONS = ["waiting_for_wake", "watching_run"] as const;
export type WorkerConnection = (typeof WORKER_CONNECTIONS)[number] | null;

export const TASK_KINDS = ["work", "manager_review", "human_check"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATUSES = [
  "backlog",
  "queued",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isRecoverableTaskStatus(
  status: TaskStatus
): status is Extract<TaskStatus, "failed" | "blocked" | "interrupted"> {
  return status === "failed" || status === "blocked" || status === "interrupted";
}

export function isHardTerminalTaskStatus(status: TaskStatus): status is Extract<TaskStatus, "completed" | "cancelled"> {
  return status === "completed" || status === "cancelled";
}

export const TASK_PHASE_STAGES = ["research", "planning", "execution", "testing", "review", "done"] as const;
export type TaskPhaseStage = (typeof TASK_PHASE_STAGES)[number];

export const TASK_PHASE_STATUSES = ["pending", "in_progress", "blocked", "completed", "failed"] as const;
export type TaskPhaseStatus = (typeof TASK_PHASE_STATUSES)[number];

export const TASK_MESSAGE_KINDS = ["note", "progress", "proposal", "result"] as const;
export type TaskMessageKind = (typeof TASK_MESSAGE_KINDS)[number];

export const ACTOR_TYPES = ["human", "agent", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const QUESTION_STATUSES = ["open", "answered"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/** Adding a wake reason here also authorizes the task worker to launch for it. */
export const WAKEUP_REASONS = [
  "human_assignment",
  "human_answer",
  "human_resume",
  "workflow_handoff",
  "assigned",
  "resumed",
] as const;
export type WakeupReason = (typeof WAKEUP_REASONS)[number];

export const RUN_STATUSES = ["active", "waiting_for_human", "completed", "failed", "interrupted"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TASK_MESSAGE_ACTOR_TYPES = ["human", "agent"] as const;

export const WORK_ITEM_PRIORITIES = ["urgent", "high", "normal", "low", "opportunistic"] as const;
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];

export const WORK_ITEM_TASK_TYPES = ["standard", "onboarding"] as const;
export type WorkItemTaskType = (typeof WORK_ITEM_TASK_TYPES)[number];

export const WORK_ITEM_STATES = [
  "queued",
  "planning",
  "plan_approval",
  "coordinating",
  "designing",
  "implementing",
  "verifying",
  "reviewing",
  "fixing",
  "final_approval",
  "merged",
  "parked",
  "abandoned",
  "dead_letter",
] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

export const WORK_ITEM_PHASES = ["expand", "migrate", "contract"] as const;
export type WorkItemPhase = (typeof WORK_ITEM_PHASES)[number];

export const WORK_ITEM_TERMINAL_STATES = ["merged", "abandoned", "dead_letter"] as const;

export function isTerminalWorkItemState(state: WorkItemState): boolean {
  return (WORK_ITEM_TERMINAL_STATES as readonly WorkItemState[]).includes(state);
}

/* —— Work-item transition policy —— */

export const WORK_ITEM_TRANSITIONS: Readonly<Record<WorkItemState, readonly WorkItemState[]>> = {
  queued: ["planning", "designing", "implementing", "parked", "abandoned", "dead_letter"],
  planning: [
    "plan_approval",
    // legacy stage-driven flow — removed when campaign 4's pipeline drives these gates
    "implementing",
    // legacy stage-driven flow — removed when campaign 4's pipeline drives these gates
    "verifying",
    // legacy stage-driven flow — removed when campaign 4's pipeline drives these gates
    "reviewing",
    "parked",
    "abandoned",
    "dead_letter",
  ],
  plan_approval: [
    "coordinating",
    "designing",
    "implementing",
    // legacy stage-driven flow — removed when campaign 4's pipeline drives these gates
    "verifying",
    // legacy stage-driven flow — removed when campaign 4's pipeline drives these gates
    "reviewing",
    // legacy stage-driven flow — removed when campaign 4's pipeline drives these gates
    "planning",
    "parked",
    "abandoned",
    "dead_letter",
  ],
  coordinating: ["final_approval", "merged", "parked", "abandoned", "dead_letter"],
  designing: ["implementing", "parked", "abandoned", "dead_letter"],
  implementing: [
    "verifying",
    // legacy stage-driven flow — removed when campaign 4's pipeline drives these gates
    "reviewing",
    // legacy stage-driven flow — removed when campaign 4's pipeline drives these gates
    "planning",
    // legacy completion — removed when campaign 4's pipeline drives final_approval
    "merged",
    "parked",
    "abandoned",
    "dead_letter",
  ],
  verifying: [
    "reviewing",
    "fixing",
    "final_approval",
    // legacy stage-driven flow — removed when campaign 4's pipeline drives these gates
    "implementing",
    // legacy stage-driven flow — removed when campaign 4's pipeline drives these gates
    "planning",
    "parked",
    "abandoned",
    "dead_letter",
  ],
  reviewing: [
    "fixing",
    "planning",
    // legacy stage-driven flow — removed when campaign 4's pipeline drives these gates
    "implementing",
    // legacy stage-driven flow — removed when campaign 4's pipeline drives these gates
    "verifying",
    "final_approval",
    // legacy completion — removed when campaign 4's pipeline drives final_approval
    "merged",
    "parked",
    "abandoned",
    "dead_letter",
  ],
  fixing: ["verifying", "parked", "abandoned", "dead_letter"],
  final_approval: ["coordinating", "merged", "fixing", "implementing", "parked", "abandoned", "dead_letter"],
  merged: [],
  parked: [
    "coordinating",
    "planning",
    "implementing",
    // legacy stage-driven flow — removed when campaign 4's pipeline drives these gates
    "verifying",
    // legacy stage-driven flow — removed when campaign 4's pipeline drives these gates
    "reviewing",
    // campaign 5: unparked fix-round items re-enter the fix loop
    "fixing",
    "abandoned",
    "dead_letter",
  ],
  abandoned: [],
  dead_letter: [],
};

export function isWorkItemTransitionAllowed(from: WorkItemState, to: WorkItemState): boolean {
  return WORK_ITEM_TRANSITIONS[from].includes(to);
}

export const WORK_ITEM_STAGES = [
  "refinement",
  "project_resolution",
  "research",
  "planning",
  "implementation",
  "testing",
  "verification",
  "human_review",
  "deployment",
] as const;
export type WorkItemStage = (typeof WORK_ITEM_STAGES)[number];

// This authorization table is part of the stage vocabulary: adding a stage must
// define its eligible agent roles here before the contract can typecheck.
export const AUTOMATION_STAGE_ALLOWED_ROLES: Readonly<Record<WorkItemStage, readonly AgentRole[]>> = Object.freeze({
  refinement: Object.freeze(["manager"] as const),
  project_resolution: Object.freeze(["manager"] as const),
  research: Object.freeze(["engineer", "verifier"] as const),
  planning: Object.freeze(["engineer"] as const),
  implementation: Object.freeze(["engineer"] as const),
  testing: Object.freeze(["engineer", "verifier"] as const),
  verification: Object.freeze(["verifier"] as const),
  human_review: Object.freeze([] as const),
  deployment: Object.freeze([] as const),
} satisfies Record<WorkItemStage, readonly AgentRole[]>);

export const WORKFLOW_STAGES = ["research", "planning", "implementation", "testing", "verification"] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export const PARK_CATEGORIES = [
  "open_question",
  "planning_run_failed",
  "design_run_failed",
  "hazardous_without_pipeline",
  "plan_rejected_twice",
  "bright_line",
  "scope_violation",
  "stage_cap_exceeded",
  "task_cap_exceeded",
  "base_diverged",
  "child_failed",
] as const;
export const PARK_RESOLUTIONS = ["resumed", "abandoned", "auto_abandoned", "dead_letter"] as const;
export const NOTIFICATION_KINDS = [
  "park_aged",
  "park_auto_abandoned",
  "cap_parked",
  "final_approval_withdrawn",
  "parent_ready_for_approval",
  "phase_ready",
] as const;
export const GATE_KINDS = [
  "plan_confirm",
  "plan_reject",
  "final_approve",
  "final_reject",
  "cancel",
  "question_answer",
  "deploy_attest",
] as const;
export type ParkCategory = (typeof PARK_CATEGORIES)[number];

// The pipeline_plans CTE in src/server/task-board/collaborators/wall-clock.ts
// mirrors this predicate in SQL when discovering capped pipeline runs.
export function pipelineTemplateShape(template: readonly WorkflowStage[]): "v1" | "v2" | null {
  if (template.length === 2 && template[0] === "implementation" && template[1] === "testing") return "v1";
  if (
    template.length === 3 &&
    template[0] === "implementation" &&
    template[1] === "testing" &&
    template[2] === "verification"
  )
    return "v2";
  return null;
}

/* —— Review and design policy —— */

export const REVIEW_FINDING_CATEGORIES = [
  "correctness",
  "security",
  "plan_deviation",
  "test_modification",
  "docs",
  "style",
  "other",
] as const;
export const REVIEW_FINDING_SEVERITIES = ["minor", "major", "critical"] as const;
export const BLOCKING_REVIEW_FINDING_CATEGORIES = ["correctness", "security", "plan_deviation"] as const;
export type ReviewFindingCategory = (typeof REVIEW_FINDING_CATEGORIES)[number];
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

// These bounds keep a maximally sized findings list inside the default 64 KiB
// run-settlement transport, including the settlement's maximally sized result.
export const REVIEW_FINDING_DRAFT_MAX_ITEMS = 16;
export const REVIEW_FINDING_DRAFT_TEXT_MAX_LENGTH = 1_000;

export function reviewFindingBlocks(category: ReviewFindingCategory): boolean {
  return (BLOCKING_REVIEW_FINDING_CATEGORIES as readonly ReviewFindingCategory[]).includes(category);
}

export const DESIGN_FAILURE_POINTS = [
  "crash_before_send",
  "crash_after_send_before_response",
  "crash_after_response_before_commit",
  "crash_after_commit_before_ack",
  "duplicate_delivery",
  "concurrent_invocation",
] as const;
export type DesignFailurePointKind = (typeof DESIGN_FAILURE_POINTS)[number];

// These bounds keep a maximally sized design record plus the settlement's
// maximally sized result inside the default 64 KiB outcome/HTTP transport.
export const DESIGN_RECORD_MAX_STATES = 32;
export const DESIGN_RECORD_MAX_TRANSITIONS = 64;
export const DESIGN_RECORD_MAX_FAILURE_POINTS = DESIGN_FAILURE_POINTS.length;
export const DESIGN_RECORD_MAX_IDEMPOTENCY_KEYS = 8;
export const DESIGN_RECORD_MAX_FAULT_INJECTION_CASES = 8;
export const DESIGN_RECORD_LABEL_MAX_LENGTH = 96;
export const DESIGN_RECORD_DETAIL_MAX_LENGTH = 128;

export const PLAN_REVISION_STATES = ["proposed", "confirmed", "superseded", "rejected"] as const;
export type PlanRevisionState = (typeof PLAN_REVISION_STATES)[number];

export const PLAN_CHANGE_SHAPES = ["mechanical_sweep", "feature", "blast_radius"] as const;
export const PLAN_TIERS = ["standard", "hazardous"] as const;

/* —— Workflow planning and automation —— */

export interface PlanBlockingQuestion {
  readonly question: string;
  readonly recommendedDefault: string;
}

export interface PlanCriterionCheck {
  readonly criterion: string;
  readonly check: string;
}

export interface DeclaredChild {
  readonly key: string;
  readonly objective: string;
  readonly projectId: string;
  /** Absent targets the project's primary repository. */
  readonly repositoryId?: string;
  readonly declaredScope: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly phase?: WorkItemPhase;
  readonly dependsOn?: readonly string[];
  readonly splitBy?: "consumer" | "phase";
}

/** All optional; present together on pipeline plans. */
export interface PlanRecordFields {
  readonly changeShape?: (typeof PLAN_CHANGE_SHAPES)[number];
  readonly tier?: (typeof PLAN_TIERS)[number];
  readonly declaredScope?: readonly string[];
  readonly nonGoals?: readonly string[];
  readonly mechanicalPortions?: readonly string[];
  readonly blockingQuestions?: readonly PlanBlockingQuestion[];
  readonly criterionChecks?: readonly PlanCriterionCheck[];
}

export interface WorkflowPipelineContext {
  readonly branch: string;
  readonly baseSha: string;
  readonly changeShape: (typeof PLAN_CHANGE_SHAPES)[number];
  readonly tier: (typeof PLAN_TIERS)[number];
  readonly declaredScope: readonly string[];
  readonly nonGoals: readonly string[];
  readonly assumptions: readonly string[];
  /** Absent is accepted from claims persisted before the hazardous Design stage. */
  readonly designRecord?: DesignRecordDraft | null;
}

export interface WorkflowReviewContext {
  readonly commits: readonly { readonly sha: string; readonly subject: string }[];
  readonly diffstat: string;
  readonly filesTouched: readonly {
    readonly path: string;
    readonly status: "added" | "modified" | "deleted";
  }[];
  readonly scopeOk: boolean;
  readonly midRunAssumptions: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly criterionChecks: readonly PlanCriterionCheck[];
  readonly mechanicalPortions: readonly string[];
  readonly priorFindings: readonly ReviewFinding[];
  readonly priorFindingsTruncated: boolean;
}

export interface WorkflowFixContext {
  readonly round: number;
  readonly findings: readonly ReviewFinding[];
}

export const WORK_NODE_STATES = ["pending", "ready", "active", "blocked", "stale", "completed", "cancelled"] as const;
export type WorkNodeState = (typeof WORK_NODE_STATES)[number];

export const STAGE_HANDOFF_OUTCOMES = ["passed", "failed", "needs_input"] as const;
export type StageHandoffOutcome = (typeof STAGE_HANDOFF_OUTCOMES)[number];
export const STAGE_HANDOFF_SUMMARY_MAX_CHARACTERS = 4_000;
export const STAGE_HANDOFF_BLOCKERS_MAX_ITEMS = 32;
export type ArtifactMediaType =
  | "text/markdown"
  | "text/vnd.mermaid"
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/svg+xml";
// Automatic targets remain readable for old clients and persisted records, while
// current work-item request parsers accept only explicit projects.
export type WorkItemProjectTarget = Readonly<{ mode: "auto" }> | Readonly<{ mode: "explicit"; projectId: string }>;
export const EVALUATOR_PROFILES = ["tests", "editorial", "visual", "manual"] as const;
export type AgentTypeEvaluatorProfile = (typeof EVALUATOR_PROFILES)[number];
export type AutomationStageExecutor =
  | Readonly<{ kind: "agent_type"; agentTypeId: string }>
  | Readonly<{ kind: "machine_verify" }>
  | Readonly<{ kind: "human" }>
  | Readonly<{ kind: "disabled" }>;

export interface AutomationAgentType {
  readonly agentTypeId: string;
  readonly name: string;
  readonly description: string;
  // Supplemental configuration cannot expand this fixed authority ceiling.
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

/* —— Board and work-item records —— */

export interface BoardPause {
  readonly paused: boolean;
  readonly reason: string | null;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface WorkItem {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly workItemId: string;
  // Refinement is stored separately so the accepted human submission remains immutable.
  readonly originalRequest: string;
  readonly refinedObjective: string | null;
  readonly priority: WorkItemPriority;
  readonly taskType: WorkItemTaskType;
  readonly projectTarget: WorkItemProjectTarget;
  readonly resolvedProjectId: string | null;
  /** Null inherits the resolved project's primary repository; a value pins this work item. */
  readonly repositoryId: string | null;
  readonly parentWorkItemId: string | null;
  readonly phase: WorkItemPhase | null;
  readonly childOrdinal: number | null;
  /** Durable link to the manager task that refines and proposes this work item's workflow. */
  readonly planningTaskId: string | null;
  readonly pipelineBranch?: string | null;
  readonly baseSha?: string | null;
  readonly state: WorkItemState;
  readonly currentStage: WorkItemStage | null;
  /** List projection only; absent from older and detail payloads. */
  readonly stateSince?: string | null;
  /** List projection only; absent from older and detail payloads. */
  readonly reviewRound?: number | null;
  /** List projection only; absent from older and detail payloads. */
  readonly heartbeatAt?: string | null;
  readonly createdBy: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
  /** Human-supplied reason recorded uniformly when the item is cancelled. */
  readonly cancelledReason: string | null;
  readonly archivedAt: string | null;
}

export interface ChildWorkItem extends WorkItem {
  readonly deployAttested: boolean;
  readonly mergeSha: string | null;
}

export interface ParentCompletion {
  readonly parentWorkItemId: string;
  readonly children: readonly Readonly<{
    readonly workItemId: string;
    readonly mergeSha: string | null;
  }>[];
}

export interface WorkItemDependency {
  readonly workItemId: string;
  readonly dependsOnWorkItemId: string;
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

export interface PlanRevision extends PlanRecordFields {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly planRevisionId: string;
  readonly workItemId: string;
  readonly revision: number;
  readonly objective: string;
  readonly assumptions: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly children: readonly DeclaredChild[] | null;
  readonly projectId: string;
  readonly skillDigests: Readonly<Record<string, string>>;
  readonly state: PlanRevisionState;
  readonly createdBy: string;
  readonly confirmedBy: string | null;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
  readonly rejectedNote?: string;
}

export interface ParkRecord {
  readonly parkRecordId: string;
  readonly workItemId: string;
  readonly category: ParkCategory;
  readonly reason: string;
  readonly parkedAt: string;
  readonly resolvedAt: string | null;
  readonly resolution: (typeof PARK_RESOLUTIONS)[number] | null;
}

export interface BoardNotification {
  readonly notificationId: string;
  readonly sequence: number;
  readonly kind: (typeof NOTIFICATION_KINDS)[number];
  readonly dedupeKey: string | null;
  readonly projectId: string | null;
  readonly workItemId: string | null;
  readonly summary: string;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly version: number;
}

export interface GateAction {
  readonly gateActionId: string;
  readonly workItemId: string;
  readonly gate: (typeof GATE_KINDS)[number];
  readonly actorId: string;
  readonly planRevisionId: string | null;
  readonly verifiedSha: string | null;
  readonly mergeSha: string | null;
  readonly refId: string | null;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface WorkItemTransition {
  readonly fromState: WorkItemState | null;
  readonly toState: WorkItemState;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly createdAt: string;
}

export interface WorkItemAudit {
  readonly gateActions: readonly GateAction[];
  readonly transitions: readonly WorkItemTransition[];
}

export interface ReviewFindingDraft {
  readonly file?: string | null;
  readonly line?: number | null;
  readonly category: ReviewFindingCategory;
  readonly severity: ReviewFindingSeverity;
  readonly expected: string;
  readonly actual: string;
}

export interface ReviewFinding extends ReviewFindingDraft {
  readonly findingId: string;
  readonly nodeId: string;
  readonly stage: WorkflowStage;
  readonly round: number;
  readonly blocking: boolean;
  readonly createdAt: string;
}

export interface FindingsLedger {
  readonly categories: readonly {
    readonly category: ReviewFindingCategory;
    readonly severity: ReviewFindingSeverity;
    readonly blocking: boolean;
    readonly count: number;
  }[];
  readonly perProject: readonly {
    readonly projectId: string;
    readonly category: ReviewFindingCategory;
    readonly count: number;
  }[];
  readonly recent: readonly (ReviewFinding & { readonly workItemId: string })[];
}

export interface ParksLedger {
  readonly open: readonly (ParkRecord & { readonly workItemTitle: string })[];
  readonly resolved: readonly (ParkRecord & { readonly workItemTitle: string })[];
  readonly recordsSince: string;
}

export interface DesignTransition {
  readonly from: string;
  readonly to: string;
  readonly durablePrecondition?: string;
  readonly recovery?: string;
}

export interface DesignFailurePoint {
  readonly point: DesignFailurePointKind;
  readonly resultingState: string;
  readonly recovery: string;
}

export interface DesignIdempotencyKey {
  readonly name: string;
  readonly generatedAt: string;
  readonly persistedAt: string;
  readonly reuse: string;
}

export interface DesignFaultInjectionCase {
  readonly name: string;
  readonly scenario: string;
  readonly expectation: string;
}

export interface DesignRecordDraft {
  readonly states: readonly string[];
  readonly transitions: readonly DesignTransition[];
  readonly failurePoints: readonly DesignFailurePoint[];
  readonly idempotencyKeys: readonly DesignIdempotencyKey[];
  readonly faultInjectionCases: readonly DesignFaultInjectionCase[];
}

export interface DesignRecord extends DesignRecordDraft {
  readonly designRecordId: string;
  readonly workItemId: string;
  readonly planRevisionId: string;
  readonly createdAt: string;
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

/* —— Pipeline evidence, artifacts, and plan requests —— */

export interface VerifyAttempt {
  readonly verifyAttemptId: string;
  readonly nodeId: string;
  readonly stage: WorkflowStage;
  readonly attempt: number;
  readonly verifyRunId: string | null;
  readonly workspacePath: string | null;
  readonly state: "starting" | "running" | "green" | "failed" | "died" | "failed_to_start" | "retired";
  readonly checkResults:
    | readonly { readonly criterion: string; readonly check: string; readonly passed: boolean }[]
    | null;
  readonly detail: string | null;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

export interface PipelineCommit {
  readonly sha: string;
  readonly subject: string;
}

export interface PipelineSummary {
  readonly commits: readonly PipelineCommit[];
  readonly diffstat: string;
  readonly filesTouched: readonly string[];
  readonly declaredScope: readonly string[];
  readonly scopeOk: boolean;
  readonly assumptions: readonly string[];
  readonly midRunAssumptions: readonly string[];
  readonly verify: readonly VerifyAttempt[];
  readonly criteria: readonly string[];
  readonly criterionChecks: readonly PlanCriterionCheck[];
  readonly findings: readonly ReviewFinding[];
  readonly designRecord: DesignRecordDraft | null;
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

export interface WorkflowPlanDraft extends PlanRecordFields {
  readonly objective: string;
  readonly assumptions: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly nodes: readonly ProposedWorkNode[];
  readonly children?: readonly DeclaredChild[];
}

export interface CreatePlanRevisionRequest extends PlanRecordFields {
  readonly workItemId: string;
  readonly objective: string;
  readonly assumptions: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly children?: readonly DeclaredChild[];
  readonly projectId: string;
  readonly skillIds: readonly string[];
  readonly nodes: readonly ProposedWorkNode[];
}

export interface ConfirmPlanRevisionRequest {
  readonly expectedState: "proposed";
}

export interface RejectPlanRevisionRequest {
  readonly note: string;
  readonly expectedState: "proposed";
}

export interface ApprovePipelineMergeRequest {
  readonly version: number;
}

export interface AttestDeployRequest {
  readonly note?: string;
}

export interface AttestDeployResult {
  readonly gateAction: GateAction;
  readonly duplicate: boolean;
}

export interface RejectFinalApprovalRequest {
  readonly version: number;
  readonly note: string;
}

export interface RejectPlanRevisionResponse {
  readonly outcome: "revising" | "parked";
}

// The outcome stays optional for compatibility with the original activation response.
export interface ConfirmPlanRevisionResponse<Workflow = unknown> {
  readonly workflow: Workflow;
  readonly outcome?: "parked_hazardous" | "designing";
}

/* —— Projects, tasks, and claim records —— */

export interface Project {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly projectId: string;
  readonly name: string;
  readonly description: string;
  readonly repoPath: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Repository {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly repositoryId: string;
  readonly projectId: string;
  readonly name: string;
  readonly path: string;
  readonly isPrimary: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentProfile {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly agentId: string;
  readonly projectId: string;
  /** The repository this agent's worker holds. Null means the project's primary, never "any". */
  readonly repositoryId: string | null;
  readonly role: AgentRole;
  readonly area: string;
  readonly mission: string;
  readonly model: string;
  readonly status: AgentStatus;
  /** Instance-local observation from an authenticated held request; never durable health state. */
  readonly workerConnection: WorkerConnection;
  /** Most recent fleet fatal-class error; cleared after the lane next claims work successfully. */
  readonly lastError: string | null;
  readonly version: number;
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
  readonly heartbeatAt: string | null;
  readonly endedAt: string | null;
  readonly result: string | null;
  readonly runtime: string | null;
  readonly runtimeVersion: string | null;
  readonly model: string | null;
  readonly promptsSha: string | null;
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
  readonly repositories: readonly Repository[];
  readonly agents: readonly AgentProfile[];
  readonly tasks: readonly BoardTask[];
  readonly openQuestions: readonly HumanQuestion[];
  readonly recentQuestions: readonly HumanQuestion[];
  readonly recentRuns: readonly AgentRun[];
  readonly recentInterrupts: readonly AgentInterrupt[];
  readonly recentEvents: readonly TaskEvent[];
}

export interface CrossRepoContext {
  readonly providerProjectId: string;
  /** Present on new claims; absent from claim results persisted before repository targeting. */
  readonly providerWorkItemId?: string;
  readonly providerRepoName: string;
  readonly interfacePath: "docs/interface.md";
  readonly sha: string;
  readonly markdown: string;
}

export interface BoardProjectContext {
  readonly projectId: string;
  readonly name: string;
  readonly repoName: string;
}

export interface ClaimRunResult {
  readonly apiVersion: typeof TASK_BOARD_API_VERSION;
  readonly run: AgentRun;
  readonly wakeup: Wakeup;
  readonly task: BoardTask | null;
  readonly context: Readonly<{
    intake: boolean;
    /** Present on intake claims; absent on legacy persisted claims and non-intake work. */
    boardProjects?: readonly BoardProjectContext[];
    onboarding?: true;
    design: boolean;
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
    /** Absent is accepted from claim replays created before phased prompt authorization. */
    readonly phase?: WorkItemPhase | null;
    readonly crossRepoContext?: CrossRepoContext;
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
      /** Absent is accepted from pre-pipeline claim replays and normalizes to null at the worker boundary. */
      workspaceKey?: string | null;
      /** Absent is accepted from pre-pipeline claim replays and normalizes to null at the worker boundary. */
      pipeline?: WorkflowPipelineContext | null;
      /** Absent is accepted from claims created before independent pipeline review. */
      review?: WorkflowReviewContext | null;
      /** Absent is accepted from claims created before findings-driven fix rounds. */
      fix?: WorkflowFixContext | null;
    }> | null;
  }>;
}

/* —— Mutating request payloads —— */

export interface CreateProjectRequest {
  readonly name: string;
  readonly description: string;
  readonly repoPath?: string;
}

export interface CreateRepositoryRequest {
  readonly name: string;
  readonly path: string;
}

export interface UpdateRepositoryRequest {
  readonly version: number;
  readonly name?: string;
  readonly path?: string;
}

export interface UpdateProjectRequest {
  readonly name?: string;
  readonly description?: string;
  readonly repoPath?: string;
}

export interface CreateWorkItemRequest {
  readonly originalRequest: string;
  readonly priority?: WorkItemPriority;
  readonly taskType?: WorkItemTaskType;
  // Optional only for older clients; the current server rejects an absent or automatic target.
  readonly projectTarget?: WorkItemProjectTarget;
}

export type UpdateWorkItemRequest =
  | Readonly<{
      version: number;
      priority?: WorkItemPriority;
      projectTarget?: WorkItemProjectTarget;
      action?: never;
      reason?: never;
    }>
  | Readonly<{
      version: number;
      action: "cancel";
      reason: string;
      priority?: never;
      projectTarget?: never;
    }>
  | Readonly<{
      version: number;
      action: "archive";
      reason?: never;
      priority?: never;
      projectTarget?: never;
    }>;

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
  /** Omitted scopes the agent to the project's primary repository. */
  readonly repositoryId?: string;
}

export interface RotateAgentTokenRequest {
  readonly version: number;
}

export interface RotateAgentTokenResponse {
  readonly agent: AgentProfile;
  /** Returned only in this one-time rotation response. It is never persisted in plaintext or included in snapshots. */
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

export interface RetryTaskRequest {
  readonly version: number;
}

export interface RetryTaskResponse {
  readonly task: BoardTask;
  readonly wakeup: Wakeup;
}

export interface BacklogTaskRequest {
  readonly version: number;
}

export interface BacklogTaskResponse {
  readonly task: BoardTask;
}

export interface CreateTaskMessageRequest {
  readonly clientEventId: string;
  readonly kind: TaskMessageKind;
  readonly body: string;
  readonly runId: string;
}

/** A persisted claim exists but may not be replayed until the board resumes. */
export interface ClaimRunPausedResult {
  readonly paused: true;
}

export type ClaimRunResponse = ClaimRunResult | ClaimRunPausedResult;

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

export interface ClaimRunPinning {
  readonly runtime?: string;
  readonly runtimeVersion?: string;
  readonly model?: string;
  readonly promptsSha?: string;
}

export type ClaimRunRequest =
  | Readonly<{
      claimId: string;
      /** Legacy single-task cursor. New workers send `messageCursors` instead. */
      messageCursor: number | null;
      messageCursors?: never;
      pinned?: ClaimRunPinning;
    }>
  | Readonly<{
      claimId: string;
      /** Per-task cursors prevent activity on one task from hiding older messages on another. */
      messageCursors: Readonly<Record<string, number>>;
      messageCursor?: never;
      pinned?: ClaimRunPinning;
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
  readonly gapReport?: string;
  readonly handoff?: StageHandoffDraft | null;
  readonly workflowPlan?: WorkflowPlanDraft | null;
  readonly reviewFindings?: readonly ReviewFindingDraft[];
  readonly designRecord?: DesignRecordDraft;
}
