import {
  parseAgentTaskProjection,
  type AgentRole,
  type AgentTaskProjection,
} from "#shared/protocol";
import { AGENT_ROLES } from "#shared/role-policy";
import type { RpetPhase } from "./checkpoint.js";
import {
  authorizeProviderPhase,
  type ProviderPhaseAuthorization,
} from "./provider-policy.js";
import type {
  ProviderAdapterConfig,
  ProviderInterruptContext,
  ProviderStepResult,
} from "./provider.js";

const PHASES = ["research", "plan", "execute", "test"] as const;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export type ProviderHostRequest =
  | Readonly<{ type: "initialize"; requestId: string; config: ProviderAdapterConfig }>
  | Readonly<{
      type: "execute";
      requestId: string;
      input: Readonly<{
        task: AgentTaskProjection;
        phase: RpetPhase;
        iteration: number;
        authorization: ProviderPhaseAuthorization;
      }>;
    }>
  | Readonly<{ type: "current_action_ack"; requestId: string; actionId: string; accepted: true }>
  | Readonly<{ type: "current_action_ack"; requestId: string; actionId: string; accepted: false; error: string }>
  | Readonly<{ type: "abort"; requestId: string }>
  | Readonly<{ type: "settle_interrupt"; requestId: string; context: ProviderInterruptContext }>
  | Readonly<{ type: "shutdown"; requestId: string }>;

export type ProviderHostResponse =
  | Readonly<{ type: "ready"; requestId: string; providerName: "codex" | "claude"; model: string }>
  | Readonly<{ type: "current_action"; requestId: string; actionId: string; summary: string }>
  | Readonly<{ type: "result"; requestId: string; result: ProviderStepResult }>
  | Readonly<{ type: "interrupt_settled"; requestId: string }>
  | Readonly<{ type: "shutdown_complete"; requestId: string }>
  | Readonly<{ type: "error"; requestId: string; message: string }>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`${label} is invalid`);
  return value as T;
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000]/u.test(value)) {
    throw new Error(`${label} must be a non-empty string no longer than ${maxLength} characters`);
  }
  return value;
}

