import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadRuntimeProfiles,
  parseRuntimeProfiles,
} from "../../../../src/server/agents/runtime/profiles.js";

function validProfiles(): Record<string, unknown> {
  return {
    version: 1,
    runtimes: {
      codex: {
        binary: "codex",
        permissionModel: "cli-sandbox-flags",
        roles: {
          engineer: { sandbox: "workspace-write" },
          verifier: { sandbox: "read-only" },
          manager: { sandbox: "read-only" },
        },
        mcp: false,
        toolCallGranularity: "command",
        contextNotes: "JSONL item stream; schema via --output-schema file",
      },
    },
  };
}

test("parses the shipped runtime capability profiles", async () => {
  const path = join(process.cwd(), "config", "runtimes.json");
  const source = JSON.parse(await readFile(path, "utf8")) as unknown;
  const parsed = parseRuntimeProfiles(source);

  assert.equal(parsed.version, 1);
  assert.deepEqual([...parsed.runtimes.keys()], ["codex", "claude"]);
  assert.deepEqual(parsed.runtimes.get("codex"), {
    runtime: "codex",
    binary: "codex",
    permissionModel: "cli-sandbox-flags",
    roles: {
      engineer: { sandbox: "workspace-write" },
      verifier: { sandbox: "read-only" },
      manager: { sandbox: "read-only" },
    },
    mcp: false,
    toolCallGranularity: "command",
    contextNotes: "JSONL item stream; schema via --output-schema file",
  });
  assert.deepEqual(parsed.runtimes.get("claude"), {
    runtime: "claude",
    binary: "claude",
    permissionModel: "permission-modes",
    roles: {
      engineer: { sandbox: "acceptEdits" },
      verifier: { sandbox: "dontAsk" },
      manager: { sandbox: "plan" },
    },
    mcp: true,
    toolCallGranularity: "tool",
    contextNotes: "stream-json; schema inline via --json-schema",
  });
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.runtimes.get("codex")));
  assert.ok(Object.isFrozen(parsed.runtimes.get("codex")?.roles));
  assert.ok(Object.isFrozen(parsed.runtimes.get("codex")?.roles.engineer));
});

test("rejects malformed or ambiguous runtime profile shapes", () => {
  const cases: Array<readonly [string, (value: Record<string, unknown>) => void, RegExp]> = [
    ["unknown version", (value) => { value.version = 2; }, /version must be 1/u],
    ["missing binary", (value) => {
      delete ((value.runtimes as Record<string, Record<string, unknown>>).codex!).binary;
    }, /codex is missing binary/u],
    ["non-record roles", (value) => {
      (value.runtimes as Record<string, Record<string, unknown>>).codex!.roles = [];
    }, /codex\.roles must be an object/u],
    ["unknown role", (value) => {
      const codex = (value.runtimes as Record<string, Record<string, unknown>>).codex!;
      (codex.roles as Record<string, unknown>).designer = { sandbox: "read-only" };
    }, /roles has unknown field designer/u],
    ["empty sandbox", (value) => {
      const codex = (value.runtimes as Record<string, Record<string, unknown>>).codex!;
      ((codex.roles as Record<string, Record<string, unknown>>).engineer!).sandbox = "";
    }, /engineer\.sandbox is invalid/u],
  ];

  for (const [label, mutate, expected] of cases) {
    const value = validProfiles();
    mutate(value);
    assert.throws(() => parseRuntimeProfiles(value), expected, label);
  }
});

test("loads only bounded regular JSON profile files without following symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-runtime-profiles-"));
  const validPath = join(root, "runtimes.json");
  const oversizedPath = join(root, "oversized.json");
  const invalidPath = join(root, "invalid.json");
  const symlinkPath = join(root, "linked.json");
  await writeFile(validPath, JSON.stringify(validProfiles()), { mode: 0o600 });
  await writeFile(oversizedPath, " ".repeat(1024 * 1024 + 1), { mode: 0o600 });
  await writeFile(invalidPath, '{ "runtimeToken": "secret-value"', { mode: 0o600 });
  await symlink(validPath, symlinkPath);

  assert.equal((await loadRuntimeProfiles(validPath)).runtimes.get("codex")?.binary, "codex");
  await assert.rejects(loadRuntimeProfiles(oversizedPath), /no larger than 1 MiB/u);
  await assert.rejects(loadRuntimeProfiles(invalidPath), (error: unknown) => {
    assert.match(String(error), /not valid JSON/u);
    assert.doesNotMatch(String(error), /secret-value/u);
    return true;
  });
  await assert.rejects(loadRuntimeProfiles(symlinkPath));
});
