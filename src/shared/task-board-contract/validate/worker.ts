/** Validates the worker trust boundary: claims, workflow context, and run outputs. */

/* —— Imports —— */

import {
  AGENT_ROLES,
  type AgentRole,
  type BoardProjectContext,
  ContractValidationError,
  type CrossRepoContext,
  type DesignRecordDraft,
  GIT_OBJECT_ID_PATTERN,
  MAX_AGENT_CONTEXT_BYTES,
  MAX_AREA_MEMORY_RESULT_CHARACTERS,
  MAX_DESIGN_CONTEXT_BYTES,
  MAX_INTERNAL_TASK_OBJECTIVE_CHARACTERS,
  PLAN_CHANGE_SHAPES,
  PLAN_TIERS,
  type PublishedInterfaceFailureReason,
  QUESTION_STATUSES,
  REVIEW_WORKSPACE_SUFFIX,
  type ReviewFindingDraft,
  STAGE_HANDOFF_BLOCKERS_MAX_ITEMS,
  STAGE_HANDOFF_OUTCOMES,
  STAGE_HANDOFF_SUMMARY_MAX_CHARACTERS,
  type SkillSnapshot,
  type StageHandoff,
  type StageHandoffDraft,
  TASK_BOARD_API_VERSION,
  TASK_KINDS,
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  type TaskKind,
  type TaskPhaseStage,
  type TaskPhaseStatus,
  VERIFY_WORKSPACE_SUFFIX,
  WORKFLOW_STAGES,
  WORK_ITEM_PHASES,
  type WorkItemPhase,
  type WorkflowFixContext,
  type WorkflowPipelineContext,
  type WorkflowPlanDraft,
  type WorkflowReviewContext,
  type WorkflowStage,
  isValidCrossRepoMarkdown,
} from "../index.js";
import {
  boundedPlanArray,
  expectedMinutes,
  parseDesignRecordDraft,
  parseReviewFindingEntity,
  planCheck,
  planScopeEntry,
  reviewFindingFile,
} from "./entities.js";
import {
  type JsonRecord,
  booleanValue,
  contractMember,
  exact,
  identifier,
  integer,
  prose,
  record,
  text,
  timestamp,
} from "./scalars.js";

/* —— Worker claim boundary —— */

export type { StageHandoffDraft, WorkflowPlanDraft };

