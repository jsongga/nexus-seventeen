import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { IsoTimestamp, TaskId, TaskStatus, WorkspaceId } from "@cicada/steward-protocol";
import { IMPACT_API_VERSION, type StoredImpactSummary } from "./types.js";
import { sanitizePublicSummary } from "./redaction.js";

interface PersistedObserverState {
  readonly apiVersion: typeof IMPACT_API_VERSION;
  readonly workspaceId: WorkspaceId;
  readonly sourceSequence: number;
  readonly updatedAt: IsoTimestamp;
  readonly summaries: readonly StoredImpactSummary[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !accepted.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.sort().join(", ")}`);
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /\p{Cc}/u.test(value)) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function timestamp(value: unknown, label: string): IsoTimestamp {
  const text = boundedString(value, label, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO timestamp`);
  return text as IsoTimestamp;
}

const STATUSES: readonly TaskStatus[] = ["queued", "running", "paused", "completed", "failed"];

function parseState(
  input: unknown,
  expectedWorkspaceId: WorkspaceId,
  maximumSummaries: number,
  maximumSummaryCharacters: number,
): PersistedObserverState {
  const value = record(input, "Impact observer state");
  exactKeys(value, ["apiVersion", "workspaceId", "sourceSequence", "updatedAt", "summaries"], "Impact observer state");
  if (value.apiVersion !== IMPACT_API_VERSION) throw new Error("Unsupported impact observer state version");
  if (value.workspaceId !== expectedWorkspaceId) throw new Error("Impact observer state belongs to another workspace");
  if (!Number.isSafeInteger(value.sourceSequence) || (value.sourceSequence as number) < 0) {
    throw new Error("Impact observer sourceSequence is invalid");
  }
  if (!Array.isArray(value.summaries) || value.summaries.length > maximumSummaries) {
    throw new Error("Impact observer summaries exceed the configured bound");
  }

  const summaries = value.summaries.map((entry, index): StoredImpactSummary => {
    const item = record(entry, `summaries[${index}]`);
    exactKeys(
      item,
      ["taskId", "status", "summary", "updatedAt", "sourceSequence", "sourceFingerprint"],
      `summaries[${index}]`,
    );
    const status = boundedString(item.status, `summaries[${index}].status`, 16) as TaskStatus;
    if (!STATUSES.includes(status)) throw new Error(`summaries[${index}].status is invalid`);
    const summary = boundedString(item.summary, `summaries[${index}].summary`, maximumSummaryCharacters);
    if (sanitizePublicSummary(summary, status, maximumSummaryCharacters) !== summary) {
      throw new Error(`summaries[${index}].summary failed the public-output safety check`);
    }
    if (!Number.isSafeInteger(item.sourceSequence) || (item.sourceSequence as number) < 0) {
      throw new Error(`summaries[${index}].sourceSequence is invalid`);
    }
    return Object.freeze({
      taskId: boundedString(item.taskId, `summaries[${index}].taskId`, 256) as TaskId,
      status,
      summary,
      updatedAt: timestamp(item.updatedAt, `summaries[${index}].updatedAt`),
      sourceSequence: item.sourceSequence as number,
      sourceFingerprint: (() => {
        const fingerprint = boundedString(item.sourceFingerprint, `summaries[${index}].sourceFingerprint`, 64);
        if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error(`summaries[${index}].sourceFingerprint is invalid`);
        return fingerprint;
      })(),
    });
  });
  if (new Set(summaries.map((summary) => summary.taskId)).size !== summaries.length) {
    throw new Error("Impact observer summaries contain duplicate task IDs");
  }
  return Object.freeze({
    apiVersion: IMPACT_API_VERSION,
    workspaceId: expectedWorkspaceId,
    sourceSequence: value.sourceSequence as number,
    updatedAt: timestamp(value.updatedAt, "Impact observer updatedAt"),
    summaries: Object.freeze(summaries),
  });
}

async function syncDirectory(pathname: string): Promise<void> {
  const handle = await open(pathname, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ImpactSummaryStore {
  readonly #path: string;
  readonly #workspaceId: WorkspaceId;
  readonly #maximumSummaries: number;
  readonly #maximumSummaryCharacters: number;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly path: string;
    readonly workspaceId: WorkspaceId;
    readonly maximumSummaries: number;
    readonly maximumSummaryCharacters: number;
  }) {
    this.#path = options.path;
    this.#workspaceId = options.workspaceId;
    this.#maximumSummaries = options.maximumSummaries;
    this.#maximumSummaryCharacters = options.maximumSummaryCharacters;
  }

  async load(): Promise<readonly StoredImpactSummary[]> {
    let handle;
    try {
      handle = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const raw = await handle.readFile("utf8");
      const parsed = parseState(
        JSON.parse(raw) as unknown,
        this.#workspaceId,
        this.#maximumSummaries,
        this.#maximumSummaryCharacters,
      );
      return structuredClone(parsed.summaries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    } finally {
      await handle?.close();
    }
  }

  save(input: {
    readonly sourceSequence: number;
    readonly updatedAt: IsoTimestamp;
    readonly summaries: readonly StoredImpactSummary[];
  }): Promise<void> {
    const operation = this.#tail.then(async () => {
      const parsed = parseState(
        {
          apiVersion: IMPACT_API_VERSION,
          workspaceId: this.#workspaceId,
          sourceSequence: input.sourceSequence,
          updatedAt: input.updatedAt,
          summaries: input.summaries,
        },
        this.#workspaceId,
        this.#maximumSummaries,
        this.#maximumSummaryCharacters,
      );
      const directory = dirname(this.#path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temporary = join(directory, `.${basename(this.#path)}.${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      let moved = false;
      try {
        await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        await rename(temporary, this.#path);
        moved = true;
        await syncDirectory(directory);
      } finally {
        await handle.close().catch(() => undefined);
        if (!moved) await unlink(temporary).catch(() => undefined);
      }
    });
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  flush(): Promise<void> {
    return this.#tail;
  }
}
