export const STEWARD_RUNTIME_API_VERSION = "steward.runtime/v1" as const;
export const STEWARD_UI_API_VERSION = "steward.ui/v1" as const;

declare const opaqueId: unique symbol;
type OpaqueId<Name extends string> = string & {
  readonly [opaqueId]: Name;
};

declare const isoTimestamp: unique symbol;
export type IsoTimestamp = string & { readonly [isoTimestamp]: true };
export type WorkspaceId = OpaqueId<"WorkspaceId">;
export type AgentId = OpaqueId<"AgentId">;
export type LaneId = OpaqueId<"LaneId">;
export type RuntimeInstanceId = OpaqueId<"RuntimeInstanceId">;
export type LeaseId = OpaqueId<"LeaseId">;
export type TaskId = OpaqueId<"TaskId">;
export type EventId = OpaqueId<"EventId">;
export type CommandId = OpaqueId<"CommandId">;
export type ClientCommandId = OpaqueId<"ClientCommandId">;
export type CheckpointRef = OpaqueId<"CheckpointRef">;
export type SessionId = OpaqueId<"SessionId">;
export type UserId = OpaqueId<"UserId">;

export type AgentRole = "engineer" | "verifier" | "manager";
export type AgentCapability =
  | "research"
  | "plan"
  | "modify_workspace"
  | "run_tests"
  | "verify"
  | "review"
  | "coordinate";

export const ROLE_CAPABILITIES = Object.freeze({
  engineer: Object.freeze([
    "research",
    "plan",
    "modify_workspace",
    "run_tests",
  ] as const),
  verifier: Object.freeze(
    ["research", "plan", "run_tests", "verify"] as const,
  ),
  manager: Object.freeze(
    ["research", "plan", "review", "coordinate"] as const,
  ),
}) satisfies Readonly<Record<AgentRole, readonly AgentCapability[]>>;

export type AgentProvider = Readonly<{
  name: "codex" | "claude";
  model: string;
}>;

type SupervisorRegistrationIdentity = Readonly<{
  apiVersion: typeof STEWARD_RUNTIME_API_VERSION;
  workspaceId: WorkspaceId;
  agentId: AgentId;
  laneId: LaneId;
  runtimeInstanceId: RuntimeInstanceId;
  displayName: string;
  role: AgentRole;
  capabilities: readonly AgentCapability[];
  provider: AgentProvider;
  softwareVersion: string;
  checkpointRef: CheckpointRef | null;
}>;

/**
 * A compare-and-swap request for a server-issued fencing epoch. A lane's first
 * runtime sends null. A replacement runtime sends the epoch it observed. The
 * control plane is the only component that chooses the next epoch.
 */
export type SupervisorRegistrationRequest = SupervisorRegistrationIdentity &
  Readonly<{
    expectedRuntimeEpoch: number | null;
  }>;

/** The identity and fencing epoch durably accepted by the control plane. */
export type SupervisorRegistration = SupervisorRegistrationIdentity &
  Readonly<{
    runtimeEpoch: number;
  }>;

export type SupervisorRegistrationResult = Readonly<{
  apiVersion: typeof STEWARD_RUNTIME_API_VERSION;
  workspaceId: WorkspaceId;
  agentId: AgentId;
  laneId: LaneId;
  runtimeInstanceId: RuntimeInstanceId;
  runtimeEpoch: number;
  leaseId: LeaseId;
  leaseGrantedAt: IsoTimestamp;
  leaseExpiresAt: IsoTimestamp;
  lastAcceptedLocalSequence: number;
  controlVersion: number;
}>;

export type LeaseRenewalRequest = Readonly<{
  apiVersion: typeof STEWARD_RUNTIME_API_VERSION;
  workspaceId: WorkspaceId;
  agentId: AgentId;
  laneId: LaneId;
  runtimeInstanceId: RuntimeInstanceId;
  runtimeEpoch: number;
  leaseId: LeaseId;
  lastDurableEventSequence: number;
  sentAt: IsoTimestamp;
}>;

export type LeaseRenewalResult = Readonly<{
  apiVersion: typeof STEWARD_RUNTIME_API_VERSION;
  workspaceId: WorkspaceId;
  agentId: AgentId;
  laneId: LaneId;
  runtimeInstanceId: RuntimeInstanceId;
  runtimeEpoch: number;
  leaseId: LeaseId;
  leaseGrantedAt: IsoTimestamp;
  leaseExpiresAt: IsoTimestamp;
  acceptedThroughLocalSequence: number;
  controlVersion: number;
}>;

export type TaskStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export type AgentTaskProjection = Readonly<{
  taskId: TaskId;
  workspaceId: WorkspaceId;
  agentId: AgentId;
  laneId: LaneId;
  title: string;
  objective: string;
  status: TaskStatus;
  expectedAgentMinutes: number;
  expectedCompletedAt: IsoTimestamp;
  startedAt: IsoTimestamp | null;
  endedAt: IsoTimestamp | null;
}>;

type ProgressBase = Readonly<{
  taskId: TaskId;
  iteration: number;
  journal: string;
  occurredAt: IsoTimestamp;
}>;

