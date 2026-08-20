import assert from "node:assert/strict";
import test from "node:test";
import {
  BLOCKING_REVIEW_FINDING_CATEGORIES,
  DESIGN_FAILURE_POINTS,
  DESIGN_RECORD_DETAIL_MAX_LENGTH,
  DESIGN_RECORD_LABEL_MAX_LENGTH,
  DESIGN_RECORD_MAX_FAILURE_POINTS,
  DESIGN_RECORD_MAX_FAULT_INJECTION_CASES,
  DESIGN_RECORD_MAX_IDEMPOTENCY_KEYS,
  DESIGN_RECORD_MAX_STATES,
  DESIGN_RECORD_MAX_TRANSITIONS,
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_SEVERITIES,
  TASK_BOARD_ERROR_CODES,
  reviewFindingBlocks,
  type DesignRecord,
} from "#shared/task-board-contract";
import {
  ContractValidationError,
  parseDesignRecordDraft,
  parseDesignRecordEntity,
  parseBoardSettle,
  parsePipelineSummaryEntity,
  parseReviewFindingDraft,
  parseWorkerAgentRunOutcome,
} from "#shared/task-board-contract/validate";

const NOW = "2026-08-19T12:00:00.000Z";

function designRecordDraft(): Record<string, unknown> {
  return {
    states: ["pending", "sent", "committed"],
    transitions: [{
      from: "pending",
      to: "sent",
      durablePrecondition: "The idempotency key is persisted.",
      recovery: "Resume with the persisted key.",
    }],
    failurePoints: DESIGN_FAILURE_POINTS.map((point) => ({
      point,
      resultingState: `durable state after ${point}`,
      recovery: `recovery for ${point}`,
    })),
    idempotencyKeys: [{
      name: "settle-key",
      generatedAt: "Before the first send.",
      persistedAt: "In the same transaction as the attempt.",
      reuse: "Reuse for every delivery of the same logical settlement.",
    }],
    faultInjectionCases: [{
      name: "Crash after commit",
      scenario: "Terminate after the durable commit and before acknowledgement.",
      expectation: "A retry observes the committed outcome without duplicating it.",
    }],
  };
}

test("review finding contract pins vocabularies, blocking derivation, and stable error codes", () => {
  assert.deepEqual([...REVIEW_FINDING_CATEGORIES], [
    "correctness", "security", "plan_deviation", "test_modification", "docs", "style", "other",
  ]);
  assert.deepEqual([...REVIEW_FINDING_SEVERITIES], ["minor", "major", "critical"]);
  assert.deepEqual([...BLOCKING_REVIEW_FINDING_CATEGORIES], ["correctness", "security", "plan_deviation"]);
  assert.deepEqual(REVIEW_FINDING_CATEGORIES.map(reviewFindingBlocks), [true, true, true, false, false, false, false]);
  assert.deepEqual({
    findingsNotAllowed: TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_FINDINGS_NOT_ALLOWED,
    findingsRequired: TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_FINDINGS_REQUIRED,
    outcomeMismatch: TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_OUTCOME_MISMATCH,
    runtimeConflict: TASK_BOARD_ERROR_CODES.TASK_BOARD_REVIEW_RUNTIME_CONFLICT,
    designRequired: TASK_BOARD_ERROR_CODES.TASK_BOARD_DESIGN_RECORD_REQUIRED,
    designNotAllowed: TASK_BOARD_ERROR_CODES.TASK_BOARD_DESIGN_RECORD_NOT_ALLOWED,
  }, {
    findingsNotAllowed: "TASK_BOARD_REVIEW_FINDINGS_NOT_ALLOWED",
    findingsRequired: "TASK_BOARD_REVIEW_FINDINGS_REQUIRED",
    outcomeMismatch: "TASK_BOARD_REVIEW_OUTCOME_MISMATCH",
    runtimeConflict: "TASK_BOARD_REVIEW_RUNTIME_CONFLICT",
    designRequired: "TASK_BOARD_DESIGN_RECORD_REQUIRED",
    designNotAllowed: "TASK_BOARD_DESIGN_RECORD_NOT_ALLOWED",
  });
});

