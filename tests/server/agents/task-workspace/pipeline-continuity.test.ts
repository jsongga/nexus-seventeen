import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { TaskWorkspaceManager, WorkspaceScopedLauncher } from "#server/agents/task-workspace";
import type {
  AgentLauncher,
  AgentRunHandle,
  BoundedAgentContext,
} from "#server/agents/task-worker/types";
import { FakeLauncher, completedOutcome, context, tempRoot } from "../task-worker/helpers.js";

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(stderr));
      else resolve(stdout);
    });
  });
}

async function fixtureRepo(root: string): Promise<string> {
  const repo = join(root, "repo");
  await git(root, ["init", "-b", "main", repo]);
  await writeFile(join(repo, "readme.md"), "hello\n");
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "."]);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return repo;
}

async function commitFile(repo: string, name: string, contents: string, message: string): Promise<string> {
  await writeFile(join(repo, name), contents);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "add", name]);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", message]);
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

function pipelineWorkflow(workspaceKey: string, baseSha: string): NonNullable<BoundedAgentContext["workflow"]> {
  return {
    planRevisionId: "plan-pipeline",
    nodeId: "node-pipeline",
    stage: "implementation",
    skills: [],
    dependencyHandoffs: [],
    workspaceKey,
    pipeline: {
      branch: `task/${workspaceKey}`,
      baseSha,
      changeShape: "feature",
      tier: "standard",
      declaredScope: ["src/server"],
      nonGoals: [],
      assumptions: [],
    },
  };
}

test("create resumes a harvested task branch with its prior-stage commits", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "workspaces"), repositoryPath: repo });
  const key = "pipeline-item";
  const first = await manager.create(key);
  await writeFile(join(first, "implementation.txt"), "first stage\n");
  await git(first, ["-c", "user.name=t", "-c", "user.email=t@local", "add", "implementation.txt"]);
  await git(first, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "implementation"]);
  const implementationCommit = (await git(first, ["rev-parse", "HEAD"])).trim();
  await manager.harvest(key);
  await manager.remove(key);

  const resumed = await manager.create(key);

  assert.equal((await git(resumed, ["branch", "--show-current"])).trim(), `task/${key}`);
  assert.equal((await git(resumed, ["rev-parse", "HEAD"])).trim(), implementationCommit);
  await access(join(resumed, "implementation.txt"));
});

test("workspace scoping uses the workflow workspace key across stage task ids", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "workspaces"), repositoryPath: repo });
  const inner = new FakeLauncher();
  const launcher = new WorkspaceScopedLauncher(inner, manager);
  const workflow = {
    planRevisionId: "plan-pipeline",
    nodeId: "node-pipeline",
    stage: "implementation",
    skills: [],
    dependencyHandoffs: [],
    workspaceKey: "work-item-pipeline",
    pipeline: null,
  } as unknown as NonNullable<BoundedAgentContext["workflow"]>;

  const handle = await launcher.launch({
    runId: "run-pipeline-stage",
    wakeReason: "workflow_handoff",
    context: context({ taskId: "implementation-attempt-task", workflow }),
  });

  assert.equal(inner.requests[0]?.workspace?.path, manager.workspacePath("work-item-pipeline"));
  inner.handles[0]?.resolve({ ...completedOutcome("failed"), status: "failed" });
  await handle.completion;
});

test("a first pipeline launch creates its workspace branch from the confirmed base SHA", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await commitFile(repo, "later.txt", "advanced HEAD\n", "advance source HEAD");
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "workspaces"), repositoryPath: repo });
  const inner = new FakeLauncher();
  const launcher = new WorkspaceScopedLauncher(inner, manager);
  const workspaceKey = "base-anchored-item";

  const handle = await launcher.launch({
    runId: "run-base-anchored",
    wakeReason: "workflow_handoff",
    context: context({
      taskId: "implementation-base-anchored",
      workflow: pipelineWorkflow(workspaceKey, baseSha),
    }),
  });

  const workspace = manager.workspacePath(workspaceKey);
  assert.equal((await git(workspace, ["rev-parse", "HEAD"])).trim(), baseSha);
  assert.equal((await git(workspace, ["branch", "--show-current"])).trim(), `task/${workspaceKey}`);
  await assert.rejects(access(join(workspace, "later.txt")));
  inner.handles[0]?.resolve({ ...completedOutcome("failed"), status: "failed" });
  await handle.completion;
});

test("two completed launches preserve both commits on one harvested task branch", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "workspaces"), repositoryPath: repo });
  const workspaceKey = "sequential-pipeline-item";
  const commits: string[] = [];
  let launches = 0;
  const inner: AgentLauncher = {
    async launch(request): Promise<AgentRunHandle> {
      launches += 1;
      assert.ok(request.workspace);
      if (launches === 2) {
        assert.equal(await readFile(join(request.workspace.path, "round-1.txt"), "utf8"), "first round\n");
      }
      commits.push(await commitFile(
        request.workspace.path,
        `round-${launches}.txt`,
        launches === 1 ? "first round\n" : "second round\n",
        `round ${launches}`,
      ));
      return {
        completion: Promise.resolve(completedOutcome(`round ${launches}`)),
        activity: (async function* activity() { return; })(),
        interrupt: () => Promise.resolve(),
      };
    },
  };
  const launcher = new WorkspaceScopedLauncher(inner, manager);

  for (const round of [1, 2]) {
    const handle = await launcher.launch({
      runId: `run-sequential-${round}`,
      wakeReason: "workflow_handoff",
      context: context({
        taskId: `pipeline-stage-${round}`,
        workflow: pipelineWorkflow(workspaceKey, baseSha),
      }),
    });
    assert.equal((await handle.completion).status, "completed");
  }

  assert.equal(launches, 2);
  assert.deepEqual(
    (await git(repo, ["rev-list", "--reverse", `${baseSha}..task/${workspaceKey}`])).trim().split("\n"),
    commits,
  );
  assert.equal(await git(repo, ["show", `task/${workspaceKey}:round-1.txt`]), "first round\n");
  assert.equal(await git(repo, ["show", `task/${workspaceKey}:round-2.txt`]), "second round\n");
});
