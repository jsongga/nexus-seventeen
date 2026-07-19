import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CirclePause,
  Clock3,
  FolderKanban,
  HelpCircle,
  ListTodo,
  MessageSquareText,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  UserRoundCheck,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Card, FieldLabel, Modal, Pill, cn, inputClass } from '../components/ui';
import { createTaskBoardClient, type TaskBoardClient } from './client';
import { parseTaskProposal, proposalChildInput, proposalIsOnBoard, type TaskProposal } from './proposals';
import { AgentPage, DocumentsPage, ProjectPage } from './WorkspacePages';
import { WorkspaceFrame, type BoardPage } from './WorkspaceSidebar';
import { isExplicitPointOfContact, selectPointOfContact } from './workspace-model';
import type {
  BoardAgent,
  BoardMessage,
  BoardQuestion,
  BoardRun,
  BoardSnapshot,
  BoardTask,
  CreateAgentInput,
  CreateProjectInput,
  CreateTaskInput,
  TaskKind,
  TaskStatus,
} from './types';

const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const taskStatusOrder: Record<TaskStatus, number> = {
  waiting_for_human: 0,
  running: 1,
  queued: 2,
  proposed: 3,
  backlog: 4,
  blocked: 5,
  failed: 6,
  interrupted: 7,
  completed: 8,
};

const statusTone: Record<TaskStatus, 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'purple'> = {
  proposed: 'purple',
  backlog: 'neutral',
  queued: 'blue',
  running: 'green',
  waiting_for_human: 'amber',
  blocked: 'amber',
  completed: 'green',
  failed: 'red',
  interrupted: 'red',
};

const agentMinuteOptions = [15, 30, 45, 60, 90, 120, 180, 240] as const;

type DialogName = 'project' | 'agent' | 'task' | 'connection' | null;

interface ConnectionSettings {
  baseUrl: string;
  token: string;
}

function defaultBaseUrl(): string {
  const configured = document.querySelector<HTMLMetaElement>('meta[name="cicada-task-board-url"]')?.content;
  if (configured) return configured;
  return '/board-api';
}

function initialConnection(): ConnectionSettings {
  return {
    baseUrl: window.sessionStorage.getItem('cicada.taskBoardUrl') ?? defaultBaseUrl(),
    token: window.sessionStorage.getItem('cicada.humanToken') ?? '',
  };
}

function prettyStatus(value: string): string {
  return value.replaceAll('_', ' ');
}

const taskKindLabel: Record<TaskKind, string> = {
  work: 'work',
  manager_review: 'manager review',
  human_check: 'human check',
};

function formatTime(value: string | null): string {
  if (value === null) return 'Not recorded';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : dateTime.format(parsed);
}

function fullTime(value: string | null): string | undefined {
  if (value === null) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}

function taskStatusLabel(task: BoardTask): string {
  if (task.kind !== 'human_check') return prettyStatus(task.status);
  if (task.status === 'completed') return 'approved';
  if (task.status === 'failed') return 'changes requested';
  if (task.endedAt === null) return 'awaiting human';
  return prettyStatus(task.status);
}

function StatusPill({ task }: { task: BoardTask }) {
  return <Pill tone={statusTone[task.status]} dot>{taskStatusLabel(task)}</Pill>;
}

function TaskKindPill({ kind }: { kind: TaskKind }) {
  const tone = kind === 'human_check' ? 'purple' : kind === 'manager_review' ? 'amber' : 'neutral';
  return <Pill tone={tone}>{taskKindLabel[kind]}</Pill>;
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center px-5 py-10 text-center">
      <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-teal-soft text-teal-700">
        {icon}
      </div>
      <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
      <p className="mt-1 max-w-md text-sm leading-6 text-muted">{body}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

function FormError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-[10px] border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent">
      {children}
    </div>
  );
}

function TaskRow({
  task,
  selected,
  agent,
  projectName,
  openQuestion,
  onSelect,
}: {
  task: BoardTask;
  selected: boolean;
  agent: BoardAgent | undefined;
  projectName?: string;
  openQuestion: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full border-b border-line-soft px-4 py-4 text-left transition-colors last:border-b-0 hover:bg-[#fafbfb] sm:px-5',
        selected && 'bg-teal-soft/45 hover:bg-teal-soft/60',
      )}
    >
      <div className="flex items-start gap-3">
        <span className={cn(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg',
          task.status === 'completed' ? 'bg-teal-soft text-teal-700' :
            openQuestion ? 'bg-caution-soft text-caution' : 'bg-line-soft text-muted',
        )}>
          {task.status === 'completed' ? <CheckCircle2 size={16} /> : task.kind === 'human_check' ? <UserRoundCheck size={16} /> : openQuestion ? <HelpCircle size={16} /> : <ListTodo size={16} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-display text-[14px] font-semibold leading-5 text-ink">{task.title}</span>
            <StatusPill task={task} />
            <TaskKindPill kind={task.kind} />
          </span>
          <span className="mt-1.5 block line-clamp-2 text-xs leading-5 text-muted">{task.objective}</span>
          <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
            {task.kind === 'human_check' ? (
              <span>Human decision · external release gate</span>
            ) : (
              <>
                <span>{agent ? `${agent.name} · ${agent.area}` : task.requiredRole ? `Needs ${task.requiredRole}` : 'Unassigned'}</span>
                {projectName ? <span>{projectName}</span> : null}
                <span className="inline-flex items-center gap-1"><Clock3 size={12} /> {task.expectedAgentMinutes} agent min</span>
                {task.expectedCompletedAt ? <span>Due {formatTime(task.expectedCompletedAt)}</span> : null}
              </>
            )}
          </span>
        </span>
        <ChevronRight size={17} className="mt-1 shrink-0 text-muted" />
      </div>
    </button>
  );
}

