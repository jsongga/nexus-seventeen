import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { IDENTIFIER_PATTERN } from "#shared/task-board-contract";
import { TaskBoardError } from "./errors.js";
import type { HostContext } from "./host.js";

const IDENTIFIER = new RegExp(IDENTIFIER_PATTERN, "u");
const MAX_TIMER_SECONDS = Math.floor(2_147_483_647 / 1_000);

export interface TaskBoardHostOptions {
  readonly homeDir?: string;
  readonly projectRoots?: readonly string[];
}

type TaskBoardListenHost = "127.0.0.1" | "::1";

export interface TaskBoardOptions {
  readonly dbPath: string;
  readonly humanToken: string;
  readonly humanPrincipal: string;
  readonly corsOrigins?: readonly string[];
  readonly host?: TaskBoardHostOptions;
  readonly listenHost?: TaskBoardListenHost;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly heartbeatTimeoutSeconds?: number;
  readonly reconcileIntervalSeconds?: number;
  readonly parkNotifySeconds?: number;
  readonly parkAutoAbandonSeconds?: number;
  readonly stageCapSeconds?: number;
  readonly taskCapSeconds?: number;
  readonly now?: () => Date;
  readonly artifactRoot?: string;
  readonly verifyWorkspaceRoot?: string;
}

export interface TaskBoardConfig {
  readonly dbPath: string;
  readonly humanToken: string;
  readonly humanPrincipal: string;
  readonly corsOrigins: ReadonlySet<string>;
  readonly host: HostContext;
  readonly listenHost: TaskBoardListenHost;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly heartbeatTimeoutSeconds: number;
  readonly reconcileIntervalSeconds: number;
  readonly parkNotifySeconds: number;
  readonly parkAutoAbandonSeconds: number;
  readonly stageCapSeconds: number;
  readonly taskCapSeconds: number;
  readonly now: () => Date;
  readonly artifactRoot: string;
  readonly verifyWorkspaceRoot: string;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", `${field} is outside its safe range`);
  }
  return resolved;
}

function configText(value: string, field: string, maximum: number): string {
  if (
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", `${field} is invalid`);
  }
  return value;
}

function exactOrigins(values: readonly string[] | undefined): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of values ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new TaskBoardError(500, "INVALID_CONFIGURATION", `Invalid CORS origin: ${value}`);
    }
    if (
      parsed.origin !== value ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      origins.has(value)
    ) {
      throw new TaskBoardError(500, "INVALID_CONFIGURATION", `Unsafe CORS origin: ${value}`);
    }
    origins.add(value);
  }
  return origins;
}

