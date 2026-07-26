import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DurableOutbox, type OutboxIdentity } from "#server/agents/supervisor/outbox";
import { registrationIdentity } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((pathname) => rm(pathname, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const pathname = await mkdtemp(join(tmpdir(), "steward-outbox-"));
  temporaryDirectories.push(pathname);
  return pathname;
}

function identity(runtimeInstanceId = "runtime-test"): OutboxIdentity {
  const registration = registrationIdentity();
  return {
    apiVersion: registration.apiVersion,
    workspaceId: registration.workspaceId,
    agentId: registration.agentId,
    laneId: registration.laneId,
    runtimeInstanceId,
  };
}

test("restart preserves replay identity and rebases only the unaccepted suffix", async () => {
  const stateDirectory = await temporaryDirectory();
  const first = await DurableOutbox.open({ stateDirectory, identity: identity(), runtimeEpoch: 1 });
  const accepted = await first.append({ type: "heartbeat", currentAction: null, checkpointRef: null });
  const unsent = await first.append({ type: "heartbeat", currentAction: null, checkpointRef: null });
  await first.flush();

  const restarted = await DurableOutbox.open({
    stateDirectory,
    identity: identity("runtime-replacement"),
    runtimeEpoch: 2,
  });
  assert.deepEqual(restarted.pending().map((event) => event.runtimeEpoch), [1, 1], "startup must not mutate possible server evidence");

  // Registration reports that the response for sequence 1 was lost locally.
  await restarted.acknowledge(accepted.localSequence);
  await restarted.rebindPendingToRuntime(2);
  const replay = restarted.pending();
  assert.equal(replay.length, 1);
  assert.equal(replay[0]!.eventId, unsent.eventId);
  assert.equal(replay[0]!.localSequence, unsent.localSequence);
  assert.equal(replay[0]!.occurredAt, unsent.occurredAt);
  assert.deepEqual(replay[0]!.payload, unsent.payload);
  assert.equal(replay[0]!.runtimeEpoch, 2);
  assert.equal(replay[0]!.runtimeInstanceId, "runtime-replacement");

  const next = await restarted.append({ type: "heartbeat", currentAction: null, checkpointRef: null });
  assert.equal(next.localSequence, 3);
  assert.equal(next.runtimeEpoch, 2);
  assert.equal(next.runtimeInstanceId, "runtime-replacement");
});

test("acknowledgement compacts the fsync-backed JSONL log", async () => {
  const stateDirectory = await temporaryDirectory();
  const outbox = await DurableOutbox.open({ stateDirectory, identity: identity(), runtimeEpoch: 1 });
  await outbox.append({ type: "heartbeat", currentAction: null, checkpointRef: null });
  await outbox.append({ type: "heartbeat", currentAction: null, checkpointRef: null });
  const third = await outbox.append({ type: "heartbeat", currentAction: null, checkpointRef: null });

  await outbox.acknowledge(2);
  const compacted = await readFile(join(stateDirectory, "runtime-outbox.jsonl"), "utf8");
  const records = compacted.trim().split("\n").map((line) => JSON.parse(line) as { localSequence: number });
  assert.deepEqual(records.map((record) => record.localSequence), [3]);

  const reopened = await DurableOutbox.open({ stateDirectory, identity: identity(), runtimeEpoch: 1 });
  assert.equal(reopened.acknowledgedThrough, 2);
  assert.equal(reopened.lastSequence, 3);
  assert.equal(reopened.pending()[0]!.eventId, third.eventId);
  await reopened.acknowledge(3);
  assert.equal(await readFile(join(stateDirectory, "runtime-outbox.jsonl"), "utf8"), "");
});

test("a torn final append is discarded before crash-safe epoch reconciliation", async () => {
  const stateDirectory = await temporaryDirectory();
  const first = await DurableOutbox.open({ stateDirectory, identity: identity(), runtimeEpoch: 4 });
  const durable = await first.append({ type: "heartbeat", currentAction: null, checkpointRef: null });
  await appendFile(join(stateDirectory, "runtime-outbox.jsonl"), '{"partial":', "utf8");

  const restarted = await DurableOutbox.open({ stateDirectory, identity: identity(), runtimeEpoch: 5 });
  assert.equal(restarted.pendingCount, 1);
  assert.equal(restarted.pending()[0]!.eventId, durable.eventId);
  assert.equal(restarted.pending()[0]!.runtimeEpoch, 4);
  await restarted.rebasePendingToEpoch(5);

  const diskRecord = JSON.parse((await readFile(join(stateDirectory, "runtime-outbox.jsonl"), "utf8")).trim()) as {
    eventId: string;
    runtimeEpoch: number;
  };
  assert.equal(diskRecord.eventId, durable.eventId);
  assert.equal(diskRecord.runtimeEpoch, 5);
});
