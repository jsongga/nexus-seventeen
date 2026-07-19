import type { BoardAgent, BoardMessage, BoardProject, BoardSnapshot, BoardTask } from './types';

const pointOfContactTerms = /(?:\bpoc\b|point of contact)/iu;

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
