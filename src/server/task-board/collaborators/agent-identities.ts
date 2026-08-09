import { randomBytes } from "node:crypto";
import type { AgentProfile, AgentRole, AutomationAgentType } from "#shared/task-board-contract";
import { sha256 } from "../canonical.js";
import { exactNow } from "../persistence/timestamps.js";
import type { TaskBoardRuntime } from "./runtime.js";

const LAZY_IDENTITY_ACTOR = "system:lazy-agent-identity";

type IdentityActor = Readonly<{ type: "human" | "agent" | "system"; id: string }>;

export interface AgentIdentityInput {
  readonly agentId: string;
  readonly role: AgentRole;
  readonly area: string;
  readonly mission: string;
  readonly model: string;
  readonly token: string;
}

export function generatedToken(runtime: TaskBoardRuntime): string {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256(token);
    if (
      tokenHash !== sha256(runtime.config.humanToken)
      && runtime.store.db.prepare("SELECT 1 FROM agents WHERE token_hash=?").get(tokenHash) === undefined
    ) return token;
  }
  throw new Error("TASK_BOARD_AGENT_TOKEN_GENERATION_FAILED");
}

function identitySlug(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "project";
}

function availableIdentityId(runtime: TaskBoardRuntime, projectName: string, role: AgentRole): string {
  const base = `${identitySlug(projectName).slice(0, 96)}-${role}`;
  if (runtime.store.db.prepare("SELECT 1 FROM agents WHERE agent_id=?").get(base) === undefined) return base;
  let suffix = 2;
  while (runtime.store.db.prepare("SELECT 1 FROM agents WHERE agent_id=?").get(`${base}-${suffix}`) !== undefined) suffix += 1;
  return `${base}-${suffix}`;
}

export function insertAgentIdentityInTransaction(
  runtime: TaskBoardRuntime,
  projectId: string,
  input: AgentIdentityInput,
  actor: IdentityActor,
): AgentProfile {
  const now = exactNow(runtime.config.now);
  runtime.store.db.prepare(`
    INSERT INTO agents(agent_id, project_id, role, area, mission, model, token_hash, last_error, version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)
  `).run(
    input.agentId,
    projectId,
    input.role,
    input.area,
    input.mission,
    input.model,
    sha256(input.token),
    now,
  );
  runtime.insertEvent(projectId, null, actor, "agent_profile_created", {
    agentId: input.agentId,
    role: input.role,
    area: input.area,
    model: input.model,
  }, now);
  return runtime.requireAgent(input.agentId);
}

export function createLazyManagerInTransaction(runtime: TaskBoardRuntime, projectId: string): AgentProfile | null {
  const existing = runtime.store.db.prepare(
    "SELECT * FROM agents WHERE project_id=? AND role='manager' ORDER BY created_at,agent_id",
  ).all(projectId);
  if (existing.length > 0) return existing.length === 1 ? runtime.agentFromRow(existing[0]!) : null;
  const project = runtime.requireProject(projectId);
  return insertAgentIdentityInTransaction(runtime, projectId, {
    agentId: availableIdentityId(runtime, project.name, "manager"),
    role: "manager",
    area: project.name,
    mission: `Refine incoming ${project.name} work, plan durable workflows, and prepare completed work for human review.`,
    model: "auto",
    token: generatedToken(runtime),
  }, { type: "system", id: LAZY_IDENTITY_ACTOR });
}

export function createLazyExecutorInTransaction(
  runtime: TaskBoardRuntime,
  projectId: string,
  agentType: AutomationAgentType,
): AgentProfile {
  const project = runtime.requireProject(projectId);
  const mission = [agentType.description, agentType.supplementalInstructions].filter(Boolean).join(" ").slice(0, 4_000);
  return insertAgentIdentityInTransaction(runtime, projectId, {
    agentId: availableIdentityId(runtime, project.name, agentType.role),
    role: agentType.role,
    area: `${project.name}: ${agentType.name}`.slice(0, 256),
    mission,
    model: "auto",
    token: generatedToken(runtime),
  }, { type: "system", id: LAZY_IDENTITY_ACTOR });
}
