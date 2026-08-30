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
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      outline: { baseUrl: "https://outline.example.test" },
      repos: [{ name: "fixture", path: repo, ref: "HEAD" }],
    })
  );

  const previousToken = process.env.STEWARD_OUTLINE_API_TOKEN;
  const previousLog = console.log;
  const lines: string[] = [];
  let factoryCalls = 0;
  delete process.env.STEWARD_OUTLINE_API_TOKEN;
  console.log = (...values: unknown[]) => {
    lines.push(values.join(" "));
  };
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

test("non-dry publishing constructs the real Outline sink from config and token", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-docs-cli-outline-"));
  const repo = join(root, "repo");
  const configPath = join(root, "docs-publish.json");
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "# Fixture\n");
  git(repo, "init", "-b", "main");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Docs Test", "-c", "user.email=docs@example.test", "commit", "-m", "fixture");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      outline: { baseUrl: "http://127.0.0.1:3000", allowInsecureBaseUrl: true },
      repos: [{ name: "fixture", path: repo, ref: "HEAD" }],
    })
  );

  const responses = [
    {
      data: [{ id: "collection-1", name: "fixture docs", permission: "read" }],
      pagination: { limit: 100, offset: 0, total: 1 },
    },
    { data: [], pagination: { limit: 100, offset: 0, total: 0 } },
    { data: { id: "document-1", title: "README.md" } },
  ];
  const paths: string[] = [];
  const previousToken = process.env.STEWARD_OUTLINE_API_TOKEN;
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const lines: string[] = [];
  process.env.STEWARD_OUTLINE_API_TOKEN = `ol_api_${"a".repeat(38)}`;
  globalThis.fetch = (async (input, init = {}) => {
    paths.push(new URL(String(input)).pathname);
    assert.equal((init.headers as Record<string, string>).authorization, `Bearer ol_api_${"a".repeat(38)}`);
    const response = responses.shift();
    assert.ok(response);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  console.log = (...values: unknown[]) => {
    lines.push(values.join(" "));
  };
  try {
    assert.equal(await runDocsPublishCli(["--config", configPath]), 0);
  } finally {
    console.log = previousLog;
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.STEWARD_OUTLINE_API_TOKEN;
    else process.env.STEWARD_OUTLINE_API_TOKEN = previousToken;
  }

  assert.deepEqual(paths, ["/api/collections.list", "/api/documents.list", "/api/documents.create"]);
  assert.equal(responses.length, 0);
  assert.deepEqual(JSON.parse(lines[0] ?? "") as unknown, {
    repo: "fixture",
    created: 1,
    updated: 0,
    archived: 0,
    unchanged: 0,
    failures: [],
  });
});

test("prints an enumeration failure, continues with later repos, and exits nonzero", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-docs-cli-enumerate-failure-"));
  const repo = join(root, "repo");
  const configPath = join(root, "docs-publish.json");
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "# Fixture\n");
  git(repo, "init", "-b", "main");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Docs Test", "-c", "user.email=docs@example.test", "commit", "-m", "fixture");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      outline: { baseUrl: "https://outline.example.test" },
      repos: [
        { name: "missing", path: join(root, "missing-repo"), ref: "HEAD" },
        { name: "fixture", path: repo, ref: "HEAD" },
      ],
    })
  );

  const previousLog = console.log;
  const lines: string[] = [];
  console.log = (...values: unknown[]) => {
    lines.push(values.join(" "));
  };
  let exitCode = -1;
  try {
    exitCode = await runDocsPublishCli(["--config", configPath, "--dry-run"]);
  } finally {
    console.log = previousLog;
  }

  assert.equal(exitCode, 1);
  assert.equal(lines.length, 2);
  const failed = JSON.parse(lines[0] ?? "") as { readonly repo: string; readonly failures: readonly string[] };
  assert.equal(failed.repo, "missing");
  assert.equal(failed.failures.length, 1);
  assert.match(failed.failures[0] ?? "", /^enumerate: /u);
  assert.deepEqual(JSON.parse(lines[1] ?? "") as unknown, {
    repo: "fixture",
    created: 1,
    updated: 0,
    archived: 0,
    unchanged: 0,
    failures: [],
  });
});
