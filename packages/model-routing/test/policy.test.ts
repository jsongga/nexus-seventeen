import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FIXED_ROLE_PHASE_POLICY,
  RoutingPolicyError,
  createModelRouter,
  type AgentRole,
  type ContextBudget,
  type ModelCatalog,
  type ModelProfile,
  type ModelProvider,
  type ModelTier,
  type RouteRequest,
  type TaskRisk,
  type WorkPhase,
} from "../src/index.js";

const tierCapacity = Object.freeze({
  economy: Object.freeze({ context: 32_000, output: 4_000 }),
  balanced: Object.freeze({ context: 64_000, output: 8_000 }),
  frontier: Object.freeze({ context: 128_000, output: 16_000 }),
} as const);

const price = Object.freeze({
  economy: Object.freeze({ input: 0.25, output: 1 }),
  balanced: Object.freeze({ input: 1.5, output: 6 }),
  frontier: Object.freeze({ input: 8, output: 32 }),
} as const);

function profile(
  provider: ModelProvider,
  tier: ModelTier,
  includeRateCard = true,
): ModelProfile {
  const base = {
    provider,
    tier,
    modelId: `${provider}-${tier}-configured-id`,
    contextWindowTokens: tierCapacity[tier].context,
    maximumOutputTokens: tierCapacity[tier].output,
  } as const;
  if (!includeRateCard) return base;
  return {
    ...base,
    rateCard: {
      id: `${provider}-${tier}-rates-v7`,
      currency: "TEST_CREDITS",
      inputPerMillionTokens: price[tier].input,
      outputPerMillionTokens: price[tier].output,
      effectiveAt: "catalog-revision-7",
    },
  };
}

function catalog(
  withoutRateCard?: Readonly<{ provider: ModelProvider; tier: ModelTier }>,
): ModelCatalog {
  function entry(provider: ModelProvider, tier: ModelTier): ModelProfile {
    const omit =
      withoutRateCard?.provider === provider && withoutRateCard.tier === tier;
    return profile(provider, tier, !omit);
  }
  return {
    codex: {
      economy: entry("codex", "economy"),
      balanced: entry("codex", "balanced"),
      frontier: entry("codex", "frontier"),
    },
    claude: {
      economy: entry("claude", "economy"),
      balanced: entry("claude", "balanced"),
      frontier: entry("claude", "frontier"),
    },
  };
}

function request(
  overrides: Partial<Omit<RouteRequest, "context">> & {
    context?: Partial<ContextBudget>;
  } = {},
): RouteRequest {
  return {
    role: overrides.role ?? "engineer",
    phase: overrides.phase ?? "execute",
    purpose: overrides.purpose ?? "development",
    complexity: overrides.complexity ?? "low",
    risk: overrides.risk ?? "low",
    priorFailedTests: overrides.priorFailedTests ?? 0,
    context: {
      estimatedInputTokens: overrides.context?.estimatedInputTokens ?? 1_000,
      reservedOutputTokens: overrides.context?.reservedOutputTokens ?? 500,
      maximumTurnTokens: overrides.context?.maximumTurnTokens ?? 20_000,
    },
  };
}

const allowedRoutes = [
  ["engineer", "research", "codex", "economy"],
  ["engineer", "plan", "codex", "economy"],
  ["engineer", "execute", "codex", "economy"],
  ["engineer", "test", "codex", "economy"],
  ["verifier", "research", "claude", "economy"],
  ["verifier", "plan", "claude", "economy"],
  ["verifier", "test", "claude", "balanced"],
  ["verifier", "review", "claude", "balanced"],
  ["manager", "research", "claude", "economy"],
  ["manager", "plan", "claude", "economy"],
  ["manager", "review", "claude", "balanced"],
  ["manager", "coordinate", "claude", "economy"],
  ["impact_observer", "summarize", "claude", "economy"],
] as const satisfies readonly (readonly [AgentRole, WorkPhase, ModelProvider, ModelTier])[];

const allRoles = ["engineer", "verifier", "manager", "impact_observer"] as const;
const allPhases = [
  "research",
  "plan",
  "execute",
  "test",
  "review",
  "coordinate",
  "summarize",
] as const;

