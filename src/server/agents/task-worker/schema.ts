import {
  exact,
  identifier,
  integer,
  parseWorkerAgentContext,
  parseWorkerAgentRunOutcome,
  parseWorkerAgentRunOutput,
  parseWorkerTaskWakeClaim,
  prose,
  record,
  timestamp,
} from "#shared/task-board-contract/validate";
import type {
  AgentRunOutcome,
  AgentRunOutput,
  BoundedAgentContext,
  CompletedRunJournalEntry,
  TaskWakeClaim,
  TaskWorkerIdentity,
  TaskWorkerJournal,
} from "./types.js";

const journalTimestamp = (value: unknown, label: string): string =>
  timestamp(value, label, `${label} must be a canonical timestamp`, true);
const journalProse = (value: unknown, label: string, maximum: number): string =>
  prose(value, label, { maximum, carriageReturns: "preserve" });
const nullableProse = (value: unknown, label: string, maximum: number): string | null =>
  value === null ? null : journalProse(value, label, maximum);
const nonNegativeInteger = (value: unknown, label: string): number => integer(value, label, 0, `${label} is invalid`);
const nullableCursor = (value: unknown, label: string): number | null => value === null ? null : nonNegativeInteger(value, label);

export function parseTaskWakeClaim(value: unknown): TaskWakeClaim {
  return parseWorkerTaskWakeClaim(value);
}

export function parseBoundedAgentContext(value: unknown): BoundedAgentContext {
  return parseWorkerAgentContext(value);
}

export function parseAgentRunOutput(value: unknown): AgentRunOutput {
  return parseWorkerAgentRunOutput(value);
}

export function parseAgentRunOutcome(value: unknown): AgentRunOutcome {
  return parseWorkerAgentRunOutcome(value);
}

export function emptyTaskWorkerJournal(identity: TaskWorkerIdentity): TaskWorkerJournal {
  return Object.freeze({
    version: 2,
    identity: Object.freeze({ workerId: identity.workerId, agentId: identity.agentId }),
    messageCursors: Object.freeze({}),
    pendingClaim: null,
    active: null,
    completed: Object.freeze([]),
  });
}

function messageCursorMap(value: unknown, label: string): Readonly<Record<string, number>> {
  const item = record(value, label);
  const entries = Object.entries(item);
  if (entries.length > 256) throw new Error(`${label} has too many task entries`);
  const parsed: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [taskId, cursor] of entries) {
    parsed[identifier(taskId, `${label} taskId`)] = nonNegativeInteger(cursor, `${label}.${taskId}`);
  }
  return Object.freeze(parsed);
}

function sameCursorMaps(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): boolean {
  const leftEntries = Object.entries(left).sort(([leftTask], [rightTask]) => leftTask.localeCompare(rightTask));
  const rightEntries = Object.entries(right).sort(([leftTask], [rightTask]) => leftTask.localeCompare(rightTask));
  return leftEntries.length === rightEntries.length && leftEntries.every(([taskId, cursor], index) => {
    const other = rightEntries[index];
    return other?.[0] === taskId && other[1] === cursor;
  });
}

function parseCompleted(value: unknown, index: number): CompletedRunJournalEntry {
  const item = exact(value, ["runId", "wakeId", "taskId", "outcome", "detail", "startedAt", "endedAt"], `Completed run ${index}`);
  if (item.outcome !== "completed" && item.outcome !== "failed" && item.outcome !== "interrupted" && item.outcome !== "waiting_for_human") {
    throw new Error(`Completed run ${index} outcome is invalid`);
  }
  const startedAt = journalTimestamp(item.startedAt, `completed[${index}].startedAt`);
  const endedAt = journalTimestamp(item.endedAt, `completed[${index}].endedAt`);
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw new Error(`Completed run ${index} time order is invalid`);
  return Object.freeze({
    runId: identifier(item.runId, `completed[${index}].runId`),
    wakeId: identifier(item.wakeId, `completed[${index}].wakeId`),
    taskId: item.taskId === null ? null : identifier(item.taskId, `completed[${index}].taskId`),
    outcome: item.outcome,
    detail: journalProse(item.detail, `completed[${index}].detail`, 2_000),
    startedAt,
    endedAt,
  });
}

