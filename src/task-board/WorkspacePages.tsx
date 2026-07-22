import {
  Bot,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  FolderKanban,
  Link2,
  ListTodo,
  MessageSquareText,
  Plus,
  Send,
  Sparkles,
  UserRoundCheck,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Avatar, Button, Card, Pill, cn, inputClass } from '../components/ui';
import type { BoardAgent, BoardProject, BoardSnapshot, BoardTask } from './types';
import { recentUpdatesForProject, resourcesForProject, taskNeedsHumanAction } from './workspace-model';

const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function formatTime(value: string | null): string {
  if (value === null) return 'Not recorded';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : dateTime.format(parsed);
}

function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description?: string | null; actions?: React.ReactNode }) {
  return (
    <header className="flex flex-col gap-4 border-b border-line bg-white px-4 py-5 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-8">
      <div className="min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-teal-700">{eyebrow}</p>
        <h1 className="mt-1 font-display text-[22px] font-semibold tracking-[-0.025em] text-ink sm:text-[26px]">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function DocumentsPage({ snapshot, onProject }: { snapshot: BoardSnapshot; onProject: (projectId: string) => void }) {
  const groups = snapshot.projects.map((project) => ({ project, resources: resourcesForProject(project, snapshot.tasks) }));
  return (
    <>
      <PageHeader eyebrow="Company knowledge" title="Documents" description="Project briefs, user-facing outcomes, links, and setup references already recorded on the durable task board." />
      <main className="mx-auto max-w-[1200px] space-y-5 p-4 sm:p-6 lg:p-8">
        {groups.map(({ project, resources }) => (
          <Card key={project.id} className="overflow-hidden">
            <button type="button" onClick={() => onProject(project.id)} className="flex w-full items-center justify-between gap-3 border-b border-line px-4 py-4 text-left hover:bg-line-soft/60 sm:px-5">
              <span><span className="block text-sm font-bold text-ink">{project.name}</span><span className="mt-0.5 block text-xs text-muted">{resources.length} recorded resources</span></span>
              <FolderKanban size={18} className="text-teal-700" />
            </button>
            {resources.length > 0 ? (
              <div className="grid gap-px bg-line md:grid-cols-2">
                {resources.map((resource) => {
                  const icon = resource.kind === 'link' ? <Link2 size={16} /> : resource.kind === 'outcome' ? <Sparkles size={16} /> : <FileText size={16} />;
                  const content = (
                    <>
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-teal-soft text-teal-700">{icon}</span>
                      <span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-sm font-bold text-ink">{resource.title}{resource.href ? <ExternalLink size={13} className="text-muted" /> : null}</span><span className="mt-1 line-clamp-3 block text-xs leading-5 text-muted">{resource.description}</span><span className="mt-2 block text-[10px] font-semibold uppercase tracking-wide text-muted">{resource.kind} · {formatTime(resource.updatedAt)}</span></span>
                    </>
                  );
                  return resource.href ? <a key={resource.id} href={resource.href} target="_blank" rel="noopener noreferrer" className="flex min-h-28 gap-3 bg-white p-4 hover:bg-[#fafbfb]">{content}</a> : <article key={resource.id} className="flex min-h-28 gap-3 bg-white p-4">{content}</article>;
                })}
              </div>
            ) : <div className="px-5 py-8 text-center text-sm text-muted">No brief, results, links, or setup references have been recorded yet.</div>}
          </Card>
        ))}
      </main>
    </>
  );
}

export function ProjectPage({
  project,
  snapshot,
  onAddTask,
  onAddAgent,
  onTask,
  onAgent,
}: {
  project: BoardProject;
  snapshot: BoardSnapshot;
  onAddTask: () => void;
  onAddAgent: () => void;
  onTask: (taskId: string) => void;
  onAgent: (agentId: string) => void;
}) {
  const tasks = snapshot.tasks.filter((task) => task.projectId === project.id);
  const agents = snapshot.agents.filter((agent) => agent.projectId === project.id);
  const updates = recentUpdatesForProject(snapshot, project.id);
  const resources = resourcesForProject(project, tasks);
  const links = resources.filter((resource) => resource.kind === 'link');
  const setup = resources.filter((resource) => resource.kind === 'setup');
  const documents = resources.filter((resource) => resource.kind === 'brief' || resource.kind === 'outcome');
  const needsHuman = tasks.filter(taskNeedsHumanAction);

  return (
    <>
      <PageHeader eyebrow="Project" title={project.name} description={project.description ?? 'No project overview has been recorded yet.'} actions={<><Button size="sm" icon={<Bot size={15} />} onClick={onAddAgent}>Add agent</Button><Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={onAddTask}>Add task</Button></>} />
      <main className="mx-auto max-w-[1300px] space-y-4 p-4 sm:p-6 lg:p-8">
        {needsHuman.length > 0 ? (
          <Card className="border-caution-fill/45 bg-caution-soft/60 px-4 py-4 shadow-none sm:px-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex gap-3"><span className="mt-0.5 text-caution"><UserRoundCheck size={19} /></span><div><h2 className="text-sm font-bold text-ink">{needsHuman.length} {needsHuman.length === 1 ? 'item needs' : 'items need'} you</h2><p className="mt-1 text-xs leading-5 text-caution">Assign a manager, answer an agent, or record a release check. No reviewer wakes automatically.</p></div></div><Button size="sm" onClick={() => onTask(needsHuman[0]!.id)}>Review first task</Button></div>
          </Card>
        ) : null}

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-4 py-4 sm:px-5"><div><h2 className="text-sm font-bold">Recent updates</h2><p className="mt-0.5 text-[11px] text-muted">Progress and outcomes written by agents</p></div><MessageSquareText size={18} className="text-teal-700" /></div>
            {updates.length > 0 ? <ol className="divide-y divide-line-soft">{updates.map((update) => <li key={update.id} className="px-4 py-4 sm:px-5"><button type="button" className="w-full text-left" onClick={() => onTask(update.taskId)}><span className="flex flex-wrap items-center gap-2 text-[11px]"><span className="font-bold text-ink">{update.author}</span><Pill tone={update.kind === 'question' ? 'amber' : update.kind === 'result' ? 'green' : 'neutral'}>{update.kind}</Pill><time className="text-muted">{formatTime(update.createdAt)}</time></span><span className="mt-1.5 block text-xs font-semibold text-teal-700">{update.taskTitle}</span><span className="mt-1 line-clamp-3 block whitespace-pre-wrap text-sm leading-6 text-[#3f4852]">{update.body}</span></button></li>)}</ol> : <div className="px-5 py-10 text-center text-sm text-muted">Updates will appear when tasks or agents record progress.</div>}
          </Card>

          <div className="space-y-4">
            <Card className="overflow-hidden"><div className="border-b border-line px-4 py-3.5"><h2 className="text-sm font-bold">Project setup</h2><p className="mt-0.5 text-[11px] text-muted">Workspace scope recorded on tasks</p></div><div className="space-y-3 p-4">{setup.length > 0 ? setup.slice(0, 8).map((resource) => <div key={resource.id} className="rounded-[9px] bg-line-soft px-3 py-2.5"><p className="text-xs font-bold text-ink">{resource.title}</p><p className="mt-1 break-all font-mono text-[10px] leading-4 text-muted">{resource.description}</p></div>) : <p className="text-xs leading-5 text-muted">No repository paths or setup references recorded yet.</p>}</div></Card>
            <Card className="overflow-hidden"><div className="border-b border-line px-4 py-3.5"><h2 className="text-sm font-bold">Docs & links</h2></div><div className="space-y-1 p-2">{[...documents, ...links].length > 0 ? [...documents, ...links].slice(0, 8).map((resource) => resource.href ? <a key={resource.id} href={resource.href} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-[8px] px-2.5 py-2 text-xs font-semibold text-teal-700 hover:bg-teal-soft"><ExternalLink size={14} /> <span className="truncate">{resource.title}</span></a> : <div key={resource.id} className="flex items-center gap-2 rounded-[8px] px-2.5 py-2 text-xs font-semibold text-ink"><FileText size={14} className="text-muted" /> <span className="truncate">{resource.title}</span></div>) : <p className="px-2 py-3 text-xs leading-5 text-muted">Results and links will appear here as tasks finish.</p>}</div></Card>
            <Card className="overflow-hidden"><div className="flex items-center justify-between border-b border-line px-4 py-3.5"><h2 className="text-sm font-bold">Agents</h2><span className="font-mono text-xs text-muted">{agents.length}</span></div><div className="space-y-1 p-2">{agents.map((agent) => <button key={agent.id} type="button" onClick={() => onAgent(agent.id)} className="flex min-h-12 w-full items-center gap-2.5 rounded-[9px] px-2.5 text-left hover:bg-line-soft"><Avatar name={agent.name} size="sm" /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold text-ink">{agent.name}</span><span className="mt-0.5 block truncate text-[10px] text-muted">{agent.role} · {agent.area}</span></span><Pill tone={agent.status === 'running' ? 'green' : agent.status === 'waiting_for_human' ? 'amber' : 'neutral'} dot>{agent.status.replaceAll('_', ' ')}</Pill></button>)}</div></Card>
          </div>
        </div>
      </main>
    </>
  );
}

function CurrentWork({ task, onTask }: { task: BoardTask | null; onTask: (taskId: string) => void }) {
  if (!task) return <Card className="border-teal-500/25 bg-teal-soft/45 p-5 shadow-none"><div className="flex items-start gap-3"><span className="flex size-9 items-center justify-center rounded-[9px] bg-white text-teal-700"><CheckCircle2 size={18} /></span><div><h2 className="text-sm font-bold text-ink">Ready for a task</h2><p className="mt-1 text-xs leading-5 text-muted">This agent is asleep and uses no model tokens until a human assigns or sends something.</p></div></div></Card>;
  return <Card className="overflow-hidden border-teal-500/30"><div className="border-b border-teal-500/20 bg-teal-soft/50 px-5 py-4"><div className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-teal-700">Current work</p><h2 className="mt-1 font-display text-lg font-semibold text-ink">{task.title}</h2></div><Pill tone={task.status === 'waiting_for_human' ? 'amber' : task.status === 'running' ? 'green' : 'blue'} dot>{task.status.replaceAll('_', ' ')}</Pill></div></div><div className="p-5"><p className="text-sm leading-6 text-muted">{task.objective}</p><div className="mt-4 flex flex-wrap items-center gap-3 text-[11px] text-muted"><span className="inline-flex items-center gap-1"><Clock3 size={13} /> {task.expectedAgentMinutes} agent min</span><span>Started {formatTime(task.startedAt)}</span><span>Expected {formatTime(task.expectedCompletedAt)}</span></div><Button className="mt-4" size="sm" onClick={() => onTask(task.id)}>Open task controls</Button></div></Card>;
}

export function AgentPage({
  agent,
  snapshot,
  isPointOfContact,
  explicitPointOfContact,
  busy,
  onTask,
  onSend,
}: {
  agent: BoardAgent;
  snapshot: BoardSnapshot;
  isPointOfContact: boolean;
  explicitPointOfContact: boolean;
  busy: boolean;
  onTask: (taskId: string) => void;
  onSend: (prompt: string, workspaceRefs: string[], routingContext?: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState('');
  const assignedTasks = useMemo(() => snapshot.tasks.filter((task) => task.assignedAgentId === agent.id).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [agent.id, snapshot.tasks]);
  const currentTask = assignedTasks.find((task) => task.id === agent.currentTaskId) ?? assignedTasks.find((task) => task.status === 'running' || task.status === 'queued' || task.status === 'waiting_for_human') ?? null;
  const project = snapshot.projects.find((item) => item.id === agent.projectId);
  const activity = snapshot.messages.filter((message) => assignedTasks.some((task) => task.id === message.taskId)).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 12);
  const agentById = new Map(snapshot.agents.map((item) => [item.id, item]));
  const routingMap = isPointOfContact
    ? snapshot.projects.slice(0, 20).map((item) => {
        const owners = snapshot.agents.filter((owner) => owner.projectId === item.id).slice(0, 8).map((owner) => `${owner.name} (${owner.role}, ${owner.area})`).join(', ');
        return `- ${item.name}: ${owners || 'no agents yet'}`;
      }).join('\n').slice(0, 2_000)
    : '';

  async function send() {
    const prompt = draft.trim();
    if (!prompt) return;
    if (await onSend(prompt, currentTask?.workspaceRefs ?? [], routingMap || undefined)) setDraft('');
  }

  return (
    <>
      <PageHeader eyebrow={isPointOfContact ? explicitPointOfContact ? 'Company point of contact' : 'Acting point of contact' : `${agent.role} · ${project?.name ?? 'Project'}`} title={agent.name} description={isPointOfContact ? explicitPointOfContact ? 'Ask a question or request routing help. A bounded company map helps this agent identify the right project or owner; you remain in control of assignments and production.' : 'No explicit POC is configured, so this engineer is the acting contact. They can answer from available context or recommend the right project and owner.' : agent.mission} actions={<Pill tone={agent.status === 'running' ? 'green' : agent.status === 'waiting_for_human' ? 'amber' : agent.status === 'failed' ? 'red' : 'neutral'} dot>{agent.status.replaceAll('_', ' ')}</Pill>} />
      <main className="mx-auto grid max-w-[1300px] items-start gap-4 p-4 sm:p-6 lg:p-8 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <CurrentWork task={currentTask} onTask={onTask} />
          <Card className="overflow-hidden">
            <div className="border-b border-line px-4 py-4 sm:px-5"><div className="flex items-center gap-2 text-teal-700"><MessageSquareText size={17} /><h2 className="text-sm font-bold text-ink">Talk to {agent.name}</h2></div><p className="mt-1 text-[11px] leading-5 text-muted">Sending creates one durable 15-minute task and wakes this agent once. Completed engineer requests enter the normal unassigned manager-review queue; no reviewer wakes automatically.</p></div>
            <div className="p-4 sm:p-5">
              <label htmlFor={`agent-message-${agent.id}`} className="sr-only">Message {agent.name}</label>
              <textarea id={`agent-message-${agent.id}`} className={cn(inputClass, 'min-h-28 resize-y py-3')} placeholder={isPointOfContact ? 'Ask a question or describe the outcome you want…' : `Ask ${agent.name} about their work or give them a new request…`} value={draft} onChange={(event) => setDraft(event.target.value)} />
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><p className="text-[11px] leading-4 text-muted">Human-triggered · 15 agent minutes · production remains locked</p><Button variant="primary" size="sm" icon={<Send size={15} />} disabled={busy || draft.trim().length === 0} onClick={() => void send()}>Send and wake agent</Button></div>
            </div>
          </Card>
          <Card className="overflow-hidden"><div className="border-b border-line px-4 py-4 sm:px-5"><h2 className="text-sm font-bold">Recent progress</h2><p className="mt-0.5 text-[11px] text-muted">Durable updates across this agent's assigned tasks</p></div>{activity.length > 0 ? <ol className="divide-y divide-line-soft">{activity.map((message) => { const task = assignedTasks.find((item) => item.id === message.taskId); const author = message.authorType === 'human' ? 'You' : message.authorType === 'system' ? 'System' : agentById.get(message.authorId ?? '')?.name ?? 'Agent'; return <li key={message.id} className="px-4 py-4 sm:px-5"><button type="button" onClick={() => onTask(message.taskId)} className="w-full text-left"><span className="flex flex-wrap items-center gap-2 text-[11px]"><span className="font-bold text-ink">{author}</span><Pill tone={message.kind === 'question' ? 'amber' : message.kind === 'result' ? 'green' : 'neutral'}>{message.kind}</Pill><time className="text-muted">{formatTime(message.createdAt)}</time></span><span className="mt-1 block text-xs font-semibold text-teal-700">{task?.title ?? 'Task update'}</span><span className="mt-1.5 line-clamp-4 block whitespace-pre-wrap text-sm leading-6 text-[#3f4852]">{message.body}</span></button></li>; })}</ol> : <div className="px-5 py-9 text-center text-sm text-muted">No progress messages recorded yet.</div>}</Card>
        </div>

        <div className="space-y-4">
          <Card className="p-5"><div className="flex items-start gap-3"><Avatar name={agent.name} size="lg" color="#d5eeeb" /><div className="min-w-0"><h2 className="text-sm font-bold text-ink">{agent.area}</h2><p className="mt-1 text-xs font-semibold capitalize text-teal-700">{agent.role}</p><p className="mt-2 text-xs leading-5 text-muted">{agent.mission}</p></div></div><dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 text-xs"><div><dt className="text-muted">Model</dt><dd className="mt-1 truncate font-semibold text-ink">{agent.model ?? 'Worker default'}</dd></div><div><dt className="text-muted">Last event</dt><dd className="mt-1 font-semibold text-ink">{agent.lastEventAt ? formatTime(agent.lastEventAt) : 'None yet'}</dd></div></dl></Card>
          <Card className="overflow-hidden"><div className="flex items-center justify-between border-b border-line px-4 py-3.5"><div><h2 className="text-sm font-bold">Assigned tasks</h2><p className="mt-0.5 text-[11px] text-muted">Queue and history</p></div><ListTodo size={17} className="text-teal-700" /></div><div className="divide-y divide-line-soft">{assignedTasks.length > 0 ? assignedTasks.slice(0, 10).map((task) => <button key={task.id} type="button" onClick={() => onTask(task.id)} className="flex w-full items-start gap-2.5 px-4 py-3 text-left hover:bg-line-soft/60"><span className="mt-0.5"><Pill tone={task.status === 'completed' ? 'green' : task.status === 'waiting_for_human' ? 'amber' : task.status === 'running' ? 'green' : 'neutral'}>{task.status.replaceAll('_', ' ')}</Pill></span><span className="min-w-0 flex-1"><span className="line-clamp-2 text-xs font-bold leading-5 text-ink">{task.title}</span><span className="mt-1 block text-[10px] text-muted">{formatTime(task.updatedAt)}</span></span></button>) : <p className="px-4 py-6 text-center text-xs text-muted">Nothing assigned yet.</p>}</div></Card>
        </div>
      </main>
    </>
  );
}
