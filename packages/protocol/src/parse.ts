import {
  ROLE_CAPABILITIES,
  STEWARD_RUNTIME_API_VERSION,
  STEWARD_UI_API_VERSION,
} from "./types.js";
import type {
  AgentCapability,
  AgentControlState,
  AgentId,
  AgentProvider,
  AgentRole,
  AgentRuntimeUpdate,
  AgentTaskProjection,
  CheckpointRef,
  ClientCommandId,
  CommandId,
  CurrentAction,
  DurableOutboxEvent,
  DurableOutboxPayload,
  EventId,
  HumanCommandEnvelope,
  HumanCommandPayload,
  HumanCommandReceipt,
  IsoTimestamp,
  LaneId,
  LeaseId,
  LeaseRenewalRequest,
  LeaseRenewalResult,
  ProgressEvent,
  RegisteredAgentProjection,
  RuntimeCommandEnvelope,
  RuntimeCommandPollRequest,
  RuntimeCommandPollResult,
  RuntimeCommandPayload,
  RuntimeEventBatch,
  RuntimeEventBatchReceipt,
  RuntimeInstanceId,
  SessionId,
  SupervisorRegistration,
  SupervisorRegistrationRequest,
  SupervisorRegistrationResult,
  TaskId,
  TaskStatus,
  UiBootstrap,
  UiEventEnvelope,
  UiEventPayload,
  UiSnapshot,
  UserId,
  WorkspaceId,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

export class ProtocolValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ProtocolValidationError";
    this.path = path;
  }
}

const fail = (path: string, message: string): never => {
  throw new ProtocolValidationError(path, message);
};

const exactObject = (
  input: unknown,
  keys: readonly string[],
  path: string,
): UnknownRecord => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    return fail(path, "expected an object");
  }

  const ownKeys = Reflect.ownKeys(input);
  const allowed = new Set(keys);
  for (const key of ownKeys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      return fail(path, `unknown field ${String(key)}`);
    }
  }
  return input as UnknownRecord;
};

const nonEmptyString = (input: unknown, path: string): string => {
  if (typeof input !== "string" || input.trim().length === 0) {
    return fail(path, "expected a nonempty string");
  }
  return input;
};

const identifier = <T extends string>(input: unknown, path: string): T =>
  nonEmptyString(input, path) as T;

const nullableIdentifier = <T extends string>(
  input: unknown,
  path: string,
): T | null => (input === null ? null : identifier<T>(input, path));

const booleanValue = (input: unknown, path: string): boolean => {
  if (typeof input !== "boolean") {
    return fail(path, "expected a boolean");
  }
  return input;
};

const integer = (
  input: unknown,
  path: string,
  minimum: 0 | 1,
): number => {
  if (!Number.isSafeInteger(input) || (input as number) < minimum) {
    return fail(
      path,
      `expected a safe integer greater than or equal to ${minimum}`,
    );
  }
  return input as number;
};

const oneOf = <T extends string>(
  input: unknown,
  allowed: readonly T[],
  path: string,
): T => {
  if (typeof input !== "string" || !allowed.includes(input as T)) {
    return fail(path, `expected one of ${allowed.join(", ")}`);
  }
  return input as T;
};

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

const timestamp = (input: unknown, path: string): IsoTimestamp => {
  if (typeof input !== "string") {
    return fail(path, "expected an ISO timestamp");
  }
  const match = ISO_TIMESTAMP_PATTERN.exec(input);
  if (match === null) {
    return fail(path, "expected a complete ISO timestamp with a timezone");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8] as string;
  const validCalendar =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59;
  if (!validCalendar) {
    return fail(path, "expected a valid calendar timestamp");
  }

  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return fail(path, "expected a valid ISO timezone offset");
    }
  }

  if (!Number.isFinite(Date.parse(input))) {
    return fail(path, "expected a valid ISO timestamp");
  }
  return input as IsoTimestamp;
};

const nullableTimestamp = (
  input: unknown,
  path: string,
): IsoTimestamp | null => (input === null ? null : timestamp(input, path));

const quarterHourTimestamp = (
  input: unknown,
  path: string,
): IsoTimestamp => {
  const parsed = timestamp(input, path);
  if (Date.parse(parsed) % (15 * 60 * 1_000) !== 0) {
    return fail(path, "expected a timestamp on a 15-minute boundary");
  }
  return parsed;
};

const expectedAgentMinutes = (input: unknown, path: string): number => {
  const parsed = integer(input, path, 1);
  if (parsed > 7 * 24 * 60) {
    return fail(path, "expected no more than 7 days of agent work");
  }
  if (parsed % 15 !== 0) {
    return fail(path, "expected a positive multiple of 15 minutes");
  }
  return parsed;
};

const assertEarlier = (
  earlier: IsoTimestamp,
  later: IsoTimestamp,
  path: string,
): void => {
  if (Date.parse(later) <= Date.parse(earlier)) {
    fail(path, "must be later than the lease grant time");
  }
};

const apiVersion = <T extends string>(
  input: unknown,
  expected: T,
  path: string,
): T => {
  if (input !== expected) {
    return fail(path, `expected ${expected}`);
  }
  return expected;
};

const role = (input: unknown, path: string): AgentRole =>
  oneOf(input, ["engineer", "verifier", "manager"], path);

const capability = (input: unknown, path: string): AgentCapability =>
  oneOf(
    input,
    [
      "research",
      "plan",
      "modify_workspace",
      "run_tests",
      "verify",
      "review",
      "coordinate",
    ],
    path,
  );

const capabilities = (
  input: unknown,
  agentRole: AgentRole,
  path: string,
): readonly AgentCapability[] => {
  if (!Array.isArray(input)) {
    return fail(path, "expected an array");
  }
  const parsed = input.map((value, index) =>
    capability(value, `${path}[${index}]`),
  );
  if (new Set(parsed).size !== parsed.length) {
    return fail(path, "capabilities must not contain duplicates");
  }

  const expected = ROLE_CAPABILITIES[agentRole];
  if (
    parsed.length !== expected.length ||
    expected.some((value) => !parsed.includes(value))
  ) {
    return fail(path, `capabilities do not match the ${agentRole} role`);
  }
  return Object.freeze([...parsed]);
};

const provider = (input: unknown, path: string): AgentProvider => {
  const value = exactObject(input, ["name", "model"], path);
  return Object.freeze({
    name: oneOf(value.name, ["codex", "claude"] as const, `${path}.name`),
    model: nonEmptyString(value.model, `${path}.model`),
  });
};

const taskStatus = (input: unknown, path: string): TaskStatus =>
  oneOf(
    input,
    ["queued", "running", "paused", "completed", "failed"],
    path,
  );

