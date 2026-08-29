import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  SCOPE_HOLD_SUMMARY_PREFIX,
  TASK_BOARD_API_VERSION,
  TASK_BOARD_ERROR_CODES,
  pipelineTemplateShape,
  type ApprovePipelineMergeRequest,
  type ClaimRunResult,
  type ConfirmPlanRevisionRequest,
  type CreatePlanRevisionRequest,
  type CreateProjectArtifactRequest,
  type CreateProjectRequest,
  type Project,
  type ProjectArtifact,
  type ProjectEvent,
  type PipelineSummary,
  type RejectFinalApprovalRequest,
  type RejectPlanRevisionRequest,
  type SettleRunRequest,
  type WorkItem,
  type WorkItemState,
  type WorkNode,
} from "#shared/task-board-contract";
import { parseDesignRecordDraft } from "#shared/task-board-contract/validate";
import { ArtifactStore } from "../persistence/artifacts.js";
import { projectFromRow, reviewFindingFromRow, type Row } from "../persistence/rows.js";
import {
  TransparentWorkflow,
  type AttemptScopeCheckResult,
  type ProjectWorkflowSnapshot,
  type RejectWorkflowTransactionResult,
  type WorkflowGitRunner,
} from "../persistence/workflow.js";
import { SkillRegistry } from "../skills.js";
import { PENDING_LIVE_WAKEUP_PREDICATE_SQL } from "../persistence/workflow.js";
import { exactNow } from "../persistence/timestamps.js";
import { RETIRED_WAKEUP_EVENT_PREFIX } from "../persistence/workflow.js";
import type { AutomationCollaborator } from "./automation.js";
import type { TaskBoardRuntime } from "./runtime.js";
import type { TasksCollaborator } from "./tasks.js";
import type { NotificationsCollaborator } from "./notifications.js";
import { BoardPauseCollaborator } from "./board-pause.js";
import { createLazyExecutorInTransaction } from "./agent-identities.js";
import {
  VerifyAttemptsCollaborator,
  type VerifyAttemptsDependencies,
} from "./verify-attempts.js";
import {
  inspectPipelineBranchSync,
  pipelineMidRunAssumptions,
  type PipelineInspection,
} from "./pipeline-inspection.js";
import {
  inspectPipelineBaseAdvance,
  mergePipelineBranch,
  resolvePipelineBranchTip,
  type MergePipelineResult,
} from "./merge-executor.js";
import { TaskBoardError } from "../errors.js";
import { declaredScopesOverlap } from "./scope-check.js";
import {
  decompositionFamilyTouchesProjectSql,
  decompositionReadinessBlocker,
} from "./decomposition-readiness.js";
import {
  transitionWorkItemInTransaction,
  workItemStateForNodeStage,
  workItemStateOwnsWorkflowExecution,
} from "./work-item-transitions.js";

const WORKFLOW_RECONCILIATION_BATCH_SIZE = 500;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BYTES = 1024 * 1024;
const VERIFIED_SHA_DETAIL = /^verified-sha:([0-9a-f]{40})$/u;

export const runWorkflowGit: WorkflowGitRunner = (arguments_) => execFileSync("git", [...arguments_], {
  encoding: "utf8",
  timeout: GIT_TIMEOUT_MS,
  maxBuffer: GIT_MAX_BYTES,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
});

export type ConfirmWorkflowResult = ProjectWorkflowSnapshot & Readonly<{
  outcome?: "parked_hazardous" | "designing";
}>;

type ProjectsVerifyDependencies = Omit<
  VerifyAttemptsDependencies,
  "git" | "settleInTransaction" | "activateNodes" | "reconcileProject"
>;
export type PipelineMergeExecutor = typeof mergePipelineBranch;

type PipelineMergeAuthorization = Readonly<{
  actorId: string;
  actorType: "human" | "system";
  refId: string | null;
}>;

type PhasedChildBaseRefresh = Readonly<{
  workItemId: string;
  projectId: string;
  baseSha: string;
}>;