interface ValidatedTaskWakeClaim {
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

interface ValidatedAgentTaskPhase {
  readonly phaseId: string;
  readonly title: string;
  readonly stage: TaskPhaseStage;
  readonly status: TaskPhaseStatus;
  readonly parallelGroup: string | null;
  readonly orderKey: number;
  readonly version: number;
}

interface ValidatedAgentTaskPhaseUpdate extends Omit<ValidatedAgentTaskPhase, "phaseId" | "version"> {
  readonly phaseId: string | null;
}

interface ValidatedAgentContext {
  readonly apiVersion: 1;
  readonly projectId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly intake: boolean;
  readonly boardProjects?: readonly BoardProjectContext[];
  readonly onboarding?: true;
  readonly design: boolean;
  readonly mission: Readonly<{ role: string; area: string; mission: string }>;
  readonly projectMemory: string;
  readonly task: Readonly<{
    kind: TaskKind;
    requiredRole: AgentRole | null;
    title: string;
    objective: string;
    acceptanceCriteria: string;
    version: number;
    expectedAgentMinutes: number | null;
    phases: readonly ValidatedAgentTaskPhase[];
  }>;
  readonly areaMemory: readonly Readonly<{ taskId: string; title: string; result: string; endedAt: string }>[];
  readonly parentEvidence: Readonly<{
    taskId: string;
    title: string;
    objective: string;
    acceptanceCriteria: string;
    status: string;
    assignedAgentId: string | null;
    workspaceRefs: readonly string[];
    startedAt: string | null;
    endedAt: string | null;
    result: string | null;
    messages: readonly Readonly<{
      messageId: string;
      author: "human" | "agent";
      kind: "note" | "progress" | "proposal" | "result";
      body: string;
      createdAt: string;
    }>[];
  }> | null;
  readonly messagesSinceCursor: number | null;
  readonly nextMessageCursor: number;
  readonly messages: readonly Readonly<{
    messageId: string;
    cursor: number;
    author: "human" | "agent" | "system";
    body: string;
    createdAt: string;
  }>[];
  readonly triggerQuestion: Readonly<{ questionId: string; question: string; answer: string }> | null;
  readonly openQuestions: readonly Readonly<{
    questionId: string;
    question: string;
    answer: string | null;
    status: "open" | "answered";
  }>[];
  readonly workspaceRefs: readonly string[];
  readonly phase: WorkItemPhase | null;
  readonly crossRepoContext?: CrossRepoContext;
  readonly workflow: Readonly<{
    planRevisionId: string;
    nodeId: string;
    stage: WorkflowStage;
    skills: readonly SkillSnapshot[];
    dependencyHandoffs: readonly StageHandoff[];
    workspaceKey: string | null;
    pipeline: WorkflowPipelineContext | null;
    review: WorkflowReviewContext | null;
    fix: WorkflowFixContext | null;
  }> | null;
}

type ValidatedAgentRunOutput =
  | Readonly<{ type: "progress"; body: string }>
  | Readonly<{ type: "proposed_child_task"; title: string; objective: string; acceptanceCriteria: readonly string[] }>
  | Readonly<{ type: "result"; body: string }>
  | Readonly<{ type: "human_question"; question: string }>;

export interface ValidatedAgentRunOutcome {
  readonly status: "completed" | "failed" | "interrupted" | "waiting_for_human";
  readonly outputs: readonly ValidatedAgentRunOutput[];
  readonly expectedAgentMinutes: number | null;
  readonly phases: readonly ValidatedAgentTaskPhaseUpdate[];
  readonly detail: string;
  readonly gapReport?: string;
  readonly handoff: StageHandoffDraft | null;
  readonly workflowPlan: WorkflowPlanDraft | null;
  readonly reviewFindings?: readonly ReviewFindingDraft[];
  readonly designRecord?: DesignRecordDraft;
}

const MAX_PUBLISHED_INTERFACE_BYTES = 64 * 1_024;
// Design claims may carry their large approved-plan objective, while later
// pipeline claims add the bounded record to an otherwise full context.
export const MAX_OUTCOME_BYTES = 64 * 1_024;
const MAX_AREA_MEMORY_ITEMS = 8;

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export interface WorkerAgentContextUsage {
  readonly bytes: number;
  readonly budget: number;
}

export class WorkerAgentContextBudgetError extends ContractValidationError {
  constructor(
    readonly usage: WorkerAgentContextUsage,
    publishedInterface: boolean
  ) {
    super(
      "Agent context exceeds its byte bound",
      publishedInterface ? "PUBLISHED_INTERFACE_OVER_BUDGET" : "INVALID_REQUEST"
    );
    this.name = "WorkerAgentContextBudgetError";
  }
}

export function workerAgentContextUsage(value: unknown): WorkerAgentContextUsage {
  const rawContext = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
  const rawWorkflow = rawContext.workflow;
  const rawPipeline =
    rawWorkflow !== null && typeof rawWorkflow === "object" && !Array.isArray(rawWorkflow)
      ? (rawWorkflow as JsonRecord).pipeline
      : null;
  const carriesDesignRecord =
    rawPipeline !== null &&
    typeof rawPipeline === "object" &&
    !Array.isArray(rawPipeline) &&
    (rawPipeline as JsonRecord).designRecord !== null &&
    (rawPipeline as JsonRecord).designRecord !== undefined;
  return Object.freeze({
    bytes: byteLength(value),
    budget: rawContext.design === true || carriesDesignRecord ? MAX_DESIGN_CONTEXT_BYTES : MAX_AGENT_CONTEXT_BYTES,
  });
}

export function publishedInterfaceValidationReason(error: unknown): PublishedInterfaceFailureReason | null {
  if (!(error instanceof ContractValidationError)) return null;
  switch (error.code) {
    case "PUBLISHED_INTERFACE_TOO_LARGE":
      return "too_large";
    case "PUBLISHED_INTERFACE_INVALID_MARKDOWN":
      return "invalid_markdown";
    case "PUBLISHED_INTERFACE_EMPTY":
      return "empty";
    case "PUBLISHED_INTERFACE_OVER_BUDGET":
      return "over_budget";
    default:
      return null;
  }
}

export function boundedJsonValue(value: unknown, maximum: number, label: string): void {
  if (byteLength(value) > maximum) throw new ContractValidationError(`${label} exceeds its byte bound`);
}

export function parseCrossRepoContext(value: unknown, label: string): CrossRepoContext {
  const item = exact(value, ["providerProjectId", "providerRepoName", "interfacePath", "sha", "markdown"], label);
  if (item.interfacePath !== "docs/interface.md") {
    throw new ContractValidationError(`${label}.interfacePath is invalid`);
  }
  if (typeof item.sha !== "string" || !GIT_OBJECT_ID_PATTERN.test(item.sha)) {
    throw new ContractValidationError(`${label}.sha is invalid`);
  }
  if (typeof item.markdown !== "string") {
    throw new ContractValidationError(`${label}.markdown must be a string`);
  }
  if (new TextEncoder().encode(item.markdown).byteLength > MAX_PUBLISHED_INTERFACE_BYTES) {
    throw new ContractValidationError(`${label}.markdown exceeds 64 KiB`, "PUBLISHED_INTERFACE_TOO_LARGE");
  }
  if (item.markdown.trim().length === 0) {
    throw new ContractValidationError(`${label}.markdown is empty`, "PUBLISHED_INTERFACE_EMPTY");
  }
  if (!isValidCrossRepoMarkdown(item.markdown)) {
    throw new ContractValidationError(`${label}.markdown is invalid`, "PUBLISHED_INTERFACE_INVALID_MARKDOWN");
  }
  return Object.freeze({
    providerProjectId: identifier(item.providerProjectId, `${label}.providerProjectId`),
    providerRepoName: prose(item.providerRepoName, `${label}.providerRepoName`, { maximum: 256 }),
    interfacePath: "docs/interface.md",
    sha: item.sha,
    markdown: item.markdown,
  });
}

function workerTimestamp(value: unknown, label: string): string {
  return timestamp(value, label, `${label} must be a canonical timestamp`, true);
}

export function workerProse(value: unknown, label: string, maximum: number): string {
  return prose(value, label, { maximum, carriageReturns: "preserve" });
}

function workerNullableProse(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : workerProse(value, label, maximum);
}

function workerNonNegative(value: unknown, label: string): number {
  return integer(value, label, 0, `${label} is invalid`);
}

function workerPositive(value: unknown, label: string): number {
  return integer(value, label, 1, `${label} is invalid`);
}

function workerNullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : workerTimestamp(value, label);
}