function TimelineItem({
  message,
  author,
}: {
  message: BoardMessage;
  author: BoardAgent | undefined;
}) {
  const label = message.authorType === 'human'
    ? 'You'
    : message.authorType === 'system'
      ? 'System'
      : author?.name ?? 'Agent';
  return (
    <li className="relative pl-6 before:absolute before:left-[5px] before:top-2 before:size-2 before:rounded-full before:bg-teal-500 after:absolute after:bottom-[-18px] after:left-[8px] after:top-4 after:w-px after:bg-line last:after:hidden">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-bold text-ink">{label}</span>
        <Pill tone={message.kind === 'question' ? 'amber' : message.kind === 'result' ? 'green' : 'neutral'}>{message.kind}</Pill>
        <time className="text-muted" dateTime={message.createdAt} title={fullTime(message.createdAt)}>{formatTime(message.createdAt)}</time>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-[#3f4852]">{message.body}</p>
    </li>
  );
}

function ProposalCard({
  message,
  parent,
  tasks,
  busy,
  onPromote,
}: {
  message: BoardMessage;
  parent: BoardTask;
  tasks: BoardTask[];
  busy: boolean;
  onPromote: (proposal: TaskProposal) => Promise<void>;
}) {
  const proposal = message.authorType === 'agent' ? parseTaskProposal(message.body) : null;
  const promoted = proposal ? proposalIsOnBoard(parent, proposal, tasks) : false;
  if (proposal === null) {
    return (
      <li className="rounded-xl border border-caution-fill/35 bg-caution-soft/35 p-4">
        <div className="flex flex-wrap items-center gap-2 text-[11px]"><span className="font-bold text-ink">Agent proposal unavailable</span><Pill tone="amber">not actionable</Pill><time className="text-muted" dateTime={message.createdAt}>{formatTime(message.createdAt)}</time></div>
        <p className="mt-2 text-sm leading-6 text-muted">This proposal was malformed and was not added to the todo list.</p>
      </li>
    );
  }
  return (
    <li className="rounded-xl border border-teal-500/25 bg-teal-soft/35 p-4">
      <div className="flex flex-wrap items-center gap-2 text-[11px]"><span className="font-bold text-ink">Agent proposal</span><Pill tone="purple">human decision</Pill><time className="text-muted" dateTime={message.createdAt}>{formatTime(message.createdAt)}</time></div>
      <h4 className="mt-3 font-display text-[15px] font-semibold text-ink">{proposal.title}</h4>
      <p className="mt-1.5 text-sm leading-6 text-muted">{proposal.objective}</p>
      <div className="mt-3 rounded-lg border border-line/70 bg-white/70 px-3 py-2.5"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Done means</p><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-ink">{proposal.acceptanceCriteria}</p></div>
      {promoted ? (
        <div className="mt-3 flex items-center gap-2 text-xs font-semibold text-teal-700"><CheckCircle2 size={15} /> Already on the todo list</div>
      ) : (
        <>
          <Button
            className="mt-3 w-full"
            size="sm"
            variant="mint"
            icon={<Plus size={15} />}
            disabled={busy}
            onClick={() => {
              const confirmed = window.confirm(`Add “${proposal.title}” as an unassigned child todo? This will not wake an agent.`);
              if (confirmed) void onPromote(proposal);
            }}
          >
            Add unassigned child todo
          </Button>
          <p className="mt-2 text-[11px] leading-4 text-muted">Inherits this task's workspace scope and starts with a 30-minute agent estimate. Assignment is separate.</p>
        </>
      )}
    </li>
  );
}

function TaskDetail({
  task,
  childTasks,
  agents,
  messages,
  questions,
  runs,
  busy,
  onAssign,
  onAnswer,
  onResume,
  onInterrupt,
  onMessage,
  onPromoteProposal,
  onDecideHumanCheck,
}: {
  task: BoardTask;
  childTasks: BoardTask[];
  agents: BoardAgent[];
  messages: BoardMessage[];
  questions: BoardQuestion[];
  runs: BoardRun[];
  busy: boolean;
  onAssign: (agentId: string, minutes: number) => Promise<void>;
  onAnswer: (questionId: string, answer: string) => Promise<void>;
  onResume: () => Promise<void>;
  onInterrupt: (runId: string) => Promise<void>;
  onMessage: (body: string) => Promise<void>;
  onPromoteProposal: (proposal: TaskProposal) => Promise<void>;
  onDecideHumanCheck: (status: 'completed' | 'failed', rationale: string) => Promise<boolean>;
}) {
  const eligibleAgents = useMemo(
    () => task.requiredRole === null ? agents : agents.filter((agent) => agent.role === task.requiredRole),
    [agents, task.requiredRole],
  );
  const defaultAgentId = task.assignedAgentId ?? eligibleAgents[0]?.id ?? '';
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [minutes, setMinutes] = useState(task.expectedAgentMinutes);
  const [answer, setAnswer] = useState('');
  const [note, setNote] = useState('');
  const [decisionRationale, setDecisionRationale] = useState('');
  const openQuestion = questions.find((question) => question.status === 'open');
  const activeRun = runs.find((run) => run.status === 'running' || run.status === 'queued');
  const assignedAgent = agents.find((agent) => agent.id === task.assignedAgentId);

  useEffect(() => {
    setAgentId(defaultAgentId);
    setMinutes(task.expectedAgentMinutes);
    setAnswer('');
    setNote('');
    setDecisionRationale('');
  }, [defaultAgentId, task.expectedAgentMinutes, task.id]);

  return (
    <Card className="overflow-hidden xl:sticky xl:top-5 xl:max-h-[calc(100dvh-40px)] xl:overflow-y-auto">
      <header className="border-b border-line px-5 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill task={task} />
          <TaskKindPill kind={task.kind} />
          <span className="font-mono text-[10px] text-muted">v{task.version}</span>
        </div>
        <h2 className="mt-3 font-display text-xl font-semibold tracking-[-0.025em] text-ink">{task.title}</h2>
        <p className="mt-2 text-sm leading-6 text-muted">{task.objective}</p>
      </header>

      {task.kind !== 'human_check' && openQuestion ? (
        <section className="border-b border-caution-fill/30 bg-caution-soft/55 px-5 py-5">
          <div className="flex items-center gap-2 text-caution">
            <HelpCircle size={17} />
            <h3 className="text-xs font-bold uppercase tracking-[0.12em]">Waiting for your answer</h3>
          </div>
          <p className="mt-3 text-sm font-semibold leading-6 text-ink">{openQuestion.prompt}</p>
          <textarea
            className={cn(inputClass, 'mt-3 min-h-24 resize-y py-3')}
            placeholder="Give the decision or missing context…"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <Button
            className="mt-3 w-full"
            variant="primary"
            icon={<Send size={16} />}
            disabled={busy || answer.trim().length === 0}
            onClick={() => void onAnswer(openQuestion.id, answer.trim()).then(() => setAnswer(''))}
          >
            Answer and wake agent
          </Button>
          <p className="mt-2 text-[11px] leading-4 text-caution">This answer creates a single durable wake-up. The agent is not running while it waits.</p>
        </section>
      ) : null}

      <section className="border-b border-line px-5 py-5">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Ownership & timing</h3>
        {task.kind === 'human_check' ? (
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
            <div><dt className="text-muted">Owner</dt><dd className="mt-1 font-semibold text-ink">Human</dd></div>
            <div><dt className="text-muted">Release action</dt><dd className="mt-1 font-semibold text-ink">External and human-controlled</dd></div>
            <div><dt className="text-muted">Opened</dt><dd className="mt-1 font-mono text-[11px] text-ink" title={fullTime(task.createdAt)}>{formatTime(task.createdAt)}</dd></div>
            <div><dt className="text-muted">Decided</dt><dd className="mt-1 font-mono text-[11px] text-ink" title={fullTime(task.endedAt)}>{formatTime(task.endedAt)}</dd></div>
          </dl>
        ) : (
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
            <div><dt className="text-muted">Agent</dt><dd className="mt-1 font-semibold text-ink">{assignedAgent?.name ?? 'Unassigned'}</dd></div>
            <div><dt className="text-muted">Area</dt><dd className="mt-1 font-semibold text-ink">{assignedAgent?.area ?? '—'}</dd></div>
            <div><dt className="text-muted">Started</dt><dd className="mt-1 font-mono text-[11px] text-ink" title={fullTime(task.startedAt)}>{formatTime(task.startedAt)}</dd></div>
            <div><dt className="text-muted">Ended</dt><dd className="mt-1 font-mono text-[11px] text-ink" title={fullTime(task.endedAt)}>{formatTime(task.endedAt)}</dd></div>
            <div><dt className="text-muted">Agent estimate</dt><dd className="mt-1 font-mono text-[11px] text-ink">{task.expectedAgentMinutes} minutes</dd></div>
            <div><dt className="text-muted">Expected by</dt><dd className="mt-1 font-mono text-[11px] text-ink" title={fullTime(task.expectedCompletedAt)}>{formatTime(task.expectedCompletedAt)}</dd></div>
            {task.requiredRole ? <div><dt className="text-muted">Required role</dt><dd className="mt-1 font-semibold text-ink">{task.requiredRole}</dd></div> : null}
          </dl>
        )}
      </section>

      {task.acceptanceCriteria ? (
        <section className="border-b border-line px-5 py-5">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Done means</h3>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink">{task.acceptanceCriteria}</p>
        </section>
      ) : null}

      {task.workspaceRefs.length > 0 ? (
        <section className="border-b border-line px-5 py-5">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Allowed workspace scope</h3>
          <ul className="mt-2 space-y-1.5">
            {task.workspaceRefs.map((reference) => <li key={reference} className="break-all rounded-md bg-line-soft px-2.5 py-1.5 font-mono text-[11px] text-ink">{reference}</li>)}
          </ul>
        </section>
      ) : null}

      {task.result ? (
        <section className="border-b border-teal-500/25 bg-teal-soft/45 px-5 py-5">
          <div className="flex items-center gap-2 text-teal-700"><Sparkles size={17} /><h3 className="text-[11px] font-bold uppercase tracking-[0.14em]">{task.kind === 'human_check' ? 'Recorded human decision' : 'Result for users'}</h3></div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink">{task.result}</p>
        </section>
      ) : null}

      {task.kind === 'human_check' && task.endedAt === null ? (
        <section className="border-b border-caution-fill/30 bg-caution-soft/45 px-5 py-5">
          <div className="flex items-center gap-2 text-caution"><UserRoundCheck size={17} /><h3 className="text-[11px] font-bold uppercase tracking-[0.14em]">Human release decision</h3></div>
          <p className="mt-3 text-sm leading-6 text-ink">Review the completed work and manager assessment, then record your decision.</p>
          <p className="mt-2 text-xs font-semibold leading-5 text-caution">Approval does not deploy to production. It only marks this check complete for a separate, external human-controlled release step.</p>
          <FieldLabel htmlFor={`human-decision-${task.id}`}>Decision rationale</FieldLabel>
          <textarea
            id={`human-decision-${task.id}`}
            className={cn(inputClass, 'min-h-24 resize-y py-3')}
            placeholder="Why is this ready, or what must change?"
            value={decisionRationale}
            onChange={(event) => setDecisionRationale(event.target.value)}
          />
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Button
              variant="mint"
              icon={<CheckCircle2 size={16} />}
              disabled={busy || decisionRationale.trim().length === 0}
              onClick={() => void onDecideHumanCheck('completed', decisionRationale.trim()).then((saved) => { if (saved) setDecisionRationale(''); })}
            >
              Approve for external release step
            </Button>
            <Button
              variant="danger"
              icon={<CircleAlert size={16} />}
              disabled={busy || decisionRationale.trim().length === 0}
              onClick={() => void onDecideHumanCheck('failed', decisionRationale.trim()).then((saved) => { if (saved) setDecisionRationale(''); })}
            >
              Request changes
            </Button>
          </div>
        </section>
      ) : null}

      {task.kind !== 'human_check' && (task.status === 'backlog' || task.status === 'proposed' || task.status === 'blocked' || task.status === 'interrupted' || task.status === 'failed') && !openQuestion ? (
        <section className="border-b border-line px-5 py-5">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Human control</h3>
          {task.status === 'blocked' || task.status === 'interrupted' || task.status === 'failed' ? (
            <Button className="mt-3 w-full" variant="mint" icon={<Activity size={16} />} disabled={busy || !task.assignedAgentId} onClick={() => void onResume()}>
              Resume assigned agent
            </Button>
          ) : (
            <div className="mt-3 space-y-3">
              {task.kind === 'manager_review' ? <p className="text-xs leading-5 text-muted">This review stays asleep until a human assigns a manager. Assignment creates one durable human wake-up.</p> : null}
              {eligibleAgents.length > 0 ? (
                <select className={inputClass} aria-label={task.kind === 'manager_review' ? 'Assign manager' : 'Assign agent'} value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                  {eligibleAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} — {agent.area}</option>)}
                </select>
              ) : <p className="rounded-lg bg-line-soft px-3 py-2.5 text-xs text-muted">No {task.requiredRole ?? 'eligible'} agent is available. Add one before assigning this task.</p>}
              <select className={inputClass} aria-label="Expected agent time" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
                {agentMinuteOptions.map((value) => <option key={value} value={value}>{value} agent minutes</option>)}
              </select>
              <Button className="w-full" variant="primary" icon={<UserRoundCheck size={16} />} disabled={busy || agentId.length === 0} onClick={() => void onAssign(agentId, minutes)}>
                {task.kind === 'manager_review' ? 'Assign manager and wake' : 'Assign and wake agent'}
              </Button>
            </div>
          )}
        </section>
      ) : null}

      {task.kind !== 'human_check' && activeRun ? (
        <section className="border-b border-line px-5 py-5">
          <div className="flex items-center justify-between gap-3">
            <div><h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Current run</h3><p className="mt-1 text-xs text-muted">Started {formatTime(activeRun.startedAt)}</p></div>
            <Button variant="danger" size="sm" icon={<Square size={14} />} disabled={busy} onClick={() => void onInterrupt(activeRun.id)}>Interrupt</Button>
          </div>
        </section>
      ) : null}

      <section className="border-b border-line px-5 py-5">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Progress record</h3>
        {messages.length > 0 ? (
          <ol className="mt-4 space-y-5">
            {messages.map((message) => message.kind === 'proposal'
              ? <ProposalCard key={message.id} message={message} parent={task} tasks={childTasks} busy={busy} onPromote={onPromoteProposal} />
              : <TimelineItem key={message.id} message={message} author={agents.find((agent) => agent.id === message.authorId)} />)}
          </ol>
        ) : <p className="mt-3 text-sm text-muted">No progress has been recorded yet.</p>}
      </section>

      <form
        className="px-5 py-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (note.trim().length === 0) return;
          void onMessage(note.trim()).then(() => setNote(''));
        }}
      >
        <FieldLabel htmlFor="human-note">Add context without waking the agent</FieldLabel>
        <textarea id="human-note" className={cn(inputClass, 'min-h-20 resize-y py-3')} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Decision, constraint, or observation…" />
        <Button className="mt-3 w-full" type="submit" icon={<MessageSquareText size={16} />} disabled={busy || note.trim().length === 0}>Record note</Button>
      </form>
    </Card>
  );
}

