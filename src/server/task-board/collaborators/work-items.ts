import { randomUUID } from "node:crypto";
import {
  WORK_ITEM_PAGE_SIZE,
  type BoardTask,
  type CreateWorkItemRequest,
  type UpdateWorkItemRequest,
  type WorkItem,
  type WorkItemPage,
} from "#shared/task-board-contract";
import { sha256 } from "../canonical.js";
import { conflict, TaskBoardError } from "../errors.js";
import { RETIRED_WAKEUP_EVENT_PREFIX } from "../persistence/retired-wakeups.js";
import { decodeWorkItemCursor, encodeWorkItemCursor } from "../persistence/work-item-cursor.js";
import { stringValue, workItemFromRow } from "../persistence/rows.js";
import { exactNow } from "../persistence/timestamps.js";
import type { AutomationCollaborator } from "./automation.js";
import type { TaskBoardRuntime } from "./runtime.js";
import type { TasksCollaborator } from "./tasks.js";

export type CreateWorkItemResult = Readonly<{ workItem: WorkItem; duplicate: boolean }>;
type PlanningStartResult = Readonly<{ task: BoardTask | null; wakeAgentId: string | null }>;

const PLANNING_ACCEPTANCE_CRITERIA_PREFIX = "Return a concise workflowPlan with explicit acceptance criteria, acyclic dependencies, and unique stage sequences ending in verification. Available automated stages: ";
const WORK_ITEM_TERMINAL_RANK_SQL = "(ended_at IS NOT NULL)";
const WORK_ITEM_PRIORITY_RANK_SQL = `CASE priority
  WHEN 'urgent' THEN 0
  WHEN 'high' THEN 1
  WHEN 'normal' THEN 2
  WHEN 'low' THEN 3
  WHEN 'opportunistic' THEN 4
END`;

