import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AGENT_ROLES, IDENTIFIER_PATTERN, type AgentRole } from "#shared/task-board-contract";
import type {
  TaskFleetAgentConfig,
  TaskFleetConfig,
  TaskFleetContainerLaneConfig,
  TaskFleetRetryConfig,
} from "./types.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const IDENTIFIER = new RegExp(IDENTIFIER_PATTERN, "u");
const CONTAINER_HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const DEFAULT_LONG_POLL_MS = 30_000;
const DEFAULT_RETRY: TaskFleetRetryConfig = Object.freeze({ initialDelayMs: 1_000, maximumDelayMs: 60_000 });

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
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

function agentRole(value: unknown, label: string): AgentRole {
  if (!(AGENT_ROLES as readonly unknown[]).includes(value)) {
    throw new Error(`${label} must be one of ${AGENT_ROLES.join(", ")}`);
  }
  return value as AgentRole;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function optionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  return value === undefined ? undefined : integer(value, label, minimum, maximum);
}

function absolutePath(value: unknown, label: string): string {
  const parsed = text(value, label, 4_096);
  if (!isAbsolute(parsed)) throw new Error(`${label} must be absolute`);
  return parsed;
}

function boardUrl(value: unknown): string {
  const source = text(value, "config.boardUrl", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error("config.boardUrl is invalid");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("config.boardUrl must be an HTTPS origin or exact loopback HTTP origin");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function retryConfig(value: unknown): TaskFleetRetryConfig {
  if (value === undefined) return DEFAULT_RETRY;
  const item = exact(value, ["initialDelayMs", "maximumDelayMs"], [], "config.retry");
  const initialDelayMs = integer(item.initialDelayMs, "config.retry.initialDelayMs", 10, 60_000);
  const maximumDelayMs = integer(item.maximumDelayMs, "config.retry.maximumDelayMs", initialDelayMs, 300_000);
  return Object.freeze({ initialDelayMs, maximumDelayMs });
}

function containerConfig(value: unknown, label: string): TaskFleetContainerLaneConfig {
  const item = exact(value, ["workspaceRoot"], ["image", "agentCommand", "extraAllowedHosts"], label);
  let extraAllowedHosts: readonly string[] = Object.freeze([]);
  if (item.extraAllowedHosts !== undefined) {
    if (!Array.isArray(item.extraAllowedHosts) || item.extraAllowedHosts.length > 32) {
      throw new Error(`${label}.extraAllowedHosts must be an array of at most 32 hosts`);
    }
    extraAllowedHosts = Object.freeze(
      item.extraAllowedHosts.map((value, index) => {
        const host = text(value, `${label}.extraAllowedHosts[${index}]`, 253);
        if (!CONTAINER_HOST.test(host)) throw new Error(`${label}.extraAllowedHosts[${index}] is invalid`);
        return host;
      })
    );
  }
  return Object.freeze({
    workspaceRoot: absolutePath(item.workspaceRoot, `${label}.workspaceRoot`),
    image: item.image === undefined ? undefined : text(item.image, `${label}.image`, 512),
    agentCommand: item.agentCommand === undefined ? undefined : text(item.agentCommand, `${label}.agentCommand`, 512),
    extraAllowedHosts,
  });
}

function agentConfig(value: unknown, index: number): TaskFleetAgentConfig {
  const label = `config.agents[${index}]`;
  const item = exact(
    value,
    ["workerId", "agentId", "token", "provider", "model", "workingDirectory", "statePath"],
    ["role", "longPollMs", "agentTimeoutMs", "terminationGraceMs", "runtime", "container", "workspaceRoot"],
    label
  );
  const runtime = item.runtime === undefined ? "local-process" : item.runtime;
  if (runtime !== "local-process" && runtime !== "container")
    throw new Error(`${label}.runtime must be local-process or container`);
  if (runtime === "container" && item.container === undefined)
    throw new Error(`${label}.container is required for container lanes`);
  if (runtime !== "container" && item.container !== undefined)
    throw new Error(`${label}.container is only valid for container lanes`);
  if (runtime === "container" && item.workspaceRoot !== undefined) {
    throw new Error(`${label}.workspaceRoot is only valid for local-process lanes`);
  }
  const provider = identifier(item.provider, `${label}.provider`);
  const token = text(item.token, `${label}.token`, 512);
  if (token.length < 32) throw new Error(`${label}.token must contain at least 32 characters`);
  return Object.freeze({
    workerId: identifier(item.workerId, `${label}.workerId`),
    agentId: identifier(item.agentId, `${label}.agentId`),
    token,
    provider,
    ...(item.role === undefined ? {} : { role: agentRole(item.role, `${label}.role`) }),
    model: text(item.model, `${label}.model`, 128),
    workingDirectory: absolutePath(item.workingDirectory, `${label}.workingDirectory`),
    ...(item.workspaceRoot === undefined
      ? {}
      : { workspaceRoot: absolutePath(item.workspaceRoot, `${label}.workspaceRoot`) }),
    statePath: absolutePath(item.statePath, `${label}.statePath`),
    longPollMs:
      item.longPollMs === undefined
        ? DEFAULT_LONG_POLL_MS
        : integer(item.longPollMs, `${label}.longPollMs`, 1_000, 30_000),
    agentTimeoutMs: optionalInteger(item.agentTimeoutMs, `${label}.agentTimeoutMs`, 1_000, 24 * 60 * 60_000),
    terminationGraceMs: optionalInteger(item.terminationGraceMs, `${label}.terminationGraceMs`, 10, 60_000),
    runtime,
    container: runtime === "container" ? containerConfig(item.container, `${label}.container`) : undefined,
  });
}

function unique(values: readonly TaskFleetAgentConfig[], field: "workerId" | "agentId" | "statePath"): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value[field])) throw new Error(`config.agents contains duplicate ${field} ${value[field]}`);
    seen.add(value[field]);
  }
}

export function parseTaskFleetConfig(value: unknown): TaskFleetConfig {
  const config = record(value, "config");
  if ("promptsRoot" in config) throw new Error("config.promptsRoot is no longer supported; use config.promptsFile");
  const item = exact(
    config,
    ["version", "boardUrl", "agents"],
    ["retry", "runtimesConfigPath", "promptsFile"],
    "config"
  );
  if (item.version !== 1) throw new Error("config.version must be 1");
  if (!Array.isArray(item.agents) || item.agents.length < 1 || item.agents.length > 128) {
    throw new Error("config.agents must contain between 1 and 128 agents");
  }
  const agents = Object.freeze(item.agents.map(agentConfig));
  unique(agents, "workerId");
  unique(agents, "agentId");
  unique(agents, "statePath");
  return Object.freeze({
    version: 1,
    boardUrl: boardUrl(item.boardUrl),
    runtimesConfigPath:
      item.runtimesConfigPath === undefined
        ? undefined
        : text(item.runtimesConfigPath, "config.runtimesConfigPath", 4_096),
    promptsFile: item.promptsFile === undefined ? undefined : text(item.promptsFile, "config.promptsFile", 4_096),
    retry: retryConfig(item.retry),
    agents,
  });
}

export async function loadTaskFleetConfig(path: string): Promise<TaskFleetConfig> {
  if (path.length < 1 || path.includes("\0")) throw new Error("Task fleet config path is invalid");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_CONFIG_BYTES) {
      throw new Error("Task fleet config must be a non-empty regular file no larger than 1 MiB");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Task fleet config is not valid JSON", { cause: error });
      throw error;
    }
    return parseTaskFleetConfig(parsed);
  } finally {
    await handle.close();
  }
}
