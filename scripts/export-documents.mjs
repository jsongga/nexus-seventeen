import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

class ExportDocumentsError extends Error {}

const MAX_FILENAME_BYTES = 255;
const EVENTS_EXTENSION = '.events.jsonl';

function slug(value, fallback) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return normalized === '' ? fallback : normalized;
}

function uniqueSlug(base, used) {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function tableExists(database, table) {
  return database.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(table) !== undefined;
}

function readDocumentSnapshot(database) {
  database.exec('BEGIN');
  try {
    if (!tableExists(database, 'documents')) {
      throw new ExportDocumentsError('database does not contain the documents table');
    }
    if (!tableExists(database, 'document_events')) {
      throw new ExportDocumentsError('database does not contain the document_events table');
    }

    const documents = database.prepare(`
      SELECT
        documents.document_id,
        documents.project_id,
        documents.title,
        documents.content,
        documents.content_version,
        documents.updated_at,
        projects.name AS project_name
      FROM documents
      INNER JOIN projects ON projects.project_id = documents.project_id
      ORDER BY
        projects.name COLLATE BINARY,
        documents.project_id,
        documents.title COLLATE BINARY,
        documents.document_id
    `).all();
    const selectEvents = database.prepare(`
      SELECT *
      FROM document_events
      WHERE document_id = ?
      ORDER BY sequence
    `);
    const snapshot = documents.map((document) => ({
      ...document,
      events: selectEvents.all(document.document_id),
    }));

    database.exec('COMMIT');
    return snapshot;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the read or commit error that made the snapshot fail.
    }
    throw error;
  }
}

export function readDocuments(databasePath, Database = DatabaseSync) {
  let database;
  try {
    database = new Database(databasePath, { readOnly: true });
    return readDocumentSnapshot(database);
  } catch (error) {
    if (error instanceof ExportDocumentsError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ExportDocumentsError(`database could not be read: ${message}`);
  } finally {
    database?.close();
  }
}

async function prepareOutputDirectory(outputDirectory) {
  try {
    const outputStat = await lstat(outputDirectory);
    if (!outputStat.isDirectory()) {
      throw new ExportDocumentsError('output path exists and is not a directory');
    }
    if ((await readdir(outputDirectory)).length > 0) {
      throw new ExportDocumentsError('output directory exists and is not empty');
    }
  } catch (error) {
    if (error instanceof ExportDocumentsError) throw error;
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(outputDirectory, { mode: 0o700, recursive: true });
  }
}

function markdownFor(document, exportedAt) {
  return `---
title: ${document.title}
project: ${document.project_name} (${document.project_id})
documentId: ${document.document_id}
contentVersion: ${document.content_version}
updatedAt: ${document.updated_at}
exportedAt: ${exportedAt}
---

${document.content}`;
}

function jsonLines(events) {
  if (events.length === 0) return '';
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function documentCountsByProject(documents) {
  const counts = new Map();
  for (const document of documents) {
    counts.set(document.project_id, (counts.get(document.project_id) ?? 0) + 1);
  }
  return counts;
}

function maximumDocumentSlugBytes(documentCount) {
  const longestSuffix = documentCount > 1 ? `-${documentCount}` : '';
  return MAX_FILENAME_BYTES - Buffer.byteLength(longestSuffix) - Buffer.byteLength(EVENTS_EXTENSION);
}

async function exportDocuments(databasePath, outputDirectory) {
  const documents = readDocuments(databasePath);
  await prepareOutputDirectory(outputDirectory);

  const exportedAt = new Date().toISOString();
  const projectDocumentCounts = documentCountsByProject(documents);
  const usedProjectSlugs = new Set();
  const projects = new Map();

  for (const document of documents) {
    let projectState = projects.get(document.project_id);
    if (projectState === undefined) {
      const projectSlug = uniqueSlug(slug(document.project_name, 'project'), usedProjectSlugs);
      const directory = join(outputDirectory, projectSlug);
      await mkdir(directory, { mode: 0o700, recursive: true });
      projectState = {
        directory,
        maximumDocumentSlugBytes: maximumDocumentSlugBytes(
          projectDocumentCounts.get(document.project_id),
        ),
        usedDocumentSlugs: new Set(),
      };
      projects.set(document.project_id, projectState);
    }

    const baseDocumentSlug = slug(document.title, 'document')
      .slice(0, projectState.maximumDocumentSlugBytes);
    const documentSlug = uniqueSlug(baseDocumentSlug, projectState.usedDocumentSlugs);
    const markdownPath = join(projectState.directory, `${documentSlug}.md`);
    const eventsPath = join(projectState.directory, `${documentSlug}${EVENTS_EXTENSION}`);
    await writeFile(markdownPath, markdownFor(document, exportedAt), { flag: 'wx', mode: 0o600 });
    await writeFile(eventsPath, jsonLines(document.events), { flag: 'wx', mode: 0o600 });
  }
}

async function runCli(arguments_) {
  const [databasePath, outputDirectory, ...extraArguments] = arguments_;
  try {
    if (databasePath === undefined || outputDirectory === undefined || extraArguments.length > 0) {
      throw new ExportDocumentsError(
        'usage: node scripts/export-documents.mjs <sqlite-path> <out-dir>',
      );
    }
    await exportDocuments(databasePath, outputDirectory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const oneLineMessage = message.replace(/[\r\n]+/gu, ' ');
    process.stderr.write(`export-documents: ${oneLineMessage}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli(process.argv.slice(2));
}
