import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  ActivityBuffer,
  activityFromProviderLine,
  estimateActivity,
  estimateMinutesFromProviderLine,
  phaseActivity,
  phaseSignalFromProviderLine,
} from "./provider-activity.js";
import { parseAgentRunOutcome } from "./schema.js";
import type { AgentLaunchRequest, AgentLauncher, AgentRunHandle, AgentRunOutcome } from "./types.js";

const RESULT_SCHEMA_PATH = fileURLToPath(new URL("./agent-result.schema.json", import.meta.url));
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;
const GROUP_POLL_MS = 20;
const MAX_QUEUED_ACTIVITY = 64;

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
    expectedAgentMinutes: { type: ["integer", "null"], minimum: 15, maximum: 10_080, multipleOf: 15 },
    phases: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          phaseId: { type: ["string", "null"], pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$" },
          title: { type: "string", minLength: 1, maxLength: 240 },
          stage: { type: "string", enum: ["research", "planning", "execution", "testing", "review", "done"] },
          status: { type: "string", enum: ["pending", "in_progress", "blocked", "completed", "failed"] },
          parallelGroup: { type: ["string", "null"], pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$" },
          orderKey: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        },
        required: ["phaseId", "title", "stage", "status", "parallelGroup", "orderKey"],
      },
    },
    humanQuestion: { type: ["string", "null"], maxLength: 2_000 },
    handoff: {
      anyOf: [
        { type: "null" },
        {
          type: "object", additionalProperties: false,
          properties: {
            outcome: { type: "string", enum: ["passed", "failed", "needs_input"] },
            summary: { type: "string", minLength: 1, maxLength: 4_000 },
            evidence: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 2_000 } },
            artifactIds: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 128 } },
            acceptanceCriteria: {
              type: "array", maxItems: 32, items: {
                type: "object", additionalProperties: false,
                properties: {
                  criterion: { type: "string", minLength: 1, maxLength: 1_000 },
                  passed: { type: "boolean" },
                  evidence: { type: "string", minLength: 1, maxLength: 2_000 },
                },
                required: ["criterion", "passed", "evidence"],
              },
            },
            blockers: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 2_000 } },
            recommendedReturnStage: { type: ["string", "null"], enum: ["research", "planning", "implementation", "testing", "verification", null] },
          },
          required: ["outcome", "summary", "evidence", "artifactIds", "acceptanceCriteria", "blockers", "recommendedReturnStage"],
        },
      ],
    },
    workflowPlan: {
      anyOf: [
        { type: "null" },
        {
          type: "object", additionalProperties: false,
          properties: {
            objective: { type: "string", minLength: 1, maxLength: 8_000 },
            assumptions: { type: "array", maxItems: 64, items: { type: "string", minLength: 1, maxLength: 2_000 } },
            acceptanceCriteria: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1, maxLength: 2_000 } },
            nodes: {
              type: "array", minItems: 1, maxItems: 64, items: {
                type: "object", additionalProperties: false,
                properties: {
                  nodeId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$" },
                  title: { type: "string", minLength: 1, maxLength: 512 },
                  objective: { type: "string", minLength: 1, maxLength: 4_000 },
                  acceptanceCriteria: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1, maxLength: 2_000 } },
                  dependencyNodeIds: { type: "array", maxItems: 64, items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$" } },
                  stageTemplate: {
                    type: "array", minItems: 1, maxItems: 5, uniqueItems: true,
                    items: { type: "string", enum: ["research", "planning", "implementation", "testing", "verification"] },
                  },
                },
                required: ["nodeId", "title", "objective", "acceptanceCriteria", "dependencyNodeIds", "stageTemplate"],
              },
            },
          },
          required: ["objective", "assumptions", "acceptanceCriteria", "nodes"],
        },
      ],
    },
    detail: { type: "string", minLength: 1, maxLength: 2_000 },
  },
  required: [
    "status", "progress", "result", "proposedChildTasks", "expectedAgentMinutes", "phases", "humanQuestion", "handoff", "workflowPlan", "detail",
  ],
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

class ActivityChannel implements AsyncIterable<string> {
  readonly #queued: string[] = [];
  readonly #waiters: Array<(result: IteratorResult<string>) => void> = [];
  #closed = false;
  #iteratorCreated = false;

