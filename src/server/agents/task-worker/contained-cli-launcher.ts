/** Runs one agent CLI as a bounded local POSIX process group whose descendants can be confirmed terminated. */

import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
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
} from "./agent-envelope.js";
import type { PromptRegistry } from "./prompt-registry.js";
import type { AgentLaunchRequest, AgentLauncher, AgentRunHandle, AgentRunOutcome } from "./types.js";

const RESULT_SCHEMA_PATH = fileURLToPath(new URL("./agent-result.schema.json", import.meta.url));
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;
const GROUP_POLL_MS = 20;

export interface ContainedCliAgentLauncherOptions {
  readonly adapter: RuntimeAdapter;
  readonly profile: RuntimeProfile;
  readonly prompts: PromptRegistry;
  readonly role?: AgentRole;
  readonly model: string;
  readonly workingDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly groupAbsenceTimeoutMs?: number;
}

function workingDirectory(value: string): string {
  if (!isAbsolute(value)) throw new Error("workingDirectory must be absolute");
  return configText(value, "workingDirectory", 4_096);
}

function groupPresent(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

function signalGroup(groupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-groupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function terminateGroup(groupId: number, graceMs: number, absenceTimeoutMs: number): Promise<void> {
  signalGroup(groupId, "SIGTERM");
  await delay(graceMs);
  signalGroup(groupId, "SIGKILL");
  const deadline = Date.now() + absenceTimeoutMs;
  while (groupPresent(groupId) && Date.now() < deadline) await delay(GROUP_POLL_MS);
  if (groupPresent(groupId)) throw new AgentProcessError("Agent process group could not be confirmed absent");
}

export class ContainedCliAgentLauncher implements AgentLauncher {
  readonly #options: ContainedCliAgentLauncherOptions & {
    readonly timeoutMs: number;
    readonly terminationGraceMs: number;
    readonly groupAbsenceTimeoutMs: number;
    readonly environment: NodeJS.ProcessEnv;
  };
  #active = false;

  constructor(options: ContainedCliAgentLauncherOptions) {
    if (process.platform === "win32")
      throw new AgentProcessError("Contained task agents require POSIX process groups; Windows is fail-closed");
    this.#options = {
      ...options,
      model: configText(options.model, "model", 256),
      workingDirectory: workingDirectory(options.workingDirectory),
      timeoutMs: boundedInteger(options.timeoutMs, 60 * 60_000, 1_000, 24 * 60 * 60_000, "timeoutMs"),
      terminationGraceMs: boundedInteger(options.terminationGraceMs, 2_000, 10, 60_000, "terminationGraceMs"),
      groupAbsenceTimeoutMs: boundedInteger(options.groupAbsenceTimeoutMs, 5_000, 100, 60_000, "groupAbsenceTimeoutMs"),
      environment: options.adapter.environment(options.environment ?? process.env),
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
    if (this.#active) throw new AgentProcessError("This launcher already owns an active agent process");
    const contextRedaction = redactCredentials(request.context);
    const launchWorkingDirectory = workingDirectory(request.workspace?.path ?? this.#options.workingDirectory);
    const directory = await open(launchWorkingDirectory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    await directory.close();
    const fixedRole = agentRole(request);
    const argumentOptions = {
      model: this.#options.model,
      workingDirectory: launchWorkingDirectory,
      schemaPath: RESULT_SCHEMA_PATH,
      bareApiKey: typeof this.#options.environment.ANTHROPIC_API_KEY === "string",
    };
    const args = this.#options.adapter.args(argumentOptions, fixedRole, this.#options.profile);
    const stdin = agentPrompt({ ...request, context: contextRedaction.value }, this.#options.prompts);
    const command = this.#options.profile.binary;
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: launchWorkingDirectory,
        env: this.#options.environment,
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new AgentProcessError("Unable to start the configured one-shot agent CLI", { cause: error });
    }
    if (child.pid === undefined) {
      child.kill("SIGKILL");
      throw new AgentProcessError("Agent CLI did not expose a process-group identifier");
    }
    this.#active = true;
    const groupId = child.pid;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | null = null;
    const activity = new ActivityChannel();
    const decoder = new StringDecoder("utf8");
    let pendingLine = "";
    let activityFinished = false;
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
    const terminate = (): Promise<void> => {
      if (termination === null) {
        const attempt = terminateGroup(groupId, this.#options.terminationGraceMs, this.#options.groupAbsenceTimeoutMs);
        termination = attempt;
        void attempt.catch(() => {
          if (termination === attempt) termination = null;
        });
      }
      return termination;
    };
    const timeout = setTimeout(() => {
      failure ??= new AgentProcessError("One-shot agent process exceeded its timeout");
      void terminate().catch(() => undefined);
    }, this.#options.timeoutMs);
    timeout.unref();
    const failBound = (stream: "stdout" | "stderr"): void => {
      failure ??= new AgentProcessError(`One-shot agent ${stream} exceeded its byte bound`);
      void terminate().catch(() => undefined);
    };
    child.stdout?.on("data", (chunkValue: Buffer | string) => {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
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
      failure ??= new AgentProcessError("Unable to send bounded context to the agent CLI", { cause: error });
      void terminate().catch(() => undefined);
    });
    child.stdin?.end(stdin, "utf8");

    const completion = new Promise<AgentRunOutcome>((resolve, reject) => {
      child.once("error", (error) => {
        failure ??= new AgentProcessError("Agent CLI process failed", { cause: error });
      });
      child.once("close", (code, signal) => {
        void (async () => {
          clearTimeout(timeout);
          const diagnostic = redactCredentials(Buffer.concat(stderr).toString("utf8"));
          let providerRedactions: readonly CredentialRedaction[] = [];
          try {
            if (termination !== null) {
              try {
                await termination;
              } catch (error) {
                failure ??= error as Error;
              }
            } else if (groupPresent(groupId)) {
              failure ??= new AgentProcessError("Agent CLI left a descendant process after exit");
              try {
                await terminate();
              } catch (error) {
                failure = error as Error;
              }
            }
            if (failure !== null) {
              reject(failure);
              return;
            }
            if (code !== 0) {
              reject(new AgentProcessError(`Agent CLI exited unsuccessfully (${code ?? signal ?? "unknown"})`));
              return;
            }
            try {
              const output = Buffer.concat(stdout).toString("utf8");
              const result = structuredOutcomeWithRedactions(this.#options.adapter.result(output));
              providerRedactions = result.redactions;
              resolve(result.value);
            } catch (error) {
              reject(error);
            }
          } finally {
            finishActivity(diagnostic, providerRedactions);
            this.#active = false;
          }
        })();
      });
    });
    return Object.freeze({
      completion,
      activity,
      interrupt: async (_reason: string): Promise<void> => {
        failure ??= new AgentProcessError("Agent process was interrupted directly");
        await terminate();
      },
    });
  }
}

export { RESULT_SCHEMA } from "./agent-envelope.js";
