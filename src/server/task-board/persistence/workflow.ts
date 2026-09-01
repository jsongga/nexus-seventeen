/** Persists workflow plans and advances their state machine for task-board collaborators. */

/* —— Imports —— */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { GIT_POLICY_FLAGS, type GitTextRunner } from "../../shared/git.js";
import { scopeViolationResult, type DeclaredScopeCheckResult } from "../../shared/scope-check.js";
import {
  GIT_OBJECT_ID_PATTERN,
  IDENTIFIER_PATTERN,
  REVIEW_WORKSPACE_SUFFIX,
  STAGE_HANDOFF_BLOCKERS_MAX_ITEMS,
  STAGE_HANDOFF_SUMMARY_MAX_CHARACTERS,
  TASK_BOARD_ERROR_CODES,
  WORKFLOW_STAGES,
  isTerminalWorkItemState,
  pipelineTemplateShape,
  reviewFindingBlocks,
  type ClaimRunResult,
  type ConfirmPlanRevisionRequest,
  type CriterionResult,
  type CreatePlanRevisionRequest,
  type DesignRecordDraft,
  type GateAction,
  type PlanRevision,
  type ProjectEvent,
  type RejectFinalApprovalRequest,
  type ReviewFinding,
  type ReviewFindingDraft,
  type RejectPlanRevisionRequest,
  type RejectPlanRevisionResponse,
  type StageHandoff,
  type StageHandoffDraft,
  type WorkNode,
  type WorkItemState,
  type WorkflowPlanDraft,
  type WorkflowPipelineContext,
  type WorkflowReviewContext,
  type WorkflowStage,
} from "#shared/task-board-contract";
import {
  ContractValidationError,
  parseDesignRecordDraft,
  parseWorkflowPlanDraft,
  validateWorkflowPlanChildren,
} from "#shared/task-board-contract/validate";
import { redactForPersistence } from "../../shared/redact.js";
import { sha256 } from "../canonical.js";
import { TaskBoardError } from "../errors.js";
import { GateActionWriter, type GateActionInput } from "./gate-actions.js";
import { SkillRegistry } from "../skills.js";
import {
  assertParentTerminationCascadeRegistered,
  recordInitialWorkItemTransitionInTransaction,
  transitionWorkItemInTransaction,
  workItemStateForStage,
  workItemStateForNodeStage,
  workItemTransitionStoreForDatabase,
} from "./work-item-transitions.js";
import {
  inspectPipelineBranchSync,
  pipelineMidRunAssumptions,
  type PipelineInspection,
} from "../pipeline-inspection.js";
import { reviewFindingFromRow, type Row } from "./rows.js";

/* —— Wakeup and review constraints —— */

export const RETIRED_WAKEUP_EVENT_PREFIX = "retired-wakeup:";

export interface ExpandInterfacePublicationFailure {
  readonly finding: string;
  readonly actual: string;
}

export function retiredWakeupEventId(wakeupId: string): string {
  return RETIRED_WAKEUP_EVENT_PREFIX + wakeupId;
}

export const PENDING_LIVE_WAKEUP_PREDICATE_SQL = `
  wakeup.claimed_at IS NULL
  AND (
    wakeup.task_id IS NULL OR EXISTS (
      SELECT 1 FROM tasks AS task
      WHERE task.task_id = wakeup.task_id
        AND task.project_id = wakeup.project_id
        AND task.assigned_agent_id = wakeup.agent_id
        AND task.ended_at IS NULL
        AND task.status IN ('queued', 'blocked')
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM task_events AS event
    WHERE event.event_id = ? || wakeup.wakeup_id
  )
`;

export type { GitRunner as WorkflowGitRunner } from "../../shared/git.js";
export type AttemptScopeCheckResult =
  | DeclaredScopeCheckResult
  | Readonly<{
      ok: false;
      error: string;
    }>;
export interface MachineVerifyEvidence {
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly acceptanceCriteria: readonly CriterionResult[];
  readonly blockers: readonly string[];
}
const STAGES = new Set<WorkflowStage>(WORKFLOW_STAGES);
const ID = new RegExp(IDENTIFIER_PATTERN, "u");
const REVIEW_DIFFSTAT_MAX_CHARACTERS = 64_000;
const REVIEW_COMMIT_MAX_ITEMS = 1_000;
const REVIEW_FILE_MAX_ITEMS = 10_000;
// Keep branch-inspection evidence bounded independently of the plan, design
// record, skills, and the rest of the aggregate claim envelope.
const REVIEW_COMMIT_JSON_BUDGET = 32_000;
const REVIEW_FILE_JSON_BUDGET = 48_000;
const REVIEW_PRIOR_FINDINGS_JSON_BUDGET = 48_000;
const REVIEW_DIFFSTAT_TRUNCATION_MARKER = "\n[truncated: additional diffstat output omitted]";
const REVIEW_COMMIT_TRUNCATION_MARKER = Object.freeze({
  sha: "0".repeat(40),
  subject: "[truncated: additional commits omitted]",
});
const REVIEW_FILE_TRUNCATION_MARKER = Object.freeze({
  path: "[truncated: additional files omitted]",
  status: "modified" as const,
});
const CHILD_PIPELINE_STAGE_TEMPLATE = Object.freeze(["implementation", "testing", "verification"] as const);

