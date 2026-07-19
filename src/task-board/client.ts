import type {
  AgentRole,
  AgentStatus,
  BoardAgent,
  BoardMessage,
  BoardProject,
  BoardQuestion,
  BoardRun,
  BoardSnapshot,
  BoardTask,
  CreateAgentInput,
  CreateProjectInput,
  CreateTaskInput,
  RunStatus,
  TaskStatus,
  TaskKind,
  WakeReason,
} from './types';

type JsonRecord = Record<string, unknown>;

const API_VERSION = 'steward.task-board/v1';
const rawAgentStatuses = new Set(['idle', 'ready', 'running', 'interrupting', 'waiting_for_human'] as const);
const rawTaskStatuses = new Set(['backlog', 'queued', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled'] as const);
const rawRunStatuses = new Set(['active', 'waiting_for_human', 'completed', 'failed', 'interrupted'] as const);
const roles = new Set(['engineer', 'manager', 'verifier'] as const);
const taskKinds = new Set(['work', 'manager_review', 'human_check'] as const);
const actorTypes = new Set(['human', 'agent'] as const);
const messageKinds = new Set(['note', 'progress', 'proposal', 'result'] as const);
const questionStatuses = new Set(['open', 'answered'] as const);
const wakeReasons = new Set<WakeReason>(['human_assignment', 'human_answer', 'human_resume']);

interface RawProject {
  projectId: string;
  name: string;
  description: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface RawAgent {
  agentId: string;
  projectId: string;
  role: 'engineer' | 'manager' | 'verifier';
  area: string;
  mission: string;
  model: string;
  status: 'idle' | 'ready' | 'running' | 'interrupting' | 'waiting_for_human';
  createdAt: string;
}

interface RawTask {
  taskId: string;
  projectId: string;
  parentTaskId: string | null;
  kind: TaskKind;
  requiredRole: AgentRole | null;
  title: string;
  objective: string;
  acceptanceCriteria: string;
  workspaceRefs: string[];
  status: 'backlog' | 'queued' | 'in_progress' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  assignedAgentId: string | null;
  assignedRole: 'engineer' | 'manager' | 'verifier' | null;
  expectedAgentMinutes: number;
  startedAt: string | null;
  expectedCompletedAt: string | null;
  endedAt: string | null;
  result: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface RawQuestion {
  questionId: string;
  projectId: string;
  taskId: string;
  agentId: string;
  question: string;
  status: 'open' | 'answered';
  answer: string | null;
  askedAt: string;
  answeredAt: string | null;
  version: number;
}

interface RawRun {
  runId: string;
  projectId: string;
  agentId: string;
  taskId: string | null;
  status: 'active' | 'waiting_for_human' | 'completed' | 'failed' | 'interrupted';
  startedAt: string;
  endedAt: string | null;
}

interface RawInterrupt {
  sequence: number;
  agentId: string;
  runId: string | null;
  requestedAt: string;
}

interface RawEvent {
  eventId: string;
  projectId: string;
  taskId: string | null;
  actorType: 'human' | 'agent' | 'system';
  actorId: string;
  eventType: string;
  data: JsonRecord;
  createdAt: string;
}

interface RawMessage {
  messageId: string;
  sequence: number;
  projectId: string;
  taskId: string;
  actorType: 'human' | 'agent';
  actorId: string;
  kind: 'note' | 'progress' | 'proposal' | 'result';
  body: string;
  createdAt: string;
}

interface RawBoard {
  project: RawProject;
  agents: RawAgent[];
  tasks: RawTask[];
  questions: RawQuestion[];
  runs: RawRun[];
  interrupts: RawInterrupt[];
  events: RawEvent[];
}

function record(value: unknown, path: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return string(value, path);
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${path} must be a safe integer of at least ${minimum}`);
  }
  return Number(value);
}

function timestamp(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (Number.isNaN(Date.parse(parsed))) throw new Error(`${path} must be a timestamp`);
  return parsed;
}

function nullableTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : timestamp(value, path);
}

function member<T extends string>(value: unknown, values: ReadonlySet<T>, path: string): T {
  const parsed = string(value, path);
  if (!values.has(parsed as T)) throw new Error(`${path} has an unsupported value`);
  return parsed as T;
}

function array<T>(value: unknown, path: string, parse: (item: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => parse(item, `${path}[${index}]`));
}

function apiEntity(value: unknown, path: string): JsonRecord {
  const item = record(value, path);
  if (item.apiVersion !== API_VERSION) throw new Error(`${path}.apiVersion is incompatible`);
  return item;
}

function parseProject(value: unknown, path: string): RawProject {
  const item = apiEntity(value, path);
  return {
    projectId: string(item.projectId, `${path}.projectId`),
    name: string(item.name, `${path}.name`),
    description: string(item.description, `${path}.description`),
    version: integer(item.version, `${path}.version`, 1),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
  };
}

function parseAgent(value: unknown, path: string): RawAgent {
  const item = apiEntity(value, path);
  return {
    agentId: string(item.agentId, `${path}.agentId`),
    projectId: string(item.projectId, `${path}.projectId`),
    role: member(item.role, roles, `${path}.role`),
    area: string(item.area, `${path}.area`),
    mission: string(item.mission, `${path}.mission`),
    model: string(item.model, `${path}.model`),
    status: member(item.status, rawAgentStatuses, `${path}.status`),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
  };
}

function parseTask(value: unknown, path: string): RawTask {
  const item = apiEntity(value, path);
  const expectedAgentMinutes = integer(item.expectedAgentMinutes, `${path}.expectedAgentMinutes`, 15);
  if (expectedAgentMinutes % 15 !== 0) throw new Error(`${path}.expectedAgentMinutes must use a 15-minute interval`);
  const kind = member(item.kind, taskKinds, `${path}.kind`);
  const requiredRole = item.requiredRole === null ? null : member(item.requiredRole, roles, `${path}.requiredRole`);
  const assignedAgentId = nullableString(item.assignedAgentId, `${path}.assignedAgentId`);
  const assignedRole = item.assignedRole === null ? null : member(item.assignedRole, roles, `${path}.assignedRole`);
  if (kind === 'manager_review' ? requiredRole !== 'manager' : requiredRole !== null) {
    throw new Error(`${path}.requiredRole does not match its task kind`);
  }
  if ((assignedAgentId === null) !== (assignedRole === null)) throw new Error(`${path} has an incomplete assignment`);
  if (requiredRole !== null && assignedRole !== null && assignedRole !== requiredRole) {
    throw new Error(`${path}.assignedRole does not satisfy requiredRole`);
  }
  if (kind === 'human_check' && assignedAgentId !== null) throw new Error(`${path} human check cannot be assigned`);
  return {
    taskId: string(item.taskId, `${path}.taskId`),
    projectId: string(item.projectId, `${path}.projectId`),
    parentTaskId: nullableString(item.parentTaskId, `${path}.parentTaskId`),
    kind,
    requiredRole,
    title: string(item.title, `${path}.title`),
    objective: string(item.objective, `${path}.objective`),
    acceptanceCriteria: string(item.acceptanceCriteria, `${path}.acceptanceCriteria`),
    workspaceRefs: array(item.workspaceRefs, `${path}.workspaceRefs`, string),
    status: member(item.status, rawTaskStatuses, `${path}.status`),
    assignedAgentId,
    assignedRole,
    expectedAgentMinutes,
    startedAt: nullableTimestamp(item.startedAt, `${path}.startedAt`),
    expectedCompletedAt: nullableTimestamp(item.expectedCompletedAt, `${path}.expectedCompletedAt`),
    endedAt: nullableTimestamp(item.endedAt, `${path}.endedAt`),
    result: nullableString(item.result, `${path}.result`),
    version: integer(item.version, `${path}.version`, 1),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
  };
}

function parseQuestion(value: unknown, path: string): RawQuestion {
  const item = apiEntity(value, path);
  return {
    questionId: string(item.questionId, `${path}.questionId`),
    projectId: string(item.projectId, `${path}.projectId`),
    taskId: string(item.taskId, `${path}.taskId`),
    agentId: string(item.agentId, `${path}.agentId`),
    question: string(item.question, `${path}.question`),
    status: member(item.status, questionStatuses, `${path}.status`),
    answer: nullableString(item.answer, `${path}.answer`),
    askedAt: timestamp(item.askedAt, `${path}.askedAt`),
    answeredAt: nullableTimestamp(item.answeredAt, `${path}.answeredAt`),
    version: integer(item.version, `${path}.version`, 1),
  };
}

function parseRun(value: unknown, path: string): RawRun {
  const item = apiEntity(value, path);
  return {
    runId: string(item.runId, `${path}.runId`),
    projectId: string(item.projectId, `${path}.projectId`),
    agentId: string(item.agentId, `${path}.agentId`),
    taskId: nullableString(item.taskId, `${path}.taskId`),
    status: member(item.status, rawRunStatuses, `${path}.status`),
    startedAt: timestamp(item.startedAt, `${path}.startedAt`),
    endedAt: nullableTimestamp(item.endedAt, `${path}.endedAt`),
  };
}

function parseInterrupt(value: unknown, path: string): RawInterrupt {
  const item = apiEntity(value, path);
  return {
    sequence: integer(item.sequence, `${path}.sequence`, 1),
    agentId: string(item.agentId, `${path}.agentId`),
    runId: nullableString(item.runId, `${path}.runId`),
    requestedAt: timestamp(item.requestedAt, `${path}.requestedAt`),
  };
}

function parseEvent(value: unknown, path: string): RawEvent {
  const item = apiEntity(value, path);
  const actorType = string(item.actorType, `${path}.actorType`);
  if (actorType !== 'human' && actorType !== 'agent' && actorType !== 'system') {
    throw new Error(`${path}.actorType has an unsupported value`);
  }
  return {
    eventId: string(item.eventId, `${path}.eventId`),
    projectId: string(item.projectId, `${path}.projectId`),
    taskId: nullableString(item.taskId, `${path}.taskId`),
    actorType,
    actorId: string(item.actorId, `${path}.actorId`),
    eventType: string(item.eventType, `${path}.eventType`),
    data: record(item.data, `${path}.data`),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
  };
}

function parseMessage(value: unknown, path: string): RawMessage {
  const item = apiEntity(value, path);
  return {
    messageId: string(item.messageId, `${path}.messageId`),
    sequence: integer(item.sequence, `${path}.sequence`, 1),
    projectId: string(item.projectId, `${path}.projectId`),
    taskId: string(item.taskId, `${path}.taskId`),
    actorType: member(item.actorType, actorTypes, `${path}.actorType`),
    actorId: string(item.actorId, `${path}.actorId`),
    kind: member(item.kind, messageKinds, `${path}.kind`),
    body: string(item.body, `${path}.body`),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
  };
}

function parseRawBoard(value: unknown): RawBoard {
  const item = apiEntity(value, 'board');
  const open = array(item.openQuestions, 'board.openQuestions', parseQuestion);
  const recent = item.recentQuestions === undefined
    ? open
    : array(item.recentQuestions, 'board.recentQuestions', parseQuestion);
  return {
    project: parseProject(item.project, 'board.project'),
    agents: array(item.agents, 'board.agents', parseAgent),
    tasks: array(item.tasks, 'board.tasks', parseTask),
    questions: recent,
    runs: array(item.recentRuns, 'board.recentRuns', parseRun),
    interrupts: array(item.recentInterrupts, 'board.recentInterrupts', parseInterrupt),
    events: array(item.recentEvents, 'board.recentEvents', parseEvent),
  };
}

function taskStatus(status: RawTask['status'], hasOpenQuestion: boolean): TaskStatus {
  if (hasOpenQuestion) return 'waiting_for_human';
  const statuses: Record<RawTask['status'], TaskStatus> = {
    backlog: 'backlog',
    queued: 'queued',
    in_progress: 'running',
    blocked: 'blocked',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'interrupted',
  };
  return statuses[status];
}

function agentStatus(status: RawAgent['status']): AgentStatus {
  const statuses: Record<RawAgent['status'], AgentStatus> = {
    idle: 'sleeping',
    ready: 'queued',
    running: 'running',
    interrupting: 'interrupting',
    waiting_for_human: 'waiting_for_human',
  };
  return statuses[status];
}

function runStatus(status: RawRun['status']): RunStatus {
  return status === 'active' ? 'running' : status;
}

function eventRunId(event: RawEvent): string | null {
  return typeof event.data.runId === 'string' ? event.data.runId : null;
}

function eventWakeReason(event: RawEvent): WakeReason | null {
  const value = event.data.wakeReason;
  return typeof value === 'string' && wakeReasons.has(value as WakeReason) ? value as WakeReason : null;
}

function newest(values: Array<string | null | undefined>, fallback: string): string {
  return values.filter((value): value is string => typeof value === 'string').sort().at(-1) ?? fallback;
}

function normalize(boards: RawBoard[], listedProjects: RawProject[], rawMessages: RawMessage[]): BoardSnapshot {
  const tasksById = new Map<string, BoardTask>();
  const questions: BoardQuestion[] = boards.flatMap((board) => board.questions.map((question) => ({
    id: question.questionId,
    projectId: question.projectId,
    taskId: question.taskId,
    agentId: question.agentId,
    prompt: question.question,
    status: question.status,
    answer: question.answer,
    askedAt: question.askedAt,
    answeredAt: question.answeredAt,
    version: question.version,
  })));
  const openQuestionTasks = new Set(questions.filter((question) => question.status === 'open').map((question) => question.taskId));
  for (const raw of boards.flatMap((board) => board.tasks)) {
    tasksById.set(raw.taskId, {
      id: raw.taskId,
      projectId: raw.projectId,
      parentTaskId: raw.parentTaskId,
      kind: raw.kind,
      requiredRole: raw.requiredRole,
      title: raw.title,
      objective: raw.objective,
      acceptanceCriteria: raw.acceptanceCriteria,
      workspaceRefs: raw.workspaceRefs,
      assignedAgentId: raw.assignedAgentId,
      assignedRole: raw.assignedRole,
      status: taskStatus(raw.status, openQuestionTasks.has(raw.taskId)),
      expectedAgentMinutes: raw.expectedAgentMinutes,
      expectedCompletedAt: raw.expectedCompletedAt,
      startedAt: raw.startedAt,
      endedAt: raw.endedAt,
      result: raw.result,
      version: raw.version,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
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
        endedAt: raw.endedAt,
        interruptRequestedAt: interrupt?.requestedAt ?? null,
        createdAt: raw.startedAt,
      });
    }
  }

  const allRawTasks = boards.flatMap((board) => board.tasks);
  const agents: BoardAgent[] = boards.flatMap((board) => board.agents.map((raw) => {
    const owned = allRawTasks.filter((task) => task.assignedAgentId === raw.agentId);
    const current = owned.find((task) => task.status === 'in_progress' || task.status === 'blocked')
      ?? owned.find((task) => task.status === 'queued')
      ?? null;
    const activity = board.events.filter((event) => event.actorId === raw.agentId).map((event) => event.createdAt);
    return {
      id: raw.agentId,
      projectId: raw.projectId,
      name: raw.agentId,
      role: raw.role,
      area: raw.area,
      mission: raw.mission,
      model: raw.model,
      status: agentStatus(raw.status),
      currentTaskId: current?.taskId ?? null,
      lastEventAt: newest(activity, raw.createdAt),
      createdAt: raw.createdAt,
      updatedAt: newest(activity, raw.createdAt),
    };
  }));

  const projects: BoardProject[] = listedProjects.map((project) => ({
    id: project.projectId,
    name: project.name,
    description: project.description,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }));
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
  }));
  const generatedAt = newest([
    ...projects.map((project) => project.updatedAt),
    ...boards.flatMap((board) => board.events.map((event) => event.createdAt)),
    ...messages.map((message) => message.createdAt),
  ], new Date(0).toISOString());
  return {
    revision: projects.reduce((sum, project) => sum + (listedProjects.find((raw) => raw.projectId === project.id)?.version ?? 0), 0)
      + tasks.reduce((sum, task) => sum + task.version, 0),
    generatedAt,
    projects,
    agents,
    tasks,
    messages,
    questions,
    runs,
  };
}

/** Parses the task-board's authoritative single-project snapshot into the frontend projection. */
export function parseBoardSnapshot(value: unknown): BoardSnapshot {
  const board = parseRawBoard(value);
  return normalize([board], [board.project], []);
}

export class BoardApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BoardApiError';
  }
}

export interface TaskBoardClient {
  getSnapshot(signal?: AbortSignal): Promise<BoardSnapshot>;
  createProject(input: CreateProjectInput): Promise<void>;
  createAgent(input: CreateAgentInput): Promise<void>;
  createTask(input: CreateTaskInput): Promise<void>;
  assignTask(taskId: string, input: { agentId: string; expectedAgentMinutes: number; version: number }): Promise<void>;
  addMessage(taskId: string, input: { body: string; version: number }): Promise<void>;
  answerQuestion(questionId: string, input: { answer: string }): Promise<void>;
  resumeTask(taskId: string, input: { version: number }): Promise<void>;
  decideHumanCheck(taskId: string, input: { version: number; status: 'completed' | 'failed'; result: string }): Promise<void>;
  interruptRun(runId: string): Promise<void>;
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = `Task board request failed (${response.status})`;
  try {
    const value = record(await response.json(), 'error response');
    const error = record(value.error, 'error response.error');
    return typeof error.message === 'string' && error.message.length > 0 ? error.message : fallback;
  } catch {
    return fallback;
  }
}

function clientEventId(): string {
  return `ui-${crypto.randomUUID()}`;
}

function safeBaseUrl(value: string): string {
  const trimmed = value.replace(/\/$/, '');
  if (trimmed === '' || (trimmed.startsWith('/') && !trimmed.startsWith('//'))) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Task board URL is invalid');
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.username || parsed.password || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))) {
    throw new Error('Task board credentials require HTTPS or a loopback URL');
  }
  if (parsed.search || parsed.hash) throw new Error('Task board URL cannot include a query or fragment');
  return trimmed;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      result[index] = await operation(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}

export function createTaskBoardClient(options: {
  baseUrl?: string;
  token?: string;
  fetch?: typeof fetch;
} = {}): TaskBoardClient {
  const baseUrl = safeBaseUrl(options.baseUrl ?? '');
  const token = options.token?.trim() ?? '';
  const requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const agentRoles = new Map<string, CreateAgentInput['role']>();
  const questionVersions = new Map<string, number>();
  const taskAgents = new Map<string, string>();
  const taskPolicies = new Map<string, Readonly<{ kind: TaskKind; requiredRole: AgentRole | null }>>();
  const runAgents = new Map<string, string>();

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const response = await requestFetch(`${baseUrl}${path}`, {
      ...init,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: {
        ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init?.headers,
      },
    });
    if (!response.ok) throw new BoardApiError(await errorMessage(response), response.status);
    return response;
  }

  async function json(path: string, init?: RequestInit): Promise<unknown> {
    return request(path, init).then((response) => response.json());
  }

  async function post(path: string, body: unknown, idempotencyKey?: string): Promise<void> {
    await request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined,
    });
  }

  return {
    async getSnapshot(signal) {
      const projectsEnvelope = record(await json('/v1/projects', { signal }), 'projects response');
      const projects = array(projectsEnvelope.projects, 'projects response.projects', parseProject);
      const boards = await mapWithConcurrency(projects, 6, async (project) => {
        return parseRawBoard(await json(`/v1/projects/${encodeURIComponent(project.projectId)}/board`, { signal }));
      });
      const tasks = boards.flatMap((board) => board.tasks);
      const messageGroups = await mapWithConcurrency(tasks, 6, async (task) => {
        const envelope = record(await json(`/v1/tasks/${encodeURIComponent(task.taskId)}/messages?after=0`, { signal }), 'messages response');
        return array(envelope.messages, 'messages response.messages', parseMessage);
      });
      const rawMessages = messageGroups.flat();
      agentRoles.clear();
      questionVersions.clear();
      taskAgents.clear();
      taskPolicies.clear();
      runAgents.clear();
      for (const board of boards) {
        for (const agent of board.agents) agentRoles.set(agent.agentId, agent.role);
        for (const question of board.questions) questionVersions.set(question.questionId, question.version);
        for (const task of board.tasks) {
          taskPolicies.set(task.taskId, { kind: task.kind, requiredRole: task.requiredRole });
          if (task.assignedAgentId) taskAgents.set(task.taskId, task.assignedAgentId);
        }
        for (const run of board.runs) runAgents.set(run.runId, run.agentId);
      }
      return normalize(boards, projects, rawMessages);
    },
    async createProject(input) {
      await post('/v1/projects', input);
    },
    async createAgent(input) {
      const { projectId, ...body } = input;
      await post(`/v1/projects/${encodeURIComponent(projectId)}/agents`, body);
    },
    async createTask(input) {
      const { projectId, ...task } = input;
      await post(`/v1/projects/${encodeURIComponent(projectId)}/tasks`, {
        ...task,
        assignedAgentId: null,
        assignedRole: null,
      });
    },
    async assignTask(taskId, input) {
      const role = agentRoles.get(input.agentId);
      if (!role) throw new Error('Refresh the board before assigning this agent');
      const policy = taskPolicies.get(taskId);
      if (!policy) throw new Error('Refresh the board before assigning this task');
      if (policy.kind === 'human_check') throw new Error('Human checks cannot be assigned to agents');
      if (policy.requiredRole !== null && role !== policy.requiredRole) {
        throw new Error(`This task requires a ${policy.requiredRole} agent`);
      }
      await request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: input.version,
          assignedAgentId: input.agentId,
          assignedRole: role,
          expectedAgentMinutes: input.expectedAgentMinutes,
          status: 'queued',
        }),
      });
    },
    async addMessage(taskId, input) {
      void input.version;
      await post(`/v1/tasks/${encodeURIComponent(taskId)}/messages`, {
        clientEventId: clientEventId(),
        kind: 'note',
        body: input.body,
      });
    },
    async answerQuestion(questionId, input) {
      const version = questionVersions.get(questionId);
      if (!version) throw new Error('Refresh the board before answering this question');
      await post(`/v1/questions/${encodeURIComponent(questionId)}/answer`, { answer: input.answer, version });
    },
    async resumeTask(taskId, input) {
      if (taskPolicies.get(taskId)?.kind === 'human_check') throw new Error('Human checks cannot wake an agent');
      const agentId = taskAgents.get(taskId);
      if (!agentId) throw new Error('This task has no assigned agent to resume');
      await post(
        `/v1/agents/${encodeURIComponent(agentId)}/resume`,
        { reason: 'Human explicitly resumed this task', taskId },
        `resume:${taskId}:${input.version}`,
      );
    },
    async decideHumanCheck(taskId, input) {
      if (taskPolicies.get(taskId)?.kind !== 'human_check') throw new Error('Only human checks accept a human release decision');
      const result = input.result.trim();
      if (result.length === 0) throw new Error('A human decision rationale is required');
      await request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: input.version, status: input.status, result }),
      });
    },
    async interruptRun(runId) {
      const agentId = runAgents.get(runId);
      if (!agentId) throw new Error('Refresh the board before interrupting this run');
      await post(
        `/v1/agents/${encodeURIComponent(agentId)}/interrupt`,
        { reason: 'Human interrupted this agent from the task board' },
        `interrupt:${runId}`,
      );
    },
  };
}
