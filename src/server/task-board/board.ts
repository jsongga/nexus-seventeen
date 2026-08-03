import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import {
  TASK_BOARD_API_VERSION,
  WORK_ITEM_PAGE_SIZE,
  type AutomationConfiguration,
  type AgentInterrupt,
  type AgentProfile,
  type AgentRole,
  type AgentRun,
  type AnswerHumanQuestionRequest,
  type BoardSnapshot,
  type BoardTask,
  type ClaimRunRequest,
  type ClaimRunResult,
  type CreateAgentRequest,
  type CreateDocumentRequest,
  type CreateHumanQuestionRequest,
  type CreateHumanTaskMessageRequest,
  type CreateProjectRequest,
  type CreateTaskMessageRequest,
  type CreateTaskPhaseRequest,
  type CreateTaskRequest,
  type CreateWorkItemRequest,
  type CreatePlanRevisionRequest,
  type CreateProjectArtifactRequest,
  type ConfirmPlanRevisionRequest,
  type HumanQuestion,
  type InterruptAgentRequest,
  type DocumentEvent,
  type DocumentSnapshot,
  type DocumentSummary,
  type Project,
  type ProjectArtifact,
  type ProjectEvent,
  type ResumeAgentRequest,
  type RunInterruptBatch,
  type SettleRunRequest,
  type TaskKind,
  type TaskMessage,
  type TaskPhase,
  type TaskPhaseStatus,
  type TaskStatus,
  type UpdateTaskRequest,
  type UpdateTaskPhaseRequest,
  type UpdateWorkItemRequest,
  type UpdateDocumentPenRequest,
  type UpdateDocumentRequest,
  type UpdateAutomationConfigurationRequest,
  type Wakeup,
  type WorkItem,
  type WorkItemPage,
  type WorkerConnection,
} from "#shared/task-board-contract";
import { canonicalJson, sha256, tokenMatches } from "./canonical.js";
import type { TaskBoardConfig } from "./config.js";
import { conflict, TaskBoardError } from "./errors.js";
import { parseUpdateAutomationConfiguration } from "./schema.js";
import { TaskBoardStore } from "./persistence/store.js";
import { SkillRegistry } from "./skills.js";
import { ArtifactStore } from "./persistence/artifacts.js";
import { RETIRED_WAKEUP_EVENT_PREFIX, retiredWakeupEventId } from "./persistence/retired-wakeups.js";
import {
  claimMessageCursor,
  claimRequestHash,
  legacyClaimRequestHash,
} from "./persistence/run-claims.js";
import {
  automationConfigurationFromRow,
  documentEventFromRow,
  documentFromRow,
  documentSummaryFromRow,
  eventFromRow,
  interruptFromRow,
  messageFromRow,
  nullableString,
  numberValue,
  phaseFromRow,
  projectFromRow,
  questionFromRow,
  runFromRow,
  stringValue,
  taskFromRow,
  wakeupFromRow,
  workItemFromRow,
  type Row,
} from "./persistence/rows.js";
import { TransparentWorkflow, type ProjectWorkflowSnapshot } from "./persistence/workflow.js";
import { decodeWorkItemCursor, encodeWorkItemCursor } from "./persistence/work-item-cursor.js";
import { exactNow } from "./timestamps.js";

type Actor = Readonly<{ type: "human" | "agent"; id: string }>;
type DocumentEventType = DocumentEvent["eventType"];
type ActiveWorkerConnection = Exclude<WorkerConnection, null>;
type WorkerConnectionCounts = { waitingForWake: number; watchingRun: number };
type ReviewFollowupResult = Readonly<{ taskId: string; wakeAgentId: string | null }>;
type CreateWorkItemResult = Readonly<{ workItem: WorkItem; duplicate: boolean }>;
const REVIEW_WORKFLOW_ACTOR = "system:steward-review-workflow";
const WORK_ITEM_TERMINAL_RANK_SQL = "(ended_at IS NOT NULL)";
const WORK_ITEM_PRIORITY_RANK_SQL = `CASE priority
  WHEN 'urgent' THEN 0
  WHEN 'high' THEN 1
  WHEN 'normal' THEN 2
  WHEN 'low' THEN 3
  WHEN 'opportunistic' THEN 4
END`;

export class TaskBoard {
  readonly #config: TaskBoardConfig;
  readonly #store: TaskBoardStore;
  readonly #interruptEvents = new EventEmitter();
  readonly #wakeupEvents = new EventEmitter();
  readonly #documentEvents = new EventEmitter();
  readonly #projectEvents = new EventEmitter();
  readonly #workerConnections = new Map<string, WorkerConnectionCounts>();
  readonly #workflow: TransparentWorkflow;
  readonly #artifacts: ArtifactStore;

