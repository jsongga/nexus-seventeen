import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentLaunchRequest,
  AgentLauncher,
  AgentRunHandle,
  AgentRunInterrupt,
  AgentRunOutcome,
  AgentTaskPhase,
  AppendRunOutputRequest,
  BoundedAgentContext,
  ClaimedAgentRun,
  ClaimNextWakeRequest,
  CreateAgentTaskPhaseRequest,
  SettleAgentRunRequest,
  TaskBoardClient,
  TaskWakeClaim,
  UpdateAgentTaskPhaseRequest,
  UpdateTaskEstimateRequest,
} from "#server/agents/task-worker/types";

export const NOW = "2026-07-19T20:00:00.000Z";
export const PROJECT = "project-one";
export const AGENT = "engineer-one";
export const TASK = "task-one";
export const WAKE = "wake-one";
export const RUN = "run-one";

export async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "steward-task-worker-"));
}

export function context(overrides: Partial<BoundedAgentContext> = {}): BoundedAgentContext {
  return {
    apiVersion: 1,
    projectId: PROJECT,
    agentId: AGENT,
    taskId: TASK,
    mission: {
      role: "engineer",
      area: "Checkout reliability",
      mission: "Prevent duplicate customer charges while keeping human control over production.",
    },
    projectMemory: "The checkout service uses idempotency keys and has a focused test suite.",
    task: {
      kind: "work",
      requiredRole: null,
      title: "Prevent duplicate checkout submission",
      objective: "Make repeated submission safe for customers.",
      acceptanceCriteria: "A repeated request creates one charge and the focused tests pass.",
      version: 1,
      expectedAgentMinutes: null,
      phases: [],
    },
    areaMemory: [{
      taskId: "task-prior",
      title: "Trace the retry boundary",
      result: "The prior task located the customer-visible retry failure.",
      endedAt: NOW,
    }],
    parentEvidence: {
      taskId: "task-parent",
      title: "Identify the highest-impact checkout risk",
      objective: "Find the checkout failure that harms customers most.",
      acceptanceCriteria: "The risk and supporting evidence are recorded.",
      status: "completed",
      assignedAgentId: AGENT,
      workspaceRefs: ["repo:checkout"],
      startedAt: NOW,
      endedAt: NOW,
      result: "Retries are the highest-impact customer risk.",
      messages: [{
        messageId: "parent-progress-one",
        author: "agent",
        kind: "progress",
        body: "Retry evidence was confirmed by the focused tests.",
        createdAt: NOW,
      }],
    },
    messagesSinceCursor: null,
    nextMessageCursor: 2,
    messages: [
      {
        messageId: "message-one",
        cursor: 1,
        author: "human",
        body: "Keep this scoped to checkout retries.",
        createdAt: NOW,
      },
      {
        messageId: "message-two",
        cursor: 2,
        author: "agent",
        body: "Prior research found the charge creation boundary.",
        createdAt: NOW,
      },
    ],
    triggerQuestion: null,
    openQuestions: [],
    workspaceRefs: ["repo:checkout", "path:services/checkout"],
    ...overrides,
  };
}

export function claimed(
  request: ClaimNextWakeRequest,
  options: Readonly<{
    reason?: string;
    runId?: string;
    wakeupId?: string;
    taskId?: string | null;
    context?: BoundedAgentContext | null;
  }> = {},
): ClaimedAgentRun {
  const taskId = options.taskId === undefined ? TASK : options.taskId;
  const messageCursor = taskId === null ? null : request.messageCursors[taskId] ?? null;
  const boundedContext = options.context === undefined
    ? (taskId === null ? null : context(messageCursor === null
        ? { messagesSinceCursor: null }
        : { messagesSinceCursor: messageCursor, nextMessageCursor: messageCursor, messages: [] }))
    : options.context;
  return {
    claim: {
      apiVersion: 1,
      claimId: request.claimId,
      runId: options.runId ?? RUN,
      wakeupId: options.wakeupId ?? WAKE,
      projectId: PROJECT,
      agentId: AGENT,
      taskId,
      reason: options.reason ?? "human_assignment",
      requestedMessageCursor: messageCursor,
      claimedAt: NOW,
    },
    context: boundedContext,
  };
}

