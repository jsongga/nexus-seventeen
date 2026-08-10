import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskFleetConfig } from "#server/agents/task-fleet/config";
import { CREDENTIAL_REVOKED_MESSAGE, TaskFleet } from "#server/agents/task-fleet/fleet";
import { classifyTaskFleetError, isTransientTaskFleetError } from "#server/agents/task-fleet/runtime";
import type {
  ManagedTaskWorker,
  TaskFleetEvent,
  TaskFleetWorkerFactory,
} from "#server/agents/task-fleet/types";
import { TaskBoardHttpError } from "#server/agents/task-worker";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function fleetConfig(agentCount = 1) {
  return parseTaskFleetConfig({
    version: 1,
    boardUrl: "http://127.0.0.1:4318",
    retry: { initialDelayMs: 10, maximumDelayMs: 25 },
    agents: [
      {
        workerId: "worker-one",
        agentId: "engineer-one",
        token: "agent-one-token-0123456789-abcdefghijklmnopqrstuvwxyz",
        provider: "codex",
        model: "codex-model",
        workingDirectory: "/work/one",
        statePath: "/state/one.json",
      },
      ...(agentCount === 1 ? [] : [{
        workerId: "worker-two",
        agentId: "manager-one",
        token: "agent-two-token-0123456789-abcdefghijklmnopqrstuvwxyz",
        provider: "claude" as const,
        model: "claude-model",
        workingDirectory: "/work/two",
        statePath: "/state/two.json",
      }]),
    ],
  });
}

function idleRun(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true }));
}

function managed(overrides: Partial<ManagedTaskWorker> = {}): ManagedTaskWorker {
  return {
    run: idleRun,
    hasActiveClaim: () => false,
    quarantineActiveClaim: async () => undefined,
    dropActiveClaim: async () => undefined,
    reportLaneError: async () => undefined,
    close: async () => undefined,
    ...overrides,
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

test("two claim 503s back off, a successful claim resets the delay, and the lane keeps claiming", async () => {
  const delays: number[] = [];
  const reports: Array<string | null> = [];
  let attempts = 0;
  const fifthAttempt = deferred<void>();
  const controller = new AbortController();
  const fleet = new TaskFleet({
    config: fleetConfig(),
    workerFactory: async () => managed({
      run: async (signal) => {
        attempts += 1;
        if (attempts === 1 || attempts === 2 || attempts === 4) {
          throw new TaskBoardHttpError("claim unavailable", 503, "TEMPORARY");
        }
        if (attempts === 3) return true;
        fifthAttempt.resolve();
        return idleRun(signal);
      },
      reportLaneError: async (detail) => { reports.push(detail); },
    }),
    isTransient: isTransientTaskFleetError,
    logger: () => undefined,
    random: () => 0.5,
    sleeper: async (delay) => { delays.push(delay); },
  });

  const running = fleet.run(controller.signal);
  await fifthAttempt.promise;
  assert.equal(attempts, 5);
  assert.deepEqual(delays, [5, 10, 5]);
  assert.deepEqual(reports, [null]);
  assert.equal(fleet.snapshot.lanes[0]?.restartCount, 1);

  controller.abort();
  await running;
});

test("a non-transient settle failure quarantines its held claim with a scrubbed summary and continues", async () => {
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  const reports: Array<string | null> = [];
  const quarantines: string[] = [];
  let active = true;
  let attempts = 0;
  const nextClaim = deferred<void>();
  const controller = new AbortController();
  const fleet = new TaskFleet({
    config: fleetConfig(),
    workerFactory: async () => managed({
      run: async (signal) => {
        attempts += 1;
        if (attempts === 1) throw new TaskBoardHttpError(`settle rejected Bearer ${secret}`, 400, "INVALID_REQUEST");
        if (attempts === 2) {
          nextClaim.resolve();
          return true;
        }
        return idleRun(signal);
      },
      hasActiveClaim: () => active,
      quarantineActiveClaim: async (detail) => {
        quarantines.push(detail);
        active = false;
      },
      reportLaneError: async (detail) => { reports.push(detail); },
    }),
    isTransient: isTransientTaskFleetError,
    logger: () => undefined,
    random: () => 0.5,
    sleeper: async () => undefined,
  });

  const running = fleet.run(controller.signal);
  await nextClaim.promise;
  await eventually(() => reports.length === 2);
  assert.equal(quarantines.length, 1);
  assert.match(quarantines[0] ?? "", /Bearer \[redacted\]/u);
  assert.doesNotMatch(quarantines[0] ?? "", /sk-proj/u);
  assert.deepEqual(reports, [quarantines[0], null]);
  assert.equal(attempts, 3);

  controller.abort();
  await running;
});

test("a revoked credential logs one operator action and exits without quarantine or retry", async () => {
  const events: TaskFleetEvent[] = [];
  let operations = 0;
  let quarantines = 0;
  let drops = 0;
  let reports = 0;
  let sleeps = 0;
  const fleet = new TaskFleet({
    config: fleetConfig(),
    workerFactory: async () => managed({
      run: async () => {
        operations += 1;
        throw new TaskBoardHttpError("Agent authentication is required", 401, "UNAUTHORIZED");
      },
      hasActiveClaim: () => true,
      quarantineActiveClaim: async () => { quarantines += 1; },
      dropActiveClaim: async () => { drops += 1; },
      reportLaneError: async () => { reports += 1; },
    }),
    classifyError: classifyTaskFleetError,
    logger: (event) => events.push(event),
    sleeper: async () => { sleeps += 1; },
  });

  await fleet.run(new AbortController().signal);

  assert.equal(operations, 1);
  assert.equal(quarantines, 0);
  assert.equal(drops, 0);
  assert.equal(reports, 0);
  assert.equal(sleeps, 0);
  assert.equal(fleet.snapshot.lanes[0]?.status, "closed");
  const revoked = events.filter((event) => event.type === "lane_credential_revoked");
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0]?.error, CREDENTIAL_REVOKED_MESSAGE);
});

