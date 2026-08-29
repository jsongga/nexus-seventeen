import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  TASK_BOARD_ERROR_CODES,
  WORK_ITEM_PAGE_SIZE,
  isHardTerminalTaskStatus,
  isTerminalWorkItemState,
  type AttestDeployRequest,
  type AttestDeployResult,
  type BoardTask,
  type ChildWorkItem,
  type CreateWorkItemRequest,
  type GateAction,
  type ParkCategory,
  type ParentCompletion,
  type UpdateWorkItemRequest,
  type WorkItem,
  type WorkItemAudit,
  type WorkItemDependency,
  type WorkItemPage,
  type WorkItemState,
  type WorkItemTaskType,
  type WorkItemTransition,
} from "#shared/task-board-contract";
import { parseGateAction } from "#shared/task-board-contract/validate";
import {
  redactForPersistence,
  redactMultilineForPersistence,
  safeErrorDetail,
} from "../../shared/redact.js";
import { sha256 } from "../canonical.js";
import { conflict, TaskBoardError } from "../errors.js";
import { RETIRED_WAKEUP_EVENT_PREFIX } from "../persistence/workflow.js";
import { decodeWorkItemCursor, encodeWorkItemCursor } from "../persistence/work-item-cursor.js";
import { workItemPriorityCases } from "../persistence/store.js";
import { numberValue, stringValue, workItemFromRow, type Row } from "../persistence/rows.js";
import { exactNow } from "../persistence/timestamps.js";
import type { AutomationCollaborator } from "./automation.js";
import type { TaskBoardRuntime } from "./runtime.js";
import type { TasksCollaborator } from "./tasks.js";
import { NotificationsCollaborator } from "./notifications.js";
import { createLazyManagerInTransaction } from "./agent-identities.js";
import {
  decompositionFamilyTouchesProjectSql,
  decompositionReadinessBlocker,
} from "./decomposition-readiness.js";
import { retireOpenVerifyAttemptsForWorkItemInTransaction } from "./verify-attempts.js";
import {
  recordInitialWorkItemTransitionInTransaction,
  registerParentTerminationCascade,
  transitionWorkItemInTransaction,
} from "./work-item-transitions.js";

export type CreateWorkItemResult = Readonly<{ workItem: WorkItem; duplicate: boolean }>;
export type WorkItemDetail = WorkItem & Readonly<{
  transitions: readonly WorkItemTransition[];
  gapReportArtifactId?: string | null;
  parkCategory?: ParkCategory;
}>;
type PlanningStartResult = Readonly<{ task: BoardTask | null; wakeAgentId: string | null }>;

export function workItemAwaitsIntakePlanning(db: DatabaseSync, workItemId: string): boolean {
  return db.prepare(`
    SELECT 1
    FROM work_items item
    WHERE item.work_item_id=?
      AND item.state='queued'
      AND item.ended_at IS NULL
      AND item.parent_work_item_id IS NULL
      AND NOT EXISTS(
        SELECT 1
        FROM plan_revisions plan
        WHERE plan.work_item_id=item.work_item_id AND plan.state='confirmed'
      )
  `).get(workItemId) !== undefined;
}

const PLANNING_ACCEPTANCE_CRITERIA_PREFIX = "Return a concise workflowPlan with explicit acceptance criteria, acyclic dependencies, and valid unique stage sequences. Available automated stages: ";
const ONBOARDING_ACCEPTANCE_CRITERIA = "Return a single-node v2 workflowPlan with stageTemplate [\"implementation\",\"testing\",\"verification\"], declaredScope covering README.md, the prefix \"docs\" (covering everything under docs/), and Dockerfile, and acceptance criteria naming the five documentation slots, a dated onboarding ADR, a valid VerifyContract defining the three test tiers and source-to-test mapping, an agent Dockerfile target when a Dockerfile exists, and a gap report that always includes deferred branch protection.";
const WORK_ITEM_TERMINAL_RANK_SQL = "(work_item.ended_at IS NOT NULL)";
const WORK_ITEM_PRIORITY_RANK_SQL = `CASE work_item.priority
  ${workItemPriorityCases("  ")}
END`;

function onboardingUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: work_item_onboarding_tasks\.project_id/u.test(error.message);
}

export function workItemTitleProjection(
  workItem: Pick<WorkItem, "originalRequest" | "refinedObjective">,
): string {
  return (workItem.refinedObjective ?? workItem.originalRequest).slice(0, 220);
}

