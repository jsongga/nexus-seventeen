import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SkillRegistry } from "#server/task-board/skills";

test("loads bounded repository skills with stable digests", () => {
  const registry = new SkillRegistry(resolve("skills"));
  const [skill] = registry.loadSync(["cicada-task-curation"]);
  assert.equal(skill?.name, "cicada-task-curation");
  assert.match(skill?.digest ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.match(skill?.content ?? "", /Preserve the original request/u);
});

test("rejects missing, duplicate, and malformed skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-skills-"));
  await mkdir(join(root, "bad-skill"));
  await writeFile(join(root, "bad-skill", "SKILL.md"), "---\nname: another-name\ndescription: wrong\n---\n");
  const registry = new SkillRegistry(root);
  assert.throws(() => registry.loadSync(["missing-skill"]), /unavailable/u);
  assert.throws(() => registry.loadSync(["bad-skill"]), /invalid frontmatter/u);
  assert.throws(() => registry.loadSync(["bad-skill", "bad-skill"]), /unique and bounded/u);
});
