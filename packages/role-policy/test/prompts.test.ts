import assert from "node:assert/strict";
import { test } from "node:test";

import { AGENT_ROLES, ROLE_SYSTEM_PROMPTS } from "../src/index.js";

test("every fixed role has one compact prompt", () => {
  assert.deepEqual(Object.keys(ROLE_SYSTEM_PROMPTS).sort(), [...AGENT_ROLES].sort());
  assert.equal(Object.isFrozen(ROLE_SYSTEM_PROMPTS), true);
  for (const role of AGENT_ROLES) {
    const prompt = ROLE_SYSTEM_PROMPTS[role];
    assert.equal(prompt.startsWith("Role:"), true, role);
    assert.equal(prompt.length <= 240, true, `${role} prompt length: ${prompt.length}`);
    assert.match(prompt, /approve|production/u, role);
    assert.match(prompt, /deploy/u, role);
  }
});

test("prompts express role limits but are not authorization inputs", () => {
  assert.match(ROLE_SYSTEM_PROMPTS.engineer, /research → plan → modify → test/u);
  assert.match(ROLE_SYSTEM_PROMPTS.engineer, /failed test restart at research/u);
  assert.match(ROLE_SYSTEM_PROMPTS.verifier, /without modifying the workspace/u);
  assert.match(ROLE_SYSTEM_PROMPTS.manager, /human production-check handoff/u);
  assert.match(ROLE_SYSTEM_PROMPTS.impact_observer, /user impact/u);
});
