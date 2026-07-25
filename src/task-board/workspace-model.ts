import type { AgentStatus, AgentWorkerConnection, BoardAgent, BoardMessage, BoardProject, BoardSnapshot, BoardTask, BoardTaskPhase } from './types';

const pointOfContactTerms = /(?:\bpoc\b|point of contact)/iu;

const agentWorkLabels: Record<AgentStatus, string> = {
  sleeping: 'No task',
  queued: 'Queued',
  running: 'Working',
  interrupting: 'Stopping',
  waiting_for_human: 'Needs you',
  failed: 'Failed',
};

export function agentWorkLabel(status: AgentStatus): string {
  return agentWorkLabels[status];
}

export function workerConnectionLabel(connection: AgentWorkerConnection): string {
  if (connection === 'waiting_for_wake') return 'Worker ready';
  if (connection === 'watching_run') return 'Worker connected';
  return 'Worker not detected';
}

export function workerAssignmentHint(connection: AgentWorkerConnection): string {
  if (connection === 'waiting_for_wake') return 'Worker ready — starts when assigned.';
  if (connection === 'watching_run') return 'Worker connected — this task will wait behind current work.';
  return 'Worker not detected — assignment stays queued until it reconnects.';
}

const activeTaskStatuses = new Set<BoardTask['status']>(['running', 'waiting_for_human', 'blocked', 'queued']);
const phaseStageOrder: Record<Exclude<BoardTaskPhase['stage'], 'done'>, number> = {
  research: 0,
  planning: 1,
  execution: 2,
  testing: 3,
  review: 4,
};

export interface AgentPipelineFocus {
  task: BoardTask | null;
  phase: BoardTaskPhase | null;
  stage: 'Implementing' | 'Reviewing' | null;
  loop: number | null;
}

/** Keeps the compact agent header grounded in durable task and phase state. */
export function agentPipelineFocus(agent: BoardAgent, tasks: BoardTask[]): AgentPipelineFocus {
  const assigned = tasks
    .filter((task) => task.assignedAgentId === agent.id)
    .sort((left, right) => left.orderKey - right.orderKey || left.id.localeCompare(right.id));
  const task = assigned.find((item) => item.id === agent.currentTaskId && activeTaskStatuses.has(item.status))
    ?? assigned.find((item) => activeTaskStatuses.has(item.status))
    ?? null;
  if (task === null) return { task: null, phase: null, stage: null, loop: null };

  const phases = [...task.phases].sort((left, right) => (
    left.orderKey - right.orderKey
      || left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id)
  ));
  const phase = phases.filter((item) => item.status === 'in_progress').at(-1)
    ?? phases.filter((item) => item.status === 'blocked').at(-1)
    ?? phases.find((item) => item.status === 'pending')
    ?? phases.at(-1)
    ?? null;
  const stage = task.kind === 'manager_review' || agent.role === 'manager'
    ? 'Reviewing'
    : 'Implementing';
  if (phase === null) return { task, phase, stage, loop: null };

  const phaseIndex = phases.findIndex((item) => item.id === phase.id);
  let loop = 1;
  let previousStage: number | null = null;
  const loopUnits: Array<{ stage: number; parallelGroup: string | null }> = [];
  let previousRowParallelGroup: string | null = null;
  for (const item of phases.slice(0, phaseIndex + 1)) {
    // Older snapshots rewrote finished phases to `done`; they carry no semantic
    // position, so they must not create a false loop boundary.
    if (item.stage === 'done') {
      previousRowParallelGroup = item.parallelGroup;
      continue;
    }
    const stageOrder = phaseStageOrder[item.stage];
    const lastUnit = loopUnits.at(-1);
    const sameContiguousParallelGroup = item.parallelGroup !== null
      && item.parallelGroup === previousRowParallelGroup
      && lastUnit?.parallelGroup === item.parallelGroup;
    if (sameContiguousParallelGroup && lastUnit) {
      lastUnit.stage = Math.max(lastUnit.stage, stageOrder);
    } else {
      loopUnits.push({ stage: stageOrder, parallelGroup: item.parallelGroup });
    }
    previousRowParallelGroup = item.parallelGroup;
  }
  for (const unit of loopUnits) {
    if (previousStage !== null && unit.stage < previousStage) loop += 1;
    previousStage = unit.stage;
  }
  return { task, phase, stage, loop: loop > 1 ? loop : null };
}

export interface ProjectResource {
  id: string;
  projectId: string;
  title: string;
  description: string;
  kind: 'brief' | 'outcome' | 'link' | 'setup';
  href: string | null;
  updatedAt: string;
}

