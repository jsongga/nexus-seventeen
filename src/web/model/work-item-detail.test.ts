import { describe, expect, it } from "vitest";
import type { BoardChildWorkItem, BoardWorkItem, TaskStatus, WorkItemState } from "../types";
import {
  contractApprovalIsReady,
  contractDependencyStatuses,
  decompositionFamilyVersionKey,
  deriveDecompositionAffordances,
  deriveWorkItemDetailAffordances,
  nodesForPlan,
  proposedPlanForWorkItem,
} from "./work-item-detail";
import { notificationKindLabel, parkCategoryLabel, workItemStateLabel, workItemStatusLabel } from "./work-item-labels";

const workItemStates: readonly WorkItemState[] = [
  "queued",
  "planning",
  "plan_approval",
  "coordinating",
  "designing",
  "implementing",
  "verifying",
  "reviewing",
  "fixing",
  "final_approval",
  "merged",
  "parked",
  "abandoned",
  "dead_letter",
  "unrecognized",
];

const planningTaskStates: readonly (TaskStatus | null)[] = [
  null,
  "proposed",
  "backlog",
  "queued",
  "running",
  "waiting_for_human",
  "blocked",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "unrecognized",
];

const timestamp = "2026-08-29T12:00:00.000Z";

function child(id: string, overrides: Partial<BoardChildWorkItem> = {}): BoardChildWorkItem {
  return {
    id,
    originalRequest: id,
    refinedObjective: null,
    priority: "normal",
    taskType: "standard",
    projectTarget: { mode: "explicit", projectId: "project-one" },
    resolvedProjectId: "project-one",
    repositoryId: null,
    parentWorkItemId: "parent-one",
    phase: "migrate",
    childOrdinal: 1,
    planningTaskId: null,
    state: "merged",
    currentStage: null,
    createdBy: "human:operator",
    version: 1,
    createdAt: timestamp,
    createdAtMs: Date.parse(timestamp),
    updatedAt: timestamp,
    updatedAtMs: Date.parse(timestamp),
    endedAt: timestamp,
    endedAtMs: Date.parse(timestamp),
    cancelledReason: null,
    archivedAt: null,
    archivedAtMs: null,
    deployAttested: true,
    mergeSha: "0123456789abcdef0123456789abcdef01234567",
    ...overrides,
  };
}

const noAffordances = {
  answerQuestion: false,
  confirmPlan: false,
  rejectPlan: false,
  cancel: false,
  archive: false,
};

describe("deriveWorkItemDetailAffordances", () => {
  it("derives every action for every work-item, planning-task, and archive combination", () => {
    for (const workItemState of workItemStates) {
      for (const planningTaskState of planningTaskStates) {
        for (const archived of [false, true]) {
          const terminal =
            workItemState === "merged" || workItemState === "dead_letter" || workItemState === "abandoned";
          const expected = archived
            ? noAffordances
            : workItemState === "unrecognized"
              ? noAffordances
              : terminal
                ? { ...noAffordances, archive: true }
                : {
                    answerQuestion: workItemState === "parked" && planningTaskState === "waiting_for_human",
                    confirmPlan: workItemState === "plan_approval" && planningTaskState === "completed",
                    rejectPlan: workItemState === "plan_approval" && planningTaskState === "completed",
                    cancel: true,
                    archive: false,
                  };

          expect(
            deriveWorkItemDetailAffordances({
              workItemState,
              planningTaskState,
              archived,
            }),
            `${workItemState}/${planningTaskState ?? "missing"}/${archived ? "archived" : "visible"}`
          ).toEqual(expected);
        }
      }
    }
  });

  it("does not infer answer or review actions from the work-item state alone", () => {
    expect(
      deriveWorkItemDetailAffordances({
        workItemState: "parked",
        planningTaskState: null,
        archived: false,
      })
    ).toEqual({ ...noAffordances, cancel: true });
    expect(
      deriveWorkItemDetailAffordances({
        workItemState: "plan_approval",
        planningTaskState: "running",
        archived: false,
      })
    ).toEqual({ ...noAffordances, cancel: true });
  });
});

