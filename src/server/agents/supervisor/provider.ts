import type { AgentRole, AgentTaskProjection } from "#shared/protocol";
import type { RpetPhase } from "./checkpoint.js";
import {
  ProviderPolicyDeniedError,
  type ProviderPhaseAuthorization,
} from "./provider-policy.js";

export interface ProviderStepInput {
  task: AgentTaskProjection;
  phase: RpetPhase;
  iteration: number;
  /** Host-issued, fail-closed authorization for this exact role and phase. */
  authorization: ProviderPhaseAuthorization;
  signal: AbortSignal;
  reportCurrentAction(summary: string): Promise<void>;
}

export interface ProviderStepResult {
  journal: string;
  testOutcome?: "passed" | "failed";
  resultOverview?: string;
}

export interface ProviderInterruptContext {
  task: AgentTaskProjection | null;
  reason: string;
}

/** Deliberately excludes control-plane credentials, URL, and supervisor state paths. */
export interface ProviderAdapterConfig {
  providerName: "codex" | "claude";
  model: string;
  role: AgentRole;
  workspaceId: string;
  agentId: string;
  laneId: string;
  workingDirectory: string;
}

export interface ProviderAdapter {
  readonly providerName: "codex" | "claude";
  readonly model: string;
  executeStep(input: ProviderStepInput): Promise<ProviderStepResult>;
  settleInterrupt(context: ProviderInterruptContext): Promise<void>;
  shutdown(): Promise<void>;
}

export interface FakeProviderOptions {
  providerName?: "codex" | "claude";
  model?: string;
  testOutcomes?: readonly ("passed" | "failed")[];
  delayMs?: number;
  beforeStep?: (input: ProviderStepInput) => void | Promise<void>;
}

function abortError(): Error {
  const error = new Error("Provider step aborted");
  error.name = "AbortError";
  return error;
}

async function waitWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly providerName: "codex" | "claude";
  readonly model: string;
  readonly #testOutcomes: ("passed" | "failed")[];
  readonly #delayMs: number;
  readonly #beforeStep: FakeProviderOptions["beforeStep"];
  readonly calls: ProviderStepInput[] = [];
  interruptSettlements = 0;
  shutdownCalls = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.providerName = options.providerName ?? "codex";
    this.model = options.model ?? "fake-test-model";
    this.#testOutcomes = [...(options.testOutcomes ?? ["passed"])];
    this.#delayMs = options.delayMs ?? 0;
    this.#beforeStep = options.beforeStep;
  }

  async executeStep(input: ProviderStepInput): Promise<ProviderStepResult> {
    this.calls.push({ ...input });
    await this.#beforeStep?.(input);
    await input.reportCurrentAction(
      input.phase === "test"
        ? `Checking the task result for iteration ${input.iteration}`
        : `${input.phase[0]!.toUpperCase()}${input.phase.slice(1)}ing ${input.task.title}`,
    );
    await waitWithSignal(this.#delayMs, input.signal);
    if (input.signal.aborted) throw abortError();

    const label = `${input.phase} iteration ${input.iteration}`;
    if (input.phase === "test") {
      const testOutcome = this.#testOutcomes.shift() ?? "passed";
      return {
        journal: testOutcome === "passed"
          ? "The user-facing result passed the assigned checks."
          : "The current result did not pass its checks; the next iteration will research the failure before revising the plan.",
        testOutcome,
        ...(testOutcome === "passed" ? { resultOverview: `Completed ${input.task.title} with passing checks.` } : {}),
      };
    }
    return {
      journal: `${label} produced the next result-oriented input for ${input.task.title}.`,
    };
  }

  async settleInterrupt(_context: ProviderInterruptContext): Promise<void> {
    this.interruptSettlements += 1;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

/**
 * Keeps non-engineer supervisors alive for oversight commands without loading
 * a modifying provider implementation. Dedicated verifier/manager runners can
 * replace this when their narrower workflows are implemented.
 */
export class RoleRestrictedProviderAdapter implements ProviderAdapter {
  readonly providerName: "codex" | "claude";
  readonly model: string;
  readonly #role: AgentRole;

  constructor(config: Pick<ProviderAdapterConfig, "providerName" | "model" | "role">) {
    this.providerName = config.providerName;
    this.model = config.model;
    this.#role = config.role;
  }

  executeStep(input: ProviderStepInput): Promise<ProviderStepResult> {
    return Promise.reject(new ProviderPolicyDeniedError(
      this.#role,
      input.phase,
      "this role has no modifying provider process",
    ));
  }

  settleInterrupt(_context: ProviderInterruptContext): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
