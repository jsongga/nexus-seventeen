import assert from "node:assert/strict";
import test from "node:test";
import { loadManagerReviewRuntimeConfig } from "../src/runtime-config.js";

const EVIDENCE_TOKEN = "evidence-issuer-token-0000000000000001";
const HUMAN_TOKEN = "human-review-token-000000000000000001";
const MANAGER_TOKEN = "manager-runtime-token-0000000000000001";
const BROKER_TOKEN = "broker-handoff-token-000000000000000001";

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
    STEWARD_MANAGER_REVIEW_PORT: "4210",
  };
}

test("runtime configuration parses a fixed manager roster without logging or weakening capabilities", () => {
  const config = loadManagerReviewRuntimeConfig(environment());
  assert.equal(config.workspaceId, "workspace-runtime");
  assert.equal(config.port, 4210);
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
});
