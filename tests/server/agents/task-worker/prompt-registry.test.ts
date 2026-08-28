import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { PromptRegistry } from "#server/agents/task-worker/prompt-registry";

async function promptFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steward-prompt-registry-"));
  return join(root, "prompts.md");
}

test("loads markdown templates deterministically and includes template names in promptsSha", async () => {
  const file = await promptFile();
  await writeFile(file, "## alpha\nAlpha\n## zeta\nZeta {{value}}\n", "utf8");

  const first = PromptRegistry.loadSync(file);
  const second = PromptRegistry.loadSync(file);
  assert.match(first.promptsSha, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(second.promptsSha, first.promptsSha);
  assert.equal(first.render("zeta", { value: "rendered" }), "Zeta rendered\n");

  await writeFile(file, "## alpha\nAlpha\n## renamed\nZeta {{value}}\n", "utf8");
  assert.notEqual(PromptRegistry.loadSync(file).promptsSha, first.promptsSha);
});

test("promptsSha is independent of section order and preserves the shipped digest", async () => {
  const firstFile = await promptFile();
  const secondFile = await promptFile();
  await writeFile(firstFile, "## alpha\nAlpha\n## zeta\nZeta\n", "utf8");
  await writeFile(secondFile, "## zeta\nZeta\n## alpha\nAlpha\n", "utf8");

  assert.equal(PromptRegistry.loadSync(secondFile).promptsSha, PromptRegistry.loadSync(firstFile).promptsSha);
  assert.equal(
    PromptRegistry.loadSync(resolve("config/prompts.md")).promptsSha,
    "sha256:e0e0c2a508653508918a5aa6453ddbe3728849a2d77afbea6f9e82d78cf9e0fb",
  );
});

test("rejects prompt files larger than 1 MiB", async () => {
  const file = await promptFile();
  await writeFile(file, `## oversized\n${"x".repeat(1024 * 1024)}\n`, "utf8");

  assert.throws(() => PromptRegistry.loadSync(file), /prompts\.md.*1 MiB/u);
});

test("rejects invalid section names, symlinks, directories, and files changed while loading", async () => {
  const invalidName = await promptFile();
  await writeFile(invalidName, "## Invalid\nPrompt\n", "utf8");
  assert.throws(() => PromptRegistry.loadSync(invalidName), /Section header is invalid/u);

  const target = await promptFile();
  await writeFile(target, "## valid\nPrompt\n", "utf8");
  const link = `${target}.link`;
  await symlink(target, link);
  assert.throws(() => PromptRegistry.loadSync(link), /Prompt file is unavailable/u);
  assert.throws(() => PromptRegistry.loadSync(dirname(target)), /Prompt file is unavailable/u);

  const changed = await promptFile();
  await writeFile(changed, Buffer.concat([
    Buffer.from("## valid\n", "utf8"),
    Buffer.from([0xff]),
    Buffer.from("\n", "utf8"),
  ]));
  assert.throws(() => PromptRegistry.loadSync(changed), /Prompt file changed while loading/u);
});

test("render fails closed on unknown templates, missing placeholders, and unknown variables", async () => {
  const file = await promptFile();
  await writeFile(
    file,
    "## example\nHello {{subject}} from {{source}}.\n## malformed\nHello {{subject.\n",
    "utf8",
  );
  const registry = PromptRegistry.loadSync(file);

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
