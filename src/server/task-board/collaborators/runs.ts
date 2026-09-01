import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  TASK_BOARD_API_VERSION,
  TASK_BOARD_ERROR_CODES,
  WORK_ITEM_PHASES,
  isHardTerminalTaskStatus,
  isRecoverableTaskStatus,
  isTerminalWorkItemState,
  pipelineTemplateShape,
  type AgentInterrupt,
  type AgentRun,
  type BoardTask,
  type ClaimRunRequest,
  type ClaimRunResponse,
  type ClaimRunResult,
  type CreatePlanRevisionRequest,
  type CrossRepoContext,
  type DesignRecordDraft,
  type InterruptAgentRequest,
  type PublishedInterfaceFailureReason,
  type ResumeAgentRequest,
  type RunInterruptBatch,
  type SettleRunRequest,
  type TaskStatus,
  type Wakeup,
  type WorkNode,
  type WorkItemPhase,
  type WorkItemState,
  type WorkflowStage,
} from "#shared/task-board-contract";
import {
  ContractValidationError,
  parseDesignRecordDraft,
  parseWorkerAgentContext,
  publishedInterfaceValidationReason,
  workerAgentContextUsage,
  validateWorkflowPlanChildren,
} from "#shared/task-board-contract/validate";
import { redactForPersistence, redactMultilineForPersistence } from "../../shared/redact.js";
import { defaultGitRunner, type GitRunner, type GitTextRunner, withGitBytes } from "../../shared/git.js";
import { checkDeclaredScope, scopeViolationResult } from "../../shared/scope-check.js";
import { claimContextInputForDigest, projectClaimContext } from "../../shared/claim-context.js";
import { sha256 } from "../canonical.js";
import { conflict, TaskBoardError } from "../errors.js";
import {
  PENDING_LIVE_WAKEUP_PREDICATE_SQL,
  RETIRED_WAKEUP_EVENT_PREFIX,
  type ExpandInterfacePublicationFailure,
} from "../persistence/workflow.js";
import { claimMessageCursor, claimRequestHash, legacyClaimRequestHash } from "../persistence/run-claims.js";
import {
  interruptFromRow,
  messageFromRow,
  nullableString,
  questionFromRow,
  runFromRow,
  stringValue,
  type Row,
  wakeupFromRow,
} from "../persistence/rows.js";
import { exactNow } from "../persistence/timestamps.js";
import type { AttemptScopeCheckResult } from "../persistence/workflow.js";
import type { AutomationCollaborator } from "./automation.js";
import { BoardPauseCollaborator } from "./board-pause.js";
import { claimTaskProjectionInputs } from "./claim-projection.js";
import {
  migrateInterfaceReadiness,
  migrateInterfaceProvider,
  migrateTaskCarriesCrossRepoContext,
  publishedInterfaceFailureLabel,
  publishedInterfaceReasonSummary,
} from "./decomposition-readiness.js";
import { PUBLISHED_INTERFACE_PATH, readPublishedInterface } from "./interface-context.js";
import { onboardingDeliverablesCheck } from "./onboarding-check.js";
import type { ProjectsCollaborator } from "./projects.js";
import type { Actor, TaskBoardRuntime } from "./runtime.js";

class MigrateInterfaceClaimError extends Error {
  constructor(
    readonly summary: string,
    readonly sha: string,
    readonly contextDigest: string | null,
    readonly reason: PublishedInterfaceFailureReason,
    readonly repoPath: string | null = null,
    options?: ErrorOptions
  ) {
    super(summary, options);
    this.name = "MigrateInterfaceClaimError";
  }
}
import type { TasksCollaborator } from "./tasks.js";
import { transitionWorkItemInTransaction } from "./work-item-transitions.js";

type SettlementEffects = Readonly<{
  workflowWakeAgentId: string | null;
  settledWorkflowNodes: readonly WorkNode[];
  attemptNodeSuspensionFailed: boolean;
}>;

export type SettlementActor = Actor | Readonly<{ type: "system"; id: string }>;

export interface SuspendAllActiveRunsResult {
  readonly suspended: number;
  readonly failed: number;
}

type SettleActiveRunOptions = Readonly<{
  suspendAttempt?: boolean;
  skipAttemptNodeSuspension?: boolean;
}>;

type AttemptSettlementPrecheck = Readonly<{
  scopeCheck: AttemptScopeCheckResult | null;
  result: string;
  onboarding: OnboardingSettlementContext | null;
  publicationFailure: ExpandInterfacePublicationFailure | null;
}>;

type OnboardingSettlementContext = Readonly<{
  workItemId: string;
  projectId: string;
  nodeId: string;
  taskId: string;
  gapReport: string;
}>;

const ONBOARDING_GAP_REPORT_CAPTION = "Onboarding gap report";
const PAUSED_CLAIM_RESULT = Object.freeze({ paused: true as const });
const CORRECTABLE_SETTLEMENT_ERROR_CODES = new Set<string>([
  "WORKFLOW_PLAN_REQUIRED",
  "WORKFLOW_INVALID",
  TASK_BOARD_ERROR_CODES.ONBOARDING_DELIVERABLES_MISSING,
]);

function onboardingMissingDetail(missing: readonly string[]): string {
  const boundedItems = missing.map((item) => redactForPersistence(item, 220));
  return redactForPersistence(`Onboarding deliverables are missing: ${boundedItems.join("; ")}`, 2_000);
}

function attemptSettlementResult(request: SettleRunRequest, scopeCheck: AttemptScopeCheckResult | null): string {
  if (request.outcome === "failed") {
    if (request.result.startsWith("BRIGHT_LINE:")) return request.result;
    if (request.handoff?.summary.startsWith("BRIGHT_LINE:") === true) return request.handoff.summary;
  }
  if (scopeCheck !== null && !scopeCheck.ok) {
    return "files" in scopeCheck ? scopeViolationResult(scopeCheck.files) : scopeCheck.error.slice(0, 2_000);
  }
  return request.result;
}

const TOKEN_ROTATION_INTERRUPT_REASON = "Agent token rotated by an operator.";

