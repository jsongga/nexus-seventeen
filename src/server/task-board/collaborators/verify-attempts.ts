import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { VerifyRunnerOptions, VerifyRunStatus } from "#server/agents/verify";
import { VerifyRunner } from "#server/agents/verify";
import { TaskWorkspaceManager } from "#server/agents/task-workspace";
import type { PlanCriterionCheck, VerifyAttempt, WorkNode, WorkflowStage } from "#shared/task-board-contract";
import { exactNow } from "../persistence/timestamps.js";
import type { MachineVerifyEvidence } from "../persistence/workflow.js";
import type { TaskBoardRuntime } from "./runtime.js";

const CHECK_TIMEOUT_MS = 120_000;
const CHECK_MAX_BYTES = 1024 * 1024;
const TAIL_BYTES = 4_096;
const START_FAILURE_MARKER = /\[machine-verify-start-failures:(\d+)\]/u;
export const DEFAULT_SUPERVISOR_PATH = fileURLToPath(
  new URL("../../agents/verify/supervisor.js", import.meta.url),
);

type Row = Record<string, unknown>;

export interface MachineVerifyRunner {
  startFull(): Promise<string>;
  status(id: string): Promise<VerifyRunStatus>;
  tail(id: string, bytes: number): Promise<string>;
}

export interface MachineVerifyWorkspaceManager {
  create(key: string, baseRef?: string, branchKey?: string): Promise<string>;
  remove(key: string): Promise<void>;
  retain(key: string): Promise<void>;
}

export interface CriterionCheckExecution {
  readonly passed: boolean;
  readonly detail: string;
}

export interface VerifyAttemptsDependencies {
  readonly supervisorPath?: string;
  readonly workspaceManagerFactory?: (repositoryPath: string) => MachineVerifyWorkspaceManager;
  readonly runnerFactory?: (options: VerifyRunnerOptions) => MachineVerifyRunner;
  readonly executeCheck?: (command: string, cwd: string) => Promise<CriterionCheckExecution>;
  readonly settleInTransaction: (
    nodeId: string,
    stage: WorkflowStage,
    passed: boolean,
    evidence: MachineVerifyEvidence,
  ) => readonly WorkNode[];
  readonly activateNodes: (nodes: readonly WorkNode[]) => void;
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
  readonly repositoryPath: string;
  readonly baseSha: string | null;
  readonly criterionChecks: readonly PlanCriterionCheck[];
}

interface CheckOutcome {
  readonly results: readonly { readonly criterion: string; readonly check: string; readonly passed: boolean }[];
  readonly failures: readonly string[];
}

export type StartingVerifyAttemptResult =
  | Readonly<{ kind: "created"; verifyAttemptId: string }>
  | Readonly<{ kind: "ineligible" }>
  | Readonly<{ kind: "pipeline_required" }>;

function errorDetail(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 4_000);
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

function executeCriterionCheck(command: string, cwd: string): Promise<CriterionCheckExecution> {
  let argv: readonly string[];
  try {
    argv = commandArgv(command);
  } catch (error) {
    return Promise.resolve({ passed: false, detail: errorDetail(error) });
  }
  const [program, ...args] = argv;
  if (program === undefined) return Promise.resolve({ passed: false, detail: "criterion check is empty" });
  return new Promise((resolve) => {
    execFile(program, args, {
      cwd,
      encoding: "utf8",
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: CHECK_MAX_BYTES,
      windowsHide: true,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ passed: true, detail: "exit 0" });
        return;
      }
      const output = `${stderr}${stdout}`.trim();
      resolve({
        passed: false,
        detail: (output.length > 0 ? output : error.message).slice(0, 2_000),
      });
    });
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
    repositoryPath: String(row.repository_path),
    baseSha: row.base_sha === null ? null : String(row.base_sha),
    criterionChecks: Object.freeze(JSON.parse(String(row.criterion_checks_json ?? "[]")) as PlanCriterionCheck[]),
  });
}

