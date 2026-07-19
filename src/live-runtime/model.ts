import {
  STEWARD_UI_API_VERSION,
  parseHumanCommandEnvelope,
  type AgentTaskProjection,
  type HumanCommandEnvelope,
  type IsoTimestamp,
  type ProgressEvent,
  type RegisteredAgentProjection,
  type UiSnapshot,
} from '@cicada/steward-protocol';

const QUARTER_HOUR_MS = 15 * 60 * 1_000;

export interface AgentTaskGroups {
  readonly queued: readonly AgentTaskProjection[];
  readonly running: readonly AgentTaskProjection[];
  readonly completed: readonly AgentTaskProjection[];
  readonly attention: readonly AgentTaskProjection[];
}

export interface AgentOperatorView {
  readonly agent: RegisteredAgentProjection;
  readonly tasks: AgentTaskGroups;
  readonly progress: readonly ProgressEvent[];
}

function belongsToAgent(
  task: AgentTaskProjection,
  agent: RegisteredAgentProjection,
): boolean {
  return task.agentId === agent.agentId && task.laneId === agent.laneId;
}

function latestFirst<Value extends { readonly occurredAt: IsoTimestamp }>(
  values: readonly Value[],
): readonly Value[] {
  return [...values].sort(
    (left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt),
  );
}

/** Builds the operator view exclusively from the authoritative UI snapshot. */
export function mapSnapshotToAgents(snapshot: UiSnapshot): readonly AgentOperatorView[] {
  const tasksById = new Map(snapshot.tasks.map((task) => [task.taskId, task]));

  return Object.freeze(snapshot.agents.map((agent) => {
    const ownedTasks = snapshot.tasks.filter((task) => belongsToAgent(task, agent));
    const queuedIds = new Set(agent.queue);
    const orderedQueued = agent.queue
      .map((taskId) => tasksById.get(taskId))
      .filter(
        (task): task is AgentTaskProjection =>
          task !== undefined && task.status === 'queued' && belongsToAgent(task, agent),
      );
    const unlistedQueued = ownedTasks.filter(
      (task) => task.status === 'queued' && !queuedIds.has(task.taskId),
    );
    const taskIds = new Set(ownedTasks.map((task) => task.taskId));

    return Object.freeze({
      agent,
      tasks: Object.freeze({
        queued: Object.freeze([...orderedQueued, ...unlistedQueued]),
        running: Object.freeze(ownedTasks.filter((task) => task.status === 'running')),
        completed: Object.freeze(ownedTasks.filter((task) => task.status === 'completed')),
        attention: Object.freeze(
          ownedTasks.filter((task) => task.status === 'paused' || task.status === 'failed'),
        ),
      }),
      progress: Object.freeze(
        latestFirst(snapshot.progress.filter((event) => taskIds.has(event.taskId))),
      ),
    });
  }));
}

function assertAgentMinutes(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value % 15 !== 0) {
    throw new TypeError('Expected agent time must be a positive multiple of 15 minutes.');
  }
}

/**
 * Adds agent-only working time, then snaps upward to a wall-clock quarter hour
 * because the current wire contract requires a precomputed deadline.
 */