test("journal EIO is transient: it backs off and retries without quarantine", async () => {
  const delays: number[] = [];
  let quarantines = 0;
  let attempts = 0;
  const retried = deferred<void>();
  const controller = new AbortController();
  const fleet = new TaskFleet({
    config: fleetConfig(),
    workerFactory: async () => managed({
      run: async (signal) => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("journal write failed"), { code: "EIO" });
        retried.resolve();
        return idleRun(signal);
      },
      hasActiveClaim: () => true,
      quarantineActiveClaim: async () => { quarantines += 1; },
    }),
    isTransient: isTransientTaskFleetError,
    logger: () => undefined,
    random: () => 0.5,
    sleeper: async (delay) => { delays.push(delay); },
  });

  const running = fleet.run(controller.signal);
  await retried.promise;
  assert.deepEqual(delays, [5]);
  assert.equal(quarantines, 0);
  assert.equal(attempts, 2);

  controller.abort();
  await running;
});

test("a claim 400 with no held claim reports the error and retries at capped backoff without parking", async () => {
  const delays: number[] = [];
  const reports: Array<string | null> = [];
  let attempts = 0;
  const fourthRetry = deferred<void>();
  const controller = new AbortController();
  const fleet = new TaskFleet({
    config: fleetConfig(),
    workerFactory: async () => managed({
      run: async (signal) => {
        attempts += 1;
        if (attempts <= 4) throw new TaskBoardHttpError("claim rejected", 400, "INVALID_REQUEST");
        fourthRetry.resolve();
        return idleRun(signal);
      },
      reportLaneError: async (detail) => { reports.push(detail); },
    }),
    isTransient: isTransientTaskFleetError,
    logger: () => undefined,
    random: () => 0.5,
    sleeper: async (delay) => { delays.push(delay); },
  });

  const running = fleet.run(controller.signal);
  await fourthRetry.promise;
  assert.deepEqual(delays, [5, 10, 12, 12]);
  assert.equal(reports.length, 4);
  assert.equal(fleet.snapshot.lanes[0]?.status, "running");
  assert.equal(fleet.snapshot.lanes[0]?.restartCount, 4);

  controller.abort();
  await running;
});

test("five failed quarantine settlements drop the local claim and keep the lane alive", async () => {
  const events: TaskFleetEvent[] = [];
  const quarantineDelays: number[] = [];
  let localClaimActive = true;
  let quarantineAttempts = 0;
  let drops = 0;
  let operations = 0;
  const continued = deferred<void>();
  const controller = new AbortController();
  const fleet = new TaskFleet({
    config: fleetConfig(),
    workerFactory: async () => managed({
      run: async (signal) => {
        operations += 1;
        if (operations === 1) throw new TaskBoardHttpError("settle rejected", 400, "INVALID_REQUEST");
        continued.resolve();
        return idleRun(signal);
      },
      hasActiveClaim: () => localClaimActive,
      quarantineActiveClaim: async () => {
        quarantineAttempts += 1;
        throw new TaskBoardHttpError("quarantine settle unavailable", 503, "TEMPORARY");
      },
      dropActiveClaim: async () => {
        drops += 1;
        localClaimActive = false;
      },
    }),
    isTransient: isTransientTaskFleetError,
    logger: (event) => events.push(event),
    random: () => 0.5,
    sleeper: async (delay) => { quarantineDelays.push(delay); },
  });

  const running = fleet.run(controller.signal);
  await continued.promise;
  assert.equal(quarantineAttempts, 5);
  assert.equal(drops, 1);
  assert.equal(operations, 2);
  assert.equal(fleet.snapshot.lanes[0]?.status, "running");
  assert.deepEqual(quarantineDelays, [5, 10, 12, 12]);
  assert.equal(events.filter((event) => event.type === "claim_dropped").length, 1);

  controller.abort();
  await running;
});

