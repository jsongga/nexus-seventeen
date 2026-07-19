import {
  AGENT_ROLES,
  POLICY_OPERATIONS,
  type AgentRole,
  type DeniedRoleAction,
  type OperationEffect,
  type PolicyOperation,
  type RoleActionDecision,
  type ToolBinding,
  type ToolCallDecision,
} from "./types.js";

const PRODUCTION_OPERATIONS = Object.freeze([
  "production.approve",
  "production.deploy",
] as const);

export const AUTHORITY_BOUNDARY = Object.freeze({
  agentsMayApproveProduction: false,
  agentsMayDeployProduction: false,
  authenticatedHumanRequired: true,
} as const);

/**
 * Operations are semantic capabilities, not provider-supplied tool names. A
 * trusted host maps each concrete tool to one operation before evaluation.
 */
export const OPERATION_EFFECTS = Object.freeze({
  "context.read": "read_only",
  "research.perform": "read_only",
  "plan.record": "control_plane_write",
  "workspace.modify": "workspace_write",
  "tests.run": "test_execution",
  "verification.record": "control_plane_write",
  "review.record": "control_plane_write",
  "task.create": "control_plane_write",
  "task.route": "control_plane_write",
  "human_handoff.create": "control_plane_write",
  "impact.summarize": "control_plane_write",
  "progress.record": "control_plane_write",
  "production.approve": "production_approval",
  "production.deploy": "production_mutation",
} as const) satisfies Readonly<Record<PolicyOperation, OperationEffect>>;

export const ROLE_ALLOWED_OPERATIONS = Object.freeze({
  engineer: Object.freeze([
    "context.read",
    "research.perform",
    "plan.record",
    "workspace.modify",
    "tests.run",
    "progress.record",
  ] as const),
  verifier: Object.freeze([
    "context.read",
    "tests.run",
    "verification.record",
    "progress.record",
  ] as const),
  manager: Object.freeze([
    "context.read",
    "review.record",
    "task.create",
    "task.route",
    "human_handoff.create",
    "progress.record",
  ] as const),
  impact_observer: Object.freeze(["impact.summarize"] as const),
} as const) satisfies Readonly<Record<AgentRole, readonly PolicyOperation[]>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactOwnKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function invalid(detail: string): DeniedRoleAction {
  return Object.freeze({
    disposition: "deny",
    reason: "invalid_request",
    detail,
  });
}

export function evaluateRoleAction(request: unknown): RoleActionDecision {
  if (!isRecord(request) || !hasExactOwnKeys(request, ["role", "operation"])) {
    return invalid("Role action must contain exactly role and operation.");
  }
  if (!member(request.role, AGENT_ROLES)) return invalid("Role is not recognized.");
  if (!member(request.operation, POLICY_OPERATIONS)) return invalid("Operation is not recognized.");

  const role = request.role;
  const operation = request.operation;
  if (member(operation, PRODUCTION_OPERATIONS)) {
    const effect = operation === "production.approve"
      ? "production_approval"
      : "production_mutation";
    return Object.freeze({
      disposition: "human_required",
      reason: "production_authority_reserved_for_authenticated_human",
      role,
      operation,
      effect,
    });
  }

  const allowed = ROLE_ALLOWED_OPERATIONS[role] as readonly PolicyOperation[];
  if (!allowed.includes(operation)) {
    return Object.freeze({
      disposition: "deny",
      reason: "role_operation_not_allowed",
      detail: `${role} may not perform ${operation}.`,
    });
  }

  return Object.freeze({
    disposition: "allow",
    reason: "fixed_role_capability",
    role,
    operation,
    effect: OPERATION_EFFECTS[operation],
  });
}

/**
 * Evaluates a concrete tool name using host-owned bindings. Unknown tools and
 * malformed bindings are denied; provider output cannot introduce a binding.
 */
export function evaluateToolCall(
  request: unknown,
  trustedBindings: ToolBinding,
): ToolCallDecision {
  if (!isRecord(trustedBindings)) {
    return invalid("Trusted tool bindings are invalid.");
  }
  if (!isRecord(request) || !hasExactOwnKeys(request, ["role", "tool"])) {
    return invalid("Tool call must contain exactly role and tool.");
  }
  if (!member(request.role, AGENT_ROLES)) return invalid("Role is not recognized.");
  if (
    typeof request.tool !== "string" ||
    request.tool.length === 0 ||
    request.tool.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(request.tool)
  ) {
    return invalid("Tool name is invalid.");
  }
  if (!Object.hasOwn(trustedBindings, request.tool)) {
    return Object.freeze({
      disposition: "deny",
      reason: "role_operation_not_allowed",
      detail: `Tool ${request.tool} has no trusted policy binding.`,
    });
  }

  const operation = trustedBindings[request.tool];
  if (!member(operation, POLICY_OPERATIONS)) {
    return invalid(`Tool ${request.tool} has an invalid trusted policy binding.`);
  }
  const decision = evaluateRoleAction({ role: request.role, operation });
  if (decision.disposition === "deny") return decision;
  return Object.freeze({ ...decision, tool: request.tool });
}
