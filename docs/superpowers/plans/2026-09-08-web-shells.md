# Plan: the two web shells (campaign 14)

Spec: `docs/superpowers/specs/2026-09-08-web-shells.md`. Base: `b9a242c`.

Three tasks, in the order the spec argues for: the ratchet first, so the extraction's benefit shows
up as a falling baseline rather than being recorded after the fact.

| #   | Task             | Deliverable                                                         | Proof                    |
| --- | ---------------- | ------------------------------------------------------------------- | ------------------------ |
| 1   | Size ratchet     | A tooling test with a per-file baseline that may shrink, never grow | tooling tier             |
| 2   | `BoardApp` hooks | Five hooks in `src/web/board/`; the shell under 700 lines           | Playwright both projects |
| 3   | `WorkItemDetail` | Its three clusters                                                  | Playwright both projects |

## Task 1 — the size ratchet

A tooling test in `tests/tooling/` with a checked-in baseline of line counts, following the
module-header allowlist's shape exactly: the baseline **may shrink and may never grow**, and a
file absent from the baseline is unconstrained until someone adds it.

Seed it from the current tree so it starts green. That is the point — it records today's sizes as
a ceiling, including `BoardApp.tsx` at 1,402, and every later task lowers numbers rather than
raising them.

Cover `src/` only. Tests grow legitimately as coverage grows, and a ratchet that fights new tests
teaches people to edit the baseline.

**Exit:** the tooling tier fails if any tracked `src/` file gains a line; adding a line to
`BoardApp.tsx` fails; removing one and updating the baseline passes.

## Task 2 — the `BoardApp` hooks

Five hooks in `src/web/board/`, taking the state clusters the spec names:
`useBoardSnapshot`, `useBoardNotifications`, `useBoardPause`, `useWorkItemDetailLoad`,
`useBoardDialogs`.

**Extract by state cluster, never by line range.** The grouping was chosen so no function reads two
groups' internals; cutting on line boundaries instead produces hooks that share mutable state
across their seam, which is how a move becomes a behaviour change.

**Hook order matters.** React runs hooks in call order, and an extraction that reorders `useEffect`
calls relative to each other can change when effects fire. Preserve the existing order.

**Exit:** `BoardApp.tsx` under 700 lines, the ratchet baseline drops accordingly, Playwright green
on both projects.

## Task 3 — `WorkItemDetail`

Its three clusters, same rules. Smaller and strictly optional if task 2 runs long.

**Exit:** the file shrinks, the baseline drops, Playwright green.

## Per task

Codex implements all three; the controller runs Playwright, which is the only proof a moved hook
still runs in the same order. Gates outside the sandbox: `typecheck:all`, `test:all`, Playwright
both projects. Claude reviewer and `codex review` serialized, never concurrent with a gate. Fix
rounds cap 5.

**Watch for:** a ratchet is only as good as its baseline. If task 1's baseline is generated with a
tolerance, or rounds up, or excludes the two shells, it will pass forever and protect nothing — the
same way campaign 13's banner pass silently did not happen because it sat outside the exit
criteria. Task 1's own exit therefore includes a falsification: adding a line must fail.

## Outcome (2026-09-09)

**Task 1** shipped: 176 files ratcheted, falsified three ways.

**Task 2** shipped two of five clusters — `useBoardNotifications` and `useBoardPause`.
`BoardApp.tsx` 1,402 → 1,256. The other three are not seams; the spec records why.

**Task 3** shipped all three of `WorkItemDetail`'s loads — `useProposedWorkflow`,
`useWorkItemAudit`, `usePipelineSummary`. 1,254 → 1,162. These were genuine seams: each resets on
`workItem.id` independently and none writes another's state.

Deliberately not built: a generic `useAsyncResource` over the three. They share a shape but differ
in gating, dependencies, and whether a stale value stays rendered during reload — an abstraction
taking a predicate, a dependency list, an abort signal, a retry counter and a reset key is as
complex as the duplication it replaces.
