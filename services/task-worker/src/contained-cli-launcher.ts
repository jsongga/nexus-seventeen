import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentRunOutcome } from "./schema.js";
import type { AgentLaunchRequest, AgentLauncher, AgentRunHandle, AgentRunOutcome } from "./types.js";

const RESULT_SCHEMA_PATH = fileURLToPath(new URL("../../agent-result.schema.json", import.meta.url));
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;
const GROUP_POLL_MS = 20;

const RESULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["completed", "failed", "waiting_for_human"] },
    progress: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 2_000 } },
    result: { type: ["string", "null"], maxLength: 4_000 },
    proposedChildTasks: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1, maxLength: 512 },
          objective: { type: "string", minLength: 1, maxLength: 4_000 },
          acceptanceCriteria: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: { type: "string", minLength: 1, maxLength: 1_000 },
          },
        },
        required: ["title", "objective", "acceptanceCriteria"],
      },
    },
    humanQuestion: { type: ["string", "null"], maxLength: 2_000 },
    detail: { type: "string", minLength: 1, maxLength: 2_000 },
  },
  required: ["status", "progress", "result", "proposedChildTasks", "humanQuestion", "detail"],
} as const);

const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\b(?:sk-(?:proj-|ant-)?|github_pat_|gh[pousr]_|glpat-|npm_|xox[baprs]-)[A-Za-z0-9._-]{8,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bhttps?:\/\/[^\s/:@]{1,128}:[^\s/@]{4,256}@/iu,
] as const);

export interface ContainedCliAgentLauncherOptions {
  readonly provider: "codex" | "claude";
  readonly model: string;
  readonly workingDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly groupAbsenceTimeoutMs?: number;
}

export class AgentProcessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentProcessError";
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`${label} is invalid`);
  return result;
}

function configText(value: string, label: string, maximum: number): string {
  if (value.length < 1 || value.length > maximum || value.trim() !== value || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertCredentialSafe(value: string, label: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) throw new AgentProcessError(`${label} failed the credential-safety filter`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function providerEnvironment(provider: "codex" | "claude", source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const common = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const;
  const providerKeys = provider === "codex"
    ? (["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_ORGANIZATION", "OPENAI_PROJECT"] as const)
    : (["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"] as const);
  const result: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of [...common, ...providerKeys]) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) result[key] = value;
  }
  if (provider === "claude") {
    result.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
    result.CLAUDE_CODE_SKIP_PROMPT_HISTORY = "1";
    result.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
    result.DISABLE_AUTOUPDATER = "1";
  }
  return result;
}

function role(request: AgentLaunchRequest): "engineer" | "manager" | "verifier" {
  const value = request.context.mission.role;
  if (value !== "engineer" && value !== "manager" && value !== "verifier") {
    throw new AgentProcessError("Agent profile has an unsupported fixed role");
  }
  return value;
}

function prompt(request: AgentLaunchRequest): string {
  const fixedRole = role(request);
  const workflow = fixedRole === "engineer"
    ? [
        "Follow a research → plan → execute → test loop inside this one run.",
        "Repeat that loop only when a test fails, and stop only when the acceptance criteria pass, work fails, or a human answer is required.",
        "You may modify only the configured development workspace. Never deploy, approve production, or seek production credentials.",
      ]
    : fixedRole === "verifier"
      ? [
          "Perform independent read-only research, plan the verification, inspect or run non-modifying checks, and report evidence.",
          "Do not edit the workspace, approve production, or deploy.",
        ]
      : [
          "Perform read-only oversight of the supplied task, evidence, progress, and risks.",
          "Do not edit the workspace, approve production, or deploy.",
        ];
  return [
    `You are the fixed Cicada ${fixedRole} agent for ${request.context.mission.area}.`,
    request.context.mission.mission,
    ...workflow,
    "This is a single human-triggered run. Do not wait in a loop, emit heartbeats, create schedules, or continue after returning output.",
    "Return status completed only with a concrete result. Return waiting_for_human with exactly one focused humanQuestion when blocked on human judgment or missing authority.",
    "Proposed child tasks are proposals for humans; do not assign or start them yourself.",
    "Progress entries must be short, result-oriented updates. Do not include secrets or a technical transcript.",
    `Wake reason: ${request.wakeReason}`,
    "Bounded task context follows as JSON:",
    JSON.stringify(request.context),
    "Return only the required structured JSON result.",
  ].join("\n");
}

