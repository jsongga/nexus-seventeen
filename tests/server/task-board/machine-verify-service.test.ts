import assert from "node:assert/strict";
import test from "node:test";
import { TaskBoard, createTaskBoardService } from "#server/task-board";
import { HUMAN_TOKEN, databasePath } from "./helpers.js";

test("the reconciler timers invoke the public verify, park-lifecycle, wall-clock, and base-branch sweeps", async (t) => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals: Array<{ callback: () => void; delay: number | undefined }> = [];
  const fakeTimer = { unref: () => undefined } as unknown as NodeJS.Timeout;
  globalThis.setInterval = ((callback: () => void, delay?: number) => {
    intervals.push({ callback, delay });
    return fakeTimer;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => undefined) as typeof clearInterval;
  const verifySweep = t.mock.method(TaskBoard.prototype, "sweepVerifyAttempts", async () => 0);
  const parkSweep = t.mock.method(TaskBoard.prototype, "sweepParkLifecycle", () => ({
    notified: 0,
    autoAbandoned: 0,
  }));
  const wallClockSweep = t.mock.method(TaskBoard.prototype, "sweepWallClockCaps", () => ({
    suspended: 0,
    parked: 0,
  }));
  const baseBranchSweep = t.mock.method(TaskBoard.prototype, "sweepBaseBranch", () => ({
    withdrawn: 0,
    diverged: 0,
  }));
  let service: Awaited<ReturnType<typeof createTaskBoardService>> | undefined;
  try {
    service = await createTaskBoardService({
      dbPath: await databasePath(),
      humanToken: HUMAN_TOKEN,
      humanPrincipal: "human:alice",
      port: 0,
      reconcileIntervalSeconds: 1,
    });
    assert.equal(intervals.length, 5);
    assert.equal(intervals.every((interval) => interval.delay === 1_000), true);

    for (const interval of intervals) interval.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(verifySweep.mock.callCount(), 1);
    assert.equal(parkSweep.mock.callCount(), 1);
    assert.equal(wallClockSweep.mock.callCount(), 1);
    assert.equal(baseBranchSweep.mock.callCount(), 1);
  } finally {
    await service?.close();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("verify, park lifecycle, wall clock, and base branch keep 60-second sweeps when stale-run reconciliation is disabled", async (t) => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals: Array<{
    callback: () => void;
    delay: number | undefined;
    timer: NodeJS.Timeout;
    unrefed: boolean;
    cleared: boolean;
  }> = [];
  globalThis.setInterval = ((callback: () => void, delay?: number) => {
    const interval = {
      callback,
      delay,
      timer: undefined as unknown as NodeJS.Timeout,
      unrefed: false,
      cleared: false,
    };
    interval.timer = {
      unref: () => {
        interval.unrefed = true;
        return interval.timer;
      },
    } as NodeJS.Timeout;
    intervals.push(interval);
    return interval.timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: NodeJS.Timeout) => {
    const interval = intervals.find((candidate) => candidate.timer === timer);
    assert.ok(interval);
    interval.cleared = true;
  }) as typeof clearInterval;
  const verifySweep = t.mock.method(TaskBoard.prototype, "sweepVerifyAttempts", async () => 0);
  const parkSweep = t.mock.method(TaskBoard.prototype, "sweepParkLifecycle", () => ({
    notified: 0,
    autoAbandoned: 0,
  }));
  const wallClockSweep = t.mock.method(TaskBoard.prototype, "sweepWallClockCaps", () => ({
    suspended: 0,
    parked: 0,
  }));
  const baseBranchSweep = t.mock.method(TaskBoard.prototype, "sweepBaseBranch", () => ({
    withdrawn: 0,
    diverged: 0,
  }));
  const reconcile = t.mock.method(TaskBoard.prototype, "reconcileStaleRuns", () => 0);
  let service: Awaited<ReturnType<typeof createTaskBoardService>> | undefined;
  try {
    service = await createTaskBoardService({
      dbPath: await databasePath(),
      humanToken: HUMAN_TOKEN,
      humanPrincipal: "human:alice",
      port: 0,
      reconcileIntervalSeconds: 0,
    });
    const reconcileCallsAfterOpen = reconcile.mock.callCount();

    assert.equal(intervals.length, 4);
    assert.equal(intervals.every((interval) => interval.delay === 60_000), true);
    assert.equal(intervals.every((interval) => interval.unrefed), true);
    for (const interval of intervals) interval.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(verifySweep.mock.callCount(), 1);
    assert.equal(parkSweep.mock.callCount(), 1);
    assert.equal(wallClockSweep.mock.callCount(), 1);
    assert.equal(baseBranchSweep.mock.callCount(), 1);
    assert.equal(reconcile.mock.callCount(), reconcileCallsAfterOpen);
    await service.close();
    service = undefined;
    assert.equal(intervals.every((interval) => interval.cleared), true);
  } finally {
    await service?.close();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("park lifecycle, wall-clock, and base-branch timer failures are logged without escaping their callbacks", async (t) => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals: Array<() => void> = [];
  const fakeTimer = { unref: () => undefined } as unknown as NodeJS.Timeout;
  globalThis.setInterval = ((callback: () => void) => {
    intervals.push(callback);
    return fakeTimer;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => undefined) as typeof clearInterval;
  const failure = new Error("expected park lifecycle failure");
  const wallClockFailure = new Error("expected wall-clock failure");
  const baseBranchFailure = new Error("expected base-branch failure");
  t.mock.method(TaskBoard.prototype, "sweepParkLifecycle", () => {
    throw failure;
  });
  t.mock.method(TaskBoard.prototype, "sweepWallClockCaps", () => {
    throw wallClockFailure;
  });
  t.mock.method(TaskBoard.prototype, "sweepBaseBranch", () => {
    throw baseBranchFailure;
  });
  const logged = t.mock.method(console, "error", () => undefined);
  let service: Awaited<ReturnType<typeof createTaskBoardService>> | undefined;
  try {
    service = await createTaskBoardService({
      dbPath: await databasePath(),
      humanToken: HUMAN_TOKEN,
      humanPrincipal: "human:alice",
      port: 0,
      reconcileIntervalSeconds: 0,
    });
    assert.equal(intervals.length, 4);
    for (const callback of intervals) assert.doesNotThrow(callback);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      logged.mock.calls.some((call) => call.arguments[0] === "[task-board] park-lifecycle sweep failed"
        && call.arguments[1] === failure),
      true,
    );
    assert.equal(
      logged.mock.calls.some((call) => call.arguments[0] === "[task-board] wall-clock cap sweep failed"
        && call.arguments[1] === wallClockFailure),
      true,
    );
    assert.equal(
      logged.mock.calls.some((call) => call.arguments[0] === "[task-board] base-branch sweep failed"
        && call.arguments[1] === baseBranchFailure),
      true,
    );
  } finally {
    await service?.close();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
