import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { withSourceBanner } from "../../../src/server/docs-publish/banner.js";
import { OutlineHttpError } from "../../../src/server/docs-publish/client.js";
import type { DocsPublishRepo } from "../../../src/server/docs-publish/config.js";
import { publishRepo } from "../../../src/server/docs-publish/publish.js";
import type { DocsSink, SinkCollection, SinkDocument } from "../../../src/server/docs-publish/sink.js";
import type { GitTextRunner } from "../../../src/server/task-board/collaborators/scope-check.js";

const ENTRY: DocsPublishRepo = Object.freeze({ name: "sample", path: "/repo", ref: "main" });
const COLLECTION: SinkCollection = Object.freeze({ id: "collection-1", name: "sample docs" });
const RESOLVED_SHA = "abc1234567890abcdef1234567890abcdef12345";

function gitBlobSha(markdown: string): string {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(markdown)}\0${markdown}`)
    .digest("hex");
}

function gitWithDocs(files: Readonly<Record<string, string>>, resolvedSha = RESOLVED_SHA): GitTextRunner {
  return (arguments_) => {
    if (arguments_.includes("ls-tree")) {
      const separator = arguments_.includes("-z") ? "\0" : "\n";
      const entries = Object.entries(files).map(([path, markdown]) => `100644 blob ${gitBlobSha(markdown)}\t${path}`);
      return `${entries.join(separator)}${separator}`;
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

test("resolves a moving ref once and uses that SHA for every content read", async () => {
  const calls: Array<readonly string[]> = [];
  const markdown = "# Readme\n";
  const blobSha = gitBlobSha(markdown);
  const runner: GitTextRunner = (arguments_) => {
    calls.push([...arguments_]);
    if (arguments_.includes("rev-parse")) return `${RESOLVED_SHA}\n`;
    if (arguments_.includes("ls-tree")) return `100644 blob ${blobSha}\tREADME.md\0`;
    if (arguments_.includes("show")) return markdown;
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

  assert.deepEqual(await sink.listDocuments(COLLECTION), [
    {
      id: "created-1",
      title: "README.md",
      text: withSourceBanner({ path: "README.md", title: "README.md", markdown, blobSha }, ENTRY.name),
    },
  ]);
});

class MemorySink implements DocsSink {
  readonly #documents = new Map<string, SinkDocument>();
  #nextId = 1;
  ensureCollectionCalls = 0;
  failCreateTitle: string | undefined;
  failCreateError: Error = new Error("injected create failure");

  constructor(documents: readonly SinkDocument[] = []) {
    for (const document of documents) this.#documents.set(document.id, document);
  }

  async ensureCollection(repoName: string): Promise<SinkCollection> {
    this.ensureCollectionCalls += 1;
    assert.equal(repoName, ENTRY.name);
    return COLLECTION;
  }

  async listDocuments(collection: SinkCollection): Promise<readonly SinkDocument[]> {
    assert.equal(collection, COLLECTION);
    return [...this.#documents.values()];
  }

  async createDocument(collection: SinkCollection, title: string, text: string): Promise<void> {
    assert.equal(collection, COLLECTION);
    if (title === this.failCreateTitle) throw this.failCreateError;
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

test("diffs by banner blob SHA, updates unparseable banners, and stays idempotent", async () => {
  const files = {
    "README.md": "# Readme\n\n- item1\n",
    "docs/guide.md": "# Guide\n",
    "docs/malformed.md": "# Malformed\n",
    "docs/new.md": "# New\n",
  };
  const git = gitWithDocs(files);
  const readmeSource = {
    path: "README.md",
    title: "README.md",
    markdown: files["README.md"],
    blobSha: gitBlobSha(files["README.md"]),
  };
  const outlineSerializedReadme = withSourceBanner(readmeSource, "sample").replace("- item1", "* item1").trimEnd();
  const sink = new MemorySink([
    {
      id: "readme",
      title: "README.md",
      text: outlineSerializedReadme,
    },
    {
      id: "guide",
      title: "docs/guide.md",
      text: withSourceBanner(
        {
          path: "docs/guide.md",
          title: "docs/guide.md",
          markdown: files["docs/guide.md"],
          blobSha: "0000000000000000000000000000000000000000",
        },
        "sample"
      ),
    },
    { id: "malformed", title: "docs/malformed.md", text: "not a publisher banner\n\n# Malformed" },
    { id: "old", title: "docs/old.md", text: "old text" },
  ]);

  assert.deepEqual(await publishRepo(ENTRY, sink, git), {
    repo: "sample",
    created: 1,
    updated: 2,
    archived: 1,
    unchanged: 1,
    failures: [],
  });
  assert.deepEqual(await publishRepo(ENTRY, sink, git), {
    repo: "sample",
    created: 0,
    updated: 0,
    archived: 0,
    unchanged: 4,
    failures: [],
  });

  const documents = await sink.listDocuments(COLLECTION);
  assert.equal(documents.find((document) => document.title === "README.md")?.text, outlineSerializedReadme);
  assert.equal(
    documents.find((document) => document.title === "docs/guide.md")?.text,
    withSourceBanner(
      {
        path: "docs/guide.md",
        title: "docs/guide.md",
        markdown: files["docs/guide.md"],
        blobSha: gitBlobSha(files["docs/guide.md"]),
      },
      "sample"
    )
  );
  assert.equal(
    documents.find((document) => document.title === "docs/malformed.md")?.text,
    withSourceBanner(
      {
        path: "docs/malformed.md",
        title: "docs/malformed.md",
        markdown: files["docs/malformed.md"],
        blobSha: gitBlobSha(files["docs/malformed.md"]),
      },
      "sample"
    )
  );
});

test("treats a matching blob banner with a backtick-bearing source path as unchanged", async () => {
  const path = "docs/with`backtick.md";
  const markdown = "# Backtick path\n";
  const blobSha = gitBlobSha(markdown);
  const banner = withSourceBanner({ path, title: path, markdown, blobSha }, ENTRY.name);
  const sink = new MemorySink([{ id: "backtick", title: path, text: banner }]);

  assert.deepEqual(await publishRepo(ENTRY, sink, gitWithDocs({ [path]: markdown })), {
    repo: "sample",
    created: 0,
    updated: 0,
    archived: 0,
    unchanged: 1,
    failures: [],
  });
  assert.equal((await sink.listDocuments(COLLECTION))[0]?.text, banner);
});

