/** Proves repository checkout paths follow work-item identity and legacy fallback. */

/* —— Imports —— */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WORK_ITEM_REPOSITORY_PATH_SQL } from "#server/task-board/persistence/repository-path";

/* —— Fixture —— */

function resolutionDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL
    ) STRICT;
    CREATE TABLE repositories (
      repository_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      is_primary INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE work_items (
      work_item_id TEXT PRIMARY KEY,
      resolved_project_id TEXT NOT NULL,
      repository_id TEXT NULL
    ) STRICT;
  `);
  return db;
}

function resolvedPaths(db: DatabaseSync): readonly Record<string, unknown>[] {
  return db
    .prepare(
      `
        SELECT work_item.work_item_id,${WORK_ITEM_REPOSITORY_PATH_SQL} AS repository_path
        FROM work_items work_item
        ORDER BY work_item.work_item_id
      `
    )
    .all()
    .map((row) => ({ ...row }));
}

/* —— Resolution —— */

test("an explicit repository wins while a sibling resolves to the project primary", () => {
  const db = resolutionDatabase();
  try {
    db.prepare("INSERT INTO projects VALUES (?,?)").run("project-one", "/repos/legacy");
    db.prepare("INSERT INTO repositories VALUES (?,?,?,?)").run(
      "repository-primary",
      "project-one",
      "/repos/primary",
      1
    );
    db.prepare("INSERT INTO repositories VALUES (?,?,?,?)").run(
      "repository-secondary",
      "project-one",
      "/repos/secondary",
      0
    );
    db.prepare("INSERT INTO work_items VALUES (?,?,?)").run("item-explicit", "project-one", "repository-secondary");
    db.prepare("INSERT INTO work_items VALUES (?,?,?)").run("item-primary", "project-one", null);

    assert.deepEqual(resolvedPaths(db), [
      { work_item_id: "item-explicit", repository_path: "/repos/secondary" },
      { work_item_id: "item-primary", repository_path: "/repos/primary" },
    ]);
  } finally {
    db.close();
  }
});

test("a work item falls back to projects.repo_path when no primary exists", () => {
  const db = resolutionDatabase();
  try {
    db.prepare("INSERT INTO projects VALUES (?,?)").run("project-legacy", "/repos/legacy-only");
    db.prepare("INSERT INTO work_items VALUES (?,?,?)").run("item-legacy", "project-legacy", null);

    assert.deepEqual(resolvedPaths(db), [{ work_item_id: "item-legacy", repository_path: "/repos/legacy-only" }]);
  } finally {
    db.close();
  }
});
