/** Runs durable machine-verification attempts across SQL state, child processes, and isolated workspaces. */

/* —— Imports —— */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defaultGitRunner, GIT_POLICY_FLAGS, type GitTextRunner } from "../../shared/git.js";
import type { VerifyRunnerOptions, VerifyRunStatus } from "#server/agents/verify";
import { VerifyRunner } from "#server/agents/verify";
import { TaskWorkspaceManager, removeRecordedTaskWorkspace } from "#server/agents/task-workspace";
import type { PlanCriterionCheck, VerifyAttempt, WorkNode, WorkflowStage } from "#shared/task-board-contract";
import { GIT_OBJECT_ID_PATTERN, VERIFY_WORKSPACE_SUFFIX } from "#shared/task-board-contract";
import { redactForPersistence } from "../../shared/redact.js";
import { WORK_ITEM_REPOSITORY_PATH_SQL } from "../persistence/repository-path.js";
import { exactNow } from "../persistence/timestamps.js";
import type { MachineVerifyEvidence } from "../persistence/workflow.js";
import type { TaskBoardRuntime } from "./board-runtime.js";
import { BoardPauseCollaborator } from "./board-pause.js";

/* —— Process bounds and retirement signals —— */

const CHECK_TIMEOUT_MS = 120_000;
const CHECK_MAX_BYTES = 1024 * 1024;
const TAIL_BYTES = 4_096;
const START_FAILURE_MARKER = /\[machine-verify-start-failures:(\d+)\]/u;
export const DEFAULT_SUPERVISOR_PATH = fileURLToPath(new URL("../../agents/verify/step-runner.js", import.meta.url));

type Row = Record<string, unknown>;
type OpenAttemptState = "starting" | "running" | "failed_to_start";
type VerifyAttemptRetirement = Readonly<{
  verifyAttemptId: string;
  previousState: OpenAttemptState;
}>;
type VerifyAttemptRetirementListener = (retirement: VerifyAttemptRetirement) => void;

const retirementListeners = new WeakMap<TaskBoardRuntime, Set<VerifyAttemptRetirementListener>>();

function registerRetirementListener(runtime: TaskBoardRuntime, listener: VerifyAttemptRetirementListener): () => void {
  const listeners = retirementListeners.get(runtime) ?? new Set<VerifyAttemptRetirementListener>();
  listeners.add(listener);
  retirementListeners.set(runtime, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) retirementListeners.delete(runtime);
  };
}

export function retireOpenVerifyAttemptsForWorkItemInTransaction(
  runtime: TaskBoardRuntime,
  workItemId: string,
  reason: string,
  now: string
): number {
  if (!runtime.store.hasOpenTransaction) {
    throw new Error("TASK_BOARD_VERIFY_ATTEMPT_RETIREMENT_TRANSACTION_REQUIRED");
  }
  const detail = redactForPersistence(`Retired after work item cancellation: ${reason}`, 4_000);
  const attempts = runtime.store.db
    .prepare(
      `
    SELECT verify.verify_attempt_id, verify.state
    FROM verify_attempts verify
    JOIN work_nodes node ON node.node_id=verify.node_id
    JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
    WHERE verify.state IN ('starting','running','failed_to_start')
      AND plan.work_item_id=?
    ORDER BY verify.created_at, verify.verify_attempt_id
  `
    )
    .all(workItemId) as Array<{ verify_attempt_id: string; state: OpenAttemptState }>;
  const retired = runtime.store.db
    .prepare(
      `
    UPDATE verify_attempts
    SET state='retired',detail=?,ended_at=?
    WHERE state IN ('starting','running','failed_to_start')
      AND node_id IN (
        SELECT node.node_id
        FROM work_nodes node
        JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
        WHERE plan.work_item_id=?
      )
  `
    )
    .run(detail, now, workItemId);
  if (Number(retired.changes) > 0 && attempts.length > 0) {
    const retirements = attempts.map((attempt) =>
      Object.freeze({
        verifyAttemptId: String(attempt.verify_attempt_id),
        previousState: String(attempt.state) as OpenAttemptState,
      })
    );
    // Process and workspace cleanup starts only after retirement is durable.
    runtime.store.afterCommit(() => {
      for (const listener of retirementListeners.get(runtime) ?? []) {
        for (const retirement of retirements) listener(retirement);
      }
    });
  }
  return Number(retired.changes);
}

/* —— External lifecycle contracts —— */

export interface MachineVerifyRunner {
  startFull(): Promise<string>;
  terminate(id: string): Promise<void>;
  status(id: string): Promise<VerifyRunStatus>;
  tail(id: string, bytes: number): Promise<string>;
}

