import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import type { VerifyRunStatus } from "#server/agents/verify";
import { normalizeTaskBoardConfig } from "#server/task-board";
import {
  DEFAULT_SUPERVISOR_PATH,
  VerifyAttemptsCollaborator,
  type MachineVerifyRunner,
  type MachineVerifyWorkspaceManager,
} from "#server/task-board/collaborators/verify-attempts";
import { TaskBoardRuntime } from "#server/task-board/collaborators/runtime";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import {
  TransparentWorkflow,
  type MachineVerifyEvidence,
} from "#server/task-board/persistence/workflow";
import { SkillRegistry } from "#server/task-board/skills";
import { HUMAN_TOKEN, boardFixture, config, workItemRequest } from "./helpers.js";

type AttemptState = "starting" | "running" | "green" | "failed" | "died" | "failed_to_start";

interface Settlement {
  readonly passed: boolean;
  readonly evidence: MachineVerifyEvidence;
}

test("the default machine-verify supervisor path exists in the runtime build tree", () => {
  assert.equal(existsSync(DEFAULT_SUPERVISOR_PATH), true, DEFAULT_SUPERVISOR_PATH);
});

test("verify workspace configuration defaults beside the database and rejects unsafe overrides", async () => {
  const fixture = await boardFixture();
  try {
    const normalized = config(fixture.path);
    assert.equal(normalized.verifyWorkspaceRoot, join(dirname(fixture.path), "verify-workspaces"));
    assert.throws(
      () => normalizeTaskBoardConfig({
        dbPath: fixture.path,
        humanToken: HUMAN_TOKEN,
        humanPrincipal: "human:alice",
        verifyWorkspaceRoot: "relative/verify-workspaces",
      }),
      /verifyWorkspaceRoot must be an absolute directory path/u,
    );
  } finally {
    fixture.board.close();
  }
});

class FakeWorkspaceManager implements MachineVerifyWorkspaceManager {
  readonly creates: Array<{ key: string; baseRef: string | undefined; branchKey: string | undefined }> = [];
  readonly removed: string[] = [];
  readonly retained: string[] = [];

  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly workspace: string,
  ) {}

  async create(key: string, baseRef?: string, branchKey?: string): Promise<string> {
    assert.equal(this.runtime.store.hasOpenTransaction, false);
    this.creates.push({ key, baseRef, branchKey });
    return this.workspace;
  }

  async remove(key: string): Promise<void> {
    assert.equal(this.runtime.store.hasOpenTransaction, false);
    this.removed.push(key);
  }

  async retain(key: string): Promise<void> {
    assert.equal(this.runtime.store.hasOpenTransaction, false);
    this.retained.push(key);
  }
}

class FakeRunner implements MachineVerifyRunner {
  readonly starts: string[] = [];
  readonly statusCalls: string[] = [];
  readonly tailCalls: Array<{ id: string; bytes: number }> = [];
  startErrors: Error[] = [];
  statusError: Error | null = null;
  tailError: Error | null = null;
  statusState: VerifyRunStatus["state"] = "running";
  tailText = "verify log tail";

  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly repoRoot: string,
  ) {}

  async startFull(): Promise<string> {
    assert.equal(this.runtime.store.hasOpenTransaction, false);
    this.starts.push(this.repoRoot);
    const error = this.startErrors.shift();
    if (error !== undefined) throw error;
    return `verify-run-${this.starts.length}`;
  }

  async status(id: string): Promise<VerifyRunStatus> {
    assert.equal(this.runtime.store.hasOpenTransaction, false);
    this.statusCalls.push(id);
    if (this.statusError !== null) throw this.statusError;
    return {
      id,
      state: this.statusState,
      startedAt: "2026-08-19T12:00:00.000Z",
      endedAt: this.statusState === "running" ? null : "2026-08-19T12:01:00.000Z",
      exitCode: this.statusState === "green" ? 0 : this.statusState === "running" || this.statusState === "died" ? null : 1,
      command: "npm test",
    };
  }

  async tail(id: string, bytes: number): Promise<string> {
    assert.equal(this.runtime.store.hasOpenTransaction, false);
    this.tailCalls.push({ id, bytes });
    if (this.tailError !== null) throw this.tailError;
    return this.tailText;
  }
}

