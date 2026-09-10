/** Provides the validated browser client for task-board HTTP and event-stream APIs. */

/* —— Imports —— */

import type {
  CreateRepositoryRequest,
  PipelineSummary,
  RejectPlanRevisionResponse,
  UpdateRepositoryRequest,
} from "@shared/task-board-contract";
import type {
  AgentQueryConversationTurn,
  AgentRole,
  AutomationConfiguration,
  BoardChildWorkItem,
  BoardProject,
  BoardRepository,
  BoardSnapshot,
  BoardWorkItemDependency,
  BoardWorkItemDetail,
  CreateProjectInput,
  UpdateProjectInput,
  CreateTaskInput,
  CreateWorkItemInput,
  DeployAttestationResult,
  HostDirectoryListing,
  HostProjectRoot,
  ProjectArtifact,
  ProjectWorkflow,
  RotateAgentTokenResult,
  SaveAutomationConfigurationInput,
  WorkflowEvent,
} from "../types";
import { parseRecord } from "./parse/scalars";
import type {
  RawBoardNotification,
  RawBoardPause,
  RawFindingsLedger,
  RawParksLedger,
  RawWorkItemAudit,
} from "./parse/types";
import type { InterruptRunResult } from "./client/envelopes";
import { createAgentMethods } from "./client/agents";
import { createAutomationMethods } from "./client/automation";
import { createBoardMethods } from "./client/board";
import { type TaskBoardClientContext } from "./client/context";
import { createProjectMethods } from "./client/projects";
import { createTaskMethods } from "./client/tasks";
import { createWorkItemMethods } from "./client/work-items";

/* —— Moved modules —— */

// These moved out of this file but stay part of its public surface, so no
// caller has to know where they went.
export {
  agentQueryConversationContextMarker,
  agentQueryPromptFromObjective,
  agentQueryRoutingContextMarker,
} from "./client/agent-query";
export { parseBoardSnapshot, type InterruptRunResult } from "./client/envelopes";
export { randomUuid } from "./client/tasks";

/* —— Public client contract —— */

export class BoardApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null
  ) {
    super(message);
    this.name = "BoardApiError";
  }
}

export interface BoardNotifications {
  unread: RawBoardNotification[];
  recentRead: RawBoardNotification[];
}

