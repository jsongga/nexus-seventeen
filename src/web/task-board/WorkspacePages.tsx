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
import type { TaskBoardClient } from './client';
import type { AgentQueryConversationTurn, BoardAgent, BoardProject, BoardQuestion, BoardSnapshot, ProjectArtifact, ProjectWorkflow } from './types';
import { parseProjectMetadata, type ProjectMetadataEntry } from './project-metadata';
import {
  agentWorkLabel,
  agentPipelineFocus,
  updatesForProject,
} from './workspace-model';

const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const warmCard = '!rounded-[2px] !border-line !bg-card !shadow-none';

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
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => drop(id)}
            className={cn('group min-w-0 border border-line bg-surface transition-[border-color,transform] hover:border-taupe-hover', draggedId === id && 'opacity-50')}
          >
            <div className="flex h-7 items-center justify-between px-1">
              <span
                draggable
                onDragStart={() => setDraggedId(id)}
                onDragEnd={() => setDraggedId(null)}
                className="flex size-7 cursor-grab items-center justify-center text-muted opacity-60"
                aria-hidden="true"
              ><GripVertical size={13} /></span>
              <span className="flex opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                <button type="button" disabled={index === 0} aria-label={`Move ${entry.label} earlier`} className="flex size-7 items-center justify-center text-muted hover:bg-card hover:text-ink disabled:invisible" onClick={() => move(id, -1)}><ChevronLeft size={13} /></button>
                <button type="button" disabled={index === ordered.length - 1} aria-label={`Move ${entry.label} later`} className="flex size-7 items-center justify-center text-muted hover:bg-card hover:text-ink disabled:invisible" onClick={() => move(id, 1)}><ChevronRight size={13} /></button>
              </span>
            </div>
            {entry.href ? (
              <a
                href={entry.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${entry.label}: ${entry.value} (opens in a new tab)`}
                title={entry.value}
                className="flex min-h-24 flex-col items-center justify-center px-3 pb-3 pt-1 text-center text-teal-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover"
              >
                <span className="flex size-10 items-center justify-center border border-line bg-card">{projectResourceIcon(entry.kind)}</span>
                <span className="mt-2 max-w-full truncate text-xs font-medium">{entry.label}</span>
                <span className="mt-0.5 max-w-full truncate text-[10px] text-muted">{projectLinkLabel(entry.href)}</span>
              </a>
            ) : (
              <div title={entry.value} className="flex min-h-24 flex-col items-center justify-center px-3 pb-3 pt-1 text-center text-muted">
                <span className="flex size-10 items-center justify-center border border-line bg-card text-muted">{projectResourceIcon(entry.kind)}</span>
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
    <header className="flex min-h-14 flex-col gap-2 border-b border-line bg-card px-4 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:gap-4">
      <div className="min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted">{eyebrow}</p>
        <h1 className="mt-1 font-display text-xl font-medium tracking-[0.01em] text-ink sm:text-2xl">{title}</h1>
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
  client,
}: {
  project: BoardProject;
  snapshot: BoardSnapshot;
  onTask: (taskId: string) => void;
  onAddTask: () => void;
  client: TaskBoardClient;
}) {
  const [workflow, setWorkflow] = useState<ProjectWorkflow | null>(null);
  const [artifacts, setArtifacts] = useState<ProjectArtifact[]>([]);
  const [artifactUrls, setArtifactUrls] = useState<Record<string, string>>({});
  const [confirmingPlan, setConfirmingPlan] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      client.getProjectWorkflow(project.id, controller.signal),
      client.getProjectArtifacts(project.id, controller.signal),
    ]).then(([nextWorkflow, nextArtifacts]) => {
      setWorkflow(nextWorkflow);
      setArtifacts(nextArtifacts);
    }).catch(() => {
      if (!controller.signal.aborted) setWorkflow(null);
    });
    return () => controller.abort();
  }, [client, project.id, snapshot.generatedAt]);
  useEffect(() => {
    const controller = new AbortController();
    const created: string[] = [];
    void Promise.all(artifacts.map(async (artifact) => {
      const url = URL.createObjectURL(await client.getArtifactBlob(artifact.artifactId, controller.signal));
      created.push(url);
      return [artifact.artifactId, url] as const;
    })).then((entries) => setArtifactUrls(Object.fromEntries(entries))).catch(() => undefined);
    return () => {
      controller.abort();
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [artifacts, client]);
  useEffect(() => {
    if (!workflow) return;
    const controller = new AbortController();
    const after = Math.max(0, ...workflow.events.map((event) => event.sequence));
    void client.subscribeProjectEvents({
      projectId: project.id,
      after,
      signal: controller.signal,
      onEvent: () => {
        void client.getProjectWorkflow(project.id, controller.signal).then(setWorkflow).catch(() => undefined);
      },
    }).catch(() => undefined);
    return () => controller.abort();
  }, [client, project.id, workflow === null]);
  const confirmPlan = async (planRevisionId: string) => {
    setConfirmingPlan(planRevisionId);
    try {
      setWorkflow(await client.confirmWorkflow(planRevisionId));
    } finally {
      setConfirmingPlan(null);
    }
  };
  const proposedPlan = workflow?.plans.find((plan) => plan.state === 'proposed') ?? null;
  const updates = updatesForProject(snapshot, project.id);
  const metadata = parseProjectMetadata(project.description);
  const tasks = snapshot.tasks.filter((task) => task.projectId === project.id);
  const agents = snapshot.agents.filter((agent) => agent.projectId === project.id);
  const completedTasks = tasks.filter((task) => task.status === 'completed');
  const activeTasks = tasks.filter((task) => task.status === 'running' || task.status === 'queued');
  const attentionTasks = tasks.filter((task) => task.status === 'waiting_for_human' || task.status === 'blocked' || task.status === 'failed');
  const plannedTasks = tasks.filter((task) => task.status === 'proposed' || task.status === 'backlog');
  const interruptedTasks = tasks.filter((task) => task.status === 'interrupted');
  const completionPercent = tasks.length === 0 ? 0 : Math.round((completedTasks.length / tasks.length) * 100);
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const taskGroups = [
    { label: 'Needs attention', tasks: attentionTasks, tone: 'text-urgent' },
    { label: 'In progress', tasks: activeTasks, tone: 'text-teal-700' },
    { label: 'Planned', tasks: plannedTasks, tone: 'text-muted' },
    { label: 'Completed', tasks: completedTasks, tone: 'text-success' },
    { label: 'Interrupted', tasks: interruptedTasks, tone: 'text-muted' },
  ].filter((group) => group.tasks.length > 0);
  const updateRow = (update: (typeof updates)[number]) => (
    <li key={update.id}>
      <button type="button" className="w-full px-4 py-3.5 text-left transition-colors duration-150 hover:bg-surface sm:px-5" onClick={() => onTask(update.taskId)}>
        <span className="flex flex-wrap items-center gap-2 font-mono text-[10px]"><span className="font-medium text-ink">{update.author}</span><Pill tone={update.kind === 'question' ? 'amber' : update.kind === 'result' ? 'green' : 'neutral'}>{update.kind}</Pill><time dateTime={update.createdAt} className="text-muted">{formatTime(update.createdAt)}</time></span>
        <span className="mt-1.5 block text-xs font-medium text-teal-700">{update.taskTitle}</span>
        <span className="mt-1 line-clamp-2 block whitespace-pre-wrap text-sm leading-6 text-muted">{update.body}</span>
      </button>
    </li>
  );

  return (
    <>
      <PageHeader eyebrow="Project" title={project.name} actions={<Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={onAddTask}>Add task</Button>} />
      <main className="min-w-0 w-full max-w-[1400px] overflow-x-hidden bg-canvas p-4 sm:p-6 lg:min-h-[calc(100dvh-56px)] lg:p-8">
        <section aria-labelledby="delivery-overview-heading">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="delivery-overview-heading" className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-ink">Delivery overview</h2>
              <p className="mt-1 text-xs text-muted">Current durable task state across the whole project.</p>
            </div>
            <time dateTime={project.updatedAt} className="text-[11px] text-muted">Project updated {formatTime(project.updatedAt)}</time>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
            {[
              { label: 'Completed', value: completedTasks.length, detail: `${completionPercent}% of tracked work` },
              { label: 'In progress', value: activeTasks.length, detail: activeTasks.length === 1 ? 'task moving' : 'tasks moving' },
              { label: 'Needs attention', value: attentionTasks.length, detail: attentionTasks.length === 0 ? 'No intervention needed' : 'Blocked, failed, or waiting' },
              { label: 'Planned', value: plannedTasks.length, detail: plannedTasks.length === 1 ? 'task not started' : 'tasks not started' },
            ].map((metric) => (
              <Card key={metric.label} className="!rounded-none !border-0 p-4 sm:p-5">
                <p className="font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-muted">{metric.label}</p>
                <p className="mt-2 font-mono text-3xl font-medium tabular-nums text-ink">{String(metric.value).padStart(2, '0')}</p>
                <p className="mt-1 font-mono text-[10px] text-muted">{metric.detail}</p>
              </Card>
            ))}
          </div>
          <div className="mt-2 h-1 overflow-hidden bg-surface" role="progressbar" aria-label="Task completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={completionPercent}>
            <div className="h-full bg-success-fill transition-[width] duration-300" style={{ width: `${completionPercent}%` }} />
          </div>
        </section>

        <section className="mt-6" aria-labelledby="workflow-heading">
          <Card className={cn(warmCard, 'overflow-hidden')}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
              <div>
                <h2 id="workflow-heading" className="text-sm font-medium text-ink">Execution map</h2>
                <p className="mt-1 text-xs text-muted">Confirmed subtasks, dependencies, stage handoffs, and durable artifacts.</p>
              </div>
              <Pill tone={workflow?.nodes.some((node) => node.state === 'blocked') ? 'amber' : 'neutral'}>
                {workflow?.nodes.length ?? 0} subtasks
              </Pill>
              {proposedPlan ? <Button size="sm" variant="primary" disabled={confirmingPlan !== null} onClick={() => void confirmPlan(proposedPlan.planRevisionId)}>{confirmingPlan ? 'Confirming…' : `Confirm plan v${proposedPlan.revision}`}</Button> : null}
            </div>
            {workflow && workflow.nodes.length > 0 ? (
              <div className="grid gap-px bg-line lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
                <div className="space-y-px bg-line">
                  {workflow.nodes.map((node) => (
                    <article key={node.nodeId} className="bg-card px-4 py-4 sm:px-5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="text-sm font-medium text-ink">{node.title}</h3>
                          <p className="mt-1 text-xs leading-5 text-muted">{node.objective}</p>
                        </div>
                        <Pill tone={node.state === 'completed' ? 'green' : node.state === 'blocked' ? 'amber' : 'neutral'}>{node.state}</Pill>
                      </div>
                      {node.dependencyNodeIds.length > 0 ? <p className="mt-2 font-mono text-[10px] text-muted">Depends on {node.dependencyNodeIds.join(', ')}</p> : <p className="mt-2 font-mono text-[10px] text-muted">Dependency root</p>}
                      <div className="mt-3 flex flex-wrap gap-1">
                        {node.stageTemplate.map((stage) => (
                          <span key={stage} className={cn('border px-2 py-1 font-mono text-[9px] uppercase tracking-wide', node.currentStage === stage ? 'border-teal-700 bg-teal-50 text-teal-700' : 'border-line text-muted')}>{stage}</span>
                        ))}
                      </div>
                      {workflow.handoffs.filter((handoff) => handoff.nodeId === node.nodeId).slice(-1).map((handoff) => (
                        <p key={handoff.handoffId} className="mt-3 border-l-2 border-line pl-3 text-xs leading-5 text-muted"><span className="font-medium text-ink">{handoff.stage} handoff:</span> {handoff.summary}</p>
                      ))}
                    </article>
                  ))}
                </div>
                <aside className="bg-card px-4 py-4 sm:px-5">
                  <h3 className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">Latest workflow updates</h3>
                  <ol className="mt-3 space-y-3">
                    {workflow.events.slice(0, 8).map((event) => (
                      <li key={event.eventId} className="border-l border-line pl-3">
                        <p className="text-xs leading-5 text-ink">{event.summary}</p>
                        <time className="font-mono text-[9px] text-muted" dateTime={event.createdAt}>{formatTime(event.createdAt)}</time>
                      </li>
                    ))}
                  </ol>
                  {artifacts.length > 0 ? (
                    <div className="mt-5 border-t border-line pt-4">
                      <h3 className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">Artifacts</h3>
                      <ul className="mt-2 space-y-1">
                        {artifacts.map((artifact) => <li key={artifact.artifactId} className="py-1">
                          {artifact.mediaType.startsWith('image/') && artifactUrls[artifact.artifactId] ? <img className="mb-2 max-h-40 w-full border border-line object-contain" src={artifactUrls[artifact.artifactId]} alt={artifact.caption} /> : null}
                          {artifactUrls[artifact.artifactId] ? <a className="block truncate text-xs text-teal-700 hover:underline" href={artifactUrls[artifact.artifactId]} target="_blank" rel="noreferrer">{artifact.caption}</a> : <span className="block truncate text-xs text-muted">{artifact.caption}</span>}
                        </li>)}
                      </ul>
                    </div>
                  ) : null}
                </aside>
              </div>
            ) : <div className="px-5 py-10 text-center text-sm text-muted">A dependency map will appear after task curation proposes a workflow plan.</div>}
          </Card>
        </section>

        <div className="mt-6 grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
          <div className="min-w-0 space-y-5">
            <section aria-labelledby="project-work-heading">
              <Card className={cn(warmCard, 'overflow-hidden')}>
                <div className="border-b border-line px-4 py-4 sm:px-5">
                  <h2 id="project-work-heading" className="text-sm font-medium text-ink">All work</h2>
                  <p className="mt-1 text-xs text-muted">{tasks.length} tracked {tasks.length === 1 ? 'task' : 'tasks'}, grouped by current state.</p>
                </div>
                {taskGroups.length > 0 ? (
                  <div className="divide-y divide-line">
                    {taskGroups.map((group) => (
                      <section key={group.label} aria-labelledby={`work-group-${group.label.replaceAll(' ', '-').toLowerCase()}`} className="px-4 py-4 sm:px-5">
                        <div className="flex items-center justify-between gap-3">
                          <h3 id={`work-group-${group.label.replaceAll(' ', '-').toLowerCase()}`} className={cn('text-[10px] font-medium uppercase tracking-[0.13em]', group.tone)}>{group.label}</h3>
                          <span className="text-[10px] tabular-nums text-muted">{group.tasks.length}</span>
                        </div>
                        <ul className="mt-2 space-y-1">
                          {group.tasks.map((task) => (
                            <li key={task.id}>
                              <button type="button" className="flex w-full items-start justify-between gap-3 border-l-2 border-transparent px-2 py-2 text-left transition-colors hover:border-l-taupe hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover" onClick={() => onTask(task.id)}>
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-medium text-ink">{task.title}</span>
                                  <span className="mt-0.5 block truncate text-[11px] text-muted">
                                    {task.assignedAgentId ? agentById.get(task.assignedAgentId)?.name ?? task.assignedAgentId : 'Unassigned'}
                                    {task.result?.trim() ? ` · ${task.result.trim()}` : ''}
                                  </span>
                                </span>
                                <time dateTime={task.updatedAt} className="shrink-0 text-[10px] text-muted">{formatTime(task.updatedAt)}</time>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                ) : <div className="px-5 py-10 text-center text-sm text-muted">No work has been recorded for this project yet.</div>}
              </Card>
            </section>

            <section aria-labelledby="project-updates-heading">
              <Card className={cn(warmCard, 'overflow-hidden')}>
                <div className="border-b border-line px-4 py-4 sm:px-5">
                  <h2 id="project-updates-heading" className="text-sm font-medium text-ink">Activity history</h2>
                  <p className="mt-1 text-xs text-muted">Recorded progress, decisions, questions, and results.</p>
                </div>
                {updates.length > 0
                  ? <ol className="divide-y divide-line">{updates.map(updateRow)}</ol>
                  : <div className="px-5 py-10 text-center text-sm text-muted">Activity will appear when tasks or agents record progress.</div>}
              </Card>
            </section>
          </div>

          <div className="min-w-0 space-y-5">
            <section aria-labelledby="project-team-heading">
              <Card className={cn(warmCard, 'overflow-hidden')}>
                <div className="border-b border-line px-4 py-4 sm:px-5">
                  <h2 id="project-team-heading" className="text-sm font-medium text-ink">Team</h2>
                  <p className="mt-1 text-xs text-muted">{agents.length} {agents.length === 1 ? 'agent' : 'agents'} assigned to this project.</p>
                </div>
                {agents.length > 0 ? (
                  <ul className="divide-y divide-line">
                    {agents.map((agent) => {
                      const currentTask = tasks.find((task) => task.id === agent.currentTaskId);
                      return (
                        <li key={agent.id} className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
                          <span className="mt-1"><span className="sr-only">{agentWorkLabel(agent.status)}</span><span className={cn('block size-2 rounded-full', agent.status === 'failed' ? 'bg-urgent' : agent.status === 'running' || agent.status === 'queued' ? 'bg-success-fill' : 'bg-taupe')} /></span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-ink">{agent.name}</span>
                            <span className="mt-0.5 block text-[11px] text-muted">{agent.role} · {agentWorkLabel(agent.status)}</span>
                            <span className="mt-1 block truncate text-xs text-muted">{currentTask?.title ?? agent.area}</span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : <div className="px-5 py-8 text-sm text-muted">No agents are assigned to this project.</div>}
              </Card>
            </section>

            <section aria-labelledby="project-details-heading">
              <Card className={cn(warmCard, 'overflow-hidden')}>
                <div className="border-b border-line px-4 py-4 sm:px-5">
                  <h2 id="project-details-heading" className="text-sm font-medium text-ink">Project context</h2>
                </div>
                {metadata.summaries.length > 0 || metadata.entries.length > 0 ? (
                  <div className="px-4 py-4 sm:px-5">
                    {metadata.summaries.length > 0 ? (
                      <div className="space-y-2">
                        <h3 className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">Summary</h3>
                        {metadata.summaries.map((summary, index) => (
                          <p key={`${summary}:${index}`} className="whitespace-pre-wrap break-words text-sm leading-6 text-muted">{summary}</p>
                        ))}
                      </div>
                    ) : null}
                    {metadata.entries.length > 0 ? (
                      <div className={cn(metadata.summaries.length > 0 && 'mt-4 border-t border-line pt-4')}>
                        <ProjectResourceDashboard projectId={project.id} entries={metadata.entries} />
                      </div>
                    ) : null}
                  </div>
                ) : <div className="px-5 py-8 text-sm leading-6 text-muted">No project summary or resources have been recorded.</div>}
              </Card>
            </section>
          </div>
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
