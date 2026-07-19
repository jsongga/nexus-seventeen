import { createHash } from "node:crypto";
import {
  parseUiBootstrap,
  parseUiEventEnvelope,
  type AgentTaskProjection,
  type IsoTimestamp,
  type ProgressEvent,
  type TaskId,
  type TaskStatus,
  type UiBootstrap,
  type UiEventEnvelope,
  type WorkspaceId,
} from "@cicada/steward-protocol";
import type {
  ModelRouteDecision,
  ModelRouter,
  RouteDecision,
} from "@cicada/steward-model-routing";
import { buildImpactModelRequest, sanitizePublicSummary, sanitizeSourceText } from "./redaction.js";
import {
  IMPACT_API_VERSION,
  IMPACT_ROUTING_API_VERSION,
  type ImpactModelInvocation,
  type ImpactObserverLimits,
  type ImpactRouteAudit,
  type ImpactRoutingSnapshot,
  type ImpactSummary,
  type ImpactSummarySnapshot,
  type StoredImpactSummary,
  type WeakImpactModelAdapter,
} from "./types.js";

export interface ImpactSummaryPersistence {
  load(): Promise<readonly StoredImpactSummary[]>;
  save(input: {
    readonly sourceSequence: number;
    readonly updatedAt: IsoTimestamp;
    readonly summaries: readonly StoredImpactSummary[];
  }): Promise<void>;
  flush(): Promise<void>;
}

interface TrackedTask {
  readonly taskId: TaskId;
  title: string;
  objective: string;
  status: TaskStatus;
  updates: string[];
  touchedAtSequence: number;
}

export interface ImpactFlushResult {
  readonly summarized: number;
  readonly failed: number;
}

export class ImpactCursorError extends Error {
  readonly expected: number;
  readonly received: number;

  constructor(expected: number, received: number) {
    super(`Impact event cursor gap: expected ${expected}, received ${received}`);
    this.name = "ImpactCursorError";
    this.expected = expected;
    this.received = received;
  }
}

function isoNow(now: () => Date): IsoTimestamp {
  return now().toISOString() as IsoTimestamp;
}

const NO_TOOLS = Object.freeze([]) as readonly [];

function progressUpdate(progress: ProgressEvent, maximumCharacters: number): string {
  const journal = sanitizeSourceText(progress.journal, maximumCharacters);
  if (progress.phase === "test") {
    const result = progress.outcome === "passed" ? "Latest checks passed" : "Latest checks found more work";
    return `${result}. ${journal}`;
  }
  const phase = progress.phase === "research" ? "Understanding the request" : progress.phase === "plan" ? "Approach prepared" : "Improvement in progress";
  return `${phase}. ${journal}`;
}

function taskRank(task: AgentTaskProjection): number {
  return task.status === "running" || task.status === "paused" || task.status === "queued" ? 0 : 1;
}

function selectTasks(tasks: readonly AgentTaskProjection[], maximum: number): readonly AgentTaskProjection[] {
  if (tasks.length <= maximum) return tasks;
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => taskRank(left.task) - taskRank(right.task) || right.index - left.index)
    .slice(0, maximum)
    .sort((left, right) => left.index - right.index)
    .map(({ task }) => task);
}

export class ImpactObserver {
  readonly #workspaceId: WorkspaceId;
  readonly #model: WeakImpactModelAdapter;
  readonly #router: ModelRouter;
  readonly #persistence: ImpactSummaryPersistence;
  readonly #limits: ImpactObserverLimits;
  readonly #now: () => Date;
  readonly #tasks = new Map<TaskId, TrackedTask>();
  readonly #summaries = new Map<TaskId, StoredImpactSummary>();
  readonly #routes = new Map<TaskId, ImpactRouteAudit>();
  readonly #dirty = new Set<TaskId>();
  #cursor = 0;
  #restored = false;
  #flushPromise: Promise<ImpactFlushResult> | undefined;

  constructor(options: {
    readonly workspaceId: WorkspaceId;
    readonly model: WeakImpactModelAdapter;
    readonly router: ModelRouter;
    readonly persistence: ImpactSummaryPersistence;
    readonly limits: ImpactObserverLimits;
    readonly now?: () => Date;
  }) {
    this.#workspaceId = options.workspaceId;
    this.#model = options.model;
    this.#router = options.router;
    this.#persistence = options.persistence;
    this.#limits = options.limits;
    this.#now = options.now ?? (() => new Date());
  }

  get cursor(): number {
    return this.#cursor;
  }

  get trackedTaskCount(): number {
    return this.#tasks.size;
  }

