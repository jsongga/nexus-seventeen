import assert from "node:assert/strict";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PromptRegistry } from "#server/agents/task-worker/prompt-registry";

async function promptRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "steward-prompt-registry-"));
}

test("loads markdown templates deterministically and includes template names in promptsSha", async () => {
  const root = await promptRoot();
  await writeFile(join(root, "zeta.md"), "Zeta {{value}}", "utf8");
  await writeFile(join(root, "alpha.md"), "Alpha", "utf8");
  await writeFile(join(root, "ignored.txt"), "Not a prompt", "utf8");

  const first = PromptRegistry.loadSync(root);
  const second = PromptRegistry.loadSync(root);
  assert.match(first.promptsSha, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(second.promptsSha, first.promptsSha);
  assert.equal(first.render("zeta", { value: "rendered" }), "Zeta rendered");

  await rename(join(root, "zeta.md"), join(root, "renamed.md"));
  assert.notEqual(PromptRegistry.loadSync(root).promptsSha, first.promptsSha);
});

test("rejects prompt files larger than 64 KiB", async () => {
  const root = await promptRoot();
  await writeFile(join(root, "oversized.md"), "x".repeat(64 * 1024 + 1), "utf8");

  assert.throws(() => PromptRegistry.loadSync(root), /oversized\.md.*64 KiB/u);
});

test("render fails closed on unknown templates, missing placeholders, and unknown variables", async () => {
  const root = await promptRoot();
  await writeFile(join(root, "example.md"), "Hello {{subject}} from {{source}}.", "utf8");
  await writeFile(join(root, "malformed.md"), "Hello {{subject.", "utf8");
  const registry = PromptRegistry.loadSync(root);

  assert.throws(() => registry.render("missing", {}), /Unknown prompt template: missing/u);
  assert.throws(
    () => registry.render("example", { subject: "world" }),
    /Unfilled prompt placeholder: source/u,
  );
  assert.throws(
    () => registry.render("example", { subject: "world", source: "tests", extra: "unexpected" }),
    /Unknown prompt variable: extra/u,
  );
  assert.throws(() => registry.render("malformed", {}), /Unfilled prompt placeholder: invalid/u);
});
