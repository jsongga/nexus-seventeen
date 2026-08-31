import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  GIT_MAX_BYTES,
  GIT_TIMEOUT_MS,
  createGitRunner,
  gitExecOptions,
  redactGitFailureForTest,
  gitArguments,
  isRegularFileMode,
  parseGitTreeEntry,
  runGit,
  runGitBytes,
  splitGitTreeOutput,
  withGitBytes,
} from "../../../src/server/shared/git.js";

const repositories: string[] = [];

after(() => {
  for (const path of repositories) rmSync(path, { force: true, recursive: true });
});

function repository(): string {
  const path = mkdtempSync(join(tmpdir(), "nexus-git-"));
  repositories.push(path);
  const run = (...arguments_: string[]) =>
    execFileSync("git", ["-C", path, ...arguments_], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run("init", "--quiet", "--initial-branch", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  return path;
}

function commitAll(path: string, message: string): string {
  const run = (...arguments_: string[]) =>
    execFileSync("git", ["-C", path, ...arguments_], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run("add", "-A");
  run("commit", "--quiet", "-m", message);
  return run("rev-parse", "HEAD").trim();
}

test("the prelude disables the filesystem monitor and hooks and scopes to the repository", () => {
  assert.deepEqual(gitArguments("/repo", ["status"]), [
    "-c",
    "core.fsmonitor=",
    "-c",
    "core.hooksPath=",
    "-C",
    "/repo",
    "status",
  ]);
});

test("the bounds are applied to the call, not merely declared", () => {
  const options = gitExecOptions();
  assert.equal(options.timeout, GIT_TIMEOUT_MS);
  assert.equal(options.maxBuffer, GIT_MAX_BYTES);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(options.env?.GIT_TERMINAL_PROMPT, "0");
});

test("the environment is rebuilt per call, never frozen at module load", () => {
  const key = "NEXUS_GIT_ENV_PROBE";
  process.env[key] = "present";
  try {
    assert.equal(gitExecOptions().env?.[key], "present");
  } finally {
    delete process.env[key];
  }
  assert.equal(gitExecOptions().env?.[key], undefined);
});

test("output larger than the buffer bound fails rather than being truncated", () => {
  const path = repository();
  // Pins the BEHAVIOUR interface-context depends on: an oversize read raises
  // ENOBUFS, which it maps to "too_large". Note this does not by itself prove
  // our maxBuffer is applied — Node's default is also 1 MiB — which is why the
  // applied-options test above asserts the object we pass.
  writeFileSync(join(path, "big.md"), "x".repeat(GIT_MAX_BYTES + 1024), "utf8");
  const sha = commitAll(path, "add big");
  assert.throws(
    () => runGit(createGitRunner(), path, ["show", `${sha}:big.md`]),
    (error: unknown) => (error as { code?: string }).code === "ENOBUFS"
  );
});

test("the runner reads text and bytes from a real repository", () => {
  const path = repository();
  writeFileSync(join(path, "docs.md"), "# heading\n", "utf8");
  const sha = commitAll(path, "add docs");
  const runner = createGitRunner();

  assert.equal(runGit(runner, path, ["show", `${sha}:docs.md`]), "# heading\n");
  const bytes = runGitBytes(runner, path, ["show", `${sha}:docs.md`]);
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.toString("utf8"), "# heading\n");
});

test("byte reads preserve content a lossy decode would alter", () => {
  const path = repository();
  const invalidUtf8 = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]);
  writeFileSync(join(path, "raw.md"), invalidUtf8);
  const sha = commitAll(path, "add raw");
  const bytes = runGitBytes(createGitRunner(), path, ["show", `${sha}:raw.md`]);
  assert.deepEqual([...bytes], [...invalidUtf8]);
});

test("a credential in a failing command never reaches the error text", () => {
  const path = repository();
  // git echoes the remote it was given, so an embedded token would otherwise
  // land in a log, a handoff, or a persisted settlement.
  const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
  assert.throws(
    () => runGit(createGitRunner(), path, ["fetch", `https://x-access-token:${token}@127.0.0.1:1/none.git`]),
    (error: unknown) => {
      const fields = error as { message: string; stderr?: unknown; stdout?: unknown };
      const text = [fields.message, String(fields.stderr ?? ""), String(fields.stdout ?? "")].join("\n");
      assert.ok(!text.includes(token), `the token leaked into the failure text: ${text.slice(0, 200)}`);
      return true;
    }
  );
});

