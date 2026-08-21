import assert from "node:assert/strict";
import test from "node:test";
import {
  GATE_KINDS,
  NOTIFICATION_KINDS,
  PARK_CATEGORIES,
  PARK_RESOLUTIONS,
  TASK_BOARD_API_VERSION,
  TASK_BOARD_ERROR_CODES,
  type BoardNotification,
  type FindingsLedger,
  type GateAction,
  type ParkRecord,
  type ParksLedger,
  type ReviewFinding,
  type WorkItem,
  type WorkItemAudit,
  type WorkItemTransition,
} from "#shared/task-board-contract";
import {
  ContractValidationError,
  parseBoardNotification,
  parseFindingsLedger,
  parseGateAction,
  parseParkRecord,
  parseParksLedger,
  parseWorkItemAudit,
  parseWorkItemEntity,
} from "#shared/task-board-contract/validate";

const NOW = "2026-08-20T12:00:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const parkRecord: ParkRecord = {
  parkRecordId: "park-record-one",
  workItemId: "work-item-one",
  category: "open_question",
  reason: "The operator must answer a blocking question.",
  parkedAt: NOW,
  resolvedAt: null,
  resolution: null,
};

const reviewFinding: ReviewFinding = {
  findingId: "finding-one",
  nodeId: "node-one",
  stage: "verification",
  round: 2,
  file: "src/retry.ts",
  line: 42,
  category: "correctness",
  severity: "major",
  expected: "Retries preserve the original idempotency key.",
  actual: "A retry creates a second key.",
  blocking: true,
  createdAt: NOW,
};

const findingsLedger: FindingsLedger = {
  categories: [{ category: "correctness", severity: "major", blocking: true, count: 2 }],
  perProject: [{ projectId: "project-one", category: "correctness", count: 2 }],
  recent: [{ ...reviewFinding, workItemId: "work-item-one" }],
};

const parksLedger: ParksLedger = {
  open: [{ ...parkRecord, workItemTitle: "Make retry behavior observable." }],
  resolved: [{
    ...parkRecord,
    parkRecordId: "park-record-two",
    resolvedAt: NOW,
    resolution: "resumed",
    workItemTitle: "Make retry behavior observable.",
  }],
  recordsSince: "2026-08-20",
};

const oldWorkItem: WorkItem = {
  apiVersion: TASK_BOARD_API_VERSION,
  workItemId: "work-item-one",
  originalRequest: "Make retry behavior observable.",
  refinedObjective: null,
  priority: "normal",
  projectTarget: { mode: "explicit", projectId: "project-one" },
  resolvedProjectId: "project-one",
  planningTaskId: null,
  pipelineBranch: null,
  baseSha: null,
  state: "queued",
  currentStage: "refinement",
  createdBy: "human:operator",
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  endedAt: null,
  cancelledReason: null,
  archivedAt: null,
};

const notification: BoardNotification = {
  notificationId: "notification-one",
  sequence: 1,
  kind: "park_aged",
  dedupeKey: "park-aged:park-record-one",
  projectId: "project-one",
  workItemId: "work-item-one",
  summary: "A parked work item needs attention.",
  createdAt: NOW,
  readAt: null,
  version: 1,
};

const gateAction: GateAction = {
  gateActionId: "gate-action-one",
  workItemId: "work-item-one",
  gate: "final_approve",
  actorId: "human:operator",
  planRevisionId: "plan-revision-one",
  verifiedSha: SHA,
  mergeSha: null,
  refId: "approval-request-one",
  note: null,
  createdAt: NOW,
};

const transition: WorkItemTransition = {
  fromState: "final_approval",
  toState: "merged",
  actorType: "human",
  actorId: "human:operator",
  createdAt: NOW,
};

const audit: WorkItemAudit = {
  gateActions: [gateAction],
  transitions: [transition],
};

test("ledger and observability vocabularies and error codes are pinned", () => {
  assert.deepEqual([...PARK_CATEGORIES], [
    "open_question", "planning_run_failed", "design_run_failed", "hazardous_without_pipeline",
    "plan_rejected_twice", "bright_line", "scope_violation",
  ]);
  assert.deepEqual([...PARK_RESOLUTIONS], ["resumed", "abandoned", "auto_abandoned", "dead_letter"]);
  assert.deepEqual([...NOTIFICATION_KINDS], ["park_aged", "park_auto_abandoned"]);
  assert.deepEqual([...GATE_KINDS], [
    "plan_confirm", "plan_reject", "final_approve", "final_reject", "cancel", "question_answer",
  ]);
  assert.deepEqual({
    recordRequired: TASK_BOARD_ERROR_CODES.TASK_BOARD_PARK_RECORD_REQUIRED,
    recordInvalid: TASK_BOARD_ERROR_CODES.TASK_BOARD_PARK_RECORD_INVALID,
    notificationNotFound: TASK_BOARD_ERROR_CODES.TASK_BOARD_NOTIFICATION_NOT_FOUND,
  }, {
    recordRequired: "TASK_BOARD_PARK_RECORD_REQUIRED",
    recordInvalid: "TASK_BOARD_PARK_RECORD_INVALID",
    notificationNotFound: "TASK_BOARD_NOTIFICATION_NOT_FOUND",
  });
});

