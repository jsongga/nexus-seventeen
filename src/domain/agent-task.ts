import type {
  AgentId,
  AgentLaneId,
  Brand,
  ISODateTime,
  PolicyDecision,
  PolicyFailureCode,
  WorkItemId,
} from './types';

export const AGENT_ESTIMATE_INTERVAL_MINUTES = 15;

const MILLISECONDS_PER_MINUTE = 60_000;
const ESTIMATE_INTERVAL_MILLISECONDS =
  AGENT_ESTIMATE_INTERVAL_MINUTES * MILLISECONDS_PER_MINUTE;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type AgentTaskId = Brand<string, 'AgentTaskId'>;
export type AgentExpectedMinutes = Brand<number, 'AgentExpectedMinutes'>;

export const agentTaskId = (value: string): AgentTaskId => value as AgentTaskId;

/**
 * Agent-active time only. Human review, interruption, and other human wait time
 * are deliberately excluded and represented by task pauses instead.
 */
export function agentExpectedMinutes(value: number): AgentExpectedMinutes {
  if (!isAgentExpectedMinutes(value)) {
    throw new Error(
      `Expected agent time must be a positive safe integer divisible by ${AGENT_ESTIMATE_INTERVAL_MINUTES} minutes.`,
    );
  }

  return value as AgentExpectedMinutes;
}

export function isAgentExpectedMinutes(value: unknown): value is AgentExpectedMinutes {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value % AGENT_ESTIMATE_INTERVAL_MINUTES === 0
  );
}

export interface AgentTaskPause {
  readonly pausedAt: ISODateTime;
  readonly resumedAt?: ISODateTime;
}

export type AgentTaskStatus = 'running' | 'paused' | 'completed';

/**
 * A durable unit of agent work. It intentionally has no provider run ID: a
 * provider attempt may be interrupted or replaced without restarting the task.
 */
export interface AgentTask {
  readonly id: AgentTaskId;
  readonly laneId: AgentLaneId;
  readonly agentId: AgentId;
  readonly workItemId: WorkItemId;
  readonly title: string;
  readonly expectedAgentMinutes: AgentExpectedMinutes;
  readonly status: AgentTaskStatus;
  readonly startedAt: ISODateTime;
  readonly expectedCompletedAt: ISODateTime;
  readonly pauses: readonly AgentTaskPause[];
  readonly endedAt?: ISODateTime;
}

function allow<Value>(value: Value): PolicyDecision<Value> {
  return { allowed: true, value };
}

function deny<Value>(code: PolicyFailureCode, reason: string): PolicyDecision<Value> {
  return { allowed: false, code, reason };
}

