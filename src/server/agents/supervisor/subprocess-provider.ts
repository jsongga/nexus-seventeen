import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  FramedJsonProtocolError,
  FramedJsonReader,
  FramedJsonWriter,
} from "./framed-json.js";
import {
  assertEngineerRpetRole,
  authorizeProviderPhase,
} from "./provider-policy.js";
import {
  parseProviderHostResponse,
  type ProviderHostResponse,
} from "./provider-wire.js";
import {
  parseProviderModuleSha256,
  verifyTrustedProviderModule,
} from "./provider-module.js";
import type {
  ProviderAdapter,
  ProviderAdapterConfig,
  ProviderInterruptContext,
  ProviderStepInput,
  ProviderStepResult,
} from "./provider.js";

const COMMON_PROVIDER_ENV_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SystemRoot",
  "WINDIR",
] as const);

const PROVIDER_CREDENTIAL_ENV_KEYS = Object.freeze({
  codex: Object.freeze([
    "CODEX_API_KEY",
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT",
  ] as const),
  claude: Object.freeze([
    "ANTHROPIC_API_KEY",
  ] as const),
} as const);

const PROVIDER_CONFIGURATION_ENV_KEYS = Object.freeze({
  codex: Object.freeze([
    "CICADA_STEWARD_MODEL_CATALOG_JSON",
  ] as const),
  claude: Object.freeze([] as const),
} as const);

const DEFAULT_STEP_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_ABORT_GRACE_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const GROUP_ABSENCE_POLL_MS = 20;

type ExpectedResponseType = Exclude<ProviderHostResponse["type"], "current_action" | "error">;

type PendingResponse = {
  expected: ExpectedResponseType;
  resolve(response: ProviderHostResponse): void;
  reject(error: unknown): void;
};

type ActiveStep = {
  requestId: string;
  reportCurrentAction: ProviderStepInput["reportCurrentAction"];
};

export interface SubprocessProviderAdapterOptions {
  config: ProviderAdapterConfig;
  modulePath: string;
  moduleSha256: string;
  stateDirectory: string;
  environment?: NodeJS.ProcessEnv;
  stepTimeoutMs?: number;
  abortGraceMs?: number;
  requestTimeoutMs?: number;
  hostScriptPath?: string;
}

export class ProviderProcessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderProcessError";
  }
}

function abortError(): Error {
  const error = new Error("Provider step aborted");
  error.name = "AbortError";
  return error;
}

function timeoutError(): Error {
  const error = new Error("Provider step exceeded its configured timeout");
  error.name = "TimeoutError";
  return error;
}

function boundedTimeout(value: number | undefined, fallback: number, label: string): number {
  const timeout = value ?? fallback;
  if (!Number.isInteger(timeout) || timeout < 50 || timeout > 24 * 60 * 60_000) {
    throw new Error(`${label} must be an integer between 50 and 86400000`);
  }
  return timeout;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupPresent(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM and unknown errors are treated as present so containment fails
    // closed rather than asserting a false settlement.
    return true;
  }
}

