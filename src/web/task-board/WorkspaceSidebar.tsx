import {
  ChevronDown,
  CircleAlert,
  CircleX,
  Menu,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../components/ui';
import type { BoardAgent, BoardSnapshot } from './types';
import { agentWorkLabel, taskNeedsHumanAction } from './workspace-model';

export type BoardPage =
  | { kind: 'tasks' }
  | { kind: 'automation' }
  | { kind: 'documents'; documentId?: string }
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
  const label = `Work: ${agentWorkLabel(agent.status)}`;
  if (agent.status === 'failed') return <CircleX size={12} className="shrink-0 text-urgent" aria-label={label} />;
  if (waiting) return <CircleAlert size={12} className="shrink-0 text-caution" aria-label={label} />;
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        active ? 'bg-success-fill' : 'bg-taupe',
      )}
      title={label}
    >
      <span className="sr-only">{label}</span>
    </span>
  );
}

function RailContent({
  snapshot,
  page,
  pointOfContact,
  onNavigate,
}: {
  snapshot: BoardSnapshot | null;
  page: BoardPage;
  pointOfContact: BoardAgent | null;
  onNavigate: (page: BoardPage) => void;
}) {
  const attentionCount = snapshot?.tasks.filter(taskNeedsHumanAction).length ?? 0;
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const navRow = 'group flex min-h-11 w-full items-center border-l-2 border-transparent px-3 text-left font-mono text-[11px] uppercase tracking-[0.06em] transition-[background-color,border-color,color] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover lg:min-h-9';
  const activeRow = 'border-l-taupe bg-surface text-ink';
  const inactiveRow = 'text-ink hover:bg-surface';
  const toggleProject = (projectId: string) => {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-ink">
      <div className="flex h-14 items-center gap-3 border-b border-line px-4 pr-14 lg:pr-4">
        <span className="grid size-6 place-items-center bg-taupe font-mono text-[10px] font-bold text-white" aria-hidden="true">C</span>
        <p className="whitespace-nowrap font-mono text-[10px] font-medium tracking-[0.08em] text-ink">Cicada Tech Systems LLC.</p>
      </div>

      <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto px-3 py-4">
        <nav aria-label="Company navigation" className="space-y-1">
          <button
            type="button"
            aria-current={pageIs(page, 'tasks') ? 'page' : undefined}
            className={cn(navRow, pageIs(page, 'tasks') ? activeRow : inactiveRow)}
            onClick={() => onNavigate({ kind: 'tasks' })}
          >
            <span className="min-w-0 flex-1">Task List</span>
            {attentionCount > 0 ? (
              <span className={cn(
                'ml-2 inline-flex min-w-5 items-center justify-center border border-line px-1.5 py-0.5 font-mono text-[9px] leading-4',
                pageIs(page, 'tasks') ? 'bg-taupe text-white' : 'bg-canvas text-muted',
              )}>{attentionCount}</span>
            ) : null}
          </button>
          <button
            type="button"
            aria-current={pageIs(page, 'automation') ? 'page' : undefined}
            className={cn(navRow, pageIs(page, 'automation') ? activeRow : inactiveRow)}
            onClick={() => onNavigate({ kind: 'automation' })}
          >
            <span>Automation</span>
          </button>
          <button
            type="button"
            aria-current={pageIs(page, 'documents') ? 'page' : undefined}
            className={cn(navRow, pageIs(page, 'documents') ? activeRow : inactiveRow)}
            onClick={() => onNavigate({ kind: 'documents' })}
          >
            <span>Documents</span>
          </button>
          {pointOfContact ? (
            <button
              type="button"
              aria-current={pageIs(page, 'agent', pointOfContact.id) ? 'page' : undefined}
              className={cn(navRow, pageIs(page, 'agent', pointOfContact.id) ? activeRow : inactiveRow)}
              onClick={() => onNavigate({ kind: 'agent', agentId: pointOfContact.id })}
            >
              <span className="min-w-0 flex-1 truncate">{pointOfContact.name}</span>
              <span className={cn(
                'ml-2 border border-line px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-[0.08em]',
                pageIs(page, 'agent', pointOfContact.id) ? 'bg-taupe text-white' : 'bg-canvas text-muted',
              )}>Agent</span>
              <span className="ml-2"><AgentStatusMark agent={pointOfContact} /></span>
            </button>
          ) : null}
        </nav>

        <section className="mt-6" aria-labelledby="sidebar-projects-heading">
          <h2 id="sidebar-projects-heading" className="px-3 font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-muted">Projects</h2>
          <nav aria-label="Projects and agents" className="mt-2 space-y-1">
            {snapshot?.projects.map((project) => {
              const agents = snapshot.agents.filter((agent) => agent.projectId === project.id && agent.id !== pointOfContact?.id);
              const collapsed = collapsedProjects.has(project.id);
              return (
                <div key={project.id}>
                  <div
                    className={cn(
                      'flex items-center border-l-2 border-transparent transition-colors duration-150',
                      pageIs(page, 'project', project.id) ? activeRow : inactiveRow,
                    )}
                  >
                    <button
                      type="button"
                      aria-current={pageIs(page, 'project', project.id) ? 'page' : undefined}
                      className="min-h-11 min-w-0 flex-1 truncate py-2 pl-3 pr-2 text-left text-[12px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover lg:min-h-9"
                      onClick={() => onNavigate({ kind: 'project', projectId: project.id })}
                    >
                      {project.name}
                    </button>
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${project.name} agents`}
                      className="mr-1 flex size-9 shrink-0 items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover"
                      onClick={() => toggleProject(project.id)}
                    >
                      <ChevronDown
                        aria-hidden="true"
                        size={15}
                        strokeWidth={1.5}
                        className={cn('transition-transform duration-150', collapsed && '-rotate-90')}
                      />
                    </button>
                  </div>
                  {agents.length > 0 && !collapsed ? (
                    <div className="mt-0.5 space-y-0.5">
                      {agents.map((agent) => (
                        <button
                          key={agent.id}
                          type="button"
                          aria-current={pageIs(page, 'agent', agent.id) ? 'page' : undefined}
                          className={cn(
                            'flex min-h-9 w-full items-center gap-2 border-l-2 border-transparent py-1 pl-6 pr-3 text-left font-mono text-[10px] leading-4 transition-[background-color,border-color,color] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover lg:min-h-7',
                            pageIs(page, 'agent', agent.id) ? activeRow : 'text-muted hover:bg-surface hover:text-ink',
                          )}
                          onClick={() => onNavigate({ kind: 'agent', agentId: agent.id })}
                        >
                          <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                          <AgentStatusMark agent={agent} />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {snapshot && snapshot.projects.length === 0 ? <p className="px-4 py-2 text-[12px] text-muted">No projects yet</p> : null}
          </nav>
        </section>
      </div>
    </div>
  );
}

export function WorkspaceFrame({
  snapshot,
  page,
  pointOfContact,
  drawerOpen,
  onDrawerChange,
  onNavigate,
  children,
}: {
  snapshot: BoardSnapshot | null;
  page: BoardPage;
  pointOfContact: BoardAgent | null;
  drawerOpen: boolean;
  onDrawerChange: (open: boolean) => void;
  onNavigate: (page: BoardPage) => void;
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
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-sidebar px-4 lg:hidden">
        <p className="min-w-0 truncate font-mono text-[10px] font-medium tracking-[0.08em]">Cicada Tech Systems LLC.</p>
        <button ref={openerRef} type="button" className="flex size-10 shrink-0 items-center justify-center border border-line bg-taupe text-white transition-colors hover:bg-taupe-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover" aria-label="Open navigation" aria-expanded={drawerOpen} onClick={() => onDrawerChange(true)}><Menu size={18} strokeWidth={1.5} /></button>
      </header>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line lg:block">
        <RailContent snapshot={snapshot} page={page} pointOfContact={pointOfContact} onNavigate={onNavigate} />
      </aside>

      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" className="cicada-scrim-enter absolute inset-0 bg-ink/35" aria-label="Close navigation" onClick={closeDrawer} />
          <aside ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Company navigation" className="cicada-drawer-enter absolute inset-y-0 left-0 w-[min(88vw,240px)] border-r border-line bg-sidebar shadow-[12px_0_40px_rgba(0,0,0,.4)]">
            <button type="button" className="absolute right-2 top-2 z-10 flex size-10 items-center justify-center text-muted transition-colors hover:bg-surface hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover" aria-label="Close navigation" onClick={closeDrawer}><X size={18} strokeWidth={1.5} /></button>
            <RailContent snapshot={snapshot} page={page} pointOfContact={pointOfContact} onNavigate={navigate} />
          </aside>
        </div>
      ) : null}

      <div className="lg:pl-60">{children}</div>
    </div>
  );
}
