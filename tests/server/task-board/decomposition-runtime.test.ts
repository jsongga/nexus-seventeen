import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import type {
  ChildWorkItem,
  DeclaredChild,
  DesignRecordDraft,
  SettleRunRequest,
  WorkItem,
} from "#shared/task-board-contract";
import { DESIGN_FAILURE_POINTS, MAX_AGENT_CONTEXT_BYTES, MAX_DESIGN_CONTEXT_BYTES } from "#shared/task-board-contract";
import { TaskBoard, TaskBoardError } from "#server/task-board";
import { VerifyRunner } from "#server/agents/verify";
import { TaskWorkspaceManager } from "#server/agents/task-workspace";
import { agentPrompt } from "#server/agents/task-worker/agent-envelope";
import { HttpTaskBoardClient, mapClaimContext } from "#server/agents/task-worker/http-board-client";
import { PromptRegistry } from "#server/agents/task-worker/prompt-registry";
import { parseBoundedAgentContext } from "#server/agents/task-worker/schema";
import { TaskBoardRuntime } from "#server/task-board/collaborators/runtime";
import { DEFAULT_SUPERVISOR_PATH } from "#server/task-board/collaborators/verify-attempts";
import { transitionWorkItemInTransaction } from "#server/task-board/persistence/work-item-transitions";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import { parseClaimRunResult } from "#shared/task-board-contract/validate";
import {
  automationConfigurationRequest,
  automationStages,
  boardFixture,
  config,
  gateActions,
  latestParkRecord,
  pointProjectAtRepository,
  taskRequest,
  workItemRequest,
} from "./helpers.js";

const BASE_SHA = "1".repeat(40);
const ADVANCED_SHA = "2".repeat(40);
const CONSUMER_BASE_SHA = "3".repeat(40);
const VERIFIED_SHAS = ["a".repeat(40), "b".repeat(40), "c".repeat(40)] as const;
const MERGE_SHAS = ["d".repeat(40), "e".repeat(40), "f".repeat(40)] as const;
const NOW = "2026-08-29T14:00:00.000Z";
const PROMPTS = PromptRegistry.loadSync(resolve("config/prompts.md"));
const execFileAsync = promisify(execFile);

function staticCleanFanOutInspection(arguments_: readonly string[], head = BASE_SHA): string | null {
  if (arguments_.includes("--abbrev-ref")) return "main\n";
  if (arguments_.includes("--porcelain")) return "";
  if (arguments_.includes("rev-parse") && arguments_.at(-1) === "HEAD") return `${head}\n`;
  return null;
}

const IMPLEMENTER = {
  agentTypeId: "decomposition-runtime-implementer",
  name: "Decomposition runtime implementer",
  description: "Implements independently mergeable decomposition children.",
  role: "engineer" as const,
  supplementalInstructions: "Implement only the declared child scope.",
  skillIds: [],
  evaluatorProfile: "tests" as const,
  enabled: true,
};

const REVIEWER = {
  ...IMPLEMENTER,
  agentTypeId: "decomposition-runtime-reviewer",
  name: "Decomposition runtime reviewer",
  role: "verifier" as const,
};

function configureChildPipeline(board: TaskBoard): void {
  const current = board.getAutomationConfiguration();
  board.updateAutomationConfiguration(
    automationConfigurationRequest({
      version: current.version,
      agentTypes: [IMPLEMENTER, REVIEWER],
      stages: automationStages({
        implementation: { kind: "agent_type", agentTypeId: IMPLEMENTER.agentTypeId },
        testing: { kind: "machine_verify" },
        verification: { kind: "agent_type", agentTypeId: REVIEWER.agentTypeId },
      }),
    })
  );
}

function proposeParent(
  board: TaskBoard,
  projectId: string,
  children: readonly DeclaredChild[],
  suffix: string,
  changeShape: "feature" | "blast_radius" = "feature",
  tier: "standard" | "hazardous" = "standard",
  skillIds: readonly string[] = []
) {
  configureChildPipeline(board);
  const parent = board.createWorkItem(
    workItemRequest({
      originalRequest: `Coordinate decomposition runtime ${suffix}.`,
      projectTarget: { mode: "explicit", projectId },
    }),
    `decomposition-runtime-${suffix}`
  ).workItem;
  const workflow = board.proposeWorkflow({
    workItemId: parent.workItemId,
    projectId,
    objective: `Coordinate ${suffix} children.`,
    assumptions: [],
    acceptanceCriteria: ["Every child reaches its governed merge outcome."],
    changeShape,
    tier,
    declaredScope: ["coordination"],
    children,
    skillIds,
    nodes: [
      {
        nodeId: `parent-${suffix}`,
        title: `Coordinate ${suffix}`,
        objective: `Coordinate ${suffix}.`,
        acceptanceCriteria: ["The parent records child completion."],
        dependencyNodeIds: [],
        stageTemplate: ["verification"],
      },
    ],
  });
  const revision = workflow.plans.find((candidate) => candidate.workItemId === parent.workItemId);
  assert.ok(revision);
  board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
  return { parent, revision, children: board.listChildren(parent.workItemId) };
}

function proposeStandalonePipeline(
  board: TaskBoard,
  projectId: string,
  declaredScope: readonly string[],
  suffix: string
): WorkItem {
  configureChildPipeline(board);
  const workItem = board.createWorkItem(
    workItemRequest({
      originalRequest: `Run standalone decomposition regression ${suffix}.`,
      projectTarget: { mode: "explicit", projectId },
    }),
    `decomposition-standalone-${suffix}`
  ).workItem;
  const workflow = board.proposeWorkflow({
    workItemId: workItem.workItemId,
    projectId,
    objective: `Run standalone ${suffix}.`,
    assumptions: [],
    acceptanceCriteria: ["The pipeline activates when its overlapping predecessor releases scope."],
    changeShape: "feature",
    tier: "standard",
    declaredScope,
    skillIds: [],
    nodes: [
      {
        nodeId: `standalone-${suffix}`,
        title: `Standalone ${suffix}`,
        objective: `Run standalone ${suffix}.`,
        acceptanceCriteria: ["The pipeline activates after scope release."],
        dependencyNodeIds: [],
        stageTemplate: ["implementation", "testing", "verification"],
      },
    ],
  });
  const revision = workflow.plans.find((candidate) => candidate.workItemId === workItem.workItemId);
  assert.ok(revision);
  board.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
  return board.requireWorkItem(workItem.workItemId);
}

function phasedChildren(
  providerProjectId: string,
  consumerProjectId: string,
  suffix: string
): readonly DeclaredChild[] {
  return [
    {
      key: "expand",
      objective: `Expand the provider interface for ${suffix}.`,
      projectId: providerProjectId,
      declaredScope: [`src/${suffix}-expand`, "docs/interface.md"],
      acceptanceCriteria: ["The expansion is independently mergeable."],
      phase: "expand",
      splitBy: "phase",
    },
    {
      key: "migrate",
      objective: `Migrate the consumer interface for ${suffix}.`,
      projectId: consumerProjectId,
      declaredScope: [`src/${suffix}-migrate`],
      acceptanceCriteria: ["The migration waits for expansion."],
      phase: "migrate",
      splitBy: "consumer",
      dependsOn: ["expand"],
    },
    {
      key: "contract",
      objective: `Contract the provider interface for ${suffix}.`,
      projectId: providerProjectId,
      declaredScope: [`src/${suffix}-contract`, "docs/interface.md"],
      acceptanceCriteria: ["The contraction waits for migration."],
      phase: "contract",
      splitBy: "phase",
      dependsOn: ["migrate"],
    },
  ];
}

function childNode(board: TaskBoard, child: WorkItem) {
  assert.ok(child.resolvedProjectId);
  const workflow = board.projectWorkflow(child.resolvedProjectId);
  const plan = workflow.plans.find((candidate) => candidate.workItemId === child.workItemId);
  assert.ok(plan);
  const node = workflow.nodes.find((candidate) => candidate.planRevisionId === plan.planRevisionId);
  assert.ok(node);
  return { node, plan };
}

function forceMergedWithApproval(path: string, workItemId: string, mergeSha: string): void {
  const db = new DatabaseSync(path);
  try {
    const plan = db
      .prepare(
        `
      SELECT plan_revision_id
      FROM plan_revisions
      WHERE work_item_id=? AND state='confirmed'
      ORDER BY revision DESC
      LIMIT 1
    `
      )
      .get(workItemId);
    assert.ok(plan);
    db.prepare(
      `
      UPDATE work_items
      SET state='merged',current_stage=NULL,ended_at=?,version=version+1,updated_at=?
      WHERE work_item_id=?
    `
    ).run(NOW, NOW, workItemId);
    db.prepare(
      `
      INSERT INTO gate_actions(
        gate_action_id,work_item_id,gate,actor_id,plan_revision_id,
        verified_sha,merge_sha,ref_id,note,created_at
      ) VALUES(?,?,'final_approve','human:alice',?,NULL,?,NULL,NULL,?)
    `
    ).run(`forced-final-${workItemId}`, workItemId, String(plan.plan_revision_id), mergeSha, NOW);
  } finally {
    db.close();
  }
}

function forceParentFinalApproval(path: string, workItemId: string): number {
  const db = new DatabaseSync(path);
  try {
    db.prepare(
      `
      UPDATE work_items
      SET state='final_approval',current_stage=NULL,version=version+1,updated_at=?
      WHERE work_item_id=?
    `
    ).run(NOW, workItemId);
    return Number(db.prepare("SELECT version FROM work_items WHERE work_item_id=?").get(workItemId)?.version);
  } finally {
    db.close();
  }
}

function forceFinalApproval(path: string, workItemId: string, verifiedSha: string): number {
  const db = new DatabaseSync(path);
  try {
    const row = db
      .prepare(
        `
      SELECT node.node_id
      FROM plan_revisions plan
      JOIN work_nodes node ON node.plan_revision_id=plan.plan_revision_id
      WHERE plan.work_item_id=? AND plan.state='confirmed'
      LIMIT 1
    `
      )
      .get(workItemId);
    assert.ok(row);
    const attempt =
      Number(
        db
          .prepare(
            `
      SELECT COUNT(*) AS count
      FROM verify_attempts
      WHERE node_id=?
    `
          )
          .get(String(row.node_id))?.count
      ) + 1;
    db.prepare(
      `
      INSERT INTO verify_attempts(
        verify_attempt_id,node_id,stage,attempt,verify_run_id,workspace_path,state,
        check_results_json,detail,created_at,ended_at
      ) VALUES(?,?,'testing',?, ?,NULL,'green','[]',?,?,?)
    `
    ).run(
      `verify-${workItemId}-${attempt}`,
      String(row.node_id),
      attempt,
      `verify-run-${workItemId}-${attempt}`,
      `verified-sha:${verifiedSha}`,
      NOW,
      NOW
    );
    db.prepare(
      `
      UPDATE work_nodes
      SET state='completed',current_stage=NULL,version=version+1,updated_at=?
      WHERE node_id=?
    `
    ).run(NOW, String(row.node_id));
    db.prepare(
      `
      UPDATE work_items
      SET state='final_approval',current_stage=NULL,ended_at=NULL,version=version+1,updated_at=?
      WHERE work_item_id=?
    `
    ).run(NOW, workItemId);
    return Number(db.prepare("SELECT version FROM work_items WHERE work_item_id=?").get(workItemId)?.version);
  } finally {
    db.close();
  }
}

function hazardousDesignRecord(): DesignRecordDraft {
  return {
    states: ["pending", "committed", "unknown"],
    transitions: [
      {
        from: "pending",
        to: "committed",
        durablePrecondition: "Persist the child intent before the side effect.",
        recovery: "Resume from the durable child intent.",
      },
    ],
    failurePoints: DESIGN_FAILURE_POINTS.map((point) => ({
      point,
      resultingState: `durable child state after ${point}`,
      recovery: `recover the child after ${point}`,
    })),
    idempotencyKeys: [
      {
        name: "child-operation-key",
        generatedAt: "Before the first side effect.",
        persistedAt: "With the durable child intent.",
        reuse: "Reuse for every retry.",
      },
    ],
    faultInjectionCases: [
      {
        name: "Crash after child commit",
        scenario: "Terminate after the commit and before acknowledgement.",
        expectation: "The retry observes the committed child result.",
      },
    ],
  };
}

function latestNodeBlock(path: string, nodeId: string): string | null {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare(
        `
      SELECT summary
      FROM project_events
      WHERE node_id=? AND event_type='node_blocked'
      ORDER BY sequence DESC
      LIMIT 1
    `
      )
      .get(nodeId);
    return row === undefined ? null : String(row.summary);
  } finally {
    db.close();
  }
}

async function git(repoPath: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...arguments_], { cwd: repoPath, encoding: "utf8" });
  return result.stdout;
}

async function pipelineRepository(suffix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `decomposition-interface-${suffix}-`));
  const repoPath = join(root, "repo");
  await mkdir(join(repoPath, "docs"), { recursive: true });
  await git(root, ["init", "-b", "main", repoPath]);
  await writeFile(join(repoPath, "seed.txt"), `${suffix} seed\n`, "utf8");
  await writeFile(join(repoPath, "verify.mjs"), "process.exit(0);\n", "utf8");
  await writeFile(
    join(repoPath, "docs/workflow.md"),
    `# Verify workflow\n\n\`\`\`json\n${JSON.stringify(
      {
        version: 1,
        compile: ["node verify.mjs"],
        rules: [{ match: "**", action: { kind: "none" } }],
        full: ["node verify.mjs"],
      },
      null,
      2
    )}\n\`\`\`\n`,
    "utf8"
  );
  await git(repoPath, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "."]);
  await git(repoPath, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "seed"]);
  return repoPath;
}

async function waitForQueuedRoleTask(
  board: TaskBoard,
  projectId: string,
  role: "engineer" | "manager" | "verifier"
): Promise<NonNullable<ReturnType<TaskBoard["snapshot"]>["tasks"][number]>> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await board.sweepVerifyAttempts();
    const task = board
      .snapshot(projectId)
      .tasks.find((candidate) => candidate.status === "queued" && candidate.assignedRole === role);
    if (task !== undefined) return task;
    await delay(25);
  }
  assert.fail(`no queued ${role} task appeared for ${projectId}`);
}

type InterfaceGitOperation = "ls-tree" | "cat-file" | "show";

function crossRepoGit(readInterface: (operation: InterfaceGitOperation, sha: string) => string | Buffer) {
  const run = (arguments_: readonly string[]): string | Buffer => {
    const target = arguments_.at(-1) ?? "";
    if (arguments_.includes("ls-tree") && target === "docs/interface.md") {
      return readInterface("ls-tree", arguments_[arguments_.indexOf("-z") + 1] ?? "");
    }
    if (arguments_.includes("cat-file") && arguments_.includes("-s") && target.endsWith(":docs/interface.md")) {
      return readInterface("cat-file", target.slice(0, -":docs/interface.md".length));
    }
    if (arguments_.includes("show") && target.endsWith(":docs/interface.md")) {
      return readInterface("show", target.slice(0, -":docs/interface.md".length));
    }
    if (arguments_.includes("--abbrev-ref")) return "main\n";
    if (arguments_.includes("--porcelain")) return "";
    if (arguments_.includes("merge-base")) return "";
    if (arguments_.includes("diff") || arguments_.includes("log")) return "";
    if (arguments_.some((argument) => argument.endsWith("^{commit}"))) return `${VERIFIED_SHAS[0]}\n`;
    const repositoryIndex = arguments_.indexOf("-C");
    const repository = repositoryIndex < 0 ? null : arguments_[repositoryIndex + 1];
    return `${repository === "/repos/claim-consumer" ? CONSUMER_BASE_SHA : BASE_SHA}\n`;
  };
  const text = (arguments_: readonly string[]): string => {
    const result = run(arguments_);
    return typeof result === "string" ? result : result.toString("utf8");
  };
  return Object.assign(text, {
    bytes: (arguments_: readonly string[]): Buffer => {
      const result = run(arguments_);
      return typeof result === "string" ? Buffer.from(result, "utf8") : result;
    },
  });
}

async function migrateReadinessFixture(
  suffix: string,
  readInterface: (operation: InterfaceGitOperation, sha: string) => string | Buffer,
  skillIds: readonly string[] = []
) {
  const fixture = await boardFixture(undefined, undefined, {
    git: crossRepoGit(readInterface),
    mergePipeline: () => ({ kind: "merged", mergeSha: MERGE_SHAS[0] }),
  });
  const provider = fixture.board.createProject({
    name: `Readiness provider ${suffix}`,
    description: "Publishes the interface consumed by Migrate.",
    repoPath: "/repos/claim-provider",
  });
  const consumer = fixture.board.createProject({
    name: `Readiness consumer ${suffix}`,
    description: "Consumes the published provider interface.",
    repoPath: "/repos/claim-consumer",
  });
  const decomposition = proposeParent(
    fixture.board,
    provider.projectId,
    phasedChildren(provider.projectId, consumer.projectId, suffix),
    suffix,
    "blast_radius",
    "standard",
    skillIds
  );
  const [expand, migrate] = decomposition.children;
  assert.ok(expand);
  assert.ok(migrate);
  forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);
  fixture.board.reconcileWorkflows(provider.projectId);
  return Object.freeze({ ...fixture, provider, consumer, expand, migrate });
}

function preparePhaseVerificationClaim(
  fixture: Awaited<ReturnType<typeof boardFixture>>,
  projectId: string,
  workItem: WorkItem,
  label: string,
  attempt = 1
) {
  const { node } = childNode(fixture.board, workItem);
  const verifier = fixture.board.createAgent(projectId, {
    agentId: `${label}-verifier`,
    role: "verifier",
    area: `${label} verification`,
    mission: `Independently verify ${label}.`,
    model: "test-model",
    token: `${label}-verification-token-0123456789abcdef`,
  });
  const task = fixture.board.createTask(
    projectId,
    taskRequest({
      title: `verification: ${label}`,
      objective: `Verify ${label}.`,
      acceptanceCriteria: `The ${label} result is independently verified.`,
      workspaceRefs: [],
      assignedAgentId: verifier.agentId,
      assignedRole: "verifier",
      requiresReview: false,
    })
  );
  const db = new DatabaseSync(fixture.path);
  try {
    db.prepare(
      `
      UPDATE work_nodes SET state='active',current_stage='verification',updated_at=? WHERE node_id=?
    `
    ).run(NOW, node.nodeId);
    db.prepare(
      `
      UPDATE work_items SET state='reviewing',current_stage='verification',updated_at=? WHERE work_item_id=?
    `
    ).run(NOW, workItem.workItemId);
    db.prepare(
      `
      INSERT INTO stage_attempts(attempt_id,node_id,task_id,stage,attempt,skill_digests_json)
      VALUES(?,?,?,'verification',?,'{}')
    `
    ).run(`${label}-verification-attempt`, node.nodeId, task.taskId, attempt);
    db.prepare(
      `
      INSERT INTO verify_attempts(
        verify_attempt_id,node_id,stage,attempt,verify_run_id,workspace_path,state,
        check_results_json,detail,created_at,ended_at
      ) VALUES(?,?,'testing',?, ?,NULL,'green','[]',?,?,?)
    `
    ).run(
      `${label}-green-verification`,
      node.nodeId,
      attempt,
      `${label}-verify-run`,
      `verified-sha:${VERIFIED_SHAS[0]}`,
      NOW,
      NOW
    );
  } finally {
    db.close();
  }
  const claim = fixture.board.claimRun(verifier.agentId, {
    claimId: `claim-${label}-verification`,
    messageCursor: null,
  });
  assert.ok(claim);
  return Object.freeze({ claim, task, verifier });
}

function latestTransitionActor(
  path: string,
  workItemId: string
): Readonly<{
  actorType: string;
  actorId: string;
}> | null {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare(
        `
      SELECT actor_type,actor_id
      FROM work_item_transitions
      WHERE work_item_id=?
      ORDER BY sequence DESC
      LIMIT 1
    `
      )
      .get(workItemId);
    return row === undefined
      ? null
      : Object.freeze({
          actorType: String(row.actor_type),
          actorId: String(row.actor_id),
        });
  } finally {
    db.close();
  }
}

test("unphased dependencies order merges without blocking parallel child activation", async () => {
  const verifiedByBranch = new Map<string, string>();
  const mergeOrder: string[] = [];
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      const inspection = staticCleanFanOutInspection(arguments_);
      if (inspection !== null) return inspection;
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline(request) {
      mergeOrder.push(request.branch.slice("task/".length));
      return { kind: "merged", mergeSha: MERGE_SHAS[mergeOrder.length - 1]! };
    },
  });
  const declared: readonly DeclaredChild[] = [
    {
      key: "first",
      objective: "Merge the first child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/first"],
      acceptanceCriteria: ["The first child merges."],
    },
    {
      key: "second",
      objective: "Start in parallel but merge after the first child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/second"],
      acceptanceCriteria: ["The second child starts immediately and merges second."],
      dependsOn: ["first"],
    },
  ];

  try {
    const decomposition = proposeParent(fixture.board, fixture.project.projectId, declared, "dependency-readiness");
    const [first, second] = decomposition.children;
    assert.ok(first);
    assert.ok(second);
    assert.equal(fixture.board.requireWorkItem(first.workItemId).state, "implementing");
    assert.equal(fixture.board.requireWorkItem(second.workItemId).state, "implementing");
    assert.equal(childNode(fixture.board, first).node.state, "active");
    assert.equal(childNode(fixture.board, second).node.state, "active");

    for (const [index, child] of [first, second].entries()) {
      verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[index]!);
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const parent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(parent.state, "final_approval");
    const settled = await fixture.board.approvePipelineMerge(parent.workItemId, { version: parent.version });
    assert.equal(settled.state, "merged");
    assert.deepEqual(mergeOrder, [first.workItemId, second.workItemId]);
  } finally {
    fixture.board.close();
  }
});

