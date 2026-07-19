import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentLaunchRequest,
  AgentLauncher,
  AgentRunHandle,
  AgentRunInterrupt,
  AgentRunOutcome,
  AppendRunOutputRequest,
  BoundedAgentContext,
  ClaimedAgentRun,
  ClaimNextWakeRequest,
  SettleAgentRunRequest,
  TaskBoardClient,
  TaskWakeClaim,
} from "../src/types.js";

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
      title: "Prevent duplicate checkout submission",
      objective: "Make repeated submission safe for customers.",
      acceptanceCriteria: "A repeated request creates one charge and the focused tests pass.",
    },
    parentSummary: "The parent task identified retries as the highest-impact customer risk.",
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
  const boundedContext = options.context === undefined
    ? (taskId === null ? null : context(request.messageCursor === null
        ? { messagesSinceCursor: null }
        : { messagesSinceCursor: request.messageCursor, nextMessageCursor: request.messageCursor, messages: [] }))
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
      requestedMessageCursor: request.messageCursor,
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
    detail: label,
  };
}

export class FakeBoard implements TaskBoardClient {
  readonly claimRequests: ClaimNextWakeRequest[] = [];
  readonly appendAttempts: AppendRunOutputRequest[] = [];
  readonly outputs: AppendRunOutputRequest[] = [];
  readonly settlements: SettleAgentRunRequest[] = [];
  readonly #claimed = new Map<string, ClaimedAgentRun>();
  readonly #waiters = new Map<string, (value: AgentRunInterrupt | null) => void>();
  readonly queued: Array<(request: ClaimNextWakeRequest) => ClaimedAgentRun> = [];
  claimFailures = 0;
  appendFailures = 0;

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
  interruptReasons: string[] = [];
  #resolve!: (value: AgentRunOutcome) => void;
  #reject!: (error: unknown) => void;

  constructor() {
    this.completion = new Promise<AgentRunOutcome>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  resolve(value: AgentRunOutcome): void { this.#resolve(value); }
  reject(error: unknown): void { this.#reject(error); }

  interrupt(reason: string): Promise<void> {
    this.interruptReasons.push(reason);
    return Promise.resolve();
  }
}

export class FakeLauncher implements AgentLauncher {
  readonly requests: AgentLaunchRequest[] = [];
  readonly handles: DeferredRunHandle[] = [];
  readonly outcomes: AgentRunOutcome[] = [];

  launch(request: AgentLaunchRequest): Promise<AgentRunHandle> {
    this.requests.push(structuredClone(request));
    const queued = this.outcomes.shift();
    if (queued !== undefined) {
      return Promise.resolve({ completion: Promise.resolve(structuredClone(queued)), interrupt: () => Promise.resolve() });
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
