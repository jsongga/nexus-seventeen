/** Adapts the documentation sink contract to paginated, retried, and idempotent Outline API operations. */

import { OutlineClient, OutlineHttpError, type OutlineClientOptions } from "./client.js";
import { isDocSourcePath } from "./enumerate.js";
import { OUTLINE_RETRY_OPTIONS, type RetrySleeper, withRetry } from "./retry.js";
import type { DocsSink, SinkCollection, SinkDocument } from "./sink.js";

const PAGE_LIMIT = 100;

interface OutlineSinkOptions extends OutlineClientOptions {
  readonly sleeper?: RetrySleeper;
}

interface CollectionSummary extends SinkCollection {
  readonly permission?: string | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function envelope(value: unknown, label: string): Record<string, unknown> {
  const parsed = record(value, `${label} response`);
  if (!("data" in parsed)) throw new Error(`${label} response is missing data`);
  return parsed;
}

function parseCollection(value: unknown, label: string): CollectionSummary {
  const item = record(value, label);
  const permission = item.permission;
  if (permission !== undefined && permission !== null && typeof permission !== "string") {
    throw new Error(`${label}.permission must be a string or null`);
  }
  return Object.freeze({
    id: nonEmptyString(item.id, `${label}.id`),
    name: nonEmptyString(item.name, `${label}.name`),
    ...(permission === undefined ? {} : { permission }),
  });
}

function parseCollections(value: unknown, label: string): readonly CollectionSummary[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return Object.freeze(value.map((item, index) => parseCollection(item, `${label}[${index}]`)));
}

function documentSummary(value: unknown, label: string): SinkDocument {
  const item = record(value, label);
  return Object.freeze({
    id: nonEmptyString(item.id, `${label}.id`),
    title: stringValue(item.title, `${label}.title`),
    text: "",
  });
}

function documentSummaries(value: unknown, label: string): readonly SinkDocument[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return Object.freeze(value.map((item, index) => documentSummary(item, `${label}[${index}]`)));
}

function fullDocument(value: unknown, expected: SinkDocument, label: string): SinkDocument {
  const item = record(value, label);
  const id = nonEmptyString(item.id, `${label}.id`);
  const title = stringValue(item.title, `${label}.title`);
  if (id !== expected.id || title !== expected.title) {
    throw new Error(`${label} does not match its documents.list entry`);
  }
  if (typeof item.text !== "string") throw new Error(`${label}.text must be a string`);
  return Object.freeze({ id, title, text: item.text });
}

function nextOffset(response: Record<string, unknown>, currentOffset: number, label: string): number | null {
  const pagination = record(response.pagination, `${label}.pagination`);
  if (!Number.isSafeInteger(pagination.total) || Number(pagination.total) < 0) {
    throw new Error(`${label}.pagination.total must be a non-negative integer`);
  }
  return currentOffset + PAGE_LIMIT < Number(pagination.total) ? currentOffset + PAGE_LIMIT : null;
}

function pageBody(base: Readonly<Record<string, unknown>>, offset: number): Record<string, unknown> {
  return offset === 0 ? { ...base } : { ...base, offset };
}

export class OutlineSink implements DocsSink {
  readonly #client: OutlineClient;
  readonly #sleeper: RetrySleeper | undefined;

  constructor(options: OutlineSinkOptions) {
    this.#client = new OutlineClient(options);
    this.#sleeper = options.sleeper;
  }

  async #retry<T>(operation: () => Promise<T>): Promise<T> {
    return withRetry(operation, OUTLINE_RETRY_OPTIONS, this.#sleeper);
  }

  async #request(path: string, body: unknown): Promise<unknown> {
    return this.#retry(() => this.#client.request(path, body));
  }

  async #dataOnce(path: string, body: unknown, label: string): Promise<unknown> {
    return envelope(await this.#client.request(path, body), label).data;
  }

  async #data(path: string, body: unknown, label: string): Promise<unknown> {
    return envelope(await this.#request(path, body), label).data;
  }