test("confirm activates children in another project through the parent project's scoped pass", async () => {
  const fixture = await boardFixture(
    undefined,
    undefined,
    { git: () => `${BASE_SHA}\n` },
    { reconcileIntervalSeconds: 0 }
  );
  try {
    const childProject = fixture.board.createProject({
      name: "Cross-project child owner",
      description: "Owns every child while the decomposition parent stays in the intake project.",
      repoPath: "/repos/cross-project-child-owner",
    });

    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "remote-one",
          objective: "Activate the first remote child during confirmation.",
          projectId: childProject.projectId,
          declaredScope: ["src/remote-one"],
          acceptanceCriteria: ["The first remote child starts without a timer."],
        },
        {
          key: "remote-two",
          objective: "Activate the second remote child during confirmation.",
          projectId: childProject.projectId,
          declaredScope: ["src/remote-two"],
          acceptanceCriteria: ["The second remote child starts without a timer."],
        },
      ],
      "parent-project-confirm-pass"
    );

    assert.equal(
      fixture.board.requireWorkItem(decomposition.parent.workItemId).resolvedProjectId,
      fixture.project.projectId
    );
    assert.ok(decomposition.children.every((child) => child.resolvedProjectId === childProject.projectId));
    assert.deepEqual(
      decomposition.children.map((child) => fixture.board.requireWorkItem(child.workItemId).state),
      ["implementing", "implementing"]
    );
    assert.ok(decomposition.children.every((child) => childNode(fixture.board, child).node.state === "active"));
  } finally {
    fixture.board.close();
  }
});

test("unphased child activation keeps its confirmation-time base when the default branch moves", async () => {
  let headReads = 0;
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      if (arguments_.includes("rev-parse") && arguments_.at(-1) === "HEAD") {
        headReads += 1;
        return `${headReads === 1 ? BASE_SHA : ADVANCED_SHA}\n`;
      }
      throw new Error(`unexpected git command: ${arguments_.join(" ")}`);
    },
  });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "unphased-moving-head",
          objective: "Keep the confirmation-time base for an unphased child.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/unphased-moving-head"],
          acceptanceCriteria: ["Activation does not refresh an unphased base."],
        },
      ],
      "unphased-moving-head"
    );
    const [child] = decomposition.children;
    assert.ok(child);
    assert.equal(headReads, 1);
    assert.equal(fixture.board.requireWorkItem(child.workItemId).baseSha, BASE_SHA);
  } finally {
    fixture.board.close();
  }
});

test("a ready hazardous child enters the ordinary Design stage while implementation stays pending", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "hazardous-child",
          objective: "Design and implement the hazardous child.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/hazardous"],
          acceptanceCriteria: ["The hazardous child follows Design."],
          splitBy: "consumer",
        },
      ],
      "hazardous-readiness",
      "blast_radius",
      "hazardous"
    );
    const [child] = decomposition.children;
    assert.ok(child);
    assert.equal(fixture.board.requireWorkItem(child.workItemId).state, "designing");
    const node = childNode(fixture.board, child).node;
    assert.equal(node.state, "pending");
    assert.equal(node.currentStage, null);
    const db = new DatabaseSync(fixture.path);
    try {
      assert.equal(
        Number(
          db
            .prepare(
              `
        SELECT COUNT(*) AS count
        FROM work_item_design_tasks
        WHERE work_item_id=?
      `
            )
            .get(child.workItemId)?.count
        ),
        1
      );
      assert.equal(
        Number(
          db
            .prepare(
              `
        SELECT COUNT(*) AS count
        FROM stage_attempts
        WHERE node_id=? AND stage='implementation'
      `
            )
            .get(node.nodeId)?.count
        ),
        0
      );
      db.prepare(
        `
        UPDATE tasks
        SET status='cancelled',started_at=COALESCE(started_at,?),ended_at=?,result='Superseded by direct test proposal',
          version=version+1,updated_at=?
        WHERE task_id IN (
          SELECT task_id FROM work_item_planning_tasks WHERE work_item_id=?
        ) AND ended_at IS NULL
      `
      ).run(NOW, NOW, NOW, decomposition.parent.workItemId);
    } finally {
      db.close();
    }
    const designClaim = fixture.board.claimRun(fixture.manager.agentId, {
      claimId: "claim-hazardous-decomposition-design",
      messageCursor: null,
    });
    assert.ok(designClaim?.task);
    assert.equal(designClaim.context.design, true);
    fixture.board.settleRun(designClaim.run.runId, fixture.manager.agentId, {
      outcome: "completed",
      result: "The hazardous child design is confirmed.",
      designRecord: hazardousDesignRecord(),
    });
    assert.equal(fixture.board.requireWorkItem(child.workItemId).state, "implementing");
    const activated = childNode(fixture.board, child).node;
    assert.equal(activated.state, "active");
    assert.equal(activated.currentStage, "implementation");
  } finally {
    fixture.board.close();
  }
});

test("feature parent approval merges children in dependency order and settles parent audit", async () => {
  const verifiedByBranch = new Map<string, string>();
  const mergeOrder: string[] = [];
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      const inspection = staticCleanFanOutInspection(arguments_);
      if (inspection !== null) return inspection;
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline(request) {
      const workItemId = request.branch.slice("task/".length);
      mergeOrder.push(workItemId);
      const index = mergeOrder.length - 1;
      return { kind: "merged", mergeSha: MERGE_SHAS[index]! };
    },
  });
  const declared: readonly DeclaredChild[] = [
    {
      key: "dependent",
      objective: "Merge after the provider child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/dependent"],
      acceptanceCriteria: ["The dependent merges second."],
      dependsOn: ["provider"],
    },
    {
      key: "provider",
      objective: "Merge before the dependent child.",
      projectId: fixture.project.projectId,
      declaredScope: ["src/provider"],
      acceptanceCriteria: ["The provider merges first."],
    },
  ];

  try {
    const { parent, revision, children } = proposeParent(
      fixture.board,
      fixture.project.projectId,
      declared,
      "feature-parent-approval"
    );
    const [dependent, provider] = children;
    assert.ok(dependent);
    assert.ok(provider);
    for (const [index, child] of [provider, dependent].entries()) {
      verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[index]!);
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const readyParent = fixture.board.requireWorkItem(parent.workItemId);
    assert.equal(readyParent.state, "final_approval");
    const readyNotification = fixture.board
      .listNotifications()
      .unread.find((notification) => notification.kind === "parent_ready_for_approval");
    assert.ok(readyNotification);
    assert.match(readyNotification.dedupeKey ?? "", new RegExp(`^parent_ready_for_approval:${parent.workItemId}:`));

    const mergedParent = await fixture.board.approvePipelineMerge(parent.workItemId, {
      version: readyParent.version,
    });
    assert.equal(mergedParent.state, "merged");
    assert.deepEqual(mergeOrder, [provider.workItemId, dependent.workItemId]);
    assert.deepEqual(
      [provider, dependent]
        .map((child) => gateActions(fixture.path, child.workItemId).at(-1))
        .map((action) => ({
          gate: action?.gate,
          actorId: action?.actorId,
          mergeSha: action?.mergeSha,
        })),
      [
        { gate: "final_approve", actorId: "human:alice", mergeSha: MERGE_SHAS[0] },
        {
          gate: "final_approve",
          actorId: "human:alice",
          mergeSha: MERGE_SHAS[1],
        },
      ]
    );
    const parentApproval = gateActions(fixture.path, parent.workItemId).at(-1);
    assert.equal(parentApproval?.gate, "final_approve");
    assert.equal(parentApproval?.mergeSha, null);
    assert.equal(parentApproval?.refId, revision.planRevisionId);
    assert.equal(parentApproval?.note, "2 children merged, 0 abandoned");
    assert.deepEqual(latestTransitionActor(fixture.path, parent.workItemId), {
      actorType: "human",
      actorId: "human:alice",
    });
    assert.deepEqual(fixture.board.parentCompletion(parent.workItemId).children, [
      {
        workItemId: dependent.workItemId,
        mergeSha: MERGE_SHAS[1],
      },
      {
        workItemId: provider.workItemId,
        mergeSha: MERGE_SHAS[0],
      },
    ]);
  } finally {
    fixture.board.close();
  }
});

test("same-repository fan-out withdraws a later sibling after the first merge advances its base", async () => {
  const verifiedByBranch = new Map<string, string>();
  const heads = new Map<string, string>();
  const mergeOrder: string[] = [];
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      const repoPath = arguments_[arguments_.indexOf("-C") + 1] ?? "";
      if (arguments_.includes("--abbrev-ref")) return "main\n";
      if (arguments_.includes("--porcelain")) return "";
      if (arguments_.includes("merge-base")) return "";
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      if (arguments_.includes("rev-parse") && arguments_.at(-1) === "HEAD") {
        return `${heads.get(repoPath) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline(request) {
      const childId = request.branch.slice("task/".length);
      mergeOrder.push(childId);
      const mergeSha = MERGE_SHAS[mergeOrder.length - 1]!;
      heads.set(request.repoPath, mergeSha);
      return { kind: "merged", mergeSha };
    },
  });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "same-repo-a",
          objective: "Merge the first same-repository child.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/same-repo-a"],
          acceptanceCriteria: ["The first child advances the repository base."],
        },
        {
          key: "same-repo-b",
          objective: "Re-verify the second child after its base advances.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/same-repo-b"],
          acceptanceCriteria: ["The stale second verification is never merged."],
          dependsOn: ["same-repo-a"],
        },
      ],
      "same-repository-fan-out"
    );
    const [first, second] = decomposition.children;
    assert.ok(first);
    assert.ok(second);
    for (const [index, child] of [first, second].entries()) {
      verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[index]!);
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const firstApproval = fixture.board.requireWorkItem(decomposition.parent.workItemId);

    const coordinating = await fixture.board.approvePipelineMerge(firstApproval.workItemId, {
      version: firstApproval.version,
    });

    assert.equal(coordinating.state, "coordinating");
    assert.equal(fixture.board.requireWorkItem(first.workItemId).state, "merged");
    const withdrawn = fixture.board.requireWorkItem(second.workItemId);
    assert.equal(withdrawn.state, "implementing");
    assert.equal(withdrawn.baseSha, MERGE_SHAS[0]);
    assert.deepEqual(mergeOrder, [first.workItemId]);
    assert.ok(
      fixture.board
        .listNotifications()
        .unread.some(
          (notification) =>
            notification.kind === "final_approval_withdrawn" &&
            notification.workItemId === second.workItemId &&
            notification.dedupeKey === `final_approval_withdrawn:${second.workItemId}:${MERGE_SHAS[0]}`
        )
    );

    verifiedByBranch.set(second.pipelineBranch!, VERIFIED_SHAS[2]);
    forceFinalApproval(fixture.path, second.workItemId, VERIFIED_SHAS[2]);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const secondApproval = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(secondApproval.state, "final_approval");
    const completed = await fixture.board.approvePipelineMerge(secondApproval.workItemId, {
      version: secondApproval.version,
    });
    assert.equal(completed.state, "merged");
    assert.deepEqual(mergeOrder, [first.workItemId, second.workItemId]);
    assert.equal(gateActions(fixture.path, completed.workItemId).at(-1)?.note, "2 children merged, 0 abandoned");
  } finally {
    fixture.board.close();
  }
});

test("cross-repository fan-out merges every ready sibling under one parent approval", async () => {
  const verifiedByBranch = new Map<string, string>();
  const heads = new Map<string, string>();
  const mergeOrder: string[] = [];
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      const repoPath = arguments_[arguments_.indexOf("-C") + 1] ?? "";
      if (arguments_.includes("--abbrev-ref")) return "main\n";
      if (arguments_.includes("--porcelain")) return "";
      if (arguments_.includes("merge-base")) return "";
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      if (arguments_.includes("rev-parse") && arguments_.at(-1) === "HEAD") {
        return `${heads.get(repoPath) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline(request) {
      const childId = request.branch.slice("task/".length);
      mergeOrder.push(childId);
      const mergeSha = MERGE_SHAS[mergeOrder.length - 1]!;
      heads.set(request.repoPath, mergeSha);
      return { kind: "merged", mergeSha };
    },
  });
  const secondProject = fixture.board.createProject({
    name: "Cross-repository sibling",
    description: "Owns the second independent feature child.",
    repoPath: "/repos/cross-repository-sibling",
  });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "cross-repo-a",
          objective: "Merge the first repository child.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/cross-repo-a"],
          acceptanceCriteria: ["The first repository merges."],
        },
        {
          key: "cross-repo-b",
          objective: "Merge the independent second repository child.",
          projectId: secondProject.projectId,
          declaredScope: ["src/cross-repo-b"],
          acceptanceCriteria: ["The second repository merges under the same approval."],
        },
      ],
      "cross-repository-fan-out"
    );
    for (const [index, child] of decomposition.children.entries()) {
      verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[index]!);
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const ready = fixture.board.requireWorkItem(decomposition.parent.workItemId);

    const completed = await fixture.board.approvePipelineMerge(ready.workItemId, { version: ready.version });

    assert.equal(completed.state, "merged");
    assert.deepEqual(
      mergeOrder,
      decomposition.children.map((child) => child.workItemId)
    );
  } finally {
    fixture.board.close();
  }
});

test("rejecting a promoted unphased parent fans rejection out and waits for child re-verification", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "reject-parent-one",
          objective: "Return through implementation when the parent approval is rejected.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/reject-parent-one"],
          acceptanceCriteria: ["The child is re-verified after parent rejection."],
        },
        {
          key: "reject-parent-two",
          objective: "Also return through implementation while coordination resumes.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/reject-parent-two"],
          acceptanceCriteria: ["The second child is re-verified."],
        },
      ],
      "reject-promoted-parent"
    );
    for (const [index, child] of decomposition.children.entries()) {
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const parent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(parent.state, "final_approval");
    const notificationsBefore = fixture.board
      .listNotifications()
      .unread.filter((notification) => notification.kind === "parent_ready_for_approval").length;
    const note = "Coordinate the parent outcome again.";

    const rejected = await fixture.board.rejectFinalApproval(parent.workItemId, {
      version: parent.version,
      note,
    });

    assert.equal(rejected.state, "coordinating");
    assert.deepEqual(
      fixture.board.listChildren(parent.workItemId).map((child) => child.state),
      ["fixing", "fixing"]
    );
    for (const child of decomposition.children) {
      const action = gateActions(fixture.path, child.workItemId).at(-1);
      assert.equal(action?.gate, "final_reject");
      assert.equal(action?.actorId, "human:alice");
      assert.equal(action?.note, note);
    }
    const action = gateActions(fixture.path, parent.workItemId).at(-1);
    assert.equal(action?.gate, "final_reject");
    assert.equal(action?.actorId, "human:alice");
    assert.equal(action?.note, note);

    fixture.board.reconcileWorkflows(fixture.project.projectId);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "coordinating");
    assert.equal(
      fixture.board
        .listNotifications()
        .unread.filter((notification) => notification.kind === "parent_ready_for_approval").length,
      notificationsBefore
    );

    for (const [index, child] of decomposition.children.entries()) {
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "final_approval");
    assert.equal(
      fixture.board
        .listNotifications()
        .unread.filter((notification) => notification.kind === "parent_ready_for_approval").length,
      notificationsBefore + 1
    );
  } finally {
    fixture.board.close();
  }
});

test("rejecting one promoted child withdraws and then re-promotes its parent once", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "direct-reject-one",
          objective: "Leave final approval through a direct child rejection.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/direct-reject-one"],
          acceptanceCriteria: ["The parent approval is withdrawn."],
        },
        {
          key: "direct-reject-two",
          objective: "Remain ready while the rejected sibling re-verifies.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/direct-reject-two"],
          acceptanceCriteria: ["The parent is promoted again after both children are ready."],
        },
      ],
      "direct-child-rejection"
    );
    for (const [index, child] of decomposition.children.entries()) {
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const promoted = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(promoted.state, "final_approval");
    const readyNotificationsBefore = fixture.board
      .listNotifications()
      .unread.filter(
        (notification) =>
          notification.kind === "parent_ready_for_approval" && notification.workItemId === promoted.workItemId
      ).length;
    const [rejectedChild] = decomposition.children;
    assert.ok(rejectedChild);

    const rejected = await fixture.board.rejectFinalApproval(rejectedChild.workItemId, {
      version: fixture.board.requireWorkItem(rejectedChild.workItemId).version,
      note: "Re-verify the directly rejected child.",
    });

    assert.equal(rejected.state, "fixing");
    const withdrawn = fixture.board.requireWorkItem(promoted.workItemId);
    assert.equal(withdrawn.state, "coordinating");
    assert.equal(withdrawn.version, promoted.version + 1);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(fixture.board.requireWorkItem(promoted.workItemId).state, "coordinating");
    assert.equal(
      fixture.board
        .listNotifications()
        .unread.filter(
          (notification) =>
            notification.kind === "parent_ready_for_approval" && notification.workItemId === promoted.workItemId
        ).length,
      readyNotificationsBefore
    );

    forceFinalApproval(fixture.path, rejectedChild.workItemId, VERIFIED_SHAS[2]);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const rePromoted = fixture.board.requireWorkItem(promoted.workItemId);
    assert.equal(rePromoted.state, "final_approval");
    assert.equal(rePromoted.version, withdrawn.version + 1);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(
      fixture.board
        .listNotifications()
        .unread.filter(
          (notification) =>
            notification.kind === "parent_ready_for_approval" && notification.workItemId === promoted.workItemId
        ).length,
      readyNotificationsBefore + 1
    );
  } finally {
    fixture.board.close();
  }
});

test("a branch-bearing item with children uses the leaf path for both approval decisions", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "predicate-child",
          objective: "Expose the decomposed-parent branch predicate.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/predicate-child"],
          acceptanceCriteria: ["Approval routing remains symmetric."],
        },
      ],
      "decomposed-parent-predicate"
    );
    const parentVersion = forceParentFinalApproval(fixture.path, decomposition.parent.workItemId);
    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare("UPDATE work_items SET pipeline_branch=?,base_sha=? WHERE work_item_id=?").run(
        `task/${decomposition.parent.workItemId}`,
        BASE_SHA,
        decomposition.parent.workItemId
      );
    } finally {
      db.close();
    }

    await assert.rejects(
      fixture.board.rejectFinalApproval(decomposition.parent.workItemId, {
        version: parentVersion,
        note: "Exercise leaf rejection routing.",
      }),
      /TASK_BOARD_DATABASE_CORRUPT:pipeline_implementation_stage_missing/u
    );
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "final_approval");
    assert.equal(
      gateActions(fixture.path, decomposition.parent.workItemId).some((action) => action.gate === "final_reject"),
      false
    );

    await assert.rejects(
      fixture.board.approvePipelineMerge(decomposition.parent.workItemId, { version: parentVersion }),
      (error: unknown) => error instanceof TaskBoardError && error.code === "TASK_BOARD_PIPELINE_BRANCH_MOVED"
    );
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "final_approval");
  } finally {
    fixture.board.close();
  }
});

test("a 64-child parent settles with bounded audit fields and derived child merge detail", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  const declared = Array.from(
    { length: 64 },
    (_, ordinal): DeclaredChild => ({
      key: `child-${ordinal}`,
      objective: `Complete child ${ordinal}.`,
      projectId: fixture.project.projectId,
      declaredScope: [`src/child-${ordinal}`],
      acceptanceCriteria: [`Child ${ordinal} merges.`],
    })
  );
  try {
    const { parent, revision, children } = proposeParent(
      fixture.board,
      fixture.project.projectId,
      declared,
      "maximum-parent-completion"
    );
    for (const child of children) forceMergedWithApproval(fixture.path, child.workItemId, MERGE_SHAS[0]);
    const parentVersion = forceParentFinalApproval(fixture.path, parent.workItemId);

    const settled = await fixture.board.approvePipelineMerge(parent.workItemId, { version: parentVersion });

    assert.equal(settled.state, "merged");
    const action = gateActions(fixture.path, parent.workItemId).at(-1);
    assert.equal(action?.refId, revision.planRevisionId);
    assert.equal(action?.note, "64 children merged, 0 abandoned");
    const completion = fixture.board.parentCompletion(parent.workItemId);
    assert.equal(completion.parentWorkItemId, parent.workItemId);
    assert.equal(completion.children.length, 64);
    assert.ok(completion.children.every((child) => child.mergeSha === MERGE_SHAS[0]));
    assert.ok(fixture.board.listChildren(parent.workItemId).every((child) => child.mergeSha === MERGE_SHAS[0]));
  } finally {
    fixture.board.close();
  }
});

test("repo_busy in one phased parent does not block an unrelated parent promotion", async () => {
  const verifiedByBranch = new Map<string, string>();
  let busyBranch = "";
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      if (arguments_.includes("ls-tree") && arguments_.at(-1) === "docs/interface.md") {
        return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
      }
      if (
        arguments_.includes("cat-file") &&
        arguments_.includes("-s") &&
        arguments_.at(-1)?.endsWith(":docs/interface.md")
      )
        return "22\n";
      if (arguments_.includes("show") && arguments_.at(-1)?.endsWith(":docs/interface.md")) {
        return "# Runtime interface\n";
      }
      if (arguments_.includes("--abbrev-ref")) return "main\n";
      if (arguments_.includes("--porcelain")) return "";
      if (arguments_.includes("merge-base")) return "";
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline(request) {
      return request.branch === busyBranch ? { kind: "repo_busy" } : { kind: "merged", mergeSha: MERGE_SHAS[0] };
    },
  });
  const consumer = fixture.board.createProject({
    name: "Busy policy consumer",
    description: "Hosts the phased migrate child.",
    repoPath: "/repos/busy-policy-consumer",
  });
  try {
    const phased = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "expand",
          objective: "Expand before the busy merge.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/busy-expand", "docs/interface.md"],
          acceptanceCriteria: ["The expand child remains retryable."],
          phase: "expand",
          splitBy: "phase",
        },
        {
          key: "migrate",
          objective: "Migrate after expand.",
          projectId: consumer.projectId,
          declaredScope: ["src/busy-migrate"],
          acceptanceCriteria: ["The migrate follows expand."],
          phase: "migrate",
          splitBy: "consumer",
          dependsOn: ["expand"],
        },
        {
          key: "contract",
          objective: "Contract after migrate.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/busy-contract", "docs/interface.md"],
          acceptanceCriteria: ["The contract follows deployment."],
          phase: "contract",
          splitBy: "phase",
          dependsOn: ["migrate"],
        },
      ],
      "busy-policy",
      "blast_radius"
    );
    const expand = phased.children[0];
    assert.ok(expand);
    busyBranch = expand.pipelineBranch!;
    verifiedByBranch.set(busyBranch, VERIFIED_SHAS[0]);
    forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);

    const unrelated = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "unrelated-one",
          objective: "Prepare an unrelated child.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/unrelated-one"],
          acceptanceCriteria: ["The first unrelated child is ready."],
        },
        {
          key: "unrelated-two",
          objective: "Prepare another unrelated child.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/unrelated-two"],
          acceptanceCriteria: ["The second unrelated child is ready."],
        },
      ],
      "unrelated-promotion"
    );
    for (const [index, child] of unrelated.children.entries()) {
      verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[index]!);
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }

    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...arguments_: unknown[]) => {
      errors.push(arguments_);
    };
    try {
      fixture.board.reconcileWorkflows(fixture.project.projectId);
    } finally {
      console.error = originalError;
    }

    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "final_approval");
    assert.equal(fixture.board.requireWorkItem(unrelated.parent.workItemId).state, "final_approval");
    assert.ok(
      fixture.board
        .listNotifications()
        .unread.some(
          (notification) =>
            notification.kind === "parent_ready_for_approval" && notification.workItemId === unrelated.parent.workItemId
        )
    );
    assert.ok(errors.some((arguments_) => JSON.stringify(arguments_).includes(expand.workItemId)));
  } finally {
    fixture.board.close();
  }
});

