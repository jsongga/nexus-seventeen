import type {
  AgentRole,
  CostComparison,
  CostEstimate,
  EscalationEvidence,
  ModelProfile,
  ModelProvider,
  ModelTier,
  RouteDecision,
  RouteRequest,
  TokenEstimate,
} from './types';

export const MODEL_CATALOG_AS_OF = '2026-07-18';

function model(profile: ModelProfile): ModelProfile {
  return Object.freeze({
    ...profile,
    price: Object.freeze({ ...profile.price }),
  });
}

export const CURRENT_MODEL_MAPPING = Object.freeze({
  openai: Object.freeze({
    economy: model({
      provider: 'openai',
      tier: 'economy',
      modelId: 'gpt-5.4-mini',
      displayName: 'GPT-5.4 mini',
      price: {
        inputPerMillionUsd: 0.75,
        outputPerMillionUsd: 4.5,
        asOf: MODEL_CATALOG_AS_OF,
      },
      sourceUrl: 'https://developers.openai.com/api/docs/models',
    }),
    balanced: model({
      provider: 'openai',
      tier: 'balanced',
      modelId: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
      price: {
        inputPerMillionUsd: 2.5,
        outputPerMillionUsd: 15,
        asOf: MODEL_CATALOG_AS_OF,
      },
      sourceUrl: 'https://developers.openai.com/api/docs/models',
    }),
    frontier: model({
      provider: 'openai',
      tier: 'frontier',
      modelId: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      price: {
        inputPerMillionUsd: 5,
        outputPerMillionUsd: 30,
        asOf: MODEL_CATALOG_AS_OF,
      },
      sourceUrl: 'https://developers.openai.com/api/docs/models',
    }),
  }),
  anthropic: Object.freeze({
    economy: model({
      provider: 'anthropic',
      tier: 'economy',
      modelId: 'claude-haiku-4-5-20251001',
      displayName: 'Claude Haiku 4.5',
      price: {
        inputPerMillionUsd: 1,
        outputPerMillionUsd: 5,
        asOf: MODEL_CATALOG_AS_OF,
      },
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview',
    }),
    balanced: model({
      provider: 'anthropic',
      tier: 'balanced',
      modelId: 'claude-sonnet-5',
      displayName: 'Claude Sonnet 5',
      price: {
        inputPerMillionUsd: 2,
        outputPerMillionUsd: 10,
        asOf: MODEL_CATALOG_AS_OF,
        note: 'Introductory pricing through 2026-08-31; refresh catalog metadata after that date.',
      },
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    }),
    frontier: model({
      provider: 'anthropic',
      tier: 'frontier',
      modelId: 'claude-fable-5',
      displayName: 'Claude Fable 5',
      price: {
        inputPerMillionUsd: 10,
        outputPerMillionUsd: 50,
        asOf: MODEL_CATALOG_AS_OF,
      },
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview',
    }),
  }),
} satisfies Readonly<Record<ModelProvider, Readonly<Record<ModelTier, ModelProfile>>>>);

const DEFAULT_PROVIDER_BY_ROLE = Object.freeze({
  manager: 'anthropic',
  engineer: 'openai',
  verifier: 'openai',
} satisfies Readonly<Record<AgentRole, ModelProvider>>);

function hasMeasuredFrontierTrigger(evidence: EscalationEvidence | undefined): boolean {
  if (!evidence) {
    return false;
  }

  const repeatedFailure =
    (evidence.failedAttempts ?? 0) >= 2 || (evidence.verificationFailures ?? 0) >= 2;
  const measuredRegression =
    evidence.evaluatorScore !== undefined &&
    evidence.minimumEvaluatorScore !== undefined &&
    evidence.evaluatorScore < evidence.minimumEvaluatorScore;

  return repeatedFailure || measuredRegression;
}

function hasMeasuredBalancedTrigger(evidence: EscalationEvidence | undefined): boolean {
  return (
    (evidence?.failedAttempts ?? 0) === 1 || (evidence?.verificationFailures ?? 0) === 1
  );
}

function hasRiskEvidence(evidence: EscalationEvidence | undefined): boolean {
  return evidence?.securitySensitive === true || evidence?.largeDiff === true;
}

