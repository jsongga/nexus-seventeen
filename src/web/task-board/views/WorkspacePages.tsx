import {
  KeyRound,
  MessageSquareText,
  Plus,
  Send,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, Pill, cn } from '../../components/ui';
import { ActivityFeed, type ActivityFeedUpdate } from '../project/ActivityFeed';
import { agentQueryPromptFromObjective } from '../data/client';
import type { TaskBoardClient } from '../data/client';
import { ContextSidebar, type ContextDocument } from '../project/ContextSidebar';
import { parseProjectMetadata, type ProjectMetadataEntry } from '../model/project-metadata';
import { ThreadPipelineTable } from '../project/ThreadPipelineTable';
import type { AgentQueryConversationTurn, BoardAgent, BoardDocumentSummary, BoardProject, BoardQuestion, BoardSnapshot, ProjectArtifact, RotateAgentTokenResult } from '../types';
import { WorkspaceHeader } from '../project/WorkspaceHeader';
import {
  agentPipelineFocus,
  type ProjectUpdate,
  updatesForProject,
} from '../model/workspace-model';
import { laneConfigurationState } from '../model/lane-config';

const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function formatTime(value: string | null): string {
  if (value === null) return 'Not recorded';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : dateTime.format(parsed);
}

function projectLinkLabel(href: string): string {
  const url = new URL(href);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/u, '');
  return `${url.host}${path}${url.search}${url.hash}`;
}

function resourceId(entry: ProjectMetadataEntry, index: number): string {
  return `${entry.key}:${entry.value}:${index}`;
}

function contextDocuments(entries: ProjectMetadataEntry[]): ContextDocument[] {
  return entries.map((entry, index) => ({
    ...entry,
    id: resourceId(entry, index),
    meta: entry.href ? projectLinkLabel(entry.href) : entry.value,
  }));
}

function boardDocumentMeta(document: BoardDocumentSummary): string {
  return `Updated ${formatTime(document.updatedAt)} · Version ${document.contentVersion}`;
}

function projectDocuments(projectId: string, documents: BoardDocumentSummary[]): ContextDocument[] {
  return documents
    .filter((document) => document.projectId === projectId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title))
    .map((document) => ({
      id: `document:${document.id}`,
      label: document.title,
      value: document.title,
      href: null,
      meta: boardDocumentMeta(document),
      documentId: document.id,
    }));
}

