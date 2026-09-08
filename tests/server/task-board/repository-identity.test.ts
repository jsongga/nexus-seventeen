import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ContractValidationError, TASK_BOARD_API_VERSION } from "#shared/task-board-contract";
import { parseRepositoryEntity } from "#shared/task-board-contract/validate";
import { TaskBoard } from "#server/task-board";
import { repositoryFromRow, workItemFromRow } from "#server/task-board/persistence/rows";
import { TaskBoardStore } from "#server/task-board/persistence/store";
import { config, databasePath } from "./helpers.js";

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

test("repository rows project and parse as the shared Repository entity", () => {
  const row = {
    repository_id: "repository-one",
    project_id: "project-one",
    name: "Provider API",
    path: "/repos/provider-api",
    is_primary: 1,
    version: 3,
    created_at: NOW,
    updated_at: NOW,
  };
  const expected = {
    apiVersion: TASK_BOARD_API_VERSION,
    repositoryId: "repository-one",
    projectId: "project-one",
    name: "Provider API",
    path: "/repos/provider-api",
    isPrimary: true,
    version: 3,
    createdAt: NOW,
    updatedAt: NOW,
  };

  const projected = repositoryFromRow(row);
  assert.deepEqual(projected, expected);
  assert.deepEqual(parseRepositoryEntity(projected, "repository"), expected);
  assert.throws(
    () => parseRepositoryEntity({ ...expected, isPrimary: 1 }, "repository"),
    (error: unknown) =>
      error instanceof ContractValidationError && error.message === "repository.isPrimary must be a boolean"
  );
  assert.throws(() => repositoryFromRow({ ...row, is_primary: 2 }), /TASK_BOARD_DATABASE_CORRUPT:is_primary/u);
});

test("work-item rows preserve null inheritance and explicit repository pins", () => {
  const row = {
    work_item_id: "work-item-one",
    original_request: "Update the consumer.",
    refined_objective: null,
    priority: "normal",
    task_type: "standard",
    project_target_mode: "explicit",
    target_project_id: "project-one",
    resolved_project_id: "project-one",
    repository_id: null,
    parent_work_item_id: null,
    phase: null,
    child_ordinal: null,
    planning_task_id: null,
    pipeline_branch: null,
    base_sha: null,
    state: "queued",
    current_stage: "refinement",
    created_by: "human:operator",
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ended_at: null,
    cancelled_reason: null,
    archived_at: null,
  };

  assert.equal(workItemFromRow(row).repositoryId, null);
  assert.equal(workItemFromRow({ ...row, repository_id: "repository-consumer" }).repositoryId, "repository-consumer");
});

test("opening v27 reconciles a project-only v26-era write from repo_path", async () => {
  const path = await databasePath();
  const initial = await TaskBoardStore.open(path);
  initial.close();

  const legacy = new DatabaseSync(path);
  try {
    legacy
      .prepare(
        `
        INSERT INTO projects(project_id, name, description, repo_path, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `
      )
      .run("v26-era-project", "Legacy project", "Created through the old writer.", "/repos/legacy", NOW, NOW);
    assert.equal(legacy.prepare("SELECT COUNT(*) AS count FROM repositories").get()?.count, 0);
  } finally {
    legacy.close();
  }

  const reconciled = await TaskBoardStore.open(path);
  try {
    assert.deepEqual(
      reconciled.db
        .prepare(
          `
          SELECT project_id, name, path, is_primary, version, created_at, updated_at
          FROM repositories
          WHERE project_id=?
        `
        )
        .all("v26-era-project")
        .map((row) => ({ ...row })),
      [
        {
          project_id: "v26-era-project",
          name: "Legacy project",
          path: "/repos/legacy",
          is_primary: 1,
          version: 1,
          created_at: NOW,
          updated_at: NOW,
        },
      ]
    );
  } finally {
    reconciled.close();
  }
});

test("opening an already-consistent database leaves repository rows unchanged", async () => {
  const path = await databasePath();
  const board = await TaskBoard.open(config(path, () => new Date(NOW)));
  board.createProject({
    name: "Consistent project",
    description: "The primary already exists.",
    repoPath: "/repos/consistent",
  });
  board.close();

  const before = repositoryRows(path);
  const reopened = await TaskBoardStore.open(path);
  reopened.close();
  assert.deepEqual(repositoryRows(path), before);
});

test("opening does not guess a winner for a historically drifted primary path", async () => {
  const path = await databasePath();
  const board = await TaskBoard.open(config(path, () => new Date(NOW)));
  const project = board.createProject({
    name: "Drifted project",
    description: "Preserve historical disagreement.",
    repoPath: "/repos/project-mirror",
  });
  board.close();

  const drifted = new DatabaseSync(path);
  try {
    drifted
      .prepare("UPDATE repositories SET path=? WHERE project_id=? AND is_primary=1")
      .run("/repos/historical-primary", project.projectId);
  } finally {
    drifted.close();
  }
  const before = repositoryRows(path, project.projectId);

  const reopened = await TaskBoardStore.open(path);
  try {
    assert.equal(
      reopened.db.prepare("SELECT repo_path FROM projects WHERE project_id=?").get(project.projectId)?.repo_path,
      "/repos/project-mirror"
    );
  } finally {
    reopened.close();
  }
  assert.deepEqual(repositoryRows(path, project.projectId), before);
});
