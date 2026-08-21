import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskBoardConfig } from "#server/task-board";
import { TaskBoardError } from "#server/task-board/errors";
import { databasePath, HUMAN_TOKEN } from "./helpers.js";

function isInvalidConfiguration(error: unknown): boolean {
  return error instanceof TaskBoardError
    && error.status === 500
    && error.code === "INVALID_CONFIGURATION";
}

test("stage and task cap configuration defaults, disables at zero, and accepts the non-zero floor", async () => {
  const path = await databasePath();
  const defaults = normalizeTaskBoardConfig({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
  });
  assert.equal(defaults.stageCapSeconds, 3_600);
  assert.equal(defaults.taskCapSeconds, 10_800);

  const disabled = normalizeTaskBoardConfig({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    stageCapSeconds: 0,
    taskCapSeconds: 0,
  });
  assert.equal(disabled.stageCapSeconds, 0);
  assert.equal(disabled.taskCapSeconds, 0);

  const minimums = normalizeTaskBoardConfig({
    dbPath: path,
    humanToken: HUMAN_TOKEN,
    humanPrincipal: "human:alice",
    stageCapSeconds: 60,
    taskCapSeconds: 60,
  });
  assert.equal(minimums.stageCapSeconds, 60);
  assert.equal(minimums.taskCapSeconds, 60);
});

test("stage and task caps reject unsafe values and enforce enabled-cap ordering", async () => {
  const path = await databasePath();
  const config = (caps: Readonly<{ stageCapSeconds?: number; taskCapSeconds?: number }>) =>
    normalizeTaskBoardConfig({
      dbPath: path,
      humanToken: HUMAN_TOKEN,
      humanPrincipal: "human:alice",
      ...caps,
    });

  for (const caps of [
    { stageCapSeconds: -1 },
    { stageCapSeconds: 59 },
    { stageCapSeconds: 60.5 },
    { stageCapSeconds: Number.MAX_SAFE_INTEGER },
    { taskCapSeconds: -1 },
    { taskCapSeconds: 59 },
    { taskCapSeconds: 60.5 },
    { taskCapSeconds: Number.MAX_SAFE_INTEGER },
    { stageCapSeconds: 121, taskCapSeconds: 120 },
  ]) assert.throws(() => config(caps), isInvalidConfiguration);

  assert.equal(config({ stageCapSeconds: 120, taskCapSeconds: 0 }).taskCapSeconds, 0);
  assert.equal(config({ stageCapSeconds: 0, taskCapSeconds: 60 }).stageCapSeconds, 0);
});