test("project-scoped reconciliation leaves an unrelated ready parent untouched", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  const unrelatedProject = fixture.board.createProject({
    name: "Unrelated reconciliation project",
    description: "Owns a decomposition family outside the requested project.",
    repoPath: "/repos/unrelated-reconciliation",
  });
  try {
    const unrelated = proposeParent(
      fixture.board,
      unrelatedProject.projectId,
      [
        {
          key: "one",
          objective: "Prepare the first unrelated child.",
          projectId: unrelatedProject.projectId,
          declaredScope: ["src/unrelated-one"],
          acceptanceCriteria: ["The first child is ready."],
        },
        {
          key: "two",
          objective: "Prepare the second unrelated child.",
          projectId: unrelatedProject.projectId,
          declaredScope: ["src/unrelated-two"],
          acceptanceCriteria: ["The second child is ready."],
        },
      ],
      "project-scoped-unrelated"
    );
    for (const [index, child] of unrelated.children.entries()) {
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }

    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(fixture.board.requireWorkItem(unrelated.parent.workItemId).state, "coordinating");

    fixture.board.reconcileWorkflows(unrelatedProject.projectId);
    assert.equal(fixture.board.requireWorkItem(unrelated.parent.workItemId).state, "final_approval");
  } finally {
    fixture.board.close();
  }
});

for (const failure of ["repo_busy", "conflict"] as const) {
  test(`a ${failure} automatic merge failure does not starve a parallel Migrate sibling`, async () => {
    const verifiedByBranch = new Map<string, string>();
    let failedBranch = "";
    const fixture = await boardFixture(undefined, undefined, {
      git(arguments_) {
        if (arguments_.includes("--abbrev-ref")) return "main\n";
        if (arguments_.includes("--porcelain")) return "";
        if (arguments_.includes("merge-base")) return "";
        const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
        if (verifiedRef !== undefined) {
          return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
        }
        return `${BASE_SHA}\n`;
      },
      mergePipeline(request) {
        if (request.branch === failedBranch) {
          return failure === "repo_busy"
            ? { kind: "repo_busy" }
            : { kind: "conflict", summary: "The first Migrate conflicts." };
        }
        return {
          kind: "merged",
          mergeSha: request.branch.endsWith("expand") ? MERGE_SHAS[0] : MERGE_SHAS[1],
        };
      },
    });
    const firstConsumer = fixture.board.createProject({
      name: `First ${failure} consumer`,
      description: "Hosts the failing Migrate child.",
      repoPath: `/repos/${failure}-first-consumer`,
    });
    const secondConsumer = fixture.board.createProject({
      name: `Second ${failure} consumer`,
      description: "Hosts the independent Migrate child.",
      repoPath: `/repos/${failure}-second-consumer`,
    });
    try {
      const decomposition = proposeParent(
        fixture.board,
        fixture.project.projectId,
        [
          {
            key: "expand",
            objective: "Expand before both migrations.",
            projectId: fixture.project.projectId,
            declaredScope: ["src/expand", "docs/interface.md"],
            acceptanceCriteria: ["The expansion merges."],
            phase: "expand",
            splitBy: "phase",
          },
          {
            key: "migrate-one",
            objective: "Exercise the first migration failure.",
            projectId: firstConsumer.projectId,
            declaredScope: ["src/migrate-one"],
            acceptanceCriteria: ["The first migration remains retryable."],
            phase: "migrate",
            splitBy: "consumer",
            dependsOn: ["expand"],
          },
          {
            key: "migrate-two",
            objective: "Merge independently of the first migration failure.",
            projectId: secondConsumer.projectId,
            declaredScope: ["src/migrate-two"],
            acceptanceCriteria: ["The second migration merges in the same pass."],
            phase: "migrate",
            splitBy: "consumer",
            dependsOn: ["expand"],
          },
          {
            key: "contract",
            objective: "Contract after both migrations deploy.",
            projectId: fixture.project.projectId,
            declaredScope: ["src/contract", "docs/interface.md"],
            acceptanceCriteria: ["The contract remains downstream."],
            phase: "contract",
            splitBy: "phase",
            dependsOn: ["migrate-one", "migrate-two"],
          },
        ],
        `parallel-migrate-${failure}`,
        "blast_radius"
      );
      const [expand, firstMigrate, secondMigrate] = decomposition.children;
      assert.ok(expand);
      assert.ok(firstMigrate);
      assert.ok(secondMigrate);
      verifiedByBranch.set(expand.pipelineBranch!, VERIFIED_SHAS[0]);
      forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);
      fixture.board.reconcileWorkflows(fixture.project.projectId);
      assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "merged");

      failedBranch = firstMigrate.pipelineBranch!;
      verifiedByBranch.set(firstMigrate.pipelineBranch!, VERIFIED_SHAS[1]);
      verifiedByBranch.set(secondMigrate.pipelineBranch!, VERIFIED_SHAS[2]);
      forceFinalApproval(fixture.path, firstMigrate.workItemId, VERIFIED_SHAS[1]);
      forceFinalApproval(fixture.path, secondMigrate.workItemId, VERIFIED_SHAS[2]);
      const originalError = console.error;
      console.error = () => undefined;
      try {
        fixture.board.reconcileWorkflows(fixture.project.projectId);
      } finally {
        console.error = originalError;
      }

      assert.equal(
        fixture.board.requireWorkItem(firstMigrate.workItemId).state,
        failure === "repo_busy" ? "final_approval" : "implementing"
      );
      assert.equal(fixture.board.requireWorkItem(secondMigrate.workItemId).state, "merged");
    } finally {
      fixture.board.close();
    }
  });
}

test("a non-transient automatic merge failure reuses human conflict recovery and notifies", async () => {
  const verifiedByBranch = new Map<string, string>();
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      if (arguments_.includes("--abbrev-ref")) return "main\n";
      if (arguments_.includes("--porcelain")) return "";
      if (arguments_.includes("merge-base")) return "";
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline() {
      return { kind: "conflict", summary: "Automatic merge conflict in the Expand child." };
    },
  });
  const consumer = fixture.board.createProject({
    name: "Conflict policy consumer",
    description: "Hosts the conflict-policy migrate child.",
    repoPath: "/repos/conflict-policy-consumer",
  });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "expand",
          objective: "Exercise automatic merge conflict recovery.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/conflict-expand", "docs/interface.md"],
          acceptanceCriteria: ["The child returns to implementation."],
          phase: "expand",
          splitBy: "phase",
        },
        {
          key: "migrate",
          objective: "Wait for the recovered Expand child.",
          projectId: consumer.projectId,
          declaredScope: ["src/conflict-migrate"],
          acceptanceCriteria: ["The migrate stays downstream."],
          phase: "migrate",
          splitBy: "consumer",
          dependsOn: ["expand"],
        },
        {
          key: "contract",
          objective: "Wait for deployment after migration.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/conflict-contract", "docs/interface.md"],
          acceptanceCriteria: ["The contract stays downstream."],
          phase: "contract",
          splitBy: "phase",
          dependsOn: ["migrate"],
        },
      ],
      "automatic-conflict",
      "blast_radius"
    );
    const expand = decomposition.children[0];
    assert.ok(expand);
    verifiedByBranch.set(expand.pipelineBranch!, VERIFIED_SHAS[0]);
    forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);

    const originalError = console.error;
    console.error = () => undefined;
    try {
      fixture.board.reconcileWorkflows(fixture.project.projectId);
    } finally {
      console.error = originalError;
    }

    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "implementing");
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const handoff = inspected
        .prepare(
          `
        SELECT handoff.payload_json
        FROM stage_handoffs handoff
        JOIN work_nodes node ON node.node_id=handoff.node_id
        JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
        WHERE plan.work_item_id=? AND handoff.stage='implementation'
        ORDER BY handoff.created_at DESC,handoff.rowid DESC
        LIMIT 1
      `
        )
        .get(expand.workItemId);
      assert.match(String(handoff?.payload_json), /Automatic merge conflict in the Expand child/u);
    } finally {
      inspected.close();
    }
    assert.ok(
      fixture.board
        .listNotifications()
        .unread.some(
          (notification) =>
            notification.kind === "final_approval_withdrawn" && notification.workItemId === expand.workItemId
        )
    );
  } finally {
    fixture.board.close();
  }
});

test("unphased parents promote with merged siblings and fan out only over unmerged children", async () => {
  const verifiedByBranch = new Map<string, string>();
  const mergeOrder: string[] = [];
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      const inspection = staticCleanFanOutInspection(arguments_);
      if (inspection !== null) return inspection;
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline(request) {
      mergeOrder.push(request.branch.slice("task/".length));
      return { kind: "merged", mergeSha: MERGE_SHAS[mergeOrder.length - 1]! };
    },
  });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "merged-first",
          objective: "Merge individually before sibling approval.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/merged-first"],
          acceptanceCriteria: ["The child merges individually."],
        },
        {
          key: "remaining",
          objective: "Merge through parent fan-out.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/remaining"],
          acceptanceCriteria: ["The parent merges only this child."],
        },
      ],
      "mixed-child-states"
    );
    const [first, remaining] = decomposition.children;
    assert.ok(first);
    assert.ok(remaining);
    verifiedByBranch.set(first.pipelineBranch!, VERIFIED_SHAS[0]);
    const firstVersion = forceFinalApproval(fixture.path, first.workItemId, VERIFIED_SHAS[0]);
    await fixture.board.approvePipelineMerge(first.workItemId, { version: firstVersion });
    verifiedByBranch.set(remaining.pipelineBranch!, VERIFIED_SHAS[1]);
    forceFinalApproval(fixture.path, remaining.workItemId, VERIFIED_SHAS[1]);

    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const readyParent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(readyParent.state, "final_approval");
    const settled = await fixture.board.approvePipelineMerge(decomposition.parent.workItemId, {
      version: readyParent.version,
    });
    assert.equal(settled.state, "merged");
    assert.deepEqual(mergeOrder, [first.workItemId, remaining.workItemId]);
  } finally {
    fixture.board.close();
  }
});

test("parent fan-out reconciles an overlapping pipeline in every child project before returning", async () => {
  let now = new Date("2026-08-29T14:00:00.000Z");
  const verifiedByBranch = new Map<string, string>();
  const fixture = await boardFixture(undefined, () => now, {
    git(arguments_) {
      const inspection = staticCleanFanOutInspection(arguments_);
      if (inspection !== null) return inspection;
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline: () => ({ kind: "merged", mergeSha: MERGE_SHAS[0] }),
  });
  try {
    const childProject = fixture.board.createProject({
      name: "Fan-out child project",
      description: "Owns the child scope and a pipeline waiting for its release.",
      repoPath: "/repos/fan-out-child",
    });
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "scope-holder",
          objective: "Hold the child project's shared scope through parent approval.",
          projectId: childProject.projectId,
          declaredScope: ["src/fan-out-shared"],
          acceptanceCriteria: ["The parent merge releases the remote project scope."],
        },
      ],
      "fan-out-child-project-reconcile"
    );
    const [child] = decomposition.children;
    assert.ok(child);
    now = new Date("2026-08-29T14:00:01.000Z");
    const held = proposeStandalonePipeline(
      fixture.board,
      childProject.projectId,
      ["src/fan-out-shared"],
      "fan-out-scope-waiter"
    );
    assert.equal(childNode(fixture.board, held).node.state, "blocked");

    verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[0]);
    forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[0]);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const parent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(parent.state, "final_approval");

    const settled = await fixture.board.approvePipelineMerge(parent.workItemId, { version: parent.version });

    assert.equal(settled.state, "merged");
    assert.equal(childNode(fixture.board, held).node.state, "active");
  } finally {
    fixture.board.close();
  }
});

test("parent fan-out resumes after a mid-way child merge conflict", async () => {
  const verifiedByBranch = new Map<string, string>();
  const mergeOrder: string[] = [];
  let conflicted = false;
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      const inspection = staticCleanFanOutInspection(arguments_);
      if (inspection !== null) return inspection;
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline(request) {
      const workItemId = request.branch.slice("task/".length);
      mergeOrder.push(workItemId);
      if (mergeOrder.length === 2 && !conflicted) {
        conflicted = true;
        return { kind: "conflict", summary: "Merge conflict in the second child." };
      }
      return { kind: "merged", mergeSha: mergeOrder.length === 1 ? MERGE_SHAS[0] : MERGE_SHAS[1] };
    },
  });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "one",
          objective: "Merge before the failing child.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/resume-one"],
          acceptanceCriteria: ["The first merge remains landed."],
        },
        {
          key: "two",
          objective: "Fail once, then merge on retry.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/resume-two"],
          acceptanceCriteria: ["The retry skips the merged sibling."],
          dependsOn: ["one"],
        },
      ],
      "resumable-fan-out"
    );
    const [one, two] = decomposition.children;
    assert.ok(one);
    assert.ok(two);
    for (const [index, child] of decomposition.children.entries()) {
      verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[index]!);
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const readyParent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(readyParent.state, "final_approval");

    await assert.rejects(
      fixture.board.approvePipelineMerge(decomposition.parent.workItemId, { version: readyParent.version }),
      (error: unknown) => error instanceof TaskBoardError && error.code === "PARENT_CHILD_MERGE_CONFLICT"
    );
    assert.equal(fixture.board.requireWorkItem(one.workItemId).state, "merged");
    assert.equal(fixture.board.requireWorkItem(two.workItemId).state, "implementing");
    const withdrawnParent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(withdrawnParent.state, "coordinating");
    assert.equal(withdrawnParent.version, readyParent.version + 1);

    forceFinalApproval(fixture.path, two.workItemId, VERIFIED_SHAS[1]);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const rePromotedParent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(rePromotedParent.state, "final_approval");
    assert.equal(rePromotedParent.version, withdrawnParent.version + 1);
    const settled = await fixture.board.approvePipelineMerge(decomposition.parent.workItemId, {
      version: rePromotedParent.version,
    });
    assert.equal(settled.state, "merged");
    assert.deepEqual(mergeOrder, [one.workItemId, two.workItemId, two.workItemId]);
  } finally {
    fixture.board.close();
  }
});

test("the last individually approved unphased child settles its parent directly", async () => {
  const verifiedByBranch = new Map<string, string>();
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline(request) {
      return {
        kind: "merged",
        mergeSha: request.branch.endsWith("-0") ? MERGE_SHAS[0] : MERGE_SHAS[1],
      };
    },
  });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "one",
          objective: "Merge first through its own approval.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/individual-one"],
          acceptanceCriteria: ["The first child merges."],
        },
        {
          key: "two",
          objective: "Merge last through its own approval.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/individual-two"],
          acceptanceCriteria: ["The last child settles the parent."],
        },
      ],
      "individual-last-settlement"
    );
    const [one, two] = decomposition.children;
    assert.ok(one);
    assert.ok(two);
    for (const [index, child] of decomposition.children.entries()) {
      verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[index]!);
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "final_approval");
    await fixture.board.approvePipelineMerge(one.workItemId, {
      version: fixture.board.requireWorkItem(one.workItemId).version,
    });
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "final_approval");
    await fixture.board.approvePipelineMerge(two.workItemId, {
      version: fixture.board.requireWorkItem(two.workItemId).version,
    });
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "merged");
    assert.equal(
      gateActions(fixture.path, decomposition.parent.workItemId).at(-1)?.actorId,
      "system:parent-completion"
    );
    assert.deepEqual(latestTransitionActor(fixture.path, decomposition.parent.workItemId), {
      actorType: "system",
      actorId: "system:parent-completion",
    });
  } finally {
    fixture.board.close();
  }
});

test("an unphased blast-radius parent uses the one-parent-approval policy", async () => {
  const verifiedByBranch = new Map<string, string>();
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      const inspection = staticCleanFanOutInspection(arguments_);
      if (inspection !== null) return inspection;
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      return `${BASE_SHA}\n`;
    },
    mergePipeline() {
      return { kind: "merged", mergeSha: MERGE_SHAS[0] };
    },
  });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "consumer-split",
          objective: "Ship an unphased blast-radius child.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/consumer-split"],
          acceptanceCriteria: ["The parent provides one approval."],
          splitBy: "consumer",
        },
      ],
      "unphased-blast-radius",
      "blast_radius"
    );
    const child = decomposition.children[0];
    assert.ok(child);
    verifiedByBranch.set(child.pipelineBranch!, VERIFIED_SHAS[0]);
    forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[0]);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const readyParent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(readyParent.state, "final_approval");
    const settled = await fixture.board.approvePipelineMerge(decomposition.parent.workItemId, {
      version: readyParent.version,
    });
    assert.equal(settled.state, "merged");
    assert.equal(
      gateActions(fixture.path, decomposition.parent.workItemId).at(-1)?.note,
      "1 children merged, 0 abandoned"
    );
  } finally {
    fixture.board.close();
  }
});

test("phased children auto-merge under parent authorization and Contract waits for deploy attestations", async () => {
  const verifiedByBranch = new Map<string, string>();
  const mergeOrder: string[] = [];
  let providerHead = BASE_SHA;
  let expandBranch = "";
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      if (arguments_.includes("ls-tree") && arguments_.at(-1) === "docs/interface.md") {
        return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
      }
      if (
        arguments_.includes("cat-file") &&
        arguments_.includes("-s") &&
        arguments_.at(-1)?.endsWith(":docs/interface.md")
      )
        return "20\n";
      if (arguments_.includes("show") && arguments_.at(-1)?.endsWith(":docs/interface.md")) {
        return "# Runtime interface\n";
      }
      if (arguments_.includes("--abbrev-ref")) return "main\n";
      if (arguments_.includes("--porcelain")) return "";
      if (arguments_.includes("merge-base")) return "";
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      const repositoryIndex = arguments_.indexOf("-C");
      const repository = repositoryIndex < 0 ? null : arguments_[repositoryIndex + 1];
      return `${repository === "/repos/runtime-consumer" ? CONSUMER_BASE_SHA : providerHead}\n`;
    },
    mergePipeline(request) {
      mergeOrder.push(request.branch.slice("task/".length));
      if (request.branch === expandBranch) providerHead = ADVANCED_SHA;
      return { kind: "merged", mergeSha: MERGE_SHAS[mergeOrder.length - 1]! };
    },
  });
  const provider = fixture.board.createProject({
    name: "Runtime provider",
    description: "Owns the expanded and contracted interface.",
    repoPath: "/repos/runtime-provider",
  });
  const consumer = fixture.board.createProject({
    name: "Runtime consumer",
    description: "Consumes the expanded interface.",
    repoPath: "/repos/runtime-consumer",
  });
  const declared: readonly DeclaredChild[] = [
    {
      key: "expand",
      objective: "Expand the provider interface.",
      projectId: provider.projectId,
      declaredScope: ["docs/interface.md"],
      acceptanceCriteria: ["The additive interface is published."],
      phase: "expand",
      splitBy: "phase",
    },
    {
      key: "migrate",
      objective: "Migrate the consumer.",
      projectId: consumer.projectId,
      declaredScope: ["src/client"],
      acceptanceCriteria: ["The consumer uses the additive interface."],
      phase: "migrate",
      dependsOn: ["expand"],
      splitBy: "consumer",
    },
    {
      key: "contract",
      objective: "Contract the provider interface.",
      projectId: provider.projectId,
      declaredScope: ["docs/interface.md"],
      acceptanceCriteria: ["The legacy interface is removed."],
      phase: "contract",
      dependsOn: ["migrate"],
      splitBy: "phase",
    },
  ];

  const originalInfo = console.info;
  const infoLines: unknown[][] = [];
  console.info = (...arguments_: unknown[]) => {
    infoLines.push(arguments_);
  };
  try {
    const { parent, revision, children } = proposeParent(
      fixture.board,
      provider.projectId,
      declared,
      "phased-policy",
      "blast_radius"
    );
    const [expand, migrate, contract] = children;
    assert.ok(expand);
    assert.ok(migrate);
    assert.ok(contract);
    expandBranch = expand.pipelineBranch!;
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).baseSha, BASE_SHA);
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).baseSha, CONSUMER_BASE_SHA);
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).baseSha, BASE_SHA);
    const parentPlanConfirm = gateActions(fixture.path, parent.workItemId).find(
      (action) => action.gate === "plan_confirm"
    );
    assert.ok(parentPlanConfirm);

    verifiedByBranch.set(expand.pipelineBranch!, VERIFIED_SHAS[0]);
    forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);
    fixture.board.reconcileWorkflows(provider.projectId);
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "merged");
    assert.equal(providerHead, ADVANCED_SHA);
    const expandApproval = gateActions(fixture.path, expand.workItemId).at(-1);
    assert.equal(expandApproval?.gate, "final_approve");
    assert.equal(expandApproval?.actorId, "system:parent-plan-authorization");
    assert.equal(expandApproval?.refId, parentPlanConfirm.gateActionId);
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "implementing");
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).baseSha, CONSUMER_BASE_SHA);

    verifiedByBranch.set(migrate.pipelineBranch!, VERIFIED_SHAS[1]);
    forceFinalApproval(fixture.path, migrate.workItemId, VERIFIED_SHAS[1]);
    fixture.board.reconcileWorkflows(consumer.projectId);
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "merged");
    const migrateApproval = gateActions(fixture.path, migrate.workItemId).at(-1);
    assert.equal(migrateApproval?.actorId, "system:parent-plan-authorization");
    assert.equal(migrateApproval?.refId, parentPlanConfirm.gateActionId);
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "queued");
    assert.equal(
      latestNodeBlock(fixture.path, childNode(fixture.board, contract).node.nodeId),
      `waits for ${expand.workItemId} (expand) deploy attestation`
    );

    assert.throws(
      () => fixture.board.attestDeploy(contract.workItemId, { note: "Not merged yet." }),
      (error: unknown) => error instanceof TaskBoardError && error.code === "WORK_ITEM_NOT_MERGED"
    );
    const migrateAttestation = fixture.board.attestDeploy(migrate.workItemId, { note: "Consumer deployed first." });
    assert.equal(migrateAttestation.duplicate, false);
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "queued");
    assert.equal(
      latestNodeBlock(fixture.path, childNode(fixture.board, contract).node.nodeId),
      `waits for ${expand.workItemId} (expand) deploy attestation`
    );

    const firstAttestation = fixture.board.attestDeploy(expand.workItemId, { note: "Provider deployed." });
    const duplicateAttestation = fixture.board.attestDeploy(expand.workItemId, { note: "Ignored duplicate." });
    assert.equal(firstAttestation.duplicate, false);
    assert.equal(duplicateAttestation.duplicate, true);
    assert.equal(duplicateAttestation.gateAction.gateActionId, firstAttestation.gateAction.gateActionId);
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "implementing");
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).baseSha, ADVANCED_SHA);
    const contractBaseRefresh = infoLines.find(
      (arguments_) =>
        arguments_[0] === "[task-board] phased child base refreshed" &&
        typeof arguments_[1] === "object" &&
        arguments_[1] !== null &&
        (arguments_[1] as { workItemId?: unknown }).workItemId === contract.workItemId
    );
    assert.deepEqual(contractBaseRefresh?.[1], {
      workItemId: contract.workItemId,
      projectId: provider.projectId,
      previousBaseSha: BASE_SHA,
      baseSha: ADVANCED_SHA,
    });
    assert.deepEqual(
      (fixture.board.listChildren(parent.workItemId) as readonly ChildWorkItem[]).map((child) => child.deployAttested),
      [true, true, false]
    );
    const phaseReady = fixture.board
      .listNotifications()
      .unread.find((notification) => notification.kind === "phase_ready");
    assert.equal(phaseReady?.dedupeKey, `phase_ready:${parent.workItemId}:${contract.workItemId}`);
    assert.equal(
      fixture.board.listNotifications().unread.filter((notification) => notification.kind === "phase_ready").length,
      1
    );

    verifiedByBranch.set(contract.pipelineBranch!, VERIFIED_SHAS[2]);
    const contractVersion = forceFinalApproval(fixture.path, contract.workItemId, VERIFIED_SHAS[2]);
    const mergedContract = await fixture.board.approvePipelineMerge(contract.workItemId, {
      version: contractVersion,
    });
    assert.equal(mergedContract.state, "merged");
    assert.deepEqual(mergeOrder, [expand.workItemId, migrate.workItemId, contract.workItemId]);
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "merged");
    const parentCompletion = gateActions(fixture.path, parent.workItemId).at(-1);
    assert.equal(parentCompletion?.gate, "final_approve");
    assert.equal(parentCompletion?.actorId, "system:parent-plan-authorization");
    assert.equal(parentCompletion?.planRevisionId, revision.planRevisionId);
    assert.deepEqual(latestTransitionActor(fixture.path, parent.workItemId), {
      actorType: "system",
      actorId: "system:parent-plan-authorization",
    });
  } finally {
    console.info = originalInfo;
    fixture.board.close();
  }
});

