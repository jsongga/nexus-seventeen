/** Loads the repository, exclusion, and Outline destination policy for one documentation publication run. */

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { validateExcludePattern } from "./exclude.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export interface DocsPublishRepo {
  readonly name: string;
  readonly path: string;
  readonly ref: string;
  readonly exclude?: readonly string[];
}
export interface DocsPublishConfig {
  readonly version: 1;
  readonly outline: { readonly baseUrl: string; readonly allowInsecureBaseUrl?: boolean };
  readonly repos: readonly DocsPublishRepo[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  const item = record(value, label);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(item).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in item));
  if (unknown.length > 0) throw new Error(`${label} has unknown field ${unknown[0]}`);
  if (missing.length > 0) throw new Error(`${label} is missing ${missing[0]}`);
  return item;
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function repoName(value: unknown, label: string): string {
  if (typeof value === "string" && /[`\r\n\u2028\u2029]/u.test(value)) {
    throw new Error(`${label} must not contain backticks or newlines`);
  }
  return text(value, label, 128);
}

function excludes(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error(`${label} must be an array of at most 128 glob-lite <prefix>/** patterns`);
  }
  return Object.freeze(value.map((pattern, index) => validateExcludePattern(pattern, `${label}[${index}]`)));
}

function outlineConfig(value: unknown): DocsPublishConfig["outline"] {
  const item = exact(value, ["baseUrl"], ["allowInsecureBaseUrl"], "config.outline");
  if (item.allowInsecureBaseUrl !== undefined && typeof item.allowInsecureBaseUrl !== "boolean") {
    throw new Error("config.outline.allowInsecureBaseUrl must be a boolean");
  }
  const source = text(item.baseUrl, "config.outline.baseUrl", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error("config.outline.baseUrl is invalid");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("config.outline.baseUrl must be an HTTP(S) origin without credentials, path, query, or fragment");
  }
  if (parsed.protocol !== "https:" && item.allowInsecureBaseUrl !== true) {
    throw new Error("config.outline.baseUrl must use HTTPS unless allowInsecureBaseUrl is true");
  }
  return Object.freeze({
    baseUrl: parsed.toString().replace(/\/$/u, ""),
    ...(item.allowInsecureBaseUrl === undefined ? {} : { allowInsecureBaseUrl: item.allowInsecureBaseUrl }),
  });
}

function repoConfig(value: unknown, index: number): DocsPublishRepo {
  const label = `config.repos[${index}]`;
  const item = exact(value, ["name", "path", "ref"], ["exclude"], label);
  return Object.freeze({
    name: repoName(item.name, `${label}.name`),
    path: text(item.path, `${label}.path`, 4_096),
    ref: text(item.ref, `${label}.ref`, 512),
    ...(item.exclude === undefined ? {} : { exclude: excludes(item.exclude, `${label}.exclude`) }),
  });
}

export function parseDocsPublishConfig(value: unknown): DocsPublishConfig {
  const item = exact(value, ["version", "outline", "repos"], [], "config");
  if (item.version !== 1) throw new Error("config.version must be 1");
  if (!Array.isArray(item.repos) || item.repos.length < 1 || item.repos.length > 128) {
    throw new Error("config.repos must contain between 1 and 128 repositories");
  }
  const repos = Object.freeze(item.repos.map(repoConfig));
  const names = new Set<string>();
  for (const repo of repos) {
    if (names.has(repo.name)) throw new Error(`config.repos contains duplicate name ${repo.name}`);
    names.add(repo.name);
  }
  return Object.freeze({
    version: 1,
    outline: outlineConfig(item.outline),
    repos,
  });
}

export async function loadDocsPublishConfig(path: string): Promise<DocsPublishConfig> {
  if (path.length < 1 || path.includes("\0")) throw new Error("Docs publisher config path is invalid");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_CONFIG_BYTES) {
      throw new Error("Docs publisher config must be a non-empty regular file no larger than 1 MiB");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("Docs publisher config is not valid JSON", { cause: error });
      }
      throw error;
    }
    return parseDocsPublishConfig(parsed);
  } finally {
    await handle.close();
  }
}
