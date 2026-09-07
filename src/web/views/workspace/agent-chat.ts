/** Orders an agent's tasks, questions and runs into one chat history. */

/* —— Imports —— */

import { agentQueryPromptFromObjective } from "../../data/client";
import { formatShortDateTime } from "../../data/date-format";
import type { AgentQueryConversationTurn, BoardAgent, BoardSnapshot } from "../../types";

/* —— Chat history —— */

/* —— Agent page —— */

export function formatTime(value: string | null): string {
  if (value === null) return "Not recorded";
  return formatShortDateTime(value);
}

interface AgentChatEntry {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  createdAtMs: number;
  sender: "human" | "agent" | "system";
  contextRole: AgentQueryConversationTurn["role"] | null;
  order: number;
}

export function orderAgentChatEntries(entries: AgentChatEntry[]): AgentChatEntry[] {
  return entries.sort(
    (left, right) => left.createdAtMs - right.createdAtMs || left.order - right.order || left.id.localeCompare(right.id)
  );
}

export function latestByUpdatedAt<T extends { id: string; updatedAtMs: number }>(items: T[]): T | undefined {
  return items.reduce<T | undefined>(
    (latest, item) =>
      latest === undefined ||
      item.updatedAtMs > latest.updatedAtMs ||
      (item.updatedAtMs === latest.updatedAtMs && item.id.localeCompare(latest.id) > 0)
        ? item
        : latest,
    undefined
  );
}

export function latestByAskedAt<T extends { askedAtMs: number; id: string }>(items: T[]): T | undefined {
  return items.reduce<T | undefined>(
    (latest, item) =>
      latest === undefined ||
      item.askedAtMs > latest.askedAtMs ||
      (item.askedAtMs === latest.askedAtMs && item.id.localeCompare(latest.id) > 0)
        ? item
        : latest,
    undefined
  );
}

export function agentChatTasks(agent: BoardAgent, snapshot: BoardSnapshot, pointOfContactOnly: boolean) {
  const queryPrefix = `Request for ${agent.id}: `;
  return snapshot.tasks.filter(
    (task) => task.assignedAgentId === agent.id && (!pointOfContactOnly || task.title.startsWith(queryPrefix))
  );
}

export function agentChatHistory(
  agent: BoardAgent,
  snapshot: BoardSnapshot,
  pointOfContactOnly: boolean
): AgentChatEntry[] {
  const chatTasks = agentChatTasks(agent, snapshot, pointOfContactOnly);
  const chatTaskIds = new Set(chatTasks.map((task) => task.id));
  const promptByTask = new Map(
    chatTasks.map((task) => [task.id, agentQueryPromptFromObjective(task.objective)] as const)
  );
  const messages = snapshot.messages.filter((message) => chatTaskIds.has(message.taskId));
  const questions = snapshot.questions.filter((question) => chatTaskIds.has(question.taskId));
  const questionBodies = new Set(questions.map((question) => `${question.taskId}\u0000${question.prompt.trim()}`));
  const answerBodies = new Set(
    questions.flatMap((question) =>
      question.answer === null ? [] : [`${question.taskId}\u0000${question.answer.trim()}`]
    )
  );
  const agentNames = new Map(snapshot.agents.map((item) => [item.id, item.name]));
  const entries: AgentChatEntry[] = chatTasks.map((task) => {
    const systemRequest = task.kind === "manager_review";
    return {
      id: `query-${task.id}`,
      author: systemRequest ? "System" : "You",
      body: promptByTask.get(task.id) ?? task.objective,
      createdAt: task.createdAt,
      createdAtMs: task.createdAtMs,
      sender: systemRequest ? "system" : "human",
      contextRole: systemRequest ? null : "human",
      order: 0,
    };
  });

  for (const message of messages) {
    const body = message.body.trim();
    if (message.authorType === "human" && body === promptByTask.get(message.taskId)) continue;
    if (message.kind === "question" && questionBodies.has(`${message.taskId}\u0000${body}`)) continue;
    if (message.kind === "answer" && answerBodies.has(`${message.taskId}\u0000${body}`)) continue;
    entries.push({
      id: `message-${message.id}`,
      author:
        message.authorType === "human"
          ? "You"
          : message.authorType === "system"
            ? "System"
            : (agentNames.get(message.authorId ?? "") ?? agent.name),
      body: message.body,
      createdAt: message.createdAt,
      createdAtMs: message.createdAtMs,
      sender: message.authorType,
      contextRole:
        message.authorType === "system"
          ? null
          : message.kind === "question"
            ? "agent"
            : message.kind === "answer"
              ? "human"
              : message.kind === "result"
                ? message.authorType === "human"
                  ? "human"
                  : "agent"
                : null,
      order: 1,
    });
  }

  for (const question of questions) {
    entries.push({
      id: `question-${question.id}`,
      author: agentNames.get(question.agentId) ?? agent.name,
      body: question.prompt,
      createdAt: question.askedAt,
      createdAtMs: question.askedAtMs,
      sender: "agent",
      contextRole: "agent",
      order: 2,
    });
    if (question.answer !== null) {
      entries.push({
        id: `answer-${question.id}`,
        author: "You",
        body: question.answer,
        createdAt: question.answeredAt ?? question.askedAt,
        createdAtMs: question.answeredAtMs ?? question.askedAtMs,
        sender: "human",
        contextRole: "human",
        order: 3,
      });
    }
  }

  for (const task of chatTasks) {
    const result = task.result?.trim();
    if (!result || messages.some((message) => message.taskId === task.id && message.body.trim() === result)) continue;
    entries.push({
      id: `result-${task.id}`,
      author: agent.name,
      body: result,
      createdAt: task.endedAt ?? task.updatedAt,
      createdAtMs: task.endedAtMs ?? task.updatedAtMs,
      sender: "agent",
      contextRole: "agent",
      order: 4,
    });
  }

  return orderAgentChatEntries(entries);
}