export const parseSupervisorRegistrationRequest = (
  input: unknown,
): SupervisorRegistrationRequest => {
  const path = "registration";
  const value = exactObject(
    input,
    [
      "apiVersion",
      "workspaceId",
      "agentId",
      "laneId",
      "runtimeInstanceId",
      "expectedRuntimeEpoch",
      "displayName",
      "role",
      "capabilities",
      "provider",
      "softwareVersion",
      "checkpointRef",
    ],
    path,
  );
  const parsedRole = role(value.role, `${path}.role`);
  return Object.freeze({
    apiVersion: apiVersion(
      value.apiVersion,
      STEWARD_RUNTIME_API_VERSION,
      `${path}.apiVersion`,
    ),
    workspaceId: identifier<WorkspaceId>(
      value.workspaceId,
      `${path}.workspaceId`,
    ),
    agentId: identifier<AgentId>(value.agentId, `${path}.agentId`),
    laneId: identifier<LaneId>(value.laneId, `${path}.laneId`),
    runtimeInstanceId: identifier<RuntimeInstanceId>(
      value.runtimeInstanceId,
      `${path}.runtimeInstanceId`,
    ),
    expectedRuntimeEpoch:
      value.expectedRuntimeEpoch === null
        ? null
        : integer(
            value.expectedRuntimeEpoch,
            `${path}.expectedRuntimeEpoch`,
            1,
          ),
    displayName: nonEmptyString(value.displayName, `${path}.displayName`),
    role: parsedRole,
    capabilities: capabilities(
      value.capabilities,
      parsedRole,
      `${path}.capabilities`,
    ),
    provider: provider(value.provider, `${path}.provider`),
    softwareVersion: nonEmptyString(
      value.softwareVersion,
      `${path}.softwareVersion`,
    ),
    checkpointRef: nullableIdentifier<CheckpointRef>(
      value.checkpointRef,
      `${path}.checkpointRef`,
    ),
  });
};

export const parseSupervisorRegistration = (
  input: unknown,
): SupervisorRegistration => {
  const path = "acceptedRegistration";
  const value = exactObject(
    input,
    [
      "apiVersion",
      "workspaceId",
      "agentId",
      "laneId",
      "runtimeInstanceId",
      "runtimeEpoch",
      "displayName",
      "role",
      "capabilities",
      "provider",
      "softwareVersion",
      "checkpointRef",
    ],
    path,
  );
  const parsedRole = role(value.role, `${path}.role`);
  return Object.freeze({
    apiVersion: apiVersion(
      value.apiVersion,
      STEWARD_RUNTIME_API_VERSION,
      `${path}.apiVersion`,
    ),
    workspaceId: identifier<WorkspaceId>(
      value.workspaceId,
      `${path}.workspaceId`,
    ),
    agentId: identifier<AgentId>(value.agentId, `${path}.agentId`),
    laneId: identifier<LaneId>(value.laneId, `${path}.laneId`),
    runtimeInstanceId: identifier<RuntimeInstanceId>(
      value.runtimeInstanceId,
      `${path}.runtimeInstanceId`,
    ),
    runtimeEpoch: integer(value.runtimeEpoch, `${path}.runtimeEpoch`, 1),
    displayName: nonEmptyString(value.displayName, `${path}.displayName`),
    role: parsedRole,
    capabilities: capabilities(
      value.capabilities,
      parsedRole,
      `${path}.capabilities`,
    ),
    provider: provider(value.provider, `${path}.provider`),
    softwareVersion: nonEmptyString(
      value.softwareVersion,
      `${path}.softwareVersion`,
    ),
    checkpointRef: nullableIdentifier<CheckpointRef>(
      value.checkpointRef,
      `${path}.checkpointRef`,
    ),
  });
};

export const parseSupervisorRegistrationResult = (
  input: unknown,
): SupervisorRegistrationResult => {
  const path = "registrationResult";
  const value = exactObject(
    input,
    [
      "apiVersion",
      "workspaceId",
      "agentId",
      "laneId",
      "runtimeInstanceId",
      "runtimeEpoch",
      "leaseId",
      "leaseGrantedAt",
      "leaseExpiresAt",
      "lastAcceptedLocalSequence",
      "controlVersion",
    ],
    path,
  );
  const leaseGrantedAt = timestamp(
    value.leaseGrantedAt,
    `${path}.leaseGrantedAt`,
  );
  const leaseExpiresAt = timestamp(
    value.leaseExpiresAt,
    `${path}.leaseExpiresAt`,
  );
  assertEarlier(leaseGrantedAt, leaseExpiresAt, `${path}.leaseExpiresAt`);
  return Object.freeze({
    apiVersion: apiVersion(
      value.apiVersion,
      STEWARD_RUNTIME_API_VERSION,
      `${path}.apiVersion`,
    ),
    workspaceId: identifier<WorkspaceId>(
      value.workspaceId,
      `${path}.workspaceId`,
    ),
    agentId: identifier<AgentId>(value.agentId, `${path}.agentId`),
    laneId: identifier<LaneId>(value.laneId, `${path}.laneId`),
    runtimeInstanceId: identifier<RuntimeInstanceId>(
      value.runtimeInstanceId,
      `${path}.runtimeInstanceId`,
    ),
    runtimeEpoch: integer(value.runtimeEpoch, `${path}.runtimeEpoch`, 1),
    leaseId: identifier<LeaseId>(value.leaseId, `${path}.leaseId`),
    leaseGrantedAt,
    leaseExpiresAt,
    lastAcceptedLocalSequence: integer(
      value.lastAcceptedLocalSequence,
      `${path}.lastAcceptedLocalSequence`,
      0,
    ),
    controlVersion: integer(
      value.controlVersion,
      `${path}.controlVersion`,
      0,
    ),
  });
};

export const parseLeaseRenewalRequest = (
  input: unknown,
): LeaseRenewalRequest => {
  const path = "leaseRenewal";
  const value = exactObject(
    input,
    [
      "apiVersion",
      "workspaceId",
      "agentId",
      "laneId",
      "runtimeInstanceId",
      "runtimeEpoch",
      "leaseId",
      "lastDurableEventSequence",
      "sentAt",
    ],
    path,
  );
  return Object.freeze({
    apiVersion: apiVersion(
      value.apiVersion,
      STEWARD_RUNTIME_API_VERSION,
      `${path}.apiVersion`,
    ),
    workspaceId: identifier<WorkspaceId>(
      value.workspaceId,
      `${path}.workspaceId`,
    ),
    agentId: identifier<AgentId>(value.agentId, `${path}.agentId`),
    laneId: identifier<LaneId>(value.laneId, `${path}.laneId`),
    runtimeInstanceId: identifier<RuntimeInstanceId>(
      value.runtimeInstanceId,
      `${path}.runtimeInstanceId`,
    ),
    runtimeEpoch: integer(value.runtimeEpoch, `${path}.runtimeEpoch`, 1),
    leaseId: identifier<LeaseId>(value.leaseId, `${path}.leaseId`),
    lastDurableEventSequence: integer(
      value.lastDurableEventSequence,
      `${path}.lastDurableEventSequence`,
      0,
    ),
    sentAt: timestamp(value.sentAt, `${path}.sentAt`),
  });
};