function truncateWithMarker(value: string, maximum: number, marker: string): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - marker.length))}${marker}`;
}

function boundedReviewList<T>(items: readonly T[], maximumItems: number, jsonBudget: number, marker: T): readonly T[] {
  const result: T[] = [];
  let consumed = 2;
  const markerCost = JSON.stringify(marker).length + 1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const hasMore = index < items.length - 1;
    const itemCost = JSON.stringify(item).length + 1;
    if (
      result.length >= maximumItems ||
      (hasMore && result.length >= maximumItems - 1) ||
      consumed + itemCost + (hasMore ? markerCost : 0) > jsonBudget
    )
      break;
    result.push(item);
    consumed += itemCost;
  }
  if (result.length < items.length) result.push(marker);
  return Object.freeze(result);
}

function boundPriorReviewFindings(items: readonly ReviewFinding[]): Readonly<{
  findings: readonly ReviewFinding[];
  truncated: boolean;
}> {
  const newestFirst: ReviewFinding[] = [];
  let consumed = 2;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    const itemCost = Buffer.byteLength(JSON.stringify(item), "utf8") + (newestFirst.length === 0 ? 0 : 1);
    if (consumed + itemCost > REVIEW_PRIOR_FINDINGS_JSON_BUDGET) break;
    newestFirst.push(item);
    consumed += itemCost;
  }
  newestFirst.reverse();
  return Object.freeze({
    findings: Object.freeze(newestFirst),
    truncated: newestFirst.length < items.length,
  });
}

function boundPipelineInspectionForReview(inspection: PipelineInspection): Readonly<{
  commits: WorkflowReviewContext["commits"];
  diffstat: string;
  filesTouched: WorkflowReviewContext["filesTouched"];
}> {
  const commits = inspection.commits.map((commit) =>
    Object.freeze({
      sha: commit.sha,
      subject: truncateWithMarker(commit.subject, 1_000, " [truncated]"),
    })
  );
  const filesTouched = inspection.filesTouched.map((file) =>
    Object.freeze({
      path: truncateWithMarker(file.path, 512, " [path truncated]"),
      status: file.status,
    })
  );
  return Object.freeze({
    commits: boundedReviewList(
      commits,
      REVIEW_COMMIT_MAX_ITEMS,
      REVIEW_COMMIT_JSON_BUDGET,
      REVIEW_COMMIT_TRUNCATION_MARKER
    ),
    diffstat: truncateWithMarker(
      inspection.diffstat,
      REVIEW_DIFFSTAT_MAX_CHARACTERS,
      REVIEW_DIFFSTAT_TRUNCATION_MARKER
    ),
    filesTouched: boundedReviewList(
      filesTouched,
      REVIEW_FILE_MAX_ITEMS,
      REVIEW_FILE_JSON_BUDGET,
      REVIEW_FILE_TRUNCATION_MARKER
    ),
  });
}

function text(value: unknown, field: string, max = 8_000): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > max) {
    throw new TaskBoardError(400, "WORKFLOW_INVALID", `${field} is invalid`);
  }
  return value;
}
function list(value: unknown, field: string, max = 64): string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new TaskBoardError(400, "WORKFLOW_INVALID", `${field} is invalid`);
  return value.map((item, index) => text(item, `${field}[${index}]`, 4_000));
}
function json<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}
function optionalJsonList<T>(value: unknown): readonly T[] | undefined {
  return value === null ? undefined : Object.freeze(json<T[]>(value));
}

function assertPipelinePlanRecordComplete(raw: CreatePlanRevisionRequest): void {
  const pipelineNode = raw.nodes.length === 1 ? raw.nodes[0] : undefined;
  if (pipelineNode === undefined || pipelineTemplateShape(pipelineNode.stageTemplate) === null) return;
  const missingField =
    raw.changeShape === undefined
      ? "changeShape"
      : raw.tier === undefined
        ? "tier"
        : raw.declaredScope === undefined || raw.declaredScope.length === 0
          ? "declaredScope"
          : null;
  if (missingField !== null) {
    throw new TaskBoardError(
      400,
      TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_PLAN_INCOMPLETE,
      `Pipeline plan is missing required field ${missingField}`
    );
  }
}

function testingStageUsesMachineVerify(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT stages_json FROM automation_configuration WHERE configuration_id = 'company-default'")
    .get();
  if (row === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:automation_configuration_missing");
  const stages = json<Array<{ readonly stage?: unknown; readonly executor?: { readonly kind?: unknown } }>>(
    row.stages_json
  );
  return stages.some((stage) => stage.stage === "testing" && stage.executor?.kind === "machine_verify");
}

function verificationStageUsesEnabledAgentType(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      "SELECT agent_types_json,stages_json FROM automation_configuration WHERE configuration_id = 'company-default'"
    )
    .get();
  if (row === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:automation_configuration_missing");
  const stages = json<
    Array<{
      readonly stage?: unknown;
      readonly executor?: { readonly kind?: unknown; readonly agentTypeId?: unknown };
    }>
  >(row.stages_json);
  const agentTypes = json<Array<{ readonly agentTypeId?: unknown; readonly enabled?: unknown }>>(row.agent_types_json);
  const executor = stages.find((stage) => stage.stage === "verification")?.executor;
  return (
    executor?.kind === "agent_type" &&
    typeof executor.agentTypeId === "string" &&
    agentTypes.some((agentType) => agentType.agentTypeId === executor.agentTypeId && agentType.enabled === true)
  );
}

function pipelineExecutorsAreCompatible(
  db: DatabaseSync,
  shape: NonNullable<ReturnType<typeof pipelineTemplateShape>>
): boolean {
  return testingStageUsesMachineVerify(db) && (shape !== "v2" || verificationStageUsesEnabledAgentType(db));
}

function storedPlanPipelineShape(db: DatabaseSync, planRevisionId: string): ReturnType<typeof pipelineTemplateShape> {
  const templates = (
    db
      .prepare("SELECT stage_template_json FROM work_nodes WHERE plan_revision_id=? ORDER BY node_id")
      .all(planRevisionId) as Row[]
  ).map((row) => json<WorkflowStage[]>(row.stage_template_json));
  return templates.length === 1 ? pipelineTemplateShape(templates[0]!) : null;
}

function pipelineExecutorDrift(): TaskBoardError {
  return new TaskBoardError(
    409,
    TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_EXECUTOR_DRIFT,
    "The pipeline testing executor changed before confirmation"
  );
}

function pipelineBaseSha(repositoryPath: string, projectName: string, git: GitTextRunner): string {
  try {
    const output = git([...GIT_POLICY_FLAGS, "-C", repositoryPath, "rev-parse", "HEAD"]).trim();
    if (!GIT_OBJECT_ID_PATTERN.test(output)) throw new Error("git returned an invalid object id");
    return output;
  } catch (error) {
    throw new TaskBoardError(
      409,
      TASK_BOARD_ERROR_CODES.PROJECT_REPO_PATH_INVALID,
      `Project ${projectName} does not have a valid Git repository path`,
      { cause: error }
    );
  }
}

/* —— Stored plan projections —— */

function planFromRow(row: Row): PlanRevision {
  const declaredScope = optionalJsonList<string>(row.declared_scope_json);
  const nonGoals = optionalJsonList<string>(row.non_goals_json);
  const mechanicalPortions = optionalJsonList<string>(row.mechanical_portions_json);
  const blockingQuestions = optionalJsonList<{ readonly question: string; readonly recommendedDefault: string }>(
    row.blocking_questions_json
  );
  const criterionChecks = optionalJsonList<{ readonly criterion: string; readonly check: string }>(
    row.criterion_checks_json
  );
  const children =
    row.children === null ? null : Object.freeze(json<NonNullable<PlanRevision["children"]>>(row.children));
  return Object.freeze({
    apiVersion: "steward.task-board/v1",
    planRevisionId: String(row.plan_revision_id),
    workItemId: String(row.work_item_id),
    revision: Number(row.revision),
    objective: String(row.objective),
    assumptions: Object.freeze(json<string[]>(row.assumptions_json)),
    acceptanceCriteria: Object.freeze(json<string[]>(row.acceptance_criteria_json)),
    children,
    ...(row.change_shape === null
      ? {}
      : { changeShape: String(row.change_shape) as NonNullable<PlanRevision["changeShape"]> }),
    ...(row.tier === null ? {} : { tier: String(row.tier) as NonNullable<PlanRevision["tier"]> }),
    ...(declaredScope === undefined ? {} : { declaredScope }),
    ...(nonGoals === undefined ? {} : { nonGoals }),
    ...(mechanicalPortions === undefined ? {} : { mechanicalPortions }),
    ...(blockingQuestions === undefined ? {} : { blockingQuestions }),
    ...(criterionChecks === undefined ? {} : { criterionChecks }),
    projectId: String(row.project_id),
    skillDigests: Object.freeze(json<Record<string, string>>(row.skill_digests_json)),
    state: row.state as PlanRevision["state"],
    createdBy: String(row.created_by),
    confirmedBy: row.confirmed_by === null ? null : String(row.confirmed_by),
    createdAt: String(row.created_at),
    confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at),
    ...(row.rejected_note === null ? {} : { rejectedNote: String(row.rejected_note) }),
  });
}

function storedWorkflowPlanDraft(db: DatabaseSync, row: Row): WorkflowPlanDraft {
  const nodes = (
    db
      .prepare(
        `
    SELECT *
    FROM work_nodes
    WHERE plan_revision_id=?
    ORDER BY created_at,node_id
  `
      )
      .all(String(row.plan_revision_id)) as Row[]
  ).map((node) => ({
    nodeId: String(node.node_id),
    title: String(node.title),
    objective: String(node.objective),
    acceptanceCriteria: json<unknown>(node.acceptance_criteria_json),
    dependencyNodeIds: (
      db
        .prepare(
          `
      SELECT dependency_node_id
      FROM work_node_dependencies
      WHERE node_id=?
      ORDER BY dependency_node_id
    `
        )
        .all(String(node.node_id)) as Row[]
    ).map((dependency) => String(dependency.dependency_node_id)),
    stageTemplate: json<unknown>(node.stage_template_json),
  }));
  return parseWorkflowPlanDraft({
    objective: row.objective,
    assumptions: json<unknown>(row.assumptions_json),
    acceptanceCriteria: json<unknown>(row.acceptance_criteria_json),
    ...(row.change_shape === null ? {} : { changeShape: row.change_shape }),
    ...(row.tier === null ? {} : { tier: row.tier }),
    ...(row.declared_scope_json === null ? {} : { declaredScope: json<unknown>(row.declared_scope_json) }),
    ...(row.non_goals_json === null ? {} : { nonGoals: json<unknown>(row.non_goals_json) }),
    ...(row.mechanical_portions_json === null
      ? {}
      : { mechanicalPortions: json<unknown>(row.mechanical_portions_json) }),
    ...(row.blocking_questions_json === null ? {} : { blockingQuestions: json<unknown>(row.blocking_questions_json) }),
    ...(row.criterion_checks_json === null ? {} : { criterionChecks: json<unknown>(row.criterion_checks_json) }),
    ...(row.children === null ? {} : { children: json<unknown>(row.children) }),
    nodes,
  });
}

export interface ProjectWorkflowSnapshot {
  readonly plans: readonly PlanRevision[];
  readonly nodes: readonly WorkNode[];
  readonly handoffs: readonly StageHandoff[];
  readonly events: readonly ProjectEvent[];
}

interface ConfirmWorkflowTransactionResult {
  readonly readyNodes: readonly WorkNode[];
  readonly outcome?: "parked_hazardous" | "designing";
}

interface ConfirmPipelineBaseShas {
  readonly parentBaseSha: string | null;
  readonly childBaseShas: ReadonlyMap<string, string>;
}

export interface RejectWorkflowTransactionResult extends RejectPlanRevisionResponse {
  readonly workItemId: string;
  readonly projectId: string;
}

type PipelineMergeSettlement =
  | Readonly<{ kind: "merged"; mergeSha: string }>
  | Readonly<{ kind: "conflict"; summary: string }>;

/* —— Workflow state machine —— */

export class TransparentWorkflow {
  readonly #insertGateActionInTransaction: (input: GateActionInput) => GateAction;

  constructor(
    readonly db: DatabaseSync,
    readonly skills: SkillRegistry,
    readonly now: () => Date,
    readonly transaction: <T>(operation: () => T) => T,
    readonly queueEvent: ((event: ProjectEvent) => void) | undefined,
    readonly git: GitTextRunner,
    insertGateActionInTransaction?: (input: GateActionInput) => GateAction
  ) {
    const transitionStore = workItemTransitionStoreForDatabase(db);
    assertParentTerminationCascadeRegistered(transitionStore);
    const writer = insertGateActionInTransaction === undefined ? new GateActionWriter(transitionStore, now) : null;
    this.#insertGateActionInTransaction =
      insertGateActionInTransaction ?? ((input) => writer!.insertGateActionInTransaction(input));
  }

  propose(raw: CreatePlanRevisionRequest, actor: string): ProjectWorkflowSnapshot {
    return this.proposeInternal(raw, "human", actor, false);
  }

  proposeInTransaction(raw: CreatePlanRevisionRequest, actor: string): ProjectWorkflowSnapshot {
    // Agent proposals join task settlement so the plan cannot outlive the result that produced it.
    return this.proposeInternal(raw, "agent", actor, true);
  }

  private activateDependencyFreeNodesAtTemplateStart(
    planRevisionId: string,
    updatedAt: string
  ): Readonly<{ firstStage: WorkflowStage | null; readyNodes: readonly WorkNode[] }> {
    this.db
      .prepare(
        `
      UPDATE work_nodes
      SET state='ready',current_stage=json_extract(stage_template_json,'$[0]'),version=version+1,updated_at=?
      WHERE plan_revision_id=?
        AND state='pending'
        AND NOT EXISTS(SELECT 1 FROM work_node_dependencies dependency WHERE dependency.node_id=work_nodes.node_id)
    `
      )
      .run(updatedAt, planRevisionId);
    const firstStage = this.db
      .prepare(
        `
      SELECT current_stage
      FROM work_nodes
      WHERE plan_revision_id=? AND state='ready'
      ORDER BY created_at,node_id
      LIMIT 1
    `
      )
      .get(planRevisionId)?.current_stage;
    return Object.freeze({
      firstStage: firstStage === undefined || firstStage === null ? null : (String(firstStage) as WorkflowStage),
      readyNodes: Object.freeze(this.nodes(planRevisionId).filter((node) => node.state === "ready")),
    });
  }

  private proposeInternal(
    raw: CreatePlanRevisionRequest,
    actorType: "human" | "agent",
    actor: string,
    inTransaction: boolean
  ): ProjectWorkflowSnapshot {
    const workItemId = text(raw.workItemId, "workItemId", 128);
    const projectId = text(raw.projectId, "projectId", 128);
    const objective = text(raw.objective, "objective");
    const assumptions = list(raw.assumptions, "assumptions");
    const acceptance = list(raw.acceptanceCriteria, "acceptanceCriteria");
    if (acceptance.length === 0 || !Array.isArray(raw.nodes) || raw.nodes.length < 1 || raw.nodes.length > 128) {
      throw new TaskBoardError(400, "WORKFLOW_INVALID", "A plan needs criteria and bounded nodes");
    }
    assertPipelinePlanRecordComplete(raw);
    if (!this.db.prepare("SELECT 1 FROM work_items WHERE work_item_id = ?").get(workItemId)) {
      throw new TaskBoardError(404, "WORK_ITEM_NOT_FOUND", "Work item was not found");
    }
    if (!this.db.prepare("SELECT 1 FROM projects WHERE project_id = ?").get(projectId))
      throw new TaskBoardError(404, "PROJECT_NOT_FOUND", "Project was not found");
    const snapshots = this.skills.loadSync(raw.skillIds);
    const skillDigests = Object.fromEntries(snapshots.map((skill) => [skill.skillId, skill.digest]));
    const ids = new Set<string>();
    const nodes = raw.nodes.map((node, index) => {
      const nodeId = text(node.nodeId, `nodes[${index}].nodeId`, 128);
      if (!ID.test(nodeId) || ids.has(nodeId))
        throw new TaskBoardError(400, "WORKFLOW_INVALID", "Node IDs must be unique identifiers");
      ids.add(nodeId);
      const stages = node.stageTemplate.map((stage: WorkflowStage) => {
        if (!STAGES.has(stage)) throw new TaskBoardError(400, "WORKFLOW_INVALID", "Node stage is invalid");
        return stage;
      });
      const terminalStage = stages.at(-1);
      if (stages.length === 0 || terminalStage !== "verification" || new Set(stages).size !== stages.length) {
        throw new TaskBoardError(
          400,
          "WORKFLOW_INVALID",
          "Every node needs unique ordered stages ending in verification"
        );
      }
      return {
        nodeId,
        title: text(node.title, "node.title", 256),
        objective: text(node.objective, "node.objective"),
        acceptanceCriteria: list(node.acceptanceCriteria, "node.acceptanceCriteria"),
        dependencyNodeIds: [...node.dependencyNodeIds],
        stages,
      };
    });
    for (const node of nodes)
      for (const dependency of node.dependencyNodeIds)
        if (!ids.has(dependency) || dependency === node.nodeId)
          throw new TaskBoardError(400, "WORKFLOW_INVALID", "Dependency is invalid");
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const visit = (id: string) => {
      if (visiting.has(id)) throw new TaskBoardError(400, "WORKFLOW_CYCLE", "Task dependencies contain a cycle");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of byId.get(id)!.dependencyNodeIds) visit(dep);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of ids) visit(id);
    const createdAt = this.now().toISOString();
    const apply = (): void => {
      const workItem = this.db
        .prepare("SELECT state,current_stage,ended_at FROM work_items WHERE work_item_id=?")
        .get(workItemId) as Row | undefined;
      if (workItem === undefined) throw new TaskBoardError(404, "WORK_ITEM_NOT_FOUND", "Work item was not found");
      if (workItem.ended_at !== null) {
        throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.WORK_ITEM_ENDED, "Work item has ended");
      }
      if (this.db.prepare("SELECT 1 FROM plan_revisions WHERE work_item_id=? AND state='confirmed'").get(workItemId)) {
        throw new TaskBoardError(
          409,
          "PLAN_REVISION_UNSUPPORTED",
          "Confirmed workflows cannot be revised in this version"
        );
      }
      const revision = Number(
        this.db
          .prepare("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM plan_revisions WHERE work_item_id=?")
          .get(workItemId)?.revision
      );
      const planId = `plan_${randomUUID()}`;
      const storedIds = new Map(nodes.map((node) => [node.nodeId, `node_${randomUUID()}`]));
      this.db
        .prepare("UPDATE plan_revisions SET state='superseded' WHERE work_item_id=? AND state='proposed'")
        .run(workItemId);
      this.db
        .prepare(
          `
        INSERT INTO plan_revisions(
          plan_revision_id, work_item_id, revision, objective, assumptions_json,
          acceptance_criteria_json, change_shape, tier, declared_scope_json, non_goals_json,
          mechanical_portions_json, blocking_questions_json, criterion_checks_json,
          project_id, skill_digests_json, state, created_by,
          confirmed_by, created_at, confirmed_at, children
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `
        )
        .run(
          planId,
          workItemId,
          revision,
          objective,
          JSON.stringify(assumptions),
          JSON.stringify(acceptance),
          raw.changeShape ?? null,
          raw.tier ?? null,
          raw.declaredScope === undefined ? null : JSON.stringify(raw.declaredScope),
          raw.nonGoals === undefined ? null : JSON.stringify(raw.nonGoals),
          raw.mechanicalPortions === undefined ? null : JSON.stringify(raw.mechanicalPortions),
          raw.blockingQuestions === undefined ? null : JSON.stringify(raw.blockingQuestions),
          raw.criterionChecks === undefined ? null : JSON.stringify(raw.criterionChecks),
          projectId,
          JSON.stringify(skillDigests),
          "proposed",
          actor,
          null,
          createdAt,
          null,
          raw.children === undefined ? null : JSON.stringify(raw.children)
        );
      for (const node of nodes) {
        const storedId = storedIds.get(node.nodeId)!;
        this.db
          .prepare("INSERT INTO work_nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(
            storedId,
            planId,
            projectId,
            node.title,
            node.objective,
            JSON.stringify(node.acceptanceCriteria),
            JSON.stringify(node.stages),
            null,
            "pending",
            1,
            createdAt,
            createdAt
          );
        for (const dependency of node.dependencyNodeIds) {
          this.db.prepare("INSERT INTO work_node_dependencies VALUES(?,?)").run(storedId, storedIds.get(dependency)!);
        }
      }
      const objectiveUpdate = this.db
        .prepare(
          `
        UPDATE
          work_items
        SET refined_objective = ?
        WHERE work_item_id = ? AND ended_at IS NULL
      `
        )
        .run(objective, workItemId);
      if (Number(objectiveUpdate.changes) !== 1) {
        throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.WORK_ITEM_ENDED, "Work item has ended");
      }
      transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
        workItemId,
        to: "plan_approval",
        actorType,
        actorId: actor,
        now: createdAt,
        ...(workItem.current_stage === "human_review" ? {} : { currentStage: "human_review" as const }),
        touch: true,
      });
      this.event(projectId, null, null, "plan_proposed", `Plan revision ${revision} proposed`, createdAt);
    };
    if (inTransaction) apply();
    else this.transaction(apply);
    return this.snapshot(projectId);
  }

  claimReviewInspection(taskId: string): PipelineInspection | null {
    const row = this.db
      .prepare(
        `
      SELECT
        a.stage,
        plan.declared_scope_json,
        item.pipeline_branch,
        item.base_sha,
        project.repo_path
      FROM stage_attempts a
      JOIN work_nodes n ON n.node_id=a.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=n.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      JOIN projects project ON project.project_id=plan.project_id
      WHERE a.task_id=?
    `
      )
      .get(taskId) as Row | undefined;
    if (row === undefined || row.stage !== "verification" || row.pipeline_branch === null) return null;
    if (row.base_sha === null || row.declared_scope_json === null) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:pipeline_plan_record");
    }
    try {
      return inspectPipelineBranchSync({
        repoPath: String(row.repo_path),
        baseSha: String(row.base_sha),
        branch: String(row.pipeline_branch),
        declaredScope: Object.freeze(json<string[]>(row.declared_scope_json)),
        git: this.git,
      });
    } catch (error) {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_REPO_UNAVAILABLE,
        "The pipeline repository is unavailable",
        { cause: error }
      );
    }
  }

  claimContext(taskId: string, reviewInspection: PipelineInspection | null): ClaimRunResult["context"]["workflow"] {
    const attempt = this.db
      .prepare(
        `
      SELECT node_id,stage,skill_digests_json
      FROM stage_attempts
      WHERE task_id=?
      ORDER BY attempt DESC
      LIMIT 1
    `
      )
      .get(taskId) as Row | undefined;
    if (attempt === undefined) return null;
    return this.claimContextForStage(
      String(attempt.node_id),
      String(attempt.stage) as WorkflowStage,
      json<Record<string, string>>(attempt.skill_digests_json),
      reviewInspection
    );
  }

  claimContextForStage(
    nodeId: string,
    stage: WorkflowStage,
    digests: Readonly<Record<string, string>>,
    reviewInspection: PipelineInspection | null = null
  ): NonNullable<ClaimRunResult["context"]["workflow"]> {
    const row = this.db
      .prepare(
        `
      SELECT
        ? AS stage,
        n.node_id,
        n.plan_revision_id,
        plan.work_item_id,
        plan.assumptions_json,
        plan.acceptance_criteria_json,
        plan.criterion_checks_json,
        plan.change_shape,
        plan.tier,
        plan.declared_scope_json,
        plan.non_goals_json,
        plan.mechanical_portions_json,
        item.pipeline_branch,
        item.base_sha,
        project.repo_path,
        (SELECT payload_json FROM design_records design
          WHERE design.work_item_id=plan.work_item_id AND design.plan_revision_id=plan.plan_revision_id
        ) AS design_record_json
      FROM work_nodes n
      JOIN plan_revisions plan ON plan.plan_revision_id=n.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      JOIN projects project ON project.project_id=plan.project_id
      WHERE n.node_id=? AND plan.state='confirmed'
    `
      )
      .get(stage, nodeId) as Row | undefined;
    if (row === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:workflow_node_missing");
    const skills = this.skills.loadSync(Object.keys(digests));
    for (const skill of skills)
      if (digests[skill.skillId] !== skill.digest)
        throw new TaskBoardError(409, "SKILL_DIGEST_CHANGED", `Skill ${skill.skillId} changed after confirmation`);
    const handoffs = (
      this.db
        .prepare(
          `SELECT h.payload_json FROM work_node_dependencies d JOIN stage_handoffs h ON h.node_id=d.dependency_node_id
      WHERE d.node_id=? ORDER BY h.created_at`
        )
        .all(String(row.node_id)) as Row[]
    ).map((item) => Object.freeze(json<StageHandoff>(item.payload_json)));
    const hasPipelineBranch = row.pipeline_branch !== null;
    if (hasPipelineBranch !== (row.base_sha !== null)) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:pipeline_identity");
    }
    let pipeline: WorkflowPipelineContext | null = null;
    let review: NonNullable<NonNullable<ClaimRunResult["context"]["workflow"]>["review"]> | null = null;
    let fix: NonNullable<NonNullable<ClaimRunResult["context"]["workflow"]>["fix"]> | null = null;
    if (hasPipelineBranch) {
      if (row.change_shape === null || row.tier === null || row.declared_scope_json === null) {
        throw new Error("TASK_BOARD_DATABASE_CORRUPT:pipeline_plan_record");
      }
      pipeline = Object.freeze({
        branch: String(row.pipeline_branch),
        baseSha: String(row.base_sha),
        changeShape: String(row.change_shape) as WorkflowPipelineContext["changeShape"],
        tier: String(row.tier) as WorkflowPipelineContext["tier"],
        declaredScope: Object.freeze(json<string[]>(row.declared_scope_json)),
        nonGoals: row.non_goals_json === null ? Object.freeze([]) : Object.freeze(json<string[]>(row.non_goals_json)),
        assumptions: Object.freeze(json<string[]>(row.assumptions_json)),
        designRecord:
          row.design_record_json === null
            ? null
            : parseDesignRecordDraft(json<DesignRecordDraft>(row.design_record_json)),
      });
      if (row.stage === "implementation") {
        const latestSameNodeHandoff = this.db
          .prepare(
            `
          SELECT payload_json
          FROM stage_handoffs
          WHERE node_id=? AND stage IN ('implementation','testing','verification')
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `
          )
          .get(String(row.node_id)) as Row | undefined;
        if (latestSameNodeHandoff !== undefined) {
          const handoff = Object.freeze(json<StageHandoff>(latestSameNodeHandoff.payload_json));
          if (handoff.outcome === "failed") handoffs.push(handoff);
        }
        const latestFindingsRound = this.db
          .prepare(
            `
          SELECT MAX(round) AS round
          FROM review_findings
          WHERE node_id=? AND blocking=1
        `
          )
          .get(String(row.node_id)) as Row | undefined;
        if (latestFindingsRound?.round !== null && latestFindingsRound?.round !== undefined) {
          const round = Number(latestFindingsRound.round);
          const findings = (
            this.db
              .prepare(
                `
            SELECT *
            FROM review_findings
            WHERE node_id=? AND round=?
            ORDER BY created_at,finding_id
          `
              )
              .all(String(row.node_id), round) as Row[]
          ).map(reviewFindingFromRow);
          fix = Object.freeze({ round, findings: Object.freeze(findings) });
        }
      }
      if (row.stage === "verification") {
        if (reviewInspection === null) throw new Error("TASK_BOARD_DATABASE_CORRUPT:review_inspection");
        const inspection = boundPipelineInspectionForReview(reviewInspection);
        const allPriorFindings = (
          this.db
            .prepare(
              `
          SELECT *
          FROM review_findings
          WHERE node_id=?
          ORDER BY round,created_at,finding_id
        `
            )
            .all(String(row.node_id)) as Row[]
        ).map(reviewFindingFromRow);
        const priorFindings = boundPriorReviewFindings(allPriorFindings);
        review = Object.freeze({
          commits: inspection.commits,
          diffstat: inspection.diffstat,
          filesTouched: inspection.filesTouched,
          scopeOk: reviewInspection.scopeOk,
          midRunAssumptions: pipelineMidRunAssumptions(this.db, String(row.work_item_id)),
          acceptanceCriteria: Object.freeze(json<string[]>(row.acceptance_criteria_json)),
          criterionChecks: Object.freeze(
            json<Array<{ criterion: string; check: string }>>(row.criterion_checks_json ?? "[]").map((criterionCheck) =>
              Object.freeze(criterionCheck)
            )
          ),
          mechanicalPortions:
            row.mechanical_portions_json === null
              ? Object.freeze([])
              : Object.freeze(json<string[]>(row.mechanical_portions_json)),
          priorFindings: priorFindings.findings,
          priorFindingsTruncated: priorFindings.truncated,
        });
      }
    }
    return Object.freeze({
      planRevisionId: String(row.plan_revision_id),
      nodeId: String(row.node_id),
      stage: row.stage as WorkflowStage,
      skills: Object.freeze(skills),
      dependencyHandoffs: Object.freeze(handoffs),
      workspaceKey:
        pipeline === null
          ? null
          : row.stage === "verification"
            ? `${String(row.work_item_id)}${REVIEW_WORKSPACE_SUFFIX}`
            : String(row.work_item_id),
      pipeline,
      review,
      fix,
    });
  }

  pipelineBaseShaForConfirm(planId: string, request: ConfirmPlanRevisionRequest): string | null {
    return this.pipelineBaseShasForConfirm(planId, request).parentBaseSha;
  }

  pipelineBaseShaForProject(projectId: string): string {
    const project = this.db.prepare("SELECT name,repo_path FROM projects WHERE project_id=?").get(projectId);
    if (project === undefined) {
      throw new TaskBoardError(404, "PROJECT_NOT_FOUND", "Project was not found");
    }
    return pipelineBaseSha(String(project.repo_path), String(project.name), this.git);
  }

  pipelineBaseShasForConfirm(planId: string, request: ConfirmPlanRevisionRequest): ConfirmPipelineBaseShas {
    if (request.expectedState !== "proposed")
      throw new TaskBoardError(400, "WORKFLOW_INVALID", "Expected state must be proposed");
    const row = this.db.prepare("SELECT * FROM plan_revisions WHERE plan_revision_id=?").get(planId) as Row | undefined;
    if (!row) throw new TaskBoardError(404, TASK_BOARD_ERROR_CODES.PLAN_NOT_FOUND, "Plan was not found");
    if (row.state !== "proposed")
      throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.PLAN_NOT_PROPOSED, "Plan is no longer proposed");
    let parsedPlan: WorkflowPlanDraft;
    try {
      parsedPlan = storedWorkflowPlanDraft(this.db, row);
      const owner = this.db
        .prepare("SELECT parent_work_item_id FROM work_items WHERE work_item_id=?")
        .get(String(row.work_item_id)) as Readonly<{ parent_work_item_id: string | null }> | undefined;
      if (owner === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:plan_owner_missing");
      validateWorkflowPlanChildren(parsedPlan, String(row.project_id), owner.parent_work_item_id);
    } catch (error) {
      if (error instanceof ContractValidationError) {
        throw new TaskBoardError(400, "WORKFLOW_INVALID", error.message, { cause: error });
      }
      throw error;
    }
    const pipelineShape = storedPlanPipelineShape(this.db, planId);
    const hasPipelineShape = pipelineShape !== null;
    const hasDeclaredChildren = (parsedPlan.children?.length ?? 0) > 0;
    const childPipelineShape = pipelineTemplateShape(CHILD_PIPELINE_STAGE_TEMPLATE);
    if (childPipelineShape === null) throw new Error("TASK_BOARD_DATABASE_CORRUPT:child_pipeline_template");
    if (
      hasDeclaredChildren
        ? !pipelineExecutorsAreCompatible(this.db, childPipelineShape)
        : pipelineShape !== null && !pipelineExecutorsAreCompatible(this.db, pipelineShape)
    )
      throw pipelineExecutorDrift();
    const childProjectIds = (parsedPlan.children ?? []).map((child) => child.projectId);
    const projectIds = new Set(childProjectIds);
    if (hasPipelineShape && !hasDeclaredChildren) projectIds.add(String(row.project_id));
    const baseShas = new Map<string, string>();
    for (const projectId of projectIds) {
      baseShas.set(projectId, this.pipelineBaseShaForProject(projectId));
    }
    return Object.freeze({
      parentBaseSha: hasPipelineShape && !hasDeclaredChildren ? (baseShas.get(String(row.project_id)) ?? null) : null,
      childBaseShas: baseShas,
    });
  }

  private materializeDeclaredChildrenInTransaction(
    row: Row,
    plan: WorkflowPlanDraft,
    actor: string,
    resolvedBaseShas: ReadonlyMap<string, string>,
    now: string
  ): readonly string[] {
    const children = plan.children ?? [];
    if (children.length === 0) return Object.freeze([]);
    const parentWorkItemId = String(row.work_item_id);
    const parent = this.db
      .prepare(
        `
      SELECT original_request,priority,created_by
      FROM work_items
      WHERE work_item_id=? AND ended_at IS NULL
    `
      )
      .get(parentWorkItemId) as Row | undefined;
    if (parent === undefined) {
      throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.WORK_ITEM_ENDED, "Work item has ended");
    }

    const childRecords = children.map((child) => {
      const resolvedBaseSha = resolvedBaseShas.get(child.projectId);
      if (resolvedBaseSha === undefined) {
        throw new TaskBoardError(
          409,
          TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_REPO_UNAVAILABLE,
          "The pipeline repository is unavailable"
        );
      }
      if (!GIT_OBJECT_ID_PATTERN.test(resolvedBaseSha)) {
        throw new TaskBoardError(
          409,
          TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_REPO_UNAVAILABLE,
          "The pipeline repository is unavailable"
        );
      }
      return Object.freeze({
        child,
        workItemId: randomUUID(),
        planRevisionId: `plan_${randomUUID()}`,
        nodeId: `node_${randomUUID()}`,
        baseSha: resolvedBaseSha,
      });
    });
    const byKey = new Map(childRecords.map((record) => [record.child.key, record] as const));

    for (const [ordinal, record] of childRecords.entries()) {
      const { child, workItemId, planRevisionId, nodeId, baseSha } = record;
      const idempotencyKey = `decomposition:${parentWorkItemId}:${child.key}`;
      this.db
        .prepare(
          `
        INSERT INTO work_items(
          work_item_id,original_request,refined_objective,priority,
          project_target_mode,target_project_id,resolved_project_id,
          parent_work_item_id,phase,child_ordinal,pipeline_branch,base_sha,
          state,current_stage,created_by,idempotency_key,request_hash,
          version,created_at,updated_at,ended_at,cancelled_reason,archived_at
        ) VALUES (
          ?,?,?,?,'explicit',?,?,?,?,?,?,?,
          'queued',NULL,?,?,?,1,?,?,NULL,NULL,NULL
        )
      `
        )
        .run(
          workItemId,
          String(parent.original_request),
          child.objective,
          String(parent.priority),
          child.projectId,
          child.projectId,
          parentWorkItemId,
          child.phase ?? null,
          ordinal,
          `task/${workItemId}`,
          baseSha,
          String(parent.created_by),
          idempotencyKey,
          sha256({
            action: "create_decomposed_work_item",
            parentPlanRevisionId: String(row.plan_revision_id),
            child,
          }),
          now,
          now
        );
      recordInitialWorkItemTransitionInTransaction(workItemTransitionStoreForDatabase(this.db), {
        workItemId,
        actorType: "human",
        actorId: actor,
        now,
      });
      this.db
        .prepare(
          `
        INSERT INTO plan_revisions(
          plan_revision_id,work_item_id,revision,objective,assumptions_json,
          acceptance_criteria_json,change_shape,tier,declared_scope_json,non_goals_json,
          mechanical_portions_json,blocking_questions_json,criterion_checks_json,rejected_note,
          project_id,skill_digests_json,state,created_by,confirmed_by,created_at,confirmed_at,children
        ) VALUES (
          ?,?,1,?,?,?,?,?,?,?,?,?,?,NULL,?,?,'confirmed',?,?,?,?,NULL
        )
      `
        )
        .run(
          planRevisionId,
          workItemId,
          child.objective,
          String(row.assumptions_json),
          JSON.stringify(child.acceptanceCriteria),
          "feature",
          row.tier ?? "standard",
          JSON.stringify(child.declaredScope),
          row.non_goals_json,
          row.mechanical_portions_json,
          row.blocking_questions_json,
          "[]",
          child.projectId,
          String(row.skill_digests_json),
          String(row.created_by),
          actor,
          now,
          now
        );
      this.db
        .prepare(
          `
        INSERT INTO work_nodes(
          node_id,plan_revision_id,project_id,title,objective,acceptance_criteria_json,
          stage_template_json,current_stage,state,version,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,NULL,'pending',1,?,?)
      `
        )
        .run(
          nodeId,
          planRevisionId,
          child.projectId,
          child.objective.slice(0, 256),
          child.objective,
          JSON.stringify(child.acceptanceCriteria),
          JSON.stringify(CHILD_PIPELINE_STAGE_TEMPLATE),
          now,
          now
        );
      this.#insertGateActionInTransaction({
        workItemId,
        gate: "plan_confirm",
        actorId: actor,
        planRevisionId,
        verifiedSha: null,
        mergeSha: null,
        refId: parentWorkItemId,
        note: null,
      });
    }
    for (const record of childRecords) {
      for (const dependencyKey of record.child.dependsOn ?? []) {
        const dependency = byKey.get(dependencyKey);
        if (dependency === undefined) {
          throw new Error("TASK_BOARD_DATABASE_CORRUPT:declared_child_dependency");
        }
        this.db
          .prepare(
            `
          INSERT INTO work_item_dependencies(work_item_id,depends_on_work_item_id)
          VALUES (?,?)
        `
          )
          .run(record.workItemId, dependency.workItemId);
      }
    }
    return Object.freeze(childRecords.map((record) => record.workItemId));
  }

  confirm(
    planId: string,
    request: ConfirmPlanRevisionRequest,
    actor: string,
    resolvedBaseSha: string | null,
    resolvedChildBaseShas: ReadonlyMap<string, string>,
    startDesignInTransaction?: (workItemId: string) => void
  ): ConfirmWorkflowTransactionResult {
    if (request.expectedState !== "proposed")
      throw new TaskBoardError(400, "WORKFLOW_INVALID", "Expected state must be proposed");
    const now = this.now().toISOString();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM plan_revisions WHERE plan_revision_id=?").get(planId) as
        | Row
        | undefined;
      if (!row) throw new TaskBoardError(404, TASK_BOARD_ERROR_CODES.PLAN_NOT_FOUND, "Plan was not found");
      if (row.state !== "proposed")
        throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.PLAN_NOT_PROPOSED, "Plan is no longer proposed");
      let parsedPlan: WorkflowPlanDraft;
      try {
        parsedPlan = storedWorkflowPlanDraft(this.db, row);
        const owner = this.db
          .prepare("SELECT parent_work_item_id FROM work_items WHERE work_item_id=?")
          .get(String(row.work_item_id)) as Readonly<{ parent_work_item_id: string | null }> | undefined;
        if (owner === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:plan_owner_missing");
        validateWorkflowPlanChildren(parsedPlan, String(row.project_id), owner.parent_work_item_id);
      } catch (error) {
        if (error instanceof ContractValidationError) {
          throw new TaskBoardError(400, "WORKFLOW_INVALID", error.message, { cause: error });
        }
        throw error;
      }
      const pipelineShape = storedPlanPipelineShape(this.db, planId);
      const hasPipelineShape = pipelineShape !== null;
      const hasDeclaredChildren = (parsedPlan.children?.length ?? 0) > 0;
      const childPipelineShape = pipelineTemplateShape(CHILD_PIPELINE_STAGE_TEMPLATE);
      if (childPipelineShape === null) throw new Error("TASK_BOARD_DATABASE_CORRUPT:child_pipeline_template");
      if (
        hasDeclaredChildren
          ? !pipelineExecutorsAreCompatible(this.db, childPipelineShape)
          : pipelineShape !== null && !pipelineExecutorsAreCompatible(this.db, pipelineShape)
      )
        throw pipelineExecutorDrift();
      let identity: Readonly<{ branch: string; baseSha: string }> | null = null;
      if (hasPipelineShape && !hasDeclaredChildren) {
        if (resolvedBaseSha === null || !GIT_OBJECT_ID_PATTERN.test(resolvedBaseSha)) {
          throw new TaskBoardError(
            409,
            TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_REPO_UNAVAILABLE,
            "The pipeline repository is unavailable"
          );
        }
        identity = Object.freeze({
          branch: `task/${String(row.work_item_id)}`,
          baseSha: resolvedBaseSha,
        });
      }
      this.db
        .prepare("UPDATE plan_revisions SET state='confirmed',confirmed_by=?,confirmed_at=? WHERE plan_revision_id=?")
        .run(actor, now, planId);
      const projectUpdate = this.db
        .prepare(
          `
        UPDATE
          work_items
        SET resolved_project_id = ?
        WHERE work_item_id = ? AND ended_at IS NULL
      `
        )
        .run(String(row.project_id), String(row.work_item_id));
      if (Number(projectUpdate.changes) !== 1) {
        throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.WORK_ITEM_ENDED, "Work item has ended");
      }
      if (hasDeclaredChildren) {
        const branchlessUpdate = this.db
          .prepare(
            `
          UPDATE work_items
          SET pipeline_branch=NULL,base_sha=NULL
          WHERE work_item_id=? AND ended_at IS NULL
        `
          )
          .run(String(row.work_item_id));
        if (Number(branchlessUpdate.changes) !== 1) {
          throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.WORK_ITEM_ENDED, "Work item has ended");
        }
      }
      if (identity !== null) {
        const identityUpdate = this.db
          .prepare(
            `
          UPDATE work_items
          SET pipeline_branch=?,base_sha=?
          WHERE work_item_id=? AND ended_at IS NULL
        `
          )
          .run(identity.branch, identity.baseSha, String(row.work_item_id));
        if (Number(identityUpdate.changes) !== 1) {
          throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.WORK_ITEM_ENDED, "Work item has ended");
        }
      }
      this.#insertGateActionInTransaction({
        workItemId: String(row.work_item_id),
        gate: "plan_confirm",
        actorId: actor,
        planRevisionId: planId,
        verifiedSha: null,
        mergeSha: null,
        refId: String(row.revision),
        note: null,
      });
      const materializedChildren = this.materializeDeclaredChildrenInTransaction(
        row,
        parsedPlan,
        actor,
        resolvedChildBaseShas,
        now
      );
      if (materializedChildren.length > 0) {
        transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
          workItemId: String(row.work_item_id),
          to: "coordinating",
          actorType: "human",
          actorId: actor,
          now,
          currentStage: null,
        });
        this.event(
          String(row.project_id),
          null,
          null,
          "plan_confirmed",
          `Plan revision ${row.revision} confirmed with ${materializedChildren.length} children`,
          now
        );
        return Object.freeze({ readyNodes: Object.freeze([]) });
      }
      if (row.tier === "hazardous" && !hasPipelineShape) {
        const result = "hazardous tier requires a pipeline plan";
        this.recordPlanningResult(String(row.work_item_id), result, now);
        transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
          workItemId: String(row.work_item_id),
          to: "parked",
          actorType: "human",
          actorId: actor,
          now,
          park: { category: "hazardous_without_pipeline", reason: result },
        });
        this.event(String(row.project_id), null, null, "plan_confirmed", result, now);
        return Object.freeze({ readyNodes: Object.freeze([]), outcome: "parked_hazardous" });
      }
      if (row.tier === "hazardous") {
        if (startDesignInTransaction === undefined) {
          throw new Error("TASK_BOARD_DATABASE_CORRUPT:design_task_creator_missing");
        }
        startDesignInTransaction(String(row.work_item_id));
        transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
          workItemId: String(row.work_item_id),
          to: "designing",
          actorType: "human",
          actorId: actor,
          now,
          currentStage: "planning",
        });
        this.event(
          String(row.project_id),
          null,
          null,
          "plan_confirmed",
          `Plan revision ${row.revision} confirmed for design`,
          now
        );
        return Object.freeze({ readyNodes: Object.freeze([]), outcome: "designing" });
      }
      const activation = this.activateDependencyFreeNodesAtTemplateStart(planId, now);
      if (activation.firstStage === null) {
        throw new Error("TASK_BOARD_DATABASE_CORRUPT:confirmed_plan_without_ready_stage");
      }
      const firstWorkflowStage = activation.firstStage;
      const firstWorkItemState = workItemStateForStage(firstWorkflowStage);
      transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
        workItemId: String(row.work_item_id),
        to: firstWorkItemState === "planning" ? "plan_approval" : firstWorkItemState,
        actorType: "human",
        actorId: actor,
        now,
        currentStage: firstWorkflowStage,
      });
      this.event(String(row.project_id), null, null, "plan_confirmed", `Plan revision ${row.revision} confirmed`, now);
      return Object.freeze({ readyNodes: activation.readyNodes });
    });
  }

  rejectInTransaction(
    planId: string,
    request: RejectPlanRevisionRequest,
    actor: string
  ): RejectWorkflowTransactionResult {
    if (request.expectedState !== "proposed") {
      throw new TaskBoardError(400, "WORKFLOW_INVALID", "Expected state must be proposed");
    }
    const now = this.now().toISOString();
    const row = this.db.prepare("SELECT * FROM plan_revisions WHERE plan_revision_id=?").get(planId) as Row | undefined;
    if (!row) throw new TaskBoardError(404, TASK_BOARD_ERROR_CODES.PLAN_NOT_FOUND, "Plan was not found");
    if (row.state !== "proposed") {
      throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.PLAN_NOT_PROPOSED, "Plan is no longer proposed");
    }
    const workItemId = String(row.work_item_id);
    const projectId = String(row.project_id);
    const persistedNote = redactForPersistence(request.note);
    const rejectedBefore =
      this.db
        .prepare("SELECT 1 FROM plan_revisions WHERE work_item_id=? AND state='rejected' LIMIT 1")
        .get(workItemId) !== undefined;
    const updated = this.db
      .prepare(
        "UPDATE plan_revisions SET state='rejected',rejected_note=? WHERE plan_revision_id=? AND state='proposed'"
      )
      .run(persistedNote, planId);
    if (Number(updated.changes) !== 1) {
      throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.PLAN_NOT_PROPOSED, "Plan is no longer proposed");
    }
    const outcome = rejectedBefore ? "parked" : "revising";
    if (outcome === "parked") {
      this.recordPlanningResult(workItemId, "plan rejected twice — request unclear", now);
    }
    transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
      workItemId,
      to: outcome === "parked" ? "parked" : "planning",
      actorType: "human",
      actorId: actor,
      now,
      ...(outcome === "parked"
        ? { park: { category: "plan_rejected_twice" as const, reason: "plan rejected twice — request unclear" } }
        : {}),
      ...(outcome === "revising" ? { currentStage: "planning" as const } : {}),
    });
    this.#insertGateActionInTransaction({
      workItemId,
      gate: "plan_reject",
      actorId: actor,
      planRevisionId: planId,
      verifiedSha: null,
      mergeSha: null,
      refId: null,
      note: persistedNote,
    });
    this.event(
      projectId,
      null,
      null,
      "plan_rejected",
      outcome === "parked" ? "Plan rejected twice; work item parked" : "Plan rejected for revision",
      now
    );
    return Object.freeze({ outcome, workItemId, projectId });
  }

  settlePipelineMergeInTransaction(
    workItemId: string,
    version: number,
    settlement: PipelineMergeSettlement,
    actor: string,
    verifiedSha: string | null = null,
    actorType: "human" | "system" = "human",
    refId: string | null = null
  ): readonly WorkNode[] {
    if (settlement.kind === "conflict") {
      return this.returnFinalApprovalToImplementationInTransaction(
        workItemId,
        { version, note: settlement.summary },
        actor,
        (nodeId, currentState) =>
          workItemStateForNodeStage(this.db, workItemId, nodeId, "implementation", currentState),
        null,
        actorType
      );
    }
    const row = this.db
      .prepare(
        `
      SELECT item.state,item.version,plan.plan_revision_id,plan.project_id,node.node_id
      FROM work_items item
      JOIN plan_revisions plan ON plan.work_item_id=item.work_item_id AND plan.state='confirmed'
      JOIN work_nodes node ON node.plan_revision_id=plan.plan_revision_id
      WHERE item.work_item_id=?
      ORDER BY plan.revision DESC,node.created_at,node.node_id
      LIMIT 1
    `
      )
      .get(workItemId) as Row | undefined;
    if (row === undefined) throw new TaskBoardError(404, "WORK_ITEM_NOT_FOUND", "Work item was not found");
    if (Number(row.version) !== version) {
      throw new TaskBoardError(409, "WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
    }
    if (row.state !== "final_approval") {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.WORK_ITEM_ILLEGAL_TRANSITION,
        "Work item is not awaiting final approval"
      );
    }
    if (verifiedSha === null) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:pipeline_verified_sha_missing");
    }
    const now = this.now().toISOString();
    transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
      workItemId,
      to: "merged",
      actorType,
      actorId: actor,
      now,
      endedAt: now,
      currentStage: null,
    });
    this.#insertGateActionInTransaction({
      workItemId,
      gate: "final_approve",
      actorId: actor,
      planRevisionId: String(row.plan_revision_id),
      verifiedSha,
      mergeSha: settlement.mergeSha,
      refId,
      note: null,
    });
    this.event(
      String(row.project_id),
      String(row.node_id),
      null,
      "pipeline_merged",
      `merged ${settlement.mergeSha}`,
      now
    );
    return Object.freeze([]);
  }

  settleParentCompletionInTransaction(
    workItemId: string,
    version: number,
    childWorkItemIds: readonly string[],
    actor: string,
    actorType: "human" | "system"
  ): void {
    const row = this.db
      .prepare(
        `
      SELECT item.state,item.version,plan.plan_revision_id,plan.project_id
      FROM work_items item
      JOIN plan_revisions plan
        ON plan.work_item_id=item.work_item_id AND plan.state='confirmed'
      WHERE item.work_item_id=?
      ORDER BY plan.revision DESC
      LIMIT 1
    `
      )
      .get(workItemId) as Row | undefined;
    if (row === undefined) throw new TaskBoardError(404, "WORK_ITEM_NOT_FOUND", "Work item was not found");
    if (Number(row.version) !== version) {
      throw new TaskBoardError(409, "WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
    }
    if (row.state !== "coordinating" && row.state !== "final_approval") {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.WORK_ITEM_ILLEGAL_TRANSITION,
        "Parent work item is not ready for completion"
      );
    }
    const storedChildren = this.db
      .prepare(
        `
      SELECT work_item_id,state
      FROM work_items
      WHERE parent_work_item_id=?
      ORDER BY child_ordinal,work_item_id
    `
      )
      .all(workItemId) as Row[];
    const abandonedChildren = storedChildren.filter(
      (child) => child.state === "abandoned" || child.state === "dead_letter"
    );
    const storedChildIds = storedChildren
      .filter((child) => child.state !== "abandoned" && child.state !== "dead_letter")
      .map((child) => String(child.work_item_id));
    if (
      storedChildIds.length !== childWorkItemIds.length ||
      storedChildIds.some((childWorkItemId) => !childWorkItemIds.includes(childWorkItemId))
    ) {
      throw new TaskBoardError(409, "PARENT_CHILD_SET_MISMATCH", "Parent completion must list every child");
    }
    const childMerges = childWorkItemIds.map((childWorkItemId) => {
      const child = this.db
        .prepare(
          `
        SELECT item.state,action.merge_sha
        FROM work_items item
        LEFT JOIN gate_actions action ON action.gate_action_id=(
          SELECT latest.gate_action_id
          FROM gate_actions latest
          WHERE latest.work_item_id=item.work_item_id
            AND latest.gate='final_approve'
            AND latest.merge_sha IS NOT NULL
          ORDER BY latest.created_at DESC,latest.rowid DESC
          LIMIT 1
        )
        WHERE item.work_item_id=? AND item.parent_work_item_id=?
      `
        )
        .get(childWorkItemId, workItemId) as Row | undefined;
      if (child === undefined || child.state !== "merged" || child.merge_sha === null) {
        throw new TaskBoardError(
          409,
          "PARENT_CHILDREN_NOT_MERGED",
          "Every child must be merged before parent completion"
        );
      }
      return Object.freeze({ childWorkItemId, mergeSha: String(child.merge_sha) });
    });
    const now = this.now().toISOString();
    transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
      workItemId,
      to: "merged",
      actorType,
      actorId: actor,
      now,
      endedAt: now,
      currentStage: null,
    });
    this.#insertGateActionInTransaction({
      workItemId,
      gate: "final_approve",
      actorId: actor,
      planRevisionId: String(row.plan_revision_id),
      verifiedSha: null,
      mergeSha: null,
      refId: String(row.plan_revision_id),
      note: `${childMerges.length} children merged, ${abandonedChildren.length} abandoned`,
    });
    this.event(
      String(row.project_id),
      null,
      null,
      "parent_completed",
      `Completed parent from ${childMerges.length} merged children and ${abandonedChildren.length} abandoned children`,
      now
    );
  }

  recordOrphanedPipelineMergeInTransaction(workItemId: string, mergeSha: string): void {
    const row = this.db
      .prepare(
        `
      SELECT plan.project_id,node.node_id
      FROM plan_revisions plan
      JOIN work_nodes node ON node.plan_revision_id=plan.plan_revision_id
      WHERE plan.work_item_id=? AND plan.state='confirmed'
      ORDER BY plan.revision DESC,node.created_at,node.node_id
      LIMIT 1
    `
      )
      .get(workItemId) as Row | undefined;
    if (row === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:pipeline_plan_missing");
    this.event(
      String(row.project_id),
      String(row.node_id),
      null,
      "pipeline_merge_orphaned",
      `Orphaned merge ${mergeSha} for work item ${workItemId}; board settlement failed.`
    );
  }

  rejectFinalApprovalInTransaction(
    workItemId: string,
    request: RejectFinalApprovalRequest,
    actor: string
  ): readonly WorkNode[] {
    return this.returnFinalApprovalToImplementationInTransaction(
      workItemId,
      request,
      actor,
      "fixing",
      "final_reject",
      "human"
    );
  }

  returnFinalApprovalToImplementationInTransaction(
    workItemId: string,
    request: RejectFinalApprovalRequest,
    actor: string,
    targetState: WorkItemState | ((nodeId: string, currentState: WorkItemState) => WorkItemState),
    gateAction: "final_reject" | null,
    actorType: "human" | "system",
    newBaseSha?: string,
    sourceState: "final_approval" | "parked" = "final_approval"
  ): readonly WorkNode[] {
    const persistedNote = redactForPersistence(request.note);
    const row = this.db
      .prepare(
        `
      SELECT
        item.state,item.version,plan.plan_revision_id,plan.project_id,node.node_id,node.title,node.objective,
        node.acceptance_criteria_json,node.stage_template_json,node.state AS node_state
      FROM work_items item
      JOIN plan_revisions plan ON plan.work_item_id=item.work_item_id AND plan.state='confirmed'
      JOIN work_nodes node ON node.plan_revision_id=plan.plan_revision_id
      WHERE item.work_item_id=?
      ORDER BY plan.revision DESC,node.created_at,node.node_id
      LIMIT 1
    `
      )
      .get(workItemId) as Row | undefined;
    if (row === undefined) throw new TaskBoardError(404, "WORK_ITEM_NOT_FOUND", "Work item was not found");
    if (Number(row.version) !== request.version) {
      throw new TaskBoardError(409, "WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
    }
    if (row.state !== sourceState) {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.WORK_ITEM_ILLEGAL_TRANSITION,
        sourceState === "final_approval"
          ? "Work item is not awaiting final approval"
          : "Work item is not parked for recovery"
      );
    }
    const template = json<WorkflowStage[]>(row.stage_template_json);
    if (!template.includes("implementation") || row.node_state !== "completed") {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:pipeline_implementation_stage_missing");
    }
    const now = this.now().toISOString();
    const nodeId = String(row.node_id);
    const projectId = String(row.project_id);
    const taskId = `task_final_${randomUUID()}`;
    const orderKey = Number(this.db.prepare("SELECT COALESCE(MAX(order_key),-1)+1 AS n FROM tasks").get()?.n);
    this.db
      .prepare(
        `
      INSERT INTO tasks(
        task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
        title, objective, acceptance_criteria, workspace_refs_json,
        status, assigned_agent_id, assigned_role, expected_agent_minutes, agent_estimate_minutes,
        estimate_recorded_at, order_key, started_at, ended_at, result, version, created_at, updated_at
      ) VALUES (?, ?, NULL, 'work', NULL, 0, ?, ?, ?, '[]', 'failed', NULL, NULL, 15, NULL,
        NULL, ?, ?, ?, ?, 1, ?, ?)
    `
      )
      .run(
        taskId,
        projectId,
        `Final approval changes: ${String(row.title)}`.slice(0, 240),
        String(row.objective),
        json<string[]>(row.acceptance_criteria_json).join("\n"),
        orderKey,
        now,
        now,
        persistedNote,
        now,
        now
      );
    this.db
      .prepare(
        `
      INSERT INTO task_events(event_id, project_id, task_id, actor_type, actor_id, event_type, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, 'task_created', ?, ?)
    `
      )
      .run(
        randomUUID(),
        projectId,
        taskId,
        actorType,
        actor,
        JSON.stringify({ kind: "work", requiresReview: false, status: "failed", workItemId }),
        now
      );
    const handoff: StageHandoff = Object.freeze({
      apiVersion: "steward.task-board/v1",
      handoffId: `handoff_final_${randomUUID()}`,
      nodeId,
      taskId,
      stage: "implementation",
      outcome: "failed",
      summary: persistedNote,
      evidence: Object.freeze([persistedNote]),
      artifactIds: Object.freeze([]),
      acceptanceCriteria: Object.freeze([]),
      blockers: Object.freeze([persistedNote]),
      recommendedReturnStage: "implementation",
      createdAt: now,
    });
    this.db
      .prepare("INSERT INTO stage_handoffs VALUES(?,?,?,?,?,?,?)")
      .run(handoff.handoffId, nodeId, taskId, handoff.stage, handoff.outcome, JSON.stringify(handoff), now);
    const nodeUpdate = this.db
      .prepare(
        `
      UPDATE work_nodes
      SET state='ready',current_stage='implementation',version=version+1,updated_at=?
      WHERE node_id=? AND state='completed'
    `
      )
      .run(now, nodeId);
    if (Number(nodeUpdate.changes) !== 1) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:final_approval_node_not_completed");
    }
    if (newBaseSha !== undefined) {
      if (!GIT_OBJECT_ID_PATTERN.test(newBaseSha)) {
        throw new Error("TASK_BOARD_DATABASE_CORRUPT:base_sha_invalid");
      }
      const baseUpdate = this.db
        .prepare(
          `
        UPDATE work_items
        SET base_sha=?
        WHERE work_item_id=? AND state=? AND version=?
      `
        )
        .run(newBaseSha, workItemId, sourceState, request.version);
      if (Number(baseUpdate.changes) !== 1) {
        throw new TaskBoardError(409, "WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
      }
    }
    transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
      workItemId,
      to: typeof targetState === "function" ? targetState(nodeId, String(row.state) as WorkItemState) : targetState,
      actorType,
      actorId: actor,
      now,
      currentStage: "implementation",
    });
    if (gateAction !== null) {
      this.#insertGateActionInTransaction({
        workItemId,
        gate: gateAction,
        actorId: actor,
        planRevisionId: String(row.plan_revision_id),
        verifiedSha: null,
        mergeSha: null,
        refId: null,
        note: persistedNote,
      });
    }
    this.event(projectId, nodeId, taskId, "final_approval_rejected", persistedNote, now);
    return Object.freeze(this.nodesForIds([nodeId]));
  }

  private recordPlanningResult(workItemId: string, result: string, updatedAt: string): void {
    const update = this.db
      .prepare(
        `
      UPDATE tasks
      SET result=?,version=version+1,updated_at=?
      WHERE task_id=(SELECT task_id FROM work_item_planning_tasks WHERE work_item_id=?)
    `
      )
      .run(result, updatedAt, workItemId);
    if (Number(update.changes) !== 1) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:work_item_planning_task_missing");
    }
  }

  settleDesignInTransaction(
    taskId: string,
    result: string,
    designRecord: DesignRecordDraft,
    actorId: string
  ): readonly WorkNode[] {
    const row = this.db
      .prepare(
        `
      SELECT link.work_item_id,plan.plan_revision_id,plan.project_id,plan.revision,item.state
      FROM work_item_design_tasks link
      JOIN work_items item ON item.work_item_id=link.work_item_id
      JOIN plan_revisions plan ON plan.work_item_id=link.work_item_id AND plan.state='confirmed'
      WHERE link.task_id=?
      ORDER BY plan.revision DESC
      LIMIT 1
    `
      )
      .get(taskId) as Row | undefined;
    if (row === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:work_item_design_task_missing");
    const workItemId = String(row.work_item_id);
    const planRevisionId = String(row.plan_revision_id);
    const projectId = String(row.project_id);
    const now = this.now().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO design_records(design_record_id,work_item_id,plan_revision_id,payload_json,created_at)
      VALUES (?,?,?,?,?)
    `
      )
      .run(`design_${randomUUID()}`, workItemId, planRevisionId, JSON.stringify(designRecord), now);
    const activation = this.activateDependencyFreeNodesAtTemplateStart(planRevisionId, now);
    if (activation.firstStage !== "implementation") {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:designed_plan_without_implementation_stage");
    }
    this.recordDesignResult(workItemId, result, now);
    transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
      workItemId,
      to: "implementing",
      actorType: "agent",
      actorId,
      now,
      currentStage: "implementation",
    });
    this.event(projectId, null, taskId, "design_recorded", `Design recorded for plan revision ${row.revision}`, now);
    return activation.readyNodes;
  }

  private recordDesignResult(workItemId: string, result: string, updatedAt: string): void {
    const update = this.db
      .prepare(
        `
      UPDATE tasks
      SET result=?,version=version+1,updated_at=?
      WHERE task_id=(SELECT task_id FROM work_item_design_tasks WHERE work_item_id=?)
    `
      )
      .run(result, updatedAt, workItemId);
    if (Number(update.changes) !== 1) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:work_item_design_task_missing");
    }
  }

  linkAttempt(
    nodeId: string,
    taskId: string,
    stage: WorkflowStage,
    skillDigests: Readonly<Record<string, string>>
  ): void {
    this.linkAttemptInternal(nodeId, taskId, stage, skillDigests, false);
  }

  linkAttemptInTransaction(
    nodeId: string,
    taskId: string,
    stage: WorkflowStage,
    skillDigests: Readonly<Record<string, string>>
  ): void {
    this.linkAttemptInternal(nodeId, taskId, stage, skillDigests, true);
  }

  private linkAttemptInternal(
    nodeId: string,
    taskId: string,
    stage: WorkflowStage,
    skillDigests: Readonly<Record<string, string>>,
    inTransaction: boolean
  ): void {
    const apply = (): void => {
      const attempt = Number(
        this.db
          .prepare("SELECT COALESCE(MAX(attempt),0)+1 AS n FROM stage_attempts WHERE node_id=? AND stage=?")
          .get(nodeId, stage)?.n
      );
      this.db
        .prepare("INSERT INTO stage_attempts VALUES(?,?,?,?,?,?)")
        .run(`attempt_${randomUUID()}`, nodeId, taskId, stage, attempt, JSON.stringify(skillDigests));
      this.db
        .prepare("UPDATE work_nodes SET state='active',version=version+1,updated_at=? WHERE node_id=?")
        .run(this.now().toISOString(), nodeId);
    };
    if (inTransaction) apply();
    else this.transaction(apply);
  }

  blockNodeInTransaction(nodeId: string, summary: string): boolean {
    const row = this.db
      .prepare(
        "SELECT project_id,title,state FROM work_nodes WHERE node_id=? AND state IN ('pending','ready','blocked')"
      )
      .get(nodeId) as Row | undefined;
    if (row === undefined) return false;
    const now = this.now().toISOString();
    if (row.state === "blocked") {
      const latest = this.db
        .prepare(
          `
        SELECT summary
        FROM project_events
        WHERE node_id=? AND event_type='node_blocked'
        ORDER BY sequence DESC
        LIMIT 1
      `
        )
        .get(nodeId);
      if (latest?.summary === summary) return false;
      this.event(String(row.project_id), nodeId, null, "node_blocked", summary, now);
      return true;
    }
    const update = this.db
      .prepare(
        "UPDATE work_nodes SET state='blocked',version=version+1,updated_at=? WHERE node_id=? AND state IN ('pending','ready')"
      )
      .run(now, nodeId);
    if (Number(update.changes) !== 1) return false;
    this.event(String(row.project_id), nodeId, null, "node_blocked", summary, now);
    return true;
  }

  readyNodeAtTemplateStartInTransaction(nodeId: string): WorkNode {
    const row = this.db
      .prepare("SELECT project_id,state FROM work_nodes WHERE node_id=? AND state IN ('pending','blocked')")
      .get(nodeId) as Row | undefined;
    if (row === undefined) {
      const current = this.nodesForIds([nodeId])[0];
      if (current === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:workflow_node_missing");
      return current;
    }
    const now = this.now().toISOString();
    const update = this.db
      .prepare(
        `
      UPDATE work_nodes
      SET state='ready',current_stage=json_extract(stage_template_json,'$[0]'),version=version+1,updated_at=?
      WHERE node_id=? AND state IN ('pending','blocked')
    `
      )
      .run(now, nodeId);
    if (Number(update.changes) !== 1) throw new Error("TASK_BOARD_WORKFLOW_NODE_ACTIVATION_CONFLICT");
    if (row.state === "blocked") {
      this.event(String(row.project_id), nodeId, null, "dependency_unblocked", "Work-item dependencies satisfied", now);
    }
    const current = this.nodesForIds([nodeId])[0];
    if (current === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:workflow_node_missing");
    return current;
  }

  deferNodeForDesignInTransaction(nodeId: string): void {
    const update = this.db
      .prepare(
        `
      UPDATE work_nodes
      SET state='pending',current_stage=NULL,version=version+1,updated_at=?
      WHERE node_id=? AND state='blocked'
    `
      )
      .run(this.now().toISOString(), nodeId);
    if (Number(update.changes) > 1) throw new Error("TASK_BOARD_WORKFLOW_NODE_ACTIVATION_CONFLICT");
  }

  suspendAttemptNodeInTransaction(taskId: string, reason: string): boolean {
    const attempt = this.db
      .prepare(
        `
      SELECT attempt.attempt_id,attempt.node_id,node.project_id,node.state
      FROM stage_attempts attempt
      JOIN work_nodes node ON node.node_id=attempt.node_id
      WHERE attempt.task_id=?
    `
      )
      .get(taskId) as Row | undefined;
    if (attempt === undefined) return true;
    // A durable task/run link can outlive or be attached outside this process's
    // activation path. Cancellation still owns the run, but it must not force an
    // already-blocked or otherwise non-active node through an active-only CAS.
    if (attempt.state !== "active") {
      try {
        console.error(
          "[task-board] active attempt linked to non-active workflow node",
          Object.freeze({
            attemptId: String(attempt.attempt_id),
            taskId,
            nodeId: String(attempt.node_id),
            nodeState: String(attempt.state),
          })
        );
      } catch {
        // The durable suspension remains authoritative if diagnostic output fails.
      }
      this.event(
        String(attempt.project_id),
        String(attempt.node_id),
        taskId,
        "node_blocked",
        reason,
        this.now().toISOString()
      );
      return false;
    }
    const now = this.now().toISOString();
    const update = this.db
      .prepare(
        `
      UPDATE work_nodes
      SET state='blocked',version=version+1,updated_at=?
      WHERE node_id=? AND state='active'
    `
      )
      .run(now, String(attempt.node_id));
    if (Number(update.changes) !== 1) {
      throw new Error("TASK_BOARD_WORKFLOW_SUSPEND_CONFLICT");
    }
    this.event(String(attempt.project_id), String(attempt.node_id), taskId, "node_blocked", reason, now);
    return true;
  }

  settleAttemptInTransaction(
    taskId: string,
    outcome: "completed" | "failed" | "interrupted",
    result: string,
    draft?: StageHandoffDraft | null,
    reviewFindings?: readonly ReviewFindingDraft[],
    scopeCheck: AttemptScopeCheckResult | null = null
  ): readonly WorkNode[] {
    return this.settleAttemptInternal(taskId, outcome, result, draft, reviewFindings, scopeCheck);
  }

  recordExpandInterfacePublicationFailureInTransaction(
    taskId: string,
    failure: ExpandInterfacePublicationFailure
  ): readonly WorkNode[] {
    const attempt = this.db
      .prepare(
        `
      SELECT attempt.node_id,attempt.attempt,node.project_id,node.title,node.objective,
        node.acceptance_criteria_json,node.state AS node_state,node.current_stage,
        plan.work_item_id,item.state AS work_item_state,item.pipeline_branch
      FROM stage_attempts attempt
      JOIN work_nodes node ON node.node_id=attempt.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      WHERE attempt.task_id=? AND attempt.stage='verification' AND item.phase='expand'
    `
      )
      .get(taskId) as Row | undefined;
    if (attempt === undefined) return Object.freeze([]);

    const nodeId = String(attempt.node_id);
    const projectId = String(attempt.project_id);
    const systemTaskId = `task_interface_publication_${taskId}`;
    if (this.db.prepare("SELECT 1 FROM tasks WHERE task_id=?").get(systemTaskId) !== undefined) {
      return Object.freeze(this.nodesForIds([nodeId]));
    }
    if (attempt.node_state !== "completed" || attempt.current_stage !== null) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:interface_publication_node_not_completed");
    }

    const sourceRow = this.db.prepare("SELECT payload_json FROM stage_handoffs WHERE task_id=?").get(taskId) as
      | Row
      | undefined;
    if (sourceRow === undefined) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:interface_publication_source_handoff");
    }
    const source = json<StageHandoff>(sourceRow.payload_json);
    const finding = redactForPersistence(failure.finding);
    const suffix = ` — ${finding}`;
    const retainedSummaryLength = Math.max(0, STAGE_HANDOFF_SUMMARY_MAX_CHARACTERS - suffix.length);
    const summary = `${source.summary.slice(0, retainedSummaryLength).trimEnd()}${suffix}`;
    const originalBlockers = source.blockers.filter((blocker) => blocker !== finding);
    const blockers = Object.freeze([...originalBlockers.slice(-(STAGE_HANDOFF_BLOCKERS_MAX_ITEMS - 1)), finding]);
    const now = this.now().toISOString();
    const orderKey = Number(this.db.prepare("SELECT COALESCE(MAX(order_key),-1)+1 AS n FROM tasks").get()?.n);
    this.db
      .prepare(
        `
      INSERT INTO tasks(
        task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
        title, objective, acceptance_criteria, workspace_refs_json,
        status, assigned_agent_id, assigned_role, expected_agent_minutes, agent_estimate_minutes,
        estimate_recorded_at, order_key, started_at, ended_at, result, version, created_at, updated_at
      ) VALUES (?, ?, NULL, 'work', NULL, 0, ?, ?, ?, '[]', 'failed', NULL, NULL, 15, NULL,
        NULL, ?, ?, ?, ?, 1, ?, ?)
    `
      )
      .run(
        systemTaskId,
        projectId,
        `Interface publication: ${String(attempt.title)}`.slice(0, 240),
        String(attempt.objective),
        json<string[]>(attempt.acceptance_criteria_json).join("\n"),
        orderKey,
        now,
        now,
        finding,
        now,
        now
      );
    this.db
      .prepare(
        `
      INSERT INTO task_events(event_id, project_id, task_id, actor_type, actor_id, event_type, data_json, created_at)
      VALUES (?, ?, ?, 'system', 'system:interface-publication', 'task_created', ?, ?)
    `
      )
      .run(
        randomUUID(),
        projectId,
        systemTaskId,
        JSON.stringify({ kind: "work", requiresReview: false, status: "failed", sourceTaskId: taskId }),
        now
      );
    const handoff: StageHandoff = Object.freeze({
      apiVersion: "steward.task-board/v1",
      handoffId: `handoff_interface_publication_${taskId}`,
      nodeId,
      taskId: systemTaskId,
      stage: "verification",
      outcome: "failed",
      summary,
      evidence: Object.freeze([...source.evidence]),
      artifactIds: Object.freeze([...source.artifactIds]),
      acceptanceCriteria: Object.freeze([...source.acceptanceCriteria]),
      blockers,
      recommendedReturnStage: "implementation",
      createdAt: now,
    });
    this.db
      .prepare("INSERT INTO stage_handoffs VALUES(?,?,?,?,?,?,?)")
      .run(handoff.handoffId, nodeId, systemTaskId, handoff.stage, handoff.outcome, JSON.stringify(handoff), now);
    this.db
      .prepare(
        `
      INSERT INTO review_findings(
        finding_id,node_id,stage,round,file,line,category,severity,expected,actual,blocking,created_at
      ) VALUES (?,?, 'verification', ?, 'docs/interface.md', NULL, 'correctness', 'major', ?, ?, 1, ?)
    `
      )
      .run(
        `finding_interface_publication_${taskId}`,
        nodeId,
        Number(attempt.attempt),
        finding,
        redactForPersistence(failure.actual),
        now
      );
    const attemptNumber = Number(attempt.attempt);
    const maxAttempts = attempt.pipeline_branch === null ? 3 : 4;
    const workItemState = String(attempt.work_item_state) as WorkItemState;
    if (attemptNumber >= maxAttempts) {
      const nodeUpdate = this.db
        .prepare(
          `
        UPDATE work_nodes
        SET state='blocked',version=version+1,updated_at=?
        WHERE node_id=? AND state='completed' AND current_stage IS NULL
      `
        )
        .run(now, nodeId);
      if (Number(nodeUpdate.changes) !== 1) {
        throw new Error("TASK_BOARD_DATABASE_CORRUPT:interface_publication_node_not_completed");
      }
      if (!isTerminalWorkItemState(workItemState)) {
        transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
          workItemId: String(attempt.work_item_id),
          to: "dead_letter",
          actorType: "system",
          actorId: "system:workflow",
          now,
          endedAt: now,
          currentStage: null,
        });
      }
      this.event(
        projectId,
        nodeId,
        systemTaskId,
        "stage_failed",
        `verification publication check failed at attempt ${attemptNumber} of ${maxAttempts}`,
        now
      );
      return Object.freeze([]);
    }
    if (isTerminalWorkItemState(workItemState)) return Object.freeze([]);
    const nodeUpdate = this.db
      .prepare(
        `
      UPDATE work_nodes
      SET state='ready',current_stage='implementation',version=version+1,updated_at=?
      WHERE node_id=? AND state='completed' AND current_stage IS NULL
    `
      )
      .run(now, nodeId);
    if (Number(nodeUpdate.changes) !== 1) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:interface_publication_node_not_completed");
    }
    transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
      workItemId: String(attempt.work_item_id),
      to: "fixing",
      actorType: "system",
      actorId: "system:interface-publication",
      now,
      currentStage: "implementation",
    });
    this.event(
      projectId,
      nodeId,
      systemTaskId,
      "stage_retry_ready",
      `verification publication check failed; returning to implementation (attempt ${attemptNumber + 1} of ${maxAttempts})`,
      now
    );
    return Object.freeze(this.nodesForIds([nodeId]));
  }

  settleMachineVerifyAttemptInTransaction(
    nodeId: string,
    stage: WorkflowStage,
    passed: boolean,
    evidence: MachineVerifyEvidence
  ): readonly WorkNode[] {
    const attempt = this.db
      .prepare(
        `
      SELECT
        verify.verify_attempt_id,
        verify.attempt,
        (
          SELECT COUNT(*)
          FROM verify_attempts failed_verify
          WHERE failed_verify.node_id=verify.node_id
            AND failed_verify.stage=verify.stage
            AND failed_verify.state IN ('failed','died')
        ) AS failed_attempt_count,
        node.project_id,
        node.plan_revision_id,
        node.title,
        node.objective,
        node.acceptance_criteria_json,
        node.stage_template_json,
        node.current_stage,
        node.state AS node_state,
        plan.work_item_id,
        plan.objective AS plan_objective,
        item.state AS work_item_state,
        item.pipeline_branch
      FROM verify_attempts verify
      JOIN work_nodes node ON node.node_id=verify.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      WHERE verify.node_id=? AND verify.stage=?
      ORDER BY verify.attempt DESC
      LIMIT 1
    `
      )
      .get(nodeId, stage) as Row | undefined;
    if (attempt === undefined) return Object.freeze([]);
    if (attempt.current_stage !== stage || attempt.node_state !== "active") return Object.freeze([]);
    const verifyAttemptId = String(attempt.verify_attempt_id);
    const taskId = `task_${verifyAttemptId}`;
    const handoffId = `handoff_${verifyAttemptId}`;
    if (this.db.prepare("SELECT 1 FROM stage_handoffs WHERE handoff_id=?").get(handoffId) !== undefined) {
      return Object.freeze([]);
    }

    const now = this.now().toISOString();
    const projectId = String(attempt.project_id);
    const failedAttemptCount = Number(attempt.failed_attempt_count);
    const template = json<WorkflowStage[]>(attempt.stage_template_json);
    const taskStatus = passed ? "completed" : "failed";
    const orderKey = Number(this.db.prepare("SELECT COALESCE(MAX(order_key),-1)+1 AS n FROM tasks").get()?.n);
    // stage_handoffs requires a task FK. This already-terminal, unassigned task is only the
    // durable system-authored anchor; machine verify never creates a wakeup or agent run.
    this.db
      .prepare(
        `
      INSERT INTO tasks(
        task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
        title, objective, acceptance_criteria, workspace_refs_json,
        status, assigned_agent_id, assigned_role, expected_agent_minutes, agent_estimate_minutes,
        estimate_recorded_at, order_key, started_at, ended_at, result, version, created_at, updated_at
      ) VALUES (?, ?, NULL, 'work', NULL, 0, ?, ?, ?, '[]', ?, NULL, NULL, 15, NULL,
        NULL, ?, ?, ?, ?, 1, ?, ?)
    `
      )
      .run(
        taskId,
        projectId,
        `Machine verify: ${String(attempt.title)}`.slice(0, 240),
        String(attempt.objective),
        json<string[]>(attempt.acceptance_criteria_json).join("\n"),
        taskStatus,
        orderKey,
        now,
        now,
        evidence.summary,
        now,
        now
      );
    this.db
      .prepare(
        `
      INSERT INTO task_events(event_id, project_id, task_id, actor_type, actor_id, event_type, data_json, created_at)
      VALUES (?, ?, ?, 'system', 'system:machine-verify', 'task_created', ?, ?)
    `
      )
      .run(
        randomUUID(),
        projectId,
        taskId,
        JSON.stringify({ kind: "work", requiresReview: false, status: taskStatus, verifyAttemptId }),
        now
      );
    const handoff: StageHandoff = Object.freeze({
      apiVersion: "steward.task-board/v1",
      handoffId,
      nodeId,
      taskId,
      stage,
      outcome: passed ? "passed" : "failed",
      summary: evidence.summary,
      evidence: Object.freeze([...evidence.evidence]),
      artifactIds: Object.freeze([]),
      acceptanceCriteria: Object.freeze([...evidence.acceptanceCriteria]),
      blockers: Object.freeze([...evidence.blockers]),
      recommendedReturnStage: passed ? null : "implementation",
      createdAt: now,
    });
    this.db
      .prepare("INSERT INTO stage_handoffs VALUES(?,?,?,?,?,?,?)")
      .run(handoffId, nodeId, taskId, stage, handoff.outcome, JSON.stringify(handoff), now);

    if (!passed) {
      if (template.includes("implementation") && failedAttemptCount < 3) {
        this.db
          .prepare(
            `
          UPDATE work_nodes
          SET state='ready', current_stage='implementation', version=version+1, updated_at=?
          WHERE node_id=?
        `
          )
          .run(now, nodeId);
        this.setWorkItemStage(String(attempt.plan_revision_id), nodeId, "implementation", now);
        this.event(
          projectId,
          nodeId,
          taskId,
          "stage_retry_ready",
          `${stage} failed; returning to implementation (attempt ${failedAttemptCount + 1} of 3)`,
          now
        );
        return Object.freeze(this.nodesForIds([nodeId]));
      }
      this.db
        .prepare("UPDATE work_nodes SET state='blocked',version=version+1,updated_at=? WHERE node_id=?")
        .run(now, nodeId);
      const workItemState = String(attempt.work_item_state) as WorkItemState;
      if (failedAttemptCount >= 3 && !isTerminalWorkItemState(workItemState)) {
        transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
          workItemId: String(attempt.work_item_id),
          to: "dead_letter",
          actorType: "system",
          actorId: "system:machine-verify",
          now,
          endedAt: now,
          currentStage: null,
        });
      }
      this.event(projectId, nodeId, taskId, "stage_failed", `${stage} failed: ${evidence.summary.slice(0, 240)}`, now);
      return Object.freeze([]);
    }

    const next = template[template.indexOf(stage) + 1] ?? null;
    if (next !== null) {
      this.db
        .prepare(
          `
        UPDATE work_nodes SET state='ready',current_stage=?,version=version+1,updated_at=? WHERE node_id=?
      `
        )
        .run(next, now, nodeId);
      this.setWorkItemStage(String(attempt.plan_revision_id), nodeId, next, now);
      this.event(projectId, nodeId, taskId, "stage_completed", `${stage} completed; ${next} is ready`, now);
      return Object.freeze(this.nodesForIds([nodeId]));
    }

    this.db
      .prepare(
        `
      UPDATE work_nodes SET state='completed',current_stage=NULL,version=version+1,updated_at=? WHERE node_id=?
    `
      )
      .run(now, nodeId);
    this.event(projectId, nodeId, taskId, "node_completed", "Subtask completed", now);
    const newlyReady = (
      this.db
        .prepare(
          `
      SELECT candidate.node_id
      FROM work_nodes candidate
      WHERE candidate.state='pending'
        AND EXISTS(
          SELECT 1 FROM work_node_dependencies dependency
          WHERE dependency.node_id=candidate.node_id AND dependency.dependency_node_id=?
        )
        AND NOT EXISTS(
          SELECT 1
          FROM work_node_dependencies dependency
          JOIN work_nodes predecessor ON predecessor.node_id=dependency.dependency_node_id
          WHERE dependency.node_id=candidate.node_id AND predecessor.state<>'completed'
        )
    `
        )
        .all(nodeId) as Row[]
    ).map((row) => String(row.node_id));
    for (const readyNodeId of newlyReady) {
      this.db
        .prepare(
          `
        UPDATE work_nodes
        SET state='ready',current_stage=json_extract(stage_template_json,'$[0]'),version=version+1,updated_at=?
        WHERE node_id=?
      `
        )
        .run(now, readyNodeId);
      this.event(projectId, readyNodeId, null, "dependency_unblocked", "Dependencies completed", now);
    }

    const planRevisionId = String(attempt.plan_revision_id);
    const unfinished = this.db
      .prepare("SELECT 1 FROM work_nodes WHERE plan_revision_id=? AND state<>'completed' LIMIT 1")
      .get(planRevisionId);
    if (unfinished === undefined) {
      const workItem = this.db
        .prepare("SELECT state,current_stage FROM work_items WHERE work_item_id=?")
        .get(String(attempt.work_item_id)) as Row | undefined;
      if (workItem === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:workflow_work_item");
      if (!isTerminalWorkItemState(String(workItem.state) as WorkItemState)) {
        const pipeline = attempt.pipeline_branch !== null;
        transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
          workItemId: String(attempt.work_item_id),
          to: pipeline ? "final_approval" : "merged",
          actorType: "system",
          actorId: "system:machine-verify",
          now,
          ...(pipeline ? {} : { endedAt: now }),
          ...(workItem.current_stage === null ? {} : { currentStage: null }),
        });
      }
      this.event(
        projectId,
        null,
        taskId,
        "workflow_completed",
        `Completed: ${String(attempt.plan_objective).slice(0, 240)}`,
        now
      );
    }
    return Object.freeze(this.nodesForIds(newlyReady));
  }

  attemptNeedsSettlementRepair(taskId: string, settledRunId: string): boolean {
    return (
      this.db
        .prepare(
          `
      SELECT 1
      FROM stage_attempts attempt
      JOIN work_nodes node ON node.node_id=attempt.node_id
      JOIN tasks task ON task.task_id=attempt.task_id
      JOIN runs settled_run ON settled_run.run_id=? AND settled_run.task_id=attempt.task_id
      WHERE attempt.task_id=?
        AND node.state='active'
        AND node.current_stage=attempt.stage
        AND NOT EXISTS(SELECT 1 FROM stage_handoffs handoff WHERE handoff.task_id=attempt.task_id)
        AND (
          (settled_run.status='completed' AND task.status='completed')
          OR (settled_run.status='failed' AND task.status='failed')
          OR (settled_run.status='interrupted' AND task.status='interrupted')
          OR (settled_run.status IN ('failed','interrupted') AND task.status='blocked')
        )
        AND NOT EXISTS(
          SELECT 1
          FROM runs newer_run
          WHERE newer_run.task_id=attempt.task_id
            AND newer_run.run_id<>settled_run.run_id
            AND newer_run.status='active'
        )
    `
        )
        .get(settledRunId, taskId) !== undefined
    );
  }

  private settleAttemptInternal(
    taskId: string,
    outcome: "completed" | "failed" | "interrupted",
    result: string,
    draft: StageHandoffDraft | null | undefined,
    reviewFindings: readonly ReviewFindingDraft[] | undefined,
    scopeCheck: AttemptScopeCheckResult | null
  ): readonly WorkNode[] {
    const attempt = this.db
      .prepare(
        `
      SELECT
        a.*,
        n.project_id,
        n.plan_revision_id,
        n.stage_template_json,
        n.current_stage,
        plan.work_item_id,
        item.state AS work_item_state,
        item.pipeline_branch
      FROM stage_attempts a
      JOIN work_nodes n ON n.node_id=a.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=n.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      WHERE a.task_id=?
    `
      )
      .get(taskId) as Row | undefined;
    if (!attempt) return Object.freeze([]);
    const now = this.now().toISOString();
    const apply = (): readonly WorkNode[] => {
      const nodeId = String(attempt.node_id);
      const projectId = String(attempt.project_id);
      const stage = String(attempt.stage) as WorkflowStage;
      const passed = outcome === "completed";
      const supplied = draft ?? null;
      if (
        supplied !== null &&
        ((passed && supplied.outcome !== "passed") || (!passed && supplied.outcome === "passed"))
      )
        throw new TaskBoardError(400, "HANDOFF_OUTCOME_MISMATCH", "Handoff outcome contradicts the settled run");
      if (supplied !== null && new Set(supplied.artifactIds).size !== supplied.artifactIds.length) {
        throw new TaskBoardError(400, "HANDOFF_ARTIFACT_INVALID", "Handoff artifact IDs must be unique");
      }
      for (const artifactId of supplied?.artifactIds ?? []) {
        if (
          !this.db.prepare("SELECT 1 FROM artifacts WHERE artifact_id=? AND project_id=?").get(artifactId, projectId)
        ) {
          throw new TaskBoardError(400, "HANDOFF_ARTIFACT_INVALID", "Handoff references an unavailable artifact");
        }
      }
      const pipelineReview = stage === "verification" && attempt.pipeline_branch !== null;
      if (reviewFindings !== undefined && !pipelineReview) {
        throw new TaskBoardError(
          400,
          TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_FINDINGS_NOT_ALLOWED,
          "Review findings are only allowed for pipeline verification"
        );
      }
      const persistedReviewFindings = (reviewFindings ?? []).map((finding, index): ReviewFinding => {
        const persisted = Object.freeze({
          ...finding,
          expected: redactForPersistence(finding.expected),
          actual: redactForPersistence(finding.actual),
          findingId: `finding_${String(index).padStart(2, "0")}_${randomUUID()}`,
          nodeId,
          stage,
          round: Number(attempt.attempt),
          blocking: reviewFindingBlocks(finding.category),
          createdAt: now,
        });
        this.db
          .prepare(
            `
          INSERT INTO review_findings(
            finding_id,node_id,stage,round,file,line,category,severity,expected,actual,blocking,created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `
          )
          .run(
            persisted.findingId,
            persisted.nodeId,
            persisted.stage,
            persisted.round,
            persisted.file ?? null,
            persisted.line ?? null,
            persisted.category,
            persisted.severity,
            persisted.expected,
            persisted.actual,
            persisted.blocking ? 1 : 0,
            persisted.createdAt
          );
        return persisted;
      });
      const blockingReviewFindings = persistedReviewFindings.filter((finding) => finding.blocking);
      const reviewerResult = pipelineReview && supplied !== null;
      if (
        pipelineReview &&
        passed &&
        blockingReviewFindings.length > 0 &&
        (supplied === null || supplied.outcome === "passed")
      ) {
        throw new TaskBoardError(
          400,
          TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_OUTCOME_MISMATCH,
          "A passed review cannot contain blocking findings"
        );
      }
      // failed + needs_input handoffs bypass FINDINGS_REQUIRED by design: a findings-less retry lane; revisit if it is abused (C5 final review, minor 5)
      const failedReview = reviewerResult && outcome === "failed" && supplied?.outcome !== "needs_input";
      if (failedReview && blockingReviewFindings.length === 0) {
        throw new TaskBoardError(
          400,
          TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_FINDINGS_REQUIRED,
          "A failed review requires at least one blocking finding"
        );
      }
      const scopeFailureDetail =
        passed && stage === "implementation" && attempt.pipeline_branch !== null
          ? scopeCheck === null
            ? "scope check failed"
            : scopeCheck.ok
              ? null
              : "files" in scopeCheck
                ? scopeViolationResult(scopeCheck.files)
                : scopeCheck.error.slice(0, 2_000)
          : null;
      const persistedSupplied =
        supplied === null
          ? null
          : Object.freeze({
              ...supplied,
              summary: redactForPersistence(supplied.summary),
              evidence: Object.freeze(supplied.evidence.map((entry) => redactForPersistence(entry))),
              acceptanceCriteria: Object.freeze(
                supplied.acceptanceCriteria.map((criterion) =>
                  Object.freeze({
                    ...criterion,
                    evidence: redactForPersistence(criterion.evidence),
                  })
                )
              ),
              blockers: Object.freeze(supplied.blockers.map((blocker) => redactForPersistence(blocker))),
            });
      const handoff: StageHandoff = Object.freeze({
        apiVersion: "steward.task-board/v1",
        handoffId: `handoff_${randomUUID()}`,
        nodeId,
        taskId,
        stage,
        outcome:
          scopeFailureDetail === null ? (persistedSupplied?.outcome ?? (passed ? "passed" : "failed")) : "failed",
        summary: scopeFailureDetail ?? persistedSupplied?.summary ?? result,
        evidence: persistedSupplied?.evidence ?? Object.freeze([]),
        artifactIds: persistedSupplied?.artifactIds ?? Object.freeze([]),
        acceptanceCriteria: persistedSupplied?.acceptanceCriteria ?? Object.freeze([]),
        blockers:
          scopeFailureDetail === null
            ? (persistedSupplied?.blockers ?? Object.freeze(passed ? [] : [result]))
            : Object.freeze([scopeFailureDetail]),
        recommendedReturnStage:
          scopeFailureDetail === null
            ? failedReview
              ? "implementation"
              : (persistedSupplied?.recommendedReturnStage ?? (passed ? null : stage))
            : stage,
        createdAt: now,
      });
      this.db
        .prepare("INSERT OR IGNORE INTO stage_handoffs VALUES(?,?,?,?,?,?,?)")
        .run(handoff.handoffId, nodeId, taskId, stage, handoff.outcome, JSON.stringify(handoff), now);
      const parkAttempt = (detail: string): readonly WorkNode[] => {
        this.db
          .prepare("UPDATE work_nodes SET state='blocked',version=version+1,updated_at=? WHERE node_id=?")
          .run(now, nodeId);
        const workItemState = String(attempt.work_item_state) as WorkItemState;
        if (!isTerminalWorkItemState(workItemState) && workItemState !== "parked") {
          transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
            workItemId: String(attempt.work_item_id),
            to: "parked",
            actorType: "system",
            actorId: "system:workflow",
            now,
            park: {
              category: detail.startsWith("BRIGHT_LINE:") ? "bright_line" : "scope_violation",
              reason: detail,
            },
          });
        }
        this.event(projectId, nodeId, taskId, "stage_failed", `${stage} blocked: ${detail.slice(0, 240)}`, now);
        return Object.freeze([]);
      };
      const brightLineDetail =
        attempt.pipeline_branch !== null && stage === "implementation" && !passed
          ? result.startsWith("BRIGHT_LINE:")
            ? result
            : persistedSupplied?.summary.startsWith("BRIGHT_LINE:") === true
              ? persistedSupplied.summary
              : null
          : null;
      if (brightLineDetail !== null) return parkAttempt(brightLineDetail);
      if (scopeFailureDetail !== null) return parkAttempt(scopeFailureDetail);
      if (!passed) {
        const returnStage = failedReview
          ? handoff.recommendedReturnStage
          : persistedSupplied === null && pipelineReview
            ? handoff.recommendedReturnStage
            : (persistedSupplied?.recommendedReturnStage ?? null);
        const attemptNumber = Number(attempt.attempt);
        const template = json<WorkflowStage[]>(attempt.stage_template_json);
        const maxAttempts = stage === "verification" && attempt.pipeline_branch !== null ? 4 : 3;
        if (returnStage !== null && template.includes(returnStage) && attemptNumber < maxAttempts) {
          this.db
            .prepare(
              "UPDATE work_nodes SET state='ready',current_stage=?,version=version+1,updated_at=? WHERE node_id=?"
            )
            .run(returnStage, now, nodeId);
          this.setWorkItemStage(String(attempt.plan_revision_id), nodeId, returnStage, now);
          this.event(
            projectId,
            nodeId,
            taskId,
            "stage_retry_ready",
            `${stage} failed; returning to ${returnStage} (attempt ${attemptNumber + 1} of ${maxAttempts})`,
            now
          );
          return Object.freeze(this.nodesForIds([nodeId]));
        }
        this.db
          .prepare("UPDATE work_nodes SET state='blocked',version=version+1,updated_at=? WHERE node_id=?")
          .run(now, nodeId);
        if (attemptNumber >= maxAttempts) {
          const plan = this.db
            .prepare(
              `
            SELECT plan.work_item_id, work_item.state
            FROM plan_revisions plan
            JOIN work_items work_item ON work_item.work_item_id = plan.work_item_id
            WHERE plan.plan_revision_id = ?
          `
            )
            .get(String(attempt.plan_revision_id)) as Row | undefined;
          if (plan === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:workflow_work_item");
          if (!isTerminalWorkItemState(String(plan.state) as WorkItemState)) {
            transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
              workItemId: String(plan.work_item_id),
              to: "dead_letter",
              actorType: "system",
              actorId: "system:workflow",
              now,
              endedAt: now,
              currentStage: null,
            });
          }
        }
        this.event(projectId, nodeId, taskId, "stage_failed", `${stage} failed: ${result.slice(0, 240)}`, now);
        return Object.freeze([]);
      }
      const template = json<WorkflowStage[]>(attempt.stage_template_json);
      const next = template[template.indexOf(stage) + 1] ?? null;
      if (next !== null) {
        this.db
          .prepare("UPDATE work_nodes SET state='ready',current_stage=?,version=version+1,updated_at=? WHERE node_id=?")
          .run(next, now, nodeId);
        this.setWorkItemStage(String(attempt.plan_revision_id), nodeId, next, now);
        this.event(projectId, nodeId, taskId, "stage_completed", `${stage} completed; ${next} is ready`, now);
        return Object.freeze(this.nodesForIds([nodeId]));
      }
      this.db
        .prepare(
          "UPDATE work_nodes SET state='completed',current_stage=NULL,version=version+1,updated_at=? WHERE node_id=?"
        )
        .run(now, nodeId);
      this.event(projectId, nodeId, taskId, "node_completed", "Subtask completed", now);
      const newlyReady = (
        this.db
          .prepare(
            `SELECT n.node_id FROM work_nodes n
        WHERE n.state='pending' AND EXISTS(SELECT 1 FROM work_node_dependencies d WHERE d.node_id=n.node_id AND d.dependency_node_id=?)
        AND NOT EXISTS(SELECT 1 FROM work_node_dependencies d JOIN work_nodes dependency ON dependency.node_id=d.dependency_node_id WHERE d.node_id=n.node_id AND dependency.state<>'completed')`
          )
          .all(nodeId) as Row[]
      ).map((row) => String(row.node_id));
      for (const id of newlyReady) {
        this.db
          .prepare(
            "UPDATE work_nodes SET state='ready',current_stage=json_extract(stage_template_json,'$[0]'),version=version+1,updated_at=? WHERE node_id=?"
          )
          .run(now, id);
        this.event(projectId, id, null, "dependency_unblocked", "Dependencies completed", now);
      }
      if (newlyReady.length > 0) {
        const nextStage = this.db
          .prepare("SELECT current_stage FROM work_nodes WHERE node_id=?")
          .get(newlyReady[0]!)?.current_stage;
        if (nextStage !== null && nextStage !== undefined) {
          this.setWorkItemStage(
            String(attempt.plan_revision_id),
            newlyReady[0]!,
            String(nextStage) as WorkflowStage,
            now
          );
        }
      }
      const planRevisionId = String(attempt.plan_revision_id);
      const unfinished = this.db
        .prepare("SELECT 1 FROM work_nodes WHERE plan_revision_id=? AND state<>'completed' LIMIT 1")
        .get(planRevisionId);
      if (!unfinished) {
        const plan = this.db
          .prepare("SELECT work_item_id,objective FROM plan_revisions WHERE plan_revision_id=?")
          .get(planRevisionId) as Row;
        const workItem = this.db
          .prepare("SELECT state,current_stage FROM work_items WHERE work_item_id = ?")
          .get(String(plan.work_item_id)) as Row | undefined;
        if (workItem === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:workflow_work_item");
        if (!isTerminalWorkItemState(String(workItem.state) as WorkItemState)) {
          const pipeline = attempt.pipeline_branch !== null;
          transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
            workItemId: String(plan.work_item_id),
            to: pipeline ? "final_approval" : "merged",
            actorType: "system",
            actorId: "system:workflow",
            now,
            ...(pipeline ? {} : { endedAt: now }),
            ...(workItem.current_stage === null ? {} : { currentStage: null }),
          });
        }
        this.event(
          projectId,
          null,
          taskId,
          "workflow_completed",
          `Completed: ${String(plan.objective).slice(0, 240)}`,
          now
        );
      }
      return Object.freeze(this.nodesForIds(newlyReady));
    };
    return apply();
  }

  nodesForIds(ids: readonly string[]): WorkNode[] {
    if (ids.length === 0) return [];
    const plans = new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT plan_revision_id FROM work_nodes WHERE node_id IN (${ids.map(() => "?").join(",")})`
          )
          .all(...ids) as Row[]
      ).map((row) => String(row.plan_revision_id))
    );
    return [...plans].flatMap((plan) => this.nodes(plan)).filter((node) => ids.includes(node.nodeId));
  }

  private setWorkItemStage(planRevisionId: string, nodeId: string, stage: WorkflowStage, updatedAt: string): void {
    const plan = this.db
      .prepare(
        `
      SELECT plan.work_item_id, work_item.state, work_item.current_stage
      FROM plan_revisions plan
      JOIN work_items work_item ON work_item.work_item_id = plan.work_item_id
      WHERE plan.plan_revision_id = ?
    `
      )
      .get(planRevisionId) as Row | undefined;
    if (plan === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:workflow_plan_work_item");
    if (isTerminalWorkItemState(String(plan.state) as WorkItemState)) return;
    const currentState = String(plan.state) as WorkItemState;
    const mappedState = workItemStateForNodeStage(this.db, String(plan.work_item_id), nodeId, stage, currentState);
    // An open question keeps the work item parked even if its workflow node has advanced.
    const parkedWithOpenQuestions =
      currentState === "parked" &&
      this.db
        .prepare(
          `
      SELECT 1
      FROM questions question
      LEFT JOIN work_item_planning_tasks planning ON planning.task_id = question.task_id
      LEFT JOIN stage_attempts attempt ON attempt.task_id = question.task_id
      LEFT JOIN work_nodes node ON node.node_id = attempt.node_id
      LEFT JOIN plan_revisions question_plan ON question_plan.plan_revision_id = node.plan_revision_id
      WHERE question.status = 'open'
        AND COALESCE(planning.work_item_id, question_plan.work_item_id) = ?
      LIMIT 1
    `
        )
        .get(String(plan.work_item_id)) !== undefined;
    transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
      workItemId: String(plan.work_item_id),
      to: parkedWithOpenQuestions
        ? currentState
        : currentState === "plan_approval" && mappedState === "planning"
          ? currentState
          : mappedState,
      actorType: "system",
      actorId: "system:workflow",
      now: updatedAt,
      currentStage: stage,
      ...(parkedWithOpenQuestions
        ? { park: { category: "open_question" as const, reason: "work item remains parked for open questions" } }
        : {}),
      // Touch only when the stage genuinely moved — an unchanged stage must
      // not bump the version and spuriously invalidate concurrent CAS holders.
      ...(parkedWithOpenQuestions && stage !== plan.current_stage ? { touch: true } : {}),
    });
  }

  nodes(planId: string): readonly WorkNode[] {
    const rows = this.db
      .prepare(
        `SELECT n.*, COALESCE(json_group_array(d.dependency_node_id) FILTER(WHERE d.dependency_node_id IS NOT NULL),'[]') dependencies
      FROM work_nodes n LEFT JOIN work_node_dependencies d ON d.node_id=n.node_id WHERE n.plan_revision_id=? GROUP BY n.node_id ORDER BY n.created_at,n.node_id`
      )
      .all(planId) as Row[];
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          apiVersion: "steward.task-board/v1",
          nodeId: String(row.node_id),
          planRevisionId: String(row.plan_revision_id),
          projectId: String(row.project_id),
          title: String(row.title),
          objective: String(row.objective),
          acceptanceCriteria: Object.freeze(json<string[]>(row.acceptance_criteria_json)),
          dependencyNodeIds: Object.freeze(json<string[]>(row.dependencies)),
          stageTemplate: Object.freeze(json<WorkflowStage[]>(row.stage_template_json)),
          currentStage: row.current_stage as WorkflowStage | null,
          state: row.state as WorkNode["state"],
          version: Number(row.version),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
        })
      )
    );
  }

  snapshot(projectId: string): ProjectWorkflowSnapshot {
    const plans = (
      this.db.prepare("SELECT * FROM plan_revisions WHERE project_id=? ORDER BY revision DESC").all(projectId) as Row[]
    ).map(planFromRow);
    const seenWorkItems = new Set<string>();
    const latestPlans = plans.filter((plan) => {
      if (seenWorkItems.has(plan.workItemId)) return false;
      seenWorkItems.add(plan.workItemId);
      return true;
    });
    const nodes = latestPlans.flatMap((plan) => this.nodes(plan.planRevisionId));
    const handoffs = (
      this.db
        .prepare(
          "SELECT payload_json FROM stage_handoffs h JOIN work_nodes n ON n.node_id=h.node_id WHERE n.project_id=? ORDER BY h.created_at"
        )
        .all(projectId) as Row[]
    ).map((row) => Object.freeze(json<StageHandoff>(row.payload_json)));
    const events = (
      this.db
        .prepare("SELECT * FROM project_events WHERE project_id=? ORDER BY sequence DESC LIMIT 500")
        .all(projectId) as Row[]
    ).map((row) =>
      Object.freeze({
        apiVersion: "steward.task-board/v1" as const,
        sequence: Number(row.sequence),
        eventId: String(row.event_id),
        projectId: String(row.project_id),
        nodeId: row.node_id === null ? null : String(row.node_id),
        taskId: row.task_id === null ? null : String(row.task_id),
        eventType: String(row.event_type),
        summary: String(row.summary),
        createdAt: String(row.created_at),
      })
    );
    return Object.freeze({
      plans: Object.freeze(plans),
      nodes: Object.freeze(nodes),
      handoffs: Object.freeze(handoffs),
      events: Object.freeze(events),
    });
  }

  event(
    projectId: string,
    nodeId: string | null,
    taskId: string | null,
    type: string,
    summary: string,
    createdAt = this.now().toISOString()
  ): void {
    const eventId = `event_${randomUUID()}`;
    this.db
      .prepare(
        "INSERT INTO project_events(event_id,project_id,node_id,task_id,event_type,summary,created_at) VALUES(?,?,?,?,?,?,?)"
      )
      .run(eventId, projectId, nodeId, taskId, type, summary, createdAt);
    const sequence = Number(
      (this.db.prepare("SELECT sequence FROM project_events WHERE event_id=?").get(eventId) as Row).sequence
    );
    // The injected queue owns after-commit delivery; the event row above stays in the caller's transaction.
    this.queueEvent?.(
      Object.freeze({
        apiVersion: "steward.task-board/v1",
        sequence,
        eventId,
        projectId,
        nodeId,
        taskId,
        eventType: type,
        summary,
        createdAt,
      })
    );
  }
}
