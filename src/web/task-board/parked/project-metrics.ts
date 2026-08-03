/**
 * Project delivery task grouping and completion arithmetic.
 *
 * Deliberately not rendered by the current ProjectPage design, which shows the
 * documents, pipeline and activity regions only. Kept exported and tested so the
 * behaviour survives and can be re-surfaced without being rebuilt.
 */
import type { BoardSnapshot, BoardTask } from '../types';

export interface ProjectTaskGroup {
  label: string;
  tasks: BoardTask[];
  tone: string;
}

export function projectTaskGroups(snapshot: BoardSnapshot, projectId: string): ProjectTaskGroup[] {
  const tasks = snapshot.tasks.filter((task) => task.projectId === projectId);
  const completedTasks = tasks.filter((task) => task.status === 'completed');
  const activeTasks = tasks.filter((task) => task.status === 'running' || task.status === 'queued');
  const attentionTasks = tasks.filter((task) => task.status === 'waiting_for_human' || task.status === 'blocked' || task.status === 'failed');
  const plannedTasks = tasks.filter((task) => task.status === 'proposed' || task.status === 'backlog');
  const interruptedTasks = tasks.filter((task) => task.status === 'interrupted');

  return [
    { label: 'Needs attention', tasks: attentionTasks, tone: 'text-urgent' },
    { label: 'In progress', tasks: activeTasks, tone: 'text-teal-700' },
    { label: 'Planned', tasks: plannedTasks, tone: 'text-muted' },
    { label: 'Completed', tasks: completedTasks, tone: 'text-success' },
    { label: 'Interrupted', tasks: interruptedTasks, tone: 'text-muted' },
  ].filter((group) => group.tasks.length > 0);
}

export function completionPercent(tasks: BoardTask[]): number {
  if (tasks.length === 0) return 0;
  const completedTasks = tasks.filter((task) => task.status === 'completed');
  return Math.round((completedTasks.length / tasks.length) * 100);
}
