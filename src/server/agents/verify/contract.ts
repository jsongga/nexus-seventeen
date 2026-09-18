/** Parses the fenced verification policy in docs/workflow.md so changed files can select the required checks. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const JSON_FENCE = /^```json[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/gmu;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export type VerifyRuleAction =
  | Readonly<{ kind: "self" }>
  | Readonly<{ kind: "mirror" }>
  | Readonly<{ kind: "fixed"; nodeTestDirs?: readonly string[]; vitest?: readonly string[] }>
  | Readonly<{ kind: "colocated"; vitestFallback: string }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "escalate" }>;

export interface VerifyRule {
  readonly match: string;
  readonly action: VerifyRuleAction;
}

export interface VerifyContract {
  readonly version: 1;
  readonly compile: readonly string[];
  readonly rules: readonly VerifyRule[];
  readonly full: readonly string[];
}

export class VerifyContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "VerifyContractError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VerifyContractError(`${label} must be an object`);
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
  if (unknown.length > 0) throw new VerifyContractError(`${label} has unknown field ${unknown[0]}`);
  if (missing.length > 0) throw new VerifyContractError(`${label} is missing ${missing[0]}`);
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
    throw new VerifyContractError(`${label} is invalid`);
  }
  return value;
}

function stringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new VerifyContractError(`${label} must be a non-empty array`);
  }
  return Object.freeze(value.map((entry, index) => text(entry, `${label}[${index}]`, 256)));
}

function commandList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new VerifyContractError(`${label} must be a non-empty array`);
  }
  return Object.freeze(value.map((entry, index) => text(entry, `${label}[${index}]`, 512)));
}

function action(value: unknown, label: string): VerifyRuleAction {
  const candidate = record(value, label);
  switch (candidate.kind) {
    case "self":
    case "mirror":
    case "none":
    case "escalate": {
      exact(value, ["kind"], [], label);
      return Object.freeze({ kind: candidate.kind });
    }
    case "fixed": {
      const item = exact(value, ["kind"], ["nodeTestDirs", "vitest"], label);
      if (item.nodeTestDirs === undefined && item.vitest === undefined) {
        throw new VerifyContractError(`${label} fixed action requires nodeTestDirs or vitest`);
      }
      const nodeTestDirs =
        item.nodeTestDirs === undefined ? undefined : stringList(item.nodeTestDirs, `${label}.nodeTestDirs`);
      const vitest = item.vitest === undefined ? undefined : stringList(item.vitest, `${label}.vitest`);
      return Object.freeze({ kind: "fixed", nodeTestDirs, vitest });
    }
    case "colocated": {
      const item = exact(value, ["kind", "vitestFallback"], [], label);
      return Object.freeze({
        kind: "colocated",
        vitestFallback: text(item.vitestFallback, `${label}.vitestFallback`, 256),
      });
    }
    default:
      throw new VerifyContractError(`${label}.kind must be self, mirror, fixed, colocated, none, or escalate`);
  }
}

function rule(value: unknown, index: number): VerifyRule {
  const label = `contract.rules[${index}]`;
  const item = exact(value, ["match", "action"], [], label);
  return Object.freeze({
    match: text(item.match, `${label}.match`, 256),
    action: action(item.action, `${label}.action`),
  });
}

function contract(value: unknown): VerifyContract {
  const item = exact(value, ["version", "compile", "rules", "full"], [], "contract");
  if (item.version !== 1) throw new VerifyContractError("contract.version must be 1");
  if (!Array.isArray(item.rules) || item.rules.length < 1 || item.rules.length > 64) {
    throw new VerifyContractError("contract.rules must contain between 1 and 64 entries");
  }
  return Object.freeze({
    version: 1,
    compile: commandList(item.compile, "contract.compile"),
    rules: Object.freeze(item.rules.map(rule)),
    full: commandList(item.full, "contract.full"),
  });
}

export function parseVerifyContract(markdown: string): VerifyContract {
  const blocks = Array.from(markdown.matchAll(JSON_FENCE), (match) => match[1] ?? "");
  if (blocks.length < 1) throw new VerifyContractError("no fenced json block");
  if (blocks.length > 1) throw new VerifyContractError("multiple fenced json blocks");

  let parsed: unknown;
  try {
    parsed = JSON.parse(blocks[0] ?? "") as unknown;
  } catch {
    throw new VerifyContractError("invalid JSON in fenced json block");
  }
  return contract(parsed);
}

export async function loadVerifyContract(repoRoot: string): Promise<VerifyContract> {
  const markdown = await readFile(join(repoRoot, "docs", "workflow.md"), "utf8");
  return parseVerifyContract(markdown);
}
