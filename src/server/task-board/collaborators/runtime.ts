import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  TASK_BOARD_API_VERSION,
  TASK_BOARD_ERROR_CODES,
  isHardTerminalTaskStatus,
  type AgentProfile,
  type AgentRole,
  type AgentRun,
  type BoardTask,
  type ProjectEvent,
  type TaskKind,
  type TaskPhase,
  type TaskPhaseStatus,
  type TaskStatus,
  type Wakeup,
  type WorkerConnection,
  type WorkflowStage,
} from "#shared/task-board-contract";
import { canonicalJson } from "../canonical.js";
import type { TaskBoardConfig } from "../config.js";
import { conflict, TaskBoardError } from "../errors.js";
import { RETIRED_WAKEUP_EVENT_PREFIX, retiredWakeupEventId } from "../persistence/retired-wakeups.js";
import {
  nullableString,
  numberValue,
  phaseFromRow,
  projectFromRow,
  runFromRow,
  stringValue,
  taskFromRow,
  wakeupFromRow,
  workItemFromRow,
  type Row,
} from "../persistence/rows.js";
import type { TaskBoardStore } from "../persistence/store.js";

export type Actor = Readonly<{ type: "human" | "agent"; id: string }>;
export type ReviewFollowupResult = Readonly<{ taskId: string; wakeAgentId: string | null }>;

type ActiveWorkerConnection = Exclude<WorkerConnection, null>;
type WorkerConnectionCounts = { waitingForWake: number; watchingRun: number };
const REVIEW_WORKFLOW_ACTOR = "system:steward-review-workflow";

export class TaskBoardRuntime {
  readonly interruptEvents = new EventEmitter();
  readonly wakeupEvents = new EventEmitter();
  readonly documentEvents = new EventEmitter();
  readonly projectEvents = new EventEmitter();
  readonly #workerConnections = new Map<string, WorkerConnectionCounts>();

  constructor(
    readonly config: TaskBoardConfig,
    readonly store: TaskBoardStore,
  ) {
    this.interruptEvents.setMaxListeners(512);
    this.wakeupEvents.setMaxListeners(512);
    this.documentEvents.setMaxListeners(512);
    this.projectEvents.setMaxListeners(512);
  }

