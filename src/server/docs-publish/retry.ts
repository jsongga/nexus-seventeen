/** Retries only transport, timeout, rate-limit, and server failures from Outline mutations. */

import { OutlineHttpError } from "./client.js";

interface RetryOptions {
  readonly attempts: number;
  readonly delays: readonly number[];
}

export type RetrySleeper = (delayMs: number) => Promise<void>;

export const OUTLINE_RETRY_OPTIONS: RetryOptions = Object.freeze({
  attempts: 3,
  delays: Object.freeze([1_000, 8_000]),
});

function checkedOptions(options: RetryOptions): void {
  if (
    !Number.isSafeInteger(options.attempts) ||
    options.attempts < 1 ||
    options.delays.length !== options.attempts - 1 ||
    options.delays.some((delay) => !Number.isSafeInteger(delay) || delay < 0)
  ) {
    throw new Error("Retry options are invalid");
  }
}

function retryable(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof OutlineHttpError && (error.status === 429 || (error.status >= 500 && error.status <= 599)))
  );
}

const sleep: RetrySleeper = (delayMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
  sleeper: RetrySleeper = sleep
): Promise<T> {
  checkedOptions(options);
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!retryable(error) || attempt === options.attempts - 1) throw error;
      await sleeper(options.delays[attempt] as number);
    }
  }
  throw new Error("Retry attempts were exhausted");
}
