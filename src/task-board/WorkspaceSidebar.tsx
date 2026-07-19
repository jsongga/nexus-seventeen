import {
  CircleAlert,
  CircleX,
  ChevronRight,
  FileText,
  FolderKanban,
  ListTodo,
  Menu,
  MessageSquareText,
  Settings2,
  X,
} from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Avatar, Pill, cn } from '../components/ui';
import type { BoardAgent, BoardSnapshot } from './types';
import { isExplicitPointOfContact, taskNeedsHumanAction } from './workspace-model';

export type BoardPage =
  | { kind: 'tasks' }
  | { kind: 'documents' }
  | { kind: 'project'; projectId: string }
  | { kind: 'agent'; agentId: string };

function pageIs(page: BoardPage, kind: BoardPage['kind'], id?: string): boolean {
  if (page.kind !== kind) return false;
  if (page.kind === 'project') return page.projectId === id;
  if (page.kind === 'agent') return page.agentId === id;
  return true;
}

function AgentStatusMark({ agent }: { agent: BoardAgent }) {
  const active = agent.status === 'running' || agent.status === 'queued';
  const waiting = agent.status === 'waiting_for_human' || agent.status === 'interrupting';
  if (agent.status === 'failed') return <CircleX size={12} className="shrink-0 text-urgent" aria-label="failed" />;
  if (waiting) return <CircleAlert size={12} className="shrink-0 text-caution" aria-label={agent.status.replaceAll('_', ' ')} />;
  return (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full border border-white',
        active ? 'bg-teal-500' : 'bg-[#aab1b8]',
      )}
      title={agent.status.replaceAll('_', ' ')}
    >
      <span className="sr-only">{agent.status.replaceAll('_', ' ')}</span>
    </span>
  );
}

