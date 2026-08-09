import { dirname, isAbsolute, join } from "node:path";
import { IDENTIFIER_PATTERN } from "#shared/task-board-contract";
import { TaskBoardError } from "./errors.js";

const IDENTIFIER = new RegExp(IDENTIFIER_PATTERN, "u");

export interface TaskBoardOptions {
  readonly dbPath: string;
  readonly humanToken: string;
  readonly humanPrincipal: string;
  readonly corsOrigins?: readonly string[];
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly now?: () => Date;
  readonly artifactRoot?: string;
}

export interface TaskBoardConfig {
  readonly dbPath: string;
  readonly humanToken: string;
  readonly humanPrincipal: string;
  readonly corsOrigins: ReadonlySet<string>;
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly now: () => Date;
  readonly artifactRoot: string;
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
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", "Task board HTTP must bind to literal loopback");
  }
  const artifactRoot = configText(options.artifactRoot ?? join(dirname(dbPath), "artifacts"), "artifactRoot", 4_096);
  if (!isAbsolute(artifactRoot) || artifactRoot === "/") {
    throw new TaskBoardError(500, "INVALID_CONFIGURATION", "artifactRoot must be an absolute directory path");
  }
  return Object.freeze({
    dbPath,
    humanToken,
    humanPrincipal,
    corsOrigins: exactOrigins(options.corsOrigins),
    host,
    port: boundedInteger(options.port, 4_318, 0, 65_535, "port"),
    maxBodyBytes: boundedInteger(options.maxBodyBytes, 64 * 1_024, 1_024, 256 * 1_024, "maxBodyBytes"),
    now: options.now ?? (() => new Date()),
    artifactRoot,
  });
}
