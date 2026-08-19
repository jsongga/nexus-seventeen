import assert from "node:assert/strict";
import test from "node:test";
import { TaskBoard, createTaskBoardService } from "#server/task-board";
import { HUMAN_TOKEN, databasePath } from "./helpers.js";

test("the reconciler timer invokes the public machine-verify sweep", async (t) => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let intervalCallback: (() => void) | undefined;
  const fakeTimer = { unref: () => undefined } as unknown as NodeJS.Timeout;
  globalThis.setInterval = ((callback: () => void) => {
    intervalCallback = callback;
    return fakeTimer;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => undefined) as typeof clearInterval;
  const sweep = t.mock.method(TaskBoard.prototype, "sweepVerifyAttempts", async () => 0);
  let service: Awaited<ReturnType<typeof createTaskBoardService>> | undefined;
  try {
    service = await createTaskBoardService({
      dbPath: await databasePath(),
      humanToken: HUMAN_TOKEN,
      humanPrincipal: "human:alice",
      port: 0,
      reconcileIntervalSeconds: 1,
    });
    assert.ok(intervalCallback);

    intervalCallback();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(sweep.mock.callCount(), 1);
  } finally {
    await service?.close();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
