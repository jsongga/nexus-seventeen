import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SkillRegistry } from "#server/task-board/skills";

test("loads bounded repository skills with stable digests", async () => {
  const registry = new SkillRegistry(resolve("skills"));
  const [skill] = await registry.load(["cicada-task-curation"]);
  assert.equal(skill?.name, "cicada-task-curation");
  assert.match(skill?.digest ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.match(skill?.content ?? "", /Preserve the original request/u);
});

test("rejects missing, duplicate, and malformed skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-skills-"));
  await mkdir(join(root, "bad-skill"));
  await writeFile(join(root, "bad-skill", "SKILL.md"), "---\nname: another-name\ndescription: wrong\n---\n");
  const registry = new SkillRegistry(root);
  await assert.rejects(registry.load(["missing-skill"]), /unavailable/u);
  await assert.rejects(registry.load(["bad-skill"]), /invalid frontmatter/u);
  await assert.rejects(registry.load(["bad-skill", "bad-skill"]), /unique and bounded/u);
});
