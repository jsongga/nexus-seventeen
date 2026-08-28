import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { PromptRegistry } from "#server/agents/task-worker/prompt-registry";
import { parseSections } from "../../../../src/server/shared/sections.js";

const SHIPPED_PROMPT_DIGESTS = {
  "bright-line": "sha256:12db39383b20d373c581d082aa37ca98bd1a67aea744269e3154c6ab465eea02",
  "designer": "sha256:4d59d58946cf59460320b09d98df27d560643415308e57e25233208b2f3e0ee6",
  "engineer-fix": "sha256:c62ccbadafda09f21511d9ea22000fe73b234d9accdd3dab864bb9b43f3264ac",
  "engineer": "sha256:93afa3ac6876899830f2eb06499157cba2c3008a717a580ffa5b49720c7cf08b",
  "hazardous-implementation": "sha256:731c2c92051213cbffb1b76f12e4701312714128d8ec304968c42d908a5983af",
  "hazardous-review": "sha256:81eb184b03e693fb0411142dd93e3215bb2c5b302b994e9462094029efc64c99",
  "header": "sha256:300f504780744eb8eb9d30d4d3a738335b00a25e32bf2ab5880d8d7a1c950c9d",
  "intake-return": "sha256:0c2e0f346da40f900e8614d35ee410508c241dcf6dd5a1db097ebd3aea0afc7a",
  "intake": "sha256:c735f9a0561be5709917c8c1fb1c41e4478d66dfea7a287dd7fc4d65dd408fbd",
  "onboarding-engineer": "sha256:37327052c3ad5eae5e668325c76a88b381ae130b44984e47bd0f15bc3b826bb1",
  "onboarding-intake": "sha256:7f470fffbe0b0e43868b6bbb9a92b13d73fc8c5363f0ab471589ca2cf84a2714",
  "oversight": "sha256:e59821fadd061f634019447413fa2a32043bc9f677faa2b96af67f3f96115826",
  "pipeline-implementation": "sha256:63bc2e3f821f62e3fde0062a87f8b5a58e7c7b2ebf2bc926830eb122962263f3",
  "reviewer-evidence": "sha256:f56a956682e38ddf74bd4df501fff7663eb164cfc82e82c46b5cfc748f8b321b",
  "reviewer-legacy": "sha256:d2a491fc22468ae5e468dc38d5d104d7c01dbbce128cb56cb4c8685d8d261e7d",
  "reviewer-prior-findings-truncated": "sha256:879d0dd2050d419cd71da57d6a5b3c62568f9ee91b58196b343b4be7078bfe03",
  "reviewer-prior-findings": "sha256:b08a78d90636b91c87899ebd865778e3b5805ff54015fa2b2bd177355004d84e",
  "reviewer-scope-legacy": "sha256:c804d3f0e533249815bb7bd6ed04f013f197fc063785fa7bbd3a6f9fd4f4374d",
  "reviewer-scope": "sha256:10e0b46e143071e2e424f0dc0d848cb04147057606e65cee2b87745c540ed583",
  "reviewer": "sha256:86bb43a6bc5e4d21385d8dcd2ad73a32f15704163f206636324a292b8b586de5",
  "trailer": "sha256:4f8da4803ffa62ba9f97c25f3a6f69de48643b60ed58e591cf9ae358c279ec44",
  "verifier": "sha256:b8a3b41e65000bc0af1cc738c8fc10499a1d3e3f9d758cee9eaca62a749bab80",
  "workflow-plan-return": "sha256:6a5a985f8e41bbf74be92f42754fe53fcf81060ce7fc3f70f26e47ddfac7827b",
} as const;

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
  assert.deepEqual(
    Object.fromEntries([...parseSections(source, {})].map(([name, content]) => [
      name,
      `sha256:${createHash("sha256").update(content).digest("hex")}`,
    ])),
    SHIPPED_PROMPT_DIGESTS,
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

test("rejects an individual prompt section larger than 64 KiB", async () => {
  const file = await promptFile();
  await writeFile(file, `## header\n${"x".repeat(64 * 1024)}\n`, "utf8");

  assert.throws(() => PromptRegistry.loadSync(file), /## header.*64 KiB/u);
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