export const parseLeaseRenewalResult = (
  input: unknown,
): LeaseRenewalResult => {
  const path = "leaseRenewalResult";
  const value = exactObject(
    input,
    [
      "apiVersion",
      "workspaceId",
      "agentId",
      "laneId",
      "runtimeInstanceId",
      "runtimeEpoch",
      "leaseId",
      "leaseGrantedAt",
      "leaseExpiresAt",
      "acceptedThroughLocalSequence",
      "controlVersion",
    ],
    path,
  );
  const leaseGrantedAt = timestamp(
    value.leaseGrantedAt,
    `${path}.leaseGrantedAt`,
  );
  const leaseExpiresAt = timestamp(
    value.leaseExpiresAt,
    `${path}.leaseExpiresAt`,
  );
  assertEarlier(leaseGrantedAt, leaseExpiresAt, `${path}.leaseExpiresAt`);
  return Object.freeze({
    apiVersion: apiVersion(
      value.apiVersion,
      STEWARD_RUNTIME_API_VERSION,
      `${path}.apiVersion`,
    ),
    workspaceId: identifier<WorkspaceId>(
      value.workspaceId,
      `${path}.workspaceId`,
    ),
    agentId: identifier<AgentId>(value.agentId, `${path}.agentId`),
    laneId: identifier<LaneId>(value.laneId, `${path}.laneId`),
    runtimeInstanceId: identifier<RuntimeInstanceId>(
      value.runtimeInstanceId,
      `${path}.runtimeInstanceId`,
    ),
    runtimeEpoch: integer(value.runtimeEpoch, `${path}.runtimeEpoch`, 1),
    leaseId: identifier<LeaseId>(value.leaseId, `${path}.leaseId`),
    leaseGrantedAt,
    leaseExpiresAt,
    acceptedThroughLocalSequence: integer(
      value.acceptedThroughLocalSequence,
      `${path}.acceptedThroughLocalSequence`,
      0,
    ),
    controlVersion: integer(
      value.controlVersion,
      `${path}.controlVersion`,
      0,
    ),
  });
};

export const parseAgentTaskProjection = (
  input: unknown,
): AgentTaskProjection => parseTask(input, "task");

const parseTask = (input: unknown, path: string): AgentTaskProjection => {
  const value = exactObject(
    input,
    [
      "taskId",
      "workspaceId",
      "agentId",
      "laneId",
      "title",
      "objective",
      "status",
      "expectedAgentMinutes",
      "expectedCompletedAt",
      "startedAt",
      "endedAt",
    ],
    path,
  );
  const status = taskStatus(value.status, `${path}.status`);
  const startedAt = nullableTimestamp(value.startedAt, `${path}.startedAt`);
  const endedAt = nullableTimestamp(value.endedAt, `${path}.endedAt`);

  if (status === "queued" && (startedAt !== null || endedAt !== null)) {
    fail(path, "a queued task cannot have start or end timestamps");
  }
  if (
    (status === "running" || status === "paused") &&
    (startedAt === null || endedAt !== null)
  ) {
    fail(path, `${status} tasks require startedAt and prohibit endedAt`);
  }
  if (
    (status === "completed" || status === "failed") &&
    (startedAt === null || endedAt === null)
  ) {
    fail(path, `${status} tasks require startedAt and endedAt`);
  }
  if (
    startedAt !== null &&
    endedAt !== null &&
    Date.parse(endedAt) < Date.parse(startedAt)
  ) {
    fail(`${path}.endedAt`, "cannot be earlier than startedAt");
  }

  return Object.freeze({
    taskId: identifier<TaskId>(value.taskId, `${path}.taskId`),
    workspaceId: identifier<WorkspaceId>(
      value.workspaceId,
      `${path}.workspaceId`,
    ),
    agentId: identifier<AgentId>(value.agentId, `${path}.agentId`),
    laneId: identifier<LaneId>(value.laneId, `${path}.laneId`),
    title: nonEmptyString(value.title, `${path}.title`),
    objective: nonEmptyString(value.objective, `${path}.objective`),
    status,
    expectedAgentMinutes: expectedAgentMinutes(
      value.expectedAgentMinutes,
      `${path}.expectedAgentMinutes`,
    ),
    expectedCompletedAt: quarterHourTimestamp(
      value.expectedCompletedAt,
      `${path}.expectedCompletedAt`,
    ),
    startedAt,
    endedAt,
  });
};

type ParsedProgressFields =
  | Readonly<{
      taskId: TaskId;
      phase: "research" | "plan" | "execute";
      iteration: number;
      journal: string;
    }>
  | Readonly<{
      taskId: TaskId;
      phase: "test";
      iteration: number;
      journal: string;
      outcome: "passed" | "failed";
    }>;

const progressFields = (
  input: unknown,
  path: string,
  includeType: boolean,
): ParsedProgressFields => {
  const discriminatorObject = exactObject(
    input,
    includeType
      ? ["type", "taskId", "phase", "iteration", "journal", "outcome"]
      : [
          "taskId",
          "phase",
          "iteration",
          "journal",
          "occurredAt",
          "outcome",
        ],
    path,
  );
  if (includeType && discriminatorObject.type !== "progress") {
    fail(`${path}.type`, "expected progress");
  }
  const phase = oneOf(
    discriminatorObject.phase,
    ["research", "plan", "execute", "test"],
    `${path}.phase`,
  );
  const common = {
    taskId: identifier<TaskId>(
      discriminatorObject.taskId,
      `${path}.taskId`,
    ),
    iteration: integer(
      discriminatorObject.iteration,
      `${path}.iteration`,
      1,
    ),
    journal: nonEmptyString(
      discriminatorObject.journal,
      `${path}.journal`,
    ),
  };

  if (phase === "test") {
    return Object.freeze({
      ...common,
      phase,
      outcome: oneOf(
        discriminatorObject.outcome,
        ["passed", "failed"],
        `${path}.outcome`,
      ),
    });
  }
  if ("outcome" in discriminatorObject) {
    fail(`${path}.outcome`, "is only allowed for the test phase");
  }
  return Object.freeze({ ...common, phase });
};

const parseProgressEventAtPath = (
  input: unknown,
  path: string,
): ProgressEvent => {
  const value = exactObject(
    input,
    ["taskId", "phase", "iteration", "journal", "occurredAt", "outcome"],
    path,
  );
  const parsed = progressFields(value, path, false);
  return Object.freeze({
    ...parsed,
    occurredAt: timestamp(value.occurredAt, `${path}.occurredAt`),
  }) as ProgressEvent;
};

export const parseProgressEvent = (input: unknown): ProgressEvent =>
  parseProgressEventAtPath(input, "progress");

const currentAction = (input: unknown, path: string): CurrentAction => {
  const value = exactObject(input, ["taskId", "summary", "startedAt"], path);
  return Object.freeze({
    taskId: identifier<TaskId>(value.taskId, `${path}.taskId`),
    summary: nonEmptyString(value.summary, `${path}.summary`),
    startedAt: timestamp(value.startedAt, `${path}.startedAt`),
  });
};

const nullableCurrentAction = (
  input: unknown,
  path: string,
): CurrentAction | null => (input === null ? null : currentAction(input, path));