function chooseTier(request: RouteRequest): {
  readonly tier: ModelTier;
  readonly reasons: readonly string[];
  readonly escalated: boolean;
} {
  if (request.risk === 'critical') {
    return {
      tier: 'frontier',
      reasons: ['Critical risk is explicitly eligible for a frontier model.'],
      escalated: false,
    };
  }

  if (hasMeasuredFrontierTrigger(request.evidence)) {
    return {
      tier: 'frontier',
      reasons: ['Measured evaluator or repeated verification failures crossed the frontier threshold.'],
      escalated: true,
    };
  }

  if (request.risk === 'high') {
    return {
      tier: 'balanced',
      reasons: ['High-risk work starts on the balanced tier; measured failures may escalate it.'],
      escalated: false,
    };
  }

  if (hasRiskEvidence(request.evidence)) {
    const signals = [
      request.evidence?.securitySensitive ? 'security-sensitive' : undefined,
      request.evidence?.largeDiff ? 'large-diff' : undefined,
    ].filter((signal): signal is string => signal !== undefined);

    return {
      tier: 'balanced',
      reasons: [`${signals.join(' and ')} evidence requires at least the balanced tier.`],
      escalated: false,
    };
  }

  if (request.role === 'manager') {
    return {
      tier: 'balanced',
      reasons: ['Manager oversight always uses at least the balanced tier.'],
      escalated: false,
    };
  }

  if (request.risk === 'medium') {
    return {
      tier: 'balanced',
      reasons: ['Medium-risk work uses the balanced tier before spending frontier tokens.'],
      escalated: false,
    };
  }

  if (hasMeasuredBalancedTrigger(request.evidence)) {
    return {
      tier: 'balanced',
      reasons: ['One measured failure raised the route one tier; another failure may escalate again.'],
      escalated: true,
    };
  }

  return {
    tier: 'economy',
    reasons: ['Economy is the default until risk or observed results justify more spend.'],
    escalated: false,
  };
}

export function routeModel(request: RouteRequest): RouteDecision {
  const provider =
    request.providerPreference && request.providerPreference !== 'auto'
      ? request.providerPreference
      : DEFAULT_PROVIDER_BY_ROLE[request.role];
  const route = chooseTier(request);

  return Object.freeze({
    provider,
    tier: route.tier,
    model: CURRENT_MODEL_MAPPING[provider][route.tier],
    reasons: Object.freeze([...route.reasons]),
    escalated: route.escalated,
  });
}

export type TokenEstimateInput =
  | {
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | {
      readonly inputCharacters: number;
      readonly expectedOutputTokens: number;
      readonly charactersPerToken?: number;
    };

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite, non-negative number.`);
  }

  return Math.ceil(value);
}

export function estimateTokens(input: TokenEstimateInput): TokenEstimate {
  if ('inputTokens' in input) {
    return Object.freeze({
      inputTokens: nonNegativeInteger(input.inputTokens, 'inputTokens'),
      outputTokens: nonNegativeInteger(input.outputTokens, 'outputTokens'),
      method: 'provided',
    });
  }

  const charactersPerToken = input.charactersPerToken ?? 4;
  if (!Number.isFinite(charactersPerToken) || charactersPerToken <= 0) {
    throw new Error('charactersPerToken must be a finite number greater than zero.');
  }

  return Object.freeze({
    inputTokens: Math.ceil(
      nonNegativeInteger(input.inputCharacters, 'inputCharacters') / charactersPerToken,
    ),
    outputTokens: nonNegativeInteger(input.expectedOutputTokens, 'expectedOutputTokens'),
    method: 'character_heuristic',
    caveat: 'Character heuristics are directional; record provider usage for billing decisions.',
  });
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function estimateModelCost(modelProfile: ModelProfile, tokens: TokenEstimate): CostEstimate {
  const estimatedUsd =
    (tokens.inputTokens / 1_000_000) * modelProfile.price.inputPerMillionUsd +
    (tokens.outputTokens / 1_000_000) * modelProfile.price.outputPerMillionUsd;

  return Object.freeze({
    model: modelProfile,
    tokens,
    estimatedUsd: roundUsd(estimatedUsd),
  });
}

export function compareRouteCostToFrontier(
  decision: RouteDecision,
  routedTokens: TokenEstimate,
  frontierTokens: TokenEstimate = routedTokens,
): CostComparison {
  const routed = estimateModelCost(decision.model, routedTokens);
  const frontierBaseline = estimateModelCost(
    CURRENT_MODEL_MAPPING[decision.provider].frontier,
    frontierTokens,
  );
  const savings = frontierBaseline.estimatedUsd - routed.estimatedUsd;
  const savingsPercent =
    frontierBaseline.estimatedUsd === 0
      ? 0
      : (savings / frontierBaseline.estimatedUsd) * 100;

  return Object.freeze({
    routed,
    frontierBaseline,
    estimatedSavingsUsd: roundUsd(savings),
    estimatedSavingsPercent: Math.round(savingsPercent * 100) / 100,
    qualityAssessed: false,
    caveat:
      'This is a token-price comparison, not a quality claim. Validate routing against task outcomes; pass provider-specific token counts when tokenizers differ.',
  });
}
