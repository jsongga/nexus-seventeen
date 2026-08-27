import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDocsPublishCli } from "../../../src/server/docs-publish/main.js";

function git(repo: string, ...arguments_: string[]): void {
  execFileSync("git", ["-C", repo, ...arguments_], { stdio: ["ignore", "pipe", "pipe"] });
}

test("dry-run publishes reports without reading a token or constructing the configured sink", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-docs-cli-"));
  const repo = join(root, "repo");
  const configPath = join(root, "docs-publish.json");
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "# Fixture\n");
  git(repo, "init", "-b", "main");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Docs Test", "-c", "user.email=docs@example.test", "commit", "-m", "fixture");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    outline: { baseUrl: "https://outline.example.test" },
    repos: [{ name: "fixture", path: repo, ref: "HEAD" }],
  }));

  const previousToken = process.env.STEWARD_OUTLINE_API_TOKEN;
  const previousLog = console.log;
  const lines: string[] = [];
  let factoryCalls = 0;
  delete process.env.STEWARD_OUTLINE_API_TOKEN;
  console.log = (...values: unknown[]) => { lines.push(values.join(" ")); };
  try {
    const exitCode = await runDocsPublishCli(["--config", configPath, "--dry-run"], () => {
      factoryCalls += 1;
      throw new Error("dry-run must not construct the real sink");
    });
    assert.equal(exitCode, 0);
  } finally {
    console.log = previousLog;
    if (previousToken === undefined) delete process.env.STEWARD_OUTLINE_API_TOKEN;
    else process.env.STEWARD_OUTLINE_API_TOKEN = previousToken;
  }

  assert.equal(factoryCalls, 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? "") as unknown, {
    repo: "fixture",
    created: 1,
    updated: 0,
    archived: 0,
    unchanged: 0,
    failures: [],
  });
});
