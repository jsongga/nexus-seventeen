/** Waits for an observable system arc to finish or become quiescent. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { inspect, isDeepStrictEqual } from "node:util";

const DEFAULT_QUIESCENCE_POLLS = 600;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_CEILING_MS = 120_000;

interface ProgressGateOptions<Observation> {
  readonly label: string;
  readonly step: () => Promise<unknown> | unknown;
  readonly observe: () => Promise<Observation> | Observation;
  readonly done: (observation: Observation) => boolean;
  readonly quiescencePolls?: number;
  readonly pollIntervalMs?: number;
  readonly ceilingMs?: number;
}

function formatTrace<Observation>(trace: readonly Observation[]): string {
  if (trace.length === 0) return "(no observations)";
  return trace
    .map((observation) => inspect(observation, { breakLength: Infinity, compact: true, depth: null, sorted: true }))
    .join(" -> ");
}

export async function waitForProgress<Observation>({
  label,
  step,
  observe,
  done,
  quiescencePolls = DEFAULT_QUIESCENCE_POLLS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ceilingMs = DEFAULT_CEILING_MS,
}: ProgressGateOptions<Observation>): Promise<Observation> {
  const trace: Observation[] = [];
  const controller = new AbortController();
  let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<never>((_resolve, reject) => {
    ceilingTimer = setTimeout(() => {
      try {
        assert.fail(`${label} exceeded its ${ceilingMs} ms safety ceiling; progress trace: ${formatTrace(trace)}`);
      } catch (error) {
        reject(error);
      }
    }, ceilingMs);
  });
  const gate = (async () => {
    let previous: Observation | undefined;
    let hasPrevious = false;
    let unchangedPolls = 0;

    while (!controller.signal.aborted) {
      await step();
      if (controller.signal.aborted) break;
      const observation = await observe();
      if (hasPrevious && isDeepStrictEqual(observation, previous)) {
        unchangedPolls += 1;
      } else {
        trace.push(observation);
        previous = observation;
        hasPrevious = true;
        unchangedPolls = 0;
      }
      if (done(observation)) return observation;
      if (unchangedPolls >= quiescencePolls) {
        assert.fail(
          `${label} made no observable progress for ${quiescencePolls} consecutive polls; progress trace: ${formatTrace(trace)}`
        );
      }
      await delay(pollIntervalMs, undefined, { signal: controller.signal });
    }
    throw new Error(`${label} progress gate was stopped`);
  })();

  try {
    return await Promise.race([gate, ceiling]);
  } finally {
    controller.abort();
    if (ceilingTimer !== undefined) clearTimeout(ceilingTimer);
  }
}
