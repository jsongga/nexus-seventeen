/** Verifies progress-gated waits independently of the pipeline suites. */
import assert from "node:assert/strict";
import test from "node:test";
import { waitForProgress } from "./progress-gate.js";

test("returns once the observed arc is done and resets quiescence on change", async () => {
  const observations = ["queued", "queued", "implementing", "implementing", "reviewing"];
  let index = 0;

  const result = await waitForProgress({
    label: "test arc",
    step: () => {
      index += 1;
    },
    observe: () => observations[Math.min(index - 1, observations.length - 1)],
    done: (state) => state === "reviewing",
    quiescencePolls: 2,
    pollIntervalMs: 0,
    ceilingMs: 1_000,
  });

  assert.equal(result, "reviewing");
});

test("fails on quiescence with each distinct observation in order", async () => {
  const observations = ["queued", "implementing", "queued", "queued", "queued"];
  let index = 0;

  await assert.rejects(
    waitForProgress({
      label: "test arc",
      step: () => {
        index += 1;
      },
      observe: () => observations[Math.min(index - 1, observations.length - 1)],
      done: () => false,
      quiescencePolls: 2,
      pollIntervalMs: 0,
      ceilingMs: 1_000,
    }),
    /test arc made no observable progress for 2 consecutive polls; progress trace: 'queued' -> 'implementing' -> 'queued'/u
  );
});

test("uses the wall-clock ceiling only to stop a hung step", async () => {
  await assert.rejects(
    waitForProgress({
      label: "hung test arc",
      step: () => new Promise<void>(() => undefined),
      observe: () => "queued",
      done: () => false,
      quiescencePolls: 2,
      pollIntervalMs: 0,
      ceilingMs: 20,
    }),
    /hung test arc exceeded its 20 ms safety ceiling; progress trace: \(no observations\)/u
  );
});
