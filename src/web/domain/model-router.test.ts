import { describe, expect, it } from 'vitest';

import {
  CURRENT_MODEL_MAPPING,
  compareRouteCostToFrontier,
  estimateTokens,
  routeModel,
} from './model-router';

describe('cheap-first model routing', () => {
  it('defaults engineering and verification to GPT-5.4 mini', () => {
    const engineer = routeModel({ role: 'engineer', risk: 'low' });
    const verifier = routeModel({ role: 'verifier', risk: 'low' });

    expect(engineer.model.modelId).toBe('gpt-5.4-mini');
    expect(engineer.model.price.inputPerMillionUsd).toBe(0.75);
    expect(engineer.model.price.outputPerMillionUsd).toBe(4.5);
    expect(verifier.model.modelId).toBe('gpt-5.4-mini');
    expect([engineer, verifier].every((route) => route.tier === 'economy')).toBe(true);
  });

  it('routes manager oversight to at least Claude Sonnet', () => {
    const manager = routeModel({ role: 'manager', risk: 'low' });
    expect(manager.model.modelId).toBe('claude-sonnet-5');
    expect(manager.tier).toBe('balanced');
  });

  it('uses balanced models for medium or high risk and a first measured failure', () => {
    expect(routeModel({ role: 'engineer', risk: 'medium' }).model.modelId).toBe('gpt-5.6-terra');
    expect(routeModel({ role: 'engineer', risk: 'high' }).model.modelId).toBe('gpt-5.6-terra');
    const retried = routeModel({
      role: 'engineer',
      risk: 'low',
      evidence: { verificationFailures: 1 },
    });
    expect(retried.model.modelId).toBe('gpt-5.6-terra');
    expect(retried.escalated).toBe(true);
  });

  it('uses at least balanced for managers, security-sensitive work, and large diffs', () => {
    expect(routeModel({ role: 'manager', risk: 'low' }).model.modelId).toBe('claude-sonnet-5');
    expect(
      routeModel({
        role: 'engineer',
        risk: 'low',
        evidence: { securitySensitive: true },
      }).model.modelId,
    ).toBe('gpt-5.6-terra');
    expect(
      routeModel({
        role: 'manager',
        risk: 'low',
        evidence: { largeDiff: true },
      }).model.modelId,
    ).toBe('claude-sonnet-5');
  });

  it('reserves Sol and Fable for critical risk or measured frontier escalation', () => {
    expect(routeModel({ role: 'manager', risk: 'critical' }).model.modelId).toBe(
      'claude-fable-5',
    );

    const repeatedFailure = routeModel({
      role: 'engineer',
      risk: 'low',
      evidence: { failedAttempts: 2 },
    });
    expect(repeatedFailure.model.modelId).toBe('gpt-5.6-sol');
    expect(repeatedFailure.escalated).toBe(true);

    const measuredRegression = routeModel({
      role: 'manager',
      risk: 'low',
      evidence: { evaluatorScore: 0.78, minimumEvaluatorScore: 0.9 },
    });
    expect(measuredRegression.model.modelId).toBe('claude-fable-5');
    expect(measuredRegression.escalated).toBe(true);
  });

  it('honors an explicit provider without changing the tier policy', () => {
    const route = routeModel({
      role: 'engineer',
      risk: 'low',
      providerPreference: 'anthropic',
    });
    expect(route.provider).toBe('anthropic');
    expect(route.model).toBe(CURRENT_MODEL_MAPPING.anthropic.economy);
  });

  it('compares token price with a frontier baseline without claiming equal quality', () => {
    const route = routeModel({ role: 'engineer', risk: 'low' });
    const tokens = estimateTokens({ inputTokens: 100_000, outputTokens: 10_000 });
    const comparison = compareRouteCostToFrontier(route, tokens);

    expect(comparison.routed.estimatedUsd).toBeCloseTo(0.12);
    expect(comparison.frontierBaseline.model.modelId).toBe('gpt-5.6-sol');
    expect(comparison.frontierBaseline.estimatedUsd).toBeCloseTo(0.8);
    expect(comparison.estimatedSavingsPercent).toBe(85);
    expect(comparison.qualityAssessed).toBe(false);
    expect(comparison.caveat).toContain('not a quality claim');
  });

  it('accepts separate token estimates when provider tokenizers differ', () => {
    const route = routeModel({ role: 'manager', risk: 'low' });
    const routed = estimateTokens({ inputTokens: 80_000, outputTokens: 8_000 });
    const frontier = estimateTokens({ inputTokens: 104_000, outputTokens: 10_400 });
    const comparison = compareRouteCostToFrontier(route, routed, frontier);

    expect(comparison.routed.tokens).toBe(routed);
    expect(comparison.frontierBaseline.tokens).toBe(frontier);
  });

  it('labels character-based token estimates as heuristic', () => {
    const estimate = estimateTokens({ inputCharacters: 8_001, expectedOutputTokens: 500 });
    expect(estimate.inputTokens).toBe(2_001);
    expect(estimate.outputTokens).toBe(500);
    expect(estimate.method).toBe('character_heuristic');
    expect(estimate.caveat).toBeDefined();
  });
});
