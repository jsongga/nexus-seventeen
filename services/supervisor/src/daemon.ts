import {
  STEWARD_RUNTIME_API_VERSION,
  parseAgentTaskProjection,
  parseLeaseRenewalRequest,
  parseRuntimeCommandEnvelope,
  parseRuntimeCommandPollRequest,
  parseRuntimeEventBatch,
  parseSupervisorRegistrationRequest,
  type AgentTaskProjection,
  type CheckpointRef,
  type CurrentAction,
  type IsoTimestamp,
  type LeaseRenewalResult,
  type RuntimeCommandEnvelope,
  type RuntimeCommandPollRequest,
  type RuntimeEventBatch,
  type SupervisorRegistrationRequest,
  type SupervisorRegistrationResult,
  type TaskId,
} from "@cicada/steward-protocol";
import {
  CheckpointStore,
  EMPTY_INTERRUPT_CHECKPOINT,
  type InterruptCheckpoint,
  type SupervisorCheckpoint,
} from "./checkpoint.js";
import {
  type SupervisorControlPlaneClient,
} from "./client.js";
import type { SupervisorConfig } from "./config.js";
import { SerialExecutor } from "./fs-utils.js";
import { DurableOutbox, type OutboxIdentity } from "./outbox.js";
import { SupervisorProcessLocks } from "./process-lock.js";
import type { ProviderAdapter } from "./provider.js";
import { RpetRunner } from "./rpet.js";
import { RuntimeStateStore } from "./runtime-state.js";
import { RegistrationIntentStore } from "./registration-intent.js";

export type SupervisorDaemonState =
  | "starting"
  | "active"
  | "offline_hold"
  | "held"
  | "interrupting"
  | "paused"
  | "shutting_down"
  | "stopped";

export interface SupervisorDaemonOptions {
  config: SupervisorConfig;
  client: SupervisorControlPlaneClient;
  provider: ProviderAdapter;
  clock?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  loopIntervalMs?: number;
}

export interface SupervisorDaemonSnapshot {
  state: SupervisorDaemonState;
  runtimeEpoch: number;
  activeTask: AgentTaskProjection | null;
  queuedTasks: readonly AgentTaskProjection[];
  currentAction: CurrentAction | null;
  checkpoint: SupervisorCheckpoint | null;
  pendingOutboxEvents: number;
  lastServerSequence: number;
}

const DEFAULT_LOOP_INTERVAL_MS = 250;
const MAX_OUTBOX_BATCH = 100;
const MAX_ERROR_CHARS = 1_000;
const MAX_ACTIVE_STEP_WATCH_INTERVAL_MS = 1_000;

interface ActiveStepWatchResult {
  latestLease: LeaseRenewalResult | null;
  nextLeaseRenewalAt: number;
  failure: unknown | null;
}

interface RecoveredTaskCompletion {
  task: AgentTaskProjection;
  resultOverview: string;
}

class ActiveStepControlUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Control-plane watch failed during an active provider step", { cause });
    this.name = "ActiveStepControlUnavailableError";
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/gi, "[redacted]");
  return redacted.slice(0, MAX_ERROR_CHARS);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDelayOrAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve();
    };
    const onAbort = () => finish();
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function leaseRenewalDeadline(
  lease: Pick<SupervisorRegistrationResult, "leaseGrantedAt" | "leaseExpiresAt">,
  nowMs: number,
  configuredIntervalMs: number,
): number {
  const grantedAt = Date.parse(lease.leaseGrantedAt);
  const expiresAt = Date.parse(lease.leaseExpiresAt);
  const ttlMs = expiresAt - grantedAt;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Control plane returned an invalid lease lifetime");
  }
  const halfTtlMs = Math.max(250, Math.floor(ttlMs / 2));
  return nowMs + Math.min(configuredIntervalMs, halfTtlMs);
}

function assertIdentityMatch(
  expected: Pick<SupervisorRegistrationRequest, "workspaceId" | "agentId" | "laneId" | "runtimeInstanceId">,
  actual: Pick<SupervisorRegistrationResult, "workspaceId" | "agentId" | "laneId" | "runtimeInstanceId" | "runtimeEpoch">,
  runtimeEpoch?: number,
): void {
  if (
    actual.workspaceId !== expected.workspaceId ||
    actual.agentId !== expected.agentId ||
    actual.laneId !== expected.laneId ||
    actual.runtimeInstanceId !== expected.runtimeInstanceId ||
    (runtimeEpoch !== undefined && actual.runtimeEpoch !== runtimeEpoch)
  ) {
    throw new Error("Control-plane response does not match this supervisor identity and epoch");
  }
}

function assertIssuedRegistrationEpoch(
  request: SupervisorRegistrationRequest,
  result: SupervisorRegistrationResult,
): void {
  assertIdentityMatch(request, result);
  const expectedIssuedEpoch = request.expectedRuntimeEpoch === null
    ? 1
    : request.expectedRuntimeEpoch + 1;
  if (!Number.isSafeInteger(expectedIssuedEpoch) || result.runtimeEpoch !== expectedIssuedEpoch) {
    throw new Error("Control plane did not issue the contiguous fencing epoch requested by CAS");
  }
}

