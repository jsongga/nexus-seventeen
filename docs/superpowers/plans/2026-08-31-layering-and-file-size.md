# Plan: layering and file size (campaign 12)

Spec: `docs/superpowers/specs/2026-08-31-layering-and-file-size.md`. Base: `8cbaa60`.

Two tasks, in this order because the first is the roadmap's exit criterion and the second is
the expensive one. Either can ship without the other.

| #   | Task                          | Deliverable                                                                                                                                   | Why here                                                    |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | Break the cycle, enforce it   | `work-item-transitions.ts` → `persistence/`, `pipeline-inspection.ts` → task-board root, plus `tests/tooling/layer-direction.test.mjs`        | Two `git mv`s make the rule true; the test keeps it true    |
| 2   | `validate.ts` behind a façade | 5,068 lines cut at existing banner boundaries into `validate/{scalars,entities,board,worker,plans,requests}.ts`; `validate.ts` re-exports all | Largest file in the repository; the seams are already drawn |

Not in this campaign: `collaborators/projects.ts` (2,451 lines, seams undrawn — needs its own
brainstorming), `persistence/workflow.ts`'s size, and any rule about `collaborators →
collaborators` edges.

## Task 1 — break the cycle, enforce the direction

Two moves, no logic change:

- `src/server/task-board/collaborators/work-item-transitions.ts` →
  `src/server/task-board/persistence/work-item-transitions.ts`, test to
  `tests/server/task-board/persistence/work-item-transitions.test.ts` (new directory). Six
  collaborators import it; they keep working in the allowed direction. Its own
  `import type { TaskBoardStore } from "../persistence/store.js"` becomes `./store.js`.
- `src/server/task-board/collaborators/pipeline-inspection.ts` →
  `src/server/task-board/pipeline-inspection.ts`, test to
  `tests/server/task-board/pipeline-inspection.test.ts`. Two importers, one per layer, which
  is why it belongs to neither.

Then `tests/tooling/layer-direction.test.mjs`:

- Walks `src/server/task-board/**`, resolves every relative import specifier to a real file,
  and asserts no file under `persistence/` resolves into `collaborators/`.
- **Resolves rather than pattern-matches**, so a re-export through a third module is still
  caught. Directory names are not evidence.
- **Is proven to fail.** A fixture plants a back-import in a temporary tree and asserts the
  checker reports it — the technique `code-style.test.mjs` already uses for its banner
  scanner. Also assert it reports the _offending file and specifier_, not just a boolean.
- Counts the edges it did examine and asserts that count is non-zero, so a checker that
  silently matches nothing cannot pass.

**Exit:** `test:all` green; the planted-violation fixture fails the checker; `persistence → collaborators` is 0 edges.

## Task 2 — `validate.ts` behind a façade

Cut at the existing `/* —— Section —— */` boundaries into `src/shared/task-board-contract/validate/`:

| New module    | Banner groups                                                                                                                                                                                              |  Lines |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: |
| `scalars.ts`  | Scalar validation                                                                                                                                                                                          |   ~230 |
| `entities.ts` | Stored entity parsing · Project and work-item entities · Task, run, and message entities · Plan results, reviews, board controls, and ledgers · Design and plan entities · Pipeline evidence and artifacts | ~2,040 |
| `board.ts`    | Automation configuration · Snapshots and claim responses                                                                                                                                                   |   ~440 |
| `worker.ts`   | Worker claim boundary · Worker workflow context · Worker outputs                                                                                                                                           |   ~980 |
| `plans.ts`    | Shared plan-draft policy                                                                                                                                                                                   |   ~540 |
| `requests.ts` | Board request boundary                                                                                                                                                                                     |   ~680 |

`validate.ts` becomes a façade that re-exports all six, so **no caller changes** — 25
importing files stay untouched, and the caller migration stays a separate, optional decision.

**One relocation must happen first.** The banner groups form a DAG except for a single edge:
`projectAgentTaskPhase`, declared under `Scalar validation`, calls `parseAgentTaskPhaseResponse`
from `Task, run, and message entities`. It is an entity projection filed under scalars. Move
it into the entities group before cutting, and the module graph is acyclic. Without that, the
split reproduces the cycle it was meant to remove, one layer down.

**The invariant that makes this reviewable:** extract the set of top-level declared symbols
from `validate.ts` at base, and from the six new modules afterwards. The two sets must be
identical — no symbol invented, renamed or lost. Report the diff (expected: empty). The only
permitted content changes are import statements between the new modules, the one relocation,
and the façade's re-exports. Any other line change is a finding.

Extend the Task 1 checker, or add a sibling assertion, so the six new modules cannot import
each other cyclically either.

**Exit:** `test:all` green; symbol-set diff empty; `git diff --stat` shows no caller file
changed; no cycle among the new modules.

## Per task

Codex implements → gates run outside the sandbox (`typecheck:all`, `test:all`, and Playwright
for anything touching `src/web` — neither task does) → Claude reviewer and `codex review`
serialized, never concurrent with a gate → reconcile → commit. Fix rounds cap 5.

Both tasks move files, so both carry campaign 11 task 6's move hazards: the module-header
allowlist and baseline must move together as a provable pure path rewrite, `docs/` carries
links into `src/`, and a module leaving a directory published in `package.json`'s `imports`
map can silently downgrade a bare specifier to a deep relative path resolving through a
different build output.
