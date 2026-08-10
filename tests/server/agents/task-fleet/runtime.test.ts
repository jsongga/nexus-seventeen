import assert from "node:assert/strict";
import test from "node:test";
import { TaskBoardHttpError } from "#server/agents/task-worker";
import { classifyTaskFleetError, isTransientTaskFleetError } from "#server/agents/task-fleet/runtime";

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
