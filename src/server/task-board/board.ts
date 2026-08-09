import {
  TASK_BOARD_API_VERSION,
  type AutomationConfiguration,
  type AgentInterrupt,
  type AgentProfile,
  type AgentRun,
  type AnswerHumanQuestionRequest,
  type BoardSnapshot,
  type BoardTask,
  type ClaimRunRequest,
  type ClaimRunResult,
  type ConfirmPlanRevisionRequest,
  type CreateAgentRequest,
  type CreateDocumentRequest,
  type CreateHumanQuestionRequest,
  type CreateHumanTaskMessageRequest,
  type CreatePlanRevisionRequest,
  type CreateProjectArtifactRequest,
  type CreateProjectRequest,
  type CreateTaskMessageRequest,
  type CreateTaskPhaseRequest,
  type CreateTaskRequest,
  type CreateWorkItemRequest,
  type DocumentEvent,
  type DocumentSnapshot,
  type DocumentSummary,
  type HumanQuestion,
  type InterruptAgentRequest,
  type Project,
  type ProjectArtifact,
  type ProjectEvent,
  type ResumeAgentRequest,
  type RunInterruptBatch,
  type SettleRunRequest,
  type TaskMessage,
  type TaskPhase,
  type UpdateAutomationConfigurationRequest,
  type UpdateDocumentPenRequest,
  type UpdateDocumentRequest,
  type UpdateTaskPhaseRequest,
  type UpdateTaskRequest,
  type UpdateWorkItemRequest,
  type Wakeup,
  type WorkItem,
  type WorkItemPage,
} from "#shared/task-board-contract";
import { tokenMatches } from "./canonical.js";
import type { TaskBoardConfig } from "./config.js";
import { TaskBoardError } from "./errors.js";
import { AgentsCollaborator } from "./collaborators/agents.js";
import { AutomationCollaborator } from "./collaborators/automation.js";
import { DocumentsCollaborator } from "./collaborators/documents.js";
import { MessagesCollaborator } from "./collaborators/messages.js";
import { ProjectsCollaborator } from "./collaborators/projects.js";
import { RunsCollaborator } from "./collaborators/runs.js";
import { TaskBoardRuntime, type Actor } from "./collaborators/runtime.js";
import { TasksCollaborator } from "./collaborators/tasks.js";
import { WorkItemsCollaborator, type CreateWorkItemResult } from "./collaborators/work-items.js";
import {
  eventFromRow,
  interruptFromRow,
  questionFromRow,
  runFromRow,
  stringValue,
  taskFromRow,
} from "./persistence/rows.js";
import { TaskBoardStore } from "./persistence/store.js";
import type { ProjectWorkflowSnapshot } from "./persistence/workflow.js";

export class TaskBoard {
  readonly #runtime: TaskBoardRuntime;
  readonly #agents: AgentsCollaborator;
  readonly #automation: AutomationCollaborator;
  readonly #documents: DocumentsCollaborator;
  readonly #messages: MessagesCollaborator;
  readonly #projects: ProjectsCollaborator;
  readonly #runs: RunsCollaborator;
  readonly #tasks: TasksCollaborator;
  readonly #workItems: WorkItemsCollaborator;

  private constructor(config: TaskBoardConfig, store: TaskBoardStore) {
    this.#runtime = new TaskBoardRuntime(config, store);
    this.#automation = new AutomationCollaborator(this.#runtime);
    this.#tasks = new TasksCollaborator(this.#runtime);
    this.#projects = new ProjectsCollaborator(this.#runtime, this.#automation, this.#tasks);
    this.#workItems = new WorkItemsCollaborator(this.#runtime, this.#automation, this.#tasks);
    this.#agents = new AgentsCollaborator(this.#runtime, this.#workItems, this.#projects);
    this.#documents = new DocumentsCollaborator(this.#runtime);
    this.#messages = new MessagesCollaborator(this.#runtime);
    this.#runs = new RunsCollaborator(this.#runtime, this.#automation, this.#projects);
  }

  static async open(config: TaskBoardConfig): Promise<TaskBoard> {
    const board = new TaskBoard(config, await TaskBoardStore.open(config.dbPath));
    board.#projects.reconcileWorkflowsBestEffort();
    return board;
  }

  authenticateAgent(token: string | undefined, expectedAgentId?: string): AgentProfile {
    if (token === undefined) throw new TaskBoardError(401, "UNAUTHORIZED", "Agent authentication is required");
    const rows = expectedAgentId === undefined
      ? this.#runtime.store.db.prepare("SELECT * FROM agents").all()
      : this.#runtime.store.db.prepare("SELECT * FROM agents WHERE agent_id = ?").all(expectedAgentId);
    const row = rows.find((candidate) => tokenMatches(stringValue(candidate, "token_hash"), token));
    if (!row) throw new TaskBoardError(401, "UNAUTHORIZED", "Agent authentication is required");
    return this.#runtime.agentFromRow(row);
  }