test("the complete fixed role/phase matrix routes at its cheap-first baseline", () => {
  const router = createModelRouter(catalog());
  for (const [role, phase, provider, tier] of allowedRoutes) {
    const decision = router.route(request({ role, phase }));
    assert.equal(decision.disposition, "model", `${role}/${phase}`);
    if (decision.disposition !== "model") continue;
    assert.equal(decision.provider, provider, `${role}/${phase} provider`);
    assert.equal(decision.baselineTier, tier, `${role}/${phase} baseline`);
    assert.equal(decision.selectedTier, tier, `${role}/${phase} selection`);
    assert.equal(decision.escalated, false, `${role}/${phase} escalation`);
    assert.equal(decision.model.modelId, `${provider}-${tier}-configured-id`);
    assert.equal(decision.reasons[0]?.code, "fixed_role_phase_baseline");
  }
});

test("every role/phase combination outside the fixed matrix is rejected", () => {
  const router = createModelRouter(catalog());
  const allowed = new Set(allowedRoutes.map(([role, phase]) => `${role}/${phase}`));
  for (const role of allRoles) {
    for (const phase of allPhases) {
      if (allowed.has(`${role}/${phase}`)) continue;
      assert.throws(
        () => router.route(request({ role, phase })),
        (error: unknown) =>
          error instanceof RoutingPolicyError && error.code === "ROLE_PHASE_MISMATCH",
        `${role}/${phase}`,
      );
    }
  }
});

test("risk raises only the minimum tier justified by that risk", () => {
  const router = createModelRouter(catalog());
  const expectations = [
    ["low", "economy", undefined],
    ["medium", "balanced", "medium_risk"],
    ["high", "balanced", "high_risk"],
    ["critical", "frontier", "critical_risk"],
  ] as const satisfies readonly (readonly [TaskRisk, ModelTier, string | undefined])[];

  for (const [risk, tier, evidenceCode] of expectations) {
    const decision = router.route(request({ risk }));
    assert.equal(decision.disposition, "model");
    if (decision.disposition !== "model") continue;
    assert.equal(decision.selectedTier, tier, risk);
    if (evidenceCode === undefined) {
      assert.equal(decision.reasons.length, 1);
    } else {
      assert.ok(decision.reasons.some(({ code }) => code === evidenceCode));
    }
  }
});

test("complexity remains cheap until the high-complexity signal is present", () => {
  const router = createModelRouter(catalog());
  const low = router.route(request({ complexity: "low" }));
  const medium = router.route(request({ complexity: "medium" }));
  const high = router.route(request({ complexity: "high" }));

  assert.equal(low.disposition === "model" ? low.selectedTier : undefined, "economy");
  assert.equal(medium.disposition === "model" ? medium.selectedTier : undefined, "economy");
  assert.equal(high.disposition === "model" ? high.selectedTier : undefined, "balanced");
  assert.ok(
    high.disposition === "model" &&
      high.reasons.some(({ code }) => code === "high_complexity"),
  );
});

test("observed failed tests provide the only retry escalation signal", () => {
  const router = createModelRouter(catalog());
  const expected = [
    [0, "economy", undefined],
    [1, "balanced", "first_failed_test"],
    [2, "frontier", "repeated_failed_tests"],
    [20, "frontier", "repeated_failed_tests"],
  ] as const;

  for (const [priorFailedTests, tier, evidenceCode] of expected) {
    const decision = router.route(request({ priorFailedTests }));
    assert.equal(decision.disposition, "model");
    if (decision.disposition !== "model") continue;
    assert.equal(decision.selectedTier, tier);
    assert.equal(
      decision.reasons.some(({ code }) => code === evidenceCode),
      evidenceCode !== undefined,
    );
  }
});

test("existing balanced role baselines do not pretend to be evidence escalations", () => {
  const router = createModelRouter(catalog());
  const baseline = router.route(request({ role: "manager", phase: "review" }));
  const firstFailure = router.route(
    request({ role: "manager", phase: "review", priorFailedTests: 1 }),
  );
  const repeatedFailure = router.route(
    request({ role: "manager", phase: "review", priorFailedTests: 2 }),
  );

  assert.equal(baseline.disposition === "model" && baseline.escalated, false);
  assert.equal(firstFailure.disposition === "model" && firstFailure.escalated, false);
  assert.equal(firstFailure.disposition === "model" && firstFailure.selectedTier, "balanced");
  assert.equal(repeatedFailure.disposition === "model" && repeatedFailure.escalated, true);
  assert.equal(
    repeatedFailure.disposition === "model" && repeatedFailure.selectedTier,
    "frontier",
  );
});