test("a successful claim clears the durable lane error", async () => {
  const reports: Array<string | null> = [];
  let attempts = 0;
  const cleared = deferred<void>();
  const controller = new AbortController();
  const fleet = new TaskFleet({
    config: fleetConfig(),
    workerFactory: async () => managed({
      run: async (signal) => {
        attempts += 1;
        if (attempts === 1) throw new TaskBoardHttpError("bad claim", 400, "INVALID_REQUEST");
        if (attempts === 2) return true;
        cleared.resolve();
        return idleRun(signal);
      },
      reportLaneError: async (detail) => { reports.push(detail); },
    }),
    isTransient: isTransientTaskFleetError,
    logger: () => undefined,
    random: () => 0.5,
    sleeper: async () => undefined,
  });

  const running = fleet.run(controller.signal);
  await cleared.promise;
  assert.deepEqual(reports, ["bad claim", null]);
  assert.equal(fleet.snapshot.lanes[0]?.lastError, null);

  controller.abort();
  await running;
});

test("starts every configured lane concurrently and closes held workers once", async () => {
  const starts: string[] = [];
  const closes: string[] = [];
  const factory: TaskFleetWorkerFactory = async (config) => managed({
    run: async (signal) => { starts.push(config.agentId); return idleRun(signal); },
    close: async () => { closes.push(config.agentId); },
  });
  const controller = new AbortController();
  const fleet = new TaskFleet({
    config: fleetConfig(2),
    workerFactory: factory,
    isTransient: isTransientTaskFleetError,
    logger: () => undefined,
  });

  const running = fleet.run(controller.signal);
  await eventually(() => starts.length === 2);
  assert.deepEqual(new Set(starts), new Set(["engineer-one", "manager-one"]));

  controller.abort();
  await running;
  await fleet.close();
  assert.deepEqual(new Set(closes), new Set(["engineer-one", "manager-one"]));
  assert.deepEqual(fleet.snapshot.lanes.map((lane) => lane.status), ["closed", "closed"]);
});

test("aborting during retry backoff prevents another operation", async () => {
  let attempts = 0;
  const sleeping = deferred<void>();
  const controller = new AbortController();
  const fleet = new TaskFleet({
    config: fleetConfig(),
    workerFactory: async () => managed({
      run: async () => {
        attempts += 1;
        throw new TaskBoardHttpError("board unavailable", 503, "TEMPORARY");
      },
    }),
    isTransient: isTransientTaskFleetError,
    logger: () => undefined,
    random: () => 0.5,
    sleeper: async (_delay, signal) => {
      sleeping.resolve();
      await idleRun(signal);
    },
  });

  const running = fleet.run(controller.signal);
  await sleeping.promise;
  controller.abort();
  await running;
  assert.equal(attempts, 1);
});

test("partial factory failure closes workers already created", async () => {
  const closed: string[] = [];
  const fleet = new TaskFleet({
    config: fleetConfig(2),
    workerFactory: async (config) => {
      if (config.agentId === "manager-one") throw new Error("invalid manager configuration");
      return managed({ close: async () => { closed.push(config.agentId); } });
    },
    isTransient: isTransientTaskFleetError,
    logger: () => undefined,
  });
  await assert.rejects(fleet.run(new AbortController().signal), /worker creation failed/u);
  assert.deepEqual(closed, ["engineer-one"]);
});

test("closing during asynchronous worker creation closes the late worker without running it", async () => {
  const releaseFactory = deferred<void>();
  let runs = 0;
  let closes = 0;
  const fleet = new TaskFleet({
    config: fleetConfig(),
    workerFactory: async () => {
      await releaseFactory.promise;
      return managed({
        run: async () => { runs += 1; return false; },
        close: async () => { closes += 1; },
      });
    },
    isTransient: isTransientTaskFleetError,
    logger: () => undefined,
  });

  const running = fleet.run(new AbortController().signal);
  await fleet.close();
  releaseFactory.resolve();
  await running;
  assert.equal(runs, 0);
  assert.equal(closes, 1);
});
