import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TaskBoardStore } from '../../build/server/task-board/persistence/store.js';
import { readDocuments } from '../../scripts/export-documents.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../..');
const exportScript = resolve(repositoryRoot, 'scripts/export-documents.mjs');

// Deliberately frozen from the v24 store's DOCUMENT_SCHEMA. The exporter targets
// historical databases, so this fixture must survive removal from the live schema.
const FROZEN_V24_DOCUMENT_SCHEMA = `
CREATE TABLE documents (
  document_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type = 'text/markdown'),
  content TEXT NOT NULL,
  content_version INTEGER NOT NULL CHECK (content_version >= 1),
  pen_epoch INTEGER NOT NULL CHECK (pen_epoch >= 1),
  pen_holder_actor_type TEXT CHECK (pen_holder_actor_type IS NULL OR pen_holder_actor_type IN ('human', 'agent')),
  pen_holder_actor_id TEXT,
  pen_holder_client_id TEXT,
  pen_acquired_at TEXT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (pen_holder_actor_type IS NULL AND pen_holder_actor_id IS NULL AND pen_holder_client_id IS NULL AND pen_acquired_at IS NULL) OR
    (pen_holder_actor_type IS NOT NULL AND pen_holder_actor_id IS NOT NULL AND pen_holder_client_id IS NOT NULL AND pen_acquired_at IS NOT NULL)
  )
) STRICT;
CREATE INDEX documents_project ON documents(project_id, updated_at DESC, document_id);

CREATE TABLE document_events (
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('document_created', 'document_pen_acquired', 'document_pen_released', 'document_updated')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent')),
  actor_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  document_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(document_id, sequence)
) STRICT, WITHOUT ROWID;
CREATE INDEX document_events_project ON document_events(project_id, created_at DESC, document_id, sequence);
`;

const project = {
  project_id: 'project-1',
  name: 'Alpha / Project',
  description: 'Export fixture',
  version: 1,
  created_at: '2026-08-25T12:00:00.000Z',
  updated_at: '2026-08-25T12:00:00.000Z',
};

const documents = [
  {
    document_id: 'document-1',
    project_id: project.project_id,
    title: 'Launch Plan',
    content_type: 'text/markdown',
    content: '# Launch\n\nFirst line.\nLast line.\n',
    content_version: 3,
    pen_epoch: 2,
    pen_holder_actor_type: null,
    pen_holder_actor_id: null,
    pen_holder_client_id: null,
    pen_acquired_at: null,
    sequence: 3,
    created_at: '2026-08-25T12:01:00.000Z',
    updated_at: '2026-08-25T12:03:00.000Z',
  },
  {
    document_id: 'document-2',
    project_id: project.project_id,
    title: 'Launch---Plan',
    content_type: 'text/markdown',
    content: 'Collision content',
    content_version: 1,
    pen_epoch: 1,
    pen_holder_actor_type: null,
    pen_holder_actor_id: null,
    pen_holder_client_id: null,
    pen_acquired_at: null,
    sequence: 1,
    created_at: '2026-08-25T12:04:00.000Z',
    updated_at: '2026-08-25T12:04:00.000Z',
  },
];

const documentEvents = [
  {
    document_id: 'document-1',
    sequence: 1,
    event_id: 'event-1',
    project_id: project.project_id,
    event_type: 'document_created',
    actor_type: 'human',
    actor_id: 'human-1',
    client_id: 'client-1',
    document_json: '{"contentVersion":1}',
    created_at: '2026-08-25T12:01:00.000Z',
  },
  {
    document_id: 'document-1',
    sequence: 2,
    event_id: 'event-2',
    project_id: project.project_id,
    event_type: 'document_pen_acquired',
    actor_type: 'agent',
    actor_id: 'agent-1',
    client_id: 'client-2',
    document_json: '{"contentVersion":1,"penEpoch":2}',
    created_at: '2026-08-25T12:02:00.000Z',
  },
  {
    document_id: 'document-1',
    sequence: 3,
    event_id: 'event-3',
    project_id: project.project_id,
    event_type: 'document_updated',
    actor_type: 'agent',
    actor_id: 'agent-1',
    client_id: 'client-2',
    document_json: '{"contentVersion":3,"penEpoch":2}',
    created_at: '2026-08-25T12:03:00.000Z',
  },
];