export function expectedCompletionForAgentTime(
  issuedAt: Date,
  expectedAgentMinutes: number,
): IsoTimestamp {
  assertAgentMinutes(expectedAgentMinutes);
  const issuedAtMs = issuedAt.getTime();
  if (!Number.isFinite(issuedAtMs)) throw new TypeError('Issued time must be valid.');
  const rawCompletion = issuedAtMs + expectedAgentMinutes * 60 * 1_000;
  const onBoundary = Math.ceil(rawCompletion / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
  return new Date(onBoundary).toISOString() as IsoTimestamp;
}

interface CommandContext {
  readonly snapshot: UiSnapshot;
  readonly clientCommandId: string;
  readonly issuedAt: Date;
}

export interface QueueWorkCommandInput extends CommandContext {
  readonly agent: RegisteredAgentProjection;
  readonly title: string;
  readonly objective: string;
  readonly expectedAgentMinutes: number;
}

export function buildQueueWorkCommand(input: QueueWorkCommandInput): HumanCommandEnvelope {
  if (input.agent.role !== 'engineer') {
    throw new TypeError('Development work can be queued only to an engineer lane.');
  }
  const issuedAt = input.issuedAt.toISOString() as IsoTimestamp;
  return parseHumanCommandEnvelope({
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: input.clientCommandId,
    workspaceId: input.snapshot.workspaceId,
    expectedControlVersion: input.snapshot.controlVersion,
    issuedAt,
    payload: {
      type: 'queue_work',
      agentId: input.agent.agentId,
      laneId: input.agent.laneId,
      subject: { type: 'development' },
      title: input.title.trim(),
      objective: input.objective.trim(),
      expectedAgentMinutes: input.expectedAgentMinutes,
      expectedCompletedAt: expectedCompletionForAgentTime(
        input.issuedAt,
        input.expectedAgentMinutes,
      ),
    },
  });
}

export interface InterruptCommandInput extends CommandContext {
  readonly agent: RegisteredAgentProjection;
  readonly reason: string;
}

export function buildInterruptCommand(input: InterruptCommandInput): HumanCommandEnvelope {
  return parseHumanCommandEnvelope({
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: input.clientCommandId,
    workspaceId: input.snapshot.workspaceId,
    expectedControlVersion: input.snapshot.controlVersion,
    issuedAt: input.issuedAt.toISOString(),
    payload: {
      type: 'request_interrupt',
      agentId: input.agent.agentId,
      laneId: input.agent.laneId,
      reason: input.reason.trim(),
    },
  });
}

export interface ResumeAgentCommandInput extends CommandContext {
  readonly agent: RegisteredAgentProjection;
  readonly task: AgentTaskProjection | null;
}

export function buildResumeAgentCommand(
  input: ResumeAgentCommandInput,
): HumanCommandEnvelope {
  if (
    input.task !== null &&
    (input.task.agentId !== input.agent.agentId || input.task.laneId !== input.agent.laneId)
  ) {
    throw new TypeError('A resume task must belong to the selected agent lane.');
  }
  if (input.task !== null && input.task.status !== 'paused') {
    throw new TypeError('Only a paused task can be resumed.');
  }
  return parseHumanCommandEnvelope({
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: input.clientCommandId,
    workspaceId: input.snapshot.workspaceId,
    expectedControlVersion: input.snapshot.controlVersion,
    issuedAt: input.issuedAt.toISOString(),
    payload: {
      type: 'resume_agent',
      agentId: input.agent.agentId,
      laneId: input.agent.laneId,
      taskId: input.task?.taskId ?? null,
      checkpointRef: input.agent.checkpointRef,
    },
  });
}

export interface WorkspacePauseCommandInput extends CommandContext {
  readonly paused: boolean;
  readonly reason: string;
}

export function buildWorkspacePauseCommand(
  input: WorkspacePauseCommandInput,
): HumanCommandEnvelope {
  return parseHumanCommandEnvelope({
    apiVersion: STEWARD_UI_API_VERSION,
    clientCommandId: input.clientCommandId,
    workspaceId: input.snapshot.workspaceId,
    expectedControlVersion: input.snapshot.controlVersion,
    issuedAt: input.issuedAt.toISOString(),
    payload: {
      type: 'set_workspace_pause',
      paused: input.paused,
      reason: input.reason.trim(),
    },
  });
}

/** A fresh ID is created once per intent and retained when that intent is retried. */
export function createClientCommandId(
  randomUuid: (() => string) | undefined = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
): string {
  if (!randomUuid) throw new Error('Secure command IDs are unavailable in this browser.');
  return `ui_${randomUuid()}`;
}
