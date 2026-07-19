import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { parseSupervisorRegistrationResult } from "@cicada/steward-protocol";
import { SupervisorDaemon } from "../src/daemon.js";
import { CheckpointStore, EMPTY_INTERRUPT_CHECKPOINT, type RpetPhase } from "../src/checkpoint.js";
import { DurableOutbox } from "../src/outbox.js";
import { FakeProviderAdapter } from "../src/provider.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
import {
  FORECAST_COMPLETES_AT,
  FORECAST_MINUTES,
  FakeControlPlane,
  configFixture,
  registrationIdentity,
  taskFixture,
} from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((pathname) => rm(pathname, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const pathname = await mkdtemp(join(tmpdir(), "steward-daemon-"));
  await mkdir(join(pathname, "workspace/project"), { recursive: true });
  temporaryDirectories.push(pathname);
  return pathname;
}

async function waitFor(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for supervisor state change");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("runtime generation proof survives a private supervisor state restart", async () => {
  const root = await temporaryDirectory();
  const stateDirectory = configFixture(root).stateDirectory;
  const proof = `rgp_${"q".repeat(43)}`;
  const first = new RuntimeStateStore(stateDirectory);
  await first.load();
  await first.recordRuntimeRegistration(4, proof);

  const restarted = new RuntimeStateStore(stateDirectory);
  await restarted.load();
  assert.equal(restarted.runtimeEpoch, 4);
  assert.equal(restarted.runtimeGenerationProof, proof);
});

async function seedRpetCrashGap(
  root: string,
  phase: RpetPhase,
  outcome?: "passed" | "failed",
): Promise<void> {
  const config = configFixture(root);
  const task = taskFixture();
  const runtimeState = new RuntimeStateStore(config.stateDirectory);
  await runtimeState.load();
  const runtimeEpoch = 1;
  await runtimeState.recordRuntimeEpoch(runtimeEpoch);
  const checkpoint = new CheckpointStore(config.stateDirectory);
  await checkpoint.write({
    runtimeEpoch,
    desiredState: "active",
    taskId: task.taskId,
    activeTask: task,
    queuedTasks: [],
    iteration: 1,
    phase,
    currentAction: null,
    timing: {
      expectedAgentMinutes: task.expectedAgentMinutes,
      expectedCompletedAt: task.expectedCompletedAt,
      startedAt: task.startedAt,
    },
    resultOverview: null,
    lastLocalSequence: 0,
    interrupt: EMPTY_INTERRUPT_CHECKPOINT,
  });
  const identity = registrationIdentity(runtimeEpoch);
  const outbox = await DurableOutbox.open({
    stateDirectory: config.stateDirectory,
    identity: {
      apiVersion: identity.apiVersion,
      workspaceId: identity.workspaceId,
      agentId: identity.agentId,
      laneId: identity.laneId,
      runtimeInstanceId: identity.runtimeInstanceId,
    },
    runtimeEpoch,
  });
  if (phase === "test") {
    if (!outcome) throw new Error("A seeded test progress record requires an outcome");
    await outbox.append({
      type: "progress",
      taskId: task.taskId,
      phase,
      iteration: 1,
      journal: `${phase} completed before the simulated crash.`,
      outcome,
    });
  } else {
    await outbox.append({
      type: "progress",
      taskId: task.taskId,
      phase,
      iteration: 1,
      journal: `${phase} completed before the simulated crash.`,
    });
  }
  await outbox.flush();
}

test("control-plane failure after an atomic action enters offline hold and resumes from checkpoint", async () => {
  const root = await temporaryDirectory();
  const client = new FakeControlPlane();
  const provider = new FakeProviderAdapter();
  const daemon = await SupervisorDaemon.create({ config: configFixture(root), client, provider });
  await daemon.tick();

  client.enqueue({ type: "assign_task", task: taskFixture() }, daemon.snapshot.runtimeEpoch);
  client.loseNextUploadResponse = true;
  await daemon.tick();
  assert.equal(daemon.snapshot.state, "offline_hold");
  assert.equal(provider.calls.length, 1, "the completed research action is not retried while offline");
  assert.equal(daemon.snapshot.checkpoint?.phase, "plan");

  await daemon.tick();
  assert.equal(daemon.snapshot.state, "active");
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[1]!.phase, "plan");
  await daemon.shutdown();
});

