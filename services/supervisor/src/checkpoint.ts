import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentTaskProjection,
  CheckpointRef,
  CommandId,
  CurrentAction,
  IsoTimestamp,
  TaskId,
} from "@cicada/steward-protocol";
import { parseAgentTaskProjection } from "@cicada/steward-protocol";
import { atomicWriteFile, SerialExecutor } from "./fs-utils.js";

export type RpetPhase = "research" | "plan" | "execute" | "test";
export type InterruptCheckpointState = "none" | "requested" | "acknowledged" | "settled";

export interface TaskTimingCheckpoint {
  expectedAgentMinutes: number;
  expectedCompletedAt: IsoTimestamp;
  startedAt: IsoTimestamp | null;
}

export interface InterruptCheckpoint {
  state: InterruptCheckpointState;
  commandId: CommandId | null;
  reason: string | null;
  requestedAt: IsoTimestamp | null;
  acknowledgedAt: IsoTimestamp | null;
  settledAt: IsoTimestamp | null;
}

export interface SupervisorCheckpoint {
  version: 1;
  checkpointRef: CheckpointRef;
  runtimeEpoch: number;
  desiredState: "active" | "held" | "paused";
  taskId: TaskId | null;
  activeTask: AgentTaskProjection | null;
  queuedTasks: readonly AgentTaskProjection[];
  iteration: number;
  phase: RpetPhase | null;
  currentAction: CurrentAction | null;
  timing: TaskTimingCheckpoint | null;
  resultOverview: string | null;
  lastLocalSequence: number;
  interrupt: InterruptCheckpoint;
  updatedAt: IsoTimestamp;
}

export type CheckpointInput = Omit<SupervisorCheckpoint, "version" | "checkpointRef" | "updatedAt"> & {
  checkpointRef?: CheckpointRef;
  updatedAt?: IsoTimestamp;
};

const CHECKPOINT_FILENAME = "checkpoint.json";
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SENSITIVE_KEY_RE = /(?:token|secret|password|passwd|credential|api[-_]?key|private.*reason|chain.*thought|transcript|raw.*prompt)/i;
const SENSITIVE_VALUE_RE = /(?:\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\bsk-[A-Za-z0-9_-]{12,}|api[-_ ]?key\s*[:=])/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoSensitiveMaterial(value: unknown, path = "checkpoint"): void {
  if (typeof value === "string") {
    if (SENSITIVE_VALUE_RE.test(value)) throw new Error(`${path} appears to contain provider credentials`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveMaterial(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) throw new Error(`${path}.${key} is not permitted in checkpoint metadata`);
    assertNoSensitiveMaterial(entry, `${path}.${key}`);
  }
}

function asIsoTimestamp(value: unknown, label: string, nullable = false): IsoTimestamp | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !ISO_TIMESTAMP_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value as IsoTimestamp;
}

function asNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 2_000) throw new Error(`${label} must be a bounded string or null`);
  return value;
}

function parseInterrupt(value: unknown): InterruptCheckpoint {
  if (!isRecord(value)) throw new Error("checkpoint.interrupt must be an object");
  if (!["none", "requested", "acknowledged", "settled"].includes(String(value.state))) {
    throw new Error("checkpoint.interrupt.state is invalid");
  }
  return {
    state: value.state as InterruptCheckpointState,
    commandId: asNullableString(value.commandId, "checkpoint.interrupt.commandId") as CommandId | null,
    reason: asNullableString(value.reason, "checkpoint.interrupt.reason"),
    requestedAt: asIsoTimestamp(value.requestedAt, "checkpoint.interrupt.requestedAt", true),
    acknowledgedAt: asIsoTimestamp(value.acknowledgedAt, "checkpoint.interrupt.acknowledgedAt", true),
    settledAt: asIsoTimestamp(value.settledAt, "checkpoint.interrupt.settledAt", true),
  };
}

