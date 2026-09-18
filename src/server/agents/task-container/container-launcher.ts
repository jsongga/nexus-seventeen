/** Runs one agent task in a disposable Docker container on the isolated network prepared for container-mode fleet lanes. */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { AgentRole } from "#shared/task-board-contract";
import type { RuntimeAdapter } from "../runtime/adapter.js";
import { AgentProcessError } from "../runtime/adapter.js";
import { RuntimeCapabilityError, type RuntimeProfile } from "../runtime/profiles.js";
import {
  ActivityChannel,
  agentPrompt,
  agentRole,
  boundedInteger,
  configText,
  credentialRedactionEvents,
  delay,
  redactCredentials,
  structuredOutcomeWithRedactions,
  type CredentialRedaction,
  type CredentialRedactionResult,
} from "#server/agents/task-worker/agent-envelope";
import type { PromptRegistry } from "#server/agents/task-worker/prompt-registry";
import type {
  AgentLaunchRequest,
  AgentLauncher,
  AgentRunHandle,
  AgentRunOutcome,
} from "#server/agents/task-worker/types";
import { buildContainerRunPlan } from "./run-plan.js";

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;
const CONTAINER_POLL_MS = 100;
const DOCKER_INSPECT_TIMEOUT_MS = 10_000;
const DOCKER_REMOVE_TIMEOUT_MS = 10_000;
const DOCKER_CLIENT_CLOSE_TIMEOUT_MS = 10_000;
const CONTAINER_IMAGE_PATTERN =
  /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._\-\/]*(?::[A-Za-z0-9._-]{1,128})?(?:@sha256:[a-f0-9]{64})?)$/u;
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
  readonly adapter: RuntimeAdapter;
  readonly profile: RuntimeProfile;
  readonly prompts: PromptRegistry;
  readonly role?: AgentRole;
  readonly model: string;
  readonly image: string;
  /** Executable inside the image. Default: the profile binary. Tests pass "steward-stub". */
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
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      dockerBinary,
      [...args],
      {
        encoding: "utf8",
        env: environment,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error !== null) reject(new DockerCommandError(error, stderr));
        else resolve(stdout);
      }
    );
  });
}

