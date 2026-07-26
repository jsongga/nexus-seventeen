import type { BoardTask, CreateTaskInput } from './types';

export interface TaskProposal {
  title: string;
  objective: string;
  acceptanceCriteria: string;
}

function boundedText(value: unknown, maximum: number, singleLine = false): string | null {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const text = value.trim();
  if (text.length === 0 || text.length > maximum || (singleLine && /[\r\n]/u.test(text))) return null;
  return text;
}

function criteria(value: unknown): string | null {
  const text = boundedText(value, 4_000);
  if (text !== null) return text;
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return null;
  const items = value.map((item) => boundedText(item, 1_000));
  if (items.some((item) => item === null)) return null;
  const result = items.map((item) => `- ${item}`).join('\n');
  return result.length <= 4_000 ? result : null;
}

/** Agent proposal payloads are untrusted display data until this parser accepts them. */
export function parseTaskProposal(body: string): TaskProposal | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;
  const item = decoded as Record<string, unknown>;
  const title = boundedText(item.title, 512, true);
  const objective = boundedText(item.objective, 4_000);
  const acceptanceCriteria = criteria(item.acceptanceCriteria);
  if (title === null || objective === null || acceptanceCriteria === null) return null;
  return { title, objective, acceptanceCriteria };
}

export function proposalChildInput(parent: BoardTask, proposal: TaskProposal): CreateTaskInput {
  return {
    projectId: parent.projectId,
    parentTaskId: parent.id,
    title: proposal.title,
    objective: proposal.objective,
    acceptanceCriteria: proposal.acceptanceCriteria,
    workspaceRefs: [...parent.workspaceRefs],
  };
}

export function proposalIsOnBoard(parent: BoardTask, proposal: TaskProposal, tasks: BoardTask[]): boolean {
  return tasks.some((task) => (
    task.parentTaskId === parent.id
    && task.title === proposal.title
    && task.objective === proposal.objective
    && task.acceptanceCriteria === proposal.acceptanceCriteria
    && task.workspaceRefs.length === parent.workspaceRefs.length
    && task.workspaceRefs.every((reference, index) => reference === parent.workspaceRefs[index])
  ));
}