test("a lost registration response retries the exact same boot identity and CAS request", async () => {
  const root = await temporaryDirectory();
  const client = new FakeControlPlane();
  client.loseNextRegistrationResponse = true;
  const daemon = await SupervisorDaemon.create({
    config: configFixture(root, { runtimeInstanceId: "runtime-registration-retry" }),
    client,
    provider: new FakeProviderAdapter(),
  });

  await daemon.tick();
  assert.equal(daemon.snapshot.state, "offline_hold");
  await daemon.tick();
  assert.equal(daemon.snapshot.state, "active");
  assert.equal(daemon.snapshot.runtimeEpoch, 1);
  assert.equal(client.registrationRequests.length, 2);
  assert.equal(
    JSON.stringify(client.registrationRequests[0]),
    JSON.stringify(client.registrationRequests[1]),
  );
  assert.equal(client.registrationRequests[0]?.expectedRuntimeEpoch, null);
  await daemon.shutdown();
});

test("process restart recovers a server-committed registration through its durable exact intent", async () => {
  for (const persistIssuedEpochBeforeRestart of [false, true]) {
    const root = await temporaryDirectory();
    const client = new FakeControlPlane();
    client.loseNextRegistrationResponse = true;
    const first = await SupervisorDaemon.create({
      config: configFixture(root, { runtimeInstanceId: "runtime-committed-unacknowledged" }),
      client,
      provider: new FakeProviderAdapter(),
    });
    await first.tick();
    assert.equal(first.snapshot.state, "offline_hold");
    await first.shutdown();

    if (persistIssuedEpochBeforeRestart) {
      const runtimeState = new RuntimeStateStore(configFixture(root).stateDirectory);
      await runtimeState.load();
      await runtimeState.recordRuntimeEpoch(1);
    }

    const restarted = await SupervisorDaemon.create({
      config: configFixture(root, { runtimeInstanceId: "runtime-fresh-id-must-not-replace-pending" }),
      client,
      provider: new FakeProviderAdapter(),
    });
    await restarted.tick();
    assert.equal(restarted.snapshot.state, "active");
    assert.equal(restarted.snapshot.runtimeEpoch, 1);
    assert.deepEqual(
      client.registrationRequests.map((request) => ({
        runtimeInstanceId: request.runtimeInstanceId,
        expectedRuntimeEpoch: request.expectedRuntimeEpoch,
      })),
      [
        { runtimeInstanceId: "runtime-committed-unacknowledged", expectedRuntimeEpoch: null },
        { runtimeInstanceId: "runtime-committed-unacknowledged", expectedRuntimeEpoch: null },
      ],
    );
    await assert.rejects(
      readFile(join(configFixture(root).stateDirectory, "registration-intent.json"), "utf8"),
      { code: "ENOENT" },
    );
    await restarted.shutdown();
  }
});

test("lost upload acknowledgement is reconciled before epoch rebase on restart", async () => {
  const root = await temporaryDirectory();
  const config = configFixture(root);
  const client = new FakeControlPlane();
  const firstProvider = new FakeProviderAdapter();
  const first = await SupervisorDaemon.create({ config, client, provider: firstProvider });
  await first.tick();
  const epoch = first.snapshot.runtimeEpoch;
  await first.handleCommand(client.enqueue({ type: "assign_task", task: taskFixture("task-active") }, epoch));
  await first.handleCommand(client.enqueue({ type: "assign_task", task: taskFixture("task-queued") }, epoch));
  client.loseNextUploadResponse = true;
  await first.tick();

  const acceptedBeforeRestart = client.acceptedThrough;
  const storedBeforeRestart = new Map(client.storedEvents);
  assert.ok(acceptedBeforeRestart > 0);
  assert.equal(first.snapshot.pendingOutboxEvents, acceptedBeforeRestart);
  await first.shutdown();

  const secondProvider = new FakeProviderAdapter();
  const restarted = await SupervisorDaemon.create({
    config: configFixture(root, { runtimeInstanceId: "runtime-test-replacement" }),
    client,
    provider: secondProvider,
  });
  assert.equal(restarted.snapshot.runtimeEpoch, 1, "the observed epoch is reused only as registration CAS input");
  await restarted.tick();
  assert.equal(restarted.snapshot.runtimeEpoch, 2, "the control plane issues the replacement epoch");
  assert.deepEqual(
    client.registrationRequests.map((request) => ({
      runtimeInstanceId: request.runtimeInstanceId,
      expectedRuntimeEpoch: request.expectedRuntimeEpoch,
    })),
    [
      { runtimeInstanceId: "runtime-test", expectedRuntimeEpoch: null },
      { runtimeInstanceId: "runtime-test-replacement", expectedRuntimeEpoch: 1 },
    ],
  );
  assert.equal(restarted.snapshot.pendingOutboxEvents, 0);
  for (const [eventId, serialized] of storedBeforeRestart) {
    assert.equal(client.storedEvents.get(eventId), serialized, "accepted event IDs must never be resent with changed epoch content");
  }
  assert.equal(secondProvider.calls.length, 1);
  assert.equal(secondProvider.calls[0]!.phase, "plan", "active work resumes from its persisted RPET phase");
  assert.equal(restarted.snapshot.activeTask?.taskId, "task-active");
  assert.deepEqual(restarted.snapshot.queuedTasks.map((task) => task.taskId), ["task-queued"]);
  await restarted.shutdown();
});

