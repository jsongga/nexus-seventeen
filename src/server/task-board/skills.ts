import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SkillSnapshot } from "#shared/task-board-contract";
import { parseSections } from "../shared/sections.js";
import { TaskBoardError } from "./errors.js";

const SKILL_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_SKILL_REGISTRY_BYTES = 1024 * 1024;
const MAX_SKILLS = 32;
const REGISTRY_UNAVAILABLE = "Skill registry file is unavailable";

function frontmatter(source: string, expectedId: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(source);
  if (!match)
    throw new TaskBoardError(500, "SKILL_INVALID", `Skill section ## ${expectedId} is missing YAML frontmatter`);
  const fields = new Map(
    match[1]!.split(/\r?\n/u).map((line) => {
      const separator = line.indexOf(":");
      return separator < 1 ? ["", ""] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    })
  );
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  if (name !== expectedId || description.length < 1 || description.length > 512) {
    throw new TaskBoardError(500, "SKILL_INVALID", `Skill section ## ${expectedId} has invalid frontmatter`);
  }
  return { name, description };
}

export class SkillRegistry {
  readonly #file: string;
  #cachedSource: string | null = null;
  #cachedSections: ReadonlyMap<string, string> | null = null;

  constructor(file: string) {
    this.#file = resolve(file);
  }

  #loadSections(): ReadonlyMap<string, string> {
    let stat;
    try {
      stat = lstatSync(this.#file);
    } catch {
      throw new TaskBoardError(500, "SKILL_NOT_AVAILABLE", REGISTRY_UNAVAILABLE);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_REGISTRY_BYTES) {
      throw new TaskBoardError(500, "SKILL_NOT_AVAILABLE", REGISTRY_UNAVAILABLE);
    }
    const source = readFileSync(this.#file, "utf8");
    if (Buffer.byteLength(source) !== stat.size)
      throw new TaskBoardError(500, "SKILL_INVALID", "Skill registry file changed while loading");
    if (source === this.#cachedSource && this.#cachedSections !== null) return this.#cachedSections;
    try {
      const sections = parseSections(source, { nameRule: SKILL_ID });
      for (const [sectionId, content] of sections) frontmatter(content, sectionId);
      this.#cachedSource = source;
      this.#cachedSections = sections;
      return sections;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TaskBoardError(500, "SKILL_INVALID", `Skill registry is invalid: ${detail}`);
    }
  }

  loadSync(skillIds: readonly string[]): readonly SkillSnapshot[] {
    if (skillIds.length > MAX_SKILLS || new Set(skillIds).size !== skillIds.length)
      throw new TaskBoardError(400, "SKILL_SET_INVALID", "Skill IDs must be unique and bounded");
    if (skillIds.length === 0) return Object.freeze([]);
    for (const skillId of skillIds)
      if (!SKILL_ID.test(skillId)) throw new TaskBoardError(400, "SKILL_ID_INVALID", "Skill ID is invalid");
    const sections = this.#loadSections();
    return Object.freeze(
      skillIds.map((skillId) => {
        const content = sections.get(skillId);
        if (content === undefined || Buffer.byteLength(content) > MAX_SKILL_BYTES)
          throw new TaskBoardError(500, "SKILL_NOT_AVAILABLE", `Skill ${skillId} is unavailable`);
        const metadata = frontmatter(content, skillId);
        return Object.freeze({
          skillId,
          ...metadata,
          digest: `sha256:${createHash("sha256").update(content).digest("hex")}` as const,
          content,
        });
      })
    );
  }
}
