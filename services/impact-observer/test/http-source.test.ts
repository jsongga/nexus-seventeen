import assert from "node:assert/strict";
import test from "node:test";
import { HttpImpactEventSource, ImpactSourceError } from "../src/http-source.js";
import { bootstrap, progressEvent, WORKSPACE_ID } from "./helpers.js";

test("HTTP source performs authenticated GET-only bootstrap and bounded SSE consumption", async () => {
  const expectedBootstrap = bootstrap();
  const event = progressEvent();
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (calls.length === 1) {
      return new Response(JSON.stringify(expectedBootstrap), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const body = `id: ${event.sequence}\nevent: steward.event\ndata: ${JSON.stringify(event)}\n\n`;
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    });
  };
  const source = new HttpImpactEventSource({
    controlPlaneOrigin: "https://control.example",
    workspaceId: WORKSPACE_ID,
    readToken: "read-only-observer-token-0001",
    fetch: fakeFetch,
  });
  const received = [];
  const authoritative = await source.bootstrap();
  await assert.rejects(
    source.stream(authoritative, 1, async (item) => { received.push(item); }),
    (error: unknown) => error instanceof ImpactSourceError && error.retryable,
  );
  assert.equal(received.length, 1);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
  assert.equal(new URL(calls[0]!.url).pathname, "/v1/ui/bootstrap");
  assert.equal(new URL(calls[1]!.url).searchParams.get("after"), "1");
  assert.ok(calls.every((call) => call.authorization === "Bearer read-only-observer-token-0001"));
});

test("HTTP source treats authentication failure as non-retryable", async () => {
  const source = new HttpImpactEventSource({
    controlPlaneOrigin: "https://control.example",
    workspaceId: WORKSPACE_ID,
    readToken: "read-only-observer-token-0001",
    fetch: async () => new Response("denied", { status: 401 }),
  });
  await assert.rejects(
    source.bootstrap(),
    (error: unknown) => error instanceof ImpactSourceError && !error.retryable && error.status === 401,
  );
});

test("HTTP source rejects a command-capable identity and remote plaintext bearer transport", async () => {
  assert.throws(() => new HttpImpactEventSource({
    controlPlaneOrigin: "http://control.example",
    workspaceId: WORKSPACE_ID,
    readToken: "read-only-observer-token-0001",
  }), /requires HTTPS/u);

  const source = new HttpImpactEventSource({
    controlPlaneOrigin: "https://control.example",
    workspaceId: WORKSPACE_ID,
    readToken: "must-not-be-a-human-token-0001",
    fetch: async () => new Response(JSON.stringify({
      ...bootstrap(),
      permissions: ["workspace:read", "workspace:control"],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });
  await assert.rejects(
    source.bootstrap(),
    (error: unknown) => error instanceof ImpactSourceError &&
      !error.retryable &&
      /read-only control-plane identity/u.test(error.message),
  );
});