test("a Migrate claim reads the provider interface at the Expand merge SHA only", async () => {
  const interfaceMarkdown = "# Published provider interface 😀 𠀀\n\n- `GET /v1/orders`\n";
  const showCalls: Array<readonly string[]> = [];
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      if (arguments_.includes("show")) {
        showCalls.push([...arguments_]);
        return interfaceMarkdown;
      }
      if (arguments_.includes("ls-tree")) {
        return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
      }
      if (arguments_.includes("cat-file") && arguments_.includes("-s")) {
        return `${Buffer.byteLength(interfaceMarkdown, "utf8")}\n`;
      }
      if (arguments_.includes("--abbrev-ref")) return "main\n";
      if (arguments_.includes("--porcelain")) return "";
      if (arguments_.includes("merge-base")) return "";
      if (arguments_.some((argument) => argument.endsWith("^{commit}"))) return `${VERIFIED_SHAS[0]}\n`;
      const repositoryIndex = arguments_.indexOf("-C");
      const repository = repositoryIndex < 0 ? null : arguments_[repositoryIndex + 1];
      return `${repository === "/repos/claim-consumer" ? CONSUMER_BASE_SHA : BASE_SHA}\n`;
    },
    mergePipeline: () => ({ kind: "merged", mergeSha: MERGE_SHAS[0] }),
  });
  const provider = fixture.board.createProject({
    name: "Claim provider",
    description: "Publishes the interface consumed by Migrate.",
    repoPath: "/repos/claim-provider",
  });
  const consumer = fixture.board.createProject({
    name: "Claim consumer",
    description: "Consumes the published provider interface.",
    repoPath: "/repos/claim-consumer",
  });

  try {
    fixture.board.createTask(fixture.project.projectId, taskRequest({ title: "Ordinary non-migrate work" }));
    const ordinaryClaim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "claim-cross-repo-ordinary",
      messageCursor: null,
    });
    assert.ok(ordinaryClaim);
    assert.equal((ordinaryClaim.context as { phase?: string | null }).phase, null);
    assert.equal(Object.hasOwn(ordinaryClaim.context, "crossRepoContext"), false);

    const decomposition = proposeParent(
      fixture.board,
      provider.projectId,
      phasedChildren(provider.projectId, consumer.projectId, "claim-context"),
      "claim-context",
      "blast_radius"
    );
    const [expand, migrate] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);
    fixture.board.reconcileWorkflows(provider.projectId);
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "merged");
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "implementing");

    const implementationTask = fixture.board
      .snapshot(consumer.projectId)
      .tasks.find((task) => task.status === "queued" && task.assignedRole === "engineer");
    assert.ok(implementationTask?.assignedAgentId);
    const migrateClaim = fixture.board.claimRun(implementationTask.assignedAgentId, {
      claimId: "claim-cross-repo-migrate",
      messageCursor: null,
    });
    assert.ok(migrateClaim);
    assert.equal((migrateClaim.context as { phase?: string | null }).phase, "migrate");
    assert.deepEqual(migrateClaim.context.crossRepoContext, {
      providerProjectId: provider.projectId,
      providerRepoName: provider.name,
      interfacePath: "docs/interface.md",
      sha: MERGE_SHAS[0],
      markdown: interfaceMarkdown,
    });
    const parsedClaim = parseClaimRunResult(migrateClaim);
    const mappedContext = mapClaimContext(parsedClaim, null);
    assert.ok(mappedContext);
    const workerContext = parseBoundedAgentContext(mappedContext);
    const prompt = agentPrompt(
      {
        runId: migrateClaim.run.runId,
        wakeReason: migrateClaim.wakeup.reason,
        context: workerContext,
      },
      PROMPTS
    );
    assert.ok(prompt.includes(interfaceMarkdown));
    assert.ok(prompt.includes("😀"));
    assert.ok(prompt.includes("𠀀"));

    assert.equal(showCalls.length, 2);
    for (const call of showCalls) {
      assert.deepEqual(call.slice(-2), ["show", `${MERGE_SHAS[0]}:docs/interface.md`]);
      assert.equal(call[call.indexOf("-C") + 1], provider.repoPath);
    }
    assert.deepEqual(
      fixture.board.claimRun(implementationTask.assignedAgentId, {
        claimId: "claim-cross-repo-migrate",
        messageCursor: null,
      }),
      migrateClaim
    );
    assert.equal(showCalls.length, 2);
  } finally {
    fixture.board.close();
  }
});

test("Expand verification requires the published interface before merge and Migrate activation", async () => {
  const interfaceMarkdown = "# Published replacement interface\n";
  const providerRepo = await pipelineRepository("provider");
  const consumerRepo = await pipelineRepository("consumer");
  const fixture = await boardFixture(undefined, undefined, {
    mergePipeline: (request) => ({ kind: "merged", mergeSha: request.branchSha }),
  });
  const provider = fixture.board.createProject({
    name: "Verification provider",
    description: "Publishes the verified interface.",
    repoPath: providerRepo,
  });
  const consumer = fixture.board.createProject({
    name: "Verification consumer",
    description: "Consumes the verified interface.",
    repoPath: consumerRepo,
  });

  try {
    const decomposition = proposeParent(
      fixture.board,
      provider.projectId,
      phasedChildren(provider.projectId, consumer.projectId, "verified-publication").map((child) =>
        child.phase === "expand" ? { ...child, declaredScope: ["docs"] } : child
      ),
      "verified-publication",
      "blast_radius"
    );
    const [expand, migrate] = decomposition.children;
    assert.ok(expand?.pipelineBranch);
    assert.ok(migrate);

    const implementationTask = await waitForQueuedRoleTask(fixture.board, provider.projectId, "engineer");
    assert.ok(implementationTask.assignedAgentId);
    const implementation = fixture.board.claimRun(implementationTask.assignedAgentId, {
      claimId: "claim-expand-without-interface",
      messageCursor: null,
    });
    assert.ok(implementation);
    assert.equal((implementation.context as { phase?: string | null }).phase, "expand");
    await git(providerRepo, ["checkout", "-b", expand.pipelineBranch]);
    await writeFile(join(providerRepo, "docs", "interface.md"), Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]));
    await git(providerRepo, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "docs/interface.md"]);
    await git(providerRepo, [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@local",
      "commit",
      "-m",
      "expand with malformed interface",
    ]);
    fixture.board.settleRun(implementation.run.runId, implementationTask.assignedAgentId, {
      outcome: "completed",
      result: "Initial Expand implementation is ready.",
      handoff: {
        outcome: "passed",
        summary: "Initial Expand implementation is ready.",
        evidence: [],
        artifactIds: [],
        acceptanceCriteria: [],
        blockers: [],
        recommendedReturnStage: null,
      },
    });

    const firstReviewTask = await waitForQueuedRoleTask(fixture.board, provider.projectId, "verifier");
    assert.ok(firstReviewTask.assignedAgentId);
    const firstReview = fixture.board.claimRun(firstReviewTask.assignedAgentId, {
      claimId: "claim-expand-review-without-interface",
      messageCursor: null,
    });
    assert.ok(firstReview);
    const publicationFinding = "publish docs/interface.md (invalid UTF-8)";
    const originalSummary = "s".repeat(4_000);
    const originalBlockers = Array.from({ length: 32 }, (_, index) => `original blocker ${index}`);
    const settlementRequest: SettleRunRequest = {
      outcome: "completed",
      result: "Independent review passed.",
      handoff: {
        outcome: "passed",
        summary: originalSummary,
        evidence: ["The reviewer independently exercised the provider branch."],
        artifactIds: [],
        acceptanceCriteria: [
          {
            criterion: "The provider change is independently verified.",
            passed: true,
            evidence: "The reviewer observed the expected provider behavior.",
          },
        ],
        blockers: originalBlockers,
        recommendedReturnStage: null,
      },
      reviewFindings: [],
    };
    const settlementDuplicates: boolean[] = [];
    const client = new HttpTaskBoardClient({
      baseUrl: "http://127.0.0.1:4318",
      token: "expand-reviewer-token-0123456789abcdef",
      fetchImplementation: (async (_input, init = {}) => {
        const settled = fixture.board.settleRun(
          firstReview.run.runId,
          firstReviewTask.assignedAgentId!,
          JSON.parse(String(init.body)) as SettleRunRequest
        );
        settlementDuplicates.push(settled.duplicate);
        return new Response(JSON.stringify(settled), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    const workerSettlement = {
      claim: {
        apiVersion: 1 as const,
        claimId: firstReview.run.claimId,
        runId: firstReview.run.runId,
        wakeupId: firstReview.run.wakeupId,
        projectId: firstReview.run.projectId,
        agentId: firstReview.run.agentId,
        taskId: firstReview.run.taskId,
        reason: firstReview.wakeup.reason,
        requestedMessageCursor: null,
        claimedAt: firstReview.run.startedAt,
      },
      idempotencyKey: "settle-expand-publication-review",
      ...settlementRequest,
    };
    await client.settleAgentRun(workerSettlement);
    await client.settleAgentRun(workerSettlement);
    assert.deepEqual(settlementDuplicates, [false, true]);
    const settledRun = fixture.board
      .snapshot(provider.projectId)
      .recentRuns.find((run) => run.runId === firstReview.run.runId);
    assert.equal(settledRun?.status, "completed");
    assert.equal(settledRun.result, settlementRequest.result);
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "fixing");
    const findingsAfterFailure = fixture.board.pipelineSummary(expand.workItemId).findings;
    assert.ok(findingsAfterFailure.some((finding) => finding.expected === publicationFinding && finding.blocking));
    const failedHandoffDb = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const handoffRows = failedHandoffDb
        .prepare(
          `
        SELECT payload_json
        FROM stage_handoffs
        WHERE node_id=? AND stage='verification'
        ORDER BY created_at,rowid
      `
        )
        .all(childNode(fixture.board, expand).node.nodeId);
      assert.equal(handoffRows.length, 2);
      const workerHandoff = JSON.parse(String(handoffRows[0]?.payload_json)) as {
        outcome: string;
        summary: string;
        blockers: string[];
      };
      assert.equal(workerHandoff.outcome, "passed");
      assert.equal(workerHandoff.summary, originalSummary);
      assert.deepEqual(workerHandoff.blockers, originalBlockers);
      const failedHandoff = JSON.parse(String(handoffRows[1]?.payload_json)) as {
        taskId: string;
        outcome: string;
        summary: string;
        evidence: string[];
        acceptanceCriteria: Array<{ criterion: string; passed: boolean; evidence: string }>;
        blockers: string[];
      };
      assert.equal(failedHandoff.outcome, "failed");
      assert.equal(failedHandoff.summary.length, 4_000);
      assert.ok(failedHandoff.summary.endsWith(` — ${publicationFinding}`));
      assert.deepEqual(failedHandoff.evidence, ["The reviewer independently exercised the provider branch."]);
      assert.deepEqual(failedHandoff.acceptanceCriteria, [
        {
          criterion: "The provider change is independently verified.",
          passed: true,
          evidence: "The reviewer observed the expected provider behavior.",
        },
      ]);
      assert.equal(failedHandoff.blockers.length, 32);
      assert.equal(failedHandoff.blockers[0], "original blocker 1");
      assert.equal(failedHandoff.blockers.at(-1), publicationFinding);
      const publicationActor = failedHandoffDb
        .prepare(
          `
        SELECT actor_type,actor_id
        FROM task_events
        WHERE task_id=? AND event_type='task_created'
      `
        )
        .get(failedHandoff.taskId);
      assert.equal(publicationActor?.actor_type, "system");
      assert.equal(publicationActor?.actor_id, "system:interface-publication");
    } finally {
      failedHandoffDb.close();
    }

    const fixTask = await waitForQueuedRoleTask(fixture.board, provider.projectId, "engineer");
    assert.ok(fixTask.assignedAgentId);
    const fix = fixture.board.claimRun(fixTask.assignedAgentId, {
      claimId: "claim-expand-publish-interface-fix",
      messageCursor: null,
    });
    assert.ok(fix);
    assert.equal(fix.context.workflow?.fix?.round, 1);
    const mappedFix = mapClaimContext(parseClaimRunResult(fix), null);
    assert.ok(mappedFix);
    const publicationHandoff = mappedFix.workflow?.dependencyHandoffs.at(-1);
    assert.ok(publicationHandoff);
    assert.ok(publicationHandoff.summary.endsWith(` — ${publicationFinding}`));
    assert.equal(publicationHandoff.blockers.at(-1), publicationFinding);
    await writeFile(join(providerRepo, "docs", "interface.md"), interfaceMarkdown, "utf8");
    await git(providerRepo, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "docs/interface.md"]);
    await git(providerRepo, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "publish interface"]);
    const publishedSha = (await git(providerRepo, ["rev-parse", "HEAD"])).trim();
    await git(providerRepo, ["checkout", "main"]);
    fixture.board.settleRun(fix.run.runId, fixTask.assignedAgentId, {
      outcome: "completed",
      result: "The interface is now published.",
      handoff: {
        outcome: "passed",
        summary: "The interface is now published.",
        evidence: [],
        artifactIds: [],
        acceptanceCriteria: [],
        blockers: [],
        recommendedReturnStage: null,
      },
    });

    const secondReviewTask = await waitForQueuedRoleTask(fixture.board, provider.projectId, "verifier");
    assert.ok(secondReviewTask.assignedAgentId);
    const secondReview = fixture.board.claimRun(secondReviewTask.assignedAgentId, {
      claimId: "claim-expand-review-with-interface",
      messageCursor: null,
    });
    assert.ok(secondReview);
    const passedReview = fixture.board.settleRun(secondReview.run.runId, secondReviewTask.assignedAgentId, {
      outcome: "completed",
      result: "Independent review passed with the published interface.",
      handoff: {
        outcome: "passed",
        summary: "Independent review passed with the published interface.",
        evidence: [],
        artifactIds: [],
        acceptanceCriteria: [],
        blockers: [],
        recommendedReturnStage: null,
      },
      reviewFindings: [],
    });
    assert.equal(passedReview.run.status, "completed");
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "merged");
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "implementing");

    const migrateTask = await waitForQueuedRoleTask(fixture.board, consumer.projectId, "engineer");
    assert.ok(migrateTask.assignedAgentId);
    const migrateClaim = fixture.board.claimRun(migrateTask.assignedAgentId, {
      claimId: "claim-migrate-after-published-interface",
      messageCursor: null,
    });
    assert.ok(migrateClaim);
    assert.equal(migrateClaim.context.crossRepoContext?.markdown, interfaceMarkdown);
    assert.equal(migrateClaim.context.crossRepoContext?.sha, publishedSha);
  } finally {
    fixture.board.close();
  }
});

test("an Expand that never publishes dead-letters at the review cap and parks its parent", async () => {
  const fixture = await boardFixture(undefined, undefined, {
    git: crossRepoGit((operation) => (operation === "ls-tree" ? "" : "publication content must stay absent")),
    mergePipeline: () => ({ kind: "merged", mergeSha: MERGE_SHAS[0] }),
  });
  const provider = fixture.board.createProject({
    name: "Publication cap provider",
    description: "Never publishes its required interface.",
    repoPath: "/repos/publication-cap-provider",
  });
  const consumer = fixture.board.createProject({
    name: "Publication cap consumer",
    description: "Must remain parked when the provider exhausts review.",
    repoPath: "/repos/publication-cap-consumer",
  });

  try {
    const decomposition = proposeParent(
      fixture.board,
      provider.projectId,
      phasedChildren(provider.projectId, consumer.projectId, "publication-cap"),
      "publication-cap",
      "blast_radius"
    );
    const expand = decomposition.children[0];
    assert.ok(expand);
    const verification = preparePhaseVerificationClaim(
      fixture,
      provider.projectId,
      expand,
      "expand-publication-cap",
      4
    );

    const settled = fixture.board.settleRun(verification.claim.run.runId, verification.verifier.agentId, {
      outcome: "completed",
      result: "The fourth independent review passed.",
      handoff: {
        outcome: "passed",
        summary: "The fourth independent review passed.",
        evidence: [],
        artifactIds: [],
        acceptanceCriteria: [],
        blockers: [],
        recommendedReturnStage: null,
      },
      reviewFindings: [],
    });

    assert.equal(settled.run.status, "completed");
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "dead_letter");
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "parked");
    assert.deepEqual(latestParkRecord(fixture.path, decomposition.parent.workItemId), {
      category: "child_failed",
      reason: `Child ${expand.workItemId} was dead-lettered`,
    });
    const publicationFinding = "publish docs/interface.md (absent)";
    assert.ok(
      fixture.board
        .pipelineSummary(expand.workItemId)
        .findings.some((finding) => finding.round === 4 && finding.expected === publicationFinding && finding.blocking)
    );
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const publicationHandoff = db
        .prepare(
          `
        SELECT payload_json
        FROM stage_handoffs
        WHERE node_id=? AND task_id LIKE 'task_interface_publication_%'
        ORDER BY created_at DESC,rowid DESC
        LIMIT 1
      `
        )
        .get(childNode(fixture.board, expand).node.nodeId);
      assert.equal(
        (JSON.parse(String(publicationHandoff?.payload_json)) as { blockers: string[] }).blockers.at(-1),
        publicationFinding
      );
    } finally {
      db.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("a terminal Expand accepts a late publication-failing verification settlement", async () => {
  for (const terminalState of ["abandoned", "merged"] as const) {
    const fixture = await boardFixture(undefined, undefined, {
      git: crossRepoGit((operation) => (operation === "ls-tree" ? "" : "publication content must stay absent")),
      mergePipeline: () => ({ kind: "merged", mergeSha: MERGE_SHAS[0] }),
    });
    const provider = fixture.board.createProject({
      name: `Late ${terminalState} provider`,
      description: "Settles after its work item is already terminal.",
      repoPath: `/repos/late-${terminalState}-provider`,
    });
    const consumer = fixture.board.createProject({
      name: `Late ${terminalState} consumer`,
      description: "Is unaffected by the late provider settlement.",
      repoPath: `/repos/late-${terminalState}-consumer`,
    });

    try {
      const decomposition = proposeParent(
        fixture.board,
        provider.projectId,
        phasedChildren(provider.projectId, consumer.projectId, `late-${terminalState}`),
        `late-${terminalState}`,
        "blast_radius"
      );
      const expand = decomposition.children[0];
      assert.ok(expand);
      const verification = preparePhaseVerificationClaim(
        fixture,
        provider.projectId,
        expand,
        `expand-late-${terminalState}`,
        1
      );
      const db = new DatabaseSync(fixture.path);
      try {
        assert.equal(
          Number(
            db
              .prepare(
                `
          UPDATE work_items
          SET state=?,current_stage=NULL,ended_at=?,version=version+1,updated_at=?
          WHERE work_item_id=?
        `
              )
              .run(terminalState, NOW, NOW, expand.workItemId).changes
          ),
          1
        );
      } finally {
        db.close();
      }

      const settled = fixture.board.settleRun(verification.claim.run.runId, verification.verifier.agentId, {
        outcome: "completed",
        result: `The ${terminalState} Expand review settled late.`,
        handoff: {
          outcome: "passed",
          summary: `The ${terminalState} Expand review settled late.`,
          evidence: [],
          artifactIds: [],
          acceptanceCriteria: [],
          blockers: [],
          recommendedReturnStage: null,
        },
        reviewFindings: [],
      });

      assert.equal(settled.run.status, "completed");
      assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, terminalState);
      assert.deepEqual(
        {
          state: childNode(fixture.board, expand).node.state,
          currentStage: childNode(fixture.board, expand).node.currentStage,
        },
        { state: "completed", currentStage: null }
      );
      assert.ok(
        fixture.board
          .pipelineSummary(expand.workItemId)
          .findings.some((finding) => finding.expected === "publish docs/interface.md (absent)" && finding.blocking)
      );
    } finally {
      fixture.board.close();
    }
  }
});

