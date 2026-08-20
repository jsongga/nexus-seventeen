import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TASK_BOARD_ERROR_CODES,
  type ConfirmPlanRevisionResponse,
  type RejectPlanRevisionResponse,
} from "#shared/task-board-contract";
import { ContractValidationError, parseBoardRejectPlan } from "#shared/task-board-contract/validate";

test("plan rejection requests are exact, trimmed, and bounded", () => {
  assert.deepEqual(parseBoardRejectPlan({
    note: "  Explain the missing rollback behavior.  ",
    expectedState: "proposed",
  }), {
    note: "Explain the missing rollback behavior.",
    expectedState: "proposed",
  });
  for (const value of [
    null,
    { note: "", expectedState: "proposed" },
    { note: "x".repeat(2_001), expectedState: "proposed" },
    { note: "Revise it.", expectedState: "confirmed" },
    { note: "Revise it.", expectedState: "proposed", extra: true },
  ]) {
    assert.throws(() => parseBoardRejectPlan(value), ContractValidationError);
  }
});

test("plan gate responses and stable conflict codes expose the additive contract", () => {
  const revising: RejectPlanRevisionResponse = { outcome: "revising" };
  const parked: RejectPlanRevisionResponse = { outcome: "parked" };
  const standard: ConfirmPlanRevisionResponse<{ plans: unknown[] }> = { workflow: { plans: [] } };
  const hazardous: ConfirmPlanRevisionResponse<{ plans: unknown[] }> = {
    workflow: { plans: [] },
    outcome: "parked_hazardous",
  };
  const designing: ConfirmPlanRevisionResponse<{ plans: unknown[] }> = {
    workflow: { plans: [] },
    outcome: "designing",
  };
  assert.deepEqual([revising.outcome, parked.outcome], ["revising", "parked"]);
  assert.equal(standard.outcome, undefined);
  assert.equal(hazardous.outcome, "parked_hazardous");
  assert.equal(designing.outcome, "designing");
  assert.equal(TASK_BOARD_ERROR_CODES.PLAN_NOT_FOUND, "PLAN_NOT_FOUND");
  assert.equal(TASK_BOARD_ERROR_CODES.PLAN_NOT_PROPOSED, "PLAN_NOT_PROPOSED");
});
