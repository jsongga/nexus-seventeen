import type {
  AgentRole,
  AuthorityBoundary,
  ContextBudget,
  ContextFit,
  CostMetadata,
  EstimatedCost,
  ModelCatalog,
  ModelProfile,
  ModelProvider,
  ModelRouteDecision,
  ModelRouter,
  ModelTier,
  RouteDecision,
  RouteReason,
  RouteRequest,
  UnavailableCost,
  UsageEstimate,
  WorkPhase,
} from "./types.js";
import { RoutingPolicyError } from "./types.js";

const TIERS = Object.freeze(["economy", "balanced", "frontier"] as const);
const PROVIDERS = Object.freeze(["codex", "claude"] as const);
const ROLES = Object.freeze([
  "engineer",
  "verifier",
  "manager",
  "impact_observer",
] as const);
const PHASES = Object.freeze([
  "research",
  "plan",
  "execute",
  "test",
  "review",
  "coordinate",
  "summarize",
] as const);
const PURPOSES = Object.freeze([
  "development",
  "production_assessment",
  "production_decision",
  "production_deployment",
] as const);
const COMPLEXITIES = Object.freeze(["low", "medium", "high"] as const);
const RISKS = Object.freeze(["low", "medium", "high", "critical"] as const);

type RolePhasePolicy = Readonly<{
  provider: ModelProvider;
  baselineTier: ModelTier;
}>;

/**
 * Role and phase are deliberately fixed. Callers cannot silently pick a more
 * expensive provider or give a role a phase outside its product capability.
 */
export const FIXED_ROLE_PHASE_POLICY = Object.freeze({
  engineer: Object.freeze({
    research: Object.freeze({ provider: "codex", baselineTier: "economy" }),
    plan: Object.freeze({ provider: "codex", baselineTier: "economy" }),
    execute: Object.freeze({ provider: "codex", baselineTier: "economy" }),
    test: Object.freeze({ provider: "codex", baselineTier: "economy" }),
  }),
  verifier: Object.freeze({
    research: Object.freeze({ provider: "claude", baselineTier: "economy" }),
    plan: Object.freeze({ provider: "claude", baselineTier: "economy" }),
    test: Object.freeze({ provider: "claude", baselineTier: "balanced" }),
    review: Object.freeze({ provider: "claude", baselineTier: "balanced" }),
  }),
  manager: Object.freeze({
    research: Object.freeze({ provider: "claude", baselineTier: "economy" }),
    plan: Object.freeze({ provider: "claude", baselineTier: "economy" }),
    review: Object.freeze({ provider: "claude", baselineTier: "balanced" }),
    coordinate: Object.freeze({ provider: "claude", baselineTier: "economy" }),
  }),
  impact_observer: Object.freeze({
    summarize: Object.freeze({ provider: "claude", baselineTier: "economy" }),
  }),
} as const) satisfies Readonly<
  Record<AgentRole, Readonly<Partial<Record<WorkPhase, RolePhasePolicy>>>>
>;

const AUTHORITY_BOUNDARY = Object.freeze({
  modelMayDeployToProduction: false,
  modelMayApproveProduction: false,
  authenticatedHumanApprovalRequired: true,
} as const) satisfies AuthorityBoundary;

function tierIndex(tier: ModelTier): number {
  return TIERS.indexOf(tier);
}

function maxTier(left: ModelTier, right: ModelTier): ModelTier {
  return tierIndex(left) >= tierIndex(right) ? left : right;
}

function safeInteger(
  value: number,
  label: string,
  options: Readonly<{ positive?: boolean }> = {},
): number {
  const minimum = options.positive === true ? 1 : 0;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RoutingPolicyError(
      "INVALID_REQUEST",
      `${label} must be a safe integer greater than or equal to ${minimum}.`,
    );
  }
  return value;
}

function catalogInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RoutingPolicyError(
      "INVALID_CATALOG",
      `${label} must be a positive safe integer.`,
    );
  }
  return value;
}

function nonEmpty(value: string, label: string, code: "INVALID_CATALOG" | "INVALID_REQUEST"): string {
  if (value.trim().length === 0) {
    throw new RoutingPolicyError(code, `${label} must not be empty.`);
  }
  return value;
}