export function parseTaskWorkerJournal(value: unknown, identity: TaskWorkerIdentity): TaskWorkerJournal {
  const raw = record(value, "Task worker journal");
  const legacy = raw.version === 1;
  const item = exact(value, legacy
    ? ["version", "identity", "messageCursor", "pendingClaim", "active", "completed"]
    : ["version", "identity", "messageCursors", "pendingClaim", "active", "completed"], "Task worker journal");
  if (!legacy && item.version !== 2) throw new Error("Task worker journal version is invalid");
  const storedIdentity = exact(item.identity, ["workerId", "agentId"], "Task worker identity");
  if (storedIdentity.workerId !== identity.workerId || storedIdentity.agentId !== identity.agentId) {
    throw new Error("Task worker journal belongs to another worker or agent");
  }
  const legacyCursor = legacy ? nullableCursor(item.messageCursor, "messageCursor") : null;
  let messageCursors = legacy ? Object.freeze({}) : messageCursorMap(item.messageCursors, "messageCursors");
  let pendingClaim: TaskWorkerJournal["pendingClaim"] = null;
  if (!legacy && item.pendingClaim !== null) {
    const pending = exact(item.pendingClaim, ["claimId", "messageCursors"], "Pending board claim");
    const cursors = messageCursorMap(pending.messageCursors, "pendingClaim.messageCursors");
    if (!sameCursorMaps(cursors, messageCursors)) throw new Error("Pending board claim cursors are stale");
    pendingClaim = Object.freeze({ claimId: identifier(pending.claimId, "pendingClaim.claimId"), messageCursors: cursors });
  }
  let active: TaskWorkerJournal["active"] = null;
  if (item.active !== null) {
    const entry = exact(item.active, ["claim", "phase", "contextDigest", "launchStartedAt", "interruptReason", "outcome", "nextOutputIndex"], "Active run");
    if (entry.phase !== "claimed" && entry.phase !== "launch_started" && entry.phase !== "running" && entry.phase !== "outputs_pending") {
      throw new Error("Active run phase is invalid");
    }
    const claim = parseTaskWakeClaim(entry.claim);
    const contextDigest = entry.contextDigest === null ? null : journalProse(entry.contextDigest, "contextDigest", 80);
    if (contextDigest !== null && !/^sha256:[a-f0-9]{64}$/u.test(contextDigest)) throw new Error("contextDigest is invalid");
    const launchStartedAt = entry.launchStartedAt === null ? null : journalTimestamp(entry.launchStartedAt, "launchStartedAt");
    const interruptReason = nullableProse(entry.interruptReason, "interruptReason", 1_000);
    const outcome = entry.outcome === null ? null : parseAgentRunOutcome(entry.outcome);
    const nextOutputIndex = nonNegativeInteger(entry.nextOutputIndex, "nextOutputIndex");
    if (
      (entry.phase === "claimed" && (contextDigest !== null || launchStartedAt !== null || outcome !== null)) ||
      ((entry.phase === "launch_started" || entry.phase === "running") && (contextDigest === null || launchStartedAt === null || outcome !== null)) ||
      (entry.phase === "outputs_pending" && (contextDigest === null) !== (launchStartedAt === null)) ||
      (entry.phase === "outputs_pending") !== (outcome !== null) || (outcome === null && nextOutputIndex !== 0) ||
      (outcome !== null && nextOutputIndex > outcome.outputs.length)
    ) throw new Error("Active run phase fields are inconsistent");
    active = Object.freeze({ claim, phase: entry.phase, contextDigest, launchStartedAt, interruptReason, outcome, nextOutputIndex });
    if (legacy && claim.taskId !== null && legacyCursor !== null) messageCursors = Object.freeze({ [claim.taskId]: legacyCursor });
  }
  if (!Array.isArray(item.completed) || item.completed.length > 256) throw new Error("Completed run journal is invalid");
  const completed = item.completed.map(parseCompleted);
  if (new Set(completed.map((entry) => entry.runId)).size !== completed.length) {
    throw new Error("Completed run journal contains duplicate run IDs");
  }
  return Object.freeze({
    version: 2,
    identity: Object.freeze({ workerId: identity.workerId, agentId: identity.agentId }),
    messageCursors,
    pendingClaim,
    active,
    completed: Object.freeze(completed),
  });
}
