import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadDocsPublishConfig,
  parseDocsPublishConfig,
} from "../../../src/server/docs-publish/config.js";

function validConfig(): Record<string, unknown> {
  return {
    version: 1,
    outline: { baseUrl: "https://outline.example.test" },
    repos: [{ name: "nexus-seventeen", path: ".", ref: "HEAD", exclude: ["docs/superpowers/**"] }],
  };
}

test("parses and deeply freezes docs publisher configuration", () => {
  const config = parseDocsPublishConfig(validConfig());

  assert.deepEqual(config, validConfig());
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.outline));
  assert.ok(Object.isFrozen(config.repos));
  assert.ok(Object.isFrozen(config.repos[0]));
  assert.ok(Object.isFrozen(config.repos[0]?.exclude));
});

test("parses the shipped docs publisher configuration", async () => {
  const path = join(process.cwd(), "config", "docs-publish.json");
  const source = JSON.parse(await readFile(path, "utf8")) as unknown;
  const config = parseDocsPublishConfig(source);

  assert.equal(config.outline.baseUrl, "https://docs.cicadasystem.com");
  assert.deepEqual(config.repos, [
    { name: "nexus-seventeen", path: ".", ref: "HEAD", exclude: ["docs/superpowers/**"] },
  ]);
});

test("rejects unknown fields, bad versions, insecure URLs, and unsupported exclude globs", () => {
  const unknown = validConfig();
  unknown.token = "must-not-live-in-config";
  assert.throws(() => parseDocsPublishConfig(unknown), /unknown field token/u);

  const badVersion = validConfig();
  badVersion.version = 2;
  assert.throws(() => parseDocsPublishConfig(badVersion), /version must be 1/u);

  const insecure = validConfig();
  (insecure.outline as Record<string, unknown>).baseUrl = "http://outline.example.test";
  assert.throws(() => parseDocsPublishConfig(insecure), /HTTPS.*allowInsecureBaseUrl/u);

  const badGlob = validConfig();
  ((badGlob.repos as Array<Record<string, unknown>>)[0]!).exclude = ["docs/*.md"];
  assert.throws(() => parseDocsPublishConfig(badGlob), /exclude.*<prefix>\/\*\*/u);

  const allowed = validConfig();
  allowed.outline = { baseUrl: "http://127.0.0.1:3000", allowInsecureBaseUrl: true };
  assert.equal(parseDocsPublishConfig(allowed).outline.baseUrl, "http://127.0.0.1:3000");
});

test("rejects repository names that would corrupt source-banner markup", () => {
  const backticked = validConfig();
  ((backticked.repos as Array<Record<string, unknown>>)[0]!).name = "bad`name";
  assert.throws(() => parseDocsPublishConfig(backticked), /repos\[0\]\.name.*backtick/u);

  const multiline = validConfig();
  ((multiline.repos as Array<Record<string, unknown>>)[0]!).name = "bad\nname";
  assert.throws(() => parseDocsPublishConfig(multiline), /repos\[0\]\.name/u);
});

test("loads only bounded regular JSON files without following symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-docs-config-"));
  const validPath = join(root, "docs-publish.json");
  const oversizedPath = join(root, "oversized.json");
  const symlinkPath = join(root, "linked.json");
  await writeFile(validPath, JSON.stringify(validConfig()), { mode: 0o600 });
  await writeFile(oversizedPath, " ".repeat(1024 * 1024 + 1), { mode: 0o600 });
  await symlink(validPath, symlinkPath);

  assert.equal((await loadDocsPublishConfig(validPath)).repos[0]?.name, "nexus-seventeen");
  await assert.rejects(loadDocsPublishConfig(oversizedPath), /no larger than 1 MiB/u);
  await assert.rejects(loadDocsPublishConfig(symlinkPath));
});