test("Expand publication read errors leave the verification run active for retry", async () => {
  const fixture = await boardFixture(undefined, undefined, {
    git: crossRepoGit((operation) => {
      throw new Error(`provider repository unavailable during ${operation}`);
    }),
    mergePipeline: () => ({ kind: "merged", mergeSha: MERGE_SHAS[0] }),
  });
  const provider = fixture.board.createProject({
    name: "Publication read-error provider",
    description: "Exercises retryable verification publication reads.",
    repoPath: "/repos/publication-read-error-provider",
  });
  const consumer = fixture.board.createProject({
    name: "Publication read-error consumer",
    description: "Consumes the provider interface.",
    repoPath: "/repos/publication-read-error-consumer",
  });

  try {
    const decomposition = proposeParent(
      fixture.board,
      provider.projectId,
      phasedChildren(provider.projectId, consumer.projectId, "publication-read-error"),
      "publication-read-error",
      "blast_radius"
    );
    const expand = decomposition.children[0];
    assert.ok(expand);
    const verification = preparePhaseVerificationClaim(
      fixture,
      provider.projectId,
      expand,
      "expand-publication-read-error"
    );
    assert.throws(
      () =>
        fixture.board.settleRun(verification.claim.run.runId, verification.verifier.agentId, {
          outcome: "completed",
          result: "The Expand review passed.",
          handoff: {
            outcome: "passed",
            summary: "The Expand review passed.",
            evidence: ["Reviewer evidence remains available for retry."],
            artifactIds: [],
            acceptanceCriteria: [],
            blockers: [],
            recommendedReturnStage: null,
          },
          reviewFindings: [],
        }),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 409 && error.code === "TASK_BOARD_PIPELINE_REPO_UNAVAILABLE"
    );
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT status FROM runs WHERE run_id=?").get(verification.claim.run.runId)?.status,
        "active"
      );
      assert.equal(
        db.prepare("SELECT status FROM tasks WHERE task_id=?").get(verification.task.taskId)?.status,
        "in_progress"
      );
    } finally {
      db.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("Expand publication enforcement is inert for Migrate, Contract, and ordinary verification settles", async () => {
  for (const phase of ["migrate", "contract", "ordinary"] as const) {
    let interfaceReads = 0;
    const fixture = await boardFixture(undefined, undefined, {
      git: crossRepoGit((operation) => {
        interfaceReads += 1;
        throw new Error(`publication guard must not read ${operation} for ${phase}`);
      }),
      mergePipeline: () => ({ kind: "merged", mergeSha: MERGE_SHAS[0] }),
    });
    const provider = fixture.board.createProject({
      name: `${phase} inert provider`,
      description: `Pins publication guard inertness for ${phase}.`,
      repoPath: `/repos/${phase}-inert-provider`,
    });
    const consumer = fixture.board.createProject({
      name: `${phase} inert consumer`,
      description: `Runs ${phase} verification.`,
      repoPath: `/repos/${phase}-inert-consumer`,
    });
    try {
      let projectId: string;
      let workItem: WorkItem;
      if (phase === "ordinary") {
        projectId = consumer.projectId;
        workItem = proposeStandalonePipeline(
          fixture.board,
          projectId,
          ["src/ordinary-inert"],
          "ordinary-publication-inert"
        );
      } else {
        const decomposition = proposeParent(
          fixture.board,
          provider.projectId,
          phasedChildren(provider.projectId, consumer.projectId, `${phase}-publication-inert`),
          `${phase}-publication-inert`,
          "blast_radius"
        );
        workItem = decomposition.children.find((child) => child.phase === phase)!;
        projectId = workItem.resolvedProjectId!;
      }
      const verification = preparePhaseVerificationClaim(fixture, projectId, workItem, `${phase}-publication-inert`);
      const settled = fixture.board.settleRun(verification.claim.run.runId, verification.verifier.agentId, {
        outcome: "completed",
        result: `${phase} verification passed.`,
        handoff: {
          outcome: "passed",
          summary: `${phase} verification passed.`,
          evidence: [],
          artifactIds: [],
          acceptanceCriteria: [],
          blockers: [],
          recommendedReturnStage: null,
        },
        reviewFindings: [],
      });
      assert.equal(settled.run.status, "completed", phase);
      assert.equal(interfaceReads, 0, phase);
    } finally {
      fixture.board.close();
    }
  }
});

test("an oversized published interface blocks Migrate readiness before git show", async () => {
  let showCalls = 0;
  const fixture = await migrateReadinessFixture("oversized-interface", (operation) => {
    if (operation === "ls-tree") return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
    if (operation === "cat-file") return `${64 * 1_024 + 1}\n`;
    showCalls += 1;
    throw new Error("oversized interface must not be shown");
  });

  try {
    const { node } = childNode(fixture.board, fixture.migrate);
    assert.equal(
      latestNodeBlock(fixture.path, node.nodeId),
      `blocked: provider docs/interface.md exceeds 64 KiB at ${MERGE_SHAS[0]}; cancel the parent to abandon the decomposition`
    );
    assert.equal(showCalls, 0);
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count), 0);
      assert.equal(
        Number(db.prepare("SELECT COUNT(*) AS count FROM stage_attempts WHERE node_id=?").get(node.nodeId)?.count),
        0
      );
    } finally {
      db.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("a non-file published interface blocks Migrate readiness", async () => {
  const fixture = await migrateReadinessFixture("non-file-interface", (operation) => {
    if (operation === "ls-tree") return `040000 tree ${"f".repeat(40)}\tdocs/interface.md\0`;
    throw new Error(`${operation} must not run for a tree`);
  });

  try {
    const { node } = childNode(fixture.board, fixture.migrate);
    assert.equal(
      latestNodeBlock(fixture.path, node.nodeId),
      `blocked: provider docs/interface.md is not a file at ${MERGE_SHAS[0]}; cancel the parent to abandon the decomposition`
    );
    assert.equal(fixture.board.requireWorkItem(fixture.migrate.workItemId).state, "queued");
  } finally {
    fixture.board.close();
  }
});

test("Migrate context attaches only to implementation and fix-round engineer claims", async () => {
  const interfaceMarkdown = "# Role-scoped provider interface\n";
  const fixture = await migrateReadinessFixture("role-scoped-context", (operation) => {
    if (operation === "ls-tree") return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
    if (operation === "cat-file") return `${Buffer.byteLength(interfaceMarkdown, "utf8")}\n`;
    return interfaceMarkdown;
  });

  try {
    const { node } = childNode(fixture.board, fixture.migrate);
    const claims: Array<Readonly<{ label: string; agentId: string }>> = [];
    const db = new DatabaseSync(fixture.path);
    try {
      for (const [label, role, stage, attempt] of [
        ["verifier", "verifier", "testing", 20],
        ["reviewer", "verifier", "verification", 20],
        ["fix-round", "engineer", "implementation", 20],
      ] as const) {
        const agent = fixture.board.createAgent(fixture.consumer.projectId, {
          agentId: `role-scoped-${label}`,
          role,
          area: `${label} lane`,
          mission: `${label} must receive only role-relevant context.`,
          model: "test-model",
          token: `role-scoped-${label}-token-0123456789abcdef`,
        });
        const task = fixture.board.createTask(
          fixture.consumer.projectId,
          taskRequest({
            title: `${label}: role-scoped Migrate task`,
            assignedAgentId: agent.agentId,
            assignedRole: role,
          })
        );
        db.prepare("INSERT INTO stage_attempts VALUES(?,?,?,?,?,?)").run(
          `role-scoped-${label}-attempt`,
          node.nodeId,
          task.taskId,
          stage,
          attempt,
          "{}"
        );
        claims.push(Object.freeze({ label, agentId: agent.agentId }));
      }

      const designer = fixture.board.createAgent(fixture.consumer.projectId, {
        agentId: "role-scoped-designer",
        role: "manager",
        area: "design lane",
        mission: "Design without implementation-only context.",
        model: "test-model",
        token: "role-scoped-designer-token-0123456789abcdef",
      });
      const designTask = fixture.board.createTask(
        fixture.consumer.projectId,
        taskRequest({
          title: "design: role-scoped Migrate task",
          assignedAgentId: designer.agentId,
          assignedRole: "manager",
        })
      );
      db.prepare("INSERT INTO work_item_design_tasks VALUES(?,?,?)").run(
        fixture.migrate.workItemId,
        designTask.taskId,
        NOW
      );
      claims.push(Object.freeze({ label: "design", agentId: designer.agentId }));
    } finally {
      db.close();
    }

    for (const { label, agentId } of claims) {
      const claim = fixture.board.claimRun(agentId, {
        claimId: `claim-role-scoped-${label}`,
        messageCursor: null,
      });
      assert.ok(claim);
      assert.equal(Object.hasOwn(claim.context, "crossRepoContext"), label === "fix-round", label);
    }
  } finally {
    fixture.board.close();
  }
});

test("a provider outage after Migrate implementation does not gate verification activation", async () => {
  const interfaceMarkdown = "# Verification-independent provider interface\n";
  let outage = false;
  const fixture = await migrateReadinessFixture("verification-outage", (operation) => {
    if (outage) throw new Error("provider repository unavailable during verification");
    if (operation === "ls-tree") return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
    if (operation === "cat-file") return `${Buffer.byteLength(interfaceMarkdown, "utf8")}\n`;
    return interfaceMarkdown;
  });

  try {
    const { node } = childNode(fixture.board, fixture.migrate);
    const implementationTask = fixture.board
      .snapshot(fixture.consumer.projectId)
      .tasks.find((task) => task.status === "queued" && task.assignedRole === "engineer");
    assert.ok(implementationTask);
    const db = new DatabaseSync(fixture.path);
    try {
      const expandPlan = db
        .prepare(
          `
        SELECT plan.plan_revision_id
        FROM plan_revisions plan
        WHERE plan.work_item_id=? AND plan.state='confirmed'
      `
        )
        .get(fixture.expand.workItemId);
      assert.ok(expandPlan);
      db.prepare(
        `
        INSERT INTO gate_actions(
          gate_action_id,work_item_id,gate,actor_id,plan_revision_id,
          verified_sha,merge_sha,ref_id,note,created_at
        ) VALUES(?,?,'final_approve','human:alice',?,NULL,?,NULL,NULL,?)
      `
      ).run(
        "verification-outage-new-provider-approval",
        fixture.expand.workItemId,
        String(expandPlan.plan_revision_id),
        MERGE_SHAS[1],
        NOW
      );
      db.prepare(
        `
        UPDATE tasks SET status='completed',started_at=?,ended_at=?,result='Implementation completed',updated_at=?
        WHERE task_id=?
      `
      ).run(NOW, NOW, NOW, implementationTask.taskId);
      db.prepare(
        `
        UPDATE work_nodes SET state='ready',current_stage='verification',updated_at=? WHERE node_id=?
      `
      ).run(NOW, node.nodeId);
      db.prepare(
        `
        UPDATE work_items SET state='reviewing',current_stage='verification',updated_at=? WHERE work_item_id=?
      `
      ).run(NOW, fixture.migrate.workItemId);
    } finally {
      db.close();
    }

    outage = true;
    fixture.board.reconcileWorkflows(fixture.consumer.projectId);
    const verificationTask = fixture.board
      .snapshot(fixture.consumer.projectId)
      .tasks.find((task) => task.status === "queued" && task.assignedRole === "verifier");
    assert.ok(verificationTask, latestNodeBlock(fixture.path, node.nodeId) ?? "verification task was not activated");
  } finally {
    fixture.board.close();
  }
});

for (const [name, invalidMarkdown] of [
  ["NUL", "bad \0 interface"],
  ["ESC", "bad \u001b interface"],
] as const) {
  test(`${name} in a residual claim-side interface read blocks without persisting a poisoned run`, async () => {
    const validMarkdown = "# Valid during readiness\n";
    let showCalls = 0;
    const fixture = await migrateReadinessFixture(`${name.toLowerCase()}-claim`, (operation) => {
      if (operation === "ls-tree") return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
      if (operation === "cat-file") return `${Buffer.byteLength(validMarkdown, "utf8")}\n`;
      showCalls += 1;
      return showCalls === 1 ? validMarkdown : invalidMarkdown;
    });

    try {
      const { node } = childNode(fixture.board, fixture.migrate);
      const implementationTask = fixture.board
        .snapshot(fixture.consumer.projectId)
        .tasks.find((task) => task.status === "queued" && task.assignedRole === "engineer");
      assert.ok(implementationTask);
      const assignedAgentId = implementationTask.assignedAgentId;
      assert.ok(assignedAgentId);
      assert.throws(
        () =>
          fixture.board.claimRun(assignedAgentId, {
            claimId: `claim-cross-repo-${name.toLowerCase()}-control`,
            messageCursor: null,
          }),
        (error: unknown) =>
          error instanceof TaskBoardError &&
          error.status === 409 &&
          error.code === "TASK_BOARD_PUBLISHED_INTERFACE_UNAVAILABLE"
      );
      assert.equal(
        latestNodeBlock(fixture.path, node.nodeId),
        `blocked: provider docs/interface.md contains prohibited characters at ${MERGE_SHAS[0]}; cancel the parent to abandon the decomposition`
      );
      const db = new DatabaseSync(fixture.path, { readOnly: true });
      try {
        assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count), 0);
        assert.equal(
          Number(
            db
              .prepare(
                `
          SELECT COUNT(*) AS count
          FROM wakeups wakeup
          WHERE wakeup.task_id=? AND wakeup.claimed_at IS NOT NULL
        `
              )
              .get(implementationTask.taskId)?.count
          ),
          0
        );
        assert.equal(
          Number(
            db
              .prepare(
                `
          SELECT COUNT(*) AS count
          FROM task_events event
          JOIN wakeups wakeup ON event.event_id='retired-wakeup:' || wakeup.wakeup_id
          WHERE wakeup.task_id=?
        `
              )
              .get(implementationTask.taskId)?.count
          ),
          1
        );
      } finally {
        db.close();
      }
    } finally {
      fixture.board.close();
    }
  });
}

test("a claim-side provider outage evicts readiness success and retries without replacement-task churn", async () => {
  const interfaceMarkdown = "# Provider outage recovery interface\n";
  let outage = false;
  let treeReads = 0;
  const fixture = await migrateReadinessFixture("claim-read-outage", (operation) => {
    if (operation === "ls-tree") treeReads += 1;
    if (outage) throw new Error("provider repository unavailable");
    if (operation === "ls-tree") {
      return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
    }
    if (operation === "cat-file") return `${Buffer.byteLength(interfaceMarkdown, "utf8")}\n`;
    return interfaceMarkdown;
  });

  try {
    const { node } = childNode(fixture.board, fixture.migrate);
    const firstTask = fixture.board
      .snapshot(fixture.consumer.projectId)
      .tasks.find((task) => task.status === "queued" && task.assignedRole === "engineer");
    assert.ok(firstTask?.assignedAgentId);
    outage = true;
    assert.throws(
      () =>
        fixture.board.claimRun(firstTask.assignedAgentId!, {
          claimId: "claim-provider-read-outage",
          messageCursor: null,
        }),
      (error: unknown) =>
        error instanceof TaskBoardError &&
        error.status === 409 &&
        error.code === "TASK_BOARD_PUBLISHED_INTERFACE_UNAVAILABLE" &&
        error.message === `blocked: provider repository unreadable at ${MERGE_SHAS[0]} — retrying`
    );

    for (let pass = 0; pass < 3; pass += 1) fixture.board.reconcileWorkflows(fixture.consumer.projectId);
    const blocked = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(
        Number(
          blocked
            .prepare(
              `
        SELECT COUNT(*) AS count FROM stage_attempts WHERE node_id=?
      `
            )
            .get(node.nodeId)?.count
        ),
        1
      );
      assert.equal(
        Number(
          blocked
            .prepare(
              `
        SELECT COUNT(*) AS count
        FROM project_events
        WHERE node_id=? AND event_type='node_blocked' AND summary=?
      `
            )
            .get(node.nodeId, `blocked: provider repository unreadable at ${MERGE_SHAS[0]} — retrying`)?.count
        ),
        1
      );
      assert.equal(
        fixture.board.snapshot(fixture.consumer.projectId).tasks.filter((task) => task.assignedRole === "engineer")
          .length,
        1
      );
    } finally {
      blocked.close();
    }
    assert.ok(treeReads >= 4, `expected an uncached read on each outage pass, received ${treeReads}`);

    outage = false;
    fixture.board.reconcileWorkflows(fixture.consumer.projectId);
    const replacement = fixture.board
      .snapshot(fixture.consumer.projectId)
      .tasks.filter((task) => task.assignedRole === "engineer" && task.taskId !== firstTask.taskId);
    assert.equal(replacement.length, 1);
    assert.equal(replacement[0]?.status, "queued");
  } finally {
    fixture.board.close();
  }
});

test("Migrate readiness and claim share the bounded worker projection", async () => {
  const interfaceMarkdown = "# Bounded projection interface\n";
  const fixture = await boardFixture(undefined, undefined, {
    git: crossRepoGit((operation) => {
      if (operation === "ls-tree") return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
      if (operation === "cat-file") return `${Buffer.byteLength(interfaceMarkdown, "utf8")}\n`;
      return interfaceMarkdown;
    }),
    mergePipeline: () => ({ kind: "merged", mergeSha: MERGE_SHAS[0] }),
  });
  const provider = fixture.board.createProject({
    name: "Bounded projection provider",
    description: "Publishes the bounded interface.",
    repoPath: "/repos/claim-provider",
  });
  const consumer = fixture.board.createProject({
    name: "Bounded projection consumer",
    description: "P".repeat(6_000),
    repoPath: "/repos/claim-consumer",
  });
  const engineer = fixture.board.createAgent(consumer.projectId, {
    agentId: "bounded-projection-engineer",
    role: "engineer",
    area: "bounded projection",
    mission: "M".repeat(4_000),
    model: "test-model",
    token: "bounded-projection-token-0123456789abcdef",
  });

  try {
    const children = phasedChildren(provider.projectId, consumer.projectId, "bounded-projection").map((child) =>
      child.phase === "migrate"
        ? { ...child, acceptanceCriteria: ["A".repeat(2_000), "B".repeat(2_000), "C".repeat(2_000)] }
        : child
    );
    const decomposition = proposeParent(
      fixture.board,
      provider.projectId,
      children,
      "bounded-projection",
      "blast_radius"
    );
    const [expand, migrate] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    forceMergedWithApproval(fixture.path, expand.workItemId, MERGE_SHAS[0]);
    fixture.board.reconcileWorkflows(consumer.projectId);

    const task = await waitForQueuedRoleTask(fixture.board, consumer.projectId, "engineer");
    assert.equal(task.assignedAgentId, engineer.agentId);
    const claim = fixture.board.claimRun(engineer.agentId, {
      claimId: "claim-bounded-migrate-projection",
      messageCursor: null,
    });
    assert.ok(claim);
    const mapped = mapClaimContext(parseClaimRunResult(claim), null);
    assert.ok(mapped);
    assert.equal(mapped.mission.mission.length, 1_996);
    assert.match(mapped.mission.mission, /\n\[truncated\]$/u);
    assert.equal(mapped.projectMemory.length, 3_996);
    assert.match(mapped.projectMemory, /\n\[truncated\]$/u);
    assert.equal(mapped.task.acceptanceCriteria.length, 3_996);
    assert.match(mapped.task.acceptanceCriteria, /\n\[truncated\]$/u);
    assert.equal(mapped.crossRepoContext?.markdown, interfaceMarkdown);
  } finally {
    fixture.board.close();
  }
});

