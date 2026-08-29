import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import type { WorkflowPlanDraft } from "#shared/task-board-contract";
import type { VerifyRunStatus } from "#server/agents/verify";
import { normalizeTaskBoardConfig } from "#server/task-board";
import { AutomationCollaborator } from "#server/task-board/collaborators/automation";
import { ProjectsCollaborator } from "#server/task-board/collaborators/projects";
import {
  DEFAULT_SUPERVISOR_PATH,
  VerifyAttemptsCollaborator,
  retireOpenVerifyAttemptsForWorkItemInTransaction,
  type MachineVerifyRunner,
  type MachineVerifyWorkspaceManager,
} from "#server/task-board/collaborators/verify-attempts";
import { TaskBoardRuntime } from "#server/task-board/collaborators/runtime";
import { TasksCollaborator } from "#server/task-board/collaborators/tasks";
import { registerParentTerminationCascade } from "#server/task-board/collaborators/work-item-transitions";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import {
  TransparentWorkflow,
  type MachineVerifyEvidence,
} from "#server/task-board/persistence/workflow";
import { SkillRegistry } from "#server/task-board/skills";
import {
  HUMAN_TOKEN,
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  config,
  workItemRequest,
} from "../helpers.js";

type AttemptState = "starting" | "running" | "green" | "failed" | "died" | "failed_to_start";

interface Settlement {
  readonly passed: boolean;
  readonly evidence: MachineVerifyEvidence;
}

