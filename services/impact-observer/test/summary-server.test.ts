import assert from "node:assert/strict";
import test from "node:test";
import { FakeWeakImpactModelAdapter } from "../src/model.js";
import { ImpactObserver } from "../src/observer.js";
import { ImpactSummaryServer } from "../src/summary-server.js";
import { bootstrap, MemoryPersistence, TEST_LIMITS, testModelRouter, WORKSPACE_ID } from "./helpers.js";

test("summary API is separately authenticated, read-only, and exposes no source journals", async () => {
  const observer = new ImpactObserver({
    workspaceId: WORKSPACE_ID,
    model: new FakeWeakImpactModelAdapter(),
    router: testModelRouter(),
    persistence: new MemoryPersistence(),
    limits: TEST_LIMITS,
    now: () => new Date("2026-07-18T20:10:00.000Z"),
  });
  await observer.restore();
  observer.acceptBootstrap(bootstrap());
  await observer.flush();
  const token = "frontend-output-token-0001";
  const server = new ImpactSummaryServer({
    observer,
    workspaceId: WORKSPACE_ID,
    outputToken: token,
    host: "127.0.0.1",
    port: 0,
    corsOrigins: new Set(["https://steward.example"]),
  });
  const address = await server.start();
  try {
    const endpoint = `${address.url}/v1/impact-summaries?workspaceId=${WORKSPACE_ID}`;
    assert.equal((await fetch(endpoint)).status, 401);
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${token}`, Origin: "https://steward.example" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://steward.example");
    const body = await response.text();
    assert.match(body, /human review|underway/u);
    assert.doesNotMatch(body, /finish their purchase|recentUpdates|objective|journal/u);
    const routingResponse = await fetch(
      `${address.url}/v1/impact-routing?workspaceId=${WORKSPACE_ID}`,
      { headers: { Authorization: `Bearer ${token}`, Origin: "https://steward.example" } },
    );
    assert.equal(routingResponse.status, 200);
    const routing = await routingResponse.json() as {
      readonly routes: readonly [{
        readonly tools: readonly unknown[];
        readonly decision: {
          readonly selectedTier: string;
          readonly model: { readonly modelId: string };
          readonly authority: {
            readonly modelMayDeployToProduction: boolean;
            readonly modelMayApproveProduction: boolean;
          };
        };
      }];
    };
    assert.equal(routing.routes[0].decision.selectedTier, "economy");
    assert.equal(routing.routes[0].decision.model.modelId, "claude-economy-caller-configured-test-id");
    assert.equal(routing.routes[0].decision.authority.modelMayDeployToProduction, false);
    assert.equal(routing.routes[0].decision.authority.modelMayApproveProduction, false);
    assert.deepEqual(routing.routes[0].tools, []);
    assert.doesNotMatch(JSON.stringify(routing), /finish their purchase|recentUpdates|objective|journal/u);
    assert.equal((await fetch(endpoint, { method: "POST" })).status, 405);
  } finally {
    await server.close();
    await observer.close();
  }
});