export type ProgressEvent =
  | (ProgressBase & Readonly<{ phase: "research" | "plan" | "execute" }>)
  | (ProgressBase &
      Readonly<{ phase: "test"; outcome: "passed" | "failed" }>);

export type CurrentAction = Readonly<{
  taskId: TaskId;
  summary: string;
  startedAt: IsoTimestamp;
}>;

export type ProgressPayload =
  | Readonly<{
      type: "progress";
      taskId: TaskId;
      phase: "research" | "plan" | "execute";
      iteration: number;
      journal: string;
    }>
  | Readonly<{
      type: "progress";
      taskId: TaskId;
      phase: "test";
      iteration: number;
      journal: string;
      outcome: "passed" | "failed";
    }>;

export type DurableOutboxPayload =
  | ProgressPayload
  | Readonly<{
      type: "heartbeat";
      currentAction: CurrentAction | null;
      checkpointRef: CheckpointRef | null;
    }>
  | Readonly<{
      type: "interrupt_acknowledged";
      commandId: CommandId;
      taskId: TaskId | null;
    }>
  | Readonly<{
      type: "interrupt_refused";
      commandId: CommandId;
      reason: string;
    }>
  | Readonly<{
      type: "interrupt_settled";
      commandId: CommandId;
      taskId: TaskId | null;
      checkpointRef: CheckpointRef | null;
    }>
  | Readonly<{
      type: "hold_acknowledged";
      commandId: CommandId;
      taskId: TaskId | null;
    }>
  | Readonly<{
      type: "hold_settled";
      commandId: CommandId;
      taskId: TaskId | null;
      checkpointRef: CheckpointRef | null;
    }>
  | Readonly<{
      type: "task_completed";
      taskId: TaskId;
      result: string;
      checkpointRef: CheckpointRef | null;
    }>
  | Readonly<{
      type: "task_failed";
      taskId: TaskId;
      error: string;
      retryable: boolean;
      checkpointRef: CheckpointRef | null;
    }>;

export type DurableOutboxEvent = Readonly<{
  apiVersion: typeof STEWARD_RUNTIME_API_VERSION;
  eventId: EventId;
  workspaceId: WorkspaceId;
  agentId: AgentId;
  laneId: LaneId;
  runtimeInstanceId: RuntimeInstanceId;
  localSequence: number;
  runtimeEpoch: number;
  occurredAt: IsoTimestamp;
  payload: DurableOutboxPayload;
}>;

export type RuntimeEventBatch = Readonly<{
  apiVersion: typeof STEWARD_RUNTIME_API_VERSION;
  workspaceId: WorkspaceId;
  agentId: AgentId;
  laneId: LaneId;
  runtimeInstanceId: RuntimeInstanceId;
  runtimeEpoch: number;
  events: readonly DurableOutboxEvent[];
}>;

export type RuntimeEventBatchReceipt = Readonly<{
  apiVersion: typeof STEWARD_RUNTIME_API_VERSION;
  workspaceId: WorkspaceId;
  agentId: AgentId;
  laneId: LaneId;
  runtimeInstanceId: RuntimeInstanceId;
  runtimeEpoch: number;
  acceptedThroughLocalSequence: number;
  controlVersion: number;
}>;

export type RuntimeCommandPayload =
  | Readonly<{ type: "assign_task"; task: AgentTaskProjection }>
  | Readonly<{ type: "request_interrupt"; reason: string }>
  | Readonly<{
      type: "resume";
      taskId: TaskId | null;
      checkpointRef: CheckpointRef | null;
    }>
  | Readonly<{ type: "hold"; reason: string }>;

export type RuntimeCommandEnvelope = Readonly<{
  apiVersion: typeof STEWARD_RUNTIME_API_VERSION;
  commandId: CommandId;
  workspaceId: WorkspaceId;
  agentId: AgentId;
  laneId: LaneId;
  serverSequence: number;
  expectedRuntimeEpoch: number;
  issuedAt: IsoTimestamp;
  payload: RuntimeCommandPayload;
}>;

export type RuntimeCommandPollRequest = Readonly<{
  apiVersion: typeof STEWARD_RUNTIME_API_VERSION;
  workspaceId: WorkspaceId;
  agentId: AgentId;
  laneId: LaneId;
  runtimeInstanceId: RuntimeInstanceId;
  runtimeEpoch: number;
  afterServerSequence: number;
}>;

export type RuntimeCommandPollResult = Readonly<{
  apiVersion: typeof STEWARD_RUNTIME_API_VERSION;
  workspaceId: WorkspaceId;
  agentId: AgentId;
  laneId: LaneId;
  runtimeInstanceId: RuntimeInstanceId;
  runtimeEpoch: number;
  latestServerSequence: number;
  commands: readonly RuntimeCommandEnvelope[];
}>;

export type AgentConnectionState = "online" | "stale" | "offline";
export type AgentControlState =
  | "active"
  | "interrupt_requested"
  | "hold_requested"
  | "resume_requested"
  | "paused"
  | "held";

