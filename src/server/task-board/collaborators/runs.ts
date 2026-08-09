import { randomUUID } from "node:crypto";
import {
  TASK_BOARD_API_VERSION,
  type AgentInterrupt,
  type AgentRun,
  type ClaimRunRequest,
  type ClaimRunResult,
  type CreatePlanRevisionRequest,
  type InterruptAgentRequest,
  type ResumeAgentRequest,
  type RunInterruptBatch,
  type SettleRunRequest,
  type TaskStatus,
  type Wakeup,
  type WorkNode,
  type WorkflowStage,
} from "#shared/task-board-contract";
import { sha256 } from "../canonical.js";
import { conflict, TaskBoardError } from "../errors.js";
import { RETIRED_WAKEUP_EVENT_PREFIX } from "../persistence/retired-wakeups.js";
import {
  claimMessageCursor,
  claimRequestHash,
  legacyClaimRequestHash,
} from "../persistence/run-claims.js";
import {
  interruptFromRow,
  messageFromRow,
  nullableString,
  questionFromRow,
  runFromRow,
  stringValue,
  wakeupFromRow,
} from "../persistence/rows.js";
import { exactNow } from "../persistence/timestamps.js";
import type { AutomationCollaborator } from "./automation.js";
import type { ProjectsCollaborator } from "./projects.js";
import type { TaskBoardRuntime } from "./runtime.js";