function workerNullableCursor(value: unknown, label: string): number | null {
  return value === null ? null : workerNonNegative(value, label);
}

export function parseBoardProjectContexts(value: unknown, label: string): readonly BoardProjectContext[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new ContractValidationError(`${label} is invalid`);
  }
  const projects = value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const item = exact(entry, ["projectId", "name", "repoName"], itemLabel);
    return Object.freeze({
      projectId: identifier(item.projectId, `${itemLabel}.projectId`),
      name: workerProse(item.name, `${itemLabel}.name`, 160),
      repoName: workerProse(item.repoName, `${itemLabel}.repoName`, 256),
    });
  });
  if (new Set(projects.map((project) => project.projectId)).size !== projects.length) {
    throw new ContractValidationError(`${label} contains a duplicate project`);
  }
  return Object.freeze(projects);
}

function assertWorkerPhaseCompletion(stage: TaskPhaseStage, status: TaskPhaseStatus, label: string): void {
  if (stage === "done" && status !== "completed") {
    throw new ContractValidationError(`${label} may use the legacy done stage only when status is completed`);
  }
}

function parseWorkerHandoffEntity(value: unknown, index: number): StageHandoff {
  const handoff = exact(
    value,
    [
      "apiVersion",
      "handoffId",
      "nodeId",
      "taskId",
      "stage",
      "outcome",
      "summary",
      "evidence",
      "artifactIds",
      "acceptanceCriteria",
      "blockers",
      "recommendedReturnStage",
      "createdAt",
    ],
    `Workflow handoff ${index}`
  );
  if (handoff.apiVersion !== TASK_BOARD_API_VERSION) {
    throw new ContractValidationError(`Workflow handoff ${index} version is invalid`);
  }
  const stage = contractMember(handoff.stage, WORKFLOW_STAGES, `Workflow handoff ${index} stage`);
  const outcome = contractMember(handoff.outcome, STAGE_HANDOFF_OUTCOMES, `Workflow handoff ${index} outcome`);
  const stringList = (input: unknown, label: string, maximum: number): readonly string[] => {
    if (!Array.isArray(input) || input.length > maximum) throw new ContractValidationError(`${label} is invalid`);
    return Object.freeze(input.map((entry, itemIndex) => workerProse(entry, `${label}[${itemIndex}]`, 2_000)));
  };
  if (!Array.isArray(handoff.acceptanceCriteria) || handoff.acceptanceCriteria.length > 32) {
    throw new ContractValidationError(`Workflow handoff ${index} acceptance criteria are invalid`);
  }
  const acceptanceCriteria = handoff.acceptanceCriteria.map((entry, criterionIndex) => {
    const criterion = exact(entry, ["criterion", "passed", "evidence"], `Workflow criterion ${criterionIndex}`);
    if (typeof criterion.passed !== "boolean") {
      throw new ContractValidationError(`Workflow criterion ${criterionIndex} result is invalid`);
    }
    return Object.freeze({
      criterion: workerProse(criterion.criterion, `workflow.criterion[${criterionIndex}].criterion`, 1_000),
      passed: criterion.passed,
      evidence: workerProse(criterion.evidence, `workflow.criterion[${criterionIndex}].evidence`, 2_000),
    });
  });
  const recommendedReturnStage =
    handoff.recommendedReturnStage === null
      ? null
      : contractMember(handoff.recommendedReturnStage, WORKFLOW_STAGES, `Workflow handoff ${index} return stage`);
  return Object.freeze({
    apiVersion: TASK_BOARD_API_VERSION,
    handoffId: identifier(handoff.handoffId, `workflow.handoffs[${index}].handoffId`),
    nodeId: identifier(handoff.nodeId, `workflow.handoffs[${index}].nodeId`),
    taskId: identifier(handoff.taskId, `workflow.handoffs[${index}].taskId`),
    stage,
    outcome,
    summary: workerProse(handoff.summary, `workflow.handoffs[${index}].summary`, STAGE_HANDOFF_SUMMARY_MAX_CHARACTERS),
    evidence: stringList(handoff.evidence, `workflow.handoffs[${index}].evidence`, 32),
    artifactIds: stringList(handoff.artifactIds, `workflow.handoffs[${index}].artifactIds`, 32),
    acceptanceCriteria: Object.freeze(acceptanceCriteria),
    blockers: stringList(handoff.blockers, `workflow.handoffs[${index}].blockers`, STAGE_HANDOFF_BLOCKERS_MAX_ITEMS),
    recommendedReturnStage,
    createdAt: workerTimestamp(handoff.createdAt, `workflow.handoffs[${index}].createdAt`),
  });
}

function parseWorkerContextPhase(value: unknown, index: number): ValidatedAgentTaskPhase {
  const label = `task.phases[${index}]`;
  const item = exact(value, ["phaseId", "title", "stage", "status", "parallelGroup", "orderKey", "version"], label);
  const stage = contractMember(item.stage, TASK_PHASE_STAGES, `${label}.stage`);
  const status = contractMember(item.status, TASK_PHASE_STATUSES, `${label}.status`);
  assertWorkerPhaseCompletion(stage, status, label);
  return Object.freeze({
    phaseId: identifier(item.phaseId, `${label}.phaseId`),
    title: workerProse(item.title, `${label}.title`, 240),
    stage,
    status,
    parallelGroup: item.parallelGroup === null ? null : identifier(item.parallelGroup, `${label}.parallelGroup`),
    orderKey: workerNonNegative(item.orderKey, `${label}.orderKey`),
    version: workerPositive(item.version, `${label}.version`),
  });
}