export interface MachineVerifyWorkspaceManager {
  create(key: string, baseRef?: string, branchKey?: string): Promise<string>;
  remove(key: string): Promise<void>;
  removeRecordedPath?(path: string): Promise<void>;
  retain(key: string): Promise<void>;
}

interface CriterionCheckExecution {
  readonly passed: boolean;
  readonly detail: string;
}

export interface VerifyAttemptsDependencies {
  readonly supervisorPath?: string;
  readonly workspaceManagerFactory?: (repositoryPath: string) => MachineVerifyWorkspaceManager;
  readonly runnerFactory?: (options: VerifyRunnerOptions) => MachineVerifyRunner;
  readonly executeCheck?: (command: string, cwd: string, signal: AbortSignal) => Promise<CriterionCheckExecution>;
  readonly git?: GitTextRunner;
  readonly settleInTransaction: (
    nodeId: string,
    stage: WorkflowStage,
    passed: boolean,
    evidence: MachineVerifyEvidence
  ) => readonly WorkNode[];
  readonly activateNodes: (nodes: readonly WorkNode[]) => void;
  readonly reconcileProject: (projectId: string) => void;
}

interface AttemptContext {
  readonly verifyAttemptId: string;
  readonly nodeId: string;
  readonly stage: WorkflowStage;
  readonly attempt: number;
  readonly verifyRunId: string | null;
  readonly workspacePath: string | null;
  readonly state: VerifyAttempt["state"];
  readonly detail: string | null;
  readonly workItemId: string;
  readonly projectId: string;
  readonly repositoryPath: string;
  readonly baseSha: string | null;
  readonly criterionChecks: readonly PlanCriterionCheck[];
}

interface CheckOutcome {
  readonly results: readonly { readonly criterion: string; readonly check: string; readonly passed: boolean }[];
  readonly failures: readonly string[];
  readonly failureDetailsByIndex: readonly (string | null)[];
}

type StartingVerifyAttemptResult =
  | Readonly<{ kind: "created"; verifyAttemptId: string }>
  | Readonly<{ kind: "ineligible" }>
  | Readonly<{ kind: "pipeline_required" }>;

/* —— Command execution and row projections —— */

function errorDetail(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return redactForPersistence(value, 4_000);
}

function redactedCheckOutcome(checks: CheckOutcome): CheckOutcome {
  return Object.freeze({
    results: Object.freeze(
      checks.results.map((result) =>
        Object.freeze({
          criterion: redactForPersistence(result.criterion),
          check: redactForPersistence(result.check),
          passed: result.passed,
        })
      )
    ),
    failures: Object.freeze(checks.failures.map((failure) => redactForPersistence(failure))),
    failureDetailsByIndex: Object.freeze(
      checks.failureDetailsByIndex.map((failure) => (failure === null ? null : redactForPersistence(failure)))
    ),
  });
}

function startFailureCount(detail: string | null): number {
  const parsed = detail === null ? undefined : START_FAILURE_MARKER.exec(detail)?.[1];
  const value = parsed === undefined ? 0 : Number(parsed);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function commandArgv(command: string): readonly string[] {
  const argv: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current.length > 0) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (escaped || quote !== null) throw new Error("criterion check contains an unterminated quote or escape");
  if (current.length > 0) argv.push(current);
  if (argv.length === 0) throw new Error("criterion check is empty");
  return Object.freeze(argv);
}

function executeCriterionCheck(command: string, cwd: string, signal: AbortSignal): Promise<CriterionCheckExecution> {
  let argv: readonly string[];
  try {
    argv = commandArgv(command);
  } catch (error) {
    return Promise.resolve({ passed: false, detail: errorDetail(error) });
  }
  const [program, ...args] = argv;
  if (program === undefined) return Promise.resolve({ passed: false, detail: "criterion check is empty" });
  return new Promise((resolve) => {
    // Criterion checks come from plans; direct argv execution forbids shell expansion and command chaining.
    execFile(
      program,
      args,
      {
        cwd,
        encoding: "utf8",
        timeout: CHECK_TIMEOUT_MS,
        maxBuffer: CHECK_MAX_BYTES,
        windowsHide: true,
        shell: false,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        signal,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ passed: true, detail: "exit 0" });
          return;
        }
        const output = `${stderr}${stdout}`.trim();
        resolve({
          passed: false,
          detail: redactForPersistence(output.length > 0 ? output : error.message, 2_000),
        });
      }
    );
  });
}

