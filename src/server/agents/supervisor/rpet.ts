import {
  parseAgentTaskProjection,
  parseProgressEvent,
  type AgentTaskProjection,
  type CurrentAction,
  type DurableOutboxPayload,
  type IsoTimestamp,
  type AgentRole,
} from "#shared/protocol";
import type { RpetPhase } from "./checkpoint.js";
import { assertEngineerRpetRole, authorizeProviderPhase } from "./provider-policy.js";
import type { ProviderAdapter } from "./provider.js";

const PHASES: readonly RpetPhase[] = ["research", "plan", "execute", "test"];
const MAX_ACTION_CHARS = 280;
const MAX_JOURNAL_CHARS = 1_200;
const MAX_RESULT_CHARS = 2_000;
const PRIVATE_REASONING_RE = /(?:chain[- ]of[- ]thought|private reasoning|hidden reasoning|internal monologue)/i;
const SENSITIVE_OUTPUT_RE = /(?:\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:sk-(?:ant-|proj-)?|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}\b|\b(?:api[-_ ]?key|access[-_ ]?token|password|credential|secret)\s*[:=]\s*\S{8,})/i;

export interface RpetRunnerState {
  task: AgentTaskProjection;
  iteration: number;
  phase: RpetPhase;
}

export interface RpetStepResult {
  progress: Extract<DurableOutboxPayload, { type: "progress" }>;
  currentAction: CurrentAction;
  completed: boolean;
  resultOverview: string | null;
  nextIteration: number;
  nextPhase: RpetPhase;
}

export interface RpetRunnerOptions {
  role: AgentRole;
  clock?: () => Date;
  initialIteration?: number;
  initialPhase?: RpetPhase;
}

export type CurrentActionReporter = (action: CurrentAction) => void | Promise<void>;

function boundedResultText(value: string, label: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  if (PRIVATE_REASONING_RE.test(normalized)) throw new Error(`${label} must contain outcomes, not private reasoning`);
  if (SENSITIVE_OUTPUT_RE.test(normalized)) throw new Error(`${label} appears to contain credentials or secrets`);
  return normalized;
}

function nextPhase(phase: RpetPhase): RpetPhase {
  const index = PHASES.indexOf(phase);
  return PHASES[(index + 1) % PHASES.length]!;
}

export class RpetRunner {
  readonly #task: AgentTaskProjection;
  readonly #clock: () => Date;
  readonly #role: AgentRole;
  #iteration: number;
  #phase: RpetPhase;
  #completed = false;

  constructor(task: AgentTaskProjection, options: RpetRunnerOptions) {
    this.#task = parseAgentTaskProjection(task);
    this.#role = options.role;
    assertEngineerRpetRole(this.#role, options.initialPhase ?? "research");
    this.#iteration = options.initialIteration ?? 1;
    this.#phase = options.initialPhase ?? "research";
    this.#clock = options.clock ?? (() => new Date());
    if (!Number.isSafeInteger(this.#iteration) || this.#iteration < 1) throw new Error("RPET iteration must be positive");
  }

  get state(): RpetRunnerState {
    return {
      task: this.#task,
      iteration: this.#iteration,
      phase: this.#phase,
    };
  }

  get completed(): boolean {
    return this.#completed;
  }

  async step(
    provider: ProviderAdapter,
    signal: AbortSignal,
    reportCurrentAction: CurrentActionReporter = () => undefined,
  ): Promise<RpetStepResult> {
    if (this.#completed) throw new Error("RPET task is already complete");
    const phase = this.#phase;
    const iteration = this.#iteration;
    const authorization = authorizeProviderPhase(this.#role, phase);
    let currentAction: CurrentAction | null = null;
    const providerResult = await provider.executeStep({
      task: this.#task,
      phase,
      iteration,
      authorization,
      signal,
      reportCurrentAction: async (summary) => {
        const actionSummary = boundedResultText(summary, "currentAction", MAX_ACTION_CHARS);
        currentAction = {
          taskId: this.#task.taskId,
          summary: actionSummary,
          startedAt: this.#clock().toISOString() as IsoTimestamp,
        };
        await reportCurrentAction(currentAction);
      },
    });
    const journal = boundedResultText(providerResult.journal, "journal", MAX_JOURNAL_CHARS);
    if (!currentAction) throw new Error("Provider must report a structured current action before returning");

    const occurredAt = this.#clock().toISOString() as IsoTimestamp;
    let progress: Extract<DurableOutboxPayload, { type: "progress" }>;
    let completed = false;
    let resultOverview: string | null = null;

    if (phase === "test") {
      if (providerResult.testOutcome !== "passed" && providerResult.testOutcome !== "failed") {
        throw new Error("Provider test steps must return a passed or failed outcome");
      }
      parseProgressEvent({
        taskId: this.#task.taskId,
        phase,
        iteration,
        journal,
        outcome: providerResult.testOutcome,
        occurredAt,
      });
      progress = {
        type: "progress",
        taskId: this.#task.taskId,
        phase,
        iteration,
        journal,
        outcome: providerResult.testOutcome,
      };
      if (providerResult.testOutcome === "passed") {
        completed = true;
        this.#completed = true;
        resultOverview = boundedResultText(
          providerResult.resultOverview ?? `Completed ${this.#task.title} with passing checks.`,
          "resultOverview",
          MAX_RESULT_CHARS,
        );
      } else {
        this.#iteration += 1;
        this.#phase = "research";
      }
    } else {
      if (providerResult.testOutcome !== undefined) throw new Error("Only test steps may return a test outcome");
      parseProgressEvent({
        taskId: this.#task.taskId,
        phase,
        iteration,
        journal,
        occurredAt,
      });
      progress = {
        type: "progress",
        taskId: this.#task.taskId,
        phase,
        iteration,
        journal,
      };
      this.#phase = nextPhase(phase);
    }

    return {
      progress,
      currentAction,
      completed,
      resultOverview,
      nextIteration: this.#iteration,
      nextPhase: this.#phase,
    };
  }
}