async function attemptFixture(
  suffix: string,
  state: AttemptState,
  criterionChecks: readonly { readonly criterion: string; readonly check: string }[] = [],
  settleWorkflow = false,
) {
  const fixture = await boardFixture();
  const workItem = fixture.board.createWorkItem(workItemRequest({
    originalRequest: `Machine verify ${suffix}.`,
    projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
  }), `machine-verify-${suffix}`).workItem;
  fixture.board.close();
  const boardConfig = config(fixture.path);
  const store = await TaskBoardStore.open(boardConfig.dbPath);
  const runtime = new TaskBoardRuntime(boardConfig, store);
  const planRevisionId = `plan-machine-verify-${suffix}`;
  const nodeId = `node-machine-verify-${suffix}`;
  const verifyAttemptId = `verify-attempt-${suffix}`;
  const workspacePath = join(await mkdtemp(join(tmpdir(), "machine-verify-workspace-")), "checkout");
  store.transaction(() => {
    store.db.prepare("UPDATE projects SET description=? WHERE project_id=?")
      .run("/target/repository", fixture.project.projectId);
    store.db.prepare(`
      UPDATE work_items
      SET state='verifying', current_stage='testing', pipeline_branch=?, base_sha=?, version=version+1
      WHERE work_item_id=?
    `).run(`task/${workItem.workItemId}`, "a".repeat(40), workItem.workItemId);
    store.db.prepare(`
      INSERT INTO plan_revisions(
        plan_revision_id, work_item_id, revision, objective, assumptions_json, acceptance_criteria_json,
        change_shape, tier, declared_scope_json, non_goals_json, mechanical_portions_json,
        blocking_questions_json, criterion_checks_json, rejected_note, project_id, skill_digests_json,
        state, created_by, confirmed_by, created_at, confirmed_at
      ) VALUES (?, ?, 1, ?, '[]', '["Verify succeeds."]', 'feature', 'standard', '["src"]', '[]',
        '[]', '[]', ?, NULL, ?, '{}', 'confirmed', 'human:alice', 'human:alice', ?, ?)
    `).run(
      planRevisionId,
      workItem.workItemId,
      `Machine verify ${suffix}.`,
      JSON.stringify(criterionChecks),
      fixture.project.projectId,
      "2026-08-19T12:00:00.000Z",
      "2026-08-19T12:00:00.000Z",
    );
    store.db.prepare(`
      INSERT INTO work_nodes(
        node_id, plan_revision_id, project_id, title, objective, acceptance_criteria_json,
        stage_template_json, current_stage, state, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'Verify', 'Run machine verify.', '["Verify succeeds."]',
        '["implementation","testing"]', 'testing', 'active', 1, ?, ?)
    `).run(
      nodeId,
      planRevisionId,
      fixture.project.projectId,
      "2026-08-19T12:00:00.000Z",
      "2026-08-19T12:00:00.000Z",
    );
    store.db.prepare(`
      INSERT INTO verify_attempts(
        verify_attempt_id, node_id, stage, attempt, verify_run_id, workspace_path,
        state, check_results_json, detail, created_at, ended_at
      ) VALUES (?, ?, 'testing', 1, ?, ?, ?, NULL, NULL, ?, NULL)
    `).run(
      verifyAttemptId,
      nodeId,
      state === "running" ? "verify-run-1" : null,
      state === "running" ? workspacePath : null,
      state,
      "2026-08-19T12:00:00.000Z",
    );
  });

  const workspace = new FakeWorkspaceManager(runtime, workspacePath);
  const runner = new FakeRunner(runtime, workspacePath);
  const settlements: Settlement[] = [];
  const checkCalls: Array<{ command: string; cwd: string }> = [];
  const gitCalls: string[][] = [];
  let checkPassed = true;
  const workflow = settleWorkflow
    ? new TransparentWorkflow(
        store.db,
        new SkillRegistry(resolve("skills")),
        boardConfig.now,
        (operation) => store.transaction(operation),
        undefined,
        () => "a".repeat(40),
      )
    : null;
  const collaborator = new VerifyAttemptsCollaborator(runtime, {
    supervisorPath: "/orchestrator/build/server/agents/verify/supervisor.js",
    workspaceManagerFactory: () => workspace,
    runnerFactory: ({ repoRoot }) => {
      assert.equal(repoRoot, workspacePath);
      return runner;
    },
    executeCheck: async (command, cwd) => {
      assert.equal(runtime.store.hasOpenTransaction, false);
      checkCalls.push({ command, cwd });
      return { passed: checkPassed, detail: checkPassed ? "exit 0" : "exit 1" };
    },
    git: (arguments_) => {
      assert.equal(runtime.store.hasOpenTransaction, false);
      gitCalls.push([...arguments_]);
      return "b".repeat(40);
    },
    settleInTransaction: (_nodeId, _stage, passed, evidence) => {
      assert.equal(runtime.store.hasOpenTransaction, true);
      settlements.push({ passed, evidence });
      return workflow?.settleMachineVerifyAttemptInTransaction(_nodeId, _stage, passed, evidence) ?? [];
    },
    activateNodes: () => undefined,
  });

  const row = () => store.db.prepare("SELECT * FROM verify_attempts WHERE verify_attempt_id=?")
    .get(verifyAttemptId) as Record<string, unknown>;
  return {
    runtime, store, collaborator, runner, workspace, settlements, checkCalls, gitCalls, row,
    verifyAttemptId, workItem, nodeId,
    setCheckPassed(value: boolean): void { checkPassed = value; },
  };
}