test("a Migrate fix round previews its reusable orphan with the prior non-zero cursor", async () => {
  const interfaceMarkdown = "I".repeat(60 * 1_024);
  const fixture = await boardFixture(undefined, undefined, {
    git: crossRepoGit((operation) => {
      if (operation === "ls-tree") return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
      if (operation === "cat-file") return `${Buffer.byteLength(interfaceMarkdown, "utf8")}\n`;
      return interfaceMarkdown;
    }),
    mergePipeline: () => ({ kind: "merged", mergeSha: MERGE_SHAS[0] }),
  });
  const provider = fixture.board.createProject({
    name: "Fix-round preview provider",
    description: "Publishes the interface used by the migration fix.",
    repoPath: "/repos/claim-provider",
  });
  const consumer = fixture.board.createProject({
    name: "Fix-round preview consumer",
    description: "Claims a fresh migration fix task without prior-task history.",
    repoPath: "/repos/claim-consumer",
  });
  const engineer = fixture.board.createAgent(consumer.projectId, {
    agentId: "fix-round-preview-engineer",
    role: "engineer",
    area: "migration fixes",
    mission: "Apply the bounded migration fix.",
    model: "test-model",
    token: "fix-round-preview-token-0123456789abcdef",
  });

  try {
    const decomposition = proposeParent(
      fixture.board,
      provider.projectId,
      phasedChildren(provider.projectId, consumer.projectId, "fix-round-preview"),
      "fix-round-preview",
      "blast_radius"
    );
    const [expand, migrate] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    const { node } = childNode(fixture.board, migrate);

    const priorTask = fixture.board.createTask(
      consumer.projectId,
      taskRequest({
        title: "Terminal prior Migrate implementation",
        objective: "Carry enough terminal history to overflow the wrong readiness projection.",
        acceptanceCriteria: "The next attempt must not inherit this task's history.",
        assignedAgentId: engineer.agentId,
        assignedRole: engineer.role,
        requiresReview: false,
      })
    );
    for (let index = 0; index < 12; index += 1) {
      fixture.board.appendHumanMessage(priorTask.taskId, {
        clientEventId: `fix-round-prior-message-${index}`,
        kind: "note",
        body: `${index}:`.padEnd(2_000, "h"),
      });
    }
    const priorClaim = fixture.board.claimRun(engineer.agentId, {
      claimId: "claim-fix-round-heavy-prior",
      messageCursor: 0,
    });
    assert.ok(priorClaim);
    for (let index = 0; index < 64; index += 1) {
      fixture.board.createTaskPhase(
        priorTask.taskId,
        {
          title: `${index}:`.padEnd(240, "p"),
          stage: "execution",
          parallelGroup: `prior-${index}`,
        },
        engineer.agentId
      );
    }
    fixture.board.settleRun(priorClaim.run.runId, engineer.agentId, {
      outcome: "completed",
      result: "The heavy prior Migrate task is terminal.",
    });

    const title = `implementation: ${node.title}`;
    const acceptanceCriteria = node.acceptanceCriteria.join("\n");
    const orphan = fixture.board.createTask(
      consumer.projectId,
      taskRequest({
        title,
        objective: node.objective,
        acceptanceCriteria,
        workspaceRefs: [],
        assignedAgentId: engineer.agentId,
        assignedRole: engineer.role,
        requiresReview: false,
      })
    );
    let orphanCursor = 0;
    for (let index = 0; index < 12; index += 1) {
      const message = fixture.board.appendHumanMessage(orphan.taskId, {
        clientEventId: `fix-round-orphan-message-${index}`,
        kind: "note",
        body: `${index}:`.padEnd(2_000, "o"),
      });
      orphanCursor = message.sequence;
    }
    const orphanClaim = fixture.board.claimRun(engineer.agentId, {
      claimId: "claim-fix-round-orphan-cursor",
      messageCursor: orphanCursor,
    });
    assert.ok(orphanClaim);
    assert.equal(orphanClaim.context.messageCursor, orphanCursor);
    assert.deepEqual(orphanClaim.context.messages, []);
    fixture.board.settleRun(orphanClaim.run.runId, engineer.agentId, {
      outcome: "interrupted",
      result: "Retry this unlinked activation task for the fix round.",
    });
    const interruptedOrphan = fixture.board.requireTask(orphan.taskId);
    fixture.board.retryTask(orphan.taskId, { version: interruptedOrphan.version });

    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare(
        `
        INSERT INTO stage_attempts(attempt_id,node_id,task_id,stage,attempt,skill_digests_json)
        VALUES(?,?,?,'implementation',1,'{}')
      `
      ).run("fix-round-heavy-prior-attempt", node.nodeId, priorTask.taskId);
      db.prepare(
        `
        UPDATE plan_revisions
        SET assumptions_json=?
        WHERE work_item_id=? AND state='confirmed'
      `
      ).run(JSON.stringify(Array.from({ length: 46 }, () => "a".repeat(4_000))), migrate.workItemId);
      db.prepare(
        `
        UPDATE work_nodes
        SET state='ready',current_stage='implementation',version=version+1,updated_at=?
        WHERE node_id=?
      `
      ).run(NOW, node.nodeId);
      db.prepare(
        `
        UPDATE work_items
        SET state='fixing',current_stage='implementation',version=version+1,updated_at=?
        WHERE work_item_id=?
      `
      ).run(NOW, migrate.workItemId);
    } finally {
      db.close();
    }
    forceMergedWithApproval(fixture.path, expand.workItemId, MERGE_SHAS[0]);

    fixture.board.reconcileWorkflows(consumer.projectId);

    assert.equal(childNode(fixture.board, migrate).node.state, "active");
    assert.equal(fixture.board.requireTask(orphan.taskId).status, "queued");
    const linked = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(
        Number(
          linked
            .prepare(
              `
        SELECT COUNT(*) AS count
        FROM stage_attempts
        WHERE node_id=? AND task_id=? AND stage='implementation' AND attempt=2
      `
            )
            .get(node.nodeId, orphan.taskId)?.count
        ),
        1
      );
    } finally {
      linked.close();
    }
    const fixClaim = fixture.board.claimRun(engineer.agentId, {
      claimId: "claim-fix-round-reused-orphan",
      messageCursor: orphanCursor,
    });
    assert.ok(fixClaim);
    assert.equal(fixClaim.task?.taskId, orphan.taskId);
    assert.equal(fixClaim.context.messageCursor, orphanCursor);
    assert.deepEqual(fixClaim.context.messages, []);
  } finally {
    fixture.board.close();
  }
});

test("oversized assembled Migrate context blocks readiness once without replacement-task churn", async () => {
  const interfaceMarkdown = "I".repeat(60 * 1_024);
  const fixture = await boardFixture(undefined, undefined, {
    git: crossRepoGit((operation) => {
      if (operation === "ls-tree") return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
      if (operation === "cat-file") return `${Buffer.byteLength(interfaceMarkdown, "utf8")}\n`;
      return interfaceMarkdown;
    }),
    mergePipeline: () => ({ kind: "merged", mergeSha: MERGE_SHAS[0] }),
  });
  const provider = fixture.board.createProject({
    name: "Aggregate readiness provider",
    description: "Publishes the interface consumed by Migrate.",
    repoPath: "/repos/claim-provider",
  });
  const consumer = fixture.board.createProject({
    name: "Aggregate readiness consumer",
    description: "Consumes the published provider interface.",
    repoPath: "/repos/claim-consumer",
  });

  try {
    const decomposition = proposeParent(
      fixture.board,
      provider.projectId,
      phasedChildren(provider.projectId, consumer.projectId, "aggregate-context-bound"),
      "aggregate-context-bound",
      "blast_radius"
    );
    const [expand, migrate] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    const { node } = childNode(fixture.board, migrate);
    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare(
        `
        UPDATE plan_revisions
        SET assumptions_json=?
        WHERE work_item_id=? AND state='confirmed'
      `
      ).run(JSON.stringify(Array.from({ length: 52 }, () => "a".repeat(4_000))), migrate.workItemId);
    } finally {
      db.close();
    }

    forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);
    fixture.board.reconcileWorkflows(provider.projectId);
    fixture.board.reconcileWorkflows(consumer.projectId);
    fixture.board.reconcileWorkflows(consumer.projectId);
    assert.match(
      latestNodeBlock(fixture.path, node.nodeId) ?? "",
      /^blocked: assembled context \d+ KiB exceeds 256 KiB budget$/u
    );
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(Number(inspected.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count), 0);
      assert.equal(
        Number(
          inspected
            .prepare(
              `
        SELECT COUNT(*) AS count FROM stage_attempts WHERE node_id=?
      `
            )
            .get(node.nodeId)?.count
        ),
        0
      );
      assert.equal(
        Number(
          inspected
            .prepare(
              `
        SELECT COUNT(*) AS count
        FROM project_events
        WHERE node_id=? AND event_type='node_blocked'
          AND summary GLOB 'blocked: assembled context * KiB exceeds 256 KiB budget'
      `
            )
            .get(node.nodeId)?.count
        ),
        1
      );
    } finally {
      inspected.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("a hazardous Migrate claim carries its interface inside the design-record budget", async () => {
  const interfaceMarkdown = "I".repeat(60 * 1_024);
  const fixture = await boardFixture(undefined, undefined, {
    git: crossRepoGit((operation) => {
      if (operation === "ls-tree") return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
      if (operation === "cat-file") return `${Buffer.byteLength(interfaceMarkdown, "utf8")}\n`;
      return interfaceMarkdown;
    }),
    mergePipeline: () => ({ kind: "merged", mergeSha: MERGE_SHAS[0] }),
  });
  const provider = fixture.board.createProject({
    name: "Hazardous interface provider",
    description: "Publishes the interface for a hazardous migration.",
    repoPath: "/repos/claim-provider",
  });
  const consumer = fixture.board.createProject({
    name: "Hazardous interface consumer",
    description: "Designs and executes the hazardous migration.",
    repoPath: "/repos/claim-consumer",
  });

  try {
    const decomposition = proposeParent(
      fixture.board,
      provider.projectId,
      phasedChildren(provider.projectId, consumer.projectId, "hazardous-context-budget"),
      "hazardous-context-budget",
      "blast_radius",
      "hazardous"
    );
    const [expand, migrate] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare(
        `
        UPDATE plan_revisions
        SET assumptions_json=?
        WHERE work_item_id=? AND state='confirmed'
      `
      ).run(JSON.stringify(Array.from({ length: 52 }, () => "a".repeat(4_000))), migrate.workItemId);
    } finally {
      db.close();
    }

    forceMergedWithApproval(fixture.path, expand.workItemId, MERGE_SHAS[0]);
    fixture.board.reconcileWorkflows(consumer.projectId);
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "designing");
    const designTask = await waitForQueuedRoleTask(fixture.board, consumer.projectId, "manager");
    assert.ok(designTask.assignedAgentId);
    const design = fixture.board.claimRun(designTask.assignedAgentId, {
      claimId: "claim-hazardous-migrate-design",
      messageCursor: null,
    });
    assert.ok(design);
    fixture.board.settleRun(design.run.runId, designTask.assignedAgentId, {
      outcome: "completed",
      result: "The hazardous Migrate design is confirmed.",
      designRecord: hazardousDesignRecord(),
    });

    const implementationTask = await waitForQueuedRoleTask(fixture.board, consumer.projectId, "engineer");
    assert.ok(implementationTask.assignedAgentId);
    const claim = fixture.board.claimRun(implementationTask.assignedAgentId, {
      claimId: "claim-hazardous-migrate-implementation",
      messageCursor: null,
    });
    assert.ok(claim);
    const mapped = mapClaimContext(parseClaimRunResult(claim), null);
    assert.ok(mapped);
    const bytes = Buffer.byteLength(JSON.stringify(mapped), "utf8");
    assert.ok(bytes > MAX_AGENT_CONTEXT_BYTES, `${bytes} should exceed the ordinary context budget`);
    assert.ok(bytes <= MAX_DESIGN_CONTEXT_BYTES, `${bytes} should fit the design-record budget`);
    assert.equal(mapped.workflow?.pipeline?.tier, "hazardous");
    assert.ok(mapped.workflow?.pipeline?.designRecord);
    assert.equal(mapped.crossRepoContext?.markdown, interfaceMarkdown);
  } finally {
    fixture.board.close();
  }
});

test("a claim-time aggregate block is re-evaluated against the next task shape", async () => {
  const interfaceMarkdown = "# Residual aggregate interface\n";
  const fixture = await migrateReadinessFixture(
    "residual-aggregate-key",
    (operation) => {
      if (operation === "ls-tree") return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
      if (operation === "cat-file") return `${Buffer.byteLength(interfaceMarkdown, "utf8")}\n`;
      return interfaceMarkdown;
    },
    ["writing-design-docs"]
  );

  try {
    const { node } = childNode(fixture.board, fixture.migrate);
    const firstTask = fixture.board
      .snapshot(fixture.consumer.projectId)
      .tasks.find((task) => task.status === "queued" && task.assignedRole === "engineer");
    assert.ok(firstTask?.assignedAgentId);
    fixture.board.appendHumanMessage(firstTask.taskId, {
      clientEventId: "residual-aggregate-context-message",
      kind: "note",
      body: "Preserve this queued-task message in the readiness digest.",
    });
    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare(
        `
        UPDATE plan_revisions
        SET assumptions_json=?
        WHERE work_item_id=? AND state='confirmed'
      `
      ).run(JSON.stringify(Array.from({ length: 54 }, () => "a".repeat(5_000))), fixture.migrate.workItemId);
    } finally {
      db.close();
    }

    assert.throws(
      () =>
        fixture.board.claimRun(firstTask.assignedAgentId!, {
          claimId: "claim-residual-aggregate-key",
          messageCursor: null,
        }),
      (error: unknown) =>
        error instanceof TaskBoardError &&
        error.status === 409 &&
        error.code === "TASK_BOARD_PUBLISHED_INTERFACE_UNAVAILABLE"
    );
    const residualReason = "blocked: persisted claim-side residual digest matched";
    const keyed = new DatabaseSync(fixture.path);
    try {
      const event = keyed
        .prepare(
          `
        SELECT event_id,json_extract(data_json,'$.interfaceContextDigest') AS digest
        FROM task_events
        WHERE task_id=? AND event_type='task_cancelled'
          AND json_extract(data_json,'$.interfaceExpandSha')=?
        ORDER BY created_at DESC,rowid DESC
        LIMIT 1
      `
        )
        .get(firstTask.taskId, MERGE_SHAS[0]);
      assert.match(String(event?.digest), /^[0-9a-f]{64}$/u);
      assert.equal(
        Number(
          keyed
            .prepare(
              `
        UPDATE task_events
        SET data_json=json_set(data_json,'$.reason',?)
        WHERE event_id=?
      `
            )
            .run(residualReason, String(event?.event_id)).changes
        ),
        1
      );
    } finally {
      keyed.close();
    }
    for (let pass = 0; pass < 3; pass += 1) fixture.board.reconcileWorkflows(fixture.consumer.projectId);
    assert.match(
      latestNodeBlock(fixture.path, node.nodeId) ?? "",
      /^blocked: assembled context \d+ KiB exceeds 256 KiB budget$/u
    );
    const blocked = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(
        Number(
          blocked
            .prepare(
              `
        SELECT COUNT(*) AS count FROM stage_attempts WHERE node_id=?
      `
            )
            .get(node.nodeId)?.count
        ),
        1
      );
      assert.equal(
        Number(
          blocked
            .prepare(
              `
        SELECT COUNT(*) AS count
        FROM task_events
        WHERE task_id=? AND event_type='task_cancelled'
          AND json_extract(data_json,'$.interfaceExpandSha')=?
          AND json_extract(data_json,'$.interfaceContextDigest') IS NOT NULL
      `
            )
            .get(firstTask.taskId, MERGE_SHAS[0])?.count
        ),
        1
      );
    } finally {
      blocked.close();
    }

    const changed = new DatabaseSync(fixture.path);
    try {
      changed
        .prepare(
          `
        UPDATE plan_revisions SET assumptions_json='[]'
        WHERE work_item_id=? AND state='confirmed'
      `
        )
        .run(fixture.migrate.workItemId);
    } finally {
      changed.close();
    }
    fixture.board.reconcileWorkflows(fixture.consumer.projectId);
    const replacement = fixture.board
      .snapshot(fixture.consumer.projectId)
      .tasks.filter((task) => task.assignedRole === "engineer" && task.taskId !== firstTask.taskId);
    assert.equal(replacement.length, 1);
    assert.equal(replacement[0]?.status, "queued");
  } finally {
    fixture.board.close();
  }
});

test("legacy Migrate claim replay reports a typed interface failure", async () => {
  const interfaceMarkdown = "# Legacy replay interface\n";
  let showCalls = 0;
  const fixture = await migrateReadinessFixture("legacy-replay-typed", (operation) => {
    if (operation === "ls-tree") return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
    if (operation === "cat-file") return `${Buffer.byteLength(interfaceMarkdown, "utf8")}\n`;
    showCalls += 1;
    return showCalls <= 2 ? interfaceMarkdown : "invalid \0 interface";
  });

  try {
    const implementationTask = fixture.board
      .snapshot(fixture.consumer.projectId)
      .tasks.find((task) => task.status === "queued" && task.assignedRole === "engineer");
    assert.ok(implementationTask?.assignedAgentId);
    const request = { claimId: "claim-migrate-legacy-replay-typed", messageCursor: null } as const;
    const first = fixture.board.claimRun(implementationTask.assignedAgentId, request);
    assert.ok(first);
    const db = new DatabaseSync(fixture.path);
    try {
      assert.equal(
        Number(db.prepare("UPDATE runs SET claim_result_json=NULL WHERE run_id=?").run(first.run.runId).changes),
        1
      );
    } finally {
      db.close();
    }
    assert.throws(
      () => fixture.board.claimRun(implementationTask.assignedAgentId!, request),
      (error: unknown) =>
        error instanceof TaskBoardError &&
        error.status === 409 &&
        error.code === "TASK_BOARD_PUBLISHED_INTERFACE_UNAVAILABLE"
    );
  } finally {
    fixture.board.close();
  }
});

test("a duplicate deploy attestation retries Contract readiness reconciliation", async () => {
  let failNextContractRefresh = false;
  const fixture = await boardFixture(undefined, undefined, {
    git() {
      if (failNextContractRefresh) {
        failNextContractRefresh = false;
        throw new Error("injected Contract base refresh failure");
      }
      return `${BASE_SHA}\n`;
    },
  });
  const consumer = fixture.board.createProject({
    name: "Attestation retry consumer",
    description: "Owns the migrate phase for duplicate attestation recovery.",
    repoPath: "/repos/attestation-retry-consumer",
  });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      phasedChildren(fixture.project.projectId, consumer.projectId, "duplicate-attestation"),
      "duplicate-attestation-reconcile",
      "blast_radius"
    );
    const [expand, migrate, contract] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    assert.ok(contract);
    forceMergedWithApproval(fixture.path, expand.workItemId, MERGE_SHAS[0]);
    forceMergedWithApproval(fixture.path, migrate.workItemId, MERGE_SHAS[1]);
    fixture.board.attestDeploy(migrate.workItemId, { note: "Consumer deployed." });

    failNextContractRefresh = true;
    const first = fixture.board.attestDeploy(expand.workItemId, { note: "Provider deployed." });
    assert.equal(first.duplicate, false);
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "queued");

    const duplicate = fixture.board.attestDeploy(expand.workItemId, { note: "Retry readiness." });

    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.gateAction.gateActionId, first.gateAction.gateActionId);
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "implementing");
    assert.equal(childNode(fixture.board, contract).node.state, "active");
  } finally {
    fixture.board.close();
  }
});

test("phased automatic merge withdraws an approval when the provider base advances and merges after re-verification", async () => {
  const verifiedByBranch = new Map<string, string>();
  let providerHead = BASE_SHA;
  let mergeCalls = 0;
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      if (arguments_.includes("--abbrev-ref")) return "main\n";
      if (arguments_.includes("--porcelain")) return "";
      if (arguments_.includes("merge-base")) return "";
      const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
      if (verifiedRef !== undefined) {
        return `${verifiedByBranch.get(verifiedRef.slice(0, -"^{commit}".length)) ?? BASE_SHA}\n`;
      }
      if (arguments_.includes("rev-parse") && arguments_.at(-1) === "HEAD") return `${providerHead}\n`;
      throw new Error(`unexpected git command: ${arguments_.join(" ")}`);
    },
    mergePipeline() {
      mergeCalls += 1;
      return { kind: "merged", mergeSha: MERGE_SHAS[0] };
    },
  });
  const consumer = fixture.board.createProject({
    name: "Base-advance consumer",
    description: "Waits behind the re-verified Expand child.",
    repoPath: "/repos/base-advance-consumer",
  });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "expand",
          objective: "Expand the provider before its base advances.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/base-advance-expand", "docs/interface.md"],
          acceptanceCriteria: ["Stale verification never merges."],
          phase: "expand",
          splitBy: "phase",
        },
        {
          key: "migrate",
          objective: "Wait for the re-verified expansion.",
          projectId: consumer.projectId,
          declaredScope: ["src/base-advance-migrate"],
          acceptanceCriteria: ["Migration starts only after expansion merges."],
          phase: "migrate",
          splitBy: "consumer",
          dependsOn: ["expand"],
        },
        {
          key: "contract",
          objective: "Remain downstream of migration deployment.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/base-advance-contract", "docs/interface.md"],
          acceptanceCriteria: ["Contraction remains gated."],
          phase: "contract",
          splitBy: "phase",
          dependsOn: ["migrate"],
        },
      ],
      "phased-base-advance",
      "blast_radius"
    );
    const [expand] = decomposition.children;
    assert.ok(expand);
    verifiedByBranch.set(expand.pipelineBranch!, VERIFIED_SHAS[0]);
    forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);
    providerHead = ADVANCED_SHA;

    fixture.board.reconcileWorkflows(fixture.project.projectId);

    const withdrawn = fixture.board.requireWorkItem(expand.workItemId);
    assert.equal(withdrawn.state, "implementing");
    assert.equal(withdrawn.baseSha, ADVANCED_SHA);
    assert.equal(mergeCalls, 0);
    assert.ok(
      fixture.board
        .listNotifications()
        .unread.some(
          (notification) =>
            notification.kind === "final_approval_withdrawn" &&
            notification.workItemId === expand.workItemId &&
            notification.dedupeKey === `final_approval_withdrawn:${expand.workItemId}:${ADVANCED_SHA}`
        )
    );

    verifiedByBranch.set(expand.pipelineBranch!, VERIFIED_SHAS[1]);
    forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[1]);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "merged");
    assert.equal(mergeCalls, 1);
  } finally {
    fixture.board.close();
  }
});

for (const inspection of ["diverged", "repo_busy"] as const) {
  test(`phased automatic merge handles a ${inspection} base inspection without calling merge`, async (t) => {
    let inspectionMode: "unchanged" | typeof inspection = "unchanged";
    let mergeCalls = 0;
    const fixture = await boardFixture(undefined, undefined, {
      git(arguments_) {
        if (arguments_.includes("--abbrev-ref")) {
          return inspectionMode === "repo_busy" ? "HEAD\n" : "main\n";
        }
        if (arguments_.includes("--porcelain")) return "";
        if (arguments_.includes("merge-base")) {
          if (inspectionMode === "diverged") {
            throw Object.assign(new Error("not an ancestor"), { status: 1 });
          }
          return "";
        }
        const verifiedRef = arguments_.find((argument) => argument.endsWith("^{commit}"));
        if (verifiedRef !== undefined) return `${VERIFIED_SHAS[0]}\n`;
        if (arguments_.includes("rev-parse") && arguments_.at(-1) === "HEAD") {
          return `${inspectionMode === "diverged" ? ADVANCED_SHA : BASE_SHA}\n`;
        }
        throw new Error(`unexpected git command: ${arguments_.join(" ")}`);
      },
      mergePipeline() {
        mergeCalls += 1;
        return { kind: "merged", mergeSha: MERGE_SHAS[0] };
      },
    });
    const logged = t.mock.method(console, "info", () => undefined);
    try {
      const consumer = fixture.board.createProject({
        name: `${inspection} guard consumer`,
        description: `Hosts the ${inspection} guard migration.`,
        repoPath: `/repos/${inspection}-guard-consumer`,
      });
      const decomposition = proposeParent(
        fixture.board,
        fixture.project.projectId,
        phasedChildren(fixture.project.projectId, consumer.projectId, `${inspection}-guard`),
        `phased-${inspection}-guard`,
        "blast_radius"
      );
      const [expand] = decomposition.children;
      assert.ok(expand);
      forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);
      inspectionMode = inspection;

      fixture.board.reconcileWorkflows(fixture.project.projectId);

      assert.equal(mergeCalls, 0);
      if (inspection === "diverged") {
        assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "parked");
        assert.deepEqual(latestParkRecord(fixture.path, expand.workItemId), {
          category: "base_diverged",
          reason: `base branch history rewritten (was ${BASE_SHA}, now ${ADVANCED_SHA})`,
        });
        assert.ok(
          fixture.board
            .listNotifications()
            .unread.some(
              (notification) =>
                notification.kind === "final_approval_withdrawn" &&
                notification.workItemId === expand.workItemId &&
                notification.dedupeKey === `final_approval_withdrawn:${expand.workItemId}:base-diverged:${ADVANCED_SHA}`
            )
        );
        const resumed = fixture.board.resumeWorkItem(expand.workItemId);
        assert.equal(resumed.state, "implementing");
        assert.equal(resumed.currentStage, "implementation");
        assert.equal(resumed.baseSha, ADVANCED_SHA);
        const inspected = new DatabaseSync(fixture.path, { readOnly: true });
        try {
          assert.equal(
            inspected
              .prepare(
                `
            SELECT COUNT(*) AS count
            FROM park_records
            WHERE work_item_id=? AND resolved_at IS NULL
          `
              )
              .get(expand.workItemId)?.count,
            0
          );
        } finally {
          inspected.close();
        }
      } else {
        assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "final_approval");
        assert.ok(
          logged.mock.calls.some(
            (call) =>
              call.arguments[0] === "[task-board] phased automatic merge skipped" &&
              typeof call.arguments[1] === "object" &&
              call.arguments[1] !== null &&
              (call.arguments[1] as { childWorkItemId?: unknown }).childWorkItemId === expand.workItemId
          )
        );
      }
    } finally {
      fixture.board.close();
    }
  });
}