export type RegisteredAgentProjection = Readonly<{
  workspaceId: WorkspaceId;
  agentId: AgentId;
  laneId: LaneId;
  runtimeInstanceId: RuntimeInstanceId;
  runtimeEpoch: number;
  displayName: string;
  role: AgentRole;
  capabilities: readonly AgentCapability[];
  provider: AgentProvider;
  softwareVersion: string;
  checkpointRef: CheckpointRef | null;
  registeredAt: IsoTimestamp;
  lastSeenAt: IsoTimestamp;
  leaseExpiresAt: IsoTimestamp;
  currentAction: CurrentAction | null;
  connectionState: AgentConnectionState;
  controlState: AgentControlState;
  controlVersion: number;
  queue: readonly TaskId[];
}>;

export type UiSnapshot = Readonly<{
  apiVersion: typeof STEWARD_UI_API_VERSION;
  workspaceId: WorkspaceId;
  generatedAt: IsoTimestamp;
  sequence: number;
  paused: boolean;
  controlVersion: number;
  agents: readonly RegisteredAgentProjection[];
  tasks: readonly AgentTaskProjection[];
  progress: readonly ProgressEvent[];
}>;

export type UiBootstrap = Readonly<{
  apiVersion: typeof STEWARD_UI_API_VERSION;
  sessionId: SessionId;
  userId: UserId;
  permissions: readonly string[];
  features: readonly string[];
  snapshot: UiSnapshot;
  eventStream: Readonly<{
    href: string;
    afterSequence: number;
    retentionStartsAtSequence: number;
    heartbeatIntervalMs: number;
  }>;
  commandEndpoint: string;
}>;

export type AgentRuntimeUpdate = Readonly<{
  agentId: AgentId;
  laneId: LaneId;
  runtimeInstanceId: RuntimeInstanceId;
  runtimeEpoch: number;
  leaseExpiresAt: IsoTimestamp;
  lastSeenAt: IsoTimestamp;
  checkpointRef: CheckpointRef | null;
  currentAction: CurrentAction | null;
  connectionState: AgentConnectionState;
  controlState: AgentControlState;
  controlVersion: number;
  queue: readonly TaskId[];
}>;

export type UiEventPayload =
  | Readonly<{ type: "agent_upserted"; agent: RegisteredAgentProjection }>
  | Readonly<{ type: "agent_removed"; agentId: AgentId; laneId: LaneId }>
  | Readonly<{ type: "task_upserted"; task: AgentTaskProjection }>
  | Readonly<{
      type: "progress_recorded";
      progress: ProgressEvent;
      task: AgentTaskProjection;
    }>
  | Readonly<{
      type: "agent_runtime_updated";
      agent: AgentRuntimeUpdate;
      task: AgentTaskProjection | null;
    }>
  | Readonly<{
      type: "workspace_control_updated";
      paused: boolean;
      controlVersion: number;
    }>;

export type UiEventEnvelope = Readonly<{
  apiVersion: typeof STEWARD_UI_API_VERSION;
  eventId: EventId;
  workspaceId: WorkspaceId;
  sequence: number;
  occurredAt: IsoTimestamp;
  causationClientCommandId?: ClientCommandId;
  payload: UiEventPayload;
}>;

export type HumanCommandPayload =
  | Readonly<{
      type: "queue_work";
      agentId: AgentId;
      laneId: LaneId;
      title: string;
      objective: string;
      expectedAgentMinutes: number;
      expectedCompletedAt: IsoTimestamp;
    }>
  | Readonly<{
      type: "request_interrupt";
      agentId: AgentId;
      laneId: LaneId;
      reason: string;
    }>
  | Readonly<{
      type: "resume_agent";
      agentId: AgentId;
      laneId: LaneId;
      taskId: TaskId | null;
      checkpointRef: CheckpointRef | null;
    }>
  | Readonly<{
      type: "set_workspace_pause";
      paused: boolean;
      reason: string;
    }>;

export type HumanCommandEnvelope = Readonly<{
  apiVersion: typeof STEWARD_UI_API_VERSION;
  clientCommandId: ClientCommandId;
  workspaceId: WorkspaceId;
  expectedControlVersion: number;
  issuedAt: IsoTimestamp;
  payload: HumanCommandPayload;
}>;

export type HumanCommandRejectionCode =
  | "UNAUTHENTICATED"
  | "UNAUTHORIZED"
  | "VERSION_CONFLICT"
  | "COMMAND_ID_CONFLICT"
  | "TARGET_NOT_FOUND"
  | "INVALID_COMMAND";

export type HumanCommandReceipt =
  | Readonly<{
      state: "accepted" | "duplicate";
      clientCommandId: ClientCommandId;
      workspaceId: WorkspaceId;
      acceptedAt: IsoTimestamp;
      currentControlVersion: number;
      intentEventSequence: number;
    }>
  | Readonly<{
      state: "rejected";
      clientCommandId: ClientCommandId;
      workspaceId: WorkspaceId;
      rejectedAt: IsoTimestamp;
      currentControlVersion: number;
      code: HumanCommandRejectionCode;
      reason: string;
    }>;
