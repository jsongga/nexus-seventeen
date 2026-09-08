/** Verifies transactional project and repository writers. */

/* —— Imports —— */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TaskBoard } from "#server/task-board";
import { TaskBoardError } from "#server/task-board/errors";
import { config, databasePath } from "../helpers.js";

const NOW = "2026-09-06T16:00:00.000Z";

function repositoryRows(path: string, projectId?: string): readonly Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows =
      projectId === undefined
        ? db.prepare("SELECT * FROM repositories ORDER BY repository_id").all()
        : db.prepare("SELECT * FROM repositories WHERE project_id=? ORDER BY repository_id").all(projectId);
    return rows.map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

test("createProject writes one primary and updateProject moves that same repository", async () => {
  const path = await databasePath();
  const board = await TaskBoard.open(config(path, () => new Date(NOW)));
  try {
    const legacy = board.createProject({
      name: "Legacy path shim",
      description: "The description remains the repository path.",
    });
    assert.deepEqual(
      repositoryRows(path, legacy.projectId).map((row) => ({
        projectId: row.project_id,
        name: row.name,
        path: row.path,
        isPrimary: row.is_primary,
        version: row.version,
      })),
      [
        {
          projectId: legacy.projectId,
          name: "Legacy path shim",
          path: "The description remains the repository path.",
          isPrimary: 1,
          version: 1,
        },
      ]
    );

    const project = board.createProject({
      name: "Provider API",
      description: "Owns the provider interface.",
      repoPath: "/repos/provider-api",
    });
    assert.equal(repositoryRows(path, project.projectId).length, 1);

    const updated = board.updateProject(project.projectId, { repoPath: "/repos/provider-api-next" });
    assert.equal(updated.repoPath, "/repos/provider-api-next");
    const rows = repositoryRows(path, project.projectId);
    assert.equal(rows.length, 1);
    assert.equal(rows.filter((row) => row.is_primary === 1).length, 1);
    assert.equal(rows[0]?.path, "/repos/provider-api-next");
    assert.equal(rows[0]?.version, 2);
  } finally {
    board.close();
  }
});

test("a failing repository write rolls the project back with it", async () => {
  const path = await databasePath();
  const board = await TaskBoard.open(config(path, () => new Date(NOW)));
  try {
    // Injected rather than contrived: the point of the dual-write is that both
    // rows land or neither does, and without a forced failure nothing here would
    // fail if the repository INSERT were moved outside store.transaction().
    const injector = new DatabaseSync(path);
    try {
      injector.exec(`
        CREATE TRIGGER reject_repository_insert BEFORE INSERT ON repositories
        BEGIN SELECT RAISE(ABORT, 'injected repository failure'); END;
      `);
    } finally {
      injector.close();
    }

    assert.throws(() => board.createProject({ name: "Rolled back", description: "/repos/rolled-back" }));

    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      const projects = reader.prepare("SELECT project_id FROM projects WHERE name=?").all("Rolled back");
      assert.deepEqual(projects, [], "the project must not survive a failed repository write");
      assert.deepEqual(reader.prepare("SELECT repository_id FROM repositories").all(), []);
    } finally {
      reader.close();
    }
  } finally {
    board.close();
  }
});

test("addRepository adds a secondary without changing the primary mirror", async () => {
  const path = await databasePath();
  const board = await TaskBoard.open(config(path, () => new Date(NOW)));
  try {
    const project = board.createProject({
      name: "Catalog",
      description: "Owns the catalog repositories.",
      repoPath: "/repos/catalog-api",
    });
    const repository = board.addRepository(project.projectId, {
      name: "Catalog worker",
      path: "/repos/catalog-worker",
    });

    assert.deepEqual(
      {
        projectId: repository.projectId,
        name: repository.name,
        path: repository.path,
        isPrimary: repository.isPrimary,
        version: repository.version,
      },
      {
        projectId: project.projectId,
        name: "Catalog worker",
        path: "/repos/catalog-worker",
        isPrimary: false,
        version: 1,
      }
    );
    const rows = repositoryRows(path, project.projectId);
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.is_primary === 1).length, 1);
    assert.equal(rows.find((row) => row.is_primary === 1)?.path, project.repoPath);
    assert.equal(
      board.listProjects().find((candidate) => candidate.projectId === project.projectId)?.repoPath,
      project.repoPath
    );
  } finally {
    board.close();
  }
});

test("updateRepository renames, re-points the primary mirror, and rejects stale versions", async () => {
  const path = await databasePath();
  const board = await TaskBoard.open(config(path, () => new Date(NOW)));
  try {
    const project = board.createProject({
      name: "Catalog",
      description: "Owns the catalog repositories.",
      repoPath: "/repos/catalog-api",
    });
    const primary = board.listRepositories(project.projectId)[0]!;
    const secondary = board.addRepository(project.projectId, {
      name: "Catalog worker old",
      path: "/repos/catalog-worker",
    });

    const renamed = board.updateRepository(secondary.repositoryId, {
      version: secondary.version,
      name: "Catalog worker",
    });
    assert.equal(renamed.name, "Catalog worker");
    assert.equal(renamed.path, secondary.path);
    assert.equal(renamed.version, secondary.version + 1);

    const repointed = board.updateRepository(primary.repositoryId, {
      version: primary.version,
      path: "/repos/catalog-api-next",
    });
    assert.equal(repointed.path, "/repos/catalog-api-next");
    assert.equal(repointed.isPrimary, true);
    assert.equal(repointed.version, primary.version + 1);
    assert.equal(board.snapshot(project.projectId).project.repoPath, repointed.path);
    assert.deepEqual(
      board.snapshot(project.projectId).repositories.map((repository) => repository.repositoryId),
      [primary.repositoryId, secondary.repositoryId]
    );

    assert.throws(
      () =>
        board.updateRepository(secondary.repositoryId, {
          version: secondary.version,
          name: "Stale worker name",
        }),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 409 && error.code === "REPOSITORY_VERSION_CONFLICT"
    );
    assert.throws(
      () => board.updateRepository("repository-does-not-exist", { version: 1, name: "Missing" }),
      (error: unknown) =>
        error instanceof TaskBoardError && error.status === 404 && error.code === "REPOSITORY_NOT_FOUND"
    );
  } finally {
    board.close();
  }
});

test("a failing addRepository event rolls the repository insert back", async () => {
  const path = await databasePath();
  const board = await TaskBoard.open(config(path, () => new Date(NOW)));
  try {
    const project = board.createProject({
      name: "Catalog",
      description: "Keeps a single primary after a failed add.",
      repoPath: "/repos/catalog-api",
    });
    const injector = new DatabaseSync(path);
    try {
      injector.exec(`
        CREATE TRIGGER reject_repository_event BEFORE INSERT ON task_events
        WHEN NEW.event_type = 'repository_added'
        BEGIN SELECT RAISE(ABORT, 'injected repository event failure'); END;
      `);
    } finally {
      injector.close();
    }

    assert.throws(() =>
      board.addRepository(project.projectId, { name: "Catalog worker", path: "/repos/catalog-worker" })
    );
    const rows = repositoryRows(path, project.projectId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.is_primary, 1);
    assert.equal(rows[0]?.path, project.repoPath);
    assert.equal(
      board.listProjects().find((candidate) => candidate.projectId === project.projectId)?.repoPath,
      project.repoPath
    );
  } finally {
    board.close();
  }
});
