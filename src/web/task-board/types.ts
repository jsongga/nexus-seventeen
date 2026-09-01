/** Defines browser-facing task-board projections and mutation inputs for the web app. */

/* —— Imports —— */

import {
  agentRoleValues,
  automationStageAllowedRoles,
  evaluatorProfileValues,
  gateKindValues,
  planRevisionStateValues,
  type ParkCategory,
  questionStatusValues,
  stageHandoffOutcomeValues,
  taskKindValues,
  taskPhaseStageValues,
  taskPhaseStatusValues,
  unrecognizedState,
  wakeReasonValues,
  workerConnectionValues,
  workNodeStateValues,
  workItemPriorityValues,
  workItemPhaseValues,
  workItemStageValues,
  workItemStateValues,
  workItemTaskTypeValues,
  type WorkflowStage,
} from "./data/wire";
import type { TolerantDeclaredChild } from "@shared/task-board-contract/validate";

/* —— View vocabulary and automation policy —— */

export type { ParkCategory, WorkflowStage };

export type AgentStatus = "sleeping" | "queued" | "running" | "interrupting" | "waiting_for_human" | "failed";

export type AgentWorkerConnection = (typeof workerConnectionValues)[number] | null;

export type AgentRole = (typeof agentRoleValues)[number];
export type TaskKind = (typeof taskKindValues)[number];

export type TaskStatus =
  | "proposed"
  | "backlog"
  | "queued"
  | "running"
  | "waiting_for_human"
  | "blocked"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled"
  | typeof unrecognizedState;

export type TaskPhaseStage = (typeof taskPhaseStageValues)[number];
export type TaskPhaseStatus = (typeof taskPhaseStatusValues)[number];

export type QuestionStatus = (typeof questionStatusValues)[number];

export type RunStatus = "queued" | "running" | "waiting_for_human" | "completed" | "failed" | "interrupted";

export type WakeReason = (typeof wakeReasonValues)[number];

export type WorkItemPriority = (typeof workItemPriorityValues)[number];
export type WorkItemState = (typeof workItemStateValues)[number] | typeof unrecognizedState;
export type WorkItemPhase = (typeof workItemPhaseValues)[number] | typeof unrecognizedState;
export type WorkItemStage = (typeof workItemStageValues)[number];
export type WorkItemTaskType = (typeof workItemTaskTypeValues)[number];
export type GateKind = (typeof gateKindValues)[number] | typeof unrecognizedState;
export const AUTOMATION_STAGE_ORDER: readonly WorkItemStage[] = workItemStageValues;
export const AUTOMATION_STAGE_ALLOWED_ROLES = automationStageAllowedRoles;
export type WorkItemProjectTarget = { mode: "auto" } | { mode: "explicit"; projectId: string };

export type AutomationEvaluatorProfile = (typeof evaluatorProfileValues)[number];

export interface AutomationAgentType {
  id: string;
  name: string;
  description: string;
  role: AgentRole;
  supplementalInstructions: string;
  skillIds: string[];
  evaluatorProfile: AutomationEvaluatorProfile;
  enabled: boolean;
}

export type AutomationStageExecutor =
  | { kind: "agent_type"; agentTypeId: string }
  | { kind: "machine_verify" }
  | { kind: "human" }
  | { kind: "disabled" };

export interface AutomationStageConfiguration {
  stage: WorkItemStage;
  executor: AutomationStageExecutor;
}

export interface AutomationConfiguration {
  id: "company-default";
  agentTypes: AutomationAgentType[];
  stages: AutomationStageConfiguration[];
  version: number;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
  updatedBy: string;
}

export interface SaveAutomationConfigurationInput {
  version: number;
  agentTypes: AutomationAgentType[];
  stages: AutomationStageConfiguration[];
}

/* —— Board projections —— */

