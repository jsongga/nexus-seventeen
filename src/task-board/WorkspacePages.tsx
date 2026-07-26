import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Folder,
  Github,
  GripVertical,
  Link,
  MessageSquareText,
  Plus,
  Send,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Pill, cn } from '../components/ui';
import { agentQueryPromptFromObjective } from './client';
import type { AgentQueryConversationTurn, BoardAgent, BoardProject, BoardQuestion, BoardSnapshot } from './types';
import { parseProjectMetadata, type ProjectMetadataEntry } from './project-metadata';
import {
  agentPipelineFocus,
  recentUpdatesForProject,
} from './workspace-model';

const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const warmCard = '!rounded-[18px] !border-line !bg-white !shadow-none';

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

function projectResourceIcon(kind: ProjectMetadataEntry['kind']) {
  const props = { size: 22, strokeWidth: 1.5, 'aria-hidden': true } as const;
  if (kind === 'workspace') return <Folder {...props} />;
  if (kind === 'github') return <Github {...props} />;
  if (kind === 'dokploy') return <Cloud {...props} />;
  if (kind === 'docs') return <BookOpen {...props} />;
  return <Link {...props} />;
}

function resourceId(entry: ProjectMetadataEntry, index: number): string {
  return `${entry.key}:${entry.value}:${index}`;
}