export class SupervisorDaemon {
  readonly #config: SupervisorConfig;
  readonly #client: SupervisorControlPlaneClient;
  readonly #provider: ProviderAdapter;
  readonly #clock: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #loopIntervalMs: number;
  readonly #serial = new SerialExecutor();
  readonly #checkpointStore: CheckpointStore;
  readonly #runtimeStateStore: RuntimeStateStore;
  readonly #registrationIntentStore: RegistrationIntentStore;
  #processLocks: SupervisorProcessLocks | null = null;
  #outbox!: DurableOutbox;
  #registrationRequest!: SupervisorRegistrationRequest;
  #runtimeEpoch = 0;
  #state: SupervisorDaemonState = "starting";
  #desiredState: "active" | "held" | "paused" = "active";
  #lease: SupervisorRegistrationResult | LeaseRenewalResult | null = null;
  #nextLeaseRenewalAt = 0;
  #queue: AgentTaskProjection[] = [];
  #activeTask: AgentTaskProjection | null = null;
  #runner: RpetRunner | null = null;
  #currentAction: CurrentAction | null = null;
  #interrupt: InterruptCheckpoint = { ...EMPTY_INTERRUPT_CHECKPOINT };
  #activeStepController: AbortController | null = null;
  #interruptAbortRequested = false;
  #holdAbortRequested = false;
  #shutdownAbortRequested = false;
  #recoveredTaskCompletion: RecoveredTaskCompletion | null = null;
  #initialized = false;