export function completedOutcome(label = "Customers can retry checkout safely."): AgentRunOutcome {
  return {
    status: "completed",
    outputs: [
      { type: "progress", body: "The assigned checks now pass." },
      {
        type: "proposed_child_task",
        title: "Observe retry rate",
        objective: "Confirm retry behavior remains healthy after a human-approved release.",
        acceptanceCriteria: ["Retry rate is visible to operators."],
      },
      { type: "result", body: label },
    ],
    expectedAgentMinutes: null,
    phases: [],
    detail: label,
  };
}

export class FakeBoard implements TaskBoardClient {
  readonly claimRequests: ClaimNextWakeRequest[] = [];
  readonly appendAttempts: AppendRunOutputRequest[] = [];
  readonly outputs: AppendRunOutputRequest[] = [];
  readonly settlements: SettleAgentRunRequest[] = [];
  readonly estimateUpdates: UpdateTaskEstimateRequest[] = [];
  readonly phaseCreates: CreateAgentTaskPhaseRequest[] = [];
  readonly phaseUpdates: UpdateAgentTaskPhaseRequest[] = [];
  readonly #claimed = new Map<string, ClaimedAgentRun>();
  readonly #waiters = new Map<string, (value: AgentRunInterrupt | null) => void>();
  readonly queued: Array<(request: ClaimNextWakeRequest) => ClaimedAgentRun> = [];
  claimFailures = 0;
  appendFailures = 0;
  estimateFailures = 0;
  phaseCreateBarrier: Promise<void> | null = null;
  #phaseSequence = 0;

  claimNextWake(request: ClaimNextWakeRequest): Promise<ClaimedAgentRun | null> {
    this.claimRequests.push(structuredClone(request));
    let result = this.#claimed.get(request.claimId);
    if (result === undefined) {
      const factory = this.queued.shift();
      if (factory === undefined) return Promise.resolve(null);
      result = factory(request);
      this.#claimed.set(request.claimId, structuredClone(result));
    }
    if (this.claimFailures > 0) {
      this.claimFailures -= 1;
      return Promise.reject(new Error("Simulated lost claim response"));
    }
    return Promise.resolve(structuredClone(result));
  }

  waitForRunInterrupt(claim: TaskWakeClaim, signal?: AbortSignal): Promise<AgentRunInterrupt | null> {
    return new Promise((resolve) => {
      const finish = (value: AgentRunInterrupt | null): void => {
        signal?.removeEventListener("abort", abort);
        this.#waiters.delete(claim.runId);
        resolve(value);
      };
      const abort = () => finish(null);
      if (signal?.aborted) { resolve(null); return; }
      signal?.addEventListener("abort", abort, { once: true });
      this.#waiters.set(claim.runId, finish);
    });
  }

