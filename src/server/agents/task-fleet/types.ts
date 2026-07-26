export type TaskFleetProvider = "codex" | "claude";

export interface TaskFleetAgentConfig {
  readonly workerId: string;
  readonly agentId: string;
  readonly token: string;
  readonly provider: TaskFleetProvider;
  readonly model: string;
  readonly workingDirectory: string;
  readonly statePath: string;
  readonly longPollMs: number;
  readonly agentTimeoutMs: number | undefined;
  readonly terminationGraceMs: number | undefined;
}

export interface TaskFleetRetryConfig {
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
}

export interface TaskFleetConfig {
  readonly version: 1;
  readonly boardUrl: string;
  readonly retry: TaskFleetRetryConfig;
  readonly agents: readonly TaskFleetAgentConfig[];
}

export type TaskFleetLaneStatus = "starting" | "running" | "retrying" | "stopped" | "closed";

export interface TaskFleetLaneSnapshot {
  readonly agentId: string;
  readonly workerId: string;
  readonly status: TaskFleetLaneStatus;
  readonly restartCount: number;
  readonly retryDelayMs: number | null;
  readonly lastError: string | null;
}

export interface TaskFleetSnapshot {
  readonly started: boolean;
  readonly stopping: boolean;
  readonly lanes: readonly TaskFleetLaneSnapshot[];
}

export interface ManagedTaskWorker {
  run(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export type TaskFleetWorkerFactory = (config: TaskFleetAgentConfig, boardUrl: string) => Promise<ManagedTaskWorker>;

export type TaskFleetEvent =
  | Readonly<{ type: "lane_started"; agentId: string; workerId: string }>
  | Readonly<{ type: "lane_retrying"; agentId: string; workerId: string; restartCount: number; delayMs: number; error: string }>
  | Readonly<{ type: "lane_stopped"; agentId: string; workerId: string; error: string }>
  | Readonly<{ type: "lane_closed"; agentId: string; workerId: string }>;

export type TaskFleetLogger = (event: TaskFleetEvent) => void;

export type TaskFleetSleeper = (delayMs: number, signal: AbortSignal) => Promise<void>;

export type TaskFleetTransientClassifier = (error: unknown) => boolean;
