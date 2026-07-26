import assert from "node:assert/strict";
import test from "node:test";
import { loadManagerReviewRuntimeConfig } from "#server/review/manager-review/runtime-config";

const EVIDENCE_TOKEN = "evidence-issuer-token-0000000000000001";
const HUMAN_TOKEN = "human-review-token-000000000000000001";
const MANAGER_TOKEN = "manager-runtime-token-0000000000000001";
const BROKER_TOKEN = "broker-handoff-token-000000000000000001";
const OBSERVER_TOKEN = "control-plane-observer-token-000000000001";
const PERMIT_TOKEN = "control-plane-review-permit-token-00000001";

function environment(): NodeJS.ProcessEnv {
  return {
    STEWARD_MANAGER_REVIEW_WORKSPACE_ID: "workspace-runtime",
    STEWARD_MANAGER_REVIEW_STORE_PATH: "/tmp/steward-manager-review/events.jsonl",
    STEWARD_MANAGER_REVIEW_EVIDENCE_ISSUER_TOKEN: EVIDENCE_TOKEN,
    STEWARD_MANAGER_REVIEW_EVIDENCE_ISSUER_PRINCIPAL: "engineer-evidence-issuer",
    STEWARD_MANAGER_REVIEW_HUMAN_TOKEN: HUMAN_TOKEN,
    STEWARD_MANAGER_REVIEW_MANAGERS_JSON: JSON.stringify([{
      workspaceId: "workspace-runtime",
      agentId: "manager-runtime",
      laneId: "manager-lane-runtime",
      role: "manager",
      token: MANAGER_TOKEN,
    }]),
    STEWARD_MANAGER_REVIEW_BROKER_ORIGIN: "https://broker.example.test",
    STEWARD_MANAGER_REVIEW_BROKER_HANDOFF_ISSUER_TOKEN: BROKER_TOKEN,
    STEWARD_MANAGER_REVIEW_CONTROL_PLANE_ORIGIN: "https://control.example.test",
    STEWARD_MANAGER_REVIEW_CONTROL_PLANE_OBSERVER_READ_TOKEN: OBSERVER_TOKEN,
    STEWARD_MANAGER_REVIEW_CONTROL_PLANE_PERMIT_CONSUME_TOKEN: PERMIT_TOKEN,
    STEWARD_MANAGER_REVIEW_CONTROL_PLANE_TIMEOUT_MS: "2500",
    STEWARD_MANAGER_REVIEW_CONTROL_PLANE_MAX_BOOTSTRAP_BYTES: "131072",
    STEWARD_MANAGER_REVIEW_CONTROL_PLANE_MAX_SNAPSHOT_AGE_MS: "2000",
    STEWARD_MANAGER_REVIEW_CONTROL_PLANE_PERMIT_TIMEOUT_MS: "1800",
    STEWARD_MANAGER_REVIEW_CONTROL_PLANE_PERMIT_MAX_RESPONSE_BYTES: "65536",
    STEWARD_MANAGER_REVIEW_CORS_ORIGINS: "https://app.cicada.build, http://localhost:5173",
    STEWARD_MANAGER_REVIEW_PORT: "4210",
  };
}

test("runtime configuration parses a fixed manager roster without logging or weakening capabilities", () => {
  const config = loadManagerReviewRuntimeConfig(environment());
  assert.equal(config.workspaceId, "workspace-runtime");
  assert.equal(config.port, 4210);
  assert.equal(config.controlPlaneOrigin, "https://control.example.test");
  assert.equal(config.controlPlaneObserverReadToken, OBSERVER_TOKEN);
  assert.equal(config.controlPlanePermitConsumeToken, PERMIT_TOKEN);
  assert.equal(config.controlPlaneTimeoutMs, 2500);
  assert.equal(config.controlPlaneMaximumBootstrapBytes, 131072);
  assert.equal(config.controlPlaneMaximumSnapshotAgeMs, 2000);
  assert.equal(config.controlPlanePermitTimeoutMs, 1800);
  assert.equal(config.controlPlanePermitMaximumResponseBytes, 65536);
  assert.deepEqual(config.corsOrigins, ["https://app.cicada.build", "http://localhost:5173"]);
  assert.deepEqual(config.managers.map(({ token: _token, ...manager }) => manager), [{
    workspaceId: "workspace-runtime",
    agentId: "manager-runtime",
    laneId: "manager-lane-runtime",
    role: "manager",
  }]);
});

test("runtime configuration fails closed on unknown manager fields and reused capabilities", () => {
  const extra = environment();
  extra.STEWARD_MANAGER_REVIEW_MANAGERS_JSON = JSON.stringify([{
    workspaceId: "workspace-runtime",
    agentId: "manager-runtime",
    laneId: "manager-lane-runtime",
    role: "manager",
    token: MANAGER_TOKEN,
    canDeploy: true,
  }]);
  assert.throws(() => loadManagerReviewRuntimeConfig(extra), /unexpected or missing fields/u);

  const reused = environment();
  reused.STEWARD_MANAGER_REVIEW_BROKER_HANDOFF_ISSUER_TOKEN = HUMAN_TOKEN;
  assert.throws(() => loadManagerReviewRuntimeConfig(reused), /must all be distinct/u);

  const observerReused = environment();
  observerReused.STEWARD_MANAGER_REVIEW_CONTROL_PLANE_OBSERVER_READ_TOKEN = MANAGER_TOKEN;
  assert.throws(() => loadManagerReviewRuntimeConfig(observerReused), /must all be distinct/u);

  const permitReused = environment();
  permitReused.STEWARD_MANAGER_REVIEW_CONTROL_PLANE_PERMIT_CONSUME_TOKEN = HUMAN_TOKEN;
  assert.throws(() => loadManagerReviewRuntimeConfig(permitReused), /must all be distinct/u);
});
