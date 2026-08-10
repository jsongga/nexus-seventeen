import { safeErrorDetail } from "../../shared/safe-error-detail.js";
import type {
  ManagedTaskWorker,
  TaskFleetAgentConfig,
  TaskFleetConfig,
  TaskFleetErrorClassifier,
  TaskFleetEvent,
  TaskFleetLaneSnapshot,
  TaskFleetLogger,
  TaskFleetSleeper,
  TaskFleetSnapshot,
  TaskFleetTransientClassifier,
  TaskFleetWorkerFactory,
} from "./types.js";

const QUARANTINE_SETTLE_ATTEMPTS = 5;
const MAXIMUM_BACKOFF_MS = 60_000;

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
  readonly classifyError?: TaskFleetErrorClassifier;
  /** Compatibility adapter for custom embedders; production uses classifyError. */
  readonly isTransient?: TaskFleetTransientClassifier;
  readonly logger?: TaskFleetLogger;
  readonly sleeper?: TaskFleetSleeper;
  readonly random?: () => number;
}

export const CREDENTIAL_REVOKED_MESSAGE = "lane credential revoked — update the fleet config with the rotated token";

function defaultLogger(event: TaskFleetEvent): void {
  if (event.type === "lane_credential_revoked") {
    process.stderr.write(`[task-fleet] ${CREDENTIAL_REVOKED_MESSAGE} agent=${event.agentId} worker=${event.workerId}\n`);
    return;
  }
  let detail = "";
  if (event.type === "lane_retrying") {
    detail = ` retry=${event.restartCount} delayMs=${event.delayMs} error=${JSON.stringify(event.error)}`;
  } else if (event.type === "claim_quarantine_retrying") {
    detail = ` attempt=${event.attempt} delayMs=${event.delayMs} error=${JSON.stringify(event.error)}`;
  } else if (event.type === "claim_dropped") {
    detail = ` error=${JSON.stringify(event.error)} settleError=${JSON.stringify(event.settleError)}`;
  } else if (
    event.type === "claim_quarantined" || event.type === "claim_drop_failed" ||
    event.type === "lane_error_report_failed"
  ) {
    detail = ` error=${JSON.stringify(event.error)}`;
  }
  process.stderr.write(`[task-fleet] ${event.type} agent=${event.agentId} worker=${event.workerId}${detail}\n`);
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);
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
  readonly #classifyError: TaskFleetErrorClassifier;
  readonly #logger: TaskFleetLogger;
  readonly #sleeper: TaskFleetSleeper;
  readonly #random: () => number;
  #lanes: Lane[] = [];
  #started = false;
  #stopping = false;
  readonly #stop = new AbortController();
  #runPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(options: TaskFleetOptions) {
    this.#config = options.config;
    this.#workerFactory = options.workerFactory;
    if (options.classifyError === undefined && options.isTransient === undefined) {
      throw new Error("Task fleet requires an error classifier");
    }
    this.#classifyError = options.classifyError ?? ((error) => options.isTransient!(error) ? "TRANSIENT" : "POISONED");
    this.#logger = options.logger ?? defaultLogger;
    this.#sleeper = options.sleeper ?? abortableSleep;
    this.#random = options.random ?? Math.random;
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
    } finally {
      this.#stopping = true;
      await this.close();
    }
  }

  async #runLane(lane: Lane, signal: AbortSignal): Promise<void> {
    this.#logger({ type: "lane_started", agentId: lane.config.agentId, workerId: lane.config.workerId });
    while (!signal.aborted) {
      lane.status = "running";
      lane.retryDelayMs = null;
      try {
        const claimed = await lane.worker.run(signal);
        if (signal.aborted) return;
        lane.restartCount = 0;
        if (claimed) {
          await this.#reportLaneError(lane, null, signal);
          lane.lastError = null;
        }
      } catch (error) {
        if (signal.aborted) return;
        const detail = safeErrorDetail(error);
        lane.lastError = detail;
        const classification = this.#classifyError(error);
        if (classification === "CREDENTIAL_REVOKED") {
          lane.status = "closed";
          lane.retryDelayMs = null;
          lane.lastError = CREDENTIAL_REVOKED_MESSAGE;
          this.#logger({
            type: "lane_credential_revoked",
            agentId: lane.config.agentId,
            workerId: lane.config.workerId,
            error: CREDENTIAL_REVOKED_MESSAGE,
          });
          return;
        }
        if (classification === "TRANSIENT") {
          await this.#retryLane(lane, detail, signal);
          continue;
        }

        await this.#reportLaneError(lane, detail, signal);
        if (!lane.worker.hasActiveClaim()) {
          await this.#retryLane(lane, detail, signal);
          continue;
        }

        await this.#quarantineClaim(lane, detail, signal);
        lane.restartCount = 0;
        lane.retryDelayMs = null;
      }
    }
  }

  #delayForAttempt(attempt: number): number {
    const ceiling = Math.min(
      MAXIMUM_BACKOFF_MS,
      this.#config.retry.maximumDelayMs,
      this.#config.retry.initialDelayMs * 2 ** Math.min(30, Math.max(0, attempt - 1)),
    );
    const sampled = this.#random();
    const unit = Number.isFinite(sampled) ? Math.max(0, Math.min(0.999_999_999, sampled)) : 0.5;
    return Math.floor(ceiling * unit);
  }

  async #retryLane(lane: Lane, detail: string, signal: AbortSignal): Promise<void> {
    lane.restartCount += 1;
    const delayMs = this.#delayForAttempt(lane.restartCount);
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

  async #reportLaneError(lane: Lane, detail: string | null, signal: AbortSignal): Promise<void> {
    try {
      await lane.worker.reportLaneError(detail, signal);
    } catch (error) {
      if (signal.aborted) return;
      this.#logger({
        type: "lane_error_report_failed",
        agentId: lane.config.agentId,
        workerId: lane.config.workerId,
        error: safeErrorDetail(error, "Lane error could not be reported"),
      });
    }
  }

  async #quarantineClaim(lane: Lane, detail: string, signal: AbortSignal): Promise<void> {
    let settleError = "Quarantine settlement failed";
    for (let attempt = 1; attempt <= QUARANTINE_SETTLE_ATTEMPTS && !signal.aborted; attempt += 1) {
      try {
        await lane.worker.quarantineActiveClaim(detail, signal);
        this.#logger({
          type: "claim_quarantined",
          agentId: lane.config.agentId,
          workerId: lane.config.workerId,
          error: detail,
        });
        return;
      } catch (error) {
        settleError = safeErrorDetail(error, settleError);
        if (attempt === QUARANTINE_SETTLE_ATTEMPTS) break;
        const delayMs = this.#delayForAttempt(attempt);
        lane.status = "retrying";
        lane.retryDelayMs = delayMs;
        this.#logger({
          type: "claim_quarantine_retrying",
          agentId: lane.config.agentId,
          workerId: lane.config.workerId,
          attempt,
          delayMs,
          error: settleError,
        });
        await this.#sleeper(delayMs, signal);
      }
    }
    if (signal.aborted) return;
    try {
      await lane.worker.dropActiveClaim(detail);
      this.#logger({
        type: "claim_dropped",
        agentId: lane.config.agentId,
        workerId: lane.config.workerId,
        error: detail,
        settleError,
      });
    } catch (error) {
      this.#logger({
        type: "claim_drop_failed",
        agentId: lane.config.agentId,
        workerId: lane.config.workerId,
        error: safeErrorDetail(error, "Failed to drop quarantined claim"),
      });
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
