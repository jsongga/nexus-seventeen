import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ROLE_CAPABILITIES,
  STEWARD_RUNTIME_API_VERSION,
  parseDurableOutboxEvent,
  parseRuntimeCommandEnvelope,
  parseRuntimeEventBatch,
  type AgentTaskProjection,
  type DurableOutboxPayload,
  type RuntimeCommandEnvelope,
} from "#shared/protocol";
import { parseInspectionResult } from "./schema.js";
import { ManagerRuntimeStateStore } from "./state.js";
import type {
  ActiveManagerReview,
  ManagerRuntimeClaim,
  ManagerRuntimeOptions,
  ManagerRuntimeState,
  StoredDecision,
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

interface PreparedWork {
  readonly active: ActiveManagerReview;
  readonly claim: ManagerRuntimeClaim;
}

const MAX_JOURNAL = 1_000;

function nowIso(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error("Manager runtime clock is invalid");
  return value.toISOString();
}

function boundedJournal(value: string): string {
  const redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [redacted]")
    .replace(/\b(?:sk|rgp|rgc)_[A-Za-z0-9_-]+/giu, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim();
  return (redacted || "Manager review step completed.").slice(0, MAX_JOURNAL);
}

function checkpoint(active: ActiveManagerReview | null): string | null {
  if (active === null) return null;
  const taskHash = createHash("sha256").update(active.task.taskId).digest("hex").slice(0, 24);
  return `manager-${taskHash}-${active.phase}-${active.iteration}`;
}

function leaseRenewalDeadline(lease: ManagerRuntimeState["lease"]): number {
  if (lease === null) throw new Error("Manager runtime lease is missing");
  const grantedAt = Date.parse(lease.leaseGrantedAt);
  const expiresAt = Date.parse(lease.leaseExpiresAt);
  if (!Number.isFinite(grantedAt) || !Number.isFinite(expiresAt) || expiresAt <= grantedAt) {
    throw new Error("Manager runtime lease interval is invalid");
  }
  return grantedAt + Math.floor((expiresAt - grantedAt) / 2);
}

function taskKey(task: AgentTaskProjection): string {
  return `${task.agentId}\u0000${task.laneId}\u0000${task.taskId}`;
}

function reviewIdempotency(active: ActiveManagerReview): string {
  if (active.evidence === null || active.decision === null) throw new Error("Review evidence or decision is missing");
  const binding = JSON.stringify({
    workspaceId: active.task.workspaceId,
    managerAgentId: active.task.agentId,
    managerLaneId: active.task.laneId,
    reviewTaskId: active.task.taskId,
    subject: active.task.subject,
    evidenceId: active.evidence.evidenceId,
    evidenceDigest: active.evidence.evidenceDigest,
    testEvidenceDigest: active.evidence.testEvidenceDigest,
    releaseArtifactDigest: active.evidence.releaseArtifactDigest,
    releaseManifestDigest: active.evidence.releaseManifestDigest,
    targetEnvironment: active.evidence.targetEnvironment,
    decision: active.decision,
  });
  return `manager-review:${createHash("sha256").update(binding).digest("hex")}`;
}

function sleepWithAbort(milliseconds: number, sleep: (milliseconds: number) => Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve(); else reject(error);
    };
    const onAbort = () => finish();
    signal.addEventListener("abort", onAbort, { once: true });
    void sleep(milliseconds).then(() => finish(), finish);
  });
}

export interface ManagerRuntimeSnapshot {
  readonly started: boolean;
  readonly runtimeEpoch: number;
  readonly desiredState: ManagerRuntimeState["desiredState"];
  readonly active: ActiveManagerReview | null;
  readonly queuedTasks: readonly AgentTaskProjection[];
  readonly currentAction: ManagerRuntimeState["currentAction"];
  readonly pendingEvents: number;
  readonly hasRuntimeGenerationProof: boolean;
}

