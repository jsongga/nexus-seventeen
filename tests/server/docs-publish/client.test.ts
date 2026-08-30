import assert from "node:assert/strict";
import test from "node:test";
import { OutlineClient, OutlineHttpError } from "../../../src/server/docs-publish/client.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

test("posts JSON with bearer auth and refuses redirects and ambient credentials", async () => {
  let observedInput: string | URL | Request | undefined;
  let observedInit: RequestInit | undefined;
  const client = new OutlineClient({
    baseUrl: "https://outline.example.test",
    token: "outline-token",
    fetchImplementation: (async (input, init) => {
      observedInput = input;
      observedInit = init;
      return jsonResponse({ data: { id: "document-1" } });
    }) as typeof fetch,
  });

  assert.deepEqual(await client.request("/api/documents.info", { id: "document-1" }), { data: { id: "document-1" } });
  assert.equal(String(observedInput), "https://outline.example.test/api/documents.info");
  assert.equal(observedInit?.method, "POST");
  assert.deepEqual(observedInit?.headers, {
    accept: "application/json",
    authorization: "Bearer outline-token",
    "content-type": "application/json",
  });
  assert.equal(observedInit?.body, JSON.stringify({ id: "document-1" }));
  assert.ok(observedInit?.signal instanceof AbortSignal);
  assert.equal(observedInit?.redirect, "error");
  assert.equal(observedInit?.credentials, "omit");
  assert.equal(observedInit?.referrerPolicy, "no-referrer");
});

test("aborts a request after its per-call timeout", async () => {
  let observedSignal: AbortSignal | undefined;
  const keepAlive = setTimeout(() => {}, 1_000);
  const client = new OutlineClient({
    baseUrl: "https://outline.example.test",
    token: "outline-token",
    timeoutMs: 5,
    fetchImplementation: ((_input, init = {}) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        assert.ok(signal instanceof AbortSignal);
        observedSignal = signal;
        const rejectAbort = () => reject(new DOMException("request aborted", "AbortError"));
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
      })) as typeof fetch,
  });

  try {
    await assert.rejects(
      client.request("/api/collections.list", { limit: 100 }),
      (error: unknown) => error instanceof DOMException && error.name === "AbortError"
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(observedSignal?.aborted, true);
});

test("rejects a streamed response that exceeds the configured body bound", async () => {
  const client = new OutlineClient({
    baseUrl: "https://outline.example.test",
    token: "outline-token",
    maxResponseBytes: 16,
    fetchImplementation: (async () => jsonResponse({ data: "body larger than sixteen bytes" })) as typeof fetch,
  });

  await assert.rejects(
    client.request("/api/collections.list", { limit: 100 }),
    (error: unknown) =>
      error instanceof OutlineHttpError && error.status === 200 && /exceeds its size limit/u.test(error.message)
  );
});

test("surfaces Outline's top-level error code on non-success responses", async () => {
  const client = new OutlineClient({
    baseUrl: "https://outline.example.test",
    token: "outline-token",
    fetchImplementation: (async () =>
      jsonResponse(
        {
          ok: false,
          error: "validation_error",
        },
        400
      )) as typeof fetch,
  });

  await assert.rejects(
    client.request("/api/documents.update", { id: "document-1" }),
    (error: unknown) => error instanceof OutlineHttpError && error.status === 400 && error.code === "validation_error"
  );
});

test("leaves network TypeErrors distinguishable for the retry layer above the client", async () => {
  const networkError = new TypeError("network unavailable");
  const client = new OutlineClient({
    baseUrl: "https://outline.example.test",
    token: "outline-token",
    fetchImplementation: (async () => {
      throw networkError;
    }) as typeof fetch,
  });

  await assert.rejects(
    client.request("/api/collections.list", { limit: 100 }),
    (error: unknown) => error === networkError
  );
});