export class RunsCollaborator {
  readonly #git: GitRunner;

  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly automation: AutomationCollaborator,
    private readonly projects: ProjectsCollaborator,
    private readonly tasks: TasksCollaborator,
    git: GitRunner | GitTextRunner = defaultGitRunner,
    private readonly boardPause: BoardPauseCollaborator = new BoardPauseCollaborator(runtime)
  ) {
    this.#git = withGitBytes(git);
  }

  private scopeCheckForSettlement(
    taskId: string,
    outcome: SettleRunRequest["outcome"]
  ): AttemptScopeCheckResult | null {
    if (outcome !== "completed") return null;
    const row = this.runtime.store.db
      .prepare(
        `
      SELECT
        attempt.stage,
        project.repo_path,
        item.base_sha,
        item.pipeline_branch,
        plan.declared_scope_json
      FROM stage_attempts attempt
      JOIN work_nodes node ON node.node_id=attempt.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      JOIN projects project ON project.project_id=node.project_id
      WHERE attempt.task_id=?
    `
      )
      .get(taskId);
    if (row === undefined || row.stage !== "implementation") return null;
    if (row.pipeline_branch === null && row.base_sha === null) return null;
    if (
      typeof row.repo_path !== "string" ||
      typeof row.base_sha !== "string" ||
      typeof row.pipeline_branch !== "string" ||
      typeof row.declared_scope_json !== "string"
    )
      return Object.freeze({ ok: false, error: "scope check failed" });
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
        git: this.#git,
      });
    } catch {
      return Object.freeze({ ok: false, error: "scope check failed" });
    }
  }

  private onboardingCheckForSettlement(
    taskId: string,
    outcome: SettleRunRequest["outcome"],
    gapReport: string | undefined
  ): OnboardingSettlementContext | null {
    if (outcome !== "completed") return null;
    const row = this.runtime.store.db
      .prepare(
        `
      SELECT
        item.work_item_id,
        project.project_id,
        project.repo_path,
        item.pipeline_branch,
        node.node_id
      FROM stage_attempts attempt
      JOIN work_nodes node ON node.node_id=attempt.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      JOIN work_item_onboarding_tasks onboarding ON onboarding.work_item_id=item.work_item_id
      JOIN projects project ON project.project_id=node.project_id
      WHERE attempt.task_id=? AND attempt.stage='implementation'
    `
      )
      .get(taskId);
    if (row === undefined) return null;
    const repoPath = typeof row.repo_path === "string" ? row.repo_path : "";
    const branch = typeof row.pipeline_branch === "string" ? row.pipeline_branch : "";
    const check = onboardingDeliverablesCheck(repoPath, branch, gapReport, this.#git);
    if (!check.ok) {
      throw new TaskBoardError(
        400,
        TASK_BOARD_ERROR_CODES.ONBOARDING_DELIVERABLES_MISSING,
        onboardingMissingDetail(check.missing)
      );
    }
    if (
      typeof row.work_item_id !== "string" ||
      typeof row.project_id !== "string" ||
      typeof row.node_id !== "string" ||
      typeof gapReport !== "string"
    ) {
      throw new TaskBoardError(
        400,
        TASK_BOARD_ERROR_CODES.ONBOARDING_DELIVERABLES_MISSING,
        onboardingMissingDetail(["settlement linkage is invalid"])
      );
    }
    return Object.freeze({
      workItemId: row.work_item_id,
      projectId: row.project_id,
      nodeId: row.node_id,
      taskId,
      gapReport,
    });
  }

  private expandInterfacePublicationFailure(
    current: AgentRun,
    request: SettleRunRequest
  ): ExpandInterfacePublicationFailure | null {
    if (current.status !== "active" || current.taskId === null || request.outcome !== "completed") return null;
    const row = this.runtime.store.db
      .prepare(
        `
      SELECT project.repo_path,
        (
          SELECT verify.detail
          FROM verify_attempts verify
          WHERE verify.node_id=node.node_id AND verify.state='green'
          ORDER BY verify.attempt DESC,verify.created_at DESC,verify.verify_attempt_id DESC
          LIMIT 1
        ) AS verified_detail
      FROM stage_attempts attempt
      JOIN work_nodes node ON node.node_id=attempt.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      JOIN projects project ON project.project_id=item.resolved_project_id
      WHERE attempt.task_id=? AND attempt.stage='verification' AND item.phase='expand'
    `
      )
      .get(current.taskId) as
      | Readonly<{
          repo_path: string;
          verified_detail: string | null;
        }>
      | undefined;
    if (row === undefined) return null;
    const match = row.verified_detail === null ? null : /^verified-sha:([0-9a-f]{40})$/u.exec(row.verified_detail);
    if (match?.[1] === undefined) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:pipeline_verified_sha_missing");
    }
    const published = readPublishedInterface(row.repo_path, match[1], PUBLISHED_INTERFACE_PATH, this.#git);
    if (published.kind === "present") return null;
    if (published.reason === "read_error") {
      throw new TaskBoardError(
        409,
        TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_REPO_UNAVAILABLE,
        `Could not verify ${PUBLISHED_INTERFACE_PATH} at ${match[1]}`
      );
    }
    return Object.freeze({
      finding: `publish ${PUBLISHED_INTERFACE_PATH} (${publishedInterfaceFailureLabel(published)})`,
      actual: `${PUBLISHED_INTERFACE_PATH} at verified SHA ${match[1]} is ${publishedInterfaceFailureLabel(published)}`,
    });
  }

  private wasInterruptedBySystem(current: AgentRun): boolean {
    if (current.status !== "interrupted") return false;
    return (
      this.runtime.store.db
        .prepare(
          `
      SELECT 1
      FROM task_events
      WHERE event_type='agent_run_settled'
        AND actor_type='system'
        AND json_extract(data_json,'$.runId')=?
        AND json_extract(data_json,'$.outcome')='interrupted'
      LIMIT 1
    `
        )
        .get(current.runId) !== undefined
    );
  }

  private wasInterruptedBeforeWorkItemCancellation(current: AgentRun): boolean {
    if (current.taskId === null) return false;
    return (
      this.runtime.store.db
        .prepare(
          `
      WITH linked_work_item(work_item_id) AS (
        SELECT work_item_id
        FROM work_item_planning_tasks
        WHERE task_id=?
        UNION
        SELECT work_item_id
        FROM work_item_design_tasks
        WHERE task_id=?
        UNION
        SELECT plan.work_item_id
        FROM stage_attempts attempt
        JOIN work_nodes node ON node.node_id=attempt.node_id
        JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
        WHERE attempt.task_id=?
      )
      SELECT 1
      FROM linked_work_item link
      JOIN work_items item ON item.work_item_id=link.work_item_id
      JOIN interrupts interrupt
        ON interrupt.run_id=? AND interrupt.idempotency_key='suspend:' || ?
      WHERE item.state='abandoned'
        AND item.ended_at IS NOT NULL
        AND item.cancelled_reason IS NOT NULL
      LIMIT 1
    `
        )
        .get(current.taskId, current.taskId, current.taskId, current.runId, current.runId) !== undefined
    );
  }

  private wasSettledByAgent(current: AgentRun, agentId: string, outcome: SettleRunRequest["outcome"]): boolean {
    return (
      this.runtime.store.db
        .prepare(
          `
      SELECT 1
      FROM task_events
      WHERE event_type='agent_run_settled'
        AND actor_type='agent'
        AND actor_id=?
        AND json_extract(data_json,'$.runId')=?
        AND json_extract(data_json,'$.outcome')=?
      LIMIT 1
    `
        )
        .get(agentId, current.runId, outcome) !== undefined
    );
  }

  resumeAgent(
    agentId: string,
    request: ResumeAgentRequest,
    idempotencyKey: string
  ): { wakeup: Wakeup; duplicate: boolean } {
    const agent = this.runtime.requireAgent(agentId);
    let requestedTask: BoardTask | null = null;
    if (request.taskId !== null) {
      const task = this.runtime.requireTask(request.taskId);
      if (task.projectId !== agent.projectId)
        throw conflict("TASK_PROJECT_MISMATCH", "Resume task belongs to another project");
      if (isHardTerminalTaskStatus(task.status)) {
        throw conflict(TASK_BOARD_ERROR_CODES.TASK_TERMINAL, "Completed and cancelled tasks cannot be resumed");
      }
      if (task.kind === "human_check")
        throw conflict("HUMAN_CHECK_NOT_ASSIGNABLE", "Human checks cannot wake an agent");
      if (task.requiredRole !== null && task.requiredRole !== agent.role) {
        throw conflict("TASK_REQUIRED_ROLE_MISMATCH", `This task requires the ${task.requiredRole} role`);
      }
      requestedTask = task;
    }
    const sourceKey = `${agentId}:${idempotencyKey}`;
    const prior = this.runtime.store.db
      .prepare("SELECT * FROM wakeups WHERE reason IN ('human_resume', 'resumed') AND source_key = ?")
      .get(sourceKey);
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
        now
      );
      this.runtime.insertEvent(
        agent.projectId,
        request.taskId,
        { type: "human", id: this.runtime.config.humanPrincipal },
        "agent_resumed",
        {
          agentId,
          wakeupId,
        },
        now
      );
    });
    this.runtime.wakeupEvents.emit(agentId);
    return {
      wakeup: wakeupFromRow(this.runtime.store.db.prepare("SELECT * FROM wakeups WHERE wakeup_id = ?").get(wakeupId)!),
      duplicate: false,
    };
  }

  interruptAgent(
    agentId: string,
    request: InterruptAgentRequest,
    idempotencyKey: string
  ): { interrupt: AgentInterrupt; duplicate: boolean } {
    const agent = this.runtime.requireAgent(agentId);
    const hash = sha256({ action: "interrupt_agent", agentId, request });
    const prior = this.runtime.store.db
      .prepare("SELECT * FROM interrupts WHERE agent_id = ? AND idempotency_key = ?")
      .get(agentId, idempotencyKey);
    if (prior) {
      if (stringValue(prior, "request_hash") !== hash)
        throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key was used for another interrupt");
      return { interrupt: interruptFromRow(prior), duplicate: true };
    }
    const active = this.runtime.store.db
      .prepare("SELECT run_id FROM runs WHERE agent_id = ? AND status = 'active'")
      .get(agentId);
    const runId = active ? stringValue(active, "run_id") : null;
    const now = exactNow(this.runtime.config.now);
    let interrupt!: AgentInterrupt;
    this.runtime.store.transaction(() => {
      interrupt = this.insertInterruptInTransaction(
        agent.projectId,
        agentId,
        runId,
        idempotencyKey,
        hash,
        request.reason,
        now,
        { type: "human", id: this.runtime.config.humanPrincipal }
      );
    });
    if (runId !== null) this.runtime.interruptEvents.emit(runId);
    return { interrupt, duplicate: false };
  }

  interruptActiveRunForTokenRotationInTransaction(agentId: string, version: number): void {
    const agent = this.runtime.requireAgent(agentId);
    const active = this.runtime.store.db
      .prepare("SELECT * FROM runs WHERE agent_id = ? AND status = 'active'")
      .get(agentId);
    if (active === undefined) return;
    const current = runFromRow(active);
    const now = exactNow(this.runtime.config.now);
    const idempotencyKey = `token-rotation:${version}`;
    const reason = TOKEN_ROTATION_INTERRUPT_REASON;
    const hash = sha256({ action: "token_rotation_interrupt", agentId, version, reason });
    this.insertInterruptInTransaction(agent.projectId, agentId, current.runId, idempotencyKey, hash, reason, now, {
      type: "human",
      id: this.runtime.config.humanPrincipal,
    });
    const effects = this.settleActiveRunInTransaction(
      current,
      agentId,
      { outcome: "interrupted", result: reason },
      now,
      { type: "human", id: this.runtime.config.humanPrincipal }
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
    actor: SettlementActor
  ): AgentInterrupt {
    const interruptId = randomUUID();
    this.runtime.store.db
      .prepare(
        `
      INSERT INTO interrupts(
        interrupt_id, project_id, agent_id, run_id, idempotency_key, request_hash, reason, requested_by, requested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(interruptId, projectId, agentId, runId, idempotencyKey, hash, reason, actor.id, now);
    this.runtime.insertEvent(
      projectId,
      null,
      actor,
      "agent_interrupt_requested",
      {
        interruptId,
        agentId,
        runId,
        reason,
      },
      now
    );
    return interruptFromRow(
      this.runtime.store.db.prepare("SELECT * FROM interrupts WHERE interrupt_id = ?").get(interruptId)!
    );
  }

  async waitForRunInterrupts(
    runId: string,
    agentId: string,
    after: number,
    waitMs: number,
    signal: AbortSignal,
    credentialVersion?: number
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

  claimRun(agentId: string, request: ClaimRunRequest, credentialVersion?: number): ClaimRunResponse | null {
    this.requireCredentialVersion(agentId, credentialVersion);
    const prior = this.runtime.store.db
      .prepare("SELECT * FROM runs WHERE agent_id = ? AND claim_id = ?")
      .get(agentId, request.claimId);
    if (prior) {
      if (this.boardPause.isBoardPaused()) return PAUSED_CLAIM_RESULT;
      const priorRun = runFromRow(prior);
      const requestHash = claimRequestHash(agentId, request, priorRun.taskId);
      const storedHash = stringValue(prior, "claim_request_hash");
      const selectedCursor = claimMessageCursor(request, priorRun.taskId);
      if (
        storedHash !== requestHash &&
        storedHash !== legacyClaimRequestHash(agentId, request.claimId, selectedCursor)
      ) {
        throw conflict("CLAIM_ID_CONFLICT", "claimId was used with another cursor");
      }
      const persistedResult = nullableString(prior, "claim_result_json");
      if (persistedResult !== null) return this.claimResultFromJson(persistedResult);
      // Legacy runs created before claim-result persistence have NULL here; rebuild them while their source data remains valid.
      const reviewInspection = priorRun.taskId === null ? null : this.projects.prepareClaimContext(priorRun.taskId);
      const crossRepoContext =
        priorRun.taskId === null
          ? null
          : (() => {
              try {
                return this.prepareCrossRepoContext(priorRun.taskId);
              } catch (error) {
                if (error instanceof MigrateInterfaceClaimError) this.throwTypedMigrateInterfaceError(error);
                throw error;
              }
            })();
      return this.claimResult(priorRun, selectedCursor ?? 0, reviewInspection, crossRepoContext);
    }
    const existing = this.runtime.store.db
      .prepare("SELECT run_id FROM runs WHERE agent_id = ? AND status = 'active'")
      .get(agentId);
    if (existing) throw conflict("AGENT_RUN_ACTIVE", "Agent already has an active run");
    const candidate = this.runtime.store.transaction(() => {
      if (this.boardPause.isBoardPaused()) return null;
      this.requireCredentialVersion(agentId, credentialVersion);
      const activeInside = this.runtime.store.db
        .prepare("SELECT 1 FROM runs WHERE agent_id = ? AND status = 'active'")
        .get(agentId);
      if (activeInside) throw conflict("AGENT_RUN_ACTIVE", "Agent already has an active run");
      this.runtime.retireStaleWakeupsForAgent(agentId, exactNow(this.runtime.config.now));
      const wakeupRow = this.runtime.store.db
        .prepare(
          `
        SELECT wakeup.*
        FROM wakeups AS wakeup
        LEFT JOIN tasks AS ordered_task ON ordered_task.task_id = wakeup.task_id
        WHERE wakeup.agent_id = ?
          AND ${PENDING_LIVE_WAKEUP_PREDICATE_SQL}
        ORDER BY
          CASE WHEN ordered_task.task_id IS NULL THEN 1 ELSE 0 END,
          ordered_task.order_key,
          ordered_task.task_id,
          wakeup.created_at,
          wakeup.rowid
        LIMIT 1
      `
        )
        .get(agentId, RETIRED_WAKEUP_EVENT_PREFIX);
      return wakeupRow === undefined ? null : wakeupFromRow(wakeupRow);
    });
    if (candidate === null) return null;

    // Review Git inspection may spawn several bounded subprocesses. It must run
    // after candidate resolution and before the write transaction below.
    const reviewInspection = candidate.taskId === null ? null : this.projects.prepareClaimContext(candidate.taskId);
    let crossRepoContext: CrossRepoContext | null;
    try {
      crossRepoContext = candidate.taskId === null ? null : this.prepareCrossRepoContext(candidate.taskId);
    } catch (error) {
      if (error instanceof MigrateInterfaceClaimError && candidate.taskId !== null) {
        this.rejectMigrateInterfaceClaim(candidate.taskId, error);
      }
      throw error;
    }
    const now = exactNow(this.runtime.config.now);
    let reviewRuntimeConflict: TaskBoardError | null = null;
    let claimed: ClaimRunResponse | null;
    try {
      claimed = this.runtime.store.transaction(() => {
        if (this.boardPause.isBoardPaused()) return null;
        const currentAgent = this.requireCredentialVersion(agentId, credentialVersion);
        const activeInside = this.runtime.store.db
          .prepare("SELECT 1 FROM runs WHERE agent_id = ? AND status = 'active'")
          .get(agentId);
        if (activeInside) throw conflict("AGENT_RUN_ACTIVE", "Agent already has an active run");
        const wakeupRow = this.runtime.store.db
          .prepare(
            `
        SELECT wakeup.*
        FROM wakeups AS wakeup
        WHERE wakeup.wakeup_id = ?
          AND wakeup.agent_id = ?
          AND ${PENDING_LIVE_WAKEUP_PREDICATE_SQL}
      `
          )
          .get(candidate.wakeupId, agentId, RETIRED_WAKEUP_EVENT_PREFIX);
        if (wakeupRow === undefined) return null;
        const wakeup = wakeupFromRow(wakeupRow);
        if (wakeup.taskId !== null) {
          const conflictRow = this.runtime.store.db
            .prepare(
              `
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
        `
            )
            .get(wakeup.taskId);
          const reviewRuntime = request.pinned?.runtime ?? null;
          const reviewModel = request.pinned?.model ?? null;
          const implementationRuntime = conflictRow?.runtime ?? null;
          const implementationModel = conflictRow?.model ?? null;
          if (
            conflictRow !== undefined &&
            typeof reviewRuntime === "string" &&
            typeof reviewModel === "string" &&
            typeof implementationRuntime === "string" &&
            typeof implementationModel === "string" &&
            reviewRuntime === implementationRuntime &&
            reviewModel === implementationModel
          ) {
            const message = `review runtime matches implement runtime (${reviewRuntime}/${reviewModel}) — configure a different reviewer lane`;
            this.projects.recordReviewRuntimeConflictInTransaction(
              String(conflictRow.project_id),
              String(conflictRow.node_id),
              wakeup.taskId,
              message
            );
            reviewRuntimeConflict = new TaskBoardError(
              409,
              TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_RUNTIME_CONFLICT,
              message
            );
            return null;
          }
        }
        const requestHash = claimRequestHash(agentId, request, wakeup.taskId);
        const runId = randomUUID();
        this.runtime.store.db
          .prepare(
            `
        INSERT INTO runs(
          run_id, claim_id, claim_request_hash, project_id, agent_id, wakeup_id, task_id, status, started_at,
          heartbeat_at, ended_at, result, runtime, runtime_version, model, prompts_sha
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, NULL, ?, ?, ?, ?)
      `
          )
          .run(
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
            request.pinned?.promptsSha ?? null
          );
        const claim = this.runtime.store.db
          .prepare(
            `
        UPDATE wakeups SET claimed_at = ?, run_id = ? WHERE wakeup_id = ? AND claimed_at IS NULL
      `
          )
          .run(now, runId, wakeup.wakeupId);
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
            const started = this.runtime.store.db
              .prepare(
                `
            UPDATE tasks
            SET status = 'in_progress', started_at = COALESCE(started_at, ?), version = version + 1, updated_at = ?
            WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND status IN ('queued', 'blocked') AND ended_at IS NULL
          `
              )
              .run(now, now, task.taskId, agentId, task.version);
            if (Number(started.changes) !== 1)
              throw conflict("TASK_VERSION_CONFLICT", "Task changed while its run was starting");
            this.runtime.insertEvent(
              task.projectId,
              task.taskId,
              { type: "agent", id: agentId },
              "task_run_started",
              {
                kind: task.kind,
                requiredRole: task.requiredRole,
                runId,
                previousStatus: task.status,
                status: "in_progress",
                version: task.version + 1,
              },
              now
            );
          }
        }
        this.runtime.insertEvent(
          currentAgent.projectId,
          wakeup.taskId,
          { type: "agent", id: agentId },
          "agent_run_claimed",
          {
            runId,
            claimId: request.claimId,
            wakeupId: wakeup.wakeupId,
            wakeReason: wakeup.reason,
            messageCursor: claimMessageCursor(request, wakeup.taskId),
          },
          now
        );
        const result = this.claimResult(
          runFromRow(this.runtime.store.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId)!),
          claimMessageCursor(request, wakeup.taskId) ?? 0,
          reviewInspection,
          crossRepoContext
        );
        if (crossRepoContext !== null) {
          const projectedContext = projectClaimContext(result, claimMessageCursor(request, wakeup.taskId));
          try {
            if (projectedContext === null) throw new Error("TASK_BOARD_DATABASE_CORRUPT:migrate_taskless_claim");
            parseWorkerAgentContext(projectedContext);
          } catch (error) {
            const reason = publishedInterfaceValidationReason(error);
            if (reason === null || projectedContext === null) throw error;
            const usage = workerAgentContextUsage(projectedContext);
            const providerRow = this.runtime.store.db
              .prepare("SELECT repo_path FROM projects WHERE project_id=?")
              .get(crossRepoContext.providerProjectId) as Readonly<{ repo_path?: unknown }> | undefined;
            const providerRepoPath = typeof providerRow?.repo_path === "string" ? providerRow.repo_path : null;
            throw new MigrateInterfaceClaimError(
              publishedInterfaceReasonSummary(reason, crossRepoContext.sha, usage.bytes, usage.budget),
              crossRepoContext.sha,
              sha256(claimContextInputForDigest(projectedContext)),
              reason,
              providerRepoPath,
              { cause: error }
            );
          }
        }
        const persisted = this.runtime.store.db
          .prepare("UPDATE runs SET claim_result_json = ? WHERE run_id = ? AND claim_result_json IS NULL")
          .run(JSON.stringify(result), runId);
        if (Number(persisted.changes) !== 1) throw new Error("TASK_BOARD_DATABASE_CORRUPT:claim_result_json");
        return result;
      });
    } catch (error) {
      if (error instanceof MigrateInterfaceClaimError && candidate.taskId !== null) {
        this.rejectMigrateInterfaceClaim(candidate.taskId, error);
      }
      throw error;
    }
    if (reviewRuntimeConflict !== null) throw reviewRuntimeConflict;
    return claimed;
  }

  async waitToClaimRun(
    agentId: string,
    request: ClaimRunRequest,
    waitMs: number,
    signal: AbortSignal,
    credentialVersion?: number
  ): Promise<ClaimRunResponse | null> {
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
      const row = this.runtime.store.db
        .prepare("SELECT * FROM runs WHERE run_id = ? AND agent_id = ?")
        .get(runId, agentId);
      if (!row) throw new TaskBoardError(404, "RUN_NOT_FOUND", "Run was not found");
      const current = runFromRow(row);
      if (current.status !== "active") throw conflict("RUN_NOT_ACTIVE", "Run is already settled");
      const heartbeatAt = exactNow(this.runtime.config.now);
      const update = this.runtime.store.db
        .prepare(
          `
        UPDATE runs SET heartbeat_at = ? WHERE run_id = ? AND agent_id = ? AND status = 'active'
      `
        )
        .run(heartbeatAt, runId, agentId);
      if (Number(update.changes) !== 1) throw conflict("RUN_NOT_ACTIVE", "Run is already settled");
      return runFromRow(this.runtime.store.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId)!);
    });
  }

  reconcileStaleRuns(): number {
    const timeoutSeconds = this.runtime.config.heartbeatTimeoutSeconds;
    if (timeoutSeconds === 0) return 0;
    const runColumns = new Set(
      this.runtime.store.db
        .prepare("SELECT name FROM pragma_table_info('runs')")
        .all()
        .map((row) => stringValue(row, "name"))
    );
    if (!["run_id", "agent_id", "status", "started_at", "heartbeat_at"].every((column) => runColumns.has(column))) {
      return 0;
    }
    const sweepStartedAt = exactNow(this.runtime.config.now);
    const cutoff = new Date(Date.parse(sweepStartedAt) - timeoutSeconds * 1_000).toISOString();
    const candidates = this.runtime.store.db
      .prepare(
        `
      SELECT run_id
      FROM runs
      WHERE status = 'active' AND COALESCE(heartbeat_at, started_at) < ?
      ORDER BY run_id
    `
      )
      .all(cutoff)
      .map((row) => stringValue(row, "run_id"));
    let settledCount = 0;
    for (const runId of candidates) {
      const settlement = this.runtime.store.transaction(() => {
        const row = this.runtime.store.db
          .prepare(
            `
          SELECT *
          FROM runs
          WHERE run_id = ?
            AND status = 'active'
            AND COALESCE(heartbeat_at, started_at) < ?
        `
          )
          .get(runId, cutoff);
        if (row === undefined) return null;
        const current = runFromRow(row);
        const effects = this.settleActiveRunInTransaction(
          current,
          current.agentId,
          { outcome: "interrupted", result: "run heartbeat lost" },
          exactNow(this.runtime.config.now),
          { type: "system", id: "system:stale-run-sweep" }
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

  suspendActiveRunInTransaction(
    runId: string,
    reason: string,
    actor: SettlementActor,
    nowOverride?: string,
    options: Readonly<{ skipAttemptNodeSuspension?: boolean }> = {}
  ): {
    workItemId: string | null;
    projectId: string;
    attemptNodeSuspensionFailed: boolean;
  } | null {
    const row = this.runtime.store.db.prepare("SELECT * FROM runs WHERE run_id=? AND status='active'").get(runId);
    if (row === undefined) return null;
    const current = runFromRow(row);
    const persistedReason = redactForPersistence(reason);
    const now = nowOverride ?? exactNow(this.runtime.config.now);
    const workItem =
      current.taskId === null
        ? undefined
        : this.runtime.store.db
            .prepare(
              `
      SELECT plan.work_item_id
      FROM stage_attempts attempt
      JOIN work_nodes node ON node.node_id=attempt.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      WHERE attempt.task_id=?
    `
            )
            .get(current.taskId);
    const idempotencyKey = `suspend:${current.runId}`;
    const requestHash = sha256({ action: "suspend_run", runId: current.runId, reason: persistedReason, actor });
    const priorInterrupt = this.runtime.store.db
      .prepare("SELECT request_hash FROM interrupts WHERE agent_id=? AND idempotency_key=?")
      .get(current.agentId, idempotencyKey);
    if (priorInterrupt === undefined) {
      this.insertInterruptInTransaction(
        current.projectId,
        current.agentId,
        current.runId,
        idempotencyKey,
        requestHash,
        persistedReason,
        now,
        actor
      );
    } else if (stringValue(priorInterrupt, "request_hash") !== requestHash) {
      throw conflict("IDEMPOTENCY_CONFLICT", "Run suspension was retried with different input");
    }
    this.runtime.store.afterCommit(() => this.runtime.interruptEvents.emit(current.runId));
    const effects = this.settleActiveRunInTransaction(
      current,
      current.agentId,
      { outcome: "interrupted", result: reason },
      now,
      actor,
      undefined,
      {
        suspendAttempt: true,
        skipAttemptNodeSuspension: options.skipAttemptNodeSuspension,
      }
    );
    return Object.freeze({
      workItemId: workItem === undefined ? null : stringValue(workItem, "work_item_id"),
      projectId: current.projectId,
      attemptNodeSuspensionFailed: effects.attemptNodeSuspensionFailed,
    });
  }

  suspendAllActiveRuns(reason: string, actor: SettlementActor): SuspendAllActiveRunsResult {
    // Planning and design runs are deliberately excluded from the board pause: they
    // are short-lived, and Task 5's started_at cap sweep suspends them individually
    // before applying its own cap-specific park transition.
    const runIds = this.runtime.store.db
      .prepare(
        `
      SELECT run.run_id
      FROM runs run
      JOIN stage_attempts attempt ON attempt.task_id=run.task_id
      JOIN work_nodes node ON node.node_id=attempt.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      WHERE run.status='active' AND item.pipeline_branch IS NOT NULL
      ORDER BY run.started_at,run.run_id
    `
      )
      .all()
      .map((row) => stringValue(row, "run_id"));
    let suspended = 0;
    let failed = 0;
    for (const runId of runIds) {
      try {
        const result = this.runtime.store.transaction(() => this.suspendActiveRunInTransaction(runId, reason, actor));
        if (result?.attemptNodeSuspensionFailed === true) failed += 1;
        else if (result !== null) suspended += 1;
      } catch (error) {
        failed += 1;
        console.error(`[task-board] active-run suspension failed for run ${runId}`, error);
      }
    }
    return Object.freeze({ suspended, failed });
  }

  settleRun(runId: string, agentId: string, request: SettleRunRequest): { run: AgentRun; duplicate: boolean } {
    const row = this.runtime.store.db
      .prepare("SELECT * FROM runs WHERE run_id = ? AND agent_id = ?")
      .get(runId, agentId);
    if (!row) throw new TaskBoardError(404, "RUN_NOT_FOUND", "Run was not found");
    const current = runFromRow(row);
    const persistedResult = redactForPersistence(request.result);
    const interruptedBeforeCancellation =
      current.status !== "active" && this.wasInterruptedBeforeWorkItemCancellation(current);
    if (current.status !== "active" && !interruptedBeforeCancellation && this.wasInterruptedBySystem(current)) {
      return { run: current, duplicate: true };
    }
    const design = this.designSettlement(current.taskId, request);
    if (request.reviewFindings !== undefined) {
      const pipelineReview =
        current.taskId === null
          ? undefined
          : this.runtime.store.db
              .prepare(
                `
        SELECT 1
        FROM stage_attempts attempt
        JOIN work_nodes node ON node.node_id=attempt.node_id
        JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
        JOIN work_items item ON item.work_item_id=plan.work_item_id
        WHERE attempt.task_id=? AND attempt.stage='verification' AND item.pipeline_branch IS NOT NULL
      `
              )
              .get(current.taskId);
      if (pipelineReview === undefined) {
        throw new TaskBoardError(
          400,
          TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_FINDINGS_NOT_ALLOWED,
          "Review findings are only allowed for pipeline verification"
        );
      }
    }
    if (interruptedBeforeCancellation) {
      return this.absorbSettlementAfterWorkItemCancellation(current, agentId, request, persistedResult, design);
    }
    if (current.status !== "active") {
      if (current.status === request.outcome && current.result === persistedResult) {
        let repairedNodes: readonly WorkNode[] = Object.freeze([]);
        const taskId = current.taskId;
        const needsRepair = taskId !== null && this.projects.attemptNeedsSettlementRepair(taskId, current.runId);
        if (taskId !== null && needsRepair) {
          const scopeCheck = this.scopeCheckForSettlement(taskId, request.outcome);
          const onboarding = this.onboardingCheckForSettlement(taskId, request.outcome, request.gapReport);
          const settlementResult = redactForPersistence(attemptSettlementResult(request, scopeCheck));
          this.runtime.store.transaction(() => {
            if (this.projects.attemptNeedsSettlementRepair(taskId, current.runId)) {
              repairedNodes = this.projects.settleAttemptInTransaction(
                taskId,
                request.outcome,
                settlementResult,
                request.handoff,
                request.reviewFindings,
                scopeCheck
              );
              if (onboarding !== null && scopeCheck?.ok === true) {
                this.recordOnboardingGapReportInTransaction(onboarding, agentId);
              }
            }
          });
          this.projects.activateWorkflowNodes(repairedNodes);
          this.projects.reconcileWorkflowsBestEffort(current.projectId);
        }
        return { run: current, duplicate: true };
      }
      throw conflict("RUN_NOT_ACTIVE", "Run is already settled");
    }
    const publicationFailure = this.expandInterfacePublicationFailure(current, request);
    const scopeCheck = current.taskId === null ? null : this.scopeCheckForSettlement(current.taskId, request.outcome);
    let onboarding: OnboardingSettlementContext | null;
    try {
      onboarding =
        current.taskId === null
          ? null
          : this.onboardingCheckForSettlement(current.taskId, request.outcome, request.gapReport);
    } catch (error) {
      this.recordCorrectableSettlementRejectionBestEffort(current, agentId, error);
      throw error;
    }
    const attemptPrecheck = Object.freeze({
      scopeCheck,
      result: attemptSettlementResult(request, scopeCheck),
      onboarding,
      publicationFailure,
    });
    const now = exactNow(this.runtime.config.now);
    let effects: SettlementEffects;
    try {
      effects = this.runtime.store.transaction(() =>
        this.settleActiveRunInTransaction(
          current,
          agentId,
          request,
          now,
          { type: "agent", id: agentId },
          attemptPrecheck
        )
      );
    } catch (error) {
      this.recordCorrectableSettlementRejectionBestEffort(current, agentId, error);
      throw error;
    }
    if (effects.workflowWakeAgentId !== null) this.runtime.wakeupEvents.emit(effects.workflowWakeAgentId);
    this.projects.activateWorkflowNodes(effects.settledWorkflowNodes);
    this.projects.reconcileWorkflowsBestEffort(current.projectId);
    return {
      run: runFromRow(this.runtime.store.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId)!),
      duplicate: false,
    };
  }

  private absorbSettlementAfterWorkItemCancellation(
    current: AgentRun,
    agentId: string,
    request: SettleRunRequest,
    persistedResult: string,
    design: ReturnType<RunsCollaborator["designSettlement"]>
  ): { run: AgentRun; duplicate: boolean } {
    if (
      current.status === request.outcome &&
      current.result === persistedResult &&
      this.wasSettledByAgent(current, agentId, request.outcome)
    ) {
      return { run: current, duplicate: true };
    }
    if (current.status !== "interrupted") throw conflict("RUN_NOT_ACTIVE", "Run is already settled");

    const planning =
      current.taskId === null
        ? undefined
        : this.runtime.store.db
            .prepare(
              `
      SELECT item.*
      FROM work_item_planning_tasks link
      JOIN work_items item ON item.work_item_id=link.work_item_id
      WHERE link.task_id=?
    `
            )
            .get(current.taskId);
    if (planning !== undefined && request.outcome === "completed") {
      if (request.workflowPlan === undefined || request.workflowPlan === null) {
        throw new TaskBoardError(400, "WORKFLOW_PLAN_REQUIRED", "Planning tasks must return a workflow plan");
      }
      try {
        validateWorkflowPlanChildren(
          request.workflowPlan,
          planning.resolved_project_id === null ? undefined : String(planning.resolved_project_id),
          planning.parent_work_item_id === null ? null : String(planning.parent_work_item_id)
        );
      } catch (error) {
        if (error instanceof ContractValidationError) {
          throw new TaskBoardError(400, "WORKFLOW_INVALID", error.message, { cause: error });
        }
        throw error;
      }
      const pipelineNode = request.workflowPlan.nodes.length === 1 ? request.workflowPlan.nodes[0] : undefined;
      if (pipelineNode !== undefined && pipelineTemplateShape(pipelineNode.stageTemplate) === "v1") {
        throw new TaskBoardError(
          400,
          TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_PLAN_INCOMPLETE,
          'pipeline plans must end in a verification stage (template ["implementation","testing","verification"])'
        );
      }
    } else if (request.workflowPlan !== undefined && request.workflowPlan !== null) {
      throw new TaskBoardError(
        400,
        "WORKFLOW_PLAN_NOT_ALLOWED",
        "Only completed planning tasks can return a workflow plan"
      );
    }

    const now = exactNow(this.runtime.config.now);
    this.runtime.store.transaction(() => {
      const update = this.runtime.store.db
        .prepare(
          `
        UPDATE runs
        SET status=?,ended_at=?,result=?
        WHERE run_id=? AND agent_id=? AND status='interrupted'
      `
        )
        .run(request.outcome, now, persistedResult, current.runId, agentId);
      if (Number(update.changes) !== 1) throw conflict("RUN_NOT_ACTIVE", "Run is already settled");
      if (planning !== undefined) {
        this.runtime.insertEvent(
          current.projectId,
          current.taskId,
          { type: "agent", id: agentId },
          "work_item_plan_discarded",
          { workItemId: String(planning.work_item_id), runId: current.runId, reason: "work_item_ended" },
          now
        );
      }
      if (design.row !== undefined && design.record !== null) {
        this.runtime.insertEvent(
          current.projectId,
          current.taskId,
          { type: "agent", id: agentId },
          "work_item_design_discarded",
          { workItemId: String(design.row.work_item_id), runId: current.runId, reason: "work_item_ended" },
          now
        );
      }
      this.runtime.insertEvent(
        current.projectId,
        current.taskId,
        { type: "agent", id: agentId },
        "agent_run_settled",
        {
          runId: current.runId,
          outcome: request.outcome,
        },
        now
      );
    });
    return {
      run: runFromRow(this.runtime.store.db.prepare("SELECT * FROM runs WHERE run_id=?").get(current.runId)!),
      duplicate: false,
    };
  }

  private recordCorrectableSettlementRejection(current: AgentRun, agentId: string, error: unknown): void {
    if (
      current.status !== "active" ||
      !(error instanceof TaskBoardError) ||
      error.status !== 400 ||
      !CORRECTABLE_SETTLEMENT_ERROR_CODES.has(error.code)
    )
      return;
    const detail = redactForPersistence(error.message, 2_000);
    const now = exactNow(this.runtime.config.now);
    this.runtime.store.transaction(() => {
      const terminalMessages = this.runtime.store.db
        .prepare(
          `
        SELECT message_id
        FROM task_messages
        WHERE run_id=? AND actor_type='agent' AND actor_id=? AND client_event_id GLOB 'twe_*'
      `
        )
        .all(current.runId, agentId) as ReadonlyArray<Record<string, unknown>>;
      for (const row of terminalMessages) {
        const messageId = String(row.message_id);
        this.runtime.store.db
          .prepare(
            `
          DELETE FROM task_events
          WHERE event_type='task_message_appended' AND json_extract(data_json,'$.messageId')=?
        `
          )
          .run(messageId);
      }
      this.runtime.store.db
        .prepare(
          `
        DELETE FROM task_messages
        WHERE run_id=? AND actor_type='agent' AND actor_id=? AND client_event_id GLOB 'twe_*'
      `
        )
        .run(current.runId, agentId);
      this.runtime.insertEvent(
        current.projectId,
        current.taskId,
        { type: "agent", id: agentId },
        "settlement_rejected",
        { runId: current.runId, code: error.code, detail, retractedOutputCount: terminalMessages.length },
        now
      );
    });
  }

  private recordCorrectableSettlementRejectionBestEffort(current: AgentRun, agentId: string, error: unknown): void {
    try {
      this.recordCorrectableSettlementRejection(current, agentId, error);
    } catch (recordingError) {
      try {
        console.error(`[task-board] settlement rejection recording failed for run ${current.runId}`, recordingError);
      } catch {
        // The original typed settlement error remains authoritative even if logging also fails.
      }
    }
  }

  private settleActiveRunInTransaction(
    current: AgentRun,
    agentId: string,
    request: SettleRunRequest,
    now: string,
    actor: SettlementActor,
    attemptPrecheck?: AttemptSettlementPrecheck,
    options: SettleActiveRunOptions = {}
  ): SettlementEffects {
    let workflowWakeAgentId: string | null = null;
    let settledWorkflowNodes: readonly WorkNode[] = Object.freeze([]);
    let attemptNodeSuspensionFailed = false;
    const persistedResult = redactForPersistence(request.result);
    const attemptResult = redactForPersistence(attemptPrecheck?.result ?? request.result);
    // Keep this planning snapshot: its work-item state is reused after task and workflow settlement below.
    const planning =
      current.taskId === null
        ? undefined
        : this.runtime.store.db
            .prepare(
              `
      SELECT w.* FROM work_item_planning_tasks link
      JOIN work_items w ON w.work_item_id=link.work_item_id
      WHERE link.task_id=?
    `
            )
            .get(current.taskId);
    const design = this.designSettlement(current.taskId, request);
    let workflowProposal: CreatePlanRevisionRequest | null = null;
    if (planning && request.outcome === "completed") {
      if (request.workflowPlan === undefined || request.workflowPlan === null) {
        throw new TaskBoardError(400, "WORKFLOW_PLAN_REQUIRED", "Planning tasks must return a workflow plan");
      }
      try {
        validateWorkflowPlanChildren(
          request.workflowPlan,
          planning.resolved_project_id === null ? undefined : String(planning.resolved_project_id),
          planning.parent_work_item_id === null ? null : String(planning.parent_work_item_id)
        );
      } catch (error) {
        if (error instanceof ContractValidationError) {
          throw new TaskBoardError(400, "WORKFLOW_INVALID", error.message, { cause: error });
        }
        throw error;
      }
      const pipelineNode = request.workflowPlan.nodes.length === 1 ? request.workflowPlan.nodes[0] : undefined;
      const pipelineShape = pipelineNode === undefined ? null : pipelineTemplateShape(pipelineNode.stageTemplate);
      if (pipelineShape === "v1") {
        throw new TaskBoardError(
          400,
          TASK_BOARD_ERROR_CODES.TASK_BOARD_PIPELINE_PLAN_INCOMPLETE,
          'pipeline plans must end in a verification stage (template ["implementation","testing","verification"])'
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
          now
        );
      } else {
        const existingPlan = this.runtime.store.db
          .prepare("SELECT 1 FROM plan_revisions WHERE work_item_id=? AND state IN ('proposed','confirmed')")
          .get(workItemId);
        if (!existingPlan) {
          const configured = this.automation.getConfiguration();
          const requiredStages = new Set(request.workflowPlan.nodes.flatMap((node) => node.stageTemplate));
          for (const stage of requiredStages) {
            const executor = configured.stages.find((configuredStage) => configuredStage.stage === stage)?.executor;
            if (executor?.kind === "machine_verify") continue;
            const agentType =
              executor?.kind === "agent_type"
                ? configured.agentTypes.find(
                    (candidate) => candidate.agentTypeId === executor.agentTypeId && candidate.enabled
                  )
                : undefined;
            if (agentType === undefined) {
              throw new TaskBoardError(
                409,
                "WORKFLOW_EXECUTOR_UNAVAILABLE",
                `No enabled executor is configured for ${stage}`
              );
            }
          }
          const executorTypeIds = new Set(
            configured.stages.flatMap((stage) =>
              requiredStages.has(stage.stage as WorkflowStage) && stage.executor.kind === "agent_type"
                ? [stage.executor.agentTypeId]
                : []
            )
          );
          const skillIds = [
            ...new Set(
              configured.agentTypes.flatMap((agentType) =>
                agentType.enabled && executorTypeIds.has(agentType.agentTypeId) ? agentType.skillIds : []
              )
            ),
          ];
          workflowProposal = {
            ...request.workflowPlan,
            workItemId,
            projectId: planning.resolved_project_id === null ? current.projectId : String(planning.resolved_project_id),
            skillIds,
          };
        }
      }
    } else if (request.workflowPlan !== undefined && request.workflowPlan !== null) {
      throw new TaskBoardError(
        400,
        "WORKFLOW_PLAN_NOT_ALLOWED",
        "Only completed planning tasks can return a workflow plan"
      );
    }
    if (current.taskId !== null && design.row !== undefined && design.record !== null) {
      const workItemId = String(design.row.work_item_id);
      if (isTerminalWorkItemState(String(design.row.state) as WorkItemState)) {
        this.runtime.insertEvent(
          current.projectId,
          current.taskId,
          actor,
          "work_item_design_discarded",
          { workItemId, runId: current.runId, reason: "work_item_ended" },
          now
        );
      } else {
        settledWorkflowNodes = this.projects.settleDesignInTransaction(
          current.taskId,
          persistedResult,
          design.record,
          agentId
        );
      }
    } else if (current.taskId !== null && options.suspendAttempt === true) {
      if (options.skipAttemptNodeSuspension !== true) {
        attemptNodeSuspensionFailed = !this.projects.suspendAttemptNodeInTransaction(current.taskId, attemptResult);
      }
    } else if (current.taskId !== null) {
      settledWorkflowNodes = this.projects.settleAttemptInTransaction(
        current.taskId,
        request.outcome,
        attemptResult,
        request.handoff,
        request.reviewFindings,
        attemptPrecheck?.scopeCheck ?? null
      );
      if (attemptPrecheck?.publicationFailure !== null && attemptPrecheck?.publicationFailure !== undefined) {
        settledWorkflowNodes = this.projects.recordExpandInterfacePublicationFailureInTransaction(
          current.taskId,
          attemptPrecheck.publicationFailure
        );
      }
    }
    if (workflowProposal !== null) {
      this.projects.proposeWorkflowForAgentInTransaction(workflowProposal, agentId);
    }
    const update = this.runtime.store.db
      .prepare(
        `
      UPDATE runs SET status = ?, ended_at = ?, result = ? WHERE run_id = ? AND agent_id = ? AND status = 'active'
    `
      )
      .run(request.outcome, now, persistedResult, current.runId, agentId);
    if (Number(update.changes) !== 1) throw conflict("RUN_NOT_ACTIVE", "Run is already settled");
    if (current.taskId !== null) {
      const taskRow = this.runtime.store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(current.taskId);
      if (!taskRow) throw new Error("TASK_BOARD_DATABASE_CORRUPT:run_task");
      const task = this.runtime.requireTask(current.taskId);
      if (task.assignedAgentId === agentId && task.endedAt === null) {
        const nextStatus: TaskStatus = request.outcome;
        if (task.status !== nextStatus || request.outcome === "completed") {
          const lifecycle =
            request.outcome === "completed"
              ? this.runtime.store.db
                  .prepare(
                    `
                UPDATE tasks
                SET status = 'completed', ended_at = ?, result = ?, version = version + 1, updated_at = ?
                WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND ended_at IS NULL
              `
                  )
                  .run(now, attemptResult, now, task.taskId, agentId, task.version)
              : this.runtime.store.db
                  .prepare(
                    `
                UPDATE tasks
                SET status = ?, ended_at = ?, result = ?, version = version + 1, updated_at = ?
                WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND ended_at IS NULL
              `
                  )
                  .run(request.outcome, now, attemptResult, now, task.taskId, agentId, task.version);
          if (Number(lifecycle.changes) !== 1)
            throw conflict("TASK_VERSION_CONFLICT", "Task changed while its run was settling");
          this.runtime.insertEvent(
            task.projectId,
            task.taskId,
            actor,
            "task_run_settled",
            {
              kind: task.kind,
              requiredRole: task.requiredRole,
              runId: current.runId,
              outcome: request.outcome,
              previousStatus: task.status,
              status: nextStatus,
              version: task.version + 1,
            },
            now
          );
          if (options.suspendAttempt === true) {
            this.runtime.reconcileTaskPhasesForTerminal(task, "interrupted", actor, now);
          } else if (request.outcome === "completed") {
            if (actor.type === "system") throw new Error("TASK_BOARD_SYSTEM_RUN_COMPLETION_INVALID");
            this.runtime.reconcileTaskPhasesForTerminal(task, "completed", actor, now);
            workflowWakeAgentId = this.runtime.createReviewFollowup(task, now)?.wakeAgentId ?? null;
          }
          this.runtime.retirePendingWakeupsForTask(
            task.taskId,
            request.outcome === "completed" ? "task_terminal" : "task_recovery_required",
            now
          );
        }
      }
    }
    if (planning && request.outcome !== "completed" && options.suspendAttempt !== true) {
      const workItemId = String(planning.work_item_id);
      if (isTerminalWorkItemState(String(planning.state) as WorkItemState)) {
        this.runtime.insertEvent(
          current.projectId,
          current.taskId,
          actor,
          "work_item_plan_discarded",
          { workItemId, runId: current.runId, reason: "work_item_ended" },
          now
        );
      } else {
        transitionWorkItemInTransaction(this.runtime.store, {
          workItemId,
          to: "parked",
          actorType: actor.type,
          actorId: actor.id,
          now,
          currentStage: "planning",
          park: {
            category: "planning_run_failed",
            reason: attemptResult.length > 0 ? attemptResult : "planning run failed",
          },
        });
      }
    }
    if (design.row !== undefined && request.outcome !== "completed" && options.suspendAttempt !== true) {
      const workItemId = String(design.row.work_item_id);
      if (!isTerminalWorkItemState(String(design.row.state) as WorkItemState)) {
        transitionWorkItemInTransaction(this.runtime.store, {
          workItemId,
          to: "parked",
          actorType: actor.type,
          actorId: actor.id,
          now,
          currentStage: "planning",
          park: {
            category: "design_run_failed",
            reason: attemptResult.length > 0 ? attemptResult : "design run failed",
          },
        });
      }
    }
    this.runtime.insertEvent(
      current.projectId,
      current.taskId,
      actor,
      "agent_run_settled",
      {
        runId: current.runId,
        outcome: request.outcome,
      },
      now
    );
    if (
      attemptPrecheck?.onboarding !== null &&
      attemptPrecheck?.onboarding !== undefined &&
      attemptPrecheck.scopeCheck?.ok === true
    ) {
      this.recordOnboardingGapReportInTransaction(attemptPrecheck.onboarding, agentId);
    }
    return Object.freeze({ workflowWakeAgentId, settledWorkflowNodes, attemptNodeSuspensionFailed });
  }

  private recordOnboardingGapReportInTransaction(onboarding: OnboardingSettlementContext, agentId: string): void {
    const link = this.runtime.store.db
      .prepare(
        `
      SELECT onboarding.gap_report_artifact_id, artifact.task_id AS gap_report_task_id
      FROM work_item_onboarding_tasks onboarding
      LEFT JOIN artifacts artifact ON artifact.artifact_id=onboarding.gap_report_artifact_id
      WHERE work_item_id=?
    `
      )
      .get(onboarding.workItemId);
    if (link === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:onboarding_gap_report_link");
    if (link.gap_report_artifact_id !== null && link.gap_report_task_id === onboarding.taskId) return;
    const artifact = this.projects.recordOnboardingGapReportInTransaction({
      projectId: onboarding.projectId,
      nodeId: onboarding.nodeId,
      taskId: onboarding.taskId,
      content: redactMultilineForPersistence(onboarding.gapReport),
      caption: ONBOARDING_GAP_REPORT_CAPTION,
      actorId: agentId,
    });
    const update = this.runtime.store.db
      .prepare(
        `
      UPDATE work_item_onboarding_tasks
      SET gap_report_artifact_id=?
      WHERE work_item_id=? AND gap_report_artifact_id IS ?
    `
      )
      .run(artifact.artifactId, onboarding.workItemId, link.gap_report_artifact_id);
    if (Number(update.changes) !== 1) throw new Error("TASK_BOARD_DATABASE_CORRUPT:onboarding_gap_report_identity");
  }

  private designSettlement(
    taskId: string | null,
    request: SettleRunRequest
  ): Readonly<{ row: Record<string, unknown> | undefined; record: DesignRecordDraft | null }> {
    const row =
      taskId === null
        ? undefined
        : this.runtime.store.db
            .prepare(
              `
      SELECT item.*
      FROM work_item_design_tasks link
      JOIN work_items item ON item.work_item_id=link.work_item_id
      WHERE link.task_id=?
    `
            )
            .get(taskId);
    if (row === undefined) {
      if (request.designRecord !== undefined) {
        throw new TaskBoardError(
          400,
          TASK_BOARD_ERROR_CODES.TASK_BOARD_DESIGN_RECORD_NOT_ALLOWED,
          "Design records are only allowed for design tasks"
        );
      }
      return Object.freeze({ row: undefined, record: null });
    }
    if (request.outcome !== "completed") {
      if (request.designRecord !== undefined) {
        throw new TaskBoardError(
          400,
          TASK_BOARD_ERROR_CODES.TASK_BOARD_DESIGN_RECORD_NOT_ALLOWED,
          "Only completed design tasks can return a design record"
        );
      }
      return Object.freeze({ row, record: null });
    }
    if (request.designRecord === undefined) {
      throw new TaskBoardError(
        400,
        TASK_BOARD_ERROR_CODES.TASK_BOARD_DESIGN_RECORD_REQUIRED,
        "Completed design tasks must return a design record"
      );
    }
    try {
      return Object.freeze({ row, record: parseDesignRecordDraft(request.designRecord) });
    } catch (error) {
      if (error instanceof ContractValidationError) {
        throw new TaskBoardError(400, TASK_BOARD_ERROR_CODES.TASK_BOARD_DESIGN_RECORD_REQUIRED, error.message, {
          cause: error,
        });
      }
      throw error;
    }
  }

  private claimResult(
    run: AgentRun,
    cursor: number,
    reviewInspection: ReturnType<ProjectsCollaborator["prepareClaimContext"]>,
    crossRepoContext: CrossRepoContext | null
  ): ClaimRunResult {
    const wakeup = wakeupFromRow(
      this.runtime.store.db.prepare("SELECT * FROM wakeups WHERE wakeup_id = ?").get(run.wakeupId)!
    );
    const taskProjection =
      wakeup.taskId === null ? null : claimTaskProjectionInputs(this.runtime, wakeup.taskId, cursor);
    const task = taskProjection?.task ?? null;
    const messages = taskProjection?.messages ?? Object.freeze([]);
    const messageCursor = taskProjection?.messageCursor ?? cursor;
    const triggerQuestion =
      wakeup.questionId === null
        ? null
        : questionFromRow(
            this.runtime.store.db.prepare("SELECT * FROM questions WHERE question_id = ?").get(wakeup.questionId)!
          );
    const parentTask = task?.parentTaskId ? this.runtime.requireTask(task.parentTaskId) : null;
    const parentMessages =
      parentTask === null
        ? []
        : this.runtime.store.db
            .prepare(
              `
      SELECT * FROM (
        SELECT * FROM task_messages WHERE task_id = ? ORDER BY sequence DESC LIMIT 12
      ) ORDER BY sequence
    `
            )
            .all(parentTask.taskId)
            .map(messageFromRow);
    const workflow = task === null ? null : this.projects.claimContext(task.taskId, reviewInspection);
    const phase = task === null ? null : this.claimWorkItemPhase(task.taskId);
    const areaMemory =
      workflow?.pipeline !== null && workflow?.pipeline !== undefined
        ? []
        : this.runtime.store.db
            .prepare(
              `
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
      `
            )
            .all(run.projectId, run.agentId, run.taskId, run.taskId)
            .map((row) =>
              Object.freeze({
                taskId: stringValue(row, "task_id"),
                title: stringValue(row, "title"),
                result: stringValue(row, "result"),
                endedAt: stringValue(row, "ended_at"),
              })
            );
    const project = this.runtime.requireProject(run.projectId);
    const intake = taskProjection?.intake ?? false;
    return Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      run,
      wakeup,
      task,
      context: Object.freeze({
        intake,
        ...(intake ? { boardProjects: this.boardProjectContexts(run.projectId) } : {}),
        ...(task !== null &&
        this.runtime.store.db
          .prepare(
            `
          SELECT 1
          FROM work_item_onboarding_tasks onboarding
          WHERE onboarding.task_id = ?
             OR onboarding.work_item_id = (
               SELECT plan.work_item_id
               FROM stage_attempts attempt
               JOIN work_nodes node ON node.node_id=attempt.node_id
               JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
               WHERE attempt.task_id=?
             )
          LIMIT 1
        `
          )
          .get(task.taskId, task.taskId) !== undefined
          ? { onboarding: true as const }
          : {}),
        design:
          task !== null &&
          this.runtime.store.db.prepare("SELECT 1 FROM work_item_design_tasks WHERE task_id = ?").get(task.taskId) !==
            undefined,
        agent: this.runtime.requireAgent(run.agentId),
        projectMemory: Object.freeze({
          projectId: project.projectId,
          name: project.name,
          description: project.description,
        }),
        areaMemory: Object.freeze(areaMemory),
        parentTask,
        parentMessages: Object.freeze(parentMessages),
        acceptanceCriteria: task?.acceptanceCriteria ?? null,
        workspaceRefs: task?.workspaceRefs ?? Object.freeze([]),
        phase,
        ...(crossRepoContext === null ? {} : { crossRepoContext }),
        messageCursor,
        messages: Object.freeze(messages),
        triggerQuestion,
        openQuestions: Object.freeze(
          this.runtime.store.db
            .prepare(
              `
          SELECT * FROM questions WHERE agent_id = ? AND status = 'open' ORDER BY asked_at, question_id LIMIT 50
        `
            )
            .all(run.agentId)
            .map(questionFromRow)
        ),
        workflow,
      }),
    });
  }

  private boardProjectContexts(parentProjectId: string): NonNullable<ClaimRunResult["context"]["boardProjects"]> {
    return Object.freeze(
      (
        this.runtime.store.db
          .prepare(
            `
      SELECT project_id,name,repo_path
      FROM projects
      ORDER BY CASE WHEN project_id=? THEN 0 ELSE 1 END,created_at,project_id
      LIMIT 64
    `
          )
          .all(parentProjectId) as Row[]
      ).map((row) =>
        Object.freeze({
          projectId: stringValue(row, "project_id"),
          name: stringValue(row, "name"),
          repoName: basename(stringValue(row, "repo_path")),
        })
      )
    );
  }

  private claimWorkItemPhase(taskId: string): WorkItemPhase | null {
    const row = this.runtime.store.db
      .prepare(
        `
      SELECT item.phase
      FROM stage_attempts attempt
      JOIN work_nodes node ON node.node_id=attempt.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      WHERE attempt.task_id=?
      ORDER BY attempt.attempt DESC
      LIMIT 1
    `
      )
      .get(taskId) as Readonly<{ phase: string | null }> | undefined;
    if (row === undefined || row.phase === null) return null;
    if (!(WORK_ITEM_PHASES as readonly string[]).includes(row.phase)) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:work_item_phase");
    }
    return row.phase as WorkItemPhase;
  }

  private prepareCrossRepoContext(taskId: string): CrossRepoContext | null {
    const owner = this.runtime.store.db
      .prepare(
        `
      SELECT item.work_item_id,item.phase,attempt.stage,task.assigned_role
      FROM stage_attempts attempt
      JOIN tasks task ON task.task_id=attempt.task_id
      JOIN work_nodes node ON node.node_id=attempt.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      WHERE attempt.task_id=?
      ORDER BY attempt.attempt DESC
      LIMIT 1
    `
      )
      .get(taskId) as
      | Readonly<{
          work_item_id: string;
          phase: string | null;
          stage: string;
          assigned_role: string | null;
        }>
      | undefined;
    if (
      owner === undefined ||
      owner.phase !== "migrate" ||
      !migrateTaskCarriesCrossRepoContext(owner.stage, owner.assigned_role)
    )
      return null;
    const provider = migrateInterfaceProvider(this.runtime.store.db, owner.work_item_id);
    if (provider === null) throw new Error("TASK_BOARD_DATABASE_CORRUPT:migrate_provider_merge_missing");
    const readiness = migrateInterfaceReadiness(this.runtime.store.db, owner.work_item_id, (repoPath, sha, path) =>
      readPublishedInterface(repoPath, sha, path, this.#git)
    );
    if (readiness === null) throw new Error("TASK_BOARD_DATABASE_CORRUPT:migrate_provider_merge_missing");
    if (readiness.kind === "blocked") {
      throw new MigrateInterfaceClaimError(readiness.summary, readiness.sha, null, readiness.reason, provider.repoPath);
    }
    return readiness.context;
  }

  private rejectMigrateInterfaceClaim(taskId: string, error: MigrateInterfaceClaimError): never {
    if (error.repoPath !== null) {
      this.projects.evictPublishedInterface(error.repoPath, error.sha);
    }
    this.projects.blockMigrateInterfaceClaim(
      taskId,
      error.summary,
      error.contextDigest === null
        ? null
        : {
            expandSha: error.sha,
            contextDigest: error.contextDigest,
          }
    );
    this.throwTypedMigrateInterfaceError(error);
  }

  private throwTypedMigrateInterfaceError(error: MigrateInterfaceClaimError): never {
    throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.TASK_BOARD_PUBLISHED_INTERFACE_UNAVAILABLE, error.summary, {
      cause: error,
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
    if (envelope.apiVersion !== TASK_BOARD_API_VERSION)
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:claim_result_json");
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
        context.intake =
          currentRun?.taskId !== null &&
          currentRun?.taskId !== undefined &&
          this.runtime.store.db
            .prepare("SELECT 1 FROM work_item_planning_tasks WHERE task_id = ?")
            .get(currentRun.taskId) !== undefined;
      }
      if (context.intake === true && !Object.hasOwn(context, "boardProjects") && currentRun !== null) {
        context.boardProjects = this.boardProjectContexts(currentRun.projectId);
      }
      if (!Object.hasOwn(context, "design")) context.design = false;
      if (!Object.hasOwn(context, "phase")) {
        context.phase =
          currentRun?.taskId === null || currentRun?.taskId === undefined
            ? null
            : this.claimWorkItemPhase(currentRun.taskId);
      }
      if (context.workflow !== null && typeof context.workflow === "object" && !Array.isArray(context.workflow)) {
        const workflow = context.workflow as Record<string, unknown>;
        if (!Object.hasOwn(workflow, "workspaceKey")) workflow.workspaceKey = null;
        if (!Object.hasOwn(workflow, "pipeline")) workflow.pipeline = null;
        if (workflow.pipeline !== null && typeof workflow.pipeline === "object" && !Array.isArray(workflow.pipeline)) {
          const pipeline = workflow.pipeline as Record<string, unknown>;
          if (!Object.hasOwn(pipeline, "designRecord")) pipeline.designRecord = null;
        }
        if (!Object.hasOwn(workflow, "review")) workflow.review = null;
      }
    }
    return result as ClaimRunResult;
  }

  private interruptBatch(runId: string, after: number): RunInterruptBatch {
    const items = this.runtime.store.db
      .prepare(
        `
      SELECT * FROM interrupts WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT 100
    `
      )
      .all(runId, after)
      .map(interruptFromRow);
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