export class RunsCollaborator {
  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly automation: AutomationCollaborator,
    private readonly projects: ProjectsCollaborator,
  ) {}

  resumeAgent(agentId: string, request: ResumeAgentRequest, idempotencyKey: string): { wakeup: Wakeup; duplicate: boolean } {
    const agent = this.runtime.requireAgent(agentId);
    if (request.taskId !== null) {
      const task = this.runtime.requireTask(request.taskId);
      if (task.projectId !== agent.projectId) throw conflict("TASK_PROJECT_MISMATCH", "Resume task belongs to another project");
      if (task.kind === "human_check") throw conflict("HUMAN_CHECK_NOT_ASSIGNABLE", "Human checks cannot wake an agent");
      if (task.requiredRole !== null && task.requiredRole !== agent.role) {
        throw conflict("TASK_REQUIRED_ROLE_MISMATCH", `This task requires the ${task.requiredRole} role`);
      }
    }
    const sourceKey = `${agentId}:${idempotencyKey}`;
    const prior = this.runtime.store.db.prepare("SELECT * FROM wakeups WHERE reason = 'human_resume' AND source_key = ?").get(sourceKey);
    if (prior) {
      if (stringValue(prior, "detail") !== request.reason || nullableString(prior, "task_id") !== request.taskId) {
        throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key was used for another resume");
      }
      return { wakeup: wakeupFromRow(prior), duplicate: true };
    }
    const now = exactNow(this.runtime.config.now);
    let wakeupId = "";
    this.runtime.store.transaction(() => {
      wakeupId = this.runtime.insertWakeup(
        agent.projectId,
        agentId,
        "human_resume",
        sourceKey,
        request.taskId,
        null,
        request.reason,
        now,
      );
      this.runtime.insertEvent(agent.projectId, request.taskId, { type: "human", id: this.runtime.config.humanPrincipal }, "agent_resumed", {
        agentId,
        wakeupId,
      }, now);
    });
    this.runtime.wakeupEvents.emit(agentId);
    return { wakeup: wakeupFromRow(this.runtime.store.db.prepare("SELECT * FROM wakeups WHERE wakeup_id = ?").get(wakeupId)!), duplicate: false };
  }

  interruptAgent(
    agentId: string,
    request: InterruptAgentRequest,
    idempotencyKey: string,
  ): { interrupt: AgentInterrupt; duplicate: boolean } {
    const agent = this.runtime.requireAgent(agentId);
    const hash = sha256({ action: "interrupt_agent", agentId, request });
    const prior = this.runtime.store.db.prepare("SELECT * FROM interrupts WHERE agent_id = ? AND idempotency_key = ?").get(agentId, idempotencyKey);
    if (prior) {
      if (stringValue(prior, "request_hash") !== hash) throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key was used for another interrupt");
      return { interrupt: interruptFromRow(prior), duplicate: true };
    }
    const active = this.runtime.store.db.prepare("SELECT run_id FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
    const runId = active ? stringValue(active, "run_id") : null;
    const now = exactNow(this.runtime.config.now);
    const interruptId = randomUUID();
    this.runtime.store.transaction(() => {
      this.runtime.store.db.prepare(`
        INSERT INTO interrupts(
          interrupt_id, project_id, agent_id, run_id, idempotency_key, request_hash, reason, requested_by, requested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(interruptId, agent.projectId, agentId, runId, idempotencyKey, hash, request.reason, this.runtime.config.humanPrincipal, now);
      this.runtime.insertEvent(agent.projectId, null, { type: "human", id: this.runtime.config.humanPrincipal }, "agent_interrupt_requested", {
        interruptId,
        agentId,
        runId,
        reason: request.reason,
      }, now);
    });
    const interrupt = interruptFromRow(this.runtime.store.db.prepare("SELECT * FROM interrupts WHERE interrupt_id = ?").get(interruptId)!);
    if (runId !== null) this.runtime.interruptEvents.emit(runId);
    return { interrupt, duplicate: false };
  }

  async waitForRunInterrupts(
    runId: string,
    agentId: string,
    after: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<RunInterruptBatch | null> {
    this.runtime.requireRun(runId, agentId, null, false);
    if (signal.aborted) return null;
    const immediate = this.interruptBatch(runId, after);
    if (immediate.items.length > 0 || waitMs === 0) return immediate.items.length > 0 ? immediate : null;
    const releaseConnection = this.runtime.retainWorkerConnection(agentId, "watching_run");
    try {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          this.runtime.interruptEvents.off(runId, done);
          signal.removeEventListener("abort", done);
          resolve();
        };
        this.runtime.interruptEvents.once(runId, done);
        signal.addEventListener("abort", done, { once: true });
        timer = setTimeout(done, waitMs);
        timer.unref();
        if (signal.aborted) done();
      });
    } finally {
      releaseConnection();
    }
    if (signal.aborted) return null;
    const batch = this.interruptBatch(runId, after);
    return batch.items.length > 0 ? batch : null;
  }

  claimRun(agentId: string, request: ClaimRunRequest): ClaimRunResult | null {
    const agent = this.runtime.requireAgent(agentId);
    const prior = this.runtime.store.db.prepare("SELECT * FROM runs WHERE agent_id = ? AND claim_id = ?").get(agentId, request.claimId);
    if (prior) {
      const priorRun = runFromRow(prior);
      const requestHash = claimRequestHash(agentId, request, priorRun.taskId);
      const storedHash = stringValue(prior, "claim_request_hash");
      const selectedCursor = claimMessageCursor(request, priorRun.taskId);
      if (storedHash !== requestHash && storedHash !== legacyClaimRequestHash(agentId, request.claimId, selectedCursor)) {
        throw conflict("CLAIM_ID_CONFLICT", "claimId was used with another cursor");
      }
      return this.claimResult(priorRun, selectedCursor ?? 0);
    }
    const existing = this.runtime.store.db.prepare("SELECT run_id FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
    if (existing) throw conflict("AGENT_RUN_ACTIVE", "Agent already has an active run");
    const now = exactNow(this.runtime.config.now);
    const claimed = this.runtime.store.transaction(() => {
      const activeInside = this.runtime.store.db.prepare("SELECT 1 FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
      if (activeInside) throw conflict("AGENT_RUN_ACTIVE", "Agent already has an active run");
      this.runtime.retireStaleWakeupsForAgent(agentId, now);
      const wakeupRow = this.runtime.store.db.prepare(`
        SELECT wakeup.*
        FROM wakeups AS wakeup
        LEFT JOIN tasks AS ordered_task ON ordered_task.task_id = wakeup.task_id
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
        ORDER BY
          CASE WHEN ordered_task.task_id IS NULL THEN 1 ELSE 0 END,
          ordered_task.order_key,
          ordered_task.task_id,
          wakeup.created_at,
          wakeup.rowid
        LIMIT 1
      `).get(agentId, RETIRED_WAKEUP_EVENT_PREFIX);
      if (!wakeupRow) return null;
      const wakeup = wakeupFromRow(wakeupRow);
      const requestHash = claimRequestHash(agentId, request, wakeup.taskId);
      const runId = randomUUID();
      this.runtime.store.db.prepare(`
        INSERT INTO runs(run_id, claim_id, claim_request_hash, project_id, agent_id, wakeup_id, task_id, status, started_at, ended_at, result)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL)
      `).run(runId, request.claimId, requestHash, agent.projectId, agentId, wakeup.wakeupId, wakeup.taskId, now);
      const claim = this.runtime.store.db.prepare(`
        UPDATE wakeups SET claimed_at = ?, run_id = ? WHERE wakeup_id = ? AND claimed_at IS NULL
      `).run(now, runId, wakeup.wakeupId);
      if (Number(claim.changes) !== 1) throw conflict("WAKEUP_ALREADY_CLAIMED", "Wakeup was already claimed");
      if (wakeup.taskId !== null) {
        const taskRow = this.runtime.store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(wakeup.taskId);
        if (!taskRow) throw new Error("TASK_BOARD_DATABASE_CORRUPT:wakeup_task");
        const task = this.runtime.requireTask(wakeup.taskId);
        if (task.assignedAgentId !== agentId) {
          throw conflict("WAKEUP_TASK_NOT_ASSIGNED", "Wakeup task is no longer assigned to this agent");
        }
        if (task.endedAt !== null) throw conflict("WAKEUP_TASK_TERMINAL", "Wakeup task is already terminal");
        if (task.status === "queued" || task.status === "blocked") {
          const started = this.runtime.store.db.prepare(`
            UPDATE tasks
            SET status = 'in_progress', started_at = COALESCE(started_at, ?), version = version + 1, updated_at = ?
            WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND status IN ('queued', 'blocked') AND ended_at IS NULL
          `).run(now, now, task.taskId, agentId, task.version);
          if (Number(started.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Task changed while its run was starting");
          this.runtime.insertEvent(task.projectId, task.taskId, { type: "agent", id: agentId }, "task_run_started", {
            kind: task.kind,
            requiredRole: task.requiredRole,
            runId,
            previousStatus: task.status,
            status: "in_progress",
            version: task.version + 1,
          }, now);
        }
      }
      this.runtime.insertEvent(agent.projectId, wakeup.taskId, { type: "agent", id: agentId }, "agent_run_claimed", {
        runId,
        claimId: request.claimId,
        wakeupId: wakeup.wakeupId,
        wakeReason: wakeup.reason,
      }, now);
      return Object.freeze({ runId, wakeup });
    });
    if (claimed === null) return null;
    return this.claimResult(
      runFromRow(this.runtime.store.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(claimed.runId)!),
      claimMessageCursor(request, claimed.wakeup.taskId) ?? 0,
    );
  }

  async waitToClaimRun(
    agentId: string,
    request: ClaimRunRequest,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<ClaimRunResult | null> {
    if (signal.aborted) {
      this.runtime.requireAgent(agentId);
      return null;
    }
    const immediate = this.claimRun(agentId, request);
    if (immediate !== null || waitMs === 0) return immediate;
    const releaseConnection = this.runtime.retainWorkerConnection(agentId, "waiting_for_wake");
    try {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          this.runtime.wakeupEvents.off(agentId, done);
          signal.removeEventListener("abort", done);
          resolve();
        };
        this.runtime.wakeupEvents.once(agentId, done);
        signal.addEventListener("abort", done, { once: true });
        timer = setTimeout(done, waitMs);
        timer.unref();
        if (signal.aborted) done();
      });
    } finally {
      releaseConnection();
    }
    if (signal.aborted) return null;
    return this.claimRun(agentId, request);
  }

  settleRun(runId: string, agentId: string, request: SettleRunRequest): { run: AgentRun; duplicate: boolean } {
    const row = this.runtime.store.db.prepare("SELECT * FROM runs WHERE run_id = ? AND agent_id = ?").get(runId, agentId);
    if (!row) throw new TaskBoardError(404, "RUN_NOT_FOUND", "Run was not found");
    const current = runFromRow(row);
    if (current.status !== "active") {
      if (current.status === request.outcome && current.result === request.result) {
        let repairedNodes: readonly WorkNode[] = Object.freeze([]);
        const taskId = current.taskId;
        if (taskId !== null) {
          this.runtime.store.transaction(() => {
            if (this.projects.attemptNeedsSettlementRepair(taskId, current.runId)) {
              repairedNodes = this.projects.settleAttemptInTransaction(
                taskId,
                request.outcome,
                request.result,
                request.handoff,
              );
            }
          });
          this.projects.activateWorkflowNodes(repairedNodes);
        }
        return { run: current, duplicate: true };
      }
      throw conflict("RUN_NOT_ACTIVE", "Run is already settled");
    }
    const planning = current.taskId === null ? undefined : this.runtime.store.db.prepare(`
      SELECT w.* FROM work_item_planning_tasks link
      JOIN work_items w ON w.work_item_id=link.work_item_id
      WHERE link.task_id=?
    `).get(current.taskId);
    let workflowProposal: CreatePlanRevisionRequest | null = null;
    if (planning && request.outcome === "completed") {
      if (request.workflowPlan === undefined || request.workflowPlan === null) {
        throw new TaskBoardError(400, "WORKFLOW_PLAN_REQUIRED", "Planning tasks must return a workflow plan");
      }
      const workItemId = String(planning.work_item_id);
      const existingPlan = this.runtime.store.db.prepare(
        "SELECT 1 FROM plan_revisions WHERE work_item_id=? AND state IN ('proposed','confirmed')",
      ).get(workItemId);
      if (!existingPlan) {
        const configured = this.automation.getConfiguration();
        const requiredStages = new Set(request.workflowPlan.nodes.flatMap((node) => node.stageTemplate));
        for (const stage of requiredStages) {
          const executor = configured.stages.find((configuredStage) => configuredStage.stage === stage)?.executor;
          const agentType = executor?.kind === "agent_type"
            ? configured.agentTypes.find((candidate) => candidate.agentTypeId === executor.agentTypeId && candidate.enabled)
            : undefined;
          if (agentType === undefined) {
            throw new TaskBoardError(409, "WORKFLOW_EXECUTOR_UNAVAILABLE", `No enabled executor is configured for ${stage}`);
          }
        }
        const executorTypeIds = new Set(configured.stages.flatMap((stage) =>
          requiredStages.has(stage.stage as WorkflowStage) && stage.executor.kind === "agent_type" ? [stage.executor.agentTypeId] : []));
        const skillIds = [...new Set(configured.agentTypes.flatMap((agentType) =>
          agentType.enabled && executorTypeIds.has(agentType.agentTypeId) ? agentType.skillIds : []))];
        workflowProposal = {
          workItemId,
          projectId: String(planning.resolved_project_id),
          objective: request.workflowPlan.objective,
          assumptions: request.workflowPlan.assumptions,
          acceptanceCriteria: request.workflowPlan.acceptanceCriteria,
          skillIds,
          nodes: request.workflowPlan.nodes,
        };
      }
    } else if (request.workflowPlan !== undefined && request.workflowPlan !== null) {
      throw new TaskBoardError(400, "WORKFLOW_PLAN_NOT_ALLOWED", "Only completed planning tasks can return a workflow plan");
    }
    const now = exactNow(this.runtime.config.now);
    let workflowWakeAgentId: string | null = null;
    let settledWorkflowNodes: readonly WorkNode[] = Object.freeze([]);
    this.runtime.store.transaction(() => {
      if (current.taskId !== null) {
        settledWorkflowNodes = this.projects.settleAttemptInTransaction(
          current.taskId,
          request.outcome,
          request.result,
          request.handoff,
        );
      }
      if (workflowProposal !== null) {
        this.projects.proposeWorkflowForAgentInTransaction(workflowProposal, agentId);
      }
      const update = this.runtime.store.db.prepare(`
        UPDATE runs SET status = ?, ended_at = ?, result = ? WHERE run_id = ? AND agent_id = ? AND status = 'active'
      `).run(request.outcome, now, request.result, runId, agentId);
      if (Number(update.changes) !== 1) throw conflict("RUN_NOT_ACTIVE", "Run is already settled");
      if (current.taskId !== null) {
        const taskRow = this.runtime.store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(current.taskId);
        if (!taskRow) throw new Error("TASK_BOARD_DATABASE_CORRUPT:run_task");
        const task = this.runtime.requireTask(current.taskId);
        if (task.assignedAgentId === agentId && task.endedAt === null) {
          const nextStatus: TaskStatus = request.outcome === "completed" ? "completed" : "blocked";
          if (task.status !== nextStatus || request.outcome === "completed") {
            const lifecycle = request.outcome === "completed"
              ? this.runtime.store.db.prepare(`
                  UPDATE tasks
                  SET status = 'completed', ended_at = ?, result = ?, version = version + 1, updated_at = ?
                  WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND ended_at IS NULL
                `).run(now, request.result, now, task.taskId, agentId, task.version)
              : this.runtime.store.db.prepare(`
                  UPDATE tasks
                  SET status = 'blocked', ended_at = NULL, result = NULL, version = version + 1, updated_at = ?
                  WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND ended_at IS NULL
                `).run(now, task.taskId, agentId, task.version);
            if (Number(lifecycle.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Task changed while its run was settling");
            this.runtime.insertEvent(task.projectId, task.taskId, { type: "agent", id: agentId }, "task_run_settled", {
              kind: task.kind,
              requiredRole: task.requiredRole,
              runId,
              outcome: request.outcome,
              previousStatus: task.status,
              status: nextStatus,
              version: task.version + 1,
            }, now);
            if (request.outcome === "completed") {
              this.runtime.reconcileTaskPhasesForTerminal(task, "completed", { type: "agent", id: agentId }, now);
              this.runtime.retirePendingWakeupsForTask(task.taskId, "task_terminal", now);
              workflowWakeAgentId = this.runtime.createReviewFollowup(task, now)?.wakeAgentId ?? null;
            }
          }
        }
      }
      if (planning && request.outcome !== "completed") {
        this.runtime.store.db.prepare(
          "UPDATE work_items SET state='needs_input',current_stage='planning',version=version+1,updated_at=? WHERE work_item_id=? AND ended_at IS NULL",
        ).run(now, String(planning.work_item_id));
      }
      this.runtime.insertEvent(current.projectId, current.taskId, { type: "agent", id: agentId }, "agent_run_settled", {
        runId,
        outcome: request.outcome,
      }, now);
    });
    if (workflowWakeAgentId !== null) this.runtime.wakeupEvents.emit(workflowWakeAgentId);
    this.projects.activateWorkflowNodes(settledWorkflowNodes);
    return { run: runFromRow(this.runtime.store.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId)!), duplicate: false };
  }

  private claimResult(run: AgentRun, cursor: number): ClaimRunResult {
    const wakeup = wakeupFromRow(this.runtime.store.db.prepare("SELECT * FROM wakeups WHERE wakeup_id = ?").get(run.wakeupId)!);
    const task = wakeup.taskId === null ? null : this.runtime.requireTask(wakeup.taskId);
    const messages = task === null ? [] : this.runtime.store.db.prepare(`
      SELECT * FROM task_messages WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT 100
    `).all(task.taskId, cursor).map(messageFromRow);
    const messageCursor = messages.at(-1)?.sequence ?? cursor;
    const triggerQuestion = wakeup.questionId === null
      ? null
      : questionFromRow(this.runtime.store.db.prepare("SELECT * FROM questions WHERE question_id = ?").get(wakeup.questionId)!);
    const parentTask = task?.parentTaskId ? this.runtime.requireTask(task.parentTaskId) : null;
    const parentMessages = parentTask === null ? [] : this.runtime.store.db.prepare(`
      SELECT * FROM (
        SELECT * FROM task_messages WHERE task_id = ? ORDER BY sequence DESC LIMIT 12
      ) ORDER BY sequence
    `).all(parentTask.taskId).map(messageFromRow);
    const areaMemory = this.runtime.store.db.prepare(`
      SELECT task_id, title, substr(result, 1, 1000) AS result, ended_at
      FROM tasks
      WHERE project_id = ?
        AND assigned_agent_id = ?
        AND status = 'completed'
        AND result IS NOT NULL
        AND ended_at IS NOT NULL
        AND (? IS NULL OR task_id <> ?)
      ORDER BY ended_at DESC, task_id DESC
      LIMIT 8
    `).all(run.projectId, run.agentId, run.taskId, run.taskId).map((row) => Object.freeze({
      taskId: stringValue(row, "task_id"),
      title: stringValue(row, "title"),
      result: stringValue(row, "result"),
      endedAt: stringValue(row, "ended_at"),
    }));
    const project = this.runtime.requireProject(run.projectId);
    return Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      run,
      wakeup,
      task,
      context: Object.freeze({
        agent: this.runtime.requireAgent(run.agentId),
        projectMemory: Object.freeze({ projectId: project.projectId, name: project.name, description: project.description }),
        areaMemory: Object.freeze(areaMemory),
        parentTask,
        parentMessages: Object.freeze(parentMessages),
        acceptanceCriteria: task?.acceptanceCriteria ?? null,
        workspaceRefs: task?.workspaceRefs ?? Object.freeze([]),
        messageCursor,
        messages: Object.freeze(messages),
        triggerQuestion,
        openQuestions: Object.freeze(this.runtime.store.db.prepare(`
          SELECT * FROM questions WHERE agent_id = ? AND status = 'open' ORDER BY asked_at, question_id LIMIT 50
        `).all(run.agentId).map(questionFromRow)),
        workflow: task === null ? null : this.projects.claimContext(task.taskId),
      }),
    });
  }

  private interruptBatch(runId: string, after: number): RunInterruptBatch {
    const items = this.runtime.store.db.prepare(`
      SELECT * FROM interrupts WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT 100
    `).all(runId, after).map(interruptFromRow);
    return Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      items: Object.freeze(items),
      cursor: items.at(-1)?.sequence ?? after,
    });
  }
}
