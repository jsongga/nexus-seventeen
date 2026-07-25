import { useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  BrainCircuit,
  CircleGauge,
  ClipboardCheck,
  FileClock,
  GitPullRequestArrow,
  LockKeyhole,
  Menu,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Users,
  X,
} from 'lucide-react';
import { Avatar, Button, cn, Pill } from './ui';
import { useDialogLayer } from './dialog-stack';

export type ViewKey =
  | 'overview'
  | 'missions'
  | 'runs'
  | 'approvals'
  | 'team'
  | 'routing'
  | 'audit';

interface NavItem {
  id: ViewKey;
  label: string;
  icon: typeof Activity;
  badge?: boolean;
}

const primaryNav: NavItem[] = [
  { id: 'overview', label: 'Attention', icon: CircleGauge, badge: true },
  { id: 'missions', label: 'Missions', icon: GitPullRequestArrow },
  { id: 'runs', label: 'Live runs', icon: Activity },
  { id: 'approvals', label: 'Approvals', icon: ClipboardCheck, badge: true },
];

const systemNav: NavItem[] = [
  { id: 'team', label: 'Role team', icon: Users },
  { id: 'routing', label: 'Model policy', icon: BrainCircuit },
  { id: 'audit', label: 'Audit trail', icon: FileClock },
];

const mobileNav: NavItem[] = [
  { id: 'overview', label: 'Home', icon: CircleGauge },
  { id: 'missions', label: 'Missions', icon: GitPullRequestArrow },
  { id: 'runs', label: 'Runs', icon: Activity },
  { id: 'approvals', label: 'Approvals', icon: ClipboardCheck, badge: true },
];

function CicadaMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <img
        src="/cicada-mark.svg"
        alt=""
        className={cn('shrink-0', compact ? 'size-8' : 'size-9')}
        aria-hidden="true"
      />
      <div>
        <div className="font-display text-[15px] font-semibold leading-none tracking-[-0.02em] text-ink">
          cicada
        </div>
        <div className="mt-1 text-[11px] font-medium leading-none text-muted">Nexus Seventeen</div>
      </div>
    </div>
  );
}

function NavButton({
  item,
  active,
  attentionCount,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  attentionCount: number;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex min-h-10 w-full items-center gap-3 rounded-[10px] px-3 text-left text-[13px] font-medium transition-colors',
        active
          ? 'bg-teal-soft text-teal-700 shadow-[inset_2px_0_0_var(--color-teal-500)]'
          : 'text-muted hover:bg-white hover:text-ink',
      )}
    >
      <Icon size={17} strokeWidth={active ? 2.3 : 1.9} />
      <span className="flex-1">{item.label}</span>
      {item.badge && attentionCount > 0 ? (
        <span
          className={cn(
            'grid min-w-5 place-items-center rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium',
            active ? 'bg-teal-500 text-ink' : 'bg-muted-surface text-muted',
          )}
        >
          {attentionCount}
        </span>
      ) : null}
    </button>
  );
}

