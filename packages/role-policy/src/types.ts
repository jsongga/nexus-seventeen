export const AGENT_ROLES = Object.freeze([
  "engineer",
  "verifier",
  "manager",
  "impact_observer",
] as const);

export type AgentRole = (typeof AGENT_ROLES)[number];

export const POLICY_OPERATIONS = Object.freeze([
  "context.read",
  "research.perform",
  "plan.record",
  "workspace.modify",
  "tests.run",
  "verification.record",
  "review.record",
  "task.create",
  "task.route",
  "human_handoff.create",
  "impact.summarize",
  "progress.record",
  "production.approve",
  "production.deploy",
] as const);

export type PolicyOperation = (typeof POLICY_OPERATIONS)[number];

export type OperationEffect =
  | "read_only"
  | "workspace_write"
  | "test_execution"
  | "control_plane_write"
  | "production_approval"
  | "production_mutation";

export type RoleActionRequest = Readonly<{
  role: AgentRole;
  operation: PolicyOperation;
}>;

export type AllowedRoleAction = Readonly<{
  disposition: "allow";
  reason: "fixed_role_capability";
  role: AgentRole;
  operation: PolicyOperation;
  effect: OperationEffect;
}>;

export type DeniedRoleAction = Readonly<{
  disposition: "deny";
  reason: "invalid_request" | "role_operation_not_allowed";
  detail: string;
}>;

export type HumanRequiredRoleAction = Readonly<{
  disposition: "human_required";
  reason: "production_authority_reserved_for_authenticated_human";
  role: AgentRole;
  operation: "production.approve" | "production.deploy";
  effect: "production_approval" | "production_mutation";
}>;

export type RoleActionDecision =
  | AllowedRoleAction
  | DeniedRoleAction
  | HumanRequiredRoleAction;

export const WORKFLOW_STATES = Object.freeze([
  "queued",
  "engineer_research",
  "engineer_plan",
  "engineer_execute",
  "engineer_test",
  "verifier_review",
  "manager_review",
  "human_review_pending",
  "human_approved",
  "deployed",
] as const);

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const WORKFLOW_SIGNALS = Object.freeze([
  "work_started",
  "research_complete",
  "plan_complete",
  "implementation_complete",
  "test_failed",
  "test_passed",
  "verification_changes_requested",
  "verification_passed",
  "manager_changes_requested",
  "human_handoff_created",
  "human_changes_requested",
  "human_approved",
  "human_deployed",
] as const);

export type WorkflowSignal = (typeof WORKFLOW_SIGNALS)[number];

export type AgentWorkflowActor = Readonly<{
  kind: "agent";
  role: AgentRole;
}>;

export type HumanWorkflowActor = Readonly<{
  kind: "human";
  authenticated: boolean;
}>;

export type WorkflowActor = AgentWorkflowActor | HumanWorkflowActor;

export type WorkflowTransitionRequest = Readonly<{
  from: WorkflowState;
  to: WorkflowState;
  signal: WorkflowSignal;
  actor: WorkflowActor;
}>;

export type AllowedWorkflowTransition = Readonly<{
  disposition: "allow";
  reason: "valid_fixed_workflow_transition";
  transition: WorkflowTransitionRequest;
}>;

export type DeniedWorkflowTransition = Readonly<{
  disposition: "deny";
  reason:
    | "invalid_request"
    | "transition_not_allowed"
    | "actor_not_allowed";
  detail: string;
}>;

export type HumanRequiredWorkflowTransition =
  | Readonly<{
      disposition: "human_required";
      reason: "production_authority_reserved_for_authenticated_human";
      from: "human_review_pending" | "human_approved";
      to: "human_approved" | "deployed";
    }>
  | Readonly<{
      disposition: "human_required";
      reason: "human_authentication_required";
      from: WorkflowState;
      to: WorkflowState;
    }>;

export type WorkflowTransitionDecision =
  | AllowedWorkflowTransition
  | DeniedWorkflowTransition
  | HumanRequiredWorkflowTransition;

export type ToolBinding = Readonly<Record<string, PolicyOperation>>;

export type ToolCallRequest = Readonly<{
  role: AgentRole;
  tool: string;
}>;

export type ToolCallDecision =
  | (AllowedRoleAction & Readonly<{ tool: string }>)
  | (HumanRequiredRoleAction & Readonly<{ tool: string }>)
  | DeniedRoleAction;
