import type { AgentProfile, CreateAgentRequest } from "#shared/task-board-contract";
import { sha256 } from "../canonical.js";
import { conflict } from "../errors.js";
import { exactNow } from "../persistence/timestamps.js";
import type { TaskBoardRuntime } from "./runtime.js";
import type { ProjectsCollaborator } from "./projects.js";
import type { WorkItemsCollaborator } from "./work-items.js";

export class AgentsCollaborator {
  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly workItems: WorkItemsCollaborator,
    private readonly projects: ProjectsCollaborator,
  ) {}

  createAgent(projectId: string, request: CreateAgentRequest): AgentProfile {
    this.runtime.requireProject(projectId);
    const tokenHash = sha256(request.token);
    if (tokenHash === sha256(this.runtime.config.humanToken)) {
      throw conflict("TOKEN_REALM_CONFLICT", "Agent credential must be distinct from the human credential");
    }
    const now = exactNow(this.runtime.config.now);
    try {
      this.runtime.store.transaction(() => {
        this.runtime.store.db.prepare(`
          INSERT INTO agents(agent_id, project_id, role, area, mission, model, token_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          request.agentId,
          projectId,
          request.role,
          request.area,
          request.mission,
          request.model,
          tokenHash,
          now,
        );
        this.runtime.insertEvent(projectId, null, { type: "human", id: this.runtime.config.humanPrincipal }, "agent_profile_created", {
          agentId: request.agentId,
          role: request.role,
          area: request.area,
          model: request.model,
        }, now);
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

  setLaneError(agentId: string, detail: string | null): void {
    if (this.runtime.store.db.prepare("UPDATE agents SET last_error=? WHERE agent_id=?").run(detail, agentId).changes !== 1) {
      throw new Error("TASK_BOARD_DATABASE_CORRUPT:agent_lane_error");
    }
  }
}