  private constructor(options: SupervisorDaemonOptions) {
    this.#config = options.config;
    this.#client = options.client;
    this.#provider = options.provider;
    this.#clock = options.clock ?? (() => new Date());
    this.#sleep = options.sleep ?? defaultSleep;
    this.#loopIntervalMs = options.loopIntervalMs ?? DEFAULT_LOOP_INTERVAL_MS;
    if (!Number.isInteger(this.#loopIntervalMs) || this.#loopIntervalMs < 10 || this.#loopIntervalMs > 60_000) {
      throw new Error("loopIntervalMs must be an integer between 10 and 60000");
    }
    this.#checkpointStore = new CheckpointStore(this.#config.stateDirectory);
    this.#runtimeStateStore = new RuntimeStateStore(this.#config.stateDirectory);
    this.#registrationIntentStore = new RegistrationIntentStore(this.#config.stateDirectory);
  }

  static async create(options: SupervisorDaemonOptions): Promise<SupervisorDaemon> {
    const daemon = new SupervisorDaemon(options);
    try {
      await daemon.#initialize();
      return daemon;
    } catch (error) {
      try {
        await daemon.#releaseProcessLocks();
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], "Supervisor initialization and lock release failed");
      }
      throw error;
    }
  }

  get snapshot(): SupervisorDaemonSnapshot {
    return {
      state: this.#state,
      runtimeEpoch: this.#runtimeEpoch,
      activeTask: this.#activeTask ? structuredClone(this.#activeTask) : null,
      queuedTasks: this.#queue.map((task) => structuredClone(task)),
      currentAction: this.#currentAction ? structuredClone(this.#currentAction) : null,
      checkpoint: this.#checkpointStore.current,
      pendingOutboxEvents: this.#outbox.pendingCount,
      lastServerSequence: this.#runtimeStateStore.lastServerSequence,
    };
  }

  tick(): Promise<void> {
    return this.#serial.run(() => this.#tickInternal());
  }

  handleCommand(command: RuntimeCommandEnvelope): Promise<void> {
    const parsed = parseRuntimeCommandEnvelope(command);
    if (
      !this.#initialized ||
      !this.#lease ||
      this.#state === "shutting_down" ||
      this.#state === "stopped"
    ) {
      return Promise.reject(new Error("Supervisor is not accepting commands"));
    }
    if (
      (parsed.payload.type === "request_interrupt" || parsed.payload.type === "hold") &&
      parsed.workspaceId === this.#registrationRequest.workspaceId &&
      parsed.agentId === this.#registrationRequest.agentId &&
      parsed.laneId === this.#registrationRequest.laneId &&
      parsed.expectedRuntimeEpoch === this.#runtimeEpoch &&
      parsed.serverSequence > this.#runtimeStateStore.lastServerSequence &&
      this.#activeStepController &&
      !this.#activeStepController.signal.aborted
    ) {
      if (parsed.payload.type === "request_interrupt") {
        this.#interruptAbortRequested = true;
        this.#state = "interrupting";
      } else {
        this.#holdAbortRequested = true;
        this.#state = "held";
      }
      this.#activeStepController.abort();
    }
    return this.#serial.run(() => this.#handleCommand(parsed));
  }

  async run(signal?: AbortSignal): Promise<void> {
    const requestShutdown = () => {
      this.#shutdownAbortRequested = true;
      this.#activeStepController?.abort();
    };
    signal?.addEventListener("abort", requestShutdown, { once: true });
    try {
      while (!signal?.aborted && this.#state !== "stopped" && this.#state !== "shutting_down") {
        await this.tick();
        await this.#sleep(this.#loopIntervalMs);
      }
    } finally {
      signal?.removeEventListener("abort", requestShutdown);
      await this.shutdown();
    }
  }

  shutdown(): Promise<void> {
    this.#shutdownAbortRequested = true;
    this.#activeStepController?.abort();
    return this.#serial.run(async () => {
      if (this.#state === "stopped") return;
      this.#state = "shutting_down";
      const failures: unknown[] = [];
      try {
        await this.#writeCheckpoint(null);
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.#provider.shutdown();
      } catch (error) {
        failures.push(error);
      }
      if (this.#lease && this.#outbox.pendingCount > 0) {
        await this.#flushOutboxToServer().catch(() => undefined);
      }
      const flushes = await Promise.allSettled([
        this.#outbox.flush(),
        this.#checkpointStore.flush(),
        this.#runtimeStateStore.flush(),
      ]);
      for (const flush of flushes) {
        if (flush.status === "rejected") failures.push(flush.reason);
      }
      try {
        await this.#releaseProcessLocks();
      } catch (error) {
        failures.push(error);
      } finally {
        this.#state = "stopped";
      }
      if (failures.length > 0) throw new AggregateError(failures, "Supervisor shutdown did not complete cleanly");
    });
  }

  async #initialize(): Promise<void> {
    this.#processLocks = await SupervisorProcessLocks.acquire(
      this.#config.stateDirectory,
      this.#config.workingDirectory,
    );
    await this.#runtimeStateStore.load();
    const previousCheckpoint = await this.#checkpointStore.load();
    const observedRuntimeEpoch = this.#runtimeStateStore.runtimeEpoch;
    if (previousCheckpoint && observedRuntimeEpoch > 0 && previousCheckpoint.runtimeEpoch > observedRuntimeEpoch) {
      throw new Error("Checkpoint claims a runtime epoch that was never durably observed from the control plane");
    }
    // Epoch 1 is only a local, non-transmitted bootstrap value needed to open
    // an empty outbox. The registration CAS below sends null until the server
    // issues the authoritative first epoch.
    this.#runtimeEpoch = observedRuntimeEpoch || 1;
    this.#interrupt = previousCheckpoint?.interrupt
      ? structuredClone(previousCheckpoint.interrupt)
      : { ...EMPTY_INTERRUPT_CHECKPOINT };
    this.#desiredState =
      previousCheckpoint?.desiredState ??
      (this.#interrupt.state === "none" ? "active" : "paused");
    this.#state = "starting";

    const checkpointRef = previousCheckpoint?.checkpointRef ?? null;
    const pendingRegistration = await this.#registrationIntentStore.load(
      this.#config,
      observedRuntimeEpoch,
      checkpointRef,
    );
    this.#registrationRequest = pendingRegistration ?? parseSupervisorRegistrationRequest({
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        workspaceId: this.#config.workspaceId,
        agentId: this.#config.agentId,
        laneId: this.#config.laneId,
        runtimeInstanceId: this.#config.runtimeInstanceId,
        expectedRuntimeEpoch: observedRuntimeEpoch || null,
        displayName: this.#config.displayName,
        role: this.#config.role,
        capabilities: this.#config.capabilities,
        provider: this.#config.provider,
        softwareVersion: this.#config.softwareVersion,
        checkpointRef,
      });
    if (!pendingRegistration) {
      await this.#registrationIntentStore.write(this.#registrationRequest);
    }
    const identity: OutboxIdentity = {
      apiVersion: this.#registrationRequest.apiVersion,
      workspaceId: this.#registrationRequest.workspaceId,
      agentId: this.#registrationRequest.agentId,
      laneId: this.#registrationRequest.laneId,
      runtimeInstanceId: this.#registrationRequest.runtimeInstanceId,
    };
    this.#outbox = await DurableOutbox.open({
      stateDirectory: this.#config.stateDirectory,
      identity,
      runtimeEpoch: this.#runtimeEpoch,
    });
    if (previousCheckpoint) {
      this.#restoreCheckpointedWork(previousCheckpoint);
      await this.#recoverRpetCommitGap();
    }
    this.#initialized = true;
  }

  async #tickInternal(): Promise<void> {
    if (!this.#initialized || this.#state === "stopped" || this.#state === "shutting_down") return;
    if (!this.#lease) {
      const reconciled = await this.#reconcile();
      if (!reconciled) return;
    }

    try {
      await this.#renewLeaseIfDue();
      await this.#flushOutboxToServer();
      await this.#pollAndApplyCommands();
    } catch {
      await this.#enterOfflineHold();
      return;
    }

    if (this.#state !== "active") return;
    this.#activateNextTask();
    if (!this.#runner || !this.#activeTask) return;

    try {
      await this.#performAtomicRpetStep();
    } catch (error) {
      if (error instanceof ActiveStepControlUnavailableError) {
        await this.#enterOfflineHold();
        return;
      }
      if (this.#shutdownAbortRequested) {
        await this.#writeCheckpoint(null);
        return;
      }
      if (this.#interruptAbortRequested) {
        await this.#writeCheckpoint(null);
        return;
      }
      if (this.#holdAbortRequested) {
        await this.#writeCheckpoint(null);
        return;
      }
      if (this.#activeTask) {
        const checkpoint = await this.#writeCheckpoint(errorMessage(error));
        await this.#outbox.append({
          type: "task_failed",
          taskId: this.#activeTask.taskId,
          error: errorMessage(error),
          retryable: false,
          checkpointRef: checkpoint?.checkpointRef ?? null,
        }, this.#clock());
        await this.#writeCheckpoint(errorMessage(error));
      }
      this.#desiredState = "held";
      this.#state = "held";
      return;
    }

    try {
      await this.#flushOutboxToServer();
    } catch {
      await this.#enterOfflineHold();
    }
  }

  async #reconcile(): Promise<boolean> {
    try {
      const result = await this.#client.register(this.#registrationRequest);
      assertIssuedRegistrationEpoch(this.#registrationRequest, result);
      this.#runtimeEpoch = result.runtimeEpoch;
      await this.#runtimeStateStore.recordRuntimeEpoch(result.runtimeEpoch);
      // Registration reconciles a possible lost acknowledgement first. Only the
      // remaining unsent suffix may be rebased without changing an eventId the
      // server might already have stored under an older fencing epoch.
      await this.#outbox.acknowledge(result.lastAcceptedLocalSequence);
      await this.#outbox.rebindPendingToRuntime(result.runtimeEpoch);
      await this.#finalizeRecoveredTaskCompletion();
      await this.#registrationIntentStore.clear(this.#registrationRequest);
      this.#lease = result;
      this.#nextLeaseRenewalAt = leaseRenewalDeadline(
        result,
        this.#clock().getTime(),
        this.#config.leaseIntervalMs,
      );
      this.#state = this.#desiredState;
      await this.#pollAndApplyCommands();
      return true;
    } catch {
      await this.#enterOfflineHold();
      return false;
    }
  }

  async #renewLeaseIfDue(): Promise<void> {
    if (!this.#lease || this.#clock().getTime() < this.#nextLeaseRenewalAt) return;
    const request = parseLeaseRenewalRequest({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: this.#registrationRequest.workspaceId,
      agentId: this.#registrationRequest.agentId,
      laneId: this.#registrationRequest.laneId,
      runtimeInstanceId: this.#registrationRequest.runtimeInstanceId,
      runtimeEpoch: this.#runtimeEpoch,
      leaseId: this.#lease.leaseId,
      lastDurableEventSequence: this.#outbox.acknowledgedThrough,
      sentAt: this.#clock().toISOString(),
    });
    const result = await this.#client.renewLease(request);
    assertIdentityMatch(this.#registrationRequest, result, this.#runtimeEpoch);
    if (result.leaseId !== this.#lease.leaseId) throw new Error("Lease renewal returned a different lease ID");
    await this.#outbox.acknowledge(result.acceptedThroughLocalSequence);
    this.#lease = result;
    this.#nextLeaseRenewalAt = leaseRenewalDeadline(
      result,
      this.#clock().getTime(),
      this.#config.leaseIntervalMs,
    );
  }

  async #flushOutboxToServer(): Promise<void> {
    const events = this.#outbox.pending(MAX_OUTBOX_BATCH);
    if (events.length === 0) return;
    const batch: RuntimeEventBatch = parseRuntimeEventBatch({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: this.#registrationRequest.workspaceId,
      agentId: this.#registrationRequest.agentId,
      laneId: this.#registrationRequest.laneId,
      runtimeInstanceId: this.#registrationRequest.runtimeInstanceId,
      runtimeEpoch: this.#runtimeEpoch,
      events,
    });
    const receipt = await this.#client.uploadEvents(batch);
    assertIdentityMatch(this.#registrationRequest, receipt, this.#runtimeEpoch);
    await this.#outbox.acknowledge(receipt.acceptedThroughLocalSequence);
  }

  async #pollAndApplyCommands(): Promise<void> {
    const request: RuntimeCommandPollRequest = parseRuntimeCommandPollRequest({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: this.#registrationRequest.workspaceId,
      agentId: this.#registrationRequest.agentId,
      laneId: this.#registrationRequest.laneId,
      runtimeInstanceId: this.#registrationRequest.runtimeInstanceId,
      runtimeEpoch: this.#runtimeEpoch,
      afterServerSequence: this.#runtimeStateStore.lastServerSequence,
    });
    const result = await this.#client.pollCommands(request);
    assertIdentityMatch(this.#registrationRequest, result, this.#runtimeEpoch);
    const commands = [...result.commands].sort((left, right) => left.serverSequence - right.serverSequence);
    for (const command of commands) await this.#handleCommand(command);
    await this.#runtimeStateStore.recordServerSequence(result.latestServerSequence);
  }

  async #handleCommand(rawCommand: RuntimeCommandEnvelope): Promise<void> {
    const command = parseRuntimeCommandEnvelope(rawCommand);
    if (
      command.workspaceId !== this.#registrationRequest.workspaceId ||
      command.agentId !== this.#registrationRequest.agentId ||
      command.laneId !== this.#registrationRequest.laneId
    ) {
      throw new Error("Runtime command identity does not match this supervisor");
    }
    if (command.serverSequence <= this.#runtimeStateStore.lastServerSequence) return;
    if (command.expectedRuntimeEpoch < this.#runtimeEpoch) {
      if (command.payload.type === "request_interrupt") {
        const alreadyRefused = this.#outbox.pendingTail(1_000).some(
          (event) =>
            event.payload.type === "interrupt_refused" &&
            event.payload.commandId === command.commandId,
        );
        if (!alreadyRefused) {
          await this.#outbox.append({
            type: "interrupt_refused",
            commandId: command.commandId,
            reason: `Stale runtime epoch ${command.expectedRuntimeEpoch}; current epoch is ${this.#runtimeEpoch}`,
          }, this.#clock());
        }
      }
      await this.#runtimeStateStore.recordServerSequence(command.serverSequence);
      return;
    }
    if (command.expectedRuntimeEpoch > this.#runtimeEpoch) {
      await this.#enterOfflineHold();
      throw new Error("Runtime command is fenced to a newer supervisor epoch");
    }

    switch (command.payload.type) {
      case "assign_task":
        if (this.#config.role !== "engineer") {
          await this.#rejectRpetTaskForRole(command.payload.task);
        } else if (this.#queueTask(command.payload.task)) {
          await this.#writeCheckpoint(null);
        }
        break;
      case "request_interrupt":
        await this.#settleInterrupt(command, command.payload.reason);
        break;
      case "resume":
        await this.#resume(command.payload.taskId, command.payload.checkpointRef);
        break;
      case "hold":
        await this.#settleHold(command);
        break;
    }
    await this.#runtimeStateStore.recordServerSequence(command.serverSequence);
  }

  #queueTask(taskValue: AgentTaskProjection): boolean {
    const task = parseAgentTaskProjection(taskValue);
    if (this.#activeTask?.taskId === task.taskId || this.#queue.some((entry) => entry.taskId === task.taskId)) return false;
    this.#queue.push(task);
    return true;
  }

  async #rejectRpetTaskForRole(taskValue: AgentTaskProjection): Promise<void> {
    const task = parseAgentTaskProjection(taskValue);
    this.#desiredState = "held";
    this.#state = "held";
    const checkpoint = await this.#writeCheckpoint(null);
    await this.#outbox.append({
      type: "task_failed",
      taskId: task.taskId,
      error: `Role policy denied ${this.#config.role}: only engineers may enter the modifying RPET workflow`,
      retryable: false,
      checkpointRef: checkpoint?.checkpointRef ?? null,
    }, this.#clock());
    await this.#writeCheckpoint(null);
  }

  #activateNextTask(): void {
    if (this.#activeTask || this.#runner) return;
    const task = this.#queue.shift();
    if (!task) return;
    this.#activeTask = task;
    const checkpoint = this.#checkpointStore.current;
    if (checkpoint && checkpoint.taskId === task.taskId && checkpoint.phase !== null && checkpoint.iteration > 0) {
      this.#runner = new RpetRunner(task, {
        role: this.#config.role,
        initialIteration: checkpoint.iteration,
        initialPhase: checkpoint.phase,
        clock: this.#clock,
      });
    } else {
      this.#runner = new RpetRunner(task, { role: this.#config.role, clock: this.#clock });
    }
    this.#currentAction = null;
  }

  async #performAtomicRpetStep(): Promise<void> {
    const runner = this.#runner;
    const task = this.#activeTask;
    if (!runner || !task) return;
    await this.#writeCheckpoint(null);
    const controller = new AbortController();
    const stopWatch = new AbortController();
    this.#activeStepController = controller;
    const watch = this.#watchActiveStep(controller, stopWatch.signal);
    let result: Awaited<ReturnType<RpetRunner["step"]>> | null = null;
    let stepFailure: unknown | null = null;
    try {
      result = await runner.step(this.#provider, controller.signal, async (action) => {
        this.#currentAction = action;
        let checkpoint = await this.#writeCheckpoint(null);
        await this.#outbox.append({
          type: "heartbeat",
          currentAction: action,
          checkpointRef: checkpoint?.checkpointRef ?? null,
        }, this.#clock());
        checkpoint = await this.#writeCheckpoint(null);
        void checkpoint;
      });
    } catch (error) {
      stepFailure = error;
    } finally {
      if (this.#activeStepController === controller) this.#activeStepController = null;
      stopWatch.abort();
    }
    const watchResult = await watch;
    if (watchResult.latestLease) {
      try {
        await this.#outbox.acknowledge(watchResult.latestLease.acceptedThroughLocalSequence);
      } catch (error) {
        throw new ActiveStepControlUnavailableError(error);
      }
      this.#lease = watchResult.latestLease;
      this.#nextLeaseRenewalAt = watchResult.nextLeaseRenewalAt;
    }
    if (watchResult.failure) throw new ActiveStepControlUnavailableError(watchResult.failure);
    if (stepFailure) throw stepFailure;
    if (!result) throw new Error("Provider step ended without a result");
    await this.#outbox.append(result.progress, this.#clock());
    const checkpoint = await this.#writeCheckpoint(result.resultOverview);
    if (!result.completed) return;

    await this.#outbox.append({
      type: "task_completed",
      taskId: task.taskId,
      result: result.resultOverview!,
      checkpointRef: checkpoint?.checkpointRef ?? null,
    }, this.#clock());
    this.#currentAction = null;
    this.#activeTask = null;
    this.#runner = null;
    await this.#writeCheckpoint(result.resultOverview);
  }

  async #watchActiveStep(
    stepController: AbortController,
    stopSignal: AbortSignal,
  ): Promise<ActiveStepWatchResult> {
    let lease = this.#lease;
    let nextLeaseRenewalAt = this.#nextLeaseRenewalAt;
    let afterServerSequence = this.#runtimeStateStore.lastServerSequence;
    const watchIntervalMs = Math.min(this.#loopIntervalMs, MAX_ACTIVE_STEP_WATCH_INTERVAL_MS);
    const result: ActiveStepWatchResult = {
      latestLease: null,
      nextLeaseRenewalAt,
      failure: null,
    };

    while (!stopSignal.aborted && !stepController.signal.aborted) {
      try {
        const request = parseRuntimeCommandPollRequest({
          apiVersion: STEWARD_RUNTIME_API_VERSION,
          workspaceId: this.#registrationRequest.workspaceId,
          agentId: this.#registrationRequest.agentId,
          laneId: this.#registrationRequest.laneId,
          runtimeInstanceId: this.#registrationRequest.runtimeInstanceId,
          runtimeEpoch: this.#runtimeEpoch,
          afterServerSequence,
        });
        const polled = await this.#client.pollCommands(request, stopSignal);
        assertIdentityMatch(this.#registrationRequest, polled, this.#runtimeEpoch);
        if (stopSignal.aborted || stepController.signal.aborted) break;
        const commands = [...polled.commands].sort(
          (left, right) => left.serverSequence - right.serverSequence,
        );
        for (const command of commands) {
          if (command.serverSequence <= afterServerSequence) continue;
          afterServerSequence = command.serverSequence;
          this.#scheduleWatchedCommand(command);
          if (stepController.signal.aborted) break;
        }
        afterServerSequence = Math.max(afterServerSequence, polled.latestServerSequence);
        if (stopSignal.aborted || stepController.signal.aborted) break;

        if (lease && this.#clock().getTime() >= nextLeaseRenewalAt) {
          const renewal = parseLeaseRenewalRequest({
            apiVersion: STEWARD_RUNTIME_API_VERSION,
            workspaceId: this.#registrationRequest.workspaceId,
            agentId: this.#registrationRequest.agentId,
            laneId: this.#registrationRequest.laneId,
            runtimeInstanceId: this.#registrationRequest.runtimeInstanceId,
            runtimeEpoch: this.#runtimeEpoch,
            leaseId: lease.leaseId,
            lastDurableEventSequence: this.#outbox.acknowledgedThrough,
            sentAt: this.#clock().toISOString(),
          });
          const renewed = await this.#client.renewLease(renewal, stopSignal);
          assertIdentityMatch(this.#registrationRequest, renewed, this.#runtimeEpoch);
          if (renewed.leaseId !== lease.leaseId) {
            throw new Error("Lease renewal returned a different lease ID");
          }
          lease = renewed;
          nextLeaseRenewalAt = leaseRenewalDeadline(
            renewed,
            this.#clock().getTime(),
            this.#config.leaseIntervalMs,
          );
          result.latestLease = renewed;
          result.nextLeaseRenewalAt = nextLeaseRenewalAt;
        }
      } catch (error) {
        if (stopSignal.aborted || stepController.signal.aborted) break;
        result.failure = error;
        stepController.abort();
        break;
      }
      await waitForDelayOrAbort(watchIntervalMs, stopSignal);
    }
    return result;
  }

  #scheduleWatchedCommand(command: RuntimeCommandEnvelope): void {
    // handleCommand's interrupt fast path is intentionally synchronous: it may
    // abort the provider controller while this tick owns the serial executor.
    // The returned durable command application must not be awaited here, or the
    // watcher and active step would deadlock waiting on each other.
    void this.handleCommand(command).catch(() => {
      void this.#serial.run(async () => {
        if (this.#state !== "stopped" && this.#state !== "shutting_down") {
          await this.#enterOfflineHold();
        }
      }).catch(() => undefined);
    });
  }

  async #settleInterrupt(command: RuntimeCommandEnvelope, reason: string): Promise<void> {
    const now = this.#clock().toISOString() as IsoTimestamp;
    const announcedTaskId = this.#currentAction?.taskId ?? null;
    const previousInterrupt = this.#interrupt;
    const sameCommand = previousInterrupt.commandId === command.commandId;
    const lifecycle = this.#outbox.pendingTail(1_000).filter(
      (event) =>
        (event.payload.type === "interrupt_acknowledged" || event.payload.type === "interrupt_settled") &&
        event.payload.commandId === command.commandId,
    );
    const alreadyAcknowledged = lifecycle.some(
      (event) => event.payload.type === "interrupt_acknowledged",
    );
    const alreadySettled =
      (sameCommand && previousInterrupt.state === "settled") ||
      lifecycle.some((event) => event.payload.type === "interrupt_settled");
    this.#state = "interrupting";
    this.#interrupt = {
      state: "requested",
      commandId: command.commandId,
      reason,
      requestedAt: sameCommand ? previousInterrupt.requestedAt ?? now : now,
      acknowledgedAt: null,
      settledAt: null,
    };
    let checkpoint = await this.#writeCheckpoint(null);
    if (!alreadyAcknowledged && !alreadySettled) {
      await this.#outbox.append({
        type: "interrupt_acknowledged",
        commandId: command.commandId,
        taskId: announcedTaskId,
      }, this.#clock());
    }
    this.#interrupt = {
      ...this.#interrupt,
      state: "acknowledged",
      acknowledgedAt: sameCommand
        ? previousInterrupt.acknowledgedAt ?? this.#clock().toISOString() as IsoTimestamp
        : this.#clock().toISOString() as IsoTimestamp,
    };
    checkpoint = await this.#writeCheckpoint(null);
    if (!alreadySettled) {
      await this.#provider.settleInterrupt({ task: this.#activeTask, reason });
      await this.#outbox.append({
        type: "interrupt_settled",
        commandId: command.commandId,
        taskId: announcedTaskId,
        checkpointRef: checkpoint?.checkpointRef ?? null,
      }, this.#clock());
    }
    this.#interrupt = {
      ...this.#interrupt,
      state: "settled",
      settledAt: sameCommand
        ? previousInterrupt.settledAt ?? this.#clock().toISOString() as IsoTimestamp
        : this.#clock().toISOString() as IsoTimestamp,
    };
    await this.#writeCheckpoint(null);
    this.#interruptAbortRequested = false;
    this.#desiredState = "paused";
    this.#state = "paused";
  }

  async #settleHold(command: RuntimeCommandEnvelope): Promise<void> {
    const taskId = this.#currentAction?.taskId ?? null;
    const lifecycle = this.#outbox.pendingTail(1_000).filter(
      (event) =>
        (event.payload.type === "hold_acknowledged" || event.payload.type === "hold_settled") &&
        event.payload.commandId === command.commandId,
    );
    const alreadyAcknowledged = lifecycle.some((event) => event.payload.type === "hold_acknowledged");
    const alreadySettled = lifecycle.some((event) => event.payload.type === "hold_settled");

    this.#desiredState = "held";
    this.#state = "held";
    if (!alreadyAcknowledged && !alreadySettled) {
      await this.#outbox.append({
        type: "hold_acknowledged",
        commandId: command.commandId,
        taskId,
      }, this.#clock());
    }
    const checkpoint = await this.#writeCheckpoint(null);
    if (!alreadySettled) {
      await this.#outbox.append({
        type: "hold_settled",
        commandId: command.commandId,
        taskId,
        checkpointRef: checkpoint?.checkpointRef ?? null,
      }, this.#clock());
    }
    this.#holdAbortRequested = false;
    await this.#writeCheckpoint(null);
  }

  async #resume(taskId: TaskId | null, checkpointRef: CheckpointRef | null): Promise<void> {
    const checkpoint = this.#checkpointStore.current;
    if (checkpointRef && checkpoint?.checkpointRef !== checkpointRef) {
      this.#state = "held";
      this.#desiredState = "held";
      return;
    }
    if (taskId && this.#activeTask?.taskId !== taskId) {
      if (this.#activeTask) {
        this.#state = "held";
        this.#desiredState = "held";
        return;
      }
      const index = this.#queue.findIndex((task) => task.taskId === taskId);
      if (index < 0) {
        this.#state = "held";
        this.#desiredState = "held";
        return;
      }
      const [task] = this.#queue.splice(index, 1);
      if (task) this.#queue.unshift(task);
      this.#activateNextTask();
    }
    this.#interrupt = { ...EMPTY_INTERRUPT_CHECKPOINT };
    this.#desiredState = "active";
    this.#state = "active";
    this.#holdAbortRequested = false;
    await this.#writeCheckpoint(null);
  }

  async #enterOfflineHold(): Promise<void> {
    this.#lease = null;
    this.#state = "offline_hold";
    await this.#writeCheckpoint(null);
  }

  async #writeCheckpoint(resultOverview: string | null): Promise<SupervisorCheckpoint | null> {
    const previous = this.#checkpointStore.current;
    if (
      !this.#activeTask &&
      this.#queue.length === 0 &&
      !previous &&
      this.#interrupt.state === "none" &&
      this.#desiredState === "active"
    ) {
      return null;
    }
    const runnerState = this.#runner?.state;
    const task = this.#activeTask;
    return this.#checkpointStore.write({
      ...(previous?.checkpointRef ? { checkpointRef: previous.checkpointRef } : {}),
      runtimeEpoch: this.#runtimeEpoch,
      desiredState: this.#desiredState,
      taskId: task?.taskId ?? previous?.taskId ?? null,
      activeTask: task ? structuredClone(task) : null,
      queuedTasks: this.#queue.map((queuedTask) => structuredClone(queuedTask)),
      iteration: runnerState?.iteration ?? previous?.iteration ?? 0,
      phase: runnerState?.phase ?? previous?.phase ?? null,
      currentAction: this.#currentAction,
      timing: task
        ? {
            expectedAgentMinutes: task.expectedAgentMinutes,
            expectedCompletedAt: task.expectedCompletedAt,
            startedAt: task.startedAt,
          }
        : previous?.timing ?? null,
      resultOverview: resultOverview ?? previous?.resultOverview ?? null,
      lastLocalSequence: this.#outbox.lastSequence,
      interrupt: this.#interrupt,
    });
  }

  #restoreCheckpointedWork(checkpoint: SupervisorCheckpoint): void {
    this.#desiredState = checkpoint.desiredState;
    const tasks = [checkpoint.activeTask, ...checkpoint.queuedTasks].filter(
      (task): task is AgentTaskProjection => task !== null,
    );
    for (const task of tasks) {
      if (
        task.workspaceId !== this.#registrationRequest.workspaceId ||
        task.agentId !== this.#registrationRequest.agentId ||
        task.laneId !== this.#registrationRequest.laneId
      ) {
        throw new Error("Checkpointed task identity does not match this supervisor");
      }
    }
    this.#queue = checkpoint.queuedTasks.map((task) => structuredClone(task));
    this.#activeTask = checkpoint.activeTask ? structuredClone(checkpoint.activeTask) : null;
    this.#currentAction = checkpoint.currentAction ? structuredClone(checkpoint.currentAction) : null;
    if (!this.#activeTask) return;
    if (checkpoint.phase !== null && checkpoint.iteration > 0) {
      this.#runner = new RpetRunner(this.#activeTask, {
        role: this.#config.role,
        initialIteration: checkpoint.iteration,
        initialPhase: checkpoint.phase,
        clock: this.#clock,
      });
    } else {
      this.#runner = new RpetRunner(this.#activeTask, { role: this.#config.role, clock: this.#clock });
    }
  }

  async #releaseProcessLocks(): Promise<void> {
    const locks = this.#processLocks;
    if (!locks) return;
    await locks.release();
    this.#processLocks = null;
  }

  async #recoverRpetCommitGap(): Promise<void> {
    const task = this.#activeTask;
    const runner = this.#runner;
    if (!task || !runner) return;
    const events = this.#outbox.pendingTail(1_000);
    const completed = [...events].reverse().find(
      (event) => event.payload.type === "task_completed" && event.payload.taskId === task.taskId,
    );
    if (completed?.payload.type === "task_completed") {
      this.#currentAction = null;
      this.#activeTask = null;
      this.#runner = null;
      await this.#writeCheckpoint(completed.payload.result);
      return;
    }

    const progressEvent = [...events].reverse().find(
      (event) => event.payload.type === "progress" && event.payload.taskId === task.taskId,
    );
    if (!progressEvent || progressEvent.payload.type !== "progress") return;
    const progress = progressEvent.payload;
    const current = runner.state;
    if (progress.iteration !== current.iteration || progress.phase !== current.phase) return;

    this.#currentAction = null;
    if (progress.phase === "test" && progress.outcome === "passed") {
      this.#recoveredTaskCompletion = {
        task: structuredClone(task),
        resultOverview:
          this.#checkpointStore.current?.resultOverview ??
          `Completed ${task.title} with passing checks.`,
      };
      return;
    }

    const next = progress.phase === "research"
      ? { iteration: progress.iteration, phase: "plan" as const }
      : progress.phase === "plan"
        ? { iteration: progress.iteration, phase: "execute" as const }
        : progress.phase === "execute"
          ? { iteration: progress.iteration, phase: "test" as const }
          : { iteration: progress.iteration + 1, phase: "research" as const };
    this.#runner = new RpetRunner(task, {
      role: this.#config.role,
      initialIteration: next.iteration,
      initialPhase: next.phase,
      clock: this.#clock,
    });
    await this.#writeCheckpoint(null);
  }

  async #finalizeRecoveredTaskCompletion(): Promise<void> {
    const recovered = this.#recoveredTaskCompletion;
    if (!recovered) return;
    const checkpoint = await this.#writeCheckpoint(recovered.resultOverview);
    await this.#outbox.append({
      type: "task_completed",
      taskId: recovered.task.taskId,
      result: recovered.resultOverview,
      checkpointRef: checkpoint?.checkpointRef ?? null,
    }, this.#clock());
    this.#recoveredTaskCompletion = null;
    this.#currentAction = null;
    this.#activeTask = null;
    this.#runner = null;
    await this.#writeCheckpoint(recovered.resultOverview);
  }
}