export function AppShell({
  currentView,
  onNavigate,
  attentionCount,
  paused,
  onTogglePause,
  onNewMission,
  children,
}: {
  currentView: ViewKey;
  onNavigate: (view: ViewKey) => void;
  attentionCount: number;
  paused: boolean;
  onTogglePause: () => void;
  onNewMission: () => void;
  children: ReactNode;
}) {
  const [mobileSystemOpen, setMobileSystemOpen] = useState(false);
  const mobileSystemRef = useRef<HTMLElement>(null);
  const { isTopmost: isMobileSystemTopmost, layerId: mobileSystemLayerId } = useDialogLayer({
    open: mobileSystemOpen,
    onClose: () => setMobileSystemOpen(false),
    containerRef: mobileSystemRef,
  });

  function navigate(view: ViewKey) {
    setMobileSystemOpen(false);
    onNavigate(view);
  }

  return (
    <div className="min-h-dvh bg-canvas text-ink lg:grid lg:grid-cols-[242px_minmax(0,1fr)]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[242px] flex-col border-r border-line bg-canvas px-3 py-4 lg:flex">
        <div className="px-2">
          <CicadaMark />
        </div>

        <div
          className="mt-6 flex min-h-12 items-center gap-3 rounded-[10px] border border-line bg-white px-3 text-left shadow-[0_1px_2px_rgba(23,28,36,.04)]"
          aria-label="Northwind Labs software workspace"
        >
          <span className="grid size-8 place-items-center rounded-lg bg-teal-soft text-xs font-bold text-teal-700">
            NW
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold text-ink">Northwind Labs</span>
            <span className="mt-0.5 block text-[10px] font-medium text-muted">Software workspace</span>
          </span>
        </div>

        <nav className="mt-5" aria-label="Main navigation">
          <p className="mb-2 px-3 text-[11px] font-semibold text-muted">Work</p>
          <div className="space-y-1">
            {primaryNav.map((item) => (
              <NavButton
                key={item.id}
                item={item}
                active={currentView === item.id}
                attentionCount={attentionCount}
                onClick={() => navigate(item.id)}
              />
            ))}
          </div>

          <p className="mb-2 mt-6 px-3 text-[11px] font-semibold text-muted">System</p>
          <div className="space-y-1">
            {systemNav.map((item) => (
              <NavButton
                key={item.id}
                item={item}
                active={currentView === item.id}
                attentionCount={attentionCount}
                onClick={() => navigate(item.id)}
              />
            ))}
          </div>
        </nav>

        <div className="mt-auto space-y-3">
          <div className="rounded-[14px] border border-white/10 bg-ink-panel p-3.5 shadow-[0_8px_24px_rgba(23,28,36,.12)]">
            <div className="flex items-center gap-2 text-white">
              <span className="grid size-7 place-items-center rounded-lg bg-white/10 text-caution-fill">
                <LockKeyhole size={15} />
              </span>
              <span className="text-xs font-semibold">Production locked</span>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-white/58">
              Only your signed release approval can unlock a deployment.
            </p>
          </div>

          <div className="flex items-center gap-3 px-2 py-1">
            <Avatar name="Jordan Lee" color="#f0d9a8" size="sm" human />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-ink">Jordan Lee</p>
              <p className="mt-0.5 text-[10px] font-medium text-muted">Human owner</p>
            </div>
            <Menu size={16} className="text-muted" />
          </div>
        </div>
      </aside>

      <div className="min-w-0 lg:col-start-2">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-line bg-canvas/92 px-4 backdrop-blur-xl lg:hidden">
          <CicadaMark compact />
          <div className="flex items-center gap-2" aria-label="Northwind demo workspace">
            <span className="text-right">
              <span className="block text-xs font-semibold leading-none">Northwind</span>
              <span className="mt-1 block text-[10px] font-medium text-caution">Demo data</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            {currentView !== 'overview' ? (
              <button
                type="button"
                onClick={onNewMission}
                className="grid size-10 place-items-center rounded-[10px] border border-teal-500 bg-teal-500 text-ink"
                aria-label="Create a new mission"
              >
                <Plus size={18} strokeWidth={2.2} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onTogglePause}
              className={cn(
                'grid size-10 place-items-center rounded-[10px] border',
                paused
                  ? 'border-teal-border bg-teal-soft text-teal-700'
                  : 'border-line bg-white text-muted',
              )}
              aria-label={paused ? 'Resume all agents' : 'Pause all agents'}
            >
              {paused ? <Play size={17} /> : <Pause size={17} />}
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1440px] px-4 pb-28 pt-5 sm:px-6 lg:px-8 lg:pb-10 lg:pt-7 xl:px-10">
          <div className="mb-5 hidden items-center justify-end gap-2 lg:flex">
            <Pill tone="amber">Demo · browser-local</Pill>
            <Pill tone={paused ? 'amber' : 'green'} dot>
              {paused ? 'Agents paused' : 'Development live'}
            </Pill>
            <Button
              size="sm"
              variant="secondary"
              onClick={onTogglePause}
              icon={paused ? <Play size={14} /> : <Pause size={14} />}
            >
              {paused ? 'Resume all' : 'Pause all'}
            </Button>
            <Button size="sm" variant="primary" onClick={onNewMission} icon={<Plus size={14} />}>
              New mission
            </Button>
          </div>
          {children}
        </main>
      </div>

      {mobileSystemOpen ? (
        <div
          className="fixed inset-0 z-40 bg-scrim/35 lg:hidden"
          role="presentation"
          aria-hidden={isMobileSystemTopmost ? undefined : true}
          onMouseDown={(event) => {
            if (isMobileSystemTopmost && event.target === event.currentTarget) {
              setMobileSystemOpen(false);
            }
          }}
        >
          <section
            ref={mobileSystemRef}
            role="dialog"
            aria-modal={isMobileSystemTopmost ? 'true' : undefined}
            aria-labelledby={`${mobileSystemLayerId}-title`}
            tabIndex={-1}
            className="absolute inset-x-3 bottom-[82px] rounded-[14px] border border-line bg-white p-3 shadow-[0_20px_56px_rgba(23,28,36,.22)]"
          >
            <div className="mb-2 flex items-center justify-between px-2">
              <p id={`${mobileSystemLayerId}-title`} className="text-sm font-semibold">System</p>
              <button
                type="button"
                onClick={() => setMobileSystemOpen(false)}
                className="grid size-9 place-items-center rounded-[9px] text-muted hover:bg-line-soft hover:text-ink"
                aria-label="Close system navigation"
              >
                <X size={17} />
              </button>
            </div>
            <div className="grid gap-1 sm:grid-cols-3">
              {systemNav.map((item) => (
                <NavButton
                  key={item.id}
                  item={item}
                  active={currentView === item.id}
                  attentionCount={attentionCount}
                  onClick={() => navigate(item.id)}
                />
              ))}
            </div>
          </section>
        </div>
      ) : null}

      <nav
        className="fixed inset-x-0 z-30 flex h-[74px] border-t border-line bg-white/96 px-1 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_26px_rgba(23,28,36,.06)] backdrop-blur-xl lg:hidden"
        style={{ bottom: 'max(0px, calc(100% - 100dvh))' }}
        aria-label="Mobile navigation"
      >
        {mobileNav.map((item) => {
          const Icon = item.icon;
          const active = currentView === item.id;
          return (
            <button
              type="button"
              key={item.id}
              onClick={() => navigate(item.id)}
              className={cn(
                'relative flex min-h-12 min-w-11 flex-1 flex-col items-center justify-center gap-1 pt-1 text-[10px] font-medium',
                active ? 'text-teal-700' : 'text-muted',
              )}
            >
              <span className={cn('relative grid size-8 place-items-center rounded-[9px]', active && 'bg-teal-soft')}>
                <Icon size={18} strokeWidth={active ? 2.4 : 1.9} />
                {item.badge && attentionCount > 0 ? (
                  <span className="absolute -right-1 -top-1 grid size-[18px] place-items-center rounded-md border-2 border-white bg-urgent-fill font-mono text-[8px] font-medium text-white">
                    {attentionCount}
                  </span>
                ) : null}
              </span>
              {item.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setMobileSystemOpen((open) => !open)}
          className={cn(
            'relative flex min-h-12 min-w-11 flex-1 flex-col items-center justify-center gap-1 pt-1 text-[10px] font-medium',
            systemNav.some((item) => item.id === currentView) || mobileSystemOpen
              ? 'text-teal-700'
              : 'text-muted',
          )}
          aria-expanded={mobileSystemOpen}
        >
          <span
            className={cn(
              'grid size-8 place-items-center rounded-[9px]',
              (systemNav.some((item) => item.id === currentView) || mobileSystemOpen) &&
                'bg-teal-soft',
            )}
          >
            <MoreHorizontal size={19} />
          </span>
          More
        </button>
      </nav>

    </div>
  );
}