test("context capacity is auditable evidence for selecting a larger tier", () => {
  const router = createModelRouter(catalog());
  const balanced = router.route(
    request({
      context: {
        estimatedInputTokens: 30_000,
        reservedOutputTokens: 3_000,
        maximumTurnTokens: 100_000,
      },
    }),
  );
  const frontier = router.route(
    request({
      context: {
        estimatedInputTokens: 60_000,
        reservedOutputTokens: 8_000,
        maximumTurnTokens: 100_000,
      },
    }),
  );

  assert.equal(balanced.disposition === "model" && balanced.selectedTier, "balanced");
  assert.equal(frontier.disposition === "model" && frontier.selectedTier, "frontier");
  for (const decision of [balanced, frontier]) {
    assert.ok(
      decision.disposition === "model" &&
        decision.reasons.some(({ code }) => code === "context_capacity"),
    );
  }
});

test("an oversized turn is blocked instead of silently spending more", () => {
  const router = createModelRouter(catalog());
  const overBudget = router.route(
    request({
      context: {
        estimatedInputTokens: 2_000,
        reservedOutputTokens: 1_000,
        maximumTurnTokens: 2_999,
      },
    }),
  );
  assert.equal(overBudget.disposition, "blocked");
  assert.equal(overBudget.disposition === "blocked" && overBudget.reason, "turn_token_budget_exceeded");
  assert.equal(overBudget.usage.remainingTokensAfterEstimate, -1);
  assert.equal(overBudget.model, null);

  const noContextFit = router.route(
    request({
      context: {
        estimatedInputTokens: 120_000,
        reservedOutputTokens: 16_000,
        maximumTurnTokens: 200_000,
      },
    }),
  );
  assert.equal(noContextFit.disposition, "blocked");
  assert.equal(noContextFit.disposition === "blocked" && noContextFit.reason, "model_context_exceeded");

  const noOutputFit = router.route(
    request({
      context: {
        estimatedInputTokens: 1_000,
        reservedOutputTokens: 16_001,
        maximumTurnTokens: 30_000,
      },
    }),
  );
  assert.equal(noOutputFit.disposition, "blocked");
  assert.equal(noOutputFit.disposition === "blocked" && noOutputFit.reason, "model_context_exceeded");
});

test("the bounded impact observer never escalates based on source-task risk or failures", () => {
  const router = createModelRouter(catalog());
  const observer = router.route(
    request({
      role: "impact_observer",
      phase: "summarize",
      risk: "critical",
      complexity: "high",
      priorFailedTests: 12,
    }),
  );
  assert.equal(observer.disposition, "model");
  assert.equal(observer.disposition === "model" && observer.selectedTier, "economy");
  assert.deepEqual(
    observer.disposition === "model" && observer.reasons.map(({ code }) => code),
    ["fixed_role_phase_baseline", "bounded_observer"],
  );

  const oversized = router.route(
    request({
      role: "impact_observer",
      phase: "summarize",
      context: {
        estimatedInputTokens: 32_000,
        reservedOutputTokens: 1,
        maximumTurnTokens: 40_000,
      },
    }),
  );
  assert.equal(oversized.disposition, "blocked");
  assert.equal(oversized.disposition === "blocked" && oversized.reason, "model_context_exceeded");
});

