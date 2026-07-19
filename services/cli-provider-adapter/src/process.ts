import { spawn, type ChildProcess } from "node:child_process";

const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const TERMINATION_GRACE_MS = 2_000;

export interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(input: CommandInvocation): Promise<CommandResult>;
}

export class ProviderCommandError extends Error {
  readonly exitCode: number | null;

  constructor(message: string, exitCode: number | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderCommandError";
    this.exitCode = exitCode;
  }
}

function positiveBound(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1_024 || result > 64 * 1024 * 1024) {
    throw new Error(`${label} is outside the supported range`);
  }
  return result;
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // The CLI inherits the provider-host process group. The supervisor owns that
  // group and destroys it before an interrupt is considered settled. Creating
  // a nested group here would let the CLI outlive a force-killed host.
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
  }, TERMINATION_GRACE_MS);
  timer.unref();
}

function validateInvocation(input: CommandInvocation): void {
  if (input.command.length === 0 || input.command.includes("\0")) {
    throw new Error("Provider command is invalid");
  }
  if (input.args.some((argument) => argument.includes("\0"))) {
    throw new Error("Provider command argument is invalid");
  }
  if (input.stdin.includes("\0")) throw new Error("Provider prompt contains a null byte");
}

export const nodeCommandRunner: CommandRunner = Object.freeze({
  run(input: CommandInvocation): Promise<CommandResult> {
    validateInvocation(input);
    const timeoutMs = positiveBound(input.timeoutMs, DEFAULT_TIMEOUT_MS, "Provider timeout");
    const maxStdoutBytes = positiveBound(
      input.maxStdoutBytes,
      DEFAULT_MAX_STDOUT_BYTES,
      "Provider stdout bound",
    );
    const maxStderrBytes = positiveBound(
      input.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
      "Provider stderr bound",
    );
    if (input.signal.aborted) {
      return Promise.reject(new DOMException("Provider command was aborted", "AbortError"));
    }

    return new Promise<CommandResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(input.command, [...input.args], {
          cwd: input.cwd,
          env: { ...input.env },
          shell: false,
          windowsHide: true,
          detached: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(new ProviderCommandError("Unable to start the configured provider CLI", null, { cause: error }));
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let failure: Error | null = null;
      const timeout = setTimeout(() => {
        failure = new ProviderCommandError("Provider CLI exceeded the fixed step timeout");
        terminate(child);
      }, timeoutMs);
      timeout.unref();
      const onAbort = () => {
        failure = new DOMException("Provider command was aborted", "AbortError");
        terminate(child);
      };
      input.signal.addEventListener("abort", onAbort, { once: true });

      const failBound = (stream: "stdout" | "stderr") => {
        if (failure) return;
        failure = new ProviderCommandError(`Provider CLI ${stream} exceeded its fixed byte bound`);
        terminate(child);
      };
      child.stdout?.on("data", (chunkValue: Buffer | string) => {
        const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) {
          failBound("stdout");
          return;
        }
        stdoutChunks.push(Buffer.from(chunk));
      });
      child.stderr?.on("data", (chunkValue: Buffer | string) => {
        const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
        stderrBytes += chunk.length;
        if (stderrBytes > maxStderrBytes) {
          failBound("stderr");
          return;
        }
        stderrChunks.push(Buffer.from(chunk));
      });
      child.once("error", (error) => {
        failure ??= new ProviderCommandError("Provider CLI process failed", null, { cause: error });
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        input.signal.removeEventListener("abort", onAbort);
        if (failure) {
          reject(failure);
          return;
        }
        resolve(Object.freeze({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        }));
      });

      child.stdin?.once("error", (error) => {
        failure ??= new ProviderCommandError("Unable to send the task to the provider CLI", null, { cause: error });
        terminate(child);
      });
      child.stdin?.end(input.stdin, "utf8");
    });
  },
});

export function providerCliEnvironment(
  provider: "codex" | "claude",
  source: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const universal = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"] as const;
  const providerSpecific = provider === "codex"
    ? (["CODEX_HOME", "CODEX_API_KEY"] as const)
    : (["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"] as const);
  const result: Record<string, string> = {};
  for (const key of [...universal, ...providerSpecific]) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) result[key] = value;
  }
  if (provider === "claude") {
    result.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
    result.CLAUDE_CODE_SKIP_PROMPT_HISTORY = "1";
    result.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
    result.DISABLE_AUTOUPDATER = "1";
  }
  return Object.freeze(result);
}