test("review finding drafts round-trip while server-derived fields remain forbidden", () => {
  const draft = {
    file: "src/server/task-board/persistence/store.ts",
    line: 912,
    category: "correctness",
    severity: "major",
    expected: "The settlement is committed exactly once.",
    actual: "A retry can duplicate the settlement.",
  } as const;
  assert.deepEqual(parseReviewFindingDraft(draft), draft);
  assert.deepEqual(parseReviewFindingDraft({
    category: "docs",
    severity: "minor",
    expected: "Document the recovery path.",
    actual: "The recovery path is absent.",
  }), {
    category: "docs",
    severity: "minor",
    expected: "Document the recovery path.",
    actual: "The recovery path is absent.",
  });

  for (const invalid of [
    { ...draft, category: "future_category" },
    { ...draft, severity: "urgent" },
    { ...draft, blocking: true },
    { ...draft, file: "src/server/\u0000store.ts" },
    { ...draft, file: "/absolute/path.ts" },
    { ...draft, file: "x".repeat(513) },
    { ...draft, line: 0 },
    { ...draft, expected: "" },
    { ...draft, actual: "x".repeat(2_001) },
  ]) {
    assert.throws(() => parseReviewFindingDraft(invalid), ContractValidationError);
  }
});

test("design records round-trip a complete failure matrix", () => {
  const draft = designRecordDraft();
  const parsedDraft = parseDesignRecordDraft(draft);
  assert.deepEqual(parsedDraft, draft);
  const record: DesignRecord = {
    ...parsedDraft,
    designRecordId: "design-record-one",
    workItemId: "work-item-one",
    planRevisionId: "plan-revision-one",
    createdAt: NOW,
  };
  assert.deepEqual(parseDesignRecordEntity(record, "designRecord"), record);
});

test("pipeline summaries strictly round-trip findings and the design record", () => {
  const summary = {
    commits: [{ sha: "0123456789abcdef0123456789abcdef01234567", subject: "Review evidence" }],
    diffstat: " src/change.ts | 1 +",
    filesTouched: ["src/change.ts"],
    declaredScope: ["src"],
    scopeOk: true,
    assumptions: [],
    midRunAssumptions: [],
    verify: [],
    criteria: [],
    criterionChecks: [],
    findings: [{
      findingId: "finding-one",
      nodeId: "node-one",
      stage: "verification",
      round: 1,
      file: "src/change.ts",
      line: 4,
      category: "correctness",
      severity: "major",
      expected: "The retry is idempotent.",
      actual: "The retry duplicates the write.",
      blocking: true,
      createdAt: NOW,
    }],
    designRecord: designRecordDraft(),
  } as const;

  assert.deepEqual(parsePipelineSummaryEntity(summary, "pipelineSummary"), summary);
  const { findings: _findings, ...withoutFindings } = summary;
  const { designRecord: _designRecord, ...withoutDesignRecord } = summary;
  assert.throws(() => parsePipelineSummaryEntity(withoutFindings, "pipelineSummary"), ContractValidationError);
  assert.throws(() => parsePipelineSummaryEntity(withoutDesignRecord, "pipelineSummary"), ContractValidationError);
});

test("board settlements preserve valid design records and use the required-record code for invalid drafts", () => {
  const draft = designRecordDraft();
  assert.deepEqual(parseBoardSettle({
    outcome: "completed",
    result: "Design complete.",
    designRecord: draft,
  }).designRecord, draft);
  assert.throws(
    () => parseBoardSettle({
      outcome: "completed",
      result: "Design incomplete.",
      designRecord: {
        ...draft,
        failurePoints: (draft.failurePoints as Array<Record<string, unknown>>).slice(0, -1),
      },
    }),
    (error: unknown) => error instanceof ContractValidationError &&
      error.code === TASK_BOARD_ERROR_CODES.TASK_BOARD_DESIGN_RECORD_REQUIRED &&
      error.message === "design record missing failure point: concurrent_invocation",
  );
});

