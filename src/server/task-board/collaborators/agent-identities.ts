/** Creates explicit or lazy agent identities with unique credentials inside their caller's board transaction. */

import { randomBytes } from "node:crypto";
import type { AgentProfile, AgentRole, AutomationAgentType } from "#shared/task-board-contract";
import { sha256 } from "../canonical.js";
import { conflict } from "../errors.js";
import { AGENT_REPOSITORY_ID_SQL } from "../persistence/repository-path.js";
import { exactNow } from "../persistence/timestamps.js";
import type { TaskBoardRuntime } from "./board-runtime.js";

const LAZY_IDENTITY_ACTOR = "system:lazy-agent-identity";

type IdentityActor = Readonly<{ type: "human" | "agent" | "system"; id: string }>;

interface AgentIdentityInput {
  readonly agentId: string;
  readonly role: AgentRole;
  readonly area: string;
  readonly mission: string;
  readonly model: string;
  readonly token: string;
  /** Omitted or null scopes the agent to its project's primary repository. */
  readonly repositoryId?: string | null;
}

export function generatedToken(runtime: TaskBoardRuntime): string {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256(token);
    if (
      tokenHash !== sha256(runtime.config.humanToken) &&
      runtime.store.db.prepare("SELECT 1 FROM agents WHERE token_hash=?").get(tokenHash) === undefined
    )
      return token;
  }
  throw new Error("TASK_BOARD_AGENT_TOKEN_GENERATION_FAILED");
}

function identitySlug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "project"
  );
}

function availableIdentityId(runtime: TaskBoardRuntime, projectName: string, role: AgentRole): string {
  const base = `${identitySlug(projectName).slice(0, 96)}-${role}`;
  if (runtime.store.db.prepare("SELECT 1 FROM agents WHERE agent_id=?").get(base) === undefined) return base;
  let suffix = 2;
  while (runtime.store.db.prepare("SELECT 1 FROM agents WHERE agent_id=?").get(`${base}-${suffix}`) !== undefined)
    suffix += 1;
  return `${base}-${suffix}`;
}

export function insertAgentIdentityInTransaction(
  runtime: TaskBoardRuntime,
  projectId: string,
  input: AgentIdentityInput,
  actor: IdentityActor
): AgentProfile {
  const now = exactNow(runtime.config.now);
  const repositoryId = input.repositoryId ?? null;
  // An agent scoped to a repository its project does not own could never reach that checkout.
  if (
    repositoryId !== null &&
    runtime.store.db
      .prepare("SELECT 1 FROM repositories WHERE repository_id=? AND project_id=?")
      .get(repositoryId, projectId) === undefined
  ) {
    throw conflict("AGENT_REPOSITORY_PROJECT_MISMATCH", "Repository belongs to another project");
  }
  runtime.store.db
    .prepare(
      `
    INSERT INTO agents(
      agent_id, project_id, repository_id, role, area, mission, model, token_hash, last_error, version, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)
  `
    )
    .run(
      input.agentId,
      projectId,
      repositoryId,
      input.role,
      input.area,
      input.mission,
      input.model,
      sha256(input.token),
      now
    );
  runtime.insertEvent(
    projectId,
    null,
    actor,
    "agent_profile_created",
    {
      agentId: input.agentId,
      repositoryId,
      role: input.role,
      area: input.area,
      model: input.model,
    },
    now
  );
  return runtime.requireAgent(input.agentId);
}

export function createLazyManagerInTransaction(
  runtime: TaskBoardRuntime,
  projectId: string,
  repositoryId: string | null = null
): AgentProfile {
  // A manager plans against a checkout, so it must be the checkout the work targets. Null on
  // either side resolves to the project's primary, which is what a single-repository project has
  // always meant.
  const existing = runtime.store.db
    .prepare(
      `
      SELECT *
      FROM agents agent
      WHERE project_id=? AND role='manager'
        AND (? IS NULL OR ${AGENT_REPOSITORY_ID_SQL} = ?)
      ORDER BY created_at,agent_id
      LIMIT 1
    `
    )
    .get(projectId, repositoryId, repositoryId);
  if (existing !== undefined) return runtime.agentFromRow(existing);
  const project = runtime.requireProject(projectId);
  return insertAgentIdentityInTransaction(
    runtime,
    projectId,
    {
      agentId: availableIdentityId(runtime, project.name, "manager"),
      role: "manager",
      area: project.name,
      mission: `Refine incoming ${project.name} work, plan durable workflows, and prepare completed work for human review.`,
      model: "auto",
      token: generatedToken(runtime),
      repositoryId,
    },
    { type: "system", id: LAZY_IDENTITY_ACTOR }
  );
}

export function createLazyExecutorInTransaction(
  runtime: TaskBoardRuntime,
  projectId: string,
  agentType: AutomationAgentType,
  repositoryId: string | null = null
): AgentProfile {
  const project = runtime.requireProject(projectId);
  const mission = [agentType.description, agentType.supplementalInstructions].filter(Boolean).join(" ").slice(0, 4_000);
  return insertAgentIdentityInTransaction(
    runtime,
    projectId,
    {
      agentId: availableIdentityId(runtime, project.name, agentType.role),
      role: agentType.role,
      area: `${project.name}: ${agentType.name}`.slice(0, 256),
      mission,
      model: "auto",
      token: generatedToken(runtime),
      repositoryId,
    },
    { type: "system", id: LAZY_IDENTITY_ACTOR }
  );
}