function ProjectForm({ busy, onSubmit }: { busy: boolean; onSubmit: (input: CreateProjectInput) => Promise<void> }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <form className="space-y-4 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); void onSubmit({ name: name.trim(), description: description.trim() }); }}>
      <div><FieldLabel htmlFor="project-name">Project name</FieldLabel><input id="project-name" className={inputClass} autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="Cicada platform" /></div>
      <div><FieldLabel htmlFor="project-description">Outcome</FieldLabel><textarea id="project-description" className={cn(inputClass, 'min-h-24 resize-y py-3')} required value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What should this system become better at?" /></div>
      <Button className="w-full" type="submit" variant="primary" disabled={busy || name.trim().length === 0 || description.trim().length === 0}>Create project</Button>
    </form>
  );
}

function AgentForm({ projectId, busy, onSubmit }: { projectId: string; busy: boolean; onSubmit: (input: CreateAgentInput) => Promise<void> }) {
  const [agentId, setAgentId] = useState('');
  const [role, setRole] = useState<CreateAgentInput['role']>('engineer');
  const [area, setArea] = useState('');
  const [mission, setMission] = useState('');
  const [model, setModel] = useState('');
  const [token, setToken] = useState(() => `${crypto.randomUUID()}${crypto.randomUUID()}`);
  return (
    <form className="space-y-4 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); void onSubmit({ projectId, agentId: agentId.trim(), role, area: area.trim(), mission: mission.trim(), model: model.trim(), token }); }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div><FieldLabel htmlFor="agent-name">Agent ID</FieldLabel><input id="agent-name" className={inputClass} required pattern="[A-Za-z0-9][A-Za-z0-9._:@/-]*" value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="billing-engineer" /></div>
        <div><FieldLabel htmlFor="agent-role">Fixed role</FieldLabel><select id="agent-role" className={inputClass} value={role} onChange={(event) => setRole(event.target.value as CreateAgentInput['role'])}><option value="engineer">Engineer</option><option value="manager">Manager</option><option value="verifier">Verifier</option></select></div>
      </div>
      <div><FieldLabel htmlFor="agent-area">Owned part of the system</FieldLabel><input id="agent-area" className={inputClass} required value={area} onChange={(event) => setArea(event.target.value)} placeholder="Billing and subscriptions" /></div>
      <div><FieldLabel htmlFor="agent-mission">Standing mission</FieldLabel><textarea id="agent-mission" className={cn(inputClass, 'min-h-24 resize-y py-3')} required value={mission} onChange={(event) => setMission(event.target.value)} placeholder="Keep billing reliable, understandable, and easier for customers to manage." /></div>
      <div><FieldLabel htmlFor="agent-model">Provider model or routing profile</FieldLabel><input id="agent-model" className={inputClass} required value={model} onChange={(event) => setModel(event.target.value)} placeholder="Configured model ID" /></div>
      <div><FieldLabel htmlFor="agent-token">One-time worker credential</FieldLabel><div className="flex gap-2"><input id="agent-token" className={cn(inputClass, 'font-mono text-xs')} required minLength={32} value={token} onChange={(event) => setToken(event.target.value)} /><Button size="sm" onClick={() => void navigator.clipboard.writeText(token)}>Copy</Button></div><p className="mt-1.5 text-[11px] leading-4 text-muted">Copy this into the worker configuration now. The board stores only its hash and cannot show it again.</p></div>
      <Button className="w-full" type="submit" variant="primary" disabled={busy || !agentId.trim() || !area.trim() || !mission.trim() || !model.trim() || token.length < 32}>Add sleeping agent</Button>
    </form>
  );
}