test("starting attempts start outside the transaction, then green runs execute and record criterion checks", async () => {
  const fixture = await attemptFixture("green", "starting", [{
    criterion: "The focused test passes.",
    check: "node test.mjs",
  }]);
  try {
    await fixture.collaborator.sweep();
    assert.equal(fixture.row().state, "running");
    assert.deepEqual(fixture.workspace.creates, [{
      key: `${fixture.workItem.workItemId}-verify`,
      baseRef: "a".repeat(40),
      branchKey: fixture.workItem.workItemId,
    }]);

    fixture.runner.statusState = "green";
    await fixture.collaborator.sweep();

    assert.equal(fixture.row().state, "green");
    assert.deepEqual(JSON.parse(String(fixture.row().check_results_json)), [{
      criterion: "The focused test passes.",
      check: "node test.mjs",
      passed: true,
    }]);
    assert.deepEqual(fixture.checkCalls, [{ command: "node test.mjs", cwd: String(fixture.row().workspace_path) }]);
    assert.deepEqual(fixture.gitCalls, [[
      "-c", "core.fsmonitor=", "-c", "core.hooksPath=", "-C", String(fixture.row().workspace_path),
      "rev-parse", "HEAD",
    ]]);
    assert.equal(fixture.row().detail, `verified-sha:${"b".repeat(40)}`);
    assert.equal(fixture.settlements[0]?.passed, true);
    assert.deepEqual(fixture.workspace.removed, [`${fixture.workItem.workItemId}-verify`]);
    assert.deepEqual(fixture.workspace.retained, []);
  } finally {
    fixture.runtime.close();
    fixture.store.close();
  }
});

test("a failed criterion settles the green verify run as failed and retains its workspace", async () => {
  const fixture = await attemptFixture("check-failure", "running", [{
    criterion: "The focused test passes.",
    check: "node test.mjs",
  }]);
  try {
    fixture.runner.statusState = "green";
    fixture.setCheckPassed(false);
    await fixture.collaborator.sweep();

    assert.equal(fixture.row().state, "failed");
    assert.match(String(fixture.row().detail), /The focused test passes/u);
    assert.equal(fixture.settlements[0]?.passed, false);
    assert.deepEqual(fixture.workspace.removed, []);
    assert.deepEqual(fixture.workspace.retained, [`${fixture.workItem.workItemId}-verify`]);
  } finally {
    fixture.runtime.close();
    fixture.store.close();
  }
});

