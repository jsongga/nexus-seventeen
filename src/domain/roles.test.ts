import { describe, expect, it } from 'vitest';

import { canAssignManager } from './approval-policy';
import {
  AGENT_ROLE_KEYS,
  BROAD_DEVELOPMENT_CAPABILITIES,
  FORBIDDEN_AGENT_PRODUCTION_CAPABILITIES,
  ROLE_TEMPLATES,
  hasCapability,
} from './roles';
import { SEED_AGENTS, SEED_WORK_ITEMS } from './seed';

describe('fixed roles and capabilities', () => {
  it('gives engineers broad development freedom', () => {
    for (const capability of BROAD_DEVELOPMENT_CAPABILITIES) {
      expect(hasCapability('engineer', capability)).toBe(true);
    }
  });

  it('never gives an agent production approval, consumption, or deployment', () => {
    for (const role of AGENT_ROLE_KEYS) {
      expect(ROLE_TEMPLATES[role].principalKind).toBe('agent');
      for (const capability of FORBIDDEN_AGENT_PRODUCTION_CAPABILITIES) {
        expect(hasCapability(role, capability)).toBe(false);
      }
    }

    expect(hasCapability('manager', 'production.request_approval')).toBe(true);
    expect(hasCapability('human_approver', 'production.approve')).toBe(true);
    expect(hasCapability('human_approver', 'production.deploy')).toBe(false);
  });

  it('keeps seeded engineer and manager assignments independent', () => {
    for (const workItem of SEED_WORK_ITEMS) {
      const { engineer, manager } = workItem.assignments;
      if (engineer && manager) {
        expect(canAssignManager(engineer, manager)).toEqual({ allowed: true, value: true });
      }
    }

    expect(new Set(SEED_AGENTS.map((agent) => agent.id)).size).toBe(SEED_AGENTS.length);
  });

  it('rejects self-review even if malformed data assigns one identity twice', () => {
    const engineer = SEED_AGENTS.find((agent) => agent.role === 'engineer');
    expect(engineer).toBeDefined();
    if (!engineer) {
      return;
    }

    const decision = canAssignManager(engineer.id, engineer.id);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe('MANAGER_SEPARATION_REQUIRED');
    }
  });
});
