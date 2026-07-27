import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SkillSnapshot } from "#shared/task-board-contract";
import { TaskBoardError } from "./errors.js";

const SKILL_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_SKILLS = 32;

function frontmatter(source: string, expectedId: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(source);
  if (!match) throw new TaskBoardError(500, "SKILL_INVALID", `${expectedId} is missing YAML frontmatter`);
  const fields = new Map(match[1]!.split(/\r?\n/u).map((line) => {
    const separator = line.indexOf(":");
    return separator < 1 ? ["", ""] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  if (name !== expectedId || description.length < 1 || description.length > 512) {
    throw new TaskBoardError(500, "SKILL_INVALID", `${expectedId} has invalid frontmatter`);
  }
  return { name, description };
}

export class SkillRegistry {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async load(skillIds: readonly string[]): Promise<readonly SkillSnapshot[]> {
    if (skillIds.length > MAX_SKILLS || new Set(skillIds).size !== skillIds.length) {
      throw new TaskBoardError(400, "SKILL_SET_INVALID", "Skill IDs must be unique and bounded");
    }
    return Promise.all(skillIds.map((skillId) => this.#loadOne(skillId)));
  }

  loadSync(skillIds: readonly string[]): readonly SkillSnapshot[] {
    if (skillIds.length > MAX_SKILLS || new Set(skillIds).size !== skillIds.length) throw new TaskBoardError(400, "SKILL_SET_INVALID", "Skill IDs must be unique and bounded");
    return Object.freeze(skillIds.map((skillId) => {
      if (!SKILL_ID.test(skillId)) throw new TaskBoardError(400, "SKILL_ID_INVALID", "Skill ID is invalid");
      const path = join(this.#root, skillId, "SKILL.md");
      let stat;
      try { stat = lstatSync(path); } catch { throw new TaskBoardError(500, "SKILL_NOT_AVAILABLE", `Skill ${skillId} is unavailable`); }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES) throw new TaskBoardError(500, "SKILL_NOT_AVAILABLE", `Skill ${skillId} is unavailable`);
      const content = readFileSync(path, "utf8");
      const metadata = frontmatter(content, skillId);
      return Object.freeze({ skillId, ...metadata, digest: `sha256:${createHash("sha256").update(content).digest("hex")}` as const, content });
    }));
  }

  async #loadOne(skillId: string): Promise<SkillSnapshot> {
    if (!SKILL_ID.test(skillId)) throw new TaskBoardError(400, "SKILL_ID_INVALID", "Skill ID is invalid");
    const path = join(this.#root, skillId, "SKILL.md");
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES) {
      throw new TaskBoardError(500, "SKILL_NOT_AVAILABLE", `Skill ${skillId} is unavailable`);
    }
    const content = await readFile(path, "utf8");
    if (Buffer.byteLength(content) !== stat.size) throw new TaskBoardError(500, "SKILL_INVALID", `${skillId} changed while loading`);
    const metadata = frontmatter(content, skillId);
    return Object.freeze({
      skillId,
      ...metadata,
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      content,
    });
  }
}
