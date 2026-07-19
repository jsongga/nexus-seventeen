import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  createControlPlane,
  type ControlPlaneService,
} from "@cicada/steward-control-plane";
import {
  STEWARD_RUNTIME_API_VERSION,
  STEWARD_UI_API_VERSION,
  parseHumanCommandEnvelope,
  parseHumanCommandReceipt,
  parseRuntimeEventBatch,
  parseUiBootstrap,
  type AgentId,
  type HumanCommandEnvelope,
  type HumanCommandPayload,
  type IsoTimestamp,
  type LaneId,
  type UiBootstrap,
  type WorkspaceId,
} from "@cicada/steward-protocol";
import {
  ControlPlaneUnavailableError,
  FakeProviderAdapter,
  HttpSupervisorControlPlaneClient,
  SupervisorDaemon,
  parseSupervisorConfig,
  type SupervisorConfig,
} from "@cicada/steward-supervisor";

const WORKSPACE_ID = "workspace-integration" as WorkspaceId;
const AGENT_ID = "agent-engineer" as AgentId;
const LANE_ID = "lane-engineer" as LaneId;
const RUNTIME_INSTANCE_ID = "runtime-engineer";
const SUPERVISOR_TOKEN = "integration-supervisor-token";
const HUMAN_TOKEN = "integration-human-token";
const OBSERVER_TOKEN = "integration-observer-token";
const CONTROL_TIME = "2026-07-18T20:00:00.000Z";
const EXPECTED_COMPLETED_AT = "2026-07-18T20:15:00.000Z" as IsoTimestamp;
const TEST_TIMEOUT_MS = 20_000;

interface TestResources {
  directories: string[];
  daemons: SupervisorDaemon[];
  services: ControlPlaneService[];
}

const resources: TestResources = {
  directories: [],
  daemons: [],
  services: [],
};

