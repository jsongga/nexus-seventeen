import {
  TASK_BOARD_API_VERSION,
  TASK_BOARD_ERROR_CODES,
  type AutomationConfiguration,
  type AgentInterrupt,
  type AgentProfile,
  type AgentRun,
  type ApprovePipelineMergeRequest,
  type AttestDeployRequest,
  type AttestDeployResult,
  type AnswerHumanQuestionRequest,
  type BacklogTaskRequest,
  type BacklogTaskResponse,
  type BoardNotification,
  type BoardPause,
  type BoardSnapshot,
  type BoardTask,
  type ChildWorkItem,
  type ClaimRunRequest,
  type ClaimRunResponse,
  type ClaimRunResult,
  type ConfirmPlanRevisionRequest,
  type CreateAgentRequest,
  type CreateHumanQuestionRequest,
  type CreateHumanTaskMessageRequest,
  type CreatePlanRevisionRequest,
  type CreateProjectArtifactRequest,
  type CreateProjectRequest,
  type UpdateProjectRequest,
  type CreateTaskMessageRequest,
  type CreateTaskPhaseRequest,
  type CreateTaskRequest,
  type CreateWorkItemRequest,
  type FindingsLedger,
  type HumanQuestion,
  type InterruptAgentRequest,
  type ParentCompletion,
  type Project,
  type ProjectArtifact,
  type ProjectEvent,
  type PipelineSummary,
  type ParksLedger,
  type RejectFinalApprovalRequest,
  type RejectPlanRevisionRequest,
  type RejectPlanRevisionResponse,
  type RetryTaskRequest,
  type RetryTaskResponse,
  type RotateAgentTokenResponse,
  type ResumeAgentRequest,
  type RunInterruptBatch,
  type SettleRunRequest,
  type TaskMessage,
  type TaskPhase,
  type UpdateAutomationConfigurationRequest,
  type UpdateTaskPhaseRequest,
  type UpdateTaskRequest,
  type UpdateWorkItemRequest,
  type Wakeup,
  type WorkItem,
  type WorkItemAudit,
  type WorkItemDependency,
  type WorkItemPage,
} from "#shared/task-board-contract";
import { tokenMatches } from "./canonical.js";
import type { TaskBoardConfig } from "./config.js";
import { TaskBoardError } from "./errors.js";
import { AgentsCollaborator } from "./collaborators/agents.js";
import { AutomationCollaborator } from "./collaborators/automation.js";
import { BoardPauseCollaborator } from "./collaborators/board-pause.js";
import { BaseBranchPollCollaborator, type BaseBranchSweepResult } from "./collaborators/base-branch-poll.js";
import { LedgersCollaborator } from "./collaborators/ledgers.js";
import { MessagesCollaborator } from "./collaborators/messages.js";
import {
  NotificationsCollaborator,
  type NotificationDeliveryAdapter,
  type NotificationList,
} from "./collaborators/notifications.js";
import { ParkLifecycleCollaborator, type ParkLifecycleSweepResult } from "./collaborators/park-lifecycle.js";
import { ProjectsCollaborator, type PipelineMergeExecutor } from "./collaborators/projects.js";
import { RunsCollaborator, type SettlementActor, type SuspendAllActiveRunsResult } from "./collaborators/runs.js";
import { TaskBoardRuntime, type Actor } from "./collaborators/runtime.js";
import type { GitRunner } from "./collaborators/scope-check.js";
import { TasksCollaborator } from "./collaborators/tasks.js";
import { WallClockCollaborator, type WallClockSweepResult } from "./collaborators/wall-clock.js";
import { WorkItemsCollaborator, type CreateWorkItemResult, type WorkItemDetail } from "./collaborators/work-items.js";
import {
  eventFromRow,
  interruptFromRow,
  questionFromRow,
  runFromRow,
  stringValue,
  taskFromRow,
} from "./persistence/rows.js";
import { TaskBoardStore } from "./persistence/store.js";
import { PENDING_LIVE_WAKEUP_PREDICATE_SQL, RETIRED_WAKEUP_EVENT_PREFIX } from "./persistence/workflow.js";
import type { ProjectWorkflowSnapshot } from "./persistence/workflow.js";
import type { ConfirmWorkflowResult } from "./collaborators/projects.js";

