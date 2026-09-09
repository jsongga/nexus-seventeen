/** Frames the workspace: the navigation rail beside the routed page. */

import { Menu, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import type { BoardAgent, BoardSnapshot } from "../types";
import type { RawBoardPause } from "../data/parse";
import type { BoardPage } from "../routing/routing";
import { RailContent } from "./sidebar/RailContent";

export function WorkspaceFrame({
  snapshot,
  page,
  pointOfContact,
  drawerOpen,
  onDrawerChange,
  onNavigate,
  onAddProject,
  canAddProject,
  unreadNotifications = 0,
  boardPause = null,
  pausePopoverOpen = false,
  pauseBusy = false,
  pauseControlDisabled = false,
  pauseControlError = null,
  onPauseBoard = () => undefined,
  onConfirmPause = () => undefined,
  onCancelPause = () => undefined,
  pauseReason = "",
  onPauseReasonChange = () => undefined,
  onHidePausePopover = () => undefined,
  onResumeBoard = () => undefined,
  children,
}: {
  snapshot: BoardSnapshot | null;
  page: BoardPage;
  pointOfContact: BoardAgent | null;
  drawerOpen: boolean;
  onDrawerChange: (open: boolean) => void;
  onNavigate: (page: BoardPage, event: Event) => void;
  onAddProject: (event: Event) => void;
  canAddProject: boolean;
  unreadNotifications?: number;
  boardPause?: RawBoardPause | null;
  pausePopoverOpen?: boolean;
  pauseBusy?: boolean;
  pauseControlDisabled?: boolean;
  pauseControlError?: string | null;
  onPauseBoard?: () => void;
  onConfirmPause?: (reason: string) => void;
  onCancelPause?: () => void;
  pauseReason?: string;
  onPauseReasonChange?: (reason: string) => void;
  /** Closes the popover without discarding the draft — a layout change is not a cancellation. */
  onHidePausePopover?: () => void;
  onResumeBoard?: () => void;
  children: ReactNode;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const pausePopoverOpenRef = useRef(pausePopoverOpen);
  const pauseBusyRef = useRef(pauseBusy);
  const onHidePausePopoverRef = useRef(onHidePausePopover);
  pausePopoverOpenRef.current = pausePopoverOpen;
  pauseBusyRef.current = pauseBusy;
  onHidePausePopoverRef.current = onHidePausePopover;

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onBreakpointChange = () => {
      // Crossing the breakpoint swaps the rail for the drawer, so the popover must close —
      // but the operator did not abandon it, so the draft and any error survive.
      if (pausePopoverOpenRef.current) onHidePausePopoverRef.current();
    };
    desktop.addEventListener("change", onBreakpointChange);
    return () => desktop.removeEventListener("change", onBreakpointChange);
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => drawerRef.current?.focus(), 0);
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onBreakpointChange = (event: MediaQueryListEvent) => {
      if (event.matches) {
        onDrawerChange(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onDrawerChange(false);
        window.setTimeout(() => openerRef.current?.focus(), 0);
        return;
      }
      if (event.key === "Tab" && drawerRef.current) {
        const focusable = [
          ...drawerRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
          ),
        ];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) {
          event.preventDefault();
        } else if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === drawerRef.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === drawerRef.current)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    desktop.addEventListener("change", onBreakpointChange);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      desktop.removeEventListener("change", onBreakpointChange);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [drawerOpen, onDrawerChange]);

  const closeDrawer = (restoreFocus = true) => {
    if (pausePopoverOpen) onHidePausePopover();
    onDrawerChange(false);
    if (restoreFocus) window.setTimeout(() => openerRef.current?.focus(), 0);
  };

  const navigate = (next: BoardPage, event: Event) => {
    onNavigate(next, event);
    closeDrawer();
  };

  const addProjectFromDrawer = (event: Event) => {
    closeDrawer(false);
    onAddProject(event);
  };

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-sidebar px-4 lg:hidden">
        <p className="min-w-0 truncate text-[11px] font-medium">Cicada Tech Systems LLC.</p>
        <button
          ref={openerRef}
          type="button"
          className="flex size-10 shrink-0 items-center justify-center rounded-[99px] border border-line bg-taupe text-white transition-colors hover:bg-taupe-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover"
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          onClick={() => onDrawerChange(true)}
        >
          <Menu size={18} strokeWidth={1.5} />
        </button>
      </header>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line lg:block">
        <RailContent
          snapshot={snapshot}
          page={page}
          pointOfContact={pointOfContact}
          onNavigate={onNavigate}
          onAddProject={onAddProject}
          canAddProject={canAddProject}
          unreadNotifications={unreadNotifications}
          boardPause={boardPause}
          pausePopoverOpen={pausePopoverOpen && !drawerOpen}
          pauseReason={pauseReason}
          pauseBusy={pauseBusy}
          pauseControlDisabled={pauseControlDisabled}
          pauseControlError={pauseControlError}
          onPauseBoard={onPauseBoard}
          onPauseReasonChange={onPauseReasonChange}
          onConfirmPause={onConfirmPause}
          onCancelPause={onCancelPause}
          onResumeBoard={onResumeBoard}
        />
      </aside>

      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="cicada-scrim-enter absolute inset-0 bg-ink/35"
            aria-label="Close navigation"
            onClick={() => closeDrawer()}
          />
          <aside
            ref={drawerRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Company navigation"
            className="cicada-drawer-enter absolute inset-y-0 left-0 w-[min(88vw,240px)] border-r border-line bg-sidebar shadow-[12px_0_40px_var(--elevation-shadow-color)]"
          >
            <button
              type="button"
              className="absolute right-2 top-2 z-10 flex size-10 items-center justify-center rounded-[99px] text-muted transition-colors hover:bg-surface hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover"
              aria-label="Close navigation"
              onClick={() => closeDrawer()}
            >
              <X size={18} strokeWidth={1.5} />
            </button>
            <RailContent
              snapshot={snapshot}
              page={page}
              pointOfContact={pointOfContact}
              onNavigate={navigate}
              onAddProject={addProjectFromDrawer}
              canAddProject={canAddProject}
              unreadNotifications={unreadNotifications}
              boardPause={boardPause}
              pausePopoverOpen={pausePopoverOpen}
              pauseReason={pauseReason}
              pauseBusy={pauseBusy}
              pauseControlDisabled={pauseControlDisabled}
              pauseControlError={pauseControlError}
              onPauseBoard={onPauseBoard}
              onPauseReasonChange={onPauseReasonChange}
              onConfirmPause={onConfirmPause}
              onCancelPause={onCancelPause}
              onResumeBoard={onResumeBoard}
            />
          </aside>
        </div>
      ) : null}

      <div className="lg:pl-60">{children}</div>
    </div>
  );
}