  listProjects(): readonly Project[] {
    return this.#projects.listProjects();
  }

  proposeWorkflow(request: CreatePlanRevisionRequest): ProjectWorkflowSnapshot {
    return this.#projects.proposeWorkflow(request);
  }

  projectWorkflow(projectId: string): ProjectWorkflowSnapshot {
    return this.#projects.projectWorkflow(projectId);
  }

  reconcileWorkflows(projectId?: string): void {
    this.#projects.reconcileWorkflows(projectId);
  }

  createArtifact(projectId: string, request: CreateProjectArtifactRequest): Promise<ProjectArtifact> {
    return this.#projects.createArtifact(projectId, request);
  }

  listArtifacts(projectId: string): readonly ProjectArtifact[] {
    return this.#projects.listArtifacts(projectId);
  }

  artifactContent(artifactId: string): Promise<{ artifact: ProjectArtifact; bytes: Buffer }> {
    return this.#projects.artifactContent(artifactId);
  }

  listProjectEvents(projectId: string, after = 0): readonly ProjectEvent[] {
    return this.#projects.listProjectEvents(projectId, after);
  }

  subscribeProjectEvents(projectId: string, listener: (event: ProjectEvent) => void): () => void {
    return this.#projects.subscribeProjectEvents(projectId, listener);
  }

  confirmWorkflow(planRevisionId: string, request: ConfirmPlanRevisionRequest): ProjectWorkflowSnapshot {
    return this.#projects.confirmWorkflow(planRevisionId, request);
  }

  getAutomationConfiguration(): AutomationConfiguration {
    return this.#automation.getConfiguration();
  }

  updateAutomationConfiguration(request: UpdateAutomationConfigurationRequest): AutomationConfiguration {
    return this.#automation.updateConfiguration(request);
  }

  listWorkItemsPage(cursor?: string): WorkItemPage {
    return this.#workItems.listWorkItemsPage(cursor);
  }

  listWorkItems(): readonly WorkItem[] {
    return this.#workItems.listWorkItems();
  }

  requireWorkItem(workItemId: string): WorkItem {
    return this.#workItems.requireWorkItem(workItemId);
  }

  createWorkItem(request: CreateWorkItemRequest, idempotencyKey: string): CreateWorkItemResult {
    return this.#workItems.createWorkItem(request, idempotencyKey);
  }

  createWorkItemAndStartPlanning(request: CreateWorkItemRequest, idempotencyKey: string): CreateWorkItemResult {
    return this.#workItems.createWorkItemAndStartPlanning(request, idempotencyKey);
  }

  startWorkItemPlanning(workItemId: string): BoardTask | null {
    return this.#workItems.startWorkItemPlanning(workItemId);
  }

  updateWorkItem(workItemId: string, request: UpdateWorkItemRequest): WorkItem {
    return this.#workItems.updateWorkItem(workItemId, request);
  }

  createProject(request: CreateProjectRequest): Project {
    return this.#projects.createProject(request);
  }

  createDocument(projectId: string, request: CreateDocumentRequest): DocumentSnapshot {
    return this.#documents.createDocument(projectId, request);
  }

  listDocuments(projectId: string): readonly DocumentSummary[] {
    return this.#documents.listDocuments(projectId);
  }

  getDocument(documentId: string): DocumentSnapshot {
    return this.#documents.getDocument(documentId);
  }

  updateDocumentPen(documentId: string, request: UpdateDocumentPenRequest, actor: Actor): DocumentSnapshot {
    return this.#documents.updateDocumentPen(documentId, request, actor);
  }

  updateDocument(documentId: string, request: UpdateDocumentRequest, actor: Actor): DocumentSnapshot {
    return this.#documents.updateDocument(documentId, request, actor);
  }

  listDocumentEvents(documentId: string, after = 0): readonly DocumentEvent[] {
    return this.#documents.listDocumentEvents(documentId, after);
  }

  subscribeDocumentEvents(documentId: string, listener: (event: DocumentEvent) => void): () => void {
    return this.#documents.subscribeDocumentEvents(documentId, listener);
  }

  createAgent(projectId: string, request: CreateAgentRequest): AgentProfile {
    return this.#agents.createAgent(projectId, request);
  }

  createTask(projectId: string, request: CreateTaskRequest): BoardTask {
    return this.#tasks.createTask(projectId, request);
  }

