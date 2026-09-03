/** Renders the board-wide pause banner and decides when its popover closes. */

/* —— Imports —— */

import { CirclePause } from "lucide-react";
import type { RawBoardPause } from "../data/parse";

/* —— Board pause —— */

export function BoardPauseBanner({ boardPause }: { boardPause: RawBoardPause | null }) {
  if (boardPause?.paused !== true) return null;
  return (
    <div
      className="border-b border-caution-border bg-caution-soft px-4 py-3 text-caution sm:px-8 lg:px-12"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5">
        <CirclePause className="mt-0.5 shrink-0" size={16} aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold">Board paused</p>
          <p className="mt-0.5 text-xs leading-5">{boardPause.reason ?? "No reason was provided."}</p>
        </div>
      </div>
    </div>
  );
}

export function pausePopoverShouldClose(boardPause: RawBoardPause | null): boolean {
  return boardPause === null || boardPause.paused;
}
