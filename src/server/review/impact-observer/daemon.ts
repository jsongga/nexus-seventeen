import type { ImpactEventSource, ImpactObserverLogger } from "./types.js";
import { ImpactCursorError, ImpactObserver } from "./observer.js";
import { ImpactSourceError } from "./http-source.js";

const NULL_LOGGER: ImpactObserverLogger = Object.freeze({
  info() {},
  warn() {},
  error() {},
});

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    timer.unref();
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class ImpactObserverDaemon {
  readonly #observer: ImpactObserver;
  readonly #source: ImpactEventSource;
  readonly #reconnectMinimumMs: number;
  readonly #reconnectMaximumMs: number;
  readonly #logger: ImpactObserverLogger;

  constructor(options: {
    readonly observer: ImpactObserver;
    readonly source: ImpactEventSource;
    readonly reconnectMinimumMs: number;
    readonly reconnectMaximumMs: number;
    readonly logger?: ImpactObserverLogger;
  }) {
    this.#observer = options.observer;
    this.#source = options.source;
    this.#reconnectMinimumMs = options.reconnectMinimumMs;
    this.#reconnectMaximumMs = options.reconnectMaximumMs;
    this.#logger = options.logger ?? NULL_LOGGER;
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.#observer.restore();
    let delay = this.#reconnectMinimumMs;
    try {
      while (!signal.aborted) {
        try {
          const bootstrap = await this.#source.bootstrap(signal);
          if (signal.aborted) break;
          this.#observer.acceptBootstrap(bootstrap);
          const initial = await this.#observer.flush(signal);
          if (initial.failed > 0) this.#logger.warn("One or more impact summaries will be retried after fresh task activity");
          delay = this.#reconnectMinimumMs;
          await this.#source.stream(
            bootstrap,
            this.#observer.cursor,
            async (event) => {
              this.#observer.acceptEvent(event);
              const result = await this.#observer.flush(signal);
              if (result.failed > 0) this.#logger.warn("An impact summary attempt failed without affecting agent work");
            },
            signal,
          );
        } catch (error) {
          if (signal.aborted) break;
          if (error instanceof ImpactSourceError && !error.retryable) throw error;
          if (error instanceof ImpactCursorError) {
            this.#logger.warn("Impact observer detected an event gap and will re-bootstrap authoritative state");
          } else {
            this.#logger.warn("Impact observer lost its read-only event stream and will reconnect");
          }
        }
        if (!signal.aborted) await wait(delay, signal);
        delay = Math.min(this.#reconnectMaximumMs, delay * 2);
      }
    } finally {
      await this.#observer.close();
      this.#logger.info("Impact observer stopped");
    }
  }
}
