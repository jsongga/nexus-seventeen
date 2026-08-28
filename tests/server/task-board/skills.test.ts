import assert from "node:assert/strict";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { TaskBoardError } from "#server/task-board/errors";
import { SkillRegistry } from "#server/task-board/skills";

const SHIPPED_SKILL_DIGESTS = {
  "cicada-after-effects-production": "sha256:23aa9895cd7abef72b0af219fab089f9c8df505dd8029231163dd257a5b37ff5",
  "cicada-blender-production": "sha256:5394db06d42c904deee7d8bbcc50a2285ea3b952e4ab574cddba0ea32d055ed6",
  "cicada-evidence-research": "sha256:76466a554605c03d6462d202c001c43632b1efcb2f2fcaace54362c6d2e1950d",
  "cicada-failure-reflection": "sha256:dc1c3de000f98e5723f64a8fa6acb20c899f00715b31178e28a45ef5e8bc09a2",
  "cicada-image-direction": "sha256:7cd7bf593cda37d8a3e50762c60952ba6c908be0e8965b24dcb1f83bbbc060a9",
  "cicada-outcome-evaluation": "sha256:421d27767a49a72c701c8a02d03f7577186520b43af7928fcac54c29dcd87346",
  "cicada-software-implementation": "sha256:08c447f2d62ae83d0277450d175317b3aaba1a833ed7760c044311a95a0b0466",
  "cicada-solution-planning": "sha256:b787d7838ee3c64e9bed82880b581879f40ee867b742862575a20d06b4794ac0",
  "cicada-task-curation": "sha256:ded0828dd25c682d23c2fa0ac9987d03dd88094847677cc02136b1283dde7edd",
  "cicada-web-interface-design": "sha256:028bbe2604b5a834dd2456230eca18a17fbd735e7d7313a19801f65b7abae1af",
  "writing-design-docs": "sha256:fcfa35fabf9015ea34914ae7ee77adcf5aa54a8879eb279d82fc547294dcc20c",
} as const;

test("loads bounded repository skills with stable digests", () => {
  const registry = new SkillRegistry(resolve("config/skills.md"));
  const skills = registry.loadSync(Object.keys(SHIPPED_SKILL_DIGESTS));
  assert.deepEqual(
    Object.fromEntries(skills.map(({ skillId, digest }) => [skillId, digest])),
    SHIPPED_SKILL_DIGESTS,
  );
  assert.match(skills.find(({ skillId }) => skillId === "cicada-task-curation")?.content ?? "", /Preserve the original request/u);
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
  assert.throws(
    () => new SkillRegistry(missingFile).loadSync(["missing-skill"]),
    (error: unknown) => {
      assert.ok(error instanceof TaskBoardError);
      assert.equal(error.code, "SKILL_NOT_AVAILABLE");
      assert.equal(error.message, "Skill registry file is unavailable");
      assert.ok(!error.message.includes(root));
      return true;
    },
  );

  const link = join(root, "skills-link.md");
  await symlink(file, link);
  assert.throws(() => new SkillRegistry(link).loadSync(["bad-skill"]), /Skill registry file is unavailable/u);
});

test("rejects oversized registries before reading and keeps the per-section cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-skills-"));
  const oversizedFile = join(root, "oversized-skills.md");
  await writeFile(oversizedFile, `## oversized-skill\n${"x".repeat(1024 * 1024)}\n`, "utf8");
  await chmod(oversizedFile, 0);
  try {
    assert.throws(
      () => new SkillRegistry(oversizedFile).loadSync(["oversized-skill"]),
      (error: unknown) => {
        assert.ok(error instanceof TaskBoardError);
        assert.equal(error.code, "SKILL_NOT_AVAILABLE");
        assert.equal(error.message, "Skill registry file is unavailable");
        return true;
      },
    );
  } finally {
    await chmod(oversizedFile, 0o600);
  }

  const oversizedSectionFile = join(root, "oversized-section.md");
  await writeFile(
    oversizedSectionFile,
    `## oversized-skill\n---\nname: oversized-skill\ndescription: valid\n---\n${"x".repeat(64 * 1024)}\n`,
    "utf8",
  );
  assert.throws(
    () => new SkillRegistry(oversizedSectionFile).loadSync(["oversized-skill"]),
    (error: unknown) => {
      assert.ok(error instanceof TaskBoardError);
      assert.equal(error.code, "SKILL_NOT_AVAILABLE");
      assert.match(error.message, /Skill oversized-skill is unavailable/u);
      return true;
    },
  );
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
