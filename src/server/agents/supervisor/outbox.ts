import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDurableOutboxEvent } from "#shared/protocol";
import { appendAndFsync, atomicWriteFile, SerialExecutor } from "./fs-utils.js";

export type DurableOutboxEvent = ReturnType<typeof parseDurableOutboxEvent>;
export type DurableOutboxPayload = DurableOutboxEvent["payload"];

export interface OutboxIdentity {
  apiVersion: DurableOutboxEvent["apiVersion"];
  workspaceId: string;
  agentId: string;
  laneId: string;
  runtimeInstanceId: string;
}

export interface OpenOutboxOptions {
  stateDirectory: string;
  identity: OutboxIdentity;
  runtimeEpoch: number;
}

interface OutboxStateFile {
  version: 1;
  lastSequence: number;
  acknowledgedThrough: number;
}

const OUTBOX_FILENAME = "runtime-outbox.jsonl";
const STATE_FILENAME = "runtime-outbox-state.json";
const DEFAULT_BATCH_LIMIT = 100;

function parseStateFile(text: string): OutboxStateFile {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Outbox state must be an object");
  }
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    !Number.isSafeInteger(state.lastSequence) ||
    !Number.isSafeInteger(state.acknowledgedThrough) ||
    (state.lastSequence as number) < 0 ||
    (state.acknowledgedThrough as number) < 0 ||
    (state.acknowledgedThrough as number) > (state.lastSequence as number)
  ) {
    throw new Error("Outbox state is invalid");
  }
  return state as unknown as OutboxStateFile;
}

