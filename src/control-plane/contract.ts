import type {
  AgentId,
  AgentExpectedMinutes,
  AgentLaneId,
  AgentRole,
  AgentRunId,
  AgentTaskId,
  ISODateTime,
  ReleaseId,
  UserId,
  WorkItemId,
} from '../domain';

declare const controlPlaneBrand: unique symbol;

type ControlPlaneBrand<Value, Name extends string> = Value & {
  readonly [controlPlaneBrand]: Name;
};

export type WorkspaceId = ControlPlaneBrand<string, 'WorkspaceId'>;
export type RuntimeInstanceId = ControlPlaneBrand<string, 'RuntimeInstanceId'>;
export type ControlPlaneEventId = ControlPlaneBrand<string, 'ControlPlaneEventId'>;
export type FrontendCommandId = ControlPlaneBrand<string, 'FrontendCommandId'>;
export type FrontendSessionId = ControlPlaneBrand<string, 'FrontendSessionId'>;

export const workspaceId = (value: string): WorkspaceId => value as WorkspaceId;
export const runtimeInstanceId = (value: string): RuntimeInstanceId =>
  value as RuntimeInstanceId;
export const controlPlaneEventId = (value: string): ControlPlaneEventId =>
  value as ControlPlaneEventId;
export const frontendCommandId = (value: string): FrontendCommandId =>
  value as FrontendCommandId;
export const frontendSessionId = (value: string): FrontendSessionId =>
  value as FrontendSessionId;

export const STEWARD_UI_API_VERSION = 'steward.ui/v1' as const;

export type AgentConnectivity = 'online' | 'stale' | 'offline';

export interface AgentLeaseProjection {
  readonly state: AgentConnectivity;
  readonly registeredAt: ISODateTime;
  readonly lastSeenAt: ISODateTime;
  readonly leaseExpiresAt: ISODateTime;
  /** Control-plane-issued fencing token; increases with every new runtime owner. */
  readonly runtimeEpoch: number;
}

export interface ActiveRunProjection {
  readonly id: AgentRunId;
  readonly state:
    | 'starting'
    | 'running'
    | 'interrupt_requested'
    | 'interrupt_acknowledged'
    | 'interrupt_refused'
    | 'interrupt_unknown'
    | 'interrupted';
  readonly startedAt: ISODateTime;
}

/**
 * Durable task state is independent of an expendable provider run. This is
 * what lets a reloaded frontend rediscover original task timing after a run
 * is interrupted, resumed, or replaced.
 */
export interface AgentTaskProjection {
  readonly id: AgentTaskId;
  readonly workItemId: WorkItemId;
  readonly status: 'running' | 'paused' | 'completed';
  readonly startedAt: ISODateTime;
  readonly expectedAgentMinutes: AgentExpectedMinutes;
  /** Server-authored and snapped upward to a 15-minute wall-clock boundary. */
  readonly expectedCompletedAt: ISODateTime;
  readonly endedAt?: ISODateTime;
}

/**
 * Authoritative discovery record returned by the control plane. The browser
 * never connects to `runtimeInstanceId`; it is identity and audit metadata.
 */
export interface DiscoveredAgent {
  readonly agentId: AgentId;
  readonly laneId: AgentLaneId;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly displayName: string;
  readonly role: AgentRole;
  readonly capabilities: readonly string[];
  readonly lease: AgentLeaseProjection;
  readonly activeRun?: ActiveRunProjection;
  readonly task?: AgentTaskProjection;
  /** Advances for every registry projection change, including heartbeats. */
  readonly projectionVersion: number;
  /** Advances only for human-commandable lane state and is used for CAS. */
  readonly controlVersion: number;
}

export interface WorkspaceDiscoverySnapshot {
  readonly apiVersion: typeof STEWARD_UI_API_VERSION;
  readonly workspaceId: WorkspaceId;
  readonly sequence: number;
  /** Compare-and-swap version for workspace-wide human controls. */
  readonly controlVersion: number;
  readonly generatedAt: ISODateTime;
  readonly paused: boolean;
  readonly agents: readonly DiscoveredAgent[];
}

export interface FrontendBootstrap {
  readonly apiVersion: typeof STEWARD_UI_API_VERSION;
  readonly sessionId: FrontendSessionId;
  readonly userId: UserId;
  readonly permissions: readonly string[];
  /** Server-advertised optional UI behaviors; absence must fail to read-only or hidden. */
  readonly features: readonly string[];
  readonly snapshot: WorkspaceDiscoverySnapshot;
  readonly eventStream: {
    readonly href: string;
    readonly afterSequence: number;
    readonly retentionStartsAtSequence: number;
    readonly heartbeatIntervalMs: number;
  };
  readonly commandEndpoint: string;
}

export type AgentRegistryEventPayload =
  | {
      readonly type: 'agent_upserted';
      readonly agent: DiscoveredAgent;
    }
  | {
      readonly type: 'agent_removed';
      readonly laneId: AgentLaneId;
      readonly agentId: AgentId;
      readonly laneProjectionVersion: number;
      /** Disconnection never removes a lane; only explicit lifecycle changes do. */
      readonly reason: 'retired' | 'identity_replaced';
    }
  | {
      readonly type: 'workspace_pause_changed';
      readonly paused: boolean;
      readonly workspaceControlVersion: number;
    };

export interface AgentRegistryEvent {
  readonly apiVersion: typeof STEWARD_UI_API_VERSION;
  readonly id: ControlPlaneEventId;
  readonly workspaceId: WorkspaceId;
  readonly sequence: number;
  /** Control-plane commit time; nondecreasing within a workspace event sequence. */
  readonly occurredAt: ISODateTime;
  readonly causationCommandId?: FrontendCommandId;
  readonly payload: AgentRegistryEventPayload;
}

