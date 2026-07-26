import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseSupervisorRegistrationRequest,
  type SupervisorRegistrationRequest,
} from "#shared/protocol";
import type { SupervisorConfig } from "./config.js";
import { atomicWriteFile } from "./fs-utils.js";

const REGISTRATION_INTENT_FILENAME = "registration-intent.json";
const MAX_REGISTRATION_INTENT_BYTES = 32 * 1024;

type RegistrationIntentFile = Readonly<{
  version: 1 | 2;
  request: SupervisorRegistrationRequest;
  proofChallenge: string | null;
}>;

const PROOF_CHALLENGE_PATTERN = /^rgc_[A-Za-z0-9_-]{43}$/u;

function proofChallenge(): string {
  return `rgc_${randomBytes(32).toString("base64url")}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseIntent(value: unknown): RegistrationIntentFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Registration intent must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const legacy =
    record.version === 1 &&
    keys.length === 2 &&
    keys[0] === "request" &&
    keys[1] === "version";
  const current =
    record.version === 2 &&
    keys.length === 3 &&
    keys[0] === "proofChallenge" &&
    keys[1] === "request" &&
    keys[2] === "version" &&
    typeof record.proofChallenge === "string" &&
    PROOF_CHALLENGE_PATTERN.test(record.proofChallenge);
  if (!legacy && !current) {
    throw new Error("Registration intent has invalid fields or version");
  }
  return Object.freeze({
    version: legacy ? 1 : 2,
    request: parseSupervisorRegistrationRequest(record.request),
    proofChallenge: legacy ? null : record.proofChallenge as string,
  });
}

function matchesConfig(request: SupervisorRegistrationRequest, config: SupervisorConfig): boolean {
  return (
    request.workspaceId === config.workspaceId &&
    request.agentId === config.agentId &&
    request.laneId === config.laneId &&
    request.displayName === config.displayName &&
    request.role === config.role &&
    canonical(request.capabilities) === canonical(config.capabilities) &&
    canonical(request.provider) === canonical(config.provider) &&
    request.softwareVersion === config.softwareVersion
  );
}

function expectedOrIssuedEpoch(request: SupervisorRegistrationRequest, observedEpoch: number): boolean {
  const expected = request.expectedRuntimeEpoch ?? 0;
  return observedEpoch === expected || observedEpoch === expected + 1;
}

async function fsyncDirectory(pathname: string): Promise<void> {
  const handle = await open(pathname, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class RegistrationIntentStore {
  readonly #path: string;
  #proofChallenge: string | null = null;

  constructor(stateDirectory: string) {
    this.#path = join(stateDirectory, REGISTRATION_INTENT_FILENAME);
  }

  get proofChallenge(): string | null {
    return this.#proofChallenge;
  }

  async load(
    config: SupervisorConfig,
    observedRuntimeEpoch: number,
    checkpointRef: string | null,
  ): Promise<SupervisorRegistrationRequest | null> {
    let handle;
    try {
      handle = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size < 1 ||
        stat.size > MAX_REGISTRATION_INTENT_BYTES ||
        (stat.mode & 0o077) !== 0
      ) {
        throw new Error("Registration intent must be a private bounded regular file");
      }
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        throw new Error("Registration intent must be owned by the supervisor process user");
      }
      const intent = parseIntent(JSON.parse(await handle.readFile("utf8")) as unknown);
      if (!matchesConfig(intent.request, config)) {
        throw new Error("Pending registration intent does not match this supervisor configuration");
      }
      if (intent.request.checkpointRef !== checkpointRef) {
        throw new Error("Pending registration intent does not match the durable checkpoint reference");
      }
      if (!expectedOrIssuedEpoch(intent.request, observedRuntimeEpoch)) {
        throw new Error("Pending registration intent is inconsistent with the durably observed runtime epoch");
      }
      this.#proofChallenge = intent.proofChallenge;
      return intent.request;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("Registration intent contains invalid JSON", { cause: error });
      }
      throw error;
    } finally {
      await handle.close();
    }
  }

  async write(request: SupervisorRegistrationRequest): Promise<void> {
    const parsed = parseSupervisorRegistrationRequest(request);
    const challenge = proofChallenge();
    await atomicWriteFile(
      this.#path,
      `${JSON.stringify({ version: 2, request: parsed, proofChallenge: challenge })}\n`,
      0o600,
    );
    this.#proofChallenge = challenge;
  }

  async clear(expectedRequest: SupervisorRegistrationRequest): Promise<void> {
    let handle;
    try {
      handle = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const opened = await handle.stat();
    try {
      if (!opened.isFile() || opened.size < 1 || opened.size > MAX_REGISTRATION_INTENT_BYTES) {
        throw new Error("Registration intent changed before it could be cleared");
      }
      const current = parseIntent(JSON.parse(await handle.readFile("utf8")) as unknown);
      if (canonical(current.request) !== canonical(expectedRequest)) {
        throw new Error("Refusing to clear a registration intent that changed unexpectedly");
      }
    } finally {
      await handle.close();
    }
    const currentEntry = await lstat(this.#path);
    if (
      currentEntry.isSymbolicLink() ||
      currentEntry.dev !== opened.dev ||
      currentEntry.ino !== opened.ino
    ) {
      throw new Error("Registration intent changed before unlink");
    }
    await unlink(this.#path);
    await fsyncDirectory(dirname(this.#path));
    this.#proofChallenge = null;
  }
}