afterEach(async () => {
  for (const daemon of resources.daemons.splice(0).reverse()) {
    await daemon.shutdown().catch(() => undefined);
  }
  for (const service of resources.services.splice(0).reverse()) {
    await service.close().catch(() => undefined);
  }
  await Promise.all(
    resources.directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steward-http-integration-"));
  resources.directories.push(root);
  await mkdir(join(root, "workspace", "project"), { recursive: true });
  return root;
}

async function startControlPlane(root: string): Promise<{
  service: ControlPlaneService;
  url: string;
}> {
  const service = await createControlPlane({
    workspaceId: WORKSPACE_ID,
    storePath: join(root, "control-plane", "events.jsonl"),
    workloadIdentities: [{
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      laneId: LANE_ID,
      role: "engineer",
      token: SUPERVISOR_TOKEN,
    }],
    humanToken: HUMAN_TOKEN,
    observerReadToken: OBSERVER_TOKEN,
    leaseMs: 60_000,
    keepAliveMs: 1_000,
    now: () => new Date(CONTROL_TIME),
  });
  resources.services.push(service);
  const { url } = await service.start();
  return { service, url };
}

function supervisorConfig(
  root: string,
  controlPlaneUrl: string,
  runtimeInstanceId = RUNTIME_INSTANCE_ID,
): SupervisorConfig {
  return parseSupervisorConfig({
    controlPlaneUrl,
    supervisorToken: SUPERVISOR_TOKEN,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    laneId: LANE_ID,
    runtimeInstanceId,
    displayName: "Cicada engineer",
    role: "engineer",
    provider: { name: "codex", model: "fake-integration-model" },
    softwareVersion: "0.1.0",
    workingDirectory: join(root, "workspace", "project"),
    stateDirectory: join(root, "supervisor", "state"),
    leaseIntervalMs: 60_000,
  });
}

function runtimeClient(controlPlaneUrl: string): HttpSupervisorControlPlaneClient {
  return new HttpSupervisorControlPlaneClient({
    controlPlaneUrl,
    supervisorToken: SUPERVISOR_TOKEN,
    timeoutMs: 2_000,
    maxAttempts: 1,
    baseBackoffMs: 0,
    maxBackoffMs: 0,
    sleep: async () => undefined,
    random: () => 0,
  });
}

async function createDaemon(
  root: string,
  controlPlaneUrl: string,
  provider: FakeProviderAdapter,
  runtimeInstanceId = RUNTIME_INSTANCE_ID,
): Promise<SupervisorDaemon> {
  const daemon = await SupervisorDaemon.create({
    config: supervisorConfig(root, controlPlaneUrl, runtimeInstanceId),
    client: runtimeClient(controlPlaneUrl),
    provider,
    clock: () => new Date(CONTROL_TIME),
    sleep: async () => undefined,
    loopIntervalMs: 10,
  });
  resources.daemons.push(daemon);
  return daemon;
}

async function postHumanCommand(
  controlPlaneUrl: string,
  clientCommandId: string,
  expectedControlVersion: number,
  payload: HumanCommandPayload,
): Promise<void> {
  const command: HumanCommandEnvelope = parseHumanCommandEnvelope({
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId,
    workspaceId: WORKSPACE_ID,
    expectedControlVersion,
    issuedAt: CONTROL_TIME,
    payload,
  });
  const response = await fetch(`${controlPlaneUrl}/v1/ui/commands`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${HUMAN_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const receipt = parseHumanCommandReceipt(body);
  assert.equal(receipt.state, "accepted");
  assert.equal(receipt.currentControlVersion, expectedControlVersion + 1);
}

async function bootstrap(controlPlaneUrl: string): Promise<UiBootstrap> {
  const response = await fetch(`${controlPlaneUrl}/v1/ui/bootstrap`, {
    headers: { authorization: `Bearer ${HUMAN_TOKEN}` },
  });
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return parseUiBootstrap(body);
}

async function assertNoFrontendSubscribers(controlPlaneUrl: string): Promise<void> {
  const response = await fetch(`${controlPlaneUrl}/health`);
  assert.equal(response.status, 200);
  const health = (await response.json()) as { subscribers?: unknown };
  assert.equal(health.subscribers, 0);
}

function queuePayload(title: string): HumanCommandPayload {
  return {
    type: "queue_work",
    agentId: AGENT_ID,
    laneId: LANE_ID,
    title,
    objective: "Deliver a user-visible result through the research, plan, execute, test loop.",
    expectedAgentMinutes: 15,
    expectedCompletedAt: EXPECTED_COMPLETED_AT,
  };
}

test(
  "unattended HTTP work retries failed tests, survives restart, and fences the stale epoch",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const root = await temporaryRoot();
    const firstControlPlane = await startControlPlane(root);
    const provider = new FakeProviderAdapter({ testOutcomes: ["failed", "passed"] });
    const daemon = await createDaemon(root, firstControlPlane.url, provider);

    await daemon.tick();
    assert.equal(daemon.snapshot.state, "active");
    assert.equal(daemon.snapshot.runtimeEpoch, 1);
    assert.equal(firstControlPlane.service.projection.lanes.size, 1);

    await postHumanCommand(
      firstControlPlane.url,
      "queue-retry-work",
      0,
      queuePayload("Repair mobile task controls"),
    );

    await daemon.tick();
    const taskId = daemon.snapshot.activeTask?.taskId;
    assert.ok(taskId);
    assert.equal(firstControlPlane.service.projection.requireTask(taskId).status, "running");
    assert.equal(firstControlPlane.service.projection.requireLane(LANE_ID).currentAction?.taskId, taskId);
    assert.equal(firstControlPlane.service.projection.progress.get(taskId)?.length, 1);

    for (let remainingStep = 0; remainingStep < 7; remainingStep += 1) {
      await daemon.tick();
    }
    assert.equal(daemon.snapshot.activeTask, null);
    assert.equal(daemon.snapshot.pendingOutboxEvents, 0);
    assert.deepEqual(
      provider.calls.map((call) => `${call.iteration}:${call.phase}`),
      [
        "1:research",
        "1:plan",
        "1:execute",
        "1:test",
        "2:research",
        "2:plan",
        "2:execute",
        "2:test",
      ],
    );

    await assertNoFrontendSubscribers(firstControlPlane.url);
    const beforeRestart = await bootstrap(firstControlPlane.url);
    assert.equal(beforeRestart.snapshot.agents.length, 1);
    const discoveredAgent = beforeRestart.snapshot.agents[0];
    assert.equal(discoveredAgent?.agentId, AGENT_ID);
    assert.equal(discoveredAgent?.role, "engineer");
    assert.equal(discoveredAgent?.provider.model, "fake-integration-model");

    const completedTask = beforeRestart.snapshot.tasks.find((task) => task.taskId === taskId);
    assert.ok(completedTask);
    assert.equal(completedTask.status, "completed");
    assert.equal(completedTask.expectedAgentMinutes, 15);
    assert.equal(completedTask.expectedCompletedAt, EXPECTED_COMPLETED_AT);
    assert.ok(completedTask.startedAt);
    assert.ok(completedTask.endedAt);
    assert.ok(Date.parse(completedTask.endedAt) >= Date.parse(completedTask.startedAt));

    const taskProgress = beforeRestart.snapshot.progress.filter((entry) => entry.taskId === taskId);
    assert.deepEqual(
      taskProgress.map((entry) =>
        entry.phase === "test"
          ? `${entry.iteration}:${entry.phase}:${entry.outcome}`
          : `${entry.iteration}:${entry.phase}`,
      ),
      [
        "1:research",
        "1:plan",
        "1:execute",
        "1:test:failed",
        "2:research",
        "2:plan",
        "2:execute",
        "2:test:passed",
      ],
    );
    assert.equal(completedTask.startedAt, CONTROL_TIME);
    assert.ok(Date.parse(taskProgress[0]!.occurredAt) >= Date.parse(completedTask.startedAt));

    await daemon.shutdown();
    resources.daemons.splice(resources.daemons.indexOf(daemon), 1);
    await firstControlPlane.service.close();
    resources.services.splice(resources.services.indexOf(firstControlPlane.service), 1);

    const restartedControlPlane = await startControlPlane(root);
    const afterRestart = await bootstrap(restartedControlPlane.url);
    const rebuiltTask = afterRestart.snapshot.tasks.find((task) => task.taskId === taskId);
    assert.ok(rebuiltTask);
    assert.equal(rebuiltTask.startedAt, completedTask.startedAt);
    assert.equal(rebuiltTask.endedAt, completedTask.endedAt);
    assert.deepEqual(afterRestart.snapshot.progress, beforeRestart.snapshot.progress);

    const replacementProvider = new FakeProviderAdapter();
    const replacementDaemon = await createDaemon(
      root,
      restartedControlPlane.url,
      replacementProvider,
      "runtime-engineer-replacement",
    );
    await replacementDaemon.tick();
    assert.equal(replacementDaemon.snapshot.runtimeEpoch, 2);
    assert.equal(replacementProvider.calls.length, 0, "completed work must not replay after restart");
    assert.equal(
      (await bootstrap(restartedControlPlane.url)).snapshot.agents[0]?.runtimeEpoch,
      2,
    );

    const staleSequence =
      restartedControlPlane.service.projection.requireLane(LANE_ID).lastAcceptedLocalSequence + 1;
    const staleBatch = parseRuntimeEventBatch({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      laneId: LANE_ID,
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      runtimeEpoch: 1,
      events: [
        {
          apiVersion: STEWARD_RUNTIME_API_VERSION,
          eventId: "stale-epoch-heartbeat",
          workspaceId: WORKSPACE_ID,
          agentId: AGENT_ID,
          laneId: LANE_ID,
          runtimeInstanceId: RUNTIME_INSTANCE_ID,
          localSequence: staleSequence,
          runtimeEpoch: 1,
          occurredAt: CONTROL_TIME,
          payload: { type: "heartbeat", currentAction: null, checkpointRef: null },
        },
      ],
    });
    await assert.rejects(
      runtimeClient(restartedControlPlane.url).uploadEvents(staleBatch),
      (error: unknown) =>
        error instanceof ControlPlaneUnavailableError &&
        error.status === 409 &&
        error.retryable === false,
    );
  },
);

test(
  "human queue and interrupt commands pause active work without losing later work",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const root = await temporaryRoot();
    const controlPlane = await startControlPlane(root);
    const provider = new FakeProviderAdapter();
    const daemon = await createDaemon(root, controlPlane.url, provider);
    await daemon.tick();

    await postHumanCommand(controlPlane.url, "queue-active", 0, queuePayload("Deliver first result"));
    await postHumanCommand(controlPlane.url, "queue-later", 1, queuePayload("Deliver second result"));
    await daemon.tick();
    const activeTaskId = daemon.snapshot.activeTask?.taskId;
    assert.ok(activeTaskId);
    assert.equal(provider.calls.length, 1);

    await postHumanCommand(controlPlane.url, "interrupt-active", 2, {
      type: "request_interrupt",
      agentId: AGENT_ID,
      laneId: LANE_ID,
      reason: "A human needs to inspect the current result.",
    });
    await daemon.tick();
    await daemon.tick();
    assert.equal(daemon.snapshot.state, "paused");
    assert.equal(daemon.snapshot.activeTask?.taskId, activeTaskId);
    assert.deepEqual(
      daemon.snapshot.queuedTasks.map((task) => task.title),
      ["Deliver second result"],
    );
    assert.equal(provider.interruptSettlements, 1);

    await postHumanCommand(controlPlane.url, "queue-while-paused", 3, queuePayload("Deliver third result"));
    await daemon.tick();
    assert.equal(daemon.snapshot.state, "paused");
    assert.deepEqual(
      daemon.snapshot.queuedTasks.map((task) => task.title),
      ["Deliver second result", "Deliver third result"],
    );
    assert.equal(provider.calls.length, 1, "queued work must not run until a human resumes the agent");

    await daemon.tick();
    await assertNoFrontendSubscribers(controlPlane.url);
    const view = await bootstrap(controlPlane.url);
    const activeTask = view.snapshot.tasks.find((task) => task.taskId === activeTaskId);
    assert.equal(activeTask?.status, "paused");
    assert.deepEqual(
      view.snapshot.tasks.map((task) => task.title).sort(),
      ["Deliver first result", "Deliver second result", "Deliver third result"],
    );
    assert.equal(view.snapshot.agents[0]?.controlState, "paused");
    assert.equal(view.snapshot.agents[0]?.queue.length, 3);
  },
);
