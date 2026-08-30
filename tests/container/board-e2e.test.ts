import assert from "node:assert/strict";
import { access, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createTaskBoardService, type BoardSnapshot, type BoardTask, type Project } from "#server/task-board";
import { createTaskFleetWorker, parseTaskFleetConfig } from "#server/agents/task-fleet";
import { agentImage, docker, fixtureRepo, requireDocker, runGit, tempRoot } from "./helpers.js";

const HUMAN_TOKEN = "container-e2e-human-token-0123456789abcd";
const AGENT_TOKEN = "container-e2e-agent-token-0123456789abcd";

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
