import { TASK_BOARD_ERROR_CODES, type AgentProfile, type CreateAgentRequest, type RotateAgentTokenResponse } from "#shared/task-board-contract";
import { sha256 } from "../canonical.js";
import { conflict } from "../errors.js";
import { exactNow } from "../persistence/timestamps.js";
import type { TaskBoardRuntime } from "./runtime.js";
import type { ProjectsCollaborator } from "./projects.js";
import type { RunsCollaborator } from "./runs.js";
import type { WorkItemsCollaborator } from "./work-items.js";
import { generatedToken, insertAgentIdentityInTransaction } from "./agent-identities.js";

export class AgentsCollaborator {
  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly workItems: WorkItemsCollaborator,
    private readonly projects: ProjectsCollaborator,
    private readonly runs: RunsCollaborator,
  ) {}

  createAgent(projectId: string, request: CreateAgentRequest): AgentProfile {
    this.runtime.requireProject(projectId);
    const tokenHash = sha256(request.token);
    if (tokenHash === sha256(this.runtime.config.humanToken)) {
      throw conflict("TOKEN_REALM_CONFLICT", "Agent credential must be distinct from the human credential");
    }
    try {
      this.runtime.store.transaction(() => {
        insertAgentIdentityInTransaction(
          this.runtime,
          projectId,
          request,
          { type: "human", id: this.runtime.config.humanPrincipal },
        );
      });
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        throw conflict("AGENT_ALREADY_EXISTS", "Agent id or credential is already registered");
      }
      throw error;
    }
    const created = this.runtime.requireAgent(request.agentId);
    if (created.role === "manager") {
      const pending = this.runtime.store.db.prepare(
        "SELECT work_item_id FROM work_items WHERE resolved_project_id=? AND state='submitted' AND ended_at IS NULL ORDER BY created_at,work_item_id",
      ).all(projectId);
      for (const row of pending) this.workItems.startWorkItemPlanning(String(row.work_item_id));
    }
    this.projects.reconcileWorkflowsBestEffort(projectId);
    return created;
  }

  rotateToken(agentId: string, version: number): RotateAgentTokenResponse {
    return this.runtime.store.transaction(() => {
      const current = this.runtime.requireAgent(agentId);
      if (current.version !== version) {
        throw conflict(TASK_BOARD_ERROR_CODES.AGENT_VERSION_CONFLICT, "Agent credential version changed");
      }
      this.runs.interruptActiveRunForTokenRotationInTransaction(agentId, version);
      const token = generatedToken(this.runtime);
      const tokenHash = sha256(token);
      const update = this.runtime.store.db.prepare(`
        UPDATE agents SET token_hash=?,version=version+1 WHERE agent_id=? AND version=?
      `).run(tokenHash, agentId, version);
      if (Number(update.changes) !== 1) {
        throw conflict(TASK_BOARD_ERROR_CODES.AGENT_VERSION_CONFLICT, "Agent credential version changed");
      }
      const now = exactNow(this.runtime.config.now);
      this.runtime.insertEvent(current.projectId, null, { type: "human", id: this.runtime.config.humanPrincipal }, "agent_token_rotated", {
        agentId,
        previousVersion: version,
        version: version + 1,
      }, now);
      return Object.freeze({ agent: this.runtime.requireAgent(agentId), token });
    });
  }

  setLaneError(agentId: string, detail: string | null): void {
    if (this.runtime.store.db.prepare("UPDATE agents SET last_error=? WHERE agent_id=?").run(detail, agentId).changes !== 1) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:agent_lane_error");
    }
  }
}
