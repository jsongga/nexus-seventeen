import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskFleetConfig } from "../src/config.js";
import { TaskFleet } from "../src/fleet.js";
import type {
  ManagedTaskWorker,
  TaskFleetAgentConfig,
  TaskFleetEvent,
  TaskFleetWorkerFactory,
} from "../src/types.js";

class TransientFailure extends Error {}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function fleetConfig() {
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
      {
        workerId: "worker-two",
        agentId: "manager-one",
        token: "agent-two-token-0123456789-abcdefghijklmnopqrstuvwxyz",
        provider: "claude",
        model: "claude-model",
        workingDirectory: "/work/two",
        statePath: "/state/two.json",
      },
    ],
  });
}

function idleRun(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

test("starts every configured lane concurrently and stays model-free while held workers are idle", async () => {
  const starts: string[] = [];
  const closes: string[] = [];
  const sleeps: number[] = [];
  const factory: TaskFleetWorkerFactory = async (config) => ({
    run: async (signal) => { starts.push(config.agentId); await idleRun(signal); },
    close: async () => { closes.push(config.agentId); },
  });
  const controller = new AbortController();
  const fleet = new TaskFleet({
    config: fleetConfig(),
    workerFactory: factory,
    isTransient: () => false,
    logger: () => undefined,
    sleeper: async (delay) => { sleeps.push(delay); },
  });

  const running = fleet.run(controller.signal);
  await eventually(() => starts.length === 2);
  assert.deepEqual(new Set(starts), new Set(["engineer-one", "manager-one"]));
  assert.deepEqual(sleeps, []);
  assert.deepEqual(fleet.snapshot.lanes.map((lane) => lane.status), ["running", "running"]);

  controller.abort();
  await running;
  assert.deepEqual(new Set(closes), new Set(["engineer-one", "manager-one"]));
  assert.deepEqual(fleet.snapshot.lanes.map((lane) => lane.status), ["closed", "closed"]);
});

test("re-enters a failed worker with exponential bounded backoff and preserves other lanes", async () => {
  const attempts = new Map<string, number>();
  const delays: number[] = [];
  const events: TaskFleetEvent[] = [];
  const thirdStart = deferred<void>();
  const factory: TaskFleetWorkerFactory = async (config) => ({
    run: async (signal) => {
      const attempt = (attempts.get(config.agentId) ?? 0) + 1;
      attempts.set(config.agentId, attempt);
      if (config.agentId === "engineer-one" && attempt <= 3) throw new TransientFailure(`offline ${attempt}`);
      if (config.agentId === "engineer-one") thirdStart.resolve();
      await idleRun(signal);
    },
    close: async () => undefined,
  });
  const controller = new AbortController();
  const fleet = new TaskFleet({
    config: fleetConfig(),
    workerFactory: factory,
    isTransient: (error) => error instanceof TransientFailure,
    logger: (event) => events.push(event),
    sleeper: async (delay, signal) => { delays.push(delay); if (signal.aborted) return; },
  });

  const running = fleet.run(controller.signal);
  await thirdStart.promise;
  assert.deepEqual(delays, [10, 20, 25]);
  assert.equal(attempts.get("engineer-one"), 4);
  assert.equal(attempts.get("manager-one"), 1);
  assert.deepEqual(
    events.filter((event) => event.type === "lane_retrying").map((event) => event.type === "lane_retrying" ? event.delayMs : 0),
    [10, 20, 25],
  );

  controller.abort();
  await running;
});

test("stops only the lane with a non-transient error and keeps another agent waiting", async () => {
  const events: TaskFleetEvent[] = [];
  const managerStarted = deferred<void>();
  const factory: TaskFleetWorkerFactory = async (config) => ({
    run: async (signal) => {
      if (config.agentId === "engineer-one") throw new Error("credential rejected");
      managerStarted.resolve();
      await idleRun(signal);
    },
    close: async () => undefined,
  });
  const controller = new AbortController();
  const fleet = new TaskFleet({
    config: fleetConfig(),
    workerFactory: factory,
    isTransient: () => false,
    logger: (event) => events.push(event),
  });

  const running = fleet.run(controller.signal);
  await managerStarted.promise;
  await eventually(() => fleet.snapshot.lanes.some((lane) => lane.agentId === "engineer-one" && lane.status === "stopped"));
  assert.equal(fleet.snapshot.lanes.find((lane) => lane.agentId === "manager-one")?.status, "running");
  assert.equal(events.filter((event) => event.type === "lane_stopped").length, 1);

  controller.abort();
  await running;
});

test("aborting during retry backoff prevents another worker run and closes once", async () => {
  let attempts = 0;
  let closes = 0;
  const sleeping = deferred<void>();
  const controller = new AbortController();
  const worker: ManagedTaskWorker = {
    run: async () => { attempts += 1; throw new TransientFailure("board unavailable"); },
    close: async () => { closes += 1; },
  };
  const factory: TaskFleetWorkerFactory = async (_config: TaskFleetAgentConfig) => worker;
  const config = parseTaskFleetConfig({
    version: 1,
    boardUrl: "http://127.0.0.1:4318",
    agents: [{
      workerId: "worker-one",
      agentId: "engineer-one",
      token: "agent-one-token-0123456789-abcdefghijklmnopqrstuvwxyz",
      provider: "codex",
      model: "codex-model",
      workingDirectory: "/work/one",
      statePath: "/state/one.json",
    }],
  });
  const fleet = new TaskFleet({
    config,
    workerFactory: factory,
    isTransient: (error) => error instanceof TransientFailure,
    logger: () => undefined,
    sleeper: async (_delay, signal) => {
      sleeping.resolve();
      await idleRun(signal);
    },
  });

  const running = fleet.run(controller.signal);
  await sleeping.promise;
  controller.abort();
  await running;
  await fleet.close();
  assert.equal(attempts, 1);
  assert.equal(closes, 1);
});

test("close itself aborts held lanes and partial factory failure closes workers already created", async () => {
  let heldClosed = 0;
  const heldStarted = deferred<void>();
  const heldFleet = new TaskFleet({
    config: parseTaskFleetConfig({
      version: 1,
      boardUrl: "http://127.0.0.1:4318",
      agents: [{
        workerId: "worker-held",
        agentId: "engineer-held",
        token: "agent-held-token-0123456789-abcdefghijklmnopqrstuvwxyz",
        provider: "codex",
        model: "codex-model",
        workingDirectory: "/work/held",
        statePath: "/state/held.json",
      }],
    }),
    workerFactory: async () => ({
      run: async (signal) => { heldStarted.resolve(); await idleRun(signal); },
      close: async () => { heldClosed += 1; },
    }),
    isTransient: () => false,
    logger: () => undefined,
  });
  const running = heldFleet.run(new AbortController().signal);
  await heldStarted.promise;
  await heldFleet.close();
  await running;
  assert.equal(heldClosed, 1);

  const closed: string[] = [];
  const failingFleet = new TaskFleet({
    config: fleetConfig(),
    workerFactory: async (config) => {
      if (config.agentId === "manager-one") throw new Error("invalid manager configuration");
      return { run: idleRun, close: async () => { closed.push(config.agentId); } };
    },
    isTransient: () => false,
    logger: () => undefined,
  });
  await assert.rejects(failingFleet.run(new AbortController().signal), /worker creation failed/u);
  assert.deepEqual(closed, ["engineer-one"]);
});

test("closing during asynchronous worker creation still closes the late worker without running it", async () => {
  const releaseFactory = deferred<void>();
  let runs = 0;
  let closes = 0;
  const config = parseTaskFleetConfig({
    version: 1,
    boardUrl: "http://127.0.0.1:4318",
    agents: [{
      workerId: "worker-late",
      agentId: "engineer-late",
      token: "agent-late-token-0123456789-abcdefghijklmnopqrstuvwxyz",
      provider: "codex",
      model: "codex-model",
      workingDirectory: "/work/late",
      statePath: "/state/late.json",
    }],
  });
  const fleet = new TaskFleet({
    config,
    workerFactory: async () => {
      await releaseFactory.promise;
      return {
        run: async () => { runs += 1; },
        close: async () => { closes += 1; },
      };
    },
    isTransient: () => false,
    logger: () => undefined,
  });

  const running = fleet.run(new AbortController().signal);
  await fleet.close();
  releaseFactory.resolve();
  await running;
  assert.equal(runs, 0);
  assert.equal(closes, 1);
});
