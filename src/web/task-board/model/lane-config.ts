import type { BoardAgent } from '../types';

export const MASKED_LANE_TOKEN = '<rotate token to reveal>';

export interface LaneConfigurationState {
  tokenVisible: boolean;
  snippet: string;
}

export function laneConfigurationState(agent: BoardAgent, visibleToken: string | null): LaneConfigurationState {
  const token = visibleToken ?? MASKED_LANE_TOKEN;
  const provider = agent.model !== null && /^claude(?:-|$)/iu.test(agent.model)
    ? 'claude'
    : agent.model !== null && /^codex(?:-|$)/iu.test(agent.model)
      ? 'codex'
      : '<codex or claude>';
  return {
    tokenVisible: visibleToken !== null,
    snippet: JSON.stringify({
      workerId: agent.id,
      agentId: agent.id,
      token,
      provider,
      model: agent.model ?? 'auto',
      workingDirectory: '/absolute/path/to/repository',
      statePath: `/absolute/path/to/.steward-data/workers/${agent.id.replaceAll('/', '-')}.json`,
    }, null, 2),
  };
}
