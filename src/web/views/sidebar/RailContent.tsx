/** Renders the navigation rail: projects, agents, and the board's pause state. */

/* —— Imports —— */

import { ChevronDown, CircleAlert, CirclePause, CirclePlay, CircleX, Plus } from "lucide-react";
import { useId, useRef, useState, type RefObject } from "react";
import { Popover } from "../../components/popover";
import { Button, cn } from "../../components/ui";
import type { BoardAgent, BoardSnapshot } from "../../types";
import type { RawBoardPause } from "../../data/parse";
import { agentWorkLabel, taskNeedsHumanAction } from "../../model/workspace-model";
import type { BoardPage } from "../../routing/routing";

/* —— Navigation rail —— */

function pageIs(page: BoardPage, kind: BoardPage["kind"], id?: string): boolean {
  if (kind === "tasks" && page.kind === "intake") return true;
  if (page.kind !== kind) return false;
  if (page.kind === "project") return page.projectId === id;
  if (page.kind === "agent") return page.agentId === id;
  if (page.kind === "intake") return page.workItemId === id;
  return true;
}

function AgentStatusMark({ agent }: { agent: BoardAgent }) {
  const active = agent.status === "running" || agent.status === "queued";
  const waiting = agent.status === "waiting_for_human" || agent.status === "interrupting";
  const label = `Work: ${agentWorkLabel(agent.status)}`;
  if (agent.status === "failed") return <CircleX size={12} className="shrink-0 text-urgent" aria-label={label} />;
  if (waiting) return <CircleAlert size={12} className="shrink-0 text-caution" aria-label={label} />;
  return (
    <span className={cn("size-1.5 shrink-0 rounded-[99px]", active ? "bg-success-fill" : "bg-taupe")} title={label}>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function PauseReasonPopover({
  open,
  anchorRef,
  reason,
  busy,
  disabled,
  error,
  onReasonChange,
  onConfirm,
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  reason: string;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onReasonChange: (reason: string) => void;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const reasonId = useId();
  const errorId = useId();
  const close = () => {
    onReasonChange("");
    onClose();
  };
  const preserveRecovery = busy || error !== null;

  return (
    <Popover open={open} onClose={preserveRecovery ? () => undefined : close} anchorRef={anchorRef} label="Pause board">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          onConfirm(reason.slice(0, 500));
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={reasonId} className="text-xs font-medium text-ink">
            Reason
          </label>
          <span className="text-[10px] text-muted" aria-hidden="true">
            Optional
          </span>
        </div>
        <textarea
          id={reasonId}
          value={reason}
          maxLength={500}
          rows={4}
          placeholder="Why are you pausing the board?"
          disabled={busy || disabled}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? undefined : errorId}
          data-popover-initial-focus
          onChange={(event) => onReasonChange(event.currentTarget.value.slice(0, 500))}
          className="mt-1.5 w-full resize-y rounded-sm border border-line bg-canvas px-3 py-2 text-sm leading-5 text-ink outline-none transition-colors placeholder:text-muted focus:border-taupe-hover disabled:cursor-not-allowed disabled:opacity-55"
        />
        {error === null ? null : (
          <p id={errorId} className="mt-2 text-[11px] leading-4 text-urgent" role="alert">
            {error}
          </p>
        )}
        <div className="mt-3 grid gap-2 lg:grid-cols-2">
          <Button type="submit" variant="primary" size="sm" disabled={busy || disabled}>
            {busy ? "Pausing…" : "Confirm pause"}
          </Button>
          <Button size="sm" disabled={busy} onClick={close}>
            Cancel
          </Button>
        </div>
      </form>
    </Popover>
  );
}

export function RailContent({
  snapshot,
  page,
  pointOfContact,
  onNavigate,
  onAddProject,
  canAddProject,
  unreadNotifications,
  boardPause,
  pausePopoverOpen,
  pauseReason,
  pauseBusy,
  pauseControlDisabled,
  pauseControlError,
  onPauseBoard,
  onPauseReasonChange,
  onConfirmPause,
  onCancelPause,
  onResumeBoard,
}: {
  snapshot: BoardSnapshot | null;
  page: BoardPage;
  pointOfContact: BoardAgent | null;
  onNavigate: (page: BoardPage, event: Event) => void;
  onAddProject: (event: Event) => void;
  canAddProject: boolean;
  unreadNotifications: number;
  boardPause: RawBoardPause | null;
  pausePopoverOpen: boolean;
  pauseReason: string;
  pauseBusy: boolean;
  pauseControlDisabled: boolean;
  pauseControlError: string | null;
  onPauseBoard: () => void;
  onPauseReasonChange: (reason: string) => void;
  onConfirmPause: (reason: string) => void;
  onCancelPause: () => void;
  onResumeBoard: () => void;
}) {
  const attentionCount = snapshot?.tasks.filter(taskNeedsHumanAction).length ?? 0;
  const parkedCount = snapshot?.workItems.filter((workItem) => workItem.state === "parked").length ?? 0;
  const finalApprovalCount = snapshot?.workItems.filter((workItem) => workItem.state === "final_approval").length ?? 0;
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const pauseAnchorRef = useRef<HTMLButtonElement>(null);
  const navRow =
    "group flex min-h-11 w-full items-center border-l-2 border-transparent px-3 text-left text-[12px] font-medium transition-[background-color,border-color,color] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover lg:min-h-9";
  const activeRow = "border-l-taupe bg-surface text-ink";
  const inactiveRow = "text-ink hover:bg-surface";
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
        <span
          className="grid size-6 place-items-center rounded-sm bg-taupe text-[10px] font-bold text-white"
          aria-hidden="true"
        >
          C
        </span>
        <p className="whitespace-nowrap text-[11px] font-medium text-ink">Cicada Tech Systems LLC.</p>
      </div>

      <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto px-3 py-4">
        <nav aria-label="Company navigation" className="space-y-1">
          <button
            type="button"
            aria-current={pageIs(page, "tasks") ? "page" : undefined}
            className={cn(navRow, pageIs(page, "tasks") ? activeRow : inactiveRow)}
            onClick={(event) => onNavigate({ kind: "tasks" }, event.nativeEvent)}
          >
            <span className="min-w-0 flex-1">Requests</span>
            <span className="ml-2 flex shrink-0 flex-wrap justify-end gap-1">
              {parkedCount > 0 ? (
                <span
                  className={cn(
                    "inline-flex items-center justify-center rounded-[99px] border border-line px-1.5 py-0.5 font-mono text-[9px] leading-4",
                    pageIs(page, "tasks") ? "bg-taupe text-white" : "bg-canvas text-muted"
                  )}
                >
                  {parkedCount} parked
                </span>
              ) : null}
              {finalApprovalCount > 0 ? (
                <span
                  aria-label={`${finalApprovalCount} ${finalApprovalCount === 1 ? "request awaits" : "requests await"} final approval`}
                  className={cn(
                    "inline-flex items-center justify-center rounded-[99px] border border-line px-1.5 py-0.5 font-mono text-[9px] leading-4",
                    pageIs(page, "tasks") ? "bg-taupe text-white" : "bg-canvas text-muted"
                  )}
                >
                  {finalApprovalCount} final
                </span>
              ) : null}
              {unreadNotifications > 0 ? (
                <span
                  aria-label={`${unreadNotifications} unread ${unreadNotifications === 1 ? "notification" : "notifications"}`}
                  className={cn(
                    "inline-flex min-w-5 items-center justify-center rounded-[99px] border border-caution/30 px-1.5 py-0.5 font-mono text-[9px] leading-4",
                    pageIs(page, "tasks") ? "bg-caution-soft text-caution" : "bg-canvas text-caution"
                  )}
                >
                  {unreadNotifications}
                </span>
              ) : null}
              {attentionCount > 0 ? (
                <span
                  aria-label={`${attentionCount} board ${attentionCount === 1 ? "task needs" : "tasks need"} human action`}
                  className={cn(
                    "inline-flex min-w-5 items-center justify-center rounded-[99px] border border-line px-1.5 py-0.5 font-mono text-[9px] leading-4",
                    pageIs(page, "tasks") ? "bg-taupe text-white" : "bg-canvas text-muted"
                  )}
                >
                  {attentionCount}
                </span>
              ) : null}
            </span>
          </button>
          <button
            type="button"
            aria-current={pageIs(page, "automation") ? "page" : undefined}
            className={cn(navRow, pageIs(page, "automation") ? activeRow : inactiveRow)}
            onClick={(event) => onNavigate({ kind: "automation" }, event.nativeEvent)}
          >
            <span>Automation</span>
          </button>
          <button
            type="button"
            aria-current={pageIs(page, "ledgers") ? "page" : undefined}
            className={cn(navRow, pageIs(page, "ledgers") ? activeRow : inactiveRow)}
            onClick={(event) => onNavigate({ kind: "ledgers" }, event.nativeEvent)}
          >
            <span>Ledgers</span>
          </button>
          {pointOfContact ? (
            <button
              type="button"
              aria-current={pageIs(page, "agent", pointOfContact.id) ? "page" : undefined}
              className={cn(navRow, pageIs(page, "agent", pointOfContact.id) ? activeRow : inactiveRow)}
              onClick={(event) => onNavigate({ kind: "agent", agentId: pointOfContact.id }, event.nativeEvent)}
            >
              <span className="min-w-0 flex-1 truncate">{pointOfContact.name}</span>
              <span
                className={cn(
                  "ml-2 rounded-md border border-line px-1.5 py-0.5 text-[10px] font-medium",
                  pageIs(page, "agent", pointOfContact.id) ? "bg-taupe text-white" : "bg-canvas text-muted"
                )}
              >
                Agent
              </span>
              <span className="ml-2">
                <AgentStatusMark agent={pointOfContact} />
              </span>
            </button>
          ) : null}
        </nav>

        <section className="mt-6" aria-labelledby="sidebar-projects-heading">
          <h2 id="sidebar-projects-heading" className="px-3 text-[11px] font-semibold text-ink">
            Projects
          </h2>
          <nav aria-label="Projects and agents" className="mt-2 space-y-1">
            {snapshot?.projects.map((project) => {
              const agents = snapshot.agents.filter(
                (agent) => agent.projectId === project.id && agent.id !== pointOfContact?.id
              );
              const collapsed = collapsedProjects.has(project.id);
              return (
                <div key={project.id}>
                  <div
                    className={cn(
                      "flex items-center border-l-2 border-transparent transition-colors duration-150",
                      pageIs(page, "project", project.id) ? activeRow : inactiveRow
                    )}
                  >
                    <button
                      type="button"
                      aria-current={pageIs(page, "project", project.id) ? "page" : undefined}
                      className="min-h-11 min-w-0 flex-1 truncate py-2 pl-3 pr-2 text-left text-[12px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover lg:min-h-9"
                      onClick={(event) => onNavigate({ kind: "project", projectId: project.id }, event.nativeEvent)}
                    >
                      {project.name}
                    </button>
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      aria-label={`${collapsed ? "Expand" : "Collapse"} ${project.name} agents`}
                      className="mr-1 flex size-9 shrink-0 items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover"
                      onClick={() => toggleProject(project.id)}
                    >
                      <ChevronDown
                        aria-hidden="true"
                        size={15}
                        strokeWidth={1.5}
                        className={cn("transition-transform duration-150", collapsed && "-rotate-90")}
                      />
                    </button>
                  </div>
                  {agents.length > 0 && !collapsed ? (
                    <div className="mt-0.5 space-y-0.5">
                      {agents.map((agent) => (
                        <button
                          key={agent.id}
                          type="button"
                          aria-current={pageIs(page, "agent", agent.id) ? "page" : undefined}
                          className={cn(
                            "flex min-h-9 w-full items-center gap-2 border-l-2 border-transparent py-1 pl-6 pr-3 text-left text-[11px] leading-4 transition-[background-color,border-color,color] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover lg:min-h-7",
                            pageIs(page, "agent", agent.id) ? activeRow : "text-muted hover:bg-surface hover:text-ink"
                          )}
                          onClick={(event) => onNavigate({ kind: "agent", agentId: agent.id }, event.nativeEvent)}
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
            {snapshot && snapshot.projects.length === 0 ? (
              <div className="px-3 py-2">
                <p className="px-1 text-[12px] text-muted">No projects yet</p>
                <button
                  type="button"
                  className="mt-2 flex min-h-10 w-full items-center justify-center gap-2 rounded-md border border-line bg-canvas px-3 text-[12px] font-medium text-ink transition-colors hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover disabled:cursor-not-allowed disabled:opacity-45"
                  disabled={!canAddProject}
                  onClick={(event) => onAddProject(event.nativeEvent)}
                >
                  <Plus size={14} aria-hidden="true" />
                  Add project
                </button>
              </div>
            ) : null}
          </nav>
        </section>
      </div>

      {boardPause === null ? null : (
        <section aria-label="Board controls" className="border-t border-line p-3">
          <div className="flex items-center justify-between gap-3 px-3 pb-2">
            <p className="text-[11px] font-semibold text-ink">Orchestration</p>
            {boardPause?.paused ? (
              <span className="rounded-[99px] border border-caution/30 bg-caution-soft px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-caution">
                Paused
              </span>
            ) : null}
          </div>
          <div className="relative">
            <button
              ref={pauseAnchorRef}
              type="button"
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-line bg-canvas px-3 text-[12px] font-medium text-ink transition-colors hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover disabled:cursor-not-allowed disabled:opacity-45 lg:min-h-9"
              disabled={pauseBusy || pauseControlDisabled}
              aria-expanded={boardPause.paused ? undefined : pausePopoverOpen}
              aria-haspopup={boardPause.paused ? undefined : "dialog"}
              onClick={boardPause.paused ? onResumeBoard : onPauseBoard}
            >
              {boardPause.paused ? (
                <CirclePlay size={14} aria-hidden="true" />
              ) : (
                <CirclePause size={14} aria-hidden="true" />
              )}
              {pauseBusy
                ? boardPause.paused
                  ? "Resuming…"
                  : "Pausing…"
                : boardPause.paused
                  ? "Resume board"
                  : "Pause board"}
            </button>
            {boardPause.paused ? null : (
              <PauseReasonPopover
                open={pausePopoverOpen}
                anchorRef={pauseAnchorRef}
                reason={pauseReason}
                busy={pauseBusy}
                disabled={pauseControlDisabled}
                error={pauseControlError}
                onReasonChange={onPauseReasonChange}
                onConfirm={onConfirmPause}
                onClose={onCancelPause}
              />
            )}
          </div>
          {!boardPause.paused || pauseControlError === null ? null : (
            <p className="px-3 pt-2 text-[11px] leading-4 text-urgent" role="alert">
              {pauseControlError}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
