import { FrozenEvidenceFileInspector } from "./inspector.js";
import { HttpManagerReviewClient, HttpManagerRuntimeControlClient } from "./http-clients.js";
import { createManagerRuntimeInstanceId } from "./process-identity.js";
import { ManagerRuntime } from "./runner.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function optionalInteger(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

const provider = required("STEWARD_MANAGER_PROVIDER");
if (provider !== "codex" && provider !== "claude") throw new Error("STEWARD_MANAGER_PROVIDER is invalid");
const maxReviewIterations = optionalInteger("STEWARD_MANAGER_MAX_REVIEW_ITERATIONS");
const pollIntervalMs = optionalInteger("STEWARD_MANAGER_POLL_INTERVAL_MS");

const runtime = await ManagerRuntime.create({
  identity: {
    workspaceId: required("STEWARD_MANAGER_WORKSPACE_ID"),
    agentId: required("STEWARD_MANAGER_AGENT_ID"),
    laneId: required("STEWARD_MANAGER_LANE_ID"),
    runtimeInstanceId: createManagerRuntimeInstanceId(),
    displayName: required("STEWARD_MANAGER_DISPLAY_NAME"),
    provider: { name: provider, model: required("STEWARD_MANAGER_MODEL") },
    softwareVersion: process.env.STEWARD_MANAGER_SOFTWARE_VERSION ?? "0.1.0",
  },
  statePath: required("STEWARD_MANAGER_STATE_PATH"),
  control: new HttpManagerRuntimeControlClient({
    baseUrl: required("STEWARD_MANAGER_CONTROL_PLANE_URL"),
    token: required("STEWARD_MANAGER_CONTROL_PLANE_TOKEN"),
  }),
  reviews: new HttpManagerReviewClient({
    baseUrl: required("STEWARD_MANAGER_REVIEW_URL"),
    token: required("STEWARD_MANAGER_REVIEW_TOKEN"),
  }),
  inspector: new FrozenEvidenceFileInspector({
    evidenceDirectory: required("STEWARD_MANAGER_READONLY_EVIDENCE_DIR"),
  }),
  ...(maxReviewIterations === undefined ? {} : { maxReviewIterations }),
  ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
});

const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
try {
  await runtime.run(stop.signal);
} finally {
  await runtime.close();
}
