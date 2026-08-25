import {
  TASK_PHASE_STAGES,
  TASK_PHASE_STATUSES,
  type TaskPhaseStage,
  type TaskPhaseStatus,
} from "#shared/task-board-contract";
import type { RuntimeEvent } from "./events.js";

const MAX_EVENT_CHARACTERS = 256 * 1024;

type JsonObject = Record<string, unknown>;

export interface LivePhaseSignal {
  readonly key: string;
  readonly title: string;
  readonly stage: TaskPhaseStage;
  readonly status: TaskPhaseStatus;
  readonly parallelGroup: string | null;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function contractMember<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
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

function sanitizePhaseTitle(value: string): string | null {
  let result = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\bhttps?:\/\/[^\s)>\]]+/giu, "[link redacted]")
    .replace(/\b(?:Bearer\s+)?(?:sk-(?:proj-|ant-)?|github_pat_|gh[pousr]_|glpat-|npm_|xox[baprs]-)[A-Za-z0-9._~+\/-]{8,}/gu, "[credential redacted]")
    .replace(/(^|[\s("'`])\/(?:Users|home|var|tmp|private|opt|srv|workspaces?|repos?|mnt|Volumes)\/[^\s"'`),;]*/gu, "$1[local path]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, "[local path]")
    .replace(/\s+/gu, " ")
    .trim();
  if (result.length === 0) return null;
  if (result.length > 120) result = `${result.slice(0, 119).trimEnd()}…`;
  return result;
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
    typeof item.key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(item.key) ||
    item.parallelGroup !== null && (typeof item.parallelGroup !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(item.parallelGroup)) ||
    !contractMember(item.stage, TASK_PHASE_STAGES) ||
    !contractMember(item.status, TASK_PHASE_STATUSES) ||
    item.stage === "done" && item.status !== "completed"
  ) {
    return null;
  }
  const title = typeof item.title === "string" ? sanitizePhaseTitle(item.title) : null;
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
