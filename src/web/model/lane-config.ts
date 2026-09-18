/** Builds AgentPage's copyable fleet-lane configuration while revealing a credential only immediately after rotation. */

import type { BoardAgent } from "../types";

export const MASKED_LANE_TOKEN = "<rotate token to reveal>";

interface LaneConfigurationState {
  tokenVisible: boolean;
  snippet: string;
}

export function laneConfigurationState(agent: BoardAgent, visibleToken: string | null): LaneConfigurationState {
  const token = visibleToken ?? MASKED_LANE_TOKEN;
  const runtime =
    agent.model !== null && /^claude(?:-|$)/iu.test(agent.model)
      ? "claude"
      : agent.model !== null && /^codex(?:-|$)/iu.test(agent.model)
        ? "codex"
        : "<codex or claude>";
  return {
    tokenVisible: visibleToken !== null,
    snippet: JSON.stringify(
      {
        workerId: agent.id,
        agentId: agent.id,
        token,
        runtime,
        launchMode: "local-process",
        model: agent.model ?? "auto",
        workingDirectory: "/absolute/path/to/repository",
        statePath: `/absolute/path/to/.steward-data/workers/${agent.id.replaceAll("/", "-")}.json`,
      },
      null,
      2
    ),
  };
}
