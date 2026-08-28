import { randomUUID } from "node:crypto";
import {
  TASK_BOARD_ERROR_CODES,
  WORK_ITEM_PAGE_SIZE,
  isHardTerminalTaskStatus,
  type BoardTask,
  type CreateWorkItemRequest,
  type GateAction,
  type UpdateWorkItemRequest,
  type WorkItem,
  type WorkItemAudit,
  type WorkItemPage,
  type WorkItemState,
  type WorkItemTaskType,
  type WorkItemTransition,
} from "#shared/task-board-contract";
import { parseGateAction } from "#shared/task-board-contract/validate";
import { redactForPersistence } from "../../shared/redact.js";
import { sha256 } from "../canonical.js";
import { conflict, TaskBoardError } from "../errors.js";
import { RETIRED_WAKEUP_EVENT_PREFIX } from "../persistence/workflow.js";
import { decodeWorkItemCursor, encodeWorkItemCursor } from "../persistence/work-item-cursor.js";
import { workItemPriorityCases } from "../persistence/store.js";
import { stringValue, workItemFromRow, type Row } from "../persistence/rows.js";
import { exactNow } from "../persistence/timestamps.js";
import type { AutomationCollaborator } from "./automation.js";
import type { TaskBoardRuntime } from "./runtime.js";
import type { TasksCollaborator } from "./tasks.js";
import { createLazyManagerInTransaction } from "./agent-identities.js";
import {
  recordInitialWorkItemTransitionInTransaction,
  transitionWorkItemInTransaction,
} from "./work-item-transitions.js";

export type CreateWorkItemResult = Readonly<{ workItem: WorkItem; duplicate: boolean }>;
export type WorkItemDetail = WorkItem & Readonly<{
  transitions: readonly WorkItemTransition[];
  gapReportArtifactId?: string | null;
}>;
type PlanningStartResult = Readonly<{ task: BoardTask | null; wakeAgentId: string | null }>;

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
  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly automation: AutomationCollaborator,
    private readonly tasks: TasksCollaborator,
    private readonly reconcileWorkflowsBestEffort: (projectId: string) => void = () => undefined,
  ) {}

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

  requireWorkItem(workItemId: string): WorkItemDetail {
    const workItem = this.runtime.requireWorkItem(workItemId);
    const transitions = this.workItemTransitions(workItemId);
    if (workItem.taskType !== "onboarding") return Object.freeze({ ...workItem, transitions });
    const gapReport = this.runtime.store.db.prepare(`
      SELECT gap_report_artifact_id
      FROM work_item_onboarding_tasks
      WHERE work_item_id=?
    `).get(workItemId);
    if (gapReport === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:onboarding_detail_link");
    return Object.freeze({
      ...workItem,
      transitions,
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
      if (request.projectTarget !== undefined && current.state !== "queued") {
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
    actor: { type: "human" | "system"; id: string },
    now: string,
  ): void {
    const persistedReason = redactForPersistence(reason);
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
      const task = this.runtime.requireTask(stringValue(linked, "task_id"));
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
  }

  private cancelWorkItem(workItemId: string, version: number, reason: string): WorkItem {
    const persistedReason = redactForPersistence(reason);
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
      let planningProjectId: string | null = current.resolvedProjectId;
      if (current.planningTaskId !== null) {
        const planningTask = this.runtime.requireTask(current.planningTaskId);
        planningProjectId = planningTask.projectId;
      }
      this.closeWorkItemWorkInTransaction(workItemId, reason, actor, now);
      if (planningProjectId !== null) {
        this.runtime.insertEvent(
          planningProjectId,
          current.planningTaskId,
          actor,
          "work_item_cancelled",
          {
            workItemId,
            previousState: current.state,
            previousVersion: current.version,
            reason: persistedReason,
          },
          now,
        );
      }
      transitionWorkItemInTransaction(this.runtime.store, {
        workItemId,
        to: "abandoned",
        actorType: "human",
        actorId: this.runtime.config.humanPrincipal,
        now,
        endedAt: now,
        cancelledReason: persistedReason,
        currentStage: null,
      });
      this.runtime.insertGateActionInTransaction({
        workItemId,
        gate: "cancel",
        actorId: this.runtime.config.humanPrincipal,
        planRevisionId: null,
        verifiedSha: null,
        mergeSha: null,
        refId: null,
        note: persistedReason,
      });
      return this.runtime.requireWorkItem(workItemId);
    });
    if (cancelled.resolvedProjectId !== null) {
      this.reconcileWorkflowsBestEffort(cancelled.resolvedProjectId);
    }
    return cancelled;
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