test("every production approval and deployment route is human-only at every risk", () => {
  const router = createModelRouter(catalog());
  const risks = ["low", "medium", "high", "critical"] as const;
  const purposes = ["production_decision", "production_deployment"] as const;

  for (const [role, phase] of allowedRoutes.map(([role, phase]) => [role, phase] as const)) {
    for (const risk of risks) {
      for (const purpose of purposes) {
        const decision = router.route(request({ role, phase, risk, purpose }));
        assert.equal(decision.disposition, "human_required", `${role}/${phase}/${risk}/${purpose}`);
        assert.equal(decision.model, null);
        assert.equal(decision.cost.status, "not_applicable");
        assert.equal(decision.authority.modelMayApproveProduction, false);
        assert.equal(decision.authority.modelMayDeployToProduction, false);
        assert.equal(decision.authority.authenticatedHumanApprovalRequired, true);
      }
    }
  }

  const invalidModelPhaseStillCannotCrossBoundary = router.route(
    request({
      role: "engineer",
      phase: "review",
      risk: "critical",
      purpose: "production_decision",
    }),
  );
  assert.equal(invalidModelPhaseStillCannotCrossBoundary.disposition, "human_required");
});

test("production assessment may use a model but never grants production authority", () => {
  const decision = createModelRouter(catalog()).route(
    request({
      role: "manager",
      phase: "review",
      purpose: "production_assessment",
      risk: "high",
    }),
  );
  assert.equal(decision.disposition, "model");
  if (decision.disposition !== "model") return;
  assert.equal(decision.selectedTier, "balanced");
  assert.deepEqual(decision.authority, {
    modelMayDeployToProduction: false,
    modelMayApproveProduction: false,
    authenticatedHumanApprovalRequired: true,
  });
});

test("token, context, and cost metadata use only the injected rate card", () => {
  const decision = createModelRouter(catalog()).route(request());
  assert.equal(decision.disposition, "model");
  if (decision.disposition !== "model") return;

  assert.deepEqual(decision.usage, {
    inputTokens: 1_000,
    reservedOutputTokens: 500,
    totalTokens: 1_500,
    maximumTurnTokens: 20_000,
    remainingTokensAfterEstimate: 18_500,
    method: "caller_estimate",
  });
  assert.deepEqual(decision.contextFit, {
    modelContextWindowTokens: 32_000,
    modelMaximumOutputTokens: 4_000,
    projectedRemainingContextTokens: 30_500,
    projectedContextUtilization: 1_500 / 32_000,
  });
  assert.deepEqual(decision.cost, {
    status: "estimated",
    currency: "TEST_CREDITS",
    estimatedInputCost: 0.00025,
    estimatedOutputCost: 0.0005,
    estimatedTotalCost: 0.00075,
    rateCardId: "codex-economy-rates-v7",
    rateEffectiveAt: "catalog-revision-7",
    basis: "estimated_input_and_reserved_output",
  });
  assert.equal(decision.qualityClaimedEquivalentToFrontier, false);
});

test("missing prices are explicit and never replaced by stale hardcoded rates", () => {
  const noRate = createModelRouter(
    catalog({ provider: "codex", tier: "economy" }),
  ).route(request());
  assert.equal(noRate.disposition, "model");
  assert.deepEqual(noRate.cost, {
    status: "unavailable",
    reason: "rate_card_not_supplied",
  });

  const custom = catalog();
  const mutableRate = custom.codex.economy.rateCard as {
    inputPerMillionTokens: number;
    outputPerMillionTokens: number;
  };
  mutableRate.inputPerMillionTokens = 7;
  mutableRate.outputPerMillionTokens = 11;
  const customRate = createModelRouter(custom).route(request());
  assert.equal(customRate.disposition, "model");
  assert.equal(customRate.cost.status, "estimated");
  if (customRate.cost.status !== "estimated") return;
  assert.equal(customRate.cost.estimatedInputCost, 0.007);
  assert.equal(customRate.cost.estimatedOutputCost, 0.0055);
  assert.equal(customRate.cost.estimatedTotalCost, 0.0125);
});

test("router creation snapshots and freezes caller-owned catalog data", () => {
  const source = catalog();
  const router = createModelRouter(source);
  const mutableProfile = source.codex.economy as { modelId: string };
  const mutableRate = source.codex.economy.rateCard as { inputPerMillionTokens: number };
  mutableProfile.modelId = "changed-after-router-creation";
  mutableRate.inputPerMillionTokens = 999;

  const decision = router.route(request());
  assert.equal(decision.disposition, "model");
  if (decision.disposition !== "model") return;
  assert.equal(decision.model.modelId, "codex-economy-configured-id");
  assert.equal(decision.model.rateCard?.inputPerMillionTokens, 0.25);
  assert.equal(Object.isFrozen(decision.model), true);
  assert.equal(Object.isFrozen(decision.model.rateCard), true);
  assert.equal(Object.isFrozen(decision.reasons), true);
  assert.equal(Object.isFrozen(decision.request.context), true);
});