  agentFromRow(row: Row): AgentProfile {
    const agentId = stringValue(row, "agent_id");
    const active = this.store.db.prepare("SELECT run_id FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
    let status: AgentProfile["status"];
    if (active) {
      const interrupted = this.store.db.prepare("SELECT 1 FROM interrupts WHERE run_id = ? LIMIT 1").get(stringValue(active, "run_id"));
      status = interrupted ? "interrupting" : "running";
    } else if (this.store.db.prepare(`
      SELECT 1
      FROM wakeups AS wakeup
      WHERE wakeup.agent_id = ?
        AND wakeup.claimed_at IS NULL
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
      LIMIT 1
    `).get(agentId, RETIRED_WAKEUP_EVENT_PREFIX)) {
      status = "ready";
    } else if (this.store.db.prepare("SELECT 1 FROM questions WHERE agent_id = ? AND status = 'open' LIMIT 1").get(agentId)) {
      status = "waiting_for_human";
    } else {
      status = "idle";
    }
    return Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      agentId,
      projectId: stringValue(row, "project_id"),
      role: stringValue(row, "role") as AgentRole,
      area: stringValue(row, "area"),
      mission: stringValue(row, "mission"),
      model: stringValue(row, "model"),
      status,
      workerConnection: this.workerConnection(agentId),
      createdAt: stringValue(row, "created_at"),
    });
  }

  requireProject(projectId: string) {
    const row = this.store.db.prepare("SELECT * FROM projects WHERE project_id = ?").get(projectId);
    if (!row) throw new TaskBoardError(404, "PROJECT_NOT_FOUND", "Project was not found");
    return projectFromRow(row);
  }

  requireWorkItem(workItemId: string) {
    const row = this.store.db.prepare("SELECT * FROM work_items WHERE work_item_id = ?").get(workItemId);
    if (!row) throw new TaskBoardError(404, "WORK_ITEM_NOT_FOUND", "Work item was not found");
    return workItemFromRow(row);
  }

  requireAgent(agentId: string): AgentProfile {
    const row = this.store.db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId);
    if (!row) throw new TaskBoardError(404, "AGENT_NOT_FOUND", "Agent was not found");
    return this.agentFromRow(row);
  }

  nextTaskOrderKey(): number {
    const row = this.store.db.prepare(`
      SELECT COALESCE(MAX(order_key), -1024) + 1024 AS next_order_key
      FROM tasks
    `).get();
    const orderKey = numberValue(row!, "next_order_key");
    if (!Number.isSafeInteger(orderKey) || orderKey < 0) throw conflict("TASK_ORDER_EXHAUSTED", "Task order key space is exhausted");
    return orderKey;
  }

  nextPhaseOrderKey(taskId: string): number {
    const row = this.store.db.prepare(`
      SELECT COALESCE(MAX(order_key), -1024) + 1024 AS next_order_key
      FROM task_phases WHERE task_id = ?
    `).get(taskId);
    const orderKey = numberValue(row!, "next_order_key");
    if (!Number.isSafeInteger(orderKey) || orderKey < 0) throw conflict("TASK_PHASE_ORDER_EXHAUSTED", "Task phase order key space is exhausted");
    return orderKey;
  }

  taskPhases(taskId: string): readonly TaskPhase[] {
    return Object.freeze(this.store.db.prepare(`
      SELECT * FROM task_phases WHERE task_id = ? ORDER BY order_key, phase_id
    `).all(taskId).map(phaseFromRow));
  }

  requireTaskPhase(phaseId: string): TaskPhase {
    const row = this.store.db.prepare("SELECT * FROM task_phases WHERE phase_id = ?").get(phaseId);
    if (!row) throw new TaskBoardError(404, "TASK_PHASE_NOT_FOUND", "Task phase was not found");
    return phaseFromRow(row);
  }

  reconcileTaskPhasesForTerminal(
    task: BoardTask,
    taskStatus: Extract<TaskStatus, "completed" | "failed" | "interrupted" | "cancelled">,
    actor: Actor,
    now: string,
  ): void {
    const phases = this.store.db.prepare(`
      SELECT * FROM task_phases
      WHERE task_id = ? AND ended_at IS NULL
      ORDER BY order_key, phase_id
    `).all(task.taskId).map(phaseFromRow);
    const phaseStatus: TaskPhaseStatus = taskStatus === "completed" ? "completed" : "failed";
    for (const phase of phases) {
      const stage = phase.stage;
      const nextVersion = phase.version + 1;
      const update = this.store.db.prepare(`
        UPDATE task_phases SET
          stage = ?, status = ?, started_at = COALESCE(started_at, ?), ended_at = ?,
          version = ?, updated_at = ?
        WHERE phase_id = ? AND version = ? AND ended_at IS NULL
      `).run(stage, phaseStatus, now, now, nextVersion, now, phase.phaseId, phase.version);
      if (Number(update.changes) !== 1) {
        throw conflict("TASK_PHASE_VERSION_CONFLICT", "Task phase changed while its task became terminal");
      }
      this.insertEvent(task.projectId, task.taskId, actor, "task_phase_updated", {
        phaseId: phase.phaseId,
        previousVersion: phase.version,
        version: nextVersion,
        stage,
        status: phaseStatus,
        terminalTaskStatus: taskStatus,
      }, now);
    }
  }

  requireTask(taskId: string): BoardTask {
    const row = this.store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
    if (!row) throw new TaskBoardError(404, "TASK_NOT_FOUND", "Task was not found");
    return taskFromRow(row, this.taskPhases(taskId));
  }

  isWorkflowTask(taskId: string): boolean {
    return this.store.db.prepare("SELECT 1 FROM stage_attempts WHERE task_id = ?").get(taskId) !== undefined;
  }

  recoverWorkflowTaskInTransaction(
    taskId: string,
    transition: "retry" | "reassign",
    now: string,
  ): boolean {
    const link = this.store.db.prepare(`
      SELECT
        attempt.node_id,
        attempt.stage,
        attempt.attempt,
        node.project_id,
        node.plan_revision_id,
        node.title,
        node.state,
        node.current_stage,
        node.version
      FROM stage_attempts attempt
      JOIN work_nodes node ON node.node_id = attempt.node_id
      WHERE attempt.task_id = ?
    `).get(taskId);
    if (link === undefined) return false;
    const nodeId = stringValue(link, "node_id");
    const stage = stringValue(link, "stage") as WorkflowStage;
    const currentStage = nullableString(link, "current_stage");
    const state = stringValue(link, "state");
    const attempt = numberValue(link, "attempt");
    const newerAttempt = this.store.db.prepare(`
      SELECT 1 FROM stage_attempts
      WHERE node_id = ? AND stage = ? AND attempt > ?
      LIMIT 1
    `).get(nodeId, stage, attempt);
    if (
      currentStage !== stage ||
      (state !== "active" && state !== "blocked") ||
      newerAttempt !== undefined
    ) {
      throw conflict(
        TASK_BOARD_ERROR_CODES.TASK_WORKFLOW_ATTEMPT_SUPERSEDED,
        "Workflow task attempt is no longer recoverable",
      );
    }
    const nodeVersion = numberValue(link, "version");
    this.store.db.prepare("DELETE FROM stage_handoffs WHERE task_id = ?").run(taskId);
    const update = this.store.db.prepare(`
      UPDATE work_nodes
      SET state = 'active', current_stage = ?, version = version + 1, updated_at = ?
      WHERE node_id = ? AND version = ? AND current_stage = ? AND state IN ('active', 'blocked')
    `).run(stage, now, nodeId, nodeVersion, stage);
    if (Number(update.changes) !== 1) {
      throw conflict(TASK_BOARD_ERROR_CODES.WORK_NODE_VERSION_CONFLICT, "Workflow node changed during task recovery");
    }
    this.store.db.prepare(`
      UPDATE work_items
      SET state = 'processing', current_stage = ?, version = version + 1, updated_at = ?
      WHERE work_item_id = (
        SELECT work_item_id FROM plan_revisions WHERE plan_revision_id = ?
      ) AND ended_at IS NULL
    `).run(stage, now, stringValue(link, "plan_revision_id"));
    const projectId = stringValue(link, "project_id");
    const eventId = `event_${randomUUID()}`;
    const eventType = transition === "retry" ? "stage_task_retried" : "stage_task_reassigned";
    const summary = transition === "retry"
      ? `${stringValue(link, "title")} ${stage} attempt resumed`
      : `${stringValue(link, "title")} ${stage} attempt reassigned`;
    this.store.db.prepare(`
      INSERT INTO project_events(event_id, project_id, node_id, task_id, event_type, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, projectId, nodeId, taskId, eventType, summary, now);
    const sequence = Number(this.store.db.prepare("SELECT sequence FROM project_events WHERE event_id = ?").get(eventId)?.sequence);
    const event: ProjectEvent = Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      sequence,
      eventId,
      projectId,
      nodeId,
      taskId,
      eventType,
      summary,
      createdAt: now,
    });
    this.store.afterCommit(() => {
      for (const listener of this.projectEvents.listeners(projectId)) {
        try {
          (listener as (item: ProjectEvent) => void)(event);
        } catch (error) {
          console.error("[task-board] project event listener failed", error);
        }
      }
    });
    return true;
  }

  requireRun(runId: string, agentId: string, taskId: string | null, active: boolean): AgentRun {
    const row = this.store.db.prepare("SELECT * FROM runs WHERE run_id = ? AND agent_id = ?").get(runId, agentId);
    if (!row) throw new TaskBoardError(404, "RUN_NOT_FOUND", "Run was not found");
    const run = runFromRow(row);
    if (active && run.status !== "active") throw conflict("RUN_NOT_ACTIVE", "Run is no longer active");
    if (taskId !== null) {
      const wake = this.store.db.prepare("SELECT task_id FROM wakeups WHERE wakeup_id = ?").get(run.wakeupId);
      if (!wake || nullableString(wake, "task_id") !== taskId) throw conflict("RUN_TASK_MISMATCH", "Run is not bound to this task");
    }
    return run;
  }

  requireActiveRun(agentId: string, taskId: string): AgentRun {
    const row = this.store.db.prepare("SELECT * FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
    if (!row) throw conflict("RUN_NOT_ACTIVE", "Agent has no active run");
    return this.requireRun(stringValue(row, "run_id"), agentId, taskId, true);
  }

  assertNoActiveRunForTaskInTransaction(taskId: string): void {
    const active = this.store.db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND status = 'active' LIMIT 1").get(taskId);
    if (active !== undefined) throw conflict("AGENT_RUN_ACTIVE", "Task already has an active run");
  }

  assertAssignment(projectId: string, agentId: string, role: AgentRole): void {
    const agent = this.requireAgent(agentId);
    if (agent.projectId !== projectId) throw conflict("AGENT_PROJECT_MISMATCH", "Assigned agent belongs to another project");
    if (agent.role !== role) throw conflict("AGENT_ROLE_MISMATCH", "Assigned role does not match the fixed agent profile");
  }

  assertTaskAssignment(task: BoardTask, agentId: string, role: AgentRole): void {
    if (task.kind === "human_check") throw conflict("HUMAN_CHECK_NOT_ASSIGNABLE", "Human checks cannot be assigned to agents");
    if (task.requiredRole !== null && role !== task.requiredRole) {
      throw conflict("TASK_REQUIRED_ROLE_MISMATCH", `This task requires the ${task.requiredRole} role`);
    }
    this.assertAssignment(task.projectId, agentId, role);
  }

  createReviewFollowup(parent: BoardTask, now: string): ReviewFollowupResult | null {
    const nextKind: TaskKind | null = parent.kind === "manager_review"
      ? "human_check"
      : parent.kind === "work" && parent.requiresReview && parent.assignedRole === "engineer"
        ? "manager_review"
        : null;
    if (nextKind === null) return null;
    let source = parent;
    if (nextKind === "human_check") {
      if (parent.parentTaskId === null) return null;
      source = this.requireTask(parent.parentTaskId);
      if (source.kind !== "work" || !source.requiresReview) return null;
    }
    const existing = this.store.db.prepare(`
      SELECT task_id FROM tasks WHERE parent_task_id = ? AND task_kind = ? LIMIT 1
    `).get(parent.taskId, nextKind);
    if (existing) return Object.freeze({ taskId: stringValue(existing, "task_id"), wakeAgentId: null });

    const taskId = randomUUID();
    const requiredRole: AgentRole | null = nextKind === "manager_review" ? "manager" : null;
    const managers = nextKind === "manager_review"
      ? this.store.db.prepare(`
          SELECT agent_id FROM agents
          WHERE project_id = ? AND role = 'manager'
          ORDER BY created_at, agent_id
          LIMIT 2
        `).all(parent.projectId)
      : [];
    const assignedAgentId = managers.length === 1 ? stringValue(managers[0]!, "agent_id") : null;
    const assignedRole: AgentRole | null = assignedAgentId === null ? null : "manager";
    const status: TaskStatus = assignedAgentId === null ? "backlog" : "queued";
    const titlePrefix = nextKind === "manager_review" ? "Manager review: " : "Human check: ";
    const title = `${titlePrefix}${source.title}`.slice(0, 240).trimEnd();
    const objective = (nextKind === "manager_review"
      ? `Review the completed engineer work and its evidence for this outcome: ${source.objective}`
      : `Decide whether the reviewed work is ready for the next human-controlled release step: ${source.objective}`)
      .slice(0, 4_000)
      .trimEnd();
    const acceptanceCriteria = nextKind === "manager_review"
      ? "Inspect the completed work, test evidence, result, and risks; record a clear recommendation for a human."
      : "A human records the final decision and rationale. This task cannot be assigned to or completed by an agent.";
    const orderKey = this.nextTaskOrderKey();
    this.store.db.prepare(`
      INSERT INTO tasks(
        task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
        title, objective, acceptance_criteria, workspace_refs_json,
        status, assigned_agent_id, assigned_role, expected_agent_minutes, agent_estimate_minutes,
        estimate_recorded_at, order_key, started_at, ended_at,
        result, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 15, NULL, NULL, ?, NULL, NULL, NULL, 1, ?, ?)
    `).run(
      taskId,
      parent.projectId,
      parent.taskId,
      nextKind,
      requiredRole,
      title,
      objective,
      acceptanceCriteria,
      canonicalJson(parent.workspaceRefs),
      status,
      assignedAgentId,
      assignedRole,
      orderKey,
      now,
      now,
    );
    this.insertEvent(parent.projectId, taskId, { type: "system", id: REVIEW_WORKFLOW_ACTOR }, "task_created", {
      kind: nextKind,
      requiredRole,
      requiresReview: false,
      parentTaskId: parent.taskId,
      status,
      assignedAgentId,
      expectedAgentMinutes: null,
      orderKey,
    }, now);
    this.insertEvent(parent.projectId, parent.taskId, { type: "system", id: REVIEW_WORKFLOW_ACTOR }, "review_followup_created", {
      childTaskId: taskId,
      childKind: nextKind,
      childRequiredRole: requiredRole,
      childAssignedAgentId: assignedAgentId,
    }, now);
    if (assignedAgentId !== null) {
      this.insertWakeup(
        parent.projectId,
        assignedAgentId,
        "workflow_handoff",
        `manager-review:${parent.taskId}:${taskId}`,
        taskId,
        null,
        `Review completed engineer task: ${source.title}`,
        now,
        REVIEW_WORKFLOW_ACTOR,
      );
    }
    return Object.freeze({ taskId, wakeAgentId: assignedAgentId });
  }

  retirePendingWakeupsForTask(
    taskId: string,
    retirementReason: string,
    now: string,
    preservedWakeupId: string | null = null,
  ): void {
    const task = this.requireTask(taskId);
    const rows = this.store.db.prepare(`
      SELECT *
      FROM wakeups AS wakeup
      WHERE wakeup.task_id = ?
        AND wakeup.claimed_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM task_events AS event
          WHERE event.event_id = ? || wakeup.wakeup_id
        )
      ORDER BY wakeup.created_at, wakeup.rowid
    `).all(taskId, RETIRED_WAKEUP_EVENT_PREFIX);
    for (const row of rows) {
      if (stringValue(row, "wakeup_id") !== preservedWakeupId) this.retireWakeup(row, task, retirementReason, now);
    }
  }

  retireStaleWakeupsForAgent(agentId: string, now: string): void {
    const rows = this.store.db.prepare(`
      SELECT *
      FROM wakeups AS wakeup
      WHERE wakeup.agent_id = ?
        AND wakeup.claimed_at IS NULL
        AND wakeup.task_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM task_events AS event
          WHERE event.event_id = ? || wakeup.wakeup_id
        )
      ORDER BY wakeup.created_at DESC, wakeup.rowid DESC
    `).all(agentId, RETIRED_WAKEUP_EVENT_PREFIX);
    const preferredByTask = new Map<string, { wakeupId: string; isHumanAnswer: boolean }>();
    for (const row of rows) {
      const wakeup = wakeupFromRow(row);
      if (wakeup.taskId === null) continue;
      const preferred = preferredByTask.get(wakeup.taskId);
      if (preferred === undefined || (!preferred.isHumanAnswer && wakeup.reason === "human_answer")) {
        preferredByTask.set(wakeup.taskId, {
          wakeupId: wakeup.wakeupId,
          isHumanAnswer: wakeup.reason === "human_answer",
        });
      }
    }
    for (const row of rows) {
      const wakeup = wakeupFromRow(row);
      if (wakeup.taskId === null) continue;
      const taskRow = this.store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(wakeup.taskId);
      const task = taskRow === undefined ? null : this.requireTask(stringValue(taskRow, "task_id"));
      const preferredWakeupId = preferredByTask.get(wakeup.taskId)?.wakeupId ?? wakeup.wakeupId;
      const supersededByWakeupId = preferredWakeupId === wakeup.wakeupId ? null : preferredWakeupId;
      let retirementReason: string | null = null;
      if (supersededByWakeupId !== null) retirementReason = "superseded_by_preferred_wakeup";
      else if (task === null) retirementReason = "task_missing";
      else if (task.projectId !== wakeup.projectId) retirementReason = "task_project_changed";
      else {
        if (wakeup.reason === "workflow_handoff") {
          const sourceRow = task.parentTaskId === null
            ? undefined
            : this.store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(task.parentTaskId);
          const source = sourceRow === undefined ? null : this.requireTask(stringValue(sourceRow, "task_id"));
          if (
            task.kind !== "manager_review" || task.requiredRole !== "manager" ||
            source === null || source.kind !== "work" || !source.requiresReview ||
            source.status !== "completed" || source.endedAt === null || source.result === null
          ) {
            retirementReason = "workflow_handoff_scope_invalid";
          }
        }
        if (retirementReason === null) {
          if (task.status === "cancelled") retirementReason = "task_cancelled";
          else if (isHardTerminalTaskStatus(task.status)) {
            retirementReason = "task_terminal";
          } else if (task.assignedAgentId === null) retirementReason = "task_unassigned";
          else if (task.assignedAgentId !== agentId) retirementReason = "task_reassigned";
          else if (task.status !== "queued" && task.status !== "blocked") retirementReason = "task_not_runnable";
        }
      }
      if (retirementReason === null) continue;
      this.retireWakeup(row, task, retirementReason, now, supersededByWakeupId);
    }
  }

  insertWakeup(
    projectId: string,
    agentId: string,
    reason: Wakeup["reason"],
    sourceKey: string,
    taskId: string | null,
    questionId: string | null,
    detail: string,
    now: string,
    createdBy = this.config.humanPrincipal,
  ): string {
    const wakeupId = randomUUID();
    this.store.db.prepare(`
      INSERT INTO wakeups(
        wakeup_id, project_id, agent_id, reason, source_key, task_id, question_id,
        detail, created_by, created_at, claimed_at, run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      wakeupId,
      projectId,
      agentId,
      reason,
      sourceKey,
      taskId,
      questionId,
      detail,
      createdBy,
      now,
    );
    return wakeupId;
  }

  insertEvent(
    projectId: string,
    taskId: string | null,
    actor: Actor | Readonly<{ type: "system"; id: string }>,
    eventType: string,
    data: Readonly<Record<string, unknown>>,
    now: string,
  ): void {
    this.store.db.prepare(`
      INSERT INTO task_events(event_id, project_id, task_id, actor_type, actor_id, event_type, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), projectId, taskId, actor.type, actor.id, eventType, canonicalJson(data), now);
  }

  retainWorkerConnection(agentId: string, connection: ActiveWorkerConnection): () => void {
    const counts = this.#workerConnections.get(agentId) ?? { waitingForWake: 0, watchingRun: 0 };
    if (!this.#workerConnections.has(agentId)) this.#workerConnections.set(agentId, counts);
    if (connection === "waiting_for_wake") counts.waitingForWake += 1;
    else counts.watchingRun += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.#workerConnections.get(agentId) !== counts) return;
      if (connection === "waiting_for_wake") counts.waitingForWake -= 1;
      else counts.watchingRun -= 1;
      if (counts.waitingForWake === 0 && counts.watchingRun === 0) this.#workerConnections.delete(agentId);
    };
  }

  close(): void {
    this.interruptEvents.removeAllListeners();
    this.wakeupEvents.removeAllListeners();
    this.documentEvents.removeAllListeners();
    // projectEvents was omitted here before, so subscribeProjectEvents
    // listeners outlived close(). All four emitters are released together.
    this.projectEvents.removeAllListeners();
    this.#workerConnections.clear();
  }

  private workerConnection(agentId: string): WorkerConnection {
    const counts = this.#workerConnections.get(agentId);
    if (counts === undefined) return null;
    if (counts.watchingRun > 0) return "watching_run";
    return counts.waitingForWake > 0 ? "waiting_for_wake" : null;
  }

  private retireWakeup(
    row: Row,
    task: BoardTask | null,
    retirementReason: string,
    now: string,
    supersededByWakeupId: string | null = null,
  ): void {
    const wakeup = wakeupFromRow(row);
    const eventId = retiredWakeupEventId(wakeup.wakeupId);
    if (this.store.db.prepare("SELECT 1 FROM task_events WHERE event_id = ?").get(eventId)) return;
    this.store.db.prepare(`
      INSERT INTO task_events(
        event_id, project_id, task_id, actor_type, actor_id, event_type, data_json, created_at
      ) VALUES (?, ?, ?, 'system', 'steward:wakeup-retirement', 'agent_wakeup_retired', ?, ?)
    `).run(
      eventId,
      wakeup.projectId,
      task === null ? null : wakeup.taskId,
      canonicalJson({
        agentId: wakeup.agentId,
        assignedAgentId: task?.assignedAgentId ?? null,
        retirementReason,
        supersededByWakeupId,
        taskStatus: task?.status ?? null,
        wakeReason: wakeup.reason,
        wakeupId: wakeup.wakeupId,
      }),
      now,
    );
  }
}