test("a failing command keeps the properties callers branch on", () => {
  const path = repository();
  assert.throws(
    () => runGit(createGitRunner(), path, ["rev-parse", "does-not-exist"]),
    (error: unknown) => {
      const fields = error as { status?: unknown; stderr?: unknown };
      assert.notEqual(fields.status, undefined, "callers read status");
      assert.notEqual(fields.stderr, undefined, "merge-executor reads stderr");
      return true;
    }
  );
});

test("an unreachable remote fails fast instead of waiting for a human", () => {
  const path = repository();
  const started = Date.now();
  assert.throws(() => runGit(createGitRunner(), path, ["fetch", "https://127.0.0.1:1/none.git"]));
  // Failing at all is not the point: it must fail well inside the timeout,
  // which is what a non-inherited stdin and GIT_TERMINAL_PROMPT=0 buy.
  assert.ok(Date.now() - started < GIT_TIMEOUT_MS / 2, "the call blocked instead of failing fast");
});

test("a token in git's stderr is redacted, on both the text and byte runners", () => {
  // The fixture injects the failure directly: git sanitises the URL it prints,
  // so a real failure never exercises the stream branches these mutations hide in.
  const token = "AKIAIOSFODNN7EXAMPLE";
  for (const [name, stderr] of [
    ["string stderr", `fatal: could not read ${token}\nsecond line\n`],
    ["buffer stderr", Buffer.from(`fatal: could not read ${token}\nsecond line\n`)],
  ] as const) {
    const failing = Object.assign(new Error("boom"), { status: 128, code: "E", stderr, stdout: stderr });
    const guarded = () => {
      try {
        throw failing;
      } catch (error) {
        return redactGitFailureForTest(error);
      }
    };
    assert.throws(guarded, (error: unknown) => {
      const fields = error as { stderr?: unknown; stdout?: unknown };
      for (const stream of [fields.stderr, fields.stdout]) {
        const text = Buffer.isBuffer(stream) ? stream.toString("utf8") : String(stream);
        assert.ok(!text.includes(token), `${name}: token survived in a stream`);
        assert.ok(text.includes("second line"), `${name}: line structure must survive redaction`);
      }
      assert.ok(Buffer.isBuffer(stderr) ? Buffer.isBuffer(fields.stderr) : typeof fields.stderr === "string");
      return true;
    });
  }
});

test("withGitBytes adapts a text-only runner and passes a byte runner through", () => {
  const calls: string[][] = [];
  const text = (arguments_: readonly string[]) => {
    calls.push([...arguments_]);
    return "value";
  };
  const adapted = withGitBytes(text);
  assert.equal(adapted(["status"]), "value");
  assert.equal(adapted.bytes(["status"]).toString("utf8"), "value");
  assert.equal(calls.length, 2);

  const native = createGitRunner();
  assert.equal(withGitBytes(native), native);
});

test("tree entries parse a sha-256 object id as well as sha-1", () => {
  const entry64 = `100644 blob ${"b".repeat(64)}\tdocs/interface.md`;
  assert.equal(parseGitTreeEntry(entry64)?.sha, "b".repeat(64));
});

test("tree entries parse into mode, type, sha and path", () => {
  const entry = `100644 blob ${"a".repeat(40)}\tdocs/interface.md`;
  assert.deepEqual(parseGitTreeEntry(entry), {
    mode: "100644",
    type: "blob",
    sha: "a".repeat(40),
    path: "docs/interface.md",
  });
});

test("a malformed tree entry parses to null rather than throwing", () => {
  for (const entry of [
    "",
    "100644 blob",
    `100644 blob ${"a".repeat(39)}\tdocs.md`,
    `100644 blob ${"a".repeat(40)}\t`,
    `12345 blob ${"a".repeat(40)}\tdocs.md`,
  ]) {
    assert.equal(parseGitTreeEntry(entry), null, `expected null for ${JSON.stringify(entry)}`);
  }
});

test("a symlink is a blob to git but not a regular file", () => {
  const path = repository();
  writeFileSync(join(path, "real.md"), "# real\n", "utf8");
  symlinkSync("real.md", join(path, "link.md"));
  const sha = commitAll(path, "add link");

  const output = runGit(createGitRunner(), path, ["ls-tree", "-z", sha, "--", "link.md"]);
  const entries = splitGitTreeOutput(output);
  assert.equal(entries.length, 1);
  const parsed = parseGitTreeEntry(entries[0]!);
  assert.ok(parsed !== null);
  assert.equal(parsed.type, "blob");
  assert.equal(parsed.mode, "120000");
  assert.equal(isRegularFileMode(parsed.mode), false, "a symlink must not read as a published file");
});

test("splitting tree output drops the trailing separator", () => {
  assert.deepEqual(splitGitTreeOutput("a\0b\0"), ["a", "b"]);
  assert.deepEqual(splitGitTreeOutput(""), []);
});
