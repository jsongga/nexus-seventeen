import { describe, expect, it } from 'vitest';
import type { BoardAgent } from '../types';
import { laneConfigurationState, MASKED_LANE_TOKEN } from './lane-config';

const agent: BoardAgent = {
  id: 'payment-tools-manager',
  projectId: 'project-payment-tools',
  name: 'payment-tools-manager',
  role: 'manager',
  area: 'Payment tools',
  mission: 'Plan incoming payment-tools work.',
  model: 'auto',
  status: 'sleeping',
  workerConnection: null,
  lastError: null,
  currentTaskId: null,
  lastEventAt: null,
  version: 1,
  createdAt: '2026-08-09T20:00:00.000Z',
  updatedAt: '2026-08-09T20:00:00.000Z',
};

describe('lane configuration state', () => {
  it('shows the exact fleet agent shape with a masked token before rotation', () => {
    const state = laneConfigurationState(agent, null);
    expect(state.tokenVisible).toBe(false);
    expect(JSON.parse(state.snippet)).toEqual({
      workerId: agent.id,
      agentId: agent.id,
      token: MASKED_LANE_TOKEN,
      provider: '<codex or claude>',
      model: 'auto',
      workingDirectory: '/absolute/path/to/repository',
      statePath: '/absolute/path/to/.steward-data/workers/payment-tools-manager.json',
    });
  });

  it('reveals only the token returned in the current page session', () => {
    const token = 'rotated-agent-token-012345678901234567890123';
    const visible = laneConfigurationState(agent, token);
    expect(visible.tokenVisible).toBe(true);
    expect(JSON.parse(visible.snippet)).toMatchObject({ agentId: agent.id, token });

    const leftPage = laneConfigurationState(agent, null);
    expect(leftPage.tokenVisible).toBe(false);
    expect(leftPage.snippet).not.toContain(token);
  });

  it('uses the fleet provider that matches an existing Claude model identity', () => {
    const state = laneConfigurationState({ ...agent, model: 'claude-sonnet-4-5' }, null);
    expect(JSON.parse(state.snippet)).toMatchObject({ provider: 'claude', model: 'claude-sonnet-4-5' });
  });

  it('uses the fleet provider that matches an explicit Codex model identity', () => {
    const state = laneConfigurationState({ ...agent, model: 'codex-mini' }, null);
    expect(JSON.parse(state.snippet)).toMatchObject({ provider: 'codex', model: 'codex-mini' });
  });
});
