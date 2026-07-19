import assert from "node:assert/strict";
import test from "node:test";
import type { UiBootstrap, UiEventEnvelope } from "@cicada/steward-protocol";
import { ImpactObserverDaemon } from "../src/daemon.js";
import { FakeWeakImpactModelAdapter } from "../src/model.js";
import { ImpactObserver } from "../src/observer.js";
import type { ImpactEventSource } from "../src/types.js";
import {
  bootstrap,
  MemoryPersistence,
  progressEvent,
  TEST_LIMITS,
  testModelRouter,
  WORKSPACE_ID,
} from "./helpers.js";

test("daemon discards a gapped stream and re-bootstraps authoritative state", async () => {
  const stop = new AbortController();
  class GappedSource implements ImpactEventSource {
    bootstraps = 0;
    streams = 0;

    async bootstrap(): Promise<UiBootstrap> {
      this.bootstraps += 1;
      return bootstrap({ sequence: this.bootstraps === 1 ? 1 : 3 });
    }

    async stream(
      _bootstrap: UiBootstrap,
      _afterSequence: number,
      onEvent: (event: UiEventEnvelope) => Promise<void>,
    ): Promise<void> {
      this.streams += 1;
      if (this.streams === 1) {
        await onEvent(progressEvent({ sequence: 3 }));
        return;
      }
      stop.abort();
    }
  }
  const source = new GappedSource();
  const observer = new ImpactObserver({
    workspaceId: WORKSPACE_ID,
    model: new FakeWeakImpactModelAdapter(),
    router: testModelRouter(),
    persistence: new MemoryPersistence(),
    limits: TEST_LIMITS,
  });
  const warnings: string[] = [];
  const daemon = new ImpactObserverDaemon({
    observer,
    source,
    reconnectMinimumMs: 1,
    reconnectMaximumMs: 2,
    logger: { info() {}, error() {}, warn(message) { warnings.push(message); } },
  });
  await daemon.run(stop.signal);
  assert.equal(source.bootstraps, 2);
  assert.equal(source.streams, 2);
  assert.ok(warnings.some((message) => message.includes("event gap")));
  assert.equal(observer.cursor, 3);
});
