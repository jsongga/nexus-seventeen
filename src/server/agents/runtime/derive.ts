import {
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  type PhaseStep,
  type TaskPhaseStatus,
} from "#shared/task-board-contract";
import { redactRecognizedCredentials, type CredentialRedactionMarkers } from "../../shared/redact.js";
import type { RuntimeEvent } from "./adapter.js";

const MAX_EVENT_CHARACTERS = 256 * 1024;
const DEFAULT_MAXIMUM_ACTIVITY_CHARACTERS = 160;
const ACTIVITY_CREDENTIAL_MARKERS: CredentialRedactionMarkers = Object.freeze({
  token: "[credential redacted]",
  bearer: "[credential redacted]",
  pem: "[credential redacted]",
  urlCredential: "[link redacted]",
});
const ACTIVITY_LINK_PATTERN = /(?:\bhttps?:\/\/|\[link redacted\])(?:\[(?:credential|link) redacted\]|[^\s)>\]])*/giu;

type JsonObject = Record<string, unknown>;

export interface LivePhaseSignal {
  readonly key: string;
  readonly title: string;
  readonly stage: PhaseStep;
  readonly status: TaskPhaseStatus;
  readonly parallelGroup: string | null;
}

interface ActivityBufferOptions {
  readonly minimumIntervalMs?: number;
  readonly dedupeWindowMs?: number;
  readonly maximumCharacters?: number;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function contractMember<const Values extends readonly string[]>(
  value: unknown,
  values: Values
): value is Values[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function estimateFromText(value: unknown): number | null {
  if (typeof value !== "string" || value.length > MAX_EVENT_CHARACTERS) return null;
  const matches = [...value.matchAll(/(?:^|\r?\n)STEWARD_ESTIMATE_MINUTES=(\d{1,5})(?=\r?\n|$)/gu)];
  const raw = matches.at(-1)?.[1];
  if (raw === undefined) return null;
  const minutes = Number(raw);
  return Number.isSafeInteger(minutes) && minutes >= 15 && minutes <= 10_080 && minutes % 15 === 0 ? minutes : null;
}

function phaseSignalFromText(value: unknown): LivePhaseSignal | null {
  if (typeof value !== "string" || value.length > MAX_EVENT_CHARACTERS) return null;
  const matches = [...value.matchAll(/(?:^|\r?\n)STEWARD_PHASE_JSON=([^\r\n]{2,768})(?=\r?\n|$)/gu)];
  const raw = matches.at(-1)?.[1];
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const item = object(parsed);
  if (item === null || Object.keys(item).sort().join(",") !== "key,parallelGroup,stage,status,title") return null;
  if (
    typeof item.key !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(item.key) ||
    (item.parallelGroup !== null &&
      (typeof item.parallelGroup !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(item.parallelGroup))) ||
    !contractMember(item.stage, TASK_PHASE_STAGES) ||
    !contractMember(item.status, TASK_PHASE_STATUSES) ||
    (item.stage === "done" && item.status !== "completed")
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

function approvedToolActivity(name: string): string {
  switch (name.toLowerCase()) {
    case "bash":
    case "shell":
      return "Running a development check.";
    case "read":
    case "glob":
    case "grep":
      return "Inspecting the relevant code and context.";
    case "edit":
    case "write":
    case "notebookedit":
      return "Updating the implementation.";
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

function toolCallActivity(name: string, detail: string): string {
  switch (name.toLowerCase()) {
    case "work":
      return "Work started.";
    case "reasoning":
      return "Reviewing the task and choosing the next safe step.";
    case "todo_list":
    case "plan":
      return "Preparing the implementation plan.";
    case "command":
      return "Running a development check.";
    case "file_change":
      return "Updating the implementation.";
    case "web_search":
      return "Researching relevant information.";
    case "mcp_tool_call":
    case "tool_call":
    case "collaboration_tool_call":
      return "Gathering information with an approved tool.";
    case "progress":
      return approvedToolActivity(detail);
    case "container_starting":
      return "Task container starting";
    case "container_attached":
      return "Task container attached";
    case "container_teardown":
      return "Task container teardown";
    default:
      return approvedToolActivity(name);
  }
}

function markerOutput(event: RuntimeEvent & { readonly type: "tool_result" }): boolean {
  return event.name === "command" || event.name === "tool";
}

function toolResultActivity(event: RuntimeEvent & { readonly type: "tool_result" }): string | null {
  if (markerOutput(event) && (estimateFromText(event.output) !== null || phaseSignalFromText(event.output) !== null)) {
    return null;
  }
  switch (event.name.toLowerCase()) {
    case "reasoning":
      return null;
    case "todo_list":
    case "plan":
      return "Prepared the implementation plan.";
    case "command":
      return event.failed === true ? "A development check found more work." : "A development check completed.";
    case "file_change":
      return "Updated the implementation.";
    case "web_search":
      return "Relevant research was gathered.";
    case "mcp_tool_call":
    case "tool_call":
    case "collaboration_tool_call":
      return event.failed === true
        ? "An information-gathering step found more work."
        : "Information gathering completed.";
    case "summary":
      return "A development step completed.";
    default:
      return event.failed === true ? "A development step found more work." : "A development step completed.";
  }
}

function credentialRedactionActivity(event: RuntimeEvent & { readonly type: "credential_redaction" }): string {
  const site = event.site === "provider_outcome" ? "provider outcome" : event.site;
  return `Credential redaction at ${site}: ${event.patternName} matched ${event.count} ${event.count === 1 ? "span" : "spans"}.`;
}

export function activityFromEvent(event: RuntimeEvent): string | null {
  switch (event.type) {
    case "stage_started":
      return "Agent process started.";
    case "message_delta":
      return null;
    case "tool_call":
      return toolCallActivity(event.name, event.detail);
    case "tool_result":
      return toolResultActivity(event);
    case "credential_redaction":
      return credentialRedactionActivity(event);
    case "stage_finished":
      return "Work finished; preparing the recorded result.";
    case "error":
      return "The run encountered a problem and needs attention.";
  }
}

export function estimateMinutesFromEvent(event: RuntimeEvent): number | null {
  return event.type === "tool_result" && markerOutput(event) ? estimateFromText(event.output) : null;
}

export function phaseSignalFromEvent(event: RuntimeEvent): LivePhaseSignal | null {
  return event.type === "tool_result" && markerOutput(event) ? phaseSignalFromText(event.output) : null;
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

function positiveInteger(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} is invalid`);
  return value;
}

/** Defense-in-depth for bounded provider activity and phase telemetry. */
export function sanitizeActivity(
  value: string,
  maximumCharacters = DEFAULT_MAXIMUM_ACTIVITY_CHARACTERS
): string | null {
  positiveInteger(maximumCharacters, "maximumCharacters", 32);
  let result = redactRecognizedCredentials(value.replace(/[\u0000-\u001f\u007f]+/gu, " "), ACTIVITY_CREDENTIAL_MARKERS)
    .replace(ACTIVITY_LINK_PATTERN, "[link redacted]")
    .replace(
      /(^|[\s("'`])\/(?:Users|home|var|tmp|private|opt|srv|workspaces?|repos?|mnt|Volumes)\/[^\s"'`),;]*/gu,
      "$1[local path]"
    )
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, "[local path]")
    .replace(/\s+/gu, " ")
    .trim();
  if (result.length === 0) return null;
  if (result.length > maximumCharacters) result = `${result.slice(0, maximumCharacters - 1).trimEnd()}…`;
  return result;
}

/** Maps only fixed, sanitized lifecycle labels to a durable phase stage. */
export function phaseStageFromActivity(activity: string): Exclude<PhaseStep, "done"> | null {
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

/** Coalesces noisy runtime events without a heartbeat or timer. */
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
    this.#maximumCharacters = positiveInteger(
      options.maximumCharacters ?? DEFAULT_MAXIMUM_ACTIVITY_CHARACTERS,
      "maximumCharacters",
      32
    );
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
    if (this.#lastObservedAt !== null && observedAt < this.#lastObservedAt)
      throw new Error("observedAt moved backwards");
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
