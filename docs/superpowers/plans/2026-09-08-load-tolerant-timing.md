# Plan: load-tolerant pipeline timing (roadmap 9.8)

Spec: `docs/superpowers/specs/2026-09-08-load-tolerant-timing.md`. Base: `acd6ce7`.

Two tasks. Task 1 is the shared mechanism and the ten node windows; task 2 is the Playwright arc,
which is a different failure and deserves its own diagnosis rather than the same helper.

| #   | Task               | Deliverable                                                      | Why here                                           |
| --- | ------------------ | ---------------------------------------------------------------- | -------------------------------------------------- |
| 1   | Progress gating    | One helper; all ten wall-clock windows converted; failure traces | The mechanism, and every node-suite instance       |
| 2   | The Playwright arc | `a pending pause keeps its reason…` stops failing under load     | Different mechanism — a held response, not a sweep |

## Task 1 — progress gating

One helper, used by every window in `tests/server/task-board/machine-verify-integration.test.ts`
(1 window) and `tests/server/task-board/pipeline-e2e.test.ts` (9 windows). It takes a step
function to advance the system, an observation function returning the values the arc cares about,
and a predicate for success. It returns when the predicate holds, and fails when the observation
has been **unchanged for N consecutive polls** — not when a clock expires.

Keep a wall-clock ceiling, generous (60 s+), whose only job is to stop a hung suite. It must never
be the thing that decides an ordinary verdict.

**The failure message must carry the progress trace** — the distinct observed values in order.
Today's message names only the current state; a progress gate that fails should say what it
passed through, because "stuck in `verifying` after reaching `implementing` twice" is a different
bug from "never left `queued`".

**Do not change a single state assertion.** This task changes waiting, nothing else. A reviewer
should be able to confirm that every `assert` in both files is byte-identical.

**Exit:** both suites pass with a parallel `npm run build:runtime` looping in the background; the
diff touches only waiting code and the new helper.

## Task 2 — the Playwright arc

`a pending pause keeps its reason and error when the rail breakpoint changes`
(`tests/e2e/task-board.spec.ts:597`). Measured today: fails roughly 1 run in 3 on a busy machine,
passes on an idle one. Its shape is a **held POST response** plus a viewport change mid-flight,
so the node helper does not apply.

Diagnose before changing. The likely candidates are the interaction between
`boardStub.pausePostRequestStarted`, `setViewportSize`, and the re-query of the rail after the
breakpoint change — a re-render can detach the popover between the two `openCompanyRail` calls.
Say which it is; do not add a retry or a sleep.

**Exit:** 5 consecutive runs pass with a parallel build running.

## Per task

Codex implements task 1. **The controller implements task 2** — it needs repeated observed runs
under real load, which Codex's sandbox cannot do (no browser, no bound port).

Gates outside the sandbox: `typecheck:all`, `test:all`, `test:container`, Playwright both
projects. Claude reviewer and `codex review` serialized, never concurrent with a gate. Fix rounds
cap 5.

**Watch for:** a progress gate that observes too little is a sleep with extra steps — if the
observation function returns a value that changes on every poll (a timestamp, a counter that
always advances), quiescence never triggers and the gate degrades to the wall-clock ceiling. The
reviewer should check that each observation is drawn from what the arc actually asserts.
