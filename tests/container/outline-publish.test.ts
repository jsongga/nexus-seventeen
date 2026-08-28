import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { DocsPublishRepo } from "../../src/server/docs-publish/config.js";
import { OutlineSink } from "../../src/server/docs-publish/outline-sink.js";
import { publishRepo } from "../../src/server/docs-publish/publish.js";
import { runGit } from "./helpers.js";
import { bootOutline, OUTLINE_IMAGE, type OutlineFixture } from "./outline-helpers.js";

const REPO_NAME = "nexus-seventeen";
const COLLECTION_NAME = `${REPO_NAME} docs`;
const WORKFLOW_TITLE = "docs/workflow.md";

interface OutlineEnvelope {
  readonly data: unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function dataArray(value: unknown, label: string): readonly Record<string, unknown>[] {
  const envelope = record(value, `${label} response`);
  assert.ok(Array.isArray(envelope.data), `${label}.data must be an array`);
  return envelope.data.map((item, index) => record(item, `${label}.data[${index}]`));
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  return record(record(value, `${label} response`).data, `${label}.data`);
}

async function outlineApi(
  fixture: OutlineFixture,
  path: string,
  body: unknown,
): Promise<OutlineEnvelope> {
  const response = await fetch(`${fixture.baseUrl}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${fixture.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${path} returned HTTP ${response.status}: ${text.slice(0, 2_000)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    assert.fail(`${path} returned invalid JSON: ${String(error)}; body=${text.slice(0, 2_000)}`);
  }
  return record(parsed, `${path} response`) as unknown as OutlineEnvelope;
}

test("Outline container image stays equal to the deployment compose pin", async () => {
  const compose = await readFile(resolve("docker-compose.outline.yml"), "utf8");
  const composeImage = /^ {4}image:\s*(outlinewiki\/outline:[^\s#]+)\s*$/mu.exec(compose)?.[1];
  assert.equal(composeImage, OUTLINE_IMAGE);
});

test("real Outline publishes this repo idempotently and archives excluded docs", {
  timeout: 600_000,
}, async (t) => {
  const fixture = await bootOutline();
  t.after(() => fixture.teardown());
  const repoPath = resolve(".");
  const entry: DocsPublishRepo = Object.freeze({
    name: REPO_NAME,
    path: repoPath,
    ref: "HEAD",
    exclude: Object.freeze(["docs/superpowers/**"]),
  });
  const sink = new OutlineSink({
    baseUrl: fixture.baseUrl,
    token: fixture.token,
    allowInsecureBaseUrl: true,
    timeoutMs: 30_000,
  });

  const first = await fixture.step("publish-run-1-create", async () => {
    const report = await publishRepo(entry, sink);
    assert.equal(report.failures.length, 0, `run 1 failures: ${report.failures.join("; ")}`);
    assert.ok(report.created > 0, `run 1 should create documents: ${JSON.stringify(report)}`);
    return report;
  });

  await fixture.step("publish-run-2-all-unchanged", async () => {
    const report = await publishRepo(entry, sink);
    assert.equal(report.failures.length, 0, `run 2 failures: ${report.failures.join("; ")}`);
    assert.equal(report.created, 0);
    assert.equal(report.updated, 0);
    assert.equal(report.archived, 0);
    assert.equal(report.unchanged, first.created, `run 2 was not all-unchanged: ${JSON.stringify(report)}`);
  });

  const workflowDocument = await fixture.step("assert-read-only-collection-and-banner", async () => {
    const collections = dataArray(
      await outlineApi(fixture, "/api/collections.list", { limit: 100 }),
      "collections.list",
    );
    const collection = collections.find((candidate) => candidate.name === COLLECTION_NAME);
    assert.ok(collection, `collection ${COLLECTION_NAME} was not returned by collections.list`);
    assert.equal(collection.permission, "read");
    assert.equal(typeof collection.id, "string");

    const documents = dataArray(
      await outlineApi(fixture, "/api/documents.list", { collectionId: collection.id, limit: 100 }),
      "documents.list",
    );
    const workflow = documents.find((candidate) => candidate.title === WORKFLOW_TITLE);
    assert.ok(workflow, `${WORKFLOW_TITLE} was not returned by documents.list`);
    assert.equal(typeof workflow.id, "string");

    const document = dataRecord(
      await outlineApi(fixture, "/api/documents.info", { id: workflow.id }),
      "documents.info",
    );
    assert.equal(document.id, workflow.id);
    assert.equal(document.title, WORKFLOW_TITLE);
    const text = document.text;
    assert.ok(typeof text === "string", "documents.info.data.text must be a string");
    const blobSha = (await runGit(repoPath, ["rev-parse", `HEAD:${WORKFLOW_TITLE}`])).trim();
    const expectedBanner = `> **Read-only mirror.** Source: \`${REPO_NAME}/${WORKFLOW_TITLE}\` @ ${blobSha.slice(0, 12)}. Edit in the repository — this page is republished on merge. Comments are welcome here.`;
    assert.equal(text.split("\n", 1)[0], expectedBanner);
    return Object.freeze({ id: workflow.id, title: workflow.title });
  });

  await fixture.step("publish-run-3-archive-widened-exclude", async () => {
    const report = await publishRepo(Object.freeze({
      ...entry,
      exclude: Object.freeze(["docs/superpowers/**", "docs/**"]),
    }), sink);
    assert.equal(report.failures.length, 0, `run 3 failures: ${report.failures.join("; ")}`);
    assert.equal(report.created, 0);
    assert.equal(report.updated, 0);
    assert.equal(report.archived, first.created - 1, `every docs/** title except README.md should archive: ${JSON.stringify(report)}`);

    const archived = dataRecord(
      await outlineApi(fixture, "/api/documents.info", { id: workflowDocument.id }),
      "documents.info archived",
    );
    assert.equal(archived.id, workflowDocument.id, "archived document was deleted or replaced");
    assert.equal(archived.title, workflowDocument.title);
    const archivedAt = archived.archivedAt;
    assert.ok(typeof archivedAt === "string", "dropped document must have archivedAt set");
    assert.ok(archivedAt.length > 0, "dropped document archivedAt must be non-empty");
  });
});
