const MAX_EVENT_CHARACTERS = 256 * 1024;
const DEFAULT_MAXIMUM_ACTIVITY_CHARACTERS = 160;
const FAILURE_STATES = new Set(["cancelled", "error", "failed", "rejected"]);

type JsonObject = Record<string, unknown>;

export type ActivityProvider = "codex" | "claude";

export interface ActivityBufferOptions {
  readonly minimumIntervalMs?: number;
  readonly dedupeWindowMs?: number;
  readonly maximumCharacters?: number;
}

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

function codexItemActivity(eventType: string, item: JsonObject): string | null {
  const itemType = typeof item.type === "string" ? item.type : "";
  const completed = eventType === "item.completed";
  const started = eventType === "item.started";
  if (!started && !completed) return null;

  switch (itemType) {
    case "reasoning":
      return started ? "Reviewing the task and choosing the next safe step." : null;
    case "todo_list":
    case "plan":
      return completed ? "Prepared the implementation plan." : "Preparing the implementation plan.";
    case "command_execution":
      if (!completed) return "Running a development check.";
      return failed(item) ? "A development check found more work." : "A development check completed.";
    case "file_change":
      return completed ? "Updated the implementation." : "Updating the implementation.";
    case "web_search":
      return completed ? "Relevant research was gathered." : "Researching relevant information.";
    case "mcp_tool_call":
    case "tool_call":
    case "collaboration_tool_call":
      if (!completed) return "Gathering information with an approved tool.";
      return failed(item) ? "An information-gathering step found more work." : "Information gathering completed.";
    case "agent_message":
      // Agent messages may contain the prompt, reasoning, or final structured result.
      return null;
    default:
      return null;
  }
}

/**
 * Converts one complete Codex JSONL event into a fixed, non-transcript activity.
 * Event payload text, commands, paths, prompts, and reasoning are never copied.
 */
export function activityFromCodexJsonLine(line: string): string | null {
  const event = eventFromLine(line);
  if (event === null || typeof event.type !== "string") return null;
  switch (event.type) {
    case "thread.started":
      return "Agent process started.";
    case "turn.started":
      return "Work started.";
    case "turn.completed":
      return "Work finished; preparing the recorded result.";
    case "turn.failed":
    case "error":
      return "The run encountered a problem and needs attention.";
    case "item.started":
    case "item.completed": {
      const item = object(event.item);
      return item === null ? null : codexItemActivity(event.type, item);
    }
    default:
      return null;
  }
}

function claudeToolActivity(name: unknown): string {
  if (typeof name !== "string") return "Using an approved development tool.";
  switch (name.toLowerCase()) {
    case "read":
    case "glob":
    case "grep":
      return "Inspecting the relevant code and context.";
    case "edit":
    case "write":
    case "notebookedit":
      return "Updating the implementation.";
    case "bash":
    case "shell":
      return "Running a development check.";
    case "webfetch":
    case "websearch":
      return "Researching relevant information.";
    case "todowrite":
    case "enterplanmode":
    case "exitplanmode":
      return "Preparing the implementation plan.";
    case "task":
    case "agent":
      return "Delegating a focused investigation.";
    case "skill":
      return "Applying the configured development workflow.";
    case "askuserquestion":
      return "Preparing a focused question for human input.";
    default:
      return "Using an approved development tool.";
  }
}

function claudeContentActivity(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const entry of content) {
    const block = object(entry);
    if (block === null || typeof block.type !== "string") continue;
    if (block.type === "tool_use") return claudeToolActivity(block.name);
    if (block.type === "tool_result") {
      return failed(block) ? "A development step found more work." : "A development step completed.";
    }
  }
  return null;
}

function claudeMessageActivity(event: JsonObject): string | null {
  const message = object(event.message);
  return message === null ? null : claudeContentActivity(message.content);
}

function claudeStreamEventActivity(value: unknown): string | null {
  const event = object(value);
  if (event === null || typeof event.type !== "string") return null;
  if (event.type === "message_start") return "Work started.";
  if (event.type !== "content_block_start") return null;
  const block = object(event.content_block);
  if (block?.type !== "tool_use") return null;
  return claudeToolActivity(block.name);
}

/**
 * Converts one complete Claude stream-json event into a fixed activity string.
 * Assistant text, thinking deltas, tool inputs/results, and result text are ignored.
 */
export function activityFromClaudeStreamLine(line: string): string | null {
  const event = eventFromLine(line);
  if (event === null || typeof event.type !== "string") return null;
  switch (event.type) {
    case "system":
      return event.subtype === "init" ? "Agent process started." : null;
    case "stream_event":
      return claudeStreamEventActivity(event.event);
    case "assistant":
    case "user":
      return claudeMessageActivity(event);
    case "tool_progress":
      return claudeToolActivity(event.tool_name);
    case "tool_use_summary":
      return "A development step completed.";
    case "result":
      return failed(event) || typeof event.subtype === "string" && event.subtype.toLowerCase().includes("error")
        ? "The run encountered a problem and needs attention."
        : "Work finished; preparing the recorded result.";
    default:
      return null;
  }
}