function parseCheckpoint(value: unknown): SupervisorCheckpoint {
  if (!isRecord(value)) throw new Error("Checkpoint must be an object");
  assertNoSensitiveMaterial(value);
  if (value.version !== 1) throw new Error("Unsupported checkpoint version");
  if (typeof value.checkpointRef !== "string" || value.checkpointRef.length === 0) throw new Error("checkpointRef is invalid");
  if (!Number.isSafeInteger(value.runtimeEpoch) || (value.runtimeEpoch as number) < 1) throw new Error("runtimeEpoch is invalid");
  if (!Number.isSafeInteger(value.iteration) || (value.iteration as number) < 0) throw new Error("iteration is invalid");
  if (!Number.isSafeInteger(value.lastLocalSequence) || (value.lastLocalSequence as number) < 0) {
    throw new Error("lastLocalSequence is invalid");
  }
  const phase = value.phase === null ? null : String(value.phase);
  if (phase !== null && !["research", "plan", "execute", "test"].includes(phase)) throw new Error("phase is invalid");
  const desiredState = value.desiredState === undefined
    ? undefined
    : String(value.desiredState);
  if (
    desiredState !== undefined &&
    !["active", "held", "paused"].includes(desiredState)
  ) {
    throw new Error("desiredState is invalid");
  }

  let timing: TaskTimingCheckpoint | null = null;
  if (value.timing !== null) {
    if (!isRecord(value.timing)) throw new Error("timing must be an object or null");
    if (
      !Number.isInteger(value.timing.expectedAgentMinutes) ||
      (value.timing.expectedAgentMinutes as number) < 15 ||
      (value.timing.expectedAgentMinutes as number) % 15 !== 0
    ) {
      throw new Error("timing.expectedAgentMinutes must be a positive multiple of 15");
    }
    const expectedCompletedAt = asIsoTimestamp(value.timing.expectedCompletedAt, "timing.expectedCompletedAt")!;
    if (Date.parse(expectedCompletedAt) % (15 * 60 * 1_000) !== 0) {
      throw new Error("timing.expectedCompletedAt must be on a 15-minute boundary");
    }
    timing = {
      expectedAgentMinutes: value.timing.expectedAgentMinutes as number,
      expectedCompletedAt,
      startedAt: asIsoTimestamp(value.timing.startedAt, "timing.startedAt", true),
    };
  }

  let currentAction: CurrentAction | null = null;
  if (value.currentAction !== null) {
    if (!isRecord(value.currentAction)) throw new Error("currentAction must be an object or null");
    if (typeof value.currentAction.taskId !== "string" || typeof value.currentAction.summary !== "string") {
      throw new Error("currentAction is invalid");
    }
    currentAction = {
      taskId: value.currentAction.taskId as TaskId,
      summary: value.currentAction.summary,
      startedAt: asIsoTimestamp(value.currentAction.startedAt, "currentAction.startedAt")!,
    };
  }

  const activeTask = value.activeTask === undefined || value.activeTask === null
    ? null
    : parseAgentTaskProjection(value.activeTask);
  const queuedTaskValues = value.queuedTasks === undefined ? [] : value.queuedTasks;
  if (!Array.isArray(queuedTaskValues) || queuedTaskValues.length > 100) {
    throw new Error("queuedTasks must be an array of at most 100 tasks");
  }
  const queuedTasks = queuedTaskValues.map((task) => parseAgentTaskProjection(task));
  const taskIds = queuedTasks.map((task) => task.taskId);
  if (new Set(taskIds).size !== taskIds.length || (activeTask && taskIds.includes(activeTask.taskId))) {
    throw new Error("checkpoint task queue contains duplicate task IDs");
  }
  const taskId = asNullableString(value.taskId, "taskId") as TaskId | null;
  if (activeTask && taskId !== activeTask.taskId) {
    throw new Error("checkpoint taskId must match activeTask.taskId");
  }

  return {
    version: 1,
    checkpointRef: value.checkpointRef as CheckpointRef,
    runtimeEpoch: value.runtimeEpoch as number,
    desiredState:
      (desiredState as SupervisorCheckpoint["desiredState"] | undefined) ??
      (parseInterrupt(value.interrupt).state === "none" ? "active" : "paused"),
    taskId,
    activeTask,
    queuedTasks: Object.freeze(queuedTasks),
    iteration: value.iteration as number,
    phase: phase as RpetPhase | null,
    currentAction,
    timing,
    resultOverview: asNullableString(value.resultOverview, "resultOverview"),
    lastLocalSequence: value.lastLocalSequence as number,
    interrupt: parseInterrupt(value.interrupt),
    updatedAt: asIsoTimestamp(value.updatedAt, "updatedAt")!,
  };
}

export const EMPTY_INTERRUPT_CHECKPOINT: InterruptCheckpoint = Object.freeze({
  state: "none",
  commandId: null,
  reason: null,
  requestedAt: null,
  acknowledgedAt: null,
  settledAt: null,
});

export class CheckpointStore {
  readonly #path: string;
  readonly #serial = new SerialExecutor();
  #current: SupervisorCheckpoint | null = null;

  constructor(stateDirectory: string) {
    this.#path = join(stateDirectory, CHECKPOINT_FILENAME);
  }

  get current(): SupervisorCheckpoint | null {
    return this.#current ? structuredClone(this.#current) : null;
  }

  async load(): Promise<SupervisorCheckpoint | null> {
    try {
      const parsed = parseCheckpoint(JSON.parse(await readFile(this.#path, "utf8")));
      this.#current = parsed;
      return structuredClone(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  write(input: CheckpointInput): Promise<SupervisorCheckpoint> {
    return this.#serial.run(async () => {
      const checkpoint = parseCheckpoint({
        ...input,
        version: 1,
        checkpointRef: input.checkpointRef ?? this.#current?.checkpointRef ?? randomUUID(),
        updatedAt: input.updatedAt ?? new Date().toISOString(),
      });
      await atomicWriteFile(this.#path, `${JSON.stringify(checkpoint, null, 2)}\n`);
      this.#current = checkpoint;
      return structuredClone(checkpoint);
    });
  }

  flush(): Promise<void> {
    return this.#serial.idle();
  }
}
