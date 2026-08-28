# Board UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the app's only native dialog (pause reason `prompt`) and stop Add-a-task (and the four pure confirms) from taking over the page, via one anchored popover primitive and an anchored Modal variant — with every Playwright-pinned accessible name and the dirty-draft protocol preserved.

**Architecture:** `components/popover.tsx` (non-modal, in-tree, anchored) for the pause reason; `Modal` gains `variant="anchored"` + `anchorRef` (no scrim, no body lock, still a named `role="dialog"` on the dialog layer stack) used by Add-a-task and the four yes/no confirms on `sm+`; phones keep the bottom sheet.

**Tech Stack:** React 19 + Tailwind v4 (`src/web`), vitest (SSR markup only), Playwright (desktop + mobile projects). No deps.

**Spec:** `docs/superpowers/specs/2026-08-27-board-ux-polish-design.md`

## Global Constraints

- **Zero** `globalThis.prompt`, `confirm`, `alert` after Task 1 (grep-pinned by a vitest test over `src/web`).
- Accessible names Playwright pins are frozen: `Pause board`/`Resume board` (trigger), `Board paused`, dialog `Add a task` (+ `Add a task to <project>`), `Task`, `Task type`, `Priority`, `Project`, `Submit task`, `Choose a project`, `Close dialog`, `Discard draft?`, `Discard`, `Keep editing`, `Interrupt N agents?`, `Rotate agent token?`, `Approve and merge pipeline`, `Archive work item`. New names: `Reason` (pause textbox), `Confirm pause`, `Cancel`.
- Dirty-draft protocol unchanged (`useConfirmBeforeDiscard`, nested `Discard draft?`, Escape → Discard sequence with focus retained on the textarea after `Keep editing`).
- Anchored surfaces: no scrim, no `body.overflow` lock, Escape closes, outside-`mousedown` closes (via `requestClose` when a dirty guard exists), focus returns to the trigger; `sm+` only — below `sm` the existing bottom sheet renders.
- Design tokens: `bg-surface`, `border-line`, `rounded-md`, `shadow-[0_24px_64px_var(--elevation-shadow-color)]`; the global `:focus-visible` ring; reduced-motion respected (no new animations).
- Playwright cannot run in the implementer sandbox: implementers update specs statically + typecheck; the controller runs both projects after each task. Vitest (`npm run test:web`) + `npm run typecheck:all` per task.
- Implementers do not commit.

---

### Task 1: Popover primitive + pause reason (Spec Part A)
**Files:** create `src/web/components/popover.tsx` (+ `popover.test.ts` SSR markup: role, aria-label, no aria-modal, initial-focus attr); modify `src/web/task-board/BoardApp.tsx` (`changeBoardPause(client, boardPause, reason: string | null)`; split `toggleBoardPause` into `openPausePopover`/`confirmPause(reason)`/`resumeBoard`; `pauseBusy` only on confirm; `pauseControlError` piped into the popover), `src/web/task-board/views/WorkspaceSidebar.tsx` (`PauseReasonPopover` anchored to the `Pause board` button inside the Board controls section; textarea `Reason` maxLength 500 placeholder "Why are you pausing the board?"; `Confirm pause` + `Cancel`; error `role="alert"` inside), `src/web/task-board/BoardApp.test.ts` (changeBoardPause: null → no call; `'  '` → `reason: null`; text → trimmed text; resume path ignores reason), `src/web/task-board/views/WorkItemObservability.test.ts` (sidebar markup pins still hold), new `src/web/no-native-dialogs.test.ts` (greps `src/web/**/*.ts{,x}` for `globalThis.(prompt|confirm|alert)` / bare `prompt(` — must find zero); `tests/e2e/task-board.spec.ts` pause test (~166): replace `page.once('dialog', …)` with click `Pause board` → fill textbox `Reason` → click `Confirm pause`; add: Escape closes the popover and focus returns to `Pause board`; a 409 keeps the popover open with the alert and the typed reason.
**Steps:** SSR + unit tests first; implement; `npm run test:web && npm run typecheck:all`; controller runs Playwright.

### Task 2: Anchored Modal variant + Add-a-task (Spec Part B)
**Files:** modify `src/web/components/ui.tsx` (`Modal` `variant`/`anchorRef`; anchored layout on `sm+`; scrim omitted; outside-mousedown → `requestClose`; `data-testid="modal-scrim"` on the takeover scrim so tests can assert its absence), `src/web/components/dialog-stack.ts` (`useDialogLayer({ lockScroll })` — anchored layers don't lock `body.overflow`; Escape/Tab/focus-restore unchanged), `src/web/task-board/views/CreateDialogs.tsx` (task Modal → `variant="anchored"` with the opener's ref; project picker unchanged), `src/web/task-board/BoardApp.tsx` (`openDialog('task', { anchor })` from the header icon button, empty-state button, and `ProjectPage onAddTask` — `WorkspacePages.tsx` passes its button ref), tests: `CreateDialogs.test.ts` (markup pins + anchored variant renders no scrim testid), `dialog-stack.test.ts` (lockScroll option), Playwright: the two bare `page.getByRole('dialog')` become `{ name: 'Add a task' }`; new assertions in the create test (desktop): `Task list actions` group visible while the dialog is open and `getByTestId('modal-scrim')` count 0; new test: outside-click with a dirty draft opens `Discard draft?`; mobile project unchanged.
**Steps:** tests first; implement; `npm run test:web && npm run typecheck:all`; controller runs Playwright (both projects).

### Task 3: Pure confirms adopt the anchored variant (Spec Part C)
**Files:** `src/web/task-board/views/WorkspacePages.tsx` (`Interrupt N agents?` at its button; `Rotate agent token?` at its button), `src/web/task-board/views/WorkItemDetail.tsx` (`Approve and merge pipeline`, `Archive work item` at their buttons); their SSR tests updated for the variant; Playwright tests touching these names unchanged except adding `getByTestId('modal-scrim')` count 0 where they open on desktop; `orchestrator-roadmap.md` 9.6 entry: shipped marker + audit note listing the modals deliberately left as takeovers.
**Steps:** implement; `npm run test:web && npm run typecheck:all`; controller runs Playwright.

## Self-review
Spec Parts A–C ↔ Tasks 1–3; names frozen list matches the spec; no placeholders; SSR-only vitest limitation handled by Playwright coverage per task.
