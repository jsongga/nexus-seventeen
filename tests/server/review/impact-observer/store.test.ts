import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImpactSummaryStore } from "#server/review/impact-observer/store";
import { IMPACT_API_VERSION } from "#server/review/impact-observer/types";
import { TEST_LIMITS, WORKSPACE_ID } from "./helpers.js";

test("durable store rejects tampered summaries that contain secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "steward-impact-store-"));
  const path = join(root, "state.json");
  await writeFile(path, JSON.stringify({
    apiVersion: IMPACT_API_VERSION,
    workspaceId: WORKSPACE_ID,
    sourceSequence: 1,
    updatedAt: "2026-07-18T20:00:00.000Z",
    summaries: [{
      taskId: "task-one",
      status: "running",
      summary: "Bearer abcdefghijklmnop is available.",
      updatedAt: "2026-07-18T20:00:00.000Z",
      sourceSequence: 1,
      sourceFingerprint: "a".repeat(64),
    }],
  }), { mode: 0o600 });
  const store = new ImpactSummaryStore({
    path,
    workspaceId: WORKSPACE_ID,
    maximumSummaries: TEST_LIMITS.maxTrackedTasks,
    maximumSummaryCharacters: TEST_LIMITS.maxSummaryChars,
  });
  await assert.rejects(store.load(), /public-output safety check/u);
});