  async #findCollectionOnce(name: string): Promise<CollectionSummary | undefined> {
    let offset = 0;
    while (true) {
      const response = envelope(
        await this.#client.request("/api/collections.list", pageBody({ limit: PAGE_LIMIT }, offset)),
        "collections.list"
      );
      const page = parseCollections(response.data, "collections.list.data");
      const match = page.find((candidate) => candidate.name === name);
      if (match !== undefined) return match;
      const next = nextOffset(response, offset, "collections.list");
      if (next === null) break;
      offset = next;
    }
    return undefined;
  }

  async #readOnlyCollectionOnce(name: string): Promise<SinkCollection | undefined> {
    const match = await this.#findCollectionOnce(name);
    if (match === undefined) return undefined;
    if (match.permission !== "read") {
      await this.#dataOnce("/api/collections.update", { id: match.id, permission: "read" }, "collections.update");
    }
    return Object.freeze({ id: match.id, name: match.name });
  }

  async #ensureCollectionOnce(name: string): Promise<SinkCollection> {
    const existing = await this.#readOnlyCollectionOnce(name);
    if (existing !== undefined) return existing;

    try {
      const created = parseCollection(
        await this.#dataOnce("/api/collections.create", { name, permission: "read" }, "collections.create"),
        "collections.create.data"
      );
      return Object.freeze({ id: created.id, name: created.name });
    } catch (error) {
      if (
        !(error instanceof OutlineHttpError) ||
        error.status === 429 ||
        (error.status >= 500 && error.status <= 599)
      ) {
        throw error;
      }
      const reconciled = await this.#readOnlyCollectionOnce(name);
      if (reconciled !== undefined) return reconciled;
      throw error;
    }
  }

  async ensureCollection(repoName: string): Promise<SinkCollection> {
    const name = `${repoName} docs`;
    return this.#retry(() => this.#ensureCollectionOnce(name));
  }

  async #findDocumentByTitleOnce(collection: SinkCollection, title: string): Promise<SinkDocument | undefined> {
    let offset = 0;
    while (true) {
      const response = envelope(
        await this.#client.request(
          "/api/documents.list",
          pageBody({ collectionId: collection.id, limit: PAGE_LIMIT }, offset)
        ),
        "documents.list"
      );
      const page = documentSummaries(response.data, "documents.list.data");
      const match = page.find((candidate) => candidate.title === title);
      if (match !== undefined) return match;
      const next = nextOffset(response, offset, "documents.list");
      if (next === null) break;
      offset = next;
    }
    return undefined;
  }

  async createDocument(collection: SinkCollection, title: string, text: string): Promise<void> {
    let attempt = 0;
    await this.#retry(async () => {
      const retrying = attempt > 0;
      attempt += 1;
      if (retrying && (await this.#findDocumentByTitleOnce(collection, title)) !== undefined) return;
      await this.#dataOnce(
        "/api/documents.create",
        { collectionId: collection.id, title, text, publish: true },
        "documents.create"
      );
    });
  }

  async listDocuments(collection: SinkCollection): Promise<readonly SinkDocument[]> {
    const summaries: SinkDocument[] = [];
    let offset = 0;
    while (true) {
      const response = envelope(
        await this.#request(
          "/api/documents.list",
          pageBody({ collectionId: collection.id, limit: PAGE_LIMIT }, offset)
        ),
        "documents.list"
      );
      const page = documentSummaries(response.data, "documents.list.data");
      summaries.push(...page);
      const next = nextOffset(response, offset, "documents.list");
      if (next === null) break;
      offset = next;
    }

    const documents: SinkDocument[] = [];
    for (const summary of summaries) {
      if (!isDocSourcePath(summary.title)) {
        documents.push(summary);
        continue;
      }
      documents.push(
        fullDocument(
          await this.#data("/api/documents.info", { id: summary.id }, "documents.info"),
          summary,
          "documents.info.data"
        )
      );
    }
    return Object.freeze(documents);
  }

  async updateDocument(documentId: string, title: string, text: string): Promise<void> {
    await this.#data("/api/documents.update", { id: documentId, title, text }, "documents.update");
  }

  async archiveDocument(documentId: string): Promise<void> {
    await this.#data("/api/documents.archive", { id: documentId }, "documents.archive");
  }
}