test("board pause skips the whole decomposition policy pass until work resumes", async (t) => {
  let mergeCalls = 0;
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      if (arguments_.includes("--abbrev-ref")) return "main\n";
      if (arguments_.includes("--porcelain")) return "";
      if (arguments_.some((argument) => argument.endsWith("^{commit}"))) return `${VERIFIED_SHAS[0]}\n`;
      if (arguments_.includes("rev-parse")) return `${BASE_SHA}\n`;
      throw new Error(`unexpected git command: ${arguments_.join(" ")}`);
    },
    mergePipeline() {
      mergeCalls += 1;
      return { kind: "merged", mergeSha: MERGE_SHAS[0] };
    },
  });
  try {
    const consumer = fixture.board.createProject({
      name: "Paused policy consumer",
      description: "Hosts migration work held behind the board pause.",
      repoPath: "/repos/paused-policy-consumer",
    });
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      phasedChildren(fixture.project.projectId, consumer.projectId, "paused-policy"),
      "paused-policy",
      "blast_radius"
    );
    const [expand] = decomposition.children;
    assert.ok(expand);
    forceFinalApproval(fixture.path, expand.workItemId, VERIFIED_SHAS[0]);
    const initialPause = fixture.board.getBoardPause();
    fixture.board.setBoardPause({
      paused: true,
      reason: "Hold all automatic decomposition policy actions.",
      version: initialPause.version,
      actor: "human:alice",
    });
    const logged = t.mock.method(console, "info", () => undefined);

    fixture.board.reconcileWorkflows(fixture.project.projectId);

    assert.equal(mergeCalls, 0);
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "final_approval");
    assert.equal(logged.mock.callCount(), 1);
    assert.equal(logged.mock.calls[0]?.arguments[0], "[task-board] decomposition policy reconciliation skipped");
    assert.deepEqual(logged.mock.calls[0]?.arguments[1], {
      reason: "board_paused",
      projectId: fixture.project.projectId,
    });

    const paused = fixture.board.getBoardPause();
    fixture.board.setBoardPause({
      paused: false,
      reason: null,
      version: paused.version,
      actor: "human:alice",
    });
    fixture.board.resumePausedWork();
    assert.equal(mergeCalls, 1);
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "merged");
  } finally {
    fixture.board.close();
  }
});

test("decomposition reconciliation fails closed when the board pause row is missing", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "pause-row-guard",
          objective: "Keep policy work behind the durable pause row.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/pause-row-guard"],
          acceptanceCriteria: ["A missing pause row fails closed."],
        },
      ],
      "missing-pause-row"
    );
    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare("DELETE FROM board_pause WHERE pause_id='board'").run();
    } finally {
      db.close();
    }

    assert.throws(
      () => fixture.board.reconcileWorkflows(fixture.project.projectId),
      /TASK_BOARD_DATABASE_CORRUPT:board_pause/u
    );
  } finally {
    fixture.board.close();
  }
});

test("base-branch withdrawal also withdraws a feature parent's pending approval", async () => {
  let targetHead = BASE_SHA;
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      if (arguments_.includes("--abbrev-ref")) return "main\n";
      if (arguments_.includes("--porcelain")) return "";
      if (arguments_.includes("--is-ancestor")) return "";
      if (arguments_.includes("HEAD") || arguments_.includes("--verify")) return `${targetHead}\n`;
      return `${targetHead}\n`;
    },
  });
  try {
    const { parent, children } = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "one",
          objective: "Prepare the first child.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/withdraw-one"],
          acceptanceCriteria: ["The first child is ready."],
        },
        {
          key: "two",
          objective: "Prepare the second child.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/withdraw-two"],
          acceptanceCriteria: ["The second child is ready."],
        },
      ],
      "withdraw-parent"
    );
    for (const [index, child] of children.entries()) {
      forceFinalApproval(fixture.path, child.workItemId, VERIFIED_SHAS[index]!);
    }
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "final_approval");
    targetHead = ADVANCED_SHA;
    const sweep = fixture.board.sweepBaseBranch(NOW);
    assert.equal(sweep.withdrawn, 2);
    assert.equal(fixture.board.requireWorkItem(parent.workItemId).state, "coordinating");
    assert.ok(
      fixture.board
        .listNotifications()
        .unread.some(
          (notification) =>
            notification.kind === "final_approval_withdrawn" &&
            notification.workItemId === parent.workItemId &&
            notification.dedupeKey?.startsWith(`final_approval_withdrawn:${parent.workItemId}:`) === true
        )
    );
  } finally {
    fixture.board.close();
  }
});

test("an abandoned or dead-lettered child parks its parent as child_failed", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  const first = proposeParent(
    fixture.board,
    fixture.project.projectId,
    [
      {
        key: "abandoned",
        objective: "Exercise abandoned-child propagation.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/abandoned"],
        acceptanceCriteria: ["The parent is parked."],
      },
    ],
    "abandoned-child"
  );
  const [abandonedChild] = first.children;
  assert.ok(abandonedChild);
  try {
    fixture.board.updateWorkItem(abandonedChild.workItemId, {
      action: "cancel",
      version: fixture.board.requireWorkItem(abandonedChild.workItemId).version,
      reason: "The child cannot proceed.",
    });
    assert.equal(fixture.board.requireWorkItem(first.parent.workItemId).state, "parked");
    assert.deepEqual(latestParkRecord(fixture.path, first.parent.workItemId), {
      category: "child_failed",
      reason: `Child ${abandonedChild.workItemId} was abandoned`,
    });

    const second = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "dead-lettered",
          objective: "Exercise dead-letter propagation.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/dead-lettered"],
          acceptanceCriteria: ["The second parent is parked."],
        },
      ],
      "dead-letter-child"
    );
    const [deadChild] = second.children;
    assert.ok(deadChild);
    fixture.board.close();
    const store = await TaskBoardStore.open(fixture.path);
    new TaskBoardRuntime(config(fixture.path), store);
    try {
      store.transaction(() => {
        transitionWorkItemInTransaction(store, {
          workItemId: deadChild.workItemId,
          to: "dead_letter",
          actorType: "system",
          actorId: "system:test",
          now: NOW,
          endedAt: NOW,
          currentStage: null,
        });
      });
      const parent = store.db
        .prepare("SELECT state FROM work_items WHERE work_item_id=?")
        .get(second.parent.workItemId);
      assert.equal(parent?.state, "parked");
      const park = store.db
        .prepare(
          `
        SELECT category,reason
        FROM park_records
        WHERE work_item_id=?
        ORDER BY rowid DESC
        LIMIT 1
      `
        )
        .get(second.parent.workItemId);
      assert.equal(park?.category, "child_failed");
      assert.equal(park?.reason, `Child ${deadChild.workItemId} was dead-lettered`);
    } finally {
      store.close();
    }
  } finally {
    try {
      fixture.board.close();
    } catch {
      // The dead-letter branch closes the board before opening the store directly.
    }
  }
});

test("resuming a child-failure park abandons the dead-lettered child and completes through the remaining child", async () => {
  const fixture = await boardFixture(undefined, undefined, {
    git(arguments_) {
      const inspection = staticCleanFanOutInspection(arguments_, VERIFIED_SHAS[0]);
      return inspection ?? `${VERIFIED_SHAS[0]}\n`;
    },
    mergePipeline: () => ({ kind: "merged", mergeSha: MERGE_SHAS[0] }),
  });
  const decomposition = proposeParent(
    fixture.board,
    fixture.project.projectId,
    [
      {
        key: "failed",
        objective: "Dead-letter this child to park the parent.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/unpark-failed"],
        acceptanceCriteria: ["The failure parks the parent."],
      },
      {
        key: "remaining",
        objective: "Continue after the parent is unparked.",
        projectId: fixture.project.projectId,
        declaredScope: ["src/unpark-remaining"],
        acceptanceCriteria: ["This child can still merge."],
      },
    ],
    "child-failure-unpark"
  );
  const [failed, remaining] = decomposition.children;
  assert.ok(failed);
  assert.ok(remaining);
  try {
    const store = await TaskBoardStore.open(fixture.path);
    new TaskBoardRuntime(config(fixture.path), store);
    try {
      store.transaction(() => {
        transitionWorkItemInTransaction(store, {
          workItemId: failed.workItemId,
          to: "dead_letter",
          actorType: "system",
          actorId: "system:test-dead-letter",
          now: NOW,
          endedAt: NOW,
          currentStage: null,
        });
      });
    } finally {
      store.close();
    }
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "parked");
    assert.throws(
      () => fixture.board.resumeWorkItem(remaining.workItemId),
      (error: unknown) => error instanceof TaskBoardError && error.status === 409
    );

    const resumed = fixture.board.resumeWorkItem(decomposition.parent.workItemId);
    assert.equal(resumed.state, "coordinating");
    assert.deepEqual(latestTransitionActor(fixture.path, decomposition.parent.workItemId), {
      actorType: "human",
      actorId: "human:alice",
    });
    assert.equal(fixture.board.requireWorkItem(remaining.workItemId).state, "implementing");
    forceFinalApproval(fixture.path, remaining.workItemId, VERIFIED_SHAS[0]);
    fixture.board.reconcileWorkflows(fixture.project.projectId);
    const promoted = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(promoted.state, "final_approval");

    const merged = await fixture.board.approvePipelineMerge(promoted.workItemId, { version: promoted.version });

    assert.equal(merged.state, "merged");
    assert.equal(fixture.board.requireWorkItem(failed.workItemId).state, "dead_letter");
    assert.equal(fixture.board.requireWorkItem(remaining.workItemId).state, "merged");
    const completion = gateActions(fixture.path, decomposition.parent.workItemId).at(-1);
    assert.equal(completion?.gate, "final_approve");
    assert.equal(completion?.note, "1 children merged, 1 abandoned");
  } finally {
    fixture.board.close();
  }
});

test("a phased Contract reports an abandoned Migrate after Expand deploy attestation", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const consumer = fixture.board.createProject({
      name: "Attested abandoned migration consumer",
      description: "Owns the abandoned migration after the expansion is deployed.",
      repoPath: "/repos/attested-abandoned-migration-consumer",
    });
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      phasedChildren(fixture.project.projectId, consumer.projectId, "attested-abandoned-migrate"),
      "phased-attested-abandoned-migrate",
      "blast_radius"
    );
    const [expand, migrate, contract] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    assert.ok(contract);
    forceMergedWithApproval(fixture.path, expand.workItemId, MERGE_SHAS[0]);
    fixture.board.attestDeploy(expand.workItemId, { note: "The expansion is deployed." });
    assert.equal(
      (fixture.board.listChildren(decomposition.parent.workItemId) as readonly ChildWorkItem[])[0]?.deployAttested,
      true
    );

    fixture.board.updateWorkItem(migrate.workItemId, {
      action: "cancel",
      version: fixture.board.requireWorkItem(migrate.workItemId).version,
      reason: "The migration is unsafe to continue.",
    });

    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "parked");
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "queued");
    assert.equal(childNode(fixture.board, contract).node.state, "blocked");
    assert.equal(
      latestNodeBlock(fixture.path, childNode(fixture.board, contract).node.nodeId),
      `blocked: ${migrate.workItemId} (migrate) abandoned`
    );

    assert.throws(
      () => fixture.board.resumeWorkItem(decomposition.parent.workItemId),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 409 && error.code === "PARENT_PHASED_FAILED"
    );
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "queued");
    assert.equal(childNode(fixture.board, contract).node.state, "blocked");
    assert.equal(
      latestNodeBlock(fixture.path, childNode(fixture.board, contract).node.nodeId),
      `blocked: ${migrate.workItemId} (migrate) abandoned`
    );

    const cancelled = fixture.board.updateWorkItem(decomposition.parent.workItemId, {
      action: "cancel",
      version: fixture.board.requireWorkItem(decomposition.parent.workItemId).version,
      reason: "Cancel the unsafe phased family.",
    });

    assert.equal(cancelled.state, "abandoned");
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "merged");
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "abandoned");
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "abandoned");
  } finally {
    fixture.board.close();
  }
});

test("a phased Contract reports an abandoned Migrate before an unattested Expand", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const consumer = fixture.board.createProject({
      name: "Abandoned migration consumer",
      description: "Owns the migration that makes Contract unsafe when abandoned.",
      repoPath: "/repos/abandoned-migration-consumer",
    });
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      phasedChildren(fixture.project.projectId, consumer.projectId, "abandoned-migrate"),
      "phased-abandoned-migrate",
      "blast_radius"
    );
    const [expand, migrate, contract] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    assert.ok(contract);
    forceMergedWithApproval(fixture.path, expand.workItemId, MERGE_SHAS[0]);
    assert.equal(
      (fixture.board.listChildren(decomposition.parent.workItemId) as readonly ChildWorkItem[])[0]?.deployAttested,
      false
    );

    fixture.board.updateWorkItem(migrate.workItemId, {
      action: "cancel",
      version: fixture.board.requireWorkItem(migrate.workItemId).version,
      reason: "The migration is unsafe to continue.",
    });

    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "parked");
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "queued");
    assert.equal(childNode(fixture.board, contract).node.state, "blocked");
    assert.equal(
      latestNodeBlock(fixture.path, childNode(fixture.board, contract).node.nodeId),
      `blocked: ${migrate.workItemId} (migrate) abandoned`
    );

    assert.throws(
      () => fixture.board.resumeWorkItem(decomposition.parent.workItemId),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 409 && error.code === "PARENT_PHASED_FAILED"
    );
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "queued");
    assert.equal(childNode(fixture.board, contract).node.state, "blocked");
    assert.equal(
      latestNodeBlock(fixture.path, childNode(fixture.board, contract).node.nodeId),
      `blocked: ${migrate.workItemId} (migrate) abandoned`
    );

    const cancelled = fixture.board.updateWorkItem(decomposition.parent.workItemId, {
      action: "cancel",
      version: fixture.board.requireWorkItem(decomposition.parent.workItemId).version,
      reason: "Cancel the unsafe phased family.",
    });

    assert.equal(cancelled.state, "abandoned");
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "merged");
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "abandoned");
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "abandoned");
  } finally {
    fixture.board.close();
  }
});

test("resuming an unphased parent with only abandoned children completes it", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "first",
          objective: "Abandon the first unphased child.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/all-abandoned-first"],
          acceptanceCriteria: ["The parent records this abandoned child."],
        },
        {
          key: "second",
          objective: "Abandon the second unphased child.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/all-abandoned-second"],
          acceptanceCriteria: ["The parent records this abandoned child."],
        },
      ],
      "all-children-abandoned"
    );
    for (const child of decomposition.children) {
      fixture.board.updateWorkItem(child.workItemId, {
        action: "cancel",
        version: fixture.board.requireWorkItem(child.workItemId).version,
        reason: `Abandon ${child.workItemId}.`,
      });
    }
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "parked");

    const resumed = fixture.board.resumeWorkItem(decomposition.parent.workItemId);

    assert.equal(resumed.state, "merged");
    assert.equal(
      gateActions(fixture.path, decomposition.parent.workItemId).at(-1)?.note,
      "0 children merged, 2 abandoned"
    );
  } finally {
    fixture.board.close();
  }
});

test("a phased parent with no failed child completes after every child merges", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const consumer = fixture.board.createProject({
      name: "No-failure phased consumer",
      description: "Completes the phased family without a failed child.",
      repoPath: "/repos/no-failure-phased-consumer",
    });
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      phasedChildren(fixture.project.projectId, consumer.projectId, "no-failed-child"),
      "phased-no-failed-child",
      "blast_radius"
    );
    for (const [index, child] of decomposition.children.entries()) {
      forceMergedWithApproval(fixture.path, child.workItemId, MERGE_SHAS[index] ?? MERGE_SHAS[0]);
    }

    fixture.board.reconcileWorkflows(fixture.project.projectId);

    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "merged");
  } finally {
    fixture.board.close();
  }
});

test("a phased failed parent cannot resume after an earlier child later merges", async () => {
  const fixture = await boardFixture(undefined, undefined, {
    git: crossRepoGit((operation) => {
      if (operation === "ls-tree") return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
      if (operation === "cat-file") return "19\n";
      return "# Resume interface\n";
    }),
  });
  try {
    const consumer = fixture.board.createProject({
      name: "Resume reconciliation consumer",
      description: "Hosts the child that becomes ready while its parent is parked.",
      repoPath: "/repos/resume-reconciliation-consumer",
    });
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "expand",
          objective: "Merge before the parked family resumes.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/resume-expand", "docs/interface.md"],
          acceptanceCriteria: ["The expansion satisfies migration readiness."],
          phase: "expand",
          splitBy: "phase",
        },
        {
          key: "migrate",
          objective: "Activate in the resume call once Expand is merged.",
          projectId: consumer.projectId,
          declaredScope: ["src/resume-migrate"],
          acceptanceCriteria: ["Resume reconciliation activates migration."],
          phase: "migrate",
          splitBy: "consumer",
          dependsOn: ["expand"],
        },
        {
          key: "contract",
          objective: "Provide a terminal child that parks the parent before resume.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/resume-contract", "docs/interface.md"],
          acceptanceCriteria: ["The parent can be resumed after this child fails."],
          phase: "contract",
          splitBy: "phase",
          dependsOn: ["migrate"],
        },
      ],
      "resume-reconciles-ready-child",
      "blast_radius"
    );
    const [expand, migrate, contract] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    assert.ok(contract);
    fixture.board.updateWorkItem(contract.workItemId, {
      action: "cancel",
      version: fixture.board.requireWorkItem(contract.workItemId).version,
      reason: "Park the family while Expand finishes externally.",
    });
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "parked");
    forceMergedWithApproval(fixture.path, expand.workItemId, MERGE_SHAS[0]);
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "queued");

    assert.throws(
      () => fixture.board.resumeWorkItem(decomposition.parent.workItemId),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 409 && error.code === "PARENT_PHASED_FAILED"
    );
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "queued");
    assert.equal(childNode(fixture.board, migrate).node.state, "blocked");
  } finally {
    fixture.board.close();
  }
});

test("phased activation reports an invalid child repository as a project-naming typed error", async (t) => {
  const consumerPath = "/repos/invalid-activation-consumer";
  let failConsumerHead = false;
  const delegate = crossRepoGit((operation) => {
    if (operation === "ls-tree") return `100644 blob ${"f".repeat(40)}\tdocs/interface.md\0`;
    if (operation === "cat-file") return "23\n";
    return "# Activation interface\n";
  });
  const fixture = await boardFixture(undefined, undefined, {
    git: Object.assign(
      (arguments_: readonly string[]) => {
        if (
          failConsumerHead &&
          arguments_.includes(consumerPath) &&
          arguments_.includes("rev-parse") &&
          arguments_.at(-1) === "HEAD"
        )
          throw new Error("fatal: invalid activation repository");
        return delegate(arguments_);
      },
      { bytes: delegate.bytes }
    ),
  });
  const logged = t.mock.method(console, "error", () => undefined);
  try {
    const consumer = fixture.board.createProject({
      name: "Invalid activation consumer",
      description: "Becomes invalid only when its Migrate phase activates.",
      repoPath: consumerPath,
    });
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      phasedChildren(fixture.project.projectId, consumer.projectId, "invalid-activation-repository"),
      "invalid-activation-repository",
      "blast_radius"
    );
    const [expand, migrate] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    forceMergedWithApproval(fixture.path, expand.workItemId, MERGE_SHAS[0]);
    failConsumerHead = true;

    fixture.board.reconcileWorkflows(consumer.projectId);

    const typed = logged.mock.calls
      .map((call) => call.arguments[1])
      .find((error) => error instanceof TaskBoardError && error.code === "PROJECT_REPO_PATH_INVALID");
    assert.ok(typed instanceof TaskBoardError);
    assert.equal(typed.status, 409);
    assert.equal(typed.message, "Project Invalid activation consumer does not have a valid Git repository path");
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "queued");
  } finally {
    fixture.board.close();
  }
});