export function normalizeTaskBoardConfig(options: TaskBoardOptions): TaskBoardConfig {
  const dbPath = configText(options.dbPath, "dbPath", 4_096);
  if (!isAbsolute(dbPath) || dbPath === "/") {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", "dbPath must be an absolute file path");
  }
  const humanToken = configText(options.humanToken, "humanToken", 512);
  if (humanToken.length < 32) {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", "humanToken must contain at least 32 characters");
  }
  const humanPrincipal = configText(options.humanPrincipal, "humanPrincipal", 128);
  if (!IDENTIFIER.test(humanPrincipal)) {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", "humanPrincipal is invalid");
  }
  const hostOptions = options.host;
  const projectRoots = hostOptions?.projectRoots?.map((value) =>
    configText(value, "host.projectRoots entry", 4_096));
  if (projectRoots?.some((value) => !value.startsWith("/"))) {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", "host.projectRoots entries must be absolute paths");
  }
  const listenHost = options.listenHost ?? "127.0.0.1";
  if (listenHost !== "127.0.0.1" && listenHost !== "::1") {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", "Task board HTTP must bind to literal loopback");
  }
  const host = Object.freeze({
    homeDir: hostOptions?.homeDir ?? homedir(),
    rootsOverride: projectRoots === undefined ? null : Object.freeze([...projectRoots]),
  });
  const artifactRoot = configText(options.artifactRoot ?? join(dirname(dbPath), "artifacts"), "artifactRoot", 4_096);
  if (!isAbsolute(artifactRoot) || artifactRoot === "/") {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", "artifactRoot must be an absolute directory path");
  }
  const verifyWorkspaceRoot = configText(
    options.verifyWorkspaceRoot ?? join(dirname(dbPath), "verify-workspaces"),
    "verifyWorkspaceRoot",
    4_096,
  );
  if (!isAbsolute(verifyWorkspaceRoot) || verifyWorkspaceRoot === "/") {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", "verifyWorkspaceRoot must be an absolute directory path");
  }
  const heartbeatTimeoutSeconds = boundedInteger(
    options.heartbeatTimeoutSeconds,
    300,
    0,
    MAX_TIMER_SECONDS,
    "heartbeatTimeoutSeconds",
  );
  // The non-zero floor is 2x the worker's fixed 30-second heartbeat cadence.
  if (heartbeatTimeoutSeconds !== 0 && heartbeatTimeoutSeconds < 60) {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", "heartbeatTimeoutSeconds is outside its safe range");
  }
  const parkNotifySeconds = boundedInteger(
    options.parkNotifySeconds,
    86_400,
    0,
    MAX_TIMER_SECONDS,
    "parkNotifySeconds",
  );
  if (parkNotifySeconds !== 0 && parkNotifySeconds < 60) {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", "parkNotifySeconds is outside its safe range");
  }
  const parkAutoAbandonSeconds = boundedInteger(
    options.parkAutoAbandonSeconds,
    604_800,
    0,
    MAX_TIMER_SECONDS,
    "parkAutoAbandonSeconds",
  );
  if (parkAutoAbandonSeconds !== 0 && parkAutoAbandonSeconds < 60) {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", "parkAutoAbandonSeconds is outside its safe range");
  }
  if (
    parkNotifySeconds !== 0
    && parkAutoAbandonSeconds !== 0
    && parkAutoAbandonSeconds < parkNotifySeconds
  ) {
    throw new TaskBoardError(
      500,
      "INVALID_CONFIGURATION",
      "parkAutoAbandonSeconds must be at least parkNotifySeconds when both are enabled",
    );
  }
  const stageCapSeconds = boundedInteger(
    options.stageCapSeconds,
    3_600,
    0,
    MAX_TIMER_SECONDS,
    "stageCapSeconds",
  );
  if (stageCapSeconds !== 0 && stageCapSeconds < 60) {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", "stageCapSeconds is outside its safe range");
  }
  const taskCapSeconds = boundedInteger(
    options.taskCapSeconds,
    10_800,
    0,
    MAX_TIMER_SECONDS,
    "taskCapSeconds",
  );
  if (taskCapSeconds !== 0 && taskCapSeconds < 60) {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", "taskCapSeconds is outside its safe range");
  }
  if (
    stageCapSeconds !== 0
    && taskCapSeconds !== 0
    && taskCapSeconds < stageCapSeconds
  ) {
    throw new TaskBoardError(
      500,
      "INVALID_CONFIGURATION",
      "taskCapSeconds must be at least stageCapSeconds when both are enabled",
    );
  }
  return Object.freeze({
    dbPath,
    humanToken,
    humanPrincipal,
    corsOrigins: exactOrigins(options.corsOrigins),
    host,
    listenHost,
    port: boundedInteger(options.port, 4_318, 0, 65_535, "port"),
    maxBodyBytes: boundedInteger(options.maxBodyBytes, 64 * 1_024, 1_024, 256 * 1_024, "maxBodyBytes"),
    heartbeatTimeoutSeconds,
    reconcileIntervalSeconds: boundedInteger(
      options.reconcileIntervalSeconds,
      60,
      0,
      MAX_TIMER_SECONDS,
      "reconcileIntervalSeconds",
    ),
    parkNotifySeconds,
    parkAutoAbandonSeconds,
    stageCapSeconds,
    taskCapSeconds,
    now: options.now ?? (() => new Date()),
    artifactRoot,
    verifyWorkspaceRoot,
  });
}
