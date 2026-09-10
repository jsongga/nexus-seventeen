/** Defines the shared transport and cache state for one task-board client. */

import type { AgentRole, TaskKind } from "../../types";

/* —— Shared client state —— */

export interface TaskBoardClientContext {
  readonly request: (path: string, init?: RequestInit) => Promise<Response>;
  readonly agentRoles: Map<string, AgentRole>;
  readonly questionVersions: Map<string, number>;
  readonly taskAgents: Map<string, string>;
  readonly taskPolicies: Map<string, Readonly<{ kind: TaskKind; requiredRole: AgentRole | null }>>;
  readonly runAgents: Map<string, string>;
}

/* —— Transport helpers —— */

export async function requestJson(context: TaskBoardClientContext, path: string, init?: RequestInit): Promise<unknown> {
  return context.request(path, init).then((response) => response.json());
}

export async function post(
  context: TaskBoardClientContext,
  path: string,
  body: unknown,
  idempotencyKey?: string
): Promise<void> {
  await context.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined,
  });
}