export interface TaskBoardClient {
  getSnapshot(signal?: AbortSignal, requestMarker?: "foreground" | "poll" | "mutation"): Promise<BoardSnapshot>;
  getBoardPause(signal?: AbortSignal): Promise<RawBoardPause>;
  setBoardPause(input: { reason: string | null; version: number }): Promise<RawBoardPause>;
  resumeBoard(input: { version: number }): Promise<RawBoardPause>;
  getFindingsLedger(projectId?: string, signal?: AbortSignal): Promise<RawFindingsLedger>;
  getParksLedger(signal?: AbortSignal): Promise<RawParksLedger>;
  getNotifications(signal?: AbortSignal): Promise<BoardNotifications>;
  markNotificationRead(notificationId: string, version: number): Promise<RawBoardNotification>;
  getWorkItemAudit(workItemId: string, signal?: AbortSignal): Promise<RawWorkItemAudit>;
  getWorkItem(workItemId: string, signal?: AbortSignal): Promise<BoardWorkItemDetail>;
  getWorkItemChildren(parentWorkItemId: string, signal?: AbortSignal): Promise<BoardChildWorkItem[]>;
  getWorkItemDependencies(workItemId: string, signal?: AbortSignal): Promise<BoardWorkItemDependency[]>;
  getAutomationConfiguration(signal?: AbortSignal): Promise<AutomationConfiguration>;
  saveAutomationConfiguration(input: SaveAutomationConfigurationInput): Promise<AutomationConfiguration>;
  createProject(input: CreateProjectInput): Promise<BoardProject>;
  updateProject(projectId: string, input: UpdateProjectInput): Promise<BoardProject>;
  addRepository(projectId: string, input: CreateRepositoryRequest): Promise<BoardRepository>;
  updateRepository(repositoryId: string, input: UpdateRepositoryRequest): Promise<BoardRepository>;
  getHostProjectRoots(signal?: AbortSignal): Promise<HostProjectRoot[]>;
  getHostDirectories(path?: string, signal?: AbortSignal): Promise<HostDirectoryListing>;
  createWorkItem(input: CreateWorkItemInput): Promise<BoardWorkItemDetail>;
  cancelWorkItem(workItemId: string, input: { version: number; reason: string }): Promise<BoardWorkItemDetail>;
  archiveWorkItem(workItemId: string, input: { version: number }): Promise<BoardWorkItemDetail>;
  rotateAgentToken(agentId: string, input: { version: number }): Promise<RotateAgentTokenResult>;
  createTask(input: CreateTaskInput): Promise<void>;
  createAgentQuery(input: {
    projectId: string;
    agentId: string;
    assignedRole: AgentRole;
    prompt: string;
    workspaceRefs: string[];
    routingContext?: string;
    recentConversation?: AgentQueryConversationTurn[];
  }): Promise<void>;
  assignTask(taskId: string, input: { agentId: string; version: number }): Promise<void>;
  retryTask(taskId: string, version: number): Promise<void>;
  backlogTask(taskId: string, version: number): Promise<void>;
  reorderTask(taskId: string, input: { orderKey: number; version: number }): Promise<void>;
  returnTaskToBacklog(taskId: string, input: { version: number }): Promise<void>;
  addMessage(taskId: string, input: { body: string; version: number }): Promise<void>;
  answerQuestion(questionId: string, input: { answer: string }): Promise<void>;
  resumeTask(taskId: string, input: { version: number }): Promise<void>;
  decideHumanCheck(
    taskId: string,
    input: { version: number; status: "completed" | "failed"; result: string }
  ): Promise<void>;
  interruptRun(runId: string): Promise<InterruptRunResult>;
  getProjectWorkflow(projectId: string, signal?: AbortSignal): Promise<ProjectWorkflow>;
  getPipelineSummary(workItemId: string, signal?: AbortSignal): Promise<PipelineSummary>;
  approvePipelineMerge(workItemId: string, input: { version: number }): Promise<BoardWorkItemDetail>;
  rejectFinalApproval(workItemId: string, input: { version: number; note: string }): Promise<BoardWorkItemDetail>;
  attestDeployment(workItemId: string, input: { note?: string }): Promise<DeployAttestationResult>;
  resumeWorkItem(workItemId: string): Promise<BoardWorkItemDetail>;
  getProjectArtifacts(projectId: string, signal?: AbortSignal): Promise<ProjectArtifact[]>;
  confirmWorkflow(planRevisionId: string): Promise<ProjectWorkflow>;
  rejectWorkflowPlan(planRevisionId: string, note: string): Promise<RejectPlanRevisionResponse>;
  subscribeProjectEvents(input: {
    projectId: string;
    after: number;
    signal: AbortSignal;
    onEvent: (event: WorkflowEvent) => void;
  }): Promise<void>;
  getArtifactBlob(artifactId: string, signal?: AbortSignal): Promise<Blob>;
}

/* —— Transport boundary —— */

async function errorDetails(response: Response): Promise<{ message: string; code: string | null }> {
  const fallback = `Task board request failed (${response.status})`;
  try {
    const value = parseRecord(await response.json(), "error response");
    const error = parseRecord(value.error, "error response.error");
    return {
      message: typeof error.message === "string" && error.message.length > 0 ? error.message : fallback,
      code: typeof error.code === "string" && error.code.length > 0 ? error.code : null,
    };
  } catch {
    return { message: fallback, code: null };
  }
}

// Remote boards require HTTPS; plain HTTP is accepted only for loopback development.
function safeBaseUrl(value: string): string {
  const trimmed = value.replace(/\/$/, "");
  if (trimmed === "" || (trimmed.startsWith("/") && !trimmed.startsWith("//"))) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Task board URL is invalid");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
  ) {
    throw new Error("Task board URL requires HTTPS or a loopback host");
  }
  if (parsed.search || parsed.hash) throw new Error("Task board URL cannot include a query or fragment");
  return trimmed;
}