export function parseWorkerPhaseUpdate(value: unknown, index: number): ValidatedAgentTaskPhaseUpdate {
  const label = `phases[${index}]`;
  const item = exact(value, ["phaseId", "title", "stage", "status", "parallelGroup", "orderKey"], label);
  const stage = contractMember(item.stage, TASK_PHASE_STAGES, `${label}.stage`);
  const status = contractMember(item.status, TASK_PHASE_STATUSES, `${label}.status`);
  assertWorkerPhaseCompletion(stage, status, label);
  return Object.freeze({
    phaseId: item.phaseId === null ? null : identifier(item.phaseId, `${label}.phaseId`),
    title: workerProse(item.title, `${label}.title`, 240),
    stage,
    status,
    parallelGroup: item.parallelGroup === null ? null : identifier(item.parallelGroup, `${label}.parallelGroup`),
    orderKey: workerNonNegative(item.orderKey, `${label}.orderKey`),
  });
}

/* —— Worker workflow context —— */

export function parseWorkflowPipelineFields(
  item: JsonRecord,
  label: string
): Readonly<{
  workspaceKey: string | null;
  pipeline: WorkflowPipelineContext | null;
  review: WorkflowReviewContext | null;
  fix: WorkflowFixContext | null;
}> {
  const workspaceKey =
    item.workspaceKey === undefined || item.workspaceKey === null
      ? null
      : identifier(item.workspaceKey, `${label}.workspaceKey`);
  let pipeline: WorkflowPipelineContext | null = null;
  if (item.pipeline !== undefined && item.pipeline !== null) {
    const rawPipeline = record(item.pipeline, `${label}.pipeline`);
    const value = exact(
      item.pipeline,
      [
        "branch",
        "baseSha",
        "changeShape",
        "tier",
        "declaredScope",
        "nonGoals",
        "assumptions",
        ...("designRecord" in rawPipeline ? ["designRecord"] : []),
      ],
      `${label}.pipeline`
    );
    if (workspaceKey === null) {
      throw new ContractValidationError(`${label}.pipeline requires workspaceKey`);
    }
    const branch = workerProse(value.branch, `${label}.pipeline.branch`, 133);
    const baseSha = workerProse(value.baseSha, `${label}.pipeline.baseSha`, 64);
    const branchMatch = /^task\/(.+)$/u.exec(branch);
    const branchWorkspaceKey = branchMatch?.[1];
    if (
      branchWorkspaceKey === undefined ||
      (workspaceKey !== branchWorkspaceKey &&
        workspaceKey !== `${branchWorkspaceKey}${VERIFY_WORKSPACE_SUFFIX}` &&
        workspaceKey !== `${branchWorkspaceKey}${REVIEW_WORKSPACE_SUFFIX}`) ||
      !GIT_OBJECT_ID_PATTERN.test(baseSha)
    ) {
      throw new ContractValidationError(`${label}.pipeline identity is invalid`);
    }
    pipeline = Object.freeze({
      branch,
      baseSha,
      changeShape: contractMember(value.changeShape, PLAN_CHANGE_SHAPES, `${label}.pipeline.changeShape`),
      tier: contractMember(value.tier, PLAN_TIERS, `${label}.pipeline.tier`),
      declaredScope: boundedPlanArray(
        value.declaredScope,
        `${label}.pipeline.declaredScope`,
        1,
        64,
        (entry, entryLabel) => planScopeEntry(entry, entryLabel, workerProse)
      ),
      nonGoals: boundedPlanArray(value.nonGoals, `${label}.pipeline.nonGoals`, 0, 32, (entry, entryLabel) =>
        workerProse(entry, entryLabel, 1_000)
      ),
      assumptions: boundedPlanArray(value.assumptions, `${label}.pipeline.assumptions`, 0, 64, (entry, entryLabel) =>
        workerProse(entry, entryLabel, 4_000)
      ),
      designRecord:
        value.designRecord === undefined || value.designRecord === null
          ? null
          : parseDesignRecordDraft(value.designRecord),
    });
  }
  if ((workspaceKey === null) !== (pipeline === null)) {
    throw new ContractValidationError(`${label}.workspaceKey and pipeline must both be null or both be present`);
  }
  const review =
    item.review === undefined || item.review === null
      ? null
      : parseWorkflowReviewContext(item.review, `${label}.review`);
  if (review !== null && (pipeline === null || !workspaceKey?.endsWith(REVIEW_WORKSPACE_SUFFIX))) {
    throw new ContractValidationError(`${label}.review identity is invalid`);
  }
  const fix =
    item.fix === undefined || item.fix === null
      ? null
      : (() => {
          const value = exact(item.fix, ["round", "findings"], `${label}.fix`);
          return Object.freeze({
            round: integer(value.round, `${label}.fix.round`, 1),
            findings: Object.freeze(
              boundedPlanArray(value.findings, `${label}.fix.findings`, 1, 64, (entry, entryLabel) =>
                parseReviewFindingEntity(entry, entryLabel)
              )
            ),
          });
        })();
  if (fix !== null && (pipeline === null || workspaceKey?.endsWith(REVIEW_WORKSPACE_SUFFIX) === true)) {
    throw new ContractValidationError(`${label}.fix identity is invalid`);
  }
  return Object.freeze({ workspaceKey, pipeline, review, fix });
}

