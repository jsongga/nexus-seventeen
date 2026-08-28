import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { TaskBoardError } from "#server/task-board/errors";
import { SkillRegistry } from "#server/task-board/skills";

test("loads bounded repository skills with stable digests", () => {
  const registry = new SkillRegistry(resolve("config/skills.md"));
  const [skill] = registry.loadSync(["cicada-task-curation"]);
  assert.equal(skill?.name, "cicada-task-curation");
  assert.match(skill?.digest ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.match(skill?.content ?? "", /Preserve the original request/u);
});

test("rejects missing, duplicate, and malformed skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-skills-"));
  const file = join(root, "skills.md");
  await writeFile(file, "## good-skill\n---\nname: good-skill\ndescription: valid\n---\nBody\n");
  const registry = new SkillRegistry(file);
  assert.throws(() => registry.loadSync(["missing-skill"]), /unavailable/u);

  await writeFile(file, "## bad-skill\n---\nname: another-name\ndescription: wrong\n---\n");
  assert.throws(() => registry.loadSync(["bad-skill"]), /invalid frontmatter/u);
  assert.throws(() => registry.loadSync(["bad-skill", "bad-skill"]), /unique and bounded/u);

  const missingFile = join(root, "missing-skills.md");
  assert.throws(() => new SkillRegistry(missingFile).loadSync(["missing-skill"]), /missing-skills\.md/u);
});

test("loads section names using the full skill ID grammar", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-skills-"));
  const file = join(root, "skills.md");
  const skillId = "foo.bar_baz:qux";
  await writeFile(file, `## ${skillId}\n---\nname: ${skillId}\ndescription: valid\n---\nBody\n`);

  const [skill] = new SkillRegistry(file).loadSync([skillId]);
  assert.equal(skill?.skillId, skillId);
  assert.equal(skill?.name, skillId);
});

test("rejects a column-0 section heading inside any skill body", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-skills-"));
  const file = join(root, "skills.md");
  await writeFile(
    file,
    "## valid-skill\n---\nname: valid-skill\ndescription: valid\n---\nBody before heading\n## examples\nBody after heading\n",
  );

  assert.throws(
    () => new SkillRegistry(file).loadSync(["valid-skill"]),
    (error: unknown) => {
      assert.ok(error instanceof TaskBoardError);
      assert.equal(error.code, "SKILL_INVALID");
      assert.match(error.message, /## examples is missing YAML frontmatter/u);
      return true;
    },
  );
});
