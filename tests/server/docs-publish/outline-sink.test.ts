import assert from "node:assert/strict";
import test from "node:test";
import { OutlineSink } from "../../../src/server/docs-publish/outline-sink.js";
import type { SinkCollection } from "../../../src/server/docs-publish/sink.js";

interface WireStep {
  readonly path: string;
  readonly body: unknown;
  readonly response: unknown;
  readonly status?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sinkFor(
  steps: readonly WireStep[],
  sleeper: (delayMs: number) => Promise<void> = async () => {
    throw new Error("successful requests must not sleep");
  },
): OutlineSink {
  let index = 0;
  const fetchImplementation = (async (input, init = {}) => {
    const step = steps[index];
    assert.ok(step, `unexpected Outline request ${String(input)}`);
    index += 1;
    assert.equal(String(input), `https://outline.example.test${step.path}`);
    assert.equal(init.method, "POST");
    assert.deepEqual(init.headers, {
      accept: "application/json",
      authorization: "Bearer outline-token",
      "content-type": "application/json",
    });
    assert.deepEqual(JSON.parse(String(init.body)) as unknown, step.body);
    return jsonResponse(step.response, step.status);
  }) as typeof fetch;
  const sink = new OutlineSink({
    baseUrl: "https://outline.example.test",
    token: "outline-token",
    fetchImplementation,
    sleeper,
  });
  return Object.assign(sink, {
    assertComplete(): void { assert.equal(index, steps.length); },
  });
}

function assertComplete(sink: OutlineSink): void {
  (sink as OutlineSink & { assertComplete(): void }).assertComplete();
}

test("ensureCollection paginates and matches the exact collection name", async () => {
  const sink = sinkFor([
    {
      path: "/api/collections.list",
      body: { limit: 100 },
      response: {
        data: [{ id: "other", name: "sample docs extra", permission: "read" }],
        pagination: { limit: 100, offset: 0, total: 101 },
      },
    },
    {
      path: "/api/collections.list",
      body: { limit: 100, offset: 100 },
      response: {
        data: [{ id: "target", name: "sample docs", permission: "read" }],
        pagination: { limit: 100, offset: 100, total: 101 },
      },
    },
  ]);

  assert.deepEqual(await sink.ensureCollection("sample"), { id: "target", name: "sample docs" });
  assertComplete(sink);
});

test("ensureCollection creates a missing read-only collection", async () => {
  const sink = sinkFor([
    {
      path: "/api/collections.list",
      body: { limit: 100 },
      response: { data: [], pagination: { limit: 100, offset: 0, total: 0 } },
    },
    {
      path: "/api/collections.create",
      body: { name: "sample docs", permission: "read" },
      response: { data: { id: "created", name: "sample docs", permission: "read" } },
    },
  ]);

  assert.deepEqual(await sink.ensureCollection("sample"), { id: "created", name: "sample docs" });
  assertComplete(sink);
});

test("ensureCollection self-heals a collection with the wrong permission", async () => {
  const sink = sinkFor([
    {
      path: "/api/collections.list",
      body: { limit: 100 },
      response: {
        data: [{ id: "target", name: "sample docs", permission: null }],
        pagination: { limit: 100, offset: 0, total: 1 },
      },
    },
    {
      path: "/api/collections.update",
      body: { id: "target", permission: "read" },
      response: { data: { id: "target", name: "sample docs", permission: "read" } },
    },
  ]);

  assert.deepEqual(await sink.ensureCollection("sample"), { id: "target", name: "sample docs" });
  assertComplete(sink);
});

test("listDocuments paginates and fetches full text only for possible source-path titles", async () => {
  const collection: SinkCollection = Object.freeze({ id: "collection-1", name: "sample docs" });
  const sink = sinkFor([
    {
      path: "/api/documents.list",
      body: { collectionId: "collection-1", limit: 100 },
      response: {
        data: [
          { id: "readme", title: "README.md" },
          { id: "notes", title: "Meeting notes" },
          { id: "untitled", title: "" },
          { id: "wrong-case", title: "docs/Guide.MD" },
        ],
        pagination: { limit: 100, offset: 0, total: 101 },
      },
    },
    {
      path: "/api/documents.list",
      body: { collectionId: "collection-1", limit: 100, offset: 100 },
      response: {
        data: [{ id: "guide", title: "docs/guide.md" }],
        pagination: { limit: 100, offset: 100, total: 101 },
      },
    },
    {
      path: "/api/documents.info",
      body: { id: "readme" },
      response: { data: { id: "readme", title: "README.md", text: "# Readme\n" } },
    },
    {
      path: "/api/documents.info",
      body: { id: "guide" },
      response: { data: { id: "guide", title: "docs/guide.md", text: "# Guide\n" } },
    },
  ]);

  assert.deepEqual(await sink.listDocuments(collection), [
    { id: "readme", title: "README.md", text: "# Readme\n" },
    { id: "notes", title: "Meeting notes", text: "" },
    { id: "untitled", title: "", text: "" },
    { id: "wrong-case", title: "docs/Guide.MD", text: "" },
    { id: "guide", title: "docs/guide.md", text: "# Guide\n" },
  ]);
  assertComplete(sink);
});

test("create, update, and archive use the exact Outline wire shapes", async () => {
  const collection: SinkCollection = Object.freeze({ id: "collection-1", name: "sample docs" });
  const sink = sinkFor([
    {
      path: "/api/documents.create",
      body: { collectionId: "collection-1", title: "docs/new.md", text: "# New\n", publish: true },
      response: { data: { id: "new", title: "docs/new.md", text: "# New\n" } },
    },
    {
      path: "/api/documents.update",
      body: { id: "existing", title: "README.md", text: "# Updated\n" },
      response: { data: { id: "existing", title: "README.md", text: "# Updated\n" } },
    },
    {
      path: "/api/documents.archive",
      body: { id: "old" },
      response: { data: { id: "old", archivedAt: "2026-08-26T00:00:00.000Z" } },
    },
  ]);

  await sink.createDocument(collection, "docs/new.md", "# New\n");
  await sink.updateDocument("existing", "README.md", "# Updated\n");
  await sink.archiveDocument("old");
  assertComplete(sink);
});

test("lost collection-create responses reconcile through a fresh list without duplicating", async () => {
  const collections: Array<{ id: string; name: string; permission: string }> = [];
  const delays: number[] = [];
  let createCalls = 0;
  const fetchImplementation = (async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/collections.list") {
      return jsonResponse({
        data: collections,
        pagination: { limit: 100, offset: 0, total: collections.length },
      });
    }
    assert.equal(path, "/api/collections.create");
    createCalls += 1;
    const body = JSON.parse(String(init.body)) as { name: string; permission: string };
    const created = { id: `collection-${createCalls}`, name: body.name, permission: body.permission };
    collections.push(created);
    throw new TypeError("response connection was lost");
  }) as typeof fetch;
  const sink = new OutlineSink({
    baseUrl: "https://outline.example.test",
    token: "outline-token",
    fetchImplementation,
    sleeper: async (delay) => { delays.push(delay); },
  });

