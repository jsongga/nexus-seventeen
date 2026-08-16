# Orchestrator campaign 1 — task record and state machine

Status: Approved (operator directive: continue the roadmap autonomously; spec
open for async review)
Author: Claude, from `orchestrator-design.md` §3 and `orchestrator-roadmap.md`
campaign 1
Date: 2026-08-15
Scope: v19 schema migration installing the orchestrator's state machine,
heartbeat, claim-time pinning, per-stage transition record, and
forward-tolerant web enum parsing

## Summary

`orchestrator-design.md` §3 defines the orchestrator's work unit: a record
carrying the verbatim raw request, a ten-state pipeline with two human gates,
heartbeat liveness, and metadata pinned at claim time. This campaign installs
that machinery in the existing board.

**The §3 "task" is today's `work_items` row, not today's `tasks` row.** The
work item already carries the immutable `original_request`, the intake
lifecycle, and the human-gate semantics; today's `tasks` are per-agent stage
attempts whose claim/settle/recovery statuses (`queued`, `in_progress`,
`blocked`, …) describe execution, not pipeline position. Renaming task
statuses to pipeline stages would fake granularity the system does not have.
So: the pipeline state machine lands on **work items**; heartbeat and pinning
land on **runs** (the running-agent records); task statuses are unchanged.
This refines the roadmap's loose "task states" phrasing — recorded here
deliberately.

## The new work-item state machine

`WORK_ITEM_STATES` (contract, single source → SQL CHECK, validators, web)
becomes exactly §3's graph:

```
queued -> planning -> plan_approval -> designing -> implementing
       -> verifying -> reviewing -> fixing -> final_approval -> merged
                                            \-> parked
                                            \-> abandoned | dead_letter
```

Reverse edges per §3: `reviewing -> fixing`, `reviewing -> planning`,
`fixing -> verifying`, `parked -> planning | implementing`,
`final_approval -> implementing`. Additionally every non-terminal state may
move to `parked`, `abandoned`, and `dead_letter` (park catches everything
abnormal; abandon is the operator cancel; dead-letter is the retry cap).
`designing` is entered only from `plan_approval` (hazardous tier) and exits
to `implementing`. Terminals: `merged | abandoned | dead_letter` — coupled to
`ended_at IS NOT NULL` by CHECK, exactly as today's three terminals are.

- A new contract table `WORK_ITEM_TRANSITIONS: Record<state, readonly
  state[]>` is the single source of legality. One server helper
  (`transitionWorkItemInTransaction`) performs every state write: it
  validates the edge (409 `WORK_ITEM_ILLEGAL_TRANSITION` otherwise), bumps
  `version`, couples `ended_at`, and appends the transition row (below).
  All existing writer sites (work-items.ts create/planning/cancel/archive,
  runs.ts settle-question path, runtime.ts stage progression) route through
  it.
- `current_stage` (`WORK_ITEM_STAGES`) is untouched this campaign: the
  workflow engine and intake UI still read it. The new states encode
  pipeline position; reconciling the stage column into the state machine is
  campaign 4's job (recorded deferral).

**v19 migration mapping** (old `state` × `current_stage` → new `state`):
`submitted → queued`; `processing` × `refinement | project_resolution |
research | planning | NULL → planning`, × `implementation | deployment →
implementing`, × `testing → verifying`, × `verification → reviewing`;
`needs_input → parked`; `waiting_for_human_review` × `human_review →
final_approval`, × anything else → `plan_approval`; `completed → merged`;
`failed → dead_letter`; `cancelled → abandoned` (`cancelled_reason`
preserved). Table rebuild (v13→v14 pattern: FK off, rebuild, copy with the
mapping CASE, indexes, `foreign_key_check`).

## Transition record (per-stage elapsed)

New table `work_item_transitions(work_item_id REFERENCES … , sequence
INTEGER, from_state TEXT NULL, to_state TEXT, actor_type TEXT, actor_id
TEXT, created_at TEXT, PRIMARY KEY(work_item_id, sequence))`. Appended by
the transition helper (creation writes `NULL -> queued`). Migration seeds one
synthetic row per existing item (`NULL ->` its migrated state, actor
`system:migration`, `created_at = updated_at`) so elapsed derivation never
sees an empty history. Exposed on the work-item detail envelope as
`transitions: [{ fromState, toState, actorType, actorId, createdAt,
createdAtMs }]` — per-stage elapsed is derived client-side; no denormalized
elapsed columns.

## Heartbeat (runs) and the stale-run sweep

- `runs` gains `heartbeat_at TEXT` (additive `ALTER TABLE`). New route
  `POST /v1/runs/:id/heartbeat` — agent credential, own active run only
  (404/409 otherwise), sets `heartbeat_at = now`; idempotent; no version
  bump; no event emission (liveness is not history).
- Worker: while watching an active run, the fleet worker heartbeats every
  30 s (timer beside its existing run-watch loop; failures logged, never
  fatal — the sweep is the safety net, not the worker).