export type FrontendCommandPayload =
  | {
      readonly type: 'queue_work';
      readonly title: string;
      readonly desiredOutcome: string;
      readonly priority: 'next' | 'backlog';
      /** Agent working time only; never an estimate for human review. */
      readonly expectedAgentMinutes: AgentExpectedMinutes;
    }
  | {
      readonly type: 'request_interrupt';
      readonly runId: AgentRunId;
      readonly reason: string;
    }
  | {
      readonly type: 'resume_agent';
    }
  | {
      readonly type: 'set_workspace_pause';
      readonly paused: boolean;
    }
  | {
      readonly type: 'record_product_decision';
      readonly optionId: string;
    }
  | {
      readonly type: 'approve_production';
      readonly releaseId: ReleaseId;
      readonly confirmation: string;
    };

export type FrontendCommandPrecondition =
  | {
      readonly resource: 'lane';
      readonly id: AgentLaneId;
      readonly version: number;
    }
  | {
      readonly resource: 'workspace';
      readonly version: number;
    }
  | {
      readonly resource: 'approval';
      readonly id: string;
      readonly version: number;
    };

/**
 * A command asks the durable control plane to act. Its typed precondition
 * prevents stale writes to the exact lane, workspace, or approval resource.
 */
interface FrontendCommandBase {
  readonly apiVersion: typeof STEWARD_UI_API_VERSION;
  readonly id: FrontendCommandId;
  readonly workspaceId: WorkspaceId;
  /** Diagnostic client time only; the control plane assigns authoritative time. */
  readonly clientIssuedAt: ISODateTime;
}

export type FrontendCommand = FrontendCommandBase &
  (
    | {
        readonly precondition: Extract<FrontendCommandPrecondition, { resource: 'lane' }>;
        readonly payload: Extract<
          FrontendCommandPayload,
          { type: 'queue_work' | 'request_interrupt' | 'resume_agent' }
        >;
      }
    | {
        readonly precondition: Extract<FrontendCommandPrecondition, { resource: 'workspace' }>;
        readonly payload: Extract<FrontendCommandPayload, { type: 'set_workspace_pause' }>;
      }
    | {
        readonly precondition: Extract<FrontendCommandPrecondition, { resource: 'approval' }>;
        readonly payload: Extract<
          FrontendCommandPayload,
          { type: 'record_product_decision' | 'approve_production' }
        >;
      }
  );

export type FrontendCommandReceipt =
  | {
      readonly state: 'accepted' | 'duplicate';
      readonly commandId: FrontendCommandId;
      readonly workspaceId: WorkspaceId;
      readonly acceptedAt: ISODateTime;
      readonly currentTargetVersion: number;
      /** Original durable intent event, including when this is a later retry. */
      readonly intentEventSequence: number;
    }
  | {
      readonly state: 'rejected';
      readonly commandId: FrontendCommandId;
      readonly workspaceId: WorkspaceId;
      readonly rejectedAt: ISODateTime;
      readonly currentTargetVersion: number;
      readonly code:
        | 'UNAUTHENTICATED'
        | 'UNAUTHORIZED'
        | 'VERSION_CONFLICT'
        | 'COMMAND_ID_CONFLICT'
        | 'TARGET_NOT_FOUND'
        | 'INVALID_COMMAND';
      readonly reason: string;
    };

export interface AgentEventSubscription {
  close(): void;
}

export type AgentEventStreamTermination =
  | {
      readonly kind: 'transient_network' | 'server_shutdown';
      readonly retryAfterMs?: number;
    }
  | {
      readonly kind: 'retention_miss';
      readonly retentionStartsAtSequence: number;
    }
  | {
      readonly kind: 'authentication_expired';
    }
  | {
      readonly kind: 'incompatible_protocol';
      readonly supportedVersions: readonly string[];
    };

/**
 * The only production dependency the React application should consume.
 * This first contract slice models registry discovery; task, evidence, review,
 * and approval projections must join the same gateway before App is migrated.
 */
export interface ControlPlaneGateway {
  bootstrap(signal?: AbortSignal): Promise<FrontendBootstrap>;
  subscribe(input: {
    readonly afterSequence: number;
    readonly onEvent: (event: AgentRegistryEvent) => void;
    readonly onDisconnect: (reason: AgentEventStreamTermination) => void;
  }): AgentEventSubscription;
  submit(command: FrontendCommand, signal?: AbortSignal): Promise<FrontendCommandReceipt>;
}

/** This identifies the intent event; it never proves that a runtime side effect finished. */
export function commandIntentEventWasObserved(
  receipt: FrontendCommandReceipt,
  event: AgentRegistryEvent,
): boolean {
  return (
    receipt.state !== 'rejected' &&
    event.workspaceId === receipt.workspaceId &&
    event.sequence === receipt.intentEventSequence &&
    event.causationCommandId === receipt.commandId
  );
}

/** A bootstrap after this sequence already contains the command's durable intent. */
export function commandIntentIsInSnapshot(
  receipt: FrontendCommandReceipt,
  snapshot: WorkspaceDiscoverySnapshot,
): boolean {
  return (
    receipt.state !== 'rejected' &&
    snapshot.workspaceId === receipt.workspaceId &&
    Number.isSafeInteger(snapshot.sequence) &&
    snapshot.sequence >= receipt.intentEventSequence
  );
}