export interface TaskBoardDependencies {
  readonly mergePipeline?: PipelineMergeExecutor;
  readonly git?: GitRunner;
  readonly notificationDelivery?: NotificationDeliveryAdapter;
}

export class TaskBoard {
  readonly #runtime: TaskBoardRuntime;
  readonly #agents: AgentsCollaborator;
  readonly #automation: AutomationCollaborator;
  readonly #baseBranchPoll: BaseBranchPollCollaborator;
  readonly #boardPause: BoardPauseCollaborator;
  readonly #ledgers: LedgersCollaborator;
  readonly #messages: MessagesCollaborator;
  readonly #notifications: NotificationsCollaborator;
  readonly #parkLifecycle: ParkLifecycleCollaborator;
  readonly #projects: ProjectsCollaborator;
  readonly #runs: RunsCollaborator;
  readonly #tasks: TasksCollaborator;
  readonly #wallClock: WallClockCollaborator;
  readonly #workItems: WorkItemsCollaborator;

  private constructor(config: TaskBoardConfig, store: TaskBoardStore, dependencies: TaskBoardDependencies) {
    this.#runtime = new TaskBoardRuntime(config, store);
    this.#boardPause = new BoardPauseCollaborator(this.#runtime);
    this.#ledgers = new LedgersCollaborator(this.#runtime);
    this.#notifications = new NotificationsCollaborator(this.#runtime, dependencies.notificationDelivery);
    this.#automation = new AutomationCollaborator(this.#runtime);
    this.#tasks = new TasksCollaborator(this.#runtime);
    const reconcileProjectWorkflows = (projectId: string) => {
      this.#projects.reconcileWorkflowsBestEffort(projectId);
    };
    this.#workItems = new WorkItemsCollaborator(
      this.#runtime,
      this.#automation,
      this.#tasks,
      reconcileProjectWorkflows,
      this.#notifications
    );
    this.#projects = new ProjectsCollaborator(
      this.#runtime,
      this.#automation,
      this.#tasks,
      dependencies.git,
      {},
      dependencies.mergePipeline,
      this.#notifications,
      this.#boardPause
    );
    this.#projects.setStartDesignInTransaction((workItemId) => {
      const task = this.#workItems.startWorkItemDesignInTransaction(workItemId);
      if (task === null) {
        throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.PLANNING_UNAVAILABLE, "A design manager is unavailable");
      }
    });
    this.#parkLifecycle = new ParkLifecycleCollaborator(
      this.#runtime,
      this.#notifications,
      this.#workItems,
      reconcileProjectWorkflows
    );
    this.#baseBranchPoll = new BaseBranchPollCollaborator(this.#runtime, this.#projects, dependencies.git);
    this.#runs = new RunsCollaborator(
      this.#runtime,
      this.#automation,
      this.#projects,
      this.#tasks,
      dependencies.git,
      this.#boardPause
    );
    this.#workItems.setSuspendActiveRunInTransaction((runId, reason, actor, now, options) =>
      this.#runs.suspendActiveRunInTransaction(runId, reason, actor, now, options)
    );
    this.#wallClock = new WallClockCollaborator(this.#runtime, this.#runs, this.#notifications);
    this.#agents = new AgentsCollaborator(this.#runtime, this.#workItems, this.#projects, this.#runs);
    this.#messages = new MessagesCollaborator(this.#runtime);
  }

  static async open(config: TaskBoardConfig, dependencies: TaskBoardDependencies = {}): Promise<TaskBoard> {
    const board = new TaskBoard(config, await TaskBoardStore.open(config.dbPath), dependencies);
    board.#runs.reconcileStaleRuns();
    board.#projects.reconcileWorkflowsBestEffort();
    return board;
  }

  authenticateAgent(token: string | undefined, expectedAgentId?: string): AgentProfile {
    if (token === undefined) throw new TaskBoardError(401, "UNAUTHORIZED", "Agent authentication is required");
    const rows =
      expectedAgentId === undefined
        ? this.#runtime.store.db.prepare("SELECT * FROM agents").all()
        : this.#runtime.store.db.prepare("SELECT * FROM agents WHERE agent_id = ?").all(expectedAgentId);
    const row = rows.find((candidate) => tokenMatches(stringValue(candidate, "token_hash"), token));
    if (!row) throw new TaskBoardError(401, "UNAUTHORIZED", "Agent authentication is required");
    return this.#runtime.agentFromRow(row);
  }

  assertAgentCredentialVersion(agentId: string, credentialVersion: number): void {
    this.#runtime.requireAgentCredentialVersion(agentId, credentialVersion);
  }

  listProjects(): readonly Project[] {
    return this.#projects.listProjects();
  }

  proposeWorkflow(request: CreatePlanRevisionRequest): ProjectWorkflowSnapshot {
    if (this.#workItems.requireWorkItem(request.workItemId).state === "queued") {
      // Direct proposals are test-only (there is no HTTP route), so this bootstrap's separate commit is accepted.
      this.#workItems.startWorkItemPlanning(request.workItemId);
    }
    return this.#projects.proposeWorkflow(request);
  }

  projectWorkflow(projectId: string): ProjectWorkflowSnapshot {
    return this.#projects.projectWorkflow(projectId);
  }

  reconcileWorkflows(projectId?: string): void {
    this.#projects.reconcileWorkflows(projectId);
  }

  reconcileWorkflowsBestEffort(projectId?: string): void {
    this.#projects.reconcileWorkflowsBestEffort(projectId);
  }

  getBoardPause(): BoardPause {
    return this.#boardPause.getBoardPause();
  }

  setBoardPause(input: { paused: boolean; reason: string | null; version: number; actor: string }): BoardPause {
    return this.#boardPause.setBoardPause(input);
  }

  isBoardPaused(): boolean {
    return this.#boardPause.isBoardPaused();
  }

  suspendAllActiveRuns(reason: string, actor: SettlementActor): SuspendAllActiveRunsResult {
    return this.#runs.suspendAllActiveRuns(reason, actor);
  }

  resumePausedWork(): void {
    const agentIds = this.#runtime.store.db
      .prepare(
        `
      SELECT DISTINCT wakeup.agent_id
      FROM wakeups AS wakeup
      WHERE ${PENDING_LIVE_WAKEUP_PREDICATE_SQL}
      ORDER BY wakeup.agent_id
    `
      )
      .all(RETIRED_WAKEUP_EVENT_PREFIX)
      .map((row) => stringValue(row, "agent_id"));
    for (const agentId of agentIds) this.#runtime.wakeupEvents.emit(agentId);
    this.#projects.reconcileWorkflowsBestEffort();
  }

  sweepVerifyAttempts(): Promise<number> {
    return this.#projects.sweepVerifyAttempts();
  }

  sweepParkLifecycle(now: string): ParkLifecycleSweepResult {
    return this.#parkLifecycle.sweepParkLifecycle(now);
  }

  sweepWallClockCaps(now: string): WallClockSweepResult {
    return this.#wallClock.sweepWallClockCaps(now);
  }

  sweepBaseBranch(now: string): BaseBranchSweepResult {
    return this.#baseBranchPoll.sweepBaseBranch(now);
  }

  listNotifications(): NotificationList {
    return this.#notifications.listNotifications();
  }

  findingsLedger(projectId?: string): FindingsLedger {
    return this.#ledgers.findingsLedger(projectId);
  }

  parksLedger(): ParksLedger {
    return this.#ledgers.parksLedger();
  }

  markNotificationRead(notificationId: string, version: number): BoardNotification {
    return this.#notifications.markNotificationRead(notificationId, version);
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

  confirmWorkflow(planRevisionId: string, request: ConfirmPlanRevisionRequest): ConfirmWorkflowResult {
    return this.#projects.confirmWorkflow(planRevisionId, request, (workItemId) => {
      const task = this.#workItems.startWorkItemDesignInTransaction(workItemId);
      if (task === null) {
        throw new TaskBoardError(409, TASK_BOARD_ERROR_CODES.PLANNING_UNAVAILABLE, "A design manager is unavailable");
      }
    });
  }

  rejectWorkflowPlan(planRevisionId: string, request: RejectPlanRevisionRequest): RejectPlanRevisionResponse {
    let wakeAgentId: string | null = null;
    const result = this.#runtime.store.transaction(() => {
      const rejected = this.#projects.rejectWorkflowInTransaction(planRevisionId, request);
      if (rejected.outcome === "revising") {
        const planning = this.#workItems.startWorkItemPlanningRevisionInTransaction(rejected.workItemId, request.note);
        if (planning.task === null || planning.wakeAgentId === null) {
          throw new TaskBoardError(
            409,
            TASK_BOARD_ERROR_CODES.PLANNING_UNAVAILABLE,
            "A planning manager is unavailable"
          );
        }
        wakeAgentId = planning.wakeAgentId;
      }
      return Object.freeze({ outcome: rejected.outcome });
    });
    if (wakeAgentId !== null) this.#runtime.wakeupEvents.emit(wakeAgentId);
    return result;
  }

  pipelineSummary(workItemId: string): PipelineSummary {
    return this.#projects.pipelineSummary(workItemId);
  }

  async approvePipelineMerge(workItemId: string, request: ApprovePipelineMergeRequest): Promise<WorkItemDetail> {
    await this.#projects.approvePipelineMerge(workItemId, request);
    return this.#workItems.requireWorkItem(workItemId);
  }

  async rejectFinalApproval(workItemId: string, request: RejectFinalApprovalRequest): Promise<WorkItemDetail> {
    await this.#projects.rejectFinalApproval(workItemId, request);
    return this.#workItems.requireWorkItem(workItemId);
  }

  resumeWorkItem(workItemId: string): WorkItemDetail {
    if (!this.#projects.resumeBaseDivergedWorkItem(workItemId)) {
      this.#workItems.resumeDecomposedParent(workItemId);
    }
    return this.#workItems.requireWorkItem(workItemId);
  }

  getAutomationConfiguration(): AutomationConfiguration {
    return this.#automation.getConfiguration();
  }

  updateAutomationConfiguration(request: UpdateAutomationConfigurationRequest): AutomationConfiguration {
    const configuration = this.#automation.updateConfiguration(request);
    this.#projects.reconcileWorkflowsBestEffort();
    return configuration;
  }

  listWorkItemsPage(cursor?: string, includeArchived = false): WorkItemPage {
    return this.#workItems.listWorkItemsPage(cursor, includeArchived);
  }

  listWorkItems(includeArchived = false): readonly WorkItem[] {
    return this.#workItems.listWorkItems(includeArchived);
  }

  listChildren(parentWorkItemId: string): readonly ChildWorkItem[] {
    return this.#workItems.listChildren(parentWorkItemId);
  }

  parentCompletion(parentWorkItemId: string): ParentCompletion {
    return this.#workItems.parentCompletion(parentWorkItemId);
  }

  attestDeploy(workItemId: string, request: AttestDeployRequest): AttestDeployResult {
    return this.#workItems.attestDeploy(workItemId, request);
  }

  dependenciesFor(workItemId: string): readonly WorkItemDependency[] {
    return this.#workItems.dependenciesFor(workItemId);
  }

  requireWorkItem(workItemId: string): WorkItemDetail {
    return this.#workItems.requireWorkItem(workItemId);
  }

  workItemAudit(workItemId: string): WorkItemAudit {
    return this.#workItems.workItemAudit(workItemId);
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

  updateProject(projectId: string, request: UpdateProjectRequest): Project {
    return this.#projects.updateProject(projectId, request);
  }

  createAgent(projectId: string, request: CreateAgentRequest): AgentProfile {
    return this.#agents.createAgent(projectId, request);
  }

  rotateAgentToken(agentId: string, version: number): RotateAgentTokenResponse {
    return this.#agents.rotateToken(agentId, version);
  }

  setAgentLaneError(agentId: string, detail: string | null): void {
    this.#agents.setLaneError(agentId, detail);
  }

  createTask(projectId: string, request: CreateTaskRequest): BoardTask {
    return this.#tasks.createTask(projectId, request);
  }

  updateTask(taskId: string, request: UpdateTaskRequest, actor: Actor): BoardTask {
    return this.#tasks.updateTask(taskId, request, actor);
  }

  retryTask(taskId: string, request: RetryTaskRequest): RetryTaskResponse {
    return this.#tasks.retryTask(taskId, request);
  }

  backlogTask(taskId: string, request: BacklogTaskRequest): BacklogTaskResponse {
    return this.#tasks.backlogTask(taskId, request);
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

  answerQuestion(
    questionId: string,
    request: AnswerHumanQuestionRequest
  ): { question: HumanQuestion; wakeup: Wakeup; duplicate: boolean } {
    return this.#messages.answerQuestion(questionId, request);
  }

  resumeAgent(
    agentId: string,
    request: ResumeAgentRequest,
    idempotencyKey: string
  ): { wakeup: Wakeup; duplicate: boolean } {
    return this.#runs.resumeAgent(agentId, request, idempotencyKey);
  }

  interruptAgent(
    agentId: string,
    request: InterruptAgentRequest,
    idempotencyKey: string
  ): { interrupt: AgentInterrupt; duplicate: boolean } {
    return this.#runs.interruptAgent(agentId, request, idempotencyKey);
  }

  async waitForRunInterrupts(
    runId: string,
    agentId: string,
    after: number,
    waitMs: number,
    signal: AbortSignal,
    credentialVersion?: number
  ): Promise<RunInterruptBatch | null> {
    return this.#runs.waitForRunInterrupts(runId, agentId, after, waitMs, signal, credentialVersion);
  }

  claimRun(agentId: string, request: ClaimRunRequest, credentialVersion?: number): ClaimRunResult | null {
    const result = this.#runs.claimRun(agentId, request, credentialVersion);
    return result !== null && "paused" in result ? null : result;
  }

  async waitToClaimRun(
    agentId: string,
    request: ClaimRunRequest,
    waitMs: number,
    signal: AbortSignal,
    credentialVersion?: number
  ): Promise<ClaimRunResult | null> {
    const result = await this.#runs.waitToClaimRun(agentId, request, waitMs, signal, credentialVersion);
    return result !== null && "paused" in result ? null : result;
  }

  waitToClaimRunWithHold(
    agentId: string,
    request: ClaimRunRequest,
    waitMs: number,
    signal: AbortSignal,
    credentialVersion?: number
  ): Promise<ClaimRunResponse | null> {
    return this.#runs.waitToClaimRun(agentId, request, waitMs, signal, credentialVersion);
  }

  heartbeatRun(runId: string, agentAuth: Pick<AgentProfile, "agentId" | "version">): AgentRun {
    return this.#runs.heartbeatRun(runId, agentAuth.agentId, agentAuth.version);
  }

  reconcileStaleRuns(): number {
    return this.#runs.reconcileStaleRuns();
  }

  settleRun(runId: string, agentId: string, request: SettleRunRequest): { run: AgentRun; duplicate: boolean } {
    return this.#runs.settleRun(runId, agentId, request);
  }

  snapshot(projectId: string): BoardSnapshot {
    const project = this.#runtime.requireProject(projectId);
    return Object.freeze({
      apiVersion: TASK_BOARD_API_VERSION,
      project,
      agents: Object.freeze(
        this.#runtime.store.db
          .prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY created_at, agent_id")
          .all(projectId)
          .map((row) => this.#runtime.agentFromRow(row))
      ),
      tasks: Object.freeze(
        this.#runtime.store.db
          .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY order_key, task_id")
          .all(projectId)
          .map((row) => {
            const taskId = stringValue(row, "task_id");
            return taskFromRow(row, this.#runtime.taskPhases(taskId));
          })
      ),
      openQuestions: Object.freeze(
        this.#runtime.store.db
          .prepare("SELECT * FROM questions WHERE project_id = ? AND status = 'open' ORDER BY asked_at, question_id")
          .all(projectId)
          .map(questionFromRow)
      ),
      recentQuestions: Object.freeze(
        this.#runtime.store.db
          .prepare("SELECT * FROM questions WHERE project_id = ? ORDER BY asked_at DESC, question_id DESC LIMIT 100")
          .all(projectId)
          .map(questionFromRow)
      ),
      recentRuns: Object.freeze(
        this.#runtime.store.db
          .prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC, run_id DESC LIMIT 100")
          .all(projectId)
          .map(runFromRow)
      ),
      recentInterrupts: Object.freeze(
        this.#runtime.store.db
          .prepare("SELECT * FROM interrupts WHERE project_id = ? ORDER BY sequence DESC LIMIT 100")
          .all(projectId)
          .map(interruptFromRow)
      ),
      recentEvents: Object.freeze(
        this.#runtime.store.db
          .prepare("SELECT * FROM task_events WHERE project_id = ? ORDER BY sequence DESC LIMIT 200")
          .all(projectId)
          .map(eventFromRow)
      ),
    });
  }

  listMessages(taskId: string, after = 0): readonly TaskMessage[] {
    return this.#messages.listMessages(taskId, after);
  }

  requireTask(taskId: string): BoardTask {
    return this.#tasks.requireTask(taskId);
  }

  close(): void {
    this.#projects.close();
    this.#runtime.close();
    this.#runtime.store.close();
  }
}
