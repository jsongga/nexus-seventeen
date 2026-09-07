/** End-to-end container execution through the task board and fleet. */

import assert from "node:assert/strict";
import { access, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createTaskBoardService,
  normalizeTaskBoardConfig,
  TaskBoard,
  type BoardSnapshot,
  type BoardTask,
  type Project,
} from "#server/task-board";
import { createTaskFleetWorker, parseTaskFleetConfig } from "#server/agents/task-fleet";
import { automationConfigurationRequest, automationStages } from "../server/task-board/helpers.js";
import { agentImage, docker, fixtureRepo, requireDocker, runGit, tempRoot } from "./helpers.js";

const HUMAN_TOKEN = "container-e2e-human-token-0123456789abcd";
const AGENT_TOKEN = "container-e2e-agent-token-0123456789abcd";
const REPOSITORY_A_TOKEN = "container-e2e-repository-a-token-0123456789abcd";
const REPOSITORY_B_TOKEN = "container-e2e-repository-b-token-0123456789abcd";

async function request<T>(
  origin: string,
  path: string,
  method: "GET" | "POST",
  token: string,
  expectedStatus: number,
  body?: unknown,
  idempotencyKey?: string
): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, text);
  return JSON.parse(text) as T;
}

test("a board-claimed task executes in a disposable container against its own workspace", async (t) => {
  await requireDocker();
  const image = await agentImage();
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = await fixtureRepo(root);
  const service = await createTaskBoardService({
    dbPath: join(root, "board", "task-board.sqlite"),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:container-e2e",
    port: 0,
  });
  let worker: Awaited<ReturnType<typeof createTaskFleetWorker>> | null = null;
  try {
    const address = await service.start();
    const { project } = await request<{ project: Project }>(address.url, "/v1/projects", "POST", HUMAN_TOKEN, 201, {
      name: "Container execution",
      description: "Prove container-per-task execution end to end.",
    });
    await request(address.url, `/v1/projects/${project.projectId}/agents`, "POST", HUMAN_TOKEN, 201, {
      agentId: "container-engineer",
      role: "engineer",
      area: "execution",
      mission: "Prove containerized execution.",
      model: "stub-model",
      token: AGENT_TOKEN,
    });
    const { task } = await request<{ task: BoardTask }>(
      address.url,
      `/v1/projects/${project.projectId}/tasks`,
      "POST",
      HUMAN_TOKEN,
      201,
      {
        parentTaskId: null,
        title: "Run inside a container",
        objective: "The stub commits a proof file on the task branch.",
        acceptanceCriteria: "task branch exists in the source repo with stub-proof.txt",
        workspaceRefs: [],
        assignedAgentId: "container-engineer",
        assignedRole: "engineer",
        expectedAgentMinutes: 15,
      }
    );
    const config = parseTaskFleetConfig({
      version: 1,
      boardUrl: address.url,
      agents: [
        {
          workerId: "container-e2e-worker",
          agentId: "container-engineer",
          token: AGENT_TOKEN,
          provider: "codex",
          model: "stub-model",
          workingDirectory: repo,
          statePath: join(root, "worker", "journal.json"),
          longPollMs: 1000,
          runtime: "container",
          container: {
            workspaceRoot: join(root, "workspaces"),
            image,
            agentCommand: "steward-stub",
          },
        },
      ],
    });
    worker = await createTaskFleetWorker(config.agents[0]!, config.boardUrl);
    assert.equal(
      await worker.run(new AbortController().signal),
      true,
      "the container lane claimed and settled the wake"
    );

    const board = await request<BoardSnapshot>(
      address.url,
      `/v1/projects/${project.projectId}/board`,
      "GET",
      HUMAN_TOKEN,
      200
    );
    const run = board.recentRuns.find((candidate) => candidate.taskId === task.taskId);
    assert.equal(run?.status, "completed");
    assert.equal(run?.runtime, "codex");
    assert.match(run?.runtimeVersion ?? "", /\+[0-9a-f]{12}$/u);
    assert.equal(board.tasks.find((candidate) => candidate.taskId === task.taskId)?.status, "completed");

    assert.match(await runGit(repo, ["show", `task/${task.taskId}:stub-proof.txt`]), /stub ran/u);
    assert.equal((await runGit(repo, ["branch", "--show-current"])).trim(), "main");
    assert.equal(await runGit(repo, ["status", "--porcelain"]), "");

    await assert.rejects(access(join(root, "workspaces", task.taskId)));
    assert.deepEqual(await readdir(join(root, "workspaces")), []);
    assert.equal((await docker(["ps", "-aq", "--filter", "label=steward.task"])).trim(), "");
  } finally {
    try {
      await worker?.close();
    } finally {
      await service.close();
    }
  }
});