function validTimestamp(value: unknown): value is ISODateTime {
  return (
    typeof value === 'string' &&
    ISO_DATE_TIME_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function timestampMilliseconds(value: ISODateTime): number {
  return Date.parse(value);
}

function snapUpToEstimateInterval(
  timestampMillisecondsValue: number,
): ISODateTime | undefined {
  const snapped =
    Math.ceil(timestampMillisecondsValue / ESTIMATE_INTERVAL_MILLISECONDS) *
    ESTIMATE_INTERVAL_MILLISECONDS;
  const date = new Date(snapped);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString() as ISODateTime;
}

function totalClosedPauseMilliseconds(pauses: readonly AgentTaskPause[]): number {
  return pauses.reduce((total, pause) => {
    if (pause.resumedAt === undefined) {
      return total;
    }

    return total + timestampMilliseconds(pause.resumedAt) - timestampMilliseconds(pause.pausedAt);
  }, 0);
}

function expectedCompletedAt(input: {
  readonly startedAt: ISODateTime;
  readonly expectedAgentMinutes: AgentExpectedMinutes;
  readonly pauses: readonly AgentTaskPause[];
}): ISODateTime | undefined {
  const unsnapped =
    timestampMilliseconds(input.startedAt) +
    input.expectedAgentMinutes * MILLISECONDS_PER_MINUTE +
    totalClosedPauseMilliseconds(input.pauses);

  return snapUpToEstimateInterval(unsnapped);
}

function immutableTask(task: AgentTask): AgentTask {
  return Object.freeze({
    ...task,
    pauses: Object.freeze(
      task.pauses.map((pause) => Object.freeze({ ...pause })),
    ),
  });
}

function latestTransitionAt(task: AgentTask): ISODateTime {
  const latestPause = task.pauses.at(-1);
  return latestPause?.resumedAt ?? latestPause?.pausedAt ?? task.startedAt;
}

function validIdentifiers(task: Record<string, unknown>): boolean {
  return (
    typeof task.id === 'string' &&
    task.id.trim().length > 0 &&
    typeof task.laneId === 'string' &&
    task.laneId.trim().length > 0 &&
    typeof task.agentId === 'string' &&
    task.agentId.trim().length > 0 &&
    typeof task.workItemId === 'string' &&
    task.workItemId.trim().length > 0
  );
}

/** Validates both stored fields and the derived forecast. */
export function isAgentTask(value: unknown): value is AgentTask {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    !validIdentifiers(candidate) ||
    typeof candidate.title !== 'string' ||
    candidate.title.trim().length === 0 ||
    !isAgentExpectedMinutes(candidate.expectedAgentMinutes) ||
    !validTimestamp(candidate.startedAt) ||
    !validTimestamp(candidate.expectedCompletedAt) ||
    !Array.isArray(candidate.pauses) ||
    (candidate.status !== 'running' &&
      candidate.status !== 'paused' &&
      candidate.status !== 'completed')
  ) {
    return false;
  }

  let previousTransitionAt = timestampMilliseconds(candidate.startedAt);
  let hasOpenPause = false;
  const pauses: AgentTaskPause[] = [];

  for (const valuePause of candidate.pauses) {
    if (typeof valuePause !== 'object' || valuePause === null || Array.isArray(valuePause)) {
      return false;
    }

    const pause = valuePause as Record<string, unknown>;
    if (
      !validTimestamp(pause.pausedAt) ||
      timestampMilliseconds(pause.pausedAt) < previousTransitionAt ||
      hasOpenPause
    ) {
      return false;
    }

    if (pause.resumedAt === undefined) {
      hasOpenPause = true;
      pauses.push({ pausedAt: pause.pausedAt });
      previousTransitionAt = timestampMilliseconds(pause.pausedAt);
      continue;
    }

    if (
      !validTimestamp(pause.resumedAt) ||
      timestampMilliseconds(pause.resumedAt) < timestampMilliseconds(pause.pausedAt)
    ) {
      return false;
    }

    pauses.push({ pausedAt: pause.pausedAt, resumedAt: pause.resumedAt });
    previousTransitionAt = timestampMilliseconds(pause.resumedAt);
  }

  if ((candidate.status === 'paused') !== hasOpenPause) {
    return false;
  }

  if (candidate.status === 'completed') {
    if (
      !validTimestamp(candidate.endedAt) ||
      timestampMilliseconds(candidate.endedAt) < previousTransitionAt
    ) {
      return false;
    }
  } else if (candidate.endedAt !== undefined) {
    return false;
  }

  return (
    candidate.expectedCompletedAt ===
    expectedCompletedAt({
      startedAt: candidate.startedAt,
      expectedAgentMinutes: candidate.expectedAgentMinutes,
      pauses,
    })
  );
}

export interface StartAgentTaskInput {
  readonly id: AgentTaskId;
  readonly laneId: AgentLaneId;
  readonly agentId: AgentId;
  readonly workItemId: WorkItemId;
  readonly title: string;
  readonly expectedAgentMinutes: AgentExpectedMinutes;
  readonly startedAt: ISODateTime;
}

export function startAgentTask(
  input: StartAgentTaskInput,
): PolicyDecision<AgentTask> {
  if (
    !validTimestamp(input.startedAt) ||
    !isAgentExpectedMinutes(input.expectedAgentMinutes)
  ) {
    return deny(
      'AGENT_TASK_TIMING_INVALID',
      `Agent tasks require a valid ISO start time and a positive estimate divisible by ${AGENT_ESTIMATE_INTERVAL_MINUTES} minutes.`,
    );
  }

  if (input.title.trim().length === 0) {
    return deny(
      'AGENT_TASK_TIMING_INVALID',
      'Agent tasks require a non-empty title so their timing remains attributable.',
    );
  }

  const pauses: readonly AgentTaskPause[] = [];
  const forecast = expectedCompletedAt({
    startedAt: input.startedAt,
    expectedAgentMinutes: input.expectedAgentMinutes,
    pauses,
  });
  if (forecast === undefined) {
    return deny(
      'AGENT_TASK_TIMING_INVALID',
      'The expected agent completion falls outside the supported ISO date range.',
    );
  }

  return allow(
    immutableTask({
      ...input,
      title: input.title.trim(),
      status: 'running',
      expectedCompletedAt: forecast,
      pauses,
    }),
  );
}

export interface PauseAgentTaskInput {
  readonly task: AgentTask;
  readonly pausedAt: ISODateTime;
}

/** Pauses the task forecast for human wait without ending the durable task. */
export function pauseAgentTask(
  input: PauseAgentTaskInput,
): PolicyDecision<AgentTask> {
  if (!isAgentTask(input.task)) {
    return deny('AGENT_TASK_TIMING_INVALID', 'The agent task contains invalid timing state.');
  }

  if (input.task.status !== 'running') {
    return deny(
      'INVALID_AGENT_TASK_TRANSITION',
      'Only a running agent task may be paused for human wait.',
    );
  }

  if (
    !validTimestamp(input.pausedAt) ||
    timestampMilliseconds(input.pausedAt) < timestampMilliseconds(latestTransitionAt(input.task))
  ) {
    return deny(
      'AGENT_TASK_TIMING_INVALID',
      'A task pause requires a valid ISO timestamp that does not precede the prior transition.',
    );
  }

  return allow(
    immutableTask({
      ...input.task,
      status: 'paused',
      pauses: [...input.task.pauses, { pausedAt: input.pausedAt }],
    }),
  );
}

export interface ResumeAgentTaskInput {
  readonly task: AgentTask;
  readonly resumedAt: ISODateTime;
}

export function resumeAgentTask(
  input: ResumeAgentTaskInput,
): PolicyDecision<AgentTask> {
  if (!isAgentTask(input.task)) {
    return deny('AGENT_TASK_TIMING_INVALID', 'The agent task contains invalid timing state.');
  }

  const openPause = input.task.pauses.at(-1);
  if (
    input.task.status !== 'paused' ||
    openPause === undefined ||
    openPause.resumedAt !== undefined
  ) {
    return deny(
      'INVALID_AGENT_TASK_TRANSITION',
      'Only a paused agent task may resume.',
    );
  }

  if (
    !validTimestamp(input.resumedAt) ||
    timestampMilliseconds(input.resumedAt) < timestampMilliseconds(openPause.pausedAt)
  ) {
    return deny(
      'AGENT_TASK_TIMING_INVALID',
      'A task resume requires a valid ISO timestamp that does not precede its pause.',
    );
  }

  const pauses = [
    ...input.task.pauses.slice(0, -1),
    { pausedAt: openPause.pausedAt, resumedAt: input.resumedAt },
  ];
  const forecast = expectedCompletedAt({
    startedAt: input.task.startedAt,
    expectedAgentMinutes: input.task.expectedAgentMinutes,
    pauses,
  });
  if (forecast === undefined) {
    return deny(
      'AGENT_TASK_TIMING_INVALID',
      'The resumed task forecast falls outside the supported ISO date range.',
    );
  }

  return allow(
    immutableTask({
      ...input.task,
      status: 'running',
      pauses,
      expectedCompletedAt: forecast,
    }),
  );
}

export interface CompleteAgentTaskInput {
  readonly task: AgentTask;
  readonly endedAt: ISODateTime;
}

export function completeAgentTask(
  input: CompleteAgentTaskInput,
): PolicyDecision<AgentTask> {
  if (!isAgentTask(input.task)) {
    return deny('AGENT_TASK_TIMING_INVALID', 'The agent task contains invalid timing state.');
  }

  if (input.task.status !== 'running') {
    return deny(
      'INVALID_AGENT_TASK_TRANSITION',
      'Only a running agent task may complete.',
    );
  }

  if (
    !validTimestamp(input.endedAt) ||
    timestampMilliseconds(input.endedAt) < timestampMilliseconds(latestTransitionAt(input.task))
  ) {
    return deny(
      'AGENT_TASK_TIMING_INVALID',
      'Task completion requires a valid ISO end time that does not precede the prior transition.',
    );
  }

  return allow(
    immutableTask({
      ...input.task,
      status: 'completed',
      endedAt: input.endedAt,
    }),
  );
}