function ProjectResourceDashboard({ projectId, entries }: { projectId: string; entries: ProjectMetadataEntry[] }) {
  const storageKey = `nexus-seventeen:project-resources:${projectId}`;
  const [order, setOrder] = useState<string[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const resources = entries.map((entry, index) => ({ entry, id: resourceId(entry, index) }));

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]') as unknown;
      setOrder(Array.isArray(saved) && saved.every((item) => typeof item === 'string') ? saved : []);
    } catch {
      setOrder([]);
    }
  }, [storageKey]);

  const ordered = [...resources].sort((left, right) => {
    const leftIndex = order.indexOf(left.id);
    const rightIndex = order.indexOf(right.id);
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
  });
  const saveOrder = (next: string[]) => {
    setOrder(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // The dashboard still reorders for this session when browser storage is unavailable.
    }
  };
  const move = (id: string, direction: -1 | 1) => {
    const current = ordered.map((resource) => resource.id);
    const from = current.indexOf(id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= current.length) return;
    [current[from], current[to]] = [current[to]!, current[from]!];
    saveOrder(current);
  };
  const drop = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    const current = ordered.map((resource) => resource.id);
    const from = current.indexOf(draggedId);
    const to = current.indexOf(targetId);
    current.splice(to, 0, current.splice(from, 1)[0]!);
    saveOrder(current);
    setDraggedId(null);
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">Resources</h3>
        <p className="text-[10px] text-muted">Drag to arrange</p>
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
        {ordered.map(({ entry, id }, index) => (
          <li
            key={id}
            draggable
            onDragStart={() => setDraggedId(id)}
            onDragEnd={() => setDraggedId(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => drop(id)}
            className={cn('group relative min-w-0 rounded-[14px] border border-line bg-[#faf8f4] transition-[border-color,transform] hover:border-taupe-hover', draggedId === id && 'opacity-50')}
          >
            <span className="absolute left-2 top-2 cursor-grab text-muted opacity-60" aria-hidden="true"><GripVertical size={13} /></span>
            <div className="absolute right-1 top-1 z-10 flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
              <button type="button" disabled={index === 0} aria-label={`Move ${entry.label} earlier`} className="flex size-7 items-center justify-center rounded-full text-muted hover:bg-white hover:text-ink disabled:invisible" onClick={() => move(id, -1)}><ChevronLeft size={13} /></button>
              <button type="button" disabled={index === ordered.length - 1} aria-label={`Move ${entry.label} later`} className="flex size-7 items-center justify-center rounded-full text-muted hover:bg-white hover:text-ink disabled:invisible" onClick={() => move(id, 1)}><ChevronRight size={13} /></button>
            </div>
            {entry.href ? (
              <a
                href={entry.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${entry.label}: ${entry.value} (opens in a new tab)`}
                title={entry.value}
                className="flex min-h-28 flex-col items-center justify-center rounded-[14px] px-3 pb-3 pt-7 text-center text-teal-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover"
              >
                <span className="flex size-10 items-center justify-center rounded-[12px] bg-white shadow-sm">{projectResourceIcon(entry.kind)}</span>
                <span className="mt-2 max-w-full truncate text-xs font-medium">{entry.label}</span>
                <span className="mt-0.5 max-w-full truncate text-[10px] text-muted">{projectLinkLabel(entry.href)}</span>
              </a>
            ) : (
              <div title={entry.value} className="flex min-h-28 flex-col items-center justify-center px-3 pb-3 pt-7 text-center text-[#514c46]">
                <span className="flex size-10 items-center justify-center rounded-[12px] bg-white text-muted shadow-sm">{projectResourceIcon(entry.kind)}</span>
                <span className="mt-2 max-w-full truncate text-xs font-medium">{entry.label}</span>
                <span className="mt-0.5 max-w-full truncate font-mono text-[9px] text-muted">{entry.value}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description?: string | null; actions?: React.ReactNode }) {
  return (
    <header className="flex flex-col gap-2 border-b border-line bg-canvas px-4 py-4 sm:px-8 sm:py-5 lg:flex-row lg:items-end lg:justify-between lg:gap-4 lg:px-12 lg:py-8">
      <div className="min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted">{eyebrow}</p>
        <h1 className="mt-1.5 font-display text-2xl font-light tracking-[0.01em] text-ink sm:text-[28px]">{title}</h1>
        {description ? <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function ProjectPage({
  project,
  snapshot,
  onTask,
  onAddTask,
}: {
  project: BoardProject;
  snapshot: BoardSnapshot;
  onTask: (taskId: string) => void;
  onAddTask: () => void;
}) {
  const updates = recentUpdatesForProject(snapshot, project.id);
  const metadata = parseProjectMetadata(project.description);
  const updateRow = (update: (typeof updates)[number]) => (
    <li key={update.id}>
      <button type="button" className="w-full px-4 py-3.5 text-left transition-[background-color,transform] duration-150 ease-out hover:bg-[#faf6f0] motion-safe:active:scale-[0.995] sm:px-5" onClick={() => onTask(update.taskId)}>
        <span className="flex flex-wrap items-center gap-2 text-[11px]"><span className="font-medium text-[#332f2a]">{update.author}</span><Pill className="!rounded-full" tone={update.kind === 'question' ? 'amber' : update.kind === 'result' ? 'green' : 'neutral'}>{update.kind}</Pill><time dateTime={update.createdAt} className="text-[#817a72]">{formatTime(update.createdAt)}</time></span>
        <span className="mt-1.5 block text-xs font-medium text-teal-700">{update.taskTitle}</span>
        <span className="mt-1 line-clamp-2 block whitespace-pre-wrap text-sm leading-6 text-[#514c46]">{update.body}</span>
      </button>
    </li>
  );

  return (
    <>
      <PageHeader eyebrow="Project" title={project.name} actions={<Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={onAddTask}>Add task</Button>} />
      <main className="w-full max-w-6xl bg-canvas p-4 sm:px-8 sm:py-6 lg:min-h-[calc(100dvh-117px)] lg:px-12 lg:py-8">
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.4fr)]">
          <section aria-labelledby="project-details-heading">
            <Card className={cn(warmCard, 'overflow-hidden')}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-4 sm:px-5">
                <h2 id="project-details-heading" className="text-sm font-medium text-ink">Project details</h2>
                <time dateTime={project.updatedAt} className="text-[11px] text-muted">Updated {formatTime(project.updatedAt)}</time>
              </div>
              {metadata.summaries.length > 0 || metadata.entries.length > 0 ? (
                <div className="px-4 py-4 sm:px-5">
                  {metadata.summaries.length > 0 ? (
                    <div className="space-y-2">
                      <h3 className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">Summary</h3>
                      {metadata.summaries.map((summary, index) => (
                        <p key={`${summary}:${index}`} className="whitespace-pre-wrap break-words text-sm leading-6 text-[#514c46]">{summary}</p>
                      ))}
                    </div>
                  ) : null}
                  {metadata.entries.length > 0 ? (
                    <div className={cn(metadata.summaries.length > 0 && 'mt-4 border-t border-line pt-4')}>
                      <ProjectResourceDashboard projectId={project.id} entries={metadata.entries} />
                    </div>
                  ) : null}
                </div>
              ) : <div className="px-5 py-8 text-sm leading-6 text-muted">No project summary or links have been recorded.</div>}
            </Card>
          </section>

          <section aria-labelledby="project-updates-heading">
            <Card className={cn(warmCard, 'overflow-hidden')}>
              <div className="border-b border-line px-4 py-4 sm:px-5">
                <h2 id="project-updates-heading" className="text-sm font-medium text-ink">Recent updates</h2>
              </div>
              {updates.length > 0
                ? <ol className="divide-y divide-line">{updates.map(updateRow)}</ol>
                : <div className="px-5 py-10 text-center text-sm text-muted">Updates will appear when tasks or agents record progress.</div>}
            </Card>
          </section>
        </div>
      </main>
    </>
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
}: Pick<AgentPageProps, 'agent' | 'snapshot' | 'isPointOfContact' | 'busy' | 'onTask' | 'onSend' | 'onAnswer'>) {
  const [draft, setDraft] = useState('');
  const historyEndRef = useRef<HTMLDivElement>(null);
  const history = useMemo(() => agentChatHistory(agent, snapshot, isPointOfContact), [agent, isPointOfContact, snapshot]);
  const focus = useMemo(() => agentPipelineFocus(agent, snapshot.tasks), [agent, snapshot.tasks]);
  const recentConversation = useMemo(() => history.flatMap((entry): AgentQueryConversationTurn[] => (
    entry.contextRole === null ? [] : [{ role: entry.contextRole, body: entry.body }]
  )), [history]);
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

  return (
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
                {focus.stage ? <Pill className="!rounded-full" tone={focus.stage === 'Reviewing' ? 'amber' : 'green'} dot>{focus.stage}</Pill> : null}
                <Pill className="max-w-full !rounded-full" tone="neutral">
                  <span className="block max-w-[18rem] truncate">{focus.phase ? `Phase · ${focus.phase.title}` : focus.task ? 'Phase not reported' : 'No active phase'}</span>
                </Pill>
                {focus.loop ? <Pill className="!rounded-full" tone="blue">Loop {focus.loop}</Pill> : null}
              </div>
            </div>
          </header>
        )}

        <div role="log" aria-label={`Chat history with ${agent.name}`} aria-live="polite" aria-relevant="additions" className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-5 sm:py-7">
          {history.length > 0 ? (
            <ol className="space-y-4">
              {history.map((entry) => (
                <li key={entry.id} className={cn('flex', entry.sender === 'human' ? 'justify-end' : entry.sender === 'system' ? 'justify-center' : 'justify-start')}>
                  <article className={cn(
                    'max-w-[88%] rounded-[18px] px-4 py-3 text-sm leading-6 shadow-none sm:max-w-[76%]',
                    entry.sender === 'human'
                      ? 'rounded-br-[6px] bg-taupe text-[#332f2a]'
                      : entry.sender === 'system'
                        ? 'bg-surface text-muted'
                        : 'rounded-bl-[6px] border border-line bg-white text-[#514c46]',
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
              <span className="flex size-10 items-center justify-center rounded-full bg-surface"><MessageSquareText size={17} strokeWidth={1.5} /></span>
              <p className="mt-3 text-sm">No messages yet.</p>
            </div>
          )}
          <div ref={historyEndRef} aria-hidden="true" />
        </div>

        <form className="shrink-0 border-t border-line bg-canvas py-4 sm:py-5" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <label htmlFor={`agent-message-${agent.id}`} className="sr-only">Message {agent.name}</label>
          <div className="flex items-end gap-2 rounded-[18px] border border-line bg-white p-2 transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-taupe-hover focus-within:shadow-[0_0_0_3px_rgba(213,200,186,.2)]">
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
  );
}

export function AgentPage(props: AgentPageProps) {
  return <AgentChat agent={props.agent} snapshot={props.snapshot} isPointOfContact={props.isPointOfContact} busy={props.busy} onTask={props.onTask} onSend={props.onSend} onAnswer={props.onAnswer} />;
}