export interface BoardWorkItem {
  id: string;
  originalRequest: string;
  refinedObjective: string | null;
  priority: WorkItemPriority;
  /** Unknown server values remain visible during rolling upgrades. */
  taskType: string;
  projectTarget: WorkItemProjectTarget;
  resolvedProjectId: string | null;
  parentWorkItemId: string | null;
  phase: WorkItemPhase | null;
  childOrdinal: number | null;
  planningTaskId: string | null;
  state: WorkItemState;
  currentStage: WorkItemStage | null;
  stateSince?: string | null;
  stateSinceMs?: number | null;
  reviewRound?: number | null;
  heartbeatAt?: string | null;
  heartbeatAtMs?: number | null;
  createdBy: string;
  version: number;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
  endedAt: string | null;
  endedAtMs: number | null;
  cancelledReason: string | null;
  archivedAt: string | null;
  archivedAtMs: number | null;
  /** Present on the per-id detail response, absent from list snapshots. */
  parkCategory?: ParkCategory | null;
}

export interface BoardChildWorkItem extends BoardWorkItem {
  deployAttested: boolean;
  mergeSha: string | null;
}

export interface BoardWorkItemDependency {
  workItemId: string;
  dependsOnWorkItemId: string;
}

export interface BoardGateAction {
  id: string;
  workItemId: string;
  gate: GateKind;
  actorId: string;
  planRevisionId: string | null;
  verifiedSha: string | null;
  mergeSha: string | null;
  refId: string | null;
  note: string | null;
  createdAt: string;
  createdAtMs: number;
}

export interface DeployAttestationResult {
  gateAction: BoardGateAction;
  duplicate: boolean;
}

export interface BoardWorkItemTransition {
  fromState: (typeof workItemStateValues)[number] | null;
  toState: (typeof workItemStateValues)[number];
  actorType: "human" | "agent" | "system";
  actorId: string;
  createdAt: string;
  createdAtMs: number;
}

export interface BoardWorkItemDetail extends BoardWorkItem {
  transitions: BoardWorkItemTransition[];
  gapReportArtifactId: string | null;
  parkCategory: ParkCategory | null;
}

export interface BoardProject {
  id: string;
  name: string;
  description: string | null;
  repoPath: string;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
}

export interface BoardAgent {
  id: string;
  projectId: string;
  name: string;
  role: AgentRole;
  area: string;
  mission: string;
  model: string | null;
  status: AgentStatus;
  workerConnection: AgentWorkerConnection;
  lastError: string | null;
  currentTaskId: string | null;
  lastEventAt: string | null;
  lastEventAtMs: number | null;
  version: number;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
}

export interface BoardTask {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  kind: TaskKind;
  requiredRole: AgentRole | null;
  requiresReview: boolean;
  title: string;
  objective: string;
  acceptanceCriteria: string | null;
  workspaceRefs: string[];
  assignedAgentId: string | null;
  assignedRole: AgentRole | null;
  status: TaskStatus;
  expectedAgentMinutes: number | null;
  estimateRecordedAt: string | null;
  estimateRecordedAtMs: number | null;
  expectedCompletedAt: string | null;
  expectedCompletedAtMs: number | null;
  orderKey: number;
  phases: BoardTaskPhase[];
  startedAt: string | null;
  startedAtMs: number | null;
  endedAt: string | null;
  endedAtMs: number | null;
  result: string | null;
  version: number;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
}

export interface BoardTaskPhase {
  id: string;
  title: string;
  stage: TaskPhaseStage;
  status: TaskPhaseStatus;
  parallelGroup: string | null;
  orderKey: number;
  startedAt: string | null;
  startedAtMs: number | null;
  endedAt: string | null;
  endedAtMs: number | null;
  version: number;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
}

export interface BoardMessage {
  id: string;
  projectId: string;
  taskId: string;
  authorType: "human" | "agent" | "system";
  authorId: string | null;
  kind: "progress" | "question" | "answer" | "decision" | "result" | "note" | "proposal";
  body: string;
  createdAt: string;
  createdAtMs: number;
}

export interface BoardQuestion {
  id: string;
  projectId: string;
  taskId: string;
  agentId: string;
  prompt: string;
  status: QuestionStatus;
  answer: string | null;
  askedAt: string;
  askedAtMs: number;
  answeredAt: string | null;
  answeredAtMs: number | null;
  version: number;
}

