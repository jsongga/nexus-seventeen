import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("create can isolate a verify workspace while resuming the work item's task branch", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  await run(repo, "git", ["checkout", "-b", "task/work-item-a"]);
  await writeFile(join(repo, "implementation.txt"), "committed implementation\n");
  await run(repo, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "add", "implementation.txt"]);
  await run(repo, "git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "implementation"]);
  await run(repo, "git", ["checkout", "main"]);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo });

  const path = await manager.create("work-item-a-verify", undefined, "work-item-a");

  assert.equal(path, manager.workspacePath("work-item-a-verify"));
  assert.equal((await run(path, "git", ["branch", "--show-current"])).trim(), "task/work-item-a");
  assert.equal(await readFile(join(path, "implementation.txt"), "utf8"), "committed implementation\n");
});

test("create rejects unsafe keys before touching the filesystem", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const workspaceRoot = join(root, "ws");
  const outsidePath = join(root, "state");
  await writeFile(outsidePath, "outside\n");
  const manager = new TaskWorkspaceManager({ workspaceRoot, repositoryPath: repo });

  await assert.rejects(manager.create("a/../../state"), TaskWorkspaceError);

  assert.equal(await readFile(outsidePath, "utf8"), "outside\n");
  await assert.rejects(access(workspaceRoot), { code: "ENOENT" });
  for (const key of ["foo:bar", "a..b", "trailing."]) {
    assert.throws(() => manager.workspacePath(key), TaskWorkspaceError);
  }
});

test("create removes the cloned workspace when base ref selection fails", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo });
  const path = manager.workspacePath("task-bad-ref");

  await assert.rejects(manager.create("task-bad-ref", "refs/heads/does-not-exist"), TaskWorkspaceError);

  await assert.rejects(access(path), { code: "ENOENT" });
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

test("dirty checks disable an agent-controlled core.fsmonitor executable", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo });
  const path = await manager.create("task-fsmonitor");
  const marker = join(root, "fsmonitor-ran");
  const fsmonitor = join(root, "fsmonitor.sh");
  await writeFile(fsmonitor, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nprintf 'token\\n'\n`, { mode: 0o755 });
  await run(path, "git", ["config", "core.fsmonitor", fsmonitor]);

  await writeFile(join(path, "dirty.txt"), "dirty\n");
  assert.equal(await manager.hasUncommittedChanges("task-fsmonitor"), true);
  await assert.rejects(access(marker), { code: "ENOENT" }, "core.fsmonitor must not run on the host");

  await rm(join(path, "dirty.txt"));
  assert.equal(await manager.hasUncommittedChanges("task-fsmonitor"), false);
  await assert.rejects(access(marker), { code: "ENOENT" }, "core.fsmonitor must remain disabled");
});

test("remove is idempotent, retain prunes oldest timestamps across keys, and bad inputs are rejected", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const manager = new TaskWorkspaceManager({ workspaceRoot: join(root, "ws"), repositoryPath: repo, retainedLimit: 1 });
  await manager.remove("never-created");
  await manager.create("task-z");
  await manager.retain("task-z");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await manager.create("task-a");
  await manager.retain("task-a");
  const { readdir } = await import("node:fs/promises");
  const retained = (await readdir(join(root, "ws"))).filter((name) => name.startsWith("retained-"));
  assert.equal(retained.length, 1);
  assert.match(retained[0] ?? "", /^retained-task-a-/u);
  await manager.retain("task-z"); // already gone — no-op
  assert.throws(() => new TaskWorkspaceManager({ workspaceRoot: "relative", repositoryPath: repo }), TaskWorkspaceError);
  await assert.rejects(manager.create("../escape"), TaskWorkspaceError);
  await assert.rejects(manager.create("retained-x"), TaskWorkspaceError);
});

test("retain ignores only missing workspaces and wraps other stat failures", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const workspaceRoot = join(root, "ws");
  const manager = new TaskWorkspaceManager({ workspaceRoot, repositoryPath: repo });
  await manager.retain("missing");
  await mkdir(workspaceRoot, { recursive: true });
  await symlink("task-loop", manager.workspacePath("task-loop"));

  await assert.rejects(manager.retain("task-loop"), (error: unknown) => {
    assert.ok(error instanceof TaskWorkspaceError);
    assert.equal((error.cause as NodeJS.ErrnoException).code, "ELOOP");
    return true;
  });
});

test("retainStrays retains direct child workspaces and enforces the retained cap", async () => {
  const root = await tempRoot();
  const repo = await fixtureRepo(root);
  const workspaceRoot = join(root, "ws");
  await mkdir(join(workspaceRoot, "retained-old-1"), { recursive: true });
  await mkdir(join(workspaceRoot, "task-stray-a"));
  await mkdir(join(workspaceRoot, "task-stray-b"));
  const manager = new TaskWorkspaceManager({ workspaceRoot, repositoryPath: repo, retainedLimit: 2 });

  await manager.retainStrays([]);

  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(workspaceRoot);
  assert.equal(entries.length, 2);
  assert.equal(entries.some((name) => name.startsWith("retained-task-stray-a-")), true);
  assert.equal(entries.some((name) => name.startsWith("retained-task-stray-b-")), true);
});
