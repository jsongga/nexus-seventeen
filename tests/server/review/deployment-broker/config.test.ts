import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "#server/review/deployment-broker/config";
import { options, tempRoot } from "./helpers.js";

test("configuration requires distinct capabilities and a bounded target allowlist", async () => {
  const root = await tempRoot();
  const base = options(root);
  assert.throws(() => normalizeConfig({ ...base, executorToken: base.humanToken }), /must be distinct/u);
  assert.throws(() => normalizeConfig({ ...base, targetEnvironments: [] }), /1 to 32/u);
  assert.throws(
    () => normalizeConfig({ ...base, targetEnvironments: ["production-us", "production-us"] }),
    /duplicate/u,
  );
  assert.throws(() => normalizeConfig({ ...base, maximumExpirySeconds: 10 }), /below the minimum|safe range/u);
  assert.throws(() => normalizeConfig({ ...base, host: "0.0.0.0" }), /literal loopback/u);
});
