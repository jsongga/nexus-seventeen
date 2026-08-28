import assert from "node:assert/strict";
import test from "node:test";
import {
  OutlineClient,
  OutlineHttpError,
} from "../../../src/server/docs-publish/client.js";
import { withRetry } from "../../../src/server/docs-publish/retry.js";

const OPTIONS = Object.freeze({ attempts: 3, delays: Object.freeze([1_000, 8_000]) });

test("retries rate limits with the configured delays and then succeeds", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await withRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new OutlineHttpError("rate limited", 429, "rate_limit");
    return "ok";
  }, OPTIONS, async (delay) => { delays.push(delay); });

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1_000, 8_000]);
});

test("does not retry a non-retryable HTTP response", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const failure = new OutlineHttpError("bad request", 400, "validation_error");

  await assert.rejects(withRetry(async () => {
    attempts += 1;
    throw failure;
  }, OPTIONS, async (delay) => { delays.push(delay); }), (error: unknown) => error === failure);
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test("retries network TypeErrors", async () => {
  let attempts = 0;
  const delays: number[] = [];
  assert.equal(await withRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("network unavailable");
    return 42;
  }, OPTIONS, async (delay) => { delays.push(delay); }), 42);

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [1_000]);
});

test("retries client timeouts with the configured delays", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const keepAlive = setTimeout(() => {}, 1_000);
  const client = new OutlineClient({
    baseUrl: "https://outline.example.test",
    token: "outline-token",
    timeoutMs: 5,
    fetchImplementation: ((_input, init = {}) => {
      attempts += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        assert.ok(signal instanceof AbortSignal);
        const rejectAbort = () => reject(new DOMException("request aborted", "AbortError"));
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
      });
    }) as typeof fetch,
  });

  try {
    await assert.rejects(
      withRetry(
        () => client.request("/api/collections.list", { limit: 100 }),
        OPTIONS,
        async (delay) => { delays.push(delay); },
      ),
      (error: unknown) => error instanceof DOMException && error.name === "AbortError",
    );
  } finally {
    clearTimeout(keepAlive);
  }

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1_000, 8_000]);
});

test("rethrows the last retryable failure after exhausting all attempts", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const failure = new OutlineHttpError("unavailable", 503, "service_unavailable");

  await assert.rejects(withRetry(async () => {
    attempts += 1;
    throw failure;
  }, OPTIONS, async (delay) => { delays.push(delay); }), (error: unknown) => error === failure);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1_000, 8_000]);
});