export function createTaskBoardClient(
  options: {
    baseUrl?: string;
    fetch?: typeof fetch;
  } = {}
): TaskBoardClient {
  const baseUrl = safeBaseUrl(options.baseUrl ?? "");
  const requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request(path: string, init?: RequestInit): Promise<Response> {
    // Cross-host boards must not receive ambient browser credentials or referrer details.
    const response = await requestFetch(`${baseUrl}${path}`, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      const error = await errorDetails(response);
      throw new BoardApiError(error.message, response.status, error.code);
    }
    return response;
  }

  const context: TaskBoardClientContext = {
    request,
    agentRoles: new Map(),
    questionVersions: new Map(),
    taskAgents: new Map(),
    taskPolicies: new Map(),
    runAgents: new Map(),
  };
  const boardMethods = createBoardMethods(context);
  const workItemMethods = createWorkItemMethods(context);
  const automationMethods = createAutomationMethods(context);
  const projectMethods = createProjectMethods(context);
  const agentMethods = createAgentMethods(context);
  const taskMethods = createTaskMethods(context);

  return {
    getBoardPause: boardMethods.getBoardPause,
    setBoardPause: boardMethods.setBoardPause,
    resumeBoard: boardMethods.resumeBoard,
    getFindingsLedger: boardMethods.getFindingsLedger,
    getParksLedger: boardMethods.getParksLedger,
    getNotifications: boardMethods.getNotifications,
    markNotificationRead: boardMethods.markNotificationRead,
    getWorkItemAudit: workItemMethods.getWorkItemAudit,
    getWorkItem: workItemMethods.getWorkItem,
    getWorkItemChildren: workItemMethods.getWorkItemChildren,
    getWorkItemDependencies: workItemMethods.getWorkItemDependencies,
    getPipelineSummary: workItemMethods.getPipelineSummary,
    approvePipelineMerge: workItemMethods.approvePipelineMerge,
    rejectFinalApproval: workItemMethods.rejectFinalApproval,
    attestDeployment: workItemMethods.attestDeployment,
    resumeWorkItem: workItemMethods.resumeWorkItem,
    getProjectWorkflow: projectMethods.getProjectWorkflow,
    getProjectArtifacts: projectMethods.getProjectArtifacts,
    confirmWorkflow: projectMethods.confirmWorkflow,
    rejectWorkflowPlan: projectMethods.rejectWorkflowPlan,
    subscribeProjectEvents: projectMethods.subscribeProjectEvents,
    getArtifactBlob: projectMethods.getArtifactBlob,
    getSnapshot: boardMethods.getSnapshot,
    getAutomationConfiguration: automationMethods.getAutomationConfiguration,
    saveAutomationConfiguration: automationMethods.saveAutomationConfiguration,
    createProject: projectMethods.createProject,
    updateProject: projectMethods.updateProject,
    addRepository: projectMethods.addRepository,
    updateRepository: projectMethods.updateRepository,
    getHostProjectRoots: projectMethods.getHostProjectRoots,
    getHostDirectories: projectMethods.getHostDirectories,
    createWorkItem: workItemMethods.createWorkItem,
    cancelWorkItem: workItemMethods.cancelWorkItem,
    archiveWorkItem: workItemMethods.archiveWorkItem,
    rotateAgentToken: agentMethods.rotateAgentToken,
    createTask: taskMethods.createTask,
    createAgentQuery: taskMethods.createAgentQuery,
    assignTask: taskMethods.assignTask,
    retryTask: taskMethods.retryTask,
    backlogTask: taskMethods.backlogTask,
    reorderTask: taskMethods.reorderTask,
    returnTaskToBacklog: taskMethods.returnTaskToBacklog,
    addMessage: taskMethods.addMessage,
    answerQuestion: taskMethods.answerQuestion,
    resumeTask: taskMethods.resumeTask,
    decideHumanCheck: taskMethods.decideHumanCheck,
    interruptRun: agentMethods.interruptRun,
  };
}