test("a reused stale boot identity cannot seize or rewrite the server-issued epoch", async () => {
  const root = await temporaryDirectory();
  const config = configFixture(root, { runtimeInstanceId: "runtime-fixed-stale" });
  const client = new FakeControlPlane();
  const first = await SupervisorDaemon.create({
    config,
    client,
    provider: new FakeProviderAdapter(),
  });
  await first.tick();
  assert.equal(first.snapshot.runtimeEpoch, 1);
  await first.shutdown();

  const stale = await SupervisorDaemon.create({
    config,
    client,
    provider: new FakeProviderAdapter(),
  });
  await stale.tick();
  assert.equal(stale.snapshot.state, "offline_hold");
  assert.equal(stale.snapshot.runtimeEpoch, 1);
  assert.deepEqual(
    client.registrationRequests.map((request) => request.expectedRuntimeEpoch),
    [null, 1],
  );
  await stale.shutdown();
});

test("a stale-epoch human interrupt is fenced and durably refused", async () => {
  const root = await temporaryDirectory();
  const config = configFixture(root);
  const epochSeed = new RuntimeStateStore(config.stateDirectory);
  await epochSeed.load();
  await epochSeed.recordRuntimeEpoch(1);

  const client = new FakeControlPlane(1);
  const provider = new FakeProviderAdapter();
  let now = Date.parse("2026-07-18T20:00:00.000Z");
  const daemon = await SupervisorDaemon.create({ config, client, provider, clock: () => new Date(now) });
  assert.equal(daemon.snapshot.runtimeEpoch, 1);
  await daemon.tick();
  assert.equal(daemon.snapshot.runtimeEpoch, 2);

  const stale = client.enqueue({ type: "request_interrupt", reason: "Stop the stale process" }, 1);
  await daemon.handleCommand(stale);
  assert.equal(daemon.snapshot.state, "active");
  assert.equal(provider.interruptSettlements, 0);
  const records = (await readFile(join(config.stateDirectory, "runtime-outbox.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { payload: { type: string; commandId: string } });
  assert.equal(records.at(-1)?.payload.type, "interrupt_refused");
  assert.equal(records.at(-1)?.payload.commandId, stale.commandId);
  now += 1_000;
  await daemon.tick();
  assert.equal(
    client.leaseRequests.at(-1)?.lastDurableEventSequence,
    0,
    "lease cursor reports only server-acknowledged durable events, not the pending suffix",
  );
  await daemon.shutdown();
});

test("a direct human interrupt aborts an in-flight provider action before serialized settlement", async () => {
  const root = await temporaryDirectory();
  const client = new FakeControlPlane();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const provider = new FakeProviderAdapter({
    delayMs: 10_000,
    beforeStep: () => markStarted?.(),
  });
  const daemon = await SupervisorDaemon.create({ config: configFixture(root), client, provider });
  await daemon.tick();
  const epoch = daemon.snapshot.runtimeEpoch;
  await daemon.handleCommand(client.enqueue({ type: "assign_task", task: taskFixture() }, epoch));

  const runningTick = daemon.tick();
  await started;
  const interrupt = client.enqueue({ type: "request_interrupt", reason: "Stop now" }, epoch);
  const settling = daemon.handleCommand(interrupt);
  await Promise.all([runningTick, settling]);

  assert.equal(daemon.snapshot.state, "paused");
  assert.equal(provider.interruptSettlements, 1);
  assert.equal(daemon.snapshot.activeTask?.taskId, "task-one");
  const records = (await readFile(join(configFixture(root).stateDirectory, "runtime-outbox.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { payload: { type: string } });
  assert.ok(!records.some((record) => record.payload.type === "task_failed"));
  assert.deepEqual(records.slice(-2).map((record) => record.payload.type), [
    "interrupt_acknowledged",
    "interrupt_settled",
  ]);
  await daemon.shutdown();
});

test("interrupt and hold report no task before a current action is durably announced", async () => {
  for (const commandType of ["request_interrupt", "hold"] as const) {
    const root = await temporaryDirectory();
    const client = new FakeControlPlane();
    const daemon = await SupervisorDaemon.create({
      config: configFixture(root),
      client,
      provider: new FakeProviderAdapter(),
    });
    await daemon.tick();
    const epoch = daemon.snapshot.runtimeEpoch;
    await daemon.handleCommand(
      client.enqueue({ type: "assign_task", task: taskFixture() }, epoch),
    );
    await daemon.handleCommand(
      client.enqueue(
        commandType === "request_interrupt"
          ? { type: commandType, reason: "Stop before provider work" }
          : { type: commandType, reason: "Hold before provider work" },
        epoch,
      ),
    );

    const records = (await readFile(join(configFixture(root).stateDirectory, "runtime-outbox.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { payload: { type: string; taskId?: string | null } });
    const lifecycleTypes = commandType === "request_interrupt"
      ? new Set(["interrupt_acknowledged", "interrupt_settled"])
      : new Set(["hold_acknowledged", "hold_settled"]);
    const lifecycle = records.filter((record) => lifecycleTypes.has(record.payload.type));
    assert.equal(lifecycle.length, 2);
    assert.ok(lifecycle.every((record) => record.payload.taskId === null));
    await daemon.shutdown();
  }
});

test("the active-step watcher renews its lease and applies an HTTP-polled interrupt promptly", async () => {
  const root = await temporaryDirectory();
  const client = new FakeControlPlane();
  let now = Date.parse("2026-07-18T20:00:00.000Z");
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const provider = new FakeProviderAdapter({
    delayMs: 10_000,
    beforeStep: () => {
      now += 1_001;
      markStarted?.();
    },
  });
  const daemon = await SupervisorDaemon.create({
    config: configFixture(root, { runtimeInstanceId: "runtime-test-crash-recovery" }),
    client,
    provider,
    clock: () => new Date(now),
    loopIntervalMs: 10,
  });
  await daemon.tick();
  const epoch = daemon.snapshot.runtimeEpoch;
  await daemon.handleCommand(client.enqueue({ type: "assign_task", task: taskFixture() }, epoch));

  const runningTick = daemon.tick();
  await started;
  const pollsBeforeInterrupt = client.pollCalls;
  client.enqueue({ type: "request_interrupt", reason: "Human stopped the live agent" }, epoch);
  await waitFor(() => daemon.snapshot.state === "paused");
  await runningTick;

  assert.ok(client.pollCalls > pollsBeforeInterrupt, "the watcher polls independently during provider work");
  assert.ok(client.leaseRequests.length > 0, "the watcher renews a due lease during provider work");
  assert.equal(daemon.snapshot.state, "paused");
  assert.equal(daemon.snapshot.activeTask?.taskId, "task-one");
  assert.equal(
    client.receivedBatches.some((batch) => batch.events.some((event) => event.payload.type === "task_failed")),
    false,
  );
  await daemon.shutdown();
});

test("lease renewal is capped by the granted TTL instead of a slower configured interval", async () => {
  const root = await temporaryDirectory();
  class ShortLeaseControlPlane extends FakeControlPlane {
    override async register(request: Parameters<FakeControlPlane["register"]>[0]) {
      const result = await super.register(request);
      return parseSupervisorRegistrationResult({
        ...result,
        leaseExpiresAt: new Date(Date.parse(result.leaseGrantedAt) + 2_000).toISOString(),
      });
    }
  }
  const client = new ShortLeaseControlPlane();
  let now = Date.now();
  const daemon = await SupervisorDaemon.create({
    config: { ...configFixture(root), leaseIntervalMs: 300_000 },
    client,
    provider: new FakeProviderAdapter(),
    clock: () => new Date(now),
  });
  await daemon.tick();
  assert.equal(client.leaseRequests.length, 0);
  now += 1_100;
  await daemon.tick();
  assert.equal(client.leaseRequests.length, 1);
  await daemon.shutdown();
});

test("an HTTP-polled hold aborts provider work and emits an ordered durable hold barrier", async () => {
  const root = await temporaryDirectory();
  const client = new FakeControlPlane();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const provider = new FakeProviderAdapter({
    delayMs: 10_000,
    beforeStep: () => markStarted?.(),
  });
  const daemon = await SupervisorDaemon.create({
    config: configFixture(root),
    client,
    provider,
    loopIntervalMs: 10,
  });
  await daemon.tick();
  const epoch = daemon.snapshot.runtimeEpoch;
  await daemon.handleCommand(client.enqueue({ type: "assign_task", task: taskFixture() }, epoch));

  const runningTick = daemon.tick();
  await started;
  const hold = client.enqueue({ type: "hold", reason: "Human review boundary" }, epoch);
  await runningTick;
  await daemon.tick();

  assert.equal(daemon.snapshot.state, "held");
  assert.equal(daemon.snapshot.activeTask?.taskId, "task-one");
  const payloads = client.receivedBatches.flatMap((batch) => batch.events.map((event) => event.payload));
  const lifecycle = payloads.filter(
    (payload) =>
      (payload.type === "hold_acknowledged" || payload.type === "hold_settled") &&
      payload.commandId === hold.commandId,
  );
  assert.deepEqual(lifecycle.map((payload) => payload.type), ["hold_acknowledged", "hold_settled"]);
  assert.equal(payloads.some((payload) => payload.type === "progress" || payload.type === "task_failed"), false);
  await daemon.shutdown();
});

test("initialization failure releases both exact process locks", async () => {
  const root = await temporaryDirectory();
  const config = configFixture(root);
  await mkdir(config.stateDirectory, { recursive: true });
  await writeFile(join(config.stateDirectory, "runtime-state.json"), "not-json\n", { mode: 0o600 });

  await assert.rejects(
    SupervisorDaemon.create({ config, client: new FakeControlPlane(), provider: new FakeProviderAdapter() }),
    /JSON|Unexpected token|Unexpected character/,
  );
  await assert.rejects(readFile(join(config.stateDirectory, ".steward-supervisor.lock"), "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(join(config.workingDirectory, ".steward-supervisor.lock"), "utf8"), { code: "ENOENT" });
});

test("a second supervisor cannot share a live daemon's state or working directory", async () => {
  const root = await temporaryDirectory();
  const config = configFixture(root);
  const first = await SupervisorDaemon.create({
    config,
    client: new FakeControlPlane(),
    provider: new FakeProviderAdapter(),
  });
  await assert.rejects(
    SupervisorDaemon.create({
      config,
      client: new FakeControlPlane(),
      provider: new FakeProviderAdapter(),
    }),
    /already locked/,
  );
  await first.shutdown();

  const replacement = await SupervisorDaemon.create({
    config,
    client: new FakeControlPlane(),
    provider: new FakeProviderAdapter(),
  });
  await replacement.shutdown();
});

test("restart derives the next RPET phase from a progress record fsynced before its checkpoint", async () => {
  const root = await temporaryDirectory();
  await seedRpetCrashGap(root, "research");
  const provider = new FakeProviderAdapter();
  const daemon = await SupervisorDaemon.create({
    config: configFixture(root),
    client: new FakeControlPlane(1),
    provider,
  });

  assert.equal(daemon.snapshot.checkpoint?.phase, "plan");
  await daemon.tick();
  assert.equal(provider.calls[0]?.phase, "plan", "the already durable research step is not executed twice");
  await daemon.shutdown();
});

test("restart finalizes a passing test record without rerunning the provider", async () => {
  const root = await temporaryDirectory();
  await seedRpetCrashGap(root, "test", "passed");
  const client = new FakeControlPlane(1);
  const provider = new FakeProviderAdapter();
  const daemon = await SupervisorDaemon.create({
    config: configFixture(root, { runtimeInstanceId: "runtime-test-passed-recovery" }),
    client,
    provider,
  });

  await daemon.tick();
  assert.equal(provider.calls.length, 0);
  assert.equal(daemon.snapshot.activeTask, null);
  assert.equal(
    client.receivedBatches.flatMap((batch) => batch.events).filter((event) => event.payload.type === "task_completed").length,
    1,
  );
  await daemon.shutdown();
});

test("cooperative interrupt settles at an action boundary and preserves the queued work", async () => {
  const root = await temporaryDirectory();
  const config = configFixture(root);
  const client = new FakeControlPlane();
  const provider = new FakeProviderAdapter();
  const daemon = await SupervisorDaemon.create({ config, client, provider });
  await daemon.tick();
  const epoch = daemon.snapshot.runtimeEpoch;

  client.enqueue({ type: "assign_task", task: taskFixture("task-active") }, epoch);
  await daemon.tick();
  const queued = client.enqueue({ type: "assign_task", task: taskFixture("task-queued") }, epoch);
  await daemon.handleCommand(queued);
  const interrupt = client.enqueue({ type: "request_interrupt", reason: "Human review requested" }, epoch);
  await daemon.handleCommand(interrupt);

  const snapshot = daemon.snapshot;
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.activeTask?.taskId, "task-active");
  assert.deepEqual(snapshot.queuedTasks.map((task) => task.taskId), ["task-queued"]);
  assert.equal(provider.interruptSettlements, 1);
  assert.equal(snapshot.checkpoint?.interrupt.state, "settled");
  assert.equal(snapshot.checkpoint?.interrupt.commandId, interrupt.commandId);
  assert.equal(snapshot.checkpoint?.timing?.expectedAgentMinutes, FORECAST_MINUTES);
  assert.equal(snapshot.checkpoint?.timing?.expectedCompletedAt, FORECAST_COMPLETES_AT);

  const records = (await readFile(join(config.stateDirectory, "runtime-outbox.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { payload: { type: string } });
  assert.deepEqual(records.map((record) => record.payload.type), ["interrupt_acknowledged", "interrupt_settled"]);
  await daemon.shutdown();
});

test("a durable workspace hold survives supervisor restart without command replay", async () => {
  const root = await temporaryDirectory();
  const config = configFixture(root);
  const client = new FakeControlPlane();
  const first = await SupervisorDaemon.create({
    config,
    client,
    provider: new FakeProviderAdapter(),
  });
  await first.tick();
  await first.handleCommand(
    client.enqueue(
      { type: "hold", reason: "Human paused the workspace for review" },
      first.snapshot.runtimeEpoch,
    ),
  );
  assert.equal(first.snapshot.state, "held");
  assert.equal(first.snapshot.checkpoint?.desiredState, "held");
  await first.shutdown();

  const restarted = await SupervisorDaemon.create({
    config: configFixture(root, { runtimeInstanceId: "runtime-test-after-hold" }),
    client,
    provider: new FakeProviderAdapter(),
  });
  assert.equal(restarted.snapshot.state, "starting");
  assert.equal(restarted.snapshot.checkpoint?.desiredState, "held");
  await restarted.tick();
  assert.equal(restarted.snapshot.state, "held");
  await restarted.shutdown();
});

test("failed tests continue RPET and preserve the exact 15-minute forecast", async () => {
  const root = await temporaryDirectory();
  const client = new FakeControlPlane();
  const provider = new FakeProviderAdapter({ testOutcomes: ["failed", "passed"] });
  const daemon = await SupervisorDaemon.create({ config: configFixture(root), client, provider });
  await daemon.tick();
  client.enqueue({ type: "assign_task", task: taskFixture() }, daemon.snapshot.runtimeEpoch);

  for (let step = 0; step < 4; step += 1) await daemon.tick();
  assert.equal(daemon.snapshot.activeTask?.taskId, "task-one");
  assert.equal(daemon.snapshot.checkpoint?.iteration, 2);
  assert.equal(daemon.snapshot.checkpoint?.phase, "research");
  assert.equal(daemon.snapshot.checkpoint?.timing?.expectedAgentMinutes, 15);
  assert.equal(daemon.snapshot.checkpoint?.timing?.expectedCompletedAt, FORECAST_COMPLETES_AT);

  for (let step = 0; step < 4; step += 1) await daemon.tick();
  assert.equal(daemon.snapshot.activeTask, null);
  assert.equal(daemon.snapshot.checkpoint?.timing?.expectedAgentMinutes, 15);
  assert.equal(daemon.snapshot.checkpoint?.timing?.expectedCompletedAt, FORECAST_COMPLETES_AT);
  assert.deepEqual(provider.calls.map((call) => `${call.iteration}:${call.phase}`), [
    "1:research", "1:plan", "1:execute", "1:test",
    "2:research", "2:plan", "2:execute", "2:test",
  ]);
  await daemon.shutdown();
});