function codexArgs(options: ContainedCliAgentLauncherOptions, request: AgentLaunchRequest): readonly string[] {
  return Object.freeze([
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--config",
    'approval_policy="never"',
    "--config",
    "sandbox_workspace_write.network_access=false",
    "--config",
    'shell_environment_policy.inherit="none"',
    "--config",
    'shell_environment_policy.include_only=["PATH","HOME","TMPDIR","TEMP","TMP","LANG","LC_ALL"]',
    "--model",
    options.model,
    "--sandbox",
    role(request) === "engineer" ? "workspace-write" : "read-only",
    "--cd",
    options.workingDirectory,
    "--color",
    "never",
    "--json",
    "--output-schema",
    RESULT_SCHEMA_PATH,
    "-",
  ]);
}

function claudeArgs(options: ContainedCliAgentLauncherOptions, request: AgentLaunchRequest): readonly string[] {
  const fixedRole = role(request);
  const tools = fixedRole === "engineer"
    ? ["Read", "Glob", "Grep", "Edit", "Write", "Bash"]
    : fixedRole === "verifier"
      ? ["Read", "Glob", "Grep", "Bash"]
      : ["Read", "Glob", "Grep"];
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: ["~/"],
        allowRead: [options.workingDirectory],
        ...(fixedRole === "engineer"
          ? { allowWrite: [options.workingDirectory] }
          : { denyWrite: [options.workingDirectory] }),
      },
      credentials: {
        files: [
          { path: "~/.ssh", mode: "deny" },
          { path: "~/.aws", mode: "deny" },
          { path: "~/.config/gcloud", mode: "deny" },
        ],
        envVars: [
          { name: "ANTHROPIC_API_KEY", mode: "deny" },
          { name: "ANTHROPIC_AUTH_TOKEN", mode: "deny" },
          { name: "CODEX_API_KEY", mode: "deny" },
          { name: "OPENAI_API_KEY", mode: "deny" },
        ],
      },
    },
  };
  const args = [
    "--print",
    "--bare",
    "--safe-mode",
    "--disable-slash-commands",
    "--exclude-dynamic-system-prompt-sections",
    "--model",
    options.model,
    "--effort",
    "low",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--settings",
    JSON.stringify(settings),
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(RESULT_SCHEMA),
    "--permission-mode",
    fixedRole === "engineer" ? "acceptEdits" : fixedRole === "verifier" ? "dontAsk" : "plan",
    "--tools",
    tools.join(","),
  ];
  if (tools.includes("Bash")) args.push("--allowedTools", "Bash");
  return Object.freeze(args);
}

function decodeJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new AgentProcessError(`${label} was not valid JSON`);
  }
}

function outputObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AgentProcessError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function providerResult(provider: "codex" | "claude", stdout: string): unknown {
  if (provider === "claude") {
    const envelope = outputObject(decodeJson(stdout, "Claude response"), "Claude response");
    if (envelope.is_error === true || envelope.subtype === "error") throw new AgentProcessError("Claude reported a failed run");
    if (envelope.structured_output !== undefined) return envelope.structured_output;
    return typeof envelope.result === "string" ? decodeJson(envelope.result, "Claude result") : envelope.result;
  }
  let message: string | undefined;
  let completed = false;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    if (line.length > 1024 * 1024) throw new AgentProcessError("Codex emitted an oversized JSONL event");
    const event = outputObject(decodeJson(line, "Codex event"), "Codex event");
    if (event.type === "turn.failed" || event.type === "error") throw new AgentProcessError("Codex reported a failed run");
    if (event.type === "turn.completed") completed = true;
    if (event.type !== "item.completed") continue;
    const item = outputObject(event.item, "Codex item");
    if (item.type === "agent_message" && typeof item.text === "string") message = item.text;
  }
  if (!completed || message === undefined) throw new AgentProcessError("Codex ended without a completed structured result");
  return decodeJson(message, "Codex result");
}

