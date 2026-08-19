import { randomUUID } from "node:crypto";
import {
  TASK_BOARD_API_VERSION,
  TASK_BOARD_ERROR_CODES,
  isHardTerminalTaskStatus,
  isRecoverableTaskStatus,
  isTerminalWorkItemState,
  pipelineTemplateShape,
  type AgentInterrupt,
  type AgentRun,
  type BoardTask,
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
  type WorkItemState,
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
import type { AttemptScopeCheckResult } from "../persistence/workflow.js";
import type { AutomationCollaborator } from "./automation.js";
import type { ProjectsCollaborator } from "./projects.js";
import type { Actor, TaskBoardRuntime } from "./runtime.js";
import {
  checkDeclaredScope,
  runDeclaredScopeGit,
  scopeViolationResult,
  type GitRunner,
} from "./scope-check.js";
import type { TasksCollaborator } from "./tasks.js";
import { transitionWorkItemInTransaction } from "./work-item-transitions.js";

type SettlementEffects = Readonly<{
  workflowWakeAgentId: string | null;
  settledWorkflowNodes: readonly WorkNode[];
}>;

type SettlementActor = Actor | Readonly<{ type: "system"; id: string }>;

type AttemptSettlementPrecheck = Readonly<{
  scopeCheck: AttemptScopeCheckResult | null;
  result: string;
}>;

function attemptSettlementResult(
  request: SettleRunRequest,
  scopeCheck: AttemptScopeCheckResult | null,
): string {
  if (request.outcome === "failed") {
    if (request.result.startsWith("BRIGHT_LINE:")) return request.result;
    if (request.handoff?.summary.startsWith("BRIGHT_LINE:") === true) return request.handoff.summary;
  }
  if (scopeCheck !== null && !scopeCheck.ok) {
    return "files" in scopeCheck ? scopeViolationResult(scopeCheck.files) : scopeCheck.error.slice(0, 2_000);
  }
  return request.result;
}

export const TOKEN_ROTATION_INTERRUPT_REASON = "Agent token rotated by an operator.";

export class RunsCollaborator {
  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly automation: AutomationCollaborator,
    private readonly projects: ProjectsCollaborator,
    private readonly tasks: TasksCollaborator,
    private readonly git: GitRunner = runDeclaredScopeGit,
  ) {}

  private scopeCheckForSettlement(taskId: string, outcome: SettleRunRequest["outcome"]): AttemptScopeCheckResult | null {
    if (outcome !== "completed") return null;
    const row = this.runtime.store.db.prepare(`
      SELECT
        attempt.stage,
        project.description AS repo_path,
        item.base_sha,
        item.pipeline_branch,
        plan.declared_scope_json
      FROM stage_attempts attempt
      JOIN work_nodes node ON node.node_id=attempt.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      JOIN projects project ON project.project_id=node.project_id
      WHERE attempt.task_id=?
    `).get(taskId);
    if (row === undefined || row.stage !== "implementation") return null;
    if (row.pipeline_branch === null && row.base_sha === null) return null;
    if (
      typeof row.repo_path !== "string" || typeof row.base_sha !== "string" ||
      typeof row.pipeline_branch !== "string" || typeof row.declared_scope_json !== "string"
    ) return Object.freeze({ ok: false, error: "scope check failed" });
    let declaredScope: unknown;
    try {
      declaredScope = JSON.parse(row.declared_scope_json);
    } catch {
      return Object.freeze({ ok: false, error: "scope check failed" });
    }
    if (!Array.isArray(declaredScope) || !declaredScope.every((prefix) => typeof prefix === "string")) {
      return Object.freeze({ ok: false, error: "scope check failed" });
    }
    try {
      return checkDeclaredScope({
        repoPath: row.repo_path,
        baseSha: row.base_sha,
        branch: row.pipeline_branch,
        declaredScope,
        git: this.git,
      });
    } catch {
      return Object.freeze({ ok: false, error: "scope check failed" });
    }
  }

  resumeAgent(agentId: string, request: ResumeAgentRequest, idempotencyKey: string): { wakeup: Wakeup; duplicate: boolean } {
    const agent = this.runtime.requireAgent(agentId);
    let requestedTask: BoardTask | null = null;
    if (request.taskId !== null) {
      const task = this.runtime.requireTask(request.taskId);
      if (task.projectId !== agent.projectId) throw conflict("TASK_PROJECT_MISMATCH", "Resume task belongs to another project");
      if (isHardTerminalTaskStatus(task.status)) {
        throw conflict(TASK_BOARD_ERROR_CODES.TASK_TERMINAL, "Completed and cancelled tasks cannot be resumed");
      }
      if (task.kind === "human_check") throw conflict("HUMAN_CHECK_NOT_ASSIGNABLE", "Human checks cannot wake an agent");
      if (task.requiredRole !== null && task.requiredRole !== agent.role) {
        throw conflict("TASK_REQUIRED_ROLE_MISMATCH", `This task requires the ${task.requiredRole} role`);
      }
      requestedTask = task;
    }
    const sourceKey = `${agentId}:${idempotencyKey}`;
    const prior = this.runtime.store.db.prepare(
      "SELECT * FROM wakeups WHERE reason IN ('human_resume', 'resumed') AND source_key = ?",
    ).get(sourceKey);
    if (prior) {
      if (stringValue(prior, "detail") !== request.reason || nullableString(prior, "task_id") !== request.taskId) {
        throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key was used for another resume");
      }
      return { wakeup: wakeupFromRow(prior), duplicate: true };
    }
    if (requestedTask !== null && isRecoverableTaskStatus(requestedTask.status)) {
      if (requestedTask.assignedAgentId === null || requestedTask.assignedRole === null) {
        throw conflict(TASK_BOARD_ERROR_CODES.TASK_UNASSIGNED, "Recoverable task has no assigned agent");
      }
      const recovered = this.tasks.retryTaskFromResume(requestedTask.taskId, agentId, sourceKey, request.reason);
      return { wakeup: recovered.wakeup, duplicate: false };
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
    let interrupt!: AgentInterrupt;
    this.runtime.store.transaction(() => {
      interrupt = this.insertInterruptInTransaction(agent.projectId, agentId, runId, idempotencyKey, hash, request.reason, now);
    });
    if (runId !== null) this.runtime.interruptEvents.emit(runId);
    return { interrupt, duplicate: false };
  }

  interruptActiveRunForTokenRotationInTransaction(agentId: string, version: number): void {
    const agent = this.runtime.requireAgent(agentId);
    const active = this.runtime.store.db.prepare(
      "SELECT * FROM runs WHERE agent_id = ? AND status = 'active'",
    ).get(agentId);
    if (active === undefined) return;
    const current = runFromRow(active);
    const now = exactNow(this.runtime.config.now);
    const idempotencyKey = `token-rotation:${version}`;
    const reason = TOKEN_ROTATION_INTERRUPT_REASON;
    const hash = sha256({ action: "token_rotation_interrupt", agentId, version, reason });
    this.insertInterruptInTransaction(agent.projectId, agentId, current.runId, idempotencyKey, hash, reason, now);
    const effects = this.settleActiveRunInTransaction(
      current,
      agentId,
      { outcome: "interrupted", result: reason },
      now,
      { type: "human", id: this.runtime.config.humanPrincipal },
    );
    this.runtime.store.afterCommit(() => {
      this.runtime.interruptEvents.emit(current.runId);
      if (effects.workflowWakeAgentId !== null) this.runtime.wakeupEvents.emit(effects.workflowWakeAgentId);
      this.projects.activateWorkflowNodes(effects.settledWorkflowNodes);
      this.projects.reconcileWorkflowsBestEffort(current.projectId);
    });
  }

  private insertInterruptInTransaction(
    projectId: string,
    agentId: string,
    runId: string | null,
    idempotencyKey: string,
    hash: string,
    reason: string,
    now: string,
  ): AgentInterrupt {
    const interruptId = randomUUID();
    this.runtime.store.db.prepare(`
      INSERT INTO interrupts(
        interrupt_id, project_id, agent_id, run_id, idempotency_key, request_hash, reason, requested_by, requested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(interruptId, projectId, agentId, runId, idempotencyKey, hash, reason, this.runtime.config.humanPrincipal, now);
    this.runtime.insertEvent(projectId, null, { type: "human", id: this.runtime.config.humanPrincipal }, "agent_interrupt_requested", {
      interruptId,
      agentId,
      runId,
      reason,
    }, now);
    return interruptFromRow(this.runtime.store.db.prepare("SELECT * FROM interrupts WHERE interrupt_id = ?").get(interruptId)!);
  }

  async waitForRunInterrupts(
    runId: string,
    agentId: string,
    after: number,
    waitMs: number,
    signal: AbortSignal,
    credentialVersion?: number,
  ): Promise<RunInterruptBatch | null> {
    this.requireCredentialVersion(agentId, credentialVersion);
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
    this.requireCredentialVersion(agentId, credentialVersion);
    const batch = this.interruptBatch(runId, after);
    return batch.items.length > 0 ? batch : null;
  }

  claimRun(agentId: string, request: ClaimRunRequest, credentialVersion?: number): ClaimRunResult | null {
    this.requireCredentialVersion(agentId, credentialVersion);
    const prior = this.runtime.store.db.prepare("SELECT * FROM runs WHERE agent_id = ? AND claim_id = ?").get(agentId, request.claimId);
    if (prior) {
      const priorRun = runFromRow(prior);
      const requestHash = claimRequestHash(agentId, request, priorRun.taskId);
      const storedHash = stringValue(prior, "claim_request_hash");
      const selectedCursor = claimMessageCursor(request, priorRun.taskId);
      if (storedHash !== requestHash && storedHash !== legacyClaimRequestHash(agentId, request.claimId, selectedCursor)) {
        throw conflict("CLAIM_ID_CONFLICT", "claimId was used with another cursor");
      }
      const persistedResult = nullableString(prior, "claim_result_json");
      if (persistedResult !== null) return this.claimResultFromJson(persistedResult);
      // Legacy runs created before claim-result persistence have NULL here; rebuild them while their source data remains valid.
      const reviewInspection = priorRun.taskId === null
        ? null
        : this.projects.prepareClaimContext(priorRun.taskId);
      return this.claimResult(priorRun, selectedCursor ?? 0, reviewInspection);
    }
    const existing = this.runtime.store.db.prepare("SELECT run_id FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
    if (existing) throw conflict("AGENT_RUN_ACTIVE", "Agent already has an active run");
    const candidate = this.runtime.store.transaction(() => {
      this.requireCredentialVersion(agentId, credentialVersion);
      const activeInside = this.runtime.store.db.prepare("SELECT 1 FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
      if (activeInside) throw conflict("AGENT_RUN_ACTIVE", "Agent already has an active run");
      this.runtime.retireStaleWakeupsForAgent(agentId, exactNow(this.runtime.config.now));
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
      return wakeupRow === undefined ? null : wakeupFromRow(wakeupRow);
    });
    if (candidate === null) return null;

    // Review Git inspection may spawn several bounded subprocesses. It must run
    // after candidate resolution and before the write transaction below.
    const reviewInspection = candidate.taskId === null
      ? null
      : this.projects.prepareClaimContext(candidate.taskId);
    const now = exactNow(this.runtime.config.now);
    let reviewRuntimeConflict: TaskBoardError | null = null;
    const claimed = this.runtime.store.transaction(() => {
      const currentAgent = this.requireCredentialVersion(agentId, credentialVersion);
      const activeInside = this.runtime.store.db.prepare("SELECT 1 FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
      if (activeInside) throw conflict("AGENT_RUN_ACTIVE", "Agent already has an active run");
      const wakeupRow = this.runtime.store.db.prepare(`
        SELECT wakeup.*
        FROM wakeups AS wakeup
        WHERE wakeup.wakeup_id = ?
          AND wakeup.agent_id = ?
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
      `).get(candidate.wakeupId, agentId, RETIRED_WAKEUP_EVENT_PREFIX);
      if (wakeupRow === undefined) return null;
      const wakeup = wakeupFromRow(wakeupRow);
      if (wakeup.taskId !== null) {
        const conflictRow = this.runtime.store.db.prepare(`
          WITH claimed AS (
            SELECT attempt.node_id,node.project_id
            FROM stage_attempts attempt
            JOIN work_nodes node ON node.node_id=attempt.node_id
            JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
            JOIN work_items item ON item.work_item_id=plan.work_item_id
            WHERE attempt.task_id=?
              AND attempt.stage='verification'
              AND item.pipeline_branch IS NOT NULL
          ),
          latest_implementation AS (
            SELECT implementation.task_id
            FROM stage_attempts implementation
            WHERE implementation.node_id=(SELECT node_id FROM claimed)
              AND implementation.stage='implementation'
            ORDER BY implementation.attempt DESC
            LIMIT 1
          ),
          latest_run AS (
            SELECT run.runtime,run.model
            FROM runs run
            JOIN tasks task ON task.task_id=run.task_id
            WHERE task.task_id=(SELECT task_id FROM latest_implementation)
            ORDER BY run.started_at DESC,run.rowid DESC
            LIMIT 1
          )
          SELECT claimed.node_id,claimed.project_id,latest_run.runtime,latest_run.model
          FROM claimed
          LEFT JOIN latest_run ON 1=1
        `).get(wakeup.taskId);
        const reviewRuntime = request.pinned?.runtime ?? null;
        const reviewModel = request.pinned?.model ?? null;
        const implementationRuntime = conflictRow?.runtime ?? null;
        const implementationModel = conflictRow?.model ?? null;
        if (
          conflictRow !== undefined &&
          typeof reviewRuntime === "string" && typeof reviewModel === "string" &&
          typeof implementationRuntime === "string" && typeof implementationModel === "string" &&
          reviewRuntime === implementationRuntime && reviewModel === implementationModel
        ) {
          const message = `review runtime matches implement runtime (${reviewRuntime}/${reviewModel}) — configure a different reviewer lane`;
          this.projects.recordReviewRuntimeConflictInTransaction(
            String(conflictRow.project_id),
            String(conflictRow.node_id),
            wakeup.taskId,
            message,
          );
          reviewRuntimeConflict = new TaskBoardError(
            409,
            TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_RUNTIME_CONFLICT,
            message,
          );
          return null;
        }
      }
      const requestHash = claimRequestHash(agentId, request, wakeup.taskId);
      const runId = randomUUID();
      this.runtime.store.db.prepare(`
        INSERT INTO runs(
          run_id, claim_id, claim_request_hash, project_id, agent_id, wakeup_id, task_id, status, started_at,
          heartbeat_at, ended_at, result, runtime, runtime_version, model, prompts_sha
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, NULL, ?, ?, ?, ?)
      `).run(
        runId,
        request.claimId,
        requestHash,
        currentAgent.projectId,
        agentId,
        wakeup.wakeupId,
        wakeup.taskId,
        now,
        request.pinned?.runtime ?? null,
        request.pinned?.runtimeVersion ?? null,
        request.pinned?.model ?? null,
        request.pinned?.promptsSha ?? null,
      );
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
      this.runtime.insertEvent(currentAgent.projectId, wakeup.taskId, { type: "agent", id: agentId }, "agent_run_claimed", {
        runId,
        claimId: request.claimId,
        wakeupId: wakeup.wakeupId,
        wakeReason: wakeup.reason,
      }, now);
      const result = this.claimResult(
        runFromRow(this.runtime.store.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId)!),
        claimMessageCursor(request, wakeup.taskId) ?? 0,
        reviewInspection,
      );
      const persisted = this.runtime.store.db.prepare(
        "UPDATE runs SET claim_result_json = ? WHERE run_id = ? AND claim_result_json IS NULL",
      ).run(JSON.stringify(result), runId);
      if (Number(persisted.changes) !== 1) throw new Error("TASK_BOARD_DATABASE_CORRUPT:claim_result_json");
      return result;
    });
    if (reviewRuntimeConflict !== null) throw reviewRuntimeConflict;
    return claimed;
  }

  async waitToClaimRun(
    agentId: string,
    request: ClaimRunRequest,
    waitMs: number,
    signal: AbortSignal,
    credentialVersion?: number,
  ): Promise<ClaimRunResult | null> {
    if (signal.aborted) {
      this.runtime.requireAgent(agentId);
      return null;
    }
    const immediate = this.claimRun(agentId, request, credentialVersion);
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
    return this.claimRun(agentId, request, credentialVersion);
  }

  heartbeatRun(runId: string, agentId: string, credentialVersion: number): AgentRun {
    return this.runtime.store.transaction(() => {
      this.runtime.requireAgentCredentialVersion(agentId, credentialVersion);
      const row = this.runtime.store.db.prepare(
        "SELECT * FROM runs WHERE run_id = ? AND agent_id = ?",
      ).get(runId, agentId);
      if (!row) throw new TaskBoardError(404, "RUN_NOT_FOUND", "Run was not found");
      const current = runFromRow(row);
      if (current.status !== "active") throw conflict("RUN_NOT_ACTIVE", "Run is already settled");
      const heartbeatAt = exactNow(this.runtime.config.now);
      const update = this.runtime.store.db.prepare(`
        UPDATE runs SET heartbeat_at = ? WHERE run_id = ? AND agent_id = ? AND status = 'active'
      `).run(heartbeatAt, runId, agentId);
      if (Number(update.changes) !== 1) throw conflict("RUN_NOT_ACTIVE", "Run is already settled");
      return runFromRow(this.runtime.store.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId)!);
    });
  }

  reconcileStaleRuns(): number {
    const timeoutSeconds = this.runtime.config.heartbeatTimeoutSeconds;
    if (timeoutSeconds === 0) return 0;
    const runColumns = new Set(this.runtime.store.db.prepare(
      "SELECT name FROM pragma_table_info('runs')",
    ).all().map((row) => stringValue(row, "name")));
    if (!["run_id", "agent_id", "status", "started_at", "heartbeat_at"].every((column) => runColumns.has(column))) {
      return 0;
    }
    const sweepStartedAt = exactNow(this.runtime.config.now);
    const cutoff = new Date(Date.parse(sweepStartedAt) - timeoutSeconds * 1_000).toISOString();
    const candidates = this.runtime.store.db.prepare(`
      SELECT run_id
      FROM runs
      WHERE status = 'active' AND COALESCE(heartbeat_at, started_at) < ?
      ORDER BY run_id
    `).all(cutoff).map((row) => stringValue(row, "run_id"));
    let settledCount = 0;
    for (const runId of candidates) {
      const settlement = this.runtime.store.transaction(() => {
        const row = this.runtime.store.db.prepare(`
          SELECT *
          FROM runs
          WHERE run_id = ?
            AND status = 'active'
            AND COALESCE(heartbeat_at, started_at) < ?
        `).get(runId, cutoff);
        if (row === undefined) return null;
        const current = runFromRow(row);
        const effects = this.settleActiveRunInTransaction(
          current,
          current.agentId,
          { outcome: "interrupted", result: "run heartbeat lost" },
          exactNow(this.runtime.config.now),
          { type: "system", id: "system:stale-run-sweep" },
        );
        return Object.freeze({ current, effects });
      });
      if (settlement === null) continue;
      if (settlement.effects.workflowWakeAgentId !== null) {
        this.runtime.wakeupEvents.emit(settlement.effects.workflowWakeAgentId);
      }
      this.projects.activateWorkflowNodes(settlement.effects.settledWorkflowNodes);
      this.projects.reconcileWorkflowsBestEffort(settlement.current.projectId);
      settledCount += 1;
    }
    return settledCount;
  }

  settleRun(runId: string, agentId: string, request: SettleRunRequest): { run: AgentRun; duplicate: boolean } {
    const row = this.runtime.store.db.prepare("SELECT * FROM runs WHERE run_id = ? AND agent_id = ?").get(runId, agentId);
    if (!row) throw new TaskBoardError(404, "RUN_NOT_FOUND", "Run was not found");
    const current = runFromRow(row);
    if (current.status !== "active") {
      if (current.status === request.outcome && current.result === request.result) {
        let repairedNodes: readonly WorkNode[] = Object.freeze([]);
        const taskId = current.taskId;
        const needsRepair = taskId !== null && this.projects.attemptNeedsSettlementRepair(taskId, current.runId);
        if (taskId !== null && needsRepair) {
          const scopeCheck = this.scopeCheckForSettlement(taskId, request.outcome);
          const settlementResult = attemptSettlementResult(request, scopeCheck);
          this.runtime.store.transaction(() => {
            if (this.projects.attemptNeedsSettlementRepair(taskId, current.runId)) {
              repairedNodes = this.projects.settleAttemptInTransaction(
                taskId,
                request.outcome,
                settlementResult,
                request.handoff,
                scopeCheck,
              );
            }
          });
          this.projects.activateWorkflowNodes(repairedNodes);
          this.projects.reconcileWorkflowsBestEffort(current.projectId);
        }
        return { run: current, duplicate: true };
      }
      throw conflict("RUN_NOT_ACTIVE", "Run is already settled");
    }
    const scopeCheck = current.taskId === null ? null : this.scopeCheckForSettlement(current.taskId, request.outcome);
    const attemptPrecheck = Object.freeze({
      scopeCheck,
      result: attemptSettlementResult(request, scopeCheck),
    });
    const now = exactNow(this.runtime.config.now);
    const effects = this.runtime.store.transaction(() => this.settleActiveRunInTransaction(
      current,
      agentId,
      request,
      now,
      { type: "agent", id: agentId },
      attemptPrecheck,
    ));
    if (effects.workflowWakeAgentId !== null) this.runtime.wakeupEvents.emit(effects.workflowWakeAgentId);
    this.projects.activateWorkflowNodes(effects.settledWorkflowNodes);
    this.projects.reconcileWorkflowsBestEffort(current.projectId);
    return { run: runFromRow(this.runtime.store.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId)!), duplicate: false };
  }

  private settleActiveRunInTransaction(
    current: AgentRun,
    agentId: string,
    request: SettleRunRequest,
    now: string,
    actor: SettlementActor,
    attemptPrecheck?: AttemptSettlementPrecheck,
  ): SettlementEffects {
    let workflowWakeAgentId: string | null = null;
    let settledWorkflowNodes: readonly WorkNode[] = Object.freeze([]);
    const attemptResult = attemptPrecheck?.result ?? request.result;
    // Keep this planning snapshot: its work-item state is reused after task and workflow settlement below.
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
      const pipelineNode = request.workflowPlan.nodes.length === 1 ? request.workflowPlan.nodes[0] : undefined;
      const pipelineShape = pipelineNode === undefined ? null : pipelineTemplateShape(pipelineNode.stageTemplate);
      if (pipelineShape === "v1") {
        throw new TaskBoardError(
          400,
          TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_PLAN_INCOMPLETE,
          "pipeline plans must end in a verification stage (template [\"implementation\",\"testing\",\"verification\"])",
        );
      }
      const workItemId = String(planning.work_item_id);
      if (isTerminalWorkItemState(String(planning.state) as WorkItemState)) {
        this.runtime.insertEvent(
          current.projectId,
          current.taskId,
          actor,
          "work_item_plan_discarded",
          { workItemId, runId: current.runId, reason: "work_item_ended" },
          now,
        );
      } else {
        const existingPlan = this.runtime.store.db.prepare(
          "SELECT 1 FROM plan_revisions WHERE work_item_id=? AND state IN ('proposed','confirmed')",
        ).get(workItemId);
        if (!existingPlan) {
          const configured = this.automation.getConfiguration();
          const requiredStages = new Set(request.workflowPlan.nodes.flatMap((node) => node.stageTemplate));
          for (const stage of requiredStages) {
            const executor = configured.stages.find((configuredStage) => configuredStage.stage === stage)?.executor;
            if (executor?.kind === "machine_verify") continue;
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
            ...request.workflowPlan,
            workItemId,
            projectId: String(planning.resolved_project_id),
            skillIds,
          };
        }
      }
    } else if (request.workflowPlan !== undefined && request.workflowPlan !== null) {
      throw new TaskBoardError(400, "WORKFLOW_PLAN_NOT_ALLOWED", "Only completed planning tasks can return a workflow plan");
    }
    if (current.taskId !== null) {
      settledWorkflowNodes = this.projects.settleAttemptInTransaction(
        current.taskId,
        request.outcome,
        attemptResult,
        request.handoff,
        attemptPrecheck?.scopeCheck ?? null,
      );
    }
    if (workflowProposal !== null) {
      this.projects.proposeWorkflowForAgentInTransaction(workflowProposal, agentId);
    }
    const update = this.runtime.store.db.prepare(`
      UPDATE runs SET status = ?, ended_at = ?, result = ? WHERE run_id = ? AND agent_id = ? AND status = 'active'
    `).run(request.outcome, now, request.result, current.runId, agentId);
    if (Number(update.changes) !== 1) throw conflict("RUN_NOT_ACTIVE", "Run is already settled");
    if (current.taskId !== null) {
      const taskRow = this.runtime.store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(current.taskId);
      if (!taskRow) throw new Error("TASK_BOARD_DATABASE_CORRUPT:run_task");
      const task = this.runtime.requireTask(current.taskId);
      if (task.assignedAgentId === agentId && task.endedAt === null) {
        const nextStatus: TaskStatus = request.outcome;
        if (task.status !== nextStatus || request.outcome === "completed") {
          const lifecycle = request.outcome === "completed"
            ? this.runtime.store.db.prepare(`
                UPDATE tasks
                SET status = 'completed', ended_at = ?, result = ?, version = version + 1, updated_at = ?
                WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND ended_at IS NULL
              `).run(now, attemptResult, now, task.taskId, agentId, task.version)
            : this.runtime.store.db.prepare(`
                UPDATE tasks
                SET status = ?, ended_at = ?, result = ?, version = version + 1, updated_at = ?
                WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND ended_at IS NULL
              `).run(request.outcome, now, attemptResult, now, task.taskId, agentId, task.version);
          if (Number(lifecycle.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Task changed while its run was settling");
          this.runtime.insertEvent(task.projectId, task.taskId, actor, "task_run_settled", {
            kind: task.kind,
            requiredRole: task.requiredRole,
            runId: current.runId,
            outcome: request.outcome,
            previousStatus: task.status,
            status: nextStatus,
            version: task.version + 1,
          }, now);
          if (request.outcome === "completed") {
            if (actor.type === "system") throw new Error("TASK_BOARD_SYSTEM_RUN_COMPLETION_INVALID");
            this.runtime.reconcileTaskPhasesForTerminal(task, "completed", actor, now);
            workflowWakeAgentId = this.runtime.createReviewFollowup(task, now)?.wakeAgentId ?? null;
          }
          this.runtime.retirePendingWakeupsForTask(
            task.taskId,
            request.outcome === "completed" ? "task_terminal" : "task_recovery_required",
            now,
          );
        }
      }
    }
    if (planning && request.outcome !== "completed") {
      const workItemId = String(planning.work_item_id);
      if (isTerminalWorkItemState(String(planning.state) as WorkItemState)) {
        this.runtime.insertEvent(
          current.projectId,
          current.taskId,
          actor,
          "work_item_plan_discarded",
          { workItemId, runId: current.runId, reason: "work_item_ended" },
          now,
        );
      } else {
        transitionWorkItemInTransaction(this.runtime.store, {
          workItemId,
          to: "parked",
          actorType: actor.type,
          actorId: actor.id,
          now,
          currentStage: "planning",
        });
      }
    }
    this.runtime.insertEvent(current.projectId, current.taskId, actor, "agent_run_settled", {
      runId: current.runId,
      outcome: request.outcome,
    }, now);
    return Object.freeze({ workflowWakeAgentId, settledWorkflowNodes });
  }

  private claimResult(
    run: AgentRun,
    cursor: number,
    reviewInspection: ReturnType<ProjectsCollaborator["prepareClaimContext"]>,
  ): ClaimRunResult {
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
    const workflow = task === null ? null : this.projects.claimContext(task.taskId, reviewInspection);
    const areaMemory = workflow?.pipeline !== null && workflow?.pipeline !== undefined
      ? []
      : this.runtime.store.db.prepare(`
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
        intake: task !== null && this.runtime.store.db.prepare(
          "SELECT 1 FROM work_item_planning_tasks WHERE task_id = ?",
        ).get(task.taskId) !== undefined,
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
        workflow,
      }),
    });
  }

  private claimResultFromJson(value: string): ClaimRunResult {
    let result: unknown;
    try {
      result = JSON.parse(value);
    } catch {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:claim_result_json");
    }
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:claim_result_json");
    }
    const envelope = result as { apiVersion?: unknown; run?: unknown; context?: unknown };
    if (envelope.apiVersion !== TASK_BOARD_API_VERSION) throw new Error("TASK_BOARD_DATABASE_CORRUPT:claim_result_json");
    let currentRun: AgentRun | null = null;
    if (envelope.run !== null && typeof envelope.run === "object" && !Array.isArray(envelope.run)) {
      const run = envelope.run as Record<string, unknown>;
      for (const field of ["heartbeatAt", "runtime", "runtimeVersion", "model", "promptsSha"] as const) {
        if (!Object.hasOwn(run, field)) run[field] = null;
      }
      if (typeof run.runId !== "string") throw new Error("TASK_BOARD_DATABASE_CORRUPT:claim_result_json");
      const currentRow = this.runtime.store.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(run.runId);
      if (currentRow === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:claim_result_json");
      currentRun = runFromRow(currentRow);
      run.status = currentRun.status;
      run.heartbeatAt = currentRun.heartbeatAt;
      run.endedAt = currentRun.endedAt;
      run.result = currentRun.result;
    }
    if (envelope.context !== null && typeof envelope.context === "object" && !Array.isArray(envelope.context)) {
      const context = envelope.context as Record<string, unknown>;
      if (!Object.hasOwn(context, "intake")) {
        context.intake = currentRun?.taskId !== null && currentRun?.taskId !== undefined &&
          this.runtime.store.db.prepare("SELECT 1 FROM work_item_planning_tasks WHERE task_id = ?")
            .get(currentRun.taskId) !== undefined;
      }
      if (context.workflow !== null && typeof context.workflow === "object" && !Array.isArray(context.workflow)) {
        const workflow = context.workflow as Record<string, unknown>;
        if (!Object.hasOwn(workflow, "workspaceKey")) workflow.workspaceKey = null;
        if (!Object.hasOwn(workflow, "pipeline")) workflow.pipeline = null;
        if (!Object.hasOwn(workflow, "review")) workflow.review = null;
      }
    }
    return result as ClaimRunResult;
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

  private requireCredentialVersion(agentId: string, credentialVersion: number | undefined) {
    return credentialVersion === undefined
      ? this.runtime.requireAgent(agentId)
      : this.runtime.requireAgentCredentialVersion(agentId, credentialVersion);
  }
}