for (const terminal of ["failed", "died"] as const) {
  test(`${terminal} verify runs settle with a bounded tail and retain the workspace`, async () => {
    const fixture = await attemptFixture(`terminal-${terminal}`, "running");
    try {
      fixture.runner.statusState = terminal;
      fixture.runner.tailText = `${terminal} evidence`;
      await fixture.collaborator.sweep();

      assert.equal(fixture.row().state, terminal);
      assert.deepEqual(fixture.runner.tailCalls, [{ id: "verify-run-1", bytes: 4_096 }]);
      assert.equal(fixture.settlements[0]?.passed, false);
      assert.match(fixture.settlements[0]?.evidence.summary ?? "", new RegExp(`${terminal} evidence`, "u"));
      assert.deepEqual(fixture.workspace.retained, [`${fixture.workItem.workItemId}-verify`]);
    } finally {
      fixture.runtime.close();
      fixture.store.close();
    }
  });
}

test("failed_to_start retries once, while a second start failure settles the verify round", async () => {
  const retried = await attemptFixture("retry-start", "starting");
  try {
    retried.runner.startErrors.push(new Error("first spawn failed"));
    await retried.collaborator.sweep();
    assert.equal(retried.row().state, "failed_to_start");
    assert.match(String(retried.row().detail), /start-failures:1/u);

    await retried.collaborator.sweep();
    assert.equal(retried.row().state, "running");
    assert.equal(retried.runner.starts.length, 2);
    assert.deepEqual(retried.settlements, []);
  } finally {
    retried.runtime.close();
    retried.store.close();
  }

  const exhausted = await attemptFixture("exhaust-start", "starting");
  try {
    exhausted.runner.startErrors.push(new Error("first spawn failed"), new Error("second spawn failed"));
    await exhausted.collaborator.sweep();
    await exhausted.collaborator.sweep();

    assert.equal(exhausted.row().state, "failed");
    assert.match(String(exhausted.row().detail), /second spawn failed/u);
    assert.equal(exhausted.settlements[0]?.passed, false);
    assert.deepEqual(exhausted.workspace.retained, [`${exhausted.workItem.workItemId}-verify`]);
  } finally {
    exhausted.runtime.close();
    exhausted.store.close();
  }
});

test("missing running-attempt status and tail files settle died and return the node to implementation", async () => {
  const fixture = await attemptFixture("missing-run-files", "running", [], true);
  try {
    fixture.runner.statusError = new Error("ENOENT: workspace/status.json");
    fixture.runner.tailError = new Error("ENOENT: workspace/log");

    await fixture.collaborator.sweep();

    assert.equal(fixture.row().state, "died");
    assert.deepEqual(fixture.runner.statusCalls, ["verify-run-1"]);
    assert.deepEqual(fixture.runner.tailCalls, [{ id: "verify-run-1", bytes: 4_096 }]);
    assert.equal(fixture.settlements.length, 1);
    assert.equal(fixture.settlements[0]?.passed, false);
    assert.match(fixture.settlements[0]?.evidence.summary ?? "", /workspace\/status\.json/u);
    assert.match(fixture.settlements[0]?.evidence.summary ?? "", /workspace\/log/u);
    const node = fixture.store.db.prepare(
      "SELECT state,current_stage FROM work_nodes WHERE node_id=?",
    ).get(fixture.nodeId);
    assert.equal(node?.state, "ready");
    assert.equal(node?.current_stage, "implementation");
    assert.equal(fixture.runtime.requireWorkItem(fixture.workItem.workItemId).state, "implementing");
    assert.equal(Number(fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM stage_handoffs WHERE node_id=? AND stage='testing'",
    ).get(fixture.nodeId)?.count), 1);
  } finally {
    fixture.runtime.close();
    fixture.store.close();
  }
});

