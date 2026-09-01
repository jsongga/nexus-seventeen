import { describe, expect, it } from "vitest";
import type { BoardWorkItem } from "../types";
import { groupWorkItems } from "./work-item-tree";

const timestamp = "2026-08-29T12:00:00.000Z";

function workItem(id: string, overrides: Partial<BoardWorkItem> = {}): BoardWorkItem {
  return {
    id,
    originalRequest: id,
    refinedObjective: null,
    priority: "normal",
    taskType: "standard",
    projectTarget: { mode: "explicit", projectId: "project-one" },
    resolvedProjectId: "project-one",
    parentWorkItemId: null,
    phase: null,
    childOrdinal: null,
    planningTaskId: null,
    state: "coordinating",
    currentStage: null,
    createdBy: "human:operator",
    version: 1,
    createdAt: timestamp,
    createdAtMs: Date.parse(timestamp),
    updatedAt: timestamp,
    updatedAtMs: Date.parse(timestamp),
    endedAt: null,
    endedAtMs: null,
    cancelledReason: null,
    archivedAt: null,
    archivedAtMs: null,
    ...overrides,
  };
}

describe("groupWorkItems", () => {
  it("places ordinal-sorted children directly after their parent with progress and phase hints", () => {
    const parent = workItem("parent");
    const expand = workItem("expand", {
      parentWorkItemId: parent.id,
      phase: "expand",
      childOrdinal: 0,
      state: "merged",
    });
    const migrate = workItem("migrate", {
      parentWorkItemId: parent.id,
      phase: "migrate",
      childOrdinal: 1,
      state: "merged",
    });
    const contract = workItem("contract", {
      parentWorkItemId: parent.id,
      phase: "contract",
      childOrdinal: 2,
      state: "queued",
    });
    const abandoned = workItem("abandoned", { parentWorkItemId: parent.id, childOrdinal: 3, state: "abandoned" });
    const deadLettered = workItem("dead-lettered", {
      parentWorkItemId: parent.id,
      childOrdinal: 4,
      state: "dead_letter",
    });
    const ordinary = workItem("ordinary", { state: "queued" });

    const grouped = groupWorkItems([contract, deadLettered, ordinary, migrate, parent, abandoned, expand]);

    expect(grouped.map(({ workItem: item, depth }) => [item.id, depth])).toEqual([
      ["ordinary", 0],
      ["parent", 0],
      ["expand", 1],
      ["migrate", 1],
      ["contract", 1],
      ["abandoned", 1],
      ["dead-lettered", 1],
    ]);
    expect(grouped.find(({ workItem: item }) => item.id === "parent")).toMatchObject({
      childCount: 3,
      mergedChildCount: 2,
      abandonedChildCount: 2,
    });
    expect(grouped.find(({ workItem: item }) => item.id === "migrate")?.dependencyHint).toBe("after Expand");
    expect(grouped.find(({ workItem: item }) => item.id === "contract")?.dependencyHint).toBe("after Migrate");
  });

  it("keeps an orphan child visible as a root with its own dependency hint", () => {
    const orphan = workItem("orphan", { parentWorkItemId: "missing-parent", phase: "migrate", childOrdinal: 4 });

    expect(groupWorkItems([orphan])).toEqual([
      expect.objectContaining({
        workItem: orphan,
        depth: 0,
        dependencyHint: "after Expand",
      }),
    ]);
  });
});