  assert.deepEqual(await sink.ensureCollection("sample"), {
    id: "collection-1",
    name: "sample docs",
  });
  assert.equal(createCalls, 1);
  assert.equal(collections.length, 1);
  assert.deepEqual(delays, [1_000]);
});

test("collection-create conflicts on a retry reconcile through another exact-name lookup", async () => {
  const collections: Array<{ id: string; name: string; permission: string }> = [];
  const delays: number[] = [];
  let createCalls = 0;
  let listCalls = 0;
  const fetchImplementation = (async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/collections.list") {
      listCalls += 1;
      const visible = listCalls === 2 ? [] : collections;
      return jsonResponse({
        data: visible,
        pagination: { limit: 100, offset: 0, total: visible.length },
      });
    }
    assert.equal(path, "/api/collections.create");
    createCalls += 1;
    if (createCalls === 1) {
      const body = JSON.parse(String(init.body)) as { name: string; permission: string };
      collections.push({ id: "collection-1", name: body.name, permission: body.permission });
      throw new TypeError("response connection was lost");
    }
    return jsonResponse({ error: "collection_already_exists" }, 409);
  }) as typeof fetch;
  const sink = new OutlineSink({
    baseUrl: "https://outline.example.test",
    token: "outline-token",
    fetchImplementation,
    sleeper: async (delay) => { delays.push(delay); },
  });

  assert.deepEqual(await sink.ensureCollection("sample"), {
    id: "collection-1",
    name: "sample docs",
  });
  assert.equal(createCalls, 2);
  assert.equal(collections.length, 1);
  assert.deepEqual(delays, [1_000]);
});