function heldVerifyPlan(suffix: string): WorkflowPlanDraft {
  return {
    objective: `Exercise verify scope release ${suffix}.`,
    assumptions: ["The older overlapping pipeline owns the shared scope."],
    acceptanceCriteria: ["Dead-letter settlement releases the newer pipeline immediately."],
    changeShape: "feature",
    tier: "standard",
    declaredScope: ["src/shared"],
    nonGoals: ["Do not wait for periodic reconciliation."],
    mechanicalPortions: [],
    blockingQuestions: [],
    criterionChecks: [],
    nodes: [{
      nodeId: `verify-scope-release-${suffix}`,
      title: `Verify scope release ${suffix}`,
      objective: "Run the standard pipeline through machine verification.",
      acceptanceCriteria: ["The held sibling can activate when this item exits the in-flight set."],
      dependencyNodeIds: [],
      stageTemplate: ["implementation", "testing", "verification"],
    }],
  };
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
  onCreate: (() => void | Promise<void>) | null = null;

  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly workspace: string,
  ) {}

  async create(key: string, baseRef?: string, branchKey?: string): Promise<string> {
    assert.equal(this.runtime.store.hasOpenTransaction, false);
    this.creates.push({ key, baseRef, branchKey });
    await this.onCreate?.();
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
  readonly terminateCalls: string[] = [];
  readonly statusCalls: string[] = [];
  readonly tailCalls: Array<{ id: string; bytes: number }> = [];
  startErrors: Error[] = [];
  statusError: Error | null = null;
  tailError: Error | null = null;
  statusState: VerifyRunStatus["state"] = "running";
  tailText = "verify log tail";
  onStart: (() => void | Promise<void>) | null = null;
  onStatus: (() => void | Promise<void>) | null = null;

  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly repoRoot: string,
  ) {}

  async startFull(): Promise<string> {
    assert.equal(this.runtime.store.hasOpenTransaction, false);
    this.starts.push(this.repoRoot);
    const error = this.startErrors.shift();
    if (error !== undefined) throw error;
    await this.onStart?.();
    return `verify-run-${this.starts.length}`;
  }

  async terminate(id: string): Promise<void> {
    assert.equal(this.runtime.store.hasOpenTransaction, false);
    this.terminateCalls.push(id);
  }

  async status(id: string): Promise<VerifyRunStatus> {
    assert.equal(this.runtime.store.hasOpenTransaction, false);
    this.statusCalls.push(id);
    await this.onStatus?.();
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
  registerParentTerminationCascade(store, () => undefined);
  const planRevisionId = `plan-machine-verify-${suffix}`;
  const nodeId = `node-machine-verify-${suffix}`;
  const verifyAttemptId = `verify-attempt-${suffix}`;
  const workspacePath = join(await mkdtemp(join(tmpdir(), "machine-verify-workspace-")), "checkout");
  store.transaction(() => {
    store.db.prepare("UPDATE projects SET repo_path=? WHERE project_id=?")
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
  let checkDetails: readonly string[] = ["exit 1"];
  const workflow = settleWorkflow
    ? new TransparentWorkflow(
        store.db,
        new SkillRegistry(resolve("config/skills.md")),
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
      return {
        passed: checkPassed,
        detail: checkPassed ? "exit 0" : checkDetails[checkCalls.length - 1] ?? checkDetails.at(-1) ?? "exit 1",
      };
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
    reconcileProject: () => undefined,
  });

  const row = () => store.db.prepare("SELECT * FROM verify_attempts WHERE verify_attempt_id=?")
    .get(verifyAttemptId) as Record<string, unknown>;
  return {
    runtime, store, collaborator, runner, workspace, settlements, checkCalls, gitCalls, row,
    verifyAttemptId, workItem, nodeId,
    setCheckPassed(value: boolean): void { checkPassed = value; },
    setCheckFailureDetail(value: string): void { checkDetails = [value]; },
    setCheckFailureDetails(values: readonly string[]): void { checkDetails = [...values]; },
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

test("a stored confirmed v1 pipeline reaches final approval after a green machine-verify sweep", async () => {
  // The fixture inserts ["implementation","testing"] directly to simulate legacy confirmed data.
  const fixture = await attemptFixture("stored-v1-green", "running", [], true);
  try {
    fixture.runner.statusState = "green";

    await fixture.collaborator.sweep();

    assert.equal(fixture.row().state, "green");
    assert.equal(fixture.runtime.requireWorkItem(fixture.workItem.workItemId).state, "final_approval");
    assert.deepEqual({
      ...fixture.store.db.prepare("SELECT state,current_stage FROM work_nodes WHERE node_id=?")
        .get(fixture.nodeId),
    }, { state: "completed", current_stage: null });
  } finally {
    fixture.runtime.close();
    fixture.store.close();
  }
});

test("retiring a starting attempt after spawn terminates its process and removes its workspace", async () => {
  const fixture = await attemptFixture("retired-while-starting", "starting", [], true);
  try {
    fixture.runner.onStart = () => {
      fixture.store.transaction(() => {
        assert.equal(retireOpenVerifyAttemptsForWorkItemInTransaction(
          fixture.runtime,
          fixture.workItem.workItemId,
          "The work item was cancelled.",
          "2026-08-19T12:00:30.000Z",
        ), 1);
      });
    };

    await fixture.collaborator.sweep();

    assert.equal(fixture.row().state, "retired");
    assert.deepEqual(fixture.runner.terminateCalls, ["verify-run-1"]);
    assert.deepEqual(fixture.workspace.removed, [`${fixture.workItem.workItemId}-verify`]);
    assert.deepEqual(fixture.settlements, []);
    assert.equal(Number(fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM project_events WHERE node_id=? AND event_type='stage_completed'",
    ).get(fixture.nodeId)?.count), 0);
  } finally {
    fixture.runtime.close();
    fixture.store.close();
  }
});

test("retiring a running attempt terminates its process and removes its workspace", async () => {
  const fixture = await attemptFixture("retired-while-running", "running", [], true);
  try {
    fixture.store.transaction(() => {
      assert.equal(retireOpenVerifyAttemptsForWorkItemInTransaction(
        fixture.runtime,
        fixture.workItem.workItemId,
        "The work item was cancelled.",
        "2026-08-19T12:00:30.000Z",
      ), 1);
    });
    await fixture.collaborator.sweep();

    assert.equal(fixture.row().state, "retired");
    assert.deepEqual(fixture.runner.terminateCalls, ["verify-run-1"]);
    assert.deepEqual(fixture.workspace.removed, [`${fixture.workItem.workItemId}-verify`]);
    assert.deepEqual(fixture.settlements, []);
    assert.equal(Number(fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM project_events WHERE node_id=? AND event_type='stage_completed'",
    ).get(fixture.nodeId)?.count), 0);
  } finally {
    fixture.runtime.close();
    fixture.store.close();
  }
});

test("retirement racing a running verify settlement cleans the workspace exactly once and rejects its late write", async () => {
  const fixture = await attemptFixture("late-cancellation", "running", [], true);
  let releaseStatus!: () => void;
  let markStatusStarted!: () => void;
  const statusHeld = new Promise<void>((resolveStatus) => { releaseStatus = resolveStatus; });
  const statusStarted = new Promise<void>((resolveStarted) => { markStatusStarted = resolveStarted; });
  try {
    fixture.runner.statusState = "green";
    fixture.runner.onStatus = () => {
      markStatusStarted();
      return statusHeld;
    };
    const lateSweep = fixture.collaborator.sweep();
    await statusStarted;

    fixture.store.transaction(() => {
      assert.equal(retireOpenVerifyAttemptsForWorkItemInTransaction(
        fixture.runtime,
        fixture.workItem.workItemId,
        "The work item was cancelled.",
        "2026-08-19T12:00:30.000Z",
      ), 1);
    });
    releaseStatus();
    assert.equal(await lateSweep, 1);

    assert.equal(fixture.row().state, "retired");
    assert.equal(fixture.row().ended_at, "2026-08-19T12:00:30.000Z");
    assert.deepEqual(fixture.runner.terminateCalls, ["verify-run-1"]);
    assert.deepEqual(fixture.workspace.removed, [`${fixture.workItem.workItemId}-verify`]);
    assert.deepEqual(fixture.settlements, []);
    assert.equal(fixture.store.db.prepare("SELECT 1 FROM tasks WHERE task_id=?")
      .get(`task_${fixture.verifyAttemptId}`), undefined);
    assert.equal(fixture.store.db.prepare("SELECT 1 FROM stage_handoffs WHERE handoff_id=?")
      .get(`handoff_${fixture.verifyAttemptId}`), undefined);
  } finally {
    releaseStatus();
    fixture.runtime.close();
    fixture.store.close();
  }
});

test("retiring a failed_to_start attempt only changes its terminal state", async () => {
  const fixture = await attemptFixture("retired-after-start-failure", "failed_to_start", [], true);
  try {
    fixture.store.transaction(() => {
      assert.equal(retireOpenVerifyAttemptsForWorkItemInTransaction(
        fixture.runtime,
        fixture.workItem.workItemId,
        "The work item was cancelled.",
        "2026-08-19T12:00:30.000Z",
      ), 1);
    });
    await fixture.collaborator.sweep();

    assert.equal(fixture.row().state, "retired");
    assert.deepEqual(fixture.runner.terminateCalls, []);
    assert.deepEqual(fixture.workspace.removed, []);
    assert.deepEqual(fixture.workspace.retained, []);
    assert.deepEqual(fixture.settlements, []);
  } finally {
    fixture.runtime.close();
    fixture.store.close();
  }
});

test("retiring a failed_to_start attempt removes its recorded workspace", async () => {
  const fixture = await attemptFixture("retired-start-failure-workspace", "failed_to_start", [], true);
  try {
    fixture.store.db.prepare("UPDATE verify_attempts SET workspace_path=? WHERE verify_attempt_id=?")
      .run("/tmp/retired-start-failure-workspace", fixture.verifyAttemptId);
    fixture.store.transaction(() => {
      assert.equal(retireOpenVerifyAttemptsForWorkItemInTransaction(
        fixture.runtime,
        fixture.workItem.workItemId,
        "The work item was cancelled.",
        "2026-08-19T12:00:30.000Z",
      ), 1);
    });
    await fixture.collaborator.sweep();

    assert.equal(fixture.row().state, "retired");
    assert.deepEqual(fixture.runner.terminateCalls, []);
    assert.deepEqual(fixture.workspace.removed, [`${fixture.workItem.workItemId}-verify`]);
    assert.deepEqual(fixture.workspace.retained, []);
    assert.deepEqual(fixture.settlements, []);
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

test("criterion commands and failure output are redacted before verify persistence and evidence", async () => {
  const commandSecret = `github_pat_${"c".repeat(48)}`;
  const bearerSecret = `criterion-${"d".repeat(48)}`;
  const fixture = await attemptFixture("redacted-check", "running", [{
    criterion: "The secret-bearing check fails safely.",
    check: `node check.mjs --credential ${commandSecret}`,
  }]);
  try {
    fixture.runner.statusState = "green";
    fixture.setCheckPassed(false);
    fixture.setCheckFailureDetail(`Authorization: Bearer ${bearerSecret}`);

    await fixture.collaborator.sweep();

    const checkResults = String(fixture.row().check_results_json);
    const detail = String(fixture.row().detail);
    assert.match(checkResults, /\[redacted:token\]/u);
    assert.doesNotMatch(checkResults, new RegExp(commandSecret, "u"));
    assert.match(detail, /\[redacted:bearer\]/u);
    assert.doesNotMatch(detail, new RegExp(bearerSecret, "u"));
    assert.match(fixture.settlements[0]?.evidence.blockers[0] ?? "", /\[redacted:bearer\]/u);
    assert.doesNotMatch(JSON.stringify(fixture.settlements[0]?.evidence), new RegExp(bearerSecret, "u"));
  } finally {
    fixture.runtime.close();
    fixture.store.close();
  }
});

test("criterion failure evidence remains aligned by check index when redacted labels collide", async () => {
  const fixture = await attemptFixture("redacted-label-collision", "running", [
    {
      criterion: `Credential sk-ant-${"a".repeat(48)} is rejected.`,
      check: "node first-check.mjs",
    },
    {
      criterion: `Credential sk-ant-${"b".repeat(48)} is rejected.`,
      check: "node second-check.mjs",
    },
  ]);
  try {
    fixture.runner.statusState = "green";
    fixture.setCheckPassed(false);
    fixture.setCheckFailureDetails(["first indexed evidence", "second indexed evidence"]);

    await fixture.collaborator.sweep();

    const criteria = fixture.settlements[0]?.evidence.acceptanceCriteria;
    assert.equal(criteria?.[0]?.criterion, "Credential [redacted:token] is rejected.");
    assert.equal(criteria?.[1]?.criterion, "Credential [redacted:token] is rejected.");
    assert.match(criteria?.[0]?.evidence ?? "", /first indexed evidence/u);
    assert.match(criteria?.[1]?.evidence ?? "", /second indexed evidence/u);
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

test("a secret-bearing verify tail is redacted before every durable failure projection", async () => {
  const fixture = await attemptFixture("redacted-tail", "running", [], true);
  const antToken = `sk-ant-${"a".repeat(48)}`;
  const bearerToken = `bearer-${"b".repeat(48)}`;
  const rawTail = `verify failed ${antToken} Authorization: Bearer ${bearerToken} `
    .padEnd(4_096, "x");
  assert.equal(rawTail.length, 4_096);
  try {
    fixture.store.transaction(() => {
      fixture.store.db.prepare("UPDATE work_nodes SET stage_template_json='[\"testing\"]' WHERE node_id=?")
        .run(fixture.nodeId);
    });
    fixture.runner.statusState = "failed";
    fixture.runner.tailText = rawTail;

    await fixture.collaborator.sweep();

    const detail = String(fixture.row().detail);
    assert.match(detail, /\[redacted:token\]/u);
    assert.match(detail, /\[redacted:bearer\]/u);
    assert.doesNotMatch(detail, new RegExp(antToken, "u"));
    assert.doesNotMatch(detail, new RegExp(bearerToken, "u"));

    const handoffRow = fixture.store.db.prepare(
      "SELECT payload_json FROM stage_handoffs WHERE node_id=? AND stage='testing'",
    ).get(fixture.nodeId);
    assert.ok(handoffRow);
    const handoffJson = String(handoffRow.payload_json);
    const handoff = JSON.parse(handoffJson) as { readonly summary: string };
    assert.match(handoff.summary, /\[redacted:token\]/u);
    assert.match(handoff.summary, /\[redacted:bearer\]/u);
    assert.doesNotMatch(handoffJson, new RegExp(antToken, "u"));
    assert.doesNotMatch(handoffJson, new RegExp(bearerToken, "u"));

    const event = fixture.store.db.prepare(`
      SELECT summary
      FROM project_events
      WHERE node_id=? AND event_type='stage_failed'
    `).get(fixture.nodeId);
    assert.ok(event);
    const eventSummary = String(event.summary);
    assert.match(eventSummary, /\[redacted:token\]/u);
    assert.match(eventSummary, /\[redacted:bearer\]/u);
    assert.doesNotMatch(eventSummary, new RegExp(antToken, "u"));
    assert.doesNotMatch(eventSummary, new RegExp(bearerToken, "u"));
  } finally {
    fixture.runtime.close();
    fixture.store.close();
  }
});

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

test("starting and failed_to_start verify attempts wait out a board pause", async () => {
  const starting = await attemptFixture("paused-starting", "starting");
  try {
    starting.store.db.prepare("UPDATE board_pause SET paused=1,reason='maintenance',version=version+1")
      .run();
    await starting.collaborator.sweep();
    assert.equal(starting.row().state, "starting");
    assert.deepEqual(starting.runner.starts, []);
    assert.deepEqual(starting.workspace.creates, []);

    starting.store.db.prepare("UPDATE board_pause SET paused=0,reason=NULL,version=version+1")
      .run();
    await starting.collaborator.sweep();
    assert.equal(starting.row().state, "running");
    assert.equal(starting.runner.starts.length, 1);
  } finally {
    starting.runtime.close();
    starting.store.close();
  }

  const failedToStart = await attemptFixture("paused-failed-to-start", "starting");
  try {
    failedToStart.runner.startErrors.push(new Error("first spawn failed"));
    await failedToStart.collaborator.sweep();
    assert.equal(failedToStart.row().state, "failed_to_start");
    assert.equal(failedToStart.runner.starts.length, 1);

    failedToStart.store.db.prepare("UPDATE board_pause SET paused=1,reason='maintenance',version=version+1")
      .run();
    await failedToStart.collaborator.sweep();
    assert.equal(failedToStart.row().state, "failed_to_start");
    assert.equal(failedToStart.runner.starts.length, 1);

    failedToStart.store.db.prepare("UPDATE board_pause SET paused=0,reason=NULL,version=version+1")
      .run();
    await failedToStart.collaborator.sweep();
    assert.equal(failedToStart.row().state, "running");
    assert.equal(failedToStart.runner.starts.length, 2);
  } finally {
    failedToStart.runtime.close();
    failedToStart.store.close();
  }
});

test("a pause committed during workspace creation fences the verify supervisor spawn", async () => {
  const fixture = await attemptFixture("pause-during-workspace", "starting");
  try {
    fixture.workspace.onCreate = () => {
      fixture.store.db.prepare("UPDATE board_pause SET paused=1,reason='maintenance',version=version+1")
        .run();
    };

    await fixture.collaborator.sweep();
    assert.equal(fixture.row().state, "starting");
    assert.deepEqual(fixture.runner.starts, []);
    assert.deepEqual(fixture.workspace.removed, [`${fixture.workItem.workItemId}-verify`]);

    fixture.workspace.onCreate = null;
    fixture.store.db.prepare("UPDATE board_pause SET paused=0,reason=NULL,version=version+1")
      .run();
    await fixture.collaborator.sweep();
    assert.equal(fixture.row().state, "running");
    assert.equal(fixture.runner.starts.length, 1);
  } finally {
    fixture.runtime.close();
    fixture.store.close();
  }
});

test("verify start failures are redacted before attempt detail and machine evidence", async () => {
  const antToken = `sk-ant-${"e".repeat(48)}`;
  const bearerToken = `start-${"f".repeat(48)}`;
  const fixture = await attemptFixture("redacted-start", "starting");
  try {
    fixture.runner.startErrors.push(
      new Error(`spawn rejected ${antToken}`),
      new Error(`Authorization: Bearer ${bearerToken}`),
    );

    await fixture.collaborator.sweep();
    assert.match(String(fixture.row().detail), /\[redacted:token\]/u);
    assert.doesNotMatch(String(fixture.row().detail), new RegExp(antToken, "u"));

    await fixture.collaborator.sweep();
    const detail = String(fixture.row().detail);
    assert.match(detail, /\[redacted:bearer\]/u);
    assert.doesNotMatch(detail, new RegExp(bearerToken, "u"));
    assert.match(fixture.settlements[0]?.evidence.summary ?? "", /\[redacted:bearer\]/u);
    assert.doesNotMatch(JSON.stringify(fixture.settlements[0]?.evidence), new RegExp(bearerToken, "u"));
  } finally {
    fixture.runtime.close();
    fixture.store.close();
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

test("a third machine-verify failure dead-letters the scope holder and immediately activates its sibling", async () => {
  let now = new Date("2026-08-19T12:00:00.000Z");
  const baseSha = "a".repeat(40);
  const fixture = await boardFixture(undefined, () => now, { git: () => baseSha });
  let closed = false;
  try {
    const implementationType = {
      agentTypeId: "verify-scope-release-implementation",
      name: "Verify scope release implementation",
      description: "Runs implementation while testing uses machine verify.",
      role: "engineer" as const,
      supplementalInstructions: "Preserve the declared scope ordering.",
      skillIds: [],
      evaluatorProfile: "tests" as const,
      enabled: true,
    };
    const verificationType = {
      ...implementationType,
      agentTypeId: "verify-scope-release-verification",
      name: "Verify scope release verification",
      role: "verifier" as const,
    };
    fixture.board.updateAutomationConfiguration(automationConfigurationRequest({
      agentTypes: [implementationType, verificationType],
      stages: automationStages({
        implementation: { kind: "agent_type", agentTypeId: implementationType.agentTypeId },
        testing: { kind: "machine_verify" },
        verification: { kind: "agent_type", agentTypeId: verificationType.agentTypeId },
      }),
    }));
    fixture.board.createAgent(fixture.project.projectId, {
      agentId: "verify-scope-release-second-engineer",
      role: "engineer",
      area: "scope-release",
      mission: "Activate the held sibling without a reconciliation timer.",
      model: "codex-mini",
      token: "verify-scope-release-second-engineer-token-0123456789",
    });

    const propose = (suffix: string) => {
      const workItem = fixture.board.createWorkItemAndStartPlanning(workItemRequest({
        originalRequest: `Machine verify scope holder ${suffix}.`,
        projectTarget: { mode: "explicit", projectId: fixture.project.projectId },
      }), `verify-scope-release-${suffix}`).workItem;
      const planning = fixture.board.claimRun(fixture.manager.agentId, {
        claimId: `verify-scope-release-planning-${suffix}`,
        messageCursor: null,
      });
      assert.ok(planning);
      fixture.board.settleRun(planning.run.runId, fixture.manager.agentId, {
        outcome: "completed",
        result: "The overlapping pipeline plan is ready.",
        workflowPlan: heldVerifyPlan(suffix),
      });
      const plan = fixture.board.projectWorkflow(fixture.project.projectId).plans.find(
        (candidate) => candidate.workItemId === workItem.workItemId && candidate.state === "proposed",
      );
      assert.ok(plan);
      return { plan, workItem };
    };

    const holder = propose("holder");
    fixture.board.confirmWorkflow(holder.plan.planRevisionId, { expectedState: "proposed" });
    now = new Date("2026-08-19T12:00:01.000Z");
    const held = propose("held");
    fixture.board.confirmWorkflow(held.plan.planRevisionId, { expectedState: "proposed" });
    const before = fixture.board.projectWorkflow(fixture.project.projectId);
    const holderNode = before.nodes.find((node) => node.planRevisionId === holder.plan.planRevisionId);
    const heldNode = before.nodes.find((node) => node.planRevisionId === held.plan.planRevisionId);
    assert.equal(holderNode?.state, "active");
    assert.equal(heldNode?.state, "blocked");
    fixture.board.close();
    closed = true;

    const boardConfig = config(fixture.path, () => now);
    const store = await TaskBoardStore.open(boardConfig.dbPath);
    const runtime = new TaskBoardRuntime(boardConfig, store);
    registerParentTerminationCascade(store, () => undefined);
    const automation = new AutomationCollaborator(runtime);
    const tasks = new TasksCollaborator(runtime);
    assert.ok(holderNode);
    assert.ok(heldNode);
    store.transaction(() => {
      store.db.prepare(`
        UPDATE work_items SET state='verifying',current_stage='testing',version=version+1
        WHERE work_item_id=?
      `).run(holder.workItem.workItemId);
      store.db.prepare(`
        UPDATE work_nodes SET state='active',current_stage='testing',version=version+1,updated_at=?
        WHERE node_id=?
      `).run(now.toISOString(), holderNode.nodeId);
      const insert = store.db.prepare(`
        INSERT INTO verify_attempts(
          verify_attempt_id,node_id,stage,attempt,verify_run_id,workspace_path,state,
          check_results_json,detail,created_at,ended_at
        ) VALUES (?,?,'testing',?,?,?,?,'[]',?,?,?)
      `);
      insert.run(
        "verify-scope-release-prior-failed",
        holderNode.nodeId,
        1,
        null,
        null,
        "failed",
        "prior verify failure",
        "2026-08-19T11:00:00.000Z",
        "2026-08-19T11:01:00.000Z",
      );
      insert.run(
        "verify-scope-release-prior-died",
        holderNode.nodeId,
        3,
        null,
        null,
        "died",
        "prior verify death",
        "2026-08-19T11:30:00.000Z",
        "2026-08-19T11:31:00.000Z",
      );
      insert.run(
        "verify-scope-release-current",
        holderNode.nodeId,
        5,
        "verify-scope-release-run",
        "/tmp/verify-scope-release-workspace",
        "running",
        null,
        now.toISOString(),
        null,
      );
    });
    const projects = new ProjectsCollaborator(
      runtime,
      automation,
      tasks,
      () => baseSha,
      {
        workspaceManagerFactory: () => ({
          create: async () => "/tmp/verify-scope-release-workspace",
          remove: async () => undefined,
          retain: async () => undefined,
        }),
        runnerFactory: () => ({
          startFull: async () => "unused-verify-run",
          terminate: async () => undefined,
          status: async () => ({
            id: "verify-scope-release-run",
            state: "failed",
            startedAt: "2026-08-19T12:00:00.000Z",
            endedAt: now.toISOString(),
            exitCode: 1,
            command: "npm test",
          }),
          tail: async () => "third verify failure",
        }),
      },
    );
    try {
      assert.equal(await projects.sweepVerifyAttempts(), 1);
      assert.equal(runtime.requireWorkItem(holder.workItem.workItemId).state, "dead_letter");
      const after = projects.projectWorkflow(fixture.project.projectId);
      assert.equal(after.nodes.find((node) => node.nodeId === heldNode.nodeId)?.state, "active");
    } finally {
      projects.close();
      runtime.close();
      store.close();
    }
  } finally {
    if (!closed) fixture.board.close();
  }
});
