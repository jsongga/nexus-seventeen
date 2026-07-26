import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseProgressEvent } from "#shared/protocol";
import { FakeWeakImpactModelAdapter } from "#server/review/impact-observer/model";
import { ImpactCursorError, ImpactObserver } from "#server/review/impact-observer/observer";
import { ImpactSummaryStore } from "#server/review/impact-observer/store";
import {
  bootstrap,
  MemoryPersistence,
  progressEvent,
  task,
  TEST_LIMITS,
  testModelRouter,
  WORKSPACE_ID,
} from "./helpers.js";

test("observer continuously summarizes relevant changes while bounding task and progress memory", async () => {
  const model = new FakeWeakImpactModelAdapter();
  const persistence = new MemoryPersistence();
  const observer = new ImpactObserver({
    workspaceId: WORKSPACE_ID,
    model,
    router: testModelRouter(),
    persistence,
    limits: TEST_LIMITS,
    now: () => new Date("2026-07-18T20:10:00.000Z"),
  });
  await observer.restore();
  observer.acceptBootstrap(bootstrap({
    tasks: [task("old-1", "completed"), task("old-2", "completed"), task("active-1"), task("active-2")],
  }));
  assert.equal(observer.trackedTaskCount, 3);
  const initial = await observer.flush();
  assert.equal(initial.summarized, 3);

  observer.acceptEvent(progressEvent({ sequence: 2, projectedTask: task("active-1") }));
  observer.acceptEvent(progressEvent({
    sequence: 3,
    projectedTask: task("active-1"),
    progress: parseProgressEvent({
      taskId: task("active-1").taskId,
      phase: "execute",
      iteration: 2,
      journal: "api_key=do-not-send src/secret.ts People can understand the next step.",
      occurredAt: "2026-07-18T20:06:00.000Z",
    }),
  }));
  observer.acceptEvent(progressEvent({ sequence: 4, projectedTask: task("active-1") }));
  const updated = await observer.flush();
  assert.ok(updated.summarized >= 1);
  const latestRequest = model.requests.at(-1);
  assert.ok(latestRequest);
  assert.ok(latestRequest.task.recentUpdates.length <= 2);
  assert.doesNotMatch(JSON.stringify(latestRequest), /do-not-send|secret\.ts/u);
  assert.equal(observer.snapshot().sourceSequence, 4);
  const latestRoute = model.routedRequests.at(-1);
  assert.ok(latestRoute);
  assert.equal(latestRoute.route.selectedTier, "economy");
  assert.equal(latestRoute.route.model.modelId, "claude-economy-caller-configured-test-id");
  assert.deepEqual(latestRoute.tools, []);
  assert.deepEqual(latestRoute.route.authority, {
    modelMayDeployToProduction: false,
    modelMayApproveProduction: false,
    authenticatedHumanApprovalRequired: true,
  });
  assert.ok(persistence.writes >= 4);
  await observer.close();
});

test("observer fails closed on cursor gaps so the daemon can re-bootstrap", async () => {
  const observer = new ImpactObserver({
    workspaceId: WORKSPACE_ID,
    model: new FakeWeakImpactModelAdapter(),
    router: testModelRouter(),
    persistence: new MemoryPersistence(),
    limits: TEST_LIMITS,
  });
  await observer.restore();
  observer.acceptBootstrap(bootstrap({ sequence: 5 }));
  assert.throws(() => observer.acceptEvent(progressEvent({ sequence: 7 })), ImpactCursorError);
  assert.equal(observer.cursor, 5);
  await observer.close();
});

test("latest safe summaries survive restart and identical bootstrap facts do not spend model tokens again", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-impact-"));
  const path = join(root, "private", "impact.json");
  const store = () => new ImpactSummaryStore({
    path,
    workspaceId: WORKSPACE_ID,
    maximumSummaries: TEST_LIMITS.maxTrackedTasks,
    maximumSummaryCharacters: TEST_LIMITS.maxSummaryChars,
  });
  const firstModel = new FakeWeakImpactModelAdapter();
  const first = new ImpactObserver({
    workspaceId: WORKSPACE_ID,
    model: firstModel,
    router: testModelRouter(),
    persistence: store(),
    limits: TEST_LIMITS,
    now: () => new Date("2026-07-18T20:10:00.000Z"),
  });
  await first.restore();
  first.acceptBootstrap(bootstrap());
  await first.flush();
  await first.close();

  const secondModel = new FakeWeakImpactModelAdapter();
  const second = new ImpactObserver({
    workspaceId: WORKSPACE_ID,
    model: secondModel,
    router: testModelRouter(),
    persistence: store(),
    limits: TEST_LIMITS,
    now: () => new Date("2026-07-18T20:11:00.000Z"),
  });
  await second.restore();
  assert.equal(second.summaries().length, 1);
  second.acceptBootstrap(bootstrap());
  const result = await second.flush();
  assert.equal(result.summarized, 0);
  assert.equal(secondModel.requests.length, 0);

  const state = JSON.parse(await readFile(path, "utf8")) as { summaries: unknown[] };
  assert.equal(state.summaries.length, 1);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
  await second.close();
});

test("observer blocks a summary that cannot fit the configured economy context", async () => {
  const model = new FakeWeakImpactModelAdapter();
  const observer = new ImpactObserver({
    workspaceId: WORKSPACE_ID,
    model,
    router: testModelRouter(64),
    persistence: new MemoryPersistence(),
    limits: { ...TEST_LIMITS, maxOutputTokens: 48 },
    now: () => new Date("2026-07-18T20:10:00.000Z"),
  });
  await observer.restore();
  observer.acceptBootstrap(bootstrap());
  const result = await observer.flush();
  assert.deepEqual(result, { summarized: 0, failed: 1 });
  assert.equal(model.routedRequests.length, 0);
  const audit = observer.routingSnapshot().routes.at(-1);
  assert.ok(audit);
  assert.equal(audit.decision.disposition, "blocked");
  assert.equal(
    audit.decision.disposition === "blocked" ? audit.decision.reason : undefined,
    "model_context_exceeded",
  );
  assert.deepEqual(audit.tools, []);
  await observer.close();
});