function parseWorkflowReviewContext(value: unknown, label: string): WorkflowReviewContext {
  const fields = [
    "commits",
    "diffstat",
    "filesTouched",
    "scopeOk",
    "midRunAssumptions",
    "acceptanceCriteria",
    "criterionChecks",
    "mechanicalPortions",
    "priorFindings",
    "priorFindingsTruncated",
  ];
  const item = exact(value, fields, label, {
    // Claims persisted before these additive review fields joined the block remain replayable.
    required: fields.filter((field) => field !== "mechanicalPortions" && field !== "priorFindingsTruncated"),
  });
  const commits = boundedPlanArray(item.commits, `${label}.commits`, 0, 1_000, (entry, entryLabel) => {
    const commit = exact(entry, ["sha", "subject"], entryLabel);
    const sha = workerProse(commit.sha, `${entryLabel}.sha`, 64);
    if (!GIT_OBJECT_ID_PATTERN.test(sha)) throw new ContractValidationError(`${entryLabel}.sha is invalid`);
    return Object.freeze({ sha, subject: workerProse(commit.subject, `${entryLabel}.subject`, 1_000) });
  });
  const filesTouched = boundedPlanArray(item.filesTouched, `${label}.filesTouched`, 0, 10_000, (entry, entryLabel) => {
    const file = exact(entry, ["path", "status"], entryLabel);
    return Object.freeze({
      path: reviewFindingFile(file.path, `${entryLabel}.path`),
      status: contractMember(file.status, ["added", "modified", "deleted"] as const, `${entryLabel}.status`),
    });
  });
  const stringList = (input: unknown, field: string, maximum: number, itemMaximum: number): readonly string[] =>
    boundedPlanArray(input, field, 0, maximum, (entry, entryLabel) => workerProse(entry, entryLabel, itemMaximum));
  const criterionChecks = boundedPlanArray(
    item.criterionChecks,
    `${label}.criterionChecks`,
    0,
    32,
    (entry, entryLabel) => {
      const criterionCheck = exact(entry, ["criterion", "check"], entryLabel);
      return Object.freeze({
        criterion: workerProse(criterionCheck.criterion, `${entryLabel}.criterion`, 4_000),
        check: planCheck(criterionCheck.check, `${entryLabel}.check`, workerProse),
      });
    }
  );
  const priorFindings = boundedPlanArray(item.priorFindings, `${label}.priorFindings`, 0, 1_000, (entry, entryLabel) =>
    parseReviewFindingEntity(entry, entryLabel)
  );
  if (typeof item.scopeOk !== "boolean") throw new ContractValidationError(`${label}.scopeOk is invalid`);
  if (item.priorFindingsTruncated !== undefined && typeof item.priorFindingsTruncated !== "boolean") {
    throw new ContractValidationError(`${label}.priorFindingsTruncated is invalid`);
  }
  return Object.freeze({
    commits,
    diffstat: text(item.diffstat, `${label}.diffstat`, {
      maximum: 64_000,
      allowEmpty: true,
      trim: false,
      carriageReturns: "preserve",
    }),
    filesTouched,
    scopeOk: item.scopeOk,
    midRunAssumptions: stringList(item.midRunAssumptions, `${label}.midRunAssumptions`, 256, 4_000),
    acceptanceCriteria: stringList(item.acceptanceCriteria, `${label}.acceptanceCriteria`, 64, 4_000),
    criterionChecks,
    mechanicalPortions:
      item.mechanicalPortions === undefined
        ? Object.freeze([])
        : stringList(item.mechanicalPortions, `${label}.mechanicalPortions`, 32, 1_000),
    priorFindings,
    priorFindingsTruncated: item.priorFindingsTruncated ?? false,
  });
}

export function parseWorkerTaskWakeClaim(value: unknown): ValidatedTaskWakeClaim {
  const item = exact(
    value,
    [
      "apiVersion",
      "claimId",
      "runId",
      "wakeupId",
      "projectId",
      "agentId",
      "taskId",
      "reason",
      "requestedMessageCursor",
      "claimedAt",
    ],
    "Task wake claim"
  );
  if (item.apiVersion !== 1 || typeof item.reason !== "string" || item.reason.length > 64) {
    throw new ContractValidationError("Task wake claim version or reason is invalid");
  }
  return Object.freeze({
    apiVersion: 1,
    claimId: identifier(item.claimId, "claimId"),
    runId: identifier(item.runId, "runId"),
    wakeupId: identifier(item.wakeupId, "wakeupId"),
    projectId: identifier(item.projectId, "projectId"),
    agentId: identifier(item.agentId, "agentId"),
    taskId: item.taskId === null ? null : identifier(item.taskId, "taskId"),
    reason: item.reason,
    requestedMessageCursor: workerNullableCursor(item.requestedMessageCursor, "requestedMessageCursor"),
    claimedAt: workerTimestamp(item.claimedAt, "claimedAt"),
  });
}