test("lost document-create responses reconcile by exact title without duplicating", async () => {
  const collection: SinkCollection = Object.freeze({ id: "collection-1", name: "sample docs" });
  const documents: Array<{ id: string; title: string; text: string }> = [];
  const delays: number[] = [];
  let createCalls = 0;
  let listCalls = 0;
  const fetchImplementation = (async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/documents.list") {
      listCalls += 1;
      return jsonResponse({
        data: documents.map(({ id, title }) => ({ id, title })),
        pagination: { limit: 100, offset: 0, total: documents.length },
      });
    }
    assert.equal(path, "/api/documents.create");
    createCalls += 1;
    const body = JSON.parse(String(init.body)) as { title: string; text: string };
    documents.push({ id: `document-${createCalls}`, title: body.title, text: body.text });
    throw new TypeError("response connection was lost");
  }) as typeof fetch;
  const sink = new OutlineSink({
    baseUrl: "https://outline.example.test",
    token: "outline-token",
    fetchImplementation,
    sleeper: async (delay) => { delays.push(delay); },
  });

  await sink.createDocument(collection, "docs/new.md", "# New\n");
  assert.equal(createCalls, 1);
  assert.equal(listCalls, 1);
  assert.deepEqual(documents, [{ id: "document-1", title: "docs/new.md", text: "# New\n" }]);
  assert.deepEqual(delays, [1_000]);
});

test("collection and document sink paths compose the shared retry policy", async () => {
  const collectionDelays: number[] = [];
  const collectionSink = sinkFor([
    {
      path: "/api/collections.list",
      body: { limit: 100 },
      response: { error: "rate_limit" },
      status: 429,
    },
    {
      path: "/api/collections.list",
      body: { limit: 100 },
      response: {
        data: [{ id: "target", name: "sample docs", permission: "read" }],
        pagination: { limit: 100, offset: 0, total: 1 },
      },
    },
  ], async (delay) => { collectionDelays.push(delay); });

  assert.deepEqual(await collectionSink.ensureCollection("sample"), {
    id: "target",
    name: "sample docs",
  });
  assert.deepEqual(collectionDelays, [1_000]);
  assertComplete(collectionSink);

  const documentDelays: number[] = [];
  const documentSink = sinkFor([
    {
      path: "/api/documents.update",
      body: { id: "existing", title: "README.md", text: "# Updated\n" },
      response: { error: "rate_limit" },
      status: 429,
    },
    {
      path: "/api/documents.update",
      body: { id: "existing", title: "README.md", text: "# Updated\n" },
      response: { data: { id: "existing", title: "README.md", text: "# Updated\n" } },
    },
  ], async (delay) => { documentDelays.push(delay); });

  await documentSink.updateDocument("existing", "README.md", "# Updated\n");
  assert.deepEqual(documentDelays, [1_000]);
  assertComplete(documentSink);
});

test("rejects a successful response without Outline's data envelope", async () => {
  const sink = sinkFor([{
    path: "/api/collections.list",
    body: { limit: 100 },
    response: { ok: true },
  }]);

  await assert.rejects(sink.ensureCollection("sample"), /data/u);
  assertComplete(sink);
});