/** Adds every artifact to the feed without duplicating it across task messages. */
function activityUpdates(updates: ProjectUpdate[], artifacts: ProjectArtifact[]): ActivityFeedUpdate[] {
  const taskTitleById = new Map(updates.map((update) => [update.taskId, update.taskTitle]));

  const artifactUpdates = artifacts.map((artifact): ActivityFeedUpdate => {
    const taskTitle = artifact.taskId ? taskTitleById.get(artifact.taskId) : undefined;
    return {
      id: `artifact:${artifact.artifactId}`,
      author: 'Artifact',
      body: taskTitle
        ? `${artifact.caption} was added to ${taskTitle}.`
        : `${artifact.caption} was added to the project.`,
      createdAt: artifact.createdAt,
      artifacts: [{
        artifactId: artifact.artifactId,
        caption: artifact.caption,
        mediaType: artifact.mediaType,
      }],
    };
  });

  return [
    ...updates.map((update): ActivityFeedUpdate => ({
      id: update.id,
      author: update.author,
      body: update.body,
      createdAt: update.createdAt,
      artifacts: [],
    })),
    ...artifactUpdates,
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function ProjectPage({
  project,
  snapshot,
  onTask,
  onAddTask,
  onSelectDocument,
  client,
  connected,
}: {
  project: BoardProject;
  snapshot: BoardSnapshot;
  onTask: (taskId: string) => void;
  onAddTask: () => void;
  onSelectDocument: (documentId: string) => void;
  client: TaskBoardClient;
  connected: boolean;
}) {
  const [artifacts, setArtifacts] = useState<ProjectArtifact[]>([]);
  const [artifactUrls, setArtifactUrls] = useState<Record<string, string>>({});
  const [pausing, setPausing] = useState(false);
  const [pausedRunIds, setPausedRunIds] = useState<Set<string>>(() => new Set());
  const [pauseError, setPauseError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void client.getProjectArtifacts(project.id, controller.signal).then((nextArtifacts) => {
      setArtifacts((current) => (
        current.length === nextArtifacts.length &&
        current.every((artifact, index) => artifact.artifactId === nextArtifacts[index]?.artifactId)
          ? current
          : nextArtifacts
      ));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [client, project.id, snapshot.generatedAt]);

  useEffect(() => {
    const controller = new AbortController();
    const created: string[] = [];
    let disposed = false;
    setArtifactUrls({});
    void Promise.all(artifacts.map(async (artifact) => {
      const url = URL.createObjectURL(await client.getArtifactBlob(artifact.artifactId, controller.signal));
      created.push(url);
      return [artifact.artifactId, url] as const;
    })).then((entries) => {
      if (!disposed) setArtifactUrls(Object.fromEntries(entries));
    }).catch(() => undefined);
    return () => {
      disposed = true;
      controller.abort();
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [artifacts, client]);

  const updates = updatesForProject(snapshot, project.id);
  const metadata = parseProjectMetadata(project.description);
  const tasks = snapshot.tasks
    .filter((task) => task.projectId === project.id)
    .sort((left, right) => left.orderKey - right.orderKey || left.id.localeCompare(right.id));
  const agents = snapshot.agents.filter((agent) => agent.projectId === project.id);
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const documents = [
    ...projectDocuments(project.id, snapshot.documents),
    ...contextDocuments(metadata.entries),
  ];
  const feedUpdates = activityUpdates(updates, artifacts);
  const activeRuns = snapshot.runs.filter((run) => (
    run.projectId === project.id
      && (run.status === 'running' || run.status === 'queued')
      && run.interruptRequestedAt === null
      && !pausedRunIds.has(run.id)
  ));

  const pauseAgents = async () => {
    setPausing(true);
    setPauseError(null);
    const results = await Promise.allSettled(activeRuns.map((run) => client.interruptRun(run.id)));
    const pausedIds = activeRuns.flatMap((run, index) => results[index]?.status === 'fulfilled' ? [run.id] : []);
    if (pausedIds.length > 0) {
      setPausedRunIds((current) => new Set([...current, ...pausedIds]));
    }
    if (results.some((result) => result.status === 'rejected')) {
      setPauseError('Some active agents could not be paused. Refresh and try again.');
    }
    setPausing(false);
  };

  const openArtifact = (artifactId: string) => {
    const url = artifactUrls[artifactId];
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-w-0 flex-col overflow-hidden bg-canvas lg:h-dvh">
      <WorkspaceHeader
        eyebrow="Workspace, Project Overview"
        title={project.name}
        actions={(
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-[99px] border-0 bg-canvas text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
            aria-label="Add task"
            title="Add task"
            disabled={!connected}
            onClick={onAddTask}
          >
            <Plus size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex-row">
        <ContextSidebar
          intro={metadata.summaries.join('\n\n') || `Project context and reference materials for ${project.name}.`}
          documents={documents}
          onSelectDocument={onSelectDocument}
          orderStorageKey={`nexus-seventeen:project-resources:${project.id}`}
        />
        <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-hidden p-4 sm:gap-8 sm:p-8">
          <ThreadPipelineTable tasks={tasks} agentById={agentById} onTask={onTask} />
          <div className="flex min-h-0 flex-1 flex-col">
            <ActivityFeed updates={feedUpdates} artifactUrls={artifactUrls} onOpenArtifact={openArtifact} />
            {pauseError ? <p className="pt-2 text-right text-[11px] text-urgent" role="alert">{pauseError}</p> : null}
            <div className="mt-auto flex justify-end gap-2 pt-4">
              <Button
                variant="secondary"
                size="sm"
                className="!min-h-0 !border-0 !bg-muted-surface !px-4 !py-2"
                disabled={!connected || activeRuns.length === 0 || pausing}
                title={!connected ? 'Reconnect the task board to pause agents' : activeRuns.length === 0 ? 'No active agents to pause' : undefined}
                onClick={() => void pauseAgents()}
              >
                {pausing ? 'Pausing…' : 'Pause Agents'}
              </Button>
              {/* Compile reporting stays disabled because no report endpoint exists. */}
              <Button
                variant="primary"
                size="sm"
                className="!min-h-0 !border-0 !px-4 !py-2"
                disabled
                title="Compile Report is not implemented yet"
              >
                Compile Report
              </Button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

interface AgentPageProps {
  agent: BoardAgent;
  snapshot: BoardSnapshot;
  isPointOfContact: boolean;
  explicitPointOfContact: boolean;
  busy: boolean;
  onTask: (taskId: string) => void;
  onSend: (prompt: string, workspaceRefs: string[], routingContext?: string, recentConversation?: AgentQueryConversationTurn[]) => Promise<boolean>;
  onAnswer: (questionId: string, answer: string) => Promise<boolean>;
  onRotateToken: () => Promise<RotateAgentTokenResult | null>;
}

interface AgentChatEntry {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  sender: 'human' | 'agent' | 'system';
  contextRole: AgentQueryConversationTurn['role'] | null;
  order: number;
}

function agentChatTasks(agent: BoardAgent, snapshot: BoardSnapshot, pointOfContactOnly: boolean) {
  const queryPrefix = `Request for ${agent.id}: `;
  return snapshot.tasks.filter((task) => (
    task.assignedAgentId === agent.id
      && (!pointOfContactOnly || task.title.startsWith(queryPrefix))
  ));
}

function agentChatHistory(agent: BoardAgent, snapshot: BoardSnapshot, pointOfContactOnly: boolean): AgentChatEntry[] {
  const chatTasks = agentChatTasks(agent, snapshot, pointOfContactOnly);
  const chatTaskIds = new Set(chatTasks.map((task) => task.id));
  const promptByTask = new Map(chatTasks.map((task) => (
    [task.id, agentQueryPromptFromObjective(task.objective)] as const
  )));
  const messages = snapshot.messages.filter((message) => chatTaskIds.has(message.taskId));
  const questions = snapshot.questions.filter((question) => chatTaskIds.has(question.taskId));
  const questionBodies = new Set(questions.map((question) => `${question.taskId}\u0000${question.prompt.trim()}`));
  const answerBodies = new Set(questions.flatMap((question) => question.answer === null ? [] : [`${question.taskId}\u0000${question.answer.trim()}`]));
  const agentNames = new Map(snapshot.agents.map((item) => [item.id, item.name]));
  const entries: AgentChatEntry[] = chatTasks.map((task) => {
    const systemRequest = task.kind === 'manager_review';
    return {
      id: `query-${task.id}`,
      author: systemRequest ? 'System' : 'You',
      body: promptByTask.get(task.id) ?? task.objective,
      createdAt: task.createdAt,
      sender: systemRequest ? 'system' : 'human',
      contextRole: systemRequest ? null : 'human',
      order: 0,
    };
  });

  for (const message of messages) {
    const body = message.body.trim();
    if (message.authorType === 'human' && body === promptByTask.get(message.taskId)) continue;
    if (message.kind === 'question' && questionBodies.has(`${message.taskId}\u0000${body}`)) continue;
    if (message.kind === 'answer' && answerBodies.has(`${message.taskId}\u0000${body}`)) continue;
    entries.push({
      id: `message-${message.id}`,
      author: message.authorType === 'human'
        ? 'You'
        : message.authorType === 'system'
          ? 'System'
          : agentNames.get(message.authorId ?? '') ?? agent.name,
      body: message.body,
      createdAt: message.createdAt,
      sender: message.authorType,
      contextRole: message.authorType === 'system'
        ? null
        : message.kind === 'question'
          ? 'agent'
          : message.kind === 'answer'
            ? 'human'
            : message.kind === 'result'
              ? message.authorType === 'human' ? 'human' : 'agent'
              : null,
      order: 1,
    });
  }

  for (const question of questions) {
    entries.push({
      id: `question-${question.id}`,
      author: agentNames.get(question.agentId) ?? agent.name,
      body: question.prompt,
      createdAt: question.askedAt,
      sender: 'agent',
      contextRole: 'agent',
      order: 2,
    });
    if (question.answer !== null) {
      entries.push({
        id: `answer-${question.id}`,
        author: 'You',
        body: question.answer,
        createdAt: question.answeredAt ?? question.askedAt,
        sender: 'human',
        contextRole: 'human',
        order: 3,
      });
    }
  }

  for (const task of chatTasks) {
    const result = task.result?.trim();
    if (!result || messages.some((message) => message.taskId === task.id && message.body.trim() === result)) continue;
    entries.push({
      id: `result-${task.id}`,
      author: agent.name,
      body: result,
      createdAt: task.endedAt ?? task.updatedAt,
      sender: 'agent',
      contextRole: 'agent',
      order: 4,
    });
  }

  return entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.order - right.order || left.id.localeCompare(right.id));
}

function AgentChat({
  agent,
  snapshot,
  isPointOfContact,
  busy,
  onTask,
  onSend,
  onAnswer,
  onRotateToken,
}: Pick<AgentPageProps, 'agent' | 'snapshot' | 'isPointOfContact' | 'busy' | 'onTask' | 'onSend' | 'onAnswer' | 'onRotateToken'>) {
  const [draft, setDraft] = useState('');
  const [visibleLaneToken, setVisibleLaneToken] = useState<string | null>(null);
  const [confirmRotation, setConfirmRotation] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotationError, setRotationError] = useState<string | null>(null);
  const historyEndRef = useRef<HTMLDivElement>(null);
  const history = useMemo(() => agentChatHistory(agent, snapshot, isPointOfContact), [agent, isPointOfContact, snapshot]);
  const focus = useMemo(() => agentPipelineFocus(agent, snapshot.tasks), [agent, snapshot.tasks]);
  const recentConversation = useMemo(() => history.flatMap((entry): AgentQueryConversationTurn[] => (
    entry.contextRole === null ? [] : [{ role: entry.contextRole, body: entry.body }]
  )), [history]);
  const laneConfiguration = useMemo(
    () => laneConfigurationState(agent, visibleLaneToken),
    [agent, visibleLaneToken],
  );
  const currentOpenQuestion = useMemo(() => {
    const chatTasks = agentChatTasks(agent, snapshot, isPointOfContact);
    const currentQuery = chatTasks.find((task) => task.id === agent.currentTaskId)
      ?? chatTasks
        .filter((task) => task.status === 'waiting_for_human' || task.status === 'running' || task.status === 'blocked' || task.status === 'queued')
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!currentQuery) return null;
    return snapshot.questions
      .filter((question): question is BoardQuestion => question.taskId === currentQuery.id && question.status === 'open')
      .sort((left, right) => right.askedAt.localeCompare(left.askedAt))[0] ?? null;
  }, [agent, isPointOfContact, snapshot]);
  const routingMap = useMemo(() => !isPointOfContact ? '' : snapshot.projects.slice(0, 20).map((project) => {
    const owners = snapshot.agents
      .filter((owner) => owner.projectId === project.id)
      .slice(0, 8)
      .map((owner) => `${owner.name} (${owner.role}, ${owner.area})`)
      .join(', ');
    return `- ${project.name}: ${owners || 'no agents yet'}`;
  }).join('\n').slice(0, 2_000), [isPointOfContact, snapshot.agents, snapshot.projects]);

  useEffect(() => {
    historyEndRef.current?.scrollIntoView?.({ block: 'end' });
  }, [history.length]);

  async function send() {
    const prompt = draft.trim();
    if (!prompt) return;
    const sent = currentOpenQuestion
      ? await onAnswer(currentOpenQuestion.id, prompt)
      : await onSend(prompt, isPointOfContact ? [] : focus.task?.workspaceRefs ?? [], routingMap || undefined, recentConversation);
    if (sent) setDraft('');
  }

  async function rotateToken() {
    setConfirmRotation(false);
    setRotating(true);
    setRotationError(null);
    const rotated = await onRotateToken();
    if (rotated === null) {
      setRotationError('The token could not be rotated. Refresh the agent and try again.');
    } else {
      setVisibleLaneToken(rotated.token);
    }
    setRotating(false);
  }

  return (
    <>
      <main className="h-[calc(100dvh-4rem)] overflow-hidden bg-canvas lg:h-dvh">
        <section aria-labelledby="agent-chat-heading" className="mx-auto flex h-full w-full max-w-4xl flex-col px-4 sm:px-8 lg:px-10">
          {isPointOfContact ? (
            <header className="shrink-0 border-b border-line py-4 sm:py-5 lg:py-7">
              <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted">Point of contact</p>
              <h1 id="agent-chat-heading" className="mt-1.5 font-display text-2xl font-light tracking-[0.01em] text-ink sm:text-[28px]">Chat with {agent.name}</h1>
            </header>
          ) : (
            <header aria-label={`${agent.name} current focus`} className="shrink-0 border-b border-line py-4 sm:py-5 lg:py-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-5">
              <div className="min-w-0">
                <h1 id="agent-chat-heading" className="font-display text-xl font-light tracking-[0.01em] text-ink sm:text-2xl">{agent.name}</h1>
                <p className="mt-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted">Current focus</p>
                {focus.task ? (
                  <button
                    type="button"
                    className="mt-1 max-w-full rounded-[8px] text-left text-sm font-medium leading-5 text-ink underline decoration-transparent underline-offset-4 transition-[color,text-decoration-color,transform] duration-150 ease-out hover:text-teal-700 hover:decoration-current motion-safe:active:scale-[0.99]"
                    onClick={() => onTask(focus.task!.id)}
                  >
                    {focus.task.title}
                  </button>
                ) : <p className="mt-1 text-sm leading-5 text-muted">No current task</p>}
              </div>
              <div className="flex max-w-full flex-wrap items-center gap-1.5 sm:justify-end">
                {focus.stage ? <Pill tone={focus.stage === 'Reviewing' ? 'amber' : 'green'} dot>{focus.stage}</Pill> : null}
                <Pill className="max-w-full" tone="neutral">
                  <span className="block max-w-[18rem] truncate">{focus.phase ? `Phase · ${focus.phase.title}` : focus.task ? 'Phase not reported' : 'No active phase'}</span>
                </Pill>
                {focus.loop ? <Pill tone="blue">Loop {focus.loop}</Pill> : null}
              </div>
            </div>
            </header>
          )}

          <section aria-labelledby="lane-configuration-heading" className="shrink-0 border-b border-line py-4 sm:py-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <KeyRound size={15} strokeWidth={1.6} aria-hidden="true" />
                <h2 id="lane-configuration-heading" className="text-sm font-medium text-ink">Lane configuration</h2>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted">
                Paste this agent object into the fleet config’s <code>agents</code> array and replace the working-directory and provider placeholders.
              </p>
            </div>
            <Button
              className="shrink-0"
              size="sm"
              disabled={busy || rotating}
              onClick={() => setConfirmRotation(true)}
            >
              {rotating ? 'Rotating…' : laneConfiguration.tokenVisible ? 'Rotate again' : 'Rotate token'}
            </Button>
          </div>
          <pre
            aria-label={`Fleet lane configuration for ${agent.name}`}
            className="mt-3 max-h-48 overflow-auto rounded-xl border border-line bg-muted-surface p-3 font-mono text-[11px] leading-5 text-ink"
          >{laneConfiguration.snippet}</pre>
          <p className="mt-2 text-[11px] leading-4 text-muted" role={laneConfiguration.tokenVisible ? 'status' : undefined}>
            {laneConfiguration.tokenVisible
              ? 'Token visible for this page session only. It will be masked after you leave or reload.'
              : 'No token is stored in the board snapshot. Rotate it to reveal a new value once.'}
          </p>
          {rotationError ? <p className="mt-2 text-xs text-urgent" role="alert">{rotationError}</p> : null}
          </section>

          <div role="log" aria-label={`Chat history with ${agent.name}`} aria-live="polite" aria-relevant="additions" className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-5 sm:py-7">
          {history.length > 0 ? (
            <ol className="space-y-4">
              {history.map((entry) => (
                <li key={entry.id} className={cn('flex', entry.sender === 'human' ? 'justify-end' : entry.sender === 'system' ? 'justify-center' : 'justify-start')}>
                  <article className={cn(
                    'max-w-[88%] rounded-[18px] px-4 py-3 text-sm leading-6 shadow-none sm:max-w-[76%]',
                    entry.sender === 'human'
                      ? 'rounded-br-[6px] bg-taupe text-white'
                      : entry.sender === 'system'
                        ? 'bg-muted-surface text-muted'
                        : 'rounded-bl-[6px] border border-line bg-muted-surface text-ink',
                  )}>
                    <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[10px] leading-4 opacity-70">
                      <span className="font-medium">{entry.author}</span>
                      <time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
                    </div>
                    <p className="whitespace-pre-wrap break-words">{entry.body}</p>
                  </article>
                </li>
              ))}
            </ol>
          ) : (
            <div className="flex h-full min-h-44 flex-col items-center justify-center text-center text-muted">
              <span className="flex size-10 items-center justify-center rounded-full bg-muted-surface"><MessageSquareText size={17} strokeWidth={1.5} /></span>
              <p className="mt-3 text-sm">No messages yet.</p>
            </div>
          )}
          <div ref={historyEndRef} aria-hidden="true" />
          </div>

          <form className="shrink-0 border-t border-line bg-canvas py-4 sm:py-5" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <label htmlFor={`agent-message-${agent.id}`} className="sr-only">Message {agent.name}</label>
          <div className="flex items-end gap-2 rounded-[18px] border border-line bg-surface p-2 transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-taupe-hover focus-within:shadow-[0_0_0_3px_rgba(213,200,186,.2)]">
            <textarea
              id={`agent-message-${agent.id}`}
              className="min-h-11 max-h-40 flex-1 resize-y bg-transparent px-2 py-2 text-sm leading-6 text-ink outline-none placeholder:text-muted"
              maxLength={8_000}
              placeholder={currentOpenQuestion ? 'Reply to the agent’s question…' : isPointOfContact ? 'Ask a question or describe what you need…' : `Message ${agent.name}…`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button className="size-11 min-h-0 shrink-0 rounded-full p-0" variant="primary" type="submit" icon={<Send size={16} />} aria-label="Send message" disabled={busy || draft.trim().length === 0} />
          </div>
          </form>
        </section>
      </main>
      <Modal
        open={confirmRotation}
        onClose={() => setConfirmRotation(false)}
        title="Rotate agent token?"
        description="Rotating immediately disconnects any worker using the current token."
      >
        <div className="space-y-4 p-5 sm:p-6">
          <p className="text-sm leading-6 text-muted">
            The old token will stop authenticating as soon as rotation succeeds. Update the fleet lane with the new token before reconnecting it.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button disabled={rotating} onClick={() => setConfirmRotation(false)}>Cancel</Button>
            <Button variant="danger" disabled={rotating} onClick={() => void rotateToken()}>Rotate token</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export function AgentPage(props: AgentPageProps) {
  return <AgentChat agent={props.agent} snapshot={props.snapshot} isPointOfContact={props.isPointOfContact} busy={props.busy} onTask={props.onTask} onSend={props.onSend} onAnswer={props.onAnswer} onRotateToken={props.onRotateToken} />;
}
