import { randomUUID } from "node:crypto";
import type {
  BacklogTaskRequest,
  BacklogTaskResponse,
  BoardTask,
  CreateTaskPhaseRequest,
  CreateTaskRequest,
  RetryTaskRequest,
  RetryTaskResponse,
  TaskPhase,
  TaskStatus,
  UpdateTaskPhaseRequest,
  UpdateTaskRequest,
} from "#shared/task-board-contract";
import {
  TASK_BOARD_ERROR_CODES,
  isHardTerminalTaskStatus,
  isRecoverableTaskStatus,
} from "#shared/task-board-contract";
import { canonicalJson } from "../canonical.js";
import { conflict, TaskBoardError } from "../errors.js";
import { wakeupFromRow } from "../persistence/rows.js";
import { exactNow } from "../persistence/timestamps.js";
import type { Actor, TaskBoardRuntime } from "./runtime.js";

export class TasksCollaborator {
  constructor(private readonly runtime: TaskBoardRuntime) {}

  createTask(projectId: string, request: CreateTaskRequest): BoardTask {
    return this.createTaskInternal(projectId, request, false);
  }

  createTaskInTransaction(projectId: string, request: CreateTaskRequest): BoardTask {
    return this.createTaskInternal(projectId, request, true);
  }

  private createTaskInternal(projectId: string, request: CreateTaskRequest, inTransaction: boolean): BoardTask {
    this.runtime.requireProject(projectId);
    if (request.parentTaskId !== null) {
      const parent = this.runtime.requireTask(request.parentTaskId);
      if (parent.projectId !== projectId) throw conflict("PARENT_PROJECT_MISMATCH", "Parent task belongs to another project");
    }
    if (request.assignedAgentId !== null && request.assignedRole !== null) {
      this.runtime.assertAssignment(projectId, request.assignedAgentId, request.assignedRole);
    }
    const taskId = randomUUID();
    const now = exactNow(this.runtime.config.now);
    const status: TaskStatus = request.assignedAgentId === null ? "backlog" : "queued";
    const apply = (): BoardTask => {
      const orderKey = this.runtime.nextTaskOrderKey();
      this.runtime.store.db.prepare(`
        INSERT INTO tasks(
          task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
          title, objective, acceptance_criteria, workspace_refs_json,
          status, assigned_agent_id, assigned_role, expected_agent_minutes, agent_estimate_minutes, order_key, started_at, ended_at,
          result, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'work', NULL, ?, ?, ?, ?, ?, ?, ?, ?, 15, NULL, ?, NULL, NULL, NULL, 1, ?, ?)
      `).run(
        taskId,
        projectId,
        request.parentTaskId,
        request.requiresReview === false ? 0 : 1,
        request.title,
        request.objective,
        request.acceptanceCriteria,
        canonicalJson(request.workspaceRefs),
        status,
        request.assignedAgentId,
        request.assignedRole,
        orderKey,
        now,
        now,
      );
      this.runtime.insertEvent(projectId, taskId, { type: "human", id: this.runtime.config.humanPrincipal }, "task_created", {
        kind: "work",
        requiredRole: null,
        requiresReview: request.requiresReview !== false,
        status,
        assignedAgentId: request.assignedAgentId,
        expectedAgentMinutes: null,
        orderKey,
      }, now);
      if (request.assignedAgentId !== null) {
        this.runtime.insertWakeup(
          projectId,
          request.assignedAgentId,
          "human_assignment",
          `task:${taskId}:version:1`,
          taskId,
          null,
          `Assigned task: ${request.title}`,
          now,
        );
      }
      return this.runtime.requireTask(taskId);
    };
    const task = inTransaction ? apply() : this.runtime.store.transaction(apply);
    if (!inTransaction && request.assignedAgentId !== null) this.runtime.wakeupEvents.emit(request.assignedAgentId);
    return task;
  }

  retryTask(taskId: string, request: RetryTaskRequest): RetryTaskResponse {
    return this.retryTaskInternal(taskId, request.version, null);
  }

  retryTaskFromResume(
    taskId: string,
    agentId: string,
    sourceKey: string,
    detail: string,
  ): RetryTaskResponse {
    return this.retryTaskInternal(taskId, null, { agentId, sourceKey, detail });
  }