function attemptContext(row: Row): AttemptContext {
  return Object.freeze({
    verifyAttemptId: String(row.verify_attempt_id),
    nodeId: String(row.node_id),
    stage: String(row.stage) as WorkflowStage,
    attempt: Number(row.attempt),
    verifyRunId: row.verify_run_id === null ? null : String(row.verify_run_id),
    workspacePath: row.workspace_path === null ? null : String(row.workspace_path),
    state: String(row.state) as VerifyAttempt["state"],
    detail: row.detail === null ? null : String(row.detail),
    workItemId: String(row.work_item_id),
    projectId: String(row.project_id),
    repositoryPath: String(row.repository_path),
    baseSha: row.base_sha === null ? null : String(row.base_sha),
    criterionChecks: Object.freeze(JSON.parse(String(row.criterion_checks_json ?? "[]")) as PlanCriterionCheck[]),
  });
}

function verifyAttempt(row: Row): VerifyAttempt {
  return Object.freeze({
    verifyAttemptId: String(row.verify_attempt_id),
    nodeId: String(row.node_id),
    stage: String(row.stage) as WorkflowStage,
    attempt: Number(row.attempt),
    verifyRunId: row.verify_run_id === null ? null : String(row.verify_run_id),
    workspacePath: row.workspace_path === null ? null : String(row.workspace_path),
    state: String(row.state) as VerifyAttempt["state"],
    checkResults:
      row.check_results_json === null
        ? null
        : Object.freeze(JSON.parse(String(row.check_results_json)) as NonNullable<VerifyAttempt["checkResults"]>),
    detail: row.detail === null ? null : String(row.detail),
    createdAt: String(row.created_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
  });
}

/* —— Verify-attempt lifecycle —— */

export class VerifyAttemptsCollaborator {
  readonly #supervisorPath: string;
  readonly #workspaceManagerFactory: (repositoryPath: string) => MachineVerifyWorkspaceManager;
  readonly #runnerFactory: (options: VerifyRunnerOptions) => MachineVerifyRunner;
  readonly #executeCheck: (command: string, cwd: string, signal: AbortSignal) => Promise<CriterionCheckExecution>;
  readonly #git: GitTextRunner;
  readonly #boardPause: BoardPauseCollaborator;
  readonly #inFlightStarts = new Set<string>();
  readonly #startAbortControllers = new Map<string, AbortController>();
  readonly #criterionAbortControllers = new Map<string, AbortController>();
  readonly #retirementOperations = new Set<Promise<void>>();
  readonly #terminationClaims = new Set<string>();
  readonly #workspaceCleanupClaims = new Set<string>();
  readonly #unregisterRetirementListener: () => void;
  #sweepInFlight: Promise<number> | null = null;
  #closed = false;

  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly dependencies: VerifyAttemptsDependencies
  ) {
    this.#supervisorPath = dependencies.supervisorPath ?? DEFAULT_SUPERVISOR_PATH;
    this.#workspaceManagerFactory =
      dependencies.workspaceManagerFactory ??
      ((repositoryPath) =>
        new TaskWorkspaceManager({
          workspaceRoot: runtime.config.verifyWorkspaceRoot,
          repositoryPath,
        }));
    this.#runnerFactory = dependencies.runnerFactory ?? ((options) => new VerifyRunner(options));
    this.#executeCheck = dependencies.executeCheck ?? executeCriterionCheck;
    this.#git = dependencies.git ?? defaultGitRunner;
    this.#boardPause = new BoardPauseCollaborator(runtime);
    this.#unregisterRetirementListener = registerRetirementListener(runtime, (retirement) => {
      if (this.#closed) return;
      const controller = this.#startAbortControllers.get(retirement.verifyAttemptId);
      controller?.abort();
      this.#criterionAbortControllers.get(retirement.verifyAttemptId)?.abort();
      if (controller === undefined) this.#trackRetirement(this.#retireAttemptResources(retirement.verifyAttemptId));
    });
  }

  listForWorkItem(workItemId: string): readonly VerifyAttempt[] {
    return Object.freeze(
      (
        this.runtime.store.db
          .prepare(
            `
      SELECT verify.*
      FROM verify_attempts verify
      JOIN work_nodes node ON node.node_id=verify.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      WHERE plan.work_item_id=? AND plan.state='confirmed'
      ORDER BY verify.created_at,verify.verify_attempt_id
    `
          )
          .all(workItemId) as Row[]
      ).map(verifyAttempt)
    );
  }

  createStartingAttemptInTransaction(nodeId: string, stage: WorkflowStage): StartingVerifyAttemptResult {
    const row = this.runtime.store.db
      .prepare(
        `
      SELECT node.project_id, node.title, node.state, node.current_stage, item.pipeline_branch
      FROM work_nodes node
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      WHERE node.node_id=?
    `
      )
      .get(nodeId) as Row | undefined;
    if (row === undefined || row.current_stage !== stage || (row.state !== "ready" && row.state !== "blocked"))
      return Object.freeze({ kind: "ineligible" });
    if (row.pipeline_branch === null) return Object.freeze({ kind: "pipeline_required" });
    const attempt = Number(
      this.runtime.store.db
        .prepare(
          `
      SELECT COALESCE(MAX(prior.attempt), 0) + 1 AS next_attempt
      FROM (
        SELECT attempt FROM verify_attempts WHERE node_id=? AND stage=?
        UNION ALL
        SELECT attempt FROM stage_attempts WHERE node_id=? AND stage=?
      ) prior
    `
        )
        .get(nodeId, stage, nodeId, stage)?.next_attempt
    );
    const verifyAttemptId = `verify_${randomUUID()}`;
    const now = exactNow(this.runtime.config.now);
    this.runtime.store.db
      .prepare(
        `
      INSERT INTO verify_attempts(
        verify_attempt_id, node_id, stage, attempt, verify_run_id, workspace_path,
        state, check_results_json, detail, created_at, ended_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, 'starting', NULL, NULL, ?, NULL)
    `
      )
      .run(verifyAttemptId, nodeId, stage, attempt, now);
    const updated = this.runtime.store.db
      .prepare(
        `
      UPDATE work_nodes
      SET state='active',version=version+1,updated_at=?
      WHERE node_id=? AND current_stage=? AND state IN ('ready','blocked')
    `
      )
      .run(now, nodeId, stage);
    if (Number(updated.changes) !== 1) throw new Error("TASK_BOARD_MACHINE_VERIFY_ACTIVATION_CONFLICT");
    return Object.freeze({ kind: "created", verifyAttemptId });
  }

  startAfterCommit(verifyAttemptId: string): void {
    if (this.#closed) return;
    void this.#start(verifyAttemptId).catch((error: unknown) => {
      if (this.#closed) return;
      console.error(`[task-board] machine verify start failed for ${verifyAttemptId}`, error);
    });
  }

  sweep(): Promise<number> {
    if (this.#closed) return Promise.resolve(0);
    if (this.#sweepInFlight !== null) return this.#sweepInFlight;
    const sweep = this.#sweepAndDrainRetirements();
    this.#sweepInFlight = sweep;
    void sweep
      .finally(() => {
        if (this.#sweepInFlight === sweep) this.#sweepInFlight = null;
      })
      .catch(() => undefined);
    return sweep;
  }

  close(): void {
    this.#closed = true;
    for (const controller of this.#criterionAbortControllers.values()) controller.abort();
    this.#unregisterRetirementListener();
  }

  async #sweepAndDrainRetirements(): Promise<number> {
    await this.#drainRetirements();
    if (this.#closed) return 0;
    const processed = (await this.#sweepRetiredAttempts()) + (await this.#sweepOpenAttempts());
    await this.#drainRetirements();
    return processed;
  }

  #trackRetirement(operation: Promise<void>): void {
    this.#retirementOperations.add(operation);
    void operation.finally(() => this.#retirementOperations.delete(operation)).catch(() => undefined);
  }

  async #drainRetirements(): Promise<void> {
    while (this.#retirementOperations.size > 0) {
      await Promise.all([...this.#retirementOperations]);
    }
  }

  async #retireAttemptResources(verifyAttemptId: string): Promise<void> {
    if (this.#closed) return;
    const current = this.#context(verifyAttemptId);
    if (current === undefined || current.state !== "retired") return;
    let terminated = current.verifyRunId === null;
    if (current.verifyRunId !== null) {
      try {
        const runner = this.#runnerFactory({
          repoRoot: current.workspacePath ?? current.repositoryPath,
          supervisorPath: this.#supervisorPath,
        });
        terminated = await this.#terminateBestEffort(current.verifyAttemptId, runner, current.verifyRunId);
      } catch (error) {
        console.error(
          `[task-board] could not prepare termination for retired verify attempt ${verifyAttemptId}`,
          error
        );
      }
    }
    let workspaceRemoved = current.workspacePath === null;
    if (current.workspacePath !== null) {
      try {
        const workspace = this.#workspaceManagerFactory(current.repositoryPath);
        workspaceRemoved = await this.#removeAttemptWorkspaceBestEffort(
          current.verifyAttemptId,
          workspace,
          current.workItemId,
          current.workspacePath
        );
      } catch (error) {
        console.error(`[task-board] could not prepare retired verify workspace cleanup for ${verifyAttemptId}`, error);
        try {
          await removeRecordedTaskWorkspace(this.runtime.config.verifyWorkspaceRoot, current.workspacePath);
          workspaceRemoved = true;
        } catch (cleanupError) {
          console.error(
            `[task-board] could not remove recorded verify workspace for ${current.workItemId}`,
            cleanupError
          );
        }
      }
    }
    if (this.#closed) return;
    this.runtime.store.db
      .prepare(
        `
      UPDATE verify_attempts
      SET verify_run_id=CASE WHEN ?=1 THEN NULL ELSE verify_run_id END,
        workspace_path=CASE WHEN ?=1 THEN NULL ELSE workspace_path END
      WHERE verify_attempt_id=? AND state='retired'
    `
      )
      .run(terminated ? 1 : 0, workspaceRemoved ? 1 : 0, verifyAttemptId);
  }

  async #sweepRetiredAttempts(): Promise<number> {
    if (this.#closed) return 0;
    const attemptIds = (
      this.runtime.store.db
        .prepare(
          `
      SELECT verify_attempt_id
      FROM verify_attempts
      WHERE state='retired' AND (verify_run_id IS NOT NULL OR workspace_path IS NOT NULL)
      ORDER BY created_at,verify_attempt_id
    `
        )
        .all() as Row[]
    ).map((row) => String(row.verify_attempt_id));
    let processed = 0;
    for (const verifyAttemptId of attemptIds) {
      if (this.#closed) break;
      await this.#retireAttemptResources(verifyAttemptId);
      processed += 1;
    }
    return processed;
  }

  async #sweepOpenAttempts(): Promise<number> {
    if (this.#closed) return 0;
    const attemptIds = (
      this.runtime.store.db
        .prepare(
          `
      SELECT verify_attempt_id
      FROM verify_attempts
      WHERE state IN ('starting','running','failed_to_start')
      ORDER BY created_at, verify_attempt_id
    `
        )
        .all() as Row[]
    ).map((row) => String(row.verify_attempt_id));
    let processed = 0;
    for (const verifyAttemptId of attemptIds) {
      if (this.#closed) break;
      const current = this.#context(verifyAttemptId);
      if (current === undefined) continue;
      if (current.state === "starting" || current.state === "failed_to_start") {
        if (await this.#start(verifyAttemptId)) processed += 1;
      } else if (current.state === "running") {
        if (await this.#poll(current)) processed += 1;
      }
    }
    return processed;
  }

  #context(verifyAttemptId: string): AttemptContext | undefined {
    const row = this.runtime.store.db
      .prepare(
        `
      SELECT
        verify.*,
        plan.work_item_id,
        plan.criterion_checks_json,
        work_item.base_sha,
        node.project_id,
        ${WORK_ITEM_REPOSITORY_PATH_SQL} AS repository_path
      FROM verify_attempts verify
      JOIN work_nodes node ON node.node_id=verify.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items work_item ON work_item.work_item_id=plan.work_item_id
      WHERE verify.verify_attempt_id=?
    `
      )
      .get(verifyAttemptId) as Row | undefined;
    return row === undefined ? undefined : attemptContext(row);
  }

  async #start(verifyAttemptId: string): Promise<boolean> {
    if (this.#closed) return false;
    if (this.#boardPause.isBoardPaused()) return false;
    if (this.#inFlightStarts.has(verifyAttemptId)) return false;
    this.#inFlightStarts.add(verifyAttemptId);
    const abortController = new AbortController();
    this.#startAbortControllers.set(verifyAttemptId, abortController);
    let current: AttemptContext | undefined;
    let workspacePath: string | null = null;
    let workspace: MachineVerifyWorkspaceManager | null = null;
    try {
      current = this.#context(verifyAttemptId);
      if (current === undefined || (current.state !== "starting" && current.state !== "failed_to_start")) {
        return false;
      }
      workspace = this.#workspaceManagerFactory(current.repositoryPath);
      workspacePath = await workspace.create(
        `${current.workItemId}${VERIFY_WORKSPACE_SUFFIX}`,
        current.baseSha ?? undefined,
        current.workItemId
      );
      // Retirement can commit while workspace or process setup awaits, so durable state is checked on both sides of spawn.
      const beforeSpawn = this.#context(verifyAttemptId);
      if (
        abortController.signal.aborted ||
        beforeSpawn === undefined ||
        (beforeSpawn.state !== "starting" && beforeSpawn.state !== "failed_to_start")
      ) {
        if (beforeSpawn?.state === "retired") {
          await this.#removeAttemptWorkspaceBestEffort(verifyAttemptId, workspace, current.workItemId);
        } else {
          await this.#removeBestEffort(workspace, current.workItemId);
        }
        return false;
      }
      if (this.#closed) {
        await this.#removeBestEffort(workspace, current.workItemId);
        return false;
      }
      const runner = this.#runnerFactory({ repoRoot: workspacePath, supervisorPath: this.#supervisorPath });
      if (this.#boardPause.isBoardPaused()) {
        await this.#removeBestEffort(workspace, current.workItemId);
        return false;
      }
      const verifyRunId = await runner.startFull();
      const afterSpawn = this.#context(verifyAttemptId);
      if (
        this.#closed ||
        abortController.signal.aborted ||
        afterSpawn === undefined ||
        (afterSpawn.state !== "starting" && afterSpawn.state !== "failed_to_start")
      ) {
        await this.#terminateBestEffort(verifyAttemptId, runner, verifyRunId);
        if (afterSpawn?.state === "retired") {
          await this.#removeAttemptWorkspaceBestEffort(verifyAttemptId, workspace, current.workItemId);
        } else {
          await this.#removeBestEffort(workspace, current.workItemId);
        }
        return false;
      }
      let started = false;
      this.runtime.store.transaction(() => {
        const update = this.runtime.store.db
          .prepare(
            `
          UPDATE verify_attempts
          SET state='running',verify_run_id=?,workspace_path=?,detail=NULL
          WHERE verify_attempt_id=? AND state IN ('starting','failed_to_start')
        `
          )
          .run(verifyRunId, workspacePath, verifyAttemptId);
        started = Number(update.changes) === 1;
      });
      if (!started) {
        const latest = this.#context(verifyAttemptId);
        await this.#terminateBestEffort(verifyAttemptId, runner, verifyRunId);
        if (latest?.state === "retired") {
          await this.#removeAttemptWorkspaceBestEffort(verifyAttemptId, workspace, current.workItemId);
        } else {
          await this.#removeBestEffort(workspace, current.workItemId);
        }
        return false;
      }
      return true;
    } catch (error) {
      if (this.#closed) {
        if (workspace !== null && current !== undefined) {
          await this.#removeBestEffort(workspace, current.workItemId);
        }
        return false;
      }
      current = this.#context(verifyAttemptId);
      if (current === undefined || (current.state !== "starting" && current.state !== "failed_to_start")) {
        if (current?.state === "retired" && workspace !== null) {
          await this.#removeAttemptWorkspaceBestEffort(verifyAttemptId, workspace, current.workItemId);
        }
        return false;
      }
      const failedAttempt = current;
      const failures = startFailureCount(current.detail) + 1;
      const safeError = errorDetail(error);
      const detail = redactForPersistence(`[machine-verify-start-failures:${failures}] ${safeError}`, 4_000);
      let settledNodes: readonly WorkNode[] = [];
      this.runtime.store.transaction(() => {
        if (failures < 2) {
          this.runtime.store.db
            .prepare(
              `
            UPDATE verify_attempts
            SET state='failed_to_start',workspace_path=?,detail=?
            WHERE verify_attempt_id=? AND state IN ('starting','failed_to_start')
          `
            )
            .run(workspacePath, detail, verifyAttemptId);
          return;
        }
        const now = exactNow(this.runtime.config.now);
        this.runtime.store.db
          .prepare(
            `
          UPDATE verify_attempts
          SET state='failed',workspace_path=?,detail=?,ended_at=?
          WHERE verify_attempt_id=? AND state IN ('starting','failed_to_start')
        `
          )
          .run(workspacePath, detail, now, verifyAttemptId);
        settledNodes = this.dependencies.settleInTransaction(
          failedAttempt.nodeId,
          failedAttempt.stage,
          false,
          Object.freeze({
            summary: `Machine verify failed to start after two attempts: ${safeError}`,
            evidence: Object.freeze([detail]),
            acceptanceCriteria: Object.freeze([]),
            blockers: Object.freeze([safeError]),
          })
        );
      });
      if (failures >= 2) {
        this.dependencies.activateNodes(settledNodes);
        this.dependencies.reconcileProject(failedAttempt.projectId);
        if (workspace !== null) await this.#retainBestEffort(workspace, current.workItemId);
      }
      return true;
    } finally {
      this.#inFlightStarts.delete(verifyAttemptId);
      if (this.#startAbortControllers.get(verifyAttemptId) === abortController) {
        this.#startAbortControllers.delete(verifyAttemptId);
      }
    }
  }

  async #poll(current: AttemptContext): Promise<boolean> {
    if (current.verifyRunId === null || current.workspacePath === null) {
      await this.#finalizeFailure(current, "died", "Machine verify lost its durable run identity.");
      return true;
    }
    const runner = this.#runnerFactory({
      repoRoot: current.workspacePath,
      supervisorPath: this.#supervisorPath,
    });
    let status: VerifyRunStatus;
    try {
      status = await runner.status(current.verifyRunId);
    } catch (error) {
      if (this.#closed) return false;
      const statusDetail = `Machine verify status failed: ${errorDetail(error)}`;
      let detail: string;
      try {
        const tail = await runner.tail(current.verifyRunId, TAIL_BYTES);
        detail = tail.length === 0 ? statusDetail : `${statusDetail}\n${tail}`;
      } catch (tailError) {
        detail = `${statusDetail}; verify log tail failed: ${errorDetail(tailError)}`;
      }
      if (this.#closed) return false;
      await this.#finalizeFailure(current, "died", detail);
      return true;
    }
    if (this.#closed) return false;
    if (status.state === "running") return false;
    if (status.state === "failed" || status.state === "died") {
      let tail: string;
      try {
        tail = await runner.tail(current.verifyRunId, TAIL_BYTES);
      } catch (error) {
        tail = `Could not read verify log tail: ${errorDetail(error)}`;
      }
      if (this.#closed) return false;
      await this.#finalizeFailure(current, status.state, tail);
      return true;
    }

    const checks = await this.#runChecks(current);
    if (this.#closed) return false;
    if (this.#context(current.verifyAttemptId)?.state !== "running") return true;
    if (checks.failures.length > 0) {
      const detail = redactForPersistence(
        `Machine verify criterion checks failed: ${checks.failures.join("; ")}`,
        4_000
      );
      await this.#finalize(current, "failed", checks, detail, false);
    } else {
      let verifiedSha: string;
      try {
        if (current.workspacePath === null) throw new Error("verify workspace path is unavailable");
        verifiedSha = this.#git([...GIT_POLICY_FLAGS, "-C", current.workspacePath, "rev-parse", "HEAD"]).trim();
        if (!GIT_OBJECT_ID_PATTERN.test(verifiedSha) || verifiedSha.length !== 40) {
          throw new Error("git returned an invalid verified object id");
        }
      } catch (error) {
        await this.#finalizeFailure(
          current,
          "died",
          `Machine verify could not record the verified branch tip: ${errorDetail(error)}`
        );
        return true;
      }
      await this.#finalize(
        current,
        "green",
        checks,
        "Machine verify and criterion checks passed.",
        true,
        `verified-sha:${verifiedSha}`
      );
    }
    return true;
  }

  async #runChecks(current: AttemptContext): Promise<CheckOutcome> {
    if (current.workspacePath === null) {
      return Object.freeze({
        results: Object.freeze([]),
        failures: Object.freeze([]),
        failureDetailsByIndex: Object.freeze([]),
      });
    }
    const results: Array<{ criterion: string; check: string; passed: boolean }> = [];
    const failures: string[] = [];
    const failureDetailsByIndex: Array<string | null> = [];
    const controller = new AbortController();
    this.#criterionAbortControllers.set(current.verifyAttemptId, controller);
    try {
      for (const check of current.criterionChecks) {
        if (this.#closed || controller.signal.aborted) break;
        let execution: CriterionCheckExecution;
        try {
          execution = await this.#executeCheck(check.check, current.workspacePath, controller.signal);
        } catch (error) {
          execution = { passed: false, detail: errorDetail(error) };
        }
        if (controller.signal.aborted || this.#context(current.verifyAttemptId)?.state !== "running") break;
        const criterion = redactForPersistence(check.criterion);
        const command = redactForPersistence(check.check);
        const detail = redactForPersistence(execution.detail, 2_000);
        results.push({ criterion, check: command, passed: execution.passed });
        const failure = execution.passed ? null : `${criterion}: ${detail}`;
        failureDetailsByIndex.push(failure);
        if (failure !== null) failures.push(failure);
      }
    } finally {
      if (this.#criterionAbortControllers.get(current.verifyAttemptId) === controller) {
        this.#criterionAbortControllers.delete(current.verifyAttemptId);
      }
    }
    return Object.freeze({
      results: Object.freeze(results),
      failures: Object.freeze(failures),
      failureDetailsByIndex: Object.freeze(failureDetailsByIndex),
    });
  }

  async #finalizeFailure(current: AttemptContext, state: "failed" | "died", detail: string): Promise<void> {
    await this.#finalize(
      current,
      state,
      Object.freeze({
        results: Object.freeze([]),
        failures: Object.freeze([detail]),
        failureDetailsByIndex: Object.freeze([]),
      }),
      detail,
      false
    );
  }

  async #finalize(
    current: AttemptContext,
    state: "green" | "failed" | "died",
    checks: CheckOutcome,
    detail: string,
    passed: boolean,
    storedDetail = detail
  ): Promise<void> {
    if (this.#closed) return;
    const safeChecks = redactedCheckOutcome(checks);
    const safeDetail = redactForPersistence(detail, 4_000);
    const safeStoredDetail = redactForPersistence(storedDetail, 4_000);
    let settledNodes: readonly WorkNode[] = [];
    let settled = false;
    // Settle the workflow in the same transaction as the terminal attempt state.
    this.runtime.store.transaction(() => {
      const update = this.runtime.store.db
        .prepare(
          `
        UPDATE verify_attempts
        SET state=?,check_results_json=?,detail=?,ended_at=?
        WHERE verify_attempt_id=? AND state='running'
      `
        )
        .run(
          state,
          JSON.stringify(safeChecks.results),
          safeStoredDetail,
          exactNow(this.runtime.config.now),
          current.verifyAttemptId
        );
      if (Number(update.changes) !== 1) return;
      const criterionResults = current.criterionChecks.map((criterion, index) => {
        const safeCriterion = redactForPersistence(criterion.criterion);
        const safeCheck = redactForPersistence(criterion.check);
        return Object.freeze({
          criterion: safeCriterion,
          passed: safeChecks.results[index]?.passed ?? false,
          evidence:
            safeChecks.results[index]?.passed === true
              ? `Passed: ${safeCheck}`
              : (safeChecks.failureDetailsByIndex[index] ?? `Failed: ${safeCheck}`),
        });
      });
      settledNodes = this.dependencies.settleInTransaction(
        current.nodeId,
        current.stage,
        passed,
        Object.freeze({
          summary: safeDetail,
          evidence: Object.freeze([safeDetail]),
          acceptanceCriteria: Object.freeze(criterionResults),
          blockers: Object.freeze(passed ? [] : [...safeChecks.failures]),
        })
      );
      settled = true;
    });
    if (!settled) {
      const latest = this.#context(current.verifyAttemptId);
      if (latest?.state === "retired") {
        await this.#retireAttemptResources(current.verifyAttemptId);
      }
      return;
    }
    this.dependencies.activateNodes(settledNodes);
    this.dependencies.reconcileProject(current.projectId);
    const workspace = this.#workspaceManagerFactory(current.repositoryPath);
    // Failed workspaces are retained as diagnostic evidence; green workspaces are disposable.
    if (passed) {
      await this.#removeAttemptWorkspaceBestEffort(current.verifyAttemptId, workspace, current.workItemId);
    } else await this.#retainBestEffort(workspace, current.workItemId);
  }

  async #terminateBestEffort(
    verifyAttemptId: string,
    runner: MachineVerifyRunner,
    verifyRunId: string
  ): Promise<boolean> {
    if (this.#terminationClaims.has(verifyAttemptId)) return false;
    this.#terminationClaims.add(verifyAttemptId);
    try {
      await runner.terminate(verifyRunId);
      return true;
    } catch (error) {
      console.error(`[task-board] could not terminate retired verify attempt ${verifyAttemptId}`, error);
      return false;
    } finally {
      this.#terminationClaims.delete(verifyAttemptId);
    }
  }

  async #removeAttemptWorkspaceBestEffort(
    verifyAttemptId: string,
    workspace: MachineVerifyWorkspaceManager,
    workItemId: string,
    recordedPath?: string
  ): Promise<boolean> {
    if (this.#workspaceCleanupClaims.has(verifyAttemptId)) return false;
    this.#workspaceCleanupClaims.add(verifyAttemptId);
    try {
      if (recordedPath !== undefined && workspace.removeRecordedPath !== undefined) {
        try {
          await workspace.removeRecordedPath(recordedPath);
          return true;
        } catch (error) {
          console.error(`[task-board] could not remove recorded verify workspace for ${workItemId}`, error);
        }
      }
      try {
        await workspace.remove(`${workItemId}${VERIFY_WORKSPACE_SUFFIX}`);
        return true;
      } catch (error) {
        console.error(`[task-board] could not remove green verify workspace for ${workItemId}`, error);
        return false;
      }
    } finally {
      this.#workspaceCleanupClaims.delete(verifyAttemptId);
    }
  }

  async #removeBestEffort(workspace: MachineVerifyWorkspaceManager, workItemId: string): Promise<void> {
    try {
      await workspace.remove(`${workItemId}${VERIFY_WORKSPACE_SUFFIX}`);
    } catch (error) {
      console.error(`[task-board] could not remove green verify workspace for ${workItemId}`, error);
    }
  }

  async #retainBestEffort(workspace: MachineVerifyWorkspaceManager, workItemId: string): Promise<void> {
    try {
      await workspace.retain(`${workItemId}${VERIFY_WORKSPACE_SUFFIX}`);
    } catch (error) {
      console.error(`[task-board] could not retain failed verify workspace for ${workItemId}`, error);
    }
  }
}