const outboxPayload = (
  input: unknown,
  path: string,
): DurableOutboxPayload => {
  const value = exactObjectForDiscriminator(input, path);
  switch (value.type) {
    case "progress": {
      const parsed = progressFields(input, path, true);
      return Object.freeze({
        type: "progress",
        ...parsed,
      }) as DurableOutboxPayload;
    }
    case "heartbeat": {
      const item = exactObject(
        input,
        ["type", "currentAction", "checkpointRef"],
        path,
      );
      return Object.freeze({
        type: "heartbeat",
        currentAction: nullableCurrentAction(
          item.currentAction,
          `${path}.currentAction`,
        ),
        checkpointRef: nullableIdentifier<CheckpointRef>(
          item.checkpointRef,
          `${path}.checkpointRef`,
        ),
      });
    }
    case "interrupt_acknowledged": {
      const item = exactObject(input, ["type", "commandId", "taskId"], path);
      return Object.freeze({
        type: "interrupt_acknowledged",
        commandId: identifier<CommandId>(
          item.commandId,
          `${path}.commandId`,
        ),
        taskId: nullableIdentifier<TaskId>(item.taskId, `${path}.taskId`),
      });
    }
    case "interrupt_refused": {
      const item = exactObject(input, ["type", "commandId", "reason"], path);
      return Object.freeze({
        type: "interrupt_refused",
        commandId: identifier<CommandId>(
          item.commandId,
          `${path}.commandId`,
        ),
        reason: nonEmptyString(item.reason, `${path}.reason`),
      });
    }
    case "interrupt_settled": {
      const item = exactObject(
        input,
        ["type", "commandId", "taskId", "checkpointRef"],
        path,
      );
      return Object.freeze({
        type: "interrupt_settled",
        commandId: identifier<CommandId>(
          item.commandId,
          `${path}.commandId`,
        ),
        taskId: nullableIdentifier<TaskId>(item.taskId, `${path}.taskId`),
        checkpointRef: nullableIdentifier<CheckpointRef>(
          item.checkpointRef,
          `${path}.checkpointRef`,
        ),
      });
    }
    case "hold_acknowledged": {
      const item = exactObject(input, ["type", "commandId", "taskId"], path);
      return Object.freeze({
        type: "hold_acknowledged",
        commandId: identifier<CommandId>(
          item.commandId,
          `${path}.commandId`,
        ),
        taskId: nullableIdentifier<TaskId>(item.taskId, `${path}.taskId`),
      });
    }
    case "hold_settled": {
      const item = exactObject(
        input,
        ["type", "commandId", "taskId", "checkpointRef"],
        path,
      );
      return Object.freeze({
        type: "hold_settled",
        commandId: identifier<CommandId>(
          item.commandId,
          `${path}.commandId`,
        ),
        taskId: nullableIdentifier<TaskId>(item.taskId, `${path}.taskId`),
        checkpointRef: nullableIdentifier<CheckpointRef>(
          item.checkpointRef,
          `${path}.checkpointRef`,
        ),
      });
    }
    case "task_completed": {
      const item = exactObject(
        input,
        ["type", "taskId", "result", "checkpointRef"],
        path,
      );
      return Object.freeze({
        type: "task_completed",
        taskId: identifier<TaskId>(item.taskId, `${path}.taskId`),
        result: nonEmptyString(item.result, `${path}.result`),
        checkpointRef: nullableIdentifier<CheckpointRef>(
          item.checkpointRef,
          `${path}.checkpointRef`,
        ),
      });
    }
    case "task_failed": {
      const item = exactObject(
        input,
        ["type", "taskId", "error", "retryable", "checkpointRef"],
        path,
      );
      return Object.freeze({
        type: "task_failed",
        taskId: identifier<TaskId>(item.taskId, `${path}.taskId`),
        error: nonEmptyString(item.error, `${path}.error`),
        retryable: booleanValue(item.retryable, `${path}.retryable`),
        checkpointRef: nullableIdentifier<CheckpointRef>(
          item.checkpointRef,
          `${path}.checkpointRef`,
        ),
      });
    }
    default:
      return fail(`${path}.type`, "unknown outbox payload type");
  }
};

const exactObjectForDiscriminator = (
  input: unknown,
  path: string,
): UnknownRecord => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    return fail(path, "expected an object");
  }
  const type = (input as UnknownRecord).type;
  if (typeof type !== "string") {
    return fail(`${path}.type`, "expected a string discriminator");
  }
  return input as UnknownRecord;
};

export const parseDurableOutboxEvent = (
  input: unknown,
): DurableOutboxEvent => {
  const path = "outboxEvent";
  const value = exactObject(
    input,
    [
      "apiVersion",
      "eventId",
      "workspaceId",
      "agentId",
      "laneId",
      "runtimeInstanceId",
      "localSequence",
      "runtimeEpoch",
      "occurredAt",
      "payload",
    ],
    path,
  );
  return Object.freeze({
    apiVersion: apiVersion(
      value.apiVersion,
      STEWARD_RUNTIME_API_VERSION,
      `${path}.apiVersion`,
    ),
    eventId: identifier<EventId>(value.eventId, `${path}.eventId`),
    workspaceId: identifier<WorkspaceId>(
      value.workspaceId,
      `${path}.workspaceId`,
    ),
    agentId: identifier<AgentId>(value.agentId, `${path}.agentId`),
    laneId: identifier<LaneId>(value.laneId, `${path}.laneId`),
    runtimeInstanceId: identifier<RuntimeInstanceId>(
      value.runtimeInstanceId,
      `${path}.runtimeInstanceId`,
    ),
    localSequence: integer(value.localSequence, `${path}.localSequence`, 1),
    runtimeEpoch: integer(value.runtimeEpoch, `${path}.runtimeEpoch`, 1),
    occurredAt: timestamp(value.occurredAt, `${path}.occurredAt`),
    payload: outboxPayload(value.payload, `${path}.payload`),
  });
};

export const parseRuntimeEventBatch = (input: unknown): RuntimeEventBatch => {
  const path = "runtimeEventBatch";
  const value = exactObject(
    input,
    [
      "apiVersion",
      "workspaceId",
      "agentId",
      "laneId",
      "runtimeInstanceId",
      "runtimeEpoch",
      "events",
    ],
    path,
  );
  if (!Array.isArray(value.events)) {
    return fail(`${path}.events`, "expected an array");
  }
  if (value.events.length === 0 || value.events.length > 100) {
    return fail(`${path}.events`, "expected between 1 and 100 events");
  }
  const workspaceId = identifier<WorkspaceId>(
    value.workspaceId,
    `${path}.workspaceId`,
  );
  const agentId = identifier<AgentId>(value.agentId, `${path}.agentId`);
  const laneId = identifier<LaneId>(value.laneId, `${path}.laneId`);
  const runtimeInstanceId = identifier<RuntimeInstanceId>(
    value.runtimeInstanceId,
    `${path}.runtimeInstanceId`,
  );
  const runtimeEpoch = integer(value.runtimeEpoch, `${path}.runtimeEpoch`, 1);
  const events = (value.events as unknown[]).map((event, index) => {
    const parsed = parseDurableOutboxEvent(event);
    if (
      parsed.workspaceId !== workspaceId ||
      parsed.agentId !== agentId ||
      parsed.laneId !== laneId ||
      parsed.runtimeInstanceId !== runtimeInstanceId ||
      parsed.runtimeEpoch !== runtimeEpoch
    ) {
      fail(
        `${path}.events[${index}]`,
        "event identity and epoch must match the batch",
      );
    }
    return parsed;
  });
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.localSequence <= events[index - 1]!.localSequence) {
      fail(
        `${path}.events[${index}].localSequence`,
        "event sequences must be strictly increasing",
      );
    }
  }
  return Object.freeze({
    apiVersion: apiVersion(
      value.apiVersion,
      STEWARD_RUNTIME_API_VERSION,
      `${path}.apiVersion`,
    ),
    workspaceId,
    agentId,
    laneId,
    runtimeInstanceId,
    runtimeEpoch,
    events: Object.freeze([...events]),
  });
};