  private retryTaskInternal(
    taskId: string,
    expectedVersion: number | null,
    resume: Readonly<{ agentId: string; sourceKey: string; detail: string }> | null,
  ): RetryTaskResponse {
    let wakeupId = "";
    let wakeAgentId = "";
    this.runtime.store.transaction(() => {
      const current = this.runtime.requireTask(taskId);
      if (isHardTerminalTaskStatus(current.status)) {
        throw conflict(TASK_BOARD_ERROR_CODES.TASK_TERMINAL, "Completed and cancelled tasks cannot be retried");
      }
      if (expectedVersion !== null && current.version !== expectedVersion) {
        throw conflict("TASK_VERSION_CONFLICT", "Task version changed");
      }
      if (!isRecoverableTaskStatus(current.status)) {
        throw conflict(
          TASK_BOARD_ERROR_CODES.TASK_NOT_RECOVERABLE,
          "Only failed, blocked, or interrupted tasks can be retried",
        );
      }
      if (current.assignedAgentId === null || current.assignedRole === null) {
        throw conflict(TASK_BOARD_ERROR_CODES.TASK_UNASSIGNED, "Recoverable task has no assigned agent");
      }
      if (resume !== null && current.assignedAgentId !== resume.agentId) {
        throw conflict("WAKEUP_TASK_NOT_ASSIGNED", "Resume target is not assigned to this task");
      }
      this.runtime.assertNoActiveRunForTaskInTransaction(taskId);
      const now = exactNow(this.runtime.config.now);
      const nextVersion = current.version + 1;
      const pendingHumanAnswer = this.runtime.store.db.prepare(`
        SELECT *
        FROM wakeups AS wakeup
        WHERE wakeup.task_id = ?
          AND wakeup.reason = 'human_answer'
          AND wakeup.claimed_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM task_events AS event
            WHERE event.event_id = 'retired-wakeup:' || wakeup.wakeup_id
          )
        ORDER BY wakeup.created_at DESC, wakeup.rowid DESC
        LIMIT 1
      `).get(taskId);
      const update = this.runtime.store.db.prepare(`
        UPDATE tasks
        SET status = 'queued', ended_at = NULL, result = NULL, version = ?, updated_at = ?
        WHERE task_id = ? AND version = ?
          AND assigned_agent_id = ?
          AND status IN ('failed', 'blocked', 'interrupted')
      `).run(nextVersion, now, taskId, current.version, current.assignedAgentId);
      if (Number(update.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Task version changed");
      wakeupId = pendingHumanAnswer === undefined ? "" : wakeupFromRow(pendingHumanAnswer).wakeupId;
      this.runtime.retirePendingWakeupsForTask(taskId, "task_retried", now, wakeupId || null);
      this.runtime.recoverWorkflowTaskInTransaction(taskId, "retry", now);
      this.runtime.insertEvent(
        current.projectId,
        taskId,
        { type: "human", id: this.runtime.config.humanPrincipal },
        "task_retried",
        {
          previousStatus: current.status,
          status: "queued",
          assignedAgentId: current.assignedAgentId,
          previousVersion: current.version,
          version: nextVersion,
        },
        now,
      );
      if (wakeupId === "") {
        wakeupId = this.runtime.insertWakeup(
          current.projectId,
          current.assignedAgentId,
          "resumed",
          resume?.sourceKey ?? `task:${taskId}:retry:version:${nextVersion}`,
          taskId,
          null,
          resume?.detail ?? `Retry task: ${current.title}`,
          now,
        );
      }
      wakeAgentId = current.assignedAgentId;
    });
    this.runtime.wakeupEvents.emit(wakeAgentId);
    return Object.freeze({
      task: this.runtime.requireTask(taskId),
      wakeup: wakeupFromRow(this.runtime.store.db.prepare("SELECT * FROM wakeups WHERE wakeup_id = ?").get(wakeupId)!),
    });
  }

  backlogTask(taskId: string, request: BacklogTaskRequest): BacklogTaskResponse {
    this.runtime.store.transaction(() => {
      const current = this.runtime.requireTask(taskId);
      if (isHardTerminalTaskStatus(current.status)) {
        throw conflict(TASK_BOARD_ERROR_CODES.TASK_TERMINAL, "Completed and cancelled tasks cannot return to backlog");
      }
      if (current.version !== request.version) throw conflict("TASK_VERSION_CONFLICT", "Task version changed");
      this.runtime.assertNoActiveRunForTaskInTransaction(taskId);
      if (this.runtime.isWorkflowTask(taskId)) {
        throw conflict(TASK_BOARD_ERROR_CODES.TASK_WORKFLOW_BOUND, "Workflow stage tasks cannot return to backlog");
      }
      const now = exactNow(this.runtime.config.now);
      const nextVersion = current.version + 1;
      const update = this.runtime.store.db.prepare(`
        UPDATE tasks
        SET status = 'backlog', assigned_agent_id = NULL, assigned_role = NULL,
          agent_estimate_minutes = NULL, estimate_recorded_at = NULL,
          ended_at = NULL, result = NULL, version = ?, updated_at = ?
        WHERE task_id = ? AND version = ? AND status NOT IN ('completed', 'cancelled')
      `).run(nextVersion, now, taskId, current.version);
      if (Number(update.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Task version changed");
      this.runtime.retirePendingWakeupsForTask(taskId, "task_unassigned", now);
      this.runtime.insertEvent(
        current.projectId,
        taskId,
        { type: "human", id: this.runtime.config.humanPrincipal },
        "task_backlogged",
        {
          previousStatus: current.status,
          status: "backlog",
          previousAssignedAgentId: current.assignedAgentId,
          assignedAgentId: null,
          previousVersion: current.version,
          version: nextVersion,
        },
        now,
      );
    });
    return Object.freeze({ task: this.runtime.requireTask(taskId) });
  }

  updateTask(taskId: string, request: UpdateTaskRequest, actor: Actor): BoardTask {
    const current = this.runtime.requireTask(taskId);
    if (current.version !== request.version) throw conflict("TASK_VERSION_CONFLICT", "Task version changed");
    if (isHardTerminalTaskStatus(current.status)) {
      throw conflict(TASK_BOARD_ERROR_CODES.TASK_TERMINAL, "Completed and cancelled tasks are immutable");
    }
    if (current.kind === "human_check" && actor.type !== "human") {
      throw new TaskBoardError(403, "HUMAN_CHECK_HUMAN_ONLY", "Human checks can only be decided by a human");
    }
    if (actor.type === "human" && "expectedAgentMinutes" in request) {
      throw new TaskBoardError(403, "AGENT_ESTIMATE_REQUIRED", "Only the assigned agent can estimate task duration");
    }
    if (actor.type === "agent") {
      const forbidden = ["title", "objective", "acceptanceCriteria", "workspaceRefs", "assignedAgentId", "assignedRole", "orderKey"]
        .some((field) => field in request);
      if (forbidden) throw new TaskBoardError(403, "HUMAN_UPDATE_REQUIRED", "Assignment and planning fields are human-only");
      if (current.assignedAgentId !== actor.id) throw new TaskBoardError(403, "TASK_NOT_ASSIGNED", "Task is not assigned to this agent");
      if (request.status === "cancelled" || request.status === "backlog" || request.status === "queued") {
        throw new TaskBoardError(403, "HUMAN_UPDATE_REQUIRED", "Agent cannot move work to the requested status");
      }
      this.runtime.requireActiveRun(actor.id, taskId);
    }
    const assignedAgentId = "assignedAgentId" in request ? request.assignedAgentId ?? null : current.assignedAgentId;
    const assignedRole = "assignedRole" in request ? request.assignedRole ?? null : current.assignedRole;
    if (assignedAgentId !== null && assignedRole !== null) this.runtime.assertTaskAssignment(current, assignedAgentId, assignedRole);
    const assigneeChanged = actor.type === "human" && "assignedAgentId" in request && assignedAgentId !== current.assignedAgentId;
    const newAssignment = assigneeChanged && assignedAgentId !== null;
    const recoveringReassignment = newAssignment && isRecoverableTaskStatus(current.status);
    const status = request.status ?? (newAssignment && (current.status === "backlog" || recoveringReassignment) ? "queued" : current.status);
    const humanCheckSettlement = current.kind === "human_check" && actor.type === "human" && status === "failed";
    const recoveryStatusTransition = request.status !== undefined && request.status !== current.status && (
      isRecoverableTaskStatus(current.status) || isRecoverableTaskStatus(request.status)
    );
    if (
      (recoveringReassignment && status !== "queued") ||
      (recoveryStatusTransition && !(recoveringReassignment && status === "queued") && !humanCheckSettlement)
    ) {
      throw conflict(
        TASK_BOARD_ERROR_CODES.TASK_RECOVERY_REQUIRED,
        "Use retry, reassignment, backlog, or run settlement to change recovery state",
      );
    }
    if (status === "backlog" && this.runtime.isWorkflowTask(taskId)) {
      throw conflict(TASK_BOARD_ERROR_CODES.TASK_WORKFLOW_BOUND, "Workflow stage tasks cannot return to backlog");
    }
    if (current.kind === "human_check" && status !== "backlog" && status !== "completed" && status !== "failed" && status !== "cancelled") {
      throw new TaskBoardError(400, "HUMAN_CHECK_STATUS_INVALID", "Human checks stay in backlog until a human records a terminal decision");
    }
    const settled = status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";
    const hardTerminal = isHardTerminalTaskStatus(status);
    const leavesRecoverableState = isRecoverableTaskStatus(current.status) && !settled;
    const result = recoveringReassignment || leavesRecoverableState
      ? null
      : "result" in request ? request.result ?? null : current.result;
    if (settled && result === null) throw new TaskBoardError(400, "TASK_RESULT_REQUIRED", "Settled task status requires a result");
    if (!settled && result !== null) throw new TaskBoardError(400, "TASK_RESULT_NOT_TERMINAL", "Task result is reserved for a settled status");
    const now = exactNow(this.runtime.config.now);
    const startedAt = current.startedAt ?? (status === "in_progress" || status === "blocked" || settled ? now : null);
    const endedAt = settled ? current.endedAt ?? now : null;
    const expectedAgentMinutes = assigneeChanged
      ? null
      : "expectedAgentMinutes" in request
        ? request.expectedAgentMinutes ?? null
        : current.expectedAgentMinutes;
    const estimateRecordedAt = assigneeChanged
      ? null
      : "expectedAgentMinutes" in request
        ? request.expectedAgentMinutes === null ? null : now
        : current.estimateRecordedAt;
    const nextVersion = current.version + 1;
    let workflowWakeAgentId: string | null = null;
    const changed = this.runtime.store.transaction(() => {
      if (recoveringReassignment) this.runtime.assertNoActiveRunForTaskInTransaction(taskId);
      const update = this.runtime.store.db.prepare(`
        UPDATE tasks SET
          title = ?, objective = ?, acceptance_criteria = ?, workspace_refs_json = ?, status = ?,
          assigned_agent_id = ?, assigned_role = ?, agent_estimate_minutes = ?, estimate_recorded_at = ?, order_key = ?, started_at = ?, ended_at = ?,
          result = ?, version = ?, updated_at = ?
        WHERE task_id = ? AND version = ? AND status NOT IN ('completed', 'cancelled')
      `).run(
        request.title ?? current.title,
        request.objective ?? current.objective,
        request.acceptanceCriteria ?? current.acceptanceCriteria,
        canonicalJson(request.workspaceRefs ?? current.workspaceRefs),
        status,
        assignedAgentId,
        assignedRole,
        expectedAgentMinutes,
        estimateRecordedAt,
        request.orderKey ?? current.orderKey,
        startedAt,
        endedAt,
        result,
        nextVersion,
        now,
        taskId,
        current.version,
      );
      if (Number(update.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Task version changed");
      this.runtime.insertEvent(current.projectId, taskId, actor, "task_updated", {
        kind: current.kind,
        requiredRole: current.requiredRole,
        previousVersion: current.version,
        version: nextVersion,
        status,
        assignedAgentId,
        expectedAgentMinutes,
        orderKey: request.orderKey ?? current.orderKey,
      }, now);
      if (status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled") {
        this.runtime.reconcileTaskPhasesForTerminal(current, status, actor, now);
      }
      if (assignedAgentId !== current.assignedAgentId || settled || status === "backlog") {
        const retirementReason = status === "cancelled"
          ? "task_cancelled"
          : hardTerminal
            ? "task_terminal"
            : status === "failed" || status === "interrupted"
              ? "task_recovery_required"
            : assignedAgentId === null
              ? "task_unassigned"
              : status === "backlog"
                ? "task_not_runnable"
                : "task_reassigned";
        this.runtime.retirePendingWakeupsForTask(taskId, retirementReason, now);
      }
      if (recoveringReassignment) this.runtime.recoverWorkflowTaskInTransaction(taskId, "reassign", now);
      const shouldWake = newAssignment && (status === "queued" || status === "blocked");
      if (shouldWake) {
        this.runtime.insertWakeup(
          current.projectId,
          assignedAgentId,
          recoveringReassignment ? "assigned" : "human_assignment",
          `task:${taskId}:version:${nextVersion}`,
          taskId,
          null,
          `Assigned task: ${request.title ?? current.title}`,
          now,
        );
      }
      if (status === "completed") {
        workflowWakeAgentId = this.runtime.createReviewFollowup(current, now)?.wakeAgentId ?? null;
      }
      return true;
    });
    if (!changed) throw new Error("TASK_BOARD_UPDATE_FAILED");
    if (newAssignment && (status === "queued" || status === "blocked")) this.runtime.wakeupEvents.emit(assignedAgentId);
    if (workflowWakeAgentId !== null) this.runtime.wakeupEvents.emit(workflowWakeAgentId);
    return this.runtime.requireTask(taskId);
  }

  createTaskPhase(taskId: string, request: CreateTaskPhaseRequest, agentId: string): TaskPhase {
    const task = this.runtime.requireTask(taskId);
    if (task.assignedAgentId !== agentId) {
      throw new TaskBoardError(403, "TASK_NOT_ASSIGNED", "Task is not assigned to this agent");
    }
    if (task.endedAt !== null) throw conflict("TASK_TERMINAL", "Terminal task cannot add phases");
    this.runtime.requireActiveRun(agentId, taskId);
    if (request.stage === "done") {
      throw new TaskBoardError(400, "PHASE_STATE_INVALID", "A new pending phase cannot start at the done stage");
    }
    const phaseId = randomUUID();
    const now = exactNow(this.runtime.config.now);
    this.runtime.store.transaction(() => {
      const orderKey = this.runtime.nextPhaseOrderKey(taskId);
      this.runtime.store.db.prepare(`
        INSERT INTO task_phases(
          phase_id, project_id, task_id, title, stage, status, parallel_group,
          order_key, started_at, ended_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, 1, ?, ?)
      `).run(
        phaseId,
        task.projectId,
        taskId,
        request.title,
        request.stage,
        request.parallelGroup,
        orderKey,
        now,
        now,
      );
      this.runtime.insertEvent(task.projectId, taskId, { type: "agent", id: agentId }, "task_phase_created", {
        phaseId,
        stage: request.stage,
        status: "pending",
        parallelGroup: request.parallelGroup,
        orderKey,
      }, now);
    });
    return this.runtime.requireTaskPhase(phaseId);
  }

  updateTaskPhase(phaseId: string, request: UpdateTaskPhaseRequest, agentId: string): TaskPhase {
    const current = this.runtime.requireTaskPhase(phaseId);
    if (current.version !== request.version) throw conflict("TASK_PHASE_VERSION_CONFLICT", "Task phase version changed");
    if (current.endedAt !== null) throw conflict("TASK_PHASE_TERMINAL", "Terminal task phases are immutable");
    const task = this.runtime.requireTask(current.taskId);
    if (task.assignedAgentId !== agentId) {
      throw new TaskBoardError(403, "TASK_NOT_ASSIGNED", "Task is not assigned to this agent");
    }
    if (task.endedAt !== null) throw conflict("TASK_TERMINAL", "Terminal task phases are immutable");
    this.runtime.requireActiveRun(agentId, task.taskId);
    const stage = request.stage ?? current.stage;
    const status = request.status ?? current.status;
    if (stage === "done" && status !== "completed") {
      throw new TaskBoardError(400, "PHASE_STATE_INVALID", "The legacy done stage may only be used by a completed phase");
    }
    if (current.startedAt !== null && status === "pending") {
      throw new TaskBoardError(400, "PHASE_STATE_INVALID", "A started phase cannot return to pending");
    }
    const now = exactNow(this.runtime.config.now);
    const startedAt = status === "pending" ? null : current.startedAt ?? now;
    const endedAt = status === "completed" || status === "failed" ? now : null;
    const nextVersion = current.version + 1;
    this.runtime.store.transaction(() => {
      const update = this.runtime.store.db.prepare(`
        UPDATE task_phases SET
          title = ?, stage = ?, status = ?, parallel_group = ?, order_key = ?,
          started_at = ?, ended_at = ?, version = ?, updated_at = ?
        WHERE phase_id = ? AND version = ? AND ended_at IS NULL
      `).run(
        request.title ?? current.title,
        stage,
        status,
        "parallelGroup" in request ? request.parallelGroup ?? null : current.parallelGroup,
        request.orderKey ?? current.orderKey,
        startedAt,
        endedAt,
        nextVersion,
        now,
        phaseId,
        current.version,
      );
      if (Number(update.changes) !== 1) throw conflict("TASK_PHASE_VERSION_CONFLICT", "Task phase version changed");
      this.runtime.insertEvent(task.projectId, task.taskId, { type: "agent", id: agentId }, "task_phase_updated", {
        phaseId,
        previousVersion: current.version,
        version: nextVersion,
        stage,
        status,
      }, now);
    });
    return this.runtime.requireTaskPhase(phaseId);
  }

  requireTask(taskId: string): BoardTask {
    return this.runtime.requireTask(taskId);
  }
}