describe("work-item workflow selection", () => {
  it("selects only the latest proposed revision and its nodes for the opened work item", () => {
    const workflow = {
      plans: [
        { planRevisionId: "old", workItemId: "opened", revision: 1, state: "superseded" },
        { planRevisionId: "other", workItemId: "another", revision: 4, state: "proposed" },
        { planRevisionId: "latest", workItemId: "opened", revision: 3, state: "proposed" },
        { planRevisionId: "earlier", workItemId: "opened", revision: 2, state: "proposed" },
      ],
      nodes: [
        { nodeId: "latest-node", planRevisionId: "latest" },
        { nodeId: "other-node", planRevisionId: "other" },
      ],
      handoffs: [],
      events: [],
    } as never;

    expect(proposedPlanForWorkItem(workflow, "opened")?.planRevisionId).toBe("latest");
    expect(nodesForPlan(workflow, "latest").map((node) => node.nodeId)).toEqual(["latest-node"]);
  });
});

describe("decomposition affordances", () => {
  it("derives parent, child, and ordinary actions independently in every work-item state", () => {
    for (const workItemState of workItemStates) {
      expect(
        deriveDecompositionAffordances({
          workItemState,
          parentWorkItemId: null,
          phase: null,
          hasChildren: true,
          phasedFamily: false,
          childFailed: false,
          deployAttested: false,
        }),
        `parent/${workItemState}`
      ).toEqual({
        approveAndMergeChildren: workItemState === "final_approval",
        resumeCoordination: workItemState === "parked",
        resumeAfterBaseChange: false,
        attestDeployment: false,
      });

      expect(
        deriveDecompositionAffordances({
          workItemState,
          parentWorkItemId: "parent-one",
          phase: "expand",
          hasChildren: true,
          phasedFamily: false,
          childFailed: false,
          deployAttested: false,
        }),
        `child/${workItemState}`
      ).toEqual({
        approveAndMergeChildren: false,
        resumeCoordination: false,
        resumeAfterBaseChange: false,
        attestDeployment: workItemState === "merged",
      });

      expect(
        deriveDecompositionAffordances({
          workItemState,
          parentWorkItemId: null,
          phase: null,
          hasChildren: false,
          phasedFamily: false,
          childFailed: false,
          deployAttested: false,
        }),
        `ordinary/${workItemState}`
      ).toEqual({
        approveAndMergeChildren: false,
        resumeCoordination: false,
        resumeAfterBaseChange: false,
        attestDeployment: false,
      });
    }

    expect(
      deriveDecompositionAffordances({
        workItemState: "final_approval",
        parentWorkItemId: null,
        phase: null,
        hasChildren: true,
        phasedFamily: true,
        childFailed: false,
        deployAttested: false,
      }).approveAndMergeChildren
    ).toBe(false);
  });

  it("hides resume only when a phased coordination family has a terminal child", () => {
    expect(
      deriveDecompositionAffordances({
        workItemState: "parked",
        parentWorkItemId: null,
        phase: null,
        hasChildren: true,
        phasedFamily: true,
        childFailed: true,
        deployAttested: false,
      }).resumeCoordination
    ).toBe(false);
    expect(
      deriveDecompositionAffordances({
        workItemState: "parked",
        parentWorkItemId: null,
        phase: null,
        hasChildren: true,
        phasedFamily: false,
        childFailed: true,
        deployAttested: false,
      }).resumeCoordination
    ).toBe(true);
  });

  it("offers base-change recovery only for an item parked as base_diverged", () => {
    expect(
      deriveDecompositionAffordances({
        workItemState: "parked",
        parentWorkItemId: "parent-one",
        phase: "expand",
        hasChildren: false,
        phasedFamily: false,
        childFailed: false,
        deployAttested: false,
        parkCategory: "base_diverged",
      }).resumeAfterBaseChange
    ).toBe(true);
    expect(
      deriveDecompositionAffordances({
        workItemState: "parked",
        parentWorkItemId: null,
        phase: null,
        hasChildren: false,
        phasedFamily: false,
        childFailed: false,
        deployAttested: false,
        parkCategory: "planning_run_failed",
      }).resumeAfterBaseChange
    ).toBe(false);
  });

  it("keys family refreshes to only the parent and its children", () => {
    const parent = child("parent", { parentWorkItemId: null, phase: null, version: 4 });
    const first = child("first", { parentWorkItemId: parent.id, version: 2 });
    const second = child("second", { parentWorkItemId: parent.id, version: 7 });
    const unrelated = child("unrelated", { parentWorkItemId: null, phase: null, version: 1 });

    const initial = decompositionFamilyVersionKey(first, [parent, first, second, unrelated]);
    expect(decompositionFamilyVersionKey(first, [parent, first, second, { ...unrelated, version: 99 }])).toBe(initial);
    expect(decompositionFamilyVersionKey(first, [{ ...parent, version: 5 }, first, second, unrelated])).not.toBe(
      initial
    );
    expect(decompositionFamilyVersionKey(parent, [parent, first, { ...second, version: 8 }, unrelated])).not.toBe(
      initial
    );
  });

  it("keeps an unrecognized Contract phase blocked even when sibling statuses are ready", () => {
    const readyStatus = [{ child: child("expand"), direct: true, ready: true }];

    expect(contractApprovalIsReady("contract", "ready", readyStatus)).toBe(true);
    expect(contractApprovalIsReady("unrecognized", "ready", readyStatus)).toBe(false);
  });

  it("requires every non-Contract sibling and marks declared direct dependencies", () => {
    const expand = child("expand", { phase: "expand", childOrdinal: 0 });
    const migrate = child("migrate", { phase: "migrate", childOrdinal: 1, deployAttested: false });
    const contract = child("contract", {
      phase: "contract",
      childOrdinal: 2,
      state: "final_approval",
      deployAttested: false,
      mergeSha: null,
    });

    expect(
      contractDependencyStatuses(
        contract.id,
        [contract, migrate, expand],
        [
          {
            workItemId: contract.id,
            dependsOnWorkItemId: migrate.id,
          },
        ]
      )
    ).toEqual([
      { child: expand, direct: false, ready: true },
      { child: migrate, direct: true, ready: false },
    ]);
  });
});

