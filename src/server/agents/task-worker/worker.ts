import { createHash, randomUUID } from "node:crypto";
import { TaskWorkerJournalStore } from "./journal.js";
import {
  estimateMinutesFromActivity,
  phaseStageFromActivity,
  phaseSignalFromActivity,
  sanitizeActivity,
  type LivePhaseSignal,
} from "./provider-activity.js";
import {
  parseAgentRunOutcome,
  parseBoundedAgentContext,
  parseTaskWakeClaim,
} from "./schema.js";
import {
  TASK_WAKE_REASONS,
  type AgentRunHandle,
  type AgentRunOutcome,
  type AgentTaskPhase,
  type AgentTaskPhaseUpdate,
  type BoundedAgentContext,
  type ClaimedAgentRun,
  type TaskWakeClaim,
  type TaskWakeReason,
  type TaskWorkerJournal,
  type TaskWorkerOptions,
} from "./types.js";

class SerialExecutor {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release: (() => void) | undefined;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  idle(): Promise<void> { return this.#tail; }
}

const ALLOWED_WAKE_REASONS = new Set<string>(TASK_WAKE_REASONS);
const MAX_HISTORY = 256;
const MAX_MESSAGE_CURSORS = 256;

function exactNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error("Task worker clock is invalid");
  return value.toISOString();
}

