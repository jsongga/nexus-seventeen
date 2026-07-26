import type {
  ManagedTaskWorker,
  TaskFleetAgentConfig,
  TaskFleetConfig,
  TaskFleetEvent,
  TaskFleetLaneSnapshot,
  TaskFleetLogger,
  TaskFleetSleeper,
  TaskFleetSnapshot,
  TaskFleetTransientClassifier,
  TaskFleetWorkerFactory,
} from "./types.js";

interface Lane {
  readonly config: TaskFleetAgentConfig;
  readonly worker: ManagedTaskWorker;
  status: TaskFleetLaneSnapshot["status"];
  restartCount: number;
  retryDelayMs: number | null;
  lastError: string | null;
}

export interface TaskFleetOptions {
  readonly config: TaskFleetConfig;
  readonly workerFactory: TaskFleetWorkerFactory;
  readonly isTransient: TaskFleetTransientClassifier;
  readonly logger?: TaskFleetLogger;
  readonly sleeper?: TaskFleetSleeper;
}

function errorMessage(error: unknown): string {
  const source = error instanceof Error ? error.message : typeof error === "string" ? error : "Task worker failed";
  return source.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 2_000) || "Task worker failed";
}

function defaultLogger(event: TaskFleetEvent): void {
  const detail = event.type === "lane_retrying"
    ? ` retry=${event.restartCount} delayMs=${event.delayMs} error=${JSON.stringify(event.error)}`
    : event.type === "lane_stopped"
      ? ` error=${JSON.stringify(event.error)}`
      : "";
  process.stderr.write(`[task-fleet] ${event.type} agent=${event.agentId} worker=${event.workerId}${detail}\n`);
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);
    // A retrying fleet must stay alive while the board is unavailable; this backoff never launches a model.
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class TaskFleet {
  readonly #config: TaskFleetConfig;
  readonly #workerFactory: TaskFleetWorkerFactory;
  readonly #isTransient: TaskFleetTransientClassifier;
  readonly #logger: TaskFleetLogger;
  readonly #sleeper: TaskFleetSleeper;
  #lanes: Lane[] = [];
  #started = false;
  #stopping = false;
  readonly #stop = new AbortController();
  #runPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(options: TaskFleetOptions) {
    this.#config = options.config;
    this.#workerFactory = options.workerFactory;
    this.#isTransient = options.isTransient;
    this.#logger = options.logger ?? defaultLogger;
    this.#sleeper = options.sleeper ?? abortableSleep;
  }

  get snapshot(): TaskFleetSnapshot {
    return Object.freeze({
      started: this.#started,
      stopping: this.#stopping,
      lanes: Object.freeze(this.#lanes.map((lane) => Object.freeze({
        agentId: lane.config.agentId,
        workerId: lane.config.workerId,
        status: lane.status,
        restartCount: lane.restartCount,
        retryDelayMs: lane.retryDelayMs,
        lastError: lane.lastError,
      }))),
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#runPromise !== null) return this.#runPromise;
    if (this.#closePromise !== null) throw new Error("Task fleet is already closed");
    this.#started = true;
    this.#runPromise = this.#run(AbortSignal.any([signal, this.#stop.signal]));
    return this.#runPromise;
  }

  async #run(signal: AbortSignal): Promise<void> {
    try {
      const created = await Promise.allSettled(this.#config.agents.map(async (config): Promise<Lane> => ({
        config,
        worker: await this.#workerFactory(config, this.#config.boardUrl),
        status: "starting",
        restartCount: 0,
        retryDelayMs: null,
        lastError: null,
      })));
      const failed = created.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      const workers = created
        .filter((result): result is PromiseFulfilledResult<Lane> => result.status === "fulfilled")
        .map((result) => result.value);
      if (failed.length > 0) {
        await Promise.allSettled(workers.map((lane) => lane.worker.close()));
        throw new AggregateError(failed.map((result) => result.reason), "Task-fleet worker creation failed");
      }
      this.#lanes = workers;
      if (signal.aborted || this.#closePromise !== null) {
        await Promise.allSettled(workers.map(async (lane) => {
          await lane.worker.close();
          lane.status = "closed";
        }));
        return;
      }
      await Promise.all(workers.map((lane) => this.#runLane(lane, signal)));
      if (!signal.aborted) {
        const stopped = workers.filter((lane) => lane.status === "stopped");
        throw new AggregateError(stopped.map((lane) => new Error(`${lane.config.agentId}: ${lane.lastError ?? "stopped"}`)), "All task-fleet lanes stopped");
      }
    } finally {
      this.#stopping = true;
      await this.close();
    }
  }

  async #runLane(lane: Lane, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      lane.status = "running";
      lane.retryDelayMs = null;
      this.#logger({ type: "lane_started", agentId: lane.config.agentId, workerId: lane.config.workerId });
      try {
        await lane.worker.run(signal);
        if (signal.aborted) return;
        const error = new Error("Task worker stopped without fleet shutdown");
        lane.lastError = error.message;
        lane.status = "stopped";
        this.#logger({ type: "lane_stopped", agentId: lane.config.agentId, workerId: lane.config.workerId, error: error.message });
        return;
      } catch (error) {
        const detail = errorMessage(error);
        lane.lastError = detail;
        if (!this.#isTransient(error) || signal.aborted) {
          lane.status = signal.aborted ? "closed" : "stopped";
          if (!signal.aborted) {
            this.#logger({ type: "lane_stopped", agentId: lane.config.agentId, workerId: lane.config.workerId, error: detail });
          }
          return;
        }
        lane.restartCount += 1;
        const delayMs = Math.min(
          this.#config.retry.maximumDelayMs,
          this.#config.retry.initialDelayMs * 2 ** Math.min(30, lane.restartCount - 1),
        );
        lane.status = "retrying";
        lane.retryDelayMs = delayMs;
        this.#logger({
          type: "lane_retrying",
          agentId: lane.config.agentId,
          workerId: lane.config.workerId,
          restartCount: lane.restartCount,
          delayMs,
          error: detail,
        });
        await this.#sleeper(delayMs, signal);
      }
    }
  }

  async close(): Promise<void> {
    this.#stop.abort();
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#stopping = true;
    await Promise.allSettled(this.#lanes.map(async (lane) => {
      await lane.worker.close();
      lane.status = "closed";
      lane.retryDelayMs = null;
      this.#logger({ type: "lane_closed", agentId: lane.config.agentId, workerId: lane.config.workerId });
    }));
  }
}