- **Sweep**: `reconcileStaleRuns()` finds `status='active'` runs whose
  `COALESCE(heartbeat_at, started_at)` is older than the timeout (default
  300 s; env `STEWARD_TASK_BOARD_HEARTBEAT_TIMEOUT_SECONDS`, 0 disables) and
  settles each via the existing `settleActiveRunInTransaction` with outcome
  `interrupted`, result `"run heartbeat lost"` — the task becomes
  `interrupted` (recoverable by the existing retry/reassign machinery), the
  workflow repair path runs, events emit after commit. Runs at startup
  (beside `reconcileWorkflows`) and on a service-owned interval (default
  60 s; env `STEWARD_TASK_BOARD_RECONCILE_INTERVAL_SECONDS`, 0 disables —
  tests drive it synchronously via a public `board.reconcileStaleRuns()`).
  §3's "reconciler keys on heartbeat age, not wall-clock alone" is satisfied:
  the predicate reads only the run's own liveness timestamps.

## Claim-time pinning (runs)

`runs` gains nullable `runtime`, `runtime_version`, `model`, `prompts_sha`
(additive). The claim request accepts an optional `pinned { runtime,
runtimeVersion, model, promptsSha }` block (each 1–128 chars, single-line);
stored verbatim on the claim insert, echoed on the run envelope. The fleet
worker sends what it knows today: `runtime` = its CLI kind, `runtimeVersion`
= the CLI's `--version` output captured at lane start, `model` = the agent
profile's model field; `promptsSha` stays null until the orchestrator prompt
repo exists (campaign 4). Replayed claims (existing `claim_result_json`
dedupe) keep the originally pinned values.

## Forward-tolerant web enum parsing

Closes the parked audit follow-up. The shared validator's **browser
projection only** gains tolerance on two fields: `work_items[].state` and
`tasks[].status`. An unknown string on those fields parses to the sentinel
member `'unrecognized'` instead of failing the whole snapshot; the web view
vocabulary gains an `unrecognized` bucket rendered as a neutral "Unknown
state — refresh the app" badge with no affordances (recovery, transitions,
and pipeline UI all treat it as inert). Server-side parsing stays strict.
Wire tests pin: strict profile rejects, browser profile buckets.

## Web migration

`WORK_ITEM_STATES` ripples through wire.ts, types, intake views,
ThreadPipelineTable, and e2e fixtures: mechanical vocabulary swap using the
migration mapping (view copy: `queued → "Queued"`, `planning → "Planning"`,
`plan_approval → "Plan review"`, `designing → "Design"`, `implementing →
"Implementing"`, `verifying → "Verifying"`, `reviewing → "Reviewing"`,
`fixing → "Fixing"`, `final_approval → "Final review"`, `merged → "Done"`,
`parked → "Parked"`, `abandoned → "Cancelled"`, `dead_letter → "Failed"`).
The wire→view task-status map is untouched.

## Out of scope

Driving the new middle states (designing/verifying/reviewing/fixing) from
real machinery — campaigns 4–5; today's flow simply uses the subset it
reaches. Stage-column collapse into the state machine (campaign 4). Rich
plan records, tier/change-shape enrichment beyond nullable columns — **not
even nullable columns yet**: tier, change shape, declared scope, worktree,
branch, and PR fields land with the Intake that produces them (campaign 4),
so this campaign adds no dead columns. Scheduling, budgets, containers.

## Verification bar

Contract: transition-table completeness tests (every state reachable,
terminals absorbing, reverse edges exact). Store: v19 golden fixture
(`v19-schema.sql`) byte-identity + CHECK-fragment pins updated; v18→v19
migration test with a seeded DB covering every (state × stage) mapping cell
and the synthetic transition seed; `user_version` assertions bumped across
board.test.ts. Server: transition-helper legality matrix
(allowed/409/version bump/ended_at coupling/transition row); heartbeat route
auth/ownership/idempotency; sweep test — active run, stale heartbeat →
settled interrupted, task recoverable, workflow repair ran, fresh heartbeat
survives; pinning round-trip incl. claim replay. Worker: heartbeat timer
sends during watch, stops on settle (existing worker test harness).
Web: wire tolerance tests (strict rejects / browser buckets); view-map
exhaustiveness compile checks; e2e fixture vocabulary updated and suites
green. Per task `typecheck:all` + suite; full `npm test` + e2e at campaign
end; dual review per task; both-model whole-branch review before merge.

## Alternatives considered

- **Rename `tasks.status` to the pipeline states** (roadmap's literal
  wording) — rejected: task statuses gate claim/settle/recovery machinery
  built around execution semantics; the pipeline unit with the verbatim raw
  request and human gates is the work item. A rename would leave
  `in_progress` masquerading as five distinct pipeline stages.
- **Collapse `current_stage` now** — rejected: the workflow engine and
  intake UI read it; removing it belongs with the pipeline that replaces its
  writers (campaign 4).
- **Denormalized per-stage elapsed columns** — rejected: a transition log is
  strictly more informative, append-only, and derivable both ways.
- **Heartbeat via wakeup long-poll liveness** — rejected: §3 wants liveness
  of the *running* agent; the long-poll covers waiting agents, not active
  runs, and a wedged worker holds no poll.
- **Map old `failed` → `parked`** — rejected: old failures were terminal
  (`ended_at` set); parked is live. `dead_letter` preserves terminality and
  the CHECK coupling.
- **Tolerant parsing everywhere** — rejected for now: blanket tolerance
  hides real contract drift; the two user-visible lifecycle enums are where
  stale tabs actually break.