function signalProcessGroup(groupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-groupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function terminateAndConfirmProcessGroup(
  groupId: number,
  termGraceMs: number,
  absenceTimeoutMs: number,
): Promise<void> {
  signalProcessGroup(groupId, "SIGTERM");
  await delay(termGraceMs);
  // Always attempt group SIGKILL after the grace period. The host leader may
  // already have exited while a TERM-ignoring descendant still owns the group.
  signalProcessGroup(groupId, "SIGKILL");
  const deadline = Date.now() + absenceTimeoutMs;
  while (processGroupPresent(groupId) && Date.now() < deadline) {
    await delay(GROUP_ABSENCE_POLL_MS);
  }
  if (processGroupPresent(groupId)) {
    throw new ProviderProcessError(
      `Provider process group ${groupId} could not be confirmed absent`,
    );
  }
}

/**
 * The child gets an explicit fixed allowlist, never the supervisor's ambient
 * environment. The sole Steward-namespaced exception is the non-secret,
 * caller-owned model catalog explicitly listed for the Codex adapter above.
 */
export function providerChildEnvironment(
  providerName: "codex" | "claude",
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowed = [
    ...COMMON_PROVIDER_ENV_KEYS,
    ...PROVIDER_CREDENTIAL_ENV_KEYS[providerName],
    ...PROVIDER_CONFIGURATION_ENV_KEYS[providerName],
  ];
  const result: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of allowed) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export class SubprocessProviderAdapter implements ProviderAdapter {
  readonly providerName: "codex" | "claude";
  readonly model: string;
  readonly #config: ProviderAdapterConfig;
  readonly #modulePath: string;
  readonly #moduleSha256: string;
  readonly #stateDirectory: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #stepTimeoutMs: number;
  readonly #abortGraceMs: number;
  readonly #requestTimeoutMs: number;
  readonly #hostScriptPath: string;
  readonly #pending = new Map<string, PendingResponse>();
  #child: ChildProcess | null = null;
  #reader: FramedJsonReader | null = null;
  #writer: FramedJsonWriter | null = null;
  #startPromise: Promise<void> | null = null;
  #activeStep: ActiveStep | null = null;
  #stopped = false;
  #generation = 0;
  #groupId: number | null = null;
  #groupTermination: Promise<void> | null = null;
  #containmentFailure: unknown | null = null;

  private constructor(options: SubprocessProviderAdapterOptions) {
    this.#config = Object.freeze({ ...options.config });
    this.providerName = options.config.providerName;
    this.model = options.config.model;
    this.#modulePath = options.modulePath;
    this.#moduleSha256 = parseProviderModuleSha256(options.moduleSha256);
    this.#stateDirectory = options.stateDirectory;
    this.#environment = providerChildEnvironment(this.providerName, options.environment ?? process.env);
    this.#stepTimeoutMs = boundedTimeout(options.stepTimeoutMs, DEFAULT_STEP_TIMEOUT_MS, "stepTimeoutMs");
    this.#abortGraceMs = boundedTimeout(options.abortGraceMs, DEFAULT_ABORT_GRACE_MS, "abortGraceMs");
    this.#requestTimeoutMs = boundedTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
    this.#hostScriptPath = options.hostScriptPath ?? fileURLToPath(new URL("./provider-host.js", import.meta.url));
    if (process.platform === "win32") {
      throw new ProviderProcessError(
        "Real provider hosting requires POSIX process-group containment; Windows is fail-closed",
      );
    }
    assertEngineerRpetRole(this.#config.role);
  }

  static async create(options: SubprocessProviderAdapterOptions): Promise<SubprocessProviderAdapter> {
    const adapter = new SubprocessProviderAdapter(options);
    await adapter.#ensureHost();
    return adapter;
  }

  async executeStep(input: ProviderStepInput): Promise<ProviderStepResult> {
    if (this.#stopped) throw new ProviderProcessError("Provider adapter is shut down");
    if (this.#activeStep) throw new ProviderProcessError("Provider adapter already has an active step");
    if (input.signal.aborted) throw abortError();
    const expected = authorizeProviderPhase(this.#config.role, input.phase);
    if (
      input.authorization.role !== this.#config.role ||
      input.authorization.phase !== input.phase ||
      input.authorization.operations.length !== expected.operations.length ||
      input.authorization.operations.some((operation, index) => operation !== expected.operations[index])
    ) {
      throw new ProviderProcessError("Provider step authorization does not match host policy");
    }

    await this.#ensureHost();
    if (input.signal.aborted) throw abortError();
    const requestId = randomUUID();
    this.#activeStep = { requestId, reportCurrentAction: input.reportCurrentAction };
    let timedOut = false;
    let forced: NodeJS.Timeout | null = null;
    const request = this.#waitForResponse(requestId, "result");
    const requestAbort = (reason: Error) => {
      void this.#writer?.send({ type: "abort", requestId }).catch(() => undefined);
      if (!forced) {
        forced = setTimeout(() => this.#failHost(reason), this.#abortGraceMs);
        forced.unref();
      }
    };
    const onAbort = () => requestAbort(abortError());
    input.signal.addEventListener("abort", onAbort, { once: true });
    const stepTimer = setTimeout(() => {
      timedOut = true;
      requestAbort(timeoutError());
    }, this.#stepTimeoutMs);
    stepTimer.unref();

    try {
      await this.#writer!.send({
        type: "execute",
        requestId,
        input: {
          task: input.task,
          phase: input.phase,
          iteration: input.iteration,
          authorization: expected,
        },
      });
      const response = await request;
      if (response.type !== "result") throw new ProviderProcessError("Provider returned an unexpected response");
      return response.result;
    } catch (error) {
      if (timedOut) {
        await this.#beginHostTermination(timeoutError());
        throw timeoutError();
      }
      if (!this.#child) await this.#awaitGroupTermination();
      if (input.signal.aborted) throw abortError();
      throw error;
    } finally {
      clearTimeout(stepTimer);
      if (forced) clearTimeout(forced);
      input.signal.removeEventListener("abort", onAbort);
      if (this.#activeStep?.requestId === requestId) this.#activeStep = null;
      this.#pending.delete(requestId);
    }
  }

  async settleInterrupt(context: ProviderInterruptContext): Promise<void> {
    if (this.#stopped) return;
    await this.#awaitGroupTermination();
    // A previously forced group is settled only after confirmed absence. Do
    // not start a fresh host merely to notify it about an old interrupt.
    if (!this.#child) return;
    if (this.#activeStep) throw new ProviderProcessError("Cannot settle an interrupt while a provider step is active");
    const requestId = randomUUID();
    let settlementFailure: unknown | null = null;
    try {
      await this.#exchange(
        { type: "settle_interrupt", requestId, context },
        requestId,
        "interrupt_settled",
        this.#requestTimeoutMs,
      );
    } catch (error) {
      settlementFailure = error;
    }
    let containmentFailure: unknown | null = null;
    try {
      await this.#beginHostTermination(
        new ProviderProcessError("Provider host rotated after interrupt settlement"),
      );
    } catch (error) {
      containmentFailure = error;
    }
    if (settlementFailure && containmentFailure) {
      throw new AggregateError(
        [settlementFailure, containmentFailure],
        "Provider interrupt and process-group settlement failed",
      );
    }
    if (containmentFailure) throw containmentFailure;
    if (settlementFailure) throw settlementFailure;
  }

  async shutdown(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.#awaitGroupTermination();
    if (!this.#child) return;
    const requestId = randomUUID();
    try {
      await this.#exchange(
        { type: "shutdown", requestId },
        requestId,
        "shutdown_complete",
        this.#requestTimeoutMs,
      );
    } finally {
      await this.#beginHostTermination(new ProviderProcessError("Provider host stopped"));
    }
  }

  async #ensureHost(): Promise<void> {
    if (this.#stopped) throw new ProviderProcessError("Provider adapter is shut down");
    await this.#awaitGroupTermination();
    if (this.#containmentFailure) {
      throw new ProviderProcessError("A previous provider process group was not contained", {
        cause: this.#containmentFailure,
      });
    }
    if (this.#child && this.#writer) return;
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#startHost().finally(() => {
      this.#startPromise = null;
    });
    return this.#startPromise;
  }

  async #startHost(): Promise<void> {
    await verifyTrustedProviderModule({
      modulePath: this.#modulePath,
      expectedSha256: this.#moduleSha256,
      workingDirectory: this.#config.workingDirectory,
      stateDirectory: this.#stateDirectory,
    });
    const generation = ++this.#generation;
    const child = spawn(process.execPath, [
      this.#hostScriptPath,
      this.#modulePath,
      this.#moduleSha256,
    ], {
      cwd: this.#config.workingDirectory,
      env: this.#environment,
      stdio: ["ignore", "ignore", "ignore", "pipe"],
      detached: true,
      windowsHide: true,
    });
    if (!child.pid) {
      child.kill("SIGKILL");
      throw new ProviderProcessError("Provider host did not receive a process-group ID");
    }
    this.#groupId = child.pid;
    const transport = child.stdio[3] as Duplex | null;
    if (!transport) {
      await this.#beginHostTermination(new ProviderProcessError("Provider host transport was not created"));
      throw new ProviderProcessError("Provider host transport was not created");
    }
    this.#child = child;
    this.#reader = new FramedJsonReader(transport);
    this.#writer = new FramedJsonWriter(transport);
    child.once("error", () => {
      if (this.#generation === generation) this.#failHost(new ProviderProcessError("Provider host process failed"));
    });
    child.once("exit", (code, signal) => {
      if (this.#generation !== generation || this.#child !== child) return;
      this.#failHost(new ProviderProcessError(
        `Provider host exited before shutdown (${signal ?? code ?? "unknown"})`,
      ));
    });
    void this.#readResponses(generation);

    try {
      const requestId = randomUUID();
      const ready = await this.#exchange(
        { type: "initialize", requestId, config: this.#config },
        requestId,
        "ready",
        this.#requestTimeoutMs,
      );
      if (
        ready.type !== "ready" ||
        ready.providerName !== this.providerName ||
        ready.model !== this.model
      ) {
        throw new ProviderProcessError("Provider host identity did not match configuration");
      }
    } catch (error) {
      await this.#beginHostTermination(error);
      throw error;
    }
  }

  async #readResponses(generation: number): Promise<void> {
    try {
      for await (const raw of this.#reader!) {
        if (generation !== this.#generation) return;
        const response = parseProviderHostResponse(raw);
        if (response.type === "current_action") {
          await this.#handleCurrentAction(response);
          continue;
        }
        const pending = this.#pending.get(response.requestId);
        if (!pending) throw new FramedJsonProtocolError("Provider sent a response for an unknown request");
        this.#pending.delete(response.requestId);
        if (response.type === "error") {
          pending.reject(new ProviderProcessError(response.message));
        } else if (response.type !== pending.expected) {
          pending.reject(new FramedJsonProtocolError("Provider response type did not match the request"));
          this.#failHost(new FramedJsonProtocolError("Provider response type did not match the request"));
        } else {
          pending.resolve(response);
        }
      }
      if (generation === this.#generation && this.#child) {
        this.#failHost(new ProviderProcessError("Provider host transport closed"));
      }
    } catch (error) {
      if (generation === this.#generation) this.#failHost(error);
    }
  }

  async #handleCurrentAction(
    response: Extract<ProviderHostResponse, { type: "current_action" }>,
  ): Promise<void> {
    const active = this.#activeStep;
    if (!active || active.requestId !== response.requestId) {
      throw new FramedJsonProtocolError("Provider reported a current action outside its active step");
    }
    try {
      await active.reportCurrentAction(response.summary);
      await this.#writer!.send({
        type: "current_action_ack",
        requestId: response.requestId,
        actionId: response.actionId,
        accepted: true,
      });
    } catch {
      await this.#writer!.send({
        type: "current_action_ack",
        requestId: response.requestId,
        actionId: response.actionId,
        accepted: false,
        error: "Supervisor could not durably record the current action",
      });
    }
  }

  async #exchange(
    value: unknown,
    requestId: string,
    expected: ExpectedResponseType,
    timeoutMs: number,
  ): Promise<ProviderHostResponse> {
    const response = this.#waitForResponse(requestId, expected);
    const timer = setTimeout(() => {
      const pending = this.#pending.get(requestId);
      if (!pending) return;
      this.#pending.delete(requestId);
      pending.reject(new ProviderProcessError("Provider host request timed out"));
      this.#failHost(new ProviderProcessError("Provider host request timed out"));
    }, timeoutMs);
    timer.unref();
    try {
      await this.#writer!.send(value);
      return await response;
    } finally {
      clearTimeout(timer);
      this.#pending.delete(requestId);
    }
  }

  #waitForResponse(requestId: string, expected: ExpectedResponseType): Promise<ProviderHostResponse> {
    if (this.#pending.has(requestId)) throw new Error("Duplicate provider request ID");
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { expected, resolve, reject });
    });
  }

  #failHost(error: unknown): void {
    void this.#beginHostTermination(error).catch(() => undefined);
  }

  async #beginHostTermination(error: unknown): Promise<void> {
    if (this.#groupTermination) return this.#groupTermination;
    const groupId = this.#groupId;
    this.#child = null;
    this.#reader = null;
    this.#writer = null;
    this.#groupId = null;
    this.#generation += 1;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (!groupId) return;
    const termination = terminateAndConfirmProcessGroup(
      groupId,
      this.#abortGraceMs,
      this.#requestTimeoutMs,
    );
    this.#groupTermination = termination;
    try {
      await termination;
    } catch (containmentFailure) {
      this.#containmentFailure = containmentFailure;
      throw containmentFailure;
    } finally {
      if (this.#groupTermination === termination) this.#groupTermination = null;
    }
  }

  async #awaitGroupTermination(): Promise<void> {
    if (this.#groupTermination) await this.#groupTermination;
    if (this.#containmentFailure) {
      throw new ProviderProcessError("Provider process-group absence was not confirmed", {
        cause: this.#containmentFailure,
      });
    }
  }
}
