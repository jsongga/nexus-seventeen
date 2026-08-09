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
import type { AutomationCollaborator } from "./automation.js";
import type { TaskBoardRuntime } from "./runtime.js";
import type { TasksCollaborator } from "./tasks.js";

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
    return this.#workflow.snapshot(ready[0]?.projectId ?? String(this.runtime.store.db.prepare("SELECT project_id FROM plan_revisions WHERE plan_revision_id=?").get(planRevisionId)?.project_id));
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

  private activateWorkflowNode(node: WorkNode): void {
    const configuration = this.automation.getConfiguration();
    const stage = node.currentStage;
    if (stage === null) return;
    const configuredExecutor = configuration.stages.find((item) => item.stage === stage)?.executor;
    if (configuredExecutor?.kind !== "agent_type") {
      this.#workflow.event(node.projectId, node.nodeId, null, "node_blocked", `${node.title} has no configured ${stage} executor`);
      return;
    }
    const agentType = configuration.agentTypes.find((item) => item.agentTypeId === configuredExecutor.agentTypeId && item.enabled);
    if (!agentType) {
      this.#workflow.event(node.projectId, node.nodeId, null, "node_blocked", `${node.title} executor is unavailable`);
      return;
    }
    const agent = this.runtime.store.db.prepare("SELECT * FROM agents WHERE project_id=? AND role=? ORDER BY created_at,agent_id LIMIT 1").get(node.projectId, agentType.role);
    if (!agent) {
      this.#workflow.event(node.projectId, node.nodeId, null, "node_blocked", `${node.title} has no compatible agent`);
      return;
    }
    const task = this.tasks.createTask(node.projectId, {
      parentTaskId: null, title: `${stage}: ${node.title}`, objective: node.objective,
      acceptanceCriteria: node.acceptanceCriteria.join("\n"), workspaceRefs: [],
      assignedAgentId: String(agent.agent_id), assignedRole: agentType.role, requiresReview: false,
    });
    const plan = this.runtime.store.db.prepare("SELECT p.skill_digests_json FROM plan_revisions p JOIN work_nodes n ON n.plan_revision_id=p.plan_revision_id WHERE n.node_id=?").get(node.nodeId);
    const planDigests = JSON.parse(String(plan?.skill_digests_json ?? "{}")) as Record<string, string>;
    const stageDigests = Object.fromEntries(agentType.skillIds.flatMap((skillId) =>
      planDigests[skillId] === undefined ? [] : [[skillId, planDigests[skillId]]]));
    this.#workflow.linkAttempt(node.nodeId, task.taskId, stage, stageDigests);
    this.#workflow.event(node.projectId, node.nodeId, task.taskId, "stage_started", `${node.title} entered ${stage}`);
  }
}
