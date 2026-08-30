import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { AGENT_ROLES, IDENTIFIER_PATTERN, type AgentRole } from "#shared/task-board-contract";

const MAX_PROFILES_BYTES = 1024 * 1024;
const IDENTIFIER = new RegExp(IDENTIFIER_PATTERN, "u");

interface RuntimeRoleProfile {
  readonly sandbox: string;
}

export interface RuntimeProfile {
  readonly runtime: string;
  readonly binary: string;
  readonly permissionModel: string;
  readonly roles: Readonly<Partial<Record<AgentRole, RuntimeRoleProfile>>>;
  readonly mcp: boolean;
  readonly toolCallGranularity: string;
  readonly contextNotes: string;
}

export interface RuntimeProfiles {
  readonly version: 1;
  readonly runtimes: ReadonlyMap<string, RuntimeProfile>;
}

export class RuntimeCapabilityError extends Error {
  readonly runtime: string;
  readonly role: string;

  constructor(runtime: string, role: string, detail = "is not supported") {
    super(`Runtime ${runtime} cannot launch role ${role}: ${detail}`);
    this.name = "RuntimeCapabilityError";
    this.runtime = runtime;
    this.role = role;
  }
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
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const parsed = text(value, label, 128);
  if (!IDENTIFIER.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function roleProfiles(value: unknown, label: string): RuntimeProfile["roles"] {
  const item = exact(value, [], AGENT_ROLES, label);
  const result: Partial<Record<AgentRole, RuntimeRoleProfile>> = {};
  for (const role of AGENT_ROLES) {
    if (item[role] === undefined) continue;
    const roleProfile = exact(item[role], ["sandbox"], [], `${label}.${role}`);
    result[role] = Object.freeze({
      sandbox: text(roleProfile.sandbox, `${label}.${role}.sandbox`, 128),
    });
  }
  return Object.freeze(result);
}

function runtimeProfile(runtime: string, value: unknown): RuntimeProfile {
  const label = `profiles.runtimes.${runtime}`;
  const item = exact(
    value,
    ["binary", "permissionModel", "roles", "mcp", "toolCallGranularity", "contextNotes"],
    [],
    label
  );
  if (typeof item.mcp !== "boolean") throw new Error(`${label}.mcp must be a boolean`);
  return Object.freeze({
    runtime,
    binary: text(item.binary, `${label}.binary`, 512),
    permissionModel: text(item.permissionModel, `${label}.permissionModel`, 128),
    roles: roleProfiles(item.roles, `${label}.roles`),
    mcp: item.mcp,
    toolCallGranularity: text(item.toolCallGranularity, `${label}.toolCallGranularity`, 128),
    contextNotes: text(item.contextNotes, `${label}.contextNotes`, 4_096),
  });
}

export function parseRuntimeProfiles(value: unknown): RuntimeProfiles {
  const item = exact(value, ["version", "runtimes"], [], "profiles");
  if (item.version !== 1) throw new Error("profiles.version must be 1");
  const runtimes = record(item.runtimes, "profiles.runtimes");
  const entries = Object.entries(runtimes);
  if (entries.length < 1 || entries.length > 128) {
    throw new Error("profiles.runtimes must contain between 1 and 128 runtimes");
  }
  const parsed = new Map<string, RuntimeProfile>();
  for (const [key, profile] of entries) {
    const runtime = identifier(key, `profiles.runtimes key ${key}`);
    parsed.set(runtime, runtimeProfile(runtime, profile));
  }
  return Object.freeze({ version: 1, runtimes: parsed });
}

export async function loadRuntimeProfiles(path: string): Promise<RuntimeProfiles> {
  if (path.length < 1 || path.includes("\0")) throw new Error("Runtime profiles path is invalid");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_PROFILES_BYTES) {
      throw new Error("Runtime profiles must be a non-empty regular file no larger than 1 MiB");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Runtime profiles are not valid JSON", { cause: error });
      throw error;
    }
    return parseRuntimeProfiles(parsed);
  } finally {
    await handle.close();
  }
}
