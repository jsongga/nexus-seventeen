import { withSourceBanner } from "./banner.js";
import { OutlineHttpError } from "./client.js";
import type { DocsPublishRepo } from "./config.js";
import { enumerateDocs } from "./enumerate.js";
import type { DocsSink, SinkCollection, SinkDocument } from "./sink.js";
import { defaultGitRunner, runGit, type GitTextRunner } from "../shared/git.js";

export interface PublishReport {
  readonly repo: string;
  readonly created: number;
  readonly updated: number;
  readonly archived: number;
  readonly unchanged: number;
  readonly failures: readonly string[];
}

const SOURCE_BANNER_PATTERN = /^> \*\*Read-only mirror\.\*\* Source: `.*? @ blob ([0-9a-f]{12})\./su;

function errorDetail(error: unknown): string {
  if (error instanceof OutlineHttpError && error.code !== undefined) {
    return `HTTP ${error.status} ${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function report(
  repo: string,
  created: number,
  updated: number,
  archived: number,
  unchanged: number,
  failures: readonly string[]
): PublishReport {
  return Object.freeze({
    repo,
    created,
    updated,
    archived,
    unchanged,
    failures: Object.freeze([...failures]),
  });
}

async function collectionState(
  entry: DocsPublishRepo,
  sink: DocsSink
): Promise<Readonly<{ collection: SinkCollection; documents: readonly SinkDocument[] }>> {
  const collection = await sink.ensureCollection(entry.name);
  return Object.freeze({ collection, documents: await sink.listDocuments(collection) });
}

function sourceBlobPrefix(text: string): string | undefined {
  return SOURCE_BANNER_PATTERN.exec(text)?.[1];
}

export async function publishRepo(
  entry: DocsPublishRepo,
  sink: DocsSink,
  runner: GitTextRunner = defaultGitRunner
): Promise<PublishReport> {
  let sources: ReturnType<typeof enumerateDocs>;
  try {
    const resolvedSha = runGit(runner, entry.path, ["rev-parse", entry.ref]).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(resolvedSha)) {
      throw new Error(`git returned an invalid full SHA for ${entry.ref}`);
    }
    sources = enumerateDocs(entry.path, resolvedSha, { exclude: entry.exclude }, runner);
  } catch (error) {
    return report(entry.name, 0, 0, 0, 0, [`enumerate: ${errorDetail(error)}`]);
  }

  let state: Awaited<ReturnType<typeof collectionState>>;
  try {
    state = await collectionState(entry, sink);
  } catch (error) {
    return report(entry.name, 0, 0, 0, 0, [`prepare collection: ${errorDetail(error)}`]);
  }

  const desired = new Map(
    sources.map((source) => [
      source.title,
      Object.freeze({
        blobPrefix: source.blobSha.slice(0, 12),
        text: withSourceBanner(source, entry.name),
      }),
    ])
  );
  const existing = new Map(state.documents.map((document) => [document.title, document]));
  const failures: string[] = [];
  let created = 0;
  let updated = 0;
  let archived = 0;
  let unchanged = 0;

  for (const [title, desiredDocument] of desired) {
    const document = existing.get(title);
    if (document === undefined) {
      try {
        await sink.createDocument(state.collection, title, desiredDocument.text);
        created += 1;
      } catch (error) {
        failures.push(`create ${title}: ${errorDetail(error)}`);
      }
      continue;
    }
    if (sourceBlobPrefix(document.text) === desiredDocument.blobPrefix) {
      unchanged += 1;
      continue;
    }
    try {
      await sink.updateDocument(document.id, title, desiredDocument.text);
      updated += 1;
    } catch (error) {
      failures.push(`update ${title}: ${errorDetail(error)}`);
    }
  }

  for (const document of state.documents) {
    if (desired.has(document.title)) continue;
    try {
      await sink.archiveDocument(document.id);
      archived += 1;
    } catch (error) {
      failures.push(`archive ${document.title}: ${errorDetail(error)}`);
    }
  }

  return report(entry.name, created, updated, archived, unchanged, failures);
}
