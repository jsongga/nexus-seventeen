/**
 * Wire -> view projection.
 *
 * The board speaks one vocabulary and the interface speaks another, on
 * purpose. The server reports an agent as `idle`; the interface shows
 * `sleeping`. A task is `in_progress` on the wire and `running` on screen,
 * and a task with an unanswered question is `waiting_for_human` regardless
 * of what the wire says. Keeping the mapping explicit here is what stops
 * server vocabulary leaking into components.
 */
import type {
  AgentStatus,
  BoardAgent,
  BoardDocument,
  BoardDocumentSummary,
  BoardMessage,
  BoardProject,
  BoardQuestion,
  BoardRun,
  BoardSnapshot,
  BoardTask,
  BoardTaskPhase,
  BoardWorkItem,
  RunStatus,
  TaskStatus,
} from '../types';
import type {
  RawBoard,
  RawDocument,
  RawDocumentSummary,
  RawEvent,
  RawMessage,
  RawProject,
  RawWorkItem,
} from '../data/parse';
import {
  wakeReasons,
  type WakeReason as WireWakeReason,
  type WireAgentStatus,
  type WireRunStatus,
  type WireTaskStatus,
} from '../data/wire';

export function taskStatus(status: WireTaskStatus, hasOpenQuestion: boolean): TaskStatus {
  if (hasOpenQuestion) return 'waiting_for_human';
  const statuses: Record<WireTaskStatus, TaskStatus> = {
    backlog: 'backlog',
    queued: 'queued',
    in_progress: 'running',
    blocked: 'blocked',
    completed: 'completed',
    failed: 'failed',
    interrupted: 'interrupted',
    cancelled: 'cancelled',
  };
  return statuses[status];
}

export function agentStatus(status: WireAgentStatus): AgentStatus {
  const statuses: Record<WireAgentStatus, AgentStatus> = {
    idle: 'sleeping',
    ready: 'queued',
    running: 'running',
    interrupting: 'interrupting',
    waiting_for_human: 'waiting_for_human',
  };
  return statuses[status];
}

export function runStatus(status: WireRunStatus): RunStatus {
  return status === 'active' ? 'running' : status;
}

export function eventRunId(event: RawEvent): string | null {
  return typeof event.data.runId === 'string' ? event.data.runId : null;
}

// Returns the WIRE wake reason, not the view one. `wakeReasons` is derived from
// the contract, so narrowing to the view type here would let a newly added
// contract member pass the runtime check and then be cast into a view union that
// excludes it. Keeping the wire type means the assignment into
// BoardRun.wakeReason is where a contract addition fails to compile — which is
// exactly where someone should be forced to decide how the UI displays it.
export function eventWakeReason(event: RawEvent): WireWakeReason | null {
  const value = event.data.wakeReason;
  return typeof value === 'string' && wakeReasons.has(value as WireWakeReason) ? value as WireWakeReason : null;
}

interface TimestampValue {
  iso: string;
  ms: number;
}

export function newest(values: Array<TimestampValue | null | undefined>, fallback: TimestampValue): TimestampValue {
  let latest: TimestampValue | null = null;
  for (const value of values) {
    if (value !== null && value !== undefined && (
      latest === null
      || value.ms > latest.ms
      || (value.ms === latest.ms && value.iso.localeCompare(latest.iso) > 0)
    )) latest = value;
  }
  return latest ?? fallback;
}

export function documentSummary(raw: RawDocumentSummary): BoardDocumentSummary {
  return {
    id: raw.documentId,
    projectId: raw.projectId,
    title: raw.title,
    contentType: raw.contentType,
    contentVersion: raw.contentVersion,
    penEpoch: raw.penEpoch,
    penHolder: raw.penHolder === null ? null : { ...raw.penHolder },
    sequence: raw.sequence,
    createdAt: raw.createdAt,
    createdAtMs: raw.createdAtMs,
    updatedAt: raw.updatedAt,
    updatedAtMs: raw.updatedAtMs,
  };
}

export function documentProjection(raw: RawDocument): BoardDocument {
  return { ...documentSummary(raw), content: raw.content };
}

