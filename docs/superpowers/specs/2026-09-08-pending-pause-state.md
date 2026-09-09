# A pending pause keeps its draft and its error (roadmap 9.12)

**Status** Draft · **Author** Claude (controller) · **Date** 2026-09-08 · **Scope** where the
board-pause popover's reason and error live.

## What this is about

An operator pauses the whole board by opening a popover in the navigation rail, typing a
**reason**, and confirming. The request can come back with a **version conflict** — someone else
changed the pause state first — and the popover is meant to show that error while keeping the
reason, so the operator can retry without retyping.

## The defect

The reason and the error are scoped to the popover, so anything that closes it destroys both.

| Where it lives                                            | What clears it                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| `pauseReason` — local state in `WorkspaceSidebar` (`:53`) | any unmount, and `:62` on close                                  |
| `pauseControlError` — `BoardApp` (`:229`)                 | `openPausePopover` (`:788`) **and** `closePausePopover` (`:794`) |

`WorkspaceSidebar:65-72` cancels the pause outright when the desktop rail breakpoint changes —
guarded by `!pauseBusy`, so a request in flight is protected. That guard is the whole reason the
arc usually passes: the response normally resolves while `pauseBusy` is still true.

**But the guard is a race, not a rule.** The `matchMedia` change event and the response resolution
are unordered. When the event lands after `pauseBusy` goes false, the popover is cancelled and the
operator loses both the conflict and the reason they typed. Measured: the
`a pending pause keeps its reason and error when the rail breakpoint changes` arc fails about one
run in three, and forcing the losing order makes it fail every time.

So the flake is a symptom. **Roadmap 9.8 correctly declined to "fix" it as a timing problem** —
there is a real defect underneath.

## The change in one sentence

A pause draft survives anything except the operator abandoning it or the pause succeeding.

## Model

| Event                                      | Popover | Reason       | Error        |
| ------------------------------------------ | ------- | ------------ | ------------ |
| Breakpoint change, drawer close, re-render | closes  | **kept**     | **kept**     |
| Operator cancels (Escape, outside click)   | closes  | cleared      | cleared      |
| Pause succeeds                             | closes  | cleared      | cleared      |
| Operator reopens after a conflict          | opens   | **restored** | **restored** |

Two moves make this true:

1. **Lift `pauseReason` to `BoardApp`**, beside `pauseControlError` and `pausePopoverOpen`. It is
   part of the pause interaction, not of whichever sidebar instance happens to be mounted.
2. **Distinguish hiding from cancelling.** A breakpoint change _hides_ the popover; only the
   operator _cancels_ it. Today both call `closePausePopover`, which clears.

`openPausePopover` also stops clearing the error, so reopening after a conflict shows what
happened rather than a blank form.

## Anticipated question

**Is a stale conflict worth showing?** Yes, while its draft is still there — the two belong to one
attempt, and showing a reason without the reason it failed is worse than showing neither. Both
clear together on cancel or success, so a conflict can never outlive the attempt it describes.

## Recommendation

**do-X only** — the two moves above, plus un-skipping nothing (the arc already exists and already
fails). No new UI, no new state machine.

**Exit:** the `a pending pause keeps its reason and error…` arc passes 5 consecutive runs under
load, and forcing the previously-losing order (release the response after the breakpoint render)
also passes.

## Alternatives considered

**Make the breakpoint handler wait for the in-flight request.** Keeps state popover-scoped and
"fixes" the observed failure. Rejected: it deepens the race rather than removing it — every future
path that closes the popover would need the same guard, and the operator still loses the draft on
any close.

**Keep the state where it is and stop closing on breakpoint change.** Cheapest. Rejected: crossing
the breakpoint genuinely swaps the rail for the drawer, and leaving a popover anchored to a
control that no longer exists is worse than closing it.

**Persist the draft to `localStorage`.** Survives reloads too. Rejected as scope: nothing asks for
a pause reason to outlive the tab, and a stale reason resurrected days later is a new confusion.
