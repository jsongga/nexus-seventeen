import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TaskBoard } from "#server/task-board";
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