test("park records, notifications, and gate actions round-trip strictly", () => {
  assert.deepEqual(parseParkRecord(parkRecord, "parkRecord"), parkRecord);
  assert.deepEqual(parseBoardNotification(notification, "notification"), notification);
  assert.deepEqual(parseGateAction(gateAction, "gateAction"), gateAction);
  assert.deepEqual(parseWorkItemAudit(audit, "audit"), audit);

  assert.throws(
    () => parseParkRecord({ ...parkRecord, additiveField: true }, "parkRecord"),
    ContractValidationError,
  );
  assert.throws(
    () => parseWorkItemAudit({ ...audit, additiveField: true }, "audit"),
    ContractValidationError,
  );
});

test("ledger validators reject unknown enums and enforce text and SHA bounds", () => {
  for (const invalid of [
    () => parseParkRecord({ ...parkRecord, category: "future_category" }, "parkRecord"),
    () => parseParkRecord({ ...parkRecord, resolution: "future_resolution" }, "parkRecord"),
    () => parseParkRecord({ ...parkRecord, reason: "x".repeat(2_001) }, "parkRecord"),
    () => parseBoardNotification({ ...notification, kind: "future_kind" }, "notification"),
    () => parseBoardNotification({ ...notification, summary: "x".repeat(501) }, "notification"),
    () => parseGateAction({ ...gateAction, gate: "future_gate" }, "gateAction"),
    () => parseGateAction({ ...gateAction, verifiedSha: "0123" }, "gateAction"),
    () => parseGateAction({ ...gateAction, verifiedSha: SHA.toUpperCase() }, "gateAction"),
    () => parseGateAction({ ...gateAction, mergeSha: `${SHA}00` }, "gateAction"),
    () => parseGateAction({ ...gateAction, note: "x".repeat(2_001) }, "gateAction"),
  ]) assert.throws(invalid, ContractValidationError);
});

test("findings and parks ledger responses round-trip strictly", () => {
  assert.deepEqual(parseFindingsLedger(findingsLedger, "findingsLedger"), findingsLedger);
  assert.deepEqual(parseParksLedger(parksLedger, "parksLedger"), parksLedger);

  assert.throws(
    () => parseFindingsLedger({ ...findingsLedger, additiveField: true }, "findingsLedger"),
    ContractValidationError,
  );
  assert.throws(
    () => parseFindingsLedger({
      ...findingsLedger,
      categories: [{ ...findingsLedger.categories[0], count: 0 }],
    }, "findingsLedger"),
    ContractValidationError,
  );
  assert.throws(
    () => parseFindingsLedger({
      ...findingsLedger,
      recent: Array.from({ length: 51 }, (_, index) => ({
        ...findingsLedger.recent[0],
        findingId: `finding-${index}`,
      })),
    }, "findingsLedger"),
    ContractValidationError,
  );
  assert.throws(
    () => parseParksLedger({
      ...parksLedger,
      resolved: Array.from({ length: 101 }, (_, index) => ({
        ...parksLedger.resolved[0],
        parkRecordId: `park-record-${index}`,
      })),
    }, "parksLedger"),
    ContractValidationError,
  );
});

test("work-item observability fields are optional for old payloads", () => {
  const parsedOld = parseWorkItemEntity(oldWorkItem, "workItem");
  assert.deepEqual(parsedOld, oldWorkItem);
  assert.equal("stateSince" in parsedOld, false);
  assert.equal("reviewRound" in parsedOld, false);
  assert.equal("heartbeatAt" in parsedOld, false);

  assert.deepEqual(parseWorkItemEntity({
    ...oldWorkItem,
    stateSince: NOW,
    reviewRound: 2,
    heartbeatAt: null,
  }, "workItem"), {
    ...oldWorkItem,
    stateSince: NOW,
    reviewRound: 2,
    heartbeatAt: null,
  });
});
