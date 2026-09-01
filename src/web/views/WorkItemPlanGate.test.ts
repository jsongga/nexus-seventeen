import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { runWorkItemDetailMutation } from "../BoardApp";
import { BoardApiError } from "../data/client";
import type { DetailedWorkflowPlan } from "../model/work-item-detail";
import { PlanApprovalActions, PlanRecordDetails, PlanRejectionForm } from "./WorkItemDetail";

const timestamp = "2026-08-19T12:00:00.000Z";

function plan(tier: "standard" | "hazardous" = "standard"): DetailedWorkflowPlan {
  return {
    planRevisionId: "plan-one",
    workItemId: "work-item-one",
    revision: 1,
    objective: "Implement and verify the bounded pipeline change.",
    assumptions: ["The current contract remains compatible."],
    acceptanceCriteria: ["The new loop is covered end to end."],
    children: null,
    changeShape: "feature",
    tier,
    declaredScope: ["src/server/task-board", "src/web/task-board"],
    nonGoals: ["Do not add the Design stage in this campaign."],
    mechanicalPortions: ["Add the reject request parser."],
    blockingQuestions: [
      {
        question: "Should the previous planning task remain durable?",
        recommendedDefault: "Yes, keep it as immutable history.",
      },
    ],
    criterionChecks: [
      {
        criterion: "The plan can be revised once.",
        check: "Run the plan revision integration test.",
      },
    ],
    state: "proposed",
    createdAt: timestamp,
    createdAtMs: Date.parse(timestamp),
    confirmedAt: null,
    confirmedAtMs: null,
  };
}

describe("plan approval record and controls", () => {
  it("renders every optional plan-record section and its badges", () => {
    const markup = renderToStaticMarkup(createElement(PlanRecordDetails, { plan: plan() }));

    for (const text of [
      "Feature",
      "Standard",
      "Declared scope",
      "src/server/task-board",
      "Non-goals",
      "Do not add the Design stage in this campaign.",
      "Mechanical portions",
      "Add the reject request parser.",
      "Blocking questions",
      "Should the previous planning task remain durable?",
      "Recommended default",
      "Yes, keep it as immutable history.",
      "Criterion checks",
      "The plan can be revised once.",
      "Run the plan revision integration test.",
    ])
      expect(markup).toContain(text);
  });

  it("keeps reject and confirm separate and explains the hazardous Design-stage gate", () => {
    const markup = renderToStaticMarkup(
      createElement(PlanApprovalActions, {
        plan: plan("hazardous"),
        busy: false,
        confirmEnabled: true,
        rejectEnabled: true,
        onConfirm: vi.fn(),
        onReject: vi.fn(),
      })
    );

    expect(markup).toContain("Hazardous tier: confirming enters the Design stage before implementation.");
    expect(markup).toContain("Confirm plan");
    expect(markup).toContain("Reject plan");
    expect(markup).not.toContain("Cancel work item");
  });

  it("renders declared children and the phased merge authorization at the plan gate", () => {
    const markup = renderToStaticMarkup(
      createElement(PlanRecordDetails, {
        plan: {
          ...plan(),
          changeShape: "blast_radius",
          children: [
            {
              key: "expand-provider",
              objective: "Publish the additive provider interface.",
              projectId: "provider-project",
              declaredScope: ["docs/interface.md"],
              acceptanceCriteria: ["The interface is published."],
              phase: "expand",
              splitBy: "phase",
            },
            {
              key: "migrate-consumer",
              objective: "Adopt the published provider interface.",
              projectId: "consumer-project",
              declaredScope: ["src/consumer"],
              acceptanceCriteria: ["The consumer uses the interface."],
              phase: "migrate",
              dependsOn: ["expand-provider"],
              splitBy: "consumer",
            },
          ],
        },
      })
    );

    for (const text of [
      "Declared children",
      "Expand",
      "Migrate",
      "provider-project",
      "Declared scope",
      "docs/interface.md",
      "src/consumer",
      "Acceptance criteria",
      "The interface is published.",
      "The consumer uses the interface.",
      "After expand-provider",
      "Expand and Migrate children merge automatically once verified and reviewed; Contract requires your approval after deployment is attested",
    ])
      expect(markup).toContain(text);
    expect(markup.match(/Declared scope/gu)).toHaveLength(3);
    expect(markup.match(/Acceptance criteria/gu)).toHaveLength(3);
  });

  it("renders a bounded revision-note form with revision rather than cancellation copy", () => {
    const markup = renderToStaticMarkup(
      createElement(PlanRejectionForm, {
        workItemId: "work-item-one",
        note: "",
        busy: false,
        errors: [],
        onNoteChange: vi.fn(),
        onDismissError: vi.fn(),
        onSubmit: vi.fn(),
        onKeep: vi.fn(),
      })
    );

    expect(markup).toContain("Revision note");
    expect(markup).toContain('maxLength="2000"');
    expect(markup).toContain("Reject and revise");
    expect(markup).toContain("Keep proposed plan");
    expect(markup).not.toContain("Reject and cancel");
  });

  it("refreshes work-item detail after rejection success and a stale-plan conflict", async () => {
    const successRefresh = vi.fn().mockResolvedValue(true);
    const success = await runWorkItemDetailMutation(async () => ({ outcome: "revising" }), successRefresh);

    expect(success.actionResult).toEqual({ ok: true });
    expect(successRefresh).toHaveBeenCalledOnce();

    const conflictRefresh = vi.fn().mockResolvedValue(true);
    const conflict = await runWorkItemDetailMutation(async () => {
      throw new BoardApiError("Plan revision is no longer proposed", 409, "PLAN_NOT_PROPOSED");
    }, conflictRefresh);

    expect(conflict.actionResult.ok).toBe(false);
    expect(conflictRefresh).toHaveBeenCalledOnce();
  });
});