export function projectProjection(raw: RawProject): BoardProject {
  return {
    id: raw.projectId,
    name: raw.name,
    description: raw.description,
    createdAt: raw.createdAt,
    createdAtMs: raw.createdAtMs,
    updatedAt: raw.updatedAt,
    updatedAtMs: raw.updatedAtMs,
  };
}

export function workItemProjection(raw: RawWorkItem): BoardWorkItem {
  return {
    id: raw.workItemId,
    originalRequest: raw.originalRequest,
    refinedObjective: raw.refinedObjective,
    priority: raw.priority,
    projectTarget: { ...raw.projectTarget },
    resolvedProjectId: raw.resolvedProjectId,
    planningTaskId: raw.planningTaskId,
    state: raw.state,
    currentStage: raw.currentStage,
    createdBy: raw.createdBy,
    version: raw.version,
    createdAt: raw.createdAt,
    createdAtMs: raw.createdAtMs,
    updatedAt: raw.updatedAt,
    updatedAtMs: raw.updatedAtMs,
    endedAt: raw.endedAt,
    endedAtMs: raw.endedAtMs,
    cancelledReason: raw.cancelledReason,
    archivedAt: raw.archivedAt,
    archivedAtMs: raw.archivedAtMs,
  };
}

export function normalize(boards: RawBoard[], listedProjects: RawProject[], rawMessages: RawMessage[], rawWorkItems: RawWorkItem[]): BoardSnapshot {
  const tasksById = new Map<string, BoardTask>();
  const allRawTasks = boards.flatMap((board) => board.tasks);
  const questions: BoardQuestion[] = boards.flatMap((board) => board.questions.map((question) => ({
    id: question.questionId,
    projectId: question.projectId,
    taskId: question.taskId,
    agentId: question.agentId,
    prompt: question.question,
    status: question.status,
    answer: question.answer,
    askedAt: question.askedAt,
    askedAtMs: question.askedAtMs,
    answeredAt: question.answeredAt,
    answeredAtMs: question.answeredAtMs,
    version: question.version,
  })));
  const openQuestionTasks = new Set(questions.filter((question) => question.status === 'open').map((question) => question.taskId));
  for (const [index, raw] of allRawTasks.entries()) {
    const phases: BoardTaskPhase[] = raw.phases.map((phase) => ({
      id: phase.phaseId,
      title: phase.title,
      stage: phase.stage,
      status: phase.status,
      parallelGroup: phase.parallelGroup,
      orderKey: phase.orderKey,
      startedAt: phase.startedAt,
      startedAtMs: phase.startedAtMs,
      endedAt: phase.endedAt,
      endedAtMs: phase.endedAtMs,
      version: phase.version,
      createdAt: phase.createdAt,
      createdAtMs: phase.createdAtMs,
      updatedAt: phase.updatedAt,
      updatedAtMs: phase.updatedAtMs,
    }));
    tasksById.set(raw.taskId, {
      id: raw.taskId,
      projectId: raw.projectId,
      parentTaskId: raw.parentTaskId,
      kind: raw.kind,
      requiredRole: raw.requiredRole,
      requiresReview: raw.requiresReview,
      title: raw.title,
      objective: raw.objective,
      acceptanceCriteria: raw.acceptanceCriteria,
      workspaceRefs: raw.workspaceRefs,
      assignedAgentId: raw.assignedAgentId,
      assignedRole: raw.assignedRole,
      status: taskStatus(raw.status, openQuestionTasks.has(raw.taskId)),
      expectedAgentMinutes: raw.expectedAgentMinutes,
      estimateRecordedAt: raw.estimateRecordedAt,
      estimateRecordedAtMs: raw.estimateRecordedAtMs,
      expectedCompletedAt: raw.expectedCompletedAt,
      expectedCompletedAtMs: raw.expectedCompletedAtMs,
      orderKey: raw.orderKey ?? index * 1024,
      phases,
      startedAt: raw.startedAt,
      startedAtMs: raw.startedAtMs,
      endedAt: raw.endedAt,
      endedAtMs: raw.endedAtMs,
      result: raw.result,
      version: raw.version,
      createdAt: raw.createdAt,
      createdAtMs: raw.createdAtMs,
      updatedAt: raw.updatedAt,
      updatedAtMs: raw.updatedAtMs,
    });
  }

  const runs: BoardRun[] = [];
  for (const board of boards) {
    const runEvents = new Map(board.events.map((event) => [eventRunId(event), event]));
    for (const raw of board.runs) {
      const event = runEvents.get(raw.runId);
      const taskId = raw.taskId ?? event?.taskId ?? null;
      if (!taskId) continue;
      const interrupt = board.interrupts.find((item) => item.runId === raw.runId);
      runs.push({
        id: raw.runId,
        projectId: raw.projectId,
        taskId,
        agentId: raw.agentId,
        status: runStatus(raw.status),
        wakeReason: event ? eventWakeReason(event) : null,
        startedAt: raw.startedAt,
        startedAtMs: raw.startedAtMs,
        endedAt: raw.endedAt,
        endedAtMs: raw.endedAtMs,
        interruptRequestedAt: interrupt?.requestedAt ?? null,
        interruptRequestedAtMs: interrupt?.requestedAtMs ?? null,
        createdAt: raw.startedAt,
        createdAtMs: raw.startedAtMs,
      });
    }
  }

  const agents: BoardAgent[] = boards.flatMap((board) => board.agents.map((raw) => {
    const owned = allRawTasks.filter((task) => task.assignedAgentId === raw.agentId);
    const current = owned.find((task) => task.status === 'in_progress' || task.status === 'blocked')
      ?? owned.find((task) => task.status === 'queued')
      ?? null;
    const activity = board.events
      .filter((event) => event.actorId === raw.agentId)
      .map((event) => ({ iso: event.createdAt, ms: event.createdAtMs }));
    const latestActivity = newest(activity, { iso: raw.createdAt, ms: raw.createdAtMs });
    return {
      id: raw.agentId,
      projectId: raw.projectId,
      name: raw.agentId,
      role: raw.role,
      area: raw.area,
      mission: raw.mission,
      model: raw.model,
      status: agentStatus(raw.status),
      workerConnection: raw.workerConnection,
      lastError: raw.lastError,
      currentTaskId: current?.taskId ?? null,
      lastEventAt: latestActivity.iso,
      lastEventAtMs: latestActivity.ms,
      version: raw.version,
      createdAt: raw.createdAt,
      createdAtMs: raw.createdAtMs,
      updatedAt: latestActivity.iso,
      updatedAtMs: latestActivity.ms,
    };
  }));

  const projects = listedProjects.map(projectProjection);
  const workItems = rawWorkItems.map(workItemProjection);
  const tasks = [...tasksById.values()];
  const messages: BoardMessage[] = rawMessages.map((message) => ({
    id: message.messageId,
    projectId: message.projectId,
    taskId: message.taskId,
    authorType: message.actorType,
    authorId: message.actorId,
    kind: message.kind,
    body: message.body,
    createdAt: message.createdAt,
    createdAtMs: message.createdAtMs,
  }));
  const documents = boards.flatMap((board) => board.documents.map(documentSummary));
  const generatedAt = newest([
    ...workItems.map((workItem) => ({ iso: workItem.updatedAt, ms: workItem.updatedAtMs })),
    ...projects.map((project) => ({ iso: project.updatedAt, ms: project.updatedAtMs })),
    ...boards.flatMap((board) => board.events.map((event) => ({ iso: event.createdAt, ms: event.createdAtMs }))),
    ...messages.map((message) => ({ iso: message.createdAt, ms: message.createdAtMs })),
    ...documents.map((document) => ({ iso: document.updatedAt, ms: document.updatedAtMs })),
  ], { iso: new Date(0).toISOString(), ms: 0 });
  return {
    revision: workItems.reduce((sum, workItem) => sum + workItem.version, 0)
      + projects.reduce((sum, project) => sum + (listedProjects.find((raw) => raw.projectId === project.id)?.version ?? 0), 0)
      + tasks.reduce((sum, task) => sum + task.version, 0)
      + tasks.reduce((sum, task) => sum + task.phases.reduce((phaseSum, phase) => phaseSum + phase.version, 0), 0)
      + documents.reduce((sum, document) => sum + document.sequence, 0),
    generatedAt: generatedAt.iso,
    generatedAtMs: generatedAt.ms,
    workItems,
    projects,
    agents,
    tasks,
    messages,
    questions,
    runs,
    documents,
  };
}
