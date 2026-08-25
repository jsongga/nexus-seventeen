import type { AgentRole } from "#shared/task-board-contract";
import type { ProviderArgumentOptions } from "../task-worker/agent-envelope.js";
import type { RuntimeAdapter } from "./adapter.js";
import { AgentProcessError } from "./errors.js";
import type { RuntimeEvent } from "./events.js";
import { RuntimeCapabilityError, type RuntimeProfile } from "./profiles.js";

const MAX_EVENT_CHARACTERS = 256 * 1024;
const MAX_RESULT_EVENT_CHARACTERS = 1024 * 1024;
const FAILURE_STATES = new Set(["cancelled", "error", "failed", "rejected"]);

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
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
  if (item.is_error === true || item.error !== undefined && item.error !== null) return true;
  if (typeof item.exit_code === "number" && item.exit_code !== 0) return true;
  return typeof item.status === "string" && FAILURE_STATES.has(item.status.toLowerCase());
}

function frozenEvent(event: RuntimeEvent): readonly RuntimeEvent[] {
  return Object.freeze([Object.freeze(event)]);
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function errorDetail(event: JsonObject): string {
  if (typeof event.message === "string") return event.message;
  if (typeof event.detail === "string") return event.detail;
  if (typeof event.error === "string") return event.error;
  const error = object(event.error);
  if (typeof error?.message === "string") return error.message;
  return "Codex reported a failed run";
}

function codexEvents(line: string): readonly RuntimeEvent[] {
  const event = eventFromLine(line);
  if (event === null || typeof event.type !== "string") return Object.freeze([]);
  switch (event.type) {
    case "thread.started":
      return frozenEvent({ type: "stage_started" });
    case "turn.started":
      return frozenEvent({ type: "tool_call", name: "work", detail: "" });
    case "item.started":
    case "item.completed": {
      const item = object(event.item);
      if (item === null) return Object.freeze([]);
      if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
        return frozenEvent({ type: "message_delta", text: item.text });
      }
      const itemType = typeof item.type === "string" ? item.type : "";
      const name = itemType === "command_execution" ? "command" : itemType;
      switch (itemType) {
        case "reasoning":
        case "todo_list":
        case "plan":
        case "file_change":
        case "web_search":
        case "mcp_tool_call":
        case "tool_call":
        case "collaboration_tool_call":
        case "command_execution":
          return event.type === "item.started"
            ? frozenEvent({
                type: "tool_call",
                name,
                detail: itemType === "command_execution" ? text(item.command) : "",
              })
            : frozenEvent({
                type: "tool_result",
                name,
                output: itemType === "command_execution"
                  ? text(item.aggregated_output)
                  : itemType === "mcp_tool_call" || itemType === "tool_call" || itemType === "collaboration_tool_call"
                    ? text(item.result ?? item.output)
                    : "",
                failed: failed(item),
              });
        default:
          return Object.freeze([]);
      }
    }
    case "turn.completed":
      return frozenEvent({ type: "stage_finished" });
    case "turn.failed":
    case "error":
      return frozenEvent({ type: "error", detail: errorDetail(event) });
    default:
      return Object.freeze([]);
  }
}

function codexSandbox(profile: RuntimeProfile, role: AgentRole): string {
  if (profile.runtime !== "codex") {
    throw new RuntimeCapabilityError("codex", role, `profile ${profile.runtime} does not match the adapter`);
  }
  const sandbox = profile.roles[role]?.sandbox;
  if (sandbox !== "workspace-write" && sandbox !== "read-only") {
    throw new RuntimeCapabilityError(
      profile.runtime,
      role,
      sandbox === undefined ? "the role is missing from its capability profile" : `unknown sandbox ${sandbox}`,
    );
  }
  return sandbox;
}

function codexArgs(
  options: ProviderArgumentOptions,
  fixedRole: AgentRole,
  profile: RuntimeProfile,
): readonly string[] {
  const includedEnvironment = options.proxyEgress === true
    ? ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY"]
    : ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"];
  return Object.freeze([
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--config",
    'approval_policy="never"',
    "--config",
    `sandbox_workspace_write.network_access=${options.proxyEgress === true ? "true" : "false"}`,
    "--config",
    'shell_environment_policy.inherit="none"',
    "--config",
    `shell_environment_policy.include_only=${JSON.stringify(includedEnvironment)}`,
    "--model",
    options.model,
    "--sandbox",
    codexSandbox(profile, fixedRole),
    "--cd",
    options.workingDirectory,
    "--color",
    "never",
    "--json",
    "--output-schema",
    options.schemaPath,
    "-",
  ]);
}

function codexEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = [
    "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_ORGANIZATION", "OPENAI_PROJECT",
  ] as const;
  const result: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) result[key] = value;
  }
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

function codexResult(stdout: string): unknown {
  let message: string | undefined;
  let completed = false;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    if (line.length > MAX_RESULT_EVENT_CHARACTERS) throw new AgentProcessError("Codex emitted an oversized JSONL event");
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

export const codexAdapter: RuntimeAdapter = Object.freeze({
  runtime: "codex",
  assertRole(profile: RuntimeProfile, role: AgentRole): void {
    codexSandbox(profile, role);
  },
  args: codexArgs,
  environment: codexEnvironment,
  events: codexEvents,
  result: codexResult,
});
