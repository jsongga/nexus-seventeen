export type ModelProvider = "codex" | "claude";
export type ModelTier = "economy" | "balanced" | "frontier";

export type AgentRole =
  | "engineer"
  | "verifier"
  | "manager"
  | "impact_observer";

export type RpetPhase = "research" | "plan" | "execute" | "test";
export type OversightPhase = "review" | "coordinate" | "summarize";
export type WorkPhase = RpetPhase | OversightPhase;

export type TaskComplexity = "low" | "medium" | "high";
export type TaskRisk = "low" | "medium" | "high" | "critical";

/**
 * A model may assess a production candidate, but only a human may approve or
 * perform deployment. Keeping these purposes distinct prevents a review model
 * from accidentally acquiring production authority.
 */
export type RoutePurpose =
  | "development"
  | "production_assessment"
  | "production_decision"
  | "production_deployment";

export type RateCard = Readonly<{
  id: string;
  currency: string;
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  effectiveAt: string;
}>;

export type ModelProfile = Readonly<{
  provider: ModelProvider;
  tier: ModelTier;
  modelId: string;
  contextWindowTokens: number;
  maximumOutputTokens: number;
  rateCard?: RateCard;
}>;

export type ProviderCatalog = Readonly<Record<ModelTier, ModelProfile>>;
export type ModelCatalog = Readonly<Record<ModelProvider, ProviderCatalog>>;

export type ContextBudget = Readonly<{
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  maximumTurnTokens: number;
}>;

export type RouteRequest = Readonly<{
  role: AgentRole;
  phase: WorkPhase;
  purpose: RoutePurpose;
  complexity: TaskComplexity;
  risk: TaskRisk;
  context: ContextBudget;
  priorFailedTests: number;
}>;

export type UsageEstimate = Readonly<{
  inputTokens: number;
  reservedOutputTokens: number;
  totalTokens: number;
  maximumTurnTokens: number;
  remainingTokensAfterEstimate: number;
  method: "caller_estimate";
}>;

export type EstimatedCost = Readonly<{
  status: "estimated";
  currency: string;
  estimatedInputCost: number;
  estimatedOutputCost: number;
  estimatedTotalCost: number;
  rateCardId: string;
  rateEffectiveAt: string;
  basis: "estimated_input_and_reserved_output";
}>;

export type UnavailableCost = Readonly<{
  status: "unavailable";
  reason: "rate_card_not_supplied";
}>;

export type NotApplicableCost = Readonly<{
  status: "not_applicable";
  reason: "no_model_selected";
}>;

export type CostMetadata = EstimatedCost | UnavailableCost | NotApplicableCost;

export type RouteReasonCode =
  | "fixed_role_phase_baseline"
  | "medium_risk"
  | "high_risk"
  | "critical_risk"
  | "high_complexity"
  | "first_failed_test"
  | "repeated_failed_tests"
  | "context_capacity"
  | "bounded_observer";

export type RouteReason = Readonly<{
  code: RouteReasonCode;
  minimumTier: ModelTier;
  detail: string;
}>;

export type ContextFit = Readonly<{
  modelContextWindowTokens: number;
  modelMaximumOutputTokens: number;
  projectedRemainingContextTokens: number;
  projectedContextUtilization: number;
}>;

export type AuthorityBoundary = Readonly<{
  modelMayDeployToProduction: false;
  modelMayApproveProduction: false;
  authenticatedHumanApprovalRequired: true;
}>;

export type ModelRouteDecision = Readonly<{
  disposition: "model";
  request: RouteRequest;
  provider: ModelProvider;
  baselineTier: ModelTier;
  selectedTier: ModelTier;
  model: ModelProfile;
  escalated: boolean;
  reasons: readonly RouteReason[];
  usage: UsageEstimate;
  contextFit: ContextFit;
  cost: EstimatedCost | UnavailableCost;
  authority: AuthorityBoundary;
  qualityClaimedEquivalentToFrontier: false;
}>;

export type HumanRequiredDecision = Readonly<{
  disposition: "human_required";
  request: RouteRequest;
  reason: "production_authority_required";
  detail: string;
  model: null;
  usage: UsageEstimate;
  cost: NotApplicableCost;
  authority: AuthorityBoundary;
}>;

export type BlockedRouteReason =
  | "turn_token_budget_exceeded"
  | "model_context_exceeded";

export type BlockedRouteDecision = Readonly<{
  disposition: "blocked";
  request: RouteRequest;
  reason: BlockedRouteReason;
  detail: string;
  model: null;
  usage: UsageEstimate;
  cost: NotApplicableCost;
  authority: AuthorityBoundary;
}>;

export type RouteDecision =
  | ModelRouteDecision
  | HumanRequiredDecision
  | BlockedRouteDecision;

export type ModelRouter = Readonly<{
  route(request: RouteRequest): RouteDecision;
}>;

export class RoutingPolicyError extends Error {
  readonly code:
    | "INVALID_CATALOG"
    | "INVALID_REQUEST"
    | "ROLE_PHASE_MISMATCH";

  constructor(
    code: RoutingPolicyError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RoutingPolicyError";
    this.code = code;
  }
}

