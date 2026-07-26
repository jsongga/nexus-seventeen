import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import {
  ROLE_CAPABILITIES,
  type AgentCapability,
  type AgentProvider,
  type AgentRole,
} from "#shared/protocol";

export const SUPERVISOR_ROLES = ["engineer", "verifier", "manager"] as const;
export type SupervisorRole = AgentRole;

export interface SupervisorConfig {
  controlPlaneUrl: string;
  supervisorToken: string;
  workspaceId: string;
  agentId: string;
  laneId: string;
  runtimeInstanceId: string;
  displayName: string;
  role: SupervisorRole;
  capabilities: readonly AgentCapability[];
  provider: AgentProvider;
  softwareVersion: string;
  workingDirectory: string;
  stateDirectory: string;
  leaseIntervalMs: number;
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  configFilePath?: string | null;
  runtimeInstanceIdFactory?: () => string;
}

const CONFIG_KEYS = [
  "controlPlaneUrl",
  "supervisorToken",
  "workspaceId",
  "agentId",
  "laneId",
  "runtimeInstanceId",
  "displayName",
  "role",
  "provider",
  "softwareVersion",
  "workingDirectory",
  "stateDirectory",
  "leaseIntervalMs",
] as const;

type ConfigKey = (typeof CONFIG_KEYS)[number];
type RawConfig = Partial<Record<ConfigKey, unknown>>;

const ENV_KEYS: Partial<Record<ConfigKey, string>> = {
  controlPlaneUrl: "STEWARD_CONTROL_PLANE_URL",
  supervisorToken: "STEWARD_SUPERVISOR_TOKEN",
  workspaceId: "STEWARD_WORKSPACE_ID",
  agentId: "STEWARD_AGENT_ID",
  laneId: "STEWARD_LANE_ID",
  runtimeInstanceId: "STEWARD_RUNTIME_INSTANCE_ID",
  displayName: "STEWARD_DISPLAY_NAME",
  role: "STEWARD_ROLE",
  softwareVersion: "STEWARD_SOFTWARE_VERSION",
  workingDirectory: "STEWARD_WORKING_DIRECTORY",
  stateDirectory: "STEWARD_STATE_DIRECTORY",
  leaseIntervalMs: "STEWARD_LEASE_INTERVAL_MS",
};

const IDENTIFIER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const VERSION_RE = /^[0-9A-Za-z](?:[0-9A-Za-z.+_-]{0,126}[0-9A-Za-z])?$/;
const MIN_LEASE_INTERVAL_MS = 1_000;
const MAX_LEASE_INTERVAL_MS = 5 * 60_000;

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>): void {
  const allowed = new Set<string>(CONFIG_KEYS);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown supervisor configuration field(s): ${unknown.sort().join(", ")}`);
  }
}

function requiredString(raw: RawConfig, key: ConfigKey): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required and must be a non-empty string`);
  }
  return value.trim();
}

function identifier(raw: RawConfig, key: "workspaceId" | "agentId" | "laneId" | "runtimeInstanceId"): string {
  const value = requiredString(raw, key);
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`${key} is not a valid Steward identifier`);
  }
  return value;
}

function parseControlPlaneUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("controlPlaneUrl must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("controlPlaneUrl must use HTTP or HTTPS");
  }
  const loopbackHost = url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopbackHost) {
    throw new Error("controlPlaneUrl may use plaintext HTTP only for exact loopback hosts");
  }
  if (url.username || url.password) {
    throw new Error("controlPlaneUrl must not embed credentials");
  }
  if (url.search) throw new Error("controlPlaneUrl must not contain query parameters");
  if (url.hash) {
    throw new Error("controlPlaneUrl must not contain a fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function pathParts(pathname: string): string[] {
  const root = parse(pathname).root;
  return pathname.slice(root.length).split(sep).filter(Boolean);
}

export function assertSafeWorkingDirectory(value: string): string {
  if (!isAbsolute(value)) {
    throw new Error("workingDirectory must be absolute");
  }
  const pathname = resolve(value);
  const root = parse(pathname).root;
  if (pathname === root) {
    throw new Error("workingDirectory must not be a filesystem root");
  }

  const userHome = resolve(homedir());
  const fromHome = relative(userHome, pathname);
  if (pathname === userHome || (fromHome && !fromHome.startsWith(`..${sep}`) && fromHome !== ".." && pathParts(fromHome).length < 2)) {
    throw new Error("workingDirectory is too broad; select a specific project directory");
  }
  if (pathParts(pathname).length < 3) {
    throw new Error("workingDirectory is too broad; select a specific project directory");
  }
  return pathname;
}

export function assertSafeStateDirectory(value: string): string {
  if (!isAbsolute(value)) {
    throw new Error("stateDirectory must be absolute");
  }
  const pathname = resolve(value);
  const root = parse(pathname).root;
  if (pathname === root) {
    throw new Error("stateDirectory must not be a filesystem root");
  }
  const userHome = resolve(homedir());
  const fromHome = relative(userHome, pathname);
  if (
    pathname === userHome ||
    (fromHome && !fromHome.startsWith(`..${sep}`) && fromHome !== ".." && pathParts(fromHome).length < 2) ||
    pathParts(pathname).length < 3
  ) {
    throw new Error("stateDirectory is too broad; select a supervisor-specific directory");
  }
  return pathname;
}

function pathContains(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === "" || (
    fromParent !== ".." &&
    !fromParent.startsWith(`..${sep}`) &&
    !isAbsolute(fromParent)
  );
}

export function assertDisjointSupervisorDirectories(
  workingDirectory: string,
  stateDirectory: string,
): void {
  const working = resolve(workingDirectory);
  const state = resolve(stateDirectory);
  if (pathContains(working, state) || pathContains(state, working)) {
    throw new Error("stateDirectory and workingDirectory must be disjoint; neither may contain the other");
  }
}

function parseLeaseInterval(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < MIN_LEASE_INTERVAL_MS || parsed > MAX_LEASE_INTERVAL_MS) {
    throw new Error(`leaseIntervalMs must be an integer between ${MIN_LEASE_INTERVAL_MS} and ${MAX_LEASE_INTERVAL_MS}`);
  }
  return parsed;
}