  updateTask(taskId: string, request: UpdateTaskRequest, actor: Actor): BoardTask {
    return this.#tasks.updateTask(taskId, request, actor);
  }

  createTaskPhase(taskId: string, request: CreateTaskPhaseRequest, agentId: string): TaskPhase {
    return this.#tasks.createTaskPhase(taskId, request, agentId);
  }

  updateTaskPhase(phaseId: string, request: UpdateTaskPhaseRequest, agentId: string): TaskPhase {
    return this.#tasks.updateTaskPhase(phaseId, request, agentId);
  }

  appendAgentMessage(taskId: string, agentId: string, request: CreateTaskMessageRequest): TaskMessage {
    return this.#messages.appendAgentMessage(taskId, agentId, request);
  }

  appendHumanMessage(taskId: string, request: CreateHumanTaskMessageRequest): TaskMessage {
    return this.#messages.appendHumanMessage(taskId, request);
  }

  askQuestion(taskId: string, agentId: string, request: CreateHumanQuestionRequest): HumanQuestion {
    return this.#messages.askQuestion(taskId, agentId, request);
  }

  answerQuestion(questionId: string, request: AnswerHumanQuestionRequest): { question: HumanQuestion; wakeup: Wakeup; duplicate: boolean } {
    return this.#messages.answerQuestion(questionId, request);
  }

  resumeAgent(agentId: string, request: ResumeAgentRequest, idempotencyKey: string): { wakeup: Wakeup; duplicate: boolean } {
    return this.#runs.resumeAgent(agentId, request, idempotencyKey);
  }

  interruptAgent(
    agentId: string,
    request: InterruptAgentRequest,
    idempotencyKey: string,
  ): { interrupt: AgentInterrupt; duplicate: boolean } {
    return this.#runs.interruptAgent(agentId, request, idempotencyKey);
  }

  async waitForRunInterrupts(
    runId: string,
    agentId: string,
    after: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<RunInterruptBatch | null> {
    return this.#runs.waitForRunInterrupts(runId, agentId, after, waitMs, signal);
  }

  claimRun(agentId: string, request: ClaimRunRequest): ClaimRunResult | null {
    return this.#runs.claimRun(agentId, request);
  }

  async waitToClaimRun(
    agentId: string,
    request: ClaimRunRequest,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<ClaimRunResult | null> {
    return this.#runs.waitToClaimRun(agentId, request, waitMs, signal);
  }

  settleRun(runId: string, agentId: string, request: SettleRunRequest): { run: AgentRun; duplicate: boolean } {
    return this.#runs.settleRun(runId, agentId, request);
  }

  snapshot(projectId: string): BoardSnapshot {
    const project = this.#runtime.requireProject(projectId);
    return Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      project,
      agents: Object.freeze(this.#runtime.store.db.prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY created_at, agent_id").all(projectId).map((row) => this.#runtime.agentFromRow(row))),
      tasks: Object.freeze(this.#runtime.store.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY order_key, task_id").all(projectId).map((row) => {
        const taskId = stringValue(row, "task_id");
        return taskFromRow(row, this.#runtime.taskPhases(taskId));
      })),
      openQuestions: Object.freeze(this.#runtime.store.db.prepare("SELECT * FROM questions WHERE project_id = ? AND status = 'open' ORDER BY asked_at, question_id").all(projectId).map(questionFromRow)),
      recentQuestions: Object.freeze(this.#runtime.store.db.prepare("SELECT * FROM questions WHERE project_id = ? ORDER BY asked_at DESC, question_id DESC LIMIT 100").all(projectId).map(questionFromRow)),
      recentRuns: Object.freeze(this.#runtime.store.db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC, run_id DESC LIMIT 100").all(projectId).map(runFromRow)),
      recentInterrupts: Object.freeze(this.#runtime.store.db.prepare("SELECT * FROM interrupts WHERE project_id = ? ORDER BY sequence DESC LIMIT 100").all(projectId).map(interruptFromRow)),
      recentEvents: Object.freeze(this.#runtime.store.db.prepare("SELECT * FROM task_events WHERE project_id = ? ORDER BY sequence DESC LIMIT 200").all(projectId).map(eventFromRow)),
      documents: this.#documents.listDocuments(projectId),
    });
  }

  listMessages(taskId: string, after = 0): readonly TaskMessage[] {
    return this.#messages.listMessages(taskId, after);
  }

  requireTask(taskId: string): BoardTask {
    return this.#tasks.requireTask(taskId);
  }

  close(): void {
    this.#runtime.close();
    this.#runtime.store.close();
  }
}