function RailContent({
  snapshot,
  page,
  pointOfContact,
  connected,
  lastSyncedLabel,
  onNavigate,
  onConnection,
}: {
  snapshot: BoardSnapshot | null;
  page: BoardPage;
  pointOfContact: BoardAgent | null;
  connected: boolean;
  lastSyncedLabel: string;
  onNavigate: (page: BoardPage) => void;
  onConnection: () => void;
}) {
  const attentionCount = snapshot?.tasks.filter(taskNeedsHumanAction).length ?? 0;
  const navRow = 'group relative flex min-h-10 w-full items-center gap-2.5 rounded-[9px] px-3 text-left text-[13px] font-semibold transition-colors';
  const activeRow = 'bg-teal-soft text-teal-700 before:absolute before:bottom-2 before:left-0 before:top-2 before:w-0.5 before:rounded-full before:bg-teal-700';

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="border-b border-line px-4 py-4">
        <div className="flex items-center gap-3">
          <img src="/cicada-mark.svg" alt="" className="size-9 shrink-0 rounded-[10px] bg-teal-500 p-1.5" />
          <div className="min-w-0">
            <p className="truncate font-display text-[15px] font-bold tracking-[-0.02em] text-ink">Cicada</p>
            <p className="text-[11px] font-medium text-muted">Steward</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <nav aria-label="Company navigation" className="space-y-1">
          <button type="button" className={cn(navRow, pageIs(page, 'tasks') ? activeRow : 'text-[#46515b] hover:bg-line-soft')} onClick={() => onNavigate({ kind: 'tasks' })}>
            <ListTodo size={17} />
            <span className="min-w-0 flex-1">Task List</span>
            {attentionCount > 0 ? <Pill tone="amber" className="min-h-5 px-1.5">{attentionCount}</Pill> : null}
          </button>
          <button type="button" className={cn(navRow, pageIs(page, 'documents') ? activeRow : 'text-[#46515b] hover:bg-line-soft')} onClick={() => onNavigate({ kind: 'documents' })}>
            <FileText size={17} />
            <span>Documents</span>
          </button>
        </nav>

        <div className="mt-5">
          <p className="px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Point of contact</p>
          {pointOfContact ? (
            <button
              type="button"
              className={cn(
                'relative mt-2 flex min-h-14 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left transition-colors',
                pageIs(page, 'agent', pointOfContact.id) ? activeRow : 'hover:bg-line-soft',
              )}
              onClick={() => onNavigate({ kind: 'agent', agentId: pointOfContact.id })}
            >
              <span className="relative"><Avatar name={pointOfContact.name} size="sm" color="#d5eeeb" /><span className="absolute -bottom-0.5 -right-0.5"><AgentStatusMark agent={pointOfContact} /></span></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-bold text-ink">{pointOfContact.name}</span>
                <span className="mt-0.5 block truncate text-[10px] text-muted">{isExplicitPointOfContact(pointOfContact) ? 'Ask or route anything' : 'Acting POC · ask or route work'}</span>
              </span>
              <MessageSquareText size={15} className="shrink-0 text-teal-700" />
            </button>
          ) : (
            <div className="mt-2 rounded-[10px] border border-dashed border-line px-3 py-3 text-[11px] leading-4 text-muted">Add an agent to establish the company POC.</div>
          )}
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between px-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Projects</p>
            <span className="font-mono text-[10px] text-muted">{snapshot?.projects.length ?? 0}</span>
          </div>
          <nav aria-label="Projects and agents" className="mt-2 space-y-2">
            {snapshot?.projects.map((project) => {
              const agents = snapshot.agents.filter((agent) => agent.projectId === project.id);
              return (
                <div key={project.id}>
                  <button
                    type="button"
                    className={cn(navRow, pageIs(page, 'project', project.id) ? activeRow : 'text-[#39434d] hover:bg-line-soft')}
                    onClick={() => onNavigate({ kind: 'project', projectId: project.id })}
                  >
                    <FolderKanban size={16} />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    <ChevronRight size={14} className="text-muted" />
                  </button>
                  {agents.length > 0 ? (
                    <div className="ml-[19px] mt-0.5 border-l border-line pl-2">
                      {agents.map((agent) => (
                        <button
                          key={agent.id}
                          type="button"
                          className={cn(
                            'relative flex min-h-10 w-full items-center gap-2 rounded-[8px] px-2 text-left text-xs transition-colors',
                            pageIs(page, 'agent', agent.id) ? activeRow : 'text-muted hover:bg-line-soft hover:text-ink',
                          )}
                          onClick={() => onNavigate({ kind: 'agent', agentId: agent.id })}
                        >
                          <AgentStatusMark agent={agent} />
                          <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                          {pointOfContact?.id === agent.id ? <span className="rounded bg-teal-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-teal-700">POC</span> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </nav>
        </div>
      </div>

      <div className="border-t border-line p-3">
        <button type="button" onClick={onConnection} className="flex min-h-11 w-full items-center gap-2.5 rounded-[9px] px-3 text-left text-xs text-muted hover:bg-line-soft hover:text-ink">
          <Settings2 size={16} />
          <span className="min-w-0 flex-1"><span className="block font-semibold">Board connection</span><span className="mt-0.5 block truncate text-[10px]">{connected ? lastSyncedLabel : `Disconnected · ${lastSyncedLabel}`}</span></span>
          {connected ? <span className="size-2 rounded-full bg-teal-500"><span className="sr-only">connected</span></span> : <CircleAlert size={14} className="text-urgent" aria-label="disconnected" />}
        </button>
      </div>
    </div>
  );
}

export function WorkspaceFrame({
  snapshot,
  page,
  pointOfContact,
  connected,
  lastSyncedLabel,
  drawerOpen,
  onDrawerChange,
  onNavigate,
  onConnection,
  children,
}: {
  snapshot: BoardSnapshot | null;
  page: BoardPage;
  pointOfContact: BoardAgent | null;
  connected: boolean;
  lastSyncedLabel: string;
  drawerOpen: boolean;
  onDrawerChange: (open: boolean) => void;
  onNavigate: (page: BoardPage) => void;
  onConnection: () => void;
  children: ReactNode;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => drawerRef.current?.focus(), 0);
    const desktop = window.matchMedia('(min-width: 1024px)');
    const onBreakpointChange = (event: MediaQueryListEvent) => {
      if (event.matches) onDrawerChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDrawerChange(false);
        window.setTimeout(() => openerRef.current?.focus(), 0);
        return;
      }
      if (event.key === 'Tab' && drawerRef.current) {
        const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) {
          event.preventDefault();
        } else if (event.shiftKey && (document.activeElement === first || document.activeElement === drawerRef.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === drawerRef.current)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    desktop.addEventListener('change', onBreakpointChange);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      desktop.removeEventListener('change', onBreakpointChange);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [drawerOpen, onDrawerChange]);

  const closeDrawer = () => {
    onDrawerChange(false);
    window.setTimeout(() => openerRef.current?.focus(), 0);
  };

  const navigate = (next: BoardPage) => {
    onNavigate(next);
    closeDrawer();
  };

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-line bg-white px-4 lg:hidden">
        <div className="flex items-center gap-2.5"><img src="/cicada-mark.svg" alt="" className="size-8 rounded-[9px] bg-teal-500 p-1.5" /><div><p className="text-sm font-bold leading-none">Cicada</p><p className="mt-1 text-[10px] leading-none text-muted">Steward</p></div></div>
        <button ref={openerRef} type="button" className="flex size-10 items-center justify-center rounded-[9px] text-muted hover:bg-line-soft hover:text-ink" aria-label="Open navigation" aria-expanded={drawerOpen} onClick={() => onDrawerChange(true)}><Menu size={20} /></button>
      </header>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line lg:block">
        <RailContent snapshot={snapshot} page={page} pointOfContact={pointOfContact} connected={connected} lastSyncedLabel={lastSyncedLabel} onNavigate={onNavigate} onConnection={onConnection} />
      </aside>

      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" className="absolute inset-0 bg-ink/45" aria-label="Close navigation" onClick={closeDrawer} />
          <aside ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Company navigation" className="absolute inset-y-0 left-0 w-[min(88vw,320px)] border-r border-line bg-white shadow-[12px_0_40px_rgba(23,28,36,.18)]">
            <button type="button" className="absolute right-3 top-3 z-10 flex size-10 items-center justify-center rounded-[9px] text-muted hover:bg-line-soft hover:text-ink" aria-label="Close navigation" onClick={closeDrawer}><X size={19} /></button>
            <RailContent snapshot={snapshot} page={page} pointOfContact={pointOfContact} connected={connected} lastSyncedLabel={lastSyncedLabel} onNavigate={navigate} onConnection={() => { onDrawerChange(false); onConnection(); }} />
          </aside>
        </div>
      ) : null}

      <div className="lg:pl-64">{children}</div>
    </div>
  );
}
