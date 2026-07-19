import {
  AGENT_ROLES,
  WORKFLOW_SIGNALS,
  WORKFLOW_STATES,
  type AgentRole,
  type WorkflowActor,
  type WorkflowSignal,
  type WorkflowState,
  type WorkflowTransitionDecision,
  type WorkflowTransitionRequest,
} from "./types.js";

type TransitionActor = AgentRole | "authenticated_human";

type TransitionRule = Readonly<{
  from: WorkflowState;
  to: WorkflowState;
  signal: WorkflowSignal;
  actor: TransitionActor;
}>;

/**
 * The only legal path to production. Failed tests and requested changes always
 * return to research, ensuring a complete RPET iteration before review resumes.
 */
export const WORKFLOW_TRANSITIONS = Object.freeze([
  Object.freeze({
    from: "queued",
    to: "engineer_research",
    signal: "work_started",
    actor: "engineer",
  }),
  Object.freeze({
    from: "engineer_research",
    to: "engineer_plan",
    signal: "research_complete",
    actor: "engineer",
  }),
  Object.freeze({
    from: "engineer_plan",
    to: "engineer_execute",
    signal: "plan_complete",
    actor: "engineer",
  }),
  Object.freeze({
    from: "engineer_execute",
    to: "engineer_test",
    signal: "implementation_complete",
    actor: "engineer",
  }),
  Object.freeze({
    from: "engineer_test",
    to: "engineer_research",
    signal: "test_failed",
    actor: "engineer",
  }),
  Object.freeze({
    from: "engineer_test",
    to: "verifier_review",
    signal: "test_passed",
    actor: "engineer",
  }),
  Object.freeze({
    from: "verifier_review",
    to: "engineer_research",
    signal: "verification_changes_requested",
    actor: "verifier",
  }),
  Object.freeze({
    from: "verifier_review",
    to: "manager_review",
    signal: "verification_passed",
    actor: "verifier",
  }),
  Object.freeze({
    from: "manager_review",
    to: "engineer_research",
    signal: "manager_changes_requested",
    actor: "manager",
  }),
  Object.freeze({
    from: "manager_review",
    to: "human_review_pending",
    signal: "human_handoff_created",
    actor: "manager",
  }),
  Object.freeze({
    from: "human_review_pending",
    to: "engineer_research",
    signal: "human_changes_requested",
    actor: "authenticated_human",
  }),
  Object.freeze({
    from: "human_review_pending",
    to: "human_approved",
    signal: "human_approved",
    actor: "authenticated_human",
  }),
  Object.freeze({
    from: "human_approved",
    to: "deployed",
    signal: "human_deployed",
    actor: "authenticated_human",
  }),
] as const) satisfies readonly TransitionRule[];

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

function parseActor(value: unknown): WorkflowActor | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "agent") {
    if (!hasExactOwnKeys(value, ["kind", "role"]) || !member(value.role, AGENT_ROLES)) return null;
    return Object.freeze({ kind: "agent", role: value.role });
  }
  if (value.kind === "human") {
    if (!hasExactOwnKeys(value, ["kind", "authenticated"]) || typeof value.authenticated !== "boolean") {
      return null;
    }
    return Object.freeze({ kind: "human", authenticated: value.authenticated });
  }
  return null;
}

function denied(
  reason: "invalid_request" | "transition_not_allowed" | "actor_not_allowed",
  detail: string,
): WorkflowTransitionDecision {
  return Object.freeze({ disposition: "deny", reason, detail });
}

export function validateWorkflowTransition(request: unknown): WorkflowTransitionDecision {
  if (!isRecord(request) || !hasExactOwnKeys(request, ["from", "to", "signal", "actor"])) {
    return denied("invalid_request", "Transition must contain exactly from, to, signal, and actor.");
  }
  if (!member(request.from, WORKFLOW_STATES)) return denied("invalid_request", "Source state is not recognized.");
  if (!member(request.to, WORKFLOW_STATES)) return denied("invalid_request", "Target state is not recognized.");
  if (!member(request.signal, WORKFLOW_SIGNALS)) return denied("invalid_request", "Signal is not recognized.");
  const actor = parseActor(request.actor);
  if (actor === null) return denied("invalid_request", "Actor is invalid.");

  const rule = WORKFLOW_TRANSITIONS.find(
    (candidate) =>
      candidate.from === request.from &&
      candidate.to === request.to &&
      candidate.signal === request.signal,
  );
  if (rule === undefined) {
    return denied("transition_not_allowed", "The requested fixed workflow transition is not allowed.");
  }

  if (rule.actor === "authenticated_human") {
    if (actor.kind === "agent") {
      if (rule.to === "human_approved" || rule.to === "deployed") {
        return Object.freeze({
          disposition: "human_required",
          reason: "production_authority_reserved_for_authenticated_human",
          from: rule.from,
          to: rule.to,
        });
      }
      return denied("actor_not_allowed", "This transition must be performed by a human.");
    }
    if (!actor.authenticated) {
      return Object.freeze({
        disposition: "human_required",
        reason: "human_authentication_required",
        from: rule.from,
        to: rule.to,
      });
    }
  } else if (actor.kind !== "agent" || actor.role !== rule.actor) {
    return denied("actor_not_allowed", `This transition requires the ${rule.actor} role.`);
  }

  const transition: WorkflowTransitionRequest = Object.freeze({
    from: request.from,
    to: request.to,
    signal: request.signal,
    actor,
  });
  return Object.freeze({
    disposition: "allow",
    reason: "valid_fixed_workflow_transition",
    transition,
  });
}
