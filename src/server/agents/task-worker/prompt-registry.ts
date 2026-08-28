import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSections } from "../../shared/sections.js";

const MAX_PROMPT_BYTES = 1024 * 1024;
const PROMPT_NAME = /^[a-z0-9][a-z0-9-]*$/u;
const PLACEHOLDER = /\{\{(?<name>[a-z][a-zA-Z0-9]*)\}\}/gu;
const KNOWN_TEMPLATES: ReadonlySet<string> = new Set([
  "bright-line",
  "designer",
  "engineer-fix",
  "engineer",
  "hazardous-implementation",
  "hazardous-review",
  "header",
  "intake-return",
  "intake",
  "onboarding-engineer",
  "onboarding-intake",
  "oversight",
  "pipeline-implementation",
  "reviewer-evidence",
  "reviewer-legacy",
  "reviewer-prior-findings-truncated",
  "reviewer-prior-findings",
  "reviewer-scope-legacy",
  "reviewer-scope",
  "reviewer",
  "trailer",
  "verifier",
  "workflow-plan-return",
]);

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

  static loadSync(file: string): PromptRegistry {
    const resolvedFile = resolve(file);
    const stat = lstatSync(resolvedFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Prompt file is unavailable: ${resolvedFile}`);
    if (stat.size > MAX_PROMPT_BYTES) throw new Error(`${resolvedFile} exceeds the 1 MiB prompt limit`);
    const source = readFileSync(resolvedFile, "utf8");
    if (Buffer.byteLength(source) !== stat.size) throw new Error(`Prompt file changed while loading: ${resolvedFile}`);

    const sections = parseSections(source, { nameRule: PROMPT_NAME });
    for (const name of sections.keys()) {
      if (!KNOWN_TEMPLATES.has(name)) throw new Error(`Prompt file contains unknown template section: ## ${name}`);
    }
    for (const name of KNOWN_TEMPLATES) {
      if (!sections.has(name)) throw new Error(`Prompt file is missing template section: ## ${name}`);
    }

    const templates = new Map<string, LoadedPrompt>();
    for (const [name, content] of sections) {
      templates.set(name, Object.freeze({ content, digest: digest(content) }));
    }
    const manifest = [...templates]
      .map(([name, prompt]) => [name, prompt.digest] as const)
      .sort(([left], [right]) => {
        const leftFileName = `${left}.md`;
        const rightFileName = `${right}.md`;
        return leftFileName < rightFileName ? -1 : leftFileName > rightFileName ? 1 : 0;
      });
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
