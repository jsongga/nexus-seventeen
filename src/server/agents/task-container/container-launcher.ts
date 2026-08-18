import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import {
  ActivityChannel,
  AgentProcessError,
  agentPrompt,
  agentRole,
  assertCredentialSafe,
  boundedInteger,
  configText,
  delay,
  providerEnvironment,
  providerResult,
  structuredOutcome,
  type AgentProvider,
} from "#server/agents/task-worker/agent-envelope";
import {
  ActivityBuffer,
  activityFromProviderLine,
  estimateActivity,
  estimateMinutesFromProviderLine,
  phaseActivity,
  phaseSignalFromProviderLine,
} from "#server/agents/task-worker/provider-activity";
import type {
  AgentLaunchRequest,
  AgentLauncher,
  AgentRunHandle,
  AgentRunOutcome,
} from "#server/agents/task-worker/types";
import { buildContainerRunPlan } from "./arguments.js";

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;
const CONTAINER_POLL_MS = 100;
const DOCKER_INSPECT_TIMEOUT_MS = 10_000;
const DOCKER_REMOVE_TIMEOUT_MS = 10_000;
const DOCKER_CLIENT_CLOSE_TIMEOUT_MS = 10_000;
const CONTAINER_IMAGE_PATTERN = /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._\-\/]*(?::[A-Za-z0-9._-]{1,128})?(?:@sha256:[a-f0-9]{64})?)$/u;
const DOCKER_ENVIRONMENT_KEYS = [
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
] as const;

class DockerCommandError extends Error {
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(error: Error & { readonly killed?: boolean }, stderr: string) {
    super(error.message, { cause: error });
    this.name = "DockerCommandError";
    this.stderr = stderr;
    this.timedOut = error.killed === true;
  }
}

export interface ContainerAgentLauncherOptions {
  readonly provider: "codex" | "claude";
  readonly model: string;
  readonly image: string;
  /** Executable inside the image. Default: the provider name. Tests pass "steward-stub". */
  readonly agentCommand?: string;
  readonly networkName: string;
  readonly proxyUrl: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly dockerBinary?: string;
  /** Extra -e KEY=VALUE pairs for the container (test hook, e.g. STEWARD_STUB_MODE). */
  readonly extraContainerEnv?: Readonly<Record<string, string>>;
}

function dockerCommand(
  dockerBinary: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(dockerBinary, [...args], {
      encoding: "utf8",
      env: environment,
      timeout: timeoutMs,
    }, (error, stdout, stderr) => {
      if (error !== null) reject(new DockerCommandError(error, stderr));
      else resolve(stdout);
    });
  });
}

function isExplicitDockerAbsence(error: unknown): boolean {
  return error instanceof DockerCommandError
    && !error.timedOut
    && /No such object|no such container/iu.test(error.stderr);
}

