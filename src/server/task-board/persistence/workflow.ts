import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  GIT_OBJECT_ID_PATTERN,
  IDENTIFIER_PATTERN,
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
  type WorkflowPipelineContext,
  type WorkflowReviewContext,
  type WorkflowStage,
} from "#shared/task-board-contract";
import { parseDesignRecordDraft } from "#shared/task-board-contract/validate";
import { TaskBoardError } from "../errors.js";
import { SkillRegistry } from "../skills.js";
import {
  transitionWorkItemInTransaction,
  workItemStateForStage,
  workItemStateForNodeStage,
  workItemTransitionStoreForDatabase,
} from "../collaborators/work-item-transitions.js";
import {
  scopeViolationResult,
  type DeclaredScopeCheckResult,
  type GitRunner,
} from "../collaborators/scope-check.js";
import {
  inspectPipelineBranchSync,
  pipelineMidRunAssumptions,
  type PipelineInspection,
} from "../collaborators/pipeline-inspection.js";

type Row = Record<string, unknown>;
export type { GitRunner as WorkflowGitRunner } from "../collaborators/scope-check.js";
export type AttemptScopeCheckResult = DeclaredScopeCheckResult | Readonly<{
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

function truncateWithMarker(value: string, maximum: number, marker: string): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - marker.length))}${marker}`;
}

function boundedReviewList<T>(
  items: readonly T[],
  maximumItems: number,
  jsonBudget: number,
  marker: T,
): readonly T[] {
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
    ) break;
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
  const commits = inspection.commits.map((commit) => Object.freeze({
    sha: commit.sha,
    subject: truncateWithMarker(commit.subject, 1_000, " [truncated]"),
  }));
  const filesTouched = inspection.filesTouched.map((file) => Object.freeze({
    path: truncateWithMarker(file.path, 512, " [path truncated]"),
    status: file.status,
  }));
  return Object.freeze({
    commits: boundedReviewList(
      commits,
      REVIEW_COMMIT_MAX_ITEMS,
      REVIEW_COMMIT_JSON_BUDGET,
      REVIEW_COMMIT_TRUNCATION_MARKER,
    ),
    diffstat: truncateWithMarker(
      inspection.diffstat,
      REVIEW_DIFFSTAT_MAX_CHARACTERS,
      REVIEW_DIFFSTAT_TRUNCATION_MARKER,
    ),
    filesTouched: boundedReviewList(
      filesTouched,
      REVIEW_FILE_MAX_ITEMS,
      REVIEW_FILE_JSON_BUDGET,
      REVIEW_FILE_TRUNCATION_MARKER,
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
  if (!Array.isArray(value) || value.length > max) throw new TaskBoardError(400, "WORKFLOW_INVALID", `${field} is invalid`);
  return value.map((item, index) => text(item, `${field}[${index}]`, 4_000));
}
function json<T>(value: unknown): T { return JSON.parse(String(value)) as T; }
function reviewFindingFromRow(row: Row): ReviewFinding {
  return Object.freeze({
    findingId: String(row.finding_id),
    nodeId: String(row.node_id),
    stage: row.stage as WorkflowStage,
    round: Number(row.round),
    file: row.file === null ? null : String(row.file),
    line: row.line === null ? null : Number(row.line),
    category: row.category as ReviewFinding["category"],
    severity: row.severity as ReviewFinding["severity"],
    expected: String(row.expected),
    actual: String(row.actual),
    blocking: Number(row.blocking) === 1,
    createdAt: String(row.created_at),
  });
}
function optionalJsonList<T>(value: unknown): readonly T[] | undefined {
  return value === null ? undefined : Object.freeze(json<T[]>(value));
}

function assertPipelinePlanRecordComplete(raw: CreatePlanRevisionRequest): void {
  const pipelineNode = raw.nodes.length === 1 ? raw.nodes[0] : undefined;
  if (pipelineNode === undefined || pipelineTemplateShape(pipelineNode.stageTemplate) === null) return;
  const missingField = raw.changeShape === undefined
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
      `Pipeline plan is missing required field ${missingField}`,
    );
  }
}

function testingStageUsesMachineVerify(db: DatabaseSync): boolean {
  const row = db.prepare(
    "SELECT stages_json FROM automation_configuration WHERE configuration_id = 'company-default'",
  ).get();
  if (row === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:automation_configuration_missing");
  const stages = json<Array<{ readonly stage?: unknown; readonly executor?: { readonly kind?: unknown } }>>(row.stages_json);
  return stages.some((stage) => stage.stage === "testing" && stage.executor?.kind === "machine_verify");
}

function verificationStageUsesEnabledAgentType(db: DatabaseSync): boolean {
  const row = db.prepare(
    "SELECT agent_types_json,stages_json FROM automation_configuration WHERE configuration_id = 'company-default'",
  ).get();
  if (row === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:automation_configuration_missing");
  const stages = json<Array<{
    readonly stage?: unknown;
    readonly executor?: { readonly kind?: unknown; readonly agentTypeId?: unknown };
  }>>(row.stages_json);
  const agentTypes = json<Array<{ readonly agentTypeId?: unknown; readonly enabled?: unknown }>>(row.agent_types_json);
  const executor = stages.find((stage) => stage.stage === "verification")?.executor;
  return executor?.kind === "agent_type" &&
    typeof executor.agentTypeId === "string" &&
    agentTypes.some((agentType) => agentType.agentTypeId === executor.agentTypeId && agentType.enabled === true);
}

function storedPlanPipelineShape(
  db: DatabaseSync,
  planRevisionId: string,
): ReturnType<typeof pipelineTemplateShape> {
  const templates = (db.prepare(
    "SELECT stage_template_json FROM work_nodes WHERE plan_revision_id=? ORDER BY node_id",
  ).all(planRevisionId) as Row[]).map((row) => json<WorkflowStage[]>(row.stage_template_json));
  return templates.length === 1 ? pipelineTemplateShape(templates[0]!) : null;
}

function pipelineExecutorDrift(): TaskBoardError {
  return new TaskBoardError(
    409,
    TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_EXECUTOR_DRIFT,
    "The pipeline testing executor changed before confirmation",
  );
}

function assertPipelineSerialAvailability(db: DatabaseSync, projectId: string, workItemId: string): void {
  const active = db.prepare(`
    SELECT 1
    FROM work_items
    WHERE resolved_project_id=?
      AND work_item_id<>?
      AND pipeline_branch IS NOT NULL
      AND state IN ('implementing','verifying','reviewing','fixing','designing','final_approval','parked')
    LIMIT 1
  `).get(projectId, workItemId);
  if (active !== undefined) {
    throw new TaskBoardError(
      409,
      TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_SERIAL_CONFLICT,
      "Another pipeline work item is still active for this project",
    );
  }
}

function pipelineBaseSha(repositoryPath: string, git: GitRunner): string {
  try {
    const output = git([
      "-c", "core.fsmonitor=",
      "-c", "core.hooksPath=",
      "-C", repositoryPath,
      "rev-parse", "HEAD",
    ]).trim();
    if (!GIT_OBJECT_ID_PATTERN.test(output)) throw new Error("git returned an invalid object id");
    return output;
  } catch (error) {
    throw new TaskBoardError(
      409,
      TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_REPO_UNAVAILABLE,
      "The pipeline repository is unavailable",
      { cause: error },
    );
  }
}

function planFromRow(row: Row): PlanRevision {
  const declaredScope = optionalJsonList<string>(row.declared_scope_json);
  const nonGoals = optionalJsonList<string>(row.non_goals_json);
  const mechanicalPortions = optionalJsonList<string>(row.mechanical_portions_json);
  const blockingQuestions = optionalJsonList<{ readonly question: string; readonly recommendedDefault: string }>(row.blocking_questions_json);
  const criterionChecks = optionalJsonList<{ readonly criterion: string; readonly check: string }>(row.criterion_checks_json);
  return Object.freeze({
    apiVersion: "steward.task-board/v1", planRevisionId: String(row.plan_revision_id),
    workItemId: String(row.work_item_id), revision: Number(row.revision), objective: String(row.objective),
    assumptions: Object.freeze(json<string[]>(row.assumptions_json)),
    acceptanceCriteria: Object.freeze(json<string[]>(row.acceptance_criteria_json)),
    ...(row.change_shape === null ? {} : { changeShape: String(row.change_shape) as NonNullable<PlanRevision["changeShape"]> }),
    ...(row.tier === null ? {} : { tier: String(row.tier) as NonNullable<PlanRevision["tier"]> }),
    ...(declaredScope === undefined ? {} : { declaredScope }),
    ...(nonGoals === undefined ? {} : { nonGoals }),
    ...(mechanicalPortions === undefined ? {} : { mechanicalPortions }),
    ...(blockingQuestions === undefined ? {} : { blockingQuestions }),
    ...(criterionChecks === undefined ? {} : { criterionChecks }),
    projectId: String(row.project_id), skillDigests: Object.freeze(json<Record<string, string>>(row.skill_digests_json)),
    state: row.state as PlanRevision["state"], createdBy: String(row.created_by),
    confirmedBy: row.confirmed_by === null ? null : String(row.confirmed_by),
    createdAt: String(row.created_at), confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at),
    ...(row.rejected_note === null ? {} : { rejectedNote: String(row.rejected_note) }),
  });
}

export interface ProjectWorkflowSnapshot {
  readonly plans: readonly PlanRevision[];
  readonly nodes: readonly WorkNode[];
  readonly handoffs: readonly StageHandoff[];
  readonly events: readonly ProjectEvent[];
}

export interface ConfirmWorkflowTransactionResult {
  readonly readyNodes: readonly WorkNode[];
  readonly outcome?: "parked_hazardous" | "designing";
}

export interface RejectWorkflowTransactionResult extends RejectPlanRevisionResponse {
  readonly workItemId: string;
  readonly projectId: string;
}

export type PipelineMergeSettlement =
  | Readonly<{ kind: "merged"; mergeSha: string }>
  | Readonly<{ kind: "conflict"; summary: string }>;

export class TransparentWorkflow {
  constructor(
    readonly db: DatabaseSync,
    readonly skills: SkillRegistry,
    readonly now: () => Date,
    readonly transaction: <T>(operation: () => T) => T,
    readonly queueEvent: ((event: ProjectEvent) => void) | undefined,
    readonly git: GitRunner,
  ) {}

  propose(raw: CreatePlanRevisionRequest, actor: string): ProjectWorkflowSnapshot {
    return this.proposeInternal(raw, "human", actor, false);
  }

  proposeInTransaction(raw: CreatePlanRevisionRequest, actor: string): ProjectWorkflowSnapshot {
    return this.proposeInternal(raw, "agent", actor, true);
  }

  private activateDependencyFreeNodesAtTemplateStart(
    planRevisionId: string,
    updatedAt: string,
  ): Readonly<{ firstStage: WorkflowStage | null; readyNodes: readonly WorkNode[] }> {
    this.db.prepare(`
      UPDATE work_nodes
      SET state='ready',current_stage=json_extract(stage_template_json,'$[0]'),version=version+1,updated_at=?
      WHERE plan_revision_id=?
        AND state='pending'
        AND NOT EXISTS(SELECT 1 FROM work_node_dependencies dependency WHERE dependency.node_id=work_nodes.node_id)
    `).run(updatedAt, planRevisionId);
    const firstStage = this.db.prepare(`
      SELECT current_stage
      FROM work_nodes
      WHERE plan_revision_id=? AND state='ready'
      ORDER BY created_at,node_id
      LIMIT 1
    `).get(planRevisionId)?.current_stage;
    return Object.freeze({
      firstStage: firstStage === undefined || firstStage === null ? null : String(firstStage) as WorkflowStage,
      readyNodes: Object.freeze(this.nodes(planRevisionId).filter((node) => node.state === "ready")),
    });
  }

  private proposeInternal(
    raw: CreatePlanRevisionRequest,
    actorType: "human" | "agent",
    actor: string,
    inTransaction: boolean,
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
    if (!this.db.prepare("SELECT 1 FROM work_items WHERE work_item_id = ?").get(workItemId)) throw new TaskBoardError(404, "WORK_ITEM_NOT_FOUND", "Work item was not found");
    if (!this.db.prepare("SELECT 1 FROM projects WHERE project_id = ?").get(projectId)) throw new TaskBoardError(404, "PROJECT_NOT_FOUND", "Project was not found");
    const snapshots = this.skills.loadSync(raw.skillIds);
    const skillDigests = Object.fromEntries(snapshots.map((skill) => [skill.skillId, skill.digest]));
    const ids = new Set<string>();
    const nodes = raw.nodes.map((node, index) => {
      const nodeId = text(node.nodeId, `nodes[${index}].nodeId`, 128);
      if (!ID.test(nodeId) || ids.has(nodeId)) throw new TaskBoardError(400, "WORKFLOW_INVALID", "Node IDs must be unique identifiers");
      ids.add(nodeId);
      const stages = node.stageTemplate.map((stage: WorkflowStage) => {
        if (!STAGES.has(stage)) throw new TaskBoardError(400, "WORKFLOW_INVALID", "Node stage is invalid");
        return stage;
      });
      const terminalStage = stages.at(-1);
      if (stages.length === 0 ||
        terminalStage !== "verification" ||
        new Set(stages).size !== stages.length) {
        throw new TaskBoardError(
          400,
          "WORKFLOW_INVALID",
          "Every node needs unique ordered stages ending in verification",
        );
      }
      return { nodeId, title: text(node.title, "node.title", 256), objective: text(node.objective, "node.objective"), acceptanceCriteria: list(node.acceptanceCriteria, "node.acceptanceCriteria"), dependencyNodeIds: [...node.dependencyNodeIds], stages };
    });
    for (const node of nodes) for (const dependency of node.dependencyNodeIds) if (!ids.has(dependency) || dependency === node.nodeId) throw new TaskBoardError(400, "WORKFLOW_INVALID", "Dependency is invalid");
    const visiting = new Set<string>(); const visited = new Set<string>(); const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const visit = (id: string) => { if (visiting.has(id)) throw new TaskBoardError(400, "WORKFLOW_CYCLE", "Task dependencies contain a cycle"); if (visited.has(id)) return; visiting.add(id); for (const dep of byId.get(id)!.dependencyNodeIds) visit(dep); visiting.delete(id); visited.add(id); };
    for (const id of ids) visit(id);
    const createdAt = this.now().toISOString();
    const apply = (): void => {
      const workItem = this.db.prepare(
        "SELECT state,current_stage,ended_at FROM work_items WHERE work_item_id=?",
      ).get(workItemId) as Row | undefined;
      if (workItem === undefined) throw new TaskBoardError(404, "WORK_ITEM_NOT_FOUND", "Work item was not found");
      if (workItem.ended_at !== null) {
        throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.WORK_ITEM_ENDED, "Work item has ended");
      }
      if (this.db.prepare("SELECT 1 FROM plan_revisions WHERE work_item_id=? AND state='confirmed'").get(workItemId)) {
        throw new TaskBoardError(409, "PLAN_REVISION_UNSUPPORTED", "Confirmed workflows cannot be revised in this version");
      }
      const revision = Number(this.db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM plan_revisions WHERE work_item_id=?").get(workItemId)?.revision);
      const planId = `plan_${randomUUID()}`;
      const storedIds = new Map(nodes.map((node) => [node.nodeId, `node_${randomUUID()}`]));
      this.db.prepare("UPDATE plan_revisions SET state='superseded' WHERE work_item_id=? AND state='proposed'").run(workItemId);
      this.db.prepare(`
        INSERT INTO plan_revisions(
          plan_revision_id, work_item_id, revision, objective, assumptions_json,
          acceptance_criteria_json, change_shape, tier, declared_scope_json, non_goals_json,
          mechanical_portions_json, blocking_questions_json, criterion_checks_json,
          project_id, skill_digests_json, state, created_by,
          confirmed_by, created_at, confirmed_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
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
      );
      for (const node of nodes) {
        const storedId = storedIds.get(node.nodeId)!;
        this.db.prepare("INSERT INTO work_nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(storedId, planId, projectId, node.title, node.objective, JSON.stringify(node.acceptanceCriteria), JSON.stringify(node.stages), null, "pending", 1, createdAt, createdAt);
        for (const dependency of node.dependencyNodeIds) {
          this.db.prepare("INSERT INTO work_node_dependencies VALUES(?,?)").run(storedId, storedIds.get(dependency)!);
        }
      }
      const objectiveUpdate = this.db.prepare(`
        UPDATE
          work_items
        SET refined_objective = ?
        WHERE work_item_id = ? AND ended_at IS NULL
      `).run(objective, workItemId);
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
    const row = this.db.prepare(`
      SELECT
        a.stage,
        plan.declared_scope_json,
        item.pipeline_branch,
        item.base_sha,
        project.description AS repo_path
      FROM stage_attempts a
      JOIN work_nodes n ON n.node_id=a.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=n.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      JOIN projects project ON project.project_id=plan.project_id
      WHERE a.task_id=?
    `).get(taskId) as Row | undefined;
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
        { cause: error },
      );
    }
  }

  claimContext(
    taskId: string,
    reviewInspection: PipelineInspection | null,
  ): ClaimRunResult["context"]["workflow"] {
    const row = this.db.prepare(`
      SELECT
        a.stage,
        a.skill_digests_json,
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
        project.description AS repo_path,
        (SELECT payload_json FROM design_records design
          WHERE design.work_item_id=plan.work_item_id AND design.plan_revision_id=plan.plan_revision_id
        ) AS design_record_json
      FROM stage_attempts a
      JOIN work_nodes n ON n.node_id=a.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=n.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      JOIN projects project ON project.project_id=plan.project_id
      WHERE a.task_id=?
    `).get(taskId) as Row | undefined;
    if (!row) return null;
    const digests = json<Record<string, string>>(row.skill_digests_json);
    const skills = this.skills.loadSync(Object.keys(digests));
    for (const skill of skills) if (digests[skill.skillId] !== skill.digest) throw new TaskBoardError(409, "SKILL_DIGEST_CHANGED", `Skill ${skill.skillId} changed after confirmation`);
    const handoffs = (this.db.prepare(`SELECT h.payload_json FROM work_node_dependencies d JOIN stage_handoffs h ON h.node_id=d.dependency_node_id
      WHERE d.node_id=? ORDER BY h.created_at`).all(String(row.node_id)) as Row[]).map((item) => Object.freeze(json<StageHandoff>(item.payload_json)));
    const hasPipelineBranch = row.pipeline_branch !== null;
    if (hasPipelineBranch !== (row.base_sha !== null)) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:pipeline_identity");
    }
    let pipeline: WorkflowPipelineContext | null = null;
    let review: NonNullable<NonNullable<ClaimRunResult["context"]["workflow"]>["review"]> | null = null;
    let fix: NonNullable<NonNullable<ClaimRunResult["context"]["workflow"]>["fix"]> | null = null;
    if (hasPipelineBranch) {
      if (
        row.change_shape === null || row.tier === null ||
        row.declared_scope_json === null
      ) {
        throw new Error("TASK_BOARD_DATABASE_CORRUPT:pipeline_plan_record");
      }
      pipeline = Object.freeze({
        branch: String(row.pipeline_branch),
        baseSha: String(row.base_sha),
        changeShape: String(row.change_shape) as WorkflowPipelineContext["changeShape"],
        tier: String(row.tier) as WorkflowPipelineContext["tier"],
        declaredScope: Object.freeze(json<string[]>(row.declared_scope_json)),
        nonGoals: row.non_goals_json === null
          ? Object.freeze([])
          : Object.freeze(json<string[]>(row.non_goals_json)),
        assumptions: Object.freeze(json<string[]>(row.assumptions_json)),
        designRecord: row.design_record_json === null
          ? null
          : parseDesignRecordDraft(json<DesignRecordDraft>(row.design_record_json)),
      });
      if (row.stage === "implementation") {
        const latestSameNodeHandoff = this.db.prepare(`
          SELECT payload_json
          FROM stage_handoffs
          WHERE node_id=? AND stage IN ('implementation','testing','verification')
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `).get(String(row.node_id)) as Row | undefined;
        if (latestSameNodeHandoff !== undefined) {
          const handoff = Object.freeze(json<StageHandoff>(latestSameNodeHandoff.payload_json));
          if (handoff.outcome === "failed") handoffs.push(handoff);
        }
        const latestFindingsRound = this.db.prepare(`
          SELECT MAX(round) AS round
          FROM review_findings
          WHERE node_id=? AND blocking=1
        `).get(String(row.node_id)) as Row | undefined;
        if (latestFindingsRound?.round !== null && latestFindingsRound?.round !== undefined) {
          const round = Number(latestFindingsRound.round);
          const findings = (this.db.prepare(`
            SELECT *
            FROM review_findings
            WHERE node_id=? AND round=?
            ORDER BY created_at,finding_id
          `).all(String(row.node_id), round) as Row[]).map(reviewFindingFromRow);
          fix = Object.freeze({ round, findings: Object.freeze(findings) });
        }
      }
      if (row.stage === "verification") {
        if (reviewInspection === null) throw new Error("TASK_BOARD_DATABASE_CORRUPT:review_inspection");
        const inspection = boundPipelineInspectionForReview(reviewInspection);
        const allPriorFindings = (this.db.prepare(`
          SELECT *
          FROM review_findings
          WHERE node_id=?
          ORDER BY round,created_at,finding_id
        `).all(String(row.node_id)) as Row[]).map(reviewFindingFromRow);
        const priorFindings = boundPriorReviewFindings(allPriorFindings);
        review = Object.freeze({
          commits: inspection.commits,
          diffstat: inspection.diffstat,
          filesTouched: inspection.filesTouched,
          scopeOk: reviewInspection.scopeOk,
          midRunAssumptions: pipelineMidRunAssumptions(this.db, String(row.work_item_id)),
          acceptanceCriteria: Object.freeze(json<string[]>(row.acceptance_criteria_json)),
          criterionChecks: Object.freeze(json<Array<{ criterion: string; check: string }>>(
            row.criterion_checks_json ?? "[]",
          ).map((criterionCheck) => Object.freeze(criterionCheck))),
          mechanicalPortions: row.mechanical_portions_json === null
            ? Object.freeze([])
            : Object.freeze(json<string[]>(row.mechanical_portions_json)),
          priorFindings: priorFindings.findings,
          priorFindingsTruncated: priorFindings.truncated,
        });
      }
    }
    return Object.freeze({
      planRevisionId: String(row.plan_revision_id), nodeId: String(row.node_id), stage: row.stage as WorkflowStage,
      skills: Object.freeze(skills), dependencyHandoffs: Object.freeze(handoffs),
      workspaceKey: pipeline === null
        ? null
        : row.stage === "verification" ? `${String(row.work_item_id)}-review` : String(row.work_item_id),
      pipeline,
      review,
      fix,
    });
  }

  pipelineBaseShaForConfirm(planId: string, request: ConfirmPlanRevisionRequest): string | null {
    if (request.expectedState !== "proposed") throw new TaskBoardError(400, "WORKFLOW_INVALID", "Expected state must be proposed");
    const row = this.db.prepare("SELECT * FROM plan_revisions WHERE plan_revision_id=?").get(planId) as Row | undefined;
    if (!row) throw new TaskBoardError(404, TASK_BOARD_ERROR_CODES.PLAN_NOT_FOUND, "Plan was not found");
    if (row.state !== "proposed") throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.PLAN_NOT_PROPOSED, "Plan is no longer proposed");
    const pipelineShape = storedPlanPipelineShape(this.db, planId);
    const hasPipelineShape = pipelineShape !== null;
    if (
      pipelineShape !== null &&
      (!testingStageUsesMachineVerify(this.db) ||
        (pipelineShape === "v2" && !verificationStageUsesEnabledAgentType(this.db)))
    ) throw pipelineExecutorDrift();
    if (!hasPipelineShape) return null;
    assertPipelineSerialAvailability(this.db, String(row.project_id), String(row.work_item_id));
    const project = this.db.prepare("SELECT description FROM projects WHERE project_id=?").get(String(row.project_id));
    if (project === undefined) {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_REPO_UNAVAILABLE,
        "The pipeline repository is unavailable",
      );
    }
    return pipelineBaseSha(String(project.description), this.git);
  }

  confirm(
    planId: string,
    request: ConfirmPlanRevisionRequest,
    actor: string,
    resolvedBaseSha: string | null,
    startDesignInTransaction?: (workItemId: string) => void,
  ): ConfirmWorkflowTransactionResult {
    if (request.expectedState !== "proposed") throw new TaskBoardError(400, "WORKFLOW_INVALID", "Expected state must be proposed");
    const now = this.now().toISOString();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM plan_revisions WHERE plan_revision_id=?").get(planId) as Row | undefined;
      if (!row) throw new TaskBoardError(404, TASK_BOARD_ERROR_CODES.PLAN_NOT_FOUND, "Plan was not found");
      if (row.state !== "proposed") throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.PLAN_NOT_PROPOSED, "Plan is no longer proposed");
      const pipelineShape = storedPlanPipelineShape(this.db, planId);
      const hasPipelineShape = pipelineShape !== null;
      if (
        pipelineShape !== null &&
        (!testingStageUsesMachineVerify(this.db) ||
          (pipelineShape === "v2" && !verificationStageUsesEnabledAgentType(this.db)))
      ) throw pipelineExecutorDrift();
      let identity: Readonly<{ branch: string; baseSha: string }> | null = null;
      if (hasPipelineShape) {
        assertPipelineSerialAvailability(this.db, String(row.project_id), String(row.work_item_id));
        if (resolvedBaseSha === null || !GIT_OBJECT_ID_PATTERN.test(resolvedBaseSha)) {
          throw new TaskBoardError(
            409,
            TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_REPO_UNAVAILABLE,
            "The pipeline repository is unavailable",
          );
        }
        identity = Object.freeze({
          branch: `task/${String(row.work_item_id)}`,
          baseSha: resolvedBaseSha,
        });
      }
      this.db.prepare("UPDATE plan_revisions SET state='confirmed',confirmed_by=?,confirmed_at=? WHERE plan_revision_id=?").run(actor, now, planId);
      const projectUpdate = this.db.prepare(`
        UPDATE
          work_items
        SET resolved_project_id = ?
        WHERE work_item_id = ? AND ended_at IS NULL
      `).run(String(row.project_id), String(row.work_item_id));
      if (Number(projectUpdate.changes) !== 1) {
        throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.WORK_ITEM_ENDED, "Work item has ended");
      }
      if (identity !== null) {
        const identityUpdate = this.db.prepare(`
          UPDATE work_items
          SET pipeline_branch=?,base_sha=?
          WHERE work_item_id=? AND ended_at IS NULL
        `).run(identity.branch, identity.baseSha, String(row.work_item_id));
        if (Number(identityUpdate.changes) !== 1) {
          throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.WORK_ITEM_ENDED, "Work item has ended");
        }
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
          now,
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
    actor: string,
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
    const rejectedBefore = this.db.prepare(
      "SELECT 1 FROM plan_revisions WHERE work_item_id=? AND state='rejected' LIMIT 1",
    ).get(workItemId) !== undefined;
    const updated = this.db.prepare(
      "UPDATE plan_revisions SET state='rejected',rejected_note=? WHERE plan_revision_id=? AND state='proposed'",
    ).run(request.note, planId);
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
      ...(outcome === "revising" ? { currentStage: "planning" as const } : {}),
    });
    this.event(
      projectId,
      null,
      null,
      "plan_rejected",
      outcome === "parked" ? "Plan rejected twice; work item parked" : "Plan rejected for revision",
      now,
    );
    return Object.freeze({ outcome, workItemId, projectId });
  }

  settlePipelineMergeInTransaction(
    workItemId: string,
    version: number,
    settlement: PipelineMergeSettlement,
    actor: string,
  ): readonly WorkNode[] {
    if (settlement.kind === "conflict") {
      // Spec refinement: a cleanly aborted merge conflict is recoverable engineering work.
      // Use the final-rejection return path verbatim so the implementation node is re-armed
      // with a system:final-approval failed handoff instead of parking the serial pipeline.
      return this.rejectFinalApprovalInTransaction(workItemId, {
        version,
        note: settlement.summary,
      }, actor);
    }
    const row = this.db.prepare(`
      SELECT item.state,item.version,plan.project_id,node.node_id
      FROM work_items item
      JOIN plan_revisions plan ON plan.work_item_id=item.work_item_id AND plan.state='confirmed'
      JOIN work_nodes node ON node.plan_revision_id=plan.plan_revision_id
      WHERE item.work_item_id=?
      ORDER BY plan.revision DESC,node.created_at,node.node_id
      LIMIT 1
    `).get(workItemId) as Row | undefined;
    if (row === undefined) throw new TaskBoardError(404, "WORK_ITEM_NOT_FOUND", "Work item was not found");
    if (Number(row.version) !== version) {
      throw new TaskBoardError(409, "WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
    }
    if (row.state !== "final_approval") {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.WORK_ITEM_ILLEGAL_TRANSITION,
        "Work item is not awaiting final approval",
      );
    }
    const now = this.now().toISOString();
    transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
      workItemId,
      to: "merged",
      actorType: "human",
      actorId: actor,
      now,
      endedAt: now,
      currentStage: null,
    });
    this.event(
      String(row.project_id),
      String(row.node_id),
      null,
      "pipeline_merged",
      `merged ${settlement.mergeSha}`,
      now,
    );
    return Object.freeze([]);
  }

  recordOrphanedPipelineMergeInTransaction(workItemId: string, mergeSha: string): void {
    const row = this.db.prepare(`
      SELECT plan.project_id,node.node_id
      FROM plan_revisions plan
      JOIN work_nodes node ON node.plan_revision_id=plan.plan_revision_id
      WHERE plan.work_item_id=? AND plan.state='confirmed'
      ORDER BY plan.revision DESC,node.created_at,node.node_id
      LIMIT 1
    `).get(workItemId) as Row | undefined;
    if (row === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:pipeline_plan_missing");
    this.event(
      String(row.project_id),
      String(row.node_id),
      null,
      "pipeline_merge_orphaned",
      `Orphaned merge ${mergeSha} for work item ${workItemId}; board settlement failed.`,
    );
  }

  rejectFinalApprovalInTransaction(
    workItemId: string,
    request: RejectFinalApprovalRequest,
    actor: string,
  ): readonly WorkNode[] {
    const row = this.db.prepare(`
      SELECT
        item.state,item.version,plan.project_id,node.node_id,node.title,node.objective,
        node.acceptance_criteria_json,node.stage_template_json,node.state AS node_state
      FROM work_items item
      JOIN plan_revisions plan ON plan.work_item_id=item.work_item_id AND plan.state='confirmed'
      JOIN work_nodes node ON node.plan_revision_id=plan.plan_revision_id
      WHERE item.work_item_id=?
      ORDER BY plan.revision DESC,node.created_at,node.node_id
      LIMIT 1
    `).get(workItemId) as Row | undefined;
    if (row === undefined) throw new TaskBoardError(404, "WORK_ITEM_NOT_FOUND", "Work item was not found");
    if (Number(row.version) !== request.version) {
      throw new TaskBoardError(409, "WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
    }
    if (row.state !== "final_approval") {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.WORK_ITEM_ILLEGAL_TRANSITION,
        "Work item is not awaiting final approval",
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
    this.db.prepare(`
      INSERT INTO tasks(
        task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
        title, objective, acceptance_criteria, workspace_refs_json,
        status, assigned_agent_id, assigned_role, expected_agent_minutes, agent_estimate_minutes,
        estimate_recorded_at, order_key, started_at, ended_at, result, version, created_at, updated_at
      ) VALUES (?, ?, NULL, 'work', NULL, 0, ?, ?, ?, '[]', 'failed', NULL, NULL, 15, NULL,
        NULL, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      taskId,
      projectId,
      `Final approval changes: ${String(row.title)}`.slice(0, 240),
      String(row.objective),
      json<string[]>(row.acceptance_criteria_json).join("\n"),
      orderKey,
      now,
      now,
      request.note,
      now,
      now,
    );
    this.db.prepare(`
      INSERT INTO task_events(event_id, project_id, task_id, actor_type, actor_id, event_type, data_json, created_at)
      VALUES (?, ?, ?, 'system', 'system:final-approval', 'task_created', ?, ?)
    `).run(
      randomUUID(),
      projectId,
      taskId,
      JSON.stringify({ kind: "work", requiresReview: false, status: "failed", workItemId }),
      now,
    );
    const handoff: StageHandoff = Object.freeze({
      apiVersion: "steward.task-board/v1",
      handoffId: `handoff_final_${randomUUID()}`,
      nodeId,
      taskId,
      stage: "implementation",
      outcome: "failed",
      summary: request.note,
      evidence: Object.freeze([request.note]),
      artifactIds: Object.freeze([]),
      acceptanceCriteria: Object.freeze([]),
      blockers: Object.freeze([request.note]),
      recommendedReturnStage: "implementation",
      createdAt: now,
    });
    this.db.prepare("INSERT INTO stage_handoffs VALUES(?,?,?,?,?,?,?)").run(
      handoff.handoffId,
      nodeId,
      taskId,
      handoff.stage,
      handoff.outcome,
      JSON.stringify(handoff),
      now,
    );
    const nodeUpdate = this.db.prepare(`
      UPDATE work_nodes
      SET state='ready',current_stage='implementation',version=version+1,updated_at=?
      WHERE node_id=? AND state='completed'
    `).run(now, nodeId);
    if (Number(nodeUpdate.changes) !== 1) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:final_approval_node_not_completed");
    }
    transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
      workItemId,
      to: workItemStateForNodeStage(this.db, nodeId, "implementation"),
      actorType: "human",
      actorId: actor,
      now,
      currentStage: "implementation",
    });
    this.event(projectId, nodeId, taskId, "final_approval_rejected", request.note, now);
    return Object.freeze(this.nodesForIds([nodeId]));
  }

  private recordPlanningResult(workItemId: string, result: string, updatedAt: string): void {
    const update = this.db.prepare(`
      UPDATE tasks
      SET result=?,version=version+1,updated_at=?
      WHERE task_id=(SELECT task_id FROM work_item_planning_tasks WHERE work_item_id=?)
    `).run(result, updatedAt, workItemId);
    if (Number(update.changes) !== 1) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:work_item_planning_task_missing");
    }
  }

  settleDesignInTransaction(
    taskId: string,
    result: string,
    designRecord: DesignRecordDraft,
    actorId: string,
  ): readonly WorkNode[] {
    const row = this.db.prepare(`
      SELECT link.work_item_id,plan.plan_revision_id,plan.project_id,plan.revision,item.state
      FROM work_item_design_tasks link
      JOIN work_items item ON item.work_item_id=link.work_item_id
      JOIN plan_revisions plan ON plan.work_item_id=link.work_item_id AND plan.state='confirmed'
      WHERE link.task_id=?
      ORDER BY plan.revision DESC
      LIMIT 1
    `).get(taskId) as Row | undefined;
    if (row === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:work_item_design_task_missing");
    const workItemId = String(row.work_item_id);
    const planRevisionId = String(row.plan_revision_id);
    const projectId = String(row.project_id);
    const now = this.now().toISOString();
    this.db.prepare(`
      INSERT INTO design_records(design_record_id,work_item_id,plan_revision_id,payload_json,created_at)
      VALUES (?,?,?,?,?)
    `).run(`design_${randomUUID()}`, workItemId, planRevisionId, JSON.stringify(designRecord), now);
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
    const update = this.db.prepare(`
      UPDATE tasks
      SET result=?,version=version+1,updated_at=?
      WHERE task_id=(SELECT task_id FROM work_item_design_tasks WHERE work_item_id=?)
    `).run(result, updatedAt, workItemId);
    if (Number(update.changes) !== 1) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:work_item_design_task_missing");
    }
  }

  linkAttempt(nodeId: string, taskId: string, stage: WorkflowStage, skillDigests: Readonly<Record<string, string>>): void {
    this.linkAttemptInternal(nodeId, taskId, stage, skillDigests, false);
  }

  linkAttemptInTransaction(nodeId: string, taskId: string, stage: WorkflowStage, skillDigests: Readonly<Record<string, string>>): void {
    this.linkAttemptInternal(nodeId, taskId, stage, skillDigests, true);
  }

  private linkAttemptInternal(
    nodeId: string,
    taskId: string,
    stage: WorkflowStage,
    skillDigests: Readonly<Record<string, string>>,
    inTransaction: boolean,
  ): void {
    const apply = (): void => {
      const attempt = Number(this.db.prepare("SELECT COALESCE(MAX(attempt),0)+1 AS n FROM stage_attempts WHERE node_id=? AND stage=?").get(nodeId, stage)?.n);
      this.db.prepare("INSERT INTO stage_attempts VALUES(?,?,?,?,?,?)").run(`attempt_${randomUUID()}`, nodeId, taskId, stage, attempt, JSON.stringify(skillDigests));
      this.db.prepare("UPDATE work_nodes SET state='active',version=version+1,updated_at=? WHERE node_id=?").run(this.now().toISOString(), nodeId);
    };
    if (inTransaction) apply();
    else this.transaction(apply);
  }

  blockNodeInTransaction(nodeId: string, summary: string): boolean {
    const row = this.db.prepare("SELECT project_id,title FROM work_nodes WHERE node_id=? AND state='ready'").get(nodeId) as Row | undefined;
    if (row === undefined) return false;
    const now = this.now().toISOString();
    const update = this.db.prepare(
      "UPDATE work_nodes SET state='blocked',version=version+1,updated_at=? WHERE node_id=? AND state='ready'",
    ).run(now, nodeId);
    if (Number(update.changes) !== 1) return false;
    this.event(String(row.project_id), nodeId, null, "node_blocked", summary, now);
    return true;
  }

  settleAttemptInTransaction(
    taskId: string,
    outcome: "completed" | "failed" | "interrupted",
    result: string,
    draft?: StageHandoffDraft | null,
    reviewFindings?: readonly ReviewFindingDraft[],
    scopeCheck: AttemptScopeCheckResult | null = null,
  ): readonly WorkNode[] {
    return this.settleAttemptInternal(taskId, outcome, result, draft, reviewFindings, scopeCheck);
  }

  settleMachineVerifyAttemptInTransaction(
    nodeId: string,
    stage: WorkflowStage,
    passed: boolean,
    evidence: MachineVerifyEvidence,
  ): readonly WorkNode[] {
    const attempt = this.db.prepare(`
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
    `).get(nodeId, stage) as Row | undefined;
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
    this.db.prepare(`
      INSERT INTO tasks(
        task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
        title, objective, acceptance_criteria, workspace_refs_json,
        status, assigned_agent_id, assigned_role, expected_agent_minutes, agent_estimate_minutes,
        estimate_recorded_at, order_key, started_at, ended_at, result, version, created_at, updated_at
      ) VALUES (?, ?, NULL, 'work', NULL, 0, ?, ?, ?, '[]', ?, NULL, NULL, 15, NULL,
        NULL, ?, ?, ?, ?, 1, ?, ?)
    `).run(
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
      now,
    );
    this.db.prepare(`
      INSERT INTO task_events(event_id, project_id, task_id, actor_type, actor_id, event_type, data_json, created_at)
      VALUES (?, ?, ?, 'system', 'system:machine-verify', 'task_created', ?, ?)
    `).run(
      randomUUID(),
      projectId,
      taskId,
      JSON.stringify({ kind: "work", requiresReview: false, status: taskStatus, verifyAttemptId }),
      now,
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
    this.db.prepare("INSERT INTO stage_handoffs VALUES(?,?,?,?,?,?,?)")
      .run(handoffId, nodeId, taskId, stage, handoff.outcome, JSON.stringify(handoff), now);

    if (!passed) {
      if (template.includes("implementation") && failedAttemptCount < 3) {
        this.db.prepare(`
          UPDATE work_nodes
          SET state='ready', current_stage='implementation', version=version+1, updated_at=?
          WHERE node_id=?
        `).run(now, nodeId);
        this.setWorkItemStage(String(attempt.plan_revision_id), nodeId, "implementation", now);
        this.event(
          projectId,
          nodeId,
          taskId,
          "stage_retry_ready",
          `${stage} failed; returning to implementation (attempt ${failedAttemptCount + 1} of 3)`,
          now,
        );
        return Object.freeze(this.nodesForIds([nodeId]));
      }
      this.db.prepare("UPDATE work_nodes SET state='blocked',version=version+1,updated_at=? WHERE node_id=?")
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
      this.db.prepare(`
        UPDATE work_nodes SET state='ready',current_stage=?,version=version+1,updated_at=? WHERE node_id=?
      `).run(next, now, nodeId);
      this.setWorkItemStage(String(attempt.plan_revision_id), nodeId, next, now);
      this.event(projectId, nodeId, taskId, "stage_completed", `${stage} completed; ${next} is ready`, now);
      return Object.freeze(this.nodesForIds([nodeId]));
    }

    this.db.prepare(`
      UPDATE work_nodes SET state='completed',current_stage=NULL,version=version+1,updated_at=? WHERE node_id=?
    `).run(now, nodeId);
    this.event(projectId, nodeId, taskId, "node_completed", "Subtask completed", now);
    const newlyReady = (this.db.prepare(`
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
    `).all(nodeId) as Row[]).map((row) => String(row.node_id));
    for (const readyNodeId of newlyReady) {
      this.db.prepare(`
        UPDATE work_nodes
        SET state='ready',current_stage=json_extract(stage_template_json,'$[0]'),version=version+1,updated_at=?
        WHERE node_id=?
      `).run(now, readyNodeId);
      this.event(projectId, readyNodeId, null, "dependency_unblocked", "Dependencies completed", now);
    }

    const planRevisionId = String(attempt.plan_revision_id);
    const unfinished = this.db.prepare(
      "SELECT 1 FROM work_nodes WHERE plan_revision_id=? AND state<>'completed' LIMIT 1",
    ).get(planRevisionId);
    if (unfinished === undefined) {
      const workItem = this.db.prepare("SELECT state,current_stage FROM work_items WHERE work_item_id=?")
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
        now,
      );
    }
    return Object.freeze(this.nodesForIds(newlyReady));
  }

  attemptNeedsSettlementRepair(taskId: string, settledRunId: string): boolean {
    return this.db.prepare(`
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
    `).get(settledRunId, taskId) !== undefined;
  }

  private settleAttemptInternal(
    taskId: string,
    outcome: "completed" | "failed" | "interrupted",
    result: string,
    draft: StageHandoffDraft | null | undefined,
    reviewFindings: readonly ReviewFindingDraft[] | undefined,
    scopeCheck: AttemptScopeCheckResult | null,
  ): readonly WorkNode[] {
    const attempt = this.db.prepare(`
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
    `).get(taskId) as Row | undefined;
    if (!attempt) return Object.freeze([]);
    const now = this.now().toISOString();
    const apply = (): readonly WorkNode[] => {
      const nodeId = String(attempt.node_id); const projectId = String(attempt.project_id);
      const stage = String(attempt.stage) as WorkflowStage;
      const passed = outcome === "completed";
      const supplied = draft ?? null;
      if (
        supplied !== null &&
        (passed && supplied.outcome !== "passed" || !passed && supplied.outcome === "passed")
      ) throw new TaskBoardError(400, "HANDOFF_OUTCOME_MISMATCH", "Handoff outcome contradicts the settled run");
      if (supplied !== null && new Set(supplied.artifactIds).size !== supplied.artifactIds.length) {
        throw new TaskBoardError(400, "HANDOFF_ARTIFACT_INVALID", "Handoff artifact IDs must be unique");
      }
      for (const artifactId of supplied?.artifactIds ?? []) {
        if (!this.db.prepare("SELECT 1 FROM artifacts WHERE artifact_id=? AND project_id=?").get(artifactId, projectId)) {
          throw new TaskBoardError(400, "HANDOFF_ARTIFACT_INVALID", "Handoff references an unavailable artifact");
        }
      }
      const pipelineReview = stage === "verification" && attempt.pipeline_branch !== null;
      if (reviewFindings !== undefined && !pipelineReview) {
        throw new TaskBoardError(
          400,
          TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_FINDINGS_NOT_ALLOWED,
          "Review findings are only allowed for pipeline verification",
        );
      }
      const persistedReviewFindings = (reviewFindings ?? []).map((finding, index): ReviewFinding => {
        const persisted = Object.freeze({
          ...finding,
          findingId: `finding_${String(index).padStart(2, "0")}_${randomUUID()}`,
          nodeId,
          stage,
          round: Number(attempt.attempt),
          blocking: reviewFindingBlocks(finding.category),
          createdAt: now,
        });
        this.db.prepare(`
          INSERT INTO review_findings(
            finding_id,node_id,stage,round,file,line,category,severity,expected,actual,blocking,created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
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
          persisted.createdAt,
        );
        return persisted;
      });
      const blockingReviewFindings = persistedReviewFindings.filter((finding) => finding.blocking);
      const reviewerResult = pipelineReview && supplied !== null;
      if (
        pipelineReview && passed && blockingReviewFindings.length > 0 &&
        (supplied === null || supplied.outcome === "passed")
      ) {
        throw new TaskBoardError(
          400,
          TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_OUTCOME_MISMATCH,
          "A passed review cannot contain blocking findings",
        );
      }
      const failedReview = reviewerResult && outcome === "failed" && supplied?.outcome !== "needs_input";
      if (failedReview && blockingReviewFindings.length === 0) {
        throw new TaskBoardError(
          400,
          TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_FINDINGS_REQUIRED,
          "A failed review requires at least one blocking finding",
        );
      }
      const scopeFailureDetail = passed && stage === "implementation" && attempt.pipeline_branch !== null
        ? scopeCheck === null
          ? "scope check failed"
          : scopeCheck.ok
            ? null
            : "files" in scopeCheck
              ? scopeViolationResult(scopeCheck.files)
              : scopeCheck.error.slice(0, 2_000)
        : null;
      const handoff: StageHandoff = Object.freeze({
        apiVersion: "steward.task-board/v1", handoffId: `handoff_${randomUUID()}`, nodeId, taskId, stage,
        outcome: scopeFailureDetail === null ? supplied?.outcome ?? (passed ? "passed" : "failed") : "failed",
        summary: scopeFailureDetail ?? supplied?.summary ?? result,
        evidence: supplied?.evidence ?? Object.freeze([]), artifactIds: supplied?.artifactIds ?? Object.freeze([]),
        acceptanceCriteria: supplied?.acceptanceCriteria ?? Object.freeze([]),
        blockers: scopeFailureDetail === null
          ? supplied?.blockers ?? Object.freeze(passed ? [] : [result])
          : Object.freeze([scopeFailureDetail]),
        recommendedReturnStage: scopeFailureDetail === null
          ? failedReview
            ? "implementation"
            : supplied?.recommendedReturnStage ?? (passed ? null : stage)
          : stage,
        createdAt: now,
      });
      this.db.prepare("INSERT OR IGNORE INTO stage_handoffs VALUES(?,?,?,?,?,?,?)").run(handoff.handoffId, nodeId, taskId, stage, handoff.outcome, JSON.stringify(handoff), now);
      const parkAttempt = (detail: string): readonly WorkNode[] => {
        this.db.prepare(
          "UPDATE work_nodes SET state='blocked',version=version+1,updated_at=? WHERE node_id=?",
        ).run(now, nodeId);
        const workItemState = String(attempt.work_item_state) as WorkItemState;
        if (!isTerminalWorkItemState(workItemState) && workItemState !== "parked") {
          transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
            workItemId: String(attempt.work_item_id),
            to: "parked",
            actorType: "system",
            actorId: "system:workflow",
            now,
          });
        }
        this.event(projectId, nodeId, taskId, "stage_failed", `${stage} blocked: ${detail.slice(0, 240)}`, now);
        return Object.freeze([]);
      };
      const brightLineDetail = attempt.pipeline_branch !== null && stage === "implementation" && !passed
        ? result.startsWith("BRIGHT_LINE:")
          ? result
          : supplied?.summary.startsWith("BRIGHT_LINE:") === true ? supplied.summary : null
        : null;
      if (brightLineDetail !== null) return parkAttempt(brightLineDetail);
      if (scopeFailureDetail !== null) return parkAttempt(scopeFailureDetail);
      if (!passed) {
        const returnStage = failedReview
          ? handoff.recommendedReturnStage
          : supplied === null && pipelineReview
            ? handoff.recommendedReturnStage
            : supplied?.recommendedReturnStage ?? null;
        const attemptNumber = Number(attempt.attempt);
        const template = json<WorkflowStage[]>(attempt.stage_template_json);
        const maxAttempts = stage === "verification" && attempt.pipeline_branch !== null ? 4 : 3;
        if (returnStage !== null && template.includes(returnStage) && attemptNumber < maxAttempts) {
          this.db.prepare("UPDATE work_nodes SET state='ready',current_stage=?,version=version+1,updated_at=? WHERE node_id=?").run(returnStage, now, nodeId);
          this.setWorkItemStage(String(attempt.plan_revision_id), nodeId, returnStage, now);
          this.event(projectId, nodeId, taskId, "stage_retry_ready", `${stage} failed; returning to ${returnStage} (attempt ${attemptNumber + 1} of ${maxAttempts})`, now);
          return Object.freeze(this.nodesForIds([nodeId]));
        }
        this.db.prepare("UPDATE work_nodes SET state='blocked',version=version+1,updated_at=? WHERE node_id=?").run(now, nodeId);
        if (attemptNumber >= maxAttempts) {
          const plan = this.db.prepare(`
            SELECT plan.work_item_id, work_item.state
            FROM plan_revisions plan
            JOIN work_items work_item ON work_item.work_item_id = plan.work_item_id
            WHERE plan.plan_revision_id = ?
          `
          ).get(String(attempt.plan_revision_id)) as Row | undefined;
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
        this.db.prepare("UPDATE work_nodes SET state='ready',current_stage=?,version=version+1,updated_at=? WHERE node_id=?").run(next, now, nodeId);
        this.setWorkItemStage(String(attempt.plan_revision_id), nodeId, next, now);
        this.event(projectId, nodeId, taskId, "stage_completed", `${stage} completed; ${next} is ready`, now);
        return Object.freeze(this.nodesForIds([nodeId]));
      }
      this.db.prepare("UPDATE work_nodes SET state='completed',current_stage=NULL,version=version+1,updated_at=? WHERE node_id=?").run(now, nodeId);
      this.event(projectId, nodeId, taskId, "node_completed", "Subtask completed", now);
      const newlyReady = (this.db.prepare(`SELECT n.node_id FROM work_nodes n
        WHERE n.state='pending' AND EXISTS(SELECT 1 FROM work_node_dependencies d WHERE d.node_id=n.node_id AND d.dependency_node_id=?)
        AND NOT EXISTS(SELECT 1 FROM work_node_dependencies d JOIN work_nodes dependency ON dependency.node_id=d.dependency_node_id WHERE d.node_id=n.node_id AND dependency.state<>'completed')`).all(nodeId) as Row[]).map((row) => String(row.node_id));
      for (const id of newlyReady) {
        this.db.prepare("UPDATE work_nodes SET state='ready',current_stage=json_extract(stage_template_json,'$[0]'),version=version+1,updated_at=? WHERE node_id=?").run(now, id);
        this.event(projectId, id, null, "dependency_unblocked", "Dependencies completed", now);
      }
      if (newlyReady.length > 0) {
        const nextStage = this.db.prepare("SELECT current_stage FROM work_nodes WHERE node_id=?").get(newlyReady[0]!)?.current_stage;
        if (nextStage !== null && nextStage !== undefined) {
          this.setWorkItemStage(String(attempt.plan_revision_id), newlyReady[0]!, String(nextStage) as WorkflowStage, now);
        }
      }
      const planRevisionId = String(attempt.plan_revision_id);
      const unfinished = this.db.prepare(
        "SELECT 1 FROM work_nodes WHERE plan_revision_id=? AND state<>'completed' LIMIT 1",
      ).get(planRevisionId);
      if (!unfinished) {
        const plan = this.db.prepare("SELECT work_item_id,objective FROM plan_revisions WHERE plan_revision_id=?").get(planRevisionId) as Row;
        const workItem = this.db.prepare(
          "SELECT state,current_stage FROM work_items WHERE work_item_id = ?",
        ).get(String(plan.work_item_id)) as Row | undefined;
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
        this.event(projectId, null, taskId, "workflow_completed", `Completed: ${String(plan.objective).slice(0, 240)}`, now);
      }
      return Object.freeze(this.nodesForIds(newlyReady));
    };
    return apply();
  }

  nodesForIds(ids: readonly string[]): WorkNode[] {
    if (ids.length === 0) return [];
    const plans = new Set((this.db.prepare(`SELECT DISTINCT plan_revision_id FROM work_nodes WHERE node_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[]).map((row) => String(row.plan_revision_id)));
    return [...plans].flatMap((plan) => this.nodes(plan)).filter((node) => ids.includes(node.nodeId));
  }

  private setWorkItemStage(
    planRevisionId: string,
    nodeId: string,
    stage: WorkflowStage,
    updatedAt: string,
  ): void {
    const plan = this.db.prepare(`
      SELECT plan.work_item_id, work_item.state, work_item.current_stage
      FROM plan_revisions plan
      JOIN work_items work_item ON work_item.work_item_id = plan.work_item_id
      WHERE plan.plan_revision_id = ?
    `
    ).get(planRevisionId) as Row | undefined;
    if (plan === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:workflow_plan_work_item");
    if (isTerminalWorkItemState(String(plan.state) as WorkItemState)) return;
    const currentState = String(plan.state) as WorkItemState;
    const mappedState = workItemStateForNodeStage(this.db, nodeId, stage);
    const parkedWithOpenQuestions = currentState === "parked" && this.db.prepare(`
      SELECT 1
      FROM questions question
      LEFT JOIN work_item_planning_tasks planning ON planning.task_id = question.task_id
      LEFT JOIN stage_attempts attempt ON attempt.task_id = question.task_id
      LEFT JOIN work_nodes node ON node.node_id = attempt.node_id
      LEFT JOIN plan_revisions question_plan ON question_plan.plan_revision_id = node.plan_revision_id
      WHERE question.status = 'open'
        AND COALESCE(planning.work_item_id, question_plan.work_item_id) = ?
      LIMIT 1
    `).get(String(plan.work_item_id)) !== undefined;
    transitionWorkItemInTransaction(workItemTransitionStoreForDatabase(this.db), {
      workItemId: String(plan.work_item_id),
      to: parkedWithOpenQuestions
        ? currentState
        : currentState === "plan_approval" && mappedState === "planning" ? currentState : mappedState,
      actorType: "system",
      actorId: "system:workflow",
      now: updatedAt,
      currentStage: stage,
      // Touch only when the stage genuinely moved — an unchanged stage must
      // not bump the version and spuriously invalidate concurrent CAS holders.
      ...(parkedWithOpenQuestions && stage !== plan.current_stage ? { touch: true } : {}),
    });
  }

  nodes(planId: string): readonly WorkNode[] {
    const rows = this.db.prepare(`SELECT n.*, COALESCE(json_group_array(d.dependency_node_id) FILTER(WHERE d.dependency_node_id IS NOT NULL),'[]') dependencies
      FROM work_nodes n LEFT JOIN work_node_dependencies d ON d.node_id=n.node_id WHERE n.plan_revision_id=? GROUP BY n.node_id ORDER BY n.created_at,n.node_id`).all(planId) as Row[];
    return Object.freeze(rows.map((row) => Object.freeze({
      apiVersion: "steward.task-board/v1", nodeId: String(row.node_id), planRevisionId: String(row.plan_revision_id), projectId: String(row.project_id),
      title: String(row.title), objective: String(row.objective), acceptanceCriteria: Object.freeze(json<string[]>(row.acceptance_criteria_json)),
      dependencyNodeIds: Object.freeze(json<string[]>(row.dependencies)), stageTemplate: Object.freeze(json<WorkflowStage[]>(row.stage_template_json)),
      currentStage: row.current_stage as WorkflowStage | null, state: row.state as WorkNode["state"], version: Number(row.version),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    })));
  }

  snapshot(projectId: string): ProjectWorkflowSnapshot {
    const plans = (this.db.prepare("SELECT * FROM plan_revisions WHERE project_id=? ORDER BY revision DESC").all(projectId) as Row[]).map(planFromRow);
    const seenWorkItems = new Set<string>();
    const latestPlans = plans.filter((plan) => {
      if (seenWorkItems.has(plan.workItemId)) return false;
      seenWorkItems.add(plan.workItemId);
      return true;
    });
    const nodes = latestPlans.flatMap((plan) => this.nodes(plan.planRevisionId));
    const handoffs = (this.db.prepare("SELECT payload_json FROM stage_handoffs h JOIN work_nodes n ON n.node_id=h.node_id WHERE n.project_id=? ORDER BY h.created_at").all(projectId) as Row[]).map((row) => Object.freeze(json<StageHandoff>(row.payload_json)));
    const events = (this.db.prepare("SELECT * FROM project_events WHERE project_id=? ORDER BY sequence DESC LIMIT 500").all(projectId) as Row[]).map((row) => Object.freeze({ apiVersion: "steward.task-board/v1" as const, sequence: Number(row.sequence), eventId: String(row.event_id), projectId: String(row.project_id), nodeId: row.node_id === null ? null : String(row.node_id), taskId: row.task_id === null ? null : String(row.task_id), eventType: String(row.event_type), summary: String(row.summary), createdAt: String(row.created_at) }));
    return Object.freeze({ plans: Object.freeze(plans), nodes: Object.freeze(nodes), handoffs: Object.freeze(handoffs), events: Object.freeze(events) });
  }

  event(projectId: string, nodeId: string | null, taskId: string | null, type: string, summary: string, createdAt = this.now().toISOString()): void {
    const eventId = `event_${randomUUID()}`;
    this.db.prepare("INSERT INTO project_events(event_id,project_id,node_id,task_id,event_type,summary,created_at) VALUES(?,?,?,?,?,?,?)").run(eventId, projectId, nodeId, taskId, type, summary, createdAt);
    const sequence = Number((this.db.prepare("SELECT sequence FROM project_events WHERE event_id=?").get(eventId) as Row).sequence);
    this.queueEvent?.(Object.freeze({
      apiVersion: "steward.task-board/v1", sequence, eventId, projectId, nodeId, taskId,
      eventType: type, summary, createdAt,
    }));
  }
}