export function parseWorkerAgentContext(value: unknown): ValidatedAgentContext {
  const rawContext = record(value, "Agent context");
  const usage = workerAgentContextUsage(value);
  if (usage.bytes > usage.budget) {
    throw new WorkerAgentContextBudgetError(usage, rawContext.crossRepoContext !== undefined);
  }
  const item = exact(
    value,
    [
      "apiVersion",
      "projectId",
      "agentId",
      "taskId",
      "intake",
      "boardProjects",
      "onboarding",
      "design",
      "mission",
      "projectMemory",
      "task",
      "areaMemory",
      "parentEvidence",
      "messagesSinceCursor",
      "nextMessageCursor",
      "messages",
      "triggerQuestion",
      "openQuestions",
      "workspaceRefs",
      "phase",
      "crossRepoContext",
      "workflow",
    ],
    "Agent context",
    {
      required: [
        "apiVersion",
        "projectId",
        "agentId",
        "taskId",
        "intake",
        "design",
        "mission",
        "projectMemory",
        "task",
        "areaMemory",
        "parentEvidence",
        "messagesSinceCursor",
        "nextMessageCursor",
        "messages",
        "triggerQuestion",
        "openQuestions",
        "workspaceRefs",
        "workflow",
      ],
    }
  );
  if (item.apiVersion !== 1) throw new ContractValidationError("Agent context version is invalid");
  const intake = booleanValue(item.intake, "context.intake");
  const boardProjects =
    item.boardProjects === undefined
      ? undefined
      : parseBoardProjectContexts(item.boardProjects, "context.boardProjects");
  if (boardProjects !== undefined && !intake) {
    throw new ContractValidationError("Board projects are only valid for intake agent context");
  }
  if (boardProjects !== undefined && !boardProjects.some((project) => project.projectId === item.projectId)) {
    throw new ContractValidationError("Intake agent context board projects omit the parent project");
  }
  if (item.onboarding !== undefined && item.onboarding !== true) {
    throw new ContractValidationError("context.onboarding must be true when present");
  }
  const mission = exact(item.mission, ["role", "area", "mission"], "Agent mission");
  const task = exact(
    item.task,
    ["kind", "requiredRole", "title", "objective", "acceptanceCriteria", "version", "expectedAgentMinutes", "phases"],
    "Agent task context"
  );
  const currentTaskId = identifier(item.taskId, "context.taskId");
  if (!Array.isArray(item.areaMemory) || item.areaMemory.length > MAX_AREA_MEMORY_ITEMS) {
    throw new ContractValidationError("Agent area memory is invalid");
  }
  const areaMemory = item.areaMemory.map((entry, index) => {
    const memory = exact(entry, ["taskId", "title", "result", "endedAt"], `Area memory ${index}`);
    const parsed = Object.freeze({
      taskId: identifier(memory.taskId, `areaMemory[${index}].taskId`),
      title: workerProse(memory.title, `areaMemory[${index}].title`, 512),
      result: workerProse(memory.result, `areaMemory[${index}].result`, MAX_AREA_MEMORY_RESULT_CHARACTERS),
      endedAt: workerTimestamp(memory.endedAt, `areaMemory[${index}].endedAt`),
    });
    if (parsed.taskId === currentTaskId)
      throw new ContractValidationError("Agent area memory includes the current task");
    return parsed;
  });
  if (new Set(areaMemory.map((entry) => entry.taskId)).size !== areaMemory.length) {
    throw new ContractValidationError("Agent area memory contains duplicate tasks");
  }
  if (
    areaMemory.some((entry, index) => {
      const previous = areaMemory[index - 1];
      return (
        previous !== undefined &&
        (entry.endedAt > previous.endedAt || (entry.endedAt === previous.endedAt && entry.taskId >= previous.taskId))
      );
    })
  )
    throw new ContractValidationError("Agent area memory ordering is invalid");

  if (!Array.isArray(item.messages) || item.messages.length > 50)
    throw new ContractValidationError("Agent context messages are invalid");
  const messages = item.messages.map((entry, index) => {
    const message = exact(entry, ["messageId", "cursor", "author", "body", "createdAt"], `Message ${index}`);
    if (message.author !== "human" && message.author !== "agent" && message.author !== "system") {
      throw new ContractValidationError(`Message ${index} author is invalid`);
    }
    return Object.freeze({
      messageId: identifier(message.messageId, `messages[${index}].messageId`),
      cursor: workerNonNegative(message.cursor, `messages[${index}].cursor`),
      author: message.author,
      body: workerProse(message.body, `messages[${index}].body`, 2_000),
      createdAt: workerTimestamp(message.createdAt, `messages[${index}].createdAt`),
    });
  });
  if (messages.some((message, index) => index > 0 && message.cursor <= messages[index - 1]!.cursor)) {
    throw new ContractValidationError("Agent context message cursors must increase strictly");
  }
  const since = workerNullableCursor(item.messagesSinceCursor, "messagesSinceCursor");
  const next = workerNonNegative(item.nextMessageCursor, "nextMessageCursor");
  if (
    (since !== null && next < since) ||
    messages.some((message) => message.cursor <= (since ?? -1) || message.cursor > next)
  ) {
    throw new ContractValidationError("Agent context message cursor binding is invalid");
  }

  if (!Array.isArray(item.openQuestions) || item.openQuestions.length > 16) {
    throw new ContractValidationError("Agent context questions are invalid");
  }
  const openQuestions = item.openQuestions.map((entry, index) => {
    const question = exact(entry, ["questionId", "question", "answer", "status"], `Question ${index}`);
    const status = contractMember(question.status, QUESTION_STATUSES, `Question ${index} status`);
    if (status === "open" && question.answer !== null)
      throw new ContractValidationError(`Question ${index} open answer is invalid`);
    if (status === "answered" && question.answer === null)
      throw new ContractValidationError(`Question ${index} answered value is missing`);
    return Object.freeze({
      questionId: identifier(question.questionId, `openQuestions[${index}].questionId`),
      question: workerProse(question.question, `openQuestions[${index}].question`, 2_000),
      answer: workerNullableProse(question.answer, `openQuestions[${index}].answer`, 4_000),
      status,
    });
  });
  const triggerQuestion =
    item.triggerQuestion === null
      ? null
      : (() => {
          const trigger = exact(item.triggerQuestion, ["questionId", "question", "answer"], "Trigger question");
          return Object.freeze({
            questionId: identifier(trigger.questionId, "triggerQuestion.questionId"),
            question: workerProse(trigger.question, "triggerQuestion.question", 2_000),
            answer: workerProse(trigger.answer, "triggerQuestion.answer", 4_000),
          });
        })();
  if (!Array.isArray(item.workspaceRefs) || item.workspaceRefs.length > 32) {
    throw new ContractValidationError("Agent context workspace references are invalid");
  }

  let workflow: ValidatedAgentContext["workflow"] = null;
  if (item.workflow !== null) {
    const workflowItem = exact(
      item.workflow,
      [
        "planRevisionId",
        "nodeId",
        "stage",
        "skills",
        "dependencyHandoffs",
        "workspaceKey",
        "pipeline",
        "review",
        "fix",
      ],
      "Workflow context",
      { required: ["planRevisionId", "nodeId", "stage", "skills", "dependencyHandoffs"] }
    );
    const workflowStage = contractMember(workflowItem.stage, WORKFLOW_STAGES, "Workflow stage");
    const pipelineFields = parseWorkflowPipelineFields(workflowItem, "Workflow context");
    if (pipelineFields.fix !== null && workflowStage !== "implementation") {
      throw new ContractValidationError("Workflow context.fix is only valid during implementation");
    }
    if (!Array.isArray(workflowItem.skills) || workflowItem.skills.length > 16)
      throw new ContractValidationError("Workflow skills are invalid");
    const skills = workflowItem.skills.map((entry, index) => {
      const skill = exact(entry, ["skillId", "name", "description", "digest", "content"], `Workflow skill ${index}`);
      if (typeof skill.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(skill.digest)) {
        throw new ContractValidationError(`Workflow skill ${index} digest is invalid`);
      }
      return Object.freeze({
        skillId: identifier(skill.skillId, `workflow.skills[${index}].skillId`),
        name: workerProse(skill.name, `workflow.skills[${index}].name`, 256),
        description: workerProse(skill.description, `workflow.skills[${index}].description`, 2_000),
        digest: skill.digest as SkillSnapshot["digest"],
        content: workerProse(skill.content, `workflow.skills[${index}].content`, 32_000),
      });
    });
    if (!Array.isArray(workflowItem.dependencyHandoffs) || workflowItem.dependencyHandoffs.length > 32) {
      throw new ContractValidationError("Workflow dependency handoffs are invalid");
    }
    const dependencyHandoffs = workflowItem.dependencyHandoffs.map(parseWorkerHandoffEntity);
    workflow = Object.freeze({
      planRevisionId: identifier(workflowItem.planRevisionId, "workflow.planRevisionId"),
      nodeId: identifier(workflowItem.nodeId, "workflow.nodeId"),
      stage: workflowStage,
      skills: Object.freeze(skills),
      dependencyHandoffs: Object.freeze(dependencyHandoffs),
      workspaceKey: pipelineFields.workspaceKey,
      pipeline: pipelineFields.pipeline,
      review: pipelineFields.review,
      fix: pipelineFields.fix,
    });
  }

  const crossRepoContext =
    item.crossRepoContext === undefined ? undefined : parseCrossRepoContext(item.crossRepoContext, "crossRepoContext");
  const phase =
    item.phase === undefined || item.phase === null
      ? null
      : contractMember(item.phase, WORK_ITEM_PHASES, "context.phase");

  if (!Array.isArray(task.phases) || task.phases.length > 64)
    throw new ContractValidationError("Agent task phases are invalid");
  const phases = task.phases.map(parseWorkerContextPhase);
  if (new Set(phases.map((phase) => phase.phaseId)).size !== phases.length) {
    throw new ContractValidationError("Agent task phases contain duplicate phase IDs");
  }
  if (
    phases.some((phase, index) => {
      const previous = phases[index - 1];
      return (
        previous !== undefined &&
        (phase.orderKey < previous.orderKey ||
          (phase.orderKey === previous.orderKey && phase.phaseId <= previous.phaseId))
      );
    })
  )
    throw new ContractValidationError("Agent task phase ordering is invalid");

  let parentEvidence: ValidatedAgentContext["parentEvidence"] = null;
  if (item.parentEvidence !== null) {
    const parent = exact(
      item.parentEvidence,
      [
        "taskId",
        "title",
        "objective",
        "acceptanceCriteria",
        "status",
        "assignedAgentId",
        "workspaceRefs",
        "startedAt",
        "endedAt",
        "result",
        "messages",
      ],
      "Parent evidence"
    );
    if (!Array.isArray(parent.workspaceRefs) || parent.workspaceRefs.length > 32) {
      throw new ContractValidationError("Parent evidence workspace references are invalid");
    }
    if (!Array.isArray(parent.messages) || parent.messages.length > 12)
      throw new ContractValidationError("Parent evidence messages are invalid");
    const parentMessages = parent.messages.map((entry, index) => {
      const message = exact(entry, ["messageId", "author", "kind", "body", "createdAt"], `Parent message ${index}`);
      if (message.author !== "human" && message.author !== "agent")
        throw new ContractValidationError(`Parent message ${index} author is invalid`);
      if (
        message.kind !== "note" &&
        message.kind !== "progress" &&
        message.kind !== "proposal" &&
        message.kind !== "result"
      ) {
        throw new ContractValidationError(`Parent message ${index} kind is invalid`);
      }
      return Object.freeze({
        messageId: identifier(message.messageId, `parent.messages[${index}].messageId`),
        author: message.author,
        kind: message.kind,
        body: workerProse(message.body, `parent.messages[${index}].body`, 2_000),
        createdAt: workerTimestamp(message.createdAt, `parent.messages[${index}].createdAt`),
      });
    });
    parentEvidence = Object.freeze({
      taskId: identifier(parent.taskId, "parent.taskId"),
      title: workerProse(parent.title, "parent.title", 512),
      objective: workerProse(parent.objective, "parent.objective", 8_000),
      acceptanceCriteria: workerProse(parent.acceptanceCriteria, "parent.acceptanceCriteria", 4_000),
      status: workerProse(parent.status, "parent.status", 64),
      assignedAgentId:
        parent.assignedAgentId === null ? null : identifier(parent.assignedAgentId, "parent.assignedAgentId"),
      workspaceRefs: Object.freeze(
        parent.workspaceRefs.map((entry, index) => workerProse(entry, `parent.workspaceRefs[${index}]`, 512))
      ),
      startedAt: workerNullableTimestamp(parent.startedAt, "parent.startedAt"),
      endedAt: workerNullableTimestamp(parent.endedAt, "parent.endedAt"),
      result: workerNullableProse(parent.result, "parent.result", 4_000),
      messages: Object.freeze(parentMessages),
    });
  }

  return Object.freeze({
    apiVersion: 1,
    projectId: identifier(item.projectId, "context.projectId"),
    agentId: identifier(item.agentId, "context.agentId"),
    taskId: currentTaskId,
    intake,
    ...(boardProjects === undefined ? {} : { boardProjects }),
    ...(item.onboarding === true ? { onboarding: true as const } : {}),
    design: booleanValue(item.design, "context.design"),
    mission: Object.freeze({
      role: workerProse(mission.role, "mission.role", 64),
      area: workerProse(mission.area, "mission.area", 256),
      mission: workerProse(mission.mission, "mission.mission", 2_000),
    }),
    projectMemory: workerProse(item.projectMemory, "projectMemory", 8_000),
    task: Object.freeze({
      kind: contractMember(task.kind, TASK_KINDS, "task.kind") as TaskKind,
      requiredRole:
        task.requiredRole === null
          ? null
          : (contractMember(task.requiredRole, AGENT_ROLES, "task.requiredRole") as AgentRole),
      title: workerProse(task.title, "task.title", 512),
      objective: workerProse(
        task.objective,
        "task.objective",
        item.design === true ? MAX_INTERNAL_TASK_OBJECTIVE_CHARACTERS : 8_000
      ),
      acceptanceCriteria: workerProse(task.acceptanceCriteria, "task.acceptanceCriteria", 4_000),
      version: workerPositive(task.version, "task.version"),
      expectedAgentMinutes: expectedMinutes(task.expectedAgentMinutes, "task.expectedAgentMinutes", {
        nullable: true,
        maximum: 10_080,
        message: (field) => `${field} must be a 15-minute interval between 15 and 10080`,
      }),
      phases: Object.freeze(phases),
    }),
    areaMemory: Object.freeze(areaMemory),
    parentEvidence,
    messagesSinceCursor: since,
    nextMessageCursor: next,
    messages: Object.freeze(messages),
    triggerQuestion,
    openQuestions: Object.freeze(openQuestions),
    workspaceRefs: Object.freeze(
      item.workspaceRefs.map((entry, index) => workerProse(entry, `workspaceRefs[${index}]`, 512))
    ),
    phase,
    ...(crossRepoContext === undefined ? {} : { crossRepoContext }),
    workflow,
  });
}