export class ProjectsCollaborator {
  readonly #workflow: TransparentWorkflow;
  readonly #artifacts: ArtifactStore;
  readonly #verifyAttempts: VerifyAttemptsCollaborator;
  readonly #boardPause: BoardPauseCollaborator;
  // Process-local by ruling: one task-board process owns a repository/database pair.
  readonly #finalApprovalLocks = new Map<string, Promise<void>>();
  #startDesignInTransaction: ((workItemId: string) => void) | undefined;
  #decompositionReconciliationActive = false;

  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly automation: AutomationCollaborator,
    private readonly tasks: TasksCollaborator,
    private readonly git: WorkflowGitRunner = runWorkflowGit,
    verifyDependencies: ProjectsVerifyDependencies = {},
    private readonly mergePipeline: PipelineMergeExecutor = mergePipelineBranch,
    private readonly notifications?: NotificationsCollaborator,
    boardPause?: BoardPauseCollaborator,
  ) {
    this.#workflow = new TransparentWorkflow(
      runtime.store.db,
      new SkillRegistry(resolve("config/skills.md")),
      runtime.config.now,
      (operation) => runtime.store.transaction(operation),
      (event) => runtime.store.afterCommit(() => this.emitProjectEvent(event)),
      git,
      (input) => runtime.insertGateActionInTransaction(input),
    );
    this.#artifacts = new ArtifactStore(runtime.store.db, runtime.config.artifactRoot, runtime.config.now);
    this.#boardPause = boardPause ?? new BoardPauseCollaborator(runtime);
    this.#verifyAttempts = new VerifyAttemptsCollaborator(runtime, {
      ...verifyDependencies,
      git,
      settleInTransaction: (nodeId, stage, passed, evidence) =>
        this.#workflow.settleMachineVerifyAttemptInTransaction(nodeId, stage, passed, evidence),
      activateNodes: (nodes) => this.activateWorkflowNodes(nodes),
      reconcileProject: (projectId) => this.reconcileWorkflowsBestEffort(projectId),
    });
  }

  setStartDesignInTransaction(startDesignInTransaction: (workItemId: string) => void): void {
    this.#startDesignInTransaction = startDesignInTransaction;
  }

  listProjects(): readonly Project[] {
    return Object.freeze(this.runtime.store.db.prepare("SELECT * FROM projects ORDER BY created_at, project_id").all().map(projectFromRow));
  }

  proposeWorkflow(request: CreatePlanRevisionRequest): ProjectWorkflowSnapshot {
    return this.#workflow.propose(request, this.runtime.config.humanPrincipal);
  }

  proposeWorkflowForAgentInTransaction(request: CreatePlanRevisionRequest, agentId: string): ProjectWorkflowSnapshot {
    return this.#workflow.proposeInTransaction(request, agentId);
  }

  projectWorkflow(projectId: string): ProjectWorkflowSnapshot {
    this.runtime.requireProject(projectId);
    return this.#workflow.snapshot(projectId);
  }

  async createArtifact(projectId: string, request: CreateProjectArtifactRequest): Promise<ProjectArtifact> {
    const artifact = this.#artifacts.create(projectId, request, this.runtime.config.humanPrincipal);
    this.#workflow.event(projectId, artifact.nodeId, artifact.taskId, "artifact_created", artifact.caption);
    return artifact;
  }

  recordOnboardingGapReportInTransaction(input: Readonly<{
    projectId: string;
    nodeId: string;
    taskId: string;
    content: string;
    caption: string;
    actorId: string;
  }>): ProjectArtifact {
    const artifact = this.#artifacts.create(input.projectId, {
      nodeId: input.nodeId,
      taskId: input.taskId,
      mediaType: "text/markdown",
      caption: input.caption,
      contentBase64: Buffer.from(input.content, "utf8").toString("base64"),
    }, input.actorId);
    this.#workflow.event(input.projectId, input.nodeId, input.taskId, "artifact_created", artifact.caption);
    return artifact;
  }

  listArtifacts(projectId: string): readonly ProjectArtifact[] {
    this.runtime.requireProject(projectId);
    return this.#artifacts.list(projectId);
  }

  artifactContent(artifactId: string): Promise<{ artifact: ProjectArtifact; bytes: Buffer }> {
    return this.#artifacts.content(artifactId);
  }

  listProjectEvents(projectId: string, after = 0): readonly ProjectEvent[] {
    this.runtime.requireProject(projectId);
    return Object.freeze((this.runtime.store.db.prepare(
      "SELECT * FROM project_events WHERE project_id=? AND sequence>? ORDER BY sequence LIMIT 500",
    ).all(projectId, after) as Row[]).map((row) => Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      sequence: Number(row.sequence),
      eventId: String(row.event_id),
      projectId: String(row.project_id),
      nodeId: row.node_id === null ? null : String(row.node_id),
      taskId: row.task_id === null ? null : String(row.task_id),
      eventType: String(row.event_type),
      summary: String(row.summary),
      createdAt: String(row.created_at),
    })));
  }

  subscribeProjectEvents(projectId: string, listener: (event: ProjectEvent) => void): () => void {
    this.runtime.requireProject(projectId);
    this.runtime.projectEvents.on(projectId, listener);
    return () => this.runtime.projectEvents.off(projectId, listener);
  }

  confirmWorkflow(
    planRevisionId: string,
    request: ConfirmPlanRevisionRequest,
    startDesignInTransaction?: (workItemId: string) => void,
  ): ConfirmWorkflowResult {
    const baseShas = this.#workflow.pipelineBaseShasForConfirm(planRevisionId, request);
    const confirmation = this.#workflow.confirm(
      planRevisionId,
      request,
      this.runtime.config.humanPrincipal,
      baseShas.parentBaseSha,
      baseShas.childBaseShas,
      startDesignInTransaction ?? this.#startDesignInTransaction,
    );
    for (const node of confirmation.readyNodes) this.activateWorkflowNode(node);
    const projectId = confirmation.readyNodes[0]?.projectId
      ?? String(this.runtime.store.db.prepare("SELECT project_id FROM plan_revisions WHERE plan_revision_id=?").get(planRevisionId)?.project_id);
    if (confirmation.outcome === undefined) this.reconcileWorkflowsBestEffort(projectId);
    const workflow = this.#workflow.snapshot(projectId);
    return Object.freeze({
      ...workflow,
      ...(confirmation.outcome === undefined ? {} : { outcome: confirmation.outcome }),
    });
  }

  rejectWorkflowInTransaction(
    planRevisionId: string,
    request: RejectPlanRevisionRequest,
  ): RejectWorkflowTransactionResult {
    return this.#workflow.rejectInTransaction(planRevisionId, request, this.runtime.config.humanPrincipal);
  }

  pipelineSummary(workItemId: string): PipelineSummary {
    this.runtime.requireWorkItem(workItemId);
    const row = this.runtime.store.db.prepare(`
      SELECT
        item.pipeline_branch,item.base_sha,project.repo_path,
        plan.assumptions_json,plan.acceptance_criteria_json,plan.declared_scope_json,
        plan.criterion_checks_json,
        (SELECT design.payload_json FROM design_records design
          WHERE design.work_item_id=item.work_item_id
        ) AS design_record_json
      FROM work_items item
      JOIN plan_revisions plan ON plan.work_item_id=item.work_item_id AND plan.state='confirmed'
      JOIN projects project ON project.project_id=plan.project_id
      WHERE item.work_item_id=?
      ORDER BY plan.revision DESC
      LIMIT 1
    `).get(workItemId) as Row | undefined;
    if (row === undefined || row.pipeline_branch === null || row.base_sha === null) {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_REPO_UNAVAILABLE,
        "Work item has no pipeline branch",
      );
    }
    if (row.declared_scope_json === null) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:pipeline_plan_record");
    }
    const repoPath = String(row.repo_path);
    const branch = String(row.pipeline_branch);
    const baseSha = String(row.base_sha);
    const declaredScope = Object.freeze(JSON.parse(String(row.declared_scope_json)) as string[]);
    let inspection: PipelineInspection;
    try {
      inspection = inspectPipelineBranchSync({
        repoPath,
        baseSha,
        branch,
        declaredScope,
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

    const assumptions = Object.freeze(JSON.parse(String(row.assumptions_json)) as string[]);
    const midRunAssumptions = pipelineMidRunAssumptions(this.runtime.store.db, workItemId);
    const criteria = JSON.parse(String(row.acceptance_criteria_json)) as string[];
    const criterionChecks = JSON.parse(String(row.criterion_checks_json ?? "[]")) as Array<{
      criterion: string;
      check: string;
    }>;
    const machineCheckedCriteria = new Set(criterionChecks.map((entry) => entry.criterion));
    const findings = Object.freeze((this.runtime.store.db.prepare(`
      SELECT finding.*
      FROM plan_revisions plan
      JOIN work_nodes node ON node.plan_revision_id=plan.plan_revision_id
      JOIN review_findings finding ON finding.node_id=node.node_id
      WHERE plan.work_item_id=? AND plan.state='confirmed'
      ORDER BY finding.round,finding.created_at,finding.finding_id
    `).all(workItemId) as Row[]).map(reviewFindingFromRow));
    const designRecord = row.design_record_json === null
      ? null
      : parseDesignRecordDraft(JSON.parse(String(row.design_record_json)));
    return Object.freeze({
      commits: inspection.commits,
      diffstat: inspection.diffstat,
      filesTouched: Object.freeze(inspection.filesTouched.map((file) => file.path)),
      declaredScope,
      scopeOk: inspection.scopeOk,
      assumptions,
      midRunAssumptions,
      verify: this.#verifyAttempts.listForWorkItem(workItemId),
      criteria: Object.freeze(criteria.filter((criterion) => !machineCheckedCriteria.has(criterion))),
      criterionChecks: Object.freeze(criterionChecks),
      findings,
      designRecord,
    });
  }

  approvePipelineMerge(workItemId: string, request: ApprovePipelineMergeRequest): Promise<WorkItem> {
    const workItem = this.runtime.requireWorkItem(workItemId);
    if (this.isDecomposedParent(workItem)) {
      return this.approveUnphasedParent(workItemId, request);
    }
    return this.approvePipelineMergeAuthorized(workItemId, request, {
      actorId: this.runtime.config.humanPrincipal,
      actorType: "human",
      refId: null,
    });
  }

  private approvePipelineMergeAuthorized(
    workItemId: string,
    request: ApprovePipelineMergeRequest,
    authorization: PipelineMergeAuthorization,
    reconcileAfter = true,
  ): Promise<WorkItem> {
    return this.withFinalApprovalLock(workItemId, () =>
      this.approveSinglePipelineMerge(workItemId, request, authorization, reconcileAfter));
  }

  private approveSinglePipelineMerge(
    workItemId: string,
    request: ApprovePipelineMergeRequest,
    authorization: PipelineMergeAuthorization,
    reconcileAfter: boolean,
  ): WorkItem {
    // Git runs before the final settlement transaction and never while the store has an open transaction.
    const context = this.pipelineMergeContext(workItemId, request.version);
    let branchTip: string;
    try {
      branchTip = resolvePipelineBranchTip({
        repoPath: context.repoPath,
        branch: context.branch,
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
    const verifiedSha = context.verifiedSha;
    if (verifiedSha === null || branchTip !== verifiedSha) {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_BRANCH_MOVED,
        "branch advanced since verification — request changes to re-verify",
      );
    }
    let merge: MergePipelineResult;
    try {
      merge = this.mergePipeline({
        repoPath: context.repoPath,
        branch: context.branch,
        branchSha: branchTip,
        baseSha: context.baseSha,
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
    if (merge.kind === "repo_busy") {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_REPO_BUSY,
        "The pipeline repository is busy; check out a clean non-task merge target and retry",
      );
    }
    if (merge.kind === "diverged") {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_BASE_DIVERGED,
        `The pipeline base diverged from the current merge target: ${merge.detail}`,
      );
    }
    if (merge.kind === "empty") {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_BRANCH_EMPTY,
        "nothing to merge",
      );
    }
    let readyNodes: readonly WorkNode[];
    try {
      readyNodes = this.runtime.store.transaction(() => {
        const nodes = this.#workflow.settlePipelineMergeInTransaction(
          workItemId,
          request.version,
          merge,
          authorization.actorId,
          verifiedSha,
          authorization.actorType,
          authorization.refId,
        );
        const settled = this.runtime.requireWorkItem(workItemId);
        if (settled.state !== "final_approval" && settled.state !== "merged") {
          this.withdrawPromotedParentForChildInTransaction({
            childWorkItemId: workItemId,
            actorId: "system:parent-coordination",
            now: exactNow(this.runtime.config.now),
            dedupeToken: `reverify:${request.version}`,
          });
        }
        return nodes;
      });
    } catch (error) {
      if (merge.kind !== "merged") throw error;
      this.runtime.store.transaction(() => {
        this.#workflow.recordOrphanedPipelineMergeInTransaction(workItemId, merge.mergeSha);
      });
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_MERGE_SETTLEMENT_CONFLICT,
        `Merge ${merge.mergeSha} landed, but the work item could not be settled; operator recovery is required`,
        { cause: error },
      );
    }
    this.activateWorkflowNodes(readyNodes);
    if (reconcileAfter) this.reconcileWorkflowsBestEffort(context.projectId);
    return this.runtime.requireWorkItem(workItemId);
  }

  private approveUnphasedParent(
    workItemId: string,
    request: ApprovePipelineMergeRequest,
  ): Promise<WorkItem> {
    return this.withFinalApprovalLock(workItemId, async () => {
      const parent = this.runtime.requireWorkItem(workItemId);
      if (parent.version !== request.version) {
        throw new TaskBoardError(409, "WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
      }
      if (parent.state !== "final_approval") {
        throw new TaskBoardError(
          409,
          TASK_BOARD_ERROR_CODES.WORK_ITEM_ILLEGAL_TRANSITION,
          "Parent work item is not awaiting final approval",
        );
      }
      const orderedChildren = this.childrenInDependencyOrder(workItemId);
      if (orderedChildren.length === 0 || this.decompositionMergePolicy(orderedChildren) !== "parent_approval") {
        throw new TaskBoardError(
          409,
          TASK_BOARD_ERROR_CODES.WORK_ITEM_ILLEGAL_TRANSITION,
          "Only an unphased decomposed parent can fan out final approval",
        );
      }
      const authorization: PipelineMergeAuthorization = Object.freeze({
        actorId: this.runtime.config.humanPrincipal,
        actorType: "human",
        refId: null,
      });
      const familyProjectIds = new Set((this.runtime.store.db.prepare(`
        SELECT project.project_id
        FROM projects project
        WHERE ${decompositionFamilyTouchesProjectSql("?", "project.project_id")}
        ORDER BY project.project_id
      `).all(workItemId, workItemId) as Row[]).map((row) => String(row.project_id)));
      for (const child of orderedChildren) {
        const current = this.runtime.requireWorkItem(child.workItemId);
        if (current.state === "merged") continue;
        if (current.state !== "final_approval") {
          throw new TaskBoardError(
            409,
            "PARENT_CHILDREN_NOT_READY",
            `Child ${current.workItemId} is not awaiting final approval`,
          );
        }
        const merged = await this.approvePipelineMergeAuthorized(
          current.workItemId,
          { version: current.version },
          authorization,
          false,
        );
        if (merged.state !== "merged") {
          throw new TaskBoardError(409, "PARENT_CHILD_MERGE_CONFLICT", `Child ${merged.workItemId} did not merge`);
        }
      }
      this.runtime.store.transaction(() => {
        this.#workflow.settleParentCompletionInTransaction(
          workItemId,
          request.version,
          orderedChildren.map((child) => child.workItemId),
          this.runtime.config.humanPrincipal,
          "human",
        );
      });
      for (const projectId of familyProjectIds) this.reconcileWorkflowsBestEffort(projectId);
      return this.runtime.requireWorkItem(workItemId);
    });
  }

  /** Phases, not change shape, select the decomposition merge policy. */
  private decompositionMergePolicy(
    children: readonly Readonly<{ phase: string | null }>[],
  ): "phased_auto_merge" | "parent_approval" {
    const phased = children.filter((child) => child.phase !== null).length;
    if (phased === 0) return "parent_approval";
    if (phased === children.length) return "phased_auto_merge";
    throw new Error("TASK_BOARD_DATABASE_CORRUPT:mixed_child_phases");
  }

  private isDecomposedParent(row: Pick<WorkItem, "workItemId" | "pipelineBranch">): boolean {
    return row.pipelineBranch === null && this.runtime.store.db.prepare(
      "SELECT 1 FROM work_items WHERE parent_work_item_id=? LIMIT 1",
    ).get(row.workItemId) !== undefined;
  }

  private childrenInDependencyOrder(parentWorkItemId: string): readonly Readonly<{
    workItemId: string;
    phase: string | null;
    ordinal: number;
  }>[] {
    const rows = this.runtime.store.db.prepare(`
      SELECT work_item_id,phase,child_ordinal
      FROM work_items
      WHERE parent_work_item_id=?
        AND state NOT IN ('abandoned','dead_letter')
      ORDER BY child_ordinal,work_item_id
    `).all(parentWorkItemId) as Row[];
    const children = rows.map((row) => Object.freeze({
      workItemId: String(row.work_item_id),
      phase: row.phase === null ? null : String(row.phase),
      ordinal: Number(row.child_ordinal),
    }));
    const byId = new Map(children.map((child) => [child.workItemId, child] as const));
    const dependencyRows = this.runtime.store.db.prepare(`
      SELECT dependency.work_item_id,dependency.depends_on_work_item_id
      FROM work_item_dependencies dependency
      JOIN work_items child ON child.work_item_id=dependency.work_item_id
      JOIN work_items predecessor ON predecessor.work_item_id=dependency.depends_on_work_item_id
      WHERE child.parent_work_item_id=?
        AND child.state NOT IN ('abandoned','dead_letter')
        AND predecessor.state NOT IN ('abandoned','dead_letter')
      ORDER BY child.child_ordinal,dependency.depends_on_work_item_id
    `).all(parentWorkItemId) as Row[];
    const remaining = new Map<string, number>(children.map((child) => [child.workItemId, 0]));
    const dependents = new Map<string, string[]>();
    for (const dependency of dependencyRows) {
      const childId = String(dependency.work_item_id);
      const predecessorId = String(dependency.depends_on_work_item_id);
      if (!byId.has(predecessorId)) throw new Error("TASK_BOARD_DATABASE_CORRUPT:cross_parent_dependency");
      remaining.set(childId, (remaining.get(childId) ?? 0) + 1);
      const list = dependents.get(predecessorId) ?? [];
      list.push(childId);
      dependents.set(predecessorId, list);
    }
    const ready = children.filter((child) => remaining.get(child.workItemId) === 0);
    const ordered: typeof children = [];
    while (ready.length > 0) {
      ready.sort((left, right) => left.ordinal - right.ordinal || left.workItemId.localeCompare(right.workItemId));
      const next = ready.shift()!;
      ordered.push(next);
      for (const dependentId of dependents.get(next.workItemId) ?? []) {
        const count = (remaining.get(dependentId) ?? 0) - 1;
        remaining.set(dependentId, count);
        if (count === 0) ready.push(byId.get(dependentId)!);
      }
    }
    if (ordered.length !== children.length) throw new Error("TASK_BOARD_DATABASE_CORRUPT:work_item_dependency_cycle");
    return Object.freeze(ordered);
  }

  rejectFinalApproval(workItemId: string, request: RejectFinalApprovalRequest): Promise<WorkItem> {
    return this.withFinalApprovalLock(workItemId, () => {
      if (this.isDecomposedParent(this.runtime.requireWorkItem(workItemId))) {
        const readyNodes: WorkNode[] = [];
        const rejected = this.runtime.store.transaction(() => {
          const current = this.runtime.requireWorkItem(workItemId);
          if (current.version !== request.version) {
            throw new TaskBoardError(409, "WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
          }
          if (current.state !== "final_approval") {
            throw new TaskBoardError(
              409,
              TASK_BOARD_ERROR_CODES.WORK_ITEM_ILLEGAL_TRANSITION,
              "Parent work item is not awaiting final approval",
            );
          }
          const plan = this.runtime.store.db.prepare(`
            SELECT plan_revision_id
            FROM plan_revisions
            WHERE work_item_id=? AND state='confirmed'
            ORDER BY revision DESC
            LIMIT 1
          `).get(workItemId) as Row | undefined;
          if (plan === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:confirmed_parent_plan_missing");
          const children = this.runtime.store.db.prepare(`
            SELECT work_item_id,state,version
            FROM work_items
            WHERE parent_work_item_id=?
            ORDER BY child_ordinal,created_at,work_item_id
          `).all(workItemId) as Row[];
          for (const child of children) {
            if (child.state !== "final_approval") continue;
            readyNodes.push(...this.#workflow.rejectFinalApprovalInTransaction(
              String(child.work_item_id),
              { version: Number(child.version), note: request.note },
              this.runtime.config.humanPrincipal,
            ));
          }
          transitionWorkItemInTransaction(this.runtime.store, {
            workItemId,
            to: "coordinating",
            actorType: "human",
            actorId: this.runtime.config.humanPrincipal,
            now: exactNow(this.runtime.config.now),
            currentStage: null,
          });
          this.runtime.insertGateActionInTransaction({
            workItemId,
            gate: "final_reject",
            actorId: this.runtime.config.humanPrincipal,
            planRevisionId: String(plan.plan_revision_id),
            verifiedSha: null,
            mergeSha: null,
            refId: null,
            note: request.note,
          });
          return this.runtime.requireWorkItem(workItemId);
        });
        this.activateWorkflowNodes(readyNodes);
        return rejected;
      }
      const readyNodes = this.runtime.store.transaction(() => {
        const nodes = this.#workflow.rejectFinalApprovalInTransaction(
          workItemId,
          request,
          this.runtime.config.humanPrincipal,
        );
        this.withdrawPromotedParentForChildInTransaction({
          childWorkItemId: workItemId,
          actorId: "system:parent-coordination",
          now: exactNow(this.runtime.config.now),
          dedupeToken: `reject:${request.version}`,
        });
        return nodes;
      });
      this.activateWorkflowNodes(readyNodes);
      return this.runtime.requireWorkItem(workItemId);
    });
  }

  withdrawFinalApprovalForBaseAdvance(
    input: Readonly<{
      workItemId: string;
      expectedVersion: number;
      expectedBaseSha: string;
      head: string;
      note: string;
      now: string;
    }>,
  ): boolean {
    const locked = this.withFinalApprovalLockIfAvailable(input.workItemId, () =>
      this.withdrawFinalApprovalForBaseAdvanceWithLockHeld(input));
    return locked.acquired && locked.value;
  }

  private withdrawFinalApprovalForBaseAdvanceWithLockHeld(input: Readonly<{
    workItemId: string;
    expectedVersion: number;
    expectedBaseSha: string;
    head: string;
    note: string;
    now: string;
  }>): boolean {
    const readyNodes = this.runtime.store.transaction(() => {
      const current = this.runtime.store.db.prepare(`
        SELECT state,version,base_sha,resolved_project_id
        FROM work_items
        WHERE work_item_id=?
      `).get(input.workItemId) as Row | undefined;
      if (
        current === undefined ||
        current.state !== "final_approval" ||
        Number(current.version) !== input.expectedVersion ||
        current.base_sha !== input.expectedBaseSha
      ) return null;
      const nodes = this.#workflow.returnFinalApprovalToImplementationInTransaction(
        input.workItemId,
        { version: input.expectedVersion, note: input.note },
        "system:base-branch-poll",
        (nodeId, currentState) => workItemStateForNodeStage(
          this.runtime.store.db,
          input.workItemId,
          nodeId,
          "implementation",
          currentState,
        ),
        null,
        "system",
        input.head,
      );
      this.withdrawPromotedParentForChildInTransaction({
        childWorkItemId: input.workItemId,
        actorId: "system:base-branch-poll",
        now: input.now,
        dedupeToken: input.head,
      });
      this.notifications?.insertNotificationAtInTransaction({
        kind: "final_approval_withdrawn",
        dedupeKey: `final_approval_withdrawn:${input.workItemId}:${input.head}`,
        projectId: current.resolved_project_id === null ? null : String(current.resolved_project_id),
        workItemId: input.workItemId,
        summary: `Final approval withdrawn: base branch advanced to ${input.head.slice(0, 10)}`,
      }, input.now);
      return nodes;
    });
    if (readyNodes === null) return false;
    this.activateWorkflowNodes(readyNodes);
    return true;
  }

  parkFinalApprovalForBaseDivergence(input: Readonly<{
    workItemId: string;
    expectedVersion: number;
    expectedBaseSha: string;
    head: string;
    reason: string;
    now: string;
  }>): boolean {
    const locked = this.withFinalApprovalLockIfAvailable(input.workItemId, () =>
      this.parkFinalApprovalForBaseDivergenceWithLockHeld(input));
    return locked.acquired && locked.value;
  }

  private parkFinalApprovalForBaseDivergenceWithLockHeld(input: Readonly<{
    workItemId: string;
    expectedVersion: number;
    expectedBaseSha: string;
    head: string;
    reason: string;
    now: string;
  }>): boolean {
    return this.runtime.store.transaction(() => {
      const current = this.runtime.store.db.prepare(`
        SELECT state,version,base_sha,current_stage,resolved_project_id
        FROM work_items
        WHERE work_item_id=?
      `).get(input.workItemId) as Row | undefined;
      if (
        current === undefined ||
        current.state !== "final_approval" ||
        Number(current.version) !== input.expectedVersion ||
        current.base_sha !== input.expectedBaseSha
      ) return false;
      if (current.current_stage !== null) {
        throw new Error("TASK_BOARD_DATABASE_CORRUPT:final_approval_current_stage");
      }
      const activeRun = this.runtime.store.db.prepare(`
        SELECT run.run_id
        FROM runs run
        JOIN stage_attempts attempt ON attempt.task_id=run.task_id
        JOIN work_nodes node ON node.node_id=attempt.node_id
        JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
        WHERE plan.work_item_id=? AND plan.state='confirmed' AND run.status='active'
        LIMIT 1
      `).get(input.workItemId);
      if (activeRun !== undefined) {
        throw new Error("TASK_BOARD_DATABASE_CORRUPT:active_run_in_final_approval");
      }
      transitionWorkItemInTransaction(this.runtime.store, {
        workItemId: input.workItemId,
        to: "parked",
        actorType: "system",
        actorId: "system:base-branch-poll",
        now: input.now,
        currentStage: null,
        park: { category: "base_diverged", reason: input.reason },
      });
      this.notifications?.insertNotificationAtInTransaction({
        kind: "final_approval_withdrawn",
        dedupeKey: `final_approval_withdrawn:${input.workItemId}:base-diverged:${input.head}`,
        projectId: current.resolved_project_id === null ? null : String(current.resolved_project_id),
        workItemId: input.workItemId,
        summary: `Final approval parked: base branch diverged at ${input.head.slice(0, 10)}`,
      }, input.now);
      this.withdrawPromotedParentForChildInTransaction({
        childWorkItemId: input.workItemId,
        actorId: "system:base-branch-poll",
        now: input.now,
        dedupeToken: `base-diverged:${input.head}`,
      });
      return true;
    });
  }

  private withdrawPromotedParentForChildInTransaction(input: Readonly<{
    childWorkItemId: string;
    actorId: string;
    now: string;
    dedupeToken: string;
  }>): boolean {
    const parent = this.runtime.store.db.prepare(`
      SELECT parent.work_item_id,parent.resolved_project_id,parent.state
      FROM work_items child
      JOIN work_items parent ON parent.work_item_id=child.parent_work_item_id
      WHERE child.work_item_id=?
    `).get(input.childWorkItemId) as Row | undefined;
    if (parent?.state !== "final_approval") return false;
    const parentId = String(parent.work_item_id);
    transitionWorkItemInTransaction(this.runtime.store, {
      workItemId: parentId,
      to: "coordinating",
      actorType: "system",
      actorId: input.actorId,
      now: input.now,
      currentStage: null,
    });
    this.notifications?.insertNotificationAtInTransaction({
      kind: "final_approval_withdrawn",
      dedupeKey: `final_approval_withdrawn:${parentId}:${input.childWorkItemId}:${input.dedupeToken}`,
      projectId: parent.resolved_project_id === null ? null : String(parent.resolved_project_id),
      workItemId: parentId,
      summary: `Parent approval withdrawn: child ${input.childWorkItemId} needs re-verification`,
    }, input.now);
    return true;
  }

  private withFinalApprovalLockIfAvailable<T>(
    workItemId: string,
    operation: () => T,
  ): Readonly<{ acquired: false }> | Readonly<{ acquired: true; value: T }> {
    if (this.#finalApprovalLocks.has(workItemId)) return Object.freeze({ acquired: false });
    let release!: () => void;
    const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent; });
    this.#finalApprovalLocks.set(workItemId, current);
    try {
      return Object.freeze({ acquired: true, value: operation() });
    } finally {
      release();
      if (this.#finalApprovalLocks.get(workItemId) === current) this.#finalApprovalLocks.delete(workItemId);
    }
  }

  private async withFinalApprovalLock<T>(workItemId: string, operation: () => T | Promise<T>): Promise<T> {
    const predecessor = this.#finalApprovalLocks.get(workItemId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent; });
    this.#finalApprovalLocks.set(workItemId, current);
    await predecessor.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#finalApprovalLocks.get(workItemId) === current) this.#finalApprovalLocks.delete(workItemId);
    }
  }

  private pipelineMergeContext(workItemId: string, version: number): Readonly<{
    projectId: string;
    repoPath: string;
    branch: string;
    baseSha: string;
    verifiedSha: string | null;
  }> {
    const workItem = this.runtime.requireWorkItem(workItemId);
    if (workItem.version !== version) {
      throw new TaskBoardError(409, "WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
    }
    if (workItem.state !== "final_approval") {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.WORK_ITEM_ILLEGAL_TRANSITION,
        "Work item is not awaiting final approval",
      );
    }
    if (
      workItem.pipelineBranch === null || workItem.pipelineBranch === undefined ||
      workItem.baseSha === null || workItem.baseSha === undefined
    ) {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_REPO_UNAVAILABLE,
        "Work item has no pipeline branch",
      );
    }
    if (workItem.resolvedProjectId === null) {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_REPO_UNAVAILABLE,
        "The pipeline repository is unavailable",
      );
    }
    const project = this.runtime.requireProject(workItem.resolvedProjectId);
    const latestGreen = this.runtime.store.db.prepare(`
      SELECT verify.detail
      FROM verify_attempts verify
      JOIN work_nodes node ON node.node_id=verify.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      WHERE plan.work_item_id=? AND plan.state='confirmed' AND verify.state='green'
      ORDER BY verify.attempt DESC,verify.created_at DESC,verify.verify_attempt_id DESC
      LIMIT 1
    `).get(workItemId);
    const verifiedSha = latestGreen?.detail === null || latestGreen?.detail === undefined
      ? null
      : VERIFIED_SHA_DETAIL.exec(String(latestGreen.detail))?.[1] ?? null;
    return Object.freeze({
      projectId: project.projectId,
      repoPath: project.repoPath,
      branch: workItem.pipelineBranch,
      baseSha: workItem.baseSha,
      verifiedSha,
    });
  }

  createProject(request: CreateProjectRequest): Project {
    const now = exactNow(this.runtime.config.now);
    const projectId = randomUUID();
    this.runtime.store.transaction(() => {
      this.runtime.store.db.prepare(`
        INSERT INTO projects(project_id, name, description, repo_path, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(projectId, request.name, request.description, request.repoPath ?? request.description, now, now);
      this.runtime.insertEvent(projectId, null, { type: "human", id: this.runtime.config.humanPrincipal }, "project_created", {
        name: request.name,
      }, now);
    });
    return this.runtime.requireProject(projectId);
  }

  prepareClaimContext(taskId: string): PipelineInspection | null {
    return this.#workflow.claimReviewInspection(taskId);
  }

  claimContext(
    taskId: string,
    reviewInspection: PipelineInspection | null,
  ): ClaimRunResult["context"]["workflow"] {
    return this.#workflow.claimContext(taskId, reviewInspection);
  }

  recordReviewRuntimeConflictInTransaction(
    projectId: string,
    nodeId: string,
    taskId: string,
    summary: string,
  ): void {
    const mostRecent = this.runtime.store.db.prepare(`
      SELECT summary
      FROM project_events
      WHERE task_id=? AND event_type='review_runtime_conflict'
      ORDER BY sequence DESC
      LIMIT 1
    `).get(taskId) as Row | undefined;
    if (mostRecent !== undefined && String(mostRecent.summary) === summary) return;
    this.#workflow.event(projectId, nodeId, taskId, "review_runtime_conflict", summary);
  }

  settleAttemptInTransaction(
    taskId: string,
    outcome: SettleRunRequest["outcome"],
    result: string,
    handoff: SettleRunRequest["handoff"],
    reviewFindings: SettleRunRequest["reviewFindings"],
    scopeCheck: AttemptScopeCheckResult | null = null,
  ): readonly WorkNode[] {
    return this.#workflow.settleAttemptInTransaction(taskId, outcome, result, handoff, reviewFindings, scopeCheck);
  }

  suspendAttemptNodeInTransaction(taskId: string, reason: string): void {
    this.#workflow.suspendAttemptNodeInTransaction(taskId, reason);
  }

  settleDesignInTransaction(
    taskId: string,
    result: string,
    designRecord: NonNullable<SettleRunRequest["designRecord"]>,
    actorId: string,
  ): readonly WorkNode[] {
    return this.#workflow.settleDesignInTransaction(taskId, result, designRecord, actorId);
  }

  attemptNeedsSettlementRepair(taskId: string, settledRunId: string): boolean {
    return this.#workflow.attemptNeedsSettlementRepair(taskId, settledRunId);
  }

  activateWorkflowNodes(nodes: readonly WorkNode[]): void {
    for (const node of nodes) this.activateWorkflowNode(node);
  }

  private reconcileDecompositionPolicies(projectId?: string): void {
    if (this.#decompositionReconciliationActive) return;
    if (this.#boardPause.isBoardPaused()) {
      console.info("[task-board] decomposition policy reconciliation skipped", Object.freeze({
        reason: "board_paused",
        projectId: projectId ?? null,
      }));
      return;
    }
    this.#decompositionReconciliationActive = true;
    try {
      const projectFilter = projectId === undefined
        ? ""
        : `AND ${decompositionFamilyTouchesProjectSql("parent.work_item_id", "?")}`;
      const parents = this.runtime.store.db.prepare(`
        SELECT parent.work_item_id,
          EXISTS(
            SELECT 1
            FROM work_items phased_child
            WHERE phased_child.parent_work_item_id=parent.work_item_id
              AND phased_child.phase IS NOT NULL
          ) AS parent_is_phased
        FROM work_items parent
        WHERE parent.state IN ('coordinating','final_approval')
          AND EXISTS(SELECT 1 FROM work_items child WHERE child.parent_work_item_id=parent.work_item_id)
          ${projectFilter}
        ORDER BY parent.created_at,parent.work_item_id
      `).all(...(projectId === undefined ? [] : [projectId])) as Row[];
      for (const parent of parents) {
        const parentId = String(parent.work_item_id);
        const parentIsPhased = Number(parent.parent_is_phased) === 1;
        try {
          this.reconcileDecompositionParent(parentId, parentIsPhased, parentIsPhased
            ? {
                actorId: "system:parent-plan-authorization",
                actorType: "system",
                refId: null,
              }
            : {
                actorId: "system:parent-completion",
                actorType: "system",
                refId: null,
              });
        } catch (error) {
          this.logDecompositionPolicyFailure(parentId, null, false, error);
        }
      }
    } finally {
      this.#decompositionReconciliationActive = false;
    }
  }

  private reconcileDecompositionParent(
    parentId: string,
    parentIsPhased: boolean,
    completionAuthorization: PipelineMergeAuthorization,
  ): void {
    const parent = this.runtime.requireWorkItem(parentId);
    const children = this.childrenInDependencyOrder(parentId);
    const states = new Map((this.runtime.store.db.prepare(`
      SELECT work_item_id,state
      FROM work_items
      WHERE parent_work_item_id=?
    `).all(parentId) as Row[]).map((row) => [String(row.work_item_id), String(row.state)] as const));
    const hasFailedChild = [...states.values()].some((state) => (
      state === "abandoned" || state === "dead_letter"
    ));
    if (
      (!parentIsPhased || !hasFailedChild)
      && children.every((child) => states.get(child.workItemId) === "merged")
    ) {
      this.runtime.store.transaction(() => {
        const current = this.runtime.requireWorkItem(parentId);
        if (current.state !== "coordinating" && current.state !== "final_approval") return;
        this.#workflow.settleParentCompletionInTransaction(
          parentId,
          current.version,
          children.map((child) => child.workItemId),
          completionAuthorization.actorId,
          completionAuthorization.actorType,
        );
      });
      return;
    }
    if (children.length === 0) return;
    if (parent.state !== "coordinating") return;
    const mergePolicy = this.decompositionMergePolicy(children);

    if (mergePolicy === "phased_auto_merge") {
      const authorization = this.runtime.store.db.prepare(`
        SELECT gate_action_id
        FROM gate_actions
        WHERE work_item_id=? AND gate='plan_confirm'
        ORDER BY created_at DESC,rowid DESC
        LIMIT 1
      `).get(parentId) as Row | undefined;
      if (authorization === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:parent_plan_authorization_missing");
      for (const child of children) {
        const current = this.runtime.requireWorkItem(child.workItemId);
        if (current.state !== "final_approval" || !["expand", "migrate"].includes(child.phase ?? "")) continue;
        const unmetDependency = this.runtime.store.db.prepare(`
          SELECT 1
          FROM work_item_dependencies dependency
          JOIN work_items predecessor ON predecessor.work_item_id=dependency.depends_on_work_item_id
          WHERE dependency.work_item_id=?
            AND predecessor.state NOT IN ('merged','abandoned','dead_letter')
          LIMIT 1
        `).get(child.workItemId);
        if (unmetDependency !== undefined) continue;
        try {
          const locked = this.withFinalApprovalLockIfAvailable(child.workItemId, () => {
            const context = this.pipelineMergeContext(child.workItemId, current.version);
            const baseAdvance = inspectPipelineBaseAdvance({
              repoPath: context.repoPath,
              branch: context.branch,
              baseSha: context.baseSha,
              git: this.git,
            });
            if (baseAdvance.kind === "advanced") {
              const note = `base branch advanced to ${baseAdvance.head}; rebase onto it and re-verify`;
              return Object.freeze({
                kind: "withdrawn" as const,
                applied: this.withdrawFinalApprovalForBaseAdvanceWithLockHeld({
                  workItemId: child.workItemId,
                  expectedVersion: current.version,
                  expectedBaseSha: context.baseSha,
                  head: baseAdvance.head,
                  note,
                  now: exactNow(this.runtime.config.now),
                }),
              });
            }
            if (baseAdvance.kind === "diverged") {
              return Object.freeze({
                kind: "parked" as const,
                applied: this.parkFinalApprovalForBaseDivergenceWithLockHeld({
                  workItemId: child.workItemId,
                  expectedVersion: current.version,
                  expectedBaseSha: context.baseSha,
                  head: baseAdvance.head,
                  reason: `base branch history rewritten (was ${context.baseSha}, now ${baseAdvance.head})`,
                  now: exactNow(this.runtime.config.now),
                }),
              });
            }
            if (baseAdvance.kind === "repo_busy") {
              return Object.freeze({ kind: "repo_busy" as const });
            }
            return Object.freeze({
              kind: "merge" as const,
              workItem: this.approveSinglePipelineMerge(
                child.workItemId,
                { version: current.version },
                {
                  actorId: "system:parent-plan-authorization",
                  actorType: "system",
                  refId: String(authorization.gate_action_id),
                },
                false,
              ),
            });
          });
          if (!locked.acquired) continue;
          if (locked.value.kind === "repo_busy") {
            console.info("[task-board] phased automatic merge skipped", Object.freeze({
              parentWorkItemId: parentId,
              childWorkItemId: child.workItemId,
              reason: "repo_busy",
            }));
            continue;
          }
          if (locked.value.kind === "withdrawn" || locked.value.kind === "parked") {
            if (!locked.value.applied) {
              this.logDecompositionPolicyFailure(
                parentId,
                child.workItemId,
                false,
                locked.value.kind === "withdrawn"
                  ? "base-advance withdrawal was not applied"
                  : "base-divergence park was not applied",
              );
            }
            continue;
          }
          if (locked.value.workItem.state !== "merged") {
            this.notifyAutomaticMergeFailure(
              parentId,
              child.workItemId,
              locked.value.workItem.resolvedProjectId,
              locked.value.workItem.version,
            );
            this.logDecompositionPolicyFailure(parentId, child.workItemId, false, "automatic merge returned to implementation");
            continue;
          }
        } catch (error) {
          const transient = error instanceof TaskBoardError && (
            error.code === TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_REPO_BUSY
            || error.code === TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_REPO_UNAVAILABLE
          );
          this.logDecompositionPolicyFailure(parentId, child.workItemId, transient, error);
          if (!transient) {
            const failed = this.runtime.requireWorkItem(child.workItemId);
            this.notifyAutomaticMergeFailure(parentId, child.workItemId, failed.resolvedProjectId, failed.version);
          }
          continue;
        }
      }
      return;
    }

    const unmerged = children.filter((child) => states.get(child.workItemId) !== "merged");
    if (
      unmerged.length === 0
      || unmerged.some((child) => states.get(child.workItemId) !== "final_approval")
    ) return;
    this.runtime.store.transaction(() => {
      const current = this.runtime.requireWorkItem(parentId);
      if (current.state !== "coordinating") return;
      const transition = transitionWorkItemInTransaction(this.runtime.store, {
        workItemId: parentId,
        to: "final_approval",
        actorType: "system",
        actorId: "system:parent-coordination",
        now: exactNow(this.runtime.config.now),
        currentStage: null,
      });
      this.notifications?.insertNotificationInTransaction({
        kind: "parent_ready_for_approval",
        dedupeKey: `parent_ready_for_approval:${parentId}:${transition.version}`,
        projectId: current.resolvedProjectId,
        workItemId: parentId,
        summary: `Parent ready for approval: ${parentId}`,
      });
    });
  }

  private notifyAutomaticMergeFailure(
    parentId: string,
    childId: string,
    projectId: string | null,
    version: number,
  ): void {
    this.runtime.store.transaction(() => {
      this.notifications?.insertNotificationInTransaction({
        kind: "final_approval_withdrawn",
        dedupeKey: `final_approval_withdrawn:${childId}:automatic-merge:${version}`,
        projectId,
        workItemId: childId,
        summary: `Automatic merge failed for child ${childId} of parent ${parentId}`,
      });
    });
  }

  private logDecompositionPolicyFailure(
    parentId: string,
    childId: string | null,
    transient: boolean,
    error: unknown,
  ): void {
    console.error("[task-board] decomposition policy reconciliation failed", Object.freeze({
      parentWorkItemId: parentId,
      childWorkItemId: childId,
      transient,
      code: error instanceof TaskBoardError ? error.code : "UNEXPECTED_ERROR",
      error,
    }));
  }

  reconcileWorkflows(projectId?: string): void {
    if (projectId !== undefined) this.runtime.requireProject(projectId);
    this.reconcileDecompositionPolicies(projectId);
    if (this.runtime.store.db.prepare(
      projectId === undefined
        ? "SELECT 1 FROM work_nodes LIMIT 1"
        : "SELECT 1 FROM work_nodes WHERE project_id=? LIMIT 1",
    ).get(...(projectId === undefined ? [] : [projectId])) === undefined) return;
    const projectFilter = projectId === undefined ? "" : `AND (
      node.project_id=?
      OR (
        item.parent_work_item_id IS NOT NULL
        AND ${decompositionFamilyTouchesProjectSql("item.parent_work_item_id", "?")}
      )
    )`;
    const rows = this.runtime.store.db.prepare(`
      SELECT node.node_id
      FROM work_nodes node
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      WHERE plan.state='confirmed'
        ${projectFilter}
        AND item.state NOT IN ('coordinating','parked','merged','abandoned','dead_letter')
        AND (
          (
            item.parent_work_item_id IS NOT NULL
            AND item.state='queued'
            AND node.state IN ('pending','blocked')
          )
          OR
          (
            node.state='ready'
            AND node.current_stage IS NOT NULL
            AND NOT EXISTS(
              SELECT 1
              FROM stage_attempts attempt
              JOIN tasks task ON task.task_id=attempt.task_id
              WHERE attempt.node_id=node.node_id
                AND attempt.stage=node.current_stage
                AND task.ended_at IS NULL
                AND task.status IN ('queued','in_progress','blocked')
            )
          )
          OR (
            node.state='blocked'
            AND node.current_stage IS NOT NULL
            AND (
              SELECT event.event_type
              FROM project_events event
              WHERE event.node_id=node.node_id
                AND event.event_type IN (
                  'node_blocked','stage_started','stage_retry_ready','stage_completed','stage_failed','node_completed'
                )
              ORDER BY event.sequence DESC
              LIMIT 1
            )='node_blocked'
          )
        )
      ORDER BY node.created_at,node.node_id
    `).all(...(projectId === undefined ? [] : [projectId, projectId])) as Row[];
    const candidateIds = rows.map((row) => String(row.node_id));
    for (let offset = 0; offset < candidateIds.length; offset += WORKFLOW_RECONCILIATION_BATCH_SIZE) {
      const batch = candidateIds.slice(offset, offset + WORKFLOW_RECONCILIATION_BATCH_SIZE);
      let nodesById: ReadonlyMap<string, WorkNode>;
      try {
        nodesById = new Map(this.#workflow.nodesForIds(batch).map((node) => [node.nodeId, node]));
      } catch {
        for (const nodeId of batch) this.reconcileWorkflowCandidate(nodeId);
        continue;
      }
      for (const nodeId of batch) this.reconcileWorkflowCandidate(nodeId, nodesById.get(nodeId));
    }
  }

  reconcileWorkflowsBestEffort(projectId?: string): void {
    try {
      this.reconcileWorkflows(projectId);
    } catch (error) {
      const scope = projectId === undefined ? "at startup" : `for project ${projectId}`;
      console.error(`[task-board] workflow reconciliation failed ${scope}`, error);
    }
  }

  sweepVerifyAttempts(): Promise<number> {
    return this.#verifyAttempts.sweep();
  }

  close(): void {
    this.#verifyAttempts.close();
  }

  private reconcileWorkflowCandidate(nodeId: string, candidate?: WorkNode): void {
    try {
      const node = candidate ?? this.#workflow.nodesForIds([nodeId])[0];
      if (node !== undefined) this.activateWorkflowNode(node);
    } catch (error) {
      console.error(`[task-board] workflow reconciliation failed for node ${nodeId}`, error);
    }
  }

  private phasedChildBaseRefreshForActivation(nodeId: string): PhasedChildBaseRefresh | null {
    const candidate = this.runtime.store.db.prepare(`
      SELECT item.work_item_id,item.resolved_project_id
      FROM work_nodes node
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      WHERE node.node_id=?
        AND node.state IN ('pending','ready','blocked')
        AND item.state='queued'
        AND item.parent_work_item_id IS NOT NULL
        AND EXISTS(
          SELECT 1
          FROM work_items phased_child
          WHERE phased_child.parent_work_item_id=item.parent_work_item_id
            AND phased_child.phase IS NOT NULL
        )
    `).get(nodeId) as Row | undefined;
    if (candidate === undefined) return null;
    const workItemId = String(candidate.work_item_id);
    if (decompositionReadinessBlocker(this.runtime.store.db, workItemId) !== null) return null;
    if (candidate.resolved_project_id === null) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:phased_child_project_missing");
    }
    const projectId = String(candidate.resolved_project_id);
    return Object.freeze({
      workItemId,
      projectId,
      baseSha: this.#workflow.pipelineBaseShaForProject(projectId),
    });
  }

  private activateWorkflowNode(node: WorkNode): void {
    // A phased child's default-branch head is resolved before the activation
    // transaction so no Git process runs while SQLite holds a transaction.
    const phasedBaseRefresh = this.phasedChildBaseRefreshForActivation(node.nodeId);
    let phasedBaseRefreshLog: Readonly<{
      workItemId: string;
      projectId: string;
      previousBaseSha: string;
      baseSha: string;
    }> | null = null;
    let wakeAgentId: string | null = null;
    this.runtime.store.transaction(() => {
      let current = this.#workflow.nodesForIds([node.nodeId])[0];
      if (current === undefined || !["pending", "ready", "blocked"].includes(current.state)) return;
      const owner = this.runtime.store.db.prepare(`
        SELECT item.work_item_id,item.state,item.parent_work_item_id,item.phase,
          item.resolved_project_id,item.base_sha,plan.tier,
          EXISTS(
            SELECT 1
            FROM work_items phased_child
            WHERE phased_child.parent_work_item_id=item.parent_work_item_id
              AND phased_child.phase IS NOT NULL
          ) AS parent_is_phased
        FROM plan_revisions plan
        JOIN work_items item ON item.work_item_id=plan.work_item_id
        WHERE plan.plan_revision_id=?
      `).get(current.planRevisionId) as Row | undefined;
      if (owner === undefined || typeof owner.state !== "string") {
        throw new Error("TASK_BOARD_DATABASE_CORRUPT:workflow_node_owner");
      }
      const ownerState = owner.state as WorkItemState;
      if (!workItemStateOwnsWorkflowExecution(ownerState)) return;
      const childWorkItemId = owner.parent_work_item_id === null
        ? null
        : String(owner.work_item_id);
      if (childWorkItemId !== null && ownerState === "queued") {
        const unmet = decompositionReadinessBlocker(this.runtime.store.db, childWorkItemId);
        if (unmet !== null) {
          const dependencyId = unmet.workItemId;
          const dependencyPhase = unmet.phase ?? "child";
          this.#workflow.blockNodeInTransaction(
            current.nodeId,
            unmet.state === "abandoned" || unmet.state === "dead_letter"
              ? `blocked: ${dependencyId} (${dependencyPhase}) ${unmet.state}`
              : unmet.state !== "merged"
              ? `waits for ${dependencyId} (${dependencyPhase}) to merge`
              : `waits for ${dependencyId} (${dependencyPhase}) deploy attestation`,
          );
          return;
        }
        if (Number(owner.parent_is_phased) === 1) {
          if (
            phasedBaseRefresh === null
            || phasedBaseRefresh.workItemId !== childWorkItemId
            || phasedBaseRefresh.projectId !== owner.resolved_project_id
            || owner.base_sha === null
          ) {
            throw new Error("TASK_BOARD_DATABASE_CORRUPT:phased_child_base_refresh_missing");
          }
          const refreshed = this.runtime.store.db.prepare(`
            UPDATE work_items
            SET base_sha=?
            WHERE work_item_id=? AND state='queued'
          `).run(phasedBaseRefresh.baseSha, childWorkItemId);
          if (Number(refreshed.changes) !== 1) {
            throw new Error("TASK_BOARD_DATABASE_CORRUPT:phased_child_base_refresh_conflict");
          }
          phasedBaseRefreshLog = Object.freeze({
            workItemId: childWorkItemId,
            projectId: phasedBaseRefresh.projectId,
            previousBaseSha: String(owner.base_sha),
            baseSha: phasedBaseRefresh.baseSha,
          });
        }
        if (owner.tier === "hazardous") {
          if (this.#startDesignInTransaction === undefined) {
            throw new Error("TASK_BOARD_DATABASE_CORRUPT:design_task_creator_missing");
          }
          this.#workflow.deferNodeForDesignInTransaction(current.nodeId);
          this.#startDesignInTransaction(childWorkItemId);
          transitionWorkItemInTransaction(this.runtime.store, {
            workItemId: childWorkItemId,
            to: "designing",
            actorType: "system",
            actorId: "system:parent-coordination",
            now: exactNow(this.runtime.config.now),
            currentStage: "planning",
          });
          return;
        }
        current = this.#workflow.readyNodeAtTemplateStartInTransaction(current.nodeId);
        const childStage = current.currentStage;
        if (childStage === null) {
          throw new Error("TASK_BOARD_DATABASE_CORRUPT:confirmed_plan_without_ready_stage");
        }
        transitionWorkItemInTransaction(this.runtime.store, {
          workItemId: childWorkItemId,
          to: workItemStateForNodeStage(
            this.runtime.store.db,
            childWorkItemId,
            current.nodeId,
            childStage,
            ownerState,
          ),
          actorType: "system",
          actorId: "system:parent-coordination",
          now: exactNow(this.runtime.config.now),
          currentStage: childStage,
        });
      }
      if (!["ready", "blocked"].includes(current.state)) return;
      if (current.state === "blocked") {
        const latestLifecycleEvent = this.runtime.store.db.prepare(`
          SELECT event.event_type
          FROM project_events event
          WHERE event.node_id=?
            AND event.event_type IN (
              'node_blocked','stage_started','stage_retry_ready','stage_completed','stage_failed','node_completed'
            )
          ORDER BY event.sequence DESC
          LIMIT 1
        `).get(current.nodeId);
        if (latestLifecycleEvent?.event_type !== "node_blocked") return;
      }
      const stage = current.currentStage;
      if (stage === null) return;
      const pipeline = pipelineTemplateShape(current.stageTemplate) === null
        ? undefined
        : this.runtime.store.db.prepare(`
            SELECT plan.work_item_id,plan.declared_scope_json,plan.confirmed_at
            FROM plan_revisions plan
            JOIN work_items item ON item.work_item_id=plan.work_item_id
            WHERE plan.plan_revision_id=?
              AND plan.state='confirmed'
              AND item.pipeline_branch IS NOT NULL
          `).get(current.planRevisionId) as Row | undefined;
      if (pipeline !== undefined) {
        if (pipeline.declared_scope_json === null || pipeline.confirmed_at === null) {
          throw new Error("TASK_BOARD_DATABASE_CORRUPT:pipeline_plan_record");
        }
        const declaredScope = JSON.parse(String(pipeline.declared_scope_json)) as string[];
        const otherPipelineItems = this.runtime.store.db.prepare(`
          SELECT item.work_item_id,plan.declared_scope_json
          FROM work_items item
          JOIN plan_revisions plan
            ON plan.work_item_id=item.work_item_id
            AND plan.state='confirmed'
          WHERE item.resolved_project_id=?
            AND item.work_item_id<>?
            AND item.pipeline_branch IS NOT NULL
            AND item.state IN ('implementing','verifying','reviewing','fixing','designing','final_approval','parked')
            AND (
              plan.confirmed_at<?
              OR (plan.confirmed_at=? AND item.work_item_id<?)
            )
          ORDER BY plan.confirmed_at,item.work_item_id
        `).all(
          current.projectId,
          String(pipeline.work_item_id),
          String(pipeline.confirmed_at),
          String(pipeline.confirmed_at),
          String(pipeline.work_item_id),
        ) as Row[];
        for (const other of otherPipelineItems) {
          if (other.declared_scope_json === null) {
            throw new Error("TASK_BOARD_DATABASE_CORRUPT:pipeline_plan_record");
          }
          const otherDeclaredScope = JSON.parse(String(other.declared_scope_json)) as string[];
          if (!declaredScopesOverlap(declaredScope, otherDeclaredScope)) continue;
          this.#workflow.blockNodeInTransaction(
            current.nodeId,
            `${SCOPE_HOLD_SUMMARY_PREFIX}overlaps ${String(other.work_item_id)}`,
          );
          return;
        }
      }
      const configuration = this.automation.getConfiguration();
      const configuredExecutor = configuration.stages.find((item) => item.stage === stage)?.executor;
      if (configuredExecutor?.kind === "machine_verify") {
        const activation = this.#verifyAttempts.createStartingAttemptInTransaction(current.nodeId, stage);
        if (activation.kind === "pipeline_required") {
          this.#workflow.blockNodeInTransaction(current.nodeId, "machine_verify requires a pipeline plan");
          return;
        }
        if (activation.kind === "ineligible") return;
        this.#workflow.event(
          current.projectId,
          current.nodeId,
          null,
          "stage_started",
          `${current.title} entered ${stage}`,
        );
        this.runtime.store.afterCommit(() => this.#verifyAttempts.startAfterCommit(activation.verifyAttemptId));
        return;
      }
      if (configuredExecutor?.kind !== "agent_type") {
        this.#workflow.blockNodeInTransaction(
          current.nodeId,
          `${current.title} has no configured ${stage} executor`,
        );
        return;
      }
      if (stage === "testing") {
        const pipeline = this.runtime.store.db.prepare(`
          SELECT item.pipeline_branch
          FROM work_nodes node
          JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
          JOIN work_items item ON item.work_item_id=plan.work_item_id
          WHERE node.node_id=?
        `).get(current.nodeId);
        if (pipeline?.pipeline_branch !== null && pipeline?.pipeline_branch !== undefined) {
          this.#workflow.blockNodeInTransaction(
            current.nodeId,
            "pipeline testing stage requires machine_verify",
          );
          return;
        }
      }
      const agentType = configuration.agentTypes.find((item) =>
        item.agentTypeId === configuredExecutor.agentTypeId && item.enabled);
      if (!agentType) {
        this.#workflow.blockNodeInTransaction(current.nodeId, `${current.title} executor is unavailable`);
        return;
      }
      let agent = this.runtime.store.db.prepare(`
        SELECT *
        FROM agents
        WHERE project_id=? AND role=?
          AND NOT EXISTS (
            SELECT 1 FROM runs
            WHERE runs.agent_id=agents.agent_id AND runs.status='active'
          )
          AND NOT EXISTS (
            SELECT 1 FROM wakeups AS wakeup
            WHERE wakeup.agent_id=agents.agent_id
              AND ${PENDING_LIVE_WAKEUP_PREDICATE_SQL}
          )
        ORDER BY created_at,agent_id
        LIMIT 1
      `).get(current.projectId, agentType.role, RETIRED_WAKEUP_EVENT_PREFIX);
      agent ??= this.runtime.store.db.prepare(
        "SELECT * FROM agents WHERE project_id=? AND role=? ORDER BY created_at,agent_id LIMIT 1",
      ).get(current.projectId, agentType.role);
      if (!agent) {
        createLazyExecutorInTransaction(this.runtime, current.projectId, agentType);
        agent = this.runtime.store.db.prepare(
          "SELECT * FROM agents WHERE project_id=? AND role=? ORDER BY created_at,agent_id LIMIT 1",
        ).get(current.projectId, agentType.role);
        if (!agent) {
          this.#workflow.blockNodeInTransaction(current.nodeId, `${current.title} has no compatible agent`);
          return;
        }
      }
      const title = `${stage}: ${current.title}`;
      const acceptanceCriteria = current.acceptanceCriteria.join("\n");
      const orphan = this.runtime.store.db.prepare(`
        SELECT task.*
        FROM tasks task
        JOIN agents assigned
          ON assigned.agent_id=task.assigned_agent_id
          AND assigned.project_id=task.project_id
          AND assigned.role=task.assigned_role
        WHERE task.project_id=?
          AND task.parent_task_id IS NULL
          AND task.task_kind='work'
          AND task.required_role IS NULL
          AND task.requires_review=0
          AND task.title=?
          AND task.objective=?
          AND task.acceptance_criteria=?
          AND task.workspace_refs_json='[]'
          AND task.assigned_role=?
          AND task.ended_at IS NULL
          AND task.status='queued'
          AND NOT EXISTS(SELECT 1 FROM stage_attempts attempt WHERE attempt.task_id=task.task_id)
          AND NOT EXISTS(SELECT 1 FROM work_item_planning_tasks planning WHERE planning.task_id=task.task_id)
          AND EXISTS(
            SELECT 1 FROM wakeups wakeup
            WHERE wakeup.task_id=task.task_id
              AND wakeup.project_id=task.project_id
              AND wakeup.agent_id=task.assigned_agent_id
              AND wakeup.claimed_at IS NULL
              AND NOT EXISTS(
                SELECT 1 FROM task_events event WHERE event.event_id=? || wakeup.wakeup_id
              )
          )
        ORDER BY task.order_key,task.task_id
        LIMIT 1
      `).get(
        current.projectId,
        title,
        current.objective,
        acceptanceCriteria,
        agentType.role,
        RETIRED_WAKEUP_EVENT_PREFIX,
      );
      const task = orphan === undefined
        ? this.tasks.createTaskInTransaction(current.projectId, {
            parentTaskId: null,
            title,
            objective: current.objective,
            acceptanceCriteria,
            workspaceRefs: [],
            assignedAgentId: String(agent.agent_id),
            assignedRole: agentType.role,
            requiresReview: false,
          })
        : this.runtime.requireTask(String(orphan.task_id));
      const plan = this.runtime.store.db.prepare(`
        SELECT plan.skill_digests_json
        FROM plan_revisions plan
        JOIN work_nodes planned_node ON planned_node.plan_revision_id=plan.plan_revision_id
        WHERE planned_node.node_id=?
      `).get(current.nodeId);
      const planDigests = JSON.parse(String(plan?.skill_digests_json ?? "{}")) as Record<string, string>;
      const stageDigests = Object.fromEntries(agentType.skillIds.flatMap((skillId) =>
        planDigests[skillId] === undefined ? [] : [[skillId, planDigests[skillId]]]));
      this.#workflow.linkAttemptInTransaction(current.nodeId, task.taskId, stage, stageDigests);
      this.#workflow.event(
        current.projectId,
        current.nodeId,
        task.taskId,
        "stage_started",
        `${current.title} entered ${stage}`,
      );
      if (orphan === undefined) wakeAgentId = String(agent.agent_id);
    });
    if (phasedBaseRefreshLog !== null) {
      console.info("[task-board] phased child base refreshed", phasedBaseRefreshLog);
    }
    if (wakeAgentId !== null) this.runtime.wakeupEvents.emit(wakeAgentId);
  }

  private emitProjectEvent(event: ProjectEvent): void {
    for (const candidate of this.runtime.projectEvents.listeners(event.projectId)) {
      try {
        (candidate as (item: ProjectEvent) => void)(event);
      } catch (error) {
        console.error("[task-board] project event listener failed", error);
      }
    }
  }
}