test("records a per-document sink failure and continues publishing later documents", async () => {
  const sink = new MemorySink();
  sink.failCreateTitle = "docs/b.md";

  const report = await publishRepo(
    ENTRY,
    sink,
    gitWithDocs({
      "docs/a.md": "# A\n",
      "docs/b.md": "# B\n",
      "docs/c.md": "# C\n",
    })
  );

  assert.equal(report.created, 2);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0] ?? "", /create docs\/b\.md.*injected create failure/u);
  assert.deepEqual(
    (await sink.listDocuments(COLLECTION)).map((document) => document.title),
    ["docs/a.md", "docs/c.md"]
  );
});

test("reports enumeration failures without preparing the collection", async () => {
  const sink = new MemorySink();
  const runner: GitTextRunner = (arguments_) => {
    if (arguments_.includes("rev-parse")) return `${RESOLVED_SHA}\n`;
    if (arguments_.includes("ls-tree")) throw new Error("stdout maxBuffer length exceeded");
    throw new Error(`unexpected git call: ${arguments_.join(" ")}`);
  };

  assert.deepEqual(await publishRepo(ENTRY, sink, runner), {
    repo: "sample",
    created: 0,
    updated: 0,
    archived: 0,
    unchanged: 0,
    failures: ["enumerate: stdout maxBuffer length exceeded"],
  });
  assert.equal(sink.ensureCollectionCalls, 0);
  assert.deepEqual(await sink.listDocuments(COLLECTION), []);
});

test("includes Outline's HTTP status and error code in sink failure details", async () => {
  const sink = new MemorySink();
  sink.failCreateTitle = "README.md";
  sink.failCreateError = new OutlineHttpError("Outline request failed with HTTP 400", 400, "validation_error");

  const report = await publishRepo(
    ENTRY,
    sink,
    gitWithDocs({
      "README.md": "# Readme\n",
    })
  );

  assert.deepEqual(report.failures, [
    "create README.md: HTTP 400 validation_error: Outline request failed with HTTP 400",
  ]);
});