function structuredOutcome(value: unknown): AgentRunOutcome {
  const item = outputObject(value, "Provider result");
  const expected = ["status", "progress", "result", "proposedChildTasks", "humanQuestion", "detail"].sort();
  const actual = Object.keys(item).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new AgentProcessError("Provider result has unexpected or missing fields");
  }
  if (!Array.isArray(item.progress) || !Array.isArray(item.proposedChildTasks)) {
    throw new AgentProcessError("Provider result collections are invalid");
  }
  const outputs: unknown[] = item.progress.map((body) => ({ type: "progress", body }));
  for (const proposal of item.proposedChildTasks) {
    const task = outputObject(proposal, "Proposed child task");
    outputs.push({
      type: "proposed_child_task",
      title: task.title,
      objective: task.objective,
      acceptanceCriteria: task.acceptanceCriteria,
    });
  }
  if (item.result !== null) outputs.push({ type: "result", body: item.result });
  if (item.humanQuestion !== null) outputs.push({ type: "human_question", question: item.humanQuestion });
  const outcome = parseAgentRunOutcome({ status: item.status, outputs, detail: item.detail });
  assertCredentialSafe(JSON.stringify(outcome), "Provider output");
  return outcome;
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
    if (process.platform === "win32") throw new AgentProcessError("Contained task agents require POSIX process groups; Windows is fail-closed");
    if (!isAbsolute(options.workingDirectory)) throw new Error("workingDirectory must be absolute");
    this.#options = {
      ...options,
      model: configText(options.model, "model", 256),
      workingDirectory: configText(options.workingDirectory, "workingDirectory", 4_096),
      timeoutMs: boundedInteger(options.timeoutMs, 60 * 60_000, 1_000, 24 * 60 * 60_000, "timeoutMs"),
      terminationGraceMs: boundedInteger(options.terminationGraceMs, 2_000, 10, 60_000, "terminationGraceMs"),
      groupAbsenceTimeoutMs: boundedInteger(options.groupAbsenceTimeoutMs, 5_000, 100, 60_000, "groupAbsenceTimeoutMs"),
      environment: providerEnvironment(options.provider, options.environment ?? process.env),
    };
  }

  async launch(request: AgentLaunchRequest): Promise<AgentRunHandle> {
    if (this.#active) throw new AgentProcessError("This launcher already owns an active agent process");
    assertCredentialSafe(JSON.stringify(request.context), "Agent context");
    const directory = await open(this.#options.workingDirectory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    await directory.close();
    const stdin = prompt(request);
    const command = this.#options.provider === "codex" ? "codex" : "claude";
    const args = this.#options.provider === "codex" ? codexArgs(this.#options, request) : claudeArgs(this.#options, request);
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: this.#options.workingDirectory,
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
    let termination: Promise<void> | null = null;
    const terminate = (): Promise<void> => {
      termination ??= terminateGroup(groupId, this.#options.terminationGraceMs, this.#options.groupAbsenceTimeoutMs);
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
      if (stdoutBytes > MAX_STDOUT_BYTES) { failBound("stdout"); return; }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunkValue: Buffer | string) => {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) { failBound("stderr"); return; }
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
          if (termination !== null) {
            try { await termination; } catch (error) { failure ??= error as Error; }
          } else if (groupPresent(groupId)) {
            failure ??= new AgentProcessError("Agent CLI left a descendant process after exit");
            try { await terminate(); } catch (error) { failure = error as Error; }
          }
          this.#active = false;
          if (failure !== null) { reject(failure); return; }
          if (code !== 0) {
            reject(new AgentProcessError(`Agent CLI exited unsuccessfully (${code ?? signal ?? "unknown"})`));
            return;
          }
          try {
            const output = Buffer.concat(stdout).toString("utf8");
            const diagnostic = Buffer.concat(stderr).toString("utf8");
            assertCredentialSafe(diagnostic, "Agent diagnostics");
            resolve(structuredOutcome(providerResult(this.#options.provider, output)));
          } catch (error) {
            reject(error);
          }
        })();
      });
    });
    return Object.freeze({
      completion,
      interrupt: async (reason: string): Promise<void> => {
        assertCredentialSafe(reason, "Interrupt reason");
        failure ??= new AgentProcessError("Agent process was interrupted directly");
        await terminate();
      },
    });
  }
}
