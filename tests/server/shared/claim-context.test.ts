import assert from "node:assert/strict";
import test from "node:test";
import { claimContextInputForDigest } from "../../../src/server/shared/claim-context.js";

test("claim context digest identity ignores allocation-time task version and cursor differences", () => {
  const preview = claimContextInputForDigest({
    taskId: "preview-task",
    task: { title: "Migrate", version: 1 },
    messagesSinceCursor: 0,
    nextMessageCursor: 3,
  });
  const claim = claimContextInputForDigest({
    taskId: "allocated-task",
    task: { title: "Migrate", version: 2 },
    messagesSinceCursor: null,
    nextMessageCursor: 3,
  });

  assert.deepEqual(claim, preview);
});
