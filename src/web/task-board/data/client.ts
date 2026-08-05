import type {
  AgentQueryConversationTurn,
  AgentRole,
  AutomationConfiguration,
  BoardDocument,
  BoardProject,
  BoardSnapshot,
  BoardWorkItem,
  CreateAgentInput,
  CreateDocumentInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateWorkItemInput,
  ProjectArtifact,
  ProjectWorkflow,
  SaveAutomationConfigurationInput,
  TaskKind,
  WorkflowEvent,
} from '../types';
import {
  array,
  automationAgentTypeWire,
  automationStageWire,
  exactRecord,
  integer,
  maximumRawWorkItems,
  maximumTaskMessages,
  maximumWorkItemCursorBytes,
  maximumWorkItemPages,
  parseAutomationAgentType,
  parseAutomationConfiguration,
  parseAutomationStage,
  parseDocument,
  parseMessage,
  parseProject,
  parseRawBoard,
  parseWorkItem,
  record,
  string,
  validateAutomationParts,
  validateAutomationPayloadSize,
  type JsonRecord,
  type RawMessage,
  type RawTask,
  type RawWorkItem,
} from './parse';
import {
  documentProjection,
  normalize,
  projectProjection,
  workItemProjection,
} from '../model/project';
import { workItemPageSize } from './wire';

// Client-side paging for task messages. Deliberately NOT the contract's
// WORK_ITEM_PAGE_SIZE — same value today, different concerns.
const taskMessagePageSize = 200;
const maximumAgentQueryObjectiveCharacters = 8_000;
const maximumAgentQueryConversationCharacters = 2_400;
const maximumAgentQueryConversationTurns = 12;
const maximumAgentQueryTurnCharacters = 480;

export const agentQueryConversationContextMarker = '\n\nRecent POC conversation (context only; newest request is above):\n';
export const agentQueryRoutingContextMarker = '\n\nCompany routing map (use this only to identify the best project or agent):\n';

/** Parses the task-board's authoritative single-project snapshot into the frontend projection. */
export function parseBoardSnapshot(value: unknown): BoardSnapshot {
  const board = parseRawBoard(value);
  return normalize([board], [board.project], [], []);
}

/** Parses one authoritative document snapshot returned by the task board. */
export function parseBoardDocument(value: unknown): BoardDocument {
  return documentProjection(parseDocument(value, 'document'));
}

export function agentQueryPromptFromObjective(objective: string): string {
  const sectionIndexes = [
    objective.indexOf(agentQueryConversationContextMarker),
    objective.indexOf(agentQueryRoutingContextMarker),
  ].filter((index) => index >= 0);
  const promptEnd = sectionIndexes.length > 0 ? Math.min(...sectionIndexes) : objective.length;
  return objective.slice(0, promptEnd).trim();
}

function compactAgentQueryText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function truncateAgentQueryText(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) return value;
  if (maximumCharacters <= 1) return '…'.slice(0, maximumCharacters);
  return `${value.slice(0, maximumCharacters - 1).trimEnd()}…`;
}

