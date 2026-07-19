import type {
  AgentRunOutcome,
  AgentRunOutput,
  BoundedAgentContext,
  CompletedRunJournalEntry,
  TaskWakeClaim,
  TaskWorkerIdentity,
  TaskWorkerJournal,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_OUTCOME_BYTES = 64 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const item = record(value, label);
  const actual = Object.keys(item).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
  return item;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function prose(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function nullableProse(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : prose(value, label, maximum);
}

function timestamp(value: unknown, label: string): string {
  const parsed = new Date(typeof value === "string" ? value : Number.NaN);
  if (typeof value !== "string" || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid`);
  return Number(value);
}

function nullableCursor(value: unknown, label: string): number | null {
  return value === null ? null : nonNegativeInteger(value, label);
}

function boundedJson(value: unknown, maximum: number, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum) throw new Error(`${label} exceeds its byte bound`);
}

export function parseTaskWakeClaim(value: unknown): TaskWakeClaim {
  const item = exact(value, [
    "apiVersion", "claimId", "runId", "wakeupId", "projectId", "agentId", "taskId", "reason",
    "requestedMessageCursor", "claimedAt",
  ], "Task wake claim");
  if (item.apiVersion !== 1 || typeof item.reason !== "string" || item.reason.length > 64) {
    throw new Error("Task wake claim version or reason is invalid");
  }
  return Object.freeze({
    apiVersion: 1,
    claimId: identifier(item.claimId, "claimId"),
    runId: identifier(item.runId, "runId"),
    wakeupId: identifier(item.wakeupId, "wakeupId"),
    projectId: identifier(item.projectId, "projectId"),
    agentId: identifier(item.agentId, "agentId"),
    taskId: item.taskId === null ? null : identifier(item.taskId, "taskId"),
    reason: item.reason,
    requestedMessageCursor: nullableCursor(item.requestedMessageCursor, "requestedMessageCursor"),
    claimedAt: timestamp(item.claimedAt, "claimedAt"),
  });
}

export function parseBoundedAgentContext(value: unknown): BoundedAgentContext {
  boundedJson(value, MAX_CONTEXT_BYTES, "Agent context");
  const item = exact(value, [
    "apiVersion", "projectId", "agentId", "taskId", "mission", "projectMemory", "task", "parentSummary",
    "messagesSinceCursor", "nextMessageCursor", "messages", "triggerQuestion", "openQuestions", "workspaceRefs",
  ], "Agent context");
  if (item.apiVersion !== 1) throw new Error("Agent context version is invalid");
  const mission = exact(item.mission, ["role", "area", "mission"], "Agent mission");
  const task = exact(item.task, ["title", "objective", "acceptanceCriteria"], "Agent task context");
  if (!Array.isArray(item.messages) || item.messages.length > 50) throw new Error("Agent context messages are invalid");
  const messages = item.messages.map((entry, index) => {
    const message = exact(entry, ["messageId", "cursor", "author", "body", "createdAt"], `Message ${index}`);
    if (message.author !== "human" && message.author !== "agent" && message.author !== "system") {
      throw new Error(`Message ${index} author is invalid`);
    }
    return Object.freeze({
      messageId: identifier(message.messageId, `messages[${index}].messageId`),
      cursor: nonNegativeInteger(message.cursor, `messages[${index}].cursor`),
      author: message.author,
      body: prose(message.body, `messages[${index}].body`, 2_000),
      createdAt: timestamp(message.createdAt, `messages[${index}].createdAt`),
    });
  });
  if (messages.some((message, index) => index > 0 && message.cursor <= messages[index - 1]!.cursor)) {
    throw new Error("Agent context message cursors must increase strictly");
  }
  const since = nullableCursor(item.messagesSinceCursor, "messagesSinceCursor");
  const next = nonNegativeInteger(item.nextMessageCursor, "nextMessageCursor");
  if ((since !== null && next < since) || messages.some((message) => message.cursor <= (since ?? -1) || message.cursor > next)) {
    throw new Error("Agent context message cursor binding is invalid");
  }
  if (!Array.isArray(item.openQuestions) || item.openQuestions.length > 16) {
    throw new Error("Agent context questions are invalid");
  }
  const openQuestions = item.openQuestions.map((entry, index) => {
    const question = exact(entry, ["questionId", "question", "answer", "status"], `Question ${index}`);
    if (question.status !== "open" && question.status !== "answered") throw new Error(`Question ${index} status is invalid`);
    if (question.status === "open" && question.answer !== null) throw new Error(`Question ${index} open answer is invalid`);
    if (question.status === "answered" && question.answer === null) throw new Error(`Question ${index} answered value is missing`);
    return Object.freeze({
      questionId: identifier(question.questionId, `openQuestions[${index}].questionId`),
      question: prose(question.question, `openQuestions[${index}].question`, 2_000),
      answer: nullableProse(question.answer, `openQuestions[${index}].answer`, 4_000),
      status: question.status,
    });
  });
  let triggerQuestion: BoundedAgentContext["triggerQuestion"] = null;
  if (item.triggerQuestion !== null) {
    const trigger = exact(item.triggerQuestion, ["questionId", "question", "answer"], "Trigger question");
    triggerQuestion = Object.freeze({
      questionId: identifier(trigger.questionId, "triggerQuestion.questionId"),
      question: prose(trigger.question, "triggerQuestion.question", 2_000),
      answer: prose(trigger.answer, "triggerQuestion.answer", 4_000),
    });
  }
  if (!Array.isArray(item.workspaceRefs) || item.workspaceRefs.length > 32) {
    throw new Error("Agent context workspace references are invalid");
  }
  return Object.freeze({
    apiVersion: 1,
    projectId: identifier(item.projectId, "context.projectId"),
    agentId: identifier(item.agentId, "context.agentId"),
    taskId: identifier(item.taskId, "context.taskId"),
    mission: Object.freeze({
      role: prose(mission.role, "mission.role", 64),
      area: prose(mission.area, "mission.area", 256),
      mission: prose(mission.mission, "mission.mission", 2_000),
    }),
    projectMemory: prose(item.projectMemory, "projectMemory", 8_000),
    task: Object.freeze({
      title: prose(task.title, "task.title", 512),
      objective: prose(task.objective, "task.objective", 4_000),
      acceptanceCriteria: prose(task.acceptanceCriteria, "task.acceptanceCriteria", 4_000),
    }),
    parentSummary: nullableProse(item.parentSummary, "parentSummary", 4_000),
    messagesSinceCursor: since,
    nextMessageCursor: next,
    messages: Object.freeze(messages),
    triggerQuestion,
    openQuestions: Object.freeze(openQuestions),
    workspaceRefs: Object.freeze(item.workspaceRefs.map((entry, index) => prose(entry, `workspaceRefs[${index}]`, 512))),
  });
}

export function parseAgentRunOutput(value: unknown): AgentRunOutput {
  const discriminator = record(value, "Agent output").type;
  switch (discriminator) {
    case "progress": {
      const item = exact(value, ["type", "body"], "Progress output");
      return Object.freeze({ type: "progress", body: prose(item.body, "progress.body", 2_000) });
    }
    case "proposed_child_task": {
      const item = exact(value, ["type", "title", "objective", "acceptanceCriteria"], "Child-task proposal");
      if (!Array.isArray(item.acceptanceCriteria) || item.acceptanceCriteria.length < 1 || item.acceptanceCriteria.length > 16) {
        throw new Error("Child-task acceptance criteria are invalid");
      }
      return Object.freeze({
        type: "proposed_child_task",
        title: prose(item.title, "proposal.title", 512),
        objective: prose(item.objective, "proposal.objective", 4_000),
        acceptanceCriteria: Object.freeze(item.acceptanceCriteria.map((criterion, index) =>
          prose(criterion, `proposal.acceptanceCriteria[${index}]`, 1_000))),
      });
    }
    case "result": {
      const item = exact(value, ["type", "body"], "Result output");
      return Object.freeze({ type: "result", body: prose(item.body, "result.body", 4_000) });
    }
    case "human_question": {
      const item = exact(value, ["type", "question"], "Human question output");
      return Object.freeze({ type: "human_question", question: prose(item.question, "question", 2_000) });
    }
    default:
      throw new Error("Agent output type is invalid");
  }
}

export function parseAgentRunOutcome(value: unknown): AgentRunOutcome {
  boundedJson(value, MAX_OUTCOME_BYTES, "Agent outcome");
  const item = exact(value, ["status", "outputs", "detail"], "Agent outcome");
  if (
    item.status !== "completed" && item.status !== "failed" && item.status !== "interrupted" &&
    item.status !== "waiting_for_human"
  ) {
    throw new Error("Agent outcome status is invalid");
  }
  if (!Array.isArray(item.outputs) || item.outputs.length > 64) throw new Error("Agent outcome outputs are invalid");
  const outputs = item.outputs.map(parseAgentRunOutput);
  const results = outputs.filter((output) => output.type === "result").length;
  const questions = outputs.filter((output) => output.type === "human_question").length;
  if (item.status === "completed" ? results !== 1 || questions !== 0 : results !== 0) {
    throw new Error("Agent outcome result does not match its terminal status");
  }
  if (item.status === "waiting_for_human" ? questions !== 1 : questions !== 0) {
    throw new Error("Agent outcome question does not match its terminal status");
  }
  if (item.status === "waiting_for_human" && outputs.at(-1)?.type !== "human_question") {
    throw new Error("A human question must be the final output because it ends the run");
  }
  return Object.freeze({
    status: item.status,
    outputs: Object.freeze(outputs),
    detail: prose(item.detail, "outcome.detail", 2_000),
  });
}

export function emptyTaskWorkerJournal(identity: TaskWorkerIdentity): TaskWorkerJournal {
  return Object.freeze({
    version: 1,
    identity: Object.freeze({ workerId: identity.workerId, agentId: identity.agentId }),
    messageCursor: null,
    pendingClaim: null,
    active: null,
    completed: Object.freeze([]),
  });
}

function parseCompleted(value: unknown, index: number): CompletedRunJournalEntry {
  const item = exact(value, [
    "runId", "wakeId", "taskId", "outcome", "detail", "startedAt", "endedAt",
  ], `Completed run ${index}`);
  if (
    item.outcome !== "completed" && item.outcome !== "failed" && item.outcome !== "interrupted" &&
    item.outcome !== "waiting_for_human"
  ) {
    throw new Error(`Completed run ${index} outcome is invalid`);
  }
  const startedAt = timestamp(item.startedAt, `completed[${index}].startedAt`);
  const endedAt = timestamp(item.endedAt, `completed[${index}].endedAt`);
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw new Error(`Completed run ${index} time order is invalid`);
  return Object.freeze({
    runId: identifier(item.runId, `completed[${index}].runId`),
    wakeId: identifier(item.wakeId, `completed[${index}].wakeId`),
    taskId: item.taskId === null ? null : identifier(item.taskId, `completed[${index}].taskId`),
    outcome: item.outcome,
    detail: prose(item.detail, `completed[${index}].detail`, 2_000),
    startedAt,
    endedAt,
  });
}

export function parseTaskWorkerJournal(value: unknown, identity: TaskWorkerIdentity): TaskWorkerJournal {
  const item = exact(value, ["version", "identity", "messageCursor", "pendingClaim", "active", "completed"], "Task worker journal");
  if (item.version !== 1) throw new Error("Task worker journal version is invalid");
  const storedIdentity = exact(item.identity, ["workerId", "agentId"], "Task worker identity");
  if (storedIdentity.workerId !== identity.workerId || storedIdentity.agentId !== identity.agentId) {
    throw new Error("Task worker journal belongs to another worker or agent");
  }
  const messageCursor = nullableCursor(item.messageCursor, "messageCursor");
  let pendingClaim: TaskWorkerJournal["pendingClaim"] = null;
  if (item.pendingClaim !== null) {
    const pending = exact(item.pendingClaim, ["claimId", "messageCursor"], "Pending board claim");
    pendingClaim = Object.freeze({
      claimId: identifier(pending.claimId, "pendingClaim.claimId"),
      messageCursor: nullableCursor(pending.messageCursor, "pendingClaim.messageCursor"),
    });
    if (pendingClaim.messageCursor !== messageCursor) throw new Error("Pending board claim cursor is stale");
  }
  let active: TaskWorkerJournal["active"] = null;
  if (item.active !== null) {
    const entry = exact(item.active, [
      "claim", "phase", "contextDigest", "launchStartedAt", "interruptReason", "outcome", "nextOutputIndex",
    ], "Active run");
    if (entry.phase !== "claimed" && entry.phase !== "launch_started" && entry.phase !== "running" && entry.phase !== "outputs_pending") {
      throw new Error("Active run phase is invalid");
    }
    const claim = parseTaskWakeClaim(entry.claim);
    const contextDigest = entry.contextDigest === null ? null : prose(entry.contextDigest, "contextDigest", 80);
    if (contextDigest !== null && !/^sha256:[a-f0-9]{64}$/u.test(contextDigest)) throw new Error("contextDigest is invalid");
    const launchStartedAt = entry.launchStartedAt === null ? null : timestamp(entry.launchStartedAt, "launchStartedAt");
    const interruptReason = nullableProse(entry.interruptReason, "interruptReason", 1_000);
    const outcome = entry.outcome === null ? null : parseAgentRunOutcome(entry.outcome);
    const nextOutputIndex = nonNegativeInteger(entry.nextOutputIndex, "nextOutputIndex");
    if (
      (entry.phase === "claimed" && (contextDigest !== null || launchStartedAt !== null || outcome !== null)) ||
      ((entry.phase === "launch_started" || entry.phase === "running") &&
        (contextDigest === null || launchStartedAt === null || outcome !== null)) ||
      (entry.phase === "outputs_pending" && (contextDigest === null) !== (launchStartedAt === null)) ||
      (entry.phase === "outputs_pending") !== (outcome !== null) ||
      (outcome === null && nextOutputIndex !== 0) ||
      (outcome !== null && nextOutputIndex > outcome.outputs.length)
    ) {
      throw new Error("Active run phase fields are inconsistent");
    }
    active = Object.freeze({ claim, phase: entry.phase, contextDigest, launchStartedAt, interruptReason, outcome, nextOutputIndex });
  }
  if (!Array.isArray(item.completed) || item.completed.length > 256) throw new Error("Completed run journal is invalid");
  const completed = item.completed.map(parseCompleted);
  if (new Set(completed.map((entry) => entry.runId)).size !== completed.length) {
    throw new Error("Completed run journal contains duplicate run IDs");
  }
  return Object.freeze({
    version: 1,
    identity: Object.freeze({ workerId: identity.workerId, agentId: identity.agentId }),
    messageCursor,
    pendingClaim,
    active,
    completed: Object.freeze(completed),
  });
}
