# Campaign 9.6: Board UX polish — no native dialogs, anchored surfaces

**Status:** Shipped 2026-08-28 (amended after the final review to the as-built behavior — see the *Amendments* section)
**Author:** Claude (owner's request 2026-08-26; seam facts from the 2026-08-27 exploration)
**Date:** 2026-08-27
**Scope:** roadmap campaign 9.6. Web only (`src/web`, Playwright). No contract or server change.

## Summary

Two owner complaints: the board's pause control collects its reason through the browser's native
`prompt()` (the only native dialog in the app), and "Add a task" opens a full-screen takeover modal
that feels like leaving the task board. This campaign adds one **anchored, non-modal popover
primitive**, uses it for the pause reason, and gives the existing `Modal` an **anchored variant**
(no scrim, positioned at its trigger, page still scrollable) that Add-a-task and the four pure
yes/no confirms adopt on desktop while keeping the bottom-sheet behaviour on phones. Every
accessible name Playwright pins is preserved; the dirty-draft guard is untouched.

Exit (roadmap): zero `globalThis.prompt/confirm/alert`; creating a task keeps the board visibly
present; Playwright green on both projects.

## Part A — Popover primitive + pause reason

`src/web/components/popover.tsx` — `Popover({ open, onClose, anchorRef, label, children, className })`:
in-tree (no portal), rendered right after its trigger inside a `relative` wrapper; `role="dialog"`
with `aria-label={label}` but **not** `aria-modal`; `absolute` below the anchor (right-aligned when
it would overflow), `w-[min(22rem,calc(100vw-2rem))]`, `bg-surface border border-line rounded-md
shadow-[0_24px_64px_var(--elevation-shadow-color)] p-3`; initial focus to `[data-popover-initial-focus]`;
Escape (listener on the popover element, not `window` — so the mobile drawer's and Modal's
handling are untouched) and outside `mousedown` (document, ignoring anchor + popover) call
`onClose`; focus returns to the anchor on close; **no** `body.overflow` lock; does not join the
Modal layer stack.

Pause flow (`BoardApp.tsx`, `WorkspaceSidebar.tsx`): `onPauseBoard` opens `PauseReasonPopover`
anchored to the `Pause board` button — textarea labelled `Reason` (optional, `maxLength` 500,
placeholder "Why are you pausing the board?"), buttons **`Confirm pause`** (primary) and `Cancel`;
`onResumeBoard` calls resume directly (no popover). `changeBoardPause(client, boardPause, reason:
string | null)` takes the value (cancel = popover closed, no call; empty/whitespace → `reason: null`
exactly as today). `pauseBusy` is set only on confirm, so the anchor stays enabled while the popover
is open. `pauseControlError` renders inside the popover (`role="alert"`) and the popover stays
open on failure so the typed reason survives a 409. The trigger keeps its names `Pause board` /
`Resume board`; the banner text `Board paused` + reason is unchanged.

## Part B — Anchored Modal variant + Add-a-task

`Modal` gains `variant?: 'takeover' | 'anchored'` (default takeover) and `anchorRef?`. Anchored on
`sm+`: no scrim, `absolute` panel positioned below/right-aligned to the anchor, `w-[min(28rem,…)]`,
`max-h-[min(80dvh,…)]` with internal scroll, same border/shadow; **still** a `role="dialog"` named
by its title, still uses `useDialogLayer` (Tab trap inside the panel, Escape → `requestClose`, dirty
guard → nested `Discard draft?`, focus restore) — but the layer no longer sets `body.overflow` for
anchored variants and the scrim's backdrop-close is replaced by outside-`mousedown` → `requestClose`.
Below `sm` the variant is ignored: the existing bottom sheet renders (phones keep working; the
mobile Playwright project is unchanged by construction).

Add-a-task uses `variant="anchored"` anchored to whichever trigger opened it (header `Add task`
icon button, empty-state button, project page's button — `openDialog('task', …)` gains the anchor
ref). The project picker (`Add project from disk`) stays a takeover: it hosts a file browser and is
rare. Playwright: all role names (`dialog "Add a task"`, `Task`, `Task type`, `Priority`, `Project`,
`Submit task`, `Choose a project`, `Close dialog`, `Discard draft?`) unchanged; the two bare
`page.getByRole('dialog')` uses get the explicit name; a positive assertion is added — while
Add-a-task is open on desktop the header's "Task list actions" group is still visible and the page
has no scrim element.

## Part C — Pure confirms adopt the anchored variant

`Interrupt N agents?`, `Rotate agent token?`, `Approve and merge pipeline`, `Archive work item` (the
four dirty-free yes/no modals) switch to `variant="anchored"` at their buttons; names unchanged.
Form-bearing detail modals (`Cancel work item`, `Reject proposed plan`, `Request implementation
changes`, the agent-type editor) stay takeovers this campaign (audit note in the roadmap).

## Testing

Vitest is SSR-only: unit tests cover `changeBoardPause(reason)` (cancel vs empty vs text), the
popover's markup (role/name/no aria-modal), the anchored Modal markup (no scrim element), and the
existing markup pins. Behaviour (open/close/Escape/outside-click/dirty flow/focus) is proven in
Playwright: the pause test drives the popover (`Reason` textbox + `Confirm pause`) instead of
`page.once('dialog')`; add-task tests keep their sequences; a new test pins Escape-closes +
focus-returns-to-trigger for the pause popover and outside-click-with-dirty-draft → `Discard draft?`
for the anchored Add-a-task. Both Playwright projects must pass at close.

## Alternatives considered

- Portal-based floating library (popper/floating-ui) — rejected: no deps rule; in-tree absolute
  positioning suffices for a 22–28rem panel anchored to a fixed rail/header.
- Replace Add-a-task with a fully inline form in the task list — rejected: three entry points (header,
  empty state, project page) need the same form; an anchored panel keeps one component.
- Keep the takeover on desktop but shrink it — rejected: the complaint is the takeover itself.
- Convert every modal — deferred: form-bearing detail dialogs carry the dirty protocol and belong to
  a detail-pane redesign, not this polish pass.

## Amendments (as built, 2026-08-28)

- **One placement helper for both surfaces** — `resolveModalAnchorPlacement` (exported from `components/ui.tsx`) picks the side of the anchor with more space, caps the panel's max-height to that side's available space (no `80dvh` clamp), and returns a **takeover fallback** when the roomier side offers less than 12rem. The Popover reuses it (so it flips above/below like the Modal) and scrolls its body. A null or detached anchor renders the takeover layout.
- **Anchored dialogs are genuinely non-modal** — no scrim, no scroll lock, no `aria-modal`, and **no Tab trap**; Escape, initial focus, focus restore, outside-mousedown close and the dirty-draft guard remain. The takeover variant is unchanged.
- **Stable element tree** across the `sm` breakpoint so a draft survives a resize/rotation while open; the anchored header is static (flex column with an internal body scroller) so it can never overlay controls.
- **Dirty-guard routing** — re-clicking the open dialog's own trigger never resets the dirty state; clicking a *different* trigger while a dirty dialog is open first asks `Discard draft?` (pending open resolved after the decision); route navigation closes an open anchored dialog through the same path.
- **Pause popover** closes when the `lg` breakpoint is crossed in either direction and restores focus to its anchor only if it held focus.
- **Residue kept as takeovers** (documented on the roadmap): `Cancel work item`, `Reject proposed plan`, `Request implementation changes`, the agent-type editor, and the project picker.

