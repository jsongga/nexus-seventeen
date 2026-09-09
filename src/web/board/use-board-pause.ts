/** Owns the board-wide pause: its state, its popover, and the draft an operator is typing. */

/* —— Imports —— */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskBoardClient } from "../data/client";
import type { RawBoardPause } from "../data/parse";
import { pausePopoverShouldClose } from "./pause";

/* —— Pause request and version safety —— */

/** Keeps delayed reads from replacing a newer pause mutation response. */
export class BoardPauseVersionGuard {
  #latestVersion: number | null = null;

  accept(next: RawBoardPause): boolean {
    if (this.#latestVersion !== null && next.version < this.#latestVersion) return false;
    this.#latestVersion = next.version;
    return true;
  }
}

export async function changeBoardPause(
  client: TaskBoardClient,
  boardPause: RawBoardPause,
  reason: string | null
): Promise<RawBoardPause | null> {
  if (boardPause.paused) return client.resumeBoard({ version: boardPause.version });
  if (reason === null) return null;
  const trimmedReason = reason.slice(0, 500).trim();
  return client.setBoardPause({
    reason: trimmedReason.length === 0 ? null : trimmedReason,
    version: boardPause.version,
  });
}

/* —— Hook —— */

export interface BoardPauseState {
  readonly boardPause: RawBoardPause | null;
  /** Accepts a newer pause than the one held, so a delayed read cannot replace a fresh mutation. */
  readonly updateBoardPause: (next: RawBoardPause | null) => void;
  readonly pausePopoverOpen: boolean;
  readonly pauseBusy: boolean;
  readonly pauseControlError: string | null;
  readonly pauseReason: string;
  readonly setPauseReason: (reason: string) => void;
  readonly openPausePopover: () => void;
  readonly closePausePopover: () => void;
  readonly hidePausePopover: () => void;
  readonly confirmPause: (reason: string | null) => Promise<void>;
  readonly resumeBoard: () => Promise<void>;
}

/**
 * The draft lives here rather than in the sidebar that renders it: crossing the rail breakpoint
 * swaps which sidebar is mounted, and an operator must not lose what they typed to a layout
 * change (roadmap 9.12).
 */
export function useBoardPause(client: TaskBoardClient, connected: boolean): BoardPauseState {
  const [boardPause, setBoardPause] = useState<RawBoardPause | null>(null);
  const [pausePopoverOpen, setPausePopoverOpen] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseControlError, setPauseControlError] = useState<string | null>(null);
  const [pauseReason, setPauseReason] = useState("");
  const pauseVersions = useMemo(() => new BoardPauseVersionGuard(), []);

  const updateBoardPause = useCallback(
    (next: RawBoardPause | null) => {
      if (next === null) {
        setBoardPause(null);
        return;
      }
      if (pauseVersions.accept(next)) setBoardPause(next);
    },
    [pauseVersions]
  );

  useEffect(() => {
    if (pausePopoverShouldClose(boardPause)) setPausePopoverOpen(false);
  }, [boardPause]);

  function openPausePopover(): void {
    if (boardPause === null || boardPause.paused || pauseBusy) return;
    // Reopening after a conflict shows what happened; a blank form hides it.
    setPausePopoverOpen(true);
  }

  /** Closes the popover and discards the draft — the operator abandoned the attempt. */
  function closePausePopover(): void {
    setPausePopoverOpen(false);
    setPauseControlError(null);
    setPauseReason("");
  }

  /**
   * A layout change closes an idle popover, but never one holding an attempt: in flight, failed,
   * or carrying a typed reason. Losing a draft to a resize is not something the operator asked for.
   */
  function hidePausePopover(): void {
    if (pauseBusy || pauseControlError !== null || pauseReason.trim() !== "") return;
    setPausePopoverOpen(false);
  }

  async function confirmPause(reason: string | null): Promise<void> {
    if (!connected || boardPause === null || boardPause.paused || pauseBusy) return;
    setPauseBusy(true);
    setPauseControlError(null);
    try {
      const next = await changeBoardPause(client, boardPause, reason);
      if (next !== null) {
        updateBoardPause(next);
        setPausePopoverOpen(false);
        setPauseReason("");
      }
    } catch (caught) {
      setPauseControlError(caught instanceof Error ? caught.message : "The board pause state could not be changed.");
    } finally {
      setPauseBusy(false);
    }
  }

  async function resumeBoard(): Promise<void> {
    if (boardPause === null || !boardPause.paused || pauseBusy) return;
    setPauseBusy(true);
    setPauseControlError(null);
    try {
      const next = await changeBoardPause(client, boardPause, null);
      if (next !== null) updateBoardPause(next);
    } catch (caught) {
      setPauseControlError(caught instanceof Error ? caught.message : "The board pause state could not be changed.");
      try {
        updateBoardPause(await client.getBoardPause());
      } catch {
        // Keep the last authoritative state visible with the mutation error.
      }
    } finally {
      setPauseBusy(false);
    }
  }

  return {
    boardPause,
    updateBoardPause,
    pausePopoverOpen,
    pauseBusy,
    pauseControlError,
    pauseReason,
    setPauseReason,
    openPausePopover,
    closePausePopover,
    hidePausePopover,
    confirmPause,
    resumeBoard,
  };
}