export const parseRuntimeEventBatchReceipt = (
  input: unknown,
): RuntimeEventBatchReceipt => {
  const path = "runtimeEventBatchReceipt";
  const value = exactObject(
    input,
    [
      "apiVersion",
      "workspaceId",
      "agentId",
      "laneId",
      "runtimeInstanceId",
      "runtimeEpoch",
      "acceptedThroughLocalSequence",
      "controlVersion",
    ],
    path,
  );
  return Object.freeze({
    apiVersion: apiVersion(
      value.apiVersion,
      STEWARD_RUNTIME_API_VERSION,
      `${path}.apiVersion`,
    ),
    workspaceId: identifier<WorkspaceId>(
      value.workspaceId,
      `${path}.workspaceId`,
    ),
    agentId: identifier<AgentId>(value.agentId, `${path}.agentId`),
    laneId: identifier<LaneId>(value.laneId, `${path}.laneId`),
    runtimeInstanceId: identifier<RuntimeInstanceId>(
      value.runtimeInstanceId,
      `${path}.runtimeInstanceId`,
    ),
    runtimeEpoch: integer(value.runtimeEpoch, `${path}.runtimeEpoch`, 1),
    acceptedThroughLocalSequence: integer(
      value.acceptedThroughLocalSequence,
      `${path}.acceptedThroughLocalSequence`,
      0,
    ),
    controlVersion: integer(
      value.controlVersion,
      `${path}.controlVersion`,
      0,
    ),
  });
};

const runtimeCommandPayload = (
  input: unknown,
  path: string,
): RuntimeCommandPayload => {
  const value = exactObjectForDiscriminator(input, path);
  switch (value.type) {
    case "assign_task": {
      const item = exactObject(input, ["type", "task"], path);
      const task = parseTask(item.task, `${path}.task`);
      if (task.status !== "queued") {
        fail(`${path}.task.status`, "an assigned task must be queued");
      }
      return Object.freeze({ type: "assign_task", task });
    }
    case "request_interrupt": {
      const item = exactObject(input, ["type", "reason"], path);
      return Object.freeze({
        type: "request_interrupt",
        reason: nonEmptyString(item.reason, `${path}.reason`),
      });
    }
    case "resume": {
      const item = exactObject(
        input,
        ["type", "taskId", "checkpointRef"],
        path,
      );
      return Object.freeze({
        type: "resume",
        taskId: nullableIdentifier<TaskId>(item.taskId, `${path}.taskId`),
        checkpointRef: nullableIdentifier<CheckpointRef>(
          item.checkpointRef,
          `${path}.checkpointRef`,
        ),
      });
    }
    case "hold": {
      const item = exactObject(input, ["type", "reason"], path);
      return Object.freeze({
        type: "hold",
        reason: nonEmptyString(item.reason, `${path}.reason`),
      });
    }
    default:
      return fail(`${path}.type`, "unknown runtime command type");
  }
};

export const parseRuntimeCommandEnvelope = (
  input: unknown,
): RuntimeCommandEnvelope => {
  const path = "runtimeCommand";
  const value = exactObject(
    input,
    [
      "apiVersion",
      "commandId",
      "workspaceId",
      "agentId",
      "laneId",
      "serverSequence",
      "expectedRuntimeEpoch",
      "issuedAt",
      "payload",
    ],
    path,
  );
  const workspaceId = identifier<WorkspaceId>(
    value.workspaceId,
    `${path}.workspaceId`,
  );
  const agentId = identifier<AgentId>(value.agentId, `${path}.agentId`);
  const laneId = identifier<LaneId>(value.laneId, `${path}.laneId`);
  const payload = runtimeCommandPayload(value.payload, `${path}.payload`);
  if (payload.type === "assign_task") {
    if (
      payload.task.workspaceId !== workspaceId ||
      payload.task.agentId !== agentId ||
      payload.task.laneId !== laneId
    ) {
      fail(
        `${path}.payload.task`,
        "assignment identity must match its command envelope",
      );
    }
  }
  return Object.freeze({
    apiVersion: apiVersion(
      value.apiVersion,
      STEWARD_RUNTIME_API_VERSION,
      `${path}.apiVersion`,
    ),
    commandId: identifier<CommandId>(value.commandId, `${path}.commandId`),
    workspaceId,
    agentId,
    laneId,
    serverSequence: integer(value.serverSequence, `${path}.serverSequence`, 1),
    expectedRuntimeEpoch: integer(
      value.expectedRuntimeEpoch,
      `${path}.expectedRuntimeEpoch`,
      1,
    ),
    issuedAt: timestamp(value.issuedAt, `${path}.issuedAt`),
    payload,
  });
};

export const parseRuntimeCommandPollRequest = (
  input: unknown,
): RuntimeCommandPollRequest => {
  const path = "runtimeCommandPollRequest";
  const value = exactObject(
    input,
    [
      "apiVersion",
      "workspaceId",
      "agentId",
      "laneId",
      "runtimeInstanceId",
      "runtimeEpoch",
      "afterServerSequence",
    ],
    path,
  );
  return Object.freeze({
    apiVersion: apiVersion(
      value.apiVersion,
      STEWARD_RUNTIME_API_VERSION,
      `${path}.apiVersion`,
    ),
    workspaceId: identifier<WorkspaceId>(
      value.workspaceId,
      `${path}.workspaceId`,
    ),
    agentId: identifier<AgentId>(value.agentId, `${path}.agentId`),
    laneId: identifier<LaneId>(value.laneId, `${path}.laneId`),
    runtimeInstanceId: identifier<RuntimeInstanceId>(
      value.runtimeInstanceId,
      `${path}.runtimeInstanceId`,
    ),
    runtimeEpoch: integer(value.runtimeEpoch, `${path}.runtimeEpoch`, 1),
    afterServerSequence: integer(
      value.afterServerSequence,
      `${path}.afterServerSequence`,
      0,
    ),
  });
};

export const parseRuntimeCommandPollResult = (
  input: unknown,
): RuntimeCommandPollResult => {
  const path = "runtimeCommandPollResult";
  const value = exactObject(
    input,
    [
      "apiVersion",
      "workspaceId",
      "agentId",
      "laneId",
      "runtimeInstanceId",
      "runtimeEpoch",
      "latestServerSequence",
      "commands",
    ],
    path,
  );
  if (!Array.isArray(value.commands)) {
    return fail(`${path}.commands`, "expected an array");
  }
  if (value.commands.length > 100) {
    return fail(`${path}.commands`, "cannot contain more than 100 commands");
  }
  const workspaceId = identifier<WorkspaceId>(
    value.workspaceId,
    `${path}.workspaceId`,
  );
  const agentId = identifier<AgentId>(value.agentId, `${path}.agentId`);
  const laneId = identifier<LaneId>(value.laneId, `${path}.laneId`);
  const runtimeInstanceId = identifier<RuntimeInstanceId>(
    value.runtimeInstanceId,
    `${path}.runtimeInstanceId`,
  );
  const runtimeEpoch = integer(value.runtimeEpoch, `${path}.runtimeEpoch`, 1);
  const latestServerSequence = integer(
    value.latestServerSequence,
    `${path}.latestServerSequence`,
    0,
  );
  const commands = (value.commands as unknown[]).map((command, index) => {
    const parsed = parseRuntimeCommandEnvelope(command);
    if (
      parsed.workspaceId !== workspaceId ||
      parsed.agentId !== agentId ||
      parsed.laneId !== laneId ||
      parsed.expectedRuntimeEpoch !== runtimeEpoch
    ) {
      fail(
        `${path}.commands[${index}]`,
        "command identity and epoch must match the poll result",
      );
    }
    if (parsed.serverSequence > latestServerSequence) {
      fail(
        `${path}.commands[${index}].serverSequence`,
        "cannot be beyond latestServerSequence",
      );
    }
    return parsed;
  });
  for (let index = 1; index < commands.length; index += 1) {
    if (commands[index]!.serverSequence <= commands[index - 1]!.serverSequence) {
      fail(
        `${path}.commands[${index}].serverSequence`,
        "command sequences must be strictly increasing",
      );
    }
  }
  return Object.freeze({
    apiVersion: apiVersion(
      value.apiVersion,
      STEWARD_RUNTIME_API_VERSION,
      `${path}.apiVersion`,
    ),
    workspaceId,
    agentId,
    laneId,
    runtimeInstanceId,
    runtimeEpoch,
    latestServerSequence,
    commands: Object.freeze([...commands]),
  });
};

