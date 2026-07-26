import type { TaskPhaseStage, TaskPhaseStatus } from "#shared/task-board-contract";

const MAX_EVENT_CHARACTERS = 256 * 1024;
const DEFAULT_MAXIMUM_ACTIVITY_CHARACTERS = 160;
const FAILURE_STATES = new Set(["cancelled", "error", "failed", "rejected"]);

type JsonObject = Record<string, unknown>;

export type ActivityProvider = "codex" | "claude";

export interface LivePhaseSignal {
  readonly key: string;
  readonly title: string;
  readonly stage: TaskPhaseStage;
  readonly status: TaskPhaseStatus;
  readonly parallelGroup: string | null;
}

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

function estimateFromText(value: unknown): number | null {
  if (typeof value !== "string" || value.length > MAX_EVENT_CHARACTERS) return null;
  const matches = [...value.matchAll(/(?:^|\r?\n)STEWARD_ESTIMATE_MINUTES=(\d{1,5})(?=\r?\n|$)/gu)];
  const raw = matches.at(-1)?.[1];
  if (raw === undefined) return null;
  const minutes = Number(raw);
  return Number.isSafeInteger(minutes) && minutes >= 15 && minutes <= 10_080 && minutes % 15 === 0
    ? minutes
    : null;
}

function claudeToolResultEstimate(content: unknown): number | null {
  const direct = estimateFromText(content);
  if (direct !== null || !Array.isArray(content)) return direct;
  for (const entry of content) {
    const block = object(entry);
    const estimate = block?.type === "text" ? estimateFromText(block.text) : null;
    if (estimate !== null) return estimate;
  }
  return null;
}

function phaseSignalFromText(value: unknown): LivePhaseSignal | null {
  if (typeof value !== "string" || value.length > MAX_EVENT_CHARACTERS) return null;
  const matches = [...value.matchAll(/(?:^|\r?\n)STEWARD_PHASE_JSON=([^\r\n]{2,768})(?=\r?\n|$)/gu)];
  const raw = matches.at(-1)?.[1];
  if (raw === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return null; }
  const item = object(parsed);
  if (item === null || Object.keys(item).sort().join(",") !== "key,parallelGroup,stage,status,title") return null;
  if (
    typeof item.key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(item.key) ||
    item.parallelGroup !== null && (typeof item.parallelGroup !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(item.parallelGroup)) ||
    item.stage !== "research" && item.stage !== "planning" && item.stage !== "execution" &&
      item.stage !== "testing" && item.stage !== "review" && item.stage !== "done" ||
    item.status !== "pending" && item.status !== "in_progress" && item.status !== "blocked" &&
      item.status !== "completed" && item.status !== "failed" ||
    item.stage === "done" && item.status !== "completed"
  ) {
    return null;
  }
  const title = typeof item.title === "string" ? sanitizeActivity(item.title, 120) : null;
  if (title === null) return null;
  return Object.freeze({
    key: item.key,
    title,
    stage: item.stage,
    status: item.status,
    parallelGroup: item.parallelGroup,
  });
}

function claudeToolResultPhase(content: unknown): LivePhaseSignal | null {
  const direct = phaseSignalFromText(content);
  if (direct !== null || !Array.isArray(content)) return direct;
  for (const entry of content) {
    const block = object(entry);
    const phase = block?.type === "text" ? phaseSignalFromText(block.text) : null;
    if (phase !== null) return phase;
  }
  return null;
}

/** Extracts only an exact numeric marker from completed tool output; all other provider text is ignored. */
export function estimateMinutesFromProviderLine(provider: ActivityProvider, line: string): number | null {
  const event = eventFromLine(line);
  if (event === null || typeof event.type !== "string") return null;
  if (provider === "codex") {
    if (event.type !== "item.completed") return null;
    const item = object(event.item);
    return item?.type === "command_execution" ? estimateFromText(item.aggregated_output) : null;
  }
  if (event.type !== "user") return null;
  const content = object(event.message)?.content;
  if (!Array.isArray(content)) return null;
  for (const entry of content) {
    const block = object(entry);
    if (block?.type !== "tool_result") continue;
    const estimate = claudeToolResultEstimate(block.content);
    if (estimate !== null) return estimate;
  }
  return null;
}

/** Extracts a strictly bounded phase signal only from completed tool output. */
export function phaseSignalFromProviderLine(provider: ActivityProvider, line: string): LivePhaseSignal | null {
  const event = eventFromLine(line);
  if (event === null || typeof event.type !== "string") return null;
  if (provider === "codex") {
    if (event.type !== "item.completed") return null;
    const item = object(event.item);
    return item?.type === "command_execution" ? phaseSignalFromText(item.aggregated_output) : null;
  }
  if (event.type !== "user") return null;
  const content = object(event.message)?.content;
  if (!Array.isArray(content)) return null;
  for (const entry of content) {
    const block = object(entry);
    if (block?.type !== "tool_result") continue;
    const phase = claudeToolResultPhase(block.content);
    if (phase !== null) return phase;
  }
  return null;
}

export function estimateActivity(minutes: number): string {
  if (!Number.isSafeInteger(minutes) || minutes < 15 || minutes > 10_080 || minutes % 15 !== 0) {
    throw new Error("Estimate minutes are invalid");
  }
  return `Agent estimated ${minutes} minutes of work remaining.`;
}

export function estimateMinutesFromActivity(activity: string): number | null {
  const match = /^Agent estimated (\d{1,5}) minutes of work remaining\.$/u.exec(activity);
  return match === null ? null : estimateFromText(`STEWARD_ESTIMATE_MINUTES=${match[1]}\n`);
}

const SAFE_PHASE_PREFIX = "STEWARD_SAFE_PHASE=";

export function phaseActivity(signal: LivePhaseSignal): string {
  return `${SAFE_PHASE_PREFIX}${JSON.stringify(signal)}`;
}

export function phaseSignalFromActivity(activity: string): LivePhaseSignal | null {
  return activity.startsWith(SAFE_PHASE_PREFIX)
    ? phaseSignalFromText(`STEWARD_PHASE_JSON=${activity.slice(SAFE_PHASE_PREFIX.length)}\n`)
    : null;
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
      if (estimateFromText(item.aggregated_output) !== null || phaseSignalFromText(item.aggregated_output) !== null) return null;
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
      if (claudeToolResultEstimate(block.content) !== null || claudeToolResultPhase(block.content) !== null) return null;
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

/** Maps only fixed, sanitized lifecycle labels to a durable phase stage. */
export function phaseStageFromActivity(activity: string): Exclude<TaskPhaseStage, "done"> | null {
  switch (activity) {
    case "Agent process started.":
    case "Work started.":
    case "Reviewing the task and choosing the next safe step.":
    case "Researching relevant information.":
    case "Relevant research was gathered.":
    case "Gathering information with an approved tool.":
    case "Information gathering completed.":
    case "Inspecting the relevant code and context.":
    case "Delegating a focused investigation.":
    case "Applying the configured development workflow.":
      return "research";
    case "Preparing the implementation plan.":
    case "Prepared the implementation plan.":
      return "planning";
    case "Updating the implementation.":
    case "Updated the implementation.":
      return "execution";
    case "Running a development check.":
    case "A development check completed.":
    case "A development check found more work.":
    case "A development step found more work.":
      return "testing";
    case "Work finished; preparing the recorded result.":
    case "Preparing a focused question for human input.":
      return "review";
    default:
      return null;
  }
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
