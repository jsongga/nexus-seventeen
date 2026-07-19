import assert from "node:assert/strict";
import test from "node:test";
import { FakeWeakImpactModelAdapter } from "../src/model.js";
import {
  buildImpactModelRequest,
  containsSensitiveMaterial,
  sanitizePublicSummary,
  sanitizeSourceText,
} from "../src/redaction.js";
import { TEST_LIMITS } from "./helpers.js";

test("source facts are bounded and stripped of credentials, links, contacts, and implementation lines", () => {
  const source = [
    "People will get a clearer confirmation after checkout.",
    "api_key=super-secret-value-12345",
    "src/checkout/handler.ts => { npm test }",
    "Contact owner@example.com at https://internal.example/path",
  ].join("\n");
  const sanitized = sanitizeSourceText(source, 180);
  assert.match(sanitized, /clearer confirmation/u);
  assert.doesNotMatch(sanitized, /super-secret|handler|owner@example|internal\.example/u);
  assert.ok(sanitized.length <= 180);
  assert.equal(containsSensitiveMaterial("Bearer abcdefghijklmnop"), true);
});

test("model request construction honors its input and output budgets", () => {
  const request = buildImpactModelRequest(
    {
      title: "A".repeat(2_000),
      objective: "Help people complete their purchase. ".repeat(200),
      status: "running",
      recentUpdates: Array.from({ length: 20 }, (_, index) => `User outcome ${index}: ${"x".repeat(500)}`),
    },
    { ...TEST_LIMITS, maxInputTokens: 128, maxOutputTokens: 48 },
  );
  assert.ok(request.estimatedInputTokens <= 128);
  assert.equal(request.maxOutputTokens, 48);
  assert.ok(request.task.recentUpdates.length <= TEST_LIMITS.maxProgressEntriesPerTask);
});

test("public output removes implementation and production claims, then fails closed", () => {
  const mixed = sanitizePublicSummary(
    "Users should find checkout easier. npm test passed in src/checkout.ts. This was deployed to production.",
    "running",
    320,
  );
  assert.equal(mixed, "Users should find checkout easier.");

  const unsafeOnly = sanitizePublicSummary("Bearer abcdefghijklmnop was deployed to production.", "completed", 320);
  assert.equal(unsafeOnly, "The requested improvement is complete and ready for human review before any user release.");
});

test("fake weak adapter is deterministic and never claims a release", async () => {
  const adapter = new FakeWeakImpactModelAdapter();
  const request = buildImpactModelRequest(
    { title: "Improve checkout", objective: "Help people finish", status: "completed", recentUpdates: [] },
    TEST_LIMITS,
  );
  const first = await adapter.summarize(request);
  const second = await adapter.summarize(request);
  assert.deepEqual(first, second);
  assert.match(first.text, /human review/u);
  assert.doesNotMatch(first.text, /deployed|production/u);
});
