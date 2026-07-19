import {
  STEWARD_UI_API_VERSION,
  parseAgentTaskProjection,
  parseUiBootstrap,
  parseUiEventEnvelope,
  type AgentTaskProjection,
  type ProgressEvent,
  type TaskStatus,
  type UiBootstrap,
  type UiEventEnvelope,
  type WorkspaceId,
} from "@cicada/steward-protocol";
import {
  createModelRouter,
  type ModelCatalog,
  type ModelProfile,
  type ModelProvider,
  type ModelRouter,
  type ModelTier,
} from "@cicada/steward-model-routing";
import type { ImpactObserverLimits, StoredImpactSummary } from "../src/types.js";
import type { ImpactSummaryPersistence } from "../src/observer.js";

export const WORKSPACE_ID = "workspace-impact-test" as WorkspaceId;

export const TEST_LIMITS: ImpactObserverLimits = Object.freeze({
  maxTrackedTasks: 3,
  maxProgressEntriesPerTask: 2,
  maxSourceChars: 240,
  maxInputTokens: 256,
  maxOutputTokens: 64,
  maxSummaryChars: 320,
});

function modelProfile(
  provider: ModelProvider,
  tier: ModelTier,
  contextWindowTokens: number,
): ModelProfile {
  return Object.freeze({
    provider,
    tier,
    modelId: `${provider}-${tier}-caller-configured-test-id`,
    contextWindowTokens,
    maximumOutputTokens: Math.min(1_024, contextWindowTokens),
    rateCard: Object.freeze({
      id: `${provider}-${tier}-caller-rates-v1`,
      currency: "TEST",
      inputPerMillionTokens: 0.125,
      outputPerMillionTokens: 0.5,
      effectiveAt: "2026-07-18T00:00:00.000Z",
    }),
  });
}

export function testModelCatalog(claudeEconomyContextWindowTokens = 8_192): ModelCatalog {
  const provider = (name: ModelProvider): ModelCatalog[ModelProvider] => Object.freeze({
    economy: modelProfile(name, "economy", name === "claude" ? claudeEconomyContextWindowTokens : 8_192),
    balanced: modelProfile(name, "balanced", 16_384),
    frontier: modelProfile(name, "frontier", 32_768),
  });
  return Object.freeze({
    codex: provider("codex"),
    claude: provider("claude"),
  });
}

export function testModelRouter(claudeEconomyContextWindowTokens = 8_192): ModelRouter {
  return createModelRouter(testModelCatalog(claudeEconomyContextWindowTokens));
}

export function task(taskId = "task-one", status: TaskStatus = "running"): AgentTaskProjection {
  return parseAgentTaskProjection({
    taskId,
    workspaceId: WORKSPACE_ID,
    agentId: "agent-one",
    laneId: "lane-one",
    title: "Make checkout clearer",
    objective: "Help people understand what happens next and finish their purchase with confidence.",
    status,
    expectedAgentMinutes: 15,
    expectedCompletedAt: "2026-07-18T20:15:00.000Z",
    startedAt: status === "queued" ? null : "2026-07-18T20:00:00.000Z",
    endedAt: status === "completed" || status === "failed" ? "2026-07-18T20:12:00.000Z" : null,
  });
}

export function bootstrap(options: {
  readonly sequence?: number;
  readonly tasks?: readonly AgentTaskProjection[];
  readonly progress?: readonly ProgressEvent[];
  readonly eventHref?: string;
} = {}): UiBootstrap {
  const sequence = options.sequence ?? 1;
  return parseUiBootstrap({
    apiVersion: STEWARD_UI_API_VERSION,
    sessionId: "session-impact",
    userId: "human-impact",
    permissions: ["workspace:read"],
    features: ["durable-replay"],
    snapshot: {
      apiVersion: STEWARD_UI_API_VERSION,
      workspaceId: WORKSPACE_ID,
      generatedAt: "2026-07-18T20:00:00.000Z",
      sequence,
      paused: false,
      controlVersion: 1,
      agents: [],
      tasks: options.tasks ?? [task()],
      progress: options.progress ?? [],
    },
    eventStream: {
      href: options.eventHref ?? "/v1/ui/events",
      afterSequence: sequence,
      retentionStartsAtSequence: sequence === 0 ? 0 : 1,
      heartbeatIntervalMs: 1_000,
    },
    commandEndpoint: "/v1/ui/commands",
  });
}

export function progressEvent(options: {
  readonly sequence?: number;
  readonly progress?: ProgressEvent;
  readonly projectedTask?: AgentTaskProjection;
} = {}): UiEventEnvelope {
  const sequence = options.sequence ?? 2;
  const projectedTask = options.projectedTask ?? task();
  const progress = options.progress ?? {
    taskId: projectedTask.taskId,
    phase: "test",
    iteration: 1,
    journal: "People can now finish checkout more reliably.",
    outcome: "passed",
    occurredAt: "2026-07-18T20:05:00.000Z",
  };
  return parseUiEventEnvelope({
    apiVersion: STEWARD_UI_API_VERSION,
    eventId: `ui-event-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sequence,
    occurredAt: progress.occurredAt,
    payload: { type: "progress_recorded", progress, task: projectedTask },
  });
}

export class MemoryPersistence implements ImpactSummaryPersistence {
  summaries: readonly StoredImpactSummary[] = [];
  writes = 0;

  async load(): Promise<readonly StoredImpactSummary[]> {
    return structuredClone(this.summaries);
  }

  async save(input: { readonly summaries: readonly StoredImpactSummary[] }): Promise<void> {
    this.summaries = structuredClone(input.summaries);
    this.writes += 1;
  }

  async flush(): Promise<void> {}
}
