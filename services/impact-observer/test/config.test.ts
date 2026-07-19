import assert from "node:assert/strict";
import test from "node:test";
import { loadImpactObserverConfig } from "../src/config.js";
import { testModelCatalog } from "./helpers.js";

function environment(): NodeJS.ProcessEnv {
  return {
    STEWARD_CONTROL_PLANE_URL: "https://control.example",
    STEWARD_WORKSPACE_ID: "workspace-one",
    STEWARD_IMPACT_READ_TOKEN: "command-capable-read-token-0001",
    STEWARD_IMPACT_OUTPUT_TOKEN: "separate-output-token-0001",
    STEWARD_IMPACT_STATE_PATH: "/tmp/steward-impact-test/state.json",
    STEWARD_IMPACT_FAKE_MODEL: "true",
    STEWARD_MODEL_CATALOG_JSON: JSON.stringify(testModelCatalog()),
  };
}

test("config requires a separate frontend token and exact control-plane origin", () => {
  const config = loadImpactObserverConfig(environment());
  assert.equal(config.controlPlaneOrigin, "https://control.example");
  assert.equal(config.limits.maxInputTokens, 512);
  assert.equal(config.modelCatalog.claude.economy.modelId, "claude-economy-caller-configured-test-id");
  assert.equal(config.modelCatalog.claude.economy.rateCard?.inputPerMillionTokens, 0.125);
  assert.throws(
    () => loadImpactObserverConfig({
      ...environment(),
      STEWARD_IMPACT_OUTPUT_TOKEN: environment().STEWARD_IMPACT_READ_TOKEN,
    }),
    /must differ/u,
  );
  assert.throws(
    () => loadImpactObserverConfig({ ...environment(), STEWARD_CONTROL_PLANE_URL: "https://control.example/path" }),
    /without credentials, path/u,
  );
});

test("config requires an exact, caller-supplied six-profile model catalog", () => {
  assert.throws(
    () => loadImpactObserverConfig({ ...environment(), STEWARD_MODEL_CATALOG_JSON: undefined }),
    /MODEL_CATALOG_JSON is required/u,
  );
  const catalog = structuredClone(testModelCatalog()) as Record<string, unknown>;
  catalog.unexpected = {};
  assert.throws(
    () => loadImpactObserverConfig({ ...environment(), STEWARD_MODEL_CATALOG_JSON: JSON.stringify(catalog) }),
    /must contain exactly/u,
  );
});