function TaskForm({ projectId, tasks, busy, onSubmit }: { projectId: string; tasks: BoardTask[]; busy: boolean; onSubmit: (input: CreateTaskInput) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [criteria, setCriteria] = useState('');
  const [workspaceRefs, setWorkspaceRefs] = useState('');
  const [parentTaskId, setParentTaskId] = useState('');
  const [minutes, setMinutes] = useState(30);
  return (
    <form className="space-y-4 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); void onSubmit({ projectId, parentTaskId: parentTaskId || null, title: title.trim(), objective: objective.trim(), acceptanceCriteria: criteria.trim(), workspaceRefs: workspaceRefs.split('\n').map((value) => value.trim()).filter(Boolean), expectedAgentMinutes: minutes }); }}>
      <div><FieldLabel htmlFor="task-title">Task</FieldLabel><input id="task-title" className={inputClass} autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Make invoice failures easier to recover from" /></div>
      <div><FieldLabel htmlFor="task-objective">User outcome</FieldLabel><textarea id="task-objective" className={cn(inputClass, 'min-h-24 resize-y py-3')} required value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Describe the impact, not the implementation." /></div>
      <div><FieldLabel htmlFor="task-criteria">Done means</FieldLabel><textarea id="task-criteria" className={cn(inputClass, 'min-h-20 resize-y py-3')} required value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="Observable checks the engineer and manager can verify." /></div>
      <div><FieldLabel htmlFor="task-workspaces">Workspace paths or repository refs</FieldLabel><textarea id="task-workspaces" className={cn(inputClass, 'min-h-20 resize-y py-3 font-mono text-xs')} required value={workspaceRefs} onChange={(event) => setWorkspaceRefs(event.target.value)} placeholder={'/absolute/path/to/repository\npackages/billing'} /><p className="mt-1.5 text-[11px] leading-4 text-muted">One per line. These are the only system areas the worker should place in this task's context.</p></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div><FieldLabel htmlFor="task-parent">Parent task</FieldLabel><select id="task-parent" className={inputClass} value={parentTaskId} onChange={(event) => setParentTaskId(event.target.value)}><option value="">None</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></div>
        <div><FieldLabel htmlFor="task-minutes">Expected agent time</FieldLabel><select id="task-minutes" className={inputClass} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>{agentMinuteOptions.map((value) => <option key={value} value={value}>{value} minutes</option>)}</select></div>
      </div>
      <Button className="w-full" type="submit" variant="primary" disabled={busy || !title.trim() || !objective.trim() || !criteria.trim() || !workspaceRefs.trim()}>Add to todo list</Button>
    </form>
  );
}

function ConnectionForm({ settings, busy, onSubmit }: { settings: ConnectionSettings; busy: boolean; onSubmit: (settings: ConnectionSettings) => void }) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [token, setToken] = useState(settings.token);
  return (
    <form className="space-y-4 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); onSubmit({ baseUrl: baseUrl.trim().replace(/\/$/, ''), token: token.trim() }); }}>
      <div><FieldLabel htmlFor="board-url">Task board URL</FieldLabel><input id="board-url" className={inputClass} required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://127.0.0.1:4318" /></div>
      <div><FieldLabel htmlFor="human-token">Human access token</FieldLabel><input id="human-token" type="password" className={inputClass} value={token} onChange={(event) => setToken(event.target.value)} placeholder="Required when board authentication is enabled" /></div>
      <p className="text-xs leading-5 text-muted">Saved only for this browser tab. Agent credentials stay in the worker and are never sent to this frontend.</p>
      <Button className="w-full" type="submit" variant="primary" disabled={busy || baseUrl.trim().length === 0}>Connect</Button>
    </form>
  );
}

