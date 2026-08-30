import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectPipelineBranch, type PipelineInspection } from "#server/task-board/collaborators/pipeline-inspection";
import type { GitTextRunner } from "#server/task-board/collaborators/scope-check";

const SHA = "a".repeat(40);
const SAFE_PREFIX = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=", "-C", "/repo"] as const;

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout);
      else reject(new Error(stderr));
    });
  });
}

test("pipeline inspection uses safe git argv and maps name-status paths into review evidence", async () => {
  const calls: string[][] = [];
  const git: GitTextRunner = (arguments_) => {
    calls.push([...arguments_]);
    if (arguments_.includes("log")) return `${SHA}\0Implement the review context\0`;
    if (arguments_.includes("--stat")) return " 3 files changed, 2 insertions(+), 1 deletion(-)\n";
    if (arguments_.includes("--name-status")) {
      return "A\0src/added.ts\0M\0src/changed.ts\0D\0src/deleted.ts\0";
    }
    throw new Error(`unexpected git command: ${arguments_.join(" ")}`);
  };

  const inspection: PipelineInspection = await inspectPipelineBranch({
    repoPath: "/repo",
    baseSha: "b".repeat(40),
    branch: "task/work-item-review",
    declaredScope: ["src"],
    git,
  });

  assert.deepEqual(inspection, {
    commits: [{ sha: SHA, subject: "Implement the review context" }],
    diffstat: " 3 files changed, 2 insertions(+), 1 deletion(-)\n",
    filesTouched: [
      { path: "src/added.ts", status: "added" },
      { path: "src/changed.ts", status: "modified" },
      { path: "src/deleted.ts", status: "deleted" },
    ],
    scopeOk: true,
  });
  assert.equal(calls.length, 3);
  for (const call of calls) assert.deepEqual(call.slice(0, SAFE_PREFIX.length), SAFE_PREFIX);
  assert.deepEqual(calls[2]?.slice(SAFE_PREFIX.length), [
    "diff",
    "--no-renames",
    "--name-status",
    "-z",
    `${"b".repeat(40)}..task/work-item-review`,
    "--",
  ]);
});

test("pipeline inspection reuses declared-scope prefix checks for status paths", async () => {
  const git: GitTextRunner = (arguments_) => {
    if (arguments_.includes("log") || arguments_.includes("--stat")) return "";
    return "M\0docs/outside.md\0";
  };

  const inspection = await inspectPipelineBranch({
    repoPath: "/repo",
    baseSha: "c".repeat(40),
    branch: "task/work-item-review",
    declaredScope: ["src"],
    git,
  });

  assert.equal(inspection.scopeOk, false);
});

test("pipeline inspection treats a committed file-to-symlink type change as modified", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-pipeline-type-change-"));
  const repo = join(root, "repo");
  try {
    await runGit(root, ["init", "-b", "main", repo]);
    await runGit(repo, ["config", "user.name", "Pipeline Inspection Test"]);
    await runGit(repo, ["config", "user.email", "pipeline-inspection@test.invalid"]);
    await mkdir(join(repo, "src"), { recursive: true });
    const changedPath = join(repo, "src", "value.ts");
    await writeFile(changedPath, "export const value = 1;\n");
    await runGit(repo, ["add", "src/value.ts"]);
    await runGit(repo, ["commit", "-m", "base file"]);
    const baseSha = (await runGit(repo, ["rev-parse", "HEAD"])).trim();
    await runGit(repo, ["switch", "-c", "task/type-change"]);
    await unlink(changedPath);
    await symlink("target.ts", changedPath);
    await runGit(repo, ["add", "src/value.ts"]);
    await runGit(repo, ["commit", "-m", "convert file to symlink"]);

    const inspection = await inspectPipelineBranch({
      repoPath: repo,
      baseSha,
      branch: "task/type-change",
      declaredScope: ["src"],
    });

    assert.deepEqual(inspection.filesTouched, [{ path: "src/value.ts", status: "modified" }]);
    assert.equal(inspection.scopeOk, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