export class WorkItemsCollaborator {
  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly automation: AutomationCollaborator,
    private readonly tasks: TasksCollaborator,
  ) {}

  listWorkItemsPage(cursor?: string): WorkItemPage {
    const tuple = cursor === undefined ? null : decodeWorkItemCursor(cursor);
    const select = `
      SELECT *,
        ${WORK_ITEM_TERMINAL_RANK_SQL} AS work_item_terminal_rank,
        ${WORK_ITEM_PRIORITY_RANK_SQL} AS work_item_priority_rank
      FROM work_items
    `;
    const orderAndLimit = `
      ORDER BY
        ${WORK_ITEM_TERMINAL_RANK_SQL},
        ${WORK_ITEM_PRIORITY_RANK_SQL},
        created_at,
        work_item_id
      LIMIT ${WORK_ITEM_PAGE_SIZE + 1}
    `;
    const rows = tuple === null
      ? this.runtime.store.db.prepare(`${select} ${orderAndLimit}`).all()
      : this.runtime.store.db.prepare(`
          ${select}
          WHERE (
            ${WORK_ITEM_TERMINAL_RANK_SQL},
            ${WORK_ITEM_PRIORITY_RANK_SQL},
            created_at,
            work_item_id
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

  listWorkItems(): readonly WorkItem[] {
    return this.listWorkItemsPage().workItems;
  }

  requireWorkItem(workItemId: string): WorkItem {
    return this.runtime.requireWorkItem(workItemId);
  }

  createWorkItem(request: CreateWorkItemRequest, idempotencyKey: string): CreateWorkItemResult {
    return this.createWorkItemInternal(request, idempotencyKey, false);
  }

  createWorkItemAndStartPlanning(request: CreateWorkItemRequest, idempotencyKey: string): CreateWorkItemResult {
    let planning: PlanningStartResult = Object.freeze({ task: null, wakeAgentId: null });
    const result = this.runtime.store.transaction(() => {
      const created = this.createWorkItemInternal(request, idempotencyKey, true);
      if (created.workItem.state === "submitted") {
        planning = this.startWorkItemPlanningInTransaction(created.workItem.workItemId, created.duplicate);
      }
      return Object.freeze({
        workItem: this.runtime.requireWorkItem(created.workItem.workItemId),
        duplicate: created.duplicate,
      });
    });
    if (planning.wakeAgentId !== null) this.runtime.wakeupEvents.emit(planning.wakeAgentId);
    return result;
  }

  private createWorkItemInternal(
    request: CreateWorkItemRequest,
    idempotencyKey: string,
    inTransaction: boolean,
  ): CreateWorkItemResult {
    const priority = request.priority ?? "normal";
    const projectTarget = request.projectTarget ?? Object.freeze({ mode: "auto" as const });
    if (projectTarget.mode === "explicit") this.runtime.requireProject(projectTarget.projectId);
    const createdBy = this.runtime.config.humanPrincipal;
    const requestHash = sha256({
      action: "create_work_item",
      createdBy,
      originalRequest: request.originalRequest,
      priority,
      projectTarget,
    });
    const workItemId = randomUUID();
    const targetProjectId = projectTarget.mode === "explicit" ? projectTarget.projectId : null;
    const apply = (): CreateWorkItemResult => {
      const prior = this.runtime.store.db.prepare(`
        SELECT * FROM work_items WHERE created_by = ? AND idempotency_key = ?
      `).get(createdBy, idempotencyKey);
      if (prior) {
        if (stringValue(prior, "request_hash") !== requestHash) {
          throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key was used for another work item");
        }
        return Object.freeze({ workItem: workItemFromRow(prior), duplicate: true });
      }
      const now = exactNow(this.runtime.config.now);
      this.runtime.store.db.prepare(`
        INSERT INTO work_items(
          work_item_id, original_request, refined_objective, priority,
          project_target_mode, target_project_id, resolved_project_id,
          state, current_stage, created_by, idempotency_key, request_hash,
          version, created_at, updated_at, ended_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'submitted', 'refinement', ?, ?, ?, 1, ?, ?, NULL)
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
      return Object.freeze({ workItem: this.runtime.requireWorkItem(workItemId), duplicate: false });
    };
    return inTransaction ? apply() : this.runtime.store.transaction(apply);
  }

  startWorkItemPlanning(workItemId: string): BoardTask | null {
    const planning = this.runtime.store.transaction(() => this.startWorkItemPlanningInTransaction(workItemId, false));
    if (planning.wakeAgentId !== null) this.runtime.wakeupEvents.emit(planning.wakeAgentId);
    return planning.task;
  }

  private startWorkItemPlanningInTransaction(workItemId: string, repairLegacyOrphan: boolean): PlanningStartResult {
    const workItem = this.runtime.requireWorkItem(workItemId);
    if (workItem.resolvedProjectId === null || workItem.endedAt !== null) {
      return Object.freeze({ task: null, wakeAgentId: null });
    }
    const existing = this.runtime.store.db.prepare("SELECT task_id FROM work_item_planning_tasks WHERE work_item_id=?").get(workItemId);
    if (existing) {
      return Object.freeze({ task: this.runtime.requireTask(String(existing.task_id)), wakeAgentId: null });
    }
    const managers = this.runtime.store.db.prepare(
      "SELECT agent_id FROM agents WHERE project_id=? AND role='manager' ORDER BY created_at,agent_id",
    ).all(workItem.resolvedProjectId);
    if (managers.length !== 1) return Object.freeze({ task: null, wakeAgentId: null });
    const managerId = String(managers[0]!.agent_id);
    const configuration = this.automation.getConfiguration();
    const enabledTypes = new Set(configuration.agentTypes.filter((agentType) => agentType.enabled).map((agentType) => agentType.agentTypeId));
    const availableStages = configuration.stages.flatMap((stage) =>
      stage.executor.kind === "agent_type" && enabledTypes.has(stage.executor.agentTypeId) ? [stage.stage] : []);
    const taskRequest = {
      parentTaskId: null,
      title: `Plan workflow: ${workItem.originalRequest.slice(0, 160)}`,
      objective: workItem.originalRequest,
      acceptanceCriteria: `${PLANNING_ACCEPTANCE_CRITERIA_PREFIX}${availableStages.join(", ") || "none configured"}.`,
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
      PLANNING_ACCEPTANCE_CRITERIA_PREFIX.length,
      PLANNING_ACCEPTANCE_CRITERIA_PREFIX,
      managerId,
      RETIRED_WAKEUP_EVENT_PREFIX,
    ) : undefined;
    const task = orphan
      ? this.runtime.requireTask(String(orphan.task_id))
      : this.tasks.createTaskInTransaction(workItem.resolvedProjectId, taskRequest);
    const now = exactNow(this.runtime.config.now);
    this.runtime.store.db.prepare("INSERT INTO work_item_planning_tasks VALUES(?,?,?)").run(workItemId, task.taskId, now);
    this.runtime.store.db.prepare(
      "UPDATE work_items SET state='processing',current_stage='planning',version=version+1,updated_at=? WHERE work_item_id=? AND ended_at IS NULL",
    ).run(now, workItemId);
    return Object.freeze({ task, wakeAgentId: orphan ? null : managerId });
  }

  updateWorkItem(workItemId: string, request: UpdateWorkItemRequest): WorkItem {
    return this.runtime.store.transaction(() => {
      if (request.priority === undefined && request.projectTarget === undefined) {
        throw new TaskBoardError(400, "INVALID_REQUEST", "Work item update contains no changes");
      }
      const current = this.runtime.requireWorkItem(workItemId);
      if (current.version !== request.version) throw conflict("WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
      if (current.endedAt !== null) throw conflict("WORK_ITEM_TERMINAL", "Terminal work items are immutable");
      if (request.projectTarget !== undefined && current.state !== "submitted") {
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
        UPDATE work_items SET
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
}