function requestId(value: unknown, label = "requestId"): string {
  if (typeof value !== "string" || !REQUEST_ID_RE.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function parseConfig(value: unknown): ProviderAdapterConfig {
  const item = record(value, "config");
  exact(item, ["providerName", "model", "role", "workspaceId", "agentId", "laneId", "workingDirectory"], "config");
  const providerName = oneOf(item.providerName, ["codex", "claude"] as const, "config.providerName");
  const role = oneOf(item.role, AGENT_ROLES, "config.role") as AgentRole;
  const workingDirectory = boundedString(item.workingDirectory, "config.workingDirectory", 4_096);
  if (!workingDirectory.startsWith("/")) throw new Error("config.workingDirectory must be absolute");
  return Object.freeze({
    providerName,
    model: boundedString(item.model, "config.model", 200),
    role,
    workspaceId: boundedString(item.workspaceId, "config.workspaceId", 128),
    agentId: boundedString(item.agentId, "config.agentId", 128),
    laneId: boundedString(item.laneId, "config.laneId", 128),
    workingDirectory,
  });
}

function parseAuthorization(value: unknown, role: AgentRole, phase: RpetPhase): ProviderPhaseAuthorization {
  const item = record(value, "input.authorization");
  exact(item, ["role", "phase", "operations"], "input.authorization");
  if (item.role !== role || item.phase !== phase || !Array.isArray(item.operations)) {
    throw new Error("input.authorization does not match the initialized role and phase");
  }
  const authorized = authorizeProviderPhase(role, phase);
  if (
    item.operations.length !== authorized.operations.length ||
    item.operations.some((operation, index) => operation !== authorized.operations[index])
  ) {
    throw new Error("input.authorization operations do not match the host policy");
  }
  return authorized;
}

function parseInterruptContext(value: unknown): ProviderInterruptContext {
  const item = record(value, "context");
  exact(item, ["task", "reason"], "context");
  return Object.freeze({
    task: item.task === null ? null : parseAgentTaskProjection(item.task),
    reason: boundedString(item.reason, "context.reason", 1_000),
  });
}

export function parseProviderHostRequest(value: unknown, initializedRole?: AgentRole): ProviderHostRequest {
  const item = record(value, "provider request");
  const type = boundedString(item.type, "provider request.type", 64);
  const id = requestId(item.requestId);
  switch (type) {
    case "initialize":
      exact(item, ["type", "requestId", "config"], "initialize request");
      return Object.freeze({ type, requestId: id, config: parseConfig(item.config) });
    case "execute": {
      exact(item, ["type", "requestId", "input"], "execute request");
      if (!initializedRole) throw new Error("provider host is not initialized");
      const input = record(item.input, "input");
      exact(input, ["task", "phase", "iteration", "authorization"], "input");
      const phase = oneOf(input.phase, PHASES, "input.phase");
      if (!Number.isSafeInteger(input.iteration) || (input.iteration as number) < 1) {
        throw new Error("input.iteration must be a positive safe integer");
      }
      return Object.freeze({
        type,
        requestId: id,
        input: Object.freeze({
          task: parseAgentTaskProjection(input.task),
          phase,
          iteration: input.iteration as number,
          authorization: parseAuthorization(input.authorization, initializedRole, phase),
        }),
      });
    }
    case "current_action_ack": {
      const accepted = item.accepted;
      if (accepted === true) {
        exact(item, ["type", "requestId", "actionId", "accepted"], "current action acknowledgement");
        return Object.freeze({ type, requestId: id, actionId: requestId(item.actionId, "actionId"), accepted });
      }
      if (accepted === false) {
        exact(item, ["type", "requestId", "actionId", "accepted", "error"], "current action acknowledgement");
        return Object.freeze({
          type,
          requestId: id,
          actionId: requestId(item.actionId, "actionId"),
          accepted,
          error: boundedString(item.error, "error", 1_000),
        });
      }
      throw new Error("current action acknowledgement accepted field is invalid");
    }
    case "abort":
      exact(item, ["type", "requestId"], "abort request");
      return Object.freeze({ type, requestId: id });
    case "settle_interrupt":
      exact(item, ["type", "requestId", "context"], "interrupt settlement request");
      return Object.freeze({ type, requestId: id, context: parseInterruptContext(item.context) });
    case "shutdown":
      exact(item, ["type", "requestId"], "shutdown request");
      return Object.freeze({ type, requestId: id });
    default:
      throw new Error("provider request type is invalid");
  }
}

export function parseProviderStepResult(value: unknown): ProviderStepResult {
  const item = record(value, "provider result");
  const allowed = new Set(["journal", "testOutcome", "resultOverview"]);
  if (Object.keys(item).some((key) => !allowed.has(key))) throw new Error("provider result has unexpected fields");
  const journal = boundedString(item.journal, "provider result.journal", 1_200);
  const testOutcome = item.testOutcome === undefined
    ? undefined
    : oneOf(item.testOutcome, ["passed", "failed"] as const, "provider result.testOutcome");
  const resultOverview = item.resultOverview === undefined
    ? undefined
    : boundedString(item.resultOverview, "provider result.resultOverview", 2_000);
  return Object.freeze({
    journal,
    ...(testOutcome ? { testOutcome } : {}),
    ...(resultOverview ? { resultOverview } : {}),
  });
}

export function parseProviderHostResponse(value: unknown): ProviderHostResponse {
  const item = record(value, "provider response");
  const type = boundedString(item.type, "provider response.type", 64);
  const id = requestId(item.requestId);
  switch (type) {
    case "ready":
      exact(item, ["type", "requestId", "providerName", "model"], "ready response");
      return Object.freeze({
        type,
        requestId: id,
        providerName: oneOf(item.providerName, ["codex", "claude"] as const, "providerName"),
        model: boundedString(item.model, "model", 200),
      });
    case "current_action":
      exact(item, ["type", "requestId", "actionId", "summary"], "current action response");
      return Object.freeze({
        type,
        requestId: id,
        actionId: requestId(item.actionId, "actionId"),
        summary: boundedString(item.summary, "summary", 280),
      });
    case "result":
      exact(item, ["type", "requestId", "result"], "result response");
      return Object.freeze({ type, requestId: id, result: parseProviderStepResult(item.result) });
    case "interrupt_settled":
      exact(item, ["type", "requestId"], "interrupt response");
      return Object.freeze({ type, requestId: id });
    case "shutdown_complete":
      exact(item, ["type", "requestId"], "shutdown response");
      return Object.freeze({ type, requestId: id });
    case "error":
      exact(item, ["type", "requestId", "message"], "error response");
      return Object.freeze({ type, requestId: id, message: boundedString(item.message, "message", 1_000) });
    default:
      throw new Error("provider response type is invalid");
  }
}