describe("work-item labels", () => {
  it("labels every park category and notification kind, including scheduling additions", () => {
    expect(parkCategoryLabel).toEqual({
      open_question: "Open question",
      planning_run_failed: "Planning run failed",
      design_run_failed: "Design run failed",
      hazardous_without_pipeline: "Hazardous without pipeline",
      plan_rejected_twice: "Plan rejected twice",
      bright_line: "Bright line",
      scope_violation: "Scope violation",
      stage_cap_exceeded: "Stage cap exceeded",
      task_cap_exceeded: "Task cap exceeded",
      base_diverged: "Base diverged",
      child_failed: "Child failed",
      unrecognized: "Unknown category",
    });
    expect(notificationKindLabel).toEqual({
      park_aged: "Park aged",
      park_auto_abandoned: "Automatically abandoned",
      cap_parked: "Cap parked",
      final_approval_withdrawn: "Final approval withdrawn",
      parent_ready_for_approval: "Parent ready for approval",
      phase_ready: "Phase ready",
      unrecognized: "Unknown notification",
    });
  });

  it("uses the exhaustive campaign vocabulary in list rows and the detail pane", () => {
    const expected = {
      queued: "Queued",
      planning: "Planning",
      plan_approval: "Plan review",
      coordinating: "Coordinating",
      designing: "Design",
      implementing: "Implementing",
      verifying: "Verifying",
      reviewing: "Reviewing",
      fixing: "Fixing",
      final_approval: "Final review",
      merged: "Done",
      parked: "Parked",
      abandoned: "Abandoned",
      dead_letter: "Dead letter",
      unrecognized: "Unknown state — refresh the app",
    } satisfies Record<WorkItemState | "unrecognized", string>;

    expect(workItemStateLabel).toEqual(expected);
    for (const state of workItemStates) {
      expect(workItemStatusLabel({ state } as BoardWorkItem)).toBe(expected[state]);
    }
  });
});