export function BoardApp() {
  const [connection, setConnection] = useState<ConnectionSettings>(initialConnection);
  const client = useMemo<TaskBoardClient>(() => createTaskBoardClient({ baseUrl: connection.baseUrl, token: connection.token }), [connection]);
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [page, setPage] = useState<BoardPage>({ kind: 'tasks' });
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDetailOpen, setTaskDetailOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [dialogProjectId, setDialogProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshSequence = useRef(0);
  const refreshController = useRef<AbortController | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    const sequence = ++refreshSequence.current;
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    if (!quiet) setLoading(true);
    try {
      const next = await client.getSnapshot(controller.signal);
      if (sequence !== refreshSequence.current) return;
      setSnapshot(next);
      setError(null);
      setConnected(true);
      setLastSyncedAt(new Date().toISOString());
      setPage((current) => {
        if (current.kind === 'project' && !next.projects.some((project) => project.id === current.projectId)) return { kind: 'tasks' };
        if (current.kind === 'agent' && !next.agents.some((agent) => agent.id === current.agentId)) return { kind: 'tasks' };
        return current;
      });
      setSelectedTaskId((current) => current && next.tasks.some((task) => task.id === current) ? current : null);
    } catch (caught) {
      if (controller.signal.aborted || sequence !== refreshSequence.current) return;
      setConnected(false);
      setError(caught instanceof Error ? caught.message : 'Could not connect to the task board');
    } finally {
      if (sequence === refreshSequence.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    refreshController.current?.abort();
    setSnapshot(null);
    setPage({ kind: 'tasks' });
    setSelectedTaskId(null);
    setTaskDetailOpen(false);
    setConnected(false);
    setLastSyncedAt(null);
    setError(null);
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true);
    }, 5_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      refreshController.current?.abort();
      refreshSequence.current += 1;
    };
  }, [refresh]);

  const mutate = useCallback(async (operation: () => Promise<unknown>): Promise<boolean> => {
    if (!connected) {
      setError('The task board is disconnected. Reconnect before making changes');
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      await operation();
      setDialog(null);
      await refresh(true);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The change could not be saved');
      return false;
    } finally {
      setBusy(false);
    }
  }, [connected, refresh]);

  const allTasks = useMemo(() => [...(snapshot?.tasks ?? [])].sort((left, right) => taskStatusOrder[left.status] - taskStatusOrder[right.status] || right.updatedAt.localeCompare(left.updatedAt)), [snapshot]);
  const selectedTask = allTasks.find((task) => task.id === selectedTaskId) ?? allTasks[0];
  const selectedTaskAgents = snapshot?.agents.filter((agent) => agent.projectId === selectedTask?.projectId) ?? [];
  const taskMessages = snapshot?.messages.filter((message) => message.taskId === selectedTask?.id).sort((left, right) => left.createdAt.localeCompare(right.createdAt)) ?? [];
  const taskQuestions = snapshot?.questions.filter((question) => question.taskId === selectedTask?.id) ?? [];
  const taskRuns = snapshot?.runs.filter((run) => run.taskId === selectedTask?.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt)) ?? [];
  const openQuestionIds = new Set(snapshot?.questions.filter((question) => question.status === 'open').map((question) => question.taskId));
  const pointOfContact = selectPointOfContact(snapshot?.agents ?? []);
  const pageProject = page.kind === 'project' ? snapshot?.projects.find((project) => project.id === page.projectId) : undefined;
  const pageAgent = page.kind === 'agent' ? snapshot?.agents.find((agent) => agent.id === page.agentId) : undefined;
  const contextProjectId = dialogProjectId ?? pageProject?.id ?? pageAgent?.projectId ?? selectedTask?.projectId ?? snapshot?.projects[0]?.id ?? null;
  const contextProject = snapshot?.projects.find((project) => project.id === contextProjectId);
  const contextTasks = snapshot?.tasks.filter((task) => task.projectId === contextProjectId) ?? [];

  function openTask(taskId: string) {
    setSelectedTaskId(taskId);
    setPage({ kind: 'tasks' });
    setTaskDetailOpen(true);
  }

  function openDialog(name: Exclude<DialogName, null>, projectId?: string) {
    setDialogProjectId(projectId ?? null);
    setDialog(name);
  }

  async function createProject(input: CreateProjectInput): Promise<void> {
    await mutate(() => client.createProject(input));
  }

  async function createAgent(input: CreateAgentInput) {
    await mutate(() => client.createAgent(input));
  }

  async function createTask(input: CreateTaskInput) {
    await mutate(() => client.createTask(input));
  }

  let content: ReactNode;
  if (loading && snapshot === null) {
    content = <main className="p-4 sm:p-6 lg:p-8"><Card><EmptyState icon={<RefreshCw className="animate-spin" size={20} />} title="Locating your agents" body="Reading durable projects, tasks, questions, and progress from the task board." /></Card></main>;
  } else if (snapshot === null) {
    content = <main className="p-4 sm:p-6 lg:p-8"><Card><EmptyState icon={<CircleAlert size={20} />} title="Connect the task board" body="Start the task-board service or update the connection. The frontend intentionally has no local demo fallback." action={<Button variant="primary" onClick={() => openDialog('connection')}>Connection settings</Button>} /></Card></main>;
  } else if (snapshot.projects.length === 0) {
    content = <main className="p-4 sm:p-6 lg:p-8"><Card><EmptyState icon={<FolderKanban size={20} />} title="Create the first project" body="A project groups permanent agent identities, their owned areas, and the shared todo list." action={<Button variant="primary" icon={<Plus size={16} />} onClick={() => openDialog('project')}>Create project</Button>} /></Card></main>;
  } else if (page.kind === 'documents') {
    content = <DocumentsPage snapshot={snapshot} onProject={(projectId) => setPage({ kind: 'project', projectId })} />;
  } else if (page.kind === 'project' && pageProject) {
    content = <ProjectPage project={pageProject} snapshot={snapshot} onAddTask={() => openDialog('task', pageProject.id)} onAddAgent={() => openDialog('agent', pageProject.id)} onTask={openTask} onAgent={(agentId) => setPage({ kind: 'agent', agentId })} />;
  } else if (page.kind === 'agent' && pageAgent) {
    content = <AgentPage key={pageAgent.id} agent={pageAgent} snapshot={snapshot} isPointOfContact={pageAgent.id === pointOfContact?.id} explicitPointOfContact={pageAgent.id === pointOfContact?.id && isExplicitPointOfContact(pageAgent)} busy={busy || !connected} onTask={openTask} onSend={(prompt, workspaceRefs, routingContext) => mutate(() => client.createAgentQuery({ projectId: pageAgent.projectId, agentId: pageAgent.id, assignedRole: pageAgent.role, prompt, workspaceRefs, routingContext }))} />;
  } else {
    content = (
      <>
        <header className="flex flex-col gap-4 border-b border-line bg-white px-4 py-5 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-8">
          <div><p className="text-[11px] font-bold uppercase tracking-[0.14em] text-teal-700">Company work</p><h1 className="mt-1 font-display text-2xl font-semibold tracking-[-0.035em] sm:text-[28px]">Task List</h1><p className="mt-1 text-sm text-muted">One durable queue across every project. Only a human assignment, answer, resume, or direct request wakes an agent.</p></div>
          <div className="flex flex-wrap gap-2"><Button size="sm" icon={<RefreshCw size={15} className={loading ? 'animate-spin' : ''} />} disabled={loading} onClick={() => void refresh()}>Refresh</Button><Button size="sm" icon={<Plus size={15} />} disabled={!connected} onClick={() => openDialog('project')}>Project</Button><Button size="sm" variant="primary" icon={<Plus size={15} />} disabled={!connected || !contextProject} onClick={() => openDialog('task', contextProject?.id)}>Add task</Button></div>
        </header>
        <main className="mx-auto max-w-[1500px] p-4 sm:p-6 lg:p-8">
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(360px,.92fr)_minmax(420px,1.08fr)]">
            <Card className={cn('overflow-hidden', taskDetailOpen ? 'hidden xl:block' : 'block')}>
              <div className="flex items-center justify-between border-b border-line px-4 py-3.5 sm:px-5"><div><h2 className="text-sm font-bold">All projects</h2><p className="mt-0.5 text-[11px] text-muted">{allTasks.length} tasks · ordered by attention</p></div><ListTodo size={18} className="text-teal-700" /></div>
              {allTasks.length > 0 ? allTasks.map((task) => <TaskRow key={task.id} task={task} selected={task.id === selectedTask?.id} agent={snapshot.agents.find((agent) => agent.id === task.assignedAgentId)} projectName={snapshot.projects.find((project) => project.id === task.projectId)?.name} openQuestion={openQuestionIds.has(task.id)} onSelect={() => openTask(task.id)} />) : <EmptyState icon={<ListTodo size={19} />} title="Todo list is empty" body="Record a user outcome, then assign it when you want an agent to start." action={<Button size="sm" variant="primary" onClick={() => openDialog('task', contextProject?.id)}>Add task</Button>} />}
            </Card>
            <div className={cn(taskDetailOpen ? 'block' : 'hidden xl:block')}>
              {taskDetailOpen ? <Button className="mb-3 xl:hidden" size="sm" icon={<ArrowLeft size={15} />} onClick={() => setTaskDetailOpen(false)}>Back to task list</Button> : null}
              {selectedTask ? <TaskDetail key={selectedTask.id} task={selectedTask} childTasks={allTasks.filter((task) => task.parentTaskId === selectedTask.id)} agents={selectedTaskAgents} messages={taskMessages} questions={taskQuestions} runs={taskRuns} busy={busy || !connected} onAssign={async (agentId, expectedAgentMinutes) => { await mutate(() => client.assignTask(selectedTask.id, { agentId, expectedAgentMinutes, version: selectedTask.version })); }} onAnswer={async (questionId, answer) => { await mutate(() => client.answerQuestion(questionId, { answer })); }} onResume={async () => { await mutate(() => client.resumeTask(selectedTask.id, { version: selectedTask.version })); }} onInterrupt={async (runId) => { await mutate(() => client.interruptRun(runId)); }} onMessage={async (body) => { await mutate(() => client.addMessage(selectedTask.id, { body, version: selectedTask.version })); }} onPromoteProposal={async (proposal) => { await mutate(() => client.createTask(proposalChildInput(selectedTask, proposal))); }} onDecideHumanCheck={async (status, rationale) => { const result = status === 'completed' ? `Approved for an external human-controlled release step.\n\nRationale: ${rationale}` : `Changes requested by human.\n\nRationale: ${rationale}`; return mutate(() => client.decideHumanCheck(selectedTask.id, { version: selectedTask.version, status, result })); }} /> : <Card><EmptyState icon={<CirclePause size={19} />} title="Nothing selected" body="Choose a task to inspect its durable progress record and human controls." /></Card>}
            </div>
          </div>
        </main>
      </>
    );
  }

  return (
    <WorkspaceFrame snapshot={snapshot} page={page} pointOfContact={pointOfContact} connected={connected} lastSyncedLabel={lastSyncedAt ? `Read ${formatTime(lastSyncedAt)}` : 'No durable state read'} drawerOpen={drawerOpen} onDrawerChange={setDrawerOpen} onNavigate={(next) => { setPage(next); setTaskDetailOpen(false); }} onConnection={() => openDialog('connection')}>
      {error ? <div className="px-4 pt-4 sm:px-6 lg:px-8"><FormError><div className="flex items-start justify-between gap-4"><div><p className="font-semibold">Task board unavailable</p><p className="mt-1 text-xs leading-5 opacity-80">{error}. Existing durable state remains visible; no demo data is being shown.</p></div><button type="button" className="shrink-0 underline" onClick={() => openDialog('connection')}>Configure</button></div></FormError></div> : null}
      {content}

      <Modal open={dialog === 'project'} onClose={() => setDialog(null)} title="Create a project" description="A durable workspace for agent owners and their shared todo list."><ProjectForm busy={busy || !connected} onSubmit={createProject} /></Modal>
      <Modal open={dialog === 'agent'} onClose={() => setDialog(null)} title={contextProject ? `Add an agent to ${contextProject.name}` : 'Add a system owner'} description="The identity persists. The model process only exists during a run.">{contextProject ? <AgentForm projectId={contextProject.id} busy={busy || !connected} onSubmit={createAgent} /> : null}</Modal>
      <Modal open={dialog === 'task'} onClose={() => setDialog(null)} title={contextProject ? `Add a task to ${contextProject.name}` : 'Add a task'} description="Creating a task does not wake anyone. Assignment is a separate human action.">{contextProject ? <TaskForm projectId={contextProject.id} tasks={contextTasks} busy={busy || !connected} onSubmit={createTask} /> : null}</Modal>
      <Modal open={dialog === 'connection'} onClose={() => setDialog(null)} title="Task board connection" description="The UI can disappear without stopping agents or losing work."><ConnectionForm settings={connection} busy={busy} onSubmit={(next) => { window.sessionStorage.setItem('cicada.taskBoardUrl', next.baseUrl); window.sessionStorage.setItem('cicada.humanToken', next.token); setConnection(next); setDialog(null); }} /></Modal>
      {error && dialog ? <div role="alert" className="fixed bottom-4 left-4 right-4 z-[70] mx-auto max-w-lg rounded-xl border border-urgent/25 bg-urgent-soft px-4 py-3 text-sm text-urgent shadow-[0_12px_34px_rgba(23,28,36,.18)]"><div className="flex items-start justify-between gap-3"><span>{error}</span><button type="button" className="font-bold" onClick={() => setError(null)} aria-label="Dismiss error">×</button></div></div> : null}
    </WorkspaceFrame>
  );
}
