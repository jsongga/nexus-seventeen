import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { TaskWorkspaceManager, WorkspaceScopedLauncher } from "#server/agents/task-workspace";
import { FakeLauncher, completedOutcome, context, tempRoot } from "../task-worker/helpers.js";

function run(cwd: string, command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr));
      else resolve(stdout);
    });
  });
}

async function fixtureRepo(root: string): Promise<string> {
  const repo = join(root, "repo");
  await run(root, "git", ["init", "-b", "main", repo]);
  await writeFile(join(repo, "readme.md"), "hello\n");
  await run(repo, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "add", "."]);
  await run(repo, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return repo;
}

function request(taskId: string) {
  return {
    runId: "run-workspace",
    wakeReason: "human_assignment" as const,
    context: context({ taskId }),
  };
}

test("launch scopes the inner launcher to an existing per-task workspace", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo });
  const inner = new FakeLauncher();
  const launcher = new WorkspaceScopedLauncher(inner, manager);

  const handle = await launcher.launch(request("task-launch"));

  assert.equal(inner.requests[0]?.workspace?.path, manager.workspacePath("task-launch"));
  await access(manager.workspacePath("task-launch"));
  inner.handles[0]?.resolve({ ...completedOutcome("failed"), status: "failed" });
  await handle.completion;
});

test("a completed outcome harvests the task branch and removes the workspace", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo });
  const inner = new FakeLauncher();
  const launcher = new WorkspaceScopedLauncher(inner, manager);
  const key = "task-completed";

  const handle = await launcher.launch(request(key));
  const path = manager.workspacePath(key);
  await writeFile(join(path, "work.txt"), "done\n");
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "add", "."]);
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "work"]);
  inner.handles[0]?.resolve(completedOutcome());

  assert.equal((await handle.completion).status, "completed");
  assert.equal(await run(repo, "git", ["show", `task/${key}:work.txt`]), "done\n");
  await assert.rejects(access(path));
});

test("a taskId ending in the review suffix keeps normal workspace semantics without workflow context", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo });
  const inner = new FakeLauncher();
  const launcher = new WorkspaceScopedLauncher(inner, manager);
  const key = "task-id-review";

  const handle = await launcher.launch(request(key));
  const path = manager.workspacePath(key);
  await writeFile(join(path, "work.txt"), "normal task work\n");
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "add", "."]);
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "normal task work"]);
  inner.handles[0]?.resolve(completedOutcome());

  assert.equal((await handle.completion).status, "completed");
  assert.equal(await run(repo, "git", ["show", `task/${key}:work.txt`]), "normal task work\n");
  await assert.rejects(access(path));
});

test("a completed outcome harvests its branch and retains uncommitted workspace changes", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const workspaceRoot = join(root, "ws");
  const manager = new TaskWorkspaceManager({ workspaceRoot, repositoryPath: repo });
  const inner = new FakeLauncher();
  const launcher = new WorkspaceScopedLauncher(inner, manager);
  const key = "task-completed-dirty";

  const handle = await launcher.launch(request(key));
  const path = manager.workspacePath(key);
  await writeFile(join(path, "work.txt"), "committed\n");
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "add", "."]);
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "work"]);
  await writeFile(join(path, "evidence.txt"), "uncommitted\n");
  inner.handles[0]?.resolve(completedOutcome());

  assert.equal((await handle.completion).status, "completed");
  assert.equal(await run(repo, "git", ["show", `task/${key}:work.txt`]), "committed\n");
  const retained = (await readdir(workspaceRoot)).filter((name) => name.startsWith(`retained-${key}-`));
  assert.equal(retained.length, 1);
  assert.equal(await readFile(join(workspaceRoot, retained[0] ?? "", "evidence.txt"), "utf8"), "uncommitted\n");
});

test("a failed outcome retains the workspace without harvesting the task branch", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const workspaceRoot = join(root, "ws");
  const manager = new TaskWorkspaceManager({ workspaceRoot, repositoryPath: repo });
  const inner = new FakeLauncher();
  const launcher = new WorkspaceScopedLauncher(inner, manager);
  const key = "task-failed";
  inner.outcomes.push({ ...completedOutcome("failed"), status: "failed" });

  const handle = await launcher.launch(request(key));

  assert.equal((await handle.completion).status, "failed");
  const retained = (await readdir(workspaceRoot)).filter((name) => name.startsWith(`retained-${key}-`));
  assert.equal(retained.length, 1);
  await assert.rejects(run(repo, "git", ["show-ref", "--verify", `refs/heads/task/${key}`]));
});

test("an inner launch failure retains the workspace and rethrows", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const workspaceRoot = join(root, "ws");
  const manager = new TaskWorkspaceManager({ workspaceRoot, repositoryPath: repo });
  const inner = new FakeLauncher();
  const failure = new Error("launch failed");
  inner.launch = () => Promise.reject(failure);
  const launcher = new WorkspaceScopedLauncher(inner, manager);

  await assert.rejects(launcher.launch(request("task-throw")), failure);
  const retained = (await readdir(workspaceRoot)).filter((name) => name.startsWith("retained-task-throw-"));
  assert.equal(retained.length, 1);
});

test("interrupt passes through to the inner run handle", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo });
  const inner = new FakeLauncher();
  const launcher = new WorkspaceScopedLauncher(inner, manager);

  const handle = await launcher.launch(request("task-interrupt"));
  await handle.interrupt("operator request");

  assert.deepEqual(inner.handles[0]?.interruptReasons, ["operator request"]);
  inner.handles[0]?.resolve({ ...completedOutcome("failed"), status: "failed" });
  await handle.completion;
});