async function readOptional(pathname: string): Promise<string | null> {
  try {
    return await readFile(pathname, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function validateEventIdentity(event: DurableOutboxEvent, identity: OutboxIdentity): void {
  if (
    event.apiVersion !== identity.apiVersion ||
    event.workspaceId !== identity.workspaceId ||
    event.agentId !== identity.agentId ||
    event.laneId !== identity.laneId
  ) {
    throw new Error(`Outbox event ${event.eventId} does not belong to this runtime identity`);
  }
}

function parseJsonLines(
  text: string,
  identity: OutboxIdentity,
  acknowledgedThrough: number,
): { events: DurableOutboxEvent[]; truncatedTail: boolean; highestSequence: number } {
  if (text.length === 0) return { events: [], truncatedTail: false, highestSequence: acknowledgedThrough };
  const hasFinalNewline = text.endsWith("\n");
  const lines = text.split("\n");
  const events: DurableOutboxEvent[] = [];
  let highestSequence = acknowledgedThrough;
  let previousSequence = 0;
  let truncatedTail = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const isLast = index === lines.length - 1;
    if (line.length === 0 && isLast && hasFinalNewline) continue;
    if (line.trim().length === 0) throw new Error(`Outbox contains an empty record at line ${index + 1}`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (isLast && !hasFinalNewline) {
        truncatedTail = true;
        break;
      }
      throw new Error(`Outbox record ${index + 1} is invalid JSON`, { cause: error });
    }

    let event: DurableOutboxEvent;
    try {
      event = parseDurableOutboxEvent(parsed);
    } catch (error) {
      throw new Error(`Outbox record ${index + 1} fails protocol validation`, { cause: error });
    }
    validateEventIdentity(event, identity);
    if (!Number.isSafeInteger(event.localSequence) || event.localSequence <= previousSequence) {
      throw new Error(`Outbox localSequence is not strictly increasing at line ${index + 1}`);
    }
    previousSequence = event.localSequence;
    highestSequence = Math.max(highestSequence, event.localSequence);
    if (event.localSequence > acknowledgedThrough) events.push(event);
  }

  return { events, truncatedTail, highestSequence };
}

export class DurableOutbox {
  readonly #logPath: string;
  readonly #statePath: string;
  readonly #identity: OutboxIdentity;
  readonly #serial = new SerialExecutor();
  #runtimeEpoch: number;
  #pending: DurableOutboxEvent[];
  #lastSequence: number;
  #acknowledgedThrough: number;
  #faulted: Error | null = null;

  private constructor(
    options: OpenOutboxOptions,
    pending: DurableOutboxEvent[],
    lastSequence: number,
    acknowledgedThrough: number,
  ) {
    this.#logPath = join(options.stateDirectory, OUTBOX_FILENAME);
    this.#statePath = join(options.stateDirectory, STATE_FILENAME);
    this.#identity = Object.freeze({ ...options.identity });
    this.#runtimeEpoch = options.runtimeEpoch;
    this.#pending = pending;
    this.#lastSequence = lastSequence;
    this.#acknowledgedThrough = acknowledgedThrough;
  }

  static async open(options: OpenOutboxOptions): Promise<DurableOutbox> {
    if (!Number.isSafeInteger(options.runtimeEpoch) || options.runtimeEpoch < 1) {
      throw new Error("runtimeEpoch must be a positive safe integer");
    }
    const stateText = await readOptional(join(options.stateDirectory, STATE_FILENAME));
    const state = stateText
      ? parseStateFile(stateText)
      : { version: 1 as const, lastSequence: 0, acknowledgedThrough: 0 };
    const logText = await readOptional(join(options.stateDirectory, OUTBOX_FILENAME)) ?? "";
    const parsed = parseJsonLines(logText, options.identity, state.acknowledgedThrough);
    const lastSequence = Math.max(state.lastSequence, parsed.highestSequence);
    const outbox = new DurableOutbox(options, parsed.events, lastSequence, state.acknowledgedThrough);
    if (parsed.truncatedTail) {
      await atomicWriteFile(outbox.#logPath, outbox.#serializePending());
    }
    return outbox;
  }

  get lastSequence(): number {
    return this.#lastSequence;
  }

  get acknowledgedThrough(): number {
    return this.#acknowledgedThrough;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  pending(limit = DEFAULT_BATCH_LIMIT): readonly DurableOutboxEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Outbox batch limit must be between 1 and 1000");
    }
    return this.#pending.slice(0, limit);
  }

  pendingTail(limit = DEFAULT_BATCH_LIMIT): readonly DurableOutboxEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Outbox tail limit must be between 1 and 1000");
    }
    return this.#pending.slice(-limit);
  }

  append(payload: DurableOutboxPayload, occurredAt = new Date()): Promise<DurableOutboxEvent> {
    return this.#serial.run(async () => {
      if (this.#faulted) {
        throw new Error("Durable outbox requires a safe reopen after a failed append", {
          cause: this.#faulted,
        });
      }
      if (this.#pending.some(
        (event) =>
          event.runtimeEpoch !== this.#runtimeEpoch ||
          event.runtimeInstanceId !== this.#identity.runtimeInstanceId,
      )) {
        throw new Error("Outbox must reconcile and rebind its pending suffix before appending in a new runtime");
      }
      const event = parseDurableOutboxEvent({
        ...this.#identity,
        eventId: randomUUID(),
        localSequence: this.#lastSequence + 1,
        runtimeEpoch: this.#runtimeEpoch,
        occurredAt: occurredAt.toISOString(),
        payload,
      });
      try {
        await appendAndFsync(this.#logPath, `${JSON.stringify(event)}\n`);
      } catch (error) {
        if (error instanceof AggregateError && error.message === "APPEND_AND_ROLLBACK_FAILED") {
          this.#faulted = error;
        }
        throw error;
      }
      this.#pending.push(event);
      this.#lastSequence = event.localSequence;
      return event;
    });
  }

  acknowledge(acknowledgedThrough: number): Promise<void> {
    return this.#serial.run(async () => {
      if (!Number.isSafeInteger(acknowledgedThrough)) {
        throw new Error("Acknowledgement sequence must be a safe integer");
      }
      if (acknowledgedThrough < this.#acknowledgedThrough) return;
      if (acknowledgedThrough > this.#lastSequence) {
        throw new Error("Server cannot acknowledge an outbox sequence that was never written");
      }
      if (acknowledgedThrough === this.#acknowledgedThrough) return;

      const nextPending = this.#pending.filter((event) => event.localSequence > acknowledgedThrough);
      const nextState: OutboxStateFile = {
        version: 1,
        lastSequence: this.#lastSequence,
        acknowledgedThrough,
      };
      await atomicWriteFile(this.#statePath, `${JSON.stringify(nextState)}\n`);
      await atomicWriteFile(
        this.#logPath,
        nextPending.length > 0 ? `${nextPending.map((event) => JSON.stringify(event)).join("\n")}\n` : "",
      );
      this.#pending = nextPending;
      this.#acknowledgedThrough = acknowledgedThrough;
    });
  }

  rebasePendingToEpoch(runtimeEpoch: number): Promise<void> {
    return this.rebindPendingToRuntime(runtimeEpoch);
  }

  rebindPendingToRuntime(runtimeEpoch: number): Promise<void> {
    return this.#serial.run(async () => {
      if (!Number.isSafeInteger(runtimeEpoch) || runtimeEpoch < this.#runtimeEpoch) {
        throw new Error("runtimeEpoch cannot move backwards");
      }
      const needsRebase = this.#pending.some(
        (event) =>
          event.runtimeEpoch !== runtimeEpoch ||
          event.runtimeInstanceId !== this.#identity.runtimeInstanceId,
      );
      if (!needsRebase) {
        this.#runtimeEpoch = runtimeEpoch;
        return;
      }
      const rebased = this.#pending.map((event) => parseDurableOutboxEvent({
        ...event,
        runtimeEpoch,
        runtimeInstanceId: this.#identity.runtimeInstanceId,
      }));
      // Epoch and boot identity are fencing metadata rather than immutable
      // business evidence. This method is called only after the server has
      // acknowledged the durable prefix, so only the unsent suffix is rebound.
      // Atomic replacement ensures a crash sees either the complete old suffix or
      // complete rebased suffix, never mixed event content for one eventId.
      await atomicWriteFile(
        this.#logPath,
        rebased.length > 0 ? `${rebased.map((event) => JSON.stringify(event)).join("\n")}\n` : "",
      );
      this.#pending = rebased;
      this.#runtimeEpoch = runtimeEpoch;
    });
  }

  flush(): Promise<void> {
    return this.#serial.idle();
  }

  #serializePending(): string {
    return this.#pending.length > 0
      ? `${this.#pending.map((event) => JSON.stringify(event)).join("\n")}\n`
      : "";
  }
}
