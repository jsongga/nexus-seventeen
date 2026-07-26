import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDisjointSupervisorDirectories, loadSupervisorConfig } from "#server/agents/supervisor/config";
import { loadProviderAdapter, toProviderAdapterConfig } from "#server/agents/supervisor/main";
import { RoleRestrictedProviderAdapter } from "#server/agents/supervisor/provider";
import { configFixture } from "./helpers.js";

test("provider adapter configuration cannot receive control-plane credentials or supervisor state paths", () => {
  const adapterConfig = toProviderAdapterConfig(configFixture("/tmp/steward-main-test"));
  assert.deepEqual(Object.keys(adapterConfig).sort(), [
    "agentId",
    "laneId",
    "model",
    "providerName",
    "role",
    "workingDirectory",
    "workspaceId",
  ]);
  assert.equal("supervisorToken" in adapterConfig, false);
  assert.equal("controlPlaneUrl" in adapterConfig, false);
  assert.equal("stateDirectory" in adapterConfig, false);
});

test("supervisor state and agent-writable workspace paths must be disjoint", () => {
  assert.throws(
    () => assertDisjointSupervisorDirectories(
      "/tmp/steward/workspace/project",
      "/tmp/steward/workspace/project/.steward/state",
    ),
    /must be disjoint/i,
  );
  assert.throws(
    () => assertDisjointSupervisorDirectories(
      "/tmp/steward/state",
      "/tmp/steward/state/workspace/project",
    ),
    /must be disjoint/i,
  );
});

test("production config creates a fresh boot identity and rejects operator-supplied runtime IDs", async () => {
  const env: NodeJS.ProcessEnv = {
    STEWARD_CONTROL_PLANE_URL: "https://control.example.test",
    STEWARD_SUPERVISOR_TOKEN: "test-supervisor-token-0001",
    STEWARD_WORKSPACE_ID: "workspace-test",
    STEWARD_AGENT_ID: "agent-test",
    STEWARD_LANE_ID: "lane-test",
    STEWARD_DISPLAY_NAME: "Test engineer",
    STEWARD_ROLE: "engineer",
    STEWARD_PROVIDER_NAME: "codex",
    STEWARD_PROVIDER_MODEL: "test-model",
    STEWARD_SOFTWARE_VERSION: "0.1.0",
    STEWARD_WORKING_DIRECTORY: "/tmp/steward-main/workspace/project",
    STEWARD_STATE_DIRECTORY: "/tmp/steward-main/state/supervisor",
    STEWARD_LEASE_INTERVAL_MS: "1000",
  };
  const first = await loadSupervisorConfig({
    env,
    configFilePath: null,
    runtimeInstanceIdFactory: () => "runtime-first-boot",
  });
  const second = await loadSupervisorConfig({
    env,
    configFilePath: null,
    runtimeInstanceIdFactory: () => "runtime-second-boot",
  });
  assert.equal(first.runtimeInstanceId, "runtime-first-boot");
  assert.equal(second.runtimeInstanceId, "runtime-second-boot");
  await assert.rejects(
    loadSupervisorConfig({
      env: { ...env, STEWARD_RUNTIME_INSTANCE_ID: "runtime-stale" },
      configFilePath: null,
    }),
    /must not be supplied/i,
  );
  await assert.rejects(
    loadSupervisorConfig({
      env: { ...env, STEWARD_CONTROL_PLANE_URL: "http://control.example.test" },
      configFilePath: null,
      runtimeInstanceIdFactory: () => "runtime-remote-http",
    }),
    /only for exact loopback/i,
  );
  const loopback = await loadSupervisorConfig({
    env: { ...env, STEWARD_CONTROL_PLANE_URL: "http://127.0.0.1:3001" },
    configFilePath: null,
    runtimeInstanceIdFactory: () => "runtime-loopback-http",
  });
  assert.equal(loopback.controlPlaneUrl, "http://127.0.0.1:3001");
});

test("real providers fail closed to subprocess configuration and fake providers are barred in production", async () => {
  const engineer = configFixture("/tmp/steward-main-provider");
  await assert.rejects(
    loadProviderAdapter(engineer, { NODE_ENV: "production", STEWARD_FAKE_PROVIDER: "true" }),
    /only when NODE_ENV=test/i,
  );
  await assert.rejects(
    loadProviderAdapter(engineer, { STEWARD_FAKE_PROVIDER: "true" }),
    /only when NODE_ENV=test/i,
  );
  const fake = await loadProviderAdapter(engineer, {
    NODE_ENV: "test",
    STEWARD_FAKE_PROVIDER: "true",
  });
  await fake.shutdown();
  await assert.rejects(
    loadProviderAdapter(engineer, { NODE_ENV: "production" }),
    /STEWARD_PROVIDER_ADAPTER_MODULE/,
  );

  const manager = configFixture("/tmp/steward-main-manager", { role: "manager" });
  const restricted = await loadProviderAdapter(manager, {
    NODE_ENV: "production",
    STEWARD_PROVIDER_ADAPTER_MODULE: "/path/that/must/not/be/imported.mjs",
  });
  assert.ok(restricted instanceof RoleRestrictedProviderAdapter);
  await restricted.shutdown();
});