export class ManagerRuntime {
  readonly #options: Required<Pick<ManagerRuntimeOptions, "maxReviewIterations" | "pollIntervalMs">> & ManagerRuntimeOptions;
  readonly #store: ManagerRuntimeStateStore;
  readonly #serial = new SerialExecutor();
  #state: ManagerRuntimeState;
  #runtimeGenerationProof: string | null = null;
  #stepController: AbortController | null = null;
  #started = false;
  #workInFlight = false;
  #nextLeaseRenewalAt = 0;

  private constructor(options: ManagerRuntimeOptions, store: ManagerRuntimeStateStore) {
    const maxReviewIterations = options.maxReviewIterations ?? 3;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    if (!Number.isSafeInteger(maxReviewIterations) || maxReviewIterations < 1 || maxReviewIterations > 10) {
      throw new Error("maxReviewIterations must be between 1 and 10");
    }
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 25 || pollIntervalMs > 60_000) {
      throw new Error("pollIntervalMs must be between 25 and 60000");
    }
    this.#options = { ...options, maxReviewIterations, pollIntervalMs };
    this.#store = store;
    this.#state = store.current;
  }

  static async create(options: ManagerRuntimeOptions): Promise<ManagerRuntime> {
    const store = await ManagerRuntimeStateStore.open(options.statePath, options.identity);
    return new ManagerRuntime(options, store);
  }

  get snapshot(): ManagerRuntimeSnapshot {
    return {
      started: this.#started,
      runtimeEpoch: this.#state.runtimeEpoch,
      desiredState: this.#state.desiredState,
      active: this.#state.active === null ? null : structuredClone(this.#state.active),
      queuedTasks: structuredClone(this.#state.queue),
      currentAction: this.#state.currentAction === null ? null : structuredClone(this.#state.currentAction),
      pendingEvents: this.#state.pendingEvents.length,
      hasRuntimeGenerationProof: this.#runtimeGenerationProof !== null,
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#started) return;
    const intent = await this.#serial.run(async () => {
      if (this.#state.registrationIntent !== null) return this.#state.registrationIntent;
      const registrationIntent = {
        request: {
          apiVersion: STEWARD_RUNTIME_API_VERSION,
          workspaceId: this.#options.identity.workspaceId as never,
          agentId: this.#options.identity.agentId as never,
          laneId: this.#options.identity.laneId as never,
          runtimeInstanceId: this.#options.identity.runtimeInstanceId as never,
          expectedRuntimeEpoch: this.#state.runtimeEpoch === 0 ? null : this.#state.runtimeEpoch,
          displayName: this.#options.identity.displayName,
          role: "manager" as const,
          capabilities: ROLE_CAPABILITIES.manager,
          provider: this.#options.identity.provider,
          softwareVersion: this.#options.identity.softwareVersion,
          checkpointRef: checkpoint(this.#state.active) as never,
        },
        runtimeProofChallenge: `rgc_${randomBytes(32).toString("base64url")}`,
      } as const;
      const next = { ...this.#state, registrationIntent };
      this.#state = next;
      await this.#store.save(next);
      return registrationIntent;
    });
    const registration = await this.#options.control.register(intent.request, {
      runtimeProofChallenge: intent.runtimeProofChallenge,
      replacementProof: this.#state.runtimeGenerationProof,
    }, signal);
    if (
      registration.workspaceId !== this.#options.identity.workspaceId ||
      registration.agentId !== this.#options.identity.agentId ||
      registration.laneId !== this.#options.identity.laneId ||
      registration.runtimeInstanceId !== intent.request.runtimeInstanceId ||
      registration.runtimeEpoch !== (intent.request.expectedRuntimeEpoch === null ? 1 : intent.request.expectedRuntimeEpoch + 1) ||
      !/^rgp_[A-Za-z0-9_-]{43}$/u.test(registration.runtimeGenerationProof)
    ) {
      throw new Error("Control plane returned an invalid manager registration session");
    }
    await this.#serial.run(async () => {
      const currentIntent = this.#state.registrationIntent;
      if (
        currentIntent === null ||
        JSON.stringify(currentIntent.request) !== JSON.stringify(intent.request) ||
        currentIntent.runtimeProofChallenge !== intent.runtimeProofChallenge
      ) {
        throw new Error("Manager registration intent changed while registration was in flight");
      }
      const pendingPayloads = this.#state.pendingEvents
        .filter((event) => event.localSequence > registration.lastAcceptedLocalSequence)
        .map((event) => event.payload);
      let nextLocalSequence = registration.lastAcceptedLocalSequence + 1;
      let next: ManagerRuntimeState = {
        ...this.#state,
        identity: { ...this.#state.identity, runtimeInstanceId: intent.request.runtimeInstanceId },
        runtimeEpoch: registration.runtimeEpoch,
        runtimeGenerationProof: registration.runtimeGenerationProof,
        registrationIntent: null,
        lease: {
          leaseId: registration.leaseId,
          leaseGrantedAt: registration.leaseGrantedAt,
          leaseExpiresAt: registration.leaseExpiresAt,
        },
        nextLocalSequence,
        pendingEvents: [],
      };
      for (const payload of pendingPayloads) {
        const result = this.#appendEvent(next, payload, nextLocalSequence);
        next = result.state;
        nextLocalSequence = result.nextSequence;
      }
      this.#state = next;
      await this.#store.save(next);
    });
    this.#runtimeGenerationProof = registration.runtimeGenerationProof;
    this.#nextLeaseRenewalAt = leaseRenewalDeadline(this.#state.lease);
    this.#started = true;
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.start(signal);
    await Promise.all([this.#controlLoop(signal), this.#workLoop(signal)]);
  }

  async #controlLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.controlOnce(signal);
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      await sleepWithAbort(this.#options.pollIntervalMs, this.#options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))), signal);
    }
  }

  async #workLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.workOnce();
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      await sleepWithAbort(this.#options.pollIntervalMs, this.#options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))), signal);
    }
  }

  async controlOnce(signal?: AbortSignal): Promise<void> {
    this.#assertStarted();
    await this.flushEvents(signal);
    const lease = this.#state.lease;
    if (lease === null) throw new Error("Manager runtime lease is missing");
    const now = (this.#options.now ?? (() => new Date()))();
    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("Manager runtime clock is invalid");
    if (now.valueOf() >= this.#nextLeaseRenewalAt) {
      const renewed = await this.#options.control.renewLease({
        apiVersion: STEWARD_RUNTIME_API_VERSION,
        workspaceId: this.#options.identity.workspaceId as never,
        agentId: this.#options.identity.agentId as never,
        laneId: this.#options.identity.laneId as never,
        runtimeInstanceId: this.#state.identity.runtimeInstanceId as never,
        runtimeEpoch: this.#state.runtimeEpoch,
        leaseId: lease.leaseId as never,
        lastDurableEventSequence: this.#state.nextLocalSequence - 1,
        sentAt: now.toISOString() as never,
      }, signal);
      if (renewed.runtimeEpoch !== this.#state.runtimeEpoch || renewed.leaseId !== lease.leaseId) {
        throw new Error("Control plane renewed another manager runtime lease");
      }
      await this.#serial.run(async () => {
        const next = {
          ...this.#state,
          lease: {
            leaseId: renewed.leaseId,
            leaseGrantedAt: renewed.leaseGrantedAt,
            leaseExpiresAt: renewed.leaseExpiresAt,
          },
        };
        this.#state = next;
        await this.#store.save(next);
      });
      this.#nextLeaseRenewalAt = leaseRenewalDeadline(this.#state.lease);
    }
    const result = await this.#options.control.pollCommands({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: this.#options.identity.workspaceId as never,
      agentId: this.#options.identity.agentId as never,
      laneId: this.#options.identity.laneId as never,
      runtimeInstanceId: this.#state.identity.runtimeInstanceId as never,
      runtimeEpoch: this.#state.runtimeEpoch,
      afterServerSequence: this.#state.lastServerSequence,
    }, signal);
    if (result.runtimeEpoch !== this.#state.runtimeEpoch || result.latestServerSequence < this.#state.lastServerSequence) {
      throw new Error("Control plane returned an invalid manager command cursor");
    }
    for (const command of result.commands) await this.handleCommand(command);
    await this.#serial.run(async () => {
      if (result.latestServerSequence > this.#state.lastServerSequence) {
        const next = { ...this.#state, lastServerSequence: result.latestServerSequence };
        this.#state = next;
        await this.#store.save(next);
      }
    });
    await this.flushEvents(signal);
  }

  async handleCommand(input: RuntimeCommandEnvelope): Promise<void> {
    const command = parseRuntimeCommandEnvelope(input);
    if (
      command.workspaceId !== this.#options.identity.workspaceId ||
      command.agentId !== this.#options.identity.agentId ||
      command.laneId !== this.#options.identity.laneId ||
      command.expectedRuntimeEpoch !== this.#state.runtimeEpoch
    ) {
      throw new Error("Manager command targets another runtime identity or epoch");
    }
    if (command.payload.type === "request_interrupt" || command.payload.type === "hold") {
      this.#stepController?.abort();
    }
    await this.#serial.run(async () => {
      if (command.serverSequence <= this.#state.lastServerSequence) return;
      let next = this.#state;
      switch (command.payload.type) {
        case "assign_task": {
          const task = command.payload.task;
          if (task.subject.type !== "manager_review") {
            next = this.#addEvent(next, {
              type: "task_failed",
              taskId: task.taskId,
              error: "Manager runtime accepts only manager_review tasks",
              retryable: false,
              checkpointRef: checkpoint(next.active) as never,
            });
            break;
          }
          const duplicate = next.active?.task.taskId === task.taskId ||
            next.queue.some((candidate) => candidate.taskId === task.taskId);
          if (!duplicate) next = { ...next, queue: [...next.queue, task] };
          break;
        }
        case "recover_task": {
          const task = command.payload.task;
          if (task.subject.type !== "manager_review") throw new Error("Cannot recover a non-review task");
          const filtered = next.queue.filter((candidate) => candidate.taskId !== task.taskId);
          const recovered = next.active !== null && taskKey(next.active.task) === taskKey(task)
            ? { ...next.active, task }
            : {
                task,
                phase: "locate" as const,
                iteration: 1,
                evidence: null,
                decision: null,
                progressMode: "suppress" as const,
              };
          next = {
            ...next,
            active: recovered,
            queue: filtered,
            currentAction: null,
          };
          break;
        }
        case "request_interrupt": {
          const activeTaskId = next.active?.task.taskId ?? null;
          next = this.#addEvent(next, {
            type: "interrupt_acknowledged",
            commandId: command.commandId,
            taskId: activeTaskId,
          });
          next = { ...next, desiredState: "paused", currentAction: null };
          next = this.#addEvent(next, {
            type: "interrupt_settled",
            commandId: command.commandId,
            taskId: activeTaskId,
            checkpointRef: checkpoint(next.active) as never,
          });
          next = this.#addEvent(next, {
            type: "heartbeat",
            currentAction: null,
            checkpointRef: checkpoint(next.active) as never,
          });
          break;
        }
        case "hold": {
          const activeTaskId = next.active?.task.taskId ?? null;
          next = this.#addEvent(next, { type: "hold_acknowledged", commandId: command.commandId, taskId: activeTaskId });
          next = { ...next, desiredState: "held", currentAction: null };
          next = this.#addEvent(next, {
            type: "hold_settled",
            commandId: command.commandId,
            taskId: activeTaskId,
            checkpointRef: checkpoint(next.active) as never,
          });
          next = this.#addEvent(next, {
            type: "heartbeat",
            currentAction: null,
            checkpointRef: checkpoint(next.active) as never,
          });
          break;
        }
        case "resume": {
          if (command.payload.taskId !== null && next.active?.task.taskId !== command.payload.taskId) {
            throw new Error("Resume command does not match the active manager task");
          }
          next = { ...next, desiredState: "active" };
          next = this.#addEvent(next, {
            type: "heartbeat",
            currentAction: null,
            checkpointRef: checkpoint(next.active) as never,
          });
          break;
        }
      }
      next = { ...next, lastServerSequence: command.serverSequence };
      this.#state = next;
      await this.#store.save(next);
    });
  }

  async workOnce(): Promise<void> {
    this.#assertStarted();
    if (this.#workInFlight) return;
    this.#workInFlight = true;
    try {
      const prepared = await this.#prepareWork();
      if (prepared === null) return;
      this.#stepController = new AbortController();
      if (prepared.active.phase === "locate") {
        await this.#locateEvidence(prepared, this.#stepController.signal);
      } else if (prepared.active.phase === "inspect") {
        await this.#inspectEvidence(prepared, this.#stepController.signal);
      } else {
        await this.#submitReview(prepared, this.#stepController.signal);
      }
    } finally {
      this.#stepController = null;
      this.#workInFlight = false;
    }
  }

  async #prepareWork(): Promise<PreparedWork | null> {
    return this.#serial.run(async () => {
      if (this.#state.desiredState !== "active") return null;
      let next = this.#state;
      if (next.active === null && next.queue.length > 0) {
        const [task, ...queue] = next.queue;
        if (task === undefined) return null;
        next = {
          ...next,
          queue,
          active: { task, phase: "locate", iteration: 1, evidence: null, decision: null, progressMode: "emit" },
        };
      }
      if (next.active === null) {
        if (next !== this.#state) {
          this.#state = next;
          await this.#store.save(next);
        }
        return null;
      }
      const active = next.active;
      const summaries = {
        locate: "Locating exact immutable passing evidence",
        inspect: `Inspecting evidence read-only (iteration ${active.iteration})`,
        submit: "Recording the manager review decision",
      } as const;
      const currentAction = {
        taskId: active.task.taskId,
        summary: summaries[active.phase],
        startedAt: nowIso(this.#options.now ?? (() => new Date())),
      };
      next = { ...next, currentAction };
      next = this.#addEvent(next, {
        type: "heartbeat",
        currentAction: currentAction as never,
        checkpointRef: checkpoint(next.active) as never,
      });
      this.#state = next;
      await this.#store.save(next);
      return { active: structuredClone(active), claim: this.#claim() };
    });
  }

  async #locateEvidence(prepared: PreparedWork, signal: AbortSignal): Promise<void> {
    const subject = prepared.active.task.subject;
    if (subject.type !== "manager_review") throw new Error("Active manager task has the wrong subject");
    const queue = await this.#options.reviews.listQueue(prepared.claim, signal);
    const evidence = queue.find((candidate) =>
      candidate.workspaceId === prepared.active.task.workspaceId &&
      candidate.taskId === subject.sourceTaskId &&
      candidate.evidenceId === subject.evidenceId &&
      candidate.evidenceDigest === subject.evidenceDigest &&
      candidate.testOutcome === "passed"
    );
    if (evidence === undefined) {
      await this.#clearActionIfCurrent(prepared.active);
      return;
    }
    await this.#serial.run(async () => {
      if (!this.#isCurrent(prepared.active) || this.#state.desiredState !== "active") return;
      let next: ManagerRuntimeState = {
        ...this.#state,
        active: { ...prepared.active, phase: "inspect", evidence, decision: null },
        currentAction: null,
      };
      if (prepared.active.progressMode === "emit") {
        next = this.#addProgress(next, prepared.active.task, "research", prepared.active.iteration, "Located the exact immutable passing evidence and source task.");
        next = this.#addProgress(next, prepared.active.task, "plan", prepared.active.iteration, "Will compare the read-only inspection against the evidence, test, artifact, and manifest digests.");
      }
      next = this.#addEvent(next, { type: "heartbeat", currentAction: null, checkpointRef: checkpoint(next.active) as never });
      this.#state = next;
      await this.#store.save(next);
    });
  }

  async #inspectEvidence(prepared: PreparedWork, signal: AbortSignal): Promise<void> {
    const evidence = prepared.active.evidence;
    if (evidence === null) throw new Error("Inspection phase has no evidence");
    let result: ReturnType<typeof parseInspectionResult> | null = null;
    let inspectionError = false;
    try {
      result = parseInspectionResult(await this.#options.inspector.inspect({
        task: prepared.active.task,
        evidence,
        iteration: prepared.active.iteration,
      }, signal));
    } catch (error) {
      if (signal.aborted) return;
      inspectionError = true;
    }
    await this.#serial.run(async () => {
      if (!this.#isCurrent(prepared.active) || this.#state.desiredState !== "active") return;
      const exact = result !== null &&
        result.evidenceDigest === evidence.evidenceDigest &&
        result.testEvidenceDigest === evidence.testEvidenceDigest &&
        result.releaseArtifactDigest === evidence.releaseArtifactDigest &&
        result.releaseManifestDigest === evidence.releaseManifestDigest;
      const reachedLimit = prepared.active.iteration >= this.#options.maxReviewIterations;
      let next: ManagerRuntimeState = { ...this.#state, currentAction: null };
      if (prepared.active.progressMode === "emit") {
        next = this.#addProgress(
          next,
          prepared.active.task,
          "execute",
          prepared.active.iteration,
          exact && result !== null ? boundedJournal(result.summary) : "Read-only inspection could not verify the exact immutable evidence binding.",
        );
      }
      if (!inspectionError && exact && result?.state === "continue" && !reachedLimit) {
        if (prepared.active.progressMode === "emit") {
          next = this.#addProgress(next, prepared.active.task, "test", prepared.active.iteration, "Review evidence needs another bounded inspection pass.", "failed");
        }
        const iteration = prepared.active.iteration + 1;
        const active: ActiveManagerReview = { ...prepared.active, iteration };
        next = { ...next, active };
        if (prepared.active.progressMode === "emit") {
          next = this.#addProgress(next, prepared.active.task, "research", iteration, "Rechecking the immutable evidence after an inconclusive review pass.");
          next = this.#addProgress(next, prepared.active.task, "plan", iteration, "Will repeat the bounded read-only evidence comparison.");
        }
      } else {
        const decision: StoredDecision = exact && result !== null && result.state !== "continue"
          ? {
              decision: result.state,
              summary: boundedJournal(result.summary),
              remainingRisks: boundedJournal(result.remainingRisks),
            }
          : {
              decision: "changes_requested",
              summary: "The manager could not verify the exact immutable passing evidence.",
              remainingRisks: "Evidence, test, artifact, or frozen release-manifest binding remains unverified.",
            };
        if (prepared.active.progressMode === "emit") {
          next = this.#addProgress(next, prepared.active.task, "test", prepared.active.iteration, "Manager review procedure reached a bounded decision.", "passed");
        }
        next = { ...next, active: { ...prepared.active, phase: "submit", decision } };
      }
      next = this.#addEvent(next, { type: "heartbeat", currentAction: null, checkpointRef: checkpoint(next.active) as never });
      this.#state = next;
      await this.#store.save(next);
    });
  }

  async #submitReview(prepared: PreparedWork, signal: AbortSignal): Promise<void> {
    const evidence = prepared.active.evidence;
    const decision = prepared.active.decision;
    if (evidence === null || decision === null) throw new Error("Submit phase is incomplete");
    // Manager-review owns the atomic control-plane completion. Flush the visible
    // action first so operators can see what the runtime is doing before the permit.
    await this.flushEvents(signal);
    const receipt = await this.#options.reviews.recordReview(
      prepared.claim,
      evidence.evidenceId,
      {
        reviewTaskId: prepared.active.task.taskId,
        evidenceDigest: evidence.evidenceDigest,
        decision: decision.decision,
        summary: decision.summary,
        remainingRisks: decision.remainingRisks,
      },
      reviewIdempotency(prepared.active),
      signal,
    );
    if (
      receipt.reviewTaskId !== prepared.active.task.taskId ||
      receipt.evidenceId !== evidence.evidenceId ||
      receipt.evidenceDigest !== evidence.evidenceDigest ||
      receipt.decision !== decision.decision
    ) {
      throw new Error("Manager review receipt does not match the active review");
    }
    await this.#serial.run(async () => {
      if (!this.#isCurrent(prepared.active) || this.#state.desiredState !== "active") return;
      let next: ManagerRuntimeState = { ...this.#state, active: null, currentAction: null };
      next = this.#addEvent(next, { type: "heartbeat", currentAction: null, checkpointRef: null });
      this.#state = next;
      await this.#store.save(next);
    });
  }

  async #clearActionIfCurrent(active: ActiveManagerReview): Promise<void> {
    await this.#serial.run(async () => {
      if (!this.#isCurrent(active)) return;
      let next: ManagerRuntimeState = { ...this.#state, currentAction: null };
      next = this.#addEvent(next, { type: "heartbeat", currentAction: null, checkpointRef: checkpoint(next.active) as never });
      this.#state = next;
      await this.#store.save(next);
    });
  }

  async flushEvents(signal?: AbortSignal): Promise<void> {
    this.#assertStarted();
    const events = this.#state.pendingEvents;
    if (events.length === 0) return;
    const receipt = await this.#options.control.uploadEvents(parseRuntimeEventBatch({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      workspaceId: this.#options.identity.workspaceId,
      agentId: this.#options.identity.agentId,
      laneId: this.#options.identity.laneId,
      runtimeInstanceId: this.#state.identity.runtimeInstanceId,
      runtimeEpoch: this.#state.runtimeEpoch,
      events,
    }), signal);
    if (receipt.runtimeEpoch !== this.#state.runtimeEpoch) throw new Error("Event receipt belongs to another runtime epoch");
    await this.#serial.run(async () => {
      const next = {
        ...this.#state,
        pendingEvents: this.#state.pendingEvents.filter((event) => event.localSequence > receipt.acceptedThroughLocalSequence),
      };
      this.#state = next;
      await this.#store.save(next);
    });
  }

  #claim(): ManagerRuntimeClaim {
    if (this.#runtimeGenerationProof === null) throw new Error("Manager runtime generation proof is unavailable");
    return {
      workspaceId: this.#options.identity.workspaceId,
      agentId: this.#options.identity.agentId,
      laneId: this.#options.identity.laneId,
      runtimeInstanceId: this.#state.identity.runtimeInstanceId,
      runtimeEpoch: this.#state.runtimeEpoch,
      runtimeGenerationProof: this.#runtimeGenerationProof,
    };
  }

  #addProgress(
    state: ManagerRuntimeState,
    task: AgentTaskProjection,
    phase: "research" | "plan" | "execute" | "test",
    iteration: number,
    journal: string,
    outcome?: "passed" | "failed",
  ): ManagerRuntimeState {
    return this.#addEvent(state, {
      type: "progress",
      taskId: task.taskId,
      phase,
      iteration,
      journal: boundedJournal(journal),
      ...(phase === "test" ? { outcome: outcome ?? "failed" } : {}),
    } as DurableOutboxPayload);
  }

  #addEvent(state: ManagerRuntimeState, payload: DurableOutboxPayload): ManagerRuntimeState {
    return this.#appendEvent(state, payload, state.nextLocalSequence).state;
  }

  #appendEvent(
    state: ManagerRuntimeState,
    payload: DurableOutboxPayload,
    sequence: number,
  ): { state: ManagerRuntimeState; nextSequence: number } {
    const event = parseDurableOutboxEvent({
      apiVersion: STEWARD_RUNTIME_API_VERSION,
      eventId: randomUUID(),
      workspaceId: this.#options.identity.workspaceId,
      agentId: this.#options.identity.agentId,
      laneId: this.#options.identity.laneId,
      runtimeInstanceId: state.identity.runtimeInstanceId,
      localSequence: sequence,
      runtimeEpoch: state.runtimeEpoch,
      occurredAt: nowIso(this.#options.now ?? (() => new Date())),
      payload,
    });
    const nextSequence = sequence + 1;
    return {
      state: { ...state, nextLocalSequence: nextSequence, pendingEvents: [...state.pendingEvents, event] },
      nextSequence,
    };
  }

  #isCurrent(active: ActiveManagerReview): boolean {
    return this.#state.active !== null &&
      taskKey(this.#state.active.task) === taskKey(active.task) &&
      this.#state.active.phase === active.phase &&
      this.#state.active.iteration === active.iteration;
  }

  #assertStarted(): void {
    if (!this.#started) throw new Error("Manager runtime is not started");
  }

  async close(): Promise<void> {
    this.#stepController?.abort();
    await this.#serial.idle();
    await this.#store.close();
    this.#runtimeGenerationProof = null;
    this.#started = false;
  }
}