export interface ProjectUpdate {
  id: string;
  projectId: string;
  taskId: string;
  taskTitle: string;
  author: string;
  body: string;
  kind: BoardMessage['kind'] | 'task';
  createdAt: string;
}

export function selectPointOfContact(agents: BoardAgent[]): BoardAgent | null {
  if (agents.length === 0) return null;
  const ordered = [...agents].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  return ordered.find((agent) => pointOfContactTerms.test(`${agent.id} ${agent.name} ${agent.area} ${agent.mission}`))
    ?? ordered.find((agent) => agent.role === 'engineer')
    ?? ordered[0]
    ?? null;
}

export function isExplicitPointOfContact(agent: BoardAgent): boolean {
  return agent.id === 'steward-poc' || pointOfContactTerms.test(`${agent.name} ${agent.area} ${agent.mission}`);
}

export function taskNeedsHumanAction(task: BoardTask): boolean {
  return task.status === 'waiting_for_human'
    || (task.kind === 'manager_review' && task.assignedAgentId === null && task.endedAt === null)
    || (task.kind === 'human_check' && task.endedAt === null);
}

export function isWebLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function refTitle(reference: string): string {
  if (isWebLink(reference)) {
    const url = new URL(reference);
    return url.hostname.replace(/^www\./u, '');
  }
  const pieces = reference.split('/').filter(Boolean);
  return pieces.at(-1) ?? reference;
}

export function resourcesForProject(project: BoardProject, tasks: BoardTask[]): ProjectResource[] {
  const projectTasks = tasks.filter((task) => task.projectId === project.id);
  const resources: ProjectResource[] = [];
  if (project.description?.trim()) {
    resources.push({
      id: `${project.id}:brief`,
      projectId: project.id,
      title: 'Project brief',
      description: project.description.trim(),
      kind: 'brief',
      href: null,
      updatedAt: project.updatedAt,
    });
  }

  const seenReferences = new Set<string>();
  for (const task of [...projectTasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    for (const reference of task.workspaceRefs) {
      const value = reference.trim();
      if (!value || seenReferences.has(value)) continue;
      seenReferences.add(value);
      const link = isWebLink(value);
      resources.push({
        id: `${project.id}:ref:${value}`,
        projectId: project.id,
        title: refTitle(value),
        description: link ? `Linked from ${task.title}` : value,
        kind: link ? 'link' : 'setup',
        href: link ? value : null,
        updatedAt: task.updatedAt,
      });
    }
  }

  for (const task of projectTasks) {
    if (task.kind !== 'work' || task.status !== 'completed' || !task.result?.trim()) continue;
    resources.push({
      id: `${project.id}:result:${task.id}`,
      projectId: project.id,
      title: task.title,
      description: task.result.trim(),
      kind: 'outcome',
      href: null,
      updatedAt: task.endedAt ?? task.updatedAt,
    });
  }

  return resources.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function recentUpdatesForProject(snapshot: BoardSnapshot, projectId: string): ProjectUpdate[] {
  const projectTasks = snapshot.tasks.filter((task) => task.projectId === projectId);
  const taskById = new Map(projectTasks.map((task) => [task.id, task]));
  const agentById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const messages = snapshot.messages
    .filter((message) => message.projectId === projectId && taskById.has(message.taskId))
    .map((message): ProjectUpdate => ({
      id: message.id,
      projectId,
      taskId: message.taskId,
      taskTitle: taskById.get(message.taskId)?.title ?? 'Task update',
      author: message.authorType === 'human'
        ? 'You'
        : message.authorType === 'system'
          ? 'System'
          : agentById.get(message.authorId ?? '')?.name ?? 'Agent',
      body: message.body,
      kind: message.kind,
      createdAt: message.createdAt,
    }));

  const messagedTaskIds = new Set(messages.map((message) => message.taskId));
  const taskUpdates = projectTasks
    .filter((task) => !messagedTaskIds.has(task.id))
    .map((task): ProjectUpdate => ({
      id: `task:${task.id}:${task.updatedAt}`,
      projectId,
      taskId: task.id,
      taskTitle: task.title,
      author: task.assignedAgentId ? agentById.get(task.assignedAgentId)?.name ?? 'Agent' : 'Task board',
      body: task.result?.trim() || `${task.title} is ${task.status.replaceAll('_', ' ')}.`,
      kind: 'task',
      createdAt: task.updatedAt,
    }));

  return [...messages, ...taskUpdates]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 12);
}
