const SECTION_NAME = /^[a-z0-9][a-z0-9-]*$/u;

export interface ParseSectionsOptions {
  readonly nameRule?: RegExp;
}

interface SectionHeader {
  readonly name: string;
  readonly lineStart: number;
  readonly bodyStart: number;
}

function matches(rule: RegExp, value: string): boolean {
  rule.lastIndex = 0;
  const matched = rule.test(value);
  rule.lastIndex = 0;
  return matched;
}

export function parseSections(source: string, { nameRule }: ParseSectionsOptions): ReadonlyMap<string, string> {
  const headers: SectionHeader[] = [];
  const names = new Set<string>();
  let offset = 0;

  while (offset <= source.length) {
    const newline = source.indexOf("\n", offset);
    const lineEnd = newline === -1 ? source.length : newline;
    const line = source.slice(offset, lineEnd);
    if (line.startsWith("## ")) {
      const name = line.slice(3);
      if (!SECTION_NAME.test(name) || (nameRule !== undefined && !matches(nameRule, name))) {
        throw new Error(`Section header is invalid: ${line}`);
      }
      if (names.has(name)) throw new Error(`Section name is duplicated: ${name}`);
      names.add(name);
      headers.push({ name, lineStart: offset, bodyStart: newline === -1 ? source.length : newline + 1 });
    }
    if (newline === -1) break;
    offset = newline + 1;
  }

  if (headers.length === 0) {
    if (source.trim().length > 0) throw new Error("Section source has text before the first header");
    throw new Error("Section source contains no sections");
  }
  const preamble = source.slice(0, headers[0]!.lineStart);
  if (preamble.trim().length > 0) throw new Error("Section source has text before the first header");

  const sections = new Map<string, string>();
  for (const [index, header] of headers.entries()) {
    const bodyEnd = index + 1 < headers.length ? headers[index + 1]!.lineStart : source.length;
    const body = source.slice(header.bodyStart, bodyEnd);
    if (body.trim().length === 0) throw new Error(`Section body is empty: ${header.name}`);
    if (!body.endsWith("\n") || body.endsWith("\n\n")) {
      throw new Error(`Section body must end with exactly one newline: ${header.name}`);
    }
    sections.set(header.name, body);
  }
  return sections;
}