export function activityFromProviderLine(provider: ActivityProvider, line: string): string | null {
  return provider === "codex"
    ? activityFromCodexJsonLine(line)
    : activityFromClaudeStreamLine(line);
}

function positiveInteger(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} is invalid`);
  return value;
}

/** Defense-in-depth for caller-authored lifecycle labels; provider payloads should never be passed here. */
export function sanitizeActivity(value: string, maximumCharacters = DEFAULT_MAXIMUM_ACTIVITY_CHARACTERS): string | null {
  positiveInteger(maximumCharacters, "maximumCharacters", 32);
  let result = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\bhttps?:\/\/[^\s)>\]]+/giu, "[link redacted]")
    .replace(/\b(?:Bearer\s+)?(?:sk-(?:proj-|ant-)?|github_pat_|gh[pousr]_|glpat-|npm_|xox[baprs]-)[A-Za-z0-9._~+\/-]{8,}/gu, "[credential redacted]")
    .replace(/(^|[\s("'`])\/(?:Users|home|var|tmp|private|opt|srv|workspaces?|repos?|mnt|Volumes)\/[^\s"'`),;]*/gu, "$1[local path]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, "[local path]")
    .replace(/\s+/gu, " ")
    .trim();
  if (result.length === 0) return null;
  if (result.length > maximumCharacters) result = `${result.slice(0, maximumCharacters - 1).trimEnd()}…`;
  return result;
}

/**
 * Coalesces noisy provider events without a heartbeat or timer. Call `flush`
 * while the stream is active and `drain` once when the provider stream ends.
 */
export class ActivityBuffer {
  readonly #minimumIntervalMs: number;
  readonly #dedupeWindowMs: number;
  readonly #maximumCharacters: number;
  readonly #recent = new Map<string, number>();
  #lastObservedAt: number | null = null;
  #lastEmittedAt: number | null = null;
  #pending: string | null = null;

  constructor(options: ActivityBufferOptions = {}) {
    this.#minimumIntervalMs = positiveInteger(options.minimumIntervalMs ?? 1_500, "minimumIntervalMs", 0);
    this.#dedupeWindowMs = positiveInteger(options.dedupeWindowMs ?? 30_000, "dedupeWindowMs", 0);
    this.#maximumCharacters = positiveInteger(options.maximumCharacters ?? DEFAULT_MAXIMUM_ACTIVITY_CHARACTERS, "maximumCharacters", 32);
  }

  get hasPending(): boolean {
    return this.#pending !== null;
  }

  push(activity: string | null, observedAt = Date.now()): string | null {
    this.#observeTime(observedAt);
    if (activity === null) return this.#emitPendingIfReady(observedAt);
    const safe = sanitizeActivity(activity, this.#maximumCharacters);
    if (safe === null) return this.#emitPendingIfReady(observedAt);
    this.#prune(observedAt);
    const prior = this.#recent.get(safe);
    if (prior !== undefined && observedAt - prior <= this.#dedupeWindowMs) {
      return this.#emitPendingIfReady(observedAt);
    }
    this.#recent.set(safe, observedAt);

    const pending = this.#emitPendingIfReady(observedAt);
    if (pending !== null) {
      this.#pending = safe;
      return pending;
    }
    if (this.#ready(observedAt)) return this.#emit(safe, observedAt);
    this.#pending = safe;
    return null;
  }

  flush(observedAt = Date.now()): string | null {
    this.#observeTime(observedAt);
    return this.#emitPendingIfReady(observedAt);
  }

  /** Emits the latest held update regardless of the active-stream rate limit. */
  drain(observedAt = Date.now()): string | null {
    this.#observeTime(observedAt);
    if (this.#pending === null) return null;
    const value = this.#pending;
    this.#pending = null;
    return this.#emit(value, observedAt);
  }

  #observeTime(observedAt: number): void {
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("observedAt is invalid");
    if (this.#lastObservedAt !== null && observedAt < this.#lastObservedAt) throw new Error("observedAt moved backwards");
    this.#lastObservedAt = observedAt;
  }

  #ready(observedAt: number): boolean {
    return this.#lastEmittedAt === null || observedAt - this.#lastEmittedAt >= this.#minimumIntervalMs;
  }

  #emit(value: string, observedAt: number): string {
    this.#lastEmittedAt = observedAt;
    return value;
  }

  #emitPendingIfReady(observedAt: number): string | null {
    if (this.#pending === null || !this.#ready(observedAt)) return null;
    const value = this.#pending;
    this.#pending = null;
    return this.#emit(value, observedAt);
  }

  #prune(observedAt: number): void {
    for (const [activity, seenAt] of this.#recent) {
      if (observedAt - seenAt > this.#dedupeWindowMs) this.#recent.delete(activity);
    }
  }
}