  publish(value: string): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value });
      return;
    }
    if (this.#queued.length === MAX_QUEUED_ACTIVITY) this.#queued.shift();
    this.#queued.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    if (this.#iteratorCreated) throw new Error("Agent activity stream can only be consumed once");
    this.#iteratorCreated = true;
    return { next: () => this.#next() };
  }

  #next(): Promise<IteratorResult<string>> {
    const value = this.#queued.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
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
  const planningRun = request.context.task.title.startsWith("Plan workflow:");
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
      : planningRun ? [
          "Refine the supplied request into a small dependency-aware workflow plan for human confirmation.",
          "Do not implement, assign, or start the proposed nodes.",
          "Call out assumptions explicitly and make every acceptance criterion observable.",
        ] : [
          "Perform read-only oversight of the supplied task, evidence, progress, and risks.",
          "Return a clear READY_FOR_HUMAN_CHECK or CHANGES_REQUESTED recommendation supported by the supplied evidence.",
          "Do not edit the workspace, approve production, or deploy.",
        ];
  return [
    `You are the fixed Cicada ${fixedRole} agent for ${request.context.mission.area}.`,
    request.context.mission.mission,
    ...workflow,
    "This is a single event-triggered run. Do not wait in a loop, emit heartbeats, create schedules, or continue after returning output.",
    "Return status completed only with a concrete result. Return waiting_for_human with exactly one focused humanQuestion when blocked on human judgment or missing authority.",
    "Proposed child tasks are proposals for humans; do not assign or start them yourself.",
    "Progress entries must be short, result-oriented updates. Do not include secrets or a technical transcript.",
    "When workflow context is present, return a compact handoff with criterion results, evidence references, artifact IDs, blockers, and a recommended return stage. Otherwise return handoff null.",
    "When the task asks you to plan a workflow, return workflowPlan with a dependency hierarchy and unique ordered stages ending in verification. Otherwise return workflowPlan null.",
    "After inspecting the task, estimate only the agent's remaining work in 15-minute intervals. Return expectedAgentMinutes null until there is enough evidence; null leaves any current estimate unchanged.",
    "Use phases for durable work stages. Return only phases that should be created or changed: copy an active existing phaseId from context to update it, or use null to create one. Phases with the same non-null parallelGroup may run concurrently.",
    "When a phase completes, keep its semantic research, planning, execution, testing, or review stage and set status completed. The legacy done stage may appear in old context but should not be created.",
    "Completed and failed phases are immutable history. Every repeated research-plan-execute-test loop must create new phase rows: use null phaseId in terminal output and fresh live keys rather than reusing a completed phaseId or key.",
    "As soon as planning gives you enough evidence, publish the remaining-work estimate before implementation by running a command that prints exactly STEWARD_ESTIMATE_MINUTES=N on its own line, where N is a 15-minute interval. Do this again only if new evidence materially changes the estimate.",
    "Make planned phases visible while they run by printing one exact line per state change: STEWARD_PHASE_JSON={\"key\":\"cycle-1-execution\",\"title\":\"Short user-facing title\",\"stage\":\"execution\",\"status\":\"in_progress\",\"parallelGroup\":null}. Reuse a key only while that phase is active; after completion, use a fresh key for every later cycle. Use the same non-null parallelGroup for concurrent work. Do not repeat these live phases in terminal phases.",
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
    // Bare mode deliberately skips OAuth/keychain reads, so enable it only when explicit API-key auth is available.
    ...(typeof options.environment?.ANTHROPIC_API_KEY === "string" ? ["--bare"] : []),
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
    "stream-json",
    "--verbose",
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
    let envelope: Record<string, unknown> | null = null;
    for (const line of stdout.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      if (line.length > 1024 * 1024) throw new AgentProcessError("Claude emitted an oversized stream event");
      const event = outputObject(decodeJson(line, "Claude stream event"), "Claude stream event");
      if (event.type === "result") envelope = event;
    }
    if (envelope === null) throw new AgentProcessError("Claude ended without a terminal result event");
    if (
      envelope.is_error === true ||
      typeof envelope.subtype === "string" && envelope.subtype.toLowerCase().includes("error")
    ) {
      throw new AgentProcessError("Claude reported a failed run");
    }
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
  const expected = [
    "status", "progress", "result", "proposedChildTasks", "expectedAgentMinutes", "phases", "humanQuestion",
    ...("handoff" in item ? ["handoff"] : []),
    ...("workflowPlan" in item ? ["workflowPlan"] : []),
    "detail",
  ].sort();
  const actual = Object.keys(item).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new AgentProcessError("Provider result has unexpected or missing fields");
  }
  if (!Array.isArray(item.progress) || !Array.isArray(item.proposedChildTasks) || !Array.isArray(item.phases)) {
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
  const outcome = parseAgentRunOutcome({
    status: item.status,
    outputs,
    expectedAgentMinutes: item.expectedAgentMinutes,
    phases: item.phases,
    detail: item.detail,
    handoff: item.handoff ?? null,
    workflowPlan: item.workflowPlan ?? null,
  });
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
          finishActivity();
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
      activity,
      interrupt: async (_reason: string): Promise<void> => {
        failure ??= new AgentProcessError("Agent process was interrupted directly");
        await terminate();
      },
    });
  }
}
