import { randomUUID } from "node:crypto";
import type {
  BoardTask,
  CreateTaskPhaseRequest,
  CreateTaskRequest,
  TaskPhase,
  TaskStatus,
  UpdateTaskPhaseRequest,
  UpdateTaskRequest,
} from "#shared/task-board-contract";
import { canonicalJson } from "../canonical.js";
import { conflict, TaskBoardError } from "../errors.js";
import { exactNow } from "../persistence/timestamps.js";
import type { Actor, TaskBoardRuntime } from "./runtime.js";

export class TasksCollaborator {
  constructor(private readonly runtime: TaskBoardRuntime) {}

  createTask(projectId: string, request: CreateTaskRequest): BoardTask {
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
    this.runtime.store.transaction(() => {
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
    });
    if (request.assignedAgentId !== null) this.runtime.wakeupEvents.emit(request.assignedAgentId);
    return this.runtime.requireTask(taskId);
  }

  updateTask(taskId: string, request: UpdateTaskRequest, actor: Actor): BoardTask {
    const current = this.runtime.requireTask(taskId);
    if (current.version !== request.version) throw conflict("TASK_VERSION_CONFLICT", "Task version changed");
    if (current.endedAt !== null) throw conflict("TASK_TERMINAL", "Terminal tasks are immutable");
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
    const status = request.status ?? (newAssignment && current.status === "backlog" ? "queued" : current.status);
    if (current.kind === "human_check" && status !== "backlog" && status !== "completed" && status !== "failed" && status !== "cancelled") {
      throw new TaskBoardError(400, "HUMAN_CHECK_STATUS_INVALID", "Human checks stay in backlog until a human records a terminal decision");
    }
    const terminal = status === "completed" || status === "failed" || status === "cancelled";
    const result = "result" in request ? request.result ?? null : current.result;
    if (terminal && result === null) throw new TaskBoardError(400, "TASK_RESULT_REQUIRED", "Terminal task status requires a result");
    if (!terminal && result !== null) throw new TaskBoardError(400, "TASK_RESULT_NOT_TERMINAL", "Task result is reserved for terminal status");
    const now = exactNow(this.runtime.config.now);
    const startedAt = current.startedAt ?? (status === "in_progress" || status === "blocked" || terminal ? now : null);
    const endedAt = terminal ? now : null;
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
      const update = this.runtime.store.db.prepare(`
        UPDATE tasks SET
          title = ?, objective = ?, acceptance_criteria = ?, workspace_refs_json = ?, status = ?,
          assigned_agent_id = ?, assigned_role = ?, agent_estimate_minutes = ?, estimate_recorded_at = ?, order_key = ?, started_at = ?, ended_at = ?,
          result = ?, version = ?, updated_at = ?
        WHERE task_id = ? AND version = ? AND ended_at IS NULL
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
      if (terminal) this.runtime.reconcileTaskPhasesForTerminal(current, status, actor, now);
      if (assignedAgentId !== current.assignedAgentId || terminal || status === "backlog") {
        const retirementReason = status === "cancelled"
          ? "task_cancelled"
          : terminal
            ? "task_terminal"
            : assignedAgentId === null
              ? "task_unassigned"
              : status === "backlog"
                ? "task_not_runnable"
                : "task_reassigned";
        this.runtime.retirePendingWakeupsForTask(taskId, retirementReason, now);
      }
      if (newAssignment) {
        this.runtime.insertWakeup(
          current.projectId,
          assignedAgentId,
          "human_assignment",
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
    if (newAssignment) this.runtime.wakeupEvents.emit(assignedAgentId);
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