/* —— Worker outputs —— */

export function parseWorkerAgentRunOutput(value: unknown): ValidatedAgentRunOutput {
  const discriminator = record(value, "Agent output").type;
  if (discriminator === "progress" || discriminator === "result") {
    const item = exact(value, ["type", "body"], discriminator === "progress" ? "Progress output" : "Result output");
    return Object.freeze({
      type: discriminator,
      body: workerProse(item.body, `${discriminator}.body`, discriminator === "progress" ? 2_000 : 4_000),
    });
  }
  if (discriminator === "human_question") {
    const item = exact(value, ["type", "question"], "Human question output");
    return Object.freeze({ type: "human_question", question: workerProse(item.question, "question", 2_000) });
  }
  if (discriminator === "proposed_child_task") {
    const item = exact(value, ["type", "title", "objective", "acceptanceCriteria"], "Child-task proposal");
    if (
      !Array.isArray(item.acceptanceCriteria) ||
      item.acceptanceCriteria.length < 1 ||
      item.acceptanceCriteria.length > 16
    ) {
      throw new ContractValidationError("Child-task acceptance criteria are invalid");
    }
    return Object.freeze({
      type: "proposed_child_task",
      title: workerProse(item.title, "proposal.title", 512),
      objective: workerProse(item.objective, "proposal.objective", 4_000),
      acceptanceCriteria: Object.freeze(
        item.acceptanceCriteria.map((criterion, index) =>
          workerProse(criterion, `proposal.acceptanceCriteria[${index}]`, 1_000)
        )
      ),
    });
  }
  throw new ContractValidationError("Agent output type is invalid");
}