  private constructor(config: TaskBoardConfig, store: TaskBoardStore) {
    this.#config = config;
    this.#store = store;
    this.#workflow = new TransparentWorkflow(
      store.db,
      new SkillRegistry(resolve("skills")),
      config.now,
      (operation) => store.transaction(operation),
      (event) => this.#projectEvents.emit(event.projectId, event),
    );
    this.#artifacts = new ArtifactStore(store.db, config.artifactRoot, config.now);
    this.#interruptEvents.setMaxListeners(512);
    this.#wakeupEvents.setMaxListeners(512);
    this.#documentEvents.setMaxListeners(512);
    this.#projectEvents.setMaxListeners(512);
  }

  static async open(config: TaskBoardConfig): Promise<TaskBoard> {
    return new TaskBoard(config, await TaskBoardStore.open(config.dbPath));
  }

  authenticateAgent(token: string | undefined, expectedAgentId?: string): AgentProfile {
    if (token === undefined) throw new TaskBoardError(401, "UNAUTHORIZED", "Agent authentication is required");
    const rows = expectedAgentId === undefined
      ? this.#store.db.prepare("SELECT * FROM agents").all()
      : this.#store.db.prepare("SELECT * FROM agents WHERE agent_id = ?").all(expectedAgentId);
    const row = rows.find((candidate) => tokenMatches(stringValue(candidate, "token_hash"), token));
    if (!row) throw new TaskBoardError(401, "UNAUTHORIZED", "Agent authentication is required");
    return this.#agentFromRow(row);
  }

  listProjects(): readonly Project[] {
    return Object.freeze(this.#store.db.prepare("SELECT * FROM projects ORDER BY created_at, project_id").all().map(projectFromRow));
  }

  proposeWorkflow(request: CreatePlanRevisionRequest): ProjectWorkflowSnapshot {
    return this.#workflow.propose(request, this.#config.humanPrincipal);
  }

  projectWorkflow(projectId: string): ProjectWorkflowSnapshot {
    this.#requireProject(projectId);
    return this.#workflow.snapshot(projectId);
  }

  createArtifact(projectId: string, request: CreateProjectArtifactRequest): Promise<ProjectArtifact> {
    return this.#artifacts.create(projectId, request, this.#config.humanPrincipal).then((artifact) => {
      this.#workflow.event(projectId, artifact.nodeId, artifact.taskId, "artifact_created", artifact.caption);
      return artifact;
    });
  }

  listArtifacts(projectId: string): readonly ProjectArtifact[] {
    this.#requireProject(projectId);
    return this.#artifacts.list(projectId);
  }

  artifactContent(artifactId: string): Promise<{ artifact: ProjectArtifact; bytes: Buffer }> {
    return this.#artifacts.content(artifactId);
  }

  listProjectEvents(projectId: string, after = 0): readonly ProjectEvent[] {
    this.#requireProject(projectId);
    return Object.freeze((this.#store.db.prepare(
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
    this.#requireProject(projectId);
    this.#projectEvents.on(projectId, listener);
    return () => this.#projectEvents.off(projectId, listener);
  }

  confirmWorkflow(planRevisionId: string, request: ConfirmPlanRevisionRequest): ProjectWorkflowSnapshot {
    const ready = this.#workflow.confirm(planRevisionId, request, this.#config.humanPrincipal);
    for (const node of ready) this.#activateWorkflowNode(node);
    return this.#workflow.snapshot(ready[0]?.projectId ?? String(this.#store.db.prepare("SELECT project_id FROM plan_revisions WHERE plan_revision_id=?").get(planRevisionId)?.project_id));
  }

  #activateWorkflowNode(node: import("#shared/task-board-contract").WorkNode): void {
    const configuration = this.getAutomationConfiguration();
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
    const agent = this.#store.db.prepare("SELECT * FROM agents WHERE project_id=? AND role=? ORDER BY created_at,agent_id LIMIT 1").get(node.projectId, agentType.role);
    if (!agent) {
      this.#workflow.event(node.projectId, node.nodeId, null, "node_blocked", `${node.title} has no compatible agent`);
      return;
    }
    const task = this.createTask(node.projectId, {
      parentTaskId: null, title: `${stage}: ${node.title}`, objective: node.objective,
      acceptanceCriteria: node.acceptanceCriteria.join("\n"), workspaceRefs: [],
      assignedAgentId: String(agent.agent_id), assignedRole: agentType.role, requiresReview: false,
    });
    const plan = this.#store.db.prepare("SELECT p.skill_digests_json FROM plan_revisions p JOIN work_nodes n ON n.plan_revision_id=p.plan_revision_id WHERE n.node_id=?").get(node.nodeId);
    const planDigests = JSON.parse(String(plan?.skill_digests_json ?? "{}")) as Record<string, string>;
    const stageDigests = Object.fromEntries(agentType.skillIds.flatMap((skillId) =>
      planDigests[skillId] === undefined ? [] : [[skillId, planDigests[skillId]]]));
    this.#workflow.linkAttempt(node.nodeId, task.taskId, stage, stageDigests);
    this.#workflow.event(node.projectId, node.nodeId, task.taskId, "stage_started", `${node.title} entered ${stage}`);
  }

  getAutomationConfiguration(): AutomationConfiguration {
    const row = this.#store.db.prepare(`
      SELECT * FROM automation_configuration WHERE configuration_id = 'company-default'
    `).get();
    if (!row) throw new Error("TASK_BOARD_DATABASE_CORRUPT:automation_configuration_missing");
    return automationConfigurationFromRow(row);
  }

  updateAutomationConfiguration(request: UpdateAutomationConfigurationRequest): AutomationConfiguration {
    const normalized = parseUpdateAutomationConfiguration(request);
    return this.#store.transaction(() => {
      const current = this.getAutomationConfiguration();
      if (current.version !== normalized.version) {
        throw conflict("AUTOMATION_CONFIGURATION_VERSION_CONFLICT", "Automation configuration version changed");
      }
      const nextTypes = new Map(normalized.agentTypes.map((agentType) => [agentType.agentTypeId, agentType] as const));
      for (const existing of current.agentTypes) {
        const replacement = nextTypes.get(existing.agentTypeId);
        if (replacement === undefined) {
          throw conflict(
            "AUTOMATION_AGENT_TYPE_REMOVAL_FORBIDDEN",
            "Existing agent types must be retained and may be disabled instead of removed",
          );
        }
        if (replacement.role !== existing.role) {
          throw conflict(
            "AUTOMATION_AGENT_TYPE_ROLE_IMMUTABLE",
            "An existing agent type's authority role cannot change",
          );
        }
      }
      const now = exactNow(this.#config.now);
      const update = this.#store.db.prepare(`
        UPDATE automation_configuration
        SET agent_types_json = ?, stages_json = ?, version = version + 1, updated_at = ?, updated_by = ?
        WHERE configuration_id = 'company-default' AND version = ?
      `).run(
        canonicalJson(normalized.agentTypes),
        canonicalJson(normalized.stages),
        now,
        this.#config.humanPrincipal,
        current.version,
      );
      if (Number(update.changes) !== 1) {
        throw conflict("AUTOMATION_CONFIGURATION_VERSION_CONFLICT", "Automation configuration version changed");
      }
      return this.getAutomationConfiguration();
    });
  }

  listWorkItemsPage(cursor?: string): WorkItemPage {
    const tuple = cursor === undefined ? null : decodeWorkItemCursor(cursor);
    const select = `
      SELECT *,
        ${WORK_ITEM_TERMINAL_RANK_SQL} AS work_item_terminal_rank,
        ${WORK_ITEM_PRIORITY_RANK_SQL} AS work_item_priority_rank
      FROM work_items
    `;
    const orderAndLimit = `
      ORDER BY
        ${WORK_ITEM_TERMINAL_RANK_SQL},
        ${WORK_ITEM_PRIORITY_RANK_SQL},
        created_at,
        work_item_id
      LIMIT ${WORK_ITEM_PAGE_SIZE + 1}
    `;
    const rows = tuple === null
      ? this.#store.db.prepare(`${select} ${orderAndLimit}`).all()
      : this.#store.db.prepare(`
          ${select}
          WHERE (
            ${WORK_ITEM_TERMINAL_RANK_SQL},
            ${WORK_ITEM_PRIORITY_RANK_SQL},
            created_at,
            work_item_id
          ) > (?, ?, ?, ?)
          ${orderAndLimit}
        `).all(tuple.terminalRank, tuple.priorityRank, tuple.createdAt, tuple.workItemId);
    const pageRows = rows.slice(0, WORK_ITEM_PAGE_SIZE);
    const workItems = Object.freeze(pageRows.map(workItemFromRow));
    if (rows.length <= WORK_ITEM_PAGE_SIZE) return Object.freeze({ workItems });
    const last = pageRows.at(-1);
    if (last === undefined) throw new Error("TASK_BOARD_DATABASE_CORRUPT:work_item_page");
    return Object.freeze({ workItems, nextCursor: encodeWorkItemCursor(last) });
  }

  listWorkItems(): readonly WorkItem[] {
    return this.listWorkItemsPage().workItems;
  }

  requireWorkItem(workItemId: string): WorkItem {
    return this.#requireWorkItem(workItemId);
  }

  createWorkItem(request: CreateWorkItemRequest, idempotencyKey: string): CreateWorkItemResult {
    const priority = request.priority ?? "normal";
    const projectTarget = request.projectTarget ?? Object.freeze({ mode: "auto" as const });
    if (projectTarget.mode === "explicit") this.#requireProject(projectTarget.projectId);
    const createdBy = this.#config.humanPrincipal;
    const requestHash = sha256({
      action: "create_work_item",
      createdBy,
      originalRequest: request.originalRequest,
      priority,
      projectTarget,
    });
    const workItemId = randomUUID();
    const targetProjectId = projectTarget.mode === "explicit" ? projectTarget.projectId : null;
    return this.#store.transaction(() => {
      const prior = this.#store.db.prepare(`
        SELECT * FROM work_items WHERE created_by = ? AND idempotency_key = ?
      `).get(createdBy, idempotencyKey);
      if (prior) {
        if (stringValue(prior, "request_hash") !== requestHash) {
          throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key was used for another work item");
        }
        return Object.freeze({ workItem: workItemFromRow(prior), duplicate: true });
      }
      const now = exactNow(this.#config.now);
      this.#store.db.prepare(`
        INSERT INTO work_items(
          work_item_id, original_request, refined_objective, priority,
          project_target_mode, target_project_id, resolved_project_id,
          state, current_stage, created_by, idempotency_key, request_hash,
          version, created_at, updated_at, ended_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'submitted', 'refinement', ?, ?, ?, 1, ?, ?, NULL)
      `).run(
        workItemId,
        request.originalRequest,
        priority,
        projectTarget.mode,
        targetProjectId,
        targetProjectId,
        createdBy,
        idempotencyKey,
        requestHash,
        now,
        now,
      );
      return Object.freeze({ workItem: this.#requireWorkItem(workItemId), duplicate: false });
    });
  }

  startWorkItemPlanning(workItemId: string): BoardTask | null {
    const workItem = this.#requireWorkItem(workItemId);
    if (workItem.resolvedProjectId === null || workItem.endedAt !== null) return null;
    const existing = this.#store.db.prepare("SELECT task_id FROM work_item_planning_tasks WHERE work_item_id=?").get(workItemId);
    if (existing) return this.#requireTask(String(existing.task_id));
    const managers = this.#store.db.prepare(
      "SELECT agent_id FROM agents WHERE project_id=? AND role='manager' ORDER BY created_at,agent_id",
    ).all(workItem.resolvedProjectId);
    if (managers.length !== 1) return null;
    const managerId = String(managers[0]!.agent_id);
    const configuration = this.getAutomationConfiguration();
    const enabledTypes = new Set(configuration.agentTypes.filter((agentType) => agentType.enabled).map((agentType) => agentType.agentTypeId));
    const availableStages = configuration.stages.flatMap((stage) =>
      stage.executor.kind === "agent_type" && enabledTypes.has(stage.executor.agentTypeId) ? [stage.stage] : []);
    const task = this.createTask(workItem.resolvedProjectId, {
      parentTaskId: null,
      title: `Plan workflow: ${workItem.originalRequest.slice(0, 160)}`,
      objective: workItem.originalRequest,
      acceptanceCriteria: `Return a concise workflowPlan with explicit acceptance criteria, acyclic dependencies, and unique stage sequences ending in verification. Available automated stages: ${availableStages.join(", ") || "none configured"}.`,
      workspaceRefs: [],
      assignedAgentId: managerId,
      assignedRole: "manager",
      requiresReview: false,
    });
    const now = exactNow(this.#config.now);
    this.#store.transaction(() => {
      this.#store.db.prepare("INSERT INTO work_item_planning_tasks VALUES(?,?,?)").run(workItemId, task.taskId, now);
      this.#store.db.prepare(
        "UPDATE work_items SET state='processing',current_stage='planning',version=version+1,updated_at=? WHERE work_item_id=? AND ended_at IS NULL",
      ).run(now, workItemId);
    });
    return task;
  }

  updateWorkItem(workItemId: string, request: UpdateWorkItemRequest): WorkItem {
    return this.#store.transaction(() => {
      if (request.priority === undefined && request.projectTarget === undefined) {
        throw new TaskBoardError(400, "INVALID_REQUEST", "Work item update contains no changes");
      }
      const current = this.#requireWorkItem(workItemId);
      if (current.version !== request.version) throw conflict("WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
      if (current.endedAt !== null) throw conflict("WORK_ITEM_TERMINAL", "Terminal work items are immutable");
      if (request.projectTarget !== undefined && current.state !== "submitted") {
        throw conflict("WORK_ITEM_TARGET_LOCKED", "Project target cannot change after intake begins processing");
      }
      const projectTarget = request.projectTarget ?? current.projectTarget;
      if (projectTarget.mode === "explicit") this.#requireProject(projectTarget.projectId);
      const targetProjectId = projectTarget.mode === "explicit" ? projectTarget.projectId : null;
      const resolvedProjectId = request.projectTarget === undefined
        ? current.resolvedProjectId
        : targetProjectId;
      const now = exactNow(this.#config.now);
      const nextVersion = current.version + 1;
      const update = this.#store.db.prepare(`
        UPDATE work_items SET
          priority = ?, project_target_mode = ?, target_project_id = ?, resolved_project_id = ?,
          version = ?, updated_at = ?
        WHERE work_item_id = ? AND version = ? AND ended_at IS NULL
      `).run(
        request.priority ?? current.priority,
        projectTarget.mode,
        targetProjectId,
        resolvedProjectId,
        nextVersion,
        now,
        workItemId,
        current.version,
      );
      if (Number(update.changes) !== 1) throw conflict("WORK_ITEM_VERSION_CONFLICT", "Work item version changed");
      return this.#requireWorkItem(workItemId);
    });
  }

  createProject(request: CreateProjectRequest): Project {
    const now = exactNow(this.#config.now);
    const projectId = randomUUID();
    this.#store.transaction(() => {
      this.#store.db.prepare(`
        INSERT INTO projects(project_id, name, description, version, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(projectId, request.name, request.description, now, now);
      this.#insertEvent(projectId, null, { type: "human", id: this.#config.humanPrincipal }, "project_created", {
        name: request.name,
      }, now);
    });
    return this.#requireProject(projectId);
  }

  createDocument(projectId: string, request: CreateDocumentRequest): DocumentSnapshot {
    this.#requireProject(projectId);
    const documentId = randomUUID();
    const now = exactNow(this.#config.now);
    const actor: Actor = { type: "human", id: this.#config.humanPrincipal };
    this.#store.transaction(() => {
      this.#store.db.prepare(`
        INSERT INTO documents(
          document_id, project_id, title, content_type, content, content_version,
          pen_epoch, pen_holder_actor_type, pen_holder_actor_id, pen_holder_client_id,
          pen_acquired_at, sequence, created_at, updated_at
        ) VALUES (?, ?, ?, 'text/markdown', ?, 1, 1, 'human', ?, ?, ?, 1, ?, ?)
      `).run(
        documentId,
        projectId,
        request.title,
        request.content,
        actor.id,
        request.clientId,
        now,
        now,
        now,
      );
      this.#insertDocumentEvent(this.#requireDocument(documentId), actor, request.clientId, "document_created", now);
    });
    return this.#requireDocument(documentId);
  }

  listDocuments(projectId: string): readonly DocumentSummary[] {
    this.#requireProject(projectId);
    return Object.freeze(this.#store.db.prepare(`
      SELECT * FROM documents WHERE project_id = ? ORDER BY updated_at DESC, document_id
    `).all(projectId).map(documentSummaryFromRow));
  }

  getDocument(documentId: string): DocumentSnapshot {
    return this.#requireDocument(documentId);
  }

  updateDocumentPen(documentId: string, request: UpdateDocumentPenRequest, actor: Actor): DocumentSnapshot {
    const current = this.#requireDocument(documentId);
    this.#assertDocumentActor(current, actor);
    if (request.force && actor.type !== "human") {
      throw new TaskBoardError(403, "DOCUMENT_FORCE_HUMAN_ONLY", "Only a human can force a pen takeover");
    }

    const sameHolder = current.penHolder?.actorType === actor.type
      && current.penHolder.actorId === actor.id
      && current.penHolder.clientId === request.clientId;
    if (
      request.action === "acquire" &&
      sameHolder &&
      (request.expectedPenEpoch === current.penEpoch || request.expectedPenEpoch === current.penEpoch - 1)
    ) return current;
    if (request.expectedPenEpoch !== current.penEpoch) {
      throw conflict("DOCUMENT_PEN_EPOCH_CONFLICT", "Document pen epoch changed");
    }
    if (request.action === "release" && current.penHolder === null) return current;
    if (request.action === "acquire" && current.penHolder !== null && !request.force) {
      throw conflict("DOCUMENT_PEN_HELD", "Document pen is held by another client");
    }
    if (request.action === "release" && !sameHolder) {
      throw new TaskBoardError(403, "DOCUMENT_PEN_NOT_HELD", "Only the current pen holder can release it");
    }
    if (request.action === "acquire" && current.penEpoch === Number.MAX_SAFE_INTEGER) {
      throw conflict("DOCUMENT_PEN_EPOCH_EXHAUSTED", "Document pen epoch is exhausted");
    }

    const now = exactNow(this.#config.now);
    const nextSequence = current.sequence + 1;
    const eventType: DocumentEventType = request.action === "acquire" ? "document_pen_acquired" : "document_pen_released";
    this.#store.transaction(() => {
      const update = request.action === "acquire"
        ? this.#store.db.prepare(`
            UPDATE documents
            SET pen_epoch = pen_epoch + 1, pen_holder_actor_type = ?, pen_holder_actor_id = ?,
                pen_holder_client_id = ?, pen_acquired_at = ?, sequence = sequence + 1, updated_at = ?
            WHERE document_id = ? AND pen_epoch = ? AND sequence = ?
          `).run(actor.type, actor.id, request.clientId, now, now, documentId, current.penEpoch, current.sequence)
        : this.#store.db.prepare(`
            UPDATE documents
            SET pen_holder_actor_type = NULL, pen_holder_actor_id = NULL, pen_holder_client_id = NULL,
                pen_acquired_at = NULL, sequence = sequence + 1, updated_at = ?
            WHERE document_id = ? AND pen_epoch = ? AND sequence = ?
              AND pen_holder_actor_type = ? AND pen_holder_actor_id = ? AND pen_holder_client_id = ?
          `).run(now, documentId, current.penEpoch, current.sequence, actor.type, actor.id, request.clientId);
      if (Number(update.changes) !== 1) throw conflict("DOCUMENT_VERSION_CONFLICT", "Document changed");
      const changed = this.#requireDocument(documentId);
      if (changed.sequence !== nextSequence) throw new Error("TASK_BOARD_DOCUMENT_SEQUENCE_INVALID");
      this.#insertDocumentEvent(changed, actor, request.clientId, eventType, now);
    });
    const document = this.#requireDocument(documentId);
    this.#emitDocumentEvent(documentId, document.sequence);
    return document;
  }

  updateDocument(documentId: string, request: UpdateDocumentRequest, actor: Actor): DocumentSnapshot {
    const current = this.#requireDocument(documentId);
    this.#assertDocumentActor(current, actor);
    if (request.penEpoch !== current.penEpoch) {
      throw conflict("DOCUMENT_PEN_EPOCH_CONFLICT", "Document pen epoch changed");
    }
    if (request.contentVersion !== current.contentVersion) {
      throw conflict("DOCUMENT_CONTENT_VERSION_CONFLICT", "Document content version changed");
    }
    if (
      current.penHolder === null ||
      current.penHolder.actorType !== actor.type ||
      current.penHolder.actorId !== actor.id ||
      current.penHolder.clientId !== request.clientId
    ) {
      throw new TaskBoardError(403, "DOCUMENT_PEN_NOT_HELD", "The current actor and client do not hold the document pen");
    }
    const now = exactNow(this.#config.now);
    this.#store.transaction(() => {
      const update = this.#store.db.prepare(`
        UPDATE documents
        SET content = ?, content_version = content_version + 1, sequence = sequence + 1, updated_at = ?
        WHERE document_id = ? AND content_version = ? AND pen_epoch = ? AND sequence = ?
          AND pen_holder_actor_type = ? AND pen_holder_actor_id = ? AND pen_holder_client_id = ?
      `).run(
        request.content,
        now,
        documentId,
        current.contentVersion,
        current.penEpoch,
        current.sequence,
        actor.type,
        actor.id,
        request.clientId,
      );
      if (Number(update.changes) !== 1) throw conflict("DOCUMENT_VERSION_CONFLICT", "Document changed");
      this.#insertDocumentEvent(this.#requireDocument(documentId), actor, request.clientId, "document_updated", now);
    });
    const document = this.#requireDocument(documentId);
    this.#emitDocumentEvent(documentId, document.sequence);
    return document;
  }

  listDocumentEvents(documentId: string, after = 0): readonly DocumentEvent[] {
    this.#requireDocument(documentId);
    return Object.freeze(this.#store.db.prepare(`
      SELECT * FROM document_events
      WHERE document_id = ? AND sequence > ?
      ORDER BY sequence
      LIMIT 200
    `).all(documentId, after).map(documentEventFromRow));
  }

  subscribeDocumentEvents(documentId: string, listener: (event: DocumentEvent) => void): () => void {
    this.#requireDocument(documentId);
    this.#documentEvents.on(documentId, listener);
    return () => this.#documentEvents.off(documentId, listener);
  }

  createAgent(projectId: string, request: CreateAgentRequest): AgentProfile {
    this.#requireProject(projectId);
    const tokenHash = sha256(request.token);
    if (tokenHash === sha256(this.#config.humanToken)) {
      throw conflict("TOKEN_REALM_CONFLICT", "Agent credential must be distinct from the human credential");
    }
    const now = exactNow(this.#config.now);
    try {
      this.#store.transaction(() => {
        this.#store.db.prepare(`
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
        this.#insertEvent(projectId, null, { type: "human", id: this.#config.humanPrincipal }, "agent_profile_created", {
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
    const created = this.#requireAgent(request.agentId);
    if (created.role === "manager") {
      const pending = this.#store.db.prepare(
        "SELECT work_item_id FROM work_items WHERE resolved_project_id=? AND state='submitted' AND ended_at IS NULL ORDER BY created_at,work_item_id",
      ).all(projectId);
      for (const row of pending) this.startWorkItemPlanning(String(row.work_item_id));
    }
    return created;
  }

  createTask(projectId: string, request: CreateTaskRequest): BoardTask {
    this.#requireProject(projectId);
    if (request.parentTaskId !== null) {
      const parent = this.#requireTask(request.parentTaskId);
      if (parent.projectId !== projectId) throw conflict("PARENT_PROJECT_MISMATCH", "Parent task belongs to another project");
    }
    if (request.assignedAgentId !== null && request.assignedRole !== null) {
      this.#assertAssignment(projectId, request.assignedAgentId, request.assignedRole);
    }
    const taskId = randomUUID();
    const now = exactNow(this.#config.now);
    const status: TaskStatus = request.assignedAgentId === null ? "backlog" : "queued";
    this.#store.transaction(() => {
      const orderKey = this.#nextTaskOrderKey();
      this.#store.db.prepare(`
        INSERT INTO tasks(
          task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
          title, objective, acceptance_criteria, workspace_refs_json,
          status, assigned_agent_id, assigned_role, expected_agent_minutes, agent_estimate_minutes, order_key, started_at, ended_at,
          result, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'work', NULL, ?, ?, ?, ?, ?, ?, ?, ?, 15, NULL, ?, NULL, NULL, NULL, 1, ?, ?)
      `).run(
        taskId,
        projectId,
        request.parentTaskId,
        request.requiresReview === false ? 0 : 1,
        request.title,
        request.objective,
        request.acceptanceCriteria,
        canonicalJson(request.workspaceRefs),
        status,
        request.assignedAgentId,
        request.assignedRole,
        orderKey,
        now,
        now,
      );
      this.#insertEvent(projectId, taskId, { type: "human", id: this.#config.humanPrincipal }, "task_created", {
        kind: "work",
        requiredRole: null,
        requiresReview: request.requiresReview !== false,
        status,
        assignedAgentId: request.assignedAgentId,
        expectedAgentMinutes: null,
        orderKey,
      }, now);
      if (request.assignedAgentId !== null) {
        this.#insertWakeup(
          projectId,
          request.assignedAgentId,
          "human_assignment",
          `task:${taskId}:version:1`,
          taskId,
          null,
          `Assigned task: ${request.title}`,
          now,
        );
      }
    });
    if (request.assignedAgentId !== null) this.#wakeupEvents.emit(request.assignedAgentId);
    return this.#requireTask(taskId);
  }

  updateTask(taskId: string, request: UpdateTaskRequest, actor: Actor): BoardTask {
    const current = this.#requireTask(taskId);
    if (current.version !== request.version) throw conflict("TASK_VERSION_CONFLICT", "Task version changed");
    if (current.endedAt !== null) throw conflict("TASK_TERMINAL", "Terminal tasks are immutable");
    if (current.kind === "human_check" && actor.type !== "human") {
      throw new TaskBoardError(403, "HUMAN_CHECK_HUMAN_ONLY", "Human checks can only be decided by a human");
    }
    if (actor.type === "human" && "expectedAgentMinutes" in request) {
      throw new TaskBoardError(403, "AGENT_ESTIMATE_REQUIRED", "Only the assigned agent can estimate task duration");
    }
    if (actor.type === "agent") {
      const forbidden = ["title", "objective", "acceptanceCriteria", "workspaceRefs", "assignedAgentId", "assignedRole", "orderKey"]
        .some((field) => field in request);
      if (forbidden) throw new TaskBoardError(403, "HUMAN_UPDATE_REQUIRED", "Assignment and planning fields are human-only");
      if (current.assignedAgentId !== actor.id) throw new TaskBoardError(403, "TASK_NOT_ASSIGNED", "Task is not assigned to this agent");
      if (request.status === "cancelled" || request.status === "backlog" || request.status === "queued") {
        throw new TaskBoardError(403, "HUMAN_UPDATE_REQUIRED", "Agent cannot move work to the requested status");
      }
      this.#requireActiveRun(actor.id, taskId);
    }
    const assignedAgentId = "assignedAgentId" in request ? request.assignedAgentId ?? null : current.assignedAgentId;
    const assignedRole = "assignedRole" in request ? request.assignedRole ?? null : current.assignedRole;
    if (assignedAgentId !== null && assignedRole !== null) this.#assertTaskAssignment(current, assignedAgentId, assignedRole);
    const assigneeChanged = actor.type === "human" && "assignedAgentId" in request && assignedAgentId !== current.assignedAgentId;
    const newAssignment = assigneeChanged && assignedAgentId !== null;
    const status = request.status ?? (newAssignment && current.status === "backlog" ? "queued" : current.status);
    if (current.kind === "human_check" && status !== "backlog" && status !== "completed" && status !== "failed" && status !== "cancelled") {
      throw new TaskBoardError(400, "HUMAN_CHECK_STATUS_INVALID", "Human checks stay in backlog until a human records a terminal decision");
    }
    const terminal = status === "completed" || status === "failed" || status === "cancelled";
    const result = "result" in request ? request.result ?? null : current.result;
    if (terminal && result === null) throw new TaskBoardError(400, "TASK_RESULT_REQUIRED", "Terminal task status requires a result");
    if (!terminal && result !== null) throw new TaskBoardError(400, "TASK_RESULT_NOT_TERMINAL", "Task result is reserved for terminal status");
    const now = exactNow(this.#config.now);
    const startedAt = current.startedAt ?? (status === "in_progress" || status === "blocked" || terminal ? now : null);
    const endedAt = terminal ? now : null;
    const expectedAgentMinutes = assigneeChanged
      ? null
      : "expectedAgentMinutes" in request
        ? request.expectedAgentMinutes ?? null
        : current.expectedAgentMinutes;
    const estimateRecordedAt = assigneeChanged
      ? null
      : "expectedAgentMinutes" in request
        ? request.expectedAgentMinutes === null ? null : now
        : current.estimateRecordedAt;
    const nextVersion = current.version + 1;
    let workflowWakeAgentId: string | null = null;
    const changed = this.#store.transaction(() => {
      const update = this.#store.db.prepare(`
        UPDATE tasks SET
          title = ?, objective = ?, acceptance_criteria = ?, workspace_refs_json = ?, status = ?,
          assigned_agent_id = ?, assigned_role = ?, agent_estimate_minutes = ?, estimate_recorded_at = ?, order_key = ?, started_at = ?, ended_at = ?,
          result = ?, version = ?, updated_at = ?
        WHERE task_id = ? AND version = ? AND ended_at IS NULL
      `).run(
        request.title ?? current.title,
        request.objective ?? current.objective,
        request.acceptanceCriteria ?? current.acceptanceCriteria,
        canonicalJson(request.workspaceRefs ?? current.workspaceRefs),
        status,
        assignedAgentId,
        assignedRole,
        expectedAgentMinutes,
        estimateRecordedAt,
        request.orderKey ?? current.orderKey,
        startedAt,
        endedAt,
        result,
        nextVersion,
        now,
        taskId,
        current.version,
      );
      if (Number(update.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Task version changed");
      this.#insertEvent(current.projectId, taskId, actor, "task_updated", {
        kind: current.kind,
        requiredRole: current.requiredRole,
        previousVersion: current.version,
        version: nextVersion,
        status,
        assignedAgentId,
        expectedAgentMinutes,
        orderKey: request.orderKey ?? current.orderKey,
      }, now);
      if (terminal) this.#reconcileTaskPhasesForTerminal(current, status, actor, now);
      if (assignedAgentId !== current.assignedAgentId || terminal || status === "backlog") {
        const retirementReason = status === "cancelled"
          ? "task_cancelled"
          : terminal
            ? "task_terminal"
            : assignedAgentId === null
              ? "task_unassigned"
              : status === "backlog"
                ? "task_not_runnable"
                : "task_reassigned";
        this.#retirePendingWakeupsForTask(taskId, retirementReason, now);
      }
      if (newAssignment) {
        this.#insertWakeup(
          current.projectId,
          assignedAgentId,
          "human_assignment",
          `task:${taskId}:version:${nextVersion}`,
          taskId,
          null,
          `Assigned task: ${request.title ?? current.title}`,
          now,
        );
      }
      if (status === "completed") {
        workflowWakeAgentId = this.#createReviewFollowup(current, now)?.wakeAgentId ?? null;
      }
      return true;
    });
    if (!changed) throw new Error("TASK_BOARD_UPDATE_FAILED");
    if (newAssignment) this.#wakeupEvents.emit(assignedAgentId);
    if (workflowWakeAgentId !== null) this.#wakeupEvents.emit(workflowWakeAgentId);
    return this.#requireTask(taskId);
  }

  createTaskPhase(taskId: string, request: CreateTaskPhaseRequest, agentId: string): TaskPhase {
    const task = this.#requireTask(taskId);
    if (task.assignedAgentId !== agentId) {
      throw new TaskBoardError(403, "TASK_NOT_ASSIGNED", "Task is not assigned to this agent");
    }
    if (task.endedAt !== null) throw conflict("TASK_TERMINAL", "Terminal task cannot add phases");
    this.#requireActiveRun(agentId, taskId);
    if (request.stage === "done") {
      throw new TaskBoardError(400, "PHASE_STATE_INVALID", "A new pending phase cannot start at the done stage");
    }
    const phaseId = randomUUID();
    const now = exactNow(this.#config.now);
    this.#store.transaction(() => {
      const orderKey = this.#nextPhaseOrderKey(taskId);
      this.#store.db.prepare(`
        INSERT INTO task_phases(
          phase_id, project_id, task_id, title, stage, status, parallel_group,
          order_key, started_at, ended_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, 1, ?, ?)
      `).run(
        phaseId,
        task.projectId,
        taskId,
        request.title,
        request.stage,
        request.parallelGroup,
        orderKey,
        now,
        now,
      );
      this.#insertEvent(task.projectId, taskId, { type: "agent", id: agentId }, "task_phase_created", {
        phaseId,
        stage: request.stage,
        status: "pending",
        parallelGroup: request.parallelGroup,
        orderKey,
      }, now);
    });
    return this.#requireTaskPhase(phaseId);
  }

  updateTaskPhase(phaseId: string, request: UpdateTaskPhaseRequest, agentId: string): TaskPhase {
    const current = this.#requireTaskPhase(phaseId);
    if (current.version !== request.version) throw conflict("TASK_PHASE_VERSION_CONFLICT", "Task phase version changed");
    if (current.endedAt !== null) throw conflict("TASK_PHASE_TERMINAL", "Terminal task phases are immutable");
    const task = this.#requireTask(current.taskId);
    if (task.assignedAgentId !== agentId) {
      throw new TaskBoardError(403, "TASK_NOT_ASSIGNED", "Task is not assigned to this agent");
    }
    if (task.endedAt !== null) throw conflict("TASK_TERMINAL", "Terminal task phases are immutable");
    this.#requireActiveRun(agentId, task.taskId);
    const stage = request.stage ?? current.stage;
    const status = request.status ?? current.status;
    if (stage === "done" && status !== "completed") {
      throw new TaskBoardError(400, "PHASE_STATE_INVALID", "The legacy done stage may only be used by a completed phase");
    }
    if (current.startedAt !== null && status === "pending") {
      throw new TaskBoardError(400, "PHASE_STATE_INVALID", "A started phase cannot return to pending");
    }
    const now = exactNow(this.#config.now);
    const startedAt = status === "pending" ? null : current.startedAt ?? now;
    const endedAt = status === "completed" || status === "failed" ? now : null;
    const nextVersion = current.version + 1;
    this.#store.transaction(() => {
      const update = this.#store.db.prepare(`
        UPDATE task_phases SET
          title = ?, stage = ?, status = ?, parallel_group = ?, order_key = ?,
          started_at = ?, ended_at = ?, version = ?, updated_at = ?
        WHERE phase_id = ? AND version = ? AND ended_at IS NULL
      `).run(
        request.title ?? current.title,
        stage,
        status,
        "parallelGroup" in request ? request.parallelGroup ?? null : current.parallelGroup,
        request.orderKey ?? current.orderKey,
        startedAt,
        endedAt,
        nextVersion,
        now,
        phaseId,
        current.version,
      );
      if (Number(update.changes) !== 1) throw conflict("TASK_PHASE_VERSION_CONFLICT", "Task phase version changed");
      this.#insertEvent(task.projectId, task.taskId, { type: "agent", id: agentId }, "task_phase_updated", {
        phaseId,
        previousVersion: current.version,
        version: nextVersion,
        stage,
        status,
      }, now);
    });
    return this.#requireTaskPhase(phaseId);
  }

  appendAgentMessage(taskId: string, agentId: string, request: CreateTaskMessageRequest): TaskMessage {
    const task = this.#requireTask(taskId);
    if (task.assignedAgentId !== agentId) throw new TaskBoardError(403, "TASK_NOT_ASSIGNED", "Task is not assigned to this agent");
    return this.#appendMessage(task, { type: "agent", id: agentId }, request.clientEventId, request.runId, request.kind, request.body);
  }

  appendHumanMessage(taskId: string, request: CreateHumanTaskMessageRequest): TaskMessage {
    const task = this.#requireTask(taskId);
    return this.#appendMessage(
      task,
      { type: "human", id: this.#config.humanPrincipal },
      request.clientEventId,
      null,
      request.kind,
      request.body,
    );
  }

  askQuestion(taskId: string, agentId: string, request: CreateHumanQuestionRequest): HumanQuestion {
    const task = this.#requireTask(taskId);
    if (task.assignedAgentId !== agentId) throw new TaskBoardError(403, "TASK_NOT_ASSIGNED", "Task is not assigned to this agent");
    const hash = sha256({ action: "ask_question", taskId, agentId, request });
    const prior = this.#store.db.prepare("SELECT * FROM questions WHERE agent_id = ? AND client_event_id = ?").get(agentId, request.clientEventId);
    if (prior) {
      if (stringValue(prior, "request_hash") !== hash) throw conflict("CLIENT_EVENT_CONFLICT", "clientEventId was used for another question");
      return questionFromRow(prior);
    }
    this.#requireRun(request.runId, agentId, taskId, true);
    if (task.endedAt !== null) throw conflict("TASK_TERMINAL", "Terminal task cannot wait for a human answer");
    const questionId = randomUUID();
    const now = exactNow(this.#config.now);
    this.#store.transaction(() => {
      this.#store.db.prepare(`
        INSERT INTO questions(
          question_id, project_id, task_id, agent_id, run_id, client_event_id, request_hash,
          question, status, answer, asked_at, answered_at, answered_by, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, NULL, NULL, 1)
      `).run(questionId, task.projectId, taskId, agentId, request.runId, request.clientEventId, hash, request.question, now);
      const settled = this.#store.db.prepare(`
        UPDATE runs SET status = 'waiting_for_human', ended_at = ?, result = ?
        WHERE run_id = ? AND agent_id = ? AND status = 'active'
      `).run(now, `Waiting for human answer: ${request.question}`, request.runId, agentId);
      if (Number(settled.changes) !== 1) throw conflict("RUN_NOT_ACTIVE", "Run is no longer active");
      if (task.status !== "blocked") {
        const blocked = this.#store.db.prepare(`
          UPDATE tasks
          SET status = 'blocked', version = version + 1, updated_at = ?
          WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND ended_at IS NULL
        `).run(now, taskId, agentId, task.version);
        if (Number(blocked.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Task changed while its question was opening");
        this.#insertEvent(task.projectId, taskId, { type: "agent", id: agentId }, "task_blocked_for_human", {
          runId: request.runId,
          questionId,
          previousStatus: task.status,
          status: "blocked",
          version: task.version + 1,
        }, now);
      }
      this.#insertEvent(task.projectId, taskId, { type: "agent", id: agentId }, "human_question_opened", {
        questionId,
        runId: request.runId,
      }, now);
    });
    return questionFromRow(this.#store.db.prepare("SELECT * FROM questions WHERE question_id = ?").get(questionId)!);
  }

  answerQuestion(questionId: string, request: AnswerHumanQuestionRequest): { question: HumanQuestion; wakeup: Wakeup; duplicate: boolean } {
    const currentRow = this.#store.db.prepare("SELECT * FROM questions WHERE question_id = ?").get(questionId);
    if (!currentRow) throw new TaskBoardError(404, "QUESTION_NOT_FOUND", "Question was not found");
    const current = questionFromRow(currentRow);
    if (current.status === "answered") {
      if (current.answer !== request.answer || current.version !== request.version + 1) {
        throw conflict("QUESTION_ALREADY_ANSWERED", "Question already has another answer");
      }
      const wake = this.#store.db.prepare("SELECT * FROM wakeups WHERE reason = 'human_answer' AND source_key = ?").get(`question:${questionId}`);
      if (!wake) throw new Error("TASK_BOARD_DATABASE_CORRUPT:answered_question_wakeup");
      return { question: current, wakeup: wakeupFromRow(wake), duplicate: true };
    }
    if (current.version !== request.version) throw conflict("QUESTION_VERSION_CONFLICT", "Question version changed");
    const now = exactNow(this.#config.now);
    let wakeupId = "";
    this.#store.transaction(() => {
      const update = this.#store.db.prepare(`
        UPDATE questions SET status = 'answered', answer = ?, answered_at = ?, answered_by = ?, version = version + 1
        WHERE question_id = ? AND status = 'open' AND version = ?
      `).run(request.answer, now, this.#config.humanPrincipal, questionId, request.version);
      if (Number(update.changes) !== 1) throw conflict("QUESTION_VERSION_CONFLICT", "Question version changed");
      wakeupId = this.#insertWakeup(
        current.projectId,
        current.agentId,
        "human_answer",
        `question:${questionId}`,
        current.taskId,
        questionId,
        `Human answered: ${request.answer}`,
        now,
      );
      this.#insertEvent(current.projectId, current.taskId, { type: "human", id: this.#config.humanPrincipal }, "human_question_answered", {
        questionId,
        wakeupId,
      }, now);
    });
    this.#wakeupEvents.emit(current.agentId);
    return {
      question: questionFromRow(this.#store.db.prepare("SELECT * FROM questions WHERE question_id = ?").get(questionId)!),
      wakeup: wakeupFromRow(this.#store.db.prepare("SELECT * FROM wakeups WHERE wakeup_id = ?").get(wakeupId)!),
      duplicate: false,
    };
  }

  resumeAgent(agentId: string, request: ResumeAgentRequest, idempotencyKey: string): { wakeup: Wakeup; duplicate: boolean } {
    const agent = this.#requireAgent(agentId);
    if (request.taskId !== null) {
      const task = this.#requireTask(request.taskId);
      if (task.projectId !== agent.projectId) throw conflict("TASK_PROJECT_MISMATCH", "Resume task belongs to another project");
      if (task.kind === "human_check") throw conflict("HUMAN_CHECK_NOT_ASSIGNABLE", "Human checks cannot wake an agent");
      if (task.requiredRole !== null && task.requiredRole !== agent.role) {
        throw conflict("TASK_REQUIRED_ROLE_MISMATCH", `This task requires the ${task.requiredRole} role`);
      }
    }
    const sourceKey = `${agentId}:${idempotencyKey}`;
    const prior = this.#store.db.prepare("SELECT * FROM wakeups WHERE reason = 'human_resume' AND source_key = ?").get(sourceKey);
    if (prior) {
      if (stringValue(prior, "detail") !== request.reason || nullableString(prior, "task_id") !== request.taskId) {
        throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key was used for another resume");
      }
      return { wakeup: wakeupFromRow(prior), duplicate: true };
    }
    const now = exactNow(this.#config.now);
    let wakeupId = "";
    this.#store.transaction(() => {
      wakeupId = this.#insertWakeup(
        agent.projectId,
        agentId,
        "human_resume",
        sourceKey,
        request.taskId,
        null,
        request.reason,
        now,
      );
      this.#insertEvent(agent.projectId, request.taskId, { type: "human", id: this.#config.humanPrincipal }, "agent_resumed", {
        agentId,
        wakeupId,
      }, now);
    });
    this.#wakeupEvents.emit(agentId);
    return { wakeup: wakeupFromRow(this.#store.db.prepare("SELECT * FROM wakeups WHERE wakeup_id = ?").get(wakeupId)!), duplicate: false };
  }

  interruptAgent(
    agentId: string,
    request: InterruptAgentRequest,
    idempotencyKey: string,
  ): { interrupt: AgentInterrupt; duplicate: boolean } {
    const agent = this.#requireAgent(agentId);
    const hash = sha256({ action: "interrupt_agent", agentId, request });
    const prior = this.#store.db.prepare("SELECT * FROM interrupts WHERE agent_id = ? AND idempotency_key = ?").get(agentId, idempotencyKey);
    if (prior) {
      if (stringValue(prior, "request_hash") !== hash) throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key was used for another interrupt");
      return { interrupt: interruptFromRow(prior), duplicate: true };
    }
    const active = this.#store.db.prepare("SELECT run_id FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
    const runId = active ? stringValue(active, "run_id") : null;
    const now = exactNow(this.#config.now);
    const interruptId = randomUUID();
    this.#store.transaction(() => {
      this.#store.db.prepare(`
        INSERT INTO interrupts(
          interrupt_id, project_id, agent_id, run_id, idempotency_key, request_hash, reason, requested_by, requested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(interruptId, agent.projectId, agentId, runId, idempotencyKey, hash, request.reason, this.#config.humanPrincipal, now);
      this.#insertEvent(agent.projectId, null, { type: "human", id: this.#config.humanPrincipal }, "agent_interrupt_requested", {
        interruptId,
        agentId,
        runId,
        reason: request.reason,
      }, now);
    });
    const interrupt = interruptFromRow(this.#store.db.prepare("SELECT * FROM interrupts WHERE interrupt_id = ?").get(interruptId)!);
    if (runId !== null) this.#interruptEvents.emit(runId);
    return { interrupt, duplicate: false };
  }

  async waitForRunInterrupts(
    runId: string,
    agentId: string,
    after: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<RunInterruptBatch | null> {
    this.#requireRun(runId, agentId, null, false);
    if (signal.aborted) return null;
    const immediate = this.#interruptBatch(runId, after);
    if (immediate.items.length > 0 || waitMs === 0) return immediate.items.length > 0 ? immediate : null;
    const releaseConnection = this.#retainWorkerConnection(agentId, "watching_run");
    try {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          this.#interruptEvents.off(runId, done);
          signal.removeEventListener("abort", done);
          resolve();
        };
        this.#interruptEvents.once(runId, done);
        signal.addEventListener("abort", done, { once: true });
        timer = setTimeout(done, waitMs);
        timer.unref();
        if (signal.aborted) done();
      });
    } finally {
      releaseConnection();
    }
    if (signal.aborted) return null;
    const batch = this.#interruptBatch(runId, after);
    return batch.items.length > 0 ? batch : null;
  }

  claimRun(agentId: string, request: ClaimRunRequest): ClaimRunResult | null {
    const agent = this.#requireAgent(agentId);
    const prior = this.#store.db.prepare("SELECT * FROM runs WHERE agent_id = ? AND claim_id = ?").get(agentId, request.claimId);
    if (prior) {
      const priorRun = runFromRow(prior);
      const requestHash = claimRequestHash(agentId, request, priorRun.taskId);
      const storedHash = stringValue(prior, "claim_request_hash");
      const selectedCursor = claimMessageCursor(request, priorRun.taskId);
      if (storedHash !== requestHash && storedHash !== legacyClaimRequestHash(agentId, request.claimId, selectedCursor)) {
        throw conflict("CLAIM_ID_CONFLICT", "claimId was used with another cursor");
      }
      return this.#claimResult(priorRun, selectedCursor ?? 0);
    }
    const existing = this.#store.db.prepare("SELECT run_id FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
    if (existing) throw conflict("AGENT_RUN_ACTIVE", "Agent already has an active run");
    const now = exactNow(this.#config.now);
    const claimed = this.#store.transaction(() => {
      const activeInside = this.#store.db.prepare("SELECT 1 FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
      if (activeInside) throw conflict("AGENT_RUN_ACTIVE", "Agent already has an active run");
      this.#retireStaleWakeupsForAgent(agentId, now);
      const wakeupRow = this.#store.db.prepare(`
        SELECT wakeup.*
        FROM wakeups AS wakeup
        LEFT JOIN tasks AS ordered_task ON ordered_task.task_id = wakeup.task_id
        WHERE wakeup.agent_id = ?
          AND wakeup.claimed_at IS NULL
          AND (
            wakeup.task_id IS NULL OR EXISTS (
              SELECT 1 FROM tasks AS task
              WHERE task.task_id = wakeup.task_id
                AND task.project_id = wakeup.project_id
                AND task.assigned_agent_id = wakeup.agent_id
                AND task.ended_at IS NULL
                AND task.status IN ('queued', 'blocked')
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM task_events AS event
            WHERE event.event_id = ? || wakeup.wakeup_id
          )
        ORDER BY
          CASE WHEN ordered_task.task_id IS NULL THEN 1 ELSE 0 END,
          ordered_task.order_key,
          ordered_task.task_id,
          wakeup.created_at,
          wakeup.rowid
        LIMIT 1
      `).get(agentId, RETIRED_WAKEUP_EVENT_PREFIX);
      if (!wakeupRow) return null;
      const wakeup = wakeupFromRow(wakeupRow);
      const requestHash = claimRequestHash(agentId, request, wakeup.taskId);
      const runId = randomUUID();
      this.#store.db.prepare(`
        INSERT INTO runs(run_id, claim_id, claim_request_hash, project_id, agent_id, wakeup_id, task_id, status, started_at, ended_at, result)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL)
      `).run(runId, request.claimId, requestHash, agent.projectId, agentId, wakeup.wakeupId, wakeup.taskId, now);
      const claim = this.#store.db.prepare(`
        UPDATE wakeups SET claimed_at = ?, run_id = ? WHERE wakeup_id = ? AND claimed_at IS NULL
      `).run(now, runId, wakeup.wakeupId);
      if (Number(claim.changes) !== 1) throw conflict("WAKEUP_ALREADY_CLAIMED", "Wakeup was already claimed");
      if (wakeup.taskId !== null) {
        const taskRow = this.#store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(wakeup.taskId);
        if (!taskRow) throw new Error("TASK_BOARD_DATABASE_CORRUPT:wakeup_task");
        const task = this.#requireTask(wakeup.taskId);
        if (task.assignedAgentId !== agentId) {
          throw conflict("WAKEUP_TASK_NOT_ASSIGNED", "Wakeup task is no longer assigned to this agent");
        }
        if (task.endedAt !== null) throw conflict("WAKEUP_TASK_TERMINAL", "Wakeup task is already terminal");
        if (task.status === "queued" || task.status === "blocked") {
          const started = this.#store.db.prepare(`
            UPDATE tasks
            SET status = 'in_progress', started_at = COALESCE(started_at, ?), version = version + 1, updated_at = ?
            WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND status IN ('queued', 'blocked') AND ended_at IS NULL
          `).run(now, now, task.taskId, agentId, task.version);
          if (Number(started.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Task changed while its run was starting");
          this.#insertEvent(task.projectId, task.taskId, { type: "agent", id: agentId }, "task_run_started", {
            kind: task.kind,
            requiredRole: task.requiredRole,
            runId,
            previousStatus: task.status,
            status: "in_progress",
            version: task.version + 1,
          }, now);
        }
      }
      this.#insertEvent(agent.projectId, wakeup.taskId, { type: "agent", id: agentId }, "agent_run_claimed", {
        runId,
        claimId: request.claimId,
        wakeupId: wakeup.wakeupId,
        wakeReason: wakeup.reason,
      }, now);
      return Object.freeze({ runId, wakeup });
    });
    if (claimed === null) return null;
    return this.#claimResult(
      runFromRow(this.#store.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(claimed.runId)!),
      claimMessageCursor(request, claimed.wakeup.taskId) ?? 0,
    );
  }

  async waitToClaimRun(
    agentId: string,
    request: ClaimRunRequest,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<ClaimRunResult | null> {
    if (signal.aborted) {
      this.#requireAgent(agentId);
      return null;
    }
    const immediate = this.claimRun(agentId, request);
    if (immediate !== null || waitMs === 0) return immediate;
    const releaseConnection = this.#retainWorkerConnection(agentId, "waiting_for_wake");
    try {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          this.#wakeupEvents.off(agentId, done);
          signal.removeEventListener("abort", done);
          resolve();
        };
        this.#wakeupEvents.once(agentId, done);
        signal.addEventListener("abort", done, { once: true });
        timer = setTimeout(done, waitMs);
        timer.unref();
        if (signal.aborted) done();
      });
    } finally {
      releaseConnection();
    }
    if (signal.aborted) return null;
    return this.claimRun(agentId, request);
  }

  settleRun(runId: string, agentId: string, request: SettleRunRequest): { run: AgentRun; duplicate: boolean } {
    const row = this.#store.db.prepare("SELECT * FROM runs WHERE run_id = ? AND agent_id = ?").get(runId, agentId);
    if (!row) throw new TaskBoardError(404, "RUN_NOT_FOUND", "Run was not found");
    const current = runFromRow(row);
    if (current.status !== "active") {
      if (current.status === request.outcome && current.result === request.result) return { run: current, duplicate: true };
      throw conflict("RUN_NOT_ACTIVE", "Run is already settled");
    }
    const planning = current.taskId === null ? undefined : this.#store.db.prepare(`
      SELECT w.* FROM work_item_planning_tasks link
      JOIN work_items w ON w.work_item_id=link.work_item_id
      WHERE link.task_id=?
    `).get(current.taskId);
    if (planning && request.outcome === "completed") {
      if (request.workflowPlan === undefined || request.workflowPlan === null) {
        throw new TaskBoardError(400, "WORKFLOW_PLAN_REQUIRED", "Planning tasks must return a workflow plan");
      }
      const workItemId = String(planning.work_item_id);
      const existingPlan = this.#store.db.prepare(
        "SELECT 1 FROM plan_revisions WHERE work_item_id=? AND state IN ('proposed','confirmed')",
      ).get(workItemId);
      if (!existingPlan) {
        const configured = this.getAutomationConfiguration();
        const requiredStages = new Set(request.workflowPlan.nodes.flatMap((node) => node.stageTemplate));
        for (const stage of requiredStages) {
          const executor = configured.stages.find((configuredStage) => configuredStage.stage === stage)?.executor;
          const agentType = executor?.kind === "agent_type"
            ? configured.agentTypes.find((candidate) => candidate.agentTypeId === executor.agentTypeId && candidate.enabled)
            : undefined;
          if (agentType === undefined) {
            throw new TaskBoardError(409, "WORKFLOW_EXECUTOR_UNAVAILABLE", `No enabled executor is configured for ${stage}`);
          }
        }
        const executorTypeIds = new Set(configured.stages.flatMap((stage) =>
          requiredStages.has(stage.stage as import("#shared/task-board-contract").WorkflowStage) &&
          stage.executor.kind === "agent_type" ? [stage.executor.agentTypeId] : []));
        const skillIds = [...new Set(configured.agentTypes.flatMap((agentType) =>
          agentType.enabled && executorTypeIds.has(agentType.agentTypeId) ? agentType.skillIds : []))];
        this.#workflow.propose({
          workItemId,
          projectId: String(planning.resolved_project_id),
          objective: request.workflowPlan.objective,
          assumptions: request.workflowPlan.assumptions,
          acceptanceCriteria: request.workflowPlan.acceptanceCriteria,
          skillIds,
          nodes: request.workflowPlan.nodes,
        }, agentId);
      }
    } else if (request.workflowPlan !== undefined && request.workflowPlan !== null) {
      throw new TaskBoardError(400, "WORKFLOW_PLAN_NOT_ALLOWED", "Only completed planning tasks can return a workflow plan");
    }
    const now = exactNow(this.#config.now);
    let workflowWakeAgentId: string | null = null;
    this.#store.transaction(() => {
      const update = this.#store.db.prepare(`
        UPDATE runs SET status = ?, ended_at = ?, result = ? WHERE run_id = ? AND agent_id = ? AND status = 'active'
      `).run(request.outcome, now, request.result, runId, agentId);
      if (Number(update.changes) !== 1) throw conflict("RUN_NOT_ACTIVE", "Run is already settled");
      if (current.taskId !== null) {
        const taskRow = this.#store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(current.taskId);
        if (!taskRow) throw new Error("TASK_BOARD_DATABASE_CORRUPT:run_task");
        const task = this.#requireTask(current.taskId);
        if (task.assignedAgentId === agentId && task.endedAt === null) {
          const nextStatus: TaskStatus = request.outcome === "completed" ? "completed" : "blocked";
          if (task.status !== nextStatus || request.outcome === "completed") {
            const lifecycle = request.outcome === "completed"
              ? this.#store.db.prepare(`
                  UPDATE tasks
                  SET status = 'completed', ended_at = ?, result = ?, version = version + 1, updated_at = ?
                  WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND ended_at IS NULL
                `).run(now, request.result, now, task.taskId, agentId, task.version)
              : this.#store.db.prepare(`
                  UPDATE tasks
                  SET status = 'blocked', ended_at = NULL, result = NULL, version = version + 1, updated_at = ?
                  WHERE task_id = ? AND assigned_agent_id = ? AND version = ? AND ended_at IS NULL
                `).run(now, task.taskId, agentId, task.version);
            if (Number(lifecycle.changes) !== 1) throw conflict("TASK_VERSION_CONFLICT", "Task changed while its run was settling");
            this.#insertEvent(task.projectId, task.taskId, { type: "agent", id: agentId }, "task_run_settled", {
              kind: task.kind,
              requiredRole: task.requiredRole,
              runId,
              outcome: request.outcome,
              previousStatus: task.status,
              status: nextStatus,
              version: task.version + 1,
            }, now);
            if (request.outcome === "completed") {
              this.#reconcileTaskPhasesForTerminal(task, "completed", { type: "agent", id: agentId }, now);
              this.#retirePendingWakeupsForTask(task.taskId, "task_terminal", now);
              workflowWakeAgentId = this.#createReviewFollowup(task, now)?.wakeAgentId ?? null;
            }
          }
        }
      }
      this.#insertEvent(current.projectId, current.taskId, { type: "agent", id: agentId }, "agent_run_settled", {
        runId,
        outcome: request.outcome,
      }, now);
    });
    if (workflowWakeAgentId !== null) this.#wakeupEvents.emit(workflowWakeAgentId);
    if (planning && request.outcome !== "completed") {
      const now = exactNow(this.#config.now);
      this.#store.transaction(() => {
        this.#store.db.prepare(
          "UPDATE work_items SET state='needs_input',current_stage='planning',version=version+1,updated_at=? WHERE work_item_id=? AND ended_at IS NULL",
        ).run(now, String(planning.work_item_id));
      });
    }
    if (current.taskId !== null) {
      for (const node of this.#workflow.settleAttempt(current.taskId, request.outcome, request.result, request.handoff)) this.#activateWorkflowNode(node);
    }
    return { run: runFromRow(this.#store.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId)!), duplicate: false };
  }

  snapshot(projectId: string): BoardSnapshot {
    const project = this.#requireProject(projectId);
    return Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      project,
      agents: Object.freeze(this.#store.db.prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY created_at, agent_id").all(projectId).map((row) => this.#agentFromRow(row))),
      tasks: Object.freeze(this.#store.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY order_key, task_id").all(projectId).map((row) => {
        const taskId = stringValue(row, "task_id");
        return taskFromRow(row, this.#taskPhases(taskId));
      })),
      openQuestions: Object.freeze(this.#store.db.prepare("SELECT * FROM questions WHERE project_id = ? AND status = 'open' ORDER BY asked_at, question_id").all(projectId).map(questionFromRow)),
      recentQuestions: Object.freeze(this.#store.db.prepare("SELECT * FROM questions WHERE project_id = ? ORDER BY asked_at DESC, question_id DESC LIMIT 100").all(projectId).map(questionFromRow)),
      recentRuns: Object.freeze(this.#store.db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC, run_id DESC LIMIT 100").all(projectId).map(runFromRow)),
      recentInterrupts: Object.freeze(this.#store.db.prepare("SELECT * FROM interrupts WHERE project_id = ? ORDER BY sequence DESC LIMIT 100").all(projectId).map(interruptFromRow)),
      recentEvents: Object.freeze(this.#store.db.prepare("SELECT * FROM task_events WHERE project_id = ? ORDER BY sequence DESC LIMIT 200").all(projectId).map(eventFromRow)),
      documents: this.listDocuments(projectId),
    });
  }

  listMessages(taskId: string, after = 0): readonly TaskMessage[] {
    this.#requireTask(taskId);
    return Object.freeze(this.#store.db.prepare(`
      SELECT * FROM task_messages WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT 200
    `).all(taskId, after).map(messageFromRow));
  }

  requireTask(taskId: string): BoardTask {
    return this.#requireTask(taskId);
  }

  close(): void {
    this.#interruptEvents.removeAllListeners();
    this.#wakeupEvents.removeAllListeners();
    this.#documentEvents.removeAllListeners();
    this.#workerConnections.clear();
    this.#store.close();
  }

  #appendMessage(
    task: BoardTask,
    actor: Actor,
    clientEventId: string,
    runId: string | null,
    kind: TaskMessage["kind"],
    body: string,
  ): TaskMessage {
    const hash = sha256({ action: "append_task_message", taskId: task.taskId, actor, clientEventId, runId, kind, body });
    const prior = this.#store.db.prepare(`
      SELECT * FROM task_messages WHERE actor_type = ? AND actor_id = ? AND client_event_id = ?
    `).get(actor.type, actor.id, clientEventId);
    if (prior) {
      if (stringValue(prior, "request_hash") !== hash) throw conflict("CLIENT_EVENT_CONFLICT", "clientEventId was used for another message");
      return messageFromRow(prior);
    }
    if (actor.type === "agent") {
      if (runId === null) throw new Error("TASK_BOARD_AGENT_MESSAGE_RUN_MISSING");
      this.#requireRun(runId, actor.id, task.taskId, true);
    }
    const messageId = randomUUID();
    const now = exactNow(this.#config.now);
    this.#store.transaction(() => {
      this.#store.db.prepare(`
        INSERT INTO task_messages(
          message_id, project_id, task_id, run_id, actor_type, actor_id, client_event_id,
          request_hash, kind, body, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(messageId, task.projectId, task.taskId, runId, actor.type, actor.id, clientEventId, hash, kind, body, now);
      this.#insertEvent(task.projectId, task.taskId, actor, "task_message_appended", { messageId, kind }, now);
    });
    return messageFromRow(this.#store.db.prepare("SELECT * FROM task_messages WHERE message_id = ?").get(messageId)!);
  }

  #claimResult(run: AgentRun, cursor: number): ClaimRunResult {
    const wakeup = wakeupFromRow(this.#store.db.prepare("SELECT * FROM wakeups WHERE wakeup_id = ?").get(run.wakeupId)!);
    const task = wakeup.taskId === null ? null : this.#requireTask(wakeup.taskId);
    const messages = task === null ? [] : this.#store.db.prepare(`
      SELECT * FROM task_messages WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT 100
    `).all(task.taskId, cursor).map(messageFromRow);
    const messageCursor = messages.at(-1)?.sequence ?? cursor;
    const triggerQuestion = wakeup.questionId === null
      ? null
      : questionFromRow(this.#store.db.prepare("SELECT * FROM questions WHERE question_id = ?").get(wakeup.questionId)!);
    const parentTask = task?.parentTaskId ? this.#requireTask(task.parentTaskId) : null;
    const parentMessages = parentTask === null ? [] : this.#store.db.prepare(`
      SELECT * FROM (
        SELECT * FROM task_messages WHERE task_id = ? ORDER BY sequence DESC LIMIT 12
      ) ORDER BY sequence
    `).all(parentTask.taskId).map(messageFromRow);
    const areaMemory = this.#store.db.prepare(`
      SELECT task_id, title, substr(result, 1, 1000) AS result, ended_at
      FROM tasks
      WHERE project_id = ?
        AND assigned_agent_id = ?
        AND status = 'completed'
        AND result IS NOT NULL
        AND ended_at IS NOT NULL
        AND (? IS NULL OR task_id <> ?)
      ORDER BY ended_at DESC, task_id DESC
      LIMIT 8
    `).all(run.projectId, run.agentId, run.taskId, run.taskId).map((row) => Object.freeze({
      taskId: stringValue(row, "task_id"),
      title: stringValue(row, "title"),
      result: stringValue(row, "result"),
      endedAt: stringValue(row, "ended_at"),
    }));
    const project = this.#requireProject(run.projectId);
    return Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      run,
      wakeup,
      task,
      context: Object.freeze({
        agent: this.#requireAgent(run.agentId),
        projectMemory: Object.freeze({ projectId: project.projectId, name: project.name, description: project.description }),
        areaMemory: Object.freeze(areaMemory),
        parentTask,
        parentMessages: Object.freeze(parentMessages),
        acceptanceCriteria: task?.acceptanceCriteria ?? null,
        workspaceRefs: task?.workspaceRefs ?? Object.freeze([]),
        messageCursor,
        messages: Object.freeze(messages),
        triggerQuestion,
        openQuestions: Object.freeze(this.#store.db.prepare(`
          SELECT * FROM questions WHERE agent_id = ? AND status = 'open' ORDER BY asked_at, question_id LIMIT 50
        `).all(run.agentId).map(questionFromRow)),
        workflow: task === null ? null : this.#workflow.claimContext(task.taskId),
      }),
    });
  }

  #interruptBatch(runId: string, after: number): RunInterruptBatch {
    const items = this.#store.db.prepare(`
      SELECT * FROM interrupts WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT 100
    `).all(runId, after).map(interruptFromRow);
    return Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      items: Object.freeze(items),
      cursor: items.at(-1)?.sequence ?? after,
    });
  }

  #retainWorkerConnection(agentId: string, connection: ActiveWorkerConnection): () => void {
    const counts = this.#workerConnections.get(agentId) ?? { waitingForWake: 0, watchingRun: 0 };
    if (!this.#workerConnections.has(agentId)) this.#workerConnections.set(agentId, counts);
    if (connection === "waiting_for_wake") counts.waitingForWake += 1;
    else counts.watchingRun += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.#workerConnections.get(agentId) !== counts) return;
      if (connection === "waiting_for_wake") counts.waitingForWake -= 1;
      else counts.watchingRun -= 1;
      if (counts.waitingForWake === 0 && counts.watchingRun === 0) this.#workerConnections.delete(agentId);
    };
  }

  #workerConnection(agentId: string): WorkerConnection {
    const counts = this.#workerConnections.get(agentId);
    if (counts === undefined) return null;
    if (counts.watchingRun > 0) return "watching_run";
    return counts.waitingForWake > 0 ? "waiting_for_wake" : null;
  }

  #agentFromRow(row: Row): AgentProfile {
    const agentId = stringValue(row, "agent_id");
    const active = this.#store.db.prepare("SELECT run_id FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
    let status: AgentProfile["status"];
    if (active) {
      const interrupted = this.#store.db.prepare("SELECT 1 FROM interrupts WHERE run_id = ? LIMIT 1").get(stringValue(active, "run_id"));
      status = interrupted ? "interrupting" : "running";
    } else if (this.#store.db.prepare(`
      SELECT 1
      FROM wakeups AS wakeup
      WHERE wakeup.agent_id = ?
        AND wakeup.claimed_at IS NULL
        AND (
          wakeup.task_id IS NULL OR EXISTS (
            SELECT 1 FROM tasks AS task
            WHERE task.task_id = wakeup.task_id
              AND task.project_id = wakeup.project_id
              AND task.assigned_agent_id = wakeup.agent_id
              AND task.ended_at IS NULL
              AND task.status IN ('queued', 'blocked')
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_events AS event
          WHERE event.event_id = ? || wakeup.wakeup_id
        )
      LIMIT 1
    `).get(agentId, RETIRED_WAKEUP_EVENT_PREFIX)) {
      status = "ready";
    } else if (this.#store.db.prepare("SELECT 1 FROM questions WHERE agent_id = ? AND status = 'open' LIMIT 1").get(agentId)) {
      status = "waiting_for_human";
    } else {
      status = "idle";
    }
    return Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      agentId,
      projectId: stringValue(row, "project_id"),
      role: stringValue(row, "role") as AgentRole,
      area: stringValue(row, "area"),
      mission: stringValue(row, "mission"),
      model: stringValue(row, "model"),
      status,
      workerConnection: this.#workerConnection(agentId),
      createdAt: stringValue(row, "created_at"),
    });
  }

  #requireProject(projectId: string): Project {
    const row = this.#store.db.prepare("SELECT * FROM projects WHERE project_id = ?").get(projectId);
    if (!row) throw new TaskBoardError(404, "PROJECT_NOT_FOUND", "Project was not found");
    return projectFromRow(row);
  }

  #requireWorkItem(workItemId: string): WorkItem {
    const row = this.#store.db.prepare("SELECT * FROM work_items WHERE work_item_id = ?").get(workItemId);
    if (!row) throw new TaskBoardError(404, "WORK_ITEM_NOT_FOUND", "Work item was not found");
    return workItemFromRow(row);
  }

  #requireDocument(documentId: string): DocumentSnapshot {
    const row = this.#store.db.prepare("SELECT * FROM documents WHERE document_id = ?").get(documentId);
    if (!row) throw new TaskBoardError(404, "DOCUMENT_NOT_FOUND", "Document was not found");
    return documentFromRow(row);
  }

  #assertDocumentActor(document: DocumentSnapshot, actor: Actor): void {
    if (actor.type === "human") {
      if (actor.id !== this.#config.humanPrincipal) {
        throw new TaskBoardError(403, "DOCUMENT_PROJECT_FORBIDDEN", "Actor cannot access this document");
      }
      return;
    }
    const agent = this.#requireAgent(actor.id);
    if (agent.projectId !== document.projectId) {
      throw new TaskBoardError(403, "DOCUMENT_PROJECT_FORBIDDEN", "Agent belongs to another project");
    }
  }

  #insertDocumentEvent(
    document: DocumentSnapshot,
    actor: Actor,
    clientId: string,
    eventType: DocumentEventType,
    now: string,
  ): void {
    this.#store.db.prepare(`
      INSERT INTO document_events(
        document_id, sequence, event_id, project_id, event_type, actor_type,
        actor_id, client_id, document_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      document.documentId,
      document.sequence,
      randomUUID(),
      document.projectId,
      eventType,
      actor.type,
      actor.id,
      clientId,
      canonicalJson(document),
      now,
    );
  }

  #emitDocumentEvent(documentId: string, sequence: number): void {
    const row = this.#store.db.prepare(`
      SELECT * FROM document_events WHERE document_id = ? AND sequence = ?
    `).get(documentId, sequence);
    if (!row) throw new Error("TASK_BOARD_DATABASE_CORRUPT:document_event");
    const event = documentEventFromRow(row);
    for (const candidate of this.#documentEvents.listeners(documentId)) {
      try {
        (candidate as (item: DocumentEvent) => void)(event);
      } catch {
        // A disconnected watcher cannot make a committed document mutation fail.
      }
    }
  }

  #requireAgent(agentId: string): AgentProfile {
    const row = this.#store.db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId);
    if (!row) throw new TaskBoardError(404, "AGENT_NOT_FOUND", "Agent was not found");
    return this.#agentFromRow(row);
  }

  #nextTaskOrderKey(): number {
    const row = this.#store.db.prepare(`
      SELECT COALESCE(MAX(order_key), -1024) + 1024 AS next_order_key
      FROM tasks
    `).get();
    const orderKey = numberValue(row!, "next_order_key");
    if (!Number.isSafeInteger(orderKey) || orderKey < 0) throw conflict("TASK_ORDER_EXHAUSTED", "Task order key space is exhausted");
    return orderKey;
  }

  #nextPhaseOrderKey(taskId: string): number {
    const row = this.#store.db.prepare(`
      SELECT COALESCE(MAX(order_key), -1024) + 1024 AS next_order_key
      FROM task_phases WHERE task_id = ?
    `).get(taskId);
    const orderKey = numberValue(row!, "next_order_key");
    if (!Number.isSafeInteger(orderKey) || orderKey < 0) throw conflict("TASK_PHASE_ORDER_EXHAUSTED", "Task phase order key space is exhausted");
    return orderKey;
  }

  #taskPhases(taskId: string): readonly TaskPhase[] {
    return Object.freeze(this.#store.db.prepare(`
      SELECT * FROM task_phases WHERE task_id = ? ORDER BY order_key, phase_id
    `).all(taskId).map(phaseFromRow));
  }

  #requireTaskPhase(phaseId: string): TaskPhase {
    const row = this.#store.db.prepare("SELECT * FROM task_phases WHERE phase_id = ?").get(phaseId);
    if (!row) throw new TaskBoardError(404, "TASK_PHASE_NOT_FOUND", "Task phase was not found");
    return phaseFromRow(row);
  }

  #reconcileTaskPhasesForTerminal(
    task: BoardTask,
    taskStatus: Extract<TaskStatus, "completed" | "failed" | "cancelled">,
    actor: Actor,
    now: string,
  ): void {
    const phases = this.#store.db.prepare(`
      SELECT * FROM task_phases
      WHERE task_id = ? AND ended_at IS NULL
      ORDER BY order_key, phase_id
    `).all(task.taskId).map(phaseFromRow);
    const phaseStatus: TaskPhaseStatus = taskStatus === "completed" ? "completed" : "failed";
    for (const phase of phases) {
      const stage = phase.stage;
      const nextVersion = phase.version + 1;
      const update = this.#store.db.prepare(`
        UPDATE task_phases SET
          stage = ?, status = ?, started_at = COALESCE(started_at, ?), ended_at = ?,
          version = ?, updated_at = ?
        WHERE phase_id = ? AND version = ? AND ended_at IS NULL
      `).run(stage, phaseStatus, now, now, nextVersion, now, phase.phaseId, phase.version);
      if (Number(update.changes) !== 1) {
        throw conflict("TASK_PHASE_VERSION_CONFLICT", "Task phase changed while its task became terminal");
      }
      this.#insertEvent(task.projectId, task.taskId, actor, "task_phase_updated", {
        phaseId: phase.phaseId,
        previousVersion: phase.version,
        version: nextVersion,
        stage,
        status: phaseStatus,
        terminalTaskStatus: taskStatus,
      }, now);
    }
  }

  #requireTask(taskId: string): BoardTask {
    const row = this.#store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
    if (!row) throw new TaskBoardError(404, "TASK_NOT_FOUND", "Task was not found");
    return taskFromRow(row, this.#taskPhases(taskId));
  }

  #requireRun(runId: string, agentId: string, taskId: string | null, active: boolean): AgentRun {
    const row = this.#store.db.prepare("SELECT * FROM runs WHERE run_id = ? AND agent_id = ?").get(runId, agentId);
    if (!row) throw new TaskBoardError(404, "RUN_NOT_FOUND", "Run was not found");
    const run = runFromRow(row);
    if (active && run.status !== "active") throw conflict("RUN_NOT_ACTIVE", "Run is no longer active");
    if (taskId !== null) {
      const wake = this.#store.db.prepare("SELECT task_id FROM wakeups WHERE wakeup_id = ?").get(run.wakeupId);
      if (!wake || nullableString(wake, "task_id") !== taskId) throw conflict("RUN_TASK_MISMATCH", "Run is not bound to this task");
    }
    return run;
  }

  #requireActiveRun(agentId: string, taskId: string): AgentRun {
    const row = this.#store.db.prepare("SELECT * FROM runs WHERE agent_id = ? AND status = 'active'").get(agentId);
    if (!row) throw conflict("RUN_NOT_ACTIVE", "Agent has no active run");
    return this.#requireRun(stringValue(row, "run_id"), agentId, taskId, true);
  }

  #assertAssignment(projectId: string, agentId: string, role: AgentRole): void {
    const agent = this.#requireAgent(agentId);
    if (agent.projectId !== projectId) throw conflict("AGENT_PROJECT_MISMATCH", "Assigned agent belongs to another project");
    if (agent.role !== role) throw conflict("AGENT_ROLE_MISMATCH", "Assigned role does not match the fixed agent profile");
  }

  #assertTaskAssignment(task: BoardTask, agentId: string, role: AgentRole): void {
    if (task.kind === "human_check") throw conflict("HUMAN_CHECK_NOT_ASSIGNABLE", "Human checks cannot be assigned to agents");
    if (task.requiredRole !== null && role !== task.requiredRole) {
      throw conflict("TASK_REQUIRED_ROLE_MISMATCH", `This task requires the ${task.requiredRole} role`);
    }
    this.#assertAssignment(task.projectId, agentId, role);
  }

  #createReviewFollowup(parent: BoardTask, now: string): ReviewFollowupResult | null {
    const nextKind: TaskKind | null = parent.kind === "manager_review"
      ? "human_check"
      : parent.kind === "work" && parent.requiresReview && parent.assignedRole === "engineer"
        ? "manager_review"
        : null;
    if (nextKind === null) return null;
    let source = parent;
    if (nextKind === "human_check") {
      if (parent.parentTaskId === null) return null;
      source = this.#requireTask(parent.parentTaskId);
      if (source.kind !== "work" || !source.requiresReview) return null;
    }
    const existing = this.#store.db.prepare(`
      SELECT task_id FROM tasks WHERE parent_task_id = ? AND task_kind = ? LIMIT 1
    `).get(parent.taskId, nextKind);
    if (existing) return Object.freeze({ taskId: stringValue(existing, "task_id"), wakeAgentId: null });

    const taskId = randomUUID();
    const requiredRole: AgentRole | null = nextKind === "manager_review" ? "manager" : null;
    const managers = nextKind === "manager_review"
      ? this.#store.db.prepare(`
          SELECT agent_id FROM agents
          WHERE project_id = ? AND role = 'manager'
          ORDER BY created_at, agent_id
          LIMIT 2
        `).all(parent.projectId)
      : [];
    const assignedAgentId = managers.length === 1 ? stringValue(managers[0]!, "agent_id") : null;
    const assignedRole: AgentRole | null = assignedAgentId === null ? null : "manager";
    const status: TaskStatus = assignedAgentId === null ? "backlog" : "queued";
    const titlePrefix = nextKind === "manager_review" ? "Manager review: " : "Human check: ";
    const title = `${titlePrefix}${source.title}`.slice(0, 240).trimEnd();
    const objective = (nextKind === "manager_review"
      ? `Review the completed engineer work and its evidence for this outcome: ${source.objective}`
      : `Decide whether the reviewed work is ready for the next human-controlled release step: ${source.objective}`)
      .slice(0, 4_000)
      .trimEnd();
    const acceptanceCriteria = nextKind === "manager_review"
      ? "Inspect the completed work, test evidence, result, and risks; record a clear recommendation for a human."
      : "A human records the final decision and rationale. This task cannot be assigned to or completed by an agent.";
    const orderKey = this.#nextTaskOrderKey();
    this.#store.db.prepare(`
      INSERT INTO tasks(
        task_id, project_id, parent_task_id, task_kind, required_role, requires_review,
        title, objective, acceptance_criteria, workspace_refs_json,
        status, assigned_agent_id, assigned_role, expected_agent_minutes, agent_estimate_minutes,
        estimate_recorded_at, order_key, started_at, ended_at,
        result, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 15, NULL, NULL, ?, NULL, NULL, NULL, 1, ?, ?)
    `).run(
      taskId,
      parent.projectId,
      parent.taskId,
      nextKind,
      requiredRole,
      title,
      objective,
      acceptanceCriteria,
      canonicalJson(parent.workspaceRefs),
      status,
      assignedAgentId,
      assignedRole,
      orderKey,
      now,
      now,
    );
    this.#insertEvent(parent.projectId, taskId, { type: "system", id: REVIEW_WORKFLOW_ACTOR }, "task_created", {
      kind: nextKind,
      requiredRole,
      requiresReview: false,
      parentTaskId: parent.taskId,
      status,
      assignedAgentId,
      expectedAgentMinutes: null,
      orderKey,
    }, now);
    this.#insertEvent(parent.projectId, parent.taskId, { type: "system", id: REVIEW_WORKFLOW_ACTOR }, "review_followup_created", {
      childTaskId: taskId,
      childKind: nextKind,
      childRequiredRole: requiredRole,
      childAssignedAgentId: assignedAgentId,
    }, now);
    if (assignedAgentId !== null) {
      this.#insertWakeup(
        parent.projectId,
        assignedAgentId,
        "workflow_handoff",
        `manager-review:${parent.taskId}:${taskId}`,
        taskId,
        null,
        `Review completed engineer task: ${source.title}`,
        now,
        REVIEW_WORKFLOW_ACTOR,
      );
    }
    return Object.freeze({ taskId, wakeAgentId: assignedAgentId });
  }

  #retireWakeup(
    row: Row,
    task: BoardTask | null,
    retirementReason: string,
    now: string,
    supersededByWakeupId: string | null = null,
  ): void {
    const wakeup = wakeupFromRow(row);
    const eventId = retiredWakeupEventId(wakeup.wakeupId);
    if (this.#store.db.prepare("SELECT 1 FROM task_events WHERE event_id = ?").get(eventId)) return;
    this.#store.db.prepare(`
      INSERT INTO task_events(
        event_id, project_id, task_id, actor_type, actor_id, event_type, data_json, created_at
      ) VALUES (?, ?, ?, 'system', 'steward:wakeup-retirement', 'agent_wakeup_retired', ?, ?)
    `).run(
      eventId,
      wakeup.projectId,
      task === null ? null : wakeup.taskId,
      canonicalJson({
        agentId: wakeup.agentId,
        assignedAgentId: task?.assignedAgentId ?? null,
        retirementReason,
        supersededByWakeupId,
        taskStatus: task?.status ?? null,
        wakeReason: wakeup.reason,
        wakeupId: wakeup.wakeupId,
      }),
      now,
    );
  }

  #retirePendingWakeupsForTask(taskId: string, retirementReason: string, now: string): void {
    const task = this.#requireTask(taskId);
    const rows = this.#store.db.prepare(`
      SELECT *
      FROM wakeups AS wakeup
      WHERE wakeup.task_id = ?
        AND wakeup.claimed_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM task_events AS event
          WHERE event.event_id = ? || wakeup.wakeup_id
        )
      ORDER BY wakeup.created_at, wakeup.rowid
    `).all(taskId, RETIRED_WAKEUP_EVENT_PREFIX);
    for (const row of rows) this.#retireWakeup(row, task, retirementReason, now);
  }

  #retireStaleWakeupsForAgent(agentId: string, now: string): void {
    const rows = this.#store.db.prepare(`
      SELECT *
      FROM wakeups AS wakeup
      WHERE wakeup.agent_id = ?
        AND wakeup.claimed_at IS NULL
        AND wakeup.task_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM task_events AS event
          WHERE event.event_id = ? || wakeup.wakeup_id
        )
      ORDER BY wakeup.created_at DESC, wakeup.rowid DESC
    `).all(agentId, RETIRED_WAKEUP_EVENT_PREFIX);
    const preferredByTask = new Map<string, { wakeupId: string; isHumanAnswer: boolean }>();
    for (const row of rows) {
      const wakeup = wakeupFromRow(row);
      if (wakeup.taskId === null) continue;
      const preferred = preferredByTask.get(wakeup.taskId);
      if (preferred === undefined || (!preferred.isHumanAnswer && wakeup.reason === "human_answer")) {
        preferredByTask.set(wakeup.taskId, {
          wakeupId: wakeup.wakeupId,
          isHumanAnswer: wakeup.reason === "human_answer",
        });
      }
    }
    for (const row of rows) {
      const wakeup = wakeupFromRow(row);
      if (wakeup.taskId === null) continue;
      const taskRow = this.#store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(wakeup.taskId);
      const task = taskRow === undefined ? null : this.#requireTask(stringValue(taskRow, "task_id"));
      const preferredWakeupId = preferredByTask.get(wakeup.taskId)?.wakeupId ?? wakeup.wakeupId;
      const supersededByWakeupId = preferredWakeupId === wakeup.wakeupId ? null : preferredWakeupId;
      let retirementReason: string | null = null;
      if (supersededByWakeupId !== null) retirementReason = "superseded_by_preferred_wakeup";
      else if (task === null) retirementReason = "task_missing";
      else if (task.projectId !== wakeup.projectId) retirementReason = "task_project_changed";
      else {
        if (wakeup.reason === "workflow_handoff") {
          const sourceRow = task.parentTaskId === null
            ? undefined
            : this.#store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(task.parentTaskId);
          const source = sourceRow === undefined ? null : this.#requireTask(stringValue(sourceRow, "task_id"));
          if (
            task.kind !== "manager_review" || task.requiredRole !== "manager" ||
            source === null || source.kind !== "work" || !source.requiresReview ||
            source.status !== "completed" || source.endedAt === null || source.result === null
          ) {
            retirementReason = "workflow_handoff_scope_invalid";
          }
        }
        if (retirementReason === null) {
          if (task.status === "cancelled") retirementReason = "task_cancelled";
          else if (
            task.endedAt !== null ||
            task.status === "completed" ||
            task.status === "failed"
          ) {
            retirementReason = "task_terminal";
          } else if (task.assignedAgentId === null) retirementReason = "task_unassigned";
          else if (task.assignedAgentId !== agentId) retirementReason = "task_reassigned";
          else if (task.status !== "queued" && task.status !== "blocked") retirementReason = "task_not_runnable";
        }
      }
      if (retirementReason === null) continue;
      this.#retireWakeup(row, task, retirementReason, now, supersededByWakeupId);
    }
  }

  #insertWakeup(
    projectId: string,
    agentId: string,
    reason: Wakeup["reason"],
    sourceKey: string,
    taskId: string | null,
    questionId: string | null,
    detail: string,
    now: string,
    createdBy = this.#config.humanPrincipal,
  ): string {
    const wakeupId = randomUUID();
    this.#store.db.prepare(`
      INSERT INTO wakeups(
        wakeup_id, project_id, agent_id, reason, source_key, task_id, question_id,
        detail, created_by, created_at, claimed_at, run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      wakeupId,
      projectId,
      agentId,
      reason,
      sourceKey,
      taskId,
      questionId,
      detail,
      createdBy,
      now,
    );
    return wakeupId;
  }

  #insertEvent(
    projectId: string,
    taskId: string | null,
    actor: Actor | Readonly<{ type: "system"; id: string }>,
    eventType: string,
    data: Readonly<Record<string, unknown>>,
    now: string,
  ): void {
    this.#store.db.prepare(`
      INSERT INTO task_events(event_id, project_id, task_id, actor_type, actor_id, event_type, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), projectId, taskId, actor.type, actor.id, eventType, canonicalJson(data), now);
  }
}