function requestEnum(
  value: string,
  allowed: readonly string[],
  label: string,
): void {
  if (!allowed.includes(value)) {
    throw new RoutingPolicyError(
      "INVALID_REQUEST",
      `${label} must be one of: ${allowed.join(", ")}.`,
    );
  }
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RoutingPolicyError(
      "INVALID_CATALOG",
      `${label} must be a finite, non-negative number.`,
    );
  }
  return value;
}

function copyModel(
  profile: ModelProfile,
  expectedProvider: ModelProvider,
  expectedTier: ModelTier,
): ModelProfile {
  if (profile.provider !== expectedProvider || profile.tier !== expectedTier) {
    throw new RoutingPolicyError(
      "INVALID_CATALOG",
      `Catalog entry ${expectedProvider}.${expectedTier} must identify the same provider and tier.`,
    );
  }

  nonEmpty(profile.modelId, `${expectedProvider}.${expectedTier}.modelId`, "INVALID_CATALOG");
  const contextWindowTokens = catalogInteger(
    profile.contextWindowTokens,
    `${expectedProvider}.${expectedTier}.contextWindowTokens`,
  );
  const maximumOutputTokens = catalogInteger(
    profile.maximumOutputTokens,
    `${expectedProvider}.${expectedTier}.maximumOutputTokens`,
  );
  if (maximumOutputTokens > contextWindowTokens) {
    throw new RoutingPolicyError(
      "INVALID_CATALOG",
      `${expectedProvider}.${expectedTier}.maximumOutputTokens cannot exceed its context window.`,
    );
  }

  const rateCard = profile.rateCard;
  if (rateCard === undefined) {
    return Object.freeze({
      provider: expectedProvider,
      tier: expectedTier,
      modelId: profile.modelId,
      contextWindowTokens,
      maximumOutputTokens,
    });
  }

  nonEmpty(rateCard.id, `${expectedProvider}.${expectedTier}.rateCard.id`, "INVALID_CATALOG");
  nonEmpty(
    rateCard.currency,
    `${expectedProvider}.${expectedTier}.rateCard.currency`,
    "INVALID_CATALOG",
  );
  nonEmpty(
    rateCard.effectiveAt,
    `${expectedProvider}.${expectedTier}.rateCard.effectiveAt`,
    "INVALID_CATALOG",
  );
  finiteNonNegative(
    rateCard.inputPerMillionTokens,
    `${expectedProvider}.${expectedTier}.rateCard.inputPerMillionTokens`,
  );
  finiteNonNegative(
    rateCard.outputPerMillionTokens,
    `${expectedProvider}.${expectedTier}.rateCard.outputPerMillionTokens`,
  );

  return Object.freeze({
    provider: expectedProvider,
    tier: expectedTier,
    modelId: profile.modelId,
    contextWindowTokens,
    maximumOutputTokens,
    rateCard: Object.freeze({ ...rateCard }),
  });
}

function snapshotCatalog(catalog: ModelCatalog): ModelCatalog {
  const copiedProviders = {} as Record<ModelProvider, Record<ModelTier, ModelProfile>>;
  for (const provider of PROVIDERS) {
    const providerCatalog = catalog[provider];
    if (providerCatalog === undefined || providerCatalog === null) {
      throw new RoutingPolicyError("INVALID_CATALOG", `Catalog is missing provider ${provider}.`);
    }
    const copiedTiers = {} as Record<ModelTier, ModelProfile>;
    for (const tier of TIERS) {
      const profile = providerCatalog[tier];
      if (profile === undefined || profile === null) {
        throw new RoutingPolicyError(
          "INVALID_CATALOG",
          `Catalog is missing ${provider}.${tier}.`,
        );
      }
      copiedTiers[tier] = copyModel(profile, provider, tier);
    }
    copiedProviders[provider] = Object.freeze(copiedTiers);
  }
  return Object.freeze(copiedProviders);
}

function usageFor(context: ContextBudget): UsageEstimate {
  const inputTokens = safeInteger(context.estimatedInputTokens, "context.estimatedInputTokens");
  const reservedOutputTokens = safeInteger(
    context.reservedOutputTokens,
    "context.reservedOutputTokens",
  );
  const maximumTurnTokens = safeInteger(
    context.maximumTurnTokens,
    "context.maximumTurnTokens",
    { positive: true },
  );
  const totalTokens = inputTokens + reservedOutputTokens;
  if (!Number.isSafeInteger(totalTokens)) {
    throw new RoutingPolicyError("INVALID_REQUEST", "Estimated turn tokens exceed safe integer range.");
  }
  return Object.freeze({
    inputTokens,
    reservedOutputTokens,
    totalTokens,
    maximumTurnTokens,
    remainingTokensAfterEstimate: maximumTurnTokens - totalTokens,
    method: "caller_estimate",
  });
}

