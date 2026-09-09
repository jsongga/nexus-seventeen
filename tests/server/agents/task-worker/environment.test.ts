import assert from "node:assert/strict";
import test from "node:test";
import { taskWorkerRuntimeFromEnvironment } from "#server/agents/task-worker/environment";

test("uses STEWARD_TASK_WORKER_RUNTIME without a warning", () => {
  const warnings: string[] = [];

  assert.equal(
    taskWorkerRuntimeFromEnvironment({ STEWARD_TASK_WORKER_RUNTIME: "codex" }, (message) => warnings.push(message)),
    "codex"
  );
  assert.deepEqual(warnings, []);
});

test("accepts STEWARD_TASK_WORKER_PROVIDER for one version and names its replacement", () => {
  const warnings: string[] = [];

  assert.equal(
    taskWorkerRuntimeFromEnvironment({ STEWARD_TASK_WORKER_PROVIDER: "claude" }, (message) => warnings.push(message)),
    "claude"
  );
  assert.deepEqual(warnings, ["STEWARD_TASK_WORKER_PROVIDER is deprecated; use STEWARD_TASK_WORKER_RUNTIME"]);
});

test("rejects old and new runtime environment variables together", () => {
  assert.throws(
    () =>
      taskWorkerRuntimeFromEnvironment({
        STEWARD_TASK_WORKER_RUNTIME: "codex",
        STEWARD_TASK_WORKER_PROVIDER: "codex",
      }),
    /STEWARD_TASK_WORKER_PROVIDER.*STEWARD_TASK_WORKER_RUNTIME.*cannot both be set/u
  );
});

test("requires a non-empty runtime environment variable", () => {
  assert.throws(() => taskWorkerRuntimeFromEnvironment({}), /STEWARD_TASK_WORKER_RUNTIME is required/u);
  assert.throws(
    () => taskWorkerRuntimeFromEnvironment({ STEWARD_TASK_WORKER_RUNTIME: "" }),
    /STEWARD_TASK_WORKER_RUNTIME is required/u
  );
  assert.throws(
    () => taskWorkerRuntimeFromEnvironment({ STEWARD_TASK_WORKER_PROVIDER: "" }),
    /STEWARD_TASK_WORKER_RUNTIME is required/u
  );
});
