import { fileURLToPath } from "node:url";
import type { ModelRouteDecision } from "@cicada/steward-model-routing";
import {
  authorizeProviderPhase,
  type ProviderAdapter,
  type ProviderAdapterConfig,
  type ProviderInterruptContext,
  type ProviderStepInput,
  type ProviderStepResult,
} from "@cicada/steward-supervisor";
import {
  nodeCommandRunner,
  providerCliEnvironment,
  type CommandInvocation,
  type CommandRunner,
} from "./process.js";
import { providerPrompt } from "./prompt.js";
import { parseClaudeResult, parseCodexResult } from "./result.js";
import {
  createEngineerModelSelector,
  engineerRouteCurrentAction,
  type EngineerModelSelector,
} from "./routing.js";

const RESULT_SCHEMA_PATH = fileURLToPath(
  new URL("../../provider-result.schema.json", import.meta.url),
);
const RESULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    journal: { type: "string", minLength: 1, maxLength: 1_200 },
    testOutcome: { type: ["string", "null"], enum: ["passed", "failed", null] },
    resultOverview: { type: ["string", "null"], maxLength: 2_000 },
  },
  required: ["journal", "testOutcome", "resultOverview"],
} as const);

function writablePhase(phase: ProviderStepInput["phase"]): boolean {
  return phase === "execute";
}

function codexArgs(
  config: ProviderAdapterConfig,
  input: ProviderStepInput,
  modelId: string,
): readonly string[] {
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
    "--config",
    "shell_environment_policy.ignore_default_excludes=false",
    "--model",
    modelId,
    "--sandbox",
    writablePhase(input.phase) ? "workspace-write" : "read-only",
    "--cd",
    config.workingDirectory,
    "--color",
    "never",
    "--json",
    "--output-schema",
    RESULT_SCHEMA_PATH,
    "-",
  ]);
}

function claudeTools(input: ProviderStepInput): readonly string[] {
  switch (input.phase) {
    case "research":
    case "plan":
      return Object.freeze(["Read", "Glob", "Grep"]);
    case "execute":
      return Object.freeze(["Read", "Glob", "Grep", "Edit", "Write", "Bash"]);
    case "test":
      return Object.freeze(["Read", "Glob", "Grep", "Bash"]);
  }
}

function claudeArgs(
  config: ProviderAdapterConfig,
  input: ProviderStepInput,
  modelId: string,
): readonly string[] {
  const tools = claudeTools(input);
  const sandboxSettings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: ["~/"],
        allowRead: [config.workingDirectory],
        ...(writablePhase(input.phase)
          ? { allowWrite: [config.workingDirectory] }
          : { denyWrite: [config.workingDirectory] }),
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
        ],
      },
    },
  } as const;
  const args = [
    "--print",
    "--bare",
    "--safe-mode",
    "--disable-slash-commands",
    "--exclude-dynamic-system-prompt-sections",
    "--model",
    modelId,
    "--effort",
    "low",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--settings",
    JSON.stringify(sandboxSettings),
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(RESULT_SCHEMA),
    "--permission-mode",
    input.phase === "execute" ? "acceptEdits" : input.phase === "test" ? "dontAsk" : "plan",
    "--tools",
    tools.join(","),
  ];
  if (input.phase === "execute" || input.phase === "test") args.push("--allowedTools", "Bash");
  return Object.freeze(args);
}

function buildRoutedCliInvocation(
  config: ProviderAdapterConfig,
  input: ProviderStepInput,
  route: ModelRouteDecision,
  environment: NodeJS.ProcessEnv,
): Omit<CommandInvocation, "signal"> {
  if (
    route.provider !== config.providerName ||
    route.model.provider !== route.provider
  ) {
    throw new Error("Selected model route does not match the configured provider");
  }
  const provider = route.provider;
  return Object.freeze({
    command: provider === "codex" ? "codex" : "claude",
    args: provider === "codex"
      ? codexArgs(config, input, route.model.modelId)
      : claudeArgs(config, input, route.model.modelId),
    cwd: config.workingDirectory,
    env: providerCliEnvironment(provider, environment),
    stdin: providerPrompt(input),
  });
}

export function buildCliInvocation(
  config: ProviderAdapterConfig,
  input: ProviderStepInput,
  environment: NodeJS.ProcessEnv = process.env,
): Omit<CommandInvocation, "signal"> {
  const route = createEngineerModelSelector(config, environment).select(input);
  return buildRoutedCliInvocation(config, input, route, environment);
}

function assertAuthorized(config: ProviderAdapterConfig, input: ProviderStepInput): void {
  if (config.role !== "engineer") throw new Error("The modifying RPET adapter is restricted to engineers");
  const expected = authorizeProviderPhase(config.role, input.phase);
  if (
    input.authorization.role !== expected.role ||
    input.authorization.phase !== expected.phase ||
    input.authorization.operations.length !== expected.operations.length ||
    input.authorization.operations.some((operation, index) => operation !== expected.operations[index])
  ) {
    throw new Error("Provider step authorization does not match the fixed role policy");
  }
}

export class CliProviderAdapter implements ProviderAdapter {
  readonly providerName = "codex" as const;
  readonly model: string;
  readonly #config: ProviderAdapterConfig;
  readonly #runner: CommandRunner;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #modelSelector: EngineerModelSelector;
  #active: AbortController | null = null;
  #activeCompletion: Promise<ProviderStepResult> | null = null;

  constructor(
    config: ProviderAdapterConfig,
    runner: CommandRunner = nodeCommandRunner,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    if (config.role !== "engineer") throw new Error("CLI provider adapters may only own engineer RPET lanes");
    this.#modelSelector = createEngineerModelSelector(config, environment);
    this.#config = Object.freeze({ ...config });
    this.model = config.model;
    this.#runner = runner;
    this.#environment = Object.freeze({ ...environment });
  }

  async executeStep(input: ProviderStepInput): Promise<ProviderStepResult> {
    if (this.#active) throw new Error("A provider step is already active");
    assertAuthorized(this.#config, input);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    input.signal.addEventListener("abort", forwardAbort, { once: true });
    this.#active = controller;

    const completion = (async () => {
      const route = this.#modelSelector.select(input);
      await input.reportCurrentAction(engineerRouteCurrentAction(input, route));
      const invocation = buildRoutedCliInvocation(this.#config, input, route, this.#environment);
      const result = await this.#runner.run({ ...invocation, signal: controller.signal });
      if (result.exitCode !== 0) {
        throw new Error(`Provider CLI exited unsuccessfully (${result.exitCode})`);
      }
      return route.provider === "codex"
        ? parseCodexResult(result.stdout, input.phase)
        : parseClaudeResult(result.stdout, input.phase);
    })();
    this.#activeCompletion = completion;
    try {
      return await completion;
    } finally {
      input.signal.removeEventListener("abort", forwardAbort);
      if (this.#active === controller) this.#active = null;
      if (this.#activeCompletion === completion) this.#activeCompletion = null;
    }
  }

  async settleInterrupt(_context: ProviderInterruptContext): Promise<void> {
    this.#active?.abort();
    await this.#activeCompletion?.catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    this.#active?.abort();
    await this.#activeCompletion?.catch(() => undefined);
  }
}

export function createProviderAdapter(config: ProviderAdapterConfig): ProviderAdapter {
  return new CliProviderAdapter(config);
}