function rolePhasePolicy(role: AgentRole, phase: WorkPhase): RolePhasePolicy {
  const phases = FIXED_ROLE_PHASE_POLICY[role] as
    | Readonly<Partial<Record<WorkPhase, RolePhasePolicy>>>
    | undefined;
  if (phases === undefined) {
    throw new RoutingPolicyError("INVALID_REQUEST", `Unknown routing role ${String(role)}.`);
  }
  const typedPhases = phases as Readonly<
    Partial<Record<WorkPhase, RolePhasePolicy>>
  >;
  const policy = typedPhases[phase];
  if (policy === undefined) {
    throw new RoutingPolicyError(
      "ROLE_PHASE_MISMATCH",
      `Role ${role} is not allowed to route phase ${phase}.`,
    );
  }
  return policy;
}

function reason(
  code: RouteReason["code"],
  minimumTier: ModelTier,
  detail: string,
): RouteReason {
  return Object.freeze({ code, minimumTier, detail });
}

function evidenceFor(request: RouteRequest, baselineTier: ModelTier): readonly RouteReason[] {
  const reasons: RouteReason[] = [
    reason(
      "fixed_role_phase_baseline",
      baselineTier,
      `The fixed ${request.role}/${request.phase} policy starts at ${baselineTier}.`,
    ),
  ];

  // The observer is deliberately weak, bounded, and non-authoritative. Source
  // task risk and failures must not turn presentation work into frontier spend.
  if (request.role === "impact_observer") {
    reasons.push(
      reason(
        "bounded_observer",
        "economy",
        "Impact summaries stay on the economy tier; oversize inputs must be compacted.",
      ),
    );
    return Object.freeze(reasons);
  }

  if (request.risk === "medium") {
    reasons.push(reason("medium_risk", "balanced", "Medium risk requires balanced reasoning."));
  } else if (request.risk === "high") {
    reasons.push(reason("high_risk", "balanced", "High risk requires balanced reasoning."));
  } else if (request.risk === "critical") {
    reasons.push(reason("critical_risk", "frontier", "Critical risk warrants frontier reasoning."));
  }

  if (request.complexity === "high") {
    reasons.push(
      reason("high_complexity", "balanced", "High task complexity requires the balanced tier."),
    );
  }

  if (request.priorFailedTests === 1) {
    reasons.push(
      reason(
        "first_failed_test",
        "balanced",
        "One observed failed test justifies one tier of escalation.",
      ),
    );
  } else if (request.priorFailedTests >= 2) {
    reasons.push(
      reason(
        "repeated_failed_tests",
        "frontier",
        "Repeated observed test failures justify frontier escalation.",
      ),
    );
  }

  return Object.freeze(reasons);
}

function minimumTier(reasons: readonly RouteReason[]): ModelTier {
  return reasons.reduce<ModelTier>(
    (minimum, item) => maxTier(minimum, item.minimumTier),
    "economy",
  );
}

