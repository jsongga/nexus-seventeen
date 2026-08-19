import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mergePipelineBranch, runMergeGit } from "#server/task-board/collaborators/merge-executor";

function git(repo: string, ...arguments_: string[]): string {
  return execFileSync("git", ["-C", repo, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function fixtureRepo(
  mergeTarget = "main",
): Promise<Readonly<{ root: string; repo: string; baseSha: string; branch: string; mergeTarget: string }>> {
  const root = await mkdtemp(join(tmpdir(), "steward-final-merge-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-b", mergeTarget, repo]);
  git(repo, "config", "user.name", "Task Board Test");
  git(repo, "config", "user.email", "task-board@example.test");
  await writeFile(join(repo, "shared.txt"), "base\n");
  git(repo, "add", "shared.txt");
  git(repo, "commit", "-m", "initial");
  const baseSha = git(repo, "rev-parse", "HEAD").trim();
  return Object.freeze({ root, repo, baseSha, branch: "task/work-item-one", mergeTarget });
}

test("mergePipelineBranch merges into a clean trunk target even when the repository has multiple branches", async (t) => {
  const fixture = await fixtureRepo("trunk");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  git(fixture.repo, "branch", "develop");
  git(fixture.repo, "branch", "release");
  git(fixture.repo, "switch", "-c", fixture.branch);
  await writeFile(join(fixture.repo, "feature.txt"), "pipeline change\n");
  git(fixture.repo, "add", "feature.txt");
  git(fixture.repo, "commit", "-m", "add pipeline change");
  const branchSha = git(fixture.repo, "rev-parse", "HEAD").trim();
  git(fixture.repo, "switch", fixture.mergeTarget);

  const result = mergePipelineBranch({
    repoPath: fixture.repo,
    branch: fixture.branch,
    baseSha: fixture.baseSha,
    git: runMergeGit,
  });

  assert.equal(result.kind, "merged");
  if (result.kind !== "merged") return;
  assert.equal(git(fixture.repo, "rev-parse", "HEAD").trim(), result.mergeSha);
  assert.match(git(fixture.repo, "rev-list", "--parents", "-n", "1", result.mergeSha), new RegExp(branchSha, "u"));
  assert.equal(git(fixture.repo, "status", "--porcelain", "-z"), "");
});

test("mergePipelineBranch aborts a conflict and leaves the repository clean", async (t) => {
  const fixture = await fixtureRepo();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  git(fixture.repo, "switch", "-c", fixture.branch);
  await writeFile(join(fixture.repo, "shared.txt"), "pipeline\n");
  git(fixture.repo, "add", "shared.txt");
  git(fixture.repo, "commit", "-m", "pipeline edit");
  git(fixture.repo, "switch", "main");
  await writeFile(join(fixture.repo, "shared.txt"), "default branch\n");
  git(fixture.repo, "add", "shared.txt");
  git(fixture.repo, "commit", "-m", "default edit");
  const before = git(fixture.repo, "rev-parse", "HEAD").trim();

  const result = mergePipelineBranch({
    repoPath: fixture.repo,
    branch: fixture.branch,
    baseSha: fixture.baseSha,
    git: runMergeGit,
  });

  assert.equal(result.kind, "conflict");
  if (result.kind !== "conflict") return;
  assert.match(result.summary, /conflict/iu);
  assert.equal(git(fixture.repo, "rev-parse", "HEAD").trim(), before);
  assert.equal(git(fixture.repo, "status", "--porcelain", "-z"), "");
  assert.throws(() => git(fixture.repo, "rev-parse", "--verify", "MERGE_HEAD"));
});

test("mergePipelineBranch reports repo_busy when another task branch is checked out", async (t) => {
  const fixture = await fixtureRepo();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  git(fixture.repo, "branch", fixture.branch);
  git(fixture.repo, "switch", "-c", "task/operator-work");

  assert.deepEqual(mergePipelineBranch({
    repoPath: fixture.repo,
    branch: fixture.branch,
    baseSha: fixture.baseSha,
    git: runMergeGit,
  }), { kind: "repo_busy" });
});

test("mergePipelineBranch reports repo_busy when the default branch worktree is dirty", async (t) => {
  const fixture = await fixtureRepo();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  git(fixture.repo, "branch", fixture.branch);
  await writeFile(join(fixture.repo, "shared.txt"), "uncommitted operator work\n");

  assert.deepEqual(mergePipelineBranch({
    repoPath: fixture.repo,
    branch: fixture.branch,
    baseSha: fixture.baseSha,
    git: runMergeGit,
  }), { kind: "repo_busy" });
});

test("mergePipelineBranch reports diverged when the pipeline base is not an ancestor of the merge target", async (t) => {
  const fixture = await fixtureRepo("trunk");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  git(fixture.repo, "branch", fixture.branch);
  git(fixture.repo, "switch", "--orphan", "develop");
  await writeFile(join(fixture.repo, "unrelated.txt"), "unrelated history\n");
  git(fixture.repo, "add", ".");
  git(fixture.repo, "commit", "-m", "unrelated root");

  const result = mergePipelineBranch({
    repoPath: fixture.repo,
    branch: fixture.branch,
    baseSha: fixture.baseSha,
    git: runMergeGit,
  });

  assert.equal(result.kind, "diverged");
  if (result.kind !== "diverged") return;
  assert.match(result.detail, /not an ancestor of merge target develop/iu);
});
