import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { codexAdapter } from "../../../../src/server/agents/runtime/codex.js";
import { runtimeRegistry } from "../../../../src/server/agents/runtime/registry.js";
import { parseTaskFleetConfig } from "#server/agents/task-fleet/config";
import { TaskBoardHttpError } from "#server/agents/task-worker";
import {
  captureTaskFleetRuntimeVersion,
  classifyTaskFleetError,
  createTaskFleetWorker,
  isTransientTaskFleetError,
} from "#server/agents/task-fleet/runtime";
import { tempRoot } from "../task-worker/helpers.js";

test("captures the first CLI version line once and treats failures or invalid output as unavailable", async () => {
  const calls: Array<{ command: string; arguments_: readonly string[] }> = [];
  const captured = await captureTaskFleetRuntimeVersion("codex", async (command, arguments_) => {
    calls.push({ command, arguments_ });
    return "codex-cli 1.2.3\nrelease metadata\n";
  });
  assert.equal(captured, "codex-cli 1.2.3");
  assert.deepEqual(calls, [{ command: "codex", arguments_: ["--version"] }]);

  assert.equal(await captureTaskFleetRuntimeVersion("claude", async () => { throw new Error("missing"); }), null);
  assert.equal(await captureTaskFleetRuntimeVersion("claude", async () => "\nsecond line"), null);
  assert.equal(await captureTaskFleetRuntimeVersion("claude", async () => "v".repeat(129)), null);
});

test("constructs a worker with the registry-selected adapter and rejects an unknown runtime id", async () => {
  const root = await tempRoot();
  const config = parseTaskFleetConfig({
    version: 1,
    boardUrl: "http://127.0.0.1:4318",
    agents: [{
      workerId: "worker-one",
      agentId: "engineer-one",
      token: "agent-one-token-0123456789-abcdefghijklmnopqrstuvwxyz",
      provider: "codex",
      model: "codex-test",
      workingDirectory: root,
      statePath: join(root, "journal", "state.json"),
    }],
  }).agents[0]!;
  let environmentCalls = 0;
  const selected = Object.freeze({
    ...codexAdapter,
    environment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
      environmentCalls += 1;
      return codexAdapter.environment(source);
    },
  });
  const worker = await createTaskFleetWorker(config, "http://127.0.0.1:4318", {
    registry: runtimeRegistry([selected]),
  });
  try {
    assert.equal(environmentCalls, 1);
  } finally {
    await worker.close();
  }

  await assert.rejects(
    createTaskFleetWorker(config, "http://127.0.0.1:4318", { registry: runtimeRegistry([]) }),
    /Unknown runtime adapter: codex/u,
  );
});

test("retries transport, throttling, server, and journal I/O failures", () => {
  for (const status of [null, 408, 425, 429, 500, 503]) {
    assert.equal(isTransientTaskFleetError(new TaskBoardHttpError("temporary", status, null)), true, String(status));
  }
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(isTransientTaskFleetError(new TaskBoardHttpError("permanent", status, null)), false, String(status));
  }
  for (const code of ["EIO", "ENOSPC", "EMFILE", "ENFILE"]) {
    assert.equal(isTransientTaskFleetError(Object.assign(new Error("journal I/O failed"), { code })), true, code);
  }
  assert.equal(isTransientTaskFleetError(new Error("programming error")), false);
});

test("classifies a revoked lane credential separately from transient and poisoned failures", () => {
  assert.equal(classifyTaskFleetError(new TaskBoardHttpError("rotated", 401, "UNAUTHORIZED")), "CREDENTIAL_REVOKED");
  assert.equal(classifyTaskFleetError(new TaskBoardHttpError("temporary", 503, "TEMPORARY")), "TRANSIENT");
  assert.equal(classifyTaskFleetError(new TaskBoardHttpError("invalid", 400, "INVALID_REQUEST")), "POISONED");
});