test("a repository-targeted task is claimed only by the worker holding that repository", async (t) => {
  await requireDocker();
  const image = await agentImage();
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryARoot = join(root, "repository-a-fixture");
  const repositoryBRoot = join(root, "repository-b-fixture");
  await mkdir(repositoryARoot);
  await mkdir(repositoryBRoot);
  const repositoryA = await fixtureRepo(repositoryARoot);
  const repositoryB = await fixtureRepo(repositoryBRoot);
  const boardOptions = {
    dbPath: join(root, "board", "task-board.sqlite"),
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:repository-fleet-e2e",
    port: 0,
    reconcileIntervalSeconds: 0,
  } as const;
  const service = await createTaskBoardService(boardOptions);
  let setupBoard: TaskBoard | null = null;
  let workerA: Awaited<ReturnType<typeof createTaskFleetWorker>> | null = null;
  let workerB: Awaited<ReturnType<typeof createTaskFleetWorker>> | null = null;
  try {
    const address = await service.start();
    setupBoard = await TaskBoard.open(normalizeTaskBoardConfig(boardOptions));
    const { project } = await request<{ project: Project }>(address.url, "/v1/projects", "POST", HUMAN_TOKEN, 201, {
      name: "Two-repository container execution",
      description: "Prove repository-scoped fleet dispatch end to end.",
      repoPath: repositoryA,
    });
    const repositoryBProfile = setupBoard.addRepository(project.projectId, {
      name: "Repository B",
      path: repositoryB,
    });
    const repositoryDatabase = new DatabaseSync(boardOptions.dbPath, { readOnly: true });
    let repositoryAId: string;
    try {
      const primary = repositoryDatabase
        .prepare("SELECT repository_id FROM repositories WHERE project_id=? AND is_primary=1")
        .get(project.projectId);
      if (typeof primary?.repository_id !== "string") throw new Error("primary repository is missing");
      repositoryAId = primary.repository_id;
    } finally {
      repositoryDatabase.close();
    }

    await request(address.url, `/v1/projects/${project.projectId}/agents`, "POST", HUMAN_TOKEN, 201, {
      agentId: "repository-a-engineer",
      role: "engineer",
      area: "repository A execution",
      mission: "Execute only work targeting repository A.",
      model: "stub-model",
      token: REPOSITORY_A_TOKEN,
      repositoryId: repositoryAId,
    });
    await request(address.url, `/v1/projects/${project.projectId}/agents`, "POST", HUMAN_TOKEN, 201, {
      agentId: "repository-b-engineer",
      role: "engineer",
      area: "repository B execution",
      mission: "Execute only work targeting repository B.",
      model: "stub-model",
      token: REPOSITORY_B_TOKEN,
      repositoryId: repositoryBProfile.repositoryId,
    });

    const engineerType = {
      agentTypeId: "repository-fleet-engineer",
      name: "Repository fleet engineer",
      description: "Executes the repository-scoped container fixture.",
      role: "engineer" as const,
      supplementalInstructions: "Commit the deterministic proof file in the assigned repository.",
      skillIds: [],
      evaluatorProfile: "tests" as const,
      enabled: true,
    };
    const verifierType = {
      ...engineerType,
      agentTypeId: "repository-fleet-verifier",
      name: "Repository fleet verifier",
      role: "verifier" as const,
    };
    const initialAutomation = setupBoard.getAutomationConfiguration();
    setupBoard.updateAutomationConfiguration(
      automationConfigurationRequest({
        version: initialAutomation.version,
        agentTypes: [engineerType, verifierType],
        stages: automationStages({
          implementation: { kind: "agent_type", agentTypeId: engineerType.agentTypeId },
          testing: { kind: "machine_verify" },
          verification: { kind: "agent_type", agentTypeId: verifierType.agentTypeId },
        }),
      })
    );
    const parent = setupBoard.createWorkItem(
      {
        originalRequest: "Commit the container proof in repository B.",
        priority: "normal",
        projectTarget: { mode: "explicit", projectId: project.projectId },
      },
      "repository-fleet-container-e2e"
    ).workItem;
    const proposed = setupBoard.proposeWorkflow({
      workItemId: parent.workItemId,
      projectId: project.projectId,
      objective: "Route the repository B change to its matching worker.",
      assumptions: ["Both repository workers are configured before dispatch."],
      acceptanceCriteria: ["Only repository B receives the proof commit."],
      changeShape: "feature",
      tier: "standard",
      declaredScope: ["coordination"],
      nonGoals: ["Do not modify repository A."],
      mechanicalPortions: [],
      blockingQuestions: [],
      criterionChecks: [
        {
          criterion: "Only repository B receives the proof commit.",
          check: "git show task/<work-item-id>:stub-proof.txt",
        },
      ],
      children: [
        {
          key: "repository-b-proof",
          objective: "Commit the container proof in repository B.",
          projectId: project.projectId,
          repositoryId: repositoryBProfile.repositoryId,
          declaredScope: ["stub-proof.txt"],
          acceptanceCriteria: ["Repository B contains stub-proof.txt on the task branch."],
        },
      ],
      skillIds: [],
      nodes: [
        {
          nodeId: "repository-fleet-parent",
          title: "Coordinate the repository B proof",
          objective: "Track the repository-specific child outcome.",
          acceptanceCriteria: ["The repository B child is materialized."],
          dependencyNodeIds: [],
          stageTemplate: ["verification"],
        },
      ],
    });
    const revision = proposed.plans.find((plan) => plan.workItemId === parent.workItemId);
    assert.ok(revision);
    setupBoard.confirmWorkflow(revision.planRevisionId, { expectedState: "proposed" });
    const [repositoryBWorkItem] = setupBoard.listChildren(parent.workItemId);
    assert.ok(repositoryBWorkItem);

    const configuredAutomation = setupBoard.getAutomationConfiguration();
    setupBoard.updateAutomationConfiguration(
      automationConfigurationRequest({
        version: configuredAutomation.version,
        agentTypes: [engineerType, verifierType],
        stages: automationStages({
          implementation: { kind: "agent_type", agentTypeId: engineerType.agentTypeId },
          verification: { kind: "agent_type", agentTypeId: verifierType.agentTypeId },
        }),
      })
    );
    const beforeRun = await request<BoardSnapshot>(
      address.url,
      `/v1/projects/${project.projectId}/board`,
      "GET",
      HUMAN_TOKEN,
      200
    );
    const repositoryBTask = beforeRun.tasks.find(
      (task) => task.assignedAgentId === "repository-b-engineer" && task.status === "queued"
    );
    assert.ok(repositoryBTask);

    const config = parseTaskFleetConfig({
      version: 1,
      boardUrl: address.url,
      agents: [
        {
          workerId: "repository-a-worker",
          agentId: "repository-a-engineer",
          token: REPOSITORY_A_TOKEN,
          provider: "codex",
          role: "engineer",
          model: "stub-model",
          workingDirectory: repositoryA,
          statePath: join(root, "repository-a-worker", "journal.json"),
          longPollMs: 1000,
          runtime: "container",
          container: {
            workspaceRoot: join(root, "repository-a-workspaces"),
            image,
            agentCommand: "steward-stub",
          },
        },
        {
          workerId: "repository-b-worker",
          agentId: "repository-b-engineer",
          token: REPOSITORY_B_TOKEN,
          provider: "codex",
          role: "engineer",
          model: "stub-model",
          workingDirectory: repositoryB,
          statePath: join(root, "repository-b-worker", "journal.json"),
          longPollMs: 1000,
          runtime: "container",
          container: {
            workspaceRoot: join(root, "repository-b-workspaces"),
            image,
            agentCommand: "steward-stub",
          },
        },
      ],
    });
    workerA = await createTaskFleetWorker(config.agents[0]!, config.boardUrl);
    workerB = await createTaskFleetWorker(config.agents[1]!, config.boardUrl);

    assert.equal(
      await workerA.run(new AbortController().signal),
      false,
      "repository A's worker must not claim repository B's task"
    );
    assert.equal(
      await workerB.run(new AbortController().signal),
      true,
      "repository B's worker must claim and settle its task"
    );

    const board = await request<BoardSnapshot>(
      address.url,
      `/v1/projects/${project.projectId}/board`,
      "GET",
      HUMAN_TOKEN,
      200
    );
    const run = board.recentRuns.find((candidate) => candidate.taskId === repositoryBTask.taskId);
    assert.equal(run?.agentId, "repository-b-engineer");
    assert.equal(run?.status, "completed");
    assert.equal(board.tasks.find((candidate) => candidate.taskId === repositoryBTask.taskId)?.status, "completed");

    assert.match(
      await runGit(repositoryB, ["show", `task/${repositoryBWorkItem.workItemId}:stub-proof.txt`]),
      /stub ran/u
    );
    assert.equal(
      (await runGit(repositoryA, ["branch", "--list", `task/${repositoryBWorkItem.workItemId}`])).trim(),
      ""
    );
    assert.equal(await runGit(repositoryA, ["status", "--porcelain"]), "");
    assert.equal(await runGit(repositoryB, ["status", "--porcelain"]), "");
    assert.equal((await docker(["ps", "-aq", "--filter", "label=steward.task"])).trim(), "");
  } finally {
    try {
      await workerA?.close();
      await workerB?.close();
    } finally {
      setupBoard?.close();
      await service.close();
    }
  }
});