function safeDetail(error: unknown, fallback: string): string {
  const source = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const redacted = source
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [redacted]")
    .replace(/\b(?:sk|xox|ghp|github_pat)_[A-Za-z0-9_-]+/giu, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim();
  return (redacted || fallback).slice(0, 2_000);
}

function contextDigest(context: BoundedAgentContext): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(context)).digest("hex")}`;
}

function outputIdempotency(claim: TaskWakeClaim, index: number, output: AgentRunOutcome["outputs"][number]): string {
  const digest = createHash("sha256").update(JSON.stringify({
    action: "append_task_worker_output",
    runId: claim.runId,
    wakeupId: claim.wakeupId,
    taskId: claim.taskId,
    localSequence: index + 1,
    output,
  })).digest("hex");
  return `twe_${digest}`;
}

function activityIdempotency(claim: TaskWakeClaim, sequence: number, body: string): string {
  const digest = createHash("sha256").update(JSON.stringify({
    action: "append_task_worker_activity",
    runId: claim.runId,
    wakeupId: claim.wakeupId,
    taskId: claim.taskId,
    sequence,
    body,
  })).digest("hex");
  return `twa_${digest}`;
}

function settlementIdempotency(claim: TaskWakeClaim, outcome: AgentRunOutcome, result: string): string {
  const digest = createHash("sha256").update(JSON.stringify({
    action: "settle_task_worker_run",
    runId: claim.runId,
    wakeupId: claim.wakeupId,
    taskId: claim.taskId,
    outcome: outcome.status,
    result,
  })).digest("hex");
  return `tws_${digest}`;
}

function requestedCursor(messageCursors: Readonly<Record<string, number>>, taskId: string | null): number | null {
  return taskId === null ? null : messageCursors[taskId] ?? null;
}

function withTaskCursor(
  messageCursors: Readonly<Record<string, number>>,
  taskId: string,
  cursor: number,
): Readonly<Record<string, number>> {
  const entries = new Map(Object.entries(messageCursors));
  entries.delete(taskId);
  entries.set(taskId, cursor);
  return Object.freeze(Object.fromEntries([...entries.entries()].slice(-MAX_MESSAGE_CURSORS)));
}

function settlementResult(outcome: AgentRunOutcome): string {
  if (outcome.status !== "completed") return outcome.detail;
  const result = outcome.outputs.find((output) => output.type === "result");
  if (result?.type !== "result") throw new Error("Completed agent outcome is missing its result output");
  return result.body;
}

function interruptedOutcome(reason: string): AgentRunOutcome {
  return Object.freeze({
    status: "interrupted",
    outputs: Object.freeze([]),
    expectedAgentMinutes: null,
    phases: Object.freeze([]),
    detail: safeDetail(reason, "The agent run was interrupted."),
  });
}

function failedOutcome(error: unknown, fallback: string): AgentRunOutcome {
  return Object.freeze({
    status: "failed",
    outputs: Object.freeze([]),
    expectedAgentMinutes: null,
    phases: Object.freeze([]),
    detail: safeDetail(error, fallback),
  });
}

interface LiveTaskState {
  taskVersion: number;
  expectedAgentMinutes: number | null;
  currentPhase: AgentTaskPhase | null;
  parallelPhases: Map<string, AgentTaskPhase>;
  phaseSource: "inferred" | "structured";
  phaseTracking: boolean;
  estimateTracking: boolean;
}

function livePhaseTitle(stage: Exclude<AgentTaskPhase["stage"], "done">): string {
  switch (stage) {
    case "research": return "Review task";
    case "planning": return "Plan work";
    case "execution": return "Execute work";
    case "testing": return "Test work";
    case "review": return "Review result";
  }
}

function samePhaseState(phase: AgentTaskPhase, update: AgentTaskPhaseUpdate): boolean {
  return phase.title === update.title && phase.stage === update.stage && phase.status === update.status &&
    phase.parallelGroup === update.parallelGroup && phase.orderKey === update.orderKey;
}

function wakeAuthorizationFailure(claim: TaskWakeClaim, context: BoundedAgentContext): string | null {
  if (!ALLOWED_WAKE_REASONS.has(claim.reason)) {
    return `Wake reason ${claim.reason} is not human-authorized or an approved workflow handoff.`;
  }
  if (claim.reason !== "workflow_handoff") return null;
  if (
    context.task.kind !== "manager_review" ||
    context.task.requiredRole !== "manager" ||
    context.mission.role !== "manager" ||
    context.parentEvidence === null ||
    context.parentEvidence.status !== "completed" ||
    context.parentEvidence.endedAt === null ||
    context.parentEvidence.result === null
  ) {
    return "Workflow handoff is not bound to a manager review with completed parent evidence.";
  }
  return null;
}

function assertClaimBinding(
  claimed: ClaimedAgentRun,
  agentId: string,
  expectedClaimId: string,
  messageCursors: Readonly<Record<string, number>>,
): ClaimedAgentRun {
  const claim = parseTaskWakeClaim(claimed.claim);
  const context = claimed.context === null ? null : parseBoundedAgentContext(claimed.context);
  const cursor = requestedCursor(messageCursors, claim.taskId);
  if (
    claim.agentId !== agentId ||
    claim.claimId !== expectedClaimId ||
    claim.requestedMessageCursor !== cursor ||
    (claim.taskId === null) !== (context === null) ||
    (context !== null && (
      context.projectId !== claim.projectId ||
      context.agentId !== claim.agentId ||
      context.taskId !== claim.taskId ||
      context.messagesSinceCursor !== cursor
    ))
  ) {
    throw new Error("Task-board claim context does not match the requested agent, task, or cursor");
  }
  return Object.freeze({ claim, context });
}

export interface TaskWorkerSnapshot {
  readonly started: boolean;
  readonly dispatchInFlight: boolean;
  readonly activeRunId: string | null;
  readonly activePhase: TaskWorkerJournal["active"] extends infer _ ? import("./types.js").ActiveRunPhase | null : never;
  readonly interruptReason: string | null;
  readonly messageCursors: Readonly<Record<string, number>>;
  readonly completedRuns: number;
}

export class TaskWorker {
  readonly #options: TaskWorkerOptions & { readonly longPollMs: number; readonly now: () => Date };
  readonly #store: TaskWorkerJournalStore;
  readonly #serial = new SerialExecutor();
  #state: TaskWorkerJournal;
  #started = false;
  #dispatchInFlight = false;
  #activeHandle: AgentRunHandle | null = null;
  #interruptSettlement: Promise<void> | null = null;
  #interruptTerminalResolve: (() => void) | null = null;

  private constructor(options: TaskWorkerOptions, store: TaskWorkerJournalStore) {
    const longPollMs = options.longPollMs ?? 30_000;
    if (!Number.isSafeInteger(longPollMs) || longPollMs < 1 || longPollMs > 30_000) {
      throw new Error("longPollMs must be an integer between 1 and 30000");
    }
    this.#options = { ...options, longPollMs, now: options.now ?? (() => new Date()) };
    this.#store = store;
    this.#state = store.current;
  }

  static async create(options: TaskWorkerOptions): Promise<TaskWorker> {
    const store = await TaskWorkerJournalStore.open(options.statePath, options.identity);
    return new TaskWorker(options, store);
  }

  get snapshot(): TaskWorkerSnapshot {
    return {
      started: this.#started,
      dispatchInFlight: this.#dispatchInFlight,
      activeRunId: this.#state.active?.claim.runId ?? null,
      activePhase: this.#state.active?.phase ?? null,
      interruptReason: this.#state.active?.interruptReason ?? null,
      messageCursors: structuredClone(this.#state.messageCursors),
      completedRuns: this.#state.completed.length,
    };
  }

  async start(): Promise<void> {
    this.#started = true;
  }

  /**
   * Claims at most one durable wake and invokes at most one model process.
   * The board call may long-poll; an idle call never launches the provider.
   */
  async dispatchOnce(signal?: AbortSignal): Promise<boolean> {
    if (!this.#started) await this.start();
    if (this.#dispatchInFlight) return false;
    this.#dispatchInFlight = true;
    try {
      if (this.#state.active !== null) return await this.#recoverOrContinueActive(signal);
      const pending = await this.#ensurePendingClaim();
      const claimed = await this.#options.board.claimNextWake({
        agentId: this.#options.identity.agentId,
        claimId: pending.claimId,
        messageCursors: pending.messageCursors,
        longPollMs: this.#options.longPollMs,
      }, signal);
      if (claimed === null) {
        await this.#serial.run(async () => {
          if (this.#state.pendingClaim?.claimId !== pending.claimId) return;
          const next = { ...this.#state, pendingClaim: null };
          this.#state = next;
          await this.#store.save(next);
        });
        return false;
      }
      const parsed = assertClaimBinding(claimed, this.#options.identity.agentId, pending.claimId, pending.messageCursors);
      await this.#recordClaim(parsed);
      if (parsed.context === null) {
        await this.#recordOutcome(failedOutcome("A human resume without a task cannot launch an agent process.", "No task was assigned."));
        await this.#flushAndFinish();
      } else {
        await this.#executeActive(parsed.context, signal);
      }
      return true;
    } finally {
      this.#dispatchInFlight = false;
    }
  }

  /** The dispatcher performs no timer-based model work; every launch follows a claimed, authorized wake. */
  async run(signal: AbortSignal): Promise<void> {
    await this.start();
    while (!signal.aborted) {
      try {
        await this.dispatchOnce(signal);
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
    }
  }

  async #ensurePendingClaim(): Promise<NonNullable<TaskWorkerJournal["pendingClaim"]>> {
    return this.#serial.run(async () => {
      if (this.#state.pendingClaim !== null) return this.#state.pendingClaim;
      const pendingClaim = Object.freeze({
        claimId: `claim-${randomUUID()}`,
        messageCursors: Object.freeze({ ...this.#state.messageCursors }),
      });
      const next = { ...this.#state, pendingClaim };
      this.#state = next;
      await this.#store.save(next);
      return pendingClaim;
    });
  }

  async #recordClaim(claimed: ClaimedAgentRun): Promise<void> {
    await this.#serial.run(async () => {
      if (this.#state.active !== null) throw new Error("Task worker already owns an active run");
      if (this.#state.pendingClaim?.claimId !== claimed.claim.claimId) throw new Error("Task-board claim intent changed in flight");
      const active = Object.freeze({
        claim: claimed.claim,
        phase: "claimed" as const,
        contextDigest: null,
        launchStartedAt: null,
        interruptReason: null,
        outcome: null,
        nextOutputIndex: 0,
      });
      const next: TaskWorkerJournal = {
        ...this.#state,
        messageCursors: claimed.context === null
          ? this.#state.messageCursors
          : withTaskCursor(this.#state.messageCursors, claimed.context.taskId, claimed.context.nextMessageCursor),
        pendingClaim: null,
        active,
      };
      this.#state = next;
      await this.#store.save(next);
    });
  }

  async #recoverOrContinueActive(signal?: AbortSignal): Promise<boolean> {
    const active = this.#state.active;
    if (active === null) return false;
    if (active.phase === "outputs_pending") {
      await this.#flushAndFinish();
      return true;
    }
    if (active.phase === "claimed") {
      const replay = await this.#options.board.claimNextWake({
        agentId: this.#options.identity.agentId,
        claimId: active.claim.claimId,
        messageCursors: active.claim.taskId === null || active.claim.requestedMessageCursor === null
          ? Object.freeze({})
          : Object.freeze({ [active.claim.taskId]: active.claim.requestedMessageCursor }),
        longPollMs: 0,
      }, signal);
      if (replay === null) throw new Error("Task board did not replay the active durable claim");
      const parsed = assertClaimBinding(
        replay,
        this.#options.identity.agentId,
        active.claim.claimId,
        active.claim.taskId === null || active.claim.requestedMessageCursor === null
          ? Object.freeze({})
          : Object.freeze({ [active.claim.taskId]: active.claim.requestedMessageCursor }),
      );
      if (parsed.claim.runId !== active.claim.runId || parsed.claim.wakeupId !== active.claim.wakeupId) {
        throw new Error("Task board replayed another run for the active claim");
      }
      if (parsed.context === null) {
        await this.#recordOutcome(failedOutcome("A human resume without a task cannot launch an agent process.", "No task was assigned."));
        await this.#flushAndFinish();
      } else {
        await this.#executeActive(parsed.context, signal);
      }
      return true;
    }
    const outcome = active.interruptReason === null
      ? failedOutcome("Worker restarted after the one-shot launch boundary; refusing to launch a duplicate agent process.", "Run recovery failed.")
      : interruptedOutcome(active.interruptReason);
    await this.#closeRecoveredPhases(active.claim, signal);
    await this.#recordOutcome(outcome);
    await this.#flushAndFinish();
    return true;
  }

  async #closeRecoveredPhases(claim: TaskWakeClaim, signal?: AbortSignal): Promise<void> {
    const cursors = claim.taskId === null || claim.requestedMessageCursor === null
      ? Object.freeze({})
      : Object.freeze({ [claim.taskId]: claim.requestedMessageCursor });
    try {
      const replay = await this.#options.board.claimNextWake({
        agentId: this.#options.identity.agentId,
        claimId: claim.claimId,
        messageCursors: cursors,
        longPollMs: 0,
      }, signal);
      if (replay === null) return;
      const parsed = assertClaimBinding(replay, this.#options.identity.agentId, claim.claimId, cursors);
      if (parsed.claim.runId !== claim.runId || parsed.claim.wakeupId !== claim.wakeupId || parsed.context === null) return;
      for (const phase of parsed.context.task.phases) {
        if (phase.status === "completed" || phase.status === "failed") continue;
        try {
          await this.#options.board.updateTaskPhase({ claim, phase, status: "failed" }, signal);
        } catch {
          // Recovery settlement remains primary if a phase changed concurrently.
        }
      }
    } catch {
      // Refusing a duplicate model launch is more important than phase cleanup.
    }
  }

  async #executeActive(contextInput: BoundedAgentContext, signal?: AbortSignal): Promise<void> {
    const context = parseBoundedAgentContext(contextInput);
    const active = this.#state.active;
    if (active === null || active.phase !== "claimed") throw new Error("Task worker has no claimed run to execute");
    const control = new AbortController();
    const liveTask: LiveTaskState = {
      taskVersion: context.task.version,
      expectedAgentMinutes: context.task.expectedAgentMinutes,
      currentPhase: null,
      parallelPhases: new Map(),
      phaseSource: "inferred",
      phaseTracking: true,
      estimateTracking: true,
    };
    const onAbort = () => { void this.interrupt("Task worker shutdown requested"); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const watch = this.#options.board.waitForRunInterrupt(active.claim, control.signal)
      .then(async (interrupt) => {
        if (interrupt === null) return;
        if (
          interrupt.runId !== active.claim.runId || interrupt.agentId !== active.claim.agentId ||
          interrupt.projectId !== active.claim.projectId
        ) {
          throw new Error("Task board returned an interrupt for another active run");
        }
        await this.interrupt(interrupt.reason);
      })
      .catch(async (error: unknown) => {
        if (control.signal.aborted) return;
        await this.interrupt(safeDetail(error, "The durable interrupt channel failed."));
      });
    try {
      const authorizationFailure = wakeAuthorizationFailure(active.claim, context);
      if (authorizationFailure !== null) {
        await this.#recordOutcome(failedOutcome(
          authorizationFailure,
          "Wake reason is not authorized.",
        ));
        await this.#flushAndFinish();
        return;
      }
      if (signal?.aborted || this.#state.active?.interruptReason !== null) {
        await this.#recordOutcome(interruptedOutcome(this.#state.active?.interruptReason ?? "Task worker shutdown requested"));
        await this.#flushAndFinish();
        return;
      }
      await this.#serial.run(async () => {
        const current = this.#state.active;
        if (current === null || current.claim.runId !== active.claim.runId || current.phase !== "claimed") {
          throw new Error("Active run changed before the launch boundary");
        }
        const next: TaskWorkerJournal = {
          ...this.#state,
          active: {
            ...current,
            phase: "launch_started",
            contextDigest: contextDigest(context),
            launchStartedAt: exactNow(this.#options.now),
          },
        };
        this.#state = next;
        await this.#store.save(next);
      });

      let outcome: AgentRunOutcome;
      try {
        await this.#startLivePhase(active.claim, liveTask);
        if (signal?.aborted || this.#state.active?.interruptReason !== null) {
          throw new Error("The run was interrupted before the model launch boundary");
        }
        const handle = await this.#options.launcher.launch({
          runId: active.claim.runId,
          wakeReason: active.claim.reason as TaskWakeReason,
          context,
        });
        this.#activeHandle = handle;
        await this.#serial.run(async () => {
          const current = this.#state.active;
          if (current === null || current.claim.runId !== active.claim.runId) throw new Error("Active run changed during launch");
          const next: TaskWorkerJournal = { ...this.#state, active: { ...current, phase: "running" } };
          this.#state = next;
          await this.#store.save(next);
        });

        const activityForwarding = this.#forwardActivity(active.claim, handle.activity, liveTask).then(
          () => null,
          (error: unknown) => error,
        );

        let resolveInterrupted!: () => void;
        const interrupted = new Promise<void>((resolve) => { resolveInterrupted = resolve; });
        this.#interruptTerminalResolve = resolveInterrupted;
        await this.#settleActiveInterrupt();
        const completion = handle.completion.then(
          (value) => ({ type: "completed" as const, value }),
          (error: unknown) => ({ type: "failed" as const, error }),
        );
        const terminal = await Promise.race([
          completion,
          interrupted.then(() => ({ type: "interrupted" as const })),
        ]);
        // The launcher closes activity with the provider stream. Drain all safe
        // updates before any terminal output or settlement can make the run inactive.
        await activityForwarding;
        control.abort();
        await watch;
        if (this.#state.active?.interruptReason !== null || terminal.type === "interrupted") {
          await this.#settleActiveInterrupt();
          outcome = interruptedOutcome(this.#state.active?.interruptReason ?? "The agent run was interrupted.");
        } else if (terminal.type === "failed") {
          outcome = failedOutcome(terminal.error, "The one-shot agent process failed.");
        } else {
          outcome = parseAgentRunOutcome(terminal.value);
        }
      } catch (error) {
        outcome = this.#state.active?.interruptReason === null && !signal?.aborted
          ? failedOutcome(error, "The one-shot agent process failed.")
          : interruptedOutcome(this.#state.active?.interruptReason ?? "Task worker shutdown requested");
      }
      await this.#applyStructuredTaskState(active.claim, context, outcome, liveTask);
      await this.#finishLivePhase(active.claim, liveTask, outcome.status);
      await this.#recordOutcome(outcome);
      await this.#flushAndFinish();
    } finally {
      control.abort();
      await watch;
      signal?.removeEventListener("abort", onAbort);
      this.#activeHandle = null;
      this.#interruptSettlement = null;
      this.#interruptTerminalResolve = null;
    }
  }

  async #startLivePhase(claim: TaskWakeClaim, liveTask: LiveTaskState): Promise<void> {
    if (!liveTask.phaseTracking || claim.taskId === null) return;
    try {
      const created = await this.#options.board.createTaskPhase({
        claim,
        title: livePhaseTitle("research"),
        stage: "research",
        parallelGroup: null,
      });
      liveTask.currentPhase = await this.#options.board.updateTaskPhase({
        claim,
        phase: created,
        status: "in_progress",
      });
    } catch {
      liveTask.phaseTracking = false;
    }
  }

  async #advanceLivePhase(
    claim: TaskWakeClaim,
    liveTask: LiveTaskState,
    stage: Exclude<AgentTaskPhase["stage"], "done">,
  ): Promise<void> {
    if (!liveTask.phaseTracking || liveTask.phaseSource !== "inferred" || claim.taskId === null) return;
    if (liveTask.currentPhase?.stage === stage && liveTask.currentPhase.status === "in_progress") return;
    try {
      const current = liveTask.currentPhase;
      if (current !== null && current.status !== "completed" && current.status !== "failed") {
        liveTask.currentPhase = await this.#options.board.updateTaskPhase({
          claim,
          phase: current,
          status: "completed",
        });
      }
      const created = await this.#options.board.createTaskPhase({
        claim,
        title: livePhaseTitle(stage),
        stage,
        parallelGroup: null,
      });
      liveTask.currentPhase = await this.#options.board.updateTaskPhase({
        claim,
        phase: created,
        status: "in_progress",
      });
    } catch {
      liveTask.phaseTracking = false;
    }
  }

  async #finishLivePhase(
    claim: TaskWakeClaim,
    liveTask: LiveTaskState,
    outcome: AgentRunOutcome["status"],
  ): Promise<void> {
    const current = liveTask.currentPhase;
    if (claim.taskId === null) return;
    if (
      liveTask.phaseTracking && current !== null &&
      current.status !== "completed" && current.status !== "failed"
    ) {
      try {
        liveTask.currentPhase = outcome === "completed"
          ? await this.#options.board.updateTaskPhase({
              claim,
              phase: current,
              status: "completed",
            })
          : await this.#options.board.updateTaskPhase({
              claim,
              phase: current,
              status: outcome === "waiting_for_human" ? "blocked" : "failed",
            });
      } catch {
        liveTask.phaseTracking = false;
      }
    }
    for (const [key, phase] of liveTask.parallelPhases) {
      if (phase.status === "completed" || phase.status === "failed") continue;
      try {
        const updated = outcome === "completed"
          ? await this.#options.board.updateTaskPhase({ claim, phase, status: "completed" })
          : await this.#options.board.updateTaskPhase({
              claim,
              phase,
              status: outcome === "waiting_for_human" ? "blocked" : "failed",
            });
        liveTask.parallelPhases.set(key, updated);
      } catch {
        // The task outcome remains authoritative if phase telemetry conflicts.
      }
    }
  }

  async #applyLivePhaseSignal(
    claim: TaskWakeClaim,
    liveTask: LiveTaskState,
    signal: LivePhaseSignal,
  ): Promise<void> {
    if (!liveTask.phaseTracking || claim.taskId === null) return;
    try {
      let phase = liveTask.parallelPhases.get(signal.key);
      if (phase !== undefined && (phase.status === "completed" || phase.status === "failed")) {
        // Provider keys identify one durable phase row. A repeated loop must use
        // a fresh key so history is appended rather than rewriting terminal work.
        return;
      }
      if (phase === undefined) {
        if (liveTask.phaseSource === "inferred" && liveTask.currentPhase !== null) {
          // The marker is stronger evidence than lifecycle inference. Adopt the
          // active inferred row so the marker's own tool call cannot create an
          // interleaved testing -> execution sequence and a false loop.
          phase = liveTask.currentPhase;
          liveTask.currentPhase = null;
        } else {
          phase = await this.#options.board.createTaskPhase({
            claim,
            title: signal.title,
            stage: signal.stage === "done" ? "review" : signal.stage,
            parallelGroup: signal.parallelGroup,
          });
        }
      }
      liveTask.phaseSource = "structured";
      if (
        phase.title !== signal.title ||
        phase.stage !== (signal.stage === "done" ? phase.stage : signal.stage) ||
        phase.status !== signal.status ||
        phase.parallelGroup !== signal.parallelGroup
      ) {
        const stage = signal.stage === "done" ? phase.stage : signal.stage;
        phase = await this.#options.board.updateTaskPhase({
          claim,
          phase,
          ...(phase.title === signal.title ? {} : { title: signal.title }),
          ...(phase.stage === stage ? {} : { stage }),
          ...(phase.status === signal.status ? {} : { status: signal.status }),
          ...(phase.parallelGroup === signal.parallelGroup ? {} : { parallelGroup: signal.parallelGroup }),
        });
      }
      liveTask.parallelPhases.set(signal.key, phase);
    } catch {
      liveTask.phaseTracking = false;
    }
  }

  async #applyStructuredTaskState(
    claim: TaskWakeClaim,
    context: BoundedAgentContext,
    outcome: AgentRunOutcome,
    liveTask: LiveTaskState,
  ): Promise<void> {
    if (claim.taskId === null) return;
    if (
      liveTask.estimateTracking &&
      outcome.expectedAgentMinutes !== null &&
      outcome.expectedAgentMinutes !== liveTask.expectedAgentMinutes
    ) {
      try {
        liveTask.taskVersion = await this.#options.board.updateTaskEstimate({
          claim,
          version: liveTask.taskVersion,
          expectedAgentMinutes: outcome.expectedAgentMinutes,
        });
        liveTask.expectedAgentMinutes = outcome.expectedAgentMinutes;
      } catch {
        // A human may have reordered the task while this run was active, which
        // advances its CAS version. Metadata loss must not invalidate completed work.
        liveTask.estimateTracking = false;
      }
    }

    const existing = new Map(context.task.phases.map((phase) => [phase.phaseId, phase] as const));
    for (const desired of outcome.phases) {
      try {
        let phase: AgentTaskPhase;
        if (desired.phaseId === null) {
          phase = await this.#options.board.createTaskPhase({
            claim,
            title: desired.title,
            // A newly created phase starts pending; use a non-terminal stage for
            // the instant before a completed desired state is applied.
            stage: desired.stage === "done" ? "review" : desired.stage,
            parallelGroup: desired.parallelGroup,
          });
          existing.set(phase.phaseId, phase);
        } else {
          const current = existing.get(desired.phaseId);
          if (current === undefined) continue;
          if (current.status === "completed" || current.status === "failed") continue;
          phase = current;
        }
        const desiredStage = desired.stage === "done" && desired.status === "completed"
          ? phase.stage
          : desired.stage;
        if (samePhaseState(phase, { ...desired, stage: desiredStage })) continue;
        phase = await this.#options.board.updateTaskPhase({
          claim,
          phase,
          ...(phase.title === desired.title ? {} : { title: desired.title }),
          ...(phase.stage === desiredStage ? {} : { stage: desiredStage }),
          ...(phase.status === desired.status ? {} : { status: desired.status }),
          ...(phase.parallelGroup === desired.parallelGroup ? {} : { parallelGroup: desired.parallelGroup }),
          ...(phase.orderKey === desired.orderKey ? {} : { orderKey: desired.orderKey }),
        });
        existing.set(phase.phaseId, phase);
      } catch {
        // Phase telemetry is useful but subordinate to the task's tested result.
        // Conflicts remain visible in board history and do not rewrite the outcome.
      }
    }
    if (outcome.status === "completed") {
      for (const [phaseId, phase] of existing) {
        if (phase.status === "completed" || phase.status === "failed") continue;
        try {
          existing.set(phaseId, await this.#options.board.updateTaskPhase({
            claim,
            phase,
            status: "completed",
          }));
        } catch {
          // A concurrent phase change cannot invalidate the task's tested result.
        }
      }
    }
  }

  async #forwardActivity(
    claim: TaskWakeClaim,
    activity: AsyncIterable<string>,
    liveTask: LiveTaskState,
  ): Promise<void> {
    if (claim.taskId === null) return;
    let sequence = 0;
    for await (const observed of activity) {
      const phaseSignal = phaseSignalFromActivity(observed);
      if (phaseSignal !== null) await this.#applyLivePhaseSignal(claim, liveTask, phaseSignal);
      const body = phaseSignal === null ? sanitizeActivity(observed) : "Agent updated a task phase.";
      if (body === null) continue;
      const current = this.#state.active;
      if (current === null || current.claim.runId !== claim.runId || current.phase === "outputs_pending") return;
      sequence += 1;
      const estimate = estimateMinutesFromActivity(body);
      if (
        estimate !== null && liveTask.estimateTracking &&
        estimate !== liveTask.expectedAgentMinutes
      ) {
        try {
          liveTask.taskVersion = await this.#options.board.updateTaskEstimate({
            claim,
            version: liveTask.taskVersion,
            expectedAgentMinutes: estimate,
          });
          liveTask.expectedAgentMinutes = estimate;
        } catch {
          liveTask.estimateTracking = false;
        }
      }
      const stage = phaseStageFromActivity(body);
      if (stage !== null) await this.#advanceLivePhase(claim, liveTask, stage);
      const request = {
        claim,
        output: Object.freeze({ type: "progress" as const, body }),
        localSequence: sequence,
        idempotencyKey: activityIdempotency(claim, sequence, body),
      };
      try {
        await this.#options.board.appendRunOutput(request);
      } catch {
        // A lost response is safe to retry because the key binds the run,
        // sequence, and sanitized body. Activity remains secondary to the run result.
        await this.#options.board.appendRunOutput(request);
      }
    }
  }

  async #recordOutcome(outcomeInput: AgentRunOutcome): Promise<void> {
    const outcome = parseAgentRunOutcome(outcomeInput);
    await this.#serial.run(async () => {
      const active = this.#state.active;
      if (active === null) throw new Error("Cannot record an outcome without an active run");
      const next: TaskWorkerJournal = {
        ...this.#state,
        active: { ...active, phase: "outputs_pending", outcome, nextOutputIndex: 0 },
      };
      this.#state = next;
      await this.#store.save(next);
    });
  }

  async #flushAndFinish(): Promise<void> {
    let active = this.#state.active;
    if (active === null || active.phase !== "outputs_pending" || active.outcome === null) {
      throw new Error("Task worker has no terminal output to flush");
    }
    const outcome = active.outcome;
    const result = settlementResult(outcome);
    while (active.nextOutputIndex < outcome.outputs.length) {
      const index = active.nextOutputIndex;
      const output = outcome.outputs[index];
      if (output === undefined) throw new Error("Task worker output cursor is invalid");
      await this.#options.board.appendRunOutput({
        claim: active.claim,
        output,
        localSequence: index + 1,
        idempotencyKey: outputIdempotency(active.claim, index, output),
      });
      await this.#serial.run(async () => {
        const current = this.#state.active;
        if (current === null || current.claim.runId !== active!.claim.runId || current.outcome === null) {
          throw new Error("Active run changed while output was being appended");
        }
        const next: TaskWorkerJournal = {
          ...this.#state,
          active: { ...current, nextOutputIndex: Math.max(current.nextOutputIndex, index + 1) },
        };
        this.#state = next;
        await this.#store.save(next);
      });
      active = this.#state.active;
      if (active === null) throw new Error("Active run disappeared while outputs were pending");
    }
    if (outcome.status !== "waiting_for_human") {
      await this.#options.board.settleAgentRun({
        claim: active.claim,
        outcome: outcome.status,
        result,
        handoff: outcome.handoff ?? null,
        idempotencyKey: settlementIdempotency(active.claim, outcome, result),
      });
    }
    await this.#serial.run(async () => {
      const current = this.#state.active;
      if (current === null || current.claim.runId !== active!.claim.runId) throw new Error("Active run changed before settlement journal");
      const completed = [...this.#state.completed, Object.freeze({
        runId: current.claim.runId,
        wakeId: current.claim.wakeupId,
        taskId: current.claim.taskId,
        outcome: outcome.status,
        detail: outcome.detail,
        startedAt: current.claim.claimedAt,
        endedAt: exactNow(this.#options.now),
      })].slice(-MAX_HISTORY);
      const next: TaskWorkerJournal = { ...this.#state, active: null, completed };
      this.#state = next;
      await this.#store.save(next);
    });
  }

  /** Directly reaches the launcher handle; no heartbeat or model turn mediates interruption. */
  async interrupt(reason: string): Promise<boolean> {
    const detail = safeDetail(reason, "Human interruption requested");
    const active = await this.#serial.run(async () => {
      const current = this.#state.active;
      if (current === null || current.phase === "outputs_pending") return null;
      if (current.interruptReason !== null) return current;
      const next: TaskWorkerJournal = { ...this.#state, active: { ...current, interruptReason: detail } };
      this.#state = next;
      await this.#store.save(next);
      return next.active;
    });
    if (active === null) return false;
    await this.#settleActiveInterrupt();
    return true;
  }

  async #settleActiveInterrupt(): Promise<void> {
    const reason = this.#state.active?.interruptReason;
    const handle = this.#activeHandle;
    if (reason === null || reason === undefined || handle === null) return;
    if (this.#interruptSettlement === null) {
      this.#interruptSettlement = handle.interrupt(reason).then(() => {
        this.#interruptTerminalResolve?.();
      });
    }
    await this.#interruptSettlement;
  }

  async close(): Promise<void> {
    if (this.#state.active !== null && this.#state.active.phase !== "outputs_pending") {
      await this.interrupt("Task worker is shutting down");
    }
    await this.#serial.idle();
    await this.#store.close();
    this.#started = false;
  }
}