const connectionState = (
  input: unknown,
  path: string,
): "online" | "stale" | "offline" =>
  oneOf(input, ["online", "stale", "offline"], path);

const controlState = (input: unknown, path: string): AgentControlState =>
  oneOf(
    input,
    [
      "active",
      "interrupt_requested",
      "hold_requested",
      "resume_requested",
      "paused",
      "held",
    ],
    path,
  );

const taskIdQueue = (input: unknown, path: string): readonly TaskId[] => {
  if (!Array.isArray(input)) {
    return fail(path, "expected an array");
  }
  const parsed = input.map((item, index) =>
    identifier<TaskId>(item, `${path}[${index}]`),
  );
  if (new Set(parsed).size !== parsed.length) {
    return fail(path, "queue must not contain duplicate task IDs");
  }
  return Object.freeze([...parsed]);
};

export const parseRegisteredAgentProjection = (
  input: unknown,
): RegisteredAgentProjection => parseAgent(input, "agent");

const parseAgent = (
  input: unknown,
  path: string,
): RegisteredAgentProjection => {
  const value = exactObject(
    input,
    [
      "workspaceId",
      "agentId",
      "laneId",
      "runtimeInstanceId",
      "runtimeEpoch",
      "displayName",
      "role",
      "capabilities",
      "provider",
      "softwareVersion",
      "checkpointRef",
      "registeredAt",
      "lastSeenAt",
      "leaseExpiresAt",
      "currentAction",
      "connectionState",
      "controlState",
      "controlVersion",
      "queue",
    ],
    path,
  );
  const parsedRole = role(value.role, `${path}.role`);
  const registeredAt = timestamp(value.registeredAt, `${path}.registeredAt`);
  const lastSeenAt = timestamp(value.lastSeenAt, `${path}.lastSeenAt`);
  if (Date.parse(lastSeenAt) < Date.parse(registeredAt)) {
    fail(`${path}.lastSeenAt`, "cannot be earlier than registeredAt");
  }
  return Object.freeze({
    workspaceId: identifier<WorkspaceId>(
      value.workspaceId,
      `${path}.workspaceId`,
    ),
    agentId: identifier<AgentId>(value.agentId, `${path}.agentId`),
    laneId: identifier<LaneId>(value.laneId, `${path}.laneId`),
    runtimeInstanceId: identifier<RuntimeInstanceId>(
      value.runtimeInstanceId,
      `${path}.runtimeInstanceId`,
    ),
    runtimeEpoch: integer(value.runtimeEpoch, `${path}.runtimeEpoch`, 1),
    displayName: nonEmptyString(value.displayName, `${path}.displayName`),
    role: parsedRole,
    capabilities: capabilities(
      value.capabilities,
      parsedRole,
      `${path}.capabilities`,
    ),
    provider: provider(value.provider, `${path}.provider`),
    softwareVersion: nonEmptyString(
      value.softwareVersion,
      `${path}.softwareVersion`,
    ),
    checkpointRef: nullableIdentifier<CheckpointRef>(
      value.checkpointRef,
      `${path}.checkpointRef`,
    ),
    registeredAt,
    lastSeenAt,
    leaseExpiresAt: timestamp(
      value.leaseExpiresAt,
      `${path}.leaseExpiresAt`,
    ),
    currentAction: nullableCurrentAction(
      value.currentAction,
      `${path}.currentAction`,
    ),
    connectionState: connectionState(
      value.connectionState,
      `${path}.connectionState`,
    ),
    controlState: controlState(value.controlState, `${path}.controlState`),
    controlVersion: integer(
      value.controlVersion,
      `${path}.controlVersion`,
      0,
    ),
    queue: taskIdQueue(value.queue, `${path}.queue`),
  });
};

const parseAgentRuntimeUpdate = (
  input: unknown,
  path: string,
): AgentRuntimeUpdate => {
  const value = exactObject(
    input,
    [
      "agentId",
      "laneId",
      "runtimeInstanceId",
      "runtimeEpoch",
      "leaseExpiresAt",
      "lastSeenAt",
      "checkpointRef",
      "currentAction",
      "connectionState",
      "controlState",
      "controlVersion",
      "queue",
    ],
    path,
  );
  return Object.freeze({
    agentId: identifier<AgentId>(value.agentId, `${path}.agentId`),
    laneId: identifier<LaneId>(value.laneId, `${path}.laneId`),
    runtimeInstanceId: identifier<RuntimeInstanceId>(
      value.runtimeInstanceId,
      `${path}.runtimeInstanceId`,
    ),
    runtimeEpoch: integer(value.runtimeEpoch, `${path}.runtimeEpoch`, 1),
    leaseExpiresAt: timestamp(
      value.leaseExpiresAt,
      `${path}.leaseExpiresAt`,
    ),
    lastSeenAt: timestamp(value.lastSeenAt, `${path}.lastSeenAt`),
    checkpointRef: nullableIdentifier<CheckpointRef>(
      value.checkpointRef,
      `${path}.checkpointRef`,
    ),
    currentAction: nullableCurrentAction(
      value.currentAction,
      `${path}.currentAction`,
    ),
    connectionState: connectionState(
      value.connectionState,
      `${path}.connectionState`,
    ),
    controlState: controlState(value.controlState, `${path}.controlState`),
    controlVersion: integer(
      value.controlVersion,
      `${path}.controlVersion`,
      0,
    ),
    queue: taskIdQueue(value.queue, `${path}.queue`),
  });
};

export const parseUiSnapshot = (input: unknown): UiSnapshot =>
  parseSnapshot(input, "snapshot");

const parseSnapshot = (input: unknown, path: string): UiSnapshot => {
  const value = exactObject(
    input,
    [
      "apiVersion",
      "workspaceId",
      "generatedAt",
      "sequence",
      "paused",
      "controlVersion",
      "agents",
      "tasks",
      "progress",
    ],
    path,
  );
  if (!Array.isArray(value.agents)) {
    fail(`${path}.agents`, "expected an array");
  }
  if (!Array.isArray(value.tasks)) {
    fail(`${path}.tasks`, "expected an array");
  }
  if (!Array.isArray(value.progress)) {
    fail(`${path}.progress`, "expected an array");
  }
  const agentInputs = value.agents as unknown[];
  const taskInputs = value.tasks as unknown[];
  const progressInputs = value.progress as unknown[];
  const workspaceId = identifier<WorkspaceId>(
    value.workspaceId,
    `${path}.workspaceId`,
  );
  const agents = agentInputs.map((item, index) =>
    parseAgent(item, `${path}.agents[${index}]`),
  );
  const tasks = taskInputs.map((item, index) =>
    parseTask(item, `${path}.tasks[${index}]`),
  );
  const progress = progressInputs.map((item, index) =>
    parseProgressEventAtPath(item, `${path}.progress[${index}]`),
  );
  for (const agent of agents) {
    if (agent.workspaceId !== workspaceId) {
      fail(`${path}.agents`, "agent workspace does not match the snapshot");
    }
  }
  for (const task of tasks) {
    if (task.workspaceId !== workspaceId) {
      fail(`${path}.tasks`, "task workspace does not match the snapshot");
    }
  }
  if (
    new Set(agents.map((agent) => agent.agentId)).size !== agents.length ||
    new Set(agents.map((agent) => agent.laneId)).size !== agents.length
  ) {
    fail(`${path}.agents`, "agent and lane IDs must be unique");
  }
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) {
    fail(`${path}.tasks`, "task IDs must be unique");
  }
  const taskIds = new Set(tasks.map((task) => task.taskId));
  if (progress.some((entry) => !taskIds.has(entry.taskId))) {
    fail(`${path}.progress`, "progress must reference a task in the snapshot");
  }
  return Object.freeze({
    apiVersion: apiVersion(
      value.apiVersion,
      STEWARD_UI_API_VERSION,
      `${path}.apiVersion`,
    ),
    workspaceId,
    generatedAt: timestamp(value.generatedAt, `${path}.generatedAt`),
    sequence: integer(value.sequence, `${path}.sequence`, 0),
    paused: booleanValue(value.paused, `${path}.paused`),
    controlVersion: integer(
      value.controlVersion,
      `${path}.controlVersion`,
      0,
    ),
    agents: Object.freeze([...agents]),
    tasks: Object.freeze([...tasks]),
    progress: Object.freeze([...progress]),
  });
};

