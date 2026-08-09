import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  TASK_BOARD_API_VERSION,
  type ClaimRunResult,
  type ConfirmPlanRevisionRequest,
  type CreatePlanRevisionRequest,
  type CreateProjectArtifactRequest,
  type CreateProjectRequest,
  type Project,
  type ProjectArtifact,
  type ProjectEvent,
  type SettleRunRequest,
  type WorkNode,
} from "#shared/task-board-contract";
import { ArtifactStore } from "../persistence/artifacts.js";
import { projectFromRow, type Row } from "../persistence/rows.js";
import { TransparentWorkflow, type ProjectWorkflowSnapshot } from "../persistence/workflow.js";
import { SkillRegistry } from "../skills.js";
import { exactNow } from "../persistence/timestamps.js";
import { RETIRED_WAKEUP_EVENT_PREFIX } from "../persistence/retired-wakeups.js";
import type { AutomationCollaborator } from "./automation.js";
import type { TaskBoardRuntime } from "./runtime.js";
import type { TasksCollaborator } from "./tasks.js";

const WORKFLOW_RECONCILIATION_BATCH_SIZE = 500;

export class ProjectsCollaborator {
  readonly #workflow: TransparentWorkflow;
  readonly #artifacts: ArtifactStore;

  constructor(
    private readonly runtime: TaskBoardRuntime,
    private readonly automation: AutomationCollaborator,
    private readonly tasks: TasksCollaborator,
  ) {
    this.#workflow = new TransparentWorkflow(
      runtime.store.db,
      new SkillRegistry(resolve("skills")),
      runtime.config.now,
      (operation) => runtime.store.transaction(operation),
      (event) => runtime.projectEvents.emit(event.projectId, event),
    );
    this.#artifacts = new ArtifactStore(runtime.store.db, runtime.config.artifactRoot, runtime.config.now);
  }

  listProjects(): readonly Project[] {
    return Object.freeze(this.runtime.store.db.prepare("SELECT * FROM projects ORDER BY created_at, project_id").all().map(projectFromRow));
  }

  proposeWorkflow(request: CreatePlanRevisionRequest): ProjectWorkflowSnapshot {
    return this.#workflow.propose(request, this.runtime.config.humanPrincipal);
  }

  proposeWorkflowForAgent(request: CreatePlanRevisionRequest, agentId: string): ProjectWorkflowSnapshot {
    return this.#workflow.propose(request, agentId);
  }

  proposeWorkflowForAgentInTransaction(request: CreatePlanRevisionRequest, agentId: string): ProjectWorkflowSnapshot {
    return this.#workflow.proposeInTransaction(request, agentId);
  }

  projectWorkflow(projectId: string): ProjectWorkflowSnapshot {
    this.runtime.requireProject(projectId);
    return this.#workflow.snapshot(projectId);
  }

  createArtifact(projectId: string, request: CreateProjectArtifactRequest): Promise<ProjectArtifact> {
    return this.#artifacts.create(projectId, request, this.runtime.config.humanPrincipal).then((artifact) => {
      this.#workflow.event(projectId, artifact.nodeId, artifact.taskId, "artifact_created", artifact.caption);
      return artifact;
    });
  }

  listArtifacts(projectId: string): readonly ProjectArtifact[] {
    this.runtime.requireProject(projectId);
    return this.#artifacts.list(projectId);
  }

  artifactContent(artifactId: string): Promise<{ artifact: ProjectArtifact; bytes: Buffer }> {
    return this.#artifacts.content(artifactId);
  }

  listProjectEvents(projectId: string, after = 0): readonly ProjectEvent[] {
    this.runtime.requireProject(projectId);
    return Object.freeze((this.runtime.store.db.prepare(
      "SELECT * FROM project_events WHERE project_id=? AND sequence>? ORDER BY sequence LIMIT 500",
    ).all(projectId, after) as Row[]).map((row) => Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      sequence: Number(row.sequence),
      eventId: String(row.event_id),
      projectId: String(row.project_id),
      nodeId: row.node_id === null ? null : String(row.node_id),
      taskId: row.task_id === null ? null : String(row.task_id),
      eventType: String(row.event_type),
      summary: String(row.summary),
      createdAt: String(row.created_at),
    })));
  }

  subscribeProjectEvents(projectId: string, listener: (event: ProjectEvent) => void): () => void {
    this.runtime.requireProject(projectId);
    this.runtime.projectEvents.on(projectId, listener);
    return () => this.runtime.projectEvents.off(projectId, listener);
  }

  confirmWorkflow(planRevisionId: string, request: ConfirmPlanRevisionRequest): ProjectWorkflowSnapshot {
    const ready = this.#workflow.confirm(planRevisionId, request, this.runtime.config.humanPrincipal);
    for (const node of ready) this.activateWorkflowNode(node);
    const projectId = ready[0]?.projectId
      ?? String(this.runtime.store.db.prepare("SELECT project_id FROM plan_revisions WHERE plan_revision_id=?").get(planRevisionId)?.project_id);
    this.reconcileWorkflowsBestEffort(projectId);
    return this.#workflow.snapshot(projectId);
  }

  createProject(request: CreateProjectRequest): Project {
    const now = exactNow(this.runtime.config.now);
    const projectId = randomUUID();
    this.runtime.store.transaction(() => {
      this.runtime.store.db.prepare(`
        INSERT INTO projects(project_id, name, description, version, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(projectId, request.name, request.description, now, now);
      this.runtime.insertEvent(projectId, null, { type: "human", id: this.runtime.config.humanPrincipal }, "project_created", {
        name: request.name,
      }, now);
    });
    return this.runtime.requireProject(projectId);
  }

  claimContext(taskId: string): ClaimRunResult["context"]["workflow"] {
    return this.#workflow.claimContext(taskId);
  }

  settleAttempt(taskId: string, outcome: SettleRunRequest["outcome"], result: string, handoff: SettleRunRequest["handoff"]): void {
    this.activateWorkflowNodes(this.#workflow.settleAttempt(taskId, outcome, result, handoff));
  }

  settleAttemptInTransaction(
    taskId: string,
    outcome: SettleRunRequest["outcome"],
    result: string,
    handoff: SettleRunRequest["handoff"],
  ): readonly WorkNode[] {
    return this.#workflow.settleAttemptInTransaction(taskId, outcome, result, handoff);
  }

  attemptNeedsSettlementRepair(taskId: string, settledRunId: string): boolean {
    return this.#workflow.attemptNeedsSettlementRepair(taskId, settledRunId);
  }

  activateWorkflowNodes(nodes: readonly WorkNode[]): void {
    for (const node of nodes) this.activateWorkflowNode(node);
  }

  reconcileWorkflows(projectId?: string): void {
    if (projectId !== undefined) this.runtime.requireProject(projectId);
    if (this.runtime.store.db.prepare(
      projectId === undefined
        ? "SELECT 1 FROM work_nodes LIMIT 1"
        : "SELECT 1 FROM work_nodes WHERE project_id=? LIMIT 1",
    ).get(...(projectId === undefined ? [] : [projectId])) === undefined) return;
    const projectFilter = projectId === undefined ? "" : "AND node.project_id=?";
    const rows = this.runtime.store.db.prepare(`
      SELECT node.node_id
      FROM work_nodes node
      JOIN plan_revisions plan ON plan.plan_revision_id=node.plan_revision_id
      WHERE plan.state='confirmed'
        ${projectFilter}
        AND node.current_stage IS NOT NULL
        AND (
          (
            node.state='ready'
            AND NOT EXISTS(
              SELECT 1
              FROM stage_attempts attempt
              JOIN tasks task ON task.task_id=attempt.task_id
              WHERE attempt.node_id=node.node_id
                AND attempt.stage=node.current_stage
                AND task.ended_at IS NULL
                AND task.status IN ('queued','in_progress','blocked')
            )
          )
          OR (
            node.state='blocked'
            AND (
              SELECT event.event_type
              FROM project_events event
              WHERE event.node_id=node.node_id
                AND event.event_type IN (
                  'node_blocked','stage_started','stage_retry_ready','stage_completed','stage_failed','node_completed'
                )
              ORDER BY event.sequence DESC
              LIMIT 1
            )='node_blocked'
          )
        )
      ORDER BY node.created_at,node.node_id
    `).all(...(projectId === undefined ? [] : [projectId])) as Row[];
    const candidateIds = rows.map((row) => String(row.node_id));
    for (let offset = 0; offset < candidateIds.length; offset += WORKFLOW_RECONCILIATION_BATCH_SIZE) {
      const batch = candidateIds.slice(offset, offset + WORKFLOW_RECONCILIATION_BATCH_SIZE);
      let nodesById: ReadonlyMap<string, WorkNode>;
      try {
        nodesById = new Map(this.#workflow.nodesForIds(batch).map((node) => [node.nodeId, node]));
      } catch {
        for (const nodeId of batch) this.reconcileWorkflowCandidate(nodeId);
        continue;
      }
      for (const nodeId of batch) this.reconcileWorkflowCandidate(nodeId, nodesById.get(nodeId));
    }
  }

  reconcileWorkflowsBestEffort(projectId?: string): void {
    try {
      this.reconcileWorkflows(projectId);
    } catch (error) {
      const scope = projectId === undefined ? "at startup" : `for project ${projectId}`;
      console.error(`[task-board] workflow reconciliation failed ${scope}`, error);
    }
  }

  private reconcileWorkflowCandidate(nodeId: string, candidate?: WorkNode): void {
    try {
      const node = candidate ?? this.#workflow.nodesForIds([nodeId])[0];
      if (node !== undefined) this.activateWorkflowNode(node);
    } catch (error) {
      console.error(`[task-board] workflow reconciliation failed for node ${nodeId}`, error);
    }
  }

  private activateWorkflowNode(node: WorkNode): void {
    let wakeAgentId: string | null = null;
    this.runtime.store.transaction(() => {
      const current = this.#workflow.nodesForIds([node.nodeId])[0];
      if (current === undefined || !["ready", "blocked"].includes(current.state)) return;
      if (current.state === "blocked") {
        const latestLifecycleEvent = this.runtime.store.db.prepare(`
          SELECT event.event_type
          FROM project_events event
          WHERE event.node_id=?
            AND event.event_type IN (
              'node_blocked','stage_started','stage_retry_ready','stage_completed','stage_failed','node_completed'
            )
          ORDER BY event.sequence DESC
          LIMIT 1
        `).get(current.nodeId);
        if (latestLifecycleEvent?.event_type !== "node_blocked") return;
      }
      const stage = current.currentStage;
      if (stage === null) return;
      const configuration = this.automation.getConfiguration();
      const configuredExecutor = configuration.stages.find((item) => item.stage === stage)?.executor;
      if (configuredExecutor?.kind !== "agent_type") {
        this.#workflow.blockNodeInTransaction(
          current.nodeId,
          `${current.title} has no configured ${stage} executor`,
        );
        return;
      }
      const agentType = configuration.agentTypes.find((item) =>
        item.agentTypeId === configuredExecutor.agentTypeId && item.enabled);
      if (!agentType) {
        this.#workflow.blockNodeInTransaction(current.nodeId, `${current.title} executor is unavailable`);
        return;
      }
      const agent = this.runtime.store.db.prepare(
        "SELECT * FROM agents WHERE project_id=? AND role=? ORDER BY created_at,agent_id LIMIT 1",
      ).get(current.projectId, agentType.role);
      if (!agent) {
        this.#workflow.blockNodeInTransaction(current.nodeId, `${current.title} has no compatible agent`);
        return;
      }
      const title = `${stage}: ${current.title}`;
      const acceptanceCriteria = current.acceptanceCriteria.join("\n");
      const orphan = this.runtime.store.db.prepare(`
        SELECT task.*
        FROM tasks task
        JOIN agents assigned
          ON assigned.agent_id=task.assigned_agent_id
          AND assigned.project_id=task.project_id
          AND assigned.role=task.assigned_role
        WHERE task.project_id=?
          AND task.parent_task_id IS NULL
          AND task.task_kind='work'
          AND task.required_role IS NULL
          AND task.requires_review=0
          AND task.title=?
          AND task.objective=?
          AND task.acceptance_criteria=?
          AND task.workspace_refs_json='[]'
          AND task.assigned_role=?
          AND task.ended_at IS NULL
          AND task.status='queued'
          AND NOT EXISTS(SELECT 1 FROM stage_attempts attempt WHERE attempt.task_id=task.task_id)
          AND NOT EXISTS(SELECT 1 FROM work_item_planning_tasks planning WHERE planning.task_id=task.task_id)
          AND EXISTS(
            SELECT 1 FROM wakeups wakeup
            WHERE wakeup.task_id=task.task_id
              AND wakeup.project_id=task.project_id
              AND wakeup.agent_id=task.assigned_agent_id
              AND wakeup.claimed_at IS NULL
              AND NOT EXISTS(
                SELECT 1 FROM task_events event WHERE event.event_id=? || wakeup.wakeup_id
              )
          )
        ORDER BY task.order_key,task.task_id
        LIMIT 1
      `).get(
        current.projectId,
        title,
        current.objective,
        acceptanceCriteria,
        agentType.role,
        RETIRED_WAKEUP_EVENT_PREFIX,
      );
      const task = orphan === undefined
        ? this.tasks.createTaskInTransaction(current.projectId, {
            parentTaskId: null,
            title,
            objective: current.objective,
            acceptanceCriteria,
            workspaceRefs: [],
            assignedAgentId: String(agent.agent_id),
            assignedRole: agentType.role,
            requiresReview: false,
          })
        : this.runtime.requireTask(String(orphan.task_id));
      const plan = this.runtime.store.db.prepare(`
        SELECT plan.skill_digests_json
        FROM plan_revisions plan
        JOIN work_nodes planned_node ON planned_node.plan_revision_id=plan.plan_revision_id
        WHERE planned_node.node_id=?
      `).get(current.nodeId);
      const planDigests = JSON.parse(String(plan?.skill_digests_json ?? "{}")) as Record<string, string>;
      const stageDigests = Object.fromEntries(agentType.skillIds.flatMap((skillId) =>
        planDigests[skillId] === undefined ? [] : [[skillId, planDigests[skillId]]]));
      this.#workflow.linkAttemptInTransaction(current.nodeId, task.taskId, stage, stageDigests);
      this.#workflow.event(
        current.projectId,
        current.nodeId,
        task.taskId,
        "stage_started",
        `${current.title} entered ${stage}`,
      );
      if (orphan === undefined) wakeAgentId = String(agent.agent_id);
    });
    if (wakeAgentId !== null) this.runtime.wakeupEvents.emit(wakeAgentId);
  }
}