function childClosesWithin(childClose: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref();
    void childClose.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function inspectContainer(
  dockerBinary: string,
  containerName: string,
  environment: NodeJS.ProcessEnv,
): Promise<"absent" | "present" | "unknown"> {
  try {
    await dockerCommand(
      dockerBinary,
      ["inspect", "--format", "{{.State.Running}}", containerName],
      environment,
      DOCKER_INSPECT_TIMEOUT_MS,
    );
    return "present";
  } catch (error) {
    return isExplicitDockerAbsence(error) ? "absent" : "unknown";
  }
}

async function terminateContainer(
  dockerBinary: string,
  containerName: string,
  terminationGraceMs: number,
  environment: NodeJS.ProcessEnv,
  child: ChildProcess,
  childClose: Promise<unknown>,
  childIsClosed: () => boolean,
): Promise<void> {
  const graceDeadline = Date.now() + terminationGraceMs;
  const graceSeconds = Math.ceil(terminationGraceMs / 1_000);
  try {
    await dockerCommand(
      dockerBinary,
      ["stop", "-t", String(graceSeconds), containerName],
      environment,
      graceSeconds * 1_000 + 10_000,
    );
  } catch {
    // A concurrent exit or a missing container is confirmed by inspect below.
  }

  const remainingGraceMs = graceDeadline - Date.now();
  if (remainingGraceMs > 0) await delay(remainingGraceMs);
  if (!childIsClosed()) child.kill("SIGKILL");
  if (!childIsClosed()) {
    const closed = await childClosesWithin(childClose, DOCKER_CLIENT_CLOSE_TIMEOUT_MS);
    if (!closed) throw new AgentProcessError("Task container could not be confirmed absent");
  }

  const deadline = Date.now() + terminationGraceMs;
  let state = await inspectContainer(dockerBinary, containerName, environment);
  while (state === "unknown" && Date.now() < deadline) {
    await delay(Math.min(CONTAINER_POLL_MS, Math.max(1, deadline - Date.now())));
    state = await inspectContainer(dockerBinary, containerName, environment);
  }

  try {
    await dockerCommand(
      dockerBinary,
      ["rm", "-f", containerName],
      environment,
      DOCKER_REMOVE_TIMEOUT_MS,
    );
  } catch {
    // The final inspect is the authoritative absence check.
  }

  state = await inspectContainer(dockerBinary, containerName, environment);
  while (state !== "absent" && Date.now() < deadline) {
    await delay(Math.min(CONTAINER_POLL_MS, Math.max(1, deadline - Date.now())));
    state = await inspectContainer(dockerBinary, containerName, environment);
  }
  if (state !== "absent") throw new AgentProcessError("Task container could not be confirmed absent");
}

export class ContainerAgentLauncher implements AgentLauncher {
  readonly #options: ContainerAgentLauncherOptions & {
    readonly provider: AgentProvider;
    readonly timeoutMs: number;
    readonly terminationGraceMs: number;
    readonly dockerBinary: string;
  };
  readonly #environment: NodeJS.ProcessEnv;
  readonly #dockerEnvironment: NodeJS.ProcessEnv;
  #active = false;

  constructor(options: ContainerAgentLauncherOptions) {
    const image = configText(options.image, "image", 512);
    if (!CONTAINER_IMAGE_PATTERN.test(image)) throw new Error("image is invalid");
    const agentCommand = options.agentCommand === undefined
      ? undefined
      : configText(options.agentCommand, "agentCommand", 256);
    if (agentCommand?.startsWith("-") === true) throw new Error("agentCommand is invalid");
    const sourceEnvironment = options.environment ?? process.env;
    this.#environment = providerEnvironment(options.provider, sourceEnvironment);
    this.#dockerEnvironment = { ...this.#environment };
    for (const key of DOCKER_ENVIRONMENT_KEYS) {
      const value = sourceEnvironment[key];
      if (typeof value === "string") this.#dockerEnvironment[key] = value;
    }
    this.#options = {
      ...options,
      model: configText(options.model, "model", 256),
      image,
      agentCommand,
      timeoutMs: boundedInteger(options.timeoutMs, 60 * 60_000, 1_000, 24 * 60 * 60_000, "timeoutMs"),
      terminationGraceMs: boundedInteger(options.terminationGraceMs, 2_000, 10, 60_000, "terminationGraceMs"),
      dockerBinary: options.dockerBinary ?? "docker",
    };
  }

  async launch(request: AgentLaunchRequest): Promise<AgentRunHandle> {
    if (request.workspace === undefined) {
      throw new AgentProcessError("Container launches require a per-launch workspace");
    }
    if (this.#active) throw new AgentProcessError("This launcher already owns an active agent process");
    assertCredentialSafe(JSON.stringify(request.context), "Agent context");
    const directory = await open(request.workspace.path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    await directory.close();
    const plan = buildContainerRunPlan({
      options: this.#options,
      runId: request.runId,
      taskId: request.context.taskId,
      fixedRole: agentRole(request),
      workspacePath: request.workspace.path,
      bareApiKey: typeof this.#environment.ANTHROPIC_API_KEY === "string",
    });
    const stdin = agentPrompt(request);
    let child: ChildProcess;
    try {
      child = spawn(this.#options.dockerBinary, [...plan.args], {
        env: this.#dockerEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new AgentProcessError("Unable to start the docker client", { cause: error });
    }
    this.#active = true;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | null = null;
    let childSpawned = false;
    let childClosed = false;
    let spawnFailed = false;
    const childClose = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => {
        childClosed = true;
        resolve({ code, signal });
      });
    });
    child.once("spawn", () => { childSpawned = true; });
    child.once("error", (error) => {
      spawnFailed = !childSpawned;
      failure ??= new AgentProcessError(
        spawnFailed ? "Unable to start the docker client" : "Docker client process failed",
        { cause: error },
      );
    });
    const activity = new ActivityChannel();
    const activityBuffer = new ActivityBuffer();
    const decoder = new StringDecoder("utf8");
    let pendingLine = "";
    let activityFinished = false;
    const observeLine = (line: string): void => {
      const estimate = estimateMinutesFromProviderLine(this.#options.provider, line);
      if (estimate !== null) activity.publish(estimateActivity(estimate));
      const phase = phaseSignalFromProviderLine(this.#options.provider, line);
      if (phase !== null) activity.publish(phaseActivity(phase));
      const ready = activityBuffer.push(activityFromProviderLine(this.#options.provider, line));
      if (ready !== null) activity.publish(ready);
    };
    const observeChunk = (chunk: Buffer): void => {
      pendingLine += decoder.write(chunk);
      const lines = pendingLine.split(/\r?\n/u);
      pendingLine = lines.pop() ?? "";
      for (const line of lines) observeLine(line);
    };
    const finishActivity = (): void => {
      if (activityFinished) return;
      activityFinished = true;
      pendingLine += decoder.end();
      if (pendingLine.length > 0) observeLine(pendingLine);
      const final = activityBuffer.drain();
      if (final !== null) activity.publish(final);
      activity.close();
    };
    let termination: Promise<void> | null = null;
    const terminate = (): Promise<void> => {
      if (termination === null) {
        const attempt = terminateContainer(
          this.#options.dockerBinary,
          plan.containerName,
          this.#options.terminationGraceMs,
          this.#dockerEnvironment,
          child,
          childClose,
          () => childClosed,
        );
        termination = attempt;
        void attempt.catch(() => {
          if (termination === attempt) termination = null;
        });
      }
      return termination;
    };
    const timeout = setTimeout(() => {
      failure ??= new AgentProcessError("Agent container exceeded its timeout");
      void terminate().catch(() => undefined);
    }, this.#options.timeoutMs);
    timeout.unref();
    const failBound = (stream: "stdout" | "stderr"): void => {
      failure ??= new AgentProcessError(`Agent container ${stream} exceeded its byte bound`);
      void terminate().catch(() => undefined);
    };
    child.stdout?.on("data", (chunkValue: Buffer | string) => {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) { failBound("stdout"); return; }
      stdout.push(Buffer.from(chunk));
      observeChunk(chunk);
    });
    child.stderr?.on("data", (chunkValue: Buffer | string) => {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) { failBound("stderr"); return; }
      stderr.push(Buffer.from(chunk));
    });
    child.stdin?.once("error", (error) => {
      failure ??= new AgentProcessError("Unable to send bounded context to the agent container", { cause: error });
      void terminate().catch(() => undefined);
    });
    child.stdin?.end(stdin, "utf8");

    const completion = (async (): Promise<AgentRunOutcome> => {
      const { code, signal } = await childClose;
      clearTimeout(timeout);
      finishActivity();
      try {
        if (termination !== null) {
          try { await termination; } catch (error) { failure ??= error as Error; }
        } else if (!spawnFailed && code !== 0) {
          try { await terminate(); } catch (error) { failure = error as Error; }
        }
        if (failure !== null) throw failure;
        if (code !== 0) {
          throw new AgentProcessError(`Agent container exited unsuccessfully (${code ?? signal ?? "unknown"})`);
        }
        const output = Buffer.concat(stdout).toString("utf8");
        const diagnostic = Buffer.concat(stderr).toString("utf8");
        assertCredentialSafe(diagnostic, "Agent diagnostics");
        return structuredOutcome(providerResult(this.#options.provider, output));
      } finally {
        this.#active = false;
      }
    })();
    return Object.freeze({
      completion,
      activity,
      interrupt: async (_reason: string): Promise<void> => {
        failure ??= new AgentProcessError("Agent container was interrupted directly");
        await terminate();
        try { await completion; } catch {}
      },
    });
  }
}
