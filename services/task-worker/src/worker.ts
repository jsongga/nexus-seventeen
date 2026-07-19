import { createHash, randomUUID } from "node:crypto";
import { TaskWorkerJournalStore } from "./journal.js";
import {
  parseAgentRunOutcome,
  parseBoundedAgentContext,
  parseTaskWakeClaim,
} from "./schema.js";
import {
  TASK_WAKE_REASONS,
  type AgentRunHandle,
  type AgentRunOutcome,
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

function settlementIdempotency(claim: TaskWakeClaim, outcome: AgentRunOutcome): string {
  const digest = createHash("sha256").update(JSON.stringify({
    action: "settle_task_worker_run",
    runId: claim.runId,
    wakeupId: claim.wakeupId,
    taskId: claim.taskId,
    outcome: outcome.status,
    detail: outcome.detail,
  })).digest("hex");
  return `tws_${digest}`;
}

function interruptedOutcome(reason: string): AgentRunOutcome {
  return Object.freeze({
    status: "interrupted",
    outputs: Object.freeze([]),
    detail: safeDetail(reason, "The agent run was interrupted."),
  });
}

function failedOutcome(error: unknown, fallback: string): AgentRunOutcome {
  return Object.freeze({
    status: "failed",
    outputs: Object.freeze([]),
    detail: safeDetail(error, fallback),
  });
}

function assertClaimBinding(claimed: ClaimedAgentRun, agentId: string, expectedClaimId: string, cursor: number | null): ClaimedAgentRun {
  const claim = parseTaskWakeClaim(claimed.claim);
  const context = claimed.context === null ? null : parseBoundedAgentContext(claimed.context);
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
  readonly messageCursor: number | null;
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
    if (!Number.isSafeInteger(longPollMs) || longPollMs < 0 || longPollMs > 30_000) {
      throw new Error("longPollMs must be an integer between 0 and 30000");
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
      messageCursor: this.#state.messageCursor,
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
        messageCursor: pending.messageCursor,
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
      const parsed = assertClaimBinding(claimed, this.#options.identity.agentId, pending.claimId, pending.messageCursor);
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

  /** The dispatcher performs no timer-based model work; every launch follows a claimed human wake. */
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
      const pendingClaim = Object.freeze({ claimId: `claim-${randomUUID()}`, messageCursor: this.#state.messageCursor });
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
        messageCursor: claimed.context?.nextMessageCursor ?? this.#state.messageCursor,
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
        messageCursor: active.claim.requestedMessageCursor,
        longPollMs: 0,
      }, signal);
      if (replay === null) throw new Error("Task board did not replay the active durable claim");
      const parsed = assertClaimBinding(
        replay,
        this.#options.identity.agentId,
        active.claim.claimId,
        active.claim.requestedMessageCursor,
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
    await this.#recordOutcome(outcome);
    await this.#flushAndFinish();
    return true;
  }

  async #executeActive(contextInput: BoundedAgentContext, signal?: AbortSignal): Promise<void> {
    const context = parseBoundedAgentContext(contextInput);
    const active = this.#state.active;
    if (active === null || active.phase !== "claimed") throw new Error("Task worker has no claimed run to execute");
    const control = new AbortController();
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
      if (!ALLOWED_WAKE_REASONS.has(active.claim.reason)) {
        await this.#recordOutcome(failedOutcome(
          `Wake reason ${active.claim.reason} is not human-authorized.`,
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
        outcome = this.#state.active?.interruptReason === null
          ? failedOutcome(error, "The one-shot agent process failed.")
          : interruptedOutcome(this.#state.active?.interruptReason ?? "The agent run was interrupted.");
      }
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
        detail: outcome.detail,
        idempotencyKey: settlementIdempotency(active.claim, outcome),
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
