import type {
  IsoTimestamp,
  TaskId,
  TaskStatus,
  UiBootstrap,
  UiEventEnvelope,
  WorkspaceId,
} from "#shared/protocol";
import type {
  ModelRouteDecision,
  RouteDecision,
} from "#shared/model-routing";

export const IMPACT_API_VERSION = "steward.impact/v1" as const;
export const IMPACT_ROUTING_API_VERSION = "steward.impact-routing/v1" as const;

export interface ImpactModelTaskFacts {
  readonly title: string;
  readonly objective: string;
  readonly status: TaskStatus;
  readonly recentUpdates: readonly string[];
}

export interface ImpactModelRequest {
  readonly instruction: string;
  readonly task: ImpactModelTaskFacts;
  readonly estimatedInputTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * The only capability passed to an impact provider. The policy-selected model
 * is explicit and the empty tool list cannot be widened by an adapter.
 */
export interface ImpactModelInvocation extends ImpactModelRequest {
  readonly route: ModelRouteDecision;
  readonly tools: readonly [];
}

export interface ImpactModelResult {
  readonly text: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * A deliberately narrow adapter boundary. It receives only redacted, bounded
 * facts and has no control-plane client, agent identity, or deployment method.
 */
export interface WeakImpactModelAdapter {
  readonly name: string;
  summarize(request: ImpactModelInvocation, signal?: AbortSignal): Promise<ImpactModelResult>;
  close?(): Promise<void>;
}

export interface ImpactRouteAudit {
  readonly taskId: TaskId;
  readonly sourceSequence: number;
  readonly routedAt: IsoTimestamp;
  readonly decision: RouteDecision;
  readonly tools: readonly [];
}

export interface ImpactRoutingSnapshot {
  readonly apiVersion: typeof IMPACT_ROUTING_API_VERSION;
  readonly workspaceId: WorkspaceId;
  readonly generatedAt: IsoTimestamp;
  readonly sourceSequence: number;
  readonly routes: readonly ImpactRouteAudit[];
}

export interface ImpactSummary {
  readonly taskId: TaskId;
  readonly status: TaskStatus;
  readonly summary: string;
  readonly updatedAt: IsoTimestamp;
  readonly sourceSequence: number;
}

export interface StoredImpactSummary extends ImpactSummary {
  readonly sourceFingerprint: string;
}

export interface ImpactSummarySnapshot {
  readonly apiVersion: typeof IMPACT_API_VERSION;
  readonly workspaceId: WorkspaceId;
  readonly generatedAt: IsoTimestamp;
  readonly sourceSequence: number;
  readonly summaries: readonly ImpactSummary[];
}

export interface ImpactObserverLimits {
  readonly maxTrackedTasks: number;
  readonly maxProgressEntriesPerTask: number;
  readonly maxSourceChars: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxSummaryChars: number;
}

export interface ImpactEventSource {
  bootstrap(signal?: AbortSignal): Promise<UiBootstrap>;
  stream(
    bootstrap: UiBootstrap,
    afterSequence: number,
    onEvent: (event: UiEventEnvelope) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ImpactObserverLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
