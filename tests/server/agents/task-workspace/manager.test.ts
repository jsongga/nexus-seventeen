import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { TaskWorkspaceManager, TaskWorkspaceError } from "#server/agents/task-workspace";
import { tempRoot } from "../task-worker/helpers.js";

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

test("create clones without hardlinks, branches task/<key>, and is reset-idempotent", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo });
  const path = await manager.create("task-a");
  assert.equal(path, manager.workspacePath("task-a"));
  await access(join(path, ".git"));
  assert.equal((await run(path, "git", ["branch", "--show-current"])).trim(), "task/task-a");
  await writeFile(join(path, "leftover.txt"), "stale");
  const again = await manager.create("task-a");
  await assert.rejects(access(join(again, "leftover.txt")));
});

test("harvest publishes the task branch into the source repo and force-updates on re-harvest", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo });
  const path = await manager.create("task-b");
  await writeFile(join(path, "work.txt"), "done\n");
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "add", "."]);
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "work"]);
  await manager.harvest("task-b");
  const shown = await run(repo, "git", ["show", "task/task-b:work.txt"]);
  assert.equal(shown, "done\n");
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "--amend", "-m", "rework"]);
  await manager.harvest("task-b");
  assert.match(await run(repo, "git", ["log", "-1", "--format=%s", "task/task-b"]), /rework/u);
});

test("a hook planted inside the workspace never executes on the host during harvest", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo });
  const path = await manager.create("task-c");
  const marker = join(root, "hook-ran");
  for (const hook of ["post-checkout", "post-commit", "reference-transaction", "post-update"]) {
    await writeFile(join(path, ".git", "hooks", hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  }
  await writeFile(join(path, "work.txt"), "x\n");
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "add", "work.txt"]);
  await run(path, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "x"]);
  await rm(marker, { force: true });
  await manager.harvest("task-c");
  await assert.rejects(access(marker), { code: "ENOENT" }, "workspace hooks must not run on the host");
});

test("remove is idempotent, retain caps the debugging cache, and bad inputs are rejected", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo, retainedLimit: 1 });
  await manager.remove("never-created");
  await manager.create("task-d");
  await manager.retain("task-d");
  await manager.create("task-e");
  await manager.retain("task-e");
  const { readdir } = await import("node:fs/promises");
  const retained = (await readdir(join(root, "ws"))).filter((name) => name.startsWith("retained-"));
  assert.equal(retained.length, 1);
  assert.match(retained[0] ?? "", /^retained-task-e-/u);
  await manager.retain("task-d"); // already gone — no-op
  assert.throws(() => new TaskWorkspaceManager({ workspaceRoot: "relative", repositoryPath: repo }), TaskWorkspaceError);
  await assert.rejects(manager.create("../escape"), TaskWorkspaceError);
  await assert.rejects(manager.create("retained-x"), TaskWorkspaceError);
});
