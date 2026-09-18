/** Defines the lane configuration, lifecycle snapshots, events, and worker seams shared by fleet supervision and construction. */

import type { AgentRole } from "#shared/task-board-contract";

export type TaskFleetRuntime = string;

export type TaskFleetLaunchMode = "local-process" | "container";

export interface TaskFleetContainerLaneConfig {
  readonly workspaceRoot: string;
  readonly image: string | undefined;
  readonly agentCommand: string | undefined;
  readonly extraAllowedHosts: readonly string[];
}

export interface TaskFleetAgentConfig {
  readonly workerId: string;
  readonly agentId: string;
  readonly token: string;
  readonly runtime: TaskFleetRuntime;
  readonly role?: AgentRole;
  readonly model: string;
  /** For container lanes, workingDirectory is the repository path workspaces are cloned from. */
  readonly workingDirectory: string;
  /** Optional local-process workspace root; each pipeline work item receives a cloned task workspace. */
  readonly workspaceRoot?: string;
  readonly statePath: string;
  readonly longPollMs: number;
  readonly agentTimeoutMs: number | undefined;
  readonly terminationGraceMs: number | undefined;
  readonly launchMode: TaskFleetLaunchMode;
  readonly container: TaskFleetContainerLaneConfig | undefined;
}

export interface TaskFleetRetryConfig {
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
}

export interface TaskFleetConfig {
  readonly version: 1;
  readonly boardUrl: string;
  readonly runtimesConfigPath: string | undefined;
  readonly promptsFile: string | undefined;
  readonly retry: TaskFleetRetryConfig;
  readonly agents: readonly TaskFleetAgentConfig[];
}

export type TaskFleetLaneStatus = "starting" | "running" | "retrying" | "closed";

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
  /** Runs one long-poll/dispatch operation and reports whether it claimed a wake. */
  run(signal: AbortSignal): Promise<boolean>;
  hasActiveClaim(): boolean;
  quarantineActiveClaim(detail: string, signal?: AbortSignal): Promise<void>;
  dropActiveClaim(detail: string): Promise<void>;
  reportLaneError(detail: string | null, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export type TaskFleetWorkerFactory = (config: TaskFleetAgentConfig, boardUrl: string) => Promise<ManagedTaskWorker>;

export type TaskFleetEvent =
  | Readonly<{ type: "lane_started"; agentId: string; workerId: string }>
  | Readonly<{ type: "lane_credential_revoked"; agentId: string; workerId: string; error: string }>
  | Readonly<{
      type: "lane_retrying";
      agentId: string;
      workerId: string;
      restartCount: number;
      delayMs: number;
      error: string;
    }>
  | Readonly<{ type: "claim_quarantined"; agentId: string; workerId: string; error: string }>
  | Readonly<{
      type: "claim_quarantine_retrying";
      agentId: string;
      workerId: string;
      attempt: number;
      delayMs: number;
      error: string;
    }>
  | Readonly<{ type: "claim_dropped"; agentId: string; workerId: string; error: string; settleError: string }>
  | Readonly<{ type: "claim_drop_failed"; agentId: string; workerId: string; error: string }>
  | Readonly<{ type: "lane_error_report_failed"; agentId: string; workerId: string; error: string }>
  | Readonly<{ type: "lane_closed"; agentId: string; workerId: string }>;

export type TaskFleetLogger = (event: TaskFleetEvent) => void;

export type TaskFleetSleeper = (delayMs: number, signal: AbortSignal) => Promise<void>;

export type TaskFleetTransientClassifier = (error: unknown) => boolean;

export type TaskFleetErrorClassification = "TRANSIENT" | "CREDENTIAL_REVOKED" | "POISONED";

export type TaskFleetErrorClassifier = (error: unknown) => TaskFleetErrorClassification;
