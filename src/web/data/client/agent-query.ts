/** Builds the prompt an agent query sends, bounded so a long conversation cannot grow it without limit. */

/* —— Imports —— */

import type { AgentQueryConversationTurn } from "../../types";

/* —— Agent query prompts —— */

export const maximumAgentQueryObjectiveCharacters = 8_000;

const maximumAgentQueryConversationCharacters = 2_400;

const maximumAgentQueryConversationTurns = 12;

const maximumAgentQueryTurnCharacters = 480;

export const agentQueryConversationContextMarker =
  "\n\nRecent POC conversation (context only; newest request is above):\n";

export const agentQueryRoutingContextMarker =
  "\n\nCompany routing map (use this only to identify the best project or agent):\n";

export function agentQueryPromptFromObjective(objective: string): string {
  const sectionIndexes = [
    objective.indexOf(agentQueryConversationContextMarker),
    objective.indexOf(agentQueryRoutingContextMarker),
  ].filter((index) => index >= 0);
  const promptEnd = sectionIndexes.length > 0 ? Math.min(...sectionIndexes) : objective.length;
  return objective.slice(0, promptEnd).trim();
}

function compactAgentQueryText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateAgentQueryText(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) return value;
  if (maximumCharacters <= 1) return "…".slice(0, maximumCharacters);
  return `${value.slice(0, maximumCharacters - 1).trimEnd()}…`;
}

export function recentAgentQueryConversation(turns: AgentQueryConversationTurn[], newestPrompt: string): string {
  const newestPromptKey = compactAgentQueryText(newestPrompt);
  const selected: string[] = [];
  const seen = new Set<string>();
  let characters = 0;

  for (let index = turns.length - 1; index >= 0 && selected.length < maximumAgentQueryConversationTurns; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    const body = compactAgentQueryText(turn.body);
    if (!body || (turn.role === "human" && body === newestPromptKey)) continue;
    const key = `${turn.role}\u0000${body}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const label = turn.role === "human" ? "Human" : "Agent";
    const line = `${label}: ${truncateAgentQueryText(body, maximumAgentQueryTurnCharacters)}`;
    const separatorCharacters = selected.length > 0 ? 1 : 0;
    if (characters + separatorCharacters + line.length > maximumAgentQueryConversationCharacters) break;
    selected.unshift(line);
    characters += separatorCharacters + line.length;
  }

  return selected.join("\n");
}

export function appendAgentQuerySection(objective: string, marker: string, content: string): string {
  if (!content) return objective;
  const availableCharacters = maximumAgentQueryObjectiveCharacters - objective.length - marker.length;
  if (availableCharacters <= 0) return objective;
  return `${objective}${marker}${truncateAgentQueryText(content, availableCharacters)}`;
}