export interface BoardRun {
  id: string;
  projectId: string;
  taskId: string | null;
  agentId: string;
  status: RunStatus;
  wakeReason: WakeReason | null;
  startedAt: string | null;
  startedAtMs: number | null;
  heartbeatAt: string | null;
  heartbeatAtMs: number | null;
  endedAt: string | null;
  endedAtMs: number | null;
  interruptRequestedAt: string | null;
  interruptRequestedAtMs: number | null;
  createdAt: string;
  createdAtMs: number;
}

export interface BoardSnapshot {
  revision: number;
  generatedAt: string;
  generatedAtMs: number;
  workItems: BoardWorkItem[];
  projects: BoardProject[];
  agents: BoardAgent[];
  tasks: BoardTask[];
  messages: BoardMessage[];
  questions: BoardQuestion[];
  runs: BoardRun[];
}

/* —— Workflow and project projections —— */

export interface WorkflowPlan {
  planRevisionId: string;
  workItemId: string;
  revision: number;
  objective: string;
  assumptions: string[];
  acceptanceCriteria: string[];
  children: TolerantDeclaredChild[] | null;
  state: (typeof planRevisionStateValues)[number];
  createdAt: string;
  createdAtMs: number;
  confirmedAt: string | null;
  confirmedAtMs: number | null;
}

export interface WorkflowNode {
  nodeId: string;
  planRevisionId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  dependencyNodeIds: string[];
  stageTemplate: WorkflowStage[];
  currentStage: WorkflowStage | null;
  state: (typeof workNodeStateValues)[number];
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  updatedAtMs: number;
}

export interface WorkflowHandoff {
  handoffId: string;
  nodeId: string;
  taskId: string;
  stage: WorkflowStage;
  outcome: (typeof stageHandoffOutcomeValues)[number];
  summary: string;
  evidence: string[];
  artifactIds: string[];
  blockers: string[];
  createdAt: string;
  createdAtMs: number;
}

export interface WorkflowEvent {
  sequence: number;
  eventId: string;
  nodeId: string | null;
  taskId: string | null;
  eventType: string;
  summary: string;
  createdAt: string;
  createdAtMs: number;
}

export interface ProjectWorkflow {
  plans: WorkflowPlan[];
  nodes: WorkflowNode[];
  handoffs: WorkflowHandoff[];
  events: WorkflowEvent[];
}

export interface ProjectArtifact {
  artifactId: string;
  nodeId: string | null;
  taskId: string | null;
  mediaType: string;
  byteSize: number;
  caption: string;
  createdAt: string;
  createdAtMs: number;
}

export interface HostProjectEntry {
  name: string;
  path: string;
  hasGit: boolean;
  modifiedAtMs: number;
}

export interface HostProjectRoot {
  name: string;
  path: string;
  projects: HostProjectEntry[];
  truncated: boolean;
}

export interface HostDirectoryEntry {
  name: string;
  path: string;
  hasGit: boolean;
}

export interface HostDirectoryListing {
  path: string;
  parent: string | null;
  entries: HostDirectoryEntry[];
  truncated: boolean;
}

/* —— Mutation inputs —— */

export interface CreateProjectInput {
  name: string;
  description: string;
  repoPath?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  repoPath?: string;
}

export interface RotateAgentTokenResult {
  agentId: string;
  version: number;
  token: string;
}

export interface CreateTaskInput {
  projectId: string;
  parentTaskId: string | null;
  title: string;
  objective: string;
  acceptanceCriteria: string;
  workspaceRefs: string[];
}

export interface CreateWorkItemInput {
  originalRequest: string;
  priority: Exclude<WorkItemPriority, "opportunistic">;
  taskType: WorkItemTaskType;
  projectId: string;
  idempotencyKey: string;
}

export interface AgentQueryConversationTurn {
  role: "human" | "agent";
  body: string;
}