function tableExists(database, table) {
  return database.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(table) !== undefined;
}

async function createBaseDatabase(databasePath) {
  const store = await TaskBoardStore.open(databasePath);
  store.close();
}

async function createHistoricalDatabase(databasePath) {
  await createBaseDatabase(databasePath);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON');
    if (!tableExists(database, 'documents')) {
      database.exec(FROZEN_V24_DOCUMENT_SCHEMA);
    }
  } finally {
    database.close();
  }
}

async function createHistoricalFixture(databasePath) {
  await createHistoricalDatabase(databasePath);
  await insertHistoricalRows(databasePath, [project], documents, [...documentEvents].reverse());
}

async function insertHistoricalRows(databasePath, projects, documentsToInsert, events = []) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON');
    const insertProject = database.prepare(`
      INSERT INTO projects(project_id, name, description, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const projectToInsert of projects) {
      insertProject.run(...Object.values(projectToInsert));
    }

    const insertDocument = database.prepare(`
      INSERT INTO documents(
        document_id, project_id, title, content_type, content, content_version,
        pen_epoch, pen_holder_actor_type, pen_holder_actor_id,
        pen_holder_client_id, pen_acquired_at, sequence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const document of documentsToInsert) {
      insertDocument.run(...Object.values(document));
    }

    const insertEvent = database.prepare(`
      INSERT INTO document_events(
        document_id, sequence, event_id, project_id, event_type, actor_type,
        actor_id, client_id, document_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const event of events) {
      insertEvent.run(...Object.values(event));
    }
  } finally {
    database.close();
  }
}

async function createPostDropDatabase(databasePath) {
  await createBaseDatabase(databasePath);
  const database = new DatabaseSync(databasePath);
  try {
    if (tableExists(database, 'document_events')) {
      database.exec('DROP TABLE document_events');
    }
    if (tableExists(database, 'documents')) {
      database.exec('DROP TABLE documents');
    }
    database.exec('PRAGMA user_version = 25');
  } finally {
    database.close();
  }
}

async function makeTestDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-export-documents-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

function runExport(databasePath, outputDirectory) {
  return spawnSync(process.execPath, [exportScript, databasePath, outputDirectory], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    timeout: 10_000,
  });
}

function assertSuccessful(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
}

function assertOneLineFailure(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^export-documents: [^\r\n]+\n$/u);
}

function exportedAtFrom(markdown) {
  const match = markdown.match(/\nexportedAt: ([^\r\n]+)\n/u);
  assert.notEqual(match, null);
  assert.equal(new Date(match[1]).toISOString(), match[1]);
  return match[1];
}

function expectedMarkdown(document, exportedAt) {
  return `---
title: ${document.title}
project: ${project.name} (${project.project_id})
documentId: ${document.document_id}
contentVersion: ${document.content_version}
updatedAt: ${document.updated_at}
exportedAt: ${exportedAt}
---

${document.content}`;
}

test('reads documents and every event query inside one explicit snapshot', () => {
  const operations = [];
  const documentRows = [
    { document_id: 'snapshot-document-1' },
    { document_id: 'snapshot-document-2' },
  ];

  class RecordingDatabase {
    constructor(databasePath, options) {
      assert.equal(databasePath, '/recording.sqlite');
      assert.deepEqual(options, { readOnly: true });
      operations.push('OPEN READ ONLY');
    }

    exec(statement) {
      operations.push(statement);
    }

    prepare(statement) {
      if (statement.includes('FROM sqlite_schema')) {
        return {
          get(table) {
            operations.push(`READ TABLE ${table}`);
            return { exists: 1 };
          },
        };
      }
      if (statement.includes('FROM documents')) {
        return {
          all() {
            operations.push('READ DOCUMENTS');
            return documentRows;
          },
        };
      }
      if (statement.includes('FROM document_events')) {
        return {
          all(documentId) {
            operations.push(`READ EVENTS ${documentId}`);
            return [{ document_id: documentId, sequence: 1 }];
          },
        };
      }
      throw new Error(`unexpected statement: ${statement}`);
    }

    close() {
      operations.push('CLOSE');
    }
  }

  const snapshot = readDocuments('/recording.sqlite', RecordingDatabase);

  assert.deepEqual(snapshot, documentRows.map((document) => ({
    ...document,
    events: [{ document_id: document.document_id, sequence: 1 }],
  })));
  assert.deepEqual(operations, [
    'OPEN READ ONLY',
    'BEGIN',
    'READ TABLE documents',
    'READ TABLE document_events',
    'READ DOCUMENTS',
    'READ EVENTS snapshot-document-1',
    'READ EVENTS snapshot-document-2',
    'COMMIT',
    'CLOSE',
  ]);
});

test('exports markdown and ordered event history with collision-safe slugs', async (t) => {
  const directory = await makeTestDirectory(t);
  const databasePath = join(directory, 'board.sqlite');
  const outputDirectory = join(directory, 'export');
  await createHistoricalFixture(databasePath);

  const result = runExport(databasePath, outputDirectory);

  assertSuccessful(result);
  assert.deepEqual(await readdir(outputDirectory), ['alpha-project']);
  const projectDirectory = join(outputDirectory, 'alpha-project');
  assert.deepEqual((await readdir(projectDirectory)).sort(), [
    'launch-plan-2.events.jsonl',
    'launch-plan-2.md',
    'launch-plan.events.jsonl',
    'launch-plan.md',
  ]);
  assert.equal((await stat(outputDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(projectDirectory)).mode & 0o777, 0o700);

  const firstMarkdown = await readFile(join(projectDirectory, 'launch-plan.md'), 'utf8');
  const exportedAt = exportedAtFrom(firstMarkdown);
  assert.equal(firstMarkdown, expectedMarkdown(documents[0], exportedAt));
  const secondMarkdown = await readFile(join(projectDirectory, 'launch-plan-2.md'), 'utf8');
  assert.equal(exportedAtFrom(secondMarkdown), exportedAt);
  assert.equal(secondMarkdown, expectedMarkdown(documents[1], exportedAt));

  assert.equal(
    await readFile(join(projectDirectory, 'launch-plan.events.jsonl'), 'utf8'),
    `${documentEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
  assert.equal(
    await readFile(join(projectDirectory, 'launch-plan-2.events.jsonl'), 'utf8'),
    '',
  );
});

test('exports an empty historical database to an empty directory', async (t) => {
  const directory = await makeTestDirectory(t);
  const databasePath = join(directory, 'board.sqlite');
  const outputDirectory = join(directory, 'export');
  await createHistoricalDatabase(databasePath);

  const result = runExport(databasePath, outputDirectory);

  assertSuccessful(result);
  assert.deepEqual(await readdir(outputDirectory), []);
  assert.equal((await stat(outputDirectory)).mode & 0o777, 0o700);
});

test('rejects a post-drop database without document tables', async (t) => {
  const directory = await makeTestDirectory(t);
  const databasePath = join(directory, 'board.sqlite');
  const outputDirectory = join(directory, 'export');
  await createPostDropDatabase(databasePath);

  const result = runExport(databasePath, outputDirectory);

  assertOneLineFailure(result);
  assert.equal(
    result.stderr,
    'export-documents: database does not contain the documents table\n',
  );
  await assert.rejects(stat(outputDirectory), { code: 'ENOENT' });
});

test('rejects missing and invalid databases with one-line errors', async (t) => {
  const directory = await makeTestDirectory(t);
  const missingPath = join(directory, 'missing.sqlite');
  const invalidPath = join(directory, 'invalid.sqlite');
  await writeFile(invalidPath, 'not a sqlite database');

  assertOneLineFailure(runExport(missingPath, join(directory, 'missing-export')));
  assertOneLineFailure(runExport(invalidPath, join(directory, 'invalid-export')));
});

test('refuses to overwrite a non-empty output directory', async (t) => {
  const directory = await makeTestDirectory(t);
  const databasePath = join(directory, 'board.sqlite');
  const outputDirectory = join(directory, 'export');
  await createHistoricalFixture(databasePath);
  await mkdir(outputDirectory, { mode: 0o700 });
  await writeFile(join(outputDirectory, 'keep.txt'), 'keep');

  const result = runExport(databasePath, outputDirectory);

  assertOneLineFailure(result);
  assert.equal(result.stderr, 'export-documents: output directory exists and is not empty\n');
  assert.deepEqual(await readdir(outputDirectory), ['keep.txt']);
  assert.equal(await readFile(join(outputDirectory, 'keep.txt'), 'utf8'), 'keep');
});

test('falls back and uniques slugs for non-ASCII project and document names', async (t) => {
  const directory = await makeTestDirectory(t);
  const databasePath = join(directory, 'board.sqlite');
  const outputDirectory = join(directory, 'export');
  const nonAsciiProject = { ...project, project_id: 'project-non-ascii', name: '项目' };
  const nonAsciiDocuments = [
    {
      ...documents[1],
      document_id: 'document-non-ascii-1',
      project_id: nonAsciiProject.project_id,
      title: '计划',
    },
    {
      ...documents[1],
      document_id: 'document-non-ascii-2',
      project_id: nonAsciiProject.project_id,
      title: '说明',
    },
  ];
  await createHistoricalDatabase(databasePath);
  await insertHistoricalRows(databasePath, [nonAsciiProject], nonAsciiDocuments);

  const result = runExport(databasePath, outputDirectory);

  assertSuccessful(result);
  assert.deepEqual(await readdir(outputDirectory), ['project']);
  assert.deepEqual((await readdir(join(outputDirectory, 'project'))).sort(), [
    'document-2.events.jsonl',
    'document-2.md',
    'document.events.jsonl',
    'document.md',
  ]);
});

test('keeps two identical 240-character title filenames distinct and within 255 bytes', async (t) => {
  const directory = await makeTestDirectory(t);
  const databasePath = join(directory, 'board.sqlite');
  const outputDirectory = join(directory, 'export');
  const longTitle = 'a'.repeat(240);
  const longProject = { ...project, project_id: 'project-long', name: 'Long project' };
  const longDocuments = [1, 2].map((number) => ({
    ...documents[1],
    document_id: `document-long-${number}`,
    project_id: longProject.project_id,
    title: longTitle,
  }));
  await createHistoricalDatabase(databasePath);
  await insertHistoricalRows(databasePath, [longProject], longDocuments);

  const result = runExport(databasePath, outputDirectory);

  assertSuccessful(result);
  const filenames = (await readdir(join(outputDirectory, 'long-project'))).sort();
  assert.deepEqual(filenames, [
    `${longTitle}-2.events.jsonl`,
    `${longTitle}-2.md`,
    `${longTitle}.events.jsonl`,
    `${longTitle}.md`,
  ]);
  assert.ok(filenames.every((filename) => Buffer.byteLength(filename) <= 255));
});

test('reserves space for a multi-digit collision suffix before uniquing long slugs', async (t) => {
  const directory = await makeTestDirectory(t);
  const databasePath = join(directory, 'board.sqlite');
  const outputDirectory = join(directory, 'export');
  const longTitle = 'b'.repeat(240);
  const truncatedTitle = longTitle.slice(0, 239);
  const longProject = { ...project, project_id: 'project-many-long', name: 'Many long titles' };
  const longDocuments = Array.from({ length: 10 }, (_, index) => ({
    ...documents[1],
    document_id: `document-many-long-${index + 1}`,
    project_id: longProject.project_id,
    title: longTitle,
  }));
  await createHistoricalDatabase(databasePath);
  await insertHistoricalRows(databasePath, [longProject], longDocuments);

  const result = runExport(databasePath, outputDirectory);

  assertSuccessful(result);
  const filenames = await readdir(join(outputDirectory, 'many-long-titles'));
  assert.equal(filenames.length, 20);
  assert.ok(filenames.includes(`${truncatedTitle}.events.jsonl`));
  assert.ok(filenames.includes(`${truncatedTitle}-10.events.jsonl`));
  assert.ok(filenames.every((filename) => Buffer.byteLength(filename) <= 255));
});
