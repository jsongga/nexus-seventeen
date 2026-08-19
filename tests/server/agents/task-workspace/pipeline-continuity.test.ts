import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { TaskWorkspaceManager, WorkspaceScopedLauncher } from "#server/agents/task-workspace";
import type { BoundedAgentContext } from "#server/agents/task-worker/types";
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