export class WorkItemsCollaborator {
  #suspendActiveRunInTransaction: ((
    runId: string,
    reason: string,
    actor: { type: "human" | "agent" | "system"; id: string },
    now: string,
    options?: Readonly<{ skipAttemptNodeSuspension?: boolean }>,
  ) => unknown) | undefined;

  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly automation: AutomationCollaborator,
    private readonly tasks: TasksCollaborator,
    private readonly reconcileWorkflowsBestEffort: (projectId: string) => void = () => undefined,
    private readonly notifications: NotificationsCollaborator = new NotificationsCollaborator(runtime),
  ) {
    registerParentTerminationCascade(this.runtime.store, (input) => {
      this.cancelChildrenForParentTerminationInTransaction(input);
    });
  }

  setSuspendActiveRunInTransaction(suspend: (
    runId: string,
    reason: string,
    actor: { type: "human" | "agent" | "system"; id: string },
    now: string,
    options?: Readonly<{ skipAttemptNodeSuspension?: boolean }>,
  ) => unknown): void {
    this.#suspendActiveRunInTransaction = suspend;
  }

  listWorkItemsPage(cursor?: string, includeArchived = false): WorkItemPage {
    const tuple = cursor === undefined ? null : decodeWorkItemCursor(cursor);
    const select = `
      SELECT work_item.*,
        CASE WHEN onboarding.work_item_id IS NULL THEN 'standard' ELSE 'onboarding' END AS task_type,
        (SELECT task_id FROM work_item_planning_tasks planning WHERE planning.work_item_id=work_item.work_item_id) AS planning_task_id,
        (SELECT MAX(transition.created_at)
          FROM work_item_transitions transition
          WHERE transition.work_item_id=work_item.work_item_id
        ) AS state_since,
        (SELECT MAX(attempt.attempt)
          FROM stage_attempts attempt
          JOIN work_nodes node ON node.node_id=attempt.node_id
          JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
          WHERE plan.work_item_id=work_item.work_item_id
            AND plan.state='confirmed'
            AND attempt.stage='verification'
        ) AS review_round,
        (SELECT MAX(COALESCE(run.heartbeat_at, run.started_at))
          FROM runs run
          WHERE run.status='active'
            AND (
              EXISTS(
                SELECT 1 FROM work_item_planning_tasks planning
                WHERE planning.work_item_id=work_item.work_item_id AND planning.task_id=run.task_id
              )
              OR EXISTS(
                SELECT 1 FROM work_item_design_tasks design
                WHERE design.work_item_id=work_item.work_item_id AND design.task_id=run.task_id
              )
              OR EXISTS(
                SELECT 1
                FROM stage_attempts attempt
                JOIN work_nodes node ON node.node_id=attempt.node_id
                JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
                WHERE plan.work_item_id=work_item.work_item_id AND attempt.task_id=run.task_id
              )
            )
        ) AS heartbeat_at,
        ${WORK_ITEM_TERMINAL_RANK_SQL} AS work_item_terminal_rank,
        ${WORK_ITEM_PRIORITY_RANK_SQL} AS work_item_priority_rank
      FROM work_items work_item
      LEFT JOIN work_item_onboarding_tasks onboarding ON onboarding.work_item_id=work_item.work_item_id
    `;
    const orderAndLimit = `
      ORDER BY
        ${WORK_ITEM_TERMINAL_RANK_SQL},
        ${WORK_ITEM_PRIORITY_RANK_SQL},
        work_item.created_at,
        work_item.work_item_id
      LIMIT ${WORK_ITEM_PAGE_SIZE + 1}
    `;
    const rows = tuple === null
      ? this.runtime.store.db.prepare(`${select} WHERE ${includeArchived ? "1=1" : "work_item.archived_at IS NULL"} ${orderAndLimit}`).all()
      : this.runtime.store.db.prepare(`
          ${select}
          WHERE ${includeArchived ? "1=1" : "work_item.archived_at IS NULL"} AND (
            ${WORK_ITEM_TERMINAL_RANK_SQL},
            ${WORK_ITEM_PRIORITY_RANK_SQL},
            work_item.created_at,
            work_item.work_item_id
          ) > (?, ?, ?, ?)
          ${orderAndLimit}
        `).all(tuple.terminalRank, tuple.priorityRank, tuple.createdAt, tuple.workItemId);
    const pageRows = rows.slice(0, WORK_ITEM_PAGE_SIZE);
    const workItems = Object.freeze(pageRows.map(workItemFromRow));
    if (rows.length <= WORK_ITEM_PAGE_SIZE) return Object.freeze({ workItems });
    const last = pageRows.at(-1);
    if (last === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:work_item_page");
    return Object.freeze({ workItems, nextCursor: encodeWorkItemCursor(last) });
  }

  listWorkItems(includeArchived = false): readonly WorkItem[] {
    return this.listWorkItemsPage(undefined, includeArchived).workItems;
  }

  listChildren(parentWorkItemId: string): readonly ChildWorkItem[] {
    const completionByChild = new Map(this.parentCompletion(parentWorkItemId).children.map(
      (child) => [child.workItemId, child.mergeSha] as const,
    ));
    const rows = this.runtime.store.db.prepare(`
      SELECT work_item.*,
        CASE WHEN onboarding.work_item_id IS NULL THEN 'standard' ELSE 'onboarding' END AS task_type,
        (SELECT task_id FROM work_item_planning_tasks planning
          WHERE planning.work_item_id=work_item.work_item_id
        ) AS planning_task_id,
        EXISTS(
          SELECT 1 FROM gate_actions action
          WHERE action.work_item_id=work_item.work_item_id AND action.gate='deploy_attest'
        ) AS deploy_attested
      FROM work_items work_item
      LEFT JOIN work_item_onboarding_tasks onboarding ON onboarding.work_item_id=work_item.work_item_id
      WHERE work_item.parent_work_item_id=?
      ORDER BY work_item.child_ordinal,work_item.created_at,work_item.work_item_id
    `).all(parentWorkItemId);
    return Object.freeze(rows.map((row) => Object.freeze({
      ...workItemFromRow(row),
      deployAttested: numberValue(row, "deploy_attested") === 1,
      mergeSha: completionByChild.get(stringValue(row, "work_item_id")) ?? null,
    })));
  }

  parentCompletion(parentWorkItemId: string): ParentCompletion {
    this.runtime.requireWorkItem(parentWorkItemId);
    const children = (this.runtime.store.db.prepare(`
      SELECT child.work_item_id,
        (
          SELECT action.merge_sha
          FROM gate_actions action
          WHERE action.work_item_id=child.work_item_id
            AND action.gate='final_approve'
            AND action.merge_sha IS NOT NULL
          ORDER BY action.created_at DESC,action.rowid DESC
          LIMIT 1
        ) AS merge_sha
      FROM work_items child
      WHERE child.parent_work_item_id=?
      ORDER BY child.child_ordinal,child.created_at,child.work_item_id
    `).all(parentWorkItemId) as Row[]).map((row) => Object.freeze({
      workItemId: stringValue(row, "work_item_id"),
      mergeSha: row.merge_sha === null ? null : stringValue(row, "merge_sha"),
    }));
    return Object.freeze({
      parentWorkItemId,
      children: Object.freeze(children),
    });
  }

  resumeDecomposedParent(workItemId: string): WorkItem {
    const projectIds = this.decompositionFamilyProjectIds(workItemId);
    this.runtime.store.transaction(() => {
      const current = this.runtime.requireWorkItem(workItemId);
      const hasChildren = this.runtime.store.db.prepare(
        "SELECT 1 FROM work_items WHERE parent_work_item_id=? LIMIT 1",
      ).get(workItemId) !== undefined;
      if (current.state !== "parked" || !hasChildren) {
        throw conflict(
          TASK_BOARD_ERROR_CODES.WORK_ITEM_ILLEGAL_TRANSITION,
          "Only a parked decomposed parent can be resumed",
        );
      }
      const phasedFailure = this.runtime.store.db.prepare(`
        SELECT 1
        FROM park_records park
        WHERE park.work_item_id=?
          AND park.resolved_at IS NULL
          AND park.category='child_failed'
          AND EXISTS(
            SELECT 1
            FROM work_items child
            WHERE child.parent_work_item_id=? AND child.phase IS NOT NULL
          )
        LIMIT 1
      `).get(workItemId, workItemId);
      if (phasedFailure !== undefined) {
        throw conflict(
          TASK_BOARD_ERROR_CODES.PARENT_PHASED_FAILED,
          "A phased parent with a failed child cannot resume; cancel the parent instead",
        );
      }
      transitionWorkItemInTransaction(this.runtime.store, {
        workItemId,
        to: "coordinating",
        actorType: "human",
        actorId: this.runtime.config.humanPrincipal,
        now: exactNow(this.runtime.config.now),
        currentStage: null,
      });
    });
    for (const projectId of projectIds) this.reconcileWorkflowsBestEffort(projectId);
    return this.runtime.requireWorkItem(workItemId);
  }

  attestDeploy(workItemId: string, request: AttestDeployRequest): AttestDeployResult {
    const projectIds = new Set<string>();
    const result = this.runtime.store.transaction(() => {
      const workItem = this.runtime.requireWorkItem(workItemId);
      if (workItem.state !== "merged") {
        throw conflict("WORK_ITEM_NOT_MERGED", "Only merged work items can be deploy-attested");
      }
      const existing = this.runtime.store.db.prepare(`
        SELECT *
        FROM gate_actions
        WHERE work_item_id=? AND gate='deploy_attest'
        ORDER BY created_at, rowid
        LIMIT 1
      `).get(workItemId);
      let attestation: AttestDeployResult;
      if (existing !== undefined) {
        attestation = Object.freeze({
          gateAction: parseGateAction({
            gateActionId: existing.gate_action_id,
            workItemId: existing.work_item_id,
            gate: existing.gate,
            actorId: existing.actor_id,
            planRevisionId: existing.plan_revision_id,
            verifiedSha: existing.verified_sha,
            mergeSha: existing.merge_sha,
            refId: existing.ref_id,
            note: existing.note,
            createdAt: existing.created_at,
          }, "gateAction"),
          duplicate: true,
        });
      } else {
        const plan = this.runtime.store.db.prepare(`
          SELECT plan_revision_id
          FROM plan_revisions
          WHERE work_item_id=? AND state='confirmed'
          ORDER BY revision DESC
          LIMIT 1
        `).get(workItemId);
        if (plan === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:confirmed_plan_missing");
        const gateAction = this.runtime.insertGateActionInTransaction({
          workItemId,
          gate: "deploy_attest",
          actorId: this.runtime.config.humanPrincipal,
          planRevisionId: stringValue(plan, "plan_revision_id"),
          verifiedSha: null,
          mergeSha: null,
          refId: null,
          note: request.note ?? null,
        });
        attestation = Object.freeze({ gateAction, duplicate: false });
      }
      const contractCandidates = this.runtime.store.db.prepare(`
        SELECT contract.work_item_id,contract.resolved_project_id,contract.parent_work_item_id
        FROM work_items contract
        WHERE contract.phase='contract'
          AND contract.state='queued'
          AND contract.parent_work_item_id=(
            SELECT parent_work_item_id FROM work_items WHERE work_item_id=?
          )
        ORDER BY contract.child_ordinal,contract.work_item_id
      `).all(workItemId) as Row[];
      const readyContracts = contractCandidates.filter((contract) => (
        decompositionReadinessBlocker(this.runtime.store.db, stringValue(contract, "work_item_id")) === null
      ));
      for (const contract of readyContracts) {
        const contractId = stringValue(contract, "work_item_id");
        const parentId = stringValue(contract, "parent_work_item_id");
        const projectId = stringValue(contract, "resolved_project_id");
        projectIds.add(projectId);
        this.notifications.insertNotificationInTransaction({
          kind: "phase_ready",
          dedupeKey: `phase_ready:${parentId}:${contractId}`,
          projectId,
          workItemId: contractId,
          summary: `Contract phase ready: ${contractId}`,
        });
      }
      return attestation;
    });
    for (const projectId of projectIds) this.reconcileWorkflowsBestEffort(projectId);
    return result;
  }

  dependenciesFor(workItemId: string): readonly WorkItemDependency[] {
    this.runtime.requireWorkItem(workItemId);
    const dependencies = this.runtime.store.db.prepare(`
      SELECT dependency.work_item_id,dependency.depends_on_work_item_id
      FROM work_item_dependencies dependency
      JOIN work_items predecessor
        ON predecessor.work_item_id=dependency.depends_on_work_item_id
      WHERE dependency.work_item_id=?
      ORDER BY predecessor.child_ordinal,dependency.depends_on_work_item_id
    `).all(workItemId).map((row) => Object.freeze({
      workItemId: stringValue(row, "work_item_id"),
      dependsOnWorkItemId: stringValue(row, "depends_on_work_item_id"),
    }));
    return Object.freeze(dependencies);
  }

  requireWorkItem(workItemId: string): WorkItemDetail {
    const workItem = this.runtime.requireWorkItem(workItemId);
    const transitions = this.workItemTransitions(workItemId);
    const openPark = this.runtime.store.db.prepare(`
      SELECT category
      FROM park_records
      WHERE work_item_id=? AND resolved_at IS NULL
      ORDER BY parked_at DESC,rowid DESC
      LIMIT 1
    `).get(workItemId) as Row | undefined;
    const parkCategory = openPark === undefined ? null : stringValue(openPark, "category") as ParkCategory;
    const parkProjection = parkCategory === null ? {} : { parkCategory };
    if (workItem.taskType !== "onboarding") return Object.freeze({ ...workItem, transitions, ...parkProjection });
    const gapReport = this.runtime.store.db.prepare(`
      SELECT gap_report_artifact_id
      FROM work_item_onboarding_tasks
      WHERE work_item_id=?
    `).get(workItemId);
    if (gapReport === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:onboarding_detail_link");
    return Object.freeze({
      ...workItem,
      transitions,
      ...parkProjection,
      gapReportArtifactId: gapReport.gap_report_artifact_id === null
        ? null
        : stringValue(gapReport, "gap_report_artifact_id"),
    });
  }

  workItemAudit(workItemId: string): WorkItemAudit {
    this.runtime.requireWorkItem(workItemId);
    const gateActions = this.runtime.store.db.prepare(`
      SELECT *
      FROM gate_actions
      WHERE work_item_id = ?
      ORDER BY created_at, rowid
    `).all(workItemId).map((row) => this.gateActionFromRow(row));
    return Object.freeze({
      gateActions: Object.freeze(gateActions),
      transitions: this.workItemTransitions(workItemId),
    });
  }

  private workItemTransitions(workItemId: string): readonly WorkItemTransition[] {
    const transitions = this.runtime.store.db.prepare(`
      SELECT from_state, to_state, actor_type, actor_id, created_at
      FROM work_item_transitions
      WHERE work_item_id = ?
      ORDER BY sequence
    `).all(workItemId).map((row) => Object.freeze({
      fromState: row.from_state === null ? null : String(row.from_state) as WorkItemState,
      toState: String(row.to_state) as WorkItemState,
      actorType: String(row.actor_type) as "human" | "agent" | "system",
      actorId: String(row.actor_id),
      createdAt: String(row.created_at),
    }));
    return Object.freeze(transitions);
  }

  private gateActionFromRow(row: Row): GateAction {
    return parseGateAction({
      gateActionId: row.gate_action_id,
      workItemId: row.work_item_id,
      gate: row.gate,
      actorId: row.actor_id,
      planRevisionId: row.plan_revision_id,
      verifiedSha: row.verified_sha,
      mergeSha: row.merge_sha,
      refId: row.ref_id,
      note: row.note,
      createdAt: row.created_at,
    }, "gateAction");
  }

  createWorkItem(request: CreateWorkItemRequest, idempotencyKey: string): CreateWorkItemResult {
    if ((request.taskType ?? "standard") === "onboarding") {
      return this.createWorkItemAndStartPlanning(request, idempotencyKey);
    }
    return this.createWorkItemInternal(request, idempotencyKey, false);
  }

  createWorkItemAndStartPlanning(request: CreateWorkItemRequest, idempotencyKey: string): CreateWorkItemResult {
    let planning: PlanningStartResult = Object.freeze({ task: null, wakeAgentId: null });
    const taskType = request.taskType ?? "standard";
    let result: CreateWorkItemResult;
    try {
      result = this.runtime.store.transaction(() => {
        const created = this.createWorkItemInternal(request, idempotencyKey, true);
        if (created.workItem.state === "queued") {
          planning = this.startWorkItemPlanningInTransaction(created.workItem.workItemId, created.duplicate, undefined, taskType);
        }
        return Object.freeze({
          workItem: this.runtime.requireWorkItem(created.workItem.workItemId),
          duplicate: created.duplicate,
        });
      });
    } catch (error) {
      if (taskType === "onboarding" && onboardingUniqueConstraint(error)) {
        throw conflict(TASK_BOARD_ERROR_CODES.ONBOARDING_EXISTS, "This project already has an onboarding work item");
      }
      throw error;
    }
    if (planning.wakeAgentId !== null) this.runtime.wakeupEvents.emit(planning.wakeAgentId);
    return result;
  }

  private createWorkItemInternal(
    request: CreateWorkItemRequest,
    idempotencyKey: string,
    inTransaction: boolean,
  ): CreateWorkItemResult {
    const priority = request.priority ?? "normal";
    const taskType = request.taskType ?? "standard";
    const projectTarget = request.projectTarget;
    if (projectTarget === undefined || projectTarget.mode !== "explicit") {
      throw new TaskBoardError(
        400,
        taskType === "onboarding" ? TASK_BOARD_ERROR_CODES.ONBOARDING_PROJECT_REQUIRED : TASK_BOARD_ERROR_CODES.PROJECT_REQUIRED,
        "Choose a project",
      );
    }
    if (taskType === "onboarding" && this.runtime.store.db.prepare(
      "SELECT 1 FROM projects WHERE project_id=?",
    ).get(projectTarget.projectId) === undefined) {
      throw new TaskBoardError(400, TASK_BOARD_ERROR_CODES.ONBOARDING_PROJECT_REQUIRED, "Choose an existing project");
    }
    this.runtime.requireProject(projectTarget.projectId);
    const createdBy = this.runtime.config.humanPrincipal;
    const requestHash = sha256({
      action: "create_work_item",
      createdBy,
      originalRequest: request.originalRequest,
      priority,
      ...(taskType === "onboarding" ? { taskType } : {}),
      projectTarget,
    });
    const workItemId = randomUUID();
    const targetProjectId = projectTarget.projectId;
    const apply = (): CreateWorkItemResult => {
      const prior = this.runtime.store.db.prepare(`
        SELECT work_item.*,
          CASE WHEN onboarding.work_item_id IS NULL THEN 'standard' ELSE 'onboarding' END AS task_type,
          (SELECT task_id FROM work_item_planning_tasks planning WHERE planning.work_item_id=work_item.work_item_id) AS planning_task_id
        FROM work_items work_item
        LEFT JOIN work_item_onboarding_tasks onboarding ON onboarding.work_item_id=work_item.work_item_id
        WHERE created_by = ? AND idempotency_key = ?
      `).get(createdBy, idempotencyKey);
      if (prior) {
        if (stringValue(prior, "request_hash") !== requestHash) {
          throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key was used for another work item");
        }
        return Object.freeze({ workItem: workItemFromRow(prior), duplicate: true });
      }
      if (taskType === "onboarding" && this.runtime.store.db.prepare(
        "SELECT 1 FROM work_item_onboarding_tasks WHERE project_id=?",
      ).get(targetProjectId) !== undefined) {
        throw conflict(TASK_BOARD_ERROR_CODES.ONBOARDING_EXISTS, "This project already has an onboarding work item");
      }
      const now = exactNow(this.runtime.config.now);
      this.runtime.store.db.prepare(`
        INSERT INTO work_items(
          work_item_id, original_request, refined_objective, priority,
          project_target_mode, target_project_id, resolved_project_id,
          state, current_stage, created_by, idempotency_key, request_hash,
          version, created_at, updated_at, ended_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'queued', 'refinement', ?, ?, ?, 1, ?, ?, NULL)
      `).run(
        workItemId,
        request.originalRequest,
        priority,
        projectTarget.mode,
        targetProjectId,
        targetProjectId,
        createdBy,
        idempotencyKey,
        requestHash,
        now,
        now,
      );
      recordInitialWorkItemTransitionInTransaction(this.runtime.store, {
        workItemId,
        actorType: "human",
        actorId: createdBy,
        now,
      });
      return Object.freeze({ workItem: this.runtime.requireWorkItem(workItemId), duplicate: false });
    };
    return inTransaction ? apply() : this.runtime.store.transaction(apply);
  }

  startWorkItemPlanning(workItemId: string): BoardTask | null {
    const planning = this.runtime.store.transaction(() => this.startWorkItemPlanningInTransaction(workItemId, false));
    if (planning.wakeAgentId !== null) this.runtime.wakeupEvents.emit(planning.wakeAgentId);
    return planning.task;
  }

  workItemAwaitsIntakePlanning(workItemId: string): boolean {
    return workItemAwaitsIntakePlanning(this.runtime.store.db, workItemId);
  }

  startWorkItemPlanningRevisionInTransaction(workItemId: string, revisionNote: string): PlanningStartResult {
    return this.startWorkItemPlanningInTransaction(workItemId, false, revisionNote);
  }

  startWorkItemDesignInTransaction(workItemId: string): BoardTask | null {
    const workItem = this.runtime.requireWorkItem(workItemId);
    if (workItem.resolvedProjectId === null || workItem.endedAt !== null) return null;
    const existing = this.runtime.store.db.prepare(
      "SELECT task_id FROM work_item_design_tasks WHERE work_item_id=?",
    ).get(workItemId);
    if (existing !== undefined) return this.runtime.requireTask(String(existing.task_id));
    const manager = createLazyManagerInTransaction(this.runtime, workItem.resolvedProjectId);
    const confirmed = this.runtime.store.db.prepare(`
      SELECT *
      FROM plan_revisions
      WHERE work_item_id=? AND state='confirmed'
      ORDER BY revision DESC
      LIMIT 1
    `).get(workItemId);
    if (confirmed === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:confirmed_plan_missing");
    const nodes = this.runtime.store.db.prepare(`
      SELECT *
      FROM work_nodes
      WHERE plan_revision_id=?
      ORDER BY created_at,node_id
    `).all(String(confirmed.plan_revision_id)).map((node) => ({
      nodeId: String(node.node_id),
      title: String(node.title),
      objective: String(node.objective),
      acceptanceCriteria: JSON.parse(String(node.acceptance_criteria_json)) as unknown,
      dependencyNodeIds: this.runtime.store.db.prepare(`
        SELECT dependency_node_id
        FROM work_node_dependencies
        WHERE node_id=?
        ORDER BY dependency_node_id
      `).all(String(node.node_id)).map((dependency) => String(dependency.dependency_node_id)),
      stageTemplate: JSON.parse(String(node.stage_template_json)) as unknown,
    }));
    const confirmedPlanRecord = {
      planRevisionId: String(confirmed.plan_revision_id),
      workItemId,
      revision: Number(confirmed.revision),
      objective: String(confirmed.objective),
      assumptions: JSON.parse(String(confirmed.assumptions_json)) as unknown,
      acceptanceCriteria: JSON.parse(String(confirmed.acceptance_criteria_json)) as unknown,
      changeShape: confirmed.change_shape === null ? null : String(confirmed.change_shape),
      tier: confirmed.tier === null ? null : String(confirmed.tier),
      declaredScope: confirmed.declared_scope_json === null
        ? null
        : JSON.parse(String(confirmed.declared_scope_json)) as unknown,
      nonGoals: confirmed.non_goals_json === null
        ? null
        : JSON.parse(String(confirmed.non_goals_json)) as unknown,
      mechanicalPortions: confirmed.mechanical_portions_json === null
        ? null
        : JSON.parse(String(confirmed.mechanical_portions_json)) as unknown,
      blockingQuestions: confirmed.blocking_questions_json === null
        ? null
        : JSON.parse(String(confirmed.blocking_questions_json)) as unknown,
      criterionChecks: confirmed.criterion_checks_json === null
        ? null
        : JSON.parse(String(confirmed.criterion_checks_json)) as unknown,
      projectId: String(confirmed.project_id),
      skillDigests: JSON.parse(String(confirmed.skill_digests_json)) as unknown,
      state: "confirmed",
      createdBy: String(confirmed.created_by),
      createdAt: String(confirmed.created_at),
      confirmedBy: confirmed.confirmed_by === null ? null : String(confirmed.confirmed_by),
      confirmedAt: confirmed.confirmed_at === null ? null : String(confirmed.confirmed_at),
      nodes,
    };
    const managerId = manager.agentId;
    const workItemTitle = workItemTitleProjection(workItem);
    const task = this.tasks.createTaskInTransaction(workItem.resolvedProjectId, {
      parentTaskId: null,
      title: `Design workflow: ${workItemTitle}`,
      objective: `${JSON.stringify(confirmedPlanRecord)}\n\n${workItem.originalRequest}`,
      acceptanceCriteria: "Return a valid designRecord covering all six hazardous failure points. Never write code.",
      workspaceRefs: [],
      assignedAgentId: managerId,
      assignedRole: "manager",
      requiresReview: false,
    });
    const now = exactNow(this.runtime.config.now);
    this.runtime.store.db.prepare("INSERT INTO work_item_design_tasks VALUES(?,?,?)").run(workItemId, task.taskId, now);
    this.runtime.store.afterCommit(() => this.runtime.wakeupEvents.emit(managerId));
    return task;
  }

  private startWorkItemPlanningInTransaction(
    workItemId: string,
    repairLegacyOrphan: boolean,
    revisionNote?: string,
    requestedTaskType?: WorkItemTaskType,
  ): PlanningStartResult {
    const workItem = this.runtime.requireWorkItem(workItemId);
    if (workItem.resolvedProjectId === null || workItem.endedAt !== null) {
      return Object.freeze({ task: null, wakeAgentId: null });
    }
    const existing = this.runtime.store.db.prepare("SELECT task_id FROM work_item_planning_tasks WHERE work_item_id=?").get(workItemId);
    if (existing && revisionNote === undefined) {
      return Object.freeze({ task: this.runtime.requireTask(String(existing.task_id)), wakeAgentId: null });
    }
    if (revisionNote === undefined && !this.workItemAwaitsIntakePlanning(workItemId)) {
      return Object.freeze({ task: null, wakeAgentId: null });
    }
    if (existing) {
      const priorTask = this.runtime.requireTask(String(existing.task_id));
      if (!isHardTerminalTaskStatus(priorTask.status)) {
        throw conflict("PLAN_REVISION_NOT_READY", "The prior planning task has not completed");
      }
      this.runtime.store.db.prepare("DELETE FROM work_item_planning_tasks WHERE work_item_id=?").run(workItemId);
    }
    const manager = createLazyManagerInTransaction(this.runtime, workItem.resolvedProjectId);
    const managerId = manager.agentId;
    const onboarding = requestedTaskType === "onboarding" || workItem.taskType === "onboarding";
    const project = onboarding ? this.runtime.requireProject(workItem.resolvedProjectId) : null;
    const configuration = this.automation.getConfiguration();
    const enabledTypes = new Set(configuration.agentTypes.filter((agentType) => agentType.enabled).map((agentType) => agentType.agentTypeId));
    const availableStages = configuration.stages.flatMap((stage) =>
      stage.executor.kind === "machine_verify" ||
      stage.executor.kind === "agent_type" && enabledTypes.has(stage.executor.agentTypeId) ? [stage.stage] : []);
    const taskRequest = {
      parentTaskId: null,
      title: `Plan workflow: ${workItem.originalRequest.slice(0, 160)}`,
      objective: onboarding
        ? revisionNote === undefined
          ? `Onboard project: ${project!.name}`
          : `Prior plan rejected: ${redactForPersistence(revisionNote)}\n\nOnboard project: ${project!.name}`
        : revisionNote === undefined
          ? workItem.originalRequest
          : `Prior plan rejected: ${redactForPersistence(revisionNote)}\n\n${workItem.originalRequest}`,
      acceptanceCriteria: onboarding
        ? ONBOARDING_ACCEPTANCE_CRITERIA
        : `${PLANNING_ACCEPTANCE_CRITERIA_PREFIX}${availableStages.join(", ") || "none configured"}.`,
      workspaceRefs: [],
      assignedAgentId: managerId,
      assignedRole: "manager",
      requiresReview: false,
    } as const;
    const orphan = repairLegacyOrphan ? this.runtime.store.db.prepare(`
      SELECT task.task_id
      FROM tasks task
      WHERE task.project_id=?
        AND task.parent_task_id IS NULL
        AND task.task_kind='work'
        AND task.required_role IS NULL
        AND task.requires_review=0
        AND task.title=?
        AND task.objective=?
        AND substr(task.acceptance_criteria,1,?)=?
        AND task.workspace_refs_json='[]'
        AND task.assigned_agent_id=?
        AND task.assigned_role='manager'
        AND task.ended_at IS NULL
        AND task.status IN ('queued','in_progress')
        AND NOT EXISTS(
          SELECT 1 FROM work_item_planning_tasks link WHERE link.task_id=task.task_id
        )
        AND (
          EXISTS(
            SELECT 1
            FROM wakeups wakeup
            WHERE wakeup.task_id=task.task_id
              AND wakeup.project_id=task.project_id
              AND wakeup.agent_id=task.assigned_agent_id
              AND wakeup.claimed_at IS NULL
              AND task.status='queued'
              AND NOT EXISTS(
                SELECT 1 FROM task_events event
                WHERE event.event_id=? || wakeup.wakeup_id
              )
          )
          OR EXISTS(
            SELECT 1
            FROM runs run
            WHERE run.task_id=task.task_id
              AND run.project_id=task.project_id
              AND run.agent_id=task.assigned_agent_id
              AND run.status='active'
          )
        )
      ORDER BY task.order_key,task.task_id
      LIMIT 1
    `).get(
      workItem.resolvedProjectId,
      taskRequest.title,
      taskRequest.objective,
      (onboarding ? ONBOARDING_ACCEPTANCE_CRITERIA : PLANNING_ACCEPTANCE_CRITERIA_PREFIX).length,
      onboarding ? ONBOARDING_ACCEPTANCE_CRITERIA : PLANNING_ACCEPTANCE_CRITERIA_PREFIX,
      managerId,
      RETIRED_WAKEUP_EVENT_PREFIX,
    ) : undefined;
    const task = orphan
      ? this.runtime.requireTask(String(orphan.task_id))
      : this.tasks.createTaskInTransaction(workItem.resolvedProjectId, taskRequest);
    const now = exactNow(this.runtime.config.now);
    this.runtime.store.db.prepare("INSERT INTO work_item_planning_tasks VALUES(?,?,?)").run(workItemId, task.taskId, now);
    if (onboarding) {
      const onboardingLink = this.runtime.store.db.prepare(
        "SELECT 1 FROM work_item_onboarding_tasks WHERE work_item_id=?",
      ).get(workItemId);
      if (onboardingLink === undefined) {
        this.runtime.store.db.prepare(`
          INSERT INTO work_item_onboarding_tasks(work_item_id,project_id,task_id,created_at)
          VALUES(?,?,?,?)
        `).run(workItemId, workItem.resolvedProjectId, task.taskId, now);
      } else {
        this.runtime.store.db.prepare(
          "UPDATE work_item_onboarding_tasks SET task_id=? WHERE work_item_id=?",
        ).run(task.taskId, workItemId);
      }
    }
    transitionWorkItemInTransaction(this.runtime.store, {
      workItemId,
      to: "planning",
      actorType: "system",
      actorId: "system:planning",
      now,
      currentStage: "planning",
    });
    return Object.freeze({ task, wakeAgentId: orphan ? null : managerId });
  }

  updateWorkItem(workItemId: string, request: UpdateWorkItemRequest): WorkItem {
    if (request.action === "cancel") return this.cancelWorkItem(workItemId, request.version, request.reason);
    if (request.action === "archive") return this.archiveWorkItem(workItemId, request.version);
    return this.runtime.store.transaction(() => {
      if (request.priority === undefined && request.projectTarget === undefined) {
        throw new TaskBoardError(400, "INVALID_REQUEST", "Work item update contains no changes");
      }
      const current = this.runtime.requireWorkItem(workItemId);
      if (current.version !== request.version) throw conflict("WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
      if (current.endedAt !== null) throw conflict("WORK_ITEM_TERMINAL", "Terminal work items are immutable");
      if (
        request.projectTarget !== undefined &&
        (current.state !== "queued" || current.parentWorkItemId !== null)
      ) {
        throw conflict("WORK_ITEM_TARGET_LOCKED", "Project target cannot change after intake begins processing");
      }
      const projectTarget = request.projectTarget ?? current.projectTarget;
      if (projectTarget.mode === "explicit") this.runtime.requireProject(projectTarget.projectId);
      const targetProjectId = projectTarget.mode === "explicit" ? projectTarget.projectId : null;
      const resolvedProjectId = request.projectTarget === undefined
        ? current.resolvedProjectId
        : targetProjectId;
      const now = exactNow(this.runtime.config.now);
      const nextVersion = current.version + 1;
      const update = this.runtime.store.db.prepare(`
        UPDATE
          work_items
        SET
          priority = ?, project_target_mode = ?, target_project_id = ?, resolved_project_id = ?,
          version = ?, updated_at = ?
        WHERE work_item_id = ? AND version = ? AND ended_at IS NULL
      `).run(
        request.priority ?? current.priority,
        projectTarget.mode,
        targetProjectId,
        resolvedProjectId,
        nextVersion,
        now,
        workItemId,
        current.version,
      );
      if (Number(update.changes) !== 1) throw conflict("WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
      return this.runtime.requireWorkItem(workItemId);
    });
  }

  closeWorkItemWorkInTransaction(
    workItemId: string,
    reason: string,
    actor: { type: "human" | "agent" | "system"; id: string },
    now: string,
    terminateActiveRuns = false,
  ): void {
    const persistedReason = redactForPersistence(reason);
    let cleanupFailure: unknown | null = null;
    retireOpenVerifyAttemptsForWorkItemInTransaction(this.runtime, workItemId, persistedReason, now);
    const linkedTasks = this.runtime.store.db.prepare(`
      SELECT task_id
      FROM (
        SELECT task_id
        FROM work_item_planning_tasks
        WHERE work_item_id=?
        UNION
        SELECT task_id
        FROM work_item_design_tasks
        WHERE work_item_id=?
        UNION
        SELECT attempt.task_id
        FROM stage_attempts AS attempt
        JOIN work_nodes AS node ON node.node_id=attempt.node_id
        JOIN plan_revisions AS plan ON plan.plan_revision_id=node.plan_revision_id
        WHERE plan.work_item_id=?
      )
      ORDER BY task_id
    `).all(workItemId, workItemId, workItemId);
    for (const linked of linkedTasks) {
      const taskId = stringValue(linked, "task_id");
      if (terminateActiveRuns) {
        const runIds = this.runtime.store.db.prepare(`
          SELECT run_id
          FROM runs
          WHERE task_id=? AND status='active'
          ORDER BY started_at,run_id
        `).all(taskId).map((row) => stringValue(row, "run_id"));
        if (runIds.length > 0 && this.#suspendActiveRunInTransaction === undefined) {
          throw new Error("TASK_BOARD_PARENT_TERMINATION_RUN_SUSPENDER_MISSING");
        }
        for (const runId of runIds) {
          try {
            this.#suspendActiveRunInTransaction!(runId, persistedReason, actor, now);
          } catch (error) {
            this.#suspendActiveRunInTransaction!(
              runId,
              persistedReason,
              actor,
              now,
              { skipAttemptNodeSuspension: true },
            );
            const durable = this.runtime.store.db.prepare(`
              SELECT run.status,run.ended_at,
                EXISTS(
                  SELECT 1 FROM interrupts interrupt
                  WHERE interrupt.run_id=run.run_id
                    AND interrupt.idempotency_key='suspend:' || run.run_id
                ) AS interrupted
              FROM runs run
              WHERE run.run_id=?
            `).get(runId);
            if (
              durable?.status !== "interrupted" ||
              durable.ended_at === null ||
              Number(durable.interrupted) !== 1
            ) {
              throw new Error("TASK_BOARD_PARENT_TERMINATION_DURABLE_RUN_FALLBACK_FAILED", { cause: error });
            }
            cleanupFailure ??= error;
          }
        }
      }
      const task = this.runtime.requireTask(taskId);
      if (!isHardTerminalTaskStatus(task.status)) {
        const taskUpdate = this.runtime.store.db.prepare(`
          UPDATE tasks
          SET status='cancelled',started_at=COALESCE(started_at,?),ended_at=?,result=?,version=version+1,updated_at=?
          WHERE task_id=? AND version=? AND status NOT IN ('completed','cancelled')
        `).run(now, now, persistedReason, now, task.taskId, task.version);
        if (Number(taskUpdate.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Planning task version changed");
        this.runtime.reconcileTaskPhasesForTerminal(task, "cancelled", actor, now);
        this.runtime.retirePendingWakeupsForTask(task.taskId, "task_cancelled", now);
        this.runtime.insertEvent(
          task.projectId,
          task.taskId,
          actor,
          "task_updated",
          {
            kind: task.kind,
            requiredRole: task.requiredRole,
            previousVersion: task.version,
            version: task.version + 1,
            status: "cancelled",
            assignedAgentId: task.assignedAgentId,
            result: persistedReason,
          },
          now,
        );
      }
      const openQuestions = this.runtime.store.db.prepare(
        "SELECT question_id FROM questions WHERE task_id=? AND status='open' ORDER BY asked_at,question_id",
      ).all(task.taskId);
      const closedAnswer = `Closed because the work item was cancelled: ${persistedReason}`;
      const closedQuestions = this.runtime.store.db.prepare(`
        UPDATE questions
        SET status='answered',answer=?,answered_at=?,answered_by=?,version=version+1
        WHERE task_id=? AND status='open'
      `).run(closedAnswer, now, actor.id, task.taskId);
      if (Number(closedQuestions.changes) !== openQuestions.length) {
        throw conflict("QUESTION_VERSION_CONFLICT", "Planning questions changed while the work item was cancelled");
      }
      for (const question of openQuestions) {
        this.runtime.insertEvent(
          task.projectId,
          task.taskId,
          actor,
          "human_question_closed",
          {
            questionId: stringValue(question, "question_id"),
            workItemId,
            reason: "work_item_cancelled",
          },
          now,
        );
      }
    }
    if (cleanupFailure !== null) throw cleanupFailure;
  }

  private cancelChildrenForParentTerminationInTransaction(input: Readonly<{
    parentWorkItemId: string;
    state: "abandoned" | "dead_letter";
    actorType: "human" | "agent" | "system";
    actorId: string;
    now: string;
  }>): void {
    const children = this.runtime.store.db.prepare(`
      SELECT work_item_id,state
      FROM work_items
      WHERE parent_work_item_id=?
      ORDER BY child_ordinal,created_at,work_item_id
    `).all(input.parentWorkItemId) as Row[];
    const note = `parent ${input.parentWorkItemId} ${input.state}`;
    for (const child of children) {
      if (isTerminalWorkItemState(String(child.state) as WorkItemState)) continue;
      const childWorkItemId = String(child.work_item_id);
      const actor = { type: input.actorType, id: input.actorId } as const;
      let abandoned: WorkItem | null = null;
      try {
        abandoned = this.cancelWorkItemInTransaction({
          workItemId: childWorkItemId,
          reason: note,
          actor,
          now: input.now,
          refId: input.parentWorkItemId,
          terminateActiveRuns: true,
        });
      } catch (error) {
        this.recordChildCancellationFailureInTransaction(input, childWorkItemId, error);
        let current: WorkItem;
        try {
          current = this.runtime.requireWorkItem(childWorkItemId);
        } catch (inspectionError) {
          this.logChildCancellationFailure(
            input.parentWorkItemId,
            childWorkItemId,
            inspectionError,
            "fallback",
          );
          continue;
        }
        if (isTerminalWorkItemState(current.state)) {
          abandoned = current;
        } else {
          try {
            abandoned = this.cancelWorkItemInTransaction({
              workItemId: childWorkItemId,
              reason: note,
              actor,
              now: input.now,
              refId: input.parentWorkItemId,
              terminateActiveRuns: true,
            });
          } catch (fallbackError) {
            this.logChildCancellationFailure(input.parentWorkItemId, childWorkItemId, fallbackError, "fallback");
            try {
              transitionWorkItemInTransaction(this.runtime.store, {
                workItemId: childWorkItemId,
                to: "abandoned",
                actorType: actor.type,
                actorId: actor.id,
                now: input.now,
                endedAt: input.now,
                cancelledReason: note,
                currentStage: null,
              });
              abandoned = this.runtime.requireWorkItem(childWorkItemId);
            } catch (terminalError) {
              this.logChildCancellationFailure(
                input.parentWorkItemId,
                childWorkItemId,
                terminalError,
                "terminal-fallback",
              );
            }
          }
        }
      }
      if (abandoned === null) continue;
      try {
        this.notifications.insertNotificationAtInTransaction({
          kind: "park_auto_abandoned",
          dedupeKey: `park_auto_abandoned:${abandoned.workItemId}:${input.parentWorkItemId}`,
          projectId: abandoned.resolvedProjectId,
          workItemId: abandoned.workItemId,
          summary: `Child auto-abandoned after parent ${input.parentWorkItemId} ${input.state}: ${abandoned.workItemId}`,
        }, input.now);
      } catch (error) {
        this.recordChildCancellationFailureInTransaction(input, childWorkItemId, error);
      }
    }
  }

  private recordChildCancellationFailureInTransaction(
    input: Readonly<{
      parentWorkItemId: string;
      state: "abandoned" | "dead_letter";
      actorType: "human" | "agent" | "system";
      actorId: string;
      now: string;
    }>,
    childWorkItemId: string,
    error: unknown,
  ): void {
    const message = safeErrorDetail(error, "Child cancellation cleanup failed");
    this.logChildCancellationFailure(input.parentWorkItemId, childWorkItemId, error, "primary");
    try {
      const child = this.runtime.requireWorkItem(childWorkItemId);
      if (child.resolvedProjectId === null) return;
      this.runtime.insertEvent(
        child.resolvedProjectId,
        null,
        { type: input.actorType, id: input.actorId },
        "work_item_cancellation_cleanup_failed",
        {
          parentWorkItemId: input.parentWorkItemId,
          childWorkItemId,
          parentTerminalState: input.state,
          message,
        },
        input.now,
      );
    } catch (recordingError) {
      this.logChildCancellationFailure(
        input.parentWorkItemId,
        childWorkItemId,
        recordingError,
        "recording",
      );
    }
  }

  private logChildCancellationFailure(
    parentWorkItemId: string,
    childWorkItemId: string,
    error: unknown,
    phase: "primary" | "fallback" | "terminal-fallback" | "recording",
  ): void {
    const message = safeErrorDetail(error, "Child cancellation cleanup failed");
    const sourceStack = error instanceof Error ? error.stack ?? message : message;
    try {
      console.error("[task-board] child cancellation cleanup failed", Object.freeze({
        parentWorkItemId: redactForPersistence(parentWorkItemId, 200),
        childWorkItemId: redactForPersistence(childWorkItemId, 200),
        phase,
        message,
        stack: redactMultilineForPersistence(sourceStack, 8_000),
      }));
    } catch {
      // Parent termination remains authoritative even if diagnostics fail.
    }
  }

  private cancelWorkItemInTransaction(input: Readonly<{
    workItemId: string;
    reason: string;
    actor: { type: "human" | "agent" | "system"; id: string };
    now: string;
    refId: string | null;
    terminateActiveRuns: boolean;
  }>): WorkItem {
    const current = this.runtime.requireWorkItem(input.workItemId);
    if (current.endedAt !== null) throw conflict("WORK_ITEM_TERMINAL", "Terminal work items are immutable");
    const persistedReason = redactForPersistence(input.reason);
    let planningProjectId: string | null = current.resolvedProjectId;
    if (current.planningTaskId !== null) {
      const planningTask = this.runtime.requireTask(current.planningTaskId);
      planningProjectId = planningTask.projectId;
    }
    this.closeWorkItemWorkInTransaction(
      input.workItemId,
      persistedReason,
      input.actor,
      input.now,
      input.terminateActiveRuns,
    );
    if (planningProjectId !== null) {
      this.runtime.insertEvent(
        planningProjectId,
        current.planningTaskId,
        input.actor,
        "work_item_cancelled",
        {
          workItemId: input.workItemId,
          previousState: current.state,
          previousVersion: current.version,
          reason: persistedReason,
        },
        input.now,
      );
    }
    transitionWorkItemInTransaction(this.runtime.store, {
      workItemId: input.workItemId,
      to: "abandoned",
      actorType: input.actor.type,
      actorId: input.actor.id,
      now: input.now,
      endedAt: input.now,
      cancelledReason: persistedReason,
      currentStage: null,
    });
    this.runtime.insertGateActionInTransaction({
      workItemId: input.workItemId,
      gate: "cancel",
      actorId: input.actor.id,
      planRevisionId: null,
      verifiedSha: null,
      mergeSha: null,
      refId: input.refId,
      note: persistedReason,
    });
    return this.runtime.requireWorkItem(input.workItemId);
  }

  private cancelWorkItem(workItemId: string, version: number, reason: string): WorkItem {
    const persistedReason = redactForPersistence(reason);
    const projectIds = this.decompositionFamilyProjectIds(workItemId);
    const cancelled = this.runtime.store.transaction(() => {
      const current = this.runtime.requireWorkItem(workItemId);
      if (current.state === "abandoned") {
        if (current.version === version + 1 && current.cancelledReason === persistedReason) return current;
        throw conflict("WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
      }
      if (current.version !== version) throw conflict("WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
      if (current.endedAt !== null) throw conflict("WORK_ITEM_TERMINAL", "Terminal work items are immutable");
      const now = exactNow(this.runtime.config.now);
      const actor = { type: "human" as const, id: this.runtime.config.humanPrincipal };
      return this.cancelWorkItemInTransaction({
        workItemId,
        reason: persistedReason,
        actor,
        now,
        refId: null,
        terminateActiveRuns: true,
      });
    });
    for (const projectId of projectIds) this.reconcileWorkflowsBestEffort(projectId);
    return cancelled;
  }

  private decompositionFamilyProjectIds(parentWorkItemId: string): ReadonlySet<string> {
    return new Set((this.runtime.store.db.prepare(`
      SELECT project.project_id
      FROM projects project
      WHERE ${decompositionFamilyTouchesProjectSql("?", "project.project_id")}
      ORDER BY project.project_id
    `).all(parentWorkItemId, parentWorkItemId) as Row[]).map((row) => stringValue(row, "project_id")));
  }

  private archiveWorkItem(workItemId: string, version: number): WorkItem {
    return this.runtime.store.transaction(() => {
      const current = this.runtime.requireWorkItem(workItemId);
      if (current.archivedAt !== null) return current;
      if (current.endedAt === null) {
        throw conflict(TASK_BOARD_ERROR_CODES.WORK_ITEM_NOT_TERMINAL, "Only terminal work items can be archived");
      }
      if (current.version !== version) throw conflict("WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
      const now = exactNow(this.runtime.config.now);
      const update = this.runtime.store.db.prepare(`
        UPDATE
          work_items
        SET archived_at=?,version=version+1,updated_at=?
        WHERE work_item_id=? AND version=? AND ended_at IS NOT NULL AND archived_at IS NULL
      `).run(now, now, workItemId, current.version);
      if (Number(update.changes) !== 1) throw conflict("WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
      return this.runtime.requireWorkItem(workItemId);
    });
  }
}
