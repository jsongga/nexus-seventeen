/** Provides task commands over a shared client context. */

import type { TaskBoardClient } from "../client";
import { integer } from "../parse/scalars";
import {
  agentQueryConversationContextMarker,
  agentQueryRoutingContextMarker,
  appendAgentQuerySection,
  maximumAgentQueryObjectiveCharacters,
  recentAgentQueryConversation,
} from "./agent-query";
import { post, type TaskBoardClientContext } from "./context";

/* —— Browser utilities —— */

export function randomUuid(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  // Older secure contexts may lack randomUUID; retain cryptographic IDs rather than falling back to Math.random.
  if (typeof source?.getRandomValues !== "function") {
    throw new Error("This browser cannot generate secure random identifiers");
  }
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function clientEventId(): string {
  return `ui-${randomUuid()}`;
}

function taskCommandVersion(value: unknown, path: string): number {
  const version = integer(value, path);
  if (version < 1) throw new Error(`${path} must be a positive safe integer`);
  return version;
}

/* —— Task methods —— */

export function createTaskMethods(
  context: TaskBoardClientContext
): Pick<
  TaskBoardClient,
  | "createTask"
  | "createAgentQuery"
  | "assignTask"
  | "retryTask"
  | "backlogTask"
  | "reorderTask"
  | "returnTaskToBacklog"
  | "addMessage"
  | "answerQuestion"
  | "resumeTask"
  | "decideHumanCheck"
> {
  const postRequest = (path: string, body: unknown, idempotencyKey?: string): Promise<void> =>
    post(context, path, body, idempotencyKey);

  return {
    async createTask(input) {
      const { projectId, ...task } = input;
      await postRequest(`/v1/projects/${encodeURIComponent(projectId)}/tasks`, {
        ...task,
        assignedAgentId: null,
        assignedRole: null,
      });
    },
    async createAgentQuery(input) {
      const prompt = input.prompt.trim();
      if (prompt.length === 0) throw new Error("Enter a question or request for this agent");
      if (prompt.length > maximumAgentQueryObjectiveCharacters)
        throw new Error("Agent questions and requests cannot exceed 8,000 characters");
      const recentConversation = recentAgentQueryConversation(input.recentConversation ?? [], prompt);
      const routingContext = input.routingContext?.trim();
      const objectiveWithConversation = appendAgentQuerySection(
        prompt,
        agentQueryConversationContextMarker,
        recentConversation
      );
      const objective = appendAgentQuerySection(
        objectiveWithConversation,
        agentQueryRoutingContextMarker,
        routingContext ?? ""
      );
      const workspaceRefs = [...new Set(input.workspaceRefs)].slice(0, 32);
      const titlePrefix = `Request for ${input.agentId}: `;
      const titleSummary = prompt.replace(/\s+/gu, " ");
      await postRequest(`/v1/projects/${encodeURIComponent(input.projectId)}/tasks`, {
        parentTaskId: null,
        title: `${titlePrefix}${titleSummary}`.slice(0, 240).trimEnd(),
        objective,
        acceptanceCriteria:
          "Return a concise answer or result. If more work is needed, propose child tasks for human approval; do not assign agents or deploy.",
        workspaceRefs,
        assignedAgentId: input.agentId,
        assignedRole: input.assignedRole,
        requiresReview: false,
      });
    },
    async assignTask(taskId, input) {
      const role = context.agentRoles.get(input.agentId);
      if (!role) throw new Error("Refresh the board before assigning this agent");
      const policy = context.taskPolicies.get(taskId);
      if (!policy) throw new Error("Refresh the board before assigning this task");
      if (policy.kind === "human_check") throw new Error("Human checks cannot be assigned to agents");
      if (policy.requiredRole !== null && role !== policy.requiredRole) {
        throw new Error(`This task requires a ${policy.requiredRole} agent`);
      }
      await context.request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          version: input.version,
          assignedAgentId: input.agentId,
          assignedRole: role,
          status: "queued",
        }),
      });
    },
    async retryTask(taskId, version) {
      await postRequest(`/v1/tasks/${encodeURIComponent(taskId)}/retry`, {
        version: taskCommandVersion(version, "task retry.version"),
      });
    },
    async backlogTask(taskId, version) {
      await postRequest(`/v1/tasks/${encodeURIComponent(taskId)}/backlog`, {
        version: taskCommandVersion(version, "task backlog.version"),
      });
    },
    async reorderTask(taskId, input) {
      if (!Number.isSafeInteger(input.orderKey) || input.orderKey < 0) {
        throw new Error("Task order must be a non-negative safe integer");
      }
      await context.request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: JSON.stringify({ version: input.version, orderKey: input.orderKey }),
      });
    },
    async returnTaskToBacklog(taskId, input) {
      await context.request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          version: input.version,
          assignedAgentId: null,
          assignedRole: null,
          status: "backlog",
        }),
      });
    },
    async addMessage(taskId, input) {
      void input.version;
      await postRequest(`/v1/tasks/${encodeURIComponent(taskId)}/messages`, {
        clientEventId: clientEventId(),
        kind: "note",
        body: input.body,
      });
    },
    async answerQuestion(questionId, input) {
      const version = context.questionVersions.get(questionId);
      if (!version) throw new Error("Refresh the board before answering this question");
      await postRequest(`/v1/questions/${encodeURIComponent(questionId)}/answer`, { answer: input.answer, version });
    },
    async resumeTask(taskId, input) {
      if (context.taskPolicies.get(taskId)?.kind === "human_check")
        throw new Error("Human checks cannot wake an agent");
      const agentId = context.taskAgents.get(taskId);
      if (!agentId) throw new Error("This task has no assigned agent to resume");
      await postRequest(
        `/v1/agents/${encodeURIComponent(agentId)}/resume`,
        { reason: "Human explicitly resumed this task", taskId },
        `resume:${taskId}:${input.version}`
      );
    },
    async decideHumanCheck(taskId, input) {
      if (context.taskPolicies.get(taskId)?.kind !== "human_check")
        throw new Error("Only human checks accept a human release decision");
      const result = input.result.trim();
      if (result.length === 0) throw new Error("A human decision rationale is required");
      await context.request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: JSON.stringify({ version: input.version, status: input.status, result }),
      });
    },
  };
}