  async restore(): Promise<void> {
    if (this.#restored) return;
    const summaries = await this.#persistence.load();
    for (const summary of summaries) this.#summaries.set(summary.taskId, structuredClone(summary));
    this.#pruneSummaries();
    this.#restored = true;
  }

  acceptBootstrap(input: UiBootstrap): void {
    if (!this.#restored) throw new Error("Impact observer must restore durable summaries before bootstrap");
    const bootstrap = parseUiBootstrap(input);
    if (bootstrap.snapshot.workspaceId !== this.#workspaceId) {
      throw new Error("Impact bootstrap belongs to another workspace");
    }
    this.#cursor = bootstrap.snapshot.sequence;
    this.#tasks.clear();
    this.#dirty.clear();

    const selected = selectTasks(bootstrap.snapshot.tasks, this.#limits.maxTrackedTasks);
    const selectedIds = new Set(selected.map((task) => task.taskId));
    for (const taskId of this.#routes.keys()) {
      if (!selectedIds.has(taskId)) this.#routes.delete(taskId);
    }
    for (const task of selected) this.#upsertTask(task, this.#cursor, false);
    for (const progress of bootstrap.snapshot.progress) {
      if (!selectedIds.has(progress.taskId)) continue;
      this.#appendProgress(progress, false);
    }
    for (const taskId of this.#tasks.keys()) this.#markIfChanged(taskId);
  }

  acceptEvent(input: UiEventEnvelope): void {
    const event = parseUiEventEnvelope(input);
    if (event.workspaceId !== this.#workspaceId) throw new Error("Impact event belongs to another workspace");
    const expected = this.#cursor + 1;
    if (event.sequence !== expected) throw new ImpactCursorError(expected, event.sequence);
    this.#cursor = event.sequence;

    switch (event.payload.type) {
      case "task_upserted":
        this.#upsertTask(event.payload.task, event.sequence, true);
        break;
      case "progress_recorded":
        this.#upsertTask(event.payload.task, event.sequence, false);
        this.#appendProgress(event.payload.progress, true);
        break;
      case "agent_runtime_updated":
        if (event.payload.task !== null) this.#upsertTask(event.payload.task, event.sequence, true);
        break;
      case "agent_upserted":
      case "agent_removed":
      case "workspace_control_updated":
        break;
    }
  }

  summaries(): readonly ImpactSummary[] {
    return Object.freeze(
      [...this.#summaries.values()].map(({ sourceFingerprint: _sourceFingerprint, ...summary }) =>
        Object.freeze(structuredClone(summary)),
      ),
    );
  }

  snapshot(): ImpactSummarySnapshot {
    return Object.freeze({
      apiVersion: IMPACT_API_VERSION,
      workspaceId: this.#workspaceId,
      generatedAt: isoNow(this.#now),
      sourceSequence: this.#cursor,
      summaries: this.summaries(),
    });
  }

  routingSnapshot(): ImpactRoutingSnapshot {
    return Object.freeze({
      apiVersion: IMPACT_ROUTING_API_VERSION,
      workspaceId: this.#workspaceId,
      generatedAt: isoNow(this.#now),
      sourceSequence: this.#cursor,
      routes: Object.freeze([...this.#routes.values()]),
    });
  }

  flush(signal?: AbortSignal): Promise<ImpactFlushResult> {
    if (this.#flushPromise !== undefined) return this.#flushPromise;
    const operation = this.#drain(signal);
    this.#flushPromise = operation;
    void operation.then(
      () => { if (this.#flushPromise === operation) this.#flushPromise = undefined; },
      () => { if (this.#flushPromise === operation) this.#flushPromise = undefined; },
    );
    return operation;
  }

  async close(): Promise<void> {
    await this.#flushPromise;
    await this.#persistence.flush();
    await this.#model.close?.();
  }

  #upsertTask(task: AgentTaskProjection, sequence: number, mark: boolean): void {
    const existing = this.#tasks.get(task.taskId);
    if (existing === undefined) {
      this.#makeRoomForTask();
      this.#tasks.set(task.taskId, {
        taskId: task.taskId,
        title: sanitizeSourceText(task.title, this.#limits.maxSourceChars),
        objective: sanitizeSourceText(task.objective, this.#limits.maxSourceChars),
        status: task.status,
        updates: [],
        touchedAtSequence: sequence,
      });
    } else {
      existing.title = sanitizeSourceText(task.title, this.#limits.maxSourceChars);
      existing.objective = sanitizeSourceText(task.objective, this.#limits.maxSourceChars);
      existing.status = task.status;
      existing.touchedAtSequence = sequence;
    }
    if (mark) this.#markIfChanged(task.taskId);
  }

  #appendProgress(progress: ProgressEvent, mark: boolean): void {
    const task = this.#tasks.get(progress.taskId);
    if (task === undefined) return;
    task.updates.push(progressUpdate(progress, this.#limits.maxSourceChars));
    if (task.updates.length > this.#limits.maxProgressEntriesPerTask) {
      task.updates.splice(0, task.updates.length - this.#limits.maxProgressEntriesPerTask);
    }
    task.touchedAtSequence = this.#cursor;
    if (mark) this.#markIfChanged(progress.taskId);
  }

  #makeRoomForTask(): void {
    if (this.#tasks.size < this.#limits.maxTrackedTasks) return;
    const entries = [...this.#tasks.values()];
    const candidate = entries
      .filter((task) => task.status === "completed" || task.status === "failed")
      .sort((left, right) => left.touchedAtSequence - right.touchedAtSequence)[0]
      ?? entries.sort((left, right) => left.touchedAtSequence - right.touchedAtSequence)[0];
    if (candidate !== undefined) {
      this.#tasks.delete(candidate.taskId);
      this.#dirty.delete(candidate.taskId);
      this.#routes.delete(candidate.taskId);
    }
  }

  #modelRequest(task: TrackedTask) {
    return buildImpactModelRequest(
      {
        title: task.title,
        objective: task.objective,
        status: task.status,
        recentUpdates: task.updates,
      },
      this.#limits,
    );
  }

  #fingerprint(task: TrackedTask): string {
    const request = this.#modelRequest(task);
    return createHash("sha256")
      .update(JSON.stringify({ instruction: request.instruction, task: request.task }))
      .digest("hex");
  }

  #markIfChanged(taskId: TaskId): void {
    const task = this.#tasks.get(taskId);
    if (task === undefined) return;
    if (this.#summaries.get(taskId)?.sourceFingerprint !== this.#fingerprint(task)) this.#dirty.add(taskId);
  }

  #pruneSummaries(): void {
    while (this.#summaries.size > this.#limits.maxTrackedTasks) {
      const oldest = this.#summaries.keys().next().value as TaskId | undefined;
      if (oldest === undefined) break;
      this.#summaries.delete(oldest);
    }
  }

  #recordRoute(taskId: TaskId, decision: RouteDecision): void {
    const audit: ImpactRouteAudit = Object.freeze({
      taskId,
      sourceSequence: this.#cursor,
      routedAt: isoNow(this.#now),
      decision,
      tools: NO_TOOLS,
    });
    this.#routes.delete(taskId);
    this.#routes.set(taskId, audit);
    while (this.#routes.size > this.#limits.maxTrackedTasks) {
      const oldest = this.#routes.keys().next().value as TaskId | undefined;
      if (oldest === undefined) break;
      this.#routes.delete(oldest);
    }
  }

  #route(request: ReturnType<typeof buildImpactModelRequest>): RouteDecision {
    return this.#router.route({
      role: "impact_observer",
      phase: "summarize",
      purpose: "development",
      complexity: "low",
      risk: "low",
      context: Object.freeze({
        estimatedInputTokens: request.estimatedInputTokens,
        reservedOutputTokens: request.maxOutputTokens,
        maximumTurnTokens: this.#limits.maxInputTokens + this.#limits.maxOutputTokens,
      }),
      priorFailedTests: 0,
    });
  }

  #invocation(
    request: ReturnType<typeof buildImpactModelRequest>,
    decision: ModelRouteDecision,
  ): ImpactModelInvocation {
    return Object.freeze({
      ...request,
      route: decision,
      tools: NO_TOOLS,
    });
  }

  async #persist(): Promise<void> {
    await this.#persistence.save({
      sourceSequence: this.#cursor,
      updatedAt: isoNow(this.#now),
      summaries: Object.freeze([...this.#summaries.values()].map((summary) => structuredClone(summary))),
    });
  }

  async #drain(signal?: AbortSignal): Promise<ImpactFlushResult> {
    let summarized = 0;
    let failed = 0;
    while (this.#dirty.size > 0) {
      if (signal?.aborted) throw signal.reason;
      const taskId = this.#dirty.values().next().value as TaskId | undefined;
      if (taskId === undefined) break;
      this.#dirty.delete(taskId);
      const task = this.#tasks.get(taskId);
      if (task === undefined) continue;
      const fingerprint = this.#fingerprint(task);
      if (this.#summaries.get(taskId)?.sourceFingerprint === fingerprint) continue;
      const request = this.#modelRequest(task);
      const decision = this.#route(request);
      this.#recordRoute(taskId, decision);
      if (
        decision.disposition !== "model" ||
        decision.request.role !== "impact_observer" ||
        decision.request.phase !== "summarize" ||
        decision.provider !== "claude" ||
        decision.baselineTier !== "economy" ||
        decision.selectedTier !== "economy" ||
        decision.authority.modelMayApproveProduction !== false ||
        decision.authority.modelMayDeployToProduction !== false
      ) {
        failed += 1;
        continue;
      }
      let result;
      try {
        result = await this.#model.summarize(this.#invocation(request, decision), signal);
      } catch {
        if (signal?.aborted) throw signal.reason;
        failed += 1;
        continue;
      }
      const current = this.#tasks.get(taskId);
      if (current === undefined) continue;
      if (this.#fingerprint(current) !== fingerprint) {
        this.#dirty.add(taskId);
        continue;
      }
      if (typeof result !== "object" || result === null || typeof result.text !== "string") {
        failed += 1;
        continue;
      }
      const summary = sanitizePublicSummary(
        result.text,
        current.status,
        Math.min(this.#limits.maxSummaryChars, this.#limits.maxOutputTokens * 4),
      );
      const record: StoredImpactSummary = Object.freeze({
        taskId,
        status: current.status,
        summary,
        updatedAt: isoNow(this.#now),
        sourceSequence: this.#cursor,
        sourceFingerprint: fingerprint,
      });
      this.#summaries.delete(taskId);
      this.#summaries.set(taskId, record);
      this.#pruneSummaries();
      await this.#persist();
      summarized += 1;
    }
    return Object.freeze({ summarized, failed });
  }
}