function parseRole(value: string): SupervisorRole {
  if (!SUPERVISOR_ROLES.includes(value as SupervisorRole)) {
    throw new Error(`role must be one of: ${SUPERVISOR_ROLES.join(", ")}`);
  }
  return value as SupervisorRole;
}

function parseProvider(value: unknown): AgentProvider {
  const provider = asObject(value, "provider");
  const unknown = Object.keys(provider).filter((key) => key !== "name" && key !== "model");
  if (unknown.length > 0) throw new Error(`Unknown provider field(s): ${unknown.sort().join(", ")}`);
  if (provider.name !== "codex" && provider.name !== "claude") {
    throw new Error("provider.name must be codex or claude");
  }
  if (typeof provider.model !== "string" || provider.model.trim().length === 0 || provider.model.length > 200) {
    throw new Error("provider.model must be a non-empty model identifier");
  }
  if (/\p{Cc}/u.test(provider.model)) throw new Error("provider.model contains control characters");
  return Object.freeze({ name: provider.name, model: provider.model.trim() });
}

export function parseSupervisorConfig(rawValue: unknown): SupervisorConfig {
  const record = asObject(rawValue, "Supervisor configuration");
  rejectUnknownKeys(record);
  const raw = record as RawConfig;
  const role = parseRole(requiredString(raw, "role"));
  const provider = parseProvider(raw.provider);
  const softwareVersion = requiredString(raw, "softwareVersion");
  if (!VERSION_RE.test(softwareVersion)) throw new Error("softwareVersion is invalid");
  const supervisorToken = requiredString(raw, "supervisorToken");
  if (supervisorToken.length < 16) throw new Error("supervisorToken is too short");
  const workingDirectory = assertSafeWorkingDirectory(requiredString(raw, "workingDirectory"));
  const stateDirectory = assertSafeStateDirectory(requiredString(raw, "stateDirectory"));
  assertDisjointSupervisorDirectories(workingDirectory, stateDirectory);

  return Object.freeze({
    controlPlaneUrl: parseControlPlaneUrl(requiredString(raw, "controlPlaneUrl")),
    supervisorToken,
    workspaceId: identifier(raw, "workspaceId"),
    agentId: identifier(raw, "agentId"),
    laneId: identifier(raw, "laneId"),
    runtimeInstanceId: identifier(raw, "runtimeInstanceId"),
    displayName: requiredString(raw, "displayName"),
    role,
    capabilities: ROLE_CAPABILITIES[role],
    provider,
    softwareVersion,
    workingDirectory,
    stateDirectory,
    leaseIntervalMs: parseLeaseInterval(raw.leaseIntervalMs),
  });
}

async function readConfigFile(pathname: string): Promise<RawConfig> {
  const text = await readFile(pathname, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Unable to parse supervisor config file ${pathname}`, { cause: error });
  }
  const record = asObject(parsed, "Supervisor config file");
  rejectUnknownKeys(record);
  return record as RawConfig;
}

export async function loadSupervisorConfig(options: LoadConfigOptions = {}): Promise<SupervisorConfig> {
  const env = options.env ?? process.env;
  const configuredPath = options.configFilePath === undefined
    ? env.STEWARD_CONFIG_FILE?.trim() || null
    : options.configFilePath;
  const merged: RawConfig = configuredPath ? await readConfigFile(resolve(configuredPath)) : {};

  if (merged.runtimeInstanceId !== undefined || env.STEWARD_RUNTIME_INSTANCE_ID !== undefined) {
    throw new Error(
      "runtimeInstanceId is a per-process boot identity and must not be supplied by file or environment",
    );
  }

  for (const key of CONFIG_KEYS) {
    const envKey = ENV_KEYS[key];
    if (!envKey) continue;
    const envValue = env[envKey];
    if (envValue !== undefined && envValue.trim().length > 0) {
      merged[key] = envValue;
    }
  }
  const providerName = env.STEWARD_PROVIDER_NAME?.trim() || env.STEWARD_PROVIDER?.trim();
  const providerModel = env.STEWARD_PROVIDER_MODEL?.trim();
  if (providerName || providerModel) {
    const existing = typeof merged.provider === "object" && merged.provider !== null && !Array.isArray(merged.provider)
      ? merged.provider as Record<string, unknown>
      : {};
    merged.provider = {
      ...existing,
      ...(providerName ? { name: providerName } : {}),
      ...(providerModel ? { model: providerModel } : {}),
    };
  }
  merged.runtimeInstanceId = (options.runtimeInstanceIdFactory ?? (() => `runtime-${randomUUID()}`))();
  return parseSupervisorConfig(merged);
}