test("the maximally sized design settlement fits the 64 KiB outcome and HTTP budget", () => {
  assert.equal(DESIGN_RECORD_MAX_FAILURE_POINTS, DESIGN_FAILURE_POINTS.length);
  const maximumRecord = {
    states: Array.from({ length: DESIGN_RECORD_MAX_STATES }, () => "s".repeat(DESIGN_RECORD_LABEL_MAX_LENGTH)),
    transitions: Array.from({ length: DESIGN_RECORD_MAX_TRANSITIONS }, () => ({
      from: "f".repeat(DESIGN_RECORD_LABEL_MAX_LENGTH),
      to: "t".repeat(DESIGN_RECORD_LABEL_MAX_LENGTH),
      durablePrecondition: "d".repeat(DESIGN_RECORD_DETAIL_MAX_LENGTH),
      recovery: "r".repeat(DESIGN_RECORD_DETAIL_MAX_LENGTH),
    })),
    failurePoints: DESIGN_FAILURE_POINTS.map((point) => ({
      point,
      resultingState: "s".repeat(DESIGN_RECORD_DETAIL_MAX_LENGTH),
      recovery: "r".repeat(DESIGN_RECORD_DETAIL_MAX_LENGTH),
    })),
    idempotencyKeys: Array.from({ length: DESIGN_RECORD_MAX_IDEMPOTENCY_KEYS }, () => ({
      name: "n".repeat(DESIGN_RECORD_LABEL_MAX_LENGTH),
      generatedAt: "g".repeat(DESIGN_RECORD_DETAIL_MAX_LENGTH),
      persistedAt: "p".repeat(DESIGN_RECORD_DETAIL_MAX_LENGTH),
      reuse: "r".repeat(DESIGN_RECORD_DETAIL_MAX_LENGTH),
    })),
    faultInjectionCases: Array.from({ length: DESIGN_RECORD_MAX_FAULT_INJECTION_CASES }, () => ({
      name: "n".repeat(DESIGN_RECORD_LABEL_MAX_LENGTH),
      scenario: "s".repeat(DESIGN_RECORD_DETAIL_MAX_LENGTH),
      expectation: "e".repeat(DESIGN_RECORD_DETAIL_MAX_LENGTH),
    })),
  } as const;
  const maximumSettlement = {
    outcome: "completed",
    result: "r".repeat(16_000),
    handoff: null,
    workflowPlan: null,
    designRecord: maximumRecord,
  } as const;
  const maximumOutcome = {
    status: "completed",
    outputs: [{ type: "result", body: "r".repeat(4_000) }],
    expectedAgentMinutes: null,
    phases: [],
    detail: "d".repeat(2_000),
    handoff: null,
    workflowPlan: null,
    designRecord: maximumRecord,
  } as const;

  assert.deepEqual(parseBoardSettle(maximumSettlement).designRecord, maximumRecord);
  assert.ok(Buffer.byteLength(JSON.stringify(maximumSettlement), "utf8") < 64 * 1_024);
  assert.deepEqual(parseWorkerAgentRunOutcome(maximumOutcome).designRecord, maximumRecord);
  assert.ok(Buffer.byteLength(JSON.stringify(maximumOutcome), "utf8") < 64 * 1_024);
});

test("design record drafts enforce failure coverage, array bounds, and bounded text", () => {
  const draft = designRecordDraft();
  assert.throws(
    () => parseDesignRecordDraft({
      ...draft,
      failurePoints: (draft.failurePoints as Array<Record<string, unknown>>).slice(0, -1),
    }),
    (error: unknown) => error instanceof ContractValidationError &&
      error.message === "design record missing failure point: concurrent_invocation",
  );
  assert.throws(
    () => parseDesignRecordDraft({
      ...draft,
      states: Array.from({ length: DESIGN_RECORD_MAX_STATES + 1 }, (_, index) => `state-${index}`),
    }),
    ContractValidationError,
  );
  assert.throws(
    () => parseDesignRecordDraft({
      ...draft,
      transitions: Array.from(
        { length: DESIGN_RECORD_MAX_TRANSITIONS + 1 },
        () => (draft.transitions as Array<Record<string, unknown>>)[0],
      ),
    }),
    ContractValidationError,
  );
  assert.throws(
    () => parseDesignRecordDraft({
      ...draft,
      transitions: [{
        ...(draft.transitions as Array<Record<string, unknown>>)[0],
        recovery: "r".repeat(DESIGN_RECORD_DETAIL_MAX_LENGTH + 1),
      }],
    }),
    ContractValidationError,
  );
  assert.throws(
    () => parseDesignRecordDraft({ ...draft, states: ["pending\u0007"] }),
    ContractValidationError,
  );
  assert.throws(
    () => parseDesignRecordDraft({
      ...draft,
      failurePoints: [
        ...(draft.failurePoints as Array<Record<string, unknown>>).slice(0, -1),
        {
          ...(draft.failurePoints as Array<Record<string, unknown>>).at(-1),
          point: "future_failure_point",
        },
      ],
    }),
    ContractValidationError,
  );
});