const stringList = (input: unknown, path: string): readonly string[] => {
  if (!Array.isArray(input)) {
    return fail(path, "expected an array");
  }
  const parsed = input.map((item, index) =>
    nonEmptyString(item, `${path}[${index}]`),
  );
  if (new Set(parsed).size !== parsed.length) {
    return fail(path, "must not contain duplicate values");
  }
  return Object.freeze([...parsed]);
};

const originRelativePath = (input: unknown, path: string): string => {
  const parsed = nonEmptyString(input, path);
  if (
    !parsed.startsWith("/") ||
    parsed.startsWith("//") ||
    parsed.includes("\\") ||
    parsed.includes("#") ||
    /[\u0000-\u0020]/.test(parsed)
  ) {
    return fail(path, "expected an origin-relative path");
  }
  return parsed;
};

export const parseUiBootstrap = (input: unknown): UiBootstrap => {
  const path = "bootstrap";
  const value = exactObject(
    input,
    [
      "apiVersion",
      "sessionId",
      "userId",
      "permissions",
      "features",
      "snapshot",
      "eventStream",
      "commandEndpoint",
    ],
    path,
  );
  const snapshot = parseSnapshot(value.snapshot, `${path}.snapshot`);
  const stream = exactObject(
    value.eventStream,
    [
      "href",
      "afterSequence",
      "retentionStartsAtSequence",
      "heartbeatIntervalMs",
    ],
    `${path}.eventStream`,
  );
  const afterSequence = integer(
    stream.afterSequence,
    `${path}.eventStream.afterSequence`,
    0,
  );
  const retentionStartsAtSequence = integer(
    stream.retentionStartsAtSequence,
    `${path}.eventStream.retentionStartsAtSequence`,
    0,
  );
  const heartbeatIntervalMs = integer(
    stream.heartbeatIntervalMs,
    `${path}.eventStream.heartbeatIntervalMs`,
    1,
  );
  if (afterSequence !== snapshot.sequence) {
    fail(
      `${path}.eventStream.afterSequence`,
      "must equal the snapshot sequence",
    );
  }
  if (retentionStartsAtSequence > afterSequence + 1) {
    fail(
      `${path}.eventStream.retentionStartsAtSequence`,
      "cannot be beyond the next event sequence",
    );
  }
  if (heartbeatIntervalMs < 1_000 || heartbeatIntervalMs > 300_000) {
    fail(
      `${path}.eventStream.heartbeatIntervalMs`,
      "must be between 1000 and 300000 milliseconds",
    );
  }
  return Object.freeze({
    apiVersion: apiVersion(
      value.apiVersion,
      STEWARD_UI_API_VERSION,
      `${path}.apiVersion`,
    ),
    sessionId: identifier<SessionId>(value.sessionId, `${path}.sessionId`),
    userId: identifier<UserId>(value.userId, `${path}.userId`),
    permissions: stringList(value.permissions, `${path}.permissions`),
    features: stringList(value.features, `${path}.features`),
    snapshot,
    eventStream: Object.freeze({
      href: originRelativePath(stream.href, `${path}.eventStream.href`),
      afterSequence,
      retentionStartsAtSequence,
      heartbeatIntervalMs,
    }),
    commandEndpoint: originRelativePath(
      value.commandEndpoint,
      `${path}.commandEndpoint`,
    ),
  });
};

const uiEventPayload = (input: unknown, path: string): UiEventPayload => {
  const value = exactObjectForDiscriminator(input, path);
  switch (value.type) {
    case "agent_upserted": {
      const item = exactObject(input, ["type", "agent"], path);
      return Object.freeze({
        type: "agent_upserted",
        agent: parseAgent(item.agent, `${path}.agent`),
      });
    }
    case "agent_removed": {
      const item = exactObject(input, ["type", "agentId", "laneId"], path);
      return Object.freeze({
        type: "agent_removed",
        agentId: identifier<AgentId>(item.agentId, `${path}.agentId`),
        laneId: identifier<LaneId>(item.laneId, `${path}.laneId`),
      });
    }
    case "task_upserted": {
      const item = exactObject(input, ["type", "task"], path);
      return Object.freeze({
        type: "task_upserted",
        task: parseTask(item.task, `${path}.task`),
      });
    }
    case "progress_recorded": {
      const item = exactObject(input, ["type", "progress", "task"], path);
      const progress = parseProgressEventAtPath(
        item.progress,
        `${path}.progress`,
      );
      const task = parseTask(item.task, `${path}.task`);
      if (progress.taskId !== task.taskId) {
        return fail(path, "progress and task IDs must match");
      }
      return Object.freeze({ type: "progress_recorded", progress, task });
    }
    case "agent_runtime_updated": {
      const item = exactObject(input, ["type", "agent", "task"], path);
      return Object.freeze({
        type: "agent_runtime_updated",
        agent: parseAgentRuntimeUpdate(item.agent, `${path}.agent`),
        task:
          item.task === null ? null : parseTask(item.task, `${path}.task`),
      });
    }
    case "workspace_control_updated": {
      const item = exactObject(
        input,
        ["type", "paused", "controlVersion"],
        path,
      );
      return Object.freeze({
        type: "workspace_control_updated",
        paused: booleanValue(item.paused, `${path}.paused`),
        controlVersion: integer(
          item.controlVersion,
          `${path}.controlVersion`,
          0,
        ),
      });
    }
    default:
      return fail(`${path}.type`, "unknown UI event type");
  }
};

