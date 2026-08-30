import type { AgentRole } from "#shared/task-board-contract";
import { RESULT_SCHEMA, type ProviderArgumentOptions } from "../task-worker/agent-envelope.js";
import { AgentProcessError, type RuntimeAdapter, type RuntimeEvent } from "./adapter.js";
import { RuntimeCapabilityError, type RuntimeProfile } from "./profiles.js";

const MAX_EVENT_CHARACTERS = 256 * 1024;
const MAX_RESULT_EVENT_CHARACTERS = 1024 * 1024;
const FAILURE_STATES = new Set(["cancelled", "error", "failed", "rejected"]);

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function eventFromLine(line: string): JsonObject | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EVENT_CHARACTERS) return null;
  try {
    return object(JSON.parse(trimmed) as unknown);
  } catch {
    return null;
  }
}

function failed(item: JsonObject): boolean {
  if (item.is_error === true || (item.error !== undefined && item.error !== null)) return true;
  if (typeof item.exit_code === "number" && item.exit_code !== 0) return true;
  return typeof item.status === "string" && FAILURE_STATES.has(item.status.toLowerCase());
}

function frozenEvents(events: RuntimeEvent[]): readonly RuntimeEvent[] {
  return Object.freeze(events.map((event) => Object.freeze(event)));
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return jsonText(value);
  // Accepted divergence from the legacy parser: flattening makes derive.ts select the last
  // valid STEWARD marker across sub-blocks, while the old block-by-block scan selected the first.
  return value
    .map((entry) => {
      const block = object(entry);
      return block?.type === "text" && typeof block.text === "string" ? block.text : jsonText(entry);
    })
    .join("\n");
}

function assistantEvents(content: unknown): RuntimeEvent[] {
  if (!Array.isArray(content)) return [];
  const events: RuntimeEvent[] = [];
  for (const entry of content) {
    const block = object(entry);
    if (block?.type === "text" && typeof block.text === "string") {
      events.push({ type: "message_delta", text: block.text });
    } else if (block?.type === "tool_use" && typeof block.name === "string") {
      events.push({ type: "tool_call", name: block.name, detail: jsonText(block.input) });
    }
  }
  return events;
}

function userEvents(content: unknown): RuntimeEvent[] {
  if (!Array.isArray(content)) return [];
  const events: RuntimeEvent[] = [];
  for (const entry of content) {
    const block = object(entry);
    if (block?.type === "tool_result") {
      events.push({ type: "tool_result", name: "tool", output: contentText(block.content), failed: failed(block) });
    }
  }
  return events;
}

function streamEvents(value: unknown): RuntimeEvent[] {
  const event = object(value);
  if (event?.type === "message_start") {
    return [{ type: "tool_call", name: "work", detail: "" }];
  }
  if (event?.type === "content_block_delta") {
    const delta = object(event.delta);
    return delta?.type === "text_delta" && typeof delta.text === "string"
      ? [{ type: "message_delta", text: delta.text }]
      : [];
  }
  if (event?.type !== "content_block_start") return [];
  const block = object(event.content_block);
  return block?.type === "tool_use" && typeof block.name === "string"
    ? [{ type: "tool_call", name: block.name, detail: jsonText(block.input) }]
    : [];
}

function errorDetail(event: JsonObject): string {
  if (typeof event.result === "string") return event.result;
  if (typeof event.message === "string") return event.message;
  if (typeof event.detail === "string") return event.detail;
  if (typeof event.error === "string") return event.error;
  const error = object(event.error);
  if (typeof error?.message === "string") return error.message;
  return "Claude reported a failed run";
}

function claudeEvents(line: string): readonly RuntimeEvent[] {
  const event = eventFromLine(line);
  if (event === null || typeof event.type !== "string") return Object.freeze([]);
  switch (event.type) {
    case "system":
      return event.subtype === "init" ? frozenEvents([{ type: "stage_started" }]) : Object.freeze([]);
    case "assistant":
      return frozenEvents(assistantEvents(object(event.message)?.content));
    case "user":
      return frozenEvents(userEvents(object(event.message)?.content));
    case "stream_event":
      return frozenEvents(streamEvents(event.event));
    case "tool_progress":
      return frozenEvents([{ type: "tool_call", name: "progress", detail: jsonText(event.tool_name) }]);
    case "tool_use_summary":
      return frozenEvents([{ type: "tool_result", name: "summary", output: "" }]);
    case "result":
      return failed(event) || (typeof event.subtype === "string" && event.subtype.toLowerCase().includes("error"))
        ? frozenEvents([{ type: "error", detail: errorDetail(event) }])
        : frozenEvents([{ type: "stage_finished" }]);
    default:
      return Object.freeze([]);
  }
}

function claudeSandbox(profile: RuntimeProfile, role: AgentRole): string {
  if (profile.runtime !== "claude") {
    throw new RuntimeCapabilityError("claude", role, `profile ${profile.runtime} does not match the adapter`);
  }
  const sandbox = profile.roles[role]?.sandbox;
  if (sandbox !== "acceptEdits" && sandbox !== "dontAsk" && sandbox !== "plan") {
    throw new RuntimeCapabilityError(
      profile.runtime,
      role,
      sandbox === undefined ? "the role is missing from its capability profile" : `unknown sandbox ${sandbox}`
    );
  }
  return sandbox;
}

function claudeArgs(
  options: ProviderArgumentOptions,
  fixedRole: AgentRole,
  profile: RuntimeProfile
): readonly string[] {
  const tools =
    fixedRole === "engineer"
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
    ...(options.bareApiKey ? ["--bare"] : []),
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
    claudeSandbox(profile, fixedRole),
    "--tools",
    tools.join(","),
  ];
  if (tools.includes("Bash")) args.push("--allowedTools", "Bash");
  return Object.freeze(args);
}

function claudeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CONFIG_DIR",
  ] as const;
  const result: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) result[key] = value;
  }
  result.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  result.CLAUDE_CODE_SKIP_PROMPT_HISTORY = "1";
  result.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
  result.DISABLE_AUTOUPDATER = "1";
  return result;
}

function decodeJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new AgentProcessError(`${label} was not valid JSON`);
  }
}

function outputObject(value: unknown, label: string): JsonObject {
  const result = object(value);
  if (result === null) throw new AgentProcessError(`${label} is invalid`);
  return result;
}

function claudeResult(stdout: string): unknown {
  let envelope: JsonObject | null = null;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    if (line.length > MAX_RESULT_EVENT_CHARACTERS)
      throw new AgentProcessError("Claude emitted an oversized stream event");
    const event = outputObject(decodeJson(line, "Claude stream event"), "Claude stream event");
    if (event.type === "result") envelope = event;
  }
  if (envelope === null) throw new AgentProcessError("Claude ended without a terminal result event");
  if (
    envelope.is_error === true ||
    (typeof envelope.subtype === "string" && envelope.subtype.toLowerCase().includes("error"))
  ) {
    throw new AgentProcessError("Claude reported a failed run");
  }
  if (envelope.structured_output !== undefined) return envelope.structured_output;
  return typeof envelope.result === "string" ? decodeJson(envelope.result, "Claude result") : envelope.result;
}

export const claudeAdapter: RuntimeAdapter = Object.freeze({
  runtime: "claude",
  assertRole(profile: RuntimeProfile, role: AgentRole): void {
    claudeSandbox(profile, role);
  },
  args: claudeArgs,
  environment: claudeEnvironment,
  events: claudeEvents,
  result: claudeResult,
});