test("catalog validation fails closed for missing, mismatched, or unsafe profiles", () => {
  const complete = catalog();
  const incompleteCodex: Partial<Record<ModelTier, ModelProfile>> = {
    ...complete.codex,
  };
  delete incompleteCodex.frontier;
  const missing = { codex: incompleteCodex, claude: complete.claude };
  assert.throws(
    () => createModelRouter(missing as ModelCatalog),
    (error: unknown) =>
      error instanceof RoutingPolicyError && error.code === "INVALID_CATALOG",
  );

  const mismatch = catalog() as unknown as {
    codex: { economy: ModelProfile } & Omit<ModelCatalog["codex"], "economy">;
    claude: ModelCatalog["claude"];
  };
  mismatch.codex.economy = { ...mismatch.codex.economy, provider: "claude" };
  assert.throws(() => createModelRouter(mismatch as ModelCatalog), /same provider and tier/u);

  const invalidWindow = catalog() as unknown as {
    codex: { economy: ModelProfile } & Omit<ModelCatalog["codex"], "economy">;
    claude: ModelCatalog["claude"];
  };
  invalidWindow.codex.economy = {
    ...invalidWindow.codex.economy,
    contextWindowTokens: 0,
  };
  assert.throws(() => createModelRouter(invalidWindow as ModelCatalog), /positive safe integer/u);

  const invalidOutput = catalog() as unknown as {
    codex: { economy: ModelProfile } & Omit<ModelCatalog["codex"], "economy">;
    claude: ModelCatalog["claude"];
  };
  invalidOutput.codex.economy = {
    ...invalidOutput.codex.economy,
    maximumOutputTokens: 32_001,
  };
  assert.throws(() => createModelRouter(invalidOutput as ModelCatalog), /cannot exceed/u);

  const invalidPrice = catalog() as unknown as {
    codex: { economy: ModelProfile } & Omit<ModelCatalog["codex"], "economy">;
    claude: ModelCatalog["claude"];
  };
  invalidPrice.codex.economy = {
    ...invalidPrice.codex.economy,
    rateCard: {
      ...invalidPrice.codex.economy.rateCard!,
      inputPerMillionTokens: Number.NaN,
    },
  };
  assert.throws(() => createModelRouter(invalidPrice as ModelCatalog), /finite, non-negative/u);
});

test("request token estimates and observed failure counts are validated", () => {
  const router = createModelRouter(catalog());
  const cases = [
    request({ context: { estimatedInputTokens: -1 } }),
    request({ context: { estimatedInputTokens: 1.2 } }),
    request({ context: { reservedOutputTokens: -1 } }),
    request({ context: { maximumTurnTokens: 0 } }),
    request({ priorFailedTests: -1 }),
    request({ priorFailedTests: 0.5 }),
  ];
  for (const invalidRequest of cases) {
    assert.throws(
      () => router.route(invalidRequest),
      (error: unknown) =>
        error instanceof RoutingPolicyError && error.code === "INVALID_REQUEST",
    );
  }
});

test("untyped callers cannot route unknown policy values", () => {
  const router = createModelRouter(catalog());
  const cases = [
    { ...request(), role: "intern" },
    { ...request(), phase: "deploy" },
    { ...request(), purpose: "production_decison" },
    { ...request(), complexity: "extreme" },
    { ...request(), risk: "unknown" },
  ];
  for (const invalidRequest of cases) {
    assert.throws(
      () => router.route(invalidRequest as unknown as RouteRequest),
      (error: unknown) =>
        error instanceof RoutingPolicyError && error.code === "INVALID_REQUEST",
    );
  }
});

test("the exported policy matrix is immutable", () => {
  assert.equal(Object.isFrozen(FIXED_ROLE_PHASE_POLICY), true);
  assert.equal(Object.isFrozen(FIXED_ROLE_PHASE_POLICY.engineer), true);
  assert.equal(Object.isFrozen(FIXED_ROLE_PHASE_POLICY.engineer.execute), true);
});