function modelFits(model: ModelProfile, usage: UsageEstimate): boolean {
  return (
    usage.totalTokens <= model.contextWindowTokens &&
    usage.reservedOutputTokens <= model.maximumOutputTokens
  );
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

export function estimateCost(
  model: ModelProfile,
  usage: UsageEstimate,
): EstimatedCost | UnavailableCost {
  if (model.rateCard === undefined) {
    return Object.freeze({
      status: "unavailable",
      reason: "rate_card_not_supplied",
    });
  }

  const estimatedInputCost =
    (usage.inputTokens / 1_000_000) * model.rateCard.inputPerMillionTokens;
  const estimatedOutputCost =
    (usage.reservedOutputTokens / 1_000_000) * model.rateCard.outputPerMillionTokens;

  return Object.freeze({
    status: "estimated",
    currency: model.rateCard.currency,
    estimatedInputCost: roundMoney(estimatedInputCost),
    estimatedOutputCost: roundMoney(estimatedOutputCost),
    estimatedTotalCost: roundMoney(estimatedInputCost + estimatedOutputCost),
    rateCardId: model.rateCard.id,
    rateEffectiveAt: model.rateCard.effectiveAt,
    basis: "estimated_input_and_reserved_output",
  });
}

function noModelCost(): Extract<CostMetadata, { status: "not_applicable" }> {
  return Object.freeze({
    status: "not_applicable",
    reason: "no_model_selected",
  });
}

function contextFit(model: ModelProfile, usage: UsageEstimate): ContextFit {
  return Object.freeze({
    modelContextWindowTokens: model.contextWindowTokens,
    modelMaximumOutputTokens: model.maximumOutputTokens,
    projectedRemainingContextTokens: model.contextWindowTokens - usage.totalTokens,
    projectedContextUtilization: usage.totalTokens / model.contextWindowTokens,
  });
}

function frozenRequest(request: RouteRequest): RouteRequest {
  return Object.freeze({
    ...request,
    context: Object.freeze({ ...request.context }),
  });
}

function routeWithCatalog(catalog: ModelCatalog, rawRequest: RouteRequest): RouteDecision {
  const request = frozenRequest(rawRequest);
  const usage = usageFor(request.context);
  safeInteger(request.priorFailedTests, "priorFailedTests");
  requestEnum(request.purpose, PURPOSES, "purpose");

  // This check intentionally precedes role/phase routing. No malformed phase or
  // catalog condition may accidentally turn production authority into a model call.
  if (
    request.purpose === "production_decision" ||
    request.purpose === "production_deployment"
  ) {
    return Object.freeze({
      disposition: "human_required",
      request,
      reason: "production_authority_required",
      detail:
        "Production approval and deployment require an authenticated human; no model route is selected.",
      model: null,
      usage,
      cost: noModelCost(),
      authority: AUTHORITY_BOUNDARY,
    });
  }

  requestEnum(request.role, ROLES, "role");
  requestEnum(request.phase, PHASES, "phase");
  requestEnum(request.complexity, COMPLEXITIES, "complexity");
  requestEnum(request.risk, RISKS, "risk");
  const fixedPolicy = rolePhasePolicy(request.role, request.phase);

  if (usage.remainingTokensAfterEstimate < 0) {
    return Object.freeze({
      disposition: "blocked",
      request,
      reason: "turn_token_budget_exceeded",
      detail: "Compact or split the work before selecting a model.",
      model: null,
      usage,
      cost: noModelCost(),
      authority: AUTHORITY_BOUNDARY,
    });
  }

  const reasons = [...evidenceFor(request, fixedPolicy.baselineTier)];
  const requiredTier = minimumTier(reasons);
  const providerCatalog = catalog[fixedPolicy.provider];
  let selectedModel: ModelProfile | undefined;
  const candidateTiers: readonly ModelTier[] =
    request.role === "impact_observer"
      ? ["economy"]
      : TIERS.slice(tierIndex(requiredTier));
  for (const tier of candidateTiers) {
    const candidate = providerCatalog[tier];
    if (modelFits(candidate, usage)) {
      selectedModel = candidate;
      break;
    }
  }

  if (selectedModel === undefined) {
    return Object.freeze({
      disposition: "blocked",
      request,
      reason: "model_context_exceeded",
      detail: "Compact or split the context; no policy-eligible model can safely fit this turn.",
      model: null,
      usage,
      cost: noModelCost(),
      authority: AUTHORITY_BOUNDARY,
    });
  }

  if (tierIndex(selectedModel.tier) > tierIndex(requiredTier)) {
    reasons.push(
      reason(
        "context_capacity",
        selectedModel.tier,
        `The ${requiredTier} model cannot fit the estimated context and reserved output.`,
      ),
    );
  }

  const decision: ModelRouteDecision = Object.freeze({
    disposition: "model",
    request,
    provider: fixedPolicy.provider,
    baselineTier: fixedPolicy.baselineTier,
    selectedTier: selectedModel.tier,
    model: selectedModel,
    escalated: tierIndex(selectedModel.tier) > tierIndex(fixedPolicy.baselineTier),
    reasons: Object.freeze(reasons),
    usage,
    contextFit: contextFit(selectedModel, usage),
    cost: estimateCost(selectedModel, usage),
    authority: AUTHORITY_BOUNDARY,
    qualityClaimedEquivalentToFrontier: false,
  });
  return decision;
}

export function createModelRouter(inputCatalog: ModelCatalog): ModelRouter {
  const catalog = snapshotCatalog(inputCatalog);
  return Object.freeze({
    route(request: RouteRequest): RouteDecision {
      return routeWithCatalog(catalog, request);
    },
  });
}