function recentAgentQueryConversation(
  turns: AgentQueryConversationTurn[],
  newestPrompt: string,
): string {
  const newestPromptKey = compactAgentQueryText(newestPrompt);
  const selected: string[] = [];
  const seen = new Set<string>();
  let characters = 0;

  for (let index = turns.length - 1; index >= 0 && selected.length < maximumAgentQueryConversationTurns; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    const body = compactAgentQueryText(turn.body);
    if (!body || (turn.role === 'human' && body === newestPromptKey)) continue;
    const key = `${turn.role}\u0000${body}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const label = turn.role === 'human' ? 'Human' : 'Agent';
    const line = `${label}: ${truncateAgentQueryText(body, maximumAgentQueryTurnCharacters)}`;
    const separatorCharacters = selected.length > 0 ? 1 : 0;
    if (characters + separatorCharacters + line.length > maximumAgentQueryConversationCharacters) break;
    selected.unshift(line);
    characters += separatorCharacters + line.length;
  }

  return selected.join('\n');
}

function appendAgentQuerySection(objective: string, marker: string, content: string): string {
  if (!content) return objective;
  const availableCharacters = maximumAgentQueryObjectiveCharacters - objective.length - marker.length;
  if (availableCharacters <= 0) return objective;
  return `${objective}${marker}${truncateAgentQueryText(content, availableCharacters)}`;
}

function automationConfigurationFromEnvelope(value: unknown, path: string): AutomationConfiguration {
  const envelope = exactRecord(value, path, ['configuration']);
  return parseAutomationConfiguration(envelope.configuration, `${path}.configuration`);
}

function automationConfigurationUpdateBody(input: SaveAutomationConfigurationInput): JsonRecord {
  const version = integer(input.version, 'automation configuration update.version', 1);
  const rawAgentTypes = input.agentTypes.map(automationAgentTypeWire);
  const agentTypes = rawAgentTypes.map((agentType, index) => parseAutomationAgentType(agentType, `automation configuration update.agentTypes[${index}]`));
  const rawStages = input.stages.map(automationStageWire);
  const stages = rawStages.map((entry, index) => parseAutomationStage(entry, `automation configuration update.stages[${index}]`));
  validateAutomationParts(agentTypes, stages, 'automation configuration update');
  validateAutomationPayloadSize(agentTypes, stages, 'automation configuration update');
  return { version, agentTypes: rawAgentTypes, stages: rawStages };
}

function documentFromEnvelope(value: unknown, path: string): BoardDocument {
  const envelope = record(value, path);
  return documentProjection(parseDocument(envelope.document, `${path}.document`));
}

function projectFromEnvelope(value: unknown, path: string): BoardProject {
  const envelope = record(value, path);
  return projectProjection(parseProject(envelope.project, `${path}.project`));
}

function workItemFromEnvelope(value: unknown, path: string): BoardWorkItem {
  const envelope = record(value, path);
  return workItemProjection(parseWorkItem(envelope.workItem, `${path}.workItem`));
}

function workItemPageFromEnvelope(value: unknown, path: string): {
  workItems: RawWorkItem[];
  nextCursor: string | null;
} {
  const envelope = record(value, path);
  if (!Array.isArray(envelope.workItems)) throw new Error(`${path}.workItems must be an array`);
  if (envelope.workItems.length > workItemPageSize) {
    throw new Error(`${path}.workItems cannot contain more than ${workItemPageSize} records`);
  }
  const workItems = envelope.workItems.map((item, index) => parseWorkItem(item, `${path}.workItems[${index}]`));
  if (!('nextCursor' in envelope)) return { workItems, nextCursor: null };
  const nextCursor = string(envelope.nextCursor, `${path}.nextCursor`);
  if (
    nextCursor.length === 0
    || new TextEncoder().encode(nextCursor).byteLength > maximumWorkItemCursorBytes
  ) {
    throw new Error(`${path}.nextCursor must be a nonempty string no larger than ${maximumWorkItemCursorBytes} UTF-8 bytes`);
  }
  return { workItems, nextCursor };
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

export class DocumentStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentStreamError';
  }
}

export interface TaskBoardClient {
  readonly documentClientId: string;
  getSnapshot(signal?: AbortSignal): Promise<BoardSnapshot>;
  getAutomationConfiguration(signal?: AbortSignal): Promise<AutomationConfiguration>;
  saveAutomationConfiguration(input: SaveAutomationConfigurationInput): Promise<AutomationConfiguration>;
  getDocument(documentId: string, signal?: AbortSignal): Promise<BoardDocument>;
  createDocument(input: CreateDocumentInput): Promise<BoardDocument>;
  changeDocumentPen(documentId: string, input: {
    action: 'acquire' | 'release';
    expectedPenEpoch: number;
    force: boolean;
  }): Promise<BoardDocument>;
  saveDocumentSnapshot(documentId: string, input: {
    penEpoch: number;
    contentVersion: number;
    content: string;
  }): Promise<BoardDocument>;
  subscribeDocument(input: {
    documentId: string;
    after: number;
    signal: AbortSignal;
    onDocument: (document: BoardDocument) => void;
  }): Promise<void>;
  createProject(input: CreateProjectInput): Promise<BoardProject>;
  createWorkItem(input: CreateWorkItemInput): Promise<BoardWorkItem>;
  createAgent(input: CreateAgentInput): Promise<void>;
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
  reorderTask(taskId: string, input: { orderKey: number; version: number }): Promise<void>;
  returnTaskToBacklog(taskId: string, input: { version: number }): Promise<void>;
  addMessage(taskId: string, input: { body: string; version: number }): Promise<void>;
  answerQuestion(questionId: string, input: { answer: string }): Promise<void>;
  resumeTask(taskId: string, input: { version: number }): Promise<void>;
  decideHumanCheck(taskId: string, input: { version: number; status: 'completed' | 'failed'; result: string }): Promise<void>;
  interruptRun(runId: string): Promise<void>;
  getProjectWorkflow(projectId: string, signal?: AbortSignal): Promise<ProjectWorkflow>;
  getProjectArtifacts(projectId: string, signal?: AbortSignal): Promise<ProjectArtifact[]>;
  confirmWorkflow(planRevisionId: string): Promise<ProjectWorkflow>;
  subscribeProjectEvents(input: {
    projectId: string;
    after: number;
    signal: AbortSignal;
    onEvent: (event: WorkflowEvent) => void;
  }): Promise<void>;
  getArtifactBlob(artifactId: string, signal?: AbortSignal): Promise<Blob>;
  uploadArtifact(projectId: string, input: {
    mediaType: string;
    caption: string;
    contentBase64: string;
  }): Promise<ProjectArtifact>;
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

export function randomUuid(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  if (typeof source?.getRandomValues !== 'function') {
    throw new Error('This browser cannot generate secure random identifiers');
  }
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

function clientEventId(): string {
  return `ui-${randomUuid()}`;
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
    throw new Error('Task board URL requires HTTPS or a loopback host');
  }
  if (parsed.search || parsed.hash) throw new Error('Task board URL cannot include a query or fragment');
  return trimmed;
}

const documentClientStorageKey = 'cicada.documentClientId';
const documentClientOwnerStoragePrefix = 'cicada.documentClientOwner.';
const documentClientRuntimeNonce = `document-runtime-${randomUuid()}`;
let runtimeDocumentClientId: string | null = null;
let runtimeDocumentClientOwnerKey: string | null = null;
let documentClientCleanupRegistered = false;

function newDocumentClientId(): string {
  return `document-ui-${randomUuid()}`;
}

function documentClientOwnerKey(clientId: string): string {
  return `${documentClientOwnerStoragePrefix}${clientId}`;
}

function registerDocumentClientCleanup(): void {
  if (documentClientCleanupRegistered || typeof globalThis.addEventListener !== 'function') return;
  documentClientCleanupRegistered = true;
  globalThis.addEventListener('pagehide', (event) => {
    if ('persisted' in event && event.persisted === true) return;
    const ownerKey = runtimeDocumentClientOwnerKey;
    if (!ownerKey) return;
    try {
      if (globalThis.localStorage?.getItem(ownerKey) === documentClientRuntimeNonce) {
        globalThis.localStorage.removeItem(ownerKey);
      }
    } catch {
      // A storage policy change must not make page navigation fail.
    }
  });
}

function claimDocumentClientId(clientId: string, storage: Storage): boolean {
  const ownerKey = documentClientOwnerKey(clientId);
  const currentOwner = storage.getItem(ownerKey);
  if (currentOwner && currentOwner !== documentClientRuntimeNonce) return false;
  storage.setItem(ownerKey, documentClientRuntimeNonce);
  if (storage.getItem(ownerKey) !== documentClientRuntimeNonce) return false;
  runtimeDocumentClientOwnerKey = ownerKey;
  registerDocumentClientCleanup();
  return true;
}

function stableDocumentClientId(configured?: string): string {
  const supplied = configured?.trim();
  if (supplied) return supplied;
  if (runtimeDocumentClientId) return runtimeDocumentClientId;

  let session: Storage | undefined;
  try {
    session = globalThis.sessionStorage;
    const local = globalThis.localStorage;
    if (!session || !local) throw new Error('Browser storage is unavailable');

    const stored = session.getItem(documentClientStorageKey)?.trim();
    let selected: string | null = null;
    if (stored && claimDocumentClientId(stored, local)) {
      selected = stored;
    } else {
      for (let attempt = 0; attempt < 3 && !selected; attempt += 1) {
        const candidate = newDocumentClientId();
        if (claimDocumentClientId(candidate, local)) selected = candidate;
      }
    }
    if (!selected) throw new Error('Document client ownership could not be claimed');
    session.setItem(documentClientStorageKey, selected);
    runtimeDocumentClientId = selected;
  } catch {
    // Without a shared ownership claim, reusing copied session storage is unsafe.
    const claimedOwnerKey = runtimeDocumentClientOwnerKey;
    try {
      if (claimedOwnerKey && globalThis.localStorage?.getItem(claimedOwnerKey) === documentClientRuntimeNonce) {
        globalThis.localStorage.removeItem(claimedOwnerKey);
      }
    } catch {
      // Storage is already known to be unreliable; continue with runtime state.
    }
    runtimeDocumentClientOwnerKey = null;
    runtimeDocumentClientId = newDocumentClientId();
    try {
      session?.setItem(documentClientStorageKey, runtimeDocumentClientId);
    } catch {
      // The runtime-scoped value still keeps repeated client creation stable.
    }
  }
  return runtimeDocumentClientId;
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

const maximumDocumentEventBytes = 2 * 1024 * 1024;

function dispatchDocumentEvent(
  frame: string,
  onDocument: (document: BoardDocument) => void,
): void {
  let eventName = 'message';
  let eventId: string | null = null;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (line === '' || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'id') eventId = value;
    else if (field === 'data') data.push(value);
  }
  if (eventName !== 'document') return;
  if (eventId === null || !/^(?:0|[1-9]\d*)$/u.test(eventId)) {
    throw new DocumentStreamError('The document stream returned an invalid event cursor.');
  }
  const sequence = Number(eventId);
  if (!Number.isSafeInteger(sequence)) throw new DocumentStreamError('The document stream cursor is too large.');
  let decoded: unknown;
  try {
    decoded = JSON.parse(data.join('\n')) as unknown;
  } catch {
    throw new DocumentStreamError('The document stream returned invalid JSON.');
  }
  const envelope = record(decoded, 'document event');
  const document = documentProjection(parseDocument(envelope.document, 'document event.document'));
  if (document.sequence !== sequence) {
    throw new DocumentStreamError('The document stream cursor does not match its document snapshot.');
  }
  onDocument(document);
}

async function consumeDocumentStream(
  response: Response,
  onDocument: (document: BoardDocument) => void,
): Promise<void> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^text\/event-stream(?:\s*;|$)/iu.test(contentType)) {
    throw new DocumentStreamError('The document stream did not return server-sent events.');
  }
  if (!response.body) throw new DocumentStreamError('The document stream returned no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const next = await reader.read();
      pending += decoder.decode(next.value, { stream: !next.done });
      let boundary = /\r?\n\r?\n/u.exec(pending);
      while (boundary) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        if (frame.length > maximumDocumentEventBytes) {
          throw new DocumentStreamError('A document stream event exceeded the size limit.');
        }
        if (frame.trim().length > 0) dispatchDocumentEvent(frame, onDocument);
        boundary = /\r?\n\r?\n/u.exec(pending);
      }
      if (pending.length > maximumDocumentEventBytes) {
        throw new DocumentStreamError('A document stream event exceeded the size limit.');
      }
      if (next.done) break;
    }
    if (pending.trim().length > 0) dispatchDocumentEvent(pending, onDocument);
  } finally {
    reader.releaseLock();
  }
}

export function createTaskBoardClient(options: {
  baseUrl?: string;
  fetch?: typeof fetch;
  documentClientId?: string;
} = {}): TaskBoardClient {
  const baseUrl = safeBaseUrl(options.baseUrl ?? '');
  const requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const documentClientId = stableDocumentClientId(options.documentClientId);
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

  async function taskMessages(task: RawTask, signal?: AbortSignal): Promise<RawMessage[]> {
    const messages: RawMessage[] = [];
    let after = 0;
    while (true) {
      const envelope = record(
        await json(`/v1/tasks/${encodeURIComponent(task.taskId)}/messages?after=${after}`, { signal }),
        'messages response',
      );
      const page = array(envelope.messages, 'messages response.messages', parseMessage);
      const cursor = integer(envelope.cursor, 'messages response.cursor');
      if (page.length > taskMessagePageSize) throw new Error('messages response exceeded the page size limit');
      if (cursor < after) throw new Error('messages response cursor moved backwards');
      if (page.length === 0) {
        if (cursor !== after) throw new Error('messages response cursor advanced without messages');
        return messages;
      }
      if (cursor === after) throw new Error('messages response cursor did not advance');

      let previousSequence = after;
      for (const message of page) {
        if (message.taskId !== task.taskId || message.projectId !== task.projectId) {
          throw new Error('messages response belongs to another task or project');
        }
        if (message.sequence <= previousSequence) throw new Error('messages response is not in chronological order');
        previousSequence = message.sequence;
      }
      if (cursor !== previousSequence) throw new Error('messages response cursor does not match its final message');
      if (messages.length + page.length > maximumTaskMessages) {
        throw new Error(`messages response exceeded the ${maximumTaskMessages}-message task limit`);
      }
      messages.push(...page);
      if (page.length < taskMessagePageSize) return messages;
      after = cursor;
    }
  }

  async function paginatedWorkItems(initialValue: unknown, signal?: AbortSignal): Promise<RawWorkItem[]> {
    const merged: RawWorkItem[] = [];
    const positionsById = new Map<string, number>();
    const seenCursors = new Set<string>();
    let value = initialValue;
    let pages = 0;
    let rawRows = 0;

    while (true) {
      pages += 1;
      const page = workItemPageFromEnvelope(value, `work items response page ${pages}`);
      rawRows += page.workItems.length;
      if (rawRows > maximumRawWorkItems) {
        throw new Error(`work items response exceeded the ${maximumRawWorkItems.toLocaleString()}-record raw pagination limit`);
      }
      for (const workItem of page.workItems) {
        const position = positionsById.get(workItem.workItemId);
        if (position === undefined) {
          positionsById.set(workItem.workItemId, merged.length);
          merged.push(workItem);
        } else if (workItem.version > merged[position]!.version) {
          merged[position] = workItem;
        }
      }

      const cursor = page.nextCursor;
      if (cursor === null) return merged;
      if (seenCursors.has(cursor)) throw new Error('work items response repeated a pagination cursor');
      seenCursors.add(cursor);
      if (pages >= maximumWorkItemPages || rawRows >= maximumRawWorkItems) {
        throw new Error(`work items response exceeded the ${maximumWorkItemPages}-page or ${maximumRawWorkItems.toLocaleString()}-record pagination limit`);
      }
      value = await json(`/v1/work-items?cursor=${encodeURIComponent(cursor)}`, { signal });
    }
  }

  return {
    documentClientId,
    async getProjectWorkflow(projectId, signal) {
      const envelope = record(await json(`/v1/projects/${encodeURIComponent(projectId)}/workflow`, { signal }), 'workflow response');
      const workflow = record(envelope.workflow, 'workflow response.workflow');
      return {
        plans: array(workflow.plans, 'workflow plans', (value) => record(value, 'workflow plan')) as unknown as ProjectWorkflow['plans'],
        nodes: array(workflow.nodes, 'workflow nodes', (value) => record(value, 'workflow node')) as unknown as ProjectWorkflow['nodes'],
        handoffs: array(workflow.handoffs, 'workflow handoffs', (value) => record(value, 'workflow handoff')) as unknown as ProjectWorkflow['handoffs'],
        events: array(workflow.events, 'workflow events', (value) => record(value, 'workflow event')) as unknown as ProjectWorkflow['events'],
      };
    },
    async getProjectArtifacts(projectId, signal) {
      const envelope = record(await json(`/v1/projects/${encodeURIComponent(projectId)}/artifacts`, { signal }), 'artifacts response');
      return array(envelope.artifacts, 'artifacts response.artifacts', (value) => record(value, 'artifact')) as unknown as ProjectArtifact[];
    },
    async confirmWorkflow(planRevisionId) {
      const envelope = record(await json(`/v1/plans/${encodeURIComponent(planRevisionId)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ expectedState: 'proposed' }),
      }), 'confirm workflow response');
      const workflow = record(envelope.workflow, 'confirm workflow response.workflow');
      return {
        plans: array(workflow.plans, 'workflow plans', (value) => record(value, 'workflow plan')) as unknown as ProjectWorkflow['plans'],
        nodes: array(workflow.nodes, 'workflow nodes', (value) => record(value, 'workflow node')) as unknown as ProjectWorkflow['nodes'],
        handoffs: array(workflow.handoffs, 'workflow handoffs', (value) => record(value, 'workflow handoff')) as unknown as ProjectWorkflow['handoffs'],
        events: array(workflow.events, 'workflow events', (value) => record(value, 'workflow event')) as unknown as ProjectWorkflow['events'],
      };
    },
    async subscribeProjectEvents(input) {
      const response = await request(
        `/v1/projects/${encodeURIComponent(input.projectId)}/workflow/events?after=${input.after}`,
        { signal: input.signal, headers: { accept: 'text/event-stream' } },
      );
      if (!response.body) throw new Error('The workflow event stream returned no body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      try {
        while (true) {
          const chunk = await reader.read();
          pending += decoder.decode(chunk.value, { stream: !chunk.done });
          let boundary = pending.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const data = frame.split(/\r?\n/u).filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
            if (data) {
              const envelope = record(JSON.parse(data) as unknown, 'workflow event');
              input.onEvent(record(envelope.event, 'workflow event.event') as unknown as WorkflowEvent);
            }
            boundary = pending.indexOf('\n\n');
          }
          if (pending.length > 64 * 1_024) throw new Error('A workflow event exceeded the size limit');
          if (chunk.done) return;
        }
      } finally {
        reader.releaseLock();
      }
    },
    async getArtifactBlob(artifactId, signal) {
      return request(`/v1/artifacts/${encodeURIComponent(artifactId)}`, { signal }).then((response) => response.blob());
    },
    async uploadArtifact(projectId, input) {
      const envelope = record(await json(`/v1/projects/${encodeURIComponent(projectId)}/artifacts`, {
        method: 'POST',
        body: JSON.stringify({ nodeId: null, taskId: null, ...input }),
      }), 'upload artifact response');
      return record(envelope.artifact, 'upload artifact response.artifact') as unknown as ProjectArtifact;
    },
    async getSnapshot(signal) {
      const [projectsValue, workItemsValue] = await Promise.all([
        json('/v1/projects', { signal }),
        json('/v1/work-items', { signal }),
      ]);
      const projectsEnvelope = record(projectsValue, 'projects response');
      const projects = array(projectsEnvelope.projects, 'projects response.projects', parseProject);
      const workItems = await paginatedWorkItems(workItemsValue, signal);
      const boards = await mapWithConcurrency(projects, 6, async (project) => {
        return parseRawBoard(await json(`/v1/projects/${encodeURIComponent(project.projectId)}/board`, { signal }));
      });
      const tasks = boards.flatMap((board) => board.tasks);
      const messageGroups = await mapWithConcurrency(tasks, 6, (task) => taskMessages(task, signal));
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
      return normalize(boards, projects, rawMessages, workItems);
    },
    async getAutomationConfiguration(signal) {
      return automationConfigurationFromEnvelope(
        await json('/v1/automation-configuration', { signal }),
        'automation configuration response',
      );
    },
    async saveAutomationConfiguration(input) {
      return automationConfigurationFromEnvelope(
        await json('/v1/automation-configuration', {
          method: 'PATCH',
          body: JSON.stringify(automationConfigurationUpdateBody(input)),
        }),
        'save automation configuration response',
      );
    },
    async getDocument(documentId, signal) {
      return documentFromEnvelope(
        await json(`/v1/documents/${encodeURIComponent(documentId)}`, { signal }),
        'document response',
      );
    },
    async createDocument(input) {
      const title = input.title.trim();
      if (title.length === 0) throw new Error('Enter a document title');
      return documentFromEnvelope(
        await json(`/v1/projects/${encodeURIComponent(input.projectId)}/documents`, {
          method: 'POST',
          body: JSON.stringify({
            title,
            contentType: 'text/markdown',
            content: input.content,
            clientId: documentClientId,
          }),
        }),
        'create document response',
      );
    },
    async changeDocumentPen(documentId, input) {
      return documentFromEnvelope(
        await json(`/v1/documents/${encodeURIComponent(documentId)}/pen`, {
          method: 'POST',
          body: JSON.stringify({
            action: input.action,
            clientId: documentClientId,
            expectedPenEpoch: input.expectedPenEpoch,
            force: input.force,
          }),
        }),
        'document pen response',
      );
    },
    async saveDocumentSnapshot(documentId, input) {
      return documentFromEnvelope(
        await json(`/v1/documents/${encodeURIComponent(documentId)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            clientId: documentClientId,
            penEpoch: input.penEpoch,
            contentVersion: input.contentVersion,
            content: input.content,
          }),
        }),
        'save document response',
      );
    },
    async subscribeDocument(input) {
      if (!Number.isSafeInteger(input.after) || input.after < 0) {
        throw new Error('Document event cursor must be a non-negative safe integer');
      }
      const response = await request(
        `/v1/documents/${encodeURIComponent(input.documentId)}/events?after=${input.after}`,
        { signal: input.signal, headers: { accept: 'text/event-stream' } },
      );
      await consumeDocumentStream(response, input.onDocument);
    },
    async createProject(input) {
      return projectFromEnvelope(
        await json('/v1/projects', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
        'create project response',
      );
    },
    async createWorkItem(input) {
      const originalRequest = input.originalRequest.trim();
      if (originalRequest.length === 0) throw new Error('Enter a task');
      if (originalRequest.length > 16_000) throw new Error('Tasks cannot exceed 16,000 characters');
      const idempotencyKey = input.idempotencyKey.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(idempotencyKey)) {
        throw new Error('Task submission has an invalid idempotency key');
      }
      if (input.projectTarget.mode === 'explicit' && input.projectTarget.projectId.trim().length === 0) {
        throw new Error('Choose a project or use automatic project selection');
      }
      return workItemFromEnvelope(
        await json('/v1/work-items', {
          method: 'POST',
          body: JSON.stringify({
            originalRequest,
            priority: input.priority,
            projectTarget: input.projectTarget,
          }),
          headers: { 'idempotency-key': idempotencyKey },
        }),
        'create work item response',
      );
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
    async createAgentQuery(input) {
      const prompt = input.prompt.trim();
      if (prompt.length === 0) throw new Error('Enter a question or request for this agent');
      if (prompt.length > maximumAgentQueryObjectiveCharacters) throw new Error('Agent questions and requests cannot exceed 8,000 characters');
      const recentConversation = recentAgentQueryConversation(input.recentConversation ?? [], prompt);
      const routingContext = input.routingContext?.trim();
      const objectiveWithConversation = appendAgentQuerySection(
        prompt,
        agentQueryConversationContextMarker,
        recentConversation,
      );
      const objective = appendAgentQuerySection(
        objectiveWithConversation,
        agentQueryRoutingContextMarker,
        routingContext ?? '',
      );
      const workspaceRefs = [...new Set(input.workspaceRefs)].slice(0, 32);
      const titlePrefix = `Request for ${input.agentId}: `;
      const titleSummary = prompt.replace(/\s+/gu, ' ');
      await post(`/v1/projects/${encodeURIComponent(input.projectId)}/tasks`, {
        parentTaskId: null,
        title: `${titlePrefix}${titleSummary}`.slice(0, 240).trimEnd(),
        objective,
        acceptanceCriteria: 'Return a concise answer or result. If more work is needed, propose child tasks for human approval; do not assign agents or deploy.',
        workspaceRefs,
        assignedAgentId: input.agentId,
        assignedRole: input.assignedRole,
        requiresReview: false,
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
          status: 'queued',
        }),
      });
    },
    async reorderTask(taskId, input) {
      if (!Number.isSafeInteger(input.orderKey) || input.orderKey < 0) {
        throw new Error('Task order must be a non-negative safe integer');
      }
      await request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: input.version, orderKey: input.orderKey }),
      });
    },
    async returnTaskToBacklog(taskId, input) {
      await request(`/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: input.version,
          assignedAgentId: null,
          assignedRole: null,
          status: 'backlog',
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
