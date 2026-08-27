import assert from "node:assert/strict";
import test from "node:test";
import { withSourceBanner } from "../../../src/server/docs-publish/banner.js";
import type { DocsPublishRepo } from "../../../src/server/docs-publish/config.js";
import { publishRepo } from "../../../src/server/docs-publish/publish.js";
import type {
  DocsSink,
  SinkCollection,
  SinkDocument,
} from "../../../src/server/docs-publish/sink.js";
import type { GitRunner } from "../../../src/server/task-board/collaborators/scope-check.js";

const ENTRY: DocsPublishRepo = Object.freeze({ name: "sample", path: "/repo", ref: "main" });
const COLLECTION: SinkCollection = Object.freeze({ id: "collection-1", name: "sample docs" });
const RESOLVED_SHA = "abc1234567890abcdef1234567890abcdef12345";

function gitWithDocs(files: Readonly<Record<string, string>>, resolvedSha = RESOLVED_SHA): GitRunner {
  return (arguments_) => {
    if (arguments_.includes("ls-tree")) {
      const separator = arguments_.includes("-z") ? "\0" : "\n";
      return `${Object.keys(files).join(separator)}${separator}`;
    }
    const showIndex = arguments_.indexOf("show");
    if (showIndex >= 0) {
      const selector = arguments_[showIndex + 1] ?? "";
      const separator = selector.indexOf(":");
      const path = separator < 0 ? selector : selector.slice(separator + 1);
      const markdown = files[path];
      if (markdown === undefined) throw new Error(`missing fixture path ${path}`);
      return markdown;
    }
    if (arguments_.includes("rev-parse")) return `${resolvedSha}\n`;
    throw new Error(`unexpected git call: ${arguments_.join(" ")}`);
  };
}

test("resolves a moving ref once and uses that SHA for every content read and the banner", async () => {
  const calls: Array<readonly string[]> = [];
  const runner: GitRunner = (arguments_) => {
    calls.push([...arguments_]);
    if (arguments_.includes("rev-parse")) return `${RESOLVED_SHA}\n`;
    if (arguments_.includes("ls-tree")) return "README.md\0";
    if (arguments_.includes("show")) return "# Readme\n";
    throw new Error(`unexpected git call: ${arguments_.join(" ")}`);
  };
  const sink = new MemorySink();

  await publishRepo(ENTRY, sink, runner);

  const revisionCalls = calls.filter((call) => call.includes("rev-parse"));
  assert.equal(revisionCalls.length, 1);
  assert.equal(calls[0], revisionCalls[0]);
  assert.deepEqual(revisionCalls[0]?.slice(-2), ["rev-parse", ENTRY.ref]);
  const contentCalls = calls.filter((call) => call.includes("ls-tree") || call.includes("show"));
  assert.equal(contentCalls.length, 2);
  assert.ok(contentCalls.every((call) => call.some((argument) => argument.includes(RESOLVED_SHA))));
  assert.ok(contentCalls.every((call) => call.every((argument) => !argument.includes(ENTRY.ref))));

  assert.deepEqual(await sink.listDocuments(COLLECTION), [{
    id: "created-1",
    title: "README.md",
    text: withSourceBanner(
      { path: "README.md", title: "README.md", markdown: "# Readme\n" },
      ENTRY.name,
      RESOLVED_SHA.slice(0, 7),
    ),
  }]);
});

class MemorySink implements DocsSink {
  readonly #documents = new Map<string, SinkDocument>();
  #nextId = 1;
  failCreateTitle: string | undefined;

  constructor(documents: readonly SinkDocument[] = []) {
    for (const document of documents) this.#documents.set(document.id, document);
  }

  async ensureCollection(repoName: string): Promise<SinkCollection> {
    assert.equal(repoName, ENTRY.name);
    return COLLECTION;
  }

  async listDocuments(collection: SinkCollection): Promise<readonly SinkDocument[]> {
    assert.equal(collection, COLLECTION);
    return [...this.#documents.values()];
  }

  async createDocument(collection: SinkCollection, title: string, text: string): Promise<void> {
    assert.equal(collection, COLLECTION);
    if (title === this.failCreateTitle) throw new Error("injected create failure");
    const id = `created-${this.#nextId++}`;
    this.#documents.set(id, Object.freeze({ id, title, text }));
  }

  async updateDocument(documentId: string, title: string, text: string): Promise<void> {
    assert.ok(this.#documents.has(documentId));
    this.#documents.set(documentId, Object.freeze({ id: documentId, title, text }));
  }

  async archiveDocument(documentId: string): Promise<void> {
    assert.equal(this.#documents.delete(documentId), true);
  }
}

test("creates, updates, preserves, and archives documents idempotently across two runs", async () => {
  const files = {
    "README.md": "# Readme\n",
    "docs/guide.md": "# Guide\n",
    "docs/new.md": "# New\n",
  };
  const git = gitWithDocs(files);
  const sink = new MemorySink([
    {
      id: "readme",
      title: "README.md",
      text: withSourceBanner({ path: "README.md", title: "README.md", markdown: files["README.md"] }, "sample", "abc1234"),
    },
    { id: "guide", title: "docs/guide.md", text: "stale text" },
    { id: "old", title: "docs/old.md", text: "old text" },
  ]);

  assert.deepEqual(await publishRepo(ENTRY, sink, git), {
    repo: "sample",
    created: 1,
    updated: 1,
    archived: 1,
    unchanged: 1,
    failures: [],
  });
  assert.deepEqual(await publishRepo(ENTRY, sink, git), {
    repo: "sample",
    created: 0,
    updated: 0,
    archived: 0,
    unchanged: 3,
    failures: [],
  });
});

test("records a per-document sink failure and continues publishing later documents", async () => {
  const sink = new MemorySink();
  sink.failCreateTitle = "docs/b.md";

  const report = await publishRepo(ENTRY, sink, gitWithDocs({
    "docs/a.md": "# A\n",
    "docs/b.md": "# B\n",
    "docs/c.md": "# C\n",
  }));

  assert.equal(report.created, 2);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0] ?? "", /create docs\/b\.md.*injected create failure/u);
  assert.deepEqual(
    (await sink.listDocuments(COLLECTION)).map((document) => document.title),
    ["docs/a.md", "docs/c.md"],
  );
});
