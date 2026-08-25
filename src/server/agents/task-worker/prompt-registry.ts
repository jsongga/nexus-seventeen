import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const MAX_PROMPT_BYTES = 64 * 1024;
const PROMPT_FILE = /^(?<name>[a-z0-9][a-z0-9-]*)\.md$/u;
const PLACEHOLDER = /\{\{(?<name>[a-z][a-zA-Z0-9]*)\}\}/gu;

interface LoadedPrompt {
  readonly content: string;
  readonly digest: `sha256:${string}`;
}

function digest(content: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export class PromptRegistry {
  readonly #templates: ReadonlyMap<string, LoadedPrompt>;
  readonly #promptsSha: string;

  private constructor(templates: ReadonlyMap<string, LoadedPrompt>, promptsSha: string) {
    this.#templates = templates;
    this.#promptsSha = promptsSha;
  }

  static loadSync(root: string): PromptRegistry {
    const resolvedRoot = resolve(root);
    const templates = new Map<string, LoadedPrompt>();
    const entries = readdirSync(resolvedRoot, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith(".md"))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const match = PROMPT_FILE.exec(entry.name);
      if (match?.groups?.name === undefined) throw new Error(`Prompt file name is invalid: ${entry.name}`);
      const path = join(resolvedRoot, entry.name);
      const stat = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Prompt file is unavailable: ${entry.name}`);
      }
      if (stat.size > MAX_PROMPT_BYTES) throw new Error(`${entry.name} exceeds the 64 KiB prompt limit`);
      const content = readFileSync(path, "utf8");
      if (Buffer.byteLength(content) !== stat.size) throw new Error(`Prompt file changed while loading: ${entry.name}`);
      templates.set(match.groups.name, Object.freeze({ content, digest: digest(content) }));
    }
    const manifest = [...templates].map(([name, prompt]) => [name, prompt.digest] as const);
    const promptsSha = digest(JSON.stringify(manifest));
    return new PromptRegistry(templates, promptsSha);
  }

  get promptsSha(): string {
    return this.#promptsSha;
  }

  render(name: string, vars: Readonly<Record<string, string>>): string {
    const prompt = this.#templates.get(name);
    if (prompt === undefined) throw new Error(`Unknown prompt template: ${name}`);
    const placeholders = new Set<string>();
    for (const match of prompt.content.matchAll(PLACEHOLDER)) {
      const placeholder = match.groups?.name;
      if (placeholder === undefined) throw new Error("Unfilled prompt placeholder: invalid");
      placeholders.add(placeholder);
    }
    const unmatched = prompt.content.replace(PLACEHOLDER, "");
    if (unmatched.includes("{{") || unmatched.includes("}}")) {
      throw new Error("Unfilled prompt placeholder: invalid");
    }
    for (const variable of Object.keys(vars)) {
      if (!placeholders.has(variable)) throw new Error(`Unknown prompt variable: ${variable}`);
    }
    for (const placeholder of placeholders) {
      if (!Object.hasOwn(vars, placeholder)) throw new Error(`Unfilled prompt placeholder: ${placeholder}`);
    }
    return prompt.content.replace(PLACEHOLDER, (_token, _name, _offset, _source, groups: { name?: string }) => {
      const placeholder = groups.name;
      if (placeholder === undefined) throw new Error("Prompt placeholder is invalid");
      return vars[placeholder]!;
    });
  }
}