export const parseUiEventEnvelope = (input: unknown): UiEventEnvelope => {
  const path = "uiEvent";
  const value = exactObject(
    input,
    [
      "apiVersion",
      "eventId",
      "workspaceId",
      "sequence",
      "occurredAt",
      "causationClientCommandId",
      "payload",
    ],
    path,
  );
  const workspaceId = identifier<WorkspaceId>(
    value.workspaceId,
    `${path}.workspaceId`,
  );
  const payload = uiEventPayload(value.payload, `${path}.payload`);
  if (
    (payload.type === "agent_upserted" &&
      payload.agent.workspaceId !== workspaceId) ||
    (payload.type === "task_upserted" &&
      payload.task.workspaceId !== workspaceId) ||
    (payload.type === "progress_recorded" &&
      payload.task.workspaceId !== workspaceId) ||
    (payload.type === "agent_runtime_updated" &&
      payload.task !== null &&
      payload.task.workspaceId !== workspaceId)
  ) {
    fail(`${path}.payload`, "payload workspace does not match its envelope");
  }
  const common = {
    apiVersion: apiVersion(
      value.apiVersion,
      STEWARD_UI_API_VERSION,
      `${path}.apiVersion`,
    ),
    eventId: identifier<EventId>(value.eventId, `${path}.eventId`),
    workspaceId,
    sequence: integer(value.sequence, `${path}.sequence`, 1),
    occurredAt: timestamp(value.occurredAt, `${path}.occurredAt`),
    payload,
  };
  if (Object.hasOwn(value, "causationClientCommandId")) {
    return Object.freeze({
      ...common,
      causationClientCommandId: identifier<ClientCommandId>(
        value.causationClientCommandId,
        `${path}.causationClientCommandId`,
      ),
    });
  }
  return Object.freeze(common);
};

const humanCommandPayload = (
  input: unknown,
  path: string,
): HumanCommandPayload => {
  const value = exactObjectForDiscriminator(input, path);
  switch (value.type) {
    case "queue_work": {
      const item = exactObject(
        input,
        [
          "type",
          "agentId",
          "laneId",
          "title",
          "objective",
          "expectedAgentMinutes",
          "expectedCompletedAt",
        ],
        path,
      );
      return Object.freeze({
        type: "queue_work",
        agentId: identifier<AgentId>(item.agentId, `${path}.agentId`),
        laneId: identifier<LaneId>(item.laneId, `${path}.laneId`),
        title: nonEmptyString(item.title, `${path}.title`),
        objective: nonEmptyString(item.objective, `${path}.objective`),
        expectedAgentMinutes: expectedAgentMinutes(
          item.expectedAgentMinutes,
          `${path}.expectedAgentMinutes`,
        ),
        expectedCompletedAt: quarterHourTimestamp(
          item.expectedCompletedAt,
          `${path}.expectedCompletedAt`,
        ),
      });
    }
    case "request_interrupt": {
      const item = exactObject(
        input,
        ["type", "agentId", "laneId", "reason"],
        path,
      );
      return Object.freeze({
        type: "request_interrupt",
        agentId: identifier<AgentId>(item.agentId, `${path}.agentId`),
        laneId: identifier<LaneId>(item.laneId, `${path}.laneId`),
        reason: nonEmptyString(item.reason, `${path}.reason`),
      });
    }
    case "resume_agent": {
      const item = exactObject(
        input,
        ["type", "agentId", "laneId", "taskId", "checkpointRef"],
        path,
      );
      return Object.freeze({
        type: "resume_agent",
        agentId: identifier<AgentId>(item.agentId, `${path}.agentId`),
        laneId: identifier<LaneId>(item.laneId, `${path}.laneId`),
        taskId: nullableIdentifier<TaskId>(item.taskId, `${path}.taskId`),
        checkpointRef: nullableIdentifier<CheckpointRef>(
          item.checkpointRef,
          `${path}.checkpointRef`,
        ),
      });
    }
    case "set_workspace_pause": {
      const item = exactObject(input, ["type", "paused", "reason"], path);
      return Object.freeze({
        type: "set_workspace_pause",
        paused: booleanValue(item.paused, `${path}.paused`),
        reason: nonEmptyString(item.reason, `${path}.reason`),
      });
    }
    default:
      return fail(`${path}.type`, "unknown human command type");
  }
};

export const parseHumanCommandEnvelope = (
  input: unknown,
): HumanCommandEnvelope => {
  const path = "humanCommand";
  const value = exactObject(
    input,
    [
      "apiVersion",
      "clientCommandId",
      "workspaceId",
      "expectedControlVersion",
      "issuedAt",
      "payload",
    ],
    path,
  );
  return Object.freeze({
    apiVersion: apiVersion(
      value.apiVersion,
      STEWARD_UI_API_VERSION,
      `${path}.apiVersion`,
    ),
    clientCommandId: identifier<ClientCommandId>(
      value.clientCommandId,
      `${path}.clientCommandId`,
    ),
    workspaceId: identifier<WorkspaceId>(
      value.workspaceId,
      `${path}.workspaceId`,
    ),
    expectedControlVersion: integer(
      value.expectedControlVersion,
      `${path}.expectedControlVersion`,
      0,
    ),
    issuedAt: timestamp(value.issuedAt, `${path}.issuedAt`),
    payload: humanCommandPayload(value.payload, `${path}.payload`),
  });
};

export const parseHumanCommandReceipt = (
  input: unknown,
): HumanCommandReceipt => {
  const path = "humanCommandReceipt";
  const discriminated = exactObjectForDiscriminatorBy(
    input,
    path,
    "state",
  );
  if (discriminated.state === "accepted" || discriminated.state === "duplicate") {
    const value = exactObject(
      input,
      [
        "state",
        "clientCommandId",
        "workspaceId",
        "acceptedAt",
        "currentControlVersion",
        "intentEventSequence",
      ],
      path,
    );
    return Object.freeze({
      state: discriminated.state,
      clientCommandId: identifier<ClientCommandId>(
        value.clientCommandId,
        `${path}.clientCommandId`,
      ),
      workspaceId: identifier<WorkspaceId>(
        value.workspaceId,
        `${path}.workspaceId`,
      ),
      acceptedAt: timestamp(value.acceptedAt, `${path}.acceptedAt`),
      currentControlVersion: integer(
        value.currentControlVersion,
        `${path}.currentControlVersion`,
        0,
      ),
      intentEventSequence: integer(
        value.intentEventSequence,
        `${path}.intentEventSequence`,
        1,
      ),
    });
  }
  if (discriminated.state === "rejected") {
    const value = exactObject(
      input,
      [
        "state",
        "clientCommandId",
        "workspaceId",
        "rejectedAt",
        "currentControlVersion",
        "code",
        "reason",
      ],
      path,
    );
    return Object.freeze({
      state: "rejected",
      clientCommandId: identifier<ClientCommandId>(
        value.clientCommandId,
        `${path}.clientCommandId`,
      ),
      workspaceId: identifier<WorkspaceId>(
        value.workspaceId,
        `${path}.workspaceId`,
      ),
      rejectedAt: timestamp(value.rejectedAt, `${path}.rejectedAt`),
      currentControlVersion: integer(
        value.currentControlVersion,
        `${path}.currentControlVersion`,
        0,
      ),
      code: oneOf(
        value.code,
        [
          "UNAUTHENTICATED",
          "UNAUTHORIZED",
          "VERSION_CONFLICT",
          "COMMAND_ID_CONFLICT",
          "TARGET_NOT_FOUND",
          "INVALID_COMMAND",
        ] as const,
        `${path}.code`,
      ),
      reason: nonEmptyString(value.reason, `${path}.reason`),
    });
  }
  return fail(`${path}.state`, "unknown human command receipt state");
};

const exactObjectForDiscriminatorBy = (
  input: unknown,
  path: string,
  field: string,
): UnknownRecord => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    return fail(path, "expected an object");
  }
  const discriminator = (input as UnknownRecord)[field];
  if (typeof discriminator !== "string") {
    return fail(`${path}.${field}`, "expected a string discriminator");
  }
  return input as UnknownRecord;
};