test("cancelling a coordinating parent abandons active children and leaves merged siblings untouched", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "active",
          objective: "Run until the coordinating parent is cancelled.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/cascade-active"],
          acceptanceCriteria: ["Parent cancellation terminates this run."],
        },
        {
          key: "merged",
          objective: "Remain merged when the parent is cancelled.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/cascade-merged"],
          acceptanceCriteria: ["Merged children are immutable."],
        },
      ],
      "cancel-parent-cascade"
    );
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "cancel-parent-cascade-active-run",
      messageCursor: null,
    });
    assert.ok(claim?.task);
    const activeChildId = claim.context.workflow?.workspaceKey;
    assert.ok(activeChildId);
    const mergedChild = decomposition.children.find((child) => child.workItemId !== activeChildId);
    assert.ok(mergedChild);
    forceMergedWithApproval(fixture.path, mergedChild.workItemId, MERGE_SHAS[0]);
    const mergedActionsBefore = gateActions(fixture.path, mergedChild.workItemId);
    const parent = fixture.board.requireWorkItem(decomposition.parent.workItemId);

    const cancelled = fixture.board.updateWorkItem(parent.workItemId, {
      action: "cancel",
      version: parent.version,
      reason: "Stop the decomposed family.",
    });

    assert.equal(cancelled.state, "abandoned");
    const activeChild = fixture.board.requireWorkItem(activeChildId);
    assert.equal(activeChild.state, "abandoned");
    assert.equal(activeChild.endedAt, cancelled.endedAt);
    assert.equal(fixture.board.requireTask(claim.task.taskId).status, "cancelled");
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const run = db.prepare("SELECT status,ended_at FROM runs WHERE run_id=?").get(claim.run.runId);
      assert.equal(run?.status, "interrupted");
      assert.equal(run?.ended_at, cancelled.endedAt);
    } finally {
      db.close();
    }
    const childCancel = gateActions(fixture.path, activeChildId).at(-1);
    assert.equal(childCancel?.gate, "cancel");
    assert.equal(childCancel?.refId, parent.workItemId);
    assert.equal(childCancel?.note, `parent ${parent.workItemId} abandoned`);
    const cascadeNotifications = fixture.board
      .listNotifications()
      .unread.filter(
        (notification) =>
          notification.kind === "park_auto_abandoned" &&
          notification.workItemId === activeChildId &&
          notification.dedupeKey === `park_auto_abandoned:${activeChildId}:${parent.workItemId}`
      );
    assert.equal(cascadeNotifications.length, 1);
    assert.equal(fixture.board.requireWorkItem(mergedChild.workItemId).state, "merged");
    assert.deepEqual(gateActions(fixture.path, mergedChild.workItemId), mergedActionsBefore);
  } finally {
    fixture.board.close();
  }
});

test("cancelling a child directly interrupts its active run", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "direct-child-cancel",
          objective: "Run until a human cancels this child directly.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/direct-child-cancel"],
          acceptanceCriteria: ["Direct child cancellation interrupts active work."],
        },
      ],
      "direct-child-cancel"
    );
    const [child] = decomposition.children;
    assert.ok(child);
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "direct-child-cancel-active-run",
      messageCursor: null,
    });
    assert.equal(claim?.context.workflow?.workspaceKey, child.workItemId);

    const cancelled = fixture.board.updateWorkItem(child.workItemId, {
      action: "cancel",
      version: fixture.board.requireWorkItem(child.workItemId).version,
      reason: "Stop this child and its active work.",
    });

    assert.equal(cancelled.state, "abandoned");
    assert.equal(fixture.board.requireTask(claim!.task!.taskId).status, "cancelled");
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const run = db.prepare("SELECT status,ended_at FROM runs WHERE run_id=?").get(claim!.run.runId);
      assert.equal(run?.status, "interrupted");
      assert.equal(run?.ended_at, cancelled.endedAt);
    } finally {
      db.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("a child cleanup failure is recorded without aborting parent termination", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  const originalError = console.error;
  const logged: unknown[][] = [];
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "cleanup-failure",
          objective: "Inject a run interruption failure during parent cancellation.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/cleanup-failure"],
          acceptanceCriteria: ["The parent still reaches a terminal state."],
        },
        {
          key: "unaffected-sibling",
          objective: "Prove the cascade continues after a sibling cleanup failure.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/unaffected-sibling"],
          acceptanceCriteria: ["This child is still abandoned."],
        },
      ],
      "cancel-parent-cleanup-failure"
    );
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "cancel-parent-cleanup-failure-run",
      messageCursor: null,
    });
    assert.ok(claim?.task);
    const failingChildId = claim.context.workflow?.workspaceKey;
    assert.ok(failingChildId);
    const unaffected = decomposition.children.find((child) => child.workItemId !== failingChildId);
    assert.ok(unaffected);
    const interruptAbort = new AbortController();
    const interruptWatch = fixture.board.waitForRunInterrupts(
      claim.run.runId,
      fixture.engineer.agentId,
      0,
      30_000,
      interruptAbort.signal
    );
    const injected = new DatabaseSync(fixture.path);
    try {
      injected.exec(`
        CREATE TRIGGER fail_child_run_cleanup
        BEFORE INSERT ON task_events
        WHEN NEW.task_id='${claim.task.taskId}' AND NEW.event_type='task_run_settled'
        BEGIN
          SELECT RAISE(ABORT, 'forced child cleanup failure');
        END;
      `);
    } finally {
      injected.close();
    }
    console.error = (...arguments_: unknown[]) => {
      logged.push(arguments_);
    };
    const parent = fixture.board.requireWorkItem(decomposition.parent.workItemId);

    const cancelled = fixture.board.updateWorkItem(parent.workItemId, {
      action: "cancel",
      version: parent.version,
      reason: "Terminate the family despite one failed cleanup operation.",
    });

    assert.equal(cancelled.state, "abandoned");
    assert.equal(fixture.board.requireWorkItem(failingChildId).state, "abandoned");
    assert.equal(fixture.board.requireWorkItem(unaffected.workItemId).state, "abandoned");
    assert.equal(fixture.board.requireTask(claim.task.taskId).status, "cancelled");
    let interruptTimeout: NodeJS.Timeout | undefined;
    const interruptBatch = await Promise.race([
      interruptWatch,
      new Promise<never>((_resolve, reject) => {
        interruptTimeout = setTimeout(() => {
          interruptAbort.abort();
          reject(new Error("the child worker was not signalled after durable run termination"));
        }, 2_000);
      }),
    ]).finally(() => {
      if (interruptTimeout !== undefined) clearTimeout(interruptTimeout);
    });
    assert.equal(interruptBatch?.items.length, 1);
    assert.equal(interruptBatch?.items[0]?.runId, claim.run.runId);
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const run = inspected.prepare("SELECT status,ended_at FROM runs WHERE run_id=?").get(claim.run.runId);
      assert.equal(run?.status, "interrupted");
      assert.ok(run?.ended_at);
      assert.equal(
        Number(
          inspected.prepare("SELECT COUNT(*) AS count FROM interrupts WHERE run_id=?").get(claim.run.runId)?.count
        ),
        1
      );
      const events = inspected
        .prepare(
          `
        SELECT data_json
        FROM task_events
        WHERE event_type='work_item_cancellation_cleanup_failed'
          AND json_extract(data_json,'$.childWorkItemId')=?
      `
        )
        .all(failingChildId);
      assert.equal(events.length, 1);
      assert.match(String(events[0]?.data_json), /forced child cleanup failure/u);
    } finally {
      inspected.close();
    }
    const cleanupLogs = logged.filter((record) => record[0] === "[task-board] child cancellation cleanup failed");
    assert.equal(cleanupLogs.length, 1);
    assert.equal((cleanupLogs[0]?.[1] as { phase?: unknown } | undefined)?.phase, "primary");
  } finally {
    console.error = originalError;
    fixture.board.close();
  }
});

test("a parent termination cascade reconciles overlapping pipelines in every child project", async () => {
  let now = new Date("2026-08-29T14:00:00.000Z");
  const fixture = await boardFixture(undefined, () => now, { git: () => `${BASE_SHA}\n` });
  try {
    const childProject = fixture.board.createProject({
      name: "Cascade child project",
      description: "Owns a child scope released by parent termination.",
      repoPath: "/repos/cascade-child",
    });
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "cascade-holder",
          objective: "Hold remote scope until the parent terminates.",
          projectId: childProject.projectId,
          declaredScope: ["src/cascade-shared"],
          acceptanceCriteria: ["Termination releases the remote scope immediately."],
        },
      ],
      "cascade-child-project-reconcile"
    );
    const [child] = decomposition.children;
    assert.ok(child);
    now = new Date("2026-08-29T14:00:01.000Z");
    const held = proposeStandalonePipeline(
      fixture.board,
      childProject.projectId,
      ["src/cascade-shared"],
      "cascade-scope-waiter"
    );
    assert.equal(childNode(fixture.board, held).node.state, "blocked");

    const parent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    const cancelled = fixture.board.updateWorkItem(parent.workItemId, {
      action: "cancel",
      version: parent.version,
      reason: "Release every cascaded child project.",
    });

    assert.equal(cancelled.state, "abandoned");
    assert.equal(fixture.board.requireWorkItem(child.workItemId).state, "abandoned");
    assert.equal(fixture.board.requireWorkItem(held.workItemId).state, "implementing");
    assert.equal(childNode(fixture.board, held).node.state, "active");
  } finally {
    fixture.board.close();
  }
});

test("parent cancellation retires a child's running machine verification before late settlement", async () => {
  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  try {
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "machine-verify-child",
          objective: "Remain in machine verification until the parent is cancelled.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/machine-verify-child"],
          acceptanceCriteria: ["Late machine settlement cannot write durable output."],
        },
      ],
      "cancel-machine-verification"
    );
    const [child] = decomposition.children;
    assert.ok(child);
    const node = childNode(fixture.board, child).node;
    const verifyAttemptId = `verify-cancel-${child.workItemId}`;
    const db = new DatabaseSync(fixture.path);
    try {
      db.prepare(
        `
        UPDATE work_items
        SET state='verifying',current_stage='testing',version=version+1,updated_at=?
        WHERE work_item_id=?
      `
      ).run(NOW, child.workItemId);
      db.prepare(
        `
        UPDATE work_nodes
        SET state='active',current_stage='testing',version=version+1,updated_at=?
        WHERE node_id=?
      `
      ).run(NOW, node.nodeId);
      db.prepare(
        `
        INSERT INTO verify_attempts(
          verify_attempt_id,node_id,stage,attempt,verify_run_id,workspace_path,state,
          check_results_json,detail,created_at,ended_at
        ) VALUES(?,?,'testing',1,'late-verify-run','/tmp/late-verify-workspace','running',NULL,NULL,?,NULL)
      `
      ).run(verifyAttemptId, node.nodeId, NOW);
    } finally {
      db.close();
    }
    const parent = fixture.board.requireWorkItem(decomposition.parent.workItemId);

    fixture.board.updateWorkItem(parent.workItemId, {
      action: "cancel",
      version: parent.version,
      reason: "Cancel while the child verifier is still running.",
    });

    const retired = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const attempt = retired
        .prepare("SELECT state,ended_at FROM verify_attempts WHERE verify_attempt_id=?")
        .get(verifyAttemptId);
      assert.equal(attempt?.state, "retired");
      assert.equal(attempt?.ended_at, fixture.board.requireWorkItem(parent.workItemId).endedAt);
    } finally {
      retired.close();
    }

    assert.equal(await fixture.board.sweepVerifyAttempts(), 1);
    const settled = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(settled.prepare("SELECT 1 FROM tasks WHERE task_id=?").get(`task_${verifyAttemptId}`), undefined);
      assert.equal(
        settled.prepare("SELECT 1 FROM stage_handoffs WHERE handoff_id=?").get(`handoff_${verifyAttemptId}`),
        undefined
      );
    } finally {
      settled.close();
    }
  } finally {
    fixture.board.close();
  }
});

test("parent cancellation retires persisted Contract work even when the blocked node did not start it", async () => {
  const root = await mkdtemp(join(tmpdir(), "decomposition-cancel-persisted-contract-"));
  const repo = join(root, "repo");
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Decomposition Test"]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "decomposition@test.invalid"]);
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(
    join(repo, "docs", "workflow.md"),
    `# Verify workflow

\`\`\`json
${JSON.stringify(
  {
    version: 1,
    compile: ["node verify-full.mjs"],
    rules: [{ match: "**", action: { kind: "none" } }],
    full: ["node verify-full.mjs"],
  },
  null,
  2
)}
\`\`\`
`
  );
  await writeFile(join(repo, "verify-full.mjs"), "setTimeout(() => process.exit(0), 60_000);\n");
  await execFileAsync("git", ["-C", repo, "add", "."]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "fixture base"]);

  const fixture = await boardFixture(undefined, undefined, { git: () => `${BASE_SHA}\n` });
  let verifyRunner: VerifyRunner | null = null;
  let verifyRunId: string | null = null;
  let verifyPid: number | null = null;
  try {
    const db = new DatabaseSync(fixture.path);
    try {
      pointProjectAtRepository(db, fixture.project.projectId, repo);
    } finally {
      db.close();
    }
    const consumer = fixture.board.createProject({
      name: "Persisted Contract cancellation consumer",
      description: "Hosts the migration that dead-letters before Contract cancellation.",
      repoPath: repo,
    });
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      phasedChildren(fixture.project.projectId, consumer.projectId, "persisted-contract-cancel"),
      "persisted-contract-cancel",
      "blast_radius"
    );
    const [expand, migrate, contract] = decomposition.children;
    assert.ok(expand);
    assert.ok(migrate);
    assert.ok(contract);
    forceMergedWithApproval(fixture.path, expand.workItemId, MERGE_SHAS[0]);
    const transitionStore = await TaskBoardStore.open(fixture.path);
    new TaskBoardRuntime(config(fixture.path), transitionStore);
    try {
      transitionStore.transaction(() => {
        transitionWorkItemInTransaction(transitionStore, {
          workItemId: migrate.workItemId,
          to: "dead_letter",
          actorType: "system",
          actorId: "system:test-dead-letter",
          now: NOW,
          endedAt: NOW,
          currentStage: null,
        });
      });
    } finally {
      transitionStore.close();
    }
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "parked");
    const contractNode = childNode(fixture.board, contract).node;
    assert.equal(contractNode.state, "blocked");

    const contractRunner = fixture.board.createAgent(fixture.project.projectId, {
      agentId: "persisted-contract-runner",
      role: "engineer",
      area: "contract-cancellation",
      mission: "Hold a persisted Contract run until family cancellation.",
      model: "codex-mini",
      token: "persisted-contract-runner-token-0123456789",
    });
    const contractTask = fixture.board.createTask(
      fixture.project.projectId,
      taskRequest({
        title: "Hold blocked Contract work open",
        objective: "Exercise cancellation of a run attached outside workflow activation.",
        acceptanceCriteria: "Parent cancellation interrupts the persisted run.",
        workspaceRefs: [],
        assignedAgentId: contractRunner.agentId,
      })
    );
    const contractRun = fixture.board.claimRun(contractRunner.agentId, {
      claimId: "persisted-contract-cancel-run",
      messageCursor: null,
    });
    assert.equal(contractRun?.task?.taskId, contractTask.taskId);
    assert.ok(contractRun);

    const workspaceRoot = join(dirname(fixture.path), "verify-workspaces");
    const workspace = new TaskWorkspaceManager({ workspaceRoot, repositoryPath: repo });
    const workspacePath = await workspace.create(`${contract.workItemId}-verify`, undefined, contract.workItemId);
    verifyRunner = new VerifyRunner({ repoRoot: workspacePath, supervisorPath: DEFAULT_SUPERVISOR_PATH });
    verifyRunId = await verifyRunner.startFull();
    const status = JSON.parse(
      await readFile(join(workspacePath, ".verify-runs", verifyRunId, "status.json"), "utf8")
    ) as { pid?: unknown; state?: unknown };
    assert.equal(status.state, "running");
    assert.equal(typeof status.pid, "number");
    verifyPid = Number(status.pid);
    process.kill(verifyPid, 0);

    const verifyAttemptId = `verify-cancel-${contract.workItemId}`;
    const setup = new DatabaseSync(fixture.path);
    let completionEventsBefore = 0;
    try {
      setup
        .prepare(
          `
        INSERT INTO stage_attempts(attempt_id,node_id,task_id,stage,attempt,skill_digests_json)
        VALUES(?,?,?,'implementation',99,'{}')
      `
        )
        .run(`attempt-cancel-${contract.workItemId}`, contractNode.nodeId, contractTask.taskId);
      setup
        .prepare(
          `
        INSERT INTO verify_attempts(
          verify_attempt_id,node_id,stage,attempt,verify_run_id,workspace_path,state,
          check_results_json,detail,created_at,ended_at
        ) VALUES(?,?,'testing',99,?,?,'running',NULL,NULL,?,NULL)
      `
        )
        .run(verifyAttemptId, contractNode.nodeId, verifyRunId, workspacePath, NOW);
      completionEventsBefore = Number(
        setup
          .prepare(
            `
        SELECT COUNT(*) AS count
        FROM project_events
        WHERE node_id=? AND event_type='stage_completed'
      `
          )
          .get(contractNode.nodeId)?.count
      );
    } finally {
      setup.close();
    }

    const cancelled = fixture.board.updateWorkItem(decomposition.parent.workItemId, {
      action: "cancel",
      version: fixture.board.requireWorkItem(decomposition.parent.workItemId).version,
      reason: "Cancel the unsafe phased family after migration dead-letter.",
    });
    assert.equal(cancelled.state, "abandoned");
    assert.equal(fixture.board.requireWorkItem(expand.workItemId).state, "merged");
    assert.equal(fixture.board.requireWorkItem(migrate.workItemId).state, "dead_letter");
    assert.equal(fixture.board.requireWorkItem(contract.workItemId).state, "abandoned");
    assert.equal(childNode(fixture.board, contract).node.state, "blocked");
    assert.equal(fixture.board.requireTask(contractTask.taskId).status, "cancelled");
    assert.equal(await fixture.board.sweepVerifyAttempts(), 0);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        process.kill(verifyPid, 0);
        await delay(25);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        verifyPid = null;
        break;
      }
    }
    assert.equal(verifyPid, null, "the persisted verifier process must terminate");
    await assert.rejects(access(workspacePath));
    const inspected = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(
        inspected.prepare("SELECT state FROM verify_attempts WHERE verify_attempt_id=?").get(verifyAttemptId)?.state,
        "retired"
      );
      assert.equal(
        inspected.prepare("SELECT status FROM runs WHERE run_id=?").get(contractRun.run.runId)?.status,
        "interrupted"
      );
      assert.equal(
        Number(
          inspected
            .prepare(
              `
        SELECT COUNT(*) AS count
        FROM project_events
        WHERE node_id=? AND event_type='stage_completed'
      `
            )
            .get(contractNode.nodeId)?.count
        ),
        completionEventsBefore
      );
    } finally {
      inspected.close();
    }
  } finally {
    fixture.board.close();
    if (verifyPid !== null) {
      try {
        process.kill(process.platform === "win32" ? verifyPid : -verifyPid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    } else if (verifyRunner !== null && verifyRunId !== null) {
      await verifyRunner.terminate(verifyRunId).catch(() => undefined);
    }
  }
});

test("park auto-abandon cascades to an active child while preserving a merged sibling", async () => {
  let clock = new Date(NOW);
  const fixture = await boardFixture(undefined, () => clock, { git: () => `${BASE_SHA}\n` });
  try {
    const childProject = fixture.board.createProject({
      name: "Auto-abandon child project",
      description: "Owns a child scope released by parent lifecycle expiry.",
      repoPath: "/repos/auto-abandon-child",
    });
    const decomposition = proposeParent(
      fixture.board,
      fixture.project.projectId,
      [
        {
          key: "active",
          objective: "Remain active until the parked parent auto-abandons.",
          projectId: childProject.projectId,
          declaredScope: ["src/auto-cascade-active"],
          acceptanceCriteria: ["Auto-abandon terminates this run."],
        },
        {
          key: "failure",
          objective: "Fail to park the coordinating parent.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/auto-cascade-failure"],
          acceptanceCriteria: ["This failure parks the parent."],
        },
        {
          key: "merged",
          objective: "Remain merged across parent auto-abandon.",
          projectId: fixture.project.projectId,
          declaredScope: ["src/auto-cascade-merged"],
          acceptanceCriteria: ["Merged siblings are untouched."],
        },
      ],
      "auto-abandon-parent-cascade"
    );
    const claim = fixture.board.claimRun(fixture.engineer.agentId, {
      claimId: "auto-abandon-parent-cascade-active-run",
      messageCursor: null,
    });
    assert.ok(claim?.task);
    const activeChildId = claim.context.workflow?.workspaceKey;
    assert.ok(activeChildId);
    const [failedChild, mergedChild] = decomposition.children.filter((child) => child.workItemId !== activeChildId);
    assert.ok(failedChild);
    assert.ok(mergedChild);
    clock = new Date(Date.parse(NOW) + 1_000);
    const held = proposeStandalonePipeline(
      fixture.board,
      childProject.projectId,
      ["src/auto-cascade-active"],
      "auto-cascade-scope-waiter"
    );
    assert.equal(childNode(fixture.board, held).node.state, "blocked");
    forceMergedWithApproval(fixture.path, mergedChild.workItemId, MERGE_SHAS[0]);
    const mergedActionsBefore = gateActions(fixture.path, mergedChild.workItemId);
    fixture.board.updateWorkItem(failedChild.workItemId, {
      action: "cancel",
      version: fixture.board.requireWorkItem(failedChild.workItemId).version,
      reason: "Park the parent for lifecycle expiry.",
    });
    assert.equal(fixture.board.requireWorkItem(decomposition.parent.workItemId).state, "parked");

    clock = new Date(Date.parse(NOW) + 8 * 24 * 60 * 60 * 1_000);
    const sweep = fixture.board.sweepParkLifecycle(clock.toISOString());

    assert.equal(sweep.autoAbandoned, 1);
    const parent = fixture.board.requireWorkItem(decomposition.parent.workItemId);
    assert.equal(parent.state, "abandoned");
    const activeChild = fixture.board.requireWorkItem(activeChildId);
    assert.equal(activeChild.state, "abandoned");
    assert.equal(activeChild.endedAt, parent.endedAt);
    assert.equal(fixture.board.requireTask(claim.task.taskId).status, "cancelled");
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT status FROM runs WHERE run_id=?").get(claim.run.runId)?.status, "interrupted");
    } finally {
      db.close();
    }
    const childCancel = gateActions(fixture.path, activeChildId).at(-1);
    assert.equal(childCancel?.gate, "cancel");
    assert.equal(childCancel?.refId, parent.workItemId);
    assert.equal(childCancel?.note, `parent ${parent.workItemId} abandoned`);
    assert.equal(fixture.board.requireWorkItem(mergedChild.workItemId).state, "merged");
    assert.deepEqual(gateActions(fixture.path, mergedChild.workItemId), mergedActionsBefore);
    assert.equal(fixture.board.requireWorkItem(held.workItemId).state, "implementing");
    assert.equal(childNode(fixture.board, held).node.state, "active");
  } finally {
    fixture.board.close();
  }
});