export class VerifyAttemptsCollaborator {
  readonly #supervisorPath: string;
  readonly #workspaceManagerFactory: (repositoryPath: string) => MachineVerifyWorkspaceManager;
  readonly #runnerFactory: (options: VerifyRunnerOptions) => MachineVerifyRunner;
  readonly #executeCheck: (command: string, cwd: string) => Promise<CriterionCheckExecution>;
  readonly #inFlightStarts = new Set<string>();
  #sweepInFlight: Promise<number> | null = null;
  #closed = false;

  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly dependencies: VerifyAttemptsDependencies,
  ) {
    this.#supervisorPath = dependencies.supervisorPath ?? DEFAULT_SUPERVISOR_PATH;
    this.#workspaceManagerFactory = dependencies.workspaceManagerFactory ?? ((repositoryPath) =>
      new TaskWorkspaceManager({
        workspaceRoot: runtime.config.verifyWorkspaceRoot,
        repositoryPath,
      }));
    this.#runnerFactory = dependencies.runnerFactory ?? ((options) => new VerifyRunner(options));
    this.#executeCheck = dependencies.executeCheck ?? executeCriterionCheck;
  }

  createStartingAttemptInTransaction(nodeId: string, stage: WorkflowStage): StartingVerifyAttemptResult {
    const row = this.runtime.store.db.prepare(`
      SELECT node.project_id, node.title, node.state, node.current_stage, item.pipeline_branch
      FROM work_nodes node
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      WHERE node.node_id=?
    `).get(nodeId) as Row | undefined;
    if (
      row === undefined ||
      row.current_stage !== stage ||
      (row.state !== "ready" && row.state !== "blocked")
    ) return Object.freeze({ kind: "ineligible" });
    if (row.pipeline_branch === null) return Object.freeze({ kind: "pipeline_required" });
    const attempt = Number(this.runtime.store.db.prepare(`
      SELECT COALESCE(MAX(prior.attempt), 0) + 1 AS next_attempt
      FROM (
        SELECT attempt FROM verify_attempts WHERE node_id=? AND stage=?
        UNION ALL
        SELECT attempt FROM stage_attempts WHERE node_id=? AND stage=?
      ) prior
    `).get(nodeId, stage, nodeId, stage)?.next_attempt);
    const verifyAttemptId = `verify_${randomUUID()}`;
    const now = exactNow(this.runtime.config.now);
    this.runtime.store.db.prepare(`
      INSERT INTO verify_attempts(
        verify_attempt_id, node_id, stage, attempt, verify_run_id, workspace_path,
        state, check_results_json, detail, created_at, ended_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, 'starting', NULL, NULL, ?, NULL)
    `).run(verifyAttemptId, nodeId, stage, attempt, now);
    const updated = this.runtime.store.db.prepare(`
      UPDATE work_nodes
      SET state='active',version=version+1,updated_at=?
      WHERE node_id=? AND current_stage=? AND state IN ('ready','blocked')
    `).run(now, nodeId, stage);
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
    const sweep = this.#sweepOpenAttempts();
    this.#sweepInFlight = sweep;
    void sweep.finally(() => {
      if (this.#sweepInFlight === sweep) this.#sweepInFlight = null;
    }).catch(() => undefined);
    return sweep;
  }

  close(): void {
    this.#closed = true;
  }

  async #sweepOpenAttempts(): Promise<number> {
    const attemptIds = (this.runtime.store.db.prepare(`
      SELECT verify_attempt_id
      FROM verify_attempts
      WHERE state IN ('starting','running','failed_to_start')
      ORDER BY created_at, verify_attempt_id
    `).all() as Row[]).map((row) => String(row.verify_attempt_id));
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
    const row = this.runtime.store.db.prepare(`
      SELECT
        verify.*,
        plan.work_item_id,
        plan.criterion_checks_json,
        item.base_sha,
        project.description AS repository_path
      FROM verify_attempts verify
      JOIN work_nodes node ON node.node_id=verify.node_id
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      JOIN work_items item ON item.work_item_id=plan.work_item_id
      JOIN projects project ON project.project_id=node.project_id
      WHERE verify.verify_attempt_id=?
    `).get(verifyAttemptId) as Row | undefined;
    return row === undefined ? undefined : attemptContext(row);
  }

  async #start(verifyAttemptId: string): Promise<boolean> {
    if (this.#closed) return false;
    if (this.#inFlightStarts.has(verifyAttemptId)) return false;
    this.#inFlightStarts.add(verifyAttemptId);
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
        `${current.workItemId}-verify`,
        current.baseSha ?? undefined,
        current.workItemId,
      );
      if (this.#closed) {
        await this.#removeBestEffort(workspace, current.workItemId);
        return false;
      }
      const runner = this.#runnerFactory({ repoRoot: workspacePath, supervisorPath: this.#supervisorPath });
      const verifyRunId = await runner.startFull();
      if (this.#closed) {
        await this.#removeBestEffort(workspace, current.workItemId);
        return false;
      }
      this.runtime.store.transaction(() => {
        this.runtime.store.db.prepare(`
          UPDATE verify_attempts
          SET state='running',verify_run_id=?,workspace_path=?,detail=NULL
          WHERE verify_attempt_id=? AND state IN ('starting','failed_to_start')
        `).run(verifyRunId, workspacePath, verifyAttemptId);
      });
      return true;
    } catch (error) {
      if (this.#closed) {
        if (workspace !== null && current !== undefined) {
          await this.#removeBestEffort(workspace, current.workItemId);
        }
        return false;
      }
      current = this.#context(verifyAttemptId);
      if (current === undefined || (current.state !== "starting" && current.state !== "failed_to_start")) return false;
      const failedAttempt = current;
      const failures = startFailureCount(current.detail) + 1;
      const detail = `[machine-verify-start-failures:${failures}] ${errorDetail(error)}`;
      let settledNodes: readonly WorkNode[] = [];
      this.runtime.store.transaction(() => {
        if (failures < 2) {
          this.runtime.store.db.prepare(`
            UPDATE verify_attempts
            SET state='failed_to_start',workspace_path=?,detail=?
            WHERE verify_attempt_id=? AND state IN ('starting','failed_to_start')
          `).run(workspacePath, detail, verifyAttemptId);
          return;
        }
        const now = exactNow(this.runtime.config.now);
        this.runtime.store.db.prepare(`
          UPDATE verify_attempts
          SET state='failed',workspace_path=?,detail=?,ended_at=?
          WHERE verify_attempt_id=? AND state IN ('starting','failed_to_start')
        `).run(workspacePath, detail, now, verifyAttemptId);
        settledNodes = this.dependencies.settleInTransaction(
          failedAttempt.nodeId,
          failedAttempt.stage,
          false,
          Object.freeze({
            summary: `Machine verify failed to start after two attempts: ${errorDetail(error)}`,
            evidence: Object.freeze([detail]),
            acceptanceCriteria: Object.freeze([]),
            blockers: Object.freeze([errorDetail(error)]),
          }),
        );
      });
      if (failures >= 2) {
        this.dependencies.activateNodes(settledNodes);
        if (workspace !== null) await this.#retainBestEffort(workspace, current.workItemId);
      }
      return true;
    } finally {
      this.#inFlightStarts.delete(verifyAttemptId);
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
    if (checks.failures.length > 0) {
      const detail = `Machine verify criterion checks failed: ${checks.failures.join("; ")}`.slice(0, 4_000);
      await this.#finalize(current, "failed", checks, detail, false);
    } else {
      await this.#finalize(current, "green", checks, "Machine verify and criterion checks passed.", true);
    }
    return true;
  }

  async #runChecks(current: AttemptContext): Promise<CheckOutcome> {
    if (current.workspacePath === null) return Object.freeze({ results: Object.freeze([]), failures: Object.freeze([]) });
    const results: Array<{ criterion: string; check: string; passed: boolean }> = [];
    const failures: string[] = [];
    for (const check of current.criterionChecks) {
      if (this.#closed) break;
      let execution: CriterionCheckExecution;
      try {
        execution = await this.#executeCheck(check.check, current.workspacePath);
      } catch (error) {
        execution = { passed: false, detail: errorDetail(error) };
      }
      results.push({ criterion: check.criterion, check: check.check, passed: execution.passed });
      if (!execution.passed) failures.push(`${check.criterion}: ${execution.detail}`);
    }
    return Object.freeze({ results: Object.freeze(results), failures: Object.freeze(failures) });
  }

  async #finalizeFailure(
    current: AttemptContext,
    state: "failed" | "died",
    detail: string,
  ): Promise<void> {
    await this.#finalize(
      current,
      state,
      Object.freeze({ results: Object.freeze([]), failures: Object.freeze([detail]) }),
      detail,
      false,
    );
  }

  async #finalize(
    current: AttemptContext,
    state: "green" | "failed" | "died",
    checks: CheckOutcome,
    detail: string,
    passed: boolean,
  ): Promise<void> {
    if (this.#closed) return;
    let settledNodes: readonly WorkNode[] = [];
    let settled = false;
    this.runtime.store.transaction(() => {
      const update = this.runtime.store.db.prepare(`
        UPDATE verify_attempts
        SET state=?,check_results_json=?,detail=?,ended_at=?
        WHERE verify_attempt_id=? AND state='running'
      `).run(
        state,
        JSON.stringify(checks.results),
        detail.slice(0, 4_000),
        exactNow(this.runtime.config.now),
        current.verifyAttemptId,
      );
      if (Number(update.changes) !== 1) return;
      const criterionResults = current.criterionChecks.map((criterion, index) => Object.freeze({
        criterion: criterion.criterion,
        passed: checks.results[index]?.passed ?? false,
        evidence: checks.results[index]?.passed === true
          ? `Passed: ${criterion.check}`
          : checks.failures.find((failure) => failure.startsWith(`${criterion.criterion}:`)) ?? `Failed: ${criterion.check}`,
      }));
      settledNodes = this.dependencies.settleInTransaction(
        current.nodeId,
        current.stage,
        passed,
        Object.freeze({
          summary: detail.slice(0, 4_000),
          evidence: Object.freeze([detail.slice(0, 4_000)]),
          acceptanceCriteria: Object.freeze(criterionResults),
          blockers: Object.freeze(passed ? [] : [...checks.failures]),
        }),
      );
      settled = true;
    });
    if (!settled) return;
    this.dependencies.activateNodes(settledNodes);
    const workspace = this.#workspaceManagerFactory(current.repositoryPath);
    if (passed) await this.#removeBestEffort(workspace, current.workItemId);
    else await this.#retainBestEffort(workspace, current.workItemId);
  }

  async #removeBestEffort(workspace: MachineVerifyWorkspaceManager, workItemId: string): Promise<void> {
    try {
      await workspace.remove(`${workItemId}-verify`);
    } catch (error) {
      console.error(`[task-board] could not remove green verify workspace for ${workItemId}`, error);
    }
  }

  async #retainBestEffort(workspace: MachineVerifyWorkspaceManager, workItemId: string): Promise<void> {
    try {
      await workspace.retain(`${workItemId}-verify`);
    } catch (error) {
      console.error(`[task-board] could not retain failed verify workspace for ${workItemId}`, error);
    }
  }
}
