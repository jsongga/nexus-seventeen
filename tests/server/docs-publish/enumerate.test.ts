import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enumerateDocs } from "../../../src/server/docs-publish/enumerate.js";

function git(repo: string, ...arguments_: string[]): string {
  return execFileSync("git", ["-C", repo, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("enumerates committed markdown from the requested ref and applies prefix excludes", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-docs-enumerate-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, "docs", "nested"), { recursive: true });
  await mkdir(join(repo, "docs", "superpowers"), { recursive: true });
  await mkdir(join(repo, "docs", "superpowers-extra"), { recursive: true });
  await writeFile(join(repo, "README.md"), "# Committed readme\n");
  await writeFile(join(repo, "docs", "guide.md"), "# Guide\n");
  await writeFile(join(repo, "docs", "nested", "deep.md"), "# Deep\n");
  await writeFile(join(repo, "docs", "superpowers", "plan.md"), "# Internal plan\n");
  await writeFile(join(repo, "docs", "superpowers-extra", "x.md"), "# Public near-match\n");
  await writeFile(join(repo, "docs", "ignored.txt"), "not markdown\n");

  git(repo, "init", "-b", "main");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Docs Test", "-c", "user.email=docs@example.test", "commit", "-m", "fixture");

  await writeFile(join(repo, "docs", "worktree-only.md"), "# Must stay invisible\n");
  await writeFile(join(repo, "README.md"), "# Uncommitted replacement\n");

  const sources = enumerateDocs(repo, "HEAD", { exclude: ["docs/superpowers/**"] });

  assert.deepEqual(sources, [
    { path: "README.md", title: "README.md", markdown: "# Committed readme\n" },
    { path: "docs/guide.md", title: "docs/guide.md", markdown: "# Guide\n" },
    { path: "docs/nested/deep.md", title: "docs/nested/deep.md", markdown: "# Deep\n" },
    {
      path: "docs/superpowers-extra/x.md",
      title: "docs/superpowers-extra/x.md",
      markdown: "# Public near-match\n",
    },
  ]);
  assert.equal(sources.some((source) => source.path === "docs/worktree-only.md"), false);
});

test("rejects the same unsafe exclude patterns as config parsing before invoking git", () => {
  const patterns = [
    "/docs/private/**",
    "docs/*/private/**",
    "docs/./private/**",
    "docs/../private/**",
  ];

  for (const pattern of patterns) {
    assert.throws(
      () => enumerateDocs("/repo", "HEAD", { exclude: [pattern] }, () => {
        throw new Error("git must not run for an invalid exclude");
      }),
      /glob-lite <prefix>\/\*\* syntax/u,
      pattern,
    );
  }
});
