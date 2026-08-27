import { withSourceBanner } from "./banner.js";
import type { DocsPublishRepo } from "./config.js";
import { enumerateDocs } from "./enumerate.js";
import type { DocsSink, SinkCollection, SinkDocument } from "./sink.js";
import {
  runDeclaredScopeGit,
  type GitRunner,
} from "../task-board/collaborators/scope-check.js";

export interface PublishReport { readonly repo: string; readonly created: number; readonly updated: number; readonly archived: number; readonly unchanged: number; readonly failures: readonly string[] }

function git(runner: GitRunner, repoPath: string, arguments_: readonly string[]): string {
  return runner([
    "-c", "core.fsmonitor=",
    "-c", "core.hooksPath=",
    "-C", repoPath,
    ...arguments_,
  ]);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function report(
  repo: string,
  created: number,
  updated: number,
  archived: number,
  unchanged: number,
  failures: readonly string[],
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
  sink: DocsSink,
): Promise<Readonly<{ collection: SinkCollection; documents: readonly SinkDocument[] }>> {
  const collection = await sink.ensureCollection(entry.name);
  return Object.freeze({ collection, documents: await sink.listDocuments(collection) });
}

export async function publishRepo(
  entry: DocsPublishRepo,
  sink: DocsSink,
  runner: GitRunner = runDeclaredScopeGit,
): Promise<PublishReport> {
  const resolvedSha = git(runner, entry.path, ["rev-parse", entry.ref]).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(resolvedSha)) {
    throw new Error(`git returned an invalid full SHA for ${entry.ref}`);
  }
  const sources = enumerateDocs(entry.path, resolvedSha, { exclude: entry.exclude }, runner);
  const shortSha = resolvedSha.slice(0, 7);

  let state: Awaited<ReturnType<typeof collectionState>>;
  try {
    state = await collectionState(entry, sink);
  } catch (error) {
    return report(entry.name, 0, 0, 0, 0, [`prepare collection: ${errorDetail(error)}`]);
  }

  const desired = new Map(sources.map((source) => [
    source.title,
    withSourceBanner(source, entry.name, shortSha),
  ]));
  const existing = new Map(state.documents.map((document) => [document.title, document]));
  const failures: string[] = [];
  let created = 0;
  let updated = 0;
  let archived = 0;
  let unchanged = 0;

  for (const [title, text] of desired) {
    const document = existing.get(title);
    if (document === undefined) {
      try {
        await sink.createDocument(state.collection, title, text);
        created += 1;
      } catch (error) {
        failures.push(`create ${title}: ${errorDetail(error)}`);
      }
      continue;
    }
    if (document.text === text) {
      unchanged += 1;
      continue;
    }
    try {
      await sink.updateDocument(document.id, title, text);
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
