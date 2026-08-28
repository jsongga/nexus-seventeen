import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { PromptRegistry } from "#server/agents/task-worker/prompt-registry";
import { parseSections } from "../../../../src/server/shared/sections.js";

async function promptFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steward-prompt-registry-"));
  return join(root, "prompts.md");
}

async function shippedPromptSource(): Promise<string> {
  return readFile(resolve("config/prompts.md"), "utf8");
}

function sectionSource(sections: ReadonlyArray<readonly [string, string]>): string {
  return sections.map(([name, content]) => `## ${name}\n${content}`).join("");
}

test("loads the exact template set deterministically and includes content in promptsSha", async () => {
  const file = await promptFile();
  const source = await shippedPromptSource();
  await writeFile(file, source, "utf8");

  const first = PromptRegistry.loadSync(file);
  const second = PromptRegistry.loadSync(file);
  assert.match(first.promptsSha, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(second.promptsSha, first.promptsSha);
  assert.equal(
    first.render("header", { role: "engineer", area: "platform", mission: "Build safely." }),
    "You are the fixed Cicada engineer agent for platform.\nBuild safely.\n",
  );

  await writeFile(file, source.replace("You are the fixed Cicada", "You are the assigned Cicada"), "utf8");
  assert.notEqual(PromptRegistry.loadSync(file).promptsSha, first.promptsSha);
});

test("promptsSha is independent of section order and preserves the shipped digest", async () => {
  const firstFile = await promptFile();
  const secondFile = await promptFile();
  const source = await shippedPromptSource();
  const sections = [...parseSections(source, {})];
  await writeFile(firstFile, source, "utf8");
  await writeFile(secondFile, sectionSource(sections.reverse()), "utf8");

  assert.equal(PromptRegistry.loadSync(secondFile).promptsSha, PromptRegistry.loadSync(firstFile).promptsSha);
  assert.equal(
    PromptRegistry.loadSync(resolve("config/prompts.md")).promptsSha,
    "sha256:e0e0c2a508653508918a5aa6453ddbe3728849a2d77afbea6f9e82d78cf9e0fb",
  );
});

test("rejects missing templates and stray column-0 headings at load", async () => {
  const source = await shippedPromptSource();
  const sections = [...parseSections(source, {})];
  const missingFile = await promptFile();
  await writeFile(missingFile, sectionSource(sections.filter(([name]) => name !== "header")), "utf8");
  assert.throws(() => PromptRegistry.loadSync(missingFile), /missing template section: ## header/u);

  const extraFile = await promptFile();
  await writeFile(
    extraFile,
    source.replace("## designer\n", "## examples\nBody text after a stray heading.\n## designer\n"),
    "utf8",
  );
  assert.throws(() => PromptRegistry.loadSync(extraFile), /unknown template section: ## examples/u);
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
  const source = await shippedPromptSource();
  await writeFile(file, source, "utf8");
  const registry = PromptRegistry.loadSync(file);

  assert.throws(() => registry.render("missing", {}), /Unknown prompt template: missing/u);
  assert.throws(
    () => registry.render("header", { role: "engineer", area: "platform" }),
    /Unfilled prompt placeholder: mission/u,
  );
  assert.throws(
    () => registry.render("header", { role: "engineer", area: "platform", mission: "Build.", extra: "unexpected" }),
    /Unknown prompt variable: extra/u,
  );

  await writeFile(file, source.replace("{{role}}", "{{role"), "utf8");
  const malformedRegistry = PromptRegistry.loadSync(file);
  assert.throws(() => malformedRegistry.render("header", {}), /Unfilled prompt placeholder: invalid/u);
});
