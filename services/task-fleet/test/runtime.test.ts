import assert from "node:assert/strict";
import test from "node:test";
import { TaskBoardHttpError } from "@cicada/steward-task-worker";
import { isTransientTaskFleetError } from "../src/runtime.js";

test("retries only transport, throttling, and server failures", () => {
  for (const status of [null, 408, 425, 429, 500, 503]) {
    assert.equal(isTransientTaskFleetError(new TaskBoardHttpError("temporary", status, null)), true, String(status));
  }
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(isTransientTaskFleetError(new TaskBoardHttpError("permanent", status, null)), false, String(status));
  }
  assert.equal(isTransientTaskFleetError(new Error("programming error")), false);
});
