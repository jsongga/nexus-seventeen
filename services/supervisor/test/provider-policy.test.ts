import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { parseAgentTaskProjection } from "@cicada/steward-protocol";
import { SupervisorDaemon } from "../src/daemon.js";
import {
  authorizeProviderPhase,
  operationsForProviderPhase,
  ProviderPolicyDeniedError,
} from "../src/provider-policy.js";
import { FakeProviderAdapter } from "../src/provider.js";
import { RpetRunner } from "../src/rpet.js";
import { FakeControlPlane, configFixture, taskFixture } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steward-policy-"));
  await mkdir(join(root, "workspace/project"), { recursive: true });
  temporaryDirectories.push(root);
  return root;
}

test("host-owned RPET phase mapping authorizes the exact semantic operations", () => {
  assert.deepEqual(operationsForProviderPhase("research"), ["context.read", "research.perform", "progress.record"]);
  assert.deepEqual(operationsForProviderPhase("plan"), ["context.read", "plan.record", "progress.record"]);
  assert.deepEqual(operationsForProviderPhase("execute"), ["context.read", "workspace.modify", "progress.record"]);
  assert.deepEqual(operationsForProviderPhase("test"), [
    "context.read",
    "tests.run",
    "progress.record",
  ]);
  assert.deepEqual(authorizeProviderPhase("engineer", "execute"), {
    role: "engineer",
    phase: "execute",
    operations: ["context.read", "workspace.modify", "progress.record"],
  });
  assert.throws(
    () => authorizeProviderPhase("verifier", "execute"),
    (error: unknown) => error instanceof ProviderPolicyDeniedError,
  );
  assert.throws(
    () => authorizeProviderPhase("manager", "execute"),
    (error: unknown) => error instanceof ProviderPolicyDeniedError,
  );
});

test("verifier and manager cannot construct or reach the modifying RPET provider path", () => {
  for (const role of ["verifier", "manager"] as const) {
    const provider = new FakeProviderAdapter();
    assert.throws(
      () => new RpetRunner(taskFixture(), { role, initialPhase: "execute" }),
      (error: unknown) => error instanceof ProviderPolicyDeniedError,
    );
    assert.equal(provider.calls.length, 0);
  }
});

test("non-engineer task assignment is durably denied without invoking an adapter", async () => {
  for (const role of ["verifier", "manager"] as const) {
    const root = await temporaryDirectory();
    const provider = new FakeProviderAdapter();
    const client = new FakeControlPlane();
    const daemon = await SupervisorDaemon.create({
      config: configFixture(root, { role, runtimeInstanceId: `runtime-${role}` }),
      client,
      provider,
    });
    await daemon.tick();
    await daemon.handleCommand(client.enqueue(
      { type: "assign_task", task: taskFixture(`task-${role}`) },
      daemon.snapshot.runtimeEpoch,
    ));
    assert.equal(provider.calls.length, 0);
    assert.equal(daemon.snapshot.activeTask, null);
    assert.deepEqual(daemon.snapshot.queuedTasks, []);
    assert.equal(daemon.snapshot.state, "held");
    const records = (await readFile(join(configFixture(root).stateDirectory, "runtime-outbox.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { payload: { type: string; error?: string } });
    assert.equal(records.at(-1)?.payload.type, "task_failed");
    assert.match(records.at(-1)?.payload.error ?? "", /only engineers/i);
    await daemon.shutdown();
  }
});

test("generic supervisors hold a recovered manager review without rewriting its lifecycle", async () => {
  const root = await temporaryDirectory();
  const provider = new FakeProviderAdapter();
  const client = new FakeControlPlane();
  const daemon = await SupervisorDaemon.create({
    config: configFixture(root, { role: "manager", runtimeInstanceId: "runtime-manager-recovery" }),
    client,
    provider,
  });
  await daemon.tick();
  const reviewTask = parseAgentTaskProjection({
    ...taskFixture("task-manager-review"),
    subject: {
      type: "manager_review",
      sourceTaskId: "task-source",
      evidenceId: "evidence-source",
      evidenceDigest: `sha256:${"a".repeat(64)}`,
    },
    status: "running",
    startedAt: "2026-07-18T20:00:00.000Z",
  });

  await daemon.handleCommand(client.enqueue(
    { type: "recover_task", task: reviewTask },
    daemon.snapshot.runtimeEpoch,
  ));

  assert.equal(provider.calls.length, 0);
  assert.equal(daemon.snapshot.activeTask, null);
  assert.deepEqual(daemon.snapshot.queuedTasks, []);
  assert.equal(daemon.snapshot.state, "held");
  assert.equal(reviewTask.status, "running");
  assert.equal(reviewTask.startedAt, "2026-07-18T20:00:00.000Z");
  assert.equal(daemon.snapshot.pendingOutboxEvents, 0, "recovery must not emit task_failed");
  await daemon.shutdown();
});