test("overlapping verify sweeps settle one handoff and one implementation return", async () => {
  const fixture = await attemptFixture("overlapping-sweeps", "running", [], true);
  try {
    fixture.runner.statusState = "failed";
    fixture.runner.tailText = "overlap failure evidence";

    await Promise.all([fixture.collaborator.sweep(), fixture.collaborator.sweep()]);

    assert.equal(fixture.settlements.length, 1);
    assert.deepEqual(fixture.runner.statusCalls, ["verify-run-1"]);
    assert.equal(Number(fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM stage_handoffs WHERE node_id=? AND stage='testing'",
    ).get(fixture.nodeId)?.count), 1);
    assert.equal(Number(fixture.store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM project_events
      WHERE node_id=? AND event_type='stage_retry_ready'
    `).get(fixture.nodeId)?.count), 1);
    const node = fixture.store.db.prepare(
      "SELECT state,current_stage,version FROM work_nodes WHERE node_id=?",
    ).get(fixture.nodeId);
    assert.equal(node?.state, "ready");
    assert.equal(node?.current_stage, "implementation");
    assert.equal(node?.version, 2);
  } finally {
    fixture.runtime.close();
    fixture.store.close();
  }
});

test("green rounds separated by final rejection do not consume the failed-verify retry budget", async () => {
  const fixture = await attemptFixture("green-rejection-budget", "running", [], true);
  try {
    fixture.store.transaction(() => {
      fixture.store.db.prepare("UPDATE verify_attempts SET attempt=5 WHERE verify_attempt_id=?")
        .run(fixture.verifyAttemptId);
      const insert = fixture.store.db.prepare(`
        INSERT INTO verify_attempts(
          verify_attempt_id,node_id,stage,attempt,verify_run_id,workspace_path,state,
          check_results_json,detail,created_at,ended_at
        ) VALUES (?,?,'testing',?,NULL,NULL,'green','[]',?, ?, ?)
      `);
      insert.run(
        "verify-prior-green-one",
        fixture.nodeId,
        1,
        `verified-sha:${"1".repeat(40)}`,
        "2026-08-19T11:00:00.000Z",
        "2026-08-19T11:01:00.000Z",
      );
      insert.run(
        "verify-prior-green-two",
        fixture.nodeId,
        3,
        `verified-sha:${"2".repeat(40)}`,
        "2026-08-19T11:30:00.000Z",
        "2026-08-19T11:31:00.000Z",
      );
    });
    fixture.runner.statusState = "failed";

    await fixture.collaborator.sweep();

    assert.equal(fixture.runtime.requireWorkItem(fixture.workItem.workItemId).state, "implementing");
    assert.deepEqual({
      ...fixture.store.db.prepare("SELECT state,current_stage FROM work_nodes WHERE node_id=?")
        .get(fixture.nodeId),
    }, { state: "ready", current_stage: "implementation" });
  } finally {
    fixture.runtime.close();
    fixture.store.close();
  }
});

test("three failed or died verify rounds exhaust the verify retry budget", async () => {
  const fixture = await attemptFixture("failed-budget", "running", [], true);
  try {
    fixture.store.transaction(() => {
      fixture.store.db.prepare("UPDATE verify_attempts SET attempt=5 WHERE verify_attempt_id=?")
        .run(fixture.verifyAttemptId);
      const insert = fixture.store.db.prepare(`
        INSERT INTO verify_attempts(
          verify_attempt_id,node_id,stage,attempt,verify_run_id,workspace_path,state,
          check_results_json,detail,created_at,ended_at
        ) VALUES (?,?,'testing',?,NULL,NULL,?,'[]','prior verify failure',?,?)
      `);
      insert.run(
        "verify-prior-failed-one",
        fixture.nodeId,
        1,
        "failed",
        "2026-08-19T11:00:00.000Z",
        "2026-08-19T11:01:00.000Z",
      );
      insert.run(
        "verify-prior-died-two",
        fixture.nodeId,
        3,
        "died",
        "2026-08-19T11:30:00.000Z",
        "2026-08-19T11:31:00.000Z",
      );
    });
    fixture.runner.statusState = "failed";

    await fixture.collaborator.sweep();

    assert.equal(fixture.runtime.requireWorkItem(fixture.workItem.workItemId).state, "dead_letter");
    assert.equal(fixture.store.db.prepare("SELECT state FROM work_nodes WHERE node_id=?")
      .get(fixture.nodeId)?.state, "blocked");
  } finally {
    fixture.runtime.close();
    fixture.store.close();
  }
});