  requestInterrupt(claim: TaskWakeClaim, reason: string): void {
    this.#waiters.get(claim.runId)?.({
      sequence: 1,
      interruptId: "interrupt-one",
      projectId: claim.projectId,
      agentId: claim.agentId,
      runId: claim.runId,
      reason,
      requestedAt: NOW,
    });
  }

  updateTaskEstimate(request: UpdateTaskEstimateRequest): Promise<number> {
    this.estimateUpdates.push(structuredClone(request));
    if (this.estimateFailures > 0) {
      this.estimateFailures -= 1;
      return Promise.reject(new Error("Simulated task version conflict"));
    }
    return Promise.resolve(request.version + 1);
  }

  async createTaskPhase(request: CreateAgentTaskPhaseRequest): Promise<AgentTaskPhase> {
    this.phaseCreates.push(structuredClone(request));
    await this.phaseCreateBarrier;
    this.#phaseSequence += 1;
    return {
      phaseId: `phase-${this.#phaseSequence}`,
      title: request.title,
      stage: request.stage,
      status: "pending",
      parallelGroup: request.parallelGroup,
      orderKey: this.#phaseSequence * 1_024,
      version: 1,
    };
  }

  updateTaskPhase(request: UpdateAgentTaskPhaseRequest): Promise<AgentTaskPhase> {
    this.phaseUpdates.push(structuredClone(request));
    return Promise.resolve({
      ...request.phase,
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.stage === undefined ? {} : { stage: request.stage }),
      ...(request.status === undefined ? {} : { status: request.status }),
      ...("parallelGroup" in request ? { parallelGroup: request.parallelGroup ?? null } : {}),
      ...(request.orderKey === undefined ? {} : { orderKey: request.orderKey }),
      version: request.phase.version + 1,
    });
  }

  appendRunOutput(request: AppendRunOutputRequest): Promise<void> {
    this.appendAttempts.push(structuredClone(request));
    if (this.appendFailures > 0) {
      this.appendFailures -= 1;
      return Promise.reject(new Error("Simulated lost output response"));
    }
    const prior = this.outputs.find((item) => item.idempotencyKey === request.idempotencyKey);
    if (prior === undefined) this.outputs.push(structuredClone(request));
    else if (JSON.stringify(prior) !== JSON.stringify(request)) return Promise.reject(new Error("Output idempotency conflict"));
    return Promise.resolve();
  }

  settleAgentRun(request: SettleAgentRunRequest): Promise<void> {
    const prior = this.settlements.find((item) => item.claim.runId === request.claim.runId);
    if (prior === undefined) this.settlements.push(structuredClone(request));
    else if (JSON.stringify(prior) !== JSON.stringify(request)) return Promise.reject(new Error("Settlement conflict"));
    return Promise.resolve();
  }
}

export class DeferredRunHandle implements AgentRunHandle {
  readonly completion: Promise<AgentRunOutcome>;
  readonly activity: AsyncIterable<string>;
  interruptReasons: string[] = [];
  readonly #activityQueued: string[] = [];
  readonly #activityWaiters: Array<(result: IteratorResult<string>) => void> = [];
  #activityClosed = false;
  #resolve!: (value: AgentRunOutcome) => void;
  #reject!: (error: unknown) => void;

  constructor() {
    this.completion = new Promise<AgentRunOutcome>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.activity = {
      [Symbol.asyncIterator]: () => ({ next: () => this.#nextActivity() }),
    };
  }

  emitActivity(value: string): void {
    if (this.#activityClosed) throw new Error("Activity stream is closed");
    const waiter = this.#activityWaiters.shift();
    if (waiter === undefined) this.#activityQueued.push(value);
    else waiter({ done: false, value });
  }

  closeActivity(): void {
    if (this.#activityClosed) return;
    this.#activityClosed = true;
    for (const waiter of this.#activityWaiters.splice(0)) waiter({ done: true, value: undefined });
  }

  resolve(value: AgentRunOutcome): void { this.closeActivity(); this.#resolve(value); }
  reject(error: unknown): void { this.closeActivity(); this.#reject(error); }

  interrupt(reason: string): Promise<void> {
    this.interruptReasons.push(reason);
    this.closeActivity();
    return Promise.resolve();
  }

  #nextActivity(): Promise<IteratorResult<string>> {
    const value = this.#activityQueued.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.#activityClosed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#activityWaiters.push(resolve));
  }
}

async function* noActivity(): AsyncGenerator<string> {
  return;
}

export class FakeLauncher implements AgentLauncher {
  readonly requests: AgentLaunchRequest[] = [];
  readonly handles: DeferredRunHandle[] = [];
  readonly outcomes: AgentRunOutcome[] = [];

  launch(request: AgentLaunchRequest): Promise<AgentRunHandle> {
    this.requests.push(structuredClone(request));
    const queued = this.outcomes.shift();
    if (queued !== undefined) {
      return Promise.resolve({
        completion: Promise.resolve(structuredClone(queued)),
        activity: noActivity(),
        interrupt: () => Promise.resolve(),
      });
    }
    const handle = new DeferredRunHandle();
    this.handles.push(handle);
    return Promise.resolve(handle);
  }
}

export async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