function isExplicitDockerAbsence(error: unknown): boolean {
  return (
    error instanceof DockerCommandError && !error.timedOut && /No such object|no such container/iu.test(error.stderr)
  );
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
  environment: NodeJS.ProcessEnv
): Promise<"absent" | "present" | "unknown"> {
  try {
    await dockerCommand(
      dockerBinary,
      ["inspect", "--format", "{{.State.Running}}", containerName],
      environment,
      DOCKER_INSPECT_TIMEOUT_MS
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
  childIsClosed: () => boolean
): Promise<void> {
  const graceDeadline = Date.now() + terminationGraceMs;
  const graceSeconds = Math.ceil(terminationGraceMs / 1_000);
  try {
    await dockerCommand(
      dockerBinary,
      ["stop", "-t", String(graceSeconds), containerName],
      environment,
      graceSeconds * 1_000 + 10_000
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
    await dockerCommand(dockerBinary, ["rm", "-f", containerName], environment, DOCKER_REMOVE_TIMEOUT_MS);
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
    const agentCommand =
      options.agentCommand === undefined ? undefined : configText(options.agentCommand, "agentCommand", 256);
    if (agentCommand?.startsWith("-") === true) throw new Error("agentCommand is invalid");
    const sourceEnvironment = options.environment ?? process.env;
    this.#environment = options.adapter.environment(sourceEnvironment);
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
    if (options.role !== undefined) options.adapter.assertRole(options.profile, options.role);
  }

  assertRole(role: AgentRole): void {
    if (this.#options.role !== undefined && role !== this.#options.role) {
      throw new RuntimeCapabilityError(
        this.#options.profile.runtime,
        role,
        `claim role does not match configured lane role ${this.#options.role}`
      );
    }
    this.#options.adapter.assertRole(this.#options.profile, role);
  }

  async launch(request: AgentLaunchRequest): Promise<AgentRunHandle> {
    if (request.workspace === undefined) {
      throw new AgentProcessError("Container launches require a per-launch workspace");
    }
    if (this.#active) throw new AgentProcessError("This launcher already owns an active agent process");
    const contextRedaction = redactCredentials(request.context);
    const directory = await open(request.workspace.path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    await directory.close();
    const plan = buildContainerRunPlan({
      options: this.#options,
      runId: request.runId,
      taskId: request.context.taskId,
      fixedRole: agentRole(request),
      workspacePath: request.workspace.path,
      bareApiKey: typeof this.#environment.ANTHROPIC_API_KEY === "string",
      runtimeEnvironment: this.#environment,
    });
    const stdin = agentPrompt({ ...request, context: contextRedaction.value }, this.#options.prompts);
    let child: ChildProcess;
    try {
      child = spawn(this.#options.dockerBinary, [...plan.args], {
        env: this.#dockerEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new AgentProcessError("Unable to start the docker client", { cause: error });
    }
    const activity = new ActivityChannel();
    this.#active = true;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | null = null;
    let childSpawned = false;
    let childClosed = false;
    let spawnFailed = false;
    const childClose = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("close", (code, signal) => {
          childClosed = true;
          resolve({ code, signal });
        });
      }
    );
    child.once("spawn", () => {
      childSpawned = true;
      activity.publish({ type: "tool_call", name: "container_starting", detail: "" });
    });
    child.once("error", (error) => {
      spawnFailed = !childSpawned;
      failure ??= new AgentProcessError(
        spawnFailed ? "Unable to start the docker client" : "Docker client process failed",
        { cause: error }
      );
    });
    const decoder = new StringDecoder("utf8");
    let pendingLine = "";
    let activityFinished = false;
    let containerAttached = false;
    const observeLine = (line: string): void => {
      for (const event of this.#options.adapter.events(line)) activity.publish(redactCredentials(event).value);
    };
    const observeChunk = (chunk: Buffer): void => {
      pendingLine += decoder.write(chunk);
      const lines = pendingLine.split(/\r?\n/u);
      pendingLine = lines.pop() ?? "";
      for (const line of lines) observeLine(line);
    };
    const finishActivity = (
      diagnostic: CredentialRedactionResult<string>,
      providerRedactions: readonly CredentialRedaction[]
    ): void => {
      if (activityFinished) return;
      activityFinished = true;
      pendingLine += decoder.end();
      if (pendingLine.length > 0) observeLine(pendingLine);
      for (const event of credentialRedactionEvents("context", contextRedaction.redactions)) activity.publish(event);
      for (const event of credentialRedactionEvents("provider_outcome", providerRedactions)) activity.publish(event);
      for (const event of credentialRedactionEvents("diagnostics", diagnostic.redactions)) activity.publish(event);
      if (diagnostic.value.length > 0) {
        activity.publish({ type: "tool_result", name: "diagnostics", output: diagnostic.value });
      }
      activity.close();
    };
    let termination: Promise<void> | null = null;
    let teardownPublished = false;
    const terminate = (): Promise<void> => {
      if (termination === null) {
        if (!teardownPublished) {
          teardownPublished = true;
          activity.publish({ type: "tool_call", name: "container_teardown", detail: "" });
        }
        const attempt = terminateContainer(
          this.#options.dockerBinary,
          plan.containerName,
          this.#options.terminationGraceMs,
          this.#dockerEnvironment,
          child,
          childClose,
          () => childClosed
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
      if (!containerAttached) {
        containerAttached = true;
        activity.publish({ type: "tool_call", name: "container_attached", detail: "" });
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        failBound("stdout");
        return;
      }
      stdout.push(Buffer.from(chunk));
      observeChunk(chunk);
    });
    child.stderr?.on("data", (chunkValue: Buffer | string) => {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        failBound("stderr");
        return;
      }
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
      if (termination === null && !spawnFailed && code !== 0) void terminate();
      const diagnostic = redactCredentials(Buffer.concat(stderr).toString("utf8"));
      let providerRedactions: readonly CredentialRedaction[] = [];
      try {
        if (termination !== null) {
          try {
            await termination;
          } catch (error) {
            failure ??= error as Error;
          }
        }
        if (failure !== null) throw failure;
        if (code !== 0) {
          throw new AgentProcessError(`Agent container exited unsuccessfully (${code ?? signal ?? "unknown"})`);
        }
        const output = Buffer.concat(stdout).toString("utf8");
        const result = structuredOutcomeWithRedactions(this.#options.adapter.result(output));
        providerRedactions = result.redactions;
        return result.value;
      } finally {
        finishActivity(diagnostic, providerRedactions);
        this.#active = false;
      }
    })();
    return Object.freeze({
      completion,
      activity,
      interrupt: async (_reason: string): Promise<void> => {
        failure ??= new AgentProcessError("Agent container was interrupted directly");
        await terminate();
        try {
          await completion;
        } catch {}
      },
    });
  }
}
